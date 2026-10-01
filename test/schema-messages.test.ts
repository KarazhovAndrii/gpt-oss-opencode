import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceAndValidate, signature } from "../src/schema.ts";
import { normalizeHistory, currentObjective, findWorkingDirectory, textOf } from "../src/messages.ts";

test("schema: enum case normalization, anyOf, $ref and array wrapping", () => {
  const s = {
    type: "object",
    $defs: { mode: { type: "string", enum: ["fast", "safe"] } },
    properties: {
      mode: { $ref: "#/$defs/mode" },
      target: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      files: { type: "array", items: { type: "string" } },
    },
    required: ["mode"],
  };
  const r = coerceAndValidate(s, { mode: "FAST", target: ["a"], files: '["x","y"]' });
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.value, { mode: "fast", target: ["a"], files: ["x", "y"] });
  assert.ok(r.repairs.length >= 2);
});

test("schema: integer rejects fractional for required, extra properties kept unless forbidden", () => {
  const s = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  assert.equal(coerceAndValidate(s, { n: 1.5 }).issues.length, 1);
  assert.deepEqual(coerceAndValidate(s, { n: 2, extra: 1 }).value, { n: 2, extra: 1 });
  const strict = { ...s, additionalProperties: false };
  assert.deepEqual(coerceAndValidate(strict, { n: 2, extra: 1 }).value, { n: 2 });
});

test("signature renders compact parameter lists", () => {
  assert.equal(
    signature({ type: "object", properties: { a: { type: "string" }, b: { type: "array", items: { type: "integer" } }, c: { enum: ["x", "y"] } }, required: ["a"] }),
    '{ a: string, b?: integer[], c?: "x" | "y" }',
  );
});

test("normalizeHistory merges system messages, splits multi-call turns and pairs results", () => {
  const out = normalizeHistory([
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:..." } }] },
    {
      role: "assistant",
      content: "Reading both.",
      tool_calls: [
        { id: "1", type: "function", function: { name: "read", arguments: '{"filePath":"/a"}' } },
        { id: "2", type: "function", function: { name: "read", arguments: "not json" } },
      ],
    },
    { role: "tool", tool_call_id: "2", content: "B-content" },
    { role: "tool", tool_call_id: "1", content: "A-content" },
    { role: "tool", tool_call_id: "orphan", content: "?" },
  ]);
  assert.equal(out[0].content, "A\n\nB");
  assert.match(textOf(out[1].content), /look\n\[image_url attachment omitted/);
  assert.deepEqual(
    out.slice(2).map((m) => [m.role, m.tool_calls?.[0]?.id ?? m.tool_call_id, m.content]),
    [
      ["assistant", "1", "Reading both."],
      ["tool", "1", "A-content"],
      ["assistant", "2", null],
      ["tool", "2", "B-content"],
    ],
  );
  assert.equal(out[4].tool_calls![0].function.arguments, JSON.stringify({ _unparseable_arguments: "not json" }));
});

test("a tool call without a result gets a placeholder so the history stays well-formed", () => {
  const out = normalizeHistory([{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "9", type: "function", function: { name: "bash", arguments: "{}" } }] }]);
  assert.equal(out.at(-1)?.role, "tool");
});

test("objective and working directory extraction", () => {
  const msgs = [
    { role: "system" as const, content: "stuff\n<env>\n  Working directory: C:\\Users\\me\\proj\n  Platform: win32\n</env>" },
    { role: "user" as const, content: '"Fix the bug in app.py"' },
  ];
  assert.equal(findWorkingDirectory(msgs), "C:\\Users\\me\\proj");
  assert.equal(currentObjective(msgs), "Fix the bug in app.py");
  assert.equal(currentObjective([{ role: "user", content: "hi <system-reminder>ignore</system-reminder>" }]), "hi");
});

test("fitContext trims the oldest large tool results first and protects the latest two", async () => {
  const { fitContext, estimateTokens } = await import("../src/messages.ts");
  const big = "x".repeat(40_000);
  const msgs: any[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
  for (let i = 0; i < 4; i++) {
    msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }] });
    msgs.push({ role: "tool", tool_call_id: `c${i}`, content: `${i}:${big}` });
  }
  const r = fitContext(msgs, 30_000);
  assert.ok(r.before > 30_000 && r.after <= 30_000, `${r.before} -> ${r.after}`);
  assert.match(String(r.messages[3].content), /omitted by gpt-oss-proxy/);
  assert.ok(String(r.messages[9].content).startsWith("3:x"), "latest result intact");
  assert.equal(msgs[3].content.length, big.length + 2, "input not mutated");
  assert.equal(fitContext(msgs, 1e9).trimmed, 0);
  assert.ok(estimateTokens(msgs) > 40_000);
});

test("fitContext cuts a pasted document larger than the window to its beginning and end, sparing tool results", async () => {
  const { fitContext } = await import("../src/messages.ts");
  // ~1.1M tokens of JSON pasted into the prompt (a real session: Ollama then kept only its tail).
  const paste = `Write a Python script that converts this JSON to HTML:\n${JSON.stringify({ issues: Array.from({ length: 12_000 }, (_, i) => ({ key: `DICHMI-${i}`, summary: "x".repeat(250) })) })}\nKeep each field labeled.`;
  const result = "1: import json\n".repeat(400);
  const msgs: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "text", text: paste }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: result },
  ];
  const r = fitContext(msgs, 19_000);
  assert.ok(r.before > 1_000_000 && r.after <= 19_000, `${r.before} -> ${r.after}`);
  const user = String(r.messages[1].content);
  assert.ok(user.startsWith("Write a Python script that converts this JSON to HTML:"), "instruction before the paste kept");
  assert.ok(user.endsWith("Keep each field labeled."), "instruction after the paste kept");
  assert.match(user, /\[… \d+ characters of this message omitted by gpt-oss-proxy: the message is larger than the model's context window/);
  assert.equal(r.messages[3].content, result, "the tool result is not sacrificed for the paste");
  assert.deepEqual(r.cuts.map((c) => [c.index, c.role, c.chars]), [[1, "user", paste.length]]);
  assert.ok(r.cuts[0].kept > 20_000, `kept ${r.cuts[0].kept} chars`);
});

test("fitContext reports the true omission when a message is cut twice", async () => {
  const { fitContext } = await import("../src/messages.ts");
  const msgs: any[] = [{ role: "system", content: "s".repeat(30_000) }, { role: "user", content: `A${"x".repeat(200_000)}Z` }];
  const r = fitContext(msgs, 12_000);
  assert.ok(r.after <= 12_000, `${r.after}`);
  const user = String(r.messages[1].content);
  const omitted = Number(user.match(/\[… (\d+) characters/)?.[1]);
  assert.equal(omitted, 200_002 - r.cuts[0].kept);
  assert.equal((user.match(/omitted by gpt-oss-proxy/g) ?? []).length, 1, "one omission note, not nested ones");
});

test("after OpenCode compacted a session, the objective comes from the summary, not its follow-up", () => {
  // Shape OpenCode 1.18 sends after compaction (captured with a probe).
  const msgs: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "What did we do so far?" },
    { role: "assistant", content: "## Goal\nAdd mode() to src/stats.js with tests.\n## Progress\nmode() written, tests not run yet." },
    { role: "user", content: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." },
  ];
  assert.match(currentObjective(msgs), /^Continue the task described in this summary of the conversation so far:\n## Goal\nAdd mode\(\)/);
  msgs[3] = { role: "user", content: "The previous request exceeded the provider's size limit due to large media attachments." };
  assert.match(currentObjective(msgs), /Add mode\(\) to src\/stats\.js/);
  // Compacted after a final answer: OpenCode keeps that answer between the summary and the follow-up.
  msgs.splice(3, 0, { role: "assistant", content: "Done: mode() added." });
  msgs[4] = { role: "user", content: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." };
  assert.match(currentObjective(msgs), /summary of the conversation so far:\n## Goal\nAdd mode\(\)/);
  msgs[4] = { role: "user", content: "Now also add median()." };
  assert.equal(currentObjective(msgs), "Now also add median().", "a real follow-up after a manual /compact is the objective");
});

test("currentObjective keeps both ends of a long request", () => {
  const t = `Convert this:\n${"y".repeat(5000)}\nto an HTML table.`;
  const o = currentObjective([{ role: "user", content: t }]);
  assert.ok(o.startsWith("Convert this:") && o.endsWith("to an HTML table."), o.slice(0, 40));
  assert.ok(o.length < 1600);
});
