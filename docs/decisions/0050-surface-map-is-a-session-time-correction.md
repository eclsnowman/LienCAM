# ADR-0050: The surface map is a session-time correction owned by the machine session

Date: 2026-09-22
Status: Accepted 2026-09-22 as a RATIFICATION of shipped code (WO-1821). Sections
1-4 record what `ea13a854b` (2026-08-14) already built. Section 5 is the one
decision this ADR makes; it is decide-and-log (LIENCAM.md rule 3) and the operator may
reverse it.
Relates to: ADR-0041 (controllers are backends), ADR-0043 (the live program
builder owns the geometry path; Amendments 2, 3 and 4), ADR-0003 (no silent
fallbacks), WO-1817 (probe calibration), WO-1822 (the gap-fill this ADR scopes).

## the operator's words

Operator ruling 2026-08-09 (`docs/archive/FEATURE-HITLIST-2026-07-21.md`, "Probing -
advanced capabilities"), verbatim:

*"SURFACE/FLATNESS MAPPING producing a coordinate transform applied during
cutting - the PCB-milling case ... A silent wrong Z here ruins a board or breaks
a cutter, so a stale map must be loud."*

## Context

The 2026-09-21 miss-recon filed this order as "who should own the surface-map
transform" on the premise that nothing had been built. That premise was false.
Commit `ea13a854b` ("feat(control): add surface mesh compensation",
2026-08-14) shipped the whole text-route feature:

- `src/lib/machine/zSurfaceMesh.ts` - planning (`planSurfaceMesh`), the grid
  (`buildSurfaceMeshPoints`), the transform (`surfaceCompensationAt`: bilinear
  inside the measured rectangle, smoothstep fade to zero over `fadeMm` outside
  it), the program identity (`fingerprintProgram`, FNV-1a over the loaded text)
  and the compiler (`compileSurfaceCompensatedProgram`).
- `src/lib/machine/machineSession.ts` - the probe cycle
  (`runSurfaceMeshProbeCycle`) and the arm (`loadMachineProgram`, the
  `armedMesh` / `meshWcsError` / `meshCompileError` block).
- `src/store/machineControlStore.ts` - `surfaceMesh: SurfaceMeshMap | null`.
- UI: `ProbingPanel.tsx` (plan, probe, disable), `MeshViewerModal.tsx` (the
  flatness view), `ProgramPanel.tsx` (the "Mesh NxM" badge).
- Tests: `src/tests/machine/zSurfaceMesh.test.ts`,
  `zSurfaceMeshPanel.test.tsx`, `zSurfaceMeshRunner.test.ts`,
  `meshViewer.wo416.test.tsx`.

ADR-0043 already leans on it: Amendment 2 cites `meshWcsError` as the prior art
for geometry-program invalidation, and its Consequences list surface-mesh
compensation among the text-shaped features that "need an id-shaped twin before
the geometry path is at parity". What was missing was a document that says who
owns the map, what kills it, and what the geometry route is supposed to do about
it. This is that document. It was written from the source, not from the recon.

## Decision

### 1. Who applies the map: the machine session, at load, never the post

The correction is applied at SESSION TIME. When an active mesh is armed,
`loadMachineProgram` (machineSession.ts, the `armedMesh` block) runs
`compileSurfaceCompensatedProgram` over the loaded text and hands the controller
the compiled `StreamLine[]` through `loadPreparedJob`. Each compiled line keeps
its ORIGINAL source line as its id, so the readout and the job cursor still
point at the operator's file.

The file postprocessor never sees the map. A posted file is the uncorrected
program; the correction exists only between "loaded" and "sent". This is
correct and stays: the map is a measurement of THIS stock on THIS machine at
THIS moment, and a post-time bake would write a physical measurement into an
artifact that outlives it - the stale-map failure the operator named, made permanent.

Ownership, by layer:

| Concern | Owner |
| --- | --- |
| The math (interpolate, fade, subdivide, refuse unsupported modal state) | `zSurfaceMesh.ts` - pure, no store, no controller |
| Measuring the map (probe grid, point 1 becomes work Z0) | `runSurfaceMeshProbeCycle` in `machineSession.ts` |
| Holding the map | `useMachineControl().surfaceMesh` |
| Applying it to what the controller runs | the session's program load (`loadMachineProgram` today) |
| Showing it | `ProgramPanel` badge + readiness text, `MeshViewerModal`, console |

### 2. What the map is, and where it lives

`SurfaceMeshMap` in the machine-control store: the measured `bounds`, the
`cutBounds` it was planned for, `pointsX` x `pointsY` samples in MACHINE Z,
`referenceMachineZ` (sample 1, which the cycle also writes as work Z0),
`fadeMm`, and its identity - `sourceFingerprint` (the loaded text),
`sourceName`, `workOffset` (G54..G59 by name), `probedAt`, `active`.

It is session state and is not persisted. A map never survives a disconnect or
a reload of the app. That is ratified, not a gap: a map outliving the session
that measured it is exactly a stale map.

### 3. What already invalidates it (shipped and enforced)

1. **Program text changed.** `compileSurfaceCompensatedProgram` refuses on a
   fingerprint mismatch ("The loaded program changed after this mesh was
   probed"), and `setProgram` in the store drops the map whenever the text
   differs (`surfaceMesh: sameText ? s.surfaceMesh : null`).
2. **Work offset changed by name.** `loadMachineProgram` refuses to arm when
   `armedMesh.workOffset !== activeWcs` ("The active work offset changed from
   G54 to G55. Probe a new mesh."), and the compiler refuses a program that
   selects any other G54-G59.
3. **Cut outside the measured area.** Planning refuses a mesh that does not
   cover every cutting move; the compiler refuses a program whose cut bounds
   leave the mesh. Rapids outside it fade to zero correction and never create
   a Z shelf.
4. **Mesh inactive or incomplete.** The compiler refuses both. The operator's
   disable (`ProbingPanel.disableSurfaceMesh`) clears the map, says so on the
   console and re-arms the ORIGINAL program in its own words.
5. **Disconnect.** The store clears `surfaceMesh` on `disconnected`.
6. **A new probe cycle.** The old map and the send queue are disarmed BEFORE
   the first move; only a complete new grid re-arms. A cycle that fails at any
   point leaves nothing armed.
7. **Fail closed.** A compile or controller refusal loads nothing; the
   uncorrected program is never armed as a fallback while the operator expects
   compensation (ADR-0003).
8. **Features that cannot honour it refuse, by name.** Run-from-line and Step
   Back refuse while a mesh is active; the path-fidelity check refuses to score
   a compensated program and says why.
9. **Loud when active.** Readiness reads "Surface mesh compensation is ACTIVE
   (N compensated motion blocks)", the Program panel shows "Mesh NxM", and the
   console logs the arm.
10. **Modal states it cannot reinterpret.** G20, G91, G18/G19/G53/G92/G93,
    rotary/auxiliary axes, and motion sharing a line with M/S/T are refused
    before any probing (the cycle preflights the compiler on a flat dummy map).

### 4. What the operator's ask names that the shipped code does NOT enforce (named gaps)

These are gaps, not omissions. WO-1822 owns them.

- **G1. The geometry route has no mesh at all - and it is the operator's machine.** The
  AXBB-E / UCCNC backend declares `gcodeText: false` and has no
  `loadPreparedJob`, so every load on it goes through `loadGcodeTextToolpathProgram`,
  `loadSetupToolpathProgram` or `loadGeometryProgram`. Those call
  `setProgram(name, null, ...)`: the store's `programText` becomes null, which
  drops any map, and `planSurfaceMesh(programText)` then refuses with "Load a
  program to derive the active cutting area." The feature is unreachable, not
  silently wrong - but it does not exist on the one machine we own. This is the
  ADR-0043 Amendment 3 defect exactly: a guard (here, a whole correction) the
  first route has and the second route lacks.
- **G2. Work offset VALUE changes are not seen.** Only the offset's NAME is
  compared. Re-zeroing X/Y/Z on the same G54 (or a G10 write to it) after
  mapping moves the program relative to the measured surface and the map stays
  armed. The check also runs only inside `loadMachineProgram`, not when the
  offset changes under an already-armed job.
- **G3. Part moved, offsets untouched.** Software cannot see a board that was
  bumped on the table. The honest remedy is loud provenance (the map's age and
  source on the badge) and a cheap spot-check probe at one mapped point that
  refuses on disagreement beyond a bound - not a silent assumption either way.
- **G4. Fixture or setup edit with identical text.** The identity is the text
  fingerprint only. Re-posting byte-identical text after moving the part in the
  setup keeps the map. `ProgramContextV1` already binds a load to its setup;
  the map's identity should include it where a context exists.
- **G5. No stated precision (WO-1817).** Samples come from the established
  two-pass Z touch with no recorded trigger repeatability. A surface touch is
  largely insensitive to tip diameter, but the map's worst-case error is bounded
  by repeatability, and for a 0.1 mm PCB isolation cut that bound is the
  product. Once WO-1817 states it, `SurfaceMeshMap` records it and the readout
  shows it.
- **G6. A multi-tool text program cannot be compensated (read from source;
  WO-1822 must pin it with a test first).** `loadMachineProgram` compiles
  `stageRunningM6Holds(text)`, which rewrites every M6 reached after motion to
  M0. The mesh's `sourceFingerprint` is taken from the UNSTAGED text in
  `runSurfaceMeshProbeCycle`, and that function's preflight also compiles the
  unstaged text - so the preflight passes, the whole grid is probed, and the
  final arm refuses with "The loaded program changed after this mesh was
  probed." Fail-closed, so no wrong Z reaches the board, but the message is
  false and drill-then-mill PCB jobs are exactly multi-tool.
- **G7. Rule 11 refusals.** G20 (inch) and G91 (incremental) programs, and
  motion sharing a line with M/S/T, are refused though the software can convert
  and split them itself. Under LIENCAM.md rule 11 these are premises to remove,
  not messages to soften. G18/G19 arcs and rotary axes are genuine limits of a
  Z-in-XY map and stay refused.

### 5. The one real decision: the geometry route gets its own consumer of the same math

**Question** (ADR-0043 reconciliation): is the text route the long-term owner of
compensation, or does the geometry path (`MachineProgram`,
`buildMachineProgram`, the interpreted file route of ADR-0043 Amendment 4) need
its own consumer?

**Decided: the geometry route gets its own consumer, and the math stays one
copy.** Each program route applies the map at its own load, in the session,
through the functions in `zSurfaceMesh.ts`. The geometry consumer corrects the
work-frame motion steps (lines only first - ADR-0043's first slice is lines,
and `compileSurfaceCompensatedProgram` already emits only G1/G0 lines, since
arcs are tessellated by `buildPreviewModel`) AFTER the program is built or
interpreted and BEFORE `loadProgram`. The bridge's load-time work->machine
resolve and soft-limit check (ADR-0043 Amendment 2) then checks the CORRECTED
coordinates, which is the order we want: a correction that pushes a move past a
limit is refused before anything moves.

**Why, and why not the alternatives:**

- *Text route only, forever.* Rejected. The flagship controller has no text
  route (ADR-0043 Amendment 4), so "text only" means the PCB case never runs on
  the only machine we can verify it on (ADR-0048's tier table). Amendment 3
  makes a route that lacks the first route's correction a defect on that route.
- *Bake it into the post / the `MachineProgram` builder.* Rejected for the
  reason in section 1: the builder produces a program from a setup; the map is a
  measurement of the stock now. `buildMachineProgram` stays measurement-free,
  exactly as ADR-0043's live builder "may read ControllerCapabilities and
  nothing else about the machine it is building for".
- *Push the map to the bridge and correct on the wire.* Rejected: the bridge
  would then own a second copy of the interpolation, and the readout, the path
  preview and the soft-limit resolve would all disagree with what the board
  flies (ADR-0041: the app speaks, controllers are backends).

**No new capability flag.** Whether compensation is possible is already
answered by whether the route exists: `loadPreparedJob` on the text route,
`capabilities.machineProgram` + `loadProgram` on the geometry route. "Text-route
only" today is an UNEXPLORED limit, not a real one - the correction is a pure
function of work-frame XY, which both routes have. Until G1 lands, the geometry
route must say plainly that surface compensation is not built for it yet
(rule 11: the software cannot do it yet, so it says so; it does not pretend).

**Identity on the geometry route.** The text fingerprint has nothing to hash
when `programText` is null. The geometry consumer keys the map to the staged
program's own identity (its step list, or the `ProgramContextV1` that built it)
plus the work offset, and G2/G4 are closed on BOTH routes by the same key.

## Alternatives considered

Covered in section 5. The pre-existing design choices (session-time, not
post-time; fail closed; point 1 is Z0; fade instead of clamp at the boundary)
are ratified, not reopened.

## Consequences

- WO-1822's premise "no code exists" is withdrawn; it is a gap-fill of G1-G7.
- WO-1822's owned-paths are incomplete as filed. The work touches:
  - `src/lib/machine/zSurfaceMesh.ts` - identity beyond the text fingerprint
    (G4, geometry key), offset value in the identity (G2), precision field
    (G5), inch/incremental/split handling (G7), a step-list compensator for the
    geometry route sharing `surfaceCompensationAt` (G1).
  - `src/lib/machine/machineSession.ts` - `loadMachineProgram` (G6: fingerprint
    the text the compiler actually receives, or compile the source and stage
    after), `runSurfaceMeshProbeCycle` (G6 preflight, G5, geometry-route
    planning input), `loadGcodeTextToolpathProgram`, `loadSetupToolpathProgram`,
    `loadSetupsToolpathProgram`, `loadGeometryProgram` (G1 consumer, G2 check),
    and the Run-from-line / Step Back refusals so they cover geometry-route
    meshes too.
  - `src/store/machineControlStore.ts` - NOT in WO-1822's owned-paths today: the
    `setProgram` rule that drops the map on a null text must learn the geometry
    identity (G1), and an offset-value change must drop or flag the map (G2).
  - `src/components/machine/ProbingPanel.tsx` - planning from a staged geometry
    program when `programText` is null (G1), spot-check probe (G3).
  - `src/components/machine/ProgramPanel.tsx` - NOT in WO-1822's owned-paths:
    the badge shows map age and precision (G3, G5).
  - `src/components/machine/MeshViewerModal.tsx` - precision in the viewer (G5).
  - Tests: extend the existing `zSurfaceMesh.test.ts`,
    `zSurfaceMeshRunner.test.ts`, `zSurfaceMeshPanel.test.tsx`, plus the new
    `surfaceMap.wo1822.test.ts`. G1 needs ADR-0043 Amendment 3's instrument:
    one fixture through both routes, compared move for move after correction.
- WO-1822 should be sliced (single-concern orders): G6 alone (small, proof
  first), G2+G4 (identity), G7 (rule 11), G1 (the geometry consumer - the large
  one, and the one that makes the feature exist on the operator's machine), G3+G5
  (provenance and precision, G5 after WO-1817).
- WO-1822 depends on this ADR in its accepted state; its depends-on is
  satisfied by this file.
- Hardware: any G1 claim is verified on the AXBB-E by readback, not by a green
  test (the machine-seat rule). Until then the geometry consumer is
  simulator-verified and says so.

## References

- `ea13a854b` feat(control): add surface mesh compensation (2026-08-14)
- `src/lib/machine/zSurfaceMesh.ts` (`surfaceCompensationAt`,
  `compileSurfaceCompensatedProgram`, `fingerprintProgram`, `planSurfaceMesh`)
- `src/lib/machine/machineSession.ts` (`loadMachineProgram`,
  `stageRunningM6Holds`, `runSurfaceMeshProbeCycle`,
  `loadGcodeTextToolpathProgram`, run-from-line and Step Back mesh refusals)
- `src/store/machineControlStore.ts` (`surfaceMesh`, `setProgram`, disconnect
  reset)
- `src/components/machine/ProbingPanel.tsx`, `ProgramPanel.tsx`,
  `MeshViewerModal.tsx`
- ADR-0043 Amendments 2, 3, 4; ADR-0048 (verification tiers); ADR-0041
- WO-1817 (calibration), WO-1822 (gap-fill)
