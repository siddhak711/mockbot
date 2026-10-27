## Spec check

- [ ] This change does not touch the UI or the data model.
- [ ] This change touches the UI or the data model. It keeps the product-model invariants in AGENTS.md:

<!-- If the second box applies, name each invariant this pull request touches and how the change keeps it. -->

Reviewers flag a pull request whose screenshots or recordings contradict those invariants (a conversation list, New chat, rename, delete, or a "Start a conversation" empty state).

## No mock providers outside tests

- [ ] No mock, stub, or fake provider is reachable outside tests. A missing credential fails loudly with a visible error, not a silent mock fallback.
- [ ] Any mock outside tests is behind an opt-in flag such as `MOCK_<SERVICE>=1` (off by default), hard-fails when that flag is set in a production build (`NODE_ENV=production` or `VERCEL_ENV=production`), and labels its output as mock to the user. A silent fallback when a credential is missing blocks this pull request.
- [ ] Grep result for `mock|stub|fake` in the non-test code this pull request touches:

<!-- Paste the command and its output. Explain every hit. -->

## Tool credentials in production

- [ ] This pull request does not add or change a tool.
- [ ] This pull request adds or changes a tool. Each tool's credential source is listed below, and production provides each one. A tool without a production credential fails visibly.

<!-- Per tool: name, credential source (env var or per-user OAuth), proof. Env vars: paste `vercel env ls --environment production` names only, never values. OAuth: screenshot or recording of the OAuth path working live (required); a test log or live API output (a real call returning real data, tokens redacted) may be added. GitHub uses per-user OAuth in production; GITHUB_TOKEN is local dev only. Until per-user GitHub OAuth exists in production, the GitHub tool must fail visibly in production with the message "GitHub not connected". -->

## What changed

## Proof

1. Visual of exactly what changed.
2. Tests that were run, with their results and output.
3. Screenshot or screen recording that proves the change works.
