// WO INT-13C -- the shared co-mount harness for the keyboard-routing tests.
//
// WHAT THIS MOUNTS AND WHY. Keyboard ownership is a claim made on `window`, and the D5.3
// dispatch table is a statement about which of several WINDOW listeners wins one keystroke.
// So the thing under test is the set of listeners three real components register when they
// are co-mounted: TopToolbar (rule 3, bubble), SolidsWorkbenchPage (rule 2, capture), and
// useGlobalShortcuts (P2's bare G/N/Delete). All three are mounted here for real, and every
// transition is driven through the REAL store action the real tabs dispatch (`setWorkspace`).
//
// WHY NOT A FULL <App /> MOUNT. Recon this session confirms INT-13B's finding (its test file
// documents it at :8-17): App renders SolidsWorkbenchPage lazily with no injection seam, so a
// full-App mount demands a real occt-wasm kernel and a real WebGL context, neither of which
// exists in jsdom. The page is mounted `embedded` with the fake kernel + fake runtime instead.
// That is not a store harness standing in for the UI: these are the REAL components
// registering their REAL listeners, and the events below are real KeyboardEvents dispatched at
// window. The only thing faked is the kernel behind the geometry, which owns none of the
// routing under test. What the co-mount does NOT reproduce is App's DOM nesting -- which is
// irrelevant here by construction, because every listener in the D5.3 table is registered on
// `window`, not on a host subtree.
//
// THE BOOT-SUSPENDED TRAP (INT-13B verified it, and it is a real property of the contract, not
// a test artifact): with `embedded` set, `suspended` is TRUE on the first render while the
// store sits at its 'cam' default, so the page would boot suspended and never reach a session.
// Every boot here therefore sets workspace='part' BEFORE render.

import * as THREE from 'three'
import { render, screen, waitFor, act } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { TopToolbar } from '../../components/toolbar/TopToolbar'
import { SketchEntryModal } from '../../components/modals/SketchEntryModal'
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts'
import { createFakeGeomClient } from '../model3d/fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { mintRectangleSketch } from '../model3d/mintRectangleSketch'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { useCamStore } from '../../store'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { Sketcher, sketcherToolStore } from '../../lib/sketch/sketcher'
import type { SketcherHost, SketchDocumentPort, SketcherOrbitPolicy } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

/** App.tsx:117 mounts the CAM global shortcuts as a bare hook with no UI of its own. */
function GlobalShortcutsHost(): null {
  useGlobalShortcuts()
  return null
}

/**
 * Boot the CAM-side chrome ONLY -- TopToolbar and the global shortcuts -- with NO Part host.
 *
 * THIS IS A REAL APPLICATION STATE, NOT A CONTRIVANCE, and it is the only state in which
 * TopToolbar's `workspace === 'cam'` guard is REACHABLE. Whenever the Part host IS mounted it
 * claims Ctrl+Z on the capture phase and calls stopImmediatePropagation, so TopToolbar's
 * listener never runs at all and the guard cannot be what saves us. The window where it can:
 * SolidsWorkbenchPage is React.lazy + <Suspense> (App.tsx:281-292) and only mounts on FIRST
 * entry to the Part workspace -- so between the operator clicking the Part tab (which sets
 * workspace='part' synchronously) and that chunk resolving and registering its listener, the
 * Part workspace is ACTIVE with no history owner. Ctrl+Z struck in that window reaches
 * TopToolbar's bubble listener with nothing above it, and the guard is the only thing standing
 * between it and a CAM project undo fired from the Model workspace. That is face (a), exactly
 * as spec 5.3 describes it: "nothing would stop TopToolbar from firing CAM undo while the user
 * is in Part Studio."
 *
 * The first mutation run is what proved this shape is necessary: with the guard deleted, every
 * test that mounted the Part host still passed.
 */
export function bootCamChromeOnly(): void {
  useCamStore.getState().setWorkspace('part')
  render(
    <>
      <TopToolbar />
      <GlobalShortcutsHost />
      <input data-testid="int13c-text-probe" />
    </>,
  )
}

/** The spies that answer "WHICH history fired?" for the CAM side.
 *
 *  Overriding the store's own `undo`/`redo` (zustand holds actions IN state, so setState
 *  replaces them) is what makes the CAM half observable without seeding a 10-deep snapshot
 *  history: TopToolbar selects `s.undo` at render, so it binds the spy exactly the way it
 *  would bind the real action. The PART half needs no spy -- it is asserted on real observable
 *  state (a feature row that a real CommandHistory undo removes), which is stronger. */
export interface CamHistorySpies {
  camUndo: ReturnType<typeof vi.fn>
  camRedo: ReturnType<typeof vi.fn>
}

export function installCamHistorySpies(opts: { canUndo?: boolean; canRedo?: boolean } = {}): CamHistorySpies {
  const camUndo = vi.fn()
  const camRedo = vi.fn()
  useCamStore.setState({
    undo: camUndo,
    redo: camRedo,
    canUndo: opts.canUndo ?? true,
    canRedo: opts.canRedo ?? true,
  })
  return { camUndo, camRedo }
}

/** The spies that answer "did a CAM GLOBAL shortcut fire?" -- the `g`/`G` regenerate actions
 *  useGlobalShortcuts drives. Overriding the store's own actions (zustand holds actions IN state)
 *  binds the spy the same way the hook reads them at event time. Used by the AC4 sketch-hotkey
 *  tests to prove that a bare `g` claimed by the active sketcher does NOT also regenerate a CAM
 *  toolpath in the wrong workspace (P2 workspace guard) or while a CAM sketch is open (mode guard). */
export interface CamRegenSpies {
  computeAll: ReturnType<typeof vi.fn>
  computeOne: ReturnType<typeof vi.fn>
}

export function installCamRegenSpies(): CamRegenSpies {
  const computeAll = vi.fn(async () => {})
  const computeOne = vi.fn(async () => {})
  useCamStore.setState({ computeAllToolpaths: computeAll, computeOperationToolpath: computeOne })
  return { computeAll, computeOne }
}

/** The armed sketch tool, or 'select' at rest -- the observable that answers "did the active
 *  sketcher claim this single-key chord?". Read from the shared module singleton the real
 *  sketcher writes through (sketcherTools.armTool), so it is the same value the toolbox renders. */
export function armedSketchTool(): string {
  return sketcherToolStore.getState().tool
}

export function canvas(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

/** THE suspend trigger: the real store action the Part/CAM tabs dispatch. */
export function switchToCam(): void {
  act(() => {
    useCamStore.getState().setWorkspace('cam')
  })
}
export function switchToPart(): void {
  act(() => {
    useCamStore.getState().setWorkspace('part')
  })
}

/**
 * Dispatch a REAL KeyboardEvent, defaulting to a real ELEMENT target (document.body).
 *
 * THE TARGET IS NOT INCIDENTAL -- it decides whether phase ordering exists at all. The D5.3
 * table is phase-ordered (rule 2 capture, rule 3 bubble), and that ordering only happens when
 * the event travels: capture listeners on window run in the CAPTURING phase, on the way DOWN to
 * a target inside the document, and bubble listeners run on the way back UP. Dispatch at
 * `window` itself and window becomes the TARGET, so the whole event is AT_TARGET -- where the
 * DOM spec invokes capture and bubble listeners TOGETHER, in REGISTRATION order. The phase
 * ordering the entire dispatch table rests on would simply not be under test, and the result
 * would silently depend on which component re-rendered last (TopToolbar re-registers on every
 * workspace switch, so it drifts to the END of the registration order mid-test).
 *
 * This was not theorised -- the first mutation run found it: with TopToolbar's guard DELETED
 * the whole slice stayed green, because the workbench's capture listener happened to be
 * registered first and stopImmediatePropagation'd the mutated listener away.
 *
 * `bubbles` and `cancelable` are both required too: without cancelable, preventDefault()
 * silently does nothing, `defaultPrevented` never becomes true, and TopToolbar's yield path
 * would be defeated by the harness rather than by the code.
 */
export function pressKey(
  key: string,
  init: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean; target?: HTMLElement } = {},
): KeyboardEvent {
  const { target, ...rest } = init
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...rest })
  act(() => {
    ;(target ?? document.body).dispatchEvent(ev)
  })
  return ev
}

/** Ctrl+Z / Ctrl+Y, the chords the whole D5.3 table is about. */
export const pressUndo = (target?: HTMLElement): KeyboardEvent => pressKey('z', { ctrlKey: true, target })
export const pressRedo = (target?: HTMLElement): KeyboardEvent => pressKey('y', { ctrlKey: true, target })

/**
 * Let an undo finish landing before asserting on it.
 *
 * NOT a sleep-until-it-works: the workbench's handleUndo ends in `void fullResync(roots)`
 * (SolidsWorkbenchPage.tsx:5745) -- deliberately un-awaited, so the DAG resync and the feature
 * tree's re-render happen a tick AFTER the keystroke returns. A synchronous assert right after
 * pressUndo() therefore reads the PRE-undo tree and fails a correct implementation (observed:
 * that is exactly how this harness's first run failed).
 *
 * It matters just as much for the NEGATIVE assertions -- "the suspended workspace's history is
 * untouched" is only worth asserting once a resync would have had the chance to run. Without
 * this flush, "still present" would pass even against a build that undid the wrong workspace's
 * history one tick later.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/**
 * Boot the real co-mount with the Part workspace ACTIVE.
 *
 * Mirrors INT-13B's boot (fake kernel + fake runtime + a real camera the fake's origin-sited
 * default cannot stand in for), and additionally mounts TopToolbar and the global-shortcuts
 * host so all three claimants of the D5.3 table are present and contending for real.
 */
export async function bootCoMount(): Promise<FakeSceneRuntime> {
  // EDIT-MODEL-REGRESSION fix (documentHolder.ts's registerLiveDocument):
  // an EMBEDDED unmount now stashes the legacy id's live document on cleanup
  // (previously always skipped for legacy -- see that function's own doc
  // comment for why). Every caller of this harness boots a FRESH
  // SolidsWorkbenchPage(embedded) per `it()`, relying on it starting from a
  // truly blank document each time; without this reset, a PRIOR test's
  // unmount-stash would now seed the NEXT test's mount with leftover
  // content from the module-level holder (pendingSeeds is process-lifetime
  // state, not per-render), corrupting node-id-based assertions across
  // tests in the same file. Every other test file that mounts SolidsWorkbenchPage
  // repeatedly already carries this same reset in its own beforeEach
  // (int14ProjectDocument.test.ts, SolidsWorkbenchPage.documentPersist.test.tsx);
  // centralizing it HERE covers every caller of this shared harness at once.
  resetDocumentHolder()
  useCamStore.getState().setWorkspace('part')
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(
    <>
      <TopToolbar />
      <GlobalShortcutsHost />
      {/* A CAM ROOT-LEVEL modal, mounted as App mounts it: an unconditional sibling of BOTH
          hosts, OUTSIDE either one's suspend boundary (App.tsx:296-304, "rendered at root so
          they appear above everything"). That placement is the whole subject of preflight
          amendment 4 -- nothing closes a CAM modal when the operator switches to Part, so its
          listeners keep running while the Model workspace is active. SketchEntryModal is the
          one CAM root modal whose window listener is a genuine modal-close Escape (the census
          reads NewOperationModal/PostProcessModal/SetupModal's listeners as narrower sub-mode
          handlers), so it is the honest specimen for that case. */}
      <SketchEntryModal />
      {/* D5.3 RULE 1's subject. Rule 1 is a pure predicate on `e.target.tagName`
          (INPUT/TEXTAREA/contentEditable), so any REAL input element is a faithful specimen --
          there is no app-specific state involved in "the user is typing". These stand in for
          every text field in either workspace, and CAM's own fields live in panels this
          co-mount does not render (they need the CAM viewport). */}
      <input data-testid="int13c-text-probe" />
      <textarea data-testid="int13c-textarea-probe" />
      <div data-testid="int13c-contenteditable-probe" contentEditable suppressContentEditableWarning />
      <SolidsWorkbenchPage embedded createClient={() => createFakeGeomClient()} createSceneRuntime={captureSceneRuntime} />
    </>,
  )
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvas().getBoundingClientRect = () => rect
  ;(canvas().parentElement as HTMLElement).getBoundingClientRect = () => rect

  // jsdom does not implement contenteditable: `isContentEditable` is `undefined` there even on
  // an element carrying the attribute (verified this session, not assumed). Rule 1's third
  // target would therefore be untestable, and -- worse -- a test asserting it would PASS
  // vacuously against a build that dropped the isContentEditable check entirely, because the
  // predicate would be reading undefined either way. Defining the property is what the browser
  // itself provides; the assertion still exercises OUR predicate (`isContentEditable === true`)
  // rather than a stub of it.
  Object.defineProperty(screen.getByTestId('int13c-contenteditable-probe'), 'isContentEditable', {
    value: true,
    configurable: true,
  })
  return runtime
}

/**
 * Mint ONE real workbench history entry, so the Part workspace has something a real
 * CommandHistory undo can remove.
 *
 * This is the observable the Part half of every assertion below rests on: `feature-row-SK1`
 * exists iff that command is applied. SKC-PARAM-RECT-REMOVAL retired the New-sketch chooser's
 * "insert a parametric rectangle" UI escape hatch this used to click through -- mintRectangleSketch
 * executes the SAME production CommandHistory + createFeatureCommand path that dialog's Apply
 * handler called (see its own header comment), so this is still a real, undoable history entry
 * driven through production command code, not a synthetic test-only command; the only thing no
 * longer exercised here is DOM button-click plumbing for a UI surface that no longer exists.
 */
export async function mintWorkbenchSketch(): Promise<void> {
  await mintRectangleSketch()
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
}

/** True while the minted command is applied -- i.e. the workbench history has NOT undone it. */
export function workbenchSketchPresent(): boolean {
  return screen.queryByTestId('feature-row-SK1') !== null
}

/**
 * Count the capture-phase 'keydown' listeners currently registered on window.
 *
 * AC2 asks for "getEventListeners-style probing": jsdom exposes no such API, so ownership is
 * counted at the source by wrapping window.addEventListener/removeEventListener BEFORE the
 * mount. This is a direct structural probe of D5.2's claim ("a suspended host has no listener
 * at all"), independent of the behavioural dispatch tests -- if the implementation ever went
 * back to an early-return flag, the dispatch tests would still pass and THIS would fail.
 */
export interface CaptureListenerProbe {
  captureKeydownCount: () => number
  uninstall: () => void
}

// ---------------------------------------------------------------------------------------
// A REAL sketcher key handler, built against a chosen HOST SHAPE (INT-13C-R1, AC4).
//
// The AC4 sketch-mode leg must prove a real SKETCH-OWNED chord (a single-key tool shortcut like
// `l`/`g`, shortcuts.ts) is owned by the ACTIVE sketcher in BOTH host shapes -- not a Ctrl+Z the
// sketcher intentionally ignores. The PART shape is exercised through the real workbench in the
// co-mount (bootCoMount opens a real package sketch). The CAM shape cannot mount its real host
// (CNCViewport.enterSketchView needs WebGL), so this builds the SHARED Sketcher package against
// the CAM host literal -- the same seam sketcherSuspendParity.int13b uses -- and enters a session,
// which attaches the package's real window keydown handler (sketchInteraction.ts). The key handler
// is host-shape-independent (only orbit policy differs by host), so this proves the CAM host shape
// owns its sketch chords with the real code, not a stand-in.
// ---------------------------------------------------------------------------------------

const SK_P0: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const SK_P1: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 10, y: 0 } }

function freshSketchDoc(): Sketch {
  return { id: 's', layerId: 'l', entities: [SK_P0, SK_P1], constraints: [], dimensions: [], solveStatus: null }
}

export interface RealSketcherMount {
  sketcher: Sketcher
  dispose: () => void
}

/**
 * Build the real Sketcher package against ONE host shape and enter a session.
 *
 * `orbitPolicy: undefined` IS the CAM mount (CNCViewport's host literal omits the field ->
 * resolves 'session'); `'drag'` is the workbench. Only the KEY handler is under test here, so the
 * document port is a minimal-but-real sink (arming a tool reads getSketch/getSelection and writes
 * the shared tool store); nothing here fakes the handler itself.
 */
export function mountRealSketcher(orbitPolicy: SketcherOrbitPolicy | undefined): RealSketcherMount {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)
  document.body.appendChild(overlayHost)
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld(true)

  const sketch = freshSketchDoc()
  const host: SketcherHost = {
    domElement: canvas,
    container,
    overlayHost,
    overlayRoot: new THREE.Group(),
    camera,
    controls: { enableRotate: true },
    orbitPolicy,
    clientToPlaneWorld: () => ({ x: 0, y: 0 }),
    worldPerPixel: () => 1,
    saveCameraPose: () => ({ token: 'int13c' }),
    restoreCameraPose: () => {},
    frameNormalToPlane: () => {},
  }
  const doc: SketchDocumentPort = {
    getSketch: () => sketch,
    ensureSketch: () => sketch,
    getDisplayUnits: () => 'mm',
    getGridSpacing: () => 10,
    getProjectCandidates: () => [],
    getSelection: () => [],
    setSelection: () => {},
    getLastStagedSize: () => null,
    setLastStagedSize: () => {},
    notice: () => {},
    beginStep: () => {},
    append: () => {},
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: () => true,
    dragMove: () => {},
    dragEnd: () => {},
    moveDimLabel: () => {},
    openDimEditor: () => {},
    getTextEditId: () => null,
    getPickPathForTextId: () => null,
    editText: () => {},
    commitTextEdit: () => {},
    cancelTextEdit: () => {},
    cancelPickTextPath: () => {},
    placeText: () => {},
    bindTextPath: () => {},
  }

  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(doc)
  sketcher.setUndoSink({ beginGesture: () => {} })
  act(() => {
    sketcher.enter()
  })
  return {
    sketcher,
    dispose: () => {
      act(() => sketcher.dispose())
      overlayHost.remove()
    },
  }
}

export function installCaptureListenerProbe(): CaptureListenerProbe {
  const live = new Set<EventListenerOrEventListenerObject>()
  const realAdd = window.addEventListener.bind(window)
  const realRemove = window.removeEventListener.bind(window)
  const isCapture = (o?: boolean | AddEventListenerOptions): boolean =>
    o === true || (typeof o === 'object' && o !== null && o.capture === true)

  window.addEventListener = function (type: string, listener: never, options?: never) {
    if (type === 'keydown' && isCapture(options)) live.add(listener)
    return realAdd(type, listener, options)
  } as typeof window.addEventListener
  window.removeEventListener = function (type: string, listener: never, options?: never) {
    if (type === 'keydown' && isCapture(options)) live.delete(listener)
    return realRemove(type, listener, options)
  } as typeof window.removeEventListener

  return {
    captureKeydownCount: () => live.size,
    uninstall: () => {
      window.addEventListener = realAdd
      window.removeEventListener = realRemove
      live.clear()
    },
  }
}
