// WO-2988 (WO-2750 Slice D): drawings of a raw STL row, through the adapter.
//
// Rows of docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 8 this file
// answers: "STL journal edit versus original bytes" and "Mesh reorder/remesh
// and fit ambiguity". Contract: src/tests/evidence/WO-2750/A/REFERENCE-CONTRACT.md
// section 5.
//
// Rule 6 routes. The STL files are what a user imports: the modeling kernel's
// own tessellation of a real part, written by the product's STL writer. The
// journal edits go through the STORE's addMeshEdit (the same call the Model
// screen and Setup make), with the hole edits planned by the Model screen's own
// planner (planStlFeatureEdits) and the face picked by the product's flat-face
// recogniser. The drawing source is then built ONLY by buildMeshDrawingSource
// from the row's bytes and its journal. Hand-built meshes appear nowhere; the
// one hand-made input is an open STL file (a part with its top deleted), and it
// is still read through the importer.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Project } from '../../types'
import type { MeshBuffers } from '../../mesh/types'

const stlBytesById = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { createLocalGeomService } = await import('../../geom')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { MOVE_FLAT_FACE_KIND } = await import('../../mesh/edit')
const { primeBoringKernel } = await import('../../mesh/edit/operations/enlargeHole')
const { recognizeFlatFaces } = await import('../../mesh/recognition')
const { recognizeMeshFeatures } = await import('../../mesh/recognition/recognize')
const { buildStlModelBodyModel } = await import('../../components/model3d/workbench/stlModelBody')
const { planStlFeatureEdits } = await import('../../components/model3d/workbench/stlFeatureEdits')
const { standardViewFrame } = await import('../../lib/drawing/project')
const { resolveDrawingReference } = await import('../../lib/drawing/resolve')
const {
  buildMeshDrawingSource,
  measureMeshFeature,
  placeMeshChainReference,
  placeMeshFeatureReference,
  projectMeshDrawingSource,
} = await import('../../lib/drawing/meshSource')
type MeshDrawingSource = import('../../lib/drawing/meshSource').MeshDrawingSource
type ProjectionScene = import('../../lib/drawing/types').ProjectionScene

const EVIDENCE_DIR = 'src/tests/evidence/WO-2750/D'
const record: Record<string, unknown> = {}
const GEO_ID = 'g-stl-2988'
const SCOPE = { modelItemId: 'item-stl', documentId: 'doc-stl', lineageId: GEO_ID, importAssetId: GEO_ID }

// ---------------------------------------------------------------- fixtures

let holedBytes: ArrayBuffer // 100 x 50 x 20 block, 10 mm through hole at (30, 25)
let movedBytes: ArrayBuffer // the same block, hole at (70, 25): another file
let coarseBytes: ArrayBuffer // the first part, tessellated coarsely
let twoHoleBytes: ArrayBuffer // holes at (30, 25) and (70, 25)
let touchingBytes: ArrayBuffer // two cubes sharing one edge: non-manifold

beforeAll(async () => {
  const g = createLocalGeomService()
  await g.init()
  await primeBoringKernel()
  const stl = async (holes: number[], deflection: number, angular = 0.1) => {
    const b = await g.makeBox('F1', { x: 100, y: 50, z: 20 })
    let body = b.body!
    if (holes.length > 0) {
      const h = await g.makeHole({ featureId: 'H1', body, face: 'F1:BOX:zMax', points: holes.map(x => ({ x, y: 25, z: 20 })), style: { kind: 'simple', diameter: 10 }, depth: { kind: 'throughAll' } })
      body = h.body!
    }
    const t = await g.tessellate(body, { deflection, angularDeflection: angular })
    return exportBinaryStl({ positions: new Float32Array(t.position), indices: new Uint32Array(t.index) }).bytes
  }
  holedBytes = await stl([30], 0.01)
  movedBytes = await stl([70], 0.01)
  coarseBytes = await stl([30], 0.2, 0.5)
  twoHoleBytes = await stl([30, 70], 0.01)
  // Two 10 mm cubes meeting along one edge (x = 10, y = 10).
  const c1 = await g.makeBox('C1', { x: 10, y: 10, z: 10 })
  const t1 = await g.tessellate(c1.body!, { deflection: 0.1 })
  const t2 = await g.tessellate(c1.body!, { deflection: 0.1 })
  const shifted = new Float32Array(t2.position).map((v, i) => (i % 3 === 2 ? v : v + 10))
  const positions = new Float32Array([...t1.position, ...shifted])
  const indices = new Uint32Array([...t1.index, ...Array.from(t2.index, v => v + t1.position.length / 3)])
  touchingBytes = exportBinaryStl({ positions, indices }).bytes
}, 300_000)

function projectFixture(): Project {
  return {
    id: 'p-2988', name: 'Drawing of an STL', version: '1.0.0',
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null, notes: '',
  } as unknown as Project
}

/** Put an STL row in the store the way an import leaves it, its bytes in the cache. */
function importRow(bytes: ArrayBuffer): void {
  stlBytesById.set(GEO_ID, bytes)
  const mesh = importStl(bytes).mesh
  const row = {
    id: GEO_ID, name: 'Holed block', filename: 'holed-block.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 20 }, size: { x: 100, y: 50, z: 20 }, center: { x: 50, y: 25, z: 10 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, faceCount: mesh.indices.length / 3,
  } as ImportedGeometry
  useCamStore.setState({ project: { ...projectFixture(), geometry: [row] } })
}

function row(): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find(g => g.id === GEO_ID)
  if (!found) throw new Error('the fixture row vanished')
  return found
}

/** The drawing source of the store row as it stands: its bytes + its journal. */
function rowSource(settings?: Parameters<typeof buildMeshDrawingSource>[0]['settings']): MeshDrawingSource {
  return buildMeshDrawingSource({ scope: SCOPE, bytes: stlBytesById.get(GEO_ID), edits: row().meshEdits, settings })
}

/** Current-mesh facets of the flat face facing up at Z `z`, picked by the product's recogniser. */
function topFaceFacets(z: number): number[] {
  const model = buildStlModelBodyModel({ geoId: GEO_ID, name: 'x', bytes: stlBytesById.get(GEO_ID)!, meshEdits: row().meshEdits })
  const faces = recognizeFlatFaces(model.mesh, model.sourceFacetIds).faces
  const face = faces.find(f => Math.abs(f.plane.normal[2] - 1) < 1e-6 && Math.abs(f.plane.point[2] - z) < 1e-4)
  if (!face) throw new Error(`no face facing up at Z ${z}`)
  const wanted = new Set(face.sourceFacetIds)
  const facets: number[] = []
  model.sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) facets.push(facet) })
  return facets
}

/** Plan one hole edit with the Model screen's planner and add it through the store. */
async function holeEdit(atX: number, request: (feature: ReturnType<typeof buildStlModelBodyModel>['features'][number]) => Parameters<typeof planStlFeatureEdits>[1][number]) {
  const model = buildStlModelBodyModel({ geoId: GEO_ID, name: 'x', bytes: stlBytesById.get(GEO_ID)!, meshEdits: row().meshEdits })
  const feature = model.features.find(f => f.kind === 'through-hole' && model.roundFeatures.some(r => r.id === f.id && Math.abs(r.axis.origin[0] - atX) < 0.5))
  if (!feature) throw new Error(`no through hole at x = ${atX}`)
  const plan = planStlFeatureEdits(model, [request(feature)])
  if (!plan.ok) throw new Error(`the planner refused: ${plan.reason}`)
  for (const p of plan.edits) await useCamStore.getState().addMeshEdit(GEO_ID, p.edit)
}

/** The bore's top rim: closed chain at z = `z` within 6 mm of (x, 25). */
function rimId(src: MeshDrawingSource, x: number, z: number): string | undefined {
  return src.chains.find(c => c.closed && c.points.every(p => Math.abs(p[2] - z) < 1e-3 && Math.hypot(p[0] - x, p[1] - 25) < 6))?.id
}

function holeSupport(src: MeshDrawingSource, x: number): string | undefined {
  return src.features.find(f => f.featureKind === 'through-hole' && f.supportFingerprint.split('|')[1].startsWith(`${x.toFixed(2)},`))?.supportFingerprint
}

function zRange(mesh: MeshBuffers): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let i = 2; i < mesh.positions.length; i += 3) { lo = Math.min(lo, mesh.positions[i]); hi = Math.max(hi, mesh.positions[i]) }
  return [lo, hi]
}

function asScene(s: ReturnType<typeof projectMeshDrawingSource>): ProjectionScene {
  if ('absent' in s) throw new Error(`no view: ${s.absent}`)
  return s
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d

beforeEach(() => {
  stlBytesById.clear()
})

// ------------------------------------------------------------------ cases

describe('an unedited STL row', () => {
  it('chains and the fitted hole are current; the hole value carries its fit deviation and says it is approximate', () => {
    importRow(holedBytes)
    const src = rowSource()
    expect(src.state.kind).toBe('mesh')
    expect(src.appliedEdits).toBe(0)
    const rim = placeMeshChainReference(src, rimId(src, 30, 20)!, 'ref:rim')!
    const hole = placeMeshFeatureReference(src, holeSupport(src, 30)!, 'ref:hole')!
    expect(resolveDrawingReference(rim, rowSource().state)).toMatchObject({ state: 'current', via: 'exact' })
    const m = measureMeshFeature(hole, rowSource())
    expect(m.result).toMatchObject({ state: 'current', via: 'exact' })
    expect(m.diametersMm![0]).toBeCloseTo(10, 1)
    expect(m.depthMm).toBeCloseTo(20, 3)
    expect(m.maxDeviationMm).toBeGreaterThan(0)
    expect(m.maxDeviationMm).toBeLessThan(m.toleranceMm!)
    expect(m).toMatchObject({ approximate: true, provenance: 'source' })
    expect(src.quality).toMatchObject({ watertight: true, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, generatedFacetCount: 0 })
    // No selector the adapter makes carries a recogniser query id or a facet number.
    const queryIds = recognizeMeshFeatures(src.mesh!).features.map(f => f.id)
    for (const ref of [rim, hole]) for (const q of queryIds) expect(JSON.stringify(ref.selector)).not.toContain(q)
    record.unedited = { triangles: src.quality!.triangleCount, diameterMm: round(m.diametersMm![0]), maxDeviationMm: round(m.maxDeviationMm!, 6), toleranceMm: m.toleranceMm, queryIds }
  })
})

describe('STL journal edit versus original bytes', () => {
  it('the drawing is made from the EDITED mesh: pulling the top 5 mm makes the hole 25 deep; the old hole is not current, the untouched bottom rim is', async () => {
    importRow(holedBytes)
    const before = rowSource()
    const topRim = placeMeshChainReference(before, rimId(before, 30, 20)!, 'ref:top-rim')!
    const bottomRim = placeMeshChainReference(before, rimId(before, 30, 0)!, 'ref:bottom-rim')!
    const hole = placeMeshFeatureReference(before, holeSupport(before, 30)!, 'ref:hole')!

    await useCamStore.getState().addMeshEdit(GEO_ID, { kind: MOVE_FLAT_FACE_KIND, facets: topFaceFacets(20), parameters: { distanceMm: 5 } })
    expect(row().meshEdits).toHaveLength(1)
    const after = rowSource()
    // The original bytes are untouched; the drawing source is the edited part.
    expect(zRange(importStl(stlBytesById.get(GEO_ID)!).mesh)[1]).toBeCloseTo(20, 4)
    expect(zRange(after.mesh!)[1]).toBeCloseTo(25, 4)
    expect(after.state.kind === 'mesh' && after.state.revision.journalFingerprint).not.toBe('none')
    expect(after.appliedEdits).toBe(1)

    const holeNow = measureMeshFeature(hole, after)
    expect(holeNow.result).toMatchObject({ state: 'stale', reason: 'mesh-feature-not-proved', resolvedIds: [] })
    expect(holeNow.diametersMm).toBeUndefined() // no fresh number from an unproved target
    expect(holeNow.result.candidates).toEqual([holeSupport(after, 30)]) // the 25 mm deep hole, for repair only
    expect(holeSupport(after, 30)).toContain('|25.00|')
    expect(resolveDrawingReference(topRim, after.state)).toMatchObject({ state: 'stale', reason: 'mesh-chain-not-proved' })
    const bottom = resolveDrawingReference(bottomRim, after.state)
    record.journalEdit = {
      zMaxOriginalBytes: 20, zMaxDrawingSource: round(zRange(after.mesh!)[1]),
      hole: [holeNow.result.state, holeNow.result.reason], topRim: resolveDrawingReference(topRim, after.state).state,
      bottomRim: [bottom.state, bottom.reason ?? null],
    }
    // Measured: the untouched bottom rim keeps its geometry-derived id and its
    // points, so it stays current through the edit (via lineage: the source changed).
    expect(bottom).toMatchObject({ state: 'current', via: 'lineage', resolvedIds: [(bottomRim.selector as { chainId: string }).chainId] })
  })

  it('a re-bored hole is made of generated facets: it gets a fingerprint from its geometry and no facet-number identity', async () => {
    importRow(holedBytes)
    const before = rowSource()
    const hole = placeMeshFeatureReference(before, holeSupport(before, 30)!, 'ref:hole')!
    await holeEdit(30, feature => ({ tool: 'resize-hole', feature, diameterMm: 12 }))
    const after = rowSource()
    expect(after.quality!.generatedFacetCount).toBeGreaterThan(0)
    const bored = after.features.find(f => f.featureKind === 'through-hole')!
    expect(bored.diametersMm[0]).toBeCloseTo(12, 1)
    expect(bored.generatedFacetCount).toBeGreaterThan(0)
    expect(bored.provenance).not.toBe('source')
    expect(measureMeshFeature(hole, after).result).toMatchObject({ state: 'stale', reason: 'mesh-feature-not-proved' })
    // A reference placed on the new bore names its geometry, not facets.
    const placed = placeMeshFeatureReference(after, bored.supportFingerprint, 'ref:bored')!
    expect(placed.selector).toEqual({ kind: 'mesh-feature', featureKind: 'through-hole', supportFingerprint: bored.supportFingerprint, settingsFingerprint: after.settingsFingerprint })
    expect(measureMeshFeature(placed, rowSource()).result.state).toBe('current')
    record.generatedFacets = { edited: after.quality!.generatedFacetCount, boreProvenance: bored.provenance, boreGenerated: bored.generatedFacetCount, boreSourced: bored.sourceFacetCount, diameterMm: round(bored.diametersMm[0]), maxDeviationMm: round(bored.maxDeviationMm, 6) }
  })

  it('the source file replaced under its journal: replay stops; references are stale and the view still draws, saying where it stopped', async () => {
    importRow(holedBytes)
    const before = rowSource()
    const rim = placeMeshChainReference(before, rimId(before, 30, 0)!, 'ref:rim')!
    await useCamStore.getState().addMeshEdit(GEO_ID, { kind: MOVE_FLAT_FACE_KIND, facets: topFaceFacets(20), parameters: { distanceMm: 5 } })
    // Another file under the same row id; the journal's selection no longer matches.
    stlBytesById.set(GEO_ID, movedBytes)
    const src = rowSource()
    expect(src.stopped).toBeDefined()
    expect(src.appliedEdits).toBe(0)
    expect(resolveDrawingReference(rim, src.state)).toMatchObject({ state: 'stale', reason: 'mesh-replay-stopped' })
    const view = asScene(projectMeshDrawingSource(src, standardViewFrame('front')))
    expect(view.stats.visibleLengthMm).toBeGreaterThan(0)
    expect(view.limits.some(l => l.includes('edit journal stopped at edit 1'))).toBe(true)
    record.replayStop = { reason: src.stopped!.reason, reference: 'stale/mesh-replay-stopped', viewVisibleMm: round(view.stats.visibleLengthMm, 2) }
  })

  it('remove one hole and move its neighbour onto the same spot: the first hole\'s references never come back current', async () => {
    importRow(twoHoleBytes)
    const before = rowSource()
    const rimA = placeMeshChainReference(before, rimId(before, 30, 20)!, 'ref:rimA')!
    const holeA = placeMeshFeatureReference(before, holeSupport(before, 30)!, 'ref:holeA')!
    await holeEdit(30, feature => ({ tool: 'defeature', feature }))
    await holeEdit(70, feature => ({ tool: 'move-hole', feature, translation: [-40, 0, 0] }))
    expect(row().meshEdits).toHaveLength(2)
    const after = rowSource()
    expect(after.stopped).toBeUndefined()
    const rim = resolveDrawingReference(rimA, after.state)
    const hole = resolveDrawingReference(holeA, after.state)
    expect(rim.state).not.toBe('current')
    expect(hole.state).not.toBe('current')
    expect(hole.resolvedIds).toEqual([])
    record.lookAlikeByJournal = {
      rim: [rim.state, rim.reason], hole: [hole.state, hole.reason],
      featuresAfter: after.features.length, refusedRegions: after.quality!.refusedRegionCount,
      rimAt30After: rimId(after, 30, 20) ?? null, rimAt30Before: (rimA.selector as { chainId: string }).chainId,
    }
  })
})

describe('reorder, remesh and detector settings', () => {
  it('a reordered file: chain and fitted hole stay current although the recogniser query id changed', () => {
    importRow(holedBytes)
    const src = rowSource()
    const rim = placeMeshChainReference(src, rimId(src, 30, 20)!, 'ref:rim')!
    const hole = placeMeshFeatureReference(src, holeSupport(src, 30)!, 'ref:hole')!
    const mesh = importStl(holedBytes).mesh
    const n = mesh.indices.length / 3
    const out = new Uint32Array(mesh.indices.length)
    for (let i = 0; i < n; i++) {
      const s = (i * 7919) % n
      out.set([mesh.indices[s * 3 + 1], mesh.indices[s * 3 + 2], mesh.indices[s * 3]], i * 3)
    }
    const reordered = exportBinaryStl({ positions: mesh.positions, indices: out }).bytes
    const now = buildMeshDrawingSource({ scope: SCOPE, bytes: reordered })
    expect(resolveDrawingReference(rim, now.state)).toMatchObject({ state: 'current', via: 'lineage' })
    expect(measureMeshFeature(hole, now).result).toMatchObject({ state: 'current', via: 'lineage' })
    const qA = recognizeMeshFeatures(src.mesh!).features[0].id
    const qB = recognizeMeshFeatures(now.mesh!).features[0].id
    expect(qA).not.toBe(qB)
    record.reorder = { queryIdBefore: qA, queryIdAfter: qB, chain: 'current', feature: 'current' }
  })

  it('a different file with the hole moved 40 mm keeps the query id; the drawing does not follow it', () => {
    importRow(holedBytes)
    const src = rowSource()
    const hole = placeMeshFeatureReference(src, holeSupport(src, 30)!, 'ref:hole')!
    const moved = buildMeshDrawingSource({ scope: SCOPE, bytes: movedBytes })
    expect(recognizeMeshFeatures(moved.mesh!).features[0].id).toBe(recognizeMeshFeatures(src.mesh!).features[0].id)
    expect(measureMeshFeature(hole, moved).result).toMatchObject({ state: 'stale', reason: 'mesh-feature-not-proved', resolvedIds: [] })
  })

  it('a coarse remesh: the rim is stale; the hole whose fit still proves the same support is current and carries the coarse fit error; changed settings are unsupported', () => {
    importRow(holedBytes)
    const fine = rowSource()
    const rim = placeMeshChainReference(fine, rimId(fine, 30, 20)!, 'ref:rim')!
    const hole = placeMeshFeatureReference(fine, holeSupport(fine, 30)!, 'ref:hole')!
    const coarse = buildMeshDrawingSource({ scope: SCOPE, bytes: coarseBytes })
    expect(coarse.quality!.triangleCount).toBeLessThan(fine.quality!.triangleCount / 4)
    expect(resolveDrawingReference(rim, coarse.state)).toMatchObject({ state: 'stale', reason: 'mesh-chain-not-proved' })
    // Measured: the coarse fit still lands on the same axis line, 10.00 mm and
    // 20.00 mm deep at the 0.01 mm fingerprint grid, so the support is proved
    // (contract section 5: geometry is the proof, never the query id). Its
    // value comes with the COARSE fit error beside it, not the fine one.
    const fineHole = measureMeshFeature(hole, fine)
    const coarseHole = measureMeshFeature(hole, coarse)
    expect(coarseHole.result).toMatchObject({ state: 'current', via: 'lineage' })
    expect(coarseHole.maxDeviationMm!).toBeGreaterThan(fineHole.maxDeviationMm! * 5)
    expect(coarseHole.maxDeviationMm!).toBeLessThan(coarseHole.toleranceMm!)
    const other = rowSource({ featureAngleDeg: 45 })
    expect(other.settingsFingerprint).not.toBe(fine.settingsFingerprint)
    expect(resolveDrawingReference(rim, other.state)).toMatchObject({ state: 'unsupported', reason: 'detector-settings-changed' })
    expect(measureMeshFeature(hole, rowSource({ recognition: { toleranceMm: 0.1 } })).result).toMatchObject({ state: 'unsupported', reason: 'detector-settings-changed' })
    // Writing a default out explicitly is the same setting.
    expect(rowSource({ featureAngleDeg: 30 }).settingsFingerprint).toBe(fine.settingsFingerprint)
    record.coarse = {
      triangles: [fine.quality!.triangleCount, coarse.quality!.triangleCount],
      rim: 'stale/mesh-chain-not-proved', hole: coarseHole.result.state,
      diameterMm: { fine: round(fineHole.diametersMm![0], 6), coarse: round(coarseHole.diametersMm![0], 6) },
      fitDeviationMm: { fine: round(fineHole.maxDeviationMm!, 6), coarse: round(coarseHole.maxDeviationMm!, 6) },
    }
  })
})

describe('meshes that are not clean solids still draw', () => {
  it('an open mesh (top deleted) and a non-manifold pair project; the view says what it cannot promise', () => {
    // An STL file with the top face's triangles left out, read by the importer.
    const mesh = importStl(holedBytes).mesh
    const keep: number[] = []
    for (let t = 0; t < mesh.indices.length / 3; t++) {
      const zs = [0, 1, 2].map(k => mesh.positions[mesh.indices[t * 3 + k] * 3 + 2])
      if (!zs.every(z => Math.abs(z - 20) < 1e-4)) keep.push(mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2])
    }
    const openBytes = exportBinaryStl({ positions: mesh.positions, indices: Uint32Array.from(keep) }).bytes
    const open = buildMeshDrawingSource({ scope: SCOPE, bytes: openBytes })
    expect(open.quality!.watertight).toBe(false)
    expect(open.quality!.boundaryEdgeCount).toBeGreaterThan(0)
    const openFront = asScene(projectMeshDrawingSource(open, standardViewFrame('front')))
    const openTop = asScene(projectMeshDrawingSource(open, standardViewFrame('top')))
    expect(openFront.stats.visibleLengthMm).toBeGreaterThan(200)
    expect(openTop.limits.some(l => l.startsWith('Open mesh:'))).toBe(true)

    const pair = buildMeshDrawingSource({ scope: SCOPE, bytes: touchingBytes })
    expect(pair.quality!.nonManifoldEdgeCount).toBeGreaterThan(0)
    const pairIso = asScene(projectMeshDrawingSource(pair, standardViewFrame('iso')))
    expect(pairIso.stats.visibleLengthMm).toBeGreaterThan(0)
    expect(pairIso.limits.some(l => l.startsWith('Non-manifold mesh:'))).toBe(true)
    record.notClean = {
      open: { boundaryEdges: open.quality!.boundaryEdgeCount, features: open.features.map(f => [f.featureKind, round(f.maxDeviationMm, 6)]), refused: open.quality!.refusedRegionCount, frontVisibleMm: round(openFront.stats.visibleLengthMm, 2), topVisibleMm: round(openTop.stats.visibleLengthMm, 2) },
      nonManifold: { edges: pair.quality!.nonManifoldEdgeCount, isoVisibleMm: round(pairIso.stats.visibleLengthMm, 2) },
    }
  })

  it('a missing or unreadable asset is missing / source-missing and draws nothing', () => {
    importRow(holedBytes)
    const src = rowSource()
    const rim = placeMeshChainReference(src, rimId(src, 30, 20)!, 'ref:rim')!
    stlBytesById.delete(GEO_ID)
    const gone = rowSource()
    expect(gone).toMatchObject({ problem: 'asset-missing', state: { kind: 'absent' } })
    expect(resolveDrawingReference(rim, gone.state)).toMatchObject({ state: 'missing', reason: 'source-missing' })
    expect(projectMeshDrawingSource(gone, standardViewFrame('front'))).toMatchObject({ absent: 'asset-missing' })
    const junk = buildMeshDrawingSource({ scope: SCOPE, bytes: new Uint8Array([1, 2, 3]) })
    expect(junk.state.kind).toBe('absent')
    expect(resolveDrawingReference(rim, junk.state)).toMatchObject({ state: 'missing', reason: 'source-missing' })
    record.missing = { absent: gone.problem, junk: junk.problem }
  })

  it('the mesh adapter never converts the mesh to a BREP', () => {
    const text = readFileSync('src/lib/drawing/meshSource.ts', 'utf8')
    for (const route of ['stepFromMesh', 'promoteImportedMeshModel', 'prismaticBrep', 'buildPrismatic']) expect(text).not.toContain(route)
  })
})

describe('evidence', () => {
  it('writes the measured outcomes when asked', () => {
    if (process.env.WO2988_EVIDENCE !== '1') return
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(`${EVIDENCE_DIR}/mesh-measured.json`, JSON.stringify(record, null, 2) + '\n')
  })
})

