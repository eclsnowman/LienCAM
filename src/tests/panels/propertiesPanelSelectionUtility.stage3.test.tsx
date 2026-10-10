// @vitest-environment jsdom
//
// PP-UTILITY Stage 3: render-gate + interaction tests for the two selection
// types Stage 2 deferred (coordination/reports/PP-UTILITY-S2.report.md) —
// sketch-LAYER rows and geometry/operation FOLDER rows — now that the new
// store slice (viewer.selectedLayerId/selectedLayerGeoId,
// viewer.selectedFolderId/Kind/SetupId) makes them first-class Properties-
// panel selections. Store-level mutual-exclusion coverage lives in
// src/tests/store/selectedLayerFolder.test.ts; this file covers the render
// surfaces + the store-driven action wiring.
//
// WHAT IT ASSERTS:
//  - LayerProperties: name/parent-geometry/kind/loop-count/locked facts, and
//    the Edit-sketch / Rename / Convert-to-model / Delete action row — Edit
//    sketch + Convert to model OMITTED (not disabled) on a locked layer, same
//    sketchEditable gate DesignTree.tsx's own layer row uses.
//  - FolderProperties: type/member-count facts + Rename/Delete action row,
//    for BOTH a geometry folder and a per-setup operation folder.
//  - Mutual exclusion at the render level: selecting a folder after a layer
//    swaps the panel from LayerProperties to FolderProperties and vice versa.
//  - Convert to model reuses the SAME promoteSketchPreview/
//    promoteSketchLayerToModel pair DesignTree.tsx's handleConvertLayerToModel
//    calls (GEO-UNIFY Stage 3) — the THIRD promote entry path.

import { answerPendingConfirm } from '../components/confirmDialog.support'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Layer2D } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

function layer(over: Partial<Layer2D> = {}): Layer2D {
  return { id: 'layer-1', name: 'Outline', color: '#4ac3ff', visible: true, ...over }
}

function seedGeo(layers: Layer2D[], loops: unknown[] = []): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Bracket', filename: 'bracket.dxf', type: 'curves_2d', format: 'dxf',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: layers,
    loops,
  } as unknown as ImportedGeometry
}

// A real (liftable) square loop, same fixture shape
// promoteSketchToModel.geoUnifyStage3.test.ts's squareLoop uses — bake never
// emits a bare polyline without segments, but liftLoops falls back to a line
// chain from `points` alone, so this is enough for promoteSketchLayerToModel's
// empty/pending guard (PROMOTE-SKETCH-FAIL round 2) to see real geometry.
function squareLoop(id: string, layerId: string) {
  return {
    id, layerId, closed: true, type: 'contour', area: 100,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  }
}

describe('PP-UTILITY Stage 3: LayerProperties', () => {
  function seedAndSelect(layerOver: Partial<Layer2D> = {}, loops: unknown[] = []) {
    const l = layer(layerOver)
    const geo = seedGeo([l], loops)
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } }))
      useCamStore.getState().setSelectedLayer(l.id, geo.id)
    })
    return { geo, layer: l }
  }

  it('renders identifying facts: name, parent geometry, kind, loop count, locked state', () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    expect(screen.getByText('Outline')).not.toBeNull()
    expect(screen.getByText('Bracket')).not.toBeNull()
    expect(screen.getByTestId('layer-kind').textContent).toBe('DXF')
    expect(screen.getByTestId('layer-loop-count').textContent).toBe('0')
    expect(screen.getByTestId('layer-locked').textContent).toBe('No')
  })

  it('a locked layer reads Locked: Yes and OMITS Edit sketch + Convert to model (not disabled)', () => {
    seedAndSelect({ locked: true })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('layer-locked').textContent).toBe('Yes')
    expect(screen.queryByTestId('layer-edit-sketch-btn')).toBeNull()
    expect(screen.queryByTestId('layer-convert-model-btn')).toBeNull()
    // Rename/Delete stay available regardless of lock state.
    expect(screen.getByTestId('layer-rename-btn')).not.toBeNull()
    expect(screen.getByTestId('layer-delete-btn')).not.toBeNull()
  })

  it('an STL-projection layer OMITS Edit sketch + Convert to model too', () => {
    seedAndSelect({ projectionPlane: { axis: 'z', origin: { x: 0, y: 0, z: 0 } } as never })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('layer-kind').textContent).toBe('STL projection')
    expect(screen.queryByTestId('layer-edit-sketch-btn')).toBeNull()
    expect(screen.queryByTestId('layer-convert-model-btn')).toBeNull()
  })

  it('Edit sketch calls openSketchForLayer for THIS layer/geo', () => {
    const { geo, layer: l } = seedAndSelect()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('layer-edit-sketch-btn'))
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
    expect(useCamStore.getState().activeSketch?.layerId).toBe(l.id)
    void geo
  })

  it('Rename calls updateGeometryLayer with the prompted name', () => {
    const { geo, layer: l } = seedAndSelect()
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Layer')
    fireEvent.click(screen.getByTestId('layer-rename-btn'))
    const updated = useCamStore.getState().project.geometry
      .find((g) => g.id === geo.id)?.layers2d?.find((x) => x.id === l.id)
    expect(updated?.name).toBe('Renamed Layer')
    promptSpy.mockRestore()
  })

  it('Delete (confirmed) calls deleteGeometryLayer and clears the layer selection', async () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('layer-delete-btn'))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam
    // deleteGeometryLayer replaces an emptied layers2d with a synthetic
    // Default layer (store contract) — the important assertion is the
    // dangling selection is cleared, not that the layer count hits zero.
    await waitFor(() => expect(useCamStore.getState().viewer.selectedLayerId).toBeNull())
  })

  it('Convert to model... (confirmed) calls promoteSketchLayerToModel — the THIRD promote entry path', async () => {
    // PROMOTE-SKETCH-FAIL round 2's empty/pending guard refuses a sketch with
    // no entities/loops ("not-ready") — real geometry is required to reach
    // the confirm+promote path at all, matching what a real imported layer
    // (with baked loops) always has.
    seedAndSelect({}, [squareLoop('lp-1', 'layer-1')])
    render(<PropertiesPanel />)
    // PROMOTE-SKETCH-FAIL round 2 replaced the native window.confirm() on
    // every promote path (including this Properties-panel button) with the
    // themed, promise-based requestConfirm/resolveConfirm pair — see
    // ConfirmModal.tsx + promoteSketchToModel.geoUnifyStage3.test.ts. Drive
    // it at the store level (headed-free, no ConfirmModal render needed:
    // resolveConfirm only touches store state).
    fireEvent.click(screen.getByTestId('layer-convert-model-btn'))
    expect(useCamStore.getState().confirmDialog).not.toBeNull()
    act(() => { useCamStore.getState().resolveConfirm(true) })
    // promoteSketchLayerToModel builds its seed document headlessly (async,
    // step 4 of the plan in the store) before mutating — poll the store
    // snapshot with a bounded timeout rather than a fixed sleep.
    await waitFor(() => {
      expect((useCamStore.getState().project.modelItems ?? []).length).toBeGreaterThan(0)
    })
    // The layer + its owning Sketches container are gone (MOVE semantics) —
    // same observable outcome the tree's own handleConvertLayerToModel test
    // coverage checks.
  })

  it('Convert to model... (cancelled) makes NO mutation', async () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    const before = (useCamStore.getState().project.modelItems ?? []).length
    fireEvent.click(screen.getByTestId('layer-convert-model-btn'))
    expect(useCamStore.getState().confirmDialog).not.toBeNull()
    await act(async () => {
      useCamStore.getState().resolveConfirm(false)
      await Promise.resolve()
    })
    expect((useCamStore.getState().project.modelItems ?? []).length).toBe(before)
  })
})

describe('PP-UTILITY Stage 3: FolderProperties — geometry folder', () => {
  function seedAndSelect() {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [
            { ...seedGeo([]), id: 'geo-a', folderId },
            { ...seedGeo([]), id: 'geo-b', folderId },
          ],
        },
      }))
      useCamStore.getState().setSelectedFolder(folderId, 'geometry')
    })
    return folderId
  }

  it('renders type + member count + Rename/Delete action row', () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    expect(screen.getByText('Brackets')).not.toBeNull()
    expect(screen.getByTestId('folder-type').textContent).toBe('Geometry folder')
    expect(screen.getByTestId('folder-member-count').textContent).toBe('2')
    expect(screen.getByTestId('folder-action-row')).not.toBeNull()
  })

  it('Rename calls renameGeometryFolder with the prompted name', () => {
    const folderId = seedAndSelect()
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Folder')
    fireEvent.click(screen.getByTestId('folder-rename-btn'))
    expect((useCamStore.getState().project.geometryFolders ?? [])
      .find((f) => f.id === folderId)?.name).toBe('Renamed Folder')
    promptSpy.mockRestore()
  })

  it('Delete removes the geometry folder without prompting and Undo restores it', () => {
    const folderId = seedAndSelect()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('folder-delete-btn'))
    expect((useCamStore.getState().project.geometryFolders ?? []).some((f) => f.id === folderId)).toBe(false)
    expect(useCamStore.getState().viewer.selectedFolderId).toBeNull()
    act(() => useCamStore.getState().undo())
    expect((useCamStore.getState().project.geometryFolders ?? []).some((f) => f.id === folderId)).toBe(true)
  })
})

describe('PP-UTILITY Stage 3: FolderProperties — operation folder', () => {
  function seedAndSelect() {
    let folderId = ''
    act(() => {
      useCamStore.getState().addSetup({
        id: 'setup-1', name: 'Setup 1', operations: [],
      } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
      folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
      useCamStore.getState().addOperation('setup-1', {
        id: 'op-1', name: 'Op 1', type: 'contour_2d', folderId,
        smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1' }),
      } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addOperation']>[1])
      // addOperation activates the new op (project.activeOperationId) as a
      // side effect — real folder-row selection never does that (only an
      // operation ROW click does). Clear it so the panel cascade reflects the
      // FOLDER selection, same as it would for a real user click, and so a
      // later folder-selection clear falls through to the (real, full-shape)
      // activeSetup branch rather than an activeOp on this deliberately
      // minimal fixture operation.
      // Same reasoning for activeSetupId: addSetup activates the new setup,
      // but this fixture's minimal setup (no `wcs`) is not realistic enough
      // for SetupProperties itself — real setup rows always carry a full wcs
      // (exercised elsewhere); here only the folder-selection cascade is
      // under test.
      useCamStore.setState((s) => ({
        project: { ...s.project, activeOperationId: null, activeSetupId: null },
      }))
      useCamStore.getState().setSelectedFolder(folderId, 'operation', 'setup-1')
    })
    return folderId
  }

  it('renders type + member count + Rename/Delete action row', () => {
    seedAndSelect()
    render(<PropertiesPanel />)
    expect(screen.getByText('Roughing')).not.toBeNull()
    expect(screen.getByTestId('folder-type').textContent).toBe('Operation folder')
    expect(screen.getByTestId('folder-member-count').textContent).toBe('1')
  })

  it('Rename calls renameOperationFolder(setupId, folderId, name)', () => {
    const folderId = seedAndSelect()
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Op Folder')
    fireEvent.click(screen.getByTestId('folder-rename-btn'))
    const setup = useCamStore.getState().project.setups.find((s) => s.id === 'setup-1')
    expect(setup?.operationFolders?.find((f) => f.id === folderId)?.name).toBe('Renamed Op Folder')
    promptSpy.mockRestore()
  })

  it('Delete removes the operation folder without prompting and Undo restores it', () => {
    const folderId = seedAndSelect()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('folder-delete-btn'))
    expect(useCamStore.getState().project.setups.find((s) => s.id === 'setup-1')
      ?.operationFolders?.some((f) => f.id === folderId)).toBe(false)
    expect(useCamStore.getState().viewer.selectedFolderId).toBeNull()
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.setups.find((s) => s.id === 'setup-1')
      ?.operationFolders?.some((f) => f.id === folderId)).toBe(true)
  })
})

describe('PP-UTILITY Stage 3: mutual exclusion at the render level', () => {
  it('selecting a folder after a layer swaps LayerProperties -> FolderProperties', () => {
    const l = layer()
    const geo = seedGeo([l])
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } }))
      useCamStore.getState().setSelectedLayer(l.id, geo.id)
    })
    const { rerender } = render(<PropertiesPanel />)
    expect(screen.queryByTestId('layer-action-row')).not.toBeNull()
    expect(screen.queryByTestId('folder-action-row')).toBeNull()

    act(() => { useCamStore.getState().setSelectedFolder(folderId, 'geometry') })
    rerender(<PropertiesPanel />)
    expect(screen.queryByTestId('folder-action-row')).not.toBeNull()
    expect(screen.queryByTestId('layer-action-row')).toBeNull()
  })

  it('selecting a layer after a folder swaps FolderProperties -> LayerProperties', () => {
    const l = layer()
    const geo = seedGeo([l])
    act(() => {
      useCamStore.getState().addGeometryFolder('Brackets')
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } }))
      const folderId = useCamStore.getState().project.geometryFolders![0].id
      useCamStore.getState().setSelectedFolder(folderId, 'geometry')
    })
    const { rerender } = render(<PropertiesPanel />)
    expect(screen.queryByTestId('folder-action-row')).not.toBeNull()

    act(() => { useCamStore.getState().setSelectedLayer(l.id, geo.id) })
    rerender(<PropertiesPanel />)
    expect(screen.queryByTestId('layer-action-row')).not.toBeNull()
    expect(screen.queryByTestId('folder-action-row')).toBeNull()
  })

  it('REGRESSION PIN: a plain geometry selection still renders GeometryProperties (geo-action-row)', () => {
    const geo = seedGeo([layer()])
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [geo] } }))
      useCamStore.getState().setSelectedGeometry(geo.id)
    })
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('geo-action-row')).not.toBeNull()
    expect(screen.queryByTestId('layer-action-row')).toBeNull()
    expect(screen.queryByTestId('folder-action-row')).toBeNull()
  })
})
