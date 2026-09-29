// OpenAI-compatible upstream client with bounded, observable failure handling:
// first-byte / idle / total timeouts, classified errors, retries with backoff.

import type { Limits, Profile } from "./config.ts";
import { apiKeyFor } from "./config.ts";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
}

export interface NativeToolCall {
  id?: string;
  name: string;
  arguments: string;
}

export interface UpstreamResult {
  content: string;
  reasoning: string;
  toolCalls: NativeToolCall[];
  finishReason: string | null;
  usage?: Usage;
  ms: number;
  firstByteMs?: number;
  attempts: number;
  providerRequestId?: string;
}

export type ErrorKind =
  | "tools_unsupported"
  | "context_length"
  | "auth"
  | "rate_limit"
  | "server"
  | "http"
  | "timeout"
  | "network"
  | "malformed"
  | "provider_error"
  | "tool_parse"
  | "aborted";

export class UpstreamError extends Error {
  kind: ErrorKind;
  status?: number;
  body?: string;
  retryable: boolean;
  retryAfterMs?: number;
  attempts = 1;
  constructor(kind: ErrorKind, message: string, opts: { status?: number; body?: string; retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.kind = kind;
    this.status = opts.status;
    this.body = opts.body;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export interface AttemptInfo {
  attempt: number;
  ms: number;
  ok: boolean;
  status?: number;
  error?: string;
  kind?: ErrorKind;
  willRetry?: boolean;
  backoffMs?: number;
}

export interface CallOptions {
  profile: Profile;
  limits: Limits;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** Deadline (epoch ms) for all attempts of this call. */
  deadline?: number;
  onReasoning?: (delta: string) => void;
  onAttempt?: (info: AttemptInfo) => void;
  fetchImpl?: typeof fetch;
}

export function classifyHttpError(status: number, body: string, retryAfter?: string | null): UpstreamError {
  const msg = extractErrorMessage(body) ?? body.slice(0, 300);
  let ra: number | undefined;
  if (retryAfter) {
    const secs = Number(retryAfter);
    ra = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (!Number.isFinite(ra)) ra = undefined;
    else ra = Math.min(ra, 60_000);
  }
  // Ollama could not parse the model's tool-call arguments (reaches clients as 400 via OpenWebUI):
  // repairable by re-prompting the model, not by retrying the same request.
  if (/error parsing tool call/i.test(msg)) return new UpstreamError("tool_parse", `model produced unparseable tool-call arguments: ${msg}`, { status, body });
  if (status === 400 && /function[ _-]?call|tool[ _-]?(call|use)?s? (is |are )?not supported|does not support tools|tools? (is |are )?not supported|tool_choice/i.test(msg)) {
    return new UpstreamError("tools_unsupported", `provider rejected tools: ${msg}`, { status, body });
  }
  if ((status === 400 || status === 413) && /context|too long|maximum.*tokens|max_tokens|token limit|prompt is too long/i.test(msg)) {
    return new UpstreamError("context_length", `context/token limit: ${msg}`, { status, body });
  }
  if (status === 401 || status === 403) return new UpstreamError("auth", `authentication failed (${status}): ${msg}`, { status, body });
  if (status === 429) return new UpstreamError("rate_limit", `rate limited: ${msg}`, { status, body, retryable: true, retryAfterMs: ra });
  if (status >= 500 || status === 408 || status === 409 || status === 425)
    return new UpstreamError("server", `provider error ${status}: ${msg}`, { status, body, retryable: true, retryAfterMs: ra });
  return new UpstreamError("http", `HTTP ${status}: ${msg}`, { status, body });
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const j = JSON.parse(body);
    // OpenAI {error:{message}}, SiliconFlow {message}, FastAPI/OpenWebUI {detail: string | {message} | [{msg}]}
    let m = j?.error?.message ?? j?.message ?? j?.detail ?? j?.error;
    if (m && typeof m === "object" && !Array.isArray(m)) m = m.message ?? m.error ?? m;
    if (Array.isArray(m)) m = m.map((x: any) => x?.msg ?? x?.message ?? JSON.stringify(x)).join("; ");
    return typeof m === "string" ? m : m ? JSON.stringify(m) : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Performs one logical model call with bounded retries. Rate limiting (429, or
 * 503 "busy") has its own retry budget with longer backoff, because per-minute
 * token limits need seconds, not milliseconds, to clear. Everything is capped by
 * the request deadline.
 */
export async function callModel(opts: CallOptions): Promise<UpstreamResult> {
  let transportLeft = Math.max(0, opts.limits.transportRetries);
  let rateLeft = Math.max(0, opts.limits.rateLimitRetries ?? 0);
  let rateHits = 0;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      const r = await callOnce(opts);
      r.attempts = attempt;
      opts.onAttempt?.({ attempt, ms: Date.now() - t0, ok: true });
      return r;
    } catch (e) {
      const err = e instanceof UpstreamError ? e : new UpstreamError("network", String((e as Error)?.message ?? e), { retryable: true });
      err.attempts = attempt;
      const throttled = err.kind === "rate_limit" || (err.kind === "server" && err.status === 503);
      const left = throttled ? rateLeft : transportLeft;
      const base = opts.limits.rateLimitBackoffMs ?? 5_000;
      // Provider 5xx bursts observed on SiliconFlow last several seconds: back off 2 s, 5 s, 12.5 s.
      const computed = throttled ? Math.min(base * 2 ** rateHits, 30_000) : Math.min(2000 * 2.5 ** (attempt - 1 - rateHits), 20_000);
      const backoff = (err.retryAfterMs ?? computed) + Math.floor(Math.random() * 500);
      const remaining = opts.deadline ? opts.deadline - Date.now() : Infinity;
      const willRetry = err.retryable && left > 0 && !opts.signal?.aborted && remaining > backoff + 5_000;
      opts.onAttempt?.({ attempt, ms: Date.now() - t0, ok: false, status: err.status, error: err.message, kind: err.kind, willRetry, backoffMs: willRetry ? backoff : undefined });
      if (!willRetry) throw err;
      if (throttled) {
        rateLeft--;
        rateHits++;
      } else transportLeft--;
      await sleep(backoff, opts.signal);
    }
  }
}

async function callOnce(opts: CallOptions): Promise<UpstreamResult> {
  const { profile, limits } = opts;
  const url = `${profile.baseURL}/chat/completions`;
  const key = apiKeyFor(profile);
  const headers: Record<string, string> = { "content-type": "application/json", accept: profile.stream ? "text/event-stream" : "application/json", ...(profile.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  const body = { ...opts.body, model: profile.model, stream: profile.stream, ...(profile.stream ? { stream_options: { include_usage: true } } : {}), ...(profile.extraBody ?? {}) };

  const ctrl = new AbortController();
  const t0 = Date.now();
  let timeoutKind: "first_byte" | "idle" | "total" | undefined;
  const totalMs = Math.min(limits.requestTimeoutMs, opts.deadline ? Math.max(1000, opts.deadline - Date.now()) : Infinity);
  const totalTimer = setTimeout(() => ((timeoutKind = "total"), ctrl.abort()), totalMs);
  // Without streaming, headers usually arrive only after the whole generation, so a
  // first-byte limit would cut off legitimately long outputs: only the total limit applies.
  let idleTimer: ReturnType<typeof setTimeout> | undefined = profile.stream
    ? setTimeout(() => ((timeoutKind = "first_byte"), ctrl.abort()), limits.firstByteTimeoutMs)
    : undefined;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ((timeoutKind = "idle"), ctrl.abort()), limits.idleTimeoutMs);
  };
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const fail = (e: unknown): never => {
    if (e instanceof UpstreamError) throw e;
    if (timeoutKind) {
      const limit = timeoutKind === "first_byte" ? limits.firstByteTimeoutMs : timeoutKind === "idle" ? limits.idleTimeoutMs : totalMs;
      throw new UpstreamError("timeout", `${timeoutKind} timeout after ${Date.now() - t0}ms (limit ${limit}ms)`, { retryable: true });
    }
    if (opts.signal?.aborted) throw new UpstreamError("aborted", "request aborted by client");
    throw new UpstreamError("network", `network error: ${(e as Error)?.message ?? e}`, { retryable: true });
  };

  try {
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      return fail(e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw classifyHttpError(res.status, text, res.headers.get("retry-after"));
    }
    const providerRequestId = res.headers.get("x-request-id") ?? res.headers.get("x-siliconcloud-trace-id") ?? undefined;
    const ctype = res.headers.get("content-type") ?? "";
    if (!profile.stream || ctype.includes("application/json")) {
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        return fail(e);
      }
      const r = parseNonStream(text);
      return { ...r, ms: Date.now() - t0, firstByteMs: Date.now() - t0, attempts: 1, providerRequestId };
    }
    const acc = new StreamAccumulator(opts.onReasoning);
    let firstByteMs: number | undefined;
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        if (firstByteMs === undefined) firstByteMs = Date.now() - t0;
        bumpIdle();
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          acc.line(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (acc.done) break;
      }
    } catch (e) {
      return fail(e);
    }
    if (buf.trim()) acc.line(buf);
    acc.flush();
    const r = acc.result();
    if (!acc.sawData) throw new UpstreamError("malformed", "stream ended without any data events", { retryable: true });
    // OpenWebUI (/api route) turns a mid-stream Ollama error into an empty "stop" chunk with
    // model "ollama" and no usage; every genuine completion carries usage on its final chunk.
    if (acc.lastModel === "ollama" && !r.usage && !r.toolCalls.length && r.finishReason === "stop") {
      throw new UpstreamError("provider_error", "the model server reported an error mid-stream (OpenWebUI hides the message; check the Ollama log)", { retryable: true });
    }
    return { ...r, ms: Date.now() - t0, firstByteMs, attempts: 1, providerRequestId };
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

function normUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens,
  };
}

function argsString(a: unknown): string {
  if (typeof a === "string") return a;
  return a == null ? "" : JSON.stringify(a);
}

/** Moves inline <think>…</think> blocks (some OpenAI-compatible gateways) into reasoning. */
export function splitThinkTags(content: string): { content: string; reasoning: string } {
  if (!content.includes("<think>")) return { content, reasoning: "" };
  let reasoning = "";
  const out = content.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, r) => {
    reasoning += r;
    return "";
  });
  return { content: out.trimStart(), reasoning };
}

export function parseNonStream(text: string): Omit<UpstreamResult, "ms" | "attempts"> {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new UpstreamError("malformed", `non-JSON response: ${text.slice(0, 200)}`, { retryable: true });
  }
  if (j?.error) throw new UpstreamError("provider_error", `provider error: ${extractErrorMessage(text)}`, { retryable: true, body: text });
  const choice = j?.choices?.[0];
  if (!choice) throw new UpstreamError("malformed", `response has no choices: ${text.slice(0, 200)}`, { retryable: true });
  const m = choice.message ?? {};
  const split = splitThinkTags(typeof m.content === "string" ? m.content : "");
  return {
    content: split.content,
    reasoning: (m.reasoning_content ?? m.reasoning ?? m.thinking ?? "") + split.reasoning,
    toolCalls: (m.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name ?? "", arguments: argsString(t.function?.arguments) })),
    finishReason: choice.finish_reason ?? null,
    usage: normUsage(j.usage),
  };
}

/** Incremental SSE -> chat completion accumulator. */
export class StreamAccumulator {
  content = "";
  reasoning = "";
  finishReason: string | null = null;
  usage?: Usage;
  done = false;
  sawData = false;
  /** `model` of the last chunk (OpenWebUI uses "ollama" for the chunk it synthesizes from an Ollama error). */
  lastModel?: string;
  private pending = "";
  private calls: (NativeToolCall & { index: number })[] = [];
  private onReasoning?: (d: string) => void;
  private inThink = false;

  constructor(onReasoning?: (d: string) => void) {
    this.onReasoning = onReasoning;
  }

  line(raw: string) {
    const line = raw.replace(/\r$/, "");
    if (line === "") return this.flush();
    if (line.startsWith(":")) return; // SSE comment / keepalive
    if (!line.startsWith("data:")) return; // event:, id:, retry: are irrelevant here
    const data = line.slice(5).replace(/^ /, "");
    if (data.trim() === "[DONE]") {
      this.flush();
      this.done = true;
      return;
    }
    if (this.pending === "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // may be a multi-line data event
      }
      if (parsed !== undefined) return this.event(parsed);
    }
    this.pending += (this.pending ? "\n" : "") + data;
  }

  flush() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = "";
    let j: any;
    try {
      j = JSON.parse(p);
    } catch {
      throw new UpstreamError("malformed", `unparseable stream event: ${p.slice(0, 200)}`, { retryable: true });
    }
    this.event(j);
  }

  private event(j: any) {
    this.sawData = true;
    if (typeof j?.model === "string") this.lastModel = j.model;
    if (j?.error) {
      throw new UpstreamError("provider_error", `provider stream error: ${typeof j.error === "string" ? j.error : j.error.message ?? JSON.stringify(j.error)}`, {
        retryable: true,
      });
    }
    if (j.usage) this.usage = normUsage(j.usage) ?? this.usage;
    const ch = j.choices?.[0];
    if (!ch) return;
    if (ch.finish_reason) this.finishReason = ch.finish_reason;
    const d = ch.delta ?? ch.message ?? {};
    const r = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof r === "string" && r) this.addReasoning(r);
    if (typeof d.content === "string" && d.content) this.addContent(d.content);
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const next = this.calls.reduce((m, x) => Math.max(m, x.index + 1), 0);
        let c: (NativeToolCall & { index: number }) | undefined;
        if (typeof t.index === "number") c = this.calls.find((x) => x.index === t.index);
        else if (t.id) c = this.calls.find((x) => x.id === t.id);
        else c = this.calls[this.calls.length - 1]; // continuation delta without index/id
        if (!c) {
          c = { index: typeof t.index === "number" ? t.index : next, id: t.id, name: "", arguments: "" };
          this.calls.push(c);
        }
        if (t.id) c.id = t.id;
        if (t.function?.name) c.name += t.function.name;
        if (t.function?.arguments !== undefined) c.arguments += argsString(t.function.arguments);
      }
    }
  }

  private addReasoning(r: string) {
    this.reasoning += r;
    this.onReasoning?.(r);
  }

  private addContent(c: string) {
    // Inline <think> tags from some gateways.
    let s = c;
    while (s) {
      if (this.inThink) {
        const e = s.indexOf("</think>");
        if (e < 0) {
          this.addReasoning(s);
          return;
        }
        this.addReasoning(s.slice(0, e));
        s = s.slice(e + 8);
        this.inThink = false;
      } else {
        const b = this.content === "" ? s.indexOf("<think>") : -1;
        if (b < 0) {
          this.content += s;
          return;
        }
        this.content += s.slice(0, b);
        s = s.slice(b + 7);
        this.inThink = true;
      }
    }
  }

  result(): Omit<UpstreamResult, "ms" | "attempts"> {
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: this.calls.sort((a, b) => a.index - b.index).map(({ index: _i, ...c }) => c),
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }
}

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens: (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0),
    cached_tokens: (a.cached_tokens ?? 0) + (b.cached_tokens ?? 0),
  };
}

export function costUSD(u: Usage | undefined, p: Profile): number | undefined {
  if (!u || !p.pricing) return undefined;
  return (u.prompt_tokens * p.pricing.input + u.completion_tokens * p.pricing.output) / 1e6;
}
