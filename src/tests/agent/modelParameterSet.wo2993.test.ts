// WO-2993 (WO-2951 Order B): model.parameter.set on a real ModelSession.
//
// T1-T8 of docs/design/WO-2951-modeling-mcp.md "Test protocol". Everything runs
// on the real ModelSession, ParameterTable, CommandHistory and RegenScheduler
// (no mocks of src/doc). The kernel op is a plain "ok" stub: a parameter edit
// needs no OCCT, and a dependent FEATURE node only has to be rebuilt or degraded
// by the scheduler, which is what the statuses below read.
//
// Negative controls (rule 6) and their recorded outputs:
// src/tests/evidence/WO-2993/negative-controls.json.

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandHistory,
  ElementMap,
  FeatureDag,
  InsertNodeCommand,
  createModelSession,
  formatParamDiag,
  type ModelSession,
} from '../../doc'
import { LEGACY_MODEL_ITEM_ID, registerModelSession, resetDocumentHolder } from '../../doc/documentHolder'
import { createDocumentArchive, stableStringify } from '../../doc/persist'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { useFormStore } from '../../form/formStore'
import { MODEL_COMMAND_ALLOW_LIST, modelCommands } from '../../lib/agent/commands'
import { firstSchemaProblem, type JsonSchema } from '../../lib/agent/schema'
import type { ModelCommandResult, ModelCommandSuccess } from '../../lib/agent/registry'

function openModel(modelItemId: string = LEGACY_MODEL_ITEM_ID): ModelSession {
  const s = createModelSession({
    modelItemId,
    dag: new FeatureDag(),
    map: new ElementMap(),
    kernelOp: async () => ({ ok: true, diagnostics: [] }),
  })
  registerModelSession(s)
  return s
}

afterEach(() => {
  resetDocumentHolder()
  useFormStore.getState().closeSession()
})

/** A feature that consumes `param:<name>`, added to the model's history like a dialog Apply. */
async function addDependent(s: ModelSession, id: string, param: string): Promise<void> {
  await s.execute({
    label: `feature ${id}`,
    commands: [new InsertNodeCommand({ id, kind: 'feature', consumes: [`param:${param}`] })],
    touched: [id],
  })
}

function set(name: unknown, expression: unknown, options = {}): Promise<ModelCommandResult> {
  return modelCommands.run('model.parameter.set', { name, expression }, options)
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

describe('WO-2993 T1 schema refusals', () => {
  it('missing name, unknown key, number for expression, unknown command: each refused with its code and nothing changed', async () => {
    const s = openModel()
    ok(await set('width', '40'))
    const before = fingerprint(s)

    const missing = await modelCommands.run('model.parameter.set', { expression: '5' })
    expect(missing).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.name' })

    const unknownKey = await modelCommands.run('model.parameter.set', { name: 'a', expression: '5', colour: 'red' })
    expect(unknownKey).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.colour' })

    const wrongType = await modelCommands.run('model.parameter.set', { name: 'a', expression: 5 })
    expect(wrongType).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$.expression' })

    const notAnObject = await modelCommands.run('model.parameter.set', 'width=5')
    expect(notAnObject).toMatchObject({ ok: false, code: 'invalid-arguments', path: '$' })

    const unknown = await modelCommands.run('model.sketch.new', {})
    expect(unknown).toMatchObject({ ok: false, code: 'unknown-command' })

    const wrongRevision = await set('a', '1', { expectRevision: 1.5 })
    expect(wrongRevision).toMatchObject({ ok: false, code: 'invalid-arguments', path: 'expectRevision' })

    expect(fingerprint(s)).toEqual(before)
    // Every refusal is one plain sentence, not a stack trace or a schema dump.
    for (const r of [missing, unknownKey, wrongType, notAnObject, unknown]) {
      if (r.ok) throw new Error('unreachable')
      expect(r.message).toMatch(/^[A-Z"].*[.]$/)
      expect(r.message).not.toMatch(/\n|at .*:\d+/)
    }
  })

  it('an input that makes the parser throw (a 200000-deep expression) is a plain refusal, never a raw exception, and changes nothing', async () => {
    const s = openModel()
    ok(await set('width', '40'))
    const before = fingerprint(s)
    for (const expression of ['('.repeat(200_000) + '1' + ')'.repeat(200_000), '-'.repeat(200_000) + '1']) {
      const result = await set('deep', expression)
      expect(result).toMatchObject({ ok: false, code: 'refused' })
      if (result.ok) throw new Error('unreachable')
      expect(result.message).toBe('model.parameter.set could not be run on this input and nothing was changed. Check the arguments and try again.')
    }
    expect(fingerprint(s)).toEqual(before)
    expect(await set('a', '1', { requestId: 5 as unknown as string })).toMatchObject({ ok: false, code: 'invalid-arguments', path: 'requestId' })
  })

  it('with no Model page mounted: one plain sentence that says what to do, nothing thrown, no session created', async () => {
    // No openModel(): documentHolder has no session.
    const result = await set('width', '40')
    expect(result).toMatchObject({ ok: false, code: 'no-model-open' })
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toBe('No model is open. Open the Model page for the part you want to work on, then run this again.')
    const { getModelSession } = await import('../../doc/documentHolder')
    expect(getModelSession()).toBeUndefined()
    for (const id of ['model.parameters', 'model.undo', 'model.redo']) {
      expect(await modelCommands.run(id)).toMatchObject({ ok: false, code: 'no-model-open' })
    }
  })

  it('edits the model item the app has open (store activeModelItemId), not just the legacy one', async () => {
    const { useCamStore } = await import('../../store')
    const other = openModel('item-7')
    expect(await set('w', '1')).toMatchObject({ ok: false, code: 'no-model-open' })
    useCamStore.setState({ activeModelItemId: 'item-7' })
    try {
      ok(await set('w', '1'))
      expect(other.params.expressionOf('w')).toBe('1')
    } finally {
      useCamStore.setState({ activeModelItemId: null })
    }
  })
})

describe('WO-2993 T2 same path as the screen', () => {
  it('setExpression on session A and model.parameter.set on session B give identical DAG bytes and dependent statuses', async () => {
    const a = openModel('item-A')
    const b = openModel('item-B')
    const script: Array<[string, string]> = [['width', '40'], ['half', 'width / 2'], ['width', '60'], ['bad', 'half + nothing']]
    for (const [name, expr] of script) {
      await a.params.setExpression(name, expr)
      if (name === 'width' && a.dag.has('F1') === false) await addDependent(a, 'F1', 'half')
    }
    for (const [name, expr] of script) {
      ok(await modelCommands.run('model.parameter.set', { name, expression: expr }, { modelItemId: 'item-B' }))
      if (name === 'width' && b.dag.has('F1') === false) await addDependent(b, 'F1', 'half')
    }
    expect(stableStringify(JSON.parse(b.dag.serialize()))).toBe(stableStringify(JSON.parse(a.dag.serialize())))
    const statuses = (s: ModelSession) => s.dag.nodeIds().map((id) => `${id}:${s.scheduler.statusOf(id)}`)
    expect(statuses(b)).toEqual(statuses(a))
    expect(b.params.valueOf('half')).toBe(30)
    expect(b.params.statusOf('bad')).toBe(a.params.statusOf('bad'))
  })
})

describe('WO-2993 T3 determinism', () => {
  async function script(): Promise<{ results: string[]; archive: string }> {
    const s = openModel()
    const results: string[] = []
    const run = async (name: string, expr: string) => results.push(JSON.stringify(await set(name, expr)))
    await run('width', '40')
    await run('depth', 'width * 2')
    await addDependent(s, 'F1', 'depth')
    await run('width', '55')
    results.push(JSON.stringify(await modelCommands.run('model.undo')))
    results.push(JSON.stringify(await modelCommands.run('model.parameters')))
    const archive = Buffer.from(createDocumentArchive({ dag: s.dag, elementMapDeltas: [] })).toString('base64')
    resetDocumentHolder()
    return { results, archive }
  }

  it('the same script on two fresh sessions gives byte-identical result JSON and document archives', async () => {
    const first = await script()
    const second = await script()
    expect(second.results).toEqual(first.results)
    expect(second.archive).toBe(first.archive)
    expect(first.results.join('\n')).not.toMatch(/\b1[67]\d{11}\b/) // no epoch-ms timestamp anywhere
  })
})

describe('WO-2993 T4 one call, one step', () => {
  it('N successful calls add N labelled steps; Undo restores value and dependents; a refused call adds none', async () => {
    const s = openModel()
    ok(await set('width', '40'))
    await addDependent(s, 'F1', 'width')
    const base = s.history.size() // width, F1
    expect(s.scheduler.statusOf('F1')).toBe('ok')

    const a = ok(await set('width', '50'))
    const b = ok(await set('depth', 'width + 1'))
    expect(s.history.size()).toBe(base + 2)
    expect(a.step).toBe('Agent: set width = 50')
    expect(b.step).toBe('Agent: set depth = width + 1')
    expect(s.history.lastAppliedCommand()?.label).toBe('Agent: set depth = width + 1')

    const refused = await set('width', 'width + 1')
    expect(refused.ok).toBe(false)
    expect(s.history.size()).toBe(base + 2)

    // The screen's Undo (session.undo) pops the agent step and restores the dependents.
    await s.undo()
    expect(s.params.has('depth')).toBe(false)
    await s.undo()
    expect(s.params.valueOf('width')).toBe(40)
    expect(s.scheduler.statusOf('F1')).toBe('ok')
    expect(s.history.size()).toBe(base)
  })
})

describe('WO-2993 T5 the screen\'s words', () => {
  it('self-reference, cycle, syntax and name refusals equal the shared formatParamDiag text the table shows', async () => {
    const s = openModel()
    ok(await set('a', '1'))
    ok(await set('b', 'a + 1'))
    const cases: Array<[string, string]> = [['c', 'c + 1'], ['a', 'b + 1'], ['d', '2 + * 3'], ['1bad', '5'], ['e', 'foo(1)']]
    for (const [name, expr] of cases) {
      const before = fingerprint(s)
      const screen = await openScreenTwin(s).setExpression(name, expr)
      if (screen.ok) throw new Error('the screen path must refuse this case')
      const agent = await set(name, expr)
      expect(agent.ok).toBe(false)
      if (agent.ok) throw new Error('unreachable')
      expect(agent.code).toBe('refused')
      expect(agent.message).toBe(formatParamDiag(screen.diag))
      expect(fingerprint(s)).toEqual(before)
    }
    const codes = await Promise.all(cases.map(async ([n, e]) => (await set(n, e) as { message: string }).message.split(':')[0]))
    expect(codes).toEqual(['PARAM_SELF_REFERENCE', 'PARAM_CYCLE', 'PARAM_SYNTAX_ERROR', 'PARAM_SYNTAX_ERROR', 'PARAM_UNKNOWN_FUNCTION'])
  })

  /** What the Parameters table calls: setExpression on the same table. */
  function openScreenTwin(s: ModelSession) {
    return s.params
  }
})

describe('WO-2993 T6 rule 11: evaluation failures commit', () => {
  it('x = 1/0 commits, returns ok with PARAM_DIVISION_BY_ZERO, and undoes like any step', async () => {
    const s = openModel()
    ok(await set('x', '4'))
    await addDependent(s, 'F1', 'x')
    const depth = s.history.size()
    const r = ok(await set('x', '1/0'))
    expect(s.history.size()).toBe(depth + 1)
    expect(r.value.status).toBe('failed')
    expect(r.diagnostics.some((d: { code: string }) => d.code === 'PARAM_DIVISION_BY_ZERO')).toBe(true)
    expect(r.status.F1).toBe('degraded')
    ok(await modelCommands.run('model.undo'))
    expect(s.params.expressionOf('x')).toBe('4')
    expect(s.scheduler.statusOf('F1')).toBe('ok')
  })
})

describe('WO-2993 T7 shared Undo', () => {
  it('model.undo / model.redo reverse a Parameters-table edit and a table Undo reverses an agent edit: one history', async () => {
    const s = openModel()
    await s.params.setExpression('w', '5') // the screen path
    expect(s.history.size()).toBe(1)
    const undone = ok(await modelCommands.run('model.undo'))
    expect(s.params.has('w')).toBe(false)
    expect(typeof undone.value.undone).toBe('string')
    const redone = ok(await modelCommands.run('model.redo'))
    expect(s.params.valueOf('w')).toBe(5)
    expect(typeof redone.value.redone).toBe('string')

    ok(await set('w', '9'))
    await s.params.undo() // what the screen's Undo takes: the model's last step
    expect(s.params.valueOf('w')).toBe(5)

    // Nothing to undo: the button does nothing, so the command reports it and refuses nothing.
    await s.undo()
    const none = ok(await modelCommands.run('model.undo'))
    expect(none.value).toEqual({ undone: null })
    expect(none.step).toBeNull()
  })
})

describe('WO-2993 T8 replay and revision', () => {
  it('a repeated requestId returns the cached result with history depth unchanged', async () => {
    const s = openModel()
    const first = ok(await set('width', '40', { requestId: 'r1' }))
    const depth = s.history.size()
    const again = await set('width', '40', { requestId: 'r1' })
    expect(again).toBe(first)
    expect(s.history.size()).toBe(depth)
    // A different request id is a new call.
    ok(await set('width', '41', { requestId: 'r2' }))
    expect(s.history.size()).toBe(depth + 1)
  })

  it('every mutation route bumps revision(); a stale expectRevision refuses with nothing changed', async () => {
    const s = openModel()
    const moves: Array<[string, () => void | Promise<unknown>]> = [
      ['agent edit', async () => { await set('w', '1') }],
      ['undo', async () => { await s.undo() }],
      ['redo', async () => { await s.redo() }],
      ['coalesceIntoLast', () => {
        const last = s.history.lastAppliedCommand() as NonNullable<ReturnType<CommandHistory['lastAppliedCommand']>>
        s.history.coalesceIntoLast(last, new InsertNodeCommand({ id: 'C1', kind: 'feature' }))
      }],
      ['restoreCheckpoint', () => { s.history.restoreCheckpoint(s.history.checkpoint()) }],
      // The page's dialog Apply goes through its history directly, not through the session.
      ['page-path dialog Apply', () => { s.history.execute(new InsertNodeCommand({ id: 'F9', kind: 'feature' })) }],
    ]
    for (const [name, move] of moves) {
      const before = s.revision()
      await move()
      expect(s.revision(), name).toBeGreaterThan(before)
      const stale = await set('z', '1', { expectRevision: before })
      expect(stale, name).toMatchObject({ ok: false, code: 'stale-revision' })
    }
    const fp = fingerprint(s)
    const stale = await set('z', '1', { expectRevision: s.revision() - 1 })
    expect(stale).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(fingerprint(s)).toEqual(fp)
    // The current revision is accepted, and the result reports the new one.
    const current = ok(await set('z', '1', { expectRevision: s.revision() }))
    expect(current.revision).toBe(s.revision())
  })

  it('a remount (new session) starts with no cached replays', async () => {
    openModel()
    ok(await set('width', '40', { requestId: 'r1' }))
    resetDocumentHolder()
    const fresh = openModel()
    ok(await set('width', '40', { requestId: 'r1' }))
    expect(fresh.history.size()).toBe(1)
  })
})

describe('WO-2993 model.parameters (read)', () => {
  it('lists every parameter sorted by name with expression, value and status, adds no step, and is a frozen copy', async () => {
    const s = openModel()
    ok(await set('b', 'a * 2'))
    ok(await set('a', '3'))
    const depth = s.history.size()
    const r = ok(await modelCommands.run('model.parameters'))
    expect(r.value.parameters.map((p: { name: string }) => p.name)).toEqual(['a', 'b'])
    expect(r.value.parameters[1]).toEqual({ name: 'b', expression: 'a * 2', value: 6, status: 'ok' })
    expect(r.step).toBeNull()
    expect(s.history.size()).toBe(depth)
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen(r.value.parameters[0])).toBe(true)
  })
})

describe('WO-2993 fix round 1 (astra audit at c8696407)', () => {
  it('F1 two overlapping calls with one requestId commit once and both get the first call\'s result', async () => {
    const s = openModel()
    const [a, b] = await Promise.all([set('w', '5', { requestId: 'same' }), set('w', '5', { requestId: 'same' })])
    expect(s.history.size()).toBe(1)
    expect(b).toBe(a)
    ok(a)
    // A refused call is not kept: the same id may be retried with good input.
    const bad = await set('v', '(', { requestId: 'r-bad' })
    expect(bad.ok).toBe(false)
    ok(await set('v', '2', { requestId: 'r-bad' }))
    expect(s.history.size()).toBe(2)
  })

  it('F3 undo/redo report the real change: an edit is edited, undoing a creation is removed, redoing it is created', async () => {
    const s = openModel()
    ok(await set('w', '5'))
    await addDependent(s, 'F1', 'w')
    ok(await set('w', '7'))
    const undoEdit = ok(await modelCommands.run('model.undo'))
    expect(undoEdit.changed).toEqual({ created: [], edited: ['param:w'], removed: [] })
    const undoFeature = ok(await modelCommands.run('model.undo'))
    expect(undoFeature.changed).toEqual({ created: [], edited: [], removed: ['F1'] })
    const undoCreate = ok(await modelCommands.run('model.undo'))
    expect(s.params.has('w')).toBe(false)
    expect(undoCreate.changed).toEqual({ created: [], edited: [], removed: ['param:w'] })
    const redoCreate = ok(await modelCommands.run('model.redo'))
    expect(redoCreate.changed).toEqual({ created: ['param:w'], edited: [], removed: [] })
    const redoFeature = ok(await modelCommands.run('model.redo'))
    expect(redoFeature.changed).toEqual({ created: ['F1'], edited: [], removed: [] })
    const redoEdit = ok(await modelCommands.run('model.redo'))
    expect(redoEdit.changed).toEqual({ created: [], edited: ['param:w'], removed: [] })
    // Nothing to undo or redo: nothing changed.
    const none = ok(await modelCommands.run('model.redo'))
    expect(none.changed).toEqual({ created: [], edited: [], removed: [] })
  })

  it('F4 every successful command value satisfies its own declared output schema, empty Undo/Redo included', async () => {
    const s = openModel()
    const schemaOf = (id: string) => modelCommands.describe(id)?.output as JsonSchema
    const results: Array<[string, ModelCommandResult]> = []
    results.push(['model.undo (empty)', await modelCommands.run('model.undo')])
    results.push(['model.redo (empty)', await modelCommands.run('model.redo')])
    results.push(['model.parameters (empty)', await modelCommands.run('model.parameters')])
    results.push(['model.parameter.set', await set('w', '5')])
    results.push(['model.parameter.set 1/0', await set('z', '1/0')])
    results.push(['model.parameters', await modelCommands.run('model.parameters')])
    results.push(['model.undo', await modelCommands.run('model.undo')])
    results.push(['model.redo', await modelCommands.run('model.redo')])
    expect(s.history.size()).toBe(2)
    // WO-3011: the two feature commands, each on a valid fixture (a sketch profile to extrude, a feature to delete).
    s.dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch SK1', regions: [{ sketchId: 'SK1', loops: [] }] } })
    results.push(['model.extrude', await modelCommands.run('model.extrude', { sketchId: 'SK1', distance: 10 })])
    results.push(['model.feature.delete', await modelCommands.run('model.feature.delete', { featureId: 'F1' })])
    // WO-3014: the four dress-up / revolve commands, each on a valid fixture (a body to dress up, the sketch to revolve).
    results.push(['model.extrude (body)', await modelCommands.run('model.extrude', { sketchId: 'SK1', distance: 10 })])
    results.push(['model.fillet', await modelCommands.run('model.fillet', { ownerId: 'F1', edges: ['e1'], radius: 1 })])
    results.push(['model.chamfer', await modelCommands.run('model.chamfer', { ownerId: 'F2', edges: ['e1'], distance: 1 })])
    results.push(['model.hole', await modelCommands.run('model.hole', { ownerId: 'F3', faceId: 'f1', seed: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 }, style: { kind: 'simple', diameter: 4 }, depth: { kind: 'throughAll' } })])
    results.push(['model.revolve', await modelCommands.run('model.revolve', { sketchId: 'SK1' })])
    expect(s.history.size()).toBe(9)
    // WO-3013: the read and the sketch command, each on a valid fixture (the three base planes seeded, as every model has).
    seedGenesisNodes(s.dag)
    results.push(['model.summary', await modelCommands.run('model.summary')])
    results.push(['model.sketch.create', await modelCommands.run('model.sketch.create', { plane: 'XY', profiles: [{ kind: 'rectangle', corner: { x: 0, y: 0 }, width: 40, height: 20 }] })])
    expect(s.history.size()).toBe(10)
    const covered = new Set<string>()
    for (const [name, result] of results) {
      const success = ok(result)
      covered.add(success.command)
      expect(firstSchemaProblem(schemaOf(success.command), success.value), name).toBeUndefined()
    }
    expect([...covered].sort()).toEqual([...MODEL_COMMAND_ALLOW_LIST].sort())
  })
})

describe('WO-2993 fix round 2 (astra re-audit at 515afbd2)', () => {
  it('R1 with a Form session open, model.undo / model.redo step the Form history like the button and leave the model edit', async () => {
    const s = openModel()
    ok(await set('w', '5')) // a prior model edit
    const form = useFormStore.getState()
    form.openSession({ featureId: null, name: 'Form 1' })
    const opened = useFormStore.getState().cage
    form.newFromStarter('plane') // a Form edit, on the Form's own history
    const edited = useFormStore.getState().cage
    expect(edited).not.toEqual(opened)
    const model = fingerprint(s)

    const undo = ok(await modelCommands.run('model.undo'))
    expect(useFormStore.getState().cage).toEqual(opened)
    expect(fingerprint(s)).toEqual(model)
    expect(s.params.valueOf('w')).toBe(5)
    expect(undo.value).toEqual({ undone: 'Form edit' })
    expect(undo.changed).toEqual({ created: [], edited: [], removed: [] })

    const redo = ok(await modelCommands.run('model.redo'))
    expect(useFormStore.getState().cage).toEqual(edited)
    expect(fingerprint(s)).toEqual(model)
    expect(redo.value).toEqual({ redone: 'Form edit' })

    // Nothing left on the Form's redo side: like the button, nothing happens, and the model is untouched.
    const none = ok(await modelCommands.run('model.redo'))
    expect(none.value).toEqual({ redone: null })
    expect(fingerprint(s)).toEqual(model)

    // Form closed: Undo takes back the model edit again.
    useFormStore.getState().closeSession()
    ok(await modelCommands.run('model.undo'))
    expect(s.params.has('w')).toBe(false)
  })
})
