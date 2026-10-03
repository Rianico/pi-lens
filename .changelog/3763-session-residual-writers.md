---
section: Fixed
audience: user
---

- **Work that finishes after `/new` no longer lands in the next session (refs #3758, #3763)** — A late runner result from an ended session is no longer delivered at a concurrent subagent's turn end, nor when the turn-end cap requeues it for the next turn after that session was replaced. An `ast_grep_replace` or `lsp_navigation` rename, or a pipeline, that finishes after the session was replaced no longer credits, lists, demotes, or marks as analysed or fixed anything in the new session; the change log and the file's change count still record the edit, since its bytes did change. The mutation bridge now ignores a branch epoch above the live one, with one record, instead of silently skipping the write's format pass.
