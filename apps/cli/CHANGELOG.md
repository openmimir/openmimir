# openmimir

## 0.5.0

### Minor Changes

- 249d2d1: Claude Code sessions that are open in a window now get Mimir's messages right there. If a session is open in a terminal, an IDE such as Orca or VS Code, or the Claude desktop app, Mimir writes into that window through Claude Code's own cross-session messaging (Claude Code 2.1.234 or later), and you watch it work there. Before, Mimir continued the session in a hidden second process, so nothing showed up in the window you were looking at.
  
  - Mimir shows which sessions are open right now, with their live state from Claude Code itself, including when one waits for you in its window (a permission prompt, a question). It tells you when that happens and when the work is done.
  - When you talk about the session you're working in, Mimir looks at the open ones first.
  - Messages arrive as from "@OpenMimir", with your own words on the first line, and run under that window's own permission settings.

## 0.4.0

### Minor Changes

- 58ecf3a: Claude Code asks you through Mimir. Anything it would ask permission for at your desk (editing files, running commands, touching files outside the project) now shows up in Mimir as an approval, instead of being silently refused. With Claude Code's default settings, Mimir-driven Claude sessions could read and report but not change anything.
  
  - Approve on the screen, or by voice after saying "confirm". When Claude offers it, a third button such as "Allow all edits in this session" covers the rest of the session, also in later turns.
  - Risky commands (`git push`, deploys, `rm -rf`, `Remove-Item -Recurse`, ...) now wait for an on-screen approval in Claude Code too, instead of being blocked outright. They still wait even if your Claude settings allow them or you run Claude in bypass mode.
  - Rejecting a request stops the turn, like pressing Esc in Claude Code.
  - A request that can no longer be answered (its session was stopped, or Mimir restarted) disappears instead of lingering.

## 0.3.0

### Minor Changes

- 0049c5a: Windows support, tested on Windows 11 (x64 and Arm). Install with `irm https://openmimir.com/install.ps1 | iex` (no admin rights needed); `mimir.exe` carries its own icon and file details.
  
  - Mimir finds Claude Code, Codex and OpenCode however they were installed: npm's `.cmd` shims run as node + script (no cmd.exe), and the folders agents install into are checked even when they're missing from PATH (Claude Code's Windows installer doesn't add its folder).
  - Prompts go to the agents on stdin, so nothing is lost to Windows command-line quoting or length limits.
  - Risky-command rules cover PowerShell and cmd.exe (`Remove-Item -Recurse`, `rd /s`, `irm ... | iex`, `Stop-Computer`, ...): OpenCode asks, Claude Code gets `PowerShell(...)` deny rules next to its Bash ones, and voice can never approve them.
  - Agents run in their own hidden console, so they can't retitle or write into Mimir's window; Ctrl+C or closing the window stops them with Mimir.
  - `mimir doctor` explains a missing Codex Windows sandbox and an outdated OpenCode 1.
  
  Fixes on every platform:
  
  - Stopping a session stops the agent's whole process tree, not just the agent.
  - Codex's "Reconnecting..." notices no longer fail a turn.
  - Sessions that ended (stopped, failed to log in, or rejected a permission) no longer show as running for ten minutes.
  - OpenCode 1 is reported plainly instead of failing on API errors.
  - Configs saved by Notepad (with a byte order mark) load, and `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` are respected.
  - New installs also look for repositories in `~/code`, `~/source/repos`, `~/Documents/GitHub` and similar folders.

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
