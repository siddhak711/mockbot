# Mockbot

Mockbot is a personal agent workspace. It starts as a single chat agent: start a conversation, watch the reply stream, and come back to the same transcript. The agent can also call tools. Tool cards stream into the transcript and the Computer pane, and a refresh keeps them with the turn.

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

Open [http://localhost:3000](http://localhost:3000). With no API key, chat uses the built-in mock provider and streams a reply into the transcript. Conversations are stored in embedded Postgres (PGlite) under `.data/pglite`, so a refresh restores the conversation list, titles, and every message.

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

The server keeps a tool registry. Each tool has a name, a JSON schema, and an invoke function, in the same shape as an MCP tool. A turn exposes at most 15 tools to the model. `tool_search` is always one of them and finds the rest by name or description. With no keys configured, the mock provider still runs a tool demo: it searches the catalog and then calls another tool, so the cards show up without an API key.

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

## API

- `POST /api/chat` with `{ "message": "...", "conversationId": "optional" }` streams server-sent events: `meta`, `delta`, `tool_start`, `tool_args`, `approval_required`, `tool_result`, `done`, and `error`.
- `POST /api/tools/approvals` with `{ "id": "...", "decision": "approve" | "deny" }` approves or denies a pending write.
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
