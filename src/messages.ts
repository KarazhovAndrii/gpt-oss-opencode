// OpenAI chat message helpers: normalization of what OpenCode sends, and
// extraction of context (working directory, current user objective).

export interface ToolCallMsg {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string | ContentPart[] | null;
  tool_calls?: ToolCallMsg[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
  [k: string]: unknown;
}

export type ContentPart = { type: string; text?: string; [k: string]: unknown };

export function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((p) => {
      if (p.type === "text") return p.text ?? "";
      if (p.type === "image_url" || p.type === "image" || p.type === "file" || p.type === "input_audio")
        return `[${p.type} attachment omitted: this model only accepts text]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Working directory announced in OpenCode's system prompt (<env> block). */
export function findWorkingDirectory(messages: ChatMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "system") continue;
    const match = textOf(m.content).match(/Working directory:\s*(.+)/);
    if (match) return match[1].trim();
  }
  return undefined;
}

/** Index of the last genuine user message (not a tool result). */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

export function currentObjective(messages: ChatMessage[], max = 1500): string {
  const i = lastUserIndex(messages);
  if (i < 0) return "";
  let t = textOf(messages[i].content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
  // Unwrap quoting some shells add around the whole prompt.
  if (/^"[\s\S]*"$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Normalizes OpenCode's messages for a text-only harmony model:
 * - merges all system/developer messages into one leading system message,
 * - flattens multi-part content to text,
 * - splits assistant messages with several tool calls into one call per
 *   message, each followed by its result (harmony has one call per turn),
 * - makes sure every tool call has a result and every result a call.
 */
export function normalizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const system: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") system.push(textOf(m.content));
    else rest.push(m);
  }
  const results = new Map<string, ChatMessage>();
  for (const m of rest) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, m);

  const out: ChatMessage[] = [];
  if (system.length) out.push({ role: "system", content: system.join("\n\n") });
  const emitted = new Set<string>();
  for (const m of rest) {
    if (m.role === "tool") {
      if (m.tool_call_id && emitted.has(m.tool_call_id)) continue; // already placed after its call
      continue; // orphan result without a preceding call: drop
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const text = textOf(m.content).trim();
      m.tool_calls.forEach((tc, i) => {
        const msg: ChatMessage = { role: "assistant", content: i === 0 && text ? text : null, tool_calls: [sanitizeCall(tc)] };
        out.push(msg);
        const r = results.get(tc.id);
        out.push({ role: "tool", tool_call_id: tc.id, content: r ? textOf(r.content) : "[no result: the tool call was not executed]" });
        emitted.add(tc.id);
      });
      continue;
    }
    out.push({ role: m.role, content: textOf(m.content) });
  }
  return out;
}

/** Rough token estimate for budget decisions (no tokenizer dependency). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += textOf(m.content).length + 16;
    for (const tc of m.tool_calls ?? []) chars += tc.function.name.length + tc.function.arguments.length + 16;
  }
  return Math.ceil(chars / 3.2);
}

export interface FitResult {
  messages: ChatMessage[];
  trimmed: number;
  before: number;
  after: number;
}

/**
 * Safety net for context overflow: if the history exceeds `budget` tokens, the
 * oldest tool results (never the two most recent) are replaced by a stub, then
 * the largest remaining result is cut to head+tail. OpenCode's own compaction
 * normally triggers first; this only prevents hard provider errors.
 */
export function fitContext(messages: ChatMessage[], budget: number): FitResult {
  const before = estimateTokens(messages);
  if (before <= budget) return { messages, trimmed: 0, before, after: before };
  const out = messages.map((m) => ({ ...m }));
  const toolIdx = out.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const protectedIdx = new Set(toolIdx.slice(-2));
  let trimmed = 0;
  let est = before;
  for (const i of toolIdx) {
    if (est <= budget) break;
    if (protectedIdx.has(i)) continue;
    const len = textOf(out[i].content).length;
    if (len < 400) continue;
    out[i].content = `[older tool result (${len} chars) omitted by gpt-oss-proxy to fit the context window; call the tool again if you need it]`;
    trimmed++;
    est = estimateTokens(out);
  }
  while (est > budget) {
    let big = -1;
    for (let i = 0; i < out.length; i++) if (out[i].role === "tool" && (big < 0 || textOf(out[i].content).length > textOf(out[big].content).length)) big = i;
    if (big < 0) break;
    const t = textOf(out[big].content);
    if (t.length < 4000) break;
    const keep = Math.max(1000, Math.floor(t.length / 4));
    out[big].content = `${t.slice(0, keep)}\n[… ${t.length - 2 * keep} chars omitted by gpt-oss-proxy to fit the context window …]\n${t.slice(-keep)}`;
    trimmed++;
    est = estimateTokens(out);
  }
  return { messages: out, trimmed, before, after: est };
}

function sanitizeCall(tc: ToolCallMsg): ToolCallMsg {
  let args = tc.function?.arguments ?? "{}";
  if (typeof args !== "string") args = JSON.stringify(args);
  try {
    JSON.parse(args);
  } catch {
    args = JSON.stringify({ _unparseable_arguments: args });
  }
  return { id: tc.id, type: "function", function: { name: tc.function?.name ?? "unknown", arguments: args } };
}
