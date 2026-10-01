// A real Python interpreter for scenarios that need one. On Windows `python` is often the
// Microsoft Store stub ("Python was not found; run without arguments to install ..."), so
// the py launcher is asked for an installed interpreter first.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let cached: string | null | undefined;

export function findPython(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const probe = ["-c", "import sys; print(sys.executable)"];
  const tries: [string, string[]][] = process.platform === "win32" ? [["py", ["-3", ...probe]], ["python", probe]] : [["python3", probe], ["python", probe]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
    const exe = r.status === 0 ? r.stdout.trim().split(/\r?\n/).at(-1)!.trim() : "";
    if (exe && fs.existsSync(exe) && !/WindowsApps/i.test(exe)) return (cached = exe);
  }
  cached = null;
  return undefined;
}

/** PATH with the interpreter's directory (and its Scripts folder, for pip) in front. */
export function withPython(envPath: string): string {
  const exe = findPython();
  if (!exe) throw new Error("this scenario needs Python 3 (install it, or make `py -3` / `python3` work)");
  const dir = path.dirname(exe);
  const sep = process.platform === "win32" ? ";" : ":";
  return [dir, path.join(dir, process.platform === "win32" ? "Scripts" : "bin"), envPath].join(sep);
}
