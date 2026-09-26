---
section: Fixed
---

- When pi replaces a session inside the same process (for example, resuming a
  session from another directory), the ended session's project root no longer
  stays in, or comes back into, the instance registry. Before, a shutdown that
  met this process's own registry write left the old root behind, a
  registration still waiting for the lock re-created it after shutdown, and
  such a registration could point the heartbeat's repair at the old root so the
  live root was never re-registered. Peers in the old root then saw a live
  pi-lens there: the shared-checkout guard reported false positives and warm
  attach could pick this process. A registration made before shutdown now drops
  itself if it runs after it, and a removal that cannot take the lock at
  shutdown is queued behind the holder instead of being skipped (closes #3498).
