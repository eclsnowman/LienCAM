// @vitest-environment jsdom
//
// WO-1599 - Operator ruling 2026-09-16: "for our heights tab, do we not have a bunch of
// conflicting conditions? ... If I wanted to cut 1.35mm above the stock bottom
// how would I do this without conflicts." His Bottom Height row read
// "Stock bottom + 1.350 mm | WCS -5.000 mm | User Override" while End condition
// below it still said "Depth from stock top 5". A geometry-bound 2D Pocket now
// has ONE bottom of cut: the row, End condition and the custom reference fields
// are views of the same state, the row's words and number come from one
// resolution, and the toolpath cuts to the plane the row states. The dialog,
// store preview and planar toolpath worker all run for real (the worker module
// executes in-process).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool, ToolpathMove } from '../../types'
import type { PrismaticRoughTargetFacts } from '../../lib/cam/geometry/occt/model/types'
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

const { derivePrismaticRoughTarget, deriveCylinders } = vi.hoisted(() => ({
  derivePrismaticRoughTarget: vi.fn<(geoId: string) => Promise<PrismaticRoughTargetFacts>>(),
  deriveCylinders: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
  derivePrismaticRoughTarget,
  deriveCylinders,
}))

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
const { validatePersistedSmartHeightState, withOperatorPlaneOverrides } = await import('../../lib/cam/smartHeights')

afterAll(() => { vi.stubGlobal('self', realSelf) })

// Stock top WCS 20, stock bottom WCS 0.
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

const pocketTarget = {
  id: 'pocket-part', name: 'Pocket.step', filename: 'Pocket.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id, assignedStockId: stock.id,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 90, y: 70, z: 12 },
    size: { x: 90, y: 70, z: 12 }, center: { x: 45, y: 35, z: 6 },
  },
  loops: [{
    id: 'floor-loop', layerId: 'floor-layer', closed: true, type: 'contour', area: 1600,
    points: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }],
  }],
  layers2d: [{
    id: 'floor-layer', name: 'Floor', color: '#00e5ff', visible: true,
    projectionPlane: {
      origin: { x: 0, y: 0, z: 8 }, normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
    },
  }],
} as unknown as ImportedGeometry

function seed(operations: Operation[] = []): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations,
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
      stocks: [stock], geometry: [pocketTarget],
    },
  } as never)
}

const savedOperation = (): Operation => useCamStore.getState().project.setups[0].operations.at(-1)!

function rowNumber(): number {
  const text = screen.getByTestId('standard-height-bottom-resolved').textContent ?? ''
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}
const rowWords = () => screen.getByTestId('standard-height-bottom-source').textContent ?? ''
const authority = () => screen.getByTestId('standard-height-bottom-authority').textContent
const endSelect = () => screen.getByTestId('end-condition-control').querySelector('select') as HTMLSelectElement

function expandBottomRow(): void {
  if (screen.getByTestId('standard-height-bottom').getAttribute('data-expanded') === 'true') return
  fireEvent.click(within(screen.getByTestId('standard-height-bottom')).getByRole('button'))
}

/** The row alone: pick a reference, then type the offset. */
function setBottomRow(reference: string, value: number): void {
  expandBottomRow()
  fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), { target: { value: reference } })
  const operator = screen.getByTestId('standard-height-bottom-operator-control') as HTMLSelectElement
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
  const input = screen.getByTestId('standard-height-bottom-offset-control').querySelector('input') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
}

async function openGeometryPocket(): Promise<void> {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('2D Pocket'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(endMill.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.click(screen.getByTestId('pocket-geometry-smart-height'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: pocketTarget.id } })
  fireEvent.click(await screen.findByText('All loops (1)'))
  fireEvent.click(screen.getByText('Heights'))
  // The Smart default: the selected geometry floor.
  await waitFor(() => expect(rowNumber()).toBeCloseTo(8, 3))
  expect(authority()).toBe('Smart')
  expandBottomRow()
}

/** One statement of the bottom of cut, read from every surface that shows it. */
async function expectOneBottom(words: string, wcs: number, endCondition: string): Promise<void> {
  await waitFor(() => {
    expect(rowWords()).toBe(words)
    expect(rowNumber()).toBeCloseTo(wcs, 3)
    expect(authority()).toBe('User Override')
    expect(endSelect().value).toBe(endCondition)
  })
  // The reference/offset fields are the Custom preset's, not a second control.
  expect(screen.queryByText('Z offset from plane')).toBeNull()
}

async function createAndCompute(): Promise<{ operation: Operation; deepestCutZ: number }> {
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  await waitFor(() => expect(create.disabled).toBe(false))
  fireEvent.click(create)
  await waitFor(() => {
    const operation = savedOperation()
    expect(operation.errorMessage ?? '').toBe('')
    expect(operation.toolpathMoves?.length ?? 0).toBeGreaterThan(0)
  }, { timeout: 20000 })
  const operation = savedOperation()
  const cutting = (operation.toolpathMoves as ToolpathMove[]).filter(move => move.type !== 'rapid')
  return { operation, deepestCutZ: Math.min(...cutting.map(move => move.z)) }
}

function savedCarriesNoSecondBottom(operation: Operation): void {
  const validated = validatePersistedSmartHeightState(operation.smartHeight)
  expect(validated.ok).toBe(true)
  if (validated.ok) expect(validated.state.intent.planeOverrides?.bottom).toBeUndefined()
}

beforeEach(() => {
  derivePrismaticRoughTarget.mockReset()
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

describe('WO-1599 one control owns the bottom of cut', () => {
  it("Operator's case: 'Stock bottom + 1.35' typed in the row is what End condition shows and what the tool cuts", async () => {
    seed()
    await openGeometryPocket()
    // The state Operator was in: an explicit depth set further down the tab first.
    fireEvent.change(endSelect(), { target: { value: 'depth_from_top' } })
    await expectOneBottom('Stock top - 5.000 mm', 15, 'depth_from_top')

    setBottomRow('stock_bottom', 1.35)
    await expectOneBottom('Stock bottom + 1.350 mm', 1.35, 'stop_above_bottom')
    const left = screen.getByText('Material left above bottom').parentElement?.querySelector('input') as HTMLInputElement
    expect(Number(left.value)).toBeCloseTo(1.35, 3)

    const { operation, deepestCutZ } = await createAndCompute()
    savedCarriesNoSecondBottom(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(1.35, 3)
    expect(deepestCutZ).toBeCloseTo(1.35 + (operation.passes.floorStockToLeave ?? 0), 3)
  }, 40000)

  it('End condition edited after the row replaces the row value in the row too, and cuts there', async () => {
    seed()
    await openGeometryPocket()
    setBottomRow('stock_bottom', 1.35)
    await expectOneBottom('Stock bottom + 1.350 mm', 1.35, 'stop_above_bottom')

    // Depth from stock top on a 20 mm stock is WCS 15, not the legacy -5.
    fireEvent.change(endSelect(), { target: { value: 'depth_from_top' } })
    await expectOneBottom('Stock top - 5.000 mm', 15, 'depth_from_top')

    const { operation, deepestCutZ } = await createAndCompute()
    savedCarriesNoSecondBottom(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(15, 3)
    expect(deepestCutZ).toBeCloseTo(15 + (operation.passes.floorStockToLeave ?? 0), 3)
  }, 40000)

  it('Smart in the row returns End condition to the geometry floor', async () => {
    seed()
    await openGeometryPocket()
    setBottomRow('stock_bottom', 1.35)
    await expectOneBottom('Stock bottom + 1.350 mm', 1.35, 'stop_above_bottom')
    fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), {
      target: { value: '__smart_policy__' },
    })
    await waitFor(() => {
      expect(authority()).toBe('Smart')
      expect(rowNumber()).toBeCloseTo(8, 3)
      expect(endSelect().value).toBe('to_geometry')
    })
  }, 40000)

  it('a saved pocket carrying a competing row override reopens as one bottom of cut', async () => {
    seed()
    await openGeometryPocket()
    fireEvent.change(endSelect(), { target: { value: 'depth_from_top' } })
    const { operation } = await createAndCompute()
    cleanup()
    act(() => useCamStore.getState().closeModal())

    // The shape Operator's project was saved in: End condition says 5 mm deep, the
    // row override says 1.35 above stock bottom.
    const legacy = {
      ...operation,
      smartHeight: withOperatorPlaneOverrides(operation.smartHeight, {
        bottom: { reference: 'stock_bottom', offsetMm: 1.35, owner: { kind: 'user_override' } },
      }),
    } as Operation
    act(() => {
      const state = useCamStore.getState()
      const setup = state.project.setups[0]
      useCamStore.setState({
        project: { ...state.project, setups: [{ ...setup, operations: [legacy] }] },
        editingOpPayload: { setupId: setup.id, opId: legacy.id },
      } as never)
    })
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('edit-operation'))
    fireEvent.click(screen.getByText('Heights'))
    expandBottomRow()
    await expectOneBottom('Stock bottom + 1.350 mm', 1.35, 'stop_above_bottom')
  }, 60000)
})
