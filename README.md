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

The server keeps a tool registry. Each tool has a name, a JSON schema, and an invoke function, in the same shape as an MCP tool. A turn exposes at most 15 tools to the model. `tool_search` is always one of them and finds the rest by name or description. With no keys configured, the tools return mock data and do not touch the network. The live mock provider answers without inventing a tool call. A model that requests tools still runs them through the registry. Tests can opt the mock provider into a multi-step demo that searches the catalog and then calls another tool.

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

## Connectors

The sidebar can register an MCP server. A connector stores a name, a transport (`http` or `stdio`), a target, and an optional secret reference. The reference is the name of an environment variable on the server and must start with `MCP_`, such as `MCP_DEMO_TOKEN`. The value stays on the server: it is sent as a bearer token for HTTP, or as that one variable in a stdio process, and it is not written into the prompt, the transcript, or API responses.

HTTP targets are `http` or `https` URLs. Stdio targets are a program and arguments separated by spaces, run without a shell. Disabling or removing a connector drops its tools from the next turn. The built-in web, GitHub, and calendar tools stay registered.

The mock provider does not invent a tool call for a normal message. To exercise a connector without an API key, name the tool:

```text
Call demo_echo {"message":"hello from the connector"}
```

`demo_echo` is the `echo` tool from a connector named Demo. The reply shows the arguments and the result. If that connector is removed or disabled, the next turn says the tool is not in the list.

A deterministic mock server ships with the repo:

```bash
MCP_DEMO_TOKEN=demo-token node scripts/mock-mcp-server.mjs --http 8787
```

Add a connector named Demo, transport HTTP, target `http://127.0.0.1:8787/mcp`, secret reference `MCP_DEMO_TOKEN`. Omit `--http` to serve the same tools over stdio:

```text
node scripts/mock-mcp-server.mjs
```

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
- `GET /api/connectors` lists connectors. Each row has `id`, `name`, `transport`, `target`, `secretRef`, `enabled`, `createdAt`, and `updatedAt`. `secretRef` is an environment variable name that starts with `MCP_`. The secret value is not included.
- `POST /api/connectors` with `{ "name", "transport": "http" | "stdio", "target", "secretRef": "optional" }` checks that the server lists tools, then stores the connector.
- `PATCH /api/connectors/:id` with `{ "enabled": true | false }` enables or disables it.
- `DELETE /api/connectors/:id` removes it.
- `GET /api/conversations` lists conversations.
- `GET /api/conversations/:id` reads one conversation, its messages, and the tool calls stored on each assistant turn.
- `PATCH /api/conversations/:id` with `{ "title": "..." }` renames it.
- `DELETE /api/conversations/:id` deletes it.

## Checks

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
```

`npm run format` rewrites files with Prettier. GitHub Actions runs lint, typecheck, the format check, and tests on every push and pull request.
