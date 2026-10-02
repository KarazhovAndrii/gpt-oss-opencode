// Which shell OpenCode's `bash` tool runs, and commands that cannot work in it.
//
// OpenCode 1.18 names the shell in the tool description ("Executes a given Windows PowerShell (5.1)
// command ...", "... PowerShell (7+) command", "... cmd.exe command", otherwise "... bash command"),
// so the proxy reads it from there: the platform alone does not tell (Windows hosts run Git Bash,
// pwsh 7 or Windows PowerShell 5.1).
//
// Windows PowerShell 5.1 is where gpt-oss writes bash or cmd.exe syntax that cannot work (observed:
// `dir /b`, `dir /s /b | findstr /i "speed"`). Every pattern below was run in powershell.exe 5.1 the
// way OpenCode runs it (-NoLogo -NoProfile -NonInteractive -Command, no Git Unix tools on PATH) and
// fails there; forms that happen to work (`ls -R`, `ls -l dir`, `rm -r`, `cat`, `findstr`, `where.exe`,
// `cmd /c "a && b"`) are deliberately not flagged. Nothing here applies to bash or pwsh 7.

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

// ------------------------------------------------------------ tokenizer

interface Token {
  text: string;
  /** Contains quoted text (never a separator, switch or command name to flag). */
  quoted: boolean;
  /** Statement/pipeline separator or block opener: ; newline | && || { ( */
  sep?: string;
}

/** Splits a PowerShell command into words and separators, keeping quoted strings and here-strings intact. */
export function tokenize(cmd: string): Token[] {
  const out: Token[] = [];
  let word = "";
  let quoted = false;
  const flush = () => {
    if (word) out.push({ text: word, quoted });
    word = "";
    quoted = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const two = cmd.slice(i, i + 2);
    if ((two === "@'" || two === '@"') && /\r?\n/.test(cmd.slice(i + 2, i + 4))) {
      // Here-string: up to a line that starts with '@ or "@.
      const close = cmd.indexOf(`\n${two[1]}@`, i + 2);
      const end = close < 0 ? cmd.length : close + 3;
      word += cmd.slice(i, end);
      quoted = true;
      i = end - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < cmd.length) {
        if (c === '"' && cmd[j] === "`") j += 2;
        else if (cmd[j] === c && cmd[j + 1] === c) j += 2;
        else if (cmd[j] === c) break;
        else j++;
      }
      word += cmd.slice(i, j + 1);
      quoted = true;
      i = j;
      continue;
    }
    if (c === "`" && i + 1 < cmd.length) {
      word += cmd.slice(i, i + 2);
      i++;
      continue;
    }
    if (two === "<#") {
      // Block comment <# ... #>: acts as whitespace.
      flush();
      const end = cmd.indexOf("#>", i + 2);
      i = (end < 0 ? cmd.length : end + 2) - 1;
      continue;
    }
    if (c === "#" && !word) {
      const nl = cmd.indexOf("\n", i);
      i = (nl < 0 ? cmd.length : nl) - 1;
      continue;
    }
    if (two === "&&" || two === "||") {
      flush();
      out.push({ text: two, quoted: false, sep: two });
      i++;
      continue;
    }
    if (c === "{" && word === "@") {
      // Hashtable literal @{ a = 1; b = 2 }: its keys are not commands.
      word = "";
      quoted = false;
      out.push({ text: "@{", quoted: false, sep: "@{" });
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "{" || c === "(" || c === "}" || c === ")") {
      flush();
      // "}" and ")" end a block: the next word is an argument position again, not a command.
      out.push({ text: c, quoted: false, sep: c === "\n" ? ";" : c });
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      continue;
    }
    word += c;
  }
  flush();
  return out;
}

/** The command with quoted strings and here-strings blanked out (for operators outside quotes). */
function unquotedText(cmd: string): string {
  return tokenize(cmd)
    .map((t) => (t.quoted ? t.text.replace(/'[^']*'|"(?:`.|[^"`])*"|@'[\s\S]*?'@|@"[\s\S]*?"@/g, " ") : t.text))
    .join(" ");
}

interface Segment {
  /** Words of one pipeline element: the command name and its arguments. */
  words: Token[];
  /** Separator before it ("" at the start). */
  after: string;
}

function segments(tokens: Token[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment = { words: [], after: "" };
  // Open blocks; segments inside a hashtable literal are skipped.
  const blocks: string[] = [];
  const keep = () => {
    if (cur.words.length && !blocks.includes("@{")) out.push(cur);
  };
  for (const t of tokens) {
    if (t.sep) {
      keep();
      if (t.sep === "@{" || t.sep === "{") blocks.push(t.sep);
      else if (t.sep === "}") blocks.pop();
      cur = { words: [], after: t.sep };
      continue;
    }
    cur.words.push(t);
  }
  keep();
  return out;
}

// ------------------------------------------------------------- checks

export interface ShellProblem {
  /** What was written, e.g. "&&" or "dir /s /b". */
  found: string;
  /** Why it fails and what to use instead. */
  fix: string;
}

const LISTERS = new Set(["dir", "ls", "gci", "get-childitem"]);
const REMOVERS = new Set(["rm", "del", "erase", "rd", "rmdir", "ri", "remove-item"]);
const CMD_SWITCH_USERS = new Set([...LISTERS, "del", "erase", "rd", "rmdir", "copy", "move"]);
// cmd.exe switches (/s /b /q /a /ad /a-d /o:n ...), not paths such as /src.
const CMD_SWITCH = /^\/([sbqfypwa]|a:?-?[dhsrail]{1,3}|o:?-?[nesdg]{1,3})$/i;
// Unix ls flag clusters that fail on Get-ChildItem (-la, -al, -lh, -ltr, -a). "-ah"/"-ad" are real
// aliases (-Hidden, -Directory), "-R"/"-r" recurse, and "-l dir" is -LiteralPath dir: all work.
const LS_FLAGS = /^-(l[ahtr]+|al[ht]*|a)$/i;
// A deletion is never something to complete on the model's own: the hint names the working form only
// with this caveat (observed: a README's injected instruction made the model propose `rm -rf src`).
const ONLY_IF_ASKED = " - but delete only what the user asked you to delete";

const UNIX_TOOLS: Record<string, string> = {
  grep: 'search files with the grep function; to filter command output use `| Select-String "pattern"` (or findstr)',
  egrep: 'search files with the grep function; to filter command output use `| Select-String "pattern"`',
  head: "use `Select-Object -First N` (or `Get-Content file -TotalCount N`), or the read function with a limit",
  tail: "use `Select-Object -Last N` (or `Get-Content file -Tail N`), or the read function with an offset",
  sed: "use the edit function to change files; for output use `-replace`",
  awk: "use `ForEach-Object` / `-split` in PowerShell",
  wc: "use `Measure-Object -Line` (e.g. `(Get-Content file | Measure-Object -Line).Lines`)",
  which: "use `Get-Command name` or `where.exe name`",
  touch: "use `New-Item -ItemType File name`",
};

const lower = (t: Token | undefined) => (t && !t.quoted ? t.text.toLowerCase() : "");

/** Commands in `cmd` that cannot work in Windows PowerShell 5.1, each with a working alternative. */
export function powershell51Problems(cmd: string): ShellProblem[] {
  const tokens = tokenize(cmd);
  const problems: ShellProblem[] = [];
  const add = (found: string, fix: string) => {
    if (!problems.some((p) => p.found === found)) problems.push({ found, fix });
  };
  for (const t of tokens) {
    if (t.sep === "&&") add("&&", "Windows PowerShell 5.1 has no `&&`: chain dependent commands with `cmd1; if ($?) { cmd2 }`");
    if (t.sep === "||") add("||", "Windows PowerShell 5.1 has no `||`: use `cmd1; if (-not $?) { cmd2 }`");
  }
  // Heredocs and input redirection are parse errors in 5.1 (observed: `python - <<'PY'` → "Missing file
  // specification after redirection operator"; `cmd < file` → "The '<' operator is reserved for future use").
  const bare = unquotedText(cmd);
  if (/<</.test(bare)) add("<<", "PowerShell has no heredocs: write the script to a file with the write function and run it, or use `python -c \"...\"`");
  else if (/</.test(bare)) add("<", "PowerShell has no `<` input redirection: pipe the file instead, e.g. `Get-Content input.txt | command`");
  for (const t of tokens) {
    if (t.quoted || t.sep) continue;
    const m = t.text.match(/^(\d|\*|&)?>>?(\/dev\/null|nul)$/i);
    if (m) add(t.text, `there is no ${m[2]} in PowerShell: use \`${m[1] === "&" || m[1] === "*" ? "*" : (m[1] ?? "")}>$null\` (or \`| Out-Null\`)`);
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (/^(\d|\*)?>>?$/.test(tokens[i].text) && !tokens[i].quoted && /^(\/dev\/null|nul)$/i.test(tokens[i + 1].text) && !tokens[i + 1].quoted)
      add(`${tokens[i].text} ${tokens[i + 1].text}`, `there is no ${tokens[i + 1].text} in PowerShell: use \`${tokens[i].text}$null\` (or \`| Out-Null\`)`);
  }
  for (const seg of segments(tokens)) {
    const name = lower(seg.words[0]);
    if (!name) continue;
    const args = seg.words.slice(1);
    const argText = args.map((a) => a.text).join(" ");
    if (CMD_SWITCH_USERS.has(name)) {
      const switches = args.filter((a) => !a.quoted && CMD_SWITCH.test(a.text));
      if (switches.length) {
        const shown = `${name} ${switches.map((s) => s.text).join(" ")}`;
        if (LISTERS.has(name))
          add(shown, `\`${name}\` is Get-ChildItem in PowerShell and takes no cmd.exe switches: to find files use the glob function (e.g. pattern "**/*name*"), or \`Get-ChildItem -Recurse -Name -Filter *name*\``);
        else if (name === "copy" || name === "move") add(shown, `\`${name}\` is ${name === "copy" ? "Copy-Item" : "Move-Item"} in PowerShell and takes no cmd.exe switches: use \`${name === "copy" ? "Copy-Item" : "Move-Item"} -Force src dst\``);
        else add(shown, `\`${name}\` is Remove-Item in PowerShell and takes no cmd.exe switches: use \`Remove-Item -Recurse -Force path\`${ONLY_IF_ASKED}`);
      }
    }
    if (LISTERS.has(name)) {
      const flag = args.find((a, k) => !a.quoted && (LS_FLAGS.test(a.text) || (/^-l$/i.test(a.text) && k === args.length - 1)));
      if (flag) add(`${name} ${flag.text}`, "Get-ChildItem has no Unix flags: use `Get-ChildItem -Force` (includes hidden files); for a recursive file list use the glob function");
    }
    if (REMOVERS.has(name)) {
      const bad = args.find((a) => !a.quoted && /^-(rf|fr|f)$/i.test(a.text));
      if (bad) add(`${name} ${bad.text}`, "Remove-Item has no -rf/-f (\"-f\" is ambiguous): use `Remove-Item -Recurse -Force path`" + ONLY_IF_ASKED);
    }
    if (name === "export") {
      const m = argText.match(/^([A-Za-z_]\w*)=(.*)$/);
      add(`export ${argText}`.trim(), `there is no export in PowerShell: use \`$env:${m?.[1] ?? "NAME"} = "${m ? m[2].replace(/^["']|["']$/g, "") : "value"}"\``);
    }
    const assign = seg.words[0].text.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (assign && !seg.words[0].quoted && name !== "export" && !seg.words[0].text.startsWith("$"))
      add(seg.words[0].text, `PowerShell has no \`NAME=value command\`: use \`$env:${assign[1]} = "${assign[2].replace(/^["']|["']$/g, "")}"; command\``);
    if (UNIX_TOOLS[name]) add(name, `\`${name}\` does not exist in Windows PowerShell: ${UNIX_TOOLS[name]}`);
    if (name === "find" && args.some((a) => /^-(i?name|type|path)$/i.test(a.text)))
      add("find -name", "`find` is the Windows FIND text search here: to find files use the glob function, or `Get-ChildItem -Recurse -Name -Filter pattern`");
    // `where` is Where-Object: at the start of a statement it filters nothing and prints nothing.
    if (name === "where" && seg.after !== "|" && args[0] && !args[0].quoted && /^[\w.-]+$/.test(args[0].text))
      add(`where ${args[0].text}`, `\`where\` is Where-Object in PowerShell and prints nothing here: use \`where.exe ${args[0].text}\` or \`Get-Command ${args[0].text}\``);
  }
  return problems;
}

/**
 * The command with `&&`/`||` chains rewritten to `; if ($?) { ... }`, when that is the only kind of
 * problem and the chain is a plain sequence; otherwise undefined. A suggestion for the model only.
 */
export function rewriteChains(cmd: string): string | undefined {
  const tokens = tokenize(cmd);
  if (tokens.some((t) => t.sep && t.sep !== "&&" && t.sep !== "||" && t.sep !== "|")) return undefined;
  // Rebuild from the original text: cut at unquoted && / || positions.
  const parts: { op: string; text: string }[] = [];
  let op = "";
  let start = 0;
  let inQuote: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inQuote) {
      if (c === "`" && inQuote === '"') i++;
      else if (c === inQuote) inQuote = undefined;
      continue;
    }
    if (c === "'" || c === '"') inQuote = c;
    else if (cmd.startsWith("&&", i) || cmd.startsWith("||", i)) {
      parts.push({ op, text: cmd.slice(start, i).trim() });
      op = cmd.slice(i, i + 2);
      start = i + 2;
      i++;
    }
  }
  parts.push({ op, text: cmd.slice(start).trim() });
  if (parts.length < 2 || parts.some((p) => !p.text)) return undefined;
  // `a && b || c` runs c when a OR b fails; nesting cannot express that in one line, so no suggestion.
  if (parts.some((p) => p.op === "||") && parts.length > 2) return undefined;
  let out = parts[parts.length - 1].text;
  for (let k = parts.length - 1; k >= 1; k--) out = `${parts[k - 1].text}; if (${parts[k].op === "&&" ? "$?" : "-not $?"}) { ${out} }`;
  return out;
}

/** Re-prompt text for a bash call that cannot work in Windows PowerShell 5.1. */
export function powershell51Feedback(cmd: string, problems: ShellProblem[]): string {
  const onlyChains = problems.every((p) => p.found === "&&" || p.found === "||");
  const rewritten = onlyChains ? rewriteChains(cmd) : undefined;
  return [
    "[not executed by the proxy] The bash function runs Windows PowerShell 5.1 (not bash, not cmd.exe), where this command fails:",
    ...problems.map((p) => `- ${p.found}: ${p.fix}`),
    rewritten ? `Corrected command: ${rewritten}` : "",
    "Send the call again in PowerShell syntax, or use the glob, grep and read functions to find and read files.",
  ]
    .filter(Boolean)
    .join("\n");
}
