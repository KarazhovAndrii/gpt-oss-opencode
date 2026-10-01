// Which shell OpenCode's `bash` tool runs. OpenCode 1.18 names it in the tool description
// ("Executes a given Windows PowerShell (5.1) command ...", "... PowerShell (7+) command",
// "... cmd.exe command", otherwise "... bash command"), so it is read from there: the platform
// alone does not tell (Windows hosts run Git Bash, pwsh 7 or Windows PowerShell 5.1).

import type { ToolDef } from "./harmony.ts";

export type ShellKind = "powershell" | "pwsh" | "cmd" | "posix";

export function shellFromDescription(desc: string): ShellKind {
  const head = desc.slice(0, 300);
  if (/Windows PowerShell \(5\.1\)/.test(head)) return "powershell";
  if (/PowerShell \(7\+\)/.test(head)) return "pwsh";
  if (/\bcmd\.exe command\b/.test(head)) return "cmd";
  return "posix";
}

/** The shell behind the catalog's `bash` tool, or undefined when there is no such tool. */
export function detectShell(tools: ToolDef[]): ShellKind | undefined {
  const bash = tools.find((t) => t.function?.name === "bash");
  return bash ? shellFromDescription(bash.function.description ?? "") : undefined;
}
