import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretHarmony, parseHarmony, renderToolNamespace } from "../src/harmony.ts";
import { OPENCODE_TOOLS } from "./helpers/proxy.ts";

test("renders tools as the harmony TypeScript namespace", () => {
  const ns = renderToolNamespace(OPENCODE_TOOLS);
  assert.match(ns, /^# Tools\n\n## functions\n\nnamespace functions \{/);
  assert.match(ns, /type read = \(_: \{\n\/\/ The absolute path to the file or directory to read\nfilePath: string,\n/);
  assert.match(ns, /offset\?: number,/);
  assert.match(ns, /format\?: "text" \| "markdown" \| "html", \/\/ default: markdown/);
  // nested array of objects (todowrite)
  assert.match(ns, /todos: Array<\{/);
  assert.match(ns, /\} \/\/ namespace functions$/);
});

test("renders a parameterless tool", () => {
  const ns = renderToolNamespace([{ function: { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} } } }]);
  assert.match(ns, /\/\/ Ping\.\ntype ping = \(\) => any;/);
});

test("stop-sequence reply: analysis then tool call in content (observed on SiliconFlow)", () => {
  const content =
    "We need to find main Python entry point. Let's search.<|end|><|start|>assistant<|channel|>commentary to=functions.glob <|constrain|>json<|message|>{\"pattern\":\"**/*.py\",\"path\":\"/work/repo\"}";
  const t = interpretHarmony("", content);
  assert.equal(t.call?.name, "glob");
  assert.deepEqual(JSON.parse(t.call!.args), { pattern: "**/*.py", path: "/work/repo" });
  assert.equal(t.reasoning, "We need to find main Python entry point. Let's search.");
  assert.equal(t.text, "");
});

test("no stop sequence: call inside reasoning, followed by a model-imagined tool result, is cut at the call", () => {
  const reasoning =
    'We need to find main. Let\'s read __main__.py.<|end|><|start|>assistant<|channel|>commentary to=read code<|message|>{"name":"read","arguments":{"filePath":"/work/repo/app/__main__.py"}}<|call|>commentary<|message|>{"tool_result": {"output": "import sys"}}<|call|>commentary<|message|>We need to explain.';
  const t = interpretHarmony(reasoning, "```json\n{\"final\": \"made up\"}\n```");
  assert.equal(t.call?.name, "read");
  assert.match(t.call!.args, /__main__\.py/);
  assert.ok(t.discarded > 0);
  assert.equal(t.text, "");
});

test("server-split final answer", () => {
  const t = interpretHarmony("The user wants 17*23.", "391");
  assert.equal(t.call, undefined);
  assert.equal(t.text, "391");
  assert.equal(t.reasoning, "The user wants 17*23.");
});

test("raw final channel inside content", () => {
  const t = interpretHarmony("", "Think about it.<|end|><|start|>assistant<|channel|>final<|message|>The answer is **42**.<|return|>");
  assert.equal(t.text, "The answer is **42**.");
  assert.equal(t.reasoning, "Think about it.");
});

test("garbled constrain header still yields the call (observed degenerate output)", () => {
  const t = interpretHarmony("", '<|channel|>commentary to=functions.read<|constrain|>?<|constrain|>fjson<|message|>{"filePath": "C:\\\\x\\\\a.py"}');
  assert.equal(t.call?.name, "read");
  assert.deepEqual(JSON.parse(t.call!.args), { filePath: "C:\\x\\a.py" });
});

test("recipient in the role position", () => {
  const t = interpretHarmony("", 'plan<|end|><|start|>assistant to=functions.bash<|channel|>commentary json<|message|>{"command":"ls"}<|call|>');
  assert.equal(t.call?.name, "bash");
  assert.equal(t.call?.terminated, true);
});

test("tool-voice message after a call marks hallucinated output", () => {
  const t = interpretHarmony(
    "",
    'x<|end|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"/a"}<|call|><|start|>functions.read to=assistant<|channel|>commentary<|message|>fake contents<|end|>',
  );
  assert.equal(t.call?.name, "read");
  assert.equal(t.hallucinatedToolOutput, true);
});

test("commentary preamble without recipient is user-visible text", () => {
  const t = interpretHarmony("", "<|channel|>commentary<|message|>Running the tests now.<|end|><|start|>assistant<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{\"command\":\"npm test\"}");
  assert.equal(t.text, "Running the tests now.");
  assert.equal(t.call?.name, "bash");
});

test("consecutive calls without results are collected as extra calls", () => {
  const c =
    'a<|end|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"/a"}<|call|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"/b"}<|call|>';
  const t = interpretHarmony("", c);
  assert.equal(t.call?.name, "read");
  assert.equal(t.extraCalls.length, 1);
});

test("truncated right after a call header", () => {
  const msgs = parseHarmony("hm<|end|><|start|>assistant<|channel|>commentary to=functions.glob <|constrain|>json", "analysis");
  assert.equal(msgs.at(-1)?.recipient, "functions.glob");
});

test("text with no harmony tokens and no reasoning is a final answer", () => {
  const t = interpretHarmony("", "Plain answer with <tags> and {json}.");
  assert.equal(t.text, "Plain answer with <tags> and {json}.");
  assert.equal(t.call, undefined);
});

test("implicit segment terminated by <|return|> is the final answer", () => {
  const t = interpretHarmony("", "All done: 3 files changed.<|return|>");
  assert.equal(t.text, "All done: 3 files changed.");
});

test("compact tool descriptions keep dynamic facts and never touch schemas", async () => {
  const { compactTools } = await import("../src/compact.ts");
  const r = compactTools(OPENCODE_TOOLS);
  assert.deepEqual(r.compacted.sort(), ["bash", "task", "todowrite"]);
  assert.ok(r.after < r.before * 0.65, `${r.before} -> ${r.after}`);
  const bash = r.tools.find((t: any) => t.function.name === "bash")!;
  assert.match(bash.function.description!, /OS: win32, Shell: bash/);
  assert.match(bash.function.description!, /for temporary work outside the workspace/);
  const task = r.tools.find((t: any) => t.function.name === "task")!;
  assert.match(task.function.description!, /- explore: Fast agent/);
  for (const [i, t] of r.tools.entries()) assert.deepEqual(t.function.parameters, OPENCODE_TOOLS[i].function.parameters);
  // Unknown shape -> untouched
  const odd = compactTools([{ function: { name: "bash", description: "Run things.", parameters: {} } }]);
  assert.equal(odd.tools[0].function.description, "Run things.");
});

test("plain text after a terminator without any header is kept as the answer", () => {
  const t = interpretHarmony("", "Let me think.<|end|>The config sets retries to 5.");
  assert.equal(t.text, "The config sets retries to 5.");
  assert.equal(t.reasoning, "Let me think.");
  // but a dangling header fragment is not mistaken for an answer
  assert.equal(interpretHarmony("", "x<|end|><|start|>assistant<|channel|>final").text, "");
});
