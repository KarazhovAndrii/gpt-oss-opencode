// Research helper: dumps the exact wire format an OpenWebUI deployment returns for
// OpenCode-shaped requests (real OpenCode tool catalog, streaming, tool-result turn).
// Works against the local replica (.local-stack/stack.json) or any deployment:
//
//   node scripts/probe-openwebui.mjs [--base http://host:8080/api] [--model gpt-oss20b-opencode] [--route /chat/completions]
//     API key: OPENWEBUI_API_KEY, else .local-stack/stack.json. Output: logs/owui-probe/<ts>/*.txt
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const state = fs.existsSync(path.join(ROOT, ".local-stack", "stack.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, ".local-stack", "stack.json"), "utf8")) : {};
const base = opt("base", process.env.OPENWEBUI_BASE_URL ?? (state.owuiUrl ? `${state.owuiUrl}/api` : "http://localhost:8080/api")).replace(/\/+$/, "");
const model = opt("model", process.env.OPENWEBUI_MODEL ?? state.presetId ?? "gpt-oss20b-opencode");
const route = opt("route", "/chat/completions");
const key = process.env.OPENWEBUI_API_KEY ?? state.apiKey;
const tools = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "opencode-tools.json"), "utf8"));
const outDir = path.join(ROOT, "logs", "owui-probe", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(outDir, { recursive: true });

const system = "You are opencode, an interactive CLI coding agent.\n<env>\n  Working directory: /work/repo\n  Platform: linux\n</env>";
const user = { role: "user", content: "Find the Python files in the repository (use the glob tool)." };

async function probe(name, body) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    console.log(`${name}: FETCH ERROR ${e}`);
    return;
  }
  const text = await res.text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  fs.writeFileSync(path.join(outDir, `${name}.txt`), `HTTP ${res.status} (${Date.now() - t0}ms)\n${headers}\n\n${text}`);
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  const deltaKeys = new Set();
  let toolDeltas = 0;
  for (const l of lines) {
    try {
      const j = JSON.parse(l.slice(5));
      const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
      Object.keys(d).forEach((k) => deltaKeys.add(k));
      if (d.tool_calls) toolDeltas++;
    } catch {}
  }
  console.log(`${name}: HTTP ${res.status} ${Date.now() - t0}ms, ${lines.length} data lines, delta keys [${[...deltaKeys]}], tool_call deltas ${toolDeltas} -> ${path.relative(ROOT, path.join(outDir, name + ".txt"))}`);
  if (!body.stream) console.log(`   body: ${text.slice(0, 600)}`);
}

console.log(`probing ${base}${route} model=${model} key=${key ? "present" : "none"}`);
await probe("1-stream-tools", { stream: true, stream_options: { include_usage: true }, tool_choice: "auto", tools, messages: [{ role: "system", content: system }, user] });
await probe("2-nonstream-tools", { stream: false, tool_choice: "auto", tools, messages: [{ role: "system", content: system }, user] });
await probe("3-stream-tool-result-turn", {
  stream: true,
  stream_options: { include_usage: true },
  tools,
  messages: [
    { role: "system", content: system },
    user,
    { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "glob", arguments: '{"pattern":"**/*.py"}' } }] },
    { role: "tool", tool_call_id: "call_abc", content: "/work/repo/app/__main__.py\n/work/repo/app/core.py" },
  ],
});
await probe("4-stream-no-tools", { stream: true, messages: [{ role: "user", content: "Say hi in three words." }] });
await probe("5-stream-stop-call", { stream: true, stop: ["<|call|>"], messages: [{ role: "system", content: system }, user] });
await probe("6-unknown-model", { model: "does-not-exist", stream: true, messages: [user] });
