# ADR-0053: Indexed first - a rotary orientation is a Setup, and CAM stays Cartesian

Date: 2026-09-23
Status: Accepted 2026-09-23 as a FRAMEWORK decision (WO-1838). Nothing in this
ADR is implemented; it decides the shape so the next rotary change is made on
purpose. Decide-and-log (LIENCAM.md rule 3) - the operator may reverse any section.
Relates to: ADR-0026 (one stock per setup; combined multi-offset posting),
ADR-0017 (machining orientation is canonical - still Proposed, its refusals
still live), ADR-0020 (nested coordinate hierarchy), ADR-0041 (controllers are
backends), ADR-0043 (the live program builder owns the geometry path),
ADR-0049 (one machine record, two lenses), ADR-0048 (verification tiers),
ADR-0003 (no silent fallbacks).

## the operator's words

Operator ruling 2026-09-21 (D8): *"And I like the idea of 4axis framework in time."*

Framework, and in time. This ADR is the framework. It builds no rotary
machining and files no child order; WO-1838 says child orders are filed only
when the operator says the time has come.

## Context

We have one half of a fourth axis and none of the other, and the asymmetry is
the reason to decide the shape before writing code.

**What exists (machine control).** Read from source, not from a census:

- `MachinePosition` carries optional `a`/`b`/`c` in degrees on top of the XYZ
  every backend reports (`src/lib/machine/types.ts:23`).
- `enabledControlAxes` resolves which axes are independently controllable and
  strips slaves, because *the operator's own enabled A follows Y* - it is a gantry
  motor, not a table (`src/lib/machine/controller.ts:118-130`). `isRotaryAxis`
  names A/B/C (`:131`).
- The machine definition stores per-axis `rotary` and `rotaryRollover` facts as
  typed settings rows (`axisDriveSettingKey`, `src/types/index.ts:448-465`).
- The G-code reader parses A/B/C words, keeps them modal, and refuses the cases
  it does not model (`src/lib/gcode/reader.ts:235-237, 1000-1036`).
- `ToolpathMove` already has optional `a`/`b`/`c`, with the contract comment
  *"These belong only to controller/file moves; CAM geometry remains
  Cartesian"* (`src/types/index.ts:3486-3492`).
- `buildMachineProgram` refuses an arc carrying a rotary endpoint, by name
  (`src/lib/program/buildMachineProgram.ts:540`).
- Five landed test files pin the control half: `rotaryAxisOnControl.wo1725`,
  `rotaryMachinePositionSeam.wo1725`, `rotaryProgramEntry.wo1726`,
  `rotaryWcsRoundTrip.wo1726`, `rotarySettingsInDefinition.wo1728`.

**What does not exist (CAM).** A case-insensitive search for rotary, 4th-axis,
a-axis and aAxis across `src/lib/cam/` and `src/cam3d/` returns no source file
at all. No strategy, no setup field, no post word. The post never emits an A:
`grep -ni rotary src/lib/post/` is empty.

**The fact nobody stores.** `AxisDefinition` (`src/types/index.ts:509-533`)
holds steps, velocity, acceleration, soft limits, a slave and six pins. It
holds nothing geometric. So the definition can say "A exists, is enabled, is
rotary, rolls over" and can never say **where the axis of rotation is in
space**. CAM cannot generate an indexed job without that number, and a wrong
one is a crash, not a wrong finish.

**The door that is already half-shut.** An "orientation" implemented by
rotating the geometry's pose is not available today: `classifyRotationOffZ`
(`src/store/dispatchGeo.ts:564`) classifies any off-Z pose as tilted or
flipped, and dispatch refuses it in the operator's words
(`src/store/index.ts:17203-17212`). ADR-0017 promises to retire those guards
and is still Proposed. A rotary design that assumes the pose route exists is a
design that depends on unstarted work.

## Decision

### 1. Indexed first. Wrapped is a separate product and a later ADR.

**Indexed**: the rotary turns to an angle, stops, and an existing 2.5D/3D
strategy cuts that face as a three-axis job. **Wrapped**: the rotary moves
while cutting.

We aim at indexed. Reasons, in order of weight:

1. Indexed needs *no strategy math*. Every operation we have already cuts a
   face; indexing changes which face is under the tool, not how the tool
   moves. Wrapped needs new path generation in every strategy that supports it,
   and a new feed model: a move mixing millimetres and degrees has no single
   feedrate, which is what G93 inverse-time exists for - and our own geometry
   route already refuses that mix by name (`reader.ts:1033`).
2. The emit boundary indexed needs *already exists*. `emitCombinedProgram`
   (`src/lib/post/emit.ts:700`) posts several setups into one program with a
   shared preamble, a per-section WCS select (`:429`), a global machine-frame
   safe-Z retract between sections, threaded tool/spindle/coolant state, and an
   optional pause. An indexed job is that loop plus one A word per boundary.
3. Indexed is *verifiable the way we verify things*. While the table is locked
   the cut is a three-axis cut, so the simulator, the engagement math, the
   holder-clearance gate and the workholding check all keep meaning. Under
   wrapped motion none of them do - the voxel and heightmap engines model stock
   as a fixed world box and cannot turn it.
4. Indexed is what a router with a rotary table is *for*: four sides of a rail,
   a hex on a shaft, a fixture plate flipped to an angle. Wrapped is for
   cylindrical engraving and camshafts.

Wrapped is not forbidden and nothing here blocks it - see section 6.

### 2. An orientation is its own Setup, related to the first, exactly like a flip.

**Decided: several Setups, one per orientation, joined by a recorded
relationship. NOT one Setup carrying a list of orientations.**

The precedent is `Setup.flipOf: SetupFlip` (`src/types/index.ts:3827-3841`,
`src/lib/cam/flipSetup.ts`, WO-288): *the same physical block, turned over, in
the same place, machined again.* An indexed orientation is that same sentence
with "turned over by hand about X or Y" replaced by "turned by the machine
about the rotary axis, to an angle". The pieces that make a flip work are the
pieces an orientation needs:

- Both sides share ONE work offset and the same stock, and the offset-claim
  rule already permits that: `conflictingWorkOffsetClaim` skips a setup bound
  to the same stock (`src/lib/post/workOffsets.ts:98-102`). No new rule needed.
- The second side gets its zero from the first side's plus the turn, in one
  safety module that is *called, never re-implemented*
  (`src/lib/machine/probeRoutines.ts:300-360`). An orientation's zero is the
  same arithmetic about a different turn.
- `emitCombinedProgram` already posts the pair as one file.

One Setup with N orientations is rejected because it reopens precisely what
ADR-0026 closed. A setup owns ONE WCS, ONE stock, ONE clearance plane, and one
answer to "where is the top of the material" - and the top of the material is
exactly what changes when the part turns. Heights, clearance, stock state and
the per-setup safe Z would all have to become per-orientation, which is
ADR-0026's multi-height-stock-in-one-setup model under a new name.

Concretely, the field to add when the time comes - a sibling of `flipOf`, not a
replacement for it:

```ts
/** Axis a rotary orientation turns about. Named, never inferred: turning about
 *  A is not turning about B, and a guess puts the cut on the wrong face. */
export type RotaryAxisName = 'A' | 'B' | 'C'

export interface SetupOrientation {
  /** The orientation this one is measured from (the 0-degree setup). */
  setupId: string
  axis: RotaryAxisName
  /** Degrees, in the controller's own sense for that axis. */
  angleDeg: number
  /** WHERE THE AXIS OF ROTATION IS, in the frame the two setups share.
   *  Required. A missing centreline is refused, never defaulted - see 4. */
  centreline: RotaryCentreline
}

export interface Setup {
  // ...
  flipOf?: SetupFlip
  /** Present only on a setup created as a rotary orientation of another. */
  orientationOf?: SetupOrientation
}
```

**The centreline is SETUP data, not machine data.** This is the choice that is
expensive to change, so it is the one stated most plainly: where the rotary
axis sits relative to the work zero is a fact about *this fixturing on this
day* - the table was bolted somewhere, the part was clocked in it, the
centreline was found by probing. It belongs with the setup that was probed, the
same way a WCS origin does. The machine definition may later carry a *default*
centreline for a permanently-mounted table, and the two lenses of ADR-0049 make
that one stored fact with two readers; but the value CAM generates from is the
setup's. Storing it only in the definition would make one probed number apply
to every project that machine ever opens, which is the stale-measurement
failure ADR-0050 refused for surface maps.

### 3. A toolpath carries Cartesian moves plus its Setup's orientation. The A word enters at one place: the post's section boundary.

The comment already on `ToolpathMove` - *"These belong only to controller/file
moves; CAM geometry remains Cartesian"* - is **ratified, not amended**. A CAM
strategy never writes `a`, `b` or `c` on a move it generates. Under indexed
machining nothing about a cut move depends on the angle: the table is locked
and the move is a three-axis move in that orientation's work frame.

The indexing move is emitted once per orientation boundary, in the post:

1. the outgoing section lifts to the global machine-frame safe Z that already
   clears every posted setup's stock top (`emit.ts:715-740`),
2. **then** the A word is emitted, alone on its block, at feed or rapid per the
   dialect,
3. **then** the incoming section selects its work offset and moves in XY.

That order is not a detail - turning a part that is still down in the material,
or moving in XY before the turn completes, is the collision this sequence
exists to prevent. It mirrors ADR-0026 decision 4 exactly, for the same reason.

On the live/geometry route (ADR-0043) the same rule holds one level down: the
indexing move is its own *step* in the built `MachineProgram` at the
orientation boundary, not a field on cut moves, and the load-time work->machine
resolve and soft-limit check see it like any other step.
`buildMachineProgram`'s rotary-arc refusal (`:540`) therefore stays true
forever on the indexed route, because no arc ever carries an A.

Consequence, deliberately: `src/lib/cam/`, `src/cam3d/`, the arc fitter, the
engagement math, the holder-clearance gate, the workholding check, the runtime
estimate and both simulation engines need **no change at all** for indexed
rotary. That is the whole argument for indexed first, stated as a diff.

### 4. What refuses, and what must never refuse (rule 11)

**Real limits - refuse, and name them:**

| Case | What the software says |
| --- | --- |
| An orientation with no centreline | "This orientation does not say where the rotary axis is. Probe or enter the centreline for <setup>." - never defaulted to 0, for flipSetup's own reason: a guess produces a plausible number on the wrong face. |
| The rotary axis is a slave | "A on this machine is slaved to Y - it drives the gantry, not a rotary table." The file route already refuses a word on a non-independent axis in almost these words (`reader.ts:1018-1023`); CAM uses the same test, `enabledControlAxes` + `isRotaryAxis`, never `definition.axes.find(a => a.enabled)`. |
| Simultaneous (wrapped) rotary cutting | "No strategy generates rotary motion while cutting yet." A statement of what is not built, with no suggestion that the operator did something wrong. |
| A rotary word on an arc, on G28/G30, in a canned cycle, or under G93 | Already refused with named messages (`buildMachineProgram.ts:540`, `reader.ts:1026-1036`). Unchanged. |
| Simulation of a turn | Each orientation simulates as its own pass; the readout says the rotation between passes is not modelled. Never draw a simulation that implies the part never turned. |

**Things the software CAN do, so it must not refuse or nag:**

- An ordinary three-axis job on a machine that happens to have a rotary axis
  enabled. Nothing changes, nothing asks. `HOMED_GATE_AXES`
  (`controller.ts:182`) already made this exact decision for homing gates -
  "adding rotary axes here would make every gate refuse on a 4-axis machine for
  an axis no gate is about" - and this ADR adopts that reasoning by name for
  every CAM-side gate.
- **An indexed setup on a machine with no rotary axis.** The software cannot
  *turn* the part, so it does not emit the turn; it can post that orientation's
  cutting perfectly well. So it posts the orientation, and says the turn must be
  made by hand and how far - which is the flip workflow we already ship. It does
  not refuse the job, and it does not tell the operator to restructure it.
- A project whose rotary table is not mounted today. That is a fixturing fact
  the software cannot see. It says what it assumed and where the centreline came
  from; it does not demand a re-probe it cannot justify.

### 5. The smallest first slice, and whether it is worth doing first

The smallest thing that genuinely cuts on a rotary table:

- (a) `Setup.orientationOf` + the centreline field, and a "new rotary
  orientation of this setup" path in `SetupModal` built the way
  `planSecondSideSetup` is - the app derives the new setup's frame instead of
  asking for an origin again.
- (b) the section-boundary A emit in `emitCombinedProgram`, in the order of
  section 3, behind the existing global safe-Z retract.
- (c) the refusals in section 4.
- (d) two orientations of one part, posted as one file, cut at the machine.

**Worth doing before the rest: yes - but not before the table exists.** The
slice is small because it reuses the flip and combined-post machinery, and it
delivers a real capability rather than scaffolding. But (a) the centreline can
only be measured on a real fixture, and (b) under the machine-seat rule a
rotary claim is proven by a readback from the board, never by a green test
(WO-1051: four rc=0 writes, four rc=7 readbacks). Built before the hardware
exists, this lands as a simulation-only feature - exactly where ADR-0048 puts
grblHAL, and not what the operator asked for. So: this slice is the first order to file
when the operator says the time has come, and nothing is filed before that.

### 6. What would close the door - do not do these

Written for the next architect, who will meet one of these as a two-line
cleanup:

1. **Do not delete `a`/`b`/`c` from `ToolpathMove` as dead code.** They are the
   wrapped-motion seam and the file route's carrier. They are unused in CAM *by
   this decision*, not by accident.
2. **Do not add A/B/C to `HOMED_GATE_AXES`** or to any other gate about machine
   coordinates. See section 4 and `controller.ts:168-182`.
3. **Do not read "the definition enables A" as "this machine has a rotary
   table."** the operator's machine fails that test in the worst way: it answers yes
   and A is a slaved gantry motor.
4. **Do not implement an orientation by rotating the geometry's pose.**
   Derivation refuses off-Z poses today (`dispatchGeo.ts:564`,
   `store/index.ts:17203-17212`) and ADR-0017, which retires those guards, is
   unstarted. The orientation belongs on the Setup.
5. **Do not put the centreline only in the machine definition.** Section 2.
6. **Do not let the post learn a second way to emit a work offset or a
   retract.** The boundary in `emitCombinedProgram` is the one place.

### 7. Out of scope, deliberately

Five-axis, simultaneous multi-axis, turning/lathe, and tilting heads (a B or C
that tilts the *spindle* rather than turning the *work* - a different geometry
problem with a different tool-length story). WO-1838's standing caution forbids
widening into these and Next's own census deferred them. This ADR is written
for a rotary table turning the work about an axis parallel to X or Y.

## Alternatives considered

- **Wrapped first.** Rejected: new strategy math, a feed model our own geometry
  route refuses (G93 mixing mm and degrees), and no simulation or engagement
  check that still means anything. It is the second product, not the first.
- **One Setup carrying a list of orientations.** Rejected: reopens ADR-0026's
  multi-height-stock ambiguity, since the orientation changes the stock top that
  heights, clearance and safe Z all resolve against.
- **Cut moves carry an A coordinate from CAM.** Rejected for indexed: under a
  locked table the angle is constant across a whole setup, so putting it on
  every move stores one fact N times, and it would spread rotary awareness into
  every strategy, the arc fitter, the simulators and the engagement math for no
  behaviour. It is the right answer for wrapped, and wrapped gets its own ADR.
- **Bake the orientation into the geometry pose (one setup, rotated model).**
  Rejected: blocked by the live ADR-0017 refusals (section 6.4), and it would
  make the rotary angle a property of the *model* rather than of the fixturing.
- **A rotary-specific operation type ("4-axis face").** Rejected: the whole
  value of indexed is that existing operations work unchanged. A new operation
  type would be a second implementation of every strategy it wrapped.
- **Emit the turn from the bridge / the controller backend.** Rejected under
  ADR-0041: the app speaks, controllers are backends. A turn invented at the
  far end would not appear in the posted file, the preview or the soft-limit
  check.

## Consequences

- The rotary framework question is answered before anyone implements it, which
  is what WO-1838 was filed for. No src/ change: this order's deliverable is
  one ADR, per its own scope line.
- The first rotary CAM order, when the operator says the time has come, is section 5's
  slice and touches: `src/types/index.ts` (`SetupOrientation`, `Setup`),
  `src/lib/cam/flipSetup.ts` or a sibling for the orientation frame math,
  `src/components/modals/SetupModal.tsx`, `src/lib/post/emit.ts`
  (`emitSetupSection` / `emitCombinedProgram`), `src/lib/post/workOffsets.ts`
  (no change expected - the same-stock exemption already covers it, and the
  order must pin that with a test rather than assume it), and
  `src/lib/machine/probeRoutines.ts` for the centreline probe.
- Schema: `orientationOf` is optional and absent on every existing project, so
  it needs no migration (ADR-0040: no legacy before 1.0 - fixtures are
  regenerated, never migrated).
- Simulation stays honest rather than complete: an indexed job is several
  simulated passes with the turn unmodelled and said so. Turning stock in the
  voxel field is a separate, larger decision and is not taken here.
- Hardware: no rotary CUT claim is made anywhere from a green test. The first
  slice's verdict comes from the board, with the operator and the machine seat present
  (WO-1838's standing caution).
- This ADR is listed in `docs/decisions/README.md` so the next architect meets
  it while reading the ADR index. Pointing STATUS.md and docs/ARCHITECTURE.md
  at it is outside WO-1838's owned paths and is left to the architect.

## References

- WO-1838 `queue/WO-1838-a-fourth-axis-the-cam-side-can-grow-into.md`
- `src/lib/machine/types.ts:23` (`MachinePosition` a/b/c)
- `src/lib/machine/controller.ts:118-131` (`enabledControlAxes`,
  `isRotaryAxis`), `:168-182` (`HOMED_GATE_AXES` and its reasoning)
- `src/types/index.ts:448-465` (rotary settings keys), `:509-533`
  (`AxisDefinition` - no geometry), `:3486-3492` (`ToolpathMove` a/b/c and its
  contract), `:3827-3850` (`SetupFlip`, `Setup`)
- `src/lib/cam/flipSetup.ts` (WO-288 - the same block, turned over),
  `src/lib/machine/probeRoutines.ts:300-360` (second-side zero)
- `src/lib/post/emit.ts:700` (`emitCombinedProgram`), `:429` (WCS select),
  `:715-740` (global safe Z)
- `src/lib/post/workOffsets.ts:77-102` (`conflictingWorkOffsetClaim`,
  same-stock exemption)
- `src/lib/program/buildMachineProgram.ts:540`,
  `src/lib/gcode/reader.ts:1000-1036` (rotary refusals already shipped)
- `src/store/dispatchGeo.ts:564`, `src/store/index.ts:17203-17212` (live
  off-Z pose refusals ADR-0017 would retire)
- Tests pinning the control half: `src/tests/machine/rotaryAxisOnControl.wo1725.test.tsx`,
  `rotaryMachinePositionSeam.wo1725.test.ts`, `rotaryProgramEntry.wo1726.test.tsx`,
  `rotaryWcsRoundTrip.wo1726.test.ts`, `rotarySettingsInDefinition.wo1728.test.ts`
- ADR-0026, ADR-0017, ADR-0041, ADR-0043, ADR-0048, ADR-0049, ADR-0050, ADR-0040
