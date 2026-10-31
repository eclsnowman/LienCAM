// WO-3233: thin extrude faces carry CONSTRUCTED lineage - source entity plus
// wall role (in = toward the loop's enclosed area, out = away from it) for every
// wall, and an anchor-named start/end material cap per loop - so the names
// survive segment reordering and thickness/distance edits, and a lost entity
// loses exactly its own walls. Ordinary extrude names are untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { ExtrudeRequest, OpResult, ProfileRegion, ProfileSegment, ThinExtrudeSide } from '../../geom/geom-service.ts'
import { extrudeThinCapId, extrudeThinMergeId, extrudeThinWallId } from '../../doc/stable-id.ts'
import { rectLoop, rectWithHole, xyPlane } from './fixtures/profiles.ts'

const W = 40, H = 20, D = 8

let engine: GeomEngine
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
}, 60_000)
afterAll(async () => { await engine.disposeKernel() })

function rect(loop: ProfileSegment[] = rectLoop('S1', 0, 0, W, H)): ProfileRegion {
  return { sketchId: 'S1', plane: xyPlane(0), loops: [loop] }
}
async function thin(profile: ProfileRegion, thickness = 2, side: ThinExtrudeSide = 'inside', distance = D): Promise<OpResult> {
  const req: ExtrudeRequest = { featureId: 'F1', profiles: [profile], end: { kind: 'blind', distance }, op: 'newBody', thin: { thickness, side } }
  const r = await engine.makeExtrude(req)
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
  return r
}
const ids = (r: OpResult): string[] => r.elementMap!.generated

describe('WO-3233 thin wall roles', () => {
  it('the stable-id grammar for walls, caps and merged faces', () => {
    expect(extrudeThinWallId('F1', 'S1.e0', 'in')).toBe('F1:XTR:S1.e0:thinIn')
    expect(extrudeThinWallId('F1', 'S1.e0', 'out')).toBe('F1:XTR:S1.e0:thinOut')
    expect(extrudeThinCapId('F1', 'S1.e0', 'start')).toBe('F1:XTR:S1.e0:thinCapStart')
    expect(extrudeThinCapId('F1', 'S1.e0', 'end')).toBe('F1:XTR:S1.e0:thinCapEnd')
    expect(extrudeThinMergeId('F1', ['F1:XTR:S1.h0:thinOut', 'F1:XTR:S1.e0:thinIn'])).toBe('F1:XTR:merge:(F1:XTR:S1.e0:thinIn|F1:XTR:S1.h0:thinOut)')
  })

  it('outer loop: in is the material side for inside, the original edge is in for outside', async () => {
    const inside = await thin(rect(), 2, 'inside')
    const gi = inside.elementMap!.geometry!
    expect(gi['F1:XTR:S1.e0:thinOut'].centroid.y).toBeCloseTo(0, 6)
    expect(gi['F1:XTR:S1.e0:thinIn'].centroid.y).toBeCloseTo(2, 6)
    const outside = await thin(rect(), 2, 'outside')
    const go = outside.elementMap!.geometry!
    expect(go['F1:XTR:S1.e0:thinIn'].centroid.y).toBeCloseTo(0, 6)
    expect(go['F1:XTR:S1.e0:thinOut'].centroid.y).toBeCloseTo(-2, 6)
    await engine.dispose(inside.body!)
    await engine.dispose(outside.body!)
  }, 60_000)

  it('hole loop: inside grows the hole wall into the material (out = r + t)', async () => {
    const r = await thin(rectWithHole('S1', W, H, 20, 10, 5), 1, 'inside')
    const g = r.elementMap!.geometry!
    const radius = (id: string): number => g[id].area / (2 * Math.PI * D)
    expect(radius('F1:XTR:S1.h0:thinIn')).toBeCloseTo(5, 6)
    expect(radius('F1:XTR:S1.h0:thinOut')).toBeCloseTo(6, 6)
    // Two loops, two disjoint bands: each loop's caps are named by its anchor.
    for (const anchor of ['S1.e0', 'S1.h0']) {
      for (const which of ['start', 'end'] as const) expect(ids(r)).toContain(extrudeThinCapId('F1', anchor, which))
    }
    await engine.dispose(r.body!)
  }, 60_000)

  it('overlapping bands fuse: union volume, and a shared face is named by every cap on it, never the nearest', async () => {
    // 40 x 20 with a 10 x 7 hole at x 15..25, y 3..10. Inside t = 2: the outer
    // band is y 0..2 at the bottom; the hole band grows the hole to x 13..27,
    // y 1..12, so the two bands overlap on x 13..27, y 1..2 (14 mm2).
    // Union = 224 + (14*11 - 10*7) - 14 = 294 mm2, V = 294 * 8 (the sum would be 308 * 8).
    const profile: ProfileRegion = { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1', 0, 0, W, H), rectLoop('S1.h', 15, 3, 25, 10)] }
    const r = await thin(profile, 2, 'inside')
    expect((await engine.measure(r.body!, 'volume')).value).toBeCloseTo(294 * D, 6)
    // The hole's bottom-edge outer wall (y = 1) lies inside the fused material: not a face.
    expect(ids(r)).not.toContain('F1:XTR:S1.h.e0:thinOut')
    // The fused end cap carries both loops' cap points, so both are named on it.
    const capsEnd = ids(r).filter((id) => id.includes('thinCapEnd'))
    expect(capsEnd).toEqual([extrudeThinMergeId('F1', [extrudeThinCapId('F1', 'S1.e0', 'end'), extrudeThinCapId('F1', 'S1.h.e0', 'end')])])
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3233 thin lineage when bands cut walls into fragments', () => {
  it('every wall fragment keeps its source entity and role; nothing falls back to an anonymous wall', async () => {
    // 20 x 20 with a centred r = 5 hole, inside t = 3: the hole band (r 5..8)
    // crosses the outer band (3 mm in from each edge), so the outer inner
    // walls (x = 3, x = 17, y = 3, y = 17) are each cut in two by the hole band.
    // Union area: 400 - 196 (inner 14 x 14) + (64 pi - 25 pi) - overlap of the
    // r = 8 disc beyond the 14 x 14 square (4 circular segments of height 1).
    const seg = 64 * Math.acos(7 / 8) - 7 * Math.sqrt(64 - 49)
    const area = 400 - 196 + Math.PI * (64 - 25) - 4 * seg
    const r = await thin(rectWithHole('S1', 20, 20, 10, 10, 5), 3, 'inside')
    expect((await engine.measure(r.body!, 'volume')).value).toBeCloseTo(area * D, 6)
    expect(ids(r).some((id) => id.includes(':thinWall'))).toBe(false)
    for (const e of ['e0', 'e1', 'e2', 'e3']) {
      expect(ids(r)).toContain(`F1:XTR:S1.${e}:thinIn#0`)
      expect(ids(r)).toContain(`F1:XTR:S1.${e}:thinIn#1`)
      expect(ids(r)).toContain(`F1:XTR:S1.${e}:thinOut`)
    }
    // Each e0 inner fragment lies on y = 3, on either side of the hole band.
    const g = r.elementMap!.geometry!
    for (const j of [0, 1]) expect(g[`F1:XTR:S1.e0:thinIn#${j}`].centroid.y).toBeCloseTo(3, 6)
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3233 thin lineage stability', () => {
  it('is deterministic run to run', async () => {
    const a = await thin(rect())
    const b = await thin(rect())
    expect(ids(b)).toEqual(ids(a))
    expect(JSON.stringify(b.elementMap!.geometry)).toBe(JSON.stringify(a.elementMap!.geometry))
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)

  it('survives segment reordering and reversed segments', async () => {
    const base = rectLoop('S1', 0, 0, W, H)
    const shuffled: ProfileSegment[] = [base[2], base[0], { ...base[3], a: base[3].kind === 'line' ? base[3].b : [0, 0], b: base[3].kind === 'line' ? base[3].a : [0, 0] } as ProfileSegment, base[1]]
    const a = await thin(rect(base))
    const b = await thin(rect(shuffled))
    expect(ids(b)).toEqual(ids(a))
    for (const id of ids(a)) {
      expect(b.elementMap!.geometry![id].centroid.x).toBeCloseTo(a.elementMap!.geometry![id].centroid.x, 9)
      expect(b.elementMap!.geometry![id].centroid.y).toBeCloseTo(a.elementMap!.geometry![id].centroid.y, 9)
    }
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)

  it('survives thickness and distance edits: same names, moved geometry', async () => {
    const a = await thin(rect(), 2)
    const b = await thin(rect(), 3)
    const c = await thin(rect(), 2, 'inside', 12)
    expect(ids(b)).toEqual(ids(a))
    expect(ids(c)).toEqual(ids(a))
    expect(b.elementMap!.geometry!['F1:XTR:S1.e0:thinIn'].centroid.y).toBeCloseTo(3, 6)
    expect(c.elementMap!.geometry!['F1:XTR:S1.e0:thinCapEnd'].centroid.z).toBeCloseTo(12, 6)
    for (const r of [a, b, c]) await engine.dispose(r.body!)
  }, 60_000)

  it('a lost entity loses exactly its own walls; nothing else is renamed', async () => {
    const a = await thin(rect())
    // Replace e2 + e3 by one diagonal e4: a right triangle (0,0) (40,0) (40,20).
    const tri: ProfileSegment[] = [
      { kind: 'line', a: [0, 0], b: [W, 0], srcId: 'S1.e0' },
      { kind: 'line', a: [W, 0], b: [W, H], srcId: 'S1.e1' },
      { kind: 'line', a: [W, H], b: [0, 0], srcId: 'S1.e4' },
    ]
    const b = await thin(rect(tri), 1)
    for (const lost of ['S1.e2', 'S1.e3']) expect(ids(b).some((id) => id.includes(`:${lost}:`))).toBe(false)
    for (const kept of ['S1.e0', 'S1.e1', 'S1.e4']) {
      expect(ids(b)).toContain(extrudeThinWallId('F1', kept, 'in'))
      expect(ids(b)).toContain(extrudeThinWallId('F1', kept, 'out'))
    }
    expect(ids(b).filter((id) => /thinCap/.test(id))).toEqual(['F1:XTR:S1.e0:thinCapEnd', 'F1:XTR:S1.e0:thinCapStart'])
    expect(b.elementMap!.geometry!['F1:XTR:S1.e0:thinOut'].centroid.y).toBeCloseTo(0, 6)
    await engine.dispose(a.body!)
    await engine.dispose(b.body!)
  }, 60_000)

  it('an ordinary extrude of the same profile keeps its XTR side/cap names byte for byte', async () => {
    const r = await engine.makeExtrude({ featureId: 'F1', profiles: [rect()], end: { kind: 'blind', distance: D }, op: 'newBody' })
    expect(ids(r)).toEqual([
      'F1:XTR:S1.e0:side', 'F1:XTR:S1.e1:side', 'F1:XTR:S1.e2:side', 'F1:XTR:S1.e3:side',
      'F1:XTR:S1:capEnd', 'F1:XTR:S1:capStart',
    ])
    expect((await engine.measure(r.body!, 'volume')).value).toBeCloseTo(W * H * D, 6)
    await engine.dispose(r.body!)
  }, 60_000)
})
