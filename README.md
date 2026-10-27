# Mockbot

Mockbot is a personal agent workspace. The sidebar lists agents. Each person and agent share one persistent thread: send a message, watch the full reply stream, and come back to that same transcript. The transcript keeps the start token, reasoning, tool calls, the answer, and the finish reason. Tool cards stream into the transcript and the Computer pane, and a refresh keeps them with the turn. More than one agent can exist. Each agent has its own instructions, memory note, and grants. The lead can hand a subtask to another agent, which appends to that agent's thread.

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

Open [http://localhost:3000](http://localhost:3000). A visitor who is not signed in sees the Daylight landing page and can join the waitlist in the browser. The waitlist does not call a server. Sign in at [http://localhost:3000/login](http://localhost:3000/login) to open the workspace on the same address. With no API key, chat uses the built-in mock provider. Each mock turn streams a start token, a short reasoning trace, the answer, and an end token (`finish stop`). The live mock does not invent a connector tool call. Asking it to remember a fact calls `memory_write`. A message that asks for a handoff calls `delegate`. Tool-call cards still render when a stream includes them. The agent's thread and memories are stored in embedded Postgres (PGlite) under `.data/pglite`. A refresh restores that thread, memories, and every streamed phase. The token-by-token animation is live only. Stopping a turn keeps the partial reasoning and answer that have already been saved.

The first agent is Mockbot, seeded with the original assistant prompt. Create another agent in the sidebar (name, instructions, an optional memory note, and optional computer or connector ids). Select an agent to open that agent's thread. From Mockbot, send:

```text
delegate to Researcher: What is the grove code?
```

The lead transcript shows the `delegate` call and the child result. Only Mockbot can delegate, and it cannot delegate to itself. The child result is appended to the child agent's one thread. Open that agent in the sidebar to read it. The child uses its own memory note and can read a computer only when that computer id was granted. A connector or computer it was not granted is refused, and the lead conversation stays usable. A task that says `use connector <id>` asks for that connector.

`npm run build` then `npm start` runs the production server. Production and Vercel require `DATABASE_URL`. Use the pooled Neon connection string from the Vercel Marketplace Neon integration (`-pooler` in the host). Mockbot uses Neon's HTTP serverless driver there. It does not open PGlite, a `/tmp` database, or a blob snapshot in production. A hosted runtime without `DATABASE_URL` refuses to start.

## Accounts

The workspace is signed in. A visitor with no session who opens the home page sees the Daylight landing page. Routines, settings, connectors, and the API still redirect that visitor to the login screen. Email and password accounts and Google sign-in share one user record. Sessions are opaque tokens in an httpOnly cookie (`authjs.session-token`, or `__Secure-authjs.session-token` on HTTPS). The token is stored in Postgres. Passwords are hashed with bcrypt at cost 12 and are never written to the database as plaintext.

Auth.js (NextAuth v5) runs the Google OAuth flow and the `/api/auth/*` routes. The stock Postgres adapter is not used: local development is embedded PGlite and production is Neon's serverless driver, both behind the existing `Sql` connection. A small adapter implements the Auth.js user, account, session, and verification tables on that connection. Email and password does not use the Auth.js Credentials provider. That provider cannot persist database sessions. Sign-up and sign-in write the same `users` and `sessions` rows, then set the same cookie. Pages and the log-out action read that cookie directly. `AUTH_SECRET` is still required for `/api/auth/*` and Google sign-in.

### Environment variables

Set these in `.env.local` for local development and in the Vercel project for production. Do not commit the values.

| Variable               | Required             | Format                                                                                             |
| ---------------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`          | Yes                  | Long random string. `openssl rand -base64 32`                                                      |
| `AUTH_URL`             | Yes, per environment | Origin only, no path. Local: `http://localhost:3000`. Production: `https://mockbot-jet.vercel.app` |
| `GOOGLE_CLIENT_ID`     | For Google sign-in   | OAuth client id from Google Cloud Console                                                          |
| `GOOGLE_CLIENT_SECRET` | For Google sign-in   | OAuth client secret from the same client                                                           |

`NEXTAUTH_SECRET` is read only when `AUTH_SECRET` is unset. `NEXTAUTH_URL` is read only when `AUTH_URL` is unset. Prefer the `AUTH_*` names.

`AUTH_URL` decides whether the session cookie is marked Secure. Use the http URL locally and the https URL in the Vercel Production environment. Leave `AUTH_URL` unset on Preview deployments if those hosts are not registered as Google redirect URIs. Password sign-in still works there. Google sign-in follows `AUTH_URL` when it is set, so a Production value on a Preview deployment sends the OAuth callback to production.

Restart `npm run dev` after changing these. The dev server reads them at startup.

### Google Cloud Console

1. Open [Google Cloud Console](https://console.cloud.google.com/apis/credentials) and create an OAuth client ID of type **Web application**.
2. Under **Authorized JavaScript origins**, add both of these:
   - `http://localhost:3000`
   - `https://mockbot-jet.vercel.app`
3. Under **Authorized redirect URIs**, add both of these exactly:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://mockbot-jet.vercel.app/api/auth/callback/google`
4. Copy the client id and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. In the Vercel project, set `AUTH_SECRET`, `AUTH_URL=https://mockbot-jet.vercel.app`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` for Production. Redeploy after saving them.

The same names are listed in `.env.example`. If the Google variables are missing, the button stays on the login screen and explains what to set. It does not start an OAuth redirect until both values exist.

### Existing rows

Migration `006_auth` adds `users`, `accounts`, `sessions`, and `verification_tokens`, and nullable `user_id` on `conversations`, `agents`, and `memories`. It does not assign existing rows and it does not edit production by hand. The app migrator applies it on startup, the same way as the earlier migrations. Migration `007_composio_connections` stores each user's Composio connected-account id for a catalog app. Migration `008_connector_catalog` keeps one connector row per catalog app. Before the unique index, it keeps the oldest row for each catalog id and folds the other rows' tool settings into it.

Rows with `user_id` still null are orphans from before accounts, or from a path that does not know the caller (the routines worker). The **earliest account**, ordered by `users.created_at` then `id`, adopts those rows the next time that account loads the app. Later accounts do not see them. Each account also gets its own lead agent named Mockbot. The legacy lead id `agent_default` stays the lead for the account that adopted it. Another account's lead has its own id and can still delegate.

Connectors, routines, and the sandbox computer stay workspace-wide. They require a session, and they are not split per account in this change.

Signing in with Google does not attach to an email/password user with the same address. Google verifies the address, but the password account has not, so linking them automatically would let someone register the address first. The login screen asks for the original method instead.

## Memory

Ask the agent to remember a fact, for example "Remember that my favorite color is blue". The mock provider calls `memory_write`. Ask for the fact again in this same thread. Profile memories are injected into the system prompt, and matching facts are recalled the same way. They are not inserted as a fake user message.

The Memory button opens a panel that lists each live memory, the source snippet, and older versions. Edit and delete there. A delete is a soft delete, and a deleted memory is not retrieved again. The model can also call `memory_update`, `memory_delete`, and `memory_search`.

Writes that look like an API key, JWT, card number, or other high-entropy secret are blocked and are not stored. The model only saves facts grounded in what you said in that conversation.

When a conversation grows past about 60% of `LLM_CONTEXT_TOKENS` (default 8192), older turns are summarized into `conversation_summaries` and the recent tail stays verbatim.

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

## Connectors

The sidebar can register an MCP server. A connector stores a name, a transport (`http` or `stdio`), a target, and an optional secret reference. The reference is the name of an environment variable on the server and must start with `MCP_`, such as `MCP_DEMO_TOKEN`. The value stays on the server: it is sent as a bearer token for HTTP, or as that one variable in a stdio process, and it is not written into the prompt, the transcript, or API responses.

### Catalog connectors (Composio)

Notion and GitHub in the catalog connect through [Composio](https://composio.dev). Composio runs the provider OAuth flow and executes the provider's tools. The other catalog apps are config entries (a Composio toolkit slug is recorded, and connect stays disabled) and do not create a connector.

```bash
COMPOSIO_API_KEY=
```

`COMPOSIO_API_KEY` is a server secret. It is not written into the repo, the prompt, or the browser. If it is unset, connect fails with that variable name and does not create a connector.

The catalog sign-in window opens Composio's hosted URL. Composio sends the browser back to `/connectors/oauth/callback`. The callback origin does not require `APP_ORIGIN`:

1. `APP_ORIGIN`, when it is set to an http or https URL. This is an optional override.
2. The incoming request. `x-forwarded-host` is used when the platform sends it, otherwise the `host` header. The scheme is `x-forwarded-proto` when that is `http` or `https`. A public host without that header uses `https`. A localhost host uses the request URL's scheme.
3. The origin of the request URL, when those headers are absent.
4. `AUTH_URL`, or `NEXTAUTH_URL` when `AUTH_URL` is unset. This is the URL NextAuth is configured with, and it is used only when the request URL is not an http or https origin.

On Vercel that is the deployment host from the forwarded headers, so production and preview each call back to the site that started sign-in. Leave `APP_ORIGIN` unset.

A finished sign-in stores a Composio connected-account id per user and catalog app in `composio_connections`. The id is a connection reference, not an access token. The connector row itself stays workspace-wide and does not hold the provider token or a person's account name. Tool calls for a chat turn use the signed-in user's connection. Another account has to connect the same app before those tools run for them. Disconnecting removes that person's link. The shared connector stays until nobody is linked. A failed sign-in marks reconnect on that person's link only.

`GET /api/connectors/composio/toolkits` lists Composio toolkits and which catalog entries are enabled. Notion and GitHub are the enabled proof of concept. Enabling another catalog app is the `composio.enabled` flag on its catalog entry; the connect and execute path is the same.

Optional:

- `COMPOSIO_BASE_URL` overrides the Composio API origin.
- `COMPOSIO_TOOLKIT_VERSIONS` is a JSON object of pinned toolkit versions, such as `{"notion":"20260101_00"}`. It overrides the versions pinned in code. Notion and GitHub default to `20250909_00`. A toolkit without a pin is not executed.

The previous Notion and GitHub OAuth clients, PKCE exchange, Notion REST adapter, and GitHub hosted MCP call remain in the tree. They run only when `NATIVE_CATALOG_OAUTH=1`, and they still need `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_ID`, and `GITHUB_OAUTH_CLIENT_SECRET`. Leave that flag unset.

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

## Sandbox

Each agent has one computer. The current build has a single implicit agent, so every conversation shares that computer. The browser only talks to Mockbot. `DAYTONA_API_KEY` stays on the server.

`list`, `read`, `write`, and `exec` are registered with the tool registry. With no key, the computer is an in-process mock. It can list, read, write, and run a small set of commands (`echo`, `cat`, `ls`, `pwd`, `sleep`, `printenv`). It does not read the host filesystem and it does not start a host shell. Ask the mock model to create a file and print it:

> Create a file named hello.txt that says hello from the sandbox, read it back, and run a command that prints it.

The Computer pane shows the command, the output, the exit code, and changed files. A command that runs longer than `SANDBOX_COMMAND_TIMEOUT_MS` (default 10 seconds) is killed and stored as a failed run.

Daytona is used when a key is set. The same tools run inside a Daytona sandbox, one sandbox per agent. The sandbox id is reused on the next command. Host environment variables are not copied into it.

Each new sandbox is built from `python:3.12-slim-bookworm`. The image installs `coreutils` (`ls`, `cat`, `wc`, `head`, `tail`), `grep`, `sed`, `git`, `python3`, `nodejs`, and `npm`, then fails the build unless `grep --version`, `node --version`, `npm --version`, `python3 --version`, and `git --version` succeed. Daytona caches that image. The first create waits for the build; later creates reuse it. The SDK's 60 second create timeout is disabled for that wait.

A sandbox created before this image keeps its old filesystem. Before the first command, Mockbot runs the same version check inside the sandbox. If a tool is missing, it installs the packages with apt (as root, or with `sudo -n` when the sandbox user is not root). That install is not stored as a computer run. If the install fails, that command creates a new sandbox from the tool image instead. The old sandbox and its files are left in Daytona.

```bash
DAYTONA_API_KEY=dtn_...
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_TARGET=us
SANDBOX_COMMAND_TIMEOUT_MS=10000
npm run dev
```

`DAYTONA_API_URL` defaults to the SDK's Daytona cloud URL. `DAYTONA_TARGET` is the region, when you set one. In local development, computer records and the mock workspace are stored in embedded Postgres under `.data/sandbox`. When `DATABASE_URL` is set, and on Vercel or in production, those tables are created in the same Postgres database as conversations.

## Routines

A routine is a saved prompt. Cron routines run on a UTC schedule. Event routines run once each time an event with the same name is inserted. The scheduler is a long-lived worker that claims due rows from Postgres. It is not a serverless cron.

`npm run dev` starts that worker in the same process. Embedded Postgres is single-connection, so the dev worker shares the Next.js process and the `.data/pglite` database. Open [http://localhost:3000/routines](http://localhost:3000/routines) to create a routine, read its next run time, pause it, and inspect runs. A finished run appends the prompt and the reply to a conversation.

Cron expressions are five fields, `minute hour day month weekday`, evaluated in UTC. `0 9 * * 1` means Monday at 09:00 UTC. Names such as `MON` are not accepted. When both the day-of-month and weekday are restricted, the routine runs when either field matches.

Run the worker as its own process beside the app:

```bash
ROUTINES_WORKER=off npm run start
npm run routines
```

`npm run routines` polls until it receives SIGINT or SIGTERM. `ROUTINE_POLL_MS` defaults to 1000. `ROUTINE_WORKER_ID` sets the id stored on a claimed run. Use `ROUTINES_WORKER=off` so the app process does not start a second loop. Two processes can share a Postgres server. They cannot share one embedded PGlite directory, so local development uses the in-process worker.

A failed run is stored as failed with the error. The worker does not claim that row again. The next cron occurrence is a new run.

Insert a named event while the app is running:

```bash
curl -s -X POST http://localhost:3000/api/routines/events \
  -H 'content-type: application/json' \
  -d '{"name":"deploy.finished","payload":"optional"}'
```

The same form is on the Routines page.

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
  - `ask_user` — `{ "id", "name", "question", "options", "allowCustom", "arguments", "assistantMessageId" }` when the agent asks the person a question and the turn pauses
  - `tool_status` — `{ "id", "name", "status" }` when an approved tool starts running
  - `tool_result` — `{ "id", "name", "status", "output", "assistantMessageId" }` when a registry tool finishes
  - `done` — `{ "conversationId", "assistantMessageId" }` after the turn is saved
  - `error` — `{ "message" }`

  The OpenAI-compatible provider forwards the model phases from a chat-completions stream when the upstream chunk includes them: `delta.role`, `delta.content`, `delta.reasoning` / `reasoning_content` / `thinking`, `delta.tool_calls` (and legacy `function_call`), `delta.refusal`, and `finish_reason`. `data: [DONE]` becomes an end token when the upstream never sent a finish reason. Each stored assistant message includes a `trace` with the reasoning, tool calls, answer text, and finish reason. Registered tools also stay in `tool_calls` on that message. A `finish_reason` of `tool_calls`, or a tool call with no provider result and no answer text, runs through the registry. The default mock omits `tool_call` and `tool_result`. Tests can construct `MockProvider` with `scriptToolCall: true` to emit a display-only `lookup_context` call and result, or `demoTools: true` to run the registry demo.

- `POST /api/tools/approvals` with `{ "id": "...", "decision": "approve" | "deny" | "stop" }` approves, denies, or stops a pending write.
- `POST /api/tools/asks` with `{ "id": "...", "answer": "..." }` resumes a paused `ask_user` call. The tool result is that answer. `{ "id", "decision": "stop" }` ends the question. The pending question is stored on the assistant message. If the turn is still waiting in this process, the answer wakes it. If that waiter is gone, the answer is checked against the stored question and the turn continues from the database. A question whose stored payload can no longer be read is marked expired so the card is not left pending.
- `GET /api/connectors` lists connectors. Each row has `id`, `name`, `transport`, `target`, `secretRef`, `enabled`, `createdAt`, and `updatedAt`. `secretRef` is an environment variable name that starts with `MCP_`. The secret value is not included.
- `POST /api/connectors` with `{ "name", "transport": "http" | "stdio", "target", "secretRef": "optional" }` checks that the server lists tools, then stores the connector.
- `PATCH /api/connectors/:id` with `{ "enabled": true | false }` enables or disables it.
- `DELETE /api/connectors/:id` removes it.
- `GET /api/agents/:id/conversation` reads that agent's one thread, its messages, and the tool calls stored on each assistant turn. The thread is created if this user does not have one yet.
- `GET /api/conversations/:id` reads a thread by id. Threads are not listed, renamed, or deleted.
- `GET /api/memories` lists this agent's memories, including history.
- `PATCH /api/memories/:id` with `{ "content": "...", "kind": "profile" }` records a correction.
- `DELETE /api/memories/:id` soft-deletes a memory.
- `GET /api/computer` returns the agent's computer, workspace files, and recent runs (command, output, exit code, changed files).
- `POST /api/computer` with `{ "tool": "list" | "read" | "write" | "exec", ... }` runs one computer tool. `write` takes `path` and `content`. `exec` takes `command`. The response is the tool result and the stored run. The Daytona key is not included.
- `GET /api/agents` lists agents and their grants.
- `POST /api/agents` with `{ "name", "instructions", "memoryNote?", "computerId?", "connectorId?" }` creates an agent. Optional ids are grants for a computer or a connector.
- `POST /api/chat` accepts `agentId` and appends to that agent's thread instead of opening another one. On a Mockbot conversation, a message that begins `delegate to <name>: <task>` makes the mock provider call the `delegate` tool. The tool appends the task to that agent's thread and returns the result on the parent turn. Delegating to Mockbot is refused. Other agents do not get the delegate tool.
- `GET /api/routines` lists routines and their latest runs.
- `POST /api/routines` with `{ "name", "prompt", "cron" }` or `{ "name", "prompt", "eventName" }` creates one. A cron routine includes `nextRunAt`.
- `PATCH /api/routines/:id` with `{ "status": "paused" }` or `{ "status": "active" }` pauses or resumes it.
- `POST /api/routines/events` with `{ "name", "payload": "optional" }` stores an event and schedules one run for each active routine listening for that name.

## Checks

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
```

`npm run format` rewrites files with Prettier. GitHub Actions runs lint, typecheck, the format check, and tests on every push and pull request.
