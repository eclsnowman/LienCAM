import { describe, it, expect } from 'vitest'
import { FeatureDag, markerInsertIndex } from '../../doc/dag'
import { CommandHistory, InsertAtMarkerCommand, SetRollbackMarkerCommand } from '../../doc/commands'

// WO UI-7 (BK-40): rollback marker + explicit feature-timeline order, and the
// undo/redo-safe commands that move/insert against it.
//
// Acceptance #1 (dag layer): marker below feature N rolls back N+; marker to
// end restores everything EXCEPT nodes independently user-suppressed.
// Acceptance #2: insert-at-marker places the new feature at the marker; a
// consume of a below-marker output is refused with a plain reason.
// Acceptance #3: undo/redo round-trips marker moves and insert-at-marker.

function chain(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'] })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'] })
  dag.insertNode({ id: 'D', kind: 'feature', consumes: ['C'] })
  return dag
}

describe('FeatureDag.featureOrder (WO UI-7, BK-40)', () => {
  it('defaults to insertion order, distinct from nodeIds() alpha-sort', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'B', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
    expect(dag.featureOrder()).toEqual(['B', 'A']) // actual insertion sequence
    expect(dag.nodeIds()).toEqual(['A', 'B']) // alpha-sort -- a DIFFERENT sequence
  })

  it('removeNode drops the id from featureOrder(); restoreNode re-appends at the end', () => {
    const dag = chain()
    const removed = dag.removeNode('B')
    expect(dag.featureOrder()).toEqual(['A', 'C', 'D'])
    dag.restoreNode(removed)
    expect(dag.featureOrder()).toEqual(['A', 'C', 'D', 'B'])
  })
})

describe('markerInsertIndex (pure helper)', () => {
  it('resolves start/end/after against a featureOrder snapshot', () => {
    const order = ['A', 'B', 'C', 'D']
    expect(markerInsertIndex(order, { kind: 'start' })).toBe(0)
    expect(markerInsertIndex(order, { kind: 'end' })).toBe(4)
    expect(markerInsertIndex(order, { kind: 'after', nodeId: 'B' })).toBe(2)
    // A dangling marker (referenced node not in this order snapshot) fails open to 'end'.
    expect(markerInsertIndex(order, { kind: 'after', nodeId: 'ZZ' })).toBe(4)
  })
})

describe('FeatureDag.isRolledBack / rolledBackIds (WO UI-7, BK-40 mission #1)', () => {
  it('marker at end (default): nothing is rolled back', () => {
    const dag = chain()
    for (const id of ['A', 'B', 'C', 'D']) expect(dag.isRolledBack(id)).toBe(false)
    expect(dag.rolledBackIds()).toEqual([])
  })

  it('AC #1: marker after B rolls back C and D (>N), leaves A and B alone', () => {
    const dag = chain()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' })
    expect(dag.isRolledBack('A')).toBe(false)
    expect(dag.isRolledBack('B')).toBe(false)
    expect(dag.isRolledBack('C')).toBe(true)
    expect(dag.isRolledBack('D')).toBe(true)
    expect(dag.rolledBackIds()).toEqual(['C', 'D'])
  })

  it('marker at start: every feature is rolled back', () => {
    const dag = chain()
    dag.setRollbackMarker({ kind: 'start' })
    expect(dag.rolledBackIds()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('AC #1 interaction: marker to end restores everything EXCEPT a feature independently user-suppressed', () => {
    const dag = chain()
    dag.setSuppressed('C', true) // C is independently, individually suppressed
    dag.setRollbackMarker({ kind: 'after', nodeId: 'A' }) // rolls back B, C, D too
    expect(dag.isRolledBack('B')).toBe(true)
    expect(dag.isRolledBack('C')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)

    dag.setRollbackMarker({ kind: 'end' }) // move marker to the very end: restore everything...
    expect(dag.isRolledBack('B')).toBe(false)
    expect(dag.isRolledBack('C')).toBe(false)
    expect(dag.isRolledBack('D')).toBe(false)
    // ...except C, which stays suppressed on its OWN merit -- the marker
    // passing it never un-suppresses it (rollback-suppressed != user-suppressed).
    expect(dag.isSuppressed('C')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)
    // D consumes C (still suppressed) -- cascade-suppressed regardless of rollback.
    expect(dag.isEffectivelySuppressed('D')).toBe(true)
  })

  it('setRollbackMarker returns the PRIOR marker (undo-friendly prior-return pattern)', () => {
    const dag = chain()
    const prior1 = dag.setRollbackMarker({ kind: 'after', nodeId: 'B' })
    expect(prior1).toEqual({ kind: 'end' })
    const prior2 = dag.setRollbackMarker({ kind: 'start' })
    expect(prior2).toEqual({ kind: 'after', nodeId: 'B' })
  })

  it('setRollbackMarker throws on a nonexistent "after" node', () => {
    const dag = chain()
    expect(() => dag.setRollbackMarker({ kind: 'after', nodeId: 'nope' })).toThrow(/no such node/i)
  })

  it('isRolledBack fails open (false) if the marker node was removed out from under it', () => {
    const dag = chain()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' })
    dag.removeNode('B')
    expect(dag.isRolledBack('C')).toBe(false)
    expect(dag.isRolledBack('D')).toBe(false)
  })
})

describe('insertNode dependency guard (WO UI-7, BK-40 mission #3): new features may only consume outputs above the marker', () => {
  it('refuses (plain Error) to consume a rolled-back producer', () => {
    const dag = chain()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D rolled back
    expect(() => dag.insertNode({ id: 'E', kind: 'feature', consumes: ['C'] })).toThrow(/rolled back/i)
    expect(dag.has('E')).toBe(false) // refused BEFORE any mutation
  })

  it('accepts a new feature consuming an above-marker producer -- but a PLAIN insertNode still appends to the END of featureOrder(), which can itself land below the marker (this is exactly why InsertAtMarkerCommand exists: it inserts at the marker slot AND moves the marker, see below)', () => {
    const dag = chain()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D already below the marker
    expect(() => dag.insertNode({ id: 'E', kind: 'feature', consumes: ['B'] })).not.toThrow()
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(dag.isRolledBack('E')).toBe(true) // appended past C/D, which are below the marker
  })

  it('is a no-op (never fires) while the marker is at "end" (default, not rolled back)', () => {
    const dag = chain()
    expect(() => dag.insertNode({ id: 'E', kind: 'feature', consumes: ['D'] })).not.toThrow()
  })
})

describe('SetRollbackMarkerCommand (WO UI-7 mission #4: command surface, undo/redo)', () => {
  it('AC #3: undo/redo round-trips a marker move', () => {
    const dag = chain()
    const history = new CommandHistory(dag)

    history.execute(new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'B' }))
    expect(dag.rolledBackIds()).toEqual(['C', 'D'])

    expect(history.undo()).toBe(true)
    expect(dag.getRollbackMarker()).toEqual({ kind: 'end' })
    expect(dag.rolledBackIds()).toEqual([])

    expect(history.redo()).toBe(true)
    expect(dag.rolledBackIds()).toEqual(['C', 'D'])
  })

  it('serialize() is plain JSON; undo before do() throws', () => {
    const cmd = new SetRollbackMarkerCommand({ kind: 'after', nodeId: 'B' })
    expect(cmd.serialize()).toEqual({ type: 'setRollbackMarker', marker: { kind: 'after', nodeId: 'B' } })
    expect(() => cmd.undo(chain())).toThrow(/never set/i)
  })
})

describe('InsertAtMarkerCommand (WO UI-7 mission #3/#4)', () => {
  it('AC #2: inserts the new feature at the marker position and moves the marker to sit after it', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D rolled back

    history.execute(new InsertAtMarkerCommand({ id: 'E', kind: 'feature', consumes: ['B'] }))

    expect(dag.featureOrder()).toEqual(['A', 'B', 'E', 'C', 'D'])
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'E' })
    // E is the new active tip -- not rolled back...
    expect(dag.isRolledBack('E')).toBe(false)
    // ...C and D, already rolled back, stay rolled back below it.
    expect(dag.isRolledBack('C')).toBe(true)
    expect(dag.isRolledBack('D')).toBe(true)
  })

  it('AC #2: refuses a consume of a below-marker output with a plain reason, inserting nothing', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D rolled back

    expect(() => history.execute(new InsertAtMarkerCommand({ id: 'E', kind: 'feature', consumes: ['C'] }))).toThrow(/rolled back/i)
    expect(dag.has('E')).toBe(false)
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'B' }) // marker untouched by the refused attempt
  })

  it('inserts at the very end when the marker is at "end" (not rolled back) -- degenerate case, same as a normal append', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    history.execute(new InsertAtMarkerCommand({ id: 'E', kind: 'feature', consumes: ['D'] }))
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'E' })
  })

  it('AC #3: undo removes the inserted node AND restores the prior marker; redo replays both', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' })

    history.execute(new InsertAtMarkerCommand({ id: 'E', kind: 'feature', consumes: ['B'] }))
    expect(dag.has('E')).toBe(true)

    expect(history.undo()).toBe(true)
    expect(dag.has('E')).toBe(false)
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'B' })
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])

    expect(history.redo()).toBe(true)
    expect(dag.has('E')).toBe(true)
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'E' })
    expect(dag.featureOrder()).toEqual(['A', 'B', 'E', 'C', 'D'])
  })

  it('serialize() is plain JSON; undo before do() throws', () => {
    const input = { id: 'E', kind: 'feature' as const, consumes: ['B'] }
    const cmd = new InsertAtMarkerCommand(input)
    expect(cmd.serialize()).toEqual({ type: 'insertAtMarker', input })
    expect(() => cmd.undo(chain())).toThrow(/never inserted/i)
  })
})
