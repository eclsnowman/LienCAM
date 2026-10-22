// @vitest-environment jsdom
//
// CAM-BINDING Stage 1 (coordination/work-orders/CAM-BINDING.md): the op-picker
// gate. Real-mount, real-pick proof that a modeled body (format:'model') now
// appears in the New Operation wizard's geometry step next to imported STEP/
// STL parts, for BOTH the 2D/2.5D source list (operationSourceGeometries) and
// the 3D solid list (parallel3dSolids), and can be selected the same way an
// imported part can - via the dropdown AND via the viewport whole-part picker
// (mirrors the precedent in NewOperationModalSourcePartPick.ui60.test.tsx,
// which this file extends rather than duplicates).
//
// Mutation-provable (per the charter's Stage 1 test plan): reverting either
// `isModelOpSourceEligible(g) ||` clause in NewOperationModal.tsx's
// `operationSourceGeometries`/`parallel3dSolids` filters back to a bare
// `!isModelOriginGeometry(g) && ...` turns the corresponding "appears in the
// list" assertion below RED (the model row silently disappears from
// `options`/`allowedPartIds`) - restoring the OR turns it GREEN again. Run by
// hand at Stage 1 gate time; not re-run automatically every CI pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Setup } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const CURVES_ID = 'curves-source'
const SOLID_ID = 'solid-source'
const MODEL_ID = 'modelbody:F1'
// Commit 2e5678b7 (Smart Height V2 cutover): a real (unstubbed) contour_2d
// preflight - the end-to-end Create test below runs one - needs a proven
// Setup stock: wcs.stockId naming a PhysicalStock in project.stocks, and the
// target geometry's own stockId agreeing with it (store/index.ts's
// resolveContourSmartRuntime).
const STOCK_ID = 'stock-cam-binding'
const stock = {
  id: STOCK_ID,
  name: 'CAM-Binding Stock',
  mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 20 },
    size: { x: 100, y: 100, z: 20 }, center: { x: 50, y: 50, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
}
let pickedPart: ((id: string) => void) | null = null
let allowedPartIds: readonly string[] = []

function seedProject() {
  const geometry = [
    {
      id: CURVES_ID,
      name: 'Plate profile',
      type: 'curves_2d',
      format: 'svg',
      loaded: true,
      stockId: STOCK_ID,
      loops: [{
        id: 'outer',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
        closed: true,
        type: 'contour',
        layerId: 'layer-1',
        area: 100,
      }],
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 0 },
      },
    },
    {
      id: SOLID_ID,
      name: 'Solid body',
      type: 'mesh',
      format: 'stl',
      loaded: true,
      stockId: STOCK_ID,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 5 },
      },
    },
    // CAM-BINDING Stage 1: a live Model-workbench body surfaced as a CAM
    // geometry entry (INT-17A's own shape - modelBodyAdapter.ts's
    // buildModelBodyGeometry). No loops, type:'model', format:'model' -
    // exactly the row Stage 1's relaxed filters must now admit.
    {
      id: MODEL_ID,
      name: 'Model F1',
      type: 'model',
      format: 'model',
      filename: 'Model F1',
      loaded: true,
      stockId: STOCK_ID,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 20, y: 20, z: 10 },
      },
      modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: null,
    operations: [],
    notes: '',
  } as unknown as Setup

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      stocks: [stock],
      activeSetupId: setup.id,
    },
  } as never)
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickedPart = null
  allowedPartIds = []
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: (
      callback: ((id: string) => void) | null,
      allowedIds: readonly string[] = [],
    ) => {
      pickedPart = callback
      allowedPartIds = allowedIds
    },
    setSelectedPart: vi.fn(),
  }
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('CAM-BINDING Stage 1: modeled body appears as a selectable op source (2D/2.5D)', () => {
  it('the model row is offered in the geometry dropdown, next to the imported part', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    const optionIds = Array.from(select.options).map((o) => o.value)
    expect(optionIds).toContain(CURVES_ID)
    expect(optionIds).toContain(MODEL_ID) // <- the Stage 1 relaxation itself
    // Named, honest label - never claims loops/computability it does not have.
    // CAM-BINDING Stage 2: the default op type (contour_2d) now HAS a real
    // compute path for a modeled body, so the label no longer claims
    // "compute pending" for it - see the 3D-solid describe block below for
    // the op-type that Stage 2 does NOT cover, where the old wording stays.
    const modelOption = Array.from(select.options).find((o) => o.value === MODEL_ID)
    expect(modelOption?.textContent).toMatch(/modeled body/i)
    expect(modelOption?.textContent).not.toMatch(/compute pending/i)
  })

  it('the model row is offered through the viewport whole-part picker too', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-pick-source-part'))

    expect(allowedPartIds).toContain(MODEL_ID)
    const choose = pickedPart
    expect(choose).not.toBeNull()
    act(() => { choose?.(MODEL_ID) })

    expect((screen.getByTestId('op-geometry-select') as HTMLSelectElement).value)
      .toBe(MODEL_ID)
  })

  it('selecting the model row from the dropdown directly sets it as the op source', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: MODEL_ID } })
    expect(select.value).toBe(MODEL_ID)
    // Stage 1 is a whole-body pick: face/edge-level B-rep derive surfaces
    // (Pick face, Pick edges) stay keyed on type==='brep' only - per-face
    // identity is Stage 5 territory, never offered for a model-origin row.
    expect(screen.queryByTestId('brep-pick-face')).toBeNull()
    expect(screen.queryByTestId('brep-pick-edges')).toBeNull()
    // CAM-BINDING Stage 4: Section-at-Z DOES now offer itself for a
    // model-origin row (the generic "Section at Z -> pocket" flow extended
    // to a modeled body's own tessellation) - see
    // NewOperationModalModelSource.camBindingStage4.test.tsx for full
    // coverage of that surface; this Stage 1 test only pins that the
    // whole-body-only face/edge pickers stay gone.
    expect(screen.queryByTestId('brep-section-z')).not.toBeNull()
  })

  it('keeps model-body contour sources closed-only, including after open curves were armed', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: CURVES_ID } })
    fireEvent.click(screen.getByTestId('contour-path-open'))
    expect(screen.getByTestId('contour-path-open').className).toContain('op-toggle-active')

    fireEvent.change(select, { target: { value: MODEL_ID } })
    expect(select.value).toBe(MODEL_ID)
    expect(screen.queryByTestId('contour-path-open')).toBeNull()
    expect(screen.getByTestId('contour-path-closed').className).toContain('op-toggle-active')
    expect(screen.queryByTestId('contour-path-empty')).toBeNull()
  })
})

describe('CAM-BINDING Stage 1: end-to-end - Create lands the op on the named pending-compute state, never a toolpath, never a crash', () => {
  const TOOL_ID = 'tool-stage1-e2e'
  const seedTool = () => {
    act(() => {
      const st = useCamStore.getState()
      if (!st.toolLibrary.some((t) => t.id === TOOL_ID)) {
        st.addTool({
          id: TOOL_ID, name: 'Stage1 4mm Flat', type: 'flat_end_mill',
          diameter: 4, fluteLength: 20, shankDiameter: 6, overallLength: 50,
          numberOfFlutes: 2, material: 'carbide', coating: 'none',
          notes: '', feedsAndSpeeds: {},
        } as unknown as Parameters<typeof st.addTool>[0])
      }
    })
  }

  it('picking the modeled body and pressing Create Operation: op lands on \'unsupported\', not \'ready\' and not \'error\'', async () => {
    seedTool()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    fireEvent.click(screen.getByText('Tool'))
    act(() => { fireEvent.click(screen.getByText('Stage1 4mm Flat')) })

    fireEvent.click(screen.getByText('Geometry'))
    const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: MODEL_ID } })

    const createBtn = screen.getByTestId('op-create') as HTMLButtonElement
    // Commit 2e5678b7: Create stays disabled until the async Smart Height V2
    // preflight (previewOperationSmartHeightPlan) resolves.
    await waitFor(() => expect(createBtn.disabled).toBe(false))
    act(() => { fireEvent.click(createBtn) })

    // WO-3059: since WO-3055 (cff84a2c7d) compute derives a modeled-body source through the
    // async deriveModelOriginGeoSources, so the refusal lands a microtask after Create. Wait
    // for compute to leave 'pending'; the status it lands on is still pinned below.
    await waitFor(() => expect(useCamStore.getState().project.setups[0].operations[0]?.status).not.toBe('pending'))
    const ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(1)
    const op = ops[0]
    // The charter's own acceptance test, verbatim: "confirm the op is created
    // in a named 'pending compute support' state (not 'ready', not silently
    // 'error')".
    expect(op.status).toBe('unsupported')
    expect(op.status).not.toBe('ready')
    expect(op.status).not.toBe('error')
    expect(op.errorMessage ?? '').toMatch(/Model F1/)
    // CAM-BINDING Stage 2: contour_2d has a real compute path now, but this
    // fixture's modeled body carries no display payload (never regenerated
    // through the Model tab in this render-gate test), so the op lands on a
    // derive-failure message rather than Stage 1's generic "not yet
    // available" placeholder text - still 'unsupported', still named.
    expect(op.errorMessage ?? '').toMatch(/profile could not be derived/)
    expect(op.toolpathMoves ?? []).toHaveLength(0)

    // The charter's acceptance test, second half, AS IT STOOD AT STAGE 1: the
    // modeled body remained read-only for BOTH stock-binding and delete. CAM-
    // BINDING Stage 3 later reverses the stock-binding refusal specifically
    // (this exact seam) - setStockMembership now accepts a modeled entry, so
    // a bogus/non-existent stock id fails on the SAME generic ADR-0003
    // phantom-stock guard every geometry hits, not a model-origin refusal.
    // Delete stays refused (Stage 3 does not touch it - assertion below,
    // unchanged from Stage 1).
    expect(() => useCamStore.getState().setStockMembership(MODEL_ID, 'some-stock'))
      .toThrow(/no PhysicalStock with id "some-stock"/)
    // removeGeometry refuses loud-but-non-throwing (console.error + no-op) -
    // it is reachable from user gestures, so a throw there would crash the
    // app rather than just refuse the action (store/index.ts's own comment).
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const countBefore = useCamStore.getState().project.geometry.length
    act(() => { useCamStore.getState().removeGeometry(MODEL_ID) })
    expect(consoleErr).toHaveBeenCalledWith(expect.stringMatching(/refusing modeled geometry "Model F1"/))
    consoleErr.mockRestore()
    expect(useCamStore.getState().project.geometry.length).toBe(countBefore) // refused, not deleted
    expect(useCamStore.getState().project.geometry.some((g) => g.id === MODEL_ID)).toBe(true)
  })
})

describe('CAM-BINDING Stage 1: modeled body appears as a selectable op source (3D solid ops)', () => {
  it('the model row is offered in the parallel_3d solid dropdown, next to the imported solid', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))

    const select = screen.getByTestId('op-parallel3d-part-select') as HTMLSelectElement
    const optionIds = Array.from(select.options).map((o) => o.value)
    expect(optionIds).toContain(SOLID_ID)
    expect(optionIds).toContain(MODEL_ID)
    const modelOption = Array.from(select.options).find((o) => o.value === MODEL_ID)
    expect(modelOption?.textContent).toMatch(/modeled body/i)
  })

  it('the model row is offered through the viewport whole-part picker for parallel_3d too', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-parallel3d-pick-source'))

    expect(allowedPartIds).toContain(MODEL_ID)
    const choose = pickedPart
    act(() => { choose?.(MODEL_ID) })

    expect((screen.getByTestId('op-parallel3d-part-select') as HTMLSelectElement).value)
      .toBe(MODEL_ID)
  })
})
