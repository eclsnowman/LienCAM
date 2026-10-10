/* Placement worker for the nesting engine - true-shape part placement.
 *
 * PORTED from the vendored SVGnest placement worker
 * (vendored/svgnest-placementworker.reference.js.txt, PlacementWorker.placePaths)
 * and the relevant NFP-pair setup in svgnest.js launchWorkers. The algorithm is
 * kept faithful; the surface is adapted to the project:
 *
 *  - SVGnest scales mm -> integer for jsClipper (clipperScale) and runs ClipperLib
 *    NonZero unions/differences. Here the project clipper2-wasm wrapper
 *    (clipperEngine, double-precision mm, EvenOdd) does the NFP-union and the
 *    sheet-difference directly in mm; no SCALE_FACTOR. The math is identical.
 *  - SVGnest supports MULTIPLE bins (opens a new bin when a part will not fit).
 *    P1.2 packs ONE fixed sheet (NESTING-P1-ENGINE-PLAN.md: treat solver as
 *    fixSheet onto req.sheet); parts that do not fit on the single sheet are
 *    reported as UNPLACED (ADR 0003 - no silent drop), not spilled to a new bin.
 *  - Inner-fit containment uses noFitPolygonRectangle (the sheet is an
 *    axis-aligned rectangle). The feasible region for the i-th part is
 *    (inner-fit rectangle NFP) MINUS (union of placed-part NFPs); the placement
 *    point is chosen by SVGnest's gravity / min-bounding rule (weigh width x2),
 *    with a bottom-left (smallest x+y) gravity tie-break so a fixed finite sheet
 *    fills in rows instead of one tall column (see the tie-break note below).
 *    DETERMINISTIC: no Math.random here (all GA randomness lives in ga.ts, seeded).
 *
 * Spacing (partGap / sheetMargin) is NOT applied here. It is baked into the part
 * and sheet geometry ONCE, up front, by packNest (index.ts) via clipperEngine
 * offsets, so the NFPs already encode the clearance. This keeps the GA hot loop
 * offset-free (NESTING-P1-ENGINE-PLAN.md spacing note).
 */

import type { Vec2 } from '../../../types/index'
import { getPolygonBounds, polygonArea, rotatePolygon } from './geometry'
import { noFitPolygon, noFitPolygonRectangle } from './nfp'
import { union, difference } from '../adaptiveClearing2d/engine/clipperEngine'

/** A part instance fed to the placement worker: source geometry + the chosen
 *  rotation for THIS placement attempt. `instanceId` is unique per instance so
 *  duplicate copies of the same source part stay individually addressable. */
export interface PlacementPart {
  partId: string
  instanceId: string
  /** Source outer ring (already spacing-offset by packNest), pre-rotation. */
  outer: Vec2[]
  rotationDeg: number
  /** The real outline (pre-rotation, same frame as `outer`) and the clearance
   *  it keeps from the sheet edge. When given, sheet containment is the real
   *  outline's bounds grown by `pad`, not the proxy's: the proxy may reach past
   *  the real outline (proxy.ts) to space parts apart, and that extra must not
   *  push a part that fits off the sheet (WO-2480 audit). */
  sheetFit?: { outer: Vec2[]; pad: number }
}

/** The ring the inner-fit measures for `part` at its rotation: its proxy, or
 *  the real outline's bounds grown by the pad (sheetFit). */
function sheetFitRing(part: PlacementPart, proxyRing: Vec2[]): Vec2[] {
  if (!part.sheetFit) return proxyRing
  const b = getPolygonBounds(rotatePolygon(part.sheetFit.outer, part.rotationDeg))
  const pad = part.sheetFit.pad
  const x0 = b.x - pad
  const y0 = b.y - pad
  const x1 = b.x + b.width + pad
  const y1 = b.y + b.height + pad
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ]
}

/** One placed instance: the pose (translate after rotate) on the sheet. */
export interface PlacedInstance {
  partId: string
  instanceId: string
  x: number
  y: number
  rotationDeg: number
}

/** Result of one placement pass over an ordering+rotation gene. */
export interface PlacementResult {
  placed: PlacedInstance[]
  /** instances that did not fit on the single fixed sheet (ADR 0003). */
  unplaced: { partId: string; instanceId: string }[]
  /** Lower is better. Mirrors SVGnest fitness: penalises wasted bounding width
   *  plus a heavy penalty per unplaced part so the GA prefers placing more. */
  fitness: number
}

/** Sheet as an axis-aligned rectangle polygon (already margin-shrunk). */
export interface SheetRect {
  /** CCW rectangle ring used as the inner-fit "A" polygon. */
  polygon: Vec2[]
  width: number
  height: number
}

/**
 * Deterministic replacement for the removed wall-clock bailout (BK-7 rework,
 * WO INT-H1-R1). The old code stopped the GA search when elapsed real time
 * exceeded a deadline; that made two same-seed runs diverge under CPU load
 * because "how much work got done" depended on how fast the machine happened
 * to be at that instant. NfpBudget instead meters the ACTUAL cost driver -
 * noFitPolygon/noFitPolygonRectangle calls, weighted by ringA.length *
 * ringB.length (the orbit algorithm is ~O(n*m) in vertex count, so this is a
 * direct, input-derived proxy for the wall-clock cost a call will take,
 * without ever reading the clock). A pure function of the geometry: identical
 * inputs always spend identical amounts, on any machine, under any load.
 */
export class NfpBudget {
  private remaining: number
  constructor(total: number) {
    this.remaining = total
  }
  /** True once the budget has been fully spent; callers must stop starting
   *  new NFP-costed work (placeParts bails the rest of its pass to unplaced). */
  get exhausted(): boolean {
    return this.remaining <= 0
  }
  /** Units left (may go negative: the in-flight call that exhausted the
   *  budget is not refunded). Instrumentation/test seam only. */
  get remainingUnits(): number {
    return this.remaining
  }
  /** Charge the cost of one NFP evaluation between two rings. */
  spend(ringA: Vec2[], ringB: Vec2[]): void {
    this.remaining -= ringA.length * ringB.length
  }
}

/**
 * Part-vs-part NFP memo shared across the placement passes of ONE pack (WO-2480).
 * An NFP is translation-invariant and depends only on the two rings, and every
 * instance of a part carries the same proxy ring, so (partId, rotation) pairs
 * identify it exactly: a hit returns the very loops the orbit would recompute.
 * Pure speed - the budget is still charged for every NFP request, hit or miss,
 * so how much search a pack does is unchanged by the memo.
 */
export type NfpCache = Map<string, Vec2[][] | null>

/** Build the CCW rectangle ring for a sheet of the given size at the origin. */
export function sheetRect(width: number, height: number): SheetRect {
  return {
    polygon: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    width,
    height,
  }
}

/** Rotate then translate a ring (the instance transform: translate . rotate). */
export function transformRing(outer: Vec2[], rotationDeg: number, x: number, y: number): Vec2[] {
  const r = rotatePolygon(outer, rotationDeg)
  return r.map((p) => ({ x: p.x + x, y: p.y + y }))
}

/**
 * Place the parts (in the given order, each at its given rotation) onto the
 * single fixed sheet. Faithful port of PlacementWorker.placePaths restricted to
 * ONE bin: the inner-fit rectangle NFP gives the sheet-containment region, the
 * union of placed-part NFPs (shifted to each placed pose) is differenced out of
 * it, and the gravity/min-bounding rule picks the point. Parts that cannot be
 * placed go to `unplaced` (no silent drop, ADR 0003).
 *
 * `budget`, when given, meters NFP-computation cost (NfpBudget, above). Once
 * exhausted mid-pass, every remaining part (including the one in flight, if
 * its obstacle NFPs are incomplete) is reported unplaced rather than risking
 * an overlap from an unbounded forbidden region - the same ADR 0003 fallback
 * this function already uses for a failed/empty NFP.
 *
 * `nfpCache`, when given, memoises part-vs-part NFPs across passes (NfpCache).
 * Only pass one whose entries came from the same partId -> ring mapping.
 */
export function placeParts(
  parts: PlacementPart[],
  sheet: SheetRect,
  budget?: NfpBudget,
  nfpCache?: NfpCache,
): PlacementResult {
  const placed: PlacementPart[] = []
  const placements: PlacedInstance[] = []
  const unplaced: { partId: string; instanceId: string }[] = []
  let fitness = 0

  // pre-rotate every part once (rotation is fixed for this pass)
  const rotated = parts.map((p) => ({
    part: p,
    ring: rotatePolygon(p.outer, p.rotationDeg),
  }))

  let minwidth: number | null = null

  for (let i = 0; i < rotated.length; i++) {
    if (budget?.exhausted) {
      // budget spent: this and every remaining part are unplaced (ADR 0003 -
      // explicit, never a silent drop or a guessed placement).
      for (let k = i; k < rotated.length; k++) {
        unplaced.push({ partId: rotated[k].part.partId, instanceId: rotated[k].part.instanceId })
      }
      break
    }
    const { part, ring } = rotated[i]

    // inner-fit NFP: locus of ring[0] s.t. the part fits inside the sheet
    budget?.spend(sheet.polygon, ring)
    // the locus comes back for the fit ring's first vertex; shift it to ring[0]'s
    const fitRing = sheetFitRing(part, ring)
    const fitLocus = noFitPolygonRectangle(sheet.polygon, fitRing)
    const innerNfp =
      fitLocus && fitRing !== ring
        ? fitLocus.map((loop) =>
            loop.map((v) => ({ x: v.x + ring[0].x - fitRing[0].x, y: v.y + ring[0].y - fitRing[0].y })),
          )
        : fitLocus
    if (!innerNfp || innerNfp.length === 0) {
      // part is larger than the sheet - unplaceable (ADR 0003: report it)
      unplaced.push({ partId: part.partId, instanceId: part.instanceId })
      continue
    }

    let position: PlacedInstance | null = null

    if (placed.length === 0) {
      // first part: put it as far to the lower-left as the inner-fit allows
      let best: { x: number; y: number } | null = null
      for (const loop of innerNfp) {
        for (const v of loop) {
          if (best === null || v.x - ring[0].x < best.x) {
            best = { x: v.x - ring[0].x, y: v.y - ring[0].y }
          }
        }
      }
      if (best) {
        position = {
          partId: part.partId,
          instanceId: part.instanceId,
          x: best.x,
          y: best.y,
          rotationDeg: part.rotationDeg,
        }
      }
    } else {
      // union of the placed parts' NFPs vs this part, each shifted to its pose;
      // this is the forbidden region for ring[0].
      let combined: Vec2[][] = []
      let obstacleNfpFailed = false
      let budgetRanOut = false
      for (let j = 0; j < placed.length; j++) {
        if (budget?.exhausted) {
          // budget spent mid-candidate: the obstacle union so far is INCOMPLETE,
          // so the forbidden region is unknown - same ADR 0003 fallback as a
          // failed/empty NFP (never guess a placement against an unbounded
          // region). No console.warn: this is the expected, deterministic stop,
          // not a geometry anomaly.
          budgetRanOut = true
          break
        }
        const placedRing = rotated.find((r) => r.part.instanceId === placed[j].instanceId)!.ring
        budget?.spend(placedRing, ring)
        const key = `${placed[j].partId}@${placed[j].rotationDeg}|${part.partId}@${part.rotationDeg}`
        let nfp = nfpCache?.get(key)
        if (nfp === undefined) {
          nfp = noFitPolygon(placedRing, ring, false, false)
          nfpCache?.set(key, nfp)
        }
        if (!nfp || nfp.length === 0) {
          // FAIL-LOUD (ADR 0003, Pattern 2): an empty part-vs-part NFP means the
          // forbidden region around an already-placed obstacle is UNKNOWN. After
          // the winding normalization in packNest/solver (every proxy ring is
          // ensureCCW'd to the SVGnest winding noFitPolygon's orbit requires) a
          // valid part pair always yields a non-empty NFP; reaching here means a
          // degenerate proxy (self-touching / collapsed) the orbit could not
          // close. Silently `continue`-ing here is the exact stacking bug: the
          // obstacle drops out of `combined`, the feasible region becomes the full
          // inner-fit, and this copy lands ON TOP of that obstacle. Instead, name
          // the failure and mark the candidate UNPLACEABLE so it never overlaps.
          // eslint-disable-next-line no-console
          console.warn(
            `[nesting] empty NFP for obstacle pair (placed=${placed[j].instanceId}, ` +
              `candidate=${part.instanceId}); cannot bound overlap region -> ` +
              `candidate left UNPLACED rather than stacked (ADR 0003)`
          )
          obstacleNfpFailed = true
          break
        }
        for (const loop of nfp) {
          const shifted = loop.map((p) => ({
            x: p.x + placements[j].x,
            y: p.y + placements[j].y,
          }))
          combined = combined.length === 0 ? [shifted] : union(combined, [shifted])
        }
      }

      // an unbounded obstacle region above means we cannot prove non-overlap;
      // skip the gravity search and let this candidate fall through to unplaced.
      if (obstacleNfpFailed || budgetRanOut) {
        unplaced.push({ partId: part.partId, instanceId: part.instanceId })
        continue
      }

      // feasible region = inner-fit MINUS forbidden union. When empty there is
      // no spot for this part on the sheet right now; position stays null and
      // the part falls through to the unplaced bookkeeping below (ADR 0003 - no
      // silent drop). Faithful to SVGnest's `continue`, but SVGnest then opens a
      // NEW bin for the skipped part; P1.2 has a single sheet, so it is unplaced.
      const feasible = combined.length === 0 ? innerNfp : difference(innerNfp, combined)

      // gravity / min-bounding rule: pick the feasible vertex that yields the
      // smallest weighted bounding box (width weighed x2). TIE-BREAK = bottom-left
      // gravity (smallest sx+sy), NOT smallest-x. A pure smallest-x tie-break
      // strands parts: when several candidate poses tie on bounding score (the
      // common case for grid-tileable parts on a finite sheet), smallest-x always
      // picks the x=0 column slot, building ONE vertical column that leaves no
      // room for later parts (measured: 4x 25mm squares on 70x70 -> only 3 placed,
      // the 4th's feasible region was EMPTY because the column NFP-union covered
      // the inner-fit). SVGnest's smallest-x tie-break is sound for its multi-bin
      // model (a new column opens a new bin); on a single fixed sheet it must be
      // bottom-left gravity so parts fill rows, not one tall column. The bounding
      // SCORE is unchanged (still the SVGnest width-weighted rule).
      let minarea: number | null = null
      let minsum: number | null = null
      for (const nf of feasible) {
        if (Math.abs(polygonArea(nf)) < 2) continue
        for (const cand of nf) {
          const sx = cand.x - ring[0].x
          const sy = cand.y - ring[0].y

          // bounding box of everything placed so far PLUS this candidate pose
          const allpoints: Vec2[] = []
          for (let m = 0; m < placed.length; m++) {
            const pr = rotated.find((r) => r.part.instanceId === placed[m].instanceId)!.ring
            for (const p of pr) {
              allpoints.push({ x: p.x + placements[m].x, y: p.y + placements[m].y })
            }
          }
          for (const p of ring) allpoints.push({ x: p.x + sx, y: p.y + sy })

          const b = getPolygonBounds(allpoints)
          const area = b.width * 2 + b.height
          const sum = sx + sy

          if (
            minarea === null ||
            area < minarea ||
            (Math.abs(minarea - area) < 1e-9 && (minsum === null || sum < minsum))
          ) {
            minarea = area
            minwidth = b.width
            minsum = sum
            position = {
              partId: part.partId,
              instanceId: part.instanceId,
              x: sx,
              y: sy,
              rotationDeg: part.rotationDeg,
            }
          }
        }
      }
    }

    if (position) {
      placed.push(part)
      placements.push(position)
    } else {
      unplaced.push({ partId: part.partId, instanceId: part.instanceId })
    }
  }

  // fitness: wasted bounding width (lower = tighter), plus a per-unplaced penalty
  // so a gene that places MORE parts always beats one that places fewer.
  const sheetArea = Math.abs(sheet.width * sheet.height)
  if (minwidth !== null && sheetArea > 0) {
    fitness += minwidth / sheetArea
  }
  fitness += 2 * unplaced.length

  return { placed: placements, unplaced, fitness }
}
