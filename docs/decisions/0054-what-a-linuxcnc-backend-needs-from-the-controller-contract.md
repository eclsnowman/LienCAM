# ADR-0054: what a LinuxCNC backend needs from the controller contract

Date: 2026-09-23
Status: accepted
Parent: ADR-0041 (LienCAM speaks its own machine language; controllers are backends)
Related: ADR-0042 (the machine definition is controller-shaped), ADR-0048
(a controller we do not own ships verified in simulation only), ADR-0053
(indexed rotary is a Setup orientation; CAM stays Cartesian)
Authority: WO-1844, from `docs/audits/NEXT-PORT-REVIEW-2026-09-22.md`, Control
table, row "LinuxCNC third backend: session contract". the operator named LinuxCNC in
WO-1831 and ruled 2026-09-22 12:56 PM CT that the audit's Top-picks order is the
order to build in; this is rank 12 of 13 in that sequence.

## In one paragraph

ADR-0041 already says LinuxCNC would be a peer backend, not something that has
to cosplay as GRBL. This ADR answers the next question: **before anyone writes
that backend, which parts of `MachineController`
(`src/lib/machine/controller.ts`) must grow?** The sweep behind WO-1844 named
five candidates, taken from a sibling design study. The answer is that **two of
the five are real contract growth, one is a missing comment on a safety member,
one is worth doing but has nothing to do with LinuxCNC, and one is rejected
outright because it would make the software refuse things it can do.** The
contract is close to ready. The backend, and the equipment to verify it, is the
cost - not the interface.

## Context

### Where the five came from, and what they may be cited for

The five candidates are read from `LienCAM-next`, a sibling design study:
`src/domain/control/controllerSession.ts`,
`src/adapters/control/linuxCncCommandPort.ts`, and
`docs/research/LCNC_SUITE_REVIEW.md`. **That study never ran a machine.**
Nothing in it is evidence of how LinuxCNC behaves, and nothing below cites it
that way. It is cited only as the source of the QUESTION. Every ANSWER below is
decided from this repository's own code, from measured facts in
`docs/machine/MACHINE-SEAT-HANDOFF.md` section 7, or is explicitly marked as
desk reading of LinuxCNC's published interface that a backend author must
confirm against a running LinuxCNC before the first commit.

### What the contract looks like today

`MachineController` is 1,442 lines of interface with three backends behind it
(`GrblController`, `UccncController`, `SimulatedController`). Its house rules
are ADR-0041's: signatures follow the working implementation, and there is no
lowest common denominator - `ControllerCapabilities` exists so a caller asks
instead of assuming, and `MachineStatus` reports what a backend cannot supply as
`null` rather than inventing a value.

Every line number below was checked against this tree on 2026-09-23.

## The five, decided

### 1. An explicit UNKNOWN command outcome - ADOPT, narrowly

**Today.** The contract has receipts for two calls: `ZeroWorkAxisReceipt`
(`controller.ts:921`) and `OutputSwitchReceipt` (`controller.ts:1045`). Both
already refuse to collapse uncertainty - `ZeroWorkAxisReceipt.offset` absent
means "cannot say", never "zero", and `OutputSwitchReceipt.confirmation` is
three-valued (`confirmed | unconfirmed | superseded`) precisely so an accepted
write is not promoted into a physical-fault claim. The instinct is already
house style. **It is applied to two calls out of the whole surface.**

Everywhere else the bridge path funnels through `UccncController.call()`
(`uccncController.ts:2113-2133`), which **rejects its promise on timeout**, and
`fireAndForget()` (`:2226-2233`), which turns that rejection into one console
error line. A caller reading `false` or catching that rejection cannot tell "the
machine refused" from "the machine may still be doing it".

**Why this is not theory.** Three facts from this machine:

- **We have already lost this once, and the fix was a bigger number.**
  `PROBE_CALL_TIMEOUT_MS` (`uccncController.ts:105-108`) carries its own
  incident: "the bridge polls a probe for up to five minutes ... and a real
  touch took 12 s on the board - the 8 s call timeout reported a probe that was
  still running as a failure." Raising the ceiling to 5m30s fixed the probe. It
  did not fix the shape: the next call whose true duration we have mis-estimated
  will report the same lie.
- **The board answers "accepted" for writes it discards.** The AXBB-E boots into
  an e-stop latch in which `SetAxisSetting` returns rc=7 **and silently discards
  the value** (`pendant/uccnc-bridge/Machine.cs:1231-1234`); `Stop()` itself
  reports rc=7 for the state it found and has to be called until clean
  (measured: twice). WO-1051's four rc=0 writes against four rc=7 readbacks is
  the same shape. A write that returned is not a write that took effect.
- **LinuxCNC's completion is tri-state by construction** - desk reading of its
  published interface, to be confirmed by the backend author: a command either
  reaches `RCS_DONE`, reaches `RCS_ERROR`, or the client stops waiting.
  `LCNC_SUITE_REVIEW.md` P0 records that its own success constant is 1, not 0,
  and that a fake returning 0 concealed the mismatch. A backend written against
  a two-valued outcome has to pick a lie for the third case on its first day.

**Decision.** Grow the contract by one value, not by a session object. The calls
that can still be in flight when the answer stops arriving must be able to say
**unknown** alongside accepted and refused, in the same terms the two existing
receipts already use. Adopt the PRINCIPLE behind the recovery half too - the
evidence that clears an uncertain command must be gathered AFTER the
uncertainty, never a cached reading from before it. That principle is already
partly built: `waitForGeometryMoveArrival` (`machineSession.ts:6569-6591`)
requires idle read twice in a row and holds a `captureBackendReceipt` token that
goes stale on a connection change.

**Explicitly NOT adopted:** the eight-state reserved/dispatched/accepted machine,
the generation counters, the lease, the capacity caps, and a session object that
throws. Those are a rewrite of how the app talks to a controller, not a gap in
what the contract can express. A third value is the gap.

### 2. An injected monotonic clock that invalidates the session - NOT NEEDED

**Today.** `Date.now()` is read directly: 4 times in `bridgeTransport.ts`
(`:1642, :1655, :1704, :1716`, all inside the initial-connect retry) and 25
times in `machineSession.ts`. The counts are exact as of this tree.

**Which of those are deadlines where a wall-clock jump matters.** Four of the 25
are wall-clock STAMPS written onto a record and are correctly wall-clock - a
park macro's id (`:4218`), a probe's `atMs`/`probedAt` (`:7491, :15673`) and the
tool table's probed-Z timestamp (`:16307`) all go in front of the operator or
into persisted data. The remaining 21 measure an elapsed interval. Of those:

- **Several throttle or restate narration** (`:6768, :7853, :7854, :7895,
  :12655` - a console line repeated no more than once a second, a continuation
  notice restated after an interval). A clock jump changes when a sentence is
  printed.
- **Most of the rest are timing loops that RETURN FALSE on expiry**
  (`:6559-6561` fresh status, `:6576-6578` geometry arrival, `:15509-15510`
  probe positioning idle, `:15939-15942` probe routine move, `:16654-16655`,
  `:1627/:1684` spindle up-to-speed, `:3479/:3512` WCS selection staging). A
  clock jump makes one of these wait longer or give up early. Giving up early
  produces a REFUSAL and a sentence; none of them commands motion on expiry.
- **Exactly one gates motion on elapsed time**: the output on-delay.
  `holdMotionForOutputOnDelay` sets `outputOnDelayUntilMs = Date.now() + delayMs`
  and `releaseAfterOutputOnDelay` computes `outputOnDelayUntilMs - Date.now()`
  (`machineSession.ts:4905, :4918`). A forward wall-clock step here releases
  motion **before the delay the machine definition asks for has physically
  elapsed** - a dust shoe or a mister that has not reached state yet.

**Decision: do not adopt the session-invalidating clock.** The design being
weighed invalidates the whole session and throws on a backwards reading. On this
machine that means an operator's link dies because Windows synced NTP mid-job.
The software can still jog with a stepped clock; killing the session is a
refusal of something we can do, which rule 11 forbids.

**Decide-and-log, and it is separable from LinuxCNC entirely:** the interval
arithmetic should not use a wall clock at all. `performance.now()` is monotonic
in the browser and is a drop-in for every deadline subtraction above. Convert
the INTERVAL uses; leave the four record stamps on `Date.now()`, because a
record wants a wall clock. **This is not a LinuxCNC prerequisite** - it is the
same defect under every backend, it is small, and the on-delay case is the only
one with a motion consequence. It gets its own order and does not gate anything
here.

### 3. Stop as its own path, never through submit - KEEP; one comment is owed

**Read the E-STOP conditions by hand before believing any summary of them**, per
WO-1844's own instruction and this project's standing rule. Done, by hand, for
this ADR. What is there:

- `UccncController.emergencyStop()` (`uccncController.ts:1330-1337`) is
  explicitly never gated: "Never gated by readOnly or connection niceties beyond
  'can we still reach the bridge at all' - stopping is the one call that must
  never be refused locally."
- `machineSession` wraps it (`:8076-8081`) and adds only a motion-stop note, a
  spindle-wait cancel and the geometry program's spindle stop. It adds no gate.
- `spindleOff` is documented **"Never gated"** in the contract itself
  (`controller.ts:1250-1257`) - no capability, no verification, no link state
  may block a stop.
- **The separation already exists one layer down, and it is measured.** The
  bridge's `BoardOwner` classes (`pendant/uccnc-bridge/Bridge.cs:91-104`) make
  `emergencyStop`, `reset`, `resetToIdle`, `stopJob`, `jogCancel`, the
  socket-loss panic stop and output inhibit a `StopNow` job that **jumps every
  queue and aborts a running long operation**, while `feedHold`/`pauseJob` are
  `Priority` - they jump the queue and do NOT abort, because the operator asked
  the machine to hold, not to abandon a homing cycle. The bridge's own harness
  asserts the stop executes within 50 ms of being posted while a 5-second long
  operation is running, and that the long operation then unwinds (`:524-546`).
- WO-469's ruling stands above all of it: the control has two MODES and the mode
  decides. Armed, a click stops - unconditionally, synchronously, never gated.
  Stopped, a click clears, through `resetEstop()`'s own confirm. **A software
  E-STOP is not a freeze**; it drops the relay.

**Decision: KEEP. No structural change.** A LinuxCNC backend inherits an
obligation, not a new interface: its stop reaches the controller by its own
route, never queued behind an ordinary command, never gated locally, and never
implemented as a pause. (Desk reading, for the backend author to confirm:
LinuxCNC carries abort and estop as their own commands rather than as a variant
of ordinary command submission - the same shape our bridge already has.)

**What IS owed.** `emergencyStop(): void // (as today)` at `controller.ts:1234`
carries **no comment at all**. Every rule above lives in one backend's
implementation or in the C# bridge. A backend author reading the interface - the
exact thing a LinuxCNC author reads first - is told nothing. That is a
comment-only change to a safety file, and because it is a safety file it gets
its own order and its own review lane rather than being folded into anything
else.

### 4. Joint position vs Cartesian pose kept separate - ADOPT, additive only

**Today.** `MachineStatus` (`controller.ts:691`) carries `machinePos` and
`workPos` as `MachinePosition`, which is `{x, y, z}` plus optional `a`/`b`/`c`
in degrees (`types.ts:17-29`). There is no joint vector anywhere: a search for
"joint" across `src/lib/machine/` returns one unrelated UCCNC profile key
(`G41G42roundjoints`). The conflation WO-1844 names is real.

**Why this is not hypothetical, and the fact is from our own machine.**
**the operator's machine has a slaved gantry**: `Slaveaxis=A` on Y, and homing Y squares
both sides (handoff section 7). **There are four joints behind three Cartesian
axes on the one machine we own today.** The AXBB path does not report the slave
separately, so nothing is lost by our silence right now - but squaring and
per-side following error are joint facts, and the contract has nowhere to put
the fourth number.

The second seam is homing. `homedAxesThisSession()` is keyed by `JogAxis`
(`controller.ts:1145`), and its whole reason for existing (WO-930) is that
collapsing per-axis truth into one boolean let "homed Z" open every "home first"
gate while X and Y were unreferenced. LinuxCNC homes **joints**, not axis
letters - on a slaved gantry that is two homing operations behind one letter.
Reporting it as one `y: true` would put the WO-930 collapse straight back, one
level down.

**Decision: ADOPT, additively and optionally.**

- Add an OPTIONAL joint read to `MachineStatus`. **Absent means "this backend
  cannot say which joints it has"** - the exact three-way rule
  `inputs.home`/`limitMinus`/`limitPlus` already use (`controller.ts:760-790`),
  where absent, `null` and `false` are three different facts and collapsing any
  of them is the blindness that cost a 229 mm wrong-way move on 2026-08-23.
- Add a capability saying the axis-to-joint mapping is **not** identity, so a
  caller asks rather than assumes - ADR-0041 rule 2.
- **Do NOT reshape `machinePos`.** It is Cartesian, it is correct, every backend
  and the whole app read it, and a signature change there is a behaviour change
  in proven controllers (ADR-0041 rule 1).

This changes nothing in CAM. ADR-0053 decided a week ago that CAM stays
Cartesian and the A word enters only at the post's section boundary; joints are
a controller READ on the status frame, on the far side of that line.

### 5. Per-command permission, and "stale forbids everything except stop" - NOT NEEDED

**Today.** `verifiedIdle()` (`controller.ts:1106`) and `homedThisSession()`
(`:1127`) are booleans. The REASON is not missing from the product - it is
computed where it is enforced. `unhomedAxes()` + `describeAxisList()`
(`controller.ts:199-217`) exist so a refusal NAMES the axes, with the comment
"'home the machine first' after homing an axis reads as a bug to the operator
standing at the machine". `appCommandUnsent()` returns a sentence or `null`.
That is the house pattern already.

**Rejected: "a stale snapshot forbids everything except stop."** The design
being weighed treats an observation older than its freshness window (1 s by
default, 10 s ceiling) as forbidding every command but stop. On this machine:

- Status arrives over a websocket to a bridge that **takes one session**, and
  the bridge **deliberately pauses status frames across a real board-reopen
  attempt** (`Bridge.cs:2543-2551`) - "which costs nothing - the board they
  would describe is the one that is not answering". A reopen can take six
  250 ms latch-clearing `Stop()` calls followed by six axes of writes and
  readbacks, so a frame can honestly be seconds old with nothing wrong. A
  blanket freshness veto fires hardest on a bridge doing exactly the right
  thing.
- A legitimate operation can run far longer than any freshness window.
  `PROBE_CALL_TIMEOUT_MS` is 5m30s because a real touch took 12 s on the board
  (`uccncController.ts:105-108`). A 1-second ceiling bears no relationship to
  how long the operations the operator is standing there watching actually
  take.
- The software CAN jog with a 1.2-second-old frame. Refusing is handing the
  operator our problem, which rule 11 forbids in as many words.
- We already learned the correct version of this lesson at the one place it
  matters. `resetEstop()` must never trust a cached machine state - a background
  poll can be up to ~1 s stale - so it **asks fresh** (`queryStatus()`) and
  awaits the session's own next report, with an epoch counter so a report that
  arrives after a NEW trip cannot clear the old one
  (`machineSession.ts:8255-8272`). Fresh evidence on demand at the gate that
  needs it; not a veto over everything.

**Rejected: a permission map on the snapshot.** A
`Record<CommandKind, {allowed, reason}>` is a second place for the answer to
live, and a second place can disagree with the gate that actually enforces it.
Ours is computed at the gate. Keep `verifiedIdle()` and `homedThisSession()` as
they are.

**What to carry forward instead, as a rule on the backend:** LinuxCNC does
report task and interpreter state, and a backend may well be able to say "the
controller would refuse this right now". **That is STATUS, and it is reported as
a fact, not installed as a veto.** A backend that turns a far-end mood into a
local refusal has invented a gate nobody ordered.

## What this means for the size of a LinuxCNC backend

This is the number the operator's decision needs.

| # | candidate | verdict | size |
|---|---|---|---|
| 1 | explicit UNKNOWN command outcome | **adopt**, narrowly | contract growth: one additional outcome value, plus the call sites that can time out |
| 2 | injected monotonic clock | **not needed**; convert interval arithmetic to `performance.now()` anyway | not a LinuxCNC prerequisite; small; one motion-relevant site |
| 3 | stop as its own path | **keep** - already true end to end | a doc comment on `controller.ts:1234`, on the safety lane |
| 4 | joints vs Cartesian pose | **adopt**, additive and optional | contract growth: one optional status field, one capability |
| 5 | per-command permission / stale-forbids | **not needed**; stale rule rejected | nothing |

**So the contract prerequisite for a LinuxCNC backend is two additive, optional
changes and one comment.** The interface ADR-0041 built does not need rebuilding
to take a third backend; that is the abstraction doing its job.

**The cost is the backend and its test equipment, not the contract.** Two things
set that cost, and neither is on the list of five:

1. **A transport.** GRBL gets a byte pipe, the AXBB-E gets a JSON message
   channel through a local bridge (`ControllerBackend`, `controller.ts:1412`).
   LinuxCNC runs on its own Linux host and speaks its own remote interfaces;
   which one, and whether it needs a local bridge the way the AXBB-E does, is
   the first real question a LinuxCNC order has to answer.
2. **ADR-0048 applies in full.** We do not own a LinuxCNC. A LinuxCNC backend
   ships in ADR-0048's second tier - **verified in simulation, unverified on
   hardware, and it says so per feature** - and ADR-0048's "diligence in
   simulation is a floor, not a best effort" means the simulator to ask those
   questions of is part of the build, not an optional extra. LinuxCNC ships its
   own simulation configurations; standing one up headless is work, and it is
   the work that makes the backend provable at all.

## Consequences

Good:

- the operator can decide when LinuxCNC becomes a third backend knowing the interface is
  nearly ready and that the real cost is transport plus test equipment.
- Two of the five verdicts close defects in the code we ship **today**, under
  every backend: a timeout that reports a running probe as a failure (1), and a
  wall clock that can release held motion early (2). Neither waits on LinuxCNC.
- The two rejections are recorded with their reasons, so the next sweep that
  reads the same study does not re-open them.

Costs, honestly:

- Adding a third outcome value touches the call sites that currently return a
  bare boolean. Every one of them is a place we are currently telling a caller
  something we do not know, so the churn is the point - but it is churn in a
  safety path and it lands one call at a time, not in a sweep.
- Three backends' capability objects are pinned by exact-shape `toEqual`
  assertions (`grblControllerContract.wo418`, `simulatedController.wo420`,
  `uccncController.wo421`). A new capability for item 4 must be OPTIONAL for
  that reason, the same way `machineProgram` and the per-axis input fields are
  (`controller.ts:280-296`).
- Nothing here is confirmed against a running LinuxCNC. Every LinuxCNC statement
  above is marked as desk reading of its published interface, and the first
  LinuxCNC order confirms them before it writes a line of backend.

## What happens next

Nothing in this ADR is implemented by it. On acceptance, one child order per
adopted item, each inheriting WO-1844's review lane because each touches the
command/control path:

- **(1) The unknown outcome.** The one that must exist before a LinuxCNC
  backend, and the one that fixes a defect we have already measured.
- **(3) The comment on `emergencyStop`.** Comment-only, safety file, own order.
- **(4) Joints on the status frame.** Optional field plus optional capability;
  no backend has to implement it on the day it lands.
- **(2) `performance.now()` for interval arithmetic.** Independent of LinuxCNC;
  file it on its own merit, not behind this.

**Item 5 produces no order.** Whether to build the LinuxCNC backend at all, and
when, stays the operator's call - this ADR exists to price it, not to start it.

## References

- `src/lib/machine/controller.ts` - `MachineStatus` :691, `ZeroWorkAxisReceipt`
  :921, `OutputSwitchReceipt` :1045, `verifiedIdle` :1106, `homedThisSession`
  :1127, `homedAxesThisSession` :1145, `emergencyStop` :1234, `spindleOff`
  :1250-1257, `unhomedAxes` :199-217
- `src/lib/machine/uccncController.ts` - `PROBE_CALL_TIMEOUT_MS` :105-108,
  `emergencyStop` :1330-1337, `call` :2113-2133, `fireAndForget` :2226-2233
- `src/lib/machine/machineSession.ts` - output on-delay :4905/:4918, geometry
  arrival :6569-6591, E-STOP mode ruling and `resetEstop` evidence :8210-8272
- `pendant/uccnc-bridge/Bridge.cs` - `BoardOwner` classes :91-104, stop-latency
  harness :524-546; `pendant/uccnc-bridge/Machine.cs` - rc=7 e-stop latch
  :1231-1244
- `docs/machine/MACHINE-SEAT-HANDOFF.md` section 7 - slaved gantry, e-stop pin,
  soft limits, one-session bridge
- ADR-0041, ADR-0042, ADR-0048, ADR-0053
- Questions sourced from `LienCAM-next` (design study, never ran a machine):
  `src/domain/control/controllerSession.ts`,
  `src/adapters/control/linuxCncCommandPort.ts`,
  `docs/research/LCNC_SUITE_REVIEW.md` P0 rows
