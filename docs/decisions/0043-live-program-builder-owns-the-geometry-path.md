# ADR-0043: the live program builder - who owns the geometry path, and what it inherits from the post

Date: 2026-08-26
Status: Accepted 2026-08-26. Both stand: the machine seat argued it and agreed
with Amendment 1 (the persisted work offset, WO-1027, landed); the operator ruled
"Agree - proceed" on card Q-SENDING-A-JOB-STRAIGHT-TO-THE-AX-1787725949776
(2026-08-26T11:50Z) and, on the benchmark card, "Build the bridge path - I want
to measure OUR software" - which is precisely the geometry path this ADR owns.
Authority: Operator ruling 2026-08-25 - *"the software architecture as a whole has not
been properly mapped, structured and architected ... I don't want to build our
house on sand and watch a collapse."* Operator ruling 2026-08-26 - *"the system must be
agnostic of the controller and translate at the boundary."* The architecture
audit (`docs/ARCHITECTURE-AUDIT-2026-08-26.md`, section 3.2 and order 4) found
the gap this ADR closes and said WO-1019 must be blocked on it.

## Context

ADR-0001 and ADR-0021 give the **file postprocessor** every controller-facing
responsibility for a program written to disk: the world->work transform,
G54-G59 selection and G10 register writes, tool-change sequencing, spindle and
coolant interleaving, arc fitting, preamble and postamble. ADR-0041 then
introduced a second route to a machine - geometry straight to the controller
through `MachineController.loadMoves(QueuedMove[])` - and said its whole
justification was "no post-processor loss". Between those two decisions nobody
said **who does the post's work on the route that bypasses the post.**

Measured on main (commit 4158fbde), that gap is not theoretical:

- `QueuedMove` is `line | arc | dwell | marker` (`src/lib/machine/controller.ts:220`).
  It can carry a toolpath. It cannot carry a program: no spindle, no coolant,
  no tool change, no offset write. A real job is inexpressible on the geometry
  path even once `loadMoves` is wired.
- Nothing in `src/` builds a `QueuedMove` or calls `loadMoves` (WO-1019). The
  flagship controller, the AXBB-E, declares `gcodeText: false` and always will
  (`uccncController.ts:158`), so the product refuses every program on it -
  honestly (`machineSession.ts:2034`), but by construction.
- **The wire's coordinate frame is undeclared, and the bridge already answers it
  two different ways.** A streamed program move goes to the board raw -
  `UC100.AddLinearMoveP(m.X, m.Y, m.Z, ...)` at `pendant/uccnc-bridge/Machine.cs:4159`,
  no offset applied, so it is a MACHINE coordinate. The bridge's own
  `JogToWorkXY` adds `offsets[activeWcs]` first (`Machine.cs:3042`), so that
  call takes a WORK coordinate. `QueuedMove` says nothing about which it is.
  The path-fidelity check noticed - it carries `frame: 'work' | 'machine'` on
  its arming (`machineSession.ts:651`) because it could not tell.
- The transform the post uses is one function, `toWork` in
  `src/lib/post/coords.ts:19`, inside the post layer - so a second consumer of
  `ToolpathMove[]` would either import the post (forbidden by ADR-0021's
  one-way rule) or copy the function (the two-lists failure the audit found in
  persistence).
- The post's program shape is `assembleSections` (`src/lib/post/assemble.ts`):
  preamble -> per-operation section carrying `tool`, `spindle {rpm, dir}`,
  `coolant`, `moves` -> postamble. That structure is not G-code; it is the
  program. It also lives inside the post.

The audit's verdict applies here exactly: a boundary survives in this codebase
only when a TYPE or one SHARED FUNCTION stands at the seam. The geometry path
has neither. This ADR puts both there.

## Decision

### 1. There is a live program builder, and it is a peer of the post, not a part of it

    src/lib/program/          the SHARED program layer - neutral, imports neither
                              the post nor the store nor any backend
      buildMachineProgram()   PostInput -> MachineProgram   (the live builder)
      toWork()                moved here from src/lib/post/coords.ts
      assembleSections()      moved here from src/lib/post/assemble.ts

    src/lib/post/             the FILE builder. Imports src/lib/program/ for the
                              two shared functions. Otherwise unchanged.

Both builders consume the same `PostInput` (a setup's ordered enabled
operations plus tool/machine/WCS/stock context, built by `buildPostInput`).
Both apply the same `toWork`. Both walk the same `assembleSections`. **One
setup, two renderings** - a file of text, or a `MachineProgram`. They cannot
disagree about the transform or the sequence because there is one copy of each.

The boundary table in `docs/ARCHITECTURE.md` gains a row:

    Program builders          FILE post: YES, a dialect, by design (ADR-0021).
    (post / live builder)     LIVE builder: NO controller identity, ever. It may
                              read ControllerCapabilities and nothing else about
                              the machine it is building for. Every difference
                              between backends is a capability value, never a
                              name. This is the post-dialect pattern (audit 1.2)
                              applied to the geometry path.

### 2. `MachineProgram` is the program; `QueuedMove` stays the motion vocabulary

    interface MachineProgram {
      frame: 'work'                       // declared, always work - see 3
      units: 'mm'                         // declared, always mm - see 3
      steps: ProgramStep[]                // ordered; ids unique across ALL steps
      index: ProgramIndex                 // id -> { opId, setupId, moveOrdinal }
    }
    type ProgramStep = QueuedMove | MachineAction   // both carry `id: number`

`MachineAction` is the agnostic action type the boundary section already
requires and the audit's order 1 delivers - at minimum spindle (direction,
rpm), coolant (channel, on/off), dwell, tool change (tool number, description),
tool length offset, work-offset select and write, park, and an operator pause
with a message. **This ADR does not design that type; it fixes where it sits:
inside the program, at its position in the sequence.** A program is one ordered
list. It is not "moves plus a side list of things to do first".

Ids: the builder assigns them, sequential from 1, unique across the whole
program, action steps included. **0 is reserved** - it is the bridge's connect
sentinel (`Machine.cs:426`). `ProgramIndex` maps every id back to the
operation and move that produced it; run-from-line, step-back, the path
fidelity check and the operator readout all key off ids through that index and
never off a line number. This is the answer to WO-1019's question 2, and it is
the only id scheme.

### 3. Which post responsibilities the geometry path inherits, and who does them

| Responsibility (ADR-0021 gives it to the post) | On the geometry path |
| --- | --- |
| World -> work transform (subtract `wcs.origin`, un-rotate) | **The builder**, via the shared `toWork`. The program is in WORK coordinates. |
| Work -> machine (the G54..G59 register) | **The controller.** The bridge applies `offsets[activeWcs]` to program moves exactly as it already does for `JogToWorkXY`. The machine's own offset register is the single source of truth for that number - the same register a posted file runs under, so route one and route two put the tool in the same place. |
| G54-G59 selection | A `workOffset.select` action step at program start. |
| G10 L2/L20 register writes (ADR-0020 per-stock offsets) | A `workOffset.write` action step. Refused by the builder, by name, if the backend does not declare the capability. |
| Tool change + M0 pause | A `toolChange` action step carrying the tool number. The backend renders it (the bridge: stop motion, park if designated, pause with the message; a text backend: its dialect). The guided tool-change flow keys off the step, not off `findToolChanges(text)`. |
| Spindle on/off, coolant on/off between sections | `spindle` / `coolant` action steps at the positions `assembleSections` puts them. |
| Rapids | `ToolpathMove.type === 'rapid'` has no feed and the bridge refuses a move without one (`Bridge.cs:2382`). The builder resolves the feed from the machine definition's declared rapid rate - the same reader the text door uses for `rapidFeedMmMin` - and the step carries `rapid: true` so instruments know it was a rapid. No default is invented (`4dcf9701`). |
| Arc fitting (`post/arcfit`) | Shared stage, same chordal tolerance, run only when the backend declares arc support. The first slice runs lines only. |
| Units | Always millimetres on the wire; the bridge already converts feed to units/second. A controller whose profile is in inches is refused by capability until a conversion exists (ADR-0003, fail loud) - never silently scaled. |
| Preamble / postamble modal setup (G17 G21 G90 G94) | **None.** There is no modal state on the geometry path: plane is per arc step, units and absolute mode are declared on the program. |
| Dwell | `QueuedMove` dwell, in seconds; the bridge converts to milliseconds (`Machine.cs:4188`). |

**Declared, not inferred**: `frame` and `units` are on the type and on the
wire. A bridge that receives a program without them refuses it. That is what
turns the fidelity check's `'work' | 'machine'` guess into a fact.

### 4. The backend executes the program in order; the session does not interleave

`MachineController` gains `loadProgram?(program: MachineProgram)`, guarded by a
capability, beside `loadMoves`. The backend that receives a `MachineProgram`
executes ALL of it in sequence - motion steps through its queue, action steps
through whatever it uses for those intents - and one job state machine governs
stop, pause, feed hold and progress for the whole run.

For the bridge that means the staged stream (`StreamStaged`, `Machine.cs:4041`)
learns the action step kinds: on reaching one it lets the board's queue drain,
performs the action (the VFD call it already owns for `spindleOn`, the pause,
the offset select), then resumes pushing motion. Unknown kinds are already
refused by name at `LoadMoves` (`Machine.cs:3959`), so an old bridge fails loud
against a new program rather than running half of it.

Text backends are unchanged today. They keep the text door: a posted file IS a
declaration that the machine takes G-code (boundary section, "User text is
itself a declaration"). A text backend MAY later implement `loadProgram` by
rendering the program through its own dialect config; that would be the
GRBL-side half of this ADR and is sequenced, not decided here.

### 5. What this does to WO-1019

WO-1019 is unblocked by this ADR and re-scoped by it:

- It depends on order 1 (the `MachineAction` type and the `MachineProgram`
  container) and on the shared-function move in section 1.
- Its first slice is exactly the one it already proposed, now with a frame:
  **a straight-line-only `MachineProgram`, `frame: 'work'`, zero action steps,
  ids from the builder, run on the demo board, with stop and pause proven.**
- The refusal at `machineSession.ts:2034` stays until the program path can
  step, pause and stop; it is then replaced by the `loadProgram` route, not
  weakened around.

## Alternatives considered

**Render the program to G-code and have the bridge interpret it.** Rejected:
the AXBB-E has no G-code interpreter, that is the round trip ADR-0041 exists to
remove, and a text intermediate reintroduces line-shaped progress on a
controller that reports ids.

**Let the session interleave: `loadMoves` for each motion run, intent calls
for the actions between runs.** Rejected. It puts a second job state machine
above the backend, so stop, pause and "which step is executing" live in two
places - which is precisely the "half-path that loads but cannot step, pause or
stop" WO-1019 forbids, and it violates "NO GATE MAY EVER BLOCK A STOP" the
moment the two disagree about whether a job is running.

**Put the world->work transform in the bridge, send world coordinates.**
Rejected: the project's WCS origin is CAM-side state the bridge has no business
holding, and it would make the file route and the geometry route transform in
different places with different code - the exact two-copies failure this ADR
removes.

**Send machine coordinates (what the bridge does today).** Rejected: it makes
the builder read the machine's offset register, so the CAM side would hold a
copy of a machine fact that the machine owns; the copy goes stale the moment
the operator zeroes an axis on the pendant. The register is the machine's, so
the machine applies it - and it already does for `JogToWorkXY`.

**Keep `QueuedMove[]` as the program and add action kinds to it.** Rejected
only in name: the steps DO travel in one list. But a program has properties a
move list does not - a frame, units, an index - and pretending the container
is the same type as its motion elements is how `StreamerProgress` ended up
counting lines on a controller that has none.

**Make the live builder part of `src/lib/post/`.** Rejected: ADR-0021 makes
the post a dialect by definition, and the live builder must know no dialect.
Sharing the two functions through a neutral module keeps the post's one-way
rule intact and gives the seam the one shared function the audit says a
boundary needs to survive here.

## Consequences

Good:

- A real job - spindle up, cut, tool change, cut, spindle down - becomes
  expressible on the geometry path. Without this, WO-1019 ships a product that
  can move and cannot machine.
- One transform, one sequence, two renderings. The file route and the live
  route cannot drift, and the cheapest test of that is a fixture posted both
  ways and compared step-for-step.
- The wire's frame is a declared fact. The path-fidelity check, the readout
  and the bridge all read the same field.
- The live builder is unit-testable with no machine, no bridge and no store,
  the same way the post is.

Costs, honestly:

- Two moves inside `src/lib/`: `toWork` and `assembleSections` change import
  paths. Mechanical; the compiler finds every site.
- The bridge's wire contract grows action step kinds and a program envelope.
  That is machine-seat work in `Machine.cs`/`Bridge.cs`, and it is why this ADR
  is Proposed until they have argued it.
- The bridge's program frame CHANGES from machine to work. Every harness run to
  date (`pendant/circle-test.mjs`, `repeat-run.mjs`) sent machine coordinates.
  Those harnesses must declare `frame` explicitly or be refused; nothing may
  guess.
- Every text-shaped feature (run-from-line, step-back, single block, guided
  tool change, surface-mesh compensation, the readiness surface) needs an
  id-shaped twin before the geometry path is at parity. This ADR names the id
  scheme they will share; it does not build them. That is the size WO-1019's
  question 3 warned about, and it is why the first slice is lines only.

## References

- `docs/ARCHITECTURE-AUDIT-2026-08-26.md` sections 0, 3.1, 3.2, 7, order 4
- `docs/ARCHITECTURE.md` "Machine control boundary" and "Postprocessor boundary"
- ADR-0001 (toolpath/post separation), ADR-0020 (work offsets), ADR-0021 (post
  architecture, rule 4: the post owns coordinate emission), ADR-0041 (the
  controller interface and the geometry route), ADR-0003 (no silent fallbacks)
- `src/lib/machine/controller.ts:220` (`QueuedMove`), `:695` (`loadMoves`)
- `src/lib/post/coords.ts:19` (`toWork`), `src/lib/post/assemble.ts:17`
- `pendant/uccnc-bridge/Machine.cs:3042` (jog adds the offset), `:4159` (program
  does not), `:3951` (`LoadMoves` refuses unknown kinds), `:426` (sentinel id 0)
- `docs/research/uccnc-control-plan.md` section 12 (ids on the bench, the stale
  `CurrentID` trap)
- WO-1019 (blocked on this ADR; re-scoped by section 5)

## Amendment 1 - 2026-08-26, from the machine seat's review (accepted by the architect)

The machine seat verified the frame asymmetry (`Machine.cs:4159` raw,
`:3042` offset-adjusted) and argued FOR work coordinates on the envelope,
with one condition that is now part of this decision:

**Work-frame programs are safe only once the offset they resolve against is a
persisted fact.** Today the bridge's offset table is `readonly double[6,3]`
seeded from the UCCNC profile once at `Open` (`Machine.cs:1923`, `:552`),
mutated in memory by `ZeroWorkAxis` (`:2896`), and saved nowhere. A work zero
set through the bridge evaporates on restart and is not the offset UCCNC runs
a posted file under. **WO-1027** (machine seat) makes the table persist to the
profile keys UCCNC reads, and section 3's row "Work -> machine: the controller
applies its own register" means THAT persisted table. The program-frame change
lands together with WO-1027 or not at all.

Also established by the same review, and binding on the probe order:

- **The bridge's `probe` call is MACHINE in and MACHINE out** - `ProbeStart`
  takes the target unadjusted (`:3905`) and `GetProbePosition` returns raw
  board coordinates (`:3939-3941`). The session's existing G38.2 path already
  converts from `[PRB]` machine coordinates, so moving it onto the intent
  changes the transport and not the arithmetic.
- **`MachineController.probe(axis, targetMm)` currently has two meanings**:
  the bridge and the simulator treat `targetMm` as an ABSOLUTE machine target;
  `GrblController.probe` treats it as SIGNED RELATIVE travel in G91
  (`grbl/controller.ts:677`, flagged as unconfirmed in its own WO-418 note).
  The interface is fixed at absolute machine target - two backends and the
  board API already mean that - and GRBL converts from its own reported
  machine position. That is a separate, disjoint order before the session's
  probe cycles move.
- The machine seat's harnesses (`circle-test.mjs`, `repeat-run.mjs`) will
  declare `frame: 'machine'` rather than convert: they are deliberately
  absolute, run in free air against soft limits, and a work-frame harness
  would be measuring the offset table instead of the machine. The envelope
  therefore admits `frame: 'work' | 'machine'`, declared; the LIVE BUILDER
  only ever emits `'work'`.

## Amendment 2 - 2026-08-26, the load-time resolve and the frame requirement (machine seat)

Accepted after the operator's "Agree - proceed". The machine seat confirmed by reading
that `StreamStaged`/`PushMove` send program moves RAW today
(`AddLinearMoveP(m.X, ...)`, Machine.cs) while `JogToWorkXY` adds
`offsets[activeWcs]` - so the shift lives in the bridge, as section 3 says, and
these two properties are now binding on the bridge half:

1. **Resolve and soft-limit-check at LoadMoves, not at push time.** The bridge
   resolves every step work->machine ONCE at load using `offsets[activeWcs]`,
   checks each resolved coordinate against the soft limits, and **refuses the
   WHOLE program with a named reason and the offending step** if any falls
   outside. It stages resolved machine coordinates; `StreamStaged` is unchanged,
   so the id space, `executingMoveId`, path fidelity and the backpressure
   counter are untouched. This turns the worst failure we know - an illegal move
   mid-run that alarms the board and leaves every later program silently
   accepted-but-dead until a bridge restart (WO-932/933, measured A/B/C) - into
   a refusal before anything moves.
2. **`frame` is REQUIRED and its absence REFUSES**, by name, the same shape as
   the existing unknown-move-kind refusal. There is no safe default: assuming
   `machine` silently breaks the geometry path, assuming `work` silently shifts
   every existing harness by the active G54 (X 81.2275, Y 61.3225, Z 12.16 on
   the operator's machine today) - which is itself a soft-limit-poisoning case. The
   machine seat updates all five harnesses in the same commit to declare
   `frame:'machine'` (the empty-program staged-list-clear skips the requirement,
   since zero steps cannot be in the wrong frame).

**The re-zero question, answered (architect's call):** the program carries the
zero it was loaded with - a STATED property, not a discovered one. The bridge
holds the load-time snapshot and does nothing about a later re-zero. The SRC
side owns invalidation: if the active work offset changes after a geometry
program is loaded, the app marks the program not-ready and refuses Cycle Start
with "the work zero changed since this program was loaded - reload it." This is
not new machinery - `loadMachineProgram` ALREADY does exactly this for
surface-mesh compensation (`machineSession.ts:2015`, `meshWcsError`: "The active
work offset changed from G54 to G55. Probe a new mesh."). The geometry program
reuses that shape. No auto-reload: a silent re-resolve would re-arm the path
fidelity check at a surprising moment, which is the silent-disagreement class
this whole design exists to remove.

## Amendment 3 - 2026-09-08, a second route inherits the first route's guards

Accepted by the architect after the WO-1267 review, and named by the machine
seat: *"the g-code side had the guard and the new door was built without it -
that is a pattern here rather than a one-off."*

**The invariant.** Where this ADR gives the file route and the geometry route a
shared input (`PostInput`) and a shared transform (`toWork`), it did NOT say
what happens to the guards the file route wraps around that shared input. The
answer is now stated: **a second route to the same machine carries every refusal
the first route makes on the same input, or names in its work order why that
refusal does not apply to it.** Sharing a builder is not sharing a contract.
Silence is not an argument.

**Three occurrences, which is why this is a rule and not a note:**

1. **WO-1019** built the geometry door and left it with no caller. Its own
   comment named the disease - *"a capability that reports as present and has no
   door"*.
2. **WO-1267** gave that door a handle and did not carry across the post's
   CAM-12 guard. `collectToolpathSections` silently drops an enabled operation
   that computed to zero moves (`nesting/nestRuntime.ts`); the post re-adds every
   such operation with empty moves precisely so `validateOpsReady` refuses the
   run loudly (`post/buildPostInput.ts`). Without it the toolpath door armed,
   reported ready, enabled CYCLE START and left that operation's cut out. Caught
   in review, before landing.
3. **CAM-12 itself** exists because the same class of silent drop got through
   once already on the file route.

**What this obliges, concretely.** A work order that adds or widens a route into
a machine states which guards the existing route applies to the same input, and
for each one either carries it or says why it cannot apply. An audit or review of
such an order checks that list. A guard that exists on one route and not the
other is a defect on the route that lacks it, not a feature of the route that has
it - and it is invisible to every test that only exercises one door.

**Why this class is so hard to see:** both routes pass their own tests. The
defect lives in the difference between them, and nothing tests a difference. The
cheapest instrument remains the one this ADR's Consequences already named - one
fixture driven through both routes and compared - and it is worth more here than
another unit test on either side.

## Amendment 4 - 2026-09-11, the wire takes geometry; the app interprets text into it (WO-1335)

**This amendment corrects one clause of the Context above.** Line 34 reads: "the
flagship controller, the AXBB-E, declares `gcodeText: false` and always will...
so the product refuses every program on it - honestly, but by construction."
Everything in that sentence is true ABOUT THE WIRE and was read, for two months,
as a statement about the PRODUCT. It is not one, and reading it as one cost the
thing the operator had asked for repeatedly.

**What it cost.** On 2026-09-11, at his machine, the operator: *"I don't know how many
goddamn times I have to tell you that the software has to be able to run a g code
and run it on ours - if you need to build a translator or do whatever you got to
goddamn do... A CNC control software that cannot load the most standard file
format for controlling a CNC is not complete (.gcode and .nc)."* Measured the
same minute: Load -> Open file... -> `two-setup.nc` did NOTHING. No console line,
no staged moves, the previously loaded program still loaded. The text door handed
a posted file to a controller with no interpreter for it, and the silence was the
product of this clause.

**The amended rule, in one sentence:** `gcodeText: false` is a statement about
the WIRE - the bridge takes no text, and it still does not - and it never limits
what the PRODUCT can load. A geometry controller gains a text route in the APP:
`src/lib/gcode/interpret.ts` turns a posted file into the same stages the
toolpath route builds (a run of moves in one frame at one spindle state, ended by
the next frame, an M0/M1 hold, or the file's own M3/M5), and from there the load,
the frame selection, the spindle gate, the
travel check, the capacity split, the boundary hold and the readout are the
existing code, untouched.

**Which makes Amendment 3's obligation binding on this order, and it was met.**
The file route is a second route into the machine, so it states which guards the
toolpath route applies to the same input and carries each one: the frame must be
set on the controller before the first move (WO-1312), every stage's extent is
checked against the table with THAT stage's own offset (WO-1285), the program is
cut to the board's ceiling by the same `buildProgramParts` (WO-1044), the spindle
intent is taken only when the machine record AND the live controller both declare
the VFD path (WO-1275), and a program that would change tool is refused at the
door (WO-1323). The file's own spindle words are executed as well as read: an M5
with motion after it ends the section, the inverter is commanded off in the gap
before the next part is staged, and an M3 after it re-commands the speed and
holds the motion behind WO-1275's gate again. The instrument Amendment 3 asks for is the acceptance test:
`src/tests/machine/gcodeTextRoute.wo1335.test.tsx` drives the SAME two-setup
fixture through BOTH doors in one test and compares what reached the wire, frame
by frame and move for move.

**What this route deliberately does not do.** It does not touch the bridge, the
wire, or the toolpath route - which stays byte for byte and is the reference
this route is measured against. It builds no line list and no program context,
because nothing is streaming lines and a live text cursor over a geometry run
would be a readout that quietly lies.

## Amendment 5 - 2026-09-11, the dialect is what the UCCNC posts EMIT (WO-1335)

**Amendment 4 said the file route reads "LienCAM's own post, exactly", and that
was the wrong boundary.** Drawn there, the route refused the operator's own Fusion
output at `G43 H19` AND our own `two-setup-combined-posted.nc` at its `T2 M6` -
the two files the order's own acceptance names. A file route that cannot read
the files the machine is given is the same failure this ADR was amended to fix,
one layer up.

**The dialect is therefore measured from the posts, not from ours**, and the
rules are:

- **`G43 H<n>` is RESOLVED, not refused - BY ITS OWN NUMBER.** `H` indexes a
  controller tool table this bridge does not have, but **LienCAM owns the tool
  data**: the file door passes `interpretGcodeProgram` a resolver over the tool
  library (`gcodeToolLengthResolver`), and the shift is applied to every absolute
  Z until `G49`. `H` is looked up as the tool whose number it states - never the
  last `T` word, never a preselect - and the shift is ZERO, because the work Z
  zero was set with the cutter in the spindle and the file's numbers already mean
  its tip. An `H` no tool carries, two tools carry, or whose tool states no
  length is REFUSED by number at its own line. A caller that brings no library
  still gets the old refusal, because a route that cannot look a tool up may not
  stage a guessed Z.
- **`H` naming a tool that is NOT the one in the spindle is REFUSED**, at its own
  line, naming both numbers (architect ruling, 2026-09-11T05:31Z, on the audit's
  finding). On a machine with no controller tool table there is no gauge line to
  measure a second cutter's length from, so "T3's length minus T1's" is a
  confident number measured from nowhere: it would stage every cut below it at a
  depth nobody commanded, with nothing on screen to say so. The program is wrong
  and is told so at load.
- **A preselect and the cutter in the spindle are two different states.** A
  standalone `T` preselects and fits nothing; `M6` is what changes the tool in
  the spindle, and the tool-change hold names the tool being fitted from that
  state. Holding both in one variable is what let a `T2` typed after `T1 M6`
  decide what `G43 H1` resolved against.
- **A tool change is a BOUNDARY.** The section ends, the program HOLDS, the
  console names both tools by their library names, the boundary stops the
  spindle as every hold on this route does, and CYCLE START runs the rest.
  (WO-1330 owns the toolpath route's version of the same shape.) The one
  refusal left there is a tool change with the spindle still commanded on.
- **`G91` is CONVERTED.** The reader already resolved each incremental block
  against the position before it, so what is staged is absolute by construction.
- **Two spindle speeds in one file are allowed.** WO-1275's gate re-arms on
  every release, so the second speed is honoured by the mechanism that honours
  the first; the one-intent rule belongs to the multi-setup toolpath route.
- **`G64`/`G94` are accepted and SAID once** on the load line, and a user macro
  call (Fusion's `M2001`) HOLDS and names itself by number rather than refusing
  the file or being dropped.
- **A spindle start this machine cannot command is a HOLD.** Saying "start it at
  the machine" and releasing the cut in the same breath named an instruction
  nobody could carry out (audit, 2026-09-11).
- **Still refused:** inch units (ADR-0003, never silently scaled), dwells (no
  board readback has ever proved one runs), an O-word subroutine, a via-point
  return (`G28`/`G30`) the controller owns, cutter compensation, any word
  outside the shared reader's set, and any malformed line. `G53` and the canned
  cycles `G81/G82/G83` remain accepted - a machine-frame block resolves against
  the controller's own reported offset, and a canned cycle expands into the
  rapids and plunges this route already stages.

**Two gaps are named rather than papered over.** Coolant (`M7`/`M8`/`M9`) is
SAID at the line that states it and not commanded: coolant's only route out of
this app is the machine's configured action lines as MDI text, and
`sendMdiLine` locks MDI out for the length of a running program by design.
And the private sample program still does not load - not for a word, but
because it is full of HELICAL arcs, which `src/lib/program/buildMachineProgram.ts`
refuses product-wide until one has flown on this hardware.
