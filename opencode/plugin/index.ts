// OpenCode plugin for OpenCode 1.x and 2.x: runs gpt-oss-proxy inside OpenCode's own process,
// so no separate terminal is needed. `npm run setup` adds it to OpenCode's config.
//
//   OpenCode 2.x loads a plugin *directory* (this one) and calls `setup`; the `gpt-oss`
//   provider comes from the provider block that setup writes into OpenCode's config.
//   OpenCode 1.x calls `server`, whose `config` hook also registers that provider (limits
//   from the proxy config), so a plugin line alone is enough there.
//
// One proxy per process: OpenCode 2.x's background service sets plugins up once per project
// folder, and those setups share it. If another process already serves the port (another
// OpenCode, `npm start`) it is used, and this process takes the port over when that one goes.
//
// Configuration is the same as for the standalone proxy: gpt-oss-proxy.config.json and .env
// next to this repository's package.json, or GPT_OSS_* / <PROFILE>_* environment variables.

import type { Hooks } from "@opencode-ai/plugin";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, loadConfig, loadDotEnv, type Config } from "../../src/config.ts";
import { bindRefusal, createServer } from "../../src/server.ts";
import { Logger, pruneLogs } from "../../src/log.ts";
import { OPENCODE_PROVIDER_ID, registerProvider } from "../../src/opencode.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Shared by every copy of this module in the process (OpenCode may import it more than once). */
const SHARED = Symbol.for("gpt-oss-opencode.proxy");
/** How often to check that some process serves the proxy port. */
const WATCH_MS = 15_000;

interface Runtime {
  cfg: Config;
  startupError?: string;
  token?: string;
  users: number;
  ensure(): Promise<void>;
  close(): Promise<void>;
}

async function alreadyRunning(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    return j?.ok === true && Array.isArray(j.profiles);
  } catch {
    return false;
  }
}

function createRuntime(): Runtime {
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
  if (refusal) console.error(`[gpt-oss-proxy plugin] ${refusal}`);
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
        // Lost a race with another process: fine, it serves the same endpoint.
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
  const ensure = () => (refusal || listening ? Promise.resolve() : (starting ??= start().finally(() => (starting = undefined))));
  // The process serving the port may be another OpenCode window that closes.
  const watch = setInterval(() => void ensure(), WATCH_MS);
  watch.unref?.();
  return {
    cfg,
    startupError,
    token,
    users: 0,
    ensure,
    close: async () => {
      clearInterval(watch);
      if (!listening) return;
      listening = false;
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

async function acquire(): Promise<Runtime> {
  const g = globalThis as any;
  const rt: Runtime = (g[SHARED] ??= createRuntime());
  rt.users++;
  await rt.ensure();
  return rt;
}

async function release(rt: Runtime) {
  if (--rt.users > 0) return;
  const g = globalThis as any;
  if (g[SHARED] === rt) delete g[SHARED];
  await rt.close();
}

/** OpenCode 1.x: plugin hooks. */
async function server(): Promise<Hooks> {
  const rt = await acquire();
  return {
    config: async (oc) => registerProvider(oc, rt.cfg, { token: rt.token, all: !!rt.startupError }),
    // Before each model call: the proxy this window relied on may have closed with its window.
    "chat.params": async (input) => {
      if (input.model?.providerID === OPENCODE_PROVIDER_ID) await rt.ensure();
    },
    dispose: () => release(rt),
  };
}

/** OpenCode 2.x: start the proxy; the returned function stops it with the last user. */
async function setup(): Promise<() => Promise<void>> {
  const rt = await acquire();
  return () => release(rt);
}

export default { id: "gpt-oss-proxy", server, setup };
