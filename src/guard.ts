// Lightweight, deterministic loop detection over the conversation OpenCode
// sends. It never executes tools; it only notices when the model is about to
// repeat a call whose result it already has and nothing has changed since,
// counts consecutive tool failures, and enforces a per-turn step budget.

import type { ChatMessage } from "./messages.ts";
import { lastUserIndex, textOf } from "./messages.ts";

export interface Step {
  name: string;
  key: string;
  args: unknown;
  result: string;
  isError: boolean;
  /** Identical to an earlier call with nothing changed in between. */
  redundant: boolean;
}

export interface TurnAnalysis {
  steps: Step[];
  consecutiveErrors: number;
  redundantExecuted: number;
}

const READ_ONLY = new Set(["read", "glob", "grep", "list", "ls", "webfetch", "websearch", "codesearch", "skill", "todoread", "lsp_diagnostics", "lsp_hover", "repo_overview", "find_symbol"]);
const MUTATING = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

export function isErrorResult(text: string): boolean {
  return /^\s*(error\b|Error:|Failed\b|Unknown tool|Invalid\b)|arguments provided to the tool are invalid|oldString not found|Found multiple matches for oldString|File not found|ENOENT|No such file or directory/i.test(
    text.slice(0, 400),
  );
}

function wasCleared(text: string): boolean {
  return text.length < 200 && /(content|output) (was )?(cleared|pruned|compacted|truncated)/i.test(text);
}

/** Parameters that do not change what a call does (so they do not make a repeat "different"). */
const VOLATILE: Record<string, string[]> = { bash: ["timeout", "description"] };

export function canonicalKey(name: string, args: unknown): string {
  let a = args;
  const drop = VOLATILE[name];
  if (drop && a && typeof a === "object" && !Array.isArray(a)) {
    a = Object.fromEntries(Object.entries(a as Record<string, unknown>).filter(([k]) => !drop.includes(k)));
  }
  return `${name}:${stableStringify(a)}`;
}

const TIMED_OUT = /exceeding timeout|timed out|terminated command after/i;

// Commands that wait for an outside condition (polling loops, followers): after a timeout,
// running them longer only helps if something else changes the state, which it does not
// while the agent waits. Observed: `while true; do …; sleep 5; done` re-run with timeout 600000.
const WAIT_LOOP = /\b(while|until)\b[\s\S]*\b(sleep|Start-Sleep)\b|\bwhile\s+(true|:)(\s|;|$)|\bwhile\s*\(\s*\$?true\s*\)|\bfor\s*\(\(\s*;\s*;\s*\)\)|\btail\s+-[a-zA-Z]*f|\bsleep\s+infinity\b/i;

function isTimedOutWait(s: Step): boolean {
  return s.name === "bash" && TIMED_OUT.test(s.result) && WAIT_LOOP.test(String((s.args as any)?.command ?? ""));
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function parseArgs(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Whether `step` means the world may have changed, from the point of view of a repeat of `key`. */
function isBoundary(step: Step, key: string): boolean {
  if (step.key === key) return false;
  if (MUTATING.has(step.name)) return !step.isError;
  if (READ_ONLY.has(step.name)) return false;
  return true; // bash, task, custom tools: assume they may have changed something
}

export function analyzeTurn(messages: ChatMessage[]): TurnAnalysis {
  const start = lastUserIndex(messages);
  const results = new Map<string, string>();
  for (const m of messages.slice(start + 1)) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, textOf(m.content));
  const steps: Step[] = [];
  for (const m of messages.slice(start + 1)) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const args = parseArgs(tc.function.arguments);
      const key = canonicalKey(tc.function.name, args);
      const result = results.get(tc.id) ?? "";
      const step: Step = { name: tc.function.name, key, args, result, isError: isErrorResult(result), redundant: false };
      step.redundant = findRedundant(steps, key, args) !== undefined;
      steps.push(step);
    }
  }
  let consecutiveErrors = 0;
  for (let i = steps.length - 1; i >= 0 && steps[i].isError; i--) consecutiveErrors++;
  return { steps, consecutiveErrors, redundantExecuted: steps.filter((s) => s.redundant).length };
}

/**
 * Returns the earlier identical step if repeating `key` now would be redundant.
 * `args` (the proposed arguments) allows one legitimate escalation: re-running a
 * command that timed out with a larger timeout - unless it is a wait loop.
 */
export function findRedundant(steps: Step[], key: string, args?: unknown): Step | undefined {
  const name = key.slice(0, key.indexOf(":"));
  if (!READ_ONLY.has(name) && !MUTATING.has(name) && name !== "bash") return undefined;
  // After a wait loop timed out, a rewritten wait loop with a longer timeout is the same
  // escalation in other words (observed: `while ! grep …` timed out, then `until grep …`
  // with timeout 300000 blocked for 5 minutes).
  if (name === "bash" && WAIT_LOOP.test(String((args as any)?.command ?? "")) && Number((args as any)?.timeout ?? 120_000) > 120_000) {
    const waited = steps.findLast((s) => isTimedOutWait(s));
    if (waited && waited.key !== key) return waited;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.key === key) {
      if (wasCleared(s.result)) return undefined;
      if (name === "bash" && TIMED_OUT.test(s.result) && !isTimedOutWait(s)) {
        const prevTimeout = Number((s.args as any)?.timeout ?? 120_000);
        const nextTimeout = Number((args as any)?.timeout ?? 120_000);
        const earlierTimeouts = steps.filter((x) => x.key === key && TIMED_OUT.test(x.result)).length;
        if (nextTimeout > prevTimeout && earlierTimeouts <= 1) return undefined;
      }
      // A successful mutation repeated verbatim is a no-op (edit) or a rewrite (write); flag both.
      return s;
    }
    if (isBoundary(s, key)) return undefined;
  }
  return undefined;
}

export function redundantHint(prev: Step): string {
  const preview = prev.result.length > 600 ? `${prev.result.slice(0, 600)}…` : prev.result;
  if (isTimedOutWait(prev)) {
    return `[not executed by the proxy] This command waits in a loop for a condition, and a loop waiting for it already ran until it timed out without the condition occurring. Waiting again, even with a longer timeout, will not change that unless something else changes the state. Check the state once (for example, read the file) and tell the user the current state.\nEarlier result (start):\n${preview}`;
  }
  // Observed: `pip install` timed out at 120 s and 240 s; with the generic hint below the model
  // went silent instead of telling the user.
  if (prev.name === "bash" && TIMED_OUT.test(prev.result)) {
    return `[not executed by the proxy] This command already ran until its timeout and was stopped; running it again, even with a longer timeout, will most likely end the same way. Do not run it again. Tell the user that it does not finish in time, show what its output says, and suggest a likely cause or what they can do (for example run it themselves, or check network access).\nEarlier result (start):\n${preview}`;
  }
  const failed = prev.isError
    ? " It failed then and would fail the same way now; fix the cause first (for an edit, copy oldString exactly from the latest read output, or read the file again if it changed)."
    : " Its result (above) is still current.";
  return `[not executed by the proxy] This call is identical to one you already made in this turn, and nothing has changed since.${failed} Use the earlier result, or take a different action that moves the task forward.\nEarlier result (start):\n${preview}`;
}
