// WO-1910: an STL gains an add-or-subtract edit - a box or a cylinder, added
// to the part or cut out of it, as one journal entry.
//
// Rule 6: every fixture is real binary STL bytes parsed back through
// `importStl`; every edit is minted with the framework's own
// `createMeshEditRecord` against the resolved mesh and replayed by
// `resolveEditedStlMesh`, the resolver every route runs. The store half runs
// the store's own `addMeshEdit`, undo and save/load; the CAM half runs the
// product's `acquirePartMesh` + `computeParallel3dMoves` on a real BvhKernel.
//
// ON WELDING, said once (as in WO-1850's file): an STL is a triangle soup and
// `analyzeMesh` builds its topology from vertex INDICES, so every health and
// shell assertion runs on `welded()` - re-indexed by exact coordinate, not one
// number changed - before AND after.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry, Project, Setup } from '../../types'

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
const { analyzeMesh, measureMesh } = await import('../../mesh/analysis')
const { exportBinaryStl } = await import('../../mesh/stl')
const {
  BOOLEAN_BODY_KIND,
  NO_SOURCE_FACET,
  boreSegments,
  booleanBodyOperand,
  booleanBodyOperation,
  booleanBodyRefusal,
  booleanBodySelection,
  createMeshEditRecord,
  describeMeshEdit,
  primeBoringKernel,
  resolveEditedStlMesh,
} = await import('../../mesh/edit')
const {
  booleanMesh,
  booleanMeshWithAncestry,
  booleanOperandProblem,
  debugLiveHandleCount,
  sharedManifoldModule,
} = await import('../../mesh/manifoldOps')
const { recognizeMeshFeatures } = await import('../../mesh/recognition')
const { weldMesh } = await import('../../mesh/recognition/topology')
const {
  acquirePartMesh,
  computeParallel3dMoves,
  xyBoundsRing,
  DEFAULT_PARALLEL3D_PARAMS,
} = await import('../../cam3d/integration/parallel3dOperation')
const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
const { Cam3dClient } = await import('../../cam3d/worker/client')
const { makeTool } = await import('../post/helpers')
import type { MeshEditRecord } from '../../mesh/edit'
import type { MeshBuffers, Vec3 } from '../../mesh/types'
import type { WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { ToolpathMove } from '../../types'

// ---------------------------------------------------------------- fixtures

class Soup {
  private readonly coords: number[] = []
  tri(a: Vec3, b: Vec3, c: Vec3): void { this.coords.push(...a, ...b, ...c) }
  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }
  bytes(): ArrayBuffer { return exportBinaryStl(this.mesh()).bytes }
}

function ring(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), z] as Vec3
  })
}

function squareRing(cx: number, cy: number, s: number, z: number, n: number): Vec3[] {
  const per = n / 8
  return Array.from({ length: n }, (_, k) => {
    const segment = Math.floor(k / per)
    const f = (k % per) / per
    const xy: Array<[number, number]> = [
      [s, s * f], [s * (1 - f), s], [-s * f, s], [-s, s * (1 - f)],
      [-s, -s * f], [-s * (1 - f), -s], [s * f, -s], [s, -s * (1 - f)],
    ]
    return [cx + xy[segment][0], cy + xy[segment][1], z] as Vec3
  })
}

function annulus(soup: Soup, inner: Vec3[], outer: Vec3[], up: boolean): void {
  const n = inner.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) { soup.tri(inner[k], outer[k], outer[j]); soup.tri(inner[k], outer[j], inner[j]) }
    else { soup.tri(inner[k], outer[j], outer[k]); soup.tri(inner[k], inner[j], outer[j]) }
  }
}

function wall(soup: Soup, lower: Vec3[], upper: Vec3[], outward: boolean): void {
  const n = lower.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (outward) { soup.tri(lower[k], lower[j], upper[j]); soup.tri(lower[k], upper[j], upper[k]) }
    else { soup.tri(lower[k], upper[k], upper[j]); soup.tri(lower[k], upper[j], lower[j]) }
  }
}

const N = 64
const HALF = 20
const THICK = 10
const HOLE_R = 3

/** A 40 x 40 x 10 mm plate, centred on the origin, bottom at z = 0, with one
 *  6 mm through hole on its axis - the feature recognition must still read
 *  untouched after the box goes on and the cylinder comes out. */
function plateSoup(): Soup {
  const soup = new Soup()
  annulus(soup, ring(0, 0, HOLE_R, THICK, N), squareRing(0, 0, HALF, THICK, N), true)
  annulus(soup, ring(0, 0, HOLE_R, 0, N), squareRing(0, 0, HALF, 0, N), false)
  wall(soup, ring(0, 0, HOLE_R, 0, N), ring(0, 0, HOLE_R, THICK, N), false)
  wall(soup, squareRing(0, 0, HALF, 0, N), squareRing(0, 0, HALF, THICK, N), true)
  return soup
}

const plateBytes = (): ArrayBuffer => plateSoup().bytes()

/** The same plate with every facet wound backwards: closed, and inside-out. */
function insideOutPlateBytes(): ArrayBuffer {
  const mesh = plateSoup().mesh()
  const indices = new Uint32Array(mesh.indices.length)
  for (let t = 0; t < mesh.indices.length; t += 3) {
    indices[t] = mesh.indices[t]
    indices[t + 1] = mesh.indices[t + 2]
    indices[t + 2] = mesh.indices[t + 1]
  }
  return exportBinaryStl({ positions: mesh.positions, indices }).bytes
}

// The two edits the acceptance names: a 10 mm box sitting on the top face,
// and a 12 mm cylinder cut clean through the plate. Both well clear of the
// 6 mm hole and of each other.
const ADD_BOX = {
  operation: 'add', shape: 'box', center: [12, 12, THICK + 5], size: [10, 10, 10],
} as const
const CUT_CYLINDER = {
  operation: 'subtract', shape: 'cylinder', center: [-11, -11, THICK / 2],
  diameterMm: 12, lengthMm: THICK + 20, axisDirection: [0, 0, 1],
} as const

// ------------------------------------------------------------------ helpers

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}
const health = (mesh: MeshBuffers) => analyzeMesh(welded(mesh), { checkSelfIntersections: false })
const measures = (mesh: MeshBuffers) => measureMesh(welded(mesh))

/** Volume of a regular `n`-gon prism of circumradius `r` and height `h`. */
const prismVolume = (r: number, h: number, n: number): number =>
  (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * h

/** Mint one boolean-body record against `bytes` + `journal` as it stands. */
function mint(bytes: ArrayBuffer, journal: MeshEditRecord[], parameters: Record<string, unknown>, id?: string): MeshEditRecord {
  const resolved = resolveEditedStlMesh(bytes, journal)
  expect(resolved.stopped).toBeUndefined()
  expect(booleanBodyRefusal(resolved.mesh, parameters)).toBeNull()
  return createMeshEditRecord(resolved.mesh, {
    id,
    kind: BOOLEAN_BODY_KIND,
    facets: booleanBodySelection(resolved.mesh, parameters),
    parameters,
    sourceFacetIds: resolved.sourceFacetIds,
  })
}

beforeAll(async () => { await primeBoringKernel() }, 120_000)

// ------------------------------------------------------------------ tests

describe('WO-1910 acceptance 1: add a 10 mm box, then cut a 12 mm cylinder', () => {
  const bytes = plateBytes()
  let box: MeshEditRecord
  let cylinder: MeshEditRecord
  let source: MeshBuffers
  let boxed: MeshBuffers
  let cut: MeshBuffers

  beforeAll(() => {
    source = resolveEditedStlMesh(bytes, undefined).mesh
    box = mint(bytes, [], { ...ADD_BOX })
    boxed = resolveEditedStlMesh(bytes, [box]).mesh
    cylinder = mint(bytes, [box], { ...CUT_CYLINDER })
    cut = resolveEditedStlMesh(bytes, [box, cylinder]).mesh
  })

  it('the plate it starts from is closed, one shell, wound outward', () => {
    expect(health(source).watertight).toBe(true)
    expect(measures(source).componentCount).toBe(1)
    expect(measures(source).signedVolume).toBeGreaterThan(0)
  })

  for (const [step, pick] of [['after the box', () => boxed], ['after the cylinder', () => cut]] as const) {
    it(`${step}: closed, manifold, one shell, positively wound`, () => {
      const mesh = pick()
      const report = health(mesh)
      expect(report.watertight).toBe(true)
      expect(report.boundaryEdgeCount).toBe(0)
      expect(report.nonManifoldEdgeCount).toBe(0)
      expect(report.windingConflictEdgeCount).toBe(0)
      expect(report.degenerateTriangleCount).toBe(0)
      const m = measures(mesh)
      expect(m.componentCount).toBe(1)
      expect(m.signedVolume).toBeGreaterThan(0)
    })
  }

  it('the box adds exactly its own 1000 mm3 - it sits on the top face and overlaps nothing', () => {
    expect(measures(boxed).volume - measures(source).volume).toBeCloseTo(1000, 2)
  })

  it('the cylinder removes exactly the prism it is, through the plate thickness', () => {
    const removed = prismVolume(6, THICK, boreSegments(6))
    expect(measures(boxed).volume - measures(cut).volume).toBeCloseTo(removed, 2)
  })

  it('the part is 10 mm taller where the box went', () => {
    const top = (mesh: MeshBuffers) => {
      let z = -Infinity
      for (let v = 2; v < mesh.positions.length; v += 3) z = Math.max(z, mesh.positions[v])
      return z
    }
    expect(top(source)).toBeCloseTo(THICK, 5)
    expect(top(cut)).toBeCloseTo(THICK + 10, 5)
  })

  it('the panel line says what was done', () => {
    expect(describeMeshEdit(box)).toBe('Added a 10.00 x 10.00 x 10.00 mm box at 12.00, 12.00, 15.00')
    expect(describeMeshEdit(cylinder)).toBe('Cut a 12.00 mm cylinder, 30.00 mm long out at -11.00, -11.00, 5.00')
  })

  it('NEGATIVE CONTROL: the same box moved 1 mm into the plate adds 100 mm3 less', () => {
    // So the 1000 above is the box being measured, not a constant the
    // fixture happens to produce.
    const sunk = mint(bytes, [], { ...ADD_BOX, center: [12, 12, THICK + 4] })
    const volume = measures(resolveEditedStlMesh(bytes, [sunk]).mesh).volume
    expect(volume - measures(source).volume).toBeCloseTo(900, 2)
  })
})

describe('WO-1910 acceptance 2: every facet says where it came from', () => {
  const bytes = plateBytes()

  it('a source id or NO_SOURCE_FACET on every facet, and the two counts sum to the facet count', () => {
    const box = mint(bytes, [], { ...ADD_BOX })
    const cylinder = mint(bytes, [box], { ...CUT_CYLINDER })
    const sourceFacets = resolveEditedStlMesh(bytes, undefined).mesh.indices.length / 3
    for (const journal of [[box], [box, cylinder]]) {
      const resolved = resolveEditedStlMesh(bytes, journal)
      expect(resolved.sourceFacetIds.length).toBe(resolved.mesh.indices.length / 3)
      let descended = 0
      let added = 0
      resolved.sourceFacetIds.forEach((id) => {
        if (id === NO_SOURCE_FACET) { added++; return }
        expect(id).toBeLessThan(sourceFacets)
        descended++
      })
      expect(descended).toBeGreaterThan(0)
      expect(added).toBeGreaterThan(0)
      expect(descended + added).toBe(resolved.sourceFacetIds.length)
    }
  })

  it('the record selects the region it changes, not the whole part', () => {
    const resolved = resolveEditedStlMesh(bytes, undefined)
    const selection = booleanBodySelection(resolved.mesh, { ...ADD_BOX })
    expect(selection.length).toBeGreaterThan(0)
    expect(selection.length).toBeLessThan(resolved.mesh.indices.length / 3)
  })

  it('replay is deterministic: the same journal twice is the same bytes', () => {
    const box = mint(bytes, [], { ...ADD_BOX })
    const cylinder = mint(bytes, [box], { ...CUT_CYLINDER })
    const first = exportBinaryStl(resolveEditedStlMesh(bytes, [box, cylinder]).mesh).bytes
    const second = exportBinaryStl(resolveEditedStlMesh(bytes, [box, cylinder]).mesh).bytes
    expect(new Uint8Array(first)).toEqual(new Uint8Array(second))
  })
})

// --- the store: add, undo in one step, save, reload --------------------------

const GEO_ID = 'g-stl-1910'
const SETUP_ID = 'setup-1910'

function stlRow(): ImportedGeometry {
  return {
    id: GEO_ID, name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -HALF, y: -HALF, z: 0 }, max: { x: HALF, y: HALF, z: THICK },
      size: { x: 2 * HALF, y: 2 * HALF, z: THICK }, center: { x: 0, y: 0, z: THICK / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as ImportedGeometry
}

function project(geometry: ImportedGeometry[]): Project {
  return {
    id: 'p-1910', name: 'Boolean body', version: '1.0.0',
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry,
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations: [], stock: null, notes: '',
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

/** What the panel does: resolve, select, ask for a refusal, then record. */
async function addThroughStore(parameters: Record<string, unknown>): Promise<MeshEditRecord> {
  const resolved = resolveEditedStlMesh(stlBytesById.get(GEO_ID)!, row().meshEdits)
  expect(booleanBodyRefusal(resolved.mesh, parameters)).toBeNull()
  return useCamStore.getState().addMeshEdit(GEO_ID, {
    kind: BOOLEAN_BODY_KIND, facets: booleanBodySelection(resolved.mesh, parameters), parameters,
  })
}

let savedBlobs: Blob[] = []

describe('WO-1910 acceptance 2: the edit saves, reloads and undoes in one step', () => {
  beforeEach(() => {
    stlBytesById.clear()
    stlBytesById.set(GEO_ID, plateBytes())
    savedBlobs = []
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:wo1910' },
      revokeObjectURL: () => {},
    })
    vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
    useCamStore.setState({ project: project([stlRow()]) })
  })

  it('each edit is ONE undo step, and redo brings it back', async () => {
    await addThroughStore({ ...ADD_BOX })
    await addThroughStore({ ...CUT_CYLINDER })
    expect(row().meshEdits!.map((e) => e.kind)).toEqual([BOOLEAN_BODY_KIND, BOOLEAN_BODY_KIND])

    useCamStore.getState().undo()
    expect(row().meshEdits!.map((e) => e.parameters.shape)).toEqual(['box'])
    useCamStore.getState().undo()
    expect(row().meshEdits ?? []).toHaveLength(0)
    useCamStore.getState().redo()
    expect(row().meshEdits!.map((e) => e.parameters.shape)).toEqual(['box'])
  })

  it('the row size follows the edit (WO-1895): 10 mm taller with the box on', async () => {
    await addThroughStore({ ...ADD_BOX })
    expect(row().boundingBox.size.z).toBeCloseTo(THICK + 10, 4)
  })

  it('saves, reloads, and replays to the same part', async () => {
    await addThroughStore({ ...ADD_BOX })
    await addThroughStore({ ...CUT_CYLINDER })
    const journal = row().meshEdits!
    const before = exportBinaryStl(resolveEditedStlMesh(stlBytesById.get(GEO_ID)!, journal).mesh).bytes

    await useCamStore.getState().saveProjectToFile()
    expect(savedBlobs).toHaveLength(1)
    const fileText = await savedBlobs[0].text()
    stlBytesById.clear()
    useCamStore.setState({ project: project([]) })
    await useCamStore.getState().loadProjectFromFile(fileText)

    const reloaded = row().meshEdits!
    expect(reloaded).toEqual(journal)
    const resolved = resolveEditedStlMesh(stlBytesById.get(GEO_ID)!, reloaded)
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(2)
    expect(new Uint8Array(exportBinaryStl(resolved.mesh).bytes)).toEqual(new Uint8Array(before))
  })
})

describe('WO-1910 acceptance 3: recognition and CAM follow the new shape', () => {
  const bytes = plateBytes()
  let journal: MeshEditRecord[]

  beforeAll(() => {
    const box = mint(bytes, [], { ...ADD_BOX })
    journal = [box, mint(bytes, [box], { ...CUT_CYLINDER })]
  })

  it('the untouched 6 mm hole reads back with identical source facet ids', () => {
    const before = resolveEditedStlMesh(bytes, undefined)
    const after = resolveEditedStlMesh(bytes, journal)
    const was = recognizeMeshFeatures(before.mesh, before.sourceFacetIds).features
    const now = recognizeMeshFeatures(after.mesh, after.sourceFacetIds).features
    expect(was.map((f) => f.kind)).toEqual(['through-hole'])
    const original = was[0]
    const kept = now.find((f) => Math.abs(f.diameterMm - 2 * HOLE_R) < 0.01)
    expect(kept, `found ${now.map((f) => `${f.kind} ${f.diameterMm.toFixed(3)}`).join(', ')}`).toBeDefined()
    expect(kept!.kind).toBe('through-hole')
    expect(kept!.sourceFacetIds).toEqual(original.sourceFacetIds)
    expect(kept!.depthMm).toBeCloseTo(original.depthMm, 6)
    expect(kept!.axis.origin[0]).toBeCloseTo(original.axis.origin[0], 6)
    expect(kept!.axis.origin[1]).toBeCloseTo(original.axis.origin[1], 6)
  })

  function makeClient() {
    const kernel = new BvhKernel()
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
      terminate(): void { /* in-process channel */ },
    }
    const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
      fakeWorker.onmessage?.({ data: msg } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker)
  }

  async function movesOver(edits: MeshEditRecord[]): Promise<ToolpathMove[]> {
    const partMesh = await acquirePartMesh({ format: 'stl', bytes, meshEdits: edits }, 0.05)
    const top = partMesh.bounds.max[2]
    const result = await computeParallel3dMoves({
      partMesh,
      tool: makeTool({ id: 't-ball2', name: 'Ball d2', type: 'ball_end_mill', diameter: 2, toolNumber: 1 }),
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 1, angleDeg: 0, tolerance: 0.05 },
      resolvedHeights: {
        clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2,
        topZ: top, bottomZ: partMesh.bounds.min[2], stockTopZ: top,
      },
      // the box's own patch and a margin, so this stays a seconds-long fixture
      boundary: [xyBoundsRing({ minX: 4, minY: 4, maxX: 19, maxY: 19 })],
      boundaryKind: 'selection',
      client: makeClient(),
    })
    return result.moves
  }

  it('acquirePartMesh hands CAM the edited part: 10 mm taller', async () => {
    const plain = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [] }, 0.05)
    const edited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: journal }, 0.05)
    expect(plain.bounds.max[2]).toBeCloseTo(THICK, 4)
    expect(edited.bounds.max[2]).toBeCloseTo(THICK + 10, 4)
  })

  it('Parallel 3D rides over the added box: the tool is driven up to its top', async () => {
    // a ball tool's tip sits ON the surface it follows, so over the box it
    // reaches the box top, and without the box it never leaves the plate top.
    const heightOver = (moves: ToolpathMove[]) => Math.max(
      ...moves.filter((m) => m.x > 8 && m.x < 16 && m.y > 8 && m.y < 16).map((m) => m.z),
    )
    const lowPlain = (moves: ToolpathMove[]) => Math.min(...moves.map((m) => m.z))
    const plain = await movesOver([])
    const edited = await movesOver(journal)
    expect(lowPlain(plain)).toBeCloseTo(THICK, 1)
    expect(heightOver(edited)).toBeCloseTo(THICK + 10, 1)
  }, 180_000)
})

describe('WO-1910 acceptance 4: an inside-out operand is refused by name, a disjoint one is not', () => {
  const bytes = plateBytes()
  const plate = resolveEditedStlMesh(bytes, undefined).mesh

  /** The 10 mm box with every facet wound backwards. */
  function insideOutBox(): MeshBuffers {
    const box = booleanBodyOperand(booleanBodyOperation.validate({ ...ADD_BOX }))
    const indices = new Uint32Array(box.indices.length)
    for (let t = 0; t < box.indices.length; t += 3) {
      indices[t] = box.indices[t]
      indices[t + 1] = box.indices[t + 2]
      indices[t + 2] = box.indices[t + 1]
    }
    return { positions: box.positions, indices }
  }

  it('the kernel refuses an inside-out operand, naming it, before it runs anything', () => {
    const module = sharedManifoldModule()!
    expect(booleanOperandProblem(insideOutBox(), 'the box')).toMatch(/the box is inside-out/)
    expect(() => booleanMeshWithAncestry(module, plate, insideOutBox(), {
      operation: 'union', rightName: 'the box',
    })).toThrow(/The boolean was not run: the box is inside-out/)
    // and the refusal left no wasm handle behind (MSH-2-R1.1)
    expect(debugLiveHandleCount()).toBe(0)
  })

  it('NEGATIVE CONTROL: the unchecked kernel takes the same inside-out box and answers wrong', () => {
    // This is the silent wrong answer the check exists for: the plain boolean
    // has no operand check, and "adding" the inside-out box does NOT add the
    // 1000 mm3 the right-way-round box adds.
    const module = sharedManifoldModule()!
    const was = measures(plate).volume
    const right = booleanMesh(module, plate, booleanBodyOperand(booleanBodyOperation.validate({ ...ADD_BOX })), { operation: 'union' })
    expect(right.measures.volume - was).toBeCloseTo(1000, 2)
    let wrongVolume: number | null = null
    try {
      wrongVolume = booleanMesh(module, plate, insideOutBox(), { operation: 'union' }).measures.volume
    } catch {
      wrongVolume = null // refused outright by the kernel is also "not the answer"
    }
    if (wrongVolume !== null) expect(Math.abs(wrongVolume - was - 1000)).toBeGreaterThan(1)
  })

  it('an inside-out PART is refused by name before anything is recorded', () => {
    const inverted = resolveEditedStlMesh(insideOutPlateBytes(), undefined).mesh
    expect(booleanBodyRefusal(inverted, { ...ADD_BOX })).toMatch(/the part is inside-out/)
  })

  it('flat and not-a-number operands are named too', () => {
    const flat: MeshBuffers = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 1]),
    }
    expect(booleanOperandProblem(flat, 'the box')).toMatch(/flat/)
    const nan = booleanBodyOperand(booleanBodyOperation.validate({ ...ADD_BOX }))
    nan.positions[4] = Number.NaN
    expect(booleanOperandProblem(nan, 'the box')).toMatch(/not a number/)
    expect(booleanOperandProblem(plate, 'the part')).toBeNull()
  })

  it('a disjoint operand is not refused for being disjoint: a far-away cut goes through and changes nothing', () => {
    const far = { ...CUT_CYLINDER, center: [200, 200, 5] }
    expect(booleanOperandProblem(booleanBodyOperand(booleanBodyOperation.validate(far)), 'the cylinder')).toBeNull()
    expect(booleanBodyRefusal(plate, far)).toBeNull()
    const record = mint(bytes, [], far)
    expect(record.facets).toHaveLength(1) // the one facet nearest the shape
    const after = resolveEditedStlMesh(bytes, [record]).mesh
    expect(measures(after).volume).toBeCloseTo(measures(plate).volume, 3)
  })

  it('what IS refused is a multi-shell RESULT: a far-away box would make two solids', () => {
    const far = { ...ADD_BOX, center: [200, 200, 5] }
    expect(booleanOperandProblem(booleanBodyOperand(booleanBodyOperation.validate(far)), 'the box')).toBeNull()
    expect(booleanBodyRefusal(plate, far)).toMatch(/does not touch the part, so adding it would make 2 separate solids/)
  })

  it('and a cut that splits the part in two, or leaves nothing, is refused by name', () => {
    const slab = {
      operation: 'subtract', shape: 'box', center: [0, 0, THICK / 2], size: [2, 100, 100],
    }
    expect(booleanBodyRefusal(plate, slab)).toMatch(/split the part into 2 separate pieces/)
    const everything = { ...slab, size: [100, 100, 100] }
    expect(booleanBodyRefusal(plate, everything)).toMatch(/would leave nothing of the part/)
  })

  it('parameters that are not a shape are refused before they are recorded', () => {
    expect(() => booleanBodyOperation.validate({ ...ADD_BOX, size: [10, 0, 10] })).toThrow(/not a measurement/)
    expect(() => booleanBodyOperation.validate({ ...ADD_BOX, operation: 'xor' })).toThrow(/neither/)
    expect(() => booleanBodyOperation.validate({ ...CUT_CYLINDER, axisDirection: [0, 0, 0] })).toThrow(/no axis direction/)
    expect(() => createMeshEditRecord(plate, {
      kind: BOOLEAN_BODY_KIND, facets: [0], parameters: { ...ADD_BOX, shape: 'sphere' },
    })).toThrow(/box or a cylinder/)
  })
})
