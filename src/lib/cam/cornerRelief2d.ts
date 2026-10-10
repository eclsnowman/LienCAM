// Corner relief for 2D Pocket and closed Contour: dogbone, T-bone, longest edge (WO-2287).
//
// A round cutter leaves an r-radius fillet of material in every inside corner. With a
// relief style chosen, each such corner gets a short extra cut AFTER the operation's
// main path, at the operation's own stepdown levels, ending where the cutter just
// touches the corner point - so a square tenon, a slot-together sheet part or a joinery
// pin seats fully into the corner.
//
// Premise and method from PureCutCNC's cornerRelief.ts (Apache-2.0, Copyright 2026
// Franja (Frank) Povazanj), reimplemented here in LienCAM's idiom: Y-up, mm, the
// ToolpathMove point stream and the shared moves helpers. No code is copied.
//
// - A separate pass, not a region change: unioning an r-lobe into the cleared region
//   and eroding it by r collapses it to nothing, so the path would not change. It also
//   lets the usual job work - rough big with no relief, finish small with relief on.
// - The touch-the-corner rule. For corner C, unit edge directions u and v from C, unit
//   bisector b into the cleared side and cutter radius r, the excursion ends at
//     dogbone       C + b r
//     T-bone        C + u r, u the edge nearer parallel to X
//     longest edge  C + u r, u the longer edge (ties fall back to T-bone's rule)
//   Ending at r is the exact limit: ending at 1.2r leaves material in the corner
//   (src/tests/cam/cornerRelief2d.wo2287.test.ts proves both directions).
// - Which corners: every corner where the cleared region is convex, i.e. the kept
//   material is concave - pocket boundary corners, the reflex corners of an island,
//   the inside corners of a part routed on the outside. One sign test after rewriting
//   each loop so the cleared side is on the left of travel.
// - Where it descends: the point P on the bisector where the operation's own wall pass
//   turned the corner. P is air at every level the main path already cut there, so the
//   relief never plunges into material. The main path is READ from the moves it
//   emitted (finish wall at r, or a roughing-only wall at r + stock); a corner the main
//   path never reached, or reached only higher up (a holding tab), is relieved only at
//   the levels that are open, or not at all. Nothing is refused or reported: a corner
//   the relief cannot reach is simply not relieved.
//
// Gentle corner (WO-2317). The straight excursion buries the cutter: driving into the
// corner it cuts both walls at once, close to a full-width slot. The gentle variant
// cuts a lobe of radius rho a little larger than the cutter (rho = 1.15 r, WO-2289's
// narrowest channel) with WO-2289's open-guide trochoid (buildOpenTrochoid), so each
// orbit takes only a thin crescent:
//   lobe   Q  = the style's excursion end at distance rho, so the lobe still reaches
//              the corner point - the same touch-the-corner rule, at rho instead of r
//   start  G0 = the point on the bisector whose rho-disc touches both walls; the
//              orbit starts here, so the whole first orbit must already be air
//   orbit  R  = rho - r, centre advancing G0 -> Q by `a` per orbit
// The cut width of an orbit at its leading point is a x rho / R (the crescent is a
// thick at the lobe edge, which travels rho / R times faster than the tool centre),
// so a = GENTLE_ADVANCE_SAFETY x cap x R / rho keeps it under the operator's cap
// (src/tests/cam/gentleCornerRelief.wo2317.test.ts measures it on a raster).
// G0's disc is checked as air against the main path at every level (sampled, each
// sample within r of a fed move at or below the level); if it is not - the band a
// Contour leaves is only 2r wide - rho shrinks toward r until it fits. A level no
// candidate fits is not relieved, the same rule as above.

import type { Vec2 } from '../../types'
import type { CornerReliefStyle, ToolpathMove } from './types'
import { signedArea } from './geometry'
import { rapidEntryAt, retractFrom } from './moves'
import { buildOpenTrochoid, orbitSenseFor, TROCHOIDAL_MIN_WIDTH_RATIO } from './trochoidal2d'

export type { CornerReliefStyle }

export const CORNER_RELIEF_STYLES: readonly CornerReliefStyle[] = ['none', 'dogbone', 't_bone', 'longest_edge']

export const CORNER_RELIEF_LABELS: Record<CornerReliefStyle, string> = {
  none: 'None',
  dogbone: 'Dogbone',
  t_bone: 'T-bone',
  longest_edge: 'Longest edge',
}

/** Smallest turn at a vertex that counts as a corner (interior angle below 165 deg).
 *  Shallower corners leave a notch under 0.01 r - nothing to relieve. */
export const RELIEF_MIN_TURN_RAD = (15 * Math.PI) / 180

/** How close (mm) the main path must pass to a point to count as having cut there. */
export const RELIEF_PATH_TOL_MM = 0.01

/** Gentle corner: engagement cap range and default, as ratios of the tool diameter. */
export const GENTLE_ENGAGEMENT_MIN_RATIO = 0.05
export const GENTLE_ENGAGEMENT_MAX_RATIO = 0.5
export const GENTLE_ENGAGEMENT_DEFAULT_RATIO = 0.25
/** Fraction of the cap the advance is sized for: covers the chord sampling and the
 *  centre's own advance into the crescent. */
export const GENTLE_ADVANCE_SAFETY = 0.8
/** Lobe radii tried, as ratios of r, widest first (the band-fit radius is added). */
const GENTLE_LOBE_RATIOS = [TROCHOIDAL_MIN_WIDTH_RATIO, 1.1, 1.05, 1.02]
/** Largest distance (mm) a tessellated arc chord may sit from the arc in the air check. */
const ARC_SAGITTA_MM = 0.002
/** Samples around the start disc's rim when checking it is air. */
const GENTLE_RIM_SAMPLES = 48

const EPS = 1e-9
const Z_EPS = 1e-6

/** One closed loop of the region an operation clears. */
export interface ReliefLoop {
  points: Vec2[]
  /** True when the cleared material is inside this loop (a pocket boundary, an inside
   *  contour); false when it is outside (a pocket island, an outside contour). */
  clearedInside: boolean
}

/** A corner of the cleared region and the geometry every style needs. */
export interface ReliefCornerGeometry {
  corner: Vec2
  /** Unit direction from the corner along each adjacent edge. */
  edgeA: Vec2
  edgeB: Vec2
  lengthA: number
  lengthB: number
  /** Unit bisector of the cleared-side wedge; points into it. */
  bisector: Vec2
  /** Cleared-side interior angle (rad), below pi. */
  interiorAngle: number
}

export type ReliefStyle = Exclude<CornerReliefStyle, 'none'>

/** The operation's corner-relief fields (Pocket and Contour carry the same three). */
export interface CornerReliefRequest {
  cornerRelief?: CornerReliefStyle
  cornerReliefGentle?: boolean
  cornerReliefEngagement?: number
}

/** The Max engagement field's limits for a tool (mm), shared by both lenses. */
export function gentleEngagementLimits(toolDiameter: number): { min: number; max: number } {
  return { min: toolDiameter * GENTLE_ENGAGEMENT_MIN_RATIO, max: toolDiameter * GENTLE_ENGAGEMENT_MAX_RATIO }
}

/** The engagement cap an operation asks for (mm). Unset follows the tool (0.25 D);
 *  a set value is kept, snapped into its range. */
export function resolveGentleEngagement(toolDiameter: number, engagement?: number): number {
  const { min, max } = gentleEngagementLimits(toolDiameter)
  const v = Number.isFinite(engagement) ? (engagement as number) : toolDiameter * GENTLE_ENGAGEMENT_DEFAULT_RATIO
  return Math.min(max, Math.max(min, v))
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y
const along = (p: Vec2, d: Vec2, t: number): Vec2 => ({ x: p.x + d.x * t, y: p.y + d.y * t })

function unit(a: Vec2): Vec2 | null {
  const len = Math.hypot(a.x, a.y)
  return len > EPS ? { x: a.x / len, y: a.y / len } : null
}

/** Turns smaller than this (rad) are straight: an edge split into collinear pieces. */
const STRAIGHT_TURN_RAD = 1e-4
const SAME_POINT_MM = 1e-6

/** The loop's real vertices: no closing duplicate, no repeated points and no collinear
 *  midpoints, so an edge drawn in several pieces is measured as one edge. */
function cornerVertices(points: Vec2[]): Vec2[] {
  let pts: Vec2[] = []
  for (const p of points) {
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > SAME_POINT_MM) pts.push(p)
  }
  while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= SAME_POINT_MM) pts.pop()
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    const keep: Vec2[] = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = unit(sub(pts[i], pts[(i - 1 + n) % n]))
      const b = unit(sub(pts[(i + 1) % n], pts[i]))
      if (a && b && Math.abs(Math.atan2(cross(a, b), dot(a, b))) < STRAIGHT_TURN_RAD) { changed = true; continue }
      keep.push(pts[i])
    }
    pts = keep
  }
  return pts
}

/**
 * Every corner of the cleared region a round cutter cannot reach. Each loop is rewritten
 * so the cleared side lies on the left of travel (Y-up: a CCW loop encloses its interior
 * on the left); a left turn sharper than RELIEF_MIN_TURN_RAD is then exactly a convex
 * corner of the cleared region. Edges shorter than 2r are skipped: the notch reaches 2r
 * along an edge, and arc tessellation is made of such short edges.
 */
export function findReliefCorners(loops: ReliefLoop[], toolRadius: number): ReliefCornerGeometry[] {
  const out: ReliefCornerGeometry[] = []
  if (!(toolRadius > 0)) return out
  const minEdge = 2 * toolRadius
  for (const loop of loops) {
    const raw = cornerVertices(loop.points)
    if (raw.length < 3) continue
    const clearedOnLeft = loop.clearedInside === (signedArea(raw) > 0)
    const pts = clearedOnLeft ? raw : [...raw].reverse()
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const corner = pts[i]
      const toPrev = sub(pts[(i - 1 + n) % n], corner)
      const toNext = sub(pts[(i + 1) % n], corner)
      const edgeA = unit(toPrev)
      const edgeB = unit(toNext)
      if (!edgeA || !edgeB) continue
      // Travel arrives along -edgeA and leaves along edgeB; a positive turn is a left turn.
      const turn = Math.atan2(-cross(edgeA, edgeB), -dot(edgeA, edgeB))
      if (!(turn > RELIEF_MIN_TURN_RAD)) continue
      const bisector = unit({ x: edgeA.x + edgeB.x, y: edgeA.y + edgeB.y })
      if (!bisector) continue
      const lengthA = Math.hypot(toPrev.x, toPrev.y)
      const lengthB = Math.hypot(toNext.x, toNext.y)
      if (lengthA < minEdge || lengthB < minEdge) continue
      out.push({ corner, edgeA, edgeB, lengthA, lengthB, bisector, interiorAngle: Math.PI - turn })
    }
  }
  return out
}

/** The edge a T-bone (or longest-edge) cut runs along. T-bone takes the edge nearer
 *  parallel to X; longest edge takes the longer edge and falls back to the same rule on
 *  a tie. Remaining ties prefer +X, then +Y (Y-up), so the choice never depends on
 *  where the loop starts. */
export function tBoneDirection(g: ReliefCornerGeometry, style: 't_bone' | 'longest_edge'): Vec2 {
  if (style === 'longest_edge' && Math.abs(g.lengthA - g.lengthB) > 1e-3) {
    return g.lengthA > g.lengthB ? g.edgeA : g.edgeB
  }
  const offA = Math.abs(g.edgeA.y), offB = Math.abs(g.edgeB.y)
  if (Math.abs(offA - offB) > 1e-9) return offA < offB ? g.edgeA : g.edgeB
  if (Math.abs(g.edgeA.x - g.edgeB.x) > 1e-9) return g.edgeA.x > g.edgeB.x ? g.edgeA : g.edgeB
  return g.edgeA.y >= g.edgeB.y ? g.edgeA : g.edgeB
}

/** Where the excursion ends, `distance` from `corner` (the cutter radius in production;
 *  a parameter so the tests can drive it short and prove the corner then keeps material). */
export function reliefExcursionEnd(
  g: ReliefCornerGeometry, style: ReliefStyle, distance: number, corner: Vec2 = g.corner,
): Vec2 {
  const dir = style === 'dogbone' ? g.bisector : tBoneDirection(g, style)
  return along(corner, dir, distance)
}

// ── Reading the main path ────────────────────────────────────────────────────

interface Seg { ax: number; ay: number; az: number; bx: number; by: number; bz: number }

/** The main path's fed moves as straight XY segments with their Z. Rapids are left out:
 *  they say nothing about where material was cut. Arcs are read as their chord; a
 *  corner's wall-pass apex is always a vertex, so this never misses one. */
function pathSegments(moves: readonly ToolpathMove[]): Seg[] {
  const segs: Seg[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    segs.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z })
  }
  return segs
}

/** The fed moves as the cutter really swept them: arcs tessellated (chord within
 *  ARC_SAGITTA_MM of the arc), so the gentle air check never credits the inside of an
 *  arc's chord as cut. */
function sweptSegments(moves: readonly ToolpathMove[]): Seg[] {
  const segs: Seg[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
      const rad = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let a1 = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw' && a1 <= a0 + 1e-12) a1 += 2 * Math.PI
      if (b.type === 'arc_cw' && a1 >= a0 - 1e-12) a1 -= 2 * Math.PI
      const step = rad > ARC_SAGITTA_MM ? 2 * Math.acos(1 - ARC_SAGITTA_MM / rad) : Math.PI
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step))
      let px = a.x, py = a.y, pz = a.z
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const ang = a0 + (a1 - a0) * t
        const nx = k === n ? b.x : b.cx + rad * Math.cos(ang)
        const ny = k === n ? b.y : b.cy + rad * Math.sin(ang)
        const nz = a.z + (b.z - a.z) * t
        segs.push({ ax: px, ay: py, az: pz, bx: nx, by: ny, bz: nz })
        px = nx; py = ny; pz = nz
      }
      continue
    }
    segs.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z })
  }
  return segs
}

/** Lowest Z the main path reached within RELIEF_PATH_TOL_MM of `p` (Infinity = never).
 *  A flat cutter at Z opens the whole column above it, so every level at or above this
 *  Z is air at `p`. */
function lowestReachAt(segs: readonly Seg[], p: Vec2): number {
  let best = Infinity
  const tol = RELIEF_PATH_TOL_MM
  for (const s of segs) {
    if (p.x < Math.min(s.ax, s.bx) - tol || p.x > Math.max(s.ax, s.bx) + tol ||
        p.y < Math.min(s.ay, s.by) - tol || p.y > Math.max(s.ay, s.by) + tol) continue
    const dx = s.bx - s.ax, dy = s.by - s.ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - s.ax) * dx + (p.y - s.ay) * dy) / lenSq))
    const qx = s.ax + dx * t, qy = s.ay + dy * t
    if ((p.x - qx) ** 2 + (p.y - qy) ** 2 > tol * tol) continue
    // Z along the segment at the closest point; a zero-length segment (a plunge) counts
    // at its lower end.
    const z = lenSq < EPS ? Math.min(s.az, s.bz) : s.az + (s.bz - s.az) * t
    if (z < best) best = z
  }
  return best
}

/** Lowest Z of a fed move whose cutter (radius `radius`) covered `p` (Infinity = never). */
function lowestCoverAt(segs: readonly Seg[], p: Vec2, radius: number): number {
  let best = Infinity
  const reach = radius + RELIEF_PATH_TOL_MM
  for (const s of segs) {
    if (p.x < Math.min(s.ax, s.bx) - reach || p.x > Math.max(s.ax, s.bx) + reach ||
        p.y < Math.min(s.ay, s.by) - reach || p.y > Math.max(s.ay, s.by) + reach) continue
    const dx = s.bx - s.ax, dy = s.by - s.ay
    const lenSq = dx * dx + dy * dy
    const t = lenSq < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - s.ax) * dx + (p.y - s.ay) * dy) / lenSq))
    const qx = s.ax + dx * t, qy = s.ay + dy * t
    if ((p.x - qx) ** 2 + (p.y - qy) ** 2 > reach * reach) continue
    // A sloped move (ramp, helix) counts at its higher end: never claims air too deep.
    const z = Math.max(s.az, s.bz)
    if (z < best) best = z
  }
  return best
}

/** The fed moves within `pad` of a box around `c`: the start-disc checks read only these. */
function segsNear(segs: readonly Seg[], c: Vec2, pad: number): Seg[] {
  return segs.filter(s =>
    Math.max(s.ax, s.bx) >= c.x - pad && Math.min(s.ax, s.bx) <= c.x + pad &&
    Math.max(s.ay, s.by) >= c.y - pad && Math.min(s.ay, s.by) <= c.y + pad)
}

/** The gentle cut for one corner: orbits of `orbitRadius` advancing `advance` per orbit
 *  from `start` (G0) to `lobe` (Q); together they clear a disc of `lobeRadius` at Q. */
export interface GentleRelief {
  start: Vec2
  lobe: Vec2
  lobeRadius: number
  orbitRadius: number
  advance: number
  toolDiameter: number
}

/** Advance per orbit that keeps the orbit's cut width under `cap` (see the header). */
export function gentleAdvance(cap: number, lobeRadius: number, orbitRadius: number): number {
  return GENTLE_ADVANCE_SAFETY * cap * orbitRadius / lobeRadius
}

/** Highest Z at which the rho-disc around `start` is entirely air (Infinity = never). */
function startDiscReach(segs: readonly Seg[], start: Vec2, rho: number, toolRadius: number): number {
  let reach = lowestCoverAt(segs, start, toolRadius)
  const rings: Array<[number, number]> = [[rho, GENTLE_RIM_SAMPLES], [rho / 2, 12]]
  for (const [rad, n] of rings) {
    for (let k = 0; k < n && Number.isFinite(reach); k++) {
      const t = (2 * Math.PI * k) / n
      reach = Math.max(reach, lowestCoverAt(segs, { x: start.x + rad * Math.cos(t), y: start.y + rad * Math.sin(t) }, toolRadius))
    }
  }
  return reach
}

/** Choose the widest lobe whose start disc is air at the most of `levels`. */
function planGentle(
  g: ReliefCornerGeometry, style: ReliefStyle, toolRadius: number, wallCorner: Vec2,
  levels: readonly number[], segs: readonly Seg[], cap: number,
): { gentle: GentleRelief; levels: number[] } | null {
  const sinHalf = Math.sin(g.interiorAngle / 2)
  const r = toolRadius
  // The widest disc touching both walls that a 2r-wide wall band (a Contour) still
  // covers: its far point sits rho (1 + sin(half)) from each wall.
  const widest = GENTLE_LOBE_RATIOS[0] * r
  const bandFit = Math.min(widest, r + 0.9 * (2 * r / (1 + sinHalf) - r))
  const radii = [...new Set([...GENTLE_LOBE_RATIOS.map(k => k * r), bandFit])]
    .filter(rho => rho > r * (1 + 1e-3))
    .sort((a, b) => b - a)
  if (radii.length === 0) return null
  const near = segsNear(segs, along(wallCorner, g.bisector, radii[0] / sinHalf), radii[0] + 2 * r)
  let best: { gentle: GentleRelief; levels: number[] } | null = null
  for (const rho of radii) {
    const start = along(wallCorner, g.bisector, rho / sinHalf)
    const reach = startDiscReach(near, start, rho, r)
    if (!Number.isFinite(reach)) continue
    const open = levels.filter(z => z >= reach - Z_EPS)
    if (open.length === 0 || (best && open.length <= best.levels.length)) continue
    const orbitRadius = rho - r
    best = {
      gentle: {
        start, lobe: reliefExcursionEnd(g, style, rho, wallCorner), lobeRadius: rho, orbitRadius,
        advance: gentleAdvance(cap, rho, orbitRadius), toolDiameter: 2 * r,
      },
      levels: open,
    }
    if (open.length === levels.length) break
  }
  return best
}

export interface PlacedRelief {
  geometry: ReliefCornerGeometry
  /** P: where the main path's wall pass turned this corner; the relief descends here. */
  descend: Vec2
  /** E: where the excursion ends, the cutter just touching the corner of the wall the
   *  operation leaves. */
  end: Vec2
  /** The levels this corner is relieved at, top down. */
  levels: number[]
  /** WO-2317: present when the corner is cut gently (orbits) instead of straight. */
  gentle?: GentleRelief
}

/**
 * Place each corner on the path the operation actually emitted. The wall the operation
 * leaves sits `wall` mm off the drawn edge: 0 when a finish wall ran, the radial stock
 * when only a roughing wall did. Each candidate is tried nearest-the-corner first; the
 * first one the main path passed through wins. The descend point must be on the path;
 * so must any of its neighbours r/2 and r back along each wall that the path runs
 * through in XY (a narrow slot's wall can be shorter than that), and all of them must be
 * open at a level for the corner to be relieved there - that keeps the cut off a holding
 * tab beside the corner. With `gentleCap` set (mm) each corner is planned gently
 * instead (planGentle), at the levels both checks leave open.
 */
export function placeReliefCorners(
  corners: readonly ReliefCornerGeometry[],
  style: ReliefStyle,
  toolRadius: number,
  wallCandidates: readonly number[],
  levels: readonly number[],
  mainPath: readonly ToolpathMove[],
  gentleCap?: number,
): PlacedRelief[] {
  const segs = pathSegments(mainPath)
  const sweptSegs = gentleCap !== undefined ? sweptSegments(mainPath) : segs
  const out: PlacedRelief[] = []
  for (const g of corners) {
    const sinHalf = Math.sin(g.interiorAngle / 2)
    if (!(sinHalf > EPS)) continue
    for (const wall of wallCandidates) {
      const descend = along(g.corner, g.bisector, (toolRadius + wall) / sinHalf)
      const probes = [descend]
      for (const k of [0.5, 1]) {
        probes.push(along(descend, g.edgeA, k * toolRadius), along(descend, g.edgeB, k * toolRadius))
      }
      let reach = lowestReachAt(segs, descend)
      if (!Number.isFinite(reach)) continue
      for (const p of probes.slice(1)) {
        const z = lowestReachAt(segs, p)
        if (Number.isFinite(z)) reach = Math.max(reach, z)
      }
      const open = levels.filter(z => z >= reach - Z_EPS)
      if (open.length === 0) break
      const wallCorner = along(g.corner, g.bisector, wall / sinHalf)
      const end = reliefExcursionEnd(g, style, toolRadius, wallCorner)
      if (gentleCap !== undefined) {
        const plan = planGentle(g, style, toolRadius, wallCorner, open, sweptSegs, gentleCap)
        if (plan) out.push({ geometry: g, descend, end, levels: plan.levels, gentle: plan.gentle })
        break
      }
      out.push({ geometry: g, descend, end, levels: open })
      break
    }
  }
  return out
}

export interface ReliefEmitOptions {
  feedZ: number
  retractZ: number
  clearanceZ: number
  feedRate: number
  plungeRate: number
  /** The planner's cut-hand-resolved direction; sets a gentle orbit's sense. Absent = climb. */
  direction?: 'climb' | 'conventional'
}

/** A gentle corner's orbits at one level, from the tool at the descend point P back
 *  to P: out to the first orbit point (inside the air disc at G0), the trochoid G0 -> Q
 *  with its closing orbit at Q, then back along the guide to G0 and to P - every move
 *  of the return lies in what the orbits and the main path already cleared. */
function gentleLevelPath(g: GentleRelief, p: Vec2, direction: 'climb' | 'conventional'): Vec2[] | null {
  const orbit = buildOpenTrochoid([g.start, g.lobe], {
    orbitRadius: g.orbitRadius, advance: g.advance, toolDiameter: g.toolDiameter, sense: orbitSenseFor(direction),
  })
  if (!orbit) return null
  return [...orbit.points, g.start, p]
}

/**
 * Append the relief pass: per corner (nearest first from where the tool is), rapid over
 * the descend point, then at each level feed down through the opened column, cut out to
 * the excursion end and back (or, gentle, the orbits and back), and retract once the
 * corner is done.
 */
export function emitCornerRelief(
  moves: ToolpathMove[], placed: readonly PlacedRelief[], opts: ReliefEmitOptions,
): void {
  if (placed.length === 0) return
  const last = moves[moves.length - 1]
  if (last && last.z < opts.clearanceZ - Z_EPS) retractFrom(moves, opts.retractZ, opts.clearanceZ)
  const remaining = [...placed]
  let from: Vec2 = last ? { x: last.x, y: last.y } : remaining[0].descend
  while (remaining.length > 0) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i].descend.x - from.x) ** 2 + (remaining[i].descend.y - from.y) ** 2
      if (d < bd) { bd = d; bi = i }
    }
    const [c] = remaining.splice(bi, 1)
    const { descend: p, end: e } = c
    const route = c.gentle ? gentleLevelPath(c.gentle, p, opts.direction ?? 'climb') : [e, p]
    if (!route) continue
    rapidEntryAt(moves, p, opts.feedZ, opts.retractZ, opts.clearanceZ)
    for (const z of c.levels) {
      moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: opts.plungeRate, role: 'plunge' })
      for (const q of route) moves.push({ type: 'feed', x: q.x, y: q.y, z, feed: opts.feedRate, role: 'cut' })
    }
    retractFrom(moves, opts.retractZ, opts.clearanceZ)
    from = p
  }
}

export interface CornerReliefGroup {
  loops: ReliefLoop[]
  /** The operation's own depth levels for these loops, top down. */
  levels: readonly number[]
}

/** The one call an operation makes: find, place and append the relief for its loops.
 *  Takes the operation's params (or a bare style). `none`/absent appends nothing, so
 *  the operation's moves are untouched; gentle off is the straight cut as before. */
export function appendCornerRelief(
  moves: ToolpathMove[],
  request: CornerReliefRequest | CornerReliefStyle | undefined,
  toolRadius: number,
  wallStock: number,
  groups: readonly CornerReliefGroup[],
  opts: ReliefEmitOptions,
): void {
  const req: CornerReliefRequest = typeof request === 'string' ? { cornerRelief: request } : request ?? {}
  const style = req.cornerRelief
  if (!style || style === 'none' || !(toolRadius > 0)) return
  const gentleCap = req.cornerReliefGentle === true
    ? resolveGentleEngagement(2 * toolRadius, req.cornerReliefEngagement) : undefined
  const walls = wallStock > 1e-6 ? [0, wallStock] : [0]
  const placed: PlacedRelief[] = []
  for (const group of groups) {
    const corners = findReliefCorners(group.loops, toolRadius)
    placed.push(...placeReliefCorners(corners, style, toolRadius, walls, group.levels, moves, gentleCap))
  }
  emitCornerRelief(moves, placed, opts)
}
