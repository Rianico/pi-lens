---------------------------- MODULE FormatDrain ----------------------------
(***************************************************************************)
(* One file F and the deferred format/autofix drain that pi-lens runs at    *)
(* `agent_settled` (index.ts runDeferredMutationDrain ->                    *)
(* runtime-agent-end.ts handleAgentEnd), against the next run, a session    *)
(* replacement and another pi-lens process. Issues #3527, #3528, #3529.     *)
(*                                                                          *)
(* Actors:                                                                  *)
(*  - the agent: Read, and Edit = guard check (read-guard.ts checkEdit:     *)
(*    a read this session, or wasWrittenThisSession), then a                *)
(*    read-modify-write under pi's per-file withFileMutationQueue           *)
(*    (core/tools/edit.js), then tool_result: recordWritten of its own      *)
(*    write, the deferred-format queue record, and the pipeline's LSP sync  *)
(*    of the bytes it read (stamped: #3481 last-read-wins).                 *)
(*  - pi: `_runAgentPrompt`'s finally awaits `_emitAgentSettled`, which     *)
(*    clears `_isAgentRunActive` BEFORE awaiting the extension handlers     *)
(*    (agent-session.js ~347). The interactive main loop awaits             *)
(*    session.prompt, so its next prompt waits for the drain; an RPC prompt *)
(*    is `void session.prompt` (rpc-mode.js ~302) and a host that polls     *)
(*    isStreaming/waitForIdle does not wait (Overlap). `/new` runs from the *)
(*    editor's submit callback, so it runs while the drain runs; the drain  *)
(*    has no abort signal then.                                             *)
(*  - the drain handler (one file): the session capture and the claim       *)
(*    (runtime-agent-end.ts ~147), then runFormatPhase (pipeline.ts ~1342)  *)
(*    -> formatFile (formatters.ts ~2379): read contentBefore, spawn the    *)
(*    in-place formatter (it reads and writes F), read contentAfter,        *)
(*    changed := before # after; then fileContent is read (pipeline.ts      *)
(*    ~1438); then the apply loop: recordProjectChange, recordWritten,      *)
(*    addModifiedRange, turnSummary (runtime-agent-end.ts ~769), and        *)
(*    resyncLspFile(fileContent, fileReadStamp) (~820).                     *)
(*    FixQueue: the #3561 format hold (~588) is taken before contentBefore  *)
(*    and released when the phase settles, after the fileContent read.      *)
(*    The per-file wait is `bounded(..., 10 s)` (~607): on expiry the       *)
(*    handler requeues and moves on while the formatter child keeps         *)
(*    running (Orphan). FixQueueHold: the hold's release follows the phase, *)
(*    not the bound, so the child keeps the queue until it has written.     *)
(*    FixOrphanSync: once that child has exited, a fresh read of F is taken *)
(*    and later sent to the LSP (~614); the read and the send are separate  *)
(*    steps, as in the code.                                                *)
(*  - /new: resetForSession (runtime-coordinator.ts ~447) on the module-    *)
(*    level `runtime`: fresh read guard, cleared queue, generation + 1.     *)
(*  - another pi-lens process formatting F (not in this process's queue).   *)
(*                                                                          *)
(* The drain's autofix phase (runAutofix) has the same read/write/          *)
(* bookkeeping shape as the format phase and is not modelled separately.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Edits,            \* agent edits of F
    MaxOps,           \* agent reads + edit attempts
    MaxTurns,         \* agent runs
    MaxSessions,      \* 1 + number of /new
    ExtWrites,        \* formats of F by another pi-lens process
    Overlap,          \* TRUE: next run may start while the drain runs (RPC / waitForIdle hosts)
    Orphan,           \* TRUE: the 10 s bound may abandon the formatter child
    MtimeAuthored,    \* TRUE: wasWrittenThisSession's mtime >= sessionStart fallback (#3520)
    ResetClearsGuard, \* FALSE: mutant, /new keeps the read guard
    FixQueue,         \* fix: contentBefore..fileContent (incl. the child) under withFileMutationQueue(F)
    FixQueueHold,     \* fix: an abandoned child keeps the queue until it exits
    FixGen,           \* fix: capture sessionGeneration at claim; session writes only when current
    GenDropsAll,      \* mutant: the generation guard drops every write, current or not
    FixStamp,         \* fix: the drain's LSP sends carry the stamp of their read
    FixOrphanSync     \* fix: an abandoned child's exit is followed by a stamped read + resync

Content == [e : SUBSET (1..Edits), f : BOOLEAN]
Fmt(c) == [e |-> c.e, f |-> TRUE]
Ed(c, i) == [e |-> c.e \cup {i}, f |-> FALSE]
Init0 == [e |-> {}, f |-> TRUE]

VARIABLES
    file, mtime, applied, qOwner,
    gen, sessions, turns, turn, ops,
    reads, written, sessStart,
    aop, tmp, nextEdit, queued,
    hs, dGen, before, after, changed, fc, fcStamp,
    sp, sub, oc, ocStamp,
    clock, lspC, lspLast,
    extS, ext, extLeft,
    badClaim, blind, crossWrite, ownDrop

vars == <<file, mtime, applied, qOwner, gen, sessions, turns, turn, ops,
          reads, written, sessStart, aop, tmp, nextEdit, queued,
          hs, dGen, before, after, changed, fc, fcStamp, sp, sub, oc, ocStamp,
          clock, lspC, lspLast, extS, ext, extLeft,
          badClaim, blind, crossWrite, ownDrop>>

drainVars == <<hs, dGen, before, after, changed, fc, fcStamp>>
subVars == <<sp, sub, oc, ocStamp>>
lspVars == <<clock, lspC, lspLast>>
extVars == <<extS, ext, extLeft>>
flagVars == <<badClaim, blind, crossWrite, ownDrop>>
sessVars == <<gen, sessions, turns, turn, ops, reads, written, sessStart>>

\* LSP notify queue, #3481: a stamped send older than the last stamped send is
\* dropped; an unstamped send (stamp 0) always goes out and keeps the stamp.
Send(c, s) ==
    IF s = 0 THEN lspC' = c /\ lspLast' = lspLast
    ELSE IF s < lspLast THEN UNCHANGED <<lspC, lspLast>>
    ELSE lspC' = c /\ lspLast' = s

WriteFile(c) ==
    /\ file' = c
    /\ mtime' = IF c = file THEN mtime ELSE mtime + 1

Init ==
    /\ file = Init0 /\ mtime = 0 /\ applied = {} /\ qOwner = "none"
    /\ gen = 1 /\ sessions = 1 /\ turns = 1 /\ turn = "running" /\ ops = 0
    /\ reads = FALSE /\ written = FALSE /\ sessStart = 0
    /\ aop = "idle" /\ tmp = Init0 /\ nextEdit = 1 /\ queued = FALSE
    /\ hs = "none" /\ dGen = 0 /\ before = Init0 /\ after = Init0
    /\ changed = FALSE /\ fc = Init0 /\ fcStamp = 0
    /\ sp = "none" /\ sub = Init0 /\ oc = Init0 /\ ocStamp = 0
    /\ clock = 1 /\ lspC = Init0 /\ lspLast = 0
    /\ extS = "idle" /\ ext = Init0 /\ extLeft = ExtWrites
    /\ badClaim = FALSE /\ blind = FALSE /\ crossWrite = FALSE /\ ownDrop = FALSE

----------------------------------------------------------------------------
\* The agent

AgentRead ==
    /\ turn = "running" /\ aop = "idle" /\ ops < MaxOps
    /\ reads' = TRUE /\ ops' = ops + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn,
                   written, sessStart, aop, tmp, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, flagVars>>

WasWritten == written \/ (MtimeAuthored /\ mtime > sessStart)

EditCheck ==
    /\ turn = "running" /\ aop = "idle" /\ ops < MaxOps /\ nextEdit <= Edits
    /\ ops' = ops + 1
    /\ IF reads \/ WasWritten
         THEN aop' = "wait" /\ blind' = (blind \/ ~reads)
         ELSE UNCHANGED <<aop, blind>>
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn,
                   reads, written, sessStart, tmp, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, badClaim, crossWrite,
                   ownDrop>>

EditRead ==
    /\ aop = "wait" /\ qOwner = "none"
    /\ qOwner' = "agent" /\ tmp' = file /\ aop' = "write"
    /\ UNCHANGED <<file, mtime, applied, sessVars, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, flagVars>>

EditWrite ==
    /\ aop = "write"
    /\ WriteFile(Ed(tmp, nextEdit))
    /\ applied' = applied \cup {nextEdit}
    /\ nextEdit' = nextEdit + 1
    /\ qOwner' = "none"
    /\ written' = TRUE          \* tool_result recordWritten of its own write
    /\ queued' = TRUE           \* deferred format record
    /\ aop' = "sync"
    /\ UNCHANGED <<gen, sessions, turns, turn, ops, reads, sessStart, tmp,
                   drainVars, subVars, lspVars, extVars, flagVars>>

\* the edit's pipeline reads F and touches the LSP with that read's stamp
EditSync ==
    /\ aop = "sync"
    /\ Send(file, clock) /\ clock' = clock + 1
    /\ aop' = "idle"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, tmp, nextEdit, queued,
                   drainVars, subVars, extVars, flagVars>>

----------------------------------------------------------------------------
\* Run boundaries, /new

DrainIdle == hs \in {"none", "done"}

\* agent_end ... agent_settled: the drain captures the session and claims
EndRun ==
    /\ turn = "running" /\ aop = "idle"
    /\ turn' = "settled"
    /\ IF queued /\ DrainIdle /\ sp = "none"
         THEN hs' = "before" /\ dGen' = gen /\ queued' = FALSE
         ELSE UNCHANGED <<hs, dGen, queued>>
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, ops,
                   reads, written, sessStart, aop, tmp, nextEdit,
                   before, after, changed, fc, fcStamp, subVars,
                   lspVars, extVars, flagVars>>

StartRun ==
    /\ turn = "settled" /\ turns < MaxTurns
    /\ Overlap \/ DrainIdle
    /\ turn' = "running" /\ turns' = turns + 1
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, ops,
                   reads, written, sessStart, aop, tmp, nextEdit, queued,
                   drainVars, subVars, lspVars, extVars, flagVars>>

NewSession ==
    /\ turn = "settled" /\ aop = "idle" /\ sessions < MaxSessions
    /\ gen' = gen + 1 /\ sessions' = sessions + 1
    /\ reads' = FALSE
    /\ written' = IF ResetClearsGuard THEN FALSE ELSE written
    /\ sessStart' = mtime
    /\ queued' = FALSE            \* _pendingDeferredMutations.clear()
    /\ UNCHANGED <<file, mtime, applied, qOwner, turns, turn, ops, aop, tmp,
                   nextEdit, drainVars, subVars, lspVars, extVars, flagVars>>

----------------------------------------------------------------------------
\* The drain

\* guardedWrite: the write runs only while the captured session is current.
Current ==
    IF GenDropsAll THEN FALSE ELSE (~FixGen \/ dGen = gen)

DBefore ==
    /\ hs = "before"
    /\ ~FixQueue \/ qOwner = "none"
    /\ before' = file
    /\ qOwner' = IF FixQueue THEN "drain" ELSE qOwner
    /\ hs' = "spawn"
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit, queued,
                   dGen, after, changed, fc, fcStamp, subVars,
                   lspVars, extVars, flagVars>>

DSpawn ==
    /\ hs = "spawn"
    /\ sp' = "start" /\ hs' = "wait"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, dGen, before, after, changed, fc, fcStamp,
                   sub, oc, ocStamp, lspVars, extVars, flagVars>>

SubRead ==
    /\ sp = "start"
    /\ sub' = file /\ sp' = "run"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, oc, ocStamp, lspVars, extVars, flagVars>>

\* the formatter child writes its format of what it read; an abandoned child
\* releases the hold it kept (FixQueueHold) once it has written
SubWrite ==
    /\ sp = "run"
    /\ WriteFile(Fmt(sub))
    /\ sp' = IF hs = "wait" THEN "exited"
             ELSE IF FixOrphanSync THEN "oread"
             ELSE "none"
    /\ qOwner' = IF hs # "wait" /\ qOwner = "drain" THEN "none" ELSE qOwner
    /\ UNCHANGED <<applied, sessVars, aop, tmp, nextEdit, queued,
                   drainVars, sub, oc, ocStamp, lspVars, extVars, flagVars>>

\* fix: the post-exit read of F, stamped ...
OrphanRead ==
    /\ sp = "oread"
    /\ oc' = file /\ ocStamp' = clock /\ clock' = clock + 1
    /\ sp' = "osend"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sub, lspC, lspLast, extVars, flagVars>>

\* ... and, later, its send
OrphanSend ==
    /\ sp = "osend"
    /\ Send(oc, IF FixStamp THEN ocStamp ELSE 0)
    /\ sp' = "none"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, sub, oc, ocStamp, clock, extVars, flagVars>>

DAfter ==
    /\ hs = "wait" /\ sp = "exited"
    /\ after' = file
    /\ changed' = (before # file)
    /\ sp' = "none"
    /\ hs' = "fc"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, dGen, before, fc, fcStamp, sub, oc, ocStamp,
                   lspVars, extVars, flagVars>>

\* bounded() expires: requeue "format-failed", move on; the child runs on
Abandon ==
    /\ Orphan /\ hs = "wait" /\ sp \in {"start", "run"}
    /\ hs' = "done"
    /\ queued' = IF Current THEN TRUE ELSE queued
    /\ crossWrite' = (crossWrite \/ (Current /\ dGen # gen))
    /\ ownDrop' = (ownDrop \/ (~Current /\ dGen = gen))
    /\ qOwner' = IF qOwner = "drain" /\ ~FixQueueHold THEN "none" ELSE qOwner
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit,
                   dGen, before, after, changed, fc, fcStamp, subVars,
                   lspVars, extVars, badClaim, blind>>

\* the phase reads fileContent (with its stamp) inside the hold, then settles
\* and the hold is released
DFc ==
    /\ hs = "fc"
    /\ fc' = file /\ fcStamp' = clock /\ clock' = clock + 1
    /\ qOwner' = IF qOwner = "drain" THEN "none" ELSE qOwner
    /\ hs' = "apply"
    /\ UNCHANGED <<file, mtime, applied, sessVars, aop, tmp, nextEdit,
                   queued, dGen, before, after, changed, subVars,
                   lspC, lspLast, extVars, flagVars>>

DApply ==
    /\ hs = "apply"
    /\ badClaim' = (badClaim \/ (changed /\ after.e # before.e))
    /\ written' = IF changed /\ Current THEN TRUE ELSE written
    /\ crossWrite' = (crossWrite \/ (changed /\ Current /\ dGen # gen))
    /\ ownDrop' = (ownDrop \/ (changed /\ ~Current /\ dGen = gen))
    /\ Send(fc, IF FixStamp THEN fcStamp ELSE 0)
    /\ hs' = "done"
    /\ UNCHANGED <<file, mtime, applied, qOwner, gen, sessions, turns, turn, ops,
                   reads, sessStart, aop, tmp, nextEdit, queued,
                   dGen, before, after, changed, fc, fcStamp, subVars,
                   clock, extVars, blind>>

----------------------------------------------------------------------------
\* Another pi-lens process formats F (its own queue, not ours)

ExtRead ==
    /\ extS = "idle" /\ extLeft > 0
    /\ ext' = file /\ extS' = "run"
    /\ UNCHANGED <<file, mtime, applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, subVars, lspVars, extLeft, flagVars>>

ExtWrite ==
    /\ extS = "run"
    /\ WriteFile(Fmt(ext))
    /\ extS' = "idle" /\ extLeft' = extLeft - 1
    /\ UNCHANGED <<applied, qOwner, sessVars, aop, tmp, nextEdit,
                   queued, drainVars, subVars, lspVars, ext, flagVars>>

Next ==
    \/ AgentRead \/ EditCheck \/ EditRead \/ EditWrite \/ EditSync
    \/ EndRun \/ StartRun \/ NewSession
    \/ DBefore \/ DSpawn \/ SubRead \/ SubWrite \/ DAfter \/ Abandon
    \/ OrphanRead \/ OrphanSend
    \/ DFc \/ DApply
    \/ ExtRead \/ ExtWrite

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* Invariants

TypeOK ==
    /\ file \in Content /\ applied \subseteq 1..Edits
    /\ qOwner \in {"none", "agent", "drain"}
    /\ hs \in {"none", "before", "spawn", "wait", "fc", "apply", "done"}
    /\ sp \in {"none", "start", "run", "exited", "oread", "osend"}

\* The drain never overwrites an agent edit (pi docs/extensions.md ~1925).
NoLostEdit == applied \subseteq file.e

\* What the drain reports as its format (summary.changed, the "formatted"
\* notice, the publishFilesTouched `fixes` provenance, recordWritten) holds
\* no agent edit: before -> after is formatting only.
HonestFormatClaim == ~badClaim

\* Once everything is quiet, the LSP document holds the bytes on disk. This is
\* also the stamp filter's no-drop direction: a drain send dropped although it
\* carried the newest read leaves the LSP behind the disk.
Quiet == aop = "idle" /\ DrainIdle /\ sp = "none" /\ extS = "idle"
LspMatchesDisk == Quiet => lspC = file

\* An edit is admitted only after this session showed the agent F
\* (read-guard.ts header: "Read state from session 1 never authorises session 2").
NoBlindAllow == ~blind

\* Shape 22: a drain claimed in one session never writes the next
\* session's state (read guard, pending queue, project change log).
NoCrossSessionWrite == ~crossWrite

\* Shape 54, the generation guard's no-drop direction: a drain that is still
\* in the session it claimed in keeps every session write (recordWritten,
\* requeue).
NoOwnDrop == ~ownDrop
=============================================================================
