// WO-3011: model.feature.delete on a real ModelSession. T1-T9 of docs/design/WO-2951-modeling-mcp.md
// "Test protocol". The reference is the tree's delete: planFeatureDelete (tree/featureDelete.ts)
// run as the page's handleDelete runs it -- one CompositeCommand of RemoveNodeCommand in
// removalOrder -- on a second session of the same document.

import { afterEach, describe, expect, it } from 'vitest'
import { CompositeCommand, ElementMap, FeatureDag, GENESIS_NODE_IDS, RemoveNodeCommand, createModelSession, type ModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { createDocumentArchive, stableStringify } from '../../doc/persist'
import { planFeatureDelete } from '../../components/model3d/tree'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { featureLabel } from '../../components/model3d/bodyLineage'
import { textFor } from '../../i18n'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'

const workbenchText = textFor('sketch-and-model-workbench')

/** SK1 -> F1 (extrude) -> F2 (add, consumes SK1 + F1) -> F3 (fillet-like, consumes F2), plus a face sketch on a private datum. */
function document(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', name: 'Extrude F1' } })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['SK1', 'F1'], payload: { opType: 'extrude', name: 'Extrude F2' } })
  dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'], payload: { opType: 'fillet', name: 'Fillet F3' } })
  dag.insertNode({ id: 'datum:SK2', kind: 'datum', consumes: ['F3'], payload: { datumType: 'plane', planeKind: 'face-plane' } })
  dag.insertNode({ id: 'sketch3d:SK2', kind: 'sketch', consumes: ['datum:SK2'], payload: { name: 'Face sketch', planeNodeId: 'datum:SK2', sketch: {} } })
  return dag
}

function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID, dag: FeatureDag = document()): ModelSession {
  const s = createModelSession({ modelItemId, dag, map: new ElementMap(), kernelOp: async () => ({ ok: true, diagnostics: [] }) })
  registerModelSession(s)
  return s
}

afterEach(() => resetDocumentHolder())

function del(featureId: unknown, options = {}): Promise<ModelCommandResult> {
  return modelCommands.run('model.feature.delete', { featureId }, options)
}

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

/** The tree's Delete, as SolidsWorkbenchPage.handleDelete runs it once the confirmation is answered. */
function treeDelete(s: ModelSession, id: string): string[] {
  const plan = planFeatureDelete(s.dag, id)
  if (!plan.ok) throw new Error('the tree refuses this delete')
  s.history.execute(new CompositeCommand(plan.removalOrder.map((nid) => new RemoveNodeCommand(nid)), 'deleteFeature'))
  return plan.removalOrder
}

describe('WO-3011 model.feature.delete T1 schema refusals', () => {
  it('missing featureId, unknown key, wrong type, unknown id: each refused with its code and nothing changed', async () => {
    const s = openModel()
    const before = fingerprint(s)
    expect(await modelCommands.run('model.feature.delete', {})).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.featureId' })
    expect(await modelCommands.run('model.feature.delete', { featureId: 'F1', cascade: true })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.cascade' })
    expect(await del(3)).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.featureId' })
    expect(await del('F99')).toMatchObject({ ok: false, code: 'missing-target' })
    expect(fingerprint(s)).toEqual(before)
    resetDocumentHolder()
    expect(await del('F1')).toMatchObject({ ok: false, code: 'no-model-open' })
  })
})

describe('WO-3011 model.feature.delete T2 same path as the tree', () => {
  it('a leaf, a middle feature (with dependents) and a sketch give the tree\'s DAG bytes, removal order and statuses', async () => {
    for (const id of ['F3', 'F2', 'F1', 'SK1']) {
      const tree = openModel('item-A')
      const expectedOrder = treeDelete(tree, id)
      const agent = openModel('item-B')
      const r = ok(await del(id, { modelItemId: 'item-B' }))
      expect(r.value.removed, id).toEqual(expectedOrder)
      expect(r.changed.removed, id).toEqual([...expectedOrder].sort())
      expect(stableStringify(JSON.parse(agent.dag.serialize())), id).toBe(stableStringify(JSON.parse(tree.dag.serialize())))
      expect(agent.dag.nodeIds().map((n) => `${n}:${agent.scheduler.statusOf(n)}`), id).toEqual(tree.dag.nodeIds().map((n) => `${n}:${tree.scheduler.statusOf(n)}`))
    }
  })

  it('a middle feature takes its dependents with it and the result names every removed id', async () => {
    const s = openModel()
    const r = ok(await del('F2'))
    for (const gone of ['F2', 'F3', 'datum:SK2', 'sketch3d:SK2']) expect(s.dag.has(gone)).toBe(false)
    expect(s.dag.has('F1')).toBe(true)
    expect(s.dag.has('SK1')).toBe(true)
    expect(new Set(r.value.removed)).toEqual(new Set(['F2', 'F3', 'datum:SK2', 'sketch3d:SK2']))
    expect(r.value.removed[r.value.removed.length - 1]).toBe('F2')
  })
})

describe('WO-3011 model.feature.delete T3 determinism', () => {
  async function script(): Promise<{ results: string[]; archive: string }> {
    const s = openModel()
    const results = [JSON.stringify(await del('F3')), JSON.stringify(await modelCommands.run('model.undo')), JSON.stringify(await del('F1'))]
    const archive = Buffer.from(createDocumentArchive({ dag: s.dag, elementMapDeltas: [] })).toString('base64')
    resetDocumentHolder()
    return { results, archive }
  }

  it('the same script on two fresh sessions gives byte-identical result JSON and archives', async () => {
    const first = await script()
    const second = await script()
    expect(second.results).toEqual(first.results)
    expect(second.archive).toBe(first.archive)
    expect(first.results.join('\n')).not.toMatch(/\b1[67]\d{11}\b/)
  })
})

describe('WO-3011 model.feature.delete T4 one call, one step', () => {
  it('a delete that removes five nodes is ONE "Agent: Delete" step; one Undo brings all of them back; a refused call adds none', async () => {
    const s = openModel()
    const before = fingerprint(s)
    const r = ok(await del('F1'))
    expect(r.step).toBe('Agent: Delete')
    expect(s.history.size()).toBe(before.depth + 1)
    expect(s.history.lastAppliedCommand()?.label).toBe('Agent: Delete')
    expect(s.dag.nodeIds().filter((n) => n !== 'SK1' && !GENESIS_NODE_IDS.includes(n))).toEqual([])

    expect(await del('F1')).toMatchObject({ ok: false, code: 'missing-target' })
    expect(s.history.size()).toBe(before.depth + 1)

    await s.undo()
    const after = fingerprint(s)
    expect(after.dag).toBe(before.dag)
    expect(after.depth).toBe(before.depth)
    expect(s.dag.featureOrder()).toEqual(openModel('scratch').dag.featureOrder())
  })
})

describe('WO-3011 model.feature.delete T5 the tree\'s words', () => {
  it('a face sketch whose reference plane another sketch still uses is refused with the tree\'s sentence', async () => {
    const dag = document()
    dag.insertNode({ id: 'sketch3d:SK3', kind: 'sketch', consumes: ['datum:SK2'], payload: { name: 'Other sketch', planeNodeId: 'datum:SK2', sketch: {} } })
    const s = openModel(LEGACY_MODEL_ITEM_ID, dag)
    const before = fingerprint(s)
    const plan = planFeatureDelete(s.dag, 'sketch3d:SK2')
    if (plan.ok) throw new Error('the tree must refuse this delete')
    const message = workbenchText('SolidsWorkbenchPage.cannotDeleteItsReferencePlaneIsStillUsedBy', {
      value1: String(featureLabel(s.dag, 'sketch3d:SK2')),
      value2: String(plan.retainedConsumerIds.map((id) => featureLabel(s.dag, id)).join(', ')),
    })
    expect(await del('sketch3d:SK2')).toMatchObject({ ok: false, code: 'refused', message })
    expect(fingerprint(s)).toEqual(before)
  })

  it('an origin item is refused in one plain sentence (the tree offers no Delete there)', async () => {
    const dag = new FeatureDag()
    seedGenesisNodes(dag) // what the Model page does on load
    const s = openModel(LEGACY_MODEL_ITEM_ID, dag)
    const origin = GENESIS_NODE_IDS.find((id) => s.dag.has(id))
    if (origin === undefined) throw new Error('a seeded document carries its origin items')
    const before = fingerprint(s)
    const r = await del(origin)
    expect(r).toMatchObject({ ok: false, code: 'refused' })
    if (r.ok) throw new Error('unreachable')
    expect(r.message).toMatch(/^[A-Z"].*[.]$/)
    expect(fingerprint(s)).toEqual(before)
  })
})

describe('WO-3011 model.feature.delete T6 rule 11: dependents are removed, not refused', () => {
  it('deleting a feature other features are built on commits (the tree does it after its confirmation) and says what went', async () => {
    const s = openModel()
    const r = ok(await del('SK1'))
    expect(r.value.removed).toEqual(expect.arrayContaining(['SK1', 'F1', 'F2', 'F3']))
    expect(r.changed.removed).toEqual([...r.value.removed].sort())
    ok(await modelCommands.run('model.undo'))
    expect(['SK1', 'F1', 'F2', 'F3'].every((id) => s.dag.has(id))).toBe(true)
  })
})

describe('WO-3011 model.feature.delete T7 shared Undo', () => {
  it('model.undo / model.redo and the screen Undo step the delete on one history', async () => {
    const s = openModel()
    ok(await del('F3'))
    expect(ok(await modelCommands.run('model.undo')).value).toEqual({ undone: 'Agent: Delete' })
    expect(s.dag.has('F3')).toBe(true)
    expect(ok(await modelCommands.run('model.redo')).value).toEqual({ redone: 'Agent: Delete' })
    expect(s.dag.has('F3')).toBe(false)
    await s.undo()
    expect(s.dag.has('F3')).toBe(true)
  })
})

describe('WO-3011 model.feature.delete T8 replay and revision', () => {
  it('a repeated requestId returns the first result and deletes nothing more; a stale expectRevision refuses', async () => {
    const s = openModel()
    const first = ok(await del('F3', { requestId: 'r1' }))
    const depth = s.history.size()
    expect(await del('F3', { requestId: 'r1' })).toBe(first)
    expect(s.history.size()).toBe(depth)
    const stale = await del('F2', { expectRevision: s.revision() - 1 })
    expect(stale).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(s.dag.has('F2')).toBe(true)
    expect(ok(await del('F2', { expectRevision: s.revision() })).revision).toBe(s.revision())
  })
})

describe('WO-3011 model.feature.delete T9 boundary', () => {
  it('is in the frozen allow-list and tools list, describes its schema, and the result is a frozen copy', async () => {
    expect(Object.isFrozen(MODEL_COMMAND_ALLOW_LIST)).toBe(true)
    expect(MODEL_COMMAND_ALLOW_LIST).toContain('model.feature.delete')
    expect(modelCommands.list().find((c) => c.id === 'model.feature.delete')).toEqual({ id: 'model.feature.delete', effect: 'edit' })
    expect(modelCommands.describe('model.feature.delete')?.input).toMatchObject({ required: ['featureId'], additionalProperties: false })
    const s = openModel()
    const r = ok(await del('F3'))
    expect(Object.isFrozen(r)).toBe(true)
    expect(() => { (r.value.removed as string[]).push('F1') }).toThrow()
    expect(s.dag.has('F1')).toBe(true)
  })
})

describe('WO-3011 model.feature.delete output schema', () => {
  it('the success value satisfies the declared output schema, for a leaf and for a cascade', async () => {
    const schema = modelCommands.describe('model.feature.delete')?.output as JsonSchema
    openModel()
    for (const id of ['F3', 'F1']) {
      const r = ok(await del(id))
      expect(firstSchemaProblem(schema, r.value), id).toBeUndefined()
      expect(r.value.removed.length).toBeGreaterThan(0)
    }
  })

  it('a delete whose rebuild leaves a dependent failed still returns a conforming value with its diagnostics in the envelope', async () => {
    const schema = modelCommands.describe('model.feature.delete')?.output as JsonSchema
    const dag = document()
    const s = createModelSession({
      modelItemId: LEGACY_MODEL_ITEM_ID, dag, map: new ElementMap(),
      kernelOp: async (node) => (node.id === 'SK1'
        ? { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { reason: 'bad sketch' } }] }
        : { ok: true, diagnostics: [] }),
    })
    registerModelSession(s)
    s.scheduler.markDirty('SK1')
    await s.scheduler.run(s.params.executor)
    const r = ok(await del('F3'))
    expect(firstSchemaProblem(schema, r.value)).toBeUndefined()
    expect(Array.isArray(r.diagnostics)).toBe(true)
  })
})
