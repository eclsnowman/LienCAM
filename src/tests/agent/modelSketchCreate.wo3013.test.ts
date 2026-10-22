// WO-3013: model.sketch.create on a real ModelSession and the real kernel. T1-T9 of
// docs/design/WO-2951-modeling-mcp.md "Test protocol".
//
// The session's kernel op does what the Model page's regen does for the two node kinds this
// needs: a package sketch (payload.sketch) re-derives its regions from the plane's frame with
// extractSketchProfile (the page's recomputeSketchProfile), and an extrude node runs the real
// occt-wasm makeExtrude on those regions. The DAG, the history and the scheduler are real.
// The reference for "the same body as drawing it in the sketcher" is a hand-written sketch of
// four lines (the entities the rectangle tool commits) on the same plane, extruded the same way.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession, type ModelSession } from '../../doc'
import { applyFeatureDelta } from '../../doc/replay'
import { makeDatumPlaneExecutor } from '../../sketch3d/datumPlane'
import { buildFacePlaneDatumNodeInput } from '../../sketch3d/datumPlane'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { CompositeCommand } from '../../doc'
import type { FeatureOp } from '../../doc/regen'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { createDocumentArchive, stableStringify } from '../../doc/persist'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { BodyHandle } from '../../geom/geom-service'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import { textFor } from '../../i18n'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

const workbenchText = textFor('sketch-and-model-workbench')

let engine: GeomEngine
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
}, 60_000)
afterAll(async () => {
  await engine.disposeKernel()
})

interface Opened {
  session: ModelSession
  handles: Map<string, BodyHandle>
  map: ElementMap
}

function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID, withKernel = true): Opened {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const handles = new Map<string, BodyHandle>()
  const map = new ElementMap()
  const kernelOp: FeatureOp = async (node) => {
    if (!withKernel) return { ok: true, diagnostics: [] }
    // The page's datum branch: a face plane re-reads its face from the element map.
    if (node.kind === 'datum') return makeDatumPlaneExecutor(dag, map)(node)
    if (node.kind === 'sketch' && typeof node.payload.sketch === 'object' && node.payload.sketch !== null) {
      const plane = dag.getNode(node.payload.planeNodeId as string)
      const frame = plane?.payload.lastGoodFrame as Parameters<typeof extractSketchProfile>[1]
      const raw = node.id.replace(/^sketch3d:/, '')
      const result = await extractSketchProfile(node.payload.sketch as Sketch, frame, raw)
      const { regions: _gone, ...rest } = node.payload
      void _gone
      dag.setPayload(node.id, result.ok ? { ...rest, regions: result.regions } : rest)
      return { ok: true, diagnostics: [] }
    }
    if (node.kind === 'feature' && node.payload.opType === 'extrude') {
      const regions = dag.getNode(node.payload.sketchId as string)?.payload.regions as Array<Record<string, unknown>> | undefined
      if (regions === undefined || regions.length === 0) return { ok: false, diagnostics: [{ code: 'OPEN_PROFILE', severity: 'error', params: {} }] }
      const made = await engine.makeExtrude({
        featureId: node.id,
        profiles: regions as never,
        end: { kind: 'blind', distance: node.payload.distance as number },
        op: 'newBody',
      })
      if (!made.ok || made.body === undefined) return { ok: false, diagnostics: made.diagnostics ?? [] }
      handles.set(node.id, made.body)
      if (made.elementMap !== undefined) applyFeatureDelta(map, made.elementMap)
      return { ok: true, diagnostics: [] }
    }
    return { ok: true, diagnostics: [] }
  }
  const session = createModelSession({ modelItemId, dag, map, kernelOp })
  registerModelSession(session)
  return { session, handles, map }
}

afterEach(() => resetDocumentHolder())

const create = (args: unknown, options = {}): Promise<ModelCommandResult> => modelCommands.run('model.sketch.create', args, options)

function ok(result: ModelCommandResult): ModelCommandSuccess<any> {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

function fingerprint(s: ModelSession) {
  return {
    dag: stableStringify(JSON.parse(s.dag.serialize())),
    depth: s.history.size(),
    revision: s.revision(),
    statuses: s.dag.nodeIds().map((id) => `${id}:${s.scheduler.statusOf(id)}`).join(','),
  }
}

const RECT_40_20 = { kind: 'rectangle', corner: { x: 0, y: 0 }, width: 40, height: 20 }

async function volumeOf(o: Opened, featureId: string): Promise<number> {
  const handle = o.handles.get(featureId)
  if (handle === undefined) throw new Error(`no body for ${featureId}`)
  return (await engine.measure(handle, 'volume')).value
}

describe('WO-3013 model.sketch.create T1 schema refusals', () => {
  it('missing plane / profiles, unknown key, wrong type, bad kind: each refused with its code and nothing changed', async () => {
    const { session: s } = openModel()
    ok(await create({ plane: 'XY', profiles: [RECT_40_20] }))
    const before = fingerprint(s)
    expect(await create({ profiles: [RECT_40_20] })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.plane' })
    expect(await create({ plane: 'XY' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.profiles' })
    expect(await create({ plane: 'XY', profiles: [RECT_40_20], colour: 'red' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.colour' })
    expect(await create({ plane: 7, profiles: [RECT_40_20] })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.plane' })
    expect(await create({ plane: 'XY', profiles: [{ kind: 'star' }] })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.profiles[0].kind' })
    expect(await create({ plane: 'XY', profiles: [{ kind: 'rectangle', corner: { x: 0 }, width: 1, height: 1 }] })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.profiles[0].corner.y' })
    expect(await create({ plane: 'XY', profiles: [{ kind: 'rectangle', corner: { x: 0, y: 0 }, width: '4', height: 1 }] })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.profiles[0].width' })
    expect(await create('XY')).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$' })
    expect(fingerprint(s)).toEqual(before)
  })

  it('with no Model page mounted: one plain sentence, nothing thrown', async () => {
    resetDocumentHolder()
    expect(await create({ plane: 'XY', profiles: [RECT_40_20] })).toMatchObject({ ok: false, code: 'no-model-open' })
  })
})

describe('WO-3013 model.sketch.create T2 the same sketch the sketcher makes', () => {
  it('the node is the page\'s own: consumes the plane, payload { sketch, planeNodeId, externalRefs, dimensionDiagnostics, name }', async () => {
    const { session: s } = openModel()
    const r = ok(await create({ plane: 'xy', profiles: [RECT_40_20] }))
    expect(r.value.sketchId).toBe('sketch3d:SK1')
    expect(r.value.plane).toBe('datum:XY')
    const node = s.dag.getNode('sketch3d:SK1')!
    expect(node.kind).toBe('sketch')
    expect(node.consumes).toEqual(['datum:XY'])
    expect(node.payload).toMatchObject({ planeNodeId: 'datum:XY', externalRefs: [], dimensionDiagnostics: [], name: workbenchText('SolidsWorkbenchPage.sketchOn', { value1: 'XY' }) })
    const sketch = node.payload.sketch as Sketch
    // The rectangle tool's commit: four lines, four coincident corners, two horizontals, two verticals, the construction centre.
    const lines = sketch.entities.filter((e) => e.kind === 'line' && !e.construction)
    expect(lines).toHaveLength(4)
    expect(sketch.constraints.filter((c) => c.kind === 'coincident').length).toBeGreaterThanOrEqual(4)
    expect(sketch.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(2)
    expect(sketch.constraints.filter((c) => c.kind === 'vertical')).toHaveLength(2)
    expect(r.value.profiles).toEqual([{ index: 0, kind: 'rectangle', entityIds: lines.map((l) => l.id) }])
    expect(r.value.regionCount).toBe(1)
    expect(s.dag.getNode('sketch3d:SK1')!.payload.regions).toHaveLength(1)
  })

  it('extruded with model.extrude it gives the same body as the hand-drawn rectangle: same volume, same extrude node', async () => {
    const agent = openModel('item-A')
    ok(await create({ plane: 'XY', profiles: [RECT_40_20] }, { modelItemId: 'item-A' }))
    const extruded = ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }, { modelItemId: 'item-A' }))
    expect(extruded.value).toMatchObject({ featureId: 'F1', status: 'ok' })
    const agentVolume = await volumeOf(agent, 'F1')

    // The sketcher's result: the four lines the rectangle tool commits, in a package sketch on XY.
    const drawn = openModel('item-B')
    const ids = ['a', 'b', 'c', 'd']
    const corners = [[0, 0], [40, 0], [40, 20], [0, 20]]
    const entities: SketchEntity[] = ids.map((id, i) => ({
      id, kind: 'line', construction: false,
      start: { x: corners[i][0], y: corners[i][1] },
      end: { x: corners[(i + 1) % 4][0], y: corners[(i + 1) % 4][1] },
    }))
    const sketch: Sketch = { id: 'sketch-ref', layerId: 'plane:xy', entities, constraints: [], dimensions: [], solveStatus: null }
    drawn.session.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], refs: [], payload: { sketch, planeNodeId: 'datum:XY', externalRefs: [], dimensionDiagnostics: [] } })
    drawn.session.scheduler.markDirty('sketch3d:SK1')
    await drawn.session.scheduler.run(drawn.session.params.executor)
    await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }, { modelItemId: 'item-B' })
    const drawnVolume = await volumeOf(drawn, 'F1')

    expect(agentVolume).toBeCloseTo(8000, 3)
    expect(agentVolume).toBeCloseTo(drawnVolume, 6)
    expect(agent.session.dag.getNode('F1')!.payload).toEqual(drawn.session.dag.getNode('F1')!.payload)
    expect((agent.session.dag.getNode('sketch3d:SK1')!.payload.regions as unknown[]).length).toBe((drawn.session.dag.getNode('sketch3d:SK1')!.payload.regions as unknown[]).length)
  })

  it('a circle and a closed polyline are profiles the extrude takes: their volumes are pi r^2 h and the polygon area times h', async () => {
    const circle = openModel('item-A')
    ok(await create({ plane: 'XY', profiles: [{ kind: 'circle', center: { x: 5, y: 5 }, radius: 3 }] }, { modelItemId: 'item-A' }))
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }, { modelItemId: 'item-A' }))
    expect(await volumeOf(circle, 'F1')).toBeCloseTo(Math.PI * 9 * 10, 1)

    const tri = openModel('item-B')
    const made = ok(await create({ plane: 'XY', profiles: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }] }] }, { modelItemId: 'item-B' }))
    expect(made.value.regionCount).toBe(1)
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 4 }, { modelItemId: 'item-B' }))
    expect(await volumeOf(tri, 'F1')).toBeCloseTo(30 * 4, 3)
  })

  it('profiles on the other base planes land on their planes, and a circle inside a rectangle is a hole in its one region', async () => {
    const { session: s } = openModel()
    const r = ok(await create({ plane: 'YZ', profiles: [RECT_40_20, { kind: 'circle', center: { x: 20, y: 10 }, radius: 4 }] }))
    expect(r.value.plane).toBe('datum:YZ')
    expect(r.value.profiles.map((p: { kind: string }) => p.kind)).toEqual(['rectangle', 'circle'])
    expect(r.value.regionCount).toBe(1)
    expect((s.dag.getNode('sketch3d:SK1')!.payload.regions as Array<{ loops: unknown[] }>)[0].loops).toHaveLength(2)
    expect(s.dag.getNode('sketch3d:SK1')!.consumes).toEqual(['datum:YZ'])
    // The ids model.summary lists for the base planes work as the plane too.
    const byId = ok(await create({ plane: 'datum:XY', profiles: [RECT_40_20] }))
    expect(byId.value.plane).toBe('datum:XY')
    const xz = ok(await create({ plane: 'XZ', profiles: [RECT_40_20] }))
    expect(xz.value.sketchId).toBe('sketch3d:SK3')
    expect(xz.value.plane).toBe('datum:XZ')
  })
})

describe('WO-3013 model.sketch.create T5b a closed polyline that repeats its first point (astra round 3 F3)', () => {
  async function sketchOf(points: Array<{ x: number; y: number }>): Promise<{ result: string; archive: string }> {
    const { session: s } = openModel()
    const result = JSON.stringify(await create({ plane: 'XY', profiles: [{ kind: 'polyline', points }] }))
    const archive = Buffer.from(createDocumentArchive({ dag: s.dag, elementMapDeltas: [] })).toString('base64')
    resetDocumentHolder()
    return { result, archive }
  }

  it('is the same sketch as the polyline without the repeat: the line tool already closed it', async () => {
    const open = await sketchOf([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }])
    const repeated = await sketchOf([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }])
    expect(JSON.parse(repeated.result)).toMatchObject({ ok: true })
    expect(repeated.result).toBe(open.result)
    expect(repeated.archive).toBe(open.archive)
  })
})

describe('WO-3013 model.sketch.create T3 determinism', () => {
  async function script(): Promise<{ results: string[]; archive: string }> {
    const { session: s } = openModel()
    const results: string[] = []
    results.push(JSON.stringify(await create({ plane: 'XY', profiles: [RECT_40_20, { kind: 'circle', center: { x: 2, y: 2 }, radius: 1 }] })))
    results.push(JSON.stringify(await create({ plane: 'XZ', profiles: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }] }] })))
    results.push(JSON.stringify(await modelCommands.run('model.undo')))
    const archive = Buffer.from(createDocumentArchive({ dag: s.dag, elementMapDeltas: [] })).toString('base64')
    resetDocumentHolder()
    return { results, archive }
  }

  it('the same script on two fresh sessions gives byte-identical result JSON and archives', async () => {
    const first = await script()
    const second = await script()
    expect(second.results).toEqual(first.results)
    expect(second.archive).toBe(first.archive)
    expect(first.results.join('\n')).not.toMatch(/\b1[67]\d{11}\b|[0-9a-f]{8}-[0-9a-f]{4}-/)
  })
})

describe('WO-3013 model.sketch.create T4 one call, one step', () => {
  it('each call adds one "Agent: Sketch" step; Undo removes the sketch; a refused call adds none', async () => {
    const { session: s } = openModel()
    const a = ok(await create({ plane: 'XY', profiles: [RECT_40_20] }))
    const b = ok(await create({ plane: 'XZ', profiles: [RECT_40_20] }))
    expect(s.history.size()).toBe(2)
    expect(a.step).toBe('Agent: Sketch')
    expect(b.step).toBe('Agent: Sketch')
    expect(a.changed).toEqual({ created: ['sketch3d:SK1'], edited: [], removed: [] })
    expect(s.history.lastAppliedCommand()?.label).toBe('Agent: Sketch')

    expect((await create({ plane: 'XY', profiles: [] })).ok).toBe(false)
    expect(s.history.size()).toBe(2)

    await s.undo()
    expect(s.dag.has('sketch3d:SK2')).toBe(false)
    expect(s.dag.has('sketch3d:SK1')).toBe(true)
    await s.undo()
    expect(s.dag.has('sketch3d:SK1')).toBe(false)
    expect(s.history.size()).toBe(0)
  })

  it('the step label is localised in all four locales', async () => {
    const { default: de } = await import('../../i18n/locales/de/sketch-and-model-workbench')
    const { default: es } = await import('../../i18n/locales/es/sketch-and-model-workbench')
    const { default: fr } = await import('../../i18n/locales/fr/sketch-and-model-workbench')
    const { default: en } = await import('../../i18n/locales/en/sketch-and-model-workbench')
    for (const words of [en, de, es, fr] as Array<{ AgentCommands: Record<string, string> }>) {
      expect(words.AgentCommands.sketch).toMatch(/\S/)
    }
    expect(en.AgentCommands.sketch).toBe('Agent: Sketch')
    expect(new Set([en, de, es, fr].map((w) => (w as { AgentCommands: Record<string, string> }).AgentCommands.sketch)).size).toBe(4)
  })
})

describe('WO-3013 model.sketch.create T5 refusals in plain words, only for what cannot be done', () => {
  it('a plane that does not exist, a face plane, a degenerate profile: each one sentence, nothing changes', async () => {
    const { session: s } = openModel()
    s.dag.insertNode({ id: 'datum:FACE1', kind: 'datum', consumes: [], payload: { datumType: 'plane', planeKind: 'face-plane', flipNormal: false, xDirHint: { kind: 'projected-model-x' } } })
    const before = fingerprint(s)
    const cases: Array<[unknown, string, string]> = [
      [{ plane: 'AB', profiles: [RECT_40_20] }, 'missing-target', 'There is no plane "AB" in this model. Use XY, XZ or YZ, or the id of a plane from model.summary.'],
      [{ plane: 'F1', profiles: [RECT_40_20] }, 'missing-target', 'There is no plane "F1" in this model. Use XY, XZ or YZ, or the id of a plane from model.summary.'],
      [{ plane: 'datum:FACE1', profiles: [RECT_40_20] }, 'refused', 'The plane "datum:FACE1" has no resolved position yet, so a sketch cannot be placed on it. Rebuild the model or fix that plane first.'],
      [{ plane: 'origin', profiles: [RECT_40_20] }, 'refused', '"origin" is not a plane that can hold a sketch right now. Use XY, XZ or YZ, or the id of a plane from model.summary.'],
      [{ plane: 'XY', profiles: [] }, 'refused', 'A sketch needs at least one profile. Send a rectangle, a circle or a closed polyline.'],
      [{ plane: 'XY', profiles: [{ kind: 'rectangle', corner: { x: 0, y: 0 }, width: 0, height: 5 }] }, 'refused', 'A rectangle needs a width and a height that are not zero.'],
      [{ plane: 'XY', profiles: [{ kind: 'rectangle', corner: { x: 0, y: 0 }, width: 5 }] }, 'invalid-arguments', 'A rectangle needs a corner {x, y} and a width and height in mm.'],
      [{ plane: 'XY', profiles: [{ kind: 'circle', center: { x: 0, y: 0 }, radius: 0 }] }, 'refused', 'A circle needs a radius greater than zero.'],
      [{ plane: 'XY', profiles: [{ kind: 'circle', radius: 3 }] }, 'invalid-arguments', 'A circle needs a center {x, y} and a radius in mm.'],
      [{ plane: 'XY', profiles: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] }, 'invalid-arguments', 'A polyline needs at least three points {x, y} in mm. The last point joins back to the first.'],
      [{ plane: 'XY', profiles: [{ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }] }] }, 'refused', 'Points 2 and 3 of the polyline are the same place. Each point has to be a different place from the one before it.'],
    ]
    for (const [args, code, message] of cases) {
      expect(await create(args), JSON.stringify(args)).toMatchObject({ ok: false, code, message })
    }
    expect(fingerprint(s)).toEqual(before)
  })

  it('an offset plane that resolved takes a sketch; one that failed to rebuild is refused', async () => {
    const { session: s } = openModel()
    s.dag.insertNode({
      id: 'datum:OP1', kind: 'datum', consumes: ['datum:XY'],
      payload: {
        datumType: 'plane', planeKind: 'offset-plane', payloadSchema: 1, name: 'Offset 1',
        definition: { kind: 'offset', distance: 10, flipNormal: false },
        lastGoodFrame: { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
      },
    })
    const r = ok(await create({ plane: 'datum:OP1', profiles: [RECT_40_20] }))
    expect(r.value.plane).toBe('datum:OP1')
    expect(s.dag.getNode(r.value.sketchId)!.consumes).toEqual(['datum:OP1'])
    expect(s.dag.getNode(r.value.sketchId)!.payload.name).toBeUndefined()

    s.dag.setPayload('datum:OP1', { ...s.dag.getNode('datum:OP1')!.payload, lastGoodFrame: { origin: { x: 0, y: 0, z: Number.NaN }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } } })
    expect(await create({ plane: 'datum:OP1', profiles: [RECT_40_20] })).toMatchObject({ ok: false, code: 'refused' })
  })

  it('a sketch the sketcher would keep without a profile is kept: an open-looking overlap still saves, regionCount reports it', async () => {
    // Two profiles that cross each other are not a refusal -- the sketcher keeps them and the
    // extrude takes the regions the arrangement finds.
    const { session: s } = openModel()
    const r = ok(await create({ plane: 'XY', profiles: [RECT_40_20, { kind: 'rectangle', corner: { x: 30, y: 10 }, width: 30, height: 20 }] }))
    expect(r.value.regionCount).toBeGreaterThanOrEqual(2)
    expect(s.dag.has(r.value.sketchId)).toBe(true)
  })
})

describe('WO-3013 model.sketch.create T2b sketch on a body face (the page route: openPackageSketchOnFace)', () => {
  /** A 40 x 20 x 10 box through the agent commands, and its top face id from model.summary. */
  async function box(modelItemId: string): Promise<{ o: Opened; top: string; side: string }> {
    const o = openModel(modelItemId)
    ok(await create({ plane: 'XY', profiles: [RECT_40_20] }, { modelItemId }))
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }, { modelItemId }))
    const summary = ok(await modelCommands.run('model.summary', undefined, { modelItemId }))
    const faces = summary.value.bodies[0].planarFaces as Array<{ id: string; normal: { z: number } }>
    expect(faces).toHaveLength(6)
    return { o, top: faces.find((f) => f.normal.z > 0.9)!.id, side: faces[2].id }
  }
  const FACE_RECT = { kind: 'rectangle', corner: { x: -5, y: -5 }, width: 10, height: 10 }

  it('model.summary lists each body\'s flat faces, so an agent can name one', async () => {
    const { top } = await box('item-A')
    expect(top).toBe('F1:XTR:SK1:capEnd')
  })

  it('a rectangle on the top face, extruded, equals the page route: same DAG bytes (datum + sketch + extrude) and the same volume', async () => {
    const { o: agent, top } = await box('item-A')
    const made = ok(await create({ face: { bodyId: 'F1', faceId: top }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' }))
    expect(made.step).toBe('Agent: Sketch')
    expect(made.value.sketchId).toBe('sketch3d:SK2')
    expect(made.value.plane).toBe('datum:SK2')
    expect(made.value.regionCount).toBe(1)
    expect(made.changed).toEqual({ created: ['datum:SK2', 'sketch3d:SK2'], edited: [], removed: [] })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK2', distance: 5 }, { modelItemId: 'item-A' }))
    expect(await volumeOf(agent, 'F2')).toBeCloseTo(500, 3)

    // Dependency ancestry is not body membership: F2 sits on F1's top face but is its own body, so the summary
    // gives F2 only F2's flat faces (bottom Z10, top Z15, no Z0) and leaves F1's list as it was.
    const after = ok(await modelCommands.run('model.summary', undefined, { modelItemId: 'item-A' }))
    const zOf = (b: { planarFaces: Array<{ centroid: { z: number } }> }) => b.planarFaces.map((f) => Math.round(f.centroid.z * 1000) / 1000)
    const f1 = after.value.bodies.find((b: { id: string }) => b.id === 'F1')
    const f2 = after.value.bodies.find((b: { id: string }) => b.id === 'F2')
    expect(f1.planarFaces).toHaveLength(6)
    expect(f1.planarFaces.every((f: { id: string }) => f.id.startsWith('F1:'))).toBe(true)
    expect(f2.planarFaces.every((f: { id: string }) => f.id.startsWith('F2:'))).toBe(true)
    expect(f2.planarFaces).toHaveLength(6)
    expect(zOf(f2)).toContain(10)
    expect(zOf(f2)).toContain(15)
    expect(zOf(f2)).not.toContain(0)

    // The page's route, by hand: probe the face datum, then insert datum + sketch as ONE step (openPackageSketchOnFace + beginPackageSketch).
    const page = await box('item-B')
    const built = buildFacePlaneDatumNodeInput({ id: 'SK2', ownerId: 'F1', faceId: top })
    const sketchNode = {
      id: 'sketch3d:SK2', kind: 'sketch' as const, consumes: [built.nodeId], refs: [],
      payload: { ...agent.session.dag.getNode('sketch3d:SK2')!.payload },
    }
    delete (sketchNode.payload as Record<string, unknown>).regions
    page.o.session.history.execute(new CompositeCommand([createFeatureCommand(page.o.session.dag, built.input), createFeatureCommand(page.o.session.dag, sketchNode)], 'sketchOnFace'))
    page.o.session.touchedPast.current.push([built.nodeId, 'sketch3d:SK2'])
    for (const id of [built.nodeId, 'sketch3d:SK2']) page.o.session.scheduler.markDirty(id)
    await page.o.session.scheduler.run(page.o.session.params.executor)
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK2', distance: 5 }, { modelItemId: 'item-B' }))
    expect(await volumeOf(page.o, 'F2')).toBeCloseTo(await volumeOf(agent, 'F2'), 6)
    expect(stableStringify(JSON.parse(agent.session.dag.serialize()))).toBe(stableStringify(JSON.parse(page.o.session.dag.serialize())))
  })

  it('a Join extrude from a face sketch merges into F1: the merged body reports F1\'s faces and its own', async () => {
    const { top } = await box('item-A')
    ok(await create({ face: { bodyId: 'F1', faceId: top }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' }))
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK2', distance: 5, operation: 'add', targetFeatureId: 'F1' }, { modelItemId: 'item-A' }))
    const summary = ok(await modelCommands.run('model.summary', undefined, { modelItemId: 'item-A' }))
    expect(summary.value.bodies).toHaveLength(1)
    const ids = summary.value.bodies[0].planarFaces.map((f: { id: string }) => f.id.split(':')[0])
    expect(ids).toContain('F1')
    expect(ids).toContain('F2')
    expect(summary.value.bodies[0].planarFaces.some((f: { centroid: { z: number } }) => Math.abs(f.centroid.z) < 1e-6)).toBe(true)
  })

  it('the face datum an earlier face sketch made takes another sketch by its plane id, and one Undo takes the datum and the sketch together', async () => {
    const { o, top } = await box('item-A')
    ok(await create({ face: { bodyId: 'F1', faceId: top }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' }))
    const depth = o.session.history.size()
    const again = ok(await create({ plane: 'datum:SK2', profiles: [{ kind: 'circle', center: { x: 0, y: 0 }, radius: 3 }] }, { modelItemId: 'item-A' }))
    expect(again.value.plane).toBe('datum:SK2')
    expect(o.session.dag.getNode(again.value.sketchId)!.consumes).toEqual(['datum:SK2'])
    expect(o.session.history.size()).toBe(depth + 1)
    ok(await modelCommands.run('model.undo', undefined, { modelItemId: 'item-A' }))
    ok(await modelCommands.run('model.undo', undefined, { modelItemId: 'item-A' }))
    expect(o.session.dag.has('datum:SK2')).toBe(false)
    expect(o.session.dag.has('sketch3d:SK2')).toBe(false)
    expect(o.session.dag.has('F1')).toBe(true)
  })

  it('a face that is not flat, a face or body that does not exist, and a call with both or neither place: one plain sentence each, nothing changes', async () => {
    const { o } = await box('item-A')
    // A cylinder has a side face that is not flat.
    ok(await create({ plane: 'XZ', profiles: [{ kind: 'circle', center: { x: 0, y: 0 }, radius: 4 }] }, { modelItemId: 'item-A' }))
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK2', distance: 6 }, { modelItemId: 'item-A' }))
    const curved = [...o.map.liveIds()].find((id) => o.map.snapshotOf(id)?.surfaceType === 'cylinder')!
    expect(curved).toBeDefined()
    const before = fingerprint(o.session)
    const nonFlat = await create({ face: { bodyId: 'F2', faceId: curved }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' })
    expect(nonFlat).toMatchObject({ ok: false, code: 'refused', path: '$.face.faceId' })
    expect((nonFlat as { message: string }).message).toMatch(/is not flat, so a sketch cannot start on it/)
    expect(await create({ face: { bodyId: 'F1', faceId: 'F9:nope' }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' })).toMatchObject({ ok: false, code: 'missing-target', path: '$.face.faceId' })
    expect(await create({ face: { bodyId: 'F7', faceId: 'F1:XTR:SK1:capEnd' }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' })).toMatchObject({ ok: false, code: 'missing-target', path: '$.face.bodyId' })
    expect(await create({ plane: 'XY', face: { bodyId: 'F1', faceId: 'F1:XTR:SK1:capEnd' }, profiles: [FACE_RECT] }, { modelItemId: 'item-A' })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await create({ profiles: [FACE_RECT] }, { modelItemId: 'item-A' })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(fingerprint(o.session)).toEqual(before)
  })
})

describe('WO-3013 model.sketch.create T7 shared Undo, and the journey', () => {
  it('summary of an empty model, sketch, extrude, summary, then Undo twice restores the empty model', async () => {
    const { session: s } = openModel()
    const empty = fingerprint(s)
    const first = ok(await modelCommands.run('model.summary'))
    expect(first.value.bodies).toEqual([])
    ok(await create({ plane: 'XY', profiles: [RECT_40_20] }))
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    const built = ok(await modelCommands.run('model.summary'))
    expect(built.value.items.filter((i: { builtIn: boolean }) => !i.builtIn).map((i: { id: string; opType?: string; profileCount?: number }) => [i.id, i.opType ?? null, i.profileCount ?? null])).toEqual([
      ['sketch3d:SK1', null, 1],
      ['F1', 'extrude', null],
    ])
    expect(built.value.bodies.map((b: { id: string; name: string }) => [b.id, b.name])).toEqual([['F1', 'Extrude F1']])
    expect(ok(await modelCommands.run('model.undo')).value).toEqual({ undone: 'Agent: Extrude' })
    expect(ok(await modelCommands.run('model.undo')).value).toEqual({ undone: 'Agent: Sketch' })
    // The model is the empty one again: same nodes, same payloads, no history (the revision counter only counts up).
    expect({ dag: fingerprint(s).dag, depth: fingerprint(s).depth }).toEqual({ dag: empty.dag, depth: empty.depth })
    expect(ok(await modelCommands.run('model.redo')).value).toEqual({ redone: 'Agent: Sketch' })
    expect(s.dag.has('sketch3d:SK1')).toBe(true)
    await s.undo() // the Undo button's path
    expect(s.dag.has('sketch3d:SK1')).toBe(false)
  })
})

describe('WO-3013 model.sketch.create T8 replay and revision', () => {
  it('a repeated requestId returns the first result and adds nothing; a stale expectRevision refuses', async () => {
    const { session: s } = openModel()
    const first = ok(await create({ plane: 'XY', profiles: [RECT_40_20] }, { requestId: 'r1' }))
    const depth = s.history.size()
    expect(await create({ plane: 'XY', profiles: [RECT_40_20] }, { requestId: 'r1' })).toBe(first)
    expect(s.history.size()).toBe(depth)
    expect(await create({ plane: 'XY', profiles: [RECT_40_20] }, { expectRevision: s.revision() - 1 })).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(s.history.size()).toBe(depth)
    const current = ok(await create({ plane: 'XZ', profiles: [RECT_40_20] }, { expectRevision: s.revision() }))
    expect(current.revision).toBe(s.revision())
  })
})

describe('WO-3013 model.sketch.create T9 boundary and output schema', () => {
  it('is in the frozen allow-list and tools list, describes its schema, and results are frozen copies', async () => {
    expect(Object.isFrozen(MODEL_COMMAND_ALLOW_LIST)).toBe(true)
    expect(MODEL_COMMAND_ALLOW_LIST).toContain('model.sketch.create')
    expect(modelCommands.list().find((c) => c.id === 'model.sketch.create')).toEqual({ id: 'model.sketch.create', effect: 'edit' })
    expect(modelCommands.describe('model.sketch.create')?.input).toMatchObject({ required: ['profiles'], additionalProperties: false })
    const { session: s } = openModel()
    const r = ok(await create({ plane: 'XY', profiles: [RECT_40_20] }))
    expect(Object.isFrozen(r)).toBe(true)
    expect(() => { (r.value as { sketchId: string }).sketchId = 'X' }).toThrow()
    expect(s.dag.has('sketch3d:SK1')).toBe(true)
  })

  it('the result satisfies the declared output schema, with and without a kernel that builds regions', async () => {
    const schema = modelCommands.describe('model.sketch.create')?.output as JsonSchema
    openModel()
    const real = ok(await create({ plane: 'XY', profiles: [RECT_40_20, { kind: 'circle', center: { x: 1, y: 1 }, radius: 1 }] }))
    expect(firstSchemaProblem(schema, real.value)).toBeUndefined()
    resetDocumentHolder()
    openModel(LEGACY_MODEL_ITEM_ID, false)
    const stub = ok(await create({ plane: 'XY', profiles: [RECT_40_20] }))
    expect(stub.value.regionCount).toBe(0)
    expect(firstSchemaProblem(schema, stub.value)).toBeUndefined()
  })
})
