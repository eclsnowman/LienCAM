// @vitest-environment jsdom
// WO SKC-54: click-pick (and hover, and constraint-badge picking) works at ANY camera pose, not
// just square-on.
//
// SKC-52's investigation + audit (coordination/reports/SKC-52.report.json,
// coordination/reports/SKC-52.audit.json) proved SketchLayer.pick()'s raw NDC-unprojection
// diverges from the plane-frame raycast every OTHER sketch interaction already uses
// (workbenchSketcherHost.ts's clientToPlaneWorld, consumed via sketchInteraction.ts's
// clientToLocal) the moment the camera orbits off square-on -- in EITHER projection mode
// (audit-measured error: orthographic-oblique 650.97, perspective-top 31.95mm) and on any
// PlaneFrame, not just world XY. This file proves the fix converges pick() onto that SAME
// correct conversion.
//
// Per the WO's binding acceptance: mounted over the REAL createWorkbenchSketcherHost with a REAL
// runtime camera and REAL BASE_PLANE_FRAMES. Identity-stub hosts are FORBIDDEN here -- a stub's
// `clientToPlaneWorld: (x, y) => ({ x, y })` would pass every leg below vacuously.
//
// WO SKC-55 (honest-oracle rework, R0-R2): every expected-screen-pixel derivation in this file --
// ground truth, marquee corners, `drawLine`, and (as of R2) both badge-picking legs -- now goes
// through `renderedScreenTruth` (below), which reads the SketchLayer's own LIVE
// `group.matrixWorld` (frame basis + display offset/rotation + the real SKETCH_Z lift) rather than
// calling `host.projectToScreen`/`legacyBadgeScreenPoint` (the functions under test) or
// reconstructing a hardcoded-SKETCH_Z world point by hand. Pre-SKC-55, this file's own oracle
// shared the EXACT blind spot the picking bug did (both silently agreed at z=0); R1 closed that
// for entity pick/draw/marquee; R2 closes the two remaining badge legs the R1 audit named (see
// coordination/reports/SKC-55.report.json's r2.censusTable for the full row-by-row derivation).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import * as THREE from 'three'

import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { BADGE_PX } from '../../lib/sketch/sketcher/sketchLayer'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { Sketch } from '../../lib/sketch/sketcher'
import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { seedGenesisNodes, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import {
  createWorkbenchSketcherHost, makePlaneFrameGroup,
} from '../../components/model3d/workbench/workbenchSketcherHost'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { useUiPrefs } from '../../store/uiPrefs'
import { centerSelectionIdForEntity } from '../../lib/sketch/centerReferences'

// SKC-46: jsdom's own `localStorage` is not usable in this project's test setup -- uiPrefs'
// persist middleware needs a real Storage-shaped object (same shim workbenchSketchMount.test.ts
// installs).
const uiPrefsMemory = new Map<string, string>()
const uiPrefsStorageShim: Storage = {
  get length() { return uiPrefsMemory.size },
  clear: () => uiPrefsMemory.clear(),
  getItem: (key) => uiPrefsMemory.get(key) ?? null,
  key: (index) => [...uiPrefsMemory.keys()][index] ?? null,
  removeItem: (key) => { uiPrefsMemory.delete(key) },
  setItem: (key, value) => { uiPrefsMemory.set(key, String(value)) },
}
const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', { value: uiPrefsStorageShim, configurable: true })
afterAll(() => {
  if (priorLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
})

const SKETCH_NODE_ID = 'sketch3d:s1'
const RECT = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 } as DOMRect

function blankSketch(): Sketch {
  return { id: 's1', layerId: 'workbench', entities: [], constraints: [], dimensions: [], solveStatus: null }
}

let restoreCanvas2d: (() => void) | null = null

interface Mount {
  sketcher: Sketcher
  host: ReturnType<typeof createWorkbenchSketcherHost>
  canvas: HTMLCanvasElement
  container: HTMLElement
  dag: FeatureDag
  runtime: FakeSceneRuntime
}

/** Square-on perspective camera looking normal-to-plane from 100mm out -- the SAME geometry
 *  `orientNormalToPlane` produces on session entry, and workbenchSketchMount.test.ts's own
 *  `mount()` default. */
function squareOnPerspective(frame: typeof BASE_PLANE_FRAMES.xy, plane: 'xy' | 'xz' | 'yz'): THREE.Camera {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const n = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
  cam.position.copy(new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)).addScaledVector(n, 100)
  cam.up.set(0, 0, 1)
  if (plane === 'xy') cam.up.set(0, 1, 0)
  cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
  cam.updateMatrixWorld(true)
  return cam
}

/** Square-on ORTHOGRAPHIC camera (never orbited) -- the SAME shape legs (a)/(d) above build
 *  inline, factored out for WO SKC-57's own tests below. World-per-pixel is a flat, position-
 *  independent 0.25 on both axes (200mm/800px === 150mm/600px), so a screen-pixel offset converts
 *  to a world-mm distance through one constant -- the simplest pose for testing tolerance WIDTH
 *  (this WO's own concern), as opposed to SKC-54/55's off-normal pose coverage. */
function squareOnOrthographic(frame: typeof BASE_PLANE_FRAMES.xy): THREE.Camera {
  const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
  cam.position.set(frame.origin.x, frame.origin.y, frame.origin.z + 100)
  cam.up.set(0, 1, 0)
  cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
  cam.updateMatrixWorld(true)
  return cam
}

/** The workbench mount, built exactly as SolidsWorkbenchPage / workbenchSketchMount.test.ts
 *  builds it -- the REAL createWorkbenchSketcherHost over a REAL PlaneFrame and a REAL camera.
 *  `makeCamera` lets a leg start from an orthographic (factory-default) camera instead of the
 *  perspective default; every leg below then ORBITS by mutating that SAME camera object in
 *  place (never swapping it for a new instance), so the host's one-time-captured `camera`
 *  reference (workbenchSketcherHost.ts:98) never goes stale mid-test. */
function mount(
  plane: 'xy' | 'xz' | 'yz' = 'xy',
  initialSketch: Sketch = blankSketch(),
  makeCamera: (frame: typeof BASE_PLANE_FRAMES.xy, plane: 'xy' | 'xz' | 'yz') => THREE.Camera = squareOnPerspective,
): Mount {
  const container = document.createElement('div')
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  document.body.appendChild(container)
  canvas.getBoundingClientRect = () => RECT
  container.getBoundingClientRect = () => RECT

  const runtime = createFakeSceneRuntime()
  const frame = BASE_PLANE_FRAMES[plane]
  runtime.camera = makeCamera(frame, plane)

  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())

  dag.insertNode({
    id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
    payload: { sketch: initialSketch, externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  sketchSessionStore.bindDeps({
    dag, history, scheduler, wrapper: null,
    notice: () => {}, onDocumentChanged: () => {}, onHistoryStep: () => {},
  })

  const overlayRoot = makePlaneFrameGroup(frame)
  const host = createWorkbenchSketcherHost({
    canvas, container, runtime, overlayRoot, getFrame: () => frame,
  })
  const sketcher = new Sketcher(host)
  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })

  sketchSessionStore.begin(SKETCH_NODE_ID, frame, initialSketch)
  sketcher.enter()
  // Pass the REAL view state (getViewState()), exactly the `updateSketch(sketch, getViewState())`
  // pattern sketchSessionStore's own doc comment names as the production call shape. Without it,
  // `view.originAnchorId` never reaches the layer, and workbench's injected origin-anchor point
  // (sketchSessionStore.begin -> injectWorkbenchOrigin, always baked into `sketch.entities` at the
  // frame's local (0,0)) is neither excluded from marquee (entitiesInRect skips
  // `e.id === view.originAnchorId`) nor has its own reserved fix-badge suppressed -- an unrelated
  // pre-existing gap this file's geometry must route around regardless (see the per-leg comments).
  sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
  sketcher.onFrame(host.worldPerPixel(), 800, 600)

  return { sketcher, host, canvas, container, dag, runtime }
}

function pointer(type: string, target: EventTarget, x: number, y: number, button = 0): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}

/** A tool CLICK is a press+release in place (no drag). */
function click(m: Mount, x: number, y: number): void {
  pointer('pointerdown', m.canvas, x, y)
  pointer('pointerup', m.canvas, x, y)
  m.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
}

/** A left-to-right window drag: press on empty space, move past the 5px marquee threshold,
 *  release -- the lasso/marquee gesture. */
function drag(m: Mount, x0: number, y0: number, x1: number, y1: number): void {
  pointer('pointerdown', m.canvas, x0, y0)
  const steps = 4
  for (let i = 1; i <= steps; i++) {
    pointer('pointermove', m.canvas, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
  }
  pointer('pointerup', m.canvas, x1, y1)
  m.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
}

function payloadSketch(m: Mount): Sketch {
  return m.dag.getNode(SKETCH_NODE_ID)!.payload.sketch as Sketch
}

/** WO SKC-55-R1 (audit finding [0], matrixWorld oracle): the file's ONE screen-truth primitive,
 *  used everywhere a ground-truth or a drive (click/drag) screen position is needed. INDEPENDENT
 *  of `host.projectToScreen` (the function under test) AND of the picker: it reads the
 *  SketchLayer's own LIVE `group.matrixWorld` -- which bakes in the plane frame's basis/origin
 *  (from `overlayRoot`, set once at mount) AND the layer's own display offset/rotation/Z-lift
 *  (`applyOffsetToGroup`'s `group.position.set(offset.x, offset.y, SKETCH_Z)`, re-applied on
 *  every `update()`) -- applies it to the LOCAL sketch point, then projects the resulting WORLD
 *  point with the raw camera math (`Vector3.project` + NDC->pixel), the same pattern the
 *  CAM-shaped-host badge test below already uses for its own independent oracle. A mismatch
 *  between where the group ACTUALLY renders and where `projectToScreen` ASSUMES it renders (its
 *  own separately-imported `SKETCH_Z` constant, oblivious to the live group) is visible here by
 *  construction -- see the render-lift mutation proof under coordination/evidence/SKC-55/r1/.
 *  `updateMatrixWorld(true)` is forced because nothing in this jsdom test tree runs a real
 *  render loop (which would otherwise refresh it every frame). */
function renderedScreenTruth(m: Mount, local: { x: number; y: number }): { x: number; y: number } | null {
  m.sketcher.layer.group.updateMatrixWorld(true)
  const rect = m.canvas.getBoundingClientRect()
  const w = rect.width || m.canvas.clientWidth || 0
  const h = rect.height || m.canvas.clientHeight || 0
  if (!(w > 0 && h > 0)) return null
  const world = new THREE.Vector3(local.x, local.y, 0).applyMatrix4(m.sketcher.layer.group.matrixWorld)
  const ndc = world.project(m.runtime.camera as THREE.Camera)
  if (![ndc.x, ndc.y, ndc.z].every(Number.isFinite)) return null
  return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h }
}

/** WO SKC-55-R1 (audit finding [1], depth-aware tolerance probes): the file's ONE tolerance-scale
 *  primitive. Own math -- 2*tan(fov/2)*depth/h, the SAME textbook perspective-frustum formula
 *  `host.worldPerPixel` implements, but computed here from scratch against the live camera and
 *  the SAME independent `group.matrixWorld` truth `renderedScreenTruth` uses above -- never by
 *  calling `host.worldPerPixel()` (the function under test). Evaluated AT the probe's own local
 *  position and SKETCH_Z, not the frame-global origin/z=0 default, so a probe's accept/reject
 *  boundary actually proves the tolerance owner is position- AND depth-aware. */
function independentWorldPerPixelAt(m: Mount, local: { x: number; y: number }): number {
  m.sketcher.layer.group.updateMatrixWorld(true)
  const cam = m.runtime.camera as THREE.PerspectiveCamera
  const rect = m.canvas.getBoundingClientRect()
  const h = rect.height || m.canvas.clientHeight || 0
  const world = new THREE.Vector3(local.x, local.y, 0).applyMatrix4(m.sketcher.layer.group.matrixWorld)
  const cameraPoint = world.applyMatrix4(cam.matrixWorldInverse)
  const depth = -cameraPoint.z
  const frustumHeight = 2 * Math.tan((cam.getEffectiveFOV() * Math.PI) / 360) * depth
  return frustumHeight / h
}

/** Draw a line at two LOCAL points via real pointer events, projected to screen through
 *  `renderedScreenTruth` (the matrixWorld oracle above, at the CURRENT camera pose) -- then
 *  explicitly re-arm 'select' (a completed 2-click line does NOT auto-return to select; every
 *  other draw test in this tree either checks entities only or re-arms via a toolbox click, per
 *  workbenchSketchMount.test.ts's `wbTool(page, 'select')` precedent). */
function drawLine(m: Mount, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const pa = renderedScreenTruth(m, a)
  const pb = renderedScreenTruth(m, b)
  if (!pa || !pb) throw new Error('drawLine: the layer group must project both endpoints at the current camera pose')
  sketcherTools.armTool('line')
  click(m, pa.x, pa.y)
  click(m, pb.x, pb.y)
  sketcherTools.armTool('select')
}

let M: Mount

beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  uiPrefsMemory.clear()
  useUiPrefs.setState({ lastFilletRadius: null, lastChamferSetback: null })
})
afterEach(() => {
  M?.sketcher.dispose()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  document.body.innerHTML = ''
})

describe('SKC-54 AC1/AC2: click-pick, lasso, and hover agree at any camera pose (real host, real PlaneFrame)', () => {
  it('(a) factory-default ORTHOGRAPHIC top-down, then ORBITED off-normal on XY', () => {
    M = mount('xy', blankSketch(), (frame) => {
      const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
      cam.position.set(frame.origin.x, frame.origin.y, frame.origin.z + 100)
      cam.up.set(0, 1, 0)
      cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
      cam.updateMatrixWorld(true)
      return cam
    })
    // Badges (constraint glyphs) default ON and are checked BEFORE entities in pick(); an
    // inferred horizontal constraint on this leg's dead-flat line would otherwise compete for the
    // same anchor point. Badge picking has its own dedicated test below.
    sketchSessionStore.setState({ glyphsVisible: false })
    // Off the workbench's injected origin-anchor point (always baked in at the frame's local
    // (0,0) -- workbenchOriginAnchor.ts): a click/hover EXACTLY at (0,0) legitimately hits that
    // reserved point first (originAnchorLayer.test.ts proves that priority is intentional), so
    // this leg's geometry sits clear of it entirely, at y=20.
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.OrthographicCamera
    // ORBIT: an ordinary oblique tilt, still orthographic (same object, mutated in place).
    cam.position.set(0, -150, 120)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    // MACHINE-RECORDED camera projection mode + pose for this leg.
    expect(M.runtime.camera).toBeInstanceOf(THREE.OrthographicCamera)
    console.info('SKC-54 leg(a) pose', {
      projection: 'orthographic', plane: 'xy', position: cam.position.toArray(),
    })

    // Ground truth ONLY from the INDEPENDENT forward projection (host.projectToScreen), never
    // derived from the reverse callback under test.
    // Keep this owner-body probe off the line's now-selectable center node.
    const groundTruth = renderedScreenTruth(M, { x: 8, y: 20 })
    expect(groundTruth).not.toBeNull()
    if (!groundTruth) throw new Error('unreachable (asserted above)')

    // HOVER: a bare pointermove (no prior pointerdown) exercises the SAME pickAt() the click
    // below does, proving the hover path is cured too.
    pointer('pointermove', M.canvas, groundTruth.x, groundTruth.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    // CLICK.
    click(M, groundTruth.x, groundTruth.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])

    // LASSO agrees on the same entity (and, with the real view state now wired through, correctly
    // excludes the origin anchor even though this rect would otherwise miss it anyway).
    workbenchSketchDocumentPort.setSelection([])
    const a = renderedScreenTruth(M, { x: -20, y: 10 })
    const b = renderedScreenTruth(M, { x: 20, y: 30 })
    if (!a || !b) throw new Error('unreachable (asserted above)')
    drag(M, a.x, a.y, b.x, b.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })

  it('(b) PERSPECTIVE camera top-down, then ORBITED off-normal on XY', () => {
    M = mount('xy')
    sketchSessionStore.setState({ glyphsVisible: false }) // see leg (a)'s badge comment
    // Clear of the injected origin anchor at local (0,0) -- see leg (a)'s comment.
    drawLine(M, { x: 10, y: 10 }, { x: 30, y: 25 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    expect(cam).toBeInstanceOf(THREE.PerspectiveCamera) // machine-recorded: perspective, pre-orbit too
    // A body point at t=0.75, deliberately distinct from the selectable
    // center node at t=0.5.
    const bodyLocal = { x: 25, y: 21.25 }

    // R1.1: TOP-DOWN matrix FIRST, before any orbit -- SKC-52's audit measured a 31.9516 mm
    // perspective-TOP-DOWN error for the old raw-NDC unprojection (nonzero, unlike the
    // orthographic top-down case leg (d) anchors), so this pose is its own named risk slice, not
    // merely a stepping stone to the orbited pose below.
    console.info('SKC-54 leg(b) pose', {
      projection: 'perspective', plane: 'xy', position: cam.position.toArray(), orbited: false,
    })
    const topDownGroundTruth = renderedScreenTruth(M, bodyLocal)
    expect(topDownGroundTruth).not.toBeNull()
    if (!topDownGroundTruth) throw new Error('unreachable (asserted above)')

    pointer('pointermove', M.canvas, topDownGroundTruth.x, topDownGroundTruth.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    click(M, topDownGroundTruth.x, topDownGroundTruth.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])

    workbenchSketchDocumentPort.setSelection([])
    const topDownA = renderedScreenTruth(M, { x: 5, y: 5 })
    const topDownB = renderedScreenTruth(M, { x: 35, y: 30 })
    if (!topDownA || !topDownB) throw new Error('unreachable (asserted above)')
    drag(M, topDownA.x, topDownA.y, topDownB.x, topDownB.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
    workbenchSketchDocumentPort.setSelection([])

    // ORBIT: the SAME camera object, mutated in place off-normal.
    cam.position.set(40, -70, 65)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    console.info('SKC-54 leg(b) pose', {
      projection: 'perspective', plane: 'xy', position: cam.position.toArray(), orbited: true,
    })

    const groundTruth = renderedScreenTruth(M, bodyLocal)
    expect(groundTruth).not.toBeNull()
    if (!groundTruth) throw new Error('unreachable (asserted above)')

    pointer('pointermove', M.canvas, groundTruth.x, groundTruth.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    click(M, groundTruth.x, groundTruth.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])

    workbenchSketchDocumentPort.setSelection([])
    const a = renderedScreenTruth(M, { x: 5, y: 5 })
    const b = renderedScreenTruth(M, { x: 35, y: 30 })
    if (!a || !b) throw new Error('unreachable (asserted above)')
    drag(M, a.x, a.y, b.x, b.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })

  it('(c) a non-XY base plane (YZ), perspective camera, ORBITED off-normal', () => {
    M = mount('yz')
    sketchSessionStore.setState({ glyphsVisible: false }) // see leg (a)'s badge comment
    // Clear of the injected origin anchor at local (0,0) -- see leg (a)'s comment.
    drawLine(M, { x: 10, y: 10 }, { x: 30, y: 25 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    // Off the YZ plane's normal (1,0,0): not purely along the normal axis, and not in-plane.
    cam.position.set(80, 40, 60)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    expect(M.runtime.camera).toBeInstanceOf(THREE.PerspectiveCamera)
    console.info('SKC-54 leg(c) pose', {
      projection: 'perspective', plane: 'yz', position: cam.position.toArray(),
    })

    const bodyLocal = { x: 25, y: 21.25 }
    const groundTruth = renderedScreenTruth(M, bodyLocal)
    expect(groundTruth).not.toBeNull()
    if (!groundTruth) throw new Error('unreachable (asserted above)')

    pointer('pointermove', M.canvas, groundTruth.x, groundTruth.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    click(M, groundTruth.x, groundTruth.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])

    workbenchSketchDocumentPort.setSelection([])
    const a = renderedScreenTruth(M, { x: 5, y: 5 })
    const b = renderedScreenTruth(M, { x: 35, y: 30 })
    if (!a || !b) throw new Error('unreachable (asserted above)')
    drag(M, a.x, a.y, b.x, b.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })

  // AC6 (mutation-proof) comparison anchor: SKC-52's audit measured the OLD raw-unprojection
  // math's error as EXACTLY ZERO only for an ORTHOGRAPHIC top-down camera (its perspective-top
  // error was 31.95mm, NOT zero -- top-down alone does not make the old math right). So this
  // anchor -- and only this anchor -- uses an orthographic camera that NEVER orbits, matching
  // CAM's own immune case; the mutation proof needs it to keep passing while legs (a)-(c) above
  // fail BY NAME, otherwise a mutation that breaks EVERYTHING wouldn't prove the test targets the
  // off-normal defect specifically. See SKC-54.report.json's mutationProof section for the paired
  // before/after run this anchors.
  //
  // R1.1: expanded to the FULL hover/click/lasso matrix (not click-only) -- this is the immune
  // (error-zero) case, so it must survive the AC6 mutation unchanged, GREEN, for all three
  // assertions, exactly as it did for click alone.
  it('(d) SQUARE-ON ORTHOGRAPHIC pose (never orbited) still selects -- unchanged by this WO, and the mutation-proof anchor', () => {
    M = mount('xy', blankSketch(), (frame) => {
      const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
      cam.position.set(frame.origin.x, frame.origin.y, frame.origin.z + 100)
      cam.up.set(0, 1, 0)
      cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
      cam.updateMatrixWorld(true)
      return cam
    })
    sketchSessionStore.setState({ glyphsVisible: false }) // see leg (a)'s badge comment
    drawLine(M, { x: 10, y: 10 }, { x: 30, y: 25 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const bodyLocal = { x: 25, y: 21.25 }
    const groundTruth = renderedScreenTruth(M, bodyLocal)
    expect(groundTruth).not.toBeNull()
    if (!groundTruth) throw new Error('unreachable (asserted above)')

    pointer('pointermove', M.canvas, groundTruth.x, groundTruth.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    click(M, groundTruth.x, groundTruth.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])

    workbenchSketchDocumentPort.setSelection([])
    const a = renderedScreenTruth(M, { x: 5, y: 5 })
    const b = renderedScreenTruth(M, { x: 35, y: 30 })
    if (!a || !b) throw new Error('unreachable (asserted above)')
    drag(M, a.x, a.y, b.x, b.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })
})

// AC3 (CAM parity + the bare-layer no-callback fallback) is proved by the pre-existing
// src/tests/store/camSketchMount.test.ts and src/tests/sketch/originAnchorLayer.test.ts suites,
// re-run unmodified by this WO's gate -- see SKC-54-gate.log. Duplicating their harnesses here
// would just be a second, divergent copy of the same coverage.

describe('SKC-54 AC4: pick tolerance holds at +/-epsilon along the UN-FORESHORTENED screen axis', () => {
  it('option (a) chosen: probes run parallel to the orbit rotation axis, both signs, at a stated oblique pose', () => {
    M = mount('xy')
    // Constraint-glyph badges default ON (EMPTY_VIEW/sketchSessionStore glyphsVisible: true) and
    // are checked BEFORE entities in pick() -- an inferred horizontal constraint on the dead-flat
    // line drawn below would otherwise plant a badge near this probe's own anchor point and steal
    // the hit. Badge picking is this WO's own sibling-defect fix, covered by its own dedicated
    // test below; keep it out of THIS entity-tolerance probe.
    sketchSessionStore.setState({ glyphsVisible: false })
    // Horizontal line along local X, offset to y=20 -- clear of the workbench's injected origin
    // anchor point at local (0,0) (see the AC1/AC2 leg (a) comment: a click/hover exactly at the
    // origin legitimately hits that reserved point first, which is unrelated to this probe).
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    // Orbit AROUND THE LOCAL-Y AXIS (camera swings in the X-Z arc, Y unchanged): local-Y --
    // perpendicular to this horizontal line -- stays screen-scale-constant (the un-foreshortened
    // axis for THIS pose); local-X (parallel to the line) is what this specific tilt
    // foreshortens. STATED POSE: distance ~100mm, tilted ~60deg off the plane normal.
    cam.position.set(-86.6025403784, 0, 50)
    cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    console.info('SKC-54 AC4 pose', { projection: 'perspective', plane: 'xy', position: cam.position.toArray() })

    // WO SKC-55-R1 (audit finding [1]): INDEPENDENT of host.worldPerPixel() -- own frustum math,
    // evaluated AT the probe's own local position and SKETCH_Z (independentWorldPerPixelAt), not
    // the frame-global origin/z=0 default. Proves the tolerance owner (pick()'s worldPerPixelAt)
    // is position- AND depth-aware, not merely that a pixel-value happens to agree with it.
    const SKETCH_PICK_PX = 8
    const probeX = 8
    const tol = SKETCH_PICK_PX * independentWorldPerPixelAt(M, { x: probeX, y: 20 })
    const insideDelta = tol * 0.8
    // WO SKC-55-R2 (audit finding [1]): boundary mandated at 1.2x, matching the SKC-55 steep-pose
    // probe below and R1.2's two owner-specific probes -- this AC4 leg's own boundary had been
    // left at the pre-R1 1.35x, an inconsistency the R1 audit named explicitly.
    //
    // WO SKC-57 (P9): `click()` below is a stationary press+release, so it now also probes the
    // GENEROUS pointerup fallback (sketchInteraction.ts), not merely pointerdown's still-TIGHT
    // pick -- a "must MISS" boundary anchored to the OLD tight-only radius would now spuriously
    // hit via that fallback. Re-anchoring "outside" to 1.2x of the GENEROUS radius (not weakening
    // the assertion, just widening what "outside" means now that a plain click can reach further)
    // keeps this leg proving what it always proved: the accept region is CENTERED and position/
    // depth-aware, now at whichever radius a real click can actually land inside.
    const SKETCH_PICK_GENEROUS_PX = 16
    const generousTol = SKETCH_PICK_GENEROUS_PX * independentWorldPerPixelAt(M, { x: probeX, y: 20 })
    const outsideDelta = generousTol * 1.2

    // SKC-49-R3 (cross-WO integration fix, NOT a retarget): probe x is offset to 8 rather than 0.
    // SKC-49 (developed concurrently with this SKC-54 test on a sibling branch) now injects a
    // permanent, full-length construction line down local x=0 for EVERY sketch -- the Y-axis pick
    // anchor (sketchAnchors.ts SKETCH_AXIS_Y_ENTITY_ID), required so axis-vs-line angle dimensions
    // are clickable (Operator Q-35). A probe at exactly x=0 has distance ZERO to that vertical line
    // regardless of its y (pointSegDistance to a segment spanning y +/-100_000mm), which strictly
    // beats this line's own +/-delta distance the instant delta is nonzero -- so the axis, not the
    // drawn line, becomes the true nearest entity at x=0, breaking this probe's INTENT (measuring
    // tolerance around the drawn line) even though pick() itself is correct (nearest-wins is exactly
    // right; the axis line must win when it truly is nearest). x=8 stays inside the line's [-15,15]
    // body (no endpoint effects) and clear of BOTH injected axes (distance-to-Y-axis = |wx| = 8mm,
    // comfortably outside `tol`; distance-to-X-axis stays ~20mm via the y=20 offset already in use
    // by every other leg in this file) so the drawn line is once again the unambiguous nearest
    // candidate for every inside/outside probe below -- restoring AC4's original invariant instead
    // of retargeting its expected id.

    for (const sign of [1, -1] as const) {
      workbenchSketchDocumentPort.setSelection([])
      const insidePt = renderedScreenTruth(M, { x: probeX, y: 20 + sign * insideDelta })
      expect(insidePt, `inside-tol probe sign=${sign} must project`).not.toBeNull()
      click(M, insidePt!.x, insidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `inside tol (0.8x), sign=${sign}: must HIT`)
        .toEqual([line.id])

      workbenchSketchDocumentPort.setSelection([])
      const outsidePt = renderedScreenTruth(M, { x: probeX, y: 20 + sign * outsideDelta })
      expect(outsidePt, `outside-tol probe sign=${sign} must project`).not.toBeNull()
      click(M, outsidePt!.x, outsidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `outside tol (1.2x), sign=${sign}: must MISS`)
        .toEqual([])
    }
  })
})

// WO SKC-55 (Phase C can-fail gate): a >=60deg pose, steeper than AC4's ~60deg-anchored tolerance
// probe above, asserting the acceptance region is CENTERED on the DRAWN position -- not merely
// that a click somewhere near it hits. This is the test the WO's mutation proof targets (see
// coordination/evidence/SKC-55/ for the preimage + before/after mutation logs).
//
// 150mm out, 75deg off the plane normal (150*sin75, 0, 150*cos75), orbited AROUND THE LOCAL-X AXIS
// (camera swings in the Y-Z arc, X unchanged) -- the OPPOSITE axis from AC4's own convention, and
// deliberately so: the Z-lift parallax this mutation reintroduces shifts the ray-plane
// intersection in the direction of the camera's OWN XY offset from square-on (confirmed while
// building this test -- an X-Z-arc orbit shifted the mutation's error almost entirely along local
// X, invisible to this test's Y-only probe, since the drawn line runs along X and a shift PARALLEL
// to a line's own length doesn't move a click outside its pick tolerance; only the "draw lands
// where clicked" test below, which checks BOTH coordinates, caught it at that orbit axis). A Y-Z
// arc puts the parallax where this test's perpendicular (Y) probe can see it. Steeper than the
// WO's >=60deg floor because the shift must clearly exceed the 0.8x/1.2x probe margins to flip
// them (at 60deg the shift is only comparable to, not reliably bigger than, those margins).
const STEEP_POSE_CAMERA: readonly [number, number, number] = [0, -144.88887394336024, 38.82285676537811]

describe('SKC-55: pick/draw/marquee converge on the ACTUAL rendered (SKETCH_Z-lifted) plane at a steep (>=60deg) pose', () => {
  it('click at the DRAWN screen position selects, and the acceptance region is CENTERED there (both perpendicular signs, 0.8x/1.2x tol)', () => {
    M = mount('xy')
    sketchSessionStore.setState({ glyphsVisible: false })
    // Horizontal line at y=20, clear of the injected origin anchor and both injected axes (same
    // reasoning as AC4's own comment on probeX below).
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    // Orbit AROUND THE LOCAL-X AXIS (Y-Z arc -- see STEEP_POSE_CAMERA's own comment) to a STEEPER
    // >=60deg pose.
    cam.position.set(...STEEP_POSE_CAMERA)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    console.info('SKC-55 steep-pose test', { projection: 'perspective', plane: 'xy', position: cam.position.toArray() })

    // WO SKC-55-R1 (audit finding [1]): see AC4's own comment above -- independently calculated,
    // at the probe's own local position and SKETCH_Z, not the frame-global origin/z=0 default.
    const SKETCH_PICK_PX = 8
    // x=8: clear of the injected Y-axis (SKC-49) and inside the line's [-15,15] body -- same
    // reasoning as AC4's probeX comment above.
    const probeX = 8
    const tol = SKETCH_PICK_PX * independentWorldPerPixelAt(M, { x: probeX, y: 20 })
    const insideDelta = tol * 0.8
    // WO SKC-57 (P9): see AC4's own comment above -- `click()` now also probes the GENEROUS
    // pointerup fallback, so "outside" is re-anchored to the generous radius, not the old tight one.
    const SKETCH_PICK_GENEROUS_PX = 16
    const generousTol = SKETCH_PICK_GENEROUS_PX * independentWorldPerPixelAt(M, { x: probeX, y: 20 })
    const outsideDelta = generousTol * 1.2

    for (const sign of [1, -1] as const) {
      workbenchSketchDocumentPort.setSelection([])
      const insidePt = renderedScreenTruth(M, { x: probeX, y: 20 + sign * insideDelta })
      expect(insidePt, `inside probe sign=${sign} must project`).not.toBeNull()
      click(M, insidePt!.x, insidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `CENTERED accept region, sign=${sign} inside 0.8x: must HIT`)
        .toEqual([line.id])

      workbenchSketchDocumentPort.setSelection([])
      const outsidePt = renderedScreenTruth(M, { x: probeX, y: 20 + sign * outsideDelta })
      expect(outsidePt, `outside probe sign=${sign} must project`).not.toBeNull()
      click(M, outsidePt!.x, outsidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `CENTERED accept region, sign=${sign} outside 1.2x: must MISS`)
        .toEqual([])
    }
  })

  it('draw lands where clicked, and a marquee that visually covers an entity selects it, at the same >=60deg pose', () => {
    M = mount('xy')
    sketchSessionStore.setState({ glyphsVisible: false })

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    cam.position.set(...STEEP_POSE_CAMERA)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)

    // DRAW AFTER orbiting (not square-on): clientToLocal (sketchInteraction.ts) is shared by
    // drawing, dragging, and marquee corners -- the fix relocates where NEW geometry lands at a
    // tilt too, not just where an EXISTING entity picks. `drawLine` itself now projects through
    // the honest SKETCH_Z-lifted plane (see its own doc comment), so a click positioned there must
    // resolve back to the SAME local coordinate via the (fixed) reverse conversion.
    const target = { x: 12, y: 8 }
    const targetEnd = { x: target.x + 20, y: target.y }
    // WO SKC-55-R1 (audit finding [0]): the INDEPENDENT click-truth pixels drawLine actually
    // clicked at -- captured here, separately, so the assertion below never shares drawLine's own
    // call to renderedScreenTruth by reference (it recomputes the SAME matrixWorld projection at
    // assertion time instead).
    const clickTruth = renderedScreenTruth(M, target)
    const clickEndTruth = renderedScreenTruth(M, targetEnd)
    if (!clickTruth || !clickEndTruth) throw new Error('unreachable (drawLine below already asserts this projects)')

    drawLine(M, target, targetEnd)
    const drawnLine = payloadSketch(M).entities.find((e) => e.kind === 'line')!
    // (1) Document-coordinate roundtrip: the LOCAL point the click resolved to matches what was
    // clicked for.
    expect(drawnLine.start.x, 'a point drawn at a clicked screen position must render AT that position (matrixWorld oracle)')
      .toBeCloseTo(target.x, 6)
    expect(drawnLine.start.y).toBeCloseTo(target.y, 6)
    expect(drawnLine.end.x).toBeCloseTo(targetEnd.x, 6)
    expect(drawnLine.end.y).toBeCloseTo(targetEnd.y, 6)
    // (2) SCREEN-space matrixWorld truth (the audit's own literal ask): the drawn entity's stored
    // LOCAL coordinates, forward-mapped through the layer's ACTUAL live group.matrixWorld and
    // projected with the raw camera math, must land on the SAME pixel the user clicked at. This is
    // what the render-lift mutation (group renders somewhere the pick plane does not) breaks even
    // when (1) above happens to still agree (see coordination/evidence/SKC-55/r1/).
    const renderedStart = renderedScreenTruth(M, { x: drawnLine.start.x, y: drawnLine.start.y })
    const renderedEnd = renderedScreenTruth(M, { x: drawnLine.end.x, y: drawnLine.end.y })
    if (!renderedStart || !renderedEnd) throw new Error('unreachable (asserted above)')
    expect(renderedStart.x, 'the drawn entity must RENDER at the same pixel it was clicked at (matrixWorld oracle)')
      .toBeCloseTo(clickTruth.x, 3)
    expect(renderedStart.y).toBeCloseTo(clickTruth.y, 3)
    expect(renderedEnd.x).toBeCloseTo(clickEndTruth.x, 3)
    expect(renderedEnd.y).toBeCloseTo(clickEndTruth.y, 3)

    // MARQUEE: a box visually covering the drawn line (corners at the SAME honest projection).
    workbenchSketchDocumentPort.setSelection([])
    const a = renderedScreenTruth(M, { x: target.x - 5, y: target.y - 5 })
    const b = renderedScreenTruth(M, { x: target.x + 25, y: target.y + 5 })
    if (!a || !b) throw new Error('unreachable (asserted above)')
    drag(M, a.x, a.y, b.x, b.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([drawnLine.id])
  })
})

// WO SKC-55-R1 (audit finding [1]): SEPARATE can-fail mutation proofs for the TWO named tolerance
// owners -- SketchLayer.pick() (worldPerPixelAt) and SketchInteraction (wpp()/tolWorld()) -- each
// reverting independently to the OLD frame-global, origin-anchored `lastWorldPerPixel` /
// `host.worldPerPixel()` scalar without touching the other. Neither AC4 (~60deg, wide 0.8x/1.2x
// margins) nor the y=20 steep-pose test above (ratio too small at that probe position) separates
// cleanly under a tol-ONLY mutation (verified empirically while building this rework: both stayed
// GREEN under a bare `pick()`-tol revert) -- these two legs use a FARTHER probe (y=60, same
// STEEP_POSE_CAMERA) where the depth-vs-origin worldPerPixel ratio (~1.386x, computed directly
// against the live camera/group while authoring this test) clears the 0.8x/1.2x margins with a
// comfortable double-digit-percent cushion on both sides. See
// coordination/evidence/SKC-55/r1/ for both mutations' preimage + before/after logs.
describe('SKC-55-R1.2: the two tolerance owners are INDEPENDENTLY position/depth-aware (not the frame-global origin-anchored scalar)', () => {
  it('SketchLayer.pick(): click-select CENTERED accept region at a farther-out probe (y=60)', () => {
    M = mount('xy')
    sketchSessionStore.setState({ glyphsVisible: false })
    drawLine(M, { x: -15, y: 60 }, { x: 15, y: 60 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    cam.position.set(...STEEP_POSE_CAMERA)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)

    const SKETCH_PICK_PX = 8
    const probeX = 8
    const tol = SKETCH_PICK_PX * independentWorldPerPixelAt(M, { x: probeX, y: 60 })
    const insideDelta = tol * 0.8
    // WO SKC-57 (P9): see AC4's own comment above -- `click()` now also probes the GENEROUS
    // pointerup fallback, so "outside" is re-anchored to the generous radius, not the old tight one.
    const SKETCH_PICK_GENEROUS_PX = 16
    const generousTol = SKETCH_PICK_GENEROUS_PX * independentWorldPerPixelAt(M, { x: probeX, y: 60 })
    const outsideDelta = generousTol * 1.2

    for (const sign of [1, -1] as const) {
      workbenchSketchDocumentPort.setSelection([])
      const insidePt = renderedScreenTruth(M, { x: probeX, y: 60 + sign * insideDelta })
      expect(insidePt, `inside probe sign=${sign} must project`).not.toBeNull()
      click(M, insidePt!.x, insidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `pick() tol, sign=${sign} inside 0.8x: must HIT`)
        .toEqual([line.id])

      workbenchSketchDocumentPort.setSelection([])
      const outsidePt = renderedScreenTruth(M, { x: probeX, y: 60 + sign * outsideDelta })
      expect(outsidePt, `outside probe sign=${sign} must project`).not.toBeNull()
      click(M, outsidePt!.x, outsidePt!.y)
      expect(sketchSessionStore.getState().selectedIds, `pick() tol, sign=${sign} outside 1.2x: must MISS`)
        .toEqual([])
    }
  })

  it('SketchInteraction.tolWorld()/wpp(): a draw-tool placement click SNAPS to an existing point within the depth-aware radius', () => {
    // NOTE: entity DRAG-BEGIN (dragTargetsFor's endpoint-vs-body branch) was the FIRST design
    // tried for this mutation proof, but this file's `mount()` binds `wrapper: null`
    // (sketchSessionStore.bindDeps) -- workbenchSketchDocumentPort's `solved()` returns the
    // sketch UNCHANGED whenever the wasm solver has not booted (by name: "the wasm solver has not
    // booted yet"), so `dragMove`'s solve is a permanent no-op in THIS harness (confirmed
    // empirically while authoring this test: dragMove received the correct target position every
    // call, yet the committed geometry never moved). SNAP is solver-free -- a placement click's
    // landing point is decided entirely by `findSnap`'s radius check -- so it is the tolerance
    // consumer this harness CAN actually exercise for SketchInteraction's `wpp()`/`tolWorld()`.
    M = mount('xy')
    sketchSessionStore.setState({ glyphsVisible: false })

    // Anchor: a single point entity placed SQUARE-ON (before orbit), clear of the origin anchor
    // and both injected axes (same reasoning as every other leg's probeX/y=60 choice above).
    const anchor = { x: -15, y: 60 }
    sketcherTools.armTool('point')
    const anchorScreen = renderedScreenTruth(M, anchor)
    if (!anchorScreen) throw new Error('unreachable: anchor must project square-on')
    click(M, anchorScreen.x, anchorScreen.y)
    sketcherTools.armTool('select')
    const placedAnchor = payloadSketch(M).entities
      .filter((e) => e.kind === 'point')
      .find((e) => !e.construction)
    expect(placedAnchor?.at.x).toBeCloseTo(anchor.x, 6)
    expect(placedAnchor?.at.y).toBeCloseTo(anchor.y, 6)

    const cam = M.runtime.camera as THREE.PerspectiveCamera
    cam.position.set(...STEEP_POSE_CAMERA)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)

    // `delta` is the MIDPOINT between the depth-aware (fixed code, `layer.worldPerPixelAt` via
    // `wpp()`/`tolWorld()`) and origin-anchored (mutated code, `host.worldPerPixel()` defaults)
    // snap radius at the anchor's own position and SKETCH_Z (computed directly against the live
    // camera/group while authoring this test): inside the FIXED radius (the click SNAPS onto the
    // anchor) but outside the MUTATED, origin-anchored radius (the click stays at its raw
    // position instead).
    const SNAP_PX = 10
    const tolFixed = SNAP_PX * independentWorldPerPixelAt(M, anchor)
    const originWpp = independentWorldPerPixelAt(M, { x: 0, y: 0 })
    const tolMutated = SNAP_PX * originWpp
    const delta = (tolFixed + tolMutated) / 2
    const clickAt = { x: anchor.x + delta, y: anchor.y }

    sketcherTools.armTool('line')
    const clickScreen = renderedScreenTruth(M, clickAt)
    const secondScreen = renderedScreenTruth(M, { x: anchor.x + 40, y: anchor.y + 40 })
    expect(clickScreen, 'first click must project').not.toBeNull()
    expect(secondScreen, 'second click must project').not.toBeNull()
    if (!clickScreen || !secondScreen) throw new Error('unreachable (asserted above)')
    click(M, clickScreen.x, clickScreen.y)
    click(M, secondScreen.x, secondScreen.y)
    sketcherTools.armTool('select')

    const newLine = payloadSketch(M).entities.find((e) => e.kind === 'line')!
    expect(newLine.start.x, 'SketchInteraction wpp()/tolWorld() depth-aware: the click must SNAP to the anchor')
      .toBeCloseTo(anchor.x, 6)
    expect(newLine.start.y).toBeCloseTo(anchor.y, 6)
  })
})

function fixSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [{ id: 'p1', kind: 'point', construction: false, at: { x: 5, y: 5 } }],
    constraints: [{ id: 'fix1', kind: 'fix', point: { entityId: 'p1', site: 'self' } }],
    dimensions: [], solveStatus: null,
  }
}

describe('SKC-54 sibling defect: constraint-badge picking (sketchLayer.ts pick() badge loop)', () => {
  // R1.2: parameterized over BASE_PLANE_FRAMES.xy AND .yz -- the audit's first named risk slice
  // (projectToScreen on a NON-XY frame). Each plane gets its own off-normal oblique pose (the YZ
  // pose matches leg (c)'s above, off that frame's (1,0,0) normal).
  const badgePoseCases = [
    { plane: 'xy' as const, cameraPos: [-60, -60, 70] as const },
    { plane: 'yz' as const, cameraPos: [80, 40, 60] as const },
  ]

  for (const { plane, cameraPos } of badgePoseCases) {
    it(`a fix-constraint badge is picked correctly at an oblique perspective pose (${plane.toUpperCase()} plane, real projectToScreen)`, () => {
      const sketchWithFix = fixSketch()
      M = mount(plane, sketchWithFix)
      M.sketcher.updateSketch(sketchWithFix, { selectedIds: new Set(), glyphsVisible: true })

      const cam = M.runtime.camera as THREE.PerspectiveCamera
      cam.position.set(cameraPos[0], cameraPos[1], cameraPos[2])
      cam.up.set(0, 0, 1)
      cam.lookAt(0, 0, 0)
      cam.updateMatrixWorld(true)
      M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)

      const badge = M.sketcher.layer.getBadges().find((b) => b.constraintId === 'fix1')
      expect(badge, 'a fix badge must render with glyphsVisible').toBeDefined()
      if (!badge) throw new Error('unreachable (asserted above)')

      // WO SKC-55-R2 (audit finding [0]): matrixWorld oracle, same helper every other leg in
      // this file uses -- reads the layer group's ACTUAL live matrixWorld (frame basis +
      // offset/rotation + the SKETCH_Z lift) instead of host.projectToScreen (the function under
      // test, which shares pick()'s own hardcoded-SKETCH_Z blind spot -- see renderedScreenTruth's
      // own doc comment). badge.world is already sketch-LOCAL (constraintBadgeAnchors' anchor,
      // pre-offset/rotation/lift -- see sketchLayer.ts's own comment on legacyBadgeScreenPoint).
      const anchorScreen = renderedScreenTruth(M, { x: badge.world.x, y: badge.world.y })
      expect(anchorScreen, 'badge anchor must project via the live matrixWorld').not.toBeNull()
      if (!anchorScreen) throw new Error('unreachable (asserted above)')
      const badgeScreenX = anchorScreen.x - (badge.center.x - 0.5) * BADGE_PX
      const badgeScreenY = anchorScreen.y + (badge.center.y - 0.5) * BADGE_PX

      workbenchSketchDocumentPort.setSelection([])
      click(M, badgeScreenX, badgeScreenY)
      expect(sketchSessionStore.getState().selectedIds).toEqual(['fix1'])
    })
  }

  // R1.2's second named risk slice: production CAM's LOCKED orthographic XY host
  // (CNCViewport.ts:2181-2236) supplies clientToPlaneWorld/worldPerPixel but NO projectToScreen
  // member at all. That is the exact seam SketchLayer.legacyBadgeScreenPoint exists for -- and
  // src/tests/store/camSketchMount.test.ts's own host CANNOT stand in for it (its makeCamHost DOES
  // supply projectToScreen, so it never touches this fallback -- the WO's named TRAP). This mounts
  // the SAME real createWorkbenchSketcherHost every other leg in this file uses, then strips
  // `projectToScreen` from the returned host object entirely (not merely `undefined` -- an absent
  // key, matching production's shape byte-for-byte) before constructing the Sketcher, so
  // `Sketcher`'s own `host.projectToScreen === undefined` check (index.ts:137) threads `undefined`
  // into the layer and `projectRenderedPoint()` (sketchLayer.ts:1075) returns null, forcing pick()'s
  // badge loop onto `legacyBadgeScreenPoint` by construction.
  it('a fix-constraint badge is picked correctly with projectToScreen ABSENT (CAM-shaped host, legacy fallback)', () => {
    const container = document.createElement('div')
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    document.body.appendChild(container)
    canvas.getBoundingClientRect = () => RECT
    container.getBoundingClientRect = () => RECT

    const runtime = createFakeSceneRuntime()
    const frame = BASE_PLANE_FRAMES.xy
    const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 2000)
    cam.position.set(frame.origin.x, frame.origin.y, frame.origin.z + 100)
    cam.up.set(0, 1, 0)
    cam.lookAt(frame.origin.x, frame.origin.y, frame.origin.z)
    cam.updateMatrixWorld(true)
    runtime.camera = cam

    const dag = new FeatureDag()
    seedGenesisNodes(dag)
    const history = new CommandHistory(dag)
    const scheduler = new RegenScheduler(dag, new ElementMap())
    const sketchWithFix = fixSketch()
    dag.insertNode({
      id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
      payload: { sketch: sketchWithFix, externalRefs: [], dimensionDiagnostics: [] },
    }, dag.featureOrder().length)
    sketchSessionStore.bindDeps({
      dag, history, scheduler, wrapper: null,
      notice: () => {}, onDocumentChanged: () => {}, onHistoryStep: () => {},
    })

    const overlayRoot = makePlaneFrameGroup(frame)
    const fullHost = createWorkbenchSketcherHost({ canvas, container, runtime, overlayRoot, getFrame: () => frame })
    // The mirror: every seam member kept exactly as the real host builds it, EXCEPT
    // projectToScreen, which is dropped entirely (not set to undefined -- omitted) to match
    // CNCViewport.ts:2181-2236's shape.
    const { projectToScreen: _drop, ...host } = fullHost
    expect((host as typeof fullHost).projectToScreen, 'seam-shape guard: this host must not carry projectToScreen')
      .toBeUndefined()

    const sketcher = new Sketcher(host)
    sketcher.setDocumentPort(workbenchSketchDocumentPort)
    sketcher.setUndoSink({ beginGesture: () => { workbenchSketchDocumentPort.beginStep() } })
    sketchSessionStore.begin(SKETCH_NODE_ID, frame, sketchWithFix)
    sketcher.enter()
    M = { sketcher, host, canvas, container, dag, runtime }
    sketcher.updateSketch(sketchWithFix, { selectedIds: new Set(), glyphsVisible: true })
    sketcher.onFrame(host.worldPerPixel(), 800, 600)

    const badge = sketcher.layer.getBadges().find((b) => b.constraintId === 'fix1')
    expect(badge, 'a fix badge must render with glyphsVisible').toBeDefined()
    if (!badge) throw new Error('unreachable (asserted above)')

    // WO SKC-55-R2 (audit finding [0]): matrixWorld oracle -- reuses renderedScreenTruth (M here
    // is a real Mount: `sketcher`, `canvas`, `runtime` are all wired above exactly as `mount()`
    // wires them) instead of hand-reconstructing a world point at a hardcoded SKETCH_Z. This leg's
    // whole point is CAM parity (host has no projectToScreen), so the oracle stays independent of
    // BOTH host.projectToScreen (absent by construction) and of legacyBadgeScreenPoint (the
    // fallback under test) -- it reads the group's ACTUAL live matrixWorld instead of assuming the
    // group sits exactly at SKETCH_Z, which is what let a render-lift mismatch pass silently here
    // pre-R2 even though this pose is square-on + orthographic (where z=0 and z=SKETCH_Z happen to
    // agree, but the honest value must not depend on that coincidence).
    const anchorScreen = renderedScreenTruth(M, { x: badge.world.x, y: badge.world.y })
    expect(anchorScreen, 'badge anchor must project via the live matrixWorld').not.toBeNull()
    if (!anchorScreen) throw new Error('unreachable (asserted above)')
    const badgeScreenX = anchorScreen.x - (badge.center.x - 0.5) * BADGE_PX
    const badgeScreenY = anchorScreen.y + (badge.center.y - 0.5) * BADGE_PX

    workbenchSketchDocumentPort.setSelection([])
    click(M, badgeScreenX, badgeScreenY)
    expect(sketchSessionStore.getState().selectedIds).toEqual(['fix1'])
  })
})

// WO SKC-57: two-pass GENEROUS pick (opt-in per call site). These legs need the real
// SketchInteraction + host (unlike the pure SketchLayer.pick() tier logic covered by
// src/tests/model3d/sketchLayerGenerousPick.test.ts) because they exercise call-site routing --
// which gestures/tools opt in and which stay tight -- not the ambiguity resolution itself. The
// square-on ORTHOGRAPHIC pose (squareOnOrthographic) keeps world-per-pixel flat (0.25 both axes,
// position-independent) so a 3mm world offset is unambiguously "12 screen px, between the 8px
// tight and 16px generous radii" -- SKC-54/55's off-normal-pose coverage is a separate concern.
describe('WO SKC-57: two-pass GENEROUS pick (opt-in per call site)', () => {
  it('gesture split: a press 3mm from a lone line still starts a MARQUEE on drag (pointerdown stays TIGHT); the same press released in place SELECTS (pointerup fallback is GENEROUS)', () => {
    M = mount('xy', blankSketch(), squareOnOrthographic)
    sketchSessionStore.setState({ glyphsVisible: false })
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!
    const before = { start: { ...line.start }, end: { ...line.end } }

    // 3mm perpendicular from the line: outside the 2mm TIGHT radius, inside the 4mm GENEROUS one.
    // x=8: clear of the injected Y-axis (SKC-49, at local x=0) -- same reasoning as AC4's probeX
    // comment above.
    const pressLocal = { x: 8, y: 23 }
    const pressPx = renderedScreenTruth(M, pressLocal)
    expect(pressPx, 'press point must project').not.toBeNull()
    if (!pressPx) throw new Error('unreachable (asserted above)')

    // DRAG: pointerdown's own pick (sketchInteraction.ts:719) stays TIGHT and unchanged, so this
    // press has no hit; moving past the 5px marquee threshold starts a MARQUEE, never an entity
    // drag -- even though the press point sits inside what the (generous) pointerup fallback
    // would accept on its own. Driven explicitly here (not via the drag() helper) so a
    // .sketch-marquee element can be asserted BEFORE pointerup: an empty selection plus an
    // unchanged line afterward is ALSO what a solver-less entity drag looks like when wrapper is
    // null (workbenchSketchDocumentPort.dragMove is then a no-op) -- so those two assertions alone
    // do not prove the MARQUEE branch ran (WO SKC-57-R1 audit finding). The tiny 8px horizontal
    // drag traces a near-zero-height box at y=23, clear of the line at y=20, so releasing still
    // selects nothing and proves no accidental hit either.
    pointer('pointerdown', M.canvas, pressPx.x, pressPx.y)
    const dragSteps = 4
    for (let i = 1; i <= dragSteps; i++) {
      pointer('pointermove', M.canvas, pressPx.x + (8 * i) / dragSteps, pressPx.y)
    }
    expect(
      M.container.querySelector('.sketch-marquee'),
      'the drag must have taken the MARQUEE branch (updateMarquee appends .sketch-marquee to ' +
        'host.container) -- an entity drag never creates this element, so its presence here is ' +
        'independent proof pointerdown stayed TIGHT (missed the line) rather than routing through ' +
        "generous picking into an entity drag that a null-wrapper solver would silently no-op",
    ).not.toBeNull()
    pointer('pointerup', M.canvas, pressPx.x + 8, pressPx.y)
    M.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    expect(sketchSessionStore.getState().selectedIds, 'a marquee that does not cover the line selects nothing')
      .toEqual([])
    const afterDrag = payloadSketch(M).entities.find((e) => e.kind === 'line')!
    expect(afterDrag.start, 'the line must NOT have been dragged').toEqual(before.start)
    expect(afterDrag.end).toEqual(before.end)

    // CLICK (press, release in place, no drag) at the SAME point: the pointerup fallback
    // (sketchInteraction.ts:1214-ish) is GENEROUS, so this click-no-drag now selects the line --
    // the ACCEPTED TRADEOFF the WO calls for (clicking within the generous radius of a lone
    // entity selects it instead of deselecting).
    workbenchSketchDocumentPort.setSelection([])
    click(M, pressPx.x, pressPx.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })

  it('pick-tool hover stays TIGHT: arming smart-dimension and hovering 3mm from a lone line shows no hover halo (P11)', () => {
    M = mount('xy', blankSketch(), squareOnOrthographic)
    sketchSessionStore.setState({ glyphsVisible: false })
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })

    sketcherTools.armTool('smart-dimension')
    // x=8: clear of the injected Y-axis (SKC-49, at local x=0).
    const hoverPx = renderedScreenTruth(M, { x: 8, y: 23 })
    expect(hoverPx, 'hover point must project').not.toBeNull()
    if (!hoverPx) throw new Error('unreachable (asserted above)')
    pointer('pointermove', M.canvas, hoverPx.x, hoverPx.y)
    expect(
      M.sketcher.getHover(),
      'a pick-tool hover must not promise a pick the separate toolClick resolver cannot deliver',
    ).toBeNull()
    sketcherTools.armTool('select')
  })

  it('hover-predicts-click: select-mode hover 3mm from a lone line matches the subsequent click (both GENEROUS)', () => {
    M = mount('xy', blankSketch(), squareOnOrthographic)
    sketchSessionStore.setState({ glyphsVisible: false })
    drawLine(M, { x: -15, y: 20 }, { x: 15, y: 20 })
    const line = payloadSketch(M).entities.find((e) => e.kind === 'line')!

    // x=8: clear of the injected Y-axis (SKC-49, at local x=0).
    const px = renderedScreenTruth(M, { x: 8, y: 23 })
    expect(px, 'probe point must project').not.toBeNull()
    if (!px) throw new Error('unreachable (asserted above)')

    pointer('pointermove', M.canvas, px.x, px.y)
    expect(M.sketcher.getHover()).toBe(line.id)

    click(M, px.x, px.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([line.id])
  })
})

describe('SKC-62: shared center nodes in the real Model host', () => {
  it('renders, hovers, and click-selects a circle center top-down and oblique', () => {
    const circle = {
      id: 'center-circle',
      kind: 'circle' as const,
      construction: false,
      center: { x: 25, y: 20 },
      radius: 8,
    }
    M = mount('xy', {
      ...blankSketch(),
      entities: [circle],
    }, squareOnOrthographic)
    sketchSessionStore.setState({ glyphsVisible: false })
    M.sketcher.updateSketch(sketchSessionStore.getState().sketch, sketchSessionStore.getViewState())
    const centerId = centerSelectionIdForEntity(circle)!
    const clouds = M.sketcher.layer.group.children
      .filter((child) => child.name === '__sketch_centers__')
    expect(clouds).toHaveLength(1)

    const top = renderedScreenTruth(M, circle.center)
    expect(top).not.toBeNull()
    if (!top) throw new Error('top-down center must project')
    pointer('pointermove', M.canvas, top.x, top.y)
    expect(M.sketcher.getHover()).toBe(centerId)
    click(M, top.x, top.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([centerId])

    workbenchSketchDocumentPort.setSelection([])
    const cam = M.runtime.camera as THREE.OrthographicCamera
    cam.position.set(0, -150, 120)
    cam.up.set(0, 0, 1)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    M.sketcher.onFrame(M.host.worldPerPixel(), 800, 600)
    const oblique = renderedScreenTruth(M, circle.center)
    expect(oblique).not.toBeNull()
    if (!oblique) throw new Error('oblique center must project')
    click(M, oblique.x, oblique.y)
    expect(sketchSessionStore.getState().selectedIds).toEqual([centerId])
  })
})
