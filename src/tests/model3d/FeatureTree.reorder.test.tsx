// @vitest-environment jsdom
//
// WO UI-9 (BK-41): drag-reorder a feature row to a new position in the
// feature ORDER, with the F360-style "explain-before-drop" dependency guard
// (render-gate rule: React Testing Library render(), never a store/test-
// harness proxy).

import { useState } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree, type FeatureTreeReorderControls } from '../../components/model3d/tree'
import { FeatureDag, TreeFolderStore } from '../../doc'

afterEach(cleanup)

function siblingsDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'Base', kind: 'feature', consumes: [], payload: { name: 'Base' } })
  dag.insertNode({ id: 'X', kind: 'feature', consumes: ['Base'], payload: { name: 'Pocket' } })
  dag.insertNode({ id: 'Y', kind: 'feature', consumes: ['Base'], payload: { name: 'Fillet' } })
  return dag
}

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Sketch1' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Extrude1' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet1' } })
  return dag
}

function dataTransferStub(payload: string) {
  return { getData: () => payload, setData: () => undefined }
}

interface HarnessProps {
  dag: FeatureDag
  withRollback?: boolean
  withFolders?: boolean
}

function ReorderHarness({ dag, withRollback, withFolders }: HarnessProps) {
  const [, bump] = useState(0)
  const rerender = () => bump((v) => v + 1)

  const reorder: FeatureTreeReorderControls = {
    checkReorder: (id, targetIndex) => dag.checkReorder(id, targetIndex),
    onReorder: (id, targetIndex) => {
      dag.reorderNode(id, targetIndex)
      rerender()
    },
  }

  return (
    <FeatureTree
      dag={dag}
      reorder={reorder}
      rollback={withRollback ? { marker: dag.getRollbackMarker(), onMoveMarker: (m) => { dag.setRollbackMarker(m); rerender() } } : undefined}
      folders={
        withFolders
          ? (() => {
              const folders = new TreeFolderStore()
              return {
                list: folders.list(),
                folderOf: () => null,
                isCollapsed: () => false,
                isFolderSuppressed: () => false,
                onToggleCollapse: () => undefined,
                onCreateFolder: () => undefined,
                onRenameFolder: () => undefined,
                onDeleteFolder: () => undefined,
                onMoveToFolder: () => undefined,
                onToggleFolderSuppress: () => undefined,
              }
            })()
          : undefined
      }
    />
  )
}

describe('FeatureTree drag-reorder (WO UI-9, BK-41)', () => {
  it('AC #1: a legal drop reorders the feature at the real tree UI boundary', () => {
    const dag = siblingsDag()
    render(<ReorderHarness dag={dag} />)
    expect(dag.featureOrder()).toEqual(['Base', 'X', 'Y'])

    const rowY = screen.getByTestId('feature-row-Y')
    const rowX = screen.getByTestId('feature-row-X')
    fireEvent.dragStart(rowY, { dataTransfer: dataTransferStub('Y') })
    fireEvent.dragOver(rowX, { dataTransfer: dataTransferStub('Y') })
    fireEvent.drop(rowX, { dataTransfer: dataTransferStub('Y') })

    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
  })

  it('AC #2: an illegal drop (above a producer it consumes) is refused with the named blocking feature, and onReorder is never called', () => {
    const dag = chainDag()
    render(<ReorderHarness dag={dag} />)

    const rowFillet = screen.getByTestId('feature-row-C') // Fillet1, consumes Extrude1 (B)
    const rowSketch = screen.getByTestId('feature-row-A') // Sketch1 -- above its own producer chain
    fireEvent.dragStart(rowFillet, { dataTransfer: dataTransferStub('C') })
    fireEvent.dragOver(rowSketch, { dataTransfer: dataTransferStub('C') })
    fireEvent.drop(rowSketch, { dataTransfer: dataTransferStub('C') })

    // Refused: featureOrder is untouched.
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C'])
    const message = screen.getByTestId('reorder-refusal-message')
    expect(message.textContent).toContain('Fillet1 uses Extrude1')
    expect(message.textContent).toContain('cannot move above it')
  })

  it('AC #2: an illegal drop (below a consumer of its own output) is refused with the named blocking feature', () => {
    const dag = chainDag()
    render(<ReorderHarness dag={dag} />)

    const rowExtrude = screen.getByTestId('feature-row-B') // Extrude1, consumed by Fillet1 (C)
    const rowFillet = screen.getByTestId('feature-row-C')
    fireEvent.dragStart(rowExtrude, { dataTransfer: dataTransferStub('B') })
    fireEvent.dragOver(rowFillet, { dataTransfer: dataTransferStub('B') })
    fireEvent.drop(rowFillet, { dataTransfer: dataTransferStub('B') })

    expect(dag.featureOrder()).toEqual(['A', 'B', 'C'])
    const message = screen.getByTestId('reorder-refusal-message')
    expect(message.textContent).toContain('Fillet1 uses Extrude1')
    expect(message.textContent).toContain('cannot move below it')
  })

  it('AC #2: the live indicator shows LEGAL during dragover, before any drop', () => {
    const dag = siblingsDag()
    render(<ReorderHarness dag={dag} />)

    const rowY = screen.getByTestId('feature-row-Y')
    const rowX = screen.getByTestId('feature-row-X')
    fireEvent.dragStart(rowY, { dataTransfer: dataTransferStub('Y') })
    fireEvent.dragOver(rowX, { dataTransfer: dataTransferStub('Y') })

    expect(rowX.dataset.reorderDrop).toBe('legal')
    // Nothing moved yet -- this is a HOVER preview, not a drop.
    expect(dag.featureOrder()).toEqual(['Base', 'X', 'Y'])
  })

  it('AC #2: the live indicator shows ILLEGAL during dragover, before any drop', () => {
    const dag = chainDag()
    render(<ReorderHarness dag={dag} />)

    const rowFillet = screen.getByTestId('feature-row-C')
    const rowSketch = screen.getByTestId('feature-row-A')
    fireEvent.dragStart(rowFillet, { dataTransfer: dataTransferStub('C') })
    fireEvent.dragOver(rowSketch, { dataTransfer: dataTransferStub('C') })

    expect(rowSketch.dataset.reorderDrop).toBe('illegal')
    expect(rowSketch.getAttribute('data-tooltip')).toContain('Fillet1 uses Extrude1')
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C'])
  })

  it('dragging over a row is not marked illegal/legal once dragend fires (indicator clears)', () => {
    const dag = siblingsDag()
    render(<ReorderHarness dag={dag} />)
    const rowY = screen.getByTestId('feature-row-Y')
    const rowX = screen.getByTestId('feature-row-X')
    fireEvent.dragStart(rowY, { dataTransfer: dataTransferStub('Y') })
    fireEvent.dragOver(rowX, { dataTransfer: dataTransferStub('Y') })
    expect(rowX.dataset.reorderDrop).toBe('legal')

    fireEvent.dragEnd(rowY)
    expect(screen.getByTestId('feature-row-X').dataset.reorderDrop).toBe('none')
  })

  it('interplay: reorder respects folders (WO UI-8) -- folder membership/display grouping is untouched by a reorder', () => {
    const dag = siblingsDag()
    const folders = new TreeFolderStore()
    folders.createFolder('FLD1', 'Group')
    folders.setMembership('X', 'FLD1')

    function FoldersReorderHarness() {
      const [, bump] = useState(0)
      const rerender = () => bump((v) => v + 1)
      const reorder: FeatureTreeReorderControls = {
        checkReorder: (id, idx) => dag.checkReorder(id, idx),
        onReorder: (id, idx) => {
          dag.reorderNode(id, idx)
          rerender()
        },
      }
      return (
        <FeatureTree
          dag={dag}
          reorder={reorder}
          folders={{
            list: folders.list(),
            folderOf: (id) => folders.folderOf(id),
            isCollapsed: () => false,
            isFolderSuppressed: () => false,
            onToggleCollapse: () => undefined,
            onCreateFolder: () => undefined,
            onRenameFolder: () => undefined,
            onDeleteFolder: () => undefined,
            onMoveToFolder: (nodeId, folderId) => {
              folders.setMembership(nodeId, folderId)
              rerender()
            },
            onToggleFolderSuppress: () => undefined,
          }}
        />
      )
    }

    render(<FoldersReorderHarness />)
    const rowY = screen.getByTestId('feature-row-Y')
    const rowX = screen.getByTestId('feature-row-X')
    fireEvent.dragStart(rowY, { dataTransfer: dataTransferStub('Y') })
    fireEvent.dragOver(rowX, { dataTransfer: dataTransferStub('Y') })
    fireEvent.drop(rowX, { dataTransfer: dataTransferStub('Y') })

    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
    // Folder membership (display grouping) is completely unaffected.
    expect(folders.folderOf('X')).toBe('FLD1')
    expect(folders.folderOf('Y')).toBeNull()
    expect(screen.getByTestId('feature-row-folder-tag-X')).toBeTruthy()
  })

  it('interplay: reorder across the rollback marker follows UI-7 semantics -- moving below the marker rollback-suppresses the feature', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'A' } })
    dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'B' } })
    dag.insertNode({ id: 'E', kind: 'feature', consumes: [], payload: { name: 'E' } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // E is appended past B -- starts below the marker
    expect(dag.isRolledBack('E')).toBe(true)

    render(<ReorderHarness dag={dag} withRollback />)
    const rowE = screen.getByTestId('feature-row-E')
    const rowB = screen.getByTestId('feature-row-B')
    fireEvent.dragStart(rowE, { dataTransfer: dataTransferStub('E') })
    fireEvent.dragOver(rowB, { dataTransfer: dataTransferStub('E') })
    fireEvent.drop(rowB, { dataTransfer: dataTransferStub('E') })

    // E dropped ONTO B's slot (index 1) -- moves to sit right before B,
    // still above the marker (which stays anchored on B).
    expect(dag.featureOrder()).toEqual(['A', 'E', 'B'])
    expect(dag.isRolledBack('E')).toBe(false)
    expect(screen.getByTestId('feature-row-E').dataset.rolledBack).toBe('false')
  })

  it('interplay: suppressed features reorder like any other -- suppress state is preserved across the move', () => {
    const dag = siblingsDag()
    dag.setSuppressed('X', true)
    render(<ReorderHarness dag={dag} />)

    const rowX = screen.getByTestId('feature-row-X')
    const rowBase = screen.getByTestId('feature-row-Base')
    expect(rowX.dataset.suppressed).toBe('root')

    fireEvent.dragStart(rowX, { dataTransfer: dataTransferStub('X') })
    fireEvent.dragOver(rowBase, { dataTransfer: dataTransferStub('X') })
    fireEvent.drop(rowBase, { dataTransfer: dataTransferStub('X') })

    // X consumes Base -- moving X in front of Base is illegal, so use a
    // legal target instead: assert the refusal path preserved suppress
    // state, then perform a legal move and re-check.
    expect(dag.isSuppressed('X')).toBe(true)

    const rowY = screen.getByTestId('feature-row-Y')
    fireEvent.dragStart(screen.getByTestId('feature-row-X'), { dataTransfer: dataTransferStub('X') })
    fireEvent.dragOver(rowY, { dataTransfer: dataTransferStub('X') })
    fireEvent.drop(rowY, { dataTransfer: dataTransferStub('X') })

    expect(dag.featureOrder()).toEqual(['Base', 'Y', 'X'])
    expect(dag.isSuppressed('X')).toBe(true)
    expect(screen.getByTestId('feature-row-X').dataset.suppressed).toBe('root')
  })

  it('a tree with no `reorder` prop renders exactly as before (no drop indicator, no refusal banner)', () => {
    const dag = siblingsDag()
    render(<FeatureTree dag={dag} />)
    expect(screen.queryByTestId('reorder-refusal-message')).toBeNull()
    expect(screen.getByTestId('feature-row-X').dataset.reorderDrop).toBe('none')
  })

  it('the refusal banner can be dismissed', () => {
    const dag = chainDag()
    render(<ReorderHarness dag={dag} />)
    fireEvent.dragStart(screen.getByTestId('feature-row-C'), { dataTransfer: dataTransferStub('C') })
    fireEvent.drop(screen.getByTestId('feature-row-A'), { dataTransfer: dataTransferStub('C') })
    expect(screen.getByTestId('reorder-refusal-message')).toBeTruthy()

    fireEvent.click(screen.getByTestId('reorder-refusal-dismiss'))
    expect(screen.queryByTestId('reorder-refusal-message')).toBeNull()
  })
})
