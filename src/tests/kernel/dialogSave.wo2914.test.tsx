// @vitest-environment jsdom
// WO-2914: real dialog saves and type transitions must survive the common
// transaction boundary. Fixtures retain the independently pinned WO-1514 oracle.

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
const { useCamStore } = await import('../../store')
const {
  buildParallel3dSmartIntent, buildWaterline3dSmartIntent,
  buildSteepShallow3dSmartIntent, buildScallop3dSmartIntent,
  buildDrillBoreAuthoringIntent,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const SETUP_ID = 'setup-1'
const SOLID_ID = 'geo-solid-1'
const BALL_TOOL_ID = 'tool-ball-1'
const DRILL_TOOL_ID = 'tool-drill-1'
const HOLES_ID = 'geo-holes-1'
const LOOP_ID = 'hole-1'

const ballTool = {
  id: BALL_TOOL_ID, name: 'Ball 6mm', type: 'ball_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const drillTool = {
  id: DRILL_TOOL_ID, name: '6 mm Drill', type: 'drill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  angleFromAxisDeg: 59, tipDiameter: 0,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [SOLID_ID],
}

const wcs = {
  id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
}

const BUILDERS = {
  parallel_3d: buildParallel3dSmartIntent,
  waterline_3d: buildWaterline3dSmartIntent,
  steep_shallow_3d: buildSteepShallow3dSmartIntent,
  scallop_3d: buildScallop3dSmartIntent,
} as const

function seedSolidOp(opId: string, type: keyof typeof BUILDERS): void {
  const geo = {
    id: SOLID_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const heightIntent = defaultHeightIntent()
  const op = {
    id: opId, name: 'Op', type, toolId: BALL_TOOL_ID, enabled: true, status: 'ready',
    geometrySelections: [SOLID_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2, feedHeight: 0.5,
      topHeight: 0, topHeightMode: 'stock_top', bottomHeight: -5, bottomHeightMode: 'absolute',
      heightIntent,
    },
    params: {},
    smartHeight: {
      kind: 'smart_v2',
      intent: BUILDERS[type]({ setupId: SETUP_ID, geometryIds: [SOLID_ID], safetyIntent: heightIntent }),
    },
  } as unknown as Operation
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [op], notes: '' } as unknown as Setup
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

function seedDrillOp(opId: string, type: 'drill' | 'bore' = 'drill'): void {
  const geo = {
    id: HOLES_ID, name: 'Circles.dxf', type: 'curves_2d', format: 'dxf', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 0 } },
    loops: [{
      id: LOOP_ID, layerId: 'holes', closed: true, type: 'contour', area: 28,
      points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
    }],
    layers2d: [{ id: 'holes', name: 'Holes', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
  const heightIntent = defaultHeightIntent()
  const op = {
    id: opId, name: 'Op', type, toolId: DRILL_TOOL_ID, enabled: true, status: 'ready',
    geometrySelections: [LOOP_ID],
    passes: { stepdown: 2, stepover: 1, finishPasses: 1, stockToLeave: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2, feedHeight: 0.5,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -5, bottomHeightMode: 'absolute',
      heightIntent,
    },
    params: { loopIds: [LOOP_ID], geometryId: HOLES_ID },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreAuthoringIntent({
        operationType: type, setupId: SETUP_ID, safetyIntent: heightIntent,
        geometries: [geo], selectedLoopIds: [LOOP_ID],
        draft: { mode: 'explicit_depth', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
      }),
    },
  } as unknown as Operation
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [op], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [drillTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

function findOp(opId: string): Operation {
  return useCamStore.getState().project.setups[0].operations.find(o => o.id === opId)!
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-2914: common transactions preserve actual dialog saves and operation types', () => {
  it('Parallel Finish (3D) -> Waterline Finish (3D) saves type: waterline_3d, not the hybrid', async () => {
    seedSolidOp('op-1', 'parallel_3d')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-1') })
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()

    fireEvent.click(screen.getByText('Waterline Finish (3D)'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const op = findOp('op-1')
    expect(op.type).toBe('waterline_3d')
    expect(op.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: 'waterline_3d' } } })
  })

  it('Steep and Shallow (3D) -> Scallop Finish (3D) saves type: scallop_3d (a second 3D-family pair)', async () => {
    seedSolidOp('op-2', 'steep_shallow_3d')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-2') })
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()

    fireEvent.click(screen.getByText('Scallop Finish (3D)'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const op = findOp('op-2')
    expect(op.type).toBe('scallop_3d')
    expect(op.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: 'scallop_3d' } } })
  })

  it('Drill -> Bore saves type: bore (a 2D-family pair)', async () => {
    seedDrillOp('op-3', 'drill')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-3') })
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()

    fireEvent.click(screen.getByText('Bore'))
    // Bore keeps its own geometry/loop selection state, independent of Drill's --
    // switching the Type card does not carry Drill's picks over, so Bore starts
    // blank and needs its own Geometry-tab pick, exactly as a user would do.
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: HOLES_ID } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const op = findOp('op-3')
    expect(op.type).toBe('bore')
    expect(op.smartHeight).toMatchObject({ kind: 'smart_v2', intent: { policy: { operationType: 'bore' } } })
  })

  it('editing without changing type round-trips the same type (drill stays drill)', async () => {
    seedDrillOp('op-4', 'drill')
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-4') })
    expect(screen.queryByTestId('op-edit-load-error')).toBeNull()

    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    expect(findOp('op-4').type).toBe('drill')
  })
})
