// GEO-16 (ICR-3 step 2, Operator-approved Q-18) - two-face edge-id grammar
// disambiguation + persisted-id migration, on the REAL occt-wasm kernel.
//
// GEO-15 (step 1) PINNED the defect: edgeId keyed a two-face edge on the
// UNORDERED adjacent-face pair ONLY, so two physically distinct edges sharing a
// face pair collapsed to one id -- two overlapping R10xH20 cylinders 12mm apart,
// fused, gave 15 physical edges but only 13 unique ids (two duplicate pairs), and
// a picked-id resolver last-wins/first-wins bound the pick to the WRONG twin.
//
// GEO-16 extends the grammar: when >=2 edges of a shape share a base pair `(A^B)`
// the mint appends a deterministic GEOMETRIC disambiguator `@m<x>_<y>_<z>_l<len>`
// (curve mid-parameter point + analytic length, snapped) so EVERY physical edge
// gets a UNIQUE id -- while a single-edge pair stays byte-identical. This suite
// FLIPS the collision invariant to a UNIQUENESS invariant, proves each formerly-
// colliding twin now resolves individually, and proves migration/compatibility:
// an old BARE id that a collided pair now names refuses BY NAME (its info was
// lost; never a silent rebind), while a unique id is byte-identical old->new.
//
// The fail-CLOSED consumer backstop (#collidingPickedEdgeIds) is now unreachable
// for kernel output; its non-vacuity is proven with SYNTHETIC duplicate lists in
// src/tests/geom/stable-id.test.ts and the UI mirror in faceBoundary.test.ts /
// measureLogicCollision.test.ts. Real occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { EDGE_DISAMB_MARK, edgeIdBase } from '../../geom/worker/stable-id.ts'
import type { ProfileRegion } from '../../geom/geom-service.ts'

const R = 10
const HEIGHT = 20
const CENTER_GAP = 12 // < 2R -> the two cylinders overlap

/** A full-circle profile (single 2*pi arc) on the XY plane, centered at (cx,0),
 *  extruded +Z to make an R x HEIGHT cylinder. */
function circleProfile(sketchId: string, cx: number): ProfileRegion {
  return {
    sketchId,
    plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    loops: [[{ kind: 'arc', c: [cx, 0], r: R, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]],
  }
}

/** Build the auditor's fixture: two overlapping R10xH20 cylinders CENTER_GAP mm
 *  apart, fused into one body. Returns the fused body handle. */
async function makeOverlappingCylinders(engine: GeomEngine, tag: string) {
  const cyl1 = await engine.makeExtrude({
    featureId: `${tag}C1`, profile: circleProfile(`${tag}S1`, 0),
    end: { kind: 'blind', distance: HEIGHT }, op: 'newBody',
  })
  expect(cyl1.ok).toBe(true)
  const fused = await engine.makeExtrude({
    featureId: `${tag}C2`, profile: circleProfile(`${tag}S2`, CENTER_GAP),
    end: { kind: 'blind', distance: HEIGHT }, op: 'add', target: cyl1.body!,
  })
  expect(fused.ok).toBe(true)
  return fused.body!
}

function idFrequency(edgeIds: readonly string[]): Map<string, number> {
  const f = new Map<string, number>()
  for (const id of edgeIds) f.set(id, (f.get(id) ?? 0) + 1)
  return f
}

/** Group current edge ids by their BASE pair (disambiguator stripped). A base
 *  with >=2 members is a formerly-colliding pair the grammar disambiguated. */
function byBase(edgeIds: readonly string[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const id of edgeIds) {
    const b = edgeIdBase(id)
    m.set(b, [...(m.get(b) ?? []), id])
  }
  return m
}

describe('GEO-16 edge-id grammar disambiguation + migration (ICR-3 step 2)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#1a UNIQUENESS (FLIPPED from GEO-15): the fused overlapping cylinders now mint ALL-UNIQUE edge ids, and the disambiguator actually fired', async () => {
    const body = await makeOverlappingCylinders(engine, 'P')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const freq = idFrequency(tess.edgeIds)
    const physicalEdges = tess.edgeIds.length
    const uniqueIds = freq.size
    const dupPairs = [...freq.values()].filter((n) => n >= 2).length
    // The auditor's fixture is 15 physical edges (GEO-15 pinned 15 -> 13 ids);
    // pin the count so a topology/fixture drift to another edge count cannot pass
    // while claiming 15/15 (auditor minor #1a).
    expect(physicalEdges).toBe(15)
    // The GEO-15 invariant was physicalEdges > uniqueIds. GEO-16 flips it: every
    // physical edge has its own id.
    expect(physicalEdges).toBe(uniqueIds)
    expect(dupPairs).toBe(0)
    // Non-vacuity: at least one id carries the disambiguator, so the flip is the
    // grammar working -- not the fixture having stopped colliding.
    const disambiguated = tess.edgeIds.filter((id) => id.includes(EDGE_DISAMB_MARK))
    expect(disambiguated.length).toBeGreaterThanOrEqual(1)
    // ...and those disambiguated ids share a base pair (they are the ex-twins).
    const collidedBases = [...byBase(tess.edgeIds).entries()].filter(([, m]) => m.length >= 2)
    expect(collidedBases.length).toBeGreaterThanOrEqual(1)
    await engine.disposeAll()
  }, 60_000)

  it('#2 EACH EX-TWIN RESOLVES: both physical edges of a formerly-colliding pair now measure a real, distinct-id length (no last-wins)', async () => {
    const body = await makeOverlappingCylinders(engine, 'T')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const collided = [...byBase(tess.edgeIds).entries()].find(([, m]) => m.length >= 2)
    expect(collided).toBeDefined()
    const [, twins] = collided!
    // Distinct ids, each carrying the disambiguator.
    expect(new Set(twins).size).toBe(twins.length)
    for (const id of twins) expect(id.includes(EDGE_DISAMB_MARK)).toBe(true)
    // Each resolves to a single edge with a finite, positive length (the whole
    // point: the pick that used to bind the wrong twin now resolves uniquely).
    for (const id of twins) {
      const m = await engine.measure(body, 'length', [id])
      expect(Number.isFinite(m.value)).toBe(true)
      expect(m.value).toBeGreaterThan(0)
      expect(m.aux?.edgeIdCollisionCount ?? 0).toBe(0)
    }
    await engine.disposeAll()
  }, 60_000)

  it('#3 MIGRATION: a UNIQUE id is byte-identical old->new and resolves; an OLD BARE id a collided pair now names is REFUSED (never silently rebound)', async () => {
    const body = await makeOverlappingCylinders(engine, 'G')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const bases = byBase(tess.edgeIds)

    // (a) A pair that owns a SINGLE edge: its id has no disambiguator, so the
    //     pre-GEO-16 persisted form == the current id (byte-identical). Resolving
    //     it measures a real length -- asserted by GEOMETRY (finite, > 0), not by
    //     string identity alone.
    const uniqueEntry = [...bases.entries()].find(([b, m]) => m.length === 1 && m[0] === b)
    expect(uniqueEntry).toBeDefined()
    const uniqueOldId = uniqueEntry![0]
    expect(uniqueOldId.includes(EDGE_DISAMB_MARK)).toBe(false)
    const um = await engine.measure(body, 'length', [uniqueOldId])
    expect(Number.isFinite(um.value)).toBe(true)
    expect(um.value).toBeGreaterThan(0)

    // (b) A formerly-colliding pair: the OLD grammar persisted the BARE base
    //     `(A^B)` for BOTH physical edges (it never carried a disambiguator).
    //     That base is no longer any current edge's id, and it names >=2 edges,
    //     so migration REFUSES it -- structurally (measure: NaN + aux), the
    //     fail-loud contract. Never a silent rebind to a guessed twin.
    const collidedBase = [...bases.entries()].find(([, m]) => m.length >= 2)![0]
    expect(tess.edgeIds.includes(collidedBase)).toBe(false) // the bare form is gone
    const rm = await engine.measure(body, 'length', [collidedBase])
    expect(Number.isNaN(rm.value)).toBe(true)
    expect(rm.aux?.edgeIdCollisionCount).toBeGreaterThanOrEqual(1)
    await engine.disposeAll()
  }, 60_000)

  it('#4 NO OVER-REFUSAL: a UNIQUE fillet pick is passed THROUGH to the kernel (it fails only on geometry, never REFERENCE_UNRESOLVED)', async () => {
    const body = await makeOverlappingCylinders(engine, 'N')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const freq = idFrequency(tess.edgeIds)
    const uniqueRimArc = [...freq.entries()].filter(([, n]) => n === 1).map(([id]) => id)
      .find((id) => id.includes('S1.c0:side') && id.includes(':capStart#'))
    expect(uniqueRimArc).toBeDefined()
    const r = await engine.applyFillet({ featureId: 'NFIL', body, edges: [uniqueRimArc!], radius: 0.5, propagateTangent: true })
    if (!r.ok) {
      expect(r.diagnostics[0].code).not.toBe('REFERENCE_UNRESOLVED')
      expect(String(r.diagnostics[0].params?.reason ?? '').toLowerCase()).not.toContain('distinct edges')
    }
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM: the fixture built twice yields identical (disambiguated) edge-id lists', async () => {
    const a = await makeOverlappingCylinders(engine, 'D')
    const ta = await engine.tessellate(a, { deflection: 0.1 })
    await engine.disposeAll()
    const b = await makeOverlappingCylinders(engine, 'D')
    const tb = await engine.tessellate(b, { deflection: 0.1 })
    // Full id lists (including @token disambiguators) sort to the same sequence.
    expect([...ta.edgeIds].sort()).toEqual([...tb.edgeIds].sort())
    // And uniqueness holds both times.
    expect(idFrequency(ta.edgeIds).size).toBe(ta.edgeIds.length)
    expect(idFrequency(tb.edgeIds).size).toBe(tb.edgeIds.length)
    await engine.disposeAll()
  }, 60_000)

  // Run LAST: the ONE real kernel fillet. Filleting this self-intersecting fused
  // body a second time can corrupt occt memory, so it must not precede others.
  it('#6 UNIQUE PICK SUCCEEDS: a genuine dress-up on a unique edge of the (now collision-free) body mints a body', async () => {
    const body = await makeOverlappingCylinders(engine, 'U')
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const freq = idFrequency(tess.edgeIds)
    // The S1/S2 side-wall seam. WO-1892: the S2 wall is named from the kernel
    // record (`UC2:XTR:US2.c0:side#0`, was the positional `UC2:FUS:new#0`) --
    // the same physical edge (kernelHistoryNaming.wo1892.test.ts #5).
    const pick = [...freq.entries()].filter(([, n]) => n === 1).map(([id]) => id).sort()
      .find((id) => id.includes('S1.c0:side') && id.includes('S2.c0:side'))
    expect(pick).toBeDefined()
    const r = await engine.applyFillet({ featureId: 'UFIL', body, edges: [pick!], radius: 0.5, propagateTangent: true })
    expect(r.ok).toBe(true)
    expect(r.body).toBeDefined()
    await engine.disposeAll()
  }, 60_000)
})
