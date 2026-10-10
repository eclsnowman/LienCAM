import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { CommandHistory, InsertNodeCommand, SetHiddenCommand } from '../../doc/commands'

function sketchWithConsumer(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch' } })
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { name: 'Extrude' } })
  return dag
}

describe('FeatureDag persisted display-only hidden flag (WO UI-53)', () => {
  it('fresh nodes are visible; setHidden returns the prior value without suppression or cascade', () => {
    const dag = sketchWithConsumer()
    expect(dag.getNode('SK1')?.hidden).toBe(false)
    expect(dag.setHidden('SK1', true)).toBe(false)
    expect(dag.getNode('SK1')?.hidden).toBe(true)

    // Hidden is not suppression under either name, and the downstream
    // consumer inherits nothing from it.
    expect(dag.isSuppressed('SK1')).toBe(false)
    expect(dag.isEffectivelySuppressed('SK1')).toBe(false)
    expect(dag.isSuppressed('F1')).toBe(false)
    expect(dag.isEffectivelySuppressed('F1')).toBe(false)
    expect(dag.setHidden('SK1', false)).toBe(true)
  })

  it('serialize/restore round-trips hidden, while a pre-field document defaults to visible', () => {
    const dag = sketchWithConsumer()
    dag.setHidden('SK1', true)
    const restored = FeatureDag.restore(dag.serialize())
    expect(restored.serialize()).toBe(dag.serialize())
    expect(restored.getNode('SK1')?.hidden).toBe(true)

    const preUi53 = JSON.stringify({
      nodes: [{
        id: 'SK-OLD', kind: 'sketch', consumes: [], refs: [], payload: {},
        degraded: false, diagnostics: [], lastGoodBoundTo: {}, suppressed: false,
      }],
      order: ['SK-OLD'],
    })
    const oldRestored = FeatureDag.restore(preUi53)
    expect(oldRestored.getNode('SK-OLD')?.hidden).toBe(false)
    expect(JSON.parse(oldRestored.serialize()).nodes[0].hidden).toBe(false)
  })
})

describe('SetHiddenCommand (WO UI-53 undo/redo)', () => {
  it('hide -> undo -> redo restores only the persisted display flag', () => {
    const dag = sketchWithConsumer()
    const history = new CommandHistory(dag)

    history.execute(new SetHiddenCommand('SK1', true))
    expect(dag.getNode('SK1')?.hidden).toBe(true)
    expect(dag.isEffectivelySuppressed('F1')).toBe(false)

    expect(history.undo()).toBe(true)
    expect(dag.getNode('SK1')?.hidden).toBe(false)
    expect(history.redo()).toBe(true)
    expect(dag.getNode('SK1')?.hidden).toBe(true)
  })

  it('serializes plain command data and refuses undo before do', () => {
    const command = new SetHiddenCommand('SK1', true)
    expect(command.serialize()).toEqual({ type: 'setHidden', id: 'SK1', hidden: true })
    expect(() => command.undo(sketchWithConsumer())).toThrow(/never set/i)
  })

  it('coalesces a validated follow-up hide into the exact create undo step', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', payload: { name: 'Sketch' } })
    const history = new CommandHistory(dag)
    const create = new InsertNodeCommand({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1' },
    })
    history.execute(create)

    expect(history.coalesceIntoLast(create, new SetHiddenCommand('SK1', true))).toBe(true)
    expect(dag.getNode('SK1')?.hidden).toBe(true)
    expect(history.size()).toBe(1)

    expect(history.undo()).toBe(true)
    expect(dag.has('F1')).toBe(false)
    expect(dag.getNode('SK1')?.hidden).toBe(false)

    expect(history.redo()).toBe(true)
    expect(dag.has('F1')).toBe(true)
    expect(dag.getNode('SK1')?.hidden).toBe(true)
  })

  it('refuses a stale async tail identity without applying the follow-up', () => {
    const dag = sketchWithConsumer()
    const history = new CommandHistory(dag)
    const stale = new SetHiddenCommand('SK1', true)
    history.execute(stale)
    history.execute(new SetHiddenCommand('SK1', false))

    expect(history.coalesceIntoLast(stale, new SetHiddenCommand('SK1', true))).toBe(false)
    expect(dag.getNode('SK1')?.hidden).toBe(false)
    expect(history.size()).toBe(2)
  })
})
