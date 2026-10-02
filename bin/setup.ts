#!/usr/bin/env node
// npm run setup   connects OpenCode to a GPT-OSS server: asks for the address and key, picks
//                 the model, proves a tool call works, then writes the proxy config, the key
//                 file and OpenCode's config (plugin + default model).
// npm run doctor  checks the current setup and explains what is wrong, changing nothing.
// See HELP below for the flags that pre-fill answers (for a team: share one command line).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { parseArgs, parseEnv } from "node:util";
import { apiKeyFor, envPrefix, isSetUp, loadConfig, loadDotEnv, type Config } from "../src/config.ts";
import { OPENCODE_PROVIDER_ID, proxyURL } from "../src/opencode.ts";
import {
  ROOT,
  applyOpenCodeChange,
  checkToolCall,
  customBaseURLs,
  listModels,
  looksLikeGptOss,
  normalizeOpenWebUIURL,
  opencodeConfigDir,
  opencodeConfigFile,
  parseContext,
  parseJsonc,
  planOpenCodeChange,
  rankModels,
  updatedProxyConfig,
  writeSecret,
  type ModelInfo,
  type ModelList,
  type SetupProfile,
} from "../src/setup.ts";

const HELP = `Usage:
  npm run setup                 answer a few questions (about a minute)
  npm run setup -- [flags]      pre-fill answers; only what is missing is asked
  npm run doctor                check the current setup, change nothing

Where the model comes from (pick one):
  --openwebui <address>   an OpenWebUI server, e.g. http://gpu-server:8080
  --url <address>         any other OpenAI-compatible server (vLLM, Ollama, llama.cpp, ...)
  --siliconflow           SiliconFlow's hosted API

Answers:
  --model <id>            the model id on that server
  --context <tokens>      context window, e.g. 32768 or 64k
  --key-file <file>       read the API key from this file instead of asking
  --no-num-ctx            OpenWebUI: the server already uses this context, do not request it

What to change:
  --no-plugin             do not let OpenCode start the proxy; run "npm start" yourself
  --no-opencode           leave OpenCode's config alone
  --no-check              skip the test request
  --yes, -y               no questions: use the flags, saved key and defaults

Share one command with your team; each person is then asked only for their own key:
  npm run setup -- --openwebui http://gpu-server:8080 --model gpt-oss20b-opencode --context 65536`;

const { values: args } = parseArgs({
  options: {
    openwebui: { type: "string" },
    url: { type: "string" },
    siliconflow: { type: "boolean" },
    model: { type: "string" },
    context: { type: "string" },
    "key-file": { type: "string" },
    "no-num-ctx": { type: "boolean" },
    "no-plugin": { type: "boolean" },
    "no-opencode": { type: "boolean" },
    "no-check": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    doctor: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

// ---- Terminal ----

const color = process.stdout.isTTY && process.stdout.hasColors?.();
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);
const ok = (s: string) => console.log(`  ${green("ok")}  ${s}`);
const bad = (s: string) => console.log(`  ${red("failed")}  ${s}`);
const note = (s: string) => console.log(`  ${yellow("note")}  ${s}`);
const info = (s: string) => console.log(`  ${dim(s)}`);

class Cancelled extends Error {}

/** Questions: a terminal gets prompts (keys hidden); piped input is read line by line. */
class Prompter {
  readonly interactive: boolean;
  private tty = !!process.stdin.isTTY;
  private lines: string[] = [];
  private waiting: ((l: string | undefined) => void)[] = [];
  private ended = false;

  constructor(interactive: boolean) {
    this.interactive = interactive;
    if (!this.tty && interactive) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (l) => (this.waiting.length ? this.waiting.shift()!(l) : this.lines.push(l)));
      rl.on("close", () => {
        this.ended = true;
        for (const w of this.waiting.splice(0)) w(undefined);
      });
    }
  }

  private nextPiped(): Promise<string | undefined> {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((res) => this.waiting.push(res));
  }

  async ask(question: string, def = ""): Promise<string> {
    if (!this.interactive) return def;
    const q = `  ${question}${def ? dim(` [${def}]`) : ""}: `;
    if (!this.tty) {
      process.stdout.write(q);
      const l = await this.nextPiped();
      if (l === undefined) throw new Cancelled("input ended");
      process.stdout.write("\n");
      return l.trim() || def;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(130);
    });
    const answer = await new Promise<string>((res) => rl.question(q, res));
    rl.close();
    return answer.trim() || def;
  }

  async yes(question: string, def: boolean): Promise<boolean> {
    const a = (await this.ask(`${question} ${def ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
    return a ? a.startsWith("y") : def;
  }

  /** Reads a secret without echoing it (shows * per character). */
  async secret(question: string): Promise<string> {
    if (!this.interactive) return "";
    const q = `  ${question}: `;
    if (!this.tty) {
      process.stdout.write(q);
      const l = await this.nextPiped();
      process.stdout.write("\n");
      return (l ?? "").trim();
    }
    process.stdout.write(q);
    return new Promise((resolve) => {
      let value = "";
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write("\n");
            resolve(value.trim());
            return;
          }
          if (ch === "\u0003") {
            process.stdout.write("\n");
            process.exit(130);
          }
          if (ch === "\u007f" || ch === "\b") {
            if (value) {
              value = value.slice(0, -1);
              process.stdout.write("\b \b");
            }
          } else if (ch >= " ") {
            value += ch;
            process.stdout.write("*");
          }
        }
      };
      stdin.on("data", onData);
    });
  }
}

/** Stops with a message (thrown, so cleanup in `finally` blocks still runs). */
class Stop extends Error {}
function fail(message: string): never {
  throw new Stop(message);
}

// ---- Setup ----

const PROFILE_FOR: Record<SetupProfile, { title: string; keyEnv: string; keyHelp: string; keyRequired: boolean }> = {
  openwebui: { title: "OpenWebUI", keyEnv: "OPENWEBUI_API_KEY", keyHelp: "OpenWebUI > Settings > Account > API keys", keyRequired: true },
  custom: { title: "OpenAI-compatible server", keyEnv: "CUSTOM_API_KEY", keyHelp: "press Enter if the server needs none", keyRequired: false },
  siliconflow: { title: "SiliconFlow", keyEnv: "SILICONFLOW_API_KEY", keyHelp: "cloud.siliconflow.com > API Keys", keyRequired: true },
};

// The config file (GPT_OSS_CONFIG, as for the proxy) and the key files next to it.
const CONFIG_FILE = process.env.GPT_OSS_CONFIG ? path.resolve(process.env.GPT_OSS_CONFIG) : path.join(ROOT, "gpt-oss-proxy.config.json");
const KEY_DIR = path.dirname(CONFIG_FILE);
const keyFileName = (profile: string) => `${profile}.key`;

/** Environment variables (shell or .env) that would override what setup writes to the config file. */
function overridingVars(profile: string): string[] {
  const prefix = `${profile.toUpperCase()}_`;
  const names = ["BASE_URL", "MODEL", "STRATEGY", "ROUTE", "NUM_CTX", "CONTEXT_WINDOW", "API_KEY"].map((n) => prefix + n);
  const found = names.filter((n) => process.env[n]).map((n) => `${n} (environment)`);
  const dotenv = path.join(ROOT, ".env");
  if (fs.existsSync(dotenv)) {
    const parsed = parseEnv(fs.readFileSync(dotenv, "utf8")) as Record<string, string>;
    for (const n of names) if (parsed[n] && !process.env[n]) found.push(`${n} (.env)`);
  }
  if (process.env.GPT_OSS_STRATEGY) found.push("GPT_OSS_STRATEGY (environment)");
  return found;
}

async function chooseProfile(ui: Prompter): Promise<SetupProfile> {
  const given = [args.openwebui && "openwebui", args.url && "custom", args.siliconflow && "siliconflow"].filter(Boolean) as SetupProfile[];
  if (given.length > 1) fail("use only one of --openwebui, --url and --siliconflow.");
  if (given.length === 1) return given[0];
  if (!ui.interactive) fail("say where the model comes from: --openwebui <address>, --url <address> or --siliconflow.");
  console.log(`\n${bold("Where does your GPT-OSS model come from?")}`);
  console.log("    1) An OpenWebUI server (company or self-hosted)");
  console.log("    2) Another OpenAI-compatible server (vLLM, Ollama, llama.cpp, LM Studio, a hosted API)");
  console.log("    3) SiliconFlow (hosted)");
  for (;;) {
    const a = await ui.ask("Choose 1, 2 or 3", "1");
    const pick = ({ "1": "openwebui", "2": "custom", "3": "siliconflow" } as Record<string, SetupProfile>)[a];
    if (pick) return pick;
  }
}

async function askAddress(ui: Prompter, profile: SetupProfile, current?: string): Promise<string> {
  if (profile === "siliconflow") return "https://api.siliconflow.com/v1";
  const q = profile === "openwebui" ? "OpenWebUI address (the one you open in the browser, e.g. http://gpu-server:8080)" : "Server address (e.g. http://gpu-box:8000/v1)";
  for (;;) {
    const a = await ui.ask(q, current ?? "");
    if (a) return a;
    if (!ui.interactive) fail(`the server address is missing (--${profile === "openwebui" ? "openwebui" : "url"} <address>).`);
  }
}

async function askKey(ui: Prompter, profile: SetupProfile, retry: boolean): Promise<{ key: string; source: string }> {
  const p = PROFILE_FOR[profile];
  if (!retry) {
    if (args["key-file"]) {
      const f = path.resolve(args["key-file"]);
      if (!fs.existsSync(f)) fail(`--key-file ${f} does not exist.`);
      return { key: fs.readFileSync(f, "utf8").trim(), source: f };
    }
    const saved = path.join(KEY_DIR, keyFileName(profile));
    if (fs.existsSync(saved)) {
      const key = fs.readFileSync(saved, "utf8").trim();
      if (key && (!ui.interactive || (await ui.yes(`Use the API key saved in ${keyFileName(profile)}?`, true)))) return { key, source: keyFileName(profile) };
    }
    const fromEnv = process.env[p.keyEnv];
    if (fromEnv && (!ui.interactive || (await ui.yes(`Use the API key from ${p.keyEnv}?`, true)))) return { key: fromEnv.trim(), source: p.keyEnv };
  }
  if (!ui.interactive) {
    if (p.keyRequired) fail(`no API key: pass --key-file <file>, set ${p.keyEnv}, or run without --yes to type it.`);
    return { key: "", source: "none" };
  }
  for (;;) {
    const key = await ui.secret(`API key (${p.keyHelp}; input is hidden)`);
    if (key || !p.keyRequired) return { key, source: "typed" };
  }
}

async function findModels(ui: Prompter, profile: SetupProfile, address: string, key: string): Promise<{ list: Extract<ModelList, { ok: true }>; baseURL: string }> {
  if (profile === "openwebui") {
    const baseURL = normalizeOpenWebUIURL(address);
    const list = await listModels(`${baseURL.replace(/\/api$/, "")}/api/models`, key);
    if (!list.ok) throw Object.assign(new Error(list.error), { status: list.status });
    return { list, baseURL };
  }
  const candidates = profile === "siliconflow" ? [address] : customBaseURLs(address);
  let last: ModelList | undefined;
  for (const baseURL of candidates) {
    const list = await listModels(`${baseURL}/models`, key);
    if (list.ok) return { list, baseURL };
    last = list;
    if (list.status === 401 || list.status === 403) break;
  }
  const err = last as Extract<ModelList, { ok: false }>;
  throw Object.assign(new Error(err.error), { status: err.status });
}

async function chooseModel(ui: Prompter, models: ModelInfo[], given?: string): Promise<string> {
  const ranked = rankModels(models);
  if (given) {
    if (!models.length || models.some((m) => m.id === given)) return given;
    const close = ranked.filter(looksLikeGptOss).map((m) => m.id);
    if (!ui.interactive) fail(`the server has no model "${given}".${close.length ? ` GPT-OSS models it has: ${close.join(", ")}` : ""}`);
    note(`the server has no model "${given}"; pick one from the list.`);
  }
  if (!ranked.length) {
    if (!ui.interactive) fail("the server lists no models; pass --model <id>.");
    return ui.ask("The server lists no models. Model id");
  }
  const gptoss = ranked.filter(looksLikeGptOss);
  if (!ui.interactive) {
    if (gptoss.length === 1) return gptoss[0].id;
    fail(gptoss.length ? `several GPT-OSS models (${gptoss.map((m) => m.id).join(", ")}); pass --model <id>.` : "no GPT-OSS model on the server; pass --model <id>.");
  }
  console.log(`\n${bold("Which model?")}${gptoss.length ? dim(` (${gptoss.length} GPT-OSS model${gptoss.length > 1 ? "s" : ""} listed first)`) : ""}`);
  const shown = ranked.slice(0, 40);
  shown.forEach((m, i) => console.log(`    ${String(i + 1).padStart(2)}) ${m.id}${m.name ? dim(`  ${m.name}`) : ""}${looksLikeGptOss(m) ? "" : dim("  (not GPT-OSS)")}`));
  if (ranked.length > shown.length) info(`... and ${ranked.length - shown.length} more; type an id to use one of them`);
  for (;;) {
    const a = await ui.ask("Number or model id", "1");
    const n = Number(a);
    const id = Number.isInteger(n) && n >= 1 && n <= shown.length ? shown[n - 1].id : models.find((m) => m.id === a)?.id;
    if (id) {
      if (!looksLikeGptOss({ id })) note("this proxy is built for gpt-oss-20b and gpt-oss-120b; other models may not call tools correctly.");
      return id;
    }
  }
}

async function chooseContext(ui: Prompter, profile: SetupProfile): Promise<number | undefined> {
  if (profile === "siliconflow") return undefined;
  if (args.context) {
    const n = parseContext(args.context);
    if (!n || n < 8192) fail(`--context ${args.context}: give a number of tokens of at least 8192, e.g. 32768 or 64k.`);
    return n;
  }
  if (!ui.interactive) return 32768;
  console.log("");
  if (profile === "openwebui" && !args["no-num-ctx"]) {
    info("The proxy asks the server for this context on every request, so it works without access to the server's settings.");
    info("32768 is enough for most tasks; 65536 allows longer sessions if the server's GPU has the memory.");
  } else {
    info("Use the context length the server is configured with (too large a value makes the server cut long conversations).");
  }
  for (;;) {
    const n = parseContext(await ui.ask("Context window in tokens", "32768"));
    if (n && n >= 8192) {
      if (n < 32768) note("below 32768 OpenCode's own instructions and tools take a large share of the window.");
      return n;
    }
    note("give a number of tokens of at least 8192, e.g. 32768 or 64k.");
  }
}

/** Loads the config the way the plugin will, but from the given file, ignoring this profile's variables. */
function configFrom(file: string, profile: string): Config {
  const prefix = `${profile.toUpperCase()}_`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith(prefix) && k !== "GPT_OSS_CONFIG" && k !== "GPT_OSS_STRATEGY"));
  return loadConfig({ ...env, GPT_OSS_CONFIG: file }, ROOT);
}

function printCheck(r: Awaited<ReturnType<typeof checkToolCall>>) {
  const how = [r.route && `route ${r.route}`, r.strategy && `tool calls: ${r.strategy}`].filter(Boolean).join(", ");
  const time = `${(r.ms / 1000).toFixed(1)} s`;
  if (r.ok && !r.warning) ok(`tool call works (${time}${how ? `; ${how}` : ""}): ${r.detail}`);
  else if (r.ok) note(`the server answers (${time}${how ? `; ${how}` : ""}), but ${r.detail}. Usually fine; if OpenCode does not use tools, run "npm run doctor".`);
  else bad(`${r.detail} (${time})`);
}

async function setup() {
  const ui = new Prompter(!args.yes);
  console.log(`${bold("gpt-oss-opencode setup")} ${dim("connects OpenCode to your GPT-OSS server. Nothing is written until the end; Ctrl+C cancels.")}`);

  const profile = await chooseProfile(ui);
  const meta = PROFILE_FOR[profile];
  console.log(`\n${bold(meta.title)}`);
  let address = await askAddress(ui, profile, args.openwebui ?? args.url);
  let { key, source: keySource } = await askKey(ui, profile, false);

  // Address and key: retry until the server lists its models.
  let found: Awaited<ReturnType<typeof findModels>>;
  for (;;) {
    info(`connecting to ${profile === "openwebui" ? normalizeOpenWebUIURL(address).replace(/\/api$/, "") : address} ...`);
    try {
      found = await findModels(ui, profile, address, key);
      ok(`connected: ${found.list.models.length} model${found.list.models.length === 1 ? "" : "s"} available to this key`);
      break;
    } catch (e) {
      bad((e as Error).message);
      if (!ui.interactive) fail("fix the address or key and run setup again.");
      const status = (e as any).status;
      if (status === 401 || status === 403) ({ key, source: keySource } = await askKey(ui, profile, true));
      else address = await askAddress(ui, profile, address);
    }
  }

  const model = await chooseModel(ui, found.list.models, args.model);
  const context = await chooseContext(ui, profile);
  const numCtx = profile === "openwebui" && !args["no-num-ctx"];
  const ocPlan = args["no-opencode"] ? undefined : await planOpenCode(ui);

  // Build the configuration in a scratch folder and test it with the real proxy code.
  const configFile = CONFIG_FILE;
  let existing: any = {};
  if (fs.existsSync(configFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch (e) {
      fail(`${configFile} is not valid JSON (${(e as Error).message}); fix or delete it and run setup again.`);
    }
  }
  const keyFile = key ? keyFileName(profile) : undefined;
  const next = updatedProxyConfig(existing, { profile, baseURL: profile === "siliconflow" ? undefined : found.baseURL, model, context, numCtx, keyFile });

  // Test the new configuration with the real proxy code before writing anything. The key
  // stays in memory: it is handed to the proxy through its variable for this one request.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-oss-setup-"));
  const savedKeyVar = process.env[meta.keyEnv];
  let check: Awaited<ReturnType<typeof checkToolCall>> | undefined;
  try {
    fs.writeFileSync(path.join(scratch, "config.json"), JSON.stringify(next));
    let cfg: Config;
    try {
      cfg = configFrom(path.join(scratch, "config.json"), profile);
    } catch (e) {
      fail(`the resulting configuration is invalid: ${(e as Error).message}`);
    }
    const p = cfg.profiles[profile];
    console.log(`\n${bold("Checking")} ${dim(`${model}, context ${p.contextWindow}${numCtx ? " (requested per request)" : ""}`)}`);
    if (args["no-check"]) info("skipped (--no-check)");
    else {
      info("sending a real task through the proxy; the first answer can take a minute while the server loads the model ...");
      process.env[meta.keyEnv] = key;
      check = await checkToolCall(cfg, profile, { workdir: ROOT });
      printCheck(check);
    }
  } finally {
    if (savedKeyVar === undefined) delete process.env[meta.keyEnv];
    else process.env[meta.keyEnv] = savedKeyVar;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (check && !check.ok && !(ui.interactive && (await ui.yes("Save this configuration anyway?", false)))) {
    fail("nothing was written. Fix the problem above and run setup again (or add --no-check to save without testing).");
  }

  console.log(`\n${bold("Saving")}`);
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n");
  ok(`${configFile} ${dim("(no secrets in it)")}`);
  if (keyFile) {
    writeSecret(path.join(KEY_DIR, keyFile), key);
    ok(`${path.join(KEY_DIR, keyFile)} ${dim(`(your API key${keySource === "typed" ? "" : `, from ${keySource}`}; git-ignored)`)}`);
    if (savedKeyVar && savedKeyVar.trim() !== key) note(`${meta.keyEnv} is set in your environment with a different key, and it takes priority over ${keyFile}. Remove it or update it.`);
  }

  if (!ocPlan) info("OpenCode's config left alone (--no-opencode)");
  else configureOpenCode(configFrom(configFile, profile), profile, ocPlan);

  const others = overridingVars(profile).filter((v) => !(v.startsWith(meta.keyEnv) && process.env[meta.keyEnv]?.trim() === key));
  if (others.length) note(`these variables override the config file and may undo this setup: ${others.join(", ")}. Remove them unless you want them.`);

  const usePlugin = !args["no-plugin"] && !args["no-opencode"];
  console.log(`\n${green(bold("Ready."))} In your project folder run: ${bold("opencode")}`);
  if (!usePlugin) console.log(`  Start the proxy first, in ${ROOT}: ${bold("npm start")}`);
  else info("OpenCode starts the proxy itself; no second terminal needed.");
  info(`Model: ${OPENCODE_PROVIDER_ID}/${profile} (switch with /models). Check the setup any time: npm run doctor`);
  if (profile !== "siliconflow") {
    const flag = profile === "openwebui" ? `--openwebui ${found.baseURL.replace(/\/api$/, "")}` : `--url ${found.baseURL}`;
    const ctx = context ? ` --context ${context}` : "";
    console.log(`\n  Share with your team ${dim("(each person is asked only for their own API key):")}`);
    console.log(`    npm run setup -- ${flag} --model ${model}${ctx}${numCtx || profile !== "openwebui" ? "" : " --no-num-ctx"}`);
  }
}

interface OpenCodePlan {
  file: string;
  current: any;
  /** Why the file cannot be edited, if it cannot. */
  error?: string;
  makeDefault: boolean;
}

/** Reads OpenCode's config and asks the one question about it, before anything is written. */
async function planOpenCode(ui: Prompter): Promise<OpenCodePlan> {
  const file = opencodeConfigFile(opencodeConfigDir());
  let current: any = {};
  if (fs.existsSync(file)) {
    try {
      current = parseJsonc(fs.readFileSync(file, "utf8"));
    } catch (e) {
      return { file, current, error: (e as Error).message, makeDefault: false };
    }
  }
  let makeDefault = true;
  if (current.model && !String(current.model).startsWith(`${OPENCODE_PROVIDER_ID}/`)) {
    console.log("");
    makeDefault = await ui.yes(`Make GPT-OSS your default model in OpenCode (now ${current.model})?`, true);
  }
  return { file, current, makeDefault };
}

function configureOpenCode(cfg: Config, profile: string, plan: OpenCodePlan) {
  const { file, current, makeDefault } = plan;
  if (plan.error) {
    bad(`OpenCode config ${file} could not be read (${plan.error}); left unchanged. Fix it and run setup again.`);
    return;
  }
  const modelId = `${OPENCODE_PROVIDER_ID}/${profile}`;
  const change = planOpenCodeChange(current, { cfg, profile, plugin: !args["no-plugin"], makeDefault });
  try {
    const { backup } = applyOpenCodeChange(file, change);
    if (!change.notes.length) ok(`${file} ${dim("(already set up)")}`);
    else {
      ok(`${file}${backup ? dim(` (backup: ${path.basename(backup)})`) : ""}`);
      for (const n of change.notes) info(`  ${n}`);
    }
  } catch (e) {
    bad(`${(e as Error).message}. Add this to ${file} yourself: ${JSON.stringify(change.set)}`);
  }
  if (!makeDefault) info(`OpenCode keeps ${current.model} as default; pick GPT-OSS with /models or: opencode -m ${modelId}`);
  if (process.env.OPENCODE_CONFIG) note(`OPENCODE_CONFIG=${process.env.OPENCODE_CONFIG} is set; settings in that file override ${file}.`);
}

// ---- Doctor ----

async function doctor() {
  console.log(`${bold("gpt-oss-opencode doctor")} ${dim("checks the setup the way OpenCode will use it; nothing is changed.")}\n`);
  let problems = 0;
  const dotenv = loadDotEnv(ROOT);
  let cfg: Config;
  try {
    cfg = loadConfig(process.env, ROOT);
  } catch (e) {
    bad(`configuration: ${(e as Error).message}`);
    fail('fix it, or run "npm run setup" to write a new one.');
  }
  info(`config file: ${cfg.configFile ?? "none (built-in defaults and environment variables only)"}${dotenv ? `; .env: ${dotenv}` : ""}`);

  // OpenCode's side.
  const ocFile = opencodeConfigFile(opencodeConfigDir());
  let oc: any = {};
  if (fs.existsSync(ocFile)) {
    try {
      oc = parseJsonc(fs.readFileSync(ocFile, "utf8"));
    } catch (e) {
      bad(`OpenCode config ${ocFile}: ${(e as Error).message}`);
      problems++;
    }
  }
  const plugin = (oc.plugin ?? []).find((p: unknown) => typeof p === "string" && /opencode\/plugin\/gpt-oss-proxy\.ts$/.test(p));
  const staticBlock = oc.provider?.[OPENCODE_PROVIDER_ID];
  if (!fs.existsSync(ocFile)) {
    bad(`no OpenCode config at ${ocFile}; run "npm run setup".`);
    problems++;
  } else if (plugin) {
    const pluginPath = decodeURIComponent(new URL(plugin).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    if (!fs.existsSync(pluginPath)) {
      bad(`OpenCode loads the plugin from ${pluginPath}, which does not exist (moved folder?); run "npm run setup" again.`);
      problems++;
    } else ok(`OpenCode starts the proxy (plugin in ${ocFile})`);
  } else if (staticBlock) {
    const up = await fetch(`${proxyURL(cfg).replace(/\/v1$/, "")}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
    if (up) ok(`OpenCode uses a proxy you start yourself; it is running at ${proxyURL(cfg)}`);
    else note(`OpenCode expects a proxy at ${staticBlock.options?.baseURL ?? proxyURL(cfg)}, which is not running: start it with "npm start" (or run setup to let OpenCode start it).`);
    for (const [id, m] of Object.entries<any>(staticBlock.models ?? {})) {
      const p = cfg.profiles[id];
      if (p && isSetUp(p) && m?.limit?.context && m.limit.context !== p.contextWindow) {
        note(`OpenCode's limit.context for ${id} is ${m.limit.context}, the proxy's window is ${p.contextWindow}: set both to the same value.`);
      }
    }
  } else {
    bad(`OpenCode is not connected to the proxy (${ocFile} has neither the plugin nor a "${OPENCODE_PROVIDER_ID}" provider); run "npm run setup".`);
    problems++;
  }
  const ocModel = String(oc.model ?? "");
  const profileName = ocModel.startsWith(`${OPENCODE_PROVIDER_ID}/`) ? ocModel.slice(OPENCODE_PROVIDER_ID.length + 1) : cfg.defaultProfile;
  if (ocModel && !ocModel.startsWith(`${OPENCODE_PROVIDER_ID}/`)) info(`OpenCode's default model is ${ocModel}; GPT-OSS is used when you pick it (/models).`);
  if (process.env.OPENCODE_CONFIG) note(`OPENCODE_CONFIG=${process.env.OPENCODE_CONFIG} is set; settings in that file override ${ocFile}.`);

  // The proxy's side.
  const p = cfg.profiles[profileName];
  if (!p) fail(`OpenCode uses ${ocModel}, but the proxy has no profile "${profileName}" (it has: ${Object.keys(cfg.profiles).join(", ")}).`);
  console.log(`\n${bold(`Profile "${p.name}"`)} ${dim(`(${ocModel ? "OpenCode's default model" : "the proxy's default profile"})`)}`);
  if (!isSetUp(p)) fail(`not set up yet (no ${p.baseURL ? "API key" : "address"}); run "npm run setup".`);
  const keySource = p.apiKeyEnv && process.env[p.apiKeyEnv] ? `${p.apiKeyEnv}` : p.apiKeyFile && fs.existsSync(p.apiKeyFile) ? path.relative(ROOT, p.apiKeyFile) : "none";
  info(`address ${p.baseURL}, model ${p.model}, window ${p.contextWindow}${p.numCtx ? ` (num_ctx ${p.numCtx} requested per request)` : ""}, key from ${keySource}`);
  const over = overridingVars(p.name);
  if (over.length) info(`set by environment: ${over.join(", ")}`);
  if (p.apiKeyFile && !fs.existsSync(p.apiKeyFile) && !(p.apiKeyEnv && process.env[p.apiKeyEnv])) {
    bad(`the key file ${p.apiKeyFile} does not exist; run "npm run setup".`);
    problems++;
  }
  const modelsURL = p.kind === "openwebui" ? `${normalizeOpenWebUIURL(p.baseURL).replace(/\/api$/, "")}/api/models` : `${p.baseURL}/models`;
  const list = await listModels(modelsURL, apiKeyFor(p));
  if (!list.ok) {
    bad(list.error);
    problems++;
  } else if (list.models.length && !list.models.some((m) => m.id === p.model)) {
    bad(`the server has no model "${p.model}". GPT-OSS models it has: ${rankModels(list.models).filter(looksLikeGptOss).map((m) => m.id).join(", ") || "none"}`);
    problems++;
  } else {
    ok(`server reachable, key accepted, model ${p.model} listed`);
    info("sending a real task through the proxy; the first answer can take a minute while the server loads the model ...");
    const r = await checkToolCall(cfg, p.name, { workdir: ROOT });
    printCheck(r);
    if (!r.ok) problems++;
  }
  console.log(problems ? `\n${red(`${problems} problem${problems > 1 ? "s" : ""} found.`)}` : `\n${green(bold("All good."))} Run ${bold("opencode")} in your project.`);
  process.exitCode = problems ? 1 : 0;
}

if (args.help) console.log(HELP);
else {
  try {
    await (args.doctor ? doctor() : setup());
  } catch (e) {
    if (!(e instanceof Stop || e instanceof Cancelled)) throw e;
    const message = e instanceof Cancelled ? "input ended before setup was complete." : e.message;
    console.log(`\n${red(args.doctor ? "Doctor stopped:" : "Setup stopped:")} ${message}`);
    process.exitCode = 1;
  }
}
