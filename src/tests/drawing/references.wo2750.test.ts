// WO-2750 Slice A (WO-2981): drawing reference contract, exercised.
//
// Each case is a counterexample from docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md
// sections 4.2 and 8. Geometry comes from the REAL modeling kernel
// (createLocalGeomService, the same engine the Model screen runs) wherever the
// kernel can produce the case; the two it cannot produce today are marked
// SYNTHETIC with the measured reason. The rule every case checks: a drawing
// reference is current only when its target is proved; otherwise it reports
// why and keeps its candidates for an explicit repair. It never moves.

import { mkdirSync, writeFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import { edgeId } from '../../doc/stable-id'
import { createLocalGeomService } from '../../geom'
import type { GeomClient } from '../../geom'
import type { BodyHandle, ElementMapDelta, GeometrySnapshot, ProfileRegion } from '../../geom/geom-service'
import {
  canPublish,
  faceSnapshotSignature,
  meshChainSignature,
  resolveDrawingReference,
  resolveLinearPlaneDimension,
  summarizeMeshFeatures,
  type BrepSourceState,
  type MeshSourceState,
} from '../../lib/drawing/resolve'
import type { DrawingReference, DrawingSource, SourceRevision, WitnessRole } from '../../lib/drawing/types'
import { extractMeshEdgeChains } from '../../mesh/edgeChains'
import { recognizeMeshFeatures } from '../../mesh/recognition/recognize'
import type { MeshBuffers } from '../../mesh/types'

const EVIDENCE_DIR = 'src/tests/evidence/WO-2750/A'
const record: Record<string, unknown> = {}

let g: GeomClient

beforeAll(async () => {
  g = createLocalGeomService()
  await g.init()
}, 120_000)

// ---------------------------------------------------------------- helpers

const SCOPE = { modelItemId: 'item-1', documentId: 'doc-1', lineageId: 'F1' }

function rev(geometry: string, frame = 'f0', producer = 'occt-wasm-3.6.1'): SourceRevision {
  return { geometryFingerprint: geometry, frameFingerprint: frame, producerVersion: producer }
}

function source(kind: DrawingSource['kind'], revision: SourceRevision, extra: Partial<DrawingSource> = {}): DrawingSource {
  return { ...SCOPE, kind, observedRevision: revision, ...extra }
}

/** A face reference whose witness is taken from the map at placement time. */
function faceRef(id: string, map: ElementMap, role: WitnessRole, revision: SourceRevision, src: Partial<DrawingSource> = {}, kind: DrawingSource['kind'] = 'model-brep'): DrawingReference {
  const snap = map.snapshotOf(id)
  if (!snap) throw new Error(`no snapshot for ${id}`)
  const o = snap.normal ?? snap.axis
  return {
    id: `ref:${id}`,
    source: source(kind, revision, src),
    selector: { kind: 'face', stableId: id },
    witness: {
      role,
      ...(o ? { orientationLocal: [o.x, o.y, o.z] as [number, number, number] } : {}),
      geometrySignature: faceSnapshotSignature(snap),
      snapshot: snap,
    },
    acceptedRevision: revision,
  }
}

async function liveEdges(body: BodyHandle): Promise<Set<string>> {
  const t = await g.tessellate(body, { deflection: 0.1 })
  return new Set(t.edgeIds)
}

function brep(map: ElementMap, revision: SourceRevision, extra: Partial<BrepSourceState['scope']> = {}, kind: BrepSourceState['kind'] = 'model-brep'): BrepSourceState {
  return { kind, scope: { ...SCOPE, ...extra }, revision, map, bboxDiagMm: 113 }
}

function replay(...deltas: Array<ElementMapDelta | undefined>): ElementMap {
  const m = new ElementMap()
  for (const d of deltas) {
    if (!d) throw new Error('kernel op returned no delta')
    m.applyDelta(d)
  }
  return m
}

const plane = (o: [number, number, number], n: [number, number, number], area: number): GeometrySnapshot => ({
  surfaceType: 'plane', centroid: { x: o[0], y: o[1], z: o[2] }, area, normal: { x: n[0], y: n[1], z: n[2] },
})

function rect(id: string, x0: number, y0: number, x1: number, y1: number, z: number): ProfileRegion {
  return {
    sketchId: id,
    plane: { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    loops: [[
      { kind: 'line', a: [x0, y0], b: [x1, y0], srcId: `${id}.e0` },
      { kind: 'line', a: [x1, y0], b: [x1, y1], srcId: `${id}.e1` },
      { kind: 'line', a: [x1, y1], b: [x0, y1], srcId: `${id}.e2` },
      { kind: 'line', a: [x0, y1], b: [x0, y0], srcId: `${id}.e3` },
    ]],
  }
}

async function box(x: number, y = 50, z = 20) {
  const r = await g.makeBox('F1', { x, y, z })
  expect(r.ok).toBe(true)
  return r
}

async function hole(id: string, body: BodyHandle, x: number, y: number) {
  const r = await g.makeHole({ featureId: id, body, face: 'F1:BOX:zMax', points: [{ x, y, z: 20 }], style: { kind: 'simple', diameter: 10 }, depth: { kind: 'throughAll' } })
  expect(r.ok).toBe(true)
  return r
}

async function extrude(id: string, body: BodyHandle, op: 'cut' | 'add', profile: ProfileRegion, distance: number) {
  const r = await g.makeExtrude({ featureId: id, op, target: body, end: { kind: 'blind', distance }, profile })
  expect(r.ok).toBe(true)
  return r
}

// ------------------------------------------------------------------ cases

describe('native BREP: edits that must keep a dimension associated', () => {
  it('edit the block from 100 to 120 mm: the length dimension re-measures 120; an unrelated hole stays current', async () => {
    const b0 = await box(100)
    const h0 = await hole('H1', b0.body!, 30, 25)
    const m0 = replay(b0.elementMap, h0.elementMap)
    const r0 = rev('len100')
    const left = faceRef('F1:BOX:xMin', m0, 'plane', r0)
    const right = faceRef('F1:BOX:xMax', m0, 'plane', r0)
    const bore = faceRef('H1:HOL:i0:wall', m0, 'center', r0)
    expect(resolveLinearPlaneDimension([left, right], brep(m0, r0))).toMatchObject({ state: 'current', valueMm: 100 })

    // Regenerate the edited document from scratch, as the regen does.
    const b1 = await box(120)
    const h1 = await hole('H1', b1.body!, 30, 25)
    const m1 = replay(b1.elementMap, h1.elementMap)
    const r1 = rev('len120')
    const dim = resolveLinearPlaneDimension([left, right], brep(m1, r1))
    expect(dim.state).toBe('current')
    expect(dim.valueMm).toBeCloseTo(120, 9)
    expect(dim.measuredAt).toEqual(r1)
    expect(resolveDrawingReference(bore, brep(m1, r1))).toMatchObject({ state: 'current', via: 'exact', resolvedIds: ['H1:HOL:i0:wall'] })
    record.editLength = { before: 100, after: dim.valueMm, bore: 'current' }
  })

  it('add an unrelated feature and move the part: references stay current; a body-local dimension does not change', async () => {
    const b = await box(100)
    const h1 = await hole('H1', b.body!, 30, 25)
    const h2 = await hole('H2', h1.body!, 70, 25)
    const r0 = rev('a')
    const before = replay(b.elementMap, h1.elementMap)
    const after = replay(b.elementMap, h1.elementMap, h2.elementMap)
    const left = faceRef('F1:BOX:xMin', before, 'plane', r0)
    const right = faceRef('F1:BOX:xMax', before, 'plane', r0)
    // Same geometry, new placement: only the frame fingerprint moves.
    const moved = rev('b', 'placed-elsewhere')
    const dim = resolveLinearPlaneDimension([left, right], brep(after, moved))
    expect(dim).toMatchObject({ state: 'current', valueMm: 100 })
    expect(dim.references.map(r => r.via)).toEqual(['exact', 'exact'])
  })
})

describe('deleting a hole beside an identical hole', () => {
  it('real kernel: delete H1, regenerate; H1 is missing and never becomes H2', async () => {
    const b = await box(100)
    const h1 = await hole('H1', b.body!, 30, 25)
    const h2 = await hole('H2', h1.body!, 70, 25)
    const r0 = rev('two-holes')
    const m0 = replay(b.elementMap, h1.elementMap, h2.elementMap)
    const ref = faceRef('H1:HOL:i0:wall', m0, 'center', r0)

    const b1 = await box(100)
    const only2 = await hole('H2', b1.body!, 70, 25)
    const m1 = replay(b1.elementMap, only2.elementMap)
    const res = resolveDrawingReference(ref, brep(m1, rev('one-hole')))
    expect(res.state).toBe('missing')
    expect(res.reason).toBe('not-found')
    expect(res.resolvedIds).toEqual([])
    expect(res.candidates).not.toContain('H2:HOL:i0:wall')
    record.deleteHole = { state: res.state, reason: res.reason, candidates: res.candidates }
  })

  it('the neighbour moved onto the deleted hole\'s spot: ElementMap would fall back to it; the drawing will not', async () => {
    const b = await box(100)
    const h1 = await hole('H1', b.body!, 30, 25)
    const r0 = rev('h1')
    const m = replay(b.elementMap, h1.elementMap)
    const ref = faceRef('H1:HOL:i0:wall', m, 'center', r0)
    // Same session map: H1 is suppressed (deleted), then H2 is drilled at the
    // very same place - an identical hole with a different identity.
    const b2 = await box(100)
    const h2 = await hole('H2', b2.body!, 30, 25)
    m.applyDelta({ featureId: 'SUPPRESS-H1', modified: {}, generated: [], deleted: ['H1:HOL:i0:wall'] })
    m.applyDelta(h2.elementMap!)
    const plain = m.resolve('H1:HOL:i0:wall', 'single-face')
    expect(plain).toMatchObject({ status: 'fallback', via: 'geometric', boundTo: ['H2:HOL:i0:wall'] })
    const res = resolveDrawingReference(ref, brep(m, rev('h2-in-h1-place')))
    expect(res.state).toBe('ambiguous')
    expect(res.reason).toBe('geometric-candidate-only')
    expect(res.resolvedIds).toEqual([])
    expect(res.candidates).toEqual(['H2:HOL:i0:wall'])
    record.lookAlikeHole = { elementMap: plain.status, drawing: res.state, candidates: res.candidates }
  })
})

describe('splits', () => {
  it('real kernel, unequal split of the top face: ElementMap picks a winner; the drawing asks for repair', async () => {
    const b = await box(100)
    const r0 = rev('top-whole')
    const m0 = replay(b.elementMap)
    const top = faceRef('F1:BOX:zMax', m0, 'plane', r0)
    const slot = await extrude('C1', b.body!, 'cut', rect('S1', 40, -1, 50, 51, 10), 20)
    const m1 = replay(b.elementMap, slot.elementMap)
    const kids = m1.successorsOf('F1:BOX:zMax')
    expect(kids).toEqual(['C1:CUT:F1:BOX:zMax#0', 'C1:CUT:F1:BOX:zMax#1'])
    const plain = m1.resolve('F1:BOX:zMax', 'single-face')
    expect(plain.status).toBe('exact') // overlap winner
    expect(plain.boundTo).toHaveLength(1)
    const res = resolveDrawingReference(top, brep(m1, rev('top-split')))
    expect(res).toMatchObject({ state: 'ambiguous', reason: 'split', resolvedIds: [], candidates: kids })
    expect(res.elementMap?.boundTo).toEqual(plain.boundTo)
    record.unequalSplit = { elementMap: plain.boundTo, drawing: res.state, candidates: res.candidates }
  })

  it('real kernel, symmetric split: ElementMap degrades too; the drawing keeps both candidates', async () => {
    const b = await box(100)
    const r0 = rev('top-whole')
    const top = faceRef('F1:BOX:zMax', replay(b.elementMap), 'plane', r0)
    const slot = await extrude('C2', b.body!, 'cut', rect('S2', 45, -1, 55, 51, 10), 20)
    const m1 = replay(b.elementMap, slot.elementMap)
    expect(m1.resolve('F1:BOX:zMax', 'single-face').status).toBe('lost')
    const res = resolveDrawingReference(top, brep(m1, rev('sym')))
    expect(res).toMatchObject({ state: 'ambiguous', reason: 'split' })
    expect(res.candidates).toHaveLength(2)
  })
})

describe('merges and collapsing endpoints', () => {
  it('real kernel, a step made flush: the step-height dimension does not turn into a fresh zero', async () => {
    const b = await box(100)
    const step = await extrude('A1', b.body!, 'add', rect('S3', 50, 0, 120, 50, 20), 10)
    const r0 = rev('step')
    const m0 = replay(b.elementMap, step.elementMap)
    const lower = faceRef('F1:BOX:zMax', m0, 'plane', r0)
    const upper = faceRef('A1:XTR:S3:capEnd', m0, 'plane', r0)
    expect(resolveLinearPlaneDimension([lower, upper], brep(m0, r0))).toMatchObject({ state: 'current', valueMm: 10 })

    // Edit: the block now starts at z = 10, so its top is flush with the box top.
    const b1 = await box(100)
    const flush = await extrude('A1', b1.body!, 'add', rect('S3', 50, 0, 120, 50, 10), 10)
    const m1 = replay(b1.elementMap, flush.elementMap)
    // Measured: OCCT's fuse does NOT unify the coplanar tops into one face; it
    // splits the box top and renames the block cap. Both ends degrade.
    expect(m1.has('A1:XTR:S3:capEnd')).toBe(false)
    expect(m1.successorsOf('F1:BOX:zMax').length).toBe(2)
    const dim = resolveLinearPlaneDimension([lower, upper], brep(m1, rev('flush')))
    expect(dim.state).not.toBe('current')
    expect(dim.valueMm).toBeUndefined()
    record.flushStep = { state: dim.state, reason: dim.reason, refs: dim.references.map(r => [r.state, r.reason]) }
  })

  it('SYNTHETIC merge (the kernel fuse keeps coplanar faces apart, measured above): both endpoints on one face is stale', () => {
    const r0 = rev('two')
    const m = new ElementMap()
    m.applyDelta({
      featureId: 'F1', modified: {}, deleted: [], generated: ['A', 'B'],
      geometry: { A: plane([0, 0, 20], [0, 0, 1], 100), B: plane([50, 0, 30], [0, 0, 1], 100) },
    })
    const a = faceRef('A', m, 'plane', r0)
    const bRef = faceRef('B', m, 'plane', r0)
    expect(resolveLinearPlaneDimension([a, bRef], brep(m, r0))).toMatchObject({ state: 'current', valueMm: 10 })
    m.applyDelta({ featureId: 'HEAL', modified: { A: ['M'], B: ['M'] }, generated: [], deleted: [], geometry: { M: plane([25, 0, 20], [0, 0, 1], 200) } })
    const dim = resolveLinearPlaneDimension([a, bRef], brep(m, rev('merged')))
    expect(dim).toMatchObject({ state: 'stale', reason: 'endpoints-collapsed' })
    expect(dim.valueMm).toBeUndefined()
    // ... and an edge between the two merged faces no longer exists as stored.
    const e: DrawingReference = { ...a, id: 'ref:edge', selector: { kind: 'edge', stableId: edgeId('A', 'B') }, witness: { role: 'curve', geometrySignature: 'edge' } }
    expect(resolveDrawingReference(e, brep(m, rev('merged')))).toMatchObject({ state: 'stale', reason: 'endpoints-collapsed' })
  })

  it('an edge reference rides its two faces: current through an edit, ambiguous when one face splits', async () => {
    const b = await box(100)
    const r0 = rev('box')
    const m0 = replay(b.elementMap)
    const E = edgeId('F1:BOX:xMax', 'F1:BOX:zMax')
    const e: DrawingReference = { ...faceRef('F1:BOX:zMax', m0, 'curve', r0), id: 'ref:edge', selector: { kind: 'edge', stableId: E } }
    const b1 = await box(120)
    const now = { ...brep(replay(b1.elementMap), rev('box120')), liveEdgeIds: await liveEdges(b1.body!) }
    expect(resolveDrawingReference(e, now)).toMatchObject({ state: 'current', resolvedIds: [E] })
    // Without the body's real edge list an edge cannot be proved.
    expect(resolveDrawingReference(e, brep(replay(b1.elementMap), rev('box120')))).toMatchObject({ state: 'unsupported', reason: 'topology-unavailable' })
    const slot = await extrude('C1', b.body!, 'cut', rect('S1', 40, -1, 50, 51, 10), 20)
    expect(resolveDrawingReference(e, { ...brep(replay(b.elementMap, slot.elementMap), rev('split')), liveEdgeIds: await liveEdges(slot.body!) }))
      .toMatchObject({ state: 'ambiguous', reason: 'split' })
  })

  it('real kernel: the edge is filleted or chamfered away while both its faces survive - missing, not current', async () => {
    const E = edgeId('F1:BOX:xMax', 'F1:BOX:zMax')
    const outcomes: Record<string, unknown> = {}
    for (const op of ['fillet', 'chamfer'] as const) {
      const b = await box(100)
      const ref: DrawingReference = { ...faceRef('F1:BOX:zMax', replay(b.elementMap), 'curve', rev('box')), id: 'ref:edge', selector: { kind: 'edge', stableId: E } }
      const r = op === 'fillet'
        ? await g.applyFillet({ featureId: 'FL1', body: b.body!, edges: [E], radius: 5, propagateTangent: true })
        : await g.applyChamfer({ featureId: 'CH1', body: b.body!, edges: [E], distance: 5, propagateTangent: true })
      expect(r.ok).toBe(true)
      const m = replay(b.elementMap, r.elementMap)
      expect(m.has('F1:BOX:xMax') && m.has('F1:BOX:zMax')).toBe(true) // both faces live on
      const edges = await liveEdges(r.body!)
      expect(edges.has(E)).toBe(false)
      const res = resolveDrawingReference(ref, { ...brep(m, rev(op)), liveEdgeIds: edges })
      expect(res).toMatchObject({ state: 'missing', reason: 'edge-gone', resolvedIds: [] })
      outcomes[op] = [res.state, res.reason]
    }
    record.edgeRemoved = outcomes
  })
})

describe('GEO-16 twin edges', () => {
  it('a disambiguated twin whose geometric token moved is ambiguous with the live twins as candidates, never picked', () => {
    const r0 = rev('a')
    const m = new ElementMap()
    m.applyDelta({ featureId: 'F1', modified: {}, deleted: [], generated: ['A', 'B'], geometry: { A: plane([0, 0, 0], [0, 0, 1], 10), B: plane([0, 0, 5], [1, 0, 0], 10) } })
    const base = edgeId('A', 'B')
    const ref: DrawingReference = { ...faceRef('A', m, 'curve', r0), id: 'ref:twin', selector: { kind: 'edge', stableId: `${base}@m1_0_0_l5` } }
    const live = new Set([`${base}@m1.2_0_0_l6`, `${base}@m-1.2_0_0_l6`])
    const res = resolveDrawingReference(ref, { ...brep(m, rev('b')), liveEdgeIds: live })
    expect(res).toMatchObject({ state: 'ambiguous', reason: 'edge-twin-changed', resolvedIds: [] })
    expect(res.candidates.sort()).toEqual([...live].sort())
    // ... and the unchanged twin is simply current
    expect(resolveDrawingReference({ ...ref, selector: { kind: 'edge', stableId: `${base}@m1.2_0_0_l6` } }, { ...brep(m, rev('b')), liveEdgeIds: live }))
      .toMatchObject({ state: 'current', resolvedIds: [`${base}@m1.2_0_0_l6`] })
  })
})

describe('witness meaning', () => {
  it('a plane that turns to face the other way is stale even though its id survived', () => {
    const r0 = rev('a')
    const m = new ElementMap()
    m.applyDelta({ featureId: 'F1', modified: {}, deleted: [], generated: ['A'], geometry: { A: plane([0, 0, 20], [0, 0, 1], 100) } })
    const ref = faceRef('A', m, 'plane', r0)
    m.applyDelta({ featureId: 'MVF', modified: { A: ['A'] }, generated: [], deleted: [], geometry: { A: plane([0, 0, 20], [0, 0, -1], 100) } })
    expect(resolveDrawingReference(ref, brep(m, rev('b')))).toMatchObject({ state: 'stale', reason: 'witness-orientation-changed', candidates: ['A'] })
  })

  it('a center witness on a face that is now a plane is stale (role mismatch)', () => {
    const m = new ElementMap()
    m.applyDelta({ featureId: 'F1', modified: {}, deleted: [], generated: ['A'], geometry: { A: { surfaceType: 'cylinder', centroid: { x: 0, y: 0, z: 0 }, area: 10, axis: { x: 0, y: 0, z: 1 } } } })
    const ref = faceRef('A', m, 'center', rev('a'))
    m.applyDelta({ featureId: 'DEF', modified: { A: ['A'] }, generated: [], deleted: [], geometry: { A: plane([0, 0, 0], [0, 0, 1], 10) } })
    expect(resolveDrawingReference(ref, brep(m, rev('b')))).toMatchObject({ state: 'stale', reason: 'witness-role-mismatch' })
  })
})

describe('scope', () => {
  it('the same ids in another Model Item, or with the source gone, never resolve', async () => {
    const b = await box(100)
    const m = replay(b.elementMap)
    const ref = faceRef('F1:BOX:zMax', m, 'plane', rev('a'))
    expect(resolveDrawingReference(ref, brep(m, rev('a'), { modelItemId: 'item-2' }))).toMatchObject({ state: 'missing', reason: 'scope-mismatch', resolvedIds: [] })
    expect(resolveDrawingReference(ref, brep(m, rev('a'), { documentId: 'doc-2' }))).toMatchObject({ state: 'missing', reason: 'scope-mismatch' })
    expect(resolveDrawingReference(ref, { kind: 'absent' })).toMatchObject({ state: 'missing', reason: 'source-missing' })
  })

  it('a result measured against an older revision is not published', () => {
    const r = { measuredAt: rev('old') }
    expect(canPublish(r, rev('old'))).toBe(true)
    expect(canPublish(r, rev('new'))).toBe(false)
    expect(canPublish({}, rev('old'))).toBe(false)
  })
})

describe('imported STEP', () => {
  async function importBlock(x: number, extraSolid = false) {
    const a = await g.makeBox('F1', { x, y: 50, z: 20 })
    const handles = [a.body!]
    if (extraSolid) handles.push((await g.makeBox('F9', { x: 10, y: 10, z: 10 })).body!)
    const bytes = await g.exportStep(handles)
    const imp = await g.importStep(bytes, 'IMP1')
    return { bytes, bodies: imp.bodies }
  }

  it('same bytes rehydrate; changed bytes keep the face#i string but are NOT current', async () => {
    const one = await importBlock(100)
    expect(one.bodies).toHaveLength(1)
    const map0 = replay(one.bodies[0].elementMap)
    const id = map0.liveIds().find(s => s.includes(':step:face#'))!
    expect(id).toBeDefined()
    const r0 = rev('step-100')
    const src = { importAssetId: 'asset-1', importContentFingerprint: 'sha-100', importSolidKey: 'solid-0' }
    const ref = faceRef(id, map0, 'point', r0, src, 'imported-brep')

    const again = await importBlock(100)
    const mapA = replay(again.bodies[0].elementMap)
    expect(resolveDrawingReference(ref, brep(mapA, r0, src, 'imported-brep'))).toMatchObject({ state: 'current', resolvedIds: [id] })

    const changed = await importBlock(120)
    const mapC = replay(changed.bodies[0].elementMap)
    expect(mapC.has(id)).toBe(true) // the same index string exists in the new file...
    const res = resolveDrawingReference(ref, brep(mapC, rev('step-120'), { ...src, importContentFingerprint: 'sha-120' }, 'imported-brep'))
    expect(res).toMatchObject({ state: 'stale', reason: 'import-replaced-without-lineage', resolvedIds: [], candidates: [id] }) // ...but it is only a seed

    const rebuilt = resolveDrawingReference(ref, brep(mapA, rev('step-100', 'f0', 'occt-wasm-next'), src, 'imported-brep'))
    expect(rebuilt).toMatchObject({ state: 'stale', reason: 'producer-changed' })
    record.stepReplace = { faceId: id, sameBytes: 'current', changedBytes: res.state, otherKernelBuild: rebuilt.state }
  })

  it('multi-solid: the solid is part of the scope, never "the first solid"', async () => {
    const two = await importBlock(100, true)
    record.stepMultiSolid = { bodies: two.bodies.length, firstIds: two.bodies.map(b => b.elementMap.generated.slice(0, 2)) }
    expect(two.bodies).toHaveLength(2)
    const src = (key: string) => ({ importAssetId: 'asset-2', importContentFingerprint: 'sha-2', importSolidKey: key })
    const map1 = replay(two.bodies[1].elementMap)
    const id = map1.liveIds()[0]
    // Measured: the second solid's faces are numbered on from the first's.
    expect(replay(two.bodies[0].elementMap).has(id)).toBe(false)
    const ref = faceRef(id, map1, 'point', rev('s'), src('solid-1'), 'imported-brep')
    expect(resolveDrawingReference(ref, brep(map1, rev('s'), src('solid-1'), 'imported-brep'))).toMatchObject({ state: 'current', resolvedIds: [id] })
    const map0 = replay(two.bodies[0].elementMap)
    expect(resolveDrawingReference(ref, brep(map0, rev('s'), src('solid-0'), 'imported-brep'))).toMatchObject({ state: 'missing', reason: 'scope-mismatch' })
  })
})

describe('raw mesh (no BREP conversion)', () => {
  const SETTINGS = 'angle=30;weld=default;features=default'
  let base: MeshBuffers
  let moved: MeshBuffers
  let coarse: MeshBuffers
  // a remesh at another linear deflection whose bore rim comes out point for point the same
  let sameRim: MeshBuffers

  beforeAll(async () => {
    const tess = async (holeX: number, deflection: number, angular = 0.1) => {
      const b = await g.makeBox('F1', { x: 100, y: 50, z: 20 })
      const h = await g.makeHole({ featureId: 'H1', body: b.body!, face: 'F1:BOX:zMax', points: [{ x: holeX, y: 25, z: 20 }], style: { kind: 'simple', diameter: 10 }, depth: { kind: 'throughAll' } })
      const t = await g.tessellate(h.body!, { deflection, angularDeflection: angular })
      return { positions: new Float32Array(t.position), indices: new Uint32Array(t.index) }
    }
    base = await tess(30, 0.01)
    moved = await tess(70, 0.01)
    coarse = await tess(30, 0.2, 0.5)
    sameRim = await tess(30, 0.05)
  }, 120_000)

  function meshState(mesh: MeshBuffers, revision: SourceRevision, extra: Partial<MeshSourceState> = {}): MeshSourceState {
    return {
      kind: 'mesh', scope: SCOPE, revision,
      chains: extractMeshEdgeChains(mesh),
      features: summarizeMeshFeatures(recognizeMeshFeatures(mesh)),
      settingsFingerprint: SETTINGS,
      ...extra,
    }
  }

  function reorder(mesh: MeshBuffers): MeshBuffers {
    const n = mesh.indices.length / 3
    const out = new Uint32Array(mesh.indices.length)
    for (let i = 0; i < n; i++) {
      const src = (i * 7919) % n
      // rotate the corner order too
      out.set([mesh.indices[src * 3 + 1], mesh.indices[src * 3 + 2], mesh.indices[src * 3]], i * 3)
    }
    return { positions: mesh.positions, indices: out }
  }

  function chainRef(mesh: MeshBuffers, revision: SourceRevision): DrawingReference {
    const chains = extractMeshEdgeChains(mesh)
    // the top rim of the bore: a closed chain at z = 20 within 6 mm of (30, 25)
    const rim = chains.find(c => c.closed && c.points.every(p => Math.abs(p[2] - 20) < 1e-3 && Math.hypot(p[0] - 30, p[1] - 25) < 6))
    if (!rim) throw new Error('bore rim chain not found')
    return {
      id: 'ref:rim', source: source('mesh', revision),
      selector: { kind: 'mesh-chain', chainId: rim.id, settingsFingerprint: SETTINGS },
      witness: { role: 'curve', geometrySignature: meshChainSignature(rim) },
      acceptedRevision: revision,
    }
  }

  it('reorder-only: the chain and the fitted hole stay current although the query id changed', () => {
    const r0 = rev('mesh-a', 'f0', 'mesh-detector-1')
    const ref = chainRef(base, r0)
    const shuffled = reorder(base)
    const now = meshState(shuffled, rev('mesh-a-reordered', 'f0', 'mesh-detector-1'))
    expect(resolveDrawingReference(ref, now)).toMatchObject({ state: 'current', via: 'lineage' })

    const recA = recognizeMeshFeatures(base)
    const recB = recognizeMeshFeatures(shuffled)
    const holeA = recA.features.find(f => f.kind === 'through-hole')!
    const holeB = recB.features.find(f => f.kind === 'through-hole')!
    expect(holeA).toBeDefined()
    expect(holeB).toBeDefined()
    const [supportA] = summarizeMeshFeatures({ ...recA, features: [holeA], pockets: [] })
    const featRef: DrawingReference = {
      id: 'ref:hole', source: source('mesh', r0),
      selector: { kind: 'mesh-feature', featureKind: 'through-hole', supportFingerprint: supportA.supportFingerprint, settingsFingerprint: SETTINGS },
      witness: { role: 'center', geometrySignature: supportA.supportFingerprint },
      acceptedRevision: r0,
    }
    expect(resolveDrawingReference(featRef, now)).toMatchObject({ state: 'current' })
    record.meshReorder = { queryIdBefore: holeA.id, queryIdAfter: holeB.id, chain: 'current', feature: 'current' }
  })

  it('a different mesh whose hole moved: the fitted feature is not proved, whatever its query id says', () => {
    const r0 = rev('mesh-a', 'f0', 'mesh-detector-1')
    const recA = recognizeMeshFeatures(base)
    const recM = recognizeMeshFeatures(moved)
    const holeA = recA.features.find(f => f.kind === 'through-hole')!
    const holeM = recM.features.find(f => f.kind === 'through-hole')!
    const [supportA] = summarizeMeshFeatures({ ...recA, features: [holeA], pockets: [] })
    const featRef: DrawingReference = {
      id: 'ref:hole', source: source('mesh', r0),
      selector: { kind: 'mesh-feature', featureKind: 'through-hole', supportFingerprint: supportA.supportFingerprint, settingsFingerprint: SETTINGS },
      witness: { role: 'center', geometrySignature: supportA.supportFingerprint },
      acceptedRevision: r0,
    }
    const res = resolveDrawingReference(featRef, meshState(moved, rev('mesh-moved', 'f0', 'mesh-detector-1')))
    expect(res).toMatchObject({ state: 'stale', reason: 'mesh-feature-not-proved', resolvedIds: [] })
    expect(res.candidates).toHaveLength(1) // the moved hole, offered for repair only
    // The trap this guards: the recogniser's query id is the SAME string for a
    // hole that moved 40 mm, because it is built from the smallest facet number.
    expect(holeM.id).toBe(holeA.id)
    record.meshMovedHole = { queryIdBefore: holeA.id, queryIdMoved: holeM.id, sameQueryId: holeA.id === holeM.id, drawing: res.state }
  })

  it('a remesh that moves the rim, changed detector settings, and a stopped journal replay never come back current', () => {
    const r0 = rev('mesh-a', 'f0', 'mesh-detector-1')
    const ref = chainRef(base, r0)
    const remeshed = resolveDrawingReference(ref, meshState(coarse, rev('mesh-coarse', 'f0', 'mesh-detector-1')))
    expect(remeshed.state).toBe('stale')
    expect(remeshed.reason).toBe('mesh-chain-not-proved')
    expect(resolveDrawingReference(ref, meshState(base, r0, { settingsFingerprint: 'angle=45' })))
      .toMatchObject({ state: 'unsupported', reason: 'detector-settings-changed' })
    expect(resolveDrawingReference(ref, meshState(base, r0, { replayStopped: { reason: 'edit 3 could not apply' } })))
      .toMatchObject({ state: 'stale', reason: 'mesh-replay-stopped' })
    // A remesh that reproduces the rim point for point IS proved by geometry.
    const same = resolveDrawingReference(ref, meshState(sameRim, rev('mesh-same-rim', 'f0', 'mesh-detector-1')))
    expect(same.state).toBe('current')
    record.meshRemesh = { changedRim: [remeshed.state, remeshed.reason], identicalRim: same.state, trianglesBase: base.indices.length / 3, trianglesCoarse: coarse.indices.length / 3, trianglesSameRim: sameRim.indices.length / 3 }
  })
})

describe('mesh feature fingerprint', () => {
  it('two coaxial bores of one size (a clevis) get different fingerprints; the same bore described from either end gets one', () => {
    const bore = (origin: [number, number, number], dir: [number, number, number], range: [number, number]) => ({
      id: 'through-hole-0', kind: 'through-hole' as const,
      axis: { origin, direction: dir }, diameterMm: 10, diametersMm: [10], depthMm: 10, maxDeviationMm: 0.01,
      bands: [{ surface: 'cylinder' as const, diameterMm: 10, axialRangeMm: range, maxDeviationMm: 0.01, sourceFacetIds: [] }],
      sourceFacetIds: [],
    })
    const rec = (features: ReturnType<typeof bore>[]) => ({ features, pockets: [], slots: [], draftedPockets: [], refusals: [], toleranceMm: 0.25, facetCount: 0, crackWeldsClosed: 0, ambiguousCrackWelds: 0 })
    const [lowEar, highEar] = summarizeMeshFeatures(rec([bore([0, 0, 0], [0, 0, 1], [0, 10]), bore([0, 0, 0], [0, 0, 1], [30, 40])]))
    expect(lowEar.supportFingerprint).not.toBe(highEar.supportFingerprint)
    // the low ear again, seeded from its far end with the axis flipped
    const [flipped] = summarizeMeshFeatures(rec([bore([0, 0, 10], [0, 0, -1], [0, 10])]))
    expect(flipped.supportFingerprint).toBe(lowEar.supportFingerprint)
  })
})

describe('evidence', () => {
  it('writes the reference outcomes when asked', () => {
    if (process.env.WO2981_EVIDENCE !== '1') return
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(`${EVIDENCE_DIR}/references-measured.json`, JSON.stringify(record, null, 2) + '\n')
  })
})

