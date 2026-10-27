## Spec check

- [ ] This change does not touch the UI or the data model.
- [ ] This change touches the UI or the data model. It keeps the product-model invariants in AGENTS.md:

<!-- If the second box applies, name each invariant this pull request touches and how the change keeps it. -->

Reviewers flag a pull request whose screenshots or recordings contradict those invariants (a conversation list, New chat, rename, delete, or a "Start a conversation" empty state).

## No mock providers outside tests

- [ ] No mock, stub, or fake provider is reachable outside tests. A missing credential fails loudly with a visible error, not a silent mock fallback.
- [ ] Grep result for `mock|stub|fake` in the non-test code this pull request touches:

<!-- Paste the command and its output. Explain every hit. -->

## What changed

## Proof

1. Visual of exactly what changed.
2. Tests that were run, with their results and output.
3. Screenshot or screen recording that proves the change works.
