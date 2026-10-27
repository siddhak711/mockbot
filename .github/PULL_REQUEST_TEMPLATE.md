## Spec check

- [ ] This change does not touch the UI or the data model.
- [ ] This change touches the UI or the data model. It keeps the product-model invariants in AGENTS.md:

<!-- If the second box applies, name each invariant this pull request touches and how the change keeps it. -->

Reviewers flag a pull request whose screenshots or recordings contradict those invariants (a conversation list, New chat, rename, delete, or a "Start a conversation" empty state).

## No mock providers outside tests

- [ ] No mock, stub, or fake provider is reachable outside tests. A missing credential fails loudly with a visible error, not a silent mock fallback.
- [ ] Grep result for `mock|stub|fake` in the non-test code this pull request touches:

<!-- Paste the command and its output. Explain every hit. -->

## Tool credentials in production

- [ ] This pull request does not add or change a tool.
- [ ] This pull request adds or changes a tool. Each tool's credential source is listed below, and production provides each one. A tool without a production credential fails visibly.

<!-- Per tool: name, credential source (env var or per-user OAuth), proof. Env vars: paste `vercel env ls --environment production` names only, never values. OAuth: screenshot or recording of the OAuth path working live. GitHub uses per-user OAuth in production; GITHUB_TOKEN is local dev only. -->

## What changed

## Proof

1. Visual of exactly what changed.
2. Tests that were run, with their results and output.
3. Screenshot or screen recording that proves the change works.
