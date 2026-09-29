import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import overview from "../opencode/tool/repo_overview.ts";

const ctx = (dir: string) => ({ directory: dir, worktree: dir, sessionID: "s", messageID: "m", agent: "build", abort: new AbortController().signal, metadata() {}, ask: async () => {} }) as any;

test("repo_overview lists the tree, line counts, manifests and real entry points (not decoys)", async () => {
  const dir = path.resolve(import.meta.dirname, "../eval/fixtures/py-entry");
  const out = String(await overview.execute({}, ctx(dir)));
  assert.match(out, /app\/\n  __init__\.py \(1 lines\)\n  __main__\.py \(\d+ lines\)/);
  assert.match(out, /Likely entry points \(by name[^)]*\): app\/__main__\.py$/m);
  assert.doesNotMatch(out.split("Likely entry points")[1].split("\n")[0], /benchmark_main|fake_main/);
  assert.match(out, /pyproject \[project\.scripts\]: zoo = "app\.__main__:main"/);
  assert.match(out, /read a file before describing it/);
});

test("repo_overview reports package.json scripts and test command", async () => {
  const dir = path.resolve(import.meta.dirname, "../eval/fixtures/js-stats");
  const out = String(await overview.execute({ depth: 2 }, ctx(dir)));
  assert.match(out, /package\.json scripts: test=node --test/);
  assert.match(out, /test command: npm test/);
});
