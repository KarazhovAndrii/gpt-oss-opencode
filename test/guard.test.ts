import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTurn, canonicalKey, findRedundant, isErrorResult, redundantHint } from "../src/guard.ts";
import type { ChatMessage } from "../src/messages.ts";

let n = 0;
function turn(...steps: [string, object, string][]): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "do it" }];
  for (const [name, args, result] of steps) {
    const id = `c${n++}`;
    msgs.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    msgs.push({ role: "tool", tool_call_id: id, content: result });
  }
  return msgs;
}
const read = (p: string) => ["read", { filePath: p }, `<content>1: x</content>`] as [string, object, string];

test("identical read with nothing changed in between is redundant", () => {
  const a = analyzeTurn(turn(read("/a.py"), ["glob", { pattern: "*" }, "/a.py"]));
  assert.ok(findRedundant(a.steps, canonicalKey("read", { filePath: "/a.py" })));
});

test("argument order does not matter for identity", () => {
  const a = analyzeTurn(turn(["read", { filePath: "/a", limit: 5 }, "x"]));
  assert.ok(findRedundant(a.steps, canonicalKey("read", { limit: 5, filePath: "/a" })));
});

test("a successful edit in between makes a re-read legitimate", () => {
  const a = analyzeTurn(turn(read("/a.py"), ["edit", { filePath: "/a.py", oldString: "x", newString: "y" }, "Edit applied successfully."]));
  assert.equal(findRedundant(a.steps, canonicalKey("read", { filePath: "/a.py" })), undefined);
});

test("a failed edit does not count as a change; repeating it is redundant and the hint says it failed", () => {
  const edit = { filePath: "/a.py", oldString: "nope", newString: "y" };
  const a = analyzeTurn(turn(read("/a.py"), ["edit", edit, "Error: oldString not found in content"]));
  assert.ok(findRedundant(a.steps, canonicalKey("read", { filePath: "/a.py" })));
  const prev = findRedundant(a.steps, canonicalKey("edit", edit));
  assert.ok(prev);
  assert.match(redundantHint(prev!), /failed then/);
});

test("bash: same command twice in a row is redundant, but not across other commands", () => {
  const a = analyzeTurn(turn(["bash", { command: "pytest" }, "1 failed"]));
  assert.ok(findRedundant(a.steps, canonicalKey("bash", { command: "pytest" })));
  const b = analyzeTurn(turn(["bash", { command: "pytest" }, "1 failed"], ["bash", { command: "sed -i s/a/b/ x.py" }, ""]));
  assert.equal(findRedundant(b.steps, canonicalKey("bash", { command: "pytest" })), undefined);
});

test("tools with unknown side effects are never flagged", () => {
  const a = analyzeTurn(turn(["deploy", { env: "x" }, "ok"]));
  assert.equal(findRedundant(a.steps, canonicalKey("deploy", { env: "x" })), undefined);
});

test("earlier result pruned by OpenCode compaction: re-reading is legitimate", () => {
  const a = analyzeTurn(turn(["read", { filePath: "/a" }, "[Old tool result content cleared]"]));
  assert.equal(findRedundant(a.steps, canonicalKey("read", { filePath: "/a" })), undefined);
});

test("only the current user turn is considered", () => {
  const msgs = turn(read("/a.py"));
  msgs.push({ role: "assistant", content: "done" }, { role: "user", content: "again please" });
  const a = analyzeTurn(msgs);
  assert.equal(a.steps.length, 0);
});

test("consecutive errors and executed-redundant counts", () => {
  const a = analyzeTurn(
    turn(read("/a"), read("/a"), ["read", { filePath: "/missing" }, "Error: File not found: /missing"], ["glob", { pattern: "x" }, "Error: ripgrep execution failed"]),
  );
  assert.equal(a.consecutiveErrors, 2);
  assert.equal(a.redundantExecuted, 1);
});

test("error result detection", () => {
  assert.ok(isErrorResult("Error: oldString not found in content"));
  assert.ok(isErrorResult("File not found: C:\\x"));
  assert.ok(!isErrorResult("<path>/a</path>\n<content>1: error handling code</content>"));
});

test("bash repeats ignore volatile params; one timeout escalation is allowed, not more", () => {
  const cmd = "npm run build";
  const timedOut = "(no output)\n<shell_metadata> shell tool terminated command after exceeding timeout 120000 ms";
  // same command, different description -> redundant
  const a = analyzeTurn(turn(["bash", { command: "ls", description: "list" }, "a.txt"]));
  assert.ok(findRedundant(a.steps, canonicalKey("bash", { command: "ls", description: "list files" })));
  // timed out once: a larger timeout is a legitimate retry
  const b = analyzeTurn(turn(["bash", { command: cmd, timeout: 120000 }, timedOut]));
  assert.equal(findRedundant(b.steps, canonicalKey("bash", { command: cmd, timeout: 300000 }), { command: cmd, timeout: 300000 }), undefined);
  // same or smaller timeout after a timeout -> redundant
  assert.ok(findRedundant(b.steps, canonicalKey("bash", { command: cmd, timeout: 120000 }), { command: cmd, timeout: 120000 }));
  // timed out twice: no further escalation
  const c = analyzeTurn(turn(["bash", { command: cmd, timeout: 120000 }, timedOut], ["bash", { command: cmd, timeout: 300000 }, timedOut.replace("120000", "300000")]));
  assert.ok(findRedundant(c.steps, canonicalKey("bash", { command: cmd, timeout: 600000 }), { command: cmd, timeout: 600000 }));
});

test("a wait loop that timed out gets no timeout escalation (observed in status-poll)", () => {
  const timedOut = "(no output)\n<shell_metadata> shell tool terminated command after exceeding timeout 120000 ms";
  const loops = [
    `bash -c 'while true; do if grep -q READY status.txt; then job=$(grep -oP "job \\K[0-9]+" status.txt); echo "Job $job"; break; fi; sleep 5; done'`,
    "while ! grep -q READY status.txt; do sleep 1; done",
    "until grep -q READY status.txt; do sleep 2; done",
    "while ($true) { if (Select-String -Quiet READY status.txt) { break }; Start-Sleep 5 }",
    "tail -f app.log",
  ];
  for (const cmd of loops) {
    const a = analyzeTurn(turn(["bash", { command: cmd }, timedOut]));
    const prev = findRedundant(a.steps, canonicalKey("bash", { command: cmd, timeout: 600000 }), { command: cmd, timeout: 600000 });
    assert.ok(prev, cmd);
    assert.match(redundantHint(prev), /waits in a loop for a condition/);
  }
  // a loop that did not time out is judged like any other repeat; other commands keep their escalation
  const b = analyzeTurn(turn(["bash", { command: "npm test" }, timedOut]));
  assert.equal(findRedundant(b.steps, canonicalKey("bash", { command: "npm test", timeout: 600000 }), { command: "npm test", timeout: 600000 }), undefined);
  // a rewritten wait loop with a longer timeout after one timed out (observed), even with a check in between
  const c = analyzeTurn(turn(["bash", { command: loops[1], timeout: 120000 }, timedOut], ["bash", { command: "grep -oP 'job \\d+' status.txt" }, "job 7731"]));
  const rewritten = { command: "until grep -q READY status.txt; do sleep 5; done; echo done", timeout: 300000 };
  assert.ok(findRedundant(c.steps, canonicalKey("bash", rewritten), rewritten));
  // ...but a short re-check loop, or a first wait loop in the turn, is not blocked
  const short = { command: "until grep -q READY status.txt; do sleep 5; done", timeout: 30000 };
  assert.equal(findRedundant(c.steps, canonicalKey("bash", short), short), undefined);
  assert.equal(findRedundant(analyzeTurn(turn(read("/a"))).steps, canonicalKey("bash", rewritten), rewritten), undefined);
});
