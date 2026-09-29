// Local replica of the user's production layering for contract testing:
//   gpt-oss-proxy -> OpenWebUI (real, pinned version) -> Ollama (real) -> small tool-capable model
// gpt-oss:20b does not fit this machine, so a small model stands in; the point is
// to exercise OpenWebUI's real request/response handling (tools, streaming,
// reasoning, errors). Everything lives in .local-stack/ (git-ignored).
//
//   node scripts/owui-local-stack.mjs up [--model qwen3:1.7b] [--ctx 16384]
//   node scripts/owui-local-stack.mjs status
//   node scripts/owui-local-stack.mjs down
//
// Writes .local-stack/stack.json ({ owuiUrl, apiKey, model, presetId, ollamaUrl, pids }).
// The API key is only stored there; it is never printed.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const STACK = path.join(ROOT, ".local-stack");
const STATE = path.join(STACK, "stack.json");
const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const MODEL = opt("model", "qwen3:1.7b");
const CTX = opt("ctx", "16384");
const OLLAMA_PORT = 11435;
const OWUI_PORT = 8081;
const ollamaUrl = `http://127.0.0.1:${OLLAMA_PORT}`;
const owuiUrl = `http://127.0.0.1:${OWUI_PORT}`;
const PRESET = "gpt-oss20b-opencode";

const readState = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {});
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, what, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error(`${what} did not come up at ${url} within ${timeoutMs / 1000}s (see .local-stack/logs)`);
}

function startDetached(exe, argv, env, logName) {
  fs.mkdirSync(path.join(STACK, "logs"), { recursive: true });
  const out = fs.openSync(path.join(STACK, "logs", logName), "a");
  const child = spawn(exe, argv, { env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true, windowsHide: true });
  child.unref();
  return child.pid;
}

async function up() {
  const state = readState();
  // 1. Ollama
  let ollamaUp = false;
  try {
    ollamaUp = (await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {}
  if (!ollamaUp) {
    state.ollamaPid = startDetached(path.join(STACK, "ollama", "ollama.exe"), ["serve"], {
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_MODELS: path.join(STACK, "models"),
      OLLAMA_CONTEXT_LENGTH: CTX,
    }, "ollama.log");
    await waitFor(`${ollamaUrl}/api/version`, "Ollama", 120_000);
  }
  console.log(`ollama: ${(await (await fetch(`${ollamaUrl}/api/version`)).json()).version} at ${ollamaUrl} (context ${CTX})`);
  const tags = await (await fetch(`${ollamaUrl}/api/tags`)).json();
  if (!tags.models?.some((m) => m.name === MODEL)) {
    console.log(`pulling ${MODEL} ...`);
    const r = await fetch(`${ollamaUrl}/api/pull`, { method: "POST", body: JSON.stringify({ model: MODEL, stream: false }) });
    const j = await r.json();
    if (j.status !== "success") throw new Error(`pull failed: ${JSON.stringify(j)}`);
  }
  // 2. OpenWebUI
  let owuiUp = false;
  try {
    owuiUp = (await fetch(`${owuiUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {}
  if (!owuiUp) {
    state.secret ??= crypto.randomBytes(24).toString("hex");
    state.owuiPid = startDetached(path.join(STACK, "bin", "open-webui.exe"), ["serve", "--host", "127.0.0.1", "--port", String(OWUI_PORT)], {
      DATA_DIR: path.join(STACK, "owui-data"),
      OLLAMA_BASE_URL: ollamaUrl,
      ENABLE_OPENAI_API: "False",
      ENABLE_API_KEYS: "True",
      WEBUI_SECRET_KEY: state.secret,
      OFFLINE_MODE: "True",
      BYPASS_EMBEDDING_AND_RETRIEVAL: "True",
      ENABLE_VERSION_UPDATE_CHECK: "False",
      ANONYMIZED_TELEMETRY: "False",
      DO_NOT_TRACK: "True",
      SCARF_NO_ANALYTICS: "true",
      PYTHONIOENCODING: "utf-8",
    }, "open-webui.log");
    await waitFor(`${owuiUrl}/health`, "OpenWebUI", 600_000);
  }
  const ver = await (await fetch(`${owuiUrl}/api/version`)).json().catch(() => ({}));
  console.log(`open-webui: ${ver.version ?? "?"} at ${owuiUrl}`);
  // 3. Admin + API key (first signup becomes admin)
  if (!state.apiKey) {
    state.password ??= crypto.randomBytes(12).toString("hex");
    const creds = { email: "admin@local.test", password: state.password };
    let r = await fetch(`${owuiUrl}/api/v1/auths/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "admin", ...creds }) });
    if (!r.ok) r = await fetch(`${owuiUrl}/api/v1/auths/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(creds) });
    if (!r.ok) throw new Error(`signup/signin failed: HTTP ${r.status} ${await r.text()}`);
    const token = (await r.json()).token;
    const k = await fetch(`${owuiUrl}/api/v1/auths/api_key`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (!k.ok) throw new Error(`API key creation failed: HTTP ${k.status} ${await k.text()}`);
    state.apiKey = (await k.json()).api_key;
  }
  const auth = { authorization: `Bearer ${state.apiKey}`, "content-type": "application/json" };
  // 4. Model preset mirroring the user's "gpt-oss20b-opencode"
  const models = await (await fetch(`${owuiUrl}/api/models`, { headers: auth })).json();
  const ids = (models.data ?? []).map((m) => m.id);
  if (!ids.includes(MODEL)) throw new Error(`OpenWebUI does not list ${MODEL} (has: ${ids.join(", ")})`);
  if (!ids.includes(PRESET)) {
    const r = await fetch(`${owuiUrl}/api/v1/models/create`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: PRESET, base_model_id: MODEL, name: `${PRESET} (local stand-in: ${MODEL})`, meta: { description: "local contract-test preset" }, params: {} }),
    });
    if (!r.ok) throw new Error(`preset creation failed: HTTP ${r.status} ${await r.text()}`);
  }
  Object.assign(state, { owuiUrl, ollamaUrl, model: MODEL, presetId: PRESET, ctx: CTX });
  writeState(state);
  console.log(`ready: base URL ${owuiUrl}/api, models ${MODEL} and ${PRESET}; API key stored in .local-stack/stack.json`);
}

async function status() {
  const s = readState();
  for (const [name, url] of [["ollama", `${ollamaUrl}/api/version`], ["open-webui", `${owuiUrl}/health`]]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      console.log(`${name}: ${r.ok ? "up" : `HTTP ${r.status}`}`);
    } catch {
      console.log(`${name}: down`);
    }
  }
  console.log(`state: model=${s.model ?? "-"} preset=${s.presetId ?? "-"} apiKey=${s.apiKey ? "present" : "missing"}`);
}

function down() {
  const s = readState();
  for (const pid of [s.owuiPid, s.ollamaPid].filter(Boolean)) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      console.log(`stopped ${pid}`);
    } catch {
      console.log(`${pid} not running`);
    }
  }
  delete s.owuiPid;
  delete s.ollamaPid;
  writeState(s);
}

if (cmd === "up") await up();
else if (cmd === "down") down();
else await status();
