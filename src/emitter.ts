// Writes OpenAI chat.completion(.chunk) responses in the shape the Vercel AI
// SDK's openai-compatible provider (used by OpenCode) parses.

import type { ServerResponse } from "node:http";
import type { Usage } from "./upstream.ts";

export interface EmittedCall {
  id: string;
  name: string;
  argsJson: string;
}

export class ChatEmitter {
  private res: ServerResponse;
  private stream: boolean;
  private includeUsage: boolean;
  private model: string;
  private id: string;
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  private finished = false;
  private keepalive?: ReturnType<typeof setInterval>;
  // non-stream accumulation
  private text = "";
  private reasoningText = "";
  private calls: EmittedCall[] = [];

  constructor(res: ServerResponse, opts: { stream: boolean; includeUsage: boolean; model: string; id: string; keepaliveMs?: number }) {
    this.res = res;
    this.stream = opts.stream;
    this.includeUsage = opts.includeUsage;
    this.model = opts.model;
    this.id = opts.id;
    // The stream starts with the first output or keepalive, so an error that comes first (a
    // context overflow from the provider) can still be a real HTTP status: OpenCode compacts
    // the session on a 400 overflow error, but not on an error chunk inside a 200 stream.
    if (this.stream) {
      this.keepalive = setInterval(() => {
        this.start();
        this.write(": keepalive\n\n");
      }, opts.keepaliveMs ?? 10_000);
    }
  }

  get isFinished() {
    return this.finished;
  }

  /** Whether the response status is still open (nothing has been sent yet). */
  get canSendStatus() {
    return !this.started && !this.res.headersSent;
  }

  private start() {
    if (!this.stream || this.started) return;
    this.started = true;
    this.res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    this.chunk({ role: "assistant", content: "" });
  }

  private write(s: string) {
    if (!this.res.writableEnded && !this.res.destroyed) this.res.write(s);
  }

  private chunk(delta: Record<string, unknown>, finish: string | null = null) {
    this.start();
    const payload = { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
    this.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  reasoning(delta: string) {
    if (!delta || this.finished) return;
    if (this.stream) this.chunk({ reasoning_content: delta });
    else this.reasoningText += delta;
  }

  content(t: string) {
    if (!t || this.finished) return;
    if (this.stream) this.chunk({ content: t });
    else this.text += t;
  }

  toolCalls(calls: EmittedCall[]) {
    if (this.finished) return;
    if (this.stream) {
      calls.forEach((c, index) =>
        this.chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: c.argsJson } }] }),
      );
    } else this.calls.push(...calls);
  }

  finish(reason: "stop" | "tool_calls" | "length", usage?: Usage) {
    if (this.finished) return;
    this.finished = true;
    if (this.keepalive) clearInterval(this.keepalive);
    const u = usage
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
          ...(usage.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
          ...(usage.cached_tokens ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
        }
      : undefined;
    if (this.stream) {
      this.chunk({}, reason);
      if (u && this.includeUsage) {
        this.write(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: u })}\n\n`);
      }
      this.write("data: [DONE]\n\n");
      this.res.end();
      return;
    }
    const message: Record<string, unknown> = { role: "assistant", content: this.text || (this.calls.length ? null : "") };
    if (this.reasoningText) message.reasoning_content = this.reasoningText;
    if (this.calls.length) message.tool_calls = this.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsJson } }));
    const body = { id: this.id, object: "chat.completion", created: this.created, model: this.model, choices: [{ index: 0, message, finish_reason: reason }], ...(u ? { usage: u } : {}) };
    this.res.writeHead(200, { "content-type": "application/json" });
    this.res.end(JSON.stringify(body));
  }

  /** Protocol-level failure: an HTTP error while nothing was sent yet, else an error chunk. */
  fail(status: number, message: string, type = "proxy_error", code?: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.keepalive) clearInterval(this.keepalive);
    const error = { message, type, ...(code ? { code } : {}) };
    if (this.stream && this.started) {
      this.write(`data: ${JSON.stringify({ error })}\n\n`);
      this.res.end();
      return;
    }
    this.res.writeHead(status, { "content-type": "application/json" });
    this.res.end(JSON.stringify({ error }));
  }

  abort() {
    if (this.keepalive) clearInterval(this.keepalive);
    this.finished = true;
  }
}
