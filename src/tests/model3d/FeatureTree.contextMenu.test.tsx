// @vitest-environment jsdom
//
// WO UI-12 (BK-70/72/73) acceptance #1 + #4: right-click (or the keyboard
// equivalent) on a feature/sketch row opens a context menu with EXACTLY the
// item set -- "Move to folder" (submenu), "Delete...", sketch "Hide/Show",
// "Suppress/Unsuppress" -- driven through the REAL FeatureTree component (render-gate
// rule: React Testing Library render(), never a store/test-harness proxy).

import { useRef, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { FeatureTree, type FeatureTreeDeleteControls, type FeatureTreeFolderControls } from '../../components/model3d/tree'
import { FeatureDag, TreeFolderStore } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Box' } })
  dag.insertNode({ id: 'B', kind: 'sketch', consumes: ['A'], payload: { name: 'Sketch' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
  return dag
}

interface HarnessProps {
  dag: FeatureDag
  onToggleHidden?: (id: string) => void
  onToggleSuppress?: (id: string) => void
  onDelete?: (id: string) => void
  onEdit?: (id: string) => void
  withFolders?: boolean
}

/** Mirrors SolidsWorkbenchPage's own wiring shape (nextId-style caller-
 *  assigned folder ids, a plain onDelete callback standing in for the real
 *  CompositeCommand wiring FeatureTree.delete.test.tsx exercises directly)
 *  -- a real integration harness, not a mock of FeatureTree's props. */
function Harness({ dag, onToggleHidden, onToggleSuppress, onDelete, onEdit, withFolders }: HarnessProps) {
  const foldersRef = useRef(new TreeFolderStore())
  const [, bump] = useState(0)
  const rerender = () => bump((v) => v + 1)
  const folders = foldersRef.current

  const folderControls: FeatureTreeFolderControls | undefined = withFolders
    ? {
        list: folders.list(),
        folderOf: (id) => folders.folderOf(id),
        isCollapsed: () => false,
        isFolderSuppressed: () => false,
        onToggleCollapse: () => undefined,
        onCreateFolder: (name) => {
          folders.createFolder(`FLD${folders.list().length + 1}`, name)
          rerender()
        },
        onRenameFolder: () => undefined,
        onDeleteFolder: () => undefined,
        onMoveToFolder: (nodeId, folderId) => {
          folders.setMembership(nodeId, folderId)
          rerender()
        },
        onToggleFolderSuppress: () => undefined,
      }
    : undefined

  const del: FeatureTreeDeleteControls | undefined =
    onDelete !== undefined ? { consumersOf: (id) => dag.transitiveConsumersOf(id), onDelete } : undefined

  return (
    <FeatureTree
      dag={dag}
      hide={onToggleHidden !== undefined ? { isHidden: (id) => dag.getNode(id)?.hidden === true, onToggleHidden } : undefined}
      suppress={onToggleSuppress !== undefined ? { onToggleSuppress } : undefined}
      folders={folderControls}
      del={del}
      edit={onEdit !== undefined ? { editEntryFor: (id) => ({ onEdit: () => onEdit(id) }) } : undefined}
    />
  )
}

describe('FeatureTree context menu (WO UI-12, BK-70/72/73 mission #1)', () => {
  it('AC #1: right-click renders EXACTLY the sketch item set including Hide', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onToggleHidden={() => undefined} onToggleSuppress={() => undefined} onDelete={() => undefined} withFolders />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))

    const menu = screen.getByTestId('tree-context-menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual([
      'tree-context-menu-move-to-folder',
      'tree-context-menu-delete',
      'tree-context-menu-hide',
      'tree-context-menu-suppress',
    ])
  })

  it('AC #1: items are individually omitted when their backing control is not wired (same optional-affordance contract as the row buttons)', () => {
    const dag = chainDag()
    render(<Harness dag={dag} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    const menu = screen.getByTestId('tree-context-menu')
    expect(within(menu).queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('Hide is omitted from both sketch row and menu when its backing control is not wired', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onToggleSuppress={() => undefined} />)
    expect(screen.queryByTestId('feature-row-hide-B')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    expect(screen.queryByTestId('tree-context-menu-hide')).toBeNull()
  })

  it('removing the onContextMenu handler fails this test: right-click must open the menu', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    expect(screen.queryByTestId('tree-context-menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    expect(screen.getByTestId('tree-context-menu')).toBeTruthy()
  })

  it('Shift+F10 opens the same menu as a right-click (keyboard equivalent)', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onToggleHidden={() => undefined} onDelete={() => undefined} />)
    fireEvent.keyDown(screen.getByTestId('feature-row-B'), { key: 'F10', shiftKey: true })
    expect(screen.getByTestId('tree-context-menu')).toBeTruthy()
    expect(screen.getByTestId('tree-context-menu-hide')).toBeTruthy()
  })

  it('the "menu" key also opens it', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    fireEvent.keyDown(screen.getByTestId('feature-row-A'), { key: 'ContextMenu' })
    expect(screen.getByTestId('tree-context-menu')).toBeTruthy()
  })

  it('the backdrop closes the menu on an outside click', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-backdrop'))
    expect(screen.queryByTestId('tree-context-menu')).toBeNull()
  })

  it('Escape closes the menu', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.keyDown(screen.getByTestId('tree-context-menu'), { key: 'Escape' })
    expect(screen.queryByTestId('tree-context-menu')).toBeNull()
  })

  it('"Move to folder" moves membership through the real TreeFolderStore (assert folders store)', () => {
    const dag = chainDag()
    render(<Harness dag={dag} withFolders />)

    // Create a folder via the submenu's "New folder..." entry first.
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-move-to-folder'))
    fireEvent.click(screen.getByTestId('tree-context-menu-new-folder'))
    fireEvent.change(screen.getByTestId('tree-context-menu-new-folder-input'), { target: { value: 'Group 1' } })
    fireEvent.keyDown(screen.getByTestId('tree-context-menu-new-folder-input'), { key: 'Enter' })
    expect(screen.queryByTestId('tree-context-menu')).toBeNull() // creating closes the menu
    expect(screen.getByTestId('folder-chip-FLD1')).toBeTruthy()

    // Re-open on A, pick the real folder from the submenu list.
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-move-to-folder'))
    fireEvent.click(screen.getByTestId('tree-context-menu-folder-FLD1'))

    expect(screen.getByTestId('feature-row-folder-tag-A')).toBeTruthy()
  })

  it('"Remove from folder" only renders when the row is currently foldered, and clears membership', () => {
    const dag = chainDag()
    render(<Harness dag={dag} withFolders />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-move-to-folder'))
    expect(screen.queryByTestId('tree-context-menu-remove-from-folder')).toBeNull() // not foldered yet
    fireEvent.click(screen.getByTestId('tree-context-menu-new-folder'))
    fireEvent.change(screen.getByTestId('tree-context-menu-new-folder-input'), { target: { value: 'Group' } })
    fireEvent.keyDown(screen.getByTestId('tree-context-menu-new-folder-input'), { key: 'Enter' })

    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-move-to-folder'))
    fireEvent.click(screen.getByTestId('tree-context-menu-folder-FLD1'))
    expect(screen.getByTestId('feature-row-folder-tag-A')).toBeTruthy()

    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    fireEvent.click(screen.getByTestId('tree-context-menu-move-to-folder'))
    fireEvent.click(screen.getByTestId('tree-context-menu-remove-from-folder'))
    expect(screen.queryByTestId('feature-row-folder-tag-A')).toBeNull()
  })

  it('Delete key on a focused row opens the delete flow (fails if the Delete-key handler is removed)', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    expect(screen.queryByTestId('tree-delete-confirm')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('feature-row-C'), { key: 'Delete' })
    expect(screen.getByTestId('tree-delete-confirm')).toBeTruthy()
    expect(screen.getByTestId('tree-delete-confirm-title').textContent).toContain('Fillet')
  })

  it('"Delete..." in the context menu opens the SAME delete-confirm dialog', () => {
    const dag = chainDag()
    render(<Harness dag={dag} onDelete={() => undefined} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-C'))
    fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
    expect(screen.queryByTestId('tree-context-menu')).toBeNull()
    expect(screen.getByTestId('tree-delete-confirm')).toBeTruthy()
  })

  it('AC #4: context-menu Suppress calls the SAME onToggleSuppress command surface the row button uses (spy assert)', () => {
    const dag = chainDag()
    const onToggleSuppress = vi.fn()
    render(<Harness dag={dag} onToggleSuppress={onToggleSuppress} />)

    fireEvent.click(screen.getByTestId('feature-row-suppress-B'))
    expect(onToggleSuppress).toHaveBeenNthCalledWith(1, 'B')

    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    fireEvent.click(screen.getByTestId('tree-context-menu-suppress'))
    expect(onToggleSuppress).toHaveBeenNthCalledWith(2, 'B')
    expect(onToggleSuppress).toHaveBeenCalledTimes(2)
  })

  it('UI-53: sketch eye and context-menu Hide call the SAME toggle surface; feature rows get neither', () => {
    const dag = chainDag()
    const onToggleHidden = vi.fn()
    render(<Harness dag={dag} onToggleHidden={onToggleHidden} />)

    fireEvent.click(screen.getByTestId('feature-row-hide-B'))
    expect(onToggleHidden).toHaveBeenNthCalledWith(1, 'B')
    expect(screen.queryByTestId('feature-row-hide-A')).toBeNull()

    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    fireEvent.click(screen.getByTestId('tree-context-menu-hide'))
    expect(onToggleHidden).toHaveBeenNthCalledWith(2, 'B')
    expect(onToggleHidden).toHaveBeenCalledTimes(2)

    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    expect(screen.queryByTestId('tree-context-menu-hide')).toBeNull()
  })

  it('WO-215: an offset plane gets ordinary feature actions plus the persisted Hide surface', () => {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'datum:RP1',
      kind: 'datum',
      consumes: [],
      payload: {
        datumType: 'plane',
        planeKind: 'offset-plane',
        payloadSchema: 1,
        name: 'Fixture clearance',
        definition: { kind: 'offset', distance: 12.5, flipNormal: false },
      },
    })
    const onToggleHidden = vi.fn()
    const onToggleSuppress = vi.fn()
    const onDelete = vi.fn()
    const onEdit = vi.fn()
    render(
      <Harness
        dag={dag}
        onToggleHidden={onToggleHidden}
        onToggleSuppress={onToggleSuppress}
        onDelete={onDelete}
        onEdit={onEdit}
        withFolders
      />,
    )

    fireEvent.click(screen.getByTestId('feature-row-hide-datum:RP1'))
    expect(onToggleHidden).toHaveBeenCalledWith('datum:RP1')
    fireEvent.click(screen.getByTestId('feature-row-suppress-datum:RP1'))
    expect(onToggleSuppress).toHaveBeenCalledWith('datum:RP1')

    fireEvent.contextMenu(screen.getByTestId('feature-row-datum:RP1'))
    const menu = screen.getByTestId('tree-context-menu')
    expect(within(menu).getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'))).toEqual([
      'tree-context-menu-move-to-folder',
      'tree-context-menu-edit',
      'tree-context-menu-delete',
      'tree-context-menu-hide',
      'tree-context-menu-suppress',
    ])
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    expect(onEdit).toHaveBeenCalledWith('datum:RP1')
  })

  it('the Hide label reflects persisted sketch visibility independently of suppression', () => {
    const dag = chainDag()
    dag.setHidden('B', true)
    expect(dag.getNode('B')?.suppressed).toBe(false)
    render(<Harness dag={dag} onToggleHidden={() => undefined} onToggleSuppress={() => undefined} />)
    expect(screen.getByTestId('feature-row-hide-B').getAttribute('aria-pressed')).toBe('true')
    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    expect(screen.getByTestId('tree-context-menu-hide').textContent).toContain('Show')
    expect(screen.getByTestId('tree-context-menu-suppress').textContent).toContain('Suppress')
  })

  it('the menu\'s Suppress label reflects the row\'s current suppressed state', () => {
    const dag = chainDag()
    dag.setSuppressed('B', true)
    render(<Harness dag={dag} onToggleSuppress={() => undefined} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    expect(screen.getByTestId('tree-context-menu-suppress').textContent).toContain('Unsuppress')
  })
})
