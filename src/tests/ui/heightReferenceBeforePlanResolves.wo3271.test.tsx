// @vitest-environment jsdom
//
// WO-3271 - a Heights reference picked right after a draft edit keeps its base.
// A changed draft drops the old height preview until the plan re-resolves; a
// reference change made in that window used to find no base for the model Top
// and stored the shown height as the offset (Retract 27 became Top + 27 = 37).
// The row keeps the height in effect before and after the plan resolves.
// Fixtures are WO-1602's.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaticRoughTargetFacts } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'
import type { HeightPlaneName, ImportedGeometry, Operation, PhysicalStock, Setup, Tool } from '../../types'

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
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext,
  buildWaterline3dEvidenceContext,
  resolveSmartHeightPlan,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')

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

const contourPart = {
  id: 'contour-part', name: 'Boss.step', filename: 'Boss.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id,
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

// A 10 mm tall model in 20 mm stock: model Top and Stock top differ by 10.
const solid = {
  id: 'solid-1', name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: bbox(20, 20, 10),
} as unknown as ImportedGeometry

function seed(geometry: ImportedGeometry[], tools: Tool[], withStock = true): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      ...(withStock ? {
        stockId: stock.id,
        originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
      } : {}),
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: tools,
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      stocks: withStock ? [stock] : [], geometry,
    },
  } as never)
}

const rowNumber = (plane: HeightPlaneName): number => {
  const text = screen.getByTestId(`standard-height-${plane}-resolved`).textContent ?? ''
  const match = text.match(/-?\d+(\.\d+)?/)
  return match ? Number(match[0]) : NaN
}
const rowWords = (plane: HeightPlaneName) => screen.getByTestId(`standard-height-${plane}-source`).textContent ?? ''

function expandRow(plane: HeightPlaneName): void {
  if (screen.getByTestId(`standard-height-${plane}`).getAttribute('data-expanded') === 'true') return
  fireEvent.click(within(screen.getByTestId(`standard-height-${plane}`)).getByRole('button'))
}
function setReference(plane: HeightPlaneName, reference: string): void {
  expandRow(plane)
  fireEvent.change(screen.getByTestId(`standard-height-${plane}-source-control`), { target: { value: reference } })
}
function setOffset(plane: HeightPlaneName, value: number): void {
  expandRow(plane)
  const input = screen.getByTestId(`standard-height-${plane}-offset-control`).querySelector('input') as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: String(Math.abs(value)) } })
  fireEvent.blur(input)
  const operator = screen.getByTestId(`standard-height-${plane}-operator-control`) as HTMLSelectElement
  if ((value < 0) !== (operator.value === '-')) {
    fireEvent.change(operator, { target: { value: value < 0 ? '-' : '+' } })
  }
}

type SurfaceFinish = 'parallel_3d' | 'waterline_3d'

/** A surface finish whose plan resolves against real Smart Height evidence,
 * through the same no-stock bind the production resolvers apply. */
async function openSurfaceFinishHeights(type: SurfaceFinish, withStock = true): Promise<void> {
  const evidenceInput = (operationId: string) => ({
    revision: { projectRevision: 'p', setupRevision: 's', operationRevision: `o-${operationId}` },
    wcsOriginMachineMm: 0,
    operationId,
    geometryIds: [solid.id],
    ...(withStock ? {
      owningStock: {
        stockId: stock.id, artifactId: 'stock-box', representation: 'box', fingerprint: 'stock-fp',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 80, maxZ: 20 },
      },
    } : {}),
    target: {
      geometryId: solid.id, artifactId: 'widget-mesh', representation: 'mesh', fingerprint: 'widget-fp',
      boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 10 },
    },
  })
  seed([solid], [endMill], withStock)
  useCamStore.setState({
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => {
      const validated = validatePersistedSmartHeightState(operation.smartHeight)
      if (!validated.ok) throw new Error(validated.message)
      const evidence = type === 'waterline_3d'
        ? buildWaterline3dEvidenceContext(evidenceInput(operation.id))
        : buildParallel3dEvidenceContext(evidenceInput(operation.id))
      const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(validated.state.intent, evidence), evidence)
      if (!result.ok) throw new Error(result.refusal.message)
      return result.plan
    }),
  } as never)
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(type === 'waterline_3d' ? 'Waterline Finish (3D)' : 'Parallel Finish (3D)'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(endMill.name))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(rowNumber('top')).toBeCloseTo(10, 3))
}

afterAll(() => { vi.stubGlobal('self', realSelf) })

const realStoreActions = {
  computeOperationToolpath: useCamStore.getState().computeOperationToolpath,
  previewOperationSmartHeightPlan: useCamStore.getState().previewOperationSmartHeightPlan,
}

beforeEach(() => {
  memory.clear()
  useCamStore.setState(realStoreActions as never)
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


const policy = (testId: string) => screen.getByTestId(testId) as HTMLSelectElement
const fieldValue = (label: string) => Number(
  ((screen.getByText(label).closest('.op-field-row') ?? screen.getByText(label).parentElement!.parentElement!)
    .querySelector('input') as HTMLInputElement).value)
const planResolved = () => screen.queryByTestId('resolved-height-plan') !== null

describe('WO-3271 a Heights reference picked before the plan re-resolves keeps its base', () => {
  it.each(['parallel_3d', 'waterline_3d'] as const)(
    '%s: Retract keeps its height when the reference changes right after a draft edit', async type => {
      await openSurfaceFinishHeights(type)
      await waitFor(() => expect(rowNumber('retract')).toBeCloseTo(25, 3))
      setOffset('retract', 7)
      await waitFor(() => expect(rowNumber('retract')).toBeCloseTo(27, 3))

      // The draft edit dropped the preview; the plan has not re-resolved yet.
      setOffset('feed', 6)
      expect(planResolved()).toBe(false)
      setReference('retract', 'top')
      expect(planResolved()).toBe(false)
      expect(rowNumber('retract')).toBeCloseTo(27, 3)
      expect(rowWords('retract')).toBe('Top + 17.000 mm')

      // Once the plan resolves the row says the same thing.
      await waitFor(() => expect(planResolved()).toBe(true))
      await waitFor(() => {
        expect(rowWords('retract')).toBe('Top + 17.000 mm')
        expect(rowNumber('retract')).toBeCloseTo(27, 3)
      })
    }, 30000)

  it('Contour: the Bottom row keeps its height when Explicit is chosen right after the reference edit', async () => {
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

    setReference('bottom', 'stock_bottom')
    setOffset('bottom', 1.35)
    expect(planResolved()).toBe(false)
    expect(rowWords('bottom')).toBe('Stock bottom + 1.350 mm')
    expect(rowNumber('bottom')).toBeCloseTo(1.35, 3)

    fireEvent.change(policy('contour-height-mode'), { target: { value: 'explicit_depth' } })
    await waitFor(() => {
      expect(policy('contour-height-mode').value).toBe('explicit_depth')
      expect(fieldValue('Target End (WCS)')).toBeCloseTo(1.35, 3)
      expect(rowNumber('bottom')).toBeCloseTo(1.35, 3)
    })
  }, 30000)
})
