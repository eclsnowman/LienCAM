// @vitest-environment jsdom
//
// WO-1922: a drill or bore on an edited STL hole is marked out of date.
//
// Rule 6: drives the store's own re-recognition actions (loadMeshFeatureTargets,
// loadMeshEdgeChains, loadMeshFlatFaces) against ready Drill and Bore operations
// bound to loop ids that recognition (re)lands. The harness below is
// WO-1851's, verbatim.
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

const { useCamStore } = await import('../../store')
const { buildDrillBoreSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { legacyHeightIntentForOperation } = await import('../../lib/cam/heightIntent')
const { exportBinaryStl, importStl } = await import('../../mesh/stl')

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

type Action = 'loadMeshFeatureTargets' | 'loadMeshEdgeChains' | 'loadMeshFlatFaces'
const ACTIONS: Action[] = ['loadMeshFeatureTargets', 'loadMeshEdgeChains', 'loadMeshFlatFaces']
const MOVES = [{ type: 'rapid', x: 0, y: 0, z: 5 }] as unknown as Operation['toolpathMoves']

function readyOp(id: string, type: 'drill' | 'bore', loopIds: string[]): Operation {
  return {
    ...drillOp(id, PLATE_ID, loopIds, 12, 0),
    type, name: type, status: 'ready', toolpathMoves: MOVES,
  } as Operation
}

function reseed(operations: Operation[]): void {
  useCamStore.setState({
    toolLibrary: [drillTool],
    project: project(
      [stlRow(PLATE_ID, 'Plate', [80, 80, 17]), stlRow(BLIND_ID, 'Blind', [40, 40, 12])],
      operations,
    ),
  })
}

function ops(): Operation[] {
  return useCamStore.getState().project.setups[0].operations
}

/** The loop ids an action lands on a fresh project (recognition is deterministic). */
async function landedIds(action: Action): Promise<string[]> {
  reseed([])
  await useCamStore.getState()[action](PLATE_ID)
  return (row(PLATE_ID).loops ?? []).map((loop) => loop.id)
}

describe('WO-1922: re-recognition stales drill and bore bound to a changed loop', () => {
  for (const action of ACTIONS) {
    describe(action, () => {
      it('flips a ready Drill and a ready Bore bound to a re-derived loop to outdated, clearing moves', async () => {
        const ids = await landedIds(action)
        expect(ids.length).toBeGreaterThan(0)
        reseed([
          readyOp('op-drill', 'drill', [ids[0]]),
          readyOp('op-bore', 'bore', [ids[0]]),
        ])
        await useCamStore.getState()[action](PLATE_ID)
        for (const op of ops()) {
          expect(op.status, op.id).toBe('outdated')
          expect(op.toolpathMoves, op.id).toBeUndefined()
        }
      })

      it('keeps a Drill and a Bore bound to an unrelated loop ready with their moves', async () => {
        await landedIds(action)
        reseed([
          readyOp('op-drill', 'drill', ['loop-not-from-stl']),
          readyOp('op-bore', 'bore', ['loop-not-from-stl']),
        ])
        await useCamStore.getState()[action](PLATE_ID)
        for (const op of ops()) {
          expect(op.status, op.id).toBe('ready')
          expect(op.toolpathMoves, op.id).toBe(MOVES)
        }
      })
    })
  }

  it('an unrelated op type bound to the same loop is still left alone', async () => {
    const ids = await landedIds('loadMeshFeatureTargets')
    reseed([{ ...readyOp('op-pocket', 'drill', [ids[0]]), type: 'pocket_2d' } as Operation])
    await useCamStore.getState().loadMeshFeatureTargets(PLATE_ID)
    expect(ops()[0].status).toBe('ready')
  })
})
