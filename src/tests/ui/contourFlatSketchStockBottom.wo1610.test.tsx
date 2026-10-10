// @vitest-environment jsdom
//
// WO-1610 (finding SH-1) - a Contour around a flat sketch lying on the table
// cuts to the stock instead of refusing. A picked flat loop has no physical
// floor, so it is not a "selected feature": the dialog opens it on the
// Contour's stock-based Target End, the Heights Bottom row shows the number the
// moves use, and the Bottom row override (stock bottom + 1.35) cuts exactly
// there. A loop that does carry a floor (a model boss) still opens on the
// selected feature. The planar engine runs for real through the in-process
// toolpath worker (WO-1601's harness).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool, ToolpathMove } from '../../types'
import { typedMock } from '../support/typedMock'

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

const { deriveCylinders } = vi.hoisted(() => ({ deriveCylinders: vi.fn().mockResolvedValue([]) }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
  deriveCylinders,
}))

// The production toolpath worker, run in this thread.
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
const { useCamStore } = await import('../../store')

afterAll(() => { vi.stubGlobal('self', realSelf) })

// Stock 0..20 in Z; the WCS sits on the stock's bottom corner, so stock bottom = WCS 0.
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

const bbox = (maxX: number, maxY: number, maxZ: number) => ({
  min: { x: 0, y: 0, z: 0 }, max: { x: maxX, y: maxY, z: maxZ },
  size: { x: maxX, y: maxY, z: maxZ }, center: { x: maxX / 2, y: maxY / 2, z: maxZ / 2 },
})

/** A flat DXF sketch lying on the table: one outline loop, no floor evidence. */
const flatSketch = {
  id: 'sketch', name: 'Sketch', filename: 'Sketch.dxf', type: 'curves_2d', format: 'dxf',
  loaded: true, stockId: stock.id, loopsVersion: 1,
  position: { x: 20, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(60, 40, 0),
  loops: [{
    id: 'outline', layerId: 'layer-0', closed: true, type: 'contour', area: 2400,
    points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
  }],
  layers2d: [{ id: 'layer-0', name: '0', color: '#fff', visible: true }],
} as unknown as ImportedGeometry

/** A model boss: the loop carries a physical floor (WCS 4). */
const bossPart = {
  id: 'contour-part', name: 'Boss.step', filename: 'Boss.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id, loopsVersion: 2,
  position: { x: 30, y: 30, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
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

function seed(geometry: ImportedGeometry[]): void {
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
      stocks: [stock], geometry,
    },
  } as never)
}

function rowNumber(plane: 'top' | 'bottom'): number {
  const text = screen.getByTestId(`standard-height-${plane}-resolved`).textContent ?? ''
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

function setBottomRow(reference: string, value: number): void {
  if (screen.getByTestId('standard-height-bottom').getAttribute('data-expanded') !== 'true') {
    fireEvent.click(within(screen.getByTestId('standard-height-bottom')).getByRole('button'))
  }
  fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), { target: { value: reference } })
  const input = screen.getByTestId('standard-height-bottom-offset-control').querySelector('input') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
  // The sign after the magnitude: a sign flip of a zero offset is a no-op.
  const operator = screen.getByTestId('standard-height-bottom-operator-control') as HTMLSelectElement
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
}

const mode = () => (screen.getByTestId('contour-height-mode') as HTMLSelectElement).value

function openContourOn(geometryId: string): void {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(endMill.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: geometryId } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
}

async function createAndCompute(): Promise<{ operation: Operation; deepestCutZ: number }> {
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  await waitFor(() => expect(
    create.disabled,
    `Create disabled; height preflight: ${screen.getByTestId('operation-height-policy-controls').textContent}`,
  ).toBe(false))
  fireEvent.click(create)
  await waitFor(() => {
    const operation = useCamStore.getState().project.setups[0].operations.at(-1)!
    expect(operation.errorMessage ?? '').toBe('')
    expect(operation.toolpathMoves?.length ?? 0).toBeGreaterThan(0)
  }, { timeout: 20000 })
  const operation = useCamStore.getState().project.setups[0].operations.at(-1)!
  const cutting = (operation.toolpathMoves as ToolpathMove[]).filter(move => move.type !== 'rapid')
  return { operation, deepestCutZ: Math.min(...cutting.map(move => move.z)) }
}

beforeEach(() => {
  deriveCylinders.mockClear()
  ;(globalThis as { Worker?: unknown }).Worker = InProcessToolpathWorker
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } }),
  }
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-1610 a Contour around a flat sketch cuts to the stock', () => {
  it('opens on Stock bottom, the Bottom row shows it, and the moves cut there', async () => {
    seed([flatSketch])
    openContourOn(flatSketch.id)
    await waitFor(() => expect(mode()).toBe('stock_bottom'))
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(0, 3))
    expect(screen.queryByText(/Target End selector/)).toBeNull()

    const { operation, deepestCutZ } = await createAndCompute()
    expect(operation.smartHeight).toMatchObject({
      kind: 'smart_v2', intent: { policy: { operationType: 'contour_2d', variant: 'stock_bottom' } },
    })
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(0, 3)
    expect(deepestCutZ).toBeCloseTo(0, 3)
  }, 40000)

  it('the Bottom row override (stock bottom + 1.35) cuts exactly there', async () => {
    seed([flatSketch])
    openContourOn(flatSketch.id)
    await waitFor(() => expect(mode()).toBe('stock_bottom'))
    setBottomRow('stock_bottom', 1.35)
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(1.35, 3))

    const { operation, deepestCutZ } = await createAndCompute()
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(1.35, 3)
    expect(deepestCutZ).toBeCloseTo(1.35, 3)
  }, 40000)

  it('a model boss loop still opens on the selected feature floor', async () => {
    seed([bossPart])
    openContourOn(bossPart.id)
    await waitFor(() => expect(mode()).toBe('selected_feature'))
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(4, 3))
  }, 40000)
  it('with no stock at all it says what it needs in one plain sentence', async () => {
    seed([flatSketch])
    act(() => useCamStore.setState(state => ({
      project: {
        ...state.project,
        stocks: [],
        geometry: state.project.geometry.map(geometry => ({ ...geometry, stockId: undefined })),
        setups: state.project.setups.map(setup => ({
          ...setup, wcs: { ...setup.wcs, stockId: undefined, originBinding: undefined },
        })),
      },
    }) as never))
    delete (window as unknown as Record<string, unknown>).__cncViewport
    openContourOn(flatSketch.id)
    await waitFor(() => expect(screen.getByTestId('resolved-height-refusal').textContent)
      .toContain('This Contour needs a stock in its Setup: add one so it knows where the material is.'))
    const refusal = screen.getByTestId('resolved-height-refusal').textContent ?? ''
    expect(refusal).not.toMatch(/Target End selector|Repair:|cannot prove/)
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  }, 40000)
})
