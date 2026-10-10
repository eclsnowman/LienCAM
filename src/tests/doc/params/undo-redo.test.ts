import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../../doc'
import type { FeatureOp } from '../../../doc'

// WO DOC-4 acceptance criterion #5: parameter edit undone -> table value AND
// dependent feature state both restored; redo restores both; 10-deep cycle
// golden. Extended by WO DOC-4-R1.1 to include the GENESIS boundary (undo
// all the way to an empty table, redo all the way back) -- the audit finding
// this rework fixes was that undoing a parameter's very first commit removed
// its node without cascading to dependents, which this golden's original
// 10-edit-only scope never exercised.

describe('AC #5: undo/redo restores table value + dependent feature state together', () => {
  it('10 sequential edits, undo all 10, redo all 10 -- state matches the golden snapshot at every step; genesis boundary too', async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const seenWidths: number[] = []
    const kernelOp: FeatureOp = async (node) => {
      if (node.id === 'F1') seenWidths.push(dag.getNode(paramNodeId('width'))?.payload.value as number)
      return { ok: true, diagnostics: [] }
    }
    const table = new ParameterTable(dag, scheduler, kernelOp)

    // Genesis (not part of the 10-deep undo/redo cycle below).
    await table.setExpression('base', '0')
    await table.setExpression('width', '2*base+3')
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    scheduler.markDirty('F1')
    await scheduler.run(table.executor)

    const lastSeen = () => seenWidths[seenWidths.length - 1]
    const snap = () => ({ base: table.valueOf('base'), width: table.valueOf('width'), f1: lastSeen() })

    const snapshots = [snap()]
    for (let i = 1; i <= 10; i++) {
      await table.setExpression('base', String(i))
      expect(table.valueOf('width')).toBe(2 * i + 3)
      expect(lastSeen()).toBe(2 * i + 3)
      snapshots.push(snap())
    }
    expect(snapshots).toHaveLength(11)

    // Undo all 10 edits, one at a time; state must match the PRIOR snapshot
    // (both the table's own value AND F1's observed value) after each step.
    for (let k = 1; k <= 10; k++) {
      expect(table.canUndo()).toBe(true)
      await table.undo()
      expect(snap()).toEqual(snapshots[10 - k])
    }
    expect(snap()).toEqual(snapshots[0])
    // Genesis's own 2 commands remain undoable; the 10-edit cycle is fully undone.
    expect(table.canUndo()).toBe(true)
    expect(table.canRedo()).toBe(true)

    // Redo all 10 edits, one at a time; state must match the NEXT snapshot.
    for (let k = 1; k <= 10; k++) {
      expect(table.canRedo()).toBe(true)
      await table.redo()
      expect(snap()).toEqual(snapshots[k])
    }
    expect(snap()).toEqual(snapshots[10])
    expect(table.canRedo()).toBe(false)
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])

    // WO DOC-4-R1.1: undo the 10-edit cycle a second time, then keep going
    // PAST it, through the genesis boundary, all the way to an empty table --
    // and back. (touchedPast was fully restored by the redo loop above, so
    // this repeats the same 10 edit-undos before reaching genesis.)
    for (let k = 1; k <= 10; k++) await table.undo()
    expect(snap()).toEqual(snapshots[0])

    expect(table.canUndo()).toBe(true)
    await table.undo() // pops width's genesis InsertNodeCommand (pushed after base's) -> removes width's node entirely
    expect(table.has('width')).toBe(false)
    // F1 consumed 'width' by ordinary DAG edge; it must degrade, never stay 'ok'.
    expect(scheduler.statusOf('F1')).not.toBe('ok')
    expect(scheduler.statusOf('F1')).toBe('degraded')
    expect(scheduler.diagnosticsOf('F1').some((d) => 'code' in d && d.code === 'UPSTREAM_REMOVED')).toBe(true)
    expect(table.has('base')).toBe(true)
    expect(table.valueOf('base')).toBe(0)

    expect(table.canUndo()).toBe(true)
    await table.undo() // undoes base's genesis insert -> table fully empty
    expect(table.has('base')).toBe(false)
    expect(table.has('width')).toBe(false)
    expect(table.canUndo()).toBe(false)
    expect(scheduler.hasRunning()).toBe(false)

    // Redo all the way back: width recomputes, F1 comes back 'ok' at 3
    // (base=0 -> width=2*0+3=3), matching snapshots[0].
    await table.redo()
    expect(table.has('base')).toBe(true)
    expect(table.valueOf('base')).toBe(0)
    await table.redo()
    expect(table.has('width')).toBe(true)
    expect(table.valueOf('width')).toBe(3)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(lastSeen()).toBe(3)

    // Redo the 10-edit cycle again -- full round-trip through genesis proves
    // the redo tail (built before the genesis undos) survived intact.
    for (let k = 1; k <= 10; k++) {
      await table.redo()
      expect(snap()).toEqual(snapshots[k])
    }
    expect(table.canRedo()).toBe(false)
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])
  })

  it("R1.1: undoing a parameter's genesis creation degrades a feature bound to it; redo restores it to 'ok' with the correct value", async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const table = new ParameterTable(dag, scheduler, async () => ({ ok: true, diagnostics: [] }))

    await table.setExpression('width', '10')
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    scheduler.markDirty('F1')
    await scheduler.run(table.executor)
    expect(scheduler.statusOf('F1')).toBe('ok')

    await table.undo() // undoes width's genesis creation
    expect(table.has('width')).toBe(false)
    expect(scheduler.statusOf('F1')).not.toBe('ok')

    await table.redo()
    expect(table.has('width')).toBe(true)
    expect(table.valueOf('width')).toBe(10)
    expect(scheduler.statusOf('F1')).toBe('ok')
  })

  it('R1.1: undoing genesis cascades PARAM_UNKNOWN_REFERENCE to a dependent PARAMETER (not just a feature)', async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const table = new ParameterTable(dag, scheduler)

    // width created FIRST (a legal forward reference to 'base', which does
    // not exist yet) so that base's OWN genesis commit is the LAST touched
    // command -- undo() only pops the most recent command, so base must be
    // undone last for this test to target base's removal specifically.
    await table.setExpression('width', 'base * 2')
    await table.setExpression('base', '10')
    expect(table.statusOf('width')).toBe('ok')
    expect(table.valueOf('width')).toBe(20)

    // Undo base's genesis creation -- base is gone; width must re-evaluate
    // and surface its OWN typed PARAM_UNKNOWN_REFERENCE (not silently 'ok').
    await table.undo()
    expect(table.has('base')).toBe(false)
    expect(table.statusOf('width')).toBe('failed')
    expect(table.diagnosticsOf('width').some((d) => 'code' in d && d.code === 'PARAM_UNKNOWN_REFERENCE')).toBe(true)
    // Never deleted, never silently stale-valued: last-good value retained.
    expect(table.valueOf('width')).toBe(20)

    await table.redo()
    expect(table.has('base')).toBe(true)
    expect(table.statusOf('width')).toBe('ok')
    expect(table.valueOf('width')).toBe(20)
  })

  it('undoing a single edit restores both the parameter value and the dependent feature status', async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const table = new ParameterTable(dag, scheduler, async () => ({ ok: true, diagnostics: [] }))

    await table.setExpression('base', '10')
    await table.setExpression('width', '100/base')
    expect(table.statusOf('width')).toBe('ok')
    expect(table.valueOf('width')).toBe(10)

    // Break it, then undo the break.
    await table.setExpression('base', '0')
    expect(table.statusOf('width')).toBe('failed')

    await table.undo()
    expect(table.valueOf('base')).toBe(10)
    expect(table.statusOf('width')).toBe('ok')
    expect(table.valueOf('width')).toBe(10)
    expect(table.diagnosticsOf('width')).toEqual([])

    await table.redo()
    expect(table.valueOf('base')).toBe(0)
    expect(table.statusOf('width')).toBe('failed')
  })
})
