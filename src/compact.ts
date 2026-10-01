// Optional compaction of OpenCode's longest built-in tool descriptions
// (profile.toolDescriptions = "compact"). Tool names and parameter schemas are
// never changed; only the prose shown to the model is shortened. Dynamic facts
// embedded in the descriptions (OS/shell, temp directory, available sub-agents)
// are extracted and kept. If a description does not have the expected shape
// (e.g. a different OpenCode version), it is left untouched.

import type { ToolDef } from "./harmony.ts";

type Compactor = (desc: string) => string | undefined;

const line = (desc: string, re: RegExp) =>
  desc
    .split(/\r?\n/)
    .find((l) => re.test(l))
    ?.trim()
    .replace(/^-\s*/, "");

// OpenCode's description when its shell is PowerShell (5.1 or 7+): a different shape from the bash
// one, with a "# ... shell notes" block that must reach the model verbatim (5.1 has no &&). Left
// whole it costs ~1,030 prompt tokens more per step than the compacted bash description (measured).
function powershellBash(desc: string): string | undefined {
  const first = desc.split(/\r?\n/)[0];
  const ps51 = /Windows PowerShell \(5\.1\)/.test(first);
  if (!ps51 && !/PowerShell \(7\+\)/.test(first)) return undefined;
  const aware = line(desc, /^Be aware:/);
  const notes = desc.match(/^# (Windows )?PowerShell \([^)]*\) shell notes\r?\n(- .*(\r?\n|$))+/m)?.[0].trim();
  if (!aware || !notes) return undefined;
  return [
    `${first.replace(/ with optional timeout.*$/, "")} (${aware.replace(/^Be aware:\s*/, "")}). Commands run in the project directory; use the \`workdir\` parameter instead of changing directories in the command.`,
    line(desc, /for temporary work outside the workspace/),
    `Use it for tests, builds, git, package managers and scripts - NOT for reading, searching, writing or editing files: use read, grep, glob, write and edit for those. Quote paths that contain spaces.${ps51 ? "" : " Chain dependent commands with && on one line."}`,
    notes,
    line(desc, /optional timeout in milliseconds/i),
    /will be truncated/.test(desc) ? "Very long output is truncated; the full output is saved to a file you can read or grep." : undefined,
    "Only commit, amend, push or create PRs when explicitly asked; never force-push, skip hooks or change git config.",
  ]
    .filter(Boolean)
    .join("\n");
}

const COMPACTORS: Record<string, Compactor> = {
  bash(desc) {
    const ps = powershellBash(desc);
    if (ps) return ps;
    const aware = line(desc, /^Be aware:/);
    if (!aware || !/persistent shell session/.test(desc)) return undefined;
    const env = aware.replace(/^Be aware:\s*/, "");
    const temp = line(desc, /for temporary work outside the workspace/);
    const timeout = line(desc, /optional timeout in milliseconds/i);
    return [
      `Executes a shell command in a persistent shell session (${env}). Commands run in the project directory; use the \`workdir\` parameter instead of \`cd <dir> && ...\`.`,
      temp,
      "Use it for tests, builds, git, package managers and scripts - NOT for reading, searching, writing or editing files: use read, grep, glob, write and edit for those. Quote paths that contain spaces. Chain dependent commands with && on one line.",
      timeout,
      /will be truncated/.test(desc) ? "Very long output is truncated; the full output is saved to a file you can read or grep." : undefined,
      "Only commit, amend, push or create PRs when explicitly asked; never force-push, skip hooks or change git config.",
    ]
      .filter(Boolean)
      .join("\n");
  },
  task(desc) {
    const i = desc.indexOf("Available agent types");
    if (i < 0) return undefined;
    return [
      "Launch a sub-agent for a complex, multi-step task. It starts with a fresh context and returns one final message that the user does not see (summarize it for them).",
      "Do not use it to read a known file or to search a few files - use read, grep or glob directly. Give it a detailed prompt that says exactly what to do and what to return.",
      "",
      desc.slice(i).trim(),
    ].join("\n");
  },
  todowrite(desc) {
    if (!/in_progress/.test(desc) || !/completed/.test(desc)) return undefined;
    return "Create and update a structured todo list for multi-step work (3+ distinct steps). Statuses: pending, in_progress (exactly one at a time), completed (only after the work is actually done and verified), cancelled. Update statuses as you work. Skip it for a single simple task or an informational question.";
  },
};

export interface CompactionResult {
  tools: ToolDef[];
  before: number;
  after: number;
  compacted: string[];
}

export function compactTools(tools: ToolDef[]): CompactionResult {
  let before = 0;
  let after = 0;
  const compacted: string[] = [];
  const out = tools.map((t) => {
    const desc = t.function.description ?? "";
    before += desc.length;
    const c = COMPACTORS[t.function.name]?.(desc);
    if (c === undefined || c.length >= desc.length) {
      after += desc.length;
      return t;
    }
    after += c.length;
    compacted.push(t.function.name);
    return { ...t, function: { ...t.function, description: c } };
  });
  return { tools: out, before, after, compacted };
}
