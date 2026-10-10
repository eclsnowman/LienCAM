// WO UI-74 (Operator finding N-36): "You have workspace clipping again. Look at the
// grid. This is getting disapointing. Fix this. It should NEVER, EVER happen
// again."
//
// These tests pin the CAM camera depth policy -- computeCamDepthSlab -- on REAL
// THREE scenes and a REAL OrthographicCamera. No WebGL context is needed because
// the policy is pure geometry, which is exactly why it was extracted.
//
// The scene fixture is not invented: it is the geometry the repro MEASURED on
// the live CAM workspace (coordination/evidence/UI-74/repro/pose.json) --
//   grid          800 x 800mm at z~0        (max(machineTravelX, machineTravelY))
//   machine border 800 x 600mm at z=0.3
//   workpiece      40 x 10mm  near the origin
//   TransformControls helper  1,000,000mm span, pseudo-infinite
// with the camera placed where fitCameraToObject actually puts it: distance =
// maxDim*5 from the WORKPIECE bounds, at the (0.7, -0.9, 0.6) iso offset.
//
// Every assertion below is one the PRE-FIX code fails: pre-fix, near/far were
// construction constants (0.1 / 10000) and no policy existed at all. The
// preimage is retained at coordination/evidence/UI-74/preimage/ and the real
// browser gate is run against it (coordination/evidence/UI-74/mutation/).

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { computeCamDepthSlab, camUnionDepthExtent } from '../../lib/viewport/CNCViewport'
import { markDepthExtentExempt } from '../../viewport3d/depthExtent'

/** The grid CNCViewport.buildGrid actually builds: GridHelper(size) spans
 *  -size/2..+size/2 and is rotated flat. */
function makeGrid(size = 800): THREE.Group {
  const g = new THREE.Group()
  g.name = 'gridGroup'
  const grid = new THREE.GridHelper(size, Math.max(2, Math.round(size / 25)))
  grid.rotation.x = Math.PI / 2
  g.add(grid)
  return g
}

function makeWorkpiece(w = 40, d = 10, h = 8): THREE.Group {
  const g = new THREE.Group()
  g.name = 'workpieceGroup'
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w, d, h), new THREE.MeshBasicMaterial()))
  return g
}

/** three.js's TransformControls helper, reduced to the property that matters:
 *  pseudo-infinite guide lines named X/Y/Z, each running along its OWN axis, at
 *  the 1,000,000mm span measured on the live CAM scene. */
function makeGizmoHelper(span = 1_000_000): THREE.Object3D {
  const root = new THREE.Object3D()
  const axes: Array<[string, THREE.Vector3]> = [
    ['X', new THREE.Vector3(1, 0, 0)],
    ['Y', new THREE.Vector3(0, 1, 0)],
    ['Z', new THREE.Vector3(0, 0, 1)],
  ]
  for (const [name, dir] of axes) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      dir.clone().multiplyScalar(-span / 2), dir.clone().multiplyScalar(span / 2),
    ])
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial())
    line.name = name
    root.add(line)
  }
  return root
}

/** The camera exactly where fitCameraToObject puts it for `object`. */
function fittedCamera(object: THREE.Object3D): THREE.OrthographicCamera {
  const bbox = new THREE.Box3().setFromObject(object)
  const size = bbox.getSize(new THREE.Vector3())
  const center = bbox.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  const frustumSize = maxDim * 2.5
  const aspect = 16 / 9
  const cam = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2,
    0.1, 10000,
  )
  cam.up.set(0, 0, 1)
  const distance = maxDim * 5
  cam.position.set(center.x + distance * 0.7, center.y - distance * 0.9, center.z + distance * 0.6)
  cam.lookAt(center)
  cam.updateMatrixWorld(true)
  return cam
}

/** Worst amount by which any corner of `obj` falls outside [near, far]. 0 = the
 *  object is wholly inside the slab. This is the QUANTITY Operator sees as a cut
 *  grid, measured the same way the acceptance gate measures it in the browser. */
function worstClip(obj: THREE.Object3D, cam: THREE.Camera, near: number, far: number): number {
  const box = new THREE.Box3().setFromObject(obj)
  cam.updateMatrixWorld(true)
  let worst = 0
  const v = new THREE.Vector3()
  for (let i = 0; i < 8; i += 1) {
    v.set(
      (i & 1) ? box.max.x : box.min.x,
      (i & 2) ? box.max.y : box.min.y,
      (i & 4) ? box.max.z : box.min.z,
    ).applyMatrix4(cam.matrixWorldInverse)
    const depth = -v.z
    if (!Number.isFinite(depth)) return NaN
    if (depth < near) worst = Math.max(worst, near - depth)
    if (depth > far) worst = Math.max(worst, depth - far)
  }
  return worst
}

/** The live CAM Setup-tab scene from the repro, minus the gizmo unless asked. */
function camScene(opts: { gizmo?: boolean } = {}): { scene: THREE.Scene; grid: THREE.Group; workpiece: THREE.Group } {
  const scene = new THREE.Scene()
  const grid = makeGrid(800)
  const workpiece = makeWorkpiece()
  scene.add(grid, workpiece)
  scene.add(new THREE.AmbientLight())
  if (opts.gizmo === true) {
    const gizmo = makeGizmoHelper()
    markDepthExtentExempt(gizmo)
    scene.add(gizmo)
  }
  scene.updateMatrixWorld(true)
  return { scene, grid, workpiece }
}

describe('UI-74 CAM camera depth policy - the defect Operator reported', () => {
  it("the 800mm grid is INSIDE the slab at the part-fitted, tilted pose (Operator's N-36 bug)", () => {
    const { scene, grid, workpiece } = camScene()
    const cam = fittedCamera(workpiece)

    // The defect, pinned first: the PRE-FIX constants really do cut this grid.
    // Without this the test could pass on a scene that was never clipped, and
    // would assert nothing (the UI-72 gate's own check-2 lesson).
    expect(worstClip(grid, cam, 0.1, 10000)).toBeGreaterThan(50)

    const slab = computeCamDepthSlab(scene, cam)
    expect(slab.ok).toBe(true)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    expect(worstClip(grid, cam, slab.near, slab.far)).toBe(0)
  })

  it('fits a slab that covers the whole scene, and near goes NEGATIVE to do it', () => {
    const { scene, workpiece } = camScene()
    const cam = fittedCamera(workpiece)
    const slab = computeCamDepthSlab(scene, cam)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    // Grid corners sit behind the eye at this pose, so a slab that covers them
    // MUST start behind the eye. A policy clamped to near>0 cannot fix this bug.
    expect(slab.near).toBeLessThan(0)
    expect(slab.far).toBeGreaterThan(slab.minDepth)
    expect(slab.near).toBeLessThan(slab.minDepth)
  })

  it('fits, rather than widens: the slab tracks the scene instead of blowing out', () => {
    // The trap UI-72 hit and named: "un-clip the grid by opening the slab to
    // 100km" passes a clip check and destroys depth precision. The scene here is
    // an 800mm grid at ~200mm standoff, so a correct slab is ~1000mm deep.
    const { scene, workpiece } = camScene()
    const cam = fittedCamera(workpiece)
    const slab = computeCamDepthSlab(scene, cam)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    expect(slab.far - slab.near).toBeLessThan(2000)
    // ... and it is TIGHTER than the constants it replaced, so this is a depth-
    // precision improvement, not a trade.
    expect(slab.far - slab.near).toBeLessThan(10000 - 0.1)
  })

  it('stays fitted when the camera is level (the pose where nothing ever clipped)', () => {
    const { scene, grid, workpiece } = camScene()
    const cam = fittedCamera(workpiece)
    // Straight down: the grid sits at ONE constant camera depth. This is why the
    // defect is invisible head-on, and it must not regress into a degenerate
    // slab now that a policy exists.
    cam.position.set(0, 0, 500)
    cam.up.set(0, 1, 0)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    const slab = computeCamDepthSlab(scene, cam)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    expect(slab.far).toBeGreaterThan(slab.near)
    expect(worstClip(grid, cam, slab.near, slab.far)).toBe(0)
  })
})

describe('UI-74 - every non-body surface the CAM viewport hosts', () => {
  // The census clause, at unit level: a fix that frames the grid and clips the
  // machine border or the WCS marker is a partial. Each surface is asserted BY
  // NAME, and each is first shown to be cut by the pre-fix constants -- an
  // assertion on a surface that was never clipped proves nothing.
  const surfaces: Array<{ name: string; build: () => THREE.Object3D }> = [
    { name: 'gridGroup (800mm machine-sized setup grid)', build: () => makeGrid(800) },
    {
      name: 'machineTravelBorderGroup (dashed 800x600 travel border)',
      build: () => {
        const g = new THREE.Group()
        g.name = 'machineTravelBorderGroup'
        const pts = [
          new THREE.Vector3(-400, -300, 0.3), new THREE.Vector3(400, -300, 0.3),
          new THREE.Vector3(400, 300, 0.3), new THREE.Vector3(-400, 300, 0.3),
          new THREE.Vector3(-400, -300, 0.3),
        ]
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial()))
        return g
      },
    },
    {
      name: 'stockGroup (stock outline out at the grid edge, on the eye side)',
      build: () => {
        const g = new THREE.Group()
        g.name = 'stockGroup'
        const m = new THREE.Mesh(new THREE.BoxGeometry(300, 300, 20), new THREE.MeshBasicMaterial())
        // +x / -y is the EYE side (fitCameraToObject's offset is 0.7, -0.9, 0.6),
        // i.e. the side that falls behind the near plane. A stock placed on the
        // far side is not clipped pre-fix and would make this case vacuous --
        // which the guard below caught when it was.
        m.position.set(250, -250, 0)
        g.add(m)
        return g
      },
    },
  ]

  for (const surface of surfaces) {
    it(`${surface.name} is inside the fitted slab when tilted`, () => {
      const scene = new THREE.Scene()
      const workpiece = makeWorkpiece()
      const obj = surface.build()
      scene.add(obj, workpiece)
      scene.updateMatrixWorld(true)
      const cam = fittedCamera(workpiece)

      expect(worstClip(obj, cam, 0.1, 10000)).toBeGreaterThan(0) // non-vacuity
      const slab = computeCamDepthSlab(scene, cam)
      if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
      expect(worstClip(obj, cam, slab.near, slab.far)).toBe(0)
    })
  }
})

describe('UI-74 - the pseudo-infinite gizmo exemption', () => {
  it('an EXEMPT root contributes nothing to the extent', () => {
    const withGizmo = camScene({ gizmo: true })
    const without = camScene({ gizmo: false })
    const camA = fittedCamera(withGizmo.workpiece)
    const camB = fittedCamera(without.workpiece)
    const a = computeCamDepthSlab(withGizmo.scene, camA)
    const b = computeCamDepthSlab(without.scene, camB)
    if (!a.ok || a.near === null || !b.ok || b.near === null) throw new Error('policy declined to fit a slab')
    expect(a.near).toBeCloseTo(b.near, 6)
    expect(a.far).toBeCloseTo(b.far, 6)
  })

  it('WITHOUT the exemption the same gizmo blows the slab out past 1,000,000mm', () => {
    // The exemption's own non-vacuity: if an unexempted gizmo did NOT wreck the
    // slab, the test above would pass for the wrong reason and the exemption
    // would be untested decoration. Measured on the live scene: unioning it in
    // gives a ~1.8-million-mm slab (~0.1mm of 24-bit z-resolution).
    const { scene, workpiece } = camScene()
    scene.add(makeGizmoHelper()) // deliberately NOT marked exempt
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(workpiece)
    const slab = computeCamDepthSlab(scene, cam)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    expect(slab.far - slab.near).toBeGreaterThan(1_000_000)
  })

  it('the exemption skips the whole SUBTREE, not just the marked node', () => {
    const union = new THREE.Box3()
    const root = new THREE.Object3D()
    const child = new THREE.Mesh(new THREE.BoxGeometry(1e6, 1e6, 1e6), new THREE.MeshBasicMaterial())
    root.add(child)
    markDepthExtentExempt(root) // marked on the PARENT, geometry on the CHILD
    root.updateMatrixWorld(true)
    expect(camUnionDepthExtent(union, root, new THREE.Vector3())).toBe('none')
    expect(union.isEmpty()).toBe(true)
  })
})

describe('UI-74 - the extent walk refuses rather than fails open', () => {
  it('an invisible subtree contributes nothing', () => {
    const union = new THREE.Box3()
    const root = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(500, 500, 500), new THREE.MeshBasicMaterial())
    root.add(mesh)
    root.visible = false
    root.updateMatrixWorld(true)
    expect(camUnionDepthExtent(union, root, new THREE.Vector3())).toBe('none')
  })

  it('a NaN vertex REFUSES the whole pass instead of being skipped', () => {
    // The fail-open path this class dies on: a root whose geometry went NaN
    // still RENDERS, so quietly dropping it from the extent fits a slab that
    // clips it -- this very defect, back through the error path. NaN also
    // compares false in both directions, so a silent skip LOOKS like a pass.
    const scene = new THREE.Scene()
    scene.add(makeWorkpiece())
    const bad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    bad.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([NaN, 0, 0, 1, 1, 1]), 3))
    scene.add(bad)
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(scene)
    const slab = computeCamDepthSlab(scene, cam)
    expect(slab.ok).toBe(false)
    if (slab.ok) throw new Error('expected a refusal')
    expect(slab.reason).toBe('camera-depth-refused-nonfinite-bounds')
  })

  it('a scene with nothing drawable reports no opinion, leaving the defaults', () => {
    const scene = new THREE.Scene()
    scene.add(new THREE.AmbientLight())
    scene.add(new THREE.Group())
    scene.updateMatrixWorld(true)
    const slab = computeCamDepthSlab(scene, fittedCamera(new THREE.Object3D()))
    expect(slab.ok).toBe(true)
    if (!slab.ok) throw new Error('expected no opinion, got a refusal')
    expect(slab.near).toBeNull()
  })
})

describe('UI-74 A5 - an IN-PLACE geometry write moves the slab with it', () => {
  it('extending a line IN PLACE re-extends the depth range (version-keyed, not presence-keyed)', () => {
    // WO UI-72-R1's exact defect, pre-empted here. three.js NEVER invalidates
    // geometry.boundingBox on an in-place vertex write, so a cache keyed on
    // "boundingBox === null" keeps returning the OLD extent -- and the
    // supposedly inclusive slab then clips the thing that moved. This test would
    // pass against a presence-keyed cache ONLY if the cache is never consulted;
    // it is (the first computeCamDepthSlab call below populates it).
    const scene = new THREE.Scene()
    scene.add(makeWorkpiece())
    const geo = new THREE.BufferGeometry()
    const pos = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3)
    geo.setAttribute('position', pos)
    const outline = new THREE.Line(geo, new THREE.LineBasicMaterial())
    outline.name = 'stock-outline'
    scene.add(outline)
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(scene)

    const before = computeCamDepthSlab(scene, cam)
    if (!before.ok || before.near === null) throw new Error('policy declined to fit a slab')

    // Extend it IN PLACE, exactly as the live code does: rewrite the values,
    // flag needsUpdate. No new geometry, no re-registration, no callback.
    pos.setXYZ(1, 600, 600, 0)
    pos.needsUpdate = true
    scene.updateMatrixWorld(true)

    const after = computeCamDepthSlab(scene, cam)
    if (!after.ok || after.near === null) throw new Error('policy declined to fit a slab')

    // The moved endpoint is now the deepest thing in the scene; the slab must
    // have followed it. A stale cache leaves `after` identical to `before`.
    expect(after.far - after.near).toBeGreaterThan((before.far - before.near) + 100)
    expect(worstClip(outline, cam, after.near, after.far)).toBe(0)
  })

  it('an unreadable change signal recomputes rather than assuming unchanged', () => {
    // null version means RECOMPUTE, never "nothing moved": an unreadable counter
    // is not evidence of stillness. Interleaved attributes are the live case.
    const scene = new THREE.Scene()
    scene.add(makeWorkpiece())
    const geo = new THREE.BufferGeometry()
    const buffer = new THREE.InterleavedBuffer(new Float32Array([0, 0, 0, 1, 0, 0]), 3)
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0))
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial())
    scene.add(line)
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(scene)

    const before = computeCamDepthSlab(scene, cam)
    if (!before.ok || before.near === null) throw new Error('policy declined to fit a slab')

    buffer.array[3] = 700
    buffer.array[4] = 700
    scene.updateMatrixWorld(true)

    const after = computeCamDepthSlab(scene, cam)
    if (!after.ok || after.near === null) throw new Error('policy declined to fit a slab')
    expect(after.far - after.near).toBeGreaterThan((before.far - before.near) + 100)
  })

  it('REPLACING the position attribute re-extends the slab (identity-keyed, not version-keyed)', () => {
    // WO UI-74-R1, audit MINOR 1 -- the escape the cell above does NOT cover, and
    // the auditor built it: version counting restarts at 0 for every new
    // BufferAttribute, so setAttribute('position', <fresh attribute>) hands the
    // cache a version it has already seen. Keyed on the version alone, the stale
    // box survives the swap and the "inclusive" slab clips the thing that moved --
    // N-36 all over again, through the cache, via three.js's own buffer-swap
    // idiom. The stamp now carries the attribute's IDENTITY as well: identity
    // moves on every swap, version moves on every in-place write, and neither
    // alone covers both writers.
    //
    // RED against the version-only cache: the auditor's probe measured a geometry
    // at camera depth 5, replaced its position with a fresh version-0 buffer at
    // depth 500, and computeCamDepthSlab still returned 4.99..5.01.
    const scene = new THREE.Scene()
    scene.add(makeWorkpiece())
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3))
    const outline = new THREE.Line(geo, new THREE.LineBasicMaterial())
    outline.name = 'stock-outline'
    scene.add(outline)
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(scene)

    // Populate the cache: without this first call there is no stale box to catch.
    const before = computeCamDepthSlab(scene, cam)
    if (!before.ok || before.near === null) throw new Error('policy declined to fit a slab')
    const cachedBox = geo.boundingBox
    expect(cachedBox).not.toBeNull()

    // The swap. A BRAND NEW attribute, whose version is 0 -- the same value the
    // cache recorded for the ORIGINAL attribute, which is precisely why a
    // version-only key cannot see this coming.
    const replacement = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 900, 900, 0]), 3)
    expect(replacement.version).toBe(0)
    expect((geo.attributes.position as THREE.BufferAttribute).version).toBe(0)
    geo.setAttribute('position', replacement)
    scene.updateMatrixWorld(true)

    const after = computeCamDepthSlab(scene, cam)
    if (!after.ok || after.near === null) throw new Error('policy declined to fit a slab')

    // The replaced endpoint is now the deepest thing in the scene and the slab
    // must contain it. A version-only cache leaves `after` identical to `before`
    // and clips the line it just re-measured.
    expect(after.far - after.near).toBeGreaterThan((before.far - before.near) + 100)
    expect(worstClip(outline, cam, after.near, after.far)).toBe(0)
  })

  it('an attribute swap that does NOT move the extent still re-measures from the new buffer', () => {
    // The other half of identity-keying: the cache must key on the buffer it
    // actually measured, not merely notice big changes. Swapping in a fresh
    // attribute with the SAME extent must leave the box equal to the new buffer's
    // own bounds -- proving the recompute read the replacement rather than
    // returning the old object by luck.
    const scene = new THREE.Scene()
    scene.add(makeWorkpiece())
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 5, 0, 0]), 3))
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial())
    scene.add(line)
    scene.updateMatrixWorld(true)
    const cam = fittedCamera(scene)
    computeCamDepthSlab(scene, cam)

    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 5, 0, 0]), 3))
    scene.updateMatrixWorld(true)
    const after = computeCamDepthSlab(scene, cam)
    if (!after.ok || after.near === null) throw new Error('policy declined to fit a slab')
    expect(geo.boundingBox?.max.x).toBe(5)
    expect(worstClip(line, cam, after.near, after.far)).toBe(0)
  })
})

describe('UI-74 - the policy does not disturb picking', () => {
  it('the ortho pick ray is IDENTICAL before and after the slab is refitted', () => {
    // The one behaviour a near/far change could plausibly break here, settled by
    // construction rather than by argument. THREE.Raycaster puts the ortho ray
    // origin at NDC z = (near+far)/(near-far), which unprojects to camera depth
    // exactly 0 for ANY near/far -- the terms cancel. If a future three.js
    // changes that, this test fails and the negative near needs re-justifying.
    const { scene, workpiece } = camScene()
    const cam = fittedCamera(workpiece)
    const coords = new THREE.Vector2(0.23, -0.41)

    const rayBefore = new THREE.Raycaster()
    rayBefore.setFromCamera(coords, cam) // near/far still 0.1 / 10000

    const slab = computeCamDepthSlab(scene, cam)
    if (!slab.ok || slab.near === null) throw new Error('policy declined to fit a slab')
    expect(slab.near).toBeLessThan(0) // the change is real, not a no-op
    cam.near = slab.near
    cam.far = slab.far
    cam.updateProjectionMatrix()

    const rayAfter = new THREE.Raycaster()
    rayAfter.setFromCamera(coords, cam)

    expect(rayAfter.ray.origin.distanceTo(rayBefore.ray.origin)).toBeLessThan(1e-6)
    expect(rayAfter.ray.direction.distanceTo(rayBefore.ray.direction)).toBeLessThan(1e-9)
  })
})
