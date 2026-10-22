import { describe, expect, it } from 'vitest'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { ensureEngineClipperReady, offsetOpenRound, difference, netArea, offsetClosed } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { FaceParams, FaceWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()
await ensureEngineClipperReady()

const tool: Tool = {
  id: 'spiral-tool', name: '10 mm flat', type: 'flat_end_mill', diameter: 10,
  fluteLength: 20, shankDiameter: 10, overallLength: 60, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
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

function build(params = face(), loops = [loop([[0, 0], [100, 0], [100, 60], [0, 60]])], pp = passes): ToolpathMove[] {
  const payload: FaceWorkerPayload = {
    opId: 'spiral', setupId: 'setup', params, heights, passes: pp, linking, tool, loops,
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
  return buildFaceToolpath(payload)
}

function pointSegmentDistance(point: { x: number; y: number }, a: ToolpathMove, b: ToolpathMove): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  if (length2 < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

const rectangle = loop([[0, 0], [100, 0], [100, 60], [0, 60]])
const concave = loop([[0, 0], [100, 0], [100, 30], [55, 30], [55, 60], [0, 60]])
const split = loop([[0, 0], [40, 0], [40, 17], [80, 17], [80, 0], [120, 0], [120, 40], [80, 40], [80, 23], [40, 23], [40, 40], [0, 40]])
const circle = loop(Array.from({ length: 360 }, (_, i) => [50 + 30 * Math.cos(i * Math.PI / 180), 50 + 30 * Math.sin(i * Math.PI / 180)] as [number, number]))

function atDepth(moves: ToolpathMove[], z = -2) {
  return moves.filter(move => move.type === 'feed' && move.z === z)
}
function measure(boundary: LoopData, moves: ToolpathMove[], params = face()) {
  const path = atDepth(moves)
  // These are conservative polygonal cutter sweeps: shrink R by 0.002 and
  // approximate each round join by <=0.001 sagitta. An EMPTY difference proves
  // the exact circular cutter covers the stock too (no R+0.6 allowance).
  const swept = offsetOpenRound(path, 4.998, 0.001)
  const uncovered = difference([boundary.points], swept)
  const roots = offsetLoop(boundary.points, 5 + params.stockOffset + params.passExtension)
  // A thin swept line, rather than point samples, catches an entire chord
  // crossing a narrow concavity between otherwise valid endpoint samples.
  const crossing = difference(offsetOpenRound(path, 0.001, 0.0001), offsetClosed(roots, 0.003, 0.0001))
  let length = 0, transitionLength = 0, worstBoundaryDistance = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
    length += d
    if (path[i].role === 'stepover') transitionLength += d
  }
  for (const point of boundary.points) {
    let nearest = Infinity
    for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, pointSegmentDistance(point, path[i - 1], path[i]))
    worstBoundaryDistance = Math.max(worstBoundaryDistance, nearest)
  }
  return { orderedPointCount: path.length, uncoveredAreaMm2: netArea(uncovered),
    centrelineOutsideAreaMm2: netArea(crossing), worstVertexDistanceMm: worstBoundaryDistance,
    cuttingLengthMm: length, topologyTransitionLengthMm: transitionLength,
    uncoveredWidthBoundMm: uncovered.length ? Math.max(...uncovered.map(loop => Math.hypot(Math.max(...loop.map(p => p.x)) - Math.min(...loop.map(p => p.x)), Math.max(...loop.map(p => p.y)) - Math.min(...loop.map(p => p.y))))) : 0,
    cutTimeSeconds: length / 1000 * 60, entryCount: moves.filter(m => m.role === 'plunge').length,
    pathHash: createHash('sha256').update(JSON.stringify(moves)).digest('hex') }
}
function expectPhysical(boundary: LoopData, moves: ToolpathMove[]) {
  const measurement = measure(boundary, moves)
  expect(measurement.uncoveredAreaMm2, JSON.stringify(measurement)).toBeLessThan(1e-6)
  expect(measurement.centrelineOutsideAreaMm2, JSON.stringify(measurement)).toBeLessThan(1e-6)
  expect(measurement.worstVertexDistanceMm).toBeLessThanOrEqual(5)
  return measurement
}
// Unlike a list of connected endpoints, a repeated non-adjacent XY identifies
// completed contour laps. The old ring-plus-bridge implementation fails here.
function completedLaps(moves: ToolpathMove[]) {
  const seen = new Map<string, number>()
  let repeats = 0
  for (const [i, move] of atDepth(moves).entries()) {
    if (move.role === 'stepover') continue // explicit topology retraces
    const key = `${move.x.toFixed(5)},${move.y.toFixed(5)}`
    if (seen.has(key) && i - seen.get(key)! > 3) repeats++
    seen.set(key, i)
  }
  return repeats
}

describe('Face inward spiral (WO-2954)', () => {
  it.each(['inside', 'center', 'outside'] as const)(
    'covers the local reachable band for %s containment at stock offsets 0, 5 and 7', boundaryContainment => {
      for (const stockOffset of [0, 5, 7]) {
        const params = face({ boundaryContainment, stockOffset, passExtension: 0 })
        const centre = offsetLoop(rectangle.points, stockOffset + (boundaryContainment === 'inside' ? -5 : boundaryContainment === 'center' ? 0 : 5))
        const reachable = boundaryContainment === 'inside'
          ? offsetClosed(centre, 4.99, 0.0001)
          : offsetLoop(rectangle.points, stockOffset)
        const spiral = atDepth(build(params))
        const offset = atDepth(build({ ...params, pattern: 'offset' }))
        const spiralMissing = difference(reachable, offsetOpenRound(spiral, 4.998, 0.001))
        const offsetMissing = difference(reachable, offsetOpenRound(offset, 4.998, 0.001))
        // Set subtraction is local: an Offset gap elsewhere cannot mask a
        // Spiral gap, unlike comparing aggregate uncovered areas.
        expect(netArea(difference(spiralMissing, offsetMissing)),
          `local reachable band at stockOffset ${stockOffset}`).toBeLessThan(1e-6)
        expect(netArea(spiralMissing), `reachable area at stockOffset ${stockOffset}`).toBeLessThan(1e-6)
      }
    })

  it.each(['inside', 'center', 'outside'] as const)(
    'selects the boundary phase relative to the faced region for %s containment', boundaryContainment => {
      for (const stockOffset of [-7, 0, 7]) for (const radialStock of [0, 2]) for (const passExtension of [0, 4, 5, 6]) {
        const path = atDepth(build(face({ boundaryContainment, stockOffset, passExtension }),
          [rectangle], { ...passes, stockToLeave: radialStock }))
        const start = path[0]
        const hasBoundaryLap = path.some((p, i) => i > 3 && p.role === 'cut'
          && Math.hypot(p.x - start.x, p.y - start.y) < 1e-8)
        expect(hasBoundaryLap, JSON.stringify({ boundaryContainment, stockOffset, radialStock, passExtension }))
          .toBe(boundaryContainment === 'inside' && passExtension < 5)
      }
    })

  it('lifts vertically before transfers between Rest roots and depth passes', () => {
    const islands = [loop([[0, 0], [20, 0], [20, 60], [0, 60]], 'a'),
      loop([[40, 0], [140, 0], [140, 60], [40, 60]], 'b')]
    const moves = buildFaceToolpath({ opId: 'rest', setupId: 'setup',
      params: face({ boundarySource: 'rest' }),
      heights: { ...heights, clearanceHeight: 1, retractHeight: 0.5, feedHeight: 0.1, bottomHeight: -10 },
      passes: { ...passes, stepdown: 5 }, linking, tool, loops: islands, regionHoles: [],
      wcsOrigin: { x: 0, y: 0, z: 0 } })
    expect(moves.filter(m => m.role === 'plunge').map(m => m.z)).toEqual([-5, -5, -10, -10])
    let transfers = 0
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (b.type !== 'rapid' || Math.hypot(b.x - a.x, b.y - a.y) < 1e-8) continue
      transfers++
      // An affine 3D rapid stays above stock along its ENTIRE segment iff
      // both endpoint heights do. This catches the audit's interior crossing,
      // not just a destination at safe Z or sparse samples of the rapid.
      expect(Math.min(a.z, b.z), 'lateral rapid must follow a vertical lift above uncut stock').toBeGreaterThanOrEqual(1)
    }
    expect(transfers).toBe(3)
    const entries = moves.flatMap((m, i) => m.role === 'plunge' ? [i] : [])
    for (const i of entries) {
      expect(moves[i - 1].z).toBe(0.1)
      expect(moves[i - 1].x).toBe(moves[i].x)
      expect(moves[i - 1].y).toBe(moves[i].y)
    }
  })

  it.each([0, 90, 180, 270])('covers reachable Inside edges without overhang at entry phase %s', angle => {
    const params = face({ boundaryContainment: 'inside', passExtension: 0, passAngle: angle,
      direction: angle === 180 ? 'conventional' : 'climb' })
    const boundary = angle === 90 ? { ...rectangle, points: [...rectangle.points].reverse() } : rectangle
    const moves = build(params, [boundary], { ...passes, stepdown: 1 })
    for (const z of [-1, -2]) {
      const path = atDepth(moves, z)
      // Every segment lies in this convex inset box, hence every exact R5
      // cutter capsule is inside the stock. No sampled clearance assertion.
      for (const p of path) {
        expect(p.x).toBeGreaterThanOrEqual(5); expect(p.x).toBeLessThanOrEqual(95)
        expect(p.y).toBeGreaterThanOrEqual(5); expect(p.y).toBeLessThanOrEqual(55)
      }
      for (let s = 10; s <= 50; s += 5) for (const p of [
        { x: s, y: 0.5 }, { x: 100 - s, y: 59.5 }, { x: 0.5, y: s }, { x: 99.5, y: s },
      ]) {
        let nearest = Infinity
        for (let i = 1; i < path.length; i++) nearest = Math.min(nearest, pointSegmentDistance(p, path[i - 1], path[i]))
        expect(nearest, `reachable edge ${JSON.stringify(p)} at Z${z}`).toBeLessThanOrEqual(5)
      }
      // Compare the whole reachable domain, excluding only the 0.01 mm
      // polygon-approximation band. Square stock corners are unreachable.
      const inset = offsetLoop(rectangle.points, -5)
      const reachable = offsetClosed(inset, 4.99, 0.0001)
      const swept = offsetOpenRound(path, 4.998, 0.001)
      expect(netArea(difference(reachable, swept)), 'reachable domain must be swept').toBeLessThan(1e-6)
      expect(Math.min(...path.map(p => Math.hypot(p.x, p.y)))).toBeGreaterThan(5)
      // Exactly one perimeter coverage lap, then genuine inward progression;
      // this is explicitly distinct from the default no-completed-laps route.
      const start = path[0]
      const closure = path.findIndex((p, i) => i > 0 && Math.hypot(p.x - start.x, p.y - start.y) < 1e-8)
      expect(closure).toBeGreaterThan(0)
      expect(completedLaps(path.slice(closure).map(p => ({ ...p, z: -2 })))).toBe(0)
    }
  })

  it.each([['rectangle', rectangle], ['concave', concave], ['split', split], ['circle', circle]] as const)(
    'covers %s with one connected chain, contained segments and no intermediate rapid', (name, boundary) => {
      const moves = build(face(), [boundary])
      expect(moves.filter(m => m.role === 'plunge')).toHaveLength(1)
      expect(moves.filter(m => m.role === 'rapid' && m.z === 5)).toHaveLength(0)
      expect(moves.filter(m => m.role === 'rapid' && m.z === 10)).toHaveLength(2)
      const measurement = expectPhysical(boundary, moves)
      if (process.env.WO2954_EVIDENCE) writeFileSync(`src/tests/evidence/WO-2954/${name}-solver.json`, JSON.stringify({
        sourceHash: createHash('sha256').update(readFileSync('src/lib/cam/face2d/index.ts')).digest('hex'),
        boundary: boundary.points, params: face(), measurement, moves,
      }, null, 2) + '\n')
    })

  it('progresses inward during each circle revolution rather than closing concentric loops', () => {
    const moves = build(face(), [circle])
    expect(completedLaps(moves)).toBe(0)
    const path = atDepth(moves)
    let radians = 0, falls = 0, priorRadius = Math.hypot(path[0].x - 50, path[0].y - 50)
    for (let i = 1; i < path.length; i++) {
      const radius = Math.hypot(path[i].x - 50, path[i].y - 50)
      if (priorRadius < 6) break // explicit innermost cleanup
      const before = Math.atan2(path[i - 1].y - 50, path[i - 1].x - 50)
      const after = Math.atan2(path[i].y - 50, path[i].x - 50)
      const delta = Math.atan2(Math.sin(after - before), Math.cos(after - before))
      expect(delta).toBeGreaterThanOrEqual(-1e-7)
      expect(radius).toBeLessThanOrEqual(priorRadius + 0.003) // input polygon chord sagitta, not coverage allowance
      if (radius < priorRadius - 1e-5) falls++
      radians += delta; priorRadius = radius
    }
    expect(radians).toBeGreaterThan(10 * Math.PI)
    expect(falls).toBeGreaterThan(500)
  })

  it('has strictly advancing rectangle contour bands and rejects closed-loop substitution', () => {
    const moves = build()
    expect(completedLaps(moves)).toBe(0)
    const path = atDepth(moves)
    // Distance to the expanded rectangular envelope progresses within every
    // revolution (away from its rounded corners); no constant-offset full lap.
    const depths = path.filter(p => p.x > 10 && p.x < 90 && p.y < 20)
      .map(p => p.y + 10)
    expect(new Set(depths.map(d => d.toFixed(2))).size).toBeGreaterThan(100)
    const domain = offsetLoop(rectangle.points, 10)[0]
    const edgeDistance = (p: ToolpathMove) => Math.min(...domain.map((a, i) => pointSegmentDistance(p,
      { ...a, type: 'feed', z: -2 }, { ...domain[(i + 1) % domain.length], type: 'feed', z: -2 })))
    const inward = path.map(edgeDistance)
    for (let i = 1; i < inward.length; i++)
      expect(inward[i] - inward[i - 1], 'rectangle must progress inward at its corners too').toBeGreaterThanOrEqual(-0.01)
    const old = build(face({ pattern: 'offset' }))
    expect(completedLaps(old)).toBeGreaterThan(0)
    // Withdrawn drawing contains multiple disconnected completed rectangles.
    const withdrawn = readFileSync('src/tests/evidence/WO-2954/round-spiral.svg', 'utf8')
    expect((withdrawn.match(/M\s*[-\d]/g) ?? []).length).toBeGreaterThan(1)
  })

  it('detects uncut centre, a disconnected bridge and whole-segment boundary crossing', () => {
    const moves = build(face(), [concave])
    const missingCentre = moves.filter(m => m.type === 'rapid' || m.x < 10 || m.y < 10 || m.x > 90 || m.y > 50)
    expect(measure(concave, missingCentre).uncoveredAreaMm2).toBeGreaterThan(100)
    // An omitted safe routing sequence creates an implicit straight chord across
    // the concavity. Endpoints alone and five arbitrary samples are no proof.
    const bad: ToolpathMove[] = [
      { type: 'feed', x: 95, y: 35, z: -2, role: 'cut' },
      { type: 'feed', x: 60, y: 60, z: -2, role: 'cut' },
    ]
    expect(measure(concave, bad).centrelineOutsideAreaMm2).toBeGreaterThan(0.00001)
    expect(measure(rectangle, moves.slice(0, 4)).uncoveredAreaMm2).toBeGreaterThan(1000)
  })

  it('honours winding, M4 tool hand and oversized stepover without changing coverage', () => {
    const climb = build(face({ direction: 'climb' }), undefined, { ...passes, stepover: 50 })
    const conventional = build(face({ direction: 'conventional' }), undefined, { ...passes, stepover: 50 })
    expect(climb).not.toEqual(conventional)
    expectPhysical(rectangle, climb); expectPhysical(rectangle, conventional)
    const left = buildFaceToolpath({ opId: 'left', setupId: 'setup', params: face(), heights, passes,
      linking, tool: { ...tool, cutHand: 'left' }, loops: [rectangle], wcsOrigin: { x: 0, y: 0, z: 0 } })
    expect(left).toEqual(conventional)
    const bothWaysLeft = buildFaceToolpath({ opId: 'left', setupId: 'setup', params: face({ direction: 'both_ways' }), heights, passes,
      linking, tool: { ...tool, cutHand: 'left' }, loops: [rectangle], wcsOrigin: { x: 0, y: 0, z: 0 } })
    expect(bothWaysLeft).toEqual(conventional)
  })

  it('supports multiple depth passes, finish spacing and deterministic splits', () => {
    const pp = { ...passes, stepdown: 0.75, floorStockToLeave: 0.2, finishStepover: 1 }
    const moves = build(face({ finishPass: true }), [split], pp)
    expect(moves.filter(m => m.role === 'plunge').map(m => m.z)).toEqual([-0.75, -1.5, -1.8, -2])
    expect(moves).toEqual(build(face({ finishPass: true }), [split], pp))
    for (const z of [-0.75, -1.5, -1.8, -2]) expectPhysical(split, atDepth(moves, z).map(m => ({ ...m, z: -2 })))
    expect(moves.some(m => m.role === 'stepover')).toBe(true)
  })

  it('preserves progression under reversed source winding and nonzero entry phase', () => {
    const reverse = { ...rectangle, points: [...rectangle.points].reverse() }
    const forward = build(face({ passAngle: 90 }), [rectangle])
    const backward = build(face({ passAngle: 90 }), [reverse])
    expectPhysical(rectangle, forward); expectPhysical(rectangle, backward)
    expect(completedLaps(forward)).toBe(0); expect(completedLaps(backward)).toBe(0)
    expect(forward).not.toEqual(build())
  })

  it('rejects the withdrawn concave drawing whole segment crossing its notch', () => {
    const svg = readFileSync('src/tests/evidence/WO-2954/concave-split.svg', 'utf8')
    expect(svg).toContain('M157 187H313V293H306')
    // This exact cyan segment of the withdrawn drawing is in the U's open
    // notch (x165..305,y210..390). Its claimed in-material links have no
    // declared overrun or physical scale. Check that claim against DRAWN stock
    // only; no diagram coordinate is promoted to machine geometry.
    const stock = loop([[60,90],[410,90],[410,390],[305,390],[305,210],[165,210],[165,390],[60,390]])
    const domain = [stock.points]
    const bad = [{ x:181,y:211 },{ x:289,y:211 },{ x:289,y:269 },{ x:282,y:269 }]
    expect(netArea(difference(offsetOpenRound(bad, 0.01, 0.001), domain))).toBeGreaterThan(0.1)
    expect((svg.match(/M\d/g) ?? []).length).toBeGreaterThan(1)
  })

  it('reports the Spiral reference-fidelity limit without gating existing Face patterns', () => {
    expect(() => build(face({ tolerance: 0.001 }))).toThrow(/Inward spiral.*0.005 mm/)
    expect(() => build(face({ pattern: 'offset', tolerance: 0.001 }))).not.toThrow()
    expectPhysical(rectangle, build(face({ tolerance: 0.006 })))
  })

  it('rejects a Rest boundary with excluded pockets instead of substituting Offset', () => {
    expect(() => buildFaceToolpath({
      opId: 'rest', setupId: 'setup', params: face(), heights, passes, linking, tool,
      loops: [rectangle], regionHoles: [[{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }]],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    })).toThrow(/Inward spiral.*Rest boundary/)
  })
})
