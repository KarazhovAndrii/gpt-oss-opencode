// Research helper: dumps raw streaming deltas for a harmony tool-call turn, to
// see how the provider splits special tokens between reasoning_content/content.
//   node scripts/probe-stream-raw.mjs [stream|nostream]
const key = process.env.SILICONFLOW_API_KEY;
const stream = process.argv[2] !== "nostream";
const system = `You are a coding agent working in /work/repo. Use the tools.

# Tools

## functions

namespace functions {

// Find files matching a glob pattern.
type glob = (_: {
// The glob pattern to match files against
pattern: string,
path?: string,
}) => any;

// Read a file.
type read = (_: {
filePath: string,
}) => any;

} // namespace functions`;
const res = await fetch("https://api.siliconflow.com/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "openai/gpt-oss-20b",
    messages: [{ role: "system", content: system }, { role: "user", content: "Find the main Python entry point." }],
    max_tokens: 2000,
    stop: ["<|call|>"],
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  }),
});
if (!stream) {
  const j = await res.json();
  console.log(JSON.stringify(j.choices[0], null, 1));
  process.exit(0);
}
const dec = new TextDecoder();
let buf = "";
for await (const part of res.body) {
  buf += dec.decode(part, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    const j = JSON.parse(line.slice(5));
    const d = j.choices?.[0]?.delta ?? {};
    const keys = Object.entries(d).filter(([k, v]) => v !== null && v !== "" && k !== "role");
    console.log(JSON.stringify(Object.fromEntries(keys)), j.choices?.[0]?.finish_reason ?? "");
  }
}
