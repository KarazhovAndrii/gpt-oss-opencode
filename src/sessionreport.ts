// Session analysis for gpt-oss-proxy diagnostics (used by bin/report.ts).

export interface Flag {
  severity: "high" | "medium" | "low";
  message: string;
}

export function analyze(ev: any[]) {
  const flags: Flag[] = [];
  const requests = ev.filter((e) => e.type === "request");
  const responses = ev.filter((e) => e.type === "response");
  const outputs = ev.filter((e) => e.type === "model_output");
  const toolReqs = requests.filter((r) => r.tools?.length);
  const sum = (xs: any[], f: (x: any) => number) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const usage = { prompt: sum(responses, (r) => r.usage?.prompt_tokens), completion: sum(responses, (r) => r.usage?.completion_tokens) };
  const cost = sum(responses, (r) => r.costUSD);
  const modelCalls = sum(responses, (r) => r.modelCalls);
  const calls = responses.flatMap((r) => (r.calls ?? []).map((c: any) => ({ ...c, ts: r.ts })));
  const results = ev.filter((e) => e.type === "tool_result");

  const vf = ev.filter((e) => e.type === "validation_failure");
  if (vf.length) {
    const byCode: Record<string, number> = {};
    for (const v of vf) byCode[v.code] = (byCode[v.code] ?? 0) + 1;
    flags.push({ severity: vf.length > 3 ? "high" : "medium", message: `${vf.length} invalid tool call(s) from the model (${Object.entries(byCode).map(([k, v]) => `${k}:${v}`).join(", ")}); repaired by re-prompting` });
  }
  const stops = ev.filter((e) => e.type === "guard_stop");
  for (const s of stops) flags.push({ severity: "high", message: `turn stopped by the proxy (${s.kind}): ${String(s.reason).slice(0, 200)}` });
  const red = ev.filter((e) => e.type === "redundant_call");
  if (red.length) flags.push({ severity: red.some((r) => r.action === "passthrough") ? "high" : "medium", message: `${red.length} redundant call(s) proposed (${red.filter((r) => r.action === "hint").length} answered with a hint, ${red.filter((r) => r.action === "passthrough").length} passed through): ${[...new Set(red.map((r) => String(r.key).slice(0, 80)))].join("; ")}` });
  // "aborted" = OpenCode closed the request (e.g. its title request when a run ends): not a provider problem.
  const upErr = ev.filter((e) => e.type === "upstream_error" && e.kind !== "aborted");
  if (upErr.length) {
    const kinds: Record<string, number> = {};
    for (const u of upErr) kinds[u.kind] = (kinds[u.kind] ?? 0) + 1;
    flags.push({ severity: upErr.some((u) => !u.willRetry) ? "high" : "low", message: `${upErr.length} provider error(s): ${Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(", ")} (${upErr.filter((u) => u.willRetry).length} retried)` });
  }
  const trunc = ev.filter((e) => e.type === "context_truncated");
  if (trunc.length)
    flags.push({ severity: "high", message: `${trunc.length} request(s) were truncated by the model server (it evaluated ${Math.min(...trunc.map((t) => t.promptTokensSeen))} of ~${Math.max(...trunc.map((t) => t.estimatedPromptTokens))} prompt tokens): raise its context length (Ollama: OLLAMA_CONTEXT_LENGTH / num_ctx >= 32768)` });
  const internal = ev.filter((e) => e.type === "internal_error");
  if (internal.length) flags.push({ severity: "high", message: `${internal.length} internal proxy error(s): ${String(internal[0].error).split("\n")[0].slice(0, 160)}` });
  const empties = ev.filter((e) => e.type === "empty_output");
  if (empties.length) flags.push({ severity: "medium", message: `${empties.length} empty model output(s) (no text, no call)` });
  const errResults = results.filter((r) => r.isError);
  if (errResults.length) flags.push({ severity: errResults.length > 3 ? "medium" : "low", message: `${errResults.length} tool call(s) failed in OpenCode: ${errResults.slice(0, 5).map((r) => `${r.name}: ${String(r.preview).slice(0, 80)}`).join(" | ")}` });
  // Same call executed more than once anywhere in the session (including legit re-reads after edits).
  const seen = new Map<string, number>();
  for (const c of calls) seen.set(`${c.name} ${c.args}`, (seen.get(`${c.name} ${c.args}`) ?? 0) + 1);
  const dup = [...seen.entries()].filter(([, n]) => n > 1);
  if (dup.length) flags.push({ severity: "low", message: `identical calls executed more than once: ${dup.map(([k, n]) => `${k.slice(0, 100)} x${n}`).join("; ")}` });
  const slow = outputs.filter((o) => o.ms > 30_000);
  if (slow.length) flags.push({ severity: "low", message: `${slow.length} slow model call(s) (>30s), max ${Math.max(...slow.map((o) => o.ms))}ms` });
  const big = results.filter((r) => r.chars > 20_000);
  if (big.length) flags.push({ severity: "low", message: `${big.length} large tool result(s) (>20k chars) inflate the context: ${big.map((r) => `${r.name} ${r.chars}`).join(", ")}` });
  const denied = results.filter((r) => /rule which prevents you from using this specific tool call|rejected permission/i.test(String(r.preview)));
  if (denied.length) flags.push({ severity: "medium", message: `${denied.length} tool call(s) denied by OpenCode permissions (often a mistyped path outside the project): ${denied.map((d) => d.name).join(", ")}` });
  const ids = new Set(calls.map((c) => c.id));
  const orphan = results.filter((r) => r.tool_call_id && !ids.has(r.tool_call_id));
  if (orphan.length) flags.push({ severity: "medium", message: `${orphan.length} tool result(s) with ids the proxy never emitted in this log (earlier proxy run or another proxy?)` });
  const notes = outputs.flatMap((o) => o.notes ?? []);
  const halluc = notes.filter((n: string) => /imagined|discarded/.test(n)).length;
  if (halluc) flags.push({ severity: "low", message: `${halluc} model output(s) contained imagined tool results after a call (discarded by the proxy)` });
  if (notes.some((n: string) => /stream corruption/.test(n))) flags.push({ severity: "high", message: "provider streaming corruption detected; set stream:false for this profile" });
  // Turns answered without using any tool although tools were available.
  const byObjective = new Map<string, { calls: number; final: boolean }>();
  for (const r of toolReqs) {
    const resp = responses.find((x) => x.req === r.req);
    const k = r.objective ?? "";
    const cur = byObjective.get(k) ?? { calls: 0, final: false };
    cur.calls += resp?.calls?.length ?? 0;
    if (resp && !resp.calls?.length) cur.final = true;
    byObjective.set(k, cur);
  }
  for (const [obj, v] of byObjective) if (v.final && v.calls === 0) flags.push({ severity: "low", message: `answered without any tool call: "${obj.slice(0, 100)}" (fine for questions, suspicious for tasks)` });

  const first = ev[0]?.ts;
  const last = ev.at(-1)?.ts;
  return {
    session: ev[0]?.session,
    profile: requests[0]?.profile,
    model: requests[0]?.model,
    strategy: toolReqs[0]?.strategy,
    route: ev.find((e) => e.type === "route")?.route,
    span: first && last ? { start: first, end: last, seconds: Math.round((Date.parse(last) - Date.parse(first)) / 1000) } : undefined,
    requests: requests.length,
    toolRequests: toolReqs.length,
    modelCalls,
    toolCallsEmitted: calls.length,
    toolResults: results.length,
    usage,
    costUSD: cost,
    modelSeconds: Math.round(sum(outputs, (o) => o.ms) / 1000),
    flags,
  };
}

export function timeline(ev: any[]): string[] {
  const lines: string[] = [];
  for (const e of ev) {
    const t = String(e.ts).slice(11, 19);
    switch (e.type) {
      case "request":
        lines.push(`${t} ── request ${e.req} (${e.tools?.length ? `${e.strategy}, ${e.tools.length} tools` : "no tools"}, ${e.messages} msgs, turn step ${e.turnSteps})`);
        break;
      case "tool_result":
        lines.push(`${t}    ← result ${e.name ?? "?"} ${e.isError ? "ERROR " : ""}(${e.chars} chars): ${String(e.preview).replace(/\s+/g, " ").slice(0, 110)}`);
        break;
      case "model_output":
        lines.push(`${t}    model ${e.ms}ms tok=${e.usage?.prompt_tokens ?? "?"}/${e.usage?.completion_tokens ?? "?"}${e.proposed?.length ? ` proposes ${e.proposed.map((p: any) => `${p.name}(${String(p.args).slice(0, 90)})`).join(", ")}` : e.textChars ? ` text ${e.textChars} chars` : " (empty)"}${e.notes ? ` [${e.notes.join("; ")}]` : ""}`);
        break;
      case "validation_failure":
        lines.push(`${t}    ✗ invalid ${e.code}${e.tool ? ` ${e.tool}` : ""}: ${String(e.error).slice(0, 140)}`);
        break;
      case "call_repaired":
        lines.push(`${t}    ~ repaired ${e.tool}: ${e.repairs.join("; ").slice(0, 160)}`);
        break;
      case "redundant_call":
        lines.push(`${t}    ↻ redundant ${e.tool} (${e.action})`);
        break;
      case "upstream_error":
        lines.push(`${t}    ! provider ${e.kind} attempt ${e.attempt}: ${String(e.error).slice(0, 120)}${e.willRetry ? " (retrying)" : ""}`);
        break;
      case "strategy_fallback":
        lines.push(`${t}    ⇄ strategy ${e.from} → ${e.to}: ${String(e.reason).slice(0, 100)}`);
        break;
      case "route":
        lines.push(`${t}    route ${e.route} (owned_by ${e.ownedBy ?? "?"})${e.note ? ` - ${e.note}` : ""}`);
        break;
      case "context_truncated":
        lines.push(`${t}    ! context truncated by the server: ${e.promptTokensSeen} of ~${e.estimatedPromptTokens} prompt tokens evaluated`);
        break;
      case "guard_stop":
        lines.push(`${t}    ■ STOP ${e.kind}: ${String(e.reason).slice(0, 160)}`);
        break;
      case "response":
        lines.push(`${t}    → ${e.calls?.length ? e.calls.map((c: any) => `${c.name}(${String(c.args).slice(0, 100)})`).join(", ") : `answer: ${String(e.text ?? "").replace(/\s+/g, " ").slice(0, 140)}`}  [${e.modelCalls} model call(s), ${e.ms}ms${e.costUSD ? `, $${e.costUSD.toFixed(5)}` : ""}]`);
        break;
    }
  }
  return lines;
}

