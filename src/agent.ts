// Handles one OpenCode chat request end to end:
//   OpenCode request -> strategy adapter -> model -> validation/repair/guard
//   -> OpenAI-format tool calls or text back to OpenCode.
// OpenCode stays the tool executor: this module only decides what to send back.

import crypto from "node:crypto";
import type { Config, Profile } from "./config.ts";
import { envPrefix } from "./config.ts";
import type { ChatMessage } from "./messages.ts";
import { afterCompaction, currentObjective, estimateTokens, findWorkingDirectory, fitContext, lastUserIndex, normalizeHistory, textOf } from "./messages.ts";
import { resolveTarget } from "./openwebui.ts";
import type { ToolDef } from "./harmony.ts";
import { interpretHarmony, stripHarmonyTokens } from "./harmony.ts";
import { validateToolCall, type ValidCall } from "./toolcall.ts";
import { analyzeTurn, canonicalKey, findRedundant, redundantHint, isErrorResult, type Step } from "./guard.ts";
import { adapterFor, type Adapter } from "./strategies.ts";
import { compactTools } from "./compact.ts";
import { detectShell, powershell51Feedback, powershell51Problems } from "./shell.ts";
import { addUsage, callModel, costUSD, UpstreamError, type Usage } from "./upstream.ts";
import type { ChatEmitter } from "./emitter.ts";
import type { Logger } from "./log.ts";
import { hashOf, logArgs, logText, truncate } from "./log.ts";

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  [k: string]: unknown;
}

export interface Outcome {
  finish: "stop" | "tool_calls" | "length";
  calls: (ValidCall & { id: string })[];
  text: string;
  modelCalls: number;
  /** Billed usage: all model calls of this request (log, cost). */
  usage?: Usage;
  /** Usage reported to OpenCode: the context size, which drives its compaction (see contextUsage). */
  reportedUsage?: Usage;
  diagnostic?: string;
  /** The provider rejected the request as too long for its context window (message for OpenCode). */
  overflow?: string;
  strategy: string;
}

interface LastCall {
  usage?: Usage;
  /** Estimated prompt tokens sent. */
  sentTokens: number;
  /** The server evaluated far fewer prompt tokens than were sent (silent truncation). */
  truncated: boolean;
}

/**
 * Usage reported to OpenCode. OpenCode compacts a session once prompt + completion reaches
 * limit.context - limit.output, so the prompt figure must be the size of the conversation: the
 * last model call's prompt (internal retries are not added up, or OpenCode compacts far too early),
 * the proxy's estimate when the server silently cut the prompt, plus whatever the context guard
 * trimmed (or OpenCode never sees the overflow and the proxy keeps trimming). Without provider
 * usage the figures are estimates. Billed usage stays in the proxy log and cost.
 */
export function contextUsage(last: LastCall | undefined, billed: Usage | undefined, trimmedTokens: number, outputChars: number): Usage | undefined {
  if (!last) return undefined;
  const prompt = (last.truncated || !last.usage ? last.sentTokens : last.usage.prompt_tokens) + trimmedTokens;
  const completion = billed?.completion_tokens ?? Math.ceil(outputChars / 3.2);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(billed?.reasoning_tokens ? { reasoning_tokens: billed.reasoning_tokens } : {}),
    ...(last.usage?.cached_tokens ? { cached_tokens: Math.min(last.usage.cached_tokens, prompt) } : {}),
  };
}

/** Native tool support learned at runtime for `auto` profiles. */
export const nativeSupport = new Map<string, boolean>();

/** Largest prompt (tokens) each model server evaluated in this process: its window is at least that. */
const provenPrompt = new Map<string, number>();
export function clearProvenPrompts() {
  provenPrompt.clear();
}

const PASSTHROUGH_KEYS = ["temperature", "top_p", "reasoning_effort", "seed", "frequency_penalty", "presence_penalty"];

export function newCallId(): string {
  return `call_${crypto.randomBytes(9).toString("base64url")}`;
}

function pickStrategy(p: Profile): Adapter {
  if (p.strategy === "auto") return adapterFor(nativeSupport.get(p.name) === false ? p.fallbackStrategy : "native");
  return adapterFor(p.strategy);
}

export interface RunContext {
  cfg: Config;
  profile: Profile;
  logger: Logger;
  session: string;
  reqId: string;
  emitter: ChatEmitter;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

function diagnostic(message: string): string {
  return `[gpt-oss-proxy] ${message}`;
}

/** A tool step for a user-facing message: the command for bash, the arguments otherwise. */
function describeStep(s: Step): string {
  const args = (s.args ?? {}) as Record<string, unknown>;
  if (s.name === "bash" && typeof args.command === "string") {
    const timeout = Number(args.timeout ?? 0);
    return `bash \`${truncate(args.command, 200)}\`${timeout ? ` (timeout ${Math.round(timeout / 1000)} s)` : ""}`;
  }
  return `${s.name} ${truncate(JSON.stringify(args), 200)}`;
}

/** What to do when the model server evaluated far fewer prompt tokens than were sent. */
export function truncationAdvice(profile: Profile, seen: number): string {
  const window = profile.contextWindow;
  // The server already provides the configured window: the request itself did not fit.
  if (seen >= window * 0.9)
    return `the request is larger than the context window (${window} tokens) even after the proxy shortened the conversation. Start a new session, or put large content in a file instead of the message.`;
  const raise =
    profile.kind === "openwebui"
      ? `raise num_ctx (Ollama OLLAMA_CONTEXT_LENGTH, the model's num_ctx, or profile "numCtx" on the /api route) to at least ${window}`
      : `raise the model server's context length to at least ${window}`;
  return `its context window is smaller than the ${window} tokens profile "${profile.name}" assumes, so instructions, tools or earlier results were cut. Either ${raise}, or set ${envPrefix(profile)}_CONTEXT_WINDOW (contextWindow) to the server's real context length so the proxy shortens the conversation to fit.`;
}

/** Logs the tool results OpenCode sent back for the previous step(s). */
function logToolResults(ctx: RunContext, messages: ChatMessage[]) {
  const names = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
  // Only results after the last assistant message that had no tool results yet.
  let i = messages.length - 1;
  const fresh: ChatMessage[] = [];
  while (i >= 0 && messages[i].role === "tool") fresh.unshift(messages[i--]);
  for (const m of fresh) {
    const text = textOf(m.content);
    ctx.logger.event(ctx.session, "tool_result", {
      req: ctx.reqId,
      tool_call_id: m.tool_call_id,
      name: names.get(m.tool_call_id ?? ""),
      isError: isErrorResult(text),
      chars: text.length,
      // Error texts (OpenCode messages) are kept for diagnosis; successful results only with content logging.
      preview: ctx.cfg.logContent || isErrorResult(text) ? truncate(text, 300) : undefined,
    });
  }
}

export async function runChat(req: ChatRequest, ctx: RunContext): Promise<Outcome> {
  const { cfg, profile, logger, session, reqId, emitter } = ctx;
  const limits = cfg.limits;
  const t0 = Date.now();
  const deadline = t0 + limits.requestBudgetMs;
  const tools = (req.tools ?? []).filter((t) => t?.function?.name);
  const messages = req.messages ?? [];
  const passthrough: Record<string, unknown> = {};
  for (const k of PASSTHROUGH_KEYS) if (req[k] !== undefined) passthrough[k] = req[k];
  const requested = req.max_completion_tokens ?? req.max_tokens ?? profile.maxOutputTokens;
  const maxTokens = Math.min(requested, profile.maxOutputTokens);

  const toolsHash = tools.length ? logger.catalog(session, tools) : undefined;
  // Tools as shown to the model; validation always uses OpenCode's originals.
  const compaction = profile.toolDescriptions === "compact" && tools.length ? compactTools(tools) : undefined;
  const shownTools = compaction?.tools ?? tools;
  logToolResults(ctx, messages);

  let adapter = tools.length ? pickStrategy(profile) : adapterFor("harmony");
  const normalized = normalizeHistory(messages);
  const analysis = analyzeTurn(normalized);
  const cwd = findWorkingDirectory(messages);
  const objective = currentObjective(messages);
  // What the user, OpenCode and successful tool results actually said (not the model's own
  // tool arguments): used to tell a mentioned path from an invented one.
  const grounded = messages
    .filter((m) => m.role === "system" || m.role === "user" || (m.role === "tool" && !isErrorResult(textOf(m.content))))
    .map((m) => textOf(m.content))
    .join("\n");
  logger.event(session, "request", {
    req: reqId,
    profile: profile.name,
    provider: profile.baseURL,
    model: profile.model,
    requestedModel: req.model,
    strategy: tools.length ? adapter.name : "plain",
    messages: messages.length,
    tools: tools.map((t) => t.function.name),
    toolsHash,
    toolDescriptions: compaction ? { compacted: compaction.compacted, chars: [compaction.before, compaction.after] } : undefined,
    stream: !!req.stream,
    maxTokens,
    turnSteps: analysis.steps.length,
    consecutiveErrors: analysis.consecutiveErrors,
    redundantExecuted: analysis.redundantExecuted,
    objective: logText(objective, cfg.logContent, 300),
    cwd,
  });

  let usage: Usage | undefined;
  let modelCalls = 0;
  let last: LastCall | undefined;
  let trimmedTokens = 0;
  const finish = (o: Omit<Outcome, "modelCalls" | "usage" | "reportedUsage" | "strategy" | "calls"> & { calls: ValidCall[] }): Outcome => {
    const calls = o.calls.map((c) => ({ ...c, id: newCallId() }));
    const reportedUsage = contextUsage(last, usage, trimmedTokens, o.text.length + calls.reduce((n, c) => n + c.argsJson.length, 0));
    const out: Outcome = { ...o, calls, modelCalls, usage, reportedUsage, strategy: tools.length ? adapter.name : "plain" };
    logger.event(session, "response", {
      req: reqId,
      finish: out.finish,
      calls: out.calls.map((c) => ({ id: c.id, name: c.name, args: logArgs(c.argsJson, cfg.logContent, 500) })),
      textChars: out.text.length,
      text: cfg.logContent ? truncate(out.text, 400) : undefined,
      diagnostic: out.diagnostic,
      modelCalls,
      ms: Date.now() - t0,
      usage,
      reportedUsage: reportedUsage?.prompt_tokens !== usage?.prompt_tokens ? reportedUsage : undefined,
      costUSD: costUSD(usage, profile),
      strategy: out.strategy,
    });
    return out;
  };
  const stop = (reason: string, kind: string, overflow?: string): Outcome => {
    logger.event(session, "guard_stop", { req: reqId, kind, reason });
    return finish({ finish: "stop", calls: [], text: diagnostic(reason), diagnostic: kind, overflow });
  };

  // ---- turn-level guards (bounded execution) ----
  if (tools.length) {
    if (analysis.steps.length >= limits.maxStepsPerTurn) {
      return stop(`Stopped after ${analysis.steps.length} tool steps in this turn (limit ${limits.maxStepsPerTurn}). The task may be too large for one turn or the model is looping; review the steps above, then send a follow-up message to continue.`, "step_budget");
    }
    if (analysis.redundantExecuted >= limits.maxRedundantPerTurn) {
      const reps = analysis.steps.filter((s) => s.redundant).map((s) => truncate(s.key, 120));
      return stop(`Stopped: the model repeated identical tool calls ${analysis.redundantExecuted} times without any change in between (${[...new Set(reps)].join("; ")}). This looks like a loop; please rephrase the request or give more specific guidance.`, "repeated_calls");
    }
    if (analysis.consecutiveErrors >= limits.maxConsecutiveErrors) {
      return stop(`Stopped after ${analysis.consecutiveErrors} consecutive failing tool calls. Last error: ${truncate(analysis.steps[analysis.steps.length - 1]?.result ?? "", 300)}`, "consecutive_errors");
    }
  }

  const notes: string[] = [];
  if (analysis.consecutiveErrors >= 3) {
    notes.push(`The last ${analysis.consecutiveErrors} tool calls failed. Stop and reconsider: re-read the relevant file or check the path before trying again, and do not repeat a failing call unchanged.`);
  }
  const shell = detectShell(tools);
  const prompt = { cwd, objective, notes, shell };

  // Context guard: the proxy adds rules + the tool namespace that OpenCode does not
  // count, so keep the history within the provider window (oldest results first).
  const reserve = maxTokens + Math.ceil(JSON.stringify(shownTools).length / 3.2) + 1500;
  const fitted = fitContext(messages, Math.max(4000, profile.contextWindow - reserve));
  trimmedTokens = fitted.before - fitted.after;
  if (fitted.trimmed) {
    const cuts = fitted.cuts.map(({ role, chars, kept }) => ({ role, chars, kept }));
    logger.event(session, "context_trimmed", { req: reqId, trimmed: fitted.trimmed, estTokens: [fitted.before, fitted.after], window: profile.contextWindow, cuts: cuts.length ? cuts : undefined });
    // The user's own message did not fit: say so once per turn (it stays cut on every later step).
    const own = fitted.cuts.find((c) => c.index === lastUserIndex(messages));
    if (own && !analysis.steps.length) {
      emitter.reasoning(
        `\n${diagnostic(`your message is about ${Math.ceil(own.chars / 3.2)} tokens, more than fits in the model's context window (${profile.contextWindow} tokens), so the model sees only its first and last ${own.kept / 2} characters. For large data, save it to a file in the project and give the agent the path instead of pasting it, so it can read the parts it needs.`)}\n`,
      );
    }
  }
  const history = fitted.messages;

  // Backend-specific endpoint and payload adjustments (OpenWebUI route selection).
  const target = await resolveTarget(profile, ctx.fetchImpl);
  if (target.route) logger.event(session, "route", { req: reqId, route: target.route, ownedBy: target.ownedBy, baseURL: target.profile.baseURL, note: target.note });
  let truncationWarned = false;

  const extra: ChatMessage[] = [];
  let repairs = 0;
  let hints = 0;
  let empties = 0;
  let shellReprompts = 0;
  // Tool whose call was just rejected as invalid; a bare JSON reply right after is its corrected arguments.
  let pendingRepairTool: string | undefined;
  // Earlier step whose repetition the loop guard just refused to pass on.
  let blocked: Step | undefined;
  // Calls accepted earlier in this same response also count for redundancy checks.
  const steps: Step[] = [...analysis.steps];

  for (let iteration = 0; iteration < 12; iteration++) {
    if (ctx.signal.aborted) return finish({ finish: "stop", calls: [], text: "", diagnostic: "client_aborted" });
    if (Date.now() > deadline - 2000) {
      return stop(`Gave up after ${Math.round((Date.now() - t0) / 1000)}s (request budget ${Math.round(limits.requestBudgetMs / 1000)}s) with ${modelCalls} model calls. The provider may be slow or overloaded; try again.`, "request_budget");
    }
    const body = target.patchBody(
      tools.length
        ? adapter.build({ messages: history, tools: shownTools, toolChoice: req.tool_choice, prompt, maxTokens, extra, passthrough })
        : { ...passthrough, messages: normalizeHistory(history), max_tokens: maxTokens },
    );
    if (process.env.GPT_OSS_DUMP_REQUESTS) logger.dump(session, `${reqId}-${iteration}`, { profile: profile.name, tools, body });

    let result;
    const callStart = Date.now();
    let reasoningStarted = false;
    try {
      modelCalls++;
      result = await callModel({
        profile: target.profile,
        limits,
        body,
        signal: ctx.signal,
        deadline,
        fetchImpl: ctx.fetchImpl,
        onReasoning: (d) => {
          if (!reasoningStarted && iteration > 0) emitter.reasoning("\n\n");
          reasoningStarted = true;
          emitter.reasoning(d);
        },
        onAttempt: (a) => {
          logger.event(session, a.ok ? "upstream_ok" : "upstream_error", { req: reqId, iteration, ...a });
          // Let the user see why nothing is happening (shown in OpenCode's thinking area).
          if (!a.ok && a.willRetry && (a.kind === "rate_limit" || a.status === 503))
            emitter.reasoning(`\n[gpt-oss-proxy] provider is rate limiting (${a.status}); retrying in ${Math.round((a.backoffMs ?? 0) / 1000)}s…\n`);
        },
      });
    } catch (e) {
      const err = e as UpstreamError;
      if (err.kind === "tools_unsupported" && profile.strategy === "auto" && adapter.name === "native") {
        nativeSupport.set(profile.name, false);
        adapter = adapterFor(profile.fallbackStrategy);
        logger.event(session, "strategy_fallback", { req: reqId, from: "native", to: adapter.name, reason: err.message });
        modelCalls--;
        continue;
      }
      if (err.kind === "aborted") return finish({ finish: "stop", calls: [], text: "", diagnostic: "client_aborted" });
      if (err.kind === "tool_parse" && repairs < limits.repairAttempts) {
        // The model server could not parse the model's tool-call arguments: ask the model to resend them.
        repairs++;
        logger.event(session, "validation_failure", { req: reqId, code: "bad_json", tool: "(server-side parse)", error: err.message, attempt: repairs });
        adapter.nudge(extra, `Your previous function call could not be parsed (${truncate(err.message, 400)}). Call the function again with arguments that are one valid JSON object.`);
        continue;
      }
      const owui = profile.kind === "openwebui";
      const hint =
        err.kind === "tools_unsupported"
          ? ` This provider does not support native tool calling for ${profile.model}; set "strategy": "harmony" (or "auto") for profile "${profile.name}".`
          : err.kind === "auth" && owui
          ? ` Check ${profile.apiKeyEnv ?? "the API key"} for profile "${profile.name}". In OpenWebUI: enable API keys (Admin Panel > Settings > General, or ENABLE_API_KEYS=True), give the key's user the API-keys permission, and if API-key endpoint restrictions are on allow /api/models, /api/chat/completions and /ollama/v1/chat/completions.`
          : err.kind === "auth"
          ? ` Check the API key environment variable ${profile.apiKeyEnv ?? "(apiKeyEnv)"} for profile "${profile.name}".`
          : owui && /not found/i.test(err.message)
          ? ` The model id "${profile.model}" must match an OpenWebUI model id exactly (see /api/models) and the key's user must have access to it.`
          : err.kind === "context_length"
            ? " The conversation is too long for the model; run /compact in OpenCode or start a new session."
            : err.kind === "timeout"
              ? " The provider did not respond in time; limits can be raised in gpt-oss-proxy.config.json (limits.requestTimeoutMs, firstByteTimeoutMs, idleTimeoutMs)."
              : "";
      // An overflow goes to OpenCode as an error it compacts the session on (server.ts); the text
      // is the fallback once the stream has started. Right after a compaction it would only make
      // OpenCode compact and retry in a loop (observed), so the turn ends with the text instead.
      const compacted = afterCompaction(messages) && !analysis.steps.length;
      const overflow = err.kind === "context_length" && !compacted ? diagnostic(`context_length_exceeded: provider "${profile.name}" rejected the request as longer than the model's context window (${err.message})`) : undefined;
      const why = err.kind === "context_length" && compacted ? ` The request still does not fit right after OpenCode compacted the conversation, so the provider's real context window is probably smaller than configured: check limit.context in opencode.json and ${envPrefix(profile)}_CONTEXT_WINDOW, or the provider's output limit (maxOutputTokens).` : hint;
      return stop(`Model provider "${profile.name}" failed after ${err.attempts} attempt(s): ${err.message}.${why}`, `upstream_${err.kind}`, overflow);
    }
    if (profile.strategy === "auto" && adapter.name === "native" && tools.length) nativeSupport.set(profile.name, true);
    usage = addUsage(usage, result.usage);

    // Silent context truncation (e.g. Ollama's default num_ctx of 4096 below 23 GiB VRAM): the
    // provider reports how many prompt tokens it actually evaluated.
    const sentTokens = estimateTokens((body.messages as ChatMessage[]) ?? []) + (body.tools ? Math.ceil(JSON.stringify(body.tools).length / 3.2) : 0);
    const seen = result.usage?.prompt_tokens ?? 0;
    // A server that already evaluated a prompt this large did not cut this one: the estimate is
    // off (observed: "6,706 of ~11,400" right after the same server evaluated 26,094 tokens).
    const server = `${target.profile.baseURL}|${target.profile.model}`;
    const proven = provenPrompt.get(server) ?? 0;
    if (seen > proven) provenPrompt.set(server, seen);
    last = { usage: result.usage, sentTokens, truncated: seen > 0 && sentTokens > 3000 && seen < sentTokens * 0.6 && sentTokens > proven };
    if (last.truncated) {
      logger.event(session, "context_truncated", { req: reqId, iteration, promptTokensSeen: seen, estimatedPromptTokens: sentTokens });
      if (!truncationWarned) {
        truncationWarned = true;
        emitter.reasoning(`\n${diagnostic(`the model server evaluated only ${seen} of ~${sentTokens} prompt tokens - ${truncationAdvice(profile, seen)}`)}\n`);
      }
    }

    const sep = iteration > 0 && !reasoningStarted ? "\n\n" : "";
    if (!tools.length) {
      const turn = interpretHarmony(result.reasoning, result.content);
      const shown = reasoningStarted ? interpretHarmony("", result.content).reasoning : turn.reasoning;
      if (shown) emitter.reasoning(sep + shown);
      logger.event(session, "model_output", { req: reqId, iteration, ms: Date.now() - callStart, finish: result.finishReason, usage: result.usage, content: cfg.logContent ? truncate(result.content, 4000) : undefined });
      return finish({ finish: result.finishReason === "length" ? "length" : "stop", calls: [], text: turn.text || stripHarmonyTokens(result.content).trim() });
    }

    const interp = adapter.interpret(result);
    logger.event(session, "model_output", {
      req: reqId,
      iteration,
      ms: Date.now() - callStart,
      firstByteMs: result.firstByteMs,
      finish: result.finishReason,
      usage: result.usage,
      reasoningChars: result.reasoning.length,
      content: cfg.logContent ? truncate(result.content, 6000) : undefined,
      proposed: interp.calls.map((c) => ({ name: c.name, args: logArgs(typeof c.args === "string" ? c.args : JSON.stringify(c.args), cfg.logContent, 800) })),
      textChars: interp.text.length,
      notes: interp.notes.length ? interp.notes : undefined,
    });
    const shownReasoning = reasoningStarted ? interp.contentReasoning : interp.reasoning;
    if (shownReasoning) emitter.reasoning(sep + shownReasoning);

    if (interp.protocolError && !interp.calls.length) {
      if (repairs < limits.repairAttempts) {
        repairs++;
        logger.event(session, "validation_failure", { req: reqId, code: "protocol", error: interp.protocolError, raw: logText(result.content, cfg.logContent, 1000) });
        extra.push({ role: "assistant", content: truncate(result.content, 4000) });
        adapter.nudge(extra, interp.protocolError);
        continue;
      }
      if (interp.text.trim()) return finish({ finish: "stop", calls: [], text: interp.text.trim() });
    }

    if (!interp.calls.length && pendingRepairTool && /^\{[\s\S]*\}$/.test(interp.text.trim())) {
      // Answering a correction, the model sometimes resends only the JSON arguments
      // without addressing the function. Scoped to the tool that was just rejected.
      interp.calls.push({ name: pendingRepairTool, args: interp.text.trim() });
      interp.text = "";
      logger.event(session, "call_repaired", { req: reqId, tool: pendingRepairTool, repairs: ["bare JSON reply after a rejected call used as its arguments"] });
    }
    pendingRepairTool = undefined;

    if (interp.calls.length) {
      const valid: ValidCall[] = [];
      let rejected = false;
      for (const proposed of interp.calls) {
        const v = validateToolCall(proposed, tools, cwd, grounded);
        if (!v.ok) {
          logger.event(session, "validation_failure", { req: reqId, code: v.code, tool: v.name, error: v.error, rawArgs: logText(v.rawArgs, cfg.logContent, 1000), attempt: repairs + 1 });
          if (repairs < limits.repairAttempts) {
            repairs++;
            adapter.feedback(extra, { name: v.name, rawArgs: v.rawArgs }, `Error: ${v.error}`, newCallId());
            pendingRepairTool = v.code === "unknown_tool" ? undefined : v.name;
            rejected = true;
            break;
          }
          return stop(`The model produced an invalid tool call ${repairs + 1} times in a row and was stopped. Last problem: ${v.error}`, `invalid_call_${v.code}`);
        }
        if (v.call.repairs.length) logger.event(session, "call_repaired", { req: reqId, tool: v.call.name, repairs: v.call.repairs });
        // A command that cannot work in Windows PowerShell 5.1 (bash or cmd.exe syntax) goes back to the
        // model with the reason and a working form. Once the budget is spent it runs as written: PowerShell's
        // own error then tells the model, and the turn never stops over it.
        const command = v.call.name === "bash" && shell === "powershell" ? String(v.call.args.command ?? "") : "";
        const problems = command ? powershell51Problems(command) : [];
        if (problems.length) {
          const action = shellReprompts < limits.shellReprompts ? "reprompt" : "passthrough";
          logger.event(session, "shell_mismatch", { req: reqId, shell, action, found: problems.map((p) => p.found), command: truncate(command, 200) });
          if (action === "reprompt") {
            shellReprompts++;
            adapter.feedback(extra, { name: v.call.name, rawArgs: v.call.argsJson }, powershell51Feedback(command, problems), newCallId());
            rejected = true;
            break;
          }
        }
        const key = canonicalKey(v.call.name, v.call.args);
        const prev = findRedundant(steps, key, v.call.args);
        if (prev) {
          if (hints < limits.redundantHints) {
            hints++;
            logger.event(session, "redundant_call", { req: reqId, tool: v.call.name, key: cfg.logContent ? truncate(key, 300) : hashOf(key), action: "hint", hint: hints });
            adapter.feedback(extra, { name: v.call.name, rawArgs: v.call.argsJson }, redundantHint(prev), newCallId());
            blocked = prev;
            rejected = true;
            break;
          }
          logger.event(session, "redundant_call", { req: reqId, tool: v.call.name, key: cfg.logContent ? truncate(key, 300) : hashOf(key), action: "passthrough" });
        }
        valid.push(v.call);
        steps.push({ name: v.call.name, key, args: v.call.args, result: "", isError: false, redundant: !!prev });
      }
      if (rejected) continue;
      return finish({ finish: "tool_calls", calls: valid, text: interp.text });
    }

    if (interp.text.trim()) {
      return finish({ finish: result.finishReason === "length" ? "length" : "stop", calls: [], text: interp.text });
    }

    // Neither a call nor text (e.g. only reasoning, or output cut at the token limit).
    logger.event(session, "empty_output", { req: reqId, iteration, finish: result.finishReason, reasoningChars: result.reasoning.length, contentChars: result.content.length });
    if (empties < limits.emptyRetries) {
      empties++;
      adapter.nudge(
        extra,
        result.finishReason === "length"
          ? "Your previous reply hit the output limit before producing an answer or a function call. Think briefly, then either call the next function or give the final answer."
          : blocked
            ? "Your previous reply was empty. Do not repeat the call that was not executed. Reply to the user now: say what you ran, what the last result showed, and what is blocking the task."
            : "Your previous reply contained neither a function call nor an answer. Continue the task: call the next function, or give the final answer if the request is complete.",
      );
      continue;
    }
    // Show where the model got stuck instead of only that it did (observed: silent after
    // `pip install` timed out twice; the user saw no output at all).
    const lastStep = blocked ?? analysis.steps.at(-1);
    const where = lastStep ? ` Its last step was ${describeStep(lastStep)}, which ended with: "${truncate(lastStep.result.replace(/\s+/g, " ").trim(), 300)}".` : "";
    return stop(`The model stopped without an answer or a tool call (${modelCalls} attempts, last finish_reason=${result.finishReason}).${where} Send a follow-up message, for example asking for the current status or a different approach.`, "empty_output");
  }
  return stop(`Too many internal retries (${modelCalls} model calls) without a usable reply.`, "retry_budget");
}

