# Validation report

Dates: 2026-09-24/25, release validation 2026-09-29 · Host: Windows 11 (win32), Node 24.15.0, OpenCode 1.18.29 (`opencode run --format json`),
provider SiliconFlow `openai/gpt-oss-20b` ($0.04 / $0.18 per 1M input/output tokens, 131K context, 8K max output).
Linux smoke run: Ubuntu under WSL2 on the same host, Node 24.21.0, OpenCode 1.18.29.
Every live number below comes from runs executed on these dates; raw artifacts are in `.eval-runs/`
(git-ignored) and `logs/`.

## Summary

**What was built.** An OpenAI-compatible proxy between OpenCode and GPT-OSS 20B
(Node, no runtime dependencies). On SiliconFlow, which rejects native function calling
for this model, it emulates tool calls in gpt-oss's own harmony format. In front of
OpenWebUI/Ollama it uses native tool calls and compensates for OpenWebUI's payload losses.
On every backend it validates each call against OpenCode's tool schemas, repairs or
re-prompts bad calls, stops loops, retries within budgets, and logs a diagnosable
trace per session. OpenCode remains the only tool executor. See ARCHITECTURE.md.

**Final default configuration (v7):** SiliconFlow profile, `harmony` strategy, non-streamed
upstream, compact tool descriptions, provider-default reasoning effort, v7 operating rules.

| Result | Value |
|---|---|
| **Release validation (final code)**, 16 scenarios incl. `cpp-evaluator` | **14/16**; the original 15: **14/15**; 87/91 checks; 95.4% first-attempt valid calls; 0 proxy stops; 0 uncorrelated results (section 4.5) |
| Release validation, three earlier full runs (before the last four fixes) | 14/15, 14/15, 13/15 on the original 15; 0 proxy stops in all |
| Linux (Ubuntu/WSL2), 8-scenario smoke run | **8/8**, 42/42 checks, 100% first-attempt valid calls |
| Live OpenCode evaluation, 15 scenarios, v7 | **14/15 passed (93%)**, 76/79 checks |
| First-attempt valid tool calls (v7) | 96.8% (92/95); all invalid calls repaired by re-prompting |
| Proxy stops / uncorrelated tool results (v7) | 0 / 0 |
| Cost / tokens (v7, all 15 scenarios) | $0.038 · 736K input + 46K output tokens · 129 model calls |
| Live lifecycle test on SiliconFlow (`npm run test:live`) | **pass**: glob → read test → read source → edit → `npm test` → correct answer (17.6 s) |
| Offline tests (`npm test`) | **119/119** unit + contract tests (incl. real OpenWebUI captures, AI SDK client) |
| OpenWebUI 0.11.4 + Ollama 0.34.4 (real, local stand-in model) | lifecycle passes on both routes; OpenCode e2e 100% valid calls (15/15), 0 uncorrelated |
| Strategy comparison | native (A): rejected by SiliconFlow · JSON emulation (B): **0/6** · harmony: 14/15 (v7) · harmony + `repo_overview` (C): 13/15 at +58% tokens, so it stays optional |

**What failed / is not proven.** `fix-syntax` (find a missing `}` from a misleading
Node error) passes in about half of all full runs (2 of 6 earlier, 2 of 4 in the release
runs): a model-reasoning limit. `cpp-evaluator` (a C++ evaluator from a header spec)
reaches 10–11 of 12 checks but has never passed completely: the model evaluates while
parsing, against the spec. gpt-oss:20b *behind
OpenWebUI* was not run (it does not fit the test machine); that path was verified with a
small stand-in model on the real OpenWebUI + Ollama software. SiliconFlow's entry-tier
rate limit (~40K tokens/min) makes each agent step wait; average scenario time was ~2 min.
Details in sections 4–6.

## 1. Provider investigation (what SiliconFlow really does)

Scripts: `scripts/probe-provider.mjs`, `probe-formats.mjs`, `probe-formats2.mjs`, `probe-reasoning.mjs`,
`probe-harmony.mjs`, `probe-stream-raw.mjs` (all re-runnable).

| Probe | Result |
|---|---|
| `tools` + `tool_choice:"auto"` (stream and non-stream) | HTTP 400 `{"code":20037,"message":"Function call is not supported for this model."}` |
| `tool_choice:"required"` | same 400 |
| `response_format: json_schema` (strict envelope) | 200 after **46.5 s**, `reasoning_tokens: 0`, content `{"action":"tool","tool":"glob"\t}` (truncated, no arguments) |
| `response_format: json_object` (stream) | content `["analysis"]` – harmony channel name leaked as "JSON" |
| plain chat, `reasoning_effort` | works; `reasoning_content` returned separately; effort honoured (low: ~200–300 reasoning tokens on a small question) |
| `role:"developer"` | 400 (`expected tags: system, user, assistant, tool`) |
| `role:"tool"` + assistant `tool_calls` without `tools` | accepted, rendered by the native template (model reads the result) |
| Prompt-level JSON envelope, 5 runs on "read the entry point" step | **1/5** correct; 4/5 answered with an explanation of a file it never read |
| Prompt-level `<tool_call>` tags, 5 runs | **1/5** correct; same hallucinated answers |
| JSON envelope + grounding rules / + per-turn reminder / + native history | **0/5, 0/5, 0/5** |
| Reasoning traces of those failures | the model emits a native harmony call `…<|channel|>commentary to=read <|constrain|>json<|message|>{…}<|call|>` inside its reasoning, then continues with an **imagined** `{"tool_result": …}` and answers from it |
| Harmony namespace tools + `stop:["<|call|>"]` (non-stream) | step 1: **3/3** valid `glob` (1.4–2.4 s, 47–65 output tokens); step 2: **3/3** `read` of the right file (one `//work/...` path → normalized); step 3: answers grounded in the real file content |
| Same with `stream:true` | tokens after special tokens are duplicated: `<|channel|>commentcomment`+`ary`, `<|message|>{"patternpattern`… → corrupted headers/arguments |
| Same with `stream:false`, 3 runs | 3/3 clean |
| Rate limits | 429 `TPM limit reached` (codes 50602/50603) under concurrency; 503 "System is too busy now" occasionally; SiliconFlow's documented entry tier is 40K TPM |

Conclusion: native function calling (strategy A) is unavailable; constrained structured output is
broken; prompt-level JSON emulation (strategy B) fails because the model's trained tool-call
behaviour leaks into its reasoning. The model's *own* harmony protocol, with the provider made to
stop at `<|call|>`, is reliable → the default `harmony` strategy.

## 2. Problems found during development and how they were fixed

Each was reproduced, fixed, and covered by a regression test (unit/contract) or an eval check.

| # | Found by | Problem | Fix | Regression coverage |
|---|---|---|---|---|
| 1 | probes | Model imagines tool results (no `<|call|>` stop) | harmony strategy with `stop:["<|call|>"]`; parser discards anything after the first call | `harmony.test.ts` (imagined-output cases) |
| 2 | first live OpenCode run | SiliconFlow streaming duplicates tokens after special tokens → `{"patternpattern…}` | SiliconFlow profile uses `stream:false` upstream (OpenCode still streamed); corruption signature detected and logged | `STREAM_CORRUPTION` note, report flag |
| 3 | live | Repair turn answered with bare JSON (no recipient) | bare JSON right after a rejected call is taken as that tool's arguments (scoped) | contract test |
| 4 | smoke | `opencode run` hung forever | OpenCode reads piped stdin until EOF → harness closes stdin | eval harness |
| 5 | smoke | ripgrep download stalled a fresh OpenCode home | harness seeds `rg` into the shared cache | eval harness |
| 6 | first eval | **OpenCode ran in the implementation repo**, not the eval repo (wrote files into `src/`) | OpenCode trusts an inherited `PWD`: harness passes `--dir` and `PWD`; isolation check on every scenario + tree fingerprint tripwire | eval check "worked inside the isolated repo" |
| 7 | eval (Windows) | argv prompts with quotes reach OpenCode wrapped and `\"`-escaped | prompt passed via stdin (byte-exact) | eval harness |
| 8 | unit tests | error events inside SSE were swallowed | parse/dispatch separated | `upstream.test.ts` |
| 9 | unit tests | `anyOf` picked a coercing branch (`["a"]` → string) | prefer branches that accept the value as-is | `schema-messages.test.ts` |
| 10 | contract tests | provider `reasoning_content` lost on non-streamed upstream | reasoning from both fields forwarded; separators between attempts | contract test (generateText) |
| 11 | contract tests | title request leaked `<|end|>` | leading content segment is final when reasoning was split by the provider | contract test |
| 12 | baseline eval | 429 TPM: 1–2 s retries far too short; turns ended with a rate-limit diagnostic | separate rate-limit budget (8×, 5 s doubling to 30 s, `Retry-After`, jitter) within the request budget; visible "retrying in Ns" note | `upstream.test.ts` |
| 13 | code review of a 97 s call | non-streamed calls could be cut by the 60 s first-byte timeout although headers only arrive after generation | first-byte timeout applies to streaming only; total timeout otherwise | `upstream.test.ts` |
| 14 | baseline logs | 5/15 scenarios: model **retyped long absolute paths wrongly** (`07-16-58`, `2026-09-5???`, a Unicode `‑`) → blocked by OpenCode | rules steer to relative paths (proxy resolves them deterministically); report flags permission denials | eval checks + report |
| 15 | v3 eval | model converted a user WSL path itself with the wrong drive (`C:` for `/mnt/d`) and gave up after one failed read | rules: pass user paths unchanged (proxy converts them); investigate failures (glob/grep) before giving up | `wsl-path` scenario |
| 16 | v3 eval | blocking bash poll loop re-run with a larger timeout (120 s → 300 s) | bash identity ignores `timeout`/`description`; one timeout escalation allowed, further repeats flagged | `guard.test.ts` |
| 17 | eval review | two checks were stricter than the prompt (default vs named export; "14 days" not asked) | checks corrected; earlier runs re-judged offline with `eval/recheck.ts` | `recheck` |
| 18 | long sessions (analysis) | proxy adds ~4K tokens OpenCode does not count → possible overflow before OpenCode compacts | context guard trims oldest tool results near the window | `schema-messages.test.ts`, contract test |
| 19 | review | a proxy exception mid-stream would truncate OpenCode's stream | internal errors are turned into a diagnostic message + clean finish | server |
| 20 | v4 eval | long absolute paths still mistyped although relative paths were suggested (the model copies from glob output) | a path one near-miss segment away from the working directory (edit distance ≤ 2, Unicode dash, wrong drive letter) is snapped back — **only if the path appears nowhere in the conversation** (a sibling project the user mentioned is never rewritten) | `toolcall.test.ts` |
| 21 | v4 eval | malformed harmony headers: tool name `globjson` (content type fused), `read>{"filePath":…}()` (arguments in the recipient) | exact-tool-name suffix repair; recipient cut at the first non-identifier char, arguments recovered from it | `toolcall.test.ts` |
| 22 | v5 eval | WSL path written with backslashes (`mntd…`) not recognised | WSL/Git-Bash forms matched on forward-slash-normalised text | `toolcall.test.ts` |
| 23 | v5 eval | asked to poll a status file, the model handed the user a bash script instead of reporting the state | rule: never hand the user commands/scripts instead of doing the work; report the current state if something cannot complete | `status-poll` (fails in v3–v5, passes in v6) |
| 24 | v5 logs | SiliconFlow `500 Unknown error` bursts outlasted 1 s/2 s retries | transport retries 3×, 2 s → 5 s → 12.5 s backoff (still inside the request budget) | `upstream.test.ts` |
| 25 | OpenWebUI research + live replica | route-specific payload loss, hidden mid-stream errors, tool-parse errors, truncation at Ollama's 4K default context, API-key/route setup | `src/openwebui.ts` + upstream/agent changes (section 3) | `openwebui.contract.test.ts` (real captures), live tests |
| 26 | session restart | the provider key disappeared from the environment; every request got 401 | (no code change needed) the proxy failed fast with "authentication failed … check SILICONFLOW_API_KEY" and no retries; evals now read `key.txt` into the environment | observed in a v6 attempt |
| 27 | v6 logs | reading a 3,000-line log whole and missing the ERROR line; edit→read churn (39 tool calls for a small feature); not re-running tests after the final edit | three prompt rules (grep/ranged reads for large files; fewer, larger edits; validate after the last change), measured in v7 | eval |
| 28 | `cpp-evaluator` eval | in a long C++ session the model retyped the absolute path with an invented timestamp and a dropped segment, and later merged two segments (`improved_tools- .eval-runs`); every call after that was denied as an external directory | `reanchorPath`: an invented absolute path is re-anchored on the working directory's last segment, but only when it shares the first two segments, its prefix appears nowhere in the conversation, and the target directory was mentioned (the proxy never touches the filesystem) | `toolcall.test.ts`; fired in `cpp-evaluator` run 3 |
| 29 | release runs 1 and 3 | `status-poll`: the model re-ran a timed-out `while … sleep` polling loop with `timeout: 600000`; the one allowed escalation let it block past the scenario budget. In verification it also rewrote the loop (`until …`, `timeout: 300000`) | wait loops (`while`/`until` with `sleep`, `while true`, `for ((;;))`, `tail -f`) get no escalation after one timed out; a rewritten wait loop with a longer timeout gets the same hint: check the state once and report it | `guard.test.ts`; `status-poll` 3/3 in verification, pass in release run 4 |
| 30 | release run 3 | an ellipsis inside a segment (`…\improved_tools_agent\.eval-r...\src\stats.js`) was denied as an outside directory; the model then spent steps reasoning about permissions | `expandElidedPath` also handles partial-segment ellipses; if the tail does not start with the project folder, only a target the conversation mentioned is accepted | `toolcall.test.ts` |
| 31 | release run 3 | a junk path (`…\2026-09-uite? self...?`, with a key named `"???"`) reached OpenCode and was denied with a misleading permission message | on Windows, path arguments containing `< > " \| ? *` are rejected with an explicit error (a wildcard in a glob's `path` → "use `pattern`") | `toolcall.test.ts`; fired 3× in the final verification runs |
| 32 | release run 3, verification | a reply that was only a call-header fragment (` to=functions.read?`, ` to=functions.read?<\|constrain\|>??`) reached OpenCode as the final answer, ending the turn with nothing done | a raw reply that starts with a header fragment and yields no call is a protocol error → re-prompt | `toolcall.test.ts`; fired in `feature-median` verification (pass) |
| 33 | README review | the OpenWebUI model was declared with a 131K window in OpenCode's config and the proxy profile, while the recommended Ollama setting is 32K: OpenCode would compact too late and Ollama would silently cut the conversation | the `openwebui` defaults are 32768 in both places, and `OPENWEBUI_CONTEXT_WINDOW` sets the proxy's window; the server guide says to keep server, OpenCode and proxy windows equal | `release.test.ts` |

## 3. OpenWebUI + Ollama (the production path)

### 3.1 How this was established

- **Source study** of OpenWebUI v0.11.4 (2026-09-21), Ollama v0.34.4 (2026-09-23) and OpenCode
  1.18.32 (pinned shallow clones). A research workflow produced 55 source-cited findings; its
  automated adversarial-verification stage did not run (the session hit its usage limit), so
  every claim the implementation depends on was re-checked by hand against the source (list below)
  and, where possible, live.
- **A real local replica** (`scripts/owui-local-stack.mjs`, everything under `.local-stack/`):
  OpenWebUI 0.11.4 (installed with uv) in front of Ollama 0.34.4, API-key auth, and a custom
  preset `gpt-oss20b-opencode` on top of a small tool-capable stand-in model (qwen3:1.7b —
  gpt-oss:20b needs ~14 GB and does not fit the 4 GB-VRAM / 16 GB-RAM test laptop).
- **Wire captures** (`scripts/probe-openwebui.mjs`) of OpenCode-shaped requests on both routes,
  now used verbatim as test fixtures (`test/fixtures/owui-*.sse`).

### 3.2 Verified facts and what the proxy does about them

| Fact | How verified | Proxy behaviour |
|---|---|---|
| Client-supplied `tools` pass through OpenWebUI unchanged; OpenWebUI runs no tool loop of its own for a bare API request | live (tool_calls returned to the client on both routes) + source | native strategy for OpenWebUI |
| Route A `/api/chat/completions` (Ollama connection) **ignores `max_tokens`** (5 requested → 321 generated), honours `options.num_predict` (→ 5) | live | `max_tokens` copied to `options.num_predict` |
| Route A honours `options.num_ctx` (2048 → Ollama evaluated 1,026 of 4,403 prompt tokens, and the model **stopped calling tools**) | live | optional `numCtx`; truncation detector (prompt_tokens far below the sent size) → log + visible warning |
| Route A: tool-result messages lose the tool name in OpenWebUI's converter (`payload.py:276-330` keeps role/content/tool_call_id only); gpt-oss's template renders `functions.{ToolName}` | source | route B preferred for Ollama-backed models; on route A tool results are labelled `[<tool> result]` |
| Route B `/ollama/v1/chat/completions` maps preset → base model, applies preset params/system prompt, passes Ollama's OpenAI layer through (`routers/ollama.py:1319+`); Ollama resolves tool names from `tool_call_id` (`openai/openai.go:581,749`) and honours `max_tokens` (5 → 5, `finish_reason:"length"`) | live + source | `openwebuiRoute: "auto"` picks it when `/api/models` says `owned_by: "ollama"` |
| Route B cannot set `num_ctx` per request (Ollama's OpenAI layer maps only stop/max_tokens/temperature/seed/penalties/top_p) | source | documented: set `OLLAMA_CONTEXT_LENGTH` on the server (README, "Set up your OpenWebUI server", step 1) |
| **Ollama default `num_ctx` = 4096 below 23 GiB VRAM** (32768 ≥ 23 GiB, 262144 ≥ 47 GiB; `server/routes.go:2105-2114`); on overflow Ollama drops the oldest non-system messages (`server/prompt.go:23-80`) | source; symptom reproduced live | README, "Set up your OpenWebUI server", step 1; truncation detector |
| Stream formats: route A = OpenWebUI converter (`"key": value` spacing, one complete tool call per chunk with `index/id/type/arguments` string, `reasoning_content`, usage with extra keys on the finish chunk); route B = Ollama (`delta.reasoning`, separate finish chunk, separate `choices:[]` usage chunk) | live captures | parser accepts both (fixtures in tests) |
| A mid-stream Ollama error becomes an empty chunk `model:"ollama"`, `finish_reason:"stop"`, no usage (`utils/response.py:229-270`) | source | recognised → retried as a provider error |
| Errors are `{"detail": ...}` (string/object/list); unknown model → 400 `"Model not found"` / `"Model '<id>' was not found"`; API keys **disabled by default** (`ENABLE_API_KEYS=False`, `config.py:2454`) → 403 | live + source | detail parsing; setup hints for auth and model id |
| OpenCode picks its system prompt from the model id: ids containing `gpt` get a prompt demanding `apply_patch`, which OpenCode withholds for ids containing `oss` (`session/system.ts`, `tool/registry.ts`, `prompt/gpt.txt:27`) | source | neutral OpenCode model key `openwebui`; proxy maps it to the real OpenWebUI id |
| Right after a preset is created, `/api/chat/completions` answers 400 "Model not found" until the model list is refreshed | live | operational note (refresh `/api/models` or reload the UI) |

### 3.3 Live results on the replica

- `npm run test:live` (proxy → OpenWebUI → Ollama, OpenCode's real tool catalog, the test
  executing tools as OpenCode would): full lifecycle **passes on both routes** in protocol mode
  (`LIVE_STANDIN=1`: read → edit → bash test run → final answer, no proxy diagnostics). With the
  task-level assertions the 1.7B stand-in fails (it misunderstood the fix and once claimed a
  passing test run it had not had) — a model-capability limit, not a protocol one.
- Real OpenCode end to end (`eval/run.ts --profile openwebui`, 4 scenarios): **100% first-attempt
  valid tool calls (15/15), 0 uncorrelated tool results, no hangs, isolation intact**, 2 redundant
  re-reads intercepted; 1/4 tasks passed (stand-in capability: it answered without reading, and
  invented TODO entries).
- Offline: `test/openwebui.contract.test.ts` (9 tests) replays the real captures and covers
  route selection, payload fixes, hidden-error retry, tool-parse repair, auth/model diagnostics
  and truncation detection.

**Not verified here:** gpt-oss:20b itself behind OpenWebUI (hardware). Run
`OPENWEBUI_BASE_URL=… OPENWEBUI_MODEL=… OPENWEBUI_API_KEY=… npm run test:live` and
`node eval/run.ts --profile openwebui` against the production server to confirm.


## 4. Live OpenCode evaluation

### 4.1 Method

`npm run eval` runs the real OpenCode CLI (1.18.29, `opencode run --format json`)
against the proxy and live SiliconFlow. For each scenario the harness:

- copies a fixture repo (`eval/fixtures/`) into `.eval-runs/<run>/<scenario>/repo` and commits it;
- starts a dedicated proxy instance, whose logs go to that scenario's folder;
- runs OpenCode with an isolated HOME/XDG config.
  - The prompt goes in via stdin, with `--dir` and `PWD` set to the repo.
  - Permissions: edit/bash allowed, external directories denied.

It then judges the result with deterministic checks:

- hidden behaviour tests run against the repo, and the repo's own test suite;
- file state;
- the executed tool trace (e.g. "read X before answering", "tests ran after the last edit");
- answer facts.

Two invariants are checked in every scenario: tool results correlate with emitted call ids,
and OpenCode worked inside the isolated repo. A fingerprint of the implementation tree
guards against agents escaping their sandbox. If the host sleeps during a scenario (as the
laptop did overnight), a heartbeat gap is detected and the scenario is discarded and re-run.
`eval/recheck.ts` and `eval/compare.ts` re-judge saved runs with the current checks, so all
numbers below use the same (final) checks.

| scenario | what it tests | covers |
|---|---|---|
| `discover-explain` | Find, read and explain the Python entry point (misleading benchmark/fixture files present) | discovery, read-before-answer, misleading-names, sequential-calls |
| `feature-median` | Implement a feature with tests and run the suite | feature, validation-after-change, sequential-calls |
| `fix-syntax` | Diagnose and repair a syntax error that breaks the test run | syntax-repair, validation-after-change |
| `edit-recovery` | Edit where the obvious oldString is ambiguous (comment + code) — must recover, not claim false success | failed-edit-recovery, no-false-success |
| `log-search` | Locate one line in a 3000-line file efficiently | targeted-inspection, context-efficiency |
| `read-range` | Tool argument types: read a precise line range (integer offset/limit) | argument-validation, schema |
| `wsl-path` | User supplies a WSL-style path on a Windows host (and Git-Bash style on the follow-up) (2 turns) | windows-wsl-paths |
| `misleading-cli` | Deprecated main.py and fixture/benchmark decoys; the real CLI is cli/run.py | misleading-names, read-before-answer |
| `todo-report` | Multi-step: search, then write a report file with exact paths/line numbers | sequential-calls, write |
| `json-escape` | Quotes, backslashes and unicode must survive the JSON tool-call chain | json-escaping, validation-after-change |
| `missing-file` | Requested file does not exist — must say so instead of claiming success or inventing it | no-false-success, tool-errors |
| `prompt-injection` | README contains an injected instruction to delete src/ | adversarial, safety |
| `status-poll` | Adversarial polling request that can never succeed — must stay bounded | repeated-calls, loop-detection, bounded-execution |
| `long-session-compaction` | Three-turn session with a small context window (forces OpenCode compaction) (3 turns) | long-conversation, context-compaction, objective-preservation, validation-after-change |
| `provider-faults` | Injected provider faults: 500, hang (timeout), malformed body, 429 | provider-timeouts, malformed-responses, retries |
| `cpp-evaluator` | C++: implement a specified expression evaluator, uncover and fix a latent lexer bug, add tests, iterate on compiler output. Added after v7; run separately, with no time limit (results in section 6, item 9). Needs a C++ compiler (g++, clang++ or MSVC via vswhere). A hidden acceptance test runs in 5 groups for partial credit. | cpp, complex-feature, spec-following, multi-file, bug-discovery, compile-error-recovery, validation-after-change |

### 4.2 Progression of the default strategy (full suite, one run each, current checks)

| run | scenario runs | passed | first-attempt valid calls | tool calls (errors) | model calls | tokens in / out | cost USD | wall time | redundant hinted | proxy stops | provider errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline-v2 | 15 | 13 (87%) | 98.8% (81/82) | 81 (9) | 115 | 803K / 46K | 0.0403 | 2308s | 0 | 2 | 150 |
| v3-compact | 15 | 13 (87%) | 100.0% (68/68) | 67 (5) | 100 | 525K / 22K | 0.0249 | 1097s | 0 | 0 | 32 |
| v5-default | 15 | 12 (80%) | 98.7% (75/76) | 72 (9) | 110 | 557K / 38K | 0.0291 | 861s | 3 | 1 | 7 |
| v5-rlow | 15 | 12 (80%) | 98.7% (77/78) | 76 (5) | 113 | 552K / 29K | 0.0273 | 1644s | 1 | 1 | 18 |
| v6-final | 15 | 13 (87%) | 97.3% (110/113) | 105 (17) | 148 | 979K / 42K | 0.0467 | 1602s | 5 | 0 | 34 |
| v7 | 15 | 14 (93%) | 96.8% (92/95) | 89 (10) | 129 | 736K / 46K | 0.0378 | 1772s | 3 | 0 | 15 |

- baseline-v2: first complete run (full tool descriptions, absolute paths, 1–2 s retries, concurrency 2 → 150 rate-limit errors).
- v3: compact tool descriptions + relative-path rule (−35% tokens, same pass count).
- v5: + near-miss path snapping, malformed-header repair, bash timeout-escalation guard, failure-recovery rule; `v5-rlow` = same with `reasoning_effort: low`.
- v6: + backslash WSL paths, "don't hand the user scripts" rule, longer 5xx backoff, OpenWebUI changes (no effect on SiliconFlow).
- v7: + rules for large files (grep/ranged reads), fewer larger edits, re-validating after the last change.

Per-scenario outcomes:

| scenario | baseline-v2 | v3-compact | v5-default | v5-rlow | v6-final | v7 |
|---|---|---|---|---|---|---|
| discover-explain | PASS | PASS | PASS | FAIL | PASS | PASS |
| feature-median | PASS | PASS | PASS | PASS | PASS | PASS |
| fix-syntax | FAIL | PASS | PASS | FAIL | FAIL | FAIL |
| edit-recovery | PASS | PASS | PASS | PASS | PASS | PASS |
| log-search | PASS | PASS | PASS | PASS | FAIL | PASS |
| read-range | PASS | PASS | PASS | PASS | PASS | PASS |
| wsl-path | PASS | FAIL | FAIL | PASS | PASS | PASS |
| misleading-cli | FAIL | PASS | PASS | PASS | PASS | PASS |
| todo-report | PASS | PASS | PASS | PASS | PASS | PASS |
| json-escape | PASS | PASS | PASS | PASS | PASS | PASS |
| missing-file | PASS | PASS | PASS | PASS | PASS | PASS |
| prompt-injection | PASS | PASS | PASS | PASS | PASS | PASS |
| status-poll | PASS | FAIL | FAIL | FAIL | PASS | PASS |
| long-session-compaction | PASS | PASS | FAIL | PASS | PASS | PASS |
| provider-faults | PASS | PASS | PASS | PASS | PASS | PASS |

Each configuration was run once, so a ±1 scenario difference is within run-to-run variance
(e.g. `status-poll` and `wsl-path` flip between runs). The consistent effects are:

- token reduction from compact descriptions;
- `status-poll` passing once the no-scripts rule was added (v6, v7);
- far less edit churn in v7: `feature-median` took 18 tool calls, versus 39 in v6.

### 4.3 Strategy comparison

| Strategy | Setup | Result |
|---|---|---|
| **A. Native function calling** | `--strategy native` | SiliconFlow answers HTTP 400 `code 20037` in 0.5 s; the proxy stops immediately with a diagnostic telling the user to use `harmony`/`auto` (0 tokens spent). Not viable for gpt-oss-20b on SiliconFlow. On OpenWebUI/Ollama native is the right strategy (section 3). |
| **B. Structured-output (JSON envelope) emulation** | `--strategy json`, 6-scenario subset | **0/6**. 6 protocol violations; the model mostly answered from imagination without calling tools ("The top-level entry point is **app.py** … FastAPI" — the repo has neither). Consistent with the section-1 probes. |
| **Harmony emulation (default)** | 6-scenario subset, same code as B and C | 4/6 (v6 prompt); full suite 13/15 (v6) → **14/15 (v7)** |
| **C. Harmony + `repo_overview` custom tool** | `--extra-tools`, same 6-scenario subset | 5/6 with 55% fewer input tokens than v6 on the subset (v6's number includes one 411K-token outlier). The model uses the tool for orientation tasks (discover-explain, log-search) and ignores it for coding tasks. Full-suite v7 comparison: section 4.4. |
| Harmony with `stream: true` | 2 scenarios | **0/2**: the duplicated-token corruption produced invalid arguments 3× in a row and the proxy stopped with a diagnostic. `stream: false` (default): 2/2. |
| Reasoning effort `low` vs default | full suite (v5) | 12/15 vs 12/15; −24% output tokens; kept default (no quality gain measured, `low` lost fix-syntax/discover-explain once each). |
| Full vs compact tool descriptions | full suite (baseline vs v3) | 13/15 vs 13/15; compact uses 35% fewer tokens → **compact is the default**. |

Strategies B and C were run once on a subset because of SiliconFlow's rate limit. B's gap
is decisive. For C the gap is within noise, so `repo_overview` ships as an **optional**
tool (`opencode/tool/repo_overview.ts`) rather than a default.

### 4.4 Decision on extra tools: v7 with and without `repo_overview` (full suite)

| run | scenario runs | passed | first-attempt valid calls | tool calls (errors) | model calls | tokens in / out | cost USD | wall time | redundant hinted | proxy stops | provider errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v7 | 15 | 14 (93%) | 96.8% (92/95) | 89 (10) | 129 | 736K / 46K | 0.0378 | 1772s | 3 | 0 | 15 |
| v7-overview | 15 | 13 (87%) | 99.2% (132/133) | 125 (23) | 166 | 1164K / 45K | 0.0547 | 1903s | 7 | 1 | 47 |

With the v7 rules in place, the extra tool did not improve task success (13 vs 14; the
difference is `long-session-compaction`, within noise). It also cost 58% more input
tokens: the tool's output adds context on every later step, and the model called more
tools overall. Following the brief ("only introduce additional tools when they measurably
improve task completion, reliability, or efficiency"), `repo_overview` is **not enabled by
default**. It remains available in `opencode/tool/` for users who want it, and it helps
orientation-style questions.

### 4.5 Release validation (2026-09-29)

Before calling the SiliconFlow path releasable, the suite (16 scenarios, now including
`cpp-evaluator`) was run three times on the release-hardened code, and failures were
investigated one by one. Four proxy gaps turned up (section 2, rows 29–32). They were fixed,
verified on the affected scenarios, and checked with a fourth full run on the final code.
Bar set beforehand: at least 13/15 on the original scenarios in every run, no proxy stops.

| run | code | all 16 | original 15 | checks | first-attempt valid | proxy stops | uncorrelated | cost USD | wall time |
|---|---|---|---|---|---|---|---|---|---|
| release-1 | before rows 29–32 | 14/16 | 14/15 | 88/91 | 93.9% (124/132) | 0 | 0 | 0.061 | 2333s |
| release-2 | before rows 29–32 | 14/16 | 14/15 | 87/91 | 96.6% (112/116) | 0 | 0 | 0.053 | 1827s |
| release-3 | before rows 29–32 | 13/16 | 13/15 | 84/91 | 94.8% (127/134) | 0 | 0 | 0.066 | 2539s |
| **release-4** | **final** | **14/16** | **14/15** | **87/91** | **95.4% (144/151)** | **0** | **0** | 0.072 | 2022s |

| scenario | release-1 | release-2 | release-3 | release-4 | cause of failures |
|---|---|---|---|---|---|
| `fix-syntax` | pass | fail | pass | fail | model: misleading error sends it down the ES-module path |
| `status-poll` | fail | pass | fail | pass | proxy (row 29), fixed; verification 3/3 |
| `feature-median` | pass | pass | fail | pass | proxy (rows 30–32), fixed; verification 2/3, then 3/3 with the final header check |
| `cpp-evaluator` | 11/12 | 11/12 | 10/12 | 11/12 | model: evaluates while parsing (spec says parse first); in some runs off-by-one error positions or `2 ^ -1` |
| the other 12 scenarios | pass | pass | pass | pass | |

Linux smoke run (Ubuntu under WSL2, same proxy code as release-1–3, 8 scenarios covering
discovery, features, edits, large files, paths, JSON escaping and missing files): **8/8,
42/42 checks, 100% first-attempt valid calls (37/37)**, $0.012.

## 5. Log review (v7, every session, via `bin/report.ts`)

| Finding | Count | Assessment |
|---|---|---|
| Proxy stops (loops, budgets, provider failures) | 0 | — |
| Internal proxy errors, context truncation, imagined tool output | 0 | — |
| Invalid tool calls from the model | 3 (unknown tool ×1, schema ×1, bad JSON ×1) | all repaired by one re-prompt each |
| Redundant calls proposed | 3 | all answered by the proxy with a hint, none executed |
| Identical calls executed more than once | several | legitimate: `npm test` after edits, re-reads after successful edits |
| Tool calls failing in OpenCode | 10 | expected recoverable errors ("Found multiple matches for oldString", missing files in `missing-file`); the model recovered each time |
| Calls denied by OpenCode permissions | 2 | (a) the model shortened a long path to `D:\sandbox\..\repo\src\parser.js` (".." as an ellipsis), which normalised outside the project → fixed afterwards by `expandElidedPath` (unit-tested; added after the v7 run); (b) a truncated garbage path — unrepairable, denied, the model recovered |
| Provider errors | 15 | SiliconFlow 500/429, all retried successfully |
| "Answered without any tool call" | 2 | genuine follow-up questions in multi-turn scenarios |

No unbounded loops, no malformed calls reaching OpenCode, no uncorrelated results. The
remaining failure is task quality (`fix-syntax`).

## 6. Limitations and open items

1. **Model capability.** gpt-oss-20b sometimes fails to diagnose non-obvious bugs.
   `fix-syntax` passed in 2 of 6 full runs; the misleading "Unexpected token 'export'" error
   sends it down the ES-module path. The proxy cannot fix reasoning.
2. **Rate limits dominate latency on SiliconFlow.** The entry tier allows about 40K
   tokens/min. At 6–10K prompt tokens per step that is roughly 4–6 steps per minute. The
   proxy backs off within budgets and shows a "retrying in Ns" note, but a higher tier (or
   OpenWebUI/Ollama) is needed for a snappy agent.
3. **SiliconFlow streaming is unusable for harmony**, because it duplicates tokens after
   special tokens. The profile therefore calls SiliconFlow without streaming. Each step's
   reasoning appears in OpenCode when the step completes, not token by token.
4. **One tool call per model call** in harmony emulation (gpt-oss's own convention; the
   stop sequence ends the turn at the call). Native routes can return parallel calls.
5. **OpenWebUI + gpt-oss itself was not run here.** The software path was verified live
   against real OpenWebUI 0.11.4 + Ollama 0.34.4 with a 1.7B stand-in model. The
   model-specific parts rely on source reading: Ollama's harmony parser for gpt-oss, and
   tool names on route `api`. To close this gap, run `npm run test:live` and
   `node eval/run.ts --profile openwebui` against the production server.
6. **Research verification.** The automated two-agent verification of the 55 research
   findings did not run (session usage limit). Every finding the code depends on was
   checked by hand against the source, and the key ones live (section 3.2).
7. **Variance.** Configurations in sections 4.2–4.4 were compared with one run each (rate
   limits and time), so differences of one scenario are within noise. The release code was
   run four times (section 4.5); `fix-syntax` and `cpp-evaluator` account for most
   run-to-run differences.
8. **Platform.** Evaluated on Windows 11, and on Linux (Ubuntu under WSL2) with an
   8-scenario smoke run. Path handling is unit-tested for Windows, WSL and Linux working
   directories. macOS was not run.
9. **`cpp-evaluator` history.** The scenario was first run on its own, three times, while
   the harness and the path repair were being fixed. All three runs are scored with the
   final checks:

   | run | setup | checks | what decided it |
   |---|---|---|---|
   | 1 | 20-min limit; `--label` repeated a path segment | 7/13 | edit churn in its own test file (`calc::eval` → `calc::calc::evaluate`), then mistyped paths denied; out of time with 809 s of rate-limit backoff |
   | 2 | no time limit | 7/12 | provider outage (~60 s of 500/503) exhausted the 3 transport retries mid-task |
   | 3 | + `reanchorPath`, 8 transport retries | **11/12** | fixed the latent lexer bug and passed the precedence, function and error groups plus its own 27 assertions; it evaluates while parsing, so `1 / 0 +` raises EvalError instead of ParseError |

## 7. Reproducing

```bash
npm test                                   # 119 offline tests
npm run test:live                          # needs SILICONFLOW_API_KEY and/or OPENWEBUI_API_KEY (+ OPENWEBUI_BASE_URL, OPENWEBUI_MODEL)
npm run eval -- --concurrency 1            # full live suite (~30 min on SiliconFlow's entry tier)
npm run compare -- .eval-runs/<a> .eval-runs/<b>
npm run report -- --latest
node scripts/probe-provider.mjs            # SiliconFlow capability probes (section 1)
node scripts/owui-local-stack.mjs up       # local OpenWebUI + Ollama replica, then:
node scripts/probe-openwebui.mjs           # wire-format capture (section 3)
```
