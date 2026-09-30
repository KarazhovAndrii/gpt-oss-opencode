// Provider neutrality: the default profile is a generic OpenAI-compatible GPT-OSS
// provider; vendor presets are opt-in and nothing inherits a vendor's quirks.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, selectProfile } from "../src/config.ts";
import { startMockUpstream, type MockUpstream } from "./helpers/mock-upstream.ts";
import { startProxy, chat, type TestProxy } from "./helpers/proxy.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-prov-"));

test("the default profile is a generic provider configured by CUSTOM_* variables", () => {
  const dir = tmp();
  const cfg = loadConfig({}, dir);
  assert.equal(cfg.defaultProfile, "custom");
  assert.equal(cfg.profiles.custom.baseURL, "", "unconfigured until CUSTOM_BASE_URL is set");
  assert.equal(cfg.profiles.custom.strategy, "auto", "native tool calls first, emulation as fallback");
  const set = loadConfig({ CUSTOM_BASE_URL: "http://gpu-box:8000/v1/", CUSTOM_MODEL: "gpt-oss:20b", CUSTOM_CONTEXT_WINDOW: "131072" }, dir).profiles.custom;
  assert.deepEqual([set.baseURL, set.model, set.contextWindow], ["http://gpu-box:8000/v1", "gpt-oss:20b", 131072]);
  assert.throws(() => loadConfig({ CUSTOM_BASE_URL: "gpu-box:8000" }, dir), /baseURL must be http/);
});

test("generic model ids route to the generic provider, not to a vendor preset", () => {
  const cfg = loadConfig({}, tmp());
  for (const id of ["gpt-oss-20b", "openai/gpt-oss-20b", "anything"]) assert.equal(selectProfile(cfg, id).name, "custom", id);
  assert.equal(selectProfile(cfg, "siliconflow").name, "siliconflow");
  assert.equal(selectProfile(cfg, "openwebui").name, "openwebui");
});

test("a provider added in a config file inherits neutral defaults", () => {
  const dir = tmp();
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: { myhost: { baseURL: "http://myhost:8000/v1", model: "openai/gpt-oss-20b" } } }));
  const p = loadConfig({ GPT_OSS_CONFIG: file }, dir).profiles.myhost;
  assert.deepEqual([p.strategy, p.stream, p.contextWindow, p.pricing, p.apiKeyEnv], ["auto", true, 32768, undefined, undefined]);
  // its own <NAME>_* variables work like the built-in ones
  assert.equal(loadConfig({ GPT_OSS_CONFIG: file, MYHOST_MODEL: "gpt-oss-20b-q4" }, dir).profiles.myhost.model, "gpt-oss-20b-q4");
});

test("the shipped OpenCode config defaults to the generic provider with a matching window", () => {
  const oc = JSON.parse(fs.readFileSync(new URL("../opencode/opencode.json", import.meta.url), "utf8"));
  assert.equal(oc.model, "gpt-oss/custom");
  const cfg = loadConfig({}, tmp());
  for (const [key, m] of Object.entries<any>(oc.provider["gpt-oss"].models)) {
    assert.ok(cfg.profiles[key], `OpenCode model ${key} has a proxy profile`);
    assert.equal(m.limit.context, cfg.profiles[key].contextWindow, `${key}: OpenCode and the proxy agree on the window`);
    assert.ok(!/gpt/i.test(key), `${key}: keep "gpt" out of the model key (OpenCode picks its GPT prompt by id)`);
  }
});

describe("a request for a provider without an address", () => {
  let up: MockUpstream;
  let px: TestProxy;
  before(async () => {
    up = await startMockUpstream();
    px = await startProxy(up.url, { baseURL: "" });
  });
  after(async () => {
    await px.close();
    await up.close();
  });

  test("gets an actionable message instead of a network error", async () => {
    const r = await chat(px.url, { model: "mock", stream: false, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.match(r.json.choices[0].message.content, /profile "mock", which has no address yet\. Set MOCK_BASE_URL/);
    assert.equal(up.requests.length, 0, "nothing was sent upstream");
  });
});
