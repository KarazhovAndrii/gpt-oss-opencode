import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { detectShell, powershell51Feedback, powershell51Problems, rewriteChains, shellFromDescription, tokenize } from "../src/shell.ts";
import { operatingRules } from "../src/prompt.ts";
import { compactTools } from "../src/compact.ts";
import { OPENCODE_TOOLS } from "./helpers/proxy.ts";

// OpenCode 1.18's bash tool description with SHELL=powershell.exe (captured from an eval run's tool catalog).
export const PS51_DESCRIPTION = fs.readFileSync(new URL("./fixtures/opencode-bash-powershell51.txt", import.meta.url), "utf8");
const withBash = (description: string) => OPENCODE_TOOLS.map((t: any) => (t.function.name === "bash" ? { ...t, function: { ...t.function, description } } : t));

test("the shell is read from OpenCode's bash tool description, not from the platform", () => {
  assert.equal(shellFromDescription(PS51_DESCRIPTION), "powershell");
  assert.equal(shellFromDescription("Executes a given PowerShell (7+) command with optional timeout"), "pwsh");
  assert.equal(shellFromDescription("Executes a given cmd.exe command with optional timeout"), "cmd");
  // Git Bash on Windows: "Be aware: OS: win32, Shell: bash".
  assert.equal(detectShell(OPENCODE_TOOLS), "posix");
  assert.equal(detectShell(withBash(PS51_DESCRIPTION)), "powershell");
  assert.equal(detectShell(OPENCODE_TOOLS.filter((t: any) => t.function.name !== "bash")), undefined);
});

// Each command was run in powershell.exe 5.1 the way OpenCode 1.18 runs it (-NoLogo -NoProfile
// -NonInteractive -Command; PATH without Git's Unix tools). These failed there:
const FAILS_IN_51: [string, string][] = [
  ["echo a && echo b", "&&"],
  ["git --version && echo after", "&&"],
  ["cd sub && dir", "&&"],
  ["echo a || echo b", "||"],
  ["dir /b", "dir /b"],
  ["dir /s /b", "dir /s /b"],
  ['dir /s /b | findstr /i "speed"', "dir /s /b"],
  ["dir /s /b *.cpp", "dir /s /b"],
  ["dir /a", "dir /a"],
  ["ls -la", "ls -la"],
  ["ls -al", "ls -al"],
  ["ls -a", "ls -a"],
  ["ls -lh", "ls -lh"],
  ["ls -l", "ls -l"],
  ["rm -rf junk", "rm -rf"],
  ["rm -f a.txt", "rm -f"],
  ["rm -r -f junk", "rm -f"],
  ["rmdir /s /q junk", "rmdir /s /q"],
  ["rd /s /q junk", "rd /s /q"],
  ["del /s /q *.txt", "del /s /q"],
  ["del /f a.txt", "del /f"],
  ["copy /y a.txt b.txt", "copy /y"],
  ["move /y a.txt b.txt", "move /y"],
  ["export FOO=1", "export FOO=1"],
  ["export FOO=1; echo $env:FOO", "export FOO=1"],
  ['FOO=1 node -e "console.log(process.env.FOO)"', "FOO=1"],
  ["node -e \"console.error('err')\" 2>/dev/null", "2>/dev/null"],
  ["node -e \"console.log('out')\" >/dev/null", ">/dev/null"],
  ["node -e \"console.log('out')\" > /dev/null 2>&1", "> /dev/null"],
  ["node -e \"console.log('out')\" &>/dev/null", "&>/dev/null"],
  ["node -e \"console.log('out')\" > nul", "> nul"],
  ["grep speed a.txt", "grep"],
  ["type a.txt | grep speed", "grep"],
  ["egrep speed a.txt", "egrep"],
  ["head -n 1 a.txt", "head"],
  ["cat a.txt | head -1", "head"],
  ["tail -n 1 a.txt", "tail"],
  ["sed -n 1p a.txt", "sed"],
  ['awk "{print 1}" a.txt', "awk"],
  ["wc -l a.txt", "wc"],
  ["which node", "which"],
  ["touch b.txt", "touch"],
  ['find . -name "*.cpp"', "find -name"],
  // Exits 0 but prints nothing: `where` is Where-Object.
  ["where node", "where node"],
  // Parse errors (observed in deps-install-hangs: `python - <<'PY'`).
  ["node - <<'JS'", "<<"],
  ["cat <<EOF > x.txt", "<<"],
  ['node -e "process.stdin.pipe(process.stdout)" < a.txt', "<"],
  ['node -e "console.log(1)" <a.txt', "<"],
];

// ...and these work there (including Unix-looking forms that PowerShell happens to accept).
const WORKS_IN_51 = [
  'cmd /c "echo a && echo b"',
  'git log -1 --format="a && b"',
  "git commit -m 'fix: a && b || c'",
  "ls",
  "ls -R",
  "ls -r",
  "ls -l sub",
  "ls -ah",
  "gci -Recurse -Name",
  "rm -r junk",
  "rm -r -fo junk",
  "rm -r -force junk",
  "Remove-Item -Recurse -Force junk",
  "set FOO=1",
  '$env:FOO="1"; node -e "console.log(process.env.FOO)"',
  "node -e \"console.error('e')\" 2>$null",
  "node -e \"console.log('x')\" 2>&1 | Out-Null",
  "node -e \"console.log('x')\" > $null",
  "node -e \"console.log('x')\" *>$null",
  "findstr /s /i speed *.cpp",
  "where.exe node",
  "gci | where Name -like '*.txt'",
  "cat a.txt",
  "type a.txt",
  "mkdir -p newdir/sub",
  "cp -r sub sub2",
  "echo a; if ($?) { echo b }",
  'node -e "process.exit(0)"; if ($?) { echo b; if ($?) { echo c } }',
  'node -e "process.exit(1)"; if (-not $?) { echo fallback }',
  "Get-ChildItem -Recurse -Name -Filter *.cpp",
  "Get-Content a.txt | Select-String speed",
  "Get-Content a.txt -TotalCount 1",
  "New-Item -ItemType File b.txt | Out-Null; Test-Path b.txt",
  "Get-Command node | Select-Object -ExpandProperty Source",
  "Select-Object @{n='Size'; e={ $_.Length }}, Name",
  "npm test",
  "git log --grep fix",
  "python -m pytest tests/basic -q",
  '$x = @"\nA && B | grep x\n"@; Write-Output $x',
  'Get-Content a.txt | node -e "process.stdin.pipe(process.stdout)"',
  'node -e "console.log(1 < 2)"',
  "echo '<<' | Out-Null",
  "git log --format='<%an>'",
  '<# a comment #> node -e "console.log(2)"',
  "# grep in a comment\nnpm test",
];

test("every command that failed in Windows PowerShell 5.1 is flagged with the right cause", () => {
  for (const [cmd, found] of FAILS_IN_51) {
    const p = powershell51Problems(cmd);
    assert.ok(p.some((x) => x.found === found), `${cmd} -> ${JSON.stringify(p.map((x) => x.found))}`);
    for (const x of p) assert.ok(x.fix.length > 20, "each problem comes with a working alternative");
  }
});

test("commands that work in Windows PowerShell 5.1 are never flagged", () => {
  for (const cmd of WORKS_IN_51) assert.deepEqual(powershell51Problems(cmd), [], cmd);
});

test("tokenizer keeps quoted strings, here-strings and hashtables intact", () => {
  const t = tokenize(`git commit -m "a && b" ; echo 'x || y'`);
  assert.deepEqual(t.filter((x) => x.sep).map((x) => x.sep), [";"]);
  assert.equal(t.find((x) => x.text.startsWith('"'))?.text, '"a && b"');
  assert.deepEqual(powershell51Problems("Select-Object @{Name='x'; Expression={ grep }}"), [], "keys of a hashtable are not commands");
});

test("&& chains get a corrected command; mixed chains only the rule", () => {
  assert.equal(rewriteChains("npm install && npm test"), "npm install; if ($?) { npm test }");
  assert.equal(rewriteChains("a && b && c"), "a; if ($?) { b; if ($?) { c } }");
  assert.equal(rewriteChains("npm test || echo failed"), "npm test; if (-not $?) { echo failed }");
  assert.equal(rewriteChains('git commit -m "x && y" && git log -1'), 'git commit -m "x && y"; if ($?) { git log -1 }');
  assert.equal(rewriteChains("a && b || c"), undefined, "c must run when a OR b fails: no one-line nesting");
  assert.equal(rewriteChains("a; b && c"), undefined);
  const fb = powershell51Feedback("pip install -r req.txt && python -m pytest", powershell51Problems("pip install -r req.txt && python -m pytest"));
  assert.match(fb, /^\[not executed by the proxy\] The bash function runs Windows PowerShell 5\.1/);
  assert.match(fb, /Corrected command: pip install -r req\.txt; if \(\$\?\) \{ python -m pytest \}/);
  const mixed = powershell51Feedback("dir /s /b | findstr speed && echo ok", powershell51Problems("dir /s /b | findstr speed && echo ok"));
  assert.match(mixed, /dir \/s \/b: .*glob function/);
  assert.doesNotMatch(mixed, /Corrected command/, "no rewrite when other problems remain");
});

test("the PowerShell 5.1 operating rule is added only for a Windows PowerShell 5.1 shell", () => {
  const rules = (shell?: "powershell" | "pwsh" | "posix") => operatingRules({ cwd: "C:\\proj", objective: "x", notes: [], shell }, "harmony");
  assert.match(rules("powershell"), /The bash function runs Windows PowerShell 5\.1.*cmd1; if \(\$\?\) \{ cmd2 \}/);
  for (const s of ["pwsh", "posix", undefined] as const) assert.doesNotMatch(rules(s), /PowerShell/, String(s));
});

test("compaction shortens the PowerShell description but keeps OpenCode's shell notes (never the bash advice to chain with &&)", () => {
  const r = compactTools(withBash(PS51_DESCRIPTION));
  assert.ok(r.compacted.includes("bash"), "the PowerShell shape is compacted too (it cost ~1,030 prompt tokens per step)");
  const bash = r.tools.find((t: any) => t.function.name === "bash")!.function.description!;
  assert.ok(bash.length < PS51_DESCRIPTION.length / 3, `${bash.length} chars`);
  assert.match(bash, /^Executes a given Windows PowerShell \(5\.1\) command \(OS: win32, Shell: powershell\)/);
  assert.equal(shellFromDescription(bash), "powershell");
  assert.match(bash, /# Windows PowerShell \(5\.1\) shell notes\n- Use `cmd1; if \(\$\?\) \{ cmd2 \}` to chain dependent commands\./);
  assert.match(bash, /AppData\\Local\\Temp\\opencode` for temporary work/);
  assert.doesNotMatch(bash, /&&/);
  const pwsh = PS51_DESCRIPTION.replace("Windows PowerShell (5.1) command", "PowerShell (7+) command").replace("# Windows PowerShell (5.1) shell notes", "# PowerShell (7+) shell notes");
  const p7 = compactTools(withBash(pwsh)).tools.find((t: any) => t.function.name === "bash")!.function.description!;
  assert.match(p7, /Chain dependent commands with && on one line/);
  assert.match(p7, /# PowerShell \(7\+\) shell notes/);
});
