// OpenCode custom tool (evaluated as "strategy C"): one compact call that gives a
// small model what it otherwise gathers with several glob/list/read calls.
// Read-only; runs inside OpenCode like the built-in tools.

import { tool } from "@opencode-ai/plugin";
import fs from "node:fs/promises";
import path from "node:path";

const IGNORE = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".idea", ".vscode", ".pytest_cache", ".mypy_cache", "coverage", ".opencode"]);
const ENTRY_NAMES = /^(__main__\.py|main\.(py|js|ts|go|rs)|index\.(js|ts|mjs)|app\.(py|js|ts)|cli\.(py|js|ts)|server\.(js|ts|py)|manage\.py)$/;
const MAX_ENTRIES = 250;

async function lineCount(file: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(file);
    if (st.size > 2_000_000) return undefined;
    const buf = await fs.readFile(file);
    if (buf.includes(0)) return undefined; // binary
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return undefined;
  }
}

export default tool({
  description:
    "Compact overview of the project in one call: directory tree (depth-limited; skips .git, node_modules, build output) with line counts, manifest scripts (package.json, pyproject.toml, Makefile), likely entry points, and the test command. Use it once at the start of a task instead of several glob/list calls; then read the files you need.",
  args: {
    path: tool.schema.string().optional().describe("Sub-directory to summarize, relative to the project root or absolute (default: project root)"),
    depth: tool.schema.number().int().min(1).max(6).optional().describe("Tree depth (default 4)"),
  },
  async execute(args, ctx) {
    const root = args.path ? path.resolve(ctx.directory, args.path) : ctx.directory;
    const depth = args.depth ?? 4;
    const lines: string[] = [];
    const entries: string[] = [];
    let count = 0;
    let truncated = false;

    async function walk(dir: string, level: number, prefix: string) {
      let items: import("node:fs").Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        lines.push(`${prefix}[unreadable: ${(e as Error).message}]`);
        return;
      }
      items.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const it of items) {
        if (IGNORE.has(it.name)) continue;
        if (++count > MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const full = path.join(dir, it.name);
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (it.isDirectory()) {
          lines.push(`${prefix}${it.name}/`);
          if (level < depth) await walk(full, level + 1, prefix + "  ");
        } else {
          const n = await lineCount(full);
          lines.push(`${prefix}${it.name}${n !== undefined ? ` (${n} lines)` : ""}`);
          if (ENTRY_NAMES.test(it.name) && !/(^|\/)(tests?|fixtures?|benchmarks?|examples?|scripts)\//.test(rel)) entries.push(rel);
        }
      }
    }
    await walk(root, 1, "");

    const facts: string[] = [];
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (pkg.main) facts.push(`package.json main: ${pkg.main}`);
      if (pkg.bin) facts.push(`package.json bin: ${JSON.stringify(pkg.bin)}`);
      if (pkg.type) facts.push(`package.json type: ${pkg.type}`);
      if (pkg.scripts) facts.push(`package.json scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k}=${v}`).join("; ")}`);
      if (pkg.scripts?.test) facts.push("test command: npm test");
    } catch {
      // no package.json
    }
    try {
      const py = await fs.readFile(path.join(root, "pyproject.toml"), "utf8");
      const scripts = py.match(/\[project\.scripts\]([\s\S]*?)(\n\[|$)/)?.[1]?.trim();
      if (scripts) facts.push(`pyproject [project.scripts]: ${scripts.replace(/\s*\n\s*/g, "; ")}`);
      if (/pytest/.test(py) || lines.some((l) => /test_.*\.py/.test(l))) facts.push("test command: pytest");
    } catch {
      // no pyproject
    }
    try {
      const mk = await fs.readFile(path.join(root, "Makefile"), "utf8");
      const targets = [...mk.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]).slice(0, 15);
      if (targets.length) facts.push(`Makefile targets: ${targets.join(", ")}`);
    } catch {
      // no Makefile
    }

    return [
      `Project root: ${root}`,
      "",
      ...lines,
      truncated ? `… (truncated after ${MAX_ENTRIES} entries; call again with a sub-directory)` : "",
      "",
      entries.length ? `Likely entry points (by name, excluding tests/fixtures/benchmarks/scripts): ${entries.join(", ")}` : "Likely entry points: none found by name",
      ...facts,
      "Note: this is a listing, not file contents - read a file before describing it.",
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n");
  },
});
