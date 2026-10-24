# Mockbot

Mockbot is a personal agent workspace. Milestone 1 is a single chat agent: start a conversation, watch the reply stream, and come back to the same transcript.

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

## API

- `POST /api/chat` with `{ "message": "...", "conversationId": "optional" }` streams server-sent events (`meta`, `delta`, `done`, `error`).
- `GET /api/conversations` lists conversations.
- `GET /api/conversations/:id` reads one conversation and its messages.
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
