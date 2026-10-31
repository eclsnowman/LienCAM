// WO-3237: the background (no Model tab) replay - what CAM rebuilds a cold
// document's bodies with - builds a Thin wall along a saved open chain with the
// same request the Model tab's builder makes, and the body is the exact wall
// the REPORT formulas give. The agent command writes the dialog's payload and
// builds the same request. A chain that cannot be followed, or a chain without
// Thin, is refused by name before the kernel: never a region, never a solid.
//
// Route: the document is held through documentHolder (the cold-open path) and
// rebuilt by the production background replay (modelBodyHoleRecognition.ts ->
// headlessFeatureReplay.ts -> lib/cam resolveExtrudeSelection +
// buildExtrudeRequest copies -> makeExtrude on the shipped kernel). The request
// is captured at the kernel boundary.
//
// Measured against: U (0,30)->(0,0)->(36,0)->(36,30), D = 8, t = 2:
// left (its inside) 1472, right 1600, center 1536 mm3; the same U reversed,
// left 1600.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest, OpResult, ProfileRegion } from '../../geom/geom-service'
import { registerModelSession, resetDocumentHolder, stashLoadedDocument, LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import { ElementMap, createModelSession, type FeatureDag } from '../../doc'
import { CURRENT_SCHEMA_VERSION, FutureSchemaVersionError, createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  resolveModelReferencesHeadless,
} from '../../lib/cam/modelBodyHoleRecognition'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import { resolveExtrudeSelection, type ProfileSelector } from '../../components/model3d/workbench/regionSelector'
import { modelCommands } from '../../lib/agent/commands'
import { textFor } from '../../i18n'

const thinOpenText = textFor('thin-open-extrude.wo3237')
const BODY = 'F1'
const SKETCH = 'sketch3d:S1'

const line = (id: string, x: number, y: number, xx: number, yy: number): SketchEntity =>
  ({ id, kind: 'line', construction: false, start: { x, y }, end: { x: xx, y: yy } }) as SketchEntity
const uEntities = (): SketchEntity[] => [line('a', 0, 30, 0, 0), line('b', 0, 0, 36, 0), line('c', 36, 0, 36, 30)]
const sketchOf = (entities: SketchEntity[]): Sketch =>
  ({ id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }) as Sketch
const steps = (forward = true) => (forward
  ? [{ entityId: 'a', forward: true }, { entityId: 'b', forward: true }, { entityId: 'c', forward: true }]
  : [{ entityId: 'c', forward: false }, { entityId: 'b', forward: false }, { entityId: 'a', forward: false }])
const chainSelector = (forward = true): ProfileSelector => ({ kind: 'sketch-chain', sketchId: SKETCH, steps: steps(forward) })

function sketchDag(entities: SketchEntity[] = uEntities()): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: SKETCH, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: sketchOf(entities), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  return dag
}

function openDag(wall: Record<string, unknown>, extra: Record<string, unknown> = {}, entities?: SketchEntity[]): FeatureDag {
  const dag = sketchDag(entities)
  dag.insertNode({
    id: BODY, kind: 'feature', consumes: [SKETCH], refs: [],
    payload: {
      opType: 'extrude', sketchId: SKETCH, profileSelector: chainSelector(),
      distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', name: 'Extrude F1',
      ...wall, ...extra,
    },
  })
  return dag
}

let built: { req: ExtrudeRequest; volume: number | undefined } | null = null
function capturingClient(): GeomClient {
  const client = createLocalGeomService()
  const makeExtrude = client.makeExtrude.bind(client)
  client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
    const r = await makeExtrude(req)
    if (req.featureId === BODY) {
      built = {
        req: structuredClone(req),
        volume: r.ok && r.body !== undefined ? (await client.measure(r.body, 'volume')).value : undefined,
      }
    }
    return r
  }
  return client
}

async function replay(dag: FeatureDag): Promise<{ reason?: string }> {
  stashLoadedDocument(finalizeSeedArchive(dag))
  built = null
  try {
    await resolveModelReferencesHeadless('legacy', new Map([[BODY, []]]))
    return {}
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) }
  }
}

/** The Model tab's resolver and builder (so the preview's and Apply's) over the same payload. */
function modelTabRequest(dag: FeatureDag, id = BODY): ExtrudeRequest {
  const payload = dag.getNode(id)!.payload
  const selection = resolveExtrudeSelection(
    payload.sketchId as string,
    dag.getNode(payload.sketchId as string)?.payload.regions as ProfileRegion[] | undefined,
    payload.profileSelector as ProfileSelector,
    (nodeId) => dag.getNode(nodeId),
  )
  if (!selection.ok) throw new Error(selection.message)
  const build = buildExtrudeRequest({
    featureId: id,
    payload: payload as ExtrudeParamsInput,
    profiles: selection.profiles,
    openChain: selection.openChain,
    distance: payload.distance as number,
    lookupTarget: () => undefined,
    modelItemId: 'legacy',
    candidateTargets: [],
  })
  if (!build.ok) throw new Error(build.reason)
  return build.req
}

beforeEach(() => {
  resetDocumentHolder()
  built = null
  __setModelBodyHeadlessClientFactoryForTests(capturingClient)
})

afterEach(() => {
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
})

describe('WO-3237 headless Thin open-chain replay (the cold CAM route)', () => {
  const cases: Array<[string, boolean, string, number]> = [
    ['left', true, 'left', 1472],
    ['right', true, 'right', 1600],
    ['center', true, 'center', 1536],
    ['left of the reversed chain', false, 'left', 1600],
  ]
  for (const [name, forward, side, volume] of cases) {
    it(`U ${name}: the exact wall, and the request is the Model tab's`, async () => {
      const dag = openDag({ wallMode: 'thin', wallThickness: 2, wallSide: side }, { profileSelector: chainSelector(forward) })
      const result = await replay(dag)
      expect(result.reason).toBeUndefined()
      expect(built, 'the background replay reached the kernel').not.toBeNull()
      expect(Math.abs(built!.volume! - volume) / volume).toBeLessThan(1e-6)
      expect(built!.req.thin).toEqual({ thickness: 2, side, open: true })
      expect(built!.req.profiles).toHaveLength(1)
      expect(built!.req.profiles![0].loops).toHaveLength(1)
      expect(built!.req.profiles![0].loops[0].map((s) => s.srcId)).toEqual(forward ? ['a', 'b', 'c'] : ['c', 'b', 'a'])
      expect(modelTabRequest(dag)).toEqual(built!.req)
    }, 120_000)
  }

  it('a missing side means Left of travel, as in the dialog', async () => {
    const dag = openDag({ wallMode: 'thin', wallThickness: 2 })
    expect((await replay(dag)).reason).toBeUndefined()
    expect(built!.req.thin).toEqual({ thickness: 2, side: 'left', open: true })
    expect(Math.abs(built!.volume! - 1472) / 1472).toBeLessThan(1e-6)
  }, 120_000)

  it('a chain without Thin is refused by name before the kernel: never filled or built solid', async () => {
    for (const wall of [{}, { wallMode: 'solid' }]) {
      const result = await replay(openDag(wall))
      expect(built, 'nothing reached the kernel').toBeNull()
      expect(result.reason).toContain(thinOpenText('needsThin'))
    }
  }, 120_000)

  it('a closed side on a chain is refused by name, never mapped to left or right', async () => {
    const result = await replay(openDag({ wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }))
    expect(built).toBeNull()
    expect(result.reason).toContain(thinOpenText('unknownOpenSide', { side: 'inside' }))
  }, 120_000)

  it('a lost chain curve is refused by name: no region, no whole sketch, nothing built', async () => {
    const result = await replay(openDag({ wallMode: 'thin', wallThickness: 2, wallSide: 'left' }, {}, [line('a', 0, 30, 0, 0), line('c', 36, 0, 36, 30)]))
    expect(built).toBeNull()
    expect(result.reason).toMatch(/missing-entity/)
    expect(result.reason).toMatch(/b no longer exists/)
  }, 120_000)

  it('a chain of another sketch is refused by name', async () => {
    const result = await replay(openDag({ wallMode: 'thin', wallThickness: 2 }, { profileSelector: { ...chainSelector(), sketchId: 'sketch3d:OTHER' } }))
    expect(built).toBeNull()
    expect(result.reason).toContain(thinOpenText('wrongSketch', { chainSketch: 'sketch3d:OTHER', sketch: SKETCH }))
  }, 120_000)

  it('saves at the new schema; a reader one version older refuses the file instead of opening it', async () => {
    const dag = openDag({ wallMode: 'thin', wallThickness: 2, wallSide: 'center' })
    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const files = unzipSync(archive)
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { schemaVersion: number }
    expect(manifest.schemaVersion).toBe(9)
    expect(CURRENT_SCHEMA_VERSION).toBe(9)
    const loaded = loadDocumentArchive(archive)
    expect(loaded.migrationsApplied).toEqual([])
    expect(loaded.dag.getNode(BODY)!.payload).toEqual(dag.getNode(BODY)!.payload)
    // A schema-7 build is migrateToCurrent with CURRENT 7: this stamp is to it
    // what CURRENT + 1 is to this build.
    const future = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify({ ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION + 1 })) })
    expect(() => loadDocumentArchive(future)).toThrow(FutureSchemaVersionError)
    // The reopened document replays cold to the same wall.
    expect((await replay(loaded.dag)).reason).toBeUndefined()
    expect(Math.abs(built!.volume! - 1536) / 1536).toBeLessThan(1e-6)
  }, 120_000)
})

describe('WO-3237 model.extrude along an open chain', () => {
  it('writes the dialog payload and builds the same request the headless replay sends', async () => {
    const dag = sketchDag()
    const s = createModelSession({ modelItemId: LEGACY_MODEL_ITEM_ID, dag, map: new ElementMap(), kernelOp: async () => ({ ok: true, diagnostics: [] }) })
    registerModelSession(s)
    const result = await modelCommands.run('model.extrude', {
      sketchId: SKETCH, distance: 8, wallMode: 'thin', wallThickness: 2, wallSide: 'center', openChain: { steps: steps() },
    }, {})
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(s.dag.getNode('F1')!.payload).toMatchObject({
      opType: 'extrude', sketchId: SKETCH, profileSelector: chainSelector(), wallMode: 'thin', wallThickness: 2, wallSide: 'center',
    })
    const agentReq = modelTabRequest(s.dag, 'F1')
    resetDocumentHolder()
    __setModelBodyHeadlessClientFactoryForTests(capturingClient)
    expect((await replay(openDag({ wallMode: 'thin', wallThickness: 2, wallSide: 'center' }))).reason).toBeUndefined()
    expect(agentReq).toEqual(built!.req)
  }, 120_000)

  it('without Thin the chain is refused in the dialog\'s words and nothing is committed', async () => {
    const dag = sketchDag()
    const s = createModelSession({ modelItemId: LEGACY_MODEL_ITEM_ID, dag, map: new ElementMap(), kernelOp: async () => ({ ok: true, diagnostics: [] }) })
    registerModelSession(s)
    const before = s.history.size()
    const result = await modelCommands.run('model.extrude', { sketchId: SKETCH, distance: 8, openChain: { steps: steps() } }, {})
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain(thinOpenText('needsThin'))
    expect(s.dag.has('F1')).toBe(false)
    expect(s.history.size()).toBe(before)
  }, 120_000)
})
