// @vitest-environment jsdom
//
// WO-2880: leftovers of WO-2858 (names, not internal ids) and WO-2862 (the
// Post "All operations" box), measured through the rendered Post dialog and
// the production compute path:
//  1. a Contour deeper than its flute is refused without the loop's internal
//     `mec:` id in the operation's error;
//  2. Post diagnostics show the sentence, not the raw code in front of it;
//  3. with one operation unticked, the "All operations" box draws mixed.
// The harness (real toolpathWorker.ts in-process) follows postExportOutdated.wo1653.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { makeMachine } from './helpers'
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
// The id shape the architect's recheck showed on screen (mesh edge chain).
const LOOP_ID = 'mec:4d9ac8a66156e952'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

const END_MILL = {
  id: 'em6', name: '6 mm end mill', type: 'flat_end_mill', toolNumber: 1, cutHand: 'right',
  diameter: 6, fluteLength: 12, shankDiameter: 6, overallLength: 70,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool
const LONG_END_MILL = { ...END_MILL, id: 'em6-long', name: '6 mm long end mill', toolNumber: 2, fluteLength: 25 } as Tool
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const PASSES: PassParams = { stepdown: 4, stepover: 2, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

function contourOp(id: string, name: string, tool: Tool): Operation {
  // Contour Smart Height is through-stock: both cut the 20 mm plate.
  const depthMm = PLATE_TOP
  const heights: HeightParams = {
    clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
    topHeight: 0, topHeightMode: 'absolute', bottomHeight: -depthMm, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'sketch', loopIds: [LOOP_ID], side: 'outer', direction: 'climb',
    contourFinishMode: 'final', tabs: false,
  }
  return {
    id, name, type: 'contour_2d', enabled: true, status: 'pending', toolId: tool.id,
    geometrySelections: [], heights, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: SETUP_1, heights, params, geometryIds: ['sketch'], stockId: STOCK_ID,
    }),
  } as unknown as Operation
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
  class MockURL extends URL {
    static createObjectURL = vi.fn(() => 'blob:mock')
    static revokeObjectURL = vi.fn()
  }
  vi.stubGlobal('URL', MockURL)
  act(() => {
    useCamStore.getState().closeModal()
    const sketch = {
      id: 'sketch', name: 'Fixture plate', filename: 'plate.svg', type: 'curves_2d', format: 'svg',
      boundingBox: bbox({ x: 20, y: 15, z: PLATE_TOP }, { x: 60, y: 45, z: PLATE_TOP }),
      position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      stockId: STOCK_ID, stockIdLocked: true,
      loops: [{ id: LOOP_ID, closed: true, type: 'contour', layerId: 'L1', area: 1200, points: rect(20, 15, 60, 45) }],
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
      operations: [contourOp('op1', 'Contour 1', END_MILL), contourOp('op2', 'Contour 2', LONG_END_MILL)],
    } as unknown as Setup
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    const project = {
      ...s.project, name: 'TestProject', machine: makeMachine(), geometry: [sketch], stocks: [stock],
      setups: [setup], sceneStock, activeSetupId: SETUP_1, activeOperationId: null,
    }
    useCamStore.setState({
      project,
      toolLibrary: [END_MILL, LONG_END_MILL],
      toolpathBatch: null,
      modelRefsVerifiedSinceLoad: true,
      consoleEvents: [], consoleReadThroughId: 0,
    } as never)
  })
})

const op = (id: string) => useCamStore.getState().project.setups[0].operations.find(o => o.id === id)!

async function computeBoth(): Promise<void> {
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_1, 'op1') })
  await act(async () => { await useCamStore.getState().computeOperationToolpath(SETUP_1, 'op2') })
  await waitFor(() => expect(op('op1').status).toBe('error'))
  await waitFor(() => expect(op('op2').status, `${op('op1').errorMessage} // ${op('op2').errorMessage}`).toBe('ready'))
}

describe('WO-2880: names, not ids; diagnostics without the code; mixed scope box', () => {
  it('the Contour flute-reach refusal does not name the loop by its internal id', async () => {
    await computeBoth()
    const message = op('op1').errorMessage ?? ''
    expect(message).toMatch(/requested axial depth 20\.000 mm exceeds available flute length 12\.000 mm by 8\.000 mm/)
    expect(message).not.toContain('mec:')
    expect(message).not.toContain(LOOP_ID)
    // Unnamed loop: the loop clause is dropped, not filled with an id.
    expect(message).not.toContain('for loop')
  })

  it('a loop with a saved name is named in the refusal and in Post diagnostics', async () => {
    // The name the operation's Geometry list shows (Loop2D.name), saved on the loop.
    act(() => {
      const s = useCamStore.getState()
      const geometry = s.project.geometry.map(g => ({
        ...g, loops: (g.loops ?? []).map(l => (l.id === LOOP_ID ? { ...l, name: 'Outer profile' } : l)),
      }))
      useCamStore.setState({ project: { ...s.project, geometry } } as never)
    })
    await computeBoth()
    const message = op('op1').errorMessage ?? ''
    expect(message).toMatch(
      /requested axial depth 20\.000 mm for loop "Outer profile" exceeds available flute length 12\.000 mm by 8\.000 mm/,
    )
    expect(message).not.toContain('mec:')

    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })
    const row = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>('.diag-row'))
        .find(r => r.textContent?.includes('Operation "Contour 1" has an error'))
      expect(found).toBeDefined()
      return found!
    })
    expect(row.textContent).toContain('for loop "Outer profile"')
    expect(row.textContent).not.toContain('mec:')
  })

  it('Post diagnostics show the sentence without the raw code or the loop id', async () => {
    await computeBoth()
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })
    const row = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>('.diag-row'))
        .find(r => r.textContent?.includes('Operation "Contour 1" has an error'))
      expect(found).toBeDefined()
      return found!
    })
    const text = row.textContent ?? ''
    expect(text).toContain('Operation "Contour 1" has an error - fix it before posting.')
    expect(text).toContain('requested axial depth 20.000 mm')
    expect(text).not.toContain('mec:')
    // No diagnostic row of any code renders a raw code (OP_ERROR, ...) to the operator.
    for (const r of Array.from(document.querySelectorAll('.diag-row'))) {
      expect(r.textContent).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
    }
  })

  it('the All operations box draws checked, mixed and unchecked', async () => {
    await computeBoth()
    render(<PostProcessModal />)
    act(() => { useCamStore.getState().openModal('post-process') })
    const master = document.querySelector('.scope-master') as HTMLElement
    const all = master.querySelector('input[type="checkbox"]') as HTMLInputElement
    // The themed box (appearance: none, app.css) paints only :checked, so a mixed
    // state must carry its own fill and dash to be visible.
    const dash = () => master.querySelector('[aria-hidden="true"]')
    expect(all.checked).toBe(true)
    expect(all.indeterminate).toBe(false)
    expect(dash()).toBeNull()

    const opBoxes = Array.from(document.querySelectorAll<HTMLInputElement>('.scope-op-cb'))
    expect(opBoxes).toHaveLength(2)
    fireEvent.click(opBoxes[0])

    expect(all.checked).toBe(false)
    expect(all.indeterminate).toBe(true)
    expect(all.style.background).toBe('var(--accent)')
    expect(dash()).not.toBeNull()

    fireEvent.click(opBoxes[1])
    expect(all.checked).toBe(false)
    expect(all.indeterminate).toBe(false)
    expect(all.style.background).toBe('')
    expect(dash()).toBeNull()
  })
})
