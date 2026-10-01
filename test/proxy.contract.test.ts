// Contract tests: proxy <-> scripted provider <-> OpenAI-compatible client.
// The AI SDK tests use the same provider package OpenCode uses, so they verify
// that what the proxy emits is parsed into proper tool calls / text / reasoning.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { streamText, generateText, tool, jsonSchema } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { startMockUpstream, harmonyCall, harmonyFinal, chunk, type MockUpstream } from "./helpers/mock-upstream.ts";
import { startProxy, chat, systemPrompt, OPENCODE_TOOLS, type TestProxy } from "./helpers/proxy.ts";

const USER = { role: "user", content: "Find the main Python entry point, read it, and explain what it does." };
const base = (extra: object = {}) => ({ model: "mock", stream: true, stream_options: { include_usage: true }, tools: OPENCODE_TOOLS, messages: [{ role: "system", content: systemPrompt() }, USER], ...extra });

function sseToolCalls(events: any[]) {
  return events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
}
function sseText(events: any[]) {
  return events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
}
function sseFinish(events: any[]) {
  return events.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).at(-1);
}

describe("harmony strategy", () => {
  let up: MockUpstream;
  let px: TestProxy;
  before(async () => {
    up = await startMockUpstream();
    px = await startProxy(up.url);
  });
  after(async () => {
    await px.close();
    await up.close();
  });

  test("AI SDK receives a well-formed tool call (OpenCode's provider package)", async () => {
    up.push(harmonyCall("glob", { pattern: "**/*.py" }, "Search for python files."));
    const provider = createOpenAICompatible({ name: "gpt-oss", baseURL: px.url, includeUsage: true });
    const result = streamText({
      model: provider.chatModel("mock"),
      system: systemPrompt(),
      prompt: USER.content,
      tools: {
        glob: tool({ description: "glob", inputSchema: jsonSchema({ type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] }) }),
        read: tool({ description: "read", inputSchema: jsonSchema({ type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] }) }),
      },
    });
    const parts: any[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const call = parts.find((p) => p.type === "tool-call");
    assert.equal(call.toolName, "glob");
    assert.deepEqual(call.input, { pattern: "**/*.py" });
    assert.match(call.toolCallId, /^call_/);
    assert.ok(parts.some((p) => p.type === "reasoning-delta" && /Search for python files/.test(p.text)), "analysis is surfaced as reasoning");
    const fin = parts.find((p) => p.type === "finish-step");
    assert.equal(fin.finishReason, "tool-calls");
    assert.equal(fin.usage.inputTokens, 100);
  });

  test("upstream request: no native tools, harmony namespace + rules in system, stop at <|call|>, clamped max_tokens", async () => {
    up.requests.length = 0;
    up.push(harmonyCall("glob", { pattern: "**/*.py" }));
    await chat(px.url, base({ max_tokens: 32000 }));
    const sent = up.requests[0];
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.stop, ["<|call|>"]);
    assert.equal(sent.max_tokens, 8192);
    assert.equal(sent.messages[0].role, "system");
    assert.match(sent.messages[0].content, /namespace functions \{/);
    assert.match(sent.messages[0].content, /# Current user request[\s\S]*Find the main Python entry point/);
    assert.match(sent.messages[0].content, /Working directory: \/work\/repo/);
  });

  test("multi-step: tool results go back as native history and the final answer is streamed as text", async () => {
    up.requests.length = 0;
    up.push(harmonyFinal("The entry point is `app/__main__.py`; it prints BANANA-42.", "I have read the file."));
    const r = await chat(
      px.url,
      base({
        messages: [
          { role: "system", content: systemPrompt() },
          USER,
          { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"**/*.py"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "/work/repo/app/__main__.py" },
          { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/app/__main__.py"}' } }] },
          { role: "tool", tool_call_id: "call_2", content: "1: print('BANANA-42')" },
        ],
      }),
    );
    assert.equal(sseText(r.events), "The entry point is `app/__main__.py`; it prints BANANA-42.");
    assert.equal(sseFinish(r.events), "stop");
    const hist = up.requests[0].messages.slice(1);
    assert.deepEqual(hist.map((m: any) => m.role), ["user", "assistant", "tool", "assistant", "tool"]);
    assert.equal(hist[4].tool_call_id, "call_2");
    const ev = px.events().filter((e) => e.type === "tool_result");
    // Each request logs the results that are new since the model's last step.
    assert.deepEqual(ev.map((e) => [e.tool_call_id, e.name]), [["call_2", "read"]]);
  });

  test("invalid JSON arguments are repaired by re-prompting with the exact error", async () => {
    up.requests.length = 0;
    up.push(harmonyCall("glob", '{"pattern":"*.py","}'), harmonyCall("glob", { pattern: "**/*.py" }));
    const r = await chat(px.url, base());
    const calls = sseToolCalls(r.events);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { pattern: "**/*.py" });
    const retry = up.requests[1].messages.slice(-2);
    assert.equal(retry[0].role, "assistant");
    assert.equal(retry[1].role, "tool");
    assert.match(retry[1].content, /not valid JSON/);
    assert.ok(px.events().some((e) => e.type === "validation_failure" && e.code === "bad_json"));
  });

  test("an invented tool is rejected and the model is told which tools exist", async () => {
    up.requests.length = 0;
    up.push(harmonyCall("python", { code: "print(1)" }), harmonyCall("bash", { command: "python -c 'print(1)'" }));
    const r = await chat(px.url, base());
    assert.equal(sseToolCalls(r.events)[0].function.name, "bash");
    assert.match(up.requests[1].messages.at(-1).content, /Unknown tool "python"\. Only these tools exist: bash, edit/);
  });

  test("bare JSON reply after a rejected call is used as that tool's arguments", async () => {
    up.push(harmonyCall("read", '{"path_to_file": "/a"}'), harmonyFinal('{"filePath": "/work/repo/a.py"}', "fix it"));
    const r = await chat(px.url, base());
    const c = sseToolCalls(r.events)[0];
    assert.equal(c.function.name, "read");
    assert.deepEqual(JSON.parse(c.function.arguments), { filePath: "/work/repo/a.py" });
  });

  test("repair attempts are bounded and end with an actionable diagnostic", async () => {
    up.requests.length = 0;
    up.push(harmonyCall("glob", "{bad"), harmonyCall("glob", "{bad"), harmonyCall("glob", "{bad"));
    const r = await chat(px.url, base());
    assert.equal(up.requests.length, 3, "1 attempt + 2 repairs");
    assert.match(sseText(r.events), /^\[gpt-oss-proxy\] The model produced an invalid tool call 3 times/);
    assert.equal(sseToolCalls(r.events).length, 0);
    assert.equal(sseFinish(r.events), "stop");
    up.requests.length = 0;
  });

  test("a redundant re-read is answered by the proxy with a hint instead of being executed", async () => {
    up.requests.length = 0;
    const history = [
      { role: "system", content: systemPrompt() },
      USER,
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/a.py"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "1: x = 1" },
    ];
    up.push(harmonyCall("read", { filePath: "/work/repo/a.py" }), harmonyFinal("a.py sets x to 1."));
    const r = await chat(px.url, base({ messages: history }));
    assert.equal(sseText(r.events), "a.py sets x to 1.");
    assert.match(up.requests[1].messages.at(-1).content, /\[not executed by the proxy\] This call is identical/);
    assert.ok(px.events().some((e) => e.type === "redundant_call" && e.action === "hint"));
  });

  test("turn is stopped after repeated identical calls were executed (loop)", async () => {
    up.requests.length = 0;
    const msgs: any[] = [{ role: "system", content: systemPrompt() }, USER];
    for (let i = 0; i < 4; i++) {
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `r${i}`, type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }] });
      msgs.push({ role: "tool", tool_call_id: `r${i}`, content: "a.py" });
    }
    const r = await chat(px.url, base({ messages: msgs }));
    assert.equal(up.requests.length, 0, "no model call is spent");
    assert.match(sseText(r.events), /repeated identical tool calls 3 times/);
  });

  test("step budget stops runaway turns", async () => {
    const small = await startProxy(up.url, {}, { maxStepsPerTurn: 2 });
    try {
      const msgs: any[] = [{ role: "system", content: systemPrompt() }, USER];
      for (let i = 0; i < 2; i++) {
        msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `s${i}`, type: "function", function: { name: "read", arguments: `{"filePath":"/f${i}"}` } }] });
        msgs.push({ role: "tool", tool_call_id: `s${i}`, content: "x" });
      }
      const r = await chat(small.url, base({ messages: msgs }));
      assert.match(sseText(r.events), /Stopped after 2 tool steps/);
    } finally {
      await small.close();
    }
  });

  test("empty model output gets one nudge, then succeeds", async () => {
    up.requests.length = 0;
    up.push({ kind: "json", content: "", reasoning: "hmm" }, harmonyCall("glob", { pattern: "*" }));
    const r = await chat(px.url, base());
    assert.equal(sseToolCalls(r.events)[0].function.name, "glob");
    assert.match(up.requests[1].messages.at(-1).content, /neither a function call nor an answer/);
  });

  test("provider hangs: bounded retries then a diagnostic (no unbounded waiting)", async () => {
    const quick = await startProxy(up.url, {}, { firstByteTimeoutMs: 200, requestTimeoutMs: 600, transportRetries: 1 });
    try {
      up.requests.length = 0;
      up.push({ kind: "hang" }, { kind: "hang" });
      const t0 = Date.now();
      const r = await chat(quick.url, base());
      assert.ok(Date.now() - t0 < 5000);
      assert.equal(up.requests.length, 2);
      assert.match(sseText(r.events), /failed after 2 attempt\(s\): total timeout/);
    } finally {
      await quick.close();
    }
  });

  test("malformed provider body is retried transparently", async () => {
    up.push({ kind: "raw", contentType: "application/json", body: "<html>bad gateway</html>" }, harmonyCall("glob", { pattern: "*" }));
    const r = await chat(px.url, base());
    assert.equal(sseToolCalls(r.events)[0].function.name, "glob");
  });

  test("non-streaming clients get a chat.completion with tool_calls", async () => {
    up.push(harmonyCall("read", { filePath: "/work/repo/x.py" }));
    const r = await chat(px.url, base({ stream: false }));
    assert.equal(r.json.choices[0].finish_reason, "tool_calls");
    assert.equal(r.json.choices[0].message.tool_calls[0].function.name, "read");
    assert.equal(r.json.usage.total_tokens, 110);
  });

  test("requests without tools (title generation) return clean text", async () => {
    up.push({ kind: "json", content: "Explain entry point<|end|>", reasoning: "short title" });
    const r = await chat(px.url, { model: "mock", stream: true, messages: [{ role: "system", content: "Generate a title" }, { role: "user", content: "x" }] });
    assert.equal(sseText(r.events), "Explain entry point");
  });

  test("generateText round trip with reasoning and usage (AI SDK non-streaming path)", async () => {
    up.push(harmonyFinal("Done: 2 files.", "check"));
    const provider = createOpenAICompatible({ name: "gpt-oss", baseURL: px.url });
    const r = await generateText({ model: provider.chatModel("mock"), prompt: "hi", tools: { glob: tool({ inputSchema: jsonSchema({ type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }) }) } });
    assert.equal(r.text, "Done: 2 files.");
    assert.equal(r.reasoningText, "check");
  });

  test("logs are keyed by OpenCode's session id and never contain the API key", async () => {
    const ev = px.events();
    assert.ok(ev.length > 0);
    assert.ok(ev.some((e) => e.session === "ses_test"));
    assert.ok(ev.every((e) => e.session === "ses_test" || e.session === "no-session"));
    const all = JSON.stringify(ev);
    assert.ok(!all.includes("sk-test-secret-key-1234567890abcdef"));
    assert.ok(ev.some((e) => e.type === "tool_catalog"));
  });
});

describe("OpenWebUI-style provider (native tools via /api, streaming)", () => {
  let up: MockUpstream;
  let px: TestProxy;
  before(async () => {
    up = await startMockUpstream("/api");
    px = await startProxy(up.url, { strategy: "auto", stream: true, model: "gpt-oss20b-opencode" });
  });
  after(async () => {
    await px.close();
    await up.close();
  });

  test("native tool calls are forwarded, validated and repaired (OpenWebUI/Ollama chunk style)", async () => {
    up.requests.length = 0;
    up.push({
      kind: "sse",
      chunks: [
        chunk({ role: "assistant", content: "" }),
        chunk({ reasoning_content: "Look for main." }),
        chunk({ tool_calls: [{ id: "x1", function: { name: "Glob", arguments: { pattern: "**/*.py", path: null } } }] }),
        chunk({}, "tool_calls", { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }),
      ],
    });
    const r = await chat(px.url, base());
    assert.equal(up.paths[0], "/api/chat/completions");
    assert.equal(up.requests[0].model, "gpt-oss20b-opencode");
    assert.equal(up.requests[0].tools.length, OPENCODE_TOOLS.length, "native strategy forwards OpenCode's tools");
    const c = sseToolCalls(r.events)[0];
    assert.equal(c.function.name, "glob");
    assert.deepEqual(JSON.parse(c.function.arguments), { pattern: "**/*.py" });
    assert.ok(r.events.some((e) => e.choices?.[0]?.delta?.reasoning_content === "Look for main."), "reasoning streamed live");
  });

  test("parallel native calls are validated individually and forwarded together", async () => {
    up.push({
      kind: "sse",
      chunks: [
        chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/a.py"}' } }] }),
        chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/b.py"}' } }] }),
        chunk({}, "tool_calls"),
      ],
    });
    const r = await chat(px.url, base());
    const calls = sseToolCalls(r.events);
    assert.deepEqual(calls.map((c: any) => [c.index, JSON.parse(c.function.arguments).filePath]), [[0, "/work/repo/a.py"], [1, "/work/repo/b.py"]]);
    assert.notEqual(calls[0].id, calls[1].id);
  });

  test("native: an invalid call is repaired with native tool messages (history keeps multi-call turns intact)", async () => {
    up.requests.length = 0;
    up.push(
      { kind: "sse", chunks: [chunk({ tool_calls: [{ index: 0, id: "x", type: "function", function: { name: "edit", arguments: '{"filePath":"/work/repo/a.py"}' } }] }), chunk({}, "tool_calls")] },
      { kind: "sse", chunks: [chunk({ tool_calls: [{ index: 0, id: "y", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/a.py"}' } }] }), chunk({}, "tool_calls")] },
    );
    const history = [
      { role: "system", content: systemPrompt() },
      USER,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "p1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.py"}' } },
          { id: "p2", type: "function", function: { name: "glob", arguments: '{"pattern":"*.md"}' } },
        ],
      },
      { role: "tool", tool_call_id: "p1", content: "a.py" },
      { role: "tool", tool_call_id: "p2", content: "README.md" },
    ];
    const r = await chat(px.url, base({ messages: history }));
    assert.equal(sseToolCalls(r.events)[0].function.name, "read");
    const sent = up.requests[1].messages;
    assert.equal(sent[2].tool_calls.length, 2, "native history is forwarded as OpenCode sent it");
    assert.equal(sent.at(-2).role, "assistant");
    assert.equal(sent.at(-1).role, "tool");
    assert.match(sent.at(-1).content, /oldString is required/);
  });

  test("OpenWebUI-style errors ({detail}) become actionable diagnostics", async () => {
    up.push({ kind: "status", status: 401, body: '{"detail":"401 Unauthorized: invalid API key"}' });
    const r = await chat(px.url, base());
    assert.match(sseText(r.events), /authentication failed \(401\): 401 Unauthorized: invalid API key.*Check the API key environment variable/);
  });

  test("reasoning delivered as inline <think> tags is separated from the answer", async () => {
    up.push({ kind: "sse", chunks: [chunk({ content: "<think>The user wants a sum." }), chunk({ content: "</think>The answer is 4." }), chunk({}, "stop")] });
    const r = await chat(px.url, base());
    assert.equal(sseText(r.events), "The answer is 4.");
    assert.ok(r.events.some((e) => /The user wants a sum/.test(e.choices?.[0]?.delta?.reasoning_content ?? "")));
  });

  test("leaked raw harmony in content is recovered as a tool call", async () => {
    up.push({ kind: "sse", chunks: [chunk({ content: 'plan<|end|><|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"/work/repo/a.py"}' }), chunk({}, "stop")] });
    const r = await chat(px.url, base());
    assert.equal(sseToolCalls(r.events)[0].function.name, "read");
  });

  test("auto: 'tools not supported' falls back to harmony emulation and remembers it", async () => {
    const px2 = await startProxy(up.url, { name: "mock", strategy: "auto", stream: true });
    try {
      up.requests.length = 0;
      up.push(
        { kind: "status", status: 400, body: '{"code":20037,"message":"Function call is not supported for this model.","data":null}' },
        { kind: "sse", chunks: [chunk({ content: 'x<|end|><|start|>assistant<|channel|>commentary to=functions.glob <|constrain|>json<|message|>{"pattern":"*"}' }), chunk({}, "stop")] },
      );
      const r = await chat(px2.url, base());
      assert.equal(sseToolCalls(r.events)[0].function.name, "glob");
      assert.ok(up.requests[0].tools);
      assert.equal(up.requests[1].tools, undefined);
      assert.deepEqual(up.requests[1].stop, ["<|call|>"]);
      assert.ok(px2.events().some((e) => e.type === "strategy_fallback"));
      up.push({ kind: "sse", chunks: [chunk({ content: "All good." }), chunk({}, "stop")] });
      await chat(px2.url, base());
      assert.equal(up.requests[2].tools, undefined, "fallback is cached for later requests");
    } finally {
      await px2.close();
    }
  });
});

describe("json strategy (comparison baseline)", () => {
  test("envelope replies become tool calls; protocol violations are corrected", async () => {
    const up = await startMockUpstream();
    const px = await startProxy(up.url, { strategy: "json" });
    try {
      up.push({ kind: "json", content: "I will look for files." }, { kind: "json", content: '{"tool_calls":[{"name":"glob","arguments":{"pattern":"**/*.py"}}]}' });
      const r = await chat(px.url, base());
      assert.equal(sseToolCalls(r.events)[0].function.name, "glob");
      assert.match(up.requests[1].messages.at(-1).content, /not a single JSON object/);
      assert.match(up.requests[0].messages[0].content, /# Response protocol \(strict\)/);
      up.push({ kind: "json", content: '```json\n{"final":"Done."}\n```' });
      const f = await chat(
        px.url,
        base({
          messages: [
            { role: "system", content: systemPrompt() },
            USER,
            { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }] },
            { role: "tool", tool_call_id: "c", content: "a.py" },
          ],
        }),
      );
      assert.equal(sseText(f.events), "Done.");
      const hist = up.requests.at(-1).messages;
      assert.match(hist.at(-1).content, /^<tool_result name="glob">/);
    } finally {
      await px.close();
      await up.close();
    }
  });
});

describe("context guard", () => {
  test("oversized history is trimmed before it reaches the provider, and logged", async () => {
    const up = await startMockUpstream();
    const px = await startProxy(up.url, { contextWindow: 16_000, maxOutputTokens: 2000 });
    try {
      const huge = "line of log output\n".repeat(6000);
      const msgs: any[] = [{ role: "system", content: systemPrompt() }, USER];
      for (let i = 0; i < 3; i++) {
        msgs.push({ role: "assistant", content: null, tool_calls: [{ id: `h${i}`, type: "function", function: { name: "read", arguments: `{"filePath":"/f${i}"}` } }] });
        msgs.push({ role: "tool", tool_call_id: `h${i}`, content: huge });
      }
      up.push(harmonyFinal("summary"));
      const r = await chat(px.url, base({ messages: msgs }));
      assert.equal(sseText(r.events), "summary");
      const sent = JSON.stringify(up.requests[0].messages);
      assert.ok(sent.length < 16_000 * 3.2, `sent ${sent.length} chars`);
      assert.ok(px.events().some((e) => e.type === "context_trimmed"));
    } finally {
      await px.close();
      await up.close();
    }
  });

  test("a pasted document larger than the window is cut to both ends (not forwarded whole), and the user is told once", async () => {
    // Real session: ~3.5M chars of JSON pasted with "write a Python converter to HTML" went to an
    // Ollama with num_ctx 32768, which kept only the tail: no tools, no instruction, wrong task.
    const up = await startMockUpstream();
    const px = await startProxy(up.url, { contextWindow: 32_768, maxOutputTokens: 8192 });
    try {
      const paste = `Write a Python converter from this JSON to HTML.\n${JSON.stringify({ issues: Array.from({ length: 12_000 }, (_, i) => ({ key: `DICHMI-${i}`, summary: "s".repeat(250) })) })}\nOne section per issue.`;
      const first = [{ role: "system", content: systemPrompt() }, { role: "user", content: [{ type: "text", text: paste }] }];
      up.push(harmonyFinal("Here is the converter."));
      const r1 = await chat(px.url, base({ messages: first }));
      assert.equal(sseText(r1.events), "Here is the converter.");
      const sent = JSON.stringify(up.requests[0].messages);
      assert.ok(sent.length < 32_768 * 3.2, `sent ${sent.length} chars`);
      assert.match(sent, /Write a Python converter from this JSON to HTML\./);
      assert.match(sent, /One section per issue\./);
      const reasoning = (events: any[]) => events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "").join("");
      assert.match(reasoning(r1.events), /your message is about \d+ tokens, more than fits in the model's context window \(32768 tokens\).*save it to a file/);
      const trimmed = px.events().find((e) => e.type === "context_trimmed");
      assert.deepEqual(trimmed.cuts.map((c: any) => [c.role, c.chars]), [["user", paste.length]]);

      // Next turn: the paste is still in OpenCode's history; still cut, but no repeated notice.
      up.push(harmonyFinal("Done."));
      const r2 = await chat(px.url, base({ messages: [...first, { role: "assistant", content: "Here is the converter." }, { role: "user", content: "Add a table of contents." }] }));
      assert.ok(JSON.stringify(up.requests[1].messages).length < 32_768 * 3.2);
      assert.match(JSON.stringify(up.requests[1].messages), /Add a table of contents\./);
      assert.doesNotMatch(reasoning(r2.events), /your message is about/);
    } finally {
      await px.close();
      await up.close();
    }
  });
});
