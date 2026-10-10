// @vitest-environment jsdom
//
// WO UI-18 (D3): the tree context menu's "Edit..." item, driven through the
// REAL FeatureTree + TreeContextMenu components (render-gate rule, same
// "real component, never a store/test-harness proxy" discipline
// FeatureTree.contextMenu.test.tsx's own AC #4 spy-assert case already
// establishes for Suppress). Per-node routing is entirely the caller's
// (SolidsWorkbenchPage's editEntryFor) responsibility -- this harness stands
// in with a plain lookup function, same "mirrors SolidsWorkbenchPage's own
// wiring shape" precedent that file's Harness component follows for del/
// folders/suppress.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { FeatureTree, type FeatureTreeEditControls, type FeatureTreeEditEntry } from '../../components/model3d/tree'
import { FeatureDag } from '../../doc'

afterEach(cleanup)

function chainDag(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'A', kind: 'feature', consumes: [], payload: { name: 'Extrude', opType: 'extrude' } })
  dag.insertNode({ id: 'B', kind: 'feature', consumes: ['A'], payload: { name: 'Fillet', opType: 'fillet' } })
  return dag
}

function Harness({ dag, editEntryFor }: { dag: FeatureDag; editEntryFor: (id: string) => FeatureTreeEditEntry | undefined }) {
  const edit: FeatureTreeEditControls = { editEntryFor }
  return <FeatureTree dag={dag} edit={edit} />
}

describe('FeatureTree context menu Edit item (WO UI-18 D3)', () => {
  it('an editable kind: the item is clickable and fires the SAME handler the caller resolved (spy assert)', () => {
    const dag = chainDag()
    const onEdit = vi.fn()
    const editEntryFor = (id: string): FeatureTreeEditEntry | undefined => (id === 'A' ? { onEdit } : { reason: 'not editable' })
    render(<Harness dag={dag} editEntryFor={editEntryFor} />)

    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    const item = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(item.disabled).toBe(false)
    fireEvent.click(item)

    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('tree-context-menu')).toBeNull() // clicking Edit... also closes the menu, same as Delete.../Suppress
  })

  it('a non-editable kind: the item renders disabled with the reason as its title, and clicking it never fires anything', () => {
    const dag = chainDag()
    const onEdit = vi.fn()
    const editEntryFor = (id: string): FeatureTreeEditEntry | undefined =>
      id === 'B' ? { reason: 'Fillet has no edit dialog yet -- delete and recreate to change it' } : { onEdit }
    render(<Harness dag={dag} editEntryFor={editEntryFor} />)

    fireEvent.contextMenu(screen.getByTestId('feature-row-B'))
    const item = screen.getByTestId('tree-context-menu-edit') as HTMLButtonElement
    expect(item.disabled).toBe(true)
    expect(item.getAttribute('data-tooltip')).toBe('Fillet has no edit dialog yet -- delete and recreate to change it')

    fireEvent.click(item)
    expect(onEdit).not.toHaveBeenCalled()
    // A disabled button's click never reaches the row's onClick handler in a
    // real browser/jsdom -- the menu stays open (no silent-success close).
    expect(screen.getByTestId('tree-context-menu')).toBeTruthy()
  })

  it('editEntryFor returning undefined omits the item entirely (genesis-row convention)', () => {
    const dag = chainDag()
    const editEntryFor = (): FeatureTreeEditEntry | undefined => undefined
    render(<Harness dag={dag} editEntryFor={editEntryFor} />)

    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    expect(screen.queryByTestId('tree-context-menu-edit')).toBeNull()
  })

  it('a tree with no `edit` control wired renders no Edit item at all (optional-affordance contract)', () => {
    const dag = chainDag()
    render(<FeatureTree dag={dag} />)
    fireEvent.contextMenu(screen.getByTestId('feature-row-A'))
    expect(screen.queryByTestId('tree-context-menu-edit')).toBeNull()
  })
})
