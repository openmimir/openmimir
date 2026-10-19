---
"openmimir": minor
---

Claude Code sessions that are open in a window now get Mimir's messages right there. If a session is open in a terminal, an IDE such as Orca or VS Code, or the Claude desktop app, Mimir writes into that window through Claude Code's own cross-session messaging (Claude Code 2.1.234 or later), and you watch it work there. Before, Mimir continued the session in a hidden second process, so nothing showed up in the window you were looking at.

- Mimir shows which sessions are open right now, with their live state from Claude Code itself, including when one waits for you in its window (a permission prompt, a question). It tells you when that happens and when the work is done.
- When you talk about the session you're working in, Mimir looks at the open ones first.
- Messages arrive as from "@OpenMimir", with your own words on the first line, and run under that window's own permission settings.
