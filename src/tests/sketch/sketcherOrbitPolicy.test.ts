// @vitest-environment jsdom
// WO SKC-15B (S3) criterion 3: the camera policy, proved by a probe that can FAIL.
//
// Operator (T-SKC-PARITY finding 3): "sketch view should be normal to sketch plane view, and rotatable
// by the user if desired, but both should not happen at the same time."
//
// The package now expresses two policies (src/lib/sketch/sketcher/orbitArbiter.ts):
//   'session' (DEFAULT / undefined) -- CAM: orbit off for the whole sketch session.
//   'drag'                          -- workbench: orbit stays live, but an entity press never rotates.
//
// WHY THIS FILE MODELS OrbitControls INSTEAD OF ASSERTING `enableRotate === false`:
//
// `enableRotate` is a PROXY. Asserting it is false at some moment during a drag would pass even if
// the camera had already rotated for the first five pixels of that drag -- which is exactly what a
// suppression hung on `doc.dragBegin()` (the 5px threshold) does, because three.js OrbitControls
// latches `state = ROTATE` in its own `pointerdown` handler and only re-reads `enableRotate` on
// each subsequent `pointermove`. A gate on the proxy would pass on broken geometry
// (feedback_gates_mask_defects). So `FakeOrbitControls` below reproduces that exact latch/recheck
// shape, is registered on the canvas BEFORE the package attaches (as the real one is, from
// SceneRuntime's constructor), and the probe measures THE REAL THING: did the camera move?
//
// Non-vacuity is proved in-file: `the identical gesture rotates the camera when NO session is open`
// shows the fake controls really do move the camera through the same event sequence. If they did
// not, every zero-motion assertion here would be passing for the wrong reason.
//
// WO SKC-15C -- WHY THE NON-VACUITY ANCHOR MOVED. SKC-15B's anchor was "an empty-space press under
// 'drag' DOES rotate the camera". That anchor WAS the open finding it also reported: an empty-space
// press starts the package's marquee, so the marquee and the camera both moved at once, which Operator's
// finding 3 forbids. SKC-15C makes every LEFT press inside a session a sketch gesture (see
// orbitArbiter.ts), so that anchor is now a statement of the defect rather than of the harness's
// liveness. The replacement anchor asserts the SAME fake controls, driven by the SAME event
// sequence, on the SAME canvas -- with no sketch session open. It cannot go green by accident: if
// suppression leaked outside the session, or if the fake stopped rotating, it fails.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'

import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type {
  SketcherHost, SketchDocumentPort, SketcherOrbitPolicy,
} from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

// ---- the document under edit (same two points the lifecycle keystone uses) --------------------

const P0: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const P1: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 10, y: 0 } }

function freshSketch(): Sketch {
  return { id: 's', layerId: 'l', entities: [P0, P1], constraints: [], dimensions: [], solveStatus: null }
}

/** Client point over entity `p1` (world 10,0): world(0,0) is client(400,300); 1mm = 4px. */
const P1_CLIENT = { x: 440, y: 300 }
/** Empty space, far from both points. */
const EMPTY_CLIENT = { x: 700, y: 500 }

/**
 * A faithful-enough model of three.js OrbitControls' rotate gesture.
 *
 * The two behaviors that matter, both taken from OrbitControls' source:
 *   - `onPointerDown` -> `handleMouseDownRotate` records the rotate origin and sets `state = ROTATE`.
 *     It checks `enableRotate` ONCE, here, and rotates NOTHING yet.
 *   - `onPointerMove` -> `case STATE.ROTATE: if (scope.enableRotate === false) return;` then rotates.
 *     So the flag is re-read every move, and suppressing it at any time stops FURTHER rotation --
 *     but never un-does rotation that already happened.
 *
 * Registered on the canvas before the package attaches, matching SceneRuntime's real construction
 * order (`new OrbitControls(camera, canvas)` at runtime creation; the Sketcher attaches at enter()).
 */
class FakeOrbitControls {
  enableRotate = true
  /** Every pointermove that actually rotated. The zero-motion probe reads it AND the camera. */
  rotations = 0
  private state: 'none' | 'rotate' = 'none'
  private readonly camera: THREE.Camera

  constructor(camera: THREE.Camera, el: HTMLElement) {
    this.camera = camera
    el.addEventListener('pointerdown', (e) => {
      if ((e as MouseEvent).button !== 0) return
      // LEFT = orbit under the `liencnc-default` nav preset (src/types/index.ts).
      if (this.enableRotate === false) return
      this.state = 'rotate'
    })
    el.addEventListener('pointermove', () => {
      if (this.state !== 'rotate') return
      if (this.enableRotate === false) return
      this.rotations++
      this.camera.position.x += 1 // "the camera moved" -- the only thing the user can see
    })
    el.addEventListener('pointerup', () => { this.state = 'none' })
  }
}

interface Harness {
  sketcher: Sketcher
  canvas: HTMLElement
  controls: FakeOrbitControls
  camera: THREE.Camera
  poses: { saved: number; restored: unknown[] }
  framed: number
  dragBeginCalls: number
  dragAccepts: boolean
  sketch: Sketch
  capturePointerId: number | null
}

function makeHarness(orbitPolicy?: SketcherOrbitPolicy): Harness {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)
  document.body.appendChild(overlayHost)

  // jsdom reports zeros; the component reads a real rect for picking.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  // Same ortho camera geometry as the lifecycle keystone, so world(0,0) -> client(400,300)
  // and one world mm spans 4 client px. The entity pick below depends on it.
  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld(true)

  // Registered BEFORE the Sketcher attaches -- the real ordering.
  const controls = new FakeOrbitControls(camera, canvas)
  let capturePointerId: number | null = null
  canvas.setPointerCapture = (pointerId) => { capturePointerId = pointerId }
  canvas.hasPointerCapture = (pointerId) => capturePointerId === pointerId
  canvas.releasePointerCapture = (pointerId) => {
    if (capturePointerId === pointerId) capturePointerId = null
  }

  const poses = { saved: 0, restored: [] as unknown[] }
  const h: Partial<Harness> = {
    canvas, controls, camera, poses, framed: 0,
    dragBeginCalls: 0, dragAccepts: true, sketch: freshSketch(), capturePointerId,
  }

  const host: SketcherHost = {
    domElement: canvas,
    container,
    overlayHost,
    overlayRoot: new THREE.Group(),
    camera,
    controls,
    orbitPolicy,
    // SKC-54: SketchLayer.pick() now converges through this callback (composed package-side in
    // index.ts) instead of its own raw NDC-unprojection, so an identity stub here (`(x, y) => ({x,
    // y})`, echoing raw CLIENT pixel coords as if they were world mm) would make P1_CLIENT
    // resolve to world (440, 300) instead of world (10, 0) -- the entity pick this file's drag
    // tests depend on would silently miss. Real ortho unprojection, matching this harness's own
    // camera (position (0,0,10), the SAME math CNCViewport.ts's real host and
    // camSketchMount.test.ts's mock both use) so "world(0,0) -> client(400,300), 1mm = 4px" above
    // stays true through the reverse conversion too.
    clientToPlaneWorld: (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const v = new THREE.Vector3(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
        0,
      )
      v.unproject(camera)
      return { x: v.x, y: v.y }
    },
    worldPerPixel: () => 1,
    saveCameraPose: () => { poses.saved++; return { token: poses.saved } },
    restoreCameraPose: (pose) => { poses.restored.push(pose) },
    frameNormalToPlane: () => { h.framed = (h.framed ?? 0) + 1 },
  }

  const doc: SketchDocumentPort = {
    getSketch: () => h.sketch!,
    ensureSketch: () => h.sketch!,
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
    dragBegin: (_id, _grab, _tol, beforeMutate) => {
      h.dragBeginCalls = (h.dragBeginCalls ?? 0) + 1
      if (!h.dragAccepts) return false
      beforeMutate()
      return true
    },
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
  Object.defineProperty(h, 'capturePointerId', { get: () => capturePointerId })
  return Object.assign(h, { sketcher }) as Harness
}

/** jsdom has no PointerEvent; the component reads only MouseEvent fields. */
function pointer(
  type: string,
  target: EventTarget,
  opts: { x?: number; y?: number; button?: number; pointerId?: number } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true,
    clientX: opts.x ?? 0, clientY: opts.y ?? 0, button: opts.button ?? 0,
  })
  Object.defineProperty(event, 'pointerId', { value: opts.pointerId ?? 1 })
  target.dispatchEvent(event)
}

/** Press, move well past the 5px drag threshold in several steps, release. */
function dragGesture(H: Harness, from: { x: number; y: number }): void {
  H.sketcher.updateSketch(H.sketch)
  pointer('pointerdown', H.canvas, from)
  for (const dx of [2, 4, 8, 20, 40]) pointer('pointermove', H.canvas, { x: from.x + dx, y: from.y })
  pointer('pointerup', H.canvas, { x: from.x + 40, y: from.y })
}

let H: Harness

beforeEach(() => {
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
})
afterEach(() => {
  H?.sketcher.dispose()
  document.body.innerHTML = ''
})

// ---- The 'drag' policy: the workbench --------------------------------------------------------

describe("orbitPolicy 'drag' (the workbench): an entity drag produces ZERO camera motion", () => {
  it('NON-VACUITY: the identical empty-space gesture DOES rotate the camera when no session is open', () => {
    H = makeHarness('drag')
    // No enter(): the package has attached nothing, so only the fake OrbitControls sees the events.
    const x0 = H.camera.position.x

    dragGesture(H, EMPTY_CLIENT)

    // If this fails, the fake controls never rotate and every zero-motion assertion below is passing
    // for the wrong reason. It also proves suppression does not leak outside the sketch session.
    expect(H.controls.rotations).toBeGreaterThan(0)
    expect(H.camera.position.x).not.toBe(x0)
  })

  it('an EMPTY-SPACE press inside the session ALSO suppresses orbit -- the marquee and the camera never move together', () => {
    // WO SKC-15C, closing SKC-15B's `cameraPolicyStatement.openFinding`. Operator's bar: never both at
    // once. An empty-space left press becomes a MARQUEE after 5px; under the `liencnc-default` nav
    // preset the same press was ALSO an orbit. This is the assertion that the marquee now owns it.
    //
    // FAILS-IF `SketchInteraction.handlePointerDown` goes back to suppressing only on
    // `hit?.type === 'entity'` (SKC-15B's shape): the camera rotates through the whole marquee drag.
    H = makeHarness('drag')
    H.sketcher.enter()
    const x0 = H.camera.position.x

    dragGesture(H, EMPTY_CLIENT)

    expect(H.dragBeginCalls).toBe(0)     // nothing was picked; this really was empty space
    expect(H.controls.rotations).toBe(0) // ...and the camera never rotated
    expect(H.camera.position.x).toBe(x0)
    expect(H.controls.enableRotate).toBe(true) // restored on pointer-up
  })

  it('SKC-25 A5: an off-canvas release restores orbit in the same session', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    H.sketcher.updateSketch(H.sketch)
    const pointerId = 51

    pointer('pointerdown', H.canvas, { ...P1_CLIENT, pointerId })
    pointer('pointermove', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y, pointerId })
    const releaseTarget = H.capturePointerId === pointerId ? H.canvas : window
    pointer('pointerup', releaseTarget, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y, pointerId })

    expect(H.dragBeginCalls).toBe(1)
    expect(H.controls.rotations).toBe(0)
    expect(H.controls.enableRotate).toBe(true)
  })

  it('a press with a DRAW TOOL armed never rotates either (drawing a line does not spin the model)', () => {
    // Armed-tool presses never marquee, but they are still left presses on empty space, and they are
    // the ones the user makes most. FAILS-IF suppression is scoped to the marquee rather than to the
    // press.
    H = makeHarness('drag')
    H.sketcher.enter()
    sketcherTools.armTool('line')
    const x0 = H.camera.position.x

    dragGesture(H, EMPTY_CLIENT)

    expect(H.controls.rotations).toBe(0)
    expect(H.camera.position.x).toBe(x0)
    expect(H.controls.enableRotate).toBe(true)
  })

  it('NON-VACUITY: the entity under P1_CLIENT is really pickable (dragBegin runs)', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    dragGesture(H, P1_CLIENT)
    expect(H.dragBeginCalls).toBe(1)
  })

  it('an entity drag moves the camera ZERO mm and rotates ZERO times (the c5 assertion)', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    const x0 = H.camera.position.x

    dragGesture(H, P1_CLIENT)

    // FAILS-IF suppression is hung on dragBegin (the 5px threshold) instead of the pointerdown:
    // the 2px and 4px moves would each rotate before the threshold trips.
    expect(H.controls.rotations).toBe(0)
    expect(H.camera.position.x).toBe(x0)
  })

  it('entry does NOT suppress orbit: the user may deliberately rotate between drags', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    // FAILS-IF 'drag' accidentally inherits the session-wide suppression.
    expect(H.controls.enableRotate).toBe(true)
  })

  it('the press restores orbit on pointer-up: `enableRotate` is live again BETWEEN gestures', () => {
    // WO SKC-15C: this is what `orbitPolicy: 'drag'` still buys over `'session'`, and the assertion
    // had to change with the rule. It can no longer be "a fresh empty-space LEFT drag rotates again"
    // -- inside a session no left press ever rotates now, by design. What survives, and what Operator
    // actually asked for ("rotatable by the user if desired"), is that the flag is TRUE at rest: any
    // button the user's nav preset maps to ROTATE (RIGHT under `onshape`, MIDDLE under
    // `orbit-middle`/`solidworks`) orbits freely mid-sketch. Under `'session'` it would be false the
    // whole time, on every button -- which the `'session'` block below asserts.
    //
    // FAILS-IF the arbiter stops restoring on pointer-up: the session would silently degrade into
    // `'session'` policy after the user's first click.
    H = makeHarness('drag')
    H.sketcher.enter()
    dragGesture(H, P1_CLIENT)
    expect(H.controls.enableRotate).toBe(true)
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(false)

    dragGesture(H, EMPTY_CLIENT)
    expect(H.controls.enableRotate).toBe(true)
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(false)

    // And once the session ENDS, a left drag drives the camera exactly as it did before entry.
    H.sketcher.exit()
    const x0 = H.camera.position.x
    dragGesture(H, EMPTY_CLIENT)
    expect(H.camera.position.x).not.toBe(x0)
  })

  it('a REFUSED drag still holds orbit suppressed for the press, and restores on pointer-up', () => {
    H = makeHarness('drag')
    H.dragAccepts = false
    H.sketcher.enter()
    const x0 = H.camera.position.x

    dragGesture(H, P1_CLIENT)

    // The package re-offers a refused drag on every subsequent move past the threshold (it never
    // latches `dragActive`), so this is >= 1, not == 1. What matters is that it WAS offered.
    expect(H.dragBeginCalls).toBeGreaterThanOrEqual(1)
    expect(H.controls.rotations).toBe(0)   // ...and refusing it did not hand the gesture to orbit
    expect(H.camera.position.x).toBe(x0)
    expect(H.controls.enableRotate).toBe(true) // restored
  })

  it('suppression is idempotent both ways (a second press never clobbers the saved value)', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    H.sketcher.updateSketch(H.sketch)

    pointer('pointerdown', H.canvas, P1_CLIENT)
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(true)
    // A second press with no intervening up: the saved `true` must survive, not become `false`.
    pointer('pointerdown', H.canvas, P1_CLIENT)
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(true)

    pointer('pointerup', H.canvas, P1_CLIENT)
    expect(H.controls.enableRotate).toBe(true)
    // A second release with nothing suppressed is a no-op, not a write of a stale value.
    pointer('pointerup', H.canvas, P1_CLIENT)
    expect(H.controls.enableRotate).toBe(true)
  })

  it('CLEANUP TAIL: exiting mid-drag never strands orbit switched off', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    H.sketcher.updateSketch(H.sketch)

    pointer('pointerdown', H.canvas, P1_CLIENT)
    pointer('pointermove', H.canvas, { x: P1_CLIENT.x + 20, y: P1_CLIENT.y })
    expect(H.controls.enableRotate).toBe(false) // suppressed, drag live

    H.sketcher.exit() // exit() -> exitSession() then interaction.detach() -> endEntityPress()

    // FAILS-IF exitSession and detach fight over the flag (ordering bug), or if either forgets.
    expect(H.controls.enableRotate).toBe(true)
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(false)
  })

  it('normal-to-plane framing on entry and pose restore on finish still happen under drag policy', () => {
    H = makeHarness('drag')
    H.sketcher.enter()
    expect(H.framed).toBe(1)
    expect(H.poses.saved).toBe(1)
    H.sketcher.exit()
    expect(H.poses.restored).toEqual([{ token: 1 }])
  })
})

// ---- The DEFAULT policy: CAM. The identity argument, asserted rather than argued. --------------

describe("orbitPolicy DEFAULT (undefined === 'session'): CAM's behavior is byte-for-byte unchanged", () => {
  it('enter suppresses orbit for the whole session (CAM: left-drag is a marquee)', () => {
    H = makeHarness() // no orbitPolicy -- exactly how CNCViewport constructs its host
    H.sketcher.enter()
    expect(H.controls.enableRotate).toBe(false)
  })

  it('an entity press performs ZERO additional writes -- the drag helpers early-return', () => {
    H = makeHarness()
    H.sketcher.enter()
    expect(H.controls.enableRotate).toBe(false)

    dragGesture(H, P1_CLIENT)

    expect(H.dragBeginCalls).toBe(1)                      // the drag really ran
    expect(H.sketcher.isDragOrbitSuppressed()).toBe(false) // ...and the drag arbiter never engaged
    expect(H.controls.enableRotate).toBe(false)            // still the session suppression, untouched
  })

  it('exit restores the PRE-ENTER flag, whatever it was (the whole of what CAM depends on)', () => {
    H = makeHarness()
    H.controls.enableRotate = true
    H.sketcher.enter()
    H.sketcher.exit()
    expect(H.controls.enableRotate).toBe(true)

    H.sketcher.dispose()
    H = makeHarness()
    H.controls.enableRotate = false
    H.sketcher.enter()
    H.sketcher.exit()
    expect(H.controls.enableRotate).toBe(false)
  })

  it('under the default policy the camera cannot rotate at all inside a session', () => {
    H = makeHarness()
    H.sketcher.enter()
    const x0 = H.camera.position.x
    dragGesture(H, EMPTY_CLIENT) // the gesture that DOES rotate under 'drag'
    expect(H.controls.rotations).toBe(0)
    expect(H.camera.position.x).toBe(x0)
  })
})
