--------------------------- MODULE RunnerStore ---------------------------
(***************************************************************************)
(* The deferred collect-later runner store (clients/dispatch/              *)
(* pending-runner-findings.ts) across a same-process scope retirement, for *)
(* #3758 (the drain's captured-scope fence) and #3813/#3824 (the           *)
(* turn-end cap's requeue). This family models the store alone; the peek   *)
(* reader the commit gate adds in #3814 is a separate lane and is NOT      *)
(* modelled here.                                                          *)
(*                                                                         *)
(* Actors:                                                                 *)
(*  - deferRunnerFindings: the producer's admission. It fences with the    *)
(*    generation it captured (#3568), so an entry enters only from a live  *)
(*    scope or from a released writer with no captured handle (shape 57);  *)
(*  - drainPendingRunnerFindings: the turn-end reader. It removes the      *)
(*    settled answers it admits and keeps in-flight work for the store;    *)
(*  - requeueRunnerFindings: re-enters a drained, settled answer for the   *)
(*    next turn end when the delivery cap cut it (#3813). It tracks        *)
(*    unconditionally and carries entry.session, so the next drain can     *)
(*    still fence it (#3824);                                             *)
(*  - a raw generation bump (a scope's retirement) with no store clear.    *)
(*    resetPendingRunnerFindings clears the store at session_start, so the *)
(*    window this model explores is the one before that clear, as #3824's  *)
(*    drain fence does.                                                    *)
(*                                                                         *)
(* An entry carries two identities: `producer`, the generation that        *)
(* actually computed the answer (0 = a released writer with no captured    *)
(* handle), and `owner`, the generation the fence reads off the entry. The *)
(* shipped code keeps them equal (the drained shape carries                *)
(* entry.session, and the requeue copies it); a requeue that dropped it    *)
(* would leave owner 0 while producer stays 1.                             *)
(*                                                                         *)
(* Invariants:                                                             *)
(*  - NoStaleAdmission (shape 54, safety): the reader admits no answer     *)
(*    whose producer scope has retired;                                   *)
(*  - NoDropFreshAnswer (shape 54, no-drop): the reader drops no answer    *)
(*    whose producer scope is live or has no captured handle.             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Slots,     \* the writers whose answers the store may hold
    Drain,     \* "owned"    the shipped turn-end read (guardedWrite)
               \* "unfenced" the pre-#3758 drain (no admission check)
               \* "none"     over-drop mutant: the read admits nothing
    Requeue,   \* "carry" (shipped) | "drop" (the drained shape loses session)
    NoHandle   \* "admit" (shipped) | "drop" (mutant: a released writer is
               \* fenced out)

VARIABLES
    phase,      \* "s1" | "s2"
    gen,        \* the current generation
    producer,   \* [Slots -> 0..2]: the generation that computed the answer
    owner,      \* [Slots -> 0..2]: the generation the fence reads
    pending,    \* entries the store holds
    settled,    \* pending entries whose answer has arrived
    delivered,  \* entries a drain removed and admitted
    leaked,     \* the reader admitted an answer whose producer has retired
    droppedLive \* the reader dropped an answer whose producer is live/unfenced

vars == <<phase, gen, producer, owner, pending, settled, delivered, leaked,
          droppedLive>>

TypeOK ==
    /\ phase \in {"s1", "s2"}
    /\ gen \in 1..2
    /\ producer \in [Slots -> 0..2]
    /\ owner \in [Slots -> 0..2]
    /\ pending \subseteq Slots
    /\ settled \subseteq Slots
    /\ delivered \subseteq Slots
    /\ leaked \in BOOLEAN
    /\ droppedLive \in BOOLEAN

\* The producer's scope has retired: the answer belongs to an earlier session.
TrueRetired(s) == producer[s] # 0 /\ producer[s] # gen

\* The producer's scope is live, or it is a released writer with no handle.
Fresh(s) == ~TrueRetired(s)

\* The fence the reader applies, reading the owner the entry carries.
ReaderAdmits(kind, s) ==
    CASE kind = "unfenced" -> TRUE
      [] kind = "none"     -> FALSE
      [] OTHER             -> IF owner[s] = 0
                                THEN NoHandle = "admit"
                                ELSE owner[s] = gen

Init ==
    /\ phase = "s1"
    /\ gen = 1
    /\ producer = [s \in Slots |-> 0]
    /\ owner = [s \in Slots |-> 0]
    /\ pending = {}
    /\ settled = {}
    /\ delivered = {}
    /\ leaked = FALSE
    /\ droppedLive = FALSE

\* deferRunnerFindings: fenced at admission, so only a live capture or a
\* released writer with no handle enters the store.
Defer(s, o) ==
    /\ s \notin pending
    /\ (o = 0 \/ o = gen)
    /\ pending' = pending \cup {s}
    /\ settled' = settled \cup {s}
    /\ producer' = [producer EXCEPT ![s] = o]
    /\ owner' = [owner EXCEPT ![s] = o]
    /\ UNCHANGED <<phase, gen, delivered, leaked, droppedLive>>

\* requeueRunnerFindings: unconditional track of a drained settled answer.
\* It carries the producer's handle unless the "drop" mutant loses it.
RequeueTrack(s) ==
    /\ s \in delivered
    /\ pending' = pending \cup {s}
    /\ settled' = settled \cup {s}
    /\ owner' = [owner EXCEPT ![s] = IF Requeue = "carry" THEN owner[s] ELSE 0]
    /\ UNCHANGED <<phase, gen, producer, delivered, leaked, droppedLive>>

\* The turn-end drain: it removes the settled answers it admits, drops the
\* settled ones whose fence rejects, and keeps in-flight work.
DrainRead ==
    /\ LET candidates == pending \cap settled
           admitted == {s \in candidates : ReaderAdmits(Drain, s)}
           rejected == candidates \ admitted
           inFlight == pending \ settled
       IN /\ pending' = inFlight
          /\ delivered' = delivered \cup admitted
          /\ leaked' = (leaked \/ (\E s \in admitted : TrueRetired(s)))
          /\ droppedLive' = (droppedLive \/ (\E s \in rejected : Fresh(s)))
    /\ UNCHANGED <<phase, gen, producer, owner, settled>>

\* A raw generation bump (the scope retires) without the session_start clear.
Retire ==
    /\ gen = 1
    /\ gen' = 2
    /\ phase' = "s2"
    /\ UNCHANGED <<producer, owner, pending, settled, delivered, leaked,
                   droppedLive>>

Next ==
    \/ (\E s \in Slots, o \in {0, gen} : Defer(s, o))
    \/ (\E s \in Slots : RequeueTrack(s))
    \/ DrainRead
    \/ Retire

Spec == Init /\ [][Next]_vars

(* Shape 54, safety: the reader never admits an answer whose producer retired. *)
NoStaleAdmission == ~leaked

(* Shape 54, no-drop: the reader never drops a live or unfenced answer. *)
NoDropFreshAnswer == ~droppedLive
=============================================================================
