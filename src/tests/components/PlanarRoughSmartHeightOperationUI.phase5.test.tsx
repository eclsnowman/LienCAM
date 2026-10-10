// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, PhysicalStock, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const tool = {
  id: 'tool-1', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const resolvedSnapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 8 },
  machine: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 8 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 20.5, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 20, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 8, provenance: 'inferred' as const },
  },
  dependencyIds: [stock.id, 'target-step'],
}

function seed(
  operations: Operation[] = [],
  expectedVariant: 'stock_rough' | 'geometry_floor' | 'through_stock' | 'explicit_depth' = 'stock_rough',
): ReturnType<typeof vi.fn> {
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
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    expect(operation.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: operation.type, variant: expectedVariant },
        machining: {
          start: { value: { kind: 'current_material' } },
          end: { value: { kind: expectedVariant === 'stock_rough'
            ? 'target_surface'
            : expectedVariant === 'geometry_floor'
              ? 'selected_plane'
              : expectedVariant === 'through_stock'
                ? 'through_stock'
                : 'bounded_plane' } },
          scope: { value: expectedVariant === 'stock_rough'
            ? { kind: 'stock_footprint', stockId: stock.id }
            : { kind: 'selected_geometry', geometryIds: ['target-step'] } },
        },
      },
    })
    if (expectedVariant === 'stock_rough') expect(operation.geometrySelections).toEqual([])
    return smartHeightPlanFixture(operation, resolvedSnapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    project: {
      ...state.project,
      setups: [setup],
      activeSetupId: setup.id,
      stocks: [stock],
      geometry: [{
        id: 'target-step', name: 'Target.step', type: 'brep', format: 'step', loaded: true,
        assignedStockId: stock.id,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 10, y: 10, z: 0 }, max: { x: 90, y: 70, z: 12 } },
        loops: [{
          id: 'floor-loop', layerId: 'floor-layer', closed: true, type: 'contour', area: 1600,
          points: [
            { x: 10, y: 10 }, { x: 50, y: 10 },
            { x: 50, y: 50 }, { x: 10, y: 50 },
          ],
        }],
        layers2d: [{
          id: 'floor-layer', name: 'Floor', color: '#00e5ff', visible: true,
          projectionPlane: {
            origin: { x: 0, y: 0, z: 8 }, normal: { x: 0, y: 0, z: 1 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
          },
        }],
      }],
    },
  } as never)
  return preview
}

async function authorStockOperation(typeLabel: '2D Pocket' | '2D Adaptive Clearing'): Promise<Operation> {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(typeLabel))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.click(screen.getByTestId(typeLabel === '2D Pocket'
    ? 'pocket-stock-smart-height'
    : 'adaptive-stock-smart-height'))
  await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  expect(create.disabled).toBe(false)
  fireEvent.click(create)
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

async function authorGeometryFloorOperation(
  typeLabel: '2D Pocket' | '2D Adaptive Clearing',
): Promise<Operation> {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(typeLabel))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.click(screen.getByTestId(typeLabel === '2D Pocket'
    ? 'pocket-geometry-smart-height'
    : 'adaptive-geometry-smart-height'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'target-step' } })
  fireEvent.click(await screen.findByText('All loops (1)'))
  await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  expect(create.disabled).toBe(false)
  fireEvent.click(create)
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

async function authorBoundedGeometryOperation(
  typeLabel: '2D Pocket' | '2D Adaptive Clearing',
  endCondition: 'through_stock' | 'depth_from_top',
): Promise<Operation> {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText(typeLabel))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.click(screen.getByTestId(typeLabel === '2D Pocket'
    ? 'pocket-geometry-smart-height'
    : 'adaptive-geometry-smart-height'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'target-step' } })
  fireEvent.click(await screen.findByText('All loops (1)'))
  fireEvent.click(screen.getByText('Heights'))
  const endSelect = screen.getByTestId('end-condition-control').querySelector('select')!
  fireEvent.change(endSelect, { target: { value: endCondition } })
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  await waitFor(() => expect(create.disabled).toBe(false))
  fireEvent.click(create)
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('Planar rough Smart Height authoring UI', () => {
  it.each([
    ['2D Pocket', 'pocket_2d'],
    ['2D Adaptive Clearing', 'adaptive_clearing_2d'],
  ] as const)('authors %s stock roughing with V2 authority', async (label, operationType) => {
    const preview = seed()
    const created = await authorStockOperation(label)

    expect(preview).toHaveBeenCalled()
    expect(created.type).toBe(operationType)
    expect(created.geometrySelections).toEqual([])
    expect(created.params).toMatchObject({ boundarySource: 'stock', geometryId: '', loopIds: [] })
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType, variant: 'stock_rough' },
        machining: { scope: { value: { kind: 'stock_footprint', stockId: stock.id } } },
      },
    })
  })

  it.each([
    ['2D Pocket', 'pocket_2d', 'through_stock', 'through_stock'],
    ['2D Pocket', 'pocket_2d', 'depth_from_top', 'explicit_depth'],
    ['2D Adaptive Clearing', 'adaptive_clearing_2d', 'through_stock', 'through_stock'],
    ['2D Adaptive Clearing', 'adaptive_clearing_2d', 'depth_from_top', 'explicit_depth'],
  ] as const)('authors %s %s as live %s authority', async (
    label,
    operationType,
    endCondition,
    variant,
  ) => {
    const preview = seed([], variant)
    const created = await authorBoundedGeometryOperation(label, endCondition)

    expect(preview).toHaveBeenCalled()
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType, variant },
        machining: {
          start: { value: { kind: 'current_material' } },
          scope: { value: { kind: 'selected_geometry', geometryIds: ['target-step'] } },
        },
      },
    })
    const end = (created.smartHeight as { intent: { machining: { end: { value: { kind: string } } } } })
      .intent.machining.end.value
    expect(end.kind).toBe(variant === 'through_stock' ? 'through_stock' : 'bounded_plane')
  })

  it.each([
    ['2D Pocket', 'pocket_2d'],
    ['2D Adaptive Clearing', 'adaptive_clearing_2d'],
  ] as const)('authors %s selected geometry floors with V2 authority', async (label, operationType) => {
    const preview = seed([], 'geometry_floor')
    const created = await authorGeometryFloorOperation(label)

    expect(preview).toHaveBeenCalled()
    expect(created.type).toBe(operationType)
    expect(created.geometrySelections).toEqual(['floor-loop'])
    expect(created.params).toMatchObject({
      boundarySource: 'geometry', geometryId: 'target-step', loopIds: ['floor-loop'],
      heightReference: 'geometry_face', planeOffset: 0,
    })
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType, variant: 'geometry_floor' },
        machining: {
          start: { value: { kind: 'current_material' } },
          end: { value: { kind: 'selected_plane' } },
          scope: { value: { kind: 'selected_geometry', geometryIds: ['target-step'] } },
        },
      },
    })
  })

})
