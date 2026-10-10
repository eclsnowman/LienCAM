// WO-1845 / ADR-0051: the STL edit journal through the PRODUCTION entry points.
//
// Rule 6: any claim about what the application does runs through the
// application's own path. So nothing here hand-builds a partMesh and asserts
// on it - every assertion goes through `acquirePartMesh` (the one CAM seam all
// six store compute sites call, ADR-0051 R1), the store's own journal actions
// and undo, the store's real `saveProjectToFile`/`loadProjectFromFile`, and
// the store's `loadMeshEdgeChains` (R2).
//
// The framework's own parts are pinned in meshEditFramework.wo1845.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Operation, Project, Setup } from '../../types'

// In-memory STL cache: `collectProjectBinaries` reads through it at save and
// `hydrateCachesFromBinaries` writes through it at load, so the real save/load
// round trip below works with no IndexedDB.
const stlBytesById = new Map<string, ArrayBuffer>()

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytesById.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytesById.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytesById.delete(id) }),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { acquirePartMesh } = await import('../../cam3d/integration/parallel3dOperation')
import type { MeshEditRecord } from '../../mesh/edit'
const { createMeshEditRecord, FLIP_FACET_WINDING_KIND } = await import('../../mesh/edit')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { unitCube } = await import('./fixtures')

const GEO_ID = 'g-stl-1845'
const OP_ID = 'op-1845'
const SETUP_ID = 'setup-1845'
const TOLERANCE = 0.1

/** A 20 mm cube: closed, manifold, and with horizontal boundary chains at its
 *  top and bottom faces, so the edge-chain route (R2) has something to find. */
function fixtureBytes(): ArrayBuffer {
  return exportBinaryStl(unitCube(20)).bytes
}

function stlRow(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: GEO_ID, name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

function readyOp(): Operation {
  return {
    id: OP_ID, name: 'Parallel 3D', type: 'parallel_3d', status: 'ready',
    params: { geometryId: GEO_ID }, geometrySelections: [GEO_ID],
    toolId: null, enabled: true,
  } as unknown as Operation
}

function project(geometry: ImportedGeometry[]): Project {
  return {
    id: 'p-1845', name: 'Edit journal', version: '1.0.0',
    createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry,
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations: [readyOp()], stock: null, notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
    } as unknown as Setup],
    activeSetupId: SETUP_ID, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
    },
    notes: '',
  } as unknown as Project
}

function row(): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === GEO_ID)
  if (!found) throw new Error('the fixture row vanished')
  return found
}

function opStatus(): string {
  return useCamStore.getState().project.setups[0].operations[0].status
}

/** One flip-winding edit against the row's CURRENT mesh. */
function flipRecord(bytes: ArrayBuffer, facets: number[], id = 'edit-1'): MeshEditRecord {
  return createMeshEditRecord(importStl(bytes).mesh, { id, kind: FLIP_FACET_WINDING_KIND, facets })
}

/** Facet `f`'s three corner coordinates, in winding order. */
function corners(mesh: { positions: Float32Array; indices: Uint32Array }, f: number): number[][] {
  return [0, 1, 2].map((c) => {
    const at = mesh.indices[f * 3 + c] * 3
    return [mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]]
  })
}

function sameBuffers(a: { positions: Float32Array; indices: Uint32Array },
                     b: { positions: Float32Array; indices: Uint32Array }): boolean {
  return String(a.positions) === String(b.positions) && String(a.indices) === String(b.indices)
}

// The save path builds a Blob and clicks an anchor; capture the Blob instead.
let savedBlobs: Blob[] = []
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(async () => {
  stlBytesById.clear()
  stlBytesById.set(GEO_ID, fixtureBytes())
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1845' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.setState({ project: project([stlRow()]) })
})

describe('WO-1845 R1: the toolpath is computed from the EDITED part', () => {
  it('an STL with one edit produces a partMesh differing exactly by that edit', async () => {
    const bytes = fixtureBytes()
    const record = flipRecord(bytes, [0])

    const plain = await acquirePartMesh({ format: 'stl', bytes }, TOLERANCE)
    const edited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [record] }, TOLERANCE)

    // The edit moves no vertex and adds no triangle. Compare what the two
    // meshes actually DESCRIBE - each facet's three corners in winding order -
    // because the importer welds and renumbers vertices, so the raw buffers
    // legitimately differ in vertex ORDER for the same shape.
    expect(edited.indices.length).toBe(plain.indices.length)
    expect(edited.positions.length).toBe(plain.positions.length)
    expect(edited.bounds).toEqual(plain.bounds)
    const facets = plain.indices.length / 3
    let reversed = 0
    for (let f = 0; f < facets; f++) {
      const before = corners(plain, f)
      const after = corners(edited, f)
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      // Exactly the selected facet's winding is reversed: same three corners,
      // second and third swapped.
      expect(after).toEqual([before[0], before[2], before[1]])
      reversed++
    }
    expect(reversed).toBe(1)
  })

  it('removing the edit returns the IDENTICAL partMesh (buffer for buffer)', async () => {
    const bytes = fixtureBytes()
    const record = flipRecord(bytes, [0])
    const plain = await acquirePartMesh({ format: 'stl', bytes }, TOLERANCE)
    await acquirePartMesh({ format: 'stl', bytes, meshEdits: [record] }, TOLERANCE)
    const removed = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [] }, TOLERANCE)
    expect(sameBuffers(removed, plain)).toBe(true)
    const absent = await acquirePartMesh({ format: 'stl', bytes }, TOLERANCE)
    expect(sameBuffers(absent, plain)).toBe(true)
  })

  it('NEGATIVE CONTROL: bypassing the replay seam fails the edited-partMesh assertion', async () => {
    const bytes = fixtureBytes()
    const record = flipRecord(bytes, [0])
    const plain = await acquirePartMesh({ format: 'stl', bytes }, TOLERANCE)
    const edited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [record] }, TOLERANCE)
    expect(sameBuffers(edited, plain)).toBe(false)

    // Bypass: what the seam produced BEFORE this WO - the journal ignored.
    const bypassed = await acquirePartMesh({ format: 'stl', bytes }, TOLERANCE)
    expect(sameBuffers(bypassed, plain)).toBe(true)
    expect(sameBuffers(bypassed, edited)).toBe(false)
  })

  it('a journal that cannot replay stops at the bad edit, loudly, and keeps the earlier ones', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bytes = fixtureBytes()
    const first = flipRecord(bytes, [0], 'ok')
    const goodOnly = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [first] }, TOLERANCE)
    const broken: MeshEditRecord = { ...flipRecord(bytes, [1], 'broken'), facets: [9999] }

    const partial = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [first, broken] }, TOLERANCE)

    expect(sameBuffers(partial, goodOnly)).toBe(true)
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0][0])).toMatch(/could not be replayed/)
    consoleError.mockRestore()
  })
})

describe('WO-1845: the store owns the journal, through normal undo', () => {
  it('addMeshEdit appends one edit and outdates the ops that read the row', async () => {
    expect(opStatus()).toBe('ready')
    const record = await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })
    expect(row().meshEdits).toHaveLength(1)
    expect(row().meshEdits![0].id).toBe(record.id)
    expect(row().meshEdits![0].witness.facetCount).toBe(1)
    expect(opStatus()).toBe('outdated')
  })

  it('undo restores the no-edit row and redo restores the edit', async () => {
    await useCamStore.getState().addMeshEdit(GEO_ID, { kind: FLIP_FACET_WINDING_KIND, facets: [0] })
    expect(row().meshEdits).toHaveLength(1)

    useCamStore.getState().undo()
    expect(row().meshEdits ?? []).toHaveLength(0)

    useCamStore.getState().redo()
    expect(row().meshEdits).toHaveLength(1)
  })

  it('removeMeshEdit leaves NO journal field at all, not an empty one', async () => {
    const record = await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })
    useCamStore.getState().removeMeshEdit(GEO_ID, record.id)
    expect(row().meshEdits).toBeUndefined()
  })

  it('refuses by name on a row that is not an imported STL, and writes nothing', async () => {
    useCamStore.setState({ project: project([stlRow({ format: 'step', name: 'Bracket' })]) })
    await expect(useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })).rejects.toThrow(/"Bracket" is a STEP part; mesh edits are for imported STL parts/)
    expect(row().meshEdits).toBeUndefined()
  })

  it('refuses by name when the row has no cached bytes, and writes nothing', async () => {
    stlBytesById.clear()
    await expect(useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })).rejects.toThrow(/its mesh data is missing\. Re-import the STL/)
    expect(row().meshEdits).toBeUndefined()
  })

  it('refuses a selection the mesh does not have, and writes nothing', async () => {
    await expect(useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [99999],
    })).rejects.toThrow(/which this mesh does not have/)
    expect(row().meshEdits).toBeUndefined()
  })
})

describe('WO-1845: the journal survives the real save/load path', () => {
  it('saves, reloads and recomputes the SAME edited partMesh', async () => {
    await useCamStore.getState().addMeshEdit(GEO_ID, { kind: FLIP_FACET_WINDING_KIND, facets: [0] })
    const before = row().meshEdits!
    const expected = await acquirePartMesh(
      { format: 'stl', bytes: stlBytesById.get(GEO_ID)!, meshEdits: before }, TOLERANCE,
    )

    const fileText = await saveAndCaptureFile()
    // Everything in-memory is gone; all that survives is the file.
    stlBytesById.clear()
    useCamStore.setState({ project: project([]) })

    await useCamStore.getState().loadProjectFromFile(fileText)

    const reloaded = row().meshEdits
    expect(reloaded).toHaveLength(1)
    expect(reloaded![0]).toEqual(before[0])
    // The source bytes came back too (ADR-0051 s5.3: the journal rides in the
    // project JSON, the bytes ride in Project.binaries as they already did).
    const bytes = stlBytesById.get(GEO_ID)
    expect(bytes).toBeTruthy()
    const recomputed = await acquirePartMesh({ format: 'stl', bytes: bytes!, meshEdits: reloaded }, TOLERANCE)
    expect(sameBuffers(recomputed, expected)).toBe(true)
  })

  it('a project with NO edits writes no journal field at all', async () => {
    const fileText = await saveAndCaptureFile()
    expect(fileText).not.toContain('meshEdits')
    const saved = JSON.parse(fileText) as Project
    expect(saved.geometry[0].meshEdits).toBeUndefined()
  })

  it('a project whose last edit was removed saves exactly as a never-edited one', async () => {
    const untouched = await saveAndCaptureFile()
    const record = await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })
    const edited = await saveAndCaptureFile()
    expect(edited).toContain('meshEdits')

    useCamStore.getState().removeMeshEdit(GEO_ID, record.id)
    const cleared = await saveAndCaptureFile()
    expect(cleared).not.toContain('meshEdits')
    // updatedAt is stamped per save; the geometry rows must match exactly.
    expect(JSON.parse(cleared).geometry).toEqual(JSON.parse(untouched).geometry)
  })
})

describe('WO-1845 R2: STL edge chains come off the replayed mesh', () => {
  it('derives chains for an unedited row, and reads the journal when there is one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plain = await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(plain.length).toBeGreaterThan(0)

    // A journal that cannot replay proves the route goes THROUGH replay: the
    // chain derivation fires replay's own fail-closed console line. A route
    // that parsed the bytes itself would be silent here.
    useCamStore.setState({
      project: project([stlRow({
        meshEdits: [{ ...flipRecord(fixtureBytes(), [0]), facets: [9999] }],
      })]),
    })
    await useCamStore.getState().loadMeshEdgeChains(GEO_ID)
    expect(consoleError).toHaveBeenCalled()
    expect(String(consoleError.mock.calls[0][0])).toMatch(/could not be replayed/)
    consoleError.mockRestore()
  })
})

describe('WO-1845 R6: a duplicated row carries the journal with the bytes', () => {
  it('the duplicate produced by the panel keeps the edits', async () => {
    const record = await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: FLIP_FACET_WINDING_KIND, facets: [0],
    })
    // The panel's duplicate reaches for the viewport handle off `window`;
    // there is no browser here, so give it the same "no viewport" shape a
    // headless run of the real app has.
    vi.stubGlobal('window', {})
    const { duplicateGeometryRow } = await import('../../components/panels/PropertiesPanel')
    try {
      await duplicateGeometryRow(row())
    } finally {
      vi.unstubAllGlobals()
    }
    const copy = useCamStore.getState().project.geometry.find((g) => g.id !== GEO_ID)
    expect(copy).toBeTruthy()
    expect(copy!.meshEdits).toHaveLength(1)
    expect(copy!.meshEdits![0].id).toBe(record.id)
  })
})
