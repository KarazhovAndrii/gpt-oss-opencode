// The OpenCode side of the setup: the "gpt-oss" provider that points OpenCode at the proxy,
// with one model per configured profile and limits taken from the proxy's own profile, so
// OpenCode compacts at the window the proxy plans for. The plugin registers it at runtime;
// `npm run setup -- --no-plugin` writes it into opencode.json.

import type { Config, Profile } from "./config.ts";
import { isSetUp } from "./config.ts";

export const OPENCODE_PROVIDER_ID = "gpt-oss";

const MODEL_NAMES: Record<string, string> = {
  custom: "GPT-OSS (your provider)",
  siliconflow: "GPT-OSS via SiliconFlow",
  openwebui: "GPT-OSS via OpenWebUI",
};

/** The address OpenCode should call; a wildcard bind is reached via loopback. */
export function proxyURL(cfg: Pick<Config, "host" | "port">): string {
  const h = cfg.host.replace(/^\[|\]$/g, "");
  const host = h === "" || h === "0.0.0.0" || h === "::" ? "127.0.0.1" : h.includes(":") ? `[${h}]` : h;
  return `http://${host}:${cfg.port}/v1`;
}

function modelEntry(p: Profile): Record<string, unknown> {
  return {
    name: MODEL_NAMES[p.name] ?? `GPT-OSS (${p.name})`,
    tool_call: true,
    reasoning: true,
    limit: { context: p.contextWindow, output: p.maxOutputTokens },
    ...(p.pricing ? { cost: { input: p.pricing.input, output: p.pricing.output } } : {}),
  };
}

/** OpenCode's provider entry for the proxy: the profiles that are set up, or `all`. */
export function opencodeProvider(cfg: Config, opts: { all?: boolean; token?: string } = {}) {
  const models: Record<string, Record<string, unknown>> = {};
  for (const p of Object.values(cfg.profiles)) if (opts.all || isSetUp(p)) models[p.name] = modelEntry(p);
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "GPT-OSS (gpt-oss-proxy)",
    options: { baseURL: proxyURL(cfg), apiKey: opts.token ?? "unused-the-proxy-holds-the-provider-keys" },
    models,
  };
}

/**
 * Adds the proxy's provider to a loaded OpenCode config (the plugin's `config` hook).
 * The address is the plugin's own; the key and model settings the user wrote in
 * opencode.json win.
 */
export function registerProvider(oc: any, cfg: Config, opts: { all?: boolean; token?: string } = {}) {
  const anySetUp = Object.values(cfg.profiles).some((p) => isSetUp(p));
  const ours = opencodeProvider(cfg, { ...opts, all: opts.all || !anySetUp });
  // A model OpenCode is told to use stays listed without an address, so it answers with
  // how to configure it instead of OpenCode failing with "model not found".
  for (const ref of [oc.model, oc.small_model]) {
    const [prov, id] = String(ref ?? "").split("/");
    if (prov === OPENCODE_PROVIDER_ID && cfg.profiles[id] && !ours.models[id]) ours.models[id] = modelEntry(cfg.profiles[id]);
  }
  oc.provider ??= {};
  const mine = oc.provider[OPENCODE_PROVIDER_ID] ?? {};
  const models: Record<string, unknown> = { ...(mine.models ?? {}) };
  for (const [id, m] of Object.entries(ours.models)) {
    const user = (mine.models?.[id] ?? {}) as Record<string, any>;
    models[id] = { ...m, ...user, limit: { ...(m.limit as object), ...(user.limit ?? {}) } };
  }
  const apiKey = opts.token ?? mine.options?.apiKey ?? ours.options.apiKey;
  oc.provider[OPENCODE_PROVIDER_ID] = { ...ours, ...mine, options: { ...(mine.options ?? {}), baseURL: ours.options.baseURL, apiKey }, models };
}
