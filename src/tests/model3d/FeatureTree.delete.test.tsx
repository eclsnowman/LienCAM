// @vitest-environment jsdom
//
// WO UI-12 (BK-73) acceptance #3 (both branches): the transitive-consumer
// delete guard, driven through the REAL FeatureTree confirm-dialog UI plus a
// CommandHistory-backed delete handler mirroring SolidsWorkbenchPage.
// handleDelete's own shape exactly (render-gate rule: React Testing Library
// render(), never a store/test-harness proxy).
//
// WO UI-12-R1 (Finding 1, major): the audit held that delete-undo restores
// the removed nodes but NOT their original featureOrder() position when the
// deleted closure is not already a suffix of the tree -- dag.serialize()
// (used by the AC #3a/#3b tests above) is BLIND to featureOrder(), so those
// tests never actually proved restore position. The tests below assert
// dag.featureOrder() directly (list-equality, not just membership) for a
// closure that sits in the MIDDLE of the tree.

import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import { CommandHistory, CompositeCommand, FeatureDag, RemoveNodeCommand, markerInsertIndex } from '../../doc'

afterEach(cleanup)

/** A -> B -> C -> D: a 3-deep transitive chain past the direct-consumer
 *  boundary (B is A's only DIRECT consumer; C and D are only reachable by
 *  walking the closure) -- AC #3b's "transitive requirement bites" case. */
function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Base' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
  dag.insertNode({ id: 'D', kind: 'feature', consumes: ['C'], payload: { name: 'Chamfer' } })
  return dag
}

/** Mirrors SolidsWorkbenchPage.handleDelete's exact shape: leaf-first removal
 *  order (deepest consumer first) so CompositeCommand's own reverse-order
 *  undo restores producer before consumer. */
function DeleteHarness({ dag, history }: { dag: FeatureDag; history: CommandHistory }) {
  const [, bump] = useState(0)
  const rerender = () => bump((v) => v + 1)

  const handleDelete = (id: string): void => {
    const idsToRemove = new Set([id, ...dag.transitiveConsumersOf(id)])
    const removalOrder = dag.featureOrder().filter((nid) => idsToRemove.has(nid)).reverse()
    const cmd =
      removalOrder.length > 1
        ? new CompositeCommand(removalOrder.map((nid) => new RemoveNodeCommand(nid)), 'deleteFeature')
        : new RemoveNodeCommand(id)
    history.execute(cmd)
    rerender()
  }

  return <FeatureTree dag={dag} del={{ consumersOf: (id) => dag.transitiveConsumersOf(id), onDelete: handleDelete }} />
}

describe('FeatureTree delete guard (WO UI-12, BK-73 mission #4)', () => {
  it('AC #3a: a leaf feature (zero consumers) -> plain confirm naming it, delete removes it, undo restores it byte-identical', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<DeleteHarness dag={dag} history={history} />)
    const before = dag.serialize()

    fireEvent.keyDown(screen.getByTestId('feature-row-D'), { key: 'Delete' })
    const dialog = screen.getByTestId('tree-delete-confirm')
    expect(dialog.textContent).toContain('Chamfer')
    expect(screen.queryByTestId('tree-delete-confirm-consumers')).toBeNull()

    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    expect(dag.has('D')).toBe(false)
    expect(screen.queryByTestId('feature-row-D')).toBeNull()

    expect(history.undo()).toBe(true)
    expect(dag.has('D')).toBe(true)
    // Byte-identical dag snapshot compare (structural round-trip), per AC #3a.
    expect(dag.serialize()).toBe(before)
  })

  it('AC #3b: a feature with a 3-deep transitive consumer chain names EVERY consumer (not just direct), deletes the whole closure in ONE undo step', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<DeleteHarness dag={dag} history={history} />)
    const before = dag.serialize()

    fireEvent.keyDown(screen.getByTestId('feature-row-A'), { key: 'Delete' })
    const consumers = screen.getByTestId('tree-delete-confirm-consumers')
    // Fails-if only the DIRECT consumer (B/"Cut") were listed -- C/"Fillet"
    // and D/"Chamfer" are only reachable transitively.
    expect(consumers.textContent).toContain('Cut')
    expect(consumers.textContent).toContain('Fillet')
    expect(consumers.textContent).toContain('Chamfer')
    expect(screen.getByTestId('tree-delete-confirm-consumer-0')).toBeTruthy()
    expect(screen.getByTestId('tree-delete-confirm-consumer-1')).toBeTruthy()
    expect(screen.getByTestId('tree-delete-confirm-consumer-2')).toBeTruthy()

    const sizeBefore = history.size()
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    for (const id of ['A', 'B', 'C', 'D']) expect(dag.has(id)).toBe(false)
    // ONE undo step for the whole closure.
    expect(history.size()).toBe(sizeBefore + 1)

    expect(history.undo()).toBe(true)
    for (const id of ['A', 'B', 'C', 'D']) expect(dag.has(id)).toBe(true)
    expect(dag.serialize()).toBe(before)
  })

  it('cancel leaves the dag completely untouched', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<DeleteHarness dag={dag} history={history} />)
    fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'Delete' })
    fireEvent.click(screen.getByTestId('tree-delete-confirm-cancel'))
    expect(screen.queryByTestId('tree-delete-confirm')).toBeNull()
    expect(dag.has('B')).toBe(true)
    expect(dag.has('C')).toBe(true)
  })

  it('deleting a sketch consumed by a feature follows the SAME guard', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch1' } })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { name: 'Extrude1', opType: 'extrude' } })
    const history = new CommandHistory(dag)
    render(<DeleteHarness dag={dag} history={history} />)

    fireEvent.keyDown(screen.getByTestId('feature-row-SK1'), { key: 'Delete' })
    expect(screen.getByTestId('tree-delete-confirm-consumers').textContent).toContain('Extrude1')
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    expect(dag.has('SK1')).toBe(false)
    expect(dag.has('F1')).toBe(false)
  })

  // WO UI-12-R1 (Finding 1, major, mechanism-class rework): the audit's
  // exact repro shape -- a deleted closure that sits in the MIDDLE of the
  // tree, not a suffix -- so append-on-restore (the pre-R1 bug) and
  // restore-at-index (the fix) produce OBSERVABLY DIFFERENT featureOrder()
  // results. dag.serialize() (used above) can't tell these apart; every test
  // below asserts dag.featureOrder() by list-equality instead.
  describe('mid-tree delete-undo restores ORIGINAL featureOrder position (WO UI-12-R1 Finding 1)', () => {
    /** A -> B -> C (C consumes B), plus E which consumes A ONLY -- E sits
     *  AFTER C in featureOrder but is NOT a consumer of B, so deleting B
     *  pulls in exactly {B, C}, leaving a real "hole" in the middle of the
     *  tree for undo to restore into (the audit's "not already a suffix"
     *  case). featureOrder() === ['A', 'B', 'C', 'E']. */
    function midTreeDag(): FeatureDag {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Base' } })
      dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
      dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
      dag.insertNode({ id: 'E', kind: 'feature', consumes: ['A'], payload: { name: 'Chamfer' } })
      return dag
    }

    /** A, B, C where NEITHER B nor C consumes the other -- deleting the
     *  mid-tree leaf B is a single (non-composite) RemoveNodeCommand.
     *  featureOrder() === ['A', 'B', 'C']. */
    function singleLeafDag(): FeatureDag {
      const dag = new FeatureDag()
      dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Base' } })
      dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
      dag.insertNode({ id: 'C', kind: 'feature', consumes: ['A'], payload: { name: 'Fillet' } })
      return dag
    }

    it('test 1 -- mid-tree closure: delete B (with consumer C) -> undo -> featureOrder() === [A,B,C,E] EXACTLY (fails-if append-on-restore yields [A,E,B,C])', () => {
      const dag = midTreeDag()
      const history = new CommandHistory(dag)
      render(<DeleteHarness dag={dag} history={history} />)
      expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'E'])

      fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'Delete' })
      expect(screen.getByTestId('tree-delete-confirm-consumers').textContent).toContain('Fillet')
      fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
      expect(dag.featureOrder()).toEqual(['A', 'E'])

      expect(history.undo()).toBe(true)
      // The fails-if bite: append-on-restore would yield ['A', 'E', 'B', 'C'].
      expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'E'])
    })

    it('test 2 -- single mid-tree leaf: delete B -> undo -> featureOrder() === [A,B,C] EXACTLY (fails-if append-on-restore yields [A,C,B])', () => {
      const dag = singleLeafDag()
      const history = new CommandHistory(dag)
      render(<DeleteHarness dag={dag} history={history} />)
      expect(dag.featureOrder()).toEqual(['A', 'B', 'C'])

      fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'Delete' })
      expect(screen.queryByTestId('tree-delete-confirm-consumers')).toBeNull() // B has no consumers
      fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
      expect(dag.featureOrder()).toEqual(['A', 'C'])

      expect(history.undo()).toBe(true)
      expect(dag.featureOrder()).toEqual(['A', 'B', 'C'])
    })

    it('test 3 -- active rollback marker interplay: marker between A and B survives test 1\'s delete+undo, resolving to the SAME slot (fails-if append-on-restore reorders the rolled-back set)', () => {
      const dag = midTreeDag()
      dag.setRollbackMarker({ kind: 'after', nodeId: 'A' }) // B, C, E all rolled back
      const priorSlot = markerInsertIndex(dag.featureOrder(), dag.getRollbackMarker())
      expect(dag.rolledBackIds()).toEqual(['B', 'C', 'E'])

      const history = new CommandHistory(dag)
      render(<DeleteHarness dag={dag} history={history} />)

      fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'Delete' })
      fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
      expect(history.undo()).toBe(true)

      // The marker's own node reference is untouched (A was never removed)...
      expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'A' })
      // ...and it still resolves to the identical insertion slot.
      expect(markerInsertIndex(dag.featureOrder(), dag.getRollbackMarker())).toBe(priorSlot)
      // The fails-if bite: append-on-restore leaves featureOrder() as
      // ['A','E','B','C'], so rolledBackIds() (which walks featureOrder() in
      // sequence) would report ['E','B','C'] instead of the original order.
      expect(dag.rolledBackIds()).toEqual(['B', 'C', 'E'])
    })

    it('test 4 -- redo sanity: undo -> redo re-removes the closure and yields the SAME featureOrder() as right after the original delete', () => {
      const dag = midTreeDag()
      const history = new CommandHistory(dag)
      render(<DeleteHarness dag={dag} history={history} />)

      fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'Delete' })
      fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
      const afterDelete = dag.featureOrder()
      expect(afterDelete).toEqual(['A', 'E'])

      expect(history.undo()).toBe(true)
      expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'E'])

      expect(history.redo()).toBe(true)
      expect(dag.featureOrder()).toEqual(afterDelete)
      expect(dag.has('B')).toBe(false)
      expect(dag.has('C')).toBe(false)
    })
  })
})
