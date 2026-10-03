# Pending runner store model

A TLA+ model of the deferred collect-later runner store
(`clients/dispatch/pending-runner-findings.ts`) across a same-process scope
retirement. Every config here states its expected verdict on its first line,
and the `TLA+ models` CI job (`node scripts/check-tla-models.mjs`) checks them
all.

Issues: #3758 (the store's session fence) and #3813/#3824 (the turn-end cap's
requeue).

## What the model covers

- **The producer admission** (`deferRunnerFindings`). It fences with the
  generation it captured, so an entry enters only from a live scope or from a
  released writer with no captured handle (shape 57). The model keeps the
  producer's true generation separately from the generation the fence reads off
  the entry, so a requeue that lost `entry.session` is visible.
- **The turn-end drain** (`drainPendingRunnerFindings`). It removes the settled
  answers it admits, drops the settled ones its fence rejects, and keeps
  in-flight work for the store.
- **The requeue** (`requeueRunnerFindings`, #3813). A drained, settled answer
  re-enters the store when the delivery cap cut it. It carries
  `entry.session` unless the `Requeue = "drop"` mutant loses it.
- **The window the fence defends.** A raw generation bump retires a scope with
  no store clear. `session_start` clears the store before it bumps the scope
  (`clients/runtime-session.ts`: `resetPendingRunnerFindings` then
  `runtime.resetForSession`), so the model explores the gap before that clear
  that #3824's drain fence was written for.

## Invariants

- `NoStaleAdmission` (shape 54, safety): the reader admits no answer whose
  producer scope has retired.
- `NoDropFreshAnswer` (shape 54, no-drop): the reader drops no answer whose
  producer scope is live, nor a released writer's unfenced answer.

## Configs

| Config | Expect | What it proves |
|---|---|---|
| `Shipped` | pass | The drain fences, the requeue carries the owner, and a released writer's no-handle deferral is admitted. |
| `UnfencedDrain` | violated `NoStaleAdmission` | The drain fence is load-bearing. |
| `RequeueDropsOwner` | violated `NoStaleAdmission` | The requeue must carry `entry.session`; losing it makes a later retirement unable to reject the answer. |
| `NoHandleDropped` | violated `NoDropFreshAnswer` | A released writer's no-handle deferral must not be fenced out. |
| `OverDropDrain` | violated `NoDropFreshAnswer` | A drain that drops the live answer loses delivery. |

## What the model cannot see

- The commit gate's non-draining peek (`#3814`) is a separate lane and is not
  modelled here; this family covers the drain and the requeue only.
- Time. The drain's `maxWaitMs` and the freshness gate's mtime verdict are not
  modelled; a stale answer here means a retired producer scope, not an older
  file edit (`dropStaleRunnerFindings`).
- The store's 50-entry cap and its eviction record.

## Replay on the real code

`tests/clients/dispatch/runner-collect-later.test.ts` pins the store's requeue
round-trip on the drain; the stale direction is reproduced with a raw
`GenerationSource` bump as #3824 does.
`tests/clients/turn-end-cap-consumed-state.test.ts` drives the real
`handleTurnEnd` cap cut, the delivery hold's `onHeld` requeue and the
successor's own turn end (M3c). `tests/clients/session-generation-properties.test.ts`
drives the production enqueue, drain and requeue under a scheduler, with the
safety and no-drop directions and the no-handle arm.
