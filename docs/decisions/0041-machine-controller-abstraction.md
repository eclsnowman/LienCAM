# ADR-0041: LienCAM speaks its own machine language; controllers are backends

Date: 2026-08-21
Status: accepted
Authority: Operator ruling 2026-08-21 - *"I still want the system to be capable of running
multiple controllers... if the cheaper way to do it is to instead make our
program speak its own language and translate out to grbl or uccnc or
whatever... we'd be breaking the hardware abstraction layer further up so our
system could be more efficient for what it needs to do."* Then: *"okay, we'll do
it now."*

## Context

Machine control was built against GRBL 1.1. `GrblController` is not a generic
controller - it is one specific implementation of GRBL's `ok`/`error`/`<...>`
wire contract, including its 128-byte character-count flow control. GRBL became
LienCAM's internal machine language by default, not by decision.

Adding the AXBB-E via the UC100 API (see `docs/research/uccnc-control-plan.md`)
forced the question. The first design made the bridge *emulate GRBL* so nothing
above it changed. That works, and it was cheap, but it translates **uphill**:

- The AXBB reports **which move is executing, by an id we assign**. GRBL has
  only a line number, so the id is flattened into one.
- The AXBB buffers **seconds of motion**. GRBL counts bytes, so the bridge has
  to invent a byte budget the controller does not have.
- The AXBB accepts **geometry** (`AddLinearMove`/`AddCircularMove`). GRBL accepts
  only text - so under a GRBL-internal design, every toolpath must become G-code
  before it leaves LienCAM.

That last point is decisive. Sending geometry straight to the controller - no
post-processor loss, no arc-fitting tolerance, every move traceable to the
operation that made it - was the main reason to drive the controller directly at
all. A GRBL-shaped internal language throws it away at the door.

## Decision

Introduce `MachineController` (`src/lib/machine/controller.ts`) as LienCAM's own
machine-control language. Everything above it - `machineSession`, the Control
page, arming, the e-stop interlock, probing, step-back - depends on the
interface. Firmware protocols live in backends:

| backend | translates to |
| --- | --- |
| `GrblController` | GRBL 1.1 text over a byte pipe (serial, or websocket) |
| `UccncController` | UC100 / AXBB-E calls, via the machine-local bridge |
| `SimulatedController` | nothing - pure software, no protocol emulated |

Two rules govern the interface, and both are in the file:

1. **Signatures follow the working implementation.** Almost every member is
   transcribed from `GrblController` as it already exists, so that backend
   satisfies the interface with no behaviour change. Only genuinely
   firmware-specific members changed: `grblVersion` -> `firmwareVersion`,
   `overrideByte(byte, label)` -> `setOverride(change)`, `softReset` -> `reset`.
   Designing a "nicer" shape would mean rewriting a proven controller for no
   gain.

2. **No lowest common denominator.** The interface exposes
   `ControllerCapabilities` and callers ask. `geometryQueue`,
   `executingMoveId`, `bufferSeconds`, `perAxisHoming`,
   `ownsSpindle` are all things one controller has and another does not.
   Optional members (`loadMoves`, `homeAxes`) exist only
   where a capability guards them. A field being false is a statement about the
   controller, never a limit imposed on LienCAM.

`MachineStatus` reports unavailable fields as `null` rather than inventing
values, so the UI can say "unknown" honestly.

## Consequences

Amendment, 2026-08-29: LienCAM has no hardware dry run (Operator ruling 2026-08-23 and
2026-08-29). Outputs are live on connect; controller capability reports do not
create an operator dry-run mode.

Good:

- The geometry path becomes possible at all. That is the feature, not tidiness.
- Translation runs downhill. Narrowing a rich model to a poor one is dropping
  fields; widening a poor one to a rich one means fabricating information.
- Two GRBL emulators (~1,200 lines: `simulatedTransport.ts` and
  `pendant/sim-grbl.mjs`) exist only to fake a protocol. A native
  `SimulatedController` implements the interface directly - less code, faster
  tests, nothing pretending.
- New controllers (such as LinuxCNC over `linuxcncrsh`) are peers rather than
  things that must cosplay as GRBL.

Costs, honestly:

- One more layer between the UI and the wire.
- `machineSession.ts` (2,203 lines) changes what it depends on. Mitigated by
  rule 1: the interface was shaped to fit, so this is a type change, not a
  rewrite, and the compiler finds every call site.
- The bridge's GRBL emulation (~150 lines of C#) is discarded. It was
  scaffolding and was known to be scaffolding when written.

Rejected alternatives:

- **Keep emulating GRBL in the bridge.** Cheapest now, but forecloses the
  geometry path and gets more expensive at the program-run slice, where GRBL's
  byte-budget streaming model has to be faked against a controller that has no
  such thing.
- **Defer until after jog and stops work.** Considered and rejected by the operator.
  Deferring means writing jog, stops and probing into the GRBL shape first and
  rewriting them after.

## Notes

The G-code text helpers currently in `grbl/streamer.ts` -
`stripGcodeComments`, `isSendableGcodeLine`, `prepareProgram` - are not GRBL
concepts and are imported by four non-GRBL modules. They move to a neutral
`src/lib/gcode/` module. That is filing, not architecture, and is worth doing
whatever else happens.
