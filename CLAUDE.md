# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gpt-oss-opencode`: an OpenAI-compatible proxy that lets GPT-OSS (gpt-oss-20b, fully evaluated; gpt-oss-120b, tool round trip verified) act as OpenCode's
tool-calling agent model, with the model supplied by any OpenAI-compatible provider that serves
it (generic `custom` profile; tested presets: SiliconFlow via harmony emulation, OpenWebUI via native tools
with fallback). OpenCode stays the tool executor; the proxy never touches repositories.
Design and measurements: `docs/ARCHITECTURE.md`; test results: `docs/VALIDATION_REPORT.md`.

## Commands

- `npm start` — run the proxy (`http://127.0.0.1:8787/v1`); point it at a provider with `CUSTOM_BASE_URL` (+ `CUSTOM_MODEL`, `CUSTOM_API_KEY`), or use a preset (`SILICONFLOW_API_KEY`, `OPENWEBUI_*`).
- `npm test` — unit + contract tests (offline; mock provider + the AI SDK package OpenCode uses).
- `npm run test:live` — live provider tests, one per configured provider (`CUSTOM_BASE_URL`, `SILICONFLOW_API_KEY`, `OPENWEBUI_API_KEY`); small cost.
- `npm run typecheck` — `tsc --noEmit` (TypeScript runs natively on Node ≥ 22.18 via type stripping; no build step).
- `npm run eval -- [--only a,b] [--repeat N] [--concurrency 1] [--strategy harmony|json|native|auto] [--descriptions compact|full] [--extra-tools]` — live OpenCode evaluation; results in `.eval-runs/<run>/`.
- `npm run recheck -- .eval-runs/<run>` — re-apply current checks to a saved eval run (no model calls).
- `npm run compare -- .eval-runs/<a> .eval-runs/<b> [--only ids]` — compare runs on common scenarios with current checks.
- `node scripts/owui-local-stack.mjs up|status|down` — real local OpenWebUI + Ollama stack in `.local-stack/` (small stand-in model).
- `npm run report -- --latest | --session ID | <dir>` — session timeline + abnormality flags from proxy logs.

## Layout

`src/` proxy (server → agent orchestration → strategy adapters → upstream client; harmony
parser, validation/schema, guard, context guard, emitter, logging), `bin/` CLIs, `test/`
offline tests (+ `test/live/`), `eval/` harness + scenarios + `fixtures/` synthetic repos
(copied to `.eval-runs/` per run — never run agents inside the source tree) + `hidden/`
acceptance tests the agent never sees (`cpp-evaluator` compiles one via `eval/lib/cxx.ts`:
g++/clang++/MSVC through vswhere), `opencode/` config example, optional plugin and optional custom tool, `scripts/` provider probes.

## Conventions

- Code must run unbuilt on Node: only erasable TypeScript (no enums/namespaces/parameter properties), `.ts` import extensions, `import type` for types.
- No runtime dependencies in `src/`.
- Evals are rate-limited by SiliconFlow TPM; prefer `--concurrency 1`. If `SILICONFLOW_API_KEY` is not set, export it from `key.txt` for the command without printing it.
- When scripting `opencode run` on Windows: pass the prompt via stdin (argv mangles quotes), and set `--dir` + `PWD` (OpenCode trusts an inherited `PWD`).

## Secrets

- `key.txt` holds a plaintext API key (single line, `sk-` prefix, OpenAI-style format). Do not print, echo, `cat`, or log its contents, and do not copy the value into source files. Code should read it at runtime from the file or from an environment variable (a profile can use `"apiKeyFile": "key.txt"`).
- `key.txt` is in `.gitignore`; keep it there.
