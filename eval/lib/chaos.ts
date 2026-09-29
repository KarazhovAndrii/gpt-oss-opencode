// Fault-injecting forwarder placed between the proxy and the real provider.
// Request N (1-based, counting chat completions) gets the scripted fault.

import http from "node:http";
import type { AddressInfo } from "node:net";

export type Fault = "hang" | "500" | "429" | "malformed" | "empty" | "slow";

export interface Chaos {
  url: string;
  injected: { n: number; fault: Fault }[];
  close(): Promise<void>;
}

export async function startChaos(targetBase: string, plan: Record<number, Fault>): Promise<Chaos> {
  let n = 0;
  const injected: Chaos["injected"] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const isChat = (req.url ?? "").endsWith("/chat/completions");
    const fault = isChat ? plan[++n] : undefined;
    if (fault) injected.push({ n, fault });
    switch (fault) {
      case "hang":
        return; // never answers; the proxy's first-byte timeout must fire
      case "500":
        res.writeHead(500, { "content-type": "application/json" });
        return res.end('{"error":{"message":"injected internal error"}}');
      case "429":
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end('{"error":{"message":"injected rate limit"}}');
      case "malformed":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"id":"x","choices":[{"message":{"content":"trunc');
      case "empty":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"id":"x","choices":[]}');
    }
    if (fault === "slow") await new Promise((ok) => setTimeout(ok, 3000));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
    try {
      const up = await fetch(targetBase + (req.url ?? "").replace(/^\/v1/, ""), { method: req.method, headers, body: req.method === "POST" ? body : undefined });
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch (e) {
      res.writeHead(502);
      res.end(String(e));
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    injected,
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}
