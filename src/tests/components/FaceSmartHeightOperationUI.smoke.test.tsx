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
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { buildFaceSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const tool = {
  id: 'tool-1', name: 'Face mill 12mm', type: 'flat_end_mill', diameter: 12,
  fluteLength: 25, numberOfFlutes: 3,
} as unknown as Tool

const faceSnapshot = {
  version: 1 as const,
  wcs: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 10 },
  machine: { clearance: 30, retract: 25, feed: 20.5, top: 20, bottom: 10 },
  intent: {
    version: 1 as const,
    clearance: { reference: 'wcs_plane' as const, offset: 30, provenance: 'inferred' as const },
    retract: { reference: 'wcs_plane' as const, offset: 25, provenance: 'inferred' as const },
    feed: { reference: 'wcs_plane' as const, offset: 20.5, provenance: 'inferred' as const },
    top: { reference: 'wcs_plane' as const, offset: 20, provenance: 'inferred' as const },
    bottom: { reference: 'wcs_plane' as const, offset: 10, provenance: 'inferred' as const },
  },
  dependencyIds: [stock.id],
}

function baseFaceOperation(): Operation {
  return {
    id: 'face-base', name: 'Base Face', type: 'face', enabled: true, status: 'ready',
    toolId: tool.id, geometrySelections: [],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute',
      retractHeight: 25, feedHeight: 20,
      topHeight: 15, topHeightMode: 'stock_top',
      bottomHeight: 7.25, bottomHeightMode: 'absolute',
    },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0,
      floorStockToLeave: 0, finishPasses: 0, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
      stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
      pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
      passExtension: 0, chipThinning: false, bothSidesPerLevel: false,
      floorStockToLeave: 0, finishPass: false, entryType: 'plunge', leadInRadius: 0,
      leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
      extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
    },
} as unknown as Operation
}

function smartFaceOperation(): Operation {
  const operation = baseFaceOperation()
  return {
    ...operation,
    id: 'face-smart',
    name: 'Smart Face',
    status: 'ready',
    smartHeight: {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent: defaultHeightIntent(),
        mode: 'explicit_depth',
        stockId: stock.id,
        explicitTargetWcsMm: 8,
      }),
    },
  }
}

function activateOperation(operation: Operation): void {
  act(() => useCamStore.setState(state => ({
    project: {
      ...state.project,
      activeOperationId: operation.id,
      setups: state.project.setups.map(setup => setup.id === 'setup-1'
        ? { ...setup, operations: [operation] }
        : setup),
    },
    viewer: {
      ...state.viewer,
      selectedGeometryId: null,
      selectedStockId: null,
      selectedNestId: null,
    },
  })))
}

function seed(): void {
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
    toolLibrary: [tool],
    computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
      smartHeightPlanFixture(operation, faceSnapshot)),
    previewFaceSmartHeights: vi.fn(() => faceSnapshot),
    project: {
      ...state.project,
      setups: [setup], activeSetupId: setup.id,
      stocks: [stock], geometry: [],
    },
  } as never)
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('Face Smart Height authoring UI', () => {
  it('chooses the starting physical end condition and persists the WCS policy', async () => {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Face mill 12mm'))
    fireEvent.click(screen.getByText('Heights'))

    const create = screen.getByTestId('op-create') as HTMLButtonElement
    const mode = screen.getByTestId('face-height-mode') as HTMLSelectElement
    expect(mode.value).toBe('explicit_depth')
    expect(screen.queryByTestId('face-height-unconfirmed')).toBeNull()
    expect(await screen.findByTestId('resolved-height-plan')).not.toBeNull()
    expect(create.disabled).toBe(false)

    fireEvent.click(create)
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'face', variant: 'explicit_depth' },
        machining: {
          end: { value: { kind: 'bounded_plane', plane: { reference: 'wcs_plane', offsetMm: -5 } } },
          scope: { value: { kind: 'stock_footprint', stockId: stock.id } },
        },
      },
    })
  })

  it('offers the durable workspace face picker for the model-target policy', () => {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('2D Face'))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.change(screen.getByTestId('face-height-mode'), { target: { value: 'target_face' } })
    expect(screen.getByTestId('pick-face-target')).not.toBeNull()
    expect(screen.getByTestId('face-target-readout').textContent).toContain('No target face selected')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  })

})

describe('Face Smart Height Properties panel', () => {
  it('edits the explicit physical target through V2 authority', async () => {
    activateOperation(smartFaceOperation())
    render(<PropertiesPanel />)

    await waitFor(() => {
      // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
      expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
      expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/ mm WCS/)
    })
    // WO-2007 fix round (CS 21): the End policy read-out is gone; the editable Physical target row is the policy.
    expect(screen.queryByTestId('props-face-height-policy')).toBeNull()
    const target = screen.getByTestId('props-face-explicit-target').querySelector('input') as HTMLInputElement
    fireEvent.focus(target)
    fireEvent.change(target, { target: { value: '6.5' } })
    fireEvent.blur(target)

    const updated = useCamStore.getState().project.setups[0].operations[0]
    expect(updated.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'face', variant: 'explicit_depth' },
        machining: {
          end: { value: { kind: 'bounded_plane', plane: { reference: 'wcs_plane', offsetMm: 6.5 } } },
          scope: { value: { kind: 'stock_footprint', stockId: stock.id } },
        },
      },
    })
    expect(updated.status).toBe('pending')
  })

  it('keeps safety edits in Face V2 intent and preserves the physical endpoint', () => {
    activateOperation(smartFaceOperation())
    render(<PropertiesPanel />)

    const clearance = screen.getByTestId('props-height-row-clearance')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '22' } })
    fireEvent.blur(clearance)

    let updated = useCamStore.getState().project.setups[0].operations[0]
    expect(updated.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        safety: { clearance: { offsetMm: 22 } },
        machining: { end: { value: { plane: { offsetMm: 8 } } } },
      },
    })

  })

})
