# Mockbot

Mockbot is a personal agent workspace. Milestone 1 is a single chat agent: start a conversation, watch the full reply stream, and come back to the same transcript. The transcript keeps the start token, reasoning, tool calls, the answer, and the finish reason.

The later milestones are in [docs/ROADMAP.md](docs/ROADMAP.md).

## Install

Requires Node.js 22 or newer.

```bash
npm install
```

## Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). With no API key, chat uses the built-in mock provider. Each mock turn streams a start token, a short reasoning trace, the answer, and an end token (`finish stop`). The live mock does not invent a tool call. Tool-call cards still render when a stream includes them. Conversations are stored in embedded Postgres (PGlite) under `.data/pglite`. A refresh restores the conversation list, titles, and every streamed phase. The token-by-token animation is live only. Stopping a turn keeps the partial reasoning and answer that have already been saved.

`npm run build` then `npm start` runs the production server.

## Switch providers

The browser only talks to Mockbot. `LLM_API_KEY` is read on the server and is never sent to the page.

Mock provider (the default):

```bash
npm run dev
```

`LLM_PROVIDER` can be omitted or set to `mock`. Leave `LLM_API_KEY` unset.

OpenAI-compatible provider:

```bash
LLM_PROVIDER=openai \
LLM_API_KEY=sk-... \
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_MODEL=gpt-4o-mini \
npm run dev
```

`LLM_BASE_URL` defaults to `https://api.openai.com/v1`. `LLM_MODEL` defaults to `gpt-4o-mini`.

OpenRouter uses the same provider. Point the base URL at OpenRouter and pick a model id:

```bash
LLM_PROVIDER=openai \
LLM_API_KEY=sk-or-... \
LLM_BASE_URL=https://openrouter.ai/api/v1 \
LLM_MODEL=deepseek/deepseek-v4.1-flash \
npm run dev
```

You can put the same variables in `.env.local`. Names are listed in `.env.example`.

## Sandbox

Each agent has one computer. Milestone 1 has a single implicit agent, so every conversation shares that computer. The browser only talks to Mockbot. `DAYTONA_API_KEY` stays on the server.

With no key, the computer is an in-process mock. It can list, read, write, and run a small set of commands (`echo`, `cat`, `ls`, `pwd`, `sleep`, `printenv`). It does not read the host filesystem and it does not start a host shell. Ask the mock model to create a file and print it:

> Create a file named hello.txt that says hello from the sandbox, read it back, and run a command that prints it.

The Computer pane shows the command, the output, the exit code, and changed files. A command that runs longer than `SANDBOX_COMMAND_TIMEOUT_MS` (default 10 seconds) is killed and stored as a failed run.

Daytona is used when a key is set. The same tools run inside a Daytona sandbox, one sandbox per agent. The sandbox id is reused on the next command. Host environment variables are not copied into it.

```bash
DAYTONA_API_KEY=dtn_...
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_TARGET=us
SANDBOX_COMMAND_TIMEOUT_MS=10000
npm run dev
```

`DAYTONA_API_URL` defaults to the SDK's Daytona cloud URL. `DAYTONA_TARGET` is the region, when you set one. Computer records and the mock workspace are stored in embedded Postgres under `.data/sandbox`.

A live model does not call these tools until the tool registry from milestone 2 is registered. The definitions in `src/sandbox/tools.ts` match that registry.

## API

- `POST /api/chat` with `{ "message": "...", "conversationId": "optional" }` streams server-sent events:
  - `meta` — `{ "conversationId", "title", "userMessageId" }`
  - `start` — `{ "role": "assistant" }` when the model turn starts
  - `reasoning` — `{ "text" }` reasoning or thinking delta
  - `tool_call` — `{ "index", "id?", "name?", "arguments?" }` tool-call delta
  - `tool_result` — `{ "id", "name", "content" }` when the provider emits a tool result
  - `delta` — `{ "text" }` answer text delta
  - `end` — `{ "finishReason" }` such as `stop`, `length`, or `tool_calls`
  - `done` — `{ "conversationId", "assistantMessageId" }` after the turn is saved
  - `error` — `{ "message" }`

  The OpenAI-compatible provider forwards those phases from a chat-completions stream when the upstream chunk includes them: `delta.role`, `delta.content`, `delta.reasoning` / `reasoning_content` / `thinking`, `delta.tool_calls` (and legacy `function_call`), `delta.refusal`, and `finish_reason`. `data: [DONE]` becomes an end token when the upstream never sent a finish reason. Each stored assistant message includes a `trace` with the reasoning, tool calls, answer text, and finish reason. The default mock omits `tool_call` and `tool_result`. Tests can construct `MockProvider` with `scriptToolCall: true` to emit a `lookup_context` call and result.

- `GET /api/conversations` lists conversations.
- `GET /api/conversations/:id` reads one conversation and its messages.
- `PATCH /api/conversations/:id` with `{ "title": "..." }` renames it.
- `DELETE /api/conversations/:id` deletes it.
- `GET /api/computer` returns the agent's computer, workspace files, and recent runs (command, output, exit code, changed files).
- `POST /api/computer` with `{ "tool": "list" | "read" | "write" | "exec", ... }` runs one computer tool. `write` takes `path` and `content`. `exec` takes `command`. The response is the tool result and the stored run. The Daytona key is not included.

## Checks

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
```

`npm run format` rewrites files with Prettier. GitHub Actions runs lint, typecheck, the format check, and tests on every push and pull request.
