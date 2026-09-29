// C++ toolchain for scenario checks: finds a compiler (CXX, g++, clang++, cl, or MSVC
// via vswhere + vcvars64.bat), builds executables and runs them. Deliberately
// independent of a fixture's own build script, which the agent may have modified.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface Toolchain {
  msvc: boolean;
  cxx: string;
  env: NodeJS.ProcessEnv;
}

const win = process.platform === "win32";
let cached: Toolchain | null | undefined;

const onPath = (cmd: string) => spawnSync(win ? "where" : "which", [cmd], { encoding: "utf8" }).status === 0;

function msvcFromVswhere(): Toolchain | undefined {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) return undefined;
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const install = found.stdout?.trim().split(/\r?\n/)[0];
  const bat = install && path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!bat || !fs.existsSync(bat)) return undefined;
  // /s strips the outer quotes, leaving `"<bat>" >nul 2>&1 && set` for cmd to run.
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${bat}" >nul 2>&1 && set"`], { encoding: "utf8", windowsVerbatimArguments: true });
  const env: NodeJS.ProcessEnv = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const cl = pathKey && env[pathKey]!.split(";").map((d) => path.join(d, "cl.exe")).find((p) => fs.existsSync(p));
  return cl ? { msvc: true, cxx: cl, env } : undefined;
}

export function findCxx(): Toolchain | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const cxx = process.env.CXX;
  if (cxx) cached = { msvc: /(^|[\\/])cl(\.exe)?$/i.test(cxx), cxx, env: process.env };
  else {
    const gnu = ["g++", "clang++"].find(onPath);
    if (gnu) cached = { msvc: false, cxx: gnu, env: process.env };
    else if (win && onPath("cl")) cached = { msvc: true, cxx: "cl", env: process.env };
    else cached = (win && msvcFromVswhere()) || null;
  }
  return cached ?? undefined;
}

/** Recursively lists `.cpp` files under `dir` (relative to `cwd`), sorted. */
export function cppSources(cwd: string, dir: string): string[] {
  const abs = path.join(cwd, dir);
  if (!fs.existsSync(abs)) return [];
  return (fs.readdirSync(abs, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".cpp"))
    .map((f) => path.join(dir, f))
    .sort();
}

/** Compiles `sources` (relative to `cwd`, or absolute) into `outDir/<name>[.exe]`. */
export function buildExe(opts: { cwd: string; sources: string[]; includes: string[]; outDir: string; name: string }): { ok: boolean; exe: string; out: string } {
  const tc = findCxx();
  if (!tc) return { ok: false, exe: "", out: "no C++ compiler found (set CXX, or install g++/clang++/MSVC build tools)" };
  const exe = path.join(opts.outDir, win ? `${opts.name}.exe` : opts.name);
  const objDir = path.join(opts.outDir, `obj-${opts.name}`);
  fs.mkdirSync(objDir, { recursive: true });
  const args = tc.msvc
    ? ["/nologo", "/EHsc", "/std:c++17", "/permissive-", "/utf-8", ...opts.includes.map((i) => `/I${i}`), `/Fo${objDir}${path.sep}`, `/Fe${exe}`, ...opts.sources]
    : ["-std=c++17", ...opts.includes.map((i) => `-I${i}`), "-o", exe, ...opts.sources];
  const r = spawnSync(tc.cxx, args, { cwd: opts.cwd, env: tc.env, encoding: "utf8", timeout: 180_000 });
  const out = `${r.error?.message ?? ""}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  return { ok: !r.error && r.status === 0, exe, out };
}

export function runExe(exe: string, args: string[], cwd: string, timeoutMs = 20_000): { status: number | null; out: string; timedOut: boolean } {
  let r = spawnSync(exe, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  // A freshly linked executable can be briefly locked (e.g. by an antivirus scan on
  // Windows); a spawn failure is retried once.
  const code = () => (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (r.error && code() !== "ETIMEDOUT") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
    r = spawnSync(exe, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  }
  const timedOut = code() === "ETIMEDOUT";
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  const why = r.error ? `failed to run: ${r.error.message}` : r.status !== 0 ? `exit ${r.status ?? r.signal}` : "";
  return { status: r.status, out: [out, why].filter(Boolean).join("\n"), timedOut };
}
