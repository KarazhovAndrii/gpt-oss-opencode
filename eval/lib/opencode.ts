// Runs the real OpenCode CLI headlessly (`opencode run --format json`) in an
// isolated home/config/data directory and returns its JSON event stream.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function findOpenCode(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
    path.join(os.homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "opencode";
}

export interface ToolUse {
  tool: string;
  input: any;
  status: string;
  output: string;
  error?: string;
  ts: number;
}

export interface OpenCodeRun {
  sessionId?: string;
  events: any[];
  tools: ToolUse[];
  /** Text parts of the final assistant message(s) of this run. */
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  stderr: string;
  errors: string[];
  steps: number;
  tokens: { input: number; output: number; reasoning: number };
}

export interface IsolatedHome {
  root: string;
  env: Record<string, string>;
}

/** Creates an isolated HOME + XDG layout; seeds ripgrep so OpenCode never downloads it mid-run. */
export function isolatedHome(root: string, opencodeConfig: object, sharedCache: string): IsolatedHome {
  const home = path.join(root, "home");
  const cfgDir = path.join(root, "xdg-config", "opencode");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
  fs.mkdirSync(path.join(sharedCache, "opencode", "bin"), { recursive: true });
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  const seeded = path.join(sharedCache, "opencode", "bin", rgName);
  if (!fs.existsSync(seeded)) {
    const known = [path.join(os.homedir(), ".cache", "opencode", "bin", rgName), path.join(os.homedir(), ".local", "share", "opencode", "bin", rgName)];
    const src = known.find((k) => fs.existsSync(k));
    if (src) fs.copyFileSync(src, seeded);
  }
  return {
    root,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_STATE_HOME: path.join(root, "xdg-state"),
      XDG_CACHE_HOME: sharedCache,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    },
  };
}

function killTree(pid: number) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function runOpenCode(opts: { bin: string; cwd: string; env: Record<string, string>; model: string; prompt: string; sessionId?: string; timeoutMs: number }): Promise<OpenCodeRun> {
  // --dir and PWD matter: OpenCode resolves its working directory from an inherited
  // PWD before the real process cwd, so a stale PWD silently points it elsewhere.
  const args = ["run", "-m", opts.model, "--format", "json", "--dir", opts.cwd];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, PWD: opts.cwd, INIT_CWD: opts.cwd },
      // The prompt goes through stdin: on Windows, OpenCode (Bun) receives argv
      // prompts containing quotes with the quotes wrapped and escaped (\"), while
      // stdin arrives byte-exact. OpenCode reads stdin until EOF, so close it.
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.stdin.end(opts.prompt);
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // timeoutMs 0 = no limit.
    const timer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child.pid!);
          }, opts.timeoutMs)
        : undefined;
    child.on("close", (code) => {
      clearTimeout(timer);
      const events: any[] = [];
      for (const line of out.split(/\r?\n/)) {
        const l = line.trim();
        if (!l.startsWith("{")) continue;
        try {
          events.push(JSON.parse(l));
        } catch {
          // non-JSON noise
        }
      }
      resolve(summarizeEvents(events, { exitCode: code, timedOut, ms: Date.now() - t0, stderr: err + out.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("{")).join("\n") }));
    });
  });
}

export function summarizeEvents(events: any[], meta: { exitCode: number | null; timedOut: boolean; ms: number; stderr: string }): OpenCodeRun {
  const tools: ToolUse[] = [];
  const texts: { msg: string; text: string }[] = [];
  const errors: string[] = [];
  const tokens = { input: 0, output: 0, reasoning: 0 };
  let steps = 0;
  let sessionId: string | undefined;
  for (const e of events) {
    sessionId ??= e.sessionID;
    const p = e.part ?? {};
    if (e.type === "tool_use") {
      tools.push({ tool: p.tool, input: p.state?.input ?? {}, status: p.state?.status, output: String(p.state?.output ?? ""), error: p.state?.error, ts: e.timestamp });
    } else if (e.type === "text") {
      texts.push({ msg: p.messageID, text: p.text ?? "" });
    } else if (e.type === "step_finish") {
      steps++;
      tokens.input += p.tokens?.input ?? 0;
      tokens.output += p.tokens?.output ?? 0;
      tokens.reasoning += p.tokens?.reasoning ?? 0;
    } else if (e.type === "error") {
      errors.push(JSON.stringify(e.error ?? e).slice(0, 500));
    }
  }
  const lastMsg = texts.at(-1)?.msg;
  const text = texts
    .filter((t) => t.msg === lastMsg)
    .map((t) => t.text)
    .join("\n");
  return { sessionId, events, tools, text, errors, steps, tokens, ...meta };
}
