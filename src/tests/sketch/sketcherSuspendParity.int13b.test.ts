// @vitest-environment jsdom
// WO INT-13B-R1 acceptance B5: sketcher parity across BOTH mounts, plus the
// preflight amendment's dual-entered-session orbit-arbiter cell (spec 6.2 point 3,
// "INT-13B proves it").
//
// WHY THIS FILE EXISTS AT ALL. INT-13B added suspend()/resume() to the SHARED
// Sketcher package (src/lib/sketch/sketcher/index.ts:283/:296) -- the one package
// both hosts mount (docs/UI-ARCHITECTURE.md:279,351-353). Under
// feedback_sketcher_parity_part_cam a shared-surface change must be gated against
// BOTH mounts, not one. The two mounts differ by exactly one host field:
//   CAM       (CNCViewport.ts:2181-2191) omits orbitPolicy  -> resolves 'session'
//   workbench (workbenchSketcherHost.ts:106) sets 'drag'
// (orbitArbiter.ts:128: `return this.host.orbitPolicy ?? 'session'`). So this file
// builds the package against BOTH host shapes and asserts the suspend/resume
// contract is IDENTICAL across them -- and, where they legitimately differ, that the
// difference is the policy each mount ASKED for and nothing else.
//
// WHY IT MODELS OrbitControls RATHER THAN ASSERTING `enableRotate`. Inherited
// verbatim from sketcherOrbitPolicy.test.ts:11-24 (whose harness this copies):
// `enableRotate` is a PROXY -- three.js OrbitControls latches `state = ROTATE` in
// its own pointerdown and only re-reads the flag on subsequent moves, so a
// suppression applied late passes a flag assertion while the camera has already
// moved (feedback_gates_mask_defects). FakeOrbitControls reproduces that exact
// latch/recheck shape and the probes measure THE REAL THING: did the camera move?
// Non-vacuity is proved in-file by `the identical gesture rotates BOTH cameras when
// no session is open`.
//
// THE BASE WORKER'S RECON-1 SAID THIS IS EXPECTED TO PASS (orbitArbiter.ts holds
// ZERO module-level mutable state; every field is per-instance and policy() reads
// the per-instance host). It is built anyway: "expected to be fine" is exactly what
// charter rule 4 refuses, and the ONE coupling risk RECON-1 names -- two arbiters
// sharing one `controls` object, where the second enterSession() would capture the
// first's already-written `false` -- is a real, constructible failure that only a
// dual-entered test can see. It is constructed below as `dualSharedControls`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'

import {
  Sketcher,
  sketcherDocument,
  sketcherTools,
  sketcherToolStore,
} from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import type { SketcherHost, SketchDocumentPort, SketcherOrbitPolicy } from '../../lib/sketch/sketcher/ports'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'

// ---- the document under edit (same two points the lifecycle keystone uses) -------

const P0: SketchEntity = { id: 'p0', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const P1: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 10, y: 0 } }

function freshSketch(): Sketch {
  return { id: 's', layerId: 'l', entities: [P0, P1], constraints: [], dimensions: [], solveStatus: null }
}

/** Client point over entity `p1` (world 10,0): world(0,0) is client(400,300); 1mm = 4px. */
const P1_CLIENT = { x: 440, y: 300 }

/** A faithful-enough model of three.js OrbitControls' rotate gesture -- see the file
 *  header. Copied from sketcherOrbitPolicy.test.ts:71-94. */
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
      if (this.enableRotate === false) return
      this.state = 'rotate'
    })
    el.addEventListener('pointermove', () => {
      if (this.state !== 'rotate') return
      if (this.enableRotate === false) return
      this.rotations++
      this.camera.position.x += 1 // "the camera moved" -- the only thing the user can see
    })
    el.addEventListener('pointerup', () => {
      this.state = 'none'
    })
  }
}

interface Mount {
  label: string
  sketcher: Sketcher
  canvas: HTMLElement
  controls: FakeOrbitControls
  camera: THREE.Camera
  sketch: Sketch
  doc: SketchDocumentPort
}

/** Build the package against ONE mount's host shape.
 *
 *  `orbitPolicy: undefined` IS the CAM mount: CNCViewport's host literal never
 *  mentions the field, so the omission -- not a written value -- is what resolves
 *  'session'. Passing undefined here reproduces that identically.
 *
 *  `sharedControls` exists ONLY for the dualSharedControls probe: it is the
 *  hypothetical RECON-1 rules out (two arbiters over ONE controls object), and the
 *  probe below proves the real hosts do not do this. */
function makeMount(label: string, orbitPolicy: SketcherOrbitPolicy | undefined, sharedControls?: FakeOrbitControls): Mount {
  const overlayHost = document.createElement('div')
  const canvas = document.createElement('canvas')
  const container = document.createElement('div')
  container.appendChild(canvas)
  overlayHost.appendChild(container)
  document.body.appendChild(overlayHost)

  // jsdom reports zeros; the package reads a real rect for picking.
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect

  const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
  camera.position.set(0, 0, 10)
  camera.updateMatrixWorld(true)

  // Registered BEFORE the Sketcher attaches -- the real ordering.
  const controls = sharedControls ?? new FakeOrbitControls(camera, canvas)
  let capturePointerId: number | null = null
  canvas.setPointerCapture = (pointerId) => {
    capturePointerId = pointerId
  }
  canvas.hasPointerCapture = (pointerId) => capturePointerId === pointerId
  canvas.releasePointerCapture = (pointerId) => {
    if (capturePointerId === pointerId) capturePointerId = null
  }

  const sketch = freshSketch()
  const host: SketcherHost = {
    domElement: canvas,
    container,
    overlayHost,
    overlayRoot: new THREE.Group(),
    camera,
    controls,
    orbitPolicy,
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
    saveCameraPose: () => ({ token: label }),
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
    append: vi.fn(),
    replace: () => {},
    toggleSelectionConstruction: () => false,
    deleteSelection: () => {},
    dragBegin: (_id, _grab, _tol, beforeMutate) => {
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
  return { label, sketcher, canvas, controls, camera, sketch, doc }
}

/** THE two real mounts, by the one field that distinguishes them. */
const CAM = () => makeMount('cam', undefined) // CNCViewport omits orbitPolicy -> 'session'
const PART = () => makeMount('part', 'drag') // workbenchSketcherHost.ts:106

function pointer(target: EventTarget, type: string, opts: { x?: number; y?: number } = {}): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x ?? 0,
    clientY: opts.y ?? 0,
    button: 0,
  })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  target.dispatchEvent(event)
}

function leftClick(m: Mount, at: { x: number; y: number }): void {
  pointer(m.canvas, 'pointerdown', at)
  pointer(m.canvas, 'pointerup', at)
}

/** Press, move well past the 5px drag threshold in several steps, release. */
function leftDrag(m: Mount, from: { x: number; y: number }): void {
  m.sketcher.updateSketch(m.sketch)
  pointer(m.canvas, 'pointerdown', from)
  for (const dx of [2, 4, 8, 20, 40]) pointer(m.canvas, 'pointermove', { x: from.x + dx, y: from.y })
  pointer(m.canvas, 'pointerup', { x: from.x + 40, y: from.y })
}

const mounts: Mount[] = []
function track(m: Mount): Mount {
  mounts.push(m)
  return m
}

beforeEach(() => {
  // Both stores are MODULE SINGLETONS shared by every mount -- the very fact this
  // file is about. Reset or they leak across tests and files.
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
})
afterEach(() => {
  for (const m of mounts) m.sketcher.dispose()
  mounts.length = 0
  document.body.innerHTML = ''
})

// =================================================================================
// B5 part 1 -- PARITY. The shared suspend/resume surface, gated on BOTH mounts.
// =================================================================================

describe('WO INT-13B (B5): the shared Sketcher.suspend()/resume() contract behaves IDENTICALLY on both mounts', () => {
  /** The observable suspend/resume contract, recorded as a trace. Running the SAME
   *  script against both host shapes and comparing the traces is what makes this a
   *  parity gate rather than two unrelated tests that happen to sit in one file. */
  function traceSuspendContract(m: Mount): Record<string, unknown> {
    const repaint = vi.spyOn(m.sketcher, 'refreshToolOverlay')
    const t: Record<string, unknown> = {}

    t.subscribedBeforeEnter = m.sketcher.isToolOverlaySubscribed()

    // suspend() before any session is a no-op (it must never throw on a mount whose
    // host suspends before the user ever sketched -- which is EVERY cold start).
    m.sketcher.suspend()
    t.subscribedAfterSuspendWithNoSession = m.sketcher.isToolOverlaySubscribed()

    m.sketcher.enter()
    t.subscribedAfterEnter = m.sketcher.isToolOverlaySubscribed()

    sketcherTools.setFilletRadius(3)
    t.repaintsWhileLive = repaint.mock.calls.length

    m.sketcher.suspend()
    t.subscribedAfterSuspend = m.sketcher.isToolOverlaySubscribed()
    m.sketcher.suspend() // idempotent
    t.subscribedAfterDoubleSuspend = m.sketcher.isToolOverlaySubscribed()

    const atSuspend = repaint.mock.calls.length
    sketcherTools.setFilletRadius(4)
    sketcherTools.setFilletRadius(5)
    t.repaintsAcrossSuspendedInterval = repaint.mock.calls.length - atSuspend

    m.sketcher.resume()
    t.subscribedAfterResume = m.sketcher.isToolOverlaySubscribed()
    m.sketcher.resume() // idempotent
    t.subscribedAfterDoubleResume = m.sketcher.isToolOverlaySubscribed()

    const atResume = repaint.mock.calls.length
    sketcherTools.setFilletRadius(6)
    t.repaintsAfterResume = repaint.mock.calls.length - atResume

    // A suspended session is still ENTERED: exit() must still tear it down.
    m.sketcher.exit()
    t.subscribedAfterExit = m.sketcher.isToolOverlaySubscribed()

    repaint.mockRestore()
    return t
  }

  it('records the same contract trace for the CAM mount and the Part mount', () => {
    const camTrace = traceSuspendContract(track(CAM()))
    sketcherToolStore.__reset()
    const partTrace = traceSuspendContract(track(PART()))

    // The contract, spelled out once so a failure names the defect rather than just
    // "traces differ". These are the values BOTH mounts must produce.
    const expected = {
      subscribedBeforeEnter: false,
      subscribedAfterSuspendWithNoSession: false,
      subscribedAfterEnter: true,
      repaintsWhileLive: 1,
      subscribedAfterSuspend: false,
      subscribedAfterDoubleSuspend: false,
      // 6.2(1): the suspended mount observes NOTHING, however much the shared
      // singleton store churns.
      repaintsAcrossSuspendedInterval: 0,
      subscribedAfterResume: true,
      subscribedAfterDoubleResume: true,
      // Non-vacuity: the same class of change repaints again once resubscribed, so
      // the zero above is the unsubscription and not a dead/filtered subscription.
      repaintsAfterResume: 1,
      subscribedAfterExit: false,
    }
    expect(camTrace).toEqual(expected)
    expect(partTrace).toEqual(expected)
    // PARITY, asserted as one fact: same package, two mounts, identical behavior.
    expect(partTrace).toEqual(camTrace)
  })

  it('leaves each mount orbit-arbiter state untouched across suspend/resume (suspend is subscription-only)', () => {
    // Scope claim from sketcher/index.ts:271-276, gated rather than trusted: suspend
    // touches NO camera, NO selection, NO interaction detach, NO arbiter state. If a
    // future edit "helpfully" restored the orbit flag on suspend, the resumed
    // workspace would silently change what left-drag means -- this catches it.
    for (const make of [CAM, PART]) {
      const m = track(make())
      m.sketcher.enter()
      const enteredFlag = m.controls.enableRotate

      m.sketcher.suspend()
      expect(m.controls.enableRotate).toBe(enteredFlag)
      m.sketcher.resume()
      expect(m.controls.enableRotate).toBe(enteredFlag)
    }
  })

  it('resolves the policy each mount ASKED for: CAM suppresses orbit for the session, Part leaves it live', () => {
    // The one LEGITIMATE difference between the mounts, pinned so parity above cannot
    // be satisfied by both mounts being wrong in the same way.
    const cam = track(CAM())
    const part = track(PART())
    expect(cam.controls.enableRotate).toBe(true)
    expect(part.controls.enableRotate).toBe(true)

    cam.sketcher.enter()
    part.sketcher.enter()

    expect(cam.controls.enableRotate).toBe(false) // 'session' (orbitArbiter.ts:137)
    expect(part.controls.enableRotate).toBe(true) // 'drag'
  })
})

// =================================================================================
// B5 part 2 -- THE AMENDMENT'S CELL. Two sessions ENTERED SIMULTANEOUSLY.
// =================================================================================

describe('WO INT-13B (B5, preflight amendment / spec 6.2 point 3): two sessions ENTERED at once keep independent orbit arbiters', () => {
  it('the identical gesture rotates BOTH cameras when no session is open (non-vacuity anchor)', () => {
    // Without this, every zero-motion assertion below could be green because the fake
    // controls never rotate anything.
    const cam = track(CAM())
    const part = track(PART())

    leftDrag(cam, P1_CLIENT)
    leftDrag(part, P1_CLIENT)

    expect(cam.controls.rotations).toBeGreaterThan(0)
    expect(part.controls.rotations).toBeGreaterThan(0)
    expect(cam.camera.position.x).toBeGreaterThan(0)
    expect(part.camera.position.x).toBeGreaterThan(0)
  })

  it('each workspace resolves left-drag against ITS OWN session, independent of the other', () => {
    const cam = track(CAM())
    const part = track(PART())

    // BOTH ENTERED AT ONCE -- the precondition spec 6.2(3) names, and the one D1
    // co-mounting made reachable for the first time. Deliberately CAM first, then
    // Part: RECON-1's coupling hypothesis is that the SECOND enterSession() captures
    // whatever the FIRST already wrote, so the order is load-bearing.
    cam.sketcher.enter()
    part.sketcher.enter()

    // Entering Part did NOT disturb CAM's arbiter, and vice versa.
    expect(cam.controls.enableRotate).toBe(false)
    expect(part.controls.enableRotate).toBe(true)

    // BEHAVIOR, not the proxy flag: a left-drag in CAM's sketch moves CAM's camera
    // zero -- the gesture belongs to the sketch (marquee/entity drag), never orbit.
    const partXBefore = part.camera.position.x
    leftDrag(cam, P1_CLIENT)
    expect(cam.controls.rotations).toBe(0)
    expect(cam.camera.position.x).toBe(0)
    // ...and it did not reach across into the other live session's camera either.
    expect(part.camera.position.x).toBe(partXBefore)

    // The same gesture in Part's sketch is likewise owned by the sketch (SKC-15C:
    // every left press inside a session is a sketch gesture) -- but Part's arbiter
    // suppressed it PER-PRESS and handed the flag straight back, which is the whole
    // 'drag' policy: orbit live BETWEEN drags, never DURING one.
    const camXBefore = cam.camera.position.x
    leftDrag(part, P1_CLIENT)
    expect(part.controls.rotations).toBe(0)
    expect(part.camera.position.x).toBe(0)
    expect(part.controls.enableRotate).toBe(true) // restored after the press
    expect(part.sketcher.isDragOrbitSuppressed()).toBe(false)
    // CAM's own session, meanwhile, is exactly where it was.
    expect(cam.camera.position.x).toBe(camXBefore)
    expect(cam.controls.enableRotate).toBe(false)

    // Exiting ONE session restores ITS OWN pre-entry flag and leaves the other's
    // session entirely intact -- the co-residency claim, at teardown.
    cam.sketcher.exit()
    expect(cam.controls.enableRotate).toBe(true) // CAM's pre-entry value
    expect(part.controls.enableRotate).toBe(true) // Part still entered, untouched
    expect(part.sketcher.isToolOverlaySubscribed()).toBe(true)
  })

  it('suspending ONE entered session leaves the other live session fully observing (the co-residency payoff)', () => {
    // This is RECON-2's real hazard and the reason suspend() exists: sketcherToolStore
    // is a MODULE SINGLETON (toolStore.ts:148) and EVERY entered Sketcher subscribes
    // to that ONE store (index.ts:218-227). With two sessions co-resident, the
    // suspended workspace must go silent while the live one keeps working.
    const cam = track(CAM())
    const part = track(PART())
    cam.sketcher.enter()
    part.sketcher.enter()

    const camRepaint = vi.spyOn(cam.sketcher, 'refreshToolOverlay')
    const partRepaint = vi.spyOn(part.sketcher, 'refreshToolOverlay')

    // Both live: one shared-store change repaints BOTH overlays. This is the
    // cross-talk the spec calls a correctness hazard -- asserted here as the real,
    // current behavior rather than described.
    sketcherTools.setFilletRadius(3)
    expect(camRepaint).toHaveBeenCalledTimes(1)
    expect(partRepaint).toHaveBeenCalledTimes(1)

    // Suspend CAM only (the App switching to Part suspends the CAM host).
    cam.sketcher.suspend()
    sketcherTools.setFilletRadius(4)
    expect(camRepaint).toHaveBeenCalledTimes(1) // silent
    expect(partRepaint).toHaveBeenCalledTimes(2) // still working

    // Both arbiters still hold their own meaning while one is suspended.
    expect(cam.controls.enableRotate).toBe(false)
    expect(part.controls.enableRotate).toBe(true)

    // Resume CAM: it re-observes, and Part is unaffected throughout.
    cam.sketcher.resume()
    sketcherTools.setFilletRadius(5)
    expect(camRepaint).toHaveBeenCalledTimes(2)
    expect(partRepaint).toHaveBeenCalledTimes(3)

    camRepaint.mockRestore()
    partRepaint.mockRestore()
  })

  it('the visible mount reclaims shared tool commits on enter and resume', () => {
    const cam = track(CAM())
    const part = track(PART())

    // Part was constructed last, exactly as the retained Model mount can overwrite the singleton
    // binding before the operator creates a new CAM sketch.
    expect(sketcherDocument()).toBe(part.doc)
    cam.sketcher.enter()
    expect(sketcherDocument()).toBe(cam.doc)

    // Model owns the controller while visible. Returning to the retained CAM session must reclaim
    // it; otherwise Line appears armed but both canvas clicks commit into the hidden Model sketch.
    cam.sketcher.suspend()
    part.sketcher.enter()
    expect(sketcherDocument()).toBe(part.doc)
    part.sketcher.suspend()
    cam.sketcher.resume()
    expect(sketcherDocument()).toBe(cam.doc)

    sketcherTools.armTool('line')
    leftClick(cam, { x: 480, y: 340 })
    leftClick(cam, { x: 520, y: 340 })

    expect(cam.doc.append).toHaveBeenCalledTimes(1)
    expect(part.doc.append).not.toHaveBeenCalled()
  })

  it('dualSharedControls: the ONE coupling that WOULD break independence, constructed and named', () => {
    // RECON-1 identifies exactly one way the arbiters could couple: "two arbiters
    // sharing one `controls` would make the second enterSession() capture the first's
    // already-written false." That is a property of the HOSTS, not of the arbiter, so
    // no assertion on the real mounts can prove it absent. Build it explicitly.
    const shared = new FakeOrbitControls(new THREE.PerspectiveCamera(), document.createElement('div'))
    const a = track(makeMount('shared-a', undefined, shared)) // 'session': writes false on enter
    const b = track(makeMount('shared-b', 'drag', shared)) // 'drag': captures, writes nothing

    a.sketcher.enter()
    expect(shared.enableRotate).toBe(false) // a's session suppressed it
    b.sketcher.enter() // b now captures a's false as ITS pre-entry value

    // b exits first and restores what it captured -- a's suppression, not the true
    // pre-entry `true`. The flag is now wrong for a session that is still open.
    b.sketcher.exit()
    expect(shared.enableRotate).toBe(false)
    a.sketcher.exit()
    // a restores ITS capture (the real pre-entry true), so the damage is transient
    // here -- but the middle state above is precisely the leak.
    expect(shared.enableRotate).toBe(true)

    // WHAT THIS TEST DOES AND DOES NOT PROVE -- stated plainly, because the
    // difference is the whole reason the criterion is worth gating.
    //
    // PROVED here: the coupling RECON-1 names is REAL. Given one shared `controls`,
    // two arbiters genuinely corrupt each other's saved flag. So "the arbiters are
    // independent" is a claim about the HOSTS, not a self-evident property of the
    // arbiter class.
    //
    // NOT proved here, and deliberately not faked: that the two REAL hosts own
    // separate controls. That is a source fact, not a fake-host fact -- CAM passes
    // its own OrbitControls (CNCViewport.ts:468 constructs it, :2191 passes it) and
    // the workbench passes runtime.sketchOrbitHandle() (workbenchSketcherHost.ts:101
    // -> sceneRuntime.ts:2063), a proxy onto a DIFFERENT OrbitControls owned by the
    // workbench's own SceneRuntime. Asserting `camFake.controls !== partFake.controls`
    // would only prove this harness built two objects, which is a fact about the
    // test, not the product -- a gate on a proxy for the claim rather than the claim
    // (feedback_gates_mask_defects). The real-host separation is covered where it is
    // actually observable: the real-GPU capture drives both hosts' cameras
    // independently in one page (B0/B2b, capture-report.json).
  })
})
