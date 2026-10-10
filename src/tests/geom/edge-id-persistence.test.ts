// GEO-16-R1 (auditor findings 2 & 3) / GEO-17 (closes the two HELD majors):
// PERSISTENCE compatibility + save/load round-trip for the two-face edge-id
// grammar, proven through the REAL document persistence path (src/doc/persist
// createDocumentArchive/loadDocumentArchive) and the REAL occt-wasm kernel --
// no in-memory substitutes.
//
// Finding 2 (compat, GEO-17 A1): a genuinely PRE-GRAMMAR committed document
// fixture (src/tests/fixtures/geo16/pre-grammar-*.json) is loaded through the
// actual loader; the resolved current edge is checked against a geometric
// FINGERPRINT (analytic length + endpoints + mid-parameter point) derived
// from the fixture SOURCE independent of resolvePersistedEdgeId (the function
// under test) -- not merely "some finite positive length". The unrecoverable
// old bare collision still refuses BY NAME (never a silent rebind).
//
// Finding 3 (round-trip, GEO-17 A2): a document carrying the body's
// construction params PLUS the COMPLETE 15-edge reference set is round-
// tripped through the actual save (createDocumentArchive) and load
// (loadDocumentArchive) APIs. All 15 tessellated edge ids are compared
// before vs after, the post-load body is regenerated FROM THE LOADED
// DOCUMENT's own payload (never from the test's outer-scope constants), and
// every persisted reference is checked against its own pre-save fingerprint.
//
// FIXTURE PROVENANCE: the pre-grammar fixture's edge refs are bare base pairs
// `(A^B)` with NO @disambiguator. GEO-16 never changed face-id derivation or the
// base-pair form, so these strings are byte-for-byte what main's pre-GEO-16
// edgeId() emitted for the auditor's overlapping-cylinders body (equivalently,
// edgeIdBase() of the current ids). The formerly-colliding face pair persisted
// its BARE base for BOTH physical edges -- that is exactly the information the old
// format lost, and the case migration must refuse. The fixture was produced once
// (probe build 2026-07-11) via createDocumentArchive over a fillet node whose
// payload.edges (the same field FilletDialog.tsx persists) held those bare ids;
// the archive's document.json/manifest.json were committed verbatim.
// REGENERATED 2026-09-23 (WO-1892, ADR-0040) through the same
// createDocumentArchive path: the fused cylinder's bottom cap is now named from
// the kernel record (`PCC2:XTR:PCS2:capStart#1`, was `PCC2:FUS:new#1`); the
// colliding ref carries that name, still bare, still naming two edges.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { resolvePersistedEdgeId, edgeIdBase, EDGE_DISAMB_MARK } from '../../geom/worker/stable-id.ts'
import { FeatureDag, ElementMap } from '../../doc'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import type { ProfileRegion, BodyHandle, TessBuffers } from '../../geom/geom-service.ts'

const R = 10
const HEIGHT = 20
const CENTER_GAP = 12

interface CylParams {
  r: number
  height: number
  centerGap: number
}

function circleProfile(sketchId: string, cx: number, r: number): ProfileRegion {
  return {
    sketchId,
    plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    loops: [[{ kind: 'arc', c: [cx, 0], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]],
  }
}

/** The auditor's fixture body -- two overlapping R10xH20 cylinders 12mm apart,
 *  fused. Its face-id derivation is deterministic, so the same edge ids mint
 *  every build (proven by edge-id-collision.test.ts #5). `params` defaults to
 *  this file's module constants so every pre-GEO-17 call site is unchanged;
 *  GEO-17's A2 round-trip test passes params read back from the LOADED
 *  document instead, so the post-reload rebuild is driven by the document's
 *  own data, not by these outer-scope constants. */
async function makeOverlappingCylinders(
  engine: GeomEngine,
  tag: string,
  params: CylParams = { r: R, height: HEIGHT, centerGap: CENTER_GAP },
): Promise<BodyHandle> {
  const { r, height, centerGap } = params
  const cyl1 = await engine.makeExtrude({
    featureId: `${tag}C1`, profile: circleProfile(`${tag}S1`, 0, r),
    end: { kind: 'blind', distance: height }, op: 'newBody',
  })
  expect(cyl1.ok).toBe(true)
  const fused = await engine.makeExtrude({
    featureId: `${tag}C2`, profile: circleProfile(`${tag}S2`, centerGap, r),
    end: { kind: 'blind', distance: height }, op: 'add', target: cyl1.body!,
  })
  expect(fused.ok).toBe(true)
  return fused.body!
}

function byBase(edgeIds: readonly string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const id of edgeIds) {
    const b = edgeIdBase(id)
    m.set(b, [...(m.get(b) ?? []), id])
  }
  return m
}

// ---------------------------------------------------------------------------
// GEO-17 A1/A2: geometric fingerprint helper. Independent of
// resolvePersistedEdgeId/edgeIdBase (the code under test) -- length comes
// from the engine's own analytic curve-length measure, endpoints/mid-
// parameter point from the tessellated polyline (arc-length interpolation,
// not raw vertex-index -- the tessellator does not sample edges uniformly in
// parameter, verified by probe: a raw-index "midpoint" landed 0.49mm off the
// analytic arc bisector while arc-length interpolation landed within 0.02mm).
// ---------------------------------------------------------------------------

type Point3 = [number, number, number]

interface EdgeFingerprint {
  length: number
  start: Point3
  end: Point3
  mid: Point3
}

function dist3(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function lerp3(a: Point3, b: Point3, t: number): Point3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** VALIDATE data at every accept point (WORKER-CHARTER #3): a non-finite
 *  fingerprint component is a NAMED refusal, never a silent pass -- NaN
 *  compares false in both directions, so an un-guarded comparison would let a
 *  broken measurement sail through as neither a pass nor a loud failure. */
function assertFingerprintFinite(fp: EdgeFingerprint, label: string): void {
  // Shape BEFORE spread (GEO-17 audit major): an absent tuple must be a NAMED
  // refusal, not a generic "not iterable" TypeError, and a SHORT tuple (2 of 3
  // coordinates) must refuse rather than silently flatten into fewer numbers.
  if (!Number.isFinite(fp.length)) {
    throw new Error(
      `assertFingerprintFinite: '${label}' REFUSED -- fingerprint field 'length' is missing or ` +
        `non-finite (${JSON.stringify(fp)}); a NaN must never enter a fingerprint comparison silently.`,
    )
  }
  for (const field of ['start', 'end', 'mid'] as const) {
    const tuple: unknown = fp[field]
    if (!Array.isArray(tuple) || tuple.length !== 3) {
      throw new Error(
        `assertFingerprintFinite: '${label}' REFUSED -- fingerprint field '${field}' is not an ` +
          `exact 3-number tuple (${JSON.stringify(tuple)}); a truncated or absent coordinate must ` +
          `never enter a fingerprint comparison silently.`,
      )
    }
    // Fixed indexes, NOT forEach: forEach SKIPS holes, so a sparse [0,,0] tuple
    // (length 3, own keys 0 and 2) would pass silently (gatefix audit round 2).
    // Reading a hole yields undefined, which Number.isFinite refuses.
    for (const i of [0, 1, 2] as const) {
      if (!Number.isFinite(tuple[i])) {
        throw new Error(
          `assertFingerprintFinite: '${label}' REFUSED -- fingerprint component '${field}[${i}]' is ` +
            `missing or non-finite (${JSON.stringify(tuple)}); a NaN must never enter a fingerprint comparison silently.`,
        )
      }
    }
  }
}

describe('assertFingerprintFinite refuses malformed fingerprints BY NAME (GEO-17 audit major)', () => {
  const good: EdgeFingerprint = { length: 1, start: [0, 0, 0], end: [1, 1, 1], mid: [0.5, 0.5, 0.5] }
  it('accepts a well-formed fingerprint', () => {
    expect(() => assertFingerprintFinite(good, 'good')).not.toThrow()
  })
  it('refuses a NaN component by name', () => {
    expect(() => assertFingerprintFinite({ ...good, mid: [0.5, Number.NaN, 0.5] }, 'nan')).toThrow(/REFUSED.*'mid\[1\]' is missing or non-finite/)
  })
  it('refuses a missing length by name', () => {
    expect(() => assertFingerprintFinite({ ...good, length: undefined as unknown as number }, 'nolen')).toThrow(/REFUSED.*'length' is missing or non-finite/)
  })
  it('refuses a SHORT tuple (2 of 3 coordinates) by name -- the audit probe that silently PASSED before', () => {
    expect(() => assertFingerprintFinite({ ...good, mid: [0.5, 0.5] as unknown as Point3 }, 'short')).toThrow(/REFUSED.*'mid' is not an exact 3-number tuple/)
  })
  it('refuses an ABSENT tuple by name -- was a generic TypeError before', () => {
    expect(() => assertFingerprintFinite({ ...good, mid: undefined as unknown as Point3 }, 'absent')).toThrow(/REFUSED.*'mid' is not an exact 3-number tuple/)
  })
  it('refuses a SPARSE exact-length tuple by name -- forEach skips holes (gatefix audit round 2 probe)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => assertFingerprintFinite({ ...good, mid: [0, , 0] as unknown as Point3 }, 'sparse')).toThrow(/REFUSED.*'mid\[1\]' is missing or non-finite/)
  })
})

/** Independent per-edge geometric fingerprint for a CURRENT edge id already
 *  present in `tess`. Throws (named refusal) if the id is absent from the
 *  tessellation or its polyline is degenerate -- never returns a partial or
 *  guessed fingerprint. */
async function computeFingerprint(
  engine: GeomEngine,
  body: BodyHandle,
  tess: TessBuffers,
  id: string,
): Promise<EdgeFingerprint> {
  const idx = tess.edgeIds.indexOf(id)
  if (idx === -1) throw new Error(`computeFingerprint: '${id}' REFUSED -- not present in the tessellation`)
  const startOff = tess.edgeOffsets[idx]
  const endOff = tess.edgeOffsets[idx + 1]
  const verts: Point3[] = []
  for (let i = startOff; i < endOff; i++) {
    verts.push([tess.edgePositions[i * 3], tess.edgePositions[i * 3 + 1], tess.edgePositions[i * 3 + 2]])
  }
  if (verts.length < 2) throw new Error(`computeFingerprint: '${id}' REFUSED -- degenerate polyline (${verts.length} verts)`)

  const segLens: number[] = []
  let polyLen = 0
  for (let i = 1; i < verts.length; i++) {
    const d = dist3(verts[i - 1], verts[i])
    segLens.push(d)
    polyLen += d
  }
  // Arc-length midpoint: walk the polyline to half its total length and
  // interpolate within the bracketing segment -- the mid-PARAMETER point for
  // a curve tessellated at uniform-angle/uniform-parameter steps (verified
  // for this fixture's circular arcs).
  let acc = 0
  let mid: Point3 = verts[0]
  const half = polyLen / 2
  for (let i = 0; i < segLens.length; i++) {
    if (acc + segLens[i] >= half) {
      const t = segLens[i] > 0 ? (half - acc) / segLens[i] : 0
      mid = lerp3(verts[i], verts[i + 1], t)
      break
    }
    acc += segLens[i]
  }

  const m = await engine.measure(body, 'length', [id])
  const fp: EdgeFingerprint = { length: m.value, start: verts[0], end: verts[verts.length - 1], mid }
  assertFingerprintFinite(fp, id)
  return fp
}

const FP_TOL = { length: 1e-3, point: 0.05 } as const

/** Compares two fingerprints for the SAME physical edge. Endpoints may come
 *  back in either winding direction across two independent tessellations, so
 *  they are matched as an UNORDERED pair rather than assuming a fixed
 *  start/end convention. */
function expectFingerprintClose(actual: EdgeFingerprint, expected: EdgeFingerprint, label: string): void {
  assertFingerprintFinite(actual, `${label} (actual)`)
  assertFingerprintFinite(expected, `${label} (expected)`)
  expect(Math.abs(actual.length - expected.length), `${label}: length`).toBeLessThan(FP_TOL.length)
  const dSame = dist3(actual.start, expected.start) + dist3(actual.end, expected.end)
  const dSwap = dist3(actual.start, expected.end) + dist3(actual.end, expected.start)
  expect(Math.min(dSame, dSwap), `${label}: endpoints`).toBeLessThan(FP_TOL.point * 2)
  expect(dist3(actual.mid, expected.mid), `${label}: midpoint`).toBeLessThan(FP_TOL.point)
}

/** Re-zip the committed pre-grammar fixture json entries and load them through
 *  the ACTUAL loader (loadDocumentArchive unzips + migrates + FeatureDag.restore
 *  + regenerate). This is genuine document load, not an in-memory shortcut. */
function loadCommittedPreGrammarFixture() {
  const dir = join('src', 'tests', 'fixtures', 'geo16')
  const documentBytes = new Uint8Array(readFileSync(join(dir, 'pre-grammar-document.json')))
  const manifestBytes = new Uint8Array(readFileSync(join(dir, 'pre-grammar-manifest.json')))
  const archive = zipSync({ 'manifest.json': manifestBytes, 'document.json': documentBytes })
  return loadDocumentArchive(archive)
}

// GEO-17 A1: expected geometric fingerprint of the SPECIFIC physical edge the
// legacy `uniqueRef` id names -- `(PCC2:FUS:PCC1:XTR:PCS1:capStart#0^PCC2:FUS:
// PCC1:XTR:PCS1:capStart#1)`, read verbatim from the committed fixture below.
// Derived from the PRE-GEO-16 fixture SOURCE (the same R10/H20/gap12
// overlapping-cylinders geometry edge-id-collision.test.ts builds), NOT from
// resolvePersistedEdgeId -- captured once via a probe build (2026-07-11, real
// occt-wasm kernel) and cross-checked analytically here:
//  - length: engine.measure(body,'length',[uniqueRef]) -> the kernel's own
//    analytic curve length (18.5459...).
//  - start/end: the two circles (R=10, centers 12mm apart on X) intersect
//    where x^2+y^2=(x-12)^2+y^2=100 -> x=6, y=+-sqrt(100-36)=+-8, z=0 --
//    exactly (6,8,0) and (6,-8,0); the tessellated polyline's first/last
//    vertices land on these points to float32 precision.
//  - mid: this edge is the arc of the SECOND cylinder (center (12,0)) lying
//    inside the first. Its endpoints sit at angles +-126.87deg from that
//    center (atan2(+-8,-6)); the short way through 180deg passes the point
//    (12-10,0)=(2,0,0) -- the arc-length interpolation over the tessellated
//    polyline lands within 0.02mm of that analytic bisector.
const UNIQUE_REF_FINGERPRINT: EdgeFingerprint = {
  length: 18.545904360032065,
  start: [6, 8, 0],
  end: [6, -8, 0],
  mid: [2.0119073390960693, 0, 0],
}

describe('GEO-16 edge-id persistence: compat + save/load round-trip (findings 2 & 3, GEO-17 A1/A2)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#P1 COMPAT (GEO-17 A1): the committed PRE-GRAMMAR document loads through loadDocumentArchive; the unique ref resolves to the CORRECT physical edge (proven by a pre-derived geometric fingerprint, not just a finite length); the bare colliding ref refuses BY NAME', async () => {
    // Load through the REAL persistence path.
    const loaded = loadCommittedPreGrammarFixture()
    const fillet = loaded.dag.getNode('F_FILLET')
    expect(fillet).toBeDefined()
    const persistedEdges = (fillet!.payload as { edges: string[] }).edges
    expect(Array.isArray(persistedEdges)).toBe(true)
    expect(persistedEdges.length).toBe(2)
    // Genuinely pre-grammar: NO ref carries the @disambiguator.
    for (const id of persistedEdges) expect(id.includes(EDGE_DISAMB_MARK)).toBe(false)
    const [uniqueRef, collidedRef] = persistedEdges

    // Rebuild the SAME body with the current grammar and resolve each ref.
    const body = await makeOverlappingCylinders(engine, 'PC')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const currentIds = tess.edgeIds
    const bases = byBase(currentIds)

    // (a) The bare UNIQUE ref is byte-identical to a current id -> exact -> it
    //     resolves to real PHYSICAL geometry. GEO-17 A1: asserted against a
    //     pre-derived geometric FINGERPRINT (length + endpoints + mid-point),
    //     not merely "finite and positive" -- the old assertion could not
    //     distinguish "resolved to the correct edge" from "resolved to SOME
    //     edge" (proven non-vacuous by the A4 mutation evidence).
    expect(currentIds.filter((id) => id === uniqueRef).length).toBe(1) // precondition (fails loud on kernel drift)
    const rUnique = resolvePersistedEdgeId(uniqueRef, currentIds)
    expect(rUnique.status).toBe('exact')
    if (rUnique.status !== 'exact') throw new Error('unreachable')
    const fpUnique = await computeFingerprint(engine, body, tess, rUnique.id)
    expectFingerprintClose(fpUnique, UNIQUE_REF_FINGERPRINT, 'uniqueRef')
    expect(fpUnique.length).toBeGreaterThan(0)
    const mUnique = await engine.measure(body, 'length', [uniqueRef])
    expect(mUnique.aux?.edgeIdCollisionCount ?? 0).toBe(0)

    // (b) The old bare COLLIDING ref: its base now owns >=2 current edges but the
    //     bare form is no current id, so migration REFUSES it by name (ambiguous)
    //     -- the exact silent-wrong-binding the atomic disambiguator prevents.
    expect(currentIds.includes(collidedRef)).toBe(false)
    expect((bases.get(collidedRef) ?? []).length).toBeGreaterThanOrEqual(2)
    const rColl = resolvePersistedEdgeId(collidedRef, currentIds)
    expect(rColl.status).toBe('ambiguous')
    if (rColl.status !== 'ambiguous') throw new Error('unreachable')
    expect(rColl.base).toBe(collidedRef)
    expect(rColl.count).toBeGreaterThanOrEqual(2)
    // ...and the REAL measure path refuses it structurally (never a wrong length).
    const mColl = await engine.measure(body, 'length', [collidedRef])
    expect(Number.isNaN(mColl.value)).toBe(true)
    expect(mColl.aux?.edgeIdCollisionCount).toBeGreaterThanOrEqual(1)

    await engine.disposeAll()
  }, 60_000)

  it('#P2 ROUND-TRIP (GEO-17 A2): the COMPLETE 15-edge id set survives createDocumentArchive/loadDocumentArchive; the body is regenerated FROM THE LOADED DOCUMENT payload (not test constants); all 15 tessellated edge ids match before vs after, and every persisted reference re-resolves to its own pre-save geometric fingerprint', async () => {
    const buildParams: CylParams = { r: R, height: HEIGHT, centerGap: CENTER_GAP }
    const body = await makeOverlappingCylinders(engine, 'RT', buildParams)
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const currentIds = tess.edgeIds
    // Pin the fixture's edge count so a topology drift cannot silently pass a
    // shrunk reference set (same invariant edge-id-collision.test.ts #1a pins).
    expect(currentIds.length).toBe(15)
    expect(new Set(currentIds).size).toBe(15) // all-unique post-GEO-16 (no collision survives)

    // Fingerprint of EVERY edge before save -- keyed by id, independent of
    // resolvePersistedEdgeId (computeFingerprint never calls it).
    const fpBefore = new Map<string, EdgeFingerprint>()
    for (const id of currentIds) {
      fpBefore.set(id, await computeFingerprint(engine, body, tess, id))
    }

    // Author a document carrying the body's OWN construction params (so the
    // post-load rebuild below is driven by the loaded payload, never by this
    // file's outer-scope R/HEIGHT/CENTER_GAP constants) plus the COMPLETE
    // 15-edge reference set (GEO-17 A2: "the whole body reference set", not a
    // hand-picked 3).
    const saved = [...currentIds].sort()
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'B', kind: 'feature', consumes: [], refs: [],
      payload: { op: 'overlapping-cylinders-fixture', tag: 'RT', r: buildParams.r, height: buildParams.height, centerGap: buildParams.centerGap },
    })
    dag.insertNode({ id: 'FIL', kind: 'feature', consumes: ['B'], refs: [], payload: { opType: 'fillet', ownerId: 'B', edges: saved, radius: 0.5 } })
    dag.regenerate(new ElementMap())
    const archive = createDocumentArchive({ dag, elementMapDeltas: [], parameters: {}, sketches: [], camBindings: [], bodyCaches: [] })
    const loaded = loadDocumentArchive(archive)

    const reloadedEdges = (loaded.dag.getNode('FIL')!.payload as { edges: string[] }).edges
    // Complete id set byte-identical after reload -- all 15, not a subset.
    expect(reloadedEdges.length).toBe(15)
    expect([...reloadedEdges].sort()).toEqual(saved)

    // VALIDATE at the accept point: the loaded body payload must carry
    // finite, usable construction params -- a missing/non-finite field is a
    // named refusal here, never a silent fall-through to the outer constants
    // (that would defeat the whole point of regenerating FROM the document).
    const bNode = loaded.dag.getNode('B')
    expect(bNode).toBeDefined()
    const bodyParams = bNode!.payload as { op: string; tag: string; r: number; height: number; centerGap: number }
    expect(typeof bodyParams.tag).toBe('string')
    expect(bodyParams.tag.length).toBeGreaterThan(0)
    for (const [k, v] of Object.entries({ r: bodyParams.r, height: bodyParams.height, centerGap: bodyParams.centerGap })) {
      if (!Number.isFinite(v)) throw new Error(`GEO-17 A2 REFUSED -- loaded body payload field '${k}' is not finite (${v})`)
    }

    // Full regeneration FROM THE LOADED DOCUMENT: rebuild the body using ONLY
    // the params just read off `bodyParams`, not R/HEIGHT/CENTER_GAP/'RT'
    // directly -- this is the seam the GEO-16-R1 audit's finding 2 (major)
    // named ("rebuilds the geometry out of band from test constants rather
    // than from the loaded document").
    await engine.disposeAll()
    const body2 = await makeOverlappingCylinders(engine, bodyParams.tag, { r: bodyParams.r, height: bodyParams.height, centerGap: bodyParams.centerGap })
    const tess2 = await engine.tessellate(body2, { deflection: 0.1 })
    const currentIds2 = tess2.edgeIds

    // ALL 15 tessellated edge ids match before vs after load+regenerate (GEO-17
    // A2 -- not just the 3 previously-referenced ids).
    expect(currentIds2.length).toBe(15)
    expect([...currentIds2].sort()).toEqual(saved)

    // Every persisted reference re-resolves ('exact' -- these are current-
    // grammar ids, no migration needed) to the SAME physical edge: fingerprint
    // after must match its own pre-save fingerprint.
    for (const id of reloadedEdges) {
      const res = resolvePersistedEdgeId(id, currentIds2)
      expect(res.status, `resolve('${id}')`).toBe('exact')
      if (res.status !== 'exact') throw new Error('unreachable')
      const expected = fpBefore.get(id)
      if (!expected) throw new Error(`GEO-17 A2 REFUSED -- no pre-save fingerprint recorded for '${id}'`)
      const actual = await computeFingerprint(engine, body2, tess2, res.id)
      expectFingerprintClose(actual, expected, id)
    }

    await engine.disposeAll()
  }, 90_000)
})
