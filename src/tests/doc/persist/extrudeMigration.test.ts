// WO UI-51A: doc-schema v2->v3 migration for the extrude parameter model.
// Two gates:
//  (1) a v3 round-trip preserves an extrude's direction / boolMode /
//      targetFeatureId with full fidelity (they ride dag.serialize() like every
//      other payload field);
//  (2) a GENUINE pre-UI-51A v2 archive -- an extrude payload with NEITHER
//      direction NOR boolMode -- loads defaulted to up / newBody, with the
//      v2->v3 migration recorded in migrationsApplied (proving the field was
//      really absent, not present-and-defaulted by the writer).
//
// FAILS-IF: change migrationV2ToV3's default from 'up' to anything else
// (versioning.ts) and test (2) breaks; drop the field-copy in the dag
// serialize round-trip and test (1) breaks.

import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import { FeatureDag } from '../../../doc'
import { CURRENT_SCHEMA_VERSION, createDocumentArchive, loadDocumentArchive, stableStringify } from '../../../doc/persist'
import { GeomEngine } from '../../../geom/worker/geom-engine'
import type { ExtrudeRequest, ProfileRegion } from '../../../geom/geom-service'
import { computeProfileRegions } from '../../../sketch3d'
import type { Sketch3dDocument, Sketch3dLineEntity } from '../../../sketch3d'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../../components/model3d/workbench/extrudeParams'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

function rewriteArchive(
  archive: Uint8Array,
  mutate: (manifest: Record<string, unknown>, document: Record<string, unknown>) => void,
): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  const document = JSON.parse(strFromU8(files['document.json'])) as Record<string, unknown>
  mutate(manifest, document)
  files['manifest.json'] = strToU8(stableStringify(manifest))
  files['document.json'] = strToU8(stableStringify(document))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

function extrudeDoc(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
  dag.insertNode({
    id: 'B1',
    kind: 'feature',
    consumes: ['SK1'],
    payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'Extrude B1' },
  })
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['SK1', 'B1'],
    payload: {
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 5,
      direction: 'down',
      boolMode: 'remove',
      targetFeatureId: 'B1',
      name: 'Extrude F2',
    },
  })
  return dag
}

describe('WO UI-51A extrude schema migration (versioning.ts v2->v3)', () => {
  it('round-trips direction / boolMode / targetFeatureId at the current schema', () => {
    const archive = createDocumentArchive({ dag: extrudeDoc(), elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    const b1 = loaded.dag.getNode('B1')!.payload
    expect(b1.direction).toBe('up')
    expect(b1.boolMode).toBe('newBody')
    expect(b1.targetFeatureId).toBeUndefined()

    const f2 = loaded.dag.getNode('F2')!.payload
    expect(f2.direction).toBe('down')
    expect(f2.boolMode).toBe('remove')
    expect(f2.targetFeatureId).toBe('B1')
    // The consumed-target edge survives too (lineage carrier).
    expect(loaded.dag.getNode('F2')!.consumes).toContain('B1')
  })

  it('a genuine pre-UI-51A v2 archive (extrude WITHOUT direction/boolMode) loads defaulted to up/newBody', () => {
    const archive = createDocumentArchive({ dag: extrudeDoc(), elementMapDeltas: [] })
    // Simulate a real v2 file: drop the new fields from every extrude payload
    // and stamp the manifest back to schemaVersion 2.
    const v2 = rewriteArchive(archive, (manifest, document) => {
      manifest.schemaVersion = 2
      const dagJson = document.dag as { nodes: Array<Record<string, unknown>> }
      for (const n of dagJson.nodes) {
        const p = n.payload as Record<string, unknown> | undefined
        if (p && p.opType === 'extrude') {
          delete p.direction
          delete p.boolMode
          delete p.targetFeatureId
        }
      }
    })

    const loaded = loadDocumentArchive(v2)
    // The v2->v3 migration actually ran.
    expect(loaded.migrationsApplied).toContain(2)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    for (const id of ['B1', 'F2']) {
      const p = loaded.dag.getNode(id)!.payload
      expect(p.direction).toBe('up')
      expect(p.boolMode).toBe('newBody')
    }
    // Region/regen behavior is untouched (no region field was ever added).
    expect(loaded.dag.getNode('B1')!.payload.distance).toBe(10)
  })

  it('the v2->v3 migration is an identity step for non-extrude feature payloads', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], payload: { opType: 'revolve', sketchId: 'SK1', angleDeg: 90, name: 'Rev F1' } })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const v2 = rewriteArchive(archive, (manifest) => {
      manifest.schemaVersion = 2
    })
    const loaded = loadDocumentArchive(v2)
    expect(loaded.migrationsApplied).toContain(2)
    const p = loaded.dag.getNode('F1')!.payload
    expect(p.opType).toBe('revolve')
    expect(p.direction).toBeUndefined()
    expect(p.boolMode).toBeUndefined()
  })
})

describe('WO-214 schema v5 end-condition persistence', () => {
  it('round-trips stable Model Item/body/face identity, lineage, direction, and signed offset byte-for-byte', () => {
    const dag = extrudeDoc()
    const endTarget = {
      modelItemId: 'MODEL-1',
      bodyFeatureId: 'B1',
      subshape: {
        kind: 'face',
        stableId: 'B1:BOX:+Z',
        lineage: ['B0:BOX:+Z', 'IMPORT:face#9'],
      },
    }
    dag.setPayload('F2', {
      ...dag.getNode('F2')!.payload,
      endCondition: 'toFace',
      terminalOffset: -1.25,
      endTarget,
    })

    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    const restored = loaded.dag.getNode('F2')!.payload
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(restored.direction).toBe('down')
    expect(restored.endCondition).toBe('toFace')
    expect(restored.terminalOffset).toBe(-1.25)
    expect(restored.endTarget).toEqual(endTarget)
  })

  it('round-trips a standalone datum-plane target identity for save/open re-resolution', () => {
    const dag = extrudeDoc()
    const endTarget = { modelItemId: 'MODEL-1', planeFeatureId: 'datum:offset:7' }
    dag.setPayload('F2', {
      ...dag.getNode('F2')!.payload,
      endCondition: 'toFace',
      terminalOffset: 2.5,
      endTarget,
    })

    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    const restored = loaded.dag.getNode('F2')!.payload
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(restored.endCondition).toBe('toFace')
    expect(restored.terminalOffset).toBe(2.5)
    expect(restored.endTarget).toEqual(endTarget)
  })

  it('migrates genuine schema-v4 Blind and midplane extrudes to explicit end conditions without inventing targets', () => {
    const archive = createDocumentArchive({ dag: extrudeDoc(), elementMapDeltas: [] })
    const v4 = rewriteArchive(archive, (manifest, document) => {
      manifest.schemaVersion = 4
      const dagJson = document.dag as { nodes: Array<Record<string, unknown>> }
      for (const node of dagJson.nodes) {
        const payload = node.payload as Record<string, unknown> | undefined
        if (payload?.opType !== 'extrude') continue
        delete payload.endCondition
        delete payload.terminalOffset
        delete payload.endTarget
      }
      const f2 = dagJson.nodes.find((node) => node.id === 'F2')!
      ;(f2.payload as Record<string, unknown>).direction = 'midplane'
    })

    const loaded = loadDocumentArchive(v4)
    expect(loaded.migrationsApplied).toEqual([4, 6]) // WO-3234 adds the v6->v7 step
    expect(loaded.dag.getNode('B1')!.payload.endCondition).toBe('blind')
    expect(loaded.dag.getNode('F2')!.payload.endCondition).toBe('symmetric')
    expect(loaded.dag.getNode('F2')!.payload.endTarget).toBeUndefined()
    expect(loaded.dag.getNode('F2')!.payload.terminalOffset).toBeUndefined()
  })

  it('leaves non-extrude payloads byte-identical in the v4->v5 migration', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], payload: { opType: 'revolve', angleDeg: 45, name: 'Revolve F1' } })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const v4 = rewriteArchive(archive, (manifest) => { manifest.schemaVersion = 4 })
    const loaded = loadDocumentArchive(v4)
    expect(loaded.dag.getNode('F1')!.payload).toEqual({ opType: 'revolve', angleDeg: 45, name: 'Revolve F1' })
  })
})

describe('WO-1085 schema v6 multi-region selector persistence', () => {
  it('round-trips ordered region signatures without a payload migration', () => {
    const dag = extrudeDoc()
    const profileSelector = {
      kind: 'regions',
      regions: [
        { signature: ['circle-2'] },
        { signature: ['circle-5'], ordinal: 1 },
        { signature: ['circle-7'] },
      ],
    }
    dag.setPayload('F2', { ...dag.getNode('F2')!.payload, profileSelector })

    const loaded = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] }))

    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(loaded.migrationsApplied).toEqual([])
    expect(loaded.dag.getNode('F2')!.payload.profileSelector).toEqual(profileSelector)
  })
})

// ---------------------------------------------------------------------------
// WO UI-51A-R1 (audit MAJOR 2): the compat gate above proved field defaulting
// on a STUB sketch payload (no profile, extrudeMigration.test.ts:38 audit
// finding). This proves the binding invariant itself -- sketchProfile.ts:224 /
// regen.ts:197's documented "regions[0], NOT whole profile" V1 cut line --
// survives a v2->v3 load, through the REAL executor request builder
// (buildExtrudeRequest, the exact function SolidsWorkbenchPage.tsx's regen
// executor calls) and the REAL occt-wasm kernel, on a GENUINELY multi-region
// sketch (not a single-loop stub).
// ---------------------------------------------------------------------------

const REGION_PLANE: ProfileRegion['plane'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

function regionLine(id: string, x1: number, y1: number, x2: number, y2: number): Sketch3dLineEntity {
  return { id, kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

/**
 * A genuine MULTI-REGION sketch: a 60x60 outer square with a 20x20 square
 * hole in the middle, PLUS a separate 10x10 square island nested inside that
 * hole -- the "island-in-hole" case regions.ts documents as its own region,
 * never merged (src/tests/sketch3d/regions.test.ts:94-117). computeProfile
 * Regions therefore emits TWO regions: outer-with-hole (net area 3600-400=
 * 3200) and the island alone (area 100). Canonical sort is by the region's
 * outer loop's minimum srcId ('e0' < 'i0', regions.ts:339-343), so regions[0]
 * is DETERMINISTICALLY the outer-with-hole region -- pinned by an explicit
 * assertion below so a future regions.ts change that flips this ordering
 * fails loud here rather than silently proving the wrong region.
 */
function multiRegionSketchDoc(sketchId: string): Sketch3dDocument {
  return {
    id: sketchId,
    entities: [
      regionLine('e0', 0, 0, 60, 0),
      regionLine('e1', 60, 0, 60, 60),
      regionLine('e2', 60, 60, 0, 60),
      regionLine('e3', 0, 60, 0, 0),
      regionLine('h0', 20, 20, 40, 20),
      regionLine('h1', 40, 20, 40, 40),
      regionLine('h2', 40, 40, 20, 40),
      regionLine('h3', 20, 40, 20, 20),
      regionLine('i0', 25, 25, 35, 25),
      regionLine('i1', 35, 25, 35, 35),
      regionLine('i2', 35, 35, 25, 35),
      regionLine('i3', 25, 35, 25, 25),
    ],
    constraints: [],
  }
}

describe('WO UI-51A-R1 (audit MAJOR 2): regions[0] geometry identity, real executor + real kernel', () => {
  it('a real v2 archive with a multi-region sketch profile regenerates to IDENTICAL regions[0] geometry pre/post migration', async () => {
    const regions = await computeProfileRegions(multiRegionSketchDoc('SK1'), REGION_PLANE)
    expect(regions).toHaveLength(2) // genuinely multi-region, not a single-loop stub
    const region0 = regions[0]
    expect(region0.loops).toHaveLength(2) // outer boundary + the square hole
    expect(region0.loops[0].map((s) => s.srcId).sort()).toEqual(['e0', 'e1', 'e2', 'e3'])

    const DEPTH = 8
    const dag = new FeatureDag()
    // The sketch node's payload.profile is a REAL ProfileRegion (regions[0]
    // of a genuinely multi-region sketch) -- exactly what recomputeSketchProfile
    // (SolidsWorkbenchPage.tsx:2030) persists in production, not a name-only stub.
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1', profile: region0 } })
    dag.insertNode({
      id: 'B1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: DEPTH, direction: 'up', boolMode: 'newBody', name: 'Extrude B1' },
    })

    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    // A genuine pre-UI-51A v2 archive: strip direction/boolMode/targetFeatureId
    // from the extrude payload and stamp schemaVersion back to 2 (same recipe
    // as the compat-default test above).
    const v2 = rewriteArchive(archive, (manifest, document) => {
      manifest.schemaVersion = 2
      const dagJson = document.dag as { nodes: Array<Record<string, unknown>> }
      for (const n of dagJson.nodes) {
        const p = n.payload as Record<string, unknown> | undefined
        if (p && p.opType === 'extrude') {
          delete p.direction
          delete p.boolMode
          delete p.targetFeatureId
        }
      }
    })

    const loaded = loadDocumentArchive(v2)
    expect(loaded.migrationsApplied).toContain(2)
    const migratedPayload = loaded.dag.getNode('B1')!.payload as unknown as ExtrudeParamsInput & { distance: number }
    expect(migratedPayload.direction).toBe('up')
    expect(migratedPayload.boolMode).toBe('newBody')
    const migratedProfile = loaded.dag.getNode('SK1')!.payload.profile as ProfileRegion
    // regions[0]'s truncation survives the archive round trip byte-for-byte.
    expect(migratedProfile).toEqual(region0)

    const engine = new GeomEngine()
    await engine.init()
    try {
      // POST: the REAL executor request builder (the exact function
      // SolidsWorkbenchPage.tsx's regen executor imports and calls) drives the
      // MIGRATED v3 payload into the REAL occt-wasm kernel.
      const postBuild = buildExtrudeRequest({
        featureId: 'B1',
        payload: migratedPayload,
        profile: migratedProfile,
        distance: migratedPayload.distance,
        lookupTarget: () => undefined,
      })
      expect(postBuild.ok).toBe(true)
      if (!postBuild.ok) throw new Error('unreachable: postBuild must succeed for this fixture')
      const post = await engine.makeExtrude(postBuild.req)
      expect(post.ok).toBe(true)
      const postVol = await engine.measure(post.body!, 'volume')

      // PRE: the pre-UI-51A implicit semantics (blind / +distance / newBody --
      // there was no direction/boolMode field before this WO) against the SAME
      // regions[0] profile, hand-built without buildExtrudeRequest at all --
      // what the v2 file's geometry always was, before UI-51A ever existed.
      const preReq: ExtrudeRequest = { featureId: 'B1', profile: region0, end: { kind: 'blind', distance: DEPTH }, op: 'newBody' }
      const pre = await engine.makeExtrude(preReq)
      expect(pre.ok).toBe(true)
      const preVol = await engine.measure(pre.body!, 'volume')

      // Analytic check: regions[0] alone (outer 3600 - hole 400 = 3200) * depth
      // -- NOT a "whole profile" merge (which would net 3600-400+100=3300 by
      // treating the island as filling part of the hole). This is the
      // regions[0]-not-whole-profile invariant, proven against a real kernel
      // volume rather than asserted about the payload shape alone.
      const expectedVol = 3200 * DEPTH
      expect(Math.abs(postVol.value - expectedVol) / expectedVol).toBeLessThan(1e-6)
      expect(Math.abs(preVol.value - expectedVol) / expectedVol).toBeLessThan(1e-6)
      expect(postVol.value).toBeCloseTo(preVol.value, 6)

      // Geometry identity beyond volume: identical generated element id set
      // and cap-face centroid Z pair (bbox proxy for this flat-topped solid).
      const postIds = [...post.elementMap!.generated].sort()
      const preIds = [...pre.elementMap!.generated].sort()
      expect(postIds).toEqual(preIds)
      const capZs = (r: typeof post): number[] =>
        Object.entries(r.elementMap!.geometry!)
          .filter(([id]) => id.includes(':cap'))
          .map(([, snap]) => Math.round(snap.centroid.z * 1e5) / 1e5)
          .sort((a, b) => a - b)
      expect(capZs(post)).toEqual(capZs(pre))

      await engine.dispose(post.body!)
      await engine.dispose(pre.body!)
    } finally {
      await engine.disposeKernel()
    }
  }, 60_000)
})
