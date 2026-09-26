--------------------------- MODULE SessionRegistry ---------------------------
(***************************************************************************)
(* The instance registry entry of ONE pi process across a session          *)
(* replacement (#3498): session 1 serves root "A", ends (session_shutdown), *)
(* and session 2 starts in the same process serving root "B" (pi's         *)
(* switchSession re-creates the runtime with the resumed session's cwd).   *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - the host: session_start -> `void registerInstance(cwd)`, queued on   *)
(*    the process-wide mutation tail; session_shutdown ->                  *)
(*    `deregisterInstance()`, which clears the registration intent and     *)
(*    removes the entry with a SYNC lock that bypasses the tail;           *)
(*  - the mutation tail (queueRegistryMutation): registerInstanceNow sets  *)
(*    the intent (rememberRegistrationRoot) BEFORE taking the lock, then   *)
(*    read-modify-writes the entry under the async lock;                   *)
(*  - an LSP spawn per session (`void recordLspChild(...)`, lsp/client.ts),*)
(*    queued on the tail: with no entry it synthesizes one carrying the    *)
(*    session's root as a service cwd;                                     *)
(*  - a declined secondary's shutdown per session                          *)
(*    (`deregisterInstanceRoot`), queued on the tail: while the entry      *)
(*    still holds the session's root it re-arms the intent to that root.   *)
(*    The secondary's own root is not modelled; only its intent write is;  *)
(*  - a heartbeat per session (updateHeartbeat; turn_end and the           *)
(*    agent_settled quiet window, both fire-and-forget): under the async   *)
(*    lock it notes whether the entry is missing; after the lock it        *)
(*    re-registers from the intent (#3447), queued, not awaited;           *)
(*  - another pi process that can hold the machine-wide lock.              *)
(*                                                                         *)
(* The lock is not re-entrant (generation-lock.ts): the sync deregister    *)
(* meets this process's own async hold as "busy", and Atomics.wait blocks  *)
(* the event loop, so the holder cannot release; after LOCK_WAIT_MS the    *)
(* sync removal gives up.                                                  *)
(*                                                                         *)
(* FixParts is the fix in clients/instance-registry.ts. deregisterInstance *)
(* advances a process-wide registration generation whenever any gate is   *)
(* on; each writer captures it when it is called:                          *)
(*  - "generation": a registration whose generation moved drops itself     *)
(*    before it sets the intent, and again under the lock before it        *)
(*    writes. The heartbeat's repair calls registerInstance after its own  *)
(*    lock, so it captures there;                                          *)
(*  - "child": recordLspChild synthesizes no entry once its generation     *)
(*    moved;                                                               *)
(*  - "rootIntent": deregisterInstanceRoot re-arms the intent only while   *)
(*    its generation holds;                                                *)
(*  - "retry": a sync removal that cannot take the lock is queued on the   *)
(*    tail. It runs after the op holding the lock and waits for the lock   *)
(*    instead of dropping (deregisterInstanceAfterHolder).                 *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Contention,        \* another pi process may hold the registry lock
    HbRepair,          \* the #3447 heartbeat re-registration exists
    ClearIntent,       \* deregisterInstance clears the intent (#3447 guard)
    FixParts           \* subset of {"generation","child","rootIntent","retry"}

Root == [s \in 1..2 |-> IF s = 1 THEN "A" ELSE "B"]
Roots == {"A", "B"}
None == "none"

VARIABLES
    sess,       \* current session index (0 = none started yet)
    live,       \* the current session is between start and shutdown
    entry,      \* roots in this pid's registry entry ({} = no entry)
    intent,     \* registrationIntent().root
    tail,       \* queued registry mutations of this process
    tpc,        \* head op: "idle" (not started) | "acq" | "held"
    lock,       \* registry lock holder: none | tail | hb | other
    hbPc,       \* per session heartbeat pc
    hbMissing,  \* per session: the heartbeat found no entry
    spawned,    \* per session: its LSP spawn was recorded (queued)
    secDone,    \* per session: its secondary's shutdown was queued
    gen         \* registration generation, advanced by deregisterInstance

vars == <<sess, live, entry, intent, tail, tpc, lock, hbPc, hbMissing,
          spawned, secDone, gen>>

GenGuard == "generation" \in FixParts
ChildGate == "child" \in FixParts
RootGate == "rootIntent" \in FixParts
Retry == "retry" \in FixParts
GenOn == GenGuard \/ ChildGate \/ RootGate

Op(k, r, g) == [kind |-> k, root |-> r, gen |-> g]
RegOp(r, g) == Op("reg", r, g)
DeregOp     == Op("dereg", None, 0)

TypeOK ==
    /\ sess \in 0..2
    /\ live \in BOOLEAN
    /\ entry \subseteq Roots
    /\ intent \in Roots \cup {None}
    /\ tpc \in {"idle", "acq", "held"}
    /\ lock \in {"none", "tail", "hb", "other"}
    /\ hbPc \in [1..2 -> {"idle", "acq", "held", "post", "done"}]
    /\ hbMissing \in [1..2 -> BOOLEAN]
    /\ spawned \in [1..2 -> BOOLEAN]
    /\ secDone \in [1..2 -> BOOLEAN]
    /\ gen \in 0..2

Init ==
    /\ sess = 0
    /\ live = FALSE
    /\ entry = {}
    /\ intent = None
    /\ tail = <<>>
    /\ tpc = "idle"
    /\ lock = "none"
    /\ hbPc = [s \in 1..2 |-> "idle"]
    /\ hbMissing = [s \in 1..2 |-> FALSE]
    /\ spawned = [s \in 1..2 |-> FALSE]
    /\ secDone = [s \in 1..2 |-> FALSE]
    /\ gen = 0

(* ---------------- host ---------------- *)

Start ==
    /\ ~live /\ sess < 2
    /\ sess' = sess + 1
    /\ live' = TRUE
    /\ tail' = Append(tail, RegOp(Root[sess + 1], gen))
    /\ UNCHANGED <<entry, intent, tpc, lock, hbPc, hbMissing, spawned, secDone, gen>>

\* deregisterInstance(): sync, bypasses the tail.
Shutdown ==
    /\ live
    /\ live' = FALSE
    /\ intent' = IF ClearIntent THEN None ELSE intent
    /\ gen' = IF GenOn THEN gen + 1 ELSE gen
    /\ \/ /\ lock = "none"                       \* lock free: removed
          /\ entry' = {}
          /\ UNCHANGED tail
       \/ /\ lock = "other"                      \* the other process released
          /\ entry' = {}                         \* inside the 500 ms spin
          /\ UNCHANGED tail
       \/ /\ lock # "none"                       \* timeout: removal skipped
          /\ UNCHANGED entry
          /\ tail' = IF Retry THEN Append(tail, DeregOp) ELSE tail
    /\ UNCHANGED <<sess, tpc, lock, hbPc, hbMissing, spawned, secDone>>

\* `void recordLspChild({..., sessionIdentity: {projectRoot: cwd}})`.
LspSpawn(s) ==
    /\ live /\ sess = s /\ ~spawned[s]
    /\ spawned' = [spawned EXCEPT ![s] = TRUE]
    /\ tail' = Append(tail, Op("child", Root[s], gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing, secDone, gen>>

\* A declined secondary's `deregisterInstanceRoot(tempRoot)`.
SecondaryShutdown(s) ==
    /\ live /\ sess = s /\ ~secDone[s]
    /\ secDone' = [secDone EXCEPT ![s] = TRUE]
    /\ tail' = Append(tail, Op("root", Root[s], gen))
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbPc, hbMissing, spawned, gen>>

(* ---------------- another process ---------------- *)

OtherAcquire ==
    /\ Contention /\ lock = "none"
    /\ lock' = "other"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing, spawned, secDone, gen>>

OtherRelease ==
    /\ lock = "other"
    /\ lock' = "none"
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbPc, hbMissing, spawned, secDone, gen>>

(* ---------------- the mutation tail ---------------- *)

Op1 == tail[1]

\* registerInstanceNow's first statement: rememberRegistrationRoot(root).
\* Fix "generation": a registration whose generation moved does nothing.
TailBegin ==
    /\ tail # <<>> /\ tpc = "idle"
    /\ IF Op1.kind = "reg"
         THEN IF GenGuard /\ Op1.gen # gen
                THEN /\ tail' = Tail(tail) /\ UNCHANGED <<intent, tpc>>
                ELSE /\ intent' = Op1.root /\ tpc' = "acq" /\ UNCHANGED tail
         ELSE /\ tpc' = "acq" /\ UNCHANGED <<intent, tail>>
    /\ UNCHANGED <<sess, live, entry, lock, hbPc, hbMissing, spawned, secDone, gen>>

TailAcquire ==
    /\ tpc = "acq" /\ lock = "none"
    /\ lock' = "tail" /\ tpc' = "held"
    /\ UNCHANGED <<sess, live, entry, intent, tail, hbPc, hbMissing, spawned, secDone, gen>>

\* The lock's bounded wait ran out: the op is dropped. The fix's queued
\* removal waits through the lease instead: it stays at the head and retries.
TailTimeout ==
    /\ tpc = "acq" /\ lock \notin {"none", "tail"}
    /\ Op1.kind # "dereg"
    /\ tail' = Tail(tail) /\ tpc' = "idle"
    /\ UNCHANGED <<sess, live, entry, intent, lock, hbPc, hbMissing, spawned, secDone, gen>>

Stale == Op1.gen # gen

\* The write and the release.
\*  - "reg" MERGES the root into the entry (mergeInstanceRoots); fix
\*    "generation" re-checks under the lock.
\*  - "child" adds a child to an existing entry (roots unchanged), or
\*    synthesizes one with the session's root; fix "child" skips that.
\*  - "root" drops the secondary's root (not modelled) and re-arms the
\*    intent to the root the entry still holds; fix "rootIntent" skips the
\*    intent write once stale.
TailWrite ==
    /\ tpc = "held"
    /\ entry' = CASE Op1.kind = "dereg" -> {}
                  [] Op1.kind = "reg" ->
                        IF GenGuard /\ Stale THEN entry ELSE entry \cup {Op1.root}
                  [] Op1.kind = "child" ->
                        IF entry # {} \/ (ChildGate /\ Stale) THEN entry ELSE {Op1.root}
                  [] OTHER -> entry
    /\ intent' = IF Op1.kind = "root" /\ Op1.root \in entry /\ ~(RootGate /\ Stale)
                 THEN Op1.root ELSE intent
    /\ lock' = "none" /\ tpc' = "idle" /\ tail' = Tail(tail)
    /\ UNCHANGED <<sess, live, hbPc, hbMissing, spawned, secDone, gen>>

(* ---------------- heartbeat ---------------- *)

HbStart(s) ==
    /\ live /\ sess = s /\ hbPc[s] = "idle"
    /\ hbPc' = [hbPc EXCEPT ![s] = "acq"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbMissing, spawned, secDone, gen>>

HbAcquire(s) ==
    /\ hbPc[s] = "acq" /\ lock = "none"
    /\ lock' = "hb"
    /\ hbPc' = [hbPc EXCEPT ![s] = "held"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, hbMissing, spawned, secDone, gen>>

HbTimeout(s) ==
    /\ hbPc[s] = "acq" /\ lock \notin {"none", "hb"}
    /\ hbPc' = [hbPc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, lock, hbMissing, spawned, secDone, gen>>

\* Refreshes heartbeatAt/rss only; roots are untouched. Notes a missing entry.
HbWrite(s) ==
    /\ hbPc[s] = "held"
    /\ hbMissing' = [hbMissing EXCEPT ![s] = (entry = {})]
    /\ lock' = "none"
    /\ hbPc' = [hbPc EXCEPT ![s] = "post"]
    /\ UNCHANGED <<sess, live, entry, intent, tail, tpc, spawned, secDone, gen>>

\* After the lock: `missing && intent.root !== undefined` ->
\* `void registerInstance(intent.root)`, which captures the generation now.
HbPost(s) ==
    /\ hbPc[s] = "post"
    /\ tail' = IF HbRepair /\ hbMissing[s] /\ intent # None
               THEN Append(tail, RegOp(intent, gen))
               ELSE tail
    /\ hbPc' = [hbPc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<sess, live, entry, intent, tpc, lock, hbMissing, spawned, secDone, gen>>

Next ==
    \/ Start \/ Shutdown
    \/ OtherAcquire \/ OtherRelease
    \/ TailBegin \/ TailAcquire \/ TailTimeout \/ TailWrite
    \/ \E s \in 1..2 : \/ HbStart(s) \/ HbAcquire(s) \/ HbTimeout(s)
                       \/ HbWrite(s) \/ HbPost(s)
                       \/ LspSpawn(s) \/ SecondaryShutdown(s)

Spec == Init /\ [][Next]_vars

(* ---------------- invariants ---------------- *)

DeregQueued == \E i \in 1..Len(tail) : tail[i].kind = "dereg"

\* A root the process no longer serves is never in its entry: an ended
\* session never re-registers. The only exception is the fix's own queued
\* removal, which has not landed yet.
NoGhostRoot ==
    \A r \in entry : (live /\ r = Root[sess]) \/ DeregQueued

\* A live session is never dropped for good: its root is in the entry, or a
\* registration for it is still queued, or the heartbeat can still repair it
\* from the intent.
RegQueuedFor(r) ==
    \E i \in 1..Len(tail) :
        tail[i].kind = "reg" /\ tail[i].root = r /\ (~GenGuard \/ tail[i].gen = gen)
LiveRepairable ==
    live => \/ Root[sess] \in entry
            \/ RegQueuedFor(Root[sess])
            \/ (HbRepair /\ intent = Root[sess])
=============================================================================
