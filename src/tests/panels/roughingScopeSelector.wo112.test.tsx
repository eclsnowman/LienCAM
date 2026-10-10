// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { resolveStockOutlineMode } from '../../cam3d/integration/adaptive3dOperation'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-wo112'
const GEO_ID = 'geo-wo112'
const OP_ID = 'op-wo112'
const TOOL_ID = 'tool-wo112'

const tool = {
  id: TOOL_ID,
  name: 'WO-112 Flat 6mm',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  numberOfFlutes: 2,
} as unknown as Tool

function geometry(rotationZ = 0): ImportedGeometry {
  return {
    id: GEO_ID,
    name: 'WO-112 Widget',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    stockId: 'stock-wo112',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: rotationZ },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 20, z: 10 },
    },
  } as unknown as ImportedGeometry
}

function setup(operations: Operation[] = []): Setup {
  return {
    id: SETUP_ID,
    name: 'WO-112 Setup',
    wcs: {
      id: 'wcs-wo112',
      label: 'G54',
      fixtureOffset: 54,
      stockId: 'stock-wo112',
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
    operations,
    notes: '',
  } as unknown as Setup
}

function adaptiveOperation(useStockBoundary: boolean): Operation {
  return {
    id: OP_ID,
    name: 'WO-112 Rough',
    type: 'adaptive_3d',
    enabled: true,
    status: 'ready',
    toolId: TOOL_ID,
    geometrySelections: [GEO_ID],
    heights: {
      clearanceHeight: 10,
      clearanceHeightMode: 'absolute',
      retractHeight: 2,
      feedHeight: 0.5,
      topHeight: 0,
      topHeightMode: 'stock_top',
      bottomHeight: -5,
      bottomHeightMode: 'absolute',
    },
    passes: {
      stepdown: 2,
      stepover: 3,
      stockToLeave: 0,
      finishPasses: 1,
      springPasses: 0,
    },
    linking: {},
    params: {
      maxStepdown: 3,
      stepover: 0.4,
      tolerance: 0.05,
      helixDiameter: 3,
      radialStockToLeave: 0.2,
      axialStockToLeave: 0.1,
      cellSize: 0,
      useStockBoundary,
    },
  } as unknown as Operation
}

// Commit 2e5678b7 (Smart Height V2 cutover): the modal's Create button stays
// disabled until the operation's Smart Height preflight resolves. Stub the
// store's async preview with the shared plan fixture, as
// Adaptive3dOperationUI.smoke.test.tsx does.
const wo112PreviewSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: ['stock:stock-wo112', `geometry:${GEO_ID}`, `tool:${TOOL_ID}`],
}

function seedForModal(): void {
  act(() => {
    const current = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, wo112PreviewSnapshot)),
      project: {
        ...current.project,
        geometry: [geometry()],
        setups: [setup()],
        activeSetupId: SETUP_ID,
      },
    } as never)
  })
}

function seedForPanel(rotationZ = 0, useStockBoundary = false): void {
  act(() => {
    const current = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool],
      project: {
        ...current.project,
        geometry: [geometry(rotationZ)],
        setups: [setup([adaptiveOperation(useStockBoundary)])],
        activeSetupId: SETUP_ID,
        activeOperationId: OP_ID,
      },
      viewer: {
        ...current.viewer,
        selectedGeometryId: null,
        selectedStockId: null,
        selectedNestId: null,
      },
    } as never)
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})

function expectTwoModeSelector(scope: HTMLElement): void {
  const radios = within(scope).getAllByRole('radio') as HTMLInputElement[]
  expect(radios).toHaveLength(2)
  expect(within(scope).getByRole('radio', { name: /Clear all stock/i })).not.toBeNull()
  expect(within(scope).getByRole('radio', { name: /Clear around part/i })).not.toBeNull()
  expect(within(scope).queryByRole('checkbox', { name: /Clear (whole|all) stock/i })).toBeNull()
  // WO-1182 (363b55c65) deliberately removed helper prose from operation
  // surfaces. Keep the selector behavior sharp while pinning that the retired
  // sentence does not grow back into either the modal or Properties panel.
  expect(scope.textContent).not.toContain('Radial and axial stock to leave apply in both modes')
}

describe('WO-112 roughing scope selector', () => {
  it('persists the selected mode from the Properties panel', () => {
    seedForPanel()
    render(<PropertiesPanel />)

    const selector = screen.getByTestId('props-adaptive3d-roughing-scope')
    expectTwoModeSelector(selector)
    const allStock = within(selector).getByRole('radio', { name: /Clear all stock/i })
    fireEvent.click(allStock)

    const persisted = useCamStore.getState().project.setups[0].operations[0]
    expect((persisted.params as { useStockBoundary?: boolean }).useStockBoundary).toBe(true)
    expect(persisted.status).toBe('outdated')
  })

  it('persists the selected mode when a new operation is created', async () => {
    seedForModal()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    const selector = screen.getByTestId('op-adaptive3d-roughing-scope')
    expectTwoModeSelector(selector)
    fireEvent.click(within(selector).getByRole('radio', { name: /Clear all stock/i }))

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('adaptive_3d')
    expect((created.params as { useStockBoundary?: boolean }).useStockBoundary).toBe(true)
  })

  // WO-2007 round 3 (CS 21): the fallback notice row is gone from Properties; the engine still
  // falls back and reports it on the console (store/index.ts console.warn of decision.reason).
  it('keeps Clear all stock selected on a rotated part with no fallback notice row', () => {
    seedForPanel(Math.PI / 8, true)
    render(<PropertiesPanel />)

    const selector = screen.getByTestId('props-adaptive3d-roughing-scope')
    expect((within(selector).getByRole('radio', { name: /Clear all stock/i }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByTestId('props-adaptive3d-scope-fallback')).toBeNull()
    expect(document.body.textContent).not.toContain('Clear all stock cannot run')

    // The engine's decision for this part is unchanged: rotated -> part bounds.
    const decision = resolveStockOutlineMode({
      useStockBoundary: true,
      unspun: false,
      hasFootprint: true,
      solidPartsOnStock: 1,
      opName: 'WO-112',
    })
    expect(decision).toMatchObject({ mode: 'part-bounds', cause: 'rotated-part' })
  })
})
