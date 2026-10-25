# Mockbot

Mockbot is a personal agent workspace. It starts as a single chat agent: start a conversation, watch the full reply stream, and come back to the same transcript. The transcript keeps the start token, reasoning, tool calls, the answer, and the finish reason. The agent can also call tools. Tool cards stream into the transcript and the Computer pane, and a refresh keeps them with the turn.

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

## Tools

The server keeps a tool registry. Each tool has a name, a JSON schema, and an invoke function, in the same shape as an MCP tool. A turn exposes at most 15 tools to the model. `tool_search` is always one of them and finds the rest by name or description. With no keys configured, the tools return mock data and do not touch the network. The live mock provider answers an ordinary message without inventing a tool call. A message that asks for the sandbox computer asks the registry to run the computer tools. Any other model that requests tools still runs them through the registry. Tests can opt the mock provider into a multi-step demo that searches the catalog and then calls another tool.

Reads run immediately. A tool whose name or action sends, posts, deletes, or pays waits for approval. Creating a calendar event that includes attendees is an invite, so it waits too. The transcript shows an approval card; `POST /api/tools/approvals` with `{ "id", "decision": "approve" | "deny" }` resolves it. Deny, or a stop, skips the action and the model can finish the reply.

### Web search and fetch

```bash
TAVILY_API_KEY=tvly-...
```

`web_search` and `web_fetch` call Tavily when `TAVILY_API_KEY` is set. Otherwise they return deterministic mock results and do not touch the network.

### GitHub

```bash
GITHUB_TOKEN=github_pat_...
```

`github` reads issues, pull requests, and file contents when `GITHUB_TOKEN` is set. Otherwise it returns mock data. It does not write to GitHub.

### Google Calendar

`google_calendar` can list events or create one. Inviting attendees asks for approval before the event is created. Calendar OAuth is not part of this version. Until that exists, the tool returns mock data and does not call Google. If you already have an access token, `GOOGLE_CALENDAR_ACCESS_TOKEN` uses the Calendar API directly. That variable is optional and is not an OAuth setup.

## Sandbox

Each agent has one computer. The current build has a single implicit agent, so every conversation shares that computer. The browser only talks to Mockbot. `DAYTONA_API_KEY` stays on the server.

`list`, `read`, `write`, and `exec` are registered with the tool registry. With no key, the computer is an in-process mock. It can list, read, write, and run a small set of commands (`echo`, `cat`, `ls`, `pwd`, `sleep`, `printenv`). It does not read the host filesystem and it does not start a host shell. Ask the mock model to create a file and print it:

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

## API

- `POST /api/chat` with `{ "message": "...", "conversationId": "optional" }` streams server-sent events:
  - `meta` — `{ "conversationId", "title", "userMessageId" }`
  - `start` — `{ "role": "assistant" }` when the model turn starts
  - `reasoning` — `{ "text" }` reasoning or thinking delta
  - `tool_call` — `{ "index", "id?", "name?", "arguments?" }` tool-call delta from the model stream
  - `tool_result` — `{ "id", "name", "content" }` when the provider itself emits a tool result
  - `delta` — `{ "text" }` answer text delta
  - `end` — `{ "finishReason" }` such as `stop`, `length`, or `tool_calls`
  - `tool_start` — `{ "id", "name", "assistantMessageId" }` when the registry starts a tool
  - `tool_args` — `{ "id", "arguments" }` as a registry tool's arguments arrive
  - `approval_required` — `{ "id", "name", "arguments", "summary", "assistantMessageId" }` when a write needs approval
  - `tool_status` — `{ "id", "name", "status" }` when an approved tool starts running
  - `tool_result` — `{ "id", "name", "status", "output", "assistantMessageId" }` when a registry tool finishes
  - `done` — `{ "conversationId", "assistantMessageId" }` after the turn is saved
  - `error` — `{ "message" }`

  The OpenAI-compatible provider forwards the model phases from a chat-completions stream when the upstream chunk includes them: `delta.role`, `delta.content`, `delta.reasoning` / `reasoning_content` / `thinking`, `delta.tool_calls` (and legacy `function_call`), `delta.refusal`, and `finish_reason`. `data: [DONE]` becomes an end token when the upstream never sent a finish reason. Each stored assistant message includes a `trace` with the reasoning, tool calls, answer text, and finish reason. Registered tools also stay in `tool_calls` on that message. A `finish_reason` of `tool_calls`, or a tool call with no provider result and no answer text, runs through the registry. The default mock omits `tool_call` and `tool_result`. Tests can construct `MockProvider` with `scriptToolCall: true` to emit a display-only `lookup_context` call and result, or `demoTools: true` to run the registry demo.

- `POST /api/tools/approvals` with `{ "id": "...", "decision": "approve" | "deny" | "stop" }` approves, denies, or stops a pending write.
- `GET /api/conversations` lists conversations.
- `GET /api/conversations/:id` reads one conversation, its messages, and the tool calls stored on each assistant turn.
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
