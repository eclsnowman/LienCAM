// ============================================================
// WO-299: the postprocessor honours a work coordinate system rotated about Z
// ============================================================
// Covers the two defects the work order names:
//   1. emit.ts's arc centre offsets (I/J) now rotate through the same WCS
//      basis the endpoint gets, instead of being taken straight from world
//      coordinates (frame-invariant only under an identity basis).
//   2. validate.ts's detectRotatedWcs narrows from "any rotation is an
//      error" to "a pure rotation about Z is accepted; a tilt, a
//      non-orthonormal basis, or a mirrored basis are refused."
// Every number below is derived by hand against the stated formula
// (work = R^T * delta) so a sign flip, an axis swap, or a reversion to the
// old un-rotated I/J would fail these assertions, not just "differ".

import { describe, it, expect } from 'vitest'
import { emitProgram } from '../../lib/post/emit'
import { postProgram } from '../../lib/post/index'
import { detectRotatedWcs } from '../../lib/post/validate'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeTool, makeMachine, makeOp, makeWcs, move } from './helpers'
import type { PostInput, PostOperation } from '../../lib/post/types'

function postOp(op = makeOp(), tool = makeTool(), machine = makeMachine()): PostOperation {
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

function makeInput(ops: PostOperation[], wcs = makeWcs()): PostInput {
  return { machine: makeMachine(), setup: { wcs, operations: ops } }
}

/** One feed move to a previous point, then a CCW quarter-circle arc of radius
 *  5 around a stated WORLD centre - fixed across every test below so only the
 *  WCS changes between cases. */
function quarterArcOp(prev: { x: number; y: number }, center: { x: number; y: number }, end: { x: number; y: number }) {
  return makeOp({
    id: 'op1',
    name: 'Quarter arc',
    toolId: 't1',
    toolpathMoves: [
      move({ type: 'feed', x: prev.x, y: prev.y, z: 0, feed: 2000, role: 'cut' }),
      move({ type: 'arc_ccw', x: end.x, y: end.y, z: 0, cx: center.x, cy: center.y, feed: 2000, role: 'cut' }),
    ],
  })
}

/** Pull letter->number pairs out of an emitted line, e.g. "G3 X-5 Y0 I0 J-5"
 *  -> {X:-5, Y:0, I:0, J:-5}. Reads the ACTUAL emitted text, independent of
 *  any hand-derived expectation, so the consistency test below is a genuine
 *  check against the program's own output. */
function parseWords(line: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of line.matchAll(/([A-Z])(-?[0-9.]+)/g)) out[m[1]] = Number(m[2])
  return out
}

describe('WO-299: arc centre offset rotates with the WCS basis (emit.ts)', () => {
  it('pins exact endpoint + centre-offset numbers for a 90deg WCS rotation', () => {
    // t = 90deg: xAxis = (cos t, -sin t, 0) = (0,-1,0), yAxis = (sin t, cos t, 0) = (1,0,0).
    // Origin is non-zero so the endpoint transform (subtracts origin) and the
    // I/J transform (must NOT subtract origin) can be told apart by the numbers.
    const wcs = makeWcs({
      xAxis: { x: 0, y: -1, z: 0 },
      yAxis: { x: 1, y: 0, z: 0 },
      origin: { x: 10, y: 20, z: 0 },
    })
    const op = postOp(quarterArcOp({ x: 15, y: 20 }, { x: 10, y: 20 }, { x: 10, y: 25 }))
    const { lines } = emitProgram(makeInput([op], wcs), UCCNC_CONFIG)

    // Previous move: world (15,20,0), delta from origin (10,20,0) = (5,0,0).
    // work.x = xAxis.(5,0,0) = 0*5 = 0; work.y = yAxis.(5,0,0) = 1*5 = 5.
    expect(lines.find((l) => l.startsWith('G1'))).toBe('G1 X0 Y5 Z0 F2000')

    // Arc endpoint: world (10,25,0), delta from origin = (0,5,0).
    // work.x = xAxis.(0,5,0) = -1*5 = -5; work.y = yAxis.(0,5,0) = 0*5 = 0.
    // Centre offset: delta from the PREVIOUS WORLD point (10,20)-(15,20) =
    // (-5,0), rotated by the SAME basis (no origin term - it is a delta):
    // I = xAxis.(-5,0,0) = 0*-5 = 0; J = yAxis.(-5,0,0) = 1*-5 = -5.
    // The pre-fix formula (world difference, unrotated) would emit I-5 J0.
    expect(lines.find((l) => l.startsWith('G3'))).toBe('G3 X-5 Y0 I0 J-5')
  })

  it('pins exact numbers for a generic (non-cardinal) Z rotation, not just 0/90/180/270', () => {
    // t with cos t = 0.6, sin t = 0.8 (a 3-4-5 triangle, exact in decimal):
    // xAxis = (0.6,-0.8,0), yAxis = (0.8,0.6,0). Zero origin isolates rotation.
    const wcs = makeWcs({ xAxis: { x: 0.6, y: -0.8, z: 0 }, yAxis: { x: 0.8, y: 0.6, z: 0 } })
    const op = postOp(quarterArcOp({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }))
    const { lines } = emitProgram(makeInput([op], wcs), UCCNC_CONFIG)

    // Previous point: delta (5,0,0). work.x = 0.6*5 = 3; work.y = 0.8*5 = 4.
    const g1 = parseWords(lines.find((l) => l.startsWith('G1'))!)
    expect(g1.X).toBeCloseTo(3, 9)
    expect(g1.Y).toBeCloseTo(4, 9)

    // Endpoint: delta (0,5,0). work.x = -0.8*5 = -4; work.y = 0.6*5 = 3.
    // Centre delta from prev world (0,0)-(5,0) = (-5,0).
    // I = 0.6*-5 = -3; J = 0.8*-5 = -4.
    const g3 = parseWords(lines.find((l) => l.startsWith('G3'))!)
    expect(g3.X).toBeCloseTo(-4, 9)
    expect(g3.Y).toBeCloseTo(3, 9)
    expect(g3.I).toBeCloseTo(-3, 9)
    expect(g3.J).toBeCloseTo(-4, 9)
  })

  it('the emitted centre remains the true centre of the emitted arc under rotation', () => {
    // Same generic-rotation scenario, but the check is read straight off the
    // emitted text: reconstruct the work-space centre as (previous point) +
    // (I,J) and confirm it is equidistant from the previous point AND the
    // endpoint - both should equal the un-rotated world radius (5), proving
    // the centre and the endpoint were rotated by the same transform.
    const wcs = makeWcs({ xAxis: { x: 0.6, y: -0.8, z: 0 }, yAxis: { x: 0.8, y: 0.6, z: 0 } })
    const op = postOp(quarterArcOp({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }))
    const { lines } = emitProgram(makeInput([op], wcs), UCCNC_CONFIG)

    const g1 = parseWords(lines.find((l) => l.startsWith('G1'))!)
    const g3 = parseWords(lines.find((l) => l.startsWith('G3'))!)
    const centerX = g1.X + g3.I
    const centerY = g1.Y + g3.J
    const distTo = (x: number, y: number) => Math.hypot(x - centerX, y - centerY)

    expect(distTo(g1.X, g1.Y)).toBeCloseTo(5, 9) // centre -> previous point
    expect(distTo(g3.X, g3.Y)).toBeCloseTo(5, 9) // centre -> endpoint
  })

  it('identity WCS output is byte-identical to the pre-WO-299 world-difference formula', () => {
    const wcs = makeWcs() // identity axes, zero origin
    const op = postOp(quarterArcOp({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }))
    const { lines } = emitProgram(makeInput([op], wcs), UCCNC_CONFIG)

    // Under an identity basis R^T is the identity, so the new rotated formula
    // collapses to the exact same numbers the old plain-subtraction formula
    // produced: I = cx - prevWorld.x = 0-5 = -5, J = cy - prevWorld.y = 0-0 = 0.
    expect(lines.find((l) => l.startsWith('G1'))).toBe('G1 X5 Y0 Z0 F2000')
    expect(lines.find((l) => l.startsWith('G3'))).toBe('G3 X0 Y5 I-5 J0')
  })
})

describe('WO-299: detectRotatedWcs narrow acceptance, wired end-to-end (postProgram)', () => {
  it('a pure rotation about Z posts successfully (was refused pre-WO-299)', () => {
    const wcs = makeWcs({ xAxis: { x: 0, y: -1, z: 0 }, yAxis: { x: 1, y: 0, z: 0 } })
    const op = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const res = postProgram(makeInput([op], wcs), UCCNC_CONFIG)
    expect(res.ok, JSON.stringify(res.diagnostics)).toBe(true)
    expect(res.diagnostics.some((d) => d.code === 'WCS_ROTATED')).toBe(false)
  })

  it('a mirrored (left-handed) basis still refuses, short-circuiting to ok:false', () => {
    const mirrored = makeWcs({ xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: -1, z: 0 } })
    const op = postOp(makeOp({ id: 'a', toolId: 't1' }), makeTool({ id: 't1', toolNumber: 1 }))
    const res = postProgram(makeInput([op], mirrored), UCCNC_CONFIG)
    expect(res.ok).toBe(false)
    expect(res.gcode).toBe('')
    const diag = res.diagnostics.find((d) => d.code === 'WCS_ROTATED')
    expect(diag?.message).toContain('mirrored')
  })
})

describe('WO-299: detectRotatedWcs refusals survive, each with its own message', () => {
  it('refuses a tilted zAxis (not yaw)', () => {
    const tilted = makeWcs({
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: Math.cos(0.1), z: Math.sin(0.1) },
      zAxis: { x: 0, y: -Math.sin(0.1), z: Math.cos(0.1) },
    })
    const diags = detectRotatedWcs(tilted)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('not vertical')
  })

  it('refuses a non-orthonormal basis (not a rotation at all)', () => {
    const scaled = makeWcs({ xAxis: { x: 1.01, y: 0, z: 0 } })
    const diags = detectRotatedWcs(scaled)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('orthonormal')
  })

  it('refuses a mirrored (left-handed) basis', () => {
    const mirrored = makeWcs({ xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: -1, z: 0 } })
    const diags = detectRotatedWcs(mirrored)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe('WCS_ROTATED')
    expect(diags[0].message).toContain('mirrored')
  })
})
