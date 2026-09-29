#!/usr/bin/env node
// Starts the GPT-OSS <-> OpenCode proxy.
//   node bin/gpt-oss-proxy.ts [--port N] [--profile NAME] [--config FILE]
import { loadConfig, apiKeyFor } from "../src/config.ts";
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

const cfg = loadConfig();
const refusal = bindRefusal(cfg.host, process.env.GPT_OSS_PROXY_TOKEN);
if (refusal) {
  console.error(`gpt-oss-proxy: ${refusal}`);
  process.exit(1);
}
const prune = () => pruneLogs(cfg.logDir, cfg.logRetentionDays);
prune();
setInterval(prune, 24 * 3_600_000).unref();
const server = createServer({ cfg });
server.listen(cfg.port, cfg.host, () => {
  console.log(`gpt-oss-proxy listening on http://${cfg.host}:${cfg.port}/v1`);
  for (const p of Object.values(cfg.profiles)) {
    const mark = p.name === cfg.defaultProfile ? "*" : " ";
    console.log(` ${mark} ${p.name.padEnd(12)} ${p.baseURL}  model=${p.model}  strategy=${p.strategy}  key=${apiKeyFor(p) ? "present" : `MISSING (${p.apiKeyEnv ?? "apiKeyFile"})`}`);
  }
  const kept = cfg.logRetentionDays ? `${cfg.logRetentionDays} days` : "forever";
  console.log(`logs: ${cfg.logDir} (${cfg.logContent ? "with content" : "metadata only; GPT_OSS_LOG_CONTENT=1 adds content"}, kept ${kept})`);
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
