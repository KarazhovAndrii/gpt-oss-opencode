// Starts the proxy in-process against a mock upstream, with a temp log dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server.ts";
import { DEFAULT_LIMITS, DEFAULT_PROFILES, type Config, type Limits, type Profile } from "../../src/config.ts";
import { Logger } from "../../src/log.ts";

export const OPENCODE_TOOLS = JSON.parse(fs.readFileSync(new URL("../fixtures/opencode-tools.json", import.meta.url), "utf8"));

export function systemPrompt(cwd = "/work/repo", platform = "linux") {
  return `You are opencode, an interactive CLI tool.\n<env>\n  Working directory: ${cwd}\n  Platform: ${platform}\n</env>`;
}

export interface TestProxy {
  url: string;
  logDir: string;
  cfg: Config;
  close(): Promise<void>;
  events(): any[];
}

export async function startProxy(upstreamUrl: string, profile: Partial<Profile> = {}, limits: Partial<Limits> = {}): Promise<TestProxy> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-test-"));
  process.env.TEST_UPSTREAM_KEY = "sk-test-secret-key-1234567890abcdef";
  const p: Profile = { ...DEFAULT_PROFILES.siliconflow, name: "mock", baseURL: upstreamUrl, apiKeyEnv: "TEST_UPSTREAM_KEY", aliases: [], stream: false, ...profile };
  const cfg: Config = {
    host: "127.0.0.1",
    port: 0,
    defaultProfile: "mock",
    logDir,
    logContent: true,
    logRetentionDays: 0,
    profiles: { mock: p },
    limits: { ...DEFAULT_LIMITS, firstByteTimeoutMs: 2000, idleTimeoutMs: 1500, requestTimeoutMs: 8000, requestBudgetMs: 20000, ...limits },
  };
  const server = createServer({ cfg, logger: new Logger(logDir, { quiet: true }) });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    logDir,
    cfg,
    close: () => new Promise((ok) => server.close(() => ok())),
    events: () => {
      const out: any[] = [];
      const walk = (d: string) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (f.endsWith(".jsonl")) out.push(...fs.readFileSync(full, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
        }
      };
      walk(logDir);
      return out.sort((a, b) => a.ts.localeCompare(b.ts));
    },
  };
}

/** Minimal OpenAI-compatible client call against the proxy; parses SSE if streaming. */
export async function chat(url: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": "ses_test", ...headers },
    body: JSON.stringify(body),
  });
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream")) return { status: res.status, json: await res.json(), events: [] as any[], raw: "" };
  const raw = await res.text();
  const events = raw
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
  return { status: res.status, json: undefined as any, events, raw };
}
