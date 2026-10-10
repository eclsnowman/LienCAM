// WO SKC-15C (audit major #3, verbatim): "A named genesis refusal can occur after earlier
// CompositeCommand members have already mutated the document, and CommandHistory records no undo
// entry when do() throws. Persisted/programmatic folder membership accepts genesis IDs, making this
// reachable from the real folder-suppress path; a collapsed restored folder can also hide a genesis
// row despite the permanent top-level requirement."
//
// Two independent failures, two fixes, tested here end to end:
//
//   (1) ATOMICITY. CompositeCommand.do() now rolls back every member that already ran if a later one
//       throws, so a mid-composite genesis refusal leaves NO partial mutation and CommandHistory's
//       "no undo entry on a throwing do()" is correct because nothing was mutated. Proved with a
//       CONSTRUCTED mid-composite refusal (the auditor's `[Remove F1, Remove datum:XY]`).
//
//   (2) THE JOIN POINT. TreeFolderStore.setMembership refuses a genesis id, and restore drops one, so
//       a genesis node can never become a folder member -- which is what made (1) reachable from the
//       REAL folder-suppress path. Proved by driving that real path.
import { describe, it, expect } from 'vitest'
import {
  BASE_PLANE_XY_NODE_ID,
  CommandHistory,
  CompositeCommand,
  FeatureDag,
  GenesisNodeError,
  RemoveNodeCommand,
  TreeFolderStore,
  folderSuppressCommand,
  isFolderSuppressed,
} from '../../doc'
import { seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'

const F1 = 'F1'
const F2 = 'F2'

function seededDag(): FeatureDag {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  return dag
}

describe('WO SKC-15C: a CompositeCommand is atomic -- a mid-composite genesis refusal survives nothing', () => {
  it('the auditor case: [Remove F1, Remove datum:XY] throws by name AND leaves F1 intact, with no undo entry', () => {
    const dag = seededDag()
    dag.insertNode({ id: F1, kind: 'feature', consumes: [], refs: [], payload: {} })
    const history = new CommandHistory(dag)

    const composite = new CompositeCommand([new RemoveNodeCommand(F1), new RemoveNodeCommand(BASE_PLANE_XY_NODE_ID)])
    // The genesis member throws by name...
    expect(() => history.execute(composite)).toThrow(GenesisNodeError)

    // FAILS-IF do() is not atomic (the pre-SKC-15C behavior): F1 was deleted and stayed deleted.
    expect(dag.has(F1)).toBe(true)
    expect(dag.has(BASE_PLANE_XY_NODE_ID)).toBe(true)
    // ...and because nothing was mutated, "no undo entry" is now correct rather than a silent hole.
    expect(history.canUndo()).toBe(false)
  })

  it('rollback is in REVERSE order and restores each member exactly (three members, the third refuses)', () => {
    const dag = seededDag()
    dag.insertNode({ id: F1, kind: 'feature', consumes: [], refs: [], payload: {} })
    dag.insertNode({ id: F2, kind: 'feature', consumes: [], refs: [], payload: {} })
    const order = dag.featureOrder()
    const history = new CommandHistory(dag)

    const composite = new CompositeCommand([
      new RemoveNodeCommand(F1),
      new RemoveNodeCommand(F2),
      new RemoveNodeCommand(BASE_PLANE_XY_NODE_ID), // refuses
    ])
    expect(() => history.execute(composite)).toThrow(GenesisNodeError)

    // Both features are back, at their ORIGINAL timeline positions (RemoveNodeCommand.undo restores
    // the captured index) -- the whole document is byte-for-byte pre-composite.
    expect(dag.featureOrder()).toEqual(order)
    expect(history.canUndo()).toBe(false)
  })

  it('a composite that does NOT refuse still applies wholesale and undoes as one step (no regression)', () => {
    const dag = seededDag()
    dag.insertNode({ id: F1, kind: 'feature', consumes: [], refs: [], payload: {} })
    dag.insertNode({ id: F2, kind: 'feature', consumes: [], refs: [], payload: {} })
    const history = new CommandHistory(dag)

    history.execute(new CompositeCommand([new RemoveNodeCommand(F1), new RemoveNodeCommand(F2)]))
    expect(dag.has(F1)).toBe(false)
    expect(dag.has(F2)).toBe(false)
    expect(history.canUndo()).toBe(true)
    history.undo()
    expect(dag.has(F1)).toBe(true)
    expect(dag.has(F2)).toBe(true)
  })
})

describe('WO SKC-15C: the folder JOIN point refuses genesis ids, so the real folder-suppress path is safe', () => {
  it('setMembership refuses a genesis id by name -- a genesis node can never join a folder', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Folder 1')
    // FAILS-IF the pre-SKC-15C behavior returns: the audit added datum:XY to a folder freely.
    expect(() => folders.setMembership(BASE_PLANE_XY_NODE_ID, 'FLD1')).toThrow(GenesisNodeError)
    expect(folders.folderOf(BASE_PLANE_XY_NODE_ID)).toBeNull()
    // Clearing membership is always allowed (it can only remove a stale entry).
    expect(() => folders.setMembership(BASE_PLANE_XY_NODE_ID, null)).not.toThrow()
  })

  it('the REAL folder-suppress path can never sweep a genesis node in, because it can never be a member', () => {
    const dag = seededDag()
    dag.insertNode({ id: F1, kind: 'feature', consumes: [], refs: [], payload: {} })
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Folder 1')
    folders.setMembership(F1, 'FLD1')
    // The audit's mixed folder [F1, datum:XY] cannot be built: the genesis add is refused at the join.
    expect(() => folders.setMembership(BASE_PLANE_XY_NODE_ID, 'FLD1')).toThrow(GenesisNodeError)

    const history = new CommandHistory(dag)
    // folderSuppressCommand builds one SetSuppressedCommand per MEMBER; the only member is F1.
    history.execute(folderSuppressCommand(dag, folders, 'FLD1'))
    expect(dag.isSuppressed(F1)).toBe(true)
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(true)
    // The genesis node was never touched, and undo restores the folder cleanly.
    expect(dag.has(BASE_PLANE_XY_NODE_ID)).toBe(true)
    history.undo()
    expect(dag.isSuppressed(F1)).toBe(false)
  })

  it('restore drops a persisted genesis membership (a hand-edited/corrupt folder archive)', () => {
    const restored = TreeFolderStore.restore({
      folders: [{ id: 'FLD1', name: 'Folder 1' }],
      membership: { [F1]: 'FLD1', [BASE_PLANE_XY_NODE_ID]: 'FLD1' },
    })
    // FAILS-IF restore obeys the archive: "TreeFolderStore.restore accepted origin membership" was the
    // audit's exact finding.
    expect(restored.folderOf(F1)).toBe('FLD1')
    expect(restored.folderOf(BASE_PLANE_XY_NODE_ID)).toBeNull()
    expect(restored.membersOf('FLD1')).toEqual([F1])
  })
})
