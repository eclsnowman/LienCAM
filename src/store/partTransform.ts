// Coordinate hierarchy Phase 4 - Item 1: the single world-placement seam.
//
// `partWorldTransform` is the SOLE source of truth for "where does this part
// sit in the world (machine) frame, and how is it oriented". Every site that
// places a part group in the viewport should derive its placement from here
// rather than reading `geo.position` / `geo.rotation` directly.
//
// WHY a seam that does nothing today:
//   Under Q1 = Option 1 (machine-absolute coordinates + delta propagation by
//   membership id - see docs/planning/PHASE4-PLAN.md S3b), `geo.position` /
//   `geo.rotation` are already MACHINE-absolute for BOTH derived and explicit
//   members. There is exactly ONE coordinate meaning, so the world transform is
//   the stored transform unchanged (the identity). This helper is therefore
//   byte-identical to today's ad-hoc reads.
//
//   The value is the UPGRADE seam (ADR-0020 guardrails a/c):
//     - a future WORKSPACE tier (machine -> workspace -> stock -> geometry)
//       adds ONE compose step HERE - no call-site churn (guardrail a:
//       composable parent-child transforms).
//     - a future switch to Q1 = Option 2 (stored stock-RELATIVE local
//       transforms) does the compose `world = stockWorld * local` HERE, again
//       with no call-site churn. The `stocks` parameter is already threaded for
//       exactly that day.
//   Both upgrades are additive and driven purely by membership ids on the
//   children (guardrail c) - no `members[]` aggregate on the parent.
//
// This module is intentionally dependency-light: pure math only, no store /
// viewport imports, no side effects. Its functions are PURE.

import type { ImportedGeometry, PhysicalStock, Vec3 } from '../types'
import { rotationMatrixXYZ } from '../lib/geometry/rotationMatrixXYZ'
import { turnWorldPointForSecondSide, type SecondSideTurn } from '../lib/cam/flipSetup'

/** A part's resolved world (machine-frame) placement. */
export interface PartWorldTransform {
  position: Vec3
  rotation: Vec3
}

/**
 * Resolve a part's world placement.
 *
 * Option 1 (machine-absolute): the stored transform IS the world transform, so
 * this returns `geo.position` / `geo.rotation` unchanged for derived AND
 * explicit members alike. `stocks` is accepted now (and intentionally unused)
 * so the future workspace tier / stored-relative model composes here without
 * touching any call site.
 *
 * @param geo    the part whose world placement we want.
 * @param stocks the project's physical stocks (the future compose context).
 */
export function partWorldTransform(
  geo: ImportedGeometry,
  stocks: ReadonlyArray<PhysicalStock>,
): PartWorldTransform {
  // `stocks` is the future compose context (workspace tier / stored
  // stock-relative transform - see the module doc comment). Identity today
  // under Option 1, so it is intentionally unused; the `void` keeps the
  // parameter named and on the public signature without tripping
  // `noUnusedParameters`.
  void stocks
  return { position: geo.position, rotation: geo.rotation }
}

/**
 * WO-3196: a part's world placement as a second side holds it. The 3D engine
 * machines the part turned inside its block (turnWorldPointForSecondSide);
 * whatever draws or compares against that part must place it with the same
 * turn, or the toolpath and the part disagree. The turn is applied after the
 * part's own pose: position goes through the same point turn, rotation is the
 * half turn times the pose's rotation, read back as XYZ degrees (the order the
 * viewport applies). No turn (a first side) returns the placement unchanged.
 */
export function partWorldTransformAsSetupHoldsIt(
  placement: PartWorldTransform,
  turn: SecondSideTurn | null,
): PartWorldTransform {
  if (!turn) return placement
  return {
    position: turnWorldPointForSecondSide(placement.position, turn),
    rotation: eulerXYZDegrees(turned(turn, matrixOf(placement.rotation))),
  }
}

/**
 * WO-3196: the stored rotation after a viewport gesture on a part a second
 * side draws turned. A gesture that did not rotate the drawn part (a drag)
 * carries `stored` through untouched - un-turning its drawn rotation in
 * floating point would store a tilt of 7e-15 degrees, which every 3D route
 * refuses. A rotate composes its delta (drawn after times drawn before
 * inverse), un-turned, onto `stored`, each component snapped to 1e-9 degrees
 * so 90 stays 90 and 0 stays 0. A first side: the drop as dropped.
 */
export function storedRotationAfterGesture(
  stored: Vec3,
  drawnBefore: Vec3,
  drawnAfter: Vec3,
  turn: SecondSideTurn | null,
): Vec3 {
  if (!turn) return drawnAfter
  const [before, after] = [matrixOf(drawnBefore), matrixOf(drawnAfter)]
  const moved = after.some((row, i) => row.some((v, j) => Math.abs(v - before[i][j]) > 1e-9))
  if (!moved) return stored
  const delta = multiply(after, transpose(before))
  const composed = multiply(turned(turn, transpose(turned(turn, transpose(delta)))), matrixOf(stored))
  const r = eulerXYZDegrees(composed)
  return { x: snapDegrees(r.x), y: snapDegrees(r.y), z: snapDegrees(r.z) }
}

type Matrix3 = number[][]

/** The rotation's 3x3, row-major. */
function matrixOf(rotation: Vec3): Matrix3 {
  const { col1, col2, col3 } = rotationMatrixXYZ(rotation)
  return [[col1.x, col2.x, col3.x], [col1.y, col2.y, col3.y], [col1.z, col2.z, col3.z]]
}

/** The half turn times `m`: about X it negates the Y and Z rows; about Y, the X and Z rows. */
function turned(turn: SecondSideTurn, m: Matrix3): Matrix3 {
  const sign = turn.axis === 'x' ? [1, -1, -1] : [-1, 1, -1]
  return m.map((row, i) => row.map(v => sign[i] * v))
}

function transpose(m: Matrix3): Matrix3 {
  return m[0].map((_, j) => m.map(row => row[j]))
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  return a.map(row => b[0].map((_, j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
}

/** three.js Euler.setFromRotationMatrix, order 'XYZ', in degrees. */
function eulerXYZDegrees(m: Matrix3): Vec3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])))
  const gimbal = Math.abs(m[0][2]) >= 0.9999999
  const x = gimbal ? Math.atan2(m[2][1], m[1][1]) : Math.atan2(-m[1][2], m[2][2])
  const z = gimbal ? 0 : Math.atan2(-m[0][1], m[0][0])
  const deg = 180 / Math.PI
  return { x: x * deg, y: y * deg, z: z * deg }
}

/** Nearest 1e-9 degree; never -0. */
function snapDegrees(v: number): number {
  const s = Math.round(v * 1e9) / 1e9
  return s === 0 ? 0 : s
}
