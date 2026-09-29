import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamAccumulator, callModel, classifyHttpError, parseNonStream, UpstreamError, splitThinkTags } from "../src/upstream.ts";
import { DEFAULT_LIMITS, DEFAULT_PROFILES, type Profile } from "../src/config.ts";
import { startMockUpstream, chunk } from "./helpers/mock-upstream.ts";

const feed = (acc: StreamAccumulator, lines: string[]) => lines.forEach((l) => acc.line(l));

test("SSE: content, reasoning, indexed tool-call deltas, usage", () => {
  const acc = new StreamAccumulator();
  feed(acc, [
    `data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: "think " }))}`,
    "",
    `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "read", arguments: '{"file' } }] }))}`,
    `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: 'Path":"/x"}' } }] }))}`,
    `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "glob", arguments: '{"pattern":"*"}' } }] }))}`,
    `data: ${JSON.stringify(chunk({}, "tool_calls", { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }))}`,
    "data: [DONE]",
  ]);
  const r = acc.result();
  assert.equal(r.reasoning, "think ");
  assert.deepEqual(r.toolCalls, [
    { id: "a", name: "read", arguments: '{"filePath":"/x"}' },
    { id: "b", name: "glob", arguments: '{"pattern":"*"}' },
  ]);
  assert.equal(r.finishReason, "tool_calls");
  assert.equal(r.usage?.total_tokens, 8);
  assert.ok(acc.done);
});

test("SSE: gateway quirks (no index, object arguments, CRLF, comments, multi-line data, reasoning field)", () => {
  const acc = new StreamAccumulator();
  feed(acc, [
    ": keepalive",
    `data: ${JSON.stringify(chunk({ reasoning: "r" }))}\r`,
    `data: ${JSON.stringify(chunk({ tool_calls: [{ id: "x", function: { name: "bash", arguments: { command: "ls -la" } } }] }))}`,
    `data: ${JSON.stringify(chunk({ tool_calls: [{ id: "y", function: { name: "read", arguments: { filePath: "/a" } } }] }))}`,
    'data: {"id":"m","choices":[{"index":0,',
    'data: "delta":{"content":"hi"},"finish_reason":"stop"}]}',
    "",
  ]);
  const r = acc.result();
  assert.equal(r.reasoning, "r");
  assert.equal(r.content, "hi");
  assert.deepEqual(r.toolCalls.map((t) => [t.name, JSON.parse(t.arguments)]), [
    ["bash", { command: "ls -la" }],
    ["read", { filePath: "/a" }],
  ]);
});

test("SSE: error event inside the stream raises a retryable provider error", () => {
  const acc = new StreamAccumulator();
  assert.throws(() => acc.line('data: {"error":{"message":"overloaded"}}'), (e: any) => e instanceof UpstreamError && e.kind === "provider_error" && e.retryable);
});

test("inline <think> tags are moved to reasoning", () => {
  assert.deepEqual(splitThinkTags("<think>plan</think>Answer"), { content: "Answer", reasoning: "plan" });
  const acc = new StreamAccumulator();
  feed(acc, [`data: ${JSON.stringify(chunk({ content: "<think>a" }))}`, `data: ${JSON.stringify(chunk({ content: "b</think>Final" }))}`]);
  assert.equal(acc.result().reasoning, "ab");
  assert.equal(acc.result().content, "Final");
});

test("HTTP error classification", () => {
  assert.equal(classifyHttpError(400, '{"code":20037,"message":"Function call is not supported for this model.","data":null}').kind, "tools_unsupported");
  assert.equal(classifyHttpError(400, '{"error":{"message":"This model\'s maximum context length is 131072 tokens"}}').kind, "context_length");
  const rl = classifyHttpError(429, "{}", "3");
  assert.equal(rl.kind, "rate_limit");
  assert.equal(rl.retryAfterMs, 3000);
  assert.ok(classifyHttpError(503, "busy").retryable);
  assert.equal(classifyHttpError(401, "bad key").retryable, false);
});

test("non-stream parsing: malformed bodies are retryable errors", () => {
  assert.throws(() => parseNonStream("<html>502</html>"), (e: any) => e.kind === "malformed" && e.retryable);
  assert.throws(() => parseNonStream('{"choices":[]}'), (e: any) => e.kind === "malformed");
});

function profile(url: string, stream = false): Profile {
  return { ...DEFAULT_PROFILES.siliconflow, baseURL: url, apiKeyEnv: undefined, stream };
}

test("first-byte timeout (streaming) is retried, then succeeds; attempts are reported", async () => {
  const up = await startMockUpstream();
  try {
    up.push({ kind: "hang" }, { kind: "sse", chunks: [chunk({ content: "ok" }), chunk({}, "stop")] });
    const attempts: any[] = [];
    const r = await callModel({
      profile: profile(up.url, true),
      limits: { ...DEFAULT_LIMITS, firstByteTimeoutMs: 300, transportRetries: 2 },
      body: { messages: [] },
      onAttempt: (a) => attempts.push(a),
    });
    assert.equal(r.content, "ok");
    assert.equal(r.attempts, 2);
    assert.equal(attempts[0].kind, "timeout");
    assert.equal(attempts[0].willRetry, true);
  } finally {
    await up.close();
  }
});

test("non-streaming: a slow generation is not cut by the first-byte limit, only by the total limit", async () => {
  const up = await startMockUpstream();
  try {
    up.push({ kind: "json", content: "long output", delayMs: 600 }, { kind: "hang" });
    const limits = { ...DEFAULT_LIMITS, firstByteTimeoutMs: 200, requestTimeoutMs: 1500, transportRetries: 0 };
    const r = await callModel({ profile: profile(up.url, false), limits, body: { messages: [] } });
    assert.equal(r.content, "long output");
    await assert.rejects(callModel({ profile: profile(up.url, false), limits, body: { messages: [] } }), (e: any) => e.kind === "timeout" && /total/.test(e.message));
  } finally {
    await up.close();
  }
});

test("idle timeout mid-stream is detected", async () => {
  const up = await startMockUpstream();
  try {
    up.push({ kind: "sse", chunks: [chunk({ content: "partial" })], hangAfter: true });
    await assert.rejects(
      callModel({ profile: profile(up.url, true), limits: { ...DEFAULT_LIMITS, idleTimeoutMs: 300, transportRetries: 0 }, body: { messages: [] } }),
      (e: any) => e.kind === "timeout" && /idle/.test(e.message),
    );
  } finally {
    await up.close();
  }
});

test("5xx is retried with backoff; auth errors are not retried", async () => {
  const up = await startMockUpstream();
  try {
    up.push({ kind: "status", status: 503, body: '{"error":{"message":"busy"}}' }, { kind: "json", content: "fine" });
    const r = await callModel({ profile: profile(up.url), limits: { ...DEFAULT_LIMITS, transportRetries: 1 }, body: { messages: [] } });
    assert.equal(r.content, "fine");
    up.push({ kind: "status", status: 401, body: '{"error":{"message":"invalid key"}}' });
    await assert.rejects(callModel({ profile: profile(up.url), limits: DEFAULT_LIMITS, body: { messages: [] } }), (e: any) => e.kind === "auth" && e.attempts === 1);
  } finally {
    await up.close();
  }
});

test("retries stop at the configured bound", async () => {
  const up = await startMockUpstream();
  try {
    for (let i = 0; i < 5; i++) up.push({ kind: "status", status: 500, body: "oops" });
    await assert.rejects(
      callModel({ profile: profile(up.url), limits: { ...DEFAULT_LIMITS, transportRetries: 2 }, body: { messages: [] } }),
      (e: any) => e.kind === "server" && e.attempts === 3,
    );
    assert.equal(up.requests.length, 3);
  } finally {
    await up.close();
  }
});

test("rate limiting (429 TPM) has its own retry budget with backoff, independent of transport retries", async () => {
  const up = await startMockUpstream();
  try {
    const tpm = '{"code":50603,"message":"Request was rejected due to rate limiting. Details: TPM limit reached."}';
    up.push({ kind: "status", status: 429, body: tpm }, { kind: "status", status: 429, body: tpm }, { kind: "json", content: "after backoff" });
    const attempts: any[] = [];
    const t0 = Date.now();
    const r = await callModel({
      profile: profile(up.url),
      limits: { ...DEFAULT_LIMITS, transportRetries: 0, rateLimitRetries: 3, rateLimitBackoffMs: 100 },
      body: { messages: [] },
      onAttempt: (a) => attempts.push(a),
    });
    assert.equal(r.content, "after backoff");
    assert.deepEqual(attempts.map((a) => a.kind ?? "ok"), ["rate_limit", "rate_limit", "ok"]);
    assert.ok(Date.now() - t0 >= 300, "backoff doubles: 100ms then 200ms");
  } finally {
    await up.close();
  }
});

test("Retry-After as an HTTP date is honoured (capped)", () => {
  const e = classifyHttpError(429, "{}", new Date(Date.now() + 3000).toUTCString());
  assert.ok(e.retryAfterMs! > 1000 && e.retryAfterMs! <= 3000);
  assert.equal(classifyHttpError(429, "{}", "garbage").retryAfterMs, undefined);
});

test("the API key is sent as a bearer token and model id comes from the profile", async () => {
  const up = await startMockUpstream();
  process.env.UPSTREAM_TEST_KEY_X = "sk-abc";
  try {
    up.push({ kind: "json", content: "ok" });
    await callModel({ profile: { ...profile(up.url), apiKeyEnv: "UPSTREAM_TEST_KEY_X", model: "openai/gpt-oss-20b" }, limits: DEFAULT_LIMITS, body: { model: "ignored", messages: [] } });
    assert.equal(up.headers[0].authorization, "Bearer sk-abc");
    assert.equal(up.requests[0].model, "openai/gpt-oss-20b");
    assert.equal(up.requests[0].stream, false);
  } finally {
    await up.close();
  }
});
