// Validation and conservative repair of model-generated tool calls against the
// tool catalog OpenCode supplied in the request (the only source of truth).

import path from "node:path";
import { coerceAndValidate, signature, type JSONSchema } from "./schema.ts";
import type { ToolDef } from "./harmony.ts";

export interface ProposedCall {
  name: string;
  /** Raw arguments: a JSON string (possibly malformed) or an already-parsed object. */
  args: unknown;
}

export interface ValidCall {
  name: string;
  args: Record<string, unknown>;
  /** Serialized arguments exactly as sent to OpenCode. */
  argsJson: string;
  repairs: string[];
}

export type Validation =
  | { ok: true; call: ValidCall }
  | { ok: false; code: "unknown_tool" | "bad_json" | "schema"; error: string; name: string; rawArgs: string };

const PATH_KEYS = /^(filePath|file_path|filepath|path|workdir|cwd|directory|dir|filename)$/i;

// File-name filters. In OpenCode a pattern without wildcards matches only a file named exactly
// that ("config" finds nothing, "*config*" finds config.yaml; verified with OpenCode 1.18), but
// gpt-oss uses bare words as name searches (one session: 9 of 14 globs found nothing).
const NAME_FILTERS: Record<string, string> = { glob: "pattern", grep: "include" };
// No wildcard, path separator or extension dot: "tests", "run_tests", "speed gauge".
const BARE_WORD = /^[^*?[\]{}\/\\.]+$/;

// Names gpt-oss uses for OpenCode's tools (observed: "search" for grep, 3 times in one session).
const TOOL_ALIASES: Record<string, string> = { search: "grep" };

/**
 * @param cwd OpenCode's working directory (from its system prompt), for path normalization.
 * @param grounded Conversation text (system, user, tool results) used to decide whether an
 *   out-of-project path was actually mentioned or invented by the model.
 */
export function validateToolCall(p: ProposedCall, tools: ToolDef[], cwd?: string, grounded?: string): Validation {
  const rawArgs = typeof p.args === "string" ? p.args : JSON.stringify(p.args ?? {});
  const available = tools.map((t) => t.function.name);
  const tool = resolveTool(p.name, tools);
  if (!tool) {
    return {
      ok: false,
      code: "unknown_tool",
      name: p.name,
      rawArgs,
      error: `Unknown tool "${p.name}". Only these tools exist: ${available.join(", ")}. Call one of them by its exact name.`,
    };
  }
  const repairs: string[] = [];
  if (tool.function.name !== p.name) repairs.push(`resolved tool name "${p.name}" -> "${tool.function.name}"`);
  const params = tool.function.parameters;

  let args: unknown;
  if (typeof p.args === "string") {
    const parsed = parseArgs(p.args);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "bad_json",
        name: tool.function.name,
        rawArgs,
        error: `The arguments for "${tool.function.name}" are not valid JSON (${parsed.error}). Send a single JSON object matching ${signature(params)}. Escape newlines as \\n and quotes as \\" inside strings.`,
      };
    }
    args = parsed.value;
    if (parsed.repair) repairs.push(parsed.repair);
  } else {
    args = p.args ?? {};
  }

  // {"name": "read", "arguments": {...}} wrapper around the real arguments.
  if (isObj(args) && "arguments" in args && Object.keys(args).every((k) => k === "name" || k === "arguments")) {
    const inner = (args as any).arguments;
    const innerParsed = typeof inner === "string" ? parseArgs(inner) : { ok: true as const, value: inner };
    if (innerParsed.ok && isObj(innerParsed.value)) {
      args = innerParsed.value;
      repairs.push("unwrapped {name, arguments} envelope");
    }
  }

  if (!isObj(args)) {
    return {
      ok: false,
      code: "schema",
      name: tool.function.name,
      rawArgs,
      error: `The arguments for "${tool.function.name}" must be a JSON object matching ${signature(params)}.`,
    };
  }

  // "query" is what the model calls grep's pattern when it asks for a "search" tool (observed).
  const props = params?.properties ?? {};
  if ("query" in args && !("pattern" in args) && "pattern" in props && !("query" in props)) {
    const { query, ...rest } = args;
    args = { ...rest, pattern: query };
    repairs.push(`renamed argument "query" -> "pattern"`);
  }

  const res = coerceAndValidate(params, args as Record<string, unknown>);
  repairs.push(...res.repairs);
  if (res.issues.length) {
    const details = res.issues.map((i) => `${i.path} ${i.message}`).join("; ");
    return {
      ok: false,
      code: "schema",
      name: tool.function.name,
      rawArgs,
      error: `Invalid arguments for "${tool.function.name}": ${details}. Expected parameters: ${signature(params)}.`,
    };
  }
  const finalArgs = res.value as Record<string, unknown>;
  const required: string[] = params?.required ?? [];
  for (const [k, v] of Object.entries(finalArgs)) {
    if (v === "" && PATH_KEYS.test(k) && !required.includes(k)) {
      delete finalArgs[k];
      repairs.push(`removed empty optional ${k}`);
    }
  }
  const nameFilter = NAME_FILTERS[tool.function.name];
  const word = nameFilter ? finalArgs[nameFilter] : undefined;
  const joined = typeof word === "string" ? joinGlobList(word) : undefined;
  if (joined) {
    finalArgs[nameFilter] = joined;
    repairs.push(`glob list ${nameFilter} ${JSON.stringify(word)} -> ${JSON.stringify(joined)}`);
  } else if (typeof word === "string" && BARE_WORD.test(word.trim())) {
    const pattern = `*${word.trim().split(/\s+/).join("*")}*`;
    finalArgs[nameFilter] = pattern;
    repairs.push(`bare-word ${nameFilter} ${JSON.stringify(word)} -> ${JSON.stringify(pattern)}`);
  }
  if (cwd) {
    for (const [k, v] of Object.entries(finalArgs)) {
      if (typeof v !== "string" || !PATH_KEYS.test(k) || !(params?.properties && k in params.properties)) continue;
      const expanded = grounded !== undefined ? expandElidedPath(v, cwd, grounded) : undefined;
      let fixed = expanded ?? normalizePath(v, cwd);
      if (grounded !== undefined && !expanded) {
        const snapped = snapNearMissPath(fixed, cwd, grounded) ?? reanchorPath(fixed, cwd, grounded);
        if (snapped) fixed = snapped;
      }
      if (isWindowsPath(cwd) && invalidWindowsPath(fixed)) {
        const wildcard = /[?*]/.test(v) && params?.properties && "pattern" in params.properties && k !== "pattern";
        return {
          ok: false,
          code: "schema",
          name: tool.function.name,
          rawArgs,
          error: wildcard
            ? `Invalid ${k} ${JSON.stringify(v)}: "${k}" must be a directory without wildcards; put wildcard patterns in "pattern".`
            : `Invalid ${k} ${JSON.stringify(v)}: Windows paths cannot contain < > " | ? *. Copy the path exactly from a tool result, or use a path relative to the working directory (${cwd}).`,
        };
      }
      if (fixed !== v) {
        finalArgs[k] = fixed;
        repairs.push(`normalized ${k}: ${JSON.stringify(v)} -> ${JSON.stringify(fixed)}`);
      }
    }
  }
  return { ok: true, call: { name: tool.function.name, args: finalArgs, argsJson: JSON.stringify(finalArgs), repairs } };
}

export function resolveTool(name: string, tools: ToolDef[]): ToolDef | undefined {
  // Cut malformed headers such as `read>{"filePath":...}()` at the first non-identifier character.
  // A harmony channel name fused onto the tool name: "read..commentary" (observed) -> "read".
  const n = name.replace(/^functions[.:/]/, "").trim().replace(/[^A-Za-z0-9_.\-].*$/s, "").replace(/\.+(commentary|analysis|final)$/i, "");
  const exact = tools.find((t) => t.function.name === n);
  if (exact) return exact;
  // Content-type fused onto the name: "globjson" -> "glob" (only when that is an exact tool name).
  const fused = n.match(/^(.+?)(json|code)$/i);
  if (fused) {
    const hit = tools.find((t) => t.function.name === fused[1]);
    if (hit) return hit;
  }
  const lower = n.toLowerCase();
  const ci = tools.find((t) => t.function.name.toLowerCase() === lower);
  if (ci) return ci;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = tools.filter((t) => squash(t.function.name) === squash(n));
  if (matches.length === 1) return matches[0];
  const alias = TOOL_ALIASES[lower];
  return alias ? tools.find((t) => t.function.name === alias) : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Rewrites a comma-separated list of file patterns ("**\/*.ts,**\/*.tsx") as one glob. OpenCode
 * hands the filter to ripgrep as a single --glob, where a comma outside braces is a literal
 * character, so the list matches no file (observed: every grep of a session found nothing).
 * Extensions become "*.{ts,tsx}" (the form OpenCode's description shows); anything else becomes
 * "{a,b}", with slashless entries prefixed "**\/" because ripgrep anchors the whole alternation at
 * the root once one entry contains a slash (verified with ripgrep 15.1).
 */
export function joinGlobList(pattern: string): string | undefined {
  const parts = splitTopLevelCommas(pattern).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.some((p) => /[*?./]/.test(p))) return undefined;
  // ripgrep allows no nested braces: "*.{h,cpp},*.ts" -> "*.h", "*.cpp", "*.ts".
  const alts = [...new Set(parts.flatMap(expandBraces))];
  const exts = alts.map((a) => /^(?:\*\*\/)?\*\.([\w+-]+)$/.exec(a)?.[1]);
  if (exts.every(Boolean)) return `*.{${[...new Set(exts)].join(",")}}`;
  const anchored = alts.some((a) => a.includes("/"));
  return `{${alts.map((a) => (anchored && !a.includes("/") ? `**/${a}` : a)).join(",")}}`;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && depth > 0) depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function expandBraces(p: string): string[] {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(",").flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

/**
 * The tool a set of arguments was meant for when its name is lost: every required parameter is
 * present, most argument names are its parameters, and it knows more of them than any other tool.
 * Undefined when that is ambiguous ({"pattern": "*.py"} fits glob and grep alike).
 */
export function inferTool(args: Record<string, unknown>, tools: ToolDef[]): ToolDef | undefined {
  const keys = Object.keys(args);
  let best: ToolDef | undefined;
  let bestKnown = 0;
  let tie = false;
  for (const t of tools) {
    const props = t.function.parameters?.properties ?? {};
    const required: string[] = t.function.parameters?.required ?? [];
    if (!required.every((k) => k in args)) continue;
    const known = keys.filter((k) => k in props).length;
    if (known > bestKnown) [best, bestKnown, tie] = [t, known, false];
    else if (known === bestKnown && known > 0) tie = true;
  }
  return best && !tie && bestKnown * 2 > keys.length ? best : undefined;
}

/**
 * Recovers the call from Ollama's "error parsing tool call: raw='...', err=..." (a 400 for the
 * whole request). gpt-oss sometimes writes its reasoning into the call ahead of valid JSON
 * arguments (observed: raw='We need to analyze ... Use grep for 'class' in project.{"pattern":...}').
 * The error carries the arguments but not the tool name, so the tool is inferred from the
 * argument names. Undefined unless the text holds exactly one JSON object and one tool fits it.
 */
export function recoverUnparsedCall(message: string, tools: ToolDef[]): { name: string; args: string; dropped: string } | undefined {
  const raw = /error parsing tool call: raw='([\s\S]*)', err=/.exec(message)?.[1];
  if (!raw) return undefined;
  const found: { value: Record<string, unknown>; span: string; start: number }[] = [];
  for (let i = raw.indexOf("{"); i >= 0 && found.length < 2; i = raw.indexOf("{", i + 1)) {
    const span = extractBalancedObject(raw.slice(i));
    if (!span) continue;
    try {
      const value = JSON.parse(span);
      if (!isObj(value)) continue;
      found.push({ value, span, start: i });
      i += span.length - 1;
    } catch {
      // a brace in the prose, not the arguments
    }
  }
  if (found.length !== 1) return undefined;
  const { value, span, start } = found[0];
  // {"name": "grep", "arguments": {...}} names its tool (validateToolCall unwraps it).
  const named = typeof value.name === "string" && "arguments" in value ? resolveTool(value.name, tools) : undefined;
  const tool = named ?? inferTool(value, tools);
  if (!tool) return undefined;
  return { name: tool.function.name, args: span, dropped: (raw.slice(0, start) + raw.slice(start + span.length)).trim() };
}

/**
 * Parses a tool-arguments body. Strict JSON first; then a single balanced JSON
 * object extracted from the text (handles code fences, a trailing "<|call|>",
 * or trailing prose). String contents are never rewritten.
 */
export function parseArgs(text: string): { ok: true; value: unknown; repair?: string } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: {}, repair: "empty arguments treated as {}" };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    const obj = extractBalancedObject(t);
    if (obj !== undefined && obj !== t) {
      try {
        return { ok: true, value: JSON.parse(obj), repair: "extracted JSON object from surrounding text" };
      } catch {
        // fall through
      }
    }
    return { ok: false, error: (e as Error).message.replace(/\s+/g, " ").slice(0, 160) };
  }
}

/** Returns the first top-level {...} span, respecting JSON string escapes. */
export function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------- paths

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const normSeg = (s: string) => s.toLowerCase().replace(/[‐-―−]/g, "-");
const normText = (s: string) => s.replace(/\\/g, "/").toLowerCase().replace(/[‐-―−]/g, "-");

/**
 * Repairs a mistyped absolute path that is one near-miss segment away from the
 * working directory (e.g. a digit changed in a long directory name, a wrong drive
 * letter, a Unicode hyphen) - but only when that path prefix appears nowhere in
 * the conversation, i.e. the model invented it. A path the user or a tool result
 * actually mentioned (such as a sibling project) is never rewritten.
 * Returns the repaired path, or undefined when no safe repair applies.
 */
export function snapNearMissPath(p: string, cwd: string, grounded: string): string | undefined {
  const win = isWindowsPath(cwd);
  if (win !== isWindowsPath(p) || (!win && !p.startsWith("/"))) return undefined;
  const cs = cwd.split(/[\\/]+/).filter(Boolean);
  const ps = p.split(/[\\/]+/).filter(Boolean);
  if (ps.length < cs.length) return undefined;
  const diffs: number[] = [];
  for (let i = 0; i < cs.length; i++) if (normSeg(ps[i]) !== normSeg(cs[i])) diffs.push(i);
  const sep = win ? "\\" : "/";
  const rest = ps.slice(cs.length);
  const base = cwd.replace(/[\\/]+$/, "");
  const rebuilt = rest.length ? `${base}${sep}${rest.join(sep)}` : base;
  if (diffs.length === 0) {
    // Differs from the working directory only by Unicode dashes / case: same place.
    return ps.slice(0, cs.length).join("/") === cs.join("/") ? undefined : rebuilt;
  }
  if (diffs.length !== 1) return undefined;
  const d = diffs[0];
  const a = normSeg(ps[d]);
  const b = normSeg(cs[d]);
  if (editDistance(a, b, Math.max(2, Math.floor(b.length / 10))) > Math.max(2, Math.floor(b.length / 10))) return undefined;
  const prefix = normText(ps.slice(0, Math.min(ps.length, d + 2)).join("/"));
  if (normText(grounded).includes(prefix)) return undefined;
  return rebuilt;
}

/**
 * Repairs a long path the model abbreviated with an ellipsis, e.g.
 * "D:\sandbox\..\repo\src\a.js" for "D:\sandbox\improved\...\repo\src\a.js", or with the
 * ellipsis inside a segment: "D:\sandbox\improved_tools_agent\.eval-r...\src\a.js"
 * (observed). The part before the ellipsis must be a prefix of the working directory.
 * If the part after it starts with the working directory's last segment, the rest is
 * joined to the working directory; otherwise ("..." also swallowed the project folder)
 * only a resulting path the conversation mentioned is accepted. Like snapNearMissPath,
 * only applied when the literal path appears nowhere in the conversation.
 */
export function expandElidedPath(p: string, cwd: string, grounded: string): string | undefined {
  const win = isWindowsPath(cwd);
  const ps = p.trim().split(/[\\/]+/).filter(Boolean);
  const cs = cwd.split(/[\\/]+/).filter(Boolean);
  const k = ps.findIndex((s) => s === ".." || s.endsWith("...") || s.endsWith("…"));
  if (k <= 0 || k >= ps.length - 1) return undefined;
  const partial = ps[k] === ".." ? "" : ps[k].replace(/(\.\.\.|…)$/, "");
  const head = ps.slice(0, k);
  const tail = ps.slice(k + 1);
  if (head.length >= cs.length || !head.every((s, i) => normSeg(s) === normSeg(cs[i]))) return undefined;
  if (partial && !normSeg(cs[k]).startsWith(normSeg(partial))) return undefined;
  const text = normText(grounded);
  if (text.includes(normText(p.trim()))) return undefined;
  const sep = win ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  const join = (rest: string[]) => (rest.length ? `${base}${sep}${rest.join(sep)}` : base);
  if (normSeg(tail[0]) === normSeg(cs[cs.length - 1])) return join(tail.slice(1));
  if (ps[k] === "..") return undefined;
  const candidate = join(tail);
  return text.includes(normText(candidate)) ? candidate : undefined;
}

// Characters Windows forbids in paths (after the drive and any \\?\ prefix). Observed junk:
// "D:\...\.eval-runs\2026-09-uite? self...?" - OpenCode then denies it as an outside
// directory, which misleads the model into reasoning about permissions.
const WINDOWS_BAD_PATH_CHARS = /[<>"|?*]/;

export function invalidWindowsPath(p: string): boolean {
  return WINDOWS_BAD_PATH_CHARS.test(p.replace(/^\\\\\?\\/, "").replace(/^[A-Za-z]:/, ""));
}

/**
 * Repairs an invented absolute path whose middle the model garbled beyond a near miss:
 * several segments changed, or one dropped or duplicated (observed:
 * "...\.eval-runs\2026-09-12T12-48-02-x\repo\tests\a.cpp" and "...\2026-09-25T11-59-53-x\repo\tests\a.cpp"
 * for "...\2026-09-25T11-59-53-x\x\repo\tests\a.cpp"). The path is re-anchored on the
 * working directory's last segment when
 *   - it shares at least its first two segments with the working directory,
 *   - its prefix up to that anchor appears nowhere in the conversation (invented, not a
 *     real sibling someone mentioned), and
 *   - the directory it lands in is the working directory or was mentioned in the
 *     conversation (the proxy never touches the filesystem, so this stands in for "exists").
 */
export function reanchorPath(p: string, cwd: string, grounded: string): string | undefined {
  const win = isWindowsPath(cwd);
  if (win !== isWindowsPath(p) || (!win && !p.startsWith("/"))) return undefined;
  const cs = cwd.split(/[\\/]+/).filter(Boolean);
  const ps = p.split(/[\\/]+/).filter(Boolean);
  let common = 0;
  while (common < Math.min(cs.length, ps.length) && normSeg(ps[common]) === normSeg(cs[common])) common++;
  if (common < 2 || common === cs.length) return undefined;
  const anchor = normSeg(cs[cs.length - 1]);
  const text = normText(grounded);
  const sep = win ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  const baseKey = normText(base);
  for (let k = common; k < ps.length - 1; k++) {
    if (normSeg(ps[k]) !== anchor) continue;
    if (text.includes(normText(ps.slice(0, k + 1).join("/")))) return undefined;
    const rest = ps.slice(k + 1);
    const dir = [baseKey, ...rest.slice(0, -1).map(normSeg)].join("/");
    if (rest.length === 1 || text.includes(`${dir}/`)) return `${base}${sep}${rest.join(sep)}`;
  }
  return undefined;
}

export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
}

/**
 * Normalizes a path argument for the platform OpenCode runs on (inferred from
 * its working directory): converts WSL (/mnt/c/...) and Git-Bash (/c/...) forms
 * to Windows paths and vice versa, resolves relative paths against the working
 * directory, and cleans duplicate separators.
 */
export function normalizePath(p: string, cwd: string): string {
  const s = p.trim();
  if (s === "" || s.includes("*") || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return p;
  if (isWindowsPath(cwd)) {
    // WSL / Git-Bash forms may arrive with backslashes (\mnt\d\x, \d\x): compare on forward slashes.
    let w = /^[\\/]/.test(s) ? s.replace(/\\/g, "/") : s;
    const wsl = w.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
    const gitBash = w.match(/^\/([a-zA-Z])(?:\/(.*))?$/);
    if (wsl) w = `${wsl[1].toUpperCase()}:\\${wsl[2] ?? ""}`;
    else if (gitBash && gitBash[1].toLowerCase() === cwd[0].toLowerCase()) w = `${gitBash[1].toUpperCase()}:\\${gitBash[2] ?? ""}`;
    if (isWindowsPath(w)) {
      const n = path.win32.normalize(w);
      return /^[a-z]:/.test(n) ? n[0].toUpperCase() + n.slice(1) : n;
    }
    if (w.startsWith("/")) return p; // rooted but not resolvable on Windows; let the tool report it
    return path.win32.resolve(cwd, w);
  }
  // POSIX (Linux, macOS, WSL)
  let x = s;
  const win = x.match(/^([A-Za-z]):[\\/](.*)$/);
  if (win) {
    if (cwd.startsWith("/mnt/")) x = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`;
    else return p;
  } else if (x.includes("\\") && !x.includes("/")) {
    x = x.replace(/\\/g, "/");
  }
  if (!x.startsWith("/")) x = path.posix.resolve(cwd, x);
  const n = path.posix.normalize(x);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}
