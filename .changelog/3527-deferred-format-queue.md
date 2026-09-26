---
section: Fixed
---

- **The formatting pi-lens does at the end of the agent's run no longer erases, or takes credit for, an edit from the agent's next run (closes #3527)** — On an RPC or SDK host the next run can start while pi-lens is still formatting the files from the last one, and on any host a formatter that runs past pi-lens' 10-second wait keeps running after pi-lens has moved on. Such a formatter could write its format of the older file over the next run's edit, and an edit made while it ran could be reported as pi-lens' own formatting. The end-of-run formatter now takes its turn in pi's queue for the file (the same change that fixed #3506), and keeps it until it has exited, so the next run's edit lands after the formatter.
