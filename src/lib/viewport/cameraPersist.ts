// ---------------------------------------------------------------------------
// Camera-pose (de)serialization for refresh-persistence.
// ---------------------------------------------------------------------------
// A page refresh should return the viewport to the user's last camera framing
// ("feels like an application, not a webpage"). CNCViewport.saveCameraState()
// returns THREE.Vector3 instances which cannot go straight into localStorage,
// so this module converts to/from a plain JSON-safe shape. Kept framework-free
// (no three import) and pure so the round-trip is unit-testable.
//
// We persist position + orbit target + ortho zoom + frustumSize — the fields
// CNCViewport.saveCameraState / restoreCameraState round-trip (camera `up` is the
// fixed Z-up convention and is never changed, so it is not stored).
//
// frustumSize is the orthographic extent set by fitCameraToObject (maxDim*2.5).
// Without it a refresh restores position/target/zoom onto the CONSTRUCTOR default
// frustumSize (500), so the apparent SCALE of a persisted view is wrong even when
// the angle is preserved. It is OPTIONAL: pre-existing localStorage data written
// before this field lacks it, and deserialize must NOT reject such a pose — it
// falls back to the current (construction-default) frustumSize.

/** JSON-safe camera pose written to localStorage. */
export interface SerializedCamera {
  position: [number, number, number]
  target: [number, number, number]
  zoom: number
  /** Orthographic frustum extent (optional; absent in pre-frustumSize data). */
  frustumSize?: number
}

/** Plain {x,y,z} vector — structurally compatible with THREE.Vector3 (which has
 *  x/y/z and a .copy() that reads them), so a deserialized pose can be handed
 *  straight to CNCViewport.restoreCameraState without importing three here. */
interface Vec3Like { x: number; y: number; z: number }

/** Camera pose shape produced by CNCViewport.saveCameraState() and consumed by
 *  restoreCameraState(). position/target are Vector3-like; zoom is the ortho zoom. */
export interface CameraPose {
  position: Vec3Like
  target: Vec3Like
  zoom: number
  /** Orthographic frustum extent (optional; absent when restoring old data). */
  frustumSize?: number
}

/** Convert a live camera pose into the JSON-safe stored form. */
export function serializeCamera(pose: CameraPose): SerializedCamera {
  const out: SerializedCamera = {
    position: [pose.position.x, pose.position.y, pose.position.z],
    target: [pose.target.x, pose.target.y, pose.target.z],
    zoom: pose.zoom,
  }
  // Persist frustumSize only when it is a usable positive number, so a live pose
  // that omits it (or carries a NaN) never writes a value deserialize would drop.
  if (Number.isFinite(pose.frustumSize) && (pose.frustumSize as number) > 0) {
    out.frustumSize = pose.frustumSize
  }
  return out
}

function finite3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const [a, b, c] = v
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
  return [a as number, b as number, c as number]
}

/** Parse a stored camera into a pose usable by restoreCameraState. Returns null
 *  for anything malformed / non-finite (a stale or tampered value falls back to
 *  the default framing rather than crashing or producing a NaN camera). */
export function deserializeCamera(raw: unknown): CameraPose | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<SerializedCamera>
  const position = finite3(r.position)
  const target = finite3(r.target)
  if (!position || !target) return null
  if (!Number.isFinite(r.zoom) || (r.zoom as number) <= 0) return null
  const pose: CameraPose = {
    position: { x: position[0], y: position[1], z: position[2] },
    target: { x: target[0], y: target[1], z: target[2] },
    zoom: r.zoom as number,
  }
  // frustumSize is OPTIONAL: only carry it through when it is a usable positive
  // number. Missing or bad => omit (restore keeps the current frustumSize) rather
  // than reject the whole pose — an old localStorage value must still restore.
  if (Number.isFinite(r.frustumSize) && (r.frustumSize as number) > 0) {
    pose.frustumSize = r.frustumSize as number
  }
  return pose
}
