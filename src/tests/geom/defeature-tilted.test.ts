// GEO-7 — defeature untrim generalization: TILTED planar neighbours (BK-61).
// GEO-6 heals a fillet/chamfer band whose planar neighbours are AXIS-ALIGNED on
// the body bbox (bbox-clip sharp wire). This suite proves the generalized path:
// a band whose two neighbours are BOTH planar at ANY orientation heals by
// extending each neighbour to the neighbours' plane-plane INTERSECTION line
// (main pair) and restoring each end face's rounded corner in-plane; parallel
// planar neighbours (no intersection) and non-planar neighbours keep the
// STRUCTURED refusal. Runs against the REAL occt-wasm kernel in Node.
//
// PRE-WO CONTRAST (two DISTINCT pre-WO failure modes, GEO-7-R1.2):
//  - tilted FILLET: RECOGNITION REFUSAL — pre-WO recognizeFeatures returns the
//    band removable=false, reason "not axis-aligned on the body bbox".
//  - tilted CHAMFER: HEAL FAILURE — pre-WO recognizeFeatures returns it
//    removable=TRUE (4 untrim hashes), then healRemoval FAILS at the bbox-untrim
//    of the tilted neighbour ("not an axis-aligned bbox plane"). It is NOT refused
//    at recognition; it is recognized-but-unhealable.
// This suite asserts the opposite for BOTH (removable + watertight heal + sharp
// edge on the analytic intersection line), so it FAILS against pre-WO defeature.ts.
// GEO-7-R1 also adds the ROTATED any-orientation proof (#5/#6): the SAME bands with
// the whole solid rotated off every axis, where NO neighbour stays axis-aligned on
// the world bbox — pre-R1 the general chamfer branch required >= 2 axis-aligned
// neighbours, so the rotated chamfer was recognized as featureCount 0 (the blocker).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle, Vec3 } from 'occt-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { gatherFaces, recognizeFeatures, healRemoval, releaseFaceRecs, HM } from '../../geom/worker/defeature.ts'

// ---------- vector helpers (analytic assertions) ----------
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const nrm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vec3): Vec3 => { const l = nrm(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l } }
/** Rodrigues rotation of point `p` about the axis (through the ORIGIN) `axis` by
 *  `ang` radians — the SAME right-hand-rule rotation OcctKernel.rotate applies, so
 *  the analytic sharp line can be transformed alongside the solid. */
function rotatePoint(p: Vec3, axis: Vec3, ang: number): Vec3 {
  const kk = unit(axis); const c = Math.cos(ang), s = Math.sin(ang)
  const kc = cross(kk, p); const kd = dot(kk, p)
  return {
    x: p.x * c + kc.x * s + kk.x * kd * (1 - c),
    y: p.y * c + kc.y * s + kk.y * kd * (1 - c),
    z: p.z * c + kc.z * s + kk.z * kd * (1 - c),
  }
}
// GEO-7-R1: the auditor's rotation probe — a non-trivial off-axis rotation that
// leaves NO planar neighbour axis-aligned on the world bbox. Pre-R1 the general
// chamfer branch required >= 2 axis-aligned neighbours, so a rotated chamfer was
// recognized as featureCount 0 (the blocker). ROT_AXIS/ROT_ANG are shared by the
// rotated fillet + chamfer fixtures and the analytic sharp-line transform.
const ROT_AXIS: Vec3 = { x: 1, y: 1, z: 0.25 }
const ROT_ANG = 0.45
function perpDist(p: Vec3, lp: Vec3, dir: Vec3): number {
  const d = sub(p, lp); const along = dot(d, dir)
  return nrm({ x: d.x - along * dir.x, y: d.y - along * dir.y, z: d.z - along * dir.z })
}
function vClose(a: Vec3, b: Vec3, t = 1e-4): boolean { return Math.abs(a.x - b.x) < t && Math.abs(a.y - b.y) < t && Math.abs(a.z - b.z) < t }

// ---------- fixture builders ----------
const W = 40, HLOW = 8, HHIGH = 20, D = 30
// Sharp (un-dressed) top-front edge endpoints — the two roof planes' analytic
// intersection line runs through these (both at y=0).
const P_LOW: Vec3 = { x: W, y: 0, z: HLOW }
const P_HIGH: Vec3 = { x: 0, y: 0, z: HHIGH }
const SHARP_VOL = ((HLOW + HHIGH) / 2) * W * D  // trapezoid area * depth = 16800

/** A right-trapezoid prism: profile (0,0)-(W,0)-(W,HLOW)-(0,HHIGH) extruded in Y.
 *  The top face is a TILTED plane; the front (y=0) face is axis-aligned; left
 *  (x=0) and right (x=W) are the end faces. The top-front edge is the tilted
 *  sharp edge that the fillet/chamfer dresses. */
function trapezoidPrism(k: OcctKernel): ShapeHandle {
  const pts: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: W, y: 0, z: 0 }, P_LOW, P_HIGH]
  const edges: ShapeHandle[] = []
  for (let i = 0; i < 4; i++) edges.push(k.makeLineEdge(pts[i], pts[(i + 1) % 4]))
  const wire = k.makeWire(edges)
  const face = k.makeFace(wire)
  const solid = k.extrude(face, 0, D, 0)
  try { k.release(wire); k.release(face) } catch { /* */ }
  for (const e of edges) { try { k.release(e) } catch { /* */ } }
  return solid
}

/** The tilted top-front edge of the trapezoid prism (P_LOW -> P_HIGH at y=0). */
function tiltedEdge(k: OcctKernel, solid: ShapeHandle): ShapeHandle {
  const edges = k.getSubShapes(solid, 'edge')
  let target: ShapeHandle | null = null
  for (const e of edges) {
    const vs = k.getSubShapes(e, 'vertex')
    if (vs.length === 2) {
      const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
      if ((vClose(a, P_LOW) && vClose(b, P_HIGH)) || (vClose(a, P_HIGH) && vClose(b, P_LOW))) target = e
    }
    for (const v of vs) { try { k.release(v) } catch { /* */ } }
  }
  if (!target) throw new Error('tilted edge not found')
  // keep target; release the rest
  for (const e of edges) { if (e !== target) { try { k.release(e) } catch { /* */ } } }
  return target
}

/** A rotated bullnose bar: rectangle [0,W]x[0,H] capped by a semicircle at the
 *  top (radius W/2), extruded in Y, then rotated off every axis. The semicylinder
 *  is tangent to the two PARALLEL side faces (x=0 and x=W) — its two candidate
 *  planar neighbours never meet, so the band must refuse STRUCTURED. */
function rotatedBullnose(k: OcctKernel, H: number): ShapeHandle {
  const e1 = k.makeLineEdge({ x: 0, y: 0, z: 0 }, { x: W, y: 0, z: 0 })
  const e2 = k.makeLineEdge({ x: W, y: 0, z: 0 }, { x: W, y: 0, z: H })
  const arc = k.makeArcEdge({ x: W, y: 0, z: H }, { x: W / 2, y: 0, z: H + W / 2 }, { x: 0, y: 0, z: H })
  const e4 = k.makeLineEdge({ x: 0, y: 0, z: H }, { x: 0, y: 0, z: 0 })
  const wire = k.makeWire([e1, e2, arc, e4])
  const face = k.makeFace(wire)
  const bar = k.extrude(face, 0, D, 0)
  const rot = k.rotate(bar, { point: { x: 0, y: 0, z: 0 }, direction: unit({ x: 1, y: 1, z: 0.3 }) }, 0.6)
  for (const s of [e1, e2, arc, e4, wire, face, bar]) { try { k.release(s) } catch { /* */ } }
  return rot
}

/** True if the healed body carries an edge lying on the analytic line (lp,dir)
 *  whose two endpoints match `ends` (order-independent) within tolerance. */
function hasSharpEdgeOnLine(k: OcctKernel, solid: ShapeHandle, lp: Vec3, dir: Vec3, ends: [Vec3, Vec3]): { onLine: boolean; endpoints: boolean } {
  const edges = k.getSubShapes(solid, 'edge')
  let onLine = false, endpoints = false
  try {
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (perpDist(a, lp, dir) < 1e-4 && perpDist(b, lp, dir) < 1e-4 && nrm(sub(a, b)) > 1) {
          onLine = true
          if ((vClose(a, ends[0], 1e-3) && vClose(b, ends[1], 1e-3)) || (vClose(a, ends[1], 1e-3) && vClose(b, ends[0], 1e-3))) endpoints = true
        }
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
  } finally { for (const e of edges) { try { k.release(e) } catch { /* */ } } }
  return { onLine, endpoints }
}

function stepBuffer(step: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(step)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('GEO-7 tilted planar-neighbour defeature (real occt-wasm kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- 1) tilted FILLET band: recognize -> heal watertight, sharp edge on the
  //         analytic plane-plane intersection line, +delta ----
  it('#1 tilted fillet: heals watertight, sharp edge at the plane-plane intersection, material added', () => {
    const solid = trapezoidPrism(k)
    const edge = tiltedEdge(k, solid)
    const evo = k.filletWithHistory(solid, [edge], 3, [], HM)
    const filleted = evo.result
    try { k.release(edge); k.release(solid) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const feats = recognizeFeatures(k, filleted, recs)
    const bands = feats.filter((f) => f.type === 'filletPlanar')
    expect(bands.length).toBe(1)
    const band = bands[0]
    expect(band.removable).toBe(true)                       // pre-WO fillet: removable=false (RECOGNITION REFUSAL, "not axis-aligned")
    expect(band.untrimPlan).toBeDefined()                   // the plane-plane plan
    expect(band.untrimPlan!.endFaces.length).toBe(2)        // left + right end faces
    expect(String(band.params.sharp)).toBe('planeIntersection')

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, filleted, [band], scratch, recs)
    expect(heal.ok).toBe(true)
    const healed = heal.shape!
    expect(k.isValid(healed)).toBe(true)
    expect(k.isSolid(healed)).toBe(true)
    expect(heal.volumeDelta!).toBeGreaterThan(0)            // fillet removed material; restored
    expect(Math.abs(k.getVolume(healed) - SHARP_VOL)).toBeLessThan(1e-2)

    // sharp edge lies on the analytic intersection line (through P_LOW, P_HIGH).
    const dir = unit(sub(P_HIGH, P_LOW))
    const s = hasSharpEdgeOnLine(k, healed, P_LOW, dir, [P_LOW, P_HIGH])
    expect(s.onLine).toBe(true)
    expect(s.endpoints).toBe(true)
    // the fillet is gone: re-recognition finds no removable band.
    const rr = recognizeFeatures(k, healed)
    expect(rr.some((f) => f.type === 'filletPlanar' && f.removable)).toBe(false)

    for (const sh of scratch) if (sh !== healed) { try { k.release(sh) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)

  // ---- 2) tilted CHAMFER band: same discipline ----
  it('#2 tilted chamfer: heals watertight, sharp edge at the plane-plane intersection, material added', () => {
    const solid = trapezoidPrism(k)
    const edge = tiltedEdge(k, solid)
    const evo = k.chamferWithHistory(solid, [edge], 3, [], HM)
    const chamf = evo.result
    try { k.release(edge); k.release(solid) } catch { /* */ }

    const recs = gatherFaces(k, chamf)
    const feats = recognizeFeatures(k, chamf, recs)
    const bands = feats.filter((f) => f.type === 'chamferPlanar')
    expect(bands.length).toBe(1)                            // thin-strip gate: only the facet
    const band = bands[0]
    // NB (GEO-7-R1.2): pre-WO chamfer was recognized removable=TRUE (4 untrim
    // hashes) — NOT a recognition refusal like the fillet. It failed one step
    // later, inside healRemoval, at the bbox-untrim of the tilted neighbour
    // ("not an axis-aligned bbox plane"). Post-WO it heals via plane-plane untrim.
    expect(band.removable).toBe(true)                       // pre-WO: also true — the pre-WO break was the HEAL below, not this
    expect(band.untrimPlan).toBeDefined()                   // post-WO ONLY (pre-WO used bbox untrimHashes, no plan) -> pre-WO fails here
    expect(band.untrimPlan!.endFaces.length).toBe(2)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, chamf, [band], scratch, recs)
    expect(heal.ok).toBe(true)                              // pre-WO: ok=false ("untrim ... not an axis-aligned bbox plane")
    const healed = heal.shape!
    expect(k.isValid(healed)).toBe(true)
    expect(k.isSolid(healed)).toBe(true)
    expect(heal.volumeDelta!).toBeGreaterThan(0)
    expect(Math.abs(k.getVolume(healed) - SHARP_VOL)).toBeLessThan(1e-2)

    const dir = unit(sub(P_HIGH, P_LOW))
    const s = hasSharpEdgeOnLine(k, healed, P_LOW, dir, [P_LOW, P_HIGH])
    expect(s.onLine).toBe(true)
    expect(s.endpoints).toBe(true)
    // the bevel facet is gone: back to the 6 faces of the sharp prism (the slanted
    // top face is itself a ramp plane and, like any tilted face with axis-aligned
    // neighbours, is a chamfer CANDIDATE — pre-existing, so we assert the face
    // COUNT, not the absence of every chamfer verdict).
    expect(heal.faceCount).toBe(6)

    for (const sh of scratch) if (sh !== healed) { try { k.release(sh) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(chamf) } catch { /* */ }
  }, 60_000)

  // ---- 3) PARALLEL planar neighbours refuse STRUCTURED (named reason + face
  //         set); heal returns a clean structured failure, no crash, no solid ----
  it('#3 parallel planar neighbours: recognized then REFUSED structured (no crash, no broken solid)', () => {
    const bar = rotatedBullnose(k, 12)
    const recs = gatherFaces(k, bar)
    const feats = recognizeFeatures(k, bar, recs)
    const band = feats.find((f) => f.type === 'filletPlanar' || f.type === 'chamferPlanar')
    expect(band).toBeDefined()
    expect(band!.removable).toBe(false)
    expect(band!.untrimPlan).toBeUndefined()
    expect(band!.refuseReason!.toLowerCase()).toContain('parallel')
    expect(band!.refuseReason!.toLowerCase()).not.toContain('webassembly')
    expect(band!.neighbourHashes.length).toBeGreaterThan(0)  // structured face set

    // asking to heal the refused band -> structured failure, no shape produced.
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, bar, [band!], scratch, recs)
    expect(heal.ok).toBe(false)
    expect(heal.shape).toBeUndefined()
    for (const sh of scratch) { try { k.release(sh) } catch { /* */ } }
    releaseFaceRecs(k, recs)
    try { k.release(bar) } catch { /* */ }
  }, 60_000)

  // ---- 4) engine-level determinism: identical STEP imported twice -> byte-
  //         identical recognized keys AND healed-face deleted-id set (criterion 5) ----
  it('#4 determinism: healed-face ids byte-identical across two engine runs', async () => {
    // build the tilted-fillet fixture once, roundtrip through STEP for the engine.
    const solid = trapezoidPrism(k)
    const edge = tiltedEdge(k, solid)
    const filleted = k.filletWithHistory(solid, [edge], 3, [], HM).result
    const step = k.exportStep(filleted)
    try { k.release(edge); k.release(solid); k.release(filleted) } catch { /* */ }
    const buf = stepBuffer(step)

    const engine = new GeomEngine()
    await engine.init()
    try {
      const run = async (id: string): Promise<{ keys: string[]; deleted: string[]; healed: number; vol: number }> => {
        const { bodies } = await engine.importStep(buf, id)
        const body = bodies[0].handle
        const verdicts = await engine.recognizeFeatures(body)
        const keys = verdicts.map((v) => v.featureKey).sort()
        const band = verdicts.find((v) => v.featureClass === 'filletPlanar' && v.removable)
        expect(band).toBeDefined()
        const r = await engine.defeatureBatch({ featureId: 'DF', body, featureKeys: [band!.featureKey] })
        expect(r.ok).toBe(true)
        // strip the per-import id prefix (T1:/T2:) — the geometry-derived lineage
        // suffix is what must be byte-identical across runs.
        const deleted = [...r.elementMap!.deleted].map((d) => d.replace(/^[^:]+:/, '')).sort()
        return { keys, deleted, healed: r.report!.healed, vol: (await engine.measure(r.body!, 'volume')).value }
      }
      const a = await run('T1')
      const c = await run('T2')
      expect(a.healed).toBe(1)
      expect(a.keys).toEqual(c.keys)          // deterministic recognition
      expect(a.deleted).toEqual(c.deleted)    // deterministic healed-face id lineage
      expect(Math.abs(a.vol - SHARP_VOL)).toBeLessThan(1e-2)
      expect(Math.abs(a.vol - c.vol)).toBeLessThan(1e-9)
    } finally {
      await engine.disposeKernel()
    }
  }, 120_000)

  // ---- 5) ROTATED tilted FILLET (GEO-7-R1 any-orientation proof): the SAME
  //         trapezoid-prism fillet, then the whole solid rotated off every axis so
  //         NO planar neighbour is axis-aligned on the world bbox. Must recognize,
  //         heal watertight, and land the sharp edge on the analytic intersection
  //         line TRANSFORMED by the same rotation. The pre-WO fillet branch had no
  //         axis prerequisite, so this path was already orientation-general — this
  //         fixture PROVES it (the auditor asked to check, not assume). ----
  it('#5 ROTATED tilted fillet: recognized + healed watertight at an arbitrary orientation', () => {
    const solid = trapezoidPrism(k)
    const edge = tiltedEdge(k, solid)
    const filleted = k.filletWithHistory(solid, [edge], 3, [], HM).result
    const rot = k.rotate(filleted, { point: { x: 0, y: 0, z: 0 }, direction: unit(ROT_AXIS) }, ROT_ANG)
    try { k.release(edge); k.release(solid); k.release(filleted) } catch { /* */ }

    const recs = gatherFaces(k, rot)
    const feats = recognizeFeatures(k, rot, recs)
    const bands = feats.filter((f) => f.type === 'filletPlanar')
    expect(bands.length).toBe(1)
    const band = bands[0]
    expect(band.removable).toBe(true)
    expect(band.untrimPlan).toBeDefined()
    expect(band.untrimPlan!.endFaces.length).toBe(2)
    expect(String(band.params.sharp)).toBe('planeIntersection')

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, rot, [band], scratch, recs)
    expect(heal.ok).toBe(true)
    const healed = heal.shape!
    expect(k.isValid(healed)).toBe(true)
    expect(k.isSolid(healed)).toBe(true)
    expect(heal.volumeDelta!).toBeGreaterThan(0)
    expect(Math.abs(k.getVolume(healed) - SHARP_VOL)).toBeLessThan(1e-2)  // volume is rotation-invariant

    // the sharp edge lies on the ROTATED analytic intersection line.
    const rl = rotatePoint(P_LOW, ROT_AXIS, ROT_ANG), rh = rotatePoint(P_HIGH, ROT_AXIS, ROT_ANG)
    const dir = unit(sub(rh, rl))
    const s = hasSharpEdgeOnLine(k, healed, rl, dir, [rl, rh])
    expect(s.onLine).toBe(true)
    expect(s.endpoints).toBe(true)

    for (const sh of scratch) if (sh !== healed) { try { k.release(sh) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(rot) } catch { /* */ }
  }, 60_000)

  // ---- 6) ROTATED tilted CHAMFER (GEO-7-R1 BLOCKER FIX): the SAME chamfer fixture
  //         rotated off every axis. Pre-R1 the general chamfer branch required
  //         >= 2 axis-aligned bbox neighbours, so recognizeFeatures returned
  //         featureCount 0 for exactly this input (auditor's reproduced blocker).
  //         Post-R1: recognized (1 band), healed watertight, sharp edge on the
  //         rotation-transformed analytic line. Also guards the rotation-invariant
  //         thin-strip gate: the world-bbox aspect proxy inflated FOUR faces into
  //         false chamfer bands under this rotation; the in-plane uv extent gate
  //         yields exactly the one facet. This test FAILS against pre-R1. ----
  it('#6 ROTATED tilted chamfer: recognized (pre-R1 featureCount 0) + healed watertight, one facet only', () => {
    const solid = trapezoidPrism(k)
    const edge = tiltedEdge(k, solid)
    const chamf = k.chamferWithHistory(solid, [edge], 3, [], HM).result
    const rot = k.rotate(chamf, { point: { x: 0, y: 0, z: 0 }, direction: unit(ROT_AXIS) }, ROT_ANG)
    try { k.release(edge); k.release(solid); k.release(chamf) } catch { /* */ }

    const recs = gatherFaces(k, rot)
    const feats = recognizeFeatures(k, rot, recs)
    const bands = feats.filter((f) => f.type === 'chamferPlanar')
    expect(bands.length).toBe(1)                            // pre-R1: 0 (blocker); rotation-invariant strip gate -> exactly the facet
    const band = bands[0]
    expect(band.removable).toBe(true)                       // pre-R1: never recognized at all
    expect(band.untrimPlan).toBeDefined()
    expect(band.untrimPlan!.endFaces.length).toBe(2)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, rot, [band], scratch, recs)
    expect(heal.ok).toBe(true)
    const healed = heal.shape!
    expect(k.isValid(healed)).toBe(true)
    expect(k.isSolid(healed)).toBe(true)
    expect(heal.volumeDelta!).toBeGreaterThan(0)
    expect(Math.abs(k.getVolume(healed) - SHARP_VOL)).toBeLessThan(1e-2)
    expect(heal.faceCount).toBe(6)                          // band removed, no new faces

    const rl = rotatePoint(P_LOW, ROT_AXIS, ROT_ANG), rh = rotatePoint(P_HIGH, ROT_AXIS, ROT_ANG)
    const dir = unit(sub(rh, rl))
    const s = hasSharpEdgeOnLine(k, healed, rl, dir, [rl, rh])
    expect(s.onLine).toBe(true)
    expect(s.endpoints).toBe(true)

    for (const sh of scratch) if (sh !== healed) { try { k.release(sh) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(rot) } catch { /* */ }
  }, 60_000)
})

// ---------- GEO-20 (P6) coverage gap: filletPlanar against an IMPORTED vendor STEP ----------
// P6: "No filletPlanar test runs against a VENDOR-authored STEP. #4 above DOES
// round-trip an OCCT-exported fillet through STEP, but OCCT re-exports its own
// fillets as analytic CYLINDRICAL_SURFACE — it never exercises recognition
// against REAL vendor B-rep topology (a THIRD-PARTY exporter's entity ordering,
// tolerances, and placement conventions, none of which occt-wasm's own writer
// reproduces). This closes the gap the tractable way available to this WO: the
// BASE body is the genuine committed vendor plate (step-test-with-holes.step,
// never round-tripped through occt-wasm's own STEP writer), and the fillet is
// applied directly to that imported topology's own straight edge in-kernel — so
// the band's two planar neighbours are REAL vendor-imported faces, not
// occt-wasm-synthesized primitive faces.
describe('GEO-20 (P6) — filletPlanar recognition against a vendor-authored imported STEP fixture', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('a fillet applied to a real vendor-imported edge (step-test-with-holes.step) recognizes as a removable filletPlanar and heals watertight', () => {
    const buf = readFileSync(join(process.cwd(), 'src/tests/geom/fixtures/step-test-with-holes.step'))
    const shape = k.importStep(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

    // A specific, geometry-keyed straight edge on the real imported body — a
    // genuine vendor structural edge (x=40 side, running the full y-span at
    // z=-0.5), NOT a synthetic primitive's. Several same-length (79mm) edges on
    // this plate sit adjacent to the already-refused BK-63 ambiguous-pair
    // chamfers and cannot heal a NEW fillet cleanly (their untrim overlaps that
    // unresolved geometry — a different, already-documented gap, not this
    // test's concern); this endpoint pair was chosen because it heals cleanly,
    // proven exhaustively by coordination/evidence/GEO-20/probe-vendor-fillet.mjs.
    const edges = k.getSubShapes(shape, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      let kind = 'other'
      try { kind = k.curveType(e) } catch { /* keep other */ }
      if (kind !== 'line') { try { k.release(e) } catch { /* */ } continue }
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length >= 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[vs.length - 1])
        const matches = (p: Vec3, q: Vec3): boolean => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6 && Math.abs(p.z - q.z) < 1e-6
        const P1 = { x: 40, y: 39.5, z: -0.5 }, P2 = { x: 40, y: -39.5, z: -0.5 }
        if ((matches(a, P1) && matches(b, P2)) || (matches(a, P2) && matches(b, P1))) target = e
        else { try { k.release(e) } catch { /* */ } }
      } else { try { k.release(e) } catch { /* */ } }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    expect(target).not.toBeNull()

    const volBefore = k.getVolume(shape)
    const filleted = k.filletWithHistory(shape, [target!], 1.5, [], HM).result
    try { k.release(target!); k.release(shape) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const feats = recognizeFeatures(k, filleted, recs)
    const bands = feats.filter((f) => f.type === 'filletPlanar')
    expect(bands.length).toBeGreaterThanOrEqual(1)
    const band = bands.find((b) => b.removable) ?? bands[0]
    expect(band.removable).toBe(true)                      // recognized, not refused
    expect(band.params.radius).toBeCloseTo(1.5, 2)          // measured, not a degenerate placeholder (GEO-20 Fix A)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, filleted, [band], scratch, recs)
    expect(heal.ok).toBe(true)
    const healed = heal.shape!
    expect(k.isValid(healed)).toBe(true)
    expect(k.isSolid(healed)).toBe(true)
    expect(heal.volumeDelta!).toBeGreaterThan(0)            // material added back restoring the sharp edge
    // the heal restores the ORIGINAL (pre-fillet) sharp geometry.
    expect(Math.abs(volBefore - k.getVolume(healed))).toBeLessThan(1.0)

    for (const sh of scratch) if (sh !== healed) { try { k.release(sh) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)
})
