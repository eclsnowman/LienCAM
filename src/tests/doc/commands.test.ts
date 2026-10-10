import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { CommandHistory, HISTORY_CAP, InsertNodeCommand, RemoveNodeCommand, SetConsumesCommand } from '../../doc/commands'

// AC #2: every mutation is a Command {do, undo, serialize}; a scripted
// box -> cut -> reorder -> delete sequence via commands only, then undo x N
// to empty and redo x N back, lands in a state whose serialized DAG is
// byte-identical to the forward pass (golden test). History cap 200 enforced
// and tested at the boundary.
//
// AC #5: undo/redo NEVER snapshots geometry -- command serialization is
// plain JSON (no BodyHandle/TessBuffers/ArrayBuffer anywhere).

describe('Command layer + replay-based undo/redo', () => {
  it('scripted box -> box2 -> cut -> reorder -> delete: undo to empty, redo back -> byte-identical serialized DAG', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)

    const commands = [
      new InsertNodeCommand({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { op: 'box', size: 10 } }),
      new InsertNodeCommand({ id: 'F3', kind: 'feature', consumes: [], refs: [], payload: { op: 'box', size: 5 } }),
      new InsertNodeCommand({
        id: 'F2',
        kind: 'feature',
        consumes: ['F1'],
        refs: [{ id: 'F1:BOX:zmax', kind: 'single-face' }],
        payload: { op: 'cut' },
      }),
      new SetConsumesCommand('F2', ['F1', 'F3']), // reorder: cut now also depends on box2
      new RemoveNodeCommand('F3'), // delete box2 (leaves a dangling consumes entry on F2, by design)
    ]

    for (const cmd of commands) history.execute(cmd)
    const afterForward = dag.serialize()
    expect(dag.getNode('F2')!.consumes).toEqual(['F1', 'F3'])
    expect(dag.has('F3')).toBe(false)

    // Undo all the way back to empty.
    for (let i = 0; i < commands.length; i++) expect(history.undo()).toBe(true)
    expect(history.undo()).toBe(false) // nothing left to undo
    expect(dag.nodeIds()).toEqual([])
    expect(dag.serialize()).toBe(new FeatureDag().serialize())

    // Redo all the way back forward.
    for (let i = 0; i < commands.length; i++) expect(history.redo()).toBe(true)
    expect(history.redo()).toBe(false) // nothing left to redo
    expect(dag.serialize()).toBe(afterForward)
  })

  it('execute() after undo() clears the redo tail (standard undo-stack semantics)', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(new InsertNodeCommand({ id: 'A', kind: 'feature', consumes: [], refs: [], payload: {} }))
    history.execute(new InsertNodeCommand({ id: 'B', kind: 'feature', consumes: [], refs: [], payload: {} }))
    history.undo() // B removed, redoable
    expect(history.canRedo()).toBe(true)
    history.execute(new InsertNodeCommand({ id: 'C', kind: 'feature', consumes: [], refs: [], payload: {} }))
    expect(history.canRedo()).toBe(false)
    expect(dag.nodeIds()).toEqual(['A', 'C'])
  })

  it('history cap: the 200 most-recent commands are undoable; older ones are permanent', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    const TOTAL = HISTORY_CAP + 5
    for (let i = 0; i < TOTAL; i++) {
      const id = `n${String(i).padStart(3, '0')}`
      history.execute(new InsertNodeCommand({ id, kind: 'feature', consumes: [], refs: [], payload: {} }))
    }
    expect(history.size()).toBe(HISTORY_CAP)
    expect(dag.nodeIds().length).toBe(TOTAL)

    let undone = 0
    while (history.undo()) undone++
    expect(undone).toBe(HISTORY_CAP)
    // The oldest 5 commands (n000..n004) were evicted from history before ever
    // being undone -- they remain permanently applied.
    expect(dag.nodeIds()).toEqual(['n000', 'n001', 'n002', 'n003', 'n004'])
  })

  it('command serialize() is plain JSON: no BodyHandle/TessBuffers/ArrayBuffer anywhere in the tree', () => {
    const dag = new FeatureDag()
    const history = new CommandHistory(dag)
    history.execute(new InsertNodeCommand({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { size: 10 } }))
    history.execute(
      new InsertNodeCommand({
        id: 'F2',
        kind: 'feature',
        consumes: ['F1'],
        refs: [{ id: 'F1:BOX:zmax', kind: 'single-face' }],
        payload: {},
      }),
    )
    history.execute(new SetConsumesCommand('F2', ['F1']))
    history.execute(new RemoveNodeCommand('F1'))

    const serialized = history.serialize()
    // Round-trips through JSON with zero loss -- proves every value is a plain
    // JSON primitive/array/object (a class instance, ArrayBuffer, or typed
    // array would either throw, stringify to "{}", or fail this deep-equal).
    const roundTripped = JSON.parse(JSON.stringify(serialized))
    expect(roundTripped).toEqual(serialized)

    const banned = ['BodyHandle', 'TessBuffers', 'ArrayBuffer', 'Float32Array', 'Uint32Array']
    const text = JSON.stringify(serialized)
    for (const word of banned) expect(text).not.toContain(word)

    assertPlainJson(serialized)
  })
})

/** Recursively asserts a value contains only JSON-plain data (no functions, no ArrayBuffer/TypedArray, no class instances other than plain objects/arrays). */
function assertPlainJson(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return
  if (t === 'function') throw new Error(`assertPlainJson: function found at ${path}`)
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error(`assertPlainJson: binary buffer found at ${path}`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertPlainJson(v, `${path}[${i}]`))
    return
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`assertPlainJson: non-plain object (${(value as object).constructor?.name}) found at ${path}`)
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertPlainJson(v, `${path}.${k}`)
    return
  }
  throw new Error(`assertPlainJson: unexpected type '${t}' at ${path}`)
}
