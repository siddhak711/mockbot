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

Open [http://localhost:3000](http://localhost:3000). With no API key, chat uses the built-in mock provider and streams a reply into the transcript. Conversations and memories are stored in embedded Postgres (PGlite) under `.data/pglite`, so a refresh restores the conversation list, titles, and every message.

`npm run build` then `npm start` runs the production server. Production and Vercel require `DATABASE_URL`. Use the pooled Neon connection string from the Vercel Marketplace Neon integration (`-pooler` in the host). Mockbot uses Neon's HTTP serverless driver there. It does not open PGlite, a `/tmp` database, or a blob snapshot in production. A hosted runtime without `DATABASE_URL` refuses to start.

## Memory

Ask the agent to remember a fact, for example "Remember that my favorite color is blue". The mock provider calls `memory_write`. Open a new conversation and ask for the fact again. Profile memories are injected into the system prompt, and matching facts are recalled the same way. They are not inserted as a fake user message.

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

## API

- `POST /api/chat` with `{ "message": "...", "conversationId": "optional" }` streams server-sent events (`meta`, `delta`, `done`, `error`).
- `GET /api/conversations` lists conversations.
- `GET /api/conversations/:id` reads one conversation and its messages.
- `PATCH /api/conversations/:id` with `{ "title": "..." }` renames it.
- `DELETE /api/conversations/:id` deletes it.
- `GET /api/memories` lists this agent's memories, including history.
- `PATCH /api/memories/:id` with `{ "content": "...", "kind": "profile" }` records a correction.
- `DELETE /api/memories/:id` soft-deletes a memory.

## Memory eval

```bash
npm run eval:memory
```

That runs the mockbot recall set (about 20 cases) on the mock provider and prints answer, save, and search miss rates. It does not download LongMemEval and it does not spend a model call.

To score a 50-question slice of [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (`xiaowu0162/longmemeval-cleaned`, oracle file), opt in with a model key:

```bash
LLM_PROVIDER=openai LLM_API_KEY=sk-... npm run eval:memory -- --longmemeval
```

The script downloads `longmemeval_oracle.json` into `evals/data/` (gitignored), replays user turns, then asks the question in a new conversation. It reports a no-memory baseline, the contains-match rate, and save and search miss rates. The official LongMemEval number uses a GPT judge; this harness uses contains-match. It is not part of `npm test`.

## Checks

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
```

`npm run format` rewrites files with Prettier. GitHub Actions runs lint, typecheck, the format check, and tests on every push and pull request.
