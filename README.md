# gpt-oss-opencode

Make **GPT-OSS 20B** a working, tool-using coding agent inside **[OpenCode](https://opencode.ai)** —
even on providers that do not support function calling for it (SiliconFlow), and
with a native path for providers that do (e.g. OpenWebUI in front of Ollama).

It is a small OpenAI-compatible proxy (Node ≥ 22.18, **no runtime dependencies**)
that OpenCode uses as its model provider. OpenCode keeps doing what it does —
sessions, compaction, permissions, and executing every tool — while the proxy
translates tool calls to and from the format gpt-oss actually produces, validates
them against OpenCode's own tool schemas, repairs or rejects bad ones, stops
loops, survives provider failures, and writes diagnostics you can read.

```
OpenCode ──OpenAI API──▶ gpt-oss-proxy ──▶ SiliconFlow (harmony emulation)
   ▲ runs the tools          │              OpenWebUI   (native tools, auto-fallback)
   └──── tool calls ◀────────┘  validate · repair · loop guard · retries · logs
```

- Why it is built this way, with the measurements that drove it: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What was tested and how it performed: [docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md)

**Status (measured, see the report):**
- On SiliconFlow, real OpenCode completed 13–14 of 15 core live coding scenarios in each of four full runs (discovery, features, repairs, failed edits, paths, loops, provider faults, long sessions); on the final code, 14 of 15. About 95% of tool calls were valid on the first try, the rest were repaired, the proxy never had to stop a turn, and a full run costs about $0.07.
- Linux (Ubuntu under WSL2): 8 of 8 scenarios in a smoke run.
- The OpenWebUI 0.11.4 + Ollama 0.34.4 path was verified live with a stand-in model; gpt-oss-20b behind OpenWebUI is not yet verified.
- 118 offline tests pass.

## Quick start (SiliconFlow)

Requirements: Node.js ≥ 22.18 (tested 24.15), OpenCode ≥ 1.18 (tested 1.18.29), a SiliconFlow API key.

```bash
git clone <this repo> gpt-oss-opencode && cd gpt-oss-opencode
npm install                      # dev tooling only (TypeScript, test deps); the proxy itself has no dependencies
export SILICONFLOW_API_KEY=sk-…  # PowerShell: $env:SILICONFLOW_API_KEY="sk-…"
npm start                        # gpt-oss-proxy listening on http://127.0.0.1:8787/v1
```

Add the provider to your OpenCode config — `~/.config/opencode/opencode.json` (global)
or `opencode.json` in a project. The complete file is [`opencode/opencode.json`](opencode/opencode.json):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "gpt-oss/siliconflow",
  "small_model": "gpt-oss/siliconflow",
  "provider": {
    "gpt-oss": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GPT-OSS 20B (gpt-oss-proxy)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "unused-the-proxy-holds-the-provider-keys" },
      "models": {
        "siliconflow": {
          "name": "gpt-oss-20b via SiliconFlow",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 131072, "output": 8192 },
          "cost": { "input": 0.04, "output": 0.18 }
        },
        "openwebui": {
          "name": "gpt-oss-20b via OpenWebUI",
          "tool_call": true,
          "reasoning": true,
          "limit": { "context": 131072, "output": 8192 }
        }
      }
    }
  }
}
```

Then run `opencode` (or `opencode run "…"`) and pick **gpt-oss-20b via SiliconFlow**.
The `limit` block matters: it lets OpenCode compact the conversation before the
131K window is exceeded and stops it from requesting 32K output tokens (SiliconFlow caps at 8K).

## Quick start (OpenWebUI in front of Ollama)

This is the setup for a gpt-oss:20b model served by Ollama and exposed through
OpenWebUI (for example as a custom model `gpt-oss20b-opencode`).

```bash
export OPENWEBUI_BASE_URL=http://your-openwebui:8080/api   # PowerShell: $env:OPENWEBUI_BASE_URL="..."
export OPENWEBUI_MODEL=gpt-oss20b-opencode                  # the exact OpenWebUI model id
export OPENWEBUI_API_KEY=sk-…                                # OpenWebUI: Settings > Account > API keys
export GPT_OSS_PROFILE=openwebui
npm start
```

In OpenCode choose **gpt-oss-20b via OpenWebUI** (`gpt-oss/openwebui`); the
`opencode.json` above already defines it.

**Check these on the server side** (each was verified against OpenWebUI 0.11.4 and
Ollama 0.34.4, see the validation report):

1. **Context length — the most important setting.** Ollama's default `num_ctx` is
   **4096 on servers with less than 23 GiB of VRAM** (32768 from 23 GiB, 262144 from
   47 GiB). OpenCode's system prompt and tools alone are 5–7K tokens, so with the default
   Ollama silently drops the oldest messages and the model "forgets" the task and its
   tool results. Set `OLLAMA_CONTEXT_LENGTH=32768` (or more) for the Ollama server, or
   give the model a `num_ctx` parameter. The proxy detects the symptom (the server
   evaluates far fewer prompt tokens than were sent), writes `context_truncated` to
   its log and shows a warning in OpenCode's thinking output.
2. **API keys.** OpenWebUI accepts `sk-…` API keys only if they are enabled
   (Admin Panel > Settings > General, or `ENABLE_API_KEYS=True`), and non-admin users
   also need the API-keys permission. If API-key endpoint restrictions are on, allow
   `/api/models`, `/api/chat/completions` and `/ollama/v1/chat/completions`.
3. **Model id naming in OpenCode.** Keep the OpenCode model key free of `gpt`
   (the provided config uses `openwebui`). OpenCode picks its system prompt from the
   model id, and an id containing "gpt" gets a GPT-specific prompt that demands an
   `apply_patch` tool which OpenCode then does not offer for "oss" models. The proxy
   maps the neutral id to your real OpenWebUI model id (`OPENWEBUI_MODEL`).

**Route selection** (`openwebuiRoute`, env `OPENWEBUI_ROUTE`, default `auto`): the
proxy reads the model's `owned_by` from `/api/models`.

| Route | When | Behaviour |
|---|---|---|
| `ollama-v1` → `/ollama/v1/chat/completions` | model on an **Ollama connection** (auto-selected) | OpenWebUI applies your preset (base model, params, system prompt) and passes Ollama's own OpenAI API through: tool-result names are resolved from `tool_call_id`, `max_tokens` and `reasoning_effort` work, errors keep their message. `num_ctx` cannot be set per request — use `OLLAMA_CONTEXT_LENGTH` / model `num_ctx`. |
| `api` → `/api/chat/completions` | model on an OpenAI-type connection (auto), or forced | Full OpenWebUI pipeline. On an Ollama connection its converter drops `max_tokens`, `temperature` and `reasoning_effort` and the tool name of tool results; the proxy compensates by sending `options.num_predict`, labelling tool results (`[read result]`), and it can send `options.num_ctx` (`numCtx` / `OPENWEBUI_NUM_CTX`). Ollama errors mid-stream arrive as an empty "stop"; the proxy detects that signature and retries. |

### Optional: no separate terminal

Add the bundled plugin and OpenCode starts the proxy in its own process (and
reuses an already running one):

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"] }
```

### Optional: `repo_overview` tool

`opencode/tool/repo_overview.ts` is an OpenCode custom tool. In one call it returns a
depth-limited tree with line counts, manifest scripts, likely entry points and the test
command. To use it, copy it to `~/.config/opencode/tool/` (or a project's `.opencode/tool/`);
OpenCode installs its `@opencode-ai/plugin` dependency on first start. It helps
orientation questions, but in the full evaluation it did not improve task success and cost
58% more tokens, so it is **not** part of the default setup (validation report §4.4).

## Switching between SiliconFlow and OpenWebUI

The proxy routes by the **model id** OpenCode sends, so switching needs no code change:

| Use | OpenCode model | Proxy profile |
|---|---|---|
| SiliconFlow | `gpt-oss/siliconflow` | `siliconflow` → `https://api.siliconflow.com/v1`, model `openai/gpt-oss-20b`, key `SILICONFLOW_API_KEY`, strategy `harmony` |
| OpenWebUI | `gpt-oss/openwebui` | `openwebui` → `http://localhost:8080/api` (route auto-selected, see above), model `gpt-oss20b-opencode`, key `OPENWEBUI_API_KEY`, strategy `auto` |

Switch in the TUI model picker, with `opencode run -m gpt-oss/openwebui …`, or by
changing `"model"` in `opencode.json`. Both profiles can be configured at the same
time; each request is routed by its model id.

URLs, model ids, keys and provider parameters are configurable — copy
[`gpt-oss-proxy.config.example.json`](gpt-oss-proxy.config.example.json) to
`gpt-oss-proxy.config.json` and edit, or use environment variables:

| Variable | Effect |
|---|---|
| `GPT_OSS_CONFIG` | config file path (default `./gpt-oss-proxy.config.json` if present) |
| `GPT_OSS_PORT`, `GPT_OSS_HOST` | listen address (default `127.0.0.1:8787`) |
| `GPT_OSS_PROFILE` | profile used when OpenCode sends an unknown model id |
| `<PROFILE>_BASE_URL`, `<PROFILE>_MODEL`, `<PROFILE>_STRATEGY` | e.g. `OPENWEBUI_BASE_URL=http://gpu-box:3000/api` |
| `OPENWEBUI_ROUTE`, `OPENWEBUI_NUM_CTX` | OpenWebUI route (`auto`, `ollama-v1`, `api`) and per-request `num_ctx` (route `api` only) |
| `GPT_OSS_STRATEGY` | force a strategy for all profiles: `harmony`, `native`, `json`, `auto` |
| `GPT_OSS_LOG_DIR` | diagnostics directory (default `./logs`) |
| `GPT_OSS_LOG_CONTENT=1` | also log content: your prompt, model output, tool-call argument values and previews of successful tool results (default: off, see [Observability](#what-the-proxy-does-for-you)) |
| `GPT_OSS_LOG_RETENTION_DAYS` | delete log days older than this, at startup and daily (default `14`; `0` keeps everything) |
| `GPT_OSS_PROXY_TOKEN` | require `Authorization: Bearer <token>` from clients (put the same value in OpenCode's `apiKey`). **Required** for any address other than localhost: without it the proxy refuses to start there, because anyone who can reach it would spend your provider keys |
| `GPT_OSS_DUMP_REQUESTS=1` | also save every upstream request body for exact replays (`scripts/replay.ts`) |

Profile options: `baseURL`, `model`, `apiKeyEnv` or `apiKeyFile`, `strategy`,
`fallbackStrategy`, `stream`, `maxOutputTokens`, `contextWindow`, `pricing`
(USD per 1M tokens, for cost reporting), `extraBody` (merged into every provider
request, e.g. `{"reasoning_effort":"low"}`), `headers`, `toolDescriptions`
(`full` | `compact`), `aliases`. Limits (timeouts, retry and repair budgets,
loop thresholds) are under `limits` — see the example config.

### Which strategy for which provider

- **SiliconFlow**: `harmony` (default). SiliconFlow rejects `tools` for gpt-oss-20b
  (`400 "Function call is not supported for this model"`), and its streaming
  corrupts harmony tokens, so the profile uses `stream: false` upstream (OpenCode
  still gets a live stream from the proxy).
- **OpenWebUI + Ollama**: `auto` (default) = native tool calling. OpenWebUI passes
  client-supplied `tools` through unchanged (it never runs its own tool loop for
  them) and Ollama parses gpt-oss's harmony tool calls itself, so the proxy
  validates, repairs and loop-guards native calls. Only if the backend answers
  "tools not supported" does `auto` fall back to `harmony` emulation (remembered).
  The proxy also handles Ollama's "error parsing tool call" (the model is asked to
  resend the call).

## What the proxy does for you

- **Tool-call compatibility** — harmony-native emulation for providers without
  function calling; native pass-through otherwise; OpenAI-format `tool_calls`
  (streamed) back to OpenCode, with fresh ids that OpenCode's results correlate to.
- **Validation against OpenCode's catalog** — no invented tools, exact argument
  schemas, conservative coercions, JSON strings preserved byte-for-byte, paths
  normalized for Windows / WSL / Linux (relative paths resolved against the
  working directory).
- **Bounded recovery** — invalid calls are re-prompted with the exact error (2×),
  empty replies nudged (1×), provider timeouts/5xx/malformed bodies retried (3×, 2 s/5 s/12.5 s),
  rate limits backed off separately (8×, exponential, `Retry-After`), all inside a
  per-request time budget. When a budget runs out, OpenCode receives a
  `[gpt-oss-proxy] …` message saying what failed and what to change.
- **Loop control** — identical calls with nothing changed in between are answered
  with the earlier result instead of re-executing; repeated loops, long failure
  streaks and runaway turns are stopped with a diagnostic.
- **Context safety** — oversized histories are trimmed (oldest tool results first)
  before they hit the provider's window; compact tool descriptions (default) save
  ~25% tokens per request.
- **Observability** — JSONL per OpenCode session in `logs/<date>/<session>.jsonl`
  (provider, model, timings, tool catalog, proposed/validated/repaired calls,
  tool results, retries, timeouts, loop events, tokens, cost). By default the logs
  hold metadata only: file paths, commands, sizes and error messages, but not your
  prompts, the model's output or file contents (tool-call values appear as
  `[N chars]`). Set `GPT_OSS_LOG_CONTENT=1` when you need the full picture for
  debugging. Log days older than 14 days are deleted automatically. API keys are
  never logged.

## Session report

```bash
npm run report -- --latest            # most recent session
npm run report -- --session ses_abc   # one session
npm run report -- logs/2026-09-24     # all sessions in a directory
npm run report -- --latest --json     # machine-readable
```

It prints the timeline (requests, model calls, proposed and emitted calls, tool
results, repairs, retries) and flags abnormal behaviour: invalid calls, redundant
or repeated calls, proxy stops, provider errors, permission denials (usually a
mistyped path), large results, slow calls, imagined tool output, stream
corruption, and turns answered without any tool use.

## Tests and evaluation

```bash
npm test            # unit + contract tests (mock provider, AI SDK client) — no network
npm run typecheck
npm run eval        # live: real OpenCode + proxy + SiliconFlow on synthetic repos
node eval/run.ts --only discover-explain,fix-syntax --repeat 3 --concurrency 1
node eval/run.ts --strategy json            # compare strategies
node eval/run.ts --extra-tools              # with the optional repo_overview tool
```

Live evaluation needs `SILICONFLOW_API_KEY` and the OpenCode CLI (`OPENCODE_BIN`
to point at a specific binary). Each scenario runs in a fresh git repo copied
from `eval/fixtures/`, with an isolated OpenCode home/config, and is judged by
deterministic checks (hidden tests, repo state, the executed tool trace).
Results land in `.eval-runs/<run>/` (`summary.md`, `results.json`, per-scenario
repo, OpenCode events and proxy logs).

**OpenWebUI + Ollama** is tested three ways:

- `test/openwebui.contract.test.ts` replays real SSE captured from OpenWebUI 0.11.4 +
  Ollama 0.34.4 (both routes) and checks route selection, payload fixes, hidden-error
  retry, tool-parse repair, auth/model diagnostics and truncation detection — offline.
- `scripts/owui-local-stack.mjs up` builds a real local OpenWebUI + Ollama stack inside
  `.local-stack/` (a small stand-in model; gpt-oss:20b needs ~14 GB), creates an admin,
  an API key and a `gpt-oss20b-opencode` preset. `scripts/probe-openwebui.mjs` dumps the
  exact wire format of any deployment (`--base http://host:8080/api`, key from
  `OPENWEBUI_API_KEY`).
- Against your own server: `OPENWEBUI_BASE_URL=… OPENWEBUI_MODEL=… OPENWEBUI_API_KEY=… npm run test:live`
  runs the full tool lifecycle through the proxy, and
  `node eval/run.ts --profile openwebui` runs the OpenCode evaluation against it.

## What to expect (limitations)

The proxy makes gpt-oss-20b's tool use reliable; it cannot make the model smarter.
Measured numbers are in the [validation report](docs/VALIDATION_REPORT.md).

- **Good at:** finding and explaining code, small features with tests, targeted
  edits and fixes, searching large files. These pass consistently in the live evaluation.
- **Unreliable at:** diagnosing bugs behind misleading error messages (about half of
  the runs succeed), and larger multi-file work from a detailed spec. On a C++ task
  (implement an evaluator from a header spec, find a latent lexer bug, add tests), it
  met 10–11 of 12 checks in every run but never all of them. It found and fixed the lexer
  bug, but kept missing a requirement the header states explicitly (parse fully before
  evaluating). **Review its changes** as you would a junior developer's.
- **Slow on SiliconFlow's entry tier:** ~40K tokens/minute at 6–10K prompt tokens per
  step means waits between steps; simple tasks take 1–3 minutes, larger ones 5–20.
- **One tool call per model call** with harmony emulation (no parallel calls).
- **Tools run with your permissions.** OpenCode executes every tool the model asks
  for, including shell commands. Keep OpenCode's permission prompts for `bash` and
  `edit` when working in repositories you do not trust: text in a repository can try
  to steer any LLM agent (prompt injection).
- **Tested platforms:** Windows 11, and Linux (Ubuntu under WSL2). macOS is untested.
- **OpenWebUI + gpt-oss-20b itself has not been run** (it does not fit the test machine).
  The OpenWebUI 0.11.4 + Ollama 0.34.4 software path was verified live with a small
  stand-in model. Before relying on it, run `npm run test:live` and
  `node eval/run.ts --profile openwebui` against your server.

## License

MIT, see [LICENSE](LICENSE).
