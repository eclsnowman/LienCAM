// WO UI-57 Design 5 — seam healing on the faceOffset commit path (real
// occt-wasm kernel). Operator's verdict: "I should not get seam line... it
// should heal faces (not have seam unless required for complex geometry
// solves in the engine)." The healing step (geom-engine.ts
// #offsetFaceBoolean, faceOffset kind ONLY) runs unifySameDomain after the
// existing volume gate, re-validates isValid/isSolid/volume-neutrality on the
// HEALED result, and — the actual hard part — re-binds StableIds across the
// merge via #pairHealedFaces (unifySameDomain rebuilds EVERY kernel hash,
// even for untouched faces, so pairing is 100% geometric; verified against
// the real kernel during this WO's own preflight).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ProfileRegion, StableId } from '../../geom/geom-service.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'
import { STEP, stepBody, topFaceAtZ, mergeOf, healedStep } from './fixtures/healedStep.ts'

const BOX = { x: 60, y: 30, z: 12 }
const TOP: StableId = 'F1:BOX:zMax' as StableId
const X_MIN: StableId = 'F1:BOX:xMin' as StableId
const X_MAX: StableId = 'F1:BOX:xMax' as StableId
const Y_MIN: StableId = 'F1:BOX:yMin' as StableId
const Y_MAX: StableId = 'F1:BOX:yMax' as StableId
const BOTTOM: StableId = 'F1:BOX:zMin' as StableId

async function box(engine: GeomEngine): Promise<BodyHandle> {
  return (await engine.makeBox('F1', BOX)).body!
}

const SAVED_PROJECT_TARGET = 'F1:XTR:e7ec4046-2043-45a0-939c-cbab58a56bef:side' as StableId

const SAVED_PROJECT_BASE: ProfileRegion = {
  sketchId: 'SK1',
  plane: {
    normal: { x: 0, y: 0, z: 1 },
    origin: { x: 0, y: 0, z: 0 },
    xDir: { x: 1, y: 0, z: 0 },
  },
  loops: [[
    { kind: 'line', a: [31.1535992527557, 23.365199039578453], b: [-31.1535992527557, 23.365199039578453], srcId: '07851560-d3f7-42ce-b4af-e1a1e8fd122e' },
    { kind: 'line', a: [-31.1535992527557, 23.365199039578453], b: [-31.1535992527557, -23.365199039578453], srcId: '62ef5d72-7b62-4073-8a04-7cdfd44ad9ac' },
    { kind: 'line', a: [-31.1535992527557, -23.365199039578453], b: [31.1535992527557, -23.365199039578453], srcId: 'e7ec4046-2043-45a0-939c-cbab58a56bef' },
    { kind: 'line', a: [31.1535992527557, -23.365199039578453], b: [31.1535992527557, 23.365199039578453], srcId: 'b7183056-7bb4-4a48-b260-2bd3edb0fc09' },
  ]],
}

const SAVED_PROJECT_CUT: ProfileRegion = {
  sketchId: 'SK2',
  plane: {
    normal: { x: 0, y: -1, z: 0 },
    origin: { x: 0, y: -23.365199039578453, z: 15 },
    xDir: { x: 1, y: 0, z: 0 },
  },
  loops: [[
    { kind: 'line', a: [-14.88140678591455, 3.6160427704091447], b: [-14.88140678591455, 34.491484886979514], srcId: '07c7913f-bdb5-4c41-95c3-fdc2ebd8659d' },
    { kind: 'line', a: [-14.88140678591455, 34.491484886979514], b: [-54.93603439660045, 34.491484886979514], srcId: '1e1bcaa3-df0d-4e54-a7d1-e7d5b10b7ea0' },
    { kind: 'line', a: [-54.93603439660045, 34.491484886979514], b: [-54.93603439660045, 3.6160427704091447], srcId: 'ad003982-de9a-489c-a672-bbc4e58b5be5' },
    { kind: 'line', a: [-54.93603439660045, 3.6160427704091447], b: [-14.88140678591455, 3.6160427704091447], srcId: '8522d372-3ceb-4fd3-b829-264ca33a0675' },
  ]],
}

// Fixture provenance (WO-1892, ADR-0040): the F3 fillet edges were regenerated
// through today's engine, same modelling steps. The side cut's floor (z 18.6,
// swept from segment 8522d372) and wall (x -14.88, from 07c7913f) are now named
// from the kernel's boolean record; the saved project called them F2:CUT:new#0
// and F2:CUT:new#1. The three picked edges are the same physical edges.
async function savedProjectPrePull(engine: GeomEngine): Promise<BodyHandle> {
  const f1 = await engine.makeExtrude({
    featureId: 'F1',
    profile: SAVED_PROJECT_BASE,
    end: { kind: 'blind', distance: 30 },
    op: 'newBody',
  })
  expect(f1.ok, `saved-project F1 failed: ${JSON.stringify(f1.diagnostics)}`).toBe(true)

  const f2 = await engine.makeExtrude({
    featureId: 'F2',
    profile: SAVED_PROJECT_CUT,
    end: { kind: 'blind', distance: -100 },
    op: 'cut',
    target: f1.body!,
  })
  expect(f2.ok, `saved-project F2 failed: ${JSON.stringify(f2.diagnostics)}`).toBe(true)

  const f3 = await engine.applyFillet({
    featureId: 'F3',
    body: f2.body!,
    edges: [
      edgeId(['F1:XTR:SK1:capEnd' as StableId, 'F2:XTR:07c7913f-bdb5-4c41-95c3-fdc2ebd8659d:side' as StableId], '0'),
      edgeId(['F2:XTR:07c7913f-bdb5-4c41-95c3-fdc2ebd8659d:side' as StableId, 'F2:XTR:8522d372-3ceb-4fd3-b829-264ca33a0675:side' as StableId], '0'),
      edgeId(['F1:XTR:62ef5d72-7b62-4073-8a04-7cdfd44ad9ac:side' as StableId, 'F2:XTR:8522d372-3ceb-4fd3-b829-264ca33a0675:side' as StableId], '0'),
    ],
    radius: 2,
    propagateTangent: true,
  })
  expect(f3.ok, `saved-project F3 failed: ${JSON.stringify(f3.diagnostics)}`).toBe(true)
  return f3.body!
}

describe('WO UI-57 Design 5: faceOffset seam healing (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#heal-no-seam: pulling the top face heals the seam -- exactly 6 faces (box topology) survive, not 10 (unhealed: 5 unchanged + 1 new top + 4 doubled side-wall stripes)', async () => {
    const b = await box(engine)
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 5, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    expect(r.diagnostics.some((d) => typeof d.params?.reason === 'string' && /seam retained/i.test(String(d.params.reason)))).toBe(false)

    // Assert TOPOLOGY, not a screenshot. #pairHealedFaces sets a `snapshots`
    // entry for EVERY surviving healed face (exact-match survivors AND merge
    // winners alike) and `deleted` for anything genuinely gone; geometry[]
    // carries one entry per snapshot id plus one per deleted id (its pre-op
    // snapshot) -- so its total key count is exactly the healed face count
    // (6 for a box) when nothing was deleted outright.
    expect(r.elementMap!.deleted).toEqual([])
    expect(Object.keys(r.elementMap!.geometry!)).toHaveLength(6)
    // Every wall (xMin/xMax/yMin/yMax) must be a MODIFIED survivor (healed,
    // taller) -- never dropped to `deleted`.
    for (const wall of [X_MIN, X_MAX, Y_MIN, Y_MAX]) {
      expect(r.elementMap!.deleted).not.toContain(wall)
      expect(Object.keys(r.elementMap!.modified)).toContain(wall)
    }
    await engine.disposeAll()
  }, 60_000)

  it('#heal-volume-neutral: the healed result has the SAME area*offset volume delta as the unhealed boolean (healing changes topology only, never geometry)', async () => {
    const b = await box(engine)
    const v0 = (await engine.measure(b, 'volume')).value
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 5, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const v1 = (await engine.measure(r.body!, 'volume')).value
    expect(v1 - v0).toBeCloseTo(BOX.x * BOX.y * 5, 2) // 60*30*5 = 9000
    await engine.disposeAll()
  }, 60_000)

  it('#heal-winner-keeps-id: a healed wall keeps its PRE-EXISTING StableId (resolve -> exact), never the freshly-generated prism face', async () => {
    const b = await box(engine)
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 5, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const results = await engine.resolve(r.body!, [X_MIN, X_MAX, Y_MIN, Y_MAX, BOTTOM, TOP])
    for (const res of results) {
      expect(res.status, `expected ${res.id} to still resolve (never lost) after a healed commit`).not.toBe('lost')
    }
    await engine.disposeAll()
  }, 60_000)

  it('#heal-second-edit-resolves: a SECOND faceEdit keyed to the old (healed, taller) wall id still resolves and re-drives correctly', async () => {
    const b = await box(engine)
    const r1 = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 5, kind: 'faceOffset' })
    expect(r1.ok).toBe(true)
    // xMin is now a 30(y) x 17(z) wall (12 original + 5 healed) -- xMin's
    // outward normal is -X, so a POSITIVE delta extends outward (grows the
    // box in -X), keyed to the SAME id the box was minted with, never a
    // fresh one.
    const r2 = await engine.editFeature({ featureId: 'E2', body: r1.body!, featureKey: X_MIN as string, delta: 2, kind: 'faceOffset' })
    expect(r2.ok).toBe(true)
    const v2 = (await engine.measure(r2.body!, 'volume')).value
    const v1 = (await engine.measure(r1.body!, 'volume')).value
    // xMin wall area at this point: y(30) x healed-z(17) = 510; grown +2 -> +2*510 volume.
    expect(v2 - v1).toBeCloseTo(30 * 17 * 2, 1)
    await engine.disposeAll()
  }, 60_000)

  it('#heal-through-hole-cylinder: pulling a through-holed top merges the coaxial hole-wall stripe instead of retaining a circular seam', async () => {
    const b = await box(engine)
    const holed = await engine.makeHole({
      featureId: 'H', body: b, face: TOP, points: [{ x: 30, y: 15, z: 12 }],
      style: { kind: 'simple', diameter: 6 }, depth: { kind: 'throughAll' },
    })
    expect(holed.ok).toBe(true)
    const v0 = (await engine.measure(holed.body!, 'volume')).value

    const r = await engine.editFeature({ featureId: 'E2', body: holed.body!, featureKey: TOP as string, delta: 3, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const reasonDiag = r.diagnostics.find((d) => typeof d.params?.reason === 'string' && /seam retained/i.test(String(d.params.reason)))
    expect(reasonDiag, `same-domain cylinder healing unexpectedly fell back: ${JSON.stringify(r.diagnostics)}`).toBeUndefined()
    const v1 = (await engine.measure(r.body!, 'volume')).value
    const holeArea = Math.PI * 3 * 3 // the drilled pilot, radius 3
    expect(v1 - v0).toBeCloseTo((BOX.x * BOX.y - holeArea) * 3, 0)
    await engine.disposeAll()
  }, 60_000)

  it('#heal-sharp-boundary-negative: bounded overlap heals only splitters and preserves the box sharp edges', async () => {
    const b = await box(engine)
    const before = await engine.tessellate(b, { deflection: 0.1 })
    expect(new Set(before.faceIds).size).toBe(6)
    expect(new Set(before.edgeIds).size).toBe(12)

    const pulled = await engine.editFeature({
      featureId: 'E-sharp',
      body: b,
      featureKey: TOP as string,
      delta: 5,
      kind: 'faceOffset',
    })
    expect(pulled.ok, `sharp box Push/Pull failed: ${JSON.stringify(pulled.diagnostics)}`).toBe(true)
    const after = await engine.tessellate(pulled.body!, { deflection: 0.1 })
    expect(new Set(after.faceIds).size, 'the six legitimate box faces must remain distinct').toBe(6)
    expect(new Set(after.edgeIds).size, 'the twelve legitimate sharp box edges must remain').toBe(12)
    expect(new Set(after.edgeIds)).toEqual(new Set(before.edgeIds))
    await engine.disposeAll()
  }, 60_000)

  it('#heal-filleted-push-pull: extending a planar face adjacent to a fillet keeps the original face/edge topology with no cylinder seam', async () => {
    const b = await box(engine)
    const filletEdge = edgeId([X_MIN, Y_MIN], '0')
    const filleted = await engine.applyFillet({
      featureId: 'F2',
      body: b,
      edges: [filletEdge],
      radius: 3,
      propagateTangent: true,
    })
    expect(filleted.ok, `fillet fixture failed: ${JSON.stringify(filleted.diagnostics)}`).toBe(true)
    const before = await engine.tessellate(filleted.body!, { deflection: 0.1 })
    const beforeFaces = new Set(before.faceIds)
    const beforeEdges = new Set(before.edgeIds)
    const bandId = `F2:FIL:${filletEdge}` as StableId

    const pulled = await engine.editFeature({
      featureId: 'F3',
      body: filleted.body!,
      featureKey: TOP as string,
      delta: 5,
      kind: 'faceOffset',
    })
    expect(pulled.ok, `Push/Pull failed: ${JSON.stringify(pulled.diagnostics)}`).toBe(true)
    expect(
      pulled.diagnostics.some((d) => typeof d.params?.reason === 'string' && /seam retained/i.test(String(d.params.reason))),
      `fillet-cylinder healing fell back: ${JSON.stringify(pulled.diagnostics)}`,
    ).toBe(false)

    const after = await engine.tessellate(pulled.body!, { deflection: 0.1 })
    expect(new Set(after.faceIds).size, 'rigid extension must not add a split fillet face').toBe(beforeFaces.size)
    expect(new Set(after.edgeIds).size, 'rigid extension must not leave the circular seam edge').toBe(beforeEdges.size)
    expect((await engine.resolve(pulled.body!, [bandId]))[0].status, 'the original fillet face id must survive the merge').toBe('exact')
    expect((await engine.measure(pulled.body!, 'area', [bandId])).value)
      .toBeCloseTo((Math.PI / 2) * 3 * (BOX.z + 5), 1)
    await engine.disposeAll()
  }, 60_000)

  it('#heal-saved-project: PushPullHealFail F1-F4 keeps the 11-face topology with no same-surface split seams', async () => {
    const beforeBody = await savedProjectPrePull(engine)
    const before = await engine.tessellate(beforeBody, { deflection: 0.1 })
    expect(new Set(before.faceIds).size).toBe(11)
    expect(new Set(before.edgeIds).size).toBe(27)
    const targetArea = (await engine.measure(beforeBody, 'area', [SAVED_PROJECT_TARGET])).value
    const profileArea = (await engine.measure(beforeBody, 'area', ['F1:XTR:SK1:capEnd'])).value
    const beforeVolume = (await engine.measure(beforeBody, 'volume')).value
    expect(targetArea, 'F4 refs[] names the saved -Y wall, not the visible top profile').toBeCloseTo(1683.1156047447416, 5)
    expect(profileArea, 'the wrong browser-picked profile face must stay distinguishable').toBeCloseTo(2057.7733616051387, 5)
    expect(beforeVolume).toBeCloseTo(78652.65959228792, 2)
    const pulled = await engine.editFeature({
      featureId: 'F4',
      body: beforeBody,
      featureKey: SAVED_PROJECT_TARGET,
      delta: 17.053,
      kind: 'faceOffset',
    })
    expect(pulled.ok, `saved-project F4 failed: ${JSON.stringify(pulled.diagnostics)}`).toBe(true)
    const after = await engine.tessellate(pulled.body!, { deflection: 0.1 })
    const seam = pulled.diagnostics.find(
      (d) => typeof d.params?.reason === 'string' && /seam retained/i.test(String(d.params.reason)),
    )
    expect(seam, `saved-project healing fell back: ${JSON.stringify(pulled.diagnostics)}`).toBeUndefined()
    expect(new Set(after.faceIds), 'Push/Pull must extend the existing planar/cylindrical domains instead of splitting them')
      .toEqual(new Set(before.faceIds))
    expect(new Set(after.edgeIds), 'the seam-crossing edges must disappear while every legitimate F3 boundary survives')
      .toEqual(new Set(before.edgeIds))
    expect(pulled.elementMap?.generated, 'a rigid extension must not mint replacement F4 faces').toEqual([])
    const afterVolume = (await engine.measure(pulled.body!, 'volume')).value
    expect(afterVolume - beforeVolume, 'F4 volume delta must be the saved 1683.1 mm2 target area x 17.053 mm')
      .toBeCloseTo(targetArea * 17.053, 2)
    expect(afterVolume, 'the healed body must match Operator\'s saved F4 body, not the 113743.87 mm3 wrong-face replay')
      .toBeCloseTo(107354.83, 2)
    for (const id of new Set(before.faceIds)) {
      expect((await engine.resolve(pulled.body!, [id]))[0].status, `pre-Push/Pull face ${id} must survive`).toBe('exact')
    }
    await engine.disposeAll()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// UI-57-R1 BLOCKER 1 — the MERGED-LOSER fixture.
//
// Why the R0 suite could not fail: in every case above, the only faces that
// merge away are the freshly-GENERATED prism stripes, and a generated id gets
// no alias (it has no prior meaning to forward). rec.aliases was therefore
// ALWAYS EMPTY, so an auditor could disable #resolveFaceId outright and all
// 5/5 tests stayed green -- the exact mutation that FAILED this WO.
//
// This fixture makes two PRE-EXISTING faces merge into one, so a real
// pre-existing id genuinely loses and the alias path becomes load-bearing:
//
//   STEP BODY (extrude A, then extrude B onto it with op 'add' -- a fuse,
//   which does NOT unify same domain, so every coplanar pair below stays a
//   SEPARATE face):
//
//        z=10 +--------+                    z=10 +--------+--------+
//             |   A    |                         |        |        |
//        z=6  |        +--------+   pull  -->    |   A    |   B    |
//             |        |   B    |   topB +4      |        |        |
//        z=0  +--------+--------+            z=0 +--------+--------+
//            x=0      x=30     x=60             x=0      x=30     x=60
//
// Pulling B's top face (z=6, area 900) up by 4mm lands it at z=10, coplanar
// and adjacent to A's top face. unifySameDomain then merges topA + topB into
// ONE 60x30 face: two PRE-EXISTING contributors, one winner, one real LOSER.
// (The y=0 / y=30 walls and the two bottom halves merge the same way, so the
// healed result is a plain 60x30x10 box -- 6 faces.)
//
// Every consumer class named by the UI-57-R1 blocker-2 census gets its
// merged-loser regression here, and the two mutation proofs at the bottom of
// this file each turn a SPECIFICALLY NAMED test below RED.
// ---------------------------------------------------------------------------

// WO UI-57-R2: the step/merge fixture moved to fixtures/healedStep.ts so this
// suite and the R2 proof matrix (aliasLineageMatrix.test.ts) drive ONE fixture
// rather than two that can drift apart.
describe('WO UI-57-R1 blocker 1: a MERGED-AWAY PRE-EXISTING id (real kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })


  it('#merged-loser-exists: two PRE-EXISTING coplanar faces really do merge into one -- the fixture the R0 suite never had', async () => {
    const { merge, body } = await healedStep(engine)
    // The healed result is a plain box: the 60x30 merged top proves the two
    // 30x30 tops became ONE face.
    const topArea = (await engine.measure(body, 'area', [merge.winner])).value
    expect(topArea).toBeCloseTo(STEP.bx1 * STEP.y, 3)
    expect(merge.loser).not.toBe(merge.winner)
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-delta-direction (blocker 3): modified maps INPUT -> surviving OUTPUT, one entry per contributor -- never winner -> [winner, ...losers]', async () => {
    const { merge, modified, generated, deleted } = await healedStep(engine)
    // The loser is an INPUT whose sole surviving output is the winner.
    expect(modified[merge.loser]).toEqual([merge.winner])
    // The winner was modified (it absorbed the loser's area) and survives as
    // ITSELF -- the "live survivor, not a replaced parent" marker.
    expect(modified[merge.winner]).toEqual([merge.winner])
    // The inverted R0 shape listed losers as OUTPUTS of the winner. Nothing may.
    for (const [input, outputs] of Object.entries(modified)) {
      expect(outputs, `modified[${input}] must not list the merged-away loser as a surviving output`).not.toContain(merge.loser)
    }
    // A merged-away id is NOT deleted (it has a survivor) and a vanished
    // GENERATED face is neither an output nor an input.
    expect(deleted).not.toContain(merge.loser)
    for (const g of generated) expect(modified[g], `a generated face is an OUTPUT of this delta, never an input key`).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-resolves-fallback: public resolve() returns FALLBACK (never lost, never exact) for the merged-away id', async () => {
    const { merge, body } = await healedStep(engine)
    const [res] = await engine.resolve(body, [merge.loser])
    expect(res.status).toBe('fallback')
    const [win] = await engine.resolve(body, [merge.winner])
    expect(win.status).toBe('exact')
    // Both name the SAME live face -- the loser resolved onto its winner.
    expect(res.localIndex).toBe(win.localIndex)
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-second-edit: a SECOND faceEdit keyed to the merged-away id still re-drives the body', async () => {
    const { merge, body } = await healedStep(engine)
    const v1 = (await engine.measure(body, 'volume')).value
    // The loser now names the full 60x30 merged top; pulling it +2 must add
    // the WHOLE merged face's prism, proving it re-drove the winner's face.
    const r2 = await engine.editFeature({ featureId: 'E2', body, featureKey: merge.loser as string, delta: 2, kind: 'faceOffset' })
    expect(r2.ok, `second edit on the merged-away id refused: ${JSON.stringify(r2.diagnostics)}`).toBe(true)
    const v2 = (await engine.measure(r2.body!, 'volume')).value
    expect(v2 - v1).toBeCloseTo(STEP.bx1 * STEP.y * 2, 1)
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-measure-area: id-scoped measure resolves the merged-away id instead of throwing "none resolved"', async () => {
    const { merge, body } = await healedStep(engine)
    expect((await engine.measure(body, 'area', [merge.loser])).value).toBeCloseTo(STEP.bx1 * STEP.y, 3)
    // loser + winner name ONE face: its area counts once, but both ids count as
    // resolved (no bogus unresolvedCount).
    const both = await engine.measure(body, 'area', [merge.loser, merge.winner])
    expect(both.value).toBeCloseTo(STEP.bx1 * STEP.y, 3)
    expect(both.aux?.unresolvedCount ?? 0).toBe(0)
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-classify: classifyFace resolves the merged-away id instead of throwing "not found"', async () => {
    const { merge, body } = await healedStep(engine)
    await expect(engine.classifyFace(body, merge.loser)).resolves.toBe('plane')
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-hole + #merged-loser-shell + #merged-loser-draft: the makeHole / applyShell / applyDraft consumers accept the merged-away id', async () => {
    // makeHole keyed to the merged-away top id.
    {
      const { merge, body } = await healedStep(engine)
      const h = await engine.makeHole({
        featureId: 'H1', body, face: merge.loser, points: [{ x: 30, y: 15, z: STEP.az }],
        style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
      })
      expect(h.ok, `makeHole on the merged-away id refused: ${JSON.stringify(h.diagnostics)}`).toBe(true)
      await engine.disposeAll()
    }
    // applyShell removing the merged-away top face.
    {
      const { merge, body } = await healedStep(engine)
      const s = await engine.applyShell({ featureId: 'S1', body, removeFaces: [merge.loser], thickness: 2 })
      expect(s.ok, `applyShell on the merged-away id refused: ${JSON.stringify(s.diagnostics)}`).toBe(true)
      await engine.disposeAll()
    }
    // applyDraft on the merged-away top face.
    {
      const { merge, body } = await healedStep(engine)
      // Draft the merged-away TOP id about the z=0 neutral plane, pulling +Z.
      const d = await engine.applyDraft({
        featureId: 'D1', body, faces: [merge.loser], angleDeg: 5,
        neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        pullDir: { x: 0, y: 0, z: 1 },
      })
      // A draft may legitimately refuse for GEOMETRIC reasons on this body; what
      // must NEVER happen is a REFERENCE_UNRESOLVED -- that is the id lookup
      // rejecting the alias, which is what this regression pins.
      const unresolved = d.diagnostics.find((x) => x.code === 'REFERENCE_UNRESOLVED')
      expect(unresolved, `applyDraft rejected the merged-away id as an unresolved REFERENCE: ${JSON.stringify(d.diagnostics)}`).toBeUndefined()
      await engine.disposeAll()
    }
  }, 120_000)

  it('#merged-loser-highlight-migrates: tessellation faceIds carry the WINNER, and the loser resolves onto that same live face (the viewport selection/appearance/visibility migration path)', async () => {
    const { merge, body } = await healedStep(engine)
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    // The viewport compares a stored id against tess.faceIds by string equality
    // (highlight.ts, applyAppearance.ts, geometryVisibility.ts). After the merge
    // only the WINNER appears there -- a stored loser id matches nothing, which
    // is precisely why a stored id must be migrated through resolve().
    expect(tess.faceIds).toContain(merge.winner)
    expect(tess.faceIds).not.toContain(merge.loser)
    // resolve() gives the viewport the migration: loser -> the winner's live
    // local face index, so a selection/highlight follows the merge.
    const [res] = await engine.resolve(body, [merge.loser])
    expect(res.status).toBe('fallback')
    expect(res.localIndex).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-edge-dressup: a fillet PERSISTED on an edge of the merged-away face still regenerates (edge-id migration across face aliases)', async () => {
    const { merge, body, before } = await healedStep(engine)
    // Capture a REAL persisted edge id from the PRE-EDIT body: an edge of the
    // face that is about to lose. Edge ids embed their adjacent face ids
    // verbatim, so this id names the loser and re-derives to a different string
    // after the merge -- exactly the orphaning #migrateEdgeId fixes.
    const loserTop = merge.loser
    // EVERY pre-edit edge naming the losing top is a persisted pick a user's
    // document could hold. Take them all rather than hand-picking one -- which
    // walls end up aliased is an engine tie-break, not a test input.
    const preTess = await engine.tessellate(before, { deflection: 0.1 })
    const persisted = preTess.edgeIds.filter((id) => (id as string).includes(loserTop as string))
    expect(persisted.length, `fixture: expected pre-edit edges naming ${loserTop}`).toBeGreaterThan(0)
    // The healed body derives NO edge id naming the loser: every pick above is
    // now an orphan string unless it is MIGRATED across the face aliases.
    const postTess = await engine.tessellate(body, { deflection: 0.1 })
    expect(postTess.edgeIds.some((id) => (id as string).includes(loserTop as string))).toBe(false)
    // measure('length') is an edge-id consumer: each persisted pick must still
    // measure a real edge (a 'lost' pick contributes nothing and reports
    // unresolved). This is the can-fail core -- without #migrateEdgeId every
    // one of these is unresolved.
    for (const id of persisted) {
      const m = await engine.measure(body, 'length', [id])
      expect(Number.isFinite(m.value) && m.value > 0, `persisted edge ${id} did not migrate: measure -> ${m.value}`).toBe(true)
      expect(m.aux?.unresolvedCount ?? 0, `persisted edge ${id} reported unresolved`).toBe(0)
    }
    // ...and the dress-up lane: a fillet keyed to a persisted (loser-naming)
    // pick regenerates instead of refusing REFERENCE_UNRESOLVED.
    const f = await engine.applyFillet({ featureId: 'FIL1', body, edges: [persisted[0]], radius: 1, propagateTangent: true })
    const unresolved = f.diagnostics.find((x) => x.code === 'REFERENCE_UNRESOLVED')
    expect(unresolved, `fillet on a persisted edge of the merged-away face was rejected as an unresolved REFERENCE: ${JSON.stringify(f.diagnostics)}`).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-survives-restore: serialize/restore reconstructs the alias map from the delta -- the merged-away id still resolves after a round trip', async () => {
    const before = await stepBody(engine)
    const topA = topFaceAtZ(engine, before, STEP.az, 'block A top (z=10)')
    const topB = topFaceAtZ(engine, before, STEP.bz, 'block B top (z=6)')
    const r = await engine.editFeature({ featureId: 'E1', body: before, featureKey: topB as string, delta: STEP.pull, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const merge = mergeOf(r.elementMap!.modified as Record<string, string[]>, topA, topB)
    const bytes = await engine.serializeBody(r.body!)
    const restored = await engine.restoreBody(bytes, r.elementMap!)
    // restoreBody used to DROP aliases outright: the merged-away id came back
    // 'lost' after any round trip.
    const [res] = await engine.resolve(restored, [merge.loser])
    expect(res.status).toBe('fallback')
    expect((await engine.measure(restored, 'area', [merge.loser])).value).toBeCloseTo(STEP.bx1 * STEP.y, 3)
    await engine.disposeAll()
  }, 60_000)

  it('#merged-loser-survives-later-feature: the alias map is carried through a LATER op (every derived body record inherits it, not just the healing one)', async () => {
    const { merge, body } = await healedStep(engine)
    // A fillet mints a NEW body record. Every derived #mint used to drop
    // aliases, so the merged-away id resolved for exactly ONE generation.
    const tess = await engine.tessellate(body, { deflection: 0.1 })
    const anyEdge = tess.edgeIds.find((id) => (id as string).includes(merge.winner as string))
    expect(anyEdge, 'fixture: expected a live edge on the merged winner').toBeDefined()
    const f = await engine.applyFillet({ featureId: 'FIL2', body, edges: [anyEdge!], radius: 1, propagateTangent: true })
    expect(f.ok, `fillet failed: ${JSON.stringify(f.diagnostics)}`).toBe(true)
    const [res] = await engine.resolve(f.body!, [merge.loser])
    expect(res.status, 'the alias must survive a later feature, not just the healing one').toBe('fallback')
    await engine.disposeAll()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Mutation proofs (WORKER-CHARTER item 6) -- run:
//     node tools/mutation/ui57-heal-mutation.mjs
// It applies THREE mutations to the real source, each of which must turn the
// SPECIFICALLY NAMED tests above RED, then restores the file and verifies it is
// byte-identical by sha256 against a committed preimage:
//
//   heal-call       remove the unifySameDomain call  -> #heal-no-seam,
//                                                       #merged-loser-exists
//   alias-creation  losers get no forward pointer    -> #merged-loser-resolves-fallback,
//                                                       #merged-loser-second-edit,
//                                                       #merged-loser-classify
//   alias-lookup    the shared resolver is identity  -> (same three)
//
// The last two are the UI-57-R1 blocker-1 requirement: the R0 audit disabled
// the alias lookup and ALL 5/5 healing tests stayed green, because no R0
// fixture ever produced a merged-away PRE-EXISTING id. They go red now.
// Preimage + one RED log per mutation + the RESTORED-GREEN log are committed
// under coordination/evidence/UI-57/.
export const __MUTATION_PROOF_MARKER__ = true
