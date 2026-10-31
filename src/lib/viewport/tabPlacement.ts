import { distToPolyBoundary, pointInPolygon, segSegIntersect } from '../cam/geometry'
import type { KeepOutLevel, Obstacle, ObstacleOmission } from '../../kernel/workholding/contracts'

// Pure math for the in-viewport contour holding-tab editor (Tabs v2).
//
// The viewport places tab markers on a contour op's FINISH-CONTOUR polyline
// (Operation.contourTabPreview - derived by the engine itself, so marker
// positions and cut tabs share one geometry). A tab location is a FRACTION in
// [0, 1) of that closed polyline's perimeter: arc distance of the tab CENTER
// along the cut direction from the seam (path[0]). This module holds every
// piece of that mapping that does not need THREE - pointer-projection to the
// nearest arc position, fraction -> point sampling, even-spacing seeds, and
// the minimum-separation check the editor uses to refuse overlapping tabs -
// so the math is unit-tested without a WebGL context. The viewport supplies
// plain {x, y} world points (the pointer ray is intersected with the marker
// Z plane before reaching here).

export interface Pt2 { x: number; y: number }

export interface ArcPosition {
  /** Fraction in [0, 1) of the closed perimeter. */
  fraction: number
  /** Arc distance from the seam (mm). */
  distance: number
  /** The nearest point ON the polyline (world XY). */
  point: Pt2
  /** Euclidean distance from the query point to `point` (mm). */
  euclidean: number
}

/** Cumulative arc lengths of a CLOSED polyline: cumulative.length ===
 *  path.length + 1, last entry (the wrap back to path[0]) is the perimeter. */
export function polylineCumulative(path: Pt2[]): { cumulative: number[]; perimeter: number } {
  const cumulative = [0]
  let perimeter = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(perimeter)
  }
  return { cumulative, perimeter }
}

/**
 * Project a world-XY point onto the closed polyline: the nearest point on any
 * segment (including the closing segment back to path[0]), as an arc position.
 * Returns null for degenerate input (fewer than 2 points or ~zero perimeter).
 */
export function closestArcPosition(path: Pt2[], pt: Pt2): ArcPosition | null {
  if (path.length < 2) return null
  const { cumulative, perimeter } = polylineCumulative(path)
  if (!Number.isFinite(perimeter) || perimeter <= 1e-9) return null

  let bestD2 = Infinity
  let bestDistance = 0
  let bestPoint: Pt2 = path[0]
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby
    const t = len2 <= 1e-18
      ? 0
      : Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2))
    const px = a.x + abx * t
    const py = a.y + aby * t
    const dx = pt.x - px
    const dy = pt.y - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) {
      bestD2 = d2
      bestPoint = { x: px, y: py }
      bestDistance = cumulative[i] + Math.sqrt(len2) * t
    }
  }
  const distance = bestDistance >= perimeter ? bestDistance - perimeter : bestDistance
  return {
    fraction: distance / perimeter,
    distance,
    point: bestPoint,
    euclidean: Math.sqrt(bestD2),
  }
}

/** Point at fraction f (wrapped into [0,1)) of the closed polyline. */
export function pointAtFraction(path: Pt2[], fraction: number): Pt2 {
  const { cumulative, perimeter } = polylineCumulative(path)
  const f = ((fraction % 1) + 1) % 1
  const s = f * perimeter
  for (let i = 0; i < path.length; i++) {
    const start = cumulative[i]
    const end = cumulative[i + 1]
    if (s <= end + 1e-9) {
      const length = end - start
      if (length <= 1e-9) return path[(i + 1) % path.length]
      const t = Math.max(0, Math.min(1, (s - start) / length))
      const a = path[i]
      const b = path[(i + 1) % path.length]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  return path[0]
}

/** Evenly-spaced tab-center fractions - the engine's default placement
 *  ((i + 0.5) / count), used to SEED custom locations so hand editing starts
 *  from exactly what the user already sees. */
export function evenTabFractions(count: number): number[] {
  const n = Math.max(1, Math.round(count))
  return Array.from({ length: n }, (_, i) => (i + 0.5) / n)
}

/**
 * Is `candidate` (a tab-center fraction) at least `minSepFraction` of CIRCULAR
 * arc separation away from every other tab? `excludeIndex` skips the tab being
 * dragged (null when testing a brand-new tab). Mirrors the engine's overlap
 * rule (center spacing >= one tab width), so the editor refuses placements the
 * engine would fail loud on.
 */
export function isTabFractionFree(
  fractions: number[],
  excludeIndex: number | null,
  candidate: number,
  minSepFraction: number,
): boolean {
  const c = ((candidate % 1) + 1) % 1
  for (let i = 0; i < fractions.length; i++) {
    if (i === excludeIndex) continue
    const f = ((fractions[i] % 1) + 1) % 1
    const raw = Math.abs(f - c)
    const sep = Math.min(raw, 1 - raw)
    if (sep < minSepFraction - 1e-12) return false
  }
  return true
}

export interface TabSourceRing {
  loopId: string
  path: Pt2[]
  /** A hole has no assumed depth: it conservatively excludes the whole XY ring. */
  kind: 'boundary' | 'hole' | 'stock'
}

export interface TabSuggestionInput {
  /** Directed, closed production finish path; fractions refer to this seam. */
  path: Pt2[]
  loopId: string
  count: number
  width: number
  cutterRadius: number
  sourceRings: TabSourceRing[]
  /** Already resolved world-mm workholding record. Undefined is NOT checked-empty. */
  fixtures?: { obstacles: readonly Obstacle[]; omissions: readonly ObstacleOmission[] }
  /** Existing workholding cutting/reach band, including flute reach and allowance. */
  cuttingBand?: KeepOutLevel
  /** Optional resolved holder envelope/band; never inferred from cutter geometry. */
  holder?: { radius: number; band: KeepOutLevel }
  /** Fixed entry/exit spans, directed mm from the production seam; end >= start,
   * including unwrapped seam-crossing intervals such as [197,205] on L=200. */
  exclusions?: Array<{ start: number; end: number }>
  tolerance?: number
  /** Known input approximation error, added to epsilon, never inferred. */
  inputError?: number
}

export interface TabCandidate {
  fraction: number
  point: Pt2
  /** Directed production-seam mm, not canonical enumeration distance. */
  distance: number
  intervals: Array<{ start: number; end: number }>
  tangentTurn: number
  cornerClearance: number
  /** Minimum clearance after cutter/allowance inflation, capped at 25 mm. */
  clearance: number
  reasons: string[]
  selected: boolean
}

export interface TabSuggestions {
  loopId: string
  fractions: number[]
  found: number
  requested: number
  message: string
  candidates: TabCandidate[]
  diagnostics: string[]
  omissions: string[]
  /** W - 2R is only a conservative central-web estimate, not retention proof. */
  centralWeb: number
}

type TabArc = ReturnType<typeof polylineCumulative> & { path: Pt2[] }
const tabMod = (s: number, length: number) => ((s % length) + length) % length
const tabCircularDistance = (a: number, b: number, length: number) => {
  const d = Math.abs(tabMod(a - b, length))
  return Math.min(d, length - d)
}
const tabPointDistance = (a: Pt2, b: Pt2) => Math.hypot(a.x - b.x, a.y - b.y)

/** Exact duplicates/collinear points only: dropping small curved chords can turn
 * a finely tessellated circle into artificial sharp corners. */
function cleanTabRing(path: Pt2[]): Pt2[] {
  let out = path.filter((p, i) => i === 0 || tabPointDistance(p, path[i - 1]) > 1e-9)
    .map(p => ({ ...p }))
  if (out.length > 1 && tabPointDistance(out[0], out[out.length - 1]) <= 1e-9) out.pop()
  let changed = true
  while (changed && out.length >= 3) {
    changed = false
    out = out.filter((b, i) => {
      const a = out[(i + out.length - 1) % out.length], c = out[(i + 1) % out.length]
      const ab = tabPointDistance(a, b), bc = tabPointDistance(b, c)
      const collinear = Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) <= 1e-10 * ab * bc
        && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0
      changed ||= collinear
      return !collinear
    })
  }
  return out
}

function tabArc(path: Pt2[]): TabArc { return { path, ...polylineCumulative(path) } }

function tabSample(arc: TabArc, s: number): Pt2 {
  s = tabMod(s, arc.perimeter)
  const i = arc.cumulative.findIndex((end, j) => j > 0 && end >= s) - 1
  const a = arc.path[i], b = arc.path[(i + 1) % arc.path.length]
  const t = (s - arc.cumulative[i]) / (arc.cumulative[i + 1] - arc.cumulative[i])
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Split a directed interval into nonwrapping pieces. */
function tabWrap(start: number, end: number, length: number): Array<{ start: number; end: number }> {
  if (end - start >= length) return [{ start: 0, end: length }]
  const a = tabMod(start, length), b = a + end - start
  return b <= length ? [{ start: a, end: b }] : [{ start: a, end: length }, { start: 0, end: b - length }]
}

/** Every polyline segment traversed by an interval, including its wrap. */
function tabSegments(arc: TabArc, start: number, end: number): Array<[Pt2, Pt2]> {
  return tabWrap(start, end, arc.perimeter).flatMap(span => arc.path.flatMap((a, i) => {
    const lo = Math.max(span.start, arc.cumulative[i]), hi = Math.min(span.end, arc.cumulative[i + 1])
    if (hi <= lo) return []
    const b = arc.path[(i + 1) % arc.path.length], len = arc.cumulative[i + 1] - arc.cumulative[i]
    const at = (s: number) => ({ x: a.x + (b.x - a.x) * (s - arc.cumulative[i]) / len,
      y: a.y + (b.y - a.y) * (s - arc.cumulative[i]) / len })
    return [[at(lo), at(hi)] as [Pt2, Pt2]]
  }))
}

function tabSegmentDistance(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number {
  if (segSegIntersect(a, b, c, d)) return 0
  // The existing boundary-distance predicate handles endpoints, collinear
  // overlap and zero-length segments that segSegIntersect deliberately omits.
  return Math.min(Math.abs(distToPolyBoundary(a, [c, d])), Math.abs(distToPolyBoundary(b, [c, d])),
    Math.abs(distToPolyBoundary(c, [a, b])), Math.abs(distToPolyBoundary(d, [a, b])))
}

/**
 * Suggest geometric tab centers without authoring tabs or changing a seam.
 * Proposals: epsilon=0.25 mm + inputError, grid<=min(W/4,1 mm), clearance
 * cap=25 mm, sharp turn>=45 degrees. Smooth turns are integrated over W;
 * tessellation vertex count is never a corner criterion. Score comparisons
 * use tolerance in mm (turn is quantized as W*angle). Packing is greedy and
 * may find fewer than N even when another packing exists. This does not prove
 * retention strength, hole depth, holder clearance, or a material-safe count.
 *
 * Caller supplies production direction/identity and existing workholding
 * adapters' world-space records/reach bands. Unknown evidence is reported;
 * ordinary 2D geometry does not require a feature recognizer. This has no
 * emitter: buildContourTabPlan / kernel planTabs remain the tab authorities.
 */
export function suggestTabFractions(input: TabSuggestionInput): TabSuggestions {
  const { path, width: w, cutterRadius: r, count } = input
  const tolerance = input.tolerance ?? 0.25, error = input.inputError ?? 0
  const epsilon = tolerance + error, margin = w / 2 + r + epsilon, cap = 25
  const result: TabSuggestions = { loopId: input.loopId, fractions: [], found: 0, requested: count,
    message: `found 0 of ${count} suggestions`, candidates: [], diagnostics: [], omissions: [], centralWeb: Math.max(0, w - 2 * r) }
  const finitePath = (p: Pt2[]) => p.every(v => Number.isFinite(v.x) && Number.isFinite(v.y))
  const validBand = (b: KeepOutLevel) => [b.bottomZ, b.topZ, b.allowanceMm].every(Number.isFinite)
    && b.bottomZ <= b.topZ && b.allowanceMm >= 0
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(w) || w <= 0 || !Number.isFinite(r) || r < 0
    || !Number.isFinite(tolerance) || tolerance <= 0 || !Number.isFinite(error) || error < 0
    || !finitePath(path) || (input.exclusions ?? []).some(e => !Number.isFinite(e.start) || !Number.isFinite(e.end) || e.end < e.start)) {
    result.diagnostics.push('invalid-input'); return result
  }
  const clean = cleanTabRing(path)
  if (clean.length < 3 || polylineCumulative(clean).perimeter <= epsilon) {
    result.diagnostics.push('zero-usable-loop'); return result
  }
  if (result.centralWeb === 0) result.diagnostics.push('zero-central-web: W <= 2R; placement does not prove retention')
  if (!input.fixtures) result.omissions.push('fixtures: evidence absent')
  else result.omissions.push(...input.fixtures.omissions.map(o => `${o.id}: ${o.reason}`))
  if (!input.holder) result.omissions.push('holder: geometry absent')
  else if (!Number.isFinite(input.holder.radius) || input.holder.radius < 0 || !validBand(input.holder.band)) {
    result.diagnostics.push('invalid-holder'); return result
  }
  if (!input.cuttingBand) result.omissions.push('fixture cutting/reach band: absent')
  else if (!validBand(input.cuttingBand)) { result.diagnostics.push('invalid-cutting-band'); return result }

  if (input.sourceRings.some(ring => !finitePath(ring.path))) {
    result.diagnostics.push('invalid-source-rings-or-loop-identity'); return result
  }
  const rings = input.sourceRings.map(ring => ({ ...ring, path: cleanTabRing(ring.path) }))
  if (rings.some(ring => !finitePath(ring.path) || ring.path.length < 3 || polylineCumulative(ring.path).perimeter <= epsilon)
    || rings.filter(ring => ring.loopId === input.loopId).length !== 1) {
    result.diagnostics.push('invalid-source-rings-or-loop-identity'); return result
  }
  const source = rings.find(ring => ring.loopId === input.loopId)!
  const sourceArc = tabArc(source.path)
  // Canonical world start and direction are enumeration only. Output is always
  // projected onto the untouched directed production path.
  const q = (n: number) => Math.round(n / tolerance)
  const comparePoint = (a: Pt2, b: Pt2) => q(a.x) - q(b.x) || q(a.y) - q(b.y) || a.x - b.x || a.y - b.y
  const first = clean.reduce((best, p, i) => comparePoint(p, clean[best]) < 0 ? i : best, 0)
  const direction = comparePoint(clean[(first + 1) % clean.length], clean[(first + clean.length - 1) % clean.length]) <= 0 ? 1 : -1
  const canonical = Array.from({ length: clean.length }, (_, i) => clean[tabMod(first + direction * i, clean.length)])
  const arc = tabArc(canonical), length = arc.perimeter
  if (w >= length) { result.diagnostics.push('width-covers-loop'); return result }
  const vertices = canonical.map((b, i) => {
    const a = canonical[(i + canonical.length - 1) % canonical.length], c = canonical[(i + 1) % canonical.length]
    const before = tabPointDistance(a, b), after = tabPointDistance(b, c)
    const angle = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)))
    return { s: arc.cumulative[i], angle, before, after }
  })
  const corners = vertices.filter(v => v.angle >= Math.PI / 4 - 1e-9)
  const originalArc = tabArc(path)
  // Cleanup may remove a collinear path[0]. Fixed entry/exit distances still
  // start at the production seam, just like the returned fractions/intervals
  // and buildContourTabPlan; the next retained corner is not that seam.
  const originalStart = closestArcPosition(canonical, path[0])!.distance
  const originalSign = direction // canonical was built from clean in this direction
  const exclusions = (input.exclusions ?? []).flatMap(span => {
    if (originalSign === 1) return tabWrap(originalStart + span.start, originalStart + span.end, length)
    return tabWrap(originalStart - span.end, originalStart - span.start, length)
  })
  if (length / Math.min(w / 4, 1) > 100_000) {
    result.diagnostics.push('candidate-resolution-limit: no grid was widened'); return result
  }
  const seeds = [0]
  for (let s = 0; s < length; s += Math.min(w / 4, 1)) seeds.push(s)
  // Endpoints and midpoints of all corner/entry feasible-interval boundaries.
  const boundaries = [0, length, ...corners.flatMap(v => [tabMod(v.s - margin, length), tabMod(v.s + margin, length)]),
    ...exclusions.flatMap(e => [tabMod(e.start - w / 2, length), tabMod(e.end + w / 2, length)])].sort((a, b) => a - b)
  boundaries.forEach((s, i) => { seeds.push(s); if (i) seeds.push((s + boundaries[i - 1]) / 2) })
  const unique = seeds.map(s => tabMod(s, length)).sort((a, b) => a - b)
    .reduce<number[]>((all, s) => {
      if (!all.length || s - all[all.length - 1] >= tolerance - 1e-9) all.push(s)
      return all
    }, [])
  if (unique.length > 1 && length - unique[unique.length - 1] < tolerance - 1e-9) unique.pop()
  const fixtures = (input.fixtures?.obstacles ?? []).filter(o => {
    const valid = [o.bottomZ, o.topZ, o.footprint.minX, o.footprint.minY, o.footprint.maxX, o.footprint.maxY].every(Number.isFinite)
      && o.bottomZ <= o.topZ && o.footprint.minX < o.footprint.maxX && o.footprint.minY < o.footprint.maxY
    if (!valid) result.omissions.push(`${o.id}: unreadable footprint/band`)
    return valid
  })
  const chosen: Array<{ s: number; candidate: TabCandidate }> = []
  const pool = unique.map(s => {
    const point = tabSample(arc, s), mapped = closestArcPosition(path, point)!
    const spans = tabSegments(arc, s - w / 2, s + w / 2)
    const reasons: string[] = []
    const cornerClearance = Math.min(Infinity, ...corners.map(v => tabCircularDistance(s, v.s, length)))
    let clearance = Math.min(cap, cornerClearance - w / 2 - r)
    if (cornerClearance < margin - 1e-8) reasons.push('sharp-corner-or-short-span')
    if (exclusions.some(e => tabWrap(s - w / 2, s + w / 2, length).some(t => t.start < e.end && t.end > e.start))) reasons.push('entry-exit')
    const projection = closestArcPosition(source.path, point)!
    if (projection.euclidean > r + epsilon) reasons.push('source-path-mismatch')
    // Exempt only the local source arc, not an entire long edge (a concave
    // opposite wall can be close even when center/endpoints look clear).
    // The extra R avoids counting a curved local wall as its own obstacle:
    // local arc reach is W/2 + 2R + epsilon; sharp exclusions stay W/2+R+epsilon.
    const nonlocal = tabSegments(sourceArc, projection.distance + margin + r, projection.distance + sourceArc.perimeter - margin - r)
    const checkEdges = (edges: Array<[Pt2, Pt2]>, radius: number) => {
      let distance = Infinity
      for (const [a, b] of spans) for (const [c, d] of edges) distance = Math.min(distance, tabSegmentDistance(a, b, c, d))
      return distance - radius
    }
    if (sourceArc.perimeter <= 2 * (margin + r)) reasons.push('no-local-material-span')
    else {
      const gap = checkEdges(nonlocal, r)
      clearance = Math.min(clearance, gap)
      if (gap < epsilon - 1e-8) reasons.push('opposite-wall')
    }
    for (const ring of rings.filter(ring => ring !== source)) {
      const gap = checkEdges(tabSegments(tabArc(ring.path), 0, polylineCumulative(ring.path).perimeter), r)
      clearance = Math.min(clearance, gap)
      if (gap < epsilon - 1e-8 || (ring.kind === 'hole' && spans.some(([a, b]) => pointInPolygon(a, ring.path) || pointInPolygon(b, ring.path)))) reasons.push(`source-ring:${ring.loopId}`)
    }
    // For inner contours, explicitly require a containing material boundary;
    // absent stock/skeleton evidence must not be promoted into a checked web.
    if (source.kind === 'hole' && !rings.some(ring => ring !== source && ring.kind !== 'hole'
      && pointInPolygon(point, ring.path))) reasons.push('material-connection-unresolved')
    for (const obstacle of fixtures) {
      const f = obstacle.footprint
      const ring = [{ x: f.minX, y: f.minY }, { x: f.maxX, y: f.minY }, { x: f.maxX, y: f.maxY }, { x: f.minX, y: f.maxY }]
      const envelopes = [...(input.cuttingBand ? [{ radius: r, band: input.cuttingBand }] : []), ...(input.holder ? [input.holder] : [])]
      for (const envelope of envelopes) {
        if (obstacle.bottomZ > envelope.band.topZ || obstacle.topZ < envelope.band.bottomZ) continue
        const gap = spans.some(([a, b]) => pointInPolygon(a, ring) || pointInPolygon(b, ring)) ? -envelope.radius
          : checkEdges(tabSegments(tabArc(ring), 0, polylineCumulative(ring).perimeter), envelope.radius)
        clearance = Math.min(clearance, gap - envelope.band.allowanceMm)
        if (gap < epsilon + envelope.band.allowanceMm - 1e-8) reasons.push(`fixture:${obstacle.id}`)
      }
    }
    // Smooth turn density uses the shorter adjacent chord, so a curved arc's
    // endpoint never spreads its turn along a long straight. Sharp turns stay
    // discrete. Equal circle chords integrate to W/r under refinement.
    const tangentTurn = vertices.reduce((sum, v) => {
      if (v.angle >= Math.PI / 4 - 1e-9) return sum + (tabCircularDistance(s, v.s, length) <= w / 2 ? v.angle : 0)
      const cellWidth = Math.min(v.before, v.after)
      return sum + tabWrap(v.s - cellWidth / 2, v.s + cellWidth / 2, length)
        .reduce((total, cell) => total + tabWrap(s - w / 2, s + w / 2, length).reduce((n, span) =>
          n + Math.max(0, Math.min(cell.end, span.end) - Math.max(cell.start, span.start)), 0), 0) * v.angle / cellWidth
    }, 0)
    const candidate: TabCandidate = { fraction: mapped.fraction, distance: mapped.distance, point: mapped.point,
      intervals: tabWrap(mapped.distance - w / 2, mapped.distance + w / 2, originalArc.perimeter),
      tangentTurn, cornerClearance, clearance: Math.min(cap, clearance), reasons: [...new Set(reasons)], selected: false }
    return { s, candidate }
  })
  const quantize = (n: number) => Math.round(n / tolerance)
  while (chosen.length < count) {
    const available = pool.filter(p => !p.candidate.reasons.length && !p.candidate.selected
      && chosen.every(c => tabCircularDistance(c.s, p.s, length) >= w - 1e-9)
      // planTabs requires a positive free gap even for exact W-spaced packing.
      && (chosen.length + 1) * w < length - 1e-6)
    if (!available.length) break
    const score = (p: typeof pool[number]) => [quantize(p.candidate.tangentTurn * w), -quantize(p.candidate.clearance),
      -quantize(chosen.length ? Math.min(...chosen.map(c => tabCircularDistance(c.s, p.s, length))) : length),
      quantize(Math.abs(tabMod(p.s, length / count) - length / count / 2)),
      q(p.candidate.point.x), q(p.candidate.point.y), quantize(p.s)]
    available.sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.s - b.s })
    available[0].candidate.selected = true
    chosen.push(available[0])
  }
  for (const p of pool) if (!p.candidate.selected && !p.candidate.reasons.length) p.candidate.reasons.push(
    chosen.some(c => tabCircularDistance(c.s, p.s, length) < w - 1e-9) ? 'separation' : 'not-selected')
  result.candidates = pool.map(p => p.candidate)
  result.fractions = chosen.map(p => p.candidate.fraction).sort((a, b) => a - b)
  result.found = chosen.length
  result.message = `found ${result.found} of ${count} suggestions`
  if (result.found < count) result.diagnostics.push('partial-greedy-packing: not proof that no other packing exists')
  return result
}
