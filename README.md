# gpt-oss-opencode

**A coding agent hosted in [OpenCode](https://opencode.ai), powered by OpenAI's open-weight
GPT-OSS models (gpt-oss-20b or gpt-oss-120b) from any provider you choose.**

OpenCode hosts the agent: the conversation, the tools (read, edit, bash, …), permissions
and session history. GPT-OSS decides what to do next. You can get the model from a
hosted API, your own GPU server, or a gateway such as OpenWebUI, as long as it meets
[a short list of requirements](#llm-provider-requirements).

## Why it's useful

**Connecting OpenCode to GPT-OSS often fails in practice, in ways that depend on the
provider and inference engine. This proxy fixes the failures we measured.**

OpenCode runs its agent entirely through tool calls. Every step (reading a file, editing
it, running the tests) must arrive from the model as a well-formed OpenAI `tool_calls`
message that matches OpenCode's tool schemas. GPT-OSS was trained on its own tool-call
format ("harmony"), and whether the two meet correctly depends on the provider or
inference engine in between. Some setups work; many users report ones that don't (see
[known public reports](#known-public-reports)). We measured the failures below on
SiliconFlow and on OpenWebUI with Ollama. Here is what goes wrong without the proxy and
what it does instead:

| Without gpt-oss-opencode | With it |
|---|---|
| **The agent can't start.** SiliconFlow rejects tool calling for GPT-OSS (`HTTP 400 "Function call is not supported for this model"`, for both gpt-oss-20b and gpt-oss-120b), so OpenCode can't run a single step. | The proxy writes OpenCode's tools into the model's own harmony format and parses the calls from its raw output. **14 of 15** live coding scenarios pass. |
| **The usual workaround fails.** Prompting the model to reply with JSON tool calls passed **0 of 6** scenarios: the model mostly answered from imagination without reading a single file. | Speaking the format the model was trained on passed 4 of the same 6 with the prompt of that time; the final version passes 14 of 15 on the full suite. |
| **Streamed calls arrive corrupted.** SiliconFlow's stream duplicates tokens after harmony markers (`<\|channel\|>commentcomment…`), producing invalid calls: **0 of 2** scenarios. | The proxy reads the provider without streaming and streams to OpenCode itself: 2 of 2. |
| **Self-hosting fails silently.** OpenWebUI strips the tool name from tool results, ignores `max_tokens` (5 requested, 321 generated), and turns Ollama errors into empty answers. Ollama's default context (4K tokens on GPUs under 23 GiB) cuts the conversation without an error: the model saw 1,026 of 4,403 prompt tokens and stopped calling tools. | The proxy picks OpenWebUI's lossless route, compensates for the dropped fields, retries hidden errors, and warns in OpenCode when the server truncated the conversation. |
| **OpenCode uses the wrong system prompt.** For a model id containing "gpt", OpenCode's prompt demands an `apply_patch` tool that it doesn't offer to "oss" models. | The shipped config uses neutral model ids, and the proxy maps them to the real model. |
| **The model's own mistakes derail sessions.** Malformed calls (`globjson`, arguments inside the tool name, a bare `to=functions.read?` returned as the "answer"). Long file paths retyped with wrong digits: OpenCode denies them as outside the project, and the model starts reasoning about permissions. A timed-out polling loop re-run with a 10-minute timeout. Tool results the model invented instead of waiting for. | Every call is checked against OpenCode's tool schemas before OpenCode sees it. Broken calls are repaired or sent back with the exact error, mistyped paths are corrected when unambiguous, loops are cut off, and invented results are discarded. About 95% of calls are valid on the first try and the rest are repaired; in the final runs, no turn had to be stopped. |

**The result:** on the setups we tested, GPT-OSS works as an OpenCode agent where it
otherwise couldn't run at all, and the silent failures of the self-hosted gateway are
handled for you. You keep OpenCode exactly as it is. All 33 failure modes found and fixed
are documented, with evidence, in the [validation report](docs/VALIDATION_REPORT.md).

### Known public reports

Other users hit the same classes of problems on other setups. The table says, honestly,
whether this project fixes each one or only targets the same kind of failure. Statuses
are as of September 2026; newer versions of these projects may have fixed some.

| Report | What fails | Status here |
|---|---|---|
| [OpenCode #7524](https://github.com/anomalyco/opencode/issues/7524) (Jan 2026) | gpt-oss-120b on Scaleway: the chat-completions endpoint doesn't support tool calls for the model, and the conversation breaks after the first call | Same problem as SiliconFlow, where the proxy's emulation fixes it. **Not tested on Scaleway.** |
| [vLLM #22578](https://github.com/vllm-project/vllm/issues/22578) (Aug 2025, closed "not planned") | Tool calls through vLLM's chat-completions endpoint fail with gpt-oss-120b: parser errors, empty arguments | The `harmony` strategy parses calls itself instead of relying on the server's parser, but needs the server to return the model's raw output. **Not tested with vLLM.** |
| [OpenCode #7185](https://github.com/anomalyco/opencode/issues/7185) (Jan 2026) | gpt-oss-120b on vLLM only "thinks" and never calls a tool | Likely the same parser problem. The proxy recovers calls the model writes out as text, and `harmony` bypasses the parser. **Not tested with vLLM.** |
| [OpenCode #27210](https://github.com/anomalyco/opencode/issues/27210) (May 2026, closed "not planned") | A gpt-oss-120b subagent stops mid-reasoning after a few tool calls and returns an empty result | The proxy re-prompts once when a reply has neither text nor a tool call. **Not tested with this setup.** |
| [Ollama #12187](https://github.com/ollama/ollama/issues/12187) (Sep 2025, open) | Behind OpenWebUI, the model starts a tool call and then "completes" without doing anything | Matches the silent Ollama error that OpenWebUI turns into an empty answer; the proxy detects that and retries (tested with recorded traffic). **Not tested for this exact report.** |
| [Ollama #11800](https://github.com/ollama/ollama/issues/11800) (Aug 2025, closed) | HTTP 500 "unexpected error format in response" when the model's tool-call JSON is invalid | **Partly.** The proxy retries server errors, but re-asks the model to fix its call only for Ollama's "error parsing tool call" message. |
| Blog posts ([nijho.lt](https://www.nijho.lt/post/ollama-opencode/), [aldrickb.com](https://aldrickb.com/ollama-gpt-tools-error/)) | Ollama's 4K default context silently breaks tool calling with gpt-oss:20b | **Verified.** The proxy detects the truncation and warns in OpenCode; the fix is a server setting ([step 1 of the guide](#step-1-serve-gpt-oss20b-with-ollama-and-a-large-enough-context)). |
| [OpenCode #1633](https://github.com/sst/opencode/issues/1633) (Aug 2025, closed) | At launch, OpenCode displayed GPT-OSS's harmony output incorrectly | Fixed in OpenCode itself. Listed to show that some early problems are solved. |

If your setup is one of the untested ones, [check your provider](#checking-a-new-provider)
before relying on the proxy, and please report what you find.

**Who it's for:** anyone who wants gpt-oss-20b or gpt-oss-120b as their OpenCode agent,
especially:

- on a provider that doesn't offer function calling for GPT-OSS;
- on a self-hosted OpenWebUI or Ollama server;
- people building agents on small open models, who can use the documented failure modes
  and fixes.

The agent handles everyday coding tasks well; larger or subtler work still needs your
review (see [What to expect](#what-to-expect)).

**At a glance:** works with any OpenAI-compatible provider (generic `custom` profile, plus
tested presets for SiliconFlow and OpenWebUI) · gpt-oss-20b fully evaluated, gpt-oss-120b
verified end to end ([model sizes](#model-sizes-20b-and-120b)) · set up in about a minute
with `npm run setup` ([quick setup](#quick-setup)) · Node.js ≥ 22.18, no runtime
dependencies · MIT license.

**Contents:**
[Why it's useful](#why-its-useful) ·
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
**gpt-oss-20b or gpt-oss-120b** through an OpenAI-compatible API, for example an OpenWebUI
server and an API key for it. Check the [provider requirements](#llm-provider-requirements)
if you are unsure.

```bash
git clone https://github.com/KarazhovAndrii/gpt-oss-opencode.git
cd gpt-oss-opencode
npm run setup
```

No `npm install` and no environment variables are needed. Setup asks where the model comes
from, the server's address, your API key (input is hidden), the model (picked from the
server's own list) and, for a server you or your company run, the context size. Then it
**sends a real task through the proxy** and saves the configuration only if a valid tool
call comes back:

```text
$ npm run setup
Where does your GPT-OSS model come from?
    1) An OpenWebUI server (company or self-hosted)
    ...
  Choose 1, 2 or 3 [1]: 1
  OpenWebUI address (the one you open in the browser, e.g. http://gpu-server:8080): http://gpu-server:8080
  API key (OpenWebUI > Settings > Account > API keys; input is hidden): ***************
  ok  connected: 7 models available to this key
  ...
Checking gpt-oss20b-opencode, context 65536 (requested per request)
  ok  tool call works (2.4 s; route api, tool calls: native): the model called read {"filePath":"…/README.md"}

Saving
  ok  …/gpt-oss-opencode/gpt-oss-proxy.config.json (no secrets in it)
  ok  …/gpt-oss-opencode/openwebui.key (your API key; git-ignored)
  ok  ~/.config/opencode/opencode.json
        plugin: file:///…/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts (OpenCode starts the proxy itself)
        model: gpt-oss/openwebui
        small_model: gpt-oss/openwebui

Ready. In your project folder run: opencode
```

Then, in any project:

```bash
cd /path/to/your/project
opencode                                     # interactive; GPT-OSS is preselected
opencode run "Explain what this project does and where its entry point is."
```

OpenCode starts the proxy itself through the bundled plugin, so you don't need a second
terminal. The plugin also tells OpenCode the context size you chose, so OpenCode compacts
long conversations before they overflow.

**What setup writes:**

| File | Content |
|---|---|
| `gpt-oss-proxy.config.json` in this folder | address, model id, context; no secrets (git-ignored) |
| `<provider>.key` in this folder, e.g. `openwebui.key` | your API key (git-ignored; file mode 600 on Linux and macOS) |
| OpenCode's config: `~/.config/opencode/opencode.json`, or the `opencode.jsonc` you already have (on Windows under `%USERPROFILE%\.config\opencode\`) | the plugin, and `gpt-oss/<provider>` as the default model and title model. Your other settings and comments stay; a backup is saved next to it. If you already have another default model, setup asks before changing it |

Run setup again at any time to change the server, key, model or context.

### For teams: one command for everyone

At the end, setup prints a command with your server, model and context, for example:

```bash
npm run setup -- --openwebui http://gpu-server:8080 --model gpt-oss20b-opencode --context 65536
```

Share it (in your wiki, or a chat message). A colleague runs it after cloning and is asked
only for their own API key. For scripted installs, add `--key-file <file> --yes` and setup
asks nothing.

| Flag | Meaning |
|---|---|
| `--openwebui <address>` · `--url <address>` · `--siliconflow` | where the model comes from: an OpenWebUI server, any other OpenAI-compatible server, or SiliconFlow |
| `--model <id>` | the model id on that server |
| `--context <tokens>` | context window, e.g. `32768` or `64k` |
| `--key-file <file>` | read the API key from a file instead of asking |
| `--no-num-ctx` | OpenWebUI: the server already runs the model with this context (an admin set it), so don't request it with each call |
| `--no-plugin` | don't let OpenCode start the proxy; you run `npm start` yourself |
| `--no-opencode` | leave OpenCode's config alone |
| `--no-check` | save without the test request |
| `--yes` | ask nothing: use the flags, a saved key and defaults |

### When something doesn't work: `npm run doctor`

```bash
npm run doctor
```

Doctor checks the setup the way OpenCode will use it, and changes nothing. It shows:

- whether OpenCode loads the plugin, and whether the plugin file still exists (a moved
  folder breaks it);
- which config file, `.env` and environment variables are in effect;
- whether the server is reachable, the key is accepted, and the model exists;
- whether a real task gets a valid tool call back.

Each problem comes with what to do about it. Inside OpenCode, problems appear as messages
starting with `[gpt-oss-proxy]`: an unreadable config file, a provider that isn't set up
yet, or a server that cuts the conversation.

### Manual setup (without `npm run setup`)

If you prefer to configure things by hand, or want to run the proxy in its own terminal and
watch its output:

**1. Start the proxy and point it at your provider.**

```bash
export CUSTOM_BASE_URL=https://your-provider.example/v1   # any OpenAI-compatible endpoint
export CUSTOM_MODEL=openai/gpt-oss-20b                     # the model id your provider uses, e.g. openai/gpt-oss-120b
export CUSTOM_API_KEY=sk-...                               # only if your provider needs a key
npm start
```

On Windows PowerShell, set variables like this: `$env:CUSTOM_BASE_URL="https://..."`.
Instead of exporting, you can put the same lines (`export` is optional) in a `.env` file in
this folder; `npm start` and the plugin read it, and variables already set in your shell
win. A [config file](#config-file) holds the same settings and more.

The proxy prints where it listens and which providers are configured:

```
gpt-oss-proxy listening on http://127.0.0.1:8787/v1
config: none (built-in defaults + environment)
 * custom       https://your-provider.example/v1  model=openai/gpt-oss-20b  strategy=auto  window=32768  key=present
   siliconflow  not set up (set SILICONFLOW_API_KEY)
   openwebui    not set up (set OPENWEBUI_API_KEY)
logs: .../gpt-oss-opencode/logs (metadata only; GPT_OSS_LOG_CONTENT=1 adds content, kept 14 days)
```

Leave it running. **Is your provider one of the tested ones?** Use its preset instead of
`CUSTOM_*`:

| Provider | Set | OpenCode model |
|---|---|---|
| SiliconFlow (hosted) | `SILICONFLOW_API_KEY` | `gpt-oss/siliconflow` |
| OpenWebUI in front of Ollama | `OPENWEBUI_BASE_URL`, `OPENWEBUI_MODEL`, `OPENWEBUI_API_KEY`, and `OPENWEBUI_NUM_CTX` for the context ([server guide](#self-hosting-with-openwebui-and-ollama)) | `gpt-oss/openwebui` |

**2. Add the proxy to OpenCode.** Copy [`opencode/opencode.json`](opencode/opencode.json) to
`~/.config/opencode/opencode.json` (on Windows `%USERPROFILE%\.config\opencode\opencode.json`).
If you already have that file, merge the `provider` block into it; a project's own
`opencode.json` works as well.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "gpt-oss/custom",
  "small_model": "gpt-oss/custom",
  "provider": {
    "gpt-oss": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "GPT-OSS (gpt-oss-proxy)",
      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "unused-the-proxy-holds-the-provider-keys" },
      "models": {
        "custom":      { "name": "GPT-OSS (your provider)", "tool_call": true, "reasoning": true, "limit": { "context": 32768, "output": 8192 } },
        "siliconflow": { "name": "GPT-OSS via SiliconFlow", "tool_call": true, "reasoning": true, "limit": { "context": 131072, "output": 8192 }, "cost": { "input": 0.04, "output": 0.18 } },
        "openwebui":   { "name": "GPT-OSS via OpenWebUI", "tool_call": true, "reasoning": true, "limit": { "context": 32768, "output": 8192 } }
      }
    }
  }
}
```

- The model key (`custom`, `siliconflow`, `openwebui`) tells the proxy which provider to
  use. `"model"` sets the default and `"small_model"` the model for session titles; point
  both at the provider you use (with only OpenWebUI configured: `gpt-oss/openwebui`).
  Switch with `/models` in OpenCode or `-m` on the command line.
- `apiKey` is a placeholder: provider keys stay with the proxy, not OpenCode.
- `limit.context` is the model's window. Set it to your provider's real context length
  (and the same number in `CUSTOM_CONTEXT_WINDOW`). OpenCode then compacts long
  conversations before they overflow: once a reply's tokens reach `limit.context −
  limit.output`, or when the provider reports an overflow. The proxy reports the
  conversation's real size for this (internal retries and trimming don't distort it). 32768
  is a safe default; hosted providers often allow 131072. Without a `limit`, OpenCode never
  compacts on its own. With the plugin you don't need this block: it registers the
  provider with the proxy's own window.

Or use the plugin instead of both steps: add
`"plugin": ["file:///ABSOLUTE/PATH/TO/gpt-oss-opencode/opencode/plugin/gpt-oss-proxy.ts"]`
to OpenCode's config. OpenCode then starts the proxy (or reuses a running one) and
registers the provider, using the same environment variables, `.env` and config file as
`npm start`.

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
| Check the setup, or find out why it fails | `npm run doctor` (in the proxy folder) |
| Change the server, key, model or context | `npm run setup` again |

On Windows, a prompt that contains double quotes can be mangled on the command line; pipe it
in instead: `Get-Content task.txt | opencode run`.

### Getting good results

- **Name the files and the success check.** "Add X to `src/a.js`, add tests to
  `test/a.test.js`, and run `npm test`" works much better than "improve the stats module".
- **Ask for the tests to be run.** The model checks its work when asked, and the log shows
  whether it did.
- **Split big jobs** into steps, and continue the session with `-c` between them.
- **Review the diff** (`git diff`) before committing, as you would a junior developer's.

### Optional: the `repo_overview` tool

[`opencode/tool/repo_overview.ts`](opencode/tool/repo_overview.ts) is an OpenCode custom tool.
One call returns a depth-limited file tree with line counts, the manifest scripts, likely
entry points and the test command. Copy it to `~/.config/opencode/tool/` (or a project's
`.opencode/tool/`) to enable it. It helps with orientation questions, but in the full
evaluation it did not improve task success and used 58% more tokens, so it is off by default.

## How the agent works

```
you ──▶ OpenCode ──OpenAI API──▶ gpt-oss-proxy ──OpenAI API──▶ any GPT-OSS provider
          ▲  runs every tool          │                         (hosted API, own server,
          └──── validated tool calls ◀┘                          OpenWebUI, …)
               validate · repair · loop guard · retries · logs
```

| Part | Role |
|---|---|
| **OpenCode** | Hosts the agent: your conversation, the tools (read, glob, grep, edit, write, bash, …), permission prompts, session history and compaction. |
| **GPT-OSS** (20b or 120b) | Decides the next step: which tool to call with which arguments, or the final answer. Any provider can supply it. |
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
- **Knows your shell.** OpenCode's `bash` tool runs Windows PowerShell 5.1 on many Windows
  machines, where gpt-oss tends to write bash or cmd.exe commands (`&&`, `dir /s /b`, `grep`,
  `rm -rf`). The proxy reads the shell from OpenCode's tool description, adds one PowerShell
  rule to the model's instructions, and sends such a command back with the reason and a
  working form before it runs (up to 2 times per step; then it runs as written). Bash and
  PowerShell 7 are left alone.
- **Guards against loops.** An identical call with nothing changed since is answered with the
  earlier result instead of running again. A polling loop that already timed out is not run
  again with a longer timeout. Long failure streaks and runaway turns stop with an
  explanation.
- **Survives provider trouble.** Timeouts, 5xx errors and malformed responses are retried
  with backoff, and rate limits have their own budget. If a budget runs out, OpenCode shows
  a `[gpt-oss-proxy] …` message saying what failed and what to change.
- **Protects the context window.** Oversized histories are trimmed (oldest tool results
  first). A pasted document too large for the window is cut to its beginning and end, and
  OpenCode tells you to put it in a file instead. The proxy also warns when a server
  silently cut the conversation.
- **Keeps a diagnostic log** per session (see [Security, privacy and logs](#security-privacy-and-logs)).

The reasoning behind this design, with the measurements that drove it, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## LLM provider requirements

Any source of GPT-OSS works if it meets these requirements:

| Requirement | Why |
|---|---|
| Serves **gpt-oss-20b** or **gpt-oss-120b** | The proxy is built around these models' shared output format and habits. See [model sizes](#model-sizes-20b-and-120b) for what is verified for each. |
| **OpenAI-compatible Chat Completions API**: `POST <base URL>/chat/completions`, optionally with `Authorization: Bearer <key>` | This is the only API the proxy calls. |
| **Tool calls, in one of two ways:** native function calling (`tools` in, `tool_calls` out), **or** the model's raw text with its tool-call markers kept (harmony tokens such as `<\|channel\|>` and `<\|message\|>`) and the `stop` parameter honoured | Native providers use the `native` strategy. The others use `harmony` emulation. `auto` detects which applies. |
| **A context window of at least 32K tokens**, declared with the same value in OpenCode (`limit.context`) and the proxy (`<PROFILE>_CONTEXT_WINDOW`) | OpenCode's system prompt and tool definitions alone take 5–7K tokens. A server that silently cuts the conversation makes the model forget its task. |
| **Up to 8K output tokens per response**, or set `maxOutputTokens` to the provider's limit | File writes and edits are generated in a single response. |
| Streaming is **optional** | The proxy streams to OpenCode either way. Set `"stream": false` for a provider whose stream is broken. |

### Where the model can come from

| Source | Base URL (example) | Model id (example) | Key | Status |
|---|---|---|---|---|
| A hosted API that offers GPT-OSS | `https://<provider>/v1` | as the provider names it, often `openai/gpt-oss-20b` or `openai/gpt-oss-120b` | yes | **SiliconFlow tested** (preset `siliconflow`) |
| OpenWebUI in front of Ollama | `http://<server>:8080/api` | your OpenWebUI model id | yes | **software path tested** (preset `openwebui`, [guide](#self-hosting-with-openwebui-and-ollama)) |
| Ollama directly | `http://<server>:11434/v1` | `gpt-oss:20b` or `gpt-oss:120b` | no | untested; set Ollama's context length as in [step 1 of the guide](#step-1-serve-gpt-oss20b-with-ollama-and-a-large-enough-context) |
| Other OpenAI-compatible servers (vLLM, llama.cpp's `llama-server`, LM Studio, …) | `http://<server>:<port>/v1` | as the server names it | usually no | untested |

For any untested source, use the generic `custom` profile (`CUSTOM_BASE_URL`,
`CUSTOM_MODEL`, and `CUSTOM_API_KEY` if needed) and check it before relying on it.

### Model sizes: 20b and 120b

Both sizes share the chat format and tool-call conventions, so they have the same
integration problems, and the proxy solves them the same way for both. They differ in how
often the model itself makes mistakes, and in the hardware they need.

| | gpt-oss-20b | gpt-oss-120b |
|---|---|---|
| **Verified here** | Full live evaluation: runs of 16–19 scenarios with Git Bash and with Windows PowerShell 5.1, a Linux run, and the C++ task | Provider check, and an end-to-end tool round trip through the proxy (find files, read, edit, run the tests, answer). The full evaluation has not been run yet. |
| **Integration problems** (tool calling rejected by the provider, gateway payload losses, OpenCode prompt selection) | Present; solved by the proxy | The same. SiliconFlow rejects native tool calls for 120b just as for 20b, and the proxy's emulation works unchanged. |
| **Model mistakes** (malformed calls, mistyped paths, loops, misread specs) | Measured; see [What to expect](#what-to-expect) | Expected to be less frequent, since 120b is the stronger model; not measured yet. The proxy's guards apply either way. |
| **Self-hosting** | About 14 GB; a 16 GB GPU | About 65 GB; an 80 GB-class GPU |
| **How to select it** | The default model ids | `CUSTOM_MODEL=openai/gpt-oss-120b`, `SILICONFLOW_MODEL=openai/gpt-oss-120b`, or an OpenWebUI entry based on `gpt-oss:120b` |

The SiliconFlow preset's cost figures (`pricing` in the proxy, `cost` in `opencode.json`)
are 20b prices. When you use 120b, set its prices there so the cost reports are right.

### Checking a new provider

1. **One tool call:** `npm run setup -- --url <address>` (and `npm run doctor` later) sends a
   task through the proxy and shows whether the provider's native tool calls or the harmony
   emulation carried it.
2. **A full tool round trip:** with the `CUSTOM_*` variables set, run `npm run test:live`.
   It plays OpenCode's role against your provider, through the proxy, on a small task:
   read, edit, run the tests, answer.
3. **The live evaluation** (optional, about an hour on a rate-limited provider):
   `npm run eval -- --profile custom --concurrency 1` runs the 19 scenarios behind the
   numbers in the [validation report](docs/VALIDATION_REPORT.md).
4. **What the proxy saw:** `npm run report -- --latest` shows which strategy was used. A
   `strategy_fallback` entry means the provider refused native tools and harmony emulation
   took over.

If the provider refuses tools, set `CUSTOM_STRATEGY=harmony` to skip the detection. If its
streaming output looks corrupted, set `"stream": false` for its profile in the config file.
Those are exactly the two quirks the SiliconFlow preset handles.

## Self-hosting with OpenWebUI and Ollama

This chapter is one way to supply the model yourself: **Ollama** serves GPT-OSS on
your hardware, and **OpenWebUI** provides accounts, API keys and a model entry for
OpenCode. Plain Ollama or other servers can be used directly through the `custom` profile
([requirements](#llm-provider-requirements)); step 1 below applies to plain Ollama too.

The steps use gpt-oss-20b. **For gpt-oss-120b**, pull `gpt-oss:120b` instead (about
65 GB; it needs an 80 GB-class GPU), and use it wherever `gpt-oss:20b` appears below.
Everything else stays the same.

```
OpenCode ─▶ gpt-oss-proxy ─▶ OpenWebUI ─▶ Ollama ─▶ gpt-oss:20b
 (your machine)                (your server)
```

The settings below were verified against OpenWebUI 0.11.4 and Ollama 0.34.4. Menu names may
differ slightly in other versions.

**Someone else runs the server** (a company OpenWebUI, for example)? Then steps 1–4 are the
admin's job, and you only need its address and an API key: run `npm run setup` and choose
OpenWebUI ([step 5](#step-5-connect-the-proxy)). Setup requests the context window with
every call, so it works even if the server's own default is small.

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

On your machine, in the `gpt-oss-opencode` folder:

```bash
npm run setup -- --openwebui http://your-server:8080
```

Setup asks for the API key, lists the server's models for you to pick (`gpt-oss20b-opencode`
from step 3), and asks for the context window. It then checks a real tool call and connects
OpenCode (see [Quick setup](#quick-setup)).

**The context window.** By default the proxy sends the window you choose with every request
(Ollama's `num_ctx`), so the server uses it whatever its own default is. This goes through
OpenWebUI's `/api/chat/completions` route and needs no access to the server's settings. The
same number also goes to OpenCode, so it compacts in time. Choose 32768, or 65536 if the GPU
has the memory for longer sessions. Everyone who uses the server should choose the same
value: Ollama reloads the model when consecutive requests ask for different context sizes.

If you set the context on the server in step 1 and want the server to decide, run setup
with `--no-num-ctx` and give the server's value. The proxy then uses the direct
`/ollama/v1` route when the model is on an Ollama connection
([how the routes differ](#how-the-proxy-talks-to-openwebui)).

**Without setup**, set the same with environment variables (or put these lines in a `.env`
file in this folder) and run `npm start`:

```bash
export OPENWEBUI_BASE_URL=http://your-server:8080/api
export OPENWEBUI_MODEL=gpt-oss20b-opencode
export OPENWEBUI_API_KEY=sk-...
export OPENWEBUI_NUM_CTX=65536     # requested per request; also the proxy's window
npm start
```

Then select **GPT-OSS via OpenWebUI** in OpenCode (`/models`, or
`opencode run -m gpt-oss/openwebui "…"`), and give OpenCode the same window in
`opencode.json`: `"limit": { "context": 65536, "output": 8192 }` for the `openwebui` model.
With the plugin, OpenCode gets it from the proxy instead.

**Keep "gpt" out of the OpenCode model key.** The provided config uses `openwebui`.
OpenCode chooses its system prompt by model id: an id containing "gpt" gets a prompt that
requires an `apply_patch` tool, which OpenCode doesn't offer to "oss" models. The proxy maps
the neutral key to your real OpenWebUI model id.

### Step 6: Verify

1. **Setup and connection:** `npm run doctor` checks that the server is reachable, the key
   accepted and the model listed, and sends one real task through the proxy.
2. **A full tool round trip** (read, edit, run the tests, answer): `npm run test:live` with
   the `OPENWEBUI_*` variables set. Providers that aren't configured are skipped.
3. **Optional: the live evaluation** against your server, which takes about 30 minutes:
   `npm run eval -- --profile openwebui --concurrency 1`.

### How the proxy talks to OpenWebUI

When a context is requested (`numCtx`, which setup writes by default), the proxy uses route
`api`, the only one that carries it. Otherwise it asks `/api/models` who owns the model and
picks one of two routes. You can force one with `OPENWEBUI_ROUTE=ollama-v1` or
`OPENWEBUI_ROUTE=api`.

| Route | Used when | Behaviour |
|---|---|---|
| `ollama-v1` → `/ollama/v1/chat/completions` | the model is on an **Ollama connection** (`owned_by: "ollama"`) | OpenWebUI applies your model entry and passes requests to Ollama's own OpenAI API. Tool results keep their names, `max_tokens` and `reasoning_effort` work, and errors keep their message. The context length comes from the server (step 1). |
| `api` → `/api/chat/completions` | a context is requested (`numCtx`), the model is on an OpenAI-type connection, or the route is forced | Full OpenWebUI pipeline. On an Ollama connection it drops `max_tokens`, `temperature`, `reasoning_effort` and the names of tool results. The proxy compensates: it sends `options.num_predict`, labels tool results (`[read result]`), and sends `options.num_ctx` (`numCtx`, `OPENWEBUI_NUM_CTX`). It also recognises Ollama errors that arrive disguised as an empty answer, and retries them. |

The default strategy for OpenWebUI is native tool calling. If the backend answers "tools not
supported", the proxy switches to emulated tool calls and remembers that.

### Troubleshooting

`npm run doctor` finds most of these and says what to do.

| Symptom | Cause | Fix |
|---|---|---|
| "API keys are switched off on this OpenWebUI server" (HTTP 403 "Use of API key is not enabled") | API keys are off | Step 2 |
| "The server rejected the API key" (HTTP 401) | wrong or revoked key | create a new key (step 4) and run `npm run setup` again. A key in `OPENWEBUI_API_KEY` overrides the saved `openwebui.key` |
| HTTP 400 "Model not found" | the id differs from `/api/models`, or the list is stale | run `npm run setup` and pick the model from the list; reload OpenWebUI after creating a model |
| The model "forgets" the task, stops using tools, or OpenCode shows `[gpt-oss-proxy] the model server evaluated only N of ~M prompt tokens` | the server's context is smaller than the proxy's window, so Ollama cut the conversation | run `npm run setup` without `--no-num-ctx` (the window is then requested per request), or step 1 |
| The first answer takes very long | Ollama is loading the model into memory, or part of the model runs on the CPU | wait for the first load; check GPU memory |
| Answers on a shared server are often slow to start | requests with different context sizes alternate (other users, the OpenWebUI chat), and Ollama reloads the model each time | everyone uses the same `--context`; an admin can make it the server default too |
| Settings you saved with setup seem ignored | `OPENWEBUI_*` variables in your shell or `.env` override the config file | `npm run doctor` lists them; remove them |
| `npm run report -- --latest` shows `strategy_fallback` | the backend refused native tool calls | nothing to do; emulated tool calls are used automatically |

## Configuration reference

### Provider profiles

Each provider is a profile. OpenCode selects it through the model key (`gpt-oss/<profile>`),
so several providers can be configured at once and you switch in OpenCode.

| Profile | For | Defaults |
|---|---|---|
| `custom` (default) | any OpenAI-compatible provider serving GPT-OSS | no address until `CUSTOM_BASE_URL` is set; model `openai/gpt-oss-20b` (set `CUSTOM_MODEL` for 120b); key `CUSTOM_API_KEY` (optional); strategy `auto`; streaming; window 32768 |
| `siliconflow` (preset) | SiliconFlow | `https://api.siliconflow.com/v1`, model `openai/gpt-oss-20b`, key `SILICONFLOW_API_KEY`; strategy `harmony` and no streaming, because SiliconFlow rejects native tools for this model and corrupts streamed output; window 131072 |
| `openwebui` (preset) | OpenWebUI in front of Ollama | `http://localhost:8080/api`, model `gpt-oss20b-opencode`, key `OPENWEBUI_API_KEY`; strategy `auto`; route selection and payload fixes for OpenWebUI; window 32768 |

To use **several custom providers**, add named profiles to the config file (see below).
Each gets its own `<NAME>_*` variables and OpenCode model key `gpt-oss/<name>`.

**Where settings come from**, later wins: built-in defaults, then the config file
(`gpt-oss-proxy.config.json`, which `npm run setup` writes), then environment variables. A
`.env` file in the proxy folder counts as environment variables, but ones already set in
your shell win over it. `npm start` prints the config file and `.env` in use, and
`npm run doctor` also lists the variables that override the file. A preset counts as set up
once it has a key or an address of your own; until then its OpenCode model answers with how
to set it up.

### Environment variables

| Variable | Effect |
|---|---|
| `CUSTOM_BASE_URL`, `CUSTOM_MODEL`, `CUSTOM_API_KEY` | the generic provider: address, model id, key (optional) |
| `<PROFILE>_BASE_URL`, `<PROFILE>_MODEL`, `<PROFILE>_STRATEGY` | override any profile, e.g. `OPENWEBUI_BASE_URL=http://gpu-box:8080/api`, `CUSTOM_STRATEGY=harmony` |
| `<PROFILE>_CONTEXT_WINDOW` | the provider's real context length in tokens, e.g. `CUSTOM_CONTEXT_WINDOW=131072` |
| `SILICONFLOW_API_KEY`, `OPENWEBUI_API_KEY` | keys for the presets |
| `OPENWEBUI_NUM_CTX` | context requested from the server with every request (Ollama `num_ctx`). Selects route `api` and is also the window, unless `OPENWEBUI_CONTEXT_WINDOW` is set |
| `OPENWEBUI_ROUTE` | force the OpenWebUI route: `auto`, `ollama-v1`, `api` |
| `GPT_OSS_PORT`, `GPT_OSS_HOST` | listen address (default `127.0.0.1:8787`) |
| `GPT_OSS_PROXY_TOKEN` | require `Authorization: Bearer <token>` from clients (put the same value in OpenCode's `apiKey`). **Required** for any address other than localhost; see [Security](#security-privacy-and-logs) |
| `GPT_OSS_PROFILE` | profile used when OpenCode sends a model id that matches no profile (default `custom`) |
| `GPT_OSS_STRATEGY` | force a strategy for all profiles: `harmony`, `native`, `json`, `auto` |
| `GPT_OSS_CONFIG` | config file path (default `./gpt-oss-proxy.config.json` if present; for the plugin, in the proxy folder). `npm run setup` writes to it too, with the key files next to it |
| `GPT_OSS_LOG_DIR` | log directory (default `./logs`) |
| `GPT_OSS_LOG_CONTENT=1` | also log prompts, model output, tool-call values and result previews |
| `GPT_OSS_LOG_RETENTION_DAYS` | delete log days older than this (default `14`; `0` keeps everything) |
| `GPT_OSS_DUMP_REQUESTS=1` | also save every upstream request body for exact replays (`scripts/replay.ts`) |

### Config file

`npm run setup` writes `gpt-oss-proxy.config.json` for you, for example:

```json
{
  "defaultProfile": "openwebui",
  "profiles": {
    "openwebui": { "baseURL": "http://gpu-server:8080/api", "model": "gpt-oss20b-opencode", "numCtx": 65536, "apiKeyFile": "openwebui.key" }
  }
}
```

To write one by hand, start from
[`gpt-oss-proxy.config.example.json`](gpt-oss-proxy.config.example.json). Setup keeps
what it doesn't manage (other profiles, `limits`, `extraBody`, …) when it runs again.
Profiles you add start from the neutral `custom` defaults. Each profile accepts:

| Option | Meaning |
|---|---|
| `baseURL`, `model` | where the provider is and which model to request |
| `apiKeyEnv` or `apiKeyFile` | where the key comes from: an environment variable, or a one-line file such as `"apiKeyFile": "key.txt"` |
| `strategy`, `fallbackStrategy` | tool-call strategy (see below) |
| `contextWindow`, `maxOutputTokens` | the provider's limits |
| `numCtx` | OpenWebUI: the context to request with every request; also `contextWindow` unless that is set (see [how the proxy talks to OpenWebUI](#how-the-proxy-talks-to-openwebui)) |
| `openwebuiRoute` | OpenWebUI: `auto` (default), `api` or `ollama-v1` |
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
  never logged. OpenCode only holds a placeholder, or the proxy token. `npm run setup` saves
  the key in its own file (`<provider>.key`, mode 600 on Linux and macOS), never in the
  config file, and both are git-ignored.
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

The proxy makes GPT-OSS's tool use reliable; it cannot make the model smarter. The numbers
below were measured with **gpt-oss-20b** on SiliconFlow. The model is the same with every
provider, so task quality should carry over, while speed depends on your provider.
gpt-oss-120b is the stronger model, so expect fewer of the mistakes listed here, but that
has not been measured yet. Full results are in the
[validation report](docs/VALIDATION_REPORT.md).

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
- **Tested providers:** SiliconFlow (gpt-oss-20b fully; gpt-oss-120b end to end), and
  OpenWebUI + Ollama with a small stand-in model. GPT-OSS behind OpenWebUI, and all other
  providers, are not verified yet: check them as described in
  [Checking a new provider](#checking-a-new-provider).
- **Tested platforms:** Windows 11, with OpenCode running commands in Git Bash and in Windows
  PowerShell 5.1, and Linux (Ubuntu under WSL2); macOS and PowerShell 7 are untested.

## Development

```bash
npm test                 # 168 unit and contract tests; offline, uses the same AI SDK package as OpenCode
npm run typecheck        # tsc --noEmit (TypeScript runs natively on Node; no build step)
npm run test:live        # a real tool round trip for each configured provider (small cost)
npm run eval -- --profile custom --concurrency 1    # live evaluation: real OpenCode + proxy + your provider, 19 scenarios
npm run eval -- --only feature-median --repeat 3    # selected scenarios, repeated (default profile: siliconflow)
npm run eval -- --shell powershell --concurrency 1  # OpenCode's shell: bash (Git Bash), powershell (Windows PowerShell 5.1) or pwsh
npm run recheck -- .eval-runs/<run>                 # re-judge a saved run with the current checks
```

The live evaluation runs real OpenCode on copies of the synthetic repositories in
`eval/fixtures/` and judges each scenario with deterministic checks: hidden tests, repository
state and the executed tool calls. Results are written to `.eval-runs/<run>/`. It needs the
OpenCode CLI (set `OPENCODE_BIN` to use a specific binary) and a configured provider
(`--profile` picks it; the default, `siliconflow`, is the reference used in the validation
report). The `cpp-evaluator` scenario also needs a C++ compiler (g++, clang++ or MSVC), and
`deps-install-hangs` and `large-data-converter` need Python 3. `--shell powershell` runs
OpenCode with Windows PowerShell 5.1 and the PATH of a plain Windows machine.

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
