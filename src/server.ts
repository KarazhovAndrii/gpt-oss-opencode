// OpenAI-compatible HTTP endpoint that OpenCode talks to.
//   POST /v1/chat/completions   GET /v1/models   GET /health

import http from "node:http";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import { selectProfile, apiKeyFor, envPrefix } from "./config.ts";
import { Logger, truncate } from "./log.ts";
import { ChatEmitter } from "./emitter.ts";
import { runChat, type ChatRequest } from "./agent.ts";
import { costUSD } from "./upstream.ts";

export interface ServerOptions {
  cfg: Config;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Anyone who can reach the proxy spends the configured provider keys, so a
 * non-loopback bind requires a client token. Returns why a bind is refused, if it is.
 */
export function bindRefusal(host: string, token: string | undefined): string | undefined {
  if (isLoopback(host) || token) return undefined;
  return `refusing to listen on ${host} without GPT_OSS_PROXY_TOKEN: anyone who can reach this address could use your provider API keys. Set GPT_OSS_PROXY_TOKEN (and the same value as OpenCode's apiKey), or bind to 127.0.0.1.`;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const a = crypto.createHash("sha256").update(header ?? "").digest();
  const b = crypto.createHash("sha256").update(`Bearer ${token}`).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createServer(opts: ServerOptions): http.Server {
  const { cfg } = opts;
  const logger = opts.logger ?? new Logger(cfg.logDir);

  const token = process.env.GPT_OSS_PROXY_TOKEN;
  return http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0].replace(/\/+$/, "");
    try {
      // Client auth: optional on localhost, required (see bindRefusal) beyond it.
      if (token && url !== "/health" && !tokenMatches(req.headers.authorization, token)) {
        return json(res, 401, { error: { message: "invalid or missing proxy token", type: "auth_error" } });
      }
      if (req.method === "GET" && (url === "/health" || url === "")) {
        return json(res, 200, {
          ok: true,
          defaultProfile: cfg.defaultProfile,
          profiles: Object.values(cfg.profiles).map((p) => ({ name: p.name, baseURL: p.baseURL, model: p.model, strategy: p.strategy, apiKeyPresent: !!apiKeyFor(p) })),
        });
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
        const ids = new Set<string>();
        for (const p of Object.values(cfg.profiles)) {
          ids.add(p.name);
          p.aliases?.forEach((a) => ids.add(a));
        }
        return json(res, 200, { object: "list", data: [...ids].map((id) => ({ id, object: "model", owned_by: "gpt-oss-proxy" })) });
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        return await handleChat(req, res, cfg, logger, opts.fetchImpl);
      }
      json(res, 404, { error: { message: `not found: ${req.method} ${url}`, type: "not_found" } });
    } catch (e) {
      logger.console(`[gpt-oss-proxy] internal error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) json(res, 500, { error: { message: `proxy internal error: ${(e as Error).message}`, type: "proxy_error" } });
      else res.end();
    }
  });
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, cfg: Config, logger: Logger, fetchImpl?: typeof fetch) {
  let body: ChatRequest;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: { message: `invalid JSON body: ${(e as Error).message}`, type: "invalid_request_error" } });
  }
  if (!Array.isArray(body.messages)) return json(res, 400, { error: { message: "messages must be an array", type: "invalid_request_error" } });

  const profile = selectProfile(cfg, body.model);
  const session = String(req.headers["x-session-id"] ?? req.headers["x-session-affinity"] ?? "no-session");
  const reqId = `req_${crypto.randomBytes(6).toString("hex")}`;
  const stream = !!body.stream;
  const includeUsage = !stream || !!(body.stream_options as any)?.include_usage;
  const emitter = new ChatEmitter(res, { stream, includeUsage, model: body.model ?? profile.name, id: `chatcmpl-${reqId}` });

  if (!profile.baseURL) {
    const px = envPrefix(profile);
    const configured = Object.values(cfg.profiles).filter((p) => p.baseURL).map((p) => p.name);
    logger.event(session, "guard_stop", { req: reqId, kind: "not_configured", reason: `profile ${profile.name} has no baseURL` });
    emitter.content(
      `[gpt-oss-proxy] Model "${body.model ?? ""}" uses the provider profile "${profile.name}", which has no address yet. Set ${px}_BASE_URL (plus ${px}_MODEL and ${px}_API_KEY if your provider needs them) and restart the proxy${configured.length ? `, or use one of the configured profiles: ${configured.join(", ")}` : ""}.`,
    );
    emitter.finish("stop");
    return;
  }

  const ctrl = new AbortController();
  res.on("close", () => {
    if (!emitter.isFinished) {
      ctrl.abort();
      emitter.abort();
      logger.event(session, "client_closed", { req: reqId });
    }
  });

  const t0 = Date.now();
  let out: Awaited<ReturnType<typeof runChat>>;
  try {
    out = await runChat(body, { cfg, profile, logger, session, reqId, emitter, signal: ctrl.signal, fetchImpl });
  } catch (e) {
    // A proxy bug must not leave OpenCode with a truncated stream.
    logger.event(session, "internal_error", { req: reqId, error: String((e as Error)?.stack ?? e).slice(0, 2000) });
    logger.console(`[gpt-oss-proxy] internal error: ${(e as Error)?.stack ?? e}`);
    if (ctrl.signal.aborted) return;
    emitter.content(`[gpt-oss-proxy] internal error while handling this request: ${(e as Error)?.message ?? e}. Details are in the proxy log (session ${session}).`);
    emitter.finish("stop");
    return;
  }
  if (ctrl.signal.aborted) return;
  if (out.text) emitter.content(out.text);
  if (out.calls.length) emitter.toolCalls(out.calls.map((c) => ({ id: c.id, name: c.name, argsJson: c.argsJson })));
  emitter.finish(out.finish, out.usage);

  const cost = costUSD(out.usage, profile);
  const what = out.calls.length ? out.calls.map((c) => `${c.name}(${truncate(c.argsJson, 80)})`).join(", ") : out.diagnostic ? `DIAG ${out.diagnostic}` : `text ${out.text.length} chars`;
  logger.console(
    `[${new Date().toISOString().slice(11, 19)}] ${session.slice(-8)} ${profile.name}/${out.strategy} ${Date.now() - t0}ms calls=${out.modelCalls} tok=${out.usage?.prompt_tokens ?? "?"}/${out.usage?.completion_tokens ?? "?"}${cost !== undefined ? ` $${cost.toFixed(5)}` : ""} -> ${what}`,
  );
}
