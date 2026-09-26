---
section: Fixed
---

- **A tool result that pi-lens was still analysing when a new session started no longer writes into the new session (closes #3568)** — pi-lens stops waiting for a slow tool result after its time budget but does not cancel it, so its analysis can finish after `/new`, a fork, or a resume. pi-lens took note of which session the result belonged to only after its first waits (bash change recovery, loading the analysers, joining an analysis already running), so a result that resumed after the switch counted as the new session's: its blocker, cascade, warnings and late runner findings landed there. pi-lens now notes the session before the first wait, for the bash-derived writes it analyses and for every file an unknown tool changed, records the turn's warnings only for that session, and drops a slow runner's result deferred after the switch instead of delivering it at the new session's turn end. Each dropped write is counted once in the degradation report.
