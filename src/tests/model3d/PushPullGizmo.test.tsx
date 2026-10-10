// @vitest-environment jsdom
//
// WO UI-5 acceptance #1 (ORIGINAL) + WO UI-57 Design 1 (REWRITE, Operator verdict
// T-UI5-PUSHPULL-RESIZE step 2 FAIL): the push/pull gizmo is no longer a
// thin wrapper over three.js TransformControls -- it is a purpose-built
// SYMMETRIC single-axis handle with its OWN pointer lifecycle (raycast on
// pointerdown, closest-point-on-line projection on pointermove), because
// TransformControls cannot draw a bidirectional shaft via its public API.
// This file therefore no longer drives the shared fakeTransformControlsAdapter
// seam (TranslateGizmo.tsx/TranslateGizmo.test.tsx are the ONLY remaining
// consumers of that seam -- see TranslateGizmo.test.tsx, proven untouched and
// green by this WO). Instead:
//   - the render/attach/detach/cleanup tests below drive the component with
//     NO test driver at all, exercising its REAL geometry-building code path
//     (jsdom supports plain THREE.Object3D graph construction fine -- only
//     WebGL rendering and PointerEvent capture are unavailable, neither of
//     which the render-smoke assertions below touch);
//   - the drag-math tests drive REAL synthetic PointerEvents against a
//     REAL raycaster hit-testing a REAL picker mesh (jsdom's
//     getBoundingClientRect defaults to an all-zero rect, so it is mocked to
//     a plausible 800x600 canvas rect -- the same NDC-from-clientXY formula
//     SolidsWorkbenchPage.tsx's own real pick handlers use); this is a
//     STRONGER proof than the old fake-adapter unit test gave (it exercises
//     the actual line-line projection math, not a driver that bypassed it);
//   - the createTestDriver-based tests prove the jsdom-safe TEST-ONLY seam
//     PushPullGizmoTestDriver itself (SolidsWorkbenchPage.pushPull.test.tsx's
//     large gesture-sequencing suite drives push/pull state-machine tests
//     through THIS seam, not through real pointer events).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useEffect, useState } from 'react'
import * as THREE from 'three'
import { PushPullGizmo, type PushPullGizmoTestDriver, type PushPullGizmoProps } from '../../components/model3d/gizmos'
import { asNumber, refreshViewportColors } from '../../theme/viewportColors'

afterEach(cleanup)

function harness() {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1000)
  camera.position.set(0, 0, 100)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const domElement = document.createElement('div')
  domElement.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  })
  document.body.appendChild(domElement)
  const face = { origin: { x: 10, y: 5, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
  return { scene, camera, domElement, face }
}

/** Same harness, but with the camera parked SIDE-ON to the handle axis at a
 *  caller-chosen distance: the face normal (+Z) is perpendicular to the view,
 *  so the handle is seen at its full length with both cone tips at equal
 *  depth. That makes on-screen SIZE directly measurable (the WO UI-57 audit F2
 *  screen-space-scale tests) and makes the picker an easy, unforeshortened
 *  ray target for the hover/cursor tests -- `harness()` above stares straight
 *  down the axis, which is fine for its own drag-math assertions but degenerate
 *  for measuring length. */
function sideHarness(distance: number) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 2000)
  camera.position.set(10 + distance, 5, 0) // face origin is (10, 5, 0)
  camera.lookAt(10, 5, 0)
  camera.updateMatrixWorld(true)
  const domElement = document.createElement('div')
  domElement.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  })
  document.body.appendChild(domElement)
  const face = { origin: { x: 10, y: 5, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
  return { scene, camera, domElement, face }
}

/** Screen-space (clientX/clientY) point that projects (via the SAME camera)
 *  onto a given world point -- used to dispatch a synthetic PointerEvent at
 *  the exact pixel that will raycast through that world point. Standard
 *  three.js world->NDC->screen projection, independent of the component's
 *  own internal raycasting (so this is a real, not circular, proof). */
function screenPointFor(camera: THREE.Camera, world: THREE.Vector3): { x: number; y: number } {
  const ndc = world.clone().project(camera)
  return { x: ((ndc.x + 1) / 2) * 800, y: ((1 - ndc.y) / 2) * 600 }
}

function firePointer(el: HTMLElement, type: string, x: number, y: number, pointerId = 1): void {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId, button: 0, bubbles: true, cancelable: true }))
}

/** jsdom implements no Pointer Capture API at all (the component try/catches
 *  both calls, so production code paths survive without this) -- but the
 *  lostpointercapture test below needs to prove the component RELEASES the
 *  capture it took, which is unobservable unless the two calls exist to spy
 *  on. Returns the recorded capture/release pointerIds. */
function stubPointerCapture(el: HTMLElement): { captured: number[]; released: number[] } {
  const captured: number[] = []
  const released: number[] = []
  ;(el as unknown as { setPointerCapture(id: number): void }).setPointerCapture = (id: number) => { captured.push(id) }
  ;(el as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = (id: number) => { released.push(id) }
  return { captured, released }
}

describe('PushPullGizmo (WO UI-57 Design 1: symmetric single-axis handle)', () => {
  it('renders without crashing and adds a hidden group to the scene when face is null', () => {
    const { scene, camera, domElement } = harness()
    expect(() => render(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={null} />)).not.toThrow()
    const group = scene.children.find((c) => c instanceof THREE.Group)
    expect(group).toBeDefined()
    expect(group!.visible).toBe(false)
  })

  it('attaches (visible, positioned + oriented) at the face origin/normal when a face is provided', () => {
    const { scene, camera, domElement, face } = harness()
    render(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} />)
    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
    expect(group.visible).toBe(true)
    expect(group.position.x).toBeCloseTo(10)
    expect(group.position.y).toBeCloseTo(5)
    expect(group.position.z).toBeCloseTo(0)
    // local +Z (the handle's own axis) rotated onto the face normal (0,0,1) -- identity here.
    const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(group.quaternion)
    expect(localZ.x).toBeCloseTo(0)
    expect(localZ.y).toBeCloseTo(0)
    expect(localZ.z).toBeCloseTo(1)
  })

  it('detaches (hidden) when face transitions back to null', () => {
    const { scene, camera, domElement, face } = harness()
    const { rerender } = render(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} />)
    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
    expect(group.visible).toBe(true)
    rerender(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={null} />)
    expect(group.visible).toBe(false)
  })

  it('WO UI-14A (C5): calls requestRender on mount, on every face attach/detach, and on every drag pointermove', () => {
    const { scene, camera, domElement, face } = harness()
    let renderCalls = 0
    const requestRender = () => renderCalls++
    const { rerender } = render(
      <PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={null} requestRender={requestRender} />,
    )
    expect(renderCalls).toBe(2) // mount-once effect's scene.add + the face-attach effect's first run
    rerender(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} requestRender={requestRender} />)
    expect(renderCalls).toBe(3) // attach branch
    rerender(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={null} requestRender={requestRender} />)
    expect(renderCalls).toBe(4) // detach branch
  })

  it('WO UI-79 F-A: a REAL pointer drag reports the correct on-axis delta, and RELEASE stops the drag WITHOUT committing (there is no commit seam; the tool stays armed)', () => {
    const { scene, camera, domElement, face } = harness()
    stubPointerCapture(domElement)
    const changes: number[] = []
    const draggingStates: boolean[] = []
    render(
      <PushPullGizmo
        scene={scene}
        camera={camera}
        domElement={domElement}
        face={face}
        onChange={(d) => changes.push(d)}
        onDraggingChange={(d) => draggingStates.push(d)}
      />,
    )
    const origin = new THREE.Vector3(10, 5, 0)
    const grabPoint = origin.clone().add(new THREE.Vector3(0, 0, 4)) // grab the shaft 4mm up from origin
    const dragToPoint = origin.clone().add(new THREE.Vector3(0, 0, 9)) // drag to 9mm up
    const down = screenPointFor(camera, grabPoint)
    const move = screenPointFor(camera, dragToPoint)

    firePointer(domElement, 'pointerdown', down.x, down.y)
    expect(draggingStates).toEqual([true])
    firePointer(domElement, 'pointermove', move.x, move.y)
    // Grab-anywhere-preserves-offset: grabbed at +4, dragged to +9 -> reported delta is the CHANGE (+5), not the raw +9.
    expect(changes.length).toBe(1)
    expect(changes[0]).toBeCloseTo(5, 1)

    firePointer(domElement, 'pointerup', move.x, move.y)
    // Release emits dragging-false so the parent restores orbit -- but reports
    // NO further delta and completes nothing. The last live value (+5) is the
    // armed value the caller keeps; committing is the caller's own Apply path.
    expect(draggingStates).toEqual([true, false])
    expect(changes.length).toBe(1) // no extra onChange fired on release
    expect(changes[0]).toBeCloseTo(5, 1)
  })

  it('WO UI-79 F-A: a re-grab after release continues the offset from `value` (does not snap back to 0)', () => {
    const { scene, camera, domElement, face } = harness()
    stubPointerCapture(domElement)
    const changes: number[] = []
    // The tool is armed at +5 (a prior drag/typed value the caller passes back).
    render(
      <PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} value={5} onChange={(d) => changes.push(d)} />,
    )
    const origin = new THREE.Vector3(10, 5, 0)
    // Grab the shaft at +4 and drag to +6 (a +2 pointer move).
    const down = screenPointFor(camera, origin.clone().add(new THREE.Vector3(0, 0, 4)))
    const move = screenPointFor(camera, origin.clone().add(new THREE.Vector3(0, 0, 6)))
    firePointer(domElement, 'pointerdown', down.x, down.y)
    firePointer(domElement, 'pointermove', move.x, move.y)
    // Seeded from value=5, a +2 pointer move reports 7 -- NOT 2 (which a
    // zero-seeded grab would report, snapping the offset back).
    expect(changes.length).toBe(1)
    expect(changes[0]).toBeCloseTo(7, 1)
  })

  it('a pointerdown that misses the handle (far off-axis) starts no drag', () => {
    const { scene, camera, domElement, face } = harness()
    const draggingStates: boolean[] = []
    render(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} onDraggingChange={(d) => draggingStates.push(d)} />)
    const farAway = screenPointFor(camera, new THREE.Vector3(10, 5, 0).add(new THREE.Vector3(500, 500, 0)))
    firePointer(domElement, 'pointerdown', farAway.x, farAway.y)
    expect(draggingStates).toEqual([])
  })

  it('cleans up on unmount: removes the group from the scene and drops its listeners', () => {
    const { scene, camera, domElement, face } = harness()
    const { unmount } = render(<PushPullGizmo scene={scene} camera={camera} domElement={domElement} face={face} />)
    expect(scene.children.some((c) => c instanceof THREE.Group)).toBe(true)
    const removeSpy = vi.spyOn(domElement, 'removeEventListener')
    unmount()
    expect(scene.children.some((c) => c instanceof THREE.Group)).toBe(false)
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
  })

  // ---------------------------------------------------------------------
  // WO UI-57 audit F1 + WO UI-79 F-A -- pointer lifecycle: RELEASE is not
  // completion. Every test below drives REAL PointerEvents at domElement (the
  // driver seam is exercised separately, further down) and asserts the two
  // facts that matter: (a) NO termination path completes the tool -- this
  // component has no commit seam at all; completion is the caller's Apply path
  // (UI-79 F-A); (b) every termination still emits dragging-false, because the
  // parent's ONLY orbit restore is onDraggingChange
  // (`onDraggingChange={(dragging) => runtimeRef.current?.setOrbitEnabled(!dragging)}`),
  // so a missed emit is a permanently stuck viewport.
  // ---------------------------------------------------------------------
  describe('pointer lifecycle (audit F1 + UI-79 F-A: release never completes)', () => {
    /** Mirrors the parent's real wiring: orbit is enabled iff !dragging. There
     *  is no onCommit prop to wire -- the gizmo cannot complete the tool. */
    function lifecycleHarness() {
      const h = sideHarness(150)
      const capture = stubPointerCapture(h.domElement)
      const changes: number[] = []
      const draggingStates: boolean[] = []
      let orbitEnabled = true
      const props = {
        onChange: (d: number) => changes.push(d),
        onDraggingChange: (d: boolean) => {
          draggingStates.push(d)
          orbitEnabled = !d
        },
      }
      return { ...h, capture, changes, draggingStates, props, orbit: () => orbitEnabled }
    }

    it('UP: pointerup RELEASES -- emits dragging false, releases capture, restores orbit, and reports NO further delta (no completion)', () => {
      const h = lifecycleHarness()
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const up = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', up.x, up.y)
      expect(h.changes.length).toBe(1) // the live drag delta
      expect(h.changes[0]).toBeCloseTo(5, 1)
      firePointer(h.domElement, 'pointerup', up.x, up.y)
      expect(h.draggingStates).toEqual([true, false])
      expect(h.changes.length).toBe(1) // release fires no extra onChange, completes nothing
      expect(h.capture.released).toEqual([1])
      expect(h.orbit()).toBe(true)
    })

    it('CANCEL: pointercancel releases capture and emits dragging false', () => {
      const h = lifecycleHarness()
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      firePointer(h.domElement, 'pointercancel', move.x, move.y)
      expect(h.draggingStates).toEqual([true, false])
      expect(h.capture.released).toEqual([1])
      expect(h.orbit()).toBe(true)
    })

    it('LOST CAPTURE: lostpointercapture (no pointerup, no pointercancel) aborts -- dragging false, orbit restored', () => {
      const h = lifecycleHarness()
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      // The OS revoked capture mid-gesture. Before this fix nothing listened
      // for it: dragging stayed true forever and orbit never came back.
      firePointer(h.domElement, 'lostpointercapture', move.x, move.y)
      expect(h.draggingStates).toEqual([true, false])
      expect(h.orbit()).toBe(true)
    })

    it('UP then the browser lostpointercapture that follows it: emits dragging false ONCE (no double emit)', () => {
      const h = lifecycleHarness()
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      firePointer(h.domElement, 'pointerup', move.x, move.y)
      // releasePointerCapture is specified to fire this afterwards.
      firePointer(h.domElement, 'lostpointercapture', move.x, move.y)
      expect(h.draggingStates).toEqual([true, false])
    })

    it('CANCEL is idempotent: a second cancel (or a stray pointerup) after it emits nothing more', () => {
      const h = lifecycleHarness()
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      firePointer(h.domElement, 'pointercancel', move.x, move.y)
      firePointer(h.domElement, 'pointercancel', move.x, move.y)
      firePointer(h.domElement, 'pointerup', move.x, move.y)
      firePointer(h.domElement, 'lostpointercapture', move.x, move.y)
      expect(h.draggingStates).toEqual([true, false])
    })

    it('UNMOUNT mid-drag: effect cleanup emits dragging false (restoring the parent orbit)', () => {
      const h = lifecycleHarness()
      const { unmount } = render(
        <PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />,
      )
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      expect(h.orbit()).toBe(false) // orbit is OFF mid-drag, as the parent intends
      unmount()
      // The audit's stuck state: cleanup used to only drop listeners + dispose,
      // so orbit stayed disabled with no gizmo left on screen to re-enable it.
      expect(h.draggingStates).toEqual([true, false])
      expect(h.orbit()).toBe(true)
      expect(h.capture.released).toEqual([1])
    })

    it('ESCAPE: the parent unmounting the gizmo on Escape mid-drag restores orbit', () => {
      const h = lifecycleHarness()
      // Mirrors the parent's cancel shape (Escape -> stop rendering the gizmo).
      // The gizmo owns no Escape listener of its own -- the contract under test
      // is that ITS teardown is safe whenever the parent yanks it.
      function EscapeHost(props: PushPullGizmoProps) {
        const [mounted, setMounted] = useState(true)
        useEffect(() => {
          const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMounted(false) }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [])
        return mounted ? <PushPullGizmo {...props} /> : null
      }
      render(<EscapeHost scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} {...h.props} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      expect(h.orbit()).toBe(false)
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(h.draggingStates).toEqual([true, false])
      expect(h.orbit()).toBe(true) // the user can orbit again
    })

    it('WO UI-79 F-C: a real pointerdown that grabs the handle dispatches a pointercancel for that pointer BEFORE taking capture (un-latches any camera control that grabbed it)', () => {
      const h = sideHarness(150)
      stubPointerCapture(h.domElement)
      // A bystander that mimics OrbitControls: it latched this pointer on the
      // same pointerdown and only lets go on pointerup/pointercancel. The gizmo
      // must un-latch it via a synthetic pointercancel for the SAME pointerId.
      let latchedPointer: number | null = null
      const seenCancels: number[] = []
      h.domElement.addEventListener('pointerdown', (e) => { latchedPointer = (e as PointerEvent).pointerId })
      h.domElement.addEventListener('pointercancel', (e) => {
        const id = (e as PointerEvent).pointerId
        seenCancels.push(id)
        if (latchedPointer === id) latchedPointer = null
      })
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      firePointer(h.domElement, 'pointerdown', down.x, down.y, 7)
      // The gizmo dispatched a pointercancel for pointerId 7, so the bystander
      // forgot the pointer even though no real pointerup/cancel ever arrived.
      expect(seenCancels).toContain(7)
      expect(latchedPointer).toBeNull()
    })
  })

  // ---------------------------------------------------------------------
  // WO UI-57 audit F2 -- cohesion: screen-space scale, token color, cursors.
  // ---------------------------------------------------------------------
  describe('screen-space scale (audit F2: "the fixed-world gizmo is oversized")', () => {
    /** End-to-end span of the rendered handle, in CSS pixels, measured by
     *  projecting its two cone tips with the same camera the component uses.
     *  The side-on camera puts the handle axis perpendicular to the view, so
     *  both tips sit at the same depth and this is a clean length measurement
     *  with no foreshortening. */
    function handleSpanPx(camera: THREE.Camera, group: THREE.Group): number {
      const halfSpan = 26 * group.scale.x // (SHAFT_HALF_LENGTH + CONE_HEIGHT) local units
      const a = screenPointFor(camera, new THREE.Vector3(10, 5, halfSpan))
      const b = screenPointFor(camera, new THREE.Vector3(10, 5, -halfSpan))
      return Math.hypot(a.x - b.x, a.y - b.y)
    }

    it('renders the SAME on-screen size at near and far camera distances (not a fixed 52mm world object)', () => {
      const near = sideHarness(60)
      render(<PushPullGizmo scene={near.scene} camera={near.camera} domElement={near.domElement} face={near.face} />)
      const nearGroup = near.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
      const nearSpanPx = handleSpanPx(near.camera, nearGroup)

      cleanup()

      const far = sideHarness(400)
      render(<PushPullGizmo scene={far.scene} camera={far.camera} domElement={far.domElement} face={far.face} />)
      const farGroup = far.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
      const farSpanPx = handleSpanPx(far.camera, farGroup)

      // The world scales differ by ~6.7x precisely BECAUSE the screen size is held constant.
      expect(farGroup.scale.x / nearGroup.scale.x).toBeGreaterThan(5)
      expect(nearSpanPx).toBeCloseTo(farSpanPx, 0)
      // ~22% of the 600px-tall viewport: grabbable, and never swamping the part.
      expect(nearSpanPx).toBeGreaterThan(100)
      expect(nearSpanPx).toBeLessThan(160)
    })

    it('scales an OrthographicCamera off its zoom (depth-independent) rather than falling back to a fixed size', () => {
      /** Ortho frustum 150 world units tall (top 75, bottom -75), parked
       *  side-on like sideHarness. Returns the resolved group scale. */
      const orthoScaleAt = (zoom: number): number => {
        const h = sideHarness(150)
        const ortho = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
        ortho.zoom = zoom
        ortho.position.set(110, 5, 0)
        ortho.lookAt(10, 5, 0)
        ortho.updateMatrixWorld(true)
        render(<PushPullGizmo scene={h.scene} camera={ortho} domElement={h.domElement} face={h.face} />)
        const group = h.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
        const scale = group.scale.x
        cleanup()
        return scale
      }
      // visible height 150 world units -> handle spans 0.22 * 150 = 33 units -> scale 33/52.
      expect(orthoScaleAt(1)).toBeCloseTo((150 * 0.22) / 52, 4)
      // 3x zoom shows 1/3 the world -> the handle must shrink 3x in world units to hold its screen size.
      expect(orthoScaleAt(3)).toBeCloseTo((150 * 0.22) / 52 / 3, 4)
    })

    it('the drag delta is UNAFFECTED by the group scale (the drag math stays in unscaled world units)', () => {
      // Same physical gesture (grab the axis at +4mm, drag to +9mm) at two
      // camera distances whose visual scales differ ~6.7x. If the projection
      // math ever read the scaled transform instead of originRef/normalRef,
      // these two deltas would diverge by that factor.
      const deltaAt = (distance: number): { delta: number; scale: number } => {
        const h = sideHarness(distance)
        stubPointerCapture(h.domElement)
        const changes: number[] = []
        render(
          <PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} onChange={(d) => changes.push(d)} />,
        )
        const group = h.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
        const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
        const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
        firePointer(h.domElement, 'pointerdown', down.x, down.y)
        firePointer(h.domElement, 'pointermove', move.x, move.y)
        firePointer(h.domElement, 'pointerup', move.x, move.y)
        const scale = group.scale.x
        cleanup()
        return { delta: changes[changes.length - 1], scale } // the live drag delta (release completes nothing)
      }
      const near = deltaAt(60)
      const far = deltaAt(400)
      expect(far.scale / near.scale).toBeGreaterThan(5) // the scales really do differ
      expect(near.delta).toBeCloseTo(5, 1)
      expect(far.delta).toBeCloseTo(5, 1) // ...and the mm delta does not care
    })
  })

  describe('handle color (audit F2: viewport token bridge, not a duplicated 0xffaa00)', () => {
    afterEach(() => {
      document.documentElement.style.removeProperty('--vp-brep-pick')
      refreshViewportColors()
    })

    it('sources the handle color from the --vp-brep-pick token, so a theme change moves it', () => {
      // Retheme the token, then build the handle: a hardcoded 0xffaa00 literal
      // (the audit's finding) cannot follow this and the assertion goes RED.
      document.documentElement.style.setProperty('--vp-brep-pick', '#123456')
      refreshViewportColors()
      const expected = asNumber('--vp-brep-pick')
      expect(expected).toBe(0x123456) // guard: the bridge really did re-resolve

      const h = sideHarness(150)
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const group = h.scene.children.find((c) => c instanceof THREE.Group) as THREE.Group
      const shaft = group.children[0] as THREE.Mesh
      expect((shaft.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x123456)
    })
  })

  describe('cursors (audit F2: grab/grabbing with restoration)', () => {
    it('sets grab on hover over the handle and restores the host cursor on hover-out', () => {
      const h = sideHarness(150)
      h.domElement.style.cursor = 'crosshair' // a cursor the HOST already owns
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const onHandle = screenPointFor(h.camera, new THREE.Vector3(10, 5, 0))
      const offHandle = screenPointFor(h.camera, new THREE.Vector3(10, 300, 0))

      firePointer(h.domElement, 'pointermove', onHandle.x, onHandle.y)
      expect(h.domElement.style.cursor).toBe('grab')
      firePointer(h.domElement, 'pointermove', offHandle.x, offHandle.y)
      // Restored to the HOST's cursor -- not hard-coded back to 'default',
      // which is the stomp the audit called out at the parent.
      expect(h.domElement.style.cursor).toBe('crosshair')
    })

    it('sets grabbing while dragging and restores the host cursor on drag END', () => {
      const h = sideHarness(150)
      stubPointerCapture(h.domElement)
      h.domElement.style.cursor = 'crosshair'
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      expect(h.domElement.style.cursor).toBe('grabbing')
      firePointer(h.domElement, 'pointermove', move.x, move.y)
      expect(h.domElement.style.cursor).toBe('grabbing')
      firePointer(h.domElement, 'pointerup', move.x, move.y)
      expect(h.domElement.style.cursor).toBe('crosshair')
    })

    it('restores the host cursor on ABORT (pointercancel) -- a cancelled drag never leaves a grabbing cursor', () => {
      const h = sideHarness(150)
      stubPointerCapture(h.domElement)
      h.domElement.style.cursor = 'crosshair'
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      expect(h.domElement.style.cursor).toBe('grabbing')
      firePointer(h.domElement, 'pointercancel', down.x, down.y)
      expect(h.domElement.style.cursor).toBe('crosshair')
    })

    it('restores the host cursor on UNMOUNT, including an unmount mid-drag', () => {
      const h = sideHarness(150)
      stubPointerCapture(h.domElement)
      h.domElement.style.cursor = 'crosshair'
      const { unmount } = render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={h.face} />)
      const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4))
      firePointer(h.domElement, 'pointerdown', down.x, down.y)
      expect(h.domElement.style.cursor).toBe('grabbing')
      unmount()
      // Without cleanup restoration the canvas would keep a 'grabbing' cursor
      // forever after an Escape-driven unmount.
      expect(h.domElement.style.cursor).toBe('crosshair')
    })

    it('does not touch the cursor while detached (no face) even when the pointer crosses where the handle would be', () => {
      const h = sideHarness(150)
      h.domElement.style.cursor = 'crosshair'
      render(<PushPullGizmo scene={h.scene} camera={h.camera} domElement={h.domElement} face={null} />)
      const onHandle = screenPointFor(h.camera, new THREE.Vector3(10, 5, 0))
      firePointer(h.domElement, 'pointermove', onHandle.x, onHandle.y)
      expect(h.domElement.style.cursor).toBe('crosshair')
    })
  })

  describe('createTestDriver seam (used by SolidsWorkbenchPage.pushPull.test.tsx)', () => {
    it('drives onChange/onDraggingChange directly, bypassing raycasting entirely; simulateDragEnd RELEASES without completing (UI-79 F-A)', () => {
      const { scene, camera, domElement, face } = harness()
      let driver: PushPullGizmoTestDriver | null = null
      const changes: number[] = []
      const draggingStates: boolean[] = []
      render(
        <PushPullGizmo
          scene={scene}
          camera={camera}
          domElement={domElement}
          face={face}
          onChange={(d) => changes.push(d)}
          onDraggingChange={(d) => draggingStates.push(d)}
          createTestDriver={() => {
            driver = { simulateDragStart: () => {}, simulateDrag: () => {}, simulateDragEnd: () => {} }
            return driver
          }}
        />,
      )
      expect(driver).not.toBeNull()
      driver!.simulateDragStart()
      driver!.simulateDrag(-4.5)
      driver!.simulateDrag(-6)
      driver!.simulateDragEnd()
      expect(draggingStates).toEqual([true, false])
      // Release emits dragging-false but reports no extra delta and completes
      // nothing -- the last live value (-6) is the armed value the caller keeps.
      expect(changes).toEqual([-4.5, -6])
    })

    it('exposes the abort paths too: simulateDragCancel / simulateLostPointerCapture release the drag', () => {
      const { scene, camera, domElement, face } = harness()
      let driver: PushPullGizmoTestDriver | null = null
      const draggingStates: boolean[] = []
      render(
        <PushPullGizmo
          scene={scene}
          camera={camera}
          domElement={domElement}
          face={face}
          onDraggingChange={(d) => draggingStates.push(d)}
          createTestDriver={() => {
            driver = { simulateDragStart: () => {}, simulateDrag: () => {}, simulateDragEnd: () => {} }
            return driver
          }}
        />,
      )
      driver!.simulateDragStart()
      driver!.simulateDrag(-6)
      driver!.simulateDragCancel!()
      expect(draggingStates).toEqual([true, false])

      driver!.simulateDragStart()
      driver!.simulateDrag(-3)
      driver!.simulateLostPointerCapture!()
      expect(draggingStates).toEqual([true, false, true, false])
    })

    it('an unmount mid-driver-drag still emits dragging false (the same cleanup abort the real pointer path gets)', () => {
      const { scene, camera, domElement, face } = harness()
      let driver: PushPullGizmoTestDriver | null = null
      const draggingStates: boolean[] = []
      const { unmount } = render(
        <PushPullGizmo
          scene={scene}
          camera={camera}
          domElement={domElement}
          face={face}
          onDraggingChange={(d) => draggingStates.push(d)}
          createTestDriver={() => {
            driver = { simulateDragStart: () => {}, simulateDrag: () => {}, simulateDragEnd: () => {} }
            return driver
          }}
        />,
      )
      driver!.simulateDragStart()
      driver!.simulateDrag(-6)
      unmount()
      expect(draggingStates).toEqual([true, false])
    })

    it('does NOT attach real DOM pointer listeners when a test driver is supplied', () => {
      const { scene, camera, domElement, face } = harness()
      const addSpy = vi.spyOn(domElement, 'addEventListener')
      render(
        <PushPullGizmo
          scene={scene}
          camera={camera}
          domElement={domElement}
          face={face}
          createTestDriver={() => ({ simulateDragStart: () => {}, simulateDrag: () => {}, simulateDragEnd: () => {} })}
        />,
      )
      expect(addSpy).not.toHaveBeenCalledWith('pointerdown', expect.any(Function))
    })
  })
})
