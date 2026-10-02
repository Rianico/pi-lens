---
section: Fixed
audience: user
---

- Reading an empty file no longer blocks the first edit to it (refs #3652) — a
  zero-line read of a genuinely empty file now authorizes the subsequent edit
  instead of failing with an unresolvable `zero-read` block.
