// GEO-8 (BK-59) — chamferPlanar discriminator precision, against the REAL
// occt-wasm kernel in Node.
//
// TWO guarantees, both proven here:
//
//  (A) HOLE-STACK DISJOINTNESS (mission): a face that is PART of a recognized
//      hole stack (bore wall, countersink cone, blind floor, counterbore shoulder
//      / chamfer lip) must be reported ONLY inside that hole/stack verdict, never
//      ALSO as a standalone chamferPlanar candidate. On the real 87-face vendor
//      plate we assert the hole-verdict face set and the chamferPlanar face set are
//      strictly DISJOINT, and that the plate's genuine standalone chamfers number
//      exactly 12 — the plate's own perimeter edge breaks (4 vertical corner edges
//      + 4 top + 4 bottom edges of the outer box), NOT hole-adjacent. Every one is
//      a long thin bevel strip (in-plane aspect >> 4). (This disjointness already
//      held structurally via the hole-first `consumed` skip; GEO-8 makes it an
//      EXPLICIT, order-independent invariant — see defeature.ts §holeStackFaces.)
//
//  (B) THIN-STRIP DISCRIMINATOR (GEO-6 techDebt fix): pre-GEO-8 the axis-aligned
//      chamfer path had NO aspect gate, so a LARGE tilted plane (a ramp / roof /
//      draft face, in-plane aspect ~1.4) whose neighbours are axis-aligned on the
//      body bbox was mis-flagged as a standalone chamferPlanar candidate ("over-
//      flag diagonal planar faces on dense real parts"). GEO-8 gates BOTH untrim
//      paths on isThinStrip (aspect > 4). This test FAILS against pre-GEO-8 code:
//      the ramp face of a sharp trapezoid prism is a chamferPlanar candidate pre-WO
//      and is NOT one post-WO — while a genuine thin chamfer on the same solid keeps
//      recognizing exactly as before.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, FeatureVerdict, HoleStyle } from '../../geom/geom-service.ts'
import { gatherFaces, recognizeFeatures, releaseFaceRecs, HM } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const HOLE_CLASSES = ['throughHole', 'blindHole', 'counterboreStack'] as const
function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
function holeFaceSet(verdicts: FeatureVerdict[]): Set<string> {
  const s = new Set<string>()
  for (const v of verdicts) if ((HOLE_CLASSES as readonly string[]).includes(v.featureClass)) for (const id of v.faceIds) s.add(id)
  return s
}

describe('GEO-8 chamferPlanar discriminator — hole-stack disjointness (engine, real kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  async function importFirst(name: string, id: string): Promise<BodyHandle> {
    const { bodies } = await engine.importStep(fixtureBytes(name), id)
    return bodies[0].handle
  }

  // ---- (A) real 87-face vendor plate: disjoint sets + 12 genuine standalone chamfers ----
  it('#1 real plate: hole-stack faces and chamferPlanar candidates are DISJOINT; exactly 12 standalone chamfers', async () => {
    const b = await importFirst('step-test-with-holes.step', 'IMP1')
    const verdicts = await engine.recognizeFeatures(b)

    const holeFaces = holeFaceSet(verdicts)
    const chamfers = verdicts.filter((v) => v.featureClass === 'chamferPlanar')

    // set disjointness: no chamferPlanar face (or its band face) is a hole-stack face.
    for (const c of chamfers) {
      for (const id of c.faceIds) expect(holeFaces.has(id)).toBe(false)
    }
    // and the reverse framing — the intersection of the two id sets is empty.
    const chamferFaces = new Set<string>()
    for (const c of chamfers) for (const id of c.faceIds) chamferFaces.add(id)
    const overlap = [...chamferFaces].filter((id) => holeFaces.has(id))
    expect(overlap).toEqual([])

    // exactly the 12 perimeter edge-break chamfers (justified + named in the report).
    // Each is a genuine long thin bevel strip; none are hole-adjacent.
    expect(chamfers.length).toBe(12)
    // GEO-20 (P5): assert REMOVABILITY, not just count — the pre-GEO-20 gap this
    // discriminator's own count-only assertion never caught (P5 in the WO).
    // GEO-21-R1: all 12 are now REMOVABLE — F2 identifies the structural host pair
    // by measurement, the corner untrim derives the rebuilt corner from those hosts,
    // and a collapsed corner cap is dropped (asserted band-by-band, and healed to an
    // exactly sharp box, in defeature-geo21-corner.test.ts). GEO-20 Fix A's guarantee
    // is unchanged and still asserted: a chamfer row never carries a radius param, so
    // it can never masquerade as a radius-0 fillet candidate.
    for (const c of chamfers) {
      expect(c.removable).toBe(true)
      expect(c.refuseReason).toBeUndefined()
      expect(c.params.radius).toBeUndefined()
    }

    // sanity: the plate really does carry 12 hole stacks (so disjointness is non-vacuous).
    const holes = verdicts.filter((v) => (HOLE_CLASSES as readonly string[]).includes(v.featureClass))
    expect(holes.length).toBe(12)
    await engine.disposeAll()
  }, 120_000)

  // ---- determinism x2 (criterion 3): identical plate recognition across two runs ----
  it('#2 determinism: plate chamfer + hole verdict key sets are byte-identical across two runs', async () => {
    const run = async (id: string): Promise<{ chamfers: string[]; holes: string[] }> => {
      const b = await importFirst('step-test-with-holes.step', id)
      const v = await engine.recognizeFeatures(b)
      return {
        chamfers: v.filter((x) => x.featureClass === 'chamferPlanar').map((x) => x.featureKey).sort(),
        holes: v.filter((x) => (HOLE_CLASSES as readonly string[]).includes(x.featureClass)).map((x) => x.featureKey).sort(),
      }
    }
    const a = await run('D1')
    const c = await run('D2')
    expect(a.chamfers).toEqual(c.chamfers)
    expect(a.holes).toEqual(c.holes)
    expect(a.chamfers.length).toBe(12)
    await engine.disposeAll()
  }, 120_000)

  // ---- (A) synthetic hole dressings never leak a standalone chamfer ----
  it('#3 synthetic countersink / counterbore / chamfered-mouth holes emit ZERO chamferPlanar', async () => {
    const cases: Array<{ label: string; style: HoleStyle }> = [
      { label: 'countersink', style: { kind: 'countersink', diameter: 6, csDiameter: 12, csAngleDeg: 90 } },
      { label: 'counterbore', style: { kind: 'counterbore', diameter: 6, cbDiameter: 12, cbDepth: 4 } },
    ]
    for (const cse of cases) {
      const box = (await engine.makeBox('F1', { x: 60, y: 30, z: 12 })).body!
      const holed = (await engine.makeHole({ featureId: 'H', body: box, face: 'F1:BOX:zMax', points: [{ x: 30, y: 15, z: 12 }], style: cse.style, depth: { kind: 'blind', distance: 8 } })).body!
      const verdicts = await engine.recognizeFeatures(holed)
      const holeFaces = holeFaceSet(verdicts)
      const chamfers = verdicts.filter((v) => v.featureClass === 'chamferPlanar')
      // the dressing (cone / shoulder / chamfer lip) is captured INSIDE the one hole
      // verdict — no standalone chamferPlanar, hence trivially disjoint.
      expect(chamfers.length).toBe(0)
      // the stack itself is recognized (non-vacuous).
      expect(verdicts.some((v) => v.featureClass === 'counterboreStack')).toBe(true)
      expect(holeFaces.size).toBeGreaterThan(0)
      await engine.disposeAll()
    }
  }, 120_000)
})

// ---------- raw-kernel fixtures for the thin-strip discriminator (B) ----------
function trapezoidPrism(k: OcctKernel): ShapeHandle {
  // right-trapezoid profile (0,0)-(40,0)-(40,8)-(0,20) extruded in Y -> the top face
  // is a LARGE tilted RAMP (in-plane aspect ~1.4), NOT a thin chamfer strip.
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, { x: 40, y: 0, z: 8 }, { x: 0, y: 0, z: 20 }]
  const edges: ShapeHandle[] = []
  for (let i = 0; i < 4; i++) edges.push(k.makeLineEdge(pts[i], pts[(i + 1) % 4]))
  const wire = k.makeWire(edges); const face = k.makeFace(wire); const solid = k.extrude(face, 0, 30, 0)
  for (const s of [...edges, wire, face]) { try { k.release(s) } catch { /* */ } }
  return solid
}

/** the top edge of a box running in X at z=zTop (both endpoints on the top face). */
function topXEdge(k: OcctKernel, box: ShapeHandle, zTop: number): ShapeHandle {
  const edges = k.getSubShapes(box, 'edge')
  let target: ShapeHandle | null = null
  for (const e of edges) {
    const vs = k.getSubShapes(e, 'vertex')
    if (vs.length === 2) {
      const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
      if (Math.abs(a.z - zTop) < 1e-6 && Math.abs(b.z - zTop) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1) target = e
    }
    for (const v of vs) { try { k.release(v) } catch { /* */ } }
  }
  if (!target) throw new Error('top X edge not found')
  for (const e of edges) { if (e !== target) { try { k.release(e) } catch { /* */ } } }
  return target
}

describe('GEO-8 chamferPlanar discriminator — thin-strip gate (raw kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- (B) FAILS AGAINST PRE-GEO-8: the large tilted RAMP face of a sharp
  //          trapezoid prism was flagged chamferPlanar (removable:true) pre-WO; the
  //          thin-strip aspect gate makes it NOT a chamfer candidate post-WO. ----
  it('#4 large tilted ramp face is NOT a chamferPlanar candidate (pre-GEO-8 it was)', () => {
    const prism = trapezoidPrism(k)
    const recs = gatherFaces(k, prism)
    const feats = recognizeFeatures(k, prism, recs)
    // PRE-GEO-8: exactly one chamferPlanar (the ramp, aspect ~1.4). POST-GEO-8: none.
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    expect(chamfers.length).toBe(0)
    // guard: the ramp face IS present in the model (big tilted plane) — we suppressed
    // the CLASSIFICATION, not the geometry.
    const ramps = recs.filter((r) => r.type === 'plane' && r.planeExtent && r.planeExtent.minor > 5)
    expect(ramps.length).toBeGreaterThan(0)
    releaseFaceRecs(k, recs)
    try { k.release(prism) } catch { /* */ }
  }, 60_000)

  // ---- (B) OVER-CORRECTION GUARD: a genuine thin axis-aligned chamfer still
  //          recognizes exactly as today (aspect >> 4). ----
  it('#5 genuine thin axis-aligned chamfer still recognizes as chamferPlanar', () => {
    const box = k.makeBox(60, 30, 12)
    const edge = topXEdge(k, box, 12)
    const chamf = k.chamferWithHistory(box, [edge], 1.5, [], HM).result
    try { k.release(edge); k.release(box) } catch { /* */ }
    const recs = gatherFaces(k, chamf)
    const feats = recognizeFeatures(k, chamf, recs)
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    // the chamfer facet is a long thin strip (aspect ~28) -> still recognized.
    expect(chamfers.length).toBe(1)
    const band = recs.find((r) => r.hash === chamfers[0].dropHashes[0])!
    expect(band.planeExtent!.major / band.planeExtent!.minor).toBeGreaterThan(4)
    releaseFaceRecs(k, recs)
    try { k.release(chamf) } catch { /* */ }
  }, 60_000)
})

// ---------- GEO-20 Fix A: measured chamferPlanar width, no radius-0 placeholder ----------
describe('GEO-20 Fix A — chamferPlanar carries a MEASURED width, never a radius-0 placeholder', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- FAILS AGAINST PRE-GEO-20: params.radius was always 0 (neither call site
  //      ever passed a radius for a planar strip); post-fix it carries a real
  //      measured `width` (planeExtent.minor) and NO `radius` key at all. ----
  it('#6 genuine chamfer carries params.width > 0 and never params.radius', () => {
    const box = k.makeBox(60, 30, 12)
    const edge = topXEdge(k, box, 12)
    const chamf = k.chamferWithHistory(box, [edge], 1.5, [], HM).result
    try { k.release(edge); k.release(box) } catch { /* */ }
    const recs = gatherFaces(k, chamf)
    const feats = recognizeFeatures(k, chamf, recs)
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    expect(chamfers.length).toBe(1)
    const [c] = chamfers
    expect(c.removable).toBe(true)
    expect(c.params.radius).toBeUndefined()
    expect(typeof c.params.width).toBe('number')
    expect(c.params.width as number).toBeGreaterThan(0)
    releaseFaceRecs(k, recs)
    try { k.release(chamf) } catch { /* */ }
  }, 60_000)

  // ---- can-fail mutation proof: unlike isThinStrip's aspect gate (which already
  //      requires a valid planeExtent before a chamferPlanar candidate is even
  //      classified, making a degenerate WIDTH structurally unreachable there),
  //      partialCylinder (the filletPlanar classification gate) never inspects
  //      `radius` — a cylinder whose getFaceCylinderData read failed (radius
  //      undefined, gatherFaces:489) still classifies and previously reached
  //      bandFeature with a silent radius-0 placeholder. This is the REACHABLE
  //      degenerate case Fix A closes. Real kernel shape + real recs, with ONLY
  //      the band's radius nulled out — same injection pattern as GEO-6X5-R2
  //      test #7 (frameOf cache seeding). ----
  it('#7 a fillet band with an unmeasurable radius (getFaceCylinderData failure) refuses BY NAME', () => {
    const box = k.makeBox(40, 20, 10)
    const edges = k.getSubShapes(box, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) > 1e-6 && Math.abs(a.x - 40) < 1e-6 && Math.abs(a.y - 20) < 1e-6) target = e
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    const filleted = k.filletWithHistory(box, [target!], 3, [], HM).result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }
    try { k.release(box) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const preCheck = recognizeFeatures(k, filleted, recs)
    const before = preCheck.find((f) => f.type === 'filletPlanar')!
    expect(before.removable).toBe(true)
    expect(before.params.radius).toBe(3)
    const bandHash = before.dropHashes[0]
    const mutated = recs.map((r) => (r.hash === bandHash ? { ...r, radius: undefined } : r))
    const feats = recognizeFeatures(k, filleted, mutated)
    const fillets = feats.filter((f) => f.type === 'filletPlanar')
    expect(fillets.length).toBe(1)
    const [c] = fillets
    expect(c.removable).toBe(false)
    expect(c.refuseReason).toMatch(/degenerate fillet radius/)
    expect(c.params.radius).toBeUndefined()
    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)

  // ---- GEO-20-R1 (audit major 4): the raw-value gate (`radius > 1e-6`) missed
  //      the DISPLAY-rounding hole — a radius like 4e-4 passes that raw check
  //      yet `round(radius, 3)` collapses it to 0.000, which read as a normal
  //      removable candidate with a zero-placeholder radius. Same injection
  //      pattern as #7: real kernel shape + real recs, with ONLY the band's
  //      `radius` mutated into the (1e-6, 5e-4) sub-rounding gap. ----
  it('#10 a fillet radius that ROUNDS to zero (0 < radius < 0.0005) refuses BY NAME, never a 0 row', () => {
    const box = k.makeBox(40, 20, 10)
    const edges = k.getSubShapes(box, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) > 1e-6 && Math.abs(a.x - 40) < 1e-6 && Math.abs(a.y - 20) < 1e-6) target = e
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    const filleted = k.filletWithHistory(box, [target!], 3, [], HM).result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }
    try { k.release(box) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const preCheck = recognizeFeatures(k, filleted, recs)
    const before = preCheck.find((f) => f.type === 'filletPlanar')!
    const bandHash = before.dropHashes[0]
    const mutated = recs.map((r) => (r.hash === bandHash ? { ...r, radius: 0.0004 } : r))
    const feats = recognizeFeatures(k, filleted, mutated)
    const fillets = feats.filter((f) => f.type === 'filletPlanar')
    expect(fillets.length).toBe(1)
    const [c] = fillets
    expect(c.removable).toBe(false)
    expect(c.refuseReason).toMatch(/degenerate fillet radius.*rounds to 0\.000 mm/)
    expect(c.params.radius).toBeUndefined()
    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)

  // ---- same post-round validation for chamferPlanar width (WO's explicit
  //      "same post-round validation for chamfer width" requirement). ----
  it('#11 a chamfer width that ROUNDS to zero (0 < width < 0.0005) refuses BY NAME, never a 0 row', () => {
    const box = k.makeBox(60, 30, 12)
    const edge = topXEdge(k, box, 12)
    const chamf = k.chamferWithHistory(box, [edge], 1.5, [], HM).result
    try { k.release(edge); k.release(box) } catch { /* */ }
    const recs = gatherFaces(k, chamf)
    const preCheck = recognizeFeatures(k, chamf, recs)
    const before = preCheck.find((f) => f.type === 'chamferPlanar')!
    const bandHash = before.dropHashes[0]
    const mutated = recs.map((r) => (r.hash === bandHash ? { ...r, planeExtent: { major: r.planeExtent!.major, minor: 0.0004 } } : r))
    const feats = recognizeFeatures(k, chamf, mutated)
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    expect(chamfers.length).toBe(1)
    const [c] = chamfers
    expect(c.removable).toBe(false)
    expect(c.refuseReason).toMatch(/degenerate chamfer width.*rounds to 0\.000 mm/)
    expect(c.params.width).toBeUndefined()
    releaseFaceRecs(k, recs)
    try { k.release(chamf) } catch { /* */ }
  }, 60_000)
})

// ---------- GEO-20-R1 (audit majors 2+3): the P7 standalone branch, reached for real ----------
describe('GEO-20-R1 — P7 standalone refusal: geometry-only fillet-band eligibility', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- MAJOR 3: a named real-kernel test that REACHES the standalone P7
  //      branch. A REAL fillet band (genuinely G1-tangent to its two host
  //      planes — the same construction as test #7) has ONLY its `.type`
  //      forged to a named-but-unhandled kind, same injection pattern as #7's
  //      `.radius` nulling: the underlying kernel handle is untouched, so
  //      every geometric query (uvFromPoint/surfaceNormal/sharedEdges) still
  //      runs against the REAL cylindrical face. This constructs exactly what
  //      MAJOR 3 requires — a body where an unhandled-kind band is NOT
  //      pocket/hole-absorbed — and proves it refuses BY NAME with the exact
  //      ownership fields (dropHashes, removable, refuseReason, params). ----
  it('#8 a REAL fillet band relabelled to an unhandled kind reaches P7 and refuses BY NAME', () => {
    const box = k.makeBox(40, 20, 10)
    const edges = k.getSubShapes(box, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) > 1e-6 && Math.abs(a.x - 40) < 1e-6 && Math.abs(a.y - 20) < 1e-6) target = e
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    const filleted = k.filletWithHistory(box, [target!], 3, [], HM).result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }
    try { k.release(box) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const preCheck = recognizeFeatures(k, filleted, recs)
    const bandBefore = preCheck.find((f) => f.type === 'filletPlanar')!
    expect(bandBefore.removable).toBe(true) // sanity: genuinely a real, recognized fillet band pre-mutation
    const bandHash = bandBefore.dropHashes[0]

    const mutated = recs.map((r) => (r.hash === bandHash ? { ...r, type: 'bspline' as unknown as typeof r.type } : r))
    const feats = recognizeFeatures(k, filleted, mutated)

    // no longer classified via the cylinder/filletPlanar path (its kind changed) ...
    expect(feats.find((f) => f.type === 'filletPlanar')).toBeUndefined()
    // ... it refuses BY NAME via the standalone P7 branch instead.
    const refused = feats.find((f) => f.dropHashes[0] === bandHash)
    expect(refused).toBeDefined()
    expect(refused!.type).toBe('filletCurvedCorner')
    expect(refused!.removable).toBe(false)
    expect(refused!.refuseReason).toMatch(/unsupported surface kind 'bspline'/)
    expect(refused!.params.surfaceKind).toBe('bspline')

    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)

  // ---- MAJOR 2's own reproduction case, now a committed negative: an
  //      ordinary planar box face relabelled to the SAME unhandled kind,
  //      meeting its 4 neighbours at hard 90deg edges (measured deviation 1,
  //      no tangency to even one host, let alone two) — this is NOT
  //      fillet-like and must get SILENT non-membership, never a
  //      filletCurvedCorner row. This is the auditor's exact real-kernel probe
  //      ("a box FaceRec changed to named kind bspline... immediately
  //      received an unsupported:bspline filletCurvedCorner row"). ----
  it('#9 a general (non-tangent) freeform face relabelled to an unhandled kind gets ZERO rows (not fillet-like)', () => {
    const box = k.makeBox(40, 20, 10)
    const recs = gatherFaces(k, box)
    const top = recs.find((r) => Math.abs(r.centroid.z - 10) < 1e-6)!
    expect(top.neighbours.length).toBeGreaterThan(0) // sanity: not vacuously ineligible for lack of neighbours

    const mutated = recs.map((r) => (r.hash === top.hash ? { ...r, type: 'bspline' as unknown as typeof r.type } : r))
    const feats = recognizeFeatures(k, box, mutated)

    expect(feats.find((f) => f.dropHashes.includes(top.hash))).toBeUndefined()

    releaseFaceRecs(k, recs)
    try { k.release(box) } catch { /* */ }
  }, 60_000)
})
