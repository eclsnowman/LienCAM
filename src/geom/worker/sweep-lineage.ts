/**
 * GEO-3 sweep (extrude/revolve) CONSTRUCTED-LINEAGE helpers — PURE, kernel-free.
 * ============================================================================
 * Extrude/revolve have NO kernel history (occt-wasm's BRepPrimAPI_MakePrism /
 * MakeRevol expose no *WithHistory variant — verified, STAGE0_FINDINGS gotcha
 * note). Per docs/stable-id-spec.md "lineage is constructed, not queried": the
 * profile is ours, so each side/surf face is matched to the sketch entity that
 * generated it BY CONSTRUCTION (geometry, not kernel enumeration order), and
 * caps carry the region (sketch) tag. Every function here is a pure transform
 * over plain data so the ID grammar and the geometric matching math are
 * unit-testable without the wasm kernel — and so byte-identical geometry yields
 * byte-identical IDs regardless of the kernel's ephemeral face hashes.
 *
 * ID grammar (docs/stable-id-spec.md + this WO's binding ruling 2):
 *   Extrude side face from sketch edge e:  `<F>:XTR:<srcId>:side`
 *   Extrude start/end caps (region-tagged): `<F>:XTR:<sketchId>:capStart|capEnd`
 *   Revolve face from sketch edge e:        `<F>:REV:<srcId>:surf`
 *   Revolve start/end caps (region-tagged): `<F>:REV:<sketchId>:capStart|capEnd`
 * A `#j` disambig is appended (deterministic centroid order) ONLY when a single
 * sketch entity generates more than one face (e.g. a periodic cylinder the
 * kernel split at its seam) — the common one-edge-one-face case stays clean.
 */
import type { ProfileRegion } from '../geom-service.ts'

export type Vec3T = [number, number, number]
export type P2 = [number, number]
export type ProfileSeg = ProfileRegion['loops'][number][number]

// ---- tiny vector algebra (pure) -------------------------------------------
export function sub(a: Vec3T, b: Vec3T): Vec3T { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
export function add(a: Vec3T, b: Vec3T): Vec3T { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
export function scale(a: Vec3T, s: number): Vec3T { return [a[0] * s, a[1] * s, a[2] * s] }
export function dot(a: Vec3T, b: Vec3T): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
export function cross(a: Vec3T, b: Vec3T): Vec3T {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
export function len(a: Vec3T): number { return Math.hypot(a[0], a[1], a[2]) }
export function normalize(a: Vec3T): Vec3T {
  const l = len(a)
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}

// ---- plane basis + lifting -------------------------------------------------
export interface PlaneBasis {
  origin: Vec3T
  xDir: Vec3T
  yDir: Vec3T
  normal: Vec3T
}

/** Orthonormal right-handed basis from a ProfileRegion plane. yDir is derived
 *  as normal x xDir (both re-orthonormalized) so a slightly non-orthogonal
 *  input plane still lifts consistently. */
export function planeBasis(plane: ProfileRegion['plane']): PlaneBasis {
  const origin: Vec3T = [plane.origin.x, plane.origin.y, plane.origin.z]
  const normal = normalize([plane.normal.x, plane.normal.y, plane.normal.z])
  let xDir = normalize([plane.xDir.x, plane.xDir.y, plane.xDir.z])
  // Re-orthonormalize xDir against normal (Gram-Schmidt) so the basis is exact.
  xDir = normalize(sub(xDir, scale(normal, dot(xDir, normal))))
  const yDir = normalize(cross(normal, xDir))
  return { origin, xDir, yDir, normal }
}

/** Lift a 2D sketch-plane point to 3D model space. */
export function lift(b: PlaneBasis, p: P2): Vec3T {
  return add(b.origin, add(scale(b.xDir, p[0]), scale(b.yDir, p[1])))
}

// ---- per-segment representative point --------------------------------------
/** A representative 2D point on a profile segment: the midpoint of a line, or
 *  the mid-angle point of an arc (respecting ccw). For a full circle any single
 *  circle point serves — it still lands on the generated face. */
export function segRep2d(seg: ProfileSeg): P2 {
  if (seg.kind === 'line') {
    return [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2]
  }
  let sweep = seg.a1 - seg.a0
  if (seg.ccw && sweep <= 0) sweep += Math.PI * 2
  if (!seg.ccw && sweep >= 0) sweep -= Math.PI * 2
  const mid = seg.a0 + sweep / 2
  return [seg.c[0] + seg.r * Math.cos(mid), seg.c[1] + seg.r * Math.sin(mid)]
}

/** 2D endpoints of a profile/path segment (sketch-plane coords). */
export function segEndpoints2d(seg: ProfileSeg): { start: P2; end: P2 } {
  if (seg.kind === 'line') return { start: seg.a, end: seg.b }
  const s: P2 = [seg.c[0] + seg.r * Math.cos(seg.a0), seg.c[1] + seg.r * Math.sin(seg.a0)]
  const e: P2 = [seg.c[0] + seg.r * Math.cos(seg.a1), seg.c[1] + seg.r * Math.sin(seg.a1)]
  return { start: s, end: e }
}

/** True if a profile loop closes end-to-start within tol (each segment's end
 *  meets the next segment's start, last meets first). A single open segment
 *  ("loop" that cannot bound a face) returns false -> callers raise OPEN_PROFILE. */
export function loopClosed(loop: ProfileSeg[], tol = 1e-6): boolean {
  if (loop.length === 0) return false
  const d2 = (p: P2, q: P2): number => Math.hypot(p[0] - q[0], p[1] - q[1])
  for (let i = 0; i < loop.length; i++) {
    const cur = segEndpoints2d(loop[i])
    const nxt = segEndpoints2d(loop[(i + 1) % loop.length])
    if (d2(cur.end, nxt.start) > tol) return false
  }
  return true
}

/** Per-segment 2D geometry a sweep needs: endpoints, midpoint, and unit
 *  tangents (in the travel direction) at start/mid/end. */
export interface SegGeom2D { start: P2; end: P2; mid: P2; tStart: P2; tMid: P2; tEnd: P2 }
export function segGeom2d(seg: ProfileSeg): SegGeom2D {
  const norm2 = (d: P2): P2 => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l] }
  if (seg.kind === 'line') {
    const t = norm2([seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]])
    return { start: seg.a, end: seg.b, mid: [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2], tStart: t, tMid: t, tEnd: t }
  }
  let sweep = seg.a1 - seg.a0
  if (seg.ccw && sweep <= 0) sweep += Math.PI * 2
  if (!seg.ccw && sweep >= 0) sweep -= Math.PI * 2
  const pt = (ang: number): P2 => [seg.c[0] + seg.r * Math.cos(ang), seg.c[1] + seg.r * Math.sin(ang)]
  const tan = (ang: number): P2 => {
    const d: P2 = [-Math.sin(ang), Math.cos(ang)]
    return norm2(sweep >= 0 ? d : [-d[0], -d[1]])
  }
  return {
    start: pt(seg.a0), end: pt(seg.a0 + sweep), mid: pt(seg.a0 + sweep / 2),
    tStart: tan(seg.a0), tMid: tan(seg.a0 + sweep / 2), tEnd: tan(seg.a0 + sweep),
  }
}

/** Rotate a 3D point about an axis (origin + unit dir) by angleRad — Rodrigues. */
export function rotateAboutAxis(p: Vec3T, axisOrigin: Vec3T, axisDir: Vec3T, angleRad: number): Vec3T {
  const k = normalize(axisDir)
  const rel = sub(p, axisOrigin)
  const c = Math.cos(angleRad)
  const s = Math.sin(angleRad)
  // rel*cos + (k x rel)*sin + k*(k.rel)*(1-cos)
  const term1 = scale(rel, c)
  const term2 = scale(cross(k, rel), s)
  const term3 = scale(k, dot(k, rel) * (1 - c))
  return add(axisOrigin, add(term1, add(term2, term3)))
}

// ---- partial-revolve cap ordering (GEO-3 R1) -------------------------------
/**
 * Reference points that order a partial revolve's two angular caps: the START
 * cap lies at theta=0 (in the original profile plane), the END cap at theta.
 *
 * `profileRep` MUST be a representative point of the profile at theta=0 (e.g.
 * the mean of the lifted segment midpoints) — a point that is guaranteed OFF
 * the revolve axis for any valid revolve (a profile crossing the axis has no
 * solid of revolution). The two references are that point and that point
 * rotated by the sweep angle. Distance-to-start vs distance-to-end then orders
 * the caps GEOMETRICALLY.
 *
 * This deliberately does NOT derive the reference from the profile-plane origin
 * (the pre-R1 code did: `basis.origin - axisOrigin`). When the plane origin lies
 * on the axis — true for the canonical xzPlane fixture — that difference has a
 * ZERO perpendicular component, so the azimuth reference collapsed and every cap
 * tied at score 0, letting kernel face enumeration silently decide start/end
 * (GEO-3 R1 audit finding). A profile-derived reference cannot degenerate.
 */
export function capOrderRefs(
  profileRep: Vec3T, axisOrigin: Vec3T, axisDir: Vec3T, thetaRad: number,
): { startRef: Vec3T; endRef: Vec3T } {
  return { startRef: profileRep, endRef: rotateAboutAxis(profileRep, axisOrigin, axisDir, thetaRad) }
}

/**
 * Signed cap-ordering score for a cap face centroid: NEGATIVE for the start cap
 * (nearer `startRef`), POSITIVE for the end cap (nearer `endRef`). Feed as the
 * `capScore` to #assignSweptFaceIds so its ascending sort puts capStart (idx 0)
 * before capEnd — no atan2 wrap, no degeneracy when the plane origin is on-axis.
 */
export function capOrderScore(centroid: Vec3T, startRef: Vec3T, endRef: Vec3T): number {
  return len(sub(centroid, startRef)) - len(sub(centroid, endRef))
}

// ---- axis derivation (BK-14): analytic, from three points on a circle ------
/** Deterministic sign for an axis LINE: make the largest-magnitude component
 *  non-negative, ties broken by the earliest axis. So [0,0,-1] and [0,0,1]
 *  canonicalize to the same [0,0,1] (a cylinder/cone/torus axis is undirected). */
export function canonicalAxis(a: Vec3T): Vec3T {
  let idx = 0
  let best = Math.abs(a[0])
  for (let i = 1; i < 3; i++) {
    if (Math.abs(a[i]) > best + 1e-12) { best = Math.abs(a[i]); idx = i }
  }
  // `+ 0` normalizes -0 to 0 so a flipped axis never carries -0 components.
  return a[idx] < 0 ? [-a[0] + 0, -a[1] + 0, -a[2] + 0] : [a[0] + 0, a[1] + 0, a[2] + 0]
}

/**
 * Axis of revolution from three DISTINCT points sampled along a latitude circle
 * of an axial surface (same V, three U). A cylinder/cone/torus latitude circle
 * lies in a plane perpendicular to the axis, so the plane normal IS the axis —
 * exact and analytic (no reliance on the tilted surface normal, which is why
 * the GEO-2 two-normal-cross shortcut was cylinder-only). Returns undefined if
 * the three points are (near-)collinear (degenerate sample).
 */
export function axisFromThreeCirclePoints(p0: Vec3T, p1: Vec3T, p2: Vec3T): Vec3T | undefined {
  const n = cross(sub(p1, p0), sub(p2, p0))
  if (len(n) < 1e-9) return undefined
  return canonicalAxis(normalize(n))
}

// ---- placement frame (GEO-5 sweep) ----------------------------------------
/**
 * Orthonormal right-handed basis at `origin` with the given `normal`, choosing
 * an in-plane xDir close to `xHint` (projected off the normal). Used to RE-PLACE
 * a sweep profile at the spine start with its plane perpendicular to the spine's
 * start tangent — the placement `pipe()` (BRepOffsetAPI_MakePipe) requires
 * (verified empirically: a profile whose plane normal is NOT the spine start
 * tangent yields a degenerate zero-volume result). The in-plane rotation is
 * arbitrary for a swept solid's VOLUME (rigid placement preserves area), and the
 * lineage rep points are placed in this same frame so they stay consistent.
 */
export function frameFromNormal(origin: Vec3T, normal: Vec3T, xHint: Vec3T): PlaneBasis {
  const n = normalize(normal)
  let x = sub(xHint, scale(n, dot(xHint, n)))
  if (len(x) < 1e-9) {
    // xHint parallel to normal — fall back to any world axis not parallel to n.
    const alt: Vec3T = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    x = sub(alt, scale(n, dot(alt, n)))
  }
  const xDir = normalize(x)
  const yDir = normalize(cross(n, xDir))
  return { origin, xDir, yDir, normal: n }
}

/** Reflect a point through the plane (planeOrigin, unit planeNormal). */
export function reflectPoint(p: Vec3T, planeOrigin: Vec3T, planeNormalUnit: Vec3T): Vec3T {
  const d = dot(sub(p, planeOrigin), planeNormalUnit)
  return sub(p, scale(planeNormalUnit, 2 * d))
}

/** Reflect a (free) vector across the plane with unit normal — flips the normal
 *  component; used to predict an instance face's normal under a mirror pattern. */
export function reflectVector(v: Vec3T, planeNormalUnit: Vec3T): Vec3T {
  return sub(v, scale(planeNormalUnit, 2 * dot(v, planeNormalUnit)))
}

// ---- ID grammar ------------------------------------------------------------
export function extrudeSideId(featureId: string, srcId: string): string {
  return `${featureId}:XTR:${srcId}:side`
}

/** Sweep side face from profile entity `profSrc` swept along path entity
 *  `pathSrc` (docs/stable-id-spec.md opCode SWP; ruling 4/criterion 1 —
 *  "derived from profile srcIds x path srcIds"). */
export function sweepSideId(featureId: string, profSrc: string, pathSrc: string): string {
  return `${featureId}:SWP:${profSrc}x${pathSrc}:side`
}
export function sweepCapId(featureId: string, sketchId: string, which: 'start' | 'end'): string {
  return `${featureId}:SWP:${sketchId}:cap${which === 'start' ? 'Start' : 'End'}`
}

/** Loft face grammar (opCode LFT). Side wall spanning ordered sections i..i+1
 *  from profile entity `srcId`; caps at the first/last section. */
export function loftSideId(featureId: string, srcId: string, band: number): string {
  return `${featureId}:LFT:${srcId}:s${band}:side`
}
export function loftCapId(featureId: string, sketchId: string, which: 'start' | 'end'): string {
  return `${featureId}:LFT:${sketchId}:cap${which === 'start' ? 'Start' : 'End'}`
}

/** Hole face grammar (opCode HOL; criterion 3 — derived from featureId + point
 *  index, stable across reruns). `seg` names the sub-face role (wall/floor). */
export function holeFaceId(featureId: string, pointIndex: number, seg: string): string {
  return `${featureId}:HOL:i${pointIndex}:${seg}`
}

/** Body-pattern instance sub-shape id (docs/stable-id-spec.md; ruling 4):
 *  `<featureId>:PAT:i<n>:<childId>` — NEVER enumeration order. */
export function patternInstanceId(featureId: string, n: number, childId: string): string {
  return `${featureId}:PAT:i${n}:${childId}`
}

/** Overlap-merged pattern face id (GEO-5-R1.3; stable-id-spec no-silent-gaps,
 *  same family as GEO-4-R1.4's shell catch-all). When overlapping instances fuse
 *  coplanar walls into ONE result face, that face is named from the CONTRIBUTING
 *  instance ids: `<featureId>:PAT:merge:(i<n>:<childId>|...)`, entries sorted so
 *  the id is byte-identical across runs regardless of kernel enumeration order. */
export function patternMergeId(featureId: string, contributors: Array<{ n: number; childId: string }>): string {
  const parts = contributors.map((c) => `i${c.n}:${c.childId}`).sort()
  return `${featureId}:PAT:merge:(${parts.join('|')})`
}
export function extrudeCapId(featureId: string, sketchId: string, which: 'start' | 'end'): string {
  return `${featureId}:XTR:${sketchId}:cap${which === 'start' ? 'Start' : 'End'}`
}
export function revolveSurfId(featureId: string, srcId: string): string {
  return `${featureId}:REV:${srcId}:surf`
}
export function revolveCapId(featureId: string, sketchId: string, which: 'start' | 'end'): string {
  return `${featureId}:REV:${sketchId}:cap${which === 'start' ? 'Start' : 'End'}`
}

// ---- right-corner chain sweep (WO-3229) -------------------------------------
/**
 * A planar line/arc path swept with explicit right-miter corners. On a planar
 * path the transported profile frame only ever rotates about the path plane
 * normal N, so a profile point is fully described by two numbers taken in the
 * START frame: `q`, its offset along the left normal (N x tangent), and `h`, its
 * offset along N. Everywhere along the chain that point sits at
 * centerline(s) + q * leftNormal(s) + h * N. Corners are cut by the bisector
 * plane of the two tangents, so the inner side of a left turn (q > 0) loses
 * q * tan(phi / 2) on each leg; an arc at offset q runs on radius R - sign * q.
 * Everything below is pure 2D math in path-plane coordinates.
 */
export interface ChainLeg {
  srcId: string
  kind: 'line' | 'arc'
  start: P2
  end: P2
  tStart: P2
  tEnd: P2
  /** line: length; arc: R * |sweep| */
  length: number
  /** arc only: centre, radius, start angle and signed sweep (ccw positive) */
  c?: P2
  r?: number
  a0?: number
  sweep?: number
  /** signed corner turn into this leg (0 at the chain start) and out of it */
  turnIn: number
  turnOut: number
}

/** Signed angle (radians, ccw positive) that turns unit 2D vector a onto b. */
export function signedTurn(a: P2, b: P2): number {
  return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])
}

/** Left normal of a 2D travel direction (ccw by 90 degrees). */
export function leftNormal2d(t: P2): P2 { return [-t[1], t[0]] }

/** Path segments as legs with their corner turns. Pure. */
export function chainLegs(segs: ProfileSeg[]): ChainLeg[] {
  const legs: ChainLeg[] = segs.map((s) => {
    const g = segGeom2d(s)
    if (s.kind === 'line') {
      return { srcId: s.srcId, kind: 'line', start: g.start, end: g.end, tStart: g.tStart, tEnd: g.tEnd, length: Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]), turnIn: 0, turnOut: 0 }
    }
    let sweep = s.a1 - s.a0
    if (s.ccw && sweep <= 0) sweep += Math.PI * 2
    if (!s.ccw && sweep >= 0) sweep -= Math.PI * 2
    return { srcId: s.srcId, kind: 'arc', start: g.start, end: g.end, tStart: g.tStart, tEnd: g.tEnd, length: s.r * Math.abs(sweep), c: s.c, r: s.r, a0: s.a0, sweep, turnIn: 0, turnOut: 0 }
  })
  for (let i = 0; i + 1 < legs.length; i++) {
    const phi = signedTurn(legs[i].tEnd, legs[i + 1].tStart)
    // A tangent joint is exactly straight: keep it 0 so tangent chains stay exact.
    const turn = Math.abs(phi) < 1e-12 ? 0 : phi
    legs[i].turnOut = turn
    legs[i + 1].turnIn = turn
  }
  return legs
}

/** Total signed turn from the chain start to the START of leg `i`. */
export function turnBeforeLeg(legs: ChainLeg[], i: number): number {
  let a = 0
  for (let j = 0; j < i; j++) a += (legs[j].kind === 'arc' ? legs[j].sweep! : 0) + legs[j].turnOut
  return a
}

/**
 * The part of leg `leg` that the profile point at left offset `q` sweeps, as a
 * parameter span [u0, u1]: distance along a line, or unsigned angle from the
 * arc start along an arc. A line's ends are where the corner bisector planes
 * (or the perpendicular end planes at the chain ends) cross its offset line.
 * Arcs only ever meet tangent joints here (chainDefect refuses an arc at a
 * corner), so an arc's span is its whole sweep. Returns null for an arc whose
 * offset radius is not positive, or an arc with a corner.
 */
export function legSpanAt(leg: ChainLeg, q: number): { u0: number; u1: number } | null {
  if (leg.kind === 'line') {
    return { u0: q * Math.tan(leg.turnIn / 2), u1: leg.length - q * Math.tan(leg.turnOut / 2) }
  }
  if (leg.turnIn !== 0 || leg.turnOut !== 0) return null
  if (!(leg.r! - Math.sign(leg.sweep!) * q > 0)) return null
  return { u0: 0, u1: Math.abs(leg.sweep!) }
}

/** 2D point and unit tangent at parameter u (see legSpanAt) on the leg centreline. */
export function legPointAt(leg: ChainLeg, u: number): { p: P2; t: P2 } {
  if (leg.kind === 'line') {
    return { p: [leg.start[0] + leg.tStart[0] * u, leg.start[1] + leg.tStart[1] * u], t: leg.tStart }
  }
  const sigma = Math.sign(leg.sweep!)
  const a = leg.a0! + sigma * u
  const t: P2 = sigma > 0 ? [-Math.sin(a), Math.cos(a)] : [Math.sin(a), -Math.cos(a)]
  return { p: [leg.c![0] + leg.r! * Math.cos(a), leg.c![1] + leg.r! * Math.sin(a)], t }
}

/** Where the profile point (q, h) sits at parameter u of a leg, in 3D. */
export function chainPoint3d(basis: PlaneBasis, leg: ChainLeg, u: number, q: number, h: number): Vec3T {
  const { p, t } = legPointAt(leg, u)
  const n = leftNormal2d(t)
  return add(lift(basis, [p[0] + q * n[0], p[1] + q * n[1]]), scale(basis.normal, h))
}

/** The profile point (q, h) at the mid-span of a leg: a point on exactly the
 *  side face that point's profile entity generates along that leg. */
export function chainRepPoint(basis: PlaneBasis, leg: ChainLeg, q: number, h: number): Vec3T | null {
  const span = legSpanAt(leg, q)
  if (!span) return null
  return chainPoint3d(basis, leg, (span.u0 + span.u1) / 2, q, h)
}

/** Offset range [qMin, qMax] that a profile loop covers along `g`, where
 *  q(p2) = p2 . g is the left-normal offset of a profile 2D point. Lines take
 *  their endpoints; arcs add the extreme angles that lie inside their sweep. */
export function profileOffsetRange(loop: ProfileSeg[], g: P2): { qMin: number; qMax: number } {
  let qMin = Infinity, qMax = -Infinity
  const take = (p: P2): void => { const q = p[0] * g[0] + p[1] * g[1]; qMin = Math.min(qMin, q); qMax = Math.max(qMax, q) }
  for (const s of loop) {
    if (s.kind === 'line') { take(s.a); take(s.b); continue }
    let sweep = s.a1 - s.a0
    if (s.ccw && sweep <= 0) sweep += Math.PI * 2
    if (!s.ccw && sweep >= 0) sweep -= Math.PI * 2
    const at = (a: number): P2 => [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]
    take(at(s.a0)); take(at(s.a0 + sweep))
    const star = Math.atan2(g[1], g[0])
    for (const cand of [star, star + Math.PI]) {
      const u = ((cand - s.a0) * Math.sign(sweep)) % (Math.PI * 2)
      const uu = u < 0 ? u + Math.PI * 2 : u
      if (uu <= Math.abs(sweep)) take(at(cand))
    }
  }
  return { qMin, qMax }
}

/**
 * Why a chain cannot give one correct right-corner solid, or null. Each reason
 * is a geometric fact of the request, not a threshold: a zero-length segment,
 * a gap between segments, a corner that reverses travel (its bisector plane
 * collapses), an arc whose inner offset radius reaches zero, or a leg whose two
 * cut planes cross inside the profile so the leg turns inside out.
 */
export function chainDefect(legs: ChainLeg[], range: { qMin: number; qMax: number }, tol = 1e-6): string | null {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    if (!(leg.length > tol)) return `path segment ${leg.srcId} has zero length`
    if (i + 1 < legs.length) {
      const nxt = legs[i + 1]
      if (Math.hypot(leg.end[0] - nxt.start[0], leg.end[1] - nxt.start[1]) > tol) {
        return `path segments ${leg.srcId} and ${nxt.srcId} do not connect`
      }
      if (leg.turnOut !== 0 && (leg.kind === 'arc' || nxt.kind === 'arc')) {
        const [x, y] = [leg.kind === 'arc' ? `arc ${leg.srcId}` : leg.srcId, nxt.kind === 'arc' ? `arc ${nxt.srcId}` : nxt.srcId]
        return `${x} meets ${y} at a corner; the kernel's right-corner joint at an arc is not a true mitre, so only lines may meet at corners (join an arc tangentially)`
      }
      if (Math.PI - Math.abs(leg.turnOut) < 1e-9) {
        return `the path reverses direction between ${leg.srcId} and ${nxt.srcId}, so the swept profile folds back onto itself`
      }
    }
    const qs = [range.qMin, (range.qMin + range.qMax) / 2, range.qMax]
    for (const q of qs) {
      if (leg.kind === 'arc' && !(leg.r! - Math.sign(leg.sweep!) * q > tol)) {
        return `the profile reaches past the centre of arc ${leg.srcId} (radius ${round3(leg.r!)} mm), so the swept solid would cross itself`
      }
      const span = legSpanAt(leg, q)
      if (!span || !(span.u1 - span.u0 > 1e-9)) {
        return `path segment ${leg.srcId} is too short for the profile at its corners, so the mitred solid would turn inside out`
      }
    }
  }
  return null
}

function round3(v: number): number { return Math.round(v * 1000) / 1000 }
