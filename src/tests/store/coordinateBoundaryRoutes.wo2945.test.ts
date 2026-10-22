import { readFileSync, writeFileSync } from 'node:fs'
// Production store-entry tests. Adapter spies observe what the APPLICATION
// dispatches; they do not claim the canned moves prove engine geometry.
// A separate real BvhKernel case below measures generated move equivalence.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { ComputeParallel3dArgs } from '../../cam3d/integration/parallel3dOperation'
import type { ComputeAdaptive3dArgs } from '../../cam3d/integration/adaptive3dOperation'
import type { ImportedGeometry, Operation, OperationType, PhysicalStock, Setup, Tool, Vec3 } from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import * as frames from '../../lib/geometry/coordinateFrames'

const bridge = vi.hoisted(() => ({
  parallel: vi.fn(), waterline: vi.fn(), steep: vi.fn(), scallop: vi.fn(), pencil: vi.fn(), adaptive: vi.fn(),
  mesh: null as unknown, client: null as unknown, realParallel: false,
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
  return typedMock<typeof actual>({ ...actual,
    acquirePartMesh: vi.fn(async () => bridge.mesh as PartMesh),
    computeParallel3dMoves: async args => {
      bridge.parallel(args)
      return bridge.realParallel ? actual.computeParallel3dMoves(args) : finishResult()
    },
  })
})
vi.mock('../../cam3d/integration/waterline3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/waterline3dOperation')>()
  return typedMock<typeof actual>({ ...actual, computeWaterline3dMoves: async args => { bridge.waterline(args); return finishResult() } })
})
vi.mock('../../cam3d/integration/steepShallow3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/steepShallow3dOperation')>()
  return typedMock<typeof actual>({ ...actual, computeSteepShallow3dMoves: async args => { bridge.steep(args); return finishResult() } })
})
vi.mock('../../cam3d/integration/scallop3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/scallop3dOperation')>()
  return typedMock<typeof actual>({ ...actual, computeScallop3dMoves: async args => { bridge.scallop(args); return finishResult() } })
})
vi.mock('../../cam3d/integration/pencil3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/pencil3dOperation')>()
  return typedMock<typeof actual>({ ...actual, computePencil3dMoves: async args => { bridge.pencil(args); return finishResult() } })
})
vi.mock('../../cam3d/integration/adaptive3dOperation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>()
  return typedMock<typeof actual>({ ...actual, computeAdaptive3dMoves: async args => {
    bridge.adaptive(args)
    return { ...finishResult(), heightTruth: args.resolvedHeights, cellSize: 1 }
  } })
})
vi.mock('../../cam3d/integration/appClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  return typedMock<typeof actual>({ ...actual, getCam3dClient: () => bridge.client as Cam3dClient })
})
vi.mock('../../lib/stepCache', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof actual>({ ...actual, loadCachedStep: vi.fn(async () => new ArrayBuffer(8)) })
})
vi.mock('../../lib/stlCache', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof actual>({ ...actual, loadCachedSTL: vi.fn(async () => new ArrayBuffer(8)) })
})

function finishResult() {
  return { moves: [
    { type: 'rapid' as const, x: 2, y: 3, z: 20 },
    { type: 'feed' as const, x: 2, y: 3, z: 13, feed: 300, role: 'cut' as const },
    { type: 'feed' as const, x: 4, y: 3, z: 13, feed: 300, role: 'cut' as const },
  ], computeTimeMs: 1 }
}

const { useCamStore } = await import('../../store')
const { cancelAllSerializedCam3dComputes } = await import('../../store/toolpathBatchScheduler')
const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]
const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
const mesh: PartMesh = { source: 'model', positions: Float32Array.from(positions), indices: Uint32Array.from(indices), bounds: { min: [0, 0, 0], max: [10, 10, 10] } }
const tool: Tool = {
  id: 'tool', name: '2 mm ball', type: 'ball_end_mill', diameter: 2, fluteLength: 40,
  shankDiameter: 2, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1 } },
}
const shift = { x: 40, y: 25, z: 8 }
const origin = { x: 0, y: 0, z: 0 }
const localBounds = { min: origin, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } }

function install(type: OperationType, position: Vec3, yaw: number, options: {
  format?: 'model' | 'step' | 'stl'; stockBoundary?: boolean; partBox?: boolean; tilt?: number
} = {}) {
  const format = options.format ?? 'model'
  const geo: ImportedGeometry = {
    id: 'geo', name: 'Coordinate cube', filename: `cube.${format}`, type: format === 'model' ? 'model' : format === 'step' ? 'brep' : 'mesh',
    format, loaded: true, stockId: 'stock', boundingBox: localBounds,
    // Model rows intentionally stay identity; effective pose is the Placement.
    position: format === 'model' ? origin : position,
    rotation: { x: format === 'model' ? 0 : options.tilt ?? 0, y: 0, z: format === 'model' ? 0 : yaw },
    ...(format === 'model' ? { modelItemId: 'item', modelBody: {
      ref: { bodyId: 'body', stableIds: [], version: 1 },
      display: { positions, indices, normals: [], edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [10, 10, 10] } },
    } } : {}),
  }
  const stockMin = options.partBox ? position : { x: position.x - 12, y: position.y - 11, z: position.z }
  const size = options.partBox ? { x: 10, y: 10, z: 10 } : { x: 40, y: 40, z: 10 }
  const stock: PhysicalStock = {
    id: 'stock', name: 'Block', mode: 'explicit', position: stockMin,
    bounds: { min: origin, max: size, size, center: { x: size.x / 2, y: size.y / 2, z: 5 } },
  }
  const op: Operation = stampSmartHeightAuthority({
    id: 'op', name: 'Frame route', type, enabled: true, status: 'pending', toolId: tool.id, geometrySelections: [geo.id],
    heights: { clearanceHeight: position.z + 20, clearanceHeightMode: 'absolute', retractHeight: position.z + 15, feedHeight: position.z + 12,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom' },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: { entryType: 'plunge', rampAngle: 3, rampLength: 5, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
    params: { useStockBoundary: options.stockBoundary ?? true, stepover: 1, tolerance: 0.1, stepdown: 2, maxStepdown: 2, cellSize: 1, stockEdgeOvershoot: 0 },
  }, { setupId: 'setup', stockId: stock.id, geometryIds: [geo.id] })
  const setup: Setup = {
    id: 'setup', name: 'Setup', notes: '', stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    wcs: { id: 'wcs', label: 'G54', fixtureOffset: 54, origin,
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id },
    operations: [op],
  }
  bridge.mesh = mesh
  useCamStore.setState(state => ({ toolLibrary: [tool], toolpathBatch: null, project: {
    ...state.project, id: 'wo2945-project', geometry: [geo], setups: [setup], stocks: [stock], activeSetupId: setup.id,
    modelItemPlacements: [{ modelItemId: 'item', position, rotation: { x: options.tilt ?? 0, y: 0, z: yaw } }],
  } }))
  return { stockMin, size, op }
}
const currentOp = () => useCamStore.getState().project.setups[0].operations[0]
async function compute() {
  await useCamStore.getState().computeOperationToolpath('setup', 'op')
  expect(currentOp().status, currentOp().errorMessage).toBe('ready')
  return currentOp()
}

function expectedRing(min: Vec3, size: Vec3, position: Vec3, yaw: number): number[] {
  const c = Math.cos(yaw * Math.PI / 180), s = Math.sin(yaw * Math.PI / 180)
  return [[min.x, min.y], [min.x + size.x, min.y], [min.x + size.x, min.y + size.y], [min.x, min.y + size.y]]
    .flatMap(([x, y]) => [(x - position.x) * c + (y - position.y) * s, -(x - position.x) * s + (y - position.y) * c])
}
function expectBoundary(boundary: readonly Float64Array[] | undefined, expected: number[]) {
  expect(boundary).toHaveLength(1)
  expect(boundary![0]).toBeInstanceOf(Float64Array)
  expect(boundary![0]).toHaveLength(8)
  for (let i = 0; i < expected.length; i++) expect(boundary![0][i]).toBeCloseTo(expected[i], 10)
}

let client: Cam3dClient
beforeEach(() => {
  cancelAllSerializedCam3dComputes()
  vi.clearAllMocks()
  bridge.realParallel = false
  const kernel = new BvhKernel()
  const worker: WorkerLike = {
    onmessage: null, onerror: null, postMessage: message => dispatcher.handle(message as Cam3dRequest), terminate: () => {},
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => worker.onmessage?.({ data: message } as MessageEvent))
  bridge.client = client = new Cam3dClient(worker)
})
afterEach(async () => { cancelAllSerializedCam3dComputes(); await client.dispose(); vi.restoreAllMocks() })

describe('WO-2945 production boundary routes', () => {
  it.each([
    ['parallel_3d', 'parallel'], ['steep_shallow_3d', 'steep'], ['scallop_3d', 'scallop'], ['pencil_3d', 'pencil'], ['waterline_3d', 'waterline'],
  ] as const)('%s uses effective Model Item pose once for translated/yawed world stock', async (type, spy) => {
    const { stockMin, size } = install(type, shift, 90)
    const result = await compute()
    expect(bridge[spy]).toHaveBeenCalledOnce()
    const args = bridge[spy].mock.calls[0][0] as ComputeParallel3dArgs
    expectBoundary(args.boundary, expectedRing(stockMin, size, shift, 90))
    expect(args.partMesh.bounds).toEqual(mesh.bounds)
    // Engine stub returns local (2,3,13): app must place it ONCE at (37,27,21).
    const placed = result.toolpathMoves?.find(move => move.type === 'feed')
    expect(placed?.x).toBeCloseTo(37, 10)
    expect(placed?.y).toBeCloseTo(27, 10)
    expect(placed?.z).toBeCloseTo(21, 10)
    expect(result.resolvedHeights?.machine.top).toBeCloseTo(18, 10)
  })

  it.each(['step', 'stl'] as const)('%s keeps its format base frame without applying geometry placement twice', async format => {
    const { stockMin, size } = install('parallel_3d', shift, -90, { format })
    await compute()
    const args = bridge.parallel.mock.calls[0][0] as ComputeParallel3dArgs
    expectBoundary(args.boundary, expectedRing(stockMin, size, shift, -90))
    expect(args.partMesh.bounds.min).toEqual(format === 'stl' ? [-5, -5, 0] : [0, 0, 0])
    expect(args.partMesh.bounds.max).toEqual(format === 'stl' ? [5, 5, 10] : [10, 10, 10])
  })

  it('adaptive preview and compute share the translated footprint and stock height', async () => {
    const ringSpy = vi.spyOn(frames, 'worldRingsToDisplayLocalMm')
    const { stockMin, size } = install('adaptive_3d', shift, 0)
    const preview = await useCamStore.getState().previewAdaptive3dSmartHeights('setup', currentOp())
    const previewRing = ringSpy.mock.results.at(-1)?.value as Float64Array[]
    expectBoundary(previewRing, expectedRing(stockMin, size, shift, 0))
    expect(bridge.adaptive).not.toHaveBeenCalled()
    const result = await compute()
    const args = bridge.adaptive.mock.calls[0][0] as ComputeAdaptive3dArgs
    expect(args.boundary).toBeUndefined() // existing full-clear clips via field extent
    expect(args.stockBounds).toMatchObject({ minX: -12, minY: -11, maxX: 28, maxY: 29, minZ: 0, maxZ: 10 })
    expect(result.resolvedHeights?.machine).toEqual(preview.machine)
    expect(result.resolvedHeights?.machine.top).toBe(18)
  })

  it('adaptive rotated fallback retains a local footprint and does not enable full-clear/side-entry', async () => {
    const { stockMin, size } = install('adaptive_3d', shift, 37)
    await useCamStore.getState().previewAdaptive3dSmartHeights('setup', currentOp())
    await compute()
    const args = bridge.adaptive.mock.calls[0][0] as ComputeAdaptive3dArgs
    expectBoundary(args.boundary, expectedRing(stockMin, size, shift, 37))
    expect(args.sideEntry).toBeUndefined() // false is omitted by the production payload
    expect(args.reachStockEdgeBy).toBeUndefined()
  })

  it('adaptive part-box comparison preserves full-clear at translated nonzero Z', async () => {
    install('adaptive_3d', shift, 0, { stockBoundary: false, partBox: true })
    await compute()
    const args = bridge.adaptive.mock.calls[0][0] as ComputeAdaptive3dArgs
    expect(args.boundary).toBeUndefined()
    expect(args.sideEntry).toBe(true)
    expect(args.stockBounds).toMatchObject({ minX: 0, minY: 0, maxX: 10, maxY: 10, minZ: 0, maxZ: 10 })
  })

  it('preserves the imported and effective-model tilt refusals before strategy dispatch', async () => {
    for (const format of ['step', 'model'] as const) {
      install('parallel_3d', shift, 0, { format, tilt: 5 })
      await useCamStore.getState().computeOperationToolpath('setup', 'op')
      expect(currentOp().status).toBe('error')
      expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
      expect(bridge.parallel).not.toHaveBeenCalled()
    }
  })

  it('real parallel engine preserves main geometry at identity and translated/yawed poses', async () => {
    bridge.realParallel = true
    // A square world stock centered on the rotation origin describes the
    // SAME local material at 0/90 degrees. The earlier asymmetric AABB did not.
    const scene = (position: Vec3, yaw: number) => {
      install('parallel_3d', position, yaw)
      useCamStore.setState(state => ({ project: { ...state.project, stocks: state.project.stocks!.map(stock => ({
        ...stock, position: { x: position.x - 15, y: position.y - 15, z: position.z },
        bounds: { ...stock.bounds, size: { x: 30, y: 30, z: 10 } },
      })) } }))
    }
    scene(origin, 0)
    const a = await compute()
    scene(shift, 90)
    const b = await compute()
    const observations = [a, b].map(op => ({ moves: op.toolpathMoves!, machine: op.resolvedHeights!.machine }))
    for (const observation of observations) {
      expect(observation.moves.filter(move => move.role === 'cut').length).toBeGreaterThan(5)
      expect(observation.moves.every(move => [move.x, move.y, move.z].every(Number.isFinite))).toBe(true)
    }
    expect(b.resolvedHeights!.machine.top - a.resolvedHeights!.machine.top).toBe(shift.z)
    const baselinePath = new URL('../evidence/WO-2945/application-main-baseline.json', import.meta.url)
    // Explicit desk evidence capture only, with store/index.ts restored from
    // the recorded main source. Normal runs never update the baseline.
    if (process.env.WO2945_RECORD_MAIN === '1') {
      const source = process.env.WO2945_MAIN_SOURCE
      expect(source).toMatch(/^[a-f0-9]{40}$/)
      writeFileSync(baselinePath, JSON.stringify({ source, entry: 'useCamStore.computeOperationToolpath', observations }, null, 2) + '\n')
    } else {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { source: string; observations: typeof observations }
      expect(baseline.source).toMatch(/^[a-f0-9]{40}$/)
      expect(baseline.observations).toHaveLength(2)
      let worstMm = 0
      observations.forEach((actual, sceneIndex) => {
        const expected = baseline.observations[sceneIndex]
        expect(actual.machine).toEqual(expected.machine)
        expect(actual.moves).toHaveLength(expected.moves.length)
        actual.moves.forEach((p, i) => {
          const q = expected.moves[i]
          expect(p.type).toBe(q.type)
          expect(p.role).toBe(q.role)
          expect(p.feed).toBe(q.feed)
          for (const axis of ['x', 'y', 'z', 'cx', 'cy'] as const) {
            if (typeof p[axis] === 'number' && typeof q[axis] === 'number') {
              worstMm = Math.max(worstMm, Math.abs(p[axis]! - q[axis]!))
            } else expect(p[axis]).toBe(q[axis])
          }
        })
      })
      expect(worstMm).toBeLessThanOrEqual(1e-9)
      console.log(`[WO-2945] real production parallel vs main: ${a.toolpathMoves!.length}/${b.toolpathMoves!.length} moves; max coordinate/arc-center deviation ${worstMm} mm; both height stacks identical`)
    }

  }, 60_000)
})
