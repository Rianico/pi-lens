# Session lifecycle: instance-registry model (#3498)

A TLA+ model of one pi process's `instances.json` entry across a session
replacement, against the heartbeat's re-registration (#3447). Every config
states its expected verdict on its first line (see `formal/file-locks/README.md`);
the `TLA+ models` CI job checks them all.

## What the model covers

- **Two sessions in one process.** Session 1 serves root `A`; after its
  `session_shutdown`, session 2 serves root `B`. pi's `switchSession` rebuilds
  the runtime with the resumed session's cwd, and the registry tail and intent
  are process singletons, so they carry over.
- **`session_start`**: `void registerInstance(cwd)` (`index.ts`), queued on the
  process-wide tail (`queueRegistryMutation`). `registerInstanceNow` sets the
  intent before it takes the lock, then merges the root into the entry under
  the async lock.
- **`session_shutdown`**: `deregisterInstance()` (`index.ts`). It clears the
  intent, then removes the entry under a sync lock that bypasses the tail. The
  lock is not re-entrant (`generation-lock.ts` `tryAcquireGeneration`), and the
  sync wait uses `Atomics.wait`, which blocks the event loop. So if this
  process's own async op holds the lock, the holder cannot release it, and
  after 500 ms the sync removal gives up.
- **The heartbeat** (`updateHeartbeat`), fire-and-forget from turn_end and
  from the quiet window. Under the lock it notes whether the entry is missing.
  After the lock it re-registers from the intent with a queued
  `registerInstance`.
- **An LSP spawn** per session: `void recordLspChild(...)`
  (`clients/lsp/client.ts`), queued on the tail. With no entry it synthesizes
  one carrying the session's root as a service cwd.
- **A declined secondary's shutdown** per session: `deregisterInstanceRoot`,
  queued on the tail. While the entry still holds the session's root it
  re-arms the intent to that root. The secondary's own root is not modelled,
  only this intent write.
- **Another pi process** that can hold the machine-wide lock. A contender
  whose wait runs out drops its write (`instance-registry-lock-timeout`).

`deregisterInstance` advances a process-wide registration generation
(`createGenerationSource`, held in a process singleton), and each writer below
captures it when it is called. `FixParts` switches on the parts of the fix,
which the code now has:

1. `generation`: a registration whose generation moved drops itself before it
   sets the intent, and again under the lock before it writes
   (`instance-registry-registration-superseded`).
2. `child`: `recordLspChild` synthesizes no entry once its generation moved
   (review round 1, F2).
3. `rootIntent`: `deregisterInstanceRoot` re-arms the intent only while its
   generation holds (review round 1, F1).
4. `retry`: when the sync removal cannot take the lock, it is queued on the
   tail (`instance-registry-deregister-queued`). It runs after the op holding
   the lock, waits for the lock instead of dropping, and records
   `instance-registry-deregister-landed` when it runs.

## Invariants

- `NoGhostRoot`: every root in the entry is the live session's root. An ended
  session never re-registers. The fix's own queued removal is the only
  exception, until it lands.
- `LiveRepairable`: while a session is live, one of these holds:
  - its root is in the entry;
  - a registration for its root is still queued;
  - the heartbeat can still repair it from the intent.

  So a live session is never dropped for good.

## Results

| Config | Expect | Before the fix (`FixParts = {}`) |
|---|---|---|
| `Replacement` | pass | violated `NoGhostRoot` (own hold) |
| `ReplacementContention` | pass | violated `NoGhostRoot` (late landing) |
| `StaleIntent` | pass | violated `LiveRepairable` (stale intent) |
| `FixNoRetry` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoRegGate` (fix mutant) | violated `NoGhostRoot` | |
| `StaleIntentNoRegGate` (fix mutant) | violated `LiveRepairable` | |
| `FixNoChildGate` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoRootIntentGate` (fix mutant) | violated `NoGhostRoot` | |
| `FixNoClearIntent` (guard mutant) | violated `NoGhostRoot` | |
| `FixNoHbRepair` (guard mutant) | violated `LiveRepairable` | |

The counterexamples before the fix:

- **Own hold (`Replacement`):** session 1's heartbeat or registration holds
  the lock, and `session_shutdown` runs. The sync removal meets this process's
  own hold and gives up. The entry keeps `A` after the session ended.
- **Late landing (`ReplacementContention`, `FixNoRegGate`):** a queued
  registration is still waiting (a peer holds the lock) when shutdown removes
  the entry. It lands afterwards and re-creates the entry with `A`.
- **LSP child (`FixNoChildGate`):** a child recorded in session 1 is still
  queued at shutdown; it finds no entry and synthesizes one with `A`.
- **Secondary's removal (`FixNoRootIntentGate`):** a peer holds the lock, so
  shutdown's removal queues behind a secondary's removal that session 1
  queued. That removal still finds `A` in the entry and re-arms the intent to
  `A`; the queued removal lands; session 2's heartbeat finds no entry and
  re-registers `A` with the current generation.
- **`StaleIntent`:**
  1. Session 1's registration starts only after session 1 ended, so it sets
     the intent to `A`.
  2. Session 2's heartbeat finds no entry and re-registers from that intent,
     which is `A`.
  3. Session 2's own `B` registration times out.
  4. From then on the entry holds `A`, and heartbeats see an entry, so they
     never repair `B`.

Each has a replay on the real registry in
`tests/clients/instance-registry-session-replacement.test.ts`, red before the
fix.

## Where the code differs from the model

- **The heartbeat's repair captures the generation at its `registerInstance`
  call**, after the heartbeat's lock, not at heartbeat entry. #3498 proposed
  the entry capture. The model passes without it, because the intent clear in
  `deregisterInstance` already keeps the only stale input away from the
  repair: with the intent kept, `FixNoClearIntent` re-registers the ended root
  (`NoGhostRoot`) instead of only losing the live one.
- **The queued removal waits through the lock lease** (`LOCK_WAIT_THROUGH_LEASE_MS`,
  5.5 s), not forever. A generation or an older writer's lock file past the
  5 s lease is taken over, so a single hold cannot outlast it; a filesystem
  error, or a stream of other writers that keeps winning the lock, still can.
  The lock records `instance-registry-lock-timeout` when it does.
- A heartbeat's own lock hold is milliseconds, and the model lets it last
  arbitrarily long. The replay forces the overlap by running shutdown while
  the heartbeat's read of the registry is in flight.

## Scope

Not modelled:

- a secondary's own root: `registerInstanceRoot` never creates an entry,
  and `deregisterInstanceRoot`'s only write that can outlive the session is
  its intent re-arm, which is modelled;
- `removeLspChild`, which never creates an entry or writes the intent;
- the reaper and dead-pid pruning. A process that exits after the ghost write
  is pruned by readers, so the harm needs the process to live on, which is
  what a replacement does;
- `writeRegistryWithRetry`'s re-read loop.
