// @vitest-environment jsdom
//
// WO-2978 (WO-2951 Order A): the ModelSession foundation.
//
// What this file proves, each against the real classes (no mocks of src/doc):
//   1. Lifecycle -- one session per mount holds the page's dag, map, scheduler,
//      history and parameter table (identity, not copies), is reachable by
//      model item id through documentHolder while mounted, and is gone after
//      unmount / reset / disposeModelItem. A StrictMode-style stale unregister
//      never drops the live session.
//   2. The prepare/commit split -- prepareExpression refuses exactly what
//      setExpression refuses (incl. PARAM_CYCLE for every cycle the DAG
//      throws on, with the DAG's own {consumer, producer}), and mutates
//      NOTHING: dag bytes, history depth, revision and statuses unchanged.
//   3. The shared refusal words -- formatParamDiag lives in src/doc and is
//      what the Parameters table shows.
//   4. The revision counter on EVERY mutation route (review D1): execute,
//      undo, redo, coalesceIntoLast, restoreCheckpoint, a session step, and a
//      REAL page dialog Apply that goes through the page's history directly.
//      No-op calls do not bump it.
//   5. G2 (operator, 2026-10-20): a Parameters edit is one step on the session's
//      history -- the screen's Undo restores the parameter, not the feature
//      step before it; Redo re-applies; a mixed feature + parameter sequence
//      undoes in reverse order; a parameter delete keeps the touched stacks in
//      lockstep. A bare table keeps its private history.
//
// Negative controls (rule 6) and their recorded outputs:
// src/tests/evidence/WO-2978/negative-controls.json.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  CommandHistory,
  ElementMap,
  FeatureDag,
  InsertNodeCommand,
  ModelSession,
  ParameterTable,
  RegenScheduler,
  SetHiddenCommand,
  createModelSession,
  formatParamDiag,
  paramNodeId,
  type FeatureOp,
} from '../../doc'
import {
  LEGACY_MODEL_ITEM_ID,
  disposeModelItem,
  getModelSession,
  registerModelSession,
  resetDocumentHolder,
} from '../../doc/documentHolder'
import { DagCycleError } from '../../doc/dag'
import { ParametersTable } from '../../components/model3d/params/ParametersTable'
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'
import { createFakeGeomClient } from '../model3d/fakeGeomClient'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { useCamStore } from '../../store'

let restoreCanvas: (() => void) | null = null
beforeEach(() => {
  restoreCanvas = stubCanvas2d()
})
afterEach(() => {
  cleanup()
  restoreCanvas?.()
  restoreCanvas = null
  resetDocumentHolder()
})

function headlessSession(modelItemId = 'item-A', kernelOp?: FeatureOp): ModelSession {
  return createModelSession({ modelItemId, dag: new FeatureDag(), map: new ElementMap(), kernelOp })
}

/** Everything a refused prepare must leave untouched. */
function fingerprint(s: ModelSession) {
  return {
    dag: JSON.stringify(s.dag.serialize()),
    depth: s.history.size(),
    revision: s.revision(),
    statuses: s.dag.nodeIds().map((id) => `${id}:${s.scheduler.statusOf(id)}`).join(','),
    canUndoParams: s.params.canUndo(),
  }
}

// ---------------------------------------------------------------------------
// 1. Lifecycle
// ---------------------------------------------------------------------------

describe('WO-2978 ModelSession lifecycle', () => {
  it('holds one dag/map/scheduler/history/params set; revision() is the history counter', () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const s = createModelSession({ modelItemId: 'item-A', dag, map })
    expect(s.modelItemId).toBe('item-A')
    expect(s.dag).toBe(dag)
    expect(s.map).toBe(map)
    expect(s.scheduler).toBeInstanceOf(RegenScheduler)
    expect(s.history).toBeInstanceOf(CommandHistory)
    expect(s.params).toBeInstanceOf(ParameterTable)
    expect(s.touchedPast.current).toEqual([])
    expect(s.touchedFuture.current).toEqual([])
    expect(s.revision()).toBe(0)
    s.history.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature' }))
    expect(s.revision()).toBe(s.history.revision)
    expect(s.revision()).toBe(1)
  })

  it('is registered per model item; a stale unregister never drops the live session; reset and dispose clear it', () => {
    const a1 = headlessSession('item-A')
    const a2 = headlessSession('item-A')
    const b = headlessSession('item-B')
    expect(getModelSession('item-A')).toBeUndefined()
    const unA1 = registerModelSession(a1)
    const unB = registerModelSession(b)
    expect(getModelSession('item-A')).toBe(a1)
    expect(getModelSession('item-B')).toBe(b)
    // A remount registers its replacement before the old cleanup runs.
    const unA2 = registerModelSession(a2)
    unA1()
    expect(getModelSession('item-A')).toBe(a2)
    unA2()
    expect(getModelSession('item-A')).toBeUndefined()
    expect(getModelSession('item-B')).toBe(b)
    disposeModelItem('item-B')
    expect(getModelSession('item-B')).toBeUndefined()
    unB() // already gone: a no-op
    registerModelSession(a1)
    resetDocumentHolder()
    expect(getModelSession('item-A')).toBeUndefined()
  })

  it('execute runs one labelled step (composite for many), keeps the touched stacks in lockstep, and undo/redo rebuild its roots', async () => {
    const seen: string[] = []
    const s = headlessSession('item-A', async (node) => {
      seen.push(node.id)
      return { ok: true, diagnostics: [] }
    })
    await s.execute({
      label: 'two features',
      commands: [new InsertNodeCommand({ id: 'F1', kind: 'feature' }), new InsertNodeCommand({ id: 'F2', kind: 'feature', consumes: ['F1'] })],
      touched: ['F1', 'F2'],
    })
    expect(s.history.size()).toBe(1)
    expect(s.history.lastAppliedCommand()?.label).toBe('two features')
    expect(s.touchedPast.current).toEqual([['F1', 'F2']])
    expect(s.scheduler.statusOf('F2')).toBe('ok')

    // A throwing member leaves no change and no step (CompositeCommand rollback).
    const before = fingerprint(s)
    await expect(s.execute({
      label: 'half',
      commands: [new InsertNodeCommand({ id: 'F3', kind: 'feature' }), new InsertNodeCommand({ id: 'F1', kind: 'feature' })],
      touched: ['F3', 'F1'],
    })).rejects.toThrow(/already exists/)
    expect(fingerprint(s)).toEqual(before)
    expect(s.touchedPast.current).toEqual([['F1', 'F2']])

    const undone = await s.undo()
    expect(undone?.command.label).toBe('two features')
    expect(s.dag.has('F1')).toBe(false)
    expect(s.touchedFuture.current).toEqual([['F1', 'F2']])
    expect(await s.undo()).toBeUndefined()

    seen.length = 0
    const redone = await s.redo()
    expect(redone?.roots).toEqual(['F1', 'F2'])
    expect(s.dag.has('F2')).toBe(true)
    expect(seen).toEqual(['F1', 'F2'])
    expect(s.touchedPast.current).toEqual([['F1', 'F2']])
    expect(await s.redo()).toBeUndefined()
  })

  it('a genesis undo reports the removed node\'s former consumers as rebuild roots', async () => {
    const s = headlessSession()
    await s.execute({ label: 'F1', commands: [new InsertNodeCommand({ id: 'F1', kind: 'feature' })], touched: ['F1'] })
    s.dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    const step = s.undoStep()
    expect(step?.roots).toEqual(['F2'])
  })
})

// ---------------------------------------------------------------------------
// 2. prepareExpression: the pure check
// ---------------------------------------------------------------------------

/** The DAG's own verdict for committing `consumes` on `id`, on a throwaway copy. */
function dagCycleVerdict(dag: FeatureDag, id: string, consumes: string[]): Record<string, string> | undefined {
  const copy = FeatureDag.restore(dag.serialize())
  try {
    if (copy.has(id)) copy.setConsumes(id, consumes)
    else copy.insertNode({ id, kind: 'parameter', consumes })
    return undefined
  } catch (e) {
    if (e instanceof DagCycleError) return e.diagnostic.params as Record<string, string>
    throw e
  }
}

describe('WO-2978 prepareExpression: every edit-time check, nothing mutated', () => {
  const cycleCases: Array<{ name: string; setup: Array<[string, string]>; edit: [string, string]; refs: string[] }> = [
    // typed-errors.test.ts's CYCLE and FAILS-IF cases (A->B->A).
    { name: 'A->B->A (typed-errors)', setup: [['a', '1'], ['b', 'a + 1']], edit: ['a', 'b + 1'], refs: ['b'] },
    { name: 'A->B->C->A', setup: [['a', '1'], ['b', 'a + 1'], ['c', 'b * 2']], edit: ['a', 'c - 1'], refs: ['c'] },
    // A brand-new name closing a loop through an earlier forward reference
    // (b = a + 1 committed while `a` did not exist yet): the insert path.
    { name: 'insert closes a forward-reference loop', setup: [['b', 'a + 1']], edit: ['a', 'b * 2'], refs: ['b'] },
    // Two producers, only the second cyclic: the DAG reports the first cyclic one.
    { name: 'second producer cyclic', setup: [['x', '3'], ['a', '1'], ['b', 'a + 1']], edit: ['a', 'x + b'], refs: ['x', 'b'] },
  ]

  for (const c of cycleCases) {
    it(`PARAM_CYCLE before commit, with the DAG's own params: ${c.name}`, async () => {
      const s = headlessSession()
      for (const [n, e] of c.setup) expect((await s.params.setExpression(n, e)).ok).toBe(true)
      const before = fingerprint(s)
      const id = paramNodeId(c.edit[0])
      const dagSays = dagCycleVerdict(s.dag, id, c.refs.map(paramNodeId))
      expect(dagSays).toBeDefined()

      const prepared = s.params.prepareExpression(c.edit[0], c.edit[1])
      expect(prepared.ok).toBe(false)
      if (prepared.ok) return
      expect(prepared.diag).toEqual({ code: 'PARAM_CYCLE', severity: 'error', params: { name: c.edit[0], ...dagSays } })
      expect(fingerprint(s)).toEqual(before)

      // setExpression returns the very same outcome and still mutates nothing.
      const outcome = await s.params.setExpression(c.edit[0], c.edit[1])
      expect(outcome).toEqual(prepared)
      expect(fingerprint(s)).toEqual(before)
    })
  }

  it('refuses invalid names, syntax, unknown functions and self-reference exactly as setExpression does, mutating nothing', async () => {
    const s = headlessSession()
    await s.params.setExpression('base', '10')
    const before = fingerprint(s)
    const refusals: Array<[string, string, string]> = [
      ['1bad', '1', 'PARAM_SYNTAX_ERROR'],
      ['pi', '1', 'PARAM_SYNTAX_ERROR'],
      ['w', '2 + * 3', 'PARAM_SYNTAX_ERROR'],
      ['w', 'foo(1)', 'PARAM_UNKNOWN_FUNCTION'],
      ['w', 'sqrt(1, 2)', 'PARAM_SYNTAX_ERROR'],
      ['w', 'w + 1', 'PARAM_SELF_REFERENCE'],
    ]
    for (const [name, expr, code] of refusals) {
      const prepared = s.params.prepareExpression(name, expr)
      expect(prepared.ok, `${name} = ${expr}`).toBe(false)
      if (prepared.ok) continue
      expect(prepared.diag.code).toBe(code)
      expect(fingerprint(s)).toEqual(before)
      expect(await s.params.setExpression(name, expr)).toEqual(prepared)
      expect(fingerprint(s)).toEqual(before)
    }
  })

  it('accepts eval-time failures (rule 11: they commit and say so), returning the one command and its touched id without running it', async () => {
    const s = headlessSession()
    await s.params.setExpression('base', '10')
    const before = fingerprint(s)
    const created = s.params.prepareExpression('w', '1/0')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.touched).toEqual([paramNodeId('w')])
    expect(created.command).toBeInstanceOf(InsertNodeCommand)
    const edited = s.params.prepareExpression('base', 'missing + 1')
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect((edited.command.serialize() as { type: string }).type).toBe('setParameterExpression')
    expect(fingerprint(s)).toEqual(before)
    // And the commit path still reports it afterwards.
    expect((await s.params.setExpression('w', '1/0')).ok).toBe(true)
    expect(s.params.diagnosticsOf('w').some((d) => 'code' in d && d.code === 'PARAM_DIVISION_BY_ZERO')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The refusal words
// ---------------------------------------------------------------------------

describe('WO-2978 formatParamDiag: one module, the words the table shows', () => {
  it('formats code-only and code-with-params, in param order; undefined passes through', () => {
    expect(formatParamDiag(undefined)).toBeUndefined()
    expect(formatParamDiag({ code: 'PARAM_SYNTAX_ERROR', params: {} })).toBe('PARAM_SYNTAX_ERROR')
    expect(formatParamDiag({ code: 'PARAM_CYCLE', params: { name: 'a', consumer: 'param:a', producer: 'param:b' } }))
      .toBe('PARAM_CYCLE: name=a, consumer=param:a, producer=param:b')
  })

  it('the Parameters table shows exactly formatParamDiag(prepareExpression(...).diag) for a cycle and a self-reference', async () => {
    const s = headlessSession()
    await s.params.setExpression('a', '1')
    await s.params.setExpression('b', 'a + 1')
    render(createElement(ParametersTable, { paramTable: s.params, version: 0, onChanged: () => {}, onDeleteParameter: () => undefined }))

    const cycle = s.params.prepareExpression('a', 'b + 1')
    if (cycle.ok) throw new Error('expected a refusal')
    const row = screen.getByTestId('param-expression-a')
    fireEvent.change(row, { target: { value: 'b + 1' } })
    await act(async () => { fireEvent.blur(row) })
    await waitFor(() => expect(screen.getByTestId('param-row-error-a').textContent).toBe(formatParamDiag(cycle.diag)))

    const self = s.params.prepareExpression('c', 'c * 2')
    if (self.ok) throw new Error('expected a refusal')
    fireEvent.change(screen.getByTestId('param-new-name'), { target: { value: 'c' } })
    fireEvent.change(screen.getByTestId('param-new-expression'), { target: { value: 'c * 2' } })
    await act(async () => { fireEvent.click(screen.getByTestId('param-add')) })
    await waitFor(() => expect(screen.getByTestId('param-add-error').textContent).toBe(formatParamDiag(self.diag)))
  })
})

// ---------------------------------------------------------------------------
// 4. The revision counter on every mutation route
// ---------------------------------------------------------------------------

describe('WO-2978 CommandHistory.revision moves on every mutation route', () => {
  it('execute, undo, redo, coalesceIntoLast and restoreCheckpoint each bump it; no-op calls do not', () => {
    const dag = new FeatureDag()
    const h = new CommandHistory(dag)
    const seen: number[] = []
    const bumped = (route: string, fn: () => unknown) => {
      const r0 = h.revision
      fn()
      expect(h.revision, route).toBe(r0 + 1)
      seen.push(h.revision)
    }
    const unchanged = (route: string, fn: () => unknown) => {
      const r0 = h.revision
      fn()
      expect(h.revision, route).toBe(r0)
    }

    unchanged('undo on empty', () => expect(h.undo()).toBe(false))
    unchanged('redo on empty', () => expect(h.redo()).toBe(false))
    bumped('execute', () => h.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature' })))
    unchanged('execute whose do() throws', () => expect(() => h.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature' }))).toThrow())

    // A coalesced follow-up (the page's async Apply follow-ups): same undo
    // depth, new document state -- the revision must still move.
    const tail = h.lastAppliedCommand()!
    const depth = h.size()
    bumped('coalesceIntoLast', () => expect(h.coalesceIntoLast(tail, new SetHiddenCommand('F1', true))).toBe(true))
    expect(h.size()).toBe(depth)
    unchanged('refused coalesce (stale tail)', () => expect(h.coalesceIntoLast(tail, new SetHiddenCommand('F1', false))).toBe(false))

    const checkpoint = h.checkpoint()
    bumped('execute F2', () => h.execute(new InsertNodeCommand({ id: 'F2', kind: 'feature' })))
    bumped('undo', () => expect(h.undo()).toBe(true))
    bumped('redo', () => expect(h.redo()).toBe(true))
    // A Cancel restore puts the stacks back; anything that read the old
    // revision must see that the history moved.
    bumped('restoreCheckpoint', () => h.restoreCheckpoint(checkpoint))
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('a session step, a session undo and a direct history call on the session all move session.revision()', async () => {
    const s = headlessSession()
    const r0 = s.revision()
    await s.execute({ label: 'F1', commands: [new InsertNodeCommand({ id: 'F1', kind: 'feature' })], touched: ['F1'] })
    const r1 = s.revision()
    expect(r1).toBeGreaterThan(r0)
    // The page's path: history.execute directly, not session.execute.
    s.history.execute(new InsertNodeCommand({ id: 'F2', kind: 'feature' }))
    const r2 = s.revision()
    expect(r2).toBeGreaterThan(r1)
    await s.undo()
    expect(s.revision()).toBeGreaterThan(r2)
  })

  it('a REAL page dialog Apply, Undo and Redo (the page\'s own history calls) move the registered session\'s revision', async () => {
    render(createElement(SolidsWorkbenchPage, { createClient: createFakeGeomClient, createSceneRuntime: () => createFakeSceneRuntime() }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const hooks = window.__solidsWorkbenchHooks as SolidsWorkbenchHooks
    const session = getModelSession(LEGACY_MODEL_ITEM_ID)
    expect(session).toBeDefined()
    if (session === undefined) return
    // The page works on the session's own objects, not copies.
    expect(hooks.dag).toBe(session.dag)
    expect(hooks.history).toBe(session.history)
    expect(hooks.scheduler).toBe(session.scheduler)
    expect(hooks.map).toBe(session.map)
    expect(hooks.paramTable).toBe(session.params)

    // Dialog Apply (Offset Plane): createFeatureCommand through the page's
    // history.execute -- session.execute is never called on this path.
    const r0 = session.revision()
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '6' } })
    await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(session.dag.getNode('datum:RP1')).toBeDefined())
    const r1 = session.revision()
    expect(r1).toBeGreaterThan(r0)
    expect(session.touchedPast.current.at(-1)).toContain('datum:RP1')

    // The screen's Undo pops the SAME history through the session.
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(session.dag.has('datum:RP1')).toBe(false))
    const r2 = session.revision()
    expect(r2).toBeGreaterThan(r1)
    expect(session.touchedFuture.current.at(-1)).toContain('datum:RP1')
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(session.dag.has('datum:RP1')).toBe(true))
    expect(session.revision()).toBeGreaterThan(r2)

    // Unmount: the session is no longer reachable.
    cleanup()
    expect(getModelSession(LEGACY_MODEL_ITEM_ID)).toBeUndefined()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 5. G2: Parameters edits on the screen's Undo (operator, 2026-10-20: Mission
//    Control card "Yes - put parameter edits on Undo", confirmed in the
//    project thread)
// ---------------------------------------------------------------------------

describe('WO-2978 G2: a Parameters edit is one Undo/Redo step, in order with the other Model steps', () => {
  /** A session whose feature F1 consumes param:width; records the width F1 is built with. */
  async function sessionWithDependent() {
    const builtWith: number[] = []
    const s: ModelSession = headlessSession('item-A', async (node) => {
      if (node.id === 'F1') builtWith.push(s.params.valueOf('width') as number)
      return { ok: true, diagnostics: [] }
    })
    expect((await s.params.setExpression('width', '40')).ok).toBe(true)
    await s.execute({
      label: 'F1',
      commands: [new InsertNodeCommand({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })],
      touched: ['F1'],
    })
    return { s, lastBuilt: () => builtWith[builtWith.length - 1] }
  }

  it('Undo after a parameter edit restores the parameter (not the feature step before it) and rebuilds its dependents; Redo re-applies it', async () => {
    const { s, lastBuilt } = await sessionWithDependent()
    expect(lastBuilt()).toBe(40)
    const depth = s.history.size()
    const rev = s.revision()

    expect((await s.params.setExpression('width', '55')).ok).toBe(true)
    expect(s.history.size()).toBe(depth + 1)
    expect(s.revision()).toBeGreaterThan(rev)
    expect(s.touchedPast.current.at(-1)).toEqual([paramNodeId('width')])
    expect(lastBuilt()).toBe(55)

    const undone = await s.undo()
    expect((undone?.command.serialize() as { type: string }).type).toBe('setParameterExpression')
    expect(s.params.expressionOf('width')).toBe('40')
    expect(s.params.valueOf('width')).toBe(40)
    expect(s.dag.has('F1')).toBe(true) // the feature step before it is untouched
    expect(lastBuilt()).toBe(40) // the dependent was rebuilt with the restored value

    await s.redo()
    expect(s.params.expressionOf('width')).toBe('55')
    expect(lastBuilt()).toBe(55)
  })

  it('a mixed feature + parameter sequence undoes in reverse order and redoes forward', async () => {
    const s = headlessSession()
    const state = () => ({ a: s.params.expressionOf('a') ?? null, F1: s.dag.has('F1'), F2: s.dag.has('F2') })
    const steps: Array<() => Promise<unknown>> = [
      () => s.params.setExpression('a', '1'),
      () => s.execute({ label: 'F1', commands: [new InsertNodeCommand({ id: 'F1', kind: 'feature', consumes: [paramNodeId('a')] })], touched: ['F1'] }),
      () => s.params.setExpression('a', '2'),
      () => s.execute({ label: 'F2', commands: [new InsertNodeCommand({ id: 'F2', kind: 'feature' })], touched: ['F2'] }),
      () => s.params.setExpression('a', '3'),
    ]
    const snapshots = [state()]
    for (const step of steps) {
      await step()
      snapshots.push(state())
    }
    expect(s.history.size()).toBe(steps.length)
    expect(s.touchedPast.current).toHaveLength(steps.length)
    for (let k = steps.length - 1; k >= 0; k--) {
      await s.undo()
      expect(state(), `after undoing step ${k + 1}`).toEqual(snapshots[k])
    }
    expect(s.history.canUndo()).toBe(false)
    for (let k = 1; k <= steps.length; k++) {
      await s.redo()
      expect(state(), `after redoing step ${k}`).toEqual(snapshots[k])
    }
  })

  it('a parameter\'s genesis undo leaves its dependent degraded, never ok on the removed value', async () => {
    // F9 is added outside the history so the parameter's first commit is the
    // top step: undoing it removes param:w while F9 still consumes it.
    const s2 = headlessSession()
    await s2.params.setExpression('w', '3')
    s2.dag.insertNode({ id: 'F9', kind: 'feature', consumes: [paramNodeId('w')] })
    s2.scheduler.markDirty('F9')
    await s2.scheduler.run(s2.params.executor)
    expect(s2.scheduler.statusOf('F9')).toBe('ok')
    const step = await s2.undo() // the genesis insert of w
    expect(step?.roots).toEqual(['F9'])
    expect(s2.params.has('w')).toBe(false)
    expect(s2.scheduler.statusOf('F9')).not.toBe('ok')
  })

  it('the table bound to the session undoes the model\'s top step, the same one the screen takes', async () => {
    const { s } = await sessionWithDependent()
    expect(s.params.canUndo()).toBe(true)
    await s.params.undo() // undoes F1 (the top step), not the width edit
    expect(s.dag.has('F1')).toBe(false)
    expect(s.params.valueOf('width')).toBe(40)
    expect(s.params.canRedo()).toBe(true)
    await s.params.redo()
    expect(s.dag.has('F1')).toBe(true)
  })

  it('without the binding a bare table keeps its private history, exactly as before (the 9 older test files rely on this)', async () => {
    const dag = new FeatureDag()
    const scheduler = new RegenScheduler(dag, new ElementMap())
    const table = new ParameterTable(dag, scheduler)
    const outside = new CommandHistory(dag)
    expect((await table.setExpression('w', '5')).ok).toBe(true)
    expect(outside.size()).toBe(0)
    expect(table.canUndo()).toBe(true)
    await table.undo()
    expect(table.has('w')).toBe(false)
    expect(table.canRedo()).toBe(true)
  })

  it('on the REAL page: the Undo button takes back a Parameters-table edit before the feature step before it, and Redo replays in order', async () => {
    useCamStore.setState({ consoleEvents: [] })
    render(createElement(SolidsWorkbenchPage, { createClient: createFakeGeomClient, createSceneRuntime: () => createFakeSceneRuntime() }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const session = getModelSession(LEGACY_MODEL_ITEM_ID)
    if (session === undefined) throw new Error('no live session')

    // Step 1: a feature (Offset Plane dialog Apply).
    fireEvent.click(screen.getByTestId('workbench-offset-plane'))
    fireEvent.change(screen.getByTestId('offset-plane-distance'), { target: { value: '6' } })
    await waitFor(() => expect((screen.getByTestId('dialog-shell-apply') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(session.dag.getNode('datum:RP1')).toBeDefined())

    // Steps 2 and 3: add parameter w = 5, then edit it to 7, through the table's own inputs.
    if (screen.queryByTestId('param-new-name') === null) fireEvent.click(screen.getByTestId('workbench-section-parameters-header'))
    fireEvent.change(screen.getByTestId('param-new-name'), { target: { value: 'w' } })
    fireEvent.change(screen.getByTestId('param-new-expression'), { target: { value: '5' } })
    await act(async () => { fireEvent.click(screen.getByTestId('param-add')) })
    await waitFor(() => expect(session.params.valueOf('w')).toBe(5))
    const row = screen.getByTestId('param-expression-w')
    fireEvent.change(row, { target: { value: '7' } })
    await act(async () => { fireEvent.blur(row) })
    await waitFor(() => expect(session.params.valueOf('w')).toBe(7))
    expect(session.history.size()).toBe(3)

    const state = () => ({ w: session.params.expressionOf('w') ?? null, RP1: session.dag.has('datum:RP1') })
    const press = async (testId: 'workbench-undo' | 'workbench-redo') => {
      const before = session.revision()
      await waitFor(() => expect((screen.getAllByTestId(testId)[0] as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getAllByTestId(testId)[0])
      await waitFor(() => expect(session.revision()).toBeGreaterThan(before))
    }

    await press('workbench-undo')
    expect(state()).toEqual({ w: '5', RP1: true }) // the parameter edit, NOT the plane
    await waitFor(() => expect((screen.getByTestId('param-expression-w') as HTMLInputElement).value).toBe('5'))
    await waitFor(() => expect(useCamStore.getState().consoleEvents.at(-1)?.message).toBe('Undid edit w'))
    await press('workbench-undo')
    expect(state()).toEqual({ w: null, RP1: true })
    await press('workbench-undo')
    expect(state()).toEqual({ w: null, RP1: false })
    await press('workbench-redo')
    expect(state()).toEqual({ w: null, RP1: true })
    await press('workbench-redo')
    expect(state()).toEqual({ w: '5', RP1: true })
    await press('workbench-redo')
    expect(state()).toEqual({ w: '7', RP1: true })
  }, 60_000)

  it('on the REAL page: deleting a parameter keeps the touched stacks in lockstep with the history', async () => {
    render(createElement(SolidsWorkbenchPage, { createClient: createFakeGeomClient, createSceneRuntime: () => createFakeSceneRuntime() }))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
    const session = getModelSession(LEGACY_MODEL_ITEM_ID)
    if (session === undefined) throw new Error('no live session')
    if (screen.queryByTestId('param-new-name') === null) fireEvent.click(screen.getByTestId('workbench-section-parameters-header'))
    for (const [name, expr] of [['a', '1'], ['z', '9']] as const) {
      fireEvent.change(screen.getByTestId('param-new-name'), { target: { value: name } })
      fireEvent.change(screen.getByTestId('param-new-expression'), { target: { value: expr } })
      await act(async () => { fireEvent.click(screen.getByTestId('param-add')) })
      await waitFor(() => expect(session.params.has(name)).toBe(true))
    }
    await act(async () => { fireEvent.click(screen.getByTestId('param-delete-z')) })
    await waitFor(() => expect(session.params.has('z')).toBe(false))
    expect(session.touchedPast.current).toHaveLength(session.history.size())
    expect(session.touchedPast.current.at(-1)).toEqual([paramNodeId('z')])
  }, 60_000)
})
