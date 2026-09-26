---
section: Fixed
---

- **Starting a new session while pi-lens is still formatting no longer lets the old session's formatting authorize edits in the new one (closes #3528)** — `/new`, a fork, or a resume can run while pi-lens is still formatting the files from the last run. When that formatting finished, pi-lens recorded it in the new session: the read guard then treated the file as written in the new session and allowed an edit the agent had never read there, and the change log, turn state, turn summary and deferred-format queue of the new session picked up the old session's work. pi-lens now records the formatting (and the end-of-run autofix) only while the session that started it is still current; a dropped record is counted once in the degradation report. The files are still formatted.
