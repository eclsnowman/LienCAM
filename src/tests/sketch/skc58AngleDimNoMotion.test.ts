// WO SKC-58B -- FIX: committing the obtuse (far-sector) angle dimension
// between the X axis and a line must NOT move the line, because the obtuse
// angle already describes the current geometry.
//
// Source of truth: Operator's hands-on finding
// (coordination/findings/OPERATOR-FINDINGS-2026-07-17-angle-dim-moves-geometry.md,
// four screenshots in coordination/inbox/T-SKC56-ANGLE-DIM/). His verbatim
// bar: "a simple dimensioning task should not move the geometry unless it is
// required to solve. In this case that should not have been needed."
//
// THE ACCEPTANCE PRINCIPLE (Operator's own): a dimension whose ENTERED value
// equals the MEASURED value is a NO-MOTION constraint. Picking the obtuse
// sector of a 35deg line reads 145deg (35+145=180) -- that IS the measured
// obtuse angle of the current geometry, so committing it must not move
// anything. For ANY sector pick.
//
// THE FIX (SKC-58B, empirically validated by SKC-58's own fix-shape probe):
// selectAngleSector stores the far/obtuse value as the SIGNED directed angle
// for a REVERSED operand B (theta - sign(theta)*pi, e.g. -145deg for +35deg)
// with reverseB=true; gcsMapping's 'angle' case builds l2l_angle_pppp with
// operand B's endpoints swapped so the current geometry already satisfies the
// directed constraint. The label stays |value| = 145 (formatDimensionValue
// abs's it). One SHARED resolver, so BOTH the Part-workbench and CAM sketchers
// inherit the fix (parity cited below).
//
// This file drives the REAL injected X axis (sketchAnchors.injectSketchAnchors
// -- the same fixed construction line both hosts inject) and the REAL solver
// (planegcs via solveSketchOnWrapper). Every assertion is a can-fail gate:
//   1. ACUTE (near) pick is no-motion -- Operator's working case + the non-vacuous
//      control proving the no-motion probe passes only when nothing moves.
//   2. OBTUSE (far) pick is no-motion -- the PRIMARY ACCEPTANCE GATE (was the
//      SKC-58 `it.fails` RED repro; the fix promotes it to a plain `it`).
//   3. Sector-domain census: EVERY sector (near-CCW, far-CCW, near-CW, far-CW)
//      commits with no motion (shared-resolver law).
//   4. Edit-after-commit: the obtuse dimension still DRIVES -- a different
//      value rotates the line the short way; re-entering the measured value
//      does not move it.
//   5. In-test mutation proof: dropping reverseB (the pre-fix mapping) drags
//      the line to the supplement; restoring it is no-motion -- reverseB is
//      load-bearing (paired with the committed source-revert evidence run).

import { describe, it, expect } from 'vitest'
import { selectAngleSector } from '../../lib/sketch/tools/dimTool'
import { injectSketchAnchors, SKETCH_AXIS_X_ENTITY_ID } from '../../lib/sketch/sketchAnchors'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchLineEntity, SketchConstraint, SketchDimension, PointRef, Vec2,
} from '../../lib/sketch/types'

const THETA_DEG = 35
const LINE_LEN = 10

function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }
function deg(rad: number): number { return (rad * 180) / Math.PI }
function rad(d: number): number { return (d * Math.PI) / 180 }

/** Anchor at polar (d degrees, radius r) around the shared vertex (origin). */
function anchorAtDeg(d: number, r = 5): Vec2 {
  return { x: r * Math.cos(rad(d)), y: r * Math.sin(rad(d)) }
}

/** planegcs l2l_angle convention: the SIGNED directed angle from line1's
 *  start->end direction to line2's start->end direction (atan2(cross, dot),
 *  (-pi, pi]) -- exactly what dimTool.lineAngle documents and what the solver
 *  drives toward. This is the quantity that must NOT change for a no-motion
 *  commit. */
function directedAngle(l1: SketchLineEntity, l2: SketchLineEntity): number {
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

/**
 * Operator's scenario as a solvable sketch: the REAL fixed X axis (injected) plus
 * one free line `L` at 35deg whose start is pinned at the origin and whose
 * length is fixed by a driving distance dim -- so the ONLY remaining freedom
 * is L's rotation about the origin, which the angle dimension governs. The
 * angle dim's stored value is `angleValue` (radians), operand order (X axis,
 * L) exactly as the commit path stores it. `reverseB` is the SKC-58B
 * orientation flag: for a far/obtuse pick the value is the reversed-operand
 * signed directed angle and this is set true (gcsMapping then reverses B).
 */
function scenario(angleValue: number, reverseB = false): Sketch {
  const L: SketchLineEntity = {
    id: 'L', kind: 'line', construction: false,
    start: { x: 0, y: 0 },
    end: { x: LINE_LEN * Math.cos(rad(THETA_DEG)), y: LINE_LEN * Math.sin(rad(THETA_DEG)) },
  }
  const constraints: SketchConstraint[] = [
    { id: 'fixLstart', kind: 'fix', point: ref('L', 'start') },
  ]
  const dimensions: SketchDimension[] = [
    { id: 'lenL', kind: 'distance', driving: true, value: LINE_LEN, a: ref('L', 'start'), b: ref('L', 'end') },
    { id: 'ang', kind: 'angle', driving: true, value: angleValue, a: SKETCH_AXIS_X_ENTITY_ID, b: 'L',
      ...(reverseB ? { reverseB: true } : {}) },
  ]
  const base: Sketch = {
    id: 'sk', layerId: 'layer', entities: [L], constraints, dimensions, solveStatus: null,
  }
  // injectSketchAnchors adds the fixed X axis (SKETCH_AXIS_X_ENTITY_ID), the Y
  // axis, and the origin point -- the exact reserved geometry the live
  // sketchers inject at session entry, with originLocal (0,0).
  return injectSketchAnchors(base, { x: 0, y: 0 })
}

/** The line `L` before any solve (as drawn at THETA_DEG). */
function drawnL(sketch: Sketch): SketchLineEntity {
  return sketch.entities.find((e) => e.id === 'L') as SketchLineEntity
}

async function solveScenario(sketch: Sketch): Promise<SketchLineEntity> {
  const wrapper = await createGcsWrapper()
  const out = solveSketchOnWrapper(wrapper, sketch)
  expect(out.ok).toBe(true)
  if (!out.ok) throw new Error(`solve failed: ${out.message}`)
  return out.entities.find((e) => e.id === 'L') as SketchLineEntity
}

function endDelta(before: SketchLineEntity, after: SketchLineEntity): number {
  return Math.hypot(after.end.x - before.end.x, after.end.y - before.end.y)
}

/** Derive the committed (value, reverseB) for an anchor exactly as the real
 *  commit path does (resolveDimPlacement -> selectAngleSector). */
function sectorPick(sketch: Sketch, anchor: Vec2): { value: number; reverseB: boolean } {
  const s = selectAngleSector(sketch.entities, { a: SKETCH_AXIS_X_ENTITY_ID, b: 'L' }, anchor)!
  expect(s).not.toBeNull()
  return { value: s.value, reverseB: s.reverseB }
}

// The X axis is injected as start=(-L,0)->end=(+L,0) (direction +X), so the
// directed angle X->L for a line drawn at THETA_DEG is +THETA_DEG.
const AXIS_X_DIRECTED_THETA = THETA_DEG

describe('SKC-58B fix: obtuse angle dimension commits with NO motion (real X axis + real planegcs)', () => {
  it('premise: the injected X axis makes the directed angle X->L exactly +35deg', () => {
    const sketch = scenario(rad(THETA_DEG))
    const axisX = sketch.entities.find((e) => e.id === SKETCH_AXIS_X_ENTITY_ID) as SketchLineEntity
    expect(axisX).toBeTruthy()
    expect(axisX.kind).toBe('line')
    expect(axisX.end.x).toBeGreaterThan(axisX.start.x) // direction +X
    expect(axisX.start.y).toBe(0)
    expect(axisX.end.y).toBe(0)
    expect(deg(directedAngle(axisX, drawnL(sketch)))).toBeCloseTo(AXIS_X_DIRECTED_THETA, 6)
  })

  it('ACUTE (35deg) pick: selectAngleSector seeds theta, reverseB=false, committing does NOT move the line (working case; non-vacuous no-motion control)', async () => {
    const sketch = scenario(rad(THETA_DEG))
    const pick = sectorPick(sketch, anchorAtDeg(17)) // acute/near sector (0..35deg)
    expect(deg(pick.value)).toBeCloseTo(THETA_DEG, 6) // near sector -> raw theta
    expect(pick.reverseB).toBe(false)

    const committed = scenario(pick.value, pick.reverseB)
    const before = drawnL(committed)
    const after = await solveScenario(committed)
    const moved = endDelta(before, after)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][ACUTE] seededValueDeg=${deg(pick.value).toFixed(4)} reverseB=${pick.reverseB} ` +
      `endDeltaMm=${moved.toFixed(6)} ` +
      `endBefore=(${before.end.x.toFixed(4)},${before.end.y.toFixed(4)}) ` +
      `endAfter=(${after.end.x.toFixed(4)},${after.end.y.toFixed(4)})`)
    expect(moved).toBeLessThan(1e-6) // NO MOTION -- probe passes only when nothing moves
  })

  // ---- THE PRIMARY ACCEPTANCE GATE. Was the SKC-58 `it.fails` RED repro;
  // the SKC-58B fix promotes it to a plain passing `it`. ----
  it('OBTUSE (145deg) pick: selectAngleSector seeds the reversed-operand value with reverseB=true, committing does NOT move the line (Operator bar)', async () => {
    const sketch = scenario(rad(THETA_DEG))
    const pick = sectorPick(sketch, anchorAtDeg(100)) // obtuse/far sector (35..180deg)
    // Far value = signed reversed-operand directed angle (-145deg), |value|=145.
    expect(deg(pick.value)).toBeCloseTo(-(180 - THETA_DEG), 6)
    expect(pick.reverseB).toBe(true)

    const committed = scenario(pick.value, pick.reverseB)
    const axisX = committed.entities.find((e) => e.id === SKETCH_AXIS_X_ENTITY_ID) as SketchLineEntity
    const before = drawnL(committed)
    const after = await solveScenario(committed)
    const moved = endDelta(before, after)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][OBTUSE] seededValueDeg=${deg(pick.value).toFixed(4)} reverseB=${pick.reverseB} ` +
      `preDirectedDeg=${deg(directedAngle(axisX, before)).toFixed(4)} ` +
      `postDirectedDeg=${deg(directedAngle(axisX, after)).toFixed(4)} ` +
      `endDeltaMm=${moved.toFixed(6)} ` +
      `endBefore=(${before.end.x.toFixed(4)},${before.end.y.toFixed(4)}) ` +
      `endAfter=(${after.end.x.toFixed(4)},${after.end.y.toFixed(4)})`)
    // The obtuse angle already describes the current geometry: committing 145
    // moves nothing, and the line's directed angle X->L stays +35.
    expect(moved).toBeLessThan(1e-6) // NO MOTION -- the reported bug is fixed
    expect(deg(directedAngle(axisX, after))).toBeCloseTo(THETA_DEG, 3)
  })

  // ---- Deliverable 4: sector-domain census. selectAngleSector encodes four
  // sectors around the shared vertex (near-CCW, far-CCW, near-CW, far-CW);
  // EACH must commit with no motion under the shared resolver. ----
  it('sector-domain census: EVERY sector (near-CCW / far-CCW / near-CW / far-CW) commits with NO motion', async () => {
    const cases = [
      { name: 'near-CCW', anchorDeg: 17,  wantReverseB: false, wantAbsDeg: THETA_DEG },
      { name: 'far-CCW',  anchorDeg: 100, wantReverseB: true,  wantAbsDeg: 180 - THETA_DEG },
      { name: 'near-CW',  anchorDeg: 197, wantReverseB: false, wantAbsDeg: THETA_DEG },
      { name: 'far-CW',   anchorDeg: 290, wantReverseB: true,  wantAbsDeg: 180 - THETA_DEG },
    ]
    for (const c of cases) {
      const sketch = scenario(rad(THETA_DEG))
      const pick = sectorPick(sketch, anchorAtDeg(c.anchorDeg))
      expect(pick.reverseB).toBe(c.wantReverseB)
      expect(Math.abs(deg(pick.value))).toBeCloseTo(c.wantAbsDeg, 5) // label magnitude
      const committed = scenario(pick.value, pick.reverseB)
      const before = drawnL(committed)
      const after = await solveScenario(committed)
      const moved = endDelta(before, after)
      // eslint-disable-next-line no-console
      console.log(`[SKC-58B][CENSUS ${c.name}] seededValueDeg=${deg(pick.value).toFixed(4)} ` +
        `reverseB=${pick.reverseB} endDeltaMm=${moved.toFixed(6)}`)
      expect(moved).toBeLessThan(1e-6) // no motion for THIS sector
    }
  })

  // ---- Deliverable 5: edit-after-commit (DIRECT-SOLVER companion). The obtuse
  // dimension must remain a WORKING driving dimension -- entering a DIFFERENT
  // value rotates the line the short way for the picked sector; re-entering the
  // measured value is a no-op.
  //
  // SKC-58B-R1 Minor (this file:223): this direct-solver form constructs fresh
  // sketches per step, so it proves the solver math but NOT a host write path
  // that could drop reverseB or mishandle sequential re-entry. The REAL host
  // numeric-edit acceptance -- commitDimensionValue on the committed far dim,
  // reverseB survives the edit, the solved entities carry forward, re-entering
  // the current measured signed value is no-motion -- now runs through the CAM
  // store in camAxisAnchors.test.ts ('real-host edit-after-commit ...'). This
  // stays as the fast solver-level companion. ----
  it('edit-after-commit: the obtuse dimension still DRIVES -- a different value rotates the line, re-entering the measured value does not', async () => {
    const sketch = scenario(rad(THETA_DEG))
    const pick = sectorPick(sketch, anchorAtDeg(100)) // far: value=-145, reverseB=true
    expect(pick.reverseB).toBe(true)

    // (a) commit the measured value -> no motion (deliverable-2 result).
    const committed = scenario(pick.value, true)
    const drawn = drawnL(committed)
    const solved0 = await solveScenario(committed)
    expect(endDelta(drawn, solved0)).toBeLessThan(1e-6)

    // (b) EDIT to a DIFFERENT obtuse value: obtuse 120deg. For the reversed
    // operand the stored directed value is 120 - 180 = -120deg (|value|=120
    // for the label). The line must rotate to directed X->L = +60 (obtuse
    // 120), the SHORT way (35 -> 60, a 25deg swing on the upper side, NOT a
    // flip to the far side).
    const edited = scenario(rad(-120), true)
    const axisX = edited.entities.find((e) => e.id === SKETCH_AXIS_X_ENTITY_ID) as SketchLineEntity
    const editedBefore = drawnL(edited)
    const editedAfter = await solveScenario(edited)
    const editMoved = endDelta(editedBefore, editedAfter)
    const editedDirected = deg(directedAngle(axisX, editedAfter))
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][EDIT] newValueDeg=-120 reverseB=true movedMm=${editMoved.toFixed(6)} ` +
      `postDirectedDeg=${editedDirected.toFixed(4)}`)
    expect(editMoved).toBeGreaterThan(1) // it genuinely drives the geometry
    expect(editedDirected).toBeCloseTo(60, 2) // obtuse 120 -> directed +60
    // Short-way check: 35 -> 60 is a 25deg swing; a flip to the far side would
    // land near -60. Assert the line stayed on the +Y (upper) side.
    expect(editedAfter.end.y).toBeGreaterThan(0)

    // (c) re-enter the MEASURED value (-145) -> no motion again.
    const reentered = scenario(pick.value, true)
    const reBefore = drawnL(reentered)
    const reAfter = await solveScenario(reentered)
    expect(endDelta(reBefore, reAfter)).toBeLessThan(1e-6)
  })

  // ---- Deliverable 6 (in-test half): mutation proof. Dropping reverseB (the
  // pre-SKC-58B mapping: the signed far value fed to the DIRECTED l2l_angle_ll
  // against unchanged operands) drags the line to the supplement; restoring
  // reverseB is no-motion. reverseB is load-bearing. (Paired with the
  // committed source-revert run in coordination/evidence/SKC-58B/.) ----
  it('MUTATION PROOF: reverseB is load-bearing -- without it the obtuse value drags the line, with it there is no motion', async () => {
    const sketch = scenario(rad(THETA_DEG))
    const pick = sectorPick(sketch, anchorAtDeg(100)) // value=-145, reverseB=true

    // MUTANT (reverseB dropped): -145 fed to l2l_angle_ll(X,L) directed; the
    // geometry reads +35, so the solver rotates L to -145deg (a big move).
    const mutant = scenario(pick.value, false)
    const mBefore = drawnL(mutant)
    const mAxisX = mutant.entities.find((e) => e.id === SKETCH_AXIS_X_ENTITY_ID) as SketchLineEntity
    const mAfter = await solveScenario(mutant)
    const mMoved = endDelta(mBefore, mAfter)
    // eslint-disable-next-line no-console
    console.log(`[SKC-58B][MUTANT reverseB=false] movedMm=${mMoved.toFixed(6)} ` +
      `postDirectedDeg=${deg(directedAngle(mAxisX, mAfter)).toFixed(4)}`)
    expect(mMoved).toBeGreaterThan(1) // the pre-fix mapping MOVES the line
    expect(deg(directedAngle(mAxisX, mAfter))).toBeCloseTo(-(180 - THETA_DEG), 2) // dragged to -145

    // RESTORED (reverseB=true): no motion.
    const restored = scenario(pick.value, true)
    const rBefore = drawnL(restored)
    const rAfter = await solveScenario(restored)
    expect(endDelta(rBefore, rAfter)).toBeLessThan(1e-6)
  })
})
