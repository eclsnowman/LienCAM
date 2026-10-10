// @vitest-environment jsdom
//
// CAM-BINDING Stage 5 (face boundaries): the op wizard's new "Machining
// boundary" block - pick a SINGLE face on a modeled body as the op's
// durable machining-boundary ModelReference. Real-render regression (tsc +
// pure vitest cannot catch hooks-order/mount behavior): mounts the real
// modal, seeds a model row with per-face identity (faceIds/triFace), and
// drives the pick through a stubbed viewport handle exactly like
// NewOperationModalPickedPlane.smoke.test.tsx's own datum-pick precedent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ImportedGeometry, ModelItemPlacementRecord, PhysicalStock, Setup } from '../../types'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'

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
if (typeof globalThis.Worker === 'undefined') {
  class WorkerStub {
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  Object.defineProperty(globalThis, 'Worker', { value: WorkerStub, configurable: true })
}

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const MODEL_ID = 'modelbody:F1'
// Q-92: a SECOND modeled body that is never preselected. A face click on it
// must resolve its own owning body without the operator selecting it first.
const OTHER_MODEL_ID = 'modelbody:F2'

// A flat 20x20 top-cap face ("F_top") + a 5x5 bottom-cap face ("F_bottom"),
// each tagged via triFace/faceIds - the same fixture shape
// modelBodyDeriveFace.camBindingStage5.test.ts already proves derives
// correctly; this file only exercises the UI wiring around it.
function rectCapMesh(w: number, h: number, z: number): { positions: number[]; indices: number[] } {
  const pts = [{ x: 0, y: 0 }, { x: 0, y: h }, { x: w, y: h }, { x: w, y: 0 }]
  return { positions: pts.flatMap((p) => [p.x, p.y, z]), indices: [0, 1, 2, 0, 2, 3] }
}
function mergeFaces(
  parts: Array<{ positions: number[]; indices: number[] }>, faceIds: string[],
): { positions: number[]; indices: number[]; triFace: number[]; faceIds: string[] } {
  const positions: number[] = []; const indices: number[] = []; const triFace: number[] = []
  for (let f = 0; f < parts.length; f++) {
    const base = positions.length / 3
    positions.push(...parts[f].positions)
    for (const idx of parts[f].indices) indices.push(idx + base)
    for (let t = 0; t < parts[f].indices.length / 3; t++) triFace.push(f)
  }
  return { positions, indices, triFace, faceIds }
}

// EXPLICIT (not 'derived'): Smart Height V2's Contour/PlanarRough authority
// resolves machining "start" as the owning stock's OWN top (kind:
// 'current_material', src/lib/cam/smartHeights/resolve.ts) and refuses a
// target/Setup pair whose stock assignments do not agree (src/store/index.ts,
// "belongs to stock '...', not this Setup's stock"). 'explicit' bounds are
// read verbatim (stockWorldBounds) - deterministic, and tall enough (top=12)
// to clear the 10mm-tall model bodies below it.
function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'explicit',
    bounds: {
      min: { x: -5, y: -5, z: 0 }, max: { x: 25, y: 25, z: 12 },
      size: { x: 30, y: 30, z: 12 }, center: { x: 10, y: 10, z: 6 },
    },
    position: { x: -5, y: -5, z: 0 },
  } as unknown as PhysicalStock
}

function seedProject() {
  const bottom = rectCapMesh(5, 5, 0)
  const top = rectCapMesh(20, 20, 10)
  const mesh = mergeFaces([bottom, top], ['F_bottom', 'F_top'])
  const geometry = [
    {
      id: MODEL_ID,
      name: 'Model F1',
      type: 'model',
      format: 'model',
      filename: 'Model F1',
      loaded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
      // Smart Height V2 refuses a target whose OWN stock assignment does not
      // match the Setup's proven stock - see derivedStock() above.
      stockId: DERIVED_STOCK_ID, stockIdLocked: true,
      modelItemId: 'legacy',
      modelBody: {
        ref: { bodyId: 'F1', stableIds: mesh.faceIds, version: 1 },
        display: {
          positions: mesh.positions, normals: [], indices: mesh.indices,
          edgePositions: [], edgeOffsets: [],
          bbox: { min: [0, 0, 0], max: [20, 20, 10] },
          faceIds: mesh.faceIds, triFace: mesh.triFace,
        },
      },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Smart Height V2 proves the Setup's stock through this legacy binding
      // (workOffsets.ts's wcsBoundStockId).
      stockId: DERIVED_STOCK_ID,
    },
    defaultHeightIntent: {
      ...defaultHeightIntent(),
      clearance: { reference: 'retract', offset: 22, provenance: 'user' },
    },
    stock: null, operations: [], notes: '',
  } as unknown as Setup
  const modelItemPlacements: ModelItemPlacementRecord[] = [
    { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ]
  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project, geometry, stocks: [derivedStock()],
      setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
    toolLibrary: [{
      id: 't1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
  })
}

// Q-92: add a SECOND modeled body ("F2") beside the seeded one, offset in X so
// it is unmistakably a different part. Its faces carry their own stable ids.
function seedSecondBody() {
  const bottom = rectCapMesh(5, 5, 0)
  const top = rectCapMesh(20, 20, 10)
  const mesh = mergeFaces([bottom, top], ['G_bottom', 'G_top'])
  const second = {
    id: OTHER_MODEL_ID,
    name: 'Model F2',
    type: 'model',
    format: 'model',
    filename: 'Model F2',
    loaded: true,
    position: { x: 60, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: 'F2', stableIds: mesh.faceIds, version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [20, 20, 10] },
        faceIds: mesh.faceIds, triFace: mesh.triFace,
      },
    },
  } as unknown as ImportedGeometry
  const current = useCamStore.getState()
  useCamStore.setState({
    project: { ...current.project, geometry: [...current.project.geometry, second] },
  })
}

// The stubbed viewport handle: setBrepPickMode captures its callback so the
// test can invoke it directly (simulating a real click-on-face), same shape
// CNCViewport.setBrepPickMode's real contract returns.
type PickCallback = (sel: { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean }) => void
let capturedPickCallback: PickCallback | null = null
let lastPickCallback: PickCallback | null = null
let setSelectedPartSpy: ReturnType<typeof vi.fn>
let setBrepPickModeSpy: ReturnType<typeof vi.fn>
function stubViewport() {
  capturedPickCallback = null
  lastPickCallback = null
  setSelectedPartSpy = vi.fn()
  setBrepPickModeSpy = vi.fn((kind: string | null, cb?: PickCallback | null) => {
    if (kind !== null && cb) {
      capturedPickCallback = cb
      lastPickCallback = cb
    } else {
      capturedPickCallback = null
    }
  })
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    clearScene: vi.fn(),
    rebuildStock: vi.fn(),
    setPartPickMode: vi.fn(),
    setSelectedPart: setSelectedPartSpy,
    setBrepPickMode: setBrepPickModeSpy,
    setPickedBrepSelections: vi.fn(),
  }
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  stubViewport()
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openWizardOnModelSource() {
  const view = render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: MODEL_ID } })
  return view
}

function openAdaptiveWizardOnModelSource() {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('2D Adaptive Clearing'))
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: MODEL_ID } })
}

function selectOwningBody() {
  act(() => { useCamStore.getState().setSelectedGeometry(MODEL_ID) })
  expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
}

describe('CAM-BINDING Stage 5: "Machining boundary" block - visibility', () => {
  it('shows the Pick-face button + no-pick hint for a model source on the default contour op', () => {
    seedProject()
    openWizardOnModelSource()

    expect(screen.getByTestId('machining-boundary-pick')).toBeTruthy()
    expect(screen.getByTestId('machining-boundary-pick').textContent).toContain('Pick face on model')
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
    expect(screen.queryByTestId('machining-boundary-clear')).toBeNull()
  })

  it('does NOT show the block for a non-model (ordinary) source', () => {
    seedProject()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    // Default op has no geometry selected (isAllGeo) - still no model source.
    expect(screen.queryByTestId('machining-boundary-pick')).toBeNull()
  })

  it('does NOT show the block for an op type Stage 2 never computes against (drill)', () => {
    seedProject()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Type & Name'))
    fireEvent.click(screen.getByText('Drill'))
    fireEvent.click(screen.getByText('Geometry'))
    const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: MODEL_ID } })
    expect(screen.queryByTestId('machining-boundary-pick')).toBeNull()
  })
})

describe('CAM-BINDING Stage 5: picking a face end-to-end (no crash, real store write on Save)', () => {
  it('picking a REAL face updates the readout, and Save writes a real modelReferences entry on the created op', async () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    expect(capturedPickCallback).not.toBeNull()
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)
    // Q-92: arming a face pick turns whole-body selection OFF entirely.
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()

    // Simulate a real click on the TOP face (local array index 1, "F_top").
    act(() => {
      capturedPickCallback!({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })

    await waitFor(() => {
      expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('F_top')
    })
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.queryByTestId('machining-boundary-pick-error')).toBeNull()
    expect(screen.getByTestId('machining-boundary-clear')).toBeTruthy()

    // Save (Create Operation) - a real op lands in the store with a real
    // machining-boundary ModelReference to the picked face. Tool tab: click
    // the seeded tool's own row (the modal's tool picker is a clickable list,
    // not a <select>).
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('EM6'))
    // Commit 2e5678b7 made a valid Smart Height V2 envelope the only runtime
    // authority: Create Operation stays disabled until the modal's own
    // Contour preflight resolves one. Mirrors waitForContourHeightReady() in
    // NewOperationModalLoops.smoke.test.tsx, the worked example for this gate.
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => {
      const refusal = screen.queryByTestId('contour-height-preflight-error')
      if (refusal) throw new Error(refusal.textContent ?? 'Contour Smart Height preflight refused without a message')
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))

    await waitFor(() => {
      const setup = useCamStore.getState().project.setups[0]
      expect(setup.operations.length).toBe(1)
    })
    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.modelReferences).toEqual([{ bodyId: 'F1', stableIds: ['F_top'], role: 'machining-boundary' }])
    expect(op.heights.clearanceHeight).toBe(27)
  })

  it('the face pick is armed unscoped so any eligible body can be clicked directly', () => {
    seedProject()
    seedSecondBody()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    // Q-92: no allowedGeoId - the raycast is NOT narrowed to the preselected
    // body, which is what made a face on any other body silently unclickable.
    expect(setBrepPickModeSpy).toHaveBeenLastCalledWith('face', expect.any(Function), null)
  })

  it('a face on a NEVER-selected second body resolves its own owner and becomes the source', async () => {
    seedProject()
    seedSecondBody()
    selectOwningBody()
    openWizardOnModelSource()
    expect((screen.getByTestId('op-geometry-select') as HTMLSelectElement).value).toBe(MODEL_ID)

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()

    // A real click lands on body F2's top face. F2 was never selected, and F1
    // is the body that WAS. The hit's own geoId must win.
    act(() => {
      capturedPickCallback!({ geoId: OTHER_MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })

    await waitFor(() => {
      expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('G_top')
    })
    expect(screen.queryByTestId('machining-boundary-pick-error')).toBeNull()
    expect((screen.getByTestId('op-geometry-select') as HTMLSelectElement).value).toBe(OTHER_MODEL_ID)
    // Leaving face-pick mode re-selects the body the face named, not the stale
    // body that was selected before arming.
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(OTHER_MODEL_ID)
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(OTHER_MODEL_ID)

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('EM6'))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => {
      const refusal = screen.queryByTestId('contour-height-preflight-error')
      if (refusal) throw new Error(refusal.textContent ?? 'Contour Smart Height preflight refused without a message')
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))

    await waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    })
    const created = useCamStore.getState().project.setups[0].operations[0]
    // The STALE preselected body ("F1") must never be the bound identity.
    expect(created.modelReferences).toEqual([
      { bodyId: 'F2', stableIds: ['G_top'], role: 'machining-boundary' },
    ])
    expect((created.params as { geometryId?: string }).geometryId).toBe(OTHER_MODEL_ID)
  })

  it('a face hit that resolves to no loaded body fails loud and binds nothing', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    act(() => {
      capturedPickCallback!({ geoId: 'modelbody:GONE', kind: 'face', index: 1, isModelFace: true })
    })

    expect(screen.getByTestId('machining-boundary-pick-error').textContent)
      .toMatch(/no longer loaded/i)
    // No silent fallback to the body that happened to be preselected.
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
    expect(screen.queryByTestId('machining-boundary-clear')).toBeNull()
    // Exiting the failed pick restores ordinary whole-body selection.
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
  })

  it('a pick resolving to a non-model face is refused, exits pick presentation, and restores selection', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    // The pick collapses the full modal to the floating pick banner (same
    // mechanism the brep face/edge/datum picks already use, so the viewport
    // is actually clickable) - the refusal surfaces IN that banner, not the
    // full-form error span (which only renders while the banner is absent).
    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    expect(screen.queryByTestId('machining-boundary-pick')).toBeNull()
    act(() => {
      capturedPickCallback!({ geoId: MODEL_ID, kind: 'face', index: 0, isModelFace: false })
    })

    expect(screen.getByTestId('machining-boundary-pick-error').textContent).toMatch(/not a modeled-body face/i)
    expect(screen.queryByTestId('brep-pick-cancel')).toBeNull()
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
    expect(screen.queryByTestId('machining-boundary-clear')).toBeNull()
  })

  it('Cancel restores both the logical body selection and its viewport highlight', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    const staleCallback = lastPickCallback
    expect(staleCallback).not.toBeNull()
    if (!staleCallback) throw new Error('Expected the viewport to register a face-pick callback')
    // Q-92: while armed, NEITHER the store nor the viewport asserts a body.
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()

    fireEvent.click(screen.getByTestId('brep-pick-cancel'))
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')

    const presentationCallCount = setSelectedPartSpy.mock.calls.length
    act(() => {
      staleCallback({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    expect(setSelectedPartSpy).toHaveBeenCalledTimes(presentationCallCount)
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
  })

  it('a viewport picker startup error restores presentation and reports the failure', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()
    setBrepPickModeSpy.mockImplementationOnce(() => { throw new Error('picker start failed') })

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))

    expect(screen.getByTestId('machining-boundary-pick-error').textContent).toContain('picker start failed')
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.queryByTestId('brep-pick-cancel')).toBeNull()
  })

  it('modal teardown restores presentation and a stale face callback cannot write after close', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    const staleCallback = lastPickCallback
    expect(staleCallback).not.toBeNull()
    if (!staleCallback) throw new Error('Expected the viewport to register a face-pick callback')
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)

    act(() => { useCamStore.getState().closeModal() })
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.queryByTestId('machining-boundary-readout')).toBeNull()

    act(() => {
      staleCallback({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)
    expect(screen.queryByTestId('machining-boundary-readout')).toBeNull()
  })

  it('newProject tears down the presentation session and rejects its stale callback', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    const staleCallback = lastPickCallback
    expect(staleCallback).not.toBeNull()
    if (!staleCallback) throw new Error('Expected the viewport to register a face-pick callback')
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)

    act(() => { useCamStore.getState().newProject() })
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()
    expect(setSelectedPartSpy).not.toHaveBeenCalledWith(MODEL_ID)
    expect(screen.queryByTestId('machining-boundary-readout')).toBeNull()

    const presentationCallCount = setSelectedPartSpy.mock.calls.length
    act(() => {
      staleCallback({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    expect(setSelectedPartSpy).toHaveBeenCalledTimes(presentationCallCount)
    expect(useCamStore.getState().project.geometry).toEqual([])
  })

  it('component unmount restores presentation and rejects its stale callback', () => {
    seedProject()
    selectOwningBody()
    const view = openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    const staleCallback = lastPickCallback
    expect(staleCallback).not.toBeNull()
    if (!staleCallback) throw new Error('Expected the viewport to register a face-pick callback')
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)

    view.unmount()
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)

    const presentationCallCount = setSelectedPartSpy.mock.calls.length
    act(() => {
      staleCallback({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    expect(setSelectedPartSpy).toHaveBeenCalledTimes(presentationCallCount)
  })

  it('direct new-to-edit replacement restores presentation and rejects the replaced callback', () => {
    seedProject()
    selectOwningBody()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    const staleCallback = lastPickCallback
    expect(staleCallback).not.toBeNull()
    if (!staleCallback) throw new Error('Expected the viewport to register a face-pick callback')
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(null)

    act(() => { useCamStore.getState().openEditOperation('setup-1', 'replacement-op') })
    expect(setSelectedPartSpy).toHaveBeenLastCalledWith(MODEL_ID)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe(MODEL_ID)

    const presentationCallCount = setSelectedPartSpy.mock.calls.length
    act(() => {
      staleCallback({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    expect(setSelectedPartSpy).toHaveBeenCalledTimes(presentationCallCount)
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
  })

  it('"Clear" removes a picked face and reverts the readout to the no-pick hint', async () => {
    seedProject()
    openWizardOnModelSource()

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true }) })
    await waitFor(() => expect(screen.getByTestId('machining-boundary-clear')).toBeTruthy())

    fireEvent.click(screen.getByTestId('machining-boundary-clear'))
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
    expect(screen.queryByTestId('machining-boundary-clear')).toBeNull()
  })

  it('adaptive create and edit preserve the durable picked-face boundary', async () => {
    seedProject()
    openAdaptiveWizardOnModelSource()

    expect(screen.getByTestId('machining-boundary-pick')).toBeTruthy()
    const sourceOption = Array.from(
      (screen.getByTestId('op-geometry-select') as HTMLSelectElement).options,
    ).find((option) => option.value === MODEL_ID)
    expect(sourceOption?.textContent).toBe('Model F1 (modeled body)')

    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    act(() => {
      capturedPickCallback!({ geoId: MODEL_ID, kind: 'face', index: 1, isModelFace: true })
    })
    await waitFor(() => {
      expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('F_top')
    })

    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('EM6'))
    // Commit 2e5678b7 made a valid Smart Height V2 envelope the only runtime
    // authority: Create Operation stays disabled until the modal's own
    // planar-rough preflight resolves one (NewOperationModalBody.tsx's
    // planarRoughHeightValid).
    await waitFor(() => {
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('op-create'))

    await waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    })
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('adaptive_clearing_2d')
    expect(created.modelReferences).toEqual([
      { bodyId: 'F1', stableIds: ['F_top'], role: 'machining-boundary' },
    ])

    act(() => {
      useCamStore.getState().openEditOperation('setup-1', created.id)
    })
    await waitFor(() => {
      expect(screen.getByText('Edit Operation', { exact: false })).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('F_top')

    // Simulate an older Stock op carrying all three stale model dependencies:
    // params.geometryId, loop ids in both persistence fields, and the durable
    // picked-face reference.
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.getState().updateOperation('setup-1', created.id, {
        geometrySelections: ['stale-section-loop'],
        params: {
          ...created.params,
          boundarySource: 'stock',
          geometryId: MODEL_ID,
          loopIds: ['stale-section-loop'],
        },
      })
      useCamStore.getState().openEditOperation('setup-1', created.id)
    })
    await waitFor(() => {
      expect(screen.getByText('Edit Operation', { exact: false })).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.queryByTestId('machining-boundary-pick')).toBeNull()

    // V2 TRUTH (updated from the pre-V2 expectation that Save would silently
    // normalize every stale channel): Smart Height V2's planar-rough
    // stock_rough variant only has live evidence for a complete STEP/B-rep
    // target (src/store/index.ts, "Planar stock roughing cannot yet prove
    // target '<name>' (model/model); assign a complete STEP/B-rep target or
    // use a manual end condition."), src/store/index.ts:3112-3118. A
    // modeled-body source can never satisfy that, so the Stock-boundary
    // preflight refuses and Create Operation stays disabled - the wizard
    // correctly declines to save an operation it cannot itself validate,
    // rather than silently normalizing the stale channels. Per-family V2
    // dispatch truth for planar rough lives in
    // src/tests/store/smartHeightPlanarRoughStore.phase*.test.ts.
    await waitFor(() => {
      expect(screen.getByTestId('adaptive-stock-smart-height-preview').textContent)
        .toMatch(/cannot yet prove target/)
    })
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('op-create'))

    // The no-op click leaves the operation exactly as the direct
    // updateOperation() call above left it - unchanged, not "normalized".
    const unsaved = useCamStore.getState().project.setups[0].operations[0]
    expect(unsaved.modelReferences).toEqual([
      { bodyId: 'F1', stableIds: ['F_top'], role: 'machining-boundary' },
    ])
    expect(unsaved.geometrySelections).toEqual(['stale-section-loop'])
    expect(unsaved.params).toMatchObject({
      boundarySource: 'stock',
      geometryId: MODEL_ID,
      loopIds: ['stale-section-loop'],
    })
  })
})
