// Geometry folders (Stage A: data model + store actions only; the DesignTree UI
// is Stage B). These tests prove the store actions and — critically — that
// removeGeometryFolder CASCADE-deletes the folder AND its contained geometry by
// routing through the SAME store-side teardown removeGeometry uses (membership
// re-sort, derived-stock re-wrap, selection clear), with ONE undo entry, while
// leaving geometry in OTHER folders / at the root untouched. A nested child
// folder cascades too, even though v1's UI only creates flat root folders.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, GeometryFolder, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  } as ImportedGeometry
}

// Install a clean project (no stocks/setups) + clear undo history so each test
// asserts against a known baseline.
function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      geometryFolders: [],
      setups: [],
      stocks: undefined,
      ...over,
    },
    projectHistory: [],
    canUndo: false,
  }))
}

function geoIds(): string[] {
  return useCamStore.getState().project.geometry.map((g) => g.id)
}
function folderIds(): string[] {
  return (useCamStore.getState().project.geometryFolders ?? []).map((f) => f.id)
}

beforeEach(() => {
  installProject({})
})

// =============================================================================
// addGeometryFolder
// =============================================================================

describe('addGeometryFolder', () => {
  it('creates a ROOT folder (parentId null) and returns its id', () => {
    const id = useCamStore.getState().addGeometryFolder('Brackets')
    const folders = useCamStore.getState().project.geometryFolders!
    expect(folders).toHaveLength(1)
    expect(folders[0].id).toBe(id)
    expect(folders[0].name).toBe('Brackets')
    expect(folders[0].parentId).toBeNull()
  })

  it('records a parentId when one is given (FUTURE nesting)', () => {
    const parent = useCamStore.getState().addGeometryFolder('Parent')
    const child = useCamStore.getState().addGeometryFolder('Child', parent)
    const f = useCamStore.getState().project.geometryFolders!.find((x) => x.id === child)!
    expect(f.parentId).toBe(parent)
  })

  it('pushes one undo entry per create (history-tracked)', () => {
    expect(useCamStore.getState().canUndo).toBe(false)
    useCamStore.getState().addGeometryFolder('A')
    expect(useCamStore.getState().canUndo).toBe(true)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)
  })
})

// =============================================================================
// setGeometryFolderId
// =============================================================================

describe('setGeometryFolderId', () => {
  beforeEach(() => {
    installProject({ geometry: [makeGeo({ id: 'g1' })] })
  })

  it('moves a geometry INTO a folder', () => {
    const fid = useCamStore.getState().addGeometryFolder('F')
    useCamStore.getState().setGeometryFolderId('g1', fid)
    expect(useCamStore.getState().project.geometry[0].folderId).toBe(fid)
  })

  it('moves a geometry back to the ROOT with null', () => {
    const fid = useCamStore.getState().addGeometryFolder('F')
    useCamStore.getState().setGeometryFolderId('g1', fid)
    useCamStore.getState().setGeometryFolderId('g1', null)
    expect(useCamStore.getState().project.geometry[0].folderId).toBeNull()
  })

  it('is a no-op (no history) when the folder is unchanged', () => {
    installProject({ geometry: [makeGeo({ id: 'g1' })] })
    useCamStore.getState().setGeometryFolderId('g1', null) // already root (undefined)
    expect(useCamStore.getState().canUndo).toBe(false)
  })
})

// =============================================================================
// setModelItemFolderId (GEO-UNIFY Stage 2)
// =============================================================================

describe('setModelItemFolderId', () => {
  beforeEach(() => {
    installProject({ modelItems: [{ id: 'item-1', name: 'Item 1' }] })
  })

  it('moves an empty model item INTO a folder', () => {
    const fid = useCamStore.getState().addGeometryFolder('F')
    useCamStore.getState().setModelItemFolderId('item-1', fid)
    expect(useCamStore.getState().project.modelItems![0].folderId).toBe(fid)
  })

  it('moves an empty model item back to the ROOT with null', () => {
    const fid = useCamStore.getState().addGeometryFolder('F')
    useCamStore.getState().setModelItemFolderId('item-1', fid)
    useCamStore.getState().setModelItemFolderId('item-1', null)
    expect(useCamStore.getState().project.modelItems![0].folderId).toBeNull()
  })

  it('is a no-op (no history) when the folder is unchanged', () => {
    useCamStore.getState().setModelItemFolderId('item-1', null) // already root (undefined)
    expect(useCamStore.getState().canUndo).toBe(false)
  })

  it('is a no-op for an unknown item id', () => {
    const before = useCamStore.getState().projectHistory.length
    useCamStore.getState().setModelItemFolderId('ghost', 'some-folder')
    expect(useCamStore.getState().projectHistory).toHaveLength(before)
  })

  it('pushes one undo entry per move', () => {
    const fid = useCamStore.getState().addGeometryFolder('F')
    useCamStore.setState({ projectHistory: [], canUndo: false })
    useCamStore.getState().setModelItemFolderId('item-1', fid)
    expect(useCamStore.getState().canUndo).toBe(true)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)
  })
})

// =============================================================================
// renameGeometryFolder
// =============================================================================

describe('renameGeometryFolder', () => {
  it('renames in place', () => {
    const id = useCamStore.getState().addGeometryFolder('Old')
    useCamStore.getState().renameGeometryFolder(id, 'New')
    expect(useCamStore.getState().project.geometryFolders![0].name).toBe('New')
  })

  it('is a no-op for an unknown id and for an unchanged name', () => {
    const id = useCamStore.getState().addGeometryFolder('Keep')
    const histAfterAdd = useCamStore.getState().projectHistory.length
    useCamStore.getState().renameGeometryFolder('nope', 'X')
    useCamStore.getState().renameGeometryFolder(id, 'Keep')
    expect(useCamStore.getState().projectHistory).toHaveLength(histAfterAdd)
  })
})

// =============================================================================
// removeGeometryFolder — CASCADE
// =============================================================================

describe('removeGeometryFolder cascade', () => {
  it('deletes the folder AND every geometry contained in it', () => {
    const fid = useCamStore.getState().addGeometryFolder('Doomed')
    installProjectWithFolders(
      [fid],
      [
        makeGeo({ id: 'in-1', folderId: fid }),
        makeGeo({ id: 'in-2', folderId: fid }),
      ],
    )
    useCamStore.getState().removeGeometryFolder(fid)
    expect(folderIds()).not.toContain(fid)
    expect(geoIds()).not.toContain('in-1')
    expect(geoIds()).not.toContain('in-2')
    expect(geoIds()).toHaveLength(0)
  })

  it('leaves geometry in OTHER folders and at the ROOT untouched', () => {
    const doomed = useCamStore.getState().addGeometryFolder('Doomed')
    const keep = useCamStore.getState().addGeometryFolder('Keep')
    installProjectWithFolders(
      [doomed, keep],
      [
        makeGeo({ id: 'doomed-geo', folderId: doomed }),
        makeGeo({ id: 'keep-geo', folderId: keep }),
        makeGeo({ id: 'root-geo', folderId: null }),
      ],
    )
    useCamStore.getState().removeGeometryFolder(doomed)
    expect(folderIds()).toEqual([keep])
    expect(geoIds().sort()).toEqual(['keep-geo', 'root-geo'])
    // The surviving geometry kept its folder membership.
    const kept = useCamStore.getState().project.geometry.find((g) => g.id === 'keep-geo')!
    expect(kept.folderId).toBe(keep)
  })

  it('routes the cascade through the SAME teardown (clears the viewer selection)', () => {
    const fid = useCamStore.getState().addGeometryFolder('Doomed')
    installProjectWithFolders([fid], [makeGeo({ id: 'sel', folderId: fid })])
    // Select the contained geometry — removeGeometry's teardown clears it on delete.
    useCamStore.setState((s) => ({ viewer: { ...s.viewer, selectedGeometryId: 'sel' } }))
    useCamStore.getState().removeGeometryFolder(fid)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
  })

  it('cascades a NESTED child folder + its geometry (flat-UI v1, nested-ready model)', () => {
    const parent = useCamStore.getState().addGeometryFolder('Parent')
    const child = useCamStore.getState().addGeometryFolder('Child', parent)
    installProjectWithFolders(
      [parent, child],
      [
        makeGeo({ id: 'p-geo', folderId: parent }),
        makeGeo({ id: 'c-geo', folderId: child }),
      ],
    )
    useCamStore.getState().removeGeometryFolder(parent)
    // Both folders gone, and BOTH the parent's and the nested child's geometry gone.
    expect(folderIds()).toHaveLength(0)
    expect(geoIds()).toHaveLength(0)
  })

  it('uses ONE undo entry for the whole cascade (not one per child)', () => {
    const fid = useCamStore.getState().addGeometryFolder('Doomed')
    installProjectWithFolders(
      [fid],
      [
        makeGeo({ id: 'a', folderId: fid }),
        makeGeo({ id: 'b', folderId: fid }),
        makeGeo({ id: 'c', folderId: fid }),
      ],
    )
    // Reset history right before the cascade so we count only its entries.
    useCamStore.setState({ projectHistory: [], canUndo: false })
    useCamStore.getState().removeGeometryFolder(fid)
    expect(useCamStore.getState().projectHistory).toHaveLength(1)
    // And undo restores everything in one step.
    useCamStore.getState().undo()
    expect(geoIds().sort()).toEqual(['a', 'b', 'c'])
    expect(folderIds()).toEqual([fid])
  })

  it('is a no-op for an unknown folder id', () => {
    installProjectWithFolders([], [makeGeo({ id: 'g', folderId: null })])
    useCamStore.setState({ projectHistory: [], canUndo: false })
    useCamStore.getState().removeGeometryFolder('ghost')
    expect(geoIds()).toEqual(['g'])
    expect(useCamStore.getState().canUndo).toBe(false)
  })

  // GEO-UNIFY Stage 2: the same "kept and re-parented to root" mercy INT-17A-R1
  // C4 gives a survivor modeled body (above) extends to an EMPTY model item's
  // placeholder row -- it has no project.geometry entry of its own to catch
  // that survivors filter, so the folderId lives on the ModelItemRecord and
  // must be cleared directly by the cascade.
  it('clears an EMPTY model item\'s folderId (re-parents the placeholder to root) instead of orphaning it', () => {
    const fid = useCamStore.getState().addGeometryFolder('Doomed')
    installProjectWithFolders([fid], [])
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-1', name: 'Item 1', folderId: fid }] },
    }))
    useCamStore.getState().removeGeometryFolder(fid)
    expect(folderIds()).not.toContain(fid)
    expect(useCamStore.getState().project.modelItems).toEqual([
      { id: 'item-1', name: 'Item 1', folderId: null },
    ])
  })

  it('leaves a model item pointed at a DIFFERENT (surviving) folder untouched', () => {
    const doomed = useCamStore.getState().addGeometryFolder('Doomed')
    const keep = useCamStore.getState().addGeometryFolder('Keep')
    installProjectWithFolders([doomed, keep], [])
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: 'item-1', name: 'Item 1', folderId: keep }] },
    }))
    useCamStore.getState().removeGeometryFolder(doomed)
    expect(useCamStore.getState().project.modelItems![0].folderId).toBe(keep)
  })
})

// Helper: seed the project with a given set of folders (by id) and geometry,
// preserving the folders already created via addGeometryFolder.
function installProjectWithFolders(
  folderIdsToKeep: string[],
  geometry: ImportedGeometry[],
): void {
  const existing = useCamStore.getState().project.geometryFolders ?? []
  const folders: GeometryFolder[] = existing.filter((f) => folderIdsToKeep.includes(f.id))
  useCamStore.setState((s) => ({
    project: { ...s.project, geometry, geometryFolders: folders, setups: [], stocks: undefined },
  }))
}
