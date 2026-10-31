// V-carve toolpath builder.
//
// What the operator gets (the sign-maker's V-carve every router CAM ships):
//   - the V-bit rides the medial axis of every closed region, tip depth =
//     (inscribed radius - tip radius) / tan(half angle), so both walls of the
//     groove are the drawn outline and convex corners come to a sharp point
//     at the surface;
//   - a flat depth (the operator's, or the bit's own physical limit) clips the
//     carve: wherever the region is wider than the bit can reach at that
//     depth, the walls are cut at the flat depth along the inset outline and
//     the floor between them is cleared flat;
//   - floors are cleared by this V-bit (concentric rings, stepover chosen by
//     the operator), by a separate end mill as its own sibling operation
//     (role 'flat_clearing', built here too), or left alone;
//   - start depth, allowance and multi-depth passes.
//
// Heights: Material Start (topZ) already includes the start depth; bottomZ is
// Material Start minus the effective maximum depth, both resolved by Smart
// Height V2 in the store. The builder recomputes the depth limit from the
// tool and never cuts below whichever of the two is shallower.
//
// Refusals are thrown (ADR-0003): no closed loop selected, a tool with no tip
// angle, a flat depth the bit cannot cut, a region the bit's tip flat cannot
// enter anywhere.

import type { ToolpathMove, VCarveWorkerPayload, LoopData, PocketWorkerPayload, PocketParams } from '../types'
import type { Tool } from '../../../types'
import { resolveHeights } from '../heights'
import { resolveFeedrates } from '../feedrates'
import { entryMaterialOf, entryStartOver, hopTo, retractFrom } from '../moves'
import { assertToolFluteReach } from '../toolFluteReach'
import { toolHalfAngleRad } from '../geometry'
import { buildPocketToolpath } from '../pocket2d'
import { medialAxis, type AxisNode, type AxisPath, type Pt, type Region } from './medialAxis'
import { buildRegions, insetRegion, regionBounds, regionLoops, regionPerimeter, regionContains, treeToRegions } from './regions'
import { differenceTree, offsetLoops, offsetTree, treeToOrientedLoops, type Loops } from './clipper'

export { ensureVCarveClipperReady, vcarveClipperReady } from './clipper'
export { medialAxis } from './medialAxis'
export { buildRegions } from './regions'
export type { AxisNode, AxisPath, Region } from './medialAxis'

// ---------------------------------------------------------------------------
// Tool geometry
// ---------------------------------------------------------------------------

export interface VBitGeometry {
  /** tan of the half angle (per side, from the axis). */
  tanHalf: number
  tipRadius: number
  /** Deepest cut this bit can make: full diameter reached, or flute length. */
  physicalMaxDepth: number
}

export function vbitGeometry(tool: Pick<Tool, 'angleFromAxisDeg' | 'tipDiameter' | 'diameter' | 'fluteLength' | 'name'>): VBitGeometry {
  const angle = tool.angleFromAxisDeg
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle <= 0 || angle >= 90) {
    throw new Error(
      `V-carve: tool "${tool.name}" has no usable tip angle. ` +
      'Choose a V-bit, engraving bit or chamfer mill with an angle between 0 and 90 degrees per side.',
    )
  }
  const tanHalf = Math.tan(toolHalfAngleRad(angle))
  const tipRadius = Math.max(0, (tool.tipDiameter ?? 0) / 2)
  const radius = tool.diameter / 2
  if (!(radius > tipRadius)) {
    throw new Error(`V-carve: tool "${tool.name}" tip flat (${(tipRadius * 2).toFixed(3)} mm) is not smaller than its diameter (${tool.diameter} mm).`)
  }
  const flute = Number.isFinite(tool.fluteLength) && tool.fluteLength > 0 ? tool.fluteLength : Infinity
  const physicalMaxDepth = Math.min(flute, (radius - tipRadius) / tanHalf)
  return { tanHalf, tipRadius, physicalMaxDepth }
}

/** Effective maximum carve depth: the operator's flat depth when set, else
 *  the bit's physical limit. Refuses a flat depth the bit cannot reach. */
export function effectiveMaxDepth(geom: VBitGeometry, flatDepthMm: number | undefined, toolName: string): number {
  if (flatDepthMm === undefined) return geom.physicalMaxDepth
  if (!Number.isFinite(flatDepthMm) || flatDepthMm <= 0) {
    throw new Error('V-carve: flat depth must be a positive distance below Material Start.')
  }
  if (flatDepthMm > geom.physicalMaxDepth + 1e-9) {
    throw new Error(
      `V-carve: flat depth ${flatDepthMm.toFixed(3)} mm is deeper than tool "${toolName}" can cut ` +
      `(${geom.physicalMaxDepth.toFixed(3)} mm at its full diameter or flute length). Reduce the flat depth or choose a larger bit.`,
    )
  }
  return flatDepthMm
}

/** Depth below Material Start for an inscribed radius r (>= 0, clipped). */
export function depthForRadius(r: number, geom: VBitGeometry, maxDepth: number): number {
  const d = (r - geom.tipRadius) / geom.tanHalf
  return d <= 0 ? 0 : d >= maxDepth ? maxDepth : d
}

// ---------------------------------------------------------------------------
// Ridge path helpers
// ---------------------------------------------------------------------------

interface Ridge3 { x: number; y: number; d: number }

/** Split an axis path into runs where the radius stays at or below rFlat,
 *  interpolating the crossing point so each run ends exactly on the flat
 *  boundary. Runs inside the flat region are handled by the wall pass. */
function splitByRadius(path: AxisPath, rFlat: number): AxisNode[][] {
  // A closed chain starts at its widest point so the seam falls inside the
  // flat region and never splits one run in two.
  let base = path.points
  if (path.closed && base.length > 1) {
    let widest = 0
    for (let i = 1; i < base.length; i++) if (base[i].r > base[widest].r) widest = i
    base = [...base.slice(widest), ...base.slice(0, widest)]
  }
  const pts = path.closed && base.length > 1 ? [...base, base[0]] : base
  const runs: AxisNode[][] = []
  let cur: AxisNode[] = []
  const flush = () => { if (cur.length >= 1) runs.push(cur); cur = [] }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const inside = p.r <= rFlat
    if (i > 0) {
      const q = pts[i - 1]
      const qInside = q.r <= rFlat
      if (qInside !== inside) {
        const t = (rFlat - q.r) / (p.r - q.r)
        const x = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, r: rFlat }
        if (qInside) { cur.push(x); flush() } else { cur.push(x) }
      }
    }
    if (inside) cur.push(p)
    else if (cur.length) flush()
  }
  flush()
  return runs.filter(r => r.length >= 1)
}

/** Keep the portions of a run deeper than `minDepth` (for the earlier of the
 *  multi-depth passes, so a shallow pass does not re-trace what it already
 *  cut), splitting at the crossings. */
function trimShallower(run: Ridge3[], minDepth: number): Ridge3[][] {
  if (minDepth <= 0) return [run]
  const out: Ridge3[][] = []
  let cur: Ridge3[] = []
  const flush = () => { if (cur.length >= 2) out.push(cur); cur = [] }
  for (let i = 0; i < run.length; i++) {
    const p = run[i]
    const deep = p.d > minDepth
    if (i > 0) {
      const q = run[i - 1]
      const qDeep = q.d > minDepth
      if (qDeep !== deep) {
        const t = (minDepth - q.d) / (p.d - q.d)
        const x = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, d: minDepth }
        if (qDeep) { cur.push(x); flush() } else { cur.push(x) }
      }
    }
    if (deep) cur.push(p)
    else if (cur.length) flush()
  }
  flush()
  return out
}

// Ridge runs that meet at a medial-axis junction share the junction node, so
// their ends coincide exactly (same point, same depth); this tolerance only
// absorbs float noise.
const JOIN_EPS = 1e-6

/** Join ridge runs into as few continuous cuts as possible. A run that starts
 *  where the cut in hand ends (a medial-axis junction: same point, same depth)
 *  is cut straight on with the tool down: the tool never leaves the groove.
 *  Only when no run continues from the tip does the tool lift; it then goes to
 *  the nearest free end, branch tips (odd remaining degree) first, so a
 *  letter's strokes are cut tip to tip instead of junction-out in pieces.
 *  Runs may be reversed. */
function chainRuns(runs: Ridge3[][], from?: Pt): Ridge3[][] {
  const key = (p: Ridge3) => `${Math.round(p.x / JOIN_EPS)},${Math.round(p.y / JOIN_EPS)}`
  const same = (a: Ridge3, b: Ridge3) =>
    Math.abs(a.x - b.x) <= JOIN_EPS && Math.abs(a.y - b.y) <= JOIN_EPS && Math.abs(a.d - b.d) <= JOIN_EPS
  const ends = new Map<string, number[]>()
  runs.forEach((run, i) => {
    for (const p of [run[0], run[run.length - 1]]) {
      const k = key(p)
      const list = ends.get(k)
      if (list) list.push(i)
      else ends.set(k, [i])
    }
  })
  const used = runs.map(() => false)
  // Free run ends left at a point (a closed run counts twice, as it should).
  const degree = (p: Ridge3) => (ends.get(key(p)) ?? []).filter(i => !used[i]).length
  const chains: Ridge3[][] = []
  let pos = from
  let left = runs.length
  while (left > 0) {
    let bi = -1, brev = false, bd = Infinity, bodd = false
    for (let i = 0; i < runs.length; i++) {
      if (used[i]) continue
      const run = runs[i]
      for (const rev of [false, true]) {
        const p = rev ? run[run.length - 1] : run[0]
        const odd = degree(p) % 2 === 1
        const d = pos ? (p.x - pos.x) ** 2 + (p.y - pos.y) ** 2 : 0
        if ((odd && !bodd) || (odd === bodd && d < bd)) { bi = i; brev = rev; bd = d; bodd = odd }
      }
    }
    used[bi] = true
    left--
    const chain = brev ? [...runs[bi]].reverse() : [...runs[bi]]
    // Walk on while a run continues from the tip, preferring one that does
    // not end in a dead end so the walk runs through junctions.
    for (;;) {
      const tip = chain[chain.length - 1]
      let next = -1, nextRev = false, nextDead = true
      for (const i of ends.get(key(tip)) ?? []) {
        if (used[i]) continue
        const run = runs[i]
        const rev = !same(run[0], tip)
        if (rev && !same(run[run.length - 1], tip)) continue
        const far = rev ? run[0] : run[run.length - 1]
        const dead = degree(far) <= (same(far, tip) ? 2 : 1)
        if (next < 0 || (nextDead && !dead)) { next = i; nextRev = rev; nextDead = dead }
      }
      if (next < 0) break
      used[next] = true
      left--
      const run = nextRev ? [...runs[next]].reverse() : runs[next]
      for (let k = 1; k < run.length; k++) chain.push(run[k])
    }
    chains.push(chain)
    pos = chain[chain.length - 1]
  }
  return chains
}

function polylineLength(pts: readonly Pt[]): number {
  let length = 0
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return length
}

/** Fold the ridge runs that touch a wall loop into that loop as out-and-back
 *  excursions, so a corner's ridge (the V that runs from the flat floor's
 *  corner up to the letter's sharp corner) is cut on the way round the wall
 *  instead of as its own plunge with a lift either side.
 *
 *  A run qualifies when one of its points at this level's depth `c` lies
 *  within `reach` of the loop (the wall at depth c sits exactly where the
 *  inscribed radius gives depth c, so the ridge crosses the wall there). The
 *  tool leaves the wall at the nearest loop point Q, cuts to that ridge point
 *  S, out to each end of the run and back to S along the groove it has just
 *  cut, then returns to Q. Every point of the excursion is a point the old
 *  separate ridge pass cut at the same depth, so the carved result does not
 *  change; the return legs only re-trace the groove. A run whose return legs
 *  are longer than `maxReturn` keeps its own pass.
 *
 *  Returns the loop as one closed path from loop[0] back to loop[0], with
 *  depth `c` on the wall points; marks the folded runs in `used`. */
function foldRunsIntoWall(
  loop: readonly Pt[], c: number, runs: readonly Ridge3[][], used: boolean[], reach: number, maxReturn: number,
  legInside: (q: Pt, s: Pt) => boolean,
): Ridge3[] {
  const n = loop.length
  const inserts: { seg: number; t: number; path: Ridge3[] }[] = []
  for (let ri = 0; ri < runs.length; ri++) {
    if (used[ri]) continue
    const run = runs[ri]
    let best = { dist: Infinity, s: -1, seg: -1, t: 0, q: { x: 0, y: 0 } }
    for (let s = 0; s < run.length; s++) {
      const p = run[s]
      if (Math.abs(p.d - c) > JOIN_EPS) continue
      for (let i = 0; i < n; i++) {
        const a = loop[i], b = loop[(i + 1) % n]
        const dx = b.x - a.x, dy = b.y - a.y
        const l2 = dx * dx + dy * dy
        let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const q = { x: a.x + dx * t, y: a.y + dy * t }
        const dist = Math.hypot(p.x - q.x, p.y - q.y)
        if (dist < best.dist) best = { dist, s, seg: i, t, q }
      }
    }
    // The leg from the wall to the ridge must stay on this level's floor: a
    // ridge in a neighbouring floor (or across a counter) closer than
    // `reach` belongs to another wall.
    if (best.s < 0 || best.dist > reach || !legInside(best.q, run[best.s])) continue
    const toStart = run.slice(0, best.s + 1).reverse()
    const toEnd = run.slice(best.s)
    if (polylineLength(toStart) + polylineLength(toEnd) > maxReturn) continue
    const q: Ridge3 = { x: best.q.x, y: best.q.y, d: c }
    const path: Ridge3[] = [q]
    for (const leg of [toStart, toEnd]) {
      if (leg.length < 2) continue
      // Out along the leg from S and back to S.
      for (const p of leg) path.push(p)
      for (let k = leg.length - 2; k >= 0; k--) path.push(leg[k])
    }
    if (path.length === 1) path.push(run[best.s])
    path.push(q)
    inserts.push({ seg: best.seg, t: best.t, path })
    used[ri] = true
  }
  inserts.sort((a, b) => a.seg - b.seg || a.t - b.t)
  const out: Ridge3[] = [{ x: loop[0].x, y: loop[0].y, d: c }]
  let k = 0
  for (let i = 0; i < n; i++) {
    while (k < inserts.length && inserts[k].seg === i) for (const p of inserts[k++].path) out.push(p)
    const b = loop[(i + 1) % n]
    out.push({ x: b.x, y: b.y, d: c })
  }
  return out
}

/** A closed loop restarted at its vertex nearest `pos`, so the link into it
 *  is as short as it can be (where a closed loop starts changes nothing it
 *  cuts). */
function startNearest(loop: Pt[], pos: Pt | undefined): Pt[] {
  if (!pos) return loop
  let bi = 0, bd = Infinity
  for (let i = 0; i < loop.length; i++) {
    const d = (loop[i].x - pos.x) ** 2 + (loop[i].y - pos.y) ** 2
    if (d < bd) { bd = d; bi = i }
  }
  return bi === 0 ? loop : [...loop.slice(bi), ...loop.slice(0, bi)]
}

/** Does the straight segment a-b lie inside the regions (sampled every
 *  `step` mm)? A sample within `edgeTol` of a region's boundary counts as
 *  inside: a floor's own edge is where its rings and core tips end. */
function segmentInside(regions: readonly Region[], a: Pt, b: Pt, step: number, edgeTol = 0): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(2, Math.ceil(len / step))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    let inside = false
    for (const r of regions) if (regionContains(r, p) || (edgeTol > 0 && nearBoundary(r, p, edgeTol))) { inside = true; break }
    if (!inside) return false
  }
  return true
}

/** Sample spacing for a stay-down link test: fine enough that a link cannot
 *  step over a sliver of standing material between two floors. */
function linkSampleStep(stepover: number, tol: number): number {
  return Math.min(stepover, 0.5, Math.max(4 * tol, 0.05))
}

function nearBoundary(region: Region, p: Pt, eps: number): boolean {
  for (const loop of regionLoops(region)) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= eps) return true
    }
  }
  return false
}

/** Carry the tool from where it stopped to `p` and plunge to `pz`.
 *
 *  Inside a letter the tool has already carved a groove around itself, so it
 *  need not climb to Retract: no material can stand higher, at a point, than
 *  the lowest cone surface any earlier cut of this letter left there (the
 *  letter's cuts, indexed in `cuts`). The tool lifts to just
 *  above that bound along the whole straight link (liftedLinkZ), feeds
 *  across and plunges. The tip and its cone stay clear of every material
 *  column, so the link cuts nothing and the carve is the one a hop leaves.
 *  When the link would have to rise to Material Start (it crosses uncut
 *  stock) the tool hops at Retract instead. */
function linkTo(
  moves: ToolpathMove[], cuts: CutIndex, p: Pt, pz: number, topZ: number, geom: VBitGeometry,
  feedZ: number, retractZ: number, clearanceZ: number, feedRate: number, plungeRate: number, minimizeZTravel?: boolean,
): void {
  const last = moves[moves.length - 1]
  // A long link is quicker as a rapid hop than at feed, so only short ones ride.
  const short = last && Math.hypot(p.x - last.x, p.y - last.y) <= 4 * cuts.cell
  const lift = short && last.type === 'feed' ? liftedLinkZ(moves, cuts, last, p, geom, topZ, Math.min(topZ, retractZ)) : Infinity
  const across = Math.max(lift, last ? last.z : -Infinity, pz)
  if (across < topZ && across < retractZ) {
    if (across > last.z) moves.push({ type: 'feed', x: last.x, y: last.y, z: across, feed: feedRate, role: 'stepover' })
    moves.push({ type: 'feed', x: p.x, y: p.y, z: across, feed: feedRate, role: minimizeZTravel === false ? 'loop_back' : 'stepover' })
  } else {
    hopTo(moves, p, feedZ, retractZ, clearanceZ)
  }
  moves.push({ type: 'feed', x: p.x, y: p.y, z: pz, feed: plungeRate, role: 'plunge' })
}

const LIFT_MARGIN = 0.05

/** Carry the tool to a point and plunge it to a height there. */
type Link = (p: Pt, pz: number) => void

/** The feed moves of one letter, binned on a grid one bit reach wide, so a
 *  link looks only at the cuts that can reach it. `upTo` is how far into the
 *  move list the bins are filled; each bin holds indices k of moves whose
 *  segment from k - 1 crosses it. */
interface CutIndex { upTo: number; cell: number; bins: Map<number, number[]> }

function cutIndex(from: number, geom: VBitGeometry): CutIndex {
  return { upTo: from + 1, cell: Math.max(geom.tipRadius + geom.physicalMaxDepth * geom.tanHalf, 0.1), bins: new Map() }
}

// Bins are keyed by one number; a sign spans far fewer than a million bins.
const binKey = (i: number, j: number) => i * 1_000_003 + j

function indexCuts(moves: readonly ToolpathMove[], index: CutIndex): void {
  const { cell, bins } = index
  for (let k = Math.max(1, index.upTo); k < moves.length; k++) {
    const c = moves[k], q = moves[k - 1]
    if (c.type !== 'feed') continue
    const i0 = Math.floor(Math.min(q.x, c.x) / cell), i1 = Math.floor(Math.max(q.x, c.x) / cell)
    const j0 = Math.floor(Math.min(q.y, c.y) / cell), j1 = Math.floor(Math.max(q.y, c.y) / cell)
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = binKey(i, j)
      const bin = bins.get(key)
      if (bin) bin.push(k)
      else bins.set(key, [k])
    }
  }
  index.upTo = Math.max(index.upTo, moves.length)
}

/** The lowest height at which the tool can travel straight from `a` to `b`
 *  without touching material, given only the cuts made so far (the letter's
 *  moves, binned in `index`), plus `LIFT_MARGIN`.
 *
 *  A cut whose tip passed at height zc, d away from a point p of the link,
 *  leaves no material higher than zc + (|q - c| - tipRadius) / tanHalf at any
 *  column q. The link's tip at p, at height L, comes down to L + (|q - p| -
 *  tipRadius) / tanHalf over q. With |q - c| <= d + |q - p|, the link clears
 *  every column once L >= zc + d / tanHalf, the tip flat included; so the
 *  link rides at the highest, along it, of the lowest such bound over the
 *  cuts. The bound rises at most 1 / tanHalf per mm along the link, and the
 *  samples are close enough that it rises less than half the margin between
 *  them. A cut lowers nothing beyond the reach of the bit's cone, so a cut
 *  bounds only what the link's cone (out to Material Start, `topZ`) can
 *  reach from within it. Stops early, returning Infinity, once the link
 *  would have to rise to `ceiling`. */
function liftedLinkZ(
  cuts: readonly ToolpathMove[], index: CutIndex, a: Pt, b: Pt, geom: VBitGeometry, topZ: number, ceiling: number,
): number {
  indexCuts(cuts, index)
  const reach = geom.tipRadius + geom.physicalMaxDepth * geom.tanHalf
  const cell = index.cell
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const steps = Math.max(1, Math.ceil(len / Math.min(0.02, LIFT_MARGIN * geom.tanHalf)))
  let worst = -Infinity
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
    let bound = Infinity
    // The bins within reach of this point (a bin is at least reach wide).
    const i0 = Math.floor((x - reach) / cell), i1 = Math.floor((x + reach) / cell)
    const j0 = Math.floor((y - reach) / cell), j1 = Math.floor((y + reach) / cell)
    for (let bi = i0; bi <= i1; bi++) for (let bj = j0; bj <= j1; bj++) for (const k of index.bins.get(binKey(bi, bj)) ?? []) {
      const c = cuts[k]
      const q = cuts[k - 1]
      const dx = c.x - q.x, dy = c.y - q.y
      const l2 = dx * dx + dy * dy
      let u = l2 > 0 ? ((x - q.x) * dx + (y - q.y) * dy) / l2 : 0
      u = u < 0 ? 0 : u > 1 ? 1 : u
      const d = Math.hypot(q.x + dx * u - x, q.y + dy * u - y)
      const zc = Math.max(q.z, c.z)
      if (d + geom.tipRadius + (topZ - zc) * geom.tanHalf > reach) continue
      const h = zc + d / geom.tanHalf
      if (h < bound) bound = h
    }
    if (bound > worst) worst = bound
    if (worst + LIFT_MARGIN >= ceiling) return Infinity
  }
  return worst + LIFT_MARGIN
}

/** The region (letter) nearest the tool, so the carve walks along the sign
 *  instead of jumping across it. */
function nearestRegion(regions: readonly Region[], pos: Pt | undefined): number {
  if (!pos) return 0
  let bi = 0, bd = Infinity
  for (let i = 0; i < regions.length; i++) {
    const b = regionBounds(regions[i])
    const dx = Math.max(b.minX - pos.x, 0, pos.x - b.maxX)
    const dy = Math.max(b.minY - pos.y, 0, pos.y - b.maxY)
    const d = dx * dx + dy * dy
    if (d < bd) { bd = d; bi = i }
  }
  return bi
}

/** Start a closed run at its shallowest point so the plunge is minimal. */
function rotateToShallowest(run: Ridge3[]): Ridge3[] {
  let best = 0
  for (let i = 1; i < run.length; i++) if (run[i].d < run[best].d) best = i
  return [...run.slice(best), ...run.slice(0, best)]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildVCarveToolpath(
  payload: VCarveWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, heights, passes, tool, loops, wcsOrigin } = payload
  const { clearanceZ, retractZ, feedZ: feedPlaneZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
  const { feedRate, plungeRate } = resolveFeedrates(tool, payload.feedrateOverride)
  const tol = params.tolerance > 0 ? params.tolerance : 0.01

  // Closed loops only; loopIds narrows when given.
  const selected = loops.filter(l =>
    l.closed && l.points.length >= 3 && (params.loopIds.length === 0 || params.loopIds.includes(l.id)))
  if (selected.length === 0) {
    throw new Error('V-carve: no closed outline selected. Pick closed loops (letters, shapes); open curves cannot be V-carved.')
  }
  // WO-3083: every plunge starts ENTRY_CLEARANCE_MM above the highest material the outlines and
  // the bit sit over (was the Feed plane, Top + 5). The tool hops between cuts at Retract
  // (moves hopTo, promoted from here).
  const feedZ = entryStartOver(entryMaterialOf(payload, topZ, feedPlaneZ), selected.flatMap(l => l.points), tool.diameter / 2)

  const regions = buildRegions(selected.map(l => l.points), { allowanceMm: params.allowanceMm, arcTol: tol })
  if (regions.length === 0) {
    throw new Error('V-carve: the selected outlines enclose no area after welding and allowance.')
  }

  if (params.role === 'flat_clearing') return buildFlatClearing(payload, regions, { clearanceZ, retractZ, feedZ, topZ, bottomZ }, onProgress)

  const geom = vbitGeometry(tool)
  const maxDepthByTool = effectiveMaxDepth(geom, params.flatDepthMm, tool.name)
  // Never below the resolver's bottom plane either.
  const maxDepth = Math.min(maxDepthByTool, Math.max(0, topZ - bottomZ))
  if (!(maxDepth > 0)) throw new Error('V-carve: Material Start is not above Cutter End; nothing to carve.')
  assertToolFluteReach({ operation: 'V-carve', topZ, bottomZ: topZ - maxDepth, fluteLength: tool.fluteLength })
  const rFlat = geom.tipRadius + maxDepth * geom.tanHalf

  const moves: ToolpathMove[] = []
  const stepdown = passes.stepdown > 0 ? passes.stepdown : maxDepth
  const levelCount = Math.ceil(maxDepth / stepdown - 1e-9)
  if (levelCount > 200) {
    throw new Error(
      `V-carve: stepdown ${stepdown} mm over ${maxDepth.toFixed(2)} mm of depth makes ${levelCount} passes. Use a stepdown of at least ${(maxDepth / 200).toFixed(3)} mm.`,
    )
  }
  const clampLevels: number[] = []
  for (let c = stepdown; c < maxDepth - 1e-9; c += stepdown) clampLevels.push(c)
  clampLevels.push(maxDepth)

  const total = regions.length || 1
  let anyCut = false
  const pending = [...regions]
  for (let ri = 0; pending.length; ri++) {
    const region = pending.splice(nearestRegion(pending, moves[moves.length - 1]), 1)[0]
    const cuts = cutIndex(moves.length, geom)
    const link: Link = (p, pz) => linkTo(moves, cuts, p, pz, topZ, geom, feedZ, retractZ, clearanceZ, feedRate, plungeRate, heights.minimizeZTravel)
    const phase = total > 1 ? `V-carve region ${ri + 1}/${total}` : 'V-carve'
    onProgress?.(ri / total, phase)

    // Flat floors: where the region is wider than the bit reaches at maxDepth.
    const flats = insetRegion(region, rFlat, tol)

    // Ridge runs along the medial axis.
    const spacing = sampleSpacing(region, tol)
    const paths = medialAxis(region, { spacing })
    const runs: Ridge3[][] = []
    const closedRuns: Ridge3[][] = []
    for (const path of paths) {
      if (path.points.length === 1) {
        // A disc-like region: one dimple at the deepest point.
        const p = path.points[0]
        const d = depthForRadius(p.r, geom, maxDepth)
        if (d > 0 && !flats.length) runs.push([{ x: p.x, y: p.y, d }, { x: p.x, y: p.y, d }])
        continue
      }
      const pieces = flats.length ? splitByRadius(path, rFlat) : [path.closed ? [...path.points, path.points[0]] : path.points]
      const wholeClosed = path.closed && pieces.length === 1 && pieces[0].length === path.points.length + 1
      for (const piece of pieces) {
        const run = piece.map(p => ({ x: p.x, y: p.y, d: depthForRadius(p.r, geom, maxDepth) }))
        if (run.length < 2) continue
        if (run.every(p => p.d <= 0)) continue
        if (wholeClosed) closedRuns.push(run.slice(0, -1))
        else runs.push(run)
      }
    }

    // One depth level at a time, so a deep flat depth never starts with a
    // full-depth plunge: the floor, then the wall with the ridges that meet
    // it folded in, then whatever ridge is left, chained through junctions.
    // At level c the final wall sits tipRadius + c * tan(half) inside the
    // outline; the bit centred on that inset with its tip at depth c has its
    // edge exactly on the wall, and everything inside it is floor to clear at
    // that depth.
    const stepover = params.flatClearing.stepoverMm > 0 ? params.flatClearing.stepoverMm : Math.max(geom.tipRadius * 2, 0.5)
    for (let li = 0; li < clampLevels.length; li++) {
      const c = clampLevels[li]
      const z = topZ - c
      const minDepth = li === 0 ? 0 : clampLevels[li - 1]
      const passRuns: Ridge3[][] = []
      for (const run of runs) {
        for (const piece of trimShallower(run, minDepth)) passRuns.push(piece.map(p => ({ ...p, d: Math.min(p.d, c) })))
      }
      for (const run of closedRuns) {
        const clamped = run.map(p => ({ ...p, d: Math.min(p.d, c) }))
        if (minDepth > 0 && run.some(p => p.d <= minDepth)) {
          const pieces = trimShallower([...run, run[0]], minDepth)
          for (const piece of pieces) passRuns.push(piece.map(p => ({ ...p, d: Math.min(p.d, c) })))
        } else {
          const rotated = rotateToShallowest(clamped)
          passRuns.push([...rotated, rotated[0]])
        }
      }
      const cutRuns = passRuns.filter(run => {
        if (run.length < 2) return false
        // A zero-length run (two junction nodes at one point) cuts nothing.
        return !(polylineLength(run) < 1e-6 && run.every(p => Math.abs(p.d - run[0].d) < 1e-9))
      })
      const folded = cutRuns.map(() => false)

      if (flats.length) {
        const levelFlats = c >= maxDepth - 1e-9 ? flats : insetRegion(region, geom.tipRadius + c * geom.tanHalf, tol)
        // The V-bit has just cleared this level's floor, so the tool may
        // stay down where the floor's last ring meets the wall.
        const floorCleared = params.flatClearing.mode === 'vbit'
        if (params.flatClearing.mode !== 'none') {
          let floorLoops: Loops = levelFlats.flatMap(regionLoops)
          if (params.flatClearing.mode === 'tool') {
            const re = (params.flatClearing.clearingToolDiameter ?? 0) / 2
            if (re > 0) {
              // What the end mill can reach: erode then dilate by its radius.
              const reach = offsetLoops(offsetLoops(floorLoops, -re, tol), re, tol)
              floorLoops = treeToOrientedLoops(differenceTree(floorLoops, reach))
            }
          }
          if (floorLoops.length) {
            anyCut = emitFloorRings(moves, floorLoops, stepover, tol, z, feedRate, link) || anyCut
          }
        }
        for (const flat of levelFlats) {
          for (const wall of regionLoops(flat)) {
            if (wall.length < 3) continue
            const loop = startNearest(wall, moves[moves.length - 1])
            const path = foldRunsIntoWall(loop, c, cutRuns, folded, Math.max(2 * spacing, 4 * tol), 2 * Math.max(0, retractZ - z),
              (q, p) => segmentInside(levelFlats, q, p, linkSampleStep(stepover, tol), tol))
            const start = path[0]
            const last = moves[moves.length - 1]
            // The floor's outermost ring is this wall loop, so when the floor
            // ended where the wall starts the tool stays down. Any longer
            // link at depth would cut floor scallops the carve has never cut.
            const onFloor = floorCleared && last && last.type === 'feed' && Math.abs(last.z - z) < 1e-9 &&
              Math.hypot(last.x - start.x, last.y - start.y) <= tol
            if (onFloor) {
              moves.push({ type: 'feed', x: start.x, y: start.y, z, feed: feedRate, role: 'stepover' })
            } else {
              link(start, z)
            }
            for (let i = 1; i < path.length; i++) moves.push({ type: 'feed', x: path[i].x, y: path[i].y, z: topZ - path[i].d, feed: feedRate, role: 'cut' })
            anyCut = true
          }
        }
      }

      for (const chain of chainRuns(cutRuns.filter((_, i) => !folded[i]), moves[moves.length - 1])) {
        emitRidge(moves, chain, topZ, feedRate, link)
        anyCut = true
      }
    }
  }

  if (!anyCut) {
    throw new Error(
      `V-carve: tool "${tool.name}" cannot enter the selected outlines anywhere - every part of the drawing is narrower than its ${(geom.tipRadius * 2).toFixed(2)} mm tip flat. Choose a sharper bit or a larger design.`,
    )
  }
  retractFrom(moves, retractZ, clearanceZ)
  onProgress?.(1)
  return moves
}

/** Boundary sample spacing: fine enough for the tolerance, capped so a very
 *  long perimeter stays inside a sane sample budget. */
function sampleSpacing(region: Region, tol: number): number {
  const perimeter = regionPerimeter(region)
  const byTol = Math.max(0.05, Math.min(0.5, tol * 8))
  const byBudget = perimeter / 60_000
  return Math.max(byTol, byBudget)
}

function emitRidge(moves: ToolpathMove[], run: Ridge3[], topZ: number, feedRate: number, link: Link): void {
  const start = run[0]
  link(start, topZ - start.d)
  for (let i = 1; i < run.length; i++) {
    const p = run[i]
    moves.push({ type: 'feed', x: p.x, y: p.y, z: topZ - p.d, feed: feedRate, role: 'cut' })
  }
}

/** Concentric inside-out ring fill of floor polygons at one depth, plus one
 *  pass down the medial axis of the innermost core so the strip the last ring
 *  leaves (up to a stepover wide) is cut too. The outermost ring is the floor
 *  boundary itself (the wall pass repeats it as a finish). Every point of the
 *  floor ends up within half a stepover of a cut. */
function emitFloorRings(
  moves: ToolpathMove[], floor: Loops, stepover: number, tol: number, z: number, feedRate: number, link: Link,
): boolean {
  // Rings from the boundary inward until the offset vanishes.
  const rings: Region[][] = []
  let current = treeToRegions(offsetTree(floor, 0, tol))
  let guard = 0
  while (current.length && guard++ < 10_000) {
    rings.push(current)
    current = current.flatMap(r => insetRegion(r, stepover, tol))
  }
  if (!rings.length) return false

  // A stay-down link between two loops is only allowed when the straight
  // line between them lies inside the floor itself: crossing a standing
  // island (a letter in a carved field) at depth would gouge it. The rings,
  // the core and every stay-down link are exactly the ones the carve has
  // always had (a stay-down link also cuts, so changing which loops are
  // joined at depth would change the carved floor); only the links that
  // leave the floor ride over the carved groove (linkTo) instead of rising
  // to Clearance.
  const floorRegions = rings[0]
  const linkStaysOnFloor = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    segmentInside(floorRegions, a, b, Math.min(stepover, 0.5))
  // The cuts in the carve's own order: the core pass (the medial axis of the
  // innermost ring's interior), then the rings inside out, each ring cutting
  // on its outer side only. Each cut belongs to the ring region it came from.
  const pieces: { pts: Pt[]; node: Region }[] = []
  for (const core of rings[rings.length - 1]) {
    const spacing = Math.max(Math.max(0.05, Math.min(stepover / 4, 0.5)), regionPerimeter(core) / 60_000)
    for (const path of medialAxis(core, { spacing })) {
      const pts = path.closed && path.points.length > 1 ? [...path.points, path.points[0]] : path.points
      if (pts.length) pieces.push({ pts, node: core })
    }
  }
  for (let k = rings.length - 1; k >= 0; k--) {
    for (const region of rings[k]) {
      for (const loop of regionLoops(region)) {
        if (loop.length >= 3) pieces.push({ pts: [...loop, loop[0]], node: region })
      }
    }
  }
  if (!pieces.length) return false

  // A run is the cuts joined by stay-down links: each link goes on to the
  // next cut in that order at depth, so it also cuts, and the runs are kept
  // exactly as they are. Only where the carve lifts between runs does the
  // order change: a ring region's runs follow everything inside it, and the
  // regions inside it are finished one at a time, nearest first, so where a
  // floor narrows into two lobes the tool does not shuttle between the lobes
  // ring by ring.
  const runs = new Map<Region, Pt[][][]>()
  let prev: Pt[] | undefined
  let lastRun: Pt[][] = []
  for (const piece of pieces) {
    const own = runs.get(piece.node) ?? []
    runs.set(piece.node, own)
    const run = prev && linkStaysOnFloor(prev[prev.length - 1], piece.pts[0]) ? lastRun : undefined
    if (run) run.push(piece.pts)
    else own.push(lastRun = [piece.pts])
    prev = piece.pts
  }
  const children = new Map<Region, Region[]>()
  for (let k = 1; k < rings.length; k++) {
    for (const r of rings[k]) {
      const parent = rings[k - 1].find(f => regionContains(f, r.outer[0])) ?? rings[k - 1][nearestRegion(rings[k - 1], r.outer[0])]
      children.set(parent, [...(children.get(parent) ?? []), r])
    }
  }
  const emit = (node: Region) => {
    const inner = [...(children.get(node) ?? [])]
    while (inner.length) emit(inner.splice(nearestRegion(inner, moves[moves.length - 1]), 1)[0])
    // The region's own runs (its core's branches, its outline and its
    // holes) nearest first too.
    const own = [...(runs.get(node) ?? [])]
    while (own.length) {
      const at = moves[moves.length - 1]
      let bi = 0, bd = Infinity
      own.forEach((run, i) => {
        const d = at ? Math.hypot(run[0][0].x - at.x, run[0][0].y - at.y) : 0
        if (d < bd) { bd = d; bi = i }
      })
      const run = own.splice(bi, 1)[0]
      run.forEach((pts, i) => {
        if (i === 0) link(pts[0], z)
        else moves.push({ type: 'feed', x: pts[0].x, y: pts[0].y, z, feed: feedRate, role: 'stepover' })
        for (let j = 1; j < pts.length; j++) moves.push({ type: 'feed', x: pts[j].x, y: pts[j].y, z, feed: feedRate, role: 'cut' })
      })
    }
  }
  const roots = [...floorRegions]
  while (roots.length) emit(roots.splice(nearestRegion(roots, moves[moves.length - 1]), 1)[0])
  return true
}

// ---------------------------------------------------------------------------
// Role 'flat_clearing': the end mill's own operation
// ---------------------------------------------------------------------------

function buildFlatClearing(
  payload: VCarveWorkerPayload,
  regions: Region[],
  z: { clearanceZ: number; retractZ: number; feedZ: number; topZ: number; bottomZ: number },
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, tool } = payload
  const vbit = params.vbit
  if (!vbit) throw new Error('V-carve flat clearing: the V-bit that will follow is not recorded on this operation. Re-create it from the V-carve dialog.')
  const geom = vbitGeometry({ ...vbit, diameter: Infinity, fluteLength: Infinity, name: 'V-bit' })
  const maxDepth = Math.max(0, z.topZ - z.bottomZ)
  if (!(maxDepth > 0)) throw new Error('V-carve flat clearing: Material Start is not above Cutter End; nothing to clear.')
  const rFlat = geom.tipRadius + maxDepth * geom.tanHalf
  const tol = params.tolerance > 0 ? params.tolerance : 0.01

  const floorLoops: LoopData[] = []
  let n = 0
  for (const region of regions) {
    for (const flat of insetRegion(region, rFlat, tol)) {
      for (const loop of regionLoops(flat)) {
        floorLoops.push({ id: `vcarve-floor-${n++}`, points: loop.map(p => ({ x: p.x, y: p.y })), closed: true, type: 'closed' })
      }
    }
  }
  if (floorLoops.length === 0) {
    throw new Error(
      `V-carve flat clearing: nothing is wider than the V-bit reaches at ${maxDepth.toFixed(2)} mm, so there is no flat floor for tool "${tool.name}" to clear. Delete this operation or deepen the flat depth.`,
    )
  }
  const pocketParams: PocketParams = {
    geometryId: params.geometryId,
    loopIds: [],
    direction: 'climb',
    orderStrategy: 'by_region',
    fillStrategy: 'outside_in',
    floorStockToLeave: 0,
    finishContour: false,
    helixDiameter: 0,
    overlapMm: 0,
    stepoverLeadIn: 'none',
    stayDown: true,
    stayDownLift: 0.5,
  }
  const pocketPayload: PocketWorkerPayload = {
    ...payload,
    params: pocketParams,
    loops: floorLoops,
  }
  onProgress?.(0.1, 'V-carve flat clearing')
  return buildPocketToolpath(pocketPayload, onProgress)
}

/** Exposed for tests and the store: is every point of these moves inside
 *  one of the regions (XY), within `eps`? */
export function cutsStayInside(moves: ToolpathMove[], regions: Region[], eps: number): boolean {
  const grown = regions.map(r => ({ outer: r.outer, holes: r.holes }))
  for (const m of moves) {
    if (m.type !== 'feed' || (m.role !== 'cut' && m.role !== 'plunge')) continue
    let ok = false
    for (const r of grown) if (regionContains(r, m)) { ok = true; break }
    if (!ok) {
      // Allow boundary contact within eps.
      let near = false
      for (const r of regions) for (const loop of regionLoops(r)) {
        for (let i = 0; i < loop.length && !near; i++) {
          const a = loop[i], b = loop[(i + 1) % loop.length]
          const dx = b.x - a.x, dy = b.y - a.y
          const l2 = dx * dx + dy * dy
          let t = l2 > 0 ? ((m.x - a.x) * dx + (m.y - a.y) * dy) / l2 : 0
          t = t < 0 ? 0 : t > 1 ? 1 : t
          if (Math.hypot(a.x + t * dx - m.x, a.y + t * dy - m.y) <= eps) near = true
        }
      }
      if (!near) return false
    }
  }
  return true
}
