// @vitest-environment jsdom
//
// WO-1566: the shank clearance is shown on the operation and the operator can
// set it. Operator ruling 2026-09-15: "We want to set the default minimum clearance to
// 0.25mm, A good rule of thumb for relieved shank endmills is 0.25mm to 0.5mm."
//
// Drives the REAL New Operation dialog and the REAL Properties panel against
// the REAL store (the toolpath worker module executes in-process, as in the
// WO-1544 height-row test), then proves the persisted value reaches the REAL
// worker's clearance trim: the stop notice names it exactly and the stop moves
// back accordingly. The scene is WO-1565's case 2 (the short-neck lollipop
// under the lip T), the acceptance scene the WO names.
//
// THE SEAM THIS PINS: the dialog/panel persist `params.clearanceAllowanceMm`;
// the worker reads the payload's top-level `clearanceAllowanceMm`. The one
// store-dispatch line joining them (payload.clearanceAllowanceMm = the params
// value) lands with the clearancePart wiring WO-1565's decide-and-log scoped
// to a follow-up holding src/store/index.ts. This test sources the payload's
// allowance FROM THE PERSISTED OPERATION through the gate's own reader
// (clearanceAllowanceMmOf), so the field, the params spelling and the notice
// are proved to agree - and the follow-up's one line is pinned by contract.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock, Setup, Tool, ToolHolder, ToolpathMove } from '../../types'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import type { StockState } from '../../lib/cam/stockState'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

// The production toolpath worker, run in this thread. Its module assigns
// self.onmessage and answers through self.postMessage.
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
const realSelf = globalThis.self
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = data => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { clearanceAllowanceMmOf } = await import('../../lib/cam/holderClearanceGate')

afterAll(() => { vi.stubGlobal('self', realSelf) })

/** Drive the real worker DIRECTLY, isolated from the store's dispatch channel
 *  (its response handler would otherwise claim these moves for the open op). */
async function runWorker(type: string, payload: unknown): Promise<{ type: string; [k: string]: unknown }> {
  const prior = workerScope.postMessage
  const captured: Array<{ type: string }> = []
  workerScope.postMessage = (data) => { captured.push(data as { type: string }) }
  try {
    await workerScope.onmessage?.({ data: { type, payload } } as MessageEvent)
  } finally {
    workerScope.postMessage = prior
  }
  const terminal = captured.filter(response => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  return terminal[0]
}

// ── The WO-1565 case-2 scene (lip T, short-neck lollipop) ────────────────────

type Box = readonly [number, number, number, number, number, number]
const STEM: Box = [-5, -5, 0, 5, 5, 10]
const LIP: Box = [-5.3, -5.3, 10, 0, 5.3, 15]
const CUT_Z = 5

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function silhouetteStock(boxes: readonly Box[], cell = 0.25): StockState {
  const bounds = { minX: -40, minY: -40, minZ: 0, maxX: 40, maxY: 40, maxZ: 15 }
  const nx = Math.round((bounds.maxX - bounds.minX) / cell)
  const ny = Math.round((bounds.maxY - bounds.minY) / cell)
  const topZ = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    const y = bounds.minY + (j + 0.5) * cell
    for (let i = 0; i < nx; i++) {
      const x = bounds.minX + (i + 0.5) * cell
      for (const [x0, y0, , x1, y1, z1] of boxes) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) topZ[j * nx + i] = Math.max(topZ[j * nx + i], z1)
      }
    }
  }
  return {
    schemaVersion: 1, representation: 'z-dexel', bounds, requestedResolutionMm: cell, resolutionMm: cell,
    warnings: [], nx, ny, bottomZ: 0, topZ,
  }
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}
/** Case 2's tool: 6 mm lollipop, 3 mm neck only 3 mm long - the shank would rub the flange. */
const LOLLIPOP_SHORT_NECK = {
  id: 'tool-lollipop', name: '6 mm lollipop, 3 mm neck', type: 'lollipop_mill',
  diameter: 6, fluteLength: 6, shankDiameter: 6, overallLength: 60,
  neckDiameter: 3, shoulderLength: 3, lengthBelowHolder: 40,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const CASE2_HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 25, feedHeight: 20,
  topHeight: CUT_Z + 1, topHeightMode: 'absolute',
  bottomHeight: CUT_Z, bottomHeightMode: 'absolute',
}
const CASE2_PASSES: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const CASE2_LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const CASE2_PART = meshOf([STEM, LIP])
const CASE2_REMAINING = silhouetteStock([STEM, LIP])

/** The case-2 payload, with the allowance read off a REAL persisted operation
 *  through the gate's own reader - the exact value the store's dispatch line
 *  will put at the payload top level once the clearancePart wiring lands. */
function case2PayloadFrom(operation: Operation) {
  return {
    opId: 'op-undercut', setupId: 'setup-1',
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false },
    heights: CASE2_HEIGHTS, passes: CASE2_PASSES, linking: CASE2_LINKING,
    tool: LOLLIPOP_SHORT_NECK,
    loops: [{
      id: 'stem', closed: true, type: 'contour',
      points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
    }],
    wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER,
    stockBlock: { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 15 } },
    clearancePart: CASE2_PART,
    remainingStock: CASE2_REMAINING,
    clearanceAllowanceMm: clearanceAllowanceMmOf(operation.params),
  }
}

async function case2(operation: Operation): Promise<ToolpathCompleteWithNotices> {
  const response = await runWorker('COMPUTE_CONTOUR', case2PayloadFrom(operation))
  if (response.type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(response)}`)
  return response as ToolpathCompleteWithNotices
}

function stopNotices(response: ToolpathCompleteWithNotices): string[] {
  return (response.notices ?? []).filter(notice => notice.includes('left uncut'))
}

function cutLengthAtDepth(moves: readonly ToolpathMove[]): number {
  let length = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid' || Math.abs(a.z - CUT_Z) > 1e-6 || Math.abs(b.z - CUT_Z) > 1e-6) continue
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return length
}

// ── Store seeding ────────────────────────────────────────────────────────────

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const endMill = {
  id: 'tool-flat', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
} as unknown as Tool

const contourPart = {
  id: 'contour-part', name: 'Boss.step', filename: 'Boss.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id, loopsVersion: 2,
  position: { x: 30, y: 30, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
    size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
  },
  loops: [{
    id: 'boss-loop', layerId: 'boss-layer', closed: true, type: 'contour', area: 100,
    points: [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }],
  }],
  layers2d: [{
    id: 'boss-layer', name: 'Profile', color: '#fff', visible: true, frame: 'geometry_local',
    cylinders: [{
      center: [0, 0], diameter: 10, topZ: 10, bottomZ: 4, through: false, kind: 'boss', loopId: 'boss-loop',
    }],
  }],
} as unknown as ImportedGeometry

function seedDialog(): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
      originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [endMill],
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      stocks: [stock], geometry: [contourPart],
    },
  } as never)
}

function seedPanelOperation(params: Record<string, unknown>): void {
  const op = {
    id: 'op-1', name: 'Contour 1', type: 'contour_2d', toolId: 'tool-flat', status: 'ready',
    enabled: true, geometrySelections: [],
    toolpathMoves: [{ type: 'rapid', x: 1, y: 2, z: 3 }],
    computeTimeMs: 42, estimatedCutTimeMs: 84,
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    params,
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 2,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
    },
  } as unknown as Operation
  const setup = {
    id: 'setup-1', name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } }, operations: [op],
  } as unknown as Setup
  useCamStore.setState((s) => ({
    toolLibrary: [endMill],
    project: {
      ...s.project, setups: [setup],
      activeSetupId: 'setup-1', activeOperationId: 'op-1',
    },
    viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
  }))
}

function savedOperation(): Operation {
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

function shankClearanceInput(rowTestId: string): HTMLInputElement {
  return within(screen.getByTestId(rowTestId)).getByRole('textbox') as HTMLInputElement
}

function typeInto(input: HTMLInputElement, value: string): void {
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = InProcessToolpathWorker
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } }),
  }
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  act(() => useCamStore.getState().setDisplayUnits('mm'))
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

// ── The field in the New Operation dialog ────────────────────────────────────

describe('WO-1566 the shank clearance field in the New Operation dialog', () => {
  it('a new contour shows Shank clearance starting at 0.25 mm; a 3D operation does not show it', async () => {
    seedDialog()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByRole('button', { name: 'Passes' }))
    expect(shankClearanceInput('op-shank-clearance').value).toBe('0.25')

    // The 3D strategies do not go through the worker's clearance trim: no field.
    fireEvent.click(screen.getByRole('button', { name: 'Type & Name' }))
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByRole('button', { name: 'Passes' }))
    expect(screen.queryByTestId('op-shank-clearance')).toBeNull()
  })

  it('set to 0.5 on a new contour: the operation persists it and the case-2 stop notice names it, the stop moved back', async () => {
    seedDialog()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByRole('button', { name: 'Tool' }))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByRole('button', { name: 'Geometry' }))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: contourPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Passes' }))
    typeInto(shankClearanceInput('op-shank-clearance'), '0.5')

    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    await waitFor(() => {
      expect(savedOperation().toolpathMoves?.length ?? 0).toBeGreaterThan(0)
    }, { timeout: 20000 })

    // The value typed into the rendered dialog is on the saved operation.
    const operation = savedOperation()
    expect(clearanceAllowanceMmOf(operation.params)).toBe(0.5)

    // Computing the WO-1565 case-2 scene with the operation's value: the stop
    // notice names 0.5 exactly, and the stop moved back from the 0.25 default.
    const atOperatorValue = await case2(operation)
    const stops = stopNotices(atOperatorValue)
    expect(stops.length).toBeGreaterThan(0)
    expect(stops[0]).toMatch(/the shank would come within 0\.5 mm of the part/)
    const [, sx, sy] = /cut stopped at X (-?[\d.]+) Y (-?[\d.]+)/.exec(stops[0])!
    const gapAtStop = xyDistanceToBox(Number(sx), Number(sy), LIP) - 3
    expect(gapAtStop).toBeGreaterThanOrEqual(0.5 - 0.01)
    expect(gapAtStop).toBeLessThan(0.5 + 0.5)

    const atDefault = await case2({
      ...operation,
      params: { ...operation.params, clearanceAllowanceMm: 0.25 },
    })
    expect(cutLengthAtDepth(atOperatorValue.moves)).toBeLessThan(cutLengthAtDepth(atDefault.moves))
  })

  it('reopening the operation in the dialog shows the persisted value and saves a new one', async () => {
    seedDialog()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByRole('button', { name: 'Tool' }))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByRole('button', { name: 'Geometry' }))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: contourPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Passes' }))
    typeInto(shankClearanceInput('op-shank-clearance'), '0.5')
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    await waitFor(() => expect(savedOperation().toolpathMoves?.length ?? 0).toBeGreaterThan(0), { timeout: 20000 })

    act(() => useCamStore.getState().openEditOperation('setup-1', savedOperation().id))
    fireEvent.click(await screen.findByRole('button', { name: 'Passes' }))
    expect(shankClearanceInput('op-shank-clearance').value).toBe('0.5')
    typeInto(shankClearanceInput('op-shank-clearance'), '0.3')
    const save = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(clearanceAllowanceMmOf(savedOperation().params)).toBe(0.3))
  })

  it('inch display shows and accepts the converted value; the notice prints the stored value exactly', async () => {
    seedDialog()
    useCamStore.getState().setDisplayUnits('inch')
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByRole('button', { name: 'Tool' }))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByRole('button', { name: 'Geometry' }))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: contourPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Passes' }))

    // 0.25 mm shows as inches at the app's inch display precision (4 dp).
    expect(shankClearanceInput('op-shank-clearance').value).toBe('0.0098')
    typeInto(shankClearanceInput('op-shank-clearance'), '0.0197')

    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    await waitFor(() => expect(savedOperation().toolpathMoves?.length ?? 0).toBeGreaterThan(0), { timeout: 20000 })

    // 0.0197 in = 0.50038 mm, and the notice prints it exactly - not "0.5".
    const operation = savedOperation()
    expect(clearanceAllowanceMmOf(operation.params)).toBeCloseTo(0.50038, 6)
    const response = await case2(operation)
    expect(stopNotices(response)[0]).toMatch(/within 0\.50038 mm of the part/)
  })
})

// ── The field in the Properties panel ────────────────────────────────────────

describe('WO-1566 the shank clearance field in the Properties panel', () => {
  it('an existing operation without the value shows the 0.25 default; typing 0.125 persists it, marks the op stale, and the notice reads 0.125', async () => {
    seedPanelOperation({ side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false })
    render(<PropertiesPanel />)
    expect(shankClearanceInput('props-shank-clearance').value).toBe('0.25')

    typeInto(shankClearanceInput('props-shank-clearance'), '0.125')
    const operation = savedOperation()
    expect(clearanceAllowanceMmOf(operation.params)).toBe(0.125)
    expect(operation.status).toBe('pending')

    // The acceptance's exact-print case: 0.125 reads "0.125", not "0.13".
    const response = await case2(operation)
    expect(stopNotices(response)[0]).toMatch(/the shank would come within 0\.125 mm of the part/)
  })

  it('an operation carrying a value shows it; a negative draft clamps to 0', async () => {
    seedPanelOperation({ side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false, clearanceAllowanceMm: 0.5 })
    render(<PropertiesPanel />)
    expect(shankClearanceInput('props-shank-clearance').value).toBe('0.5')

    typeInto(shankClearanceInput('props-shank-clearance'), '-1')
    expect(clearanceAllowanceMmOf(savedOperation().params)).toBe(0)
  })

  it('a 3D operation does not show the field', () => {
    const op3d = {
      id: 'op-3d', name: '3D Rough 1', type: 'adaptive_3d', toolId: 'tool-flat',
      enabled: true, status: 'ready', geometrySelections: [],
      passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      linking: {},
      heights: {
        clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
        feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
        bottomHeight: -5, bottomHeightMode: 'absolute',
      },
      params: {
        maxStepdown: 3, stepover: 0.4, tolerance: 0.05, helixDiameter: 3,
        radialStockToLeave: 0, axialStockToLeave: 0, cellSize: 0, useStockBoundary: false,
      },
    } as unknown as Operation
    const setup = {
      id: 'setup-1', name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } }, operations: [op3d],
    } as unknown as Setup
    useCamStore.setState((s) => ({
      toolLibrary: [endMill],
      project: {
        ...s.project, setups: [setup],
        activeSetupId: 'setup-1', activeOperationId: 'op-3d',
      },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('props-shank-clearance')).toBeNull()
  })
})
