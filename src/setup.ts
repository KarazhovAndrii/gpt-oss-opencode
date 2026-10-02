// `npm run setup` / `npm run doctor`: the parts that can be tested without a terminal.
// Find the provider's models, prove a tool call works through the real proxy, write the
// proxy config + key file, and wire OpenCode up (plugin, default model) without losing
// the comments in the user's opencode.json(c).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Config } from "./config.ts";
import { Logger } from "./log.ts";
import { createServer } from "./server.ts";
import { owuiRoot } from "./openwebui.ts";
import { OPENCODE_PROVIDER_ID, opencodeProvider } from "./opencode.ts";

export type SetupProfile = "openwebui" | "custom" | "siliconflow";

// ---- Addresses and models ----

/** Accepts what people paste (host:port, the web UI address, an API URL) and returns `<root>/api`. */
export function normalizeOpenWebUIURL(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/[?#].*$/, "").replace(/\/+$/, "");
  u = u.replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
  return `${owuiRoot(u)}/api`;
}

/** Candidate base URLs for an OpenAI-compatible server: as given, and with /v1 when no path was given. */
export function customBaseURLs(input: string): string[] {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
  return new URL(u).pathname === "/" ? [`${u}/v1`, u] : [u];
}

export interface ModelInfo {
  id: string;
  name?: string;
  ownedBy?: string;
}

export type ModelList = { ok: true; url: string; models: ModelInfo[] } | { ok: false; url: string; error: string; status?: number };

/** Lists the models a key can use, with an explanation a person can act on when that fails. */
export async function listModels(modelsURL: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ModelList> {
  let r: Response;
  try {
    r = await fetchImpl(modelsURL, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    const err = e as any;
    const code = err?.cause?.code ?? err?.code ?? err?.name;
    const why = code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" ? "no answer within 15 s" : code === "ENOTFOUND" ? "unknown host name" : code === "ECONNREFUSED" ? "connection refused" : (err?.cause?.message ?? err?.message ?? String(e));
    return { ok: false, url: modelsURL, error: `Cannot reach ${modelsURL} (${why}). Check the address, and that this machine can reach the server (VPN, proxy, firewall).` };
  }
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = String(j?.detail?.message ?? j?.detail ?? j?.error?.message ?? j?.message ?? detail);
    } catch {
      // not JSON
    }
    let error = `HTTP ${r.status} from ${modelsURL}: ${detail}`;
    if (/API key is not enabled/i.test(detail)) error = `API keys are switched off on this OpenWebUI server. An admin has to enable them (Admin Panel > Settings > General > Enable API Keys) and give your user the API-keys permission.`;
    else if (r.status === 401) error = apiKey ? `The server rejected the API key (HTTP 401). Create a new key (OpenWebUI: Settings > Account > API keys) and paste it again.` : `The server needs an API key (HTTP 401).`;
    else if (r.status === 403) error = `HTTP 403 from ${modelsURL}: ${detail}. The key works but is not allowed to list models; ask the admin to allow /api/models for API keys.`;
    else if (r.status === 404) error = `Nothing at ${modelsURL} (HTTP 404). Is this the right address?`;
    return { ok: false, url: modelsURL, error, status: r.status };
  }
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, url: modelsURL, error: `${modelsURL} answered with ${/^\s*</.test(text) ? "a web page" : "something"} instead of a model list. Is this the API address (OpenWebUI: the address you open in the browser)?` };
  }
  const data: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const models = data.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name !== m.id ? m.name : undefined, ownedBy: m.owned_by }));
  return { ok: true, url: modelsURL, models };
}

export const looksLikeGptOss = (m: ModelInfo) => /gpt[-_ ]?oss/i.test(`${m.id} ${m.name ?? ""}`);

/** GPT-OSS models first (the ones that can work), then the rest, each group in server order. */
export function rankModels(models: ModelInfo[]): ModelInfo[] {
  return [...models.filter(looksLikeGptOss), ...models.filter((m) => !looksLikeGptOss(m))];
}

/** "65536", "64k", "64 K", "128000" -> tokens; undefined if not a number. */
export function parseContext(input: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(k)?\s*$/i.exec(input);
  if (!m) return undefined;
  const n = Math.round(Number(m[1]) * (m[2] ? 1024 : 1));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---- The end-to-end check ----

export interface CheckResult {
  ok: boolean;
  ms: number;
  /** What the model did, or why it failed (the proxy's own diagnostic when there is one). */
  detail: string;
  route?: string;
  strategy?: string;
  /** True when the model answered but did not call the tool: it works, but is worth a look. */
  warning?: boolean;
}

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "The absolute path to the file or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line number to start reading from (1-indexed)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines to read (defaults to 2000)" },
      },
      required: ["filePath"],
    },
  },
};

/**
 * Plays OpenCode for one step: sends a task with OpenCode's read tool through an in-process
 * proxy and expects a valid `read` call back. This covers the address, key, model id,
 * route and tool-call strategy in one go.
 */
export async function checkToolCall(cfg: Config, profileName: string, opts: { workdir?: string; fetchImpl?: typeof fetch } = {}): Promise<CheckResult> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-oss-setup-"));
  const server = createServer({ cfg: { ...cfg, logDir }, logger: new Logger(logDir, { quiet: true }), fetchImpl: opts.fetchImpl });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  const workdir = opts.workdir ?? process.cwd();
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "setup-check", ...(process.env.GPT_OSS_PROXY_TOKEN ? { authorization: `Bearer ${process.env.GPT_OSS_PROXY_TOKEN}` } : {}) },
      body: JSON.stringify({
        model: profileName,
        stream: false,
        tools: [READ_TOOL],
        messages: [
          { role: "system", content: `You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the tools available to you.\n<env>\n  Working directory: ${workdir}\n  Platform: ${process.platform}\n</env>` },
          { role: "user", content: "Read the file README.md in the working directory." },
        ],
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    const events = readEvents(logDir);
    const route = events.find((e) => e.type === "route")?.route;
    const fallback = events.find((e) => e.type === "strategy_fallback");
    const strategy = fallback ? `${fallback.to} (the server refused native tool calls)` : events.find((e) => e.type === "request" && e.strategy && e.strategy !== "plain")?.strategy;
    if (!r.ok) return { ok: false, ms, route, strategy, detail: j?.error?.message ?? `HTTP ${r.status}` };
    const msg = j?.choices?.[0]?.message ?? {};
    const call = msg.tool_calls?.[0];
    if (call?.function?.name === "read") return { ok: true, ms, route, strategy, detail: `the model called read ${call.function.arguments}` };
    const text = String(msg.content ?? "").trim();
    if (text.startsWith("[gpt-oss-proxy]")) return { ok: false, ms, route, strategy, detail: text.replace(/^\[gpt-oss-proxy\]\s*/, "") };
    return { ok: true, warning: true, ms, route, strategy, detail: `the model answered without calling the tool: "${text.slice(0, 160)}"` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((ok) => server.close(() => ok()));
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

function readEvents(dir: string): any[] {
  const out: any[] = [];
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

// ---- The proxy's config file ----

export interface ProfileAnswers {
  profile: SetupProfile;
  baseURL?: string;
  model?: string;
  /** Tokens. OpenWebUI with numCtx: requested from the server; otherwise the server's known window. */
  context?: number;
  /** OpenWebUI: send the context with every request (works without access to the server). */
  numCtx?: boolean;
  /** Key file, relative to the config file. */
  keyFile?: string;
}

const MANAGED = ["baseURL", "model", "contextWindow", "numCtx", "openwebuiRoute", "apiKeyFile"];

/** The new config file content: this profile set from the answers, everything else kept. */
export function updatedProxyConfig(existing: any, a: ProfileAnswers): any {
  const out = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  out.defaultProfile = a.profile;
  out.profiles = out.profiles && typeof out.profiles === "object" ? out.profiles : {};
  const kept = Object.fromEntries(Object.entries(out.profiles[a.profile] ?? {}).filter(([k]) => !MANAGED.includes(k)));
  const p: Record<string, unknown> = {};
  if (a.baseURL) p.baseURL = a.baseURL;
  if (a.model) p.model = a.model;
  if (a.context) {
    if (a.profile === "openwebui" && a.numCtx) p.numCtx = a.context;
    else p.contextWindow = a.context;
  }
  if (a.keyFile) p.apiKeyFile = a.keyFile;
  out.profiles[a.profile] = { ...p, ...kept };
  return out;
}

/** Writes a secret readable by the owner only (where the OS supports modes). */
export function writeSecret(file: string, value: string) {
  fs.writeFileSync(file, value.trim() + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: the user profile's ACLs apply
  }
}

// ---- OpenCode's config (JSONC: comments and trailing commas allowed) ----

function skipTrivia(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith("//", i)) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (s.startsWith("/*", i)) {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? s.length : e + 2;
    } else return i;
  }
}

function skipString(s: string, i: number): number {
  for (i++; i < s.length && s[i] !== '"'; i += s[i] === "\\" ? 2 : 1);
  if (i >= s.length) throw new Error("unterminated string");
  return i + 1;
}

function skipValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    i = skipTrivia(s, i + 1);
    while (s[i] !== close) {
      if (i >= s.length) throw new Error(`unterminated ${c}`);
      if (c === "{") {
        if (s[i] !== '"') throw new Error(`expected a key at offset ${i}`);
        i = skipTrivia(s, skipString(s, i));
        if (s[i] !== ":") throw new Error(`expected ":" at offset ${i}`);
        i = skipTrivia(s, i + 1);
      }
      i = skipTrivia(s, skipValue(s, i));
      if (s[i] === ",") i = skipTrivia(s, i + 1);
      else if (s[i] !== close) throw new Error(`expected "," or "${close}" at offset ${i}`);
    }
    return i + 1;
  }
  const m = /^(?:-?\d[\d.eE+-]*|true|false|null)/.exec(s.slice(i, i + 64));
  if (!m) throw new Error(`unexpected character at offset ${i}`);
  return i + m[0].length;
}

/** Parses JSON with comments and trailing commas, as OpenCode does. */
export function parseJsonc(text: string): any {
  const s = text.replace(/^﻿/, "");
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] === '"') {
      const e = skipString(s, i);
      out += s.slice(i, e);
      i = e;
    } else if (s.startsWith("//", i) || s.startsWith("/*", i)) {
      out += " ";
      i = skipTrivia(s, i);
    } else if (s[i] === ",") {
      const e = skipTrivia(s, i + 1);
      if (s[e] !== "}" && s[e] !== "]") out += ",";
      i++;
    } else out += s[i++];
  }
  return out.trim() ? JSON.parse(out) : {};
}

interface Member {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** After the member's comma, if it has one. */
  end: number;
  comma: boolean;
}

function topLevelMembers(s: string): { open: number; members: Member[] } {
  let i = skipTrivia(s, s.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (s[i] !== "{") throw new Error("the file does not contain a JSON object");
  const open = i;
  const members: Member[] = [];
  i = skipTrivia(s, i + 1);
  while (s[i] !== "}") {
    if (s[i] !== '"') throw new Error(`expected a key at offset ${i}`);
    const start = i;
    const keyEnd = skipString(s, i);
    const key = JSON.parse(s.slice(i, keyEnd));
    i = skipTrivia(s, keyEnd);
    if (s[i] !== ":") throw new Error(`expected ":" at offset ${i}`);
    const valueStart = skipTrivia(s, i + 1);
    const valueEnd = skipValue(s, valueStart);
    i = skipTrivia(s, valueEnd);
    const comma = s[i] === ",";
    const end = comma ? i + 1 : valueEnd;
    if (comma) i = skipTrivia(s, i + 1);
    else if (s[i] !== "}") throw new Error(`expected "," or "}" at offset ${i}`);
    members.push({ key, start, valueStart, valueEnd, end, comma });
  }
  return { open, members };
}

function indentAt(s: string, pos: number | undefined): string {
  if (pos === undefined) return "  ";
  const lineStart = s.lastIndexOf("\n", pos - 1) + 1;
  const lead = s.slice(lineStart, pos);
  return /^[ \t]+$/.test(lead) ? lead : "  ";
}

/**
 * Sets top-level keys of a JSONC document, changing only those values: comments, order
 * and formatting elsewhere stay as they were. New keys go after "$schema" (or first).
 */
export function setJsoncKeys(text: string, entries: Record<string, unknown>): string {
  let s = text.trim() ? text : "{\n}\n";
  // Each new key goes to the same place, so insert in reverse to keep the given order.
  for (const [key, value] of Object.entries(entries).reverse()) {
    const { open, members } = topLevelMembers(s);
    const indent = indentAt(s, members[0]?.start);
    const json = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
    const hit = members.find((m) => m.key === key);
    if (hit) {
      s = s.slice(0, hit.valueStart) + json + s.slice(hit.valueEnd);
      continue;
    }
    const line = `${indent}${JSON.stringify(key)}: ${json}`;
    const schema = members[0]?.key === "$schema" ? members[0] : undefined;
    if (schema && schema.comma) s = `${s.slice(0, schema.end)}\n${line},${s.slice(schema.end)}`;
    else if (schema) s = `${s.slice(0, schema.valueEnd)},\n${line}${s.slice(schema.valueEnd)}`;
    else if (members.length) s = `${s.slice(0, open + 1)}\n${line},${s.slice(open + 1)}`;
    else s = `${s.slice(0, open + 1)}\n${line}\n${s.slice(open + 1).replace(/^\s*\n/, "")}`;
  }
  return s;
}

/** OpenCode's global config directory (OpenCode uses XDG paths on every OS). */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode");
}

/** The global config file to edit: the .jsonc or .json that exists, else a new opencode.json. */
export function opencodeConfigFile(dir: string): string {
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return path.join(dir, "opencode.json");
}

/** The repository root, where the config file, key files and .env live. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_FILE = path.join(ROOT, "opencode", "plugin", "gpt-oss-proxy.ts");

export interface OpenCodeChange {
  /** Top-level keys to set, with their new values. */
  set: Record<string, unknown>;
  /** What changed, in words, for the summary. */
  notes: string[];
}

/**
 * What to change in OpenCode's config: the plugin (or, without it, a static provider block),
 * and the default model. `makeDefault` false keeps the user's current default model.
 */
export function planOpenCodeChange(current: any, opts: { cfg: Config; profile: string; plugin: boolean; makeDefault: boolean; pluginFile?: string }): OpenCodeChange {
  const set: Record<string, unknown> = {};
  const notes: string[] = [];
  const modelId = `${OPENCODE_PROVIDER_ID}/${opts.profile}`;
  if (opts.plugin) {
    const url = pathToFileURL(opts.pluginFile ?? PLUGIN_FILE).href;
    const plugins: unknown[] = Array.isArray(current.plugin) ? current.plugin : [];
    const others = plugins.filter((p) => !(typeof p === "string" && /opencode\/plugin\/gpt-oss-proxy\.ts$/.test(p)));
    const next = [...others, url];
    if (JSON.stringify(next) !== JSON.stringify(plugins)) {
      set.plugin = next;
      notes.push(`plugin: ${url} (OpenCode starts the proxy itself)`);
    }
    // The plugin registers the provider with limits from the proxy config; an old static
    // block would override them.
    if (current.provider?.[OPENCODE_PROVIDER_ID]) {
      const { [OPENCODE_PROVIDER_ID]: _old, ...rest } = current.provider;
      set.provider = rest;
      notes.push(`provider "${OPENCODE_PROVIDER_ID}": removed the static block (the plugin now registers it, with limits that match the proxy)`);
    }
  } else {
    const provider = opencodeProvider(opts.cfg, { token: process.env.GPT_OSS_PROXY_TOKEN });
    set.provider = { ...(current.provider ?? {}), [OPENCODE_PROVIDER_ID]: provider };
    notes.push(`provider "${OPENCODE_PROVIDER_ID}": ${Object.keys(provider.models).map((m) => `${m} (context ${(provider.models[m] as any).limit.context})`).join(", ")}`);
  }
  if (opts.makeDefault) {
    if (current.model !== modelId) {
      set.model = modelId;
      notes.push(`model: ${current.model ? `${current.model} -> ` : ""}${modelId}`);
    }
    // Without it OpenCode may send session titles (your first prompt) to another provider.
    if (current.small_model !== modelId) {
      set.small_model = modelId;
      notes.push(`small_model: ${current.small_model ? `${current.small_model} -> ` : ""}${modelId}`);
    }
  }
  return { set, notes };
}

/** Applies the change to the file (backing it up first) and checks the result reads back as intended. */
export function applyOpenCodeChange(file: string, change: OpenCodeChange): { backup?: string } {
  if (!Object.keys(change.set).length) return {};
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const after = setJsoncKeys(before || `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`, change.set);
  const parsed = parseJsonc(after);
  for (const [k, v] of Object.entries(change.set)) {
    if (JSON.stringify(parsed[k]) !== JSON.stringify(v)) throw new Error(`could not update "${k}" in ${file} safely; nothing was changed`);
  }
  let backup: string | undefined;
  if (before) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return { backup };
}
