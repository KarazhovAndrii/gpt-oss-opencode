// Scriptable OpenAI-compatible mock provider for contract tests. Each incoming
// request consumes the next scripted reply; every request body is recorded.

import http from "node:http";
import type { AddressInfo } from "node:net";

export type Reply =
  | { kind: "json"; content?: string; reasoning?: string; toolCalls?: { name: string; arguments: string; id?: string }[]; finish?: string; usage?: object; delayMs?: number }
  | { kind: "sse"; chunks: (object | string)[]; delayMs?: number; chunkDelayMs?: number; hangAfter?: boolean }
  | { kind: "status"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "hang" }
  | { kind: "raw"; contentType: string; body: string };

export interface MockUpstream {
  url: string;
  requests: any[];
  paths: string[];
  headers: http.IncomingHttpHeaders[];
  push(...r: Reply[]): void;
  /** Serve GET .../api/models (OpenWebUI) with these entries instead of consuming a scripted reply. */
  setModels(models: { id: string; owned_by: string }[]): void;
  close(): Promise<void>;
}

export function harmonyCall(name: string, args: object | string, analysis = "Need to call a tool."): Extract<Reply, { kind: "json" }> {
  const a = typeof args === "string" ? args : JSON.stringify(args);
  return { kind: "json", content: `${analysis}<|end|><|start|>assistant<|channel|>commentary to=functions.${name} <|constrain|>json<|message|>${a}` };
}

export function harmonyFinal(text: string, reasoning = "Done."): Extract<Reply, { kind: "json" }> {
  return { kind: "json", content: text, reasoning };
}

export async function startMockUpstream(prefix = "/v1"): Promise<MockUpstream> {
  const queue: Reply[] = [];
  const requests: any[] = [];
  const paths: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let models: { id: string; owned_by: string }[] | undefined;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && models && (req.url ?? "").split("?")[0].endsWith("/api/models")) {
      paths.push(req.url ?? "");
      headers.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((x) => ({ ...x, object: "model" })) }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      paths.push(req.url ?? "");
      headers.push(req.headers);
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push(body);
      }
      const r = queue.shift();
      if (!r) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock: no scripted reply left" } }));
        return;
      }
      if (r.kind === "hang") return; // never answer
      if (r.kind === "status") {
        res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
        res.end(r.body);
        return;
      }
      if (r.kind === "raw") {
        res.writeHead(200, { "content-type": r.contentType });
        res.end(r.body);
        return;
      }
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.kind === "json") {
        const message: any = { role: "assistant", content: r.content ?? null };
        if (r.reasoning) message.reasoning_content = r.reasoning;
        if (r.toolCalls) message.tool_calls = r.toolCalls.map((t, i) => ({ id: t.id ?? `up_${i}`, type: "function", function: { name: t.name, arguments: t.arguments } }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock",
            object: "chat.completion",
            choices: [{ index: 0, message, finish_reason: r.finish ?? (r.toolCalls ? "tool_calls" : "stop") }],
            usage: r.usage ?? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of r.chunks) {
        if (r.chunkDelayMs) await new Promise((ok) => setTimeout(ok, r.chunkDelayMs));
        res.write(typeof c === "string" ? c : `data: ${JSON.stringify(c)}\n\n`);
      }
      if (r.hangAfter) return;
      res.end("data: [DONE]\n\n");
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    requests,
    paths,
    headers,
    push: (...r) => queue.push(...r),
    setModels: (list) => {
      models = list;
    },
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

/** Builds an SSE chunk in OpenAI format. */
export function chunk(delta: object, finish: string | null = null, extra: object = {}): object {
  return { id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}
