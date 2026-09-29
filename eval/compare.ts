// Compares finished eval runs on their common scenarios, re-judging every run
// with the CURRENT checks (like eval/recheck.ts), and prints a markdown table.
//
//   node eval/compare.ts <runDir> <runDir> ... [--only id,id]
import fs from "node:fs";
import path from "node:path";
import { SCENARIOS } from "./scenarios.ts";
import { summarizeEvents } from "./lib/opencode.ts";
import { readProxyEvents, proxyMetrics } from "./lib/metrics.ts";

const args = process.argv.slice(2);
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(",") : undefined;
const runDirs = args.filter((a, i) => !a.startsWith("--") && !(onlyIdx >= 0 && i === onlyIdx + 1)).map((d) => path.resolve(d));

interface Row {
  id: string;
  pass: boolean;
  wallMs: number;
  tools: number;
  toolErrors: number;
  m: ReturnType<typeof proxyMetrics>;
}

function judge(runDir: string): Map<string, Row[]> {
  const res = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
  const out = new Map<string, Row[]>();
  for (const r of res.results.filter(Boolean)) {
    const sc = SCENARIOS.find((s) => s.id === r.id);
    if (!sc || (only && !only.includes(r.id))) continue;
    const dir = path.resolve(path.dirname(runDir), "..", r.dir);
    const turns = fs.readdirSync(dir).filter((f) => /^opencode-turn\d+\.jsonl$/.test(f)).sort();
    const answers: string[] = [];
    const tools: any[] = [];
    for (const t of turns) {
      const ev = fs.readFileSync(path.join(dir, t), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const s = summarizeEvents(ev, { exitCode: 0, timedOut: false, ms: 0, stderr: "" });
      answers.push(s.text);
      tools.push(...s.tools);
    }
    const proxy = readProxyEvents(path.join(dir, "proxy-logs"));
    const checks = [
      ...sc.check({ repo: path.join(dir, "repo"), fixtureDir: path.resolve(import.meta.dirname, "fixtures", sc.fixture), answers, answer: answers.at(-1) ?? "", tools, proxy }),
      ...r.checks.filter((c: any) => /time limit|isolated repo/.test(c.name)),
    ];
    const row: Row = { id: r.id, pass: checks.every((c) => c.pass), wallMs: r.wallMs, tools: tools.length, toolErrors: tools.filter((t) => t.status !== "completed").length, m: proxyMetrics(proxy) };
    out.set(r.id, [...(out.get(r.id) ?? []), row]);
  }
  return out;
}

const runs = runDirs.map((d) => ({ name: path.basename(d).replace(/^\d{4}-\d\d-\d\dT[\d-]+-/, ""), rows: judge(d) }));
const common = [...runs[0].rows.keys()].filter((id) => runs.every((r) => r.rows.has(id)));
const sum = (rows: Row[], f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
console.log(`Common scenarios (${common.length}): ${common.join(", ")}\n`);
console.log("| run | scenario runs | passed | first-attempt valid calls | tool calls (errors) | model calls | tokens in / out | cost USD | wall time | redundant hinted | proxy stops | provider errors |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const rows = common.flatMap((id) => r.rows.get(id)!);
  const proposed = sum(rows, (x) => x.m.proposedCalls);
  const invalid = sum(rows, (x) => x.m.validationFailures - (x.m.validationByCode.protocol ?? 0));
  const protocol = sum(rows, (x) => x.m.validationByCode.protocol ?? 0);
  console.log(
    `| ${r.name} | ${rows.length} | ${rows.filter((x) => x.pass).length} (${Math.round((100 * rows.filter((x) => x.pass).length) / rows.length)}%) | ${proposed ? `${(100 * (proposed - invalid) / proposed).toFixed(1)}% (${proposed - invalid}/${proposed})` : "-"}${protocol ? `, ${protocol} protocol violations` : ""} | ${sum(rows, (x) => x.tools)} (${sum(rows, (x) => x.toolErrors)}) | ${sum(rows, (x) => x.m.modelCalls)} | ${Math.round(sum(rows, (x) => x.m.promptTokens) / 1000)}K / ${Math.round(sum(rows, (x) => x.m.completionTokens) / 1000)}K | ${sum(rows, (x) => x.m.costUSD).toFixed(4)} | ${Math.round(sum(rows, (x) => x.wallMs) / 1000)}s | ${sum(rows, (x) => x.m.redundantHints)} | ${sum(rows, (x) => Object.values(x.m.guardStops).reduce((a, b) => a + b, 0))} | ${sum(rows, (x) => x.m.upstreamErrors)} |`,
  );
}
console.log("\nPer scenario (PASS/FAIL per run):\n");
console.log(`| scenario | ${runs.map((r) => r.name).join(" | ")} |`);
console.log(`|---|${runs.map(() => "---").join("|")}|`);
for (const id of common) console.log(`| ${id} | ${runs.map((r) => r.rows.get(id)!.map((x) => (x.pass ? "PASS" : "FAIL")).join(" ")).join(" | ")} |`);
