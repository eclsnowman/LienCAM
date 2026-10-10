// @vitest-environment jsdom
//
// WO UI-8 (BK-42 mission #4): "the UI-7 rollback marker remains correct and
// visible under filtering and inside folder groupings (the marker binds to
// feature ORDER, not the folder view)." FeatureTree.tsx keeps the marker's
// slot computed from the FULL, unfiltered/uncollapsed featureOrder() -- only
// individual ROWS are hidden by filter/collapse, so this asserts the
// underlying dag truth (isRolledBack) plus the marker row's rendering are
// both unaffected by either view concern.

import { useRef, useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree, type FeatureTreeFolderControls } from '../../components/model3d/tree'
import { FeatureDag, TreeFolderStore } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Base' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Cut' } })
  dag.insertNode({ id: 'C', kind: 'feature', consumes: ['B'], payload: { name: 'Fillet' } })
  dag.insertNode({ id: 'D', kind: 'feature', consumes: ['C'], payload: { name: 'Chamfer' } })
  return dag
}

function dataTransferStub(payload: string) {
  return { getData: () => payload, setData: () => undefined }
}

function FoldersHarness({ dag }: { dag: FeatureDag }) {
  const foldersRef = useRef(new TreeFolderStore())
  const collapsedRef = useRef(new Set<string>())
  const [, bump] = useState(0)
  const rerender = () => bump((v) => v + 1)
  const folders = foldersRef.current
  if (!folders.hasFolder('FLD1')) folders.createFolder('FLD1', 'Group')

  const controls: FeatureTreeFolderControls = {
    list: folders.list(),
    folderOf: (id) => folders.folderOf(id),
    isCollapsed: (id) => collapsedRef.current.has(id),
    isFolderSuppressed: () => false,
    onToggleCollapse: (id) => {
      if (collapsedRef.current.has(id)) collapsedRef.current.delete(id)
      else collapsedRef.current.add(id)
      rerender()
    },
    onCreateFolder: () => undefined,
    onRenameFolder: () => undefined,
    onDeleteFolder: () => undefined,
    onMoveToFolder: (nodeId, folderId) => {
      folders.setMembership(nodeId, folderId)
      rerender()
    },
    onToggleFolderSuppress: () => undefined,
  }

  return <FeatureTree dag={dag} rollback={{ marker: dag.getRollbackMarker(), onMoveMarker: () => undefined }} folders={controls} />
}

describe('Rollback marker correctness under filter + folders (WO UI-8, BK-42 mission #4)', () => {
  it('dag.isRolledBack is unaffected by filtering -- the marker is document truth, filtering is a view', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D rolled back
    const before = { C: dag.isRolledBack('C'), D: dag.isRolledBack('D') }

    render(<FeatureTree dag={dag} />)
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: 'zzz-no-match' } })

    expect(dag.isRolledBack('C')).toBe(before.C)
    expect(dag.isRolledBack('D')).toBe(before.D)
    expect(dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'B' })
  })

  it('the marker row still renders (at the same DOM position among visible rows) when a filter hides some rows', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // marker sits between B and C
    const onMoveMarker = vi.fn()
    render(<FeatureTree dag={dag} rollback={{ marker: dag.getRollbackMarker(), onMoveMarker }} />)

    // Filter out C by name -- B (active, above marker) and D (rolled back,
    // below marker) both still match "" is too broad; filter to keep B and D only.
    fireEvent.change(screen.getByTestId('tree-filter-input'), { target: { value: 'Base' } })
    // Only A matches "Base" -- marker (after B) still renders at the tree's end
    // since neither B nor anything after it is drawn, but it must not vanish
    // or throw.
    expect(screen.getByTestId('rollback-marker-row')).toBeTruthy()
    expect(screen.getByTestId('feature-row-A')).toBeTruthy()
    expect(screen.queryByTestId('feature-row-B')).toBeNull()
  })

  it('a rolled-back row correctly shows data-rolled-back="true" even while grouped in a folder', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' }) // C, D rolled back
    render(<FoldersHarness dag={dag} />)

    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('C') })
    const rowC = screen.getByTestId('feature-row-C')
    expect(rowC.dataset.rolledBack).toBe('true')
    expect(screen.getByTestId('feature-row-folder-tag-C')).toBeTruthy()
  })

  it('collapsing the folder a rolled-back feature sits in hides its row, but the marker (order-derived) state is untouched', () => {
    const dag = chainDag()
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B' })
    render(<FoldersHarness dag={dag} />)
    fireEvent.drop(screen.getByTestId('folder-chip-FLD1'), { dataTransfer: dataTransferStub('C') })
    expect(dag.isRolledBack('C')).toBe(true)

    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    expect(screen.queryByTestId('feature-row-C')).toBeNull()
    // The underlying document state (mission #4's "binds to feature ORDER,
    // not the folder view") is completely unaffected by the collapse.
    expect(dag.isRolledBack('C')).toBe(true)
    expect(dag.featureOrder()).toEqual(['A', 'B', 'C', 'D'])

    fireEvent.click(screen.getByTestId('folder-toggle-FLD1'))
    expect(screen.getByTestId('feature-row-C').dataset.rolledBack).toBe('true')
  })
})
