# Format drain model

A TLA+ model of one file F and the deferred format drain that pi-lens runs at
`agent_settled` (`runtime-agent-end.ts` `handleAgentEnd`). It runs against
the next agent run, a session replacement (`/new`, fork, resume), and another
pi-lens process. Every config here states its expected verdict on its first
line (see `formal/file-locks/README.md`). The `TLA+ models` CI job
(`node scripts/check-tla-models.mjs`) checks them all.

Issues: #3527 (the drain outside pi's mutation queue), #3528 (the drain
writes the next session's state), #3529 (the drain's LSP sync), #3576 (the
retire without a session bump, and the held resync R1).

## What the model covers

- **The agent.** It reads F and edits it. A read sends its read-warm touch:
  a stamped LSP sync of the bytes it read (`runtime-tool-call.ts` ~833), outside
  pi's queue, which opens F again in a service `/new` retired (#3576 R1). Each
  edit is a read-modify-write under pi's per-file `withFileMutationQueue`.
  After the write it records its own write in the read guard, queues a
  deferred format, and sends a stamped LSP sync of the bytes it read (#3481).
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
- **`/new`** (or fork, resume) resets the session state and retires the
  LSP service (`resetLSPService`). The next touch opens a fresh document, so
  a drain touch after the reset would spawn a server for the next session
  (review round 1, F1). The model closes the LSP document at `NewSession`.
- **A retire without a session bump** (`IdleRetire`, #3576): `session_shutdown`
  and the idle reset call `resetLSPService` but not `resetForSession`
  (`Retire`). Both bump the LSP service generation (`lsp-launch-availability`,
  `clients/lsp/server.ts`), as `NewSession` does.
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
| `LspGen` | #3528 r1 F1: the drain's LSP sends (the in-hook format and autofix resyncs and the post-exit resync) run only while its session is current |
| `StartGen` | #3528 r1 F1: after `/new`, the format worker and the autofix loop start no new file; that write's sync would be skipped |
| `ServiceGen` | #3576: the drain's LSP sends also check the LSP service generation it captured (`captureLspServiceGeneration`), so a retire without a session bump stops them too |
| `HeldResync` | #3576 R1: a drain send whose session or service was replaced goes only to a document a live client already holds, from a fresh read of F (`resyncHeldLspDocument`: `peekLSPService` and `resyncGitChangedFiles`); it never opens one |
| `GenDropsAll` | mutant only: the session guard drops every write and every drain send |

## Invariants

| Invariant | Promise |
|---|---|
| `NoLostEdit` | the drain never overwrites an agent edit (pi `docs/extensions.md` ~1925) |
| `HonestFormatClaim` | what the drain reports as its format (`summary.changed`, the notice, the `fixes` provenance, `recordWritten`) holds no agent edit |
| `LspMatchesDisk` | once quiet, an open LSP document holds the bytes on disk; this is also the no-drop direction of the stamp filter and of the session guard on the drain's sends. A retired service has no open document until its session's next touch |
| `NoBlindAllow` | an edit is admitted only after this session showed the agent F |
| `NoCrossSessionWrite` | a drain claimed in one session writes none of the next session's state (catalog shape 22), and opens no document in its fresh LSP service. The R1 resync of a document the next session already holds is not such a write |
| `NoDrainRespawn` | a drain never opens a document on an LSP service retired since it started (#234, #3576) |
| `NoOwnDrop` | a drain still in its own session keeps every session write (shape 54, the generation guard's no-drop direction) |

## Results

TLC 2.19 (`tla2tools.jar` v1.7.4), `-workers auto`. The configs named after
a bug now model the fixed code. Each fix part keeps a violated witness, so a
change that drops it turns the check red.

| Config | Models | Expect | Distinct states |
|---|---|---|---|
| `Sequential` | before the fixes, interactive host | pass | 341 |
| `SequentialWide` | the same, wider bounds | pass | 2,540 |
| `OverlapLostEdit` | fixed code (#3527), next run overlaps the drain | pass | 642 |
| `OverlapClaim` | fixed code (#3527) | pass | 642 |
| `OrphanLostEdit` | fixed code (#3527), the bound abandons the child | pass | 933 |
| `OverlapLsp` | fixed code (#3529) | pass | 642 |
| `OrphanLsp` | fixed code (#3529) | pass | 933 |
| `Straddle` | fixed code (#3528), `/new` during the drain | pass | 922 |
| `StraddleState` | fixed code (#3528), `/new` and an abandoned child | pass | 2,611 |
| `Fix` | all fix parts; overlap, orphan, `/new` and a retire without a session bump on | pass | 13,959 |
| `FixWide` | all fix parts, 3 edits, 6 ops, 3 runs | pass | 122,040 |
| `FixNoQueue` | without `FixQueue` (the drain before #3561) | violated `NoLostEdit` | 830 |
| `FixNoQueueClaim` | the same, checking the claim | violated `HonestFormatClaim` | 631 |
| `FixNoHold` | the hold released at the bound | violated `NoLostEdit` | 1,026 |
| `FixNoGen` | without `FixGen` (the code before #3528) | violated `NoBlindAllow` | 1,448 |
| `FixNoGenState` | the same, checking session state | violated `NoCrossSessionWrite` | 265 |
| `FixNoLspGen` | without `LspGen` or `ServiceGen` (the round-0 code of #3528) | violated `NoCrossSessionWrite` | 830 |
| `FixNoStartGen` | without `StartGen` or `HeldResync`: the old drain formats a file the new session has open | violated `LspMatchesDisk` | 1,275 |
| `FixNoHeldResync` | without `HeldResync` (the code before #3576): the #3528 R1 trace | violated `LspMatchesDisk` | 1,305 |
| `FixNoServiceGen` | without `ServiceGen` (the code before #3576): a retire without a session bump | violated `NoDrainRespawn` | 2,336 |
| `MutGenDropsAll` | the guard drops every write | violated `NoOwnDrop` | 243 |
| `MutGenDropsAllLsp` | the guard drops every drain send, the held resync included | violated `LspMatchesDisk` | 673 |
| `FixNoStamp` | without `FixStamp` (the code before #3529) | violated `LspMatchesDisk` | 1,844 |
| `FixNoOrphanSync` | without `FixOrphanSync` (the code before #3529) | violated `LspMatchesDisk` | 400 |
| `MutNoReset` | non-vacuity: `/new` keeps the read guard | violated `NoBlindAllow` | 556 |
| `FixMtime` | residual #3520: the mtime fallback on | violated `NoBlindAllow` | 560 |
| `FixExtProcess` | residual: another pi-lens process formats F | violated `NoLostEdit` | 160 |

Distinct states at the violation for the violated configs. #3576 made every
count grow: the agent's read now sends, and the service generation is state.

Two fix parts now overlap in the model, and the code keeps both:

- `ServiceGen` covers `/new` for the LSP sends on its own, because
  `NewSession` always retires the service (`session_start` resets it unless
  `--no-lsp`, where the drain sends nothing). `FixNoLspGen` therefore turns
  both off. The code's session half is what the replays in
  `tests/clients/format-drain-formal.test.ts` pin with a session reset alone.
- `HeldResync` covers the LSP consequence `StartGen` was the witness for, so
  `FixNoStartGen` turns both off. The start check still keeps a replaced
  drain from writing files the next session edits.

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
  its own mutation context and is not modelled. Since #3576 it starts only
  while the drain's session and LSP service are current, starts no edit after
  `/new`, and its in-flight edit's bookkeeping drops; the replays are in
  `tests/clients/format-drain-formal.test.ts` and
  `tests/clients/actionable-warnings-agreement.test.ts`.
