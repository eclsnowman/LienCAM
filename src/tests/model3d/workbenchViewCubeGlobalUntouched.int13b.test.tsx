// @vitest-environment jsdom
//
// WO INT-13B (D1.3) -- the modern form of WO UI-17-R1's regression.
//
// REPLACES workbenchViewCubeBridge.test.tsx (3 tests). Those probed a mechanism
// D1.3 DELETES: conditional acquisition of window.__cncViewport, the `ownsBridge`
// state, and the occupied-slot refusal. They could not be retargeted onto the prop
// contract literally -- there is no acquisition left to assert.
//
// But the DEFECT they were written to catch is still real, and is exactly what a
// future edit is most likely to reintroduce. UI-17-R1's audit finding 2 was: the
// workbench mount silently CLOBBERED the CAM route's live __cncViewport bridge.
// D1.3 makes that structurally impossible by giving the cube a camera prop -- so
// the modern invariant is stronger and simpler than "acquire carefully":
//
//     the workbench touches window.__cncViewport ZERO times.
//
// Not "leaves it equal" -- never reads it, never writes it, never deletes it,
// mount or unmount, occupied slot or empty, whatever its props say. Identity
// alone would be too weak a net: a reintroduced READ (the pre-D1.3 cube's actual
// contract, ViewCube.tsx:122/:179) leaves the value === identical and would sail
// straight through an equality assertion. So the global is installed as an
// ACCESSOR and every get/set is counted -- that is the assertion that fails the
// moment anyone reaches for the global again.
//
// Non-vacuous by construction: restore any of the three deleted pieces (the
// acquisition effect, ownsBridge, the refusal) and `writes` (or, for a bare read,
// `reads`) goes nonzero and this test fails. Proof of that is committed at
// coordination/evidence/INT-13B/mutation-B0-prop/.

import { describe, it, expect, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, cleanup } from '@testing-library/react'
import { WorkbenchViewCube, workbenchCubeCameraApi } from '../../components/model3d/workbench/WorkbenchViewCube'
import type { SceneRuntime, WorkbenchViewName } from '../../components/model3d/sceneRuntime'

interface BridgeShape {
  getCamera(): THREE.Camera
  setCameraView(view: WorkbenchViewName): void
}

const w = window as unknown as { __cncViewport?: BridgeShape }

afterEach(() => {
  cleanup()
  delete (w as Record<string, unknown>).__cncViewport
})

/** The two members the cube's camera contract reads off SceneRuntime, nothing else. */
function stubRuntime(): { runtime: SceneRuntime; camera: THREE.Camera; setCameraViewCalls: WorkbenchViewName[] } {
  const camera = new THREE.PerspectiveCamera()
  const setCameraViewCalls: WorkbenchViewName[] = []
  const runtime = {
    camera,
    setCameraView: (view: WorkbenchViewName) => {
      setCameraViewCalls.push(view)
    },
  } as unknown as SceneRuntime
  return { runtime, camera, setCameraViewCalls }
}

/** Install `window.__cncViewport` as a counting accessor holding `initial`.
 *  Returns the live counters plus a restore fn. An accessor -- not a plain value
 *  -- is the whole point: it catches a READ, which is what the pre-D1.3 cube
 *  actually did to this slot and what an equality check cannot see. */
function watchGlobal(initial: BridgeShape | undefined) {
  const counts = { reads: 0, writes: 0 }
  let value = initial
  Object.defineProperty(window, '__cncViewport', {
    configurable: true,
    get() {
      counts.reads += 1
      return value
    },
    set(next: BridgeShape | undefined) {
      counts.writes += 1
      value = next
    },
  })
  return {
    counts,
    /** Reads the slot WITHOUT disturbing the counters. */
    peek: () => value,
    restore: () => {
      delete (window as unknown as Record<string, unknown>).__cncViewport
    },
  }
}

describe('WO INT-13B (D1.3): the workbench view cube never touches window.__cncViewport', () => {
  it('leaves an OCCUPIED slot byte-identical and unread across mount and unmount (UI-17-R1 clobber regression, modern form)', () => {
    const sentinel: BridgeShape = {
      getCamera: () => new THREE.PerspectiveCamera(),
      setCameraView: () => {},
    }
    const watch = watchGlobal(sentinel)
    try {
      // before mount
      expect(watch.peek()).toBe(sentinel)

      const { runtime } = stubRuntime()
      const view = render(<WorkbenchViewCube runtime={runtime} />)

      // during mount -- FAILS-IF acquisition/refusal logic is reintroduced in any
      // form: an unconditional publish trips `writes`, and even UI-17-R1's
      // careful "is the slot occupied?" check trips `reads`.
      expect(watch.peek()).toBe(sentinel)
      expect(watch.counts).toEqual({ reads: 0, writes: 0 })

      view.unmount()

      // after unmount -- FAILS-IF an unpublish/cleanup tail is reintroduced.
      expect(watch.peek()).toBe(sentinel)
      expect(watch.counts).toEqual({ reads: 0, writes: 0 })
    } finally {
      watch.restore()
    }
  })

  it('leaves an EMPTY slot empty and unread -- the workbench publishes nothing, so CAM stays the sole publisher', () => {
    const watch = watchGlobal(undefined)
    try {
      const { runtime } = stubRuntime()
      const view = render(<WorkbenchViewCube runtime={runtime} />)

      // FAILS-IF the workbench republishes a SceneRuntime-backed bridge on an
      // unowned slot (its pre-D1.3 behavior). Under D1 the slot is never
      // unowned in production anyway -- CAM publishes it unconditionally at
      // Viewport.tsx:844 -- but the contract is "zero touches", not "zero
      // touches when someone else got there first".
      expect(watch.peek()).toBeUndefined()
      expect(watch.counts).toEqual({ reads: 0, writes: 0 })

      view.unmount()
      expect(watch.peek()).toBeUndefined()
      expect(watch.counts).toEqual({ reads: 0, writes: 0 })
    } finally {
      watch.restore()
    }
  })

  it('drives ITS OWN runtime through the camera prop -- the coverage the deleted bridge tests carried', () => {
    // The old file proved "the published bridge is wired to THIS runtime". That
    // claim survives D1.3; only its delivery mechanism changed (global -> prop).
    // jsdom has no WebGL, so the cube itself cannot mount to be interrogated
    // through the DOM -- workbenchCubeCameraApi is the exported seam that keeps
    // the wiring assertable headlessly. That the PAGE passes this api to the real
    // cube is proved separately, at page level, by SolidsWorkbenchPage.ui17's
    // AC5 block.
    const { runtime, camera, setCameraViewCalls } = stubRuntime()
    const api = workbenchCubeCameraApi(runtime)

    expect(api.getCamera()).toBe(camera)
    api.setCameraView('front')
    expect(setCameraViewCalls).toEqual(['front'])
  })

  it('resolves runtime.camera at CALL time, so a projection swap cannot pin the cube to a dead camera', () => {
    // sceneRuntime.setCameraProjection REPLACES the camera object outright (a
    // PerspectiveCamera and an OrthographicCamera are different subclasses; there
    // is no in-place conversion). FAILS-IF workbenchCubeCameraApi ever captures
    // runtime.camera at build time instead of reading it per call -- the cube
    // would silently keep mirroring the discarded pre-swap camera.
    const mutable = { camera: new THREE.PerspectiveCamera(), setCameraView: () => {} } as unknown as SceneRuntime
    const api = workbenchCubeCameraApi(mutable)
    const swapped = new THREE.OrthographicCamera()
    ;(mutable as { camera: THREE.Camera }).camera = swapped

    expect(api.getCamera()).toBe(swapped)
  })
})
