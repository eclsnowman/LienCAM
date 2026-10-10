// @vitest-environment jsdom
//
// React-render SMOKE / hooks-order gate for the adaptive_3d (3D rougher) operation UI.
//
// WHY THIS EXISTS: tsc + the pure-logic vitest suite cannot catch a hooks-order
// regression or a bad conditional-render in the large shared NewOperationModal /
// PropertiesPanel files. This mounts BOTH surfaces with the adaptive_3d type
// active so that:
//   - NewOperationModal renders its adaptive_3d config (part picker on the
//     Geometry tab; stepdown / stepover-fraction / helix / stock-to-leave /
//     tolerance / auto-grid / clip-to-stock on the Passes tab), and Create enables
//     once a solid + a supported cutter are chosen.
//   - PropertiesPanel renders the editable adaptive_3d param block and a Cancel
//     button while the op is computing.
// A hooks-order or render regression in either would throw here. Mirrors
// Parallel3dOperationUI.smoke.test.tsx one-to-one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within, waitFor } from '@testing-library/react'
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
const { buildAdaptive3dSmartIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const MODEL_GEO_ID = 'modelbody:feature-1'
const TOOL_ID = 'tool-flat-1'

const defaultPreviewSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: ['stock:stock-1', `geometry:${GEO_ID}`, `tool:${TOOL_ID}`],
}

const previewExactPlan = vi.fn(async (_setupId: string, operation: Operation) =>
  smartHeightPlanFixture(operation, defaultPreviewSnapshot))

const flatTool = {
  id: TOOL_ID, name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

// A single imported SOLID (STL mesh) so the adaptive_3d part picker default-selects it.
function seedSolid(): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    stockId: 'stock-1',
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [flatTool],
      previewOperationSmartHeightPlan: previewExactPlan,
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

function seedModeledSolid(): void {
  const geo = {
    id: MODEL_GEO_ID, name: 'Modeled Widget', type: 'model', format: 'model', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    modelItemId: 'item-1',
    modelBody: {
      ref: { bodyId: 'feature-1', stableIds: [], version: 1 },
      display: {
        positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 10],
        normals: [], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [20, 20, 10] },
      },
    },
  } as unknown as ImportedGeometry
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    stockId: 'stock-1',
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [flatTool],
      previewOperationSmartHeightPlan: previewExactPlan,
      project: {
        ...s.project,
        geometry: [geo],
        setups: [setup],
        activeSetupId: SETUP_ID,
        modelItemPlacements: [{
          modelItemId: 'item-1',
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        }],
      },
    } as never)
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('NewOperationModal adaptive_3d config smoke', () => {
  it('renders the Passes-tab config fields when the 3D Rough type is selected', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    // Pick the op-type card, then land on the Passes tab.
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    // Config fields render (mounting did not throw a hooks-order error).
    expect(screen.getByText('Roughing')).not.toBeNull()
    expect(screen.getByText('Max stepdown')).not.toBeNull()
    expect(screen.getByText('Stepover (fraction of tool dia)')).not.toBeNull()
    expect(screen.getByText('Wall lead-in radius')).not.toBeNull()
    expect(screen.getByText('Wall lead-out radius')).not.toBeNull()
    expect(screen.getByText('Loopback fillet')).not.toBeNull()
    expect(screen.getByText('Integral wall-follow')).not.toBeNull()
    expect(screen.getByText('Maximum direct wall ride')).not.toBeNull()
    expect(screen.getByText('Entry helix diameter')).not.toBeNull()
    expect(screen.getByText('Radial stock to leave')).not.toBeNull()
    expect(screen.getByText('Axial stock to leave')).not.toBeNull()
    expect(screen.getByText('Tolerance')).not.toBeNull()
    expect(screen.getByText('Auto grid resolution')).not.toBeNull()
    expect(screen.getByRole('radio', { name: /Clear all stock - everything that is not the part/i })).not.toBeNull()
    const direction = screen.getByTestId('op-adaptive3d-milling-direction')
    expect(within(direction).getByRole('button', { name: 'Climb' }).className)
      .toContain('op-toggle-active')
    expect(screen.queryByText('Enter from stock edge (side entry)')).toBeNull()

    // The 2.5D contour Passes block must NOT leak in: adaptive_3d reads none of
    // the shared stepdown/cutting-strategy/spring rows, so showing them is dead
    // carryover clutter. Guard against the negative catch-all re-including it.
    expect(screen.queryByTestId('contour-cutting-strategy')).toBeNull()
    expect(screen.queryByText('Cutting strategy')).toBeNull()
    expect(screen.queryByText('Spring passes')).toBeNull()
    expect(screen.queryByText('Depth of cut')).toBeNull()
  })

  it('hides the tabs/fields the 3D rougher ignores: no Linking tab, no Top/Bottom-of-cut', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))

    // Linking tab is filtered out (adaptive_3d does its own path linking).
    expect(screen.queryByText('Linking')).toBeNull()

    // Heights always presents the five standard conventions while the rougher's
    // Smart policy remains the authority for its machining band.
    fireEvent.click(screen.getByText('Heights'))
    for (const plane of ['clearance', 'retract', 'feed', 'top', 'bottom']) {
      expect(screen.getByTestId(`standard-height-${plane}`)).not.toBeNull()
      expect(screen.getByTestId(`standard-height-${plane}-resolved`)).not.toBeNull()
    }
    expect(screen.getByTestId('standard-height-top-source').textContent)
      .toContain('Operation Smart policy')
  })

  it('Geometry tab shows the solid part picker, defaulted to the only solid', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Geometry'))

    const sel = screen.getByTestId('op-adaptive3d-part-select') as HTMLSelectElement
    expect(sel).not.toBeNull()
    // Exactly one solid -> it is the effective default selection.
    expect(sel.value).toBe(GEO_ID)
  })

  it('shows exactly five compact collapsed height rows with no banner or prose', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Heights'))

    expect(screen.queryByTestId('starting-height-policy')).toBeNull()
    const controls = screen.getByTestId('standard-height-controls')
    const rows = within(controls).getAllByTestId(/^standard-height-(clearance|retract|feed|top|bottom)$/)
    expect(rows).toHaveLength(5)
    expect(rows.every(row => row.getAttribute('data-expanded') === 'false')).toBe(true)
    expect(screen.getByTestId('operation-height-policy-controls').hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('standard-height-feed-authority').textContent).not.toContain('Not Used')
  })

  it('expands only one row and exposes source, operator, and offset controls', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Heights'))

    fireEvent.click(within(screen.getByTestId('standard-height-retract')).getByRole('button'))
    expect(screen.getByTestId('standard-height-retract').getAttribute('data-expanded')).toBe('true')
    expect(screen.getByTestId('standard-height-clearance').getAttribute('data-expanded')).toBe('false')
    expect(screen.getByTestId('standard-height-retract-source-control')).not.toBeNull()
    expect(screen.getByTestId('standard-height-retract-operator-control')).not.toBeNull()
    expect(screen.getByTestId('standard-height-retract-offset-control')).not.toBeNull()

    fireEvent.click(within(screen.getByTestId('standard-height-top')).getByRole('button'))
    expect(screen.getByTestId('standard-height-retract').getAttribute('data-expanded')).toBe('false')
    expect(screen.getByTestId('standard-height-top').getAttribute('data-expanded')).toBe('true')
    const policyControls = screen.getByTestId('operation-height-policy-controls')
    expect(policyControls.hasAttribute('hidden')).toBe(false)
    expect(policyControls.style.gridRow).toBe('5')
    expect(screen.getByTestId('standard-height-bottom').style.gridRow).toBe('6')
    expect(within(screen.getByTestId('standard-height-clearance')).getByText('Clearance Height').style.whiteSpace)
      .toBe('nowrap')
  })

  it('Create enables once a solid + a supported cutter are chosen', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))

    // No tool yet -> Create disabled.
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)

    // Pick the flat end mill on the Tool tab.
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))

    // Solid auto-selected + supported cutter -> Create enabled.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  })

  it('authors new Adaptive 3D operations with current-material Smart Height V2 authority', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.click(within(screen.getByTestId('standard-height-retract')).getByRole('button'))
    fireEvent.change(screen.getByTestId('standard-height-retract-source-control'), {
      target: { value: 'top' },
    })
    const retractOffset = screen.getByTestId('standard-height-retract-offset-control')
      .querySelector('input') as HTMLInputElement
    fireEvent.focus(retractOffset)
    fireEvent.change(retractOffset, { target: { value: '3' } })
    fireEvent.blur(retractOffset)
    expect(screen.getByTestId('standard-height-retract-authority').textContent)
      .toContain('User Override')
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        version: 2,
        policyVersion: 1,
        policy: { operationType: 'adaptive_3d', variant: 'current_material' },
        safety: {
          retract: {
            reference: 'top',
            offsetMm: 3,
            owner: { kind: 'user_override' },
          },
        },
        machining: {
          scope: { value: { kind: 'whole_target', geometryIds: [GEO_ID] } },
        },
      },
    })
    expect(created.heights.heightIntent?.retract).toEqual({
      reference: 'top', offset: 3, provenance: 'user',
    })
  })

  // WO-1641 repin: "Rest material required" was an opt-in, and Operator retired
  // every rest opt-in on 2026-09-17 ("Rest is not an operation type. Rest is a
  // methodology."). The select no longer offers it; the default the operator
  // gets without touching anything is the material earlier operations left.
  it('offers no rest-material opt-in and authors the current-material policy by default', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.click(within(screen.getByTestId('standard-height-top')).getByRole('button'))
    const source = screen.getByTestId('adaptive3d-material-source') as HTMLSelectElement
    expect(source.value).toBe('current_material')
    expect(Array.from(source.options).map(option => option.value)).not.toContain('rest')
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2', intent: { policy: { variant: 'current_material' } },
    })
  })

  it('shows the numeric machining band returned by the shared Adaptive preflight', async () => {
    seedSolid()
    const originalPreview = useCamStore.getState().previewOperationSmartHeightPlan
    const snapshot: ResolvedHeightSnapshotV1 = {
      version: 1,
      wcs: { clearance: 27, retract: 17, feed: 12.5, top: 12, bottom: 0 },
      machine: { clearance: 27, retract: 17, feed: 12.5, top: 12, bottom: 0 },
      intent: defaultHeightIntent(),
      dependencyIds: ['stock:stock-1', `geometry:${GEO_ID}`, `tool:${TOOL_ID}`],
    }
    const preview = vi.fn(async (_setupId: string, operation: Operation) =>
      smartHeightPlanFixture(operation, snapshot))
    act(() => {
      useCamStore.setState({ previewOperationSmartHeightPlan: preview } as never)
    })

    try {
      render(<NewOperationModal />)
      act(() => { useCamStore.getState().openModal('new-operation') })
      fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
      fireEvent.click(screen.getByText('Tool'))
      fireEvent.click(screen.getByText('Flat 6mm'))
      fireEvent.click(screen.getByText('Heights'))
      fireEvent.click(within(screen.getByTestId('standard-height-top')).getByRole('button'))

      const values = await screen.findByTestId('resolved-height-plan')
      await waitFor(() => expect(preview).toHaveBeenCalled())
      expect(values.textContent).toContain('Top Height')
      expect(values.textContent).toContain('12 mm')
      expect(values.textContent).toContain('Bottom Height')
      expect(values.textContent).toContain('0 mm')
      expect(values.textContent).toContain('Feed')
      expect(values.textContent).toContain('12.5 mm')
    } finally {
      act(() => {
        useCamStore.setState({ previewOperationSmartHeightPlan: originalPreview } as never)
      })
    }
  })

  it('blocks an inverted explicit band and persists a corrected WCS band', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.click(within(screen.getByTestId('standard-height-top')).getByRole('button'))
    fireEvent.change(screen.getByTestId('adaptive3d-material-source'), { target: { value: 'bounded_band' } })
    const band = screen.getByTestId('adaptive3d-bounded-band')
    const inputs = within(band).getAllByRole('textbox') as HTMLInputElement[]
    expect(inputs).toHaveLength(2)
    fireEvent.focus(inputs[1])
    fireEvent.change(inputs[1], { target: { value: '5' } })
    fireEvent.blur(inputs[1])
    expect(screen.getByTestId('adaptive3d-bounded-band-error')).not.toBeNull()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.focus(inputs[1])
    fireEvent.change(inputs[1], { target: { value: '-8' } })
    fireEvent.blur(inputs[1])
    expect(screen.queryByTestId('adaptive3d-bounded-band-error')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { variant: 'bounded_band' },
        machining: {
          start: { value: { kind: 'explicit_plane', plane: { offsetMm: 0 } } },
          end: { value: { kind: 'bounded_plane', plane: { offsetMm: -8 } } },
        },
      },
    })
  })

  it('offers a LienCAM modeled solid as a compute-ready Adaptive 3D source', async () => {
    seedModeledSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Geometry'))

    const sel = screen.getByTestId('op-adaptive3d-part-select') as HTMLSelectElement
    expect(sel.value).toBe(MODEL_GEO_ID)
    expect(within(sel).getByText('Modeled Widget (LienCAM modeled solid)')).not.toBeNull()

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
  })

  it('reveals the Edge overshoot field + caution only when Clear whole stock is ON', () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    // OFF by default: the overshoot field + caution are NOT mounted (no hooks-order
    // break from the conditional block).
    expect(screen.queryByTestId('op-adaptive3d-overshoot')).toBeNull()

    // Toggle Clear all stock ON via its explicit roughing-scope radio.
    const clear = screen.getByRole('radio', {
      name: /Clear all stock - everything that is not the part/i,
    }) as HTMLInputElement
    expect(clear.checked).toBe(false)
    fireEvent.click(clear)
    expect(clear.checked).toBe(true)

    // Now the overshoot field + caution render; the input is blank (auto).
    expect(screen.getByTestId('op-adaptive3d-overshoot')).not.toBeNull()
    // HELP-QA-7 (4e4ff54e0): the placeholder no longer carries the resolved
    // auto value inline (it clipped to "auto (too"); it is a short "auto" with
    // the full meaning in the tooltip. Assert both halves so dropping the
    // tooltip that now carries the meaning cannot pass.
    const input = screen.getByPlaceholderText('auto') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toContain('Auto = tool radius')
    expect(input.value).toBe('')

    // Choosing Clear around part turns it back OFF and removes them again.
    fireEvent.click(screen.getByRole('radio', { name: /Clear around part/i }))
    expect(screen.queryByTestId('op-adaptive3d-overshoot')).toBeNull()
  })
})

// A ready adaptive_3d op so the PropertiesPanel edit block renders.
function seedAdaptive3dOp(): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    loops: [{ id: 'l1', points: [] }],
  } as unknown as ImportedGeometry
  const op = {
    id: 'op-a3d-1', name: '3D Rough 1', type: 'adaptive_3d', toolId: TOOL_ID,
    enabled: true, status: 'ready', geometrySelections: [GEO_ID],
    passes: { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {},
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    params: {
      maxStepdown: 3, stepover: 0.4, tolerance: 0.05, helixDiameter: 3,
      radialStockToLeave: 0, axialStockToLeave: 0, cellSize: 0, useStockBoundary: false,
    },
  } as unknown as Operation
  const setup = {
    id: SETUP_ID, name: 'Setup 1', wcs: { origin: { x: 0, y: 0, z: 0 } },
    operations: [op],
  } as unknown as Setup
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [flatTool],
      project: {
        ...s.project, geometry: [geo], setups: [setup],
        activeSetupId: SETUP_ID, activeOperationId: 'op-a3d-1',
      },
      viewer: { ...s.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    } as never))
  })
}

function seedSmartAdaptive3dOp(): void {
  seedAdaptive3dOp()
  act(() => {
    useCamStore.setState((state) => ({
      previewOperationSmartHeightPlan: previewExactPlan,
      project: {
        ...state.project,
        setups: state.project.setups.map(setup => ({
          ...setup,
          operations: setup.operations.map(operation => operation.id === 'op-a3d-1'
            ? {
                ...operation,
                smartHeight: {
                  kind: 'smart_v2',
                  intent: buildAdaptive3dSmartIntent({
                    setupId: SETUP_ID,
                    geometryIds: [GEO_ID],
                    safetyIntent: defaultHeightIntent(),
                    mode: 'current_material',
                  }),
                },
              }
            : operation),
        })),
      },
    }))
  })
}

describe('PropertiesPanel adaptive_3d edit smoke', () => {
  it('renders the editable param block for an adaptive_3d op (hooks-order gate)', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
    expect(screen.getByTestId('props-adaptive3d-edit')).not.toBeNull()
    // The adaptive_3d-specific rows render (not the shared stepdown/stock rows).
    expect(screen.getByText('Max stepdown')).not.toBeNull()
    expect(screen.getByText('Stepover (fraction)')).not.toBeNull()
    expect(screen.getByText('Wall lead-in radius')).not.toBeNull()
    expect(screen.getByText('Wall lead-out radius')).not.toBeNull()
    expect(screen.getByText('Loopback fillet')).not.toBeNull()
    expect(screen.getByText('Integral wall-follow')).not.toBeNull()
    expect(screen.getByText('Maximum direct wall ride')).not.toBeNull()
    expect(screen.getByRole('radio', { name: /Clear all stock - everything that is not the part/i })).not.toBeNull()
  })

  it('requires a V2 material-source choice for an operation without valid authority', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('props-adaptive3d-repair-height-note')).not.toBeNull()
    const source = screen.getByRole('combobox', { name: 'Adaptive material source' }) as HTMLSelectElement
    expect(source.value).toBe('repair_required')
    fireEvent.change(source, { target: { value: 'initial_stock' } })
    const updated = useCamStore.getState().project.setups[0].operations[0]
    expect(updated.smartHeight).toMatchObject({
      kind: 'smart_v2', intent: { policy: { variant: 'initial_stock' } },
    })
    expect(updated.status).toBe('pending')
  })

  it('keeps Adaptive V2 safety edits in the authoritative intent', async () => {
    seedSmartAdaptive3dOp()
    render(<PropertiesPanel />)
    await waitFor(() => {
      // WO-2007 (CS 21): the live plan is read from the height rows, not a diagnostics copy.
      expect(screen.queryByTestId('props-live-height-plan-loading')).toBeNull()
      expect(screen.getByTestId('props-height-value-bottom').textContent).toMatch(/ mm WCS/)
    })
    const clearanceRow = screen.getByTestId('props-height-row-clearance')
    const clearance = clearanceRow.querySelector('input') as HTMLInputElement
    fireEvent.focus(clearance)
    fireEvent.change(clearance, { target: { value: '22' } })
    fireEvent.blur(clearance)
    const updated = useCamStore.getState().project.setups[0].operations[0]
    expect(updated.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { variant: 'current_material' },
        safety: { clearance: { offsetMm: 22 } },
      },
    })
  })

  it('shows a Cancel button only while an adaptive_3d op is computing; clicking it is safe', () => {
    seedAdaptive3dOp() // seeded status: 'ready'
    render(<PropertiesPanel />)
    // Idle op -> no cancel control.
    expect(screen.queryByTestId('props-adaptive3d-cancel')).toBeNull()

    // Flip the op to 'computing' -> the store subscription re-renders the panel.
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((st) => ({
            ...st,
            operations: st.operations.map((o) =>
              o.id === 'op-a3d-1' ? { ...o, status: 'computing' } : o,
            ),
          })),
        },
      } as never))
    })
    const cancelBtn = screen.getByTestId('props-adaptive3d-cancel')
    expect(cancelBtn).not.toBeNull()

    // No live compute is registered (no tracked aborter), so the wired action is
    // a safe no-op — it must not throw when clicked.
    expect(() => fireEvent.click(cancelBtn)).not.toThrow()
    expect(typeof useCamStore.getState().cancelAdaptive3dCompute).toBe('function')
    // Calling the action directly with an unknown opId is also a no-op.
    expect(() => useCamStore.getState().cancelAdaptive3dCompute('no-such-op')).not.toThrow()
  })

  it('toggling clip-to-stock writes op.params and marks the op outdated', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)

    const block = screen.getByTestId('props-adaptive3d-edit')
    // Select Clear all stock by its explicit radio label, not by control position.
    const clip = within(block).getByRole('radio', {
      name: /Clear all stock - everything that is not the part/i,
    }) as HTMLInputElement
    expect(clip.checked).toBe(false)
    fireEvent.click(clip)

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect((op.params as { useStockBoundary?: boolean }).useStockBoundary).toBe(true)
    expect(op.status).toBe('outdated')
  })

  it('defaults to climb and persists an explicit conventional direction', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)

    const direction = screen.getByTestId('props-adaptive3d-milling-direction') as HTMLSelectElement
    expect(direction.value).toBe('climb')
    // WO-2007 fix round (CS 21): the fixed 'Entry' read-out is gone - nothing to change there.
    expect(screen.queryByText('Automatic closed-region entry')).toBeNull()
    fireEvent.change(direction, { target: { value: 'conventional' } })

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect((op.params as { millingDirection?: string }).millingDirection).toBe('conventional')
    expect(op.status).toBe('outdated')
  })

  it('persists Adaptive 3D wall-transition and loopback controls', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)

    const edit = screen.getByTestId('props-adaptive3d-edit')
    const inputFor = (label: string): HTMLInputElement => {
      const row = within(edit).getByText(label).closest('.props-group')
      const input = row?.querySelector('input')
      if (!(input instanceof HTMLInputElement)) throw new Error(`missing input for ${label}`)
      return input
    }
    const leadIn = inputFor('Wall lead-in radius')
    const leadOut = inputFor('Wall lead-out radius')
    const loopback = inputFor('Loopback fillet')
    const maxWallRide = inputFor('Maximum direct wall ride')
    const wallFollowRow = within(edit).getByText('Integral wall-follow').closest('.props-group')
    const wallFollow = wallFollowRow?.querySelector('input')
    if (!(wallFollow instanceof HTMLInputElement)) throw new Error('missing integral wall-follow input')
    expect(leadIn.value).toBe('0')
    expect(leadOut.value).toBe('0')
    expect(loopback.value).toBe('25')
    expect(wallFollow.checked).toBe(true)
    expect(maxWallRide.value).toBe('200')

    fireEvent.change(leadIn, { target: { value: '1.5' } })
    fireEvent.blur(leadIn)
    fireEvent.change(leadOut, { target: { value: '2.5' } })
    fireEvent.blur(leadOut)
    fireEvent.change(loopback, { target: { value: '40' } })
    fireEvent.blur(loopback)
    fireEvent.change(maxWallRide, { target: { value: '300' } })
    fireEvent.blur(maxWallRide)
    fireEvent.click(wallFollow)

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.params).toMatchObject({
      wallLeadInRadius: 1.5,
      wallLeadOutRadius: 2.5,
      loopbackFilletPct: 40,
      integralWallFollow: false,
      integralWallFollowLengthFactor: 3,
    })
    expect(op.status).toBe('outdated')
  })

  it('default render (op just created) has useStockBoundary off and NO overshoot field', () => {
    seedAdaptive3dOp() // seeded params: useStockBoundary false, no stockEdgeOvershoot
    render(<PropertiesPanel />)
    // The edit block mounted (no hooks-order break) but the optional field is absent.
    expect(screen.getByTestId('props-adaptive3d-edit')).not.toBeNull()
    expect(screen.queryByTestId('props-adaptive3d-overshoot-caution')).toBeNull()
    expect(screen.queryByText('Edge overshoot')).toBeNull()
    // HELP-QA-7 (4e4ff54e0) shortened this placeholder to a bare "auto", which
    // other optional fields also use -- so querying the OLD "auto (tool radius)"
    // string here would now pass vacuously no matter what rendered. Identify the
    // field by the tooltip that carries its meaning instead.
    expect(
      screen.queryAllByPlaceholderText('auto')
        .filter((el) => (el.getAttribute('data-tooltip') ?? '').includes('Auto = tool radius')),
    ).toEqual([])
  })

  it('reveals Edge overshoot when Clear whole stock is on; edits write a number, clearing writes undefined (auto); each marks outdated', () => {
    seedAdaptive3dOp()
    render(<PropertiesPanel />)

    const block = screen.getByTestId('props-adaptive3d-edit')
    // Select Clear all stock by its explicit radio label, not by control position.
    const clear = within(block).getByRole('radio', {
      name: /Clear all stock - everything that is not the part/i,
    }) as HTMLInputElement
    expect(clear.checked).toBe(false)
    fireEvent.click(clear)

    // Field + caution now render.
    expect(screen.getByTestId('props-adaptive3d-overshoot-caution')).not.toBeNull()
    // HELP-QA-7 (4e4ff54e0): short "auto" placeholder, meaning in the tooltip.
    const input = screen.getByPlaceholderText('auto') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toContain('Auto = tool radius')
    expect(input.value).toBe('') // auto (undefined) shows blank

    const params = () =>
      useCamStore.getState().project.setups[0].operations[0].params as {
        useStockBoundary?: boolean; stockEdgeOvershoot?: number
      }
    // Toggling on already wrote the boolean + marked outdated.
    expect(params().useStockBoundary).toBe(true)
    expect(params().stockEdgeOvershoot).toBeUndefined()

    // Type a finite value and commit (blur) -> writes a number, marks outdated.
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.blur(input)
    expect(params().stockEdgeOvershoot).toBe(1.5)
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('outdated')

    // Clear the field back to blank -> writes undefined (AUTO round-trip).
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(params().stockEdgeOvershoot).toBeUndefined()
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('outdated')
  })
})
