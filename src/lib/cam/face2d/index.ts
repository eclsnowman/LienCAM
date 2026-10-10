// face2d — 2D Facing toolpath generator.
//
// Faces (surfaces) the top of stock by sweeping parallel passes across a region,
// overrunning the region edges so the cutter fully clears the perimeter. This
// OUTWARD-overrun behaviour is the deliberate inverse of pocket's inward inset
// (ADR 0015 §2): a pocket has walls the tool must not cross; a face has none.
//
// The operation is SOURCE-AGNOSTIC (ADR 0015 §1): it receives the region to face
// as an ordinary world-XY polygon in loops[] and does not know or care whether
// that polygon came from the stock footprint (v1), a selected model face, or a
// rest-machining surface (both deferred — resolved in the store). All it does is
// fill the polygon with parallel passes.
//
// Algorithm (scanline boustrophedon):
//   1. Take the largest closed loop as the region boundary.
//   2. Offset it for the tool per boundaryContainment (default: outward by the
//      tool radius so edge passes fully clear the perimeter), ± stockOffset and
//      ∓ radial stock-to-leave.
//   3. Rotate the region by −passAngle so passes become horizontal scanlines.
//   4. Space scanlines by stepover; clip each against the polygon (even-odd rule,
//      so concave regions yield multiple spans per line); extend span ends by
//      passExtension (the overrun).
//   5. Rotate spans back to world XY and connect them: both-ways → continuous
//      boustrophedon (stay down, optional smooth arc turns); climb/conventional →
//      one-way passes with a retract-and-return between each.
//   6. Repeat per Z level (stepdown), honouring axial stock-to-leave and an
//      optional finish pass.
//
// Deferred FaceParams members fail loud here per ADR 0003 — a greyed UI control
// means the user cannot set them, but a hand-edited project must never silently
// produce a wrong toolpath.

import { ensureCCW, offsetPolygon, largestLoop, polyBBox, centroid, pointInPolygon } from '../geometry'
import { offsetLoop } from './clipperOffset'
// WO-1820: the rest boundary is a polygon DIFFERENCE, which face2d's own clipper
// wrapper (clipperOffset.ts) deliberately does not expose - it is an offsetter
// only. The adaptive engine's wrapper already owns the boolean ops on the same
// clipper2-wasm build, so the rest resolver borrows them rather than growing a
// third boolean surface. (clipperEngine.ts's own TODO(consolidate) covers
// hoisting both wrappers onto one shared module; this import does not make that
// worse - it reuses the instance that is already initialised in the worker.)
import { difference as clipperDifference, loopArea as clipperLoopArea,
  ensureEngineClipperReady, engineClipperReady } from '../adaptiveClearing2d/engine/clipperEngine'
import { resolveHeights } from '../heights'
import { resolveFeedrates } from '../feedrates'
import { assertToolFluteReach } from '../toolFluteReach'
import { directionForTool } from '../../tool/cutHand'
import type { ToolpathMove, FaceWorkerPayload, FaceParams } from '../types'

type Pt = { x: number; y: number }

const MAX_PASSES = 100_000   // runaway guard (degenerate stepover / huge region)

// ── Fail-loud guards for deferred capabilities (ADR 0003 / ADR 0015) ───────────
function assertSupported(params: FaceParams): void {
  if (params.avoidanceLoopIds && params.avoidanceLoopIds.length > 0)
    throw new Error('Face: avoidance regions (islands/features to keep clear) are not yet implemented (ADR 0015 deferred).')
  if (params.entryType === 'lead_in_arc')
    throw new Error('Face: arc lead-in entry is not yet implemented (ADR 0015 deferred); use plunge entry.')
  if (params.chipThinning)
    throw new Error('Face: chip thinning is not yet implemented (ADR 0015 deferred).')
  if (params.transition === 'high_feed' || params.transition === 'no_contact')
    throw new Error(`Face: '${params.transition}' transition is not yet implemented (ADR 0015 deferred); use 'straight' or 'smooth'.`)
}

// ── Depth list (matches contour/pocket) ────────────────────────────────────────
function buildDepths(topZ: number, bottomZ: number, stepdown: number): number[] {
  const sd = Math.abs(stepdown) || 1
  const depths: number[] = []
  let z = topZ - sd
  while (z > bottomZ + 0.001) { depths.push(z); z -= sd }
  depths.push(bottomZ)
  return depths
}

// ── Scanline span clipping (even-odd rule) ─────────────────────────────────────
// Returns the inside-region x-intervals where the horizontal line y = yLine
// crosses `polys`. Uses the half-open crossing test (edge counts when one endpoint
// is below yLine and the other is at-or-above) so a scanline grazing a vertex is
// counted exactly once rather than zero or twice.
//
// WO-1820: crossings are pooled across EVERY loop - outer AND hole - before
// pairing, so the even-odd rule spans the whole region set at once. One outer
// loop behaves exactly as it always did (same crossings, same order, same pairs),
// several disjoint outer loops each yield their own spans, and a HOLE loop nested
// inside an outer one toggles the parity twice and so splits that line's span
// around it. That is what lets a rest boundary (stock minus the earlier pockets)
// be filled by the same scanline fill that fills a plain rectangle.
//
// Each span end also carries WHICH kind of loop produced it. The pass overrun
// exists so the cutter fully exits the MATERIAL at the region's edge; a span end
// that sits on a pocket wall has no material past it (the hole was already grown
// into by the tool radius, so the wall is clear), and extending there would drive
// a cut move out across the open pocket. Ends on an outer loop overrun exactly as
// before; ends on a hole do not.
interface Span { x0: number; x1: number; ext0: boolean; ext1: boolean }

function scanlineSpans(outerPolys: Pt[][], holePolys: Pt[][], yLine: number): Span[] {
  const xs: Array<{ x: number; outer: boolean }> = []
  const collect = (polys: Pt[][], outer: boolean) => {
    for (const poly of polys) {
      const n = poly.length
      for (let i = 0; i < n; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % n]
        const crosses = (a.y <= yLine && b.y > yLine) || (b.y <= yLine && a.y > yLine)
        if (!crosses) continue
        const t = (yLine - a.y) / (b.y - a.y)
        xs.push({ x: a.x + t * (b.x - a.x), outer })
      }
    }
  }
  collect(outerPolys, true)
  collect(holePolys, false)
  xs.sort((p, q) => p.x - q.x)
  const spans: Span[] = []
  for (let i = 0; i + 1 < xs.length; i += 2)
    spans.push({ x0: xs[i].x, x1: xs[i + 1].x, ext0: xs[i].outer, ext1: xs[i + 1].outer })
  return spans
}

// -- Rest boundary (WO-1820 v1) ----------------------------------------------
/** The faceable region, split into outer contours and the holes punched through
 *  them, plus its NET area in mm^2 (outer minus holes). */
export interface RestRegion {
  outer: Pt[][]
  holes: Pt[][]
  areaMm2: number
}

/** True once `restRegionFrom` may be called (the clipper2 instance it borrows is
 *  loaded). `ensureRestClipperReady()` loads it. */
export const restClipperReady = engineClipperReady
/** Load the clipper2 instance `restRegionFrom` needs. Safe to call repeatedly. */
export const ensureRestClipperReady = ensureEngineClipperReady

/**
 * `boundary` minus `removed`: the stock/contour boundary with the footprints of
 * earlier operations cut out of it. Pure geometry - it is told what was removed
 * and never asks where that came from.
 *
 * Both sets are clipped with the EVEN-ODD fill rule, which matters twice:
 *  - inside `removed`, a loop NESTED in another (a pocket's island) cancels out,
 *    so an island the pocket left standing is NOT treated as removed material;
 *  - two OVERLAPPING sibling loops in `removed` cancel over their overlap, so the
 *    overlap is treated as still-present material. That errs toward facing
 *    material that is already gone (a wasted air pass) rather than toward
 *    skipping material that is still there - "missing stock is not an option".
 *
 * Outer-vs-hole classification does not assume clipper's winding convention: the
 * largest-|area| loop of a difference is always an outer contour, so every loop
 * whose signed area has the SAME sign as that one is outer and the rest are holes.
 */
export function restRegionFrom(boundary: Pt[][], removed: Pt[][]): RestRegion {
  if (!engineClipperReady())
    throw new Error('Face (Rest): clipper2 is not initialised (call ensureRestClipperReady() before restRegionFrom).')
  const subject = boundary.filter(l => l.length >= 3)
  if (subject.length === 0) return { outer: [], holes: [], areaMm2: 0 }
  const clip = removed.filter(l => l.length >= 3)
  const result = clip.length === 0
    ? subject.map(l => l.slice())
    : clipperDifference(subject, clip).filter(l => l.length >= 3)
  if (result.length === 0) return { outer: [], holes: [], areaMm2: 0 }

  let biggestAbs = -1
  let outerSign = 1
  for (const loop of result) {
    const signed = clipperLoopArea(loop)
    if (Math.abs(signed) > biggestAbs) { biggestAbs = Math.abs(signed); outerSign = Math.sign(signed) || 1 }
  }

  const outer: Pt[][] = []
  const holes: Pt[][] = []
  let areaMm2 = 0
  for (const loop of result) {
    const signed = clipperLoopArea(loop)
    if (Math.sign(signed) === outerSign) { outer.push(loop); areaMm2 += Math.abs(signed) }
    else { holes.push(loop); areaMm2 -= Math.abs(signed) }
  }
  return { outer, holes, areaMm2: Math.max(0, areaMm2) }
}

export function buildFaceToolpath(
  payload: FaceWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, heights, passes, tool, loops, regionHoles, wcsOrigin, feedrateOverride } = payload
  assertSupported(params)
  const plannerDirection = params.direction === 'both_ways'
    ? 'both_ways'
    : directionForTool(params.direction, tool)

  const moves: ToolpathMove[] = []
  const toolRadius = tool.diameter / 2

  const { feedRate, plungeRate } = resolveFeedrates(tool, feedrateOverride)
  const { clearanceZ, retractZ, feedZ, topZ, bottomZ: rawBottomZ } = resolveHeights(heights, wcsOrigin)
  assertToolFluteReach({
    operation: 'Face',
    topZ,
    bottomZ: rawBottomZ,
    fluteLength: tool.fluteLength,
  })
  const bottomZ = rawBottomZ

  // ── Region boundary: largest closed loop ──────────────────────────────────
  // ADR 0003: fail loud instead of silently emitting an empty toolpath — a
  // no-closed-loop region (e.g. a partial-ellipse baked as open loops, SKC-47-R2)
  // reaching this builder directly (bypassing the store's own pre-dispatch guard,
  // src/store/index.ts:5415-5420) must never come back as a quiet "ready / 0 moves".
  const closed = loops.filter(l => l.closed)
  if (closed.length === 0) throw new Error('Face: no closed loop found to face. Select a closed contour in the Geometry tab.')
  const boundary = ensureCCW(largestLoop(closed.map(l => l.points as Pt[])) as Pt[]) as Pt[]
  if (boundary.length < 3) return moves

  // WO-1820 rest boundary. `regionHoles` PRESENT (even empty) is the store saying
  // "this region was already differenced for you": every closed loop in `loops` is
  // an outer contour of it (the difference can split the stock into islands) and
  // `regionHoles` are the pockets punched through them. ABSENT - every other
  // boundary source, and every direct-engine caller - keeps the historical
  // single-largest-loop region byte-for-byte.
  const restMode = regionHoles !== undefined
  const holeLoops: Pt[][] = (regionHoles ?? [])
    .filter(h => h.length >= 3)
    .map(h => h.map(pt => ({ x: pt.x, y: pt.y })))
  const outerSources: Pt[][] = restMode
    ? closed.map(l => ensureCCW([...(l.points as Pt[])]) as Pt[]).filter(l => l.length >= 3)
    : [boundary]
  if (outerSources.length === 0) return moves
  if (restMode && holeLoops.length > 0 && params.pattern === 'offset')
    throw new Error(
      'Face: the Offset (contour-parallel) pattern cannot follow a Rest boundary yet - its concentric '
      + 'rings would run straight through the pocket areas the Rest boundary excludes. Use the Linear, '
      + 'Zigzag or One-way pattern for a rest face.')

  // ── Tool-centre fill region (ADR 0015 §2: outward overrun by default) ──────
  const radialStock = Math.max(0, passes.stockToLeave ?? 0)
  const stockOffset = params.stockOffset ?? 0
  const containmentSign =
    params.boundaryContainment === 'inside'  ? -1 :
    params.boundaryContainment === 'center'  ?  0 : 1   // 'outside' default
  const fillOffset = containmentSign * toolRadius + stockOffset - radialStock

  const region = (Math.abs(fillOffset) < 1e-6
    ? boundary
    : (offsetPolygon(boundary, fillOffset, 2) as Pt[] | undefined)) ?? null
  if (!region || region.length < 3 || !region.every(p => isFinite(p.x) && isFinite(p.y))) return moves

  // Tool-centre loops actually filled. Non-rest: exactly `region`, as before.
  // Rest: every outer contour grown by fillOffset through the robust clipper
  // offsetter (the miter offsetPolygon self-intersects on the concave corners a
  // differenced region is full of). The holes are offset separately, per pass
  // spacing - see holesForSpacing().
  const fillLoops: Pt[][] = restMode
    ? outerSources.flatMap(l => (Math.abs(fillOffset) < 1e-6 ? [l] : offsetLoop(l, fillOffset, 0)))
    : [region]
  if (fillLoops.length === 0) return moves

  // ── Rotate region into the pass frame (passes become horizontal lines) ─────
  const theta = (params.passAngle ?? 0) * Math.PI / 180
  const cs = Math.cos(theta), sn = Math.sin(theta)
  const rot     = (p: Pt): Pt => ({ x:  p.x * cs + p.y * sn, y: -p.x * sn + p.y * cs })
  const rotBack = (p: Pt): Pt => ({ x:  p.x * cs - p.y * sn, y:  p.x * sn + p.y * cs })
  const rPolys = fillLoops.map(l => l.map(rot))

  // WO-1820 fix phase: the tool-centre exclusion zone around each earlier pocket,
  // rotated into the scan frame, for a given SCANLINE SPACING. Returned loops are
  // both the holes the scanline fill is clipped against and the holes a stay-down
  // turn may not cross, which are the same set.
  //
  // How far the exclusion wall sits from the real pocket wall is the whole
  // question. Two rules bound it, and the tighter one wins:
  //
  //  - CONTAINMENT (the mirror of the outer offset, as before): the tool centre
  //    may come `fillOffset` past the wall. For the default outward containment
  //    that is +R - the cutter clears right up to the pocket wall, exactly as it
  //    overruns the stock edge (ADR 0015 s2). For 'inside' containment it is -R:
  //    the tool must not overhang the pocket at all, so the hole GROWS by R.
  //  - REDUNDANCY (new): a pass whose disc only clips a sliver of wall that the
  //    NEIGHBOURING pass already covers adds nothing but air. The pass one spacing
  //    short of the wall reaches `spacing` further than a pass sitting `spacing`
  //    back from it, so a pass may be split as soon as its centre is within
  //    (R - spacing) of the wall and the material it would have taken is still
  //    cut. Operator's picture verdict 2026-09-23: two passes ran the full 50mm width
  //    of a pocket to take a 0.4mm strip the neighbouring pass had already cut.
  //
  // Both are expressed as a SHRINK of the pocket loop; the smaller shrink (the
  // exclusion zone that reaches further from the pocket) is the binding one, so
  // 'inside' containment is never loosened by the redundancy rule and outward
  // containment never keeps an all-air pass. A pocket that shrinks below a
  // twentieth of the tool's own disc has no room to be worth splitting around and
  // is dropped - the face simply covers it, which is correct: the tool cannot
  // drop into a pocket narrower than itself.
  const minHoleArea = Math.PI * toolRadius * toolRadius * 0.05
  const holeCache = new Map<number, Pt[][]>()
  const holesForSpacing = (spacing: number): Pt[][] => {
    const key = Math.round(spacing * 1e6)
    const cached = holeCache.get(key)
    if (cached) return cached
    const redundancyTrim = Math.max(0, containmentSign * toolRadius + toolRadius - spacing)
    const holeOffset = -fillOffset + redundancyTrim
    const loops = holeLoops
      .flatMap(h => {
        const ccw = ensureCCW([...h]) as Pt[]
        return Math.abs(holeOffset) < 1e-9 ? [ccw] : offsetLoop(ccw, holeOffset, minHoleArea)
      })
      .filter(l => l.length >= 3 && Math.abs(clipperLoopArea(l)) >= minHoleArea)
      .map(l => l.map(rot))
    holeCache.set(key, loops)
    return loops
  }

  const bb = polyBBox(rPolys.flat())
  const stepover = Math.max(0.1, passes.stepover)
  const passExt  = Math.max(0, params.passExtension ?? 0)
  const range = bb.maxY - bb.minY
  if (range / stepover > MAX_PASSES) return moves

  // Even spacing ≤ stepover, inclusive of both extremes so edge passes clear the
  // perimeter (the region is already grown by the tool radius).
  const finishStepover = Math.max(0.1, passes.finishStepover ?? stepover)

  // Stay-down envelope for zigzag turns: the fill region grown by the overrun,
  // rotated into the scan frame. A boustrophedon turn stays DOWN as one continuous
  // cut whenever the connecting move stays inside this envelope — even a long
  // diagonal riding a slanted top/bottom edge. It RETRACTS only when the move would
  // leave the envelope, i.e. cut across a concavity/gap (a slot) that is outside
  // the region. An ordinary in-XY turn is never a retract — it just snakes over the
  // cleared/clearing surface.
  // Margin beyond the overrun: a clean boustrophedon turn rides ~passExt outside
  // the region edge and its chord can bow a little further at a SHALLOW concave
  // step — keep those down. Only a gap deeper than the tool radius (a real slot the
  // tool would gouge) should leave the envelope and force a retract.
  // Build the envelope with the ROBUST clipper offset, NOT the miter offsetPolygon.
  // An outward miter offset of a CONCAVE feature (a notch the tool bridges) self-
  // intersects at the notch mouth; even-odd pointInPolygon then flips those points
  // to "outside", so a stay-down-able boustrophedon turn over the notch wrongly
  // retracts. clipper trims the self-overlap and returns clean loop(s). (This was
  // the last miter use the ring-fill rewrite left behind.) Test the connecting move
  // against the UNION of the returned loops.
  const envLoops = restMode
    ? fillLoops.flatMap(l => offsetLoop(ensureCCW([...l]) as Pt[], passExt + toolRadius, 0))
    : offsetLoop(ensureCCW([...region]) as Pt[], passExt + toolRadius, 0)
  const stayDownEnvR: Pt[][] = (envLoops.length > 0 ? envLoops : fillLoops).map(loop => loop.map(rot))
  // WO-1820: the envelope's own holes are the pockets, exactly as the fill sees
  // them (holesForSpacing). A boustrophedon turn that would run from one side of
  // a pocket to the other must RETRACT and rapid across instead: at face depth
  // the pocket floor is already below the tool, so a stay-down link there is a
  // cut move dragged through open air right across the feature the rest boundary
  // exists to skip. They are NOT grown by the overrun margin the way the outer
  // envelope is - growing the outer edge only ever ADMITS turns that ride just
  // outside the stock, whereas eating the same margin out of a pocket would admit
  // exactly the crossing this is here to stop (a 40x30 pocket, minus a 10mm
  // margin all round, stops containing the very scanlines that run through it).

  // ── Z levels ──────────────────────────────────────────────────────────────
  // Axial (floor) stock: shared PassParams field wins; legacy per-op
  // FaceParams.floorStockToLeave is the back-compat fallback.
  const floorStock = Math.max(0, passes.floorStockToLeave ?? params.floorStockToLeave ?? 0)
  const roughBottomZ = floorStock > 0 ? bottomZ + floorStock : bottomZ
  const depths = buildDepths(topZ, roughBottomZ, passes.stepdown)
  if (floorStock > 0) depths.push(bottomZ)
  if (depths.length === 0) return moves

  const bothWays =
    params.pattern === 'zigzag' ? true :
    params.pattern === 'one_way' ? false :
    plannerDirection === 'both_ways'      // 'linear' follows the cut direction
  // One-way pass travel: climb → +X', conventional → −X' (documented v1 mapping;
  // keeps the cutter's engaged side consistent across passes).
  const oneWayPlusX = plannerDirection !== 'conventional'
  const smooth = params.transition === 'smooth' && bothWays

  // Ring patterns (offset/spiral) leave UNCUT material at convex inner corners
  // when the radial step exceeds √2·toolRadius: consecutive ring corners sit
  // stepover·√2 apart on the diagonal, so their midpoint is beyond tool reach.
  // Clamp the ring step so corners — AND the residual at an offset-tree SPLIT (a
  // concave divider, where the parent's innermost ring and the child's outermost ring
  // can sit up to ~2·step apart) — always clear: step <= R keeps that worst gap within
  // 2R (tool reach). "Missing stock is not an option." Only ever reduces the step;
  // straight passes keep the user's stepover (step <= tool diameter, no corner penalty).
  const maxRingStep = toolRadius

  // The offset (contour-parallel) pattern gets its outer ring(s) from clipper —
  // offsetting the CONTOUR outward (tool radius ± stock/offset, + overrun) with
  // proper trimming, instead of the naive miter offsetPolygon which leaves
  // untrimmed self-overlap at concave corners that then breaks the inward offset
  // tree. The outward offset of a concave boundary can itself split, so this is a
  // list of root loops; the offset fill recurses the offset tree (buildRegionTree)
  // and so handles concave/branched contours — no concavity gate is needed.
  const ringRoots: Pt[][] = params.pattern === 'offset'
    ? (restMode ? outerSources : [boundary]).flatMap(l =>
        offsetLoop(ensureCCW([...l]) as Pt[], fillOffset + passExt,
          Math.PI * toolRadius * toolRadius * 0.05))
    : []

  for (let di = 0; di < depths.length; di++) {
    const depth = depths[di]
    const isFinal = di === depths.length - 1
    const useFinish = params.finishPass && isFinal
    const lineStep = useFinish ? finishStepover : stepover
    const ringStep = Math.min(lineStep, maxRingStep)

    if (params.pattern === 'offset') {
      // Contour-parallel: per clipper-clean root region, concentric rings stepping
      // inward (the offset tree handles concave splits). oneWayPlusX = climb (CCW);
      // theta orients the start.
      for (const root of ringRoots)
        cutLevelOffset(moves, root, depth, ringStep, toolRadius,
          feedZ, retractZ, clearanceZ, feedRate, plungeRate, oneWayPlusX, theta)
    } else {
      // Straight passes leave uncut ridges once the spacing exceeds the tool
      // diameter (2·R). Cap at 1.9·R for a coverage margin — "missing stock is
      // not an option". Only ever tightens the user's stepover.
      const scanStep = Math.min(lineStep, 1.9 * toolRadius)
      const gaps = Math.max(1, Math.ceil(range / scanStep))
      // The scanlines are spaced EVENLY across the range, so the real spacing is
      // range/gaps (<= scanStep). The redundancy rule is only sound against the
      // spacing the passes actually get, never the requested ceiling.
      const rHoles = holesForSpacing(range / gaps)
      cutLevel(moves, rPolys, rHoles, rotBack, bb, range, gaps, passExt, stayDownEnvR, rHoles, depth,
        feedZ, retractZ, clearanceZ, feedRate, plungeRate,
        bothWays, oneWayPlusX, smooth,
        // bothSidesPerLevel alternates the start side each Z level
        params.bothSidesPerLevel ? (di % 2 === 1) : false,
        !!params.fromOtherSide,
        params.keepToolDown ?? true, params.maxStayDownDistance ?? Infinity)
    }

    // Progress checkpoint: one Z level cleared (coarse — per depth pass).
    onProgress?.((di + 1) / depths.length,
      depths.length > 1 ? `Z level ${di + 1}/${depths.length}` : undefined)
  }

  // Final lift to clearance.
  const last = moves[moves.length - 1]
  if (last) moves.push({ type: 'rapid', x: last.x, y: last.y, z: clearanceZ, role: 'rapid' })

  return moves
}

// ── Cut one Z level: all parallel passes ───────────────────────────────────────
function cutLevel(
  moves: ToolpathMove[],
  rPolys: Pt[][], rHoles: Pt[][], rotBack: (p: Pt) => Pt,
  bb: { minX: number; minY: number; maxX: number; maxY: number },
  range: number, gaps: number, passExt: number,
  stayDownEnvR: Pt[][], stayDownHolesR: Pt[][],
  depth: number,
  feedZ: number, retractZ: number, clearanceZ: number,
  feedRate: number, plungeRate: number,
  bothWays: boolean, oneWayPlusX: boolean, smooth: boolean,
  flipLevel: boolean, fromOtherSide: boolean,
  keepToolDown: boolean, maxStayDown: number,
): void {
  // Build the ordered list of passes. Each carries its world [start, end] segment
  // AND its endpoints in the rotated (scan) frame: xsR/xeR are the pass start/end x
  // and yLine the scanline. The boustrophedon turn between two passes stays DOWN
  // (one continuous cut) when the connecting move stays inside the overrun envelope
  // `stayDownEnvR` — even a long diagonal riding a slanted edge. It only retracts
  // when the move would leave the envelope, i.e. cut across a gap (a slot) outside
  // the region. See linkPasses.
  // The run grouping below decides the ORDER of the passes; it does not decide
  // which links lift. That stays one question of geometry: a move that leaves the
  // envelope, or crosses a pocket, retracts, and every other move is a feed link -
  // including the step onto the first row of a new run, which is an ordinary
  // row-step whenever the run opens directly above the one that just finished.
  type Pass = { a: Pt; b: Pt; yLine: number; xsR: number; xeR: number; island: number }
  // Clamp scanlines a hair inside the extremes: the half-open crossing rule in
  // scanlineSpans drops a line that sits exactly on the topmost vertex (nothing
  // is strictly above it), which would leave the top strip uncut. The inset is
  // sub-micron relative to the region and does not affect coverage (the region
  // is already grown by the tool radius).
  const eps = Math.min(range * 1e-4, 1e-3)
  const yOrder: number[] = []
  for (let i = 0; i <= gaps; i++) {
    const y = bb.minY + (i * range) / gaps
    yOrder.push(Math.min(bb.maxY - eps, Math.max(bb.minY + eps, y)))
  }
  if (flipLevel !== fromOtherSide) yOrder.reverse()

  // WO-1820 fix phase. A scanline through a rest region can produce SEVERAL spans
  // — one either side of an earlier pocket. Emitting them in raw scanline order
  // machines the two sides a row at a time, so every split row becomes an island
  // with a lift at each end and a full-width diagonal rapid back to the next row
  // (Operator's picture verdict, 2026-09-23: "there are still facing sections on
  // either side of that center pocket that don't look linked").
  //
  // Group the spans into RUNS instead: a run is a maximal stack of spans that
  // continue one into the next up the scanlines. Where the region splits, the run
  // ends and one new run opens per side; where sides merge again, those runs end
  // and one opens. Each run is then machined as its own continuous zigzag, linked
  // exactly like the unsplit rows, and the tool lifts ONCE to move between runs.
  // On an unsplit region (every non-rest face, and a rest face with nothing
  // subtracted) there is exactly one run holding every scanline in order, so the
  // pass list is byte-identical to what it always was.
  //
  // Each span also records WHICH fill loop (island of remaining material) it was
  // cut from. Where an earlier pocket runs right across the stock the rest region
  // is two separate islands, and the stay-down envelope alone does not keep the
  // tool out of the gap between them: each island's envelope is grown by the
  // overrun plus a tool radius, so for a pocket no wider than twice that the two
  // envelopes OVERLAP and a link straight across the removed slot tested as
  // "inside". Measured 2026-09-23 on a 20mm through-pocket: a 90mm feed move at
  // depth, corner to corner across the slot. Island identity is the honest test -
  // a move from one island to another is never one continuous cut, whatever the
  // envelopes say - and every non-rest face has exactly one island, so it changes
  // nothing there.
  type FillSpan = { x0: number; x1: number; lo: number; hi: number; yLine: number; island: number }
  type Run = { startRow: number; spans: FillSpan[] }
  const islandOf = (x0: number, x1: number, yLine: number): number => {
    const p = { x: (x0 + x1) / 2, y: yLine }
    let fallback = 0, bestD = Infinity
    for (let i = 0; i < rPolys.length; i++) {
      if (pointInPolygon(p, rPolys[i])) return i
      const d = distanceToLoop(p, rPolys[i])
      if (d < bestD) { bestD = d; fallback = i }
    }
    return fallback
  }
  const rows: FillSpan[][] = yOrder.map(yLine =>
    scanlineSpans(rPolys, rHoles, yLine).map(({ x0, x1, ext0, ext1 }) => ({
      x0, x1, lo: x0 - (ext0 ? passExt : 0), hi: x1 + (ext1 ? passExt : 0), yLine,
      island: islandOf(x0, x1, yLine),
    })))

  // Two spans continue one into the other when they are cut from the same island
  // and their UNEXTENDED intervals overlap. The overrun is deliberately excluded:
  // two islands the same pocket cut apart can sit closer than twice the overrun
  // without being one region.
  const overlaps = (a: FillSpan, b: FillSpan) =>
    a.island === b.island && a.x0 < b.x1 - 1e-9 && b.x0 < a.x1 - 1e-9

  const runs: Run[] = []
  let open: Array<{ run: Run; span: FillSpan }> = []
  for (let r = 0; r < rows.length; r++) {
    const spans = rows[r]
    const hitsOfSpan = spans.map(s => open.flatMap((o, i) => (overlaps(s, o.span) ? [i] : [])))
    const hitsOfRun = open.map(o => spans.flatMap((s, i) => (overlaps(s, o.span) ? [i] : [])))
    const next: typeof open = []
    for (let i = 0; i < spans.length; i++) {
      const hits = hitsOfSpan[i]
      // Continue a run only on a clean one-to-one handover. A split (one run, two
      // spans) or a merge (two runs, one span) closes every run involved and opens
      // a fresh one, which is exactly the boundary the tool should lift across.
      if (hits.length === 1 && hitsOfRun[hits[0]].length === 1) {
        const o = open[hits[0]]
        o.run.spans.push(spans[i])
        next.push({ run: o.run, span: spans[i] })
      } else {
        const run: Run = { startRow: r, spans: [spans[i]] }
        runs.push(run)
        next.push({ run, span: spans[i] })
      }
    }
    open = next
  }
  if (runs.length === 0) return

  // Emit the runs in scanline order (a run may only go next once no pending run
  // opens on a lower row). WO-1820 fix phase 3 - Operator's second picture verdict,
  // 2026-09-23: "Look at the diagonal linking crossover near the skipped center.
  // This is not desirable." The left side of the pocket was ENTERED at the pocket
  // wall, because that was the end nearest the tool - so it also ENDED at the
  // wall, and the step onto the first full-width row above the pocket became a
  // cutting move slanting right across the block.
  //
  // Which end a run is entered at fixes which end it leaves from: the passes
  // alternate, so a run of n spans entered at its `lo` end leaves from `hi` when n
  // is odd and from `lo` when n is even. Entry and exit therefore have to be
  // chosen TOGETHER, and the choice on one run changes what the next run can do -
  // so this is a small search over (which run next, which end it starts at),
  // scored, rather than a nearest-end rule:
  //   - an ordinary row-end link (stays down, no slant across the part) costs its
  //     own length only - the cheapest thing there is;
  //   - a LIFT costs a flat penalty larger than any link inside this region: the
  //     tool is in the air, which is allowed but never free;
  //   - a stay-down link that slants ACROSS the part costs a penalty larger than
  //     any number of lifts. That is the move Operator refused, and the score makes
  //     the emitter take a long rapid over it every time.
  // The result is the general rule the fix needs, at any pocket position and any
  // number of rows per side: the only moves between runs are row-end links
  // outside the stock, and lifts.
  //
  // On an unsplit region - every non-rest face - there is one run, one option and
  // no link to score, so the path stays byte-identical to what it always emitted.
  const spanScale = (bb.maxX - bb.minX) + range + 1
  const LIFT_COST = 10 * spanScale
  const ACROSS_COST = 100 * LIFT_COST
  const endOf = (s: FillSpan, plusX: boolean): Pt => ({ x: plusX ? s.hi : s.lo, y: s.yLine })
  // A run entered going +X starts at its first span's LOW end, and vice versa.
  const entryOf = (run: Run, plusX: boolean): Pt =>
    endOf(run.spans[0], !(bothWays ? plusX : oneWayPlusX))
  const exitOf = (run: Run, plusX: boolean): Pt =>
    endOf(run.spans[run.spans.length - 1], bothWays
      ? (run.spans.length % 2 === 1 ? plusX : !plusX)   // both-ways alternates
      : oneWayPlusX)                                     // one-way never turns

  // Does this move cut ACROSS the part rather than turn at a row end outside it?
  // A row-end link rides in the overrun band, within passExt of the fill region's
  // edge; a move across the part runs deep inside it. A move along one axis only
  // (a pure row step, or travel along a row) is never a crossing, whatever it
  // passes over - it is the diagonal Operator named that must not happen.
  const acrossPart = (a: Pt, b: Pt): boolean => {
    if (Math.abs(b.x - a.x) <= BOUNDARY_TOL_MM || Math.abs(b.y - a.y) <= BOUNDARY_TOL_MM) return false
    const deep = Math.max(passExt, BOUNDARY_TOL_MM)
    for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (rPolys.some(poly => pointInPolygon(p, poly) && distanceToLoop(p, poly) > deep)) return true
    }
    return false
  }
  const costCache = new Map<string, number>()
  const linkCost = (from: Pt | null, fromIsland: number, to: Pt, toIsland: number): number => {
    if (!from) return 0
    const key = `${from.x},${from.y},${fromIsland},${to.x},${to.y},${toIsland}`
    const hit = costCache.get(key)
    if (hit !== undefined) return hit
    const gap = Math.hypot(to.x - from.x, to.y - from.y)
    // linkPasses' own stay-down test, so the score reads the link the emitter
    // will actually make rather than a second opinion about it.
    const staysDown = bothWays && keepToolDown && gap <= maxStayDown && fromIsland === toIsland
      && segmentInsideRot(stayDownEnvR, stayDownHolesR, from.x, from.y, to.x, to.y)
    const cost = !staysDown ? LIFT_COST + gap
      : (acrossPart(from, to) ? ACROSS_COST : 0) + gap
    costCache.set(key, cost)
    return cost
  }

  const islandOfRun = (run: Run): number => run.spans[0].island
  type Step = { run: Run; plusX: boolean }
  let bestOrder: Step[] | null = null
  let bestCost = Infinity
  let budget = 20_000
  const walk = (pendingRuns: Run[], here: Pt | null, hereIsland: number,
                chosen: Step[], cost: number): void => {
    if (cost >= bestCost - 1e-9) return                  // costs only grow: prune
    if (pendingRuns.length === 0) { bestCost = cost; bestOrder = chosen.slice(); return }
    if (budget-- <= 0 && bestOrder) return               // keep descending until one
    let minStart = Infinity                              // complete order exists
    for (const run of pendingRuns) if (run.startRow < minStart) minStart = run.startRow
    const options: Array<{ i: number; plusX: boolean; cost: number }> = []
    for (let i = 0; i < pendingRuns.length; i++) {
      if (pendingRuns[i].startRow !== minStart) continue
      for (const plusX of bothWays ? [true, false] : [oneWayPlusX])
        options.push({ i, plusX, cost: linkCost(here, hereIsland,
          entryOf(pendingRuns[i], plusX), islandOfRun(pendingRuns[i])) })
    }
    // Cheapest first, ties in the order built above (lowest run index, then +X):
    // the first leaf the search reaches is the greedy path, and an equal-cost
    // alternative never displaces it.
    options.sort((a, b) => a.cost - b.cost)
    for (const o of options) {
      const rest = pendingRuns.slice()
      const run = rest.splice(o.i, 1)[0]
      walk(rest, exitOf(run, o.plusX), run.spans[run.spans.length - 1].island,
        chosen.concat({ run, plusX: o.plusX }), cost + o.cost)
    }
  }
  walk(runs.slice(), null, -1, [], 0)

  const passes: Pass[] = []
  for (const step of bestOrder ?? runs.map(run => ({ run, plusX: true }))) {
    let dirPlusX = step.plusX
    for (const s of step.run.spans) {
      // For both-ways we alternate; for one-way every pass goes the same way.
      const goPlusX = bothWays ? dirPlusX : oneWayPlusX
      const aR: Pt = { x: goPlusX ? s.lo : s.hi, y: s.yLine }
      const bR: Pt = { x: goPlusX ? s.hi : s.lo, y: s.yLine }
      passes.push({ a: rotBack(aR), b: rotBack(bR), yLine: s.yLine, xsR: aR.x, xeR: bR.x, island: s.island })
      dirPlusX = !dirPlusX
    }
  }
  if (passes.length === 0) return

  // Entry: rapid above the first pass start, descend, plunge to depth (the start
  // sits in the overrun region — outside the part — so the plunge is in air).
  const first = passes[0]
  moves.push({ type: 'rapid', x: first.a.x, y: first.a.y, z: clearanceZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: first.a.x, y: first.a.y, z: feedZ,      role: 'rapid' })
  moves.push({ type: 'feed',  x: first.a.x, y: first.a.y, z: depth, feed: plungeRate, role: 'plunge' })

  for (let i = 0; i < passes.length; i++) {
    const p = passes[i]
    if (i > 0) {
      const prev = passes[i - 1]
      // Stay down for a continuous turn when the connecting move (prev end -> this
      // start, in the scan frame) stays inside the overrun envelope. Retract only
      // when it would leave it — cutting across a gap/slot outside the region.
      // WO-1820 fix phase 2: opening a new run is NOT itself a reason to lift.
      // Where the region splits, the first row of the new run sits one row-step
      // above the row that just ended, at the same x - a plain boustrophedon turn
      // one step outside the stock, and lifting there was a retract-and-rapid to a
      // point the tool was already at. The move that genuinely has to lift - the
      // crossing to the far side of the pocket - leaves the region, and the hole
      // test below already refuses it.
      // A move between two separate islands of remaining material is never one
      // continuous cut, however the envelopes overlap in the gap between them.
      const canStayDown = prev.island === p.island
        && segmentInsideRot(stayDownEnvR, stayDownHolesR, prev.xeR, prev.yLine, p.xsR, p.yLine)
      linkPasses(moves, prev.b, p.a, depth, retractZ, feedRate,
        bothWays, smooth, keepToolDown, maxStayDown, canStayDown)
    }
    // Cut the pass.
    moves.push({ type: 'feed', x: p.b.x, y: p.b.y, z: depth, feed: feedRate, role: 'cut' })
  }

  // Retract at the end of the level.
  const end = passes[passes.length - 1].b
  moves.push({ type: 'rapid', x: end.x, y: end.y, z: retractZ, role: 'rapid' })
}

// ── Link from the end of one pass to the start of the next ─────────────────────
function linkPasses(
  moves: ToolpathMove[], fromPt: Pt, toPt: Pt,
  depth: number, retractZ: number, feedRate: number,
  bothWays: boolean, smooth: boolean,
  keepToolDown: boolean, maxStayDown: number, canStayDown: boolean,
): void {
  const gap = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y)

  if (bothWays && keepToolDown && canStayDown && gap <= maxStayDown) {
    // Boustrophedon turn at the overrun end — stay down.
    if (smooth) {
      // 180° arc turn (radius = gap/2). The pass ends are in the overrun region
      // (clear of the part), so the rounded turn loads the tool gradually.
      // Arc direction: CCW when advancing to +Y in the world frame; we pick by the
      // sign of the cross product of the incoming heading and the link vector.
      const cx = (fromPt.x + toPt.x) / 2
      const cy = (fromPt.y + toPt.y) / 2
      moves.push({ type: 'arc_cw', x: toPt.x, y: toPt.y, z: depth, cx, cy, feed: feedRate, role: 'stepover' })
    } else {
      moves.push({ type: 'feed', x: toPt.x, y: toPt.y, z: depth, feed: feedRate, role: 'stepover' })
    }
    return
  }

  // One-way (climb/conventional) or stay-down distance exceeded: retract, rapid
  // across the already-faced (cleared) surface, plunge back down.
  moves.push({ type: 'rapid', x: fromPt.x, y: fromPt.y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: toPt.x,   y: toPt.y,   z: retractZ, role: 'rapid' })
  moves.push({ type: 'feed',  x: toPt.x,   y: toPt.y,   z: depth, feed: feedRate, role: 'plunge' })
}

// ── Contour-parallel offset tree (handles concave / branched regions) ──────────
// A node is a RUN of nested rings that do NOT split, then `children` where the run
// pinches into sub-regions under inward offset. Built with clipper2 (offsetInward),
// which returns MULTIPLE disjoint loops when a concave region splits — so a slot/
// notch becomes two child sub-regions instead of one self-crossing ring. This is
// the recursive offset-tree that replaces the single-region ring generator.
type RegionNode = { rings: Pt[][]; children: RegionNode[] }

// Build the offset tree from one outer loop. Iterative along each non-splitting
// run (so recursion depth = number of splits, not ring count); `budget` caps the
// total ring count across the whole tree.
function buildRegionTree(loop: Pt[], step: number, minArea: number, budget: { n: number }): RegionNode {
  const rings: Pt[][] = [ensureCCW([...loop]) as Pt[]]
  let current = rings[0]
  while (budget.n-- > 0) {
    const inner = offsetLoop(current, -step, minArea).map(l => ensureCCW(l) as Pt[])
    if (inner.length === 0) return { rings, children: [] }
    if (inner.length === 1) { rings.push(inner[0]); current = inner[0]; continue }
    return { rings, children: inner.map(l => buildRegionTree(l, step, minArea, budget)) }
  }
  return { rings, children: [] }
}

// ── Offset (contour-parallel) fill of one Z level ──────────────────────────────
// Cut the offset tree: each region's nested rings outside-in (linked across the
// cleared band with a short 'stepover' feed), then descend into each sub-region by
// repositioning (retract-rapid-plunge — a sub-region sits across an uncut divider).
// Leaves finish with a centre-cleanup feed. (The "Offset"/"Concentric" strategy —
// not a continuous spiral; that is the separate 'spiral'/morphed-spiral pattern.)
function cutLevelOffset(
  moves: ToolpathMove[], region: Pt[], depth: number, stepover: number,
  toolRadius: number,
  feedZ: number, retractZ: number, clearanceZ: number,
  feedRate: number, plungeRate: number,
  climb: boolean, startAngle: number,
): void {
  const minArea = Math.PI * toolRadius * toolRadius * 0.05
  const root = buildRegionTree(region, stepover, minArea, { n: 5000 })
  emitOffsetNode(moves, root, depth, feedRate, plungeRate, climb, startAngle,
    true, null, feedZ, retractZ, clearanceZ)
  // Lift after the last sub-region.
  const last = moves[moves.length - 1]
  if (last) moves.push({ type: 'rapid', x: last.x, y: last.y, z: retractZ, role: 'rapid' })
}

// Emit one region node and, recursively, its sub-regions. Returns the last cut
// point. `prevPt` is where the tool currently is (null for the root).
function emitOffsetNode(
  moves: ToolpathMove[], node: RegionNode, depth: number,
  feedRate: number, plungeRate: number, climb: boolean, startAngle: number,
  isRoot: boolean, prevPt: Pt | null,
  feedZ: number, retractZ: number, clearanceZ: number,
): Pt {
  let lastPt: Pt = prevPt ?? node.rings[0][0]
  for (let ri = 0; ri < node.rings.length; ri++) {
    let ring = ensureCCW(node.rings[ri]) as Pt[]
    if (!climb) ring = [...ring].reverse() as Pt[]   // climb → CCW; conventional → CW
    const startIdx = (isRoot && ri === 0)
      ? nearestAngleIdx(ring, centroid(ring), startAngle)   // root entry oriented by Pass-angle
      : nearestIdx(ring, lastPt)
    const seq = [...ring.slice(startIdx), ...ring.slice(0, startIdx)]

    if (ri === 0) {
      if (isRoot) {
        // Entry: plunge at the outer ring start (in the overrun, clear of part).
        moves.push({ type: 'rapid', x: seq[0].x, y: seq[0].y, z: clearanceZ, role: 'rapid' })
        moves.push({ type: 'rapid', x: seq[0].x, y: seq[0].y, z: feedZ,      role: 'rapid' })
        moves.push({ type: 'feed',  x: seq[0].x, y: seq[0].y, z: depth, feed: plungeRate, role: 'plunge' })
      } else {
        // Reposition into the sub-region across the uncut divider: retract, rapid,
        // plunge (safe for facing — rapids sit above the stock top).
        moves.push({ type: 'rapid', x: lastPt.x,  y: lastPt.y,  z: retractZ, role: 'rapid' })
        moves.push({ type: 'rapid', x: seq[0].x,  y: seq[0].y,  z: retractZ, role: 'rapid' })
        moves.push({ type: 'feed',  x: seq[0].x,  y: seq[0].y,  z: depth, feed: plungeRate, role: 'plunge' })
      }
    } else {
      // Step across the cleared band to the next ring of the same run.
      moves.push({ type: 'feed', x: seq[0].x, y: seq[0].y, z: depth, feed: feedRate, role: 'stepover' })
    }
    for (let k = 1; k < seq.length; k++)
      moves.push({ type: 'feed', x: seq[k].x, y: seq[k].y, z: depth, feed: feedRate, role: 'cut' })
    moves.push({ type: 'feed', x: seq[0].x, y: seq[0].y, z: depth, feed: feedRate, role: 'cut' })  // close
    lastPt = seq[0]
  }

  if (node.children.length === 0) {
    // Leaf: clean the residual centre disc (innermost ring is within R of it).
    const c = centroid(node.rings[node.rings.length - 1])
    moves.push({ type: 'feed', x: c.x, y: c.y, z: depth, feed: feedRate, role: 'cut' })
    lastPt = c
  } else {
    for (const child of node.children)
      lastPt = emitOffsetNode(moves, child, depth, feedRate, plungeRate, climb, startAngle,
        false, lastPt, feedZ, retractZ, clearanceZ)
  }
  return lastPt
}

function nearestIdx(ring: Pt[], pt: Pt): number {
  let best = 0, bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const dx = ring[i].x - pt.x, dy = ring[i].y - pt.y
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

// True when the open segment (ax,ay)->(bx,by) stays inside `poly` (sampled at
// interior fractions). Used to decide a stay-down boustrophedon turn vs a retract:
// a turn that stays within the overrun envelope is one continuous cut; one that
// leaves it would cut across a gap and must retract instead.
// True when every sampled point of the segment lies inside the UNION of `polys`
// (the rotated stay-down envelope loops). A point is "inside" if it is inside ANY
// loop — the clipper outward offset returns disjoint outer loops (no holes), so the
// union is their OR.
function segmentInsideRot(polys: Pt[][], holes: Pt[][], ax: number, ay: number, bx: number, by: number): boolean {
  for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
    const p = { x: ax + (bx - ax) * t, y: ay + (by - ay) * t }
    if (!polys.some(poly => pointInPolygon(p, poly))) return false
    // WO-1820: inside the envelope but inside one of its HOLES is outside the
    // region. `holes` is empty for every non-rest face, so this costs nothing
    // and changes nothing there.
    // The ordinary boustrophedon turn at a pocket wall runs ALONG that wall: both
    // pass ends are scanline crossings of the hole loop, so every sampled point
    // sits on the boundary to within rounding and a bare inside/outside test
    // decides it by float noise (measured 2026-09-23: the same turn retracted on
    // one side of a pocket and stayed down on the other). A point only counts as
    // inside a hole once it is clear of the wall by more than `tol` - a crossing
    // of the pocket is inside by millimetres, so nothing real is admitted.
    if (holes.some(hole => pointInPolygon(p, hole) && distanceToLoop(p, hole) > BOUNDARY_TOL_MM)) return false
  }
  return true
}

// Shortest distance from `p` to the closed polyline `loop` (sign-free).
const BOUNDARY_TOL_MM = 1e-6
function distanceToLoop(p: Pt, loop: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    const qx = a.x + t * dx, qy = a.y + t * dy
    const d = Math.hypot(p.x - qx, p.y - qy)
    if (d < best) best = d
  }
  return best
}

function nearestAngleIdx(ring: Pt[], c: Pt, ang: number): number {
  let best = 0, bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = Math.atan2(ring[i].y - c.y, ring[i].x - c.x)
    let d = Math.abs(a - ang) % (2 * Math.PI)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}
