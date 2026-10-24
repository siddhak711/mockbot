# Mockbot roadmap

Each milestone has to work end to end before the next one starts. A milestone is done when a person can do the thing in the running app, the new behavior has automated tests, and the docs still match the code.

The order is the dependency order. Tools need a turn loop. Memory is retrieved on that same turn. A computer is a tool with a hard isolation boundary. Routines reuse the loop without a person sitting in the browser. Multi-agent coordination reuses agents, memory, tools, and computers instead of inventing a side channel.

## Milestone 1 — Single-agent chat

One implicit agent. The person starts a conversation, watches a reply stream, leaves, and comes back to the same transcript.

Build:

- Workspace UI with a conversation list, a transcript, and a composer.
- `POST /api/chat` streaming SSE, plus list, read, rename, and delete.
- Conversation store on embedded Postgres.
- LLM port with a mock provider and an OpenAI-compatible provider.
- Lint, typecheck, and unit tests in GitHub Actions.

Acceptance criteria:

- [ ] With no API key, a new message streams a mock reply in the transcript.
- [ ] Refreshing the page restores the conversation list, the title, and every message.
- [ ] Renaming and deleting a conversation updates the list and the open thread.
- [ ] Stopping a stream keeps the user message and any partial assistant text.
- [ ] Setting `LLM_PROVIDER=openai` and `LLM_API_KEY` sends the turn to `LLM_BASE_URL` without exposing the key to the browser.
- [ ] `npm run lint`, `npm run typecheck`, and `npm test` pass locally and in CI.
- [ ] The README is enough to install, run, and switch providers.

## Milestone 2 — Tools and connectors

The agent can call a tool on an MCP server, and the transcript shows the call and the result.

Build:

- Connector records (transport, target, secret reference) and a way to add and remove them in the UI.
- An MCP client in the server process.
- An agent loop that repeats while the model returns tool calls.
- The OpenAI-compatible provider passes tool definitions and streams tool-call deltas. The mock provider can emit a scripted tool call in tests.

Acceptance criteria:

- [ ] A person can register a local or remote MCP server without putting the secret in the prompt.
- [ ] A chat turn can invoke one of that server's tools and show the arguments and the result in the transcript.
- [ ] A tool error is visible in the transcript and the conversation remains usable afterward.
- [ ] The model receives the tool result and can finish the reply using it.
- [ ] A connector that is removed disappears from the next turn's tool list.
- [ ] Tests cover a scripted tool call, a tool failure, and the resulting stored messages.

## Milestone 3 — Durable memory

The agent can remember a fact in one conversation and use it in another. Memory is something the person can see, correct, and delete. The model writes memory with tools. There is no embedding index and no background extractor.

Storage:

- Production (`VERCEL=1` or `NODE_ENV=production`) uses Neon Postgres through `DATABASE_URL` and the Neon HTTP serverless driver. The connection string should be the pooled host. There is no PGlite file, `/tmp` database, or blob snapshot in production. A hosted runtime without `DATABASE_URL` refuses to start.
- Local development and CI use PGlite behind the same SQL interface. One migration runner applies the same SQL to both drivers.
- `memories(id, agent_id, kind, key, content, source_msg, supersedes, valid_from, valid_to, deleted_at, created_by)`. `kind` is `profile` or `fact`. A GIN full-text index covers `content`. A partial unique index allows one live row per agent and key.
- `conversation_summaries(conversation_id, summary, upto_msg, updated_at)`.
- Every memory and conversation query is scoped by `agent_id`. The default agent is `agent_default`.

Remember path:

- `memory_write(key, text)` inserts a row. A duplicate key closes the live row and inserts a new one with `supersedes`. It does not overwrite.
- `memory_update(key, text)` does the same close-and-insert when a live row exists.
- `memory_delete(key)` sets `deleted_at`.
- `memory_search(query)` is full-text, top-k, and token-capped.
- If the milestone 2 tool loop is not on main, a small loop runs tool calls, feeds the results back, and stops at a step cap. Tool definitions use the same shape milestone 2 registers.

Read path:

- Live profile memories, at most 500 tokens, are injected into the system prompt on every turn.
- Matching facts are recalled into the system prompt, at most 400 tokens.
- The system prompt tells the model when to save, update, search, and delete.
- Past about 60% of the context window, older messages are summarized into `conversation_summaries` and the recent tail stays verbatim.

Safety:

- A secret scrubber (API key, JWT, card, and high-entropy patterns) blocks the write, logs the event without the secret, and tells the model.
- The model may save only facts grounded in this conversation's user messages, not tool or web output. Edits from the memory panel still pass the scrubber.

API and UI:

- `GET /api/memories`, `PATCH /api/memories/:id`, `DELETE /api/memories/:id`.
- The memory panel lists, edits, and deletes memories and shows the source snippet and supersede history.

Eval:

- `npm run eval:memory` runs the mockbot recall set on the mock provider.
- `npm run eval:memory -- --longmemeval` adds a 50-question LongMemEval slice when `LLM_PROVIDER=openai` and `LLM_API_KEY` are set. It is not part of `npm test`.

Acceptance criteria:

- [x] Asking the agent to remember a fact creates a memory row tied to the agent.
- [x] A duplicate key updates in place of a second live row, and an update keeps the old row in history. The new row is the one retrieved.
- [x] A new conversation can use that fact, and the prompt trace in tests shows it in system context rather than as a fake user message.
- [x] The person can list memories and delete one. A deleted memory is not retrieved again.
- [x] Memories from a different agent are not retrieved.
- [x] A planted API key is not stored. The block is logged without the secret.
- [x] Profile injection stays inside its token budget.
- [x] Older conversation turns compact into a summary, and the recent tail stays verbatim.
- [x] The same memory tests run on PGlite in CI. The Neon test runs only when `DATABASE_URL` is set.
- [x] `npm run eval:memory` runs the mockbot recall set and documents how to score a LongMemEval sample.
- [x] `npm run lint`, `npm run typecheck`, and `npm test` pass.

## Milestone 4 — Sandboxed computer

Each agent gets a computer that is not the host. The agent can read, write, and run commands there, and the person can see what happened.

Build:

- A computer record per agent and a supervisor behind a small control API.
- Tools on the agent loop: list, read, write, exec.
- A test runtime that implements the same API without Docker, and a local container runtime for the real sandbox.
- A run inspector for commands, exit codes, and changed files.

Acceptance criteria:

- [ ] The agent can create a file, read it back, and run a command that prints it.
- [ ] The workspace shows the command, the output, and the exit code.
- [ ] The sandbox cannot read the host environment file or another agent's workspace. A test proves both.
- [ ] A command that exceeds its time limit is killed and reported as a failed tool result.
- [ ] The Next.js process does not invoke a host shell to perform the agent's request.

## Milestone 5 — Routines

A saved prompt runs on a schedule, or when an event arrives, even if the browser is closed.

Build:

- Routine and run tables, including cron and a named event trigger.
- A worker process that claims due work from Postgres and runs the agent loop.
- UI to create, pause, and inspect routines and their runs.

Acceptance criteria:

- [ ] A person can create a routine with a prompt and a cron schedule and see the next run time.
- [ ] The worker completes a due routine without a browser session and writes the result into a conversation.
- [ ] Pausing a routine stops further runs. The last run remains visible.
- [ ] Inserting a matching event runs an event-triggered routine once.
- [ ] A failing run is stored as failed with the error, and the worker does not spin on it.
- [ ] Two workers cannot complete the same run. A test covers the claim.

## Milestone 6 — Multi-agent coordination

More than one agent exists. A lead agent can delegate a subtask. The delegate uses its own instructions, memory, and computer.

Build:

- Agent records. Seed the milestone 1 prompt as the first agent.
- Grants that attach connectors and a computer to an agent.
- A delegate tool that opens a child conversation, runs that agent, and returns the result to the parent.
- UI to create an agent and to read a delegation in the parent transcript.

Acceptance criteria:

- [ ] A person can create a second agent with different instructions.
- [ ] The lead agent can delegate a subtask, and the parent transcript shows the delegation and the result.
- [ ] The child conversation is readable on its own and belongs to the child agent.
- [ ] The child uses its own memories and computer, and it cannot call a connector or a computer it was not granted.
- [ ] A failed child run is visible on the parent turn, and the parent conversation stays usable.
- [ ] Tests cover a successful delegation and a grant refusal.

## After the six

Not scheduled, and not allowed to jump the queue: accounts, sharing a workspace, and paying-provider budgets. Hosted Postgres is the production driver as of milestone 3; local development and CI stay on PGlite. Accounts wait until more than one person is a real requirement.
