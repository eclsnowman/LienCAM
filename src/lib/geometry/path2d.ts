import type { Vec2, Loop2D } from '../../types'
import { assignStableLoopIds } from './loopId'

// Grid resolution for endpoint snapping.
// SNAP=20 means 0.05 mm per cell — matches JOIN_TOL so adjacent cells
// cover the full tolerance range without needing > ±1 neighbour search.
const SNAP     = 20
const JOIN_TOL = 0.05     // mm
const JOIN_TOL2 = JOIN_TOL * JOIN_TOL

// Below this, two endpoints are exact/floating-noise coincident - not a gap
// the join actually closed.
const GAP_EPS = 1e-6      // mm

// WO-1840: what joinSegments did, for the import console event. Callers that
// pass a report accumulate into it across every layer they join (dxfImporter
// sums it across the by-layer joinSegments calls, one report per import).
export interface JoinReport {
  gapsClosed: number
  largestGapMM: number
  openChains: number
  // WO-1890: doubled/overlapping segments merged before chaining, and distinct
  // points where the chainer had more than one way to go. Optional so report
  // literals written before these existed still type-check; absent means 0.
  overlapsMerged?: number
  branchPoints?: number
  // WO-3276: line ends that met the middle of another line and were joined to
  // it, and the closed faces traced from chains that stayed open after that.
  tJunctionsSplit?: number
  facesClosed?: number
}

function gk(p: Vec2): string {
  return `${Math.round(p.x * SNAP)},${Math.round(p.y * SNAP)}`
}

// Generate the 9 keys for a 3×3 neighbourhood around p
function neighbours(p: Vec2): string[] {
  const ix = Math.round(p.x * SNAP)
  const iy = Math.round(p.y * SNAP)
  const keys: string[] = []
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      keys.push(`${ix + dx},${iy + dy}`)
  return keys
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y
  return dx * dx + dy * dy
}

// Joining `a` to `b` only counts as closing a gap when they were not already
// (near-)coincident - an exact endpoint match is not a defect being papered over.
function recordGap(report: JoinReport | undefined, a: Vec2, b: Vec2): void {
  if (!report) return
  const d = Math.sqrt(dist2(a, b))
  if (d <= GAP_EPS) return
  report.gapsClosed++
  if (d > report.largestGapMM) report.largestGapMM = d
}

function dedup(pts: Vec2[], tol = 0.001): Vec2[] {
  if (pts.length < 2) return pts
  const out = [pts[0]]
  const t2  = tol * tol
  for (let i = 1; i < pts.length; i++) {
    if (dist2(pts[i], out[out.length - 1]) > t2) out.push(pts[i])
  }
  return out
}

// ── Overlap merge (WO-1890) ──────────────────────────────────────────────────
//
// A traced-over or doubled line used to survive chaining: dedup only removes
// repeated POINTS, so the copy either chained on as a second pass over the same
// edge (cut twice) or was left dangling and broke the contour open. Before
// chaining, these are merged:
//   - a segment that repeats another point-for-point (either direction) is
//     dropped - a copied LINE, polyline or circle;
//   - straight 2-point segments (LINEs) that lie on one line and overlap by more
//     than JOIN_TOL become one segment spanning both;
//   - the part of a LINE that runs along a straight edge of a polyline/arc/
//     spline is removed; whatever is left of the LINE stays.
// Multi-point segments are never cut: two closed polylines sharing an edge are
// two authored outlines and stay two. Segments that only touch end-to-end are
// not overlaps. With nothing to merge the input array is returned unchanged,
// so a clean file chains exactly as before.

interface Box { minX: number; minY: number; maxX: number; maxY: number }

function boxOf(a: Vec2, b: Vec2): Box {
  return {
    minX: Math.min(a.x, b.x) - JOIN_TOL, minY: Math.min(a.y, b.y) - JOIN_TOL,
    maxX: Math.max(a.x, b.x) + JOIN_TOL, maxY: Math.max(a.y, b.y) + JOIN_TOL,
  }
}

// Every pair (i, j) whose boxes overlap and for which `wanted(i, j)` holds.
// Sweep on x so a sheet of parts does not cost n^2.
function boxPairs(boxes: Box[], wanted: (i: number, j: number) => boolean): Array<[number, number]> {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].minX - boxes[b].minX || a - b)
  const pairs: Array<[number, number]> = []
  let active: number[] = []
  for (const i of order) {
    const bi = boxes[i]
    active = active.filter(j => boxes[j].maxX >= bi.minX)
    for (const j of active) {
      const bj = boxes[j]
      if (bj.minY > bi.maxY || bj.maxY < bi.minY) continue
      if (wanted(i, j)) pairs.push(i < j ? [i, j] : [j, i])
    }
    active.push(i)
  }
  return pairs
}

// Two segments are on one line when they are parallel to within this (sine of
// the angle between them, ~0.6 deg) AND the shorter one's endpoints lie within
// JOIN_TOL of the longer one's line. The angle matters for short segments: the
// chords of a circle traced round several times (a projected helix toolpath)
// sit within JOIN_TOL of each other's lines without being the same line.
const PARALLEL_TOL = 0.01

function offLine(p: Vec2, a0: Vec2, a1: Vec2): number {
  const l = Math.sqrt(dist2(a0, a1))
  return Math.abs((p.x - a0.x) * (a1.y - a0.y) - (p.y - a0.y) * (a1.x - a0.x)) / l
}

function onOneLine(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  const la = Math.sqrt(dist2(a0, a1)), lb = Math.sqrt(dist2(b0, b1))
  if (la <= JOIN_TOL || lb <= JOIN_TOL) return false
  const cross = (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x)
  if (Math.abs(cross) > PARALLEL_TOL * la * lb) return false
  return la >= lb
    ? offLine(b0, a0, a1) <= JOIN_TOL && offLine(b1, a0, a1) <= JOIN_TOL
    : offLine(a0, b0, b1) <= JOIN_TOL && offLine(a1, b0, b1) <= JOIN_TOL
}

// Where b0-b1 runs along a0-a1: the covered stretch of a0-a1 as parameters
// (mm from a0) with the b endpoints that bound it, or null when the two are
// not on one line or share no more than JOIN_TOL of length.
interface Cover { s: number; e: number; ps: Vec2; pe: Vec2 }
function collinearCover(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): Cover | null {
  if (!onOneLine(a0, a1, b0, b1)) return null
  const la = Math.sqrt(dist2(a0, a1))
  const ux = (a1.x - a0.x) / la, uy = (a1.y - a0.y) / la
  let t0 = (b0.x - a0.x) * ux + (b0.y - a0.y) * uy
  let t1 = (b1.x - a0.x) * ux + (b1.y - a0.y) * uy
  let p0 = b0, p1 = b1
  if (t1 < t0) { [t0, t1] = [t1, t0]; [p0, p1] = [p1, p0] }
  const s = Math.max(0, t0), e = Math.min(la, t1)
  if (e - s <= JOIN_TOL) return null
  return { s, e, ps: t0 > 0 ? p0 : a0, pe: t1 < la ? p1 : a1 }
}

function pointKey(pts: Vec2[]): string {
  return pts.map(gk).join(';')
}

export function mergeOverlaps(segs: Vec2[][]): { segs: Vec2[][]; merged: number } {
  let merged = 0
  // replacement[i]: undefined keeps segs[i]; otherwise what stands in its place.
  const replacement: Array<Vec2[][] | undefined> = new Array(segs.length)

  // 1. Point-for-point repeats of multi-point segments (2-point ones are
  //    covered by the line pass below).
  const seen = new Set<string>()
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].length < 3) continue
    const fwd = pointKey(segs[i])
    if (seen.has(fwd) || seen.has(pointKey([...segs[i]].reverse()))) {
      replacement[i] = []; merged++; continue
    }
    seen.add(fwd)
  }

  const lineIdx: number[] = []
  for (let i = 0; i < segs.length; i++) if (segs[i].length === 2) lineIdx.push(i)
  if (lineIdx.length === 0) return merged === 0 ? { segs, merged } : { segs: applyReplacement(segs, replacement), merged }

  // 2. Collinear LINEs that overlap -> one LINE spanning the group. A group is
  //    only ever joined while EVERY member stays on the line of its longest
  //    member: pairwise tests alone chain round a traced-over circle and would
  //    turn it into a diameter.
  const line = (k: number) => segs[lineIdx[k]]
  const len2 = (k: number) => dist2(line(k)[0], line(k)[1])
  const groupOf = lineIdx.map((_, k) => k)
  const members = lineIdx.map((_, k) => [k])
  const refOf = lineIdx.map((_, k) => k)
  const lineBoxes = lineIdx.map(i => boxOf(segs[i][0], segs[i][1]))
  for (const [p, q] of boxPairs(lineBoxes, () => true)) {
    const gp = groupOf[p], gq = groupOf[q]
    if (gp === gq) continue
    const a = line(p), b = line(q)
    if (!collinearCover(a[0], a[1], b[0], b[1])) continue
    const ref = len2(refOf[gp]) >= len2(refOf[gq]) ? refOf[gp] : refOf[gq]
    const r = line(ref)
    const fits = (k: number) => k === ref || onOneLine(r[0], r[1], line(k)[0], line(k)[1])
    if (!members[gp].every(fits) || !members[gq].every(fits)) continue
    const keep = Math.min(gp, gq), drop = Math.max(gp, gq)
    for (const k of members[drop]) { groupOf[k] = keep; members[keep].push(k) }
    members[drop] = []
    refOf[keep] = ref
  }
  // The lines after step 2, each owned by the segs index it stands in for.
  const lines: Array<{ at: number; pts: Vec2[] }> = []
  for (let g = 0; g < lineIdx.length; g++) {
    const group = members[g].sort((x, y) => x - y)
    if (group.length === 0) continue
    const first = line(group[0])
    if (group.length === 1) { lines.push({ at: lineIdx[group[0]], pts: first }); continue }
    // Span along the longest member (best direction), oriented like the first.
    const ref = line(refOf[g])
    let ux = ref[1].x - ref[0].x, uy = ref[1].y - ref[0].y
    if (ux * (first[1].x - first[0].x) + uy * (first[1].y - first[0].y) < 0) { ux = -ux; uy = -uy }
    let lo = first[0], hi = first[1], tLo = Infinity, tHi = -Infinity
    for (const k of group) {
      for (const p of line(k)) {
        const t = (p.x - first[0].x) * ux + (p.y - first[0].y) * uy
        if (t < tLo) { tLo = t; lo = p }
        if (t > tHi) { tHi = t; hi = p }
      }
    }
    const span = [lo, hi]
    lines.push({ at: lineIdx[group[0]], pts: span })
    replacement[lineIdx[group[0]]] = [span]
    for (let m = 1; m < group.length; m++) replacement[lineIdx[group[m]]] = []
    merged += group.length - 1
  }

  // 3. LINEs running along a straight edge of a multi-point segment: keep only
  //    the part of the LINE nothing else already draws.
  const edges: Array<[Vec2, Vec2]> = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.length < 3 || replacement[i]) continue
    for (let k = 0; k + 1 < s.length; k++) {
      if (dist2(s[k], s[k + 1]) > JOIN_TOL2) edges.push([s[k], s[k + 1]])
    }
  }
  if (edges.length > 0) {
    const boxes = [
      ...lines.map(l => boxOf(l.pts[0], l.pts[1])),
      ...edges.map(([a, b]) => boxOf(a, b)),
    ]
    const nl = lines.length
    const covers = new Map<number, Cover[]>()
    for (const [p, q] of boxPairs(boxes, (i, j) => (i < nl) !== (j < nl))) {
      const line = lines[p].pts, [b0, b1] = edges[q - nl]
      const c = collinearCover(line[0], line[1], b0, b1)
      if (!c) continue
      const arr = covers.get(p); if (arr) arr.push(c); else covers.set(p, [c])
    }
    for (const [p, cs] of covers) {
      const [a0, a1] = lines[p].pts
      const len = Math.sqrt(dist2(a0, a1))
      cs.sort((x, y) => x.s - y.s)
      const pieces: Vec2[][] = []
      let cursor = 0, from = a0
      for (const c of cs) {
        if (c.s - cursor > JOIN_TOL) pieces.push([from, c.ps])
        if (c.e > cursor) { cursor = c.e; from = c.pe }
      }
      if (len - cursor > JOIN_TOL) pieces.push([from, a1])
      replacement[lines[p].at] = pieces
      merged++
    }
  }

  return merged === 0 ? { segs, merged } : { segs: applyReplacement(segs, replacement), merged }
}

function applyReplacement(segs: Vec2[][], replacement: Array<Vec2[][] | undefined>): Vec2[][] {
  const out: Vec2[][] = []
  for (let i = 0; i < segs.length; i++) {
    const r = replacement[i]
    if (r === undefined) out.push(segs[i]); else out.push(...r)
  }
  return out
}

// Shoelace signed area. Positive means CCW; negative means CW.
export function signedArea(pts: Vec2[]): number {
  let a = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

// Imported files are not consistent about winding: a lone outer boundary may
// be CW or CCW, and exporters commonly give every subpath the same direction.
// Meaning therefore comes from containment depth, not authoring direction.
// The first vertex of an enclosed child is inside every proper ancestor; the
// strict area check prevents coincident/equal loops from containing each other.
function pointInClosedLoop(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function classifyClosedLoopsByContainment(loops: Loop2D[]): Loop2D[] {
  const closed = loops.filter(loop => loop.closed && loop.points.length >= 3)
  return loops.map(loop => {
    if (!loop.closed || loop.points.length < 3) return loop
    const depth = closed.reduce((count, candidate) => {
      if (candidate === loop || candidate.area <= loop.area) return count
      return count + (pointInClosedLoop(loop.points[0], candidate.points) ? 1 : 0)
    }, 0)
    return { ...loop, type: depth % 2 === 0 ? 'contour' : 'hole' }
  })
}

/**
 * WO-3276: split segments at T-junctions. A drawing whose line ends against the
 * middle of another line (an isometric or hidden-line drawing exported as one
 * <path> per line) has no shared endpoint there, so joinSegments, which joins
 * only end to end, leaves every such chain open. Where an endpoint of one
 * segment lies within JOIN_TOL of the interior of another segment's edge, that
 * edge gets a vertex at the foot of the endpoint, so the two now share an end.
 * The new vertex is the meeting endpoint itself (at most JOIN_TOL off the edge),
 * and an endpoint is only matched against an edge it is not already within
 * JOIN_TOL of an end of (that gap is joinSegments's own tolerance). Each split
 * cuts the polyline in two at that vertex. Returns the segments and the number
 * of cuts.
 */
export function splitAtTJunctions(segs: Vec2[][]): { segs: Vec2[][]; splits: number } {
  const ends: Vec2[] = []
  for (const s of segs) {
    if (s.length < 2) continue
    ends.push(s[0], s[s.length - 1])
  }
  ends.sort((a, b) => a.x - b.x)
  const xs = ends.map(e => e.x)
  const lowerBound = (x: number) => {
    let lo = 0, hi = xs.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m }
    return lo
  }

  let splits = 0
  const out: Vec2[][] = []
  for (const s of segs) {
    if (s.length < 2) { out.push(s); continue }
    let res: Vec2[] = [s[0]]
    for (let k = 1; k < s.length; k++) {
      const a = s[k - 1], b = s[k]
      const vx = b.x - a.x, vy = b.y - a.y
      const len2 = vx * vx + vy * vy
      if (len2 > 0) {
        const minY = Math.min(a.y, b.y) - JOIN_TOL, maxY = Math.max(a.y, b.y) + JOIN_TOL
        const hits: { u: number; pt: Vec2 }[] = []
        for (let e = lowerBound(Math.min(a.x, b.x) - JOIN_TOL); e < ends.length; e++) {
          const q = ends[e]
          if (q.x > Math.max(a.x, b.x) + JOIN_TOL) break
          if (q.y < minY || q.y > maxY) continue
          const u = ((q.x - a.x) * vx + (q.y - a.y) * vy) / len2
          if (u <= 0 || u >= 1) continue
          const fx = a.x + u * vx, fy = a.y + u * vy
          if (dist2(q, { x: fx, y: fy }) >= JOIN_TOL2) continue
          if (dist2(q, a) < JOIN_TOL2 || dist2(q, b) < JOIN_TOL2) continue
          hits.push({ u, pt: q })
        }
        hits.sort((h1, h2) => h1.u - h2.u)
        for (const h of hits) {
          const last = res[res.length - 1]
          if (dist2(h.pt, last) < JOIN_TOL2) continue
          const foot = { x: h.pt.x, y: h.pt.y }
          res.push(foot)
          out.push(res)
          res = [foot]
          splits++
        }
      }
      res.push(b)
    }
    out.push(res)
  }
  return { segs: out, splits }
}

// Join raw segment arrays into connected loops.
// Uses a 3×3 grid neighbourhood so arc endpoints (computed via trig) reliably
// connect to LINE endpoints even with small floating-point differences.
export function joinSegments(rawSegs: Vec2[][], layerId: string, report?: JoinReport): Loop2D[] {
  const cleaned = rawSegs.map(s => dedup(s)).filter(s => s.length >= 2)
  const { segs, merged } = mergeOverlaps(cleaned)
  if (report) report.overlapsMerged = (report.overlapsMerged ?? 0) + merged
  if (segs.length === 0) return []

  // Multi-value maps: grid-key → [segment-indices starting / ending here]
  const startMap = new Map<string, number[]>()
  const endMap   = new Map<string, number[]>()

  const addToMap = (map: Map<string, number[]>, key: string, idx: number) => {
    const a = map.get(key); if (a) a.push(idx); else map.set(key, [idx])
  }

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    addToMap(startMap, gk(s[0]), i)
    addToMap(endMap,   gk(s[s.length - 1]), i)
  }

  const used = new Uint8Array(segs.length)

  // Every unused segment with an end within JOIN_TOL of `pt`. `atStart` says
  // which end touches. Tail/head preference order is kept (tail: starts before
  // ends; head: ends before starts) so a single candidate is found exactly as
  // before WO-1890.
  interface Candidate { idx: number; atStart: boolean }
  const candidatesAt = (pt: Vec2, startsFirst: boolean): Candidate[] => {
    const out: Candidate[] = []
    for (const atStart of startsFirst ? [true, false] : [false, true]) {
      const map = atStart ? startMap : endMap
      for (const key of neighbours(pt)) {
        const arr = map.get(key)
        if (!arr) continue
        for (let k = arr.length - 1; k >= 0; k--) {
          const idx = arr[k]
          const s = segs[idx]
          if (!used[idx] && dist2(pt, atStart ? s[0] : s[s.length - 1]) < JOIN_TOL2) out.push({ idx, atStart })
        }
      }
    }
    return out
  }

  // WO-1890 branch rule. Where more than one segment continues from `pt`, the
  // chain goes STRAIGHTEST (smallest turn from its direction of travel `dir`),
  // then across the SHORTEST gap, then onto the SHORTEST segment; a full tie
  // keeps the first found. (Before: whichever match happened to be found first
  // - effectively the last one filed.) Each such point is counted once.
  const branchKeys = new Set<string>()
  const segLen = (s: Vec2[]) => { let l = 0; for (let k = 1; k < s.length; k++) l += Math.sqrt(dist2(s[k - 1], s[k])); return l }
  const pick = (pt: Vec2, dir: Vec2, cands: Candidate[]): Candidate | null => {
    if (cands.length <= 1) return cands[0] ?? null
    branchKeys.add(gk(pt))
    const dl = Math.hypot(dir.x, dir.y) || 1
    const score = (c: Candidate) => {
      const s = segs[c.idx], n = s.length
      const from = c.atStart ? s[0] : s[n - 1], to = c.atStart ? s[1] : s[n - 2]
      const ox = to.x - from.x, oy = to.y - from.y
      const ol = Math.hypot(ox, oy) || 1
      return { cos: (dir.x * ox + dir.y * oy) / (dl * ol), gap: dist2(pt, from), len: segLen(s) }
    }
    let best = cands[0], bs = score(best)
    for (let k = 1; k < cands.length; k++) {
      const cs = score(cands[k])
      const better = cs.cos > bs.cos + 1e-9
        || (Math.abs(cs.cos - bs.cos) <= 1e-9 && (cs.gap < bs.gap - 1e-12
          || (Math.abs(cs.gap - bs.gap) <= 1e-12 && cs.len < bs.len - 1e-9)))
      if (better) { best = cands[k]; bs = cs }
    }
    return best
  }

  const loops: Loop2D[] = []

  for (let seed = 0; seed < segs.length; seed++) {
    if (used[seed]) continue
    used[seed] = 1
    let chain = [...segs[seed]]

    // Greedily extend chain at both ends
    let extended = true
    while (extended) {
      extended = false

      // WO-1890: a chain whose ends have met is a closed contour; closing it
      // outranks wandering off down a branch that touches the same point. On a
      // file with no branches nothing is left to take here anyway.
      if (chain.length >= 3 && dist2(chain[0], chain[chain.length - 1]) < JOIN_TOL2) break

      // ── Extend tail ──
      const tail = chain[chain.length - 1]
      const prev = chain[chain.length - 2]
      const t = pick(tail, { x: tail.x - prev.x, y: tail.y - prev.y }, candidatesAt(tail, true))
      if (t) {
        const s = segs[t.idx]
        used[t.idx] = 1
        if (t.atStart) {
          recordGap(report, tail, s[0])
          chain = [...chain, ...s.slice(1)]
        } else {
          recordGap(report, tail, s[s.length - 1])
          chain = [...chain, ...[...s].reverse().slice(1)]
        }
        extended = true; continue
      }

      // ── Extend head ──
      const head = chain[0]
      const next = chain[1]
      const h = pick(head, { x: head.x - next.x, y: head.y - next.y }, candidatesAt(head, false))
      if (h) {
        const s = segs[h.idx]
        used[h.idx] = 1
        if (!h.atStart) {
          recordGap(report, head, s[s.length - 1])
          chain = [...s.slice(0, -1), ...chain]
        } else {
          recordGap(report, head, s[0])
          chain = [...[...s].reverse().slice(0, -1), ...chain]
        }
        extended = true; continue
      }
    }

    chain = dedup(chain)
    if (chain.length < 2) continue

    const first = chain[0], last = chain[chain.length - 1]
    const closed = dist2(first, last) < JOIN_TOL2
    if (closed && chain.length > 2) {
      recordGap(report, first, last)
      chain.pop()
    }
    if (!closed && report) report.openChains++

    const area = closed ? signedArea(chain) : 0
    const type: Loop2D['type'] = closed ? 'contour' : 'open'

    loops.push({
      // Stable content-derived id stamped below (assignStableLoopIds); this
      // placeholder is recomputed and ignored. Was crypto.randomUUID() — the
      // fresh-uuid-per-derive source of the B19c loop-orphan bug.
      id: '',
      points: chain,
      closed,
      type,
      layerId,
      area: Math.abs(area),
    })
  }

  if (report) report.branchPoints = (report.branchPoints ?? 0) + branchKeys.size

  // Stamp deterministic ids from loop content so an identical re-import/re-derive
  // yields identical ids (docs/planning/STABLE-LOOP-ID-PLAN.md). The store namespaces
  // these by geoId at the attach boundary.
  return assignStableLoopIds(classifyClosedLoopsByContainment(loops))
}

/**
 * WO-3276: the closed faces of a drawing whose chains joinSegments left open
 * because lines branch (three or more lines meeting at a corner, as in an
 * isometric letter drawing). Chaining end to end follows one way through a
 * branch and so never comes back round; the faces of the drawn lines are what
 * a person sees as closed shapes. Edges that bound no face (a line sticking
 * out, or a bridge) are returned as `rest` and stay open. Nothing is invented:
 * every face edge is an input edge, and a face boundary is only taken where the
 * drawn lines enclose it, within JOIN_TOL.
 */
export function traceClosedFaces(chains: Vec2[][]): { faces: Vec2[][]; rest: Vec2[][] } {
  const nodes: Vec2[] = []
  const cells = new Map<string, number[]>()
  const nodeAt = (p: Vec2): number => {
    for (const key of neighbours(p)) {
      for (const id of cells.get(key) ?? []) if (dist2(nodes[id], p) < JOIN_TOL2) return id
    }
    const id = nodes.length
    nodes.push(p)
    const k = gk(p)
    const arr = cells.get(k); if (arr) arr.push(id); else cells.set(k, [id])
    return id
  }
  const edgeKeys = new Set<string>()
  const edges: Array<[number, number]> = []
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = nodeAt(c[i - 1]), b = nodeAt(c[i])
      if (a === b) continue
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push([a, b])
    }
  }

  const adj = new Map<number, Set<number>>()
  const link = (a: number, b: number) => {
    let s = adj.get(a); if (!s) adj.set(a, s = new Set())
    s.add(b)
  }
  for (const [a, b] of edges) { link(a, b); link(b, a) }

  // A line that dead-ends bounds no face: peel such ends off until none is left.
  const rest: Vec2[][] = []
  const queue = [...adj.keys()].filter(n => adj.get(n)!.size === 1)
  while (queue.length > 0) {
    const n = queue.pop()!
    const nb = adj.get(n)
    if (!nb || nb.size !== 1) continue
    const m = [...nb][0]
    rest.push([nodes[n], nodes[m]])
    adj.delete(n)
    const mb = adj.get(m)!
    mb.delete(n)
    if (mb.size === 1) queue.push(m)
    else if (mb.size === 0) adj.delete(m)
  }

  // Neighbours of each node in counter-clockwise order.
  const ring = new Map<number, number[]>()
  for (const [n, nb] of adj) {
    ring.set(n, [...nb].sort((a, b) =>
      Math.atan2(nodes[a].y - nodes[n].y, nodes[a].x - nodes[n].x)
      - Math.atan2(nodes[b].y - nodes[n].y, nodes[b].x - nodes[n].x)))
  }

  // Walk each directed edge, turning to the neighbour just clockwise of the way
  // back: inner faces come out counter-clockwise (positive area), the outside
  // of each component clockwise.
  const walked = new Set<string>()
  const faces: Vec2[][] = []
  const inFace = new Set<string>()
  for (const [u0, nb0] of ring) {
    for (const v0 of nb0) {
      if (walked.has(`${u0}>${v0}`)) continue
      const path: number[] = []
      let u = u0, v = v0
      while (!walked.has(`${u}>${v}`)) {
        walked.add(`${u}>${v}`)
        path.push(u)
        const r = ring.get(v)!
        const back = r.indexOf(u)
        const w = r[(back - 1 + r.length) % r.length]
        u = v; v = w
      }
      const pts = path.map(id => nodes[id])
      if (pts.length >= 3 && signedArea(pts) > JOIN_TOL2) {
        faces.push([...pts, pts[0]])
        for (let i = 0; i < path.length; i++) {
          const a = path[i], b = path[(i + 1) % path.length]
          inFace.add(a < b ? `${a}:${b}` : `${b}:${a}`)
        }
      }
    }
  }
  for (const [a, b] of edges) {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (adj.get(a)?.has(b) && !inFace.has(key)) rest.push([nodes[a], nodes[b]])
  }
  return { faces, rest }
}

// WO-3276: two segments belong to one connected group when a vertex of one
// lies within this of an edge of the other. Twice JOIN_TOL, so the group always
// holds everything joinSegments could join, merge or chain together: a loop
// that joinSegments builds never spans two groups.
const GROUP_TOL2 = 4 * JOIN_TOL2

function distToEdge2(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x, vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 === 0) return dist2(p, a)
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
  return dist2(p, { x: a.x + u * vx, y: a.y + u * vy })
}

// The connected groups of `segs` (indices, each group ascending, groups in
// order of their first index). Edges are paired by padded box (a sweep, so
// dense nested curves stay cheap), then an end of one edge within the
// tolerance of the other edge joins their segments.
function connectedGroups(segs: Vec2[][]): number[][] {
  const parent = segs.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const owner: number[] = []
  const edges: Array<[Vec2, Vec2]> = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    for (let k = 1; k < s.length; k++) { owner.push(i); edges.push([s[k - 1], s[k]]) }
  }
  // boxOf pads each side by JOIN_TOL, so boxes meet whenever the edges come
  // within 2 * JOIN_TOL (GROUP_TOL) of each other.
  const boxes = edges.map(([a, b]) => boxOf(a, b))
  for (const [p, q] of boxPairs(boxes, (i, j) => owner[i] !== owner[j])) {
    const rp = find(owner[p]), rq = find(owner[q])
    if (rp === rq) continue
    const [a0, a1] = edges[p], [b0, b1] = edges[q]
    if (distToEdge2(a0, b0, b1) <= GROUP_TOL2 || distToEdge2(a1, b0, b1) <= GROUP_TOL2
      || distToEdge2(b0, a0, a1) <= GROUP_TOL2 || distToEdge2(b1, a0, a1) <= GROUP_TOL2) {
      parent[Math.max(rp, rq)] = Math.min(rp, rq)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < segs.length; i++) {
    const r = find(i)
    const g = byRoot.get(r); if (g) g.push(i); else byRoot.set(r, [i])
  }
  return [...byRoot.values()]
}

/**
 * WO-3276: joinSegments for a drawing made of separate lines. Line ends that
 * meet the middle of another line are joined to it, the segments are chained as
 * joinSegments always did, and the closed faces the lines enclose are traced.
 * That is decided per connected group of lines, never for the whole layer: a
 * group that joinSegments already closes completely keeps exactly the loops
 * joinSegments gives it (same points, direction and hole/contour role), however
 * many open lines lie elsewhere in the layer. Only a group holding a chain that
 * stays open is split and traced, and outlines that arrive closed are never
 * re-traced. A layer where every group closes, or where no face is found,
 * comes out exactly as joinSegments alone gives it. Hole or contour is decided
 * over the whole layer. Known limit: a shape joined to another only by a single
 * line (a bridge) is not traced as a separate face.
 */
export function joinSegmentsIntoFaces(rawSegs: Vec2[][], layerId: string, report?: JoinReport): Loop2D[] {
  // Chain the lines exactly as before; a layer where everything closes is done.
  const plain: JoinReport = { gapsClosed: 0, largestGapMM: 0, openChains: 0, overlapsMerged: 0, branchPoints: 0 }
  const first = joinSegments(rawSegs, layerId, plain)
  const mergePlain = (openChains: number) => {
    if (!report) return
    report.gapsClosed += plain.gapsClosed
    report.largestGapMM = Math.max(report.largestGapMM, plain.largestGapMM)
    report.openChains += openChains
    report.overlapsMerged = (report.overlapsMerged ?? 0) + (plain.overlapsMerged ?? 0)
    report.branchPoints = (report.branchPoints ?? 0) + (plain.branchPoints ?? 0)
  }
  if (plain.openChains === 0) { mergePlain(0); return first }

  // Something stayed open. Each connected group is decided on its own.
  const isClosedIn = (seg: Vec2[]) => seg.length >= 3 && dist2(seg[0], seg[seg.length - 1]) < JOIN_TOL2
  const segs = rawSegs.map(s => dedup(s)).filter(s => s.length >= 2)
  const keptKeys = new Map<string, number>()
  const keptOwn: Loop2D[] = []
  const traced: Loop2D[] = []
  let splits = 0, faceLoops = 0
  for (const group of connectedGroups(segs)) {
    const groupSegs = group.map(i => segs[i])
    const own: JoinReport = { gapsClosed: 0, largestGapMM: 0, openChains: 0 }
    const ownLoops = joinSegments(groupSegs, layerId, own)
    const keep = () => {
      for (const l of ownLoops) {
        const k = pointKey(l.points)
        keptKeys.set(k, (keptKeys.get(k) ?? 0) + 1)
        keptOwn.push(l)
      }
    }
    if (own.openChains === 0) { keep(); continue }

    // Outlines that arrive closed (one closed path) are authored shapes and
    // pass through untouched; only the separate lines are joined to the lines
    // they meet and traced for the faces they enclose.
    const closedIn = groupSegs.filter(isClosedIn)
    const split = splitAtTJunctions(groupSegs.filter(seg => !isClosedIn(seg)))
    const chained = joinSegments(split.segs, layerId)
    // A chain that closed by walking through a branch need not be a face (the
    // outline of two boxes sharing a wall), so every edge goes to the tracer.
    const { faces, rest } = traceClosedFaces(chained.map(l => (l.closed ? [...l.points, l.points[0]] : l.points)))
    if (faces.length === 0) { keep(); continue }
    const fromLines = joinSegments([...faces, ...rest], layerId)
    traced.push(...joinSegments(closedIn, layerId), ...fromLines)
    splits += split.splits
    faceLoops += fromLines.filter(l => l.closed).length
  }
  if (traced.length === 0) { mergePlain(plain.openChains); return first }

  // The loops of the groups that were kept, taken from `first` itself so they
  // are exactly what joinSegments gave (a group never shares a loop with
  // another, so they are the same loops), then the traced groups.
  const loops: Loop2D[] = []
  for (const l of first) {
    const k = pointKey(l.points), n = keptKeys.get(k) ?? 0
    if (n === 0) continue
    keptKeys.set(k, n - 1)
    loops.push(l)
  }
  if (loops.length !== keptOwn.length) { loops.length = 0; loops.push(...keptOwn) }
  loops.push(...traced)
  const out = assignStableLoopIds(classifyClosedLoopsByContainment(loops))
  mergePlain(out.filter(l => !l.closed).length)
  if (report) {
    report.tJunctionsSplit = (report.tJunctionsSplit ?? 0) + splits
    report.facesClosed = (report.facesClosed ?? 0) + faceLoops
  }
  return out
}

export function computeBBox2D(loops: Loop2D[]): {
  min: Vec2; max: Vec2; size: Vec2; center: Vec2
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const loop of loops) {
    for (const p of loop.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0 }
  return {
    min: { x: minX, y: minY },
    max: { x: maxX, y: maxY },
    size: { x: maxX - minX, y: maxY - minY },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  }
}

// Shift all loop points so the bounding-box center is at (0, 0)
export function centerLoops(loops: Loop2D[]): Loop2D[] {
  const { center } = computeBBox2D(loops)
  return loops.map(loop => ({
    ...loop,
    points: loop.points.map(p => ({ x: p.x - center.x, y: p.y - center.y })),
  }))
}
