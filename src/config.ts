// Configuration: provider profiles + reliability limits.
//
// Sources, later wins: built-in defaults < JSON config file < environment.
//   GPT_OSS_CONFIG           path to a JSON config file (default ./gpt-oss-proxy.config.json if present)
//   GPT_OSS_PROFILE          default profile name
//   GPT_OSS_PORT / GPT_OSS_HOST
//   GPT_OSS_STRATEGY         override the strategy of every profile (native|harmony|json|auto)
//   GPT_OSS_LOG_DIR          directory for JSONL diagnostics
//   GPT_OSS_LOG_CONTENT      1 = also log prompts, model output, tool arguments and result previews
//   GPT_OSS_LOG_RETENTION_DAYS  delete log days older than this at startup and daily (0 = keep)
//   <PROFILE>_BASE_URL / <PROFILE>_MODEL   e.g. OPENWEBUI_BASE_URL, SILICONFLOW_MODEL
//   <PROFILE>_CONTEXT_WINDOW  the model server's real context length (tokens)

import fs from "node:fs";
import path from "node:path";

export type Strategy = "native" | "harmony" | "json" | "auto";

export interface Profile {
  name: string;
  /** "openwebui" enables OpenWebUI route selection and payload fixes (src/openwebui.ts). */
  kind?: "openai-compatible" | "openwebui";
  baseURL: string;
  /** OpenWebUI only: "auto" (by owned_by), "api" (/api/chat/completions) or "ollama-v1" (/ollama/v1 passthrough). */
  openwebuiRoute?: "auto" | "api" | "ollama-v1";
  /** OpenWebUI route "api" only: Ollama num_ctx sent per request (options.num_ctx). */
  numCtx?: number;
  model: string;
  /** Environment variable holding the API key (never logged). */
  apiKeyEnv?: string;
  /** Optional file holding the API key, read at request time (never logged). */
  apiKeyFile?: string;
  /** native: provider function calling; harmony: raw harmony emulation; json: JSON-envelope emulation; auto: native, falling back when unsupported. */
  strategy: Strategy;
  /** Strategy used by `auto` when native tool calling is rejected. */
  fallbackStrategy: Exclude<Strategy, "auto" | "native">;
  maxOutputTokens: number;
  contextWindow: number;
  /** "compact" shortens the longest built-in OpenCode tool descriptions (schemas untouched). */
  toolDescriptions?: "full" | "compact";
  /** USD per 1M tokens. */
  pricing?: { input: number; output: number };
  /** Extra JSON merged into every upstream request body (provider-specific parameters). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Stream from the provider (reasoning reaches OpenCode live). Disable for providers whose streaming is broken. */
  stream: boolean;
  /** Other model ids OpenCode may send that should map to this profile. */
  aliases?: string[];
}

export interface Limits {
  /** Max wait for response headers + first byte from the provider. */
  firstByteTimeoutMs: number;
  /** Max silence between streamed chunks. */
  idleTimeoutMs: number;
  /** Hard cap for one upstream call. */
  requestTimeoutMs: number;
  /** Transport-level retries (timeouts, 5xx, network, malformed bodies) per model call. */
  transportRetries: number;
  /** Separate retry budget for rate limiting (429 / 503 busy), with exponential backoff. */
  rateLimitRetries: number;
  /** First backoff for rate limiting; doubles per hit, capped at 30s. Retry-After wins when present. */
  rateLimitBackoffMs: number;
  /** Re-prompts after an invalid tool call (unknown tool, bad JSON, schema). */
  repairAttempts: number;
  /** Re-prompts when the model proposes a redundant call. */
  redundantHints: number;
  /** Re-prompts when the model returns neither text nor a tool call. */
  emptyRetries: number;
  /** Redundant calls executed in one user turn before the proxy stops the turn. */
  maxRedundantPerTurn: number;
  /** Consecutive failing tool results before the proxy stops the turn. */
  maxConsecutiveErrors: number;
  /** Tool steps in one user turn before the proxy stops the turn. */
  maxStepsPerTurn: number;
  /** Total wall time budget for one OpenCode request (all internal attempts). */
  requestBudgetMs: number;
}

export interface Config {
  host: string;
  port: number;
  defaultProfile: string;
  logDir: string;
  /**
   * Log content: the user's objective, model output, tool-call argument values and
   * previews of successful tool results. Off by default, so logs hold metadata, paths,
   * commands and error messages only. Keys are never logged either way.
   */
  logContent: boolean;
  /** Log days (<logDir>/<YYYY-MM-DD>) older than this are deleted; 0 keeps everything. */
  logRetentionDays: number;
  profiles: Record<string, Profile>;
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  firstByteTimeoutMs: 60_000,
  idleTimeoutMs: 45_000,
  requestTimeoutMs: 180_000,
  transportRetries: 3,
  rateLimitRetries: 8,
  rateLimitBackoffMs: 5_000,
  repairAttempts: 2,
  redundantHints: 2,
  emptyRetries: 1,
  maxRedundantPerTurn: 3,
  maxConsecutiveErrors: 8,
  maxStepsPerTurn: 60,
  requestBudgetMs: 420_000,
};

export const DEFAULT_PROFILES: Record<string, Profile> = {
  siliconflow: {
    name: "siliconflow",
    baseURL: "https://api.siliconflow.com/v1",
    model: "openai/gpt-oss-20b",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    strategy: "harmony",
    fallbackStrategy: "harmony",
    maxOutputTokens: 8192,
    contextWindow: 131072,
    // Measured: same task success as full descriptions with ~35% fewer tokens per run.
    toolDescriptions: "compact",
    pricing: { input: 0.04, output: 0.18 },
    // SiliconFlow duplicates the token after a special token when streaming
    // ("<|channel|>commentcomment..."), corrupting harmony tool calls. Its
    // non-streaming output is clean, so call it without streaming; OpenCode still
    // receives a stream (with keepalives) from the proxy.
    stream: false,
    aliases: ["gpt-oss-20b", "openai/gpt-oss-20b"],
  },
  openwebui: {
    name: "openwebui",
    kind: "openwebui",
    openwebuiRoute: "auto",
    baseURL: "http://localhost:8080/api",
    model: "gpt-oss20b-opencode",
    apiKeyEnv: "OPENWEBUI_API_KEY",
    strategy: "auto",
    fallbackStrategy: "harmony",
    maxOutputTokens: 8192,
    // Must match the context length the Ollama server really uses (OLLAMA_CONTEXT_LENGTH);
    // the README recommends 32768. Override with OPENWEBUI_CONTEXT_WINDOW.
    contextWindow: 32768,
    toolDescriptions: "compact",
    stream: true,
    aliases: ["gpt-oss20b-opencode"],
  },
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const cfg: Config = {
    host: "127.0.0.1",
    port: 8787,
    defaultProfile: "siliconflow",
    logDir: path.resolve(cwd, "logs"),
    logContent: false,
    logRetentionDays: 14,
    profiles: structuredClone(DEFAULT_PROFILES),
    limits: { ...DEFAULT_LIMITS },
  };
  const file = env.GPT_OSS_CONFIG ?? path.resolve(cwd, "gpt-oss-proxy.config.json");
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    mergeConfig(cfg, raw, path.dirname(path.resolve(file)));
  } else if (env.GPT_OSS_CONFIG) {
    throw new Error(`GPT_OSS_CONFIG points to a missing file: ${file}`);
  }
  if (env.GPT_OSS_PROFILE) cfg.defaultProfile = env.GPT_OSS_PROFILE;
  if (env.GPT_OSS_PORT) cfg.port = Number(env.GPT_OSS_PORT);
  if (env.GPT_OSS_HOST) cfg.host = env.GPT_OSS_HOST;
  if (env.GPT_OSS_LOG_DIR) cfg.logDir = path.resolve(cwd, env.GPT_OSS_LOG_DIR);
  if (env.GPT_OSS_LOG_CONTENT) cfg.logContent = /^(1|true|yes|on)$/i.test(env.GPT_OSS_LOG_CONTENT);
  if (env.GPT_OSS_LOG_RETENTION_DAYS) cfg.logRetentionDays = Number(env.GPT_OSS_LOG_RETENTION_DAYS);
  for (const p of Object.values(cfg.profiles)) {
    const prefix = p.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    if (env[`${prefix}_BASE_URL`]) p.baseURL = env[`${prefix}_BASE_URL`]!;
    if (env[`${prefix}_MODEL`]) p.model = env[`${prefix}_MODEL`]!;
    if (env[`${prefix}_STRATEGY`]) p.strategy = env[`${prefix}_STRATEGY`] as Strategy;
    if (env[`${prefix}_ROUTE`]) p.openwebuiRoute = env[`${prefix}_ROUTE`] as Profile["openwebuiRoute"];
    if (env[`${prefix}_NUM_CTX`]) p.numCtx = Number(env[`${prefix}_NUM_CTX`]);
    if (env[`${prefix}_CONTEXT_WINDOW`]) p.contextWindow = Number(env[`${prefix}_CONTEXT_WINDOW`]);
    if (env.GPT_OSS_STRATEGY) p.strategy = env.GPT_OSS_STRATEGY as Strategy;
    p.baseURL = p.baseURL.replace(/\/+$/, "");
  }
  validateConfig(cfg);
  return cfg;
}

function mergeConfig(cfg: Config, raw: any, baseDir: string) {
  for (const k of ["host", "port", "defaultProfile", "logContent", "logRetentionDays"] as const) if (raw[k] !== undefined) (cfg as any)[k] = raw[k];
  // Pre-release name of logContent.
  if (raw.logContent === undefined && raw.logModelOutput !== undefined) cfg.logContent = !!raw.logModelOutput;
  if (raw.logDir) cfg.logDir = path.resolve(baseDir, raw.logDir);
  if (raw.limits) Object.assign(cfg.limits, raw.limits);
  for (const [name, p] of Object.entries<any>(raw.profiles ?? {})) {
    const base = cfg.profiles[name] ?? { ...DEFAULT_PROFILES.siliconflow, name, pricing: undefined, aliases: [], apiKeyEnv: undefined };
    cfg.profiles[name] = { ...base, ...p, name };
    if (p.apiKeyFile) cfg.profiles[name].apiKeyFile = path.resolve(baseDir, p.apiKeyFile);
  }
}

function validateConfig(cfg: Config) {
  if (!Number.isFinite(cfg.logRetentionDays) || cfg.logRetentionDays < 0) throw new Error(`logRetentionDays must be a number >= 0 (got ${cfg.logRetentionDays})`);
  if (!cfg.profiles[cfg.defaultProfile]) {
    throw new Error(`defaultProfile "${cfg.defaultProfile}" is not defined (profiles: ${Object.keys(cfg.profiles).join(", ")})`);
  }
  for (const p of Object.values(cfg.profiles)) {
    if (!["native", "harmony", "json", "auto"].includes(p.strategy)) throw new Error(`profile ${p.name}: invalid strategy ${p.strategy}`);
    if (!/^https?:\/\//.test(p.baseURL)) throw new Error(`profile ${p.name}: baseURL must be http(s): ${p.baseURL}`);
    if (!(p.contextWindow >= 4096)) throw new Error(`profile ${p.name}: contextWindow must be a number >= 4096 (got ${p.contextWindow})`);
  }
}

/** Picks the profile for the model id OpenCode sent. */
export function selectProfile(cfg: Config, requestedModel: string | undefined): Profile {
  if (requestedModel) {
    const direct = cfg.profiles[requestedModel];
    if (direct) return direct;
    for (const p of Object.values(cfg.profiles)) if (p.aliases?.includes(requestedModel)) return p;
    // "<profile>/<anything>" or "<anything>@<profile>"
    const slash = requestedModel.split("/")[0];
    if (cfg.profiles[slash]) return cfg.profiles[slash];
    const at = requestedModel.split("@")[1];
    if (at && cfg.profiles[at]) return cfg.profiles[at];
  }
  return cfg.profiles[cfg.defaultProfile];
}

export function apiKeyFor(p: Profile, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (p.apiKeyEnv && env[p.apiKeyEnv]) return env[p.apiKeyEnv];
  if (p.apiKeyFile && fs.existsSync(p.apiKeyFile)) return fs.readFileSync(p.apiKeyFile, "utf8").trim() || undefined;
  return undefined;
}
