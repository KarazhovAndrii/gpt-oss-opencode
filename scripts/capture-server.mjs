// Research helper: an OpenAI-compatible endpoint that records every request
// OpenCode sends (headers with auth redacted, full JSON body) and replies with
// a tiny streamed answer. Used to learn OpenCode's exact provider contract.
//
//   node scripts/capture-server.mjs [port] [outDir]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.argv[2] ?? 9911);
const outDir = process.argv[3] ?? "logs/capture";
fs.mkdirSync(outDir, { recursive: true });
let n = 0;

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const headers = { ...req.headers };
      if (headers.authorization) headers.authorization = "<redacted>";
      const file = path.join(outDir, `${String(++n).padStart(3, "0")}.json`);
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      fs.writeFileSync(file, JSON.stringify({ method: req.method, url: req.url, headers, body: parsed ?? body }, null, 2));
      console.log(`${req.method} ${req.url} -> ${file}`);
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "capture", object: "model" }] }));
        return;
      }
      if (parsed?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const base = { id: "cap-1", object: "chat.completion.chunk", created: 0, model: "capture" };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "cap-1", object: "chat.completion", created: 0, model: "capture", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`capture server on http://127.0.0.1:${port}/v1`));
