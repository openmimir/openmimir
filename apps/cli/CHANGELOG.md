# openmimir

## 0.2.0

### Minor Changes

- bf8cc1d: Install with `curl -fsSL https://openmimir.com/install.sh | bash`. Release archives now have stable names (`mimir-darwin-arm64.tar.gz`), OpenCode is optional like Claude Code and Codex, and the default agent is whichever one you have installed.
- ef3bf57: Mimir now drives your OpenCode background service (the server the OpenCode app uses) instead of starting its own, so its messages appear live in your OpenCode windows and running sessions are reported directly. Existing configs switch over automatically.
- 8ce54ed: When a session Mimir gave work to finishes, Mimir reads its reply and answers your question in the conversation (and out loud when voice is on) instead of pasting the agent's raw output. The exact message Mimir sent to a session is always shown. Sessions are either running, needing you, failed or idle; the separate "done" status is gone.
- 6721eb9: Mimir searches every agent's full session history, not just the latest few, so "the older one about abuse detection" is found. While voice is on, a live caption shows what Mimir is hearing as you speak. Vague requests get a clarifying question instead of new work, and by voice Mimir reads back what it is about to start or send and waits for your yes.
- 1bca2b1: Tasks replace workers: Mimir now sees recent sessions in OpenCode, Claude Code and Codex, including ones you started yourself, and can continue any of them without you naming an agent or session. Tasks show up inline in the conversation.
- 8e99031: Mimir is now clearly the master thread over your agent sessions: it detects which sessions are running, including ones in your own terminals; every reply shows what Mimir checked, messaged or started, with live session chips you can open; and the trainer screen shows the conversation and the sessions in focus. "Tasks" are now called sessions.

### Patch Changes

- 71d5744: Messages Mimir sends into a session now carry a `[Mimir · voice/typed · time]` header with your exact words next to Mimir's task, and ask the agent to lead with the answer. Also: the session panel loads a session's latest message when opened (including old Claude Code and Codex sessions), idle sessions no longer repeat an "IDLE" badge, Codex review sub-agents no longer show up as duplicate untitled sessions, a "Reconnecting" banner appears when the connection drops, and the web UI is split into desk and trainer views.
- def88d0: A session that finished shows a subtle green "Finished" in the conversation (until it runs again), and the task Mimir sent is a single collapsed line you can expand, instead of the full dispatch message.
- 190f5e0: Session status no longer sticks on "working" after a session Mimir looked at finishes. Follow-up questions reuse what Mimir already checked instead of checking again, voice no longer says "still checking" for quick lookups, and the trainer's "In focus" list is a fixed set of glanceable rows instead of a scrolling list.
- d2e3159: The trainer screen drops the "In focus" list: the conversation gets the full height, with only approvals, waiting sessions and a running count on top.
- 1bca2b1: Voice requests no longer get lost when live transcription stays silent: Mimir transcribes the microphone audio itself. The voice shortcut is now ⌘⇧Space on macOS.
