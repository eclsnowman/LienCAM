// @vitest-environment jsdom
//
// WO INT-15, Work item 3 -- CONSTRUCTED INTERLEAVE can-fail tests for the CAM-host window
// key-listener leaks F-1 (DesignTree F2), F-2 (Viewport Escape face-select) and F-4 (a CAM
// root modal stranded across a workspace switch). All three are proved against the REAL
// <App/> co-mount, with REAL store-driven workspace switches (setWorkspace, the same action the
// tabs dispatch) and REAL KeyboardEvents dispatched at window -- charter rule 4: an ownership
// transition is settled by a constructed interleave, never by prose.
//
// WHY THE FULL <App/> MOUNT WORKS HERE (where the D5.3 harness used a partial co-mount): with
// `?partWorkspace` OFF, App never mounts SolidsWorkbenchPage (the lazy Part host that would need a
// real occt kernel + WebGL, int13cHarness:9-19). The CAM host, however, is ALWAYS mounted and
// merely toggled display:none by `workspace` (App.tsx:220) -- which is EXACTLY the leak scenario:
// switching to the Model workspace hides the CAM host without unmounting it, so its window
// listeners live on. Driving setWorkspace('part') directly through the store reproduces that hidden
// state precisely (the CAM host goes display:none, workspace is 'part'), with no Part host needed.
// CNCViewport builds a real THREE.WebGLRenderer (absent in jsdom), so it is mocked lightweight --
// the leaks under test are the REACT/DOM window listeners DesignTree/Viewport/the modals register,
// not anything CNCViewport draws.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'
import { findByTooltip } from '../support/tooltipQuery'
import { typedMock } from '../support/typedMock'

// jsdom's localStorage is unreliable under vitest's node launch flags and the store uses
// persist(); install an in-memory shim BEFORE importing the store (every *.smoke.test.tsx does).
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

// The mock CNCViewport instance the mount constructs -- captured so a test can read the calls
// Viewport.tsx's Escape handler makes on it (exitLayOnFaceMode is the F-2 observable).
let cncInstance: Record<string, ReturnType<typeof vi.fn>> | null = null

vi.mock('../../lib/viewport/CNCViewport', () => {
  // Every method Viewport.tsx calls on viewportRef.current -- must all exist or the mount throws.
  const METHODS = [
    'applyNavPreset', 'clearCarvedStock', 'clearPartLoopsOnFacePlane', 'clearScene',
    'collectWorldPositions', 'dispose', 'enterLayOnFaceMode', 'enterSketchView',
    'enterSlicePlaneMode', 'enterTargetPlaneMode', 'exitLayOnFaceMode', 'exitProjectPlaneMode',
    'exitSketchView', 'exitSlicePlaneMode', 'getCamera', 'markCameraUserPositioned',
    'partPointToScreen', 'rebuildStock', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState', 'setAxesVisible',
    'setBrepPickMode', 'setMoveSelectCallback', 'setCameraChangeHandler', 'setCameraView', 'setGridSpacing',
    'setGridVisible', 'setHeightPlanesVisible', 'setHiddenToolpathRoles', 'setMachineTravel',
    'setMachineVisible', 'setPartLoopsOnFacePlane', 'setPartProjectedLoops', 'setPartTransform',
    'setSectionView', 'setSeedOutlineVisible', 'setSelectedPart', 'setShadingMode',
    'setSketchDocumentPort', 'setSketchEditingLayer', 'setSketchMenuPort', 'setSketchOverlayHost',
    'setSketchUndoSink', 'setStockVisible', 'setToolpathVisible', 'setTransformMode',
    'setWCSOrigin', 'setWorkpieceVisible', 'showCarvedStock', 'suspendRender', 'updateHeightPlanes',
    'updateSketch', 'setGridSpacing', 'dropPartToFloor', 'settleToFloor',
    // 8381d758 (WO-227): setup fixture support planes.
    'setSetupSupportPlane',
  ]
  class CNCViewport {
    constructor() {
      for (const m of METHODS) (this as Record<string, unknown>)[m] = vi.fn()
      cncInstance = this as unknown as Record<string, ReturnType<typeof vi.fn>>
    }
  }
  return { CNCViewport }
})

// ViewCube + MachineChoiceModal build their own WebGL / carry heavy deps irrelevant to these
// window-listener leaks. An empty fragment (not `null`): ViewCube's real return type is the
// single JSX.Element its body always returns, so the mock must hand back an actual element to
// type-check against it -- renders exactly as much as `null` did (nothing).
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({
  ViewCube: () => <></>,
}))

const App = (await import('../../App')).default
const { useCamStore } = await import('../../store')

/** Dispatch a REAL KeyboardEvent at document.body (an in-document target, so window capture/bubble
 *  ordering is real -- see int13cHarness:pressKey for why the target is load-bearing). */
function pressKey(key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { document.body.dispatchEvent(ev) })
  return ev
}

function setWorkspace(w: 'cam' | 'part'): void {
  act(() => { useCamStore.getState().setWorkspace(w) })
}

/** Seed one selected 3D geometry so the DesignTree F2 target resolves AND the Viewport toolbar's
 *  lay-on-face button renders (it is gated on a selected non-2D geometry). */
function seedSelected3dGeometry(): void {
  const geo: ImportedGeometry = {
    id: 'geo-int15', name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
  } as unknown as ImportedGeometry
  act(() => {
    const s = useCamStore.getState()
    s.addGeometry(geo)
    s.setSelectedGeometry('geo-int15')
  })
}

beforeEach(() => {
  cncInstance = null
  act(() => { useCamStore.getState().newProject() })
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

// ---------------------------------------------------------------------------------------
// F-1 -- DesignTree bare-F2 rename
// ---------------------------------------------------------------------------------------

describe('INT-15 F-1: DesignTree F2 rename is workspace-scoped', () => {
  // OBSERVABLE: the handler calls e.preventDefault() ONLY when it resolves a rename target and
  // arms rename (DesignTree.tsx: `if (target) { e.preventDefault(); setRenameTarget(target) }`).
  // So defaultPrevented is a precise, DOM-stable proxy for "the CAM tree entered rename" without
  // reaching into the inline editor's markup -- the same ownership signal the D5.3 tests read.
  it('F2 in the CAM workspace ARMS rename (defaultPrevented); after switching to Model it is REFUSED', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('cam-workspace-host')).toBeTruthy())
    seedSelected3dGeometry()

    // CAM active: F2 resolves the selected-geometry target and arms rename.
    const inCam = pressKey('F2')
    expect(inCam.defaultPrevented).toBe(true)

    // Switch to the Model workspace (CAM host -> display:none, still mounted). The SAME F2, same
    // selection -- only the active workspace changed -- must now be refused by the F-1 guard.
    setWorkspace('part')
    const inModel = pressKey('F2')
    expect(inModel.defaultPrevented).toBe(false)

    // Return to CAM: ownership comes BACK (not stuck off).
    setWorkspace('cam')
    expect(pressKey('F2').defaultPrevented).toBe(true)
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// F-2 -- Viewport Escape cancels a CAM face-select mode
// ---------------------------------------------------------------------------------------

describe('INT-15 F-2: Viewport Escape face-select cancel is workspace-scoped', () => {
  it('Escape cancels lay-on-face in CAM, but a suspended CAM host ignores Escape from the Model workspace', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('cam-workspace-host')).toBeTruthy())
    seedSelected3dGeometry()

    // Arm a CAM face-select mode through the REAL toolbar button (mock enterLayOnFaceMode is a
    // no-op; interactionMode becomes 'lay-on-face' in the real Viewport state).
    const layBtn = await findByTooltip(/Lay on face/i)
    fireEvent.click(layBtn)
    const exitCallsBeforeSwitch = cncInstance?.exitLayOnFaceMode.mock.calls.length ?? 0

    // NON-VACUITY: while CAM is active, Escape DOES cancel (exitLayOnFaceMode fires). Proves the
    // listener is real and armed, so the refusal below is the suspend disarm, not an inert key.
    pressKey('Escape')
    expect((cncInstance?.exitLayOnFaceMode.mock.calls.length ?? 0)).toBe(exitCallsBeforeSwitch + 1)

    // Re-arm, then switch to the Model workspace (Viewport gets suspended={true}).
    fireEvent.click(await findByTooltip(/Lay on face/i))
    setWorkspace('part')
    const exitCallsAfterSwitch = cncInstance?.exitLayOnFaceMode.mock.calls.length ?? 0

    // The leak, refused: Escape in the Model workspace no longer cancels the CAM mode left armed
    // under the hidden host.
    pressKey('Escape')
    expect((cncInstance?.exitLayOnFaceMode.mock.calls.length ?? 0)).toBe(exitCallsAfterSwitch)
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// F-4 -- a CAM root modal stranded across a workspace switch
// ---------------------------------------------------------------------------------------

describe('INT-15 F-4: a CAM root modal is closed on a workspace switch (its Escape listener detaches)', () => {
  it('opening a CAM modal in CAM then switching to Model closes it, so it no longer answers Escape', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('cam-workspace-host')).toBeTruthy())

    act(() => { useCamStore.getState().openModal('sketch-entry') })
    await waitFor(() => expect(useCamStore.getState().activeModal).toBe('sketch-entry'))

    // Switch to the Model workspace WITHOUT closing it. The F-4 modal boundary (App.tsx) closes
    // the stranded modal ON the switch, so its window Escape listener is gone.
    setWorkspace('part')
    expect(useCamStore.getState().activeModal).toBeNull()

    // And Escape in the Model workspace finds no CAM modal to answer (nothing to assert re-opening).
    pressKey('Escape')
    expect(useCamStore.getState().activeModal).toBeNull()
  }, 40_000)
})
