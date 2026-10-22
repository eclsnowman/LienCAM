// WO-3013: model.summary on a real ModelSession. T1-T9 of docs/design/WO-2951-modeling-mcp.md
// "Test protocol" for a read command.
//
// The reference for "what the screen shows" is the Design tree's rows (the DAG's feature order,
// the names featureLabel gives them, the scheduler's status) and the Bodies list (the page's own
// census: bodyFeatureIds -> liveBodyFeatureIds -> projectBodyLineages). The session's kernel op
// is a plain "ok" stub: the DAG, the history and the scheduler are real.

import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession, type ModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { stableStringify } from '../../doc/persist'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { setBodyFacts } from '../../lib/agent/model/summary'
import { firstSchemaProblem, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'

function openModel(kernelOp?: Parameters<typeof createModelSession>[0]['kernelOp']): ModelSession {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const s = createModelSession({
    modelItemId: LEGACY_MODEL_ITEM_ID,
    dag,
    map: new ElementMap(),
    kernelOp: kernelOp ?? (async () => ({ ok: true, diagnostics: [] })),
  })
  registerModelSession(s)
  return s
}

afterEach(() => resetDocumentHolder())

const summary = (args?: unknown, options = {}): Promise<ModelCommandResult> => modelCommands.run('model.summary', args, options)

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

describe('WO-3013 model.summary T1 schema', () => {
  it('an argument is refused, and with no Model page mounted it is one plain sentence', async () => {
    const s = openModel()
    const before = fingerprint(s)
    expect(await summary({ plane: 'XY' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.plane' })
    expect(await summary('x')).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$' })
    expect(fingerprint(s)).toEqual(before)
    resetDocumentHolder()
    expect(await summary()).toMatchObject({ ok: false, code: 'no-model-open' })
  })
})

describe('WO-3013 model.summary T2 the tree, the bodies, the parameters', () => {
  it('an empty model lists the origin and three base planes, no bodies, no parameters', async () => {
    const s = openModel()
    const r = ok(await summary())
    expect(r.value.items.map((i: { id: string }) => i.id)).toEqual(['origin', 'datum:XY', 'datum:XZ', 'datum:YZ'])
    expect(r.value.items.every((i: { id: string; builtIn: boolean; status: string }) => i.builtIn && i.status === s.scheduler.statusOf(i.id))).toBe(true)
    expect(r.value.items.map((i: { name: string }) => i.name)).toEqual(['Origin', 'XY', 'XZ', 'YZ'])
    expect(r.value.bodies).toEqual([])
    expect(r.value.parameters).toEqual([])
    expect(r.step).toBeNull()
  })

  it('lists a sketch, its extrude, the body and a parameter, in tree order with the screen\'s names and statuses', async () => {
    const s = openModel()
    ok(await modelCommands.run('model.parameter.set', { name: 'w', expression: '5' }))
    s.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { name: 'Sketch on XY', planeNodeId: 'datum:XY', sketch: {}, regions: [{ sketchId: 'SK1', loops: [] }] } })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    const r = ok(await summary())
    const rows = r.value.items.filter((i: { builtIn: boolean }) => !i.builtIn)
    expect(rows).toEqual([
      { id: 'sketch3d:SK1', kind: 'sketch', name: 'Sketch on XY', status: s.scheduler.statusOf('sketch3d:SK1'), suppressed: false, builtIn: false, consumes: ['datum:XY'], plane: 'datum:XY', profileCount: 1 },
      { id: 'F1', kind: 'feature', name: 'Extrude F1', opType: 'extrude', status: 'ok', suppressed: false, builtIn: false, consumes: ['sketch3d:SK1'] },
    ])
    expect(r.value.bodies).toEqual([{ id: 'F1', name: 'Extrude F1', planarFaces: [] }])
    expect(r.value.parameters).toEqual([{ name: 'w', expression: '5', value: 5, status: 'ok' }])
  })

  it('a suppressed or failed extrude has no body row, and says why in its row', async () => {
    const s = openModel()
    s.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { planeNodeId: 'datum:XY', sketch: {}, regions: [{ sketchId: 'SK1', loops: [] }] } })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    expect(ok(await summary()).value.bodies).toHaveLength(1)
    s.dag.setSuppressed('F1', true)
    const hidden = ok(await summary())
    expect(hidden.value.bodies).toEqual([])
    expect(hidden.value.items.find((i: { id: string }) => i.id === 'F1')).toMatchObject({ suppressed: true })
    s.dag.setSuppressed('F1', false)
    // Suppressing the sketch cascades: the extrude row reads suppressed and its body is gone, as in the tree.
    s.dag.setSuppressed('sketch3d:SK1', true)
    const cascaded = ok(await summary())
    expect(cascaded.value.items.find((i: { id: string }) => i.id === 'F1')).toMatchObject({ suppressed: true })
    expect(cascaded.value.bodies).toEqual([])
    s.dag.setSuppressed('sketch3d:SK1', false)

    resetDocumentHolder()
    const failing = openModel(async (node) => (node.kind === 'feature'
      ? { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason: 'bad profile' } }] }
      : { ok: true, diagnostics: [] }))
    failing.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { planeNodeId: 'datum:XY', sketch: {}, regions: [{ sketchId: 'SK1', loops: [] }] } })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    const failed = ok(await summary())
    expect(failed.value.items.find((i: { id: string }) => i.id === 'F1')).toMatchObject({ status: 'failed' })
    expect(failed.value.bodies).toEqual([])
  })

  it('a body\'s volume appears when the page hands over what its Bodies list shows, and not before', async () => {
    const s = openModel()
    s.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { planeNodeId: 'datum:XY', sketch: {}, regions: [{ sketchId: 'SK1', loops: [] }] } })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    expect(ok(await summary()).value.bodies).toEqual([{ id: 'F1', name: 'Extrude F1', planarFaces: [] }])
    setBodyFacts(s, () => ({ F1: { volume: 8000 } }))
    expect(ok(await summary()).value.bodies).toEqual([{ id: 'F1', name: 'Extrude F1', volume: 8000, planarFaces: [] }])
    setBodyFacts(s, null)
    expect(ok(await summary()).value.bodies).toEqual([{ id: 'F1', name: 'Extrude F1', planarFaces: [] }])
  })
})

describe('WO-3013 model.summary T3-T4 determinism, and a read adds nothing', () => {
  it('two reads are byte-identical, the model is untouched, no history step and the same revision', async () => {
    const s = openModel()
    ok(await modelCommands.run('model.parameter.set', { name: 'w', expression: '5' }))
    const before = fingerprint(s)
    const a = ok(await summary())
    const b = ok(await summary())
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect(a.step).toBeNull()
    expect(a.changed).toEqual({ created: [], edited: [], removed: [] })
    expect(a.revision).toBe(before.revision)
    expect(fingerprint(s)).toEqual(before)
    expect(JSON.stringify(a)).not.toMatch(/\b1[67]\d{11}\b/)
  })
})

describe('WO-3013 model.summary T7-T9 replay, revision, boundary', () => {
  it('is in the frozen allow-list and tools list as a read, and its result is a frozen copy', async () => {
    expect(MODEL_COMMAND_ALLOW_LIST).toContain('model.summary')
    expect(modelCommands.list().find((c) => c.id === 'model.summary')).toEqual({ id: 'model.summary', effect: 'read' })
    const s = openModel()
    const r = ok(await summary())
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen(r.value.items)).toBe(true)
    expect(() => { (r.value.items as unknown[]).push(1) }).toThrow()
    expect(s.dag.nodeIds()).toHaveLength(4)
  })

  it('a stale expectRevision refuses the read too, a current one reads', async () => {
    const s = openModel()
    ok(await modelCommands.run('model.parameter.set', { name: 'w', expression: '5' }))
    expect(await summary({}, { expectRevision: s.revision() - 1 })).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(ok(await summary({}, { expectRevision: s.revision() })).revision).toBe(s.revision())
  })

  it('the result satisfies the declared output schema, on an empty model and on a full one', async () => {
    const schema = modelCommands.describe('model.summary')?.output as JsonSchema
    const s = openModel()
    expect(firstSchemaProblem(schema, ok(await summary()).value)).toBeUndefined()
    ok(await modelCommands.run('model.parameter.set', { name: 'w', expression: '5' }))
    s.dag.insertNode({ id: 'sketch3d:SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { planeNodeId: 'datum:XY', sketch: {}, regions: [{ sketchId: 'SK1', loops: [] }] } })
    ok(await modelCommands.run('model.extrude', { sketchId: 'sketch3d:SK1', distance: 10 }))
    setBodyFacts(s, () => ({ F1: { volume: 8000 } }))
    const full = ok(await summary())
    expect(full.value.items.length).toBeGreaterThan(5)
    expect(firstSchemaProblem(schema, full.value)).toBeUndefined()
  })
})
