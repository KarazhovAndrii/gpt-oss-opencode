# gpt-oss-opencode

**A coding agent hosted in [OpenCode](https://opencode.ai), powered by GPT-OSS 20B from any
provider you choose.**

OpenCode hosts the agent: the conversation, the tools (read, edit, bash, …), permissions
and session history. GPT-OSS 20B decides what to do next. You can get the model from a
hosted API, your own GPU server, or a gateway such as OpenWebUI, as long as it meets
[a short list of requirements](#llm-provider-requirements).

Connecting the two directly doesn't work well. Some providers reject tool calling for
this model, gateways drop parts of the conversation, and the model itself sometimes
emits malformed calls, invents file paths or repeats itself. **gpt-oss-opencode** is a
small proxy that runs on your machine between OpenCode and the provider and fixes that
plumbing:

- **It makes tool calls work with any provider.** It uses the provider's native function
  calling when available, and otherwise emulates it in gpt-oss's own "harmony" format.
- **It checks every call** against OpenCode's tool definitions, repairs or re-asks bad
  ones, stops loops, and retries provider failures.
- **It is provider-neutral.** A generic `custom` profile covers any OpenAI-compatible
  endpoint. Two presets cover tested providers with quirks: SiliconFlow (hosted) and
  OpenWebUI in front of Ollama (self-hosted).
- **It is measured.** With SiliconFlow as the provider, 14 of 15 live coding scenarios
  passed in the final evaluation run, and about 95% of tool calls were valid on the first
  try; the rest were repaired ([validation report](docs/VALIDATION_REPORT.md)).
- Node.js ≥ 22.18, no runtime dependencies, MIT license.

**Contents:**
[Quick setup](#quick-setup) ·
[Example usage](#example-usage) ·
[How the agent works](#how-the-agent-works) ·
[LLM provider requirements](#llm-provider-requirements) ·
[Self-hosting with OpenWebUI and Ollama](#self-hosting-with-openwebui-and-ollama) ·
[Configuration reference](#configuration-reference) ·
[Security, privacy and logs](#security-privacy-and-logs) ·
[What to expect](#what-to-expect) ·
[Development](#development)

## Quick setup

You need **Node.js 22.18 or newer**, **OpenCode 1.18 or newer**, and access to
**GPT-OSS 20B** through an OpenAI-compatible API. Check the
[provider requirements](#llm-provider-requirements) if you are unsure.

### 1. Start the proxy and point it at your provider

```bash
git clone https://github.com/KarazhovAndrii/gpt-oss-opencode.git
cd gpt-oss-opencode
npm install                                   # dev tooling only; the proxy has no runtime dependencies

export CUSTOM_BASE_URL=https://your-provider.example/v1   # any OpenAI-compatible endpoint
export CUSTOM_MODEL=openai/gpt-oss-20b                     # the model id your provider uses
export CUSTOM_API_KEY=sk-...                               # only if your provider needs a key
npm start
```

On Windows PowerShell, set variables like this: `$env:CUSTOM_BASE_URL="https://..."`.

The proxy prints where it listens and which providers are configured:

```
gpt-oss-proxy listening on http://127.0.0.1:8787/v1
 * custom       https://your-provider.example/v1  model=openai/gpt-oss-20b  strategy=auto  key=present
   siliconflow  https://api.siliconflow.com/v1  model=openai/gpt-oss-20b  strategy=harmony  key=none (SILICONFLOW_API_KEY not set)
   openwebui    http://localhost:8080/api  model=gpt-oss20b-opencode  strategy=auto  key=none (OPENWEBUI_API_KEY not set)
logs: .../gpt-oss-opencode/logs (metadata only; GPT_OSS_LOG_CONTENT=1 adds content, kept 14 days)
```

Leave it running. **Is your provider one of the tested ones?** Use its preset instead of
`CUSTOM_*`:

| Provider | Set | OpenCode model |
|---|---|---|
| SiliconFlow (hosted) | `SILICONFLOW_API_KEY` | `gpt-oss/siliconflow` |
| OpenWebUI in front of Ollama (self-hosted) | `OPENWEBUI_BASE_URL`, `OPENWEBUI_MODEL`, `OPENWEBUI_API_KEY` ([server guide](#self-hosting-with-openwebui-and-ollama)) | `gpt-oss/openwebui` |

### 2. Add the proxy to OpenCode

Copy [`opencode/opencode.json`](opencode/opencode.json) to `~/.config/opencode/opencode.json`
(on Windows `%USERPROFILE%\.config\opencode\opencode.json`). If you already have that file,
merge the `provider` block into it; a project's own `opencode.json` works as well.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "gpt-oss/custom",
  "small_model": "gpt-oss/custom",
  "provider": {
    "gpt-oss": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GPT-OSS 20B (gpt-oss-proxy)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "unused-the-proxy-holds-the-provider-keys" },
      "models": {
        "custom":      { "name": "gpt-oss-20b (your provider)", "tool_call": true, "reasoning": true, "limit": { "context": 32768, "output": 8192 } },
        "siliconflow": { "name": "gpt-oss-20b via SiliconFlow", "tool_call": true, "reasoning": true, "limit": { "context": 131072, "output": 8192 }, "cost": { "input": 0.04, "output": 0.18 } },
        "openwebui":   { "name": "gpt-oss-20b via OpenWebUI", "tool_call": true, "reasoning": true, "limit": { "context": 32768, "output": 8192 } }
      }
    }
  }
}
```

- The model key (`custom`, `siliconflow`, `openwebui`) tells the proxy which provider to
  use. `"model"` sets the default; switch with `/models` in OpenCode or `-m` on the command
  line.
- `apiKey` is a placeholder: provider keys stay with the proxy, not OpenCode.
- `limit.context` is the model's window. Set it to your provider's real context length
  (and the same number in `CUSTOM_CONTEXT_WINDOW`). OpenCode then compacts long
  conversations before they overflow. 32768 is a safe default; hosted providers often
  allow 131072.

### 3. Run a task

```bash
cd /path/to/your/project
opencode                                     # interactive; the model is preselected
opencode run "Explain what this project does and where its entry point is."
```

## Example usage

### A first task

Here is a real session, with the output trimmed (read ranges, diff context and the model's
notes removed). It ran through the proxy with SiliconFlow, one of the tested providers,
on a small JavaScript project with a `src/stats.js` module and one test file:

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
- The provider returned five server errors (HTTP 500/503). The proxy retried them without
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
| Work interactively | `opencode`, then type tasks; `/models` switches between the configured providers |
| One task from the shell | `opencode run "…"` |
| Follow up in the last session | `opencode run -c "…"` |
| Pick the provider for one run | `opencode run -m gpt-oss/siliconflow "…"` (or `gpt-oss/custom`, `gpt-oss/openwebui`) |
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
you ──▶ OpenCode ──OpenAI API──▶ gpt-oss-proxy ──OpenAI API──▶ any GPT-OSS 20B provider
          ▲  runs every tool          │                         (hosted API, own server,
          └──── validated tool calls ◀┘                          OpenWebUI, …)
               validate · repair · loop guard · retries · logs
```

| Part | Role |
|---|---|
| **OpenCode** | Hosts the agent: your conversation, the tools (read, glob, grep, edit, write, bash, …), permission prompts, session history and compaction. |
| **GPT-OSS 20B** | Decides the next step: which tool to call with which arguments, or the final answer. Any provider can supply it. |
| **gpt-oss-proxy** | Sits between the two. It speaks the OpenAI API to OpenCode and to the provider, and makes sure every step OpenCode receives is a valid tool call or a real answer. |

For each step of a task, the proxy:

- **Gets the tool call out of the model.** With a provider that supports native function
  calling, the proxy uses it (strategy `native`). Otherwise it describes OpenCode's tools
  in gpt-oss's own "harmony" format and parses the model's calls out of the reply (strategy
  `harmony`). The default strategy, `auto`, tries native first and switches to harmony if
  the provider refuses tools. OpenCode always receives standard streamed `tool_calls`.
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

## LLM provider requirements

Any source of GPT-OSS 20B works if it meets these requirements:

| Requirement | Why |
|---|---|
| Serves **GPT-OSS 20B** | The proxy is built around this model's output format and habits. gpt-oss-120b uses the same format but is untested. |
| **OpenAI-compatible Chat Completions API**: `POST <base URL>/chat/completions`, optionally with `Authorization: Bearer <key>` | This is the only API the proxy calls. |
| **Tool calls, in one of two ways:** native function calling (`tools` in, `tool_calls` out), **or** the model's raw text with its tool-call markers kept (harmony tokens such as `<\|channel\|>` and `<\|message\|>`) and the `stop` parameter honoured | Native providers use the `native` strategy. The others use `harmony` emulation. `auto` detects which applies. |
| **A context window of at least 32K tokens**, declared with the same value in OpenCode (`limit.context`) and the proxy (`<PROFILE>_CONTEXT_WINDOW`) | OpenCode's system prompt and tool definitions alone take 5–7K tokens. A server that silently cuts the conversation makes the model forget its task. |
| **Up to 8K output tokens per response**, or set `maxOutputTokens` to the provider's limit | File writes and edits are generated in a single response. |
| Streaming is **optional** | The proxy streams to OpenCode either way. Set `"stream": false` for a provider whose stream is broken. |

### Where the model can come from

| Source | Base URL (example) | Model id (example) | Key | Status |
|---|---|---|---|---|
| A hosted API that offers GPT-OSS 20B | `https://<provider>/v1` | as the provider names it, often `openai/gpt-oss-20b` | yes | **SiliconFlow tested** (preset `siliconflow`) |
| OpenWebUI in front of Ollama | `http://<server>:8080/api` | your OpenWebUI model id | yes | **software path tested** (preset `openwebui`, [guide](#self-hosting-with-openwebui-and-ollama)) |
| Ollama directly | `http://<server>:11434/v1` | `gpt-oss:20b` | no | untested; set Ollama's context length as in [step 1 of the guide](#step-1-serve-gpt-oss20b-with-ollama-and-a-large-enough-context) |
| Other OpenAI-compatible servers (vLLM, llama.cpp's `llama-server`, LM Studio, …) | `http://<server>:<port>/v1` | as the server names it | usually no | untested |

For any untested source, use the generic `custom` profile (`CUSTOM_BASE_URL`,
`CUSTOM_MODEL`, and `CUSTOM_API_KEY` if needed) and check it before relying on it.

### Checking a new provider

1. **A full tool round trip:** with the `CUSTOM_*` variables set, run `npm run test:live`.
   It plays OpenCode's role against your provider, through the proxy, on a small task:
   read, edit, run the tests, answer.
2. **The live evaluation** (optional, about 30 minutes):
   `npm run eval -- --profile custom --concurrency 1` runs the 16 scenarios behind the
   numbers in the [validation report](docs/VALIDATION_REPORT.md).
3. **What the proxy saw:** `npm run report -- --latest` shows which strategy was used. A
   `strategy_fallback` entry means the provider refused native tools and harmony emulation
   took over.

If the provider refuses tools, set `CUSTOM_STRATEGY=harmony` to skip the detection. If its
streaming output looks corrupted, set `"stream": false` for its profile in the config file.
Those are exactly the two quirks the SiliconFlow preset handles.

## Self-hosting with OpenWebUI and Ollama

This chapter is one way to supply the model yourself: **Ollama** serves GPT-OSS 20B on
your hardware, and **OpenWebUI** provides accounts, API keys and a model entry for
OpenCode. Plain Ollama or other servers can be used directly through the `custom` profile
([requirements](#llm-provider-requirements)); step 1 below applies to plain Ollama too.

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
create a key. It starts with `sk-`. Treat it like a password: the proxy reads it from the
`OPENWEBUI_API_KEY` environment variable, or from a file (see
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
   to your server, with the same variables set. Providers that aren't configured are
   skipped.
4. **Optional: the live evaluation** against your server, which takes about 30 minutes:
   `npm run eval -- --profile openwebui --concurrency 1`.

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

### Provider profiles

Each provider is a profile. OpenCode selects it through the model key (`gpt-oss/<profile>`),
so several providers can be configured at once and you switch in OpenCode.

| Profile | For | Defaults |
|---|---|---|
| `custom` (default) | any OpenAI-compatible provider serving GPT-OSS 20B | no address until `CUSTOM_BASE_URL` is set; model `openai/gpt-oss-20b`; key `CUSTOM_API_KEY` (optional); strategy `auto`; streaming; window 32768 |
| `siliconflow` (preset) | SiliconFlow | `https://api.siliconflow.com/v1`, model `openai/gpt-oss-20b`, key `SILICONFLOW_API_KEY`; strategy `harmony` and no streaming, because SiliconFlow rejects native tools for this model and corrupts streamed output; window 131072 |
| `openwebui` (preset) | OpenWebUI in front of Ollama | `http://localhost:8080/api`, model `gpt-oss20b-opencode`, key `OPENWEBUI_API_KEY`; strategy `auto`; route selection and payload fixes for OpenWebUI; window 32768 |

To use **several custom providers**, add named profiles to the config file (see below).
Each gets its own `<NAME>_*` variables and OpenCode model key `gpt-oss/<name>`.

### Environment variables

| Variable | Effect |
|---|---|
| `CUSTOM_BASE_URL`, `CUSTOM_MODEL`, `CUSTOM_API_KEY` | the generic provider: address, model id, key (optional) |
| `<PROFILE>_BASE_URL`, `<PROFILE>_MODEL`, `<PROFILE>_STRATEGY` | override any profile, e.g. `OPENWEBUI_BASE_URL=http://gpu-box:8080/api`, `CUSTOM_STRATEGY=harmony` |
| `<PROFILE>_CONTEXT_WINDOW` | the provider's real context length in tokens, e.g. `CUSTOM_CONTEXT_WINDOW=131072` |
| `SILICONFLOW_API_KEY`, `OPENWEBUI_API_KEY` | keys for the presets |
| `OPENWEBUI_ROUTE`, `OPENWEBUI_NUM_CTX` | OpenWebUI route (`auto`, `ollama-v1`, `api`) and per-request `num_ctx` (route `api` only) |
| `GPT_OSS_PORT`, `GPT_OSS_HOST` | listen address (default `127.0.0.1:8787`) |
| `GPT_OSS_PROXY_TOKEN` | require `Authorization: Bearer <token>` from clients (put the same value in OpenCode's `apiKey`). **Required** for any address other than localhost; see [Security](#security-privacy-and-logs) |
| `GPT_OSS_PROFILE` | profile used when OpenCode sends a model id that matches no profile (default `custom`) |
| `GPT_OSS_STRATEGY` | force a strategy for all profiles: `harmony`, `native`, `json`, `auto` |
| `GPT_OSS_CONFIG` | config file path (default `./gpt-oss-proxy.config.json` if present) |
| `GPT_OSS_LOG_DIR` | log directory (default `./logs`) |
| `GPT_OSS_LOG_CONTENT=1` | also log prompts, model output, tool-call values and result previews |
| `GPT_OSS_LOG_RETENTION_DAYS` | delete log days older than this (default `14`; `0` keeps everything) |
| `GPT_OSS_DUMP_REQUESTS=1` | also save every upstream request body for exact replays (`scripts/replay.ts`) |

### Config file

For anything beyond environment variables, copy
[`gpt-oss-proxy.config.example.json`](gpt-oss-proxy.config.example.json) to
`gpt-oss-proxy.config.json` and edit it. Profiles you add there start from the neutral
`custom` defaults. Each profile accepts:

| Option | Meaning |
|---|---|
| `baseURL`, `model` | where the provider is and which model to request |
| `apiKeyEnv` or `apiKeyFile` | where the key comes from: an environment variable, or a one-line file such as `"apiKeyFile": "key.txt"` |
| `strategy`, `fallbackStrategy` | tool-call strategy (see below) |
| `contextWindow`, `maxOutputTokens` | the provider's limits |
| `stream` | stream from the provider (turn off if its stream is broken) |
| `extraBody` | merged into every request, e.g. `{"reasoning_effort": "low"}` |
| `headers`, `pricing`, `toolDescriptions`, `aliases` | extra headers, USD per 1M tokens for cost reporting, `compact` or `full` tool descriptions, extra model ids |

Timeouts, retry and repair budgets and loop thresholds are under `limits` in the same file.

### Tool-call strategies

- **`auto`**, the default: the provider's native tool calling first, switching to
  `harmony` if the provider says tools are not supported (remembered).
- **`native`**: the provider's own tool calling, validated and repaired by the proxy.
- **`harmony`**: for providers without usable function calling. The proxy describes the
  tools in gpt-oss's own format, stops generation at the end of a call, and parses the
  call from the raw output. The SiliconFlow preset uses it.
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
- **Your provider sees your code.** Everything the agent reads is sent to the model
  provider. Choose the provider accordingly, or self-host.
- **Tools run with your permissions.** OpenCode executes what the model asks for, including
  shell commands. In repositories you don't trust, keep OpenCode's permission prompts for
  `bash` and `edit`: text inside a repository can try to steer any LLM agent (prompt
  injection).

**Session report:** `npm run report -- --latest` prints a session's timeline: requests, model
calls, proposed and executed calls, results, repairs and retries. It flags invalid calls,
loops, proxy stops, provider errors, permission denials (usually a mistyped path), slow calls
and context truncation. Other forms: `--session ses_abc`, a log directory, or `--json`.

## What to expect

The proxy makes GPT-OSS 20B's tool use reliable; it cannot make the model smarter. The
numbers below were measured with SiliconFlow as the provider. The model is the same
everywhere, so task quality should carry over, while speed depends on your provider. Full
results are in the [validation report](docs/VALIDATION_REPORT.md).

- **Good at:** finding and explaining code, small features with tests, targeted edits and
  fixes, and searching large files. These pass consistently in the live evaluation.
- **Unreliable at:**
  - Diagnosing bugs behind misleading error messages: about half of the runs succeed.
  - Larger work from a detailed spec. On a C++ task (implement an expression evaluator from
    a header spec, find a hidden lexer bug, add tests), it met 10–11 of 12 checks in every
    run but never all 12. It always fixed the lexer bug but kept missing a requirement the
    header states explicitly.
- **Speed depends on the provider.** On SiliconFlow's entry tier (about 40K tokens per
  minute), simple tasks took 1–3 minutes and larger ones 5–20. On your own server it
  depends on the GPU.
- **One tool call per step** with the `harmony` strategy (no parallel calls).
- **Tested providers:** SiliconFlow, and OpenWebUI + Ollama with a small stand-in model.
  GPT-OSS 20B behind OpenWebUI, and all other providers, are not verified yet: check them
  as described in [Checking a new provider](#checking-a-new-provider).
- **Tested platforms:** Windows 11 and Linux (Ubuntu under WSL2); macOS is untested.

## Development

```bash
npm test                 # 124 unit and contract tests; offline, uses the same AI SDK package as OpenCode
npm run typecheck        # tsc --noEmit (TypeScript runs natively on Node; no build step)
npm run test:live        # a real tool round trip for each configured provider (small cost)
npm run eval -- --profile custom --concurrency 1    # live evaluation: real OpenCode + proxy + your provider, 16 scenarios
npm run eval -- --only feature-median --repeat 3    # selected scenarios, repeated (default profile: siliconflow)
npm run recheck -- .eval-runs/<run>                 # re-judge a saved run with the current checks
```

The live evaluation runs real OpenCode on copies of the synthetic repositories in
`eval/fixtures/` and judges each scenario with deterministic checks: hidden tests, repository
state and the executed tool calls. Results are written to `.eval-runs/<run>/`. It needs the
OpenCode CLI (set `OPENCODE_BIN` to use a specific binary) and a configured provider
(`--profile` picks it; the default, `siliconflow`, is the reference used in the validation
report). The `cpp-evaluator` scenario also needs a C++ compiler (g++, clang++ or MSVC).

For OpenWebUI work without a GPU server, `node scripts/owui-local-stack.mjs up` builds a real
local OpenWebUI + Ollama stack in `.local-stack/`, with a small stand-in model.
`test/openwebui.contract.test.ts` replays traffic captured from real OpenWebUI and Ollama
servers.

**More documentation:**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design, provider profiles and module map.
- [docs/VALIDATION_REPORT.md](docs/VALIDATION_REPORT.md): provider investigation, every
  failure found and how it was fixed, and all evaluation results.

## License

MIT, see [LICENSE](LICENSE).
