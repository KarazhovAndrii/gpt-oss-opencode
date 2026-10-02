import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateToolCall, normalizePath, parseArgs, snapNearMissPath, recoverUnparsedCall } from "../src/toolcall.ts";
import { interpretHarmony } from "../src/harmony.ts";
import { OPENCODE_TOOLS } from "./helpers/proxy.ts";

/** Windows path from segments (avoids backslash-escaping mistakes in tests). */
const win = (...s: string[]) => s.join("\\");

const WIN = "C:\\Users\\me\\proj";
const ok = (r: ReturnType<typeof validateToolCall>) => {
  if (!r.ok) assert.fail(`expected valid call, got ${r.code}: ${r.error}`);
  return r.call;
};

test("unknown tool is rejected with the list of real tools", () => {
  const r = validateToolCall({ name: "python", args: '{"code":"print(1)"}' }, OPENCODE_TOOLS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "unknown_tool");
    assert.match(r.error, /Only these tools exist: bash, edit, glob, grep, read/);
  }
});

test("tool names: functions. prefix, case and separators are resolved", () => {
  assert.equal(ok(validateToolCall({ name: "functions.read", args: '{"filePath":"/a"}' }, OPENCODE_TOOLS)).name, "read");
  assert.equal(ok(validateToolCall({ name: "Glob", args: '{"pattern":"*"}' }, OPENCODE_TOOLS)).name, "glob");
  assert.equal(ok(validateToolCall({ name: "todo_write", args: '{"todos":[]}' }, OPENCODE_TOOLS)).name, "todowrite");
});

test("a bare-word file pattern becomes a name search (OpenCode matches it only as an exact file name)", () => {
  // Observed: glob "tests", "config", "yaml", "run_tests" all returned "No files found".
  const g = (pattern: string) => ok(validateToolCall({ name: "glob", args: { pattern } }, OPENCODE_TOOLS)).args.pattern;
  assert.equal(g("config"), "*config*");
  assert.equal(g("run_tests"), "*run_tests*");
  assert.equal(g(" speed gauge "), "*speed*gauge*");
  for (const p of ["*.py", "**/tests/**", "package.json", "src/*.ts", "README.md", "[ab].txt"]) assert.equal(g(p), p, p);
  const grep = ok(validateToolCall({ name: "grep", args: { pattern: "pytest", include: "pytest" } }, OPENCODE_TOOLS));
  assert.deepEqual([grep.args.pattern, grep.args.include], ["pytest", "*pytest*"], "the search pattern itself is untouched");
  assert.match(grep.repairs.join("; "), /bare-word include "pytest" -> "\*pytest\*"/);
});

test("a comma-separated file pattern list becomes one glob (ripgrep reads the comma literally)", () => {
  // Observed (OpenCode 2.x): include "**/*.ts,**/*.tsx,**/*.js" - every grep of the session found nothing.
  const grep = ok(validateToolCall({ name: "grep", args: { pattern: "class", include: "**/*.ts,**/*.tsx,**/*.js" } }, OPENCODE_TOOLS));
  assert.equal(grep.args.include, "*.{ts,tsx,js}");
  assert.match(grep.repairs.join("; "), /glob list include "\*\*\/\*\.ts,\*\*\/\*\.tsx,\*\*\/\*\.js" -> "\*\.\{ts,tsx,js\}"/);
  const g = (pattern: string) => ok(validateToolCall({ name: "glob", args: { pattern } }, OPENCODE_TOOLS)).args.pattern;
  assert.equal(g("*.cpp, *.h, *.hpp"), "*.{cpp,h,hpp}");
  assert.equal(g("*.{h,hpp},**/*.cpp"), "*.{h,hpp,cpp}", "nested braces are flattened (ripgrep rejects them)");
  // One entry with a slash anchors the whole alternation at the root: the others get **/.
  assert.equal(g("src/**/*.ts,*.cpp"), "{src/**/*.ts,**/*.cpp}");
  assert.equal(g("CMakeLists.txt,*.cmake"), "{CMakeLists.txt,*.cmake}");
  for (const p of ["*.{ts,tsx}", "**/*.cpp", "src/[a,b].txt", "{src,test}/**/*.ts"]) assert.equal(g(p), p, p);
});

test("a call is recovered from Ollama's parse error when its arguments follow the model's reasoning", () => {
  const tools2 = JSON.parse(fs.readFileSync(new URL("./fixtures/opencode2-tools.json", import.meta.url), "utf8"));
  const err = (raw: string) => `model produced unparseable tool-call arguments: error parsing tool call: raw='${raw}', err=invalid character 'W' looking for beginning of value`;
  // Observed with OpenCode 2.x via OpenWebUI + Ollama (the turn was stopped after the third of these).
  const args = '{"caseSensitive":true,"include":"**/*.ts,**/*.tsx,**/*.js","limit":200,"literal":true,"path":"C:\\\\Work\\\\app","pattern":"class"}';
  const r = recoverUnparsedCall(err(`We need to analyze Meet_gp_appComponent class. Maybe the file name is something like meet_gp_app.component.ts? We should search for class definitions. Use grep for 'class' in project.${args}`), tools2);
  assert.equal(r?.name, "grep");
  assert.equal(r?.args, args);
  assert.match(r?.dropped ?? "", /^We need to analyze .* in project\.$/);
  assert.equal(recoverUnparsedCall(err(`Use {braces} in prose, then ${args}`), tools2)?.name, "grep", "a brace in the prose is skipped");
  assert.equal(recoverUnparsedCall(err('{"path":"C:\\\\Work\\\\app\\\\main.cpp"}'), tools2)?.name, "read");
  assert.equal(recoverUnparsedCall(err('Call it.{"name":"glob","arguments":{"pattern":"*.cpp"}}'), tools2)?.name, "glob", "a named envelope keeps its tool");
  // Nothing to recover: placeholders, no JSON, a tool that is ambiguous, two candidate objects.
  assert.equal(recoverUnparsedCall(err('{"caseSensitive":???,.."}'), tools2), undefined);
  assert.equal(recoverUnparsedCall(err("We must provide JSON."), tools2), undefined);
  assert.equal(recoverUnparsedCall(err('{"pattern":"*.cpp"}'), tools2), undefined, "glob or grep");
  assert.equal(recoverUnparsedCall(err(`Either {"path":"a.cpp"} or ${args}`), tools2), undefined);
  assert.equal(recoverUnparsedCall("HTTP 400: bad request", tools2), undefined);
});

test("a call to a 'search' tool is a grep, with query as its pattern (observed)", () => {
  const c = ok(validateToolCall({ name: "search", args: { path: "/work/repo/tests", query: "dk_common" } }, OPENCODE_TOOLS, "/work/repo"));
  assert.equal(c.name, "grep");
  assert.equal(c.args.pattern, "dk_common");
  assert.equal(c.args.query, undefined);
  assert.match(c.repairs.join("; "), /resolved tool name "search" -> "grep".*renamed argument "query" -> "pattern"/);
  // A fused harmony channel name (observed in the cpp-evaluator eval, which these two ended).
  assert.equal(ok(validateToolCall({ name: "read..commentary", args: { filePath: "/a" } }, OPENCODE_TOOLS)).name, "read");
  assert.equal(validateToolCall({ name: "...commentary", args: {} }, OPENCODE_TOOLS).ok, false);
});

test("malformed JSON is rejected with a precise, model-facing error", () => {
  const r = validateToolCall({ name: "glob", args: '{"pattern":"*.py","}' }, OPENCODE_TOOLS);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "bad_json");
    assert.match(r.error, /not valid JSON/);
    assert.match(r.error, /\{ pattern: string, path\?: string \}/);
  }
});

test("JSON with trailing text or code fences is extracted", () => {
  assert.deepEqual(parseArgs('{"a":1} trailing'), { ok: true, value: { a: 1 }, repair: "extracted JSON object from surrounding text" });
  const c = ok(validateToolCall({ name: "glob", args: '```json\n{"pattern":"**/*.ts"}\n```' }, OPENCODE_TOOLS));
  assert.equal(c.args.pattern, "**/*.ts");
});

test("{name, arguments} envelope is unwrapped", () => {
  const c = ok(validateToolCall({ name: "read", args: '{"name":"read","arguments":{"filePath":"/a/b.py"}}' }, OPENCODE_TOOLS));
  assert.deepEqual(c.args, { filePath: "/a/b.py" });
  assert.ok(c.repairs.some((r) => r.includes("unwrapped")));
});

test("missing required parameter is rejected and names it", () => {
  const r = validateToolCall({ name: "edit", args: '{"filePath":"/a","oldString":"x"}' }, OPENCODE_TOOLS);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /newString is required/);
});

test("conservative coercions: numeric strings, boolean strings, nulls for optional fields", () => {
  const c = ok(validateToolCall({ name: "read", args: '{"filePath":"/a","limit":"50","offset":null}' }, OPENCODE_TOOLS));
  assert.deepEqual(c.args, { filePath: "/a", limit: 50 });
  const e = ok(validateToolCall({ name: "edit", args: '{"filePath":"/a","oldString":"a","newString":"b","replaceAll":"true"}' }, OPENCODE_TOOLS));
  assert.equal(e.args.replaceAll, true);
});

test("out-of-range optional number is dropped, not sent (bash timeout must be > 0)", () => {
  const c = ok(validateToolCall({ name: "bash", args: '{"command":"ls","timeout":0}' }, OPENCODE_TOOLS));
  assert.deepEqual(c.args, { command: "ls" });
});

test("write.content given as an object is serialized (JSON file writes)", () => {
  const c = ok(validateToolCall({ name: "write", args: { filePath: "/a/p.json", content: { name: "x", v: [1, 2] } } }, OPENCODE_TOOLS));
  assert.equal(c.args.content, '{\n  "name": "x",\n  "v": [\n    1,\n    2\n  ]\n}');
});

test("string contents and escaping are preserved exactly", () => {
  const newString = 'def f():\n\treturn "a\\\\b" + \'c\'  # ünïcødé ✓ \\n literal\n';
  const raw = JSON.stringify({ filePath: "/a.py", oldString: "x = 1\r\n", newString });
  const c = ok(validateToolCall({ name: "edit", args: raw }, OPENCODE_TOOLS));
  assert.equal(c.args.newString, newString);
  assert.equal(c.args.oldString, "x = 1\r\n");
  assert.equal(JSON.parse(c.argsJson).newString, newString);
});

test("todowrite nested array schema validates items", () => {
  const r = validateToolCall({ name: "todowrite", args: '{"todos":[{"content":"a","status":"pending"}]}' }, OPENCODE_TOOLS);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /todos\[0\]\.priority is required/);
});

test("empty optional path is removed (glob path:\"\")", () => {
  const c = ok(validateToolCall({ name: "glob", args: '{"pattern":"*.py","path":""}' }, OPENCODE_TOOLS, WIN));
  assert.deepEqual(c.args, { pattern: "*.py" });
});

test("paths on a Windows host", () => {
  assert.equal(normalizePath("/mnt/c/Users/me/proj/a.py", WIN), "C:\\Users\\me\\proj\\a.py");
  assert.equal(normalizePath("/c/Users/me/proj/a.py", WIN), "C:\\Users\\me\\proj\\a.py");
  assert.equal(normalizePath("c:/Users/me/proj/src/../a.py", WIN), "C:\\Users\\me\\proj\\a.py");
  assert.equal(normalizePath("src\\app.py", WIN), "C:\\Users\\me\\proj\\src\\app.py");
  assert.equal(normalizePath("src/app.py", WIN), "C:\\Users\\me\\proj\\src\\app.py");
  assert.equal(normalizePath("/work/repo/a.py", WIN), "/work/repo/a.py", "unresolvable POSIX root is left for the tool to report");
  assert.equal(normalizePath("/d/other", WIN), "/d/other", "git-bash form only mapped for the cwd drive");
  assert.equal(normalizePath(win("", "mnt", "c", "Users", "me", "proj", "a.py"), WIN), win("C:", "Users", "me", "proj", "a.py"), "WSL path written with backslashes (observed)");
  assert.equal(normalizePath(win("", "c", "Users", "me", "proj"), WIN), WIN, "Git-Bash path written with backslashes");
  assert.equal(normalizePath("**/*.py", WIN), "**/*.py");
});

test("paths on Linux and WSL hosts", () => {
  assert.equal(normalizePath("//work/repo/app/__main__.py", "/work/repo"), "/work/repo/app/__main__.py");
  assert.equal(normalizePath("app/core.py", "/work/repo"), "/work/repo/app/core.py");
  assert.equal(normalizePath("./app/", "/work/repo"), "/work/repo/app");
  assert.equal(normalizePath("D:\\proj\\a.py", "/mnt/d/proj"), "/mnt/d/proj/a.py");
  assert.equal(normalizePath("C:\\x\\a.py", "/home/u/proj"), "C:\\x\\a.py", "Windows path on plain Linux is left alone");
  assert.equal(normalizePath("app\\core.py", "/work/repo"), "/work/repo/app/core.py");
});

test("path normalization is applied to path parameters only", () => {
  const c = ok(validateToolCall({ name: "bash", args: '{"command":"cat app/x.py","workdir":"/mnt/c/Users/me/proj"}' }, OPENCODE_TOOLS, WIN));
  assert.equal(c.args.command, "cat app/x.py");
  assert.equal(c.args.workdir, "C:\\Users\\me\\proj");
  const g = ok(validateToolCall({ name: "grep", args: '{"pattern":"/mnt/c/foo","path":"src"}' }, OPENCODE_TOOLS, WIN));
  assert.equal(g.args.pattern, "/mnt/c/foo");
  assert.equal(g.args.path, "C:\\Users\\me\\proj\\src");
});

test("near-miss paths invented by the model are snapped to the working directory (observed cases)", () => {
  const root = ["D:", "sandbox", "improved_tools_agent", ".eval-runs"];
  const cwd = win(...root, "2026-09-24T07-57-43-v4-compact-x2", "feature-median-1", "repo");
  const grounded = `Working directory: ${cwd}\n${win(cwd, "src", "stats.js")}`;
  // a digit changed in a long timestamped directory name
  assert.equal(snapNearMissPath(win(...root, "2026-09-24T07-57-45-v4-compact-x2", "feature-median-1", "repo", "src", "stats.js"), cwd, grounded), win(cwd, "src", "stats.js"));
  // a Unicode non-breaking hyphen instead of "-"
  assert.equal(snapNearMissPath(win(...root, "2026-09-24T07-57-43-v4-compact\u2011x2", "feature-median-1", "repo", "a.js"), cwd, grounded), win(cwd, "a.js"));
  // wrong drive letter (model converted /mnt/d/... itself)
  assert.equal(snapNearMissPath(win("C:", ...root.slice(1), "2026-09-24T07-57-43-v4-compact-x2", "feature-median-1", "repo", "f.js"), cwd, grounded), win(cwd, "f.js"));
  // garbage beyond one segment: left alone (the tool reports it)
  assert.equal(snapNearMissPath(win("D:", "sandbox", "improved_tools_agent", ".eval-rodes", "...."), cwd, grounded), undefined);
  // already inside the project
  assert.equal(snapNearMissPath(win(cwd, "src", "a.js"), cwd, grounded), undefined);
});

test("a sibling path that was actually mentioned is never snapped", () => {
  const cwd = win("D:", "work", "projA", "repo");
  const sibling = win("D:", "work", "projB", "repo", "x.js");
  assert.equal(snapNearMissPath(sibling, cwd, `please compare with ${sibling}`), undefined);
  // never mentioned anywhere -> a typo of the working directory
  assert.equal(snapNearMissPath(sibling, cwd, `Working directory: ${cwd}`), win(cwd, "x.js"));
  // POSIX
  assert.equal(snapNearMissPath("/home/ann/proj-1234/src/a.py", "/home/ann/proj-1243", "cwd /home/ann/proj-1243"), "/home/ann/proj-1243/src/a.py");
  assert.equal(snapNearMissPath("/etc/passwd", "/home/ann/proj", ""), undefined);
});

test("validation snaps only with grounding context, and logs the repair", () => {
  const cwd = win("D:", "w", "run-0457", "repo");
  const typo = win("D:", "w", "run-0475", "repo", "a.js");
  const v = validateToolCall({ name: "read", args: JSON.stringify({ filePath: typo }) }, OPENCODE_TOOLS, cwd, `Working directory: ${cwd}`);
  assert.ok(v.ok && v.call.args.filePath === win(cwd, "a.js") && v.call.repairs.some((r) => r.startsWith("normalized filePath")));
  const noGrounding = validateToolCall({ name: "read", args: JSON.stringify({ filePath: typo }) }, OPENCODE_TOOLS, cwd);
  assert.ok(noGrounding.ok && noGrounding.call.args.filePath === typo);
});

test("an invented path with a garbled middle is re-anchored on the working directory (observed)", async () => {
  const { reanchorPath } = await import("../src/toolcall.ts");
  const root = ["D:", "sandbox", "improved_tools_agent", ".eval-runs"];
  const cwd = win(...root, "2026-09-25T11-59-53-cpp-evaluator", "cpp-evaluator", "repo");
  const grounded = `Working directory: ${cwd}\n${win(cwd, "tests", "check.hpp")}\n${win(cwd, "src", "eval.cpp")}`;
  // invented timestamp and a dropped segment
  assert.equal(reanchorPath(win(...root, "2026-09-12T12-48-02-cpp-evaluator", "repo", "tests", "test_eval.cpp"), cwd, grounded), win(cwd, "tests", "test_eval.cpp"));
  // the repeated "cpp-evaluator" segment dropped
  assert.equal(reanchorPath(win(...root, "2026-09-25T11-59-53-cpp-evaluator", "repo", "tests", "test_eval.cpp"), cwd, grounded), win(cwd, "tests", "test_eval.cpp"));
  // a file directly in the working directory
  assert.equal(reanchorPath(win(...root, "x", "repo", "README.md"), cwd, grounded), win(cwd, "README.md"));
  // lands in a directory never mentioned: left alone
  assert.equal(reanchorPath(win(...root, "x", "repo", "docs", "a.md"), cwd, grounded), undefined);
  // a real sibling someone mentioned is taken literally
  const sibling = win(...root, "older-run", "repo", "tests", "check.hpp");
  assert.equal(reanchorPath(sibling, cwd, `${grounded}\ncompare with ${sibling}`), undefined);
  // unrelated roots and paths already inside the project
  assert.equal(reanchorPath(win("C:", "Windows", "repo", "tests", "a.cpp"), cwd, grounded), undefined);
  assert.equal(reanchorPath(win(cwd, "tests", "a.cpp"), cwd, grounded), undefined);
  // POSIX
  assert.equal(reanchorPath("/home/ann/runs/b/repo/src/a.py", "/home/ann/runs/a/job/repo", "cwd /home/ann/runs/a/job/repo\n/home/ann/runs/a/job/repo/src/b.py"), "/home/ann/runs/a/job/repo/src/a.py");
  // end to end through validation
  const v = validateToolCall({ name: "edit", args: JSON.stringify({ filePath: win(...root, "2026-09-25T11-59-53-cpp-evaluator", "repo", "tests", "test_eval.cpp"), oldString: "a", newString: "b" }) }, OPENCODE_TOOLS, cwd, grounded);
  assert.ok(v.ok && v.call.args.filePath === win(cwd, "tests", "test_eval.cpp"));
});

test("an ellipsis inside a segment is expanded only to a location the conversation mentioned (observed)", async () => {
  const { expandElidedPath } = await import("../src/toolcall.ts");
  const cwd = win("D:", "sandbox", "improved_tools_agent", ".eval-runs", "2026-09-29T09-38-49-release-3", "feature-median", "repo");
  const grounded = `Working directory: ${cwd}\n${win(cwd, "src", "stats.js")}`;
  const observed = win("D:", "sandbox", "improved_tools_agent", ".eval-r...", "src", "stats.js");
  assert.equal(expandElidedPath(observed, cwd, grounded), win(cwd, "src", "stats.js"));
  // the tail starts with the project folder: expanded as before
  assert.equal(expandElidedPath(win("D:", "sandbox", "impr…", "repo", "a.js"), cwd, grounded), win(cwd, "a.js"));
  // a target nobody mentioned, or a prefix that does not match the working directory: left alone
  assert.equal(expandElidedPath(win("D:", "sandbox", "improved_tools_agent", ".eval-r...", "src", "other.js"), cwd, grounded), undefined);
  assert.equal(expandElidedPath(win("D:", "sandbox", "zzz...", "src", "stats.js"), cwd, grounded), undefined);
  const v = validateToolCall({ name: "read", args: JSON.stringify({ filePath: observed, offset: 1, limit: 2000 }) }, OPENCODE_TOOLS, cwd, grounded);
  assert.ok(v.ok && v.call.args.filePath === win(cwd, "src", "stats.js"));
});

test("paths with characters Windows forbids are rejected with a clear error (observed junk)", () => {
  const cwd = win("D:", "sandbox", "improved_tools_agent", ".eval-runs", "run", "feature-median", "repo");
  const junk = win("D:", "sandbox", "improved_tools_agent", ".eval-runs", "2026-09-uite? self...?");
  const v = validateToolCall({ name: "read", args: JSON.stringify({ filePath: junk, "???": "" }) }, OPENCODE_TOOLS, cwd, `Working directory: ${cwd}`);
  assert.ok(!v.ok && v.code === "schema" && /cannot contain/.test(v.error));
  // a wildcard in glob's directory argument points to "pattern"
  const g = validateToolCall({ name: "glob", args: JSON.stringify({ pattern: "*.js", path: "src/**" }) }, OPENCODE_TOOLS, cwd);
  assert.ok(!g.ok && /put wildcard patterns in "pattern"/.test(g.error));
  // wildcards in the pattern itself, and the \\?\ long-path prefix, are fine
  assert.ok(validateToolCall({ name: "glob", args: JSON.stringify({ pattern: "src/**/*.js" }) }, OPENCODE_TOOLS, cwd).ok);
  assert.ok(validateToolCall({ name: "read", args: JSON.stringify({ filePath: `\\\\?\\${win(cwd, "a.js")}` }) }, OPENCODE_TOOLS, cwd).ok);
  // POSIX working directories are not restricted
  assert.ok(validateToolCall({ name: "read", args: JSON.stringify({ filePath: "/work/repo/what?.txt" }) }, OPENCODE_TOOLS, "/work/repo").ok);
});

test("a reply that is only a tool-call header fragment is a protocol error, not an answer (observed)", async () => {
  const { harmonyAdapter, nativeAdapter } = await import("../src/strategies.ts");
  const r = { content: " to=functions.read?", reasoning: "", toolCalls: [], finishReason: "stop" } as any;
  assert.match(harmonyAdapter.interpret(r).protocolError ?? "", /only the start of a function call/);
  assert.match(nativeAdapter.interpret(r).protocolError ?? "", /only the start of a function call/);
  // the harmony parser files the fragment as analysis and leaves "??" as the text
  const split = { ...r, content: " to=functions.read?<|constrain|>??" };
  assert.match(harmonyAdapter.interpret(split).protocolError ?? "", /only the start of a function call/);
  // a complete call is a call, not a fragment
  const full = { ...r, content: '<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"a.js"}' };
  assert.equal(harmonyAdapter.interpret(full).protocolError, undefined);
  // ordinary answers, including ones that mention the syntax later, are untouched
  assert.equal(harmonyAdapter.interpret({ ...r, content: "Done: median() added; tests pass." }).protocolError, undefined);
  assert.equal(harmonyAdapter.interpret({ ...r, content: "Harmony calls look like `to=functions.read`." }).protocolError, undefined);
});

test("malformed harmony headers: fused content-type and arguments inside the recipient", () => {
  assert.equal(ok(validateToolCall({ name: "globjson", args: '{"pattern":"*.js"}' }, OPENCODE_TOOLS)).name, "glob");
  const t = interpretHarmony("", 'x<|end|><|start|>assistant<|channel|>commentary to=functions.read>{"filePath":"/a/b.js","limit":5}()<|message|>');
  const c = ok(validateToolCall({ name: t.call!.name, args: t.call!.args }, OPENCODE_TOOLS));
  assert.deepEqual([c.name, c.args], ["read", { filePath: "/a/b.js", limit: 5 }]);
});


test("a path abbreviated with an ellipsis segment is expanded to the working directory (observed)", async () => {
  const { expandElidedPath } = await import("../src/toolcall.ts");
  const cwd = win("D:", "sandbox", "improved_tools_agent", ".eval-runs", "2026-09-25T04-17-45-v7", "fix-syntax", "repo");
  const grounded = `Working directory: ${cwd}`;
  assert.equal(expandElidedPath(win("D:", "sandbox", "..", "repo", "src", "parser.js"), cwd, grounded), win(cwd, "src", "parser.js"));
  assert.equal(expandElidedPath(win("D:", "sandbox", "…", "repo", "a.js"), cwd, grounded), win(cwd, "a.js"));
  // a genuine parent reference that does not re-enter the project is left alone
  assert.equal(expandElidedPath(win("D:", "sandbox", "..", "other", "a.js"), cwd, grounded), undefined);
  // mentioned in the conversation -> taken literally
  const literal = win("D:", "sandbox", "..", "repo", "x.js");
  assert.equal(expandElidedPath(literal, cwd, `see ${literal}`), undefined);
  // end to end through validation
  const v = validateToolCall({ name: "read", args: JSON.stringify({ filePath: win("D:", "sandbox", "..", "repo", "src", "parser.js") }) }, OPENCODE_TOOLS, cwd, grounded);
  assert.ok(v.ok && v.call.args.filePath === win(cwd, "src", "parser.js"));
});
