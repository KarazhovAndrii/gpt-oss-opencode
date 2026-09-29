// Research helper: probes what an OpenAI-compatible provider really supports
// for gpt-oss (native tools, streaming tool deltas, response_format, reasoning
// fields, usage). Prints a compact report; never prints the API key.
//
//   node scripts/probe-provider.mjs [baseURL] [model] [envVarForKey]
const baseURL = process.argv[2] ?? "https://api.siliconflow.com/v1";
const model = process.argv[3] ?? "openai/gpt-oss-20b";
const key = process.env[process.argv[4] ?? "SILICONFLOW_API_KEY"];

const tools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file from the local filesystem.",
      parameters: {
        type: "object",
        properties: { filePath: { type: "string", description: "Absolute path" }, limit: { type: "integer" } },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  },
];
const sys = { role: "system", content: "You are a coding agent. Working directory: /work/repo. Use tools to act." };

async function call(name, body) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, ...body }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    console.log(`\n### ${name}: FETCH ERROR ${e}`);
    return;
  }
  const ms = Date.now() - t0;
  if (!body.stream) {
    const text = await res.text();
    console.log(`\n### ${name}: HTTP ${res.status} in ${ms}ms`);
    try {
      const j = JSON.parse(text);
      const m = j.choices?.[0]?.message;
      console.log(" finish:", j.choices?.[0]?.finish_reason, "| usage:", JSON.stringify(j.usage));
      console.log(" message keys:", Object.keys(m ?? {}).join(","));
      console.log(" content:", JSON.stringify(m?.content)?.slice(0, 400));
      console.log(" reasoning:", JSON.stringify(m?.reasoning_content ?? m?.reasoning)?.slice(0, 200));
      console.log(" tool_calls:", JSON.stringify(m?.tool_calls)?.slice(0, 600));
    } catch {
      console.log(" body:", text.slice(0, 500));
    }
    return;
  }
  console.log(`\n### ${name}: HTTP ${res.status} (headers in ${ms}ms)`);
  if (!res.ok) {
    console.log(" body:", (await res.text()).slice(0, 500));
    return;
  }
  const dec = new TextDecoder();
  let buf = "";
  const deltaKeys = new Set();
  let content = "",
    reasoning = "",
    finish = null,
    usage = null,
    chunks = 0;
  const tc = {};
  const tcChunks = [];
  for await (const part of res.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      chunks++;
      const j = JSON.parse(data);
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta ?? {};
      Object.keys(d).forEach((k) => deltaKeys.add(k));
      if (d.content) content += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.reasoning) reasoning += d.reasoning;
      for (const t of d.tool_calls ?? []) {
        tcChunks.push(t);
        const e = (tc[t.index ?? 0] ??= { id: null, name: "", args: "" });
        if (t.id) e.id = t.id;
        if (t.function?.name) e.name += t.function.name;
        if (t.function?.arguments) e.args += t.function.arguments;
      }
    }
  }
  console.log(` total ${Date.now() - t0}ms, ${chunks} chunks, finish=${finish}, delta keys: ${[...deltaKeys].join(",")}`);
  console.log(" usage:", JSON.stringify(usage));
  console.log(" content:", JSON.stringify(content).slice(0, 400));
  console.log(" reasoning:", JSON.stringify(reasoning).slice(0, 200));
  console.log(" tool_calls:", JSON.stringify(Object.values(tc)));
  console.log(" first tool chunks:", JSON.stringify(tcChunks.slice(0, 3)));
}

const which = process.argv[5] ?? "all";
const user = { role: "user", content: "Find the Python entry point in the repo and read it." };
if (which === "all" || which === "native")
  await call("native tools, non-stream", { messages: [sys, user], tools, tool_choice: "auto", max_tokens: 2000 });
if (which === "all" || which === "native-stream")
  await call("native tools, stream", {
    messages: [sys, user],
    tools,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 2000,
  });
if (which === "all" || which === "required")
  await call("tool_choice=required", { messages: [sys, user], tools, tool_choice: "required", max_tokens: 2000 });
if (which === "all" || which === "history")
  await call("tool history continuation, stream", {
    messages: [
      sys,
      user,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "glob", arguments: '{"pattern":"**/*.py"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "/work/repo/app/main.py\n/work/repo/tests/test_main.py" },
    ],
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 2000,
  });
const envelope = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["tool", "final"] },
    tool: { type: "string" },
    arguments: { type: "object" },
    message: { type: "string" },
  },
  required: ["action"],
};
if (which === "all" || which === "json_schema")
  await call("response_format json_schema", {
    messages: [
      { role: "system", content: sys.content + ' Reply ONLY with JSON: {"action":"tool","tool":"glob","arguments":{...}} or {"action":"final","message":"..."}. Tools: read(filePath), glob(pattern).' },
      user,
    ],
    response_format: { type: "json_schema", json_schema: { name: "step", strict: true, schema: envelope } },
    max_tokens: 2000,
  });
if (which === "all" || which === "json_object")
  await call("response_format json_object, stream", {
    messages: [
      { role: "system", content: sys.content + ' Reply ONLY with JSON: {"action":"tool","tool":"glob","arguments":{...}} or {"action":"final","message":"..."}. Tools: read(filePath), glob(pattern).' },
      user,
    ],
    response_format: { type: "json_object" },
    stream: true,
    max_tokens: 2000,
  });
if (which === "all" || which === "reasoning")
  await call("reasoning_effort=low, no tools", {
    messages: [{ role: "user", content: "What is 17*23? Answer with the number." }],
    reasoning_effort: "low",
    max_tokens: 500,
  });
