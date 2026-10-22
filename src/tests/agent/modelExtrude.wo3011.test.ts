// WO-3011: model.extrude on a real ModelSession. T1-T9 of docs/design/WO-2951-modeling-mcp.md
// "Test protocol", for the first feature command.
//
// The reference for "what the dialog does" is the dialog's own Apply: one feature node
// through createFeatureCommand with the payload ExtrudeDialog.handleApply writes (create
// mode, :539-558), and the refusal words come from the same buildExtrudeRequest the page's
// kernel op calls. The session's kernel op is a plain "ok" stub: the DAG, the history and
// the scheduler are real.

import { afterEach, describe, expect, it } from 'vitest'
import { ElementMap, FeatureDag, createModelSession, type ModelSession } from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { createDocumentArchive, stableStringify } from '../../doc/persist'
import { createFeatureCommand } from '../../components/model3d/dialogs/createFeatureCommand'
import { textFor } from '../../i18n'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'

const workbenchText = textFor('sketch-and-model-workbench')

function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID): ModelSession {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
  dag.insertNode({ id: 'SK2', kind: 'sketch', payload: { name: 'Empty', regions: [] } })
  const s = createModelSession({ modelItemId, dag, map: new ElementMap(), kernelOp: async () => ({ ok: true, diagnostics: [] }) })
  registerModelSession(s)
  return s
}

afterEach(() => resetDocumentHolder())

function extrude(args: unknown, options = {}): Promise<ModelCommandResult> {
  return modelCommands.run('model.extrude', args, options)
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

/** The dialog's Apply, create mode (ExtrudeDialog.tsx handleApply): the payload it writes. */
function dialogApply(s: ModelSession, p: { sketchId: string; distance: number; direction?: string; boolMode?: string; targetFeatureId?: string }): string {
  const id = 'F' + (s.dag.nodeIds().filter((n) => /^F\d+$/.test(n)).length + 1)
  const direction = p.direction ?? 'up'
  const boolMode = p.boolMode ?? 'newBody'
  const payload = {
    opType: 'extrude',
    sketchId: p.sketchId,
    distance: p.distance,
    direction,
    endCondition: direction === 'midplane' ? 'symmetric' : 'blind',
    boolMode,
    ...(boolMode !== 'newBody' ? { targetFeatureId: p.targetFeatureId } : {}),
    name: workbenchText('ExtrudeDialog.extrude2', { id }),
  }
  const consumes = [...new Set([p.sketchId, ...(boolMode !== 'newBody' && p.targetFeatureId !== undefined ? [p.targetFeatureId] : [])])]
  s.history.execute(createFeatureCommand(s.dag, { id, kind: 'feature', consumes, payload }))
  return id
}

describe('WO-3011 model.extrude T1 schema refusals', () => {
  it('missing sketchId, unknown key, wrong type, bad enum: each refused with its code and nothing changed', async () => {
    const s = openModel()
    ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    const before = fingerprint(s)
    expect(await extrude({ distance: 10 })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.sketchId' })
    expect(await extrude({ sketchId: 'SK1' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.distance' })
    expect(await extrude({ sketchId: 'SK1', distance: 10, colour: 'red' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.colour' })
    expect(await extrude({ sketchId: 'SK1', distance: '10' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.distance' })
    expect(await extrude({ sketchId: 'SK1', distance: 10, direction: 'sideways' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.direction' })
    expect(await extrude({ sketchId: 'SK1', distance: 10, operation: 'cut' })).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.operation' })
    expect(await extrude('SK1')).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$' })
    expect(fingerprint(s)).toEqual(before)
  })

  it('with no Model page mounted: one plain sentence, nothing thrown', async () => {
    resetDocumentHolder()
    const result = await extrude({ sketchId: 'SK1', distance: 10 })
    expect(result).toMatchObject({ ok: false, code: 'no-model-open' })
  })
})

describe('WO-3011 model.extrude T2 same path as the dialog', () => {
  const cases: Array<[string, { sketchId: string; distance: number; direction?: string; operation?: string; targetFeatureId?: string }]> = [
    ['new body up', { sketchId: 'SK1', distance: 12 }],
    ['new body down', { sketchId: 'SK1', distance: 7.5, direction: 'down' }],
    ['new body midplane', { sketchId: 'SK1', distance: 20, direction: 'midplane' }],
  ]
  for (const [name, args] of cases) {
    it(`${name}: the DAG bytes and statuses equal the dialog's Apply on the same document`, async () => {
      const dialog = openModel('item-A')
      const id = dialogApply(dialog, { sketchId: args.sketchId, distance: args.distance, direction: args.direction })
      dialog.scheduler.markDirty(id) // the page's fullResync after Apply
      await dialog.scheduler.run(dialog.params.executor)
      const agent = openModel('item-B')
      const result = ok(await extrude(args, { modelItemId: 'item-B' }))
      expect(result.value).toMatchObject({ featureId: 'F1', status: 'ok', diagnostics: [] })
      expect(stableStringify(JSON.parse(agent.dag.serialize()))).toBe(stableStringify(JSON.parse(dialog.dag.serialize())))
      expect(agent.dag.nodeIds().map((id) => `${id}:${agent.scheduler.statusOf(id)}`)).toEqual(
        dialog.dag.nodeIds().map((id) => `${id}:${dialog.scheduler.statusOf(id)}`),
      )
    })
  }

  it('Add / Remove / Intersect on a live body equal the dialog, and consume the target', async () => {
    for (const operation of ['add', 'remove', 'intersect'] as const) {
      const dialog = openModel('item-A')
      dialog.scheduler.markDirty(dialogApply(dialog, { sketchId: 'SK1', distance: 10 }))
      await dialog.scheduler.run(dialog.params.executor)
      dialogApply(dialog, { sketchId: 'SK1', distance: 4, boolMode: operation, targetFeatureId: 'F1' })
      const agent = openModel('item-B')
      ok(await extrude({ sketchId: 'SK1', distance: 10 }, { modelItemId: 'item-B' }))
      const second = ok(await extrude({ sketchId: 'SK1', distance: 4, operation, targetFeatureId: 'F1' }, { modelItemId: 'item-B' }))
      expect(second.value.featureId).toBe('F2')
      expect(agent.dag.getNode('F2')?.consumes).toEqual(['SK1', 'F1'])
      expect(stableStringify(JSON.parse(agent.dag.serialize())), operation).toBe(stableStringify(JSON.parse(dialog.dag.serialize())))
    }
  })
})

describe('WO-3011 model.extrude T3 determinism', () => {
  async function script(): Promise<{ results: string[]; archive: string }> {
    const s = openModel()
    const results: string[] = []
    results.push(JSON.stringify(await extrude({ sketchId: 'SK1', distance: 10 })))
    results.push(JSON.stringify(await extrude({ sketchId: 'SK1', distance: 3, operation: 'remove', targetFeatureId: 'F1', direction: 'down' })))
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
    expect(first.results.join('\n')).not.toMatch(/\b1[67]\d{11}\b/)
  })
})

describe('WO-3011 model.extrude T4 one call, one step', () => {
  it('each call adds one "Agent: Extrude" step; Undo removes the node; a refused call adds none', async () => {
    const s = openModel()
    const a = ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    const b = ok(await extrude({ sketchId: 'SK1', distance: 5, operation: 'add', targetFeatureId: 'F1' }))
    expect(s.history.size()).toBe(2)
    expect(a.step).toBe('Agent: Extrude')
    expect(b.step).toBe('Agent: Extrude')
    expect(a.changed).toEqual({ created: ['F1'], edited: [], removed: [] })
    expect(s.history.lastAppliedCommand()?.label).toBe('Agent: Extrude')

    expect((await extrude({ sketchId: 'SK1', distance: 0 })).ok).toBe(false)
    expect(s.history.size()).toBe(2)

    await s.undo()
    expect(s.dag.has('F2')).toBe(false)
    expect(s.dag.has('F1')).toBe(true)
    await s.undo()
    expect(s.dag.has('F1')).toBe(false)
    expect(s.history.size()).toBe(0)
  })

  it('the step label is localised in all four locales', async () => {
    const { default: de } = await import('../../i18n/locales/de/sketch-and-model-workbench')
    const { default: es } = await import('../../i18n/locales/es/sketch-and-model-workbench')
    const { default: fr } = await import('../../i18n/locales/fr/sketch-and-model-workbench')
    const { default: en } = await import('../../i18n/locales/en/sketch-and-model-workbench')
    for (const words of [en, de, es, fr] as Array<{ AgentCommands: Record<string, string> }>) {
      expect(words.AgentCommands.extrude).toMatch(/\S/)
      expect(words.AgentCommands.deleteFeature).toMatch(/\S/)
    }
    expect(en.AgentCommands.extrude).toBe('Agent: Extrude')
  })
})

describe('WO-3011 model.extrude T5 the dialog\'s words', () => {
  it('a distance, a target or a sketch the dialog would refuse is refused with its words and nothing changes', async () => {
    const s = openModel()
    ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    ok(await extrude({ sketchId: 'SK1', distance: 4, operation: 'add', targetFeatureId: 'F1' }))
    const before = fingerprint(s)
    const refusals: Array<[unknown, string]> = [
      [{ sketchId: 'SK1', distance: 0 }, workbenchText('extrudeParams.extrudeDistanceMustBeAPositiveMagnitudeGotUse', { distance: '0' })],
      [{ sketchId: 'SK1', distance: -3 }, workbenchText('extrudeParams.extrudeDistanceMustBeAPositiveMagnitudeGotUse', { distance: '-3' })],
      [{ sketchId: 'SK1', distance: 5, operation: 'add' }, workbenchText('extrudeParams.extrudeRequiresATargetBody', { rawMode: 'add' })],
      // F1 is consumed by F2, so it is no longer a live body.
      [{ sketchId: 'SK1', distance: 5, operation: 'remove', targetFeatureId: 'F1' }, workbenchText('extrudeParams.extrudeTargetHasNoLiveBodyMissingOrAlready2', { rawMode: 'remove', currentTargetId: 'F1' })],
      [{ sketchId: 'SK1', distance: 5, operation: 'intersect', targetFeatureId: 'nope' }, workbenchText('extrudeParams.extrudeTargetHasNoLiveBodyMissingOrAlready2', { rawMode: 'intersect', currentTargetId: 'nope' })],
      [{ sketchId: 'SK2', distance: 5 }, workbenchText('regionSelector.thisSketchNoLongerHasAClosedProfile')],
    ]
    for (const [args, message] of refusals) {
      const result = await extrude(args)
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code: 'refused', message })
    }
    expect(await extrude({ sketchId: 'SK9', distance: 5 })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(await extrude({ sketchId: 'F1', distance: 5 })).toMatchObject({ ok: false, code: 'missing-target' })
    expect(fingerprint(s)).toEqual(before)
  })
})

describe('WO-3011 model.extrude T6 rule 11: a stray target on New body is ignored', () => {
  it('New body with a targetFeatureId commits as New body, exactly as the dialog does', async () => {
    const s = openModel()
    const r = ok(await extrude({ sketchId: 'SK1', distance: 6, targetFeatureId: 'whatever' }))
    expect(r.value.featureId).toBe('F1')
    expect(s.dag.getNode('F1')?.payload.targetFeatureId).toBeUndefined()
    expect(s.dag.getNode('F1')?.consumes).toEqual(['SK1'])
  })

  it('a kernel failure at rebuild is a result, not a refusal: the node stays, reports status and diagnostics, and undoes', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
    const s = createModelSession({
      modelItemId: LEGACY_MODEL_ITEM_ID,
      dag,
      map: new ElementMap(),
      kernelOp: async () => ({ ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason: 'self-intersecting profile' } }] }),
    })
    registerModelSession(s)
    const r = ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    expect(r.value.status).toBe('failed')
    expect(r.value.diagnostics).toEqual([{ code: 'KERNEL_OP_FAILED', message: 'KERNEL_OP_FAILED: op=extrude, reason=self-intersecting profile' }])
    ok(await modelCommands.run('model.undo'))
    expect(s.dag.has('F1')).toBe(false)
  })
})

describe('WO-3011 model.extrude T7 shared Undo', () => {
  it('model.undo / model.redo and the screen Undo step the extrude on one history', async () => {
    const s = openModel()
    ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    const undone = ok(await modelCommands.run('model.undo'))
    expect(undone.value).toEqual({ undone: 'Agent: Extrude' })
    expect(s.dag.has('F1')).toBe(false)
    ok(await modelCommands.run('model.redo'))
    expect(s.dag.has('F1')).toBe(true)
    await s.undo() // the Undo button's path
    expect(s.dag.has('F1')).toBe(false)
  })
})

describe('WO-3011 model.extrude T8 replay and revision', () => {
  it('a repeated requestId returns the first result and adds nothing; a stale expectRevision refuses', async () => {
    const s = openModel()
    const first = ok(await extrude({ sketchId: 'SK1', distance: 10 }, { requestId: 'r1' }))
    const depth = s.history.size()
    expect(await extrude({ sketchId: 'SK1', distance: 10 }, { requestId: 'r1' })).toBe(first)
    expect(s.history.size()).toBe(depth)
    const stale = await extrude({ sketchId: 'SK1', distance: 10 }, { expectRevision: s.revision() - 1 })
    expect(stale).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(s.history.size()).toBe(depth)
    const current = ok(await extrude({ sketchId: 'SK1', distance: 2 }, { expectRevision: s.revision() }))
    expect(current.revision).toBe(s.revision())
  })
})

describe('WO-3011 model.extrude T9 boundary', () => {
  it('is in the frozen allow-list and tools list, describes its schema, and results are frozen copies', async () => {
    expect(Object.isFrozen(MODEL_COMMAND_ALLOW_LIST)).toBe(true)
    expect(MODEL_COMMAND_ALLOW_LIST).toContain('model.extrude')
    expect(modelCommands.list().map((c) => c.id)).toContain('model.extrude')
    expect(modelCommands.describe('model.extrude')?.input).toMatchObject({ required: ['sketchId', 'distance'], additionalProperties: false })
    const s = openModel()
    const r = ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    expect(Object.isFrozen(r)).toBe(true)
    expect(() => { (r.value as { featureId: string }).featureId = 'X' }).toThrow()
    expect(s.dag.has('F1')).toBe(true)
  })
})

describe('WO-3011 model.extrude output schema', () => {
  it('a success and a failed-rebuild result with diagnostics both satisfy the declared output schema', async () => {
    const schema = modelCommands.describe('model.extrude')?.output as JsonSchema
    openModel()
    const good = ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    expect(firstSchemaProblem(schema, good.value)).toBeUndefined()
    expect(good.value.diagnostics).toEqual([])
    resetDocumentHolder()
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
    registerModelSession(createModelSession({
      modelItemId: LEGACY_MODEL_ITEM_ID, dag, map: new ElementMap(),
      kernelOp: async () => ({ ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason: 'bad profile' } }] }),
    }))
    const failed = ok(await extrude({ sketchId: 'SK1', distance: 10 }))
    expect(failed.value.status).toBe('failed')
    expect(failed.value.diagnostics.length).toBeGreaterThan(0)
    expect(firstSchemaProblem(schema, failed.value)).toBeUndefined()
  })
})
