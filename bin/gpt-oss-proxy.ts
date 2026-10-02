#!/usr/bin/env node
// Starts the GPT-OSS <-> OpenCode proxy.
//   node bin/gpt-oss-proxy.ts [--port N] [--profile NAME] [--config FILE]
import { loadConfig, loadDotEnv, apiKeyFor, envPrefix, isSetUp, type Config } from "../src/config.ts";
import { bindRefusal, createServer } from "../src/server.ts";
import { pruneLogs } from "../src/log.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag("config")) process.env.GPT_OSS_CONFIG = flag("config");
if (flag("profile")) process.env.GPT_OSS_PROFILE = flag("profile");
if (flag("port")) process.env.GPT_OSS_PORT = flag("port");
if (flag("strategy")) process.env.GPT_OSS_STRATEGY = flag("strategy");

let cfg: Config;
let dotenv: string | undefined;
try {
  dotenv = loadDotEnv(process.cwd());
  cfg = loadConfig();
} catch (e) {
  console.error(`gpt-oss-proxy: ${(e as Error).message}\nFix it, or run "npm run setup" to write a working configuration.`);
  process.exit(1);
}
const refusal = bindRefusal(cfg.host, process.env.GPT_OSS_PROXY_TOKEN);
if (refusal) {
  console.error(`gpt-oss-proxy: ${refusal}`);
  process.exit(1);
}
const prune = () => pruneLogs(cfg.logDir, cfg.logRetentionDays);
prune();
setInterval(prune, 24 * 3_600_000).unref();
const server = createServer({ cfg });
server.on("error", (e: any) => {
  const hint = e?.code === "EADDRINUSE" ? ` Another proxy (or OpenCode with the gpt-oss plugin, which runs one) may already be running; set GPT_OSS_PORT to use another port.` : "";
  console.error(`gpt-oss-proxy: cannot listen on ${cfg.host}:${cfg.port}: ${e?.message ?? e}.${hint}`);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  console.log(`gpt-oss-proxy listening on http://${cfg.host}:${cfg.port}/v1`);
  console.log(`config: ${cfg.configFile ?? "none (built-in defaults + environment)"}${dotenv ? `; .env: ${dotenv}` : ""}`);
  for (const p of Object.values(cfg.profiles)) {
    const mark = p.name === cfg.defaultProfile ? "*" : " ";
    if (!isSetUp(p)) {
      console.log(` ${mark} ${p.name.padEnd(12)} not set up (${p.baseURL ? `set ${p.apiKeyEnv ?? "a key"}` : `set ${envPrefix(p)}_BASE_URL`})`);
      continue;
    }
    // A key is optional: local servers (vLLM, llama.cpp, Ollama) usually need none.
    const key = apiKeyFor(p) ? "present" : `none (${p.apiKeyEnv ?? "apiKeyFile"} not set)`;
    const ctx = p.numCtx ? `window=${p.contextWindow} (num_ctx requested)` : `window=${p.contextWindow}`;
    console.log(` ${mark} ${p.name.padEnd(12)} ${p.baseURL}  model=${p.model}  strategy=${p.strategy}  ${ctx}  key=${key}`);
  }
  if (!Object.values(cfg.profiles).some((p) => isSetUp(p))) console.log(`No provider set up yet: run "npm run setup" (about a minute).`);
  const kept = cfg.logRetentionDays ? `${cfg.logRetentionDays} days` : "forever";
  console.log(`logs: ${cfg.logDir} (${cfg.logContent ? "with content" : "metadata only; GPT_OSS_LOG_CONTENT=1 adds content"}, kept ${kept})`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
