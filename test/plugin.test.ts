// The OpenCode plugin, run in Node: the module shapes OpenCode 1.x and 2.x load, provider
// registration from the proxy config, one proxy shared per process, and taking the port
// over when the proxy this process relied on (another OpenCode window) goes away.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { Logger } from "../src/log.ts";
import plugin from "../opencode/plugin/index.ts";
import { GptOssProxyPlugin } from "../opencode/plugin/gpt-oss-proxy.ts";

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

const healthy = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
    .then((r) => r.ok)
    .catch(() => false);

let dir: string;
let port: number;
let file: string;
const saved = process.env.GPT_OSS_CONFIG;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-plugin-"));
  port = await freePort();
  file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({ port, logDir: path.join(dir, "logs"), profiles: { openwebui: { baseURL: "http://gpu:8080/api", numCtx: 65536 } } }));
  process.env.GPT_OSS_CONFIG = file;
});
after(() => {
  if (saved === undefined) delete process.env.GPT_OSS_CONFIG;
  else process.env.GPT_OSS_CONFIG = saved;
});

test("one module for both OpenCode versions: 1.x calls server, 2.x calls setup; the old file entry still works", () => {
  assert.equal(typeof plugin.id, "string");
  assert.equal(typeof plugin.server, "function", "OpenCode 1.x: default export with id and server");
  assert.equal(typeof plugin.setup, "function", "OpenCode 2.x: default export with id and setup");
  assert.equal(GptOssProxyPlugin, plugin.server, "configs naming gpt-oss-proxy.ts (OpenCode 1.x) get the same plugin");
});

test("OpenCode 1.x: registers the provider, and takes over the port when the other window's proxy closes", async () => {
  // Another OpenCode window already runs the proxy.
  const other = createServer({ cfg: loadConfig({ GPT_OSS_CONFIG: file }, dir), logger: new Logger(dir, { quiet: true }) });
  await new Promise<void>((ok) => other.listen(port, "127.0.0.1", ok));
  try {
    const hooks: any = await plugin.server();
    const oc: any = { model: "gpt-oss/openwebui" };
    await hooks.config(oc);
    assert.equal(oc.provider["gpt-oss"].options.baseURL, `http://127.0.0.1:${port}/v1`);
    assert.deepEqual(oc.provider["gpt-oss"].models.openwebui.limit, { context: 65536, output: 8192 });

    // That window closes; the next model call in this window must still find a proxy.
    other.closeAllConnections();
    await new Promise<void>((ok) => other.close(() => ok()));
    assert.equal(await healthy(port), false);
    await hooks["chat.params"]({ model: { providerID: "anthropic" } }, {});
    assert.equal(await healthy(port), false, "other providers' calls do not start it");
    await hooks["chat.params"]({ model: { providerID: "gpt-oss" } }, {});
    assert.equal(await healthy(port), true);
    await hooks.dispose();
    assert.equal(await healthy(port), false);
  } finally {
    other.close();
  }
});

test("OpenCode 2.x: setups (one per project folder) share one proxy until the last cleanup", async () => {
  const cleanupA = await plugin.setup();
  const cleanupB = await plugin.setup();
  assert.equal(await healthy(port), true);
  await cleanupA();
  assert.equal(await healthy(port), true, "the other folder still uses it");
  await cleanupB();
  assert.equal(await healthy(port), false);
});
