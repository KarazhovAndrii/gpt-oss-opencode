import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, timeline } from "../src/sessionreport.ts";

const ts = (s: number) => new Date(Date.UTC(2026, 8, 24, 10, 0, s)).toISOString();

test("session report flags abnormal behaviour and summarizes usage", () => {
  const ev = [
    { ts: ts(0), type: "request", session: "s", req: "r1", profile: "openwebui", model: "gpt-oss20b-opencode", strategy: "native", tools: ["read"], messages: 2, turnSteps: 0, objective: "fix the bug" },
    { ts: ts(0), type: "route", session: "s", req: "r1", route: "ollama-v1", ownedBy: "ollama" },
    { ts: ts(1), type: "model_output", session: "s", req: "r1", ms: 1000, usage: { prompt_tokens: 900, completion_tokens: 20 }, proposed: [{ name: "reed", args: "{}" }] },
    { ts: ts(1), type: "validation_failure", session: "s", req: "r1", code: "unknown_tool", tool: "reed", error: "Unknown tool" },
    { ts: ts(0), type: "context_trimmed", session: "s", req: "r1", trimmed: 1, estTokens: [1083858, 18000], window: 32768, cuts: [{ role: "user", chars: 3468000, kept: 57600 }] },
    { ts: ts(2), type: "context_truncated", session: "s", req: "r1", promptTokensSeen: 900, estimatedPromptTokens: 9000 },
    { ts: ts(2), type: "redundant_call", session: "s", req: "r1", tool: "read", key: "read:{}", action: "hint" },
    { ts: ts(3), type: "upstream_error", session: "s", req: "r1", kind: "rate_limit", willRetry: true },
    { ts: ts(4), type: "response", session: "s", req: "r1", calls: [{ id: "c1", name: "read", args: '{"filePath":"/a"}' }], modelCalls: 3, usage: { prompt_tokens: 2700, completion_tokens: 60 }, costUSD: 0.001 },
    { ts: ts(5), type: "tool_result", session: "s", req: "r2", tool_call_id: "c1", name: "read", isError: true, chars: 30, preview: "Error: File not found: /a" },
    { ts: ts(6), type: "guard_stop", session: "s", req: "r2", kind: "repeated_calls", reason: "loop" },
  ];
  const a = analyze(ev);
  assert.equal(a.route, "ollama-v1");
  assert.equal(a.modelCalls, 3);
  assert.equal(a.toolCallsEmitted, 1);
  assert.deepEqual(a.usage, { prompt: 2700, completion: 60 });
  const text = a.flags.map((f) => `[${f.severity}] ${f.message}`).join("\n");
  assert.match(text, /\[high\] turn stopped by the proxy \(repeated_calls\)/);
  assert.match(text, /\[high\] 1 request\(s\) were truncated .* 900 of ~9000/);
  assert.match(text, /\[medium\] a user message of 3468000 chars did not fit the context window/);
  assert.match(text, /invalid tool call.*unknown_tool:1/);
  assert.match(text, /redundant call/);
  assert.match(text, /rate_limit:1 \(1 retried\)/);
  assert.match(text, /tool call\(s\) failed in OpenCode: read: Error: File not found/);
  const tl = timeline(ev).join("\n");
  assert.match(tl, /route ollama-v1/);
  assert.match(tl, /context truncated by the server: 900 of ~9000/);
  assert.match(tl, /context trimmed by the proxy: ~1083858 → ~18000 tokens \(window 32768\); cut user 3468000→57600 chars/);
});

test("a clean session has no abnormalities", () => {
  const a = analyze([
    { ts: ts(0), type: "request", session: "s", req: "r1", tools: ["read"], objective: "what is 2+2" },
    { ts: ts(1), type: "response", session: "s", req: "r1", calls: [], text: "4", modelCalls: 1 },
  ]);
  assert.deepEqual(a.flags.filter((f) => f.severity !== "low"), []);
});
