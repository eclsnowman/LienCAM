// WO-3234: the background (no Model tab) replay builds a Thin extrude from its
// payload with the same request the Model tab's builder makes, and the body is
// the exact thin wall the REPORT formulas give.
//
// Route: the document is held through documentHolder and rebuilt by the
// production background replay (modelBodyHoleRecognition.ts ->
// headlessFeatureReplay.ts -> lib/cam buildExtrudeRequest copy -> makeExtrude
// on the shipped kernel). The request is captured at the kernel boundary and
// compared with the Model tab's own builder (workbench/extrudeParams.ts) and
// with the request the agent command's payload builds.
//
// Measured against: 40 x 20 rectangle, D = 8, t = 2 -> inside 1792, outside
// 2048, center 1920 mm3; R10 circle with an r5 hole, inside t = 1, D = 8 ->
// 240*pi mm3.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { ExtrudeRequest, OpResult, ProfileRegion } from '../../geom/geom-service'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { FeatureDag } from '../../doc'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  resolveModelReferencesHeadless,
} from '../../lib/cam/modelBodyHoleRecognition'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import { textFor } from '../../i18n'

const workbenchText = textFor('sketch-and-model-workbench')
const BODY = 'F1'
const SKETCH = 'sketch3d:S1'

const sketchOf = (entities: SketchEntity[]): Sketch =>
  ({ id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }) as Sketch

function rectangle(w: number, h: number): SketchEntity[] {
  return [
    { id: 'r0', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: w, y: 0 } },
    { id: 'r1', kind: 'line', construction: false, start: { x: w, y: 0 }, end: { x: w, y: h } },
    { id: 'r2', kind: 'line', construction: false, start: { x: w, y: h }, end: { x: 0, y: h } },
    { id: 'r3', kind: 'line', construction: false, start: { x: 0, y: h }, end: { x: 0, y: 0 } },
  ] as SketchEntity[]
}

const ring: SketchEntity[] = [
  { id: 'c-outer', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 10 },
  { id: 'c-hole', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 },
] as SketchEntity[]

function thinDag(entities: SketchEntity[], wall: Record<string, unknown>, extra: Record<string, unknown> = {}): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: SKETCH, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [],
    payload: { sketch: sketchOf(entities), planeNodeId: BASE_PLANE_XY_NODE_ID },
  })
  dag.insertNode({
    id: BODY, kind: 'feature', consumes: [SKETCH], refs: [],
    payload: {
      opType: 'extrude', sketchId: SKETCH, profileSelector: { kind: 'whole-sketch' },
      distance: 8, direction: 'up', endCondition: 'blind', boolMode: 'newBody', name: 'Extrude F1',
      ...wall, ...extra,
    },
  })
  return dag
}

/** What the background replay sent to the kernel for BODY, and the volume it got. */
let built: { req: ExtrudeRequest; volume: number | undefined; profiles: ProfileRegion[] } | null = null
function capturingClient(): GeomClient {
  const client = createLocalGeomService()
  const makeExtrude = client.makeExtrude.bind(client)
  client.makeExtrude = async (req: ExtrudeRequest): Promise<OpResult> => {
    const r = await makeExtrude(req)
    if (req.featureId === BODY) {
      built = {
        req: structuredClone({ ...req, profiles: undefined }) as ExtrudeRequest,
        profiles: structuredClone(req.profiles as ProfileRegion[]),
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

/** The Model tab's builder (and so the preview's and Apply's) over the same payload and profiles. */
function modelTabRequest(dag: FeatureDag, profiles: ProfileRegion[]): ExtrudeRequest {
  const payload = dag.getNode(BODY)!.payload
  const build = buildExtrudeRequest({
    featureId: BODY,
    payload: payload as ExtrudeParamsInput,
    profiles,
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

describe('WO-3234 headless Thin extrude replay', () => {
  const cases: Array<[string, SketchEntity[], Record<string, unknown>, number]> = [
    ['rectangle inside t=2', rectangle(40, 20), { wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }, 1792],
    ['rectangle outside t=2', rectangle(40, 20), { wallMode: 'thin', wallThickness: 2, wallSide: 'outside' }, 2048],
    ['rectangle center t=2', rectangle(40, 20), { wallMode: 'thin', wallThickness: 2, wallSide: 'center' }, 1920],
    ['nested R10/r5 inside t=1', ring, { wallMode: 'thin', wallThickness: 1, wallSide: 'inside' }, 240 * Math.PI],
  ]
  for (const [name, entities, wall, volume] of cases) {
    it(`${name}: the body is the exact thin wall and the request is the Model tab's`, async () => {
      const dag = thinDag(entities, wall)
      const result = await replay(dag)
      expect(result.reason).toBeUndefined()
      expect(built, 'the background replay reached the kernel').not.toBeNull()
      expect(built!.volume).toBeCloseTo(volume, 6)
      expect(built!.req.thin).toEqual({ thickness: wall.wallThickness, side: wall.wallSide })
      const page = modelTabRequest(dag, built!.profiles)
      expect({ ...page, profiles: undefined }).toEqual(built!.req)
    }, 120_000)
  }

  it('an ordinary solid replays unchanged: no thin on the request, the full prism volume', async () => {
    const dag = thinDag(rectangle(40, 20), {})
    expect((await replay(dag)).reason).toBeUndefined()
    expect(built!.req.thin).toBeUndefined()
    expect(built!.volume).toBeCloseTo(40 * 20 * 8, 6)
  }, 120_000)

  it('a stale thickness on an explicit solid is not read and changes nothing', async () => {
    const dag = thinDag(rectangle(40, 20), { wallMode: 'solid', wallThickness: -2, wallSide: 'nowhere' })
    expect((await replay(dag)).reason).toBeUndefined()
    expect(built!.req.thin).toBeUndefined()
    expect(built!.volume).toBeCloseTo(6400, 6)
  }, 120_000)

  it('Symmetric (midplane) Thin builds the same wall centred on the sketch plane', async () => {
    const dag = thinDag(rectangle(40, 20), { wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }, { direction: 'midplane', endCondition: 'symmetric' })
    expect((await replay(dag)).reason).toBeUndefined()
    expect(built!.req.end).toEqual({ kind: 'symmetric', distance: 8 })
    expect(built!.volume).toBeCloseTo(1792, 6)
  }, 120_000)

  it('Thin with a target-driven end is refused in one line before the kernel, never built as Blind', async () => {
    const dag = thinDag(rectangle(40, 20), { wallMode: 'thin', wallThickness: 2, wallSide: 'inside' }, { endCondition: 'upToNext' })
    const result = await replay(dag)
    expect(built, 'nothing reached the kernel').toBeNull()
    // WO-3235 supports target-driven Thin ends, so a targetless fixture is refused
    // for the missing live target - not with the old blanket Thin refusal.
    expect(result.reason).toContain(
      workbenchText('extrudeParams.extrudeRequiresAtLeastOneLiveSameItemTarget', { rawEnd: 'upToNext' }),
    )
  }, 120_000)
})
