/**
 * GEO-6 Defeature core — kernel-facing feature recognition + remove/heal.
 * =====================================================================
 * PURE occt-wasm layer: every function takes the live `OcctKernel` and speaks
 * in kernel `ShapeHandle`s + face HASHES + geometry. It NEVER touches stable
 * ids, the BodyRecord map, or the frozen contract — the engine (geom-engine.ts)
 * is the sole translator between these hashes and stable ids. Keeping this file
 * hash-only makes it directly testable against the real kernel and independent
 * of the id system.
 *
 * Provenance — every kernel recipe here is the MEASURED-and-proven primitive
 * stack from the GEO-6S spike (spike/defeature/, docs/3d/DEFEATURE-SPIKE-
 * FINDINGS.md, coordination/reports/GEO-6S.report.json):
 *   - SELECTIVE heal = probe 07 (07-selective-hole.mjs): drop only the feature
 *     faces, `removeHolesFromFace` only the feature's openings on the host slab,
 *     keep every other face byte-identical, `sewAndSolidify`, then ALWAYS run
 *     the reverse-if-negative orientation-normalize pass (Q3 finding — boolean-
 *     derived faces sew inverted without it), verify isValid + volume.
 *   - planar fillet / chamfer heal = probe 02 strategy C: untrim the planar
 *     neighbours to their sharp bbox bounds via `makeFaceOnSurface`, drop the
 *     band, sew (surface EXTENSION is required — plain drop+sew is invalid).
 *   - `defeature()` (BRepAlgoAPI_RemoveFeatures) is BROKEN in this wasm on every
 *     class (6/6) — never called here.
 *
 * GEO-6X5 (BK-89) REVISES the GEO-6S verdict on the curved-neighbour class.
 * GEO-6S concluded that class was "unsolved with the exposed kernel primitives".
 * That is FALSE, and GEO-6X4 proved why: the wall was never the math, it was a
 * kernel-API boundary. `makeFaceOnSurface()` returns a silent zero-area face on a
 * non-planar support because it cannot build the pcurve; `fixShape()` supplies it.
 * With that one call a bounded sub-class IS reconstructable, exactly and cheaply.
 *
 * What is true now:
 *   - The BOUNDED ANALYTIC BLEND-RIBBON class (a torus of minor radius r,
 *     G1-chained to cylinders of radius r, capped by cone runouts, with walls =
 *     one cylinder + one perpendicular end plane + two tangent side planes + four
 *     concurrent chamfer planes) is RECOGNIZED and RECONSTRUCTED to its sharp
 *     corner: `analyzeBlendRibbon` solves it, `rebuildBlendWalls` rebuilds it.
 *     Proven on Tray.step face #223 (GEO-6X4 probe; defeature-blend-ribbon.test.ts).
 *   - EVERYTHING else curved — variable-radius blends, spherical caps, chained
 *     multi-torus ribbons, non-concurrent chamfers, non-cone runouts, and the
 *     curved-neighbour fillet BAND below — is still RECOGNIZED and REFUSED
 *     STRUCTURED (named gate + face set), never crashed, never approximated,
 *     never sewn into a broken solid. Q-8: "figure out the math to make it work,
 *     and do it" — done for the class where the math closes, refused where it does not.
 */
import type { OcctKernel, ShapeHandle, SurfaceKind, CurveKind, NurbsCurveData } from 'occt-wasm'

/** hashCode upper bound — matches geom-engine.ts HM and the spike. */
export const HM = 1 << 30

export interface Vec3 { x: number; y: number; z: number }
export interface BBox { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number }

/** Everything the recognizer needs about one face, read once up front. */
export interface FaceRec {
  handle: ShapeHandle
  hash: number
  type: SurfaceKind
  /** surface (area-weighted) centre of mass — a point ON the surface. */
  centroid: Vec3
  /** representative unit normal at the UV midpoint. */
  normal: Vec3
  area: number
  bbox: BBox
  /** cylinder radius (getFaceCylinderData) when type === 'cylinder'. */
  radius?: number
  /** best-effort unit axis for cylinder/cone/torus (two-normal cross). */
  axis?: Vec3
  /** angular U-span (radians) for a cylinder — ~2pi full, <pi partial band. */
  uSpan?: number
  /** GEO-7-R1: in-plane extents (mm) of a PLANAR face's uv-bounding box, i.e.
   *  its size in the plane's own frame. Rotation-INVARIANT (unlike the world-axis
   *  `bbox`), so the chamfer thin-strip aspect gate holds at any orientation.
   *  `major` >= `minor`; undefined for non-planar faces or when uvBounds fails. */
  planeExtent?: { major: number; minor: number }
  /** inner (hole) loop count = wireCount - 1. */
  innerLoops: number
  /** adjacent face hashes (k.adjacentFaces). */
  neighbours: number[]
}

/** One opening (inner loop) on a planar host face. */
export interface HostLoop {
  hostHash: number
  /** index among the host's INNER wires (getSubShapes('wire') order minus the
   *  outer wire) — the exact form removeHolesFromFace() consumes. */
  loopIndex: number
  centerX: number
  centerY: number
  centerZ: number
  spanX: number
  spanY: number
  /** number of edges in the loop wire — a drilled hole is 1 circle edge; a
   *  rounded-rect pocket rim is many (lines + corner arcs). */
  edgeCount: number
}

export type FeatureType =
  | 'throughHole'
  | 'blindHole'
  | 'counterboreStack'
  | 'pocket'
  | 'engravedText'
  | 'boss'
  | 'filletPlanar'
  | 'chamferPlanar'
  | 'filletCurvedCorner'
  | 'sliver'

/** A recognized feature, hash-only. `removable:false` carries `refuseReason`. */
export interface RecognizedFeature {
  /** deterministic geometry-derived local key (NOT a stable id). */
  key: string
  type: FeatureType
  /** feature faces to DROP entirely (walls, floors, cones, bands, boss faces). */
  dropHashes: number[]
  /** planar-neighbour faces to untrim to their sharp bbox bounds (fillet/chamfer). */
  untrimHashes: number[]
  /** host slab openings to close via removeHolesFromFace. */
  hostRemovals: Array<{ hostHash: number; loopIndex: number }>
  /** neighbour face hashes preserved (lineage source for CAM rebinding). */
  neighbourHashes: number[]
  /** signed material effect of removal: 'add' fills a void (hole/pocket),
   *  'remove' deletes a protrusion (boss). Sign of the volume delta. */
  effect: 'add' | 'remove'
  removable: boolean
  refuseReason?: string
  /** measured parameters exposed for rule queries + the UI (axis/radius/depth…). */
  params: Record<string, number | string>
  /** geometry fingerprint used to RE-FIND this feature on regen after upstream
   *  edits (hashes are ephemeral; geometry is not). */
  fingerprint: { cx: number; cy: number; cz: number; nx: number; ny: number; nz: number; kind: string }
  /** GEO-7: general (tilted) planar-neighbour band. When present, the heal
   *  extends `planeA`/`planeB` to their plane-plane intersection line instead of
   *  the axis-aligned bbox rectangle. Absent for the axis-aligned bbox path
   *  (which stays byte-identical) and for every non-band feature. */
  untrimPlan?: UntrimPlan
  /** GEO-6X5: analytic blend-ribbon (curved-neighbour) reconstruction plan. Present
   *  only on an IN-CLASS `filletCurvedCorner`; its presence is what makes the feature
   *  removable. Carries the fully-solved sharp geometry so the heal never re-solves. */
  blendPlan?: BlendRibbonPlan
}

/**
 * GEO-6X5 (adopting GEO-6X4 Path C): the BOUNDED analytic blend-ribbon class.
 *
 * A torus of minor radius r, G1-chained to fillet cylinders of the SAME radius r
 * (the "ribbon"), capped at each end by a cone runout. Its walls are exactly:
 * one cylinder (the channel floor), one end plane perpendicular to that cylinder's
 * axis, two side planes tangent to the cylinder, and four chamfer planes that are
 * CONCURRENT with the end/side planes at the two corner points.
 *
 * The ribbon is NOT closed under G1 chaining (GEO-6X4 F3): removing the torus alone
 * is geometrically meaningless, and the cone runouts are not tangent to it, so they
 * cannot be re-trimmed and must be removed too. Minimal consistent removal = 5 faces
 * (3 ribbon + 2 caps); 8 wall faces are rebuilt. Anything outside this class — variable
 * radius, spherical caps, non-concurrent chamfers, non-cone runouts, multi-torus chains
 * — REFUSES STRUCTURED. It is never approximated.
 */
export interface BlendRibbonPlan {
  /** the seed torus (dropHashes[0]). */
  torusHash: number
  /** the blend's minor radius r — every ribbon cylinder has exactly this radius. */
  blendRadius: number
  /** ribbon (torus + 2 fillet cylinders) + the 2 cone runout caps: the faces DROPPED. */
  removeHashes: number[]
  /** the 8 wall faces REBUILT to the sharp corner. */
  wallHashes: number[]
  cylinderHash: number
  endPlaneHash: number
  /** centre of the sharp arc = cylinder axis pierced at the end plane. */
  arcCenter: Vec3
  /** the sharp arc's third point, on the far side of the axis from the corners. */
  arcDeep: Vec3
  /** the two runout corners, ordered by a geometry-derived key (determinism). */
  corners: BlendCorner[]
}

/** One end of the blend ribbon: its cone cap and the sharp points that replace it. */
export interface BlendCorner {
  capHash: number
  ribCylHash: number
  sideHash: number
  /** the chamfer plane over the SIDE plane. */
  overSideHash: number
  /** the chamfer plane over the END plane. */
  overEndHash: number
  /** tangency point: closed-form orthogonal projection of `arcCenter` onto the side
   *  plane. The (cylinder, sidePlane, endPlane) triple is SINGULAR here — never solve it. */
  tangency: Vec3
  /** corner point: the transversal (endPlane, sidePlane, chamferPlane) triple point. */
  corner: Vec3
  /** the runout cone's apex (a degenerate edge's vertex) — it stays put. */
  apex: Vec3
  /** |det| of the transversal solve, and its residual — recorded, never used as the guard. */
  det: number
  residual: number
  /** distance from `corner` to the FOURTH (over-end) chamfer plane: the independent
   *  quadruple-concurrency cross-check that actually bounds the class. */
  concurrency: number
  /** Survivor endpoints: the far end of each boundary edge that keeps its position while
   *  the near end migrates to the sharp corner. Resolved (and proven unique) at RECOGNIZE
   *  time so `removable` never over-promises what the heal can build. */
  farCyl: Vec3
  farSide: Vec3
  farLip: Vec3
}

/** GEO-7 plane-plane untrim plan for a tilted planar-neighbour fillet/chamfer band. */
export interface UntrimPlan {
  /** the two planar neighbours extended to their shared plane-plane intersection
   *  line (sorted: planeA < planeB). */
  planeA: number
  planeB: number
  /** the band face being dropped — its shared edge with each neighbour is the
   *  boundary that gets extended to the sharp line. */
  bandHash: number
  /** remaining planar neighbours (the band's END faces, where the fillet/chamfer
   *  rounded a single corner). Each is restored by extending the two boundary
   *  edges flanking the removed notch to their in-plane intersection (the sharp
   *  corner = where the sharp edge L meets the end plane). Works at any
   *  orientation — no axis-alignment assumed. */
  endFaces: number[]
}

// ---------- vec helpers ----------
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const norm = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
function vClose(a: Vec3, b: Vec3, t = 1e-4): boolean { return Math.abs(a.x - b.x) < t && Math.abs(a.y - b.y) < t && Math.abs(a.z - b.z) < t }
/** true if two directions are (anti)parallel within tolerance. */
function parallelDir(a: Vec3, b: Vec3): boolean { return Math.abs(Math.abs(dot(unit(a), unit(b))) - 1) < 1e-3 }
function unit(a: Vec3): Vec3 { const l = norm(a); return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l } }
/** perpendicular distance from point p to the line (lp, dir=unit). */
function perpDistPointToLine(p: Vec3, lp: Vec3, dir: Vec3): number {
  const d = sub(p, lp); const along = dot(d, dir)
  return norm({ x: d.x - along * dir.x, y: d.y - along * dir.y, z: d.z - along * dir.z })
}
function round(v: number, d = 4): number { const p = 10 ** d; return Number.isFinite(v) ? Math.round(v * p) / p : v }
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// ---------- GEO-6X5: analytic surface frames (sampled, orientation-free) ----------
//
// occt-wasm exposes NO analytic surface getters beyond getFaceCylinderData ->
// { radius }. There is no plane origin/normal, no cylinder axis, no torus getter.
// Every frame below is therefore DERIVED from `pointOnSurface(f,u,v)`, which returns
// the pure geometric surface point and is immune to the face-orientation flips that
// make `surfaceNormal` unreliable for this purpose (GEO-6X4 probe lib.mjs). FaceRec's
// `normal`/`axis` are UV-midpoint probes good enough for the band recognizers; the
// blend-ribbon solve needs exact frames, so it re-derives them here.

export interface PlaneFrame { kind: 'plane'; point: Vec3; normal: Vec3; d: number }
export interface CylFrame { kind: 'cylinder'; axisPoint: Vec3; axisDir: Vec3; radius: number; uSpan: number }
export interface TorusFrame { kind: 'torus'; center: Vec3; axisDir: Vec3; majorR: number; minorR: number; frameConsistent: boolean }
export type AnalyticFrame = PlaneFrame | CylFrame | TorusFrame

/** Circumcenter of 3 non-collinear 3D points (exact circle centre). */
function circumcenter(p1: Vec3, p2: Vec3, p3: Vec3): Vec3 | null {
  const a = sub(p1, p3), b = sub(p2, p3)
  const axb = cross(a, b)
  const den = 2 * dot(axb, axb)
  if (den < 1e-20) return null
  const la = dot(a, a), lb = dot(b, b)
  const num = cross(sub(scale(b, la), scale(a, lb)), axb)
  return add(p3, scale(num, 1 / den))
}

function planeFrame(k: OcctKernel, f: ShapeHandle): PlaneFrame | null {
  const uv = safeUv(k, f)
  if (!uv) return null
  const u0 = (uv.uMin + uv.uMax) / 2, v0 = (uv.vMin + uv.vMax) / 2
  const hu = Math.max((uv.uMax - uv.uMin) * 0.25, 1e-3)
  const hv = Math.max((uv.vMax - uv.vMin) * 0.25, 1e-3)
  try {
    const P = k.pointOnSurface(f, u0, v0)
    const Pu = k.pointOnSurface(f, u0 + hu, v0)
    const Pv = k.pointOnSurface(f, u0, v0 + hv)
    const n = unit(cross(sub(Pu, P), sub(Pv, P)))
    if (norm(n) < 0.5) return null
    return { kind: 'plane', point: P, normal: n, d: dot(n, P) }
  } catch { return null }
}

function cylFrame(k: OcctKernel, f: ShapeHandle): CylFrame | null {
  const uv = safeUv(k, f)
  if (!uv) return null
  const vA = uv.vMin + (uv.vMax - uv.vMin) * 0.25
  const vB = uv.vMin + (uv.vMax - uv.vMin) * 0.75
  const span = uv.uMax - uv.uMin
  // Nudge inward so a full-2pi seam does not alias uMin == uMax.
  const uu = [uv.uMin + span * 0.05, (uv.uMin + uv.uMax) / 2, uv.uMax - span * 0.05]
  try {
    const pA = uu.map((u) => k.pointOnSurface(f, u, vA))
    const cA = circumcenter(pA[0], pA[1], pA[2])
    if (!cA) return null
    const axisDir = unit(sub(k.pointOnSurface(f, uu[0], vB), k.pointOnSurface(f, uu[0], vA)))
    if (norm(axisDir) < 0.5) return null
    return { kind: 'cylinder', axisPoint: cA, axisDir, radius: dist(pA[0], cA), uSpan: span }
  } catch { return null }
}

/**
 * Torus frame. For fixed v the u-curve is a circle of radius (R + r cos v) centred
 * at O + r sin(v) * Z. Three v-samples give three centres (=> Z) and three radii
 * (=> R, r). `frameConsistent` cross-checks minorR against an INDEPENDENT derivation
 * from the centre offsets: a variable-radius or otherwise non-toroidal blend fails it,
 * and every downstream solve seeded from an untrustworthy frame is garbage.
 */
function torusFrame(k: OcctKernel, f: ShapeHandle): TorusFrame | null {
  const uv = safeUv(k, f)
  if (!uv) return null
  const su = uv.uMax - uv.uMin, sv = uv.vMax - uv.vMin
  const uu = [uv.uMin + su * 0.05, uv.uMin + su * 0.5, uv.uMax - su * 0.05]
  const vs = [uv.vMin + sv * 0.1, uv.vMin + sv * 0.5, uv.vMax - sv * 0.1]
  try {
    const centres: Vec3[] = [], radii: number[] = []
    for (const v of vs) {
      const ps = uu.map((u) => k.pointOnSurface(f, u, v))
      const c = circumcenter(ps[0], ps[1], ps[2])
      if (!c) return null
      centres.push(c); radii.push(dist(ps[0], c))
    }
    const [v0, v1, v2] = vs
    const c0 = Math.cos(v0), c2 = Math.cos(v2)
    if (Math.abs(c0 - c2) < 1e-9) return null
    const minorR = (radii[0] - radii[2]) / (c0 - c2)
    const majorR = radii[0] - minorR * c0
    // Axis + the INDEPENDENT minor-radius cross-check both read the centre offset
    // centres[j]-centres[i] = r*(sin v_j - sin v_i)*Z. GEO-12 (BK-92 prereq): derive
    // BOTH from the sampled v-pair with the LARGEST |sin difference|, not the fixed
    // (v0,v2) pair. On a PERFECT torus whose v-span is centred on pi/2 the (v0,v2)
    // sample fractions 0.1/0.9 are SYMMETRIC — sin(v0) == sin(v2) — so that pair's sin
    // difference AND its centre offset vanish (dsin~0). The old code then fell to a
    // sign-ambiguous cross-product axis (a wrong-signed Z displaces `center` by 2*r*sin
    // v1, so on-surface checks refuse the genuine torus) and set minorRFromOffset = NaN,
    // refusing that torus on the frameConsistent gate.
    // GEO-13 (BK-116(3)): what this code actually guarantees is BEST-PAIR SELECTION with a
    // FINITE FALLBACK — NOT that any particular sample is well conditioned. It scans all three
    // v-pairs and keeps the one with the largest |sin difference|; nothing here assumes the mid
    // sample v1 is asymmetric with an end (it CAN be — a v-span placed so v1 and an end straddle
    // pi/2 makes their sines equal). Correctness rests only on there existing ONE well-separated
    // pair: three distinct v-samples on a real torus cannot all share the same sine, so at least
    // one pair has |bd| above tol. If every pair IS degenerate (all three sines within tol — a
    // near-planar or collapsed v-sampling), `bd` stays ~0, minorRFromOffset falls to NaN, and the
    // frame refuses on the frameConsistent gate (fail-closed — never a NaN comparison, charter bar 3).
    const sinv = [Math.sin(v0), Math.sin(v1), Math.sin(v2)]
    let bi = 0, bj = 2, bd = sinv[2] - sinv[0]
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]] as Array<[number, number]>) {
      const d = sinv[j] - sinv[i]
      if (Math.abs(d) > Math.abs(bd)) { bi = i; bj = j; bd = d }
    }
    const off = sub(centres[bj], centres[bi])
    let axisDir: Vec3
    if (Math.abs(bd) > 1e-6 && norm(off) > 1e-9) {
      // Divide by the SIGNED scalar bd (not just normalising the difference): its sign
      // orients Z consistently regardless of which pair won or where v sits on the tube.
      axisDir = unit(scale(off, 1 / bd))
    } else {
      const ps = uu.map((u) => k.pointOnSurface(f, u, v1))
      axisDir = unit(cross(sub(ps[1], ps[0]), sub(ps[2], ps[0])))
    }
    if (norm(axisDir) < 0.5) return null
    const minorRFromOffset = Math.abs(bd) > 1e-9 ? dot(off, axisDir) / bd : NaN
    const center = sub(centres[1], scale(axisDir, minorR * Math.sin(v1)))
    const frameConsistent = Number.isFinite(minorRFromOffset) && Math.abs(minorRFromOffset - minorR) < 1e-6
    return { kind: 'torus', center, axisDir, majorR, minorR, frameConsistent }
  } catch { return null }
}

/** Signed distance to a plane (positive along the plane normal). */
function planeSD(pl: PlaneFrame, p: Vec3): number { return dot(pl.normal, p) - pl.d }
/** Signed distance to a cylinder surface (positive outside). */
function cylinderSD(cy: CylFrame, p: Vec3): number {
  const d = sub(p, cy.axisPoint)
  const perp = sub(d, scale(cy.axisDir, dot(d, cy.axisDir)))
  return norm(perp) - cy.radius
}
/** Signed distance to a torus surface (positive outside the tube). */
function torusSD(t: TorusFrame, p: Vec3): number {
  const sp = torusSpinePoint(t, p)
  return sp === null ? NaN : dist(p, sp) - t.minorR
}
/**
 * The point on a torus's SPINE circle (radius majorR, in the plane through `center`
 * normal to `axisDir`) nearest to `p`. Undefined when `p` sits on the torus axis,
 * where the radial direction — and therefore the nearest spine point — is not unique.
 */
function torusSpinePoint(t: TorusFrame, p: Vec3): Vec3 | null {
  const v = sub(p, t.center)
  const radial = sub(v, scale(t.axisDir, dot(v, t.axisDir)))
  const rl = norm(radial)
  if (rl < 1e-9) return null
  return add(t.center, scale(radial, t.majorR / rl))
}
/** Unit surface normal of a torus at a point ON it: the direction from spine to point. */
function torusNormalAt(t: TorusFrame, p: Vec3): Vec3 | null {
  const sp = torusSpinePoint(t, p)
  if (sp === null) return null
  const n = sub(p, sp)
  return norm(n) < 1e-9 ? null : unit(n)
}
/** Gradient (unnormalised outward normal) of the cylinder implicit at p. */
function cylinderGrad(cy: CylFrame, p: Vec3): Vec3 {
  const d = sub(p, cy.axisPoint)
  return unit(sub(d, scale(cy.axisDir, dot(d, cy.axisDir))))
}
function surfaceSD(s: PlaneFrame | CylFrame, p: Vec3): number {
  return s.kind === 'plane' ? planeSD(s, p) : cylinderSD(s, p)
}
function surfaceGrad(s: PlaneFrame | CylFrame, p: Vec3): Vec3 {
  return s.kind === 'plane' ? s.normal : cylinderGrad(s, p)
}
/** Orthogonal projection of p onto a plane. */
function projectToPlane(pl: PlaneFrame, p: Vec3): Vec3 { return sub(p, scale(pl.normal, planeSD(pl, p))) }

export interface TripleSolve { ok: boolean; point: Vec3; det: number; residual: number; iters: number; reason?: string }

/**
 * Newton solve of the 3-surface intersection F(p) = [sd1, sd2, sd3] = 0, seeded at p0.
 *
 * MANDATORY GUARD 2 (GEO-6X4 F1) — read before touching the caller. This routine's
 * `minDet` fail-closed is NOT a sufficient guard and must never be relied on to catch
 * a tangent triple: seeded slightly off the true solution, a TANGENT triple's Jacobian
 * is not exactly singular but merely ill-conditioned (det ~ 1e-5, above any sane
 * threshold), so Newton reports ok=true and returns a point ~1.25e-4 mm off — 125x the
 * sew tolerance — with no error signal. The triple must therefore be chosen
 * STRUCTURALLY transversal by the caller, not filtered numerically here.
 *
 * For the blend-ribbon corner the caller passes (endPlane, sidePlane, chamferPlane):
 * three planes, so F is affine and the solve is exact in ONE iteration from any seed.
 */
function solveTriplePoint(s1: PlaneFrame | CylFrame, s2: PlaneFrame | CylFrame, s3: PlaneFrame | CylFrame, p0: Vec3): TripleSolve {
  const tol = 1e-9, maxIter = 60, minDet = 1e-6
  let p = { ...p0 }
  for (let i = 0; i < maxIter; i++) {
    const F = [surfaceSD(s1, p), surfaceSD(s2, p), surfaceSD(s3, p)]
    const res = Math.max(...F.map(Math.abs))
    const g = [surfaceGrad(s1, p), surfaceGrad(s2, p), surfaceGrad(s3, p)]
    const det = dot(g[0], cross(g[1], g[2]))
    if (Math.abs(det) < minDet) return { ok: false, point: p, det, residual: res, iters: i, reason: 'rank-deficient Jacobian (tangent surfaces)' }
    if (res < tol) return { ok: true, point: p, det, residual: res, iters: i }
    const inv = invert3(g)
    p = add(p, {
      x: -(inv[0][0] * F[0] + inv[0][1] * F[1] + inv[0][2] * F[2]),
      y: -(inv[1][0] * F[0] + inv[1][1] * F[1] + inv[1][2] * F[2]),
      z: -(inv[2][0] * F[0] + inv[2][1] * F[1] + inv[2][2] * F[2]),
    })
    if (!Number.isFinite(p.x + p.y + p.z)) return { ok: false, point: p, det: NaN, residual: NaN, iters: i, reason: 'Newton diverged (non-finite iterate)' }
  }
  const F = [surfaceSD(s1, p), surfaceSD(s2, p), surfaceSD(s3, p)]
  return { ok: false, point: p, det: NaN, residual: Math.max(...F.map(Math.abs)), iters: maxIter, reason: 'Newton did not converge within maxIter' }
}

/** Invert the 3x3 whose ROWS are g[0..2]. */
function invert3(g: Vec3[]): number[][] {
  const m = [[g[0].x, g[0].y, g[0].z], [g[1].x, g[1].y, g[1].z], [g[2].x, g[2].y, g[2].z]]
  const c = [
    [m[1][1] * m[2][2] - m[1][2] * m[2][1], -(m[0][1] * m[2][2] - m[0][2] * m[2][1]), m[0][1] * m[1][2] - m[0][2] * m[1][1]],
    [-(m[1][0] * m[2][2] - m[1][2] * m[2][0]), m[0][0] * m[2][2] - m[0][2] * m[2][0], -(m[0][0] * m[1][2] - m[0][2] * m[1][0])],
    [m[1][0] * m[2][1] - m[1][1] * m[2][0], -(m[0][0] * m[2][1] - m[0][1] * m[2][0]), m[0][0] * m[1][1] - m[0][1] * m[1][0]],
  ]
  const det = m[0][0] * c[0][0] + m[0][1] * c[1][0] + m[0][2] * c[2][0]
  return c.map((row) => row.map((x) => x / det))
}

// ---------- gathering ----------

/** Read every face of `shape` into a FaceRec (caller must releaseFaceRecs). */
export function gatherFaces(k: OcctKernel, shape: ShapeHandle): FaceRec[] {
  const faces = k.getSubShapes(shape, 'face')
  const recs: FaceRec[] = []
  for (const f of faces) {
    let type: SurfaceKind = 'other' as SurfaceKind
    try { type = k.surfaceType(f) } catch { /* keep 'other' */ }
    const centroid = safeVec(() => k.getSurfaceCenterOfMass(f))
    const bb = k.getBoundingBox(f, false)
    const bbox: BBox = { xmin: bb.xmin, ymin: bb.ymin, zmin: bb.zmin, xmax: bb.xmax, ymax: bb.ymax, zmax: bb.zmax }
    const uv = safeUv(k, f)
    const normal = uv ? unit(safeVec(() => k.surfaceNormal(f, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2))) : { x: 0, y: 0, z: 0 }
    let area = 0
    try { area = k.getSurfaceArea(f) } catch { /* 0 */ }
    let radius: number | undefined
    let axis: Vec3 | undefined
    let uSpan: number | undefined
    if (type === 'cylinder') {
      try { const cd = k.getFaceCylinderData(f); if (cd) radius = cd.radius } catch { /* none */ }
      axis = cylinderAxis(k, f, uv)
      if (uv) uSpan = uv.uMax - uv.uMin
    } else if (type === 'cone' || type === 'torus') {
      axis = cylinderAxis(k, f, uv)
    }
    // GEO-7-R1: a planar face's in-plane extents (uv-box, plane-local frame) — a
    // rotation-invariant size the chamfer strip gate uses in place of the world bbox.
    let planeExtent: { major: number; minor: number } | undefined
    if (type === 'plane' && uv) {
      const du = uv.uMax - uv.uMin, dv = uv.vMax - uv.vMin
      planeExtent = { major: Math.max(du, dv), minor: Math.min(du, dv) }
    }
    const innerLoops = innerLoopCount(k, f)
    const neighbours = neighbourHashes(k, shape, f)
    recs.push({ handle: f, hash: k.hashCode(f, HM), type, centroid, normal, area, bbox, radius, axis, uSpan, planeExtent, innerLoops, neighbours })
  }
  return recs
}

export function releaseFaceRecs(k: OcctKernel, recs: FaceRec[]): void {
  for (const r of recs) { try { k.release(r.handle) } catch { /* ignore */ } }
}

function safeVec(fn: () => Vec3): Vec3 { try { return fn() } catch { return { x: 0, y: 0, z: 0 } } }
function safeUv(k: OcctKernel, f: ShapeHandle): { uMin: number; uMax: number; vMin: number; vMax: number } | null {
  try { return k.uvBounds(f) } catch { return null }
}

/** Axis of a cylinder/cone/torus via the cross of two surface normals. */
function cylinderAxis(k: OcctKernel, f: ShapeHandle, uv: { uMin: number; uMax: number; vMin: number; vMax: number } | null): Vec3 | undefined {
  if (!uv) return undefined
  const vMid = (uv.vMin + uv.vMax) / 2
  // Sample a QUARTER of the U-span apart, not half: on a full cylinder (uSpan
  // 2pi) the uMin and uMid normals are ANTIPARALLEL, so their cross is zero and
  // the axis is lost. A quarter turn keeps the two radial normals ~orthogonal.
  const u1 = uv.uMin
  const u2 = uv.uMin + (uv.uMax - uv.uMin) * 0.25
  const n1 = safeVec(() => k.surfaceNormal(f, u1, vMid))
  const n2 = safeVec(() => k.surfaceNormal(f, u2, vMid))
  const a = unit(cross(n1, n2))
  return norm(a) < 0.5 ? undefined : a
}

function innerLoopCount(k: OcctKernel, f: ShapeHandle): number {
  try { const ws = k.getSubShapes(f, 'wire'); const n = ws.length; for (const w of ws) { try { k.release(w) } catch { /* */ } } return Math.max(0, n - 1) } catch { return 0 }
}

function neighbourHashes(k: OcctKernel, shape: ShapeHandle, f: ShapeHandle): number[] {
  try {
    const adj = k.adjacentFaces(shape, f)
    const out = adj.map((a) => k.hashCode(a, HM))
    for (const a of adj) { try { k.release(a) } catch { /* */ } }
    return out
  } catch { return [] }
}

/** Enumerate the INNER (hole) loops of a planar face in removeHolesFromFace
 *  index order, with each loop's centre + span. */
export function hostLoops(k: OcctKernel, host: FaceRec): HostLoop[] {
  const out: HostLoop[] = []
  let wires: ShapeHandle[] = []
  let outer: ShapeHandle | null = null
  try {
    wires = k.getSubShapes(host.handle, 'wire')
    outer = k.outerWire(host.handle)
    let innerIdx = 0
    for (const w of wires) {
      let same = false
      try { same = k.isSame(w, outer) } catch { same = false }
      if (same) continue
      const wb = k.getBoundingBox(w, false)
      let edgeCount = 0
      try { const es = k.getSubShapes(w, 'edge'); edgeCount = es.length; for (const e of es) { try { k.release(e) } catch { /* */ } } } catch { edgeCount = 0 }
      out.push({
        hostHash: host.hash,
        loopIndex: innerIdx,
        centerX: (wb.xmin + wb.xmax) / 2,
        centerY: (wb.ymin + wb.ymax) / 2,
        centerZ: (wb.zmin + wb.zmax) / 2,
        spanX: wb.xmax - wb.xmin,
        spanY: wb.ymax - wb.ymin,
        edgeCount,
      })
      innerIdx++
    }
  } catch { /* none */ } finally {
    if (outer) { try { k.release(outer) } catch { /* */ } }
    for (const w of wires) { try { k.release(w) } catch { /* */ } }
  }
  return out
}

// ---------- recognition ----------

const SLIVER_AREA = 1.0        // mm^2 — a face this small is a sliver candidate
const AXIS_LINE_TOL = 1.0      // mm — loop centres within this of a shared axis line are coaxial
const DIR_TOL = 1e-3           // axis-direction parallelism tolerance

function bodyBBox(recs: FaceRec[]): BBox {
  const b: BBox = { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity }
  for (const r of recs) {
    b.xmin = Math.min(b.xmin, r.bbox.xmin); b.ymin = Math.min(b.ymin, r.bbox.ymin); b.zmin = Math.min(b.zmin, r.bbox.zmin)
    b.xmax = Math.max(b.xmax, r.bbox.xmax); b.ymax = Math.max(b.ymax, r.bbox.ymax); b.zmax = Math.max(b.zmax, r.bbox.zmax)
  }
  return b
}

interface HoleSeed { host: FaceRec; lp: HostLoop; dir: Vec3; center: Vec3; thr: number }

/**
 * Recognize every removable/refusable feature on `shape`. Deterministic: the
 * output is sorted by a geometry-derived key so identical geometry yields an
 * identical list independent of kernel enumeration order.
 */
export function recognizeFeatures(k: OcctKernel, shape: ShapeHandle, recs?: FaceRec[]): RecognizedFeature[] {
  const owned = !recs
  const faces = recs ?? gatherFaces(k, shape)
  try {
    const bb = bodyBBox(faces)
    const byHash = new Map<number, FaceRec>(faces.map((f) => [f.hash, f]))
    const features: RecognizedFeature[] = []
    const consumed = new Set<number>()

    // ---- 0) TORUS corner blends. GEO-6X5 (adopting the GEO-6X4 Path C proof):
    //         a torus inside the BOUNDED analytic blend-ribbon class is reconstructed
    //         to its sharp corner; every other torus keeps a structured refusal that
    //         NAMES the gate it failed. Never approximated, never crashed. ----
    const frames = new Map<number, AnalyticFrame | null>()
    // edge-ownership map, built once and only if the body carries a torus at all.
    let blendOwners: Map<number, number[]> | null = null
    for (const f of faces) {
      if (f.type !== 'torus' || consumed.has(f.hash)) continue
      blendOwners ??= buildEdgeOwners(k, faces)
      const res = analyzeBlendRibbon(k, byHash, f, frames, blendOwners)
      if (res.ok) {
        features.push(blendFeature(f, res.plan))
        for (const h of res.plan.removeHashes) consumed.add(h)
      } else {
        // Outside the class: consume ONLY the torus, exactly as the pre-GEO-6X5
        // blanket refusal did. Its ribbon cylinders keep falling through to the
        // edge-dress recognizer below, which refuses them for a curved neighbour.
        // (Consuming a refused ribbon would silently swallow faces that another
        // recognizer legitimately owns — e.g. a countersink cone adjacent to a fillet.)
        features.push(refuseCurved(f, res.reason))
        consumed.add(f.hash)
      }
    }

    // ---- 1) HOLES, seeded from opening loops on planar slab faces. A cylinder/
    //         cone concentric with an opening loop is a bore; a fillet band (no
    //         concentric opening) is never mistaken for a hole. ----
    const seeds: HoleSeed[] = []
    for (const host of faces) {
      if (host.type !== 'plane') continue
      for (const lp of hostLoops(k, host)) {
        // Only a CIRCULAR opening (single circle edge) seeds a hole; a rounded-
        // rectangle pocket rim (many edges) is left for the pocket recognizer.
        // This is what separates the plate's 12 drilled holes from its central
        // pocket, whose corner cylinders would otherwise read as a bore.
        if (lp.edgeCount > 3) continue
        // Concentric radius: a round hole's wall sits at loopSpan/2 from the axis;
        // a counterbore's widest opening loop == its widest wall (GEO-6S probe 07).
        const span = Math.max(lp.spanX, lp.spanY)
        seeds.push({ host, lp, dir: unit(host.normal), center: { x: lp.centerX, y: lp.centerY, z: lp.centerZ }, thr: span / 2 + 3 })
      }
    }
    const usedSeed = new Array(seeds.length).fill(false)
    for (let i = 0; i < seeds.length; i++) {
      if (usedSeed[i]) continue
      const s = seeds[i]
      const group = [s]; usedSeed[i] = true
      for (let j = i + 1; j < seeds.length; j++) {
        if (usedSeed[j]) continue
        const t = seeds[j]
        if (Math.abs(Math.abs(dot(s.dir, t.dir)) - 1) < DIR_TOL && perpDistPointToLine(t.center, s.center, s.dir) < AXIS_LINE_TOL) { group.push(t); usedSeed[j] = true }
      }
      const thr = Math.max(...group.map((g) => g.thr))
      // Bore membership = SPATIAL locality to the seed axis line (probe 07): a
      // cyl/cone concentric with the opening. We do NOT trust each face's own
      // axis (cone axis probing is imperfect) — only its distance to the axis.
      const bore = faces.filter((f) => !consumed.has(f.hash) && (f.type === 'cylinder' || f.type === 'cone') &&
        perpDistPointToLine(f.centroid, s.center, s.dir) < thr)
      if (bore.length === 0) continue // not a hole — leave the loops for the pocket recognizer
      // BK-96 (GEO-14) fail-open sweep: FaceRec.type === 'other' means gatherFaces()'s
      // surfaceType() call THREW — the kernel names every surface it recognizes (plane,
      // cylinder, cone, sphere, bspline, …), so 'other' is an UNREAD type, never an exotic
      // one. An unread face sitting inside this hole's spatial footprint (within `thr` of the
      // seed axis, where a bore wall or interior cap lives) cannot be classified as bore, cap,
      // or non-member. Treating it as an ordinary non-member — silently excluding it from
      // `bore`/`caps` and healing the hole around it — is the exact fail-open inversion
      // GEO-6X5 closed for blends (analyzeBlendRibbon's `nb.type === 'other'` gate). Refuse
      // the hole BY NAME instead, rather than sewing around geometry we never understood.
      // (Inert on readable bodies: surfaceType only throws on a genuine kernel read fault.)
      const unread = faces.find((f) => !consumed.has(f.hash) && f.type === 'other' &&
        perpDistPointToLine(f.centroid, s.center, s.dir) < thr)
      if (unread) {
        features.push(refuseHole(s, unread))
        continue
      }
      // caps = INTERIOR planar faces concentric with the axis (blind-hole floor,
      // counterbore shoulder). We do NOT test the normal — a small floor disk's
      // UV-midpoint normal probe is unreliable; concentric + interior + planar +
      // not-on-the-body-shell is the robust signal (probe 07).
      // BK-97 (GEO-11): the CENTROID-only concentricity test dropped the hole's OWN
      // host slab when a fused boss raised the body bbox past that slab (so the slab
      // reads !onBodyBBox and its centroid sits on the axis). A real floor/shoulder
      // is bounded by the bore footprint; a structural slab reaches far past it. Gate
      // on the cap's full radial EXTENT (max distance from the axis to any cap point),
      // not just its centroid — a slab like a plate top under two bosses is then
      // excluded, so it survives to be untrimmed (removeHolesFromFace) instead of
      // silently dropped into an open-topped shell.
      //
      // GEO-11-R2 (blocker 1): that extent is a PROVEN conservative upper bound on
      // the cap's true radial reach (capRadialExtent) — exact circle extrema, exact
      // line endpoints, NURBS-hull for the rest — or Infinity if any geometry read
      // fails. It never UNDER-states (which would mis-drop a structural slab, BK-97)
      // and an unreadable cap reads Infinity, so it is EXCLUDED and the heal refuses
      // loudly rather than silently mis-healing. The R1 planeExtent/bbox estimates
      // (which the audit reproduced blocker 1 through) are deleted.
      const capWithinFootprint = (f: FaceRec): boolean =>
        capRadialExtent(k, f, s.center, s.dir) <= thr + 1e-6
      const caps = faces.filter((f) => !consumed.has(f.hash) && f.type === 'plane' && !onBodyBBox(f, bb) &&
        perpDistPointToLine(f.centroid, s.center, s.dir) < thr && capWithinFootprint(f))
      const dropFaces = [...bore, ...caps]
      for (const f of dropFaces) consumed.add(f.hash)
      const removals = group.map((g) => ({ hostHash: g.lp.hostHash, loopIndex: g.lp.loopIndex }))
      const radii = bore.filter((f) => f.type === 'cylinder').map((f) => f.radius).filter((r): r is number => r !== undefined)
      const hasCone = bore.some((f) => f.type === 'cone')
      const distinctRadii = new Set(radii.map((r) => round(r, 3)))
      const floorCap = caps.length > 0
      const openings = group.length
      const type: FeatureType = (hasCone || distinctRadii.size > 1) ? 'counterboreStack' : (openings >= 2 && !floorCap) ? 'throughHole' : 'blindHole'
      const minR = radii.length ? Math.min(...radii) : 0
      const depth = axialSpan(bore, s.dir)
      features.push({
        key: `hole:${round(s.center.x)}:${round(s.center.y)}:${round(s.center.z)}:${round(s.dir.x)}:${round(s.dir.y)}:${round(s.dir.z)}:${round(minR, 3)}`,
        type,
        dropHashes: dropFaces.map((f) => f.hash),
        untrimHashes: [],
        hostRemovals: removals,
        neighbourHashes: removals.map((r) => r.hostHash),
        effect: 'add',
        removable: true,
        params: { axisX: round(s.dir.x), axisY: round(s.dir.y), axisZ: round(s.dir.z), diameter: round(2 * minR, 3), depth: round(depth, 3), openings, radiusCount: distinctRadii.size },
        fingerprint: { cx: round(s.center.x), cy: round(s.center.y), cz: round(s.center.z), nx: round(s.dir.x), ny: round(s.dir.y), nz: round(s.dir.z), kind: type },
      })
    }

    // ---- 2) LOOP features on planar hosts NOT claimed by a hole: pocket /
    //         engraved text / boss (raised island). ----
    for (const host of faces) {
      if (host.type !== 'plane') continue
      const hn = unit(host.normal)
      for (const lp of hostLoops(k, host)) {
        if (features.some((ft) => ft.hostRemovals.some((r) => r.hostHash === lp.hostHash && r.loopIndex === lp.loopIndex))) continue
        // A feature face fits WITHIN the opening footprint (pocket wall/floor,
        // boss wall/top). This replaces a naive !onBodyBBox test, which wrongly
        // dropped a boss's TOP face (it legitimately defines the body bbox) while
        // still excluding the opposite full-body slab (which spans the whole body,
        // far larger than the loop footprint).
        const fits = (f: FaceRec): boolean =>
          (f.bbox.xmax - f.bbox.xmin) <= lp.spanX * 1.5 + 2 && (f.bbox.ymax - f.bbox.ymin) <= lp.spanY * 1.5 + 2
        const inside = faces.filter((f) => f.hash !== host.hash && !consumed.has(f.hash) &&
          xyInsideLoop(f.centroid, lp) && fits(f) && Math.abs(dot(sub(f.centroid, host.centroid), hn)) > 1e-4)
        if (inside.length === 0) continue
        const meanOff = inside.reduce((a, f) => a + dot(sub(f.centroid, host.centroid), hn), 0) / inside.length
        const isBoss = meanOff > 0
        for (const f of inside) consumed.add(f.hash)
        features.push({
          key: `loop:${round(lp.centerX)}:${round(lp.centerY)}:${round(lp.centerZ)}`,
          type: isBoss ? 'boss' : 'pocket',
          dropHashes: inside.map((f) => f.hash),
          untrimHashes: [],
          hostRemovals: [{ hostHash: lp.hostHash, loopIndex: lp.loopIndex }],
          neighbourHashes: [host.hash],
          effect: isBoss ? 'remove' : 'add',
          removable: true,
          params: { centerX: round(lp.centerX), centerY: round(lp.centerY), centerZ: round(lp.centerZ), spanX: round(lp.spanX), spanY: round(lp.spanY), depth: round(Math.abs(meanOff) * 2, 3), faceCount: inside.length },
          fingerprint: { cx: round(lp.centerX), cy: round(lp.centerY), cz: round(lp.centerZ), nx: round(hn.x), ny: round(hn.y), nz: round(hn.z), kind: isBoss ? 'boss' : 'pocket' },
        })
      }
    }
    tagEngravedText(features)

    // GEO-8 (BK-59): EXPLICIT hole-stack membership set. Every face consumed by a
    // through/blind/counterbore hole verdict (bore wall, countersink cone, blind
    // floor, counterbore shoulder / chamfer lip) belongs to that ONE hole verdict
    // and must never ALSO surface as a standalone edge-dress band candidate. Holes
    // are recognized first, so these faces are already in `consumed`; we name the
    // set explicitly so the hole-stack ∩ band disjointness is a LEGIBLE, order-
    // independent contract (asserted directly in GEO-8's real-plate test) rather
    // than an emergent side effect of loop ordering.
    const holeStackFaces = new Set<number>()
    for (const ft of features) {
      if (ft.type === 'throughHole' || ft.type === 'blindHole' || ft.type === 'counterboreStack') {
        for (const h of ft.dropHashes) holeStackFaces.add(h)
      }
    }

    // ---- 3) EDGE-DRESS bands: fillet (cylinder) / chamfer (planar strip),
    //         recognized by an all-planar neighbour set. Axis-aligned neighbours
    //         take the proven bbox-clip untrim; TILTED planar neighbours (GEO-7)
    //         take the plane-plane intersection untrim. A curved neighbour, or a
    //         pair that never meets (parallel planes), -> structured refusal. ----
    for (const f of faces) {
      if (consumed.has(f.hash) || holeStackFaces.has(f.hash)) continue
      const nbrs = f.neighbours.map((h) => byHash.get(h)).filter((n): n is FaceRec => !!n)
      const planarNbrs = nbrs.filter((n) => n.type === 'plane')
      const curvedNbrs = nbrs.filter((n) => n.type !== 'plane')
      if (f.type === 'cylinder' && f.innerLoops === 0 && partialCylinder(f)) {
        if (curvedNbrs.length > 0) {
          // GEO-6X5: no longer the GEO-6S "unsolved with the exposed primitives" verdict.
          // A curved-neighbour band that belongs to an IN-CLASS analytic blend ribbon is
          // consumed by the recognizer in step 0 and never reaches here. What lands here is
          // a curved-neighbour band OUTSIDE that class, whose sharp boundary this code does
          // not construct — so it refuses rather than approximating.
          features.push(refuseCurved(f, 'fillet band with a curved neighbour outside the bounded analytic blend-ribbon class: its sharp boundary is not constructed (GEO-6X5) — no approximation is emitted'))
        } else if (planarNbrs.length >= 2) {
          if (planarNbrs.every((n) => axisAlignedOnBBox(n, bb))) {
            // axis-aligned neighbours -> the proven bbox-clip sharp-wire path (unchanged).
            features.push(bandFeature(f, planarNbrs, 'filletPlanar', true, f.radius))
          } else {
            // GEO-7: at least one TILTED planar neighbour -> plane-plane intersection untrim.
            features.push(bandFeatureGeneral(k, f, planarNbrs, 'filletPlanar', f.radius))
          }
        }
        consumed.add(f.hash)
      } else if (f.type === 'plane' && f.innerLoops === 0 && !axisAlignedOnBBox(f, bb) && curvedNbrs.length === 0 &&
        planarNbrs.length >= 2 && isThinStrip(f)) {
        // planar chamfer strip: a diagonal planar face bridging >=2 planar faces.
        // GEO-8 (BK-59): the thin-strip aspect gate (isThinStrip) now gates BOTH
        // untrim paths, not just the tilted one. Pre-GEO-8 the axis-aligned bbox
        // path had NO aspect gate, so a LARGE tilted plane (a ramp / roof / draft
        // face, aspect ~1.4) whose neighbours happen to be axis-aligned on the body
        // bbox was mis-flagged as a standalone chamferPlanar candidate — the GEO-6
        // techDebt's "over-flag diagonal planar faces on dense real parts". A genuine
        // chamfer facet is LONG and NARROW (aspect >> 4: the 87-face plate's 12 edge
        // breaks measure ~18-112), so this gate cuts the false positives while every
        // real chamfer keeps recognizing exactly as before.
        // GEO-7-R1: NO axis-aligned-neighbour-count prerequisite — the thin-strip
        // gate + planUntrim decide removable/refused at ANY orientation.
        if (planarNbrs.every((n) => axisAlignedOnBBox(n, bb))) {
          // all neighbours axis-aligned -> the proven bbox-clip sharp-wire path (unchanged).
          features.push(bandFeature(f, planarNbrs, 'chamferPlanar', true))
        } else {
          // a tilted bevelled neighbour -> GEO-7 plane-plane intersection untrim.
          features.push(bandFeatureGeneral(k, f, planarNbrs, 'chamferPlanar'))
        }
        consumed.add(f.hash)
      }
      // else: not a band — a tilted non-strip plane (ramp/roof/draft) or a face with
      // a curved / too-few planar neighbours; leave it untouched.
    }

    // ---- 4) SLIVER faces (tiny area) not otherwise claimed ----
    for (const f of faces) {
      if (consumed.has(f.hash)) continue
      if (f.area > 0 && f.area < SLIVER_AREA) {
        features.push({
          key: `sliver:${round(f.centroid.x)}:${round(f.centroid.y)}:${round(f.centroid.z)}`,
          type: 'sliver',
          dropHashes: [], untrimHashes: [], hostRemovals: [], neighbourHashes: f.neighbours,
          effect: 'add', removable: true,
          params: { area: round(f.area, 4), centerX: round(f.centroid.x), centerY: round(f.centroid.y), centerZ: round(f.centroid.z) },
          fingerprint: { cx: round(f.centroid.x), cy: round(f.centroid.y), cz: round(f.centroid.z), nx: round(f.normal.x), ny: round(f.normal.y), nz: round(f.normal.z), kind: 'sliver' },
        })
      }
    }

    features.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return features
  } finally {
    if (owned) releaseFaceRecs(k, faces)
  }
}

/**
 * BK-96 (GEO-14): a hole seed whose spatial footprint contains an UNREAD face
 * (surfaceType threw -> FaceRec.type 'other') refuses BY NAME. `removable:false`
 * carries the reason to the last consumer (healRemoval line ~1822 turns a
 * non-removable feature into `{ ok:false }`), so the hole can never heal around a
 * face the kernel could not classify. Keyed on the seed axis point like a hole so
 * the refusal re-finds the same location on regen; drops nothing.
 */
function refuseHole(s: HoleSeed, unread: FaceRec): RecognizedFeature {
  const c = { x: s.center.x, y: s.center.y, z: s.center.z }
  return {
    key: `hole-refused:${round(c.x)}:${round(c.y)}:${round(c.z)}:${round(s.dir.x)}:${round(s.dir.y)}:${round(s.dir.z)}`,
    type: 'blindHole',
    dropHashes: [], untrimHashes: [], hostRemovals: [], neighbourHashes: [s.lp.hostHash],
    effect: 'add', removable: false,
    refuseReason: `hole membership cannot be decided — an unreadable face (surfaceType threw) at (${round(unread.centroid.x, 3)},${round(unread.centroid.y, 3)},${round(unread.centroid.z, 3)}) lies inside the bore footprint`,
    params: { centerX: round(c.x), centerY: round(c.y), centerZ: round(c.z), axisX: round(s.dir.x), axisY: round(s.dir.y), axisZ: round(s.dir.z) },
    fingerprint: { cx: round(c.x), cy: round(c.y), cz: round(c.z), nx: round(s.dir.x), ny: round(s.dir.y), nz: round(s.dir.z), kind: 'blindHole' },
  }
}

function refuseCurved(f: FaceRec, reason: string): RecognizedFeature {
  return {
    key: `curved:${round(f.centroid.x)}:${round(f.centroid.y)}:${round(f.centroid.z)}`,
    type: 'filletCurvedCorner',
    dropHashes: [f.hash], untrimHashes: [], hostRemovals: [], neighbourHashes: f.neighbours,
    effect: 'add', removable: false, refuseReason: reason,
    params: { centerX: round(f.centroid.x), centerY: round(f.centroid.y), centerZ: round(f.centroid.z), area: round(f.area, 3) },
    fingerprint: { cx: round(f.centroid.x), cy: round(f.centroid.y), cz: round(f.centroid.z), nx: round(f.normal.x), ny: round(f.normal.y), nz: round(f.normal.z), kind: 'filletCurvedCorner' },
  }
}

// ---------- GEO-6X5: the bounded analytic blend-ribbon recognizer ----------

const BLEND_RADIUS_TOL = 1e-6   // mm — ribbon radius match (r of every chained cylinder)
const BLEND_GEOM_TOL = 1e-6     // mm — on-surface / tangency / concurrency gates
const BLEND_DIR_TOL = 1e-6      // |cos| deviation for the perpendicular / parallel gates
/**
 * G1 chain gate: max tolerated (1 - |cos(nA, nB)|) across a shared ribbon boundary.
 *
 * JUSTIFIED BY MEASUREMENT, not taste. Reproduce with `node tools/probes/geo-6x5/run.mjs`
 * -> coordination/evidence/GEO-6X5/r2-g1-calibration.json (full row array, no ad-hoc
 * instrumentation). Walking the chain over Tray.step's 59 tori measures ALL 156 same-radius
 * shared boundaries — the 18 belonging to the 9 in-class ribbons and the 138 on refused
 * seeds alike — at a deviation of at most 4.441e-16, i.e. 2 machine epsilon. Analytic STEP
 * surfaces that are truly tangent are tangent to the last bit.
 *
 * Where 1e-9 sits, stated exactly (GEO-6X5-R2, audit minor — R1 overstated the lower gap):
 *   - ~6.4 decades ABOVE the measured tangent noise floor (1e-9 / 4.441e-16 = 2.25e6), so
 *     no genuine blend can be refused by frame-fitting round-off; and
 *   - ~8.7 decades BELOW the measured transverse junction (0.5425 / 1e-9 = 5.425e8), the
 *     synthetic same-radius non-tangent negative in test #6.
 * Those two gaps are the halves of the ~15-decade separation between the tangent and the
 * transverse POPULATIONS themselves (0.5425 / 4.441e-16 = 1.22e15). 1 - |cos| is 0.293 at
 * 45 deg and 1.0 at 90 deg, so a real hard edge lands in the transverse population by a
 * wide margin. In angle terms 1e-9 admits theta <= sqrt(2e-9) = 4.5e-5 rad = 0.0026 deg.
 * There is no calibration ambiguity here: the tolerance has ~6 decades of slack on one
 * side and ~9 on the other. It is not a knob anyone has to tune.
 */
const BLEND_G1_TOL = 1e-9

export type BlendResult = { ok: true; plan: BlendRibbonPlan } | { ok: false; reason: string }

/** Every refusal names the gate it failed — a structured verdict, never an approximation. */
function blendRefusal(gate: string): BlendResult {
  return { ok: false, reason: `torus corner blend outside the bounded analytic blend-ribbon class (GEO-6X5): ${gate}` }
}

/**
 * The analytic frame of `rec`, memoized by face hash.
 *
 * `cache` is the ONLY channel through which a frame is produced, which is what makes
 * the frame-derivation-failure path testable: a caller that pre-seeds `cache` with
 * `null` for a face hash makes `frameOf` fail for exactly that face, without touching
 * the kernel or the walk (GEO-6X5-R2 test #7).
 */
export function frameOf(k: OcctKernel, rec: FaceRec, cache: Map<number, AnalyticFrame | null>): AnalyticFrame | null {
  const hit = cache.get(rec.hash)
  if (hit !== undefined) return hit
  let fr: AnalyticFrame | null = null
  if (rec.type === 'plane') fr = planeFrame(k, rec.handle)
  else if (rec.type === 'cylinder') fr = cylFrame(k, rec.handle)
  else if (rec.type === 'torus') fr = torusFrame(k, rec.handle)
  cache.set(rec.hash, fr)
  return fr
}

/** Unit surface normal of any analytic frame at a point ON it (null where undefined). */
function frameNormalAt(fr: AnalyticFrame, p: Vec3): Vec3 | null {
  if (fr.kind === 'plane') return fr.normal
  if (fr.kind === 'cylinder') { const n = cylinderGrad(fr, p); return norm(n) < 0.5 ? null : n }
  return torusNormalAt(fr, p)
}
/** Signed distance from p to any analytic frame's surface. */
function frameSD(fr: AnalyticFrame, p: Vec3): number {
  return fr.kind === 'plane' ? planeSD(fr, p) : fr.kind === 'cylinder' ? cylinderSD(fr, p) : torusSD(fr, p)
}

/** The worst G1 deviation over one shared boundary, plus how it was measured. */
export interface G1Measure {
  /** max over sampled points of (1 - |cos(nA, nB)|). 0 == tangent planes coincide. */
  dev: number
  /** max |signed distance| of a sampled boundary point to either analytic surface. */
  onSurface: number
  /** total usable samples across every non-degenerate shared edge. */
  samples: number
  /** how many non-degenerate shared edges were measured (each contributed >= 1 sample). */
  edges: number
  /** how many shared edges were provably degenerate (zero length) and carry no tangent data. */
  degenerateEdges: number
}

/**
 * G1 (tangent-plane) continuity across the boundary shared by two ribbon members.
 *
 * GEO-6X5-R1 (audit major 1). Surface TYPE + equal RADIUS + ADJACENCY are necessary
 * conditions for blend-ribbon membership, never sufficient: a transverse cylinder that
 * merely happens to share the torus's minor radius satisfies all three while meeting it
 * at a hard edge. The removal class is defined by a G1 tangent chain (GEO-6X4 F3), and
 * every gate downstream — the sharp-arc solve, the four-plane concurrency, the untrim —
 * assumes tangency it never checked. This measures it.
 *
 * Method: sample interior points of every shared edge (they lie on BOTH surfaces by
 * construction) and compare the two ANALYTIC normals there. Normals are compared
 * UNORIENTED (|cos|): a face's kernel orientation flips its normal, but a shared tangent
 * plane is orientation-free, and that plane — not the outward direction — is what G1 means.
 * `onSurface` reports how far the sampled boundary points fall from the fitted frames, so
 * a bad frame cannot masquerade as a bad tangency.
 *
 * Returns null when the boundary cannot be measured at all (no non-degenerate shared edge,
 * or a normal is undefined at a sample) — the caller treats that as UNVERIFIED and refuses.
 *
 * GEO-6X5-R2 (audit minor, :904): the requirement is PER NON-DEGENERATE SHARED EDGE, not
 * aggregate. Two faces may share several edges; with one aggregate counter, samples drawn
 * from a readable edge satisfied the "did we measure anything?" test on behalf of an
 * unreadable one, and that second shared boundary went unverified while the pair reported
 * success. Every non-degenerate shared edge must now yield at least one usable sample, and
 * an edge whose LENGTH cannot even be read is unverifiable — never assumed degenerate.
 */
export function measureG1(k: OcctKernel, a: FaceRec, fa: AnalyticFrame, b: FaceRec, fb: AnalyticFrame): G1Measure | null {
  const es = sharedEdgesSafe(k, a.handle, b.handle)
  try {
    let dev = 0, onSurface = 0, samples = 0, edges = 0, degenerateEdges = 0
    for (const e of es) {
      // An unreadable length is NOT evidence of degeneracy. Only a length we actually read,
      // and read as zero, proves the edge is a pole/apex that carries no tangent data.
      let len: number
      try { len = k.getLength(e) } catch { return null }
      if (!Number.isFinite(len)) return null
      if (len <= 1e-9) { degenerateEdges++; continue }

      let cp: { first: number; last: number }
      try { cp = k.curveParameters(e) } catch { return null }
      if (!Number.isFinite(cp.first) || !Number.isFinite(cp.last) || cp.last <= cp.first) return null

      // Interior fractions only: an endpoint may be a vertex the two surfaces share with a
      // THIRD face, where either normal can be degenerate.
      //
      // GEO-6X5-R3 (audit major, :948): a returned point/normal is not necessarily a USABLE
      // one — curvePointAtParam or an analytic frame can hand back NaN without throwing and
      // without frameNormalAt's own null check catching it (e.g. Math.hypot on NaN components
      // is NaN, and `NaN < 0.5` is false). Every number that feeds dev/onSurface is checked
      // for finiteness before it counts; a non-finite value makes THIS sample unusable, not
      // the whole edge — the existing "edgeSamples === 0" rule below still fires the named
      // refusal if that leaves the edge with nothing usable.
      let edgeSamples = 0
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        let p: Vec3
        try { p = k.curvePointAtParam(e, cp.first + (cp.last - cp.first) * t) } catch { continue }
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
        const na = frameNormalAt(fa, p), nb = frameNormalAt(fb, p)
        if (!na || !nb) return null
        if (!Number.isFinite(na.x) || !Number.isFinite(na.y) || !Number.isFinite(na.z)) continue
        if (!Number.isFinite(nb.x) || !Number.isFinite(nb.y) || !Number.isFinite(nb.z)) continue
        const cosNaNb = dot(na, nb)
        if (!Number.isFinite(cosNaNb)) continue
        const devSample = Math.abs(1 - Math.abs(cosNaNb))
        if (!Number.isFinite(devSample)) continue
        const sdA = frameSD(fa, p)
        if (!Number.isFinite(sdA)) continue
        const sdB = frameSD(fb, p)
        if (!Number.isFinite(sdB)) continue
        dev = Math.max(dev, devSample)
        onSurface = Math.max(onSurface, Math.abs(sdA), Math.abs(sdB))
        edgeSamples++
      }
      // THIS shared boundary yielded nothing. Another edge's samples do not speak for it.
      if (edgeSamples === 0) return null
      samples += edgeSamples
      edges++
    }
    if (edges === 0) return null
    // Belt to the per-sample braces above: those guards should make this unreachable, but a
    // verdict this consequential (it admits or refuses a boundary as G1-tangent) does not get
    // to depend solely on every future sampling path remembering to check upstream. Guard the
    // value actually returned, not just the values that built it.
    if (!Number.isFinite(dev) || !Number.isFinite(onSurface)) return null
    return { dev, onSurface, samples, edges, degenerateEdges }
  } catch { return null } finally { for (const e of es) { try { k.release(e) } catch { /* */ } } }
}

/**
 * Verify G1 across the boundary shared by two ribbon members. Returns the named refusal
 * that closes the whole blend, or null when tangency is VERIFIED (never "assumed").
 *
 * Every caller in the chain walk routes through here, so there is exactly one place where
 * a shared ribbon boundary can be judged, and it has no success path that skips a check.
 */
function verifyG1Boundary(k: OcctKernel, a: FaceRec, fa: AnalyticFrame, b: FaceRec, fb: AnalyticFrame): BlendResult | null {
  const g1 = measureG1(k, a, fa, b, fb)
  if (!g1) {
    return blendRefusal('a shared ribbon boundary carries no sampleable tangent data (degenerate or unreadable edge) — G1 continuity is unverified')
  }
  if (g1.onSurface > BLEND_GEOM_TOL) {
    return blendRefusal(`a shared ribbon boundary lies ${round(g1.onSurface, 9)} mm off the analytic frames it is supposed to bound — the frames cannot be trusted to answer tangency`)
  }
  if (g1.dev > BLEND_G1_TOL) {
    const deg = round((Math.acos(Math.max(-1, Math.min(1, 1 - g1.dev))) * 180) / Math.PI, 4)
    return blendRefusal(`a same-radius ${b.type} neighbour meets the chain at ${deg} deg, not tangentially (G1 deviation ${g1.dev.toExponential(3)} > ${BLEND_G1_TOL}) — equal radius and adjacency do not make a G1 tangent chain`)
  }
  return null
}

function sharesEdgeWith(k: OcctKernel, a: FaceRec, b: FaceRec): boolean {
  const es = sharedEdgesSafe(k, a.handle, b.handle)
  const n = es.length
  for (const e of es) { try { k.release(e) } catch { /* */ } }
  return n > 0
}

/** The apex of a cone runout cap: the single vertex of its zero-length (degenerate) edge. */
function coneApex(k: OcctKernel, cap: FaceRec): Vec3 | null {
  let w: ShapeHandle | null = null
  try {
    w = k.outerWire(cap.handle)
    const es = k.getSubShapes(w, 'edge')
    try {
      for (const e of es) {
        let len = NaN
        try { len = k.getLength(e) } catch { /* */ }
        if (len > 1e-9) continue
        const vs = k.getSubShapes(e, 'vertex')
        try { if (vs.length) return k.vertexPosition(vs[0]) } finally { for (const v of vs) { try { k.release(v) } catch { /* */ } } }
      }
    } finally { for (const e of es) { try { k.release(e) } catch { /* */ } } }
    return null
  } catch { return null } finally { if (w) { try { k.release(w) } catch { /* */ } } }
}

/** Midpoint of the (unique) edge shared by two faces — used to orient the sharp arc. */
function sharedEdgeMidpoint(k: OcctKernel, a: FaceRec, b: FaceRec): Vec3 | null {
  const es = sharedEdgesSafe(k, a.handle, b.handle)
  try {
    if (es.length !== 1) return null
    const cp = k.curveParameters(es[0])
    return k.curvePointAtParam(es[0], (cp.first + cp.last) / 2)
  } catch { return null } finally { for (const e of es) { try { k.release(e) } catch { /* */ } } }
}

function cmpVec(a: Vec3, b: Vec3): number {
  return (round(a.x, 6) - round(b.x, 6)) || (round(a.y, 6) - round(b.y, 6)) || (round(a.z, 6) - round(b.z, 6))
}

/**
 * Decide whether `seed` (a torus) is the blend of an analytic ribbon this code can
 * reconstruct EXACTLY, and if so solve the sharp geometry. Ported from the GEO-6X4
 * probe (tools/probes/geo-6x4/03-reconstruct.mjs), which proved the construction on
 * Tray.step face #223.
 *
 * The gates below ARE the class boundary. Each one that fails returns a named refusal
 * rather than an approximation, per GEO-6X4 F3 (the class is not closed under G1
 * chaining, and the four-plane concurrency is a property of THIS runout shape, not a
 * theorem).
 */
export function analyzeBlendRibbon(k: OcctKernel, byHash: Map<number, FaceRec>, seed: FaceRec, cache: Map<number, AnalyticFrame | null>, owners: Map<number, number[]>): BlendResult {
  const td = frameOf(k, seed, cache)
  if (!td || td.kind !== 'torus') return blendRefusal('the torus frame could not be derived from surface samples')
  if (!td.frameConsistent) return blendRefusal('inconsistent torus frame — two independent minor-radius derivations disagree (variable-radius or non-toroidal blend)')
  const RB = td.minorR
  if (!Number.isFinite(RB) || RB <= 1e-9) return blendRefusal(`degenerate blend radius ${round(RB, 6)}`)

  // 1) walk the G1 tangent chain: faces of the SAME blend radius r. The torus cannot be
  //    removed alone — it is tangent-continuous with its fillet cylinders (F3).
  //
  //    GEO-6X5-R1 (audit major 1): surface TYPE + equal RADIUS + ADJACENCY are the
  //    NECESSARY conditions for membership, never the sufficient ones. A cylinder that
  //    merely happens to share the torus's minor radius and touch it along a hard,
  //    transverse edge satisfies all three, and before that gate it walked straight into
  //    the candidate removal set — even though the whole downstream construction (the
  //    sharp-arc solve, the untrim, the four-plane concurrency) presumes the chain is
  //    G1. Membership REQUIRES verified tangency along every shared ribbon boundary,
  //    and anything that cannot be verified refuses closed. See measureG1().
  //
  //    GEO-6X5-R2 (the major on R1's audit) closes the ways a boundary could still go
  //    UNMEASURED. R1 verified tangency wherever it looked, but three paths let it not
  //    look, and a gate you can walk around is not a gate:
  //      (a) a neighbour whose analytic frame failed to derive was silently skipped, so an
  //          adjacent same-radius cylinder could satisfy every admission criterion and
  //          bypass the measurement. A cylinder's radius has a SECOND, frame-independent
  //          source (the kernel's getFaceCylinderData, kept in FaceRec.radius), so
  //          candidacy is now settled before the frame is ever required.
  //      (b) an adjacent torus whose minor radius could not be derived was likewise
  //          skipped. It now refuses, by the same rule and for the same reason.
  //      (c) the walk verified a spanning TREE of the ribbon's adjacency graph; a second
  //          shared boundary between two admitted members was never measured. It is now.
  //
  //    Below, every `continue` is annotated. Exactly THREE of them bypass the G1
  //    measurement, and each rests on a fact the kernel gave us rather than on a fact we
  //    failed to obtain: one on a surface TYPE the kernel read, two on a RADIUS we read.
  //    The fourth (the already-admitted branch) continues only AFTER verifying its
  //    boundary. Every other outcome is a named refusal.
  const ribbon = new Set<number>([seed.hash])
  const queue: FaceRec[] = [seed]
  let toriInChain = 1
  while (queue.length) {
    const cur = queue.shift()!
    const curFr = frameOf(k, cur, cache)
    if (!curFr) return blendRefusal('a chain member\'s analytic frame could not be derived, so its tangency cannot be verified')
    for (const nh of cur.neighbours) {
      const nb = byHash.get(nh)

      // NOT provably unreachable: `recs` is a caller-supplied parameter of
      // recognizeFeatures(), so the face map is not guaranteed to cover the body being
      // walked. A neighbour we cannot even look up is a membership question we cannot
      // answer, and the invariant answers those by refusing. (Tray: never taken.)
      if (!nb) return blendRefusal('a neighbouring face is missing from the face map, so its ribbon membership cannot be decided')

      // An ALREADY-ADMITTED neighbour is still a shared ribbon boundary. The walk verifies
      // a spanning TREE of the ribbon's adjacency graph; every non-tree edge of that graph
      // is a second boundary between two members, and skipping it left it unverified. The
      // invariant is "every shared ribbon boundary", not "every edge the walk arrived by",
      // so it is measured here too — and never re-queued. (Tray: 28 such boundaries exist,
      // all tangent to 4.441e-16; see the calibration probe's nonTreeBoundaries.)
      if (ribbon.has(nh)) {
        const memberFr = frameOf(k, nb, cache)
        if (!memberFr) return blendRefusal('a chain member\'s analytic frame could not be derived, so its tangency cannot be verified')
        const bad = verifyG1Boundary(k, cur, curFr, nb, memberFr)
        if (bad) return bad
        continue
      }

      // `type` is 'other' EXACTLY when gatherFaces()'s surfaceType() call threw — the kernel
      // names every surface it recognizes, including 'sphere' and 'bspline'. So this is an
      // UNREAD type, not an exotic one, and it cannot be classified as a non-member.
      if (nb.type === 'other') {
        return blendRefusal('a neighbouring face\'s surface type could not be read, so its ribbon membership cannot be decided')
      }
      // PROVABLY NON-MEMBER. The class is one torus G1-chained to cylinders of radius r; a
      // plane, cone, sphere, bspline or swept neighbour is not a ribbon member at ANY
      // tangency, so the boundary it shares with the chain is not a ribbon boundary at all.
      // (This is the gate that keeps the cone runout caps out of the ribbon.)
      if (nb.type !== 'cylinder' && nb.type !== 'torus') continue

      const fr = frameOf(k, nb, cache)

      // ---- membership candidacy, decided BEFORE the frame is required (audit major) ----
      // Type + radius + adjacency are the NECESSARY conditions. Establishing that a
      // neighbour fails them is what licenses a skip; failing to establish it is not.
      if (nb.type === 'torus') {
        // A torus's minor radius has ONE derivation here, the sampled analytic frame. If it
        // cannot be derived — no frame, or two independent derivations that disagree — then
        // whether this torus is a same-radius chain member is UNKNOWN, and an unknown member
        // is exactly what the pre-R1 gate used to wave through. Refuse, never skip.
        if (!fr || fr.kind !== 'torus') {
          return blendRefusal('an adjacent torus\'s analytic frame could not be derived, so its minor radius is unknown and its ribbon membership cannot be decided')
        }
        if (!fr.frameConsistent) {
          return blendRefusal('an adjacent torus\'s minor radius could not be derived — two independent derivations disagree (variable-radius or non-toroidal) — so its ribbon membership cannot be decided')
        }
        if (!Number.isFinite(fr.minorR)) {
          return blendRefusal('an adjacent torus\'s minor radius is not finite, so its ribbon membership cannot be decided')
        }
        if (Math.abs(fr.minorR - RB) > BLEND_RADIUS_TOL) continue   // provably non-member: radius differs
      } else {
        // A cylinder's radius has TWO independent sources: the kernel's own analytic
        // getFaceCylinderData (FaceRec.radius, read in gatherFaces) and the sampled frame.
        // The FaceRec radius alone settles candidacy, so a same-radius adjacent cylinder can
        // no longer duck the G1 measurement merely because its frame failed to derive.
        const rRec = Number.isFinite(nb.radius) ? nb.radius! : NaN
        const rFrm = fr && fr.kind === 'cylinder' ? fr.radius : NaN
        if (!Number.isFinite(rRec) && !Number.isFinite(rFrm)) {
          return blendRefusal('an adjacent cylinder\'s radius could not be derived from either its analytic frame or the kernel surface data, so its ribbon membership cannot be decided')
        }
        // Same-radius per EITHER source makes it a candidate. Skipping requires that every
        // radius we were able to read disagrees with r — then it is provably non-member.
        const sameRadius = (Number.isFinite(rRec) && Math.abs(rRec - RB) <= BLEND_RADIUS_TOL)
          || (Number.isFinite(rFrm) && Math.abs(rFrm - RB) <= BLEND_RADIUS_TOL)
        if (!sameRadius) continue   // provably non-member: every readable radius differs
        if (!fr || fr.kind !== 'cylinder') {
          return blendRefusal('a same-radius adjacent cylinder\'s analytic frame could not be derived, so its tangency cannot be verified')
        }
      }

      // ---- the G1 gate: fail CLOSED on anything unverified ----
      const bad = verifyG1Boundary(k, cur, curFr, nb, fr)
      if (bad) return bad

      ribbon.add(nh); queue.push(nb)
      if (nb.type === 'torus') toriInChain++
    }
  }
  if (toriInChain !== 1) return blendRefusal(`the tangent chain contains ${toriInChain} tori — a chained multi-torus ribbon is not the single-torus class`)
  const ribbonCyls = [...ribbon].filter((h) => byHash.get(h)?.type === 'cylinder')
  if (ribbon.size !== 3 || ribbonCyls.length !== 2) {
    return blendRefusal(`the tangent chain is ${ribbon.size} face(s) (${ribbonCyls.length} cylinder(s)) — the class is one torus G1-chained to exactly two fillet cylinders of radius r`)
  }

  // 2) the ribbon must be capped by exactly two CONE runouts. They are not tangent to
  //    the ribbon (cone half-angle 45deg vs the cylinder's radial normal) so they can
  //    never be re-trimmed to the sharp corner: they are removed, not rebuilt.
  const caps = new Set<number>()
  for (const h of ribbon) {
    for (const nh of byHash.get(h)!.neighbours) {
      if (ribbon.has(nh)) continue
      if (byHash.get(nh)?.type === 'cone') caps.add(nh)
    }
  }
  if (caps.size !== 2) return blendRefusal(`${caps.size} cone runout cap(s) — the class is capped by exactly 2 (a spherical cap or a bspline runout refuses here)`)

  // 3) the walls: everything adjacent to the removal set that survives.
  const removed = new Set<number>([...ribbon, ...caps])
  const walls = new Set<number>()
  for (const h of removed) for (const nh of byHash.get(h)!.neighbours) if (!removed.has(nh)) walls.add(nh)
  if (walls.size !== 8) return blendRefusal(`${walls.size} wall faces — the class rebuilds exactly 8 (1 cylinder + 1 end plane + 2 side planes + 4 chamfer planes)`)
  const wallRecs: FaceRec[] = []
  for (const h of walls) {
    const w = byHash.get(h)
    if (!w) return blendRefusal('a wall face is missing from the face map')
    if (w.type !== 'plane' && w.type !== 'cylinder') return blendRefusal(`a wall face has surface type '${w.type}' — only planes and one channel cylinder are in the class`)
    wallRecs.push(w)
  }

  // 4) classify the walls analytically.
  const cylWalls = wallRecs.filter((w) => w.type === 'cylinder')
  if (cylWalls.length !== 1) return blendRefusal(`${cylWalls.length} cylinder walls — the class has exactly one channel cylinder`)
  const cylRec = cylWalls[0]
  const CYL = frameOf(k, cylRec, cache)
  if (!CYL || CYL.kind !== 'cylinder') return blendRefusal('the channel cylinder frame could not be derived')
  if (!(CYL.radius > 2 * RB)) return blendRefusal(`channel cylinder radius ${round(CYL.radius, 4)} is not greater than 2r (${round(2 * RB, 4)}) — it is a ribbon member, not a wall`)

  const planeRecs = wallRecs.filter((w) => w.type === 'plane')
  const pf = new Map<number, PlaneFrame>()
  for (const p of planeRecs) {
    const fr = frameOf(k, p, cache)
    if (!fr || fr.kind !== 'plane') return blendRefusal('a wall plane frame could not be derived')
    pf.set(p.hash, fr)
  }
  const ends = planeRecs.filter((p) => Math.abs(Math.abs(dot(pf.get(p.hash)!.normal, CYL.axisDir)) - 1) < BLEND_DIR_TOL)
  if (ends.length !== 1) return blendRefusal(`${ends.length} end planes perpendicular to the cylinder axis (expected exactly 1)`)
  const endRec = ends[0]
  const END = pf.get(endRec.hash)!
  const sides = planeRecs.filter((p) => p.hash !== endRec.hash && sharesEdgeWith(k, p, cylRec))
  if (sides.length !== 2) return blendRefusal(`${sides.length} side planes share an edge with the channel cylinder (expected 2)`)
  const chamfers = planeRecs.filter((p) => p.hash !== endRec.hash && !sides.some((s) => s.hash === p.hash))
  if (chamfers.length !== 4) return blendRefusal(`${chamfers.length} chamfer planes (expected 4)`)

  // The torus must be the fillet that blends the channel cylinder into the end plane —
  // that is what makes the sharp boundary the transversal (cylinder INTERSECT endPlane) arc.
  if (!seed.neighbours.includes(cylRec.hash) || !seed.neighbours.includes(endRec.hash)) {
    return blendRefusal('the torus does not blend the channel cylinder into the end plane')
  }

  // 5) the sharp arc's centre O: the cylinder axis pierced at the end plane.
  const denom = dot(END.normal, CYL.axisDir)
  if (Math.abs(denom) < 0.5) return blendRefusal('the end plane is not transversal to the cylinder axis')
  const O = add(CYL.axisPoint, scale(CYL.axisDir, (END.d - dot(END.normal, CYL.axisPoint)) / denom))

  // 6) TANGENCY gate: each side plane is parallel to the cylinder axis and exactly
  //    rCyl away from it. This is the very tangency that makes the (cylinder, sidePlane,
  //    endPlane) triple SINGULAR — see GUARD 2 below and GEO-6X4 F1.
  for (const s of sides) {
    const SP = pf.get(s.hash)!
    if (Math.abs(dot(SP.normal, CYL.axisDir)) > BLEND_DIR_TOL) return blendRefusal('a side plane is not parallel to the channel cylinder axis')
    const gap = Math.abs(planeSD(SP, O))
    if (Math.abs(gap - CYL.radius) > BLEND_GEOM_TOL) return blendRefusal(`a side plane is not tangent to the channel cylinder (distance ${round(gap, 6)} vs radius ${round(CYL.radius, 6)})`)
  }

  // 7) per runout cap: the tangency point (closed form) and the corner point (transversal).
  const corners: BlendCorner[] = []
  for (const capHash of [...caps].sort((a, b) => a - b)) {
    const cap = byHash.get(capHash)!
    const ribCylHits = cap.neighbours.filter((h) => ribbon.has(h) && byHash.get(h)?.type === 'cylinder')
    if (ribCylHits.length !== 1) return blendRefusal(`a runout cap meets ${ribCylHits.length} ribbon cylinders (expected 1)`)
    const ribCyl = byHash.get(ribCylHits[0])!
    const sideHits = sides.filter((s) => sharesEdgeWith(k, s, ribCyl))
    if (sideHits.length !== 1) return blendRefusal(`a runout cap's fillet cylinder meets ${sideHits.length} side planes (expected 1)`)
    const side = sideHits[0]
    const SP = pf.get(side.hash)!
    const chams = cap.neighbours.filter((h) => chamfers.some((c) => c.hash === h)).map((h) => byHash.get(h)!)
    if (chams.length !== 2) return blendRefusal(`a runout cap meets ${chams.length} chamfer planes (expected 2)`)
    const overSideHits = chams.filter((c) => sharesEdgeWith(k, c, side))
    if (overSideHits.length !== 1) return blendRefusal(`${overSideHits.length} chamfer planes lie over the side plane (expected 1)`)
    const overSide = overSideHits[0]
    const overEnd = chams.find((c) => c.hash !== overSide.hash)!
    if (!sharesEdgeWith(k, overEnd, endRec)) return blendRefusal('the second chamfer plane does not meet the end plane')

    // MANDATORY GUARD 2 (GEO-6X4 F1), part 1: the tangency point comes from a CLOSED-FORM
    // orthogonal projection of the arc centre onto the side plane — exact, no iteration.
    // Solving (cylinder, sidePlane, endPlane) for it, as CORNER-BLEND-RESEARCH.md step 4
    // prescribed, is SINGULAR BY CONSTRUCTION (det(J) == 0 exactly at the true point) and
    // a perturbed seed merely makes it ill-conditioned, so Newton "converges" to a wrong
    // point with no error signal. Never solve that triple.
    const tangency = projectToPlane(SP, O)
    if (Math.abs(cylinderSD(CYL, tangency)) > BLEND_GEOM_TOL) return blendRefusal('the tangency point does not lie on the channel cylinder')
    if (Math.abs(planeSD(END, tangency)) > BLEND_GEOM_TOL) return blendRefusal('the tangency point does not lie on the end plane')

    // MANDATORY GUARD 2, part 2: the corner point comes from a STRUCTURALLY TRANSVERSAL
    // triple (endPlane, sidePlane, chamferPlane). All three are planes, so F is affine and
    // the solve is exact in one iteration from any seed. The triple is chosen structurally,
    // never selected by a determinant threshold.
    const sol = solveTriplePoint(END, SP, pf.get(overSide.hash)!, add(tangency, scale(END.normal, -RB)))
    if (!sol.ok) return blendRefusal(`the corner solve failed: ${sol.reason}`)

    // The INDEPENDENT class gate: the fourth plane must pass through the same point.
    // Four-plane concurrency is a property of this runout shape, not a theorem — a
    // non-concurrent chamfer refuses here rather than being approximated.
    const concurrency = Math.abs(planeSD(pf.get(overEnd.hash)!, sol.point))
    if (concurrency > BLEND_GEOM_TOL) return blendRefusal(`the chamfer planes are not concurrent at the corner point (fourth-plane residual ${round(concurrency, 9)} mm)`)

    const apex = coneApex(k, cap)
    if (!apex) return blendRefusal('a runout cap has no apex (degenerate) edge — the runout is not a cone')
    if (Math.abs(planeSD(pf.get(overSide.hash)!, apex)) > BLEND_GEOM_TOL || Math.abs(planeSD(pf.get(overEnd.hash)!, apex)) > BLEND_GEOM_TOL) {
      return blendRefusal('the runout cone apex does not lie on both chamfer planes')
    }

    // Survivor endpoints. Each must come from an edge UNIQUELY shared by the two named wall
    // faces; if it does not, the wall boundary is ambiguous and the ribbon is not
    // reconstructible (refused below rather than promised and then failed at heal time).
    const farCyl = farVert(k, cylRec, side, tangency, owners)          // cylinder <-> side plane
    const farSide = farVert(k, side, overSide, sol.point, owners)      // side <-> chamfer over side
    const farLip = farVert(k, endRec, overEnd, sol.point, owners)      // end <-> chamfer over end
    if (!farCyl || !farSide || !farLip) return blendRefusal('a survivor boundary edge is not uniquely shared between its two wall faces')

    corners.push({
      capHash, ribCylHash: ribCyl.hash, sideHash: side.hash, overSideHash: overSide.hash, overEndHash: overEnd.hash,
      tangency, corner: sol.point, apex, det: sol.det, residual: sol.residual, concurrency,
      farCyl, farSide, farLip,
    })
  }
  if (corners.length !== 2) return blendRefusal(`${corners.length} runout corners resolved (expected 2)`)
  if (corners[0].sideHash === corners[1].sideHash) return blendRefusal('both runout corners resolve to the same side plane')
  // deterministic, geometry-derived order (hashes are ephemeral; geometry is not).
  corners.sort((a, b) => cmpVec(a.tangency, b.tangency))

  // 8) the sharp arc's third point: on the far side of the axis from the two tangencies,
  //    picked by comparing against the ORIGINAL torus/cylinder shared edge.
  const radial0 = unit(sub(corners[0].tangency, O))
  const perp = unit(cross(END.normal, radial0))
  if (norm(perp) < 0.5) return blendRefusal('degenerate sharp-arc frame')
  const candA = add(O, scale(perp, CYL.radius))
  const candB = add(O, scale(perp, -CYL.radius))
  const mid = sharedEdgeMidpoint(k, cylRec, seed)
  if (!mid) return blendRefusal('the original cylinder/torus shared edge could not be sampled')
  const axisPerp = (p: Vec3): Vec3 => { const d = sub(p, CYL.axisPoint); return unit(sub(d, scale(CYL.axisDir, dot(d, CYL.axisDir)))) }
  const midDir = axisPerp(mid)
  const arcDeep = dot(axisPerp(candA), midDir) > dot(axisPerp(candB), midDir) ? candA : candB
  if (Math.abs(cylinderSD(CYL, arcDeep)) > BLEND_GEOM_TOL || Math.abs(planeSD(END, arcDeep)) > BLEND_GEOM_TOL) {
    return blendRefusal('the sharp arc\'s deep point does not lie on the cylinder INTERSECT end-plane circle')
  }

  // the seed torus leads dropHashes so `faceIds[0]` is always the torus itself.
  const others = [...ribbon].filter((h) => h !== seed.hash).sort((a, b) => a - b)
  const capList = [...caps].sort((a, b) => a - b)
  const plan: BlendRibbonPlan = {
    torusHash: seed.hash,
    blendRadius: RB,
    removeHashes: [seed.hash, ...others, ...capList],
    wallHashes: [...walls].sort((a, b) => a - b),
    cylinderHash: cylRec.hash,
    endPlaneHash: endRec.hash,
    arcCenter: O,
    arcDeep,
    corners,
  }

  // 9) CONSTRUCTIBILITY is part of the class, not an afterthought. Passing every analytic
  //    gate above proves the sharp geometry EXISTS; it does not prove this code can re-wire
  //    the eight wall boundaries to reach it. Resolve the 14 survivor edges now and refuse
  //    if any is ambiguous, so `removable: true` never over-promises what the heal delivers.
  //    (On Tray.step this is the gate that separates the 9 reconstructible ribbons from the
  //    24 that sit on a large shared end plane with several circular boundaries.)
  const constructible = blendIsConstructible(k, byHash, plan, owners)
  if (!constructible.ok) return blendRefusal(`the wall boundary cannot be uniquely re-wired to the sharp corner (${constructible.reason})`)

  return { ok: true, plan }
}

function blendFeature(seed: FaceRec, plan: BlendRibbonPlan): RecognizedFeature {
  return {
    // SAME key grammar as the refusal it replaces, so an accept-mask minted against the
    // pre-GEO-6X5 verdict list still resolves to this feature.
    key: `curved:${round(seed.centroid.x)}:${round(seed.centroid.y)}:${round(seed.centroid.z)}`,
    type: 'filletCurvedCorner',
    dropHashes: plan.removeHashes,
    untrimHashes: plan.wallHashes,
    hostRemovals: [],
    neighbourHashes: plan.wallHashes,
    // the fillet rounded a CONVEX material edge, so sharpening ADDS material back.
    effect: 'add',
    removable: true,
    params: {
      centerX: round(seed.centroid.x), centerY: round(seed.centroid.y), centerZ: round(seed.centroid.z),
      area: round(seed.area, 3), radius: round(plan.blendRadius, 6),
      cylinderRadius: round((plan.corners.length ? dist(plan.corners[0].tangency, plan.arcCenter) : 0), 6),
      removedFaces: plan.removeHashes.length, wallFaces: plan.wallHashes.length,
      sharp: 'analyticBlendRibbon',
    },
    fingerprint: { cx: round(seed.centroid.x), cy: round(seed.centroid.y), cz: round(seed.centroid.z), nx: round(seed.normal.x), ny: round(seed.normal.y), nz: round(seed.normal.z), kind: 'filletCurvedCorner' },
    blendPlan: plan,
  }
}

function bandFeature(band: FaceRec, planarNbrs: FaceRec[], type: FeatureType, untrimmable: boolean, radius?: number): RecognizedFeature {
  return {
    key: `band:${type}:${round(band.centroid.x)}:${round(band.centroid.y)}:${round(band.centroid.z)}`,
    type,
    dropHashes: [band.hash],
    untrimHashes: untrimmable ? planarNbrs.map((n) => n.hash) : [],
    hostRemovals: [],
    neighbourHashes: planarNbrs.map((n) => n.hash),
    effect: 'add',
    removable: untrimmable,
    refuseReason: untrimmable ? undefined : 'band neighbours are not axis-aligned on the body bbox: general planar-neighbour untrim (plane-plane sharp loop) is not yet in V1 scope',
    params: { centerX: round(band.centroid.x), centerY: round(band.centroid.y), centerZ: round(band.centroid.z), radius: round(radius ?? 0, 3), neighbours: planarNbrs.length },
    fingerprint: { cx: round(band.centroid.x), cy: round(band.centroid.y), cz: round(band.centroid.z), nx: round(band.normal.x), ny: round(band.normal.y), nz: round(band.normal.z), kind: type },
  }
}

/**
 * GEO-7: recognize a fillet/chamfer band whose two main planar neighbours are at
 * ANY orientation. `planUntrim` finds the pair to extend to their plane-plane
 * intersection line; on success the band is removable with an `untrimPlan`, on
 * failure it is REFUSED STRUCTURED (parallel planes, tilted end faces, or an
 * ambiguous/absent pair) — never crashed, never a broken solid.
 */
function bandFeatureGeneral(k: OcctKernel, band: FaceRec, planarNbrs: FaceRec[], type: FeatureType, radius?: number): RecognizedFeature {
  const base = {
    key: `band:${type}:${round(band.centroid.x)}:${round(band.centroid.y)}:${round(band.centroid.z)}`,
    type,
    dropHashes: [band.hash],
    hostRemovals: [] as Array<{ hostHash: number; loopIndex: number }>,
    neighbourHashes: planarNbrs.map((n) => n.hash),
    effect: 'add' as const,
    params: { centerX: round(band.centroid.x), centerY: round(band.centroid.y), centerZ: round(band.centroid.z), radius: round(radius ?? 0, 3), neighbours: planarNbrs.length } as Record<string, number | string>,
    fingerprint: { cx: round(band.centroid.x), cy: round(band.centroid.y), cz: round(band.centroid.z), nx: round(band.normal.x), ny: round(band.normal.y), nz: round(band.normal.z), kind: type },
  }
  const plan = planUntrim(k, band, planarNbrs)
  if (!plan.ok) {
    return { ...base, untrimHashes: [], removable: false, refuseReason: plan.reason }
  }
  return {
    ...base,
    untrimHashes: [plan.plan.planeA, plan.plan.planeB, ...plan.plan.endFaces],
    untrimPlan: plan.plan,
    removable: true,
    params: { ...base.params, sharp: 'planeIntersection' },
  }
}

type PlanResult = { ok: true; plan: UntrimPlan } | { ok: false; reason: string }

/**
 * Select the two planar neighbours to extend to their plane-plane intersection
 * line (the sharp edge the band replaced), plus any axis-aligned end faces to
 * bbox-untrim. The MAIN pair is the two planar neighbours whose plane-plane
 * intersection line L is parallel to a STRAIGHT edge each shares with the band:
 *  - a fillet is tangent to its two main faces along straight lines (parallel to
 *    L); its end faces meet the band along arcs (no straight shared edge).
 *  - a chamfer strip shares straight LONG edges (parallel to L) with the two
 *    bevelled faces, and short end edges (not parallel to L) with the end faces.
 * Parallel main planes (no intersection) or a tilted end face -> structured refusal.
 */
function planUntrim(k: OcctKernel, band: FaceRec, planarNbrs: FaceRec[]): PlanResult {
  const sorted = [...planarNbrs].sort((a, b) => a.hash - b.hash)
  const dirs = new Map<number, Vec3>()
  for (const nb of sorted) { const d = straightSharedDir(k, band.handle, nb.handle); if (d) dirs.set(nb.hash, d) }
  const cand = sorted.filter((nb) => dirs.has(nb.hash))
  let mainPair: [FaceRec, FaceRec] | null = null
  let parallelSeen = false
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      const a = cand[i], b = cand[j]
      const da = dirs.get(a.hash)!, db = dirs.get(b.hash)!
      const cr = cross(a.normal, b.normal)
      if (norm(cr) < 1e-4) {
        // parallel planes: only a band-SPANNING pair (shared edges parallel) counts.
        if (parallelDir(da, db)) parallelSeen = true
        continue
      }
      const dL = unit(cr)
      if (parallelDir(da, dL) && parallelDir(db, dL)) {
        if (mainPair) return { ok: false, reason: 'ambiguous planar-neighbour pair: more than one plane-plane intersection candidate' }
        mainPair = [a, b]
      }
    }
  }
  if (!mainPair) {
    if (parallelSeen) return { ok: false, reason: 'parallel planar neighbours: the two faces never meet (no plane-plane intersection line) — structured refusal' }
    return { ok: false, reason: 'no valid planar-neighbour pair for plane-plane untrim (need two non-parallel planar faces sharing a straight edge with the band)' }
  }
  const [pa, pb] = mainPair
  const rest = planarNbrs.filter((nb) => nb.hash !== pa.hash && nb.hash !== pb.hash)
  return {
    ok: true,
    plan: {
      planeA: Math.min(pa.hash, pb.hash),
      planeB: Math.max(pa.hash, pb.hash),
      bandHash: band.hash,
      endFaces: rest.map((n) => n.hash).sort((a, b) => a - b),
    },
  }
}

/** Direction of the longest STRAIGHT edge shared between `band` and `nbr`, or
 *  null if they share no straight edge (e.g. a fillet's arc-only end contact). */
function straightSharedDir(k: OcctKernel, band: ShapeHandle, nbr: ShapeHandle): Vec3 | null {
  const es = sharedEdgesSafe(k, band, nbr)
  let best: Vec3 | null = null
  let bestLen = 0
  try {
    for (const e of es) {
      let kind = 'other'
      try { kind = k.curveType(e) } catch { /* keep other */ }
      if (kind !== 'line') continue
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length >= 2) {
        const a = k.vertexPosition(vs[0]); const b = k.vertexPosition(vs[vs.length - 1])
        const d = sub(b, a); const len = norm(d)
        if (len > bestLen) { bestLen = len; best = unit(d) }
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
  } finally { for (const e of es) { try { k.release(e) } catch { /* */ } } }
  return best
}

function sharedEdgesSafe(k: OcctKernel, a: ShapeHandle, b: ShapeHandle): ShapeHandle[] {
  try { return k.sharedEdges(a, b) } catch { return [] }
}

function tagEngravedText(features: RecognizedFeature[]): void {
  const byHost = new Map<number, RecognizedFeature[]>()
  for (const ft of features) {
    if (ft.type !== 'pocket') continue
    const host = ft.hostRemovals[0]?.hostHash
    if (host === undefined) continue
    byHost.set(host, [...(byHost.get(host) ?? []), ft])
  }
  for (const group of byHost.values()) {
    if (group.length >= 3) for (const ft of group) ft.type = 'engravedText'
  }
}

// ---------- geometry predicates ----------
function partialCylinder(f: FaceRec): boolean { return f.uSpan === undefined ? true : f.uSpan < 1.9 * Math.PI }
/** GEO-7: a chamfer facet is a long, narrow strip. Gate the general (tilted)
 *  chamfer path on the face's IN-PLANE extent ratio (major/minor of its uv-box)
 *  so a large tilted plane (ramp or roof face) is not mistaken for a bevel strip.
 *  GEO-7-R1: uses the plane-local `planeExtent` (rotation-INVARIANT), not the
 *  world-axis bbox diagonal — under an arbitrary body rotation the world bbox of a
 *  broad face inflates and misreads it as a strip (four false chamfer bands on the
 *  rotated fixture). For a thin rectangle L x w, world diag^2/area = L/w + w/L ~=
 *  L/w = the in-plane ratio, so the accepted axis-aligned facet is unchanged. */
const CHAMFER_STRIP_ASPECT = 4
function isThinStrip(f: FaceRec): boolean {
  const e = f.planeExtent
  return !!e && e.minor > 1e-6 && e.major / e.minor > CHAMFER_STRIP_ASPECT
}
function axialSpan(cluster: FaceRec[], axis: Vec3): number {
  let lo = Infinity, hi = -Infinity
  for (const c of cluster) for (const corner of bboxCorners(c.bbox)) { const t = dot(corner, axis); lo = Math.min(lo, t); hi = Math.max(hi, t) }
  return hi - lo
}
function bboxCorners(b: BBox): Vec3[] {
  const xs = [b.xmin, b.xmax], ys = [b.ymin, b.ymax], zs = [b.zmin, b.zmax], out: Vec3[] = []
  for (const x of xs) for (const y of ys) for (const z of zs) out.push({ x, y, z })
  return out
}
/**
 * GEO-11-R2 (blocker 1, CONSERVATIVE-OR-REFUSE): a PROVEN upper bound on the
 * maximum radial distance from the hole axis (`center`, `dir`) to any point on
 * `f`'s outer boundary, or `Infinity` when that bound cannot be proven.
 *
 * The consumer (capWithinFootprint) DROPS a face into the hole's cap set when its
 * extent <= thr. UNDERSTATING the extent is the defect: a structural slab read as
 * small is mis-classified as a cap and dropped, resurrecting the plate-top open
 * shell (BK-97). So this returns an UPPER bound and NEVER understates. Overstating
 * only EXCLUDES a face (it stays in the sew set); if that breaks a legitimate heal
 * the final watertight gate REFUSES it loudly — the safe direction. ANY geometry
 * read failure (axis, wire, edge, curve, pole) returns Infinity (fail-closed).
 *
 * There is NO non-conservative fallback: the R1 planeExtent and bbox-corner
 * estimates are DELETED. The audit reproduced blocker 1 precisely through them —
 * planeExtent under-stated a 24x24 slab (dropped the plate top) and the bbox
 * corners over-stated a circular cap by sqrt(2) (excluded a legitimate d20
 * shoulder). Both are gone; a face whose outer wire cannot be read is Infinity.
 *
 * Per boundary edge, `edgeRadialBound` gives a conservative bound: a line's max is
 * at an endpoint (exact); a circle is recovered exactly from three samples and
 * bounded by |perp(centre)| + the projected circle's semi-major axis (tight — a
 * concentric coaxial cap returns its true R, not R*sqrt(2)); anything else is
 * bounded by its NURBS control polygon (a between-samples extremum the old fixed
 * 17-point sampling missed lives inside that hull). Exported for the R2
 * conservative-or-refuse tests.
 */
export function capRadialExtent(k: OcctKernel, f: FaceRec, center: Vec3, dir: Vec3): number {
  const axis = unit(dir)
  if (norm(axis) < 0.5) return Infinity            // no usable axis -> cannot bound
  let w: ShapeHandle | null = null
  let es: ShapeHandle[] = []
  try {
    w = k.outerWire(f.handle)
    es = k.getSubShapes(w, 'edge')
    if (es.length === 0) return Infinity           // no boundary to bound against
    let max = -Infinity
    for (const e of es) {
      const b = edgeRadialBound(k, e, center, axis)
      if (!Number.isFinite(b)) return Infinity     // any unbounded/unreadable edge -> fail closed
      max = Math.max(max, b)
    }
    return Number.isFinite(max) && max >= 0 ? max : Infinity
  } catch {
    return Infinity                                // wire / edge enumeration failed -> fail closed
  } finally {
    for (const e of es) { try { k.release(e) } catch { /* */ } }
    if (w) { try { k.release(w) } catch { /* */ } }
  }
}

/**
 * Conservative upper bound on max perpDist(point-on-edge, axis line), or Infinity
 * when the edge geometry cannot be read or a conservative bound cannot be proven.
 */
function edgeRadialBound(k: OcctKernel, e: ShapeHandle, center: Vec3, axis: Vec3): number {
  let kind: CurveKind
  try { kind = k.curveType(e) } catch { return Infinity }
  let cp: { first: number; last: number }
  try { cp = k.curveParameters(e) } catch { return Infinity }
  if (!Number.isFinite(cp.first) || !Number.isFinite(cp.last)) return Infinity
  const endpoint = (t: number): number => {
    let p: Vec3
    try { p = k.curvePointAtParam(e, t) } catch { return NaN }
    return perpDistPointToLine(p, center, axis)
  }
  const e0 = endpoint(cp.first), e1 = endpoint(cp.last)
  if (!Number.isFinite(e0) || !Number.isFinite(e1)) return Infinity
  // A line's perpDist is the norm of an affine function of the parameter (convex),
  // so its maximum is at an endpoint — exact, no interior sampling needed.
  if (kind === 'line') return Math.max(e0, e1)
  if (kind === 'circle') {
    const b = circleRadialBound(k, e, cp, center, axis)
    return Number.isFinite(b) ? Math.max(b, e0, e1) : Infinity
  }
  // ellipse / bspline / bezier / parabola / hyperbola / offset / unknown: bound by
  // the NURBS control polygon (rigorous for non-negative weights).
  return polesRadialBound(k, e, center, axis, Math.max(e0, e1))
}

/**
 * Exact upper bound on max perpDist over a CIRCULAR arc: recover the circle from
 * three curve samples (circumcircle), validate a fourth sample lies on it, then
 * bound the projected circle by |perp(centre)| + its semi-major axis. Infinity on
 * any read failure or a recovery that does not check out (fail-closed).
 */
function circleRadialBound(k: OcctKernel, e: ShapeHandle, cp: { first: number; last: number }, center: Vec3, axis: Vec3): number {
  const T = cp.last - cp.first
  if (!(Math.abs(T) > 1e-12)) return Infinity
  let p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3
  try {
    p1 = k.curvePointAtParam(e, cp.first)
    p2 = k.curvePointAtParam(e, cp.first + T / 3)
    p3 = k.curvePointAtParam(e, cp.first + (2 * T) / 3)
    p4 = k.curvePointAtParam(e, cp.first + T / 2)
  } catch { return Infinity }
  const circ = circleFrom3(p1, p2, p3)
  if (!circ) return Infinity
  // fail-closed if the recovery is inconsistent (a "circle" that is not one, or a
  // numerically bad fit): the independent fourth sample must lie on it.
  if (!(Math.abs(dist(p4, circ.center) - circ.radius) <= 1e-3 * (1 + circ.radius))) return Infinity
  const perp = (x: Vec3): Vec3 => { const d = sub(x, center); const along = dot(d, axis); return { x: d.x - along * axis.x, y: d.y - along * axis.y, z: d.z - along * axis.z } }
  const projDir = (dv: Vec3): Vec3 => { const along = dot(dv, axis); return { x: dv.x - along * axis.x, y: dv.y - along * axis.y, z: dv.z - along * axis.z } }
  // orthonormal U,V spanning the circle plane (perpendicular to its normal).
  const m = circ.normal
  let U = cross(m, { x: 1, y: 0, z: 0 })
  if (norm(U) < 1e-6) U = cross(m, { x: 0, y: 1, z: 0 })
  U = unit(U)
  const V = unit(cross(m, U))
  const u = scale(projDir(U), circ.radius)
  const v = scale(projDir(V), circ.radius)
  const su = dot(u, u), sv = dot(v, v), uv = dot(u, v)
  // max magnitude of {cosθ·u + sinθ·v} = the projected circle's semi-major axis.
  const semiMajor = Math.sqrt((su + sv) / 2 + Math.sqrt(((su - sv) / 2) ** 2 + uv * uv))
  const bound = norm(perp(circ.center)) + semiMajor
  return Number.isFinite(bound) ? bound : Infinity
}

/** Exact circumcircle through three 3D points, or null if collinear/degenerate. */
function circleFrom3(p1: Vec3, p2: Vec3, p3: Vec3): { center: Vec3; radius: number; normal: Vec3 } | null {
  const a = sub(p2, p1), b = sub(p3, p1)
  const axb = cross(a, b)
  const denom = 2 * dot(axb, axb)
  if (!(denom > 1e-18)) return null                // collinear / coincident samples
  const num = add(scale(cross(b, axb), dot(a, a)), scale(cross(axb, a), dot(b, b)))
  const center = add(p1, scale(num, 1 / denom))
  const radius = dist(center, p1)
  const normal = unit(axb)
  if (!Number.isFinite(radius) || norm(normal) < 0.5) return null
  return { center, radius, normal }
}

/**
 * Conservative bound via the NURBS control polygon: a NURBS curve with
 * non-negative weights lies in the convex hull of its poles, and perpDist is
 * convex, so the max perpDist over the poles is an upper bound over the curve.
 * Fail-closed (Infinity) if the poles cannot be read, any pole is non-finite, or a
 * rational curve carries a non-positive weight (the hull property no longer holds).
 */
function polesRadialBound(k: OcctKernel, e: ShapeHandle, center: Vec3, axis: Vec3, endpointMax: number): number {
  let nd: NurbsCurveData
  try { nd = k.getNurbsCurveData(e) } catch { return Infinity }
  const poles = nd?.poles
  if (!poles || poles.length < 3 || poles.length % 3 !== 0) return Infinity
  // GEO-13 (BK-110(b)): a curve flagged `rational` whose weights are FALSY (undefined/null/
  // empty) has UNKNOWN weights — we cannot verify they are positive, so a pole at infinity (a
  // non-positive weight) could silently pass. The old guard `nd.rational && nd.weights` skipped
  // the check entirely in that case, treating an unverifiable rational curve as if it were
  // non-rational. Fail CLOSED instead: an unverifiable rational curve is unbounded (Infinity),
  // never silently non-rational. A one-weight-per-pole count is also required, so a truncated
  // weight vector cannot vouch for the poles it does not cover.
  if (nd.rational) {
    if (!nd.weights || nd.weights.length !== poles.length / 3) return Infinity
    for (const wt of nd.weights) if (!(wt > 0)) return Infinity
  }
  let max = endpointMax
  for (let i = 0; i + 2 < poles.length; i += 3) {
    const p = { x: poles[i], y: poles[i + 1], z: poles[i + 2] }
    const d = perpDistPointToLine(p, center, axis)
    if (!Number.isFinite(d)) return Infinity
    max = Math.max(max, d)
  }
  return Number.isFinite(max) ? max : Infinity
}
function onBodyBBox(f: FaceRec, bb: BBox): boolean {
  const eps = 1e-3
  const c = f.centroid
  return Math.abs(c.x - bb.xmin) < eps || Math.abs(c.x - bb.xmax) < eps ||
    Math.abs(c.y - bb.ymin) < eps || Math.abs(c.y - bb.ymax) < eps ||
    Math.abs(c.z - bb.zmin) < eps || Math.abs(c.z - bb.zmax) < eps
}
function axisAlignedOnBBox(f: FaceRec, bb: BBox): boolean {
  const n = f.normal
  if (!(Math.abs(n.x) > 0.99 || Math.abs(n.y) > 0.99 || Math.abs(n.z) > 0.99)) return false
  return onBodyBBox(f, bb)
}
function xyInsideLoop(p: Vec3, lp: HostLoop): boolean {
  return Math.abs(p.x - lp.centerX) <= lp.spanX / 2 + 1e-6 && Math.abs(p.y - lp.centerY) <= lp.spanY / 2 + 1e-6
}

// ---------- healing ----------

export interface HealResult {
  ok: boolean
  /** healed solid (caller owns) on success; undefined on failure. */
  shape?: ShapeHandle
  reason?: string
  /** signed volume delta = healed - original (positive = material ADDED back). */
  volumeDelta?: number
  faceCount?: number
}

/**
 * SELECTIVE heal of `shape` after removing the union of `features`' face sets.
 * The proven probe-07 stack: keep every non-consumed face byte-identical, close
 * only the named openings with removeHolesFromFace, untrim the named planar
 * neighbours to their sharp bbox bounds, drop the feature faces, then
 * sewAndSolidify + reverse-if-negative + isValid/volume verification.
 *
 * ALL kernel handles created here are pushed to `scratch` (caller releases);
 * the returned solid is the ONE handle NOT in scratch on success.
 */
export function healRemoval(k: OcctKernel, shape: ShapeHandle, features: RecognizedFeature[], scratch: ShapeHandle[], faceRecs?: FaceRec[]): HealResult {
  const owned = !faceRecs
  const recs = faceRecs ?? gatherFaces(k, shape)
  const originalVol = safeNum(() => k.getVolume(shape))
  try {
    const drop = new Set<number>()
    const untrim = new Set<number>()
    // GEO-7: main-pair faces extend to a plane-plane intersection line; the band's
    // end faces restore their rounded corner (flanking-edge intersection).
    const planeUntrim = new Map<number, { otherHash: number; bandHash: number }>()
    const cornerUntrim = new Map<number, { bandHash: number }>()
    const removalsByHost = new Map<number, Set<number>>()
    for (const ft of features) {
      if (!ft.removable) return { ok: false, reason: `feature ${ft.key} (${ft.type}) is not removable: ${ft.refuseReason ?? 'refused'}` }
      for (const h of ft.dropHashes) drop.add(h)
      for (const h of ft.untrimHashes) untrim.add(h)
      if (ft.untrimPlan) {
        const { planeA, planeB, bandHash, endFaces } = ft.untrimPlan
        planeUntrim.set(planeA, { otherHash: planeB, bandHash })
        planeUntrim.set(planeB, { otherHash: planeA, bandHash })
        for (const h of endFaces) cornerUntrim.set(h, { bandHash })
      }
      for (const r of ft.hostRemovals) {
        if (!removalsByHost.has(r.hostHash)) removalsByHost.set(r.hostHash, new Set())
        removalsByHost.get(r.hostHash)!.add(r.loopIndex)
      }
    }
    const bb = bodyBBox(recs)
    const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))

    // GEO-6X5: analytic blend ribbons rebuild their 8 walls to the sharp corner via a
    // dedicated curved-neighbour path (arc boundary + pcurve repair), not the straight-
    // edged sharpBBoxWire/sharpPlaneWire/sharpCornerWire untrims.
    const blendRebuilt = new Map<number, ShapeHandle>()
    for (const ft of features) {
      if (!ft.blendPlan) continue
      for (const h of ft.blendPlan.wallHashes) {
        if (blendRebuilt.has(h)) return { ok: false, reason: `overlapping blend ribbons share wall face ${h}: refusing rather than rebuilding it twice` }
      }
      const built = rebuildBlendWalls(k, recs, byHash, ft.blendPlan, scratch)
      if (!built.ok) return { ok: false, reason: built.reason }
      for (const [h, fh] of built.faces) blendRebuilt.set(h, fh)
    }

    const faceSet: ShapeHandle[] = []
    for (const r of recs) {
      if (drop.has(r.hash)) continue
      if (blendRebuilt.has(r.hash)) {
        faceSet.push(blendRebuilt.get(r.hash)!)
      } else if (removalsByHost.has(r.hash)) {
        const idx = [...removalsByHost.get(r.hash)!].sort((a, b) => a - b)
        const host = healHostFace(k, r, idx, scratch)
        if (!host.ok) return { ok: false, reason: host.reason }
        faceSet.push(host.face)
      } else if (untrim.has(r.hash)) {
        const pu = planeUntrim.get(r.hash)
        const cu = cornerUntrim.get(r.hash)
        let wire: ShapeHandle | null
        if (pu) {
          const other = byHash.get(pu.otherHash); const band = byHash.get(pu.bandHash)
          wire = (other && band) ? sharpPlaneWire(k, r, other, band, scratch) : null
          if (!wire) return { ok: false, reason: `plane-plane untrim of face @(${round(r.centroid.x)},${round(r.centroid.y)},${round(r.centroid.z)}) failed` }
        } else if (cu) {
          const band = byHash.get(cu.bandHash)
          wire = band ? sharpCornerWire(k, r, band, scratch) : null
          if (!wire) return { ok: false, reason: `corner untrim of end face @(${round(r.centroid.x)},${round(r.centroid.y)},${round(r.centroid.z)}) failed` }
        } else {
          wire = sharpBBoxWire(k, r, bb, scratch)
          if (!wire) return { ok: false, reason: `untrim of face @(${round(r.centroid.x)},${round(r.centroid.y)},${round(r.centroid.z)}) failed: not an axis-aligned bbox plane` }
        }
        const rebuilt = k.makeFaceOnSurface(r.handle, wire)
        scratch.push(rebuilt); faceSet.push(rebuilt)
      } else {
        // keep byte-identical — pass the ORIGINAL face handle straight into the
        // sew (probe 07). sewAndSolidify copies its inputs into the new shape, so
        // the original body keeps ownership; these handles are freed by the
        // caller (releaseFaceRecs), never pushed to `scratch`.
        faceSet.push(r.handle)
      }
    }
    if (faceSet.length < 4) return { ok: false, reason: `heal face set too small (${faceSet.length})` }
    let solid: ShapeHandle
    try { solid = k.sewAndSolidify(faceSet, 1e-6) } catch (e) { return { ok: false, reason: `sewAndSolidify threw: ${errMsg(e)}` } }
    // orientation-normalize: boolean-derived faces sew inverted (GEO-6S Q3).
    const v0 = safeNum(() => k.getVolume(solid))
    if (Number.isFinite(v0) && v0 < 0) {
      const rev = k.reverseShape(solid)
      scratch.push(solid)
      solid = rev
    }
    const valid = safeBool(() => k.isValid(solid))
    const solidClass = safeBool(() => k.isSolid(solid))
    const vol = safeNum(() => k.getVolume(solid))
    // GEO-11-R1 (blocker 2): FAIL-CLOSED on non-finite data. `vol > 1e-9` alone lets
    // +Infinity through (Infinity > 1e-9 is true), and `originalVol` (line above) was
    // never validated, so a successful HealResult could carry a NaN/Infinity
    // volumeDelta. Every input to the delta must be finite BEFORE ok:true, and the
    // refusal names the offending value so the failure is legible at the boundary
    // (charter bars 2+3). NaN fails every comparison in both directions, so it is
    // checked explicitly, not left to `vol > 1e-9`.
    const volumeDelta = vol - originalVol
    if (!valid || !solidClass || !Number.isFinite(vol) || !(vol > 1e-9) || !Number.isFinite(originalVol) || !Number.isFinite(volumeDelta)) {
      scratch.push(solid)
      return { ok: false, reason: `heal did not reach a watertight solid with finite data (valid=${valid}, solid=${solidClass}, volume=${round(vol, 3)}, originalVolume=${round(originalVol, 3)}, volumeDelta=${round(volumeDelta, 3)})` }
    }
    return { ok: true, shape: solid, volumeDelta: round(volumeDelta, 4), faceCount: faceSet.length }
  } finally {
    if (owned) releaseFaceRecs(k, recs)
  }
}

type HostFaceResult = { ok: true; face: ShapeHandle } | { ok: false; reason: string }

/**
 * Close the named hole loops on a host slab (removeHolesFromFace) and return the
 * healed face, FAIL-CLOSED.
 *
 * The healed host is VALIDATED before it is admitted to the sew set: a face that
 * comes back null, invalid, or zero-area would sew into an open shell that the
 * final watertight gate would only reject with a generic reason. This helper
 * instead REFUSES BY NAME at the exact accept point, naming the offending host
 * slab (charter bars 2+3). The face is pushed to `scratch` (caller-released).
 *
 * NB: this is NOT where BK-97 lived. That defect was upstream, in recognition:
 * the host slab was mis-tagged as the hole's floor CAP and dropped, so the host
 * never reached this branch at all. See the `capWithinFootprint` gate in
 * recognizeFeatures and coordination/evidence/GEO-11/.
 */
function healHostFace(k: OcctKernel, host: FaceRec, removeIdxs: number[], scratch: ShapeHandle[]): HostFaceResult {
  const at = `@(${round(host.centroid.x)},${round(host.centroid.y)},${round(host.centroid.z)})`
  let face: ShapeHandle
  try {
    face = k.removeHolesFromFace(host.handle, [...removeIdxs].sort((a, b) => a - b))
  } catch (e) {
    return { ok: false, reason: `host-slab heal ${at} threw: ${errMsg(e)}` }
  }
  scratch.push(face)
  const valid = safeBool(() => k.isValid(face))
  const area = safeNum(() => k.getSurfaceArea(face))
  if (!valid || !(area > 1e-9)) {
    return { ok: false, reason: `host-slab heal ${at} produced an invalid/degenerate face (valid=${valid}, area=${round(area, 4)}); refusing rather than sewing an open shell` }
  }
  return { ok: true, face }
}

// ---------- GEO-6X5: blend-ribbon wall rebuild (the curved-neighbour untrim) ----------

type BlendBuild = { ok: true; faces: Map<number, ShapeHandle> } | { ok: false; reason: string }

/** edge hash -> the face hashes that use it. Lineage: the rebuild reuses ORIGINAL edge
 *  handles for every unchanged boundary, so shared topology stays exact and CAM
 *  re-resolution can reason about survivors. */
export function buildEdgeOwners(k: OcctKernel, recs: FaceRec[]): Map<number, number[]> {
  const owners = new Map<number, number[]>()
  for (const r of recs) {
    let es: ShapeHandle[]
    try { es = k.getSubShapes(r.handle, 'edge') } catch { continue }
    for (const e of es) {
      const h = k.hashCode(e, HM)
      const list = owners.get(h)
      if (list) list.push(r.hash); else owners.set(h, [r.hash])
      try { k.release(e) } catch { /* */ }
    }
  }
  return owners
}

function outerEdges(k: OcctKernel, face: ShapeHandle): ShapeHandle[] {
  let w: ShapeHandle | null = null
  try { w = k.outerWire(face); return k.getSubShapes(w, 'edge') } catch { return [] } finally { if (w) { try { k.release(w) } catch { /* */ } } }
}
function edgeVerts(k: OcctKernel, e: ShapeHandle): Vec3[] {
  let vs: ShapeHandle[] = []
  try { vs = k.getSubShapes(e, 'vertex'); return vs.map((v) => k.vertexPosition(v)) } catch { return [] } finally { for (const v of vs) { try { k.release(v) } catch { /* */ } } }
}
/** Keep `keep`, release every other handle in `es`. */
function keepOne(k: OcctKernel, es: ShapeHandle[], keep: ShapeHandle | null): ShapeHandle | null {
  for (const e of es) if (e !== keep) { try { k.release(e) } catch { /* */ } }
  return keep
}

const BLEND_VERT_TOL = 1e-7

/** The ORIGINAL edge of `face` that (a) is shared with an UNTOUCHED face and (b) has a
 *  vertex at `pt`. Asserted UNIQUE — this is what makes the rebuild topology-driven
 *  rather than coordinate-hardcoded. Null (=> structured heal failure) if not unique. */
function keepEdgeAt(k: OcctKernel, face: FaceRec, pt: Vec3, owners: Map<number, number[]>, untouched: (h: number) => boolean): ShapeHandle | null {
  const es = outerEdges(k, face.handle)
  const hits = es.filter((e) => {
    const own = (owners.get(k.hashCode(e, HM)) ?? []).filter((o) => o !== face.hash)
    if (!own.some(untouched)) return false
    return edgeVerts(k, e).some((v) => dist(v, pt) < BLEND_VERT_TOL)
  })
  return keepOne(k, es, hits.length === 1 ? hits[0] : null)
}

/** The unique ORIGINAL circle edge of `face` shared with an untouched face. */
function keepArc(k: OcctKernel, face: FaceRec, owners: Map<number, number[]>, untouched: (h: number) => boolean): ShapeHandle | null {
  const es = outerEdges(k, face.handle)
  const hits = es.filter((e) => {
    const own = (owners.get(k.hashCode(e, HM)) ?? []).filter((o) => o !== face.hash)
    if (!own.some(untouched)) return false
    try { return k.curveType(e) === 'circle' } catch { return false }
  })
  return keepOne(k, es, hits.length === 1 ? hits[0] : null)
}

/** Vertex of the (unique) `face`<->`nbr` shared edge FARTHEST from `ref` — the end that
 *  stays put while the near end migrates to the sharp corner. */
function farVert(k: OcctKernel, face: FaceRec, nbr: FaceRec, ref: Vec3, owners: Map<number, number[]>): Vec3 | null {
  const es = outerEdges(k, face.handle)
  const hits = es.filter((e) => (owners.get(k.hashCode(e, HM)) ?? []).includes(nbr.hash))
  const keep = keepOne(k, es, hits.length === 1 ? hits[0] : null)
  if (!keep) return null
  try {
    const p = edgeVerts(k, keep)
    if (p.length < 2) return null
    const a = p[0], b = p[p.length - 1]
    return dist(a, ref) > dist(b, ref) ? a : b
  } finally { try { k.release(keep) } catch { /* */ } }
}

/** The 8 wall FaceRecs a blend plan names, or null if the body no longer carries one. */
function blendWallRecs(byHash: Map<number, FaceRec>, plan: BlendRibbonPlan): {
  cyl: FaceRec; end: FaceRec; sideA: FaceRec; sideB: FaceRec
  osA: FaceRec; oeA: FaceRec; osB: FaceRec; oeB: FaceRec
} | null {
  const [A, B] = plan.corners
  const cyl = byHash.get(plan.cylinderHash), end = byHash.get(plan.endPlaneHash)
  const sideA = byHash.get(A.sideHash), sideB = byHash.get(B.sideHash)
  const osA = byHash.get(A.overSideHash), oeA = byHash.get(A.overEndHash)
  const osB = byHash.get(B.overSideHash), oeB = byHash.get(B.overEndHash)
  if (!cyl || !end || !sideA || !sideB || !osA || !oeA || !osB || !oeB) return null
  return { cyl, end, sideA, sideB, osA, oeA, osB, oeB }
}

/** Ordered, ORIENTED outer-wire edges of `face`: consecutive entries chain (b_i == a_{i+1})
 *  and the loop closes (b_last == a_0). Every edge HANDLE is returned live — the caller
 *  releases each one. Null (structured failure) when the wire is unreadable, has fewer than
 *  three edges, an edge lacks two endpoints, or the edges do not chain into one closed loop. */
function orderedOuterEdges(k: OcctKernel, face: ShapeHandle): Array<{ e: ShapeHandle; a: Vec3; b: Vec3 }> | null {
  let w: ShapeHandle | null = null
  let es: ShapeHandle[] = []
  try {
    w = k.outerWire(face)
    es = k.getSubShapes(w, 'edge')
    if (es.length < 3) { for (const e of es) { try { k.release(e) } catch { /* */ } } return null }
    const segs = es.map((e) => {
      const vs = k.getSubShapes(e, 'vertex')
      const a = vs.length ? k.vertexPosition(vs[0]) : null
      const b = vs.length ? k.vertexPosition(vs[vs.length - 1]) : null
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
      return { e, a, b }
    })
    if (segs.some((s) => !s.a || !s.b)) { for (const s of segs) { try { k.release(s.e) } catch { /* */ } } return null }
    const used = new Array(segs.length).fill(false)
    const out: Array<{ e: ShapeHandle; a: Vec3; b: Vec3 }> = [{ e: segs[0].e, a: segs[0].a!, b: segs[0].b! }]
    used[0] = true
    let tail = segs[0].b!
    for (let step = 1; step < segs.length; step++) {
      let found = false
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue
        const s = segs[i]
        if (vClose(s.a!, tail)) { out.push({ e: s.e, a: s.a!, b: s.b! }); tail = s.b!; used[i] = true; found = true; break }
        if (vClose(s.b!, tail)) { out.push({ e: s.e, a: s.b!, b: s.a! }); tail = s.a!; used[i] = true; found = true; break }
      }
      if (!found) break
    }
    if (out.length !== segs.length || !vClose(tail, out[0].a)) {
      for (const s of segs) { try { k.release(s.e) } catch { /* */ } }
      return null
    }
    return out
  } catch {
    for (const e of es) { try { k.release(e) } catch { /* */ } }
    return null
  } finally { if (w) { try { k.release(w) } catch { /* */ } } }
}

function releaseOrdered(k: OcctKernel, ordered: Array<{ e: ShapeHandle }>): void {
  for (const o of ordered) { try { k.release(o.e) } catch { /* */ } }
}

type EndSplice = { ok: true; keptEdges: ShapeHandle[]; firstFar: Vec3 } | { ok: false; reason: string }

/**
 * GEO-12 (BK-92): the boundary-run SPLICE for the blend end plane — the curved analogue of
 * sharpPlaneWire. The fixed 8-edge end recipe (a unique kept `endArc` + two end lips) can only
 * represent an end plane bordering ONE channel; GEO-6X5 F3 measured that 24 of the Tray's 33
 * analytically-solved ribbons sit on a LARGE end plane shared by several channels, where the
 * surviving circular boundary is not unique and the 8-edge wire cannot represent the face — so
 * they refused despite the sharp geometry being solved.
 *
 * Instead we WALK the end plane's outer boundary, find the single contiguous RUN of edges that
 * border the removal set OR a rebuilt wall (i.e. everything that is NOT an untouched survivor),
 * and splice the sharp corner in its place, keeping EVERY other original boundary edge — the
 * arcs of the other channels included — by its ORIGINAL handle (lineage). The run is flanked by
 * the two recognized survivor lips, so the splice anchors to geometry recognition already
 * proved. Recovers all 33 on Tray. Every topology the splice cannot represent REFUSES BY NAME
 * (inner loop, not a single run, run not flanked by the two survivor lips) — no approximation.
 *
 * Returns the KEPT original edge handles as an ordered chain running from the run's far end
 * back to its near end, plus `firstFar` = the survivor lip at the START of the run (which
 * orients the sharp insert). The caller owns every returned handle; the run edges are released
 * here.
 */
function resolveEndSplice(k: OcctKernel, end: FaceRec, plan: BlendRibbonPlan, owners: Map<number, number[]>): EndSplice {
  // An inner loop is not representable by an outer-wire splice (the rebuilt face would silently
  // drop the hole) — refuse. On Tray every solved ribbon's end plane is a single wire; this
  // bounds the class rather than mis-building a face. (Tray: never taken.)
  let wireCount = -1
  try { const ws = k.getSubShapes(end.handle, 'wire'); wireCount = ws.length; for (const wi of ws) { try { k.release(wi) } catch { /* */ } } } catch { return { ok: false, reason: 'the end plane wire set is unreadable' } }
  if (wireCount !== 1) return { ok: false, reason: `the end plane carries ${wireCount} wires — the boundary-run splice rebuilds a single outer boundary only (an inner loop is outside the class)` }

  const ordered = orderedOuterEdges(k, end.handle)
  if (!ordered) return { ok: false, reason: 'the end plane outer boundary could not be walked as a single ordered loop' }
  const n = ordered.length
  const removed = new Set(plan.removeHashes)
  const wallSet = new Set(plan.wallHashes)
  // RUN edge := borders a removed face or a rebuilt wall (owners minus the end plane itself).
  // Every other edge (untouched neighbour, or a naked boundary edge) is KEPT byte-identical.
  const isRun = ordered.map(({ e }) => {
    const own = (owners.get(k.hashCode(e, HM)) ?? []).filter((o) => o !== end.hash)
    return own.length > 0 && own.some((o) => removed.has(o) || wallSet.has(o))
  })
  const runTotal = isRun.filter(Boolean).length
  if (runTotal === 0 || runTotal >= n) {
    releaseOrdered(k, ordered)
    return { ok: false, reason: `the end plane boundary is ${runTotal === 0 ? 'entirely untouched (no removal-set contact)' : 'entirely on the removal set (no surviving boundary to keep)'} — no spliceable single run` }
  }
  let runs = 0, start = -1
  for (let j = 0; j < n; j++) if (isRun[j] && !isRun[(j - 1 + n) % n]) { runs++; if (start < 0) start = j }
  if (runs !== 1) {
    releaseOrdered(k, ordered)
    return { ok: false, reason: `the removal set meets the end plane in ${runs} separate boundary runs — the class is a single contiguous run` }
  }
  const runIdx: number[] = []
  for (let i = start, guard = 0; isRun[i] && guard <= n; i = (i + 1) % n, guard++) runIdx.push(i)
  const last = runIdx[runIdx.length - 1]
  const pBefore = ordered[start].a   // shared with the kept edge BEFORE the run
  const pAfter = ordered[last].b     // shared with the kept edge AFTER the run
  const farA = plan.corners[0].farLip, farB = plan.corners[1].farLip
  const isFar = (p: Vec3): boolean => vClose(p, farA) || vClose(p, farB)
  if (!isFar(pBefore) || !isFar(pAfter) || vClose(pBefore, pAfter)) {
    releaseOrdered(k, ordered)
    return { ok: false, reason: 'the end-plane boundary run is not flanked by the two recognized survivor lips' }
  }
  // KEPT edges: the run's complement, ordered as a chain from pAfter back round to pBefore.
  const keptEdges: ShapeHandle[] = []
  for (let step = 1; step <= n - runIdx.length; step++) keptEdges.push(ordered[(last + step) % n].e)
  for (const idx of runIdx) { try { k.release(ordered[idx].e) } catch { /* */ } }   // run edges: not reused
  return { ok: true, keptEdges, firstFar: pBefore }
}

type SurvivorEdges = { ok: true; kept: Record<string, ShapeHandle> } | { ok: false; reason: string }

/**
 * Resolve the 11 ORIGINAL boundary edges the rebuild keeps for the NON-end walls (lineage).
 * Each must be the UNIQUE edge of its wall that is shared with an UNTOUCHED face and anchored
 * at the named survivor vertex — that uniqueness is what makes the rebuild topology-driven
 * rather than coordinate-hardcoded.
 *
 * GEO-12 (BK-92): the END PLANE's surviving edges are NO LONGER resolved here. The old
 * `endArc`/`endLipA`/`endLipB` uniqueness requirement is exactly what refused 24 of the Tray's
 * 33 solved ribbons (a large end plane shared by several channels carries more than one
 * surviving circular boundary, so `endArc` is ambiguous). The end plane is now rebuilt by a
 * boundary-run splice (`resolveEndSplice`) that keeps whatever the boundary walk says is
 * untouched, however many arcs that is. The other seven walls each still border ONE channel,
 * so their survivor edges stay unique and are resolved here unchanged.
 *
 * CONSTRUCTIBILITY IS PART OF THE CLASS. `blendIsConstructible` runs this AND `resolveEndSplice`
 * (releasing the handles), so a ribbon whose walls cannot be re-wired REFUSES at recognition
 * instead of promising `removable:true` and failing later.
 */
function blendSurvivorEdges(k: OcctKernel, byHash: Map<number, FaceRec>, plan: BlendRibbonPlan, owners: Map<number, number[]>): SurvivorEdges {
  const w = blendWallRecs(byHash, plan)
  if (!w) return { ok: false, reason: 'a planned wall face is missing from the body' }
  const removed = new Set(plan.removeHashes)
  const wallSet = new Set(plan.wallHashes)
  const untouched = (h: number): boolean => !removed.has(h) && !wallSet.has(h)
  const [A, B] = plan.corners

  const kept: Record<string, ShapeHandle | null> = {
    cylArc: keepArc(k, w.cyl, owners, untouched),
    sideAFar: keepEdgeAt(k, w.sideA, A.farSide, owners, untouched),
    sideBFar: keepEdgeAt(k, w.sideB, B.farSide, owners, untouched),
    osAFar: keepEdgeAt(k, w.osA, A.farSide, owners, untouched),
    osAApex: keepEdgeAt(k, w.osA, A.apex, owners, untouched),
    oeAApex: keepEdgeAt(k, w.oeA, A.apex, owners, untouched),
    oeALip: keepEdgeAt(k, w.oeA, A.farLip, owners, untouched),
    osBFar: keepEdgeAt(k, w.osB, B.farSide, owners, untouched),
    osBApex: keepEdgeAt(k, w.osB, B.apex, owners, untouched),
    oeBApex: keepEdgeAt(k, w.oeB, B.apex, owners, untouched),
    oeBLip: keepEdgeAt(k, w.oeB, B.farLip, owners, untouched),
  }
  const missing = Object.entries(kept).filter(([, v]) => !v).map(([n]) => n)
  if (missing.length) {
    for (const h of Object.values(kept)) if (h) { try { k.release(h) } catch { /* */ } }
    return { ok: false, reason: `no unique surviving edge for ${missing.join(', ')}` }
  }
  return { ok: true, kept: kept as Record<string, ShapeHandle> }
}

/** Recognize-time constructibility probe: resolve the non-end survivor edges AND verify the
 *  end-plane boundary-run splice, then release every handle. Both must succeed for the ribbon
 *  to promise `removable:true` — the end splice is as much a class member as the 11 unique
 *  survivor edges (GEO-12). */
function blendIsConstructible(k: OcctKernel, byHash: Map<number, FaceRec>, plan: BlendRibbonPlan, owners: Map<number, number[]>): { ok: true } | { ok: false; reason: string } {
  const res = blendSurvivorEdges(k, byHash, plan, owners)
  if (!res.ok) return res
  for (const h of Object.values(res.kept)) { try { k.release(h) } catch { /* */ } }
  const end = byHash.get(plan.endPlaneHash)
  if (!end) return { ok: false, reason: 'the end plane is missing from the body' }
  const es = resolveEndSplice(k, end, plan, owners)
  if (!es.ok) return { ok: false, reason: es.reason }
  for (const h of es.keptEdges) { try { k.release(h) } catch { /* */ } }
  return { ok: true }
}

/**
 * Rebuild the 8 wall faces of an analytic blend ribbon to their sharp corner.
 *
 * The sharp boundary on the channel cylinder is an ARC (cylinder INTERSECT end plane) —
 * `sharpBBoxWire`/`sharpPlaneWire`/`sharpCornerWire` all emit straight edges only, which
 * is why this class needed a dedicated path (GEO-6X4 recommendation 2). Every unchanged
 * boundary reuses its ORIGINAL edge handle; the 11 new edges are each used by exactly two
 * rebuilt faces, so the sew closes watertight.
 */
function rebuildBlendWalls(k: OcctKernel, recs: FaceRec[], byHash: Map<number, FaceRec>, plan: BlendRibbonPlan, scratch: ShapeHandle[]): BlendBuild {
  const owners = buildEdgeOwners(k, recs)
  const fail = (reason: string): BlendBuild => ({ ok: false, reason: `blend-ribbon heal: ${reason}` })

  const w = blendWallRecs(byHash, plan)
  if (!w) return fail('a planned wall face is missing from the body')
  const { cyl, end, sideA, sideB, osA, oeA, osB, oeB } = w
  const [A, B] = plan.corners

  const line = (a: Vec3, b: Vec3): ShapeHandle => { const e = k.makeLineEdge(a, b); scratch.push(e); return e }
  let E: Record<string, ShapeHandle>
  try {
    E = {
      lineA: line(A.farCyl, A.tangency), lineB: line(B.farCyl, B.tangency),
      vertA: line(A.corner, A.tangency), vertB: line(B.corner, B.tangency),
      topA: line(A.farSide, A.corner), topB: line(B.farSide, B.corner),
      lipA: line(A.farLip, A.corner), lipB: line(B.farLip, B.corner),
      slantA: line(A.apex, A.corner), slantB: line(B.apex, B.corner),
      // the ONE curved sharp boundary: cylinder INTERSECT end plane.
      sharpArc: (() => { const e = k.makeArcEdge(A.tangency, plan.arcDeep, B.tangency); scratch.push(e); return e })(),
    }
  } catch (e) { return fail(`sharp edge construction threw: ${errMsg(e)}`) }

  // survivor edges for the 7 non-end walls (ORIGINAL handles — lineage). Proven unique at
  // recognize time; re-resolved here against the body actually being healed, and still fail-loud.
  const sel = blendSurvivorEdges(k, byHash, plan, owners)
  if (!sel.ok) return fail(sel.reason)
  const kept = sel.kept
  for (const h of Object.values(kept)) scratch.push(h)

  // GEO-12 (BK-92): the END PLANE is rebuilt by a boundary-run splice, not the fixed 8-edge
  // recipe — the run of removed/wall edges is replaced by the sharp corner and EVERY other
  // original boundary edge (arcs of other channels included) is kept by handle. The sharp
  // insert [lip,vert,sharpArc,vert,lip] runs corner[0].farLip -> corner[1].farLip; if the walk
  // enters the run at corner[1]'s lip instead, the insert is emitted reversed so it still
  // chains pBefore -> pAfter.
  const es = resolveEndSplice(k, end, plan, owners)
  if (!es.ok) return fail(es.reason)
  for (const h of es.keptEdges) scratch.push(h)
  const forward = vClose(es.firstFar, A.farLip)
  const sharpInsert = forward
    ? [E.lipA, E.vertA, E.sharpArc, E.vertB, E.lipB]
    : [E.lipB, E.vertB, E.sharpArc, E.vertA, E.lipA]
  const endEdges = [...sharpInsert, ...es.keptEdges]

  // GEO-13 (BK-92 close-out): the spliced end wire MUST be a single closed loop with every
  // vertex at degree 2 before it can be sewn — an isValid=false solid from a non-manifold or
  // multi-loop end wire is a defect, never an outcome. The splice inserts the sharp corner
  // [lip,vert,arc,vert,lip] where a channel opening was; if a sharp tangency/corner COINCIDES
  // with a kept boundary vertex (report widateBlocker), a degenerate lip/vert tab collapses to
  // zero length and a vertex would go to degree 3. reconcileSpliceLoop merges the zero-length
  // tab and re-checks; anything it cannot resolve to one all-degree-2 loop REFUSES BY NAME
  // here rather than handing an invalid face to the sew.
  const rec = reconcileSpliceLoop(k, endEdges)
  if (!rec.ok) return fail(rec.reason)
  const endWire = rec.edges

  const recipes: Array<[FaceRec, ShapeHandle[]]> = [
    [cyl, [kept.cylArc, E.lineA, E.sharpArc, E.lineB]],
    [sideA, [kept.sideAFar, E.lineA, E.vertA, E.topA]],
    [sideB, [kept.sideBFar, E.lineB, E.vertB, E.topB]],
    [end, endWire],
    [osA, [kept.osAFar, E.topA, E.slantA, kept.osAApex]],
    [oeA, [kept.oeAApex, E.slantA, E.lipA, kept.oeALip]],
    [osB, [kept.osBFar, E.topB, E.slantB, kept.osBApex]],
    [oeB, [kept.oeBApex, E.slantB, E.lipB, kept.oeBLip]],
  ]
  if (recipes.length !== plan.wallHashes.length) return fail(`rebuild set (${recipes.length}) != wall set (${plan.wallHashes.length})`)

  const out = new Map<number, ShapeHandle>()
  for (const [face, edges] of recipes) {
    let wire: ShapeHandle
    try { wire = k.makeWire(edges); scratch.push(wire) } catch (e) { return fail(`makeWire failed on wall @(${round(face.centroid.x)},${round(face.centroid.y)},${round(face.centroid.z)}): ${errMsg(e)}`) }
    let rebuilt: ShapeHandle
    try { rebuilt = k.makeFaceOnSurface(face.handle, wire); scratch.push(rebuilt) } catch (e) { return fail(`makeFaceOnSurface failed on wall @(${round(face.centroid.x)},${round(face.centroid.y)},${round(face.centroid.z)}): ${errMsg(e)}`) }

    // ---- MANDATORY GUARD 1 (GEO-6X4 F2) ----
    // makeFaceOnSurface() SILENTLY returns a zero-area, isValid=false face when a rebuilt
    // wire sits on a NON-PLANAR support: the pcurve is missing and the exposed API has no
    // call to build one. No exception is raised, and the bad face still sews into a CLOSED,
    // solid-classified body with a wrong volume (measured: volDelta 4821.5434 instead of
    // 8.813). fixShape() (ShapeFix_Shape) supplies the pcurves and recovers the exact
    // analytic area. Do NOT substitute healFace() — on this mixed reused+fresh wire it
    // returns a REVERSED face — and do NOT substitute makeNonPlanarFace(), which discards
    // the analytic support and re-fits an approximating surface.
    // The area>0 + isValid assertion below is NOT optional: it is the only thing standing
    // between a silent zero-area face and a closed-but-wrong solid.
    if (face.type !== 'plane') {
      try { const fixed = k.fixShape(rebuilt); scratch.push(fixed); rebuilt = fixed } catch (e) { return fail(`fixShape (pcurve repair) failed on the ${face.type} wall: ${errMsg(e)}`) }
    }
    const area = safeNum(() => k.getSurfaceArea(rebuilt))
    if (!(Number.isFinite(area) && area > 1e-9)) return fail(`rebuilt ${face.type} wall has non-positive area (${round(area, 6)}) — the silent zero-area-face mode (GEO-6X4 F2)`)
    if (!safeBool(() => k.isValid(rebuilt))) return fail(`rebuilt ${face.type} wall is not valid`)

    // ---- GEO-12: orient the rebuilt face to the ORIGINAL face's normal ----
    // makeFaceOnSurface takes the face's topological orientation from the WIRE winding. The
    // end-plane boundary-run splice walks the boundary in a kernel-enumeration-dependent
    // direction, so its winding — and hence the rebuilt normal — comes back flipped on most
    // ribbons (measured: normDot -1). A flipped face still passes area>0 + isValid in isolation
    // and still sews CLOSED (solid=true) with the right volume, but the shell is INCONSISTENT
    // (isValid=false) — the exact silent mode the final watertight gate would only reject with a
    // generic reason. Compare the rebuilt UV-mid normal with the original's (surfaceNormal here
    // reflects the face orientation) and reverse when they oppose, so every wall matches the
    // shell it rejoins. A no-op for the structurally-ordered walls (already aligned).
    const uvR = safeUv(k, rebuilt)
    if (uvR) {
      const rn = unit(safeVec(() => k.surfaceNormal(rebuilt, (uvR.uMin + uvR.uMax) / 2, (uvR.vMin + uvR.vMax) / 2)))
      if (norm(rn) > 0.5 && dot(rn, face.normal) < 0) {
        try { const rev = k.reverseShape(rebuilt); scratch.push(rev); rebuilt = rev } catch (e) { return fail(`rebuilt ${face.type} wall could not be re-oriented to the original normal: ${errMsg(e)}`) }
      }
    }
    out.set(face.hash, rebuilt)
  }
  return { ok: true, faces: out }
}

/** Build the sharp axis-aligned bbox rectangle wire for a planar face on the
 *  body bbox (probe 02 strategy C). Returns null if the face is not an
 *  axis-aligned bbox plane. */
function sharpBBoxWire(k: OcctKernel, f: FaceRec, bb: BBox, scratch: ShapeHandle[]): ShapeHandle | null {
  const n = f.normal
  let pts: Vec3[] | null = null
  if (Math.abs(n.x) > 0.99 && (near(f.centroid.x, bb.xmin) || near(f.centroid.x, bb.xmax))) {
    const x = n.x > 0 ? bb.xmax : bb.xmin
    pts = [{ x, y: bb.ymin, z: bb.zmin }, { x, y: bb.ymax, z: bb.zmin }, { x, y: bb.ymax, z: bb.zmax }, { x, y: bb.ymin, z: bb.zmax }]
  } else if (Math.abs(n.y) > 0.99 && (near(f.centroid.y, bb.ymin) || near(f.centroid.y, bb.ymax))) {
    const y = n.y > 0 ? bb.ymax : bb.ymin
    pts = [{ x: bb.xmin, y, z: bb.zmin }, { x: bb.xmax, y, z: bb.zmin }, { x: bb.xmax, y, z: bb.zmax }, { x: bb.xmin, y, z: bb.zmax }]
  } else if (Math.abs(n.z) > 0.99 && (near(f.centroid.z, bb.zmin) || near(f.centroid.z, bb.zmax))) {
    const z = n.z > 0 ? bb.zmax : bb.zmin
    pts = [{ x: bb.xmin, y: bb.ymin, z }, { x: bb.xmax, y: bb.ymin, z }, { x: bb.xmax, y: bb.ymax, z }, { x: bb.xmin, y: bb.ymax, z }]
  }
  if (!pts) return null
  const edges: ShapeHandle[] = []
  for (let i = 0; i < 4; i++) { const e = k.makeLineEdge(pts[i], pts[(i + 1) % 4]); scratch.push(e); edges.push(e) }
  const w = k.makeWire(edges); scratch.push(w)
  return w
}

/**
 * GEO-7: build the untrim wire for a planar neighbour `f` extended to the sharp
 * edge where its plane meets `other`'s plane. `f`'s boundary is walked, the edge
 * it shared with the removed `band` is found, and the two vertices flanking that
 * shared run are re-projected onto the plane-plane intersection line L by
 * extending `f`'s side edges to L. Both neighbours extend their converging side
 * edges to the SAME line L, so the two rebuilt faces share the sharp edge and the
 * sew closes watertight. Returns null (structured heal failure) if the planes are
 * parallel, the boundary is degenerate, or a side edge runs parallel to L.
 */
function sharpPlaneWire(k: OcctKernel, f: FaceRec, other: FaceRec, band: FaceRec, scratch: ShapeHandle[]): ShapeHandle | null {
  // plane-plane intersection line L (point p0, unit direction dir).
  const n1 = f.normal, n2 = other.normal
  const d = cross(n1, n2)
  if (norm(d) < 1e-6) return null // parallel planes
  const c1 = dot(n1, f.centroid), c2 = dot(n2, other.centroid)
  const dd = dot(d, d)
  const p0 = scale(add(scale(cross(n2, d), c1), scale(cross(d, n1), c2)), 1 / dd)
  const dir = unit(d)

  const poly = orderedWirePoints(k, f.handle)
  if (!poly || poly.length < 3) return null
  const n = poly.length

  // which polygon vertices sit on the edge f shared with the band.
  const bandVerts: Vec3[] = []
  const shared = sharedEdgesSafe(k, f.handle, band.handle)
  try {
    for (const e of shared) {
      const vs = k.getSubShapes(e, 'vertex')
      for (const v of vs) { bandVerts.push(k.vertexPosition(v)); try { k.release(v) } catch { /* */ } }
    }
  } finally { for (const e of shared) { try { k.release(e) } catch { /* */ } } }
  if (bandVerts.length === 0) return null
  const isBandSide = poly.map((p) => bandVerts.some((bv) => vClose(p, bv, 1e-3)))
  const cnt = isBandSide.filter(Boolean).length
  if (cnt === 0 || cnt >= n) return null

  // contiguous cyclic run of band-side vertices.
  let start = -1
  for (let i = 0; i < n; i++) { if (isBandSide[i] && !isBandSide[(i - 1 + n) % n]) { start = i; break } }
  if (start < 0) return null
  const run: number[] = []
  for (let i = start, guard = 0; isBandSide[i] && guard <= n; i = (i + 1) % n, guard++) run.push(i)
  const a = run[0], b = run[run.length - 1]
  const before = poly[(a - 1 + n) % n], after = poly[(b + 1) % n]
  const Pa = lineToLine(before, poly[a], p0, dir)
  const Pb = lineToLine(after, poly[b], p0, dir)
  if (!Pa || !Pb) return null

  // rebuild: keep the non-run vertices in order, replace the whole run with the
  // two extended endpoints [Pa, Pb] (Pa flanks `before`, Pb flanks `after`).
  const runSet = new Set(run)
  const out: Vec3[] = []
  for (let idx = 0; idx < n; idx++) {
    if (idx === a) { out.push(Pa); out.push(Pb) }
    else if (!runSet.has(idx)) out.push(poly[idx])
  }
  if (out.length < 3) return null
  const edges: ShapeHandle[] = []
  for (let j = 0; j < out.length; j++) { const e = k.makeLineEdge(out[j], out[(j + 1) % out.length]); scratch.push(e); edges.push(e) }
  const w = k.makeWire(edges); scratch.push(w)
  return w
}

/** Ordered vertex loop of a face's outer wire (chained by shared endpoints).
 *  Robust for straight-edged planar boundaries (the plane-untrim neighbours). */
function orderedWirePoints(k: OcctKernel, face: ShapeHandle): Vec3[] | null {
  let w: ShapeHandle | null = null
  try {
    w = k.outerWire(face)
    const es = k.getSubShapes(w, 'edge')
    try {
      const segs: Array<[Vec3, Vec3]> = []
      for (const e of es) {
        const vs = k.getSubShapes(e, 'vertex')
        if (vs.length >= 2) segs.push([k.vertexPosition(vs[0]), k.vertexPosition(vs[vs.length - 1])])
        for (const v of vs) { try { k.release(v) } catch { /* */ } }
      }
      if (segs.length < 3) return null
      const used = new Array(segs.length).fill(false)
      const pts: Vec3[] = [segs[0][0], segs[0][1]]; used[0] = true
      for (let step = 1; step < segs.length; step++) {
        const tail = pts[pts.length - 1]
        let found = false
        for (let i = 0; i < segs.length; i++) {
          if (used[i]) continue
          const [sa, sb] = segs[i]
          if (vClose(sa, tail)) { pts.push(sb); used[i] = true; found = true; break }
          if (vClose(sb, tail)) { pts.push(sa); used[i] = true; found = true; break }
        }
        if (!found) break
      }
      if (pts.length >= 2 && vClose(pts[pts.length - 1], pts[0])) pts.pop()
      return pts.length >= 3 ? pts : null
    } finally { for (const e of es) { try { k.release(e) } catch { /* */ } } }
  } catch { return null } finally { if (w) { try { k.release(w) } catch { /* */ } } }
}

/** Intersection of the line through (A -> P) with the line (p0, dir), when the
 *  two lines are coplanar (they are: both lie in `f`'s plane). Null if the side
 *  edge is parallel to L (degenerate). */
function lineToLine(A: Vec3, P: Vec3, p0: Vec3, dir: Vec3): Vec3 | null {
  return intersectLines(A, sub(P, A), p0, dir)
}

/** Coplanar line-line intersection: point on (A1, d1) closest to (A2, d2). For
 *  coplanar lines this is the exact crossing. Null if the lines are parallel. */
function intersectLines(A1: Vec3, d1: Vec3, A2: Vec3, d2: Vec3): Vec3 | null {
  const cr = cross(d1, d2)
  const den = dot(cr, cr)
  if (den < 1e-14) return null
  const t = dot(cross(sub(A2, A1), d2), cr) / den
  return add(A1, scale(d1, t))
}

/**
 * GEO-7: restore a band END face's rounded/bevelled corner. The fillet/chamfer
 * cut a single corner of this planar face into an arc (fillet) or short bevel
 * edge (chamfer). Walk the boundary, find the run shared with the removed band,
 * and replace it with the intersection of the two flanking edges — the sharp
 * corner where the band's sharp edge L meets this face's plane. Purely in-plane,
 * so it works at any orientation. Null on a degenerate boundary.
 */
function sharpCornerWire(k: OcctKernel, f: FaceRec, band: FaceRec, scratch: ShapeHandle[]): ShapeHandle | null {
  const poly = orderedWirePoints(k, f.handle)
  if (!poly || poly.length < 3) return null
  const n = poly.length
  const bandVerts: Vec3[] = []
  const shared = sharedEdgesSafe(k, f.handle, band.handle)
  try {
    for (const e of shared) {
      const vs = k.getSubShapes(e, 'vertex')
      for (const v of vs) { bandVerts.push(k.vertexPosition(v)); try { k.release(v) } catch { /* */ } }
    }
  } finally { for (const e of shared) { try { k.release(e) } catch { /* */ } } }
  if (bandVerts.length === 0) return null
  const isBandSide = poly.map((p) => bandVerts.some((bv) => vClose(p, bv, 1e-3)))
  const cnt = isBandSide.filter(Boolean).length
  if (cnt === 0 || cnt >= n) return null
  let start = -1
  for (let i = 0; i < n; i++) { if (isBandSide[i] && !isBandSide[(i - 1 + n) % n]) { start = i; break } }
  if (start < 0) return null
  const run: number[] = []
  for (let i = start, guard = 0; isBandSide[i] && guard <= n; i = (i + 1) % n, guard++) run.push(i)
  const a = run[0], b = run[run.length - 1]
  const before = poly[(a - 1 + n) % n], after = poly[(b + 1) % n]
  // flanking edges: (before -> poly[a]) and (after -> poly[b]); extend to their crossing.
  const corner = intersectLines(before, sub(poly[a], before), after, sub(poly[b], after))
  if (!corner) return null
  const runSet = new Set(run)
  const out: Vec3[] = []
  for (let idx = 0; idx < n; idx++) {
    if (idx === a) out.push(corner)
    else if (!runSet.has(idx)) out.push(poly[idx])
  }
  if (out.length < 3) return null
  const edges: ShapeHandle[] = []
  for (let j = 0; j < out.length; j++) { const e = k.makeLineEdge(out[j], out[(j + 1) % out.length]); scratch.push(e); edges.push(e) }
  const w = k.makeWire(edges); scratch.push(w)
  return w
}

/**
 * GEO-13 (BK-92 close-out): verify the spliced end wire is a single closed loop with every
 * vertex at degree 2, reconciling a coincident-vertex degeneracy first.
 *
 * The end-plane splice replaces one channel opening with the sharp insert [lip,vert,arc,vert,
 * lip] and keeps every other boundary edge. On the whole Tray (all 33 analytically-solved
 * ribbons, measured GEO-13) the sharp tangency/corner never coincides with a kept boundary
 * vertex, so this always passes untouched. But the class ALLOWS it: GEO-12's widateBlocker
 * anticipated a ribbon whose sharp tangency lands ON a kept far-arc endpoint, which collapses
 * the flanking lip/vert to a ZERO-LENGTH tab and would drive that shared point to degree 3.
 *
 * The RECONCILIATION is structural, never a bare float ==: an edge whose two endpoints are
 * within vClose tol is a degenerate tab (the merge target) and is dropped, handing its two
 * neighbours' shared vertex straight through — e.g. the sharp arc to the kept far arc. After
 * the merge every surviving vertex must be degree 2 AND the survivors must chain into ONE
 * closed loop; a wire that cannot reach that REFUSES BY NAME. `pos` reads each edge's two
 * endpoints; `analyseSpliceLoop` is the pure-topology core (unit-tested by force-injection).
 */
type SpliceLoop = { ok: true; keep: number[] } | { ok: false; reason: string }
function analyseSpliceLoop(segs: Array<{ a: Vec3; b: Vec3 }>): SpliceLoop {
  // 1) drop degenerate zero-length tabs (the coincident-vertex merge).
  const keep = segs.map((_, i) => i).filter((i) => !vClose(segs[i].a, segs[i].b))
  if (keep.length < 3) return { ok: false, reason: `the spliced end wire collapses to ${keep.length} non-degenerate edge(s) — not a face boundary` }
  // 2) cluster endpoints and count degree. NaN in any coordinate fails vClose both ways, so a
  //    non-finite endpoint lands in its own singleton cluster and shows up as an odd degree.
  const verts: Vec3[] = []
  const idOf = (p: Vec3): number => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return -1
    for (let i = 0; i < verts.length; i++) if (vClose(verts[i], p)) return i
    verts.push(p); return verts.length - 1
  }
  const deg = new Map<number, number>()
  const adj = new Map<number, number[]>()   // vertex id -> seg indices
  let nonFinite = false
  for (const i of keep) {
    const ia = idOf(segs[i].a), ib = idOf(segs[i].b)
    if (ia < 0 || ib < 0) { nonFinite = true; continue }
    deg.set(ia, (deg.get(ia) ?? 0) + 1); deg.set(ib, (deg.get(ib) ?? 0) + 1)
    ;(adj.get(ia) ?? adj.set(ia, []).get(ia)!).push(i)
    ;(adj.get(ib) ?? adj.set(ib, []).get(ib)!).push(i)
  }
  if (nonFinite) return { ok: false, reason: 'the spliced end wire carries a non-finite vertex — the sharp corner solve produced NaN/Infinity' }
  const bad = [...deg.entries()].find(([, d]) => d !== 2)
  if (bad) {
    const p = verts[bad[0]]
    return { ok: false, reason: `the spliced end wire has a degree-${bad[1]} vertex at (${round(p.x, 3)},${round(p.y, 3)},${round(p.z, 3)}) — a coincident sharp/kept vertex the merge could not reconcile to a single degree-2 loop` }
  }
  // 3) every vertex degree 2 is necessary but not sufficient (two disjoint loops also satisfy
  //    it). Walk one loop from keep[0]; it must visit EVERY surviving edge exactly once.
  const seen = new Set<number>([keep[0]])
  const start = idOf(segs[keep[0]].a)
  let vtx = idOf(segs[keep[0]].b)
  for (let step = 1; step < keep.length; step++) {
    const nbr = (adj.get(vtx) ?? []).find((j) => !seen.has(j))
    if (nbr === undefined) break
    seen.add(nbr)
    vtx = idOf(segs[nbr].a) === vtx ? idOf(segs[nbr].b) : idOf(segs[nbr].a)
  }
  if (seen.size !== keep.length) return { ok: false, reason: `the spliced end wire is not a single loop — ${seen.size} of ${keep.length} edges are reachable from the first` }
  if (vtx !== start) return { ok: false, reason: 'the spliced end wire does not close back on its first vertex' }
  return { ok: true, keep }
}
function reconcileSpliceLoop(k: OcctKernel, edges: ShapeHandle[]): { ok: true; edges: ShapeHandle[] } | { ok: false; reason: string } {
  // GEO-14 item 1 (GEO-13 held major): FAIL CLOSED when the kernel cannot read a splice
  // edge's endpoints. Each endpoint read (getSubShapes('vertex') + two vertexPosition calls)
  // runs inside a structured failure boundary: a kernel fault becomes the NAMED refusal
  // 'splice edge vertices unreadable' — the contract healRemoval promises — instead of an
  // exception that escapes healRemoval uncaught. Every vertex handle acquired before a fault
  // is released in `finally`, so a vertexPosition throw after getSubShapes succeeded does not
  // leak the handles it already opened (the auditor's mock-kernel probe proved both faults).
  const segs: Array<{ a: Vec3; b: Vec3 }> = []
  for (const e of edges) {
    let vs: ShapeHandle[] = []
    try {
      vs = k.getSubShapes(e, 'vertex')
      const a = vs.length ? k.vertexPosition(vs[0]) : { x: NaN, y: NaN, z: NaN }
      const b = vs.length ? k.vertexPosition(vs[vs.length - 1]) : { x: NaN, y: NaN, z: NaN }
      segs.push({ a, b })
    } catch (err) {
      return { ok: false, reason: `splice edge vertices unreadable — the kernel could not read a splice edge's endpoints (${errMsg(err)})` }
    } finally {
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
  }
  const res = analyseSpliceLoop(segs)
  if (!res.ok) return res
  return { ok: true, edges: res.keep.map((i) => edges[i]) }
}
export const __geo13internals = { analyseSpliceLoop, orderedOuterEdges, resolveEndSplice, polesRadialBound, coneApex }
// GEO-14: internals the fail-closed sweep + exception-boundary tests drive directly.
export const __geo14internals = { reconcileSpliceLoop }

// ---------- small utils ----------
function near(a: number, b: number): boolean { return Math.abs(a - b) < 1e-3 }
function safeNum(fn: () => number): number { try { return fn() } catch { return NaN } }
function safeBool(fn: () => boolean): boolean { try { return fn() } catch { return false } }
function errMsg(e: unknown): string { return (e instanceof Error ? e.message : String(e)).slice(0, 120) }
