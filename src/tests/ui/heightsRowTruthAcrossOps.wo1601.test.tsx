// @vitest-environment jsdom
//
// WO-1601 - the Heights tab of Contour, Face, Drill/Bore and Adaptive 3D says one
// thing. A Height row reference ("Stock bottom + 1.35") owns its plane; the
// policy selector lower on the tab names that value instead of its own stale
// preset, the fields it overrides are not shown, and choosing a policy there
// replaces the row value in the open (seeded from what was in effect, logged to
// the console). Pocket and Adaptive Clearing show no "Top of stock (Z)" field,
// which their Smart plan never read. Fixtures are WO-1544's; the planar engines
// run for real through the in-process toolpath worker.

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

// The production toolpath worker, run in this thread. Its module assigns
// self.onmessage and answers through self.postMessage.
// Vite builds the store's worker URL from self.location, so the scope keeps it.
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
const {
  buildAdaptive3dEvidenceContext,
  resolveSmartHeightPlan,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')

afterAll(() => { vi.stubGlobal('self', realSelf) })

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
const faceMill = {
  id: 'tool-face', name: 'Face mill 12mm', type: 'flat_end_mill', diameter: 12,
  fluteLength: 25, shankDiameter: 12, overallLength: 60, numberOfFlutes: 3,
} as unknown as Tool
const drill = {
  id: 'tool-drill', name: '6 mm Drill', type: 'drill', diameter: 6,
  fluteLength: 30, shankDiameter: 6, overallLength: 70, numberOfFlutes: 2,
  angleFromAxisDeg: 59, tipDiameter: 0,
} as unknown as Tool

const bbox = (maxX: number, maxY: number, maxZ: number) => ({
  min: { x: 0, y: 0, z: 0 }, max: { x: maxX, y: maxY, z: maxZ },
  size: { x: maxX, y: maxY, z: maxZ }, center: { x: maxX / 2, y: maxY / 2, z: maxZ / 2 },
})

const pocketTarget = {
  id: 'pocket-part', name: 'Pocket.step', filename: 'Pocket.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id, assignedStockId: stock.id,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(90, 70, 12),
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

const contourPart = {
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

const drillPart = {
  id: 'drill-part', name: 'Hole.step', filename: 'Hole.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
  loops: [{
    id: 'hole-1', layerId: 'holes', closed: true, type: 'contour', area: 28,
    points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
  }],
  layers2d: [{
    id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
    holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 4, through: false, loopId: 'hole-1' }],
  }],
} as unknown as ImportedGeometry

const solid = {
  id: 'solid-1', name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
} as unknown as ImportedGeometry

function seed(geometry: ImportedGeometry[], tools: Tool[]): void {
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
    toolLibrary: tools,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      stocks: [stock], geometry,
    },
  } as never)
}

function savedOperation(): Operation {
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

function rowNumber(plane: 'top' | 'bottom'): number {
  const text = screen.getByTestId(`standard-height-${plane}-resolved`).textContent ?? ''
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}

function expandRow(plane: 'top' | 'bottom'): void {
  if (screen.getByTestId(`standard-height-${plane}`).getAttribute('data-expanded') === 'true') return
  fireEvent.click(within(screen.getByTestId(`standard-height-${plane}`)).getByRole('button'))
}

const HELD = '__height_row__'

/** The row alone: pick a reference, then type the offset. */
function setRow(plane: 'top' | 'bottom', reference: string, value: number): void {
  expandRow(plane)
  fireEvent.change(screen.getByTestId(`standard-height-${plane}-source-control`), { target: { value: reference } })
  const input = screen.getByTestId(`standard-height-${plane}-offset-control`).querySelector('input') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
  // The sign after the magnitude: a sign flip of a zero offset is a no-op.
  const operator = screen.getByTestId(`standard-height-${plane}-operator-control`) as HTMLSelectElement
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
}

const rowWords = (plane: 'top' | 'bottom') => screen.getByTestId(`standard-height-${plane}-source`).textContent ?? ''
const policy = (testId: string) => screen.getByTestId(testId) as HTMLSelectElement
const shownPolicy = (testId: string) => {
  const select = policy(testId)
  return select.options[select.selectedIndex]?.text ?? ''
}
const fieldInput = (label: string) =>
  (screen.getByText(label).closest('.op-field-row') ?? screen.getByText(label).parentElement!.parentElement!)
    .querySelector('input') as HTMLInputElement
const fieldValue = (label: string) => Number(fieldInput(label).value)
const lastConsoleMessage = () => useCamStore.getState().consoleEvents.at(-1)?.message ?? ''

async function createAndCompute(): Promise<{ operation: Operation; deepestCutZ: number }> {
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  // A refusal names itself in the height preflight; show it if Create stays off.
  await waitFor(() => expect(
    create.disabled,
    `Create disabled; top row ${rowNumber('top')}; fields ${
      Array.from(screen.getByTestId('operation-height-policy-controls').querySelectorAll('input'))
        .map(input => input.value).join('/')
    }; height preflight: ${screen.getByTestId('operation-height-policy-controls').textContent}`,
  ).toBe(false))
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

describe('WO-1601 the lower height policy never shows a value that is not in effect', () => {
  it('Contour: the row reference is what Target End shows; choosing Explicit keeps the depth and says so', async () => {
    seed([contourPart], [endMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: contourPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(4, 3))
    // A preset chosen below first, so the lower draft differs from the row.
    fireEvent.change(policy('contour-height-mode'), { target: { value: 'through_stock' } })

    setRow('bottom', 'stock_bottom', 1.35)
    await waitFor(() => {
      expect(rowWords('bottom')).toBe('Stock bottom + 1.350 mm')
      expect(rowNumber('bottom')).toBeCloseTo(1.35, 3)
      expect(policy('contour-height-mode').value).toBe(HELD)
    })
    expect(shownPolicy('contour-height-mode')).toBe('Bottom Height row: Stock bottom + 1.350 mm')
    expect(screen.queryByText('Past stock bottom')).toBeNull()

    fireEvent.change(policy('contour-height-mode'), { target: { value: 'explicit_depth' } })
    await waitFor(() => {
      expect(policy('contour-height-mode').value).toBe('explicit_depth')
      expect(fieldValue('Target End (WCS)')).toBeCloseTo(1.35, 3)
      expect(rowNumber('bottom')).toBeCloseTo(1.35, 3)
    })
    expect(lastConsoleMessage()).toBe('Bottom Height Stock bottom + 1.350 mm replaced by Target End: Explicit WCS Z.')

    const { operation, deepestCutZ } = await createAndCompute()
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(1.35, 3)
    expect(deepestCutZ).toBeCloseTo(1.35, 3)
  }, 40000)

  it('Face: a row reference is the finished face - nothing left to confirm, and it cuts there', async () => {
    seed([], [faceMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(faceMill.name))
    fireEvent.click(screen.getByText('Heights'))

    setRow('bottom', 'stock_bottom', 19)
    await waitFor(() => {
      expect(rowWords('bottom')).toBe('Stock bottom + 19.000 mm')
      expect(policy('face-height-mode').value).toBe(HELD)
      expect(rowNumber('bottom')).toBeCloseTo(19, 3)
    })
    expect(shownPolicy('face-height-mode')).toBe('Bottom Height row: Stock bottom + 19.000 mm')
    expect(screen.queryByTestId('face-height-unconfirmed')).toBeNull()
    expect(screen.queryByTestId('pick-face-target')).toBeNull()

    const { operation, deepestCutZ } = await createAndCompute()
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(19, 3)
    expect(deepestCutZ).toBeCloseTo(19 + (operation.passes.floorStockToLeave ?? 0), 3)
  }, 40000)

  it('Drill: a Top row reference is named per plane; choosing Explicit seeds both fields from what was in effect', async () => {
    seed([drillPart], [drill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Drill'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(drill.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: drillPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    const smartBottom = rowNumber('bottom')

    setRow('top', 'stock_top', -2)
    await waitFor(() => {
      expect(rowWords('top')).toBe('Stock top - 2.000 mm')
      expect(rowNumber('top')).toBeCloseTo(18, 3)
      expect(policy('drill-bore-height-mode').value).toBe(HELD)
    })
    expect(shownPolicy('drill-bore-height-mode')).toBe('Top Height row: Stock top - 2.000 mm')
    // The bottom is still the detected floor, so its breakthrough stays editable.
    expect(screen.getByText('Breakthrough past floor')).not.toBeNull()

    fireEvent.change(policy('drill-bore-height-mode'), { target: { value: 'explicit_depth' } })
    await waitFor(() => {
      expect(policy('drill-bore-height-mode').value).toBe('explicit_depth')
      expect(fieldValue('Material Start (WCS)')).toBeCloseTo(18, 3)
      expect(fieldValue('Target End (WCS)')).toBeCloseTo(smartBottom, 3)
      expect(rowNumber('top')).toBeCloseTo(18, 3)
    })
    expect(lastConsoleMessage()).toBe(
      'Top Height Stock top - 2.000 mm replaced by Depth policy: Explicit Material Start and Target End.')

    // Both rows as references: neither explicit field is in effect, so neither shows.
    setRow('top', 'stock_top', -1)
    setRow('bottom', 'stock_bottom', 5)
    await waitFor(() => {
      expect(rowNumber('top')).toBeCloseTo(19, 3)
      expect(rowNumber('bottom')).toBeCloseTo(5, 3)
      expect(policy('drill-bore-height-mode').value).toBe(HELD)
    })
    expect(shownPolicy('drill-bore-height-mode')).toBe('Height rows: Stock top - 1.000 mm to Stock bottom + 5.000 mm')
    expect(screen.queryByText('Material Start (WCS)')).toBeNull()
    expect(screen.queryByText('Target End (WCS)')).toBeNull()
    fireEvent.change(policy('drill-bore-height-mode'), { target: { value: 'detected_features' } })
    await waitFor(() => expect(policy('drill-bore-height-mode').value).toBe('detected_features'))
    expect(lastConsoleMessage()).toBe(
      'Top Height Stock top - 1.000 mm and Bottom Height Stock bottom + 5.000 mm replaced by Depth policy: Detected physical floors (recommended).')
  }, 40000)

  async function openAdaptive3dHeights(): Promise<void> {
    const evidence = (operationId: string) => buildAdaptive3dEvidenceContext({
      revision: { projectRevision: 'p', setupRevision: 's', operationRevision: `o-${operationId}` },
      wcsOriginMachineMm: 0,
      operationId,
      geometryIds: [solid.id],
      owningStocks: [{
        stockId: stock.id, artifactId: 'stock-box', representation: 'box', fingerprint: 'stock-fp',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 80, maxZ: 20 },
      }],
      target: {
        geometryId: solid.id, artifactId: 'widget-mesh', representation: 'mesh', fingerprint: 'widget-fp',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 10 },
      },
      tool: { toolId: endMill.id, fingerprint: 'tool-fp' },
      axialStockToLeaveMm: 0,
    })
    seed([solid], [endMill])
    useCamStore.setState({
      computeOperationToolpath: vi.fn(),
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => {
        const validated = validatePersistedSmartHeightState(operation.smartHeight)
        if (!validated.ok) throw new Error(validated.message)
        const result = resolveSmartHeightPlan(validated.state.intent, evidence(operation.id))
        if (!result.ok) throw new Error(result.refusal.message)
        return result.plan
      }),
    } as never)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(rowNumber('top')).toBeCloseTo(20, 3))
  }

  it('Adaptive 3D: a Bottom row leaves Material source naming where cutting starts', async () => {
    await openAdaptive3dHeights()
    setRow('bottom', 'stock_bottom', 3)
    await waitFor(() => {
      expect(rowWords('bottom')).toBe('Stock bottom + 3.000 mm')
      expect(rowNumber('bottom')).toBeCloseTo(3, 3)
    })
    // Material source sets only the top; the Bottom Height row already states the bottom.
    expect(policy('adaptive3d-material-source').value).toBe('current_material')
    expect(shownPolicy('adaptive3d-material-source')).toBe('Current material (recommended)')
    expect(Array.from(policy('adaptive3d-material-source').options).map(option => option.value)).not.toContain(HELD)

    // Changing where cutting starts leaves the bottom row alone.
    fireEvent.change(policy('adaptive3d-material-source'), { target: { value: 'initial_stock' } })
    await waitFor(() => expect(policy('adaptive3d-material-source').value).toBe('initial_stock'))
    expect(rowWords('bottom')).toBe('Stock bottom + 3.000 mm')
    expect(rowNumber('bottom')).toBeCloseTo(3, 3)
  }, 40000)

  it('Adaptive 3D: a Top row replaces where cutting starts, so Material source names it', async () => {
    await openAdaptive3dHeights()
    setRow('top', 'stock_top', -2)
    await waitFor(() => {
      expect(rowWords('top')).toBe('Stock top - 2.000 mm')
      expect(policy('adaptive3d-material-source').value).toBe(HELD)
    })
    expect(shownPolicy('adaptive3d-material-source')).toBe('Top Height row: Stock top - 2.000 mm')

    setRow('bottom', 'stock_bottom', 3)
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(3, 3))
    expect(policy('adaptive3d-material-source').value).toBe(HELD)
    expect(shownPolicy('adaptive3d-material-source')).toBe('Height rows: Stock top - 2.000 mm to Stock bottom + 3.000 mm')
  }, 40000)

  it('Adaptive 3D: a Bottom row reference hides the stale band field; choosing the band seeds it', async () => {
    await openAdaptive3dHeights()
    setRow('bottom', 'stock_bottom', 3)
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(3, 3))

    // The band, chosen over the row, starts at what was in effect for both planes.
    fireEvent.change(policy('adaptive3d-material-source'), { target: { value: 'bounded_band' } })
    await waitFor(() => {
      expect(policy('adaptive3d-material-source').value).toBe('bounded_band')
      expect(fieldValue('Band top (WCS)')).toBeCloseTo(20, 3)
      expect(fieldValue('Band bottom (WCS)')).toBeCloseTo(3, 3)
      expect(rowNumber('bottom')).toBeCloseTo(3, 3)
    })

    // A row reference over the band hides only the band field it replaces.
    setRow('bottom', 'stock_bottom', 4)
    await waitFor(() => {
      expect(rowNumber('bottom')).toBeCloseTo(4, 3)
      expect(policy('adaptive3d-material-source').value).toBe(HELD)
    })
    expect(shownPolicy('adaptive3d-material-source')).toBe('Bottom Height row: Stock bottom + 4.000 mm')
    expect(screen.queryByText('Band bottom (WCS)')).toBeNull()
    expect(screen.getByText('Band top (WCS)')).not.toBeNull()
    fireEvent.change(policy('adaptive3d-material-source'), { target: { value: 'bounded_band' } })
    await waitFor(() => expect(fieldValue('Band bottom (WCS)')).toBeCloseTo(4, 3))
    expect(lastConsoleMessage()).toBe(
      'Bottom Height Stock bottom + 4.000 mm replaced by Material source: Explicit WCS band.')
  }, 40000)

  it('Pocket and Adaptive Clearing show no Top of stock field their Smart plan never read', async () => {
    seed([pocketTarget], [endMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Pocket'))
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.getByTestId('standard-height-top')).not.toBeNull()
    expect(screen.queryByText('Top of stock (Z)')).toBeNull()
    fireEvent.click(screen.getByText('Type & Name'))
    fireEvent.click(screen.getByText('2D Adaptive Clearing'))
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.getByTestId('standard-height-top')).not.toBeNull()
    expect(screen.queryByText('Top of stock (Z)')).toBeNull()
  })
})

