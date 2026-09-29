// Re-applies the current scenario checks to a finished eval run (saved repo
// state, OpenCode events and proxy logs) without calling any model. Used when a
// check itself is corrected, so earlier runs can be re-judged consistently.
//
//   node eval/recheck.ts .eval-runs/<run>
import fs from "node:fs";
import path from "node:path";
import { SCENARIOS, type Check } from "./scenarios.ts";
import { summarizeEvents } from "./lib/opencode.ts";
import { readProxyEvents } from "./lib/metrics.ts";

const runDir = path.resolve(process.argv[2] ?? "");
const results = JSON.parse(fs.readFileSync(path.join(runDir, "results.json"), "utf8"));
let passed = 0;
const rows: string[] = [];
for (const r of results.results.filter(Boolean)) {
  const sc = SCENARIOS.find((s) => s.id === r.id);
  if (!sc) continue;
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
  let checks: Check[] = sc.check({ repo: path.join(dir, "repo"), fixtureDir: path.resolve(import.meta.dirname, "fixtures", sc.fixture), answers, answer: answers.at(-1) ?? "", tools, proxy });
  // Keep harness-level checks from the original run (time limit, isolation).
  checks = [...checks, ...r.checks.filter((c: Check) => /time limit|isolated repo/.test(c.name))];
  const pass = checks.every((c) => c.pass);
  if (pass) passed++;
  const changed = pass !== r.pass ? `  (was ${r.pass ? "PASS" : "FAIL"})` : "";
  rows.push(`${pass ? "PASS" : "FAIL"} ${r.id}${changed}${checks.filter((c) => !c.pass).map((c) => `\n     x ${c.name}`).join("")}`);
}
console.log(rows.join("\n"));
console.log(`\nrechecked: ${passed}/${rows.length} passed (${path.basename(runDir)})`);
