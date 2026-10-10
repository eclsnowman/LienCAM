// @vitest-environment jsdom
//
// WO UI-8 (BK-42 mission #2): design-tree folders v1 (root-only). Real
// render() driving the REAL TreeFolderStore + CommandHistory (render-gate
// rule) -- a small stateful harness owns re-render-on-mutation exactly like
// SolidsWorkbenchPage does, so this proves the actual wiring contract, not a
// mocked stand-in.

import { useRef, useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree, type FeatureTreeFolderControls } from '../../components/model3d/tree'
import { CommandHistory, FeatureDag, TreeFolderStore, folderSuppressCommand, isFolderSuppressed } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Box' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
  return dag
}

function dataTransferStub(payload: string) {
  return { getData: () => payload, setData: () => undefined }
}

/** Mirrors SolidsWorkbenchPage's own folder-wiring shape (nextId-style
 *  caller-assigned ids, CommandHistory only for the suppress-cascade
 *  toggle) -- a real integration harness, not a mock of FeatureTree's props. */
function Harness({ dag, history }: { dag: FeatureDag; history: CommandHistory }) {
  const foldersRef = useRef(new TreeFolderStore())
  const collapsedRef = useRef(new Set<string>())
  const [, bump] = useState(0)
  const rerender = () => bump((v) => v + 1)
  const folders = foldersRef.current

  let nextFolderNum = 1
  const nextFolderId = (): string => {
    while (folders.hasFolder(`FLD${nextFolderNum}`)) nextFolderNum++
    return `FLD${nextFolderNum}`
  }

  const controls: FeatureTreeFolderControls = {
    list: folders.list(),
    folderOf: (id) => folders.folderOf(id),
    isCollapsed: (id) => collapsedRef.current.has(id),
    isFolderSuppressed: (id) => isFolderSuppressed(dag, folders, id),
    onToggleCollapse: (id) => {
      if (collapsedRef.current.has(id)) collapsedRef.current.delete(id)
      else collapsedRef.current.add(id)
      rerender()
    },
    onCreateFolder: (name) => {
      folders.createFolder(nextFolderId(), name)
      rerender()
    },
    onRenameFolder: (id, name) => {
      folders.renameFolder(id, name)
      rerender()
    },
    onDeleteFolder: (id) => {
      folders.removeFolder(id)
      rerender()
    },
    onMoveToFolder: (nodeId, folderId) => {
      folders.setMembership(nodeId, folderId)
      rerender()
    },
    onToggleFolderSuppress: (id) => {
      history.execute(folderSuppressCommand(dag, folders, id))
      rerender()
    },
  }

  return <FeatureTree dag={dag} folders={controls} />
}

describe('FeatureTree folders v1 (WO UI-8, BK-42 mission #2)', () => {
  it('no `folders` prop -> no folder strip, backward compatible', () => {
    render(<FeatureTree dag={chainDag()} />)
    expect(screen.queryByTestId('tree-folder-strip')).toBeNull()
  })

  it('create -> rename -> delete round-trips through the real TreeFolderStore, members ungroup on delete', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)

    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group 1' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    expect(screen.getByTestId('folder-chip-FLD1')).toBeTruthy()
    expect(screen.getByTestId('folder-name-FLD1').textContent).toBe('Group 1')

    // rename
    fireEvent.doubleClick(screen.getByTestId('folder-name-FLD1'))
    fireEvent.change(screen.getByTestId('folder-rename-input-FLD1'), { target: { value: 'Renamed' } })
    fireEvent.keyDown(screen.getByTestId('folder-rename-input-FLD1'), { key: 'Enter' })
    expect(screen.getByTestId('folder-name-FLD1').textContent).toBe('Renamed')

    // move A into the folder (drag-and-drop)
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('A') })
    expect(screen.getByTestId('feature-row-folder-tag-A')).toBeTruthy()

    // delete the folder -- A survives, ungrouped
    fireEvent.click(screen.getByTestId('folder-delete-FLD1'))
    expect(screen.queryByTestId('folder-chip-FLD1')).toBeNull()
    expect(screen.getByTestId('feature-row-A')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-folder-tag-A')).toBeNull()
  })

  it('drag a feature into a folder, then drop on the Root zone to ungroup it', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)

    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })

    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('B') })
    expect(screen.getByTestId('feature-row-folder-tag-B')).toBeTruthy()

    fireEvent.drop(screen.getByTestId('folder-chip-__root__'), { dataTransfer: dataTransferStub('B') })
    expect(screen.queryByTestId('feature-row-folder-tag-B')).toBeNull()
  })

  it('the per-row folder tag button also removes membership (click, no drag needed)', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('C') })
    expect(screen.getByTestId('feature-row-folder-tag-C')).toBeTruthy()

    fireEvent.click(screen.getByTestId('feature-row-folder-tag-C'))
    expect(screen.queryByTestId('feature-row-folder-tag-C')).toBeNull()
  })

  it('collapsing a folder hides its member rows; expanding restores them', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('B') })
    expect(screen.getByTestId('feature-row-B')).toBeTruthy()

    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    expect(screen.queryByTestId('feature-row-B')).toBeNull()
    // Non-member rows stay visible.
    expect(screen.getByTestId('feature-row-A')).toBeTruthy()

    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    expect(screen.getByTestId('feature-row-B')).toBeTruthy()
  })

  // Mission #2's binding invariant: "feature ORDER and DAG semantics are
  // unchanged by folder membership."
  it('mission #2 invariant: folder create/move/collapse/delete never touch featureOrder()/dag.serialize()', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    const beforeOrder = dag.featureOrder()
    const beforeSerialized = dag.serialize()
    render(<Harness dag={dag} history={history} />)

    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('C') })
    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    fireEvent.click(screen.getByTestId('folder-delete-FLD1'))

    expect(dag.featureOrder()).toEqual(beforeOrder)
    expect(dag.serialize()).toBe(beforeSerialized)
  })

  it('AC #3: folder suppress toggle cascades exactly per UI-6 semantics, undo/redo as one step', () => {
    const dag = chainDag() // A -> B -> C
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('A') })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('B') })

    const suppressButton = screen.getByTestId('folder-suppress-FLD1')
    expect(suppressButton.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(suppressButton)
    expect(dag.isSuppressed('A')).toBe(true)
    expect(dag.isSuppressed('B')).toBe(true)
    expect(dag.isSuppressed('C')).toBe(false) // C is not a folder member
    expect(dag.isEffectivelySuppressed('C')).toBe(true) // cascade via B
    expect(screen.getByTestId('folder-suppress-FLD1').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('feature-row-suppressed-glyph-A')).toBeTruthy()

    expect(history.undo()).toBe(true) // ONE undo step for both members
    expect(dag.isSuppressed('A')).toBe(false)
    expect(dag.isSuppressed('B')).toBe(false)
  })

  it('WO UI-12 (BK-70 mission #2): folder chips light up as drop targets for the WHOLE drag, not just on hover (persistent affordance)', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })

    expect(screen.getByTestId('folder-chip-FLD1').dataset.dropActive).toBe('false')
    expect(screen.getByTestId('folder-chip-__root__').dataset.dropActive).toBe('false')

    // Lit the instant the drag STARTS -- never mind whether the cursor is
    // actually over the chip yet (no dragover fired here at all).
    fireEvent.dragStart(screen.getByTestId('feature-row-A'), { dataTransfer: dataTransferStub('A') })
    expect(screen.getByTestId('folder-chip-FLD1').dataset.dropActive).toBe('true')
    expect(screen.getByTestId('folder-chip-__root__').dataset.dropActive).toBe('true')

    fireEvent.dragEnd(screen.getByTestId('feature-row-A'))
    expect(screen.getByTestId('folder-chip-FLD1').dataset.dropActive).toBe('false')
  })

  it('WO UI-12 (BK-70 mission #2): an empty folder shows the persistent "drag features here" hint; a folder with a member does not', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })

    // Rendered unconditionally while empty -- no drag or hover needed.
    expect(screen.getByTestId('folder-empty-hint-FLD1')).toBeTruthy()

    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('A') })
    expect(screen.queryByTestId('folder-empty-hint-FLD1')).toBeNull()

    fireEvent.drop(screen.getByTestId('folder-chip-__root__'), { dataTransfer: dataTransferStub('A') })
    expect(screen.getByTestId('folder-empty-hint-FLD1')).toBeTruthy()
  })

  it('render smoke: folder strip + chip + collapsed member render without throwing across every state', () => {
    const dag = chainDag()
    const history = new CommandHistory(dag)
    const { unmount } = render(<Harness dag={dag} history={history} />)
    fireEvent.click(screen.getByTestId('tree-new-folder-button'))
    fireEvent.change(screen.getByTestId('tree-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-new-folder-input'), { key: 'Enter' })
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('A') })
    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    fireEvent.click(screen.getByTestId('folder-suppress-FLD1'))
    expect(screen.getByTestId('tree-folder-strip')).toBeTruthy()
    unmount()
  })
})
