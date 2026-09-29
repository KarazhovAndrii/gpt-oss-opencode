// Research helper: prints the reasoning trace for one variant from probe-formats2
// so we can see why the model skips a required tool call.
const baseURL = "https://api.siliconflow.com/v1", model = "openai/gpt-oss-20b", key = process.env.SILICONFLOW_API_KEY;
const sys = process.argv[2] === "plain"
  ? `You are a coding agent in /work/repo (Linux). You act ONLY through tools.
Available tools:
read(filePath: string) - Read a file (absolute path).
glob(pattern: string) - Find files by glob.

RESPONSE PROTOCOL (strict): every reply must be exactly one JSON object and nothing else.
To call tools: {"tool_calls": [{"name": "<tool>", "arguments": {...}}]}
To finish and answer the user: {"final": "<markdown answer>"}`
  : process.argv[2];
const msgs = [
  { role: "system", content: sys },
  { role: "user", content: "Find the main Python entry point in the repo, read it, and explain what it does." },
  { role: "assistant", content: '{"tool_calls": [{"name": "glob", "arguments": {"pattern": "**/*.py"}}]}' },
  { role: "user", content: '<tool_result name="glob">\n/work/repo/scripts/benchmark_main.py\n/work/repo/app/__main__.py\n/work/repo/app/core.py\n/work/repo/tests/test_core.py\n</tool_result>' },
];
for (let i = 0; i < Number(process.argv[3] ?? 2); i++) {
  const r = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: msgs, max_tokens: 4000 }), signal: AbortSignal.timeout(90000) }).then(r => r.json()).catch(e => ({ error: String(e) }));
  if (r.error) { console.log(r.error); continue; }
  const m = r.choices[0].message;
  console.log("=== REASONING:\n" + (m.reasoning_content ?? "").slice(0, 1500) + "\n=== CONTENT:\n" + (m.content ?? "").slice(0, 300) + "\n");
}
