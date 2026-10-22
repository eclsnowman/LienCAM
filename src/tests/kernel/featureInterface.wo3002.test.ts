// WO-3002 (alpha.3 A3-09 step 5): one feature interface over the as-built
// recognisers, with a CLOSED type set. Acceptance 3: every recogniser output
// maps to an enum member or `unclassified`, and a new free-text type fails a
// test (the type pins below fail `tsc -b` until it is mapped). Also the
// validate rules: 2D depth comes from parameters, recognition never blocks.
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalGeomService } from '../../geom'
import type { GeomClient } from '../../geom'
import type { FeatureClass } from '../../geom/geom-service'
import type { FeatureType as ModelCoreType } from '../../geom/worker/defeature'
import {
  FEATURE_TYPES, LOOP_TYPES, MESH_BLEND_KINDS, MESH_REGION_KINDS, MESH_ROUND_KINDS, MODEL_FEATURE_CLASSES, STEP_CYLINDER_KINDS,
  facesFromSnapshots, fromLoops, geometrySignature, fromMeshRecognition, fromModelVerdicts, fromStepCylinders, isFeatureType,
  partFeatureList, recognisedFeatureList, type AdapterResult, type FeatureType, type PartFeatureList,
} from '../../kernel/features'
import { readStepShape } from '../../lib/cam/geometry/occt/model/core'
import { cylinderFeatures, holeFeatures } from '../../lib/cam/geometry/occt/model/derive'
import { loadOcctModel, type OcctModelModule } from '../../lib/cam/geometry/occt/model/loader'
import { recognizeEdgeBlends } from '../../mesh/recognition'
import { recognizeMeshFeatures } from '../../mesh/recognition/recognize'
import type { DraftedPocketKind, FeatureKind, PocketKind, SlotKind } from '../../mesh/recognition/types'
import type { RecognizedEdgeBlend } from '../../mesh/recognition/edgeBlends'
import type { CylinderFeature, HoleFeature, Loop2D } from '../../types'

const here = dirname(fileURLToPath(import.meta.url))
/* eslint-disable @typescript-eslint/no-explicit-any */
;(globalThis as any).require ??= createRequire(import.meta.url)
;(globalThis as any).__dirname ??= here
;(globalThis as any).__filename ??= fileURLToPath(import.meta.url)
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---- type pins: each list is EXACTLY the recogniser's own union ------------
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const pins: [
  Equal<FeatureClass, typeof MODEL_FEATURE_CLASSES[number]>,
  Equal<ModelCoreType, typeof MODEL_FEATURE_CLASSES[number]>,
  Equal<FeatureKind, typeof MESH_ROUND_KINDS[number]>,
  Equal<PocketKind | SlotKind | DraftedPocketKind, typeof MESH_REGION_KINDS[number]>,
  Equal<RecognizedEdgeBlend['kind'], typeof MESH_BLEND_KINDS[number]>,
  Equal<CylinderFeature['kind'], typeof STEP_CYLINDER_KINDS[number]>,
  Equal<Loop2D['type'], typeof LOOP_TYPES[number]>,
] = [true, true, true, true, true, true, true]
// and each adapter takes the recogniser's real output type as it stands
const shapes: Array<(x: never) => AdapterResult> = [
  (x: HoleFeature[]) => fromStepCylinders(x),
  (x: CylinderFeature[]) => fromStepCylinders(x),
  (x: Awaited<ReturnType<GeomClient['recognizeFeatures']>>) => fromModelVerdicts(x),
  (x: ReturnType<typeof recognizeMeshFeatures>) => fromMeshRecognition(x),
  (x: RecognizedEdgeBlend[]) => fromMeshRecognition({ features: [] }, x),
  (x: Loop2D[]) => fromLoops(x),
]

const frame = { kind: 'geometry-native', entityId: 'part' } as const

describe('WO-3002 the closed feature set', () => {
  it('is exactly these members, and the type pins hold', () => {
    expect(pins.every(Boolean)).toBe(true)
    expect(shapes).toHaveLength(6)
    expect([...FEATURE_TYPES]).toEqual([
      'throughHole', 'blindHole', 'counterbore', 'countersink', 'chamferedHole', 'boss',
      'pocket', 'slot', 'draftedPocket', 'engravedText', 'fillet', 'chamfer', 'sliver', 'unclassified',
    ])
  })

  // The mapping, stated once here so a reviewer reads it in one place.
  const MODEL: Record<typeof MODEL_FEATURE_CLASSES[number], FeatureType> = {
    throughHole: 'throughHole', blindHole: 'blindHole', counterboreStack: 'counterbore', pocket: 'pocket',
    engravedText: 'engravedText', boss: 'boss', filletPlanar: 'fillet', chamferPlanar: 'chamfer',
    filletCurvedCorner: 'fillet', sliver: 'sliver', filletChain: 'fillet', chamferChain: 'chamfer',
  }
  const MESH: Record<typeof MESH_ROUND_KINDS[number], FeatureType> = {
    'through-hole': 'throughHole', 'blind-hole': 'blindHole', boss: 'boss', counterbore: 'counterbore',
    countersink: 'countersink', 'chamfered-hole': 'chamferedHole',
  }
  const REGION: Record<typeof MESH_REGION_KINDS[number], FeatureType> = { 'rectangular-pocket': 'pocket', slot: 'slot', 'drafted-pocket': 'draftedPocket' }

  const verdict = (featureClass: string, extra: Record<string, number> = {}, removable = true) => ({
    featureKey: `loop:${featureClass}:1:2:3`, featureClass, removable, faceIds: ['f1'],
    // every class's defining params (adapters.ts MODEL_REQUIRED), so each maps as itself
    params: { axisX: 0, axisY: 0, axisZ: 1, diameter: 6, depth: 4, radiusCount: 2, counterboreDiameter: 10, counterboreDepth: 1, spanX: 5, spanY: 5, area: 3, radius: 1, width: 1, cylinderRadius: 2, distance: 1, ...extra },
  })
  const face = { f1: { surface: 'plane', areaMm2: 10, centroid: [1, 2, 3] as const } }
  const round = (kind: string) => ({ id: `${kind}-1`, kind, axis: { origin: [1, 2, 0] as const, direction: [0, 0, 1] as const }, diameterMm: 6, diametersMm: [6], depthMm: 5, bands: [{ surface: 'cylinder' as const, diameterMm: 6, axialRangeMm: [0, 5] as const }], sourceFacetIds: [1] })
  const region = (kind: string) => ({ id: `${kind}-1`, kind, floorNormal: [0, 0, 1] as const, corners: [[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 2, 0]] as const, lengthMm: 4, widthMm: 2, depthMm: 1, sourceFacetIds: [1] })

  it('maps every model-kernel class, mesh kind, cylinder kind and loop type into the set', () => {
    for (const c of MODEL_FEATURE_CLASSES) {
      const [m] = fromModelVerdicts([verdict(c)], face).candidates
      expect(m.type, c).toBe(MODEL[c])
      expect(m.sourceType).toBe(c)
    }
    for (const k of MESH_ROUND_KINDS) expect(fromMeshRecognition({ features: [round(k)] }).candidates[0].type, k).toBe(MESH[k])
    for (const k of MESH_REGION_KINDS) expect(fromMeshRecognition({ features: [], pockets: [region(k)] }).candidates[0].type, k).toBe(REGION[k])
    for (const k of MESH_BLEND_KINDS) {
      const blend = { id: `${k}-1`, kind: k, shape: 'convex', includedAngleDeg: 90, radiusMm: 1, lengthMm: 3, edgeLine: { ends: [[0, 0, 0], [3, 0, 0]] as const }, sourceFacetIds: [1] }
      expect(fromMeshRecognition({ features: [] }, [blend]).candidates[0].type).toBe(k)
    }
    for (const kind of STEP_CYLINDER_KINDS) {
      expect(fromStepCylinders([{ center: [0, 0], diameter: 4, topZ: 5, bottomZ: 0, through: true, kind }]).candidates[0].type).toBe(kind === 'boss' ? 'boss' : 'throughHole')
    }
    for (const type of LOOP_TYPES) {
      const loops = fromLoops([{ id: 'L1', layerId: 'a', type, closed: type !== 'open', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }] }])
      expect(loops.candidates.every(c => c.type === 'unclassified')).toBe(true)
    }
  })

  it('anything else is `unclassified` with one line, never a free-text type', () => {
    const results: AdapterResult[] = [
      fromModelVerdicts([verdict('newThing')], face),
      fromMeshRecognition({ features: [round('new-thing')] }),
      fromMeshRecognition({ features: [], slots: [region('new-slot')] }),
      fromModelVerdicts([verdict('counterboreStack', { radiusCount: 1 })], face),
      fromModelVerdicts([{ ...verdict('filletCurvedCorner', {}, false), refuseReason: 'torus outside the blend class' }], face),
    ]
    for (const r of results) {
      const [c] = r.candidates
      expect(c.type).toBe('unclassified')
      expect(c.note).toMatch(/\S/)
      expect(c.note!.split('\n')).toHaveLength(1)
    }
    expect(results[0].candidates[0].note).toBe('model kernel type "newThing" is not in the closed feature set')
    expect(results[3].candidates[0].note).toMatch(/countersink or a chamfered hole/)
    expect(results[4].candidates[0].note).toMatch(/torus outside the blend class/)
  })
})

describe('WO-3002 the validate rules', () => {
  it('a 2D loop has depth from parameters, keeps its loop id verbatim, and an open path is one line', () => {
    const square = (id: string, x: number) => ({ id, layerId: 'cut', type: 'contour', closed: true, points: [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }] })
    const r = fromLoops([square('geo~abc', 0), square('geo~def', 20), { id: 'geo~open', layerId: 'cut', type: 'open', closed: false, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }])
    expect(r.candidates.map(c => c.references)).toEqual([['geo~abc'], ['geo~def']])
    expect(r.candidates.every(c => c.depth.evidence === 'from-parameters')).toBe(true)
    expect(r.notes).toEqual(['1 open 2D path(s) bound no region and are not features'])
    const list = partFeatureList(frame, 'sketch-2d', r.candidates, r.notes)
    expect(list.features).toHaveLength(2)
    expect(new Set(list.features.map(f => f.id)).size).toBe(2)
  })

  it('a recogniser that fails on a body gives no features and one line; a bad output is left out with one line', () => {
    const failed = recognisedFeatureList(frame, 'stl-mesh', () => { throw new Error('mesh is not closed') })
    expect(failed.features).toEqual([])
    expect(failed.notes).toEqual(['stl-mesh recognition failed on this body, so it lists no features (mesh is not closed)'])
    const mixed = recognisedFeatureList(frame, 'step-cylinder-scan', () => fromStepCylinders([
      { center: [0, 0], diameter: 4, topZ: 5, bottomZ: 0, through: true },
      { center: [9, 0], diameter: Number.NaN, topZ: 5, bottomZ: 0, through: true },
    ]))
    expect(mixed.features.map(f => f.type)).toEqual(['throughHole'])
    expect(mixed.notes).toHaveLength(1)
    expect(mixed.notes[0]).toMatch(/STEP cylinder at \(9, 0\): left out/)
  })
})

describe('WO-3002 real recogniser outputs on one modelled part', () => {
  // 80 x 50 x 20 block: a counterbore, a countersink and a blind hole, all
  // on the top face. The model kernel, its STEP export through the CAM STEP
  // scan, and its tessellation through the STL recogniser all see it.
  let g: GeomClient
  let oc: OcctModelModule
  const lists: Record<string, PartFeatureList> = {}
  beforeAll(async () => {
    g = createLocalGeomService()
    await g.init()
    oc = await loadOcctModel({ wasmBinary: readFileSync(join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')) })
    const box = await g.makeBox('F1', { x: 80, y: 50, z: 20 })
    let body = box.body!
    const holes = [
      { x: 20, style: { kind: 'counterbore', diameter: 6, cbDiameter: 12, cbDepth: 5 }, depth: { kind: 'throughAll' } },
      { x: 40, style: { kind: 'simple', diameter: 5 }, depth: { kind: 'blind', distance: 8 } },
      { x: 60, style: { kind: 'countersink', diameter: 6, csDiameter: 12, csAngleDeg: 90 }, depth: { kind: 'throughAll' } },
    ] as const
    for (const [i, h] of holes.entries()) {
      const r = await g.makeHole({ featureId: `H${i}`, body, face: 'F1:BOX:zMax', points: [{ x: h.x, y: 25, z: 20 }], style: h.style, depth: h.depth })
      expect(r.ok, `hole ${i}`).toBe(true)
      body = r.body!
    }
    const verdicts = await g.recognizeFeatures(body)
    const step = new Uint8Array(await g.exportStep([body]))
    const reimported = await g.importStep(step.buffer.slice(0) as ArrayBuffer, 'IMP1')
    lists.model = recognisedFeatureList(frame, 'model-kernel', () => fromModelVerdicts(verdicts))
    const importedVerdicts = await g.recognizeFeatures(reimported.bodies[0].handle)
    lists.modelImported = recognisedFeatureList(frame, 'model-kernel', () => fromModelVerdicts(importedVerdicts, facesFromSnapshots(reimported.bodies[0].elementMap.geometry ?? {})))
    const { shape } = readStepShape(oc, step, 'wo3002.step')
    lists.stepScan = recognisedFeatureList(frame, 'step-cylinder-scan', () => fromStepCylinders(cylinderFeatures(oc, shape)))
    lists.stepHoles = recognisedFeatureList(frame, 'step-cylinder-scan', () => fromStepCylinders(holeFeatures(oc, shape)))
    const t = await g.tessellate(body, { deflection: 0.01 })
    const mesh = { positions: t.position, indices: t.index }
    lists.mesh = recognisedFeatureList(frame, 'stl-mesh', () => fromMeshRecognition(recognizeMeshFeatures(mesh), recognizeEdgeBlends(mesh).blends))
  }, 240_000)

  const typesOf = (name: string) => lists[name].features.map(f => f.type).sort()

  it('every output of every recogniser maps into the closed set', () => {
    for (const [name, list] of Object.entries(lists)) {
      for (const f of list.features) {
        expect(isFeatureType(f.type), `${name} ${f.sourceType}`).toBe(true)
        if (f.type === 'unclassified') expect(f.note, `${name} ${f.sourceType}`).toMatch(/\S/)
      }
      console.log(`[WO-3002] ${name}: ${list.features.map(f => `${f.type}<-${f.sourceType}`).join(', ')}${list.notes.length ? ` | notes: ${list.notes.join(' / ')}` : ''}`)
    }
  })

  it('each source names the holes it can see (GAP-013 G-102)', () => {
    // The model kernel cannot tell a countersink from a chamfered hole.
    expect(typesOf('model')).toEqual(['blindHole', 'counterbore', 'unclassified'])
    expect(typesOf('modelImported')).toEqual(typesOf('model'))
    // The STL recogniser can.
    expect(typesOf('mesh').filter(t => t !== 'fillet' && t !== 'chamfer')).toEqual(['blindHole', 'counterbore', 'countersink'])
    // The CAM STEP scan never reads cones: the countersink is only its bore.
    expect(typesOf('stepHoles')).toEqual(['blindHole', 'counterbore', 'throughHole'])
    expect(typesOf('stepScan')).toEqual(['blindHole', 'counterbore', 'throughHole'])
    const counterbore = (name: string) => lists[name].features.find(f => f.type === 'counterbore')!
    for (const name of ['model', 'mesh', 'stepScan']) {
      const g0 = counterbore(name).geometry
      expect(g0.kind).toBe('axial')
      if (g0.kind === 'axial') expect(g0.diameterMm, name).toBeCloseTo(6, 2)
    }
  })

  it('fix round 2: the through counterbore has one id from every source that can place its step', () => {
    // Its 5 mm step is in the band profile of each, so the ids agree only if
    // every source carried the shoulder where it is.
    const counterbore = (name: string) => lists[name].features.find(f => f.type === 'counterbore')!
    for (const name of ['model', 'modelImported', 'mesh', 'stepScan', 'stepHoles']) console.log(`[WO-3002] counterbore ${name}: ${counterbore(name).id} ${geometrySignature(counterbore(name).geometry).signature} ${JSON.stringify(counterbore(name).dimensions)} ${counterbore(name).note ?? ''}`)
    expect(counterbore('modelImported').id).toBe(counterbore('stepScan').id)
    expect(counterbore('mesh').id).toBe(counterbore('stepScan').id)
    expect(counterbore('stepHoles').id).toBe(counterbore('stepScan').id)
  })

  it('a STEP file the scan cannot read gives no features and one line', () => {
    const again = recognisedFeatureList(frame, 'step-cylinder-scan', () => fromStepCylinders(cylinderFeatures(oc, readStepShape(oc, new Uint8Array(0), 'x').shape)))
    expect(again.features).toEqual([])
    expect(again.notes).toHaveLength(1)
  })
})
