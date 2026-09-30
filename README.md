# gpt-oss-opencode

**Use GPT-OSS 20B as a tool-using coding agent in [OpenCode](https://opencode.ai).**

GPT-OSS 20B is a capable open-weight model, but it makes a poor OpenCode agent on its own.
SiliconFlow rejects tool calling for it. OpenWebUI drops parts of the conversation on the way
to Ollama. The model itself sometimes emits malformed calls, invents file paths or repeats
itself. **gpt-oss-opencode** is a small proxy that runs on your machine between OpenCode and
the model and fixes that plumbing:

- **OpenCode stays the agent.** It keeps the conversation, runs every tool (read, edit,
  bash, …) under your permission settings, and compacts long sessions.
- **The proxy makes the model's tool calls work.** It translates to and from gpt-oss's own
  tool-call format, checks every call against OpenCode's tool definitions, repairs or re-asks
  bad ones, stops loops, and retries provider failures.
- **Two backends:** hosted **SiliconFlow**, or **your own OpenWebUI server** with Ollama
  serving `gpt-oss:20b`.
- **Measured:** 14 of 15 live coding scenarios passed in the final evaluation run, and
  about 95% of tool calls were valid on the first try; the rest were repaired
  ([validation report](docs/VALIDATION_REPORT.md)).
- Node.js ≥ 22.18, no runtime dependencies, MIT license.

**Contents:**
[Quick setup](#quick-setup) ·
[Example usage](#example-usage) ·
[How the agent works](#how-the-agent-works) ·
[Set up your OpenWebUI server](#set-up-your-openwebui-server) ·
[Configuration reference](#configuration-reference) ·
[Security, privacy and logs](#security-privacy-and-logs) ·
[What to expect](#what-to-expect) ·
[Development](#development)

## Quick setup

You need **Node.js 22.18 or newer**, **OpenCode 1.18 or newer**, and either a
**SiliconFlow API key** or an **OpenWebUI server** set up as described in
[Set up your OpenWebUI server](#set-up-your-openwebui-server).

### 1. Start the proxy

```bash
git clone <this repository> gpt-oss-opencode
cd gpt-oss-opencode
npm install                        # dev tooling only; the proxy has no runtime dependencies

export SILICONFLOW_API_KEY=sk-...  # PowerShell: $env:SILICONFLOW_API_KEY="sk-..."
npm start
```

It prints where it listens and which backends have a key:

```
gpt-oss-proxy listening on http://127.0.0.1:8787/v1
 * siliconflow  https://api.siliconflow.com/v1  model=openai/gpt-oss-20b  strategy=harmony  key=present
   openwebui    http://localhost:8080/api  model=gpt-oss20b-opencode  strategy=auto  key=MISSING (OPENWEBUI_API_KEY)
logs: .../gpt-oss-opencode/logs (metadata only; GPT_OSS_LOG_CONTENT=1 adds content, kept 14 days)
```

Leave it running. **Using an OpenWebUI server instead?** Set these three variables before
`npm start` (the values come from [the server setup](#set-up-your-openwebui-server)):

```bash
export OPENWEBUI_BASE_URL=http://your-server:8080/api   # the address you open OpenWebUI at, plus /api
export OPENWEBUI_MODEL=gpt-oss20b-opencode               # the model id in OpenWebUI
export OPENWEBUI_API_KEY=sk-...                          # OpenWebUI: Settings > Account > API keys
```

### 2. Add the proxy to OpenCode

Copy [`opencode/opencode.json`](opencode/opencode.json) to `~/.config/opencode/opencode.json`
(on Windows `%USERPROFILE%\.config\opencode\opencode.json`). If you already have that file, merge the
`provider` block into it; a project's own `opencode.json` works as well.

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
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  }
}
```

- `apiKey` is a placeholder: the provider keys stay with the proxy, not OpenCode.
- `limit` tells OpenCode how large the model's window is. OpenCode then compacts the
  conversation before it overflows and never asks for more output than the provider allows.
- For OpenWebUI, `"model"` and `"small_model"` become `gpt-oss/openwebui`.

### 3. Run a task

```bash
cd /path/to/your/project
opencode                                     # interactive; the model is preselected
opencode run "Explain what this project does and where its entry point is."
```

## Example usage

### A first task

Here is a real session, with the output trimmed (read ranges, diff context and the model's
notes removed). It ran through the proxy against SiliconFlow on a small JavaScript project
with a `src/stats.js` module and one test file:

```text
$ opencode run "Add a median(values) function to src/stats.js: average of the two middle
  values for an even count, do not mutate the input, throw a TypeError for an empty array.
  Export it, add tests to test/stats.test.js and run the test suite."

> build · siliconflow

→ Read src/stats.js
✱ Glob "test/stats.test.js" 1 match
→ Read test/stats.test.js
✱ Glob "package.json" 1 match
→ Read package.json

← Edit src/stats.js
+export function median(values) {
+  if (values.length === 0) throw new TypeError("median() of empty list");
+  const sorted = [...values].sort((a, b) => a - b);
+  const mid = Math.floor(sorted.length / 2);
+  if (sorted.length % 2 === 1) {
+    return sorted[mid];
+  }
+  return (sorted[mid - 1] + sorted[mid]) / 2;
+}

← Edit test/stats.test.js
-import { sum, mean } from "../src/stats.js";
+import { sum, mean, median } from "../src/stats.js";

✗ Edit test/stats.test.js failed
Error: Could not find oldString in the file. It must match exactly, including whitespace, ...
→ Read test/stats.test.js
✱ Glob "test/stats.test.js" 1 match
✗ Edit test/stats.test.js failed
Error: Could not find oldString in the file. It must match exactly, including whitespace, ...
✗ Edit test/stats.test.js failed
Error: Found multiple matches for oldString. Provide more surrounding context to make the match unique.

← Edit test/stats.test.js
+test("median", () => {
+  assert.equal(median([1, 3, 2]), 2);
+  assert.equal(median([1, 2, 3, 4]), 2.5);
+  assert.throws(() => median([]), TypeError);
+});
  (…)

$ npm test
✔ sum (0.7345ms)
✔ median (0.3846ms)
✔ mean (0.1111ms)
✔ median (0.0964ms)
ℹ tests 4
ℹ pass 4

✅ median added and tests run successfully.
```

The session took 106 seconds and 18 model calls, and cost $0.006. Along the way:

- The model read the code and the tests before editing, and ran the suite at the end.
- Three of its edits to the test file failed. It re-read the file and recovered.
- SiliconFlow returned five server errors (HTTP 500/503). The proxy retried them without
  interrupting the session.
- It added the `median` test **twice**. The result is correct, but it shows why you should
  review the diff before you commit.

To follow up in the same conversation, use `-c`:

```bash
opencode run -c "The median test is duplicated in test/stats.test.js; remove the second copy and rerun the tests."
```

### Everyday commands

| Goal | Command |
|---|---|
| Work interactively | `opencode`, then type tasks; `/models` switches between the SiliconFlow and OpenWebUI entries |
| One task from the shell | `opencode run "…"` |
| Follow up in the last session | `opencode run -c "…"` |
| Pick the backend for one run | `opencode run -m gpt-oss/openwebui "…"` |
| See what happened in a session | `npm run report -- --latest` (in the proxy folder) |

On Windows, a prompt that contains double quotes can be mangled on the command line; pipe it
in instead: `Get-Content task.txt | opencode run`.

### Getting good results

- **Name the files and the success check.** "Add X to `src/a.js`, add tests to
  `test/a.test.js`, and run `npm test`" works much better than "improve the stats module".
- **Ask for the tests to be run.** The model checks its work when asked, and the log shows
  whether it did.
- **Split big jobs** into steps, and continue the session with `-c` between them.
- **Review the diff** (`git diff`) before committing, as you would a junior developer's.

### Optional: let OpenCode start the proxy

With the bundled plugin, OpenCode starts the proxy inside its own process, or reuses one that
is already running, so you don't need a separate terminal:

```json
{ "plugin": ["file:///ABSOLUTE/PATH/TO/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"] }
```

The plugin reads the same environment variables and config file as `npm start`.

### Optional: the `repo_overview` tool

[`opencode/tool/repo_overview.ts`](opencode/tool/repo_overview.ts) is an OpenCode custom tool.
One call returns a depth-limited file tree with line counts, the manifest scripts, likely
entry points and the test command. Copy it to `~/.config/opencode/tool/` (or a project's
`.opencode/tool/`) to enable it. It helps with orientation questions, but in the full
evaluation it did not improve task success and used 58% more tokens, so it is off by default.

## How the agent works

```
you ──▶ OpenCode ──OpenAI API──▶ gpt-oss-proxy ──▶ SiliconFlow           (tool calls emulated)
          ▲  runs every tool          │         └─▶ OpenWebUI ─▶ Ollama   (native tool calls)
          └────── validated tool calls ◀──┘  validate · repair · loop guard · retries · logs
```

| Part | Role |
|---|---|
| **OpenCode** | The agent loop: your conversation, the tools (read, glob, grep, edit, write, bash, …), permission prompts, session history and compaction. |
| **gpt-oss-20b** | Decides the next step: which tool to call with which arguments, or the final answer. |
| **gpt-oss-proxy** | Sits between the two. It speaks the OpenAI API to OpenCode and the model's native format to the provider, and makes sure every step OpenCode receives is a valid tool call or a real answer. |

For each step of a task, the proxy:

- **Translates tool calls.** gpt-oss writes tool calls in its own "harmony" format. SiliconFlow
  refuses function calling for this model, so the proxy describes OpenCode's tools in that
  format and parses the model's calls out of its reply. On OpenWebUI it uses native tool
  calls and compensates for OpenWebUI's payload losses. OpenCode always receives standard
  streamed `tool_calls`.
- **Validates every call** against the tool list OpenCode sent: the tool must exist, the JSON
  must parse and match the schema, and paths must be sensible. It repairs what is safe to
  repair: WSL and Git-Bash paths on Windows, relative paths, and paths the model mistyped or
  abbreviated. File contents are never rewritten.
- **Re-asks instead of failing:** an invalid call goes back to the model with the exact error
  (up to 2 times), and so does a reply that is only half a tool call.
- **Guards against loops.** An identical call with nothing changed since is answered with the
  earlier result instead of running again. A polling loop that already timed out is not run
  again with a longer timeout. Long failure streaks and runaway turns stop with an
  explanation.
- **Survives provider trouble.** Timeouts, 5xx errors and malformed responses are retried
  with backoff, and rate limits have their own budget. If a budget runs out, OpenCode shows
  a `[gpt-oss-proxy] …` message saying what failed and what to change.
- **Protects the context window.** Oversized histories are trimmed (oldest tool results
  first), and it warns when a server silently cut the conversation.
- **Keeps a diagnostic log** per session (see [Security, privacy and logs](#security-privacy-and-logs)).

The reasoning behind this design, with the measurements that drove it, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Set up your OpenWebUI server

Use this chapter to run gpt-oss-20b on your own hardware: **Ollama** serves the model and
**OpenWebUI** provides accounts, API keys and a model entry for OpenCode.

```
OpenCode ─▶ gpt-oss-proxy ─▶ OpenWebUI ─▶ Ollama ─▶ gpt-oss:20b
 (your machine)                (your server)
```

The settings below were verified against OpenWebUI 0.11.4 and Ollama 0.34.4. Menu names may
differ slightly in other versions.

**Checklist:**

1. Ollama serves `gpt-oss:20b` with a context of **at least 32768 tokens**.
2. OpenWebUI is connected to Ollama and **API keys are enabled**.
3. A plain model entry `gpt-oss20b-opencode` exists, based on `gpt-oss:20b`.
4. You have an API key for a user who can use that model.
5. The proxy on your machine has the server's address, model id and key, and uses the same
   context size as the server.

### Step 1: Serve gpt-oss:20b with Ollama and a large enough context

```bash
ollama pull gpt-oss:20b     # about 14 GB; a GPU with 16 GB of memory or more is recommended
```

**Set the context length. This is the most important setting.** Ollama's default context
(`num_ctx`) depends on the GPU memory: **4096 tokens below 23 GiB**, 32768 from 23 GiB, and
262144 from 47 GiB. OpenCode's system prompt and tool definitions alone take 5–7K tokens.
When a request doesn't fit, Ollama silently drops the oldest messages: the model forgets the
task and its tool results, and it stops calling tools. Give the Ollama server at least 32768:

- **Linux (systemd):** run `sudo systemctl edit ollama`, add the lines below, then
  `sudo systemctl restart ollama`.
  ```ini
  [Service]
  Environment="OLLAMA_CONTEXT_LENGTH=32768"
  ```
- **Docker:** add `-e OLLAMA_CONTEXT_LENGTH=32768`, for example
  `docker run -d --gpus=all -e OLLAMA_CONTEXT_LENGTH=32768 -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama`.
- **Windows or macOS app:** set `OLLAMA_CONTEXT_LENGTH=32768` as a user environment variable
  and restart Ollama.
- **Or bake it into a model variant:** create a `Modelfile` with the two lines below, run
  `ollama create gpt-oss-20b-32k -f Modelfile`, and use `gpt-oss-20b-32k` as the base model
  in step 3.
  ```
  FROM gpt-oss:20b
  PARAMETER num_ctx 32768
  ```

A larger window (65536 or more) also works if the server has the memory; it lets longer
sessions run before OpenCode compacts them. Whatever you choose, use the same number on the
client side in [step 5](#step-5-connect-the-proxy).

### Step 2: Connect OpenWebUI to Ollama and enable API keys

- **Ollama connection:** start OpenWebUI with `OLLAMA_BASE_URL` pointing at Ollama, or add
  the connection under **Admin Panel › Settings › Connections**.
- **API keys:** they are **disabled by default**, and requests with a key then fail with
  403 "Use of API key is not enabled". Turn them on under **Admin Panel › Settings ›
  General**, or start OpenWebUI with `ENABLE_API_KEYS=True`. OpenWebUI keeps many settings
  in its database after the first start; if changing the environment variable has no
  effect, use the Admin Panel.
- **Non-admin users** also need the API-keys permission, which is set in the user and group
  permissions in the Admin Panel.
- **Endpoint restrictions:** if you restricted which endpoints API keys may call, allow
  `/api/models`, `/api/chat/completions` and `/ollama/v1/chat/completions`.

A complete Docker example for OpenWebUI next to the Ollama container above:

```bash
docker run -d -p 8080:8080 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  -e ENABLE_API_KEYS=True \
  --add-host=host.docker.internal:host-gateway \
  -v open-webui:/app/backend/data --name open-webui ghcr.io/open-webui/open-webui:main
```

### Step 3: Create the model entry for OpenCode

In OpenWebUI, go to **Workspace › Models** and create a new model:

| Field | Value |
|---|---|
| Model ID | `gpt-oss20b-opencode`. Any id works if you set `OPENWEBUI_MODEL` to it. |
| Base model | `gpt-oss:20b`, or your context variant from step 1 |
| System prompt | **empty** |
| Tools, knowledge, filters | **none** |
| Advanced parameters | leave at their defaults |

Keep this entry plain. OpenCode sends its own system prompt and tool list with every
request, and the proxy checks the model's calls against exactly that list. A server-side
prompt or attached OpenWebUI tools would compete with them. Only the context length matters
on the server, and step 1 took care of it.

If the API key in step 4 belongs to a different user than the one who created the model,
give that user access to the model in its access settings. **After saving, reload the
OpenWebUI page:** until the model list is refreshed, the API can answer HTTP 400 "Model not
found" for a model you just created.

You can also skip the entry and use the base model directly
(`OPENWEBUI_MODEL=gpt-oss:20b`). The entry gives you a stable id that you can re-point to
another base model later.

### Step 4: Create an API key

Sign in as the user the proxy should act as, go to **Settings › Account › API keys**, and
create a key. It starts with `sk-`. Treat it like a password: the proxy reads
it from the `OPENWEBUI_API_KEY` environment variable, or from a file (see
[Configuration reference](#configuration-reference)).

### Step 5: Connect the proxy

On your machine:

```bash
export OPENWEBUI_BASE_URL=http://your-server:8080/api
export OPENWEBUI_MODEL=gpt-oss20b-opencode
export OPENWEBUI_API_KEY=sk-...
npm start
```

Then select **gpt-oss-20b via OpenWebUI** in OpenCode (`/models`, or
`opencode run -m gpt-oss/openwebui "…"`), or make it the default in `opencode.json`.

**Match the context window on the client.** The defaults assume the server uses 32768. If
yours is larger, tell both OpenCode and the proxy, for example for 65536:

- in `opencode.json`, set `"limit": { "context": 65536, "output": 8192 }` for the `openwebui`
  model, so OpenCode compacts in time;
- for the proxy, set `export OPENWEBUI_CONTEXT_WINDOW=65536`, so it trims before the server
  would.

**Keep "gpt" out of the OpenCode model key.** The provided config uses `openwebui`.
OpenCode chooses its system prompt by model id: an id containing "gpt" gets a prompt that
requires an `apply_patch` tool, which OpenCode doesn't offer to "oss" models. The proxy maps
the neutral key to your real OpenWebUI model id.

### Step 6: Verify

1. **The model is visible to your key:**
   ```bash
   curl -s -H "Authorization: Bearer $OPENWEBUI_API_KEY" http://your-server:8080/api/models
   ```
   Look for your model id. `"owned_by": "ollama"` means the proxy will use the direct Ollama
   route (preferred, see below).
2. **The proxy has the key:** its startup lines show `openwebui … key=present`.
3. **A full tool round trip works:** `npm run test:live` sends a real task through the proxy
   to your server, with the same variables set. The SiliconFlow part is skipped without its
   key.
4. **Optional: the live evaluation** against your server, which takes about 30 minutes:
   `node eval/run.ts --profile openwebui --concurrency 1`.

### How the proxy talks to OpenWebUI

The proxy asks `/api/models` who owns the model, then picks one of two routes. You can force
one with `OPENWEBUI_ROUTE=ollama-v1` or `OPENWEBUI_ROUTE=api`.

| Route | Used when | Behaviour |
|---|---|---|
| `ollama-v1` → `/ollama/v1/chat/completions` | the model is on an **Ollama connection** (`owned_by: "ollama"`) | OpenWebUI applies your model entry and passes requests to Ollama's own OpenAI API. Tool results keep their names, `max_tokens` and `reasoning_effort` work, and errors keep their message. The context length comes from the server (step 1). |
| `api` → `/api/chat/completions` | the model is on an OpenAI-type connection, or the route is forced | Full OpenWebUI pipeline. On an Ollama connection it drops `max_tokens`, `temperature`, `reasoning_effort` and the names of tool results. The proxy compensates: it sends `options.num_predict`, labels tool results (`[read result]`), and can send `options.num_ctx` (`OPENWEBUI_NUM_CTX`). It also recognises Ollama errors that arrive disguised as an empty answer, and retries them. |

The default strategy for OpenWebUI is native tool calling. If the backend answers "tools not
supported", the proxy switches to emulated tool calls and remembers that.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HTTP 403 "Use of API key is not enabled" | API keys are off | Step 2 |
| HTTP 401 | wrong or missing key | check `OPENWEBUI_API_KEY`; the startup line should say `key=present` |
| HTTP 400 "Model not found" | the id differs from `/api/models`, or the list is stale | compare with `curl …/api/models` (step 6); reload OpenWebUI after creating a model |
| The model "forgets" the task, stops using tools, or OpenCode shows `[gpt-oss-proxy] the model server evaluated only N of ~M prompt tokens` | the server's context is too small, so Ollama cut the conversation | Step 1; then match the client window (step 5) |
| The first answer takes very long | Ollama is loading the model into memory, or part of the model runs on the CPU | wait for the first load; check GPU memory |
| `npm run report -- --latest` shows `strategy_fallback` | the backend refused native tool calls | nothing to do; emulated tool calls are used automatically |

## Configuration reference

### Backends

The proxy chooses the backend from the **model id** OpenCode sends, so both backends can be
configured at once and you switch in OpenCode:

| OpenCode model | Proxy profile | Defaults |
|---|---|---|
| `gpt-oss/siliconflow` | `siliconflow` | `https://api.siliconflow.com/v1`, model `openai/gpt-oss-20b`, key `SILICONFLOW_API_KEY`, strategy `harmony`, window 131072 |
| `gpt-oss/openwebui` | `openwebui` | `http://localhost:8080/api`, model `gpt-oss20b-opencode`, key `OPENWEBUI_API_KEY`, strategy `auto` (native), window 32768 |

### Environment variables

| Variable | Effect |
|---|---|
| `SILICONFLOW_API_KEY`, `OPENWEBUI_API_KEY` | provider keys |
| `<PROFILE>_BASE_URL`, `<PROFILE>_MODEL`, `<PROFILE>_STRATEGY` | override a profile, e.g. `OPENWEBUI_BASE_URL=http://gpu-box:8080/api` |
| `<PROFILE>_CONTEXT_WINDOW` | the backend's real context length in tokens, e.g. `OPENWEBUI_CONTEXT_WINDOW=65536` |
| `OPENWEBUI_ROUTE`, `OPENWEBUI_NUM_CTX` | OpenWebUI route (`auto`, `ollama-v1`, `api`) and per-request `num_ctx` (route `api` only) |
| `GPT_OSS_PORT`, `GPT_OSS_HOST` | listen address (default `127.0.0.1:8787`) |
| `GPT_OSS_PROXY_TOKEN` | require `Authorization: Bearer <token>` from clients (put the same value in OpenCode's `apiKey`). **Required** for any address other than localhost; see [Security](#security-privacy-and-logs) |
| `GPT_OSS_PROFILE` | profile used when OpenCode sends an unknown model id |
| `GPT_OSS_STRATEGY` | force a strategy for all profiles: `harmony`, `native`, `json`, `auto` |
| `GPT_OSS_CONFIG` | config file path (default `./gpt-oss-proxy.config.json` if present) |
| `GPT_OSS_LOG_DIR` | log directory (default `./logs`) |
| `GPT_OSS_LOG_CONTENT=1` | also log prompts, model output, tool-call values and result previews |
| `GPT_OSS_LOG_RETENTION_DAYS` | delete log days older than this (default `14`; `0` keeps everything) |
| `GPT_OSS_DUMP_REQUESTS=1` | also save every upstream request body for exact replays (`scripts/replay.ts`) |

### Config file

For anything beyond environment variables, copy
[`gpt-oss-proxy.config.example.json`](gpt-oss-proxy.config.example.json) to
`gpt-oss-proxy.config.json` and edit it. Each profile accepts:

| Option | Meaning |
|---|---|
| `baseURL`, `model` | where the backend is and which model to request |
| `apiKeyEnv` or `apiKeyFile` | where the key comes from: an environment variable, or a one-line file such as `"apiKeyFile": "key.txt"` |
| `strategy`, `fallbackStrategy` | tool-call strategy (see below) |
| `contextWindow`, `maxOutputTokens` | the backend's limits |
| `stream` | stream from the backend (off for SiliconFlow) |
| `extraBody` | merged into every request, e.g. `{"reasoning_effort": "low"}` |
| `headers`, `pricing`, `toolDescriptions`, `aliases` | extra headers, USD per 1M tokens for cost reporting, `compact` or `full` tool descriptions, extra model ids |

Timeouts, retry and repair budgets and loop thresholds are under `limits` in the same file.

### Tool-call strategies

- **`harmony`**, the SiliconFlow default: SiliconFlow rejects `tools` for gpt-oss-20b
  (`400 "Function call is not supported for this model"`), so the proxy describes the tools
  in gpt-oss's own format and parses its calls. SiliconFlow's streaming corrupts that format,
  so the proxy calls it without streaming and still streams to OpenCode.
- **`native`**: the backend's own tool calling, validated and repaired by the proxy.
- **`auto`**, the OpenWebUI default: native first, falling back to `harmony` if the backend
  says tools are not supported.
- **`json`**: an experimental JSON-envelope emulation, kept for comparison. It performed
  poorly with this model.

## Security, privacy and logs

- **Local only by default.** The proxy listens on `127.0.0.1`. It refuses to start on any
  other address unless `GPT_OSS_PROXY_TOKEN` is set, because anyone who can reach it could
  spend your provider keys.
- **Keys stay with the proxy.** They are read from the environment or a key file and are
  never logged. OpenCode only holds a placeholder, or the proxy token.
- **Logs are metadata only by default.** One JSONL file per session is written to
  `logs/<date>/<session>.jsonl`. It records timings, tools, paths, commands, sizes, retries,
  errors, tokens and cost. Your prompts, the model's output and file contents are left out;
  tool-call values appear as `[N chars]`. Set `GPT_OSS_LOG_CONTENT=1` while debugging to log
  everything. Logs older than 14 days are deleted automatically.
- **Tools run with your permissions.** OpenCode executes what the model asks for, including
  shell commands. In repositories you don't trust, keep OpenCode's permission prompts for
  `bash` and `edit`: text inside a repository can try to steer any LLM agent (prompt
  injection).

**Session report:** `npm run report -- --latest` prints a session's timeline: requests, model
calls, proposed and executed calls, results, repairs and retries. It flags invalid calls,
loops, proxy stops, provider errors, permission denials (usually a mistyped path), slow calls
and context truncation. Other forms: `--session ses_abc`, a log directory, or `--json`.

## What to expect

The proxy makes gpt-oss-20b's tool use reliable; it cannot make the model smarter. The
measured numbers are in the [validation report](docs/VALIDATION_REPORT.md).

- **Good at:** finding and explaining code, small features with tests, targeted edits and
  fixes, and searching large files. These pass consistently in the live evaluation.
- **Unreliable at:**
  - Diagnosing bugs behind misleading error messages: about half of the runs succeed.
  - Larger work from a detailed spec. On a C++ task (implement an expression evaluator from
    a header spec, find a hidden lexer bug, add tests), it met 10–11 of 12 checks in every
    run but never all 12. It always fixed the lexer bug but kept missing a requirement the
    header states explicitly.
- **Speed:** on SiliconFlow's entry tier (about 40K tokens per minute), simple tasks take
  1–3 minutes and larger ones 5–20. On your own server, speed depends on your GPU.
- **One tool call per step** with emulated tool calls (no parallel calls).
- **Tested on** Windows 11 and Linux (Ubuntu under WSL2); macOS is untested.
- **gpt-oss-20b behind OpenWebUI is not verified yet.** The OpenWebUI 0.11.4 + Ollama 0.34.4
  software path was verified live with a small stand-in model, because gpt-oss-20b doesn't
  fit the test machine. Run [step 6](#step-6-verify) against your server before relying on it.

## Development

```bash
npm test                 # 119 unit and contract tests; offline, uses the same AI SDK package as OpenCode
npm run typecheck        # tsc --noEmit (TypeScript runs natively on Node; no build step)
npm run eval -- --concurrency 1                     # live: real OpenCode + proxy + SiliconFlow, 16 scenarios
npm run eval -- --only feature-median --repeat 3    # selected scenarios, repeated
npm run recheck -- .eval-runs/<run>                 # re-judge a saved run with the current checks
npm run test:live        # a real tool round trip per configured backend (small cost)
```

The live evaluation runs real OpenCode on copies of the synthetic repositories in
`eval/fixtures/` and judges each scenario with deterministic checks: hidden tests, repository
state and the executed tool calls. Results are written to `.eval-runs/<run>/`. It needs
`SILICONFLOW_API_KEY` and the OpenCode CLI (set `OPENCODE_BIN` to use a specific binary). The
`cpp-evaluator` scenario also needs a C++ compiler (g++, clang++ or MSVC).

For OpenWebUI work without a GPU server, `node scripts/owui-local-stack.mjs up` builds a real
local OpenWebUI + Ollama stack in `.local-stack/`, with a small stand-in model.
`test/openwebui.contract.test.ts` replays traffic captured from real OpenWebUI and Ollama
servers.

**More documentation:**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design and module map.
- [docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md): provider investigation, every
  failure found and how it was fixed, and all evaluation results.

## License

MIT, see [LICENSE](LICENSE).
