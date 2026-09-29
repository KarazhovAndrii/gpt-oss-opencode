// Research helper, round 2: tests prompt variants aimed at the "answers without
// reading" failure seen in round 1, including the harmony-style TypeScript
// namespace tool rendering that gpt-oss was trained on.
//
//   node scripts/probe-formats2.mjs [N] [variant,...]
const baseURL = process.env.PROBE_BASE_URL ?? "https://api.siliconflow.com/v1";
const model = process.env.PROBE_MODEL ?? "openai/gpt-oss-20b";
const key = process.env.SILICONFLOW_API_KEY;
const N = Number(process.argv[2] ?? 3);
const only = process.argv[3]?.split(",");

async function chat(messages, extra = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, max_tokens: 4000, ...extra }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    return { error: String(e), ms: Date.now() - t0 };
  }
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 200)}`, ms: Date.now() - t0 };
  const j = JSON.parse(text);
  const m = j.choices[0].message;
  return { content: m.content ?? "", reasoning: m.reasoning_content ?? "", usage: j.usage, ms: Date.now() - t0 };
}

const nsTools = `namespace functions {

// Read a file from the local filesystem. filePath must be absolute.
type read = (_: {
filePath: string,
offset?: number,
limit?: number,
}) => any;

// Find files matching a glob pattern.
type glob = (_: {
pattern: string,
path?: string,
}) => any;

// Run a shell command.
type bash = (_: {
command: string,
workdir?: string,
}) => any;

} // namespace functions`;

const protocol = `RESPONSE PROTOCOL (strict): every reply must be exactly one JSON object and nothing else.
To call tools: {"tool_calls": [{"name": "<tool>", "arguments": {...}}]}
To finish and answer the user: {"final": "<markdown answer>"}`;

const grounding = `Rules:
- You only know a file's contents after a tool result has shown them. A file path in a listing is NOT its content.
- If the user asks you to read, inspect, run, or change something, do it with a tool call first; never describe results you have not observed.
- Reply with "final" only when every part of the user's request has been carried out.`;

const task = "Find the main Python entry point in the repo, read it, and explain what it does.";
const globResult = "/work/repo/scripts/benchmark_main.py\n/work/repo/app/__main__.py\n/work/repo/app/core.py\n/work/repo/tests/test_core.py";
const call = '{"tool_calls": [{"name": "glob", "arguments": {"pattern": "**/*.py"}}]}';
const reminder = (req) =>
  `<system-reminder>\nUser request: ${req}\nDecide the next step. If any part of the request still needs a tool (e.g. reading a file you have only seen listed), call it now. Reply with exactly one JSON object.\n</system-reminder>`;

const variants = {
  json_grounded: {
    system: `You are a coding agent in /work/repo (Linux). You act ONLY through tools.\nAvailable tools:\n${nsTools}\n\n${grounding}\n\n${protocol}`,
    turns: [
      { role: "user", content: task },
      { role: "assistant", content: call },
      { role: "user", content: `<tool_result name="glob">\n${globResult}\n</tool_result>` },
    ],
  },
  json_grounded_reminder: {
    system: `You are a coding agent in /work/repo (Linux). You act ONLY through tools.\nAvailable tools:\n${nsTools}\n\n${grounding}\n\n${protocol}`,
    turns: [
      { role: "user", content: task },
      { role: "assistant", content: call },
      { role: "user", content: `<tool_result name="glob">\n${globResult}\n</tool_result>\n\n${reminder(task)}` },
    ],
  },
  json_native_history: {
    // Tool history rendered with the provider's native roles (accepted without `tools`).
    system: `You are a coding agent in /work/repo (Linux). You act ONLY through tools.\nAvailable tools:\n${nsTools}\n\n${grounding}\n\n${protocol}`,
    turns: [
      { role: "user", content: task },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "glob", arguments: '{"pattern":"**/*.py"}' } }] },
      { role: "tool", tool_call_id: "c1", content: globResult },
    ],
  },
};

function judge(content) {
  const c = content.trim();
  let j;
  try {
    j = JSON.parse(c.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return `unparseable:${c.slice(0, 140)}`;
  }
  const call = j.tool_calls?.[0];
  if (call?.name === "read" && /app\/__main__\.py$/.test(call.arguments?.filePath ?? "")) return "OK";
  return `wrong:${c.slice(0, 140)}`;
}

for (const [name, v] of Object.entries(variants)) {
  if (only && !only.includes(name)) continue;
  const res = [];
  let ms = 0,
    out = 0,
    n = 0;
  for (let i = 0; i < N; i++) {
    const r = await chat([{ role: "system", content: v.system }, ...v.turns]);
    if (r.error) {
      res.push(r.error);
      continue;
    }
    n++;
    ms += r.ms;
    out += r.usage?.completion_tokens ?? 0;
    res.push(judge(r.content));
  }
  console.log(`[${name}] ok=${res.filter((x) => x === "OK").length}/${N} avg ${Math.round(ms / (n || 1))}ms avg out ${Math.round(out / (n || 1))} tok`);
  res.filter((x) => x !== "OK").forEach((x) => console.log("   ", x));
}
