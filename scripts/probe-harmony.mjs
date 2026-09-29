// Research helper, round 3: harmony-native tool calling on a provider that
// rejects `tools`. Tools are rendered as the harmony TypeScript namespace in the
// system prompt, generation is stopped at <|call|>, and history is sent with
// native assistant.tool_calls / role=tool messages (which the provider accepts).
//
//   node scripts/probe-harmony.mjs [N] [stream]
const baseURL = process.env.PROBE_BASE_URL ?? "https://api.siliconflow.com/v1";
const model = process.env.PROBE_MODEL ?? "openai/gpt-oss-20b";
const key = process.env.SILICONFLOW_API_KEY;
const N = Number(process.argv[2] ?? 3);
const stream = process.argv[3] === "stream";

const ns = `# Tools

## functions

namespace functions {

// Read a file from the local filesystem. filePath must be absolute.
type read = (_: {
// Absolute path of the file
filePath: string,
// 1-indexed line to start from
offset?: number,
limit?: number,
}) => any;

// Find files matching a glob pattern.
type glob = (_: {
pattern: string,
path?: string,
}) => any;

} // namespace functions`;

const system = `You are a coding agent working in /work/repo (Linux). Use the tools to act; do not guess file contents.\n\n${ns}`;

async function chat(messages) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 4000, stop: ["<|call|>"], stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    return { error: String(e) };
  }
  if (!res.ok) return { error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
  if (!stream) {
    const j = await res.json();
    const m = j.choices[0].message;
    return { content: m.content ?? "", reasoning: m.reasoning_content ?? "", usage: j.usage, finish: j.choices[0].finish_reason, ms: Date.now() - t0 };
  }
  let buf = "",
    content = "",
    reasoning = "",
    usage,
    finish;
  const dec = new TextDecoder();
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      const j = JSON.parse(line.slice(5));
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta ?? {};
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      content += d.content ?? "";
      reasoning += d.reasoning_content ?? "";
    }
  }
  return { content, reasoning, usage, finish, ms: Date.now() - t0 };
}

// Parse the last harmony tool call in raw text.
function parseCall(text) {
  const re = /to=(?:functions\.)?([A-Za-z0-9_\-]+)[^<]*?(?:<\|constrain\|>\s*\w+\s*)?<\|message\|>([\s\S]*)$/;
  const idx = text.lastIndexOf("to=");
  if (idx < 0) return null;
  const m = text.slice(idx).match(re);
  if (!m) return { raw: text.slice(idx, idx + 200) };
  let args;
  try {
    args = JSON.parse(m[2].trim());
  } catch {
    return { name: m[1], badArgs: m[2].slice(0, 200) };
  }
  return { name: m[1], args };
}

const task = "Find the main Python entry point in the repo, read it, and explain what it does.";
const globResult = "/work/repo/scripts/benchmark_main.py\n/work/repo/app/__main__.py\n/work/repo/app/core.py\n/work/repo/tests/test_core.py";
const mainPy =
  "1: from app.core import run_pipeline\n2: \n3: def main():\n4:     # Loads zebra.csv, counts rows per species, prints BANANA-42 summary\n5:     run_pipeline('zebra.csv')\n6: \n7: if __name__ == '__main__':\n8:     main()\n";

const step1 = [{ role: "system", content: system }, { role: "user", content: task }];
const step2 = [
  ...step1,
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"**/*.py"}' } }] },
  { role: "tool", tool_call_id: "c1", content: globResult },
];
const step3 = [
  ...step2,
  { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: '{"filePath":"/work/repo/app/__main__.py"}' } }] },
  { role: "tool", tool_call_id: "c2", content: mainPy },
];

for (const [label, msgs] of [
  ["step1 (expect glob)", step1],
  ["step2 (expect read app/__main__.py)", step2],
  ["step3 (expect grounded final answer)", step3],
]) {
  console.log(`\n##### ${label}${stream ? " [stream]" : ""}`);
  for (let i = 0; i < N; i++) {
    const r = await chat(msgs);
    if (r.error) {
      console.log("  ERROR", r.error);
      continue;
    }
    const call = parseCall(r.reasoning + "\n" + r.content);
    const where = r.content.includes("to=") ? "content" : r.reasoning.includes("to=") ? "reasoning" : "-";
    console.log(
      `  [${r.ms}ms out=${r.usage?.completion_tokens} finish=${r.finish}] call@${where}: ${JSON.stringify(call)} | content: ${JSON.stringify(r.content.slice(0, 160))}`,
    );
    if (i === 0) console.log("    reasoning tail:", JSON.stringify(r.reasoning.slice(-260)));
  }
}
