// WO SKC-4 acceptance #5 (ProfileRegion output: outer + holes, correct
// winding, construction excluded, island-in-hole nesting), #6 (cross-lane
// proof: the emitted ProfileRegion feeds makeExtrude on the REAL geom
// worker), #7 (determinism: stable ids/ordering, input-order-shuffle
// invariant).
import { describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { ExtrudeRequest, ProfileRegion } from '../../geom/geom-service'
import { computeProfileRegions } from '../../sketch3d'
import type { Sketch3dCircleEntity, Sketch3dDocument, Sketch3dLineEntity } from '../../sketch3d'
import { makeArcEntity } from '../../components/sketch3d-shared/draftEntities'

const PLANE: ProfileRegion['plane'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

function line(id: string, x1: number, y1: number, x2: number, y2: number, construction = false): Sketch3dLineEntity {
  return { id, kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...(construction ? { construction } : {}) }
}

function circle(id: string, x: number, y: number, r: number): Sketch3dCircleEntity {
  return { id, kind: 'circle', center: { x, y }, radius: r }
}

const W = 40
const H = 20
const R = 3
const CX0 = 12
const CX1 = 28
const CY = 10

/** A CCW rectangle (0,0)-(W,H) with two circular holes, plus one construction
 *  line that must never appear in any emitted loop. */
function rectWithTwoHoles(sketchId: string): Sketch3dDocument {
  return {
    id: sketchId,
    entities: [
      line('e0', 0, 0, W, 0),
      line('e1', W, 0, W, H),
      line('e2', W, H, 0, H),
      line('e3', 0, H, 0, 0),
      circle('h0', CX0, CY, R),
      circle('h1', CX1, CY, R),
      line('cx', 0, 0, W, H, true), // construction diagonal -- excluded
    ],
    constraints: [],
  }
}

function shoelaceOfLineLoop(loop: ProfileRegion['loops'][number]): number {
  const pts = loop.map((seg) => {
    if (seg.kind !== 'line') throw new Error('expected an all-line loop for this fixture')
    return seg.a
  })
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    s += x1 * y2 - x2 * y1
  }
  return s / 2
}

describe('SKC-4 AC #5: ProfileRegion output', () => {
  it('rect with two circular holes emits ONE region: outer + 2 holes, correct winding, construction excluded', async () => {
    const regions = await computeProfileRegions(rectWithTwoHoles('rectSketch'), PLANE)
    expect(regions).toHaveLength(1)
    const region = regions[0]
    expect(region.sketchId).toBe('rectSketch')
    expect(region.loops).toHaveLength(3)

    const [outer, ...holes] = region.loops
    // outer boundary is CCW (positive signed area).
    expect(shoelaceOfLineLoop(outer)).toBeGreaterThan(0)
    expect(outer.map((s) => s.srcId).sort()).toEqual(['e0', 'e1', 'e2', 'e3'])

    // both holes present, each a single full-circle arc segment, CW winding.
    const holeSrcIds = holes.map((h) => h[0].srcId).sort()
    expect(holeSrcIds).toEqual(['h0', 'h1'])
    for (const hole of holes) {
      expect(hole).toHaveLength(1)
      const seg = hole[0]
      if (seg.kind !== 'arc') throw new Error('expected an arc segment for a circular hole')
      expect(seg.ccw).toBe(false)
    }

    // the construction entity never contributes a segment anywhere.
    const allSrcIds = region.loops.flat().map((s) => s.srcId)
    expect(allSrcIds).not.toContain('cx')
  })

  it('island-in-hole: a solid island nested inside a hole becomes its OWN region (never merged, never dropped)', async () => {
    const doc: Sketch3dDocument = {
      id: 'nestSketch',
      entities: [
        line('s0', 0, 0, 60, 0),
        line('s1', 60, 0, 60, 60),
        line('s2', 60, 60, 0, 60),
        line('s3', 0, 60, 0, 0),
        circle('hole', 30, 30, 15),
        circle('island', 30, 30, 5),
      ],
      constraints: [],
    }
    const regions = await computeProfileRegions(doc, PLANE)
    expect(regions).toHaveLength(2)

    const outerRegion = regions.find((r) => r.loops.length === 2)
    const islandRegion = regions.find((r) => r.loops.length === 1)
    if (!outerRegion || !islandRegion) throw new Error('expected one outer+hole region and one island-only region')

    expect(outerRegion.loops[0].map((s) => s.srcId).sort()).toEqual(['s0', 's1', 's2', 's3'])
    expect(outerRegion.loops[1][0].srcId).toBe('hole')
    expect(islandRegion.loops[0][0].srcId).toBe('island')
  })
})

describe('SKC-4 AC #7: determinism', () => {
  it('identical input reproduces byte-identical regions across two runs', async () => {
    const doc = rectWithTwoHoles('detSketch')
    const a = await computeProfileRegions(doc, PLANE)
    const b = await computeProfileRegions(doc, PLANE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('FAILS-IF: shuffling the input entities array changes emitted region identity -- it must not', async () => {
    const original = rectWithTwoHoles('shuffleSketch')
    const shuffled: Sketch3dDocument = { ...original, entities: [...original.entities].reverse() }
    const a = await computeProfileRegions(original, PLANE)
    const b = await computeProfileRegions(shuffled, PLANE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))

    // a second, differently-permuted shuffle too (not just a plain reverse).
    const permuted: Sketch3dDocument = {
      ...original,
      entities: [original.entities[4], original.entities[1], original.entities[6], original.entities[0], original.entities[5], original.entities[2], original.entities[3]],
    }
    const c = await computeProfileRegions(permuted, PLANE)
    expect(JSON.stringify(a)).toBe(JSON.stringify(c))
  })
})

/** WO SKC-8-R1 (Blocker 3): mirrors regions.ts's own private sampleArc normalization exactly, so
 *  this test measures the SAME swept-degrees value the real tessellator would produce -- the
 *  audit-caught defect collapsed a 270deg major arc down to the complementary 90deg minor sweep,
 *  which this helper would also report as 90 if the bug were still present. */
function sweptDegrees(seg: { a0: number; a1: number; ccw: boolean }): number {
  const TWO_PI = Math.PI * 2
  let span = seg.ccw ? seg.a1 - seg.a0 : seg.a0 - seg.a1
  while (span <= 0) span += TWO_PI
  while (span > TWO_PI + 1e-9) span -= TWO_PI
  return (span * 180) / Math.PI
}

function angleOnSweep(seg: { a0: number; a1: number; ccw: boolean }, angle: number, epsilonDeg = 1e-4): boolean {
  const span = sweptDegrees(seg)
  const rel = (((angle - seg.a0) * (seg.ccw ? 1 : -1)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  const relDeg = (rel * 180) / Math.PI
  return relDeg >= -epsilonDeg && relDeg <= span + epsilonDeg
}

describe('SKC-8-R1 Blocker 3: major-arc region round-trip', () => {
  it('a >180deg start/end/through arc keeps its major sweep through region output, all 3 points on-curve', async () => {
    // start=0deg, end=90deg on a r=10 circle at the origin; through=200deg forces makeArcEntity
    // to pick the MAJOR (270deg) arc between start and end, not the 90deg minor one.
    const start = { x: 10, y: 0 }
    const end = { x: 0, y: 10 }
    const through = { x: 10 * Math.cos((200 * Math.PI) / 180), y: 10 * Math.sin((200 * Math.PI) / 180) }
    const arc = makeArcEntity('majorArc', start, end, through)
    // WO SKC-12: canonical-CCW arcs express major/minor via a start/end SWAP (never a raw signed
    // delta) -- the NORMALIZED sweep, not endAngle < startAngle, is the major-arc signal now.
    expect(sweptDegrees({ a0: arc.startAngle, a1: arc.endAngle, ccw: true })).toBeCloseTo(270, 6)

    // Close the loop using the arc's OWN stored-angle endpoints (not the raw start/end click
    // points): a solved sketch's coincident endpoints always share this exact formula (see
    // arcEndpoint in regions.ts), and this test isolates the ccw-encoding bug from unrelated
    // floating-point vertex-snap noise.
    const arcStart = { x: arc.center.x + arc.radius * Math.cos(arc.startAngle), y: arc.center.y + arc.radius * Math.sin(arc.startAngle) }
    const arcEnd = { x: arc.center.x + arc.radius * Math.cos(arc.endAngle), y: arc.center.y + arc.radius * Math.sin(arc.endAngle) }
    const doc: Sketch3dDocument = {
      id: 'majorArcSketch',
      entities: [arc, line('close', arcEnd.x, arcEnd.y, arcStart.x, arcStart.y)],
      constraints: [],
    }
    const regions = await computeProfileRegions(doc, PLANE)
    expect(regions).toHaveLength(1)
    const loop = regions[0].loops[0]
    const arcSeg = loop.find((s) => s.srcId === 'majorArc')
    if (!arcSeg || arcSeg.kind !== 'arc') throw new Error('expected an arc segment sourced from majorArc')

    // FAILS-IF: a complementary-minor substitution reports ~90deg here instead of ~270deg.
    expect(sweptDegrees(arcSeg)).toBeCloseTo(270, 6)

    // All three of start/end/through sit ON the emitted curve (within its own sweep), i.e. the
    // arc's center/radius are unchanged and the through point was not swept past/around.
    const centerDist = (p: { x: number; y: number }) => Math.hypot(p.x - arcSeg.c[0], p.y - arcSeg.c[1])
    expect(centerDist(start)).toBeCloseTo(arcSeg.r, 9)
    expect(centerDist(end)).toBeCloseTo(arcSeg.r, 9)
    expect(centerDist(through)).toBeCloseTo(arcSeg.r, 9)
    const throughAngle = Math.atan2(through.y - arcSeg.c[1], through.x - arcSeg.c[0])
    expect(angleOnSweep(arcSeg, throughAngle)).toBe(true)
  })
})

describe('SKC-4 AC #6: cross-lane proof (REAL occt-wasm geom worker)', () => {
  it('the emitted ProfileRegion feeds makeExtrude directly; solid volume matches the region\'s analytic area x depth within 1e-6 relative', async () => {
    const engine = new GeomEngine()
    await engine.init()
    try {
      const regions = await computeProfileRegions(rectWithTwoHoles('extrudeSketch'), PLANE)
      expect(regions).toHaveLength(1)
      const DEPTH = 8
      const req: ExtrudeRequest = {
        featureId: 'F1',
        profile: regions[0],
        end: { kind: 'blind', distance: DEPTH },
        op: 'newBody',
      }
      const result = await engine.makeExtrude(req)
      expect(result.ok).toBe(true)
      const vol = await engine.measure(result.body!, 'volume')
      const expected = (W * H - 2 * Math.PI * R * R) * DEPTH
      expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)
      await engine.dispose(result.body!)
    } finally {
      await engine.disposeKernel()
    }
  }, 60_000)
})
