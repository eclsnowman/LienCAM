// WO UI-8 (BK-42 mission #2): TreeFolderStore (design-tree folder grouping,
// entirely separate from FeatureDag) + the CompositeCommand/folderSuppressCommand
// surface that rides UI-6's suppress cascade for folder-level suppress toggles.

import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { TreeFolderStore } from '../../doc/folders'
import { CommandHistory, CompositeCommand, SetSuppressedCommand, folderSuppressCommand, isFolderSuppressed } from '../../doc/commands'

function chain(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'] })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'] })
  return dag
}

describe('TreeFolderStore CRUD (WO UI-8, BK-42)', () => {
  it('createFolder/list -- id-sorted, caller-assigned id (never minted internally)', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD2', 'Second')
    folders.createFolder('FLD1', 'First')
    expect(folders.list()).toEqual([
      { id: 'FLD1', name: 'First' },
      { id: 'FLD2', name: 'Second' },
    ])
  })

  it('createFolder throws on a duplicate id (fail loud, same discipline as FeatureDag.insertNode)', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    expect(() => folders.createFolder('FLD1', 'Dup')).toThrow(/already exists/i)
  })

  it('renameFolder returns the PRIOR name (undo-friendly prior-return pattern)', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    expect(folders.renameFolder('FLD1', 'Renamed')).toBe('First')
    expect(folders.getFolder('FLD1')?.name).toBe('Renamed')
  })

  it('setMembership / folderOf round-trip, and returns the PRIOR folderId', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    expect(folders.folderOf('A')).toBeNull()
    expect(folders.setMembership('A', 'FLD1')).toBeNull()
    expect(folders.folderOf('A')).toBe('FLD1')
    expect(folders.setMembership('A', null)).toBe('FLD1')
    expect(folders.folderOf('A')).toBeNull()
  })

  it('setMembership throws when the target folder does not exist', () => {
    const folders = new TreeFolderStore()
    expect(() => folders.setMembership('A', 'nope')).toThrow(/no such folder/i)
  })

  it('membersOf is id-sorted', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    folders.setMembership('C', 'FLD1')
    folders.setMembership('A', 'FLD1')
    folders.setMembership('B', 'FLD1')
    expect(folders.membersOf('FLD1')).toEqual(['A', 'B', 'C'])
  })

  it('removeFolder UNGROUPS members (never deletes them) and returns the removed folder + former members', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    folders.setMembership('A', 'FLD1')
    folders.setMembership('B', 'FLD1')

    const removed = folders.removeFolder('FLD1')
    expect(removed.folder).toEqual({ id: 'FLD1', name: 'First' })
    expect(removed.memberIds).toEqual(['A', 'B'])
    expect(folders.hasFolder('FLD1')).toBe(false)
    // Members survive, just ungrouped -- folders are display-only (file header).
    expect(folders.folderOf('A')).toBeNull()
    expect(folders.folderOf('B')).toBeNull()
  })

  it('removeFolder throws on a nonexistent id', () => {
    const folders = new TreeFolderStore()
    expect(() => folders.removeFolder('nope')).toThrow(/no such folder/i)
  })
})

describe('TreeFolderStore.serialize/restore (WO UI-8: persistence round-trip)', () => {
  it('round-trips folders + membership byte-for-byte', () => {
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'First')
    folders.createFolder('FLD2', 'Second')
    folders.setMembership('A', 'FLD1')
    folders.setMembership('B', 'FLD2')

    const snap = folders.serialize()
    const restored = TreeFolderStore.restore(snap)
    expect(restored.serialize()).toEqual(snap)
    expect(restored.folderOf('A')).toBe('FLD1')
    expect(restored.folderOf('B')).toBe('FLD2')
  })

  it('restore(undefined) -- a pre-UI-8 archive -- yields an empty store, never throws', () => {
    const restored = TreeFolderStore.restore(undefined)
    expect(restored.list()).toEqual([])
  })

  it('restore drops a membership entry naming a folder that is not also declared', () => {
    const restored = TreeFolderStore.restore({ folders: [], membership: { A: 'ghost' } })
    expect(restored.folderOf('A')).toBeNull()
  })
})

describe('WO UI-8 mission #2 invariant: folder mutation NEVER touches FeatureDag order/DAG', () => {
  it('creating a folder and moving a feature into it leaves featureOrder()/serialize() completely unchanged', () => {
    const dag = chain()
    const beforeOrder = dag.featureOrder()
    const beforeSerialized = dag.serialize()

    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Group')
    folders.setMembership('B', 'FLD1')

    expect(dag.featureOrder()).toEqual(beforeOrder)
    expect(dag.serialize()).toBe(beforeSerialized)
  })
})

describe('CompositeCommand (WO UI-8, general-purpose "N mutations, one undo step")', () => {
  it('do() applies every sub-command in order; undo() reverses them in REVERSE order', () => {
    const dag = chain()
    const history = new CommandHistory(dag)
    const composite = new CompositeCommand([new SetSuppressedCommand('A', true), new SetSuppressedCommand('B', true)])

    history.execute(composite)
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)

    expect(history.undo()).toBe(true) // ONE undo step reverses BOTH
    expect(dag.isSuppressed('A')).toBe(false)
    expect(dag.isSuppressed('B')).toBe(false)

    expect(history.redo()).toBe(true)
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
  })

  it('serialize() is plain JSON, one entry per sub-command', () => {
    const composite = new CompositeCommand([new SetSuppressedCommand('A', true), new SetSuppressedCommand('B', false)])
    expect(composite.serialize()).toEqual({
      type: 'composite',
      commands: [
        { type: 'setSuppressed', id: 'A', suppressed: true },
        { type: 'setSuppressed', id: 'B', suppressed: false },
      ],
    })
  })
})

describe('isFolderSuppressed / folderSuppressCommand (WO UI-8 mission #2)', () => {
  it('an empty folder is never reported suppressed', () => {
    const dag = chain()
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Group')
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(false)
  })

  it('AC #3: folder suppress toggle suppresses EVERY member as ONE undo step, rides UI-6 cascade for downstream consumers', () => {
    const dag = chain() // A -> B -> C
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Group')
    folders.setMembership('A', 'FLD1')
    folders.setMembership('B', 'FLD1')
    // C is NOT a folder member -- it should only ever be cascade-suppressed
    // (via consuming B), never root-suppressed by the folder toggle.

    const history = new CommandHistory(dag)
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(false)

    history.execute(folderSuppressCommand(dag, folders, 'FLD1'))
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(dag.isSuppressed('C')).toBe(false) // never touched directly...
    expect(dag.isEffectivelySuppressed('C')).toBe(true) // ...but cascade-suppressed via B
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(true)

    // Toggling again (folder unsuppress) restores per UI-6 rules: every
    // member's OWN flag clears, and C's cascade clears with it.
    history.execute(folderSuppressCommand(dag, folders, 'FLD1'))
    expect(dag.isSuppressed('A')).toBe(false)
    expect(dag.isSuppressed('B')).toBe(false)
    expect(dag.isEffectivelySuppressed('C')).toBe(false)
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(false)

    // AC #3: undo/redo round-trips the WHOLE folder toggle as one step.
    expect(history.undo()).toBe(true) // undoes the unsuppress -> back to all-suppressed
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(history.undo()).toBe(true) // undoes the suppress -> back to clean
    expect(dag.isSuppressed('A')).toBe(false)
    expect(dag.isSuppressed('B')).toBe(false)
  })

  it('a folder with a mix of suppressed/unsuppressed members toggles to fully suppressed first (not fully unsuppressed)', () => {
    const dag = chain()
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Group')
    folders.setMembership('A', 'FLD1')
    folders.setMembership('B', 'FLD1')
    dag.setSuppressed('A', true) // A already suppressed on its own merit; B is not

    const history = new CommandHistory(dag)
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(false) // not ALL members suppressed yet

    history.execute(folderSuppressCommand(dag, folders, 'FLD1'))
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(isFolderSuppressed(dag, folders, 'FLD1')).toBe(true)
  })
})
