// WO-3233 (WO-3173 Draft A1): a makeExtrude request carrying thin:{thickness,
// side} builds an exact closed thin-wall solid - every loop banded by the
// thickness, the open ends closed only by the wall's own annular faces, no floor
// across the cavity - and refuses in one line whatever it cannot build exactly.
//
// Independent truth (REPORT analytic cases at D = 8, t = 2, 40 x 20 rectangle):
//   inside  (40*20 - 36*16) * 8 = 1792    outside (44*24 - 40*20) * 8 = 2048
//   center  (42*22 - 38*18) * 8 = 1920    centered circle R=10:  2*pi*10*2*8 = 320 pi
//   nested R=10 / r=5 inside t=1: (pi(100-81) + pi(36-25)) * 8 = 240 pi, two solids
// The body is then exported to STEP and read back into a SEPARATE kernel, where
// bounds, a mid-height cross section and an empty cavity probe are measured
// with plain kernel calls - not with the engine that built it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ExtrudeRequest, PlaneDef, ProfileRegion, ProfileSegment } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const W = 40, H = 20, D = 8, T = 2
const rel = (a: number, e: number): number => Math.abs(a - e) / Math.abs(e)

function rect(sketchId = 'S1', plane: PlaneDef = xyPlane(0)): ProfileRegion {
  return { sketchId, plane, loops: [rectLoop(sketchId, 0, 0, W, H)] }
}
function circle(sketchId: string, r: number, srcId = `${sketchId}.c0`, ccw = true): ProfileSegment {
  return { kind: 'arc', c: [0, 0], r, a0: 0, a1: Math.PI * 2, ccw, srcId }
}
function thinReq(profile: ProfileRegion, thin: ExtrudeRequest['thin'], end: ExtrudeRequest['end'] = { kind: 'blind', distance: D }, featureId = 'F1'): ExtrudeRequest {
  return { featureId, profiles: [profile], end, op: 'newBody', thin }
}

let engine: GeomEngine
let oracle: OcctKernel
const held: ShapeHandle[] = []
const own = <S extends ShapeHandle>(h: S): S => { held.push(h); return h }

/** STEP round trip into the independent kernel. */
async function readBack(body: BodyHandle): Promise<ShapeHandle> {
  const bytes = await engine.exportStep([body])
  return own(oracle.importStep(new TextDecoder().decode(bytes)))
}
function boxAt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ShapeHandle {
  return own(oracle.translate(own(oracle.makeBox(x1 - x0, y1 - y0, z1 - z0)), x0, y0, z0))
}
/** Volume of the shape inside an axis box (0 when nothing is there). */
function volumeIn(shape: ShapeHandle, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const common = own(oracle.intersect(shape, boxAt(x0, y0, z0, x1, y1, z1)))
  return oracle.getSubShapes(common, 'solid').length === 0 ? 0 : oracle.getVolume(common)
}
function bounds(shape: ShapeHandle): number[] {
  const b = oracle.getBoundingBox(shape, false)
  return [b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax]
}
/** Radius of a cylindrical wall from its area: area = sweep * r * D. */
function radiusOf(g: { surfaceType: string; area: number }, sweep: number): number {
  expect(g.surfaceType).toBe('cylinder')
  return g.area / (sweep * D)
}
function expectBounds(shape: ShapeHandle, want: number[]): void {
  bounds(shape).forEach((v, i) => expect(v, `bound ${i}`).toBeCloseTo(want[i], 4))
}

beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
  oracle = await OcctKernel.init()
}, 120_000)
afterAll(async () => {
  for (const h of held) { try { oracle.release(h) } catch { /* gone */ } }
  oracle?.[Symbol.dispose]()
  await engine.disposeKernel()
})

describe('WO-3233 thin closed walls: rectangle at D = 8, t = 2', () => {
  const cases = [
    { side: 'inside' as const, volume: 1792, box: [0, 0, 0, W, H, D], cavity: [T, T, W - T, H - T] },
    { side: 'outside' as const, volume: 2048, box: [-T, -T, 0, W + T, H + T, D], cavity: [0, 0, W, H] },
    { side: 'center' as const, volume: 1920, box: [-1, -1, 0, W + 1, H + 1, D], cavity: [1, 1, W - 1, H - 1] },
  ]
  for (const c of cases) {
    it(`${c.side}: volume ${c.volume}, bounds, wall section, open cavity, caps`, async () => {
      const r = await engine.makeExtrude(thinReq(rect(), { thickness: T, side: c.side }))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      const vol = (await engine.measure(r.body!, 'volume')).value
      expect(rel(vol, c.volume), `volume ${vol}`).toBeLessThanOrEqual(1e-6)

      const shape = await readBack(r.body!)
      expect(oracle.isValid(shape)).toBe(true)
      expect(oracle.getSubShapes(shape, 'solid')).toHaveLength(1)
      expectBounds(shape, c.box)
      // Mid-height 1 mm slab: the wall section area is V / D at every height.
      expect(volumeIn(shape, -10, -10, 3.5, W + 10, H + 10, 4.5)).toBeCloseTo(c.volume / D, 6)
      // No floor and no lid: the cavity is empty top to bottom.
      const [cx0, cy0, cx1, cy1] = c.cavity
      expect(volumeIn(shape, cx0 + 1e-3, cy0 + 1e-3, -1, cx1 - 1e-3, cy1 - 1e-3, D + 1)).toBe(0)

      // Wall coordinates: e0 is the y = 0 edge, e1 the x = W edge.
      const g = r.elementMap!.geometry!
      const [outY, inY] = c.side === 'inside' ? [0, T] : c.side === 'outside' ? [-T, 0] : [-1, 1]
      expect(g['F1:XTR:S1.e0:thinOut'].centroid.y).toBeCloseTo(outY, 6)
      expect(g['F1:XTR:S1.e0:thinIn'].centroid.y).toBeCloseTo(inY, 6)
      expect(g['F1:XTR:S1.e1:thinOut'].centroid.x).toBeCloseTo(W - outY, 6)
      expect(g['F1:XTR:S1.e1:thinIn'].centroid.x).toBeCloseTo(W - inY, 6)
      // Annular material caps: z = 0 and z = D, each the wall section's area.
      const start = g['F1:XTR:S1.e0:thinCapStart']
      const end = g['F1:XTR:S1.e0:thinCapEnd']
      expect(start.centroid.z).toBeCloseTo(0, 6)
      expect(end.centroid.z).toBeCloseTo(D, 6)
      expect(start.area).toBeCloseTo(c.volume / D, 6)
      expect(end.area).toBeCloseTo(c.volume / D, 6)
      // 4 entities x 2 walls + 2 caps, nothing else.
      expect(r.elementMap!.generated).toHaveLength(10)
      await engine.dispose(r.body!)
    }, 60_000)
  }

  it('missing side means inside (the documented service default)', async () => {
    const r = await engine.makeExtrude(thinReq(rect(), { thickness: T }))
    expect(r.ok).toBe(true)
    expect((await engine.measure(r.body!, 'volume')).value).toBeCloseTo(1792, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('a reversed loop gives the same walls: side follows the material, not the orientation', async () => {
    const forward = rect()
    const reversed: ProfileRegion = {
      ...forward,
      loops: [forward.loops[0].slice().reverse().map((s) => (s.kind === 'line' ? { ...s, a: s.b, b: s.a } : s))],
    }
    for (const side of ['inside', 'outside'] as const) {
      const a = await engine.makeExtrude(thinReq(forward, { thickness: T, side }))
      const b = await engine.makeExtrude(thinReq(reversed, { thickness: T, side }))
      expect(b.ok).toBe(true)
      expect((await engine.measure(b.body!, 'volume')).value).toBeCloseTo((await engine.measure(a.body!, 'volume')).value, 6)
      expect(b.elementMap!.generated).toEqual(a.elementMap!.generated)
      expect(b.elementMap!.geometry!['F1:XTR:S1.e0:thinIn'].centroid.y).toBeCloseTo(a.elementMap!.geometry!['F1:XTR:S1.e0:thinIn'].centroid.y, 9)
      await engine.dispose(a.body!)
      await engine.dispose(b.body!)
    }
  }, 60_000)

  it('blind down and symmetric ends put the caps where the end says', async () => {
    const down = await engine.makeExtrude(thinReq(rect(), { thickness: T, side: 'inside' }, { kind: 'blind', distance: -D }))
    expect(down.ok).toBe(true)
    expectBounds(await readBack(down.body!), [0, 0, -D, W, H, 0])
    expect((await engine.measure(down.body!, 'volume')).value).toBeCloseTo(1792, 6)
    const sym = await engine.makeExtrude(thinReq(rect(), { thickness: T, side: 'inside' }, { kind: 'symmetric', distance: D }))
    expect(sym.ok).toBe(true)
    expectBounds(await readBack(sym.body!), [0, 0, -D / 2, W, H, D / 2])
    expect(sym.resolvedExtrudeEnd).toMatchObject({ kind: 'symmetric', startDistance: -D / 2, endDistance: D / 2 })
    await engine.dispose(down.body!)
    await engine.dispose(sym.body!)
  }, 60_000)

  it('a displaced, rotated sketch plane gives the same wall, lifted onto that plane', async () => {
    const n = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]
    const xd = [1 / Math.sqrt(2), -1 / Math.sqrt(2), 0]
    const origin = { x: 5, y: -3, z: 7 }
    const plane: PlaneDef = { origin, normal: { x: n[0], y: n[1], z: n[2] }, xDir: { x: xd[0], y: xd[1], z: xd[2] } }
    const r = await engine.makeExtrude(thinReq(rect('S1', plane), { thickness: T, side: 'inside' }))
    expect(r.ok).toBe(true)
    expect(rel((await engine.measure(r.body!, 'volume')).value, 1792)).toBeLessThanOrEqual(1e-6)
    const g = r.elementMap!.geometry!
    const h = (p: { x: number; y: number; z: number }): number => (p.x - origin.x) * n[0] + (p.y - origin.y) * n[1] + (p.z - origin.z) * n[2]
    expect(h(g['F1:XTR:S1.e0:thinCapStart'].centroid)).toBeCloseTo(0, 6)
    expect(h(g['F1:XTR:S1.e0:thinCapEnd'].centroid)).toBeCloseTo(D, 6)
    // e0's inner wall sits t in from the y = 0 edge, in sketch coordinates.
    const c = g['F1:XTR:S1.e0:thinIn'].centroid
    const yDir = [n[1] * xd[2] - n[2] * xd[1], n[2] * xd[0] - n[0] * xd[2], n[0] * xd[1] - n[1] * xd[0]]
    expect((c.x - origin.x) * yDir[0] + (c.y - origin.y) * yDir[1] + (c.z - origin.z) * yDir[2]).toBeCloseTo(T, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('draftAngleDeg stays ignored for thin: the wall is straight', async () => {
    const r = await engine.makeExtrude({ ...thinReq(rect(), { thickness: T, side: 'inside' }), draftAngleDeg: 5 })
    expect(r.ok).toBe(true)
    expect((await engine.measure(r.body!, 'volume')).value).toBeCloseTo(1792, 6)
    expectBounds(await readBack(r.body!), [0, 0, 0, W, H, D])
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3233 thin closed walls: circles, holes and arcs', () => {
  it('centered circle R = 10, t = 2: V = 320 pi, walls at radius 11 and 9', async () => {
    const r = await engine.makeExtrude(thinReq({ sketchId: 'S2', plane: xyPlane(0), loops: [[circle('S2', 10)]] }, { thickness: T, side: 'center' }))
    expect(r.ok).toBe(true)
    expect(rel((await engine.measure(r.body!, 'volume')).value, 320 * Math.PI)).toBeLessThanOrEqual(1e-6)
    const shape = await readBack(r.body!)
    expectBounds(shape, [-11, -11, 0, 11, 11, D])
    expect(volumeIn(shape, -6, -6, -1, 6, 6, D + 1)).toBe(0)
    const g = r.elementMap!.geometry!
    expect(radiusOf(g['F1:XTR:S2.c0:thinOut'], 2 * Math.PI)).toBeCloseTo(11, 6)
    expect(radiusOf(g['F1:XTR:S2.c0:thinIn'], 2 * Math.PI)).toBeCloseTo(9, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('nested R = 10 / r = 5 inside t = 1: V = 240 pi as two separate solids', async () => {
    const profile: ProfileRegion = { sketchId: 'S3', plane: xyPlane(0), loops: [[circle('S3', 10, 'S3.o')], [circle('S3', 5, 'S3.h', false)]] }
    const r = await engine.makeExtrude(thinReq(profile, { thickness: 1, side: 'inside' }))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel((await engine.measure(r.body!, 'volume')).value, 240 * Math.PI)).toBeLessThanOrEqual(1e-6)
    const shape = await readBack(r.body!)
    expect(oracle.getSubShapes(shape, 'solid')).toHaveLength(2)
    // Material only in 9..10 and 5..6: the hole stays open, the gap between stays empty.
    expect(volumeIn(shape, -3.5, -3.5, -1, 3.5, 3.5, D + 1)).toBe(0)
    expect(volumeIn(shape, 6.3, -0.5, -1, 8.7, 0.5, D + 1)).toBe(0)
    const g = r.elementMap!.geometry!
    expect(radiusOf(g['F1:XTR:S3.o:thinIn'], 2 * Math.PI)).toBeCloseTo(9, 6)
    expect(radiusOf(g['F1:XTR:S3.h:thinOut'], 2 * Math.PI)).toBeCloseTo(6, 6)
    expect(radiusOf(g['F1:XTR:S3.h:thinIn'], 2 * Math.PI)).toBeCloseTo(5, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('a slot with tangent arcs keeps exact circular walls (inside t = 1)', async () => {
    // Obround: straights y = +-5 from x = 0..20, end arcs R = 5 about (0,0) and (20,0).
    const L = 20, R = 5
    const loop: ProfileSegment[] = [
      { kind: 'line', a: [0, -R], b: [L, -R], srcId: 'S4.b' },
      { kind: 'arc', c: [L, 0], r: R, a0: -Math.PI / 2, a1: Math.PI / 2, ccw: true, srcId: 'S4.r' },
      { kind: 'line', a: [L, R], b: [0, R], srcId: 'S4.t' },
      { kind: 'arc', c: [0, 0], r: R, a0: Math.PI / 2, a1: (3 * Math.PI) / 2, ccw: true, srcId: 'S4.l' },
    ]
    const r = await engine.makeExtrude(thinReq({ sketchId: 'S4', plane: xyPlane(0), loops: [loop] }, { thickness: 1, side: 'inside' }))
    expect(r.ok).toBe(true)
    const expected = (2 * L + Math.PI * (R * R - (R - 1) * (R - 1))) * D
    expect(rel((await engine.measure(r.body!, 'volume')).value, expected)).toBeLessThanOrEqual(1e-6)
    expect(radiusOf(r.elementMap!.geometry!['F1:XTR:S4.r:thinIn'], Math.PI)).toBeCloseTo(R - 1, 6)
    expect(radiusOf(r.elementMap!.geometry!['F1:XTR:S4.r:thinOut'], Math.PI)).toBeCloseTo(R, 6)
    await engine.dispose(r.body!)
  }, 60_000)

  it('a sharp line-arc corner extends the arc to meet the line (D shape, outside t = 1)', async () => {
    // Half disc R = 10 over y = 0. Outside t = 1: circle R = 11 cut by y = -1.
    const loop: ProfileSegment[] = [
      { kind: 'arc', c: [0, 0], r: 10, a0: 0, a1: Math.PI, ccw: true, srcId: 'S5.a' },
      { kind: 'line', a: [-10, 0], b: [10, 0], srcId: 'S5.l' },
    ]
    const r = await engine.makeExtrude(thinReq({ sketchId: 'S5', plane: xyPlane(0), loops: [loop] }, { thickness: 1, side: 'outside' }))
    expect(r.ok).toBe(true)
    const R1 = 11, h = 1
    const grown = Math.PI * R1 * R1 - (R1 * R1 * Math.acos(h / R1) - h * Math.sqrt(R1 * R1 - h * h))
    const expected = (grown - (Math.PI * 100) / 2) * D
    expect(rel((await engine.measure(r.body!, 'volume')).value, expected)).toBeLessThanOrEqual(1e-6)
    const shape = await readBack(r.body!)
    // The R = 11 arc passes x = +-11 at y = 0; the moved line closes it at y = -1.
    expectBounds(shape, [-11, -1, 0, 11, 11, D])
    // Below y = 0 the arc continues down to the moved line: material there.
    expect(volumeIn(shape, 10.5, -1, 0, 10.9, -0.01, D)).toBeGreaterThan(0)
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3233 thin walls past fillets, chamfers and notches (the exact offset, rule 11)', () => {
  // 20 x 10 rectangle, r = 2 corner fillets: area 200 - 4 (r^2 - pi r^2 / 4).
  const RR = 200 - 4 * (4 - Math.PI)
  const rounded = (): ProfileRegion => {
    const r = 2
    const loop: ProfileSegment[] = [
      { kind: 'line', a: [r, 0], b: [20 - r, 0], srcId: 'R.e0' },
      { kind: 'arc', c: [20 - r, r], r, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'R.a0' },
      { kind: 'line', a: [20, r], b: [20, 10 - r], srcId: 'R.e1' },
      { kind: 'arc', c: [20 - r, 10 - r], r, a0: 0, a1: Math.PI / 2, ccw: true, srcId: 'R.a1' },
      { kind: 'line', a: [20 - r, 10], b: [r, 10], srcId: 'R.e2' },
      { kind: 'arc', c: [r, 10 - r], r, a0: Math.PI / 2, a1: Math.PI, ccw: true, srcId: 'R.a2' },
      { kind: 'line', a: [0, 10 - r], b: [0, r], srcId: 'R.e3' },
      { kind: 'arc', c: [r, r], r, a0: Math.PI, a1: (3 * Math.PI) / 2, ccw: true, srcId: 'R.a3' },
    ]
    return { sketchId: 'R', plane: xyPlane(0), loops: [loop] }
  }

  for (const { t, inner } of [{ t: 2, inner: 16 * 6 }, { t: 3, inner: 14 * 4 }]) {
    it(`r = 2 fillets, inside t = ${t}: the inner wall turns a sharp corner, V = (${RR.toFixed(3)} - ${inner}) * 8`, async () => {
      const r = await engine.makeExtrude(thinReq(rounded(), { thickness: t, side: 'inside' }))
      expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
      expect(rel((await engine.measure(r.body!, 'volume')).value, (RR - inner) * D)).toBeLessThanOrEqual(1e-6)
      const shape = await readBack(r.body!)
      expectBounds(shape, [0, 0, 0, 20, 10, D])
      // The inner wall is the plain (20 - 2t) x (10 - 2t) rectangle: its corner region is empty.
      expect(volumeIn(shape, t + 1e-3, t + 1e-3, -1, t + 0.3, t + 0.3, D + 1)).toBe(0)
      const g = r.elementMap!.geometry!
      expect(g['F1:XTR:R.e0:thinIn'].centroid.y).toBeCloseTo(t, 6)
      expect(g['F1:XTR:R.e0:thinIn'].area).toBeCloseTo((20 - 2 * t) * D, 6)
      // The fillets keep their outer walls; their inner walls are gone with the corner.
      for (const a of ['a0', 'a1', 'a2', 'a3']) {
        expect(r.elementMap!.generated).toContain(`F1:XTR:R.${a}:thinOut`)
        expect(r.elementMap!.generated.some((id) => id.startsWith(`F1:XTR:R.${a}:thinIn`))).toBe(false)
      }
      await engine.dispose(r.body!)
    }, 60_000)
  }

  it('a 0.5 mm chamfer, inside t = 1: the chamfer wall vanishes inside, V = (199.875 - 18 * 8) * 8', async () => {
    const loop: ProfileSegment[] = [
      { kind: 'line', a: [0, 0], b: [20, 0], srcId: 'C.e0' },
      { kind: 'line', a: [20, 0], b: [20, 9.5], srcId: 'C.e1' },
      { kind: 'line', a: [20, 9.5], b: [19.5, 10], srcId: 'C.e4' },
      { kind: 'line', a: [19.5, 10], b: [0, 10], srcId: 'C.e2' },
      { kind: 'line', a: [0, 10], b: [0, 0], srcId: 'C.e3' },
    ]
    const r = await engine.makeExtrude(thinReq({ sketchId: 'C', plane: xyPlane(0), loops: [loop] }, { thickness: 1, side: 'inside' }))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel((await engine.measure(r.body!, 'volume')).value, (199.875 - 144) * D)).toBeLessThanOrEqual(1e-6)
    expect(r.elementMap!.generated).toContain('F1:XTR:C.e4:thinOut')
    expect(r.elementMap!.generated).not.toContain('F1:XTR:C.e4:thinIn')
    await engine.dispose(r.body!)
  }, 60_000)

  it('a 2 mm notch grown by 1.5 fills in: outside wall V = (43 * 23 - 780) * 8', async () => {
    const notch: ProfileRegion = {
      sketchId: 'S6', plane: xyPlane(0), loops: [[
        { kind: 'line', a: [0, 0], b: [40, 0], srcId: 'S6.a' },
        { kind: 'line', a: [40, 0], b: [40, 20], srcId: 'S6.b' },
        { kind: 'line', a: [40, 20], b: [21, 20], srcId: 'S6.c' },
        { kind: 'line', a: [21, 20], b: [21, 10], srcId: 'S6.d' },
        { kind: 'line', a: [21, 10], b: [19, 10], srcId: 'S6.e' },
        { kind: 'line', a: [19, 10], b: [19, 20], srcId: 'S6.f' },
        { kind: 'line', a: [19, 20], b: [0, 20], srcId: 'S6.g' },
        { kind: 'line', a: [0, 20], b: [0, 0], srcId: 'S6.h' },
      ]],
    }
    const r = await engine.makeExtrude(thinReq(notch, { thickness: 1.5, side: 'outside' }))
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
    expect(rel((await engine.measure(r.body!, 'volume')).value, (43 * 23 - 780) * D)).toBeLessThanOrEqual(1e-6)
    const shape = await readBack(r.body!)
    expectBounds(shape, [-1.5, -1.5, 0, 41.5, 21.5, D])
    // The notch itself is now wall material, right up to the grown top edge.
    expect(volumeIn(shape, 19.2, 10.2, 0, 20.8, 21.3, D)).toBeCloseTo(1.6 * 11.1 * D, 6)
    await engine.dispose(r.body!)
  }, 60_000)
})

describe('WO-3233 thin refusals: one line, nothing touched', () => {
  const refusal = (r: { ok: boolean; body?: unknown; diagnostics: Array<{ params?: Record<string, string | number> }> }): string => {
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    const reason = String(r.diagnostics[0]?.params?.reason ?? '')
    expect(reason.length).toBeGreaterThan(0)
    expect(reason).not.toContain('\n')
    return reason
  }

  it('zero, negative and non-finite thickness are refused, never read as another mode', async () => {
    for (const thickness of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(refusal(await engine.makeExtrude(thinReq(rect(), { thickness, side: 'inside' })))).toMatch(/thickness must be a positive finite length/)
    }
  }, 60_000)

  it('a wall whose inner loop vanishes is refused before the kernel offsets it', async () => {
    // 40 x 20 inside: at t = 10 the inner offset is a line, beyond that nothing.
    expect(refusal(await engine.makeExtrude(thinReq(rect(), { thickness: 10, side: 'inside' })))).toMatch(/cannot be built on S1\.e0: the offset closes the loop to nothing/)
    expect(refusal(await engine.makeExtrude(thinReq(rect(), { thickness: 12, side: 'inside' })))).toMatch(/cannot be built on S1\.e0: the offset closes the loop to nothing/)
    expect(refusal(await engine.makeExtrude(thinReq({ sketchId: 'S2', plane: xyPlane(0), loops: [[circle('S2', 5)]] }, { thickness: 5, side: 'inside' })))).toMatch(/cannot be built on S2\.c0: the offset closes the loop to nothing/)
  }, 60_000)

  it('end kinds other than Blind/Symmetric and unknown sides are refused in one line', async () => {
    // WO-3235: target-driven Thin ends are supported now, so throughAll without a
    // target is refused for the missing target body - not with the old blanket
    // "Blind or Symmetric ends only" refusal.
    expect(refusal(await engine.makeExtrude(thinReq(rect(), { thickness: T }, { kind: 'throughAll', direction: 1, targets: [] })))).toMatch(/Through all requires at least one target body/)
    expect(refusal(await engine.makeExtrude(thinReq(rect(), { thickness: T, side: 'sideways' as never })))).toMatch(/side must be inside, outside or center/)
  }, 60_000)

  it('after refusals the source body survives and a fresh thin extrude + STEP export succeed', async () => {
    const source = await engine.makeExtrude({ featureId: 'F0', profiles: [rect('S0')], end: { kind: 'blind', distance: D }, op: 'newBody' })
    expect(source.ok).toBe(true)
    for (const thickness of [10, 12, Number.NaN]) {
      refusal(await engine.makeExtrude({ ...thinReq(rect(), { thickness, side: 'inside' }), op: 'cut', target: source.body! }))
    }
    expect((await engine.measure(source.body!, 'volume')).value).toBeCloseTo(W * H * D, 6)
    const fresh = await engine.makeExtrude(thinReq(rect(), { thickness: T, side: 'outside' }))
    expect(fresh.ok).toBe(true)
    const shape = await readBack(fresh.body!)
    expect(oracle.getVolume(shape)).toBeCloseTo(2048, 6)
    const sourceBack = await readBack(source.body!)
    expect(oracle.getVolume(sourceBack)).toBeCloseTo(W * H * D, 6)
    await engine.dispose(fresh.body!)
    await engine.dispose(source.body!)
  }, 60_000)
})
