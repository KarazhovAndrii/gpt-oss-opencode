// Research helper: compares candidate text protocols for emulated tool calls on
// a provider without native function calling. Runs each format N times on the
// same task and reports how often the reply is a well-formed, correct call.
//
//   node scripts/probe-formats.mjs [N]
const baseURL = process.env.PROBE_BASE_URL ?? "https://api.siliconflow.com/v1";
const model = process.env.PROBE_MODEL ?? "openai/gpt-oss-20b";
const key = process.env.SILICONFLOW_API_KEY;
const N = Number(process.argv[2] ?? 3);

async function chat(messages, extra = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 3000, ...extra }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    return { error: String(e), ms: Date.now() - t0 };
  }
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 200)}`, ms: Date.now() - t0 };
  const j = JSON.parse(text);
  const m = j.choices[0].message;
  return { content: m.content ?? "", reasoning: m.reasoning_content ?? "", usage: j.usage, ms: Date.now() - t0, finish: j.choices[0].finish_reason };
}

const toolsText = `read(filePath: string, offset?: integer, limit?: integer) - Read a file. filePath must be absolute.
glob(pattern: string, path?: string) - Find files matching a glob pattern.
bash(command: string, workdir?: string) - Run a shell command.`;

const history = (fmt) => {
  const call =
    fmt === "tagged"
      ? '<tool_call>\n{"name": "glob", "arguments": {"pattern": "**/*.py"}}\n</tool_call>'
      : '{"tool_calls": [{"name": "glob", "arguments": {"pattern": "**/*.py"}}]}';
  return [
    { role: "user", content: "Find the main Python entry point in the repo, read it, and explain what it does." },
    { role: "assistant", content: call },
    {
      role: "user",
      content:
        '<tool_result name="glob">\n/work/repo/scripts/benchmark_main.py\n/work/repo/app/__main__.py\n/work/repo/app/core.py\n/work/repo/tests/test_core.py\n</tool_result>',
    },
  ];
};

const formats = {
  json: `You are a coding agent operating in /work/repo (Linux). You act ONLY through tools.
Available tools:
${toolsText}

RESPONSE PROTOCOL (strict): every reply must be exactly one JSON object and nothing else.
To call tools: {"tool_calls": [{"name": "<tool>", "arguments": {...}}]}
To finish and answer the user: {"final": "<markdown answer>"}
Never describe an action instead of calling the tool. Only answer with "final" when the task is complete.`,
  tagged: `You are a coding agent operating in /work/repo (Linux). You act ONLY through tools.
Available tools:
${toolsText}

To call a tool, output one block per call:
<tool_call>
{"name": "<tool>", "arguments": {...}}
</tool_call>
Output nothing else when calling tools. When the task is complete, reply with the final answer as plain text (no tool_call blocks).`,
};

function judge(fmt, content) {
  const c = content.trim();
  try {
    if (fmt === "json") {
      const j = JSON.parse(c.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      const call = j.tool_calls?.[0];
      return call?.name === "read" && /app\/__main__\.py$/.test(call.arguments?.filePath ?? "") ? "OK" : `wrong:${c.slice(0, 120)}`;
    }
    const m = c.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
    if (!m) return `no-block:${c.slice(0, 120)}`;
    const j = JSON.parse(m[1]);
    return j.name === "read" && /app\/__main__\.py$/.test(j.arguments?.filePath ?? "") ? "OK" : `wrong:${m[1].slice(0, 120)}`;
  } catch (e) {
    return `unparseable:${c.slice(0, 160)}`;
  }
}

if (!process.env.SKIP_ROLES) {
// 1. Which roles does the provider accept without `tools`?
for (const [name, msgs] of Object.entries({
  "developer role": [{ role: "developer", content: "Answer briefly." }, { role: "user", content: "Say hi" }],
  "tool role w/o tools param": [
    { role: "user", content: "Read x" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"filePath":"/x"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "hello" },
  ],
})) {
  const r = await chat(msgs, { max_tokens: 200 });
  console.log(`[roles] ${name}: ${r.error ?? "ok -> " + JSON.stringify(r.content).slice(0, 100)}`);
}

}
// 2. Protocol format reliability on step 2 of a discovery task (misleading filename present).
for (const fmt of Object.keys(formats)) {
  const results = [];
  let ms = 0,
    out = 0;
  for (let i = 0; i < N; i++) {
    const r = await chat([{ role: "system", content: formats[fmt] }, ...history(fmt)]);
    if (r.error) {
      results.push(r.error);
      continue;
    }
    ms += r.ms;
    out += r.usage?.completion_tokens ?? 0;
    results.push(judge(fmt, r.content));
  }
  console.log(`[format ${fmt}] ok=${results.filter((x) => x === "OK").length}/${N} avg ${Math.round(ms / N)}ms avg out ${Math.round(out / N)} tok`);
  results.filter((x) => x !== "OK").forEach((x) => console.log("   ", x));
}
