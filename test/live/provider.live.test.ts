// Live provider tests (network, costs a few cents at most). Skipped unless the
// provider is configured:
//   CUSTOM_BASE_URL [+ CUSTOM_MODEL, CUSTOM_API_KEY]  -> any OpenAI-compatible GPT-OSS provider (auto strategy)
//   SILICONFLOW_API_KEY                       -> SiliconFlow (harmony strategy)
//   OPENWEBUI_API_KEY [+ OPENWEBUI_BASE_URL]  -> OpenWebUI (auto strategy)
// Run: npm run test:live
//
// The test plays OpenCode's role: it sends OpenCode's real tool catalog through
// the proxy, executes the returned tool calls itself against a temporary repo,
// sends the results back, and checks the model completes the task correctly.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/server.ts";
import { loadConfig } from "../../src/config.ts";
import { Logger } from "../../src/log.ts";
import { OPENCODE_TOOLS } from "../helpers/proxy.ts";

const TOOLS = OPENCODE_TOOLS.filter((t: any) => ["read", "glob", "edit", "bash", "write"].includes(t.function.name));

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-live-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"t","type":"module","scripts":{"test":"node --test"}}\n');
  fs.writeFileSync(path.join(dir, "src", "greet.js"), 'export function greet(name) {\n  return "Hello, " + name;\n}\n');
  fs.writeFileSync(path.join(dir, "greet.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "./src/greet.js";\ntest("greet", () => assert.equal(greet("Ada"), "Hello, Ada!"));\n');
  return dir;
}

/** Minimal executor for the tools this test offers (the client's job, as in OpenCode). */
function execute(repo: string, name: string, args: any): string {
  try {
    switch (name) {
      case "read": {
        const text = fs.readFileSync(args.filePath, "utf8");
        return text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
      }
      case "glob":
        return listFiles(repo).filter((f) => new RegExp(globToRe(args.pattern)).test(f.replace(/\\/g, "/"))).join("\n") || "No files found";
      case "edit": {
        const text = fs.readFileSync(args.filePath, "utf8");
        if (!text.includes(args.oldString)) return "Error: oldString not found in content";
        fs.writeFileSync(args.filePath, args.replaceAll ? text.split(args.oldString).join(args.newString) : text.replace(args.oldString, args.newString));
        return "Edit applied successfully.";
      }
      case "write":
        fs.writeFileSync(args.filePath, args.content);
        return "Wrote file successfully.";
      case "bash":
        try {
          return execFileSync(process.platform === "win32" ? "cmd" : "sh", process.platform === "win32" ? ["/c", args.command] : ["-c", args.command], { cwd: args.workdir ?? repo, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e: any) {
          return `Exit code ${e.status}\n${e.stdout ?? ""}${e.stderr ?? ""}`;
        }
      default:
        return `Error: tool ${name} not available in this test`;
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

function listFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : listFiles(path.join(dir, e.name))) : [path.join(dir, e.name)]));
}
function globToRe(g: string): string {
  return g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*/g, "[^/]*") + "$";
}

async function chat(url: string, body: object) {
  const res = await fetch(`${url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-session-id": `ses_live_${Date.now()}` }, body: JSON.stringify(body) });
  const raw = await res.text();
  const events = raw.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  return {
    text: events.map((e) => e.choices?.[0]?.delta?.content ?? "").join(""),
    calls: events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []),
    finish: events.map((e) => e.choices?.[0]?.finish_reason).filter(Boolean).at(-1),
  };
}

const providers = [
  { name: "custom", enabled: !!process.env.CUSTOM_BASE_URL, hint: "set CUSTOM_BASE_URL to run" },
  { name: "siliconflow", enabled: !!process.env.SILICONFLOW_API_KEY, hint: "set SILICONFLOW_API_KEY to run" },
  { name: "openwebui", enabled: !!process.env.OPENWEBUI_API_KEY, hint: "set OPENWEBUI_API_KEY to run" },
];

for (const p of providers) {
  describe(`live: ${p.name}`, { skip: !p.enabled && p.hint }, () => {
    let url = "";
    let close: () => Promise<void>;
    let logDir = "";
    before(async () => {
      const cfg = loadConfig();
      logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptoss-live-logs-"));
      cfg.logDir = logDir;
      const server = createServer({ cfg, logger: new Logger(logDir, { quiet: true }) });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      close = () => new Promise((ok) => (server.closeAllConnections(), server.close(() => ok())));
    });
    after(async () => close?.());

    test("full tool lifecycle: catalog -> valid call -> result -> further calls -> code change -> validation -> correct answer", { timeout: 900_000 }, async () => {
      const repo = makeRepo();
      const messages: any[] = [
        { role: "system", content: `You are opencode, an interactive CLI coding agent.\n<env>\n  Working directory: ${repo}\n  Platform: ${process.platform}\n</env>` },
        { role: "user", content: "The test in greet.test.js fails. Fix src/greet.js so the test passes (do not change the test), then run `npm test` and tell me the result." },
      ];
      const trace: string[] = [];
      let final = "";
      for (let step = 0; step < 14; step++) {
        const r = await chat(url, { model: p.name, stream: true, stream_options: { include_usage: true }, tools: TOOLS, tool_choice: "auto", messages });
        if (!r.calls.length) {
          final = r.text;
          break;
        }
        assert.equal(r.finish, "tool_calls");
        const assistant = { role: "assistant", content: r.text || null, tool_calls: r.calls.map((c: any) => ({ id: c.id, type: "function", function: c.function })) };
        messages.push(assistant);
        for (const c of r.calls) {
          assert.ok(TOOLS.some((t: any) => t.function.name === c.function.name), `unknown tool ${c.function.name}`);
          const args = JSON.parse(c.function.arguments);
          trace.push(`${c.function.name} ${c.function.arguments.slice(0, 120)}`);
          messages.push({ role: "tool", tool_call_id: c.id, content: execute(repo, c.function.name, args) });
        }
      }
      console.log(`  trace (${p.name}):\n   - ${trace.join("\n   - ")}\n  final: ${final.slice(0, 300)}`);
      assert.ok(trace.length >= 2, "needs at least two sequential tool calls");
      if (process.env.LIVE_STANDIN) {
        // A small stand-in model behind the real server stack: check the protocol, not task skill.
        assert.ok(trace.some((t) => /^(edit|write) /.test(t)), "a code-changing tool call went through");
        assert.ok(trace.some((t) => t.startsWith("bash")), "a validation command went through");
        assert.ok(final.trim().length > 0 && !final.startsWith("[gpt-oss-proxy]"), "ended with a model answer, not a proxy diagnostic");
        return;
      }
      assert.match(fs.readFileSync(path.join(repo, "src", "greet.js"), "utf8"), /Hello, " \+ name \+ "!"|`Hello, \$\{name\}!`|"!"/);
      const passes = (() => {
        try {
          execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      })();
      assert.ok(passes, "repo tests pass after the agent's change");
      assert.ok(trace.some((t) => t.startsWith("bash") && /test/.test(t)), "agent ran the tests itself");
      assert.match(final, /pass|✓|succe|ok/i, "final answer reports the (passing) result");
      assert.ok(fs.readFileSync(path.join(repo, "greet.test.js"), "utf8").includes('"Hello, Ada!"'), "test unchanged");
    });
  });
}
