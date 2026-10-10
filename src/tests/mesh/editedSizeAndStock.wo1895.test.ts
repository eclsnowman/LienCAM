// WO-1895: an edited STL reports its NEW size, and Auto Stock follows.
//
// Rule 6: every assertion runs through the application's own routes - the
// store's `addMeshEdit` / `removeMeshEdit` / undo, the face picker in
// `src/mesh/recognition`, and the store's `deriveAutoStockBounds` /
// `resolveTopZ` seams that Properties, the Auto Stock box and the operation
// heights all read. Nothing hand-builds a bounding box and asserts on it.
//
// The fixture is the WO-1849 stepped block (copied, not imported: a vitest
// file that imports another test file would run its module mocks and suites -
// the precedent WO-1850 and WO-1854 set): four 15 mm treads 60 x 20 in plan at
// Z 12, 6, 12 and 3. Pulling the left-hand Z 12 tread out 2 mm raises the
// part's overall height from 12 to 14.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, PhysicalStock, Project, Setup } from '../../types'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

// In-memory STL cache: `addMeshEdit` / `removeMeshEdit` read through it, so the
// edit routes work with no IndexedDB.
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
const { deriveAutoStockBounds, resolveTopZ } = await import('../../store/dispatchGeo')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { sourceFacetIdsOf } = await import('../../mesh/edit')
const { recognizeFlatFaces } = await import('../../mesh/recognition')
const { MOVE_FLAT_FACE_KIND } = await import('../../mesh/edit')
const { deriveStockBounds } = await import('../../store/stockAssignment')

const GEO_ID = 'g-stl-1895'
const OP_ID = 'op-1895'
const SETUP_ID = 'setup-1895'

// ---------------------------------------------------------------- fixture

class Soup {
  private readonly coords: number[] = []
  tri(a: Vec3, b: Vec3, c: Vec3): void { this.coords.push(...a, ...b, ...c) }
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void { this.tri(a, b, c); this.tri(a, c, d) }
  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }
  bytes(): ArrayBuffer { return exportBinaryStl(this.mesh()).bytes }
}

const STEP_Y = 20
const STEP_COLUMNS = [
  { x0: 0, x1: 15, top: 12 },
  { x0: 15, x1: 30, top: 6 },
  { x0: 30, x1: 45, top: 12 },
  { x0: 45, x1: 60, top: 3 },
]
const STEP_LEVELS = [0, 3, 6, 12]

function steppedBlock(): ArrayBuffer {
  const soup = new Soup()
  const bands = (za: number, zb: number): Array<[number, number]> => {
    const cuts = STEP_LEVELS.filter((z) => z >= za && z <= zb)
    return cuts.slice(0, -1).map((z, k) => [z, cuts[k + 1]] as [number, number])
  }
  for (const column of STEP_COLUMNS) {
    const { x0, x1, top } = column
    soup.quad([x0, 0, 0], [x0, STEP_Y, 0], [x1, STEP_Y, 0], [x1, 0, 0])
    soup.quad([x0, 0, top], [x1, 0, top], [x1, STEP_Y, top], [x0, STEP_Y, top])
    for (const [za, zb] of bands(0, top)) {
      soup.quad([x0, 0, za], [x1, 0, za], [x1, 0, zb], [x0, 0, zb])
      soup.quad([x0, STEP_Y, za], [x0, STEP_Y, zb], [x1, STEP_Y, zb], [x1, STEP_Y, za])
    }
  }
  const heightAt = (index: number): number => STEP_COLUMNS[index]?.top ?? 0
  for (let boundary = 0; boundary <= STEP_COLUMNS.length; boundary++) {
    const x = boundary === 0 ? STEP_COLUMNS[0].x0 : STEP_COLUMNS[boundary - 1].x1
    const left = boundary === 0 ? 0 : heightAt(boundary - 1)
    const right = heightAt(boundary)
    if (left === right) continue
    const facesPlusX = left > right
    for (const [za, zb] of bands(Math.min(left, right), Math.max(left, right))) {
      if (facesPlusX) soup.quad([x, 0, za], [x, STEP_Y, za], [x, STEP_Y, zb], [x, 0, zb])
      else soup.quad([x, 0, za], [x, 0, zb], [x, STEP_Y, zb], [x, STEP_Y, za])
    }
  }
  return soup.bytes()
}

// ---------------------------------------------------------------- store

function readyOp(): Record<string, unknown> {
  return {
    id: OP_ID, name: 'Parallel 3D', type: 'parallel_3d', status: 'ready',
    params: { geometryId: GEO_ID }, geometrySelections: [GEO_ID],
    toolId: null, enabled: true,
  }
}

function project(geometry: ImportedGeometry[], stocks?: PhysicalStock[]): Project {
  return {
    id: 'p-1895', name: 'Edited size', version: '1.0.0',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry, stocks,
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
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
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

/** The row as the import path leaves it: XY centred, bottom on Z 0 - the frame
 *  CNCViewport.addSTL renders the part in and importGeometryFile persists. */
function importedRow(bytes: ArrayBuffer): ImportedGeometry {
  const mesh = importStl(bytes).mesh
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]); maxX = Math.max(maxX, mesh.positions[i])
    minY = Math.min(minY, mesh.positions[i + 1]); maxY = Math.max(maxY, mesh.positions[i + 1])
    minZ = Math.min(minZ, mesh.positions[i + 2]); maxZ = Math.max(maxZ, mesh.positions[i + 2])
  }
  const shift = { x: -(minX + maxX) / 2, y: -(minY + maxY) / 2, z: -minZ }
  const min = { x: minX + shift.x, y: minY + shift.y, z: minZ + shift.z }
  const max = { x: maxX + shift.x, y: maxY + shift.y, z: maxZ + shift.z }
  return {
    id: GEO_ID, name: 'Stepped block', filename: 'stepped-block.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min, max,
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as ImportedGeometry
}

/** The current-mesh facet indices of the flat face facing up at Z `z`, picked
 *  through the product's own recogniser exactly as the Properties panel does. */
function facetsOfTopFace(bytes: ArrayBuffer, z: number): number[] {
  const parsed = importStl(bytes)
  const sourceFacetIds = sourceFacetIdsOf(parsed.mesh)
  const faces = recognizeFlatFaces(parsed.mesh, sourceFacetIds).faces
  const face = faces.find(
    (f) => Math.abs(f.plane.normal[2] - 1) < 1e-6 && Math.abs(f.plane.point[2] - z) < 1e-6,
  )
  if (!face) throw new Error(`no face facing up at Z ${z} - the fixture changed`)
  const wanted = new Set(face.sourceFacetIds)
  const facets: number[] = []
  sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) facets.push(facet) })
  return facets
}

function autoStockZ(geo: ImportedGeometry): { min: number; max: number } {
  const b = deriveAutoStockBounds([geo], {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
  })
  if (!b) throw new Error('deriveAutoStockBounds returned null')
  return { min: b.min.z, max: b.max.z }
}

beforeEach(() => {
  stlBytesById.clear()
  const bytes = steppedBlock()
  stlBytesById.set(GEO_ID, bytes)
  useCamStore.setState({ project: project([importedRow(bytes)]) })
})

describe('WO-1895: an edit moves the reported size and Auto Stock', () => {
  it('the imported block reports 60 x 20 x 12 with the Auto Stock 1 mm above it', () => {
    const row = useCamStore.getState().project.geometry[0]
    expect(row.boundingBox.size.x).toBeCloseTo(60, 3)
    expect(row.boundingBox.size.y).toBeCloseTo(20, 3)
    expect(row.boundingBox.size.z).toBeCloseTo(12, 3)
    const auto = autoStockZ(row)
    expect(auto.max).toBeCloseTo(13, 3) // 12 + autoOffsetZTop 1
  })

  it('pulling the Z 12 tread out 2 mm makes the size 60 x 20 x 14 and lifts the stock', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    const facets = facetsOfTopFace(bytes, 12)
    await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets, parameters: { distanceMm: 2 },
    })

    const edited = row()
    expect(edited.meshEdits).toHaveLength(1)
    expect(edited.boundingBox.size.x).toBeCloseTo(60, 3)
    expect(edited.boundingBox.size.y).toBeCloseTo(20, 3)
    expect(edited.boundingBox.size.z).toBeCloseTo(14, 3)
    expect(edited.boundingBox.max.z).toBeCloseTo(14, 3)

    const auto = autoStockZ(edited)
    expect(auto.max).toBeGreaterThanOrEqual(14)
    expect(auto.max).toBeCloseTo(15, 3) // 14 + autoOffsetZTop 1
  })

  it('the operation top height follows the edit (model_top reads the new box)', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    const before = resolveTopZ(
      'model_top', 0, useCamStore.getState().project.setups[0],
      useCamStore.getState().project.sceneStock, [row()], GEO_ID,
    )
    expect(before).toBeCloseTo(12, 3)

    await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets: facetsOfTopFace(bytes, 12), parameters: { distanceMm: 2 },
    })
    const after = resolveTopZ(
      'model_top', 0, useCamStore.getState().project.setups[0],
      useCamStore.getState().project.sceneStock, [row()], GEO_ID,
    )
    expect(after).toBeCloseTo(14, 3)
  })

  it('undo returns size, Auto Stock and the operation top all to 12', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets: facetsOfTopFace(bytes, 12), parameters: { distanceMm: 2 },
    })
    expect(row().boundingBox.size.z).toBeCloseTo(14, 3)

    useCamStore.getState().undo()
    expect(row().meshEdits ?? []).toHaveLength(0)
    expect(row().boundingBox.size.z).toBeCloseTo(12, 3)
    expect(autoStockZ(row()).max).toBeCloseTo(13, 3)
    const top = resolveTopZ(
      'model_top', 0, useCamStore.getState().project.setups[0],
      useCamStore.getState().project.sceneStock, [row()], GEO_ID,
    )
    expect(top).toBeCloseTo(12, 3)
  })

  it('removing the edit also returns the size to 12', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    const record = await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets: facetsOfTopFace(bytes, 12), parameters: { distanceMm: 2 },
    })
    expect(row().boundingBox.size.z).toBeCloseTo(14, 3)
    await useCamStore.getState().removeMeshEdit(GEO_ID, record.id)
    expect(row().meshEdits).toBeUndefined()
    expect(row().boundingBox.size.z).toBeCloseTo(12, 3)
    expect(autoStockZ(row()).max).toBeCloseTo(13, 3)
  })

  it('NEGATIVE CONTROL: the box the fix replaces (the imported one) still reads 12 after the edit', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    // What the row read BEFORE WO-1895: the imported box, untouched by a journal
    // change. If the assertion below passed against THIS box, the test would not
    // be measuring the fix.
    const importedBox = { ...row().boundingBox }
    await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets: facetsOfTopFace(bytes, 12), parameters: { distanceMm: 2 },
    })
    expect(importedBox.size.z).toBeCloseTo(12, 3)
    expect(row().boundingBox.size.z).toBeCloseTo(14, 3)
    expect(row().boundingBox.size.z).not.toBeCloseTo(importedBox.size.z, 3)
  })
})

describe('WO-1895: a named AUTO stock re-wraps when its member is edited', () => {
  it('the derived PhysicalStock bounds grow with the edited part', async () => {
    const bytes = stlBytesById.get(GEO_ID)!
    const autoStock: PhysicalStock = {
      id: 'auto-1', name: 'Auto Stock 1', mode: 'derived', bounds: {
        min: { x: -32, y: -12, z: -1 }, max: { x: 32, y: 12, z: 13 },
        size: { x: 64, y: 24, z: 14 }, center: { x: 0, y: 0, z: 6 },
      },
    } as unknown as PhysicalStock
    useCamStore.setState({
      project: {
        ...useCamStore.getState().project,
        stocks: [autoStock],
        sceneStock: {
          ...useCamStore.getState().project.sceneStock,
          autoStocks: [{
            id: 'auto-1', name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0,
          }],
        },
      },
    })
    await useCamStore.getState().addMeshEdit(GEO_ID, {
      kind: MOVE_FLAT_FACE_KIND, facets: facetsOfTopFace(bytes, 12), parameters: { distanceMm: 2 },
    })
    const stock = useCamStore.getState().project.stocks!.find((s) => s.id === 'auto-1')!
    const derived = deriveStockBounds(
      stock, useCamStore.getState().project.geometry,
      { autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0 },
    )
    expect(derived).toBeTruthy()
    expect(derived!.max.z).toBeCloseTo(15, 3)
  })
})