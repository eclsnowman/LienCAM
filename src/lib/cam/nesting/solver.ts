/* Bidirectional sheet/quantity solver for the nesting engine (P1.3).
 *
 * NESTING-P1-ENGINE-PLAN.md P1.3: a SEARCH LAYER that WRAPS the P1.2 packer
 * (index.ts packNest) to satisfy req.solver. It does NOT re-implement packing;
 * it drives the existing packer/placement machinery to answer three objectives:
 *
 *  1. fixSheet  -> MAX QUANTITY. Sheet is fixed; find the largest integer
 *     multiplier M of the requested part-set that still fits (unplaced empty).
 *     Monotonic in M -> doubling-then-binary search. If even M=1 overflows,
 *     return the best single-set fixed-sheet pack with leftovers reported
 *     EXPLICITLY (ADR 0003 - no silent success).
 *  2. fixQty + lockedAxis 'width'|'height' -> MIN SHEET, one axis fixed. Binary-
 *     search the FREE dimension for the minimum length at which all requested
 *     parts place (unplaced empty). The locked dimension stays req.sheet.*.
 *  3. fixQty + lockedAxis 'none' -> MIN AREA, both free. Deterministic bounded
 *     candidate-width scan: sample a fixed number of widths from the largest
 *     single-part extent up to the sum of all part widths; for each, strip-pack
 *     a tall sheet, measure the used length, and pick the (width x usedLength)
 *     of minimum AREA that fits all parts.
 *
 * DETERMINISM (the #1 port risk): every feasibility evaluation and the final
 * pack are seeded from req.seed via mulberry32. The search itself is a pure
 * deterministic function of the (bounded) candidate set, so identical input =>
 * byte-identical NestResult across runs.
 *
 * PERFORMANCE: each feasibility probe uses fastPlace() - ONE deterministic
 * placement pass (area-descending seed order, ZERO GA generations), NOT the full
 * timeBudget GA. Only the FINAL returned result at the solved size is produced by
 * the normal packNest (full GA quality settings). The search is bounded:
 * O(log) probes for fixSheet/locked-axis, O(samples) for none-locked.
 */

import type { Vec2 } from '../../../types/index'
import type { NestPart, NestRequest, NestResult, Placement, Sheet, Spacing } from './types'
import { polygonArea, getPolygonBounds, rotatePolygon } from './geometry'
import { DEFAULT_CURVE_TOLERANCE } from './simplify'
import { validatePlacementSafety } from './placementSafety'
import { spacingProxy } from './proxy'
import { placeParts, sheetRect, transformRing, type PlacementPart, type SheetRect } from './placement'
import { packNest } from './index'
import { ensureEngineClipperReady, intersection } from '../adaptiveClearing2d/engine/clipperEngine'

/** Default angle samples for style 'arbitrary' (mirrors index.ts). */
const DEFAULT_ROTATION_COUNT = 4
/** Candidate widths sampled in the none-locked (min-area) scan. Bounded + fixed
 *  so the scan is deterministic and fast. */
const NONE_LOCKED_WIDTH_SAMPLES = 12
/** A generous free-axis length cap for locked-axis / none-locked probes: the
 *  parts laid end-to-end can never exceed the sum of their extents, doubled for
 *  spacing slack. The binary search shrinks from here. */
const FREE_AXIS_SLACK = 2
/** Tiny pad (mm) added when trimming the none-locked sheet to the measured used
 *  length, so the topmost part is not rejected for sitting exactly ON the sheet
 *  edge (the inner-fit NFP treats an on-boundary pose as non-containing). */
const LENGTH_PAD = 0.5

// ─── instance model (mirrors index.ts packNest, factored for the solver) ─────

interface SolverInstance {
  partId: string
  instanceId: string
  /** spacing-grown outer ring used for placement/clearance */
  grownOuter: Vec2[]
  /** real outline + half the gap the sheet must hold (placement.ts sheetFit) */
  sheetFit: { outer: Vec2[]; pad: number }
  /** allowed insertion angles (style + lock) */
  allowedAngles: number[]
}

/** Allowed insertion angles for a part under the request's style + lock.
 *  Mirrors index.ts allowedAngles (kept local so the solver does not depend on a
 *  non-exported symbol). */
function allowedAngles(part: NestPart, style: NestRequest['style'], rotationCount: number): number[] {
  if (part.lockedRotationDeg !== undefined) {
    return [((part.lockedRotationDeg % 360) + 360) % 360]
  }
  if (style === 'ninety') {
    return [0, 90, 180, 270]
  }
  const n = Math.max(1, rotationCount)
  const angles: number[] = []
  for (let i = 0; i < n; i++) angles.push((i * 360) / n)
  return angles
}

/** Expand a (parts x perPartMultiplier) request into spacing-grown instances.
 *  `multiplier` scales every part's quantity (used by fixSheet's M search). */
function buildInstances(
  req: NestRequest,
  multiplier: number,
  rotationCount: number
): SolverInstance[] {
  const grow = req.spacing.partGap / 2
  const curveTol = req.curveTolerance ?? DEFAULT_CURVE_TOLERANCE
  const instances: SolverInstance[] = []
  for (const entry of req.parts) {
    const { part, quantity } = entry
    // simplify the ORIGINAL ring then grow it (same order + rationale as
    // packNest: simplifying before the exact clipper grow kills the noFitPolygon
    // cost without eroding the partGap clearance). This is the PROXY fed to
    // fastPlace -> noFitPolygon; original geometry is untouched (the solver
    // re-packs final results via packNest, which carries req.curveTolerance
    // through). Small fixtures (<16 verts) are not simplified. The proxy is the
    // SAME one packNest builds (proxy.ts, WO-2480), CCW-normalised for the orbit.
    const grown = spacingProxy(part.outer, grow, curveTol)
    const angles = allowedAngles(part, req.style, rotationCount)
    const total = quantity * multiplier
    for (let q = 0; q < total; q++) {
      instances.push({
        partId: part.id,
        instanceId: `${part.id}#${q}`,
        grownOuter: grown,
        sheetFit: { outer: part.outer, pad: grow },
        allowedAngles: angles,
      })
    }
  }
  return instances
}

/** The largest single-part outer-ring width over all requested parts (used as a
 *  lower bound for the none-locked width scan and a sanity floor elsewhere). */
function maxPartWidth(req: NestRequest, rotationCount: number): number {
  let maxW = 0
  for (const entry of req.parts) {
    const angles = allowedAngles(entry.part, req.style, rotationCount)
    // smallest bounding width achievable across allowed angles (best orientation)
    let bestW = Infinity
    for (const a of angles) {
      const b = getPolygonBounds(rotatePolygon(entry.part.outer, a))
      if (b.width < bestW) bestW = b.width
    }
    if (bestW > maxW) maxW = bestW
  }
  return maxW
}

/** Sum of every requested instance's (best-orientation) bounding width. Upper
 *  bound for the none-locked width scan and the strip-pack free length. */
function sumPartWidths(req: NestRequest, rotationCount: number): number {
  let sum = 0
  for (const entry of req.parts) {
    const angles = allowedAngles(entry.part, req.style, rotationCount)
    let bestW = Infinity
    for (const a of angles) {
      const b = getPolygonBounds(rotatePolygon(entry.part.outer, a))
      if (b.width < bestW) bestW = b.width
    }
    sum += bestW * entry.quantity
  }
  return sum
}

// ─── fast deterministic feasibility probe ────────────────────────────────────

interface FastPlaceResult {
  placed: number
  unplaced: number
  /** placed instances at their poses (margin-frame), for the rare caller that
   *  needs geometry; the solver mostly uses the placed/unplaced counts. */
  placements: Placement[]
}

/**
 * ONE deterministic placement pass onto `sheet` (already margin-shrunk usable
 * size). Uses the SAME area-descending seed order the GA seeds with, at each
 * part's FIRST allowed angle (no rotation search, no GA generations). This is the
 * fast feasibility predicate: it answers "do these instances fit on this sheet"
 * cheaply and deterministically. It is intentionally weaker than packNest's full
 * GA (which the solver runs ONCE at the solved size for the returned result), so
 * a fastPlace "fits" is a sufficient condition the final pack also satisfies.
 */
function fastPlace(
  usableW: number,
  usableH: number,
  margin: number,
  instances: SolverInstance[]
): FastPlaceResult {
  if (usableW <= 0 || usableH <= 0 || instances.length === 0) {
    return {
      placed: 0,
      unplaced: instances.length,
      placements: [],
    }
  }
  const sheet: SheetRect = sheetRect(usableW, usableH)

  // seed order = |area| descending (deterministic; identical to GeneticAlgorithm
  // adam seeding). First allowed angle for each (lock-respecting).
  const ordered = instances
    .slice(0)
    .sort((a, b) => Math.abs(polygonArea(b.grownOuter)) - Math.abs(polygonArea(a.grownOuter)))

  const parts: PlacementPart[] = ordered.map((inst) => ({
    partId: inst.partId,
    instanceId: inst.instanceId,
    outer: inst.grownOuter,
    rotationDeg: inst.allowedAngles[0] ?? 0,
    sheetFit: inst.sheetFit,
  }))

  const res = placeParts(parts, sheet)
  const placements: Placement[] = res.placed.map((p) => ({
    partId: p.partId,
    instanceId: p.instanceId,
    x: p.x + margin,
    y: p.y + margin,
    rotationDeg: p.rotationDeg,
    depth: 0, // solver fast-pass places only on the sheet (no window phase)
  }))
  return {
    placed: res.placed.length,
    unplaced: res.unplaced.length,
    placements,
  }
}

/** True if ALL `instances` fit on the given full sheet (margin applied here). */
function allFit(sheet: Sheet, margin: number, instances: SolverInstance[]): boolean {
  const usableW = sheet.width - 2 * margin
  const usableH = sheet.height - 2 * margin
  const r = fastPlace(usableW, usableH, margin, instances)
  return r.unplaced === 0 && r.placed === instances.length
}

/** Assemble a NestResult from a fast-pass placement on `sheet`. Utilization and
 *  the explicit unplaced report follow the same contract as packNest's
 *  buildResult (ADR 0003: leftovers are named, never silently dropped). Used as
 *  the deterministic fallback when the full-quality packNest at a solved size
 *  underperforms the feasibility probe that justified that size. */
function buildResultFrom(
  req: NestRequest,
  sheet: Sheet,
  instances: SolverInstance[],
  placements: Placement[]
): NestResult {
  const safePlacements = validatePlacementSafety(
    req.parts,
    placements,
    sheet,
    req.spacing.sheetMargin,
  ).placements
  // requested count per partId (to compute leftovers)
  const requested = new Map<string, number>()
  for (const inst of instances) requested.set(inst.partId, (requested.get(inst.partId) ?? 0) + 1)
  const placedByPart = new Map<string, number>()
  for (const p of safePlacements) placedByPart.set(p.partId, (placedByPart.get(p.partId) ?? 0) + 1)

  const unplaced: { partId: string; count: number }[] = []
  for (const [partId, want] of requested) {
    const got = placedByPart.get(partId) ?? 0
    if (want - got > 0) unplaced.push({ partId, count: want - got })
  }
  unplaced.sort((a, b) => (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0))

  const areaByPart = new Map<string, number>()
  for (const entry of req.parts) areaByPart.set(entry.part.id, Math.abs(polygonArea(entry.part.outer)))
  let placedArea = 0
  for (const [partId, count] of placedByPart) placedArea += (areaByPart.get(partId) ?? 0) * count
  const sheetArea = sheet.width * sheet.height
  const utilization = sheetArea > 0 ? placedArea / sheetArea : 0

  return { placements: safePlacements, unplaced, utilization, sheetUsed: sheet }
}

/** Assemble a NestResult by running the deterministic fast pass on `sheet`.
 *  ADR 0003: leftovers are named, never silently dropped. */
function fastResultAt(req: NestRequest, sheet: Sheet, instances: SolverInstance[]): NestResult {
  const margin = req.spacing.sheetMargin
  const r = fastPlace(sheet.width - 2 * margin, sheet.height - 2 * margin, margin, instances)
  return buildResultFrom(req, sheet, instances, r.placements)
}

/**
 * Produce the FINAL result at a solved `sheet`. Runs the full-quality packNest;
 * but because packNest's GA can lay parts out differently than the single-pass
 * feasibility probe that justified this size, it may leave parts unplaced that
 * the probe could place. When that happens, return the deterministic fast-pass
 * result instead (which IS guaranteed to fit at this size) - this is an EXPLICIT
 * choice of the better validated pack, not a silent degradation (ADR 0003). The
 * returned result always reports any genuine leftovers in `unplaced`.
 */
async function finalPack(req: NestRequest, sheet: Sheet, instances: SolverInstance[]): Promise<NestResult> {
  const ga = await packNest({ ...req, sheet })
  const gaUnplaced = ga.unplaced.reduce((n, u) => n + u.count, 0)
  if (gaUnplaced === 0) return ga

  const fast = fastResultAt(req, sheet, instances)
  const fastUnplaced = fast.unplaced.reduce((n, u) => n + u.count, 0)
  // keep whichever validated pack places MORE parts; tie -> the GA (higher quality)
  return fastUnplaced < gaUnplaced ? fast : ga
}

// ─── public solver ───────────────────────────────────────────────────────────

/**
 * Solve req.solver and return a NestResult. Dispatches on req.solver.kind.
 * Async because clipper2-wasm (spacing offsets + the final packNest) must be
 * initialised first. Deterministic for a given req.seed.
 *
 * WO-1827: when `req.commonEdge.enabled` is set, the solved pack then goes
 * through the common-edge post-pass (applyCommonEdges) - adjacent parts whose
 * facing edges are straight and equal-length are pulled together onto ONE cut
 * line, the solver-sized sheet is re-trimmed to the compacted extent, and the
 * shared lines are reported on the result for the emitter (instanceToolpath.ts
 * expandNest) to cut once. With the option absent or disabled the result is
 * byte-identical to before this feature existed.
 */
export async function solveNest(req: CommonEdgeRequest): Promise<CommonEdgeNestResult> {
  await ensureEngineClipperReady()
  const rotationCount = req.rotationCount ?? DEFAULT_ROTATION_COUNT
  const base = await solveObjective(req, rotationCount)
  if (!req.commonEdge?.enabled) return base
  return withCommonEdges(req, base, req.commonEdge)
}

/** The pre-WO-1827 solveNest body: dispatch on req.solver.kind. Split out so the
 *  common-edge post-pass wraps a single, unchanged objective solve. */
async function solveObjective(req: NestRequest, rotationCount: number): Promise<NestResult> {
  switch (req.solver.kind) {
    case 'fixSheet':
      return solveFixSheet(req, rotationCount)
    case 'fixSheetExact':
      // Fixed WxH sheet, EXACT requested quantities: packNest already packs the
      // exact req.parts quantities onto req.sheet and reports leftovers in
      // `unplaced` (ADR 0003). No scaling, no sheet sizing.
      return packNest(req)
    case 'fixQty':
      return req.solver.lockedAxis === 'none'
        ? solveMinArea(req, rotationCount)
        : solveLockedAxis(req, rotationCount, req.solver.lockedAxis)
    case 'fixQtyRatio':
      return solveRatio(req, rotationCount)
  }
}

// ─── mode 1: fixSheet -> max quantity ────────────────────────────────────────

/**
 * Find the maximum multiplier M such that M copies of the requested set all fit
 * on the fixed sheet. Monotonic in M: if M fits, every M' < M fits too. Doubling
 * to bracket an upper bound, then binary search for the boundary.
 */
async function solveFixSheet(req: NestRequest, rotationCount: number): Promise<NestResult> {
  const margin = req.spacing.sheetMargin

  // probe M=1 first: if a single requested set does not fit, there is no
  // positive multiplier. Return the best single-set pack with explicit leftovers
  // (ADR 0003 - never a silent empty success).
  const one = buildInstances(req, 1, rotationCount)
  if (!allFit(req.sheet, margin, one)) {
    // M effectively 0: pack the single set on the fixed sheet for the best
    // partial result, reporting the genuine leftovers.
    return packNest(req)
  }

  // doubling phase: grow M until it no longer fits (or we hit a hard cap to keep
  // the search bounded for pathological tiny parts).
  let lo = 1 // known-fits
  let hi = 2 // candidate that may or may not fit
  const HARD_CAP = 4096
  while (hi <= HARD_CAP && allFit(req.sheet, margin, buildInstances(req, hi, rotationCount))) {
    lo = hi
    hi *= 2
  }

  // binary search the boundary in (lo, hi]: lo fits, hi does not (or hi>cap).
  let bestM = lo
  let high = Math.min(hi, HARD_CAP + 1)
  let low = lo
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (allFit(req.sheet, margin, buildInstances(req, mid, rotationCount))) {
      low = mid
      bestM = mid
    } else {
      high = mid
    }
  }

  // FINAL result at the solved multiplier uses the full-quality packNest so the
  // returned placements match production packing; finalPack falls back to the
  // validated fast pack if the GA underperforms the probe at this size.
  const solvedReq: NestRequest = {
    ...req,
    parts: req.parts.map((e) => ({ part: e.part, quantity: e.quantity * bestM })),
  }
  const solvedInstances = buildInstances(solvedReq, 1, rotationCount)
  return finalPack(solvedReq, req.sheet, solvedInstances)
}

// ─── mode 2: fixQty + locked axis -> min sheet (one axis free) ───────────────

/**
 * Minimise the FREE sheet axis with the other axis locked to req.sheet. Binary-
 * search the free length for the smallest value at which all requested parts fit.
 * Returns the solved sheet + a full-quality pack at that size.
 */
async function solveLockedAxis(
  req: NestRequest,
  rotationCount: number,
  lockedAxis: 'width' | 'height'
): Promise<NestResult> {
  const margin = req.spacing.sheetMargin
  const instances = buildInstances(req, 1, rotationCount)

  const lockedW = lockedAxis === 'width'
  const lockedDim = lockedW ? req.sheet.width : req.sheet.height

  // build a candidate sheet with the locked dim fixed and the free dim = `free`.
  const mk = (free: number): Sheet =>
    lockedW ? { width: lockedDim, height: free } : { width: free, height: lockedDim }

  // upper bound for the free axis: parts laid out single-file can never need more
  // than (sum of widths) + per-part spacing + 2*margin, with slack. This is a
  // generous, deterministic cap that is guaranteed to fit if anything can on the
  // locked width.
  const totalWidth = sumPartWidths(req, rotationCount)
  const totalGap = req.spacing.partGap * req.parts.reduce((n, e) => n + e.quantity, 0)
  let hi = (totalWidth + totalGap) * FREE_AXIS_SLACK + 2 * margin

  // feasibility floor: if even the generous upper bound cannot place all parts
  // (e.g. a part is wider than the locked dimension), the request is impossible
  // on this locked axis. Report it EXPLICITLY (ADR 0003) by returning a pack on
  // the largest candidate so leftovers surface; never a silent empty success.
  if (!allFit(mk(hi), margin, instances)) {
    return finalPack(req, mk(hi), instances)
  }

  // lower bound: the free axis must be at least the largest single-part extent
  // (a part cannot fit in a sheet narrower than itself) plus the margins.
  let lo = Math.max(maxPartWidth(req, rotationCount), 0) + 2 * margin
  if (lo >= hi) lo = hi / 2 // degenerate guard; hi is known-feasible

  // binary search to a tolerance: shrink the free dim while all parts still fit.
  const TOL = 0.5 // mm - finer than any realistic kerf; bounded probe count
  let bestFree = hi
  while (hi - lo > TOL) {
    const mid = (lo + hi) / 2
    if (allFit(mk(mid), margin, instances)) {
      hi = mid
      bestFree = mid
    } else {
      lo = mid
    }
  }

  return finalPack(req, mk(bestFree), instances)
}

// ─── mode 2b: fixQtyRatio -> min sheet at a FIXED aspect ratio ───────────────

/**
 * Minimise a sheet of FIXED ASPECT RATIO that holds the EXACT requested
 * quantities. The sheet is parameterised by its WIDTH w; its height is w * r
 * where r = req.solver.ratio (height / width). Because growing w grows BOTH
 * dimensions, feasibility is monotonic in w: if w fits, every w' > w fits too.
 *
 *   - Lower bound: the sheet can be no narrower than the widest part AND no
 *     shorter than the tallest part. Translate the height floor into a width
 *     floor via the ratio (w >= floorH / r), take the max, add the margins.
 *   - Upper bound: double w from the lower bound until all parts fit (bounded by
 *     a hard cap so a pathological ratio cannot loop forever). If even the cap
 *     does not fit, the request is impossible at this ratio -> pack at the cap so
 *     leftovers surface EXPLICITLY (ADR 0003), never a silent empty success.
 *   - Binary-search the smallest w in (lo, hi] at which all parts still fit.
 *
 * Final result = full-quality packNest at the solved sheet (finalPack), so the
 * returned placements match production. Deterministic for req.seed: every probe
 * and the final pack are seeded the same way, and the search is a pure function
 * of the (bounded) candidate widths.
 *
 * INVALID RATIO (non-finite or <= 0): fall back to the free-aspect min-area
 * solve and log a NAMED ADR-0003 warning that the ratio was invalid (rather than
 * silently producing a wrong-shaped sheet).
 */
async function solveRatio(req: NestRequest, rotationCount: number): Promise<NestResult> {
  const r = (req.solver as { kind: 'fixQtyRatio'; ratio: number }).ratio
  if (!Number.isFinite(r) || r <= 0) {
    // ADR 0003: name the fallback + why, never silently misshape the sheet.
    console.warn(
      `nesting solver: fixQtyRatio given an invalid ratio (${r}); ` +
        'falling back to free-aspect min-area solve (ADR 0003).',
    )
    return solveMinArea(req, rotationCount)
  }

  const margin = req.spacing.sheetMargin
  const instances = buildInstances(req, 1, rotationCount)

  // sheet of width w, height w*r (ratio = height/width).
  const mk = (w: number): Sheet => ({ width: w, height: w * r })

  // width floor: at least the widest part, AND wide enough that the height
  // (w*r) clears the tallest part -> w >= maxPartWidth and w >= maxPartWidth/r
  // (parts are square-bounded by maxPartWidth here for the floor estimate),
  // plus the margins on both axes mapped back through the ratio.
  const maxW = maxPartWidth(req, rotationCount)
  const widthFloorFromW = maxW + 2 * margin
  const widthFloorFromH = (maxW + 2 * margin) / r
  let lo = Math.max(widthFloorFromW, widthFloorFromH, 1e-6)

  // doubling phase: grow w until all parts fit (or hit a hard cap so a tiny /
  // pathological ratio cannot loop forever). HARD_CAP is a generous absolute
  // width ceiling vs the single-file extent.
  const totalWidth = sumPartWidths(req, rotationCount)
  const totalGap = req.spacing.partGap * req.parts.reduce((n, e) => n + e.quantity, 0)
  const HARD_CAP = (totalWidth + totalGap) * FREE_AXIS_SLACK + 2 * margin + maxW
  let hi = lo
  let fits = allFit(mk(hi), margin, instances)
  while (!fits && hi < HARD_CAP) {
    lo = hi
    hi = Math.min(hi * 2, HARD_CAP)
    fits = allFit(mk(hi), margin, instances)
    if (hi >= HARD_CAP) break
  }

  // impossible at this ratio even at the cap: surface leftovers EXPLICITLY
  // (ADR 0003) by packing at the largest candidate, never a silent empty success.
  if (!allFit(mk(hi), margin, instances)) {
    return finalPack(req, mk(hi), instances)
  }

  // binary search the smallest feasible w in (lo, hi]: lo may not fit, hi fits.
  const TOL = 0.5 // mm - finer than any realistic kerf; bounded probe count
  let bestW = hi
  let low = lo
  let high = hi
  while (high - low > TOL) {
    const mid = (low + high) / 2
    if (allFit(mk(mid), margin, instances)) {
      high = mid
      bestW = mid
    } else {
      low = mid
    }
  }

  return finalPack(req, mk(bestW), instances)
}

// ─── mode 3: fixQty + lockedAxis 'none' -> min area (both free) ───────────────

/**
 * Both axes free: minimise sheet AREA. Deterministic bounded strategy:
 *
 *   - Derive a candidate WIDTH set: NONE_LOCKED_WIDTH_SAMPLES evenly-spaced
 *     widths from the largest single-part width (a hard lower bound - the sheet
 *     can be no narrower than the widest part) up to the sum of all part widths
 *     (laying every part side-by-side in a single row). This range is bounded by
 *     part extents and the sample count is fixed -> deterministic + fast.
 *   - For each candidate width, strip-pack with a generous free LENGTH (the
 *     same single-file upper bound used by the locked-axis solver), then measure
 *     the actually-used length (max Y extent of the placed parts) and the area
 *     (width x usedLength). A candidate is valid only if ALL parts placed.
 *   - Return the valid candidate of MINIMUM area, packed full-quality at its
 *     (width x usedLength). This is a sanity-optimal heuristic, not a proven
 *     optimum (the plan specifies "<= a generous upper bound").
 *
 * If NO candidate width fits all parts, the request is impossible; report it
 * EXPLICITLY (ADR 0003) via a pack on the widest/longest candidate so leftovers
 * surface - never a silent empty success.
 */
async function solveMinArea(req: NestRequest, rotationCount: number): Promise<NestResult> {
  const margin = req.spacing.sheetMargin
  const instances = buildInstances(req, 1, rotationCount)

  const minW = maxPartWidth(req, rotationCount)
  const maxW = Math.max(sumPartWidths(req, rotationCount), minW)

  const totalWidth = sumPartWidths(req, rotationCount)
  const totalGap = req.spacing.partGap * req.parts.reduce((n, e) => n + e.quantity, 0)
  // generous free length so every candidate width has room to strip-pack.
  const freeLen = (totalWidth + totalGap) * FREE_AXIS_SLACK + 2 * margin

  interface Candidate {
    width: number
    usedLength: number
    area: number
    /** the VALIDATED fast-pass placements at this (width x freeLen) - retained so
     *  the final result reuses this exact layout rather than re-packing (the GA
     *  packs a tall single column poorly; reusing the validated layout is the
     *  guarantee the parts fit at the trimmed size). */
    placements: Placement[]
  }
  let best: Candidate | null = null

  const n: number = NONE_LOCKED_WIDTH_SAMPLES
  for (let i = 0; i < n; i++) {
    // candidate widths from minW..maxW inclusive (deterministic samples).
    const t = n === 1 ? 1 : i / (n - 1)
    const candW = minW + (maxW - minW) * t + 2 * margin
    const sheet: Sheet = { width: candW, height: freeLen }

    const usableW = sheet.width - 2 * margin
    const usableH = sheet.height - 2 * margin
    const r = fastPlace(usableW, usableH, margin, instances)
    if (r.unplaced !== 0 || r.placed !== instances.length) continue

    // used length = max Y over all placed (full-sheet-frame) ring vertices.
    let maxY = 0
    for (const p of r.placements) {
      const src = req.parts.find((e) => e.part.id === p.partId)!.part
      const ring = rotatePolygon(src.outer, p.rotationDeg)
      for (const v of ring) {
        const wy = v.y + p.y
        if (wy > maxY) maxY = wy
      }
    }
    // include the far keep-out margin, plus a tiny pad so the trimmed sheet still
    // strictly CONTAINS the topmost part (the inner-fit NFP treats an on-edge
    // pose as non-containing - matters for the geometric-containment gate).
    const usedLength = maxY + margin + LENGTH_PAD
    const area = candW * usedLength
    if (best === null || area < best.area) {
      best = { width: candW, usedLength, area, placements: r.placements }
    }
  }

  if (best === null) {
    // impossible: nothing placed all parts. Surface leftovers explicitly via the
    // fast pass on the widest/longest candidate (ADR 0003 - no silent success).
    const sheet: Sheet = { width: maxW + 2 * margin, height: freeLen }
    return fastResultAt(req, sheet, instances)
  }

  // Build the result from the VALIDATED fast-pass layout at the trimmed sheet.
  // The placements were proven to fit (all instances placed) and every vertex is
  // within usedLength, so this layout is feasible by construction. We do NOT
  // re-run packNest here: its GA strip-packs a narrow tall sheet poorly and would
  // under-place. (The fixSheet / locked-axis modes DO use packNest via finalPack,
  // which falls back to the fast pack only on GA shortfall.)
  const solvedSheet: Sheet = { width: best.width, height: best.usedLength }
  return buildResultFrom(req, solvedSheet, instances, best.placements)
}


// --- WO-1827: common-edge (shared cut line) nesting -------------------------
/*
 * Two nested parts placed edge-to-edge are normally separated by a kerf gap and
 * cut twice - once per owner. Common-edge nesting pulls such a pair together so
 * their facing edges COINCIDE, and the resulting line belongs to BOTH parts: the
 * sheet still falls apart into correct parts, but the material between them and
 * the second cut of that line are both saved.
 *
 * THE HONEST CONSTRAINT (WO-1827 acceptance): only a pair of STRAIGHT, EQUAL-
 * LENGTH, anti-parallel facing edges may share. Anything else - a curve, a
 * partially-overlapping straight run, edges offset ALONG their own direction, a
 * pair further apart than the requested partGap - keeps normal kerf spacing.
 * That is deliberately conservative: a partial share leaves an under-defined
 * stub of one of the two profiles, and there is no honest way to decide which
 * owner should cut it.
 *
 * WHAT MOVES. Adjacency is decided on the ORIGINAL pack (a pair is a candidate
 * only if its facing edges are already within partGap), but the translation is
 * applied to a rigid CLUSTER via union-find, so a whole column compacts: pulling
 * B onto A leaves C two gaps away from B, and C is then moved by that full
 * amount rather than rejected for "moving too far". Every move is validated
 * against the other clusters (no positive-area overlap) and the usable sheet
 * before it is applied; a move that would not validate is dropped and that pair
 * simply keeps its kerf (ADR 0003 - the refusal is visible, never silent: the
 * pair is absent from `sharedEdges`, so nothing downstream skips a cut for it).
 *
 * WHAT IS REPORTED. `sharedEdges` carries each shared line in NEST-SHEET
 * coordinates plus BOTH owning instanceIds; `excluded` names every part that
 * could not share and why. The emitter (instanceToolpath.ts expandNest) matches
 * those lines against the real move stream by geometry, so a WRONG ownership
 * claim cannot remove a cut that a part actually needs.
 */

/** Request-level switch for common-edge nesting. Additive + optional: a request
 *  without it behaves exactly as it did before WO-1827. */
export interface CommonEdgeOptions {
  /** Off by default. */
  enabled: boolean
  /** Geometric match tolerance (mm) for "straight, equal-length, coincident".
   *  Defaults to DEFAULT_COMMON_EDGE_TOLERANCE. */
  tolerance?: number
  /** Parts the CALLER knows must not share a cut line - a tolerance-critical or
   *  finish-critical profile. Named here, reported in `excluded`, never silently
   *  spaced (WO-1827 acceptance 4). */
  excludePartIds?: string[]
}

/** A NestRequest that may carry the common-edge option. */
export type CommonEdgeRequest = NestRequest & { commonEdge?: CommonEdgeOptions }

/** One cut line owned by exactly two placed copies. Coordinates are in the same
 *  sheet frame as Placement.x / Placement.y. */
export interface SharedCutEdge {
  a: Vec2
  b: Vec2
  length: number
  /** the two owning instanceIds, ascending (stable) */
  owners: [string, string]
  /** their partIds, in the same order as `owners` */
  ownerPartIds: [string, string]
}

/** A part that cannot share a cut line, named with the reason. */
export interface CommonEdgeExclusion {
  partId: string
  reason: string
}

/** solveNest's result, plus the common-edge report when the option is on. Both
 *  extra fields are absent when it is off, so existing consumers are untouched. */
export type CommonEdgeNestResult = NestResult & {
  sharedEdges?: SharedCutEdge[]
  commonEdgeExcluded?: CommonEdgeExclusion[]
}

/** applyCommonEdges' return: the compacted pack plus its full report. */
export interface CommonEdgeReport {
  placements: Placement[]
  sharedEdges: SharedCutEdge[]
  excluded: CommonEdgeExclusion[]
}

/** Match tolerance (mm) for edge length, coincidence and the along-edge offset.
 *
 *  ONE MICRON, deliberately. The packer's own poses carry float dust: on the
 *  WO-1827 fixture grid two vertically-stacked squares came out of packNest with
 *  their x differing by 1.46e-5 mm, which at a 1e-6 tolerance refused a share
 *  between two edges that are physically identical (LIENCAM.md rule 11 - the
 *  software refuses only what it CANNOT do). 1e-3 mm is still 10x finer than the
 *  project's standing 0.01 mm clearance tolerance (placementSafety.ts
 *  CLEARANCE_TOLERANCE), so it cannot mask a gap anything downstream cares
 *  about, and the accepted translation removes the offset exactly anyway: after
 *  the move the two edges coincide to float precision, not to this tolerance. */
export const DEFAULT_COMMON_EDGE_TOLERANCE = 1e-3
/** Anti-parallel test slack on the unit-direction dot product. rotatePolygon's
 *  cos/sin round-trip leaves float dust here; 1e-7 is that dust, not geometry. */
const COMMON_EDGE_ANGLE_EPSILON = 1e-7
/** A clipper intersection smaller than this is contact, not overlap (mirrors
 *  placementSafety.ts AREA_EPSILON). Contact is exactly what sharing produces. */
const COMMON_EDGE_OVERLAP_AREA_EPSILON = 1e-8
/** Sheet-containment slack (mirrors placementSafety.ts BOUNDS_EPSILON). */
const COMMON_EDGE_BOUNDS_EPSILON = 1e-6

/** True when two rings share positive AREA. Contact along an edge is zero area
 *  and must NOT count - it is the thing common-edge nesting creates. */
function hasAreaOverlap(a: Vec2[], b: Vec2[]): boolean {
  if (a.length < 3 || b.length < 3) return false
  return intersection([a], [b]).some(
    (loop) => Math.abs(polygonArea(loop)) > COMMON_EDGE_OVERLAP_AREA_EPSILON,
  )
}

/** Every ring vertex inside the usable (margin-shrunk) sheet. */
function ringInsideUsableSheet(ring: Vec2[], sheet: Sheet, margin: number): boolean {
  const minX = margin - COMMON_EDGE_BOUNDS_EPSILON
  const minY = margin - COMMON_EDGE_BOUNDS_EPSILON
  const maxX = sheet.width - margin + COMMON_EDGE_BOUNDS_EPSILON
  const maxY = sheet.height - margin + COMMON_EDGE_BOUNDS_EPSILON
  return ring.every((p) => p.x >= minX && p.y >= minY && p.x <= maxX && p.y <= maxY)
}

interface EdgeMatch {
  ei: number
  ej: number
}

/**
 * The FIRST (lowest edge indices, so deterministic) pair of facing edges on two
 * world rings that may share a cut line:
 *
 *   - both straight segments of EQUAL length (|L1 - L2| <= tol),
 *   - ANTI-parallel (unit directions dot to -1): two CCW rings meeting face to
 *     face always run their shared edge in opposite directions,
 *   - separated by a PURE PERPENDICULAR offset (no slide along the edge), so the
 *     two segments coincide exactly once moved - a partial overlap is refused,
 *   - no further apart than `maxGap` (the requested partGap): a candidate must
 *     already be a kerf-spaced neighbour, never a part fetched from across the
 *     sheet.
 */
function firstMatchingEdgePair(
  A: Vec2[],
  B: Vec2[],
  maxGap: number,
  tol: number,
): EdgeMatch | null {
  for (let ei = 0; ei < A.length; ei++) {
    const a1 = A[ei]
    const b1 = A[(ei + 1) % A.length]
    const l1 = Math.hypot(b1.x - a1.x, b1.y - a1.y)
    if (l1 <= tol) continue
    const d1 = { x: (b1.x - a1.x) / l1, y: (b1.y - a1.y) / l1 }
    for (let ej = 0; ej < B.length; ej++) {
      const a2 = B[ej]
      const b2 = B[(ej + 1) % B.length]
      const l2 = Math.hypot(b2.x - a2.x, b2.y - a2.y)
      if (l2 <= tol) continue
      if (Math.abs(l1 - l2) > tol) continue
      const d2 = { x: (b2.x - a2.x) / l2, y: (b2.y - a2.y) / l2 }
      if (d1.x * d2.x + d1.y * d2.y > -1 + COMMON_EDGE_ANGLE_EPSILON) continue
      // Translation that lands B's edge exactly on A's. Equal length plus anti-
      // parallel makes these two expressions algebraically identical; both are
      // computed so float drift between them is caught rather than assumed away.
      const t1 = { x: a1.x - b2.x, y: a1.y - b2.y }
      const t2 = { x: b1.x - a2.x, y: b1.y - a2.y }
      if (Math.hypot(t1.x - t2.x, t1.y - t2.y) > tol) continue
      const t = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 }
      // Pure perpendicular: any along-edge component means the two segments only
      // partially overlap, which would leave an under-defined stub of a profile.
      if (Math.abs(t.x * d1.x + t.y * d1.y) > tol) continue
      if (Math.hypot(t.x, t.y) > maxGap + tol) continue
      return { ei, ej }
    }
  }
  return null
}

/**
 * Compact a solved pack onto shared cut lines. Deterministic: the working order
 * is instanceId ascending, candidates are scanned in that order, and every
 * accepted move is a rigid translation of one union-find cluster.
 *
 * PRECONDITION: the clipper engine must be initialised (ensureEngineClipperReady)
 * - the overlap validation goes through it, exactly as placementSafety.ts does.
 * solveNest already awaits that before it gets here; a direct caller must too.
 *
 * Returns the (possibly moved) placements in the SAME order they arrived, the
 * shared lines in final sheet coordinates, and every part excluded from sharing
 * named with its reason.
 */
export function applyCommonEdges(
  parts: readonly { part: NestPart }[],
  placements: readonly Placement[],
  spacing: Spacing,
  sheet: Sheet,
  options: CommonEdgeOptions,
): CommonEdgeReport {
  const tol = options.tolerance ?? DEFAULT_COMMON_EDGE_TOLERANCE
  const partById = new Map(parts.map((e) => [e.part.id, e.part]))
  const excludedByName = new Set(options.excludePartIds ?? [])

  // -- eligibility, named (WO-1827 acceptance 4) ----------------------------
  const excluded: CommonEdgeExclusion[] = []
  const eligible = new Map<string, boolean>()
  for (const entry of parts) {
    const part = entry.part
    let reason: string | null = null
    if (excludedByName.has(part.id)) {
      reason =
        'named by the caller as unable to share a cut line (tolerance or finish critical)'
    } else if (part.outer.length < 3) {
      reason = 'open contour: the outer ring has fewer than 3 vertices'
    } else if (Math.abs(polygonArea(part.outer)) <= tol) {
      reason = 'open contour: the outer ring encloses no area'
    }
    eligible.set(part.id, reason === null)
    if (reason !== null) excluded.push({ partId: part.id, reason })
  }
  excluded.sort((a, b) => (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0))

  const work = [...placements].sort((a, b) =>
    a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0,
  )
  const poses = work.map((p) => ({ ...p }))
  const rings = poses.map((p) => {
    const src = partById.get(p.partId)
    return src ? transformRing(src.outer, p.rotationDeg, p.x, p.y) : []
  })
  // Adjacency is judged on the ORIGINAL pack, so a chain does not disqualify
  // itself as its head compacts (see the section header).
  const originalRings = rings.map((r) => r.map((v) => ({ ...v })))
  // depth-1 window children are placed by their host's own containment gate and
  // are out of scope for v1 sharing (WO-1827 "Out of scope"): they stay put.
  const shareable = poses.map(
    (p, k) => p.depth === 0 && (eligible.get(p.partId) ?? false) && rings[k].length >= 3,
  )

  interface Candidate {
    i: number
    j: number
    ei: number
    ej: number
  }
  const candidates: Candidate[] = []
  for (let i = 0; i < poses.length; i++) {
    if (!shareable[i]) continue
    for (let j = i + 1; j < poses.length; j++) {
      if (!shareable[j]) continue
      const m = firstMatchingEdgePair(originalRings[i], originalRings[j], spacing.partGap, tol)
      if (m) candidates.push({ i, j, ei: m.ei, ej: m.ej })
    }
  }

  // union-find over clusters that have already been welded together
  const parent = poses.map((_, k) => k)
  const find = (k: number): number => {
    let root = k
    while (parent[root] !== root) root = parent[root]
    let walk = k
    while (parent[walk] !== root) {
      const next = parent[walk]
      parent[walk] = root
      walk = next
    }
    return root
  }

  const accepted: { i: number; j: number; ei: number }[] = []
  for (const c of candidates) {
    const A = rings[c.i]
    const B = rings[c.j]
    const a1 = A[c.ei]
    const b2 = B[(c.ej + 1) % B.length]
    // Clusters only ever translate, so the two edges stay equal-length and anti-
    // parallel; only the offset between them changes.
    const t = { x: a1.x - b2.x, y: a1.y - b2.y }
    const gap = Math.hypot(t.x, t.y)
    const ri = find(c.i)
    const rj = find(c.j)

    if (gap <= tol) {
      // already coincident - a free share, nothing to move.
      if (ri !== rj) parent[rj] = ri
      accepted.push({ i: c.i, j: c.j, ei: c.ei })
      continue
    }
    if (ri === rj) {
      // Same rigid cluster and the edges do NOT coincide: welding them would
      // need a non-rigid deformation. Keep the kerf, claim nothing.
      continue
    }

    const members: number[] = []
    for (let k = 0; k < poses.length; k++) if (find(k) === rj) members.push(k)
    const moved = members.map((k) => rings[k].map((v) => ({ x: v.x + t.x, y: v.y + t.y })))
    const memberSet = new Set(members)

    let ok = true
    for (const ring of moved) {
      if (!ringInsideUsableSheet(ring, sheet, spacing.sheetMargin)) {
        ok = false
        break
      }
    }
    if (ok) {
      scan: for (let m = 0; m < members.length; m++) {
        for (let k = 0; k < poses.length; k++) {
          if (memberSet.has(k)) continue
          if (hasAreaOverlap(moved[m], rings[k])) {
            ok = false
            break scan
          }
        }
      }
    }
    if (!ok) continue // this pair keeps its kerf; it is absent from sharedEdges

    members.forEach((k, m) => {
      poses[k] = { ...poses[k], x: poses[k].x + t.x, y: poses[k].y + t.y }
      rings[k] = moved[m]
    })
    parent[rj] = ri
    accepted.push({ i: c.i, j: c.j, ei: c.ei })
  }

  // Final coordinates: a line recorded early may have been carried along by a
  // later cluster move, so every edge is resolved from the FINAL rings.
  const sharedEdges: SharedCutEdge[] = accepted.map(({ i, j, ei }) => {
    const A = rings[i]
    const a = { ...A[ei] }
    const b = { ...A[(ei + 1) % A.length] }
    const iFirst = poses[i].instanceId <= poses[j].instanceId
    const owners: [string, string] = iFirst
      ? [poses[i].instanceId, poses[j].instanceId]
      : [poses[j].instanceId, poses[i].instanceId]
    const ownerPartIds: [string, string] = iFirst
      ? [poses[i].partId, poses[j].partId]
      : [poses[j].partId, poses[i].partId]
    return { a, b, length: Math.hypot(b.x - a.x, b.y - a.y), owners, ownerPartIds }
  })

  const byInstance = new Map(poses.map((p) => [p.instanceId, p]))
  return {
    placements: placements.map((p) => byInstance.get(p.instanceId) ?? { ...p }),
    sharedEdges,
    excluded,
  }
}

/**
 * Independent check that a set of shared cut lines is REAL, for the fixture grid
 * and for any caller that did not produce them itself. A "wrong share" - a line
 * claimed between parts that do not actually meet along it - fails here BY NAME:
 *
 *   - both owners must exist,
 *   - each owner's transformed ring must genuinely carry that segment as one of
 *     its own edges (either direction),
 *   - the two owners must touch, not overlap (positive shared area is a stacked
 *     pack, not a shared cut line).
 */
export function verifyCommonEdges(
  parts: readonly { part: NestPart }[],
  placements: readonly Placement[],
  edges: readonly SharedCutEdge[],
  tolerance = DEFAULT_COMMON_EDGE_TOLERANCE,
): { ok: boolean; problems: string[] } {
  const partById = new Map(parts.map((e) => [e.part.id, e.part]))
  const byInstance = new Map(placements.map((p) => [p.instanceId, p]))
  const problems: string[] = []
  const ringFor = (instanceId: string): Vec2[] | null => {
    const p = byInstance.get(instanceId)
    if (!p) return null
    const src = partById.get(p.partId)
    if (!src) return null
    return transformRing(src.outer, p.rotationDeg, p.x, p.y)
  }
  const carriesEdge = (ring: Vec2[], a: Vec2, b: Vec2): boolean => {
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]
      const q = ring[(k + 1) % ring.length]
      const fwd =
        Math.hypot(p.x - a.x, p.y - a.y) <= tolerance &&
        Math.hypot(q.x - b.x, q.y - b.y) <= tolerance
      const rev =
        Math.hypot(p.x - b.x, p.y - b.y) <= tolerance &&
        Math.hypot(q.x - a.x, q.y - a.y) <= tolerance
      if (fwd || rev) return true
    }
    return false
  }

  edges.forEach((edge, index) => {
    const label = `shared edge ${index} (${edge.owners[0]} + ${edge.owners[1]})`
    if (edge.owners[0] === edge.owners[1]) {
      problems.push(`${label}: both owners are the same copy`)
      return
    }
    if (Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y) <= tolerance) {
      problems.push(`${label}: zero-length cut line`)
      return
    }
    const owned = edge.owners.map((id) => ({ id, ring: ringFor(id) }))
    for (const { id, ring } of owned) {
      if (ring === null) {
        problems.push(`${label}: owner ${id} is not a placed copy of a known part`)
        return
      }
      if (!carriesEdge(ring, edge.a, edge.b)) {
        problems.push(
          `${label}: owner ${id} has no edge on that line - the two parts do not meet there`,
        )
      }
    }
    const ringA = owned[0].ring as Vec2[]
    const ringB = owned[1].ring as Vec2[]
    if (hasAreaOverlap(ringA, ringB)) {
      problems.push(
        `${label}: the two owners overlap by area - stacked parts, not a shared cut line`,
      )
    }
  })

  return { ok: problems.length === 0, problems }
}

/** Total area of the placed parts (used for the post-compaction utilization). */
function placedPartArea(
  parts: readonly { part: NestPart }[],
  placements: readonly Placement[],
): number {
  const areaByPart = new Map(parts.map((e) => [e.part.id, Math.abs(polygonArea(e.part.outer))]))
  let total = 0
  for (const p of placements) total += areaByPart.get(p.partId) ?? 0
  return total
}

/**
 * Re-trim a SOLVER-SIZED sheet to the compacted extent. This is where the saved
 * material actually appears: the same parts now occupy less of the free axis, so
 * the sheet the solver reports shrinks with them. A FIXED sheet (fixSheet /
 * fixSheetExact) is the operator's stock and is never resized; the saving there
 * is the cut length, plus the room a later solve can fill.
 *
 * Never grows: each axis is the min of the trimmed value and what the base solve
 * produced, so this can only ever report LESS material than before.
 */
function trimSheetToCompactedExtent(
  req: NestRequest,
  base: Sheet,
  placements: readonly Placement[],
  parts: readonly { part: NestPart }[],
): Sheet {
  if (req.solver.kind === 'fixSheet' || req.solver.kind === 'fixSheetExact') return base
  const partById = new Map(parts.map((e) => [e.part.id, e.part]))
  let maxX = 0
  let maxY = 0
  for (const p of placements) {
    const src = partById.get(p.partId)
    if (!src) continue
    for (const v of transformRing(src.outer, p.rotationDeg, p.x, p.y)) {
      if (v.x > maxX) maxX = v.x
      if (v.y > maxY) maxY = v.y
    }
  }
  if (maxX <= 0 || maxY <= 0) return base
  const pad = req.spacing.sheetMargin + LENGTH_PAD
  const needW = maxX + pad
  const needH = maxY + pad
  if (req.solver.kind === 'fixQtyRatio') {
    const r = req.solver.ratio
    if (!Number.isFinite(r) || r <= 0) return base
    const w = Math.min(base.width, Math.max(needW, needH / r))
    return { width: w, height: w * r }
  }
  const locked = req.solver.lockedAxis
  return {
    width: locked === 'width' ? base.width : Math.min(base.width, needW),
    height: locked === 'height' ? base.height : Math.min(base.height, needH),
  }
}

/** Run the common-edge post-pass over a solved result and report it. */
function withCommonEdges(
  req: NestRequest,
  base: NestResult,
  options: CommonEdgeOptions,
): CommonEdgeNestResult {
  const report = applyCommonEdges(req.parts, base.placements, req.spacing, base.sheetUsed, options)
  const sheetUsed = trimSheetToCompactedExtent(req, base.sheetUsed, report.placements, req.parts)
  const sheetArea = sheetUsed.width * sheetUsed.height
  const utilization = sheetArea > 0 ? placedPartArea(req.parts, report.placements) / sheetArea : 0
  return {
    ...base,
    placements: report.placements,
    sheetUsed,
    utilization,
    sharedEdges: report.sharedEdges,
    commonEdgeExcluded: report.excluded,
  }
}

// re-export so callers can probe feasibility deterministically if needed.
export { fastPlace }
