// Pure rotation-matrix math, shared by store/dispatchGeo.ts and lib/cam
// callers (e.g. workholdingSeat.ts) that cannot import from store/.

import type { Vec3 } from '../../types'

/** Rotation matrix from Euler DEGREES in three.js 'XYZ' order
 *  (R = Rx * Ry * Rz) — the SAME order the viewport applies to the THREE
 *  group via group.rotation.set(...) (three Euler default order 'XYZ').
 *  The predicate and the renderer must agree. Returns the 3x3 as columns. */
export function rotationMatrixXYZ(rotation: Partial<Vec3> | undefined): {
  col1: Vec3; col2: Vec3; col3: Vec3
} {
  const x = ((rotation?.x ?? 0) * Math.PI) / 180
  const y = ((rotation?.y ?? 0) * Math.PI) / 180
  const z = ((rotation?.z ?? 0) * Math.PI) / 180
  const cx = Math.cos(x), sx = Math.sin(x)
  const cy = Math.cos(y), sy = Math.sin(y)
  const cz = Math.cos(z), sz = Math.sin(z)
  // R = Rx * Ry * Rz (verified against three.js Matrix4.makeRotationFromEuler 'XYZ')
  return {
    col1: { x: cy * cz, y: cx * sz + sx * sy * cz, z: sx * sz - cx * sy * cz },
    col2: { x: -cy * sz, y: cx * cz - sx * sy * sz, z: sx * cz + cx * sy * sz },
    col3: { x: sy, y: -sx * cy, z: cx * cy },
  }
}
