// Tool-calling strategies. Each adapter turns OpenCode's request into an
// upstream request and the upstream reply into proposed tool calls / text, and
// knows how to feed a correction back to the model. The orchestration in
// agent.ts is identical for all of them.

import type { ChatMessage } from "./messages.ts";
import { normalizeHistory, textOf } from "./messages.ts";
import { interpretHarmony, renderToolNamespace, hasHarmonyTokens, stripHarmonyTokens, type ToolDef } from "./harmony.ts";
import type { UpstreamResult } from "./upstream.ts";
import type { ProposedCall } from "./toolcall.ts";
import { extractBalancedObject } from "./toolcall.ts";
import { operatingRules, JSON_PROTOCOL, type PromptContext } from "./prompt.ts";

export interface Interpretation {
  /** All reasoning (provider reasoning field + analysis recovered from content), cleaned. */
  reasoning: string;
  /** Only the part recovered from `content` (the reasoning field may already have been streamed live). */
  contentReasoning: string;
  text: string;
  calls: ProposedCall[];
  /** Protocol problem to report back to the model (json strategy), if any. */
  protocolError?: string;
  notes: string[];
}

export interface BuildInput {
  messages: ChatMessage[];
  tools: ToolDef[];
  toolChoice?: unknown;
  prompt: PromptContext;
  maxTokens: number;
  /** Proxy-internal turns appended after OpenCode's history (corrections, hints). */
  extra: ChatMessage[];
  passthrough: Record<string, unknown>;
}

export interface Adapter {
  name: "native" | "harmony" | "json";
  build(input: BuildInput): Record<string, unknown>;
  interpret(r: UpstreamResult): Interpretation;
  /** Appends a model-visible correction for a rejected call (invalid or redundant). */
  feedback(extra: ChatMessage[], call: { name: string; rawArgs: string }, message: string, id: string): void;
  /** Appends a nudge when the model produced neither text nor a call. */
  nudge(extra: ChatMessage[], message: string): void;
}

function mergedSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const norm = normalizeHistory(messages);
  const system = norm[0]?.role === "system" ? textOf(norm[0].content) : "";
  return { system, rest: norm[0]?.role === "system" ? norm.slice(1) : norm };
}

function safeArgs(raw: string): string {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return raw;
  } catch {
    // fall through
  }
  return JSON.stringify({ _invalid_arguments: raw.slice(0, 2000) });
}

function nativeFeedback(extra: ChatMessage[], call: { name: string; rawArgs: string }, message: string, id: string) {
  extra.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: call.name || "unknown", arguments: safeArgs(call.rawArgs) } }] });
  extra.push({ role: "tool", tool_call_id: id, content: message });
}

const reminderNudge = (extra: ChatMessage[], message: string) =>
  extra.push({ role: "user", content: `<system-reminder>\n${message}\n</system-reminder>` });

// ------------------------------------------------------------------ harmony

/** Signature of a provider streaming bug: the token after a special token is emitted twice. */
export const STREAM_CORRUPTION = /<\|channel\|>(?:analysisanalysis|commentcomment|finalfinal)/;

// A reply (raw model output) that is only the start of a tool-call header, with no usable
// call. Observed as whole replies: " to=functions.read?" and " to=functions.read?<|constrain|>??",
// which reached OpenCode as the final answers "to=functions.read?" and "??". The model meant
// to call a tool: re-prompt.
const HEADER_FRAGMENT = /^\s*(?:<\|[a-z_]+\|>\s*)*(?:(?:commentary|analysis|assistant)\s*)*to=functions\b/i;

export function headerFragmentError(raw: string): string | undefined {
  if (!HEADER_FRAGMENT.test(raw)) return undefined;
  return `Your previous reply was only the start of a function call (${JSON.stringify(raw.trim().slice(0, 80))}) without its arguments. To call a tool, send the complete call with its JSON arguments; otherwise answer the user.`;
}

export const harmonyAdapter: Adapter = {
  name: "harmony",
  build({ messages, tools, prompt, maxTokens, extra, passthrough }) {
    const { system, rest } = mergedSystem(messages);
    const sys = [system, operatingRules(prompt, "harmony"), renderToolNamespace(tools)].filter(Boolean).join("\n\n");
    return {
      ...passthrough,
      messages: [{ role: "system", content: sys }, ...rest, ...extra],
      max_tokens: maxTokens,
      // Without provider tool support, <|call|> is not a stop token: the model would
      // go on to imagine the tool's output. Stopping here is what makes emulation work.
      stop: ["<|call|>"],
    };
  },
  interpret(r) {
    const notes: string[] = [];
    const turn = interpretHarmony(r.reasoning, r.content);
    const fromContent = interpretHarmony("", r.content);
    const calls: ProposedCall[] = [];
    if (turn.call) calls.push({ name: turn.call.name, args: turn.call.args });
    else if (r.toolCalls.length) for (const c of r.toolCalls) calls.push({ name: c.name, args: c.arguments });
    if (STREAM_CORRUPTION.test(r.reasoning + r.content)) notes.push("stream corruption suspected (token duplicated after a harmony special token); set stream:false for this profile");
    if (turn.hallucinatedToolOutput) notes.push("discarded model-imagined tool output");
    if (turn.discarded) notes.push(`discarded ${turn.discarded} chars after the tool call`);
    if (turn.extraCalls.length) notes.push(`ignored ${turn.extraCalls.length} additional call(s) emitted without results`);
    const protocolError = calls.length ? undefined : headerFragmentError(r.content);
    return { reasoning: turn.reasoning, contentReasoning: fromContent.reasoning, text: turn.text, calls, notes, protocolError };
  },
  feedback: nativeFeedback,
  nudge: reminderNudge,
};

// ------------------------------------------------------------------- native

export const nativeAdapter: Adapter = {
  name: "native",
  build({ messages, tools, toolChoice, prompt, maxTokens, extra, passthrough }) {
    const norm = messages.map((m) => (typeof m.content === "string" || m.content == null ? m : { ...m, content: textOf(m.content) }));
    const sysIdx = norm.findIndex((m) => m.role === "system");
    const rules = operatingRules(prompt, "native");
    const msgs = sysIdx >= 0 ? norm.map((m, i) => (i === sysIdx ? { ...m, content: `${textOf(m.content)}\n\n${rules}` } : m)) : [{ role: "system", content: rules }, ...norm];
    return { ...passthrough, messages: [...msgs, ...extra], tools, tool_choice: toolChoice ?? "auto", max_tokens: maxTokens };
  },
  interpret(r) {
    const notes: string[] = [];
    let calls: ProposedCall[] = r.toolCalls.map((c) => ({ name: c.name, args: c.arguments }));
    let text = r.content;
    let reasoning = stripHarmonyTokens(r.reasoning).trim();
    let contentReasoning = "";
    if (!calls.length && hasHarmonyTokens(r.content + r.reasoning)) {
      // The gateway leaked raw harmony instead of parsing it: recover the call.
      const turn = interpretHarmony(r.reasoning, r.content);
      if (turn.call) {
        calls = [{ name: turn.call.name, args: turn.call.args }];
        notes.push("recovered tool call from leaked harmony text");
      }
      text = turn.text;
      reasoning = turn.reasoning;
      contentReasoning = interpretHarmony("", r.content).reasoning;
    }
    const finalText = stripHarmonyTokens(text).trim();
    return { reasoning, contentReasoning, text: finalText, calls, notes, protocolError: calls.length ? undefined : headerFragmentError(r.content) };
  },
  feedback: nativeFeedback,
  nudge: reminderNudge,
};

// --------------------------------------------------------------------- json

function renderToolList(tools: ToolDef[]): string {
  return tools
    .map((t) => {
      const desc = (t.function.description ?? "").trim();
      const { $schema: _s, ...params } = (t.function.parameters ?? {}) as Record<string, unknown>;
      return `## ${t.function.name}\n${desc}\nParameters (JSON Schema): ${JSON.stringify(params)}`;
    })
    .join("\n\n");
}

function jsonHistory(rest: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const names = new Map<string, string>();
  for (const m of rest) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) names.set(tc.id, tc.function.name);
      const calls = m.tool_calls.map((tc) => {
        let args: unknown;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = tc.function.arguments;
        }
        return { name: tc.function.name, arguments: args };
      });
      out.push({ role: "assistant", content: JSON.stringify({ tool_calls: calls }) });
    } else if (m.role === "tool") {
      const block = `<tool_result name="${names.get(m.tool_call_id ?? "") ?? "tool"}">\n${textOf(m.content)}\n</tool_result>`;
      const prev = out[out.length - 1];
      if (prev?.role === "user" && typeof prev.content === "string" && prev.content.startsWith("<tool_result")) prev.content += `\n${block}`;
      else out.push({ role: "user", content: block });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: JSON.stringify({ final: textOf(m.content) }) });
    } else {
      out.push({ role: m.role, content: textOf(m.content) });
    }
  }
  return out;
}

export const jsonAdapter: Adapter = {
  name: "json",
  build({ messages, tools, prompt, maxTokens, extra, passthrough }) {
    const { system, rest } = mergedSystem(messages);
    const sys = [system, operatingRules(prompt, "json"), "# Functions", renderToolList(tools), JSON_PROTOCOL].filter(Boolean).join("\n\n");
    return { ...passthrough, messages: [{ role: "system", content: sys }, ...jsonHistory(rest), ...extra], max_tokens: maxTokens };
  },
  interpret(r) {
    const notes: string[] = [];
    let raw = stripHarmonyTokens(r.content).trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      const ex = extractBalancedObject(raw);
      if (ex) {
        try {
          obj = JSON.parse(ex);
          notes.push("extracted JSON object from surrounding text");
        } catch {
          // fall through
        }
      }
    }
    if (!obj || typeof obj !== "object") {
      return { reasoning: r.reasoning, contentReasoning: "", text: raw, calls: [], notes, protocolError: "Your reply was not a single JSON object. Reply with exactly one JSON object as described in the response protocol." };
    }
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) {
      const calls = obj.tool_calls.map((c: any) => ({ name: String(c?.name ?? c?.function?.name ?? ""), args: c?.arguments ?? c?.function?.arguments ?? {} }));
      return { reasoning: r.reasoning, contentReasoning: "", text: "", calls, notes };
    }
    if (typeof obj.final === "string") return { reasoning: r.reasoning, contentReasoning: "", text: obj.final, calls: [], notes };
    return { reasoning: r.reasoning, contentReasoning: "", text: "", calls: [], notes, protocolError: 'The JSON object must contain either "tool_calls" (non-empty array) or "final" (string).' };
  },
  feedback(extra, call, message) {
    extra.push({ role: "assistant", content: JSON.stringify({ tool_calls: [{ name: call.name, arguments: call.rawArgs }] }) });
    extra.push({ role: "user", content: `<tool_result name="${call.name}">\n${message}\n</tool_result>` });
  },
  nudge(extra, message) {
    extra.push({ role: "user", content: `<system-reminder>\n${message}\n</system-reminder>` });
  },
};

export function adapterFor(name: "native" | "harmony" | "json"): Adapter {
  return name === "native" ? nativeAdapter : name === "json" ? jsonAdapter : harmonyAdapter;
}
