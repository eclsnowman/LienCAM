// @vitest-environment jsdom
//
// WO-1176: React-render smoke / hooks-order gate for the waterline_3d
// operation UI, the twin of Parallel3dOperationUI.smoke.test.tsx. Mounts the
// New Operation dialog with the Waterline card active (solid picker on the
// Geometry tab; stepdown / tolerance / stock / steep-only / order / direction
// / flat areas / clip on the Passes tab; Create enables once a solid and a
// supported cutter are chosen; the created op carries the waterline Smart
// Height authority) and the Properties panel (editable block, a finish-depth
// edit re-authors the authority, Cancel only while computing).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { buildWaterline3dSmartIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const TOOL_ID = 'tool-ball-1'

const ballTool = {
  id: TOOL_ID, name: 'Ball 6mm', type: 'ball_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [GEO_ID],
}

function seedSolid(): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [ballTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

function openWaterline(): void {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Waterline Finish (3D)'))
}

describe('NewOperationModal waterline_3d config', () => {
  it('renders the Passes-tab fields and none of the 2.5D carryovers', () => {
    seedSolid()
    openWaterline()
    fireEvent.click(screen.getByText('Passes'))
    expect(screen.getByText('Levels')).not.toBeNull()
    expect(screen.getByText('Stepdown')).not.toBeNull()
    expect(screen.getByText('Tolerance')).not.toBeNull()
    expect(screen.getByText('Stock to leave (walls)')).not.toBeNull()
    expect(screen.getByText('Steep areas only, above')).not.toBeNull()
    expect(screen.getByText('Finish depth limit')).not.toBeNull()
    expect(screen.getByTestId('op-waterline3d-order')).not.toBeNull()
    expect(screen.getByTestId('op-waterline3d-direction')).not.toBeNull()
    expect(screen.getByTestId('op-waterline3d-flat-areas')).not.toBeNull()
    expect(screen.getByText('Clip to stock outline')).not.toBeNull()
    expect(screen.queryByText('Raster fill')).toBeNull()
    expect(screen.queryByText('Cutting strategy')).toBeNull()
    expect(screen.queryByText('Spring passes')).toBeNull()
    expect(screen.queryByText('Depth of cut')).toBeNull()
  })

  it('hides the Linking tab and shows the target-field height summary', () => {
    seedSolid()
    openWaterline()
    expect(screen.queryByText('Linking')).toBeNull()
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.getByTestId('waterline3d-height-policy')).not.toBeNull()
    expect(screen.getByTestId('waterline3d-height-mode').textContent).toContain('Full target surface')
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.getByTestId(`standard-height-${plane}`)).not.toBeNull()
    }
  })

  it('Geometry tab defaults the only solid into the waterline picker', () => {
    seedSolid()
    openWaterline()
    fireEvent.click(screen.getByText('Geometry'))
    const sel = screen.getByTestId('op-waterline3d-part-select') as HTMLSelectElement
    expect(sel.value).toBe(GEO_ID)
  })

  it('Create enables with a solid and a supported cutter, and starts the stepdown at 10% of the diameter', async () => {
    seedSolid()
    openWaterline()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Ball 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Passes'))
    const stepdownRow = screen.getByText('Stepdown').closest('.op-field-row') as HTMLElement
    expect((stepdownRow.querySelector('input') as HTMLInputElement).value).toBe('0.6')
  })

  it('creates a waterline operation with the waterline Smart Height authority and its params', async () => {
    seedSolid()
    openWaterline()
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.change(screen.getByTestId('op-waterline3d-order'), { target: { value: 'level' } })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Ball 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.type).toBe('waterline_3d')
    expect(op.geometrySelections).toEqual([GEO_ID])
    expect(op.params).toMatchObject({ order: 'level', direction: 'climb', flatAreaDetection: true, stepdown: 0.6 })
    expect(op.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'waterline_3d', variant: 'target_surface' },
        machining: {
          start: { value: { kind: 'target_model_top' } },
          end: { value: { kind: 'target_surface' } },
          scope: { value: { kind: 'whole_target', geometryIds: [GEO_ID] } },
        },
      },
    })
  })

  it('authors a finish-depth edit as the bounded variant', async () => {
    seedSolid()
    openWaterline()
    fireEvent.click(screen.getByText('Passes'))
    const depth = screen.getByTestId('op-waterline3d-finish-depth').querySelector('input') as HTMLInputElement
    fireEvent.change(depth, { target: { value: '4' } })
    fireEvent.blur(depth)
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Ball 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.smartHeight).toMatchObject({
      intent: {
        policy: { operationType: 'waterline_3d', variant: 'bounded_surface' },
        machining: { end: { value: { kind: 'target_surface', lowerLimit: { reference: 'top', offsetMm: -4 } } } },
      },
    })
  })

  it('reopens a saved waterline operation for editing with its values loaded', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((st) => ({
            ...st,
            operations: [{
              id: 'op-w-1', name: 'Walls', type: 'waterline_3d', toolId: TOOL_ID, enabled: true, status: 'ready',
              geometrySelections: [GEO_ID],
              passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
              linking: {},
              heights: {
                clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2, feedHeight: 0.5,
                topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
                heightIntent: defaultHeightIntent(),
              },
              params: { stepdown: 0.8, tolerance: 0.02, stockToLeave: 0.2, minSlopeDeg: 43, flatAreaDetection: false, order: 'region', direction: 'conventional', useStockBoundary: false },
              smartHeight: {
                kind: 'smart_v2',
                intent: buildWaterline3dSmartIntent({ setupId: SETUP_ID, geometryIds: [GEO_ID], safetyIntent: defaultHeightIntent() }),
              },
            } as unknown as Operation],
          })),
        },
      } as never))
    })
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-w-1') })
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()
    fireEvent.click(screen.getByText('Passes'))
    expect((screen.getByTestId('op-waterline3d-order') as HTMLSelectElement).value).toBe('region')
    expect((screen.getByTestId('op-waterline3d-direction') as HTMLSelectElement).value).toBe('conventional')
    expect((screen.getByTestId('op-waterline3d-flat-areas') as HTMLInputElement).checked).toBe(false)
    const stepdownRow = screen.getByText('Stepdown').closest('.op-field-row') as HTMLElement
    expect((stepdownRow.querySelector('input') as HTMLInputElement).value).toBe('0.8')
  })
})

function seedWaterlineOp(options: { smart?: boolean; finishDepthMm?: number; resolved?: boolean } = {}): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    loops: [{ id: 'l1', points: [] }],
  } as unknown as ImportedGeometry
  const heightIntent = defaultHeightIntent()
  const smartHeight = options.smart ? {
    kind: 'smart_v2' as const,
    intent: buildWaterline3dSmartIntent({
      setupId: SETUP_ID, geometryIds: [GEO_ID], safetyIntent: heightIntent, finishDepthMm: options.finishDepthMm,
    }),
  } : undefined
  const op = {
    id: 'op-w3d-1', name: 'Waterline 1', type: 'waterline_3d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [GEO_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: -5, bottomHeightMode: 'absolute',
      heightIntent,
    },
    params: { stepdown: 0.6, tolerance: 0.05, stockToLeave: 0.25, minSlopeDeg: 0, flatAreaDetection: true, order: 'level', direction: 'climb', useStockBoundary: false, finishDepth: options.finishDepthMm },
    smartHeight,
  } as unknown as Operation
  if (options.resolved && smartHeight) op.resolvedHeightPlan = smartHeightPlanFixture(op, snapshot)
  const setup = {
    id: SETUP_ID, name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } }, operations: [op],
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [ballTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID, activeOperationId: 'op-w3d-1' },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    } as never))
  })
}

describe('PropertiesPanel waterline_3d edit', () => {
  it('renders the editable block (hooks-order gate) and the repair note without an authority', () => {
    seedWaterlineOp()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-waterline3d-edit')).not.toBeNull()
    expect(screen.getByText('Steep areas only')).not.toBeNull()
    expect(screen.getByText('Flat areas')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'Waterline order' })).not.toBeNull()
    expect(screen.getByTestId('op-height-repair-required')).not.toBeNull()
  })

  it('shows the target authority and the resolved envelope', async () => {
    seedWaterlineOp({ smart: true, finishDepthMm: 4, resolved: true })
    render(<PropertiesPanel />)
    expect((screen.getByRole('combobox', { name: 'Waterline target policy' }) as HTMLSelectElement).value)
      .toBe('bounded_surface')
    expect((screen.getByTestId('props-waterline3d-depth-limit').querySelector('input') as HTMLInputElement).value).toBe('4')
    // WO-2007 fix round (CS 21): Material start and Wall allowance prose rows are gone; the values are the rows below.
    expect(screen.queryByTestId('props-waterline3d-height-start')).toBeNull()
    expect(screen.queryByTestId('props-waterline3d-wall-allowance')).toBeNull()
    // WO-2007 (CS 21): the live envelope top is the Top row value, not a diagnostics copy.
    await waitFor(() => expect(screen.getByTestId('props-height-value-top').textContent).toMatch(/^10(\.0+)? mm WCS/))
  })

  it('re-authors a finish-depth edit under the waterline policy and marks the op outdated', () => {
    seedWaterlineOp()
    render(<PropertiesPanel />)
    const row = screen.getByText('Finish depth limit').closest('.props-group')
    const input = row?.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '3.5' } })
    fireEvent.blur(input)
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'waterline_3d', variant: 'bounded_surface' },
        machining: { end: { value: { kind: 'target_surface', lowerLimit: { reference: 'top', offsetMm: -3.5 } } } },
      },
    })
    expect(op.status).toBe('outdated')
  })

  it('writes an order change to op.params and marks the op outdated', () => {
    seedWaterlineOp()
    render(<PropertiesPanel />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Waterline order' }), { target: { value: 'level' } })
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect((op.params as { order?: string }).order).toBe('level')
    expect(op.status).toBe('outdated')
  })

  it('offers Cancel only while computing', () => {
    seedWaterlineOp()
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('props-waterline3d-cancel')).toBeNull()
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((st) => ({
            ...st,
            operations: st.operations.map((o) => (o.id === 'op-w3d-1' ? { ...o, status: 'computing' } : o)),
          })),
        },
      } as never))
    })
    const cancel = screen.getByTestId('props-waterline3d-cancel')
    expect(() => fireEvent.click(cancel)).not.toThrow()
    expect(() => useCamStore.getState().cancelWaterline3dCompute('no-such-op')).not.toThrow()
  })
})
