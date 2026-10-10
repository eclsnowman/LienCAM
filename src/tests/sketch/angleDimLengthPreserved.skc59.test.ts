// WO SKC-59 -- FIX: editing an angle dimension's value must NOT change a
// line's LENGTH (and must never collapse it to a point) unless a constraint
// genuinely forces a length change.
//
// Source of truth: Operator's hands-on finding
// (coordination/OPERATOR-FINDINGS-2026-07-18-angledim-line-collapse.md, three
// screenshots in coordination/inbox/T-SKC58-ANGLEDIM/). His verbatim bar:
// "line length should not change unless it is critical to solve the equation."
// He edited a 143deg angle dim to 120deg and the line "shrank to a point."
//
// ROOT MECHANISM (b -- missing length preservation; bisected in the report):
// an angle dim between two lines constrains only DIRECTION, never length. A
// line whose length is otherwise free therefore has its length as a free DoF.
// The B23 free-DoF parking pass pins both endpoint COORDINATES softly at the
// as-drawn spot; pinning both equally admits a lower-error least-squares
// solution that SCALES the segment by cos(delta) (delta = angle swing) instead
// of rotating it rigidly. When delta -> 90deg, cos(delta) -> 0 and the line
// collapses to a point. Nothing anchored the length.
//
// THE FIX (gcsMapping.freeDofPinPrimitives): a line's LENGTH is a free DoF
// exactly like a circle/arc RADIUS (which is already parked), so park it with
// the SAME soft (tag -1) mechanism, over-weighted (scale) so the null-space
// minimum is a length-preserving ROTATION. Strictly lower priority than any
// hard constraint, so a driving distance dim still wins (G3). One SHARED
// resolver -> both the Part-workbench and CAM sketchers inherit the fix.
//
// This file drives the REAL injected axes (sketchAnchors.injectSketchAnchors --
// the same fixed construction lines both hosts inject) and the REAL solver
// (planegcs via solveSketchOnWrapper). Every assertion is a can-fail gate.
// The in-source mutation proof (removing the length pin) is committed under
// coordination/evidence/SKC-59/ (RED->GREEN + preimage).

import { describe, it, expect } from 'vitest'
import { measureAngleDimension, signedAngleEditValue } from '../../lib/sketch/tools/dimTool'
import {
  injectSketchAnchors, SKETCH_AXIS_X_ENTITY_ID,
} from '../../lib/sketch/sketchAnchors'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchLineEntity, SketchDimension, PointRef, Vec2,
} from '../../lib/sketch/types'

const EPS_COLLAPSE = 0.05      // mm: below this an endpoint pair is "collapsed"
const LEN_TOL = 1e-3           // mm: length-preservation tolerance

function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }
function rad(d: number): number { return (d * Math.PI) / 180 }
function deg(r: number): number { return (r * 180) / Math.PI }
function len(l: SketchLineEntity): number { return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) }
function directedAngle(l1: SketchLineEntity, l2: SketchLineEntity): number {
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

/** The signed value the REAL accept path (commitDimensionValue ->
 *  signedAngleEditValue) stores when the user types `typedMagDeg` into a dim
 *  currently at `curValueDeg`. Mirrors the store/workbench commit exactly, so a
 *  solver-level fixture proves the SAME signed convention the hosts write. */
function editedValueRad(curValueDeg: number, typedMagDeg: number, reverseB: boolean): number {
  const dim: SketchDimension = { id: 'e', kind: 'angle', driving: true, value: rad(curValueDeg),
    a: SKETCH_AXIS_X_ENTITY_ID, b: 'L', ...(reverseB ? { reverseB: true } : {}) }
  return signedAngleEditValue(dim, rad(typedMagDeg))
}

/** A FREE-FLOATING line at `thetaDeg` directed from +X (NO fix, NO length dim,
 *  start deliberately off the origin), plus a driving angle dim (axis X -> L)
 *  at the given stored value/reverseB. Length is a free DoF -- the collapse
 *  surface. */
function axisScenario(thetaDeg: number, value: number, reverseB: boolean, lenMm = 40): Sketch {
  const start: Vec2 = { x: -18, y: -7 }
  const end: Vec2 = { x: start.x + lenMm * Math.cos(rad(thetaDeg)), y: start.y + lenMm * Math.sin(rad(thetaDeg)) }
  const L: SketchLineEntity = { id: 'L', kind: 'line', construction: false, start, end }
  const dimensions: SketchDimension[] = [
    { id: 'ang', kind: 'angle', driving: true, value, a: SKETCH_AXIS_X_ENTITY_ID, b: 'L',
      ...(reverseB ? { reverseB: true } : {}) },
  ]
  const base: Sketch = { id: 'sk', layerId: 'layer', entities: [L], constraints: [], dimensions, solveStatus: null }
  return injectSketchAnchors(base, { x: 0, y: 0 })
}

/** Two FREE-FLOATING lines, A (fixed direction anchor via a horizontal draw)
 *  and L, with a driving line-to-line angle dim A->L. Neither line has a length
 *  dim, so BOTH lengths are free DoF. */
function lineToLineScenario(thetaLDeg: number, value: number, lenA = 30, lenL = 40): Sketch {
  const A: SketchLineEntity = { id: 'A', kind: 'line', construction: false,
    start: { x: 5, y: 5 }, end: { x: 5 + lenA, y: 5 } } // horizontal (dir 0)
  const startL: Vec2 = { x: -10, y: 12 }
  const L: SketchLineEntity = { id: 'L', kind: 'line', construction: false,
    start: startL, end: { x: startL.x + lenL * Math.cos(rad(thetaLDeg)), y: startL.y + lenL * Math.sin(rad(thetaLDeg)) } }
  const dimensions: SketchDimension[] = [
    { id: 'ang', kind: 'angle', driving: true, value, a: 'A', b: 'L' },
  ]
  const base: Sketch = { id: 'sk', layerId: 'layer', entities: [A, L], constraints: [], dimensions, solveStatus: null }
  return injectSketchAnchors(base, { x: 0, y: 0 })
}

function findLine(s: SketchLineEntity[] | { entities: unknown[] }, id: string): SketchLineEntity {
  const arr = Array.isArray(s) ? s : (s.entities as SketchLineEntity[])
  return arr.find((e) => (e as SketchLineEntity).id === id) as SketchLineEntity
}

async function solve(sketch: Sketch): Promise<SketchLineEntity[]> {
  const wrapper = await createGcsWrapper()
  const out = solveSketchOnWrapper(wrapper, sketch)
  expect(out.ok, out.ok ? '' : (out as { message: string }).message).toBe(true)
  if (!out.ok) throw new Error(out.message)
  return out.entities as SketchLineEntity[]
}

async function solveWithStatus(sketch: Sketch): Promise<{ entities: SketchLineEntity[]; dof: number }> {
  const wrapper = await createGcsWrapper()
  const out = solveSketchOnWrapper(wrapper, sketch)
  expect(out.ok, out.ok ? '' : (out as { message: string }).message).toBe(true)
  if (!out.ok) throw new Error(out.message)
  return { entities: out.entities as SketchLineEntity[], dof: out.status.dof }
}

describe('SKC-59: an angle-value edit preserves line length (no collapse)', () => {
  // ---- R1 / G2: THE Operator repro, faithful far/obtuse sector, END-TO-END through
  // the REAL signed accept convention. A line directed +37deg carries an
  // obtuse-sector angle dim reading 143 (SKC-58B: value=-143deg, reverseB=true).
  // Operator types 120 into the value box. PRE-FIX (mechanism b) the line collapsed
  // to a point; PRE-R1 (blocker C1) the b-fix stopped the collapse but the raw
  // +120 write flipped the line to the MIRROR branch (directed -60). POST-R1 the
  // shared signedAngleEditValue stores -120, so the line rotates the SHORT way on
  // the SAME sector to directed +60 at full length and the label still reads 120.
  it('R1 Operator case: far-sector 143deg edited to 120deg rotates to +60 on the SAME side at full length (no collapse, no mirror flip)', async () => {
    const created = axisScenario(37, rad(-143), true, 40)
    const before = findLine(created, 'L')
    const solvedCreate = await solve(created)
    // Creation is no-motion (SKC-58B): the line is still length 40 at 37deg.
    expect(len(findLine(solvedCreate, 'L'))).toBeCloseTo(40, 3)

    // The edit through the REAL signed accept path: typed 120 on a dim at
    // -143/reverseB=true stores -120 (NOT +120), reverseB retained.
    const storedValue = editedValueRad(-143, 120, true)
    expect(deg(storedValue)).toBeCloseTo(-120, 6) // signed convention preserved (was +120 = the bug)
    const edited = axisScenario(37, storedValue, true, 40)
    const axisX = findLine(edited, SKETCH_AXIS_X_ENTITY_ID)
    const solved = await solve(edited)
    const solvedL = findLine(solved, 'L')
    const endDist = len(solvedL)
    const directed = deg(directedAngle(axisX, solvedL))
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][R1] beforeLen=${len(before).toFixed(4)} afterLen=${endDist.toFixed(4)} ` +
      `directedDeg=${directed.toFixed(3)} (intended +60, mirror -60)`)
    expect(endDist).toBeGreaterThan(EPS_COLLAPSE)   // NOT collapsed to a point (mechanism b)
    expect(endDist).toBeCloseTo(40, 3)              // length preserved (Operator's bar)
    expect(directed).toBeCloseTo(60, 2)             // SAME sector, short-way rotation (blocker C1) -- NOT the -60 mirror
    // Displayed label is |value| -- still reads 120 to the user.
    expect(Math.abs(deg(storedValue))).toBeCloseTo(120, 6)
  })

  // ---- R1b: PURE mechanism (b), no reverseB confound. A near-sector line at
  // 143deg edited to 53deg is a 90deg swing -> cos(delta)=0 -> the unpinned
  // solver collapses it. This is the cleanest length-collapse repro (no
  // sector/sign involvement at all). ----
  it('R1b pure-(b): near-sector 143deg edited to 53deg (90deg swing) does NOT collapse', async () => {
    const edited = axisScenario(143, rad(53), false, 40)
    const axisX = findLine(edited, SKETCH_AXIS_X_ENTITY_ID)
    const solved = await solve(edited)
    const solvedL = findLine(solved, 'L')
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][R1b] afterLen=${len(solvedL).toFixed(4)} directedDeg=${deg(directedAngle(axisX, solvedL)).toFixed(3)}`)
    expect(len(solvedL)).toBeGreaterThan(EPS_COLLAPSE)
    expect(len(solvedL)).toBeCloseTo(40, 3)                        // length preserved
    expect(deg(directedAngle(axisX, solvedL))).toBeCloseTo(53, 2)  // target achieved
  })

  // ---- G1: regression table across magnitudes and directions (near sector,
  // reverseB=false, so typed value == directed angle == measured). Each row
  // asserts: target angle achieved AND length preserved AND no endpoint
  // collapse. ----
  const G1_ROWS: Array<{ name: string; from: number; to: number }> = [
    { name: 'small +delta',            from: 40,  to: 47 },
    { name: 'small -delta',            from: 40,  to: 33 },
    { name: 'large +delta (>20)',      from: 30,  to: 70 },
    { name: 'large -delta (>20)',      from: 150, to: 110 },
    { name: 'crossing 90 downward',    from: 143, to: 53 },   // 90deg swing (worst case)
    { name: 'crossing 90 upward',      from: 40,  to: 130 },
    { name: 'obtuse->acute (Operator mag)',from: 143, to: 120 },  // near-sector 143->120
    { name: 'acute->obtuse',           from: 35,  to: 160 },
    { name: 'near-flip large swing',   from: 20,  to: 175 },
  ]
  for (const r of G1_ROWS) {
    it(`G1 [${r.name}] ${r.from}deg -> ${r.to}deg: angle achieved, length preserved, no collapse`, async () => {
      const edited = axisScenario(r.from, rad(r.to), false, 40)
      const axisX = findLine(edited, SKETCH_AXIS_X_ENTITY_ID)
      const solved = await solve(edited)
      const solvedL = findLine(solved, 'L')
      const gotLen = len(solvedL)
      const gotDeg = deg(directedAngle(axisX, solvedL))
      // eslint-disable-next-line no-console
      console.log(`[SKC-59][G1 ${r.name}] len=${gotLen.toFixed(4)} directedDeg=${gotDeg.toFixed(3)} (target ${r.to})`)
      expect(gotLen).toBeGreaterThan(EPS_COLLAPSE)          // never a point
      expect(gotLen).toBeCloseTo(40, 2)                     // length preserved (<0.01mm)
      expect(Math.abs(gotLen - 40)).toBeLessThan(LEN_TOL * 40) // tight bar
      expect(gotDeg).toBeCloseTo(r.to, 2)                   // target angle achieved
    })
  }

  // ---- G1b: line-to-line angle dim (both lines free). Editing the angle must
  // preserve BOTH lengths and collapse neither. ----
  it('G1b line-to-line: editing the angle preserves BOTH line lengths, no collapse', async () => {
    // A is horizontal (dir 0), L drawn at 143deg; edit the A->L angle to 60deg.
    const edited = lineToLineScenario(143, rad(60), 30, 40)
    const solved = await solve(edited)
    const a = findLine(solved, 'A'), l = findLine(solved, 'L')
    const measured = deg(directedAngle(a, l))
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][G1b] lenA=${len(a).toFixed(4)} lenL=${len(l).toFixed(4)} directedA->L=${measured.toFixed(3)}`)
    expect(len(a)).toBeGreaterThan(EPS_COLLAPSE)
    expect(len(l)).toBeGreaterThan(EPS_COLLAPSE)
    expect(len(a)).toBeCloseTo(30, 2)   // A length preserved
    expect(len(l)).toBeCloseTo(40, 2)   // L length preserved
    expect(measured).toBeCloseTo(60, 2) // target achieved
  })

  // ---- G3: a HARD length change still wins. When a line ALSO carries a
  // driving distance dim, the solver honors BOTH: the length becomes the
  // dimensioned value (soft pin never blocks a genuine constraint-forced
  // change), and the angle is achieved. ----
  it('G3 fully-constrained: a driving distance dim=50 stretches the line while the angle rotates it', async () => {
    const L: SketchLineEntity = { id: 'L', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 40 * Math.cos(rad(143)), y: 40 * Math.sin(rad(143)) } }
    const dims: SketchDimension[] = [
      { id: 'len', kind: 'distance', driving: true, value: 50, a: ref('L', 'start'), b: ref('L', 'end') },
      { id: 'ang', kind: 'angle', driving: true, value: rad(120), a: SKETCH_AXIS_X_ENTITY_ID, b: 'L' },
    ]
    const base: Sketch = { id: 'sk', layerId: 'ly', entities: [L],
      constraints: [{ id: 'fx', kind: 'fix', point: ref('L', 'start') }], dimensions: dims, solveStatus: null }
    const sketch = injectSketchAnchors(base, { x: 0, y: 0 })
    const axisX = findLine(sketch, SKETCH_AXIS_X_ENTITY_ID)
    const solved = await solve(sketch)
    const solvedL = findLine(solved, 'L')
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][G3] len=${len(solvedL).toFixed(4)} (hard dim 50) directedDeg=${deg(directedAngle(axisX, solvedL)).toFixed(3)}`)
    expect(len(solvedL)).toBeCloseTo(50, 2)                        // HARD length wins over the soft pin
    expect(deg(directedAngle(axisX, solvedL))).toBeCloseTo(120, 2) // angle still achieved
  })

  // ---- G3b (C5): PARTIALLY-constrained. A HARD length dim=55 pins the
  // angle-edited line's length while an UNRELATED free line leaves global
  // DoF > 0, so the phase-2 free-DoF PARKING pass genuinely RUNS (it is gated
  // on status.dof > 0). The hard length must still win over the soft length pin
  // IN AN ACTIVE parking pass (not a vacuous dof==0 fixture), and the unrelated
  // free line's own length is preserved BY that pass -- proving the pin is live,
  // not that parking was skipped. ----
  it('G3b partially-constrained: hard length dim beats the soft pin while phase-2 parking is ACTIVE (dof>0)', async () => {
    // Dimensioned line: fixed start, hard length 55, angle 120 -> length must be 55.
    const L: SketchLineEntity = { id: 'L', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 40 * Math.cos(rad(143)), y: 40 * Math.sin(rad(143)) } }
    // UNRELATED free line: no fix, no dims -> its two endpoints are free DoF, so
    // global dof > 0 and the parking pass runs. The soft pin should preserve its
    // 25mm length.
    const FREE: SketchLineEntity = { id: 'FREE', kind: 'line', construction: false,
      start: { x: -30, y: -25 }, end: { x: -30 + 25 * Math.cos(rad(200)), y: -25 + 25 * Math.sin(rad(200)) } }
    const dims: SketchDimension[] = [
      { id: 'len', kind: 'distance', driving: true, value: 55, a: ref('L', 'start'), b: ref('L', 'end') },
      { id: 'ang', kind: 'angle', driving: true, value: rad(120), a: SKETCH_AXIS_X_ENTITY_ID, b: 'L' },
    ]
    const base: Sketch = { id: 'sk', layerId: 'ly', entities: [L, FREE],
      constraints: [{ id: 'fx', kind: 'fix', point: ref('L', 'start') }], dimensions: dims, solveStatus: null }
    const sketch = injectSketchAnchors(base, { x: 0, y: 0 })
    const axisX = findLine(sketch, SKETCH_AXIS_X_ENTITY_ID)
    const beforeFreeLen = len(FREE)
    const { entities, dof } = await solveWithStatus(sketch)
    const solvedL = findLine(entities, 'L')
    const solvedFree = findLine(entities, 'FREE')
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][G3b] dof=${dof} lenL=${len(solvedL).toFixed(4)} (hard 55) ` +
      `directedDeg=${deg(directedAngle(axisX, solvedL)).toFixed(3)} freeLen=${len(solvedFree).toFixed(4)}`)
    expect(dof).toBeGreaterThan(0)                                 // phase-2 parking pass genuinely ran
    expect(len(solvedL)).toBeCloseTo(55, 2)                        // HARD length wins IN an active parking pass
    expect(deg(directedAngle(axisX, solvedL))).toBeCloseTo(120, 2) // angle still achieved
    expect(len(solvedFree)).toBeCloseTo(beforeFreeLen, 2)          // soft pin live: unrelated free length preserved
  })

  // ---- NON-VACUOUS control: the assertions above pass ONLY when the line both
  // ROTATES (endpoints genuinely move) AND keeps its length. Prove the harness
  // detects motion: a large near-sector edit moves an endpoint well past any
  // noise floor while length stays 40. A do-nothing solver would fail the
  // motion assertion; a collapsing solver would fail the length assertion. ----
  it('non-vacuous: a 40->130deg edit MOVES the endpoints (genuine rotation) yet preserves length', async () => {
    const before = axisScenario(40, rad(40), false, 40) // measured==stored: no-motion seed
    const beforeL = findLine(before, 'L')
    const edited = axisScenario(40, rad(130), false, 40)
    const solved = await solve(edited)
    const solvedL = findLine(solved, 'L')
    const endMoved = Math.hypot(solvedL.end.x - beforeL.end.x, solvedL.end.y - beforeL.end.y)
    // eslint-disable-next-line no-console
    console.log(`[SKC-59][non-vacuous] endMoved=${endMoved.toFixed(4)}mm len=${len(solvedL).toFixed(4)}`)
    expect(endMoved).toBeGreaterThan(5)     // genuine rotation, not a no-op
    expect(len(solvedL)).toBeCloseTo(40, 2) // length preserved through the big move
  })

  it('premise: directedAngle + measureAngleDimension agree on a drawn 143deg near-sector line', () => {
    const s = axisScenario(143, rad(143), false, 40)
    const axisX = findLine(s, SKETCH_AXIS_X_ENTITY_ID)
    expect(deg(directedAngle(axisX, findLine(s, 'L')))).toBeCloseTo(143, 6)
    const m = measureAngleDimension(s.entities, s.dimensions[0])
    expect(m).not.toBeNull()
    // near-sector measure of a 143deg line reads 143 with reverseB=false
    expect(Math.abs(deg(m!.value))).toBeCloseTo(143, 4)
  })

  // ---- G1-FAR (C2): reverseB=true far/obtuse-sector rows across magnitude
  // classes and BOTH directions. Each edits a typed MAGNITUDE through the real
  // signed accept convention (editedValueRad, the exact signedAngleEditValue
  // both hosts call) and asserts the FINAL SIGNED direction lands on the SAME
  // side as the as-drawn line -- NOT the -mirror branch a raw magnitude write
  // produced (blocker C1). For a line drawn at directed theta, the far/obtuse
  // label M places the line at directed sign(theta)*(180-M); displayed label is
  // |storedValue| = M; length preserved (well-posed single line vs the fixed
  // injected axis -- the collapse/mirror surface, not the underdetermined
  // line-to-line one). Placed last so the pre-existing tests' solver warm-up
  // order is byte-identical to the committed file. ----
  const G1_FAR_ROWS: Array<{ name: string; thetaDeg: number; typedMag: number; expectDirected: number }> = [
    // theta>0 (above axis) -- storedValue negative, line stays ABOVE the axis.
    { name: 'Operator far obtuse->obtuse',    thetaDeg: 37,  typedMag: 120, expectDirected: 60 },   // 180-120
    { name: 'far small delta (143->138)', thetaDeg: 37,  typedMag: 138, expectDirected: 42 },
    { name: 'far large delta (160->100)', thetaDeg: 20,  typedMag: 100, expectDirected: 80 },
    { name: 'far near-90 (100->150)',     thetaDeg: 80,  typedMag: 150, expectDirected: 30 },
    // theta<0 (below axis) -- storedValue positive, line stays BELOW the axis.
    { name: 'far below-axis (143->120)',  thetaDeg: -37, typedMag: 120, expectDirected: -60 },
    { name: 'far below large (160->110)', thetaDeg: -20, typedMag: 110, expectDirected: -70 },
  ]
  for (const r of G1_FAR_ROWS) {
    it(`G1-FAR [${r.name}] line@${r.thetaDeg}deg, typed ${r.typedMag}deg -> directed ${r.expectDirected}deg (same side, no mirror), length preserved`, async () => {
      const farInitialDeg = r.thetaDeg - Math.sign(r.thetaDeg) * 180 // as-drawn far value (signed)
      const storedValue = editedValueRad(farInitialDeg, r.typedMag, true)
      // Signed convention: sign matches the as-drawn far value (NOT the raw typed +mag).
      expect(Math.sign(deg(storedValue))).toBe(Math.sign(farInitialDeg))
      expect(Math.abs(deg(storedValue))).toBeCloseTo(r.typedMag, 6) // label still reads the typed magnitude
      const edited = axisScenario(r.thetaDeg, storedValue, true, 40)
      const axisX = findLine(edited, SKETCH_AXIS_X_ENTITY_ID)
      const solved = await solve(edited)
      const solvedL = findLine(solved, 'L')
      const gotLen = len(solvedL)
      const gotDeg = deg(directedAngle(axisX, solvedL))
      // eslint-disable-next-line no-console
      console.log(`[SKC-59][G1-FAR ${r.name}] len=${gotLen.toFixed(4)} directedDeg=${gotDeg.toFixed(3)} ` +
        `(intended ${r.expectDirected}, mirror ${-r.expectDirected})`)
      expect(gotLen).toBeGreaterThan(EPS_COLLAPSE)                 // never a point
      expect(gotLen).toBeCloseTo(40, 2)                           // length preserved
      expect(gotDeg).toBeCloseTo(r.expectDirected, 2)             // SAME side (signed) -- NOT the -mirror
      expect(Math.sign(gotDeg)).toBe(Math.sign(r.thetaDeg))       // never flipped across the axis
    })
  }
})
