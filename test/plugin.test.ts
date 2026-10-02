// The OpenCode plugin, run in Node: it registers the provider from the proxy config, and
// keeps a proxy available when the one it relied on (another OpenCode window) goes away.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { Logger } from "../src/log.ts";
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

test("plugin: registers the provider, and takes over the port when the other window's proxy closes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-plugin-"));
  const port = await freePort();
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({ port, logDir: path.join(dir, "logs"), profiles: { openwebui: { baseURL: "http://gpu:8080/api", numCtx: 65536 } } }));
  const saved = process.env.GPT_OSS_CONFIG;
  process.env.GPT_OSS_CONFIG = file;
  // Another OpenCode window already runs the proxy.
  const other = createServer({ cfg: loadConfig({ GPT_OSS_CONFIG: file }, dir), logger: new Logger(dir, { quiet: true }) });
  await new Promise<void>((ok) => other.listen(port, "127.0.0.1", ok));
  try {
    const hooks: any = await GptOssProxyPlugin({} as any);
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
    if (saved === undefined) delete process.env.GPT_OSS_CONFIG;
    else process.env.GPT_OSS_CONFIG = saved;
    other.close();
  }
});
