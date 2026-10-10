// @vitest-environment jsdom
//
// WO-1544 - Operator ruling 2026-09-14: "How am I supposed to be able to override heights
// now for operations? they are greyed out and you don't let me type into the
// field or select the references." The Top/Bottom Height rows of every
// operation that owns its primary planes were disabled. This drives the real
// dialog: type a Bottom Height in the row, see it read User Override, return
// the row to Smart and see the Smart value come back, type it again, save, and
// prove the saved operation cuts to that height. The planar engines run for
// real (the toolpath worker module executes in-process); Adaptive 3D's engine
// needs WASM, so its leg resolves the saved authority through the exact
// function the store hands to that engine.

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
  resolveAdaptive3dSmartHeights,
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

const authority = (plane: 'top' | 'bottom') =>
  screen.getByTestId(`standard-height-${plane}-authority`).textContent

function expandRow(plane: 'top' | 'bottom'): void {
  if (screen.getByTestId(`standard-height-${plane}`).getAttribute('data-expanded') === 'true') return
  fireEvent.click(within(screen.getByTestId(`standard-height-${plane}`)).getByRole('button'))
}

function typeRowHeight(plane: 'top' | 'bottom', value: number): void {
  expandRow(plane)
  const operator = screen.getByTestId(`standard-height-${plane}-operator-control`) as HTMLSelectElement
  expect(operator.disabled).toBe(false)
  const input = screen.getByTestId(`standard-height-${plane}-offset-control`)
    .querySelector('input') as HTMLInputElement
  expect(input.disabled).toBe(false)
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
}

function chooseSmart(plane: 'top' | 'bottom'): void {
  expandRow(plane)
  const source = screen.getByTestId(`standard-height-${plane}-source-control`) as HTMLSelectElement
  expect(source.disabled).toBe(false)
  fireEvent.change(source, { target: { value: '__smart_policy__' } })
}

/** Type a Bottom Height, see it stick, return to Smart, type it again. */
async function overrideBottomRoundTrip(value: number, smartValue: number | undefined): Promise<void> {
  fireEvent.click(screen.getByText('Heights'))
  if (smartValue !== undefined) {
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(smartValue, 3))
    expect(authority('bottom')).toBe('Smart')
  }
  typeRowHeight('bottom', value)
  await waitFor(() => {
    expect(authority('bottom')).toBe('User Override')
    expect(rowNumber('bottom')).toBeCloseTo(value, 3)
  })
  chooseSmart('bottom')
  await waitFor(() => expect(authority('bottom')).toBe('Smart'))
  if (smartValue !== undefined) {
    await waitFor(() => expect(rowNumber('bottom')).toBeCloseTo(smartValue, 3))
  }
  typeRowHeight('bottom', value)
  await waitFor(() => {
    expect(authority('bottom')).toBe('User Override')
    expect(rowNumber('bottom')).toBeCloseTo(value, 3)
  })
}

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

function savedBottomIsUserOverride(operation: Operation): void {
  const validated = validatePersistedSmartHeightState(operation.smartHeight)
  expect(validated.ok).toBe(true)
  if (!validated.ok) return
  const intent = validated.state.intent
  const overridden = intent.planeOverrides?.bottom?.owner.kind === 'user_override' ||
    intent.machining.end.owner.kind === 'user_override'
  expect(overridden).toBe(true)
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

describe('WO-1544 operation Top/Bottom Height rows take a typed override', () => {
  it('Pocket: a typed Bottom Height is the deepest cut; Smart returns the geometry floor', async () => {
    seed([pocketTarget], [endMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Pocket'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('pocket-geometry-smart-height'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: pocketTarget.id } })
    fireEvent.click(await screen.findByText('All loops (1)'))

    await overrideBottomRoundTrip(5, 8)
    // Pocket's own end controls hold the same number: an absolute WCS Z of 5.
    expect((screen.getByTestId('end-condition-control').querySelector('select') as HTMLSelectElement).value)
      .toBe('custom')
    expect(screen.getByText('Z (WCS)')).not.toBeNull()
    const { operation, deepestCutZ } = await createAndCompute()

    savedBottomIsUserOverride(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(5, 3)
    expect(deepestCutZ).toBeCloseTo(5 + (operation.passes.floorStockToLeave ?? 0), 3)
  })

  it('Contour: a typed Bottom Height is the deepest cut; Smart returns the detected floor', async () => {
    seed([contourPart], [endMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(endMill.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: contourPart.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))

    await overrideBottomRoundTrip(2, 4)
    // The explicit mode lower in the panel holds the same number.
    expect((screen.getByTestId('contour-height-mode') as HTMLSelectElement).value).toBe('explicit_depth')
    const { operation, deepestCutZ } = await createAndCompute()

    savedBottomIsUserOverride(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(2, 3)
    expect(deepestCutZ).toBeCloseTo(2, 3)
  })

  it('Face: a typed Bottom Height is the finished face and the explicit plane shows it', async () => {
    seed([], [faceMill])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(faceMill.name))

    // Face's Smart end is a picked model face: until one is picked it has no
    // number to show, so the round trip checks the row's authority only.
    await overrideBottomRoundTrip(17, undefined)
    expect(screen.getByTestId('standard-height-bottom-source').textContent).toContain('WCS Z')
    const explicit = screen.getByTestId('face-explicit-target').querySelector('input') as HTMLInputElement
    expect(Number(explicit.value)).toBeCloseTo(17, 3)
    const { operation, deepestCutZ } = await createAndCompute()

    savedBottomIsUserOverride(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(17, 3)
    expect(deepestCutZ).toBeCloseTo(17 + (operation.passes.floorStockToLeave ?? 0), 3)
  })

  it('Drill: a typed Bottom Height is the drill depth; Smart returns the detected floor', async () => {
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
    // The Smart floor is the detected hole floor (4); WO-2678: the hole is blind,
    // so the tip stops at the floor with no drill-point allowance below it.
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(authority('bottom')).toBe('Smart')
    const smartBottom = rowNumber('bottom')
    expect(smartBottom).toBeCloseTo(4, 3)
    await overrideBottomRoundTrip(1, smartBottom)
    const { operation, deepestCutZ } = await createAndCompute()

    savedBottomIsUserOverride(operation)
    expect(operation.resolvedHeights?.wcs.bottom).toBeCloseTo(1, 3)
    expect(deepestCutZ).toBeCloseTo(1, 3)
  })

  it('Adaptive 3D: a typed Bottom Height is the band handed to the 3D engine', async () => {
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

    await overrideBottomRoundTrip(3, 0)
    expect((screen.getByTestId('adaptive3d-material-source') as HTMLSelectElement).value).toBe('bounded_band')
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)

    const operation = savedOperation()
    savedBottomIsUserOverride(operation)
    const validated = validatePersistedSmartHeightState(operation.smartHeight)
    if (!validated.ok) throw new Error(validated.message)
    const resolved = resolveAdaptive3dSmartHeights({
      intent: validated.state.intent,
      evidence: evidence(operation.id),
      geometryIds: [solid.id],
      geometryPositionZ: 0,
    })
    expect(resolved.plan.machining.cutterCenterEnd?.owner.kind).toBe('user_override')
    expect(resolved.localHeights.bottomZ).toBeCloseTo(3, 3)
    // Material Start stayed the Smart current-material top.
    expect(resolved.localHeights.topZ).toBeCloseTo(20, 3)
  })
})
