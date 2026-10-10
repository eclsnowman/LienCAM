// @vitest-environment jsdom
//
// NAV-PARITY-SMALLS: closes 3 of NAV-PARITY-AUDIT.report.md's gaps (Operator's
// multiple-navigation-paths law, memory feedback_multiple_navigation_paths).
// Render smoke — each new context-menu item is wired to the SAME existing
// handler its row's inline affordance already uses, no new business logic:
//
//   Gap 2: Setup row context menu gains "Edit setup" FIRST ->
//          openEditSetup(setupId), same as the row's inline Settings2 button.
//   Gap 3: Operation row context menu gains "Edit operation" FIRST ->
//          openEditOperation(setupId, opId), same as the row's inline
//          Settings2 button.
//   Gap 4: Model Items list rows had NO context menu at all (right-click did
//          nothing). New menu: Edit model (FIRST) / Rename / Delete, matching
//          what the row's own always-on affordances already do (click-to-open
//          / pencil icon / trash icon).
//
// Gap 1 (sketch-tab selection routing) is a separate booked lane, not touched
// here. Double-click behavior is untouched everywhere (Operator ruling).
//
// Harness copied from DesignTreeEditModel.uiEditModelFromBody.test.tsx /
// DesignTreeInlineRename.smoke.test.tsx / DesignTreeModelItemDelete.int17cC3.test.tsx.

import { answerPendingConfirm } from './confirmDialog.support'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { getByTooltip } from '../support/tooltipQuery'

// In-memory localStorage shim BEFORE importing the store (zustand persist).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
type Setup = import('../../types').Setup
type Operation = import('../../types').Operation

afterEach(cleanup)

const st = () => useCamStore.getState()

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({
      activeModal: null, editingOpPayload: null, editingSetupId: null, workspace: 'cam',
    })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: ['su1'], expandedStockIds: [],
    })
  })
})

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedSetupWithOp() {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: [{
          id: 'su1', name: 'Setup A',
          wcs: {
            id: 'w1', label: 'G54', fixtureOffset: 54,
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          operations: [{
            id: 'op1', name: 'Contour 1', type: 'contour_2d', enabled: true,
            status: 'pending', toolId: 't1', geometrySelections: [],
            heights: {}, passes: {}, linking: {}, params: {},
          } as unknown as Operation],
          notes: '',
        } as unknown as Setup],
        activeSetupId: 'su1',
        activeOperationId: null,
      },
    }))
  })
}

/** Bare Model Item, no CAM geometry dependents — keeps this file's assertions
 *  isolated from the (already-covered) model-origin CAM row's OWN "Edit
 *  model" context-menu item (UI-EDIT-MODEL-FROM-BODY). openModelItem only
 *  requires the item to exist in project.modelItems. */
function seedModelItemRow() {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
      },
    }))
  })
}

// ── Gap 2: setup context menu ────────────────────────────────────────────────

describe('NAV-PARITY-SMALLS gap 2: setup row context menu gains Edit setup FIRST', () => {
  it('right-click opens a menu whose FIRST item is Edit setup; clicking opens the edit-setup modal state', () => {
    seedSetupWithOp()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-setup'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))

    expect(buttons[0].textContent).toBe('Edit setup')
    expect(buttons[0].getAttribute('data-action')).toBe('setup-edit')

    fireEvent.click(buttons[0])

    expect(st().activeModal).toBe('edit-setup')
    expect(st().editingSetupId).toBe('su1')
  })

  it('matches the inline Settings2 "Edit setup" button\'s destination exactly (same handler)', () => {
    seedSetupWithOp()
    render(<DesignTree />)

    fireEvent.click(getByTooltip('Edit setup'))
    const viaInline = { activeModal: st().activeModal, editingSetupId: st().editingSetupId }
    expect(viaInline).toEqual({ activeModal: 'edit-setup', editingSetupId: 'su1' })

    act(() => { useCamStore.setState({ activeModal: null, editingSetupId: null }) })

    fireEvent.contextMenu(screen.getByTestId('tree-name-setup'))
    fireEvent.click(screen.getByText('Edit setup'))
    const viaMenu = { activeModal: st().activeModal, editingSetupId: st().editingSetupId }

    expect(viaMenu).toEqual(viaInline)
  })

  it('Rename stays reachable and unchanged (Edit setup only added, nothing removed)', () => {
    seedSetupWithOp()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-setup'))
    const menu = screen.getByTestId('tree-context-menu')
    expect(Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Edit setup', 'Add operation', 'Rename', 'Export...', 'Delete',
    ])
  })
})

// ── Gap 3: operation context menu ────────────────────────────────────────────

describe('NAV-PARITY-SMALLS gap 3: operation row context menu gains Edit operation FIRST', () => {
  it('right-click opens a menu whose FIRST item is Edit operation; clicking opens the edit-operation modal state', () => {
    seedSetupWithOp()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-op'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))

    expect(buttons[0].textContent).toBe('Edit operation')
    expect(buttons[0].getAttribute('data-action')).toBe('op-edit')

    fireEvent.click(buttons[0])

    expect(st().activeModal).toBe('edit-operation')
    expect(st().editingOpPayload).toEqual({ setupId: 'su1', opId: 'op1' })
  })

  it('matches the inline Settings2 "Edit operation" button\'s destination exactly (same handler)', () => {
    seedSetupWithOp()
    render(<DesignTree />)

    fireEvent.click(getByTooltip('Edit operation'))
    const viaInline = { activeModal: st().activeModal, editingOpPayload: st().editingOpPayload }
    expect(viaInline).toEqual({ activeModal: 'edit-operation', editingOpPayload: { setupId: 'su1', opId: 'op1' } })
  })
})

// ── Gap 4: Model Items context menu (previously none at all) ────────────────

describe('NAV-PARITY-SMALLS gap 4: Model Items rows gain a context menu', () => {
  it('right-click opens Edit model (FIRST) / Rename / Delete, matching the row\'s own icon order', () => {
    seedModelItemRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('model-item-row-item-a'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))

    expect(buttons.map((b) => b.textContent)).toEqual(['Edit model', 'Rename', 'Delete'])
    expect(buttons[0].getAttribute('data-action')).toBe('model-item-edit')
  })

  it('Edit model opens the SAME model workspace the row\'s own click already opens', () => {
    seedModelItemRow()
    render(<DesignTree />)

    // Baseline: the row's own click-to-open (unchanged by this lane).
    fireEvent.click(screen.getByTestId('model-item-row-item-a'))
    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('item-a')

    act(() => { useCamStore.setState({ workspace: 'cam', activeModelItemId: null }) })

    // Now via the new context-menu item — same destination.
    fireEvent.contextMenu(screen.getByTestId('model-item-row-item-a'))
    fireEvent.click(screen.getByText('Edit model'))
    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('item-a')
  })

  it('Rename starts the SAME inline rename the row\'s pencil icon starts', () => {
    seedModelItemRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('model-item-row-item-a'))
    fireEvent.click(screen.getByText('Rename'))

    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Item A')

    fireEvent.change(input, { target: { value: 'Renamed Item' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect((st().project.modelItems ?? []).find((m) => m.id === 'item-a')?.name).toBe('Renamed Item')
  })

  it('Delete confirms then removes the item, same as the row\'s trash icon', async () => {
    seedModelItemRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('model-item-row-item-a'))
    fireEvent.click(screen.getByText('Delete'))

    // WO-1268: the app's own themed confirm, answered through the store seam.
    await answerPendingConfirm(true)
    await waitFor(() => expect(st().project.modelItems ?? []).toHaveLength(0))
  })

  it('Delete does nothing when the confirm is cancelled', async () => {
    seedModelItemRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('model-item-row-item-a'))
    fireEvent.click(screen.getByText('Delete'))

    await answerPendingConfirm(false)
    expect((st().project.modelItems ?? []).map((m) => m.id)).toEqual(['item-a'])
  })
})
