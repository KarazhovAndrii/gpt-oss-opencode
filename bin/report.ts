#!/usr/bin/env node
// Summarizes gpt-oss-proxy diagnostics for an agent session and flags
// abnormal behaviour (invalid calls, loops, retries, failures, waste).
//
//   node bin/report.ts --latest                 most recent session in ./logs
//   node bin/report.ts --session ses_abc        a session by id (searches ./logs)
//   node bin/report.ts <file.jsonl | directory> one log file, or every session under a directory
//   options: --logs DIR  --json  --brief

import fs from "node:fs";
import path from "node:path";
import { analyze, timeline } from "../src/sessionreport.ts";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k: string) => args.includes(`--${k}`);
const logRoot = path.resolve(opt("logs") ?? process.env.GPT_OSS_LOG_DIR ?? "logs");

function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function load(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function render(file: string, ev: any[]) {
  const a = analyze(ev);
  if (has("json")) {
    console.log(JSON.stringify({ file, ...a }, null, 2));
    return;
  }
  console.log(`\n=== session ${a.session}  (${path.relative(process.cwd(), file)})`);
  console.log(`provider profile: ${a.profile}  model: ${a.model}  strategy: ${a.strategy ?? "-"}${a.route ? `  route: ${a.route}` : ""}`);
  if (a.span) console.log(`time: ${a.span.start} → ${a.span.end} (${a.span.seconds}s, model time ${a.modelSeconds}s)`);
  console.log(`requests: ${a.requests} (${a.toolRequests} with tools)  model calls: ${a.modelCalls}  tool calls emitted: ${a.toolCallsEmitted}  results received: ${a.toolResults}`);
  console.log(`tokens: ${a.usage.prompt} in / ${a.usage.completion} out   cost: $${a.costUSD.toFixed(5)}`);
  if (!has("brief")) {
    console.log("\n-- timeline");
    for (const l of timeline(ev)) console.log(l);
  }
  console.log("\n-- abnormalities");
  if (!a.flags.length) console.log("none detected");
  const order = { high: 0, medium: 1, low: 2 };
  for (const f of a.flags.sort((x, y) => order[x.severity] - order[y.severity])) console.log(`[${f.severity}] ${f.message}`);
}

let files: string[] = [];
const target = args.find((a, i) => !a.startsWith("--") && !["logs", "session"].includes(args[i - 1]?.replace(/^--/, "") ?? ""));
if (has("latest")) {
  const all = listSessionFiles(logRoot).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
  files = all.slice(0, 1);
} else if (opt("session")) {
  files = listSessionFiles(logRoot).filter((f) => path.basename(f).startsWith(opt("session")!));
} else if (target) {
  const p = path.resolve(target);
  files = fs.statSync(p).isDirectory() ? listSessionFiles(p) : [p];
}
if (!files.length) {
  console.error("no session logs found. usage: node bin/report.ts --latest | --session ID | <file.jsonl|dir> [--logs DIR] [--json] [--brief]");
  process.exit(1);
}
for (const f of files) render(f, load(f));
