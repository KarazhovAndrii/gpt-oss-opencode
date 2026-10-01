// Metrics derived from the proxy's JSONL diagnostics (see src/log.ts).

import fs from "node:fs";
import path from "node:path";

export function readProxyEvents(logDir: string): any[] {
  const out: any[] = [];
  if (!fs.existsSync(logDir)) return out;
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (f.endsWith(".jsonl")) {
        for (const l of fs.readFileSync(full, "utf8").split("\n")) {
          if (!l.trim()) continue;
          try {
            out.push(JSON.parse(l));
          } catch {
            // partial line
          }
        }
      }
    }
  };
  walk(logDir);
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

export interface ProxyMetrics {
  requests: number;
  toolRequests: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
  modelMs: number;
  proposedCalls: number;
  emittedCalls: number;
  validationFailures: number;
  validationByCode: Record<string, number>;
  argRepairs: number;
  redundantHints: number;
  redundantPassthrough: number;
  /** Bash commands that cannot work in Windows PowerShell 5.1: re-prompted / run as written. */
  shellReprompts: number;
  shellPassthrough: number;
  guardStops: Record<string, number>;
  upstreamErrors: number;
  upstreamErrorKinds: Record<string, number>;
  backoffMs: number;
  emptyOutputs: number;
  toolResultErrors: number;
  /** Tool results whose tool_call_id does not match any call the proxy emitted. */
  uncorrelatedResults: number;
  notes: Record<string, number>;
}

export function proxyMetrics(ev: any[]): ProxyMetrics {
  const m: ProxyMetrics = {
    requests: 0,
    toolRequests: 0,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUSD: 0,
    modelMs: 0,
    proposedCalls: 0,
    emittedCalls: 0,
    validationFailures: 0,
    validationByCode: {},
    argRepairs: 0,
    redundantHints: 0,
    redundantPassthrough: 0,
    shellReprompts: 0,
    shellPassthrough: 0,
    guardStops: {},
    upstreamErrors: 0,
    upstreamErrorKinds: {},
    backoffMs: 0,
    emptyOutputs: 0,
    toolResultErrors: 0,
    uncorrelatedResults: 0,
    notes: {},
  };
  const emittedIds = new Set<string>();
  for (const e of ev) {
    switch (e.type) {
      case "request":
        m.requests++;
        if (e.tools?.length) m.toolRequests++;
        break;
      case "response":
        m.modelCalls += e.modelCalls ?? 0;
        m.promptTokens += e.usage?.prompt_tokens ?? 0;
        m.completionTokens += e.usage?.completion_tokens ?? 0;
        m.costUSD += e.costUSD ?? 0;
        m.emittedCalls += e.calls?.length ?? 0;
        for (const c of e.calls ?? []) emittedIds.add(c.id);
        break;
      case "model_output":
        m.modelMs += e.ms ?? 0;
        m.proposedCalls += e.proposed?.length ?? 0;
        for (const n of e.notes ?? []) {
          const k = String(n).replace(/\d+/g, "N");
          m.notes[k] = (m.notes[k] ?? 0) + 1;
        }
        break;
      case "validation_failure":
        m.validationFailures++;
        m.validationByCode[e.code] = (m.validationByCode[e.code] ?? 0) + 1;
        break;
      case "call_repaired":
        m.argRepairs += e.repairs?.length ?? 0;
        break;
      case "redundant_call":
        if (e.action === "hint") m.redundantHints++;
        else m.redundantPassthrough++;
        break;
      case "shell_mismatch":
        if (e.action === "reprompt") m.shellReprompts++;
        else m.shellPassthrough++;
        break;
      case "guard_stop":
        m.guardStops[e.kind] = (m.guardStops[e.kind] ?? 0) + 1;
        break;
      case "upstream_error":
        m.upstreamErrors++;
        m.upstreamErrorKinds[e.kind] = (m.upstreamErrorKinds[e.kind] ?? 0) + 1;
        m.backoffMs += e.backoffMs ?? 0;
        break;
      case "empty_output":
        m.emptyOutputs++;
        break;
      case "tool_result":
        if (e.isError) m.toolResultErrors++;
        break;
    }
  }
  for (const e of ev) if (e.type === "tool_result" && e.tool_call_id && !emittedIds.has(e.tool_call_id)) m.uncorrelatedResults++;
  return m;
}

/** First-attempt validity: share of model-proposed calls that passed validation. */
export function validCallRate(m: ProxyMetrics): number | undefined {
  if (m.proposedCalls === 0) return undefined;
  const invalid = Object.entries(m.validationByCode)
    .filter(([k]) => k !== "protocol")
    .reduce((a, [, v]) => a + v, 0);
  return (m.proposedCalls - invalid) / m.proposedCalls;
}
