// Guard test for the refresh-camera fix: a page refresh that restores a saved
// camera must NOT have that framing clobbered by the model-load auto-fit.
//
// BUG (Operator): commit 03f8cd0 restored the camera synchronously on mount, but the
// async geometry restore that follows calls fitCameraToObject on the FIRST part
// added, overriding the restored pose. The first fix used a ONE-SHOT guard
// (skipNextInitialFit) consumed by the first fit-eligible add. T15: on a real GPU
// the async STEP load can land a SECOND/late fit AFTER the one-shot is spent,
// which still snapped the view back to ISO. The fix here is a PERSISTENT flag
// (markCameraUserPositioned -> cameraUserPositioned), checked by maybeAutoFit at
// every auto-fit site, that stays set until an explicit view change / New/Open
// clears it — so no late async fit can leak through regardless of timing.
//
// These tests drive the REAL CNCViewport.add2DGeometry (its tail funnels through
// maybeAutoFit) on a minimal real-method instance (typedZTransform pattern), with
// fitCameraToObject spied so we assert exactly when it fires.

import * as THREE from 'three'
import { describe, it, expect, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { Loop2D, Layer2D } from '../../types'

interface VpUnderTest {
  add2DGeometry: CNCViewport['add2DGeometry']
  markCameraUserPositioned: CNCViewport['markCameraUserPositioned']
  fitAll: CNCViewport['fitAll']
  fitCameraToObject: ReturnType<typeof vi.fn>
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    workpieceGroup: new THREE.Group(),
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    fitCameraToObject: vi.fn(),
  })
  return vp as VpUnderTest
}

const loops: Loop2D[] = [{
  id: 'loop-1',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  closed: true, type: 'contour', layerId: 'L1', area: 100,
}]
const layers: Layer2D[] = [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }]

describe('CNCViewport auto-fit guard (refresh camera persistence)', () => {
  it('auto-fits on the first geometry by default (New/Open/Import path)', () => {
    const vp = makeVp()
    vp.add2DGeometry('g1', loops, layers)
    expect(vp.fitCameraToObject).toHaveBeenCalledTimes(1)
  })

  it('skips the first-geometry auto-fit when the camera is user-positioned (refresh)', () => {
    const vp = makeVp()
    vp.markCameraUserPositioned()
    vp.add2DGeometry('g1', loops, layers)
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()
  })

  it('PERSISTENT: a second/late first-eligible add stays suppressed (T15 gap)', () => {
    // This is exactly the case the old one-shot guard missed: after the first add
    // consumed it, a SECOND fit-eligible add (the late async STEP-load fit on a
    // real GPU) would re-fit to ISO. The persistent flag keeps suppressing it.
    const vp = makeVp()
    vp.markCameraUserPositioned()
    vp.add2DGeometry('g1', loops, layers)
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()

    // Simulate a second "first item" add (e.g. the async STEP part landing after
    // a 2D restore) by clearing the groups so totalParts === 1 again.
    vp.geometry2dGroups.clear()
    vp.add2DGeometry('g2', loops, layers)
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()
  })

  it('an explicit fitAll clears the flag, re-enabling auto-fit for a fresh load', () => {
    const vp = makeVp()
    vp.markCameraUserPositioned()
    // fitAll with no parts present moves nothing but clears the user-positioned
    // flag (the user re-took framing control). New/Open clears it the same way.
    vp.fitAll()
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()

    vp.add2DGeometry('g1', loops, layers)
    expect(vp.fitCameraToObject).toHaveBeenCalledTimes(1)
  })
})

// ── restoreCameraState: SCALE (frustumSize) restore + old-data fallback ───────
// The refresh restore path calls restoreCameraState with a deserialized pose.
// Before this fix it applied position/target/zoom only, leaving the orthographic
// extent at the constructor default (500) — so the saved view came back at the
// wrong SCALE. These tests bind the real restoreCameraState onto a minimal
// instance and assert it recomputes the camera extents from frustumSize + aspect.
interface RestoreVp {
  restoreCameraState: CNCViewport['restoreCameraState']
  markCameraUserPositioned: CNCViewport['markCameraUserPositioned']
  add2DGeometry: CNCViewport['add2DGeometry']
  fitCameraToObject: ReturnType<typeof vi.fn>
  camera: THREE.OrthographicCamera
  frustumSize: number
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
}

function makeRestoreVp(): RestoreVp {
  const camera = new THREE.OrthographicCamera(-250, 250, 250, -250, 0.1, 10000)
  camera.up.set(0, 0, 1)
  const controls = { target: new THREE.Vector3(), update: () => {} }
  const container = { clientWidth: 800, clientHeight: 400 } // aspect 2
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    camera,
    controls,
    container,
    frustumSize: 500,
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    workpieceGroup: new THREE.Group(),
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    fitCameraToObject: vi.fn(),
  })
  return vp as RestoreVp
}

describe('CNCViewport.restoreCameraState (SCALE / frustumSize round-trip)', () => {
  it('applies position/target/zoom AND recomputes camera extents from frustumSize', () => {
    const vp = makeRestoreVp()
    vp.restoreCameraState({
      position: { x: 10, y: -20, z: 30 },
      target: { x: 1, y: 2, z: 3 },
      zoom: 1.5,
      frustumSize: 340,
    })
    expect(vp.frustumSize).toBe(340)
    expect(vp.camera.zoom).toBe(1.5)
    expect(vp.camera.position.toArray()).toEqual([10, -20, 30])
    // aspect = 800/400 = 2; left/right = +/- frustumSize*aspect/2, top/bottom = +/- frustumSize/2
    expect(vp.camera.right).toBeCloseTo(340, 6)
    expect(vp.camera.left).toBeCloseTo(-340, 6)
    expect(vp.camera.top).toBeCloseTo(170, 6)
    expect(vp.camera.bottom).toBeCloseTo(-170, 6)
  })

  it('OLD-DATA FALLBACK: a pose without frustumSize keeps the current extents (no NaN)', () => {
    const vp = makeRestoreVp()
    const before = { left: vp.camera.left, right: vp.camera.right, top: vp.camera.top, bottom: vp.camera.bottom }
    vp.restoreCameraState({ position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, zoom: 2 })
    expect(vp.frustumSize).toBe(500)                 // unchanged construction default
    expect(vp.camera.right).toBe(before.right)       // extents untouched
    expect(vp.camera.left).toBe(before.left)
    expect(vp.camera.zoom).toBe(2)                    // position/zoom still restored
  })

  it('restore + markCameraUserPositioned suppresses a later first-item auto-fit (mount contract)', () => {
    // Mirrors the Viewport.tsx mount sequence: restore the saved pose, arm the
    // persistent flag, then the async geometry restore adds the first item. The
    // auto-fit must NOT fire, so the restored framing survives (the reset bug).
    const vp = makeRestoreVp()
    vp.restoreCameraState({
      position: { x: 10, y: -20, z: 30 }, target: { x: 0, y: 0, z: 0 }, zoom: 1, frustumSize: 200,
    })
    vp.markCameraUserPositioned()
    vp.add2DGeometry('g1', loops, layers)
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()
    // Late second first-item add (async STEP landing) stays suppressed too.
    vp.geometry2dGroups.clear()
    vp.add2DGeometry('g2', loops, layers)
    expect(vp.fitCameraToObject).not.toHaveBeenCalled()
  })
})
