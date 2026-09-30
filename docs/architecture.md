# Architecture

Mimir is one server process on the user's Mac. Every interface (desk chat, trainer screen, later a
desktop app and phone calls) is a client of that server.

```
Browser tab ──WebRTC audio──────────────────────────► OpenAI GPT-Live
    │  HTTP + WebSocket                                     │
    ▼                                                       │ sideband WebSocket
Mimir server (apps/cli) ◄───────────────────────────────────┘
    ├─ Foreman (packages/core)    frontier model + tools, one ongoing conversation
    ├─ SessionManager             sessions across agents, approvals, announcements
    ├─ Store                      SQLite in ~/.openmimir/mimir.db
    └─ Adapters (packages/adapters)
          ├─ OpenCode background service (the one the OpenCode app uses)
          ├─ Claude Code (`claude -p`, transcripts in ~/.claude/projects)
          └─ Codex (`codex exec`, rollouts in ~/.codex/sessions)
```

## The foreman

`packages/core/src/foreman.ts`. One conversation, persisted in SQLite. Each request gets:

- a fixed system prompt (role, rules, approval policy),
- a **state summary** rebuilt every turn: known projects, recent sessions across all agents (including
  sessions the user started outside Mimir), pending approvals. This keeps the context small; details
  stay inside each agent's own session and are
  fetched with tools when needed.
- the last 40 messages.

Requests are handled one at a time so the conversation stays ordered. Tools: `list_projects`,
`recent_sessions`, `start_session`, `message_session`, `session_status`, `session_changes`, `stop_session`,
`resolve_approval`.

Replies adapt to the channel: markdown for the keyboard, two or three spoken sentences for voice.

## Sessions and agents

Mimir is the master thread above every agent session. Sessions are keyed `${agent}:${externalId}`. Each adapter can list its recent
sessions (`listRecent`), so the foreman sees what the user did at their desk, not just what Mimir
started. Continuing an existing session is the same call as following up on one Mimir started.

- **OpenCode** is driven over the HTTP API and event stream of the user's OpenCode background service
  (found with `opencode service status`). Using that server, not a separate one, matters: OpenCode
  apps only update live from their own server, so messages written by another server stay invisible
  until the session is reopened. Mimir starts a private `opencode serve` only if no service exists. It supports approvals, so Mimir adds
  session rules that force risky shell commands to ask (merged with the session's own rules).
- **Claude Code** runs one headless turn per message (`claude -p --resume <id>`). Risky commands are
  blocked with `--disallowedTools`, since it cannot pause for Mimir's approval.
- **Codex** runs `codex exec [resume <id>] --json` and relies on the user's Codex sandbox settings.

Sessions touched outside Mimir in the last few minutes may be open on the user's screen; the foreman
asks before sending to them.

Only sessions Mimir started or continued get spoken updates. The rest are shown, not narrated.

## Voice

`packages/voice/src/live.ts`, using GPT-Live with **client delegation**:

1. The browser creates a WebRTC offer (mic track + `oai-events` data channel) and posts it to
   `POST /api/voice/session`.
2. The server calls `POST /v1/live/sessions` with the conversation prompt, recent history and
   `delegation: { type: "client" }`, and returns the SDP answer. Audio then flows directly between
   the browser and OpenAI; the browser's WebRTC stack provides echo cancellation.
3. The server attaches a **sideband** WebSocket (`/v1/live/sessions/{id}/attach`). It assembles
   transcript deltas into turns (captions for every interface), and when GPT-Live emits
   `session.delegation.created`, it hands what the user said to the foreman. Progress goes back as
   `session.thinking.append`; the answer as `session.commentary.append`.
4. Session events (finished, failed, needs approval) are queued and injected with
   `session.commentary.append` once nobody has spoken for 1.5 seconds.

## Approvals

OpenCode asks permission for some actions. Mimir classifies each request
(`packages/core/src/policy.ts`):

- `confirm`: may be approved by voice after the user explicitly says "confirm".
- `screen`: pushes, deploys, deletes, `sudo`, etc. Only approvable from a screen.

Rejecting is always allowed. The rule is enforced in code, not only in the prompt.

## Security

See [SECURITY.md](../SECURITY.md). In short: loopback-only by default, a per-install token on every
API call, Host-header checks against DNS rebinding, and cookie-based pairing for other devices.

## Versioning

- One version for the product (`openmimir`); the web UI is built into it.
- Config (`version` field) and the SQLite schema (`meta.schema`) migrate forward on startup. The
  config is backed up before migrating. Older builds refuse to run against newer data.
- Open browser tabs reload when the server reports a different version.
