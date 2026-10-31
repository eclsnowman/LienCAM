// WO-3235 (WO-3173 Draft A3): a Thin extrude ends at a face, datum plane,
// vertex, part, the next body or through all - decided against the wall
// section itself, never the filled-in profile. Ordinary-solid target policy is
// unchanged: Up to face / plane / vertex use the target's own plane, Through all
// the targets' extent, and Up to next / part need a planar face that FULLY
// covers what is being extruded - here each connected wall, on its own.
//
// Independent truth (analytic, sketch on z = 0):
//   40 x 20 rectangle, t = 2 inside: wall section A = 40*20 - 36*16 = 224 mm2,
//   hollow centre 2..38 x 2..18.  A wall h high is 224 h mm3.
//   Two 20 x 20 squares (x 0..20 and 30..50), t = 2 inside: 144 mm2 each.
//   40 x 20 with an r = 4 hole at (20, 10), t = 1 inside: outer wall
//   800 - 38*18 = 116 mm2, hole wall pi(5^2 - 4^2) = 9 pi mm2.
// Volumes come from the returned body; the per-wall heights are also read in
// a SEPARATE kernel from the STEP export, slab by slab.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ExtrudeRequest, OpResult, ProfileRegion, ResolvedExtrudePlaneTarget, ResolvedExtrudeTarget } from '../../geom/geom-service.ts'
import { vertexId } from '../../doc/stable-id.ts'
import { rectLoop, rectWithHole, xyPlane } from './fixtures/profiles.ts'

const MODEL_ITEM = 'MODEL-1'
const T = 2
const A = 40 * 20 - 36 * 16

let engine: GeomEngine
let oracle: OcctKernel
const held: ShapeHandle[] = []
const own = <S extends ShapeHandle>(h: S): S => { held.push(h); return h }

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

const rect = (sketchId = 'S1'): ProfileRegion => ({ sketchId, plane: xyPlane(0), loops: [rectLoop(sketchId, 0, 0, 40, 20)] })

function thin(featureId: string, end: ExtrudeRequest['end'], profiles: [ProfileRegion, ...ProfileRegion[]] = [rect()], thickness = T): ExtrudeRequest {
  return { featureId, profiles, end, op: 'newBody', modelItemId: MODEL_ITEM, thin: { thickness, side: 'inside' } }
}
const bodyTarget = (bodyFeatureId: string, body: BodyHandle, modelItemId = MODEL_ITEM): ResolvedExtrudeTarget =>
  ({ identity: { modelItemId, bodyFeatureId }, body })
const faceTarget = (bodyFeatureId: string, body: BodyHandle, stableId: string, modelItemId = MODEL_ITEM): ResolvedExtrudeTarget =>
  ({ identity: { modelItemId, bodyFeatureId, subshape: { kind: 'face', stableId } }, body })

/** An ordinary solid box x0..x1, y0..y1, z0..z1 as a target body. */
async function box(featureId: string, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Promise<BodyHandle> {
  const r = await engine.makeExtrude({
    featureId,
    profiles: [{ sketchId: `${featureId}S`, plane: xyPlane(z0), loops: [rectLoop(`${featureId}S`, x0, y0, x1, y1)] }],
    end: { kind: 'blind', distance: z1 - z0 },
    op: 'newBody',
  })
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
  return r.body!
}

function built(r: OpResult): BodyHandle {
  expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true)
  return r.body!
}
const volume = async (b: BodyHandle): Promise<number> => (await engine.measure(b, 'volume')).value
const refusal = (r: OpResult): { code: string; reason: string } => {
  expect(r.ok).toBe(false)
  return { code: r.diagnostics[0].code, reason: String(r.diagnostics[0].params?.reason) }
}

/** STEP round trip into the independent kernel; the volume in an axis box. */
async function readBack(body: BodyHandle): Promise<ShapeHandle> {
  const bytes = await engine.exportStep([body])
  return own(oracle.importStep(new TextDecoder().decode(bytes)))
}
function volumeIn(shape: ShapeHandle, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const slab = own(oracle.translate(own(oracle.makeBox(x1 - x0, y1 - y0, z1 - z0)), x0, y0, z0))
  const common = own(oracle.intersect(shape, slab))
  return oracle.getSubShapes(common, 'solid').length === 0 ? 0 : oracle.getVolume(common)
}

describe('WO-3235 Thin walls end at a target', () => {
  it('Up to face stops every wall on the face plane; a signed offset falls short or extends', async () => {
    try {
      const target = await box('B1', 0, 0, 40, 20, 10, 15)
      const face = faceTarget('B1', target, 'B1:XTR:B1S:capStart')
      const at = built(await engine.makeExtrude(thin('F1', { kind: 'toFace', direction: 1, target: face })))
      expect(await volume(at)).toBeCloseTo(A * 10, 6)
      const short = await engine.makeExtrude(thin('F2', { kind: 'toFace', direction: 1, target: face, offset: -2 }))
      expect(await volume(built(short))).toBeCloseTo(A * 8, 6)
      expect(short.resolvedExtrudeEnd).toEqual({ kind: 'toFace', startDistance: 0, endDistance: 8, targets: [face.identity] })
      expect(await volume(built(await engine.makeExtrude(thin('F3', { kind: 'toFace', direction: 1, target: face, offset: 3 }))))).toBeCloseTo(A * 13, 6)
      // Up to face uses the face's plane, as for a solid: a face over only the
      // hollow centre still names the plane every wall stops at.
      const centre = await box('B2', 10, 6, 30, 14, 12, 15)
      const centreFace = faceTarget('B2', centre, 'B2:XTR:B2S:capStart')
      expect(await volume(built(await engine.makeExtrude(thin('F4', { kind: 'toFace', direction: 1, target: centreFace }))))).toBeCloseTo(A * 12, 6)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it.each([1, -1] as const)('Up to datum plane, direction %s', async (direction) => {
    try {
      const target: ResolvedExtrudePlaneTarget = {
        identity: { modelItemId: MODEL_ITEM, planeFeatureId: `datum:${direction}` },
        plane: { origin: { x: 0, y: 0, z: direction * 12 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
      }
      const r = await engine.makeExtrude(thin(`FD${direction}`, { kind: 'toFace', direction, target, offset: -1 }))
      expect(await volume(built(r))).toBeCloseTo(A * 11, 6)
      expect(r.resolvedExtrudeEnd).toEqual({ kind: 'toFace', startDistance: 0, endDistance: direction * 11, targets: [target.identity] })
      const shape = await readBack(r.body!)
      const b = oracle.getBoundingBox(shape, false)
      expect(direction === 1 ? b.zmax : b.zmin).toBeCloseTo(direction * 11, 4)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  // Audit 2026-10-29: a plane NOT parallel to the sketch. Wall section 224 mm2
  // with its area centroid at x = 20, so under z = 10 + x the wall holds
  // 224 * (10 + 20) = 6720 mm3, and its end cap lies ON the plane (normal
  // along (-1, 0, 1)), never a flat cap at one distance (2240 mm3).
  // `normal` is |cos| between the end cap's normal and the plane normal
  // (-direction, 0, 1); `onPlane` the cap centroid's height off z = +-(10 + x).
  const tiltedCap = (r: OpResult, direction: 1 | -1 = 1): { normal: number; onPlane: number } => {
    const caps = Object.entries(r.elementMap!.geometry!).filter(([id]) => id.endsWith(':thinCapEnd'))
    expect(caps).toHaveLength(1)
    const s = caps[0][1]
    const n = s.normal!
    return {
      normal: Math.abs(-direction * n.x + n.z) / Math.SQRT2 / Math.hypot(n.x, n.y, n.z),
      onPlane: Math.abs(s.centroid.z) - (10 + Math.abs(s.centroid.x)),
    }
  }

  it.each([1, -1] as const)('Up to a tilted datum plane ends every wall on that plane, direction %s', async (direction) => {
    try {
      const target: ResolvedExtrudePlaneTarget = {
        identity: { modelItemId: MODEL_ITEM, planeFeatureId: `tilted:${direction}` },
        plane: { origin: { x: 0, y: 0, z: direction * 10 }, normal: { x: -direction, y: 0, z: 1 }, xDir: { x: 0, y: 1, z: 0 } },
      }
      const r = await engine.makeExtrude(thin(`FT${direction}`, { kind: 'toFace', direction, target }))
      expect(await volume(built(r))).toBeCloseTo(A * 30, 4)
      expect(tiltedCap(r, direction).normal).toBeCloseTo(1, 6)
      expect(tiltedCap(r, direction).onPlane).toBeCloseTo(0, 4)
      const ids = r.elementMap!.generated
      expect(ids.filter((id) => id.includes(':thinCap'))).toHaveLength(2)
      expect(ids.some((id) => id.endsWith(':thinWall'))).toBe(false)
      expect(r.resolvedExtrudeEnd?.targets).toEqual([target.identity])
      const b = oracle.getBoundingBox(await readBack(r.body!), false)
      expect(direction === 1 ? b.zmax : -b.zmin).toBeCloseTo(50, 4)
      expect(direction === 1 ? b.zmin : -b.zmax).toBeCloseTo(0, 4)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('Up to a tilted body face ends every wall on the face plane, with its offset', async () => {
    try {
      // A slab sketched on the plane z = 10 + x: its start cap is that plane.
      const n = { x: -Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }
      const slab = built(await engine.makeExtrude({
        featureId: 'BT',
        profiles: [{ sketchId: 'BTS', plane: { origin: { x: 0, y: 0, z: 10 }, normal: n, xDir: { x: 0, y: 1, z: 0 } }, loops: [rectLoop('BTS', -60, -60, 60, 60)] }],
        end: { kind: 'blind', distance: 5 },
        op: 'newBody',
      }))
      const face = faceTarget('BT', slab, 'BT:XTR:BTS:capStart')
      const r = await engine.makeExtrude(thin('FTF', { kind: 'toFace', direction: 1, target: face }))
      expect(await volume(built(r))).toBeCloseTo(A * 30, 4)
      expect(tiltedCap(r).normal).toBeCloseTo(1, 6)
      expect(tiltedCap(r).onPlane).toBeCloseTo(0, 4)
      expect(r.resolvedExtrudeEnd?.targets).toEqual([face.identity])
      // The offset moves the plane along the extrusion: z = 12 + x.
      const off = await engine.makeExtrude(thin('FTO', { kind: 'toFace', direction: 1, target: face, offset: 2 }))
      expect(await volume(built(off))).toBeCloseTo(A * 32, 4)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('a tilted plane that meets the wall footprint is refused by name, never built', async () => {
    try {
      // z = x - 10 is behind the sketch for x < 10: part of the wall would end
      // behind the sketch plane.
      const crossing: ResolvedExtrudePlaneTarget = {
        identity: { modelItemId: MODEL_ITEM, planeFeatureId: 'tilted:crossing' },
        plane: { origin: { x: 10, y: 0, z: 0 }, normal: { x: -1, y: 0, z: 1 }, xDir: { x: 0, y: 1, z: 0 } },
      }
      const r = refusal(await engine.makeExtrude(thin('FTX', { kind: 'toFace', direction: 1, target: crossing })))
      expect(r.code).toBe('KERNEL_OP_FAILED')
      expect(r.reason).toMatch(/^Up to plane target 'tilted:crossing' is not ahead of the whole thin wall of S1\.e0/)
      // Ahead of every wall (z = 10 + x), but an offset of -15 crosses it.
      const ahead: ResolvedExtrudePlaneTarget = { ...crossing, plane: { ...crossing.plane, origin: { x: 0, y: 0, z: 10 } } }
      const o = refusal(await engine.makeExtrude(thin('FTY', { kind: 'toFace', direction: 1, target: ahead, offset: -15 })))
      expect(o.reason).toMatch(/terminal offset crosses the thin wall of S1\.e0/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('Up to vertex stops every wall at the vertex height', async () => {
    try {
      const target = await box('BV', 50, 0, 60, 10, 9, 14)
      const corner = vertexId(['BV:XTR:BVS:capStart', 'BV:XTR:BVS.e0:side', 'BV:XTR:BVS.e3:side'])
      const vertex: ResolvedExtrudeTarget = { identity: { modelItemId: MODEL_ITEM, bodyFeatureId: 'BV', subshape: { kind: 'vertex', stableId: corner } }, body: target }
      const r = await engine.makeExtrude(thin('FV', { kind: 'toVertex', direction: 1, target: vertex, offset: 1 }))
      expect(await volume(built(r))).toBeCloseTo(A * 10, 6)
      expect(r.resolvedExtrudeEnd?.targets).toEqual([vertex.identity])
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('Up to part terminates on a face covering only the wall section - one the filled profile would refuse', async () => {
    try {
      // A tube: the same wall, 10 mm higher. Its bottom ring covers exactly the
      // wall section and none of the hollow centre.
      const tube = built(await engine.makeExtrude({
        featureId: 'BT', profiles: [{ sketchId: 'ST', plane: xyPlane(10), loops: [rectLoop('ST', 0, 0, 40, 20)] }],
        end: { kind: 'blind', distance: 5 }, op: 'newBody', thin: { thickness: T, side: 'inside' },
      }))
      const r = await engine.makeExtrude(thin('FP', { kind: 'toPart', direction: 1, target: bodyTarget('BT', tube) }))
      expect(await volume(built(r))).toBeCloseTo(A * 10, 6)
      expect(r.resolvedExtrudeEnd?.endDistance).toBeCloseTo(10, 9)
      expect(r.resolvedExtrudeEnd?.targets.map((t) => t.bodyFeatureId)).toEqual(['BT'])
      // Control: the ordinary solid of the same sketch is not fully covered by
      // the ring, so its unchanged policy refuses.
      const solid = await engine.makeExtrude({ featureId: 'FS', profiles: [rect()], end: { kind: 'toPart', direction: 1, target: bodyTarget('BT', tube) }, op: 'newBody', modelItemId: MODEL_ITEM })
      expect(refusal(solid).reason).toMatch(/no geometry that fully terminates/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('a target over only the hollow centre is missed: Up to next passes it, Up to part refuses it', async () => {
    try {
      const centre = await box('BC', 4, 4, 36, 16, 10, 15)
      const far = await box('BF', -5, -5, 45, 25, 20, 25)
      const r = await engine.makeExtrude(thin('FN', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BC', centre), bodyTarget('BF', far)] }))
      expect(await volume(built(r))).toBeCloseTo(A * 20, 6)
      expect(r.resolvedExtrudeEnd?.endDistance).toBeCloseTo(20, 9)
      expect(r.resolvedExtrudeEnd?.targets.map((t) => t.bodyFeatureId)).toEqual(['BF'])
      const part = refusal(await engine.makeExtrude(thin('FP', { kind: 'toPart', direction: 1, target: bodyTarget('BC', centre) })))
      expect(part.reason).toMatch(/Up to part found no geometry that fully terminates/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('a target covering part of a wall does not terminate it (same coverage policy as a solid)', async () => {
    try {
      const partial = await box('BH', -5, -5, 20, 25, 10, 15)
      const far = await box('BF', -5, -5, 45, 25, 20, 25)
      const r = await engine.makeExtrude(thin('FN', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BH', partial), bodyTarget('BF', far)] }))
      expect(await volume(built(r))).toBeCloseTo(A * 20, 6)
      expect(r.resolvedExtrudeEnd?.targets.map((t) => t.bodyFeatureId)).toEqual(['BF'])
      expect(refusal(await engine.makeExtrude(thin('FP', { kind: 'toPart', direction: 1, target: bodyTarget('BH', partial) }))).reason)
        .toMatch(/fully terminates/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('separate walls stop independently: two squares at 10 and 20', async () => {
    try {
      const squares: [ProfileRegion, ...ProfileRegion[]] = [
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1a', 0, 0, 20, 20)] },
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1b', 30, 0, 50, 20)] },
      ]
      const low = await box('BL', -1, -1, 21, 21, 10, 12)
      const high = await box('BH', 29, -1, 51, 21, 20, 22)
      const r = await engine.makeExtrude(thin('F2', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BL', low), bodyTarget('BH', high)] }, squares))
      const wall = 400 - 256
      expect(await volume(built(r))).toBeCloseTo(wall * 10 + wall * 20, 6)
      expect(r.resolvedExtrudeEnd).toMatchObject({ kind: 'upToNext', startDistance: 0, endDistance: 20 })
      expect(r.resolvedExtrudeEnd?.targets.map((t) => t.bodyFeatureId).sort()).toEqual(['BH', 'BL'])
      const shape = await readBack(r.body!)
      expect(volumeIn(shape, -1, -1, 0, 21, 21, 10)).toBeCloseTo(wall * 10, 4)
      expect(volumeIn(shape, -1, -1, 10, 21, 21, 30)).toBeCloseTo(0, 6)
      expect(volumeIn(shape, 29, -1, 0, 51, 21, 30)).toBeCloseTo(wall * 20, 4)
      // An offset is applied to each wall's own target.
      const off = await engine.makeExtrude(thin('F3', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BL', low), bodyTarget('BH', high)], offset: -4 }, squares))
      expect(await volume(built(off))).toBeCloseTo(wall * 6 + wall * 16, 6)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('the hole wall and the outer wall of one profile stop at their own targets', async () => {
    try {
      const profile = rectWithHole('S1', 40, 20, 20, 10, 4)
      const plug = await box('BP', 14, 4, 26, 16, 10, 12)
      const lid = await box('BL', -1, -1, 41, 21, 20, 22)
      const r = await engine.makeExtrude(thin('FH', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BL', lid), bodyTarget('BP', plug)] }, [profile], 1))
      expect(await volume(built(r))).toBeCloseTo(116 * 20 + 9 * Math.PI * 10, 5)
      const shape = await readBack(r.body!)
      expect(volumeIn(shape, 14, 4, 0, 26, 16, 10)).toBeCloseTo(9 * Math.PI * 10, 4)
      expect(volumeIn(shape, 14, 4, 10, 26, 16, 30)).toBeCloseTo(0, 6)
      // Up to part with the plug alone: the outer wall has nothing over it.
      expect(refusal(await engine.makeExtrude(thin('FQ', { kind: 'toPart', direction: 1, target: bodyTarget('BP', plug) }, [profile], 1))).reason)
        .toMatch(/^the thin wall of S1\.e0: Up to part found no geometry that fully terminates/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('an offset that crosses the profile plane is refused, never clamped', async () => {
    try {
      const target = await box('B1', 0, 0, 40, 20, 10, 15)
      const face = faceTarget('B1', target, 'B1:XTR:B1S:capStart')
      expect(refusal(await engine.makeExtrude(thin('FX', { kind: 'toFace', direction: 1, target: face, offset: -12 }))).reason)
        .toMatch(/terminal offset crosses the profile plane/)
      // Per wall: the low wall's target is 10 away, so -12 crosses for it alone.
      const squares: [ProfileRegion, ...ProfileRegion[]] = [
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1a', 0, 0, 20, 20)] },
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1b', 30, 0, 50, 20)] },
      ]
      const low = await box('BL', -1, -1, 21, 21, 10, 12)
      const high = await box('BH', 29, -1, 51, 21, 20, 22)
      expect(refusal(await engine.makeExtrude(thin('FY', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BL', low), bodyTarget('BH', high)], offset: -12 }, squares))).reason)
        .toMatch(/^the thin wall of S1a\.e0: Up to next target is eligible before offset, but the terminal offset crosses the profile plane/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('Through all runs every wall through the targets', async () => {
    try {
      const target = await box('BA', -5, -5, 45, 25, 5, 30)
      const r = await engine.makeExtrude(thin('FA', { kind: 'throughAll', direction: 1, targets: [bodyTarget('BA', target)] }))
      expect(await volume(built(r))).toBeCloseTo(A * 30, 2)
      expect(r.resolvedExtrudeEnd?.targets).toEqual([{ modelItemId: MODEL_ITEM, bodyFeatureId: 'BA' }])
      const sym = await engine.makeExtrude(thin('FS', { kind: 'throughAll', direction: 1, targets: [bodyTarget('BA', target)], symmetric: true }))
      expect(await volume(built(sym))).toBeCloseTo(A * 60, 2)
      const cut = await engine.makeExtrude({ ...thin('FC', { kind: 'throughAll', direction: 1, targets: [bodyTarget('BA', target)] }), op: 'cut', target })
      expect(await volume(built(cut))).toBeCloseTo(50 * 30 * 25 - A * 25, 2)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('lost, foreign and consumed references report the existing unresolved result and build nothing', async () => {
    try {
      const target = await box('B1', 0, 0, 40, 20, 10, 15)
      const lost = refusal(await engine.makeExtrude(thin('FL', { kind: 'toFace', direction: 1, target: faceTarget('B1', target, 'B1:XTR:B1S:missing') })))
      expect(lost).toEqual({ code: 'REFERENCE_UNRESOLVED', reason: "Up to face target 'B1:XTR:B1S:missing' is lost" })
      const foreign = refusal(await engine.makeExtrude(thin('FF', { kind: 'toPart', direction: 1, target: bodyTarget('B1', target, 'MODEL-2') })))
      expect(foreign.code).toBe('REFERENCE_UNRESOLVED')
      expect(foreign.reason).toMatch(/belongs to Model Item 'MODEL-2', not 'MODEL-1'/)
      const foreignNext = refusal(await engine.makeExtrude(thin('FG', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('B1', target, 'MODEL-2')] })))
      expect(foreignNext.code).toBe('REFERENCE_UNRESOLVED')
      const datum: ResolvedExtrudePlaneTarget = {
        identity: { modelItemId: 'MODEL-2', planeFeatureId: 'datum:foreign' },
        plane: { origin: { x: 0, y: 0, z: 12 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
      }
      expect(refusal(await engine.makeExtrude(thin('FD', { kind: 'toFace', direction: 1, target: datum }))).code).toBe('REFERENCE_UNRESOLVED')
      // Consumed: the target body was spent by a later operation.
      await engine.dispose(target)
      for (const end of [
        { kind: 'toPart', direction: 1, target: bodyTarget('B1', target) },
        { kind: 'upToNext', direction: 1, candidates: [bodyTarget('B1', target)] },
        { kind: 'throughAll', direction: 1, targets: [bodyTarget('B1', target)] },
        { kind: 'toFace', direction: 1, target: faceTarget('B1', target, 'B1:XTR:B1S:capStart') },
      ] as ExtrudeRequest['end'][]) {
        const consumed = refusal(await engine.makeExtrude(thin(`FC-${end.kind}`, end)))
        expect(consumed, end.kind).toEqual({ code: 'REFERENCE_UNRESOLVED', reason: "extrude target body 'B1' is lost (no live kernel body)" })
      }
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('a non-planar target keeps the existing named limitation', async () => {
    try {
      const cyl = built(await engine.makeExtrude({
        featureId: 'BCYL',
        profiles: [{ sketchId: 'SCYL', plane: xyPlane(10), loops: [[{ kind: 'arc', c: [20, 10], r: 5, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'SCYL.c0' }]] }],
        end: { kind: 'blind', distance: 5 },
        op: 'newBody',
      }))
      expect(refusal(await engine.makeExtrude(thin('FN', { kind: 'toFace', direction: 1, target: faceTarget('BCYL', cyl, 'BCYL:XTR:SCYL.c0:side') }))).reason)
        .toMatch(/unsupported non-planar surface 'cylinder'/)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)

  it('a Thin wall to a target keeps its constructed face names', async () => {
    try {
      const target = await box('B1', -5, -5, 45, 25, 10, 15)
      const r = await engine.makeExtrude(thin('F1', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('B1', target)] }))
      const ids = built(r) && r.elementMap!.generated
      expect(ids.filter((id) => id.includes(':thinCap'))).toHaveLength(2)
      expect(ids.some((id) => id.endsWith(':thinWall'))).toBe(false)
      const g = r.elementMap!.geometry!
      const caps = Object.entries(g).filter(([id]) => id.includes(':thinCap')).map(([id, s]) => [id.split(':').at(-1), Math.round(s.centroid.z * 1e6) / 1e6])
      expect(Object.fromEntries(caps)).toEqual({ thinCapStart: 0, thinCapEnd: 10 })
      // Walls stopping at different heights each name their own end cap.
      const squares: [ProfileRegion, ...ProfileRegion[]] = [
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1a', 0, 0, 20, 20)] },
        { sketchId: 'S1', plane: xyPlane(0), loops: [rectLoop('S1b', 30, 0, 50, 20)] },
      ]
      const low = await box('BL', -1, -1, 21, 21, 10, 12)
      const high = await box('BH', 29, -1, 51, 21, 20, 22)
      const two = await engine.makeExtrude(thin('F2', { kind: 'upToNext', direction: 1, candidates: [bodyTarget('BL', low), bodyTarget('BH', high)] }, squares))
      const g2 = built(two) && two.elementMap!.geometry!
      const ends = Object.entries(g2).filter(([id]) => id.endsWith(':thinCapEnd')).map(([id, s]) => [id, Math.round(s.centroid.z * 1e6) / 1e6])
      expect(Object.fromEntries(ends)).toEqual({ 'F2:XTR:S1a.e0:thinCapEnd': 10, 'F2:XTR:S1b.e0:thinCapEnd': 20 })
      expect(two.elementMap!.generated.some((id) => id.endsWith(':thinWall'))).toBe(false)
    } finally {
      await engine.disposeAll()
    }
  }, 60_000)
})
