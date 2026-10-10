// @vitest-environment jsdom
//
// P2 (clutter audit): render smoke for the SHARED inline-rename mechanism
// (TreeRenameLabel + DesignTree's single rename target). SHARED-PATH gate:
// one mechanism now serves EVERY named tree row type, so EVERY row type gets
// its own assertions here, not one representative:
//   project, geometry, layer, folder, model item (WO INT-17C Stage C3), nest,
//   nest seed child, fixed stock, auto stock, setup, operation.
// Per row type: double-click on the NAME starts the edit (input appears,
// pre-filled), Escape cancels (store unchanged), empty/whitespace-only name
// cancels, Enter commits through that row type's EXISTING store action.
// Plus: F2 starts rename on the selected/active row (geometry, setup, op),
// and the context-menu Rename entry starts the inline edit (geometry, setup,
// op — the only tree rows with a context menu).
// Harness copied from DesignTreeNest.smoke.test.tsx.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

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

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    // No modal in the way of the F2 handler; deterministic selections.
    useCamStore.setState({ activeModal: null })
    // uiPrefs persist across tests — force every section/row expanded.
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: ['su1'], expandedStockIds: [],
    })
  })
})

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedGeometryWithLayer() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g1', name: 'PartOne', filename: 'p.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [{ id: 'lyr1', name: 'Outline', color: '#ff0000', visible: true }],
      loops: [{ id: 'lp1', layerId: 'lyr1', closed: true, type: 'contour', area: 50,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
    })
  })
}

function seedFolder() {
  act(() => { useCamStore.getState().addGeometryFolder('Folder One', null) })
  return (useCamStore.getState().project.geometryFolders ?? [])[0].id
}

// WO INT-17C Stage C3: a Model Item is a tree-visible row like a folder, but
// created through addModelItem (mints its own id + default name) rather than
// a hand-built record, so the seed helper opens then finishes it to leave the
// row present without leaving the Editing Space open (matches how a real row
// exists in the tree the rest of the time).
function seedModelItem(name: string): string {
  let id = ''
  act(() => {
    id = useCamStore.getState().addModelItem()
    useCamStore.getState().renameModelItem(id, name)
    useCamStore.getState().finishModelItem()
  })
  return id
}

function seedNestWithOwnedSeed() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g-owned', name: 'OwnedSeed', filename: 'o.dxf', type: 'curves_2d', format: 'dxf',
      ownerNestId: 'nest-1',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
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
          sources: [{ geometryId: 'g-owned', quantity: 2 }],
          placements: [{ partId: 'g-owned', instanceId: 'g-owned#0', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
          unplaced: [], utilization: 0.4, computeTimeMs: 10,
        }],
      },
    }))
  })
}

function seedStocks() {
  act(() => {
    useCamStore.getState().addFixedStock({
      id: 'fs1', name: 'Fixed Stock 1', width: 100, height: 80, depth: 10,
      position: { x: 0, y: 0, z: 0 },
    })
    useCamStore.getState().addAutoStock({
      id: 'as1', name: 'Auto Stock X', autoOffsetXY: 2, autoOffsetZTop: 1,
    })
  })
}

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

// ── Shared exercise: dblclick -> prefilled input; Escape / empty cancel; Enter commits ──

function startRenameByDblClick(labelTestId: string, expectedPrefill: string): HTMLInputElement {
  // Same-type rows share a testid (e.g. the default project's "Auto Stock 1"
  // next to a seeded auto stock) — pick the row by its displayed name.
  const label = screen.getAllByTestId(labelTestId).find(el => el.textContent === expectedPrefill)!
  expect(label).toBeTruthy()
  fireEvent.doubleClick(label)
  const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
  expect(input.value).toBe(expectedPrefill)
  return input
}

/** Runs the full P2 contract for one row type against its store read-back. */
function exerciseRename(labelTestId: string, oldName: string, newName: string, readName: () => string) {
  // 1) Escape cancels (store unchanged).
  let input = startRenameByDblClick(labelTestId, oldName)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByTestId('tree-rename-input')).toBeNull()
  expect(readName()).toBe(oldName)
  // 2) Empty / whitespace-only name cancels (no rename).
  input = startRenameByDblClick(labelTestId, oldName)
  fireEvent.change(input, { target: { value: '   ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.queryByTestId('tree-rename-input')).toBeNull()
  expect(readName()).toBe(oldName)
  // 3) Enter commits through the row type's existing store action.
  input = startRenameByDblClick(labelTestId, oldName)
  fireEvent.change(input, { target: { value: newName } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.queryByTestId('tree-rename-input')).toBeNull()
  expect(readName()).toBe(newName)
}

const st = () => useCamStore.getState()

describe('P2 inline rename — every named tree row type', () => {
  it('mounts with all row types seeded without throwing (hooks-order guard)', () => {
    seedGeometryWithLayer(); seedFolder(); seedModelItem('Item One'); seedNestWithOwnedSeed(); seedStocks(); seedSetupWithOp()
    expect(() => render(<DesignTree />)).not.toThrow()
  })

  it('project name: dblclick edits; Escape/empty cancel; Enter commits (updateProjectMeta)', () => {
    render(<DesignTree />)
    const oldName = st().project.name
    exerciseRename('tree-name-project', oldName, 'Renamed Project', () => st().project.name)
  })

  it('geometry row: dblclick edits with the name pre-selected; commits via updateGeometryName', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    // Prefill is fully selected so typing replaces it.
    const input = startRenameByDblClick('tree-name-geometry', 'PartOne')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('PartOne'.length)
    fireEvent.keyDown(input, { key: 'Escape' })
    exerciseRename('tree-name-geometry', 'PartOne', 'PartRenamed',
      () => st().project.geometry.find(g => g.id === 'g1')!.name)
  })

  it('layer row: dblclick edits; commits via updateGeometryLayer', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    exerciseRename('tree-name-layer', 'Outline', 'Profile',
      () => st().project.geometry.find(g => g.id === 'g1')!.layers2d![0].name)
  })

  it('loop row: dblclick assigns a persistent name without changing its stable id', () => {
    seedGeometryWithLayer()
    act(() => {
      useUiPrefs.setState({ expandedLayerKeys: ['g1:lyr1'] })
    })
    render(<DesignTree />)

    exerciseRename('tree-name-loop', 'Contour  50.0 mm\u00b2', 'Outer Profile',
      () => st().project.geometry.find(g => g.id === 'g1')!.loops![0].name ?? 'Contour  50.0 mm\u00b2')
    const loop = st().project.geometry.find(g => g.id === 'g1')!.loops![0]
    expect(loop.id).toBe('lp1')
    expect(loop.name).toBe('Outer Profile')
  })

  it('folder row: dblclick edits; commits via renameGeometryFolder', () => {
    const folderId = seedFolder()
    render(<DesignTree />)
    exerciseRename('tree-name-folder', 'Folder One', 'Folder Renamed',
      () => (st().project.geometryFolders ?? []).find(f => f.id === folderId)!.name)
  })

  it('model item row: dblclick edits; commits via renameModelItem', () => {
    seedModelItem('Item One')
    render(<DesignTree />)
    exerciseRename('tree-name-model-item', 'Item One', 'Item Renamed',
      () => (st().project.modelItems ?? [])[0].name)
  })

  it('nest row: dblclick edits; commits via renameNest', () => {
    seedNestWithOwnedSeed()
    render(<DesignTree />)
    exerciseRename('tree-name-nest', 'Nest A', 'Nest Renamed',
      () => (st().project.nests ?? [])[0].name)
  })

  it('nest seed child row: dblclick edits; commits via updateGeometryName on the owned seed', () => {
    seedNestWithOwnedSeed()
    render(<DesignTree />)
    exerciseRename('tree-name-seed', 'OwnedSeed', 'SeedRenamed',
      () => st().project.geometry.find(g => g.id === 'g-owned')!.name)
  })

  it('fixed stock row: dblclick edits; commits via updateFixedStock', () => {
    seedStocks()
    render(<DesignTree />)
    exerciseRename('tree-name-stock-fixed', 'Fixed Stock 1', 'Fixture Plate',
      () => (st().project.sceneStock.fixedStocks ?? []).find(fs => fs.id === 'fs1')!.name)
  })

  it('auto stock row: dblclick edits; commits via updateAutoStock', () => {
    seedStocks()
    render(<DesignTree />)
    exerciseRename('tree-name-stock-auto', 'Auto Stock X', 'Auto Renamed',
      () => (st().project.sceneStock.autoStocks ?? []).find(a => a.id === 'as1')!.name)
  })

  it('setup row: dblclick edits; commits via updateSetup (same action as SetupModal)', () => {
    seedSetupWithOp()
    render(<DesignTree />)
    exerciseRename('tree-name-setup', 'Setup A', 'Setup Renamed',
      () => st().project.setups[0].name)
  })

  it('operation row: dblclick opens the operation editor (not an inline input); F2 renames and commits via updateOperation', () => {
    // The row's double-click is the operation editor's gesture (DesignTree
    // handleOperationDoubleClick); rename is F2 / context menu, both covered below.
    seedSetupWithOp()
    render(<DesignTree />)
    const label = screen.getAllByTestId('tree-name-op').find(el => el.textContent === 'Contour 1')!
    fireEvent.doubleClick(label)
    expect(screen.queryByTestId('tree-rename-input')).toBeNull()
    expect(st().activeModal).toBe('edit-operation')
    act(() => { st().closeModal() })
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op1' } })) })
    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Contour 1')
    fireEvent.change(input, { target: { value: 'Contour Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.setups[0].operations[0].name).toBe('Contour Renamed')
  })
})

describe('P2 inline rename — F2 on the selected/active row', () => {
  it('F2 renames the SELECTED geometry', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    act(() => { st().setSelectedGeometry('g1') })
    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('PartOne')
    fireEvent.change(input, { target: { value: 'F2Part' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.geometry.find(g => g.id === 'g1')!.name).toBe('F2Part')
  })

  it('F2 renames the ACTIVE setup when nothing else is selected', () => {
    seedSetupWithOp()
    render(<DesignTree />)
    act(() => { st().setSelectedGeometry(null) })
    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Setup A')
    fireEvent.change(input, { target: { value: 'F2 Setup' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.setups[0].name).toBe('F2 Setup')
  })

  it('F2 renames the ACTIVE operation ahead of its setup', () => {
    seedSetupWithOp()
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op1' } }))
    })
    render(<DesignTree />)
    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Contour 1')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(st().project.setups[0].operations[0].name).toBe('Contour 1')
  })

  it('F2 while typing in another input does NOT start a rename', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    act(() => { st().setSelectedGeometry('g1') })
    const filter = screen.getByTestId('tree-filter-input')
    fireEvent.keyDown(filter, { key: 'F2' })
    expect(screen.queryByTestId('tree-rename-input')).toBeNull()
  })
})

describe('P2 inline rename — context-menu Rename entry starts the inline edit', () => {
  function clickMenuRename() {
    const menu = screen.getByTestId('tree-context-menu')
    const btn = Array.from(menu.querySelectorAll('button')).find(b => b.textContent === 'Rename')!
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
  }

  it('geometry: right-click -> Rename -> inline input (not the edit modal)', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    clickMenuRename()
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('PartOne')
    expect(st().activeModal).toBeNull()
  })

  it('setup: right-click -> Rename -> inline input (not the SetupModal)', () => {
    seedSetupWithOp()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-setup'))
    clickMenuRename()
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Setup A')
    expect(st().activeModal).toBeNull()
  })

  it('operation: right-click -> Rename -> inline input (not the op edit modal)', () => {
    seedSetupWithOp()
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getByTestId('tree-name-op'))
    clickMenuRename()
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Contour 1')
    expect(st().activeModal).toBeNull()
  })
})

describe('P2 inline rename — blur commits (shared input behavior)', () => {
  it('blur commits the typed name on the geometry row', () => {
    seedGeometryWithLayer()
    render(<DesignTree />)
    const input = startRenameByDblClick('tree-name-geometry', 'PartOne')
    fireEvent.change(input, { target: { value: 'BlurName' } })
    fireEvent.blur(input)
    expect(st().project.geometry.find(g => g.id === 'g1')!.name).toBe('BlurName')
  })
})

// ── NAV-RENAME-PENCIL: dedicated rename pencil on imported part rows ────────
// Before this, an imported DXF/SVG/STL/legacy-STEP part row had ONLY the
// double-click-on-the-name affordance (covered above) — every other named
// row type (folder, layer, loop, model item, nest, stock, setup, op)
// already had a dedicated inline Pencil button too. This closes that gap:
// same rename target + commit path (setRenameTarget({kind:'geometry',...})
// -> updateGeometryName), just reachable via a visible button, not only a
// hidden double-click gesture. Model-origin rows are deliberately excluded
// (their own MODEL identity already has its own pencil elsewhere).
describe('NAV-RENAME-PENCIL — dedicated pencil button on imported part rows', () => {
  function seedImportedPart(
    format: 'dxf' | 'svg' | 'stl' | 'step' | 'model',
    type: 'curves_2d' | 'mesh' | 'brep' | 'model',
    id: string, name: string, filename: string,
  ) {
    act(() => {
      useCamStore.getState().addGeometry({
        id, name, filename, type, format,
        boundingBox: {
          min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
          size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
        },
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      })
    })
  }

  function exercisePencilRename(id: string, oldName: string, newName: string) {
    const btn = screen.getByTestId(`rename-geo-btn-${id}`)
    fireEvent.click(btn)
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe(oldName)
    fireEvent.change(input, { target: { value: newName } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByTestId('tree-rename-input')).toBeNull()
    expect(st().project.geometry.find(g => g.id === id)!.name).toBe(newName)
  }

  it('dxf row: pencil visible; click enters rename; Enter commits via updateGeometryName', () => {
    seedImportedPart('dxf', 'curves_2d', 'g-dxf', 'Part DXF', 'p.dxf')
    render(<DesignTree />)
    exercisePencilRename('g-dxf', 'Part DXF', 'Part DXF Renamed')
  })

  it('svg row: pencil visible; click enters rename; Enter commits via updateGeometryName', () => {
    seedImportedPart('svg', 'curves_2d', 'g-svg', 'Part SVG', 'p.svg')
    render(<DesignTree />)
    exercisePencilRename('g-svg', 'Part SVG', 'Part SVG Renamed')
  })

  it('stl row: pencil visible; click enters rename; Enter commits via updateGeometryName', () => {
    seedImportedPart('stl', 'mesh', 'g-stl', 'Part STL', 'p.stl')
    render(<DesignTree />)
    exercisePencilRename('g-stl', 'Part STL', 'Part STL Renamed')
  })

  it('legacy step row (not model-origin): pencil visible; click enters rename; Enter commits via updateGeometryName', () => {
    seedImportedPart('step', 'brep', 'g-step', 'Part STEP', 'p.step')
    render(<DesignTree />)
    exercisePencilRename('g-step', 'Part STEP', 'Part STEP Renamed')
  })

  it('pencil starts the SAME rename target the context menu\'s Rename action sets (no second mechanism)', () => {
    seedImportedPart('dxf', 'curves_2d', 'g-both', 'Part Both', 'p.dxf')
    render(<DesignTree />)
    fireEvent.click(screen.getByTestId('rename-geo-btn-g-both'))
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Part Both')
    // Only ONE input mounted anywhere in the tree (single shared target).
    expect(screen.getAllByTestId('tree-rename-input')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.geometry.find(g => g.id === 'g-both')!.name).toBe('Part Both')
    // Enter with no edit re-commits the same name (no-op through the same
    // updateGeometryName path the context menu's geo-rename action uses).
  })

  it('model-origin row: pencil is OMITTED (not disabled) — row rename stays reachable via double-click only', () => {
    seedImportedPart('model', 'model', 'g-model', 'Modeled Part', 'model.body')
    render(<DesignTree />)
    expect(screen.queryByTestId('rename-geo-btn-g-model')).toBeNull()
    // The row's own name is still reachable the existing way (unchanged
    // behavior, same mechanism proven for every format in the "geometry
    // row" test above).
    expect(screen.getByTestId('tree-name-geometry')).toBeTruthy()
  })
})
