// System-prompt additions appended after OpenCode's own system prompt.
// Kept short: gpt-oss-20b follows a few concrete rules better than long prose.

import { isWindowsPath } from "./toolcall.ts";

export interface PromptContext {
  cwd?: string;
  objective: string;
  /** Extra one-off notes (e.g. "the last 4 tool calls failed"). */
  notes: string[];
}

// Retyping long absolute paths is a measured failure mode of gpt-oss-20b (digits
// get changed). Relative paths are resolved deterministically by the proxy
// before OpenCode sees the call, so OpenCode still receives absolute paths.
function platformLine(cwd?: string): string {
  if (!cwd) return "File paths: copy them exactly from tool results.";
  const example = isWindowsPath(cwd) ? "src\\main.py" : "src/main.py";
  return `File paths: prefer paths relative to the working directory (${cwd}), e.g. ${example}; they are resolved to absolute paths for you. Never retype a long absolute path from memory - use a relative path or copy it exactly from a tool result. If the user gives a path in another style (WSL /mnt/c/..., Git-Bash /c/..., forward slashes), pass it unchanged - it is converted for you; do not convert it yourself.`;
}

export function operatingRules(ctx: PromptContext, mode: "harmony" | "json" | "native"): string {
  const how =
    mode === "harmony"
      ? "Call a function by sending a commentary message addressed to functions.<name> with the JSON arguments; you then receive its result and continue. One call per message."
      : mode === "json"
        ? "Call functions using the JSON response protocol below; you then receive the results and continue."
        : "Call functions with the tool-calling interface; you then receive the results and continue.";
  const lines = [
    "# Operating rules",
    `- Work autonomously with the available functions. ${how}`,
    "- Only the listed functions exist. Use their exact names, parameter names and types.",
    "- You know a file's content, a command's output or a test result only after a function result has shown it. Never describe, quote or summarize anything you have not received in a function result.",
    "- If the request involves finding, reading, changing or running something, do it with functions before answering. Never end your turn by announcing a next step - perform it.",
    `- ${platformLine(ctx.cwd)}`,
    "- To edit, copy oldString exactly from the latest read output, without the line-number prefix. If an edit fails, read the file again and retry with the exact current text. Never claim a change succeeded unless a function result confirms it.",
    "- To find something in a large file (logs, data, long sources), search it with grep or read a line range; do not read the whole file and scan it yourself.",
    "- Make each edit count: include enough surrounding lines for a unique match and change a whole logical block at once. Re-read a file after an edit only if you need its new content.",
    "- After changing code, validate it (run the tests, a build or at least a syntax check) after your last change, and report the real outcome, including failures.",
    "- If a function call fails (e.g. file not found), find out why and try an alternative - search with glob or grep, fix the path - before telling the user it cannot be done.",
    "- Do not hand the user commands or scripts to run instead of doing the work: run them yourself with the functions and report what actually happened. If something cannot be completed (e.g. a condition never becomes true), say so and report the current state.",
    "- Do not repeat a call whose result you already have unless something changed since.",
    "- When everything requested is done and verified, reply to the user with a concise final answer.",
  ];
  if (ctx.objective) {
    lines.push("", "# Current user request (keep working until it is fully satisfied)", "<<<", ctx.objective, ">>>");
  }
  if (ctx.notes.length) lines.push("", "# Notes from the tool proxy", ...ctx.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}

export const JSON_PROTOCOL = `# Response protocol (strict)
Every reply must be exactly one JSON object and nothing else - no prose, no code fences.
- To call functions: {"tool_calls": [{"name": "<function name>", "arguments": { ... }}]}
- To finish and answer the user: {"final": "<markdown answer>"}
Function results arrive in the next user message inside <tool_result> tags.`;
