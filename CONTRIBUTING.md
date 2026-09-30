# Contributing to OpenMimir

Thanks for helping. This is a young project, so issues that describe how you want to use Mimir are
as valuable as code.

## Setup

```sh
bun install
bun run dev            # build the web UI, start the server on :4747
```

UI work: run `bun run dev:server` and `bun run dev:web` together and open <http://localhost:5173>.

You need OpenCode v2 on your PATH and an `OPENAI_API_KEY` for voice. Use a separate `MIMIR_HOME`
(for example `MIMIR_HOME=/tmp/mimir-dev`) to keep your real config and history out of the way.

## Before you open a pull request

```sh
bun run lint           # Biome (lint + format check); `bun run format` fixes formatting
bun run typecheck
bun test
```

- Keep changes focused; one topic per pull request.
- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`.
- If the change affects users, add a changeset: `bun run changeset`, pick `openmimir`, choose
  patch/minor, and write one line for the changelog.

## Layout

```
packages/protocol   shared types between server and interfaces
packages/core       foreman, worker manager, approvals, config, SQLite store
packages/adapters   coding-agent adapters (OpenCode)
packages/voice      GPT-Live session + sideband
apps/cli            the `mimir` command and HTTP/WebSocket server
apps/web            React UI (desk + trainer modes)
```

Architecture notes: [docs/architecture.md](docs/architecture.md).

## Adding an agent adapter

Implement `AgentAdapter` from `packages/adapters/src/types.ts`. The core only talks to agents
through that interface. Map the agent's own events to `AdapterEvent`s and keep anything
agent-specific inside the adapter.

## Releases

Maintainers merge the "Version packages" pull request that Changesets opens. Tagging `vX.Y.Z` builds
the macOS binaries and attaches them to a GitHub Release.
