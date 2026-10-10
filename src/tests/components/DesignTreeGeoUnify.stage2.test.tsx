// @vitest-environment jsdom
//
// GEO-UNIFY Stage 2 (placeholder folder membership + drag parity,
// coordination/reports/GEO-UNIFY.plan.md sec 1.4): an empty-model placeholder
// row (Stage 1) becomes drag/drop-eligible into geometry folders, the same
// handler shape a real geometry row already uses. Once the item gains its
// first body row, that row inherits the item's own folderId ONCE so the
// model does not silently reappear at the tree root. Folder delete extends
// its existing "kept and re-parented to root" mercy to a placeholder whose
// item points at the deleted folder.
//
// Harness copied from DesignTreeGeoUnify.stage1.test.tsx.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

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
afterEach(cleanup)

const st = () => useCamStore.getState()

// Minimal stub: DesignTree's drag handlers key off refs set in onDragStart,
// never off dataTransfer payload contents — only the effectAllowed/dropEffect
// setter calls need to not throw.
function dataTransferStub() {
  return { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => '' }
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

describe('GEO-UNIFY Stage 2: dragging a placeholder row into a folder', () => {
  it('drag placeholder -> drop on folder row moves it under the folder and persists folderId', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    const { container } = render(<DesignTree />)

    const placeholderRow = screen.getByTestId('model-item-row-item-a')
    const folderRow = container.querySelector('.tree-folder-row') as HTMLElement
    expect(folderRow).toBeTruthy()

    fireEvent.dragStart(placeholderRow, { dataTransfer: dataTransferStub() })
    fireEvent.dragOver(folderRow, { dataTransfer: dataTransferStub() })
    fireEvent.drop(folderRow, { dataTransfer: dataTransferStub() })

    expect(st().project.modelItems?.find((m) => m.id === 'item-a')?.folderId).toBe(folderId)

    // Re-render: the placeholder now lives inside the folder's own contents,
    // not at the tree root (the folder's collapse state defaults expanded).
    const rerendered = render(<DesignTree />).container
    const folderBlock = rerendered.querySelector('.tree-folder-block') as HTMLElement
    expect(folderBlock.querySelector('[data-testid="model-item-row-item-a"]')).toBeTruthy()
  })

  it('is a no-op (no history) when the folder is unchanged (mirrors setGeometryFolderId)', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    const before = st().projectHistory.length
    render(<DesignTree />)
    const placeholderRow = screen.getByTestId('model-item-row-item-a')

    fireEvent.dragStart(placeholderRow, { dataTransfer: dataTransferStub() })
    // Drop back to the root drop zone — item is already at the root (undefined).
    const rootZone = document.querySelector('.tree-folder-root-zone') as HTMLElement
    fireEvent.drop(rootZone, { dataTransfer: dataTransferStub() })

    expect(st().projectHistory.length).toBe(before)
  })

  it('a placeholder dragged into a folder can be dragged back out to the root', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          modelItems: [{ id: 'item-a', name: 'Item A', folderId }],
        },
      }))
    })
    render(<DesignTree />)
    const placeholderRow = screen.getByTestId('model-item-row-item-a')

    fireEvent.dragStart(placeholderRow, { dataTransfer: dataTransferStub() })
    const rootZone = document.querySelector('.tree-folder-root-zone') as HTMLElement
    fireEvent.drop(rootZone, { dataTransfer: dataTransferStub() })

    expect(st().project.modelItems?.find((m) => m.id === 'item-a')?.folderId).toBeNull()
  })
})

describe('GEO-UNIFY Stage 2: first body row inherits the placeholder\'s folder', () => {
  it('once the item gains its first body row (via syncModelBodies), the new row seeds folderId from the item', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId }] },
      }))
    })
    act(() => {
      useCamStore.getState().syncModelBodies({
        modelItemId: 'item-a',
        live: [{ bodyId: 'b1', name: 'Bracket' }],
        derived: [{
          bodyId: 'b1', version: 1, stableIds: ['b1:F0'],
          display: {
            positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
            bbox: { min: [0, 0, 0], max: [1, 1, 1] },
          },
        }],
      })
    })

    const modelRow = st().project.geometry.find((g) => g.format === 'model')!
    expect(modelRow.folderId).toBe(folderId)
  })

  it('a LATER regen never overwrites the row\'s own folderId once the user has moved it', () => {
    let folderId = ''
    let otherFolderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      otherFolderId = useCamStore.getState().addGeometryFolder('Gussets')
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId }] },
      }))
    })
    const syncOnce = () => useCamStore.getState().syncModelBodies({
      modelItemId: 'item-a',
      live: [{ bodyId: 'b1', name: 'Bracket' }],
      derived: [{
        bodyId: 'b1', version: 1, stableIds: ['b1:F0'],
        display: {
          positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
          indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
          bbox: { min: [0, 0, 0], max: [1, 1, 1] },
        },
      }],
    })
    act(() => { syncOnce() })
    const geoId = st().project.geometry.find((g) => g.format === 'model')!.id

    act(() => { useCamStore.getState().setGeometryFolderId(geoId, otherFolderId) })
    // A later regen (same body, bumped version — simulated by a second sync call).
    act(() => { syncOnce() })

    expect(st().project.geometry.find((g) => g.id === geoId)?.folderId).toBe(otherFolderId)
  })
})

describe('GEO-UNIFY Stage 2: folder delete re-parents an empty placeholder to root', () => {
  it('deleting a folder that owns an empty placeholder clears the item\'s folderId instead of orphaning it', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Doomed')
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A', folderId }] },
      }))
    })
    render(<DesignTree />)

    const delBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.getAttribute('data-tooltip') === 'Delete folder (and its contents)')!
    fireEvent.click(delBtn)

    // The item survives (empty models are never deleted by a folder cascade)
    // and is re-parented to the root, not left pointing at a vanished folder.
    expect(st().project.modelItems).toHaveLength(1)
    expect(st().project.modelItems![0].folderId).toBeNull()
  })
})

describe('GEO-UNIFY Stage 2: types round-trip (store-level, no rendering)', () => {
  it('setModelItemFolderId moves the item into a folder and back to root', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('F')
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    useCamStore.getState().setModelItemFolderId('item-a', folderId)
    expect(st().project.modelItems![0].folderId).toBe(folderId)
    useCamStore.getState().setModelItemFolderId('item-a', null)
    expect(st().project.modelItems![0].folderId).toBeNull()
  })
})
