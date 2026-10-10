/* Nesting engine - public API surface.
 *
 * P1.2 packer (NESTING-P1-ENGINE-PLAN.md): packNest expands the request into an
 * instance set, applies spacing clearances ONCE up front, then runs a SEEDED
 * genetic algorithm (ga.ts) whose genes are scored by the placement worker
 * (placement.ts: inner-fit containment + NFP-difference feasible region +
 * gravity/min-bounding rule). The single fixed sheet is packed (req.solver is
 * consumed in P1.3; here it is treated as fixSheet onto req.sheet). Leftovers
 * are reported in NestResult.unplaced EXPLICITLY (ADR 0003 - no silent drops).
 *
 * Determinism: ALL randomness flows from one mulberry32 seeded by req.seed
 * (rng.ts); identical input => byte-identical placements across runs.
 */

export type {
  NestPart,
  Placement,
  Sheet,
  NestStyle,
  Spacing,
  LockedAxis,
  SolverMode,
  NestRequest,
  NestResult,
} from './types'

export { mulberry32 } from './rng'
export { placeParts, sheetRect, transformRing, NfpBudget } from './placement'
// PlacementPart is part of placeParts's public signature (search-budget.test.ts imports it);
// the R1 branch omitted the re-export and vitest's transpile-only run never noticed --
// caught by the mandatory post-merge build (Architect fix-forward 2026-07-08).
export type { PlacementPart } from './placement'
export { GeneticAlgorithm } from './ga'
export { solveNest } from './solver'

import type { Vec2 } from '../../../types/index'
import type { NestRequest, NestResult, Placement, NestPart } from './types'
import { mulberry32 } from './rng'
import { polygonArea, getPolygonBounds, rotatePolygon } from './geometry'
import { ensureCCW } from '../geometry'
import { noFitPolygon } from './nfp'
import { GeneticAlgorithm, type GaPart, type Individual } from './ga'
import { solveNest } from './solver'
import { simplifyRing, DEFAULT_CURVE_TOLERANCE } from './simplify'
import { validatePlacementSafety } from './placementSafety'
import { spacingProxy } from './proxy'
import {
  placeParts,
  sheetRect,
  transformRing,
  NfpBudget,
  type NfpCache,
  type PlacementPart,
  type SheetRect,
} from './placement'
import {
  ensureEngineClipperReady,
  offsetClosed,
  union,
  difference,
} from '../adaptiveClearing2d/engine/clipperEngine'

/** Default number of evenly-spaced angles for style 'arbitrary' when the request
 *  omits rotationCount (a sane, fast default). */
const DEFAULT_ROTATION_COUNT = 4
/** Default GA population size (SVGnest default). */
const DEFAULT_POPULATION = 10
/** Default per-gene mutation percent (SVGnest default). */
const DEFAULT_MUTATION_RATE = 10
/** Generation cap: an upper bound on GA generations, always input-independent
 *  and never wall-clock. This alone is NOT sufficient to bound dense-part
 *  runtime (a fixed generation count still runs every evaluation inside it
 *  unconditionally) - see DEFAULT_SEARCH_BUDGET, the deterministic cost bound
 *  that actually replaces the removed wall-clock bailout (BK-7 / INT-H1-R1). */
const DEFAULT_GENERATION_CAP = 8
/** Default NfpBudget total (placement.ts) when req.searchBudget is omitted -
 *  a FLOOR since WO-2480: packNest raises it to one full placement pass when
 *  that costs more (fullPassCost), so the default never ends the first pass.
 *  Calibrated empirically (INT-H1-R1 R1.1, see the report for the measured
 *  sweep): every committed regression fixture's exact outcome (placed count,
 *  utilization, "all placed"/unplaced==[] assertions) is IDENTICAL from
 *  30,000 units up through 300,000+ - these fixtures' seeded "adam" (area-
 *  descending, unmutated) individual already reaches the best fitness the
 *  search ever finds, so `best` locks onto it on the very first evaluation
 *  and later generations never improve on it. 100,000 keeps a wide margin
 *  above that floor (no committed fixture regresses) while bounding a real
 *  dense part (BMG.dxf x12, ~50-vertex simplified rings, perf.test.ts) to a
 *  handful of evaluations - measured ~4s isolated, comparable to the ~3s the
 *  OLD wall-clock default produced for the same fixture, instead of the
 *  >120s the unbounded generation-cap-only code took (BK-7 audit blocker). */
const DEFAULT_SEARCH_BUDGET = 100_000

/** Allowed insertion angles for a part under the request's style + lock. */
function allowedAngles(part: NestPart, style: NestRequest['style'], rotationCount: number): number[] {
  if (part.lockedRotationDeg !== undefined) {
    // orientation lock: exactly one angle; the GA may not rotate it.
    return [((part.lockedRotationDeg % 360) + 360) % 360]
  }
  if (style === 'ninety') {
    return [0, 90, 180, 270]
  }
  // 'arbitrary': rotationCount evenly-spaced angles starting at 0.
  const n = Math.max(1, rotationCount)
  const angles: number[] = []
  for (let i = 0; i < n; i++) angles.push((i * 360) / n)
  return angles
}

/**
 * Pack the requested parts onto the fixed sheet. Async because the clipper2-wasm
 * module must be initialised before the placement worker's union/difference can
 * run. Returns placements, explicit leftovers (unplaced), utilization, and the
 * sheet used.
 */
export async function packNest(req: NestRequest): Promise<NestResult> {
  await ensureEngineClipperReady()

  const rng = mulberry32(req.seed)
  const rotationCount = req.rotationCount ?? DEFAULT_ROTATION_COUNT
  // curveTolerance simplifies the NFP/placement PROXY rings only; original part
  // geometry is untouched (poses apply to full geometry for render/toolpath).
  const curveTol = req.curveTolerance ?? DEFAULT_CURVE_TOLERANCE

  // --- spacing applied ONCE up front (NOT in the GA hot loop) ----------------
  // partGap is edge-to-edge clearance between parts: grow each part by half the
  // gap, so two grown parts in contact leave a full partGap between originals.
  // sheetMargin is part-to-sheet-edge clearance: shrink the usable sheet by it.
  const grow = req.spacing.partGap / 2
  const margin = req.spacing.sheetMargin

  // expand request into instances; carry both the spacing-grown ring (used for
  // placement / clearance) and the original ring (reported geometry envelope).
  interface Inst {
    partId: string
    instanceId: string
    grownOuter: Vec2[]
    sourceArea: number
  }
  const instances: Inst[] = []
  const sheetFitByPart = new Map<string, PlacementPart['sheetFit']>()

  for (const entry of req.parts) {
    const { part, quantity } = entry
    // SIMPLIFY the source ring FIRST (curveTol), THEN grow it. Simplifying the
    // ORIGINAL (not the grown) ring is what kills the profiled noFitPolygon hot
    // loop (BMG ~202 verts -> tens) WITHOUT eroding clearance: the spacing grow
    // is an exact clipper offset, so the full partGap is preserved (simplifying
    // the round-join-grown ring instead would chord the corner arcs inward by up
    // to curveTol and eat into the gap). Small fixtures (<16 verts) simplify to
    // themselves. This is the proxy fed to the GA -> placeParts -> noFitPolygon;
    // original geometry (used for render/toolpath) is untouched. WO-2480: the grow also covers what the
    // simplification and the offset's arc flattening shave off (proxy.ts), so the
    // proxy contains the real outline plus half the gap.
    // WINDING NORMALIZATION (nfp.ts orbit requires a consistent winding): the
    // SVGnest noFitPolygon orbit only closes when its input rings share the
    // SVGnest "counterclockwise" convention (negative SVGnest polygonArea, which
    // equals geometric CCW = project signedArea >= 0). The DXF importer yields
    // CW outer rings for some real parts (BootL, Leadscrew); an un-normalized CW
    // ring makes noFitPolygon(A,A) return ZERO loops, so the obstacle never enters
    // the placement worker's forbidden region and copies STACK. ensureCCW (project
    // signedArea-based, geometric CCW) flips those CW rings; rings already CCW
    // (BMG, every hand-authored test fixture) are returned unchanged -> byte-
    // identical. Rotation downstream preserves winding, so normalizing the proxy
    // here normalizes every noFitPolygon input the GA/placement worker sees.
    const grown = spacingProxy(part.outer, grow, curveTol)
    const area = Math.abs(polygonArea(part.outer))
    for (let q = 0; q < quantity; q++) {
      instances.push({
        partId: part.id,
        instanceId: `${part.id}#${q}`,
        grownOuter: grown,
        sourceArea: area,
      })
    }
    // the sheet holds the REAL outline plus half the gap, not the proxy (which
    // may reach further to keep parts apart - placement.ts sheetFit)
    sheetFitByPart.set(part.id, { outer: part.outer, pad: grow })
  }

  // usable sheet after the keep-out margin
  const usableW = req.sheet.width - 2 * margin
  const usableH = req.sheet.height - 2 * margin
  const sheet: SheetRect =
    usableW > 0 && usableH > 0 ? sheetRect(usableW, usableH) : sheetRect(0, 0)

  // map an instance to its allowed angles (style + lock)
  const angleByPart = new Map<string, number[]>()
  for (const entry of req.parts) {
    angleByPart.set(entry.part.id, allowedAngles(entry.part, req.style, rotationCount))
  }

  // --- empty / degenerate sheet: everything is unplaced (ADR 0003) ----------
  if (usableW <= 0 || usableH <= 0 || instances.length === 0) {
    return buildResult([], instances, req)
  }

  // --- seeded GA over (order, rotation) -------------------------------------
  const gaParts: GaPart[] = instances.map((inst) => ({
    partId: inst.partId,
    instanceId: inst.instanceId,
    outer: inst.grownOuter,
    allowedAngles: angleByPart.get(inst.partId) ?? [0],
    sheetFit: sheetFitByPart.get(inst.partId),
  }))

  const ga = new GeneticAlgorithm(
    gaParts,
    { width: sheet.width, height: sheet.height },
    { populationSize: DEFAULT_POPULATION, mutationRate: DEFAULT_MUTATION_RATE },
    rng
  )

  interface BestResult {
    placement: Placement[]
    unplaced: Inst[]
    fitness: number
  }
  let best: BestResult | null = null

  // deterministic NFP-computation-cost budget (BK-7 / INT-H1-R1): replaces the
  // removed wall-clock bailout with a pure function of the input geometry (see
  // NfpBudget in placement.ts and the searchBudget doc in types.ts).
  // WO-2480: the DEFAULT budget never ends the first pass early. It used to be a
  // flat 100,000 units, and one pass over detailed outlines costs more than that
  // (the kit sheet: sign/gear/gear/jaws/clamps = 242,980 units), so the very first
  // evaluation ran dry after the second part and every later part was reported
  // unplaced although it fitted - 2 of 7 placed. The default is now at least the
  // most one complete pass can spend (inner-fit per instance + NFP per pair, the
  // same units placeParts charges), still a pure function of the input. An
  // explicit req.searchBudget is the caller's own bound and is honoured as given.
  const budget = new NfpBudget(req.searchBudget ?? Math.max(DEFAULT_SEARCH_BUDGET, fullPassCost(gaParts, sheet)))
  const nfpCache: NfpCache = new Map()

  const evaluate = (individual: Individual): number => {
    const parts: PlacementPart[] = individual.placement.map((g, idx) => ({
      partId: g.partId,
      instanceId: g.instanceId,
      outer: g.outer,
      rotationDeg: individual.rotation[idx],
      sheetFit: sheetFitByPart.get(g.partId),
    }))
    const res = placeParts(parts, sheet, budget, nfpCache)
    individual.fitness = res.fitness

    if (best === null || res.fitness < best.fitness) {
      // translate placement worker output back into the margin-offset sheet
      // frame (origin shifted by +margin so poses are in true sheet coords).
      const placement: Placement[] = res.placed.map((p) => ({
        partId: p.partId,
        instanceId: p.instanceId,
        x: p.x + margin,
        y: p.y + margin,
        rotationDeg: p.rotationDeg,
        depth: 0, // on-sheet (Phase A); window children (depth 1) are added below
      }))
      const unplacedInsts = res.unplaced.map(
        (u) => instances.find((i) => i.instanceId === u.instanceId)!
      )
      best = { placement, unplaced: unplacedInsts, fitness: res.fitness }
    }
    return res.fitness
  }

  // generation loop, bounded by DEFAULT_GENERATION_CAP AND `budget` (BK-7 /
  // INT-H1-R1: a wall-clock deadline here previously made two same-process
  // runs on the identical seeded input diverge under CPU load - see index.ts
  // module doc / the WO report for the mechanism). Both bounds are pure
  // functions of the input: the generation cap is a fixed count, and `budget`
  // meters actual NFP computation cost (never elapsed time), so identical
  // input always does identical work on any machine under any load. Checked
  // at the SAME granularity the old wall-clock check used (after each
  // individual evaluation, and again before starting the next generation).
  let gen = 0
  while (gen < DEFAULT_GENERATION_CAP) {
    // evaluate any unscored individuals this generation
    for (const ind of ga.population) {
      if (ind.fitness === undefined) {
        evaluate(ind)
        if (budget.exhausted) break
      }
    }
    if (budget.exhausted) break
    gen++
    if (gen < DEFAULT_GENERATION_CAP) ga.generation()
  }

  const b = best as BestResult | null
  let finalPlacement = b?.placement ?? []
  let finalUnplaced = b?.unplaced ?? instances

  // --- Phase B: inside-window nesting (ADR 0024, NESTING-SPEC.md item 7) ------
  // GATED so no-window inputs are byte-identical to Phase A alone: only runs when
  // at least one source part offers a window AND Phase A left instances unplaced.
  // For each on-sheet host placement, transform its windows by the host pose and
  // try to drop each unplaced instance inside a (windowGap-shrunk) window, sub-
  // tracting the NFPs of parts already nested in THAT window. Successful drops get
  // windowParentId = host.instanceId and depth = 1. Instances that fit no window
  // stay unplaced (ADR 0003 - explicit, never silently dropped).
  const anyWindows = req.parts.some((e) => (e.part.windows?.length ?? 0) > 0)
  if (anyWindows && finalUnplaced.length > 0 && finalPlacement.length > 0) {
    const partById = new Map<string, NestPart>()
    for (const e of req.parts) partById.set(e.part.id, e.part)
    const { windowChildren, stillUnplaced } = placeInWindows(
      finalPlacement,
      finalUnplaced,
      partById,
      angleByPart,
      req.spacing.windowGap,
      curveTol
    )
    if (windowChildren.length > 0) {
      finalPlacement = [...finalPlacement, ...windowChildren]
      finalUnplaced = stillUnplaced
    }
  }

  const safety = validatePlacementSafety(
    req.parts,
    finalPlacement,
    req.sheet,
    req.spacing.sheetMargin,
    req.spacing.partGap,
  )
  const rejected = safety.rejected
    .map((placement) => instances.find((inst) => inst.instanceId === placement.instanceId))
    .filter((inst): inst is Inst => inst !== undefined)
  return buildResult(safety.placements, [...finalUnplaced, ...rejected], req)
}

/** An unplaced instance the window phase may try to nest (same shape index.ts
 *  carries through the GA). Exported so the inside-window engine extension can be
 *  gated directly (Phase B's multi-sibling clearance), independent of the GA's
 *  on-sheet host/part trade-off. */
export interface WindowInst {
  partId: string
  instanceId: string
  sourceArea: number
}

/**
 * Phase B - place leftover instances inside the interior windows of already-
 * placed host parts. Deterministic: hosts are iterated in the order Phase A
 * placed them (a fixed array), each host's windows in source order, and the
 * unplaced instances in their existing (deterministic) order. Each candidate is
 * tried at its first allowed angle (the inside-NFP search is itself deterministic).
 *
 * windowGap clearance is applied the SAME way partGap is (index.ts): the candidate
 * is grown by windowGap/2 (sibling clearance) and the window is shrunk by
 * windowGap/2 (part-to-boundary clearance) BEFORE the inside-fit, so a grown part
 * touching the shrunk window leaves a full windowGap to the real boundary and two
 * grown siblings in contact leave a full windowGap between originals.
 */
export function placeInWindows<T extends WindowInst>(
  hosts: Placement[],
  unplaced: T[],
  partById: Map<string, NestPart>,
  angleByPart: Map<string, number[]>,
  windowGap: number,
  curveTol: number = DEFAULT_CURVE_TOLERANCE
): { windowChildren: Placement[]; stillUnplaced: T[] } {
  const windowChildren: Placement[] = []
  const remaining: T[] = unplaced.slice(0)
  const half = windowGap / 2

  // tracks, per host window, the union of already-nested child rings (forbidden
  // region for the next child's reference point, in world coords).
  for (const host of hosts) {
    const hostPart = partById.get(host.partId)
    const wins = hostPart?.windows ?? []
    if (wins.length === 0) continue

    for (const winLoop of wins) {
      // window posed into world by the host transform, then shrunk by windowGap/2.
      const posed = transformRing(winLoop, host.rotationDeg, host.x, host.y)
      // simplify the posed window BEFORE the shrink (NFP "A" proxy) - dense
      // imported hosts can carry high-vertex windows and the inside-NFP is the
      // same O(n^2*m^2) cost. Simplify-before-shrink keeps the exact windowGap
      // boundary clearance (shrinking is an exact offset; simplifying after would
      // chord the boundary inward by up to curveTol).
      const posedSimple = simplifyRing(posed, curveTol)
      const shrunkLoops = half > 0 ? offsetClosed([posedSimple], -half) : [posedSimple]
      const windowRaw = shrunkLoops.length > 0 ? largestLoop(shrunkLoops) : null
      // normalize to geometric CCW so the inside-NFP orbit (window = "A") matches
      // the SVGnest winding convention (same fix as the on-sheet proxy above).
      const window = windowRaw ? ensureCCW(windowRaw) : null
      if (!window || window.length < 3) continue

      // children already nested in THIS window: their (grown, rotated) ring plus
      // the pose it sits at. The forbidden region for the NEXT candidate's
      // reference point is the union of NFP(placedChild, candidate) shifted to each
      // child's pose (the SAME construction placement.ts uses for on-sheet parts -
      // subtracting the raw child ring would be wrong; the forbidden locus is the
      // Minkowski no-fit region, not the child footprint).
      const nestedHere: { ring: Vec2[]; x: number; y: number }[] = []

      // try each still-remaining instance, smallest-area first so big leftovers do
      // not block tiny ones from a small window (deterministic tie-break by id).
      const order = remaining
        .map((inst, idx) => ({ inst, idx }))
        .sort((a, b) =>
          a.inst.sourceArea !== b.inst.sourceArea
            ? a.inst.sourceArea - b.inst.sourceArea
            : a.inst.instanceId < b.inst.instanceId
              ? -1
              : 1
        )

      for (const { inst } of order) {
        // skip if already nested this round (remaining is mutated below)
        if (!remaining.some((r) => r.instanceId === inst.instanceId)) continue
        const cand = partById.get(inst.partId)
        if (!cand) continue

        // candidate grown by windowGap/2 for sibling + boundary clearance, at its
        // first allowed angle (deterministic; the GA owns rotation search on-sheet).
        const angle = (angleByPart.get(inst.partId) ?? [0])[0] ?? 0
        // simplify the candidate's ORIGINAL ring then grow it (NFP "B" proxy),
        // same order as on-sheet so the windowGap sibling clearance is preserved.
        const candSimple = simplifyRing(cand.outer, curveTol)
        const grownCandRaw = half > 0 ? largestLoop(offsetClosed([candSimple], half)) : candSimple
        // normalize the candidate ("B") to geometric CCW too (same winding fix);
        // rotation below preserves winding, so every noFitPolygon input in the
        // window phase is consistently wound.
        const grownCand = ensureCCW(grownCandRaw)
        const ring = rotatePolygon(grownCand, angle)

        // quick bbox reject: candidate cannot exceed the shrunk window extent.
        const wb = getPolygonBounds(window)
        const rb = getPolygonBounds(ring)
        if (rb.width > wb.width || rb.height > wb.height) continue

        // inside-NFP: locus of ring[0] s.t. the candidate fits INSIDE the window.
        const innerNfp = noFitPolygon(window, ring, true, true)
        if (!innerNfp || innerNfp.length === 0) continue

        // forbidden union = NFP(child, candidate) for each already-nested child,
        // each shifted to that child's pose (placement.ts construction).
        let forbidden: Vec2[][] = []
        for (const child of nestedHere) {
          const nfp = noFitPolygon(child.ring, ring, false, false)
          if (!nfp || nfp.length === 0) continue
          for (const loop of nfp) {
            const shifted = loop.map((p) => ({ x: p.x + child.x, y: p.y + child.y }))
            forbidden = forbidden.length === 0 ? [shifted] : union(forbidden, [shifted])
          }
        }

        // feasible region = inside-NFP MINUS the sibling-forbidden union.
        const feasible = forbidden.length === 0 ? innerNfp : difference(innerNfp, forbidden)

        // deterministic bottom-left gravity: smallest (sx + sy) over feasible verts.
        let best: { sx: number; sy: number } | null = null
        for (const loop of feasible) {
          if (Math.abs(polygonArea(loop)) < 2) continue
          for (const v of loop) {
            const sx = v.x - ring[0].x
            const sy = v.y - ring[0].y
            const sum = sx + sy
            if (best === null || sum < best.sx + best.sy) best = { sx, sy }
          }
        }
        if (best === null) continue

        windowChildren.push({
          partId: inst.partId,
          instanceId: inst.instanceId,
          x: best.sx,
          y: best.sy,
          rotationDeg: angle,
          windowParentId: host.instanceId,
          depth: 1,
        })

        // remove from remaining and record this child's pose so the next candidate
        // avoids it (NFP-difference above).
        const ri = remaining.findIndex((r) => r.instanceId === inst.instanceId)
        if (ri >= 0) remaining.splice(ri, 1)
        nestedHere.push({ ring, x: best.sx, y: best.sy })

        if (remaining.length === 0) break
      }
      if (remaining.length === 0) break
    }
    if (remaining.length === 0) break
  }

  return { windowChildren, stillUnplaced: remaining }
}

/** The most NfpBudget units one placeParts pass over `parts` can spend: an
 *  inner-fit per instance plus one NFP per instance pair (rotation never changes
 *  a ring's vertex count, so this holds for every gene). */
function fullPassCost(parts: readonly { outer: Vec2[] }[], sheet: SheetRect): number {
  let cost = 0
  let before = 0
  for (const p of parts) {
    cost += sheet.polygon.length * p.outer.length + before * p.outer.length
    before += p.outer.length
  }
  return cost
}

/** Largest loop of an offset result (inward/outward offsets can split; we want
 *  the single outer envelope). Throws on empty rather than silently degrading. */
function largestLoop(loops: Vec2[][]): Vec2[] {
  if (loops.length === 0) {
    throw new Error('nesting: spacing offset produced no loop (part too small for partGap)')
  }
  let best = loops[0]
  let bestArea = Math.abs(polygonArea(best))
  for (let i = 1; i < loops.length; i++) {
    const a = Math.abs(polygonArea(loops[i]))
    if (a > bestArea) {
      best = loops[i]
      bestArea = a
    }
  }
  return best
}

/** Assemble a NestResult: utilization = placed source-area / sheet area; unplaced
 *  is grouped by partId with exact counts (ADR 0003). */
function buildResult(
  placement: Placement[],
  unplacedInsts: { partId: string; instanceId: string; sourceArea: number }[],
  req: NestRequest
): NestResult {
  // placed source area = total requested area minus unplaced area, by partId
  const placedByPart = new Map<string, number>()
  for (const p of placement) placedByPart.set(p.partId, (placedByPart.get(p.partId) ?? 0) + 1)

  // unplaced counts grouped by partId
  const unplacedCount = new Map<string, number>()
  for (const u of unplacedInsts) unplacedCount.set(u.partId, (unplacedCount.get(u.partId) ?? 0) + 1)
  const unplaced: { partId: string; count: number }[] = []
  for (const [partId, count] of unplacedCount) {
    if (count > 0) unplaced.push({ partId, count })
  }
  // deterministic ordering of the leftover report (by partId)
  unplaced.sort((a, b) => (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0))

  // utilization: sum of placed source-part areas / sheet area
  const areaByPart = new Map<string, number>()
  for (const entry of req.parts) {
    areaByPart.set(entry.part.id, Math.abs(polygonArea(entry.part.outer)))
  }
  let placedArea = 0
  for (const [partId, count] of placedByPart) {
    placedArea += (areaByPart.get(partId) ?? 0) * count
  }
  const sheetArea = req.sheet.width * req.sheet.height
  const utilization = sheetArea > 0 ? placedArea / sheetArea : 0

  return {
    placements: placement,
    unplaced,
    utilization,
    sheetUsed: req.sheet,
  }
}

/**
 * Single entry point the app transport (Web Worker) and node tests both call, so
 * the store, the worker, and the unit tests all route a NestRequest through ONE
 * place. Dispatches on req.solver: every solver objective (fixSheet max-quantity,
 * fixQty min-sheet / min-area) runs through solveNest, which itself drives packNest
 * for the final full-quality pack. Async because clipper2-wasm must initialise
 * first. Deterministic for a given req.seed (the engine's #1 invariant).
 *
 * NB: solveNest already dispatches on req.solver.kind; runNest is the named seam
 * (not new logic) so callers depend on a stable "request in, NestResult out" symbol
 * rather than on which internal function (solveNest vs packNest) handles each mode.
 */
export function runNest(req: NestRequest): Promise<NestResult> {
  return solveNest(req)
}
