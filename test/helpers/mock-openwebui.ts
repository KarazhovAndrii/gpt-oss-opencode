// A minimal OpenWebUI for setup tests: key check on /api/models, a model list, and a chat
// endpoint that answers with a native `read` tool call for the README in the working
// directory named in the system prompt. Every chat request body is recorded.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOpenWebUI {
  url: string;
  chats: { path: string; body: any }[];
  /** Answer /api/models with 403 "Use of API key is not enabled". */
  apiKeysDisabled: boolean;
  close(): Promise<void>;
}

export async function startMockOpenWebUI(opts: { key?: string; models?: { id: string; owned_by?: string; name?: string }[] } = {}): Promise<MockOpenWebUI> {
  const key = opts.key ?? "sk-good";
  const models = opts.models ?? [
    { id: "llama3:8b", owned_by: "ollama" },
    { id: "gpt-oss20b-specialist", name: "GPT-OSS 20B Specialist", owned_by: "ollama" },
  ];
  const sse = (res: http.ServerResponse, chunks: object[]) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.end("data: [DONE]\n\n");
  };
  const state: MockOpenWebUI = { url: "", chats: [], apiKeysDisabled: false, close: async () => {} };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (state.apiKeysDisabled) return json(403, { detail: "Use of API key is not enabled in the environment." });
      if (req.headers.authorization !== `Bearer ${key}`) return json(401, { detail: "Not authenticated" });
      if (req.method === "GET" && url === "/api/models") return json(200, { data: models.map((m) => ({ object: "model", ...m })) });
      if (req.method === "POST" && /\/chat\/completions$/.test(url)) {
        const b = JSON.parse(body);
        state.chats.push({ path: url, body: b });
        const sys = String(b.messages?.find((m: any) => m.role === "system")?.content ?? "");
        const cwd = /Working directory: (.+)/.exec(sys)?.[1]?.trim() ?? "/work";
        const args = JSON.stringify({ filePath: `${cwd.replace(/\\/g, "/")}/README.md` });
        const base = { id: "c", object: "chat.completion.chunk", model: b.model };
        // No tools (titles), or the tool result is back: a plain answer ends the turn.
        if (!b.tools?.length || b.messages?.at(-1)?.role === "tool") return sse(res, [{ ...base, choices: [{ index: 0, delta: { content: "Done: README read." }, finish_reason: "stop" }] }]);
        return sse(res, [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } },
        ]);
      }
      json(404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return state;
}
