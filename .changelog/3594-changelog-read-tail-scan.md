---
section: Fixed
---

- **The first logged edit after a slow session start no longer reads the whole change log to find its own seq (closes #3594)** — after #3595 moved that read outside the change-log lock, it still read the log forward from byte 0 on the main thread once per session, costing 0.8-1.6 s on a 150 MB log. pi-lens now scans backward from the end instead: one small window (grown only if needed), taking the max seq among the complete lines it finds there. An unlocked writer's line can still land in the log after a lower-seq line that read past it while it was incomplete, so a window whose own last line is not (at least tied for) its own max is not trusted — the scan grows past it, converging on a full read exactly when that disorder is present, never when the log is ordinary. A probe against a 160 MB log: 1337.9 ms before, 2.4-6.7 ms after.
