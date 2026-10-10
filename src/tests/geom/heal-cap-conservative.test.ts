// GEO-11-R2 (blocker 1, CONSERVATIVE-OR-REFUSE) — capRadialExtent must return a
// PROVEN upper bound on a cap's true radial reach, or Infinity. The R1 fix measured
// the extent from ACTUAL wire geometry but kept two NON-conservative fallbacks the
// auditor reproduced blocker 1 through:
//   - planeExtent UNDER-stated a structural slab (24x24 plate top read 12 <= thr,
//     mis-classified as a cap and dropped -> the plate-top open shell resurrected);
//   - the bbox corners OVER-stated a circular cap by sqrt(2) (a legitimate d20
//     shoulder read 14.14 > thr and was wrongly excluded);
//   - fixed 17-point sampling has no error bound, so a narrow between-samples
//     extremum was UNDER-measured (radius 1 where the true reach was 20).
//
// R2 deletes both fallbacks: ANY geometry read failure (wire/edge/curve/pole) is
// Infinity, exact extrema serve circles/lines, and the NURBS control polygon bounds
// everything else. Overstating merely EXCLUDES a face (kept in the sew set) and the
// final watertight gate REFUSES loudly — the safe direction; understating is the
// defect. Every case below FAILS against the R1 code (finite fallback / sampled
// underestimate) and PASSES after — see coordination/evidence/GEO-11/mutation-proof-R2.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle, Vec3 } from 'occt-wasm'
import {
  capRadialExtent, recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs,
} from '../../geom/worker/defeature.ts'
import type { FaceRec } from '../../geom/worker/defeature.ts'

// ---------------------------------------------------------------------------
// A fault kernel: a transparent Proxy over the real kernel that throws for a
// TARGET face handle on `outerWire` and/or `uvBounds`, delegating everything else.
// `outerWireFromCall` throws only from the Nth call onward on that handle, so a
// seeding read (hostLoops) can succeed while the LATER cap-classification read
// (capRadialExtent) throws — the exact isolation the auditor used.
// ---------------------------------------------------------------------------
interface FaultOpts {
  target: number
  outerWireFromCall?: number   // throw on outerWire(target) at call >= this (1-based); default: never
  uvBounds?: boolean           // throw on uvBounds(target); default: false
}
function faultKernel(real: OcctKernel, opts: FaultOpts): OcctKernel {
  const owCalls = new Map<number, number>()
  return new Proxy(real as object, {
    get(t, prop, recv) {
      const orig = Reflect.get(t, prop, recv)
      if (typeof orig !== 'function') return orig
      if (prop === 'outerWire' && opts.outerWireFromCall !== undefined) {
        return (h: ShapeHandle) => {
          const n = (owCalls.get(h as number) ?? 0) + 1
          owCalls.set(h as number, n)
          if (h as number === opts.target && n >= opts.outerWireFromCall!) throw new Error(`fault: outerWire(${h as number}) call#${n}`)
          return (orig as (h: ShapeHandle) => unknown).call(t, h)
        }
      }
      if (prop === 'uvBounds' && opts.uvBounds) {
        return (h: ShapeHandle) => {
          if (h as number === opts.target) throw new Error(`fault: uvBounds(${h as number})`)
          return (orig as (h: ShapeHandle) => unknown).call(t, h)
        }
      }
      return (orig as (...a: unknown[]) => unknown).bind(t)
    },
  }) as unknown as OcctKernel
}

const AXIS: Vec3 = { x: 0, y: 0, z: 1 }
/** the concentric axis line through (cx,cy) — hole seeds use the loop centre. */
function axisAt(cx: number, cy: number): Vec3 { return { x: cx, y: cy, z: 0 } }

/** build the auditor's d20 counterbore: 60x40x15 box, pilot Ø6 total depth 10,
 *  counterbore Ø20 x 4 deep, concentric on the box centre (30,20). */
function counterbore(k: OcctKernel): ShapeHandle {
  const box = k.makeBox(60, 40, 15)
  const cbore = k.translate(k.makeCylinder(10, 5), 30, 20, 11)
  const pilot = k.translate(k.makeCylinder(3, 11), 30, 20, 5)
  const drilled = k.cut(k.cut(box, cbore), pilot)
  try { k.release(box) } catch { /* */ }
  return drilled
}

/** find the counterbore SHOULDER: the annular planar cap at z~=11 concentric with
 *  (30,20), area ~= pi*(10^2 - 3^2) = 285.9. */
function findShoulder(recs: FaceRec[]): FaceRec {
  const hit = recs.find((r) => r.type === 'plane' &&
    Math.hypot(r.centroid.x - 30, r.centroid.y - 20) < 0.5 &&
    Math.abs(r.centroid.z - 11) < 0.5 && r.area > 200 && r.area < 360)
  if (!hit) throw new Error('counterbore shoulder not found')
  return hit
}

describe('GEO-11-R2 capRadialExtent is conservative-or-refuse (real occt-wasm kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- #c1 exact circle extremum: a concentric circular cap returns its true R,
  //         WELL under thr — never the R*sqrt(2) the bbox corners gave (criterion 4).
  it('#c1 a circular counterbore shoulder (R=10) measures ~10, not R*sqrt(2)=14.14', () => {
    const s = counterbore(k)
    const recs = gatherFaces(k, s)
    const shoulder = findShoulder(recs)
    const ext = capRadialExtent(k, shoulder, axisAt(30, 20), AXIS)
    expect(ext, 'circle extremum is the true outer radius R=10').toBeGreaterThan(9.9)
    expect(ext, 'NOT the sqrt(2)-inflated bbox corner (14.14)').toBeLessThan(10.2)
    releaseFaceRecs(k, recs)
    try { k.release(s) } catch { /* */ }
  }, 120_000)

  // ---- #c2 exact line endpoints: the box's structural top face (a 60x40 rectangle)
  //         reads its true far-corner reach, FAR past any bore thr -> excluded.
  it('#c2 a structural rectangular top face measures its true far-corner reach', () => {
    const s = counterbore(k)
    const recs = gatherFaces(k, s)
    // the z=15 top: planar, +Z, centroid ~ (30,20,15).
    const top = recs.find((r) => r.type === 'plane' && r.normal.z > 0.9 && Math.abs(r.centroid.z - 15) < 0.5)!
    const ext = capRadialExtent(k, top, axisAt(30, 20), AXIS)
    // far corner of a 60x40 face about (30,20) is hypot(30,20) = 36.06.
    expect(ext, 'line endpoints give the true far corner (~36)').toBeGreaterThan(35)
    releaseFaceRecs(k, recs)
    try { k.release(s) } catch { /* */ }
  }, 120_000)

  // ---- #c4 outerWire read FAILURE -> Infinity (deletes the planeExtent fallback).
  //         R1: planeExtent.major/2 = 10 (finite) — mis-included. R2: Infinity.
  it('#c4 outerWire-throw on a cap returns Infinity (no planeExtent fallback)', () => {
    const s = counterbore(k)
    const recs = gatherFaces(k, s)
    const shoulder = findShoulder(recs)
    expect(shoulder.planeExtent, 'the shoulder carries a planeExtent the R1 fallback would use').toBeDefined()
    const fk = faultKernel(k, { target: shoulder.handle as number, outerWireFromCall: 1 })
    const ext = capRadialExtent(fk, shoulder, axisAt(30, 20), AXIS)
    // R1 (planeExtent fallback) returns ~10 (finite <= thr, mis-included); R2 refuses.
    expect(ext, 'an unreadable outer wire fails closed to Infinity').toBe(Infinity)
    releaseFaceRecs(k, recs)
    try { k.release(s) } catch { /* */ }
  }, 120_000)

  // ---- #c5 outerWire + UV read FAILURE -> Infinity (deletes the bbox fallback).
  //         planeExtent absent (UV threw), so R1 fell to bbox corners = 14.14
  //         (finite); R2 refuses.
  it('#c5 outerWire+UV-throw on a cap returns Infinity (no bbox-corner fallback)', () => {
    const s = counterbore(k)
    const recs = gatherFaces(k, s)
    const shoulder = findShoulder(recs)
    // UV threw during gatherFaces -> planeExtent would be undefined; emulate that.
    const noExtent: FaceRec = { ...shoulder, planeExtent: undefined }
    const fk = faultKernel(k, { target: shoulder.handle as number, outerWireFromCall: 1, uvBounds: true })
    const ext = capRadialExtent(fk, noExtent, axisAt(30, 20), AXIS)
    // R1 (bbox corners) returns 14.14 (finite); R2 refuses.
    expect(ext, 'no wire and no planeExtent fails closed to Infinity').toBe(Infinity)
    releaseFaceRecs(k, recs)
    try { k.release(s) } catch { /* */ }
  }, 120_000)

  // ---- #c6 a narrow BETWEEN-SAMPLES extremum (criterion 2): the old fixed 17-point
  //         sampling read radius ~1 while the curve truly reached 20. The NURBS
  //         control polygon bounds the whole curve, so R2 measures >= 20.
  it('#c6 a narrow between-samples curve extremum is bounded >= its true reach (poles hull)', () => {
    // a curve double: every parameter sample reads perpDist ~1, but a control pole
    // sits at perpDist 20 (the bulge the samples miss). axis = z through the origin.
    const FACE = 900 as ShapeHandle, WIRE = 901 as ShapeHandle, EDGE = 902 as ShapeHandle
    const V1 = 903 as ShapeHandle, V2 = 904 as ShapeHandle
    const dbl = {
      outerWire: (_f: ShapeHandle) => WIRE,
      getSubShapes: (h: ShapeHandle, t: string) =>
        (h === WIRE && t === 'edge') ? [EDGE] : (h === EDGE && t === 'vertex') ? [V1, V2] : [],
      vertexPosition: (_v: ShapeHandle): Vec3 => ({ x: 1, y: 0, z: 0 }),
      curveType: (_e: ShapeHandle) => 'bspline',
      curveParameters: (_e: ShapeHandle) => ({ first: 0, last: 1 }),
      curvePointAtParam: (_e: ShapeHandle, _t: number): Vec3 => ({ x: 1, y: 0, z: 0 }),
      getNurbsCurveData: (_e: ShapeHandle) => ({
        degree: 2, rational: false, periodic: false, knots: [0, 0, 0, 1, 1, 1], multiplicities: [3, 3],
        poles: [1, 0, 0, 20, 0, 0, 1, 0, 0], weights: [1, 1, 1],
      }),
      release: (_h: ShapeHandle) => { /* */ },
    }
    // a FaceRec whose fallbacks (if R1 reached them) are ALSO small, so the only way
    // to reach 20 is the pole hull — isolating the sampling defect.
    const rec: FaceRec = {
      handle: FACE, hash: 1, type: 'plane', centroid: { x: 1, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 }, area: 1,
      bbox: { xmin: 0, ymin: -1, zmin: 0, xmax: 2, ymax: 1, zmax: 0 },
      planeExtent: { major: 2, minor: 2 }, innerLoops: 0, neighbours: [],
    }
    const ext = capRadialExtent(dbl as unknown as OcctKernel, rec, { x: 0, y: 0, z: 0 }, AXIS)
    // R1 (17 uniform samples + vertices, all perpDist ~1) reported ~1; R2 bounds by
    // the control polygon and reports >= the true reach 20 (or Infinity).
    expect(ext, 'the between-samples extremum is inside the pole hull -> >= 20').toBeGreaterThanOrEqual(20)
  })

  // ---- #e1 PROBE A end-to-end (criterion 1a): a 24x24 four-boss plate with a
  //         centred Ø20 blind hole. Force the plate top's LATER (cap-classification)
  //         outerWire read to throw. R1's planeExtent fallback (12 <= thr 13) mis-
  //         classifies the structural plate top as the hole's FLOOR and DROPS it —
  //         a wrong-classification heal that sews an open-topped SHELL (heal.ok=false).
  //         R2 reads Infinity, EXCLUDES it from the caps, and — because the plate top
  //         is the hole's HOST (its opening is an inner loop, untrimmed via the inner
  //         wires, not outerWire) — the heal completes CORRECTLY to a solid. The
  //         can-fail gates: the plate top is NOT in dropHashes, and the heal succeeds.
  it('#e1 probe A: an unreadable structural plate top is NOT mis-dropped as a cap; the heal is a correct solid, not a shell', () => {
    const plate = k.makeBox(24, 24, 10)
    const b1 = k.fuse(plate, k.translate(k.makeBox(4, 4, 4), 0, 0, 10))
    const b2 = k.fuse(b1, k.translate(k.makeBox(4, 4, 4), 20, 0, 10))
    const b3 = k.fuse(b2, k.translate(k.makeBox(4, 4, 4), 0, 20, 10))
    const body = k.fuse(b3, k.translate(k.makeBox(4, 4, 4), 20, 20, 10))
    // centred Ø20 blind hole from the top (z=10) down 6 -> floor at z=4.
    const drilled = k.cut(body, k.translate(k.makeCylinder(10, 8), 12, 12, 4))

    const recs = gatherFaces(k, drilled)
    // the plate TOP: planar +Z at z~=10 (below the boss tops z=14), centred on axis.
    const plateTop = recs.find((r) => r.type === 'plane' && r.normal.z > 0.9 &&
      Math.abs(r.centroid.z - 10) < 0.5 && Math.hypot(r.centroid.x - 12, r.centroid.y - 12) < 1.5)
    expect(plateTop, 'the structural plate top is present as a cap candidate').toBeDefined()

    // throw the plate top's outerWire from its SECOND read on: hostLoops (seeding)
    // succeeds; capRadialExtent (cap classification) throws.
    const fk = faultKernel(k, { target: plateTop!.handle as number, outerWireFromCall: 2 })
    const feats = recognizeFeatures(fk, drilled, recs)
    const hole = feats.find((f) => f.removable && (f.type === 'blindHole' || f.type === 'throughHole'))
    expect(hole, 'the blind hole is still recognized (seeding read succeeded)').toBeDefined()

    // THE CAN-FAIL GATE (R1: planeExtent=12<=13 -> plate top IN dropHashes; R2: Infinity -> OUT):
    expect(hole!.dropHashes, 'a structural slab whose extent cannot be read is NOT dropped as a cap')
      .not.toContain(plateTop!.hash)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(fk, drilled, [hole!], scratch, recs)
    // THE CAN-FAIL GATE (R1: plate top dropped -> open-topped shell, heal.ok=false;
    // R2: plate top kept as host -> correct solid, heal.ok=true):
    expect(heal.ok, 'the heal completes correctly instead of shelling on a mis-dropped slab').toBe(true)
    const healed = heal.shape as ShapeHandle
    expect(k.isSolid(healed), 'the healed result is a genuine solid, not a shell').toBe(true)

    for (const s of scratch) if (s !== healed) { try { k.release(s) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(drilled) } catch { /* */ }
  }, 120_000)

  // ---- #e2 PROBE B end-to-end (criterion 1b): the d20 counterbore. Force the
  //         shoulder's LATER outerWire read to throw. R1's planeExtent fallback
  //         (major/2 = 10 <= thr 13) mis-INCLUDES the unreadable shoulder and the
  //         heal SUCCEEDS on an estimate (silent mis-heal). R2 reads Infinity,
  //         EXCLUDES the shoulder, and the heal REFUSES (open shell -> watertight gate).
  it('#e2 probe B: an unreadable counterbore shoulder makes the heal REFUSE, not mis-heal on an estimate', () => {
    const s = counterbore(k)
    const recs = gatherFaces(k, s)
    const shoulder = findShoulder(recs)

    const fk = faultKernel(k, { target: shoulder.handle as number, outerWireFromCall: 2 })
    const feats = recognizeFeatures(fk, s, recs)
    const cb = feats.find((f) => f.removable && f.type === 'counterboreStack')
    expect(cb, 'the counterbore is still recognized').toBeDefined()
    // R2: the unreadable shoulder is EXCLUDED, so it is NOT dropped.
    expect(cb!.dropHashes, 'the unreadable shoulder is excluded from the cap set').not.toContain(shoulder.hash)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(fk, s, [cb!], scratch, recs)
    // THE CAN-FAIL GATE (R1: shoulder mis-included via planeExtent -> heal.ok true; R2: refuses):
    expect(heal.ok, 'the heal refuses rather than mis-healing on an unread-geometry estimate').toBe(false)
    expect(heal.reason, 'the refusal is named (final watertight gate)').toBeDefined()

    for (const scr of scratch) { try { k.release(scr) } catch { /* */ } }
    releaseFaceRecs(k, recs)
    try { k.release(s) } catch { /* */ }
  }, 120_000)
})
