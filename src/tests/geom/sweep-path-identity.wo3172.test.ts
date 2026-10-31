// WO-3228 (Sweep path A, from WO-3172 Draft A): the shared sweep-path
// authority resolves a persisted {kind:'sketch-chain', sketchId, steps}
// selector into the exact line/arc PathChain, by producer and entity
// identity, from the sketch's CURRENT payload and datum frame.
//
// Oracles are independent of the resolver: endpoints are recomputed here from
// the entity fields with cos/sin, world points are lifted with the documented
// plane convention (local Y = normal x xDir, sketch3d/planeMath.ts), and an
// arc's swept angle is read with the spine-wire rule geom-engine
// #buildPathWire applies to a PathChain arc.
import { describe, expect, it } from 'vitest'
import {
  PATH_JOIN_TOL_MM,
  expandSweepPathSelection,
  resolveSweepPathChain,
  reverseSweepPathSelector,
  sweepProducerIds,
  type SweepPathNodeLookup,
  type SweepPathResolution,
  type SweepPathSelector,
} from '../../geom/sweep-path'
import { chainContaining } from '../../lib/sketch/bake'
import type { PathChain, PlaneDef, ProfileSegment, Vec3 } from '../../geom/geom-service'
import type { SketchEntity, SketchConstraint } from '../../lib/sketch/types'
import type { DagNodeSnapshot } from '../../doc/dag'

const TOL = PATH_JOIN_TOL_MM
const TWO_PI = Math.PI * 2

type Node = { kind: DagNodeSnapshot['kind']; payload: Record<string, unknown> }

const XY: PlaneDef = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
// A tilted, offset datum: normal (0,-1,0), xDir (1,0,0) -> local Y is world +Z.
const XZ_RAISED: PlaneDef = { origin: { x: 3, y: -7, z: 11 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }

const line = (id: string, x0: number, y0: number, x1: number, y1: number, construction = false): SketchEntity =>
  ({ id, kind: 'line', construction, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }) as SketchEntity
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): SketchEntity =>
  ({ id, kind: 'arc', construction: false, center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 }) as SketchEntity

function planeNode(frame: PlaneDef): Node {
  return { kind: 'datum', payload: { datumType: 'plane', planeKind: 'base-plane', lastGoodFrame: frame } }
}
function packageSketch(id: string, entities: SketchEntity[], planeNodeId: string, constraints: SketchConstraint[] = []): Node {
  return {
    kind: 'sketch',
    payload: { sketch: { id, layerId: 'L', entities, constraints, dimensions: [] }, planeNodeId },
  }
}
function nativeSketch(id: string, entities: SketchEntity[], planeNodeId: string, status = 'success'): Node {
  return {
    kind: 'sketch',
    payload: {
      document: { id, entities, constraints: [] },
      solveResult: { status, entities },
      dimensionDiagnostics: [],
      externalRefs: [],
      planeNodeId,
    },
  }
}
function dag(nodes: Record<string, Node>): SweepPathNodeLookup {
  return (id) => nodes[id]
}
function sel(sketchId: string, ...steps: Array<[string, boolean]>): SweepPathSelector {
  return { kind: 'sketch-chain', sketchId, steps: steps.map(([entityId, forward]) => ({ entityId, forward })) }
}
function okPath(r: SweepPathResolution): PathChain {
  if (!r.ok) throw new Error(`expected a path, got ${r.diagnostic.code}: ${r.diagnostic.message}`)
  return r.path
}

/** Independent arc endpoint from the stored entity fields. */
function arcPt(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
/** A segment's start/end points, read only from its own fields. */
function segEnds(s: ProfileSegment): [[number, number], [number, number]] {
  return s.kind === 'line' ? [s.a, s.b] : [arcPt(s.c[0], s.c[1], s.r, s.a0), arcPt(s.c[0], s.c[1], s.r, s.a1)]
}
/** Signed swept angle a PathChain arc gets in the spine wire (geom-engine #buildPathWire rule). */
function wireSweep(s: Extract<ProfileSegment, { kind: 'arc' }>): number {
  let sweep = s.a1 - s.a0
  if (s.ccw && sweep <= 0) sweep += TWO_PI
  if (!s.ccw && sweep >= 0) sweep -= TWO_PI
  return sweep
}
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1])
function lift(p: PlaneDef, uv: [number, number]): Vec3 {
  const n = p.normal, x = p.xDir
  const y = { x: n.y * x.z - n.z * x.y, y: n.z * x.x - n.x * x.z, z: n.x * x.y - n.y * x.x }
  return { x: p.origin.x + uv[0] * x.x + uv[1] * y.x, y: p.origin.y + uv[0] * x.y + uv[1] * y.y, z: p.origin.z + uv[0] * x.z + uv[1] * y.z }
}
function expectConnected(path: PathChain): void {
  for (let i = 0; i + 1 < path.segments.length; i++) {
    expect(dist(segEnds(path.segments[i])[1], segEnds(path.segments[i + 1])[0])).toBeLessThanOrEqual(TOL)
  }
}

// An L-shaped open path: line (0,0)->(10,0), then a CCW quarter arc about
// (10,5) from -pi/2 (at (10,0)) to 0 (at (15,5)), then a line up to (15,20).
function lPath(): SketchEntity[] {
  return [line('L1', 0, 0, 10, 0), arc('A1', 10, 5, 5, -Math.PI / 2, 0), line('L2', 15, 5, 15, 20)]
}

describe('WO-3228 sweep path by identity', () => {
  it('resolves line and canonical CCW arc in either travel direction without sampling', () => {
    const lookup = dag({ S: packageSketch('S', lPath(), 'P'), P: planeNode(XY) })

    const fwd = okPath(resolveSweepPathChain(sel('S', ['L1', true], ['A1', true], ['L2', true]), lookup))
    // One exact segment per entity: no polyline, no densified arc.
    expect(fwd.segments.map((s) => [s.kind, s.srcId])).toEqual([['line', 'L1'], ['arc', 'A1'], ['line', 'L2']])
    const a = fwd.segments[1] as Extract<ProfileSegment, { kind: 'arc' }>
    expect(a).toEqual({ kind: 'arc', c: [10, 5], r: 5, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'A1' })
    expect(dist(segEnds(a)[0], arcPt(10, 5, 5, -Math.PI / 2))).toBeLessThanOrEqual(TOL)
    expect(dist(segEnds(a)[1], [15, 5])).toBeLessThanOrEqual(TOL)
    expect(wireSweep(a)).toBeCloseTo(Math.PI / 2, 12)
    expectConnected(fwd)

    // The other travel direction: same entities, reversed; the arc runs CW
    // over the same quarter turn and the path starts at (15,20).
    const back = okPath(resolveSweepPathChain(reverseSweepPathSelector(sel('S', ['L1', true], ['A1', true], ['L2', true])), lookup))
    expect(back.segments.map((s) => s.srcId)).toEqual(['L2', 'A1', 'L1'])
    const b = back.segments[1] as Extract<ProfileSegment, { kind: 'arc' }>
    expect(b.ccw).toBe(false)
    expect(wireSweep(b)).toBeCloseTo(-Math.PI / 2, 12)
    expect(dist(segEnds(back.segments[0])[0], [15, 20])).toBeLessThanOrEqual(TOL)
    expect(dist(segEnds(back.segments[2])[1], [0, 0])).toBeLessThanOrEqual(TOL)
    expectConnected(back)

    // Major arc whose stored angles wrap: start 0.3, end -0.3 (CCW the long
    // way, 2pi - 0.6). Its span survives in both directions.
    const major = arc('M', 0, 0, 4, 0.3, -0.3)
    const lm = dag({ S: packageSketch('S', [major], 'P'), P: planeNode(XY) })
    const mf = okPath(resolveSweepPathChain(sel('S', ['M', true]), lm)).segments[0] as Extract<ProfileSegment, { kind: 'arc' }>
    const mb = okPath(resolveSweepPathChain(sel('S', ['M', false]), lm)).segments[0] as Extract<ProfileSegment, { kind: 'arc' }>
    expect(wireSweep(mf)).toBeCloseTo(TWO_PI - 0.6, 12)
    expect(wireSweep(mb)).toBeCloseTo(-(TWO_PI - 0.6), 12)
    expect(dist(segEnds(mb)[0], arcPt(0, 0, 4, -0.3))).toBeLessThanOrEqual(TOL)
    expect(dist(segEnds(mb)[1], arcPt(0, 0, 4, 0.3))).toBeLessThanOrEqual(TOL)

    // Stored angles a whole extra turn apart (0 -> 2pi + 1) span 1 rad, not 7.
    const extra = okPath(resolveSweepPathChain(sel('S', ['X', true]), dag({ S: packageSketch('S', [arc('X', 0, 0, 2, 0, TWO_PI + 1)], 'P'), P: planeNode(XY) })))
    expect(wireSweep(extra.segments[0] as Extract<ProfileSegment, { kind: 'arc' }>)).toBeCloseTo(1, 12)
    expect(dist(segEnds(extra.segments[0])[1], arcPt(0, 0, 2, 1))).toBeLessThanOrEqual(TOL)
  })

  it('resolves package and native solved sketches in their current datum frame', () => {
    const steps = sel('S', ['L1', true], ['A1', true], ['L2', true])
    const pkg = okPath(resolveSweepPathChain(steps, dag({ S: packageSketch('S', lPath(), 'P'), P: planeNode(XZ_RAISED) })))
    const nat = okPath(resolveSweepPathChain(steps, dag({ S: nativeSketch('S', lPath(), 'P'), P: planeNode(XZ_RAISED) })))
    expect(pkg.plane).toEqual(XZ_RAISED)
    expect(nat).toEqual(pkg)
    // World placement: the path's last point (15,20) lifts onto the raised XZ datum.
    const end = lift(pkg.plane, segEnds(pkg.segments[2])[1])
    expect(end.x).toBeCloseTo(18, 12)
    expect(end.y).toBeCloseTo(-7, 12)
    expect(end.z).toBeCloseTo(31, 12)

    // The datum moves: the same selector follows the plane's CURRENT frame.
    const moved: PlaneDef = { ...XY, origin: { x: 0, y: 0, z: 25 } }
    const again = okPath(resolveSweepPathChain(steps, dag({ S: packageSketch('S', lPath(), 'P'), P: planeNode(moved) })))
    expect(again.plane).toEqual(moved)
    expect(again.segments).toEqual(pkg.segments)

    // A native document that has not solved has no settled geometry.
    const unsolved = resolveSweepPathChain(steps, dag({ S: nativeSketch('S', lPath(), 'P', 'conflicting'), P: planeNode(XY) }))
    expect(unsolved.ok ? 'resolved' : unsolved.diagnostic.code).toBe('unsolved-sketch')
  })

  it('survives entity array reorder and coordinate edits but never replaces deleted IDs', () => {
    const steps = sel('S', ['L1', true], ['A1', true], ['L2', true])
    const base = okPath(resolveSweepPathChain(steps, dag({ S: packageSketch('S', lPath(), 'P'), P: planeNode(XY) })))
    const shuffled = [lPath()[2], line('X', 50, 50, 60, 50), lPath()[0], lPath()[1]]
    const reordered = okPath(resolveSweepPathChain(steps, dag({ S: packageSketch('S', shuffled, 'P'), P: planeNode(XY) })))
    expect(reordered).toEqual(base)

    // Edit: the arc grows to r = 8 and its neighbours follow; ids stay, geometry is the edited one.
    const edited = [line('L1', 0, 0, 10, 0), arc('A1', 10, 8, 8, -Math.PI / 2, 0), line('L2', 18, 8, 18, 30)]
    const e = okPath(resolveSweepPathChain(steps, dag({ S: packageSketch('S', edited, 'P'), P: planeNode(XY) })))
    expect(e.segments.map((s) => s.srcId)).toEqual(['L1', 'A1', 'L2'])
    expect((e.segments[1] as Extract<ProfileSegment, { kind: 'arc' }>).r).toBe(8)
    expect(dist(segEnds(e.segments[2])[1], [18, 30])).toBeLessThanOrEqual(TOL)
    expectConnected(e)

    // Delete A1 and draw an identical arc under a new id: the path does NOT rebind to it.
    const replaced = [lPath()[0], arc('A1-new', 10, 5, 5, -Math.PI / 2, 0), lPath()[2]]
    const gone = resolveSweepPathChain(steps, dag({ S: packageSketch('S', replaced, 'P'), P: planeNode(XY) }))
    expect(gone.ok).toBe(false)
    if (!gone.ok) {
      expect(gone.diagnostic.code).toBe('missing-entity')
      expect(gone.diagnostic.entityIds).toEqual(['A1'])
      expect(gone.diagnostic.sketchId).toBe('S')
    }
  })

  it('distinguishes repeated entity IDs in different producer sketches', () => {
    const lookup = dag({
      S1: packageSketch('S1', [line('e1', 0, 0, 10, 0)], 'P1'),
      S2: packageSketch('S2', [line('e1', 0, 0, 0, 40)], 'P2'),
      P1: planeNode(XY),
      P2: planeNode(XZ_RAISED),
    })
    const p1 = okPath(resolveSweepPathChain(sel('S1', ['e1', true]), lookup))
    const p2 = okPath(resolveSweepPathChain(sel('S2', ['e1', true]), lookup))
    expect(p1.sketchId).toBe('S1')
    expect(p2.sketchId).toBe('S2')
    expect(p1.plane).toEqual(XY)
    expect(p2.plane).toEqual(XZ_RAISED)
    expect(p1.segments[0]).toEqual({ kind: 'line', a: [0, 0], b: [10, 0], srcId: 'e1' })
    expect(p2.segments[0]).toEqual({ kind: 'line', a: [0, 0], b: [0, 40], srcId: 'e1' })

    // The Sweep's producers: one sketch consumed once, two sketches each once.
    expect(sweepProducerIds('S1', sel('S1', ['e1', true]))).toEqual(['S1'])
    expect(sweepProducerIds('S1', sel('S2', ['e1', true]))).toEqual(['S1', 'S2'])
  })

  it('selects one open component despite unrelated closed or construction geometry', () => {
    const entities: SketchEntity[] = [
      // A closed rectangle elsewhere (the sweep profile, say).
      line('R1', 40, 0, 50, 0), line('R2', 50, 0, 50, 10), line('R3', 50, 10, 40, 10), line('R4', 40, 10, 40, 0),
      // A construction line ending on the path's corner: never a branch.
      line('C1', 10, 0, 10, -20, true),
      // A spline nowhere near the path: unrelated, never a reason to refuse.
      { id: 'SP', kind: 'spline', construction: false, points: [{ x: 70, y: 0 }, { x: 80, y: 5 }, { x: 90, y: 0 }], closed: false } as unknown as SketchEntity,
      ...lPath(),
    ]
    const lookup = dag({ S: packageSketch('S', entities, 'P'), P: planeNode(XY) })

    const fromArc = expandSweepPathSelection('S', 'A1', lookup)
    expect(fromArc.ok).toBe(true)
    if (fromArc.ok) {
      expect(fromArc.selector).toEqual(sel('S', ['L1', true], ['A1', true], ['L2', true]))
      expect(fromArc.path.segments.map((s) => s.srcId)).toEqual(['L1', 'A1', 'L2'])
      expectConnected(fromArc.path)
    }

    // Clicked entity drawn the other way round: the chain is oriented so that
    // entity travels as stored, and the result is still the whole L.
    const flipped = entities.map((e) => (e.id === 'L2' ? line('L2', 15, 20, 15, 5) : e))
    const fromFlipped = expandSweepPathSelection('S', 'L2', dag({ S: packageSketch('S', flipped, 'P'), P: planeNode(XY) }))
    expect(fromFlipped.ok).toBe(true)
    if (fromFlipped.ok) {
      expect(fromFlipped.selector).toEqual(sel('S', ['L2', true], ['A1', false], ['L1', false]))
      expectConnected(fromFlipped.path)
    }
  })

  it('reports disconnected, ambiguous branch, closed, zero length and malformed paths by source', () => {
    const code = (r: { ok: boolean; diagnostic?: { code: string; sketchId: string; entityIds: string[] } }) =>
      r.ok ? ['resolved'] : [r.diagnostic!.code, r.diagnostic!.sketchId, r.diagnostic!.entityIds]
    const S = (entities: SketchEntity[]) => dag({ S: packageSketch('S', entities, 'P'), P: planeNode(XY) })

    // Disconnected: the steps skip the arc between them.
    expect(code(resolveSweepPathChain(sel('S', ['L1', true], ['L2', true]), S(lPath())))).toEqual(['disconnected', 'S', ['L1', 'L2']])
    // Wrong direction on one step breaks exact continuity too.
    expect(code(resolveSweepPathChain(sel('S', ['L1', true], ['A1', false]), S(lPath())))).toEqual(['disconnected', 'S', ['L1', 'A1']])

    // Ambiguous branch: a T junction at (10,0) -- one click has no unique path.
    const tee = [...lPath(), line('T', 10, 0, 10, -8)]
    expect(code(expandSweepPathSelection('S', 'L1', S(tee)))[0]).toBe('ambiguous-branch')
    expect(code(expandSweepPathSelection('S', 'L1', S(tee)))[1]).toBe('S')
    // A Y (three arms from one point) and a lollipop (a tail into a loop):
    // every click, including on an arm that only ENDS at the junction, is ambiguous.
    const wye = [line('y1', 0, 0, 5, 0), line('y2', 5, 0, 9, 3), line('y3', 5, 0, 9, -3)]
    for (const id of ['y1', 'y2', 'y3']) expect(code(expandSweepPathSelection('S', id, S(wye)))[0]).toBe('ambiguous-branch')
    const lolly = [line('t', -6, 0, 0, 0), arc('u', 3, 0, 3, Math.PI, 0), arc('v', 3, 0, 3, 0, Math.PI)]
    for (const id of ['t', 'u', 'v']) expect(code(expandSweepPathSelection('S', id, S(lolly)))[0]).toBe('ambiguous-branch')
    // ...while the explicit ordered chain through the junction resolves.
    expect(code(resolveSweepPathChain(sel('S', ['L1', true], ['T', true]), S(tee)))).toEqual(['resolved'])

    // Closed: a loop, a full circle, and a lone full-turn arc.
    const tri = [line('a', 0, 0, 10, 0), line('b', 10, 0, 0, 10), line('c', 0, 10, 0, 0)]
    expect(code(resolveSweepPathChain(sel('S', ['a', true], ['b', true], ['c', true]), S(tri)))).toEqual(['closed-path', 'S', ['a', 'b', 'c']])
    expect(code(expandSweepPathSelection('S', 'b', S(tri)))).toEqual(['closed-path', 'S', ['a', 'b', 'c']])
    const circ = { id: 'O', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 3 } as SketchEntity
    expect(code(resolveSweepPathChain(sel('S', ['O', true]), S([circ])))).toEqual(['closed-path', 'S', ['O']])
    expect(code(resolveSweepPathChain(sel('S', ['F', true]), S([arc('F', 0, 0, 3, 1, 1 + TWO_PI)])))).toEqual(['closed-path', 'S', ['F']])

    // Zero length: a point-like line and a zero-radius arc.
    expect(code(resolveSweepPathChain(sel('S', ['z', true]), S([line('z', 4, 4, 4, 4)])))).toEqual(['zero-length', 'S', ['z']])
    expect(code(resolveSweepPathChain(sel('S', ['r0', true]), S([arc('r0', 1, 1, 0, 0, 1)])))).toEqual(['zero-length', 'S', ['r0']])

    // Malformed selectors and payloads, each by name.
    expect(code(resolveSweepPathChain({ kind: 'sketch-chain', sketchId: 'S', steps: [] }, S(lPath())))).toEqual(['malformed-selector', 'S', []])
    expect(code(resolveSweepPathChain({ kind: 'sketch-chain', sketchId: 'S', steps: [{ entityId: 'L1' }] }, S(lPath())))[0]).toBe('malformed-selector')
    expect(code(resolveSweepPathChain(null, S(lPath())))[0]).toBe('malformed-selector')
    expect(code(resolveSweepPathChain(sel('S', ['L1', true], ['L1', true]), S(lPath())))).toEqual(['repeated-entity', 'S', ['L1']])
    expect(code(resolveSweepPathChain(sel('S', ['n', true]), S([line('n', 0, 0, Number.NaN, 1)])))).toEqual(['non-finite-geometry', 'S', ['n']])
    expect(code(resolveSweepPathChain(sel('GONE', ['L1', true]), S(lPath())))).toEqual(['missing-sketch', 'GONE', []])
    expect(code(resolveSweepPathChain(sel('S', ['L1', true]), dag({ S: packageSketch('S', lPath(), 'NOPE') })))).toEqual(['unresolved-plane', 'S', []])
    expect(code(resolveSweepPathChain(sel('S', ['L1', true]), dag({ S: { kind: 'sketch', payload: { plane: 'xy', width: 10, height: 5, offset: 0 } } }))))
      .toEqual(['closed-profile-only', 'S', []])
    expect(code(resolveSweepPathChain(sel('P', ['L1', true]), S(lPath())))).toEqual(['not-a-sketch', 'P', []])

    // Unsupported spline / 3D: the missing capability is named once and nothing resolves.
    const spl = [line('L', 0, 0, 5, 0), { id: 'sp', kind: 'spline', construction: false, points: [{ x: 5, y: 0 }, { x: 9, y: 3 }], closed: false } as unknown as SketchEntity]
    const sr = resolveSweepPathChain(sel('S', ['L', true], ['sp', true]), S(spl))
    expect(code(sr)).toEqual(['unsupported-entity', 'S', ['sp']])
    if (!sr.ok) expect(sr.diagnostic.message.match(/spline/g)).toHaveLength(1)
    const edges3d = resolveSweepPathChain({ kind: 'model-edges', sketchId: '', steps: [] }, S(lPath()))
    expect(code(edges3d)[0]).toBe('unsupported-path-kind')
  })

  it("does not inherit bake's 0.05 mm join as an invisible geometric repair", () => {
    // L1 ends at (10,0); L2 starts 0.01 mm away. Bake's 0.05 mm join chains them...
    const gapped = [line('L1', 0, 0, 10, 0), line('L2', 10.01, 0, 10.01, 10)]
    expect(chainContaining(gapped, [], 'L1')?.steps.map((s) => s.entity.id)).toEqual(['L1', 'L2'])
    const lookup = dag({ S: packageSketch('S', gapped, 'P'), P: planeNode(XY) })

    // ...the sweep path does not: both the click and the explicit chain report the gap.
    for (const r of [expandSweepPathSelection('S', 'L1', lookup), resolveSweepPathChain(sel('S', ['L1', true], ['L2', true]), lookup)]) {
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.diagnostic.code).toBe('disconnected')
        expect(r.diagnostic.entityIds).toEqual(['L1', 'L2'])
        expect(r.diagnostic.gapMm).toBeCloseTo(0.01, 9)
      }
    }

    // A coincident constraint on an unsolved, still-apart pair is not geometry either.
    const constrained: SketchConstraint[] = [
      { id: 'k', kind: 'coincident', a: { entityId: 'L1', site: 'end' }, b: { entityId: 'L2', site: 'start' } } as unknown as SketchConstraint,
    ]
    const apart = [line('L1', 0, 0, 10, 0), line('L2', 10.02, 0, 10.02, 10)]
    const r = expandSweepPathSelection('S', 'L1', dag({ S: packageSketch('S', apart, 'P', constrained), P: planeNode(XY) }))
    expect(r.ok ? 'resolved' : r.diagnostic.code).toBe('disconnected')

    // Nor does that join CLOSE a path: a -> b -> c is exactly joined, and c's
    // free end stops 0.01 mm short of a's start. Bake's walk sees a closed
    // loop; the sweep path is one open chain from every click, as the
    // explicit resolver says.
    const nearlyClosed = [line('a', 0, 0, 10, 0), line('b', 10, 0, 10, 10), line('c', 10, 10, 0, 0.01)]
    expect(chainContaining(nearlyClosed, [], 'a')?.closed).toBe(true)
    const nl = dag({ S: packageSketch('S', nearlyClosed, 'P'), P: planeNode(XY) })
    expect(resolveSweepPathChain(sel('S', ['a', true], ['b', true], ['c', true]), nl).ok).toBe(true)
    for (const id of ['a', 'b', 'c']) {
      const click = expandSweepPathSelection('S', id, nl)
      expect(click.ok ? click.selector : click.diagnostic.code).toEqual(sel('S', ['a', true], ['b', true], ['c', true]))
    }

    // Within the kernel's own confusion distance it is one point, not a gap.
    const touching = [line('L1', 0, 0, 10, 0), line('L2', 10 + TOL / 2, 0, 10, 10)]
    expect(expandSweepPathSelection('S', 'L1', dag({ S: packageSketch('S', touching, 'P'), P: planeNode(XY) })).ok).toBe(true)
  })
})
