// OpenCode plugin: runs gpt-oss-proxy inside OpenCode's own process, so no separate
// terminal is needed, and registers the "gpt-oss" provider (one model per configured
// profile, limits from the proxy config), so opencode.json needs no provider block.
// If another proxy already serves the port (another OpenCode window, `npm start`), it is
// used; if that one goes away, this instance takes over before its next model call.
//
// Enable in opencode.json (`npm run setup` does this for you):
//   "plugin": ["file:///ABSOLUTE/PATH/TO/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"]
//
// Configuration is the same as for the standalone proxy: gpt-oss-proxy.config.json and .env
// next to this repository's package.json, or GPT_OSS_* / <PROFILE>_* environment variables.

import type { Plugin } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, loadConfig, loadDotEnv, type Config } from "../../src/config.ts";
import { bindRefusal, createServer } from "../../src/server.ts";
import { Logger, pruneLogs } from "../../src/log.ts";
import { OPENCODE_PROVIDER_ID, registerProvider } from "../../src/opencode.ts";

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
  let cfg: Config;
  let startupError: string | undefined;
  try {
    loadDotEnv(ROOT);
    cfg = loadConfig(process.env, ROOT);
  } catch (e) {
    // Still serve: every request then answers with this error, inside OpenCode.
    startupError = (e as Error).message;
    cfg = defaultConfig(ROOT);
    if (Number(process.env.GPT_OSS_PORT) > 0) cfg.port = Number(process.env.GPT_OSS_PORT);
  }
  const token = process.env.GPT_OSS_PROXY_TOKEN;
  const refusal = bindRefusal(cfg.host, token);
  if (refusal) {
    console.error(`[gpt-oss-proxy plugin] ${refusal}`);
    return {};
  }
  pruneLogs(cfg.logDir, cfg.logRetentionDays);
  // Quiet: console output would corrupt OpenCode's TUI. Diagnostics still go to cfg.logDir.
  const server = createServer({ cfg, logger: new Logger(cfg.logDir, { quiet: true }), startupError });
  let listening = false;
  let starting: Promise<void> | undefined;
  const start = async () => {
    if (await alreadyRunning(cfg.host, cfg.port)) return;
    await new Promise<void>((resolve) => {
      const onError = (e: any) => {
        server.off("listening", onListening);
        // Lost a race with another instance: fine, it serves the same endpoint.
        if (e?.code !== "EADDRINUSE") console.error(`[gpt-oss-proxy plugin] ${e?.message ?? e}`);
        resolve();
      };
      const onListening = () => {
        server.off("error", onError);
        listening = true;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(cfg.port, cfg.host);
    });
  };
  const ensureProxy = () => (listening ? Promise.resolve() : (starting ??= start().finally(() => (starting = undefined))));
  await ensureProxy();
  return {
    config: async (oc) => registerProvider(oc, cfg, { token, all: !!startupError }),
    // The proxy this window relied on may have closed with its OpenCode window.
    "chat.params": async (input) => {
      if (input.model?.providerID === OPENCODE_PROVIDER_ID) await ensureProxy();
    },
    dispose: async () => {
      if (!listening) return;
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
};
