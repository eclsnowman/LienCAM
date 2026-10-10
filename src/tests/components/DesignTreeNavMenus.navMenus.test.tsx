// @vitest-environment jsdom
//
// NAV-MENUS: closes the 5 context-menu gaps PP-SELECTION-UTILITY.recon.md's
// Matrix 2 flagged (no TreeContextKind existed for any of them): Fixed stock,
// Auto stock, Geometry folder, Operation folder, Nest. Render smoke — each new
// context-menu item is wired to the SAME existing handler its row's inline
// affordance already uses, no new business logic. Harness copied from
// DesignTreeNavParitySmalls.navParitySmalls.test.tsx.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
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
    useCamStore.setState({ activeModal: null, workspace: 'cam' })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: ['su1'], expandedStockIds: [],
    })
  })
})

// ── Fixed stock ──────────────────────────────────────────────────────────────

describe('NAV-MENUS: Fixed stock row gains a context menu', () => {
  beforeEach(() => {
    act(() => {
      useCamStore.getState().addFixedStock({
        id: 'fixed-1', name: 'Fixed Block', width: 50, height: 40, depth: 20,
        position: { x: 0, y: 0, z: 0 },
      })
    })
  })

  it('right-click opens Move with gizmo / Rename / Delete, in that order', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-stock-fixed'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Move with gizmo', 'Rename', 'Delete'])
    expect(buttons[0].getAttribute('data-action')).toBe('stock-fixed-toggle-gizmo')
  })

  it('gizmo toggle matches the row\'s own Move3d button (same shared owner)', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-stock-fixed'))
    fireEvent.click(screen.getByText('Move with gizmo'))
    expect(st().viewer.selectedStockId).toBe('fixed-1')
  })

  it('Delete calls the SAME handler as the row\'s Trash2 button (removeFixedStock, no confirm)', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-stock-fixed'))
    fireEvent.click(screen.getByText('Delete'))
    expect((st().project.sceneStock.fixedStocks ?? []).find((s) => s.id === 'fixed-1')).toBeUndefined()
  })
})

// ── Auto stock ───────────────────────────────────────────────────────────────

describe('NAV-MENUS: Auto stock row gains a context menu', () => {
  it('right-click opens Rename / Delete on the default auto stock', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-stock-auto'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Rename', 'Delete'])
  })

  it('Rename starts the SAME inline rename the row\'s double-click starts', () => {
    render(<DesignTree />)
    const autoId = st().project.sceneStock.autoStocks![0].id
    fireEvent.contextMenu(screen.getByTestId('tree-name-stock-auto'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed Auto' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.sceneStock.autoStocks!.find((s) => s.id === autoId)?.name).toBe('Renamed Auto')
  })
})

// ── Geometry folder ──────────────────────────────────────────────────────────

describe('NAV-MENUS: Geometry folder row gains a context menu', () => {
  beforeEach(() => {
    act(() => { useCamStore.getState().addGeometryFolder('Folder One', null) })
  })

  it('right-click opens Rename / Delete', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-folder'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Rename', 'Delete'])
  })

  it('Delete removes the folder without prompting and Undo restores it', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-folder'))
    fireEvent.click(screen.getByText('Delete'))
    expect(st().project.geometryFolders ?? []).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.geometryFolders ?? []).toHaveLength(1)
  })
})

// ── Operation folder ─────────────────────────────────────────────────────────

function seedSetupWithOpFolder() {
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
          operationFolders: [{ id: 'opf1', name: 'Op Folder A' }],
          operations: [{
            id: 'op1', name: 'Contour 1', type: 'contour_2d', enabled: true,
            folderId: 'opf1',
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

describe('NAV-MENUS: Operation folder row gains a context menu', () => {
  it('right-click opens Rename / Enable-or-Suppress-all / Delete', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-op-folder'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Rename', 'Suppress all', 'Delete'])
  })

  it('Suppress all calls the SAME setOperationFolderEnabled the row\'s Power button calls', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-op-folder'))
    fireEvent.click(screen.getByText('Suppress all'))
    expect(st().project.setups[0].operations[0].enabled).toBe(false)
  })

  it('context-menu Delete removes the operation folder without prompting and Undo restores it', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-op-folder'))
    fireEvent.click(screen.getByText('Delete'))
    expect(st().project.setups[0].operationFolders ?? []).toHaveLength(0)
    // The operation itself survives — moved back to the setup root.
    expect(st().project.setups[0].operations).toHaveLength(1)
    act(() => st().undo())
    expect(st().project.setups[0].operationFolders?.map((folder) => folder.id)).toEqual(['opf1'])
    expect(st().project.setups[0].operations[0].folderId).toBe('opf1')
  })

  it('row Delete removes the operation folder without prompting and Undo restores it', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.click(getByTooltip('Delete folder and keep operations'))
    expect(st().project.setups[0].operationFolders ?? []).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.setups[0].operationFolders?.map((folder) => folder.id)).toEqual(['opf1'])
  })
})

describe('NAV-MENUS: operation and setup deletion', () => {
  it('operation Delete removes without prompting and Undo restores it', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-op'))
    fireEvent.click(screen.getByText('Delete'))
    expect(st().project.setups[0].operations).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.setups[0].operations.map((op) => op.id)).toEqual(['op1'])
  })

  it('setup Delete removes without prompting and Undo restores it', () => {
    seedSetupWithOpFolder()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-setup'))
    fireEvent.click(screen.getByText('Delete'))
    expect(st().project.setups).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.setups.map((setup) => setup.id)).toEqual(['su1'])
  })
})

// ── Nest ─────────────────────────────────────────────────────────────────────

function seedNest() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g-nest', name: 'NestPart', filename: 'p.stl', type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
        size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: [{
          id: 'nest-1', name: 'Nest A',
          sheet: { width: 100, height: 100 }, style: 'ninety' as const,
          spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 }, seed: 1,
          sources: [{ geometryId: 'g-nest', quantity: 1 }],
          placements: [
            { partId: 'g-nest', instanceId: 'g-nest#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
          ],
          unplaced: [], utilization: 0.4, computeTimeMs: 10,
        }],
      },
    }))
  })
}

describe('NAV-MENUS: Nest row gains a context menu', () => {
  it('right-click opens Edit nest FIRST, then Rename / Hide / Explode / Delete (fresh nest, no Recompute)', () => {
    seedNest()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-nest'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Edit nest', 'Rename', 'Hide', 'Explode', 'Delete'])
    expect(buttons[0].getAttribute('data-action')).toBe('nest-edit')
  })

  it('Edit nest matches the row\'s own Pencil button (same setNestEditTarget + New Nest modal)', () => {
    seedNest()
    render(<DesignTree />)
    fireEvent.click(getByTooltip('Edit nest'))
    const viaInline = { activeModal: st().activeModal, nestEditTarget: st().nestEditTarget }
    expect(viaInline).toEqual({ activeModal: 'new-nest', nestEditTarget: 'nest-1' })

    act(() => { useCamStore.setState({ activeModal: null, nestEditTarget: null }) })

    fireEvent.contextMenu(screen.getByTestId('tree-name-nest'))
    fireEvent.click(screen.getByText('Edit nest'))
    expect({ activeModal: st().activeModal, nestEditTarget: st().nestEditTarget }).toEqual(viaInline)
  })

  it('includes Recompute when the nest is stale, matching the row\'s conditional RefreshCw button', () => {
    seedNest()
    act(() => { useCamStore.setState((s) => ({
      project: {
        ...s.project,
        nests: s.project.nests!.map((n) => n.id === 'nest-1' ? { ...n, needsRecompute: true } : n),
      },
    })) })
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-nest'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Edit nest', 'Rename', 'Hide', 'Recompute', 'Explode', 'Delete',
    ])
  })

  it('Delete removes the nest without prompting and Undo restores it', () => {
    seedNest()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-nest'))
    fireEvent.click(screen.getByText('Delete'))
    expect(st().project.nests ?? []).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })

  it('Explode removes the nest without prompting and Undo restores it', () => {
    seedNest()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-nest'))
    fireEvent.click(screen.getByText('Explode'))
    expect(st().project.nests ?? []).toHaveLength(0)
    act(() => st().undo())
    expect(st().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })
})
