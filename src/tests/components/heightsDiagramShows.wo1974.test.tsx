// @vitest-environment jsdom
//
// WO-1974: the Heights tab shows the heights diagram (svg.op-heights-diag) for
// every operation with heights, in EDIT mode too - Pocket, Adaptive 3D, and a
// Face whose Smart Height plan is not resolved yet.

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
const { buildPlanarRoughSmartHeightIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { defaultACParams, defaultPocketParams } = await import(
  '../../components/modals/newOperationModalDefaults'
)

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

const snapshot = {
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

function operation(type: 'pocket_2d' | 'adaptive_clearing_2d'): Operation {
  const safetyIntent = defaultHeightIntent()
  return {
    id: 'op-1', name: 'Op 1', type, enabled: true, status: 'ready', toolId: tool.id,
    geometrySelections: [],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute',
      retractHeight: 25, feedHeight: 20, topHeight: 20, topHeightMode: 'stock_top',
      bottomHeight: 7.25, bottomHeightMode: 'absolute', heightIntent: safetyIntent,
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: 'setup-1', operationType: type, safetyIntent, mode: 'stock_rough', stockId: stock.id,
      }),
    },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'pocket_2d'
      ? { ...defaultPocketParams, boundarySource: 'stock', geometryId: '', loopIds: [] }
      : { ...defaultACParams, boundarySource: 'stock', geometryId: '', loopIds: [] },
  } as Operation
}

function openEdit(op: Operation) {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [op],
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
    previewPlanarRoughSmartHeights: vi.fn(async () => snapshot),
    previewOperationSmartHeightPlan: vi.fn(async (_id: string, candidate: Operation) =>
      smartHeightPlanFixture(candidate, snapshot)),
    project: {
      ...state.project, setups: [setup], activeSetupId: setup.id, stocks: [stock], geometry: [],
    },
  } as never)
  const view = render(<NewOperationModal />)
  act(() => {
    useCamStore.setState({ editingOpPayload: { setupId: 'setup-1', operationId: op.id } } as never)
    useCamStore.getState().openModal('edit-operation')
  })
  fireEvent.click(screen.getByText('Heights'))
  return view
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

function diagramValue(container: HTMLElement, name: string): number {
  const text = Array.from(container.querySelectorAll('svg.op-heights-diag text'))
    .map(t => t.textContent ?? '').find(l => l.startsWith(name))
  return Number((text ?? '').slice(name.length).replace(/[^0-9.+-]/g, ''))
}

function rowValue(plane: string): number {
  return Number(screen.getByTestId(`standard-height-${plane}-resolved`).textContent!.replace(/[^0-9.-]/g, ''))
}

describe('WO-1974 heights diagram shows in the Heights tab', () => {
  it.each(['pocket_2d', 'adaptive_clearing_2d'] as const)('%s opened for EDIT draws the diagram at the row values', async type => {
    const { container } = openEdit(operation(type))
    await waitFor(() => expect(screen.getByTestId('standard-height-controls')).not.toBeNull())
    const svg = container.querySelector('svg.op-heights-diag')
    expect(svg).not.toBeNull()
    // Not inside the policy-controls div, which is `hidden` until Top/Bottom expands.
    expect(svg!.closest('[hidden]')).toBeNull()
    for (const [name, plane] of [['Clearance', 'clearance'], ['Retract', 'retract'], ['Feed height', 'feed']] as const) {
      expect(diagramValue(container, name)).toBe(rowValue(plane))
    }
    expect(diagramValue(container, 'Top of cut')).toBe(rowValue('top'))
    expect(diagramValue(container, 'Bottom of cut')).toBe(rowValue('bottom'))
  })

  it('adaptive_3d opened for EDIT draws the diagram', async () => {
    const op = operation('pocket_2d')
    op.type = 'adaptive_3d' as Operation['type']
    const { container } = openEdit(op)
    await waitFor(() => expect(screen.getByTestId('standard-height-controls')).not.toBeNull())
    const svg = container.querySelector('svg.op-heights-diag')
    expect(svg).not.toBeNull()
    expect(svg!.closest('[hidden]')).toBeNull()
  })

  it('face with an unresolved plan still draws the diagram', async () => {
    const op = operation('pocket_2d')
    op.type = 'face' as Operation['type']
    const { container } = openEdit(op)
    await waitFor(() => expect(screen.getByTestId('standard-height-controls')).not.toBeNull())
    const svg = container.querySelector('svg.op-heights-diag')
    expect(svg).not.toBeNull()
    expect(svg!.closest('[hidden]')).toBeNull()
  })
})
