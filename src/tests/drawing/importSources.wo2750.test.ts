// WO-2988 (WO-2750 Slice D): drawings of an imported STEP file, through the
// adapter.
//
// Row of docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 8 this file
// answers: "STEP import, multi-solid and replacement". Contract:
// src/tests/evidence/WO-2750/A/REFERENCE-CONTRACT.md section 4.
//
// Rule 6 route. The STEP files are written by the modeling kernel's own
// exporter from real parts, and every source is built ONLY by
// buildStepDrawingSource, which imports them through the kernel's
// `importStep(bytes, nodeId)` and keeps the node's `bodyIndex` solid, as the
// Model screen's import node replay does (store/headlessModelBodyReplay.ts).
// The view is the drawing kernel's hidden-line removal of that same solid.

import { mkdirSync, writeFileSync } from 'node:fs'
import { OcctKernel } from 'occt-wasm'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import { buildStepDrawingSource, placeStepEdgeReference, placeStepFaceReference, projectStepDrawingSource, stepSolidKey, type StepDrawingSource, type StepSourceInput } from '../../lib/drawing/brepSource'
import { contentFingerprint } from '../../lib/drawing/meshSource'
import { standardViewFrame } from '../../lib/drawing/project'
import { resolveDrawingReference, resolveLinearPlaneDimension } from '../../lib/drawing/resolve'
import type { ProjectionScene } from '../../lib/drawing/types'

const EVIDENCE_DIR = 'src/tests/evidence/WO-2750/D'
const record: Record<string, unknown> = {}
const BUILD = 'occt-8.0/occt-wasm-3.6.1-geo9-iges-history-stack/step-import-order-lineage-v1'
const SCOPE = { modelItemId: 'item-step', documentId: 'doc-step', lineageId: 'IMP1', importAssetId: 'asset-step-1' }

let g: GeomClient
let k: OcctKernel
let block100: ArrayBuffer // 100 x 50 x 20 block with a 10 mm through hole at (30, 25)
let block100again: ArrayBuffer // the same part exported again
let block120: ArrayBuffer // the edited part: 120 long
let twoSolids: ArrayBuffer // that block and a 10 mm cube in one file

beforeAll(async () => {
  g = createLocalGeomService()
  await g.init()
  k = await OcctKernel.init()
  const part = async (x: number) => {
    const b = await g.makeBox('F1', { x, y: 50, z: 20 })
    const h = await g.makeHole({ featureId: 'H1', body: b.body!, face: 'F1:BOX:zMax', points: [{ x: 30, y: 25, z: 20 }], style: { kind: 'simple', diameter: 10 }, depth: { kind: 'throughAll' } })
    return h.body!
  }
  block100 = await g.exportStep([await part(100)])
  block100again = await g.exportStep([await part(100)])
  block120 = await g.exportStep([await part(120)])
  twoSolids = await g.exportStep([await part(100), (await g.makeBox('F9', { x: 10, y: 10, z: 10 })).body!])
}, 300_000)

function input(bytes: ArrayBuffer | null, solidIndex = 0, extra: Partial<StepSourceInput> = {}): StepSourceInput {
  return { scope: SCOPE, bytes, importNodeId: 'IMP1', solidIndex, producerVersion: BUILD, ...extra }
}

/** The live face of `src` whose plane normal is `n`. */
function planeFace(src: StepDrawingSource, n: [number, number, number]): string {
  if (src.state.kind === 'absent') throw new Error('absent source')
  const map = src.state.map
  const id = map.liveIds().find(f => {
    const s = map.snapshotOf(f)
    return s?.surfaceType === 'plane' && s.normal && Math.abs(s.normal.x - n[0]) < 1e-6 && Math.abs(s.normal.y - n[1]) < 1e-6 && Math.abs(s.normal.z - n[2]) < 1e-6
  })
  if (!id) throw new Error(`no plane facing ${n}`)
  return id
}

function boreFace(src: StepDrawingSource): string {
  if (src.state.kind === 'absent') throw new Error('absent source')
  const map = src.state.map
  return map.liveIds().find(f => map.snapshotOf(f)?.surfaceType === 'cylinder')!
}

function asScene(s: ProjectionScene | { absent: string }): ProjectionScene {
  if ('absent' in s) throw new Error(`no view: ${s.absent}`)
  return s
}

async function release(...srcs: StepDrawingSource[]) {
  for (const s of srcs) if (s.handle !== undefined) await g.dispose(s.handle)
}

describe('STEP replacement policy through the import route', () => {
  it('the same bytes rehydrate: faces, an edge and the 100 mm length are current', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    expect(placed.state.kind).toBe('imported-brep')
    expect(placed.solidCount).toBe(1)
    const left = placeStepFaceReference(placed, planeFace(placed, [-1, 0, 0]), 'plane', 'ref:left')!
    const right = placeStepFaceReference(placed, planeFace(placed, [1, 0, 0]), 'plane', 'ref:right')!
    const bore = placeStepFaceReference(placed, boreFace(placed), 'axis', 'ref:bore')!
    const live = placed.state.kind === 'imported-brep' ? [...placed.state.liveEdgeIds!] : []
    const edge = placeStepEdgeReference(placed, live[0], 'ref:edge')!
    expect(left.selector).toMatchObject({ kind: 'face' })
    expect((left.selector as { stableId: string }).stableId).toMatch(/^IMP1:step:face#\d+$/)

    const reopened = await buildStepDrawingSource(g, input(block100))
    expect(contentFingerprint(block100)).toBe(reopened.state.kind !== 'absent' && reopened.state.scope.importContentFingerprint)
    for (const ref of [left, right, bore, edge]) {
      expect(resolveDrawingReference(ref, reopened.state)).toMatchObject({ state: 'current', via: 'exact' })
    }
    expect(resolveLinearPlaneDimension([left, right], reopened.state)).toMatchObject({ state: 'current', valueMm: 100 })
    record.sameBytes = { faces: placed.state.kind !== 'absent' ? placed.state.map.liveIds().length : 0, liveEdges: live.length, edge: live[0], lengthMm: 100 }
    await release(placed, reopened)
  })

  it('changed bytes keep the face#i strings but are NOT current; the dimension prints no number', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    const leftId = planeFace(placed, [-1, 0, 0])
    const left = placeStepFaceReference(placed, leftId, 'plane', 'ref:left')!
    const right = placeStepFaceReference(placed, planeFace(placed, [1, 0, 0]), 'plane', 'ref:right')!
    const edited = await buildStepDrawingSource(g, input(block120))
    expect(edited.state.kind !== 'absent' && edited.state.map.has(leftId)).toBe(true) // the same index string exists...
    const res = resolveDrawingReference(left, edited.state)
    expect(res).toMatchObject({ state: 'stale', reason: 'import-replaced-without-lineage', resolvedIds: [], candidates: [leftId] }) // ...as a seed only
    const dim = resolveLinearPlaneDimension([left, right], edited.state)
    expect(dim.state).toBe('stale')
    expect(dim.valueMm).toBeUndefined()
    // A re-export of the same part is other bytes, so it is a replacement too:
    // only the content decides "same file", never the face numbering.
    // Measured: the exporter writes a new header each time, so the bytes differ.
    const again = await buildStepDrawingSource(g, input(block100again))
    const sameContent = contentFingerprint(block100again) === contentFingerprint(block100)
    expect(sameContent).toBe(false)
    expect(resolveDrawingReference(left, again.state)).toMatchObject({ state: 'stale', reason: 'import-replaced-without-lineage' })
    record.changedBytes = { faceId: leftId, presentInNewFile: true, state: res.state, reason: res.reason, reExportSameBytes: sameContent }
    await release(placed, edited, again)
  })

  it('another kernel build is stale / producer-changed: face order is only promised per build', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    const left = placeStepFaceReference(placed, planeFace(placed, [-1, 0, 0]), 'plane', 'ref:left')!
    const other = await buildStepDrawingSource(g, input(block100, 0, { producerVersion: `${BUILD}+next` }))
    expect(resolveDrawingReference(left, other.state)).toMatchObject({ state: 'stale', reason: 'producer-changed' })
    await release(placed, other)
  })
})

describe('multi-solid STEP: the solid is part of the scope', () => {
  it('each solid is named; a reference on solid 1 never resolves on solid 0, and the unkept solid is disposed', async () => {
    const disposed: unknown[] = []
    const counting = { ...g, importStep: g.importStep.bind(g), tessellate: g.tessellate.bind(g), serializeBody: g.serializeBody.bind(g), dispose: async (h: Parameters<GeomClient['dispose']>[0]) => { disposed.push(h); return g.dispose(h) } }
    const s1 = await buildStepDrawingSource(counting, input(twoSolids, 1))
    expect(s1.solidCount).toBe(2)
    expect(disposed).toHaveLength(1) // solid 0 was imported too, and released
    expect(s1.state.kind !== 'absent' && s1.state.scope.importSolidKey).toBe(stepSolidKey(1))
    const cubeTop = placeStepFaceReference(s1, planeFace(s1, [0, 0, 1]), 'plane', 'ref:cube-top')!
    expect(cubeTop.source.importSolidKey).toBe('solid-1')
    // Measured: the second solid's faces are numbered on from the first's.
    const s0 = await buildStepDrawingSource(g, input(twoSolids, 0))
    expect(s0.state.kind !== 'absent' && s0.state.map.has((cubeTop.selector as { stableId: string }).stableId)).toBe(false)
    expect(resolveDrawingReference(cubeTop, s1.state)).toMatchObject({ state: 'current' })
    expect(resolveDrawingReference(cubeTop, s0.state)).toMatchObject({ state: 'missing', reason: 'scope-mismatch' })
    // A solid the file does not have is a missing source, never solid 0.
    const s2 = await buildStepDrawingSource(g, input(twoSolids, 2))
    expect(s2).toMatchObject({ problem: 'solid-missing', solidCount: 2, state: { kind: 'absent' } })
    expect(resolveDrawingReference(cubeTop, s2.state)).toMatchObject({ state: 'missing', reason: 'source-missing' })
    record.multiSolid = { solids: s1.solidCount, cubeTopFace: (cubeTop.selector as { stableId: string }).stableId, onSolid0: 'missing/scope-mismatch', solidIndex2: s2.problem }
    await release(s0, s1)
  })

  it('the same asset in another Model Item does not resolve', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    const left = placeStepFaceReference(placed, planeFace(placed, [-1, 0, 0]), 'plane', 'ref:left')!
    const elsewhere = await buildStepDrawingSource(g, input(block100, 0, { scope: { ...SCOPE, modelItemId: 'item-other' } }))
    expect(resolveDrawingReference(left, elsewhere.state)).toMatchObject({ state: 'missing', reason: 'scope-mismatch' })
    await release(placed, elsewhere)
  })
})

describe('missing and unreadable assets', () => {
  it('no bytes, or bytes the kernel cannot read: the source is missing and nothing is drawn', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    const left = placeStepFaceReference(placed, planeFace(placed, [-1, 0, 0]), 'plane', 'ref:left')!
    const gone = await buildStepDrawingSource(g, input(null))
    expect(gone).toMatchObject({ problem: 'asset-missing', state: { kind: 'absent' } })
    expect(resolveDrawingReference(left, gone.state)).toMatchObject({ state: 'missing', reason: 'source-missing' })
    expect(await projectStepDrawingSource(g, gone, k, standardViewFrame('front'))).toMatchObject({ absent: 'asset-missing' })
    const junk = await buildStepDrawingSource(g, input(new TextEncoder().encode('ISO-10303-21;\nnot a model\n').buffer as ArrayBuffer))
    expect(junk.state.kind).toBe('absent')
    expect(junk.problem).toBe('import-failed')
    // CONTROL (fake client, labelled): a kernel that throws instead of
    // reporting a diagnostic is also a failed import, and a kept solid whose
    // tessellation throws is released, not leaked.
    const throwing = { ...g, importStep: async () => { throw new Error('worker gone') } } as unknown as GeomClient
    expect(await buildStepDrawingSource(throwing, input(block100))).toMatchObject({ problem: 'import-failed', state: { kind: 'absent' } })
    const disposed: unknown[] = []
    const noTess = { importStep: g.importStep.bind(g), serializeBody: g.serializeBody.bind(g), tessellate: async () => { throw new Error('tess failed') }, dispose: async (h: Parameters<GeomClient['dispose']>[0]) => { disposed.push(h); return g.dispose(h) } }
    expect(await buildStepDrawingSource(noTess, input(block100))).toMatchObject({ problem: 'import-failed', state: { kind: 'absent' } })
    expect(disposed).toHaveLength(1)
    record.missing = { noBytes: gone.problem, junk: junk.problem, junkDiagnostics: junk.diagnostics.map(d => d.severity) }
    await release(placed)
  })
})

describe('edges and vertices of an imported solid', () => {
  it('edges are proved against the live edge list; vertex references stay unsupported (no live vertex list exists)', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    if (placed.state.kind === 'absent') throw new Error('absent')
    const live = [...placed.state.liveEdgeIds!]
    expect(live.length).toBeGreaterThan(12)
    expect(live.every(e => e.startsWith('(IMP1:step:face#'))).toBe(true)
    const edge = placeStepEdgeReference(placed, live[3], 'ref:edge')!
    expect(resolveDrawingReference(edge, placed.state)).toMatchObject({ state: 'current', resolvedIds: [live[3]] })
    // An edge that is not in this solid's list is not placed at all.
    expect(placeStepEdgeReference(placed, '(IMP1:step:face#0∧IMP1:step:face#99)', 'ref:x')).toBeUndefined()
    const vertex = { ...edge, id: 'ref:vertex', selector: { kind: 'vertex' as const, stableId: live[3] } }
    expect(resolveDrawingReference(vertex, placed.state)).toMatchObject({ state: 'unsupported', reason: 'topology-unavailable' })
    await release(placed)
  })
})

describe('the drawing of an imported solid', () => {
  it('front view through the kernel hidden-line removal: 240 mm visible outline, 40 mm hidden bore, exactly as the native part', async () => {
    const placed = await buildStepDrawingSource(g, input(block100))
    const front = asScene(await projectStepDrawingSource(g, placed, k, standardViewFrame('front')))
    expect(front.producer).toBe('occt-hlr')
    expect(front.stats.visibleLengthMm).toBeCloseTo(240, 6)
    expect(front.stats.hiddenLengthMm).toBeCloseTo(40, 3)
    const multi = await buildStepDrawingSource(g, input(twoSolids, 1))
    const cube = asScene(await projectStepDrawingSource(g, multi, k, standardViewFrame('front')))
    // Only the named solid is drawn: the 10 mm cube's 40 mm square, nothing of the block.
    expect(cube.stats.visibleLengthMm).toBeCloseTo(40, 6)
    expect(cube.stats.hiddenLengthMm).toBeCloseTo(0, 6)
    record.projection = {
      block: { visibleMm: front.stats.visibleLengthMm, hiddenMm: Math.round(front.stats.hiddenLengthMm * 1e6) / 1e6, ms: Math.round(front.stats.ms) },
      solid1Only: { visibleMm: cube.stats.visibleLengthMm, hiddenMm: cube.stats.hiddenLengthMm },
    }
    await release(placed, multi)
  })
})

describe('evidence', () => {
  it('writes the measured outcomes when asked', () => {
    if (process.env.WO2988_EVIDENCE !== '1') return
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(`${EVIDENCE_DIR}/import-measured.json`, JSON.stringify(record, null, 2) + '\n')
  })
})
