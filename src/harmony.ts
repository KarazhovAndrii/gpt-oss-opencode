// Harmony helpers for gpt-oss.
//
// gpt-oss was trained on the "harmony" chat format, where tools are declared as
// a TypeScript namespace and a tool call is an assistant message on the
// `commentary` channel addressed to `functions.<name>`:
//
//   <|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"filePath":"/a"}<|call|>
//
// Providers that do not enable tool calling for gpt-oss (e.g. SiliconFlow) still
// let the model emit these messages as raw text. We render the tool catalog in
// the trained format, stop generation at <|call|>, and parse the raw harmony
// text deterministically here. No natural-language parsing is involved: only
// the formal harmony tokens and headers are interpreted.

import type { JSONSchema } from "./schema.ts";
import { extractBalancedObject } from "./toolcall.ts";

export interface ToolDef {
  type?: string;
  function: { name: string; description?: string; parameters?: JSONSchema };
}

// ---------------------------------------------------------------- rendering

export function renderToolNamespace(tools: ToolDef[]): string {
  const lines: string[] = ["# Tools", "", "## functions", "", "namespace functions {", ""];
  for (const t of tools) {
    const f = t.function;
    if (f.description) for (const l of f.description.trim().split(/\r?\n/)) lines.push(`// ${l}`.trimEnd());
    const params = f.parameters;
    if (!params?.properties || Object.keys(params.properties).length === 0) {
      lines.push(`type ${f.name} = () => any;`, "");
      continue;
    }
    lines.push(`type ${f.name} = (_: ${renderObject(params, 0, params)}) => any;`, "");
  }
  lines.push("} // namespace functions");
  return lines.join("\n");
}

function renderObject(schema: JSONSchema, depth: number, root: JSONSchema): string {
  const props: Record<string, JSONSchema> = schema.properties ?? {};
  const req: string[] = schema.required ?? [];
  const pad = "  ".repeat(depth);
  const out: string[] = ["{"];
  for (const [k, raw] of Object.entries(props)) {
    const s = deref(raw, root);
    if (s.description) for (const l of String(s.description).trim().split(/\r?\n/)) out.push(`${pad}// ${l}`.trimEnd());
    const def = s.default !== undefined ? ` // default: ${typeof s.default === "string" ? s.default : JSON.stringify(s.default)}` : "";
    out.push(`${pad}${k}${req.includes(k) ? "" : "?"}: ${renderType(s, depth + 1, root)},${def}`);
  }
  out.push(`${"  ".repeat(Math.max(0, depth - 1))}}`);
  return out.join("\n");
}

function deref(s: JSONSchema, root: JSONSchema): JSONSchema {
  if (s?.$ref && typeof s.$ref === "string" && s.$ref.startsWith("#")) {
    let cur: any = root;
    for (const p of s.$ref.slice(1).split("/").filter(Boolean)) cur = cur?.[p];
    if (cur) return { ...cur, ...s, $ref: undefined };
  }
  return s ?? {};
}

function renderType(s: JSONSchema, depth: number, root: JSONSchema): string {
  s = deref(s, root);
  if (Array.isArray(s.enum)) return s.enum.map((e: unknown) => JSON.stringify(e)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map((u: JSONSchema) => renderType(u, depth, root)).join(" | ");
  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ["object"] : [];
  if (types.length === 0) return "any";
  return types
    .map((t) => {
      switch (t) {
        case "integer":
        case "number":
          return "number";
        case "string":
        case "boolean":
        case "null":
          return t;
        case "array": {
          const inner = s.items ? renderType(s.items, depth, root) : "any";
          return /[\s|{]/.test(inner) ? `Array<${inner}>` : `${inner}[]`;
        }
        case "object":
          return s.properties ? renderObject(s, depth, root) : "object";
        default:
          return "any";
      }
    })
    .join(" | ");
}

// ------------------------------------------------------------------ parsing

export interface HarmonyMessage {
  role: string;
  channel: string;
  recipient?: string;
  constrain?: string;
  content: string;
  /** Terminator token; null when the text ended without one (stop sequence / EOS). */
  end: "end" | "call" | "return" | null;
  implicit: boolean;
}

const TOKEN_RE = /<\|(start|end|message|channel|constrain|call|return)\|>/g;
const CHANNELS = new Set(["analysis", "commentary", "final"]);

export function hasHarmonyTokens(text: string): boolean {
  return /<\|(start|end|message|channel|constrain|call|return)\|>/.test(text);
}

export function stripHarmonyTokens(text: string): string {
  return text.replace(/<\|[a-z_]+\|>/g, "");
}

/** Splits raw harmony text into messages. `initialChannel` applies to leading text with no header. */
export function parseHarmony(raw: string, initialChannel: string): HarmonyMessage[] {
  const msgs: HarmonyMessage[] = [];
  let cur: HarmonyMessage | null = { role: "assistant", channel: initialChannel, content: "", end: null, implicit: true };
  let mode: "body" | "header" = "body";
  let header = "";
  let pos = 0;

  const close = (end: HarmonyMessage["end"]) => {
    if (cur && (cur.content.trim() !== "" || cur.recipient || end)) {
      cur.end = end;
      msgs.push(cur);
    }
    cur = null;
  };

  for (const m of raw.matchAll(TOKEN_RE)) {
    const text = raw.slice(pos, m.index);
    pos = m.index! + m[0].length;
    if (mode === "body") cur!.content += text;
    else header += text;
    const tok = m[1];
    switch (tok) {
      case "start":
        if (mode === "body") close(null);
        mode = "header";
        header = "";
        break;
      case "channel":
      case "constrain":
        if (mode === "body") {
          // A header began without <|start|> (seen after a terminator or mid-text).
          close(null);
          mode = "header";
          header = "";
        }
        header += `<|${tok}|>`;
        break;
      case "message":
        if (mode === "header") {
          cur = parseHeader(header);
        } else {
          // Text before <|message|> in a body was really a header (e.g. "commentary to=read json<|message|>").
          const h = cur!.content;
          cur!.content = "";
          const parsed = parseHeader(h);
          if (cur!.implicit && h.trim() === "") cur = { ...cur!, implicit: false };
          else cur = parsed;
        }
        mode = "body";
        header = "";
        break;
      case "end":
      case "call":
      case "return":
        if (mode === "body") close(tok);
        mode = "header";
        header = "";
        break;
    }
  }
  const tail = raw.slice(pos);
  if (mode === "body") {
    cur!.content += tail;
    close(null);
  } else {
    header += tail;
    const bare = stripHarmonyTokens(header).trim();
    if (/to=/.test(header)) {
      // Truncated right after a tool-call header (no <|message|> yet): keep it so the caller can report it.
      const h = parseHeader(header);
      msgs.push({ ...h, end: null });
    } else if (bare && !header.includes("<|channel|>") && !/^(assistant|analysis|commentary|final)(\s|$)/.test(bare)) {
      // Plain text after a terminator with no header at all: treat it as a final answer rather than drop it.
      msgs.push({ role: "assistant", channel: "final", content: bare, end: null, implicit: true });
    }
  }
  return msgs;
}

function parseHeader(h: string): HarmonyMessage {
  const recipient = h.match(/to=([^\s<]+)/)?.[1];
  const [rolePart, ...rest] = h.split(/<\|channel\|>/);
  let role = "assistant";
  let channel = "unknown";
  const roleWords = stripHarmonyTokens(rolePart).trim().split(/\s+/).filter(Boolean);
  const first = roleWords[0];
  if (first && !first.startsWith("to=")) {
    if (CHANNELS.has(first)) channel = first;
    else role = first;
  }
  if (rest.length) {
    const chanText = rest.join(" ");
    const w = stripHarmonyTokens(chanText).trim().split(/\s+/)[0];
    if (w && !w.startsWith("to=")) channel = w;
  }
  let constrain = h.match(/<\|constrain\|>\s*([^\s<]+)/)?.[1];
  if (!constrain && recipient) {
    // "to=functions.read json" or "to=read code"
    const after = h.slice(h.indexOf(`to=${recipient}`) + 3 + recipient.length);
    const w = stripHarmonyTokens(after).trim().split(/\s+/)[0];
    if (w && !CHANNELS.has(w)) constrain = w;
  }
  if (recipient && channel === "unknown") channel = "commentary";
  return { role, channel, recipient, constrain, content: "", end: null, implicit: false };
}

// ----------------------------------------------------------- interpretation

export interface HarmonyTurn {
  reasoning: string;
  /** User-visible text (final channel, or commentary preambles). */
  text: string;
  call?: { recipient: string; name: string; args: string; terminated: boolean };
  /** Tool calls that followed the first one without a tool result in between. */
  extraCalls: { name: string; args: string }[];
  /** The model wrote a message in a tool's voice (it simulated a tool result). */
  hallucinatedToolOutput: boolean;
  /** Content after the first call that was discarded. */
  discarded: number;
}

export function toolNameFromRecipient(recipient: string): string {
  return recipient.replace(/^functions[.:/]/, "").trim();
}

/**
 * Interprets the provider's reasoning/content streams. Everything after the
 * first tool call is discarded: without a real tool result it can only be the
 * model imagining the output.
 */
export function interpretHarmony(reasoning: string, content: string): HarmonyTurn {
  // Leading content text with no header: if the provider already split off the
  // reasoning, it is the final answer; if content carries raw harmony without a
  // separate reasoning field, it is the analysis that precedes a call.
  const contentTokens = hasHarmonyTokens(content);
  const leading = !contentTokens || reasoning.trim() !== "" ? "final" : "analysis";
  const msgs = [...(reasoning ? parseHarmony(reasoning, "analysis") : []), ...(content ? parseHarmony(content, leading) : [])];
  // A lone implicit segment terminated by <|return|> is the final answer.
  const turn: HarmonyTurn = { reasoning: "", text: "", extraCalls: [], hallucinatedToolOutput: false, discarded: 0 };
  let afterCall = false;
  for (const m of msgs) {
    const isCall = !!m.recipient && !/^(assistant|user|all)$/i.test(m.recipient);
    if (afterCall) {
      if (isCall && m.role === "assistant" && turn.hallucinatedToolOutput === false && turn.discarded === 0) {
        turn.extraCalls.push({ name: toolNameFromRecipient(m.recipient!), args: m.content.trim() });
        continue;
      }
      if (m.role !== "assistant") turn.hallucinatedToolOutput = true;
      turn.discarded += m.content.length;
      continue;
    }
    if (m.role !== "assistant") {
      turn.hallucinatedToolOutput = true;
      turn.discarded += m.content.length;
      continue;
    }
    if (isCall) {
      let args = m.content.trim();
      // Malformed header with the arguments inside the recipient: to=functions.read>{"filePath":...}()
      if (!args && m.recipient!.includes("{")) args = extractBalancedObject(m.recipient!) ?? "";
      turn.call = { recipient: m.recipient!, name: toolNameFromRecipient(m.recipient!), args, terminated: m.end === "call" };
      afterCall = true;
      continue;
    }
    const channel = m.implicit && m.end === "return" ? "final" : m.channel;
    if (channel === "analysis") turn.reasoning += (turn.reasoning ? "\n" : "") + m.content;
    else turn.text += m.content;
  }
  turn.text = stripHarmonyTokens(turn.text).trim();
  turn.reasoning = stripHarmonyTokens(turn.reasoning).trim();
  return turn;
}
