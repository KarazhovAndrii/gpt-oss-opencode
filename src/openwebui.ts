// OpenWebUI specifics (verified against OpenWebUI 0.11.4 + Ollama 0.34.4, see
// docs/VALIDATION_REPORT.md). Two usable routes for a model on an Ollama connection:
//
//   "api"       POST <root>/api/chat/completions  - OpenWebUI middleware + its own
//               OpenAI->Ollama converter. max_tokens/temperature/reasoning_effort are
//               dropped (only `options` reaches Ollama), tool-result messages lose the
//               tool name (gpt-oss then sees "functions. to=assistant"), and a mid-stream
//               Ollama error becomes an empty finish_reason "stop" chunk (model "ollama").
//               num_ctx CAN be set per request via options.num_ctx.
//   "ollama-v1" POST <root>/ollama/v1/chat/completions - passthrough to Ollama's own
//               OpenAI layer (preset -> base model, preset params/system applied):
//               tool names resolved from tool_call_id, max_tokens/reasoning_effort
//               honoured, errors preserved. num_ctx cannot be set per request (server
//               OLLAMA_CONTEXT_LENGTH or a model variant decides).
//
// "auto" asks GET <root>/api/models for the model's owned_by: "ollama" -> ollama-v1,
// anything else (OpenAI-type connection, e.g. Ollama /v1 added as OpenAI) -> api.

import type { Profile } from "./config.ts";
import { apiKeyFor } from "./config.ts";
import type { ChatMessage } from "./messages.ts";
import { textOf } from "./messages.ts";

export type OwuiRoute = "api" | "ollama-v1";

export interface Target {
  /** Profile with baseURL pointing at the chosen route (".../chat/completions" is appended by the client). */
  profile: Profile;
  route?: OwuiRoute;
  ownedBy?: string;
  /** Adjusts the upstream body for the route. */
  patchBody(body: Record<string, unknown>): Record<string, unknown>;
  note?: string;
}

export function owuiRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/(api(\/v1)?|ollama\/v1|ollama)$/, "");
}

const cache = new Map<string, { route: OwuiRoute; ownedBy?: string; note?: string; at: number }>();

async function detect(profile: Profile, fetchImpl: typeof fetch): Promise<{ route: OwuiRoute; ownedBy?: string; note?: string }> {
  const key = `${profile.baseURL}|${profile.model}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  let res: { route: OwuiRoute; ownedBy?: string; note?: string };
  try {
    const apiKey = apiKeyFor(profile);
    const r = await fetchImpl(`${owuiRoot(profile.baseURL)}/api/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const m = (j?.data ?? []).find((x: any) => x?.id === profile.model);
    if (!m) res = { route: "api", note: `model "${profile.model}" not listed by OpenWebUI /api/models; using /api/chat/completions` };
    else res = { route: m.owned_by === "ollama" ? "ollama-v1" : "api", ownedBy: m.owned_by };
  } catch (e) {
    res = { route: "api", note: `route auto-detection failed (${(e as Error).message}); using /api/chat/completions` };
  }
  cache.set(key, { ...res, at: Date.now() });
  return res;
}

/** Prefixes tool results with the tool name (route "api" loses the name on its way to Ollama). */
function labelToolResults(messages: ChatMessage[]): ChatMessage[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const name = names.get(m.tool_call_id ?? "");
    const text = textOf(m.content);
    return name && !text.startsWith(`[${name} result]`) ? { ...m, content: `[${name} result]\n${text}` } : m;
  });
}

/**
 * OpenWebUI's converter fails (HTTP 400) or silently drops messages that break
 * these invariants, so enforce them for everything sent on route "api".
 */
function owuiSafeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === "assistant" && !m.tool_calls?.length && m.content == null) return { ...m, content: "" };
    if (m.role === "tool" && typeof m.content !== "string") return { ...m, content: textOf(m.content) };
    return m;
  });
}

export async function resolveTarget(profile: Profile, fetchImpl: typeof fetch = fetch): Promise<Target> {
  if (profile.kind !== "openwebui") return { profile, patchBody: (b) => b };
  const want = profile.openwebuiRoute ?? "auto";
  const det = want === "auto" ? await detect(profile, fetchImpl) : { route: want as OwuiRoute };
  const root = owuiRoot(profile.baseURL);
  if (det.route === "ollama-v1") {
    return { profile: { ...profile, baseURL: `${root}/ollama/v1` }, route: "ollama-v1", ownedBy: (det as any).ownedBy, note: (det as any).note, patchBody: (b) => b };
  }
  const ollamaBacked = (det as any).ownedBy === "ollama";
  return {
    profile: { ...profile, baseURL: `${root}/api` },
    route: "api",
    ownedBy: (det as any).ownedBy,
    note: (det as any).note,
    patchBody: (b) => {
      const out: Record<string, unknown> = { ...b };
      // Only `options` reaches Ollama on this route: carry the output cap and context size there.
      const options: Record<string, unknown> = { ...((b.options as object) ?? {}) };
      if (typeof b.max_tokens === "number" && options.num_predict === undefined) options.num_predict = b.max_tokens;
      if (profile.numCtx && options.num_ctx === undefined) options.num_ctx = profile.numCtx;
      out.options = options;
      if (Array.isArray(b.messages)) {
        let msgs = owuiSafeMessages(b.messages as ChatMessage[]);
        if (ollamaBacked || (det as any).ownedBy === undefined) msgs = labelToolResults(msgs);
        out.messages = msgs;
      }
      return out;
    },
  };
}

export function clearRouteCache() {
  cache.clear();
}
