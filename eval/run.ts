// Evaluation harness: runs scenarios through real OpenCode + the proxy + a live
// provider, each in an isolated copy of a synthetic repository.
//
//   node eval/run.ts [--only id,id] [--skip id,id] [--strategy harmony|json|native|auto]
//                    [--profile siliconflow|custom|openwebui|<name>] [--stream true|false] [--repeat N]
//                    [--concurrency N] [--label name] [--extra-tools]
//                    [--descriptions full|compact] [--reasoning low|medium|high]
//                    [--shell bash|powershell|pwsh]
//
// Output: .eval-runs/<run>/results.json, summary.md, and per-scenario folders with
// the repo after the run, OpenCode's JSON events and the proxy diagnostics.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadConfig, type Strategy } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { Logger } from "../src/log.ts";
import { SCENARIOS, type Scenario, type Check } from "./scenarios.ts";
import { findOpenCode, isolatedHome, plainWindowsPath, runOpenCode, shellPath, type EvalShell, type ToolUse } from "./lib/opencode.ts";
import { detectShell, type ShellKind } from "../src/shell.ts";
import { readProxyEvents, proxyMetrics, validCallRate, type ProxyMetrics } from "./lib/metrics.ts";
import { startChaos } from "./lib/chaos.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k: string) => args.includes(`--${k}`);

const only = opt("only")?.split(",");
const skip = opt("skip")?.split(",") ?? [];
const strategy = opt("strategy") as Strategy | undefined;
const profileName = opt("profile", "siliconflow")!;
const streamOpt = opt("stream");
const repeat = Number(opt("repeat", "1"));
const concurrency = Number(opt("concurrency", "3"));
const extraTools = has("extra-tools");
const descriptions = opt("descriptions") as "full" | "compact" | undefined;
const reasoning = opt("reasoning") as "low" | "medium" | "high" | undefined;
// OpenCode's shell (SHELL for its process); without --shell it is inherited from the caller.
const shell = opt("shell") as EvalShell | undefined;
if (shell && !["bash", "powershell", "pwsh"].includes(shell)) throw new Error(`--shell must be bash, powershell or pwsh, not ${shell}`);
const shellExe = shell ? shellPath(shell) : undefined;
const EXPECTED_SHELL: Record<EvalShell, ShellKind> = { bash: "posix", powershell: "powershell", pwsh: "pwsh" };
// PowerShell runs get the PATH of a plain Windows machine (no Git Unix tools such as grep).
const shellPathEnv = shell && shell !== "bash" && process.platform === "win32" ? plainWindowsPath(process.env.PATH ?? "") : undefined;
const label = opt("label", `${strategy ?? "default"}${extraTools ? "+tools" : ""}${descriptions ? `-${descriptions}` : ""}${reasoning ? `-r${reasoning}` : ""}${streamOpt ? `-stream${streamOpt}` : ""}${shell ? `-${shell}` : ""}`)!;
const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label}`;
const runDir = path.join(ROOT, ".eval-runs", runId);
const sharedCache = path.join(ROOT, ".eval-runs", ".oc-cache");
const opencodeBin = findOpenCode();

// Host-suspension detector: timers do not fire while the machine sleeps, so a large
// gap between heartbeats means every timing (and provider timeout) in that window is
// meaningless. Affected scenarios are discarded and re-run.
const gaps: { at: number; ms: number }[] = [];
let lastBeat = Date.now();
const heartbeat = setInterval(() => {
  const now = Date.now();
  if (now - lastBeat > 60_000) gaps.push({ at: now, ms: now - lastBeat });
  lastBeat = now;
}, 5_000);
heartbeat.unref();
const suspendedDuring = (from: number, to: number) => gaps.filter((g) => g.at >= from && g.at - g.ms <= to).reduce((a, g) => a + g.ms, 0);

export interface ScenarioResult {
  /** Milliseconds the host was suspended during this scenario (result discarded and re-run when > 0). */
  suspendedMs?: number;
  id: string;
  run: number;
  title: string;
  covers: string[];
  pass: boolean;
  checks: Check[];
  wallMs: number;
  timedOut: boolean;
  toolCalls: number;
  toolErrors: number;
  toolsByName: Record<string, number>;
  openCodeErrors: string[];
  metrics: ProxyMetrics;
  validCallRate?: number;
  answers: string[];
  dir: string;
  /** Shell behind OpenCode's bash tool, read from the tool catalog in the proxy log. */
  shellSeen?: ShellKind;
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function git(cwd: string, ...a: string[]) {
  execFileSync("git", ["-c", "user.email=eval@local", "-c", "user.name=eval", "-c", "core.autocrlf=false", ...a], { cwd, stdio: "ignore" });
}

function placeholders(prompt: string, repo: string): string {
  const fwd = repo.replace(/\\/g, "/");
  const m = fwd.match(/^([A-Za-z]):\/(.*)$/);
  const wsl = m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : fwd;
  const gitbash = m ? `/${m[1].toLowerCase()}/${m[2]}` : fwd;
  return prompt.replaceAll("{{REPO}}", repo).replaceAll("{{REPO_WSL}}", wsl).replaceAll("{{REPO_GITBASH}}", gitbash);
}

async function runScenario(sc: Scenario, n: number): Promise<ScenarioResult> {
  const dir = path.join(runDir, `${sc.id}${repeat > 1 ? `-${n}` : ""}`);
  const repo = path.join(dir, "repo");
  const fixtureDir = path.join(ROOT, "eval", "fixtures", sc.fixture);
  copyDir(fixtureDir, repo);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");

  // Proxy, one per scenario so its diagnostics are isolated.
  const cfg = loadConfig(process.env, ROOT);
  const profile = cfg.profiles[profileName];
  if (!profile) throw new Error(`unknown profile ${profileName}`);
  if (!profile.baseURL) throw new Error(`profile ${profileName} has no base URL (set ${profileName.toUpperCase()}_BASE_URL)`);
  if (strategy) profile.strategy = strategy;
  if (streamOpt) profile.stream = streamOpt === "true";
  if (descriptions) profile.toolDescriptions = descriptions;
  if (reasoning) profile.extraBody = { ...(profile.extraBody ?? {}), reasoning_effort: reasoning };
  cfg.defaultProfile = profileName;
  cfg.logDir = path.join(dir, "proxy-logs");
  // Eval repos are synthetic: keep full content so runs can be analysed afterwards.
  cfg.logContent = true;
  Object.assign(cfg.limits, sc.proxyLimits ?? {});
  const chaos = sc.chaos ? await startChaos(profile.baseURL, sc.chaos) : undefined;
  if (chaos) profile.baseURL = chaos.url.replace(/\/v1$/, "/v1");
  const server = createServer({ cfg, logger: new Logger(cfg.logDir, { quiet: true }) });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;

  const modelId = profileName;
  const limit = sc.modelLimit ?? { context: profile.contextWindow, output: profile.maxOutputTokens };
  const ocConfig: any = {
    $schema: "https://opencode.ai/config.json",
    model: `gpt-oss/${modelId}`,
    small_model: `gpt-oss/${modelId}`,
    autoupdate: false,
    share: "disabled",
    provider: {
      "gpt-oss": {
        npm: "@ai-sdk/openai-compatible",
        name: "GPT-OSS via gpt-oss-proxy",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "unused" },
        models: { [modelId]: { name: `gpt-oss-20b (${profileName})`, tool_call: true, reasoning: true, limit, cost: profile.pricing ? { input: profile.pricing.input, output: profile.pricing.output } : undefined } },
      },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "deny", external_directory: "deny" },
  };
  const home = isolatedHome(path.join(dir, "oc"), ocConfig, sharedCache);
  if (shellExe) home.env.SHELL = shellExe;
  if (shellPathEnv) home.env.PATH = shellPathEnv;
  if (extraTools) {
    const toolDir = path.join(home.env.XDG_CONFIG_HOME, "opencode", "tool");
    copyDir(path.join(ROOT, "opencode", "tool"), toolDir);
  }

  const t0 = Date.now();
  const answers: string[] = [];
  const tools: ToolUse[] = [];
  const openCodeErrors: string[] = [];
  let sessionId: string | undefined;
  let timedOut = false;
  const perTurnTimeout = sc.timeoutMs === 0 ? 0 : Math.floor((sc.timeoutMs ?? 420_000) / Math.max(1, sc.turns.length)) + 60_000;
  for (const [i, turn] of sc.turns.entries()) {
    const r = await runOpenCode({ bin: opencodeBin, cwd: repo, env: home.env, model: `gpt-oss/${modelId}`, prompt: placeholders(turn, repo), sessionId, timeoutMs: perTurnTimeout });
    fs.writeFileSync(path.join(dir, `opencode-turn${i + 1}.jsonl`), r.events.map((e) => JSON.stringify(e)).join("\n"));
    if (r.stderr.trim()) fs.writeFileSync(path.join(dir, `opencode-turn${i + 1}.stderr.txt`), r.stderr);
    sessionId ??= r.sessionId;
    answers.push(r.text);
    tools.push(...r.tools);
    openCodeErrors.push(...r.errors);
    if (r.timedOut) {
      timedOut = true;
      openCodeErrors.push(`turn ${i + 1} timed out after ${perTurnTimeout}ms`);
      break;
    }
  }
  const wallMs = Date.now() - t0;
  const suspendedMs = suspendedDuring(t0, Date.now());
  const closed = new Promise<void>((ok) => server.close(() => ok()));
  server.closeAllConnections();
  await closed;
  await chaos?.close();

  const proxy = readProxyEvents(cfg.logDir);
  let checks: Check[];
  try {
    checks = sc.check({ repo, fixtureDir, answers, answer: answers.at(-1) ?? "", tools, proxy });
  } catch (e) {
    checks = [{ name: "checks crashed", pass: false, detail: String((e as Error).stack ?? e) }];
  }
  if (timedOut) checks.push({ name: "finished within the time limit", pass: false });
  // Isolation invariant: OpenCode must have worked inside the scenario's repo copy.
  const cwds = [...new Set(proxy.filter((e) => e.type === "request" && e.cwd).map((e) => path.resolve(e.cwd)))];
  const isolated = cwds.length > 0 && cwds.every((c) => c.toLowerCase() === path.resolve(repo).toLowerCase());
  checks.push({ name: "OpenCode worked inside the isolated repo", pass: isolated, detail: isolated ? undefined : `cwd(s): ${cwds.join(", ")}` });
  const metrics = proxyMetrics(proxy);
  const catalog = proxy.find((e) => e.type === "tool_catalog");
  const shellSeen = catalog ? detectShell(catalog.tools ?? []) : undefined;
  if (shell && shellSeen && shellSeen !== EXPECTED_SHELL[shell]) console.error(`!!! ${sc.id}: --shell ${shell} requested, but OpenCode's bash tool runs ${shellSeen} (SHELL=${shellExe})`);
  const toolsByName: Record<string, number> = {};
  for (const t of tools) toolsByName[t.tool] = (toolsByName[t.tool] ?? 0) + 1;
  const result: ScenarioResult = {
    id: sc.id,
    run: n,
    title: sc.title,
    covers: sc.covers,
    pass: checks.every((c) => c.pass),
    checks,
    wallMs,
    timedOut,
    toolCalls: tools.length,
    toolErrors: tools.filter((t) => t.status !== "completed").length,
    toolsByName,
    openCodeErrors,
    metrics,
    validCallRate: validCallRate(metrics),
    suspendedMs: suspendedMs || undefined,
    answers,
    dir: path.relative(ROOT, dir),
    shellSeen,
  };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  const mark = result.pass ? "PASS" : "FAIL";
  console.log(
    `${mark} ${sc.id}${repeat > 1 ? `#${n}` : ""}  ${(wallMs / 1000).toFixed(0)}s  tools=${result.toolCalls} modelCalls=${metrics.modelCalls} tok=${metrics.promptTokens}/${metrics.completionTokens} $${metrics.costUSD.toFixed(4)} invalid=${metrics.validationFailures} redundant=${metrics.redundantHints + metrics.redundantPassthrough} stops=${JSON.stringify(metrics.guardStops)}`,
  );
  for (const c of checks.filter((c) => !c.pass)) console.log(`     x ${c.name}${c.detail ? `: ${c.detail.replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
  return result;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k]);
        } catch (e) {
          console.error(`scenario crashed: ${(e as Error).stack}`);
          out[k] = undefined as R;
        }
      }
    }),
  );
  return out;
}

function summarize(results: ScenarioResult[]): string {
  const rs = results.filter(Boolean);
  const sum = (f: (r: ScenarioResult) => number) => rs.reduce((a, r) => a + f(r), 0);
  const passed = rs.filter((r) => r.pass).length;
  const checks = rs.flatMap((r) => r.checks);
  const proposed = sum((r) => r.metrics.proposedCalls);
  const invalid = sum((r) => r.metrics.validationFailures - (r.metrics.validationByCode.protocol ?? 0));
  const lines = [
    `# Eval run ${runId}`,
    "",
    `strategy=${strategy ?? "(profile default)"} profile=${profileName} stream=${streamOpt ?? "(profile default)"} descriptions=${descriptions ?? "(profile default)"} reasoning=${reasoning ?? "(provider default)"} extraTools=${extraTools} repeat=${repeat} shell=${shell ? `${shell} (${shellExe})` : "(inherited)"}${shellPathEnv ? " PATH=plain Windows (no Git Unix tools)" : ""} shellSeen=${[...new Set(rs.map((r) => r.shellSeen ?? "?"))].join(",")}`,
    "",
    `| metric | value |`,
    `|---|---|`,
    `| scenarios passed | ${passed}/${rs.length} (${((100 * passed) / Math.max(1, rs.length)).toFixed(0)}%) |`,
    `| checks passed | ${checks.filter((c) => c.pass).length}/${checks.length} |`,
    `| first-attempt valid tool-call rate | ${proposed ? ((100 * (proposed - invalid)) / proposed).toFixed(1) : "-"}% (${proposed - invalid}/${proposed}) |`,
    `| tool calls executed by OpenCode | ${sum((r) => r.toolCalls)} (errors: ${sum((r) => r.toolErrors)}) |`,
    `| model calls | ${sum((r) => r.metrics.modelCalls)} |`,
    `| tokens (prompt/completion) | ${sum((r) => r.metrics.promptTokens)} / ${sum((r) => r.metrics.completionTokens)} |`,
    `| cost (USD) | ${sum((r) => r.metrics.costUSD).toFixed(4)} |`,
    `| wall time | ${(sum((r) => r.wallMs) / 1000).toFixed(0)}s (avg ${(sum((r) => r.wallMs) / 1000 / Math.max(1, rs.length)).toFixed(0)}s) |`,
    `| redundant calls (hinted/passed) | ${sum((r) => r.metrics.redundantHints)}/${sum((r) => r.metrics.redundantPassthrough)} |`,
    `| non-PowerShell commands (re-prompted/run) | ${sum((r) => r.metrics.shellReprompts ?? 0)}/${sum((r) => r.metrics.shellPassthrough ?? 0)} |`,
    `| guard stops | ${sum((r) => Object.values(r.metrics.guardStops).reduce((a, b) => a + b, 0))} |`,
    `| upstream errors (retried or reported) | ${sum((r) => r.metrics.upstreamErrors)} (rate-limit backoff ${(sum((r) => r.metrics.backoffMs ?? 0) / 1000).toFixed(0)}s) |`,
    `| uncorrelated tool results | ${sum((r) => r.metrics.uncorrelatedResults)} |`,
    "",
    `| scenario | pass | checks | time | tools | model calls | tokens in/out | cost | invalid | repairs | redundant | stops |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rs.map(
      (r) =>
        `| ${r.id}${repeat > 1 ? `#${r.run}` : ""} | ${r.pass ? "PASS" : "FAIL"} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} | ${(r.wallMs / 1000).toFixed(0)}s | ${r.toolCalls} | ${r.metrics.modelCalls} | ${r.metrics.promptTokens}/${r.metrics.completionTokens} | ${r.metrics.costUSD.toFixed(4)} | ${r.metrics.validationFailures} | ${r.metrics.argRepairs} | ${r.metrics.redundantHints + r.metrics.redundantPassthrough} | ${Object.entries(r.metrics.guardStops).map(([k, v]) => `${k}:${v}`).join(" ") || "-"} |`,
    ),
    "",
    "## Failed checks",
    ...rs.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- **${r.id}${repeat > 1 ? `#${r.run}` : ""}**: ${c.name}${c.detail ? ` — ${c.detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`)),
  ];
  return lines.join("\n");
}

/** Fingerprint of the implementation tree, to catch agents escaping their sandbox repo. */
function treeFingerprint(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", ".eval-runs", "logs", ".local-stack"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out.set(path.relative(ROOT, full), `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(ROOT);
  return out;
}

const selected = SCENARIOS.filter((s) => (!only || only.includes(s.id)) && !skip.includes(s.id));
if (!selected.length) {
  console.error(`no scenarios selected; available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}
fs.mkdirSync(runDir, { recursive: true });
console.log(`eval run ${runId}: ${selected.length} scenario(s) x ${repeat}, concurrency ${concurrency}, opencode=${opencodeBin}, shell=${shellExe ?? `(inherited SHELL=${process.env.SHELL ?? ""})`}`);
const jobs = selected.flatMap((s) => Array.from({ length: repeat }, (_, i) => ({ s, n: i + 1 })));
const before = treeFingerprint();
async function runValid(sc: Scenario, n: number): Promise<ScenarioResult> {
  for (let attempt = 1; ; attempt++) {
    const r = await runScenario(sc, n);
    if (!r?.suspendedMs || attempt >= 3) return r;
    console.log(`   ~ ${sc.id}: host was suspended for ${Math.round(r.suspendedMs / 1000)}s during the run; result discarded, re-running (attempt ${attempt + 1})`);
    fs.renameSync(path.join(ROOT, r.dir), path.join(ROOT, `${r.dir}.suspended-${attempt}`));
  }
}
const results = await pool(jobs, concurrency, (j) => runValid(j.s, j.n));
const after = treeFingerprint();
const touched = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
if (touched.length) console.error(`
!!! WARNING: files in the implementation tree changed during the eval run: ${touched.join(", ")}
`);
fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ runId, strategy, profile: profileName, stream: streamOpt, descriptions, reasoning, extraTools, repeat, shell, shellExe, results }, null, 2));
const md = summarize(results);
fs.writeFileSync(path.join(runDir, "summary.md"), md);
console.log(`\n${md}\n\nresults: ${path.relative(ROOT, runDir)}`);
