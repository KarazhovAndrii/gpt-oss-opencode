# Architecture

## The problem, as measured

GPT-OSS 20B has to act as OpenCode's agent model. OpenCode talks to models through
the Vercel AI SDK's OpenAI-compatible provider: every request carries the full
conversation plus the tool catalog (`bash, edit, glob, grep, read, skill, task,
todowrite, webfetch, write`, plus plugin/MCP tools), always with `stream: true`,
`stream_options.include_usage`, `tool_choice: "auto"` and an `x-session-id` header.
It expects streamed `tool_calls` deltas back and executes the tools itself.

Probing SiliconFlow (`scripts/probe-*.mjs`, see the validation report for raw data):

| Provider feature | Accepted? | Actually works? |
|---|---|---|
| `tools` / `tool_choice` for `openai/gpt-oss-20b` | **no** – HTTP 400 `code 20037 "Function call is not supported for this model"` | – |
| `response_format: json_schema` | yes | **no** – 46 s, reasoning disabled, truncated JSON (`{"action":"tool","tool":"glob"\t}`) |
| `response_format: json_object` | yes | **no** – returned `["analysis"]` (harmony leakage) |
| `reasoning_content` field | yes | yes (non-streamed and streamed) |
| `reasoning_effort` | yes | yes |
| `role: "tool"` + assistant `tool_calls` in history (without `tools`) | yes | yes – rendered with the native chat template |
| `role: "developer"` | no (400) | – |
| streaming | yes | **corrupts harmony tokens**: the token after a special token is duplicated (`<|channel|>commentcomment…`, `<|message|>{"patternpattern…`) |
| `stop: ["<|call|>"]` | yes | yes – generation stops at the harmony call token |
| rate limits | – | TPM-limited (entry tier: 40K tokens/min), 429 `TPM limit reached`, occasional 503 "System is too busy" |

The decisive observation came from reading the model's reasoning traces: with a
JSON- or tag-based tool protocol, gpt-oss still emits its **native harmony tool
call** (`<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{…}<|call|>`)
inside its reasoning. Because the provider has tool calling disabled, `<|call|>`
is not a stop token, so the model continues and **imagines the tool result**,
then answers from it. That is exactly the "says it will read the file but never
does" / "explains a file it never read" failure (0/5 correct in those probes).

## Design

```
OpenCode ──(OpenAI chat API, SSE)──▶ gpt-oss-proxy ──(OpenAI chat API)──▶ SiliconFlow / OpenWebUI
   ▲  executes tools                  │ strategy adapter (harmony | native | json)
   └──────── tool_calls ◀─────────────┤ validation + repair · loop guard · context guard
                                      │ timeouts/retries/backoff · JSONL diagnostics
```

A small OpenAI-compatible HTTP proxy (Node ≥ 22, no runtime dependencies) sits
between OpenCode and the provider. OpenCode is configured with a custom
`@ai-sdk/openai-compatible` provider pointing at the proxy. **OpenCode remains
the only tool executor**; the proxy never touches the repository.

Why a proxy rather than an OpenCode plugin: the incompatibility is in the
provider transport (how tool calls are encoded), which plugins cannot change;
a proxy is also testable in isolation with the same AI SDK package OpenCode
uses, works with any OpenCode UI (TUI, `run`, server), and switching providers
is configuration only. An optional plugin (`opencode/plugin/gpt-oss-proxy.ts`)
can host the proxy inside OpenCode's process for convenience.

### Strategies (per provider profile)

| Strategy | Used when | How |
|---|---|---|
| `harmony` (default for SiliconFlow) | provider rejects/garbles native tools | Tools rendered as the harmony `namespace functions { … }` TypeScript block gpt-oss was trained on; `stop: ["<|call|>"]`; raw harmony output parsed deterministically (channels, recipients, terminators); history sent with native `tool_calls`/`tool` roles. |
| `native` | provider supports tools (OpenWebUI → Ollama) | OpenCode's tools forwarded as-is; returned calls validated/repaired; leaked raw harmony recovered. For OpenWebUI profiles `src/openwebui.ts` also picks the route and fixes the payload (below). |
| `json` (comparison baseline) | – | Classic prompt-level JSON-envelope emulation. |
| `auto` (default for OpenWebUI) | unknown provider | `native`; on a "tools not supported" 400 falls back to `fallbackStrategy` and remembers it. |

The orchestration (`src/agent.ts`) is identical for all strategies, so
switching providers never touches it.

### OpenWebUI in front of Ollama (`src/openwebui.ts`)

Verified from OpenWebUI 0.11.4 / Ollama 0.34.4 source and live against both:

- OpenWebUI forwards client-supplied `tools` unchanged and never runs its own tool
  loop for an API client that sends no `chat_id`/`session_id`; Ollama parses gpt-oss's
  harmony tool calls itself. So the proxy uses the **native** strategy there.
- **Route `ollama-v1`** (`/ollama/v1/chat/completions`, chosen automatically when the
  model's `owned_by` is `ollama`): OpenWebUI maps the preset to its base model, applies
  the preset's params and system prompt, and passes Ollama's OpenAI layer through.
  Tool-result names are resolved from `tool_call_id`, `max_tokens`/`reasoning_effort`
  work, errors are preserved; `num_ctx` is a server setting.
- **Route `api`** (`/api/chat/completions`): OpenWebUI's converter drops `max_tokens`,
  `temperature`, `reasoning_effort` and — for tool results — the tool name (the gpt-oss
  template then renders `functions. to=assistant`). The proxy sends `options.num_predict`
  (and `options.num_ctx` if configured), labels tool results with the tool name, keeps
  the converter's invariants (assistant `content` never `null` without tool calls,
  string tool results, JSON-object arguments), and recognises the empty `"stop"` chunk
  with model `"ollama"` and no usage that OpenWebUI emits when Ollama fails mid-stream.
- Both routes: Ollama's `"error parsing tool call"` becomes a re-prompt to the model;
  `{"detail": …}` errors (string, object or list) are read; 401/403 and "model not
  found" produce setup hints; and **context truncation** is detected from the provider's
  `prompt_tokens` (Ollama's default `num_ctx` is 4096 below 23 GiB VRAM, far below
  OpenCode's 5–7K-token system prompt + tools).

### Per-request pipeline (`src/agent.ts`)

1. Log new tool results (correlated by `tool_call_id`), the tool catalog (once per session), the request.
2. **Turn guards** (from the history OpenCode sends, no extra state): step budget,
   repeated identical calls executed, consecutive tool failures → actionable diagnostic instead of looping.
3. **Context guard**: the proxy adds ~4K tokens OpenCode does not count; if the
   estimate nears the window, the oldest tool results are stubbed (logged).
4. Build the upstream request via the strategy adapter: OpenCode's system prompt
   + short operating rules + the current user objective (verbatim) + tools.
5. Call the model with bounded transport retries and a separate rate-limit budget
   (exponential backoff, `Retry-After`), all under a per-request time budget.
6. Interpret: harmony parse (everything after the first call is discarded – it can
   only be imagined output), or native calls, or JSON envelope. A reply that is only
   the start of a call header (`to=functions.read?`) is a protocol error and is
   re-prompted, not returned as the answer.
7. **Validate** every call against the catalog OpenCode sent: tool exists (with
   `functions.` prefix / case / separator normalization, and repair of malformed
   harmony headers such as `globjson` or `read>{…}()`), arguments parse (strict,
   then single balanced object), schema check with conservative coercions
   (`"50"`→50, `null` optional removed, JSON-string arrays), path arguments
   normalized for the host (WSL `/mnt/c/…`, Git-Bash `/c/…`, relative → absolute,
   `//x` → `/x`, doubled backslashes). A path that is one near-miss segment away
   from the working directory (a changed digit in a long directory name, a wrong
   drive letter, a Unicode hyphen) is snapped back to it **only if that path appears
   nowhere in the conversation** — i.e. the model invented it; paths the user or a
   tool mentioned (e.g. a sibling project) are never rewritten. An invented path whose
   middle is garbled further (segments dropped, merged or rewritten) is re-anchored on
   the working directory's last segment. This only happens when the directory it lands
   in is the working directory or was mentioned in the conversation; the proxy never
   checks the filesystem. Abbreviated paths (`..`, `...`, `…`, also inside a segment
   such as `.eval-r...`) are expanded the same way. On Windows, a path argument with
   characters Windows forbids (`< > " | ? *`) is rejected with an explicit error
   rather than passed on, because OpenCode would deny it as an outside directory and
   mislead the model. String contents are never rewritten.
8. **Repair** invalid calls by re-prompting with the exact error as a tool result
   (bounded, default 2); a bare-JSON reply right after a rejection is accepted as
   that tool's arguments.
9. **Redundancy guard**: an identical call with nothing changed since (no successful
   edit/write, no other bash) is answered by the proxy with a hint containing the
   earlier result instead of being executed (bounded, default 2 hints; then passed through).
   A bash command that timed out may be re-run once with a larger timeout. Wait loops are
   the exception (`while`/`until` with `sleep`, `while true`, `tail -f`): after one timed
   out, re-running it or a rewritten wait loop with a longer timeout gets a hint instead.
   The hint says to check the state once and report it.
10. Emit OpenAI SSE: reasoning (`reasoning_content`), text, `tool_calls` (fresh ids),
    `finish_reason`, and usage summed over all internal attempts.

### What is deliberately *not* here

No second model, no planner/curator, no task-specific workflows, no persistent
memory. GPT-OSS does the reasoning and planning; OpenCode keeps sessions,
compaction and tool execution. The proxy only provides protocol compatibility,
validation, bounded recovery and observability.

## Files

| Path | Purpose |
|---|---|
| `src/server.ts` | HTTP endpoints (`/v1/chat/completions`, `/v1/models`, `/health`); token auth, required for any non-loopback bind (`bindRefusal`) |
| `src/agent.ts` | per-request orchestration (above) |
| `src/strategies.ts` | harmony / native / json adapters |
| `src/harmony.ts` | tool namespace renderer + harmony parser |
| `src/toolcall.ts`, `src/schema.ts` | validation, coercion, path normalization |
| `src/guard.ts` | loop / redundancy / failure analysis |
| `src/messages.ts` | history normalization, context guard |
| `src/upstream.ts` | provider client: SSE/JSON parsing, timeouts, retries, error classes |
| `src/emitter.ts` | OpenAI SSE / JSON writer (+ keepalives) |
| `src/compact.ts` | compaction of long built-in tool descriptions (default on) |
| `src/openwebui.ts` | OpenWebUI route selection and payload fixes |
| `src/log.ts`, `src/sessionreport.ts`, `bin/report.ts` | JSONL diagnostics (metadata only unless `logContent`; day folders pruned after `logRetentionDays`) and the session report tool |
| `opencode/` | OpenCode config example, optional plugin, optional `repo_overview` tool |
| `eval/` | live evaluation harness (`run.ts`), scenarios, synthetic fixture repos, `recheck.ts`/`compare.ts` |
| `scripts/` | provider probes, request replay, OpenWebUI wire probe, local OpenWebUI + Ollama stack |
| `test/` | unit + contract tests (mock provider, AI SDK client) |
