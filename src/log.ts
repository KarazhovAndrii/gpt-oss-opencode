// Diagnostic JSONL logging: one file per OpenCode session under
// <logDir>/<YYYY-MM-DD>/<sessionId>.jsonl. API keys are never passed to the
// logger, and anything that looks like a credential is redacted defensively.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_\-]{12,}/g, "sk-***"],
  [/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, "$1***"],
  [/("(?:api[_-]?key|authorization|apiKey|token)"\s*:\s*")[^"]{6,}(")/gi, "$1***$2"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

/** Free text for the log: kept with content logging, otherwise only its length. */
export function logText(s: string, content: boolean, max: number): string {
  return content ? truncate(s, max) : `[${s.length} chars]`;
}

// Argument keys kept without content logging: where a tool acted and what ran, not what was written.
const LOCATION_KEYS = /^(filePath|path|pattern|include|workdir|command|description|timeout|offset|limit|replaceAll)$/;

/** Tool-call arguments for the log; without content logging, other string values become their length. */
export function logArgs(argsJson: string, content: boolean, max: number): string {
  if (content) return truncate(argsJson, max);
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return `[${argsJson.length} chars]`;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return `[${argsJson.length} chars]`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = LOCATION_KEYS.test(k) ? truncate(v, 200) : `[${v.length} chars]`;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = `[${JSON.stringify(v).length} chars]`;
  }
  return truncate(JSON.stringify(out), max);
}

/** Deletes <dir>/<YYYY-MM-DD> day folders older than `days` (0 = keep everything). Returns the days removed. */
export function pruneLogs(dir: string, days: number, now = Date.now()): string[] {
  if (!days || !fs.existsSync(dir)) return [];
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const removed: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name) || e.name >= cutoff) continue;
    try {
      fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    } catch {
      // in use or permissions: try again next time
    }
  }
  return removed;
}

export function hashOf(v: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

export class Logger {
  private dir: string;
  private enabled: boolean;
  private catalogs = new Map<string, string>();
  quiet: boolean;

  constructor(dir: string, opts: { enabled?: boolean; quiet?: boolean } = {}) {
    this.dir = dir;
    this.enabled = opts.enabled ?? true;
    this.quiet = opts.quiet ?? false;
  }

  fileFor(session: string): string {
    const day = new Date().toISOString().slice(0, 10);
    return path.join(this.dir, day, `${session.replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`);
  }

  event(session: string, type: string, data: Record<string, unknown>) {
    if (!this.enabled) return;
    const line = redact(JSON.stringify({ ts: new Date().toISOString(), type, session, ...data }));
    const file = this.fileFor(session);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + "\n");
    } catch (e) {
      if (!this.quiet) console.error(`[gpt-oss-proxy] cannot write log ${file}: ${(e as Error).message}`);
    }
  }

  /** Writes a full upstream request body next to the session log, for exact replays (GPT_OSS_DUMP_REQUESTS=1). */
  dump(session: string, name: string, data: unknown) {
    if (!this.enabled) return;
    const file = this.fileFor(session).replace(/\.jsonl$/, `.${name}.json`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, redact(JSON.stringify(data, null, 1)));
    } catch {
      // diagnostics only
    }
  }

  /** Logs the full tool catalog once per session (and again whenever it changes). */
  catalog(session: string, tools: unknown[]): string {
    const h = hashOf(tools);
    if (this.catalogs.get(session) !== h) {
      this.catalogs.set(session, h);
      this.event(session, "tool_catalog", { hash: h, tools });
    }
    return h;
  }

  console(msg: string) {
    if (!this.quiet) console.log(redact(msg));
  }
}
