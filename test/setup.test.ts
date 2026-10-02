// `npm run setup` / `npm run doctor`: input normalisation, config writing that keeps the
// user's comments, and the CLI end to end against a mock OpenWebUI (child processes, with
// the proxy config and OpenCode's config redirected to temp folders).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.ts";
import {
  customBaseURLs,
  listModels,
  normalizeOpenWebUIURL,
  parseContext,
  parseJsonc,
  planOpenCodeChange,
  rankModels,
  setJsoncKeys,
  updatedProxyConfig,
} from "../src/setup.ts";
import { startMockOpenWebUI, type MockOpenWebUI } from "./helpers/mock-openwebui.ts";

const SETUP = fileURLToPath(new URL("../bin/setup.ts", import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-setup-"));

test("addresses: whatever people paste becomes the OpenWebUI API base or an OpenAI base URL", () => {
  for (const [input, want] of [
    ["192.168.1.20:8080", "http://192.168.1.20:8080/api"],
    ["http://gpu:8080/", "http://gpu:8080/api"],
    ["http://gpu:8080/api", "http://gpu:8080/api"],
    ["http://gpu:8080/api/chat/completions", "http://gpu:8080/api"],
    ["http://gpu:8080/ollama/v1", "http://gpu:8080/api"],
    ["https://chat.example.com/api/models", "https://chat.example.com/api"],
    ["https://example.com/owui/", "https://example.com/owui/api"],
  ]) assert.equal(normalizeOpenWebUIURL(input), want, input);
  assert.deepEqual(customBaseURLs("gpu-box:8000"), ["http://gpu-box:8000/v1", "http://gpu-box:8000"]);
  assert.deepEqual(customBaseURLs("http://gpu-box:8000/v1/chat/completions"), ["http://gpu-box:8000/v1"]);
});

test("context sizes accept plain numbers and k", () => {
  assert.equal(parseContext("65536"), 65536);
  assert.equal(parseContext("64k"), 65536);
  assert.equal(parseContext(" 32 K "), 32768);
  assert.equal(parseContext("lots"), undefined);
  assert.equal(parseContext("0"), undefined);
});

test("GPT-OSS models are offered first", () => {
  const ranked = rankModels([{ id: "llama3:8b" }, { id: "gpt-oss20b-specialist" }, { id: "qwen" }, { id: "x", name: "GPT-OSS 120B" }]);
  assert.deepEqual(ranked.map((m) => m.id), ["gpt-oss20b-specialist", "x", "llama3:8b", "qwen"]);
});

test("JSONC: comments, trailing commas and comment-like strings are read as OpenCode reads them", () => {
  const text = '\uFEFF{\n  // c1\n  "a": "http://x//y", /* c2 */\n  "b": [1, 2,],\n  "c": { "d": "/* not a comment */", },\n}\n';
  assert.deepEqual(parseJsonc(text), { a: "http://x//y", b: [1, 2], c: { d: "/* not a comment */" } });
  assert.deepEqual(parseJsonc(""), {});
});

test("JSONC: setting keys changes only those values and keeps comments and order", () => {
  const text = '{\n  "$schema": "https://opencode.ai/config.json",\n  // my main model\n  "model": "anthropic/x",\n  "theme": "tokyonight", // keep me\n}\n';
  const out = setJsoncKeys(text, { plugin: ["file:///p.ts"], model: "gpt-oss/openwebui", small_model: "gpt-oss/openwebui" });
  assert.match(out, /\/\/ my main model\n  "model": "gpt-oss\/openwebui",/);
  assert.match(out, /"theme": "tokyonight", \/\/ keep me/);
  assert.deepEqual(Object.keys(parseJsonc(out)), ["$schema", "plugin", "small_model", "model", "theme"]);
  assert.deepEqual(parseJsonc(out).plugin, ["file:///p.ts"]);
  // no $schema, a last member without a comma, an empty object
  assert.deepEqual(parseJsonc(setJsoncKeys('{ "a": 1 }', { b: 2 })), { b: 2, a: 1 });
  assert.deepEqual(parseJsonc(setJsoncKeys('{ "$schema": "s" }', { b: { c: [1] } })), { $schema: "s", b: { c: [1] } });
  assert.deepEqual(parseJsonc(setJsoncKeys("{}", { a: 1, b: 2 })), { a: 1, b: 2 });
  assert.deepEqual(parseJsonc(setJsoncKeys("", { a: 1 })), { a: 1 });
  assert.throws(() => setJsoncKeys("[1]", { a: 1 }), /JSON object/);
});

test("the proxy config: this profile is replaced, everything else kept; numCtx or contextWindow, never both", () => {
  const existing = { port: 9000, profiles: { siliconflow: { apiKeyFile: "sf.key" }, openwebui: { baseURL: "http://old/api", contextWindow: 32768, openwebuiRoute: "api", extraBody: { a: 1 } } } };
  const next = updatedProxyConfig(existing, { profile: "openwebui", baseURL: "http://new:8080/api", model: "m", context: 65536, numCtx: true, keyFile: "openwebui.key" });
  assert.deepEqual(next, {
    port: 9000,
    defaultProfile: "openwebui",
    profiles: { siliconflow: { apiKeyFile: "sf.key" }, openwebui: { baseURL: "http://new:8080/api", model: "m", numCtx: 65536, apiKeyFile: "openwebui.key", extraBody: { a: 1 } } },
  });
  assert.equal(existing.profiles.openwebui.baseURL, "http://old/api", "input not mutated");
  const fixed = updatedProxyConfig({}, { profile: "openwebui", baseURL: "http://s/api", model: "m", context: 65536, numCtx: false });
  assert.deepEqual(fixed.profiles.openwebui, { baseURL: "http://s/api", model: "m", contextWindow: 65536 });
});

test("OpenCode changes: plugin from any older clone replaced, static block removed, default model optional", () => {
  const cfg = loadConfig({ OPENWEBUI_BASE_URL: "http://gpu:8080/api", OPENWEBUI_NUM_CTX: "65536" }, tmp());
  const current = {
    model: "anthropic/x",
    plugin: ["some-plugin", "file:///C:/old/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"],
    provider: { other: { npm: "x" }, "gpt-oss": { models: { openwebui: { limit: { context: 32768 } } } } },
  };
  const plan = planOpenCodeChange(current, { cfg, profile: "openwebui", plugin: true, makeDefault: false, pluginFile: "/repo/opencode/plugin/gpt-oss-proxy.ts" });
  assert.deepEqual(plan.set.plugin, ["some-plugin", pathToFileURL("/repo/opencode/plugin/gpt-oss-proxy.ts").href]);
  assert.deepEqual(plan.set.provider, { other: { npm: "x" } });
  assert.equal(plan.set.model, undefined, "the user's default model is kept");
  const both = planOpenCodeChange({}, { cfg, profile: "openwebui", plugin: false, makeDefault: true });
  assert.equal(both.set.model, "gpt-oss/openwebui");
  assert.equal(both.set.small_model, "gpt-oss/openwebui", "titles stay on the same server");
  assert.deepEqual((both.set.provider as any)["gpt-oss"].models.openwebui.limit, { context: 65536, output: 8192 });
});

test("model listing explains failures in words a user can act on", async () => {
  const owui = await startMockOpenWebUI();
  try {
    const good = await listModels(`${owui.url}/api/models`, "sk-good");
    assert.ok(good.ok && good.models.some((m) => m.id === "gpt-oss20b-specialist"));
    const bad = await listModels(`${owui.url}/api/models`, "sk-wrong");
    assert.ok(!bad.ok && bad.status === 401 && /rejected the API key/.test(bad.error));
    owui.apiKeysDisabled = true;
    const off = await listModels(`${owui.url}/api/models`, "sk-good");
    assert.ok(!off.ok && /API keys are switched off.*admin/.test(off.error));
  } finally {
    await owui.close();
  }
  const refused = await listModels("http://127.0.0.1:1/api/models", "k");
  assert.ok(!refused.ok && /Cannot reach .*VPN/.test(refused.error), refused.ok ? "" : refused.error);
  const page = http.createServer((_q, r) => r.end("<!doctype html><html></html>"));
  await new Promise<void>((ok) => page.listen(0, "127.0.0.1", ok));
  try {
    const html = await listModels(`http://127.0.0.1:${(page.address() as AddressInfo).port}/v1/models`, undefined);
    assert.ok(!html.ok && /a web page instead of a model list/.test(html.error));
  } finally {
    page.close();
  }
});

// ---- The CLI, end to end ----

function runSetup(box: string, args: string[], input?: string): Promise<{ code: number | null; out: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENWEBUI|CUSTOM|SILICONFLOW|GPT_OSS|OPENCODE)_/.test(k)));
  Object.assign(env, { GPT_OSS_CONFIG: path.join(box, "proxy", "gpt-oss-proxy.config.json"), XDG_CONFIG_HOME: path.join(box, "xdg"), NO_COLOR: "1" });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(input ?? "");
    child.on("close", (code) => resolve({ code, out }));
  });
}

function newBox(): string {
  const box = tmp();
  fs.mkdirSync(path.join(box, "proxy"));
  fs.mkdirSync(path.join(box, "xdg", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(box, "key.txt"), "sk-good\n");
  return box;
}

describe("npm run setup / doctor", () => {
  let owui: MockOpenWebUI;
  before(async () => {
    owui = await startMockOpenWebUI();
  });
  after(async () => owui.close());

  test("one command line: checks a real tool call, then writes the config, the key and OpenCode's config", async () => {
    const box = newBox();
    owui.chats.length = 0;
    const r = await runSetup(box, ["--openwebui", owui.url.replace("http://", ""), "--model", "gpt-oss20b-specialist", "--context", "64k", "--key-file", path.join(box, "key.txt"), "--yes"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /ok {2}tool call works .*route api, tool calls: native.*the model called read/);
    assert.match(r.out, /npm run setup -- --openwebui http:\/\/127\.0\.0\.1:\d+ --model gpt-oss20b-specialist --context 65536\n/);
    // the check went through the real proxy with the context requested per request
    assert.equal(owui.chats.length, 1);
    assert.equal(owui.chats[0].path, "/api/chat/completions");
    assert.equal(owui.chats[0].body.options.num_ctx, 65536);
    const cfgText = fs.readFileSync(path.join(box, "proxy", "gpt-oss-proxy.config.json"), "utf8");
    assert.ok(!cfgText.includes("sk-good"), "no key in the config file");
    assert.deepEqual(JSON.parse(cfgText), { defaultProfile: "openwebui", profiles: { openwebui: { baseURL: `${owui.url}/api`, model: "gpt-oss20b-specialist", numCtx: 65536, apiKeyFile: "openwebui.key" } } });
    assert.equal(fs.readFileSync(path.join(box, "proxy", "openwebui.key"), "utf8").trim(), "sk-good");
    const oc = JSON.parse(fs.readFileSync(path.join(box, "xdg", "opencode", "opencode.json"), "utf8"));
    assert.equal(oc.model, "gpt-oss/openwebui");
    assert.equal(oc.small_model, "gpt-oss/openwebui");
    assert.equal(oc.plugin.length, 1);
    assert.ok(fs.existsSync(fileURLToPath(oc.plugin[0])), "the plugin path exists");
    // what the plugin will load from these files
    const cfg = loadConfig({ GPT_OSS_CONFIG: path.join(box, "proxy", "gpt-oss-proxy.config.json") }, box);
    assert.deepEqual([cfg.defaultProfile, cfg.profiles.openwebui.contextWindow, cfg.profiles.openwebui.numCtx], ["openwebui", 65536, 65536]);

    // doctor agrees, and changes nothing
    const before = fs.readFileSync(path.join(box, "xdg", "opencode", "opencode.json"), "utf8");
    const d = await runSetup(box, ["--doctor"]);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /OpenCode starts the proxy/);
    assert.match(d.out, /server reachable, key accepted, model gpt-oss20b-specialist listed/);
    assert.match(d.out, /All good\./);
    assert.equal(fs.readFileSync(path.join(box, "xdg", "opencode", "opencode.json"), "utf8"), before);
  });

  test("questions with piped answers: a wrong key is asked again; the user's JSONC keeps its comments", async () => {
    const box = newBox();
    const jsonc = path.join(box, "xdg", "opencode", "opencode.jsonc");
    fs.writeFileSync(
      jsonc,
      '{\n  "$schema": "https://opencode.ai/config.json",\n  // my main model\n  "model": "anthropic/x",\n  "provider": {\n    "gpt-oss": { "options": { "baseURL": "http://127.0.0.1:8787/v1" }, "models": { "openwebui": { "limit": { "context": 32768 } } } },\n    "other": { "npm": "x" },\n  },\n  "theme": "tokyonight", // keep me\n}\n',
    );
    // where, address, wrong key, right key, model 1, context, keep anthropic as default
    const r = await runSetup(box, [], `1\n${owui.url}\nsk-wrong\nsk-good\n1\n32768\nn\n`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /failed {2}The server rejected the API key/);
    assert.match(r.out, /removed the static block/);
    const text = fs.readFileSync(jsonc, "utf8");
    assert.match(text, /\/\/ my main model\n  "model": "anthropic\/x",/, "default model kept, comment kept");
    assert.match(text, /"theme": "tokyonight", \/\/ keep me/);
    const oc = parseJsonc(text);
    assert.deepEqual(Object.keys(oc.provider), ["other"]);
    assert.equal(oc.small_model, undefined);
    assert.equal(oc.plugin.length, 1);
    assert.equal(fs.readdirSync(path.dirname(jsonc)).filter((f) => f.startsWith("opencode.jsonc.bak-")).length, 1, "backup kept");
    assert.equal(JSON.parse(fs.readFileSync(path.join(box, "proxy", "gpt-oss-proxy.config.json"), "utf8")).profiles.openwebui.numCtx, 32768);
  });

  test("a failing check writes nothing and says why", async () => {
    const box = newBox();
    owui.apiKeysDisabled = true;
    try {
      const r = await runSetup(box, ["--openwebui", owui.url, "--model", "gpt-oss20b-specialist", "--key-file", path.join(box, "key.txt"), "--yes"]);
      assert.equal(r.code, 1);
      assert.match(r.out, /API keys are switched off on this OpenWebUI server/);
      assert.deepEqual(fs.readdirSync(path.join(box, "proxy")), []);
      assert.deepEqual(fs.readdirSync(path.join(box, "xdg", "opencode")), []);
    } finally {
      owui.apiKeysDisabled = false;
    }
    const unknown = await runSetup(box, ["--openwebui", owui.url, "--model", "gpt-oss-20b", "--key-file", path.join(box, "key.txt"), "--yes"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /the server has no model "gpt-oss-20b"\. GPT-OSS models it has: gpt-oss20b-specialist/);
  });

  test("doctor points at the broken piece", async () => {
    const box = newBox();
    fs.writeFileSync(path.join(box, "proxy", "gpt-oss-proxy.config.json"), "{}");
    const d = await runSetup(box, ["--doctor"]);
    assert.equal(d.code, 1);
    assert.match(d.out, /no OpenCode config .*npm run setup/);
    fs.writeFileSync(path.join(box, "xdg", "opencode", "opencode.json"), JSON.stringify({ plugin: ["file:///C:/moved/opencode/plugin/gpt-oss-proxy.ts"], model: "gpt-oss/openwebui" }));
    const moved = await runSetup(box, ["--doctor"]);
    assert.match(moved.out, /does not exist \(moved folder\?\)/);
    assert.match(moved.out, /not set up yet .*npm run setup/);
  });
});
