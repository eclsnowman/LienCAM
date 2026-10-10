// cam3d integration (L6 bridge): the adaptive_3d rougher operation adapter.
//
// Mirrors parallel3dOperation.ts one-to-one for the per-Z-level 3D adaptive
// rougher (strategies/adaptiveRough.ts). It OWNS the cam3d-side orchestration of
// a roughing pass, dependency-injected so it is headless-testable without the
// zustand store or IndexedDB: the store (browser) resolves the source solid,
// stock box, boundary and heights, then hands them here; everything
// cam3d-specific (CutterSpec build, cell-size resolution, the client call, IR ->
// ToolpathMove[] conversion) lives in this one place.
//
// KEY DIFFERENCE FROM parallel_3d (finish-only): the rougher CARVES STOCK, so it
// REQUIRES a stock bounding box (Box3) plus a grid cell size. The stock box is
// resolved by the caller (store: real named stock; gate: the fixture AABB); the
// cell size is resolved HERE from tolerance + tool diameter (params may override).
//
// Layering: an L6 bridge may import src/types, the cam3d client, cam3d/stock
// (Box3), and geom2d. It never reaches into strategy/kernel internals.
//
// Determinism (D-006): identical inputs -> byte-identical moves. `computeTimeMs`
// is wall-clock and intentionally NOT part of the determinism contract.

import type { CutterSpec, PartMesh } from '../kernel/types';
import type { Box3, StockMesh } from '../stock';
import type { Ring } from '../geom2d';
import type { Cam3dClient } from '../worker/client';
import type { StockHandle } from '../worker/protocol';
import { irToToolpathMoves } from '../ir/toToolpathMoves';
import type {
  FeedrateOverride, Operation, OperationDiagnostics, ToolpathMove, Tool,
} from '../../types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { spindleRotationForTool } from '../../lib/tool/cutHand';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import type { Cam3dProgressCallback } from '../progress';
import { toolToCutterSpec } from './cutterSpec';
import type { ResolvedParallel3dHeights } from './parallel3dOperation';

/** Adaptive-only clearance above a proven material top. Shared height policy is out of scope. */
export const ADAPTIVE_TRAVERSE_STANDOFF_MM = 0.5;

/**
 * The parameters an adaptive_3d op carries in `op.params` (Operation.params is
 * `Record<string, unknown>`, so no core type change is needed). A later UI wave
 * reads/writes exactly these fields.
 */
export interface Adaptive3dParams {
  /** Max axial depth of cut per Z level, mm (> 0; deep is OK -- engagement is
   *  bounded in plan view by the 2D engine, not by the stepdown). */
  maxStepdown: number;
  /** Stepover as a FRACTION 0..1 of tool DIAMETER (the engagement knob). */
  stepover: number;
  /** Physical milling direction for a clockwise spindle. */
  millingDirection: AdaptiveMillingDirection;
  /** Add roughing levels between full stepdowns to leave sloped walls nearer net shape. */
  intermediateStepdown: boolean;
  /** Tangent radius used to enter retained-wall cleanup contours, mm. */
  wallLeadInRadius: number;
  /** Tangent radius used to leave retained-wall cleanup contours, mm. */
  wallLeadOutRadius: number;
  /** Stay-down loopback fillet radius as a percent of tool radius. */
  loopbackFilletPct: number;
  /** Follow a shared wall at depth instead of retracting between nearby passes. */
  integralWallFollow: boolean;
  /** Maximum wall-follow route length divided by straight-line distance. */
  integralWallFollowLengthFactor: number;
  /** Max chordal deviation of the sampled polyline from the surface, mm. */
  tolerance: number;
  /** Entry helix diameter, mm (> 0). */
  helixDiameter: number;
  /** Entry helix descent angle from horizontal, degrees (0.5..30). */
  helixAngleDeg: number;
  /** Radial finish stock left on part walls, mm (>= 0). */
  radialStockToLeave: number;
  /** Axial finish stock left on the floor, mm (>= 0; raises the computed floor). */
  axialStockToLeave: number;
  /** Stock/part grid cell size, mm. <= 0 means "derive from tolerance + tool". */
  cellSize: number;
  /** Clip the job to the stock footprint (true) or the part xy-bounds (false). */
  useStockBoundary: boolean;
  /**
   * Corner-reach (Stage C-2): mm PAST the stock edge the tool centre may reach,
   * so the full-clear pass removes the leftover corner posts. undefined = AUTO
   * (tool radius: the tool just kisses the corner apex); 0 = stay at the walls /
   * leave posts. Only consulted in the STOCK-OUTLINE full-clear branch; ignored
   * in part-bounds / fallback mode (dilating there would gouge uncleared stock).
   */
  stockEdgeOvershoot?: number;
}

/** Defaults for a freshly-created adaptive_3d op / a params record missing fields. */
export const DEFAULT_ADAPTIVE3D_PARAMS: Adaptive3dParams = {
  maxStepdown: 3,
  stepover: 0.4,
  millingDirection: 'climb',
  intermediateStepdown: false,
  wallLeadInRadius: 0,
  wallLeadOutRadius: 0,
  loopbackFilletPct: 25,
  integralWallFollow: true,
  integralWallFollowLengthFactor: 2,
  tolerance: 0.05,
  helixDiameter: 3,
  helixAngleDeg: 10,
  radialStockToLeave: 0,
  axialStockToLeave: 0,
  cellSize: 0, // 0 -> auto (deriveCellSize)
  useStockBoundary: false,
  stockEdgeOvershoot: undefined, // undefined -> auto (tool radius, full-clear only)
};

/**
 * Read an Adaptive3dParams out of an untyped `op.params` record, filling any
 * missing/invalid field from the defaults (fail-soft on shape, since a UI wave
 * will author these). Numeric fields are validated finite/positive where the
 * strategy requires it; stepover is additionally clamped to (0, 1].
 */
export function readAdaptive3dParams(params: Record<string, unknown>): Adaptive3dParams {
  const num = (v: unknown, fallback: number, mustBePositive: boolean): number => {
    if (typeof v === 'number' && Number.isFinite(v) && (!mustBePositive || v > 0)) return v;
    return fallback;
  };
  const nonNeg = (v: unknown, fallback: number): number => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return fallback;
  };
  // Optional non-negative: a finite >= 0 value wins; anything else -> undefined
  // (AUTO), so the store can substitute the tool radius in the full-clear branch.
  const optNonNeg = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const rawStep = num(params.stepover, DEFAULT_ADAPTIVE3D_PARAMS.stepover, true);
  return {
    maxStepdown: num(params.maxStepdown, DEFAULT_ADAPTIVE3D_PARAMS.maxStepdown, true),
    // Fraction knob: keep it in (0, 1] even if a record carries a stray value.
    stepover: rawStep > 1 ? DEFAULT_ADAPTIVE3D_PARAMS.stepover : rawStep,
    millingDirection:
      params.millingDirection === 'conventional' ? 'conventional' : 'climb',
    intermediateStepdown:
      typeof params.intermediateStepdown === 'boolean'
        ? params.intermediateStepdown
        : DEFAULT_ADAPTIVE3D_PARAMS.intermediateStepdown,
    wallLeadInRadius: nonNeg(params.wallLeadInRadius, DEFAULT_ADAPTIVE3D_PARAMS.wallLeadInRadius),
    wallLeadOutRadius: nonNeg(params.wallLeadOutRadius, DEFAULT_ADAPTIVE3D_PARAMS.wallLeadOutRadius),
    loopbackFilletPct:
      typeof params.loopbackFilletPct === 'number' &&
      Number.isFinite(params.loopbackFilletPct) &&
      params.loopbackFilletPct >= 5 && params.loopbackFilletPct <= 100
        ? params.loopbackFilletPct
        : DEFAULT_ADAPTIVE3D_PARAMS.loopbackFilletPct,
    integralWallFollow:
      typeof params.integralWallFollow === 'boolean'
        ? params.integralWallFollow
        : DEFAULT_ADAPTIVE3D_PARAMS.integralWallFollow,
    integralWallFollowLengthFactor: num(
      params.integralWallFollowLengthFactor,
      DEFAULT_ADAPTIVE3D_PARAMS.integralWallFollowLengthFactor,
      true,
    ),
    tolerance: num(params.tolerance, DEFAULT_ADAPTIVE3D_PARAMS.tolerance, true),
    helixDiameter: num(params.helixDiameter, DEFAULT_ADAPTIVE3D_PARAMS.helixDiameter, true),
    helixAngleDeg:
      typeof params.helixAngleDeg === 'number' &&
      Number.isFinite(params.helixAngleDeg) &&
      params.helixAngleDeg >= 0.5 &&
      params.helixAngleDeg <= 30
        ? params.helixAngleDeg
        : DEFAULT_ADAPTIVE3D_PARAMS.helixAngleDeg,
    radialStockToLeave: nonNeg(params.radialStockToLeave, DEFAULT_ADAPTIVE3D_PARAMS.radialStockToLeave),
    axialStockToLeave: nonNeg(params.axialStockToLeave, DEFAULT_ADAPTIVE3D_PARAMS.axialStockToLeave),
    // cellSize: 0 (or absent/invalid) means auto; a positive override wins.
    cellSize: nonNeg(params.cellSize, DEFAULT_ADAPTIVE3D_PARAMS.cellSize),
    useStockBoundary:
      typeof params.useStockBoundary === 'boolean'
        ? params.useStockBoundary
        : DEFAULT_ADAPTIVE3D_PARAMS.useStockBoundary,
    // undefined = AUTO (tool radius, resolved in the store's full-clear branch).
    stockEdgeOvershoot: optNonNeg(params.stockEdgeOvershoot),
  };
}

/**
 * The outcome of the Stage C-3 safety gate: may this adaptive_3d op use the
 * stock-outline FULL-CLEAR path (size the carve field to the whole stock and
 * reach past the walls into the corners), or must it fall back to PART BOUNDS
 * (clear only around this part, leaving neighbours intact)?
 *
 *  - 'full-clear'  : safe to clear the whole stock (this part is the sole solid
 *                    on its stock, unspun, with a resolved footprint).
 *  - 'part-bounds' : fall back; `reason` is the ADR-0003 loud-fallback message the
 *                    caller must log (no silent fallback in stock-outline mode).
 */
export type StockOutlineDecision =
  | { mode: 'full-clear' }
  | {
      mode: 'part-bounds'
      reason: string
      cause: 'not-requested' | 'rotated-part' | 'stock-footprint-unavailable' | 'multiple-parts'
    }

/** Operator-facing disclosure for a requested Clear all stock safety fallback. */
export function roughingScopeFallbackMessage(decision: StockOutlineDecision): string | undefined {
  if (decision.mode !== 'part-bounds' || decision.cause === 'not-requested') return undefined
  const reason = decision.cause === 'rotated-part'
    ? 'the part is rotated'
    : decision.cause === 'stock-footprint-unavailable'
      ? 'the stock footprint is unavailable'
      : decision.reason.match(/\d+ parts share this stock/)?.[0] ?? 'multiple parts share this stock'
  return `Clear all stock cannot run because ${reason}. The engine uses Clear around part instead.`
}

/** How far a stock edge may sit from the part's box edge and still be "the part's box". */
export const PART_BOX_STOCK_TOLERANCE_MM = 0.05

/**
 * WO-2145: is this stock footprint (a local-frame ring, [x0,y0,x1,y1,...]) exactly the
 * part's own XY box? Then "clear around part" and "clear all stock" are the same
 * material, and everything outside the part box is air, so the rough may run as
 * full-clear and enter from the open side. Every edge must lie within
 * PART_BOX_STOCK_TOLERANCE_MM of the part box; a stock that stands proud of the part on
 * any side is a real stock, and "clear around part" keeps meaning what it says.
 */
export function stockFootprintIsPartBox(
  footprintRing: Ring | undefined,
  partBounds: { min: readonly number[]; max: readonly number[] },
): boolean {
  if (!footprintRing || footprintRing.length < 6) return false
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i + 1 < footprintRing.length; i += 2) {
    const x = footprintRing[i], y = footprintRing[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const tol = PART_BOX_STOCK_TOLERANCE_MM
  return Math.abs(minX - partBounds.min[0]) <= tol && Math.abs(maxX - partBounds.max[0]) <= tol &&
    Math.abs(minY - partBounds.min[1]) <= tol && Math.abs(maxY - partBounds.max[1]) <= tol
}

/**
 * Stage C-3 SAFETY GATE (pure/testable). Decide whether an adaptive_3d op in
 * stock-outline mode may use FULL-CLEAR (clear the whole stock + reach corners)
 * or must fall back LOUDLY to part bounds. The store path is browser-only, so the
 * decision lives here where a unit test can pin every branch.
 *
 * Rules, in order (first match wins):
 *  1. !useStockBoundary        -> part-bounds (neutral): the caller only consults
 *     this in stock-outline mode; a defensive no-op if called otherwise.
 *  2. !unspun                  -> part-bounds: the full-clear field needs an
 *     axis-aligned (unspun) footprint; rotated-stock grid is a follow-up.
 *  3. !hasFootprint            -> part-bounds: no real stock footprint resolved.
 *  4. solidPartsOnStock > 1    -> part-bounds: clearing the whole stock would
 *     machine the neighbour parts (nesting). HARD safety disable.
 *  5. else                     -> full-clear.
 */
export function resolveStockOutlineMode(input: {
  useStockBoundary: boolean
  unspun: boolean // geo.rotation.z === 0
  hasFootprint: boolean // a real stock footprint resolved
  solidPartsOnStock: number // count of solid parts sharing this op's stock (incl. this one)
  opName: string
}): StockOutlineDecision {
  const { useStockBoundary, unspun, hasFootprint, solidPartsOnStock, opName } = input
  if (!useStockBoundary) {
    return {
      mode: 'part-bounds',
      cause: 'not-requested',
      reason: `stock-outline full-clear not requested for "${opName}" -- using part bounds.`,
    }
  }
  if (!unspun) {
    return {
      mode: 'part-bounds',
      cause: 'rotated-part',
      reason:
        `stock-outline full-clear needs an unspun part; rotated-stock grid is a ` +
        `follow-up -- falling back to part bounds for "${opName}".`,
    }
  }
  if (!hasFootprint) {
    return {
      mode: 'part-bounds',
      cause: 'stock-footprint-unavailable',
      reason:
        `stock-outline full-clear could not resolve the stock footprint -- ` +
        `falling back to part bounds for "${opName}".`,
    }
  }
  if (solidPartsOnStock > 1) {
    return {
      mode: 'part-bounds',
      cause: 'multiple-parts',
      reason:
        `stock-outline full-clear disabled: ${solidPartsOnStock} parts share this ` +
        `stock; clearing the whole stock would machine the neighbours. Falling back ` +
        `to part bounds for "${opName}" -- give each part its own stock (exclusion ` +
        `zones are a planned follow-up).`,
    }
  }
  return { mode: 'full-clear' }
}

/**
 * Resolve the ZDexelField cell size (mm), deterministically, when the op does
 * not override it (params.cellSize <= 0).
 *
 * Choice: tie the cell to the tool (diameter / 12) with a tolerance-driven floor,
 * clamped to [0.1, 1.0] mm. Rationale: the cell must resolve the narrowest
 * plan-view features the tool can reach (a fraction of the tool diameter) while
 * staying well under the ZDexelField cell budget (4M columns; e.g. a 100x100
 * job at 0.5 mm is 200x200 = 40k columns). It never goes below the chordal
 * tolerance (no point resolving finer than the path tolerance) nor below 0.1 mm
 * (the field coarsens loudly past the budget, so we stay comfortably inside it).
 */
export function deriveCellSize(tolerance: number, diameter: number): number {
  const byTool = diameter / 12;
  const raw = Math.max(byTool, tolerance);
  return Math.min(Math.max(raw, 0.1), 1.0);
}

/**
 * The cell size an adaptive_3d operation actually plans on: the op's own
 * override when it set one, else the derived value.
 *
 * Exported because the CALLER has to resolve the identical number BEFORE the
 * compute, to know whether a previously retained carve field describes this
 * operation's grid (WO-279). Two copies of that one-line rule could drift into
 * a wrong "same grid" answer, which is the one mistake that must not happen:
 * see restStartStockFor.
 */
export function resolveAdaptive3dCellSize(
  params: Pick<Adaptive3dParams, 'cellSize' | 'tolerance'>,
  toolDiameter: number,
): number {
  return params.cellSize > 0 ? params.cellSize : deriveCellSize(params.tolerance, toolDiameter);
}

/**
 * Build a fallback stock Box3 from a part mesh AABB (used when the real named
 * stock cannot be resolved, e.g. headless gates or auto-stock mode). The stock
 * top defaults to the part's own top (block-shaped fixtures ARE the stock);
 * optional margins expand the box outward / upward.
 */
export function stockBoundsFromMesh(
  mesh: PartMesh,
  margins?: { xy?: number; top?: number; bottom?: number },
): Box3 {
  const xy = margins?.xy ?? 0;
  const top = margins?.top ?? 0;
  const bottom = margins?.bottom ?? 0;
  return {
    minX: mesh.bounds.min[0] - xy,
    minY: mesh.bounds.min[1] - xy,
    minZ: mesh.bounds.min[2] - bottom,
    maxX: mesh.bounds.max[0] + xy,
    maxY: mesh.bounds.max[1] + xy,
    maxZ: mesh.bounds.max[2] + top,
  };
}

/**
 * WO-096. Resolve the planes the ROUGHER actually travels on, from the operation's
 * resolved envelope plus the material it is about to meet.
 *
 * Adaptive roughing starts at the physical stock top, not the part-mesh top, so
 * the safety planes co-move upward when the authored ones sit lower -- and the
 * values sent to the strategy are also the values returned as the operation's
 * display truth.
 *
 * The crash reported 2026-08-08 came from co-moving them to EXACTLY the material
 * top. A traverse plane level with the block is a scrape, not a clearance: it
 * leaves zero margin for stock oversize, fixture lift, or the z-dexel's own cell
 * staircase. The floor is therefore STRICTLY above the highest material -- the
 * stock box top, or the part itself if it pokes above the box -- by
 * ADAPTIVE_TRAVERSE_STANDOFF_MM, and adaptiveRough fails loud if that floor is missing.
 *
 * Pure and exported so a test can drive the exact production arithmetic without
 * standing up a worker.
 */
export function resolveAdaptive3dTraversePlanes(input: {
  resolvedHeights: Pick<ResolvedParallel3dHeights, 'feedZ' | 'retractZ' | 'clearanceZ'>;
  /** Top of the stock box the rougher will carve, mm. */
  stockTopZ: number;
  /** Top of the part mesh, mm (material too -- a part above the box still cuts). */
  partTopZ: number;
  /** Highest material the operation can meet, established from resolved real stock. */
  materialTopZ?: number;
}): { topZ: number; materialTopZ: number; feedZ: number; retractZ: number; clearanceZ: number } {
  const topZ = input.stockTopZ;
  if (!Number.isFinite(input.materialTopZ)) {
    // WO-305: named what a machinist can act on -- which block this part cuts
    // in, not "the top of material is not proven" (an internals sentence Operator
    // read as nonsensical, rightly). This still fires whenever the operation's
    // stock genuinely cannot be resolved (e.g. an explicit "no stock" part, or
    // a setup WCS bound to a different stock than the part) -- it is not
    // weakened, only reworded.
    throw new Error(
      "Adaptive 3D can't rough this part because it can't tell which block of stock the part " +
        "is cutting in, so it can't prove how high the material actually sits. Assign the part " +
        "to a stock (or point this setup's WCS origin at that stock), then regenerate.",
    );
  }
  const materialTopZ = Math.max(input.materialTopZ!, input.partTopZ);
  const minTraverseZ = materialTopZ + ADAPTIVE_TRAVERSE_STANDOFF_MM;
  const { feedZ, retractZ, clearanceZ } = input.resolvedHeights;
  if (clearanceZ < retractZ || retractZ < feedZ || feedZ < materialTopZ) {
    throw new Error(
      `Adaptive 3D heights must satisfy Clearance >= Retract >= Feed >= Material Start; ` +
        `got ${clearanceZ}, ${retractZ}, ${feedZ}, ${materialTopZ}.`,
    );
  }
  if (clearanceZ < minTraverseZ) {
    throw new Error(
      `Adaptive 3D Clearance Height ${clearanceZ} must be at least ${minTraverseZ} ` +
        `to clear proven material with the required standoff.`,
    );
  }
  return { topZ, materialTopZ, feedZ, retractZ, clearanceZ };
}

/**
 * WO-096 (fix round). Does `stockBounds` behave like the REAL stock this part
 * sits in -- i.e. does the box actually contain the part's own AABB, standing
 * strictly above it?
 *
 * This is a NECESSARY condition, never a sufficient one. A box that fails it
 * cannot be the stock; a box that passes it merely might be. The caller's
 * explicit assertion (`stockBoundsAreRealStock`) is what makes it sufficient --
 * only the caller knows whether the box came from a resolved stock object or
 * from the part-AABB fallback. Inferring "real stock" from a tall box was the
 * silent guess this WO's audit rejected.
 *
 * Completeness is exact: a tolerance can describe a small distance, but it
 * cannot prove that the stock field covers material outside its bounds. Any
 * shortfall therefore fails closed and disables below-clearance rapids.
 */
export function stockBoxContainsPart(stockBounds: Box3, partMesh: PartMesh): boolean {
  const [minX, minY, minZ] = partMesh.bounds.min;
  const [maxX, maxY, maxZ] = partMesh.bounds.max;
  return (
    stockBounds.minX <= minX &&
    stockBounds.minY <= minY &&
    stockBounds.minZ <= minZ &&
    stockBounds.maxX >= maxX &&
    stockBounds.maxY >= maxY &&
    // >=, not >: a box level with the part top is the block-shaped fixture where
    // the stock IS the part, which is complete. A box BELOW the part top leaves
    // material outside the carve field and cannot be this part's stock.
    stockBounds.maxZ >= maxZ
  );
}

/**
 * WO-279. What the app remembers about the carved field the LAST adaptive rough
 * left behind (WO-274 retains it worker-side; WO-277 lets the next rough start
 * from it). This record is how the app knows what that field describes, because
 * the field itself cannot say: its column tops are legitimately lower than the
 * box it was carved from.
 *
 * `client` is part of the identity on purpose. A retained field lives inside ONE
 * worker; disposing the cam3d client (a compute stall, a project swap) takes
 * every field with it while a bare handle number would survive here and name
 * nothing. Comparing the client object is the only exact way to know the field
 * is still there without asking the worker -- and asking is what must not happen,
 * since the answer for a dead handle is a refusal, not a fallback.
 */
export interface RetainedRoughField {
  /** The client owning the worker that holds the field. */
  client: Cam3dClient;
  /** Handle the worker answered with; the only way to name that field. */
  handle: StockHandle;
  /** Where the rough that carved it sat, and which solid it was carved around. */
  setupId: string;
  opId: string;
  geometryId: string;
  /** The box and grid it was carved AGAINST -- exactly what the worker compares. */
  stockBounds: Box3;
  cellSize: number;
  /** Identity of every enabled operation through the rough that produced this
   * field, in setup order. A reorder or upstream edit invalidates the field. */
  upstreamChainFingerprint: string;
  /**
   * WO-1619. Highest material the field still holds, in the part's display-local
   * frame (the carved-stock mesh's top). Absent when the preview mesh was skipped:
   * the caller then reads the material as standing at the stock top, which costs
   * air-cutting time, never a crash.
   */
  materialTopZ?: number;
}

/** The facts about the operation immediately before this one that the decision reads. */
export type PrecedingOperationFacts = Pick<Operation, 'id' | 'type' | 'status' | 'enabled'>;

/**
 * WO-279 THE CALL THE APP NEVER MADE. Decide whether this adaptive rough may
 * start from the field the last one retained -- i.e. whether the app asks for
 * rest machining at all.
 *
 * THE CALLER DECIDES. WO-277's worker-side refusal exists for a caller that
 * passed a handle it should not have; it is a backstop, never a control path.
 * So every condition is checked HERE, before the handle is passed, and anything
 * short of a certain match returns undefined -- this operation then plans from a
 * full stock box exactly as it always did. Nothing in this function can produce
 * an error: a machinist who reorders his operations must never see a job that
 * used to run start failing.
 *
 * The asymmetry that sets the bar: a doubt costs air-cutting time, while
 * believing a field that describes something else means driving a cutter into
 * material the app thinks is gone. So all of these must hold:
 *
 *  - the field is still in the worker this compute will use (same client);
 *  - the operation IMMEDIATELY BEFORE this one, in this setup, is the enabled
 *    3D rough that carved it, and its own toolpath is current ('ready').
 *    Retention is one field at a time (WO-274), so anything further back is a
 *    stale picture by construction;
 *  - it was carved around the same solid -- the field is in that part's
 *    display-local frame, so another part's carve is another job's material;
 *  - it was carved against exactly this stock box and cell size. Those are the
 *    two facts the worker itself compares, checked here so a mismatch costs a
 *    full-box plan instead of a refusal. Exact equality on purpose: a near-match
 *    is a different situation, and a NaN anywhere fails it, which is correct.
 */
export function restStartStockFor(input: {
  retained: RetainedRoughField | undefined;
  /** The client this compute will run on. */
  client: Cam3dClient;
  setupId: string;
  /** The operation immediately before this one in the same setup; undefined = this is the first. */
  previousOp: PrecedingOperationFacts | undefined;
  /** Solid this operation is machining. */
  geometryId: string | undefined;
  /** The stock box THIS operation would build its field from. */
  stockBounds: Box3;
  /** The cell size THIS operation plans on (resolveAdaptive3dCellSize). */
  cellSize: number;
  /** Complete enabled setup chain preceding the operation being planned. */
  upstreamChainFingerprint: string;
}): StockHandle | undefined {
  const { retained, previousOp } = input;
  if (retained === undefined || previousOp === undefined) return undefined;
  // Same worker: a handle from a disposed client names a field that no longer exists.
  if (retained.client !== input.client) return undefined;
  // Immediately before, same setup, and it really is the rough that carved this field.
  if (previousOp.type !== 'adaptive_3d' || !previousOp.enabled || previousOp.status !== 'ready') {
    return undefined;
  }
  if (retained.setupId !== input.setupId || retained.opId !== previousOp.id) return undefined;
  // Same solid: the field's frame is that part's.
  if (input.geometryId === undefined || retained.geometryId !== input.geometryId) return undefined;
  // Same grid and same block, checked BEFORE passing (this is what WO-277 refuses on).
  if (retained.cellSize !== input.cellSize) return undefined;
  if (retained.upstreamChainFingerprint !== input.upstreamChainFingerprint) return undefined;
  const mine = input.stockBounds;
  const carved = retained.stockBounds;
  if (
    carved.minX !== mine.minX ||
    carved.minY !== mine.minY ||
    carved.minZ !== mine.minZ ||
    carved.maxX !== mine.maxX ||
    carved.maxY !== mine.maxY ||
    carved.maxZ !== mine.maxZ
  ) {
    return undefined;
  }
  return retained.handle;
}

/**
 * WO-1619 (SH-5). The retained field a rest pass starts from, and the grid it
 * plans on. The operation's own grid first (restStartStockFor, unchanged). When
 * that grid is the AUTO one and the only thing between this operation and the
 * rough's field is the cell size -- a rest pass with a smaller tool derives a
 * finer grid than the rough carved on -- it plans on the rough's grid instead,
 * so it starts from what the rough left rather than re-roughing the whole block.
 * An explicit cell size is the operator's and is never replaced.
 */
export function resolveRestStart(input: Omit<Parameters<typeof restStartStockFor>[0], 'cellSize'> & {
  params: Pick<Adaptive3dParams, 'cellSize' | 'tolerance'>;
  toolDiameter: number;
}): { handle?: StockHandle; cellSize: number; adoptedRetainedGrid: boolean } {
  const own = resolveAdaptive3dCellSize(input.params, input.toolDiameter);
  const handle = restStartStockFor({ ...input, cellSize: own });
  if (handle !== undefined) return { handle, cellSize: own, adoptedRetainedGrid: false };
  const retained = input.retained;
  if (input.params.cellSize > 0 || retained === undefined || retained.cellSize === own) {
    return { cellSize: own, adoptedRetainedGrid: false };
  }
  const adopted = restStartStockFor({ ...input, cellSize: retained.cellSize });
  return adopted !== undefined
    ? { handle: adopted, cellSize: retained.cellSize, adoptedRetainedGrid: true }
    : { cellSize: own, adoptedRetainedGrid: false };
}

/**
 * WO-1678: no tool-reach input. The rough returns every move it plans; the store
 * trims the result to what the tool assembly reaches at its one seam
 * (trimToToolReachInPartFrame), the same trim and words as every other strategy.
 */
export interface ComputeAdaptive3dArgs {
  /** Already-acquired part mesh (see acquirePartMesh); the store owns byte fetch. */
  partMesh: PartMesh;
  tool: Tool;
  /** Optional caller assertion; the adapter always derives rotation from tool hand. */
  spindleRotation?: 'cw' | 'ccw';
  /**
   * Presence marks the app operation boundary, including an explicit undefined
   * value for "no override". Lower-layer geometry gates that omit the property
   * intentionally inspect raw role-only IR conversion.
   */
  feedrateOverride?: FeedrateOverride;
  params: Adaptive3dParams;
  /** Stock box the rougher builds its ZDexelField from (mesh frame, mm). */
  stockBounds: Box3;
  /**
   * WO-096. The CALLER asserts `stockBounds` was resolved from the real stock
   * object this part sits in, not from the part's own AABB (or any other
   * fallback). Absent/false -> the rougher's traverse guard treats its stock
   * field as possibly incomplete and routes every below-clearance link over the
   * clearance plane.
   *
   * This assertion proves both the material top and the whole stock field, so it
   * licenses Stay Down. No Box3 shape or height relationship can establish
   * provenance: absent/false also leaves the material top unproven, and the
   * thrown error is surfaced as the operation error message.
   */
  stockBoundsAreRealStock?: boolean;
  /** Clearance/retract planes in the SAME frame as the part mesh z. */
  resolvedHeights: ResolvedParallel3dHeights;
  /** Job clip rings (geom2d convention: outers CCW, holes CW); undefined -> none. */
  boundary?: readonly Ring[];
  /**
   * Corner-reach (Stage C-2), mm the cut region is dilated OUTWARD past the
   * stock edge. Set by the caller ONLY in the full-clear branch (field == stock);
   * 0/undefined in part-bounds / fallback mode. Forwarded verbatim to the strategy.
   */
  reachStockEdgeBy?: number;
  /**
   * OPT-IN side entry (outside-in). STORE-DERIVED: set by the caller only after the
   * safety gate passes (single unspun footprinted part in open stock); never read
   * from params here. Forwarded verbatim to the strategy. undefined/false -> the
   * default inside-out helix (byte-identical to today).
   */
  sideEntry?: boolean;
  /**
   * WO-279. Start from the carved field the PREVIOUS rough retained (WO-277)
   * instead of a full stock box, so this operation only works the material that
   * one could not reach. Absent -> full box, exactly as before.
   *
   * CALLER-DECIDED, never inferred here: pass it only after restStartStockFor
   * says this situation matches the one the field was carved for. The worker
   * REFUSES a handle that does not match (it does not adapt), so a caller that
   * guesses turns a working job into a failing one.
   */
  startFromStock?: StockHandle;
  client: Cam3dClient;
  signal?: AbortSignal;
  onProgress?: Cam3dProgressCallback;
}

/** Smart Height V2 supplies the final cutter-center floor after allowance. */
export function resolveAdaptive3dFloorZ(input: Pick<
  ComputeAdaptive3dArgs,
  'resolvedHeights'
>): number {
  return input.resolvedHeights.bottomZ
}

/**
 * Compute the adaptive_3d rough toolpath moves through the cam3d worker. The
 * cell size is resolved here (params override, else deriveCellSize). The
 * authored Bottom plane (plus any axial stock to leave) is forwarded as the
 * roughing floor; deriving a floor from the part heightfield would discard the
 * operation's explicit Z limit.
 */
export async function computeAdaptive3dMoves(
  args: ComputeAdaptive3dArgs,
): Promise<{
  moves: ToolpathMove[];
  computeTimeMs: number;
  /** Carved-stock preview mesh (Chunk C3); absent when meshing was skipped. */
  carvedStock?: StockMesh;
  /** Reason the carved-stock preview was skipped (ADR-0003), when absent. */
  carvedStockWarning?: string;
  /**
   * WO-274/WO-279: handle to the carved field the worker RETAINED for this run.
   * The caller records it (with what it was carved against) so the NEXT rough in
   * the setup can start from it. Absent when the strategy handed back no field.
   */
  carvedStockHandle?: StockHandle;
  /**
   * The cell size this run actually planned on (params override or derived).
   * Returned so the caller records the field's grid as the truth it was carved
   * with, rather than a second, separately-resolved copy of the same number.
   */
  cellSize: number;
  /** Structured skipped/partial-region diagnostics. */
  diagnostics?: OperationDiagnostics;
  /** Exact strategy-local envelope used by this generated path. */
  heightTruth: ResolvedParallel3dHeights;
  /** WO-1540: what this generation substituted or left out, in plain words, for the app console. */
  notices?: string[];
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  const notices: string[] = [];
  const cellSize = resolveAdaptive3dCellSize(args.params, args.tool.diameter);
  const spindleRotation = spindleRotationForTool(args.tool);
  if (args.spindleRotation !== undefined && args.spindleRotation !== spindleRotation) {
    throw new Error(
      `Adaptive 3D spindle rotation ${args.spindleRotation} conflicts with the selected ` +
        `${args.tool.cutHand === 'left' ? 'left' : 'right'}-hand tool (${spindleRotation}).`,
    );
  }

  const stockBoundsAreRealStock =
    args.stockBoundsAreRealStock === true && stockBoxContainsPart(args.stockBounds, args.partMesh);
  // Provenance is a caller fact, never a relationship inferred from two Z
  // values. A taller arbitrary box can belong to another stock just as easily
  // as this one; only the store that resolved the selected stock may assert it.
  const provenMaterialTopZ = stockBoundsAreRealStock
    ? Math.max(args.stockBounds.maxZ, args.partMesh.bounds.max[2])
    : undefined;

  const { topZ, materialTopZ, feedZ, retractZ, clearanceZ } = resolveAdaptive3dTraversePlanes({
    resolvedHeights: args.resolvedHeights,
    stockTopZ: args.stockBounds.maxZ,
    partTopZ: args.partMesh.bounds.max[2],
    materialTopZ: provenMaterialTopZ,
  });
  const heights = { clearanceZ, retractZ, feedZ };

  const t0 = performance.now();
  const roughed = await args.client.generateAdaptiveRough(
    {
      partMesh: args.partMesh,
      cutter,
      stockBounds: args.stockBounds,
      cellSize,
      maxStepdown: args.params.maxStepdown,
      stepover: args.params.stepover,
      millingDirection: args.params.millingDirection,
      intermediateStepdown: args.params.intermediateStepdown,
      spindleRotation,
      wallLeadInRadius: args.params.wallLeadInRadius,
      wallLeadOutRadius: args.params.wallLeadOutRadius,
      loopbackFilletPct: args.params.loopbackFilletPct,
      integralWallFollow: args.params.integralWallFollow,
      integralWallFollowLengthFactor: args.params.integralWallFollowLengthFactor,
      tolerance: args.params.tolerance,
      helixDiameter: args.params.helixDiameter,
      helixAngleDeg: args.params.helixAngleDeg,
      radialStockToLeave: args.params.radialStockToLeave,
      axialStockToLeave: args.params.axialStockToLeave,
      heights,
      materialTopZ,
      floorZ: resolveAdaptive3dFloorZ(args),
      ...(stockBoundsAreRealStock ? { stockBoundsAreRealStock: true } : {}),
      ...(args.boundary !== undefined ? { boundary: args.boundary } : {}),
      ...(args.reachStockEdgeBy !== undefined ? { reachStockEdgeBy: args.reachStockEdgeBy } : {}),
      ...(args.sideEntry ? { sideEntry: true } : {}),
      // WO-279: rest machining. Forwarded verbatim; the decision to pass it at
      // all belongs to the caller (restStartStockFor), because only the caller
      // knows which operation ran before this one.
      ...(args.startFromStock !== undefined ? { startFromStock: args.startFromStock } : {}),
    },
    { signal: args.signal, onProgress: args.onProgress, onNotice: (message) => { notices.push(message); } },
  );
  const { ir, carvedStock, carvedStockWarning, diagnostics, carvedStockHandle } = roughed;
  const computeTimeMs = performance.now() - t0;

  const resolvedFeeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride)
    : undefined;
  const moves = irToToolpathMoves(ir, resolvedFeeds);
  if (moves.length === 0) {
    // ADR-0003: an empty result is a loud failure, never a silently-empty op.
    throw new Error(
      'adaptive_3d produced no toolpath moves. The stock box may not enclose the ' +
        'part, the floor may sit at the stock top (nothing to rough), or the ' +
        'boundary may exclude the whole part.',
    );
  }
  const floorZ = ir.meta.params?.floorZ;
  if (typeof floorZ !== 'number' || !Number.isFinite(floorZ) || floorZ >= topZ) {
    throw new Error(
      `adaptive_3d returned an invalid cutting floor (${String(floorZ)}) for stock top ${topZ}.`,
    );
  }
  const heightTruth: ResolvedParallel3dHeights = {
    clearanceZ,
    retractZ,
    feedZ,
    topZ,
    bottomZ: floorZ,
  };
  return {
    moves,
    computeTimeMs,
    heightTruth,
    cellSize,
    ...(carvedStockHandle !== undefined ? { carvedStockHandle } : {}),
    ...(carvedStock !== undefined ? { carvedStock } : {}),
    ...(carvedStockWarning !== undefined ? { carvedStockWarning } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}
