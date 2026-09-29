// Replays a dumped upstream request (GPT_OSS_DUMP_REQUESTS=1) N times, with
// optional parameter overrides, and classifies each harmony reply. Used to
// measure prompt/sampling changes against real provider behaviour.
//
//   node scripts/replay.ts <dump.json> [N] [key=value ...]
//   e.g. node scripts/replay.ts logs/.../req_x-0.json 8 temperature=0.6
import fs from "node:fs";
import { loadConfig } from "../src/config.ts";
import { callModel } from "../src/upstream.ts";
import { interpretHarmony } from "../src/harmony.ts";
import { validateToolCall } from "../src/toolcall.ts";
import { findWorkingDirectory } from "../src/messages.ts";

const [file, nArg, ...overrides] = process.argv.slice(2);
const dump = JSON.parse(fs.readFileSync(file, "utf8"));
const cfg = loadConfig();
const profile = cfg.profiles[dump.profile ?? cfg.defaultProfile];
const body = { ...dump.body };
for (const o of overrides) {
  const [k, v] = o.split("=");
  body[k] = v === "delete" ? undefined : isNaN(Number(v)) ? v : Number(v);
}
const tools = (dump.tools ?? []) as any[];
const cwd = findWorkingDirectory(body.messages);
const N = Number(nArg ?? 5);
const tally: Record<string, number> = {};
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  try {
    const r = await callModel({ profile, limits: cfg.limits, body });
    const turn = interpretHarmony(r.reasoning, r.content);
    let kind: string;
    let detail = "";
    if (turn.call) {
      const v = tools.length ? validateToolCall({ name: turn.call.name, args: turn.call.args }, tools, cwd) : undefined;
      kind = v && !v.ok ? `invalid_call:${v.code}` : `call:${turn.call.name}`;
      detail = turn.call.args.slice(0, 160);
      if (!turn.reasoning) kind += "(no-analysis)";
    } else if (turn.text) {
      kind = "final";
      detail = turn.text.slice(0, 160).replace(/\n/g, " ");
    } else kind = "empty";
    tally[kind] = (tally[kind] ?? 0) + 1;
    console.log(`#${i + 1} ${Date.now() - t0}ms out=${r.usage?.completion_tokens} ${kind} ${detail}`);
  } catch (e) {
    tally.error = (tally.error ?? 0) + 1;
    console.log(`#${i + 1} ERROR ${(e as Error).message}`);
  }
}
console.log("tally:", JSON.stringify(tally));
