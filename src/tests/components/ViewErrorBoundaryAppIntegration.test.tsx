// @vitest-environment jsdom
//
// VIEW-ERRORBOUNDARY (ADAPTIVE-VIEW-CRASH follow-up): proves the REAL App.tsx wiring, not
// just the isolated ViewportErrorBoundary component (see ViewportErrorBoundary.test.tsx for
// that unit-level RED->GREEN pin). Mounts the actual <App/>, mocks only CNCViewport (builds a
// real THREE.WebGLRenderer, absent in jsdom) and ViewCube (same reason) exactly like
// src/tests/workspace/int15.camHostListeners.test.tsx, then forces a synthetic render-time
// throw from a real child Viewport.tsx always mounts (DisplayModeControl) -- NOT
// SimulationPanel, proving the boundary catches a throw from the wider viewport subtree, per
// the follow-up's ask ("a RENDER-time throw in that view, not just [the frame-build] effect").
//
// GREEN (this file, current code): the throw is contained in-panel; DesignTree and
// PropertiesPanel (the app-shell siblings) stay mounted and show their normal content; the
// app-level ErrorBoundary never trips.
//
// RED proof for this exact wiring was captured separately (not left as dead code here):
// with the ViewportErrorBoundary wrapper in App.tsx temporarily removed, this same test was
// run and its output saved to
// coordination/evidence/VIEW-ERRORBOUNDARY/app-integration-RED.txt (app-level fallback trips,
// siblings unmount) before the wrapper was restored and this file's GREEN assertions were
// written against the real, current wiring.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// jsdom's localStorage is unreliable under this repo's vitest launch flags and the store
// uses persist(); install an in-memory shim BEFORE importing the store (every App-mounting
// test in this repo does this).
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

// Every method Viewport.tsx / this file's mount calls on viewportRef.current -- declared as
// typed class fields (not the old dynamic METHODS-array + cast) so typedMock's type argument
// actually checks this mock's shape against the real CNCViewport class.
// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    applyNavPreset = vi.fn()
    clearCarvedStock = vi.fn()
    clearPartLoopsOnFacePlane = vi.fn()
    clearScene = vi.fn()
    collectWorldPositions = vi.fn()
    dispose = vi.fn()
    enterLayOnFaceMode = vi.fn()
    enterSketchView = vi.fn()
    enterSlicePlaneMode = vi.fn()
    enterTargetPlaneMode = vi.fn()
    exitLayOnFaceMode = vi.fn()
    exitProjectPlaneMode = vi.fn()
    exitSketchView = vi.fn()
    exitSlicePlaneMode = vi.fn()
    getCamera = vi.fn()
    markCameraUserPositioned = vi.fn()
    partPointToScreen = vi.fn()
    rebuildStock = vi.fn()
    renderToolpath = vi.fn()
    restoreCameraState = vi.fn()
    restoreSelectedPartAfterSceneRestore = vi.fn()
    resumeRender = vi.fn()
    saveCameraState = vi.fn()
    setAxesVisible = vi.fn()
    setBrepPickMode = vi.fn()
    setMoveSelectCallback = vi.fn()
    setCameraChangeHandler = vi.fn()
    setCameraView = vi.fn()
    setGridSpacing = vi.fn()
    setGridVisible = vi.fn()
    setHeightPlanesVisible = vi.fn()
    setHiddenToolpathRoles = vi.fn()
    setMachineTravel = vi.fn()
    setMachineVisible = vi.fn()
    setPartLoopsOnFacePlane = vi.fn()
    setPartProjectedLoops = vi.fn()
    setPartTransform = vi.fn()
    setSectionView = vi.fn()
    setSeedOutlineVisible = vi.fn()
    setSelectedPart = vi.fn()
    setShadingMode = vi.fn()
    setSketchDocumentPort = vi.fn()
    setSketchEditingLayer = vi.fn()
    setSketchMenuPort = vi.fn()
    setSketchOverlayHost = vi.fn()
    setSketchUndoSink = vi.fn()
    setStockVisible = vi.fn()
    setToolpathVisible = vi.fn()
    setTransformMode = vi.fn()
    setWCSOrigin = vi.fn()
    setWorkpieceVisible = vi.fn()
    showCarvedStock = vi.fn()
    suspendRender = vi.fn()
    updateHeightPlanes = vi.fn()
    updateSketch = vi.fn()
    dropPartToFloor = vi.fn()
    settleToFloor = vi.fn()
  },
}))
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({ ViewCube: () => <></> }))

// The SYNTHETIC render throw: DisplayModeControl is a real, always-mounted child of
// Viewport.tsx (Viewport.tsx renders it unconditionally alongside SimulationPanel) -- mocking
// it to throw exercises a render failure OUTSIDE SimulationPanel, proving the boundary covers
// the wider "toolpath/simulation view" render surface, not just the effect a9934ed9e scoped.
// A dev-only injection, same spirit as the mission's headed-Playwright hook -- lives only in
// this test file, nothing shipped in product code.
// 37b6aa25 added CAM_SECTION_MIN/MAX exports to this module (shared section-plane
// drag range) and Viewport.tsx now imports them alongside the component; the mock
// module must supply them too or Viewport.tsx's own module eval throws before the
// synthetic component-throw this test is actually pinning.
vi.mock('../../components/viewport/DisplayModeControl', () => typedMock<typeof import('../../components/viewport/DisplayModeControl')>({
  CAM_SECTION_MIN: -200,
  CAM_SECTION_MAX: 200,
  DisplayModeControl: () => {
    throw new Error('SYNTHETIC-VIEW-RENDER-THROW: DisplayModeControl exploded (test-only injection)')
  },
}))

const App = (await import('../../App')).default
const { useCamStore } = await import('../../store')

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

describe('VIEW-ERRORBOUNDARY: real App.tsx wiring', () => {
  it('contains a synthetic viewport render throw in-panel; app shell (tree/properties) stays alive; app-level boundary never trips', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<App />)
    await waitFor(() => expect(screen.getByTestId('cam-workspace-host')).toBeTruthy())

    // Contained: the view-level fallback shows, named by the real error message (ADR-0003).
    const boundary = await screen.findByTestId('viewport-error-boundary')
    expect(boundary).not.toBeNull()
    expect(screen.getByTestId('viewport-error-boundary-message').textContent).toBe(
      'SYNTHETIC-VIEW-RENDER-THROW: DisplayModeControl exploded (test-only injection)',
    )

    // The app-level boundary never trips.
    expect(screen.queryByText('LienCAM encountered an error')).toBeNull()

    // The rest of the app shell stays fully alive and shows its normal content -- proving
    // this is a VIEW-scoped failure, not an app-wide one.
    expect(screen.getByText('Import a file, create a sketch, or start a model')).not.toBeNull()
    expect(screen.getByText('Select a geometry, setup, or operation to view its properties.')).not.toBeNull()

    consoleSpy.mockRestore()
  })
})
