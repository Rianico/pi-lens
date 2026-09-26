# Format drain model

A TLA+ model of one file F and the deferred format drain that pi-lens runs at
`agent_settled` (`runtime-agent-end.ts` `handleAgentEnd`). It runs against
the next agent run, a session replacement (`/new`, fork, resume), and another
pi-lens process. Every config here states its expected verdict on its first
line (see `formal/file-locks/README.md`). The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3527 (the drain outside pi's mutation queue), #3528 (the drain
writes the next session's state), #3529 (the drain's LSP sync).

## What the model covers

- **The agent.** It reads F and edits it. Each edit is a read-modify-write
  under pi's per-file `withFileMutationQueue`. After the write it records its
  own write in the read guard, queues a deferred format, and sends a
  stamped LSP sync of the bytes it read (#3481).
- **pi.** It clears `_isAgentRunActive` before it awaits the `agent_settled`
  handlers. The interactive main loop awaits the prompt, so the next run
  waits for the drain. An RPC prompt (`void session.prompt`) or a host that
  polls `isStreaming` does not wait (`Overlap`). `/new` runs from the editor
  callback while the drain runs, and the drain has no abort signal then.
- **The drain.** It captures the session generation and claims the record
  (`runtime-agent-end.ts` ~147). The format phase (`pipeline.ts`
  `runFormatPhase`, `formatters.ts` `formatFile`) then:
  1. reads `contentBefore`;
  2. spawns an in-place formatter child, which reads F and writes its format
     of what it read;
  3. reads `contentAfter`, then `fileContent` with its stamp.

  The apply loop then records the format (change log, `recordWritten`,
  modified range, turn summary) and resyncs the LSP.

  - The hook bound is `bounded(…, 10 s)`. When it gives up, the handler
    requeues the record and moves on, while the child runs on and writes
    later (`Orphan`).
  - With `FixQueue`, #3561's format hold covers steps 1-3; it is released
    when the phase settles.
  - With `FixQueueHold`, an abandoned child keeps the hold until it has
    written.
- **Another pi-lens process** can format F. Its formatter runs outside this
  process's queue (`ExtWrites`).

A content value is the set of agent edits it contains plus a "formatted"
bit. So a formatter that writes back stale bytes shows up as a missing edit.

## Fix parts

| Constant | Code |
|---|---|
| `FixQueue` | #3561: `holdFileMutationQueue` in the drain's format worker (`runtime-agent-end.ts` ~588), acquired in `runFormatPhase` before `contentBefore` |
| `FixQueueHold` | #3561: the hold's release follows the phase, not the bound (`runtime-agent-end.ts` ~590), and waits for `FormatSummary.abandoned` |
| `FixGen` | #3528: `captureSessionGeneration` before the claim; the requeue, autofix and format bookkeeping go through `guardedWrite` |
| `FixStamp` | #3529: the apply loop passes `result.fileReadStamp` to `resyncLspFile`; the post-exit send carries its own read's stamp |
| `FixOrphanSync` | #3529: once an abandoned phase and its abandoned formatters have settled, a fresh stamped read of F is resynced (`runtime-agent-end.ts` ~614). The read and the send are separate steps, as in the code |
| `GenDropsAll` | mutant only: the generation guard drops every write |

## Invariants

| Invariant | Promise |
|---|---|
| `NoLostEdit` | the drain never overwrites an agent edit (pi `docs/extensions.md` ~1925) |
| `HonestFormatClaim` | what the drain reports as its format (`summary.changed`, the notice, the `fixes` provenance, `recordWritten`) holds no agent edit |
| `LspMatchesDisk` | once quiet, the LSP document holds the bytes on disk; this is also the stamp filter's no-drop direction |
| `NoBlindAllow` | an edit is admitted only after this session showed the agent F |
| `NoCrossSessionWrite` | a drain claimed in one session writes none of the next session's state (catalog shape 22) |
| `NoOwnDrop` | a drain still in its own session keeps every session write (shape 54, the generation guard's no-drop direction) |

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. The configs named after
a bug now model the fixed code. Each fix part keeps a violated witness, so a
change that drops it turns the check red.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `Sequential` | before the fixes, interactive host | pass | 185 |
| `SequentialWide` | the same, wider bounds | pass | 820 |
| `OverlapLostEdit` | fixed code (#3527), next run overlaps the drain | pass | 342 |
| `OverlapClaim` | fixed code (#3527) | pass | 342 |
| `OrphanLostEdit` | fixed code (#3527), the bound abandons the child | pass | 459 |
| `OverlapLsp` | fixed code (#3529) | pass | 342 |
| `OrphanLsp` | fixed code (#3529) | pass | 459 |
| `Straddle` | fixed code (#3528), `/new` during the drain | pass | 458 |
| `StraddleState` | fixed code (#3528), `/new` and an abandoned child | pass | 1,256 |
| `Fix` | all fix parts; overlap, orphan and `/new` on | pass | 1,809 |
| `FixWide` | all fix parts, 3 edits, 6 ops, 3 runs | pass | 39,572 |
| `FixNoQueue` | without `FixQueue` (the drain before #3561) | violated `NoLostEdit` | 598 |
| `FixNoQueueClaim` | the same, checking the claim | violated `HonestFormatClaim` | 357 |
| `FixNoHold` | the hold released at the bound | violated `NoLostEdit` | 769 |
| `FixNoGen` | without `FixGen` (the code before #3528) | violated `NoBlindAllow` | 950 |
| `FixNoGenState` | the same, checking session state | violated `NoCrossSessionWrite` | 153 |
| `MutGenDropsAll` | the guard drops every write | violated `NoOwnDrop` | 184 |
| `FixNoStamp` | without `FixStamp` (the code before #3529) | violated `LspMatchesDisk` | 900 |
| `FixNoOrphanSync` | without `FixOrphanSync` (the code before #3529) | violated `LspMatchesDisk` | 270 |
| `MutNoReset` | non-vacuity: `/new` keeps the read guard | violated `NoBlindAllow` | 369 |
| `FixMtime` | residual #3520: the mtime fallback on | violated `NoBlindAllow` | 420 |
| `FixExtProcess` | residual: another pi-lens process formats F | violated `NoLostEdit` | 181 |

Distinct states at the violation for the violated configs.

## What the model does not cover

- **The hold's release (liveness).** The model has no fairness, so a hold
  that is never released cannot show up as a violation. The code mutation
  that never releases it reds five cases in
  `tests/clients/format-drain-formal.test.ts`.
- **Another pi-lens process** (`FixExtProcess`) is outside this process's
  queue. An in-place `--write` child cannot do the compare-and-swap write
  that would close it.
- **#3520** (`FixMtime`): the read guard's mtime fallback admits a
  session-2 edit from the drain's write alone. It needs its own fix.
- **The actionable-warnings phase** at the end of the drain writes through
  its own mutation context and is not modelled.
