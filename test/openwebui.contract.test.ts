// OpenWebUI contract tests. Fixtures under test/fixtures/owui-*.sse are real SSE
// captured from OpenWebUI 0.11.4 + Ollama 0.34.4 (scripts/probe-openwebui.mjs);
// the other behaviours asserted here were verified live against that stack
// (see docs/VALIDATION_REPORT.md, "OpenWebUI + Ollama").

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { streamText, tool, jsonSchema } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { startMockUpstream, chunk, type MockUpstream } from "./helpers/mock-upstream.ts";
import { startProxy, chat, systemPrompt, OPENCODE_TOOLS, type TestProxy } from "./helpers/proxy.ts";
import { clearRouteCache } from "../src/openwebui.ts";
import { clearProvenPrompts } from "../src/agent.ts";

const API_SSE = fs.readFileSync(new URL("./fixtures/owui-api-stream-toolcall.sse", import.meta.url), "utf8");
const OLLAMA_V1_SSE = fs.readFileSync(new URL("./fixtures/owui-ollamav1-stream-toolcall.sse", import.meta.url), "utf8");
const USER = { role: "user", content: "Find the Python files in the repository." };
const base = (extra: object = {}) => ({ model: "openwebui", stream: true, stream_options: { include_usage: true }, tools: OPENCODE_TOOLS, messages: [{ role: "system", content: systemPrompt() }, USER], ...extra });
const calls = (events: any[]) => events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
const text = (events: any[]) => events.map((e) => e.choices?.[0]?.delta?.content ?? "").join("");
const MODEL = "gpt-oss20b-opencode";

describe("OpenWebUI profile", () => {
  let up: MockUpstream;
  before(async () => {
    up = await startMockUpstream("/api");
  });
  after(async () => up.close());
  beforeEach(() => {
    clearRouteCache();
    clearProvenPrompts();
    up.requests.length = 0;
    up.paths.length = 0;
  });
  const proxy = (p: object = {}, l: object = {}) => startProxy(up.url, { name: "openwebui", kind: "openwebui", strategy: "auto", stream: true, model: MODEL, ...p }, l);

  test("auto route: a model on an Ollama connection is called via /ollama/v1 (tool names preserved upstream)", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push({ kind: "raw", contentType: "text/event-stream", body: OLLAMA_V1_SSE });
    const px = await proxy();
    try {
      const r = await chat(px.url, base({ max_tokens: 32000 }));
      assert.deepEqual(up.paths, ["/api/models", "/ollama/v1/chat/completions"]);
      assert.equal(up.requests[0].max_tokens, 8192, "max_tokens is honoured on this route");
      assert.equal(up.requests[0].options, undefined);
      assert.equal(calls(r.events)[0].function.name, "glob");
      assert.ok(r.events.some((e) => e.choices?.[0]?.delta?.reasoning_content === "Okay"), "Ollama `reasoning` relayed as reasoning_content");
      assert.equal(px.events().find((e) => e.type === "route")?.route, "ollama-v1");
    } finally {
      await px.close();
    }
  });

  test("auto route with numCtx: /api/chat/completions even for an Ollama model, the only route that carries num_ctx", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push({ kind: "raw", contentType: "text/event-stream", body: API_SSE });
    const px = await proxy({ numCtx: 65536 });
    try {
      await chat(px.url, base());
      assert.deepEqual(up.paths, ["/api/models", "/api/chat/completions"]);
      assert.equal(up.requests[0].options.num_ctx, 65536);
      const route = px.events().find((e) => e.type === "route");
      assert.equal(route?.route, "api");
      assert.match(route?.note ?? "", /numCtx 65536 is set/);
    } finally {
      await px.close();
    }
  });

  test("auto route: a model on an OpenAI-type connection uses /api/chat/completions", async () => {
    up.setModels([{ id: MODEL, owned_by: "openai" }]);
    up.push({ kind: "raw", contentType: "text/event-stream", body: OLLAMA_V1_SSE });
    const px = await proxy();
    try {
      await chat(px.url, base());
      assert.deepEqual(up.paths, ["/api/models", "/api/chat/completions"]);
    } finally {
      await px.close();
    }
  });

  test("route api: real OpenWebUI converter stream parses; max_tokens moved to options.num_predict, num_ctx sent, tool results labelled", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push({ kind: "raw", contentType: "text/event-stream", body: API_SSE });
    const px = await proxy({ openwebuiRoute: "api", numCtx: 32768 });
    try {
      const r = await chat(
        px.url,
        base({
          messages: [
            { role: "system", content: systemPrompt() },
            USER,
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"*.md"}' } }] },
            { role: "tool", tool_call_id: "c1", content: "README.md" },
          ],
        }),
      );
      assert.deepEqual(up.paths, ["/api/chat/completions"], "explicit route: no detection request");
      const sent = up.requests[0];
      assert.deepEqual(sent.options, { num_predict: 8192, num_ctx: 32768 });
      assert.equal(sent.messages.find((m: any) => m.role === "tool").content, "[glob result]\nREADME.md");
      assert.ok(sent.messages.every((m: any) => m.role !== "assistant" || m.tool_calls || typeof m.content === "string"));
      const c = calls(r.events)[0];
      assert.equal(c.function.name, "glob");
      assert.deepEqual(JSON.parse(c.function.arguments), { pattern: "**/*.py" });
      const fin = r.events.find((e) => e.choices?.[0]?.finish_reason);
      assert.equal(fin.choices[0].finish_reason, "tool_calls");
    } finally {
      await px.close();
    }
  });

  test("the real captures are accepted by OpenCode's provider package end to end", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    const px = await proxy({ openwebuiRoute: "api" });
    try {
      for (const sse of [API_SSE, OLLAMA_V1_SSE]) {
        up.push({ kind: "raw", contentType: "text/event-stream", body: sse });
        const provider = createOpenAICompatible({ name: "gpt-oss", baseURL: px.url, includeUsage: true });
        const result = streamText({
          model: provider.chatModel("openwebui"),
          prompt: USER.content,
          tools: { glob: tool({ inputSchema: jsonSchema({ type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] }) }) },
        });
        const parts: any[] = [];
        for await (const p of result.fullStream) parts.push(p);
        const tc = parts.find((p) => p.type === "tool-call");
        assert.equal(tc.toolName, "glob");
        assert.equal(parts.find((p) => p.type === "finish-step").finishReason, "tool-calls");
      }
    } finally {
      await px.close();
    }
  });

  test("an Ollama error hidden by OpenWebUI (empty stop chunk, model 'ollama', no usage) is retried", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push(
      { kind: "sse", chunks: [chunk({ reasoning_content: "thinking" }, null, { model: "gpt-oss:20b" }), chunk({}, "stop", { model: "ollama" })] },
      { kind: "raw", contentType: "text/event-stream", body: API_SSE },
    );
    const px = await proxy({ openwebuiRoute: "api" }, { transportRetries: 1 });
    try {
      const r = await chat(px.url, base());
      assert.equal(calls(r.events)[0].function.name, "glob");
      const err = px.events().find((e) => e.type === "upstream_error");
      assert.match(err.error, /reported an error mid-stream/);
    } finally {
      await px.close();
    }
  });

  test("Ollama 'error parsing tool call' (400 detail) makes the model resend its call", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push(
      { kind: "status", status: 400, body: JSON.stringify({ detail: "error parsing tool call: raw='{\"pattern\":\"**/*.py\"', err=unexpected end of JSON input" }) },
      { kind: "raw", contentType: "text/event-stream", body: OLLAMA_V1_SSE },
    );
    const px = await proxy();
    try {
      const r = await chat(px.url, base());
      assert.equal(calls(r.events)[0].function.name, "glob");
      assert.match(up.requests[1].messages.at(-1).content, /could not be parsed .*error parsing tool call/s);
    } finally {
      await px.close();
    }
  });

  test("API keys disabled in OpenWebUI -> actionable diagnostic, no retries", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push({ kind: "status", status: 403, body: '{"detail":"Use of API key is not enabled in the environment."}' });
    const px = await proxy({ openwebuiRoute: "ollama-v1" });
    try {
      const r = await chat(px.url, base());
      assert.match(text(r.events), /Use of API key is not enabled.*enable API keys \(Admin Panel/);
      assert.equal(up.requests.length, 1);
    } finally {
      await px.close();
    }
  });

  test("unknown model -> hint to match the OpenWebUI model id; detail objects are read", async () => {
    up.setModels([{ id: "other", owned_by: "ollama" }]);
    up.push({ kind: "status", status: 400, body: '{"detail":{"message":"Model \'gpt-oss20b-opencode\' was not found","type":"invalid_request_error"}}' });
    const px = await proxy();
    try {
      const r = await chat(px.url, base());
      assert.match(text(r.events), /Model 'gpt-oss20b-opencode' was not found\..*must match an OpenWebUI model id exactly/);
      assert.equal(up.paths[1], "/api/chat/completions", "model not listed -> falls back to the /api route");
    } finally {
      await px.close();
    }
  });

  test("silent context truncation (prompt_tokens far below the prompt size) is detected and reported", async () => {
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    up.push({ kind: "sse", chunks: [chunk({ content: "I am not sure what you want." }), chunk({}, "stop", { usage: { prompt_tokens: 1026, completion_tokens: 12, total_tokens: 1038 } })] });
    const px = await proxy();
    try {
      const r = await chat(px.url, base());
      const warning = r.events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "").join("");
      assert.match(warning, /evaluated only 1026 of ~\d+ prompt tokens - its context window is smaller than the 131072 tokens profile "openwebui" assumes/);
      assert.match(warning, /raise num_ctx .* to at least 131072, or set OPENWEBUI_CONTEXT_WINDOW \(contextWindow\) to the server's real context length/);
      assert.ok(px.events().some((e) => e.type === "context_truncated" && e.promptTokensSeen === 1026));
    } finally {
      await px.close();
    }
  });

  test("no truncation warning for a prompt the same server already evaluated a larger one than (estimate off)", async () => {
    // Observed: "evaluated only 6706 of ~11400" right after the same server evaluated 26,094 tokens.
    up.setModels([{ id: MODEL, owned_by: "ollama" }]);
    const reply = (prompt: number) => ({ kind: "sse" as const, chunks: [chunk({ content: "ok" }), chunk({}, "stop", { usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 } })] });
    up.push(reply(26094), reply(1026));
    const px = await proxy();
    try {
      await chat(px.url, base());
      const r = await chat(px.url, base());
      assert.doesNotMatch(r.events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? "").join(""), /evaluated only/);
      assert.ok(!px.events().some((e) => e.type === "context_truncated"));
    } finally {
      await px.close();
    }
  });

  test("truncation advice does not ask for a context the server already has", async () => {
    const { truncationAdvice } = await import("../src/agent.ts");
    const p = { name: "openwebui", kind: "openwebui", contextWindow: 32768 } as any;
    // The reported case: num_ctx 32768 already, the request itself was ~1.08M tokens.
    assert.match(truncationAdvice(p, 32770), /the request is larger than the context window \(32768 tokens\)/);
    assert.doesNotMatch(truncationAdvice(p, 32770), /raise num_ctx/);
    assert.match(truncationAdvice(p, 4096), /raise num_ctx .* to at least 32768/);
    assert.match(truncationAdvice({ name: "custom", contextWindow: 65536 } as any, 8000), /raise the model server's context length to at least 65536, or set CUSTOM_CONTEXT_WINDOW/);
  });
});
