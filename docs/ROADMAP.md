# Mockbot roadmap

Each milestone has to work end to end before the next one starts. A milestone is done when a person can do the thing in the running app, the new behavior has automated tests, and the docs still match the code.

The order is the dependency order. Tools need a turn loop. Memory is retrieved on that same turn. A computer is a tool with a hard isolation boundary. Routines reuse the loop without a person sitting in the browser. Multi-agent coordination reuses agents, memory, tools, and computers instead of inventing a side channel.

## Milestone 1 — Single-agent chat

One implicit agent. That agent has one persistent thread. The person sends a message, watches a reply stream, leaves, and comes back to the same transcript. There is no second conversation to start, rename, or delete.

Build:

- Workspace UI with the agent in the sidebar, a transcript, and a composer.
- `POST /api/chat` streaming SSE, and reading that agent's thread.
- Conversation store on embedded Postgres. One row per user and agent.
- LLM port with a mock provider and an OpenAI-compatible provider.
- Lint, typecheck, and unit tests in GitHub Actions.

Acceptance criteria:

- [ ] With no API key, a new message streams a mock reply in the transcript.
- [ ] Refreshing the page restores that agent's thread and every message.
- [ ] The sidebar lists the agent and does not offer a new chat. A thread cannot be renamed or deleted.
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

The agent can remember a fact and use it on a later turn of that same thread. Memory is something the person can see and delete.

Build:

- `memories` stored per agent, with soft delete.
- A remember path (a tool, once milestone 2 exists) and a retrieval step that adds matches to the system prompt.
- A memory panel in the workspace.

Acceptance criteria:

- [ ] Asking the agent to remember a fact creates a memory row tied to the agent.
- [ ] A later turn of that agent's thread can use that fact, and the prompt trace in tests shows it in system context rather than as a fake user message.
- [ ] The person can list memories and delete one. A deleted memory is not retrieved again.
- [ ] Memories from a different agent are not retrieved.
- [ ] Tests cover write, retrieve, and delete.

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
- A delegate tool that appends a subtask to the child agent's thread, runs that agent, and returns the result to the parent.
- UI to create an agent and to read a delegation in the parent transcript.

Acceptance criteria:

- [ ] A person can create a second agent with different instructions.
- [ ] The lead agent can delegate a subtask, and the parent transcript shows the delegation and the result.
- [ ] The child agent's one thread is readable on its own and belongs to the child agent. A later handoff appends to that same thread.
- [ ] The child uses its own memories and computer, and it cannot call a connector or a computer it was not granted.
- [ ] A failed child run is visible on the parent turn, and the parent conversation stays usable.
- [ ] Tests cover a successful delegation and a grant refusal.

## After the six

Not scheduled, and not allowed to jump the queue: accounts, sharing a workspace, hosted Postgres as the default, and paying-provider budgets. Hosted Postgres should be a driver change once the schema has something worth operating. Accounts wait until more than one person is a real requirement.
