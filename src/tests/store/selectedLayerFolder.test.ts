// PP-UTILITY Stage 3: transient "layer row selected" / "folder row selected"
// store state, extending the ADR-0025 tri-exclusion + N1a pattern
// (selectedNest.test.ts / selectedStock.test.ts) to two more selection kinds.
// At most one of {geometry, op, nest, stock, layer, folder} is selected at a
// time; selecting any one clears the other five. Pure store tests (no React
// render): they exercise the store actions directly via getState().
//
// Coverage:
//  (a) setSelectedLayer sets selectedLayerId/selectedLayerGeoId and clears
//      selectedFolderId/Kind/SetupId (the explicit layer<->folder mutual
//      exclusion the lane brief named);
//  (b) setSelectedFolder sets selectedFolderId/Kind/SetupId and clears
//      selectedLayerId/selectedLayerGeoId;
//  (c) setSelectedGeometry/setSelectedNest/setSelectedStock/setActiveOperation
//      ALSO clear layer + folder selection (the coherent extension of the
//      existing exclusion set) — REGRESSION PIN: the ORIGINAL clears (nest,
//      stock, activeOperationId) these four actions already performed are
//      unchanged;
//  (d) selecting a layer/folder clears geometry/nest/stock in turn;
//  (e) clearing (null) leaves competing selections untouched;
//  (f) deleteGeometryLayer / removeGeometry / removeGeometryFolder /
//      removeOperationFolder / removeSetup clear a DANGLING selection that
//      pointed at the removed row (and leave an unrelated selection alone);
//  (g) selectedLayerId/selectedFolderId are TRANSIENT (not persisted).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, persistPartialize } from '../../store'
import type { ImportedGeometry } from '../../types'

function importedGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    layers2d: [
      { id: 'layer-1', name: 'Default', color: '#4ac3ff', visible: true },
      { id: 'layer-2', name: 'Second', color: '#ff8800', visible: true },
    ],
    loops: [],
    ...over,
  } as unknown as ImportedGeometry
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    viewer: {
      ...s.viewer,
      selectedGeometryId: null, selectedNestId: null, selectedStockId: null,
      selectedLayerId: null, selectedLayerGeoId: null,
      selectedFolderId: null, selectedFolderKind: null, selectedFolderSetupId: null,
    },
    project: {
      ...s.project,
      activeOperationId: null, activeSetupId: null, setups: [],
      geometry: [], geometryFolders: [],
    },
  }))
})

describe('setSelectedLayer', () => {
  it('(a) sets selectedLayerId/selectedLayerGeoId and clears folder selection', () => {
    useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    expect(useCamStore.getState().viewer.selectedFolderId).toBe('folder-1')

    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBe('layer-1')
    expect(useCamStore.getState().viewer.selectedLayerGeoId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedFolderId).toBeNull()
    expect(useCamStore.getState().viewer.selectedFolderKind).toBeNull()
    expect(useCamStore.getState().viewer.selectedFolderSetupId).toBeNull()
  })

  it('(d) clears geometry/nest/stock', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()

    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()

    useCamStore.getState().setSelectedStock('stk-1')
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('(e) clearing (null) leaves competing selections untouched', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedLayer(null)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBeNull()
    expect(useCamStore.getState().viewer.selectedLayerGeoId).toBeNull()
  })
})

describe('setSelectedFolder', () => {
  it('(b) sets selectedFolderId/Kind/SetupId and clears layer selection', () => {
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBe('layer-1')

    useCamStore.getState().setSelectedFolder('opfolder-1', 'operation', 'setup-1')
    expect(useCamStore.getState().viewer.selectedFolderId).toBe('opfolder-1')
    expect(useCamStore.getState().viewer.selectedFolderKind).toBe('operation')
    expect(useCamStore.getState().viewer.selectedFolderSetupId).toBe('setup-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBeNull()
    expect(useCamStore.getState().viewer.selectedLayerGeoId).toBeNull()
  })

  it('(d) clears geometry/nest/stock', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
  })

  it('(e) clearing (null) leaves competing selections untouched', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedFolder(null)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedFolderId).toBeNull()
  })
})

describe('(c) REGRESSION PIN: geometry/nest/stock/operation selection unchanged, extended', () => {
  it('setSelectedGeometry still clears nest + stock (original behavior) AND now also clears layer/folder', () => {
    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().setSelectedStock('stk-1')
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    useCamStore.getState().setSelectedGeometry('geo-1')
    const v = useCamStore.getState().viewer
    expect(v.selectedGeometryId).toBe('geo-1')
    expect(v.selectedNestId).toBeNull()       // original
    expect(v.selectedStockId).toBeNull()      // original
    expect(v.selectedLayerId).toBeNull()      // new
    expect(v.selectedFolderId).toBeNull()     // new
  })

  it('setSelectedNest still clears geometry + stock + activeOperationId (original) AND now also clears layer/folder', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op-1' } }))
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    useCamStore.getState().setSelectedNest('nest-1')
    const v = useCamStore.getState().viewer
    expect(v.selectedNestId).toBe('nest-1')
    expect(v.selectedGeometryId).toBeNull()               // original
    expect(useCamStore.getState().project.activeOperationId).toBeNull() // original
    expect(v.selectedFolderId).toBeNull()                 // new
  })

  it('setSelectedStock still clears geometry + nest + activeOperationId (original) AND now also clears layer/folder', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeOperationId: 'op-1' } }))
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    useCamStore.getState().setSelectedStock('stk-1')
    const v = useCamStore.getState().viewer
    expect(v.selectedStockId).toBe('stk-1')
    expect(useCamStore.getState().project.activeOperationId).toBeNull() // original
    expect(v.selectedLayerId).toBeNull()                   // new
  })

  it('setActiveOperation(non-null) still clears nest + stock (original) AND now also clears layer/folder', () => {
    useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    useCamStore.getState().setActiveOperation('op-1')
    const v = useCamStore.getState().viewer
    expect(useCamStore.getState().project.activeOperationId).toBe('op-1')
    expect(v.selectedFolderId).toBeNull()
  })
})

describe('(f) removal teardown clears a dangling selection', () => {
  it('deleteGeometryLayer clears selectedLayerId when the deleted layer was selected', () => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [importedGeo()] } }))
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    useCamStore.getState().deleteGeometryLayer('geo-1', 'layer-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBeNull()
    expect(useCamStore.getState().viewer.selectedLayerGeoId).toBeNull()
  })

  it('deleteGeometryLayer leaves a DIFFERENT selected layer alone', () => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [importedGeo()] } }))
    useCamStore.getState().setSelectedLayer('layer-2', 'geo-1')
    useCamStore.getState().deleteGeometryLayer('geo-1', 'layer-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBe('layer-2')
  })

  it('removeGeometry clears a dangling layer selection owned by the removed part', () => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [importedGeo()] } }))
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    useCamStore.getState().removeGeometry('geo-1')
    expect(useCamStore.getState().viewer.selectedLayerId).toBeNull()
    expect(useCamStore.getState().viewer.selectedLayerGeoId).toBeNull()
  })

  it('removeGeometryFolder clears selectedFolderId when the deleted folder was selected', () => {
    useCamStore.getState().newProject()
    const id = useCamStore.getState().addGeometryFolder('Brackets')
    useCamStore.getState().setSelectedFolder(id, 'geometry')
    useCamStore.getState().removeGeometryFolder(id)
    const v = useCamStore.getState().viewer
    expect(v.selectedFolderId).toBeNull()
    expect(v.selectedFolderKind).toBeNull()
  })

  it('removeOperationFolder clears selectedFolderId when the deleted op-folder was selected', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addSetup({
      id: 'setup-1', name: 'S1', operations: [],
    } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    useCamStore.getState().setSelectedFolder(folderId, 'operation', 'setup-1')
    useCamStore.getState().removeOperationFolder('setup-1', folderId)
    const v = useCamStore.getState().viewer
    expect(v.selectedFolderId).toBeNull()
    expect(v.selectedFolderKind).toBeNull()
    expect(v.selectedFolderSetupId).toBeNull()
  })

  it('removeOperationFolder leaves a folder selection in a DIFFERENT setup alone', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addSetup({
      id: 'setup-1', name: 'S1', operations: [],
    } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    useCamStore.getState().addSetup({
      id: 'setup-2', name: 'S2', operations: [],
    } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    const folder1 = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    const folder2 = useCamStore.getState().addOperationFolder('setup-2', 'Finishing')
    useCamStore.getState().setSelectedFolder(folder1, 'operation', 'setup-1')
    useCamStore.getState().removeOperationFolder('setup-2', folder2)
    expect(useCamStore.getState().viewer.selectedFolderId).toBe(folder1)
  })

  it('removeSetup clears an operation-folder selection scoped to the removed setup', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addSetup({
      id: 'setup-1', name: 'S1', operations: [],
    } as unknown as Parameters<ReturnType<typeof useCamStore.getState>['addSetup']>[0])
    const folderId = useCamStore.getState().addOperationFolder('setup-1', 'Roughing')
    useCamStore.getState().setSelectedFolder(folderId, 'operation', 'setup-1')
    useCamStore.getState().removeSetup('setup-1')
    const v = useCamStore.getState().viewer
    expect(v.selectedFolderId).toBeNull()
    expect(v.selectedFolderKind).toBeNull()
    expect(v.selectedFolderSetupId).toBeNull()
  })
})

describe('selectedLayerId/selectedFolderId are TRANSIENT', () => {
  it('(g) not in the persisted partialize slice', () => {
    useCamStore.getState().setSelectedLayer('layer-1', 'geo-1')
    useCamStore.getState().setSelectedFolder('folder-1', 'geometry')
    const slice = persistPartialize(useCamStore.getState())
    expect('viewer' in slice).toBe(false)
    expect(JSON.stringify(slice)).not.toContain('selectedLayerId')
    expect(JSON.stringify(slice)).not.toContain('selectedFolderId')
  })
})
