// Optional OpenCode plugin: starts gpt-oss-proxy inside OpenCode's own process
// so no separate terminal is needed. If the port is already taken by a running
// proxy (e.g. another OpenCode window or `npm start`), it is reused.
//
// Enable in opencode.json:
//   "plugin": ["file:///ABSOLUTE/PATH/TO/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"]
//
// Configuration is the same as for the standalone proxy (gpt-oss-proxy.config.json
// next to this repository's package.json, or GPT_OSS_CONFIG / GPT_OSS_* env vars).

import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.ts";
import { bindRefusal, createServer } from "../../src/server.ts";
import { Logger, pruneLogs } from "../../src/log.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function alreadyRunning(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j?.ok === true && Array.isArray(j.profiles);
  } catch {
    return false;
  }
}

export const GptOssProxyPlugin: Plugin = async () => {
  const cfg = loadConfig(process.env, ROOT);
  if (await alreadyRunning(cfg.host, cfg.port)) return {};
  const refusal = bindRefusal(cfg.host, process.env.GPT_OSS_PROXY_TOKEN);
  if (refusal) {
    console.error(`[gpt-oss-proxy plugin] ${refusal}`);
    return {};
  }
  pruneLogs(cfg.logDir, cfg.logRetentionDays);
  // Quiet: console output would corrupt OpenCode's TUI. Diagnostics still go to cfg.logDir.
  const server = createServer({ cfg, logger: new Logger(cfg.logDir, { quiet: true }) });
  await new Promise<void>((resolve) => {
    server.once("error", (e: any) => {
      // Lost a race with another instance: fine, it serves the same endpoint.
      if (e?.code !== "EADDRINUSE") console.error(`[gpt-oss-proxy plugin] ${e?.message ?? e}`);
      resolve();
    });
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  return {
    dispose: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
};
