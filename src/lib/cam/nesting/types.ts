/* Public types for the nesting engine (true-shape part nesting).
 *
 * Units: canonical millimetres throughout (ADR 0022). Coordinates use the
 * project Vec2 ({ x, y }) - do NOT redefine a local point type.
 *
 * These shapes are the OBJECTIVE engine spine (NESTING-P1-ENGINE-PLAN.md, P1).
 * They are intentionally UI-free: parts in, placements out. The instanced
 * data-model / toolpath / post contracts live in ADR 0024 (later phases).
 */

import type { Vec2 } from '../../../types/index'

/** A unique source part to be nested. Geometry is stored ONCE per source and
 *  instanced per placement (ADR 0024); holes are interior loops (potential
 *  inside-window hosts in later phases). `lockedRotationDeg`, when set, pins the
 *  part to a single orientation (the solver may not rotate it). */
export interface NestPart {
  id: string
  outer: Vec2[]
  holes: Vec2[][]
  lockedRotationDeg?: number
  /** Interior loops designated usable as nesting windows: smaller parts may be
   *  placed inside one of these to use the host's waste (NESTING-SPEC.md item 7,
   *  ADR 0024). A subset of / derived from `holes`, supplied by the caller (the
   *  valid-window SELECTION is a future UI concern, P5). Absent or empty => this
   *  part offers no windows. No recursion in v1 (no window-inside-window). */
  windows?: Vec2[][]
}

/** One placed instance of a source part on the sheet. `instanceId` is unique
 *  per placement; `partId` references the source NestPart. The pose is a 2D
 *  rigid transform translate(x, y) . rotate(rotationDeg) applied to the source
 *  geometry (matches the ADR 0024 instance transform). */
export interface Placement {
  partId: string
  instanceId: string
  x: number
  y: number
  rotationDeg: number
  /** Set to the HOST placement's instanceId when this part is nested inside one
   *  of the host's interior windows; absent for parts placed directly on the
   *  sheet (ADR 0024 placement record). */
  windowParentId?: string
  /** Nesting depth: 0 = placed on the sheet, 1 = nested inside a window. v1 caps
   *  at depth 1 (no recursion). Drives innermost-first cut ordering (ADR 0024). */
  depth: number
}

/** Sheet stock the parts are packed onto (mm). */
export interface Sheet {
  width: number
  height: number
}

/** Rotation freedom for the solver:
 *  - 'arbitrary': continuous rotations sampled per `rotationCount`.
 *  - 'ninety': axis-aligned only (0/90/180/270 deg). */
export type NestStyle = 'arbitrary' | 'ninety'

/** Clearances applied via polygon offsets (mm).
 *  - partGap: minimum gap between any two parts.
 *  - sheetMargin: keep-out border inside the sheet edges.
 *  - windowGap: gap when a part is nested inside another part's interior
 *    window (later phases; carried here so the request shape is stable). */
export interface Spacing {
  partGap: number
  sheetMargin: number
  windowGap: number
}

/** Which axis (if any) of the sheet the solver may NOT change. Used only by
 *  the fixQty (min-sheet) solver: e.g. fix the width and solve the length. */
export type LockedAxis = 'none' | 'width' | 'height'

/** Solver objective (P1.3 bidirectional solver).
 *  - fixSheet: sheet size is fixed; maximise the quantity that fits (scales the
 *    requested set by the largest integer multiplier that fits).
 *  - fixSheetExact: fixed WxH sheet; pack the EXACT requested quantities (no
 *    scaling) and report leftovers (ADR 0003) — this is packNest on the given
 *    sheet, surfaced as its own mode so "Qty 5+3 means exactly 5+3".
 *  - fixQty: quantity is fixed; minimise the sheet that holds all parts, with
 *    0 or 1 sheet axis locked.
 *  - fixQtyRatio: quantity is fixed; minimise a sheet of a FIXED ASPECT RATIO
 *    that holds the EXACT requested quantities. `ratio` = height / width (> 0):
 *    e.g. ratio 1 => square, ratio 2 => twice as tall as wide. This is the
 *    auto-size mode constrained to a sensible aspect instead of a 1-wide strip
 *    (the free-aspect fixQty/'none' result). Like the other fixQty modes it packs
 *    the EXACT set and reports leftovers (ADR 0003), never scales. */
export type SolverMode =
  | { kind: 'fixSheet' }
  | { kind: 'fixSheetExact' }
  | { kind: 'fixQty'; lockedAxis: LockedAxis }
  | { kind: 'fixQtyRatio'; ratio: number }

/** Engine input. Deterministic for a given `seed` (NESTING-P1-ENGINE-PLAN.md:
 *  determinism is the #1 port risk - byte-identical output across two runs on
 *  identical input). */
export interface NestRequest {
  parts: { part: NestPart; quantity: number }[]
  sheet: Sheet
  style: NestStyle
  spacing: Spacing
  solver: SolverMode
  seed: number
  /** Orientation samples for style 'arbitrary' (ignored for 'ninety'). */
  rotationCount?: number
  /** UNUSED (BK-7): formerly a soft wall-clock deadline in the GA generation
   *  loop; removed because consulting elapsed real time made two same-process
   *  packNest runs on identical input diverge under CPU load (see index.ts
   *  packNest's generation loop). Superseded by `searchBudget`, below, which
   *  bounds the same generation loop deterministically. Kept on this type for
   *  wire compatibility with existing NestWorkerPayload callers. */
  timeBudgetMs?: number
  /** Deterministic replacement for the removed `timeBudgetMs` wall-clock
   *  bailout (BK-7 rework, WO INT-H1-R1). Bounds the GA generation loop's
   *  noFitPolygon computation cost (NfpBudget, placement.ts): every NFP/
   *  inner-fit call spends ringA.length * ringB.length units (an O(n*m) proxy
   *  for the orbit algorithm's real cost); once exhausted, the placement
   *  worker reports the rest of the current pass unplaced (ADR 0003 fallback,
   *  the same one already used for a failed/empty NFP) and no further GA
   *  generations start. A PURE function of the input geometry - never wall-
   *  clock, so identical input spends identical budget on any machine under
   *  any load. Omitted => DEFAULT_SEARCH_BUDGET (index.ts), raised to the cost
   *  of one full placement pass when that is larger (WO-2480), calibrated so
   *  every committed fixture's full (unbudgeted) search completes well inside
   *  it while a dense real part (BMG-class vertex counts) is bounded to a
   *  handful of GA evaluations instead of the full population x generation
   *  count. */
  searchBudget?: number
  /** Douglas-Peucker tolerance (mm, ADR 0022) applied to the NFP/placement PROXY
   *  rings only - NOT the rendered/cut geometry. Decimates dense imported parts
   *  (the profiled noFitPolygon hot loop is ~O(n^2*m^2) in ring vertex count) so
   *  packing stays fast. Omitted => DEFAULT_CURVE_TOLERANCE (simplify.ts). Rings
   *  below a small-vertex threshold are left byte-identical (hand-authored test
   *  fixtures are unaffected). Keep conservative vs spacing.partGap so it cannot
   *  by itself create an overlap. */
  curveTolerance?: number
}

/** Engine output. `unplaced` reports leftovers EXPLICITLY rather than silently
 *  dropping over-capacity parts (ADR 0003 - no silent fallbacks). `sheetUsed` is
 *  the fixed sheet (fixSheet) or the solver-produced size (fixQty). */
export interface NestResult {
  placements: Placement[]
  unplaced: { partId: string; count: number }[]
  utilization: number
  sheetUsed: Sheet
  /** Wall-clock ms the worker spent packing (mirrors Operation.computeTimeMs).
   *  Optional: the node test seam constructs results without timing. */
  computeTimeMs?: number
}
