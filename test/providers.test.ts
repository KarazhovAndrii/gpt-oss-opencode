// Provider neutrality: the default profile is a generic OpenAI-compatible GPT-OSS
// provider; vendor presets are opt-in and nothing inherits a vendor's quirks.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSetUp, loadConfig, loadDotEnv, selectProfile } from "../src/config.ts";
import { opencodeProvider, registerProvider } from "../src/opencode.ts";
import { startMockUpstream, type MockUpstream } from "./helpers/mock-upstream.ts";
import { startProxy, chat, type TestProxy } from "./helpers/proxy.ts";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.ts";
import { Logger } from "../src/log.ts";

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

test("OpenWebUI numCtx: requested from the server, so it is the window too, unless one is set explicitly", () => {
  const dir = tmp();
  const p = (env: Record<string, string>) => loadConfig(env, dir).profiles.openwebui;
  assert.deepEqual([p({ OPENWEBUI_NUM_CTX: "65536" }).numCtx, p({ OPENWEBUI_NUM_CTX: "65536" }).contextWindow], [65536, 65536]);
  assert.equal(p({ OPENWEBUI_NUM_CTX: "131072", OPENWEBUI_CONTEXT_WINDOW: "65536" }).contextWindow, 65536, "an explicit window wins");
  assert.throws(() => p({ OPENWEBUI_NUM_CTX: "32768", OPENWEBUI_CONTEXT_WINDOW: "65536" }), /numCtx \(32768\) is smaller than contextWindow \(65536\)/);
  assert.throws(() => p({ OPENWEBUI_NUM_CTX: "64k" }), /numCtx must be a number/);
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: { openwebui: { numCtx: 65536 }, custom: { baseURL: "http://x/v1", numCtx: 65536 } } }));
  const cfg = loadConfig({ GPT_OSS_CONFIG: file }, dir);
  assert.equal(cfg.profiles.openwebui.contextWindow, 65536);
  assert.equal(cfg.profiles.custom.contextWindow, 32768, "num_ctx is an OpenWebUI request option; other profiles ignore it");
  assert.equal(cfg.configFile, file);
  fs.writeFileSync(file, "{ broken");
  assert.throws(() => loadConfig({ GPT_OSS_CONFIG: file }, dir), /cfg\.json is not valid JSON/);
});

test("a profile is set up by its own address, or by a key for a preset's built-in address", () => {
  const dir = tmp();
  const cfg = loadConfig({}, dir);
  assert.ok(!isSetUp(cfg.profiles.custom, {}));
  assert.ok(!isSetUp(cfg.profiles.siliconflow, {}), "SiliconFlow's address alone is not a setup");
  assert.ok(isSetUp(cfg.profiles.siliconflow, { SILICONFLOW_API_KEY: "sk" }));
  assert.ok(!isSetUp(cfg.profiles.openwebui, {}));
  assert.ok(isSetUp(loadConfig({ OPENWEBUI_BASE_URL: "http://gpu:8080/api" }, dir).profiles.openwebui, {}));
  assert.ok(isSetUp(loadConfig({ CUSTOM_BASE_URL: "http://localhost:11434/v1" }, dir).profiles.custom, {}), "a keyless local server");
});

test(".env next to the config is loaded; the environment wins over it", () => {
  const dir = tmp();
  assert.equal(loadDotEnv(dir), undefined);
  fs.writeFileSync(path.join(dir, ".env"), "export GPTOSS_TEST_A=from-file\nGPTOSS_TEST_B=from-file # comment\n");
  process.env.GPTOSS_TEST_B = "from-env";
  try {
    assert.equal(loadDotEnv(dir), path.join(dir, ".env"));
    assert.deepEqual([process.env.GPTOSS_TEST_A, process.env.GPTOSS_TEST_B], ["from-file", "from-env"]);
  } finally {
    delete process.env.GPTOSS_TEST_A;
    delete process.env.GPTOSS_TEST_B;
  }
});

test("the plugin registers the configured profiles with the proxy's limits; the user's model settings win", () => {
  const dir = tmp();
  const cfg = loadConfig({ OPENWEBUI_BASE_URL: "http://gpu:8080/api", OPENWEBUI_NUM_CTX: "65536", GPT_OSS_PORT: "9100" }, dir);
  const oc: any = { model: "gpt-oss/custom" };
  registerProvider(oc, cfg);
  const prov = oc.provider["gpt-oss"];
  assert.equal(prov.options.baseURL, "http://127.0.0.1:9100/v1");
  assert.deepEqual(Object.keys(prov.models).sort(), ["custom", "openwebui"], "set-up profiles, plus the one OpenCode is told to use");
  assert.deepEqual(prov.models.openwebui.limit, { context: 65536, output: 8192 });
  const mine: any = { provider: { "gpt-oss": { options: { baseURL: "http://stale:1/v1", apiKey: "tok" }, models: { openwebui: { name: "Ours", limit: { context: 50000 } } } }, other: { npm: "x" } } };
  registerProvider(mine, cfg);
  const m = mine.provider["gpt-oss"];
  assert.equal(m.options.baseURL, "http://127.0.0.1:9100/v1", "the address is where the plugin serves");
  assert.equal(m.options.apiKey, "tok");
  assert.deepEqual([m.models.openwebui.name, m.models.openwebui.limit], ["Ours", { context: 50000, output: 8192 }]);
  assert.ok(mine.provider.other, "other providers untouched");
  // nothing set up: every profile is listed, so each one answers with how to set it up
  const none: any = {};
  registerProvider(none, loadConfig({}, dir));
  assert.deepEqual(Object.keys(none.provider["gpt-oss"].models).sort(), ["custom", "openwebui", "siliconflow"]);
});

test("the shipped OpenCode config is what the proxy would register for its defaults", () => {
  const oc = JSON.parse(fs.readFileSync(new URL("../opencode/opencode.json", import.meta.url), "utf8"));
  assert.deepEqual(oc.provider["gpt-oss"], opencodeProvider(loadConfig({}, tmp()), { all: true }));
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
    assert.match(r.json.choices[0].message.content, /profile "mock", which has no address yet\. Run "npm run setup" in the gpt-oss-opencode folder, or set MOCK_BASE_URL/);
    assert.equal(up.requests.length, 0, "nothing was sent upstream");
  });
});

test("a configuration that cannot be loaded is reported inside OpenCode, not as a dead endpoint", async () => {
  const dir = tmp();
  const cfg = loadConfig({}, dir);
  const server = createServer({ cfg, logger: new Logger(dir, { quiet: true }), startupError: "gpt-oss-proxy.config.json is not valid JSON" });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const r = await chat(url, { model: "openwebui", stream: false, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.match(r.json.choices[0].message.content, /configuration could not be loaded: gpt-oss-proxy\.config\.json is not valid JSON\nFix it \(or run "npm run setup"/);
  } finally {
    server.close();
  }
});
