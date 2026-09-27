---
section: Fixed
---

- **A stuck holder of the durable-store lock cost one 500 ms wait per call, not one total (refs #3594)** — `acquireBoundedPidFileLock`, the synchronous cross-process lock behind `commitDurableStore` (dispositions, actionable-warnings, the installer's state), waited the full 500 ms afresh on every call while another process held it, the same shape #3578 already fixed for the change-log and snapshot cache locks. After a wait runs out, pi-lens now remembers that holder, named by its lock generation file. A later call that finds the same holder still on top tries once and falls back at once, exactly as a timed-out wait does — throwing, or returning `null` under `onContention: "skip-log"`. A new holder, or one whose generation aged past its lease, gets the full wait again. The first skip on each lock is recorded once per session as `bounded-pid-lock-wait-skipped`.
