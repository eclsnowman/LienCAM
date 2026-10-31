# Rotating the work coordinates (Angle -> rotate G54)

Operator ruling 2026-09-29 1:03 AM CT, card "Angle: rotate the work coordinates? 5 choices": "Defaults are fine - build it".
Research: `.planning/research-angle-probing-and-wcs-rotation-2026-09-29.md`. Measured LinuxCNC behaviour (the spec
below points at it): `.planning/research-linuxcnc-g10-rotation-2026-09-29.md`.

This page is the ONE place the invariants live. Every slice order points here; a slice that needs to change an
invariant stops and asks the architect.

## What the operator chose (his accepted defaults)

1. After Angle, Confirm offers "Rotate G54" by the measured angle AND shows the tap-it-square number (how far the
   face runs off over the probed length, and which way to tap).
2. LinuxCNC rotates natively (`G10 L2 P1 R..`). The AXBB-E (no interpreter) is rotated by LienCAM before the moves go
   out - including the work DRO, jogs to a work position, and probing.
3. The rotation applies to every program: LienCAM CAM programs and G-code files from Fusion alike.
4. It stays until cleared. While it is on, "G54 rotated 0.73 deg" and a Clear button are always visible.
5. The 5 deg limit on the Angle routine is removed.

## What LinuxCNC does (measured 2026-09-29 on the 2.9.4 simulator - the spec)

Full record: `.planning/research-linuxcnc-g10-rotation-2026-09-29.md` (raw runs in `.planning/linuxcnc-rotation-measure/`).
O = G54 offset, R = rotation in degrees (CCW positive seen from +Z), G = G92 offset, Rot(a)(x,y) = (x cos a - y sin a,
x sin a + y cos a):

    machine_xy = O_xy + Rot(R)(work_xy + G_xy)       machine_z = O_z + work_z + G_z
    work_xy    = Rot(-R)(machine_xy - O_xy) - G_xy   work_z    = machine_z - O_z - G_z
    G10 L20 under R:  O_xy = machine_xy - Rot(R)(W_xy)

- Rotates about the G54 origin; setting R moves nothing. `G10 L2 P1 R..` keeps X/Y/Z; a G10 without R keeps R.
- Rotated: program moves, arc centres (I/J), the G28 intermediate point, G38.x probe moves (and #5061/#5062 read in the
  rotated work frame; `probed_position` is machine), the work DRO (#5420/#5421).
- NOT rotated: G53 moves, plain G28/G30 stored points, axis/joint jogs (always along machine axes).
- R is #5230, persisted to the var file at once; survives program load, M2/M30, abort, reset, E-stop + reset, machine
  off/on. Cleared only by `G10 L2 P1 R0`.
- LinuxCNC's interpreter emits UNROTATED work coordinates; the rotation is applied in motion planning. So the AXBB-E
  bridge must apply offset + G92 AND the rotation itself.
- Not measured: rotation with a tool length offset active, or with G55-G59.3.

## Invariants (every slice)

- **LinuxCNC is the spec.** The AXBB-E route behaves the way LinuxCNC behaves with `G10 L2 P1 R` - same rotation
  centre, same sign, same effect on program moves, arcs, work DRO, jogs, probe moves, G53 and G10 L20 - as MEASURED
  on the real LinuxCNC simulator (the research file above), never as reasoned from a manual. Where the AXBB-E route
  cannot match, the slice says so in its order and asks.
- **One rotation, in the controller.** The rotation lives with the work offset in the controller (LinuxCNC's G54;
  the bridge's offset table next to its offsets). The app never ALSO rotates a program or a file - the CAM setup
  frame and `GCODE_TEXT_WORK_FRAME` stay square. A double rotation is the defect every slice tests against.
- **The sign is pinned by an outcome, not a formula.** Acceptance for any rotation path: with the part's face measured
  at angle a by the Angle routine, after Confirm a program move along work X travels ALONG that face (both probe
  touch points lie on the rotated work X line through them, residual < 0.001 mm), and running Angle again on the same
  face reads 0.000 deg. A test with exact numbers pins it (the wrong sign doubles the error).
- **Visible while on.** Whenever any WCS carries a non-zero rotation the app shows it (which WCS, the angle) with a
  Clear, on every screen that shows the work position, on both controllers, including right after connect / restart
  when the rotation came from the controller's saved state.
- **Survives like the offset does.** LinuxCNC persists R itself. The bridge keeps the rotation exactly as long as it
  keeps the work offsets (same store, same restart behaviour). Clearing = rotation 0.
- **Nothing refuses what the software can do** (rule 11). No new confirm, warning or block around rotation beyond the
  indicator the operator chose.
- **UCCNC and LinuxCNC stay separate.** The LinuxCNC slice pins UCCNC/AXBB-E behaviour unchanged and vice versa.

## Slices (one concern each; motion-critical: opus-high worker, opus audit, opus-critic review)

1. WO-2185 LinuxCNC: set / clear a WCS rotation through the gateway (`G10 L2 Pn R`, keeping X Y Z) and report it in
   status. Proven on the real simulator.
2. WO-2186 AXBB-E bridge: a rotation per WCS beside the offsets, applied on every path the offsets are applied
   (program moves, arcs, jog-to-work, probe moves, workPos), matching the measured LinuxCNC behaviour; a
   set-rotation command; status carries it. Proven on the native rehearsal kit (real Bridge.cs + SimUC100).
3. WO-2187 App: one controller call to set / clear a WCS rotation on both routes; the session holds what the
   controller reports; the always-visible "G54 rotated x deg" + Clear. No Angle change.
4. WO-2188 Angle Confirm: Confirm on Angle offers the rotation + the tap-it-square number; the 5 deg limit goes.
   Angle only (HARD LIMIT: every other routine byte-identical). After WO-2182 and WO-2187.

Before any of this reaches the machine: a native-kit rehearsal through the production buttons (Angle -> Confirm ->
corner XY -> run a square program; the cut lines up with the face) and a fresh adversarial review of the bridge diff.
