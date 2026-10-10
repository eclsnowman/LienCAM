import { describe, it, expect } from 'vitest'
import { FeatureDag, ReorderBlockedError } from '../../doc/dag'
import { CommandHistory, ReorderNodeCommand } from '../../doc/commands'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist/format'

// WO UI-9 (BK-41): drag-reorder within featureOrder() + its dependency guard.
//
// Acceptance #1: a legal reorder moves the node within featureOrder(),
// leaving topoOrder() (regen's own execution order, a pure function of
// nodes+edges) completely untouched.
// Acceptance #2: an illegal reorder -- moving a feature above a producer it
// consumes, or below a consumer of its own output -- is refused with a
// structured ReorderBlockedError naming the blocking feature; checkReorder
// (the same underlying check, exposed read-only) agrees.
// Acceptance #3: reorder across the rollback marker follows UI-7 semantics.
// Acceptance #4: undo/redo round-trips a reorder.
// Acceptance #5: persistence round-trip (ADR-0027 discipline).

function chain(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'] })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'] })
  dag.insertNode({ id: 'D', kind: 'feature', consumes: ['C'] })
  return dag
}

/** Two independent (no consumes edge) siblings, plus a chained dependent -- the shape a legal, cosmetic reorder needs. */
function siblings(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'Base', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'X', kind: 'feature', consumes: ['Base'] })
  dag.insertNode({ id: 'Y', kind: 'feature', consumes: ['Base'] })
  return dag
}

describe('FeatureDag.checkReorder / reorderNode (WO UI-9, BK-41)', () => {
  it('a legal reorder among independent siblings moves featureOrder() without touching topoOrder()', () => {
    const dag = siblings()
    expect(dag.featureOrder()).toEqual(['Base', 'X', 'Y'])
    const topoBefore = dag.topoOrder()

    expect(dag.checkReorder('Y', 1)).toBeNull()
    const prior = dag.reorderNode('Y', 1)
    expect(prior).toBe(2)
    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
    // topoOrder is a pure function of nodes+edges, id tie-break -- unaffected
    // by a purely-cosmetic timeline permutation (dag.ts's determinism note).
    expect(dag.topoOrder()).toEqual(topoBefore)
  })

  it('refuses moving a feature ABOVE a producer it consumes (structured ReorderBlockedError naming the producer)', () => {
    const dag = chain()
    expect(dag.checkReorder('C', 0)).toEqual({ blockingId: 'B', direction: 'above' })
    let caught: unknown
    try {
      dag.reorderNode('C', 0)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ReorderBlockedError)
    const diag = (caught as ReorderBlockedError).diagnostic
    expect(diag.code).toBe('REORDER_BLOCKED')
    expect(diag.params).toEqual({ movedId: 'C', blockingId: 'B', direction: 'above' })
    expect((caught as Error).message).toMatch(/'C' uses 'B'/)
    expect((caught as Error).message).toMatch(/cannot move above it/)
    // The refused move mutates nothing.
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('refuses moving a feature BELOW a consumer of its own output (structured ReorderBlockedError naming the consumer)', () => {
    const dag = chain()
    expect(dag.checkReorder('B', 3)).toEqual({ blockingId: 'C', direction: 'below' })
    let caught: unknown
    try {
      dag.reorderNode('B', 3)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ReorderBlockedError)
    const diag = (caught as ReorderBlockedError).diagnostic
    expect(diag.params).toEqual({ movedId: 'B', blockingId: 'C', direction: 'below' })
    expect((caught as Error).message).toMatch(/'C' uses 'B'/)
    expect((caught as Error).message).toMatch(/cannot move below it/)
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('a no-op move (dropping onto its own current slot) is legal', () => {
    const dag = chain()
    expect(dag.checkReorder('B', 1)).toBeNull()
    expect(() => dag.reorderNode('B', 1)).not.toThrow()
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('moving the tail feature to the very front is illegal (its own producer chain blocks it)', () => {
    const dag = chain()
    expect(dag.checkReorder('D', 0)).toEqual({ blockingId: 'C', direction: 'above' })
  })

  it('moving the head feature to the very end is illegal (every downstream consumer blocks it)', () => {
    const dag = chain()
    expect(dag.checkReorder('A', 4)).toEqual({ blockingId: 'B', direction: 'below' })
  })

  it('checkReorder throws on an unknown node id', () => {
    const dag = chain()
    expect(() => dag.checkReorder('ZZ', 0)).toThrow(/no such node/i)
  })

  it('reorder respects the rollback marker (WO UI-9 mission #3): moving a feature below the marker rollback-suppresses it; moving it back above restores it', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'] })
    dag.insertNode({ id: 'E', kind: 'feature', consumes: [] }) // independent of A/B -- free to move
    expect(dag.featureOrder()).toEqual(['A', 'B', 'E'])

    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // anchored on B, which never moves
    expect(dag.isRolledBack('E')).toBe(true) // E sits after B -- below the marker

    dag.reorderNode('E', 1) // move E to sit between A and B -- above the marker
    expect(dag.featureOrder()).toEqual(['A', 'E', 'B'])
    expect(dag.isRolledBack('E')).toBe(false) // restored

    dag.reorderNode('E', 2) // move E back to the end -- below the marker again
    expect(dag.featureOrder()).toEqual(['A', 'B', 'E'])
    expect(dag.isRolledBack('E')).toBe(true) // rollback-suppressed again
  })

  it('reorder preserves suppress state (WO UI-9 mission #3): a suppressed feature stays suppressed after moving', () => {
    const dag = siblings()
    dag.setSuppressed('X', true)
    dag.reorderNode('X', 2)
    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
    expect(dag.isSuppressed('X')).toBe(true)
  })
})

describe('ReorderNodeCommand (WO UI-9 mission #4: command surface, undo/redo)', () => {
  it('AC #4: undo/redo round-trips a reorder', () => {
    const dag = siblings()
    const history = new CommandHistory(dag)

    history.execute(new ReorderNodeCommand('Y', 1))
    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])

    expect(history.undo()).toBe(true)
    expect(dag.featureOrder()).toEqual(['Base', 'X', 'Y'])

    expect(history.redo()).toBe(true)
    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
  })

  it('a refused reorder never lands on the undo stack', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    expect(() => history.execute(new ReorderNodeCommand('C', 0))).toThrow(ReorderBlockedError)
    expect(history.canUndo()).toBe(false)
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('serialize() is plain JSON; undo before do() throws', () => {
    const cmd = new ReorderNodeCommand('Y', 1)
    expect(cmd.serialize()).toEqual({ type: 'reorderNode', id: 'Y', targetIndex: 1 })
    expect(() => cmd.undo(siblings())).toThrow(/never reordered/i)
  })
})

describe('Reorder persistence round-trip (WO UI-9 AC #5, ADR-0027 discipline)', () => {
  it('a reordered featureOrder() round-trips through createDocumentArchive/loadDocumentArchive', () => {
    const dag = siblings()
    dag.reorderNode('Y', 1)
    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])

    const archive = createDocumentArchive({
      dag,
      elementMapDeltas: [],
      rollback: { featureOrder: dag.featureOrder(), marker: dag.getRollbackMarker() },
    })
    const loaded = loadDocumentArchive(archive)
    expect(loaded.dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
    expect(loaded.dag.topoOrder()).toEqual(dag.topoOrder())
  })
})
