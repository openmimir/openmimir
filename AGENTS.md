# OpenMimir: notes for coding agents

TypeScript monorepo on Bun. Read `docs/architecture.md` before larger changes.

- Install: `bun install`. Run: `bun run dev` (server on :4747 with the built UI).
- Checks before finishing: `bun run lint`, `bun run typecheck`, `bun test`.
- Use a throwaway `MIMIR_HOME` when running the server so the real `~/.openmimir` is untouched.
- Workspace packages export their `src/index.ts` directly; there is no per-package build.
- Shared types between server and UI live in `packages/protocol`. Change them there first.
- Agents are only reached through the `AgentAdapter` interface in `packages/adapters`.
- Approval rules must be enforced in code (`packages/core/src/policy.ts`), never only in prompts.
- OpenCode integration targets the v2 HTTP API (`/api/...`, SSE at `/api/event`).
- GPT-Live integration uses client delegation and a sideband socket; see `packages/voice`.
- Commits: Conventional Commits. User-facing changes get a changeset (`bun run changeset`).
- Never add `Co-Authored-By` trailers.
