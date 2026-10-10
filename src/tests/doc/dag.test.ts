import { describe, it, expect } from 'vitest'
import { FeatureDag, DagCycleError } from '../../doc/dag'
import type { DagNodeInput } from '../../doc/dag'

// AC #1: DAG store -- insert/remove/reorder with "consumes" edges; topological
// order derivable and DETERMINISTIC (golden test: same document built two
// ways -> identical serialized DAG); cycle insertion REFUSED with a
// structured error; NEGATIVE INVARIANT: no code path may consult insertion
// order for ordering ties -- ties break on stable node ids only.

const node = (partial: DagNodeInput): DagNodeInput => ({ consumes: [], refs: [], payload: {}, ...partial })

describe('FeatureDag node mutation (insert/remove/reorder)', () => {
  it('inserts nodes and returns them via getNode (a defensive clone, not a live reference)', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature' }))
    expect(dag.has('F1')).toBe(true)
    const got = dag.getNode('F1')!
    got.consumes.push('mutate-me')
    expect(dag.getNode('F1')!.consumes).toEqual([])
  })

  it('refuses to insert a node id that already exists', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature' }))
    expect(() => dag.insertNode(node({ id: 'F1', kind: 'feature' }))).toThrow(/already exists/i)
  })

  it('removeNode returns the full snapshot and drops the node', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature', payload: { size: 10 } }))
    const removed = dag.removeNode('F1')
    expect(removed.id).toBe('F1')
    expect(removed.payload).toEqual({ size: 10 })
    expect(dag.has('F1')).toBe(false)
  })

  it('removeNode on a nonexistent id throws', () => {
    const dag = new FeatureDag()
    expect(() => dag.removeNode('nope')).toThrow(/no such node/i)
  })

  it('a removed node leaves dangling consumes edges on survivors, tolerated as already-satisfied', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature' }))
    dag.insertNode(node({ id: 'F2', kind: 'feature', consumes: ['F1'] }))
    dag.removeNode('F1')
    // F2 still lists 'F1' in consumes, but F1 no longer exists -- topoOrder
    // must not block on it forever.
    expect(dag.topoOrder()).toEqual(['F2'])
  })

  it('setConsumes rewires a node\'s dependencies and returns the PRIOR list', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature' }))
    dag.insertNode(node({ id: 'F2', kind: 'feature' }))
    dag.insertNode(node({ id: 'F3', kind: 'feature', consumes: ['F1'] }))
    const prior = dag.setConsumes('F3', ['F1', 'F2'])
    expect(prior).toEqual(['F1'])
    expect(dag.getNode('F3')!.consumes).toEqual(['F1', 'F2'])
  })

  it('setRefs replaces a node\'s refs wholesale and returns the PRIOR list (WO SKC-5)', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature' }))
    dag.insertNode(node({ id: 'DP1', kind: 'datum', consumes: ['F1'], refs: [{ id: 'F1:BOX:zmax', kind: 'single-face' }] }))
    const prior = dag.setRefs('DP1', [{ id: 'F1:BOX:zmax:v2', kind: 'single-face' }])
    expect(prior).toEqual([{ id: 'F1:BOX:zmax', kind: 'single-face' }])
    expect(dag.getNode('DP1')!.refs).toEqual([{ id: 'F1:BOX:zmax:v2', kind: 'single-face' }])
  })

  it('refuses a node consuming itself (structured DagCycleError)', () => {
    const dag = new FeatureDag()
    expect(() => dag.insertNode(node({ id: 'F1', kind: 'feature', consumes: ['F1'] }))).toThrow(DagCycleError)
    dag.insertNode(node({ id: 'F2', kind: 'feature' }))
    expect(() => dag.setConsumes('F2', ['F2'])).toThrow(DagCycleError)
  })

  it('refuses an indirect cycle (A->B->C->A) with a structured error, and mutates nothing', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'A', kind: 'feature' }))
    dag.insertNode(node({ id: 'B', kind: 'feature', consumes: ['A'] }))
    dag.insertNode(node({ id: 'C', kind: 'feature', consumes: ['B'] }))
    // A consuming C would close the loop A->B->C->A.
    let caught: unknown
    try {
      dag.setConsumes('A', ['C'])
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DagCycleError)
    const diag = (caught as DagCycleError).diagnostic
    expect(diag.code).toBe('DAG_CYCLE')
    expect(diag.severity).toBe('error')
    expect(diag.params.consumer).toBe('A')
    expect(diag.params.producer).toBe('C')
    // The refused edge must not have been applied.
    expect(dag.getNode('A')!.consumes).toEqual([])
  })

  it('insertNode itself checks the new node\'s consumes list against the existing chain', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'A', kind: 'feature' }))
    dag.insertNode(node({ id: 'B', kind: 'feature', consumes: ['A'] }))
    // D consuming B is a normal forward-only edge (D depends on the existing
    // A->B chain) -- not a cycle, must succeed.
    expect(() => dag.insertNode(node({ id: 'D', kind: 'feature', consumes: ['B'] }))).not.toThrow()
    // Only AFTER D exists does rewiring A to consume D close a loop
    // (A->B->...no; concretely D->? none yet). Prove the real loop instead:
    // rewiring A to consume D would need D to depend on A first.
    dag.setConsumes('D', ['A'])
    // Now A -> B (unchanged) and A -> D -> ... D depends on A. Rewiring A to
    // ALSO consume D would close A -> D -> A.
    expect(() => dag.setConsumes('A', ['D'])).toThrow(DagCycleError)
  })
})

describe('deterministic topological order (ID tie-break, never insertion/array order)', () => {
  it('breaks ties between independent siblings by node id, regardless of insertion order', () => {
    const dagInsertZThenA = new FeatureDag()
    dagInsertZThenA.insertNode(node({ id: 'root', kind: 'feature' }))
    dagInsertZThenA.insertNode(node({ id: 'nodeZ', kind: 'feature', consumes: ['root'] }))
    dagInsertZThenA.insertNode(node({ id: 'nodeA', kind: 'feature', consumes: ['root'] }))

    const dagInsertAThenZ = new FeatureDag()
    dagInsertAThenZ.insertNode(node({ id: 'root', kind: 'feature' }))
    dagInsertAThenZ.insertNode(node({ id: 'nodeA', kind: 'feature', consumes: ['root'] }))
    dagInsertAThenZ.insertNode(node({ id: 'nodeZ', kind: 'feature', consumes: ['root'] }))

    // Both insertion orders must produce the SAME order: root, then nodeA
    // (alphabetically smaller), then nodeZ -- never the insertion order.
    expect(dagInsertZThenA.topoOrder()).toEqual(['root', 'nodeA', 'nodeZ'])
    expect(dagInsertAThenZ.topoOrder()).toEqual(['root', 'nodeA', 'nodeZ'])
  })

  it('golden test: the identical document built two different call orders serializes byte-identically', () => {
    const buildForward = () => {
      const dag = new FeatureDag()
      dag.insertNode(node({ id: 'F1', kind: 'feature', payload: { op: 'box' } }))
      dag.insertNode(node({ id: 'F3', kind: 'feature', payload: { op: 'box2' } }))
      dag.insertNode(
        node({
          id: 'F2',
          kind: 'feature',
          consumes: ['F1'],
          refs: [{ id: 'F1:BOX:zmax', kind: 'single-face' }],
          payload: { op: 'cut' },
        }),
      )
      return dag
    }
    const buildReversed = () => {
      const dag = new FeatureDag()
      dag.insertNode(
        node({
          id: 'F2',
          kind: 'feature',
          consumes: ['F1'],
          refs: [{ id: 'F1:BOX:zmax', kind: 'single-face' }],
          payload: { op: 'cut' },
        }),
      )
      dag.insertNode(node({ id: 'F3', kind: 'feature', payload: { op: 'box2' } }))
      dag.insertNode(node({ id: 'F1', kind: 'feature', payload: { op: 'box' } }))
      return dag
    }
    expect(buildForward().serialize()).toBe(buildReversed().serialize())
  })

  it('is a pure function of nodes+edges: reordering setConsumes calls in different sequences converges to the same serialization', () => {
    const a = new FeatureDag()
    a.insertNode(node({ id: 'A', kind: 'feature' }))
    a.insertNode(node({ id: 'B', kind: 'feature' }))
    a.insertNode(node({ id: 'C', kind: 'feature' }))
    a.setConsumes('B', ['A'])
    a.setConsumes('C', ['A', 'B'])

    const b = new FeatureDag()
    b.insertNode(node({ id: 'C', kind: 'feature' }))
    b.insertNode(node({ id: 'A', kind: 'feature' }))
    b.insertNode(node({ id: 'B', kind: 'feature' }))
    b.setConsumes('C', ['A', 'B'])
    b.setConsumes('B', ['A'])

    expect(a.serialize()).toBe(b.serialize())
    expect(a.topoOrder()).toEqual(['A', 'B', 'C'])
  })
})

describe('FeatureDag.restore (structural round-trip)', () => {
  it('restore(serialize()) reproduces an equivalent dag', () => {
    const dag = new FeatureDag()
    dag.insertNode(node({ id: 'F1', kind: 'feature', payload: { op: 'box' } }))
    dag.insertNode(node({ id: 'F2', kind: 'feature', consumes: ['F1'], refs: [{ id: 'x', kind: 'face-set' }] }))
    const json = dag.serialize()
    const restored = FeatureDag.restore(json)
    expect(restored.serialize()).toBe(json)
    expect(restored.topoOrder()).toEqual(['F1', 'F2'])
  })
})
