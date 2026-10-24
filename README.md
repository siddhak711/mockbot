# Mockbot

Mockbot is a personal agent workspace. The product grows in six steps: a single chat agent, tools and connectors, durable memory, a sandboxed computer per agent, routines, and multi-agent coordination.

The build order and the acceptance criteria for each step are in [docs/ROADMAP.md](docs/ROADMAP.md). This repository currently holds that roadmap and the TypeScript tooling used to check later work.

## Checks

Requires Node.js 22 or newer.

```bash
npm install
npm run lint
npm run typecheck
npm run format:check
npm run test
```

`npm run format` rewrites files with Prettier. GitHub Actions runs lint, typecheck, the format check, and tests on every push and pull request.
