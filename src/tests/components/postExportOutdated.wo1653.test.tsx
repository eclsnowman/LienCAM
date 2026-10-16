// @vitest-environment jsdom
//
// WO-1653 fix round: independent audit (a29f0da54) FAILED the branch because
// `canExport` (PostProcessModal.tsx) read the LIVE, unstaged project's
// OP_OUTDATED diagnostic - an operation that is outdated only because an
// earlier one changed disabled the Export button, so the new
// stageOperationsForEmission recompute (handleExport) was unreachable by a
// real click. That is exactly the refusal rule 11 forbids: the software CAN
// recompute a merely-outdated op (it is not the same as a genuinely
// uncomputable one), so it must not refuse first.
//
// The auditor's repro seeded one op `status: 'outdated'` with the src/tests/
// post/helpers.ts makeOp default. WO-2792 repin: since WO-2788 Post recomputes
// an out-of-date op itself on open, and that makeOp op cannot be computed (no
// Smart Height V2 authority, no geometry), so it ended 'error' - a genuine
// compute failure, which WO-2788 still refuses (OP_ERROR) and which is not this
// test's subject. The op is now a computable Drill on a real sketch, seeded
// 'outdated', run through the REAL toolpathWorker.ts in-process; the Export
// assertions are unchanged.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { makeMachine } from '../post/helpers'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  SceneStock, Setup, Tool, Vec3, WCS,
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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

const SETUP_1 = 'setup-1'
const STOCK_ID = 'stock-1'
const PLATE_TOP = 20

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}
const circle = (cx: number, cy: number, r: number) => Array.from({ length: 32 }, (_, i) => {
  const t = (2 * Math.PI * i) / 32
  return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }
})

const DRILL = {
  id: 'drill', name: 'WO-1653 5mm drill', type: 'drill', toolNumber: 1, cutHand: 'right',
  diameter: 5, fluteLength: 25, shankDiameter: 5, overallLength: 70,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -3, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const DRILL_PARAMS = {
  geometryId: 'sketch', loopIds: ['hole'], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
  dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()
let realSelf: unknown

beforeAll(async () => {
  realSelf = (globalThis as { self?: unknown }).self
  Object.defineProperty(globalThis, 'self', {
    value: {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
      location: window.location,
    },
    configurable: true, writable: true,
  })
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  Object.defineProperty(globalThis, 'self', { value: realSelf, configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

beforeEach(() => {
  workerQueue = Promise.resolve()
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerQueue = workerQueue.then(async () => {
        activeShim = this
        await workerSelf.onmessage!({ data })
      })
    }
    terminate(): void { /* no thread */ }
  })
  // The worker is constructed from `new URL(...)`, so URL stays a constructor.
  class MockURL extends URL {
    static createObjectURL = vi.fn(() => 'blob:mock')
    static revokeObjectURL = vi.fn()
  }
  vi.stubGlobal('URL', MockURL)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  act(() => {
    useCamStore.getState().closeModal()
    // WO-1653: the auditor's precondition - an op whose status is 'outdated'
    // in the live project, no edit or predecessor machinery required.
    const op = {
      id: 'op1', name: 'Drill 1', type: 'drill', enabled: true, status: 'outdated', toolId: DRILL.id,
      geometrySelections: [], heights: HEIGHTS, passes: PASSES, linking: LINKING, params: DRILL_PARAMS,
      smartHeight: smartHeightAuthorityFixture('drill', {
        setupId: SETUP_1, heights: HEIGHTS, params: DRILL_PARAMS, geometryIds: ['sketch'], stockId: STOCK_ID,
        explicitDepthMm: 3,
      }),
    } as unknown as Operation
    const sketch = {
      id: 'sketch', name: 'Holes', filename: 'holes.svg', type: 'curves_2d', format: 'svg',
      boundingBox: bbox({ x: 52, y: 27, z: PLATE_TOP }, { x: 58, y: 33, z: PLATE_TOP }),
      position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      stockId: STOCK_ID, stockIdLocked: true,
      loops: [{ id: 'hole', closed: true, type: 'hole', layerId: 'L1', area: Math.PI * 9, points: circle(55, 30, 3) }],
      layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    } as unknown as ImportedGeometry
    const stock = {
      id: STOCK_ID, name: 'Stock', mode: 'explicit',
      bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: PLATE_TOP }),
      position: { x: 0, y: 0, z: 0 },
    } as unknown as PhysicalStock
    const sceneStock = {
      mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 60, fixedDepth: PLATE_TOP,
      fixedStocks: [],
    } as unknown as SceneStock
    const setup = {
      id: SETUP_1, name: 'Setup 1', notes: '',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE_TOP },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        stockId: STOCK_ID,
      } as WCS,
      stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
      operations: [op],
    } as unknown as Setup
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = {
      ...s.project, name: 'TestProject', machine: makeMachine(), geometry: [sketch], stocks: [stock],
      setups: [setup], sceneStock, activeSetupId: SETUP_1, activeOperationId: null,
    }
    useCamStore.setState({
      project,
      toolLibrary: [DRILL],
      toolpathBatch: null,
      modelRefsVerifiedSinceLoad: true,
      consoleEvents: [], consoleReadThroughId: 0,
    } as never)
  })
})

describe('PostProcessModal Export button (WO-1653 fix round)', () => {
  it('an outdated-only op does not disable Export - the click reaches the recompute', async () => {
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })

    const exportBtn = screen.getByRole('button', { name: /Export \.nc/i })

    // THE DEFECT: before the fix, canExport read the live OP_OUTDATED
    // diagnostic and this was `true` (button disabled), with tooltip "Fix
    // the errors below before exporting" - the click never happened.
    expect(exportBtn.hasAttribute('disabled')).toBe(false)
    expect(exportBtn.getAttribute('data-tooltip')).not.toBe('Fix the errors below before exporting')

    fireEvent.click(exportBtn)

    // The click is reachable: handleExport runs (stages a recompute attempt)
    // and reports through the console, rather than the button silently
    // swallowing the click by staying disabled.
    await waitFor(() => {
      const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'post')
      expect(events.length).toBeGreaterThan(0)
    })
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'post')
    expect(events[events.length - 1].message).not.toMatch(/nothing selected/i)
    // WO-2792: the fixture is computable - the outdated op ends ready, not 'error'.
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready')
  })
})
