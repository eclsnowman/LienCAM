import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { CommandHistory, SetSuppressedCommand } from '../../doc/commands'

// WO UI-6 (BK-39): FeatureDag's suppress flag + cascade derivation, and the
// undo/redo-safe command that toggles it.
//
// AC #2 (cascade correctness): a strict A -> B -> C chain (B consumes A, C
// consumes B). Suppressing B must make C effectively suppressed (cascade,
// C's OWN flag stays false) while A -- upstream of B -- is untouched.
// Unsuppressing B must restore C.

function chain(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'] })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'] })
  return dag
}

describe('FeatureDag suppress flag + cascade (WO UI-6, BK-39)', () => {
  it('a fresh node is unsuppressed, root and cascade both false', () => {
    const dag = chain()
    for (const id of ['A', 'B', 'C']) {
      expect(dag.isSuppressed(id)).toBe(false)
      expect(dag.isEffectivelySuppressed(id)).toBe(false)
      expect(dag.getNode(id)!.suppressed).toBe(false)
    }
  })

  it('setSuppressed sets the OWN flag and returns the PRIOR value (mirrors setConsumes/setPayload)', () => {
    const dag = chain()
    expect(dag.setSuppressed('B', true)).toBe(false)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(dag.setSuppressed('B', false)).toBe(true)
    expect(dag.isSuppressed('B')).toBe(false)
  })

  it('AC #2: suppressing B cascades to C (its downstream consumer) but leaves A (its upstream producer) untouched', () => {
    const dag = chain()
    dag.setSuppressed('B', true)

    expect(dag.isSuppressed('B')).toBe(true)
    expect(dag.isEffectivelySuppressed('B')).toBe(true)

    // C consumes B -- effectively suppressed by cascade, but its OWN flag
    // stays false (own state, never conflated with root suppression).
    expect(dag.isSuppressed('C')).toBe(false)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)

    // A is upstream of B (B consumes A) -- not in B's downstream closure --
    // untouched entirely.
    expect(dag.isSuppressed('A')).toBe(false)
    expect(dag.isEffectivelySuppressed('A')).toBe(false)
  })

  it('AC #2: unsuppressing B restores C', () => {
    const dag = chain()
    dag.setSuppressed('B', true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)

    dag.setSuppressed('B', false)
    expect(dag.isEffectivelySuppressed('B')).toBe(false)
    expect(dag.isEffectivelySuppressed('C')).toBe(false)
    expect(dag.isEffectivelySuppressed('A')).toBe(false)
  })

  it('cascade walks a transitive chain longer than one hop (D consumes C consumes B consumes A, suppress A)', () => {
    const dag = chain()
    dag.insertNode({ id: 'D', kind: 'feature', consumes: ['C'] })
    dag.setSuppressed('A', true)
    expect(dag.isEffectivelySuppressed('A')).toBe(true)
    expect(dag.isEffectivelySuppressed('B')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)
    expect(dag.isEffectivelySuppressed('D')).toBe(true)
  })

  it('a diamond: suppressing one branch only cascades through the nodes that actually consume it', () => {
    // F1 -> F2 -> F4, F1 -> F3 -> F4 (F4 consumes both F2 and F3).
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F2', 'F3'] })
    dag.setSuppressed('F2', true)

    expect(dag.isEffectivelySuppressed('F1')).toBe(false)
    expect(dag.isEffectivelySuppressed('F3')).toBe(false)
    // F4 consumes F2 (suppressed) -- cascade-suppressed even though F3 (its
    // other producer) is healthy.
    expect(dag.isEffectivelySuppressed('F4')).toBe(true)
  })

  it('setSuppressed/isSuppressed/isEffectivelySuppressed throw on a nonexistent node (fail loud, same as setConsumes)', () => {
    const dag = chain()
    expect(() => dag.setSuppressed('nope', true)).toThrow(/no such node/i)
    expect(() => dag.isSuppressed('nope')).toThrow(/no such node/i)
    expect(() => dag.isEffectivelySuppressed('nope')).toThrow(/no such node/i)
  })

  it('serialize()/restore() round-trip the suppressed flag byte-identically', () => {
    const dag = chain()
    dag.setSuppressed('B', true)
    const restored = FeatureDag.restore(dag.serialize())
    expect(restored.serialize()).toBe(dag.serialize())
    expect(restored.getNode('B')!.suppressed).toBe(true)
    expect(restored.isEffectivelySuppressed('C')).toBe(true)
  })
})

describe('SetSuppressedCommand (WO UI-6 mission #3: command surface, undo/redo)', () => {
  it('AC #3: undo/redo round-trips the whole cascade closure state', () => {
    const dag = chain()
    const history = new CommandHistory(dag)

    history.execute(new SetSuppressedCommand('B', true))
    expect(dag.isEffectivelySuppressed('B')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)
    expect(dag.isEffectivelySuppressed('A')).toBe(false)

    expect(history.undo()).toBe(true)
    expect(dag.isSuppressed('B')).toBe(false)
    expect(dag.isEffectivelySuppressed('B')).toBe(false)
    expect(dag.isEffectivelySuppressed('C')).toBe(false)

    expect(history.redo()).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)
  })

  it('serialize() is plain JSON (no class instances) and undo before do() throws', () => {
    const cmd = new SetSuppressedCommand('B', true)
    expect(cmd.serialize()).toEqual({ type: 'setSuppressed', id: 'B', suppressed: true })
    const dag = chain()
    expect(() => cmd.undo(dag)).toThrow(/never set/i)
  })

  it('a scripted suppress -> other edits -> undo-to-empty -> redo-to-forward sequence stays byte-identical (same golden-test idiom as commands.test.ts)', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    history.execute(new SetSuppressedCommand('B', true))
    history.execute(new SetSuppressedCommand('C', true)) // C also gets its OWN root flag now, stacked on the cascade
    const afterForward = dag.serialize()
    expect(dag.isSuppressed('C')).toBe(true)
    expect(dag.isEffectivelySuppressed('C')).toBe(true)

    expect(history.undo()).toBe(true)
    expect(history.undo()).toBe(true)
    expect(history.undo()).toBe(false)
    expect(dag.isSuppressed('B')).toBe(false)
    expect(dag.isSuppressed('C')).toBe(false)

    expect(history.redo()).toBe(true)
    expect(history.redo()).toBe(true)
    expect(dag.serialize()).toBe(afterForward)
  })
})
