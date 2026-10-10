import type { Vec3 } from '../geom/geom-service'
import { computeXDir } from './xDirPolicy'
import type { PlaneFrame } from './planeMath'
import { vCross, vDot, vLength, vScale, vSub, vUnit, vAdd } from './planeMath'

const MIN_VECTOR_LENGTH = 1e-9

export type ReferencePlaneMathFailure =
  | 'non-finite-distance'
  | 'non-finite-parent-frame'
  | 'zero-parent-normal'
  | 'degenerate-parent-xdir'
  | 'non-finite-result'
  | 'non-finite-angle'

export type ReferencePlaneMathResult =
  | { ok: true; frame: PlaneFrame }
  | { ok: false; reason: ReferencePlaneMathFailure }

function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function finiteFrame(frame: PlaneFrame): boolean {
  return finiteVec(frame.origin) && finiteVec(frame.normal) && finiteVec(frame.xDir)
}

function canonicalVec(v: Vec3): Vec3 {
  return {
    x: Object.is(v.x, -0) ? 0 : v.x,
    y: Object.is(v.y, -0) ? 0 : v.y,
    z: Object.is(v.z, -0) ? 0 : v.z,
  }
}

/**
 * Construct a plane parallel to `parent` at a signed distance along the
 * parent's unflipped normal. `flipNormal` changes orientation, not location.
 * Invalid parent frames refuse by name; this function never repairs a broken
 * frame into plausible-looking geometry.
 */
export function makeOffsetPlaneFrame(
  parent: PlaneFrame,
  distance: number,
  opts: { flipNormal?: boolean; priorFrame?: PlaneFrame } = {},
): ReferencePlaneMathResult {
  if (!Number.isFinite(distance)) return { ok: false, reason: 'non-finite-distance' }
  if (!finiteFrame(parent)) return { ok: false, reason: 'non-finite-parent-frame' }

  const parentNormalLength = vLength(parent.normal)
  if (parentNormalLength < MIN_VECTOR_LENGTH) return { ok: false, reason: 'zero-parent-normal' }
  const parentNormal = vUnit(parent.normal)

  // xDir must carry a real in-plane direction. Falling back from a corrupt
  // parallel-to-normal xDir would hide bad persisted data, so reject it.
  const projectedXDir = vSub(parent.xDir, vScale(parentNormal, vDot(parent.xDir, parentNormal)))
  if (vLength(projectedXDir) < MIN_VECTOR_LENGTH) return { ok: false, reason: 'degenerate-parent-xdir' }

  const normal = opts.flipNormal === true ? vScale(parentNormal, -1) : parentNormal
  const origin = vAdd(parent.origin, vScale(parentNormal, distance))
  const xDir = computeXDir(normal, opts.priorFrame ?? parent)
  const frame = { origin: canonicalVec(origin), normal: canonicalVec(normal), xDir: canonicalVec(xDir) }
  return finiteFrame(frame) ? { ok: true, frame } : { ok: false, reason: 'non-finite-result' }
}

function checkedParent(parent: PlaneFrame): { normal: Vec3; xDir: Vec3 } | ReferencePlaneMathFailure {
  if (!finiteFrame(parent)) return 'non-finite-parent-frame'
  if (vLength(parent.normal) < MIN_VECTOR_LENGTH) return 'zero-parent-normal'
  const normal = vUnit(parent.normal)
  const xDir = vSub(parent.xDir, vScale(normal, vDot(parent.xDir, normal)))
  if (vLength(xDir) < MIN_VECTOR_LENGTH) return 'degenerate-parent-xdir'
  return { normal, xDir: vUnit(xDir) }
}

/**
 * The plane halfway between two planes, facing the way `a` does (`flipNormal`
 * turns it round; datumPlane.ts's constructionPlaneParentOrder decides which
 * parent is `a`). Parallel planes: the plane halfway across.
 * Planes that meet: the plane through their line that halves the angle
 * between them (the second plane counted facing the first one's way). One
 * rule covers both: points p with p.(na + nb) = da + db.
 */
export function makeMidplaneFrame(
  a: PlaneFrame,
  b: PlaneFrame,
  opts: { flipNormal?: boolean; priorFrame?: PlaneFrame } = {},
): ReferencePlaneMathResult {
  const pa = checkedParent(a)
  if (typeof pa === 'string') return { ok: false, reason: pa }
  const pb = checkedParent(b)
  if (typeof pb === 'string') return { ok: false, reason: pb }
  const nb = vDot(pa.normal, pb.normal) < 0 ? vScale(pb.normal, -1) : pb.normal
  const m = vAdd(pa.normal, nb)
  const mLen = vLength(m)
  const c = vDot(a.origin, pa.normal) + vDot(b.origin, nb)
  const n = vScale(m, 1 / mLen)
  // the point of the plane nearest the two origins' midpoint
  const q = vScale(vAdd(a.origin, b.origin), 0.5)
  const origin = vSub(q, vScale(n, (vDot(q, m) - c) / mLen))
  const normal = opts.flipNormal === true ? vScale(n, -1) : n
  const xDir = computeXDir(normal, opts.priorFrame ?? a)
  const frame = { origin: canonicalVec(origin), normal: canonicalVec(normal), xDir: canonicalVec(xDir) }
  return finiteFrame(frame) ? { ok: true, frame } : { ok: false, reason: 'non-finite-result' }
}

export type AngledPlaneHinge = 'x' | 'y'

/**
 * `parent` turned by `angleDeg` about a hinge line through its origin: its own
 * X axis or its own Y axis. Positive turns right-handed about the hinge (thumb
 * along the axis). The hinge stays in the new plane, so an X hinge keeps the
 * parent's X direction.
 */
export function makeAngledPlaneFrame(
  parent: PlaneFrame,
  angleDeg: number,
  hinge: AngledPlaneHinge,
  opts: { flipNormal?: boolean } = {},
): ReferencePlaneMathResult {
  if (!Number.isFinite(angleDeg)) return { ok: false, reason: 'non-finite-angle' }
  const p = checkedParent(parent)
  if (typeof p === 'string') return { ok: false, reason: p }
  const yDir = vCross(p.normal, p.xDir)
  const u = hinge === 'x' ? p.xDir : yDir
  const t = (angleDeg * Math.PI) / 180
  // Rodrigues about u, for vectors square to u (u.v = 0 for both the normal and the other in-plane axis)
  const turn = (v: Vec3): Vec3 => vAdd(vScale(v, Math.cos(t)), vScale(vCross(u, v), Math.sin(t)))
  const turned = turn(p.normal)
  const normal = opts.flipNormal === true ? vScale(turned, -1) : turned
  const xDir = hinge === 'x' ? p.xDir : turn(p.xDir)
  const frame = { origin: canonicalVec(parent.origin), normal: canonicalVec(vUnit(normal)), xDir: canonicalVec(vUnit(xDir)) }
  return finiteFrame(frame) ? { ok: true, frame } : { ok: false, reason: 'non-finite-result' }
}

/**
 * `parent` turned by `angleDeg` about an axis line (an axis datum): the new plane holds the axis.
 * At 0 deg it is the plane through the axis that faces as nearly the parent's way as the axis lets
 * it (exactly the parent when the axis lies in it); positive turns right-handed about `axis.dir`.
 * An axis along the parent's normal has no such facing, so the parent's X direction stands in.
 * The axis is the new plane's X direction, as the X hinge keeps the parent's.
 */
export function makeAxisAngledPlaneFrame(
  parent: PlaneFrame,
  axis: { origin: Vec3; dir: Vec3 },
  angleDeg: number,
  opts: { flipNormal?: boolean } = {},
): ReferencePlaneMathResult {
  if (!Number.isFinite(angleDeg)) return { ok: false, reason: 'non-finite-angle' }
  const p = checkedParent(parent)
  if (typeof p === 'string') return { ok: false, reason: p }
  if (!finiteVec(axis.origin) || !finiteVec(axis.dir) || vLength(axis.dir) < MIN_VECTOR_LENGTH) return { ok: false, reason: 'non-finite-parent-frame' }
  const u = vUnit(axis.dir)
  const square = (v: Vec3): Vec3 => vSub(v, vScale(u, vDot(v, u)))
  const facing = vLength(square(p.normal)) > 1e-6 ? square(p.normal) : square(p.xDir)
  const n0 = vUnit(facing)
  const t = (angleDeg * Math.PI) / 180
  const turned = vAdd(vScale(n0, Math.cos(t)), vScale(vCross(u, n0), Math.sin(t)))
  const normal = opts.flipNormal === true ? vScale(turned, -1) : turned
  // the axis point nearest the parent's origin
  const origin = vAdd(axis.origin, vScale(u, vDot(vSub(parent.origin, axis.origin), u)))
  const frame = { origin: canonicalVec(origin), normal: canonicalVec(vUnit(normal)), xDir: canonicalVec(u) }
  return finiteFrame(frame) ? { ok: true, frame } : { ok: false, reason: 'non-finite-result' }
}
