# LienCAM Architecture

This document describes the system architecture of LienCAM, a browser-based
CAM application. It is the canonical reference for how the project fits
together: layer boundaries, the operation contract, shared subsystems, the
type system, and the conventions that make every operation behave consistently.

Code conventions, workflow discipline, and engineering principles are in
docs/CONVENTIONS.md. This doc answers "what is the system?"; docs/CONVENTIONS.md
answers "how do we work on it?".

For the user-facing surface — React components, state management, viewport, and operation wizard — see docs/UI-ARCHITECTURE.md. This document and docs/UI-ARCHITECTURE.md form a pair; features spanning both layers require updates to both.

## Overview

LienCAM is an open-source, browser-based CAM application with no backend.
All toolpath computation runs client-side in a Web Worker. The application
accepts CAD geometry (DXF, SVG, STL, and STEP imports), lets users define
machining operations against that geometry, and produces G-code output.

The project's architectural goal is **a cohesive system of subsystems**:
each operation type (contour, pocket, drill, chamfer, adaptive clearing)
consumes shared infrastructure for height resolution, geometry primitives,
motion emission, and entry strategies, rather than reimplementing these
internally.

A second architectural pillar is **the separation of toolpath planning
from GCode generation**. Operations produce controller-agnostic
`ToolpathMove[]` — geometry with move-type intent and resolved feeds —
and a separate postprocessor (implemented in src/lib/post/) translates that
representation into GCode for a specific controller. This boundary makes the system
portable across controllers and keeps controller-specific concerns out
of operation code. See the Postprocessor boundary section below.

## System layers

LienCAM has five logical layers. Each has a defined responsibility and
boundary.

```
┌───────────────────────────────────────────────────────────────┐
│ UI (src/components/)                                          │
│   React components: NewOperationModal, PropertiesPanel, etc.  │
│   Reads user input, renders visualization, dispatches actions │
└───────────────────────────────────────────────────────────────┘
                            ↓ actions
┌───────────────────────────────────────────────────────────────┐
│ State (src/store/)                                            │
│   Zustand store: project state, operations, geometry, tools   │
│   Resolves height modes, builds worker payloads, dispatches   │
└───────────────────────────────────────────────────────────────┘
                            ↓ postMessage(WorkerRequestMsg)
┌───────────────────────────────────────────────────────────────┐
│ Worker dispatch (src/lib/cam/toolpathWorker.ts)               │
│   Receives WorkerRequestMsg, routes to operation by type      │
│   Returns WorkerResponseMsg with ToolpathMove[] or error      │
└───────────────────────────────────────────────────────────────┘
                            ↓ buildXxxToolpath(payload)
┌───────────────────────────────────────────────────────────────┐
│ Operations (src/lib/cam/*.ts, src/lib/cam/<op>2d/)            │
│   Deterministic: payload in, ToolpathMove[] out               │
│   Implement strategy-specific algorithms                      │
└───────────────────────────────────────────────────────────────┘
                            ↓ uses
┌───────────────────────────────────────────────────────────────┐
│ Shared subsystems (src/lib/cam/<subsystem>/)                  │
│   Geometry, heights, feedrates, moves, helix (planned)        │
│   Consumed by all operations                                  │
└───────────────────────────────────────────────────────────────┘
```

**The worker boundary is the design pivot.** Operations are deterministic
at the I/O boundary: they receive a payload, return `ToolpathMove[]`, and
do not reach outside themselves. Internally they may use mutable state
(occupancy grids, state machines, accumulators) — purity refers to the
boundary, not implementation. This makes operations testable in isolation,
allows heavy computation without blocking the UI, and forces clean data
flow.

## Worker protocol

The state layer dispatches work via `postMessage` with a discriminated
union message type:

```ts
type WorkerRequestMsg =
  | { type: 'COMPUTE_CONTOUR';           payload: ContourWorkerPayload  }
  | { type: 'COMPUTE_POCKET';            payload: PocketWorkerPayload   }
  | { type: 'COMPUTE_DRILL';             payload: DrillWorkerPayload    }
  | { type: 'COMPUTE_CHAMFER';           payload: ChamferWorkerPayload  }
  | { type: 'COMPUTE_FACE';              payload: FaceWorkerPayload     }
  | { type: 'COMPUTE_THREAD_MILL';       payload: ThreadMillWorkerPayload }
  | { type: 'COMPUTE_ADAPTIVE_CLEARING'; payload: ACWorkerPayload       }
```

Every operation payload shares a common base shape:

```ts
interface <Op>WorkerPayload {
  opId: string              // unique operation ID
  setupId: string           // setup/project ID
  params: <Op>Params        // operation-specific parameters
  heights: HeightParams     // canonical height planes (mode-resolved)
  passes: PassParams        // pass strategy (stepdown, etc.)
  linking: LinkingParams    // entry/exit strategy
  tool: Tool                // tool definition with feeds/speeds
  loops: LoopData[]         // input geometry
  wcsOrigin: Vec3           // WCS origin (heights are WCS-relative)
  feedrateOverride?: FeedrateOverride
}
```

The worker dispatcher (`toolpathWorker.ts`) routes each message to the
corresponding `build<Op>Toolpath(payload, onProgress?)` function and posts back:

```ts
type WorkerResponseMsg =
  | { type: 'TOOLPATH_COMPLETE'; opId: string; moves: ToolpathMove[]; computeTimeMs: number }
  | { type: 'TOOLPATH_ERROR';    opId: string; message: string }
  | { type: 'TOOLPATH_PROGRESS'; opId: string; progress: number /* 0..1 */; phase?: string }
```

### Progress reporting

Each `build<Op>Toolpath` accepts an optional second argument
`onProgress(fraction: number, phase?: string)` and calls it at coarse loop
checkpoints (per Z level, per region/loop, per hole). The builders are
synchronous, but `self.postMessage` mid-run still reaches the main thread. The
worker wraps `onProgress` to post a `TOOLPATH_PROGRESS` message, throttled to a
>=1% advance or a phase change so a fine-grained builder cannot flood the main
thread. The state layer updates `op.progress` / `op.progressPhase` from these
messages without terminating the worker, and clears them on the terminal
message. Single-op compute updates only that op; "Generate All" additionally
tracks `toolpathBatch { total, completed }` for a batch readout (completed/total,
no builder involvement).

Adaptive clearing is instrumented with coarse phase-boundary ticks only; a real
%-of-completion calculator is deferred until the AC planner is finished (and is
not yet dispatched by the state layer's `computeOperationToolpath`). An operation
is not considered complete until it reports progress.

### Operation metrics

Every operation carries three known metrics:

1. **Recompute progress** (`op.progress` / `op.progressPhase`) — see Progress
   reporting above.
2. **Compute time** (`op.computeTimeMs`) — wall-clock ms to calculate the
   toolpath; reported on `TOOLPATH_COMPLETE` (diagnostic).
3. **Estimated cut time** (`op.estimatedCutTimeMs`) — estimated machine
   execution time for the computed moves. `estimateRuntimeMs(moves, rapidRate)`
   in `src/lib/cam/runtime.ts` sums segment length / speed (rapid moves use the
   machine `rapidRate`; feed/arc moves use `move.feed`; arc segments use true
   arc length). Computed in the state layer on `TOOLPATH_COMPLETE` — the worker
   payload has no machine config, so the rate is read from `project.machine`. A
   setup's total cut time is the sum of its ready operations' estimates (derived
   in the UI).

## Operation contract

Every CAM operation conforms to this contract. The contract has two
kinds of rules:

- **Hard rules** are enforced across all operations today. Violations
  are defects.
- **Migration targets** are the canonical end-state where some current
  code carries pre-existing debt. Migration targets are marked
  *(migration target)*. New code follows them from day one; existing
  code is being migrated through scheduled phases (see Roadmap).

The user-facing wizard that populates these operation contracts is described in docs/UI-ARCHITECTURE.md §8 (7-tab Operation Configuration Wizard).

### Every operation MUST:

1. Live at `src/lib/cam/<op>2d.ts` (flat file) or `src/lib/cam/<op>2d/`
   (submodule directory) — the `2d` suffix anchors the dimensional
   model and leaves room for future `3d` operations.
2. Export a single entry function: `build<Op>Toolpath(payload: <Op>WorkerPayload): ToolpathMove[]`.
3. Receive the standard payload shape described above.
4. Be **deterministic at the boundary**: payload in, `ToolpathMove[]` out.
   No payload mutation, no global state access, no UI access, no async
   I/O, no nondeterminism. Internal mutable state (occupancy grids,
   state machines, accumulators) is fine — this rule is about the
   I/O boundary, not internal implementation.
5. Resolve absolute Z values by adding `wcsOrigin.z` to each consumed
   height field (or, when the heights resolver exists, call it).
6. Emit `ToolpathMove[]` with proper `role` tags from the canonical
   `MoveRole` union.

### Every operation MAY:

- Define operation-specific params in its `<Op>Params` interface.
- Implement operation-specific algorithms (state machines, ring
  generation, cycle types, scoring).
- Use mutable internal state (grids, accumulators, planners) as needed
  for its algorithm.
- Use shared subsystems (geometry, heights, moves, helix) where
  applicable.
- Have a per-operation `STATUS.md` inside its submodule directory
  for tracking active development.
- Define operation-specific feed concepts that represent real machining
  behavior (engagement-modulated rates, peck retract rates, lead-in
  feeds, etc.) — these should route through the shared feedrate
  resolver where applicable rather than bypass it.

### Every operation MUST NOT:

- Invent operation-specific Z vocabulary (no `safeZ`, `cutDepth`,
  `bridgeZ`, `plungeZ`, `relocationZ`, etc.). Use the canonical
  height-plane vocabulary defined below.
- Skip the `wcsOrigin.z` addition when computing absolute Z values.
- Duplicate generic feedrate fields (e.g., adding a `plungeFeed` on
  params when the standard `feedrateOverride > tool defaults > fallback`
  chain covers the same need).
- Interpret height-mode flags (`*Mode` fields). Modes are resolved by
  the store before dispatch; operations receive numeric WCS-relative
  values only.
- Mutate the input payload. The payload is treated as deeply immutable.
- Access global state, the DOM, or perform I/O. Operations run in a
  Web Worker and have none of these available anyway, but the
  discipline matters for testability and future portability.
- Reimplement geometry primitives that exist in a shared module.
  *(the shared geometry module is `src/lib/cam/geometry/` — it exists
  and is the canonical home for shared primitives. Any remaining private
  copies in pocket and AC are known migration debt; new code should use
  `src/lib/cam/geometry/`.)*

## Postprocessor boundary

The postprocessor is the subsystem that consumes `ToolpathMove[]`
produced by operations and emits GCode for a specific CNC controller.
**It is implemented in `src/lib/post/`** — a multi-dialect postprocessor
(UCCNC / GRBL / LinuxCNC) with canned cycles (G81/G82/G83) and custom
program-end behavior (see ADR 0021 and PostProcessModal.tsx). This section
documents the boundary so operations stay controller-agnostic and the
postprocessor keeps a clean contract to consume. The user entry point
(Post Process toolbar button) is described in docs/UI-ARCHITECTURE.md.

### Inputs and outputs

The postprocessor input is a setup's ordered, enabled operations plus
context (a `PostInput`: the machine config, the setup's WCS, and per-operation
resolved feeds/spindle/coolant/moves), not a bare `ToolpathMove[]`. Together
with a postprocessor configuration (target controller, dialect options,
resolution preferences) it produces GCode formatted for the target controller.
Applying the world->work transform from the WCS origin and emitting the work
offset (G54-G59, optional G10 L2) are the post's job, not the operation's — the
moves arrive in world coordinates.

Before emitting anything the post runs pure validators over the in-scope ops and
refuses to emit (fail loud, ADR 0003) when any selected operation is not up to
date: the only status valid to post is `'ready'`. An `'outdated'`, `'error'`,
`'computing'`, or `'pending'` op short-circuits the run with an error diagnostic
naming the op. Because the pipeline filters to the selected scope before
validating, this check is automatically scope-limited and also catches a stale
nest (editing a nest seed flips that nest's seed op to `'outdated'`) with no
nest-specific code.

### Postprocessor responsibilities

The postprocessor handles all controller-specific concerns:

- **GCode dialect**: G0/G1/G2/G3 selection, M-codes, comment syntax,
  modal vs explicit addressing.
- **Formatting**: decimal precision, block numbering, line endings,
  any header/footer required by the controller.
- **Acceleration/deceleration**: ramp-up at the start of cuts,
  ramp-down at the end, jerk-limited transitions — if the target
  controller doesn't handle these internally.
- **Resolution adjustments**: some controllers prefer line segments
  over arcs, or have block-count limits that require chunking. The
  postprocessor handles these transformations.
- **Tool change sequences, coordinate system setup, units, smoothing
  hints** (G64, G61.1, etc.) — any controller-specific preamble,
  postamble, or modal setup.

### What must NOT leak into operations

Because the postprocessor handles all of the above, operations must not:

- Emit M-codes or controller-specific instructions in `ToolpathMove[]`.
- Add acceleration/deceleration math to cut paths.
- Chunk arcs into line segments for legacy controllers.
- Make assumptions about the target controller's dialect, precision,
  or feature support.

### Contract for `ToolpathMove`

For operations to be portable across postprocessors, `ToolpathMove`
must remain controller-agnostic:

- **Geometry**: lines and arcs in machine coordinates at full
  precision (the postprocessor handles rounding).
- **Role**: a `MoveRole` tag describing intent (rapid, cut, plunge,
  helix, ramp, stepover, lead_in, lead_out, loop_back, wall_follow). The
  postprocessor uses this to choose feed rates from process settings
  and to apply any role-specific behavior.
- **Feed**: the resolved feed rate for this move, in mm/min. The
  operation knows project and process settings and assigns the
  appropriate rate by role; the postprocessor uses whatever feed is
  on the move without recomputing.

If a future requirement surfaces for the postprocessor to influence
what operations produce (e.g., a resolution mode that needs arcs
pre-chunked), that flows through the postprocessor configuration
*into the operation's worker payload* — not by operations reaching
into postprocessor concerns. The data flow stays one-way: operations
produce, postprocessor consumes.

## Machine control boundary

**This section exists because it did not.** Operator ruling 2026-08-26: *"the system must
be agnostic of the controller and translate at the boundary ... this has been
stipulated and expressed multiple times in multiple ways ... the fact that we're
running into these problems means that I was not listened to."*

**He is right, and this document is the evidence.** Everything above documents
the CAM -> postprocessor boundary in detail - inputs, outputs, responsibilities,
and an explicit *"what must NOT leak into operations"* list. The Overview calls
that boundary the thing that "makes the system portable across controllers".

**There was no equivalent for the LIVE CONTROL path, and that is the whole
defect.** The post path was mapped, policed and honoured. The control path grew
the same requirement, was given a correct interface (ADR-0041), and was never
given a boundary document, a leak list, or an identity rule. So it leaked in the
one direction nothing was watching.

**The two boundaries are deliberately adjacent in this file so they cannot
drift.** A rule that applies to one and not the other is a bug in this document.

### The layers, and what each may know

    LAYER                        MAY IT KNOW THE CONTROLLER?
    ------------------------------------------------------------------
    CAM / operations             NO. Produces ToolpathMove[] only.
    Postprocessor                YES, BY DESIGN. Its whole job is a dialect.
                                 Its output is a FILE.
    Control surfaces             NO. Panels, modals, pendant. They express
    (what the operator presses)  INTENT: jog, home, probe, spindle on,
                                 coolant on, run this program.
    MachineController interface  NO. It is the boundary itself - a vocabulary
                                 of intents, not of any controller's wire.
    Backends                     YES, EXCLUSIVELY. GrblController emits text.
    (Grbl/Uccnc/Simulated)       UccncController calls bridge APIs. This is
                                 the ONLY layer permitted to branch on
                                 controller identity.

**The interface is correct and must not be rebuilt.** `jog()`, `home()`,
`probe()`, `jogToWorkXY()` are intent methods and each backend translates them.
That is why the operator's jog buttons work on a machine that refuses G-code.
**The abstraction was never the problem.**

### THE MISSING TYPE - the root, not a leak

`ToolpathMove` exists so geometry can cross the post boundary without naming a
controller. **There is no equivalent type for machine ACTIONS.** The shared
representation of "turn the spindle clockwise" is:

    builtinDefaultLines(controller, action): string[]      // G-code lines

**THE INTENT IS THE TEXT.** That signature forces every controller to be a
G-code dialect. A controller that is not one cannot be represented in it - only
MIS-represented. Which is exactly what happened: `CONTROLLER_DEFAULTS` carries a
`uccnc` row and it is `M3 S{rpm}`, `M5`, `M8`, `M9` - for the one backend in
this codebase that declares `gcodeText: false` and refuses text outright.

**Giving UCCNC its own row made the wrongness explicit rather than fixing it.**
This is why the defect recurs and why fixing instances has never held: a
well-meaning caller CANNOT honour the boundary, because no agnostic
representation of an action exists for it to use. **The fix is a type, not a
patch.**

**AND THE TYPE MUST BE SHAPED BY THE DOMAIN, NOT BY THE FIRST CALLER.** Whoever
builds it will otherwise scope it to the action they happened to be fixing, and
an action type that covers spindle and coolant but cannot express a tool change
is the same instance-shaped failure one level up. **It must be able to express
at least:** spindle direction and rpm, coolant channel, dwell, tool change, tool
length offset, a work-offset write, and park. **Apply the drop-in test to the
TYPE itself** - if adding one of those later forces a change above the backend
layer, the type was shaped by its first caller.

Note the asymmetry that creates: geometry has an agnostic form and is policed;
actions have no agnostic form and are therefore unpoliceable.

**AND THE SAME GAP EXISTS ONE LEVEL UP, IN THE CONTRACT ITSELF.**
`StreamerProgress` is counted in LINES and BYTES. `uccncController`'s own comment
admits it stuffs move ids into `ackedSourceLine` because *"the contract has no
id-shaped progress"*. Run-from-line, step-back, guided tool change and
surface-mesh compensation exist ONLY in the text domain.

So the missing-type problem is not one abstraction that was shaped wrongly - it
is the same shape at three levels: **an ACTION is text, PROGRESS is lines, and a
PROGRAM is a file of lines.** A geometry backend can satisfy none of them
honestly, which is why it satisfies them dishonestly.

### Identity: DECLARED, never INFERRED

**A machine's controller may be DECLARED and shown to the operator. It may never
be INFERRED from silence.**

- A form default with a visible control the user can change is a DECLARATION.
  Legitimate.
- `machine?.controller ?? 'grbl'` is an INFERENCE. It manufactures an identity
  nobody stated, and it always manufactures the same one.

**This is ADR-0003 (no silent fallbacks) applied to controller identity.** The
post layer honours it; the control layer does not. That divergence produced the
sharpest symptom in the codebase: **the post side falls back to UCCNC, the
control side falls back to GRBL. One product, one question, two opposite
answers.**

**ONE RESOLVER, AND IT IS THE ONLY READER.** Exactly one function may read
`machine.controller` for dispatch, every consumer calls it, and an undeclared
controller REFUSES with a named reason rather than resolving to anything. One
reader is the discipline already used for `machineSkew` and for the active
machine's homing mode, for the same reason: a second reader is a second answer.

**Why this was never noticed:** the seed machine is declared `grbl`, so in
practice the inference always agreed with reality. The defect was invisible
until a machine that is NOT GRBL arrived.

**AND THE ROOT IS DEEPER THAN A DEFAULT VALUE: GRBL IS THE DEFAULT *OBJECT*.**

    getMachineController():  if (controller) return controller
                             return installGrblBackend()

Any caller that asks for the controller before a machine is connected **is
handed a GrblController** - and with it, GRBL's capabilities. So the system's
resting state is not "no controller yet"; it is "a GRBL machine". This outranks
the seed value as the statement of implicit identity, because it decides
BEHAVIOUR and not merely a stored string.

**The honest resting state is a controller that refuses everything and says why**
- not a working backend for one particular vendor.

**AND A DECLARATION MUST BE VISIBLE WHERE IT IS MADE.** *An invisible default is
an inference wearing a declaration's clothes.* The seed machine's `grbl` passes
the letter of the rule - it is a value the user can change - but no user ever
CHOSE it, and it is precisely why the four inference sites went unnoticed for so
long. **So the rule is not "the value exists somewhere the user could edit"; it
is that the operator can SEE and change it AT THE POINT IT IS MADE.** A new
invisible seed default would otherwise pass review under the rule as first
written.

### User text is itself a declaration

Operators can override action lines with their own G-code, and that must keep
working. It is not a violation - **typing G-code is a declaration that this
machine takes G-code.**

**But it must be honoured as one:** a user text override on a backend that
cannot accept text must REFUSE, visibly, naming the reason. It must never be
accepted, sent nowhere, and reported as done. The refusal belongs in the
console, per the UI rules.

### What must NOT leak into control surfaces

Mirroring *"What must NOT leak into operations"* above. A panel, modal, pendant
or session module must not:

- Branch on controller identity to choose behaviour. Ask the interface, or ask
  the one resolver.
- Hold, build or send controller-specific text. That is the backend's job.
- Infer a controller from a missing value.
- Represent an intent as the wire form of one particular controller.
- Assume a program is G-code text. A backend may take geometry instead, and the
  interface says which.
- Latch a control on a command whose delivery it did not confirm. "Sent" and
  "accepted" are different facts, and a button lit on the first is a lie about
  the second.
- **INTERPRET a controller's dialect to learn what the machine is doing.** The
  session currently decides e-stop exemption by M-code regex, tracks the ACTIVE
  WCS by regexing `G5x` words out of program text, and finds tool changes using
  the GRBL post dialect's `M0`-comment convention. **That is a layer inversion:**
  the control layer reading a dialect to know machine state, when the backend is
  the only thing entitled to know it. On a controller with no text, none of it
  can work at all.
- **Build controller-specific text for a CORE MACHINE FUNCTION.** Probing, work
  zero, WCS register writes, tool length offset and park are INTENTS. The
  interface already has `probe()` and `zeroWorkAxis()`; the paths that construct
  `G38.2`, `G10 L20`, `G10 L2`, `G43.1` and `G53 G0 Z` text do not use them.
- **Return success from a send that cannot fail.** `sendCommand` on a
  fire-and-forget transport returns `true` whenever the socket is up, so
  `if (sendCommand(...)) refreshState()` proceeds on a command the far end will
  refuse. **A send that cannot report failure cannot be checked, and every
  caller that checks it is being lied to.**

### The drop-in test

**A new controller is correctly supported when adding it requires changes in the
backend layer and the post dialects ONLY, and nothing above changes.** If adding
a controller requires touching a panel, a modal, the pendant or an action table,
the boundary has been violated somewhere, and this section is where you find
out where.

**Apply this test to any change that mentions a controller by name.**

### THIS SECTION IS PROSE, AND PROSE HAS NEVER HELD HERE

**The whole-system audit of 2026-08-26 reached one verdict, and it is about this
section as much as anything it describes:**

> *In this codebase a boundary survives if and only if a TYPE or a single shared
> FUNCTION embodies it at the seam; every boundary that exists only as prose or
> discipline has been violated.*

The boundaries that held for months - the post dialect boundary (a `PostConfig`
per controller, one engine), the sketch lift/bake boundary (one tested
invertible function pair), the worker payload boundary (a Worker physically
cannot reach past it) - **all have a type or a single function standing at the
seam.** The ones that failed repeatedly - the machine-action rule, the store's
internal structure, persistence field classification, and the documents
themselves - **are all prose.**

**Import direction is policed mechanically, layer by layer.**
`eslint.config.mjs` is the statement of the allowed arrows: its
`no-restricted-imports` blocks (with named legacy exemptions as the burn-down
list) cover lib/cam, post, sketch, program, machine, components and store.

**SO DO NOT MISTAKE THIS SECTION FOR A FIX.** It is a rule written down, which
is the weakest form of enforcement this codebase has and the one with the worst
record. It becomes real when:

- `ControllerType` closes (drop `(string & {})`) and ONE resolver exists, so the
  COMPILER refuses an undeclared controller instead of a reviewer noticing;
- the missing action/program/progress types exist, so an intent HAS an agnostic
  form and the wrong thing stops being the only expressible thing;
- an import-direction lint encodes the arrows this document draws.

**Until then this section documents an intention, not a constraint.** Judge it by
whether the next controller-shaped defect is caught by a compiler or by a human
re-reading this file.

### What is already RIGHT, and must not be "fixed"

**The boundary is not rotten everywhere. It is missing in ONE identifiable
direction**, and a reader who takes the leak list as a verdict on the whole
machine layer will rebuild working code. Measured as correct:

- **Capability checks are honest throughout.** No case was found of `gcodeText`
  being used as a proxy for "is this GRBL" - capabilities are asked about the
  thing they name.
- **`connectMachine` is a single selection point** - one place decides which
  backend exists.
- **The text-load refusal is honest** - a geometry backend is told it cannot run
  a G-code program rather than being handed one that silently fails.
- **`spindleRoute()`** routes by what the backend can accept.
- **The probe-routine expansion layer** and **the machine picker's derivation
  from the dialect registry** are correctly layered.

**The failing direction is specific: an INTENT that has no agnostic
representation falls back to text, and text means GRBL.** Everything that has an
agnostic representation is handled correctly. That is the whole diagnosis in one
sentence, and it is why the fix is types rather than a sweep.

### The test's own hole: identity and dialect are ONE namespace

**The drop-in test above would today pass a controller that cannot exist**, and
this is the sharpest structural finding in this section. `ControllerType` is
`'uccnc' | 'grbl' | 'linuxcnc' | 'generic' | (string & {})` - **post dialect
ids** - and the machine picker derives its options straight from the dialect
registry:

    MachineLibraryModal.tsx:24  "The Controller field selects the active
                                 postprocessor dialect."
    MachineLibraryModal.tsx:28  CONTROLLERS = DIALECT_OPTIONS.map(...)

**That picker is CORRECTLY layered and must not be "fixed"** - deriving from one
registry is exactly right, and its comment says so. The problem is what the
field MEANS. **A machine's control identity and its post dialect are the same
value**, so:

- **A controller with no G-code form cannot be DECLARED** without inventing a
  post dialect it does not need, or editing that modal - which the drop-in test
  forbids.
- UCCNC only escapes this because a UCCNC *file* dialect happens to exist. **The
  control path borrows its identity from the post layer.**

**These are two different facts about a machine:** what its TEXT should look
like when posted to a file, and how the app TALKS TO IT live. Today they are one
field because, historically, every controller took G-code and the two answers
were always the same. **The AXBB-E is the first machine where they are not, and
it is only surviving on a coincidence.**

**Until this is split, the drop-in test is necessary but not sufficient**, and
any work that adds a controller must state which of the two it is adding.

### Evidence

The leaks are MEASURED, not asserted, and are catalogued with file:line by the
control-layer audit rather than listed here - a map that carries its own bug
list goes stale the moment one is fixed. **This section is the RULE; the audit
is the current state.**

**One case belongs here permanently, because it is why the rule reads this way
rather than a defect to be closed:** the spindle buttons were routed by
capability in August, and the three coolant buttons twelve lines below in the
same file were not. The comment left beside them records it - *"Character for
character the defect WO-474 was written about, in this file, twelve lines below
the fix for it."* **The class was visible, written down, and not acted on.**
That is what a missing boundary document costs, and it is the reason this one
exists.

**AND ONE VERIFIED NEGATIVE, recorded so nobody re-derives it:** probing was
suspected of building G-code programs, because `ProbingPanel.tsx:1490` calls
`loadMachineProgram`. **It is not a leak.** That call is the surface-mesh DISABLE
path re-arming the original program. Checked before it was written down, and
recorded here because an unchecked suspicion costs the next reader the same
hour.

## Shared subsystems

### Currently implemented

| Module | Purpose | Consumers |
|---|---|---|
| `src/lib/cam/heights.ts` | `resolveHeights(heights, wcsOrigin) → { clearanceZ, retractZ, feedZ, topZ, bottomZ }` | all operations |
| `src/lib/cam/feedrates.ts` | `resolveFeedrates(tool, override) → ResolvedFeedrates` | all operations |
| `src/lib/cam/geometry/` | Consolidated geometry primitives — absorbed the former offset2d.ts, adaptiveGeometry.ts, and pocket inline copies. Phase 1 C3 (24f3fb3) | all operations |
| `src/lib/cam/moves/` | Shared motion primitives: rapidEntry, plungeTo, rampTo, cutLoop, cutLoopWithOverlap, retractFrom. Phase 1 C4 (238f568) | contour, chamfer (migrated); pocket, AC (migration in progress) |
| `src/lib/geometry/loopId.ts` | `computeLoopContentId` / `assignStableLoopIds` — `Loop2D.id` is a deterministic content hash (layerId + quantized signed area + centroid), namespaced by the owning geometry id, NOT a random uuid. Same loop → same id across re-derive, so operation `loopIds` selections survive a re-derive; a genuinely changed loop gets a new id and orphans (ADR 0003 fail-loud), never a silent mis-bind. INVARIANT (ADR 0019): never mint random loop ids; stamp `assignStableLoopIds(loops, geoId)` at every loop mint/attach site. | every loop mint/attach path; all loop-selecting operations |

### Planned (post-Phase 1)

| Module | Purpose |
|---|---|
| `src/lib/cam/helix/` | Shared helix entry subsystem. Phase 1: extract pocket's `emitHelix`. Phase 2: helix-as-default for AC, with validation and planning helpers. |

## Sketch subsystem

The parametric 2D sketching environment (ADR 0016) lives in `src/lib/sketch/`,
beside — not inside — `src/lib/cam/`. It sits UPSTREAM of the CAM layer: its
output is ordinary `Loop2D[]` geometry on a `Layer2D`, produced by the bake
described below. The UI surfaces (mode tab, toolbox, viewport render layer)
are documented in docs/UI-ARCHITECTURE.md section 4.4; this section covers the
data model, the lift/bake boundary, and the solver.

### The lift/bake boundary (the architectural contract)

While a sketch is being edited, the **Sketch document is the source of truth**
for its layer. On finish/exit the sketch BAKES to `Loop2D[]`; the CAM layer is
untouched — **the operation contract (ADR 0001) never sees sketch types**, and
baked loops are indistinguishable from DXF-imported ones.

- `bake.ts` — Sketch -> `Loop2D[]`. The ONE boundary between the parametric
  world and the CAM layer. Emits dense `points[]` (arcs densified at the same
  0.5 mm step the DXF importer uses) plus exact `segments[]` (line/arc
  `LoopSegment` geometry); loop type (contour/hole) is assigned by containment
  nesting (even depth = contour, odd = hole) and the points are oriented to
  the repo-wide winding convention (CCW = contour, CW = hole). Construction
  geometry participates in constraints but never bakes.
- `lift.ts` — `Loop2D[]` -> sketch entities. Bake's INVERSE, reusing its
  conventions exactly so `lift(bake(x)) == x` and `bake(lift(loops)) == loops`
  hold geometrically: line segments map 1:1 to line entities, arc segments to
  CCW-swept arc entities, a closed full-circle arc to a circle entity; joints
  become coincident constraints.
- Persistence: a `Sketch` is plain serializable data (no classes, no solver
  types) stored on the owning geometry's `sketches[]` ALONGSIDE the baked
  loops, riding the existing `.camproject` partialize middleware. Re-editing
  reopens the stored parametric document (non-destructive). `Layer2D` gains
  `sourceType: 'import' | 'sketch'` and a `locked` flag; STL-projected layers
  remain read-only per ADR 0011.

### Shared Project / Use contract

`src/lib/sketch/projectUse.ts` defines the one Project / Use candidate and
commit contract used by every sketch mount. A candidate is one atomic group of
explicitly open or closed paths plus its source kind, label, stable pick key,
and source revision when applicable. CAM adapts existing `Loop2D` sources;
model faces provide outer and hole loops, and model edges provide one open
polyline.

The Sketcher may ask an optional host resolver for host-owned geometry, but the
package remains the sole pointer owner. The 3D workbench publishes its model
resolver through the sketch-session/document-port seam; it considers only live,
visible bodies and applies tree-eye, hidden-body, isolate-body, hidden-face, and
isolate-face filtering before returning an edge or face candidate. One pointer
event resolves once, and cursor, disconnected-path preview, and click consume
that same candidate and revision. A click lifts every path in one append and one
undo step, assigns one whole-entity `fix` per emitted entity, applies the
caller's Construction mode, and creates ordinary UUID-backed static copies with
no live association. Normal Project / Use output is real geometry
(`construction:false`); Construction/Q is the explicit construction path.

Non-finite coordinates, stable-ID collisions, degenerate or collapsed paths,
unchainable faces, and stale source revisions are named fail-closed refusals
that append nothing. A new workbench face sketch starts blank: it retains its
face datum/frame, face-sized camera framing, and the transient SKC-22 origin
anchor, but persists no boundary entities, constraints, or external references.
The user explicitly arms Utility -> Project / Use to copy one model edge or a
face's outer and hole loops. Manual copies carry no external reference. The old
face-boundary converter and external-reference metadata remain only for saved
auto-seeded sketches: reopen preserves their persisted bytes, and datum reattach
replaces the legacy projection only when the persisted external-reference set is
nonempty.

### Module map

```
src/lib/sketch/
  types.ts               Sketch document model: entities (point/line/arc/
                         circle), constraints, dimensions, SolveStatus.
                         Plain serializable data; no planegcs vocabulary.
  solver/
    protocol.ts          worker message types (requestId-correlated)
    planegcsLoader.ts    WASM loading (Vite ?url asset; one instantiation
                         per thread; Node default path for headless tests)
    gcsMapping.ts        Sketch <-> planegcs mapping, solve, fix-probe.
                         PURE: no worker, no store; tested headless.
    sketchSolverWorker.ts  transport-only Web Worker around gcsMapping
  sketcher/
    index.ts             Shared CAM/Part Sketcher lifecycle. The active
                         instance owns one filtered tool-state subscription;
                         document updates and overlay-relevant tool/chain/
                         scalar changes invalidate its package painter.
    toolStore.ts         Mount-neutral armed tool, chain, snap and scalar state
    sketchInteraction.ts Sole pointer/keyboard owner and overlay resolver bridge
    sketchLayer.ts       Document entities, glyphs, dimensions and text render
    overlayPainter.ts    Snap, wake, preview, ghost and warning Three.js geometry
    overlays/            Shared React labels, inputs, prompt/confirm and menu UI
  tools/
    toolMachine.ts       armed-tool state machine (pure transitions)
    rectTools / circleTools / arcTools / polygonSlotTools / dimTool /
    trimTool / extendTool / filletTool / offsetTool / mirrorTool /
    patternTools         one pure module per tool: clicks in, ToolCommit out
    shortcuts.ts         single-key tool dispatch map + focus guard
  snap.ts                snap engine (endpoint/mid/center/intersection/
                         grid/H-V alignment), pure and headless-testable
  inference.ts           committed snaps -> real document constraints
  lift.ts                Loop2D -> sketch entities (bake's inverse)
  bake.ts                Sketch -> Loop2D (the CAM boundary)
  deleteSelection.ts     delete transform; referencing constraints and
                         dimensions cascade (no dangling solver ids)
  editingLayer.ts        which layer's baked loops to hide while its
                         document is open in the viewport
  blankSketch / entryChooser / projectUse / browserModel /
  constraintActions / refIds / demoSeed     smaller pure model layers
```

Each mount owns its document and solve adapter: CAM uses the project store and Part
uses the feature DAG/session adapter. Both mount the same `Sketcher`, which owns the
render layer, pointer interaction, feedback painter, tool store and DOM overlay
contract. Only an active instance subscribes to overlay-relevant tool state; `exit()`
and `dispose()` share the same idempotent unsubscribe tail, and `updateSketch()`
invalidates document-dependent ghosts while active. Wake references, snap flags and
Construction mode do not rebuild tool geometry. CAM and Part therefore consume one
live-preview lifecycle without a host-specific repaint bridge or a process-wide
one-active-instance lease. Headless tests for the subsystem live under
`src/tests/sketch/` (see docs/UI-ARCHITECTURE.md for both mounts).

### Solver worker protocol

Solving runs in a dedicated Web Worker (`sketchSolverWorker.ts`) wrapping
planegcs (`@salusoft89/planegcs` — an open-source CAD/CAM system's PlaneGCS solver compiled to
WASM), mirroring the toolpathWorker request/response pattern:

```ts
type SketchWorkerRequestMsg =
  | { type: 'SOLVE_SKETCH'; payload: { requestId: string; sketch: Sketch } }
  | { type: 'DRAG_SOLVE';   payload: { requestId: string; sketch: Sketch; drag: DragRequest } }

type SketchWorkerResponseMsg =
  | { type: 'SKETCH_SOLVE_COMPLETE'; requestId; entities; status; computeTimeMs }
  | { type: 'SKETCH_SOLVE_FAILED';   requestId; reason; message; status }
  | { type: 'SKETCH_SOLVE_ERROR';    requestId; message }
```

Protocol rules, all in the fail-loud spirit of ADR 0003:

- **requestId correlates responses to requests.** Drag solves are debounced
  and can overlap in flight; the store discards a stale response that arrives
  after a newer request was issued.
- **The worker is transport only.** All mapping/solve logic is in
  `gcsMapping.ts`, which is pure and tested headless against a direct
  `GcsWrapper`. One wrapper per worker, created on first request and reused
  (WASM instantiation is the expensive part); the worker stays alive across
  solves because drag emits a stream of requests.
- **Expected failures are typed, never faked.** `SKETCH_SOLVE_FAILED` carries
  `reason: 'conflicting' | 'solver_failed' | 'invalid_sketch'` plus the
  solver-named conflicting/redundant id sets in `status`. Conflicts WIN over
  a numerically "successful" solve — planegcs can converge while diagnosing
  an inconsistent subset, and presenting that as success would silently drop
  the user's constraint. On any failure the document geometry is untouched;
  the store keeps the last good solve.
- **Every gcs id derives from a document id** (with a `:` suffix for owned
  sub-primitives), so a conflict report always translates back to exactly one
  user-visible entity/constraint/dimension. Temporary drag pins (planegcs
  tag -1) are not document constraints and are excluded from diagnosis.

### Definition-state diagnosis (the fix-probe)

The UI colors each entity by definition state (under-defined / fully defined /
conflicting). The planegcs WASM bindings expose only the system-level `dof()`
— not an open-source CAD/CAM system's per-parameter dependency diagnosis — so per-entity state is
computed by an exact probe in `gcsMapping.ts`: **an entity is fully defined
iff grounding ALL of its parameters at their solved values leaves the
system's dof unchanged** (a determined parameter turns one equation redundant
and rank drops with it; a free parameter drops dof). This is rank arithmetic
on the constraint Jacobian evaluated by the same diagnosis that produces the
headline dof, so the per-entity answer can never disagree with the
whole-sketch answer. Cost: one diagnosis solve per entity, each starting at
the solution (converges immediately); `dof === 0` short-circuits (everything
is defined). Drag solves skip the diagnosis entirely and carry the pre-drag
truth — the temporary pins would otherwise distort dof and flash entities
white mid-drag.

### WASM heap limit and component partitioning

The planegcs WASM build ships a FIXED 16 MB heap (no memory growth): one
DogLeg solve of a system past roughly 210 entities (~420 params) aborts the
module with OOM (measured against a 340-entity DXF lift and synthetic
slices: 210 ok / 225 OOM). Documents above `MAX_SOLVE_BATCH_ENTITIES = 150`
(kept well below the abort point for headroom) are therefore solved per
CONNECTED COMPONENT of the constraint graph, batched back up to the budget —
mathematically identical, because the giant system's matrix is
block-diagonal across components, and a lifted import is routinely one
constraint island per loop. **Known limit, stated honestly: a SINGLE
connected component above ~210 entities cannot be split and may still abort
the fixed-heap WASM — it fails loud either way.**

### Sketch blocks (SKC-BLOCKS)

A **block** (`SketchBlockEntity`, `kind: 'block'`) collapses a cluster of
entities into ONE rigid object placed by a single solver anchor — the
solver-inert doctrine (ellipse/spline/text carry their shape verbatim; only an
anchor enters the solve) generalized to a carried nested sub-sketch. Members
live in the block's LOCAL frame; world placement is
`origin + Rot(rotation)*scale*local`. Only `origin` is a real planegcs point, so
a block contributes exactly 2 DoF regardless of member count (0 when its origin
is fixed) — the key lever for dense imports: `wrapLiftedAsBlock` collapses a
whole DXF/SVG lift to one fixed point, sidestepping the WASM-heap OOM above. All
block operations are pure functions in `src/lib/sketch/blocks.ts`, applied by the
host as one undo step: `groupIntoBlock` / `explodeBlock` (lossless, member ids
preserved; refuses nested / cross-boundary by name per ADR-0003),
`setBlockScale` / `setBlockRotationDeg` (direct-edit inert per ADR-0033), and
`beginBlockEdit` / `finishBlockEdit` (edit-in-place: detach members to world
coords, edit with the full toolset, then re-freeze with the
SAME id and frame via the exact inverse transform `worldEntityToLocalByFrame` —
no jump). `bake` flattens blocks to world members via `expandBlocksForGeometry`
before the ordinary loop bake, so baked loop content-ids are STABLE across
group / explode / scale / edit-in-place (ADR-0019).

**Definitions + instances (SKC-BLOCKS Stage 5).** A block is EITHER a single-use
inline block (`members` on the entity, `defId` absent — Stages 1-4, unchanged) OR
a def-backed **instance** (`defId` names a shared `BlockDefinition` in
`Sketch.blockDefs`; the entity's own `members` are empty). Many instances share
ONE definition, so editing the definition once updates EVERY instance.
`resolveBlockMembers(block, defs)` is the single resolver every geometry consumer
calls (never read `block.members` directly). Lifecycle (pure, in `blocks.ts`):
`hoistBlockToDefinition` converts a single-use block into a definition + first
instance; `placeBlockInstance` / `insertInstanceOfBlock` place more;
`pruneUnusedBlockDefs` GCs orphaned definitions (explode prunes automatically).
**Propagation** is via edit-in-place: `beginBlockEdit` on an instance detaches the
DEFINITION's members (canonical ids, only one instance ever exploded at a time),
and `finishBlockEdit` writes the edited members BACK to the definition — so every
sibling instance re-renders the change. The SOLVER is unchanged: a block still
contributes only its origin (2 DoF), so def-backed instances round-trip through the
solve inert, exactly like single-use blocks. **Id namespacing:** because two
instances share the definition's member ids, `expandBlocksForGeometry` namespaces
each def-backed instance's member ids/refs by the instance id before flattening
(only where multiple instances coexist in one list — bake / CAM geometry / a
permanent explode); the render layer flattens instances to inline blocks once at
its ingest (`materializeInstancesForView`) so all per-entity render/pick code stays
definition-agnostic. Loop ids derive from WORLD coordinates (`loopId.ts`), never
from entity ids, so namespacing is invisible to ADR-0019 — two instances at
different positions get distinct, stable, content-derived loop ids. The schema
bumps 12->13 (block entity kind) and 13->14 (`blockDefs` + `defId`) are additive
identity claims (ADR-0027).

**Rotation as a solvable angle (SKC-ROTATION-SOLVABLE).** A block's `rotation` is
typed-inert by default (only `origin` solves; 2 DoF). When a constraint or
dimension references the block AS A LINE OPERAND — an angle dimension, or a
`parallel` / `perpendicular` / `horizontal` / `vertical` constraint — its
orientation is PROMOTED to a solver-owned angle, opt-in and per-block, exactly the
way `referencedFocusSites` materializes an ellipse focus only when referenced. The
promotion (in `sketchToGcsPrimitives`, `gcsMapping.ts`) materializes a second
`refpoint` point at a fixed radius from the origin: one `p2p_distance` pins that
radius (1 equation), leaving the ANGLE free (+1 rotational DoF), and a synthetic
`origin->refpoint` `orient` LINE is the operand the angular constraint solves
against — the foci precedent (a center-tied point) with the rigid two-`difference`
tie (0 DoF) relaxed to a radius-only tie (1 DoF = the angle). `entitiesFromSolved`
re-derives `block.rotation` from the solved orient vector, so a driving
angle/parallel/horizontal constraint OWNS the rotation and the typed field becomes
a live readout. A block NOT referenced this way materializes nothing and stays
byte-identically 2 DoF, so every block DoF invariant above holds and NO schema
change is needed (the reference is an ordinary entity-id operand; `collinear` and
the far/obtuse angle sector refuse by name on a block orientation, ADR-0003). The
shared planning layer resolves a block operand for both hosts: `constraintActions`
accepts a block as a line-like operand, and `angleOperandSegment`
(`tools/dimTool.ts`) gives `planDimension` / `selectAngleSector` the block's
`origin->rotation` direction segment. Definedness follows for free: the per-entity
fix-probe (`diagnoseDefinedEntities`) grounds every `${block.id}:*` point, so a
block whose angle is constrained reads fully-defined and one whose rotation is
still free reads under-defined. NOT covered: drag-rotate (a rotate gizmo is
net-new interaction, booked in POST-MERGE-WORKPLAN.md).

## Tool geometry subsystem (ADR 0030)

A tool is a solid of revolution, and `src/lib/tool/toolProfile.ts` is the SINGLE
SOURCE OF TRUTH for its shape. Previously three consumers (the 2D tool diagram,
the 3D viewport mesh, and the stock-removal simulation) each rebuilt the shape
shank-down and tacked the tip on, with no shared geometry — so the shapes drifted
and most tool families had no honest geometry. ADR 0029 unified the tool ANGLE on
one canonical `Tool.angleFromAxisDeg`; ADR 0030 unifies the tool SHAPE on one
generator that consumes it.

### The profile generator

`buildToolProfile(tool)` returns an ordered radius(z) polyline built from the TIP
(z = 0) upward toward the holder; the full silhouette is that profile mirrored
across the centerline. It switches on `toolTypeMeta(tool.type).profileKind` (the
`ProfileKind` union in `src/lib/tool/toolMeta.ts`: flat / ball / bull / cone /
frustum / drillpoint / dovetail / disc / lollipop / thread) and the canonical
half-angle (`toolHalfAngleRad`). The `thread` kind (`buildThread`) draws a
thread mill as N V-form teeth at the tip (`toothDepth = (pitch/2)/tan(formAngle/2)`,
crest = cutting OD, root = crest - toothDepth) over `N*pitch`, then the relieved
neck and shank — driven by the optional `Tool.threadFormAngleDeg` /
`threadTeethCount` / `threadPitch` fields; with `threadPitch` unset it falls back
to the plain `buildFlat` cylinder (backward-compatible, no migration). The teeth
flow into the 2D diagram and 3D lathe (one source of truth, ADR 0030) but NOT the
voxel sim, which still models a constant crest-OD half-space (thread-form carve
deferred, ADR 0031 Amendment 1). Per-type math is ported from the validated reference impl in
`docs/qa/009 - tool-geometry-model/tool-geometry-reference.html`. Pure and
deterministic.

```ts
interface ProfileVertex { z: number; r: number }
interface ToolProfile { vertices: ProfileVertex[]; cuttingMaxZ: number; fluteTopZ: number }

buildToolProfile(tool): ToolProfile          // tip(z=0) -> up, by profileKind
buildHolderProfile(holder): ProfileVertex[]  // revolved holder, bottom-up
radiusAtZ(profile, z): number                // interpolating sampler; 0 above the tool
isCutting(profile, z): boolean               // z <= cuttingMaxZ
tipOffsetAtRadius(profile, d): number         // z of the lower cutting surface at radius d
toolReachWarnings(tool, axialDepthMm): ToolReachWarning[]   // passive rub check
```

The cutting region is `[0, cuttingMaxZ]`; everything above is non-cutting
neck / shoulder / shank. Tapered endmills (`frustum`) treat `Tool.diameter` as the
MAJOR (top) diameter narrowing to a derived tip over the full flute length
(`tip = diameter - 2*fluteLength*tan(angleFromAxis)`); undercut families
(`lollipop` / `disc` / `dovetail`) use `Tool.neckDiameter` for the non-cutting
neck; `bull` composes a corner radius.

### The three consumers read from here

- **2D diagram** (`ToolDiagram.tsx`) mirrors the profile into the silhouette,
  colored by cutting / neck / shank — no tacked-on tip, no hardcoded taper.
- **3D viewport** (`CNCViewport.buildToolMesh`) revolves the profile into a
  Three.js `LatheGeometry` colored by region, and revolves `buildHolderProfile`
  into a holder seated at the tool's `lengthBelowHolder` stickout.
- **Simulation** uses one shared sampler (`tipOffsetAtRadius` / `radiusAtZ`) in
  place of the two former per-type duplicates (`carve.ts` and `SimulationPanel.tsx`).
  Material removal uses the cutting envelope (`z <= cuttingMaxZ`), so every tool
  type carves a real shape. Undercut tools are modelled by their bottom silhouette
  (conservative — true undercut removal behind the neck is deferred).

### New types and fields

`Tool` gains `tipDiameter`, `neckDiameter`, `holderId`, and `libraryId`
(`src/types/index.ts`). `toolMeta.ts` adds `ProfileKind` and
`PROFILE_FIELD_RELEVANCE` so the editor shows only the fields a type uses.

- **`ToolHolder`** — a separate first-class entity: a revolved stack of
  `HolderSegment { height; lowerDiameter; upperDiameter }` (equal dias = cylinder,
  unequal = cone) stacked from the holder bottom (tool side) up. timeline-based CAD/CAM system `.tools`
  interchange-compatible. Stored in a `holders: ToolHolder[]` slice; a tool selects
  one via `Tool.holderId`.
- **`ToolLibrary { id; name }`** — a named flat library. Tools stay in the global
  `toolLibrary: Tool[]` pool; `Tool.libraryId` assigns each to a library (stored in
  `toolLibraries: ToolLibrary[]`). No project-vs-library split (rejected; ADR 0007
  follow-up).

The **passive rub warning** (`toolReachWarnings`) is a non-blocking check: it
surfaces when an op's axial cut depth exceeds the flute length (shank/neck rub) or
the stickout below the holder (holder rub). It never modifies a toolpath; active
avoidance is deferred (ADR 0003 fail-safe).

Schema migration v2 -> v3 (ADR 0027 chain) creates a default
`ToolLibrary { id: 'lib-default', name: 'My Tools' }`, backfills every tool's
`libraryId`, and initializes `holders: []` — on both the file-load and
persist-rehydrate paths; byte-identical no-op once current. Full decision record:
ADR 0030. UI surface: docs/UI-ARCHITECTURE.md §12.3.

## B-rep model kernel (ADR 0018)

STEP solids are first-class geometry sources. The B-rep model kernel
(`src/lib/cam/geometry/occt/model/`) is a **second, independent OCCT WASM
build** — `occt-model`, 11.6 MB raw / 3.9 MB gzip — alongside the toolpath
side's lean `occt-fillet` kernel (2.55 MiB). It carries STEP import, shape
healing, tessellation, topology queries, surface classification, and exact
planar sections, and it loads lazily in a **dedicated model worker**
(`modelWorker.ts`), separate from the toolpath worker, only when a STEP file
is imported (ADR 0018 D1). Users who never import STEP pay nothing.
Build/binding notes: `src/lib/cam/geometry/occt/model/vendor/README.md`.

### Model worker protocol

`modelClient.ts` wraps the worker in a promise-based protocol (message
types in `model/types.ts`):

- `READ_STEP` — read + heal + tessellate; answers `MODEL_PROGRESS`
  (read/heal/mesh phases) and then `MODEL_READY` with a `BrepModelPayload`:
  one merged mesh (positions/normals/indices) with per-face triangle ranges,
  per-edge polylines, and per-face surface types — all fresh JS-heap typed
  arrays copied out of the wasm heap and posted as transferables.
- `DERIVE_FACE_LOOPS` / `DERIVE_EDGE_LOOPS` / `DERIVE_HOLES` /
  `DERIVE_SECTION` — the derivation layer (below).
- `MODEL_ERROR` carries a `where` field naming the failing stage (ADR 0003 —
  failures are named, never swallowed).

The `TopoDS_Shape` handle lives only in the worker's wasm heap, keyed by
geometry ID; it never crosses the worker boundary (D2).

### Derivation layer

`derive.ts` converts picked B-rep entities into exactly what the existing
2D operations already consume — standard `Loop2D` layers landed on the
`ImportedGeometry` through the same path as STL projection layers (D4). The
operation contract is untouched: operations keep receiving `LoopData[]`
plus resolved heights and cannot tell a STEP-derived loop from a DXF one.

| Derivation | Input | Produces |
|---|---|---|
| `planarFaceLoops` | one planar Z-normal face | outer + hole boundary loops in world XY, plus the face plane Z. Non-planar or tilted faces get a typed rejection naming the surface type (D5 — no silent projection). |
| `edgeChainLoops` | a picked edge set | edges chained into closed (CCW-normalized) or open loops at one Z; typed rejection if the set is not coplanar at Z=const. |
| `holeFeatures` | the whole solid | `HoleFeature[]` — Z-axis cylindrical holes as `{ center, diameter, topZ, bottomZ, through }`; bosses excluded by an inward-normal test. |
| `sectionAtZ` | the solid + a Z value | exact `BRepAlgoAPI_Section` closed loops — supersedes faceted STL slicing for B-rep models. |

The store action `deriveBrepLayer(geoId, kind, args)` lands each result as
a `Layer2D` with a Z-plane `ProjectionPlane`; hole detections additionally
carry `Layer2D.holes` and one CCW circle loop per hole so drill's
centroid-based picking and the viewport work unchanged. Each `HoleFeature`
records the id of its generated circle loop (`loopId`), giving drill
dispatch a durable hole identity for per-hole bottom depths (see the
Operations catalog drill row). These wizard-derived layers are tagged
`frame: 'geometry_local'` (raw model coords, transformed at dispatch so they
follow the part).

There is a second, distinct entry point for a B-rep section: the DesignTree
per-geometry slice button mirrors the STL slice-to-loops flow as a two-step
interaction (pick a slice height with a live exact OCCT preview, then pick a
projection plane). To match STL exactly — STL slices the world mesh, so any
orientation slices fine — this flow cuts a **WORLD-horizontal** plane via the
`sectionAtPlane` kernel: `worldHorizontalSectionPlane(geoId, worldZ)` builds
the world-horizontal frame transformed into model space by the part group's
inverse world matrix (the UV axes are the model images of world +X / +Y), so
the orthonormal rotation makes `sectionAtPlane` flatten the loops **directly
into WORLD XY**. The result lands via `appendGeometryProjection` as a
**world-baked** `Section N` layer (no `geometry_local` frame), exactly like an
STL projection — no per-point conversion is needed because the loops are
already world XY. **Tilted parts are allowed** (no X/Y tilt guard), matching
STL. Assumes unit scale on STEP imports (non-unit scale out of scope). See
docs/UI-ARCHITECTURE.md §6.2. (The operation wizard's STEP section is a
separate path that still produces `geometry_local` model-coord loops.)

**Symbolic Z-anchor (store contract).** A world-baked projection plane placed
on a stock-relative preset carries an optional `ProjectionPlane.zAnchor`
(`{ ref: 'absolute' | 'floor' | 'stock-top' | 'stock-bottom'; offset }`)
instead of a frozen `origin.z` — the height-vocabulary pattern (ADR 0002)
applied to placement Z. Two pure helpers in `src/store/dispatchGeo.ts` back it:
`resolveAnchoredZ(zAnchor, stockBounds)` (returns the absolute Z, or `null` when
the caller must keep the stored Z — absolute / no anchor / no stock bounds) and
`computeSceneStockBounds(geometry, sceneStock)` (the scene stock's world Z extent,
mirroring the viewport's baked `_stockBounds` so picker-time and resolver-time Z
agree: the union of every named auto stock's `deriveAutoStockBounds` and the
fixed-block bounds). Note: the auto-vs-fixed *mode toggle* is gone — multiple
named auto + fixed stocks now coexist (see docs/UI-ARCHITECTURE.md §10, on branch
feat/nesting-engine); `sceneStock.mode` is vestigial.
The store action `reanchorProjectionLayers()` re-resolves `origin.z` for every
stock-anchored layer and bumps the owning geometry's `loopsVersion` (cheap +
idempotent — no-op when unchanged); it is called after every stock-bounds change
(geometry add / move / delete, fixed-stock add / resize / move / remove, scene-stock
mode/offset edit) and once at creation inside `appendGeometryProjection`. Floor is
constant and a face pick carries no anchor (absolute, part-following), so only
stock-top / stock-bottom placements ride the stock.

### Subshape identity (D3)

Selections are `{ geoId, kind: 'face' | 'edge', index }` (`BrepSelection`
in `src/types/index.ts`). The index is the TopExp_Explorer DFS
first-encounter order over the healed shape — deterministic for the same
STEP bytes + the same pinned OCCT build, asserted stable by the smoke gate.
Indices line up 1:1 with the render payload's `faceRanges` / `edgeRanges`,
so viewport picking and worker derivation agree without re-resolution.

### Persistence (D2)

The shape handle is never serialized. A `'brep'` geometry persists as its
original STEP bytes in IndexedDB (`src/lib/stepCache.ts`, mirroring
`stlCache.ts`); project load re-reads the bytes through the model worker
and re-tessellates. `modelClient` auto-recovers a non-resident shape (page
reload, worker respawn) by re-running `READ_STEP` from stepCache exactly
once before failing loudly. Tessellation buffers are runtime-only data held
in a module-level registry — never on the store, so they cannot leak into
the persisted project. The same byte-reread + re-tessellate path also runs
LIVE when the user changes the render-fidelity tier (`brepTessellationQuality`):
loaded STEP parts are re-meshed at the new deflection and swapped in place (UI
side, docs/UI-ARCHITECTURE.md §5.6).

### Heights integration

A picked face binds the operation's bottom height: the wizard stores the
face plane's world Z in `heights.selectedFaceZ` with
`bottomHeightMode: 'selected_face'`, and the store resolves it to a
WCS-relative `bottomHeight` before dispatch — per the mode-resolution rule
above (ADR 0002): the worker still sees only numbers.

Full decision record: ADR 0018
(`docs/decisions/0018-brep-model-kernel.md`). UI surface (import flow, pick
modes, wizard wiring): docs/UI-ARCHITECTURE.md §6.7.

## Modeled-body CAM binding (INT-17A/INT-17C, CAM-BINDING Stages 1-2, 4-5)

A body built in the Model workbench (3D modeling workspace, `src/geom/` — a THIRD,
separate OCCT WASM build, `occt-wasm`/`brepjs`, distinct from both this
file's `occt-fillet` and `occt-model` kernels) reconciles into a first-class
CAM geometry entry (`format: 'model'`, `ImportedGeometry.modelBody:
ModelBody`, INT-17A) carrying a tessellated display payload
(`ModelBodyDisplay`: plain positions/normals/indices triangle-mesh arrays,
no queryable B-rep) and a durable identity handle (`ModelBodyRef { bodyId,
stableIds[], version }`) whose identity rides the Model kernel's
**ElementMap** (`src/doc/element-map.ts`) exclusively — a modeled body must
NEVER be routed through the `occt-model`/STEP-import kernel documented
above (the identity boundary this section's own consumers must not cross).

`src/lib/cam/modelOrigin.ts` is the one shared refusal predicate every
consumer seam (stock, delete, nest aggregate) checks before treating a row
as ordinary geometry; `isModelOpSourceEligible` is the narrower, CAM-BINDING
Stage 1 op-picker-only relaxation that lets a modeled body become an
operation's declared SOURCE without becoming stock-eligible, deletable, or
nest-aggregatable.

**Placement (INT-17C).** Each Model Item (a project-visible modeled body/
multibody unit) carries its own rigid transform, stored in
`Project.modelItemPlacements` and read through `src/lib/cam/
modelItemPlacement.ts`'s `resolveModelItemPlacement(placements, modelItemId,
bodyId?)` — pure, fails loud (`ModelItemPlacementResolutionError`) rather
than defaulting to identity. **`resolveModelReferenceFrame`**
(`src/lib/cam/modelReferenceFrame.ts`) is the ONE named seam every
world-position resolution of model-backed geometry — op compute, stock,
setup origin, boundary, current and future — must flow through; it composes
`placementRegistry` + `resolveModelItemPlacement` into a single call so no
consumer inlines that composition itself (shared-resolver rule). The
viewport draw path, scene-restore path, and Properties Panel Placement
fields (read + write) all resolve a body's world pose through it.

**Derive-then-bind compute (CAM-BINDING Stage 2).** `contour_2d`/`pocket_2d`
operations sourcing a modeled body compute for real:
`deriveModelBodyProfile` (`src/lib/cam/modelBodyDerive.ts`) slices the
body's own `ModelBodyDisplay` triangle mesh (reusing the same mesh-plane-
intersection algorithm STL import's default 2D projection already uses,
`src/lib/geometry/stlProjection.ts` — no new kernel capability, and no
occt-model dependency either) into `Loop2D[]`, then bakes the body's world
pose (via `resolveModelReferenceFrame`) into the resulting points before
handing them to the SAME builders (`buildContourToolpath`/
`buildPocketToolpath`) every other geometry source already uses — op
compute code itself is unchanged. A tilted Placement is refused (profiles
are Z-plane data, mirroring the B-rep tilt guard). Scope: whole-body
granularity (Stage 5 adds face-level picking); only the GEOMETRY-FREE height
reference kinds work — `'absolute'` (legacy/back-compat, no longer offered
in the op wizard's dropdown), `'machine_floor'`, and `'wcs_plane'` (both
real, UI-selectable options) — since a modeled body has no CAM-owned stock
frame until Stage 3 adds stock derivation. `dispatchGeo.ts`'s `resolveTopZ`
resolves these three before its own arrival-point guard runs, for exactly
that reason. A stock-relative reference (`stock_top`/`stock_bottom`/
`geometry_face`/`model_top`/`picked_plane`) on a model-sourced op still
fails loud rather than computing at a guessed frame. Every other operation family
still lands on the named `'unsupported'` `OperationStatus` (never `'ready'`,
never a bare `'error'`) until its own Loop2D/PartMesh bridge exists.

**Drill targets from modeled bodies (CAM-DRILL-ADAPTER).** A drill op whose
source is a modeled body (CAM-BINDING Stage 1 gate) can Detect holes using the
Model kernel's own `recognizeFeatures` query — the SAME GEO-6 recognition
resize-hole uses (`src/geom/worker/defeature.ts`), never a second hole
detector and never occt-model. `deriveModelBodyDrillTargets`
(`src/lib/cam/modelBodyDerive.ts`) maps `FeatureVerdict[]` into world-space
XY centres, diameters, top/bottom Z, and the same 64-point circle `Loop2D`s
the STEP hole path already builds, so `buildDrillToolpath` is unchanged.
Z-parallel holes only (tilted axes and tilted Placement refuse by name). The
wizard's Detect holes button is offered for model + drill the same way it is
for STEP; on Save the op carries `modelReferences: [{ role: 'drill-targets',
bodyId, stableIds: hole face ids }]`. Compute re-derives fresh via recognition
when that reference is present; model regen / Placement move ambers the op
(`outdated`, toolpath retained per S5c) via `markDrillTargetOpsOutdated` on
the same `syncModelBodies` / `updateModelItemPlacement` chain Stage 3/S3b
uses. Post-load verification still rides Stage 5's
`modelRefsVerifiedSinceLoad` flag for any ModelReference including
`drill-targets`.

A whole-body-bound op carries NO `ModelReference` (a contour/pocket without a
picked face), so `markDrillTargetOpsOutdated` and the `reresolveModelReferences`
leaf hook both skip it. The shared `markModelBodyBoundOpsOutdated` (runs right
after the drill pass on the SAME two chains) closes that gap: it ambers every op
whose `params.geometryId` resolves to a model-origin row on a touched body,
uniform for all direct-bind op types, so a badge never stays green over a
would-be-different toolpath after a model edit (MODEL-ROW-CITIZEN audit). "Edit
as model" (`wrapImportedGeometryAsModelItem`) likewise ambers every op bound to
the wrapped row via the shared `outdateOpsReferencingGeo`, since the format flip
to `model` re-routes compute to a different outline. The same `wrapImported
GeometryAsModelItem` fan-out is what the multi-body STEP import "One item per
body" choice (the operator Q-76) routes to: a `solidCount > 1` import can land either as
one combined `format:'step'` row (the default) or as N per-body `format:'model'`
rows; both shapes are honest CAM citizens, and `markModelBodyBoundOpsOutdated` /
`derivedStockMembers` already handle each per-row (a combined row carries no
`modelBody` and is a single stock/bind unit; the per-body rows each carry their
own `modelBody.ref.bodyId`). The user-facing flow is documented in
docs/UI-ARCHITECTURE.md §6.7.

**Section-at-Z for a modeled body (CAM-BINDING Stage 4).** The generic
"Section at Z → pocket" wizard flow (`deriveBrepLayer(geoId, 'section', {z})`,
shipped for imported STEP bodies via occt-model's exact `sectionAtZ`
B-rep intersection) now also accepts a modeled body as its source.
`deriveModelBodySection` (`src/lib/cam/modelBodyDerive.ts`) is the
model-kernel counterpart: the Model kernel has no planar-section query
either (same gap Stage 2 found), so it reuses `stlProjection.ts`'s
mesh-plane-intersection primitives (`sliceAtZ`/`buildLoops`/
`projectSTLToLoops`) at a CALLER-CHOSEN Z against the body's own
tessellation, and bakes the world pose via `resolveModelReferenceFrame`
before returning — the same derive-then-bind shape Stage 2 established.
**Precision**: mesh-derived (tessellation-tolerance-bounded), not an exact
B-rep intersection like the STEP path — disclosed, not silently assumed
equivalent (a section-derivation parity fixture, `src/tests/brep/
camBindingStage4SectionParity.test.ts`, cross-checks the two kernels
against the same nominal shape). **World vs. local Z**: unlike the brep
path (geometry-LOCAL Z, since STEP geometry's own `position`/`rotation`
carry its world pose), a model row's own `position`/`rotation` stay
identity forever (Stage 2/3) — its real pose lives in its Placement
instead — so the wizard presents and clamps a model source's Section-Z
field in WORLD coordinates (`NewOperationModal.tsx`'s `brepZMin`/
`brepZMax`), and `deriveModelBodySection` converts `localZ = worldZ -
placement.position.z` (a pure Z-axis Placement rotation never changes Z).
Degenerate sections (Z above/below the body's world range, a tangent
slice, an open profile that never chains into a closed loop) each throw a
distinct, named `ModelBodyDeriveError` (ADR-0003). **Persisted snapshot,
not a live reference**: a derived section lands a real `Layer2D` on the
model geo row exactly like the STEP path (same `appendGeometryProjection`
landing, visible in the geometry tree, selectable loop ids) — it is
computed once when the wizard button is clicked and does NOT re-derive
automatically if the model is edited afterward (that live-reference
behavior is Stage 5's durable `ModelReference`, not built here). At
compute time, an op bound to specific persisted loop ids (i.e. a
Section-at-Z selection) uses those loops as-is; an op with no such
selection still falls through to Stage 2's whole-body
`deriveModelBodyProfile` default, unchanged. Face/edge-level B-rep derive
(Pick face, Pick edges, Detect holes) stays brep-only — Stage 5's
per-face-identity territory — as does the interactive viewport Z-scrub
live preview (`startSectionScrub`/`enterBrepSectionMode`), which calls the
occt-model worker directly; a model source uses the typed-Z + button flow
only (a disclosed, scoped-out enhancement, not a silent gap).

**Face boundaries — durable ModelReferences (CAM-BINDING Stage 5, the
program's final and highest-value stage).** Where Stage 2/4 derive against
the WHOLE body (or a Z-section of it) as a fresh, ephemeral or once-landed
snapshot, Stage 5 lets an op bind to a single PICKED FACE as a durable,
re-verified reference: `op.modelReferences: ModelReference[]` (`src/lib/cam/
types.ts`, CAM-1's own type, populated for real for the first time here) —
`{ bodyId, stableIds: [faceStableId], role: 'machining-boundary' }`.

*Face identity.* `ModelBodyDisplay` (INT-17A's persisted tessellation
payload) gains `faceIds?: string[]` (one entry per distinct face, ElementMap
stable ids) and `triFace?: number[]` (per-triangle index into `faceIds`) —
captured verbatim from the SAME live `CachedBody` the Model kernel's
`GeometryCache` already holds (`src/viewport3d/modelBodyDisplay.ts`), no new
tessellation or kernel call. Both fields are optional/additive (a project
saved before this stage, or a body not yet re-synced, simply cannot
face-pick until its next regen) — a consumer missing them refuses by name,
never invents a face id.

*Pick, in the CAM viewport, without crossing the identity boundary.*
`CNCViewport.addModelBody` tags its mesh `isModelPickMesh` (only when
`faceIds`/`triFace` are present) with `geometry.userData.modelTriFace`/
`modelFaceIds`. `resolveBrepHit`/`collectBrepObjects` gained a PARALLEL
resolution path for such a mesh — a direct O(1) `triFace[triIndex]` lookup,
never occt-model's `faceRanges` binary search — so a face click on a modeled
body resolves `{geoId, index, isModelFace: true}` (index = a position into
that geo's own `display.faceIds`, never itself persisted) without the two
identity systems ever touching. The op wizard's new "Machining boundary"
block (`NewOperationModal.tsx`, contour_2d/pocket_2d only — Stage 2's own
compute-support scope) resolves the hit to the real stable id, validates it
IMMEDIATELY via `deriveModelBodyFace` (fail loud at pick time — nothing is
written on a bad pick, mirrors the STEP Pick Face / Properties Panel
datum-pick precedent), and folds it into `modelReferences` on Save. The pick
collapses the modal to the SAME floating banner mechanism
(`brepPickKind`) the existing brep face/edge/datum picks already use — found
necessary via real-app proof: the modal's own centered dialog otherwise
covers the viewport, so a canvas click could never reach the model.

*Derive: `deriveModelBodyFace`* (`src/lib/cam/modelBodyDerive.ts`) extracts
ONE face's boundary as world-space `Loop2D[]`: gathers the face's own
triangle subset (`triFace[t] === faceIndex`), refuses a non-planar/
non-Z-normal face (same rule as occt-model's `planarFaceLoops`/ADR 0018 D5),
then traces its boundary via a standard mesh-patch-boundary algorithm (an
edge shared by exactly one triangle in the subset is a boundary edge, one
shared by two is interior and dropped) — winding/sign-independent by
construction, reusing `stlProjection.ts`'s `buildLoops`/`dp` (Douglas-Peucker,
newly exported) rather than a parallel simplification. Called FRESH on every
compute (never landed/cached, unlike Stage 4's Section-at-Z snapshot) — a
landed snapshot would give the re-resolution hook nothing to invalidate,
defeating the point of a durable reference. `computeOperationToolpath`'s
model-origin catch gives a `'machining-boundary'`-role reference PRIORITY
over Stage 4's persisted section-selection and Stage 2's whole-body default.

*Badges, for real.* CAM-1's re-resolution hook
(`SolidsWorkbenchPage.reresolveCamModelRefs` -> `client.resolve` ->
`store.reresolveModelReferences` -> `modelReferenceResolution.ts`'s exhaustive
outcome table) ships end-to-end: a REAL op populates `modelReferences` (CAM-BINDING
Stage 5 machining-boundary face binding), so this machinery runs for real on
every Model regen. The retired `?camharness=1` DEV bridge is gone. Outcomes:
`exact` (untouched), `fallback`/`stale-changed` (-> `'outdated'`, amber,
toolpath cleared -- a genuine recompute is required), `lost` (-> `'degraded'`,
red, toolpath RETAINED, never silently recomputed --
`computeOperationToolpath`'s own pre-existing `op.status === 'degraded'` guard,
unchanged, refuses to even attempt a compute). An unknown/malformed resolver
status throws (`ModelReferenceResolutionError`) before any mutation.

*Postprocessor gate — already exhaustive, extended once.*
`validateOpsCurrent` (`src/lib/post/validate.ts`) already refused
`'outdated'`/`'degraded'` ops via a compiler-enforced exhaustive switch over
`OperationStatus` (CAM-1); Stage 5 adds ONE new backstop,
`validateModelRefsVerifiedSinceLoad`, closing the load-boundary rehydration
gap below.

*Load-boundary rehydration gap (charter RISK 2) — closed, not just
disclosed.* `reresolveCamModelRefs` only ever runs inside the Model
workbench's own `fullResync`, which only runs once that workbench mounts
(lazy-loaded, INT-13A D1) — a `.camproject` loaded with a face-bound op and
never followed by a Model-tab visit would otherwise show its SAVED status,
unverified, forever. The fix is an ORDERING one, not a resolve-at-load
patch (a naive early resolve would falsely degrade every model-bound op
before the Model document rehydrates): a new session-only store flag,
`modelRefsVerifiedSinceLoad` (never persisted to a `.camproject`), is set
`false` by `loadProjectFromFile` and `true` the first time
`reresolveModelReferences` actually runs against the live kernel this
session — regardless of outcome. `postProject.ts`'s new backstop
(`validateModelRefsVerifiedSinceLoad`, threaded via
`PostProjectOptions.modelRefsVerifiedSinceLoad`, sourced by
`PostProcessModal.tsx` from the store) refuses to post ANY op carrying a
`modelReferences` entry until verified — so a stale-but-unflagged reference
is refused loudly, never silently posted. Ops with no `modelReferences` are
entirely unaffected.

Full program charter: `coordination/work-orders/CAM-BINDING.md`. UI surface
(op-source picker, status badges, the Machining boundary pick block):
docs/UI-ARCHITECTURE.md's operation status section.

## Type system

The type system has three locations, each with a defined scope.

### `src/types/index.ts` — project-wide types

Top-level types used by UI, state, and worker layers:

- `OperationType` — union of all operation type strings (`'contour_2d'`, `'pocket_2d'`, `'adaptive_clearing_2d'`, etc.)
- `Operation` — an operation instance in a project
- `Tool`, `FeedsAndSpeeds`, `FeedrateOverride` — tool and feed types
- `HeightParams` — the canonical 5-height structure (see Height plane convention)
- `PassParams`, `LinkingParams` — pass strategy and linking
- `ToolpathMove`, `MoveRole` — the output move type and role vocabulary
- `Vec2`, `Vec3` — geometry primitives
- `LoopData` — closed/open loops of points
- `AppSettings` — global app preferences (a store-root sibling of `project`, kept out of the `.camproject` export); includes the navigation-preset fields `navPreset` / `invertZoom` / `invertPan`
- `Project.schemaVersion` — the portable `.camproject` document schema version (ADR-0027). Old files auto-upgrade through an ordered migration chain (`src/store/migrations/`) applied on file-load AND on persist-rehydrate; a file from a newer app version fails loud (ADR-0003) rather than silently half-loading. Distinct from the Zustand persist `version` (which governs the localStorage blob envelope / slice layout). The existing coordinate-hierarchy migration is the v0->v1 step
- `NavPresetId`, `NavButtonAction`, `NavPreset`, `NavModifierRule`, `NavModifierState`, `NAV_PRESETS`, and the pure resolvers `resolveNavAction` / `navInvertWheelDeltaY` / `navInvertPanDelta` — the 3D-view navigation-preset model (see §3D-view navigation presets)

### `src/lib/cam/types.ts` — worker-protocol types

Types used by the worker boundary:

- `WorkerRequestMsg`, `WorkerResponseMsg` — message protocol
- Per-operation params and payloads: `ContourParams`, `ContourWorkerPayload`, `PocketParams`, `PocketWorkerPayload`, etc.
- `ChamferHeightReference` — chamfer-specific enum used in payload prep
- Re-exports of `ToolpathMove` from project-wide types

### `src/lib/cam/<op>2d/types.ts` — per-operation internal types

When an operation is a submodule, its private types live here. Examples
from adaptive clearing:

- `PlannerState`, `ScoredCandidate` — internal state machine types
- `ComponentInfo`, `FrontierCell`, `PocketEntryDecision` — algorithm types

These types may be exported within the submodule (across its internal
files) and consumed by the submodule's tests. They should not become
part of the worker/UI public API. If another module needs to consume
an internal type, that's a signal the type should be promoted to
`src/lib/cam/types.ts` first.

## 3D-view navigation presets

The viewport camera is driven by stock Three.js `OrbitControls`. A user-selectable
navigation preset (`appSettings.navPreset`, plus `invertZoom` / `invertPan`; the
user-facing surface is documented in docs/UI-ARCHITECTURE.md §12.5) re-maps how the
mouse orbits, pans, and zooms. The model is a pure, DOM-free data layer in
`src/types/index.ts` (`NAV_PRESETS` + `resolveNavAction` + the two invert-sign
helpers, all unit-tested); the application layer is `CNCViewport.applyNavPreset`.

Two preset kinds:

- **Bare-button** presets (LienCAM default, right-button orbit, orbit-on-middle) map each
  mouse button directly to a camera action and are expressed by setting
  `controls.mouseButtons` / `controls.touches`. Nothing else is installed.
- **Modifier-gated CAD** presets reserve LEFT
  for selection and gate orbit-vs-pan-vs-zoom on a modifier + middle-drag.
  `OrbitControls.mouseButtons` has no per-button modifier slots, so these carry a
  `modifierRules` table and `applyNavPreset` installs a **capture-phase
  `pointerdown` remapper**. It runs before OrbitControls' own bubble-phase handler,
  resolves the intended action from button+modifiers via `resolveNavAction`, and
  writes a base `mouseButtons` value chosen to **compensate for OrbitControls'
  internal modifier swap** so the net gesture is exact (the reasoning is recorded
  in `docs/planning/NAV-MODIFIER-SPIKE.md`).

Direction inversion: OrbitControls treats `zoomSpeed` / `panSpeed` as magnitude
only, so inversion flips the delta **sign**. Invert-zoom is a capture-phase `wheel`
interceptor (`navInvertWheelDeltaY`); invert-pan monkey-patches the private
`controls._pan` to negate both deltas (`navInvertPanDelta`), cleanly un-patched on
toggle-off. **Invert-orbit is not offered** — OrbitControls exposes no equivalent
sign hook for rotation.

`applyNavPreset` deliberately touches **only** `.mouseButtons` / `.touches` and the
zoom/pan sign — never `enableRotate` or `enabled`. It therefore composes cleanly
with sketch mode (which sets `enableRotate=false` on enter), TransformControls
gizmo drags (which toggle `controls.enabled`), and LEFT-click selection raycasting,
none of which the preset can disturb.

## Height plane convention

LienCAM uses a five-plane height model. The same vocabulary applies to
every operation. **No operation may invent its own Z names.**
The Heights tab in the Operation Configuration Wizard surfaces this vocabulary to users; see docs/UI-ARCHITECTURE.md §8.2.

```
       ↑ Z (machine absolute = wcsOrigin.z + WCS-relative)
       │
       │   clearanceHeight ────  rapid traverse plane above all stock and fixtures
       │
       │   retractHeight   ────  lift plane between depth passes or island avoidance
       │
       │   feedHeight      ────  optional: transition from rapid to feed before plunging
       │
       │   topHeight       ────  stock/model surface reference (cut starts here)
       │
       │   ... cut passes ...
       │
       │   bottomHeight    ────  final cut depth / target floor
       │
       ↓
```

### Mode resolution

`HeightParams` ships with each numeric height plus, where applicable,
a `*Mode` field that explains how to interpret the number. Example
modes seen today:

```ts
interface HeightParams {
  clearanceHeight: number
  clearanceHeightMode: 'absolute' | 'relative'
  retractHeight: number
  feedHeight: number
  topHeight: number
  topHeightMode: 'stock_top' | 'model_top' | 'absolute'
  bottomHeight: number
  bottomHeightMode: 'model_bottom' | 'absolute' | 'selected_face'
}
```

**The store resolves all height modes — current and future — to
absolute WCS-relative numeric values before dispatching to the
worker.** This includes fields without explicit `*Mode` flags today
(`retractHeight`, `feedHeight`) if they ever gain a relative mode in
the UI: the store handles the resolution, the worker only ever sees
numbers.

**Operations must not interpret modes themselves.** By the time a
height field reaches an operation, it is a pure number in WCS-relative
units. Any attempt to interpret a relative mode inside an operation is
a layering violation.

As of heights phase H1 (2026-06-11, docs/planning/HEIGHTS-AUDIT-AND-PLAN.md)
this statement is true for ALL operations: adaptive clearing, contour,
and drill previously dispatched raw heights (their mode fields were
dead), and now resolve through the same store-side path as the rest
(`resolveTopZ` / `resolveModelBottomZ` in `src/store/dispatchGeo.ts`).

**Plane-ordering validation (fail-loud, ADR 0003).** Before dispatch the
store validates `clearance >= retract >= feed >= top > bottom` on the
resolved WCS-relative planes for every operation. A violation sets the
operation's error status with a plain-language message naming the
offending planes — no worker is spawned, no silent wrong toolpath.

### Absolute Z computation

Every operation computes absolute Z planes through the shared resolver
(`src/lib/cam/heights.ts`), which adds `wcsOrigin.z` to each plane:

```ts
const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
```

The resolver output names follow the pattern: drop "Height", append "Z".
`clearanceHeight → clearanceZ`, `retractHeight → retractZ`, etc.

## Coordinate hierarchy and scene-nesting behavior (ADR 0020)

The nested model `machine → setup (primary WCS) → stock → geometry → operation
internal offsets` (ADR 0020) decides where every cut lands in X, Y AND Z.
Resolution composes inward-to-machine; `resolveTopZ` / `resolveModelBottomZ`
(`src/store/dispatchGeo.ts`) walk a part's owning stock and its setup WCS to the
absolute plane. Phase 4 added the *move/scene-nesting* behavior on top of that
resolution spine. The machine-safety rule is absolute: wrong nesting must FAIL
LOUD (ADR 0003), never silently place a cut at a guessed location.

### One stock per setup (ADR 0026)

A setup is ONE work coordinate system = ONE fixture origin = ONE stock; parts at a
different stock/height get their OWN setup (exported together as a multi-offset
combined program). A setup whose operations resolve to more than one distinct
stock has no single correct stock-top/clearance plane and is invalid: the pure
checker `setupStockConsistency` (`src/store/stockAssignment.ts`) resolves each op's
owning stock (reusing `resolveOwningStock` + `effectiveStockIdForCompute` for nest
seeds) and `postProject` REFUSES to export any selected setup that mixes stocks,
emitting a fail-loud `SETUP_MULTI_STOCK` error (ADR 0003) that tells the user to
split the work into separate setups.

### `partWorldTransform` — the single world-placement seam

`partWorldTransform(geo, stocks)` in `src/store/partTransform.ts` is the sole
source of truth for a part's world (machine-frame) position and rotation. It is a
pure, dependency-light function. Today it is the **identity**: under the chosen
transform model (machine-absolute coordinates — ADR 0020's resolution layer is
untouched), `geo.position` / `geo.rotation` are already machine-absolute for both
derived and explicit members, so the stored transform *is* the world transform.

Its value is the **upgrade seam**. A future workspace tier
(`machine → workspace → stock → geometry`) or a switch to stored stock-relative
local transforms adds exactly one `compose` step here — no call-site churn. The
`stocks` parameter is threaded now (inert today) for exactly that day. Viewport
part-placement reads route through it (`restoreGeometryToViewport`); leaf engine
methods that receive already-extracted `Vec3`s are left as-is (the identity makes
this correctness-neutral).

### Moving an EXPLICIT stock is a rigid-fixture move

Moving an explicit (fixed) stock translates the whole fixture as one rigid body in
a single store mutation (`moveFixedStockLive` → `translateStockMembers`):

- the legacy `FixedStockItem`,
- its explicit `PhysicalStock` twin (kept in sync by `syncFixedStocksToPhysical`,
  so the resolution frame never goes stale — the two stock representations have
  not yet been collapsed; that reconcile is deferred),
- **every member geometry** (`geo.stockId === stock.id`), and
- a `stock_corner`-bound WCS pinned to it (`applyStockToSetups`, Phase 3's
  conditional re-derivation),

all shift by the **same delta**. One gizmo gesture is one undo entry (history is
pushed on gizmo enter; the live move is a single `set()`). Membership re-sort
(`assignStocks`) is a no-op for ridden members — they keep containment inside the
also-moved box — but still catches a non-member the moved box now contains or
releases. A `part_feature` (snap) WCS on a *ridden* member follows its part
(`applyGeoSnapToSetups` recomputes from the moved world position — the feature
physically rode with the fixture); a snap on a non-member, and a `manual` WCS, do
not move.

**Output-invariance (the binding safety contract).** A rigid stock+members move
changes only *where the fixture sits on the bed*; the resolved cut location
**relative to the work offset** — the value that drives GCode — is byte-identical
before and after. This is proven by test
(`src/tests/store/explicitStockMove.test.ts`): `resolveTopZ('stock_top')` for Z
and member-minus-WCS for X/Y are exact-equal across the move. Because the move is
output-invariant, member staleness/projection flags are deliberately *not* bumped.
**Fail-loud (ADR 0003):** a member whose `stockId` has no fixed stock or no
explicit `PhysicalStock` twin surfaces a typed error rather than placing the cut in
a guessed frame.

### Stock RESIZE keeps members in place

Resizing an explicit stock (`updateFixedStock`) grows/shrinks the box; members do
**not** move (they keep their position within the new box) and a `stock_corner`
WCS rides the moved corner. (Contrast the rigid *move* above, which carries members
with it.)

### DERIVED stock re-wraps eagerly

A derived (auto) stock has no independent placement — its bounds *are* wherever its
members are. Previously its stored `PhysicalStock.bounds` were recomputed only
lazily at dispatch time, so any non-resolver reader saw a stale box. Phase 4 makes
the re-wrap **eager**: `rederiveDerivedStockBounds` recomputes and stores each
derived stock's bounds from its own members after a member moves, is added, or is
removed (wired into `updateGeometryTransform`, `addGeometry`, `removeGeometry`, and
`setStockMembership`, *after* `assignStocks` so membership is final — so both the
stock a part left and the one it joined re-derive).

**Guardrail (ADR 0020, binding):** each derived stock re-derives from *its own*
members only (`geo.stockId === stock.id`) — never an all-geometry / all-stocks
aggregate. Explicit stocks stay authoritative (untouched). A derived stock that
loses its last member keeps its prior bounds (`deriveStockBounds` returns null; no
zero-out). By construction the eagerly-stored bounds equal the lazy dispatch-time
derivation for the single-derived-stock case, so the two paths stay consistent.

**A member can be a modeled body (CAM-BINDING Stage 3, `coordination/work-orders/
CAM-BINDING.md`).** `geometryWorldBounds` (`src/store/dispatchGeo.ts`) now resolves
a `format:'model'` row's world-space AABB from its own tessellated display bbox
(`geo.modelBody.display.bbox`), composed through `resolveModelReferenceFrame`
(`src/lib/cam/modelReferenceFrame.ts`) — the ONE seam every world-position
resolution of a modeled body must flow through — since a model row's own
`position`/`rotation` stay identity forever (its real world pose lives in the
Model Item's Placement record). This *reverses* the pre-Stage-3 refusal ("a
model-backed CAM entry contributes no bounds"): a modeled body assigned to a
NAMED stock via `setStockMembership`/`setGeometryAutoStock` (the SAME "Owning
stock" control an imported part already uses, respected by `assignGeometryToStocks`
exactly like any other LOCKED geometry) now sizes that stock to its live bbox, and
`syncModelBodies` re-derives every affected stock/setup-WCS on each model regen
(mirroring `addGeometry`'s own rederive pipeline) so the stock tracks the model on
every parametric edit. An UNLOCKED model row is still never swept into a stock by
automatic containment (the passive-safety half of the original refusal is
unchanged). **Disclosed scope boundary:** cut-time coordinate/height resolution
(`resolveTopZ` / `owningStockWorldBounds` / `computeGeometryScope`) does not yet
thread Placement through to see a model-body member — Stage 3 delivers correct,
live-updating stock BOUNDS (create/view/auto-update), not yet a model-derived
stock usable as another operation's height reference; that is a disclosed, named
follow-up, not a silent gap.

### Scene rendering stays flat

The flat sibling scene graph and the auto-box union rendering are unchanged. Under
the machine-absolute model an explicit-stock move needs no Three.js re-parenting —
ridden part groups simply re-read their updated machine-absolute positions on the
normal refresh path. `originBinding` stays **descriptive-only** in Phase 4 (no
reader was flipped — that is Phase 5); the ADR 0002 five-plane Z vocabulary is
unchanged; the legacy/`PhysicalStock` type collapse remains deferred.

## MoveRole vocabulary

Every `ToolpathMove` may carry a `role?: MoveRole` annotation describing
why the move exists. Visualizers, simulators, and the eventual viewer
integration use the role to colour-code paths and let users toggle
visibility per role.

```ts
type MoveRole =
  | 'rapid'      // non-cutting traversal at clearance/retract heights
  | 'cut'        // material removal at cutting depth
  | 'helix'      // helical descent into material
  | 'ramp'       // linear/sloped descent along path
  | 'plunge'     // vertical descent at a point
  | 'stepover'   // transition from one ring/pass to the next at depth
  | 'lead_in'    // tangent arc/spiral entering the cut profile
  | 'lead_out'   // tangent arc/spiral exiting the cut profile
  | 'loop_back'    // curved non-cutting return between disjoint cutting segments (M8 territory)
  | 'wall_follow'  // straight-line stay-down or micro-lift transit through cleared territory (M7)
  | 'finish'       // dedicated wall-finishing contour at the true wall (0 radial stock); see Adaptive clearing
```

Roles are optional but operations SHOULD tag every move they emit.
Untagged moves render as generic feed/rapid in visualizations.

### Engagement state and feedrate resolution

MoveRole tags discriminate engagement state. Future feedrate resolution may
consult MoveRole to select the appropriate rate per move type.

Engagement-state categories:

- **Engaged cutting** — `'cut'`: full feedrate, full engagement
- **Lead-in / lead-out** — `'lead_in'`, `'lead_out'`: reduced or ramped feedrate to ease into/out of engagement
- **Transit at depth along a wall** — `'wall_follow'`: a wall-ride at cut depth emitted by adaptive clearing's Integral wall-follow option in place of a between-pass lift (stay-down; see below)
- **Non-engaged transit at depth** — `'stepover'`: may run faster than cutting feedrate (no engagement)
- **Non-cutting reposition at depth** — `'fast_traverse'`: a fast traverse through already-cleared stock at cut depth (no engagement); the postprocessor feeds it at the machine traverse/rapid rate
- **Dedicated finish** — `'finish'`: adaptive clearing's optional wall-cleanup contour and floor-cleanup replay cuts; cutting moves with their own resolved feedrate that **defaults to the cutting feed** (see the finish passes below), NOT machine-clamped
- **Z-lift** — `'plunge'`, `'ramp'`, `'helix'`: own plungeRate; future work may distinguish ramp/helix from straight plunge
- **Rapid** — `'rapid'`: machine maximum, G0

Adaptive clearing's keep-down reposition links (jumpType 1) traverse already-cleared
stock at cut depth between arcs. They carry the `'fast_traverse'` move type and **no
baked feedrate in the geometry**. Move geometry and move speed are separate data: a move
is geometry + move type, and the operation that produced it holds the speed for each move
type — always known, and clamped to the machine maxima (machine limits sit above
operation speeds in the hierarchy). The software pairs move type with the operation's
known speed to drive simulation and the cut-time estimate; the postprocessor
(implemented in src/lib/post/; ADR 0001, ADR 0021) is only where that speed is
finally written into the gcode/.nc. A fast
traverse's speed is the operation's traverse rate (bounded above by the machine rapid
rate). (Other roles still carry an emit-time `feed` value as an interim until geometry
and speed are fully divorced — that divorce is the larger pending postprocessor
migration.)

The simulation enforces this contract FAIL-LOUD (SIM-4, 2026-07): playback frame
construction (`buildFrames`, SimulationPanel.tsx) refuses any non-rapid move that
lacks a finite positive feed — a named error, never a silent rapid substitution —
and rapids are timed at `project.machine.rapidRate`. The 3D operation adapters
(`src/cam3d/integration/parallel3dOperation.ts` / `adaptive3dOperation.ts`) resolve
Tool -> Operation Override via `resolveFeedrates` and stamp a feed onto every
non-rapid IR move by role, so 3D toolpaths satisfy the contract at the source.
(Booked residual: `estimateRuntimeMs` still falls back to rapid silently for
legacy feedless ops — BK-137.)

`resolveFeedrates` currently returns `feedRate` and `plungeRate` only. The
`ResolvedFeedrates` structure may extend in future milestones to include
`linkFeedRate` (for transit) and `leadFeedRate` (for lead-in/out), with
`MoveRole` as the selector at emission time. ADR 0004's two-tier resolver
pattern (override → tool defaults) accommodates this extension without
amendment.

### Adaptive frontier-tangent contact moves

The C3b frontier-tangent entry in adaptive clearing uses `lead_in` for
the plunge-to-contact segment (the lateral feed from the plunge point
in cleared territory to the contact point on the uncut frontier). This
is a natural fit semantically — it is a tangent lead-in to a cut
profile.

A specialized `frontier_entry` role may be added later if visual review
or simulator integration needs to distinguish frontier-tangent contacts
from generic lead-ins.

## Climb direction convention

Climb milling is determined by the geometric relationship between the
tool's travel direction and the uncut material side. The convention is
the same across all operations.

For a 2D cross product `cross(heading, materialNormal) = hx·my - hy·mx`:

- **`cross < 0`** → material side is on the RIGHT of heading → **climb-correct**
- **`cross >= 0`** → material side is on the LEFT of heading → conventional

The "material normal" is the direction pointing from the tool position
toward the uncut material:

- In contour/pocket/chamfer: the offset direction (outward for outer
  paths, inward for inner paths).
- In adaptive clearing: the `entryNormal` at the cleared/uncut frontier
  (see Adaptive clearing entry conventions below).

The `MUST NOT` rule from the operation contract: **no operation invents
a different climb convention**. The cross-product test above is the
single source of truth.

## Adaptive clearing entry conventions

In addition to the universal climb convention, adaptive clearing uses
two related geometric conventions for frontier-tangent entry.

### entryNormal sign convention

At any frontier cell (a cell on the boundary between cleared and uncut
stock), `entryNormal` is defined to point **from cleared stock into
uncut stock**. This makes it analogous to the "material normal" in the
climb convention — both point from the tool position toward the
material to be cut.

### Plunge point formula

To compute a safe plunge point in already-cleared territory, the offset
is applied in the **opposite** direction of `entryNormal` (i.e., into
the cleared side):

```
plungePoint = contactPoint - entryNormal * (toolRadius + clearanceMargin)
```

where:
- `contactPoint` is the frontier cell center (where the tool will first
  engage uncut material)
- `toolRadius` is the tool's cutting radius
- `clearanceMargin` is the setback distance (default ~1 mm) — a
  no-man's-land of cleared territory between the tool's leading edge at
  plunge and the frontier

The validation check on the plunge disk uses **`toolRadius`**, not
`toolRadius + clearanceMargin`, because the disk is the tool's actual
physical footprint at plunge; the clearanceMargin is the setback
distance, not a buffer on the footprint disk.

## Contour pass model

The contour operation cuts along a closed profile. Its pass behavior is
driven by two existing `PassParams`/`ContourParams` fields — `stockToLeave`
(radial material left on the wall for roughing) and `finishPasses` (number of
true-wall finishing loops) — which together express four cutting strategies:

- **cut_at_geometry** — `stockToLeave == 0`, `finishPasses > 0`: no roughing,
  cut straight to the profile at every depth.
- **roughing_only** — `stockToLeave > 0`, `finishPasses == 0`: leave stock on
  the wall, no finish loop.
- **rough_finish_each** — `stockToLeave > 0`, `finishPasses > 0`,
  `contourFinishMode == 'each_stepdown'`: rough plus a finish at every depth.
- **rough_finish_final** — `stockToLeave > 0`, `finishPasses > 0`,
  `contourFinishMode == 'final'`: rough plus a single finish at the final depth.

`ContourParams.contourFinishMode` (`'final'` | `'each_stepdown'`) mirrors
`ACParams.wallFinishMode` and selects the depth(s) at which the finish runs.
It is meaningful only when roughing is on; `'final'` is the default and is
byte-identical to prior behavior (finish once at full depth). The no-roughing
branch (`cut_at_geometry`) always finishes at every depth.

**Fail loud when no cutting mode is selected (ADR 0003).** A contour with
`stockToLeave == 0` AND `finishPasses == 0` would silently emit zero moves with
status "ready". `buildContourToolpath` now throws an actionable error in that
case (and likewise when the stepdown resolves to zero depths) instead of
returning an empty path. The UI strategy dropdown (UI-ARCHITECTURE §8.3) makes
the no-cutting-mode combination unreachable by construction; the throw guards
legacy payloads and direct callers.

## Adaptive clearing wall and floor finish passes

Adaptive clearing has an optional final wall-cleanup pass (`ACParams.wallFinish`,
default OFF). When enabled, `processFeature` builds a true-wall contour =
`offsetClosed(featLoops, -toolRadius)` on the **combined** boundary+islands —
leaving **0 radial stock**, in contrast to roughing which offsets by
`-(toolRadius + finishStock)`. One contour is emitted per resulting loop, appended
after all roughing/cleanup passes. Because the offset is taken on the combined
loops, an island sitting closer than the tool can fit blends into a single wrapped
contour with no special-casing. Each contour is emitted with the new `'finish'`
MoveRole. A degenerate (empty) offset fails loud (ADR 0003).

`ACParams.wallFinishMode` selects the depth at which the finish runs (gated in
`emit`):

- `'final'` (default) — only at the bottom (last) depth level
- `'each_stepdown'` — after every depth level

The finish feedrate resolves through the ADR 0004 two-tier resolver
(`FeedrateOverride.finishFeedrate` → tool-library `feedsAndSpeeds.finishFeedrate`
→ the resolved cutting feed). Unlike `fast_traverse`, it is **not** machine-rapid-
clamped — a wall finish is a cutting move. When no finish feed is set, the pass
simply runs at the cutting feed (`ResolvedFeedrates.finishRate`). Per ADR 0001 the
emit bakes no feedrate on `'finish'` moves; the resolver/runtime own the speed.

Adaptive clearing also has an optional floor-cleanup pass (`ACParams.floorFinish`,
default OFF). Roughing still ends at `trueBottom + max(0, floorStockToLeave)`;
the emitter then replays the existing adaptive entry/cut/link stream exactly once
at `trueBottom`. Replayed `cut` moves carry role `'finish'` with no baked feed,
so they use the same resolved finish feed while preserving radial stock-to-leave.
With zero axial stock this is a valid one-time spring cleanup. If wall finishing is
also enabled, `'final'` runs only at `trueBottom`; `'each_stepdown'` runs at each
rough depth plus `trueBottom`, suppressing a duplicate when those depths coincide.
If axial stock reaches or exceeds the total cut depth, no rough level would exist;
the emitter fails loud instead of replaying a full-depth horizontal cut in virgin stock.

## 3D adaptive roughing (stock-outline full-clear)

The native 3D engine (`src/cam3d/`) has an adaptive rougher (`adaptive_3d`, op
adapter `src/cam3d/integration/adaptive3dOperation.ts`) that carves a z-dexel stock
level by level, driving the 2D adaptive-clearing engine per level. Its full
architecture lives in docs/3d/ (STATUS.md, 3D-TOOLPATH-HITLIST.md); this section
covers only the mechanisms that touch the shared adaptive/cut-region layer.

**Cut region per level** (`src/cam3d/rough/cutRegion.ts`, `cutRegionAt`): at plane
`z` the region to clear is `(stock section at z) MINUS (grown part section at z)`,
both sectioned from z-dexel fields on one aligned grid. Two knobs shape it:

- **Radial stock-to-leave** grows the PART section outward before the difference
  (a skin left on the walls; distinct from the tool-radius inset the engine applies
  later).
- **Corner-reach** (`reachStockEdgeBy`, mm) dilates the STOCK section outward (round
  join) before the difference. Because the engine later insets the whole region back
  by `toolRadius`, a reach of `toolRadius` returns the outer boundary to the true
  stock edge and lets the tool CENTRE reach exterior corner apices — clearing the
  posts a wall-limited path would leave. This is valid ONLY where the carve field is
  the real stock (the full-clear branch); dilating a part-AABB field would drive the
  tool into surrounding uncleared stock, so it is 0 otherwise. Absent/0 is
  byte-identical to the pre-corner-reach behaviour.

**Stock-outline full-clear.** By default the rougher clears only around the part
(the carve field's XY extent is the part AABB). When "clear whole stock" is
requested, the store sizes the carve `ZDexelField` XY to the real stock footprint,
so the difference clears out to the stock walls and frees the part, and passes
`reachStockEdgeBy` (`Adaptive3dParams.stockEdgeOvershoot`, undefined = auto = tool
radius) so the corners clean up. A pure predicate `resolveStockOutlineMode` gates
this: full-clear is allowed only when the part is unspun, has a resolved footprint,
and is the SOLE solid on its stock; every other case falls back LOUDLY (ADR 0003) to
part bounds, because clearing the whole stock would machine nested neighbours
(exclusion zones for multi-part stock are a planned follow-up).

**Opt-in outside-in seed (`ProcessParams.clearedSeed`).** The 2D engine
(`processFeature`) accepts an optional pre-cleared exterior region (FreeCAD
Adaptive2d's caller-supplied `clearedPaths`). When provided AND it abuts the
machinable region — a probe engagement-walker finds an in-band point over it — the
first pass seeds `cleared` from that exterior and grows the frontier INWARD instead
of outward from an interior helix disk, recorded as a new `AdaptiveEntry`/pass mode
`'side'` (a lateral entry that descends in cleared air, no vertical ramp). When the
seed is absent or does not abut (closed pocket), the probe returns null and behaviour
is byte-identical to the interior-helix default. This is the engine-level mechanism
for a future side/edge lead-in; it is not yet wired to the 3D rougher or the UI.

## Module layout

```
src/
├── types/
│   └── index.ts              Project-wide types (HeightParams, ToolpathMove, etc.)
├── store/
│   └── index.ts              Zustand store + worker dispatch
├── components/
│   ├── modals/
│   │   └── NewOperationModal.tsx
│   ├── panels/
│   │   └── PropertiesPanel.tsx
│   └── ...
├── lib/
│   ├── cam/
│   │   ├── toolpathWorker.ts            Worker entry, dispatches by message type
│   │   ├── types.ts                     Worker-protocol types
│   │   ├── contour2d.ts                 Operation
│   │   ├── pocket2d.ts                  Operation
│   │   ├── drill2d.ts                   Operation
│   │   ├── chamfer2d.ts                 Operation
│   │   ├── face2d/                      Operation (submodule: index.ts + STATUS.md)
│   │   ├── adaptiveClearing2d/          Operation (submodule)
│   │   │   ├── engine/                     FreeCAD Adaptive2d port (LIVE):
│   │   │   │                               index, clipperEngine, toolGeometry, geom,
│   │   │   │                               interpolation, steering, engagementPoint,
│   │   │   │                               processFeature, wallCleanLoop, emit
│   │   │   ├── AC-SPEC.md                  contract (rules, invariants, arc model)
│   │   │   ├── AC-ATTEMPTS-LEDGER.md       dead-end / lost-code ledger
│   │   │   ├── HANDOFF.md                  session-to-session continuity
│   │   │   └── STATUS.md                   active-development milestone log
│   │   │   (the old state-machine planner files — planner.ts, stock.ts,
│   │   │    engagement.ts, frontierEntry.ts, etc. — and morphProto/ were
│   │   │    removed in the 2026-06-10 cleanup; see docs/planning/CLEANUP-PLAN.md Stage 2)
│   │   ├── heights.ts
│   │   ├── feedrates.ts
│   │   ├── geometry/                    (Phase 1 C3, 24f3fb3)
│   │   │   └── occt/
│   │   │       ├── vendor/                 occt-fillet WASM kernel (ADR 0014)
│   │   │       └── model/                  B-rep model kernel (ADR 0018)
│   │   │           ├── types.ts               model worker protocol + BrepModelPayload
│   │   │           ├── core.ts                STEP read, heal, tessellate, subshape index
│   │   │           ├── derive.ts               face loops / edge chains / holes / sectionAtZ
│   │   │           ├── modelWorker.ts          dedicated worker entry (shape registry)
│   │   │           ├── modelClient.ts          main-thread promise client + payload registry
│   │   │           ├── loader.ts               lazy singleton wasm loader
│   │   │           └── vendor/                 occt-model WASM kernel + build notes
│   │   ├── moves/                       (Phase 1 C4, 238f568)
│   │   └── helix/                       (PLANNED)
│   ├── stepCache.ts                     IndexedDB cache of original STEP bytes (ADR 0018 D2)
│   └── geometry/                        Import-pipeline geometry (path2d, loopOptimizer)
└── tests/
    ├── adaptive-clearing/               Active AC tests
    └── ...
```

## Cross-domain boolean (mesh vs Model body)

MSH-4 (the operator Q-70 A + Q-72 A). `booleanMeshVsModelBody` (`src/store/index.ts`)
runs a one-shot manifold boolean of an imported STL against a Model body and
appends a NEW STATIC geometry row (`format:'stl'` + `approximate?`/
`booleanProvenance` marker fields) — a derived import-like snapshot, never a
live recomputed feature, which is what lets it dodge the (non-existent)
mesh-body feature-DAG. The manifold boolean runs off the main thread in the
app's first `MeshWorkerClient` singleton (`src/mesh/browserMeshClient.ts`, lazy,
disposed on `newProject`). The Model-body operand is its **persisted display
tessellation** world-baked through `resolveModelReferenceFrame` — identical to
every other CAM-side model-body derive (`modelBodyDerive.ts`), because the CAM
domain holds no live kernel handle (the CAM-BINDING identity boundary; there is
no tolerance control to re-tessellate a B-rep). Honesty is rigorous, not
blanket: `classifyModelBodyFidelity` (`src/lib/cam/booleanMeshModel.ts`) reads
the body's per-face display data and marks the result EXACT when every face is
planar (flat faces triangulate exactly — only the geometry type changed) and
APPROXIMATE only when a curved face was represented by triangles. Failures fail
loud (ADR 0003): non-manifold mapped to a readable message, empty result,
operand-size ceiling, and missing tessellation each refuse by name. The pure
core (fidelity classifier, world-bake, feedback copy, eligibility predicates,
failure mapper) is unit-tested against real manifold-3d.

## Machine control subsystem (GRBL sender)

**STALE FRAMING - READ "Machine control boundary" ABOVE FIRST. IT IS
AUTHORITATIVE WHERE THE TWO DISAGREE.**

Found by the whole-system audit of 2026-08-26, and it is the exact defect this
document now warns about elsewhere: **two sections about machine control that
contradict each other.** The boundary section above says the machine layer is
controller-AGNOSTIC with backends beneath it. **This section's title and opening
sentence say `src/lib/machine/` IS a GRBL sender.** That framing predates the
UCCNC backend and it is precisely the "GRBL is the implicit identity" defect the
boundary section exists to name.

**WHAT IS STILL TRUE:** everything below describing the GRBL BACKEND's internals
- framing, classification, character-counting flow control, the MDI queue,
`sendCommandAwait` semantics. Read it as documentation of ONE BACKEND.

**WHAT IS NOT:**
- **`transport.ts` and `simulatedTransport.ts` DO NOT EXIST.** Verified against
  the tree. This section describes them approvingly, including a claim that
  "every app feature is exercised end to end against it before real hardware" -
  about a file that is gone.
- **`src/lib/machine/` is NOT a GRBL protocol stack.** It holds the
  controller-agnostic contract, the UCCNC backend, the simulated backend and the
  session, of which GRBL is one part.

**This section is left in place rather than deleted because its backend detail is
still accurate and nobody has re-verified the rest line by line. Do not cite it
for anything above the backend layer.**

`src/lib/machine/` is a framework-free protocol stack that connects the
browser to a GRBL 1.1 controller (Web Serial, Chromium desktop) or to the
built-in software controller. Layering, bottom up:

- `transport.ts` / `webSerialTransport.ts` - bytes in/out + lifecycle. The
  `SimulatedGrblTransport` (`simulatedTransport.ts`) is a full software GRBL
  behind the SAME interface: banner, planner-window acks, status reports,
  real-time motion over wall-clock time, `$H`/`$J`/`G10`/`G53`, `G38.2`
  probing against a virtual pad, `G43.1`/`G49` TLO folded into the WCO
  math (WCO pushed in the NEXT report after any offset change, like real
  GRBL), and M0 pauses that hold IN STREAM ORDER. Every app feature is
  exercised end to end against it before real hardware.
- `lineFramer.ts` + `grbl/lines.ts` - chunk framing and pure classification
  of every RX line (ok/error/ALARM/status/feedback/settings).
- `grbl/streamer.ts` - character-counting flow control (never exceeds the
  controller's RX buffer) with source-line attribution.
- `grbl/controller.ts` - the stateful session: handshake, activity-scaled
  status polling, WCO caching, job lifecycle (start/pause/resume/stop/
  step/e-stop), jog, overrides, and an MDI queue whose entries can carry
  resolvers - `sendCommandAwait()` resolves on that command's OWN ack and
  settles failed on alarm/reset/disconnect; sequenced flows build on it.
  Homing state survives a COMMANDED soft reset (GRBL retains position) but
  not an unexpected banner.
- `machineSession.ts` - module-side singleton wiring the controller into
  `machineControlStore` (an unpersisted zustand store - a "connected" state
  must never rehydrate), plus the sequenced runners: `runZProbeCycle`
  (fast/fine `G38.2` fixed-pad cycle; work-Z0-through-pad or measure-tool),
  `runParkMove` (`G53` safe-Z-then-XY, HOMING-GUARDED), and the guided tool
  change (begin/continue): controlled stop, park, swap prompt, probe,
  `G43.1` vs the reference tool, re-arm via `runFromLine.ts`. Runners never
  inject commands mid-stream - the streamer keeps lines past a pause inside
  GRBL's buffer, so every intervention is a controlled stop plus a
  run-from-line re-arm.
- `toolTable.ts` + `machineToolTableStore` - sender-side per-machine tool
  length table (GRBL has no controller table): probed machine-Z per tool,
  one starred REFERENCE, `G43.1` delta math, per-machine Z-probe config.
- `machineActions.ts` + `machineActionsStore` - the action abstraction: no
  Control-tab button hardcodes codes; built-in actions resolve
  user-override -> per-controller default; custom macro buttons and park
  positions (machine-coordinate slots + a REQUIRED safe Z - never a guessed
  default) persist per machine id, outside the project schema.

Safety contract (ADR-0003 spirit; docs/planning/MACHINE-CONTROL-PLAN.md is
the stage-by-stage plan): nothing auto-connects, auto-runs, or auto-retries;
every motion is an explicit gesture; `error:N` mid-job halts and holds;
`ALARM:N` hard-stops with decoded recovery text; probe misses abort loudly.

## Operations catalog

| Operation | File | Status | Notes |
|---|---|---|---|
| Contour 2D | `contour2d.ts` | Stable | Single-loop walking, lofted-spiral roughing→finishing bridge; four cutting strategies via `stockToLeave` + `finishPasses` + `contourFinishMode` (see Contour pass model); fails loud when no cutting mode is selected (ADR 0003) |
| Pocket 2D | `pocket2d.ts` | Stable | Concentric ring offsets, helix/ramp/plunge entry, island bridges, G2 Bézier stepover |
| Drill | `drill2d.ts` | Stable | Centroid-based point ops, multiple cycle types, sort strategies. Per-hole bottom depths from detected `HoleFeature`s: the store resolves each hole's `bottomZ` into the payload's `holeBottoms` map (WCS-relative, keyed by loop id — payload data, not Z params, per ADR 0002); the op-level bottom plane stays the fallback for loops without a hole entry (warned per ADR 0003). |
| Chamfer 2D | `chamfer2d.ts` | Stable | V-bit geometry with tipOffset XY shift, single-depth |
| Face 2D | `face2d/` | In development (v1) | Scanline parallel-pass surfacing; OUTWARD boundary overrun (inverse of pocket inset); source-agnostic via boundary-source abstraction (stock in v1). See ADR 0015. |
| Thread Mill | `threadmill2d.ts` (+ pure core `threadHelix.ts`) | Stable (v1) | Helical-interpolation threading, INTERNAL + EXTERNAL. Internal threads a PRE-DRILLED hole (a separate drill op bores it larger than the tool and below the thread bottom — this op plunges straight down the open hole and orbits up); external is the MECHANICAL MIRROR around a SOLID boss — `R_final` ADDS the tool radius instead of subtracting it, the cutter plunges in AIR beside the boss (never crosses the boss center), leads in/out on the OUTSIDE via a virtual-center tangent arc, and has NO exit climb. internal/external changes the orbit RADIUS only. Per hole + per RADIAL infeed pass: a helix advancing exactly `pitch` per revolution and landing exactly on the depart plane, emitted as a dense feed polyline (post-safe; helical-arc output deferred) with tangent lead-in/out arcs. There is NO axial stepdown — infeed steps the orbit RADIUS, not Z. The INTERNAL infeed span is now REAL per-hole geometry: `spanReal = (majorDiameter - holeDia)/2`, stepping outward to `R_final` (each selected hole gets its own derived pass count); external cuts to the thread ROOT via `R_final = majorDiameter/2 + toolR - 0.6*pitch` (ADR 0031 Amendment 9 -- it previously stopped at the crest/boss-OD and cut no groove); the `0.6*pitch` external depth stays a v1 approximation (deriving the real span from a measured root diameter is future work). Climb/conventional is FUNCTIONAL (ADR 0031 Amendment 7): the orbit SENSE follows the chip-load model `s = cut x kind x spindle` (`threadOrbitSense`, hand-INDEPENDENT, like 2D contouring), and the thread HAND then couples it to the axial TRAVEL direction (`threadTravelUp`), so the builder traverses bottom-to-top OR top-to-bottom (a `descend` helix). `cutDirection` is the real knob; the spindle is a TOOL-HARDWARE property (`spindleSignForTool`, standard right-hand cutter = M3; seam for a future tool-level left-hand-cut flag), NOT an op knob and NOT the machine global. With climb the default, internal threads bottom-up (CCW) and external threads top-down (CW); `externalReference` stays band-placement only, orthogonal to traversal. Drill-style hole-loop centroid selection. Heights resolve per `threadKind` (ADR 0031 Amendments 4–5): INTERNAL is ALWAYS chamfer-style TOP-referenced — the reference plane sets the thread top (default the entered face) and `bottom = top - ThreadMillParams.threadDepth`, so the thread runs DOWN a hole; EXTERNAL is a top|base reference-DIRECTION toggle (`ThreadMillParams.externalReference`, default `'top'`): `'top'` is TOP-referenced (ref = boss top, thread runs DOWN from the top), `'base'` is BOTTOM-referenced (ref = boss BASE loop on the stock-top plane, `top = base + threadDepth`, the bottom-to-top helix CLIMBS UP the boss). All modes resolve one reference plane in the store (ADR 0002 names still reach the worker). The op also supports in-modal B-rep face/edge/section selection (the boss top is pickable directly in the thread op — no separate slice step). A "Thread size preset" dropdown batch-fills `majorDiameter` + `pitch` from `threadPresets.ts` (M3–M24 metric, common UNC/UNF). The thread-mill TOOL draws thread teeth + a relieved neck via `profileKind: 'thread'` / `buildThread()` (`src/lib/tool/toolProfile.ts`), the single source of truth for the 2D diagram + 3D lathe — but NOT the voxel sim, which still carves a constant crest-OD cylinder (thread-form carve deferred). Fails loud (ADR 0003, `'Thread mill:'` prefix) on pitch/major/passes/comp out of scope, top<=bottom, orphaned holes, a tool too large for the major diameter, or (internal) a tool too large for / a hole at-or-above the pre-drilled major diameter. Selection supports SMART CYLINDER-PICK (ADR 0031 Amendment 6): picking a vertical bore/boss cylindrical face (`cylinderFeatures` / the `'cylinder'` derive kind) INFERS thread kind (bore -> internal, boss -> external), diameter (nearest-snapped via `THREAD_STANDARDS` / `findThreadByMajor` / `findThreadByBore`), top plane, and a default depth; a bare 2D circle/loop is the manual fallback (`ThreadMillParams.geometrySource` `'cylinder'` vs `'loop'` drives an auto-vs-manual UI). Vertical-axis only in v1; the helix builder is unchanged. See ADR 0031. |
| Adaptive Clearing 2D | `adaptiveClearing2d/engine/` | In development (v1, wired) | FreeCAD Adaptive2d port: constant cut-area load held by a deflection-angle root-find, gyro-smoothed heading, implicit regions via an engage-walker + cleared-polygon, helix entry, keep-down/lift links, multi-depth emit. Routed store→worker→engine and creatable in the modal (Phase 6). This FreeCAD-port engine (`src/lib/cam/adaptiveClearing2d/engine/`) is THE adaptive-clearing implementation; the old state-machine planner was removed from the tree in the 2026-06-10 cleanup (docs/planning/CLEANUP-PLAN.md Stage 2). |

Pocket 2D entry placement and linking are island-safe (2026-06-10,
3efdb7a / e3544ac / f428652): the helix entry centroid is validated
against the island keep-out (toolRadius + wall stock) and relocated via
a shared candidate scan (`placeEntry`, both fill orders), degrading per
ADR 0003 (`helix_degraded_to_plunge`, loud failure) when no helix fits;
island keep-out honors wall stock symmetric with outer walls, and
overlap, lead-in, and linking endpoints are island-checked.

Operations under active development carry a per-operation `STATUS.md`
inside their submodule directory. Stable operations don't need one.

## Roadmap

The architectural improvements in flight or queued:

1. **Phase 1: Subsystem extraction ✓** — heights resolver (59b5e5f),
   feedrates resolver (6fef975), geometry primitives consolidation (24f3fb3),
   move primitives module (238f568). AC height-handling (cutZ bug, safeZ
   holdover) fixed as part of migration.
2. **Phase 2: Helix subsystem** — extract pocket's `emitHelix`, AC
   consumes it. Paired with the helix-as-default-entry milestone for AC.
3. **AC milestone work (M4 C3b/C3c)** — Phase 1 blockers resolved;
   work proceeds.
4. **DONE: Postprocessor implementation** — the postprocessor subsystem is
   built against the boundary contract defined above and ships in
   `src/lib/post/`: multi-dialect (UCCNC / GRBL / LinuxCNC), canned cycles
   (G81/G82/G83), custom program-end (see ADR 0021, PostProcessModal.tsx).
5. **Future: Recipe / template system** — saved operation sequences
   (geometry placeholders filled in per-Setup) that users apply to new
   parts instead of recreating operations from scratch. Requires
   recipe-ready operation design: params describe intent, tools supply
   physical realization. Phase 1 establishes this constraint. See
   ADR 0005.
6. **Future: Pocket ↔ AC bidirectional alignment** — extract patterns
   from each that benefit the other (engagement-aware stepover, etc.).
7. **Future: Main viewer integration** — preview adaptive toolpaths in
   the main LIENCAM viewport once AC is stable.
8. **Future: native 3D toolpaths** — the B-rep model kernel (ADR 0018)
   delivered STEP import, face/edge selection, and the derivation layer
   for 2.5D consumption; native 3D operations (parallel, waterline)
   build on that live B-rep with stable subshape identity. Not
   scheduled. Depth-aware multi-pass re-sectioning on tapered solids is
   a smaller staged extension (docs/brep/PLAN.md Stage 5, needs separate
   approval).

**The roadmap does not gate operation development on perfect subsystem
completion.** Operation work may proceed in parallel with later
subsystem extraction phases, provided new code follows the conventions
in this document and avoids introducing divergent abstractions. The
Phase 1 → AC ordering above is specific to the AC M4 case because the
height-handling bugs in AC are direct blockers for C3b; future
operations and milestones don't carry the same dependency.

See `src/lib/cam/adaptiveClearing2d/STATUS.md` Future Requirements
section for the AC-specific roadmap.

---

*Last updated: 2026-07-20 (a6832e63c; housekeeping sweep). Previously: 2026-07-04 (b89e006; added the 3D adaptive-roughing stock-outline
full-clear + corner-reach + `clearedSeed` outside-in-seed section). Previously
2026-07-02 (doc-reconciliation sweep; body verified current).
Previously 2026-06-11 (merged the Sketch subsystem and B-rep model
kernel sections onto one trunk). This document is canonical. If code
diverges, either the code should be migrated to match, or this
document should be updated with an explicit rationale for the
divergence.*
