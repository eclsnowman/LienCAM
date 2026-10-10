// @vitest-environment jsdom
//
// WO UI-17 (Operator pre-test gate): workbench visual cohesion + live sketch
// feedback -- the jsdom half of the acceptance harness. Real-browser pixel
// proof (rubber-band preview, snap markers) is coordination/evidence/UI-17/
// tools/capture.mjs; THIS file owns the structural/lifecycle claims:
//
//   AC1  layout: tree in the LEFT aside (DOM order asserted), no top-toolbar
//        testid remains, right rail exists with modeling sections at rest and
//        the sketch sections during a session (mode-switch BOTH directions).
//   AC2  frame drive: SceneRuntime frame-count seam increases across a
//        synthetic pointermove during a session WITHOUT camera change, and
//        does NOT free-run when no session is active (loop stopped after
//        finish -- asserted via the fake's frameDriveRunning, not just a
//        plateaued count).
//   AC4  planes: default-visible (ambient glyphs for all four genesis nodes),
//        tree eye toggle hides/shows (state + scene assertions), persists via
//        uiPrefs/localStorage across a remount.
//   AC5  view cube: the bridge's setCameraView drives the documented pose.
//   AC6  grid: present during a session, oriented by the session plane's
//        frame (quaternion asserted against the PlaneFrame's own axes),
//        absent after finish.
//   AC7  Q-15 page half: session begin/end toggles the liencnc-default
//        right-drag-orbit override; right-CLICK (below the package's drag
//        threshold) opens the sketch context menu. (The OrbitControls half --
//        a real right-drag changing the camera pose, other presets untouched
//        -- is workbenchNavRightDragOrbit.test.ts.)
//
// Mount pattern (fake kernel + fake runtime + REAL Sketcher package) follows
// SolidsWorkbenchPage.sketchEditSession.test.tsx's bootSketch verbatim.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as THREE from 'three'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { typedMock } from '../support/typedMock'
import type { ViewCubeCameraApi } from '../../components/viewport/ViewCube'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { enterBasePlaneSketchViaPick } from './enterBasePlaneSketch'
// WO INT-13B: `WorkbenchViewName` went with the retired global-bridge cast in
// AC5 -- the prop's own type carries the view union now.
import { presetCameraPosition, type CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useUiPrefs } from '../../store/uiPrefs'
import { GENESIS_NODE_IDS, BASE_PLANE_XY_NODE_ID } from '../../doc'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'

afterEach(cleanup)

/** WO INT-13B (D1.3): AC5's capture seam for the cube's camera PROP.
 *
 *  vi.mock's factory is hoisted above every import, so the recorder it writes into
 *  must be created with vi.hoisted -- a plain module-scope const would still be in
 *  the temporal dead zone when the factory runs.
 *
 *  Mocking the SHARED ViewCube (the one component both hosts mount) is what makes
 *  the prop readable at all here: the real one builds a THREE.WebGLRenderer in its
 *  mount effect, which jsdom cannot provide. The mock is the assertion target, not
 *  a convenience -- it records exactly what the page passed the real call site. */
const cubeMock = vi.hoisted(() => ({ camera: null as ViewCubeCameraApi | null, mountCount: 0 }))
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({
  ViewCube: ({ camera }: { camera: ViewCubeCameraApi }) => {
    cubeMock.camera = camera
    cubeMock.mountCount += 1
    return <div data-testid="view-cube-mock" />
  },
}))

/** WorkbenchViewCube probes for a WebGL context and renders nothing without one,
 *  so in bare jsdom the cube never mounts and its props are unobservable. Force
 *  the probe truthy for THIS file only.
 *
 *  This proves PROP-WIRING and nothing more. Per the WO: "a jsdom mock that forces
 *  webglAvailable() truthy proves prop-wiring, not rendering, and must not be
 *  reported as B0 passing." B0's rendering claim is the real-GPU capture's alone.
 *  Delegates every other context kind (notably '2d') to whatever stubCanvas2d
 *  installed, so the two stubs compose instead of clobbering each other. */
function stubWebglProbe(): () => void {
  const previous = HTMLCanvasElement.prototype.getContext
  // getExtension must exist: the real webglAvailable() hands the probe context
  // straight back via WEBGL_lose_context (it would otherwise leak one context per
  // Part entry -- see WorkbenchViewCube). Returning null for the extension is the
  // honest jsdom answer and exercises that call's optional chain.
  const fakeGl = { getExtension: () => null } as unknown as RenderingContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (kind === 'webgl' || kind === 'webgl2') return fakeGl
    return (previous as unknown as (k: string, ...r: unknown[]) => unknown).call(this, kind, ...rest)
  } as unknown as typeof HTMLCanvasElement.prototype.getContext
  return () => {
    HTMLCanvasElement.prototype.getContext = previous
  }
}

/** This vitest runtime exposes Node's EXPERIMENTAL webstorage on globalThis
 *  ("--localstorage-file was provided without a valid path"), whose setItem
 *  throws -- uiPrefs' lazyLocalStorage reads globalThis.localStorage at call
 *  time, so a plain in-memory Storage shim makes the REAL persist/restore
 *  path exercisable (the same shim-then-write approach uiPrefs' own module
 *  comment describes for node test envs). */
function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k)
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
  } as Storage
}

let restoreCanvas2d: (() => void) | null = null
let restoreWebglProbe: (() => void) | null = null
let priorLocalStorage: PropertyDescriptor | undefined
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  // Installed AFTER stubCanvas2d so it wraps (rather than is wrapped by) the 2D
  // stub; torn down in the mirror order below.
  restoreWebglProbe = stubWebglProbe()
  cubeMock.camera = null
  cubeMock.mountCount = 0
  priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
})
afterEach(() => {
  restoreWebglProbe?.()
  restoreWebglProbe = null
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherMenuStore.__reset()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  if (priorLocalStorage !== undefined) Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
  priorLocalStorage = undefined
})

const CENTRE = { x: 400, y: 300 }

function canvasEl(): HTMLElement {
  return screen.getByTestId('solids-workbench-canvas')
}

function sessionOpen(): boolean {
  return screen.queryByTestId('workbench-package-sketch-toolbar') !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function boot(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage createClient={createFakeGeomClient} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

  const runtime = captured as unknown as FakeSceneRuntime
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  cam.position.set(0, 0, 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld(true)
  runtime.camera = cam

  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect
  canvasEl().getBoundingClientRect = () => rect
  ;(canvasEl().parentElement as HTMLElement).getBoundingClientRect = () => rect
  return runtime
}

async function openSketchOn(runtime: FakeSceneRuntime, plane: 'xy' | 'xz'): Promise<void> {
  enterBasePlaneSketchViaPick(runtime, plane)
  await waitFor(() => expect(sessionOpen()).toBe(true))
}

async function finishSketch(): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  await waitFor(() => expect(sessionOpen()).toBe(false))
}

/** The live ambient genesis glyphs the scene currently holds (added minus removed). */
function liveAmbientGlyphIds(runtime: FakeSceneRuntime): string[] {
  const removed = new Set(runtime.removedObjects)
  return runtime.addedObjects
    .filter((o) => o.userData.genesisVariant === 'ambient' && !removed.has(o))
    .map((o) => o.userData.genesisNodeId as string)
}

describe('WO UI-17: workbench cohesion layout + session furniture (fake kernel, real Sketcher)', () => {
  it('AC1/AC3/AC5: tree docks LEFT, no top toolbar remains, rail shows modeling sections, console compact, view-cube bridge poses the camera', async () => {
    const runtime = await boot()

    // AC1 -- the tree lives in the LEFT aside, and the aside PRECEDES the
    // viewport canvas in DOM order (flex row: panel-left, viewport, rail).
    const leftPanel = screen.getByTestId('workbench-left-panel')
    expect(leftPanel.querySelector('[data-testid="feature-tree"]')).not.toBeNull()
    const canvas = canvasEl()
    // FAILS-IF the tree moves back right: FOLLOWING means canvas comes after leftPanel.
    expect(leftPanel.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const rail = screen.getByTestId('workbench-right-rail')
    expect(canvas.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // AC1 -- the old top strip is GONE, by testid.
    expect(screen.queryByTestId('solids-workbench-toolbar')).toBeNull()

    // AC1 -- modeling sections at rest (rail mode + the strip's own commands present).
    expect(rail.getAttribute('data-rail-mode')).toBe('modeling')
    expect(screen.getByTestId('workbench-modeling-toolbar')).toBeTruthy()
    for (const id of ['workbench-new-sketch', 'workbench-extrude', 'workbench-boolean', 'workbench-push-pull', 'workbench-undo', 'workbench-export-step']) {
      expect(rail.querySelector(`[data-testid="${id}"]`), id).not.toBeNull()
    }
    expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull()

    // AC3 -- compact bottom bar: the console is the COLLAPSED strip by
    // default (no expanded panel in the DOM), plus the one-line status strip.
    expect(screen.getByTestId('console-strip')).toBeTruthy()
    expect(document.querySelector('.bottom-console-expanded')).toBeNull()
    expect(screen.getByTestId('workbench-status-strip').textContent).toMatch(/ready/i)

    // AC5 -- the view cube drives the documented pose.
    //
    // WO INT-13B (D1.3) REWRITE. This block used to reach the camera seam through
    // `window.__cncViewport`, the global bridge WorkbenchViewCube published. D1.3
    // retires that: the cube takes its camera API as a PROP, so there is no global
    // to read. Per the WO, ALL THREE of the original claims are preserved -- only
    // the reach changes from "read the global" to "read the prop the page actually
    // passed the real cube":
    //   (a) the camera-driving prop is defined,
    //   (b) setCameraView('front') is recorded on the CORRECT runtime (this page's
    //       injected fake, not some other host's),
    //   (c) the exact position math (presetCameraPosition + toBeCloseTo(...,6)).
    // Keeping only "the callback fired" would silently drop (c)'s math-correctness
    // coverage -- charter rule "a rewrite can silently weaken prior rounds' coverage".
    //
    // The prop is captured by mocking the shared ViewCube component (see cubeMock
    // at the top of this file). That is a strictly STRONGER wiring proof than the
    // old global read: the old assertion passed if ANYTHING published a bridge,
    // whereas this one only passes if THIS page handed THIS runtime's camera api to
    // the real cube's real call site.
    //
    // NOT a rendering claim: forcing webglAvailable() truthy in jsdom proves
    // prop-wiring only. That the Part cube actually RENDERS under co-mount is B0,
    // and B0 is answered exclusively by the real-GPU capture.
    expect(cubeMock.camera, 'AC5(a): the page passes a camera api to the real ViewCube call site').toBeDefined()
    const dist = (runtime.camera as THREE.PerspectiveCamera).position.length()
    cubeMock.camera!.setCameraView('front')
    // (b) FAILS-IF the page wires the cube to anything but its own SceneRuntime.
    expect(runtime.setCameraViewCalls).toEqual(['front'])
    // (c) FAILS-IF the preset pose math regresses -- the callback firing is not enough.
    const expected = presetCameraPosition('front', { x: 0, y: 0, z: 0 }, dist)
    const pos = (runtime.camera as THREE.PerspectiveCamera).position
    expect(pos.x).toBeCloseTo(expected.x, 6)
    expect(pos.y).toBeCloseTo(expected.y, 6)
    expect(pos.z).toBeCloseTo(expected.z, 6)
    // D1.3's own invariant, asserted where the whole page is mounted (the unit-level
    // form is workbenchViewCubeGlobalUntouched.int13b.test.tsx): the workbench
    // publishes NO global bridge. FAILS-IF anyone reintroduces the acquisition
    // effect -- which, under D1's co-mount, is the UI-17-R1 clobber returning.
    expect((window as unknown as { __cncViewport?: unknown }).__cncViewport).toBeUndefined()

    // AC2 (rest half) -- no frame drive at rest: the loop is not running and
    // the frame count does not free-run.
    expect(runtime.frameDriveRunning).toBe(false)
    const restCount = runtime.frameCount()
    await sleep(120)
    expect(runtime.frameCount()).toBe(restCount)
  }, 40_000)

  it('AC1/AC2/AC6/AC7: session swaps the rail, drives frames, shows the plane grid, arms right-drag orbit, right-click opens the menu -- and ALL of it ends with the session', async () => {
    const runtime = await boot()

    // -- Enter a session on XY --------------------------------------------
    await openSketchOn(runtime, 'xy')

    // AC1 -- mode switch: sketch sections in, modeling sections out.
    expect(screen.getByTestId('workbench-right-rail').getAttribute('data-rail-mode')).toBe('sketch')
    expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy()
    expect(screen.queryByTestId('workbench-modeling-toolbar')).toBeNull()
    // The ported SECTIONS drive the shared engine: arming a tool highlights it.
    fireEvent.click(screen.getByTestId('workbench-package-tool-circle-center'))
    expect(screen.getByTestId('workbench-package-tool-circle-center').getAttribute('aria-pressed')).toBe('true')

    // AC7 -- Q-15: session begin flipped the right-drag-orbit override ON.
    expect(runtime.sketchRightDragOrbitCalls).toEqual([true])

    // AC6 -- the plane grid is up, oriented by the session plane's frame.
    const grid = runtime.getSketchGrid()
    expect(grid).not.toBeNull()
    {
      const frame = BASE_PLANE_FRAMES.xy
      const q = (grid as THREE.Group).quaternion
      // GridHelper's own plane normal is local +Y; its lines run along local X.
      const yWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
      const xWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
      expect(yWorld.distanceTo(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z))).toBeLessThan(1e-9)
      expect(xWorld.distanceTo(new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z))).toBeLessThan(1e-9)
    }

    // AC2 -- frame drive: the count increases across a synthetic pointermove
    // WITHOUT any camera change.
    expect(runtime.frameDriveRunning).toBe(true)
    const camBefore = (runtime.camera as THREE.PerspectiveCamera).position.clone()
    const before = runtime.frameCount()
    canvasEl().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: CENTRE.x + 20, clientY: CENTRE.y, button: 0 }))
    await waitFor(() => expect(runtime.frameCount()).toBeGreaterThan(before), { timeout: 5_000 })
    expect((runtime.camera as THREE.PerspectiveCamera).position.distanceTo(camBefore)).toBe(0)

    // AC7 -- right CLICK (below the package's 5px drag threshold) opens the
    // sketch context menu. The package's own native listeners handle it.
    expect(sketcherMenuStore.getState().menuAt).toBeNull()
    canvasEl().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: CENTRE.x, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: CENTRE.x, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: CENTRE.x, clientY: CENTRE.y, button: 2 }))
    expect(sketcherMenuStore.getState().menuAt).not.toBeNull()
    sketcherMenuStore.close()

    // AC7 boundary, menu halves (WO UI-17-R1, audit finding 1 -- the camera
    // halves run against the REAL OrbitControls in
    // workbenchNavRightDragOrbit.test.ts): 4px of right travel is still a
    // MENU request; 6px is the tail of an orbit drag and must NOT open one.
    // Same shared threshold both sides -- the frozen package classifies by
    // travel from its bubble-phase right-down record.
    canvasEl().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: CENTRE.x, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: CENTRE.x + 4, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: CENTRE.x + 4, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: CENTRE.x + 4, clientY: CENTRE.y, button: 2 }))
    expect(sketcherMenuStore.getState().menuAt, '4px right-travel must still open the menu').not.toBeNull()
    sketcherMenuStore.close()

    canvasEl().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: CENTRE.x, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: CENTRE.x + 6, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: CENTRE.x + 6, clientY: CENTRE.y, button: 2 }))
    canvasEl().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: CENTRE.x + 6, clientY: CENTRE.y, button: 2 }))
    expect(sketcherMenuStore.getState().menuAt, '6px right-travel is an orbit drag: no menu').toBeNull()

    // -- Finish ------------------------------------------------------------
    await finishSketch()

    // AC1 -- mode switch back: modeling sections return.
    expect(screen.getByTestId('workbench-right-rail').getAttribute('data-rail-mode')).toBe('modeling')
    expect(screen.getByTestId('workbench-modeling-toolbar')).toBeTruthy()
    expect(screen.queryByTestId('workbench-package-sketch-toolbar')).toBeNull()

    // AC2 -- the loop is STOPPED (not merely plateaued): running flag off AND
    // the count stays put over a real wait.
    expect(runtime.frameDriveRunning).toBe(false)
    const after = runtime.frameCount()
    await sleep(120)
    expect(runtime.frameCount()).toBe(after)

    // AC6 -- grid absent after finish.
    expect(runtime.getSketchGrid()).toBeNull()

    // AC7 -- override released with the session.
    expect(runtime.sketchRightDragOrbitCalls).toEqual([true, false])

    // AC6 (orientation, non-identity case) -- a second session on XZ: the
    // grid's quaternion follows THAT plane's frame.
    await openSketchOn(runtime, 'xz')
    const gridXz = runtime.getSketchGrid()
    expect(gridXz).not.toBeNull()
    {
      const frame = BASE_PLANE_FRAMES.xz
      const q = (gridXz as THREE.Group).quaternion
      const yWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
      const xWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
      expect(yWorld.distanceTo(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z))).toBeLessThan(1e-9)
      expect(xWorld.distanceTo(new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z))).toBeLessThan(1e-9)
    }
    await finishSketch()
    expect(runtime.getSketchGrid()).toBeNull()
  }, 60_000)

  it('AC4: planes default-visible, the tree eye toggle hides/shows (state + scene), and the choice persists in uiPrefs across a remount', async () => {
    const runtime = await boot()

    // Default ON: one ambient glyph per genesis node (Origin + XY/XZ/YZ).
    await waitFor(() => expect(liveAmbientGlyphIds(runtime).sort()).toEqual([...GENESIS_NODE_IDS].sort()))

    // Tree eye toggle on the XY row hides exactly that glyph.
    fireEvent.click(screen.getByTestId(`genesis-visible-${BASE_PLANE_XY_NODE_ID}`))
    await waitFor(() => expect(liveAmbientGlyphIds(runtime)).not.toContain(BASE_PLANE_XY_NODE_ID))
    expect(liveAmbientGlyphIds(runtime)).toHaveLength(GENESIS_NODE_IDS.length - 1)
    // State: uiPrefs holds it, and the eye reads hidden.
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toContain(BASE_PLANE_XY_NODE_ID)
    expect(screen.getByTestId(`genesis-visible-${BASE_PLANE_XY_NODE_ID}`).getAttribute('aria-pressed')).toBe('false')

    // Persistence: the choice reaches the persisted uiPrefs storage (the
    // reload contract -- zustand persist writes through on every set).
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem('liencam-ui-prefs') ?? null
    expect(raw).not.toBeNull()
    expect((JSON.parse(raw as string) as { state: { workbenchHiddenGenesisIds: string[] } }).state.workbenchHiddenGenesisIds).toContain(BASE_PLANE_XY_NODE_ID)

    // Reload persistence (WO UI-17-R1, audit finding 3): a cleanup+remount
    // alone never proves the RELOAD path, because the module-level Zustand
    // store still holds the value in memory -- the remount could read that and
    // the test would pass even if storage restore were broken. So: wipe the
    // in-memory field, put the ALREADY-VERIFIED persisted payload back (the
    // wipe itself write-through-persists the empty list -- zustand persist
    // writes storage on every set, exactly what a reload would NOT have seen),
    // force the REAL restore path with persist.rehydrate(), and only then
    // remount. FAILS-IF rehydration cannot recover the hidden plane from the
    // persisted payload.
    cleanup()
    useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toEqual([])
    ;(globalThis as { localStorage?: Storage }).localStorage?.setItem('liencam-ui-prefs', raw as string)
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchHiddenGenesisIds).toContain(BASE_PLANE_XY_NODE_ID)
    const runtime2 = await boot()
    await waitFor(() => expect(liveAmbientGlyphIds(runtime2)).toHaveLength(GENESIS_NODE_IDS.length - 1))
    expect(liveAmbientGlyphIds(runtime2)).not.toContain(BASE_PLANE_XY_NODE_ID)

    // Toggle back ON: the glyph returns.
    fireEvent.click(screen.getByTestId(`genesis-visible-${BASE_PLANE_XY_NODE_ID}`))
    await waitFor(() => expect(liveAmbientGlyphIds(runtime2).sort()).toEqual([...GENESIS_NODE_IDS].sort()))
  }, 60_000)
})
