// WO-2945: pure frame conversion. Domain resolvers still choose the pose;
// this module never reads a project, a controller offset, or material state.
import type { Vec3 } from '../../types'
import {
  invertRigidMat4, multiplyMat4, poseToMat4, transformDirection, transformPoint,
  type Mat4,
} from '../workholding/pose'
import { rotationMatrixXYZ } from './rotationMatrixXYZ'

const FRAME_KINDS = ['geometry-native', 'display-local', 'world', 'setup-work',
  'strategy', 'stock-grid', 'nest-sheet', 'controller-work', 'machine'] as const
export type FrameKind = typeof FRAME_KINDS[number]

/** Right-handed metric coordinates. stock-grid means mm, never integer indices.
 * World is project scene space, NOT the physical controller machine frame.
 * Owners supply epochs/revisions; this module cannot establish their currency. */
export interface FrameRef<F extends FrameKind = FrameKind> {
  readonly kind: F
  readonly projectEpoch: string
  readonly entityId: string
  readonly revision: string
}

// Invariant brands prevent widening frame kinds to bypass a typed boundary.
declare const pointBrand: unique symbol
declare const vectorBrand: unique symbol
const mapMatrix: unique symbol = Symbol('coordinate-frame-matrix')
declare const mapBrand: unique symbol
export interface FramedPointMm<F extends FrameKind> {
  readonly frame: FrameRef<F>
  readonly value: Readonly<Vec3>
  readonly [pointBrand]: (kind: F) => F
}
export interface FramedVectorMm<F extends FrameKind> {
  readonly frame: FrameRef<F>
  readonly value: Readonly<Vec3>
  readonly [vectorBrand]: (kind: F) => F
}
export interface RigidMap<A extends FrameKind, B extends FrameKind> {
  readonly from: FrameRef<A>
  readonly to: FrameRef<B>
  readonly [mapMatrix]: Mat4
  readonly [mapBrand]: (from: A, to: B) => [A, B]
}

export function frameRef<F extends FrameKind>(ref: FrameRef<F>): FrameRef<F> {
  if (!FRAME_KINDS.includes(ref.kind) || ![ref.kind, ref.projectEpoch, ref.entityId, ref.revision].every(v => typeof v === 'string' && v.length > 0)) {
    throw new Error('Frame identity and revision must be explicit')
  }
  return Object.freeze({ kind: ref.kind, projectEpoch: ref.projectEpoch, entityId: ref.entityId, revision: ref.revision })
}

export function sameFrame(a: FrameRef, b: FrameRef): boolean {
  return a.kind === b.kind && a.projectEpoch === b.projectEpoch &&
    a.entityId === b.entityId && a.revision === b.revision
}

function requireSameFrame(a: FrameRef, b: FrameRef): void {
  if (!sameFrame(a, b)) throw new Error('Coordinate frame identity or revision mismatch')
}

function metricValue(value: Readonly<Vec3>): Readonly<Vec3> {
  if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error('Coordinate must be finite mm')
  return Object.freeze({ x: value.x, y: value.y, z: value.z })
}

export function pointMm<F extends FrameKind>(frame: FrameRef<F>, value: Readonly<Vec3>): FramedPointMm<F> {
  return Object.freeze({ frame: frameRef(frame), value: metricValue(value) }) as FramedPointMm<F>
}
export function vectorMm<F extends FrameKind>(frame: FrameRef<F>, value: Readonly<Vec3>): FramedVectorMm<F> {
  return Object.freeze({ frame: frameRef(frame), value: metricValue(value) }) as FramedVectorMm<F>
}

/** T[to <- from], column-major. No scale, shear, reflection or perspective. */
export function rigidMap<A extends FrameKind, B extends FrameKind>(
  from: FrameRef<A>, to: FrameRef<B>, matrix: Mat4,
): RigidMap<A, B> {
  if (from.projectEpoch !== to.projectEpoch) throw new Error('Cannot map between project epochs')
  if (matrix.length !== 16 || !matrix.every(Number.isFinite) ||
      matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new Error('Expected a finite rigid affine matrix')
  }
  const dot = (a: number, b: number) => matrix[a] * matrix[b] + matrix[a + 1] * matrix[b + 1] + matrix[a + 2] * matrix[b + 2]
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9]) -
    matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9]) +
    matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5])
  const errors = [dot(0, 0) - 1, dot(4, 4) - 1, dot(8, 8) - 1, dot(0, 4), dot(0, 8), dot(4, 8), determinant - 1]
  if (errors.some(error => Math.abs(error) > 1e-10)) throw new Error('Expected a right-handed orthonormal rigid basis')
  return Object.freeze({ from: frameRef(from), to: frameRef(to), [mapMatrix]: Object.freeze([...matrix]) }) as RigidMap<A, B>
}

export function rigidMapFromPose<A extends FrameKind, B extends FrameKind>(
  from: FrameRef<A>, to: FrameRef<B>, pose: { position: Vec3; rotation: Vec3 },
): RigidMap<A, B> {
  return rigidMap(from, to, poseToMat4(pose))
}

export function mapPoint<A extends FrameKind, B extends FrameKind>(
  map: RigidMap<A, B>, point: FramedPointMm<NoInfer<A>>,
): FramedPointMm<B> {
  requireSameFrame(map.from, point.frame)
  return pointMm(map.to, transformPoint(map[mapMatrix], point.value))
}
export function mapVector<A extends FrameKind, B extends FrameKind>(
  map: RigidMap<A, B>, vector: FramedVectorMm<NoInfer<A>>,
): FramedVectorMm<B> {
  requireSameFrame(map.from, vector.frame)
  return vectorMm(map.to, transformDirection(map[mapMatrix], vector.value))
}
export function inverse<A extends FrameKind, B extends FrameKind>(map: RigidMap<A, B>): RigidMap<B, A> {
  return rigidMap(map.to, map.from, invertRigidMat4(map[mapMatrix]))
}
/** Apply ab first, then bc. The intermediate identity AND revision must match. */
export function compose<A extends FrameKind, B extends FrameKind, C extends FrameKind>(
  bc: RigidMap<B, C>, ab: RigidMap<A, NoInfer<B>>,
): RigidMap<A, C> {
  requireSameFrame(ab.to, bc.from)
  return rigidMap(ab.from, bc.to, multiplyMat4(bc[mapMatrix], ab[mapMatrix]))
}

/** Compatibility ingress for already-resolved world XY stock rings. This is a
 * synchronous pose-only adapter, NOT a revision-bearing planning/stock token.
 * Do not invent project identities for this legacy signature. New asynchronous
 * boundaries use FrameRef and checked maps above. Caller retains tilt/feature
 * decisions; Z is deliberately irrelevant to a planar footprint, even at the
 * identity fast path. Preserve subtract-then-rotate numerical behavior rather
 * than expanding inverse translation (lossy for large world origins). */
export function worldRingsToDisplayLocalMm(
  rings: Float64Array[], position: Readonly<Vec3>, rotZDeg: number,
): Float64Array[] {
  if (position.x === 0 && position.y === 0 && rotZDeg === 0) return rings
  const { col1, col2 } = rotationMatrixXYZ({ z: rotZDeg })
  // Recover sine from -sin in column 2 to retain signed zero as well.
  const c = col1.x, s = -col2.x
  return rings.map(ring => {
    const out = new Float64Array(ring.length)
    for (let i = 0; i < ring.length; i += 2) {
      const dx = ring[i] - position.x
      const dy = ring[i + 1] - position.y
      out[i] = dx * c + dy * s
      out[i + 1] = -dx * s + dy * c
    }
    return out
  })
}
