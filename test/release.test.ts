// Release safety: bind/auth policy, privacy of the diagnostic logs, log retention.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindRefusal, isLoopback } from "../src/server.ts";
import { logArgs, logText, pruneLogs } from "../src/log.ts";
import { loadConfig } from "../src/config.ts";
import { startMockUpstream, harmonyCall, type MockUpstream } from "./helpers/mock-upstream.ts";
import { startProxy, chat, systemPrompt, OPENCODE_TOOLS, type TestProxy } from "./helpers/proxy.ts";

test("non-loopback binds require a client token", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) assert.ok(isLoopback(h), h);
  for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) assert.ok(!isLoopback(h), h);
  assert.equal(bindRefusal("127.0.0.1", undefined), undefined);
  assert.match(bindRefusal("0.0.0.0", undefined) ?? "", /GPT_OSS_PROXY_TOKEN/);
  assert.equal(bindRefusal("0.0.0.0", "s3cret"), undefined);
});

test("log helpers keep locations and commands, not content", () => {
  const args = JSON.stringify({ filePath: "/w/src/a.js", content: "SECRET BODY", oldString: "x", replaceAll: true, limit: 5 });
  const scrubbed = JSON.parse(logArgs(args, false, 800));
  assert.deepEqual(scrubbed, { filePath: "/w/src/a.js", content: "[11 chars]", oldString: "[1 chars]", replaceAll: true, limit: 5 });
  assert.equal(logArgs(args, true, 800), args);
  assert.equal(JSON.parse(logArgs('{"command":"npm test"}', false, 800)).command, "npm test");
  assert.equal(logArgs("{not json", false, 800), "[9 chars]");
  assert.equal(logText("the user's prompt", false, 300), "[17 chars]");
  assert.equal(logText("the user's prompt", true, 300), "the user's prompt");
});

test("log retention deletes only old day folders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-prune-"));
  for (const d of ["2026-09-01", "2026-09-20", "2026-09-29", "keep-me"]) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, "2026-09-01", "s.jsonl"), "{}\n");
  const removed = pruneLogs(dir, 14, Date.parse("2026-09-29T12:00:00Z"));
  assert.deepEqual(removed, ["2026-09-01"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-09-20", "2026-09-29", "keep-me"]);
  assert.deepEqual(pruneLogs(dir, 0), []);
});

test("config: content logging is off by default; env, file and the old key switch it on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-cfg-"));
  const d = loadConfig({}, dir);
  assert.equal(d.logContent, false);
  assert.equal(d.logRetentionDays, 14);
  assert.equal(loadConfig({ GPT_OSS_LOG_CONTENT: "1", GPT_OSS_LOG_RETENTION_DAYS: "0" }, dir).logContent, true);
  const file = path.join(dir, "old.json");
  fs.writeFileSync(file, JSON.stringify({ logModelOutput: true }));
  assert.equal(loadConfig({ GPT_OSS_CONFIG: file }, dir).logContent, true);
  assert.throws(() => loadConfig({ GPT_OSS_LOG_RETENTION_DAYS: "-1" }, dir), /logRetentionDays/);
});

describe("proxy with default logging", () => {
  let up: MockUpstream;
  let px: TestProxy;
  before(async () => {
    up = await startMockUpstream();
    px = await startProxy(up.url);
    px.cfg.logContent = false;
  });
  after(async () => {
    await px.close();
    await up.close();
  });

  test("no prompt, file content or model output in the logs; paths and errors remain", async () => {
    up.push(harmonyCall("write", { filePath: "/work/repo/src/new.js", content: "export const KEY_MATERIAL = 1;" }, "Write CONFIDENTIAL_PLAN now."));
    const r = await chat(px.url, {
      model: "mock",
      stream: true,
      tools: OPENCODE_TOOLS,
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: "Add PRIVATE_FEATURE to the project." },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/src/a.js"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "1: const FILE_BODY_MARKER = 42;" },
        { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/src/missing.js"}' } }] },
        { role: "tool", tool_call_id: "c2", content: "Error: File not found: /work/repo/src/missing.js" },
      ],
    });
    assert.equal(r.status, 200);
    const text = fs
      .readdirSync(px.logDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => fs.readFileSync(path.join(px.logDir, f), "utf8"))
      .join("\n");
    for (const secret of ["PRIVATE_FEATURE", "FILE_BODY_MARKER", "KEY_MATERIAL", "CONFIDENTIAL_PLAN"]) assert.ok(!text.includes(secret), `${secret} leaked into the log`);
    assert.ok(text.includes("/work/repo/src/new.js"), "tool-call paths are kept");
    assert.ok(text.includes("File not found"), "error results are kept for diagnosis");
  });
});

describe("proxy with a client token", () => {
  let up: MockUpstream;
  let px: TestProxy;
  before(async () => {
    up = await startMockUpstream();
    process.env.GPT_OSS_PROXY_TOKEN = "tok-123";
    px = await startProxy(up.url);
    delete process.env.GPT_OSS_PROXY_TOKEN;
  });
  after(async () => {
    await px.close();
    await up.close();
  });

  test("requests without the token are rejected; /health stays open", async () => {
    const body = { model: "mock", stream: false, messages: [{ role: "user", content: "hi" }] };
    assert.equal((await chat(px.url, body)).status, 401);
    assert.equal((await chat(px.url, body, { authorization: "Bearer wrong" })).status, 401);
    up.push({ kind: "json", content: "hello" });
    assert.equal((await chat(px.url, body, { authorization: "Bearer tok-123" })).status, 200);
    assert.equal((await fetch(px.url.replace(/\/v1$/, "/health"))).status, 200);
  });
});
