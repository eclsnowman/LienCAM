// WO-2167: rigid-transform math for workholding assemblies.
//
// A pose is position (mm) + Euler XYZ rotation in degrees, the convention the
// viewport places a body group with (rotationMatrixXYZ). Composition happens in
// 4x4 matrices, column-major like three.js Matrix4.elements, so a chain such as
// instance * joint * component stays exact without converting back to angles.

import type { Vec3, WorkholdingPose } from '../../types'
import { rotationMatrixXYZ } from '../geometry/rotationMatrixXYZ'

/** A rigid 4x4 transform, column-major (three.js Matrix4.elements order). */
export type Mat4 = readonly number[]

export const IDENTITY_POSE: WorkholdingPose = {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
}

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** world = position + R(rotation) * local. Missing numbers read as 0. */
export function poseToMat4(pose: Partial<WorkholdingPose> | undefined): Mat4 {
  const { col1, col2, col3 } = rotationMatrixXYZ(pose?.rotation)
  const p = pose?.position
  return [
    col1.x, col1.y, col1.z, 0,
    col2.x, col2.y, col2.z, 0,
    col3.x, col3.y, col3.z, 0,
    p?.x ?? 0, p?.y ?? 0, p?.z ?? 0, 1,
  ]
}

export function translationMat4(v: Vec3): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, v.x, v.y, v.z, 1]
}

/** a * b: apply b first, then a. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3]
    }
  }
  return out
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  }
}

/** A NEW positions array (xyz triples) carried through `m`. */
export function transformPositions(m: Mat4, positions: ArrayLike<number>): Float32Array {
  const out = new Float32Array(positions.length - (positions.length % 3))
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
  }
  return out
}

/** `m` applied to a direction (no translation). */
export function transformDirection(m: Mat4, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z,
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z,
    z: m[2] * v.x + m[6] * v.y + m[10] * v.z,
  }
}

/** WO-2172: the inverse of a RIGID transform (rotation + translation): R^T, -R^T p. */
export function invertRigidMat4(m: Mat4): Mat4 {
  const px = m[12], py = m[13], pz = m[14]
  return [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * px + m[1] * py + m[2] * pz),
    -(m[4] * px + m[5] * py + m[6] * pz),
    -(m[8] * px + m[9] * py + m[10] * pz),
    1,
  ]
}

/**
 * WO-2172: a rigid transform back to position + Euler XYZ degrees - the pose a
 * viewport body group takes to sit exactly at `m` (three.js
 * Euler.setFromRotationMatrix, order 'XYZ'). poseToMat4(mat4ToPose(m)) === m.
 */
export function mat4ToPose(m: Mat4): WorkholdingPose {
  const m11 = m[0], m12 = m[4], m13 = m[8]
  const m22 = m[5], m23 = m[9]
  const m32 = m[6], m33 = m[10]
  const y = Math.asin(Math.min(1, Math.max(-1, m13)))
  let x: number
  let z: number
  if (Math.abs(m13) < 0.9999999) {
    x = Math.atan2(-m23, m33)
    z = Math.atan2(-m12, m11)
  } else {
    x = Math.atan2(m32, m22)
    z = 0
  }
  const deg = (r: number) => {
    const d = (r * 180) / Math.PI
    return Object.is(d, -0) ? 0 : d
  }
  return {
    position: { x: m[12], y: m[13], z: m[14] },
    rotation: { x: deg(x), y: deg(y), z: deg(z) },
  }
}
