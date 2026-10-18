---
"openmimir": minor
---

Windows support. Install with `irm https://openmimir.com/install.ps1 | iex` (no admin rights needed). Mimir finds Claude Code, Codex and OpenCode however they were installed, including npm's `.cmd` shims; sends prompts on stdin so nothing is lost to Windows command-line quoting; adds PowerShell and cmd.exe equivalents of its risky-command rules (Claude Code gets `PowerShell(...)` deny rules next to its Bash ones); stops an agent's whole process tree when you stop a session (on macOS too, which used to leave an agent's own child processes running); and respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME`. New installs also look for repositories in more common folders, such as `~/code`, `~/source/repos` and `~/Documents/GitHub`.
