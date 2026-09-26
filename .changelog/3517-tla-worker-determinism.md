---
section: Fixed
---

- `scripts/check-tla-models.mjs` no longer runs a `violated`-expectation TLA+
  config with TLC's `-workers auto`: a config that can violate more than one
  invariant could report a different one depending on how TLC's worker
  threads interleave under load. Every `violated`-expectation config now runs
  with a single, pinned worker, so its first-violation verdict is
  deterministic regardless of host contention (refs #3517).
