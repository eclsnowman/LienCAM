// @vitest-environment jsdom
//
// WO UI-72 (Operator note N-33): the sketch grid and sketch items must not be
// clipped when the Part-workbench camera tilts.
//
// SCOPE OF THIS FILE vs THE REAL GATE. jsdom has no frustum, so nothing here
// can observe an actual GPU clip -- the near<=depth<=far verdict on the REAL
// camera is tools/capture/ui72-grid-clip-gate.mjs's job (real Chrome, real GPU,
// mutation-proved RED in coordination/evidence/UI-72/mutation/). What IS
// testable here, and is deliberately tested here rather than in a browser, is
// the pure bounds logic underneath: which roots contribute, which do not, and
// -- the part that matters most -- the LIFECYCLE paths that a screenshot can
// never show.

import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DepthExtentRoots, VisibleBodyBoundsCache, createCameraSceneSafety } from '../../components/model3d/sceneRuntime'
import { markDepthExtentExempt } from '../../viewport3d/depthExtent'

const disposables: Array<() => void> = []
afterEach(() => { while (disposables.length > 0) disposables.pop()?.() })

function lineObject(halfLength: number, z = 0): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-halfLength, -halfLength, z),
    new THREE.Vector3(halfLength, halfLength, z),
  ])
  const material = new THREE.LineBasicMaterial()
  disposables.push(() => { geometry.dispose(); material.dispose() })
  return new THREE.Line(geometry, material)
}

/** A sketch-overlay-shaped root: real drawn geometry plus the injected
 *  pseudo-infinite axis line the production layer marks exempt. */
function overlayRoot(): { root: THREE.Group; axis: THREE.Line } {
  const root = new THREE.Group()
  root.add(lineObject(50))
  const axis = lineObject(100_000)
  markDepthExtentExempt(axis)
  root.add(axis)
  return { root, axis }
}

function sceneWith(obj: THREE.Object3D): THREE.Scene {
  const scene = new THREE.Scene()
  scene.add(obj)
  scene.updateMatrixWorld(true)
  return scene
}

describe('UI-72 DepthExtentRoots', () => {
  it('reports null bounds when nothing is registered', () => {
    const roots = new DepthExtentRoots()
    const snapshot = roots.snapshot()
    expect(snapshot.ok).toBe(true)
    expect(snapshot.ok ? snapshot.bounds : undefined).toBeNull()
  })

  it('measures a registered root that is in the scene and visible', () => {
    const line = lineObject(50)
    sceneWith(line)
    const roots = new DepthExtentRoots()
    roots.register(line)
    const snapshot = roots.snapshot()
    expect(snapshot.ok).toBe(true)
    expect(snapshot.ok ? snapshot.bounds?.max.x : undefined).toBeCloseTo(50)
  })

  // THE POINT OF THE WHOLE DESIGN: the injected axis lines are 100m long on
  // purpose. Including them drove the measured near/far runaway (see
  // markDepthExtentExempt). The extent must see the 50mm drawn line and NOT the
  // 100,000mm axis.
  it('EXCLUDES pseudo-infinite exempt decoration but keeps the real geometry beside it', () => {
    const { root } = overlayRoot()
    sceneWith(root)
    const roots = new DepthExtentRoots()
    roots.register(root)
    const snapshot = roots.snapshot()
    expect(snapshot.ok).toBe(true)
    expect(snapshot.ok ? snapshot.bounds?.max.x : undefined).toBeCloseTo(50)
    expect(snapshot.ok ? snapshot.bounds?.max.x : undefined).toBeLessThan(100)
  })

  it('un-marking the axis line pulls the 100km box back in (the exemption is load-bearing)', () => {
    const { root, axis } = overlayRoot()
    axis.userData.depthExtentExempt = false
    sceneWith(root)
    const roots = new DepthExtentRoots()
    roots.register(root)
    const snapshot = roots.snapshot()
    expect(snapshot.ok ? snapshot.bounds?.max.x : undefined).toBeCloseTo(100_000)
  })

  it('skips a hidden root, and a root hidden by an ANCESTOR several levels up', () => {
    const line = lineObject(50)
    const mid = new THREE.Group()
    const top = new THREE.Group()
    mid.add(line)
    top.add(mid)
    sceneWith(top)
    const roots = new DepthExtentRoots()
    roots.register(line)
    const first = roots.snapshot()
    expect(first.ok ? first.bounds : null).not.toBeNull()

    top.visible = false // three.js hides a subtree from ANY level
    const hidden = roots.snapshot()
    expect(hidden.ok).toBe(true)
    expect(hidden.ok ? hidden.bounds : undefined).toBeNull()
  })

  // THE FAIL-OPEN THIS CLOSES, built rather than argued (charter 4/5): the
  // sketch teardown paths do NOT all reach unregisterDepthExtent --
  // Sketcher.exit() early-returns `if (!session)` before firing onSessionExit,
  // and Sketcher.dispose() never fires it at all, while SolidsWorkbenchPage's
  // finish path detaches the overlay root itself either way. A root left
  // registered after detach must contribute NOTHING; if it did, the slab would
  // stay widened around geometry that is no longer drawn.
  it('a DETACHED but still-registered root contributes nothing (teardown paths miss unregister)', () => {
    const line = lineObject(50)
    const scene = sceneWith(line)
    const roots = new DepthExtentRoots()
    roots.register(line)
    const first = roots.snapshot()
    expect(first.ok ? first.bounds : null).not.toBeNull()

    scene.remove(line) // exactly what runtime.removeObject does; no unregister
    expect(line.visible).toBe(true) // still "visible", still registered...
    expect(roots.size()).toBe(1)
    const after = roots.snapshot()
    expect(after.ok).toBe(true)
    expect(after.ok ? after.bounds : undefined).toBeNull() // ...but structurally not rendered
  })

  it('a root re-parented under a plain detached Group also contributes nothing', () => {
    const line = lineObject(50)
    const scene = sceneWith(line)
    const orphanage = new THREE.Group() // never added to a scene
    const roots = new DepthExtentRoots()
    roots.register(line)
    scene.remove(line)
    orphanage.add(line)
    const after = roots.snapshot()
    expect(after.ok ? after.bounds : undefined).toBeNull()
  })

  // WO UI-72-R1 MAJOR 1, built rather than argued (charter 4). three.js does NOT
  // invalidate geometry.boundingBox when a position buffer is written IN PLACE,
  // and the live sketch path does exactly that: SketchLayer.updateDimensionGeometry
  // rewrites the position values, sets needsUpdate, and recomputes only the
  // bounding SPHERE. A depth extent that trusts a non-null boundingBox therefore
  // fits the slab to where the geometry USED to be -- so a dimension guide dragged
  // outside the old envelope clips. That is this WO's own defect, reintroduced
  // through the cache, which is why it is tested at the exact production shape:
  // measure, mutate in place, measure again.
  it('sees an IN-PLACE position rewrite that pushes a registered item past the old extent', () => {
    const line = lineObject(1)
    sceneWith(line)
    const roots = new DepthExtentRoots()
    roots.register(line)

    const first = roots.snapshot()
    expect(first.ok ? first.bounds?.max.x : undefined).toBeCloseTo(1)

    // Exactly what updateDimensionGeometry does: write the values, flag the GPU
    // upload, refresh the SPHERE only. It never touches boundingBox.
    const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute
    positions.setXYZ(1, 100, 100, 0)
    positions.needsUpdate = true
    line.geometry.computeBoundingSphere()

    const second = roots.snapshot()
    expect(second.ok).toBe(true)
    expect(second.ok ? second.bounds?.max.x : undefined).toBeCloseTo(100)
  })

  // The complement: a pass that changes NOTHING must not silently start reading a
  // different box. Without this, "recompute every time" would pass the test above
  // while quietly throwing the cache away, and the version cache -- the thing that
  // keeps the pass off a per-vertex scan -- would be untested.
  it('is stable across repeated passes when nothing mutates', () => {
    const { root } = overlayRoot()
    sceneWith(root)
    const roots = new DepthExtentRoots()
    roots.register(root)
    // Read the number out NOW: snapshot() returns its own reused union Box3, so
    // holding the first snapshot and reading it after the second would compare
    // the object with itself and pass no matter what.
    const first = roots.snapshot()
    const firstMaxX = first.ok ? first.bounds?.max.x : undefined
    const second = roots.snapshot()
    expect(first.ok && second.ok).toBe(true)
    expect(firstMaxX).toBeCloseTo(50)
    expect(second.ok ? second.bounds?.max.x : undefined).toBeCloseTo(50)
  })

  it('refuses BY NAME on non-finite geometry instead of poisoning the union', () => {
    // A NaN corner compares false in BOTH directions, so it would sail through
    // the policy's own finite checks and silently become a slab that clips
    // everything. It must refuse here, at the accept point.
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Number.NaN, 10, 0),
    ])
    const material = new THREE.LineBasicMaterial()
    disposables.push(() => { geometry.dispose(); material.dispose() })
    const line = new THREE.Line(geometry, material)
    sceneWith(line)
    const roots = new DepthExtentRoots()
    roots.register(line)
    const snapshot = roots.snapshot()
    expect(snapshot.ok).toBe(false)
    expect(!snapshot.ok && snapshot.reason).toBe('camera-bounds-refused-nonfinite')
  })
})

describe('UI-72 applyDepthSafety consumes the depth extent', () => {
  function harness(depthExtentRoots?: DepthExtentRoots) {
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 2000)
    camera.position.set(0, 0, 120)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const boundsCache = new VisibleBodyBoundsCache()
    const controls = {
      target: new THREE.Vector3(), mouseButtons: {}, touches: {}, enabled: true, enablePan: true,
      addEventListener: () => {}, removeEventListener: () => {},
    } as unknown as Parameters<typeof createCameraSceneSafety>[0]['controls']
    const canvas = document.createElement('div')
    const safety = createCameraSceneSafety({
      getCamera: () => camera, controls, canvas, boundsCache, depthExtentRoots,
    })
    disposables.push(() => safety.dispose())
    return { camera, boundsCache, safety }
  }

  function smallBody(): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(40, 30, 10)
    const material = new THREE.MeshBasicMaterial()
    disposables.push(() => { geometry.dispose(); material.dispose() })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.updateWorldMatrix(true, false)
    return mesh
  }

  /** A 200mm grid TILTED so it spans camera depth -- the repro condition. Head-on
   *  it would sit at one constant depth and clip nothing, which is exactly why
   *  the bug only shows when the user tilts. */
  function tiltedGrid(): THREE.Line {
    const line = lineObject(100)
    line.rotation.x = 0.6
    sceneWith(line)
    return line
  }

  it('WITHOUT the depth extent, the slab excludes the tilted grid (the pre-fix defect)', () => {
    const { camera, boundsCache, safety } = harness(undefined)
    boundsCache.register(smallBody())
    const grid = tiltedGrid()
    const result = safety.applyDepthSafety()
    expect(result?.ok).toBe(true)

    const box = new THREE.Box3().setFromObject(grid)
    const depths = cornerDepths(box, camera)
    expect(Math.max(...depths)).toBeGreaterThan(camera.far) // clipped
  })

  it('WITH the depth extent, every tilted-grid corner is inside the slab', () => {
    const roots = new DepthExtentRoots()
    const { camera, boundsCache, safety } = harness(roots)
    boundsCache.register(smallBody())
    const grid = tiltedGrid()
    roots.register(grid)
    const result = safety.applyDepthSafety()
    expect(result?.ok).toBe(true)

    const box = new THREE.Box3().setFromObject(grid)
    for (const depth of cornerDepths(box, camera)) {
      expect(depth).toBeGreaterThanOrEqual(camera.near)
      expect(depth).toBeLessThanOrEqual(camera.far)
    }
  })

  it('with NO visible body the depth pass stays a no-op, extent registered or not', () => {
    // The real arm-A control (coordination/evidence/UI-72/repro/): the grid
    // renders whole at 0.1/2000, so fitting a slab to a zero-thickness grid
    // plane would be a regression invented for symmetry.
    const roots = new DepthExtentRoots()
    const { camera, safety } = harness(roots)
    roots.register(tiltedGrid())
    expect(safety.applyDepthSafety()).toBeNull()
    expect(camera.near).toBe(0.1)
    expect(camera.far).toBe(2000)
  })

  // WO UI-72-R1 MAJOR 1 at the consumer end. The DepthExtentRoots test above
  // proves the stale box is seen; this proves the thing the USER feels -- that
  // the SLAB actually opens to admit the moved geometry. Asserted on near/far,
  // because a bounds fix that never reached the policy would still clip.
  it('an IN-PLACE position rewrite past the slab makes the depth policy EXPAND near/far', () => {
    const roots = new DepthExtentRoots()
    const { camera, boundsCache, safety } = harness(roots)
    boundsCache.register(smallBody())
    const grid = tiltedGrid()
    roots.register(grid)
    expect(safety.applyDepthSafety()?.ok).toBe(true)
    const before = { near: camera.near, far: camera.far }

    // Push one endpoint far behind the body, the way a dimension guide dragged
    // outside the old envelope does -- in place, sphere-only, boundingBox stale.
    const positions = grid.geometry.getAttribute('position') as THREE.BufferAttribute
    positions.setXYZ(1, 100, 100, -400)
    positions.needsUpdate = true
    grid.geometry.computeBoundingSphere()
    grid.updateWorldMatrix(true, true)

    expect(safety.applyDepthSafety()?.ok).toBe(true)
    expect(camera.far).toBeGreaterThan(before.far) // the slab admits the moved end
    for (const depth of cornerDepths(new THREE.Box3().setFromObject(grid), camera)) {
      expect(depth).toBeGreaterThanOrEqual(camera.near)
      expect(depth).toBeLessThanOrEqual(camera.far)
    }
  })

  it('a non-finite depth-extent root refuses the whole pass rather than fitting a poisoned slab', () => {
    const roots = new DepthExtentRoots()
    const { camera, boundsCache, safety } = harness(roots)
    boundsCache.register(smallBody())
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, Number.NaN, 0),
    ])
    const material = new THREE.LineBasicMaterial()
    disposables.push(() => { geometry.dispose(); material.dispose() })
    const bad = new THREE.Line(geometry, material)
    sceneWith(bad)
    roots.register(bad)

    const before = { near: camera.near, far: camera.far }
    const result = safety.applyDepthSafety()
    expect(result?.ok).toBe(false)
    expect(!result?.ok && result?.reason).toBe('camera-bounds-refused-nonfinite')
    expect(camera.near).toBe(before.near) // planes untouched by a refused pass
    expect(camera.far).toBe(before.far)
  })
})

function cornerDepths(box: THREE.Box3, camera: THREE.Camera): number[] {
  const out: number[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < 8; i += 1) {
    v.set(
      (i & 1) === 0 ? box.min.x : box.max.x,
      (i & 2) === 0 ? box.min.y : box.max.y,
      (i & 4) === 0 ? box.min.z : box.max.z,
    ).applyMatrix4(camera.matrixWorldInverse)
    out.push(-v.z)
  }
  return out
}
