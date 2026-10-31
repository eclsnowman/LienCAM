// WO-3253 (WO-3178 S1): Face's inward spiral XY planner is one shared pure
// function, planInwardSpiral, and Face emits exactly what it emitted before.
//
// Two independent oracles:
//  1. Byte identity: production buildFaceToolpath and the posted NC are compared
//     with the pre-extraction face2d source pinned in
//     src/tests/helpers/WO-3253/face2dPreExtraction.ts, in the same checkout,
//     over every case of face2d.spiral.wo2954.test.ts plus the new ones here.
//  2. Geometry: the plan itself is judged by swept-disk unions (clipper) and a
//     full segment-against-every-edge intersection test written here, never by
//     a golden array.
import { describe, expect, it } from 'vitest'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { ensureEngineClipperReady, offsetOpenRound, offsetClosed, difference, netArea } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { planInwardSpiral, type SpiralPlanPoint } from '../../lib/cam/spiralPlan'
import { buildFaceToolpath as buildFaceBefore } from '../helpers/WO-3253/face2dPreExtraction'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeOp, makeWcs } from '../post/helpers'
import type { FaceParams, FaceWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()
await ensureEngineClipperReady()

type Pt = { x: number; y: number }

// ── Face fixtures (the same as face2d.spiral.wo2954.test.ts) ──────────────────
const tool: Tool = {
  id: 'spiral-tool', name: '10 mm flat', type: 'flat_end_mill', diameter: 10,
  fluteLength: 20, shankDiameter: 10, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', toolNumber: 1,
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 7 } },
} as Tool
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 7, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' }

function face(over: Partial<FaceParams> = {}): FaceParams {
  return {
    boundarySource: 'stock', geometryId: '__stock__', loopIds: [], stockOffset: 0,
    boundaryContainment: 'outside', avoidanceLoopIds: [], pattern: 'spiral', passAngle: 0,
    direction: 'climb', fromOtherSide: false, passExtension: 5, chipThinning: false,
    bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false, entryType: 'plunge',
    leadInRadius: 0, leadOutRadius: 0, keepToolDown: true, maxStayDownDistance: Infinity,
    extendBeforeRetract: false, transition: 'straight', tolerance: 0.01, ...over,
  }
}
function loop(points: Array<[number, number]>, id = 'face'): LoopData {
  return { id, closed: true, type: 'contour', points: points.map(([x, y]) => ({ x, y })) }
}

const rectangle = loop([[0, 0], [100, 0], [100, 60], [0, 60]])
const concave = loop([[0, 0], [100, 0], [100, 30], [55, 30], [55, 60], [0, 60]])
const split = loop([[0, 0], [40, 0], [40, 17], [80, 17], [80, 0], [120, 0], [120, 40], [80, 40], [80, 23], [40, 23], [40, 40], [0, 40]])
const circle = loop(Array.from({ length: 360 }, (_, i) => [50 + 30 * Math.cos(i * Math.PI / 180), 50 + 30 * Math.sin(i * Math.PI / 180)] as [number, number]))
// The withdrawn WO-2954 drawing's U (concave-split.svg), in millimetres: a
// narrow notch the old five-sample containment check let a chord cross.
const notch = loop([[60, 90], [410, 90], [410, 390], [305, 390], [305, 210], [165, 210], [165, 390], [60, 390]].map(([x, y]) => [x / 5, y / 5] as [number, number]))

type Case = { name: string; params?: Partial<FaceParams>; loops?: LoopData[]; passes?: PassParams; tool?: Tool; regionHoles?: Pt[][] }
// Every input face2d.spiral.wo2954.test.ts builds, plus both tool hands,
// every direction and the concave U.
const cases: Case[] = [
  ...['inside', 'center', 'outside'].flatMap(boundaryContainment => [0, 5, 7].flatMap(stockOffset =>
    (['spiral', 'offset'] as const).map(pattern => ({ name: `${boundaryContainment} offset ${stockOffset} ${pattern}`,
      params: { boundaryContainment, stockOffset, passExtension: 0, pattern } as Partial<FaceParams> })))),
  ...['inside', 'center', 'outside'].flatMap(boundaryContainment => [-7, 0, 7].flatMap(stockOffset =>
    [0, 2].flatMap(radialStock => [0, 4, 5, 6].map(passExtension => ({
      name: `${boundaryContainment} phase ${stockOffset}/${radialStock}/${passExtension}`,
      params: { boundaryContainment, stockOffset, passExtension } as Partial<FaceParams>,
      passes: { ...passes, stockToLeave: radialStock } }))))),
  ...[0, 90, 180, 270].map(angle => ({ name: `inside entry ${angle}`, loops: [angle === 90 ? { ...rectangle, points: [...rectangle.points].reverse() } : rectangle],
    params: { boundaryContainment: 'inside', passExtension: 0, passAngle: angle, direction: angle === 180 ? 'conventional' : 'climb' } as Partial<FaceParams>,
    passes: { ...passes, stepdown: 1 } })),
  ...([['rectangle', rectangle], ['concave', concave], ['split', split], ['circle', circle], ['notch', notch]] as const).flatMap(([name, boundary]) =>
    (['climb', 'conventional', 'both_ways'] as const).map(direction => ({ name: `${name} ${direction}`, loops: [boundary], params: { direction } }))),
  { name: 'oversized stepover climb', params: { direction: 'climb' }, passes: { ...passes, stepover: 50 } },
  { name: 'oversized stepover conventional', params: { direction: 'conventional' }, passes: { ...passes, stepover: 50 } },
  { name: 'left hand', tool: { ...tool, cutHand: 'left' } as Tool },
  { name: 'left hand both ways', params: { direction: 'both_ways' }, tool: { ...tool, cutHand: 'left' } as Tool },
  { name: 'split finish multi-depth', loops: [split], params: { finishPass: true },
    passes: { ...passes, stepdown: 0.75, floorStockToLeave: 0.2, finishStepover: 1 } as PassParams },
  { name: 'reverse winding angle 90', loops: [{ ...rectangle, points: [...rectangle.points].reverse() }], params: { passAngle: 90 } },
  { name: 'angle 90', params: { passAngle: 90 } },
  { name: 'tolerance 0.006', params: { tolerance: 0.006 } },
  { name: 'tolerance 0.001', params: { tolerance: 0.001 } },
  { name: 'offset tolerance 0.001', params: { tolerance: 0.001, pattern: 'offset' } },
  { name: 'rest islands', params: { boundarySource: 'rest' }, loops: [loop([[0, 0], [20, 0], [20, 60], [0, 60]], 'a'),
    loop([[40, 0], [140, 0], [140, 60], [40, 60]], 'b')], regionHoles: [] },
  { name: 'rest with pocket', params: { boundarySource: 'rest' }, regionHoles: [[{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }]] },
  // Offset and straight passes share the moved region tree, entry angle and
  // boundary-distance helpers; their bytes must not move either.
  ...(['offset', 'linear', 'zigzag', 'one_way'] as const).flatMap(pattern => [
    { name: `${pattern} concave`, loops: [concave], params: { pattern, passAngle: 30 } },
    { name: `${pattern} split conventional`, loops: [split], params: { pattern, direction: 'conventional' } },
    { name: `${pattern} rest with pocket`, params: { pattern, boundarySource: 'rest' },
      regionHoles: [[{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }]] },
  ] as Case[]),
]

function payloadOf(c: Case): FaceWorkerPayload {
  return {
    opId: 'spiral', setupId: 'setup', params: face(c.params), heights, passes: c.passes ?? passes, linking,
    tool: c.tool ?? tool, loops: c.loops ?? [rectangle], wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(c.regionHoles ? { regionHoles: c.regionHoles } : {}),
  }
}
// The complete outcome: every move with full float precision, or the exact error.
function outcome(build: (p: FaceWorkerPayload) => ToolpathMove[], c: Case): { moves?: ToolpathMove[]; error?: string } {
  try { return { moves: build(payloadOf(c)) } } catch (e) { return { error: (e as Error).message } }
}
function posted(moves: ToolpathMove[], c: Case, config: typeof UCCNC_CONFIG): string {
  const t = { ...(c.tool ?? tool), toolNumber: 1 }
  const machine = makeMachine()
  const op = makeOp({ id: 'face1', name: 'Face', type: 'face', toolId: t.id, toolpathMoves: moves })
  const { lines } = emitProgram({ machine, setup: { wcs: makeWcs(), operations: [{
    op, tool: t, feeds: resolveFeedrates(t, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, t, machine), coolant: resolveCoolant(t, machine), moves,
  }] } }, config)
  return lines.join('\n')
}

// ── Independent geometry oracles ───────────────────────────────────────────────
// Every segment lies in the closed region: no proper crossing of ANY region
// edge, and the midpoint of every sub-segment between edge touches is inside
// (even-odd ray cast written here, not the planner's own helper).
function inside(p: Pt, poly: Pt[]): boolean {
  let odd = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) odd = !odd
  }
  return odd
}
function onBoundary(p: Pt, poly: Pt[], tol = 1e-5): boolean {
  return poly.some((a, i) => {
    const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= tol
  })
}
function segmentContained(a: Pt, b: Pt, poly: Pt[]): boolean {
  const ts = [0, 1]
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], d = poly[(i + 1) % poly.length]
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
    const den = rx * sy - ry * sx
    if (Math.abs(den) < 1e-14) continue
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
    if (t > 1e-9 && t < 1 - 1e-9 && u > -1e-9 && u < 1 + 1e-9) ts.push(t)
  }
  ts.sort((x, y) => x - y)
  for (const t of ts) {
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (!inside(p, poly) && !onBoundary(p, poly)) return false
  }
  for (let i = 1; i < ts.length; i++) {
    const t = (ts[i - 1] + ts[i]) / 2, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    if (!inside(p, poly) && !onBoundary(p, poly)) return false
  }
  return true
}
function expectContained(path: Pt[], region: Pt[]) {
  for (let i = 1; i < path.length; i++)
    expect(segmentContained(path[i - 1], path[i], region), `segment ${i} ${JSON.stringify([path[i - 1], path[i]])}`).toBe(true)
}
// Area of `target` not swept by an R disc along the path (conservative: the
// polygonal sweep is shrunk 0.002 mm and joins approximated within 0.001 mm).
function unswept(path: Pt[], R: number, target: Pt[][]): number {
  return netArea(difference(target, offsetOpenRound(path, R - 0.002, 0.001)))
}
function signedArea(poly: Pt[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y }
  return a / 2
}
const R = 5
const rectRegion = rectangle.points
const circleRegion = circle.points

describe('Shared inward spiral planner (WO-3253)', () => {
  it('is pure XY: samples carry only x, y, role and topology, and repeat exactly', () => {
    const region = rectRegion.map(p => ({ ...p }))
    const plan = planInwardSpiral(region, 7, R, 0.01, 0, 'climb', false)
    expect(region).toEqual(rectRegion)
    expect(plan.length).toBeGreaterThan(100)
    for (const p of plan) {
      expect(Object.keys(p).sort()).toEqual(['role', 'topology', 'x', 'y'])
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
    expect(plan[0].topology).toBe('entry')
    expect(planInwardSpiral(region, 7, R, 0.01, 0, 'climb', false)).toEqual(plan)
  })

  it('advances radially by one pitch per circle revolution, never closing a lap', () => {
    for (const direction of ['climb', 'conventional'] as const) {
      const plan = planInwardSpiral(circleRegion, 7, R, 0.01, 0, direction, false)
      const sign = direction === 'climb' ? 1 : -1
      let turned = 0, revolutionStart = Math.hypot(plan[0].x - 50, plan[0].y - 50)
      const drops: number[] = []
      for (let i = 1; i < plan.length; i++) {
        const r = Math.hypot(plan[i].x - 50, plan[i].y - 50), r0 = Math.hypot(plan[i - 1].x - 50, plan[i - 1].y - 50)
        if (r0 < R) break // innermost leaf cleanup
        const a0 = Math.atan2(plan[i - 1].y - 50, plan[i - 1].x - 50), a1 = Math.atan2(plan[i].y - 50, plan[i].x - 50)
        const delta = sign * Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
        expect(delta, `${direction} sample ${i} turns the wrong way`).toBeGreaterThanOrEqual(-1e-7)
        expect(r).toBeLessThanOrEqual(r0 + 0.003)
        turned += delta
        if (turned >= 2 * Math.PI) { drops.push(revolutionStart - r); revolutionStart = r; turned -= 2 * Math.PI }
      }
      // pitch = min(7, R/2) = 2.5 mm per revolution, outside to centre.
      expect(drops.length).toBeGreaterThanOrEqual(9)
      for (const drop of drops) expect(Math.abs(drop - 2.5), JSON.stringify(drops)).toBeLessThan(0.05)
    }
  })

  it('starts at the requested rectangle phase, keeps every corner and runs the chosen hand', () => {
    const corners = [{ x: 100, y: 60 }, { x: 0, y: 60 }, { x: 0, y: 0 }, { x: 100, y: 0 }]
    for (const [phase, corner] of [[Math.PI / 4, 0], [3 * Math.PI / 4, 1], [-3 * Math.PI / 4, 2], [-Math.PI / 4, 3]] as const) {
      for (const direction of ['climb', 'conventional'] as const) {
        const plan = planInwardSpiral(rectRegion, 7, R, 0.01, phase, direction, true)
        expect({ x: plan[0].x, y: plan[0].y }).toEqual(corners[corner])
        // The perimeter lap visits all four corners exactly, in hand order, and closes.
        const lap = plan.filter(p => p.topology === 'lap')
        const visited = lap.flatMap(p => corners.findIndex(c => c.x === p.x && c.y === p.y)).filter(i => i >= 0)
        const step = direction === 'climb' ? 1 : 3
        expect(visited).toEqual([1, 2, 3, 4].map(k => (corner + k * step) % 4))
        expect(Math.sign(signedArea(lap))).toBe(direction === 'climb' ? 1 : -1)
        expectContained(plan, rectRegion)
      }
    }
    // Without the lap no closed perimeter is cut; the first band still bends
    // through each corner inside the chord budget instead of chording past it.
    const plan = planInwardSpiral(rectRegion, 7, R, 0.01, Math.PI / 4, 'climb', false)
    expect(plan.some(p => p.topology === 'lap')).toBe(false)
    for (const corner of corners.slice(1)) {
      const nearest = Math.min(...plan.map(p => Math.hypot(p.x - corner.x, p.y - corner.y)))
      expect(nearest, JSON.stringify(corner)).toBeLessThan(2.5 * Math.SQRT2 + 0.01)
    }
  })

  it.each([['rectangle', rectangle], ['concave', concave], ['split', split], ['circle', circle], ['notch', notch]] as const)(
    'keeps every %s segment inside the region and sweeps all of it, ending on the centre', (_name, boundary) => {
      for (const direction of ['climb', 'conventional'] as const) {
        const region = boundary.points
        const plan = planInwardSpiral(region, 7, R, 0.01, 0, direction, false)
        expectContained(plan, region)
        expect(unswept(plan, R, [region])).toBeLessThan(1e-6)
        const last = plan[plan.length - 1]
        expect(last.topology).toBe('leaf')
        expect(last.role).toBe('cut')
        expect(plan.filter(p => p.topology === 'entry')).toHaveLength(1)
      }
    })

  it('covers the whole reachable inset boundary when the perimeter lap is asked for', () => {
    // An Inside face: the cutter centre region is the stock inset by R. Every
    // point of stock within R of that region must be swept, edges included.
    const inset = offsetLoop(rectRegion, -R)[0]
    const reachable = offsetClosed([inset], R - 0.01, 0.0001)
    const withLap = planInwardSpiral(inset, 7, R, 0.01, 0, 'climb', true)
    expectContained(withLap, inset)
    expect(unswept(withLap, R, reachable)).toBeLessThan(1e-6)
    const withoutLap = planInwardSpiral(inset, 7, R, 0.01, 0, 'climb', false)
    expect(unswept(withoutLap, R, reachable), 'the lap is what reaches the inset edge').toBeGreaterThan(1)
  })

  it('marks a concave split as a verbatim retrace of cut history and a contained attachment', () => {
    for (const direction of ['climb', 'conventional'] as const) {
      const plan = planInwardSpiral(split.points, 7, R, 0.01, 0, direction, false)
      const topologies = new Set(plan.map(p => p.topology))
      expect([...topologies].sort()).toEqual(['attach', 'band', 'entry', 'leaf', 'retrace'])
      for (const [i, p] of plan.entries()) {
        expect(p.role, `${p.topology} at ${i}`).toBe(p.topology === 'retrace' || p.topology === 'attach' ? 'stepover' : 'cut')
        if (p.topology === 'retrace')
          expect(plan.slice(0, i).some(q => q.x === p.x && q.y === p.y), `retrace ${i} must revisit an earlier sample`).toBe(true)
        if (p.topology === 'attach')
          expect(Math.hypot(p.x - plan[i - 1].x, p.y - plan[i - 1].y)).toBeLessThanOrEqual(R)
      }
      // Two split children, so two leaves; the attachments are the only
      // non-history stepover samples.
      expect(plan.filter(p => p.topology === 'attach')).toHaveLength(2)
      expectContained(plan, split.points)
    }
  })

  it('keeps the error behaviour: tolerance budget, and no partial plan', () => {
    expect(() => planInwardSpiral(rectRegion, 7, R, 0.005, 0, 'climb', false)).toThrow(/Inward spiral.*0\.005 mm; nothing was generated/)
    expect(() => planInwardSpiral(rectRegion, 7, R, Number.NaN, 0, 'climb', false)).toThrow(/0\.005 mm/)
    expect(planInwardSpiral(rectRegion, 7, R, 0.006, 0, 'climb', false).length).toBeGreaterThan(100)
  })

  it('is what Face emits: every Face spiral feed at depth is the plan sample, in order', () => {
    for (const direction of ['climb', 'conventional'] as const) {
      const moves = buildFaceToolpath(payloadOf({ name: 'x', loops: [split], params: { direction } }))
      const region = offsetLoop(split.points, R + 5)[0]
      const plan: SpiralPlanPoint[] = planInwardSpiral(region, 7, R, 0.01, 0, direction, false)
      const atDepth = moves.filter(m => m.type === 'feed' && m.z === -2)
      expect(atDepth.map(m => [m.x, m.y, m.role === 'plunge' ? 'cut' : m.role]))
        .toEqual(plan.map(p => [p.x, p.y, p.role]))
    }
  })

  it.each(cases.map(c => [c.name, c] as const))(
    'leaves Face moves and posted NC byte-identical to the pre-extraction source: %s', (_name, c) => {
      const before = outcome(buildFaceBefore, c), after = outcome(buildFaceToolpath, c)
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      // Only the tolerance budget and the Rest-pocket refusals (Spiral, Offset) refuse.
      expect(!!before.error).toBe(['tolerance 0.001', 'rest with pocket', 'offset rest with pocket'].includes(c.name))
      if (before.error) return
      expect(after.moves!.length).toBeGreaterThan(10)
      for (const config of [UCCNC_CONFIG, GRBL_CONFIG])
        expect(posted(after.moves!, c, config)).toBe(posted(before.moves!, c, config))
    })
})
