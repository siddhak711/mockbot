# OpenCode as mockbot's coding sub-agent

- Spike only. No application code. OpenCode is viable for a later `code_task` tool if the wrapper owns the caps, the secrets, and the sandbox.
- mini-swe-agent was not evaluated. Headless run, server mode, an OpenAI-compatible provider, ACP, and MCP all worked on OpenCode 1.19.4. The gaps are in caps and in trust of repo files, and the wrapper can close them.
- No OpenRouter key was available. Provider calls were checked against a local OpenAI-compatible server. A separate no-key run against OpenCode's own free model is recorded below.

## Install

- Binary: GitHub release `v1.19.4` of `anomalyco/opencode`, asset `opencode-linux-x64.tar.gz`. `opencode --version` prints `1.19.4`.
- License at tag `v1.19.4` is MIT, copyright 2025 opencode.
- OpenCode 2 is a different npm package (`@opencode/cli`) and was not installed. The GitHub latest release on 2026-10-24 was still 1.19.4. Pin that release. The v2 config key is `providers`, not `provider`.
- Reproduce with `OPENCODE_BIN=/path/to/opencode scripts/spikes/run_opencode_spike.sh`.

## 1. Headless `opencode run`

- Non-interactive. `opencode run "Reply with exactly OK-FROM-MOCK"` prints the assistant text and returns. No TTY required.
- Without `--pure`, stdout is a status line `> build · deepseek/deepseek-v4.1-flash` and then the assistant text. Exit 0. This showed up both in a TTY and when stdout was not a TTY.
- With `--pure`, stdout is only the assistant text: `OK-FROM-MOCK` and a newline. Exit 0.
- `--format json` prints one JSON object per line. A successful text reply is `step_start`, `text`, `step_finish`. `text` carries `part.text`. `step_finish` carries `part.reason` (`stop` or `tool-calls`) and `part.tokens` (`input`, `output`, `reasoning`, `cache`).
- Tool calls are `tool_use` events with `part.tool` and `part.state`. A bash call from the mock wrote `spike-out.txt` containing `spike-bash`.
- `--continue` / `-c` resumes the last session and sends prior messages (observed `n_messages` 4 on the second turn). `--session` with an unknown id exits 1 and prints `Session not found`.
- Missing message: exit 1, stderr `You must provide a message or a command`.
- Unknown model `nope/no-such-model`: exit 1. Stderr without logs is a generic `UnknownError`. `--print-logs` shows `ProviderModelNotFoundError: Model not found: nope/no-such-model`.
- Provider HTTP 401: exit 1. Stdout (json format) is `{"type":"error",... "name":"APIError", "statusCode":401}`. Stderr is empty unless `--print-logs`.
- Denied tools do not fail the process. Exit stays 0. `bash`, `edit`, `write`, and `webfetch` set to `deny` were removed from the tool list; `read` remained.
- `bash` set to `ask` is auto-rejected in headless mode. Stderr: `permission requested: bash (...); auto-rejecting`. The tool part is `status: error` with `The user rejected permission to use this specific tool call.` Exit 0. It does not prompt and it does not hang.
- With no provider configured, `opencode run "Reply with exactly the single word PONG"` exited 0 and printed `PONG`. The stored model was `opencode/big-pickle` (free OpenCode model, not OpenRouter).

## 2. Server mode

- `opencode serve --hostname 127.0.0.1 --port 14096`. The CLI default for `--port` is `0` (random), not 4096.
- `OPENCODE_SERVER_PASSWORD` turns on HTTP basic auth. Username defaults to `opencode` (`OPENCODE_SERVER_USERNAME` overrides).
- `GET /global/health` without credentials: 401, `WWW-Authenticate: Basic`.
- With credentials: `{"healthy":true,"version":"1.19.4"}`.
- `GET /doc` is the OpenAPI 3.1 document (`info.title` `opencode`), not HTML.
- `POST /session?directory=<abs>` then `POST /session/{id}/message?directory=<abs>` with `{"parts":[{"type":"text","text":"http-ping"}]}` returns the assistant message. Parts included `text` `OK-FROM-MOCK`. This is the reliable programmatic API.
- `opencode run --attach http://127.0.0.1:14096` does create a server session and the server stores the assistant text, but the client stdout was empty (0 bytes). Do not use `--attach` to collect the result.

## 3. Provider config (OpenRouter shape, local mock)

- Catalog model id, from `opencode models --refresh`: `openrouter/deepseek/deepseek-v4.1-flash`.
- Catalog provider `openrouter`: env `OPENROUTER_API_KEY`, npm `@openrouter/ai-sdk-provider`, API `https://openrouter.ai/api/v1`. That stock package was not used. The verified path pins npm to `@ai-sdk/openai-compatible` so the body is `POST /v1/chat/completions`.
- Config that worked, with `{env:NAME}` substitution (`opencode debug config` shows the substituted URL and redacts the key as `***`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "{env:MODEL}",
  "small_model": "{env:MODEL}",
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter via env",
      "options": {
        "baseURL": "{env:BASE_URL}",
        "apiKey": "{env:API_KEY}"
      },
      "models": {
        "deepseek/deepseek-v4.1-flash": {
          "name": "DeepSeek V4.1 Flash",
          "tool_call": true,
          "limit": { "context": 16000, "output": 128 }
        }
      }
    }
  },
  "agent": {
    "title": { "model": "{env:MODEL}" },
    "summary": { "model": "{env:MODEL}" }
  }
}
```

- `MODEL=openrouter/deepseek/deepseek-v4.1-flash`, `BASE_URL=http://127.0.0.1:<port>/v1`, `API_KEY=spike-key`.
- The mock logged `POST /v1/chat/completions`, `Authorization: Bearer spike-key`, body model `deepseek/deepseek-v4.1-flash`, `stream: true`.
- Escalation is the same env and the same base URL. `MODEL=openrouter/anthropic/claude-opus-4.8` sent body model `anthropic/claude-opus-4.8`. The wrapper must pass the `openrouter/<vendor>/<model>` id. A bare `deepseek/...` id would be read as provider `deepseek`.
- Pin `small_model` and the `title` and `summary` agents to `MODEL`. Before that pin, the title call used a different catalog model (`google/gemini-nano-banana-2.1`) and `max_tokens` 32000 against the same base URL.
- Empty `API_KEY` omits `Authorization` and still exits 0 if the server allows it. Fail closed in the wrapper, not in OpenCode.
- A repo `opencode.json` overrides `OPENCODE_CONFIG` (it is loaded later). A project file that set `baseURL` to another local port was the URL in the 401 error. `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps the trusted base URL. `OPENCODE_CONFIG_CONTENT` overrides conflicting keys but still merges project `mcp` entries, so it is not sufficient.

## 4. ACP and MCP

- ACP: `opencode acp` speaks newline-delimited JSON-RPC on stdin/stdout. `initialize` with `protocolVersion: 1` returns `protocolVersion: 1`, `agentInfo` OpenCode 1.19.4, `mcpCapabilities` `{http: true, sse: true}`, `promptCapabilities` embedded context and image, `sessionCapabilities` `close`, `fork`, `list`, `resume`.
- `session/new` with an absolute `cwd` returns `sessionId`. `session/prompt` streams `session/update` `agent_message_chunk` (`OK-FROM-MOCK`) and finishes with `stopReason: end_turn`.
- Per-step approval works on ACP when a permission is `ask`. The agent emits `session/request_permission` with options `once` (`allow_once`), `always` (`allow_always`), and `reject` (`reject_once`). Replying `{"outcome":{"outcome":"selected","optionId":"once"}}` let the bash call complete and write `spike-out.txt`.
- MCP client: config

```json
{
  "mcp": {
    "spike": {
      "type": "local",
      "command": ["python3", "scripts/spikes/mcp_stdio_server.py"],
      "enabled": true
    }
  }
}
```

- OpenCode's client sends newline-delimited JSON, not Content-Length frames. `initialize` uses protocol `2025-11-25`. `opencode mcp list` printed `spike` as connected. On the next run the model tool list contained `spike_spike_ping` (server name, underscore, tool name).
- OpenCode does not expose an MCP server. `code_task` is mockbot's tool. It shells out to `opencode run` or to the HTTP message API.

## 5. Caps

- There is no `opencode run` flag for a wall clock, a step budget, or a session token budget.
- Output tokens, per request: model `limit.output` is sent as `max_tokens` (observed 128). `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=64` forces `max_tokens` 64 even when `limit.output` is 128. That is a per-call cap, not a session budget. Sum `step_finish` tokens in the wrapper and kill the process to enforce a budget.
- `options.timeout: 1000` did not abort a response delayed by 3 seconds.
- `options.headerTimeout: 400` aborts one HTTP call with `ProviderHeaderTimeoutError` and OpenCode retries. A run was still going after 40 seconds. Not a run deadline.
- `agent.build.steps: 2` injects `CRITICAL - MAXIMUM STEPS REACHED` and says tools are disabled. The following requests still included the tool list. The script observed 5 tool calls and 5 warned requests that still offered tools. Not a security boundary.
- Wall clock that does stop the process: `timeout -k 1 <seconds> opencode run`. Exit 124. Use `--kill-after`, because a permission wait can ignore the first TERM.
- `opencode stats` reads the local sqlite database. It is not a cap.

## `code_task` flow

```mermaid
sequenceDiagram
  participant User
  participant Bot as mockbot
  participant Box as sandbox
  participant OC as opencode run
  participant LLM as BASE_URL

  User->>Bot: code_task(repo, instruction)
  Bot->>Box: create sandbox, clone with a read-only short-lived token
  Bot->>Box: drop the token from the git remote
  Bot->>OC: opencode run --format json, caps, project config disabled
  OC->>LLM: POST /v1/chat/completions
  LLM-->>OC: tool calls and text
  OC->>Box: edit files, run tests
  OC-->>Bot: JSON events and exit code
  Bot->>Box: git diff and test output
  Bot-->>User: diff, tests, summary
  User->>Bot: approve push
  Bot->>Box: inject a new single-repo token, push, open PR
  Bot->>Box: destroy sandbox
```

## Proposed interface

- Tool name: `code_task`.
- Inputs:
  - `repo` (git URL)
  - `instruction` (string)
  - `session_id` (optional, resume)
  - `model` (optional, default `openrouter/deepseek/deepseek-v4.1-flash`)
  - `base_url` (optional, default `https://openrouter.ai/api/v1`)
  - `limits.wall_seconds`, `limits.max_steps`, `limits.max_output_tokens`
  - `test_command` (optional string)
- The API key is not a tool argument. The supervisor holds it.
- `push` is not an argument of this call. Push and PR are a second, explicit approval.
- Outputs:
  - `status`: `ok`, `provider_error`, `model_not_found`, `timed_out`, `step_limit`, `test_failed`, `sandbox_error`
  - `summary` (assistant text)
  - `diff` (unified diff, even when tests fail)
  - `tests`: `{command, exit_code, output}`
  - `session_id`
  - `usage`: `{input_tokens, output_tokens}`
  - `branch` and `pr_url` only after an approved push
- Errors the wrapper should surface, not swallow:
  - exit 1 and `ProviderModelNotFoundError` (needs `--print-logs`)
  - exit 1 and JSON `APIError` (401 and other provider failures)
  - exit 1 and `Session not found`
  - exit 124 from `timeout` (`timed_out`)
  - wrapper kill after `max_steps` tool events (`step_limit`)
  - missing instruction before the sandbox is created
- OpenCode exit 0 does not mean the tools were allowed or that tests passed. Read the events and the test exit code.

## Safety

- Short-lived GitHub token, one repo, contents read for clone. Remove it from the remote URL after clone (`git remote set-url` with no credentials).
- A second token, still one repo, is injected only after the user approves push, then dropped. No token sits in the sandbox during the agent run.
- The OpenRouter key stays on the supervisor. Prefer a proxy as `BASE_URL` so the sandbox never sees the provider key. If the key is in the sandbox, it is process env for that run, not a file, and egress cannot carry it out.
- Egress from the sandbox is an allowlist: the model proxy, the git host for clone, and whatever test-time registries the repo needs. Default deny.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` on every OpenCode process. A cloned `opencode.json` can replace `baseURL` and the model.
- Quarantine `.opencode/` before every OpenCode process (rename it out of the tree). `--pure`, `OPENCODE_PURE=1`, and `OPENCODE_DISABLE_PROJECT_CONFIG=1` did not stop `.opencode/plugins/*.js` from executing at startup. A plugin in the tree wrote a marker file. Restoring the directory, or starting a new process after the agent writes one, runs it.
- Treat README, issues, dependency text, and `AGENTS.md` as untrusted data. OpenCode loads `AGENTS.md` as instructions. The sandbox boundary is what stops a prompt from exfiltrating a token, not the model.
- Headless denies `question`, `plan_enter`, and `plan_exit`. `doom_loop`, `external_directory`, and `*.env` reads are `ask` by default. Headless auto-rejects `ask` (observed for `bash`) and continues, exit 0. Set an explicit permission list anyway: allow repo read/edit/bash, deny `webfetch` unless the allowlist needs it, deny `.env`.
- Do not pass `--auto` unless every dangerous permission is an explicit deny. `--auto` approves anything that is not denied.
- `opencode debug config` redacts `apiKey`, but the process environment still has it. Do not log the environment.

## Roadmap

- Milestone 1 is the chat turn and the OpenAI-compatible provider (`LLM_BASE_URL`, `LLM_API_KEY`). This spike does not implement that. The same env idea (`BASE_URL`, `API_KEY`, `MODEL`) is how the wrapper should point OpenCode at a provider. OpenCode does not read the milestone 1 names itself.
- `code_task` needs milestone 2. That milestone is the MCP client and the tool loop. `code_task` is one tool on that loop. The transcript should show the instruction, the diff, and the test result the same way it shows any other tool call.
- `code_task` needs milestone 4. That milestone is a computer that is not the host, with list/read/write/exec and a time limit that kills the command. OpenCode runs inside that computer. The Next.js process does not shell out on the host. Daytona is a candidate for the real runtime (create, clone, destroy). The milestone 4 tests can keep using the local stand-in runtime from the roadmap.
- Milestone 6 (delegate to another agent) is a later place for a coding agent with its own memory and computer. It is not required for the first `code_task`.

## Later options

- ACP streaming with per-step approval. `opencode acp` already emits `session/request_permission` and waits. The client replies `once`, `always`, or `reject`. Use this when a person is watching. Headless `code_task` keeps the explicit deny list and the wall-clock kill instead.
- Best of three. Start three sandboxes with the same repo and instruction, run the same caps, keep the sandbox whose tests pass, and delete the other diffs. If more than one passes, keep the smallest diff. If none pass, return all three summaries and no push.

## Scripts

- `scripts/spikes/mock_openai_server.py` — local `/v1/chat/completions`.
- `scripts/spikes/mcp_stdio_server.py` — newline-delimited MCP server with tool `spike_ping`.
- `scripts/spikes/acp_smoke.py` — ACP initialize, prompt, and optional permission approval.
- `scripts/spikes/run_opencode_spike.sh` — the checks in this note.
- `scripts/spikes/demo_headless.sh` — short TTY demo of `opencode run`.

## Command log

- Command: `OPENCODE_BIN=/tmp/opencode-install/opencode scripts/spikes/run_opencode_spike.sh`
- Exit code: 0

```text
## version
1.19.4

## missing message
OK missing-message-exit = 1
OK missing-message text

## model catalog contains the OpenRouter id
OK catalog openrouter/deepseek/deepseek-v4.1-flash

## unknown model
OK unknown-model-exit = 1
OK ProviderModelNotFoundError in logs

## env substitution redacts the key
OK debug config substituted BASE_URL and redacted API_KEY

## headless text run
OK text-exit = 0
OK text-stdout = OK-FROM-MOCK
OK request model deepseek/deepseek-v4.1-flash auth=true max_tokens=64 tools include bash

## json events
OK json-exit = 0
OK json events step_start,text,step_finish

## continue last session
OK continue-exit = 0
OK continue sent history n_messages 4

## escalate MODEL
OK escalate-exit = 0
OK escalated request model anthropic/claude-opus-4.8

## empty API_KEY is not fail-closed
OK empty-key-exit = 0
OK empty API_KEY omitted Authorization

## provider 401
OK 401-exit = 1
OK json error APIError status 401

## project opencode.json is ignored only when disabled
OK evil-config-exit = 1
OK repo opencode.json overrode baseURL
OK disable-project-exit = 0
OK OPENCODE_DISABLE_PROJECT_CONFIG=1 kept the trusted base URL

## project plugins still execute when project config is disabled
OK plugin-still-runs = yes
OK plugin-absent = no

## steps is a prompt, not a hard stop
OK steps-exit = 0
OK steps=2 still executed 5 tools; warned requests with tools still offered: 5
OK bash wrote spike-out.txt

## denied tools are omitted and the run still exits 0
OK deny-exit = 0
OK denied tools omitted: ['glob', 'grep', 'read', 'skill', 'task', 'todowrite']

## headless ask is auto-rejected
OK ask-exit = 0
OK ask auto-rejected on stderr
OK bash ask stored as a rejected tool call

## headerTimeout retries until the outer timeout
OK header-timeout-exit = 124
OK ProviderHeaderTimeoutError

## GNU timeout is the wall-clock cap
OK gnu-timeout-exit = 124

## server basic auth and synchronous message
OK server-unauth = 401
OK server-health = {"healthy":true,"version":"1.19.4"}
OK POST /session/{id}/message returned OK-FROM-MOCK
OK attach-stdout-bytes = 0
OK attach created a session (16 -> 17) but printed no stdout

## mcp client
OK mcp list connected
OK model tool list contains spike_spike_ping

## acp text and per-step approval
acp initialize protocolVersion=1 agent OpenCode 1.19.4
acp mcpCapabilities http=true sse=true
acp sessionCapabilities close, fork, list, resume
acp chunk OK-FROM-MOCK
acp stop end_turn
acp permission options once, always, reject
acp tool completed
acp chunk DONE-AFTER-TOOLS
acp stop end_turn
OK approved bash wrote spike-out.txt

## summary
ALL CHECKS PASSED
```
