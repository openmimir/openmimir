---
"openmimir": minor
---

Claude Code asks you through Mimir. Anything it would ask permission for at your desk (editing files, running commands, touching files outside the project) now shows up in Mimir as an approval, instead of being silently refused. With Claude Code's default settings, Mimir-driven Claude sessions could read and report but not change anything.

- Approve on the screen, or by voice after saying "confirm". When Claude offers it, a third button such as "Allow all edits in this session" covers the rest of the session, also in later turns.
- Risky commands (`git push`, deploys, `rm -rf`, `Remove-Item -Recurse`, ...) now wait for an on-screen approval in Claude Code too, instead of being blocked outright. They still wait even if your Claude settings allow them or you run Claude in bypass mode.
- Rejecting a request stops the turn, like pressing Esc in Claude Code.
- A request that can no longer be answered (its session was stopped, or Mimir restarted) disappears instead of lingering.
