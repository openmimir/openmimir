---
"openmimir": minor
---

Windows support, tested on Windows 11 (x64 and Arm). Install with `irm https://openmimir.com/install.ps1 | iex` (no admin rights needed); `mimir.exe` carries its own icon and file details.

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
