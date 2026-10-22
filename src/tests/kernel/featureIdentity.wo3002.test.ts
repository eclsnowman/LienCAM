// WO-3002 (alpha.3 A3-09 data slice): stable, order-independent identity for
// faces, edges and features. Acceptance 1 (re-import and entity reorder give
// identical ids; the feature-block mesh / STEP twins give the same hole
// features) and 2 (two runs give identical ids and lists).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { featureBlock } from '../../cam3d/fixtures'
import { createLocalGeomService } from '../../geom'
import type { GeomClient } from '../../geom'
import {
  DEFINING_FIELDS, assignIds, edgesFromTessellation, fromLoops, facesFromSnapshots, fromMeshRecognition, fromModelVerdicts, fromStepCylinders,
  edgeMeasure, geometrySignature, identifyEdges, identifyFaces, partFeatureList,
  type AdapterResult, type EdgeDescriptor, type FaceDescriptor, type FeatureSource, type MeshRegionLike, type MeshRoundLike,
  type ModelVerdictLike, type PartFeature, type PartFrame,
} from '../../kernel/features'
import { readStepShape } from '../../lib/cam/geometry/occt/model/core'
import { cylinderFeatures } from '../../lib/cam/geometry/occt/model/derive'
import { loadOcctModel, type OcctModelModule } from '../../lib/cam/geometry/occt/model/loader'
import { recognizeMeshFeatures } from '../../mesh/recognition/recognize'
import type { MeshBuffers } from '../../mesh/types'

const here = dirname(fileURLToPath(import.meta.url))
/* eslint-disable @typescript-eslint/no-explicit-any */
;(globalThis as any).require ??= createRequire(import.meta.url)
;(globalThis as any).__dirname ??= here
;(globalThis as any).__filename ??= fileURLToPath(import.meta.url)
/* eslint-enable @typescript-eslint/no-explicit-any */

const fixture = (name: string) => readFileSync(join(here, '../../../test_fixtures/brep', name), 'utf8')
const frame = (entityId: string): PartFrame => ({ kind: 'geometry-native', entityId })

/**
 * The same solid written in another entity order: every `#n` is renumbered in
 * reverse, the entities are written in their new order, and every shell's face
 * list is reversed, so the reader meets the faces in the opposite order.
 */
function reorderStep(text: string): string {
  const start = text.indexOf('DATA;') + 'DATA;'.length
  const end = text.indexOf('ENDSEC;', start)
  const entities = text.slice(start, end).split(';').map(e => e.trim()).filter(Boolean)
  const ids = entities.map(e => Number(/^#(\d+)/.exec(e)![1]))
  const renumber = new Map(ids.map((id, i) => [id, ids[ids.length - 1 - i]]))
  const rewritten = entities.map(e => {
    let body = e.replace(/#(\d+)/g, (_, n: string) => `#${renumber.get(Number(n)) ?? n}`)
    body = body.replace(/((?:CLOSED|OPEN)_SHELL\s*\(\s*'[^']*'\s*,\s*\()([^)]*)\)/, (_, head: string, list: string) =>
      `${head}${list.split(',').map(s => s.trim()).reverse().join(',')})`)
    return { id: Number(/^#(\d+)/.exec(body)![1]), body }
  }).sort((a, b) => a.id - b.id)
  return `${text.slice(0, start)}\n${rewritten.map(e => `${e.body};`).join('\n')}\n${text.slice(end)}`
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

let g: GeomClient
let oc: OcctModelModule
beforeAll(async () => {
  g = createLocalGeomService()
  await g.init()
  oc = await loadOcctModel({ wasmBinary: readFileSync(join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')) })
}, 180_000)

async function importBody(text: string) {
  const imported = await g.importStep(bytes(text), 'IMP1')
  expect(imported.bodies).toHaveLength(1)
  const body = imported.bodies[0]
  const faces = facesFromSnapshots(body.elementMap.geometry ?? {})
  const edges = edgesFromTessellation(await g.tessellate(body.handle, { deflection: 0.1 }))
  const verdicts = await g.recognizeFeatures(body.handle)
  return { body, faces, edges, verdicts }
}
const modelList = (b: Awaited<ReturnType<typeof importBody>>) => {
  const mapped = fromModelVerdicts(b.verdicts, b.faces)
  return partFeatureList(frame('part'), 'model-kernel', mapped.candidates, mapped.notes)
}
function stepScanList(text: string) {
  const { shape } = readStepShape(oc, new TextEncoder().encode(text), 'wo3002.step')
  const mapped = fromStepCylinders(cylinderFeatures(oc, shape))
  return partFeatureList(frame('part'), 'step-cylinder-scan', mapped.candidates, mapped.notes)
}
const idsOf = (features: readonly PartFeature[]) => features.map(f => `${f.id} ${f.type} ${geometrySignature(f.geometry).signature}`)
const round3 = (p: readonly number[]) => p.map(v => Math.round(v * 1000) / 1000 + 0)
const faceAt = (f: FaceDescriptor) => `${f.surface} ${round3([f.areaMm2, ...f.centroid]).join(',')}`
const edgeAt = (e: EdgeDescriptor) => { const m = edgeMeasure(e); return round3([m.lengthMm, ...m.centroid]).join(',') }

describe('WO-3002 identity is order-independent across re-import and entity order', () => {
  for (const name of ['fix_plate_holes.step', 'fix_feature_block.step']) {
    it(`${name}: faces, edges and model-kernel features keep their ids`, async () => {
      const original = fixture(name)
      const reordered = reorderStep(original)
      expect(reordered).not.toBe(original)
      const a = await importBody(original)
      const again = await importBody(original)
      const b = await importBody(reordered)

      // An id is stable when it names the SAME geometry in both files.
      const facesA = identifyFaces(a.faces), facesB = identifyFaces(b.faces)
      expect(facesA.length).toBe(Object.keys(a.faces).length)
      expect(facesB.map(f => [f.id, faceAt(f.descriptor)])).toEqual(facesA.map(f => [f.id, faceAt(f.descriptor)]))
      expect(identifyFaces(again.faces)).toEqual(facesA)
      // The reorder really moved the faces: today's import ids (IMPn:step:face#i)
      // name different geometry in the two files, ours do not.
      const moved = facesA.filter((f, i) => f.sourceId !== facesB[i].sourceId)
      expect(moved.length).toBeGreaterThan(0)

      const edgesA = identifyEdges(a.edges), edgesB = identifyEdges(b.edges)
      expect(edgesA.length).toBe(Object.keys(a.edges).length)
      expect(edgesB.map(e => [e.id, edgeAt(e.descriptor)])).toEqual(edgesA.map(e => [e.id, edgeAt(e.descriptor)]))
      expect(new Set(edgesA.map(e => e.id)).size).toBe(edgesA.length)

      const featuresA = modelList(a), featuresB = modelList(b)
      expect(featuresA.features.length).toBe(a.verdicts.length)
      expect(idsOf(featuresB.features)).toEqual(idsOf(featuresA.features))
      expect(modelList(again)).toEqual(featuresA)
      console.log(`[WO-3002] ${name}: ${facesA.length} faces (${moved.length} import ids moved), ${edgesA.length} edges, features ${idsOf(featuresA.features).join(', ')}`)
    }, 120_000)

    it(`${name}: the STEP cylinder scan's features keep their ids`, () => {
      const original = fixture(name)
      const a = stepScanList(original)
      expect(a.features.length).toBeGreaterThan(0)
      expect(idsOf(stepScanList(reorderStep(original)).features)).toEqual(idsOf(a.features))
      expect(stepScanList(original)).toEqual(a)
    }, 60_000)
  }
})

describe('WO-3002 the feature-block twins give the same hole features', () => {
  const holes = (list: { features: readonly PartFeature[] }) =>
    list.features.filter(f => f.type === 'throughHole' || f.type === 'blindHole' || f.type === 'counterbore' || f.type === 'countersink' || f.type === 'chamferedHole')
  const summary = (list: { features: readonly PartFeature[] }) => holes(list).map(f => f.type).sort()

  it('mesh twin, model-kernel STEP twin and STEP cylinder scan: same hole count and types', async () => {
    const mesh = recognizeMeshFeatures(featureBlock() as MeshBuffers)
    const meshMapped = fromMeshRecognition(mesh)
    const meshList = partFeatureList(frame('part'), 'stl-mesh', meshMapped.candidates, meshMapped.notes)
    const model = modelList(await importBody(fixture('fix_feature_block.step')))
    const scan = stepScanList(fixture('fix_feature_block.step'))
    expect(summary(meshList)).toEqual(['blindHole', 'throughHole'])
    expect(summary(model)).toEqual(summary(meshList))
    expect(summary(scan)).toEqual(summary(meshList))
    // Same geometry, same id, whichever format it came from: the hole ids
    // depend on type, axis, extent and diameter in the part frame only.
    expect(holes(model).map(f => f.id)).toEqual(holes(meshList).map(f => f.id))
    expect(holes(scan).map(f => f.id)).toEqual(holes(meshList).map(f => f.id))
    // and mesh determinism: two runs, identical lists
    const twice = fromMeshRecognition(recognizeMeshFeatures(featureBlock() as MeshBuffers))
    expect(partFeatureList(frame('part'), 'stl-mesh', twice.candidates, twice.notes)).toEqual(meshList)
  }, 120_000)
})

describe('WO-3002 geometry decides the id, never the input', () => {
  const hole = (x: number) => ({ center: [x, 20] as [number, number], diameter: 6, topZ: 10, bottomZ: 0, through: true })

  it('a moved hole gets a new id; the same hole in any input order keeps its id', () => {
    const list = (holes: ReturnType<typeof hole>[]) => partFeatureList(frame('p'), 'step-cylinder-scan', fromStepCylinders(holes).candidates)
    const ab = list([hole(20), hole(50)]), ba = list([hole(50), hole(20)])
    expect(ba).toEqual(ab)
    const moved = list([hole(20), hole(90)])
    const at = (x: number) => ab.features.find(f => f.geometry.kind === 'axial' && f.geometry.axisPoint[0] === x)!.id
    expect(moved.features.map(f => f.id)).toContain(at(20))
    expect(moved.features.map(f => f.id)).not.toContain(at(50))
  })

  it('collisions are numbered by geometry, not by input order', () => {
    // Force every entry onto one hash bucket: the rule must still order them
    // by signature, then exact geometry, in any input order.
    const entries = [
      { item: 'b', signature: 'same', exact: '2' },
      { item: 'a', signature: 'same', exact: '1' },
      { item: 'c', signature: 'other', exact: '0' },
    ]
    const forward = assignIds('t', entries), backward = assignIds('t', entries.slice().reverse())
    expect(backward).toEqual(forward)
    const same = forward.filter(e => e.signature === 'same')
    expect(same.map(e => e.item)).toEqual(['a', 'b'])
    expect(same[1].id).toBe(`${same[0].id}#1`)
  })

  it('two identical faces (true duplicates) get #1 the same way in either order', () => {
    const face = { surface: 'plane', areaMm2: 100, centroid: [0, 0, 5] as const, normal: [0, 0, 1] as const }
    const one = identifyFaces({ x: face, y: face }), two = identifyFaces({ y: face, x: face })
    expect(one.map(f => f.id)).toEqual(two.map(f => f.id))
    expect(one[1].id).toBe(`${one[0].id}#1`)
  })
})

// ---- fix round 2: every defining field of every kind enters the id ----------
//
// One row per (source, source type) in adapters.ts DEFINING_FIELDS. Each row
// builds ONE recogniser output from plain inputs; `changes` names every
// defining field and changes it alone. A changed field must give a new id; the
// same output, rebuilt (and restated where the source allows: another input
// order, another start corner, the axis the other way), must keep its id.
// The keys of `changes` must be exactly the table's list, so a field added to
// the table without a test, or a test without a table entry, fails here.

type Build<P> = (p: P) => AdapterResult
interface Row<P> {
  source: FeatureSource
  kind: string
  base: P
  build: Build<P>
  changes: Record<string, (p: P) => P>
  /** the same geometry stated another way */
  restated?: (p: P) => P
}
const row = <P>(r: Row<P>): Row<unknown> => r as unknown as Row<unknown>
const oneId = (source: FeatureSource, r: AdapterResult) => {
  expect(r.notes).toEqual([])
  const list = partFeatureList(frame('p'), source, r.candidates)
  expect(list.features).toHaveLength(1)
  return list.features[0]
}

// STEP cylinder scan (R1): plain cylinders.
type Cyl = Parameters<typeof fromStepCylinders>[0][number]
const step: Build<Cyl[]> = c => fromStepCylinders(c)
const withCyl = (c: Cyl[], i: number, change: Partial<Cyl>) => c.map((x, k) => (k === i ? { ...x, ...change } : x))
const bothCyl = (c: Cyl[], change: (x: Cyl) => Partial<Cyl>) => c.map(x => ({ ...x, ...change(x) }))
const bore: Cyl = { center: [20, 25], diameter: 6, topZ: 20, bottomZ: 0, through: true }
const stack: Cyl[] = [
  { center: [20, 25], diameter: 12, topZ: 20, bottomZ: 15, through: false },
  { center: [20, 25], diameter: 6, topZ: 15, bottomZ: 0, through: true },
]

// Model kernel (R2): a FeatureVerdict, optionally with its faces' geometry.
interface Verdict { v: ModelVerdictLike; faces?: Record<string, FaceDescriptor> }
const model: Build<Verdict> = x => fromModelVerdicts([x.v], x.faces)
const params = (x: Verdict, change: Record<string, number | string>): Verdict => ({ ...x, v: { ...x.v, params: { ...x.v.params, ...change } } })
const hole = (featureClass: string, extra: Record<string, number>): Verdict => ({ v: {
  featureKey: 'hole:20:25:20:0:0.6:0.8:3', featureClass, removable: true, faceIds: ['w'],
  params: { axisX: 0, axisY: 0.6, axisZ: 0.8, diameter: 6, depth: 20, radiusCount: 1, openings: 1, ...extra },
} })
const holeChanges = {
  'rim (featureKey)': (x: Verdict) => ({ ...x, v: { ...x.v, featureKey: 'hole:21:25:20:0:0.6:0.8:3' } }),
  axisX: (x: Verdict) => params(x, { axisX: 0.1 }),
  axisY: (x: Verdict) => params(x, { axisY: 0.7 }),
  axisZ: (x: Verdict) => params(x, { axisZ: 0.9 }),
  diameter: (x: Verdict) => params(x, { diameter: 7 }),
  depth: (x: Verdict) => params(x, { depth: 22 }),
}
/** a non-hole verdict at (10, 10, 20); with `faces`, its one face is there too */
const keyed = (featureClass: string, prefix: string, p: Record<string, number | string>, faces: boolean): Verdict => ({
  v: { featureKey: `${prefix}:10:10:20`, featureClass, removable: true, faceIds: ['f'], params: { centerX: 10, centerY: 10, centerZ: 20, ...p } },
  ...(faces ? { faces: { f: { surface: 'plane', areaMm2: 40, centroid: [10, 10, 20] as const, normal: [0, 0, 1] as const } } } : {}),
})
const centre = (x: Verdict): Verdict => ({
  v: { ...x.v, featureKey: x.v.featureKey.replace(':10:10:20', ':11:10:20'), params: { ...x.v.params, centerX: 11 } },
  ...(x.faces ? { faces: { f: { ...x.faces.f, centroid: [11, 10, 20] as const } } } : {}),
})
const nonHole = (featureClass: string, prefix: string, p: Record<string, number | string>, changed: Record<string, number | string>, faces: boolean, kind = featureClass) => row({
  source: 'model-kernel', kind, base: keyed(featureClass, prefix, p, faces), build: model,
  changes: {
    'centre (featureKey, centerX/Y/Z)': centre,
    ...Object.fromEntries(Object.entries(changed).map(([name, value]) => [name, (x: Verdict) => params(x, { [name]: value })])),
  },
})

// STL mesh (R4).
const meshRound: Build<MeshRoundLike> = f => fromMeshRecognition({ features: [f] })
type Band = MeshRoundLike['bands'][number]
const round = (kind: string, bands: Band[]): MeshRoundLike => {
  const diameters = bands.flatMap(b => (b.surface === 'cone' ? [b.diameterMm, b.endDiameterMm!] : [b.diameterMm]))
  return {
    id: `${kind}-1`, kind, axis: { origin: [20, 25, 0], direction: [0, 0, 1] }, bands, sourceFacetIds: [1],
    diameterMm: Math.min(...bands.filter(b => b.surface === 'cylinder').map(b => b.diameterMm)), diametersMm: diameters,
    depthMm: Math.max(...bands.map(b => b.axialRangeMm[1])) - Math.min(...bands.map(b => b.axialRangeMm[0])),
  }
}
/** the same feature with the axis pointing the other way */
const flipped = (f: MeshRoundLike): MeshRoundLike => ({
  ...f, axis: { origin: f.axis.origin, direction: [-f.axis.direction[0], -f.axis.direction[1], -f.axis.direction[2]] },
  bands: f.bands.slice().reverse().map(b => ({
    ...b, axialRangeMm: [-b.axialRangeMm[1], -b.axialRangeMm[0]] as const,
    ...(b.surface === 'cone' ? { diameterMm: b.endDiameterMm!, endDiameterMm: b.diameterMm } : {}),
  })),
})
const cyl = (d: number, lo: number, hi: number): Band => ({ surface: 'cylinder', diameterMm: d, axialRangeMm: [lo, hi] })
const cone = (d0: number, d1: number, lo: number, hi: number): Band => ({ surface: 'cone', diameterMm: d0, endDiameterMm: d1, axialRangeMm: [lo, hi] })
const setBand = (f: MeshRoundLike, i: number, b: Partial<Band>) => ({ ...f, bands: f.bands.map((x, k) => (k === i ? { ...x, ...b } : x)) })
const roundChanges = (lastIsCone: boolean) => ({
  'axis.origin': (f: MeshRoundLike) => ({ ...f, axis: { ...f.axis, origin: [21, 25, 0] as const } }),
  'axis.direction': (f: MeshRoundLike) => ({ ...f, axis: { ...f.axis, direction: unit3([0, 0.1, 1]) } }),
  // the shoulder (or the far end of a one-band feature) moves
  'bands[].axialRangeMm': (f: MeshRoundLike) => f.bands.length > 1
    ? { ...setBand(setBand(f, 0, { axialRangeMm: [f.bands[0].axialRangeMm[0], f.bands[0].axialRangeMm[1] - 3] }), 1, { axialRangeMm: [f.bands[1].axialRangeMm[0] - 3, f.bands[1].axialRangeMm[1]] }) }
    : setBand(f, 0, { axialRangeMm: [f.bands[0].axialRangeMm[0], f.bands[0].axialRangeMm[1] + 2] }),
  'bands[].diameterMm': (f: MeshRoundLike) => setBand(f, f.bands.length - 1, { diameterMm: f.bands[f.bands.length - 1].diameterMm + (lastIsCone ? 0.5 : 4) }),
  ...(lastIsCone ? { 'bands[].endDiameterMm': (f: MeshRoundLike) => setBand(f, f.bands.length - 1, { endDiameterMm: f.bands[f.bands.length - 1].endDiameterMm! + 2 }) } : {}),
})
const unit3 = (v: [number, number, number]): [number, number, number] => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] }
const meshRegion = (list: 'pockets' | 'slots' | 'draftedPockets'): Build<MeshRegionLike> => r => fromMeshRecognition({ features: [], [list]: [r] })
type Corners = NonNullable<MeshRegionLike['corners']>
const rect: Corners = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]]
// the same 40 x 20 rectangle turned a quarter turn about its centre (20, 10)
const turned: Corners = [[10, -10, 0], [30, -10, 0], [30, 30, 0], [10, 30, 0]]
const startAt1 = (r: MeshRegionLike): MeshRegionLike => ({ ...r, corners: [r.corners![1], r.corners![2], r.corners![3], r.corners![0]],
  ...(r.wallDraftDeg ? { wallDraftDeg: [r.wallDraftDeg[1], r.wallDraftDeg[2], r.wallDraftDeg[3], r.wallDraftDeg[0]] } : {}) })
const region = (kind: string, extra: Partial<MeshRegionLike>): MeshRegionLike => ({
  id: `${kind}-1`, kind, floorNormal: [0, 0, 1], lengthMm: 40, widthMm: 20, depthMm: 5, sourceFacetIds: [1], ...extra,
})
const regionChanges = {
  floorNormal: (r: MeshRegionLike) => ({ ...r, floorNormal: unit3([0, 0.1, 1]) }),
  lengthMm: (r: MeshRegionLike) => ({ ...r, lengthMm: 41 }),
  widthMm: (r: MeshRegionLike) => ({ ...r, widthMm: 21 }),
  depthMm: (r: MeshRegionLike) => ({ ...r, depthMm: 6 }),
}
type Blend = Parameters<typeof fromMeshRecognition>[1] extends readonly (infer B)[] | undefined ? B : never
const blend: Build<Blend> = b => fromMeshRecognition({ features: [] }, [b])
const blendBase = (kind: string, size: Partial<Blend>): Blend => ({
  id: `${kind}-1`, kind, shape: 'convex', includedAngleDeg: 90, lengthMm: 40, edgeLine: { ends: [[0, 0, 10], [40, 0, 10]] }, sourceFacetIds: [1], ...size,
})
const blendChanges = {
  'edgeLine.ends': (b: Blend) => ({ ...b, edgeLine: { ends: [[0, 0, 10], [42, 0, 10]] as const } }),
  shape: (b: Blend) => ({ ...b, shape: 'concave' }),
  includedAngleDeg: (b: Blend) => ({ ...b, includedAngleDeg: 100 }),
}

// 2D loops.
type Loop = Parameters<typeof fromLoops>[0][number]
const loop2d: Build<Loop> = l => fromLoops([l])
const square: Loop = { id: 'geo~sq', layerId: 'cut', type: 'contour', closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }

const ROWS: Row<unknown>[] = [
  row({ source: 'step-cylinder-scan', kind: 'bore', base: [bore], build: step, changes: {
    'center[0]': c => withCyl(c, 0, { center: [21, 25] }), 'center[1]': c => withCyl(c, 0, { center: [20, 26] }),
    diameter: c => withCyl(c, 0, { diameter: 7 }), topZ: c => withCyl(c, 0, { topZ: 22 }), bottomZ: c => withCyl(c, 0, { bottomZ: 2 }),
    through: c => withCyl(c, 0, { through: false }),
  } }),
  row({ source: 'step-cylinder-scan', kind: 'boss', base: [{ center: [10, 10], diameter: 12, topZ: 30, bottomZ: 20, through: false, kind: 'boss' as const }], build: step, changes: {
    'center[0]': c => withCyl(c, 0, { center: [11, 10] }), 'center[1]': c => withCyl(c, 0, { center: [10, 11] }),
    diameter: c => withCyl(c, 0, { diameter: 13 }), topZ: c => withCyl(c, 0, { topZ: 32 }), bottomZ: c => withCyl(c, 0, { bottomZ: 21 }),
  } }),
  row({ source: 'step-cylinder-scan', kind: 'bore stack', base: stack, build: step, restated: c => c.slice().reverse(), changes: {
    'center[0]': c => bothCyl(c, () => ({ center: [21, 25] })), 'center[1]': c => bothCyl(c, () => ({ center: [20, 26] })),
    'diameter (top bore)': c => withCyl(c, 0, { diameter: 16 }), 'diameter (bottom bore)': c => withCyl(c, 1, { diameter: 7 }),
    'topZ (top bore)': c => withCyl(c, 0, { topZ: 22 }),
    // audit F2: the shoulder moves from 5 to 8 mm deep, bore, major and overall depth kept
    'shoulder (top bottomZ = bottom topZ)': c => withCyl(withCyl(c, 0, { bottomZ: 12 }), 1, { topZ: 12 }),
    'bottomZ (bottom bore)': c => withCyl(c, 1, { bottomZ: 2 }),
  } }),
  row({ source: 'model-kernel', kind: 'throughHole', base: hole('throughHole', { openings: 2 }), build: model, changes: holeChanges }),
  row({ source: 'model-kernel', kind: 'blindHole', base: hole('blindHole', {}), build: model, changes: holeChanges }),
  row({ source: 'model-kernel', kind: 'counterboreStack', base: hole('counterboreStack', { radiusCount: 2, counterboreDiameter: 12, counterboreDepth: 5 }), build: model, changes: {
    ...holeChanges,
    counterboreDiameter: x => params(x, { counterboreDiameter: 16 }),
    // audit F2
    counterboreDepth: x => params(x, { counterboreDepth: 8 }),
  } }),
  ...[false, true].flatMap(faces => [
    nonHole('pocket', 'loop', { spanX: 8, spanY: 6, depth: 5, faceCount: 5 }, { spanX: 9, spanY: 7, depth: 6 }, faces),
    nonHole('boss', 'loop', { spanX: 8, spanY: 6, depth: 5, faceCount: 5 }, { spanX: 9, spanY: 7, depth: 6 }, faces),
    nonHole('engravedText', 'loop', { spanX: 8, spanY: 6, depth: 1, faceCount: 9 }, { spanX: 9, spanY: 7, depth: 1.5 }, faces),
    nonHole('sliver', 'sliver', { area: 0.5 }, { area: 0.6 }, faces),
    nonHole('filletPlanar', 'band:filletPlanar', { radius: 2, neighbours: 2 }, { radius: 3 }, faces),
    nonHole('chamferPlanar', 'band:chamferPlanar', { width: 1.5, neighbours: 2 }, { width: 2 }, faces),
    nonHole('filletCurvedCorner', 'curved', { area: 12, radius: 2, cylinderRadius: 6, removedFaces: 5, wallFaces: 4 }, { area: 13, radius: 3, cylinderRadius: 7 }, faces),
    nonHole('filletPlanar', 'absorbed:bspline:loop:42:20:20', { area: 12, surfaceKind: 'bspline', absorbedBy: 'loop:42:20:20' }, { area: 13, surfaceKind: 'torus' }, faces, 'filletPlanar / filletCurvedCorner absorbed'),
    nonHole('filletChain', 'chain:fillet:2', { radius: 2, area: 30, chain: 'fillet', faceCount: 3 }, { radius: 3, area: 31 }, faces),
    nonHole('chamferChain', 'chain:chamfer:1', { distance: 1, distanceA: 1, distanceB: 1.5, area: 30, chain: 'chamfer', faceCount: 3 }, { distance: 1.2, distanceA: 1.2, distanceB: 2, area: 31 }, faces),
  ]),
  row({ source: 'stl-mesh', kind: 'through-hole', base: round('through-hole', [cyl(6, 0, 20)]), build: meshRound, restated: flipped, changes: roundChanges(false) }),
  row({ source: 'stl-mesh', kind: 'blind-hole', base: round('blind-hole', [cyl(6, 10, 20)]), build: meshRound, restated: flipped, changes: roundChanges(false) }),
  row({ source: 'stl-mesh', kind: 'counterbore', base: round('counterbore', [cyl(6, 0, 15), cyl(12, 15, 20)]), build: meshRound, restated: flipped, changes: roundChanges(false) }),
  row({ source: 'stl-mesh', kind: 'countersink', base: round('countersink', [cyl(6, 0, 17), cone(6, 12, 17, 20)]), build: meshRound, restated: flipped, changes: roundChanges(true) }),
  row({ source: 'stl-mesh', kind: 'chamfered-hole', base: round('chamfered-hole', [cyl(6, 0, 19), cone(6, 8, 19, 20)]), build: meshRound, restated: flipped, changes: roundChanges(true) }),
  row({ source: 'stl-mesh', kind: 'boss', base: round('boss', [cyl(12, 0, 10)]), build: meshRound, restated: flipped, changes: roundChanges(false) }),
  row({ source: 'stl-mesh', kind: 'boss (dome)', base: { ...round('boss', [cyl(20, 0, 5)]), bands: [], profile: 'spherical-cap', diameterMm: 20, diametersMm: [20], depthMm: 5 } as MeshRoundLike, build: meshRound, changes: {
    'axis.origin': f => ({ ...f, axis: { ...f.axis, origin: [21, 25, 0] as const } }),
    'axis.direction': f => ({ ...f, axis: { ...f.axis, direction: unit3([0, 0.1, 1]) } }),
    diameterMm: f => ({ ...f, diameterMm: 22, diametersMm: [22] }),
    depthMm: f => ({ ...f, depthMm: 6 }),
    profile: ({ profile: _, ...f }) => f,
  } }),
  row({ source: 'stl-mesh', kind: 'rectangular-pocket', base: region('rectangular-pocket', { corners: rect }), build: meshRegion('pockets'), restated: startAt1, changes: {
    ...regionChanges, corners: r => ({ ...r, corners: turned }),
  } }),
  row({ source: 'stl-mesh', kind: 'slot', base: region('slot', { centerline: [[10, 10, 0], [30, 10, 0]], endStyle: 'round' }), build: meshRegion('slots'),
    restated: r => ({ ...r, centerline: [r.centerline![1], r.centerline![0]] as const }), changes: {
      ...regionChanges, centerline: r => ({ ...r, centerline: [[20, 0, 0], [20, 20, 0]] as const }), endStyle: r => ({ ...r, endStyle: 'flat' }),
    } }),
  row({ source: 'stl-mesh', kind: 'drafted-pocket', base: region('drafted-pocket', { corners: rect, wallDraftDeg: [8, 5, 5, 5] }), build: meshRegion('draftedPockets'), restated: startAt1, changes: {
    ...regionChanges, corners: r => ({ ...r, corners: turned }),
    // the 8 degree wall moves to the next side
    wallDraftDeg: r => ({ ...r, wallDraftDeg: [5, 8, 5, 5] }),
  } }),
  row({ source: 'stl-mesh', kind: 'fillet', base: blendBase('fillet', { radiusMm: 2 }), build: blend,
    restated: b => ({ ...b, edgeLine: { ends: [b.edgeLine.ends[1], b.edgeLine.ends[0]] as const } }), changes: {
      ...blendChanges, radiusMm: b => ({ ...b, radiusMm: 3 }),
    } }),
  row({ source: 'stl-mesh', kind: 'chamfer', base: blendBase('chamfer', { setbackMm: [1, 2] }), build: blend,
    restated: b => ({ ...b, edgeLine: { ends: [b.edgeLine.ends[1], b.edgeLine.ends[0]] as const } }), changes: {
      ...blendChanges, setbackMm: b => ({ ...b, setbackMm: [1, 2.5] as const }),
    } }),
  row({ source: 'sketch-2d', kind: 'closed loop', base: square, build: loop2d,
    restated: l => ({ ...l, points: [l.points[2], l.points[1], l.points[0], l.points[3]] }), changes: {
      // one corner moves along an edge: same bounding box
      points: l => ({ ...l, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 2, y: 10 }] }),
    } }),
]

describe('WO-3002 fix round 2: every defining field of every kind is in the id', () => {
  it('the rows cover exactly the field table, for every source type', () => {
    const tested = new Map<string, string[]>()
    for (const r of ROWS) tested.set(`${r.source} ${r.kind}`, Object.keys(r.changes))
    const table = Object.entries(DEFINING_FIELDS).flatMap(([source, kinds]) => Object.entries(kinds).map(([kind, fields]) => [`${source} ${kind}`, [...fields]] as const))
    expect([...tested.keys()].sort()).toEqual(table.map(([key]) => key).sort())
    for (const [key, fields] of table) expect(tested.get(key)?.slice().sort(), key).toEqual(fields.slice().sort())
  })

  const cases = ROWS.flatMap(r => Object.keys(r.changes).map(field => ({ r, field, name: `${r.source} ${r.kind}${r.source === 'model-kernel' && r.kind !== 'throughHole' && r.kind !== 'blindHole' && r.kind !== 'counterboreStack' ? ((r.base as Verdict).faces ? ' (faces)' : ' (key)') : ''}: ${field}` })))
  it.each(cases.map(c => [c.name, c] as const))('%s changed alone gives a new id', (_, { r, field }) => {
    const before = oneId(r.source, r.build(r.base))
    const after = oneId(r.source, r.build(r.changes[field](r.base)))
    expect(after.id, `${field}: ${geometrySignature(after.geometry).signature}`).not.toBe(before.id)
  })

  it.each(ROWS.map(r => [`${r.source} ${r.kind}`, r] as const))('%s unchanged (and restated) keeps its id', (_, r) => {
    const id = oneId(r.source, r.build(r.base)).id
    expect(oneId(r.source, r.build(r.base)).id).toBe(id)
    if (r.restated) expect(oneId(r.source, r.build(r.restated(r.base))).id).toBe(id)
  })

  it('a counterbore is one id from STEP, model kernel and mesh, and its step is placed at its end', () => {
    const fromStep = oneId('step-cylinder-scan', step(stack)).id
    const blind = hole('counterboreStack', { radiusCount: 2, counterboreDiameter: 12, counterboreDepth: 5 })
    const upright = (x: Verdict): Verdict => params({ ...x, v: { ...x.v, featureKey: 'hole:20:25:20:0:0:1:3' } }, { axisX: 0, axisY: 0, axisZ: 1 })
    // its wide wall (z 15..20) places the step at the rim
    const wall = (z: number) => ({ w: { surface: 'cylinder', areaMm2: 280, centroid: [20, 25, 7.5] as const }, wide: { surface: 'cylinder', areaMm2: 190, centroid: [20, 25, z] as const } })
    const blindWithFaces = (x: Verdict): Verdict => ({ v: { ...x.v, faceIds: ['w', 'wide'], counterboreFaceIds: ['wide'] }, faces: wall(17.5) })
    expect(oneId('model-kernel', model(blindWithFaces(upright(blind)))).id).toBe(fromStep)
    const mesh = round('counterbore', [cyl(6, 0, 15), cyl(12, 15, 20)])
    expect(oneId('stl-mesh', meshRound(mesh)).id).toBe(fromStep)
    // A hole open at both ends, seeded from its BOTTOM opening: the wide faces
    // place the step at the top, where STEP and mesh put it.
    const fromBottom: Verdict = {
      v: { featureKey: 'hole:20:25:0:0:0:-1:3', featureClass: 'counterboreStack', removable: true, faceIds: ['bore', 'wide'], counterboreFaceIds: ['wide'],
        params: { axisX: 0, axisY: 0, axisZ: -1, diameter: 6, depth: 20, openings: 2, radiusCount: 2, counterboreDiameter: 12, counterboreDepth: 5 } },
      faces: { bore: { surface: 'cylinder', areaMm2: 280, centroid: [20, 25, 7.5] }, wide: { surface: 'cylinder', areaMm2: 190, centroid: [20, 25, 17.5] } },
    }
    const placed = oneId('model-kernel', model(fromBottom))
    expect(placed.note).toBeUndefined()
    expect(placed.id).toBe(fromStep)
    // the same hole with its step at the bottom is another feature
    const atBottom = { ...fromBottom, faces: { ...fromBottom.faces!, wide: { ...fromBottom.faces!.wide, centroid: [20, 25, 2.5] as const } } }
    expect(oneId('model-kernel', model(atBottom)).id).not.toBe(fromStep)
    // Without the wide faces' geometry the end is unknown: said in one line,
    // and the step's depth still enters the id.
    const unplaced = oneId('model-kernel', model({ v: fromBottom.v }))
    expect(unplaced.note).toMatch(/carried unplaced/)
    expect(oneId('model-kernel', model(params({ v: fromBottom.v }, { counterboreDepth: 8 }))).id).not.toBe(unplaced.id)
  })

  // R2's `openings` counts the planar loops its hole seeds met (defeature.ts:784):
  // rim, shoulder and exit on a through counterbore, so 3, not a through flag.
  it('an R2 counterbore step is placed only from its wide faces, never from the opening count', () => {
    const blind = hole('counterboreStack', { radiusCount: 2, counterboreDiameter: 12, counterboreDepth: 5, openings: 1 })
    const noFaces = oneId('model-kernel', model(blind))
    expect(noFaces.note ?? '(no note: placed)').toMatch(/carried unplaced/)
    expect(noFaces.geometry.kind === 'axial' && noFaces.geometry.bands).toEqual([])
  })

  it('an R2 counterbore seeded from its shoulder loop is not placed as if that were the rim', () => {
    // The key's rim is the shoulder (z 15); R2's depth is the whole bore span (20 mm).
    const fromShoulder: Verdict = {
      v: { featureKey: 'hole:20:25:15:0:0:1:3', featureClass: 'counterboreStack', removable: true, faceIds: ['bore', 'wide'], counterboreFaceIds: ['wide'],
        params: { axisX: 0, axisY: 0, axisZ: 1, diameter: 6, depth: 20, openings: 3, radiusCount: 2, counterboreDiameter: 12, counterboreDepth: 5 } },
      faces: { bore: { surface: 'cylinder', areaMm2: 280, centroid: [20, 25, 7.5] }, wide: { surface: 'cylinder', areaMm2: 190, centroid: [20, 25, 17.5] } },
    }
    const f = oneId('model-kernel', model(fromShoulder))
    expect(f.note ?? '(no note: placed)').toMatch(/carried unplaced/)
    expect(f.geometry.kind === 'axial' && f.geometry.bands).toEqual([])
  })

  it('a model verdict without its defining params is unclassified, with one line', () => {
    const unmeasured = oneId('model-kernel', model({ v: { featureKey: 'band:filletPlanar:1:2:3', featureClass: 'filletPlanar', removable: false, refuseReason: 'degenerate fillet radius', faceIds: ['f'], params: { centerX: 1, centerY: 2, centerZ: 3, neighbours: 2 } } }))
    expect(unmeasured.type).toBe('unclassified')
    expect(unmeasured.note).toMatch(/gave no radius for this filletPlanar: degenerate fillet radius/)
  })
})
