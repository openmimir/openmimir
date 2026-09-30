# Architecture

Mimir is one server process on the user's Mac. Every interface (desk chat, trainer screen, later a
desktop app and phone calls) is a client of that server.

```
Browser tab ──WebRTC audio──────────────────────────► OpenAI GPT-Live
    │  HTTP + WebSocket                                     │
    ▼                                                       │ sideband WebSocket
Mimir server (apps/cli) ◄───────────────────────────────────┘
    ├─ Foreman (packages/core)    frontier model + tools, one ongoing conversation
    ├─ WorkerManager              worker state, approvals, announcements
    ├─ Store                      SQLite in ~/.openmimir/mimir.db
    └─ Adapters (packages/adapters)
          └─ OpenCode v2 server (`opencode serve`, started by Mimir if needed)
```

## The foreman

`packages/core/src/foreman.ts`. One conversation, persisted in SQLite. Each request gets:

- a fixed system prompt (role, rules, approval policy),
- a **state summary** rebuilt every turn: known projects, workers and their status, pending
  approvals. This keeps the context small; details stay inside each worker's own session and are
  fetched with tools when needed.
- the last 40 messages.

Requests are handled one at a time so the conversation stays ordered. Tools: `list_projects`,
`start_worker`, `message_worker`, `worker_status`, `worker_changes`, `stop_worker`,
`resolve_approval`.

Replies adapt to the channel: markdown for the keyboard, two or three spoken sentences for voice.

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
4. Worker events (finished, failed, needs approval) are queued and injected with
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
