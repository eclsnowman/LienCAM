import * as THREE from 'three'

/** WO UI-72 (Operator note N-33). The camera-depth policy (sceneRuntime.ts's
 *  CameraDepthPolicy) fits the near/far slab to the scene extent it is handed.
 *  Anything that renders but is NOT in that extent gets clipped once the camera
 *  tilts -- which is the whole defect this WO fixes for the sketch grid and the
 *  sketch overlay.
 *
 *  The complement of that rule needs a home too: some scene objects are
 *  deliberately pseudo-infinite decoration and must NOT be framed. This module
 *  is that seam. It lives in viewport3d/ (a layer both the model3d runtime and
 *  the sketch package may import) precisely so the runtime never has to reach
 *  into the sketch layer to recognize such objects by name -- the site that
 *  knows an object is pseudo-infinite is the site that marks it. */

const DEPTH_EXTENT_EXEMPT = 'depthExtentExempt'

/** Mark `obj` (and everything under it) as deliberately unbounded: the
 *  camera-depth policy skips the subtree when computing its near/far slab.
 *
 *  The live case is the sketch overlay's injected X/Y axis lines
 *  (SKETCH_AXIS_HALF_LENGTH_MM = 100 m half-length, "infinite-style" reference
 *  lines meant to run off-screen). Feeding them to the policy MEASURED a
 *  +/-100,000 mm box and a runaway camera retreat -- near pinned at 1414.2 with
 *  far climbing 5,672 -> 33,011 -> 73,640 -> 159,754 across four depth passes,
 *  because each retreat enlarged the screen-scaled glyphs, which enlarged the
 *  box, which forced another retreat. See coordination/evidence/UI-72/.
 *
 *  Use it ONLY for geometry whose extent is a rendering convenience rather than
 *  content the user must see in full. Real drawn geometry must stay in the
 *  extent or it will clip -- that is the bug, not the fix. */
export function markDepthExtentExempt(obj: THREE.Object3D): void {
  obj.userData[DEPTH_EXTENT_EXEMPT] = true
}

/** True iff `obj` was marked by markDepthExtentExempt. */
export function isDepthExtentExempt(obj: THREE.Object3D): boolean {
  return obj.userData[DEPTH_EXTENT_EXEMPT] === true
}
