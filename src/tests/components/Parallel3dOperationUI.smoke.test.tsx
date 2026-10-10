// @vitest-environment jsdom
//
// React-render SMOKE / hooks-order gate for the parallel_3d (3D finish) operation UI.
//
// WHY THIS EXISTS: tsc + the pure-logic vitest suite cannot catch a hooks-order
// regression or a bad conditional-render in the large shared NewOperationModal /
// PropertiesPanel files. This mounts BOTH surfaces with the parallel_3d type
// active so that:
//   - NewOperationModal renders its parallel_3d config (part picker on the
//     Geometry tab; stepover / pass-angle / tolerance / clip-to-stock on the
//     Passes tab), and Create enables once a solid + a supported cutter are chosen.
//   - PropertiesPanel renders the editable parallel_3d param block and a param
//     edit marks the op outdated (the recompute gate).
// A hooks-order or render regression in either would throw here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors the other *.smoke.test.tsx files).
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
const { buildParallel3dSmartIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const TOOL_ID = 'tool-flat-1'

const flatTool = {
  id: TOOL_ID, name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const parallelSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [GEO_ID],
}

// A single imported SOLID (STL mesh) so the parallel_3d part picker default-selects it.
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
      toolLibrary: [flatTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, parallelSnapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('NewOperationModal parallel_3d config smoke', () => {
  it('renders the Passes-tab config fields when the 3D Finish type is selected', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    // Pick the op-type card, then land on the Passes tab.
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    // Config fields render (mounting did not throw a hooks-order error).
    expect(screen.getByText('Raster fill')).not.toBeNull()
    expect(screen.getByText('Stepover')).not.toBeNull()
    expect(screen.getByText('Pass angle')).not.toBeNull()
    expect(screen.getByText('Tolerance')).not.toBeNull()
    expect(screen.getByText('Surface-normal stock to leave')).not.toBeNull()
    expect(screen.getByText('Finish depth limit')).not.toBeNull()
    expect(screen.getByText('Clip to stock outline')).not.toBeNull()

    // The 2.5D contour Passes block must NOT leak in: parallel_3d reads none of
    // stepdown / cutting-strategy / stock-to-leave / spring / contour-overlap, so
    // showing them is dead carryover clutter. Guard against the negative catch-all
    // re-including this op type.
    expect(screen.queryByTestId('contour-cutting-strategy')).toBeNull()
    expect(screen.queryByText('Cutting strategy')).toBeNull()
    expect(screen.queryByText('Spring passes')).toBeNull()
    expect(screen.queryByText('Depth of cut')).toBeNull()
  })

  it('hides the tabs/fields the 3D finish ignores: no Linking tab, no Top/Bottom-of-cut', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))

    // Linking tab is filtered out (parallel_3d does its own path linking).
    expect(screen.queryByText('Linking')).toBeNull()

    // Heights always presents the five standard conventions while the surface
    // target remains the authority for the finishing range.
    fireEvent.click(screen.getByText('Heights'))
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.getByTestId(`standard-height-${plane}`)).not.toBeNull()
      expect(screen.getByTestId(`standard-height-${plane}-resolved`)).not.toBeNull()
    }
    expect(screen.getByTestId('standard-height-bottom-source').textContent)
      .toContain('Operation Smart policy')
  })

  it('Geometry tab shows the solid part picker, defaulted to the only solid', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))

    const sel = screen.getByTestId('op-parallel3d-part-select') as HTMLSelectElement
    expect(sel).not.toBeNull()
    // Exactly one solid -> it is the effective default selection.
    expect(sel.value).toBe(GEO_ID)
  })

  it('Create enables once a solid + a supported cutter are chosen', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))

    // No tool yet -> Create disabled.
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)

    // Pick the flat end mill on the Tool tab.
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))

    // Solid auto-selected + supported cutter -> Create enabled.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  })

  it('authors new full-surface operations with Smart Height V2 authority', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.type).toBe('parallel_3d')
    expect(op.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'parallel_3d', variant: 'target_surface' },
        machining: {
          start: { value: { kind: 'target_model_top' } },
          end: { value: { kind: 'target_surface' } },
          scope: { value: { kind: 'whole_target', geometryIds: [GEO_ID] } },
        },
      },
    })
  })

  it('authors a finish-depth edit as a target-field lower limit', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Passes'))
    const depth = screen.getByTestId('op-parallel3d-finish-depth').querySelector('input') as HTMLInputElement
    fireEvent.change(depth, { target: { value: '4' } })
    fireEvent.blur(depth)
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'parallel_3d', variant: 'bounded_surface' },
        machining: {
          end: {
            value: {
              kind: 'target_surface',
              lowerLimit: { reference: 'top', offsetMm: -4 },
            },
          },
        },
      },
    })
  })
})

// A ready parallel_3d op so the PropertiesPanel edit block renders.
function seedParallel3dOp(options: { smart?: boolean; finishDepthMm?: number; resolved?: boolean } = {}): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    loops: [{ id: 'l1', points: [] }],
  } as unknown as ImportedGeometry
  const heightIntent = defaultHeightIntent()
  const smartHeight = options.smart ? {
    kind: 'smart_v2' as const,
    intent: buildParallel3dSmartIntent({
      setupId: SETUP_ID,
      geometryIds: [GEO_ID],
      safetyIntent: heightIntent,
      finishDepthMm: options.finishDepthMm,
    }),
  } : undefined
  const op = {
    id: 'op-p3d-1', name: '3D Finish 1', type: 'parallel_3d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [GEO_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: -5, bottomHeightMode: 'absolute',
      heightIntent,
    },
    params: {
      stepover: 1, angleDeg: 0, tolerance: 0.05, useStockBoundary: false,
      finishDepth: options.finishDepthMm,
    },
    smartHeight,
  } as unknown as Operation
  if (options.resolved && smartHeight) {
    op.resolvedHeightPlan = smartHeightPlanFixture(op, parallelSnapshot)
  }
  const setup = {
    id: SETUP_ID, name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } },
    operations: [op],
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [flatTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, parallelSnapshot)),
      project: {
        ...s.project, geometry: [geo], setups: [setup],
        activeSetupId: SETUP_ID, activeOperationId: 'op-p3d-1',
      },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    } as never))
  })
}

describe('PropertiesPanel parallel_3d edit smoke', () => {
  it('renders the editable param block for a parallel_3d op (hooks-order gate)', () => {
    seedParallel3dOp()
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
    expect(screen.getByTestId('props-parallel3d-edit')).not.toBeNull()
    // The parallel_3d-specific rows render (not the shared stepdown/stock rows).
    expect(screen.getByText('Pass angle')).not.toBeNull()
    expect(screen.getByText('Surface-normal stock')).not.toBeNull()
    expect(screen.getByText('Finish depth limit')).not.toBeNull()
    expect(screen.getByText('Clip to stock')).not.toBeNull()
    expect(screen.getByTestId('op-height-repair-required')).not.toBeNull()
  })

  it('exposes Smart Height target authority and the live resolved target envelope', async () => {
    seedParallel3dOp({ smart: true, finishDepthMm: 4, resolved: true })
    render(<PropertiesPanel />)

    // WO-2007 (CS 21): ownership is the safety rows' tooltip, not a chip row.
    expect(screen.queryByTestId('op-height-source')).toBeNull()
    expect(screen.getByTestId('props-height-value-clearance').getAttribute('data-tooltip')).toContain('Setup owned')
    expect((screen.getByRole('combobox', { name: 'Parallel target policy' }) as HTMLSelectElement).value)
      .toBe('bounded_surface')
    expect((screen.getByTestId('props-parallel3d-depth-limit').querySelector('input') as HTMLInputElement).value)
      .toBe('4')
    // WO-2007 fix round (CS 21): Material start, Target end and Authority scope prose rows are gone.
    expect(screen.queryByTestId('props-parallel3d-height-start')).toBeNull()
    expect(screen.queryByTestId('props-parallel3d-height-end')).toBeNull()
    expect(screen.queryByTestId('props-parallel3d-height-scope')).toBeNull()
    // WO-2007 (CS 21): the live target envelope is the Top and Bottom row values.
    await waitFor(() => expect(screen.getByTestId('props-height-value-top').textContent).toMatch(/^10(\.0+)? mm WCS/))
    expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/^2(\.0+)? mm WCS/)
  })

  it('authors a Properties finish-depth edit as Smart Height V2 target authority', () => {
    seedParallel3dOp()
    render(<PropertiesPanel />)

    const finishDepthRow = screen.getByText('Finish depth limit').closest('.props-group')
    const input = finishDepthRow?.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '3.5' } })
    fireEvent.blur(input)

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'parallel_3d', variant: 'bounded_surface' },
        machining: {
          end: { value: { kind: 'target_surface', lowerLimit: { reference: 'top', offsetMm: -3.5 } } },
        },
      },
    })
    expect(op.status).toBe('outdated')
  })

  it('shows a Cancel button only while a parallel_3d op is computing; clicking it is safe', () => {
    seedParallel3dOp() // seeded status: 'ready'
    render(<PropertiesPanel />)
    // Idle op -> no cancel control.
    expect(screen.queryByTestId('props-parallel3d-cancel')).toBeNull()

    // Flip the op to 'computing' -> the store subscription re-renders the panel.
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((st) => ({
            ...st,
            operations: st.operations.map((o) =>
              o.id === 'op-p3d-1' ? { ...o, status: 'computing' } : o,
            ),
          })),
        },
      } as never))
    })
    const cancelBtn = screen.getByTestId('props-parallel3d-cancel')
    expect(cancelBtn).not.toBeNull()

    // No live compute is registered (no tracked aborter), so the wired action is
    // a safe no-op — it must not throw when clicked.
    expect(() => fireEvent.click(cancelBtn)).not.toThrow()
    expect(typeof useCamStore.getState().cancelParallel3dCompute).toBe('function')
    // Calling the action directly with an unknown opId is also a no-op.
    expect(() => useCamStore.getState().cancelParallel3dCompute('no-such-op')).not.toThrow()
  })

  it('toggling clip-to-stock writes op.params and marks the op outdated', () => {
    seedParallel3dOp()
    render(<PropertiesPanel />)

    const block = screen.getByTestId('props-parallel3d-edit')
    const checkbox = block.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect((op.params as { useStockBoundary?: boolean }).useStockBoundary).toBe(true)
    expect(op.status).toBe('outdated')
  })
})
