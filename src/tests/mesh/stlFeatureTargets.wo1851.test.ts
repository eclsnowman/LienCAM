// @vitest-environment jsdom
//
// WO-1851: a hole found in an STL can be drilled.
//
// Rule 6: every claim here goes through the application's own path - the
// store's `loadMeshFeatureTargets` and `loadMeshEdgeChains` actions, the shared
// `geometryForOperation` source boundary every operation picker resolves
// through, and the real `computeOperationToolpath` with the production
// toolpath worker running in this thread. Nothing hand-builds a payload and
// hands it to a builder.
//
// The plate fixtures below are WO-1846's own builders, copied verbatim from
// `meshFeatureRecognition.wo1846.test.ts` (which does not export them, and
// which is not this order's to edit). Copied rather than re-invented on the
// architect's instruction, so the diameters and depths asserted here are
// literally WO-1846's proven numbers.
//
// The one thing added to them: `offsetStl`, which re-exports a fixture's own
// bytes translated away from the origin. That is what a real slicer file looks
// like - the part is wherever CAD left it - and it is what makes the recentring
// this order is really about have a non-zero value to get wrong. The
// acceptance plate as WO-1846 writes it happens to sit with its XY centre on
// the origin and its bottom on Z 0, so a target reported in the file's frame
// and one reported in the mesh's local frame would be indistinguishable.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type {
  HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock, Project, Setup, Tool,
} from '../../types'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

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

// jsdom's localStorage is unusable under vitest's launch flags and the store
// persists on every set(). Same in-memory shim the other store tests install,
// and it has to exist before the store module is imported.
const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } as Storage,
})

// The PRODUCTION toolpath worker, run in this thread: its module assigns
// self.onmessage and answers through self.postMessage, so the store's real
// dispatch is exercised end to end.
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = (data) => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}
vi.stubGlobal('Worker', InProcessToolpathWorker)

const { useCamStore, geometryForOperation } = await import('../../store')
const { buildDrillBoreSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { legacyHeightIntentForOperation } = await import('../../lib/cam/heightIntent')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')
const { meshFeatureTargets, meshRecenterShift } = await import('../../mesh/recognition/toolpathTargets')

// ---------------------------------------------- WO-1846's fixtures, verbatim

/** A triangle soup being built up, in the unwelded form an STL writer wants. */
class Soup {
  private readonly coords: number[] = []

  tri(a: Vec3, b: Vec3, c: Vec3): void {
    this.coords.push(...a, ...b, ...c)
  }

  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }

  bytes(): ArrayBuffer {
    return exportBinaryStl(this.mesh()).bytes
  }
}

/** `n` points evenly round a circle, counter-clockwise seen from +Z. */
function ring(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), z] as Vec3
  })
}

/** `n` points round the square of half-size `s`, at exactly representable
 *  offsets (neighbouring cells share these vertices and a weld is by exact
 *  coordinate). */
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
    if (up) {
      soup.tri(inner[k], outer[k], outer[j])
      soup.tri(inner[k], outer[j], inner[j])
    } else {
      soup.tri(inner[k], outer[j], outer[k])
      soup.tri(inner[k], inner[j], outer[j])
    }
  }
}

function wall(soup: Soup, lower: Vec3[], upper: Vec3[], outward: boolean): void {
  const n = lower.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (outward) {
      soup.tri(lower[k], lower[j], upper[j])
      soup.tri(lower[k], upper[j], upper[k])
    } else {
      soup.tri(lower[k], upper[k], upper[j])
      soup.tri(lower[k], upper[j], lower[j])
    }
  }
}

function disk(soup: Soup, loop: Vec3[], centre: Vec3, up: boolean): void {
  const n = loop.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) soup.tri(centre, loop[k], loop[j])
    else soup.tri(centre, loop[j], loop[k])
  }
}

const N = 64
const HALF = 20
const THICK = 12
const CELLS: Array<[number, number]> = [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]

/**
 * WO-1846's acceptance plate: 80 x 80 x 12 mm, four cells, one feature each.
 *   cell 0  a 6 mm through hole
 *   cell 1  a 10/6 mm counterbore, 4 mm deep
 *   cell 2  a 6 mm hole with a 90-degree countersink 3 mm deep
 *   cell 3  a 12 mm boss, 5 mm tall
 */
function acceptancePlate(segments = N): ArrayBuffer {
  const soup = new Soup()
  const topRingRadius = [3, 5, 6, 6]
  for (let cell = 0; cell < 4; cell++) {
    const [cx, cy] = CELLS[cell]
    const outerTop = squareRing(cx, cy, HALF, THICK, segments)
    const outerBottom = squareRing(cx, cy, HALF, 0, segments)
    annulus(soup, ring(cx, cy, topRingRadius[cell], THICK, segments), outerTop, true)
    if (cell === 3) disk(soup, outerBottom, [cx, cy, 0], false)
    else annulus(soup, ring(cx, cy, 3, 0, segments), outerBottom, false)

    if (cell === 0) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, THICK, segments), false)
    } else if (cell === 1) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 8, segments), false)
      annulus(soup, ring(cx, cy, 3, 8, segments), ring(cx, cy, 5, 8, segments), true)
      wall(soup, ring(cx, cy, 5, 8, segments), ring(cx, cy, 5, THICK, segments), false)
    } else if (cell === 2) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 9, segments), false)
      wall(soup, ring(cx, cy, 3, 9, segments), ring(cx, cy, 6, THICK, segments), false)
    } else {
      wall(soup, ring(cx, cy, 6, THICK, segments), ring(cx, cy, 6, THICK + 5, segments), true)
      disk(soup, ring(cx, cy, 6, THICK + 5, segments), [cx, cy, THICK + 5], true)
    }
  }
  const outline = squareRing(0, 0, 2 * HALF, 0, segments * 2)
  const outlineTop = squareRing(0, 0, 2 * HALF, THICK, segments * 2)
  wall(soup, outline, outlineTop, true)
  return soup.bytes()
}

/** WO-1846's blind-hole plate: one hole 8 mm across, 6 mm deep, flat bottom. */
function blindHolePlate(): ArrayBuffer {
  const soup = new Soup()
  const outerTop = squareRing(0, 0, HALF, THICK, N)
  const outerBottom = squareRing(0, 0, HALF, 0, N)
  annulus(soup, ring(0, 0, 4, THICK, N), outerTop, true)
  disk(soup, outerBottom, [0, 0, 0], false)
  wall(soup, ring(0, 0, 4, 6, N), ring(0, 0, 4, THICK, N), false)
  disk(soup, ring(0, 0, 4, 6, N), [0, 0, 6], true)
  wall(soup, outerBottom, outerTop, true)
  return soup.bytes()
}

// ------------------------------------------------- the file frame vs the mesh

/** The same part, written where CAD left it. Re-exports a fixture's own bytes
 *  translated by `by`, so the recentring the viewport applies on import is a
 *  real, non-zero shift instead of a no-op. */
function offsetStl(bytes: ArrayBuffer, by: Vec3): ArrayBuffer {
  const mesh = importStl(bytes).mesh
  const positions = Float32Array.from(mesh.positions)
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    positions[offset] += by[0]
    positions[offset + 1] += by[1]
    positions[offset + 2] += by[2]
  }
  return exportBinaryStl({ positions, indices: mesh.indices }).bytes
}

/** Where CAD left this part. Nothing about it is special except that no
 *  component is zero and none is a round multiple of the other numbers here. */
const FILE_ORIGIN: Vec3 = [137.5, -62.25, 9.75]

// ------------------------------------------------------------ store fixtures

const SETUP_ID = 'setup-1851'
const TOOL_ID = 'tool-1851-drill'
const PLATE_ID = 'geo-1851-plate'
const BLIND_ID = 'geo-1851-blind'

const drillTool: Tool = {
  id: TOOL_ID, name: '5 mm drill', type: 'drill',
  diameter: 5, fluteLength: 40, shankDiameter: 5, overallLength: 80,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 2 } },
} as unknown as Tool

const STOCK_ID = 'stock-1851'

/** One explicit stock both plates sit in. A cut cannot be resolved without a
 *  stock coordinate frame (ADR-0003), so the fixture gives it one. */
const stock = {
  id: STOCK_ID, name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: -45, y: -45, z: 0 }, max: { x: 45, y: 45, z: 20 },
    size: { x: 90, y: 90, z: 20 }, center: { x: 0, y: 0, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as unknown as PhysicalStock

function stlRow(id: string, name: string, size: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl', loaded: true,
    stockId: STOCK_ID, assignedStockId: STOCK_ID,
    boundingBox: {
      min: { x: -size[0] / 2, y: -size[1] / 2, z: 0 },
      max: { x: size[0] / 2, y: size[1] / 2, z: size[2] },
      size: { x: size[0], y: size[1], z: size[2] },
      center: { x: 0, y: 0, z: size[2] / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  } as unknown as ImportedGeometry
}

const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 15, feedHeight: 14,
  topHeight: 12, topHeightMode: 'absolute',
  bottomHeight: 0, bottomHeightMode: 'absolute',
} as unknown as HeightParams

const passes: PassParams = {
  stepdown: 6, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0,
} as unknown as PassParams

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
} as unknown as LinkingParams

/**
 * A drill operation set up the way the dialog sets one up from a picked hole:
 * the material start is the hole's own top and the machining end is its own
 * measured floor, carried by the SAME Smart Height V2 envelope a solid's
 * detected hole would fill in (a `smart_v2` envelope is the only runtime
 * height authority there is - compute refuses an operation without one).
 */
function drillOp(
  id: string, geometryId: string, loopIds: string[], topZ: number, bottomZ: number,
): Operation {
  const params = {
    geometryId, loopIds,
    cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0,
    retractMode: 'clearance', sortStrategy: 'none',
  }
  const opHeights = { ...heights, topHeight: topZ, bottomHeight: bottomZ }
  return {
    id, name: 'Drill', type: 'drill', enabled: true, status: 'idle',
    toolId: TOOL_ID, geometrySelections: loopIds,
    heights: opHeights, passes, linking, params,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreSmartHeightIntent({
        operationType: 'drill', setupId: SETUP_ID,
        safetyIntent: legacyHeightIntentForOperation({ type: 'drill', heights: opHeights, params }),
        mode: 'explicit_depth', geometryIds: [geometryId],
        explicitStartWcsMm: topZ, explicitEndWcsMm: bottomZ,
      }),
    },
  } as unknown as Operation
}

function project(geometry: ImportedGeometry[], operations: Operation[]): Project {
  return {
    id: 'p-1851', name: 'STL feature targets', version: '1.0.0',
    createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 200 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [drillTool], geometry, stocks: [stock],
    setups: [{
      id: SETUP_ID, name: 'Setup 1', operations, stock: null, notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
    } as unknown as Setup],
    activeSetupId: SETUP_ID, activeOperationId: null,
    sceneStock: {
      mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 0,
      fixedWidth: 200, fixedHeight: 200, fixedDepth: 20, fixedStocks: [],
    },
    notes: '',
  } as unknown as Project
}

function row(id: string): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === id)
  if (!found) throw new Error(`fixture row "${id}" vanished`)
  return found
}

beforeEach(() => {
  stlBytesById.clear()
  stlBytesById.set(PLATE_ID, offsetStl(acceptancePlate(), FILE_ORIGIN))
  stlBytesById.set(BLIND_ID, offsetStl(blindHolePlate(), FILE_ORIGIN))
  useCamStore.setState({
    // The tool library is store state, not project state - compute resolves
    // op.toolId against it.
    toolLibrary: [drillTool],
    project: project(
      [stlRow(PLATE_ID, 'Plate', [80, 80, 17]), stlRow(BLIND_ID, 'Blind', [40, 40, 12])],
      [],
    ),
  })
})

// ---------------------------------------------------------------------------

describe('WO-1851: the store offers an STL\'s recognised holes as drill targets', () => {
  it('lists the through hole, the counterbore and the countersink with measured size and depth', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const byKind = new Map(targets.holes.map((hole) => [hole.kind, hole]))

    expect([...byKind.keys()].sort()).toEqual(['counterbore', 'countersink', 'through-hole'])

    // WO-1846's own numbers: 6 mm bore, 12 mm of plate, in the cell at (-20, -20)
    // of the RECENTRED frame (the file has it at (117.5, -82.25)).
    const through = byKind.get('through-hole')!
    expect(through.diameterMm).toBeCloseTo(6, 1)
    expect(through.center[0]).toBeCloseTo(-HALF, 6)
    expect(through.center[1]).toBeCloseTo(-HALF, 6)
    expect(through.topZ).toBeCloseTo(THICK, 6)
    expect(through.bottomZ).toBeCloseTo(0, 6)
    expect(through.depthMm).toBeCloseTo(THICK, 6)
    expect(through.through).toBe(true)

    // The counterbore's drillable size is its SMALLEST bore, as WO-1846 reports it.
    const counterbore = byKind.get('counterbore')!
    expect(counterbore.diameterMm).toBeCloseTo(6, 1)
    expect(counterbore.center[0]).toBeCloseTo(HALF, 6)
    expect(counterbore.center[1]).toBeCloseTo(-HALF, 6)
    expect(counterbore.depthMm).toBeCloseTo(THICK, 6)
    expect(counterbore.through).toBe(false)
  })

  it('lists the blind hole with the floor that was measured, not one that was typed', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(BLIND_ID)
    expect(targets.holes.map((hole) => hole.kind)).toEqual(['blind-hole'])
    const blind = targets.holes[0]
    expect(blind.diameterMm).toBeCloseTo(8, 1)
    expect(blind.center[0]).toBeCloseTo(0, 6)
    expect(blind.center[1]).toBeCloseTo(0, 6)
    expect(blind.topZ).toBeCloseTo(THICK, 6)
    expect(blind.bottomZ).toBeCloseTo(6, 6)
    expect(blind.depthMm).toBeCloseTo(6, 6)
    expect(blind.through).toBe(false)
  })

  it('does not offer the boss - a thing that stands proud of the face is not a hole', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    expect(targets.holes.some((hole) => hole.kind === 'boss')).toBe(false)
    expect(targets.pockets.some((pocket) => pocket.featureId.startsWith('boss'))).toBe(false)
    expect(targets.refusals).toEqual([])
  })

  it('offers a proved flat floor to a pocket: the blind-hole bottom and the counterbore shoulder', async () => {
    const blind = await useCamStore.getState().loadMeshFeatureTargets(BLIND_ID)
    expect(blind.pockets).toHaveLength(1)
    expect(blind.pockets[0].floorZ).toBeCloseTo(6, 6)
    expect(blind.pockets[0].diameterMm).toBeCloseTo(8, 1)

    // The counterbore's floor is the shoulder at Z 8, inside the 10 mm bore.
    const plate = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    expect(plate.pockets).toHaveLength(1)
    expect(plate.pockets[0].floorZ).toBeCloseTo(8, 6)
    expect(plate.pockets[0].topZ).toBeCloseTo(THICK, 6)
    expect(plate.pockets[0].diameterMm).toBeCloseTo(10, 1)
  })
})

describe('WO-1851: the targets land on the geometry row the way a solid\'s holes do', () => {
  it('lands one circle per hole on a derived layer carrying the hole facts', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const geometry = row(PLATE_ID)
    const layer = (geometry.layers2d ?? []).find((l) => l.name.startsWith('STL holes'))
    expect(layer).toBeDefined()
    expect(layer!.derived).toBe(true)
    expect(layer!.frame).toBe('geometry_local')
    expect(layer!.holes).toHaveLength(targets.holes.length)

    const loops = (geometry.loops ?? []).filter((loop) => loop.layerId === layer!.id)
    expect(loops).toHaveLength(targets.holes.length)
    for (const hole of layer!.holes ?? []) {
      const loop = loops.find((l) => l.id === hole.loopId)
      expect(loop, `hole at ${hole.center} has no loop`).toBeDefined()
      expect(loop!.closed).toBe(true)
      // The circle really is round the hole, at the hole's size.
      const radii = loop!.points.map((p) => Math.hypot(p.x - hole.center[0], p.y - hole.center[1]))
      expect(Math.min(...radii)).toBeCloseTo(hole.diameter / 2, 6)
      expect(Math.max(...radii)).toBeCloseTo(hole.diameter / 2, 6)
    }
  })

  it('is idempotent: asking twice does not renumber anything already picked', async () => {
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const first = (row(PLATE_ID).loops ?? []).map((loop) => loop.id)
    const version = row(PLATE_ID).loopsVersion
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    expect((row(PLATE_ID).loops ?? []).map((loop) => loop.id)).toEqual(first)
    expect(row(PLATE_ID).loopsVersion).toBe(version)
  })

  it('Detect holes answers for an STL instead of refusing it', async () => {
    // The button an operator already has for a solid. Before this order it
    // could only refuse a mesh - there is no B-rep shape to detect holes in.
    await useCamStore.getState().deriveBrepLayer(PLATE_ID, 'holes')
    const layer = (row(PLATE_ID).layers2d ?? []).find((l) => l.name.startsWith('STL holes'))
    expect(layer).toBeDefined()
    expect(layer!.holes?.length).toBeGreaterThan(0)
    // The dialog reads the deepest detected bottom off exactly this table.
    expect(Math.min(...(layer!.holes ?? []).map((hole) => hole.bottomZ))).toBeCloseTo(0, 6)
  })

  it('says so by name when the part is not an STL or its bytes are gone', async () => {
    stlBytesById.delete(PLATE_ID)
    await expect(useCamStore.getState().loadMeshFeatureTargets(PLATE_ID))
      .rejects.toThrow(/cached mesh data is missing. Re-import the STL/)
    await expect(useCamStore.getState().loadMeshFeatureTargets('no-such-geometry'))
      .rejects.toThrow(/no longer exists/)
  })
})

describe('WO-1851: the edge chains an operator already picked are untouched', () => {
  it('produces the same chain list before and after the features are derived', async () => {
    const before = await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    const beforeList = before.map((loop) => ({
      id: loop.id, name: loop.name, closed: loop.closed, type: loop.type,
      points: loop.points.length, area: loop.area,
    }))
    expect(beforeList.length).toBeGreaterThan(0)

    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)

    const after = await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    expect(after.map((loop) => ({
      id: loop.id, name: loop.name, closed: loop.closed, type: loop.type,
      points: loop.points.length, area: loop.area,
    }))).toEqual(beforeList)
    // And the chain loops themselves are still on the row, point for point.
    const chainLayerIds = new Set((row(PLATE_ID).layers2d ?? [])
      .filter((layer) => layer.name === 'STL edge chains').map((layer) => layer.id))
    const landed = (row(PLATE_ID).loops ?? []).filter((loop) => chainLayerIds.has(loop.layerId))
    expect(landed.map((loop) => loop.id)).toEqual(before.map((loop) => loop.id))
    expect(landed.map((loop) => loop.points)).toEqual(before.map((loop) => loop.points))
  })

  it('reports a hole centre in the SAME frame the chains are drawn in', async () => {
    const chains = await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const through = targets.holes.find((hole) => hole.kind === 'through-hole')!

    // The chain round the top rim of the through hole: the closed chain whose
    // own centre is nearest the reported hole centre. If the two frames
    // disagreed, the nearest chain would be a whole cell away.
    const centres = chains.filter((chain) => chain.closed).map((chain) => ({
      id: chain.id,
      x: chain.points.reduce((sum, p) => sum + p.x, 0) / chain.points.length,
      y: chain.points.reduce((sum, p) => sum + p.y, 0) / chain.points.length,
    }))
    const nearest = centres.reduce((best, c) => (
      Math.hypot(c.x - through.center[0], c.y - through.center[1])
        < Math.hypot(best.x - through.center[0], best.y - through.center[1]) ? c : best
    ))
    expect(nearest.x).toBeCloseTo(through.center[0], 3)
    expect(nearest.y).toBeCloseTo(through.center[1], 3)
  })
})

describe('WO-1851: which operation families see the targets', () => {
  it('gives a drill and a bore the hole circles, and nobody else', async () => {
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    const geometry = row(PLATE_ID)

    const holeLoopIds = (loops: ImportedGeometry['loops']) =>
      (loops ?? []).filter((loop) => loop.id.startsWith('mfh:')).map((loop) => loop.id)

    expect(holeLoopIds(geometryForOperation(geometry, 'drill').loops).length).toBeGreaterThan(0)
    expect(holeLoopIds(geometryForOperation(geometry, 'bore').loops).length).toBeGreaterThan(0)
    for (const opType of ['contour_2d', 'pocket_2d', 'engrave', 'face'] as const) {
      expect(holeLoopIds(geometryForOperation(geometry, opType).loops)).toEqual([])
    }
    // Raw geometry (no operation filter) still shows everything.
    expect(holeLoopIds(geometryForOperation(geometry, undefined).loops).length).toBeGreaterThan(0)
  })

  it('leaves the edge-chain admission rule exactly as it was', async () => {
    await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const geometry = row(PLATE_ID)
    const chains = (loops: ImportedGeometry['loops']) =>
      (loops ?? []).filter((loop) => loop.id.startsWith('mec:'))

    const all = chains(geometry.loops)
    expect(chains(geometryForOperation(geometry, 'contour_2d').loops)).toEqual(all)
    expect(chains(geometryForOperation(geometry, 'pocket_2d').loops))
      .toEqual(all.filter((loop) => loop.closed))
    expect(chains(geometryForOperation(geometry, 'drill').loops)).toEqual([])
    expect(chains(geometryForOperation(geometry, 'engrave').loops)).toEqual([])
  })

  it('does NOT offer a mixed hole-plus-chain selection to a drill, and that is deliberate', async () => {
    await useCamStore.getState().loadMeshEdgeChains(PLATE_ID)
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const forDrill = geometryForOperation(row(PLATE_ID), 'drill')
    // Every loop a drill can see is a recognised hole. An STL edge chain is a
    // rim, not a bore: it has no proved floor, so drilling to its "depth" would
    // be a typed number wearing a measured number's clothes. The chain
    // admission rule that says so is WO-258's and is unchanged here.
    expect((forDrill.loops ?? []).length).toBeGreaterThan(0)
    expect((forDrill.loops ?? []).every((loop) => loop.id.startsWith('mfh:'))).toBe(true)
  })
})

describe('WO-1851: a drill computed through the production path lands in the hole', () => {
  /** The first plunge of the computed toolpath: the move that actually enters
   *  the material, read off the operation the store wrote. */
  async function firstPlunge(
    opId: string, geometryId: string, loopIds: string[], top: number, bottom: number,
  ) {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.map((setup) => setup.id === SETUP_ID
          ? { ...setup, operations: [drillOp(opId, geometryId, loopIds, top, bottom)] }
          : setup),
      },
    }))
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId)
    const computed = useCamStore.getState().project.setups[0].operations[0]
    if (computed.status === 'error') throw new Error(`compute failed: ${computed.errorMessage}`)
    const moves = computed.toolpathMoves ?? []
    const plunge = moves.find((move) => move.type === 'feed' && move.role === 'plunge')
    if (!plunge) throw new Error(`no plunge move in ${moves.length} moves`)
    return plunge
  }

  it('drills the through hole at its measured centre, to its measured depth', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    const layer = (row(PLATE_ID).layers2d ?? []).find((l) => l.name.startsWith('STL holes'))!
    const through = targets.holes.find((hole) => hole.kind === 'through-hole')!
    const holeFeature = (layer.holes ?? []).find((h) => Math.abs(h.diameter - through.diameterMm) < 1e-9
      && Math.abs(h.center[0] - through.center[0]) < 1e-9)!

    // The operation is filled in from the FEATURE: the bottom of cut is the
    // floor that was measured, not a number the operator typed.
    const plunge = await firstPlunge(
      'op-through', PLATE_ID, [holeFeature.loopId!], holeFeature.topZ, holeFeature.bottomZ,
    )
    expect(plunge.x).toBeCloseTo(-HALF, 4)
    expect(plunge.y).toBeCloseTo(-HALF, 4)
    expect(plunge.z).toBeCloseTo(0, 4)
    expect(holeFeature.bottomZ).toBeCloseTo(0, 6)
    expect(holeFeature.topZ - holeFeature.bottomZ).toBeCloseTo(THICK, 6)
  })

  it('drills the blind hole to the floor that was measured, not through the part', async () => {
    const targets = await useCamStore.getState().loadMeshFeatureTargets(BLIND_ID)
    const layer = (row(BLIND_ID).layers2d ?? []).find((l) => l.name.startsWith('STL holes'))!
    const blind = (layer.holes ?? [])[0]
    expect(blind.bottomZ).toBeCloseTo(6, 6)

    const plunge = await firstPlunge(
      'op-blind', BLIND_ID, [blind.loopId!], blind.topZ, blind.bottomZ,
    )
    expect(plunge.x).toBeCloseTo(0, 4)
    expect(plunge.y).toBeCloseTo(0, 4)
    expect(plunge.z).toBeCloseTo(6, 4)
    expect(targets.holes[0].through).toBe(false)
  })

  // NEGATIVE CONTROL. Offset the reported centre by the recentring shift - that
  // is, report the hole where the STL FILE has it instead of where the mesh is
  // - and the plunge no longer lands in the hole. This is WO-319's defect
  // restated for feature targets: it is the one mistake this whole order is
  // about, and the assertion above has to be able to catch it.
  it('a centre left in the file frame plunges a part-width away, and the assertion catches it', async () => {
    const mesh = importStl(stlBytesById.get(PLATE_ID)!).mesh
    const shift = meshRecenterShift(mesh)
    expect(Math.hypot(shift[0], shift[1], shift[2])).toBeGreaterThan(1)

    const targets = meshFeatureTargets(mesh)
    const through = targets.holes.find((hole) => hole.kind === 'through-hole')!
    const fileFrameCentre: [number, number] = [through.center[0] - shift[0], through.center[1] - shift[1]]

    // Land the SAME circle at the un-recentred centre, through the same store.
    const radius = through.diameterMm / 2
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((geo) => geo.id === PLATE_ID
          ? {
              ...geo,
              layers2d: [{
                id: 'file-frame-layer', name: 'File-frame control', color: '#f85149',
                visible: true, derived: true, frame: 'geometry_local' as const,
              }],
              loops: [{
                id: 'file-frame-loop', layerId: 'file-frame-layer', closed: true,
                type: 'contour' as const, area: Math.PI * radius * radius,
                points: Array.from({ length: 64 }, (_, i) => {
                  const a = (2 * Math.PI * i) / 64
                  return { x: fileFrameCentre[0] + radius * Math.cos(a), y: fileFrameCentre[1] + radius * Math.sin(a) }
                }),
              }],
            }
          : geo),
      },
    }))

    const plunge = await firstPlunge(
      'op-control', PLATE_ID, ['file-frame-loop'], through.topZ, through.bottomZ,
    )
    expect(plunge.x).toBeCloseTo(fileFrameCentre[0], 4)
    expect(plunge.y).toBeCloseTo(fileFrameCentre[1], 4)
    // The assertion the real test makes FAILS on this payload, by the exact
    // recentring shift and no less.
    expect(() => expect(plunge.x).toBeCloseTo(-HALF, 4)).toThrow()
    expect(plunge.x! - (-HALF)).toBeCloseTo(-shift[0], 4)
    expect(plunge.y! - (-HALF)).toBeCloseTo(-shift[1], 4)
  })
})
