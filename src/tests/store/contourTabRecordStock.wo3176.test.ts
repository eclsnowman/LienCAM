// WO-3218 (WO-3176 Brief A0): Contour holding tabs take their stock bottom from
// the project's stock RECORD, with or without a mounted viewport.
//
// Every case presses the store's OWN generate action (computeOperationToolpath)
// with no window.__cncViewport unless the case mounts one. The 2D worker is the
// REAL toolpathWorker.ts run in-process (node has no Worker thread), so the moves
// read back are the ones the application plans. Expected heights are worked out
// HERE from the stock box and the WCS origin, never from the kernel helper.
//
// SCENE: a 40 x 16 mm outline profiled from outside with a 6 mm end mill, cut
// through an explicit 80 x 80 x 10 mm block. Tabs 1.5 mm high, 8 mm wide, 4 of
// them. The world tab top is stock bottom + 1.5; the worker is told the stock
// bottom in the WCS frame (world bottom - WCS origin Z), converted exactly once.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

const TAB_HEIGHT = 1.5
const STOCK_DEPTH = 10

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function outline(): ImportedGeometry {
  return {
    id: 'part-outline', name: 'Part outline', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -20, y: -8, z: 0 }, { x: 20, y: 8, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: 'outline-loop', closed: true, type: 'contour', layerId: 'L1', area: 640,
      points: [{ x: -20, y: -8 }, { x: 20, y: -8 }, { x: 20, y: 8 }, { x: -20, y: 8 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const MILL: Tool = {
  id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 30, shankDiameter: 6, overallLength: 80,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

/** Heights in the setup's WCS frame: top at the stock top, bottom at the stock bottom (cut-through). */
function contourOp(tabs: boolean): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: STOCK_DEPTH - 6, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'part-outline', loopIds: [], side: 'outer', direction: 'climb',
    tabs, tabWidth: 8, tabHeight: TAB_HEIGHT, tabCount: 4,
  }
  const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-1', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['part-outline'] }),
  } as unknown as Operation
}

interface Scene {
  /** World Z of the stock bottom; null = the record holds no stock at all. */
  stockBottom: number | null
  originZ: number
  tabs?: boolean
}

function install({ stockBottom, originZ, tabs = true }: Scene): void {
  const stocks = stockBottom === null ? [] : [{
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -40, y: -40, z: stockBottom }, { x: 40, y: 40, z: stockBottom + STOCK_DEPTH }),
    position: { x: -40, y: -40, z: stockBottom },
  } as unknown as PhysicalStock]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -40, y: -40, z: originZ },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      ...(stockBottom === null ? {} : { stockId: DERIVED_STOCK_ID }),
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [contourOp(tabs)], notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: stockBottom === null ? 'fixed' : 'auto',
    autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 80, fixedDepth: 10, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [MILL],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [outline()], stocks, setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: 'op-1',
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

let workerRequests: WorkerRequestMsg[] = []
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  unmountViewport()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Mount a viewport that renders the stock block the record holds (what CNCViewport draws). */
function mountViewport(stockBottom: number): void {
  ;(globalThis as { window?: unknown }).window = {
    __cncViewport: {
      getStockBounds: () => ({
        min: { x: -40, y: -40, z: stockBottom },
        max: { x: 40, y: 40, z: stockBottom + STOCK_DEPTH },
      }),
    },
  }
}

function unmountViewport(): void {
  delete (globalThis as { window?: unknown }).window
}

const op = () => useCamStore.getState().project.setups[0].operations[0]
const contourRequest = () => workerRequests.find((r) => r.type === 'COMPUTE_CONTOUR')
const sentStockBottom = () => (contourRequest()?.payload as { stockBottomZ?: number } | undefined)?.stockBottomZ

async function generate(): Promise<void> {
  await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
}

/** Every Z a cutting feed holds level at over a lift: the retained tab tops. */
function tabPlateaus(moves: readonly ToolpathMove[]): number[] {
  const zs = new Set<number>()
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type !== 'feed' || a.type === 'rapid') continue
    if (b.z > a.z + 1e-6 && Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) zs.add(Number(b.z.toFixed(6)))
  }
  return [...zs].sort((x, y) => x - y)
}

function plan(): { moves: ToolpathMove[]; tabTopZ: number | undefined; sent: number | undefined } {
  const current = op()
  expect(current.status, current.errorMessage).toBe('ready')
  return {
    moves: current.toolpathMoves ?? [],
    tabTopZ: current.contourTabPreview?.tabTopZ,
    sent: sentStockBottom(),
  }
}

describe('WO-3218: Contour tabs read the record stock, not the mounted viewport', () => {
  it('world bottom 0, WCS origin Z 6: worker told -6, tabs retained at world Z 1.5 with no viewport', async () => {
    expect((globalThis as { window?: unknown }).window).toBeUndefined()
    install({ stockBottom: 0, originZ: 6 })
    await generate()
    const { moves, tabTopZ, sent } = plan()

    expect(sent).toBe(-6)
    expect(tabPlateaus(moves)).toEqual([1.5])
    expect(tabTopZ).toBe(1.5)
    // Nothing of the part is cut below the stock bottom by more than the cut-through floor.
    expect(Math.min(...moves.map((m) => m.z))).toBe(0)
  })

  it('moved explicit stock bottom 10, WCS origin Z 16: worker told -6, tabs retained at world Z 11.5', async () => {
    install({ stockBottom: 10, originZ: 16 })
    await generate()
    const { moves, tabTopZ, sent } = plan()

    expect(sent).toBe(-6)
    expect(tabPlateaus(moves)).toEqual([11.5])
    expect(tabTopZ).toBe(11.5)
    expect(Math.min(...moves.map((m) => m.z))).toBe(10)
  })

  it('mounted and unmounted plans agree', async () => {
    for (const scene of [{ stockBottom: 0, originZ: 6 }, { stockBottom: 10, originZ: 16 }]) {
      install(scene)
      await generate()
      const unmounted = plan()

      mountViewport(scene.stockBottom)
      let mounted: ReturnType<typeof plan>
      try {
        workerRequests = []
        install(scene)
        await generate()
        mounted = plan()
      } finally {
        unmountViewport()
      }

      expect(mounted.sent).toBe(unmounted.sent)
      expect(mounted.tabTopZ).toBe(unmounted.tabTopZ)
      expect(mounted.moves).toEqual(unmounted.moves)
    }
  })

  it('no record stock: the one existing inability line, and no motion', async () => {
    install({ stockBottom: null, originZ: 6 })
    await generate()
    const current = op()

    expect(current.status).toBe('error')
    expect(current.errorMessage ?? '').not.toMatch(/\n/)
    expect(current.errorMessage).toBeTruthy()
    expect(current.toolpathMoves ?? []).toEqual([])
    expect(current.contourTabPreview).toBeUndefined()
    // Refused before any request reached the worker: nothing was planned.
    expect(contourRequest()).toBeUndefined()
  })

  it('derived stock (members padded by the scene offsets): same bottom, same tabs', async () => {
    install({ stockBottom: 0, originZ: 6 })
    useCamStore.setState((st) => ({ project: { ...st.project,
      stocks: [{ id: DERIVED_STOCK_ID, name: 'Stock', mode: 'derived', position: { x: 0, y: 0, z: 0 },
        bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }) } as unknown as PhysicalStock],
      sceneStock: { ...st.project.sceneStock, mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: STOCK_DEPTH, autoOffsetZBottom: 0 } as SceneStock,
    } as Project }))
    await generate()
    const { moves, tabTopZ, sent } = plan()
    expect(sent).toBe(-6)
    expect(tabPlateaus(moves)).toEqual([1.5])
    expect(tabTopZ).toBe(1.5)
  })

  it('multiple stocks: the setup stock decides, not the union of every block', async () => {
    install({ stockBottom: 10, originZ: 16 })
    useCamStore.setState((st) => ({ project: { ...st.project,
      stocks: [...(st.project.stocks ?? []), {
        id: 'stock-other', name: 'Other block', mode: 'explicit',
        bounds: bbox({ x: 200, y: 0, z: -30 }, { x: 260, y: 60, z: 0 }),
        position: { x: 200, y: 0, z: -30 },
      } as unknown as PhysicalStock],
    } as Project }))
    await generate()
    const { moves, tabTopZ, sent } = plan()
    expect(sent).toBe(-6)
    expect(tabPlateaus(moves)).toEqual([11.5])
    expect(tabTopZ).toBe(11.5)
  })

  it('tabs off sends no stock bottom and no preview (legacy payload kept)', async () => {
    install({ stockBottom: 0, originZ: 6, tabs: false })
    await generate()
    const { sent, tabTopZ } = plan()
    expect(sent).toBeUndefined()
    expect(tabTopZ).toBeUndefined()
  })
})
