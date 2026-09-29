// Build script for calc. Finds a C++17 compiler by itself (CXX, g++, clang++, cl,
// or MSVC located with vswhere), so no CMake/Makefile or developer prompt is needed.
//
//   node tools/build.mjs          build the command-line tool  -> build/calc[.exe]
//   node tools/build.mjs test     build and run the unit tests -> build/tests[.exe]
//
// Sources: every .cpp under src/ (library) plus app/main.cpp (tool) or every .cpp
// under tests/ (unit tests). Public headers live in include/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const TEST_TIMEOUT_MS = 30_000;

function cppFiles(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { recursive: true })
    .filter((f) => f.endsWith(".cpp"))
    .map((f) => path.join(dir, f))
    .sort();
}

function onPath(cmd) {
  const r = spawnSync(win ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

// Captures the environment of MSVC's vcvars64.bat (cached in build/).
function msvc() {
  const cacheFile = path.join(root, "build", ".msvc-env.json");
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (fs.existsSync(cached.cl)) return cached;
  } catch {
    // no cache yet
  }
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) return undefined;
  const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
  const install = found.stdout?.trim().split(/\r?\n/)[0];
  const bat = install && path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!bat || !fs.existsSync(bat)) return undefined;
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${bat}" >nul 2>&1 && set"`], { encoding: "utf8", windowsVerbatimArguments: true });
  const env = {};
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const cl = pathKey && env[pathKey].split(";").map((d) => path.join(d, "cl.exe")).find((p) => fs.existsSync(p));
  if (!cl) return undefined;
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ cl, env }));
  return { cl, env };
}

function toolchain() {
  const cxx = process.env.CXX;
  if (cxx) return { msvc: /(^|[\\/])cl(\.exe)?$/i.test(cxx), cxx, env: process.env };
  for (const c of ["g++", "clang++"]) if (onPath(c)) return { msvc: false, cxx: c, env: process.env };
  if (win && onPath("cl")) return { msvc: true, cxx: "cl", env: process.env };
  const m = win ? msvc() : undefined;
  return m && { msvc: true, cxx: m.cl, env: m.env };
}

function compile(tc, name, sources) {
  const exe = path.join("build", win ? `${name}.exe` : name);
  const objDir = path.join("build", "obj", name);
  fs.mkdirSync(path.join(root, objDir), { recursive: true });
  const args = tc.msvc
    ? ["/nologo", "/EHsc", "/std:c++17", "/W4", "/permissive-", "/utf-8", "/Iinclude", `/Fo${objDir}${path.sep}`, `/Fe${exe}`, ...sources]
    : ["-std=c++17", "-Wall", "-Wextra", "-g", "-Iinclude", "-o", exe, ...sources];
  console.log(`compiling ${name} (${sources.length} files) with ${path.basename(tc.cxx)}`);
  const r = spawnSync(tc.cxx, args, { cwd: root, env: tc.env, encoding: "utf8" });
  // cl echoes each source file name and its progress; drop that noise.
  const names = new Set(sources.map((s) => path.basename(s)));
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
    .split(/\r?\n/)
    .filter((l) => l.trim() && !names.has(l.trim()) && !/^(Generating Code|Compiling)\.\.\.$/.test(l.trim()))
    .join("\n");
  if (out) console.log(out);
  if (r.error || r.status !== 0) {
    console.log(`build failed${r.error ? `: ${r.error.message}` : ""}`);
    process.exit(1);
  }
  return exe;
}

const tc = toolchain();
if (!tc) {
  console.log("no C++ compiler found: install g++/clang++ or the MSVC build tools, or set CXX");
  process.exit(1);
}

const lib = cppFiles("src");
if (process.argv[2] === "test") {
  const exe = compile(tc, "tests", [...lib, ...cppFiles("tests")]);
  const r = spawnSync(path.join(root, exe), [], { cwd: root, stdio: "inherit", timeout: TEST_TIMEOUT_MS });
  if (r.error?.code === "ETIMEDOUT") {
    console.log(`tests timed out after ${TEST_TIMEOUT_MS / 1000}s (infinite loop?)`);
    process.exit(1);
  }
  if (r.status === null || r.status > 1) console.log(`tests crashed (exit ${r.status ?? r.signal})`);
  process.exit(r.status ?? 1);
} else {
  const exe = compile(tc, "calc", [...lib, "app/main.cpp"]);
  console.log(`built ${exe}`);
}
