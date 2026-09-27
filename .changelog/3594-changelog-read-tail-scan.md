---
section: Fixed
---

- **The first logged edit after a slow session start no longer reads the whole change log to find its own seq (closes #3594)** — after #3595 moved that read outside the change-log lock, it still read the log forward from byte 0 on the main thread once per session, costing 0.8-1.6 s on a 150 MB log. The log's own invariant (every entry's seq is above every entry before it) means the LAST line always carries the true max, so pi-lens now scans backward for it instead: one small window near the end (grown only if a single line is unusually long), not a forward walk over every line before it. A probe against a 160 MB log: 1337.9 ms before, 2.4-6.7 ms after.
