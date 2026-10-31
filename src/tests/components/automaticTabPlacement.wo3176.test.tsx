// @vitest-environment jsdom
//
// WO-3220 (WO-3176 Brief A2): Properties > Holding tabs > Suggest tab
// locations, rendered. The panel is the REAL PropertiesPanel on the REAL store;
// Generate is the store's computeOperationToolpath with the real
// toolpathWorker.ts run in-process (as the store journey does). Suggest,
// Apply, Apply K and Cancel are pressed as buttons; what they write is read
// back from the store and from the moves the next Generate publishes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

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
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const { smartHeightAuthorityFixture } = await import('../helpers/smartHeightAuthorityFixture')
const { pointAtFraction } = await import('../../lib/viewport/tabPlacement')

const TAB_WIDTH = 8
const TAB_HEIGHT = 1.5

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const RECT = [{ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: -50, y: 10 }]
/** A notch in the top edge: its inside corners stay sharp on the outside profile. */
const NOTCHED = [
  { x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: 15, y: 10 },
  { x: 15, y: 0 }, { x: -15, y: 0 }, { x: -15, y: 10 }, { x: -50, y: 10 },
]

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

function contourOp(extra: Record<string, unknown> = {}, passes: Partial<PassParams> = {}): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: 4, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'part', loopIds: [], side: 'outer', direction: 'climb',
    tabs: true, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT, tabCount: 6, ...extra,
  }
  return {
    id: 'op-1', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, linking: LINKING, params,
    passes: { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0, ...passes },
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['part'] }),
  } as unknown as Operation
}

function install(
  op: Operation = contourOp(), points = RECT,
  extra: { loops?: Array<{ id: string; points: typeof RECT }>; geometry?: ImportedGeometry[] } = {},
): void {
  const geometry = {
    id: 'part', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -50, y: -10, z: 0 }, { x: 50, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{ id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 2000, points },
      ...(extra.loops ?? []).map((l) => ({ id: l.id, closed: true, type: 'contour', layerId: 'L1', area: 64, points: l.points }))],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -80, y: -40, z: 6 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [op], notes: '',
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [MILL],
      toolpathBatch: null,
      project: {
        ...s.project, geometry: [geometry, ...(extra.geometry ?? [])], setups: [setup],
        stocks: [{
          id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
          bounds: bbox({ x: -80, y: -40, z: 0 }, { x: 80, y: 40, z: 10 }), position: { x: -80, y: -40, z: 0 },
        } as unknown as PhysicalStock],
        sceneStock: { mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 160, fixedHeight: 80, fixedDepth: 10, fixedStocks: [] } as unknown as SceneStock,
        activeSetupId: 'setup-1', activeOperationId: 'op-1',
        modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
      } as Project,
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerOnMessage: (e: { data: WorkerRequestMsg }) => Promise<void>
const realSelf = Object.getOwnPropertyDescriptor(globalThis, 'self')

beforeAll(async () => {
  const shimSelf = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null as null | ((e: { data: WorkerRequestMsg }) => Promise<void>),
    // The store resolves the worker URL against self.location.
    location: window.location,
  }
  Object.defineProperty(globalThis, 'self', { value: shimSelf, configurable: true, writable: true })
  await import('../../lib/cam/toolpathWorker')
  // The worker posts through `self` at call time: the shim stays for this file.
  workerOnMessage = shimSelf.onmessage!
})

afterAll(() => {
  if (realSelf) Object.defineProperty(globalThis, 'self', realSelf)
})

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      void workerOnMessage({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    enterContourTabEditMode: vi.fn(), exitContourTabEditMode: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const op = () => useCamStore.getState().project.setups[0].operations[0]

async function generate(): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1') })
  expect(op().status, op().errorMessage).toBe('ready')
}

function lifts(moves: readonly ToolpathMove[], topZ: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type !== 'feed' || a.type === 'rapid') continue
    if (Math.abs(a.z - topZ) < 1e-6 && Math.abs(b.z - topZ) < 1e-6 && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    }
  }
  return out
}

describe('WO-3220: Properties > Holding tabs > Suggest tab locations', () => {
  it('Suggest previews count, positions and reasons; Apply writes them; Generate cuts them', async () => {
    install(contourOp(), NOTCHED)
    await generate()
    render(<PropertiesPanel />)
    const before = JSON.stringify(op())
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    expect(screen.getByTestId('props-contour-tab-suggest-found').textContent).toBe('Found 6 of 6 suggestions')
    const line = screen.getAllByTestId('props-contour-tab-suggest-loop')[0].textContent ?? ''
    expect(line).toMatch(/^Outline 1: 6 of 6 at [\d., ]+ mm along the cut/)
    expect(line).toMatch(/Avoided: corners and short spans, the opposite wall$/)
    expect(screen.getByTestId('props-contour-tab-suggest-omitted').textContent).toContain('tool holder clearance')
    // Previewing writes nothing.
    expect(JSON.stringify(op())).toBe(before)

    const apply = screen.getByTestId('props-contour-tab-suggest-apply')
    expect(apply.textContent).toBe('Apply')
    fireEvent.click(apply)
    expect(screen.queryByTestId('props-contour-tab-suggestion')).toBeNull()
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent).toBe('Applied 6 tab locations. Generate to cut them.')
    const applied = (op().params as { tabLocations?: Record<string, number[]> }).tabLocations!
    expect(applied.outline).toHaveLength(6)
    expect(op().status).toBe('pending')
    // The applied fractions are ordinary hand locations: the existing editor counts them.
    expect(screen.getByTestId('props-contour-tab-custom-count')).toBeTruthy()

    await generate()
    const preview = op().contourTabPreview!
    const centers = applied.outline.map((f) => pointAtFraction(preview.loops[0].path, f))
    const cut = lifts(op().toolpathMoves as ToolpathMove[], preview.tabTopZ)
    expect(cut.length).toBeGreaterThanOrEqual(6)
    for (const lift of cut) expect(centers.some((c) => Math.hypot(c.x - lift.x, c.y - lift.y) < 1e-3)).toBe(true)
  })

  it('Cancel leaves the operation exactly as it was', async () => {
    install()
    await generate()
    render(<PropertiesPanel />)
    const before = JSON.stringify(op())
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest-cancel'))
    expect(screen.queryByTestId('props-contour-tab-suggestion')).toBeNull()
    expect(JSON.stringify(op())).toBe(before)
  })

  it('a partial result is applied only by the explicit Apply K', async () => {
    install()
    await generate()
    // Count override: 32 tabs of 8 mm on a 258.8 mm loop is more than the
    // greedy packing places once corners are ranked last.
    act(() => {
      useCamStore.getState().updateOperation('setup-1', 'op-1', { params: { ...op().params, tabCount: 32 } })
    })
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    const found = screen.getByTestId('props-contour-tab-suggest-found').textContent ?? ''
    const k = Number(/^Found (\d+) of 32 suggestions$/.exec(found)![1])
    expect(k).toBeGreaterThan(0)
    expect(k).toBeLessThan(32)
    const apply = screen.getByTestId('props-contour-tab-suggest-apply')
    expect(apply.textContent).toBe(`Apply ${k}`)
    fireEvent.click(apply)
    expect((op().params as { tabLocations?: Record<string, number[]> }).tabLocations!.outline).toHaveLength(k)
  })

  it('mixed Apply K: the outline with no suggestion is shown, applied and cut with no tabs', async () => {
    // A second outline, an 8 x 8 mm block, boxed in by four clamps 0.3 mm
    // clear of the cutter (as in the store journey): nothing fits on it.
    const clamp = (id: string, min: Vec3, max: Vec3) => ({
      id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf', workholding: true,
      boundingBox: bbox(min, max), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      loops: [], layers2d: [],
    } as unknown as ImportedGeometry)
    install(contourOp(), RECT, {
      loops: [{ id: 'block', points: [{ x: -4, y: 26 }, { x: 4, y: 26 }, { x: 4, y: 34 }, { x: -4, y: 34 }] }],
      geometry: [
        clamp('clamp-w', { x: -20, y: 17, z: 0 }, { x: -10.3, y: 45, z: 12 }),
        clamp('clamp-e', { x: 10.3, y: 17, z: 0 }, { x: 20, y: 45, z: 12 }),
        clamp('clamp-s', { x: -10.3, y: 17, z: 0 }, { x: 10.3, y: 19.7, z: 12 }),
        clamp('clamp-n', { x: -10.3, y: 40.3, z: 0 }, { x: 10.3, y: 45, z: 12 }),
      ],
    })
    await generate()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    const lines = screen.getAllByTestId('props-contour-tab-suggest-loop').map((el) => el.textContent ?? '')
    expect(lines[1]).toMatch(/^Outline 2: no location fits, so Apply leaves it without tabs/)
    const apply = screen.getByTestId('props-contour-tab-suggest-apply')
    expect(apply.textContent).toMatch(/^Apply \d+$/)
    fireEvent.click(apply)
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent)
      .toMatch(/^Applied \d+ tab locations; outlines left without tabs: 1\. Generate to cut them\.$/)
    const map = (op().params as { tabLocations?: Record<string, number[] | 'none'> }).tabLocations!
    expect(map.block).toBe('none')
    expect(screen.getByTestId('props-contour-tab-none-count').textContent).toBe('Outlines without tabs: 1')
    expect(screen.getByTestId('props-contour-tab-custom-count').textContent).toMatch(new RegExp(`^${(map.outline as number[]).length} custom tab`))

    await generate()
    const topZ = op().contourTabPreview!.tabTopZ
    expect(lifts(op().toolpathMoves as ToolpathMove[], topZ).filter((p) => p.y > 17)).toEqual([])

    // Edit tab locations starts from what is shown: the block is not seeded with
    // even tabs, and a click on it adds its first hand-placed tab.
    fireEvent.click(screen.getByTestId('props-contour-tab-edit'))
    expect((op().params as { tabLocations?: Record<string, unknown> }).tabLocations!.block).toBe('none')
    const vp = (window as unknown as { __cncViewport: { enterContourTabEditMode: ReturnType<typeof vi.fn> } }).__cncViewport
    const handlers = vp.enterContourTabEditMode.mock.calls[0][0] as { onAdd: (loopId: string, f: number) => void }
    act(() => { handlers.onAdd('block', 0.25) })
    expect((op().params as { tabLocations?: Record<string, unknown> }).tabLocations!.block).toEqual([0.25])

    // Reset to even spacing clears every entry, 'none' included.
    act(() => {
      useCamStore.getState().updateOperation('setup-1', 'op-1', {
        params: { ...op().params, tabLocations: { block: 'none' } },
      })
    })
    expect(screen.queryByTestId('props-contour-tab-custom-count')).toBeNull()
    fireEvent.click(screen.getByTestId('props-contour-tab-reset'))
    expect((op().params as { tabLocations?: unknown }).tabLocations).toBeUndefined()
  })

  it('inputs changed after the preview: Apply writes nothing and shows the recomputed suggestion', async () => {
    install()
    await generate()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    act(() => {
      useCamStore.getState().updateOperation('setup-1', 'op-1', { params: { ...op().params, tabCount: 3 } })
    })
    const before = JSON.stringify(op())
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest-apply'))
    expect(JSON.stringify(op())).toBe(before)
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent).toMatch(/suggestions were worked out again/)
    expect(screen.getByTestId('props-contour-tab-suggest-found').textContent).toBe('Found 3 of 3 suggestions')
  })

  it('roughing, not generated and stale contours get one honest line and no preview', async () => {
    install(contourOp({}, { stockToLeave: 0.5, finishPasses: 1 }))
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent).toMatch(/finish-only contours; this one roughs first/)
    expect(screen.queryByTestId('props-contour-tab-suggestion')).toBeNull()
    cleanup()

    install()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent).toMatch(/^Generate this operation first/)
    cleanup()

    install()
    await generate()
    act(() => {
      useCamStore.setState((st) => ({ project: { ...st.project, setups: st.project.setups.map((s) => ({
        ...s, wcs: { ...s.wcs, origin: { ...s.wcs.origin, y: s.wcs.origin.y + 3 } } })) } }))
    })
    render(<PropertiesPanel />)
    const before = JSON.stringify(op())
    fireEvent.click(screen.getByTestId('props-contour-tab-suggest'))
    expect(screen.getByTestId('props-contour-tab-suggest-note').textContent).toMatch(/Generate again to suggest/)
    expect(JSON.stringify(op())).toBe(before)
  })
})
