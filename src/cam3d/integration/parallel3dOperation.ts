// cam3d integration (L6 bridge): the parallel_3d operation adapter.
//
// This module OWNS the cam3d-side orchestration of a parallel (raster) 3D
// finishing pass, dependency-injected so it is headless-testable without the
// zustand store or IndexedDB. The store (browser) fetches the source bytes and
// resolves heights/boundary, then hands them here; everything cam3d-specific
// (CutterSpec build, PathBuildHeights + zSeed mapping, the client call, IR ->
// ToolpathMove[] conversion) lives in this one place.
//
// Layering: an L6 bridge may import src/types, the cam3d client, cam3d/input,
// geom2d, and src/mesh's leaf domain modules (pure functions over typed
// arrays - no store, no IndexedDB, no kernel). It never reaches into
// strategy/kernel internals.
//
// Determinism (D-006): the returned moves are byte-identical for identical
// inputs. `computeTimeMs` is wall-clock and intentionally NOT part of the
// determinism contract (it is diagnostic only, exactly like the store's other
// compute paths).

import type { Parallel3dParams } from '../../kernel/parameterTypes';
export type { Parallel3dParams } from '../../kernel/parameterTypes';
export { DEFAULT_PARALLEL3D_PARAMS } from '../../kernel/parameterDefaults';
export { readParallel3dParams } from '../../kernel/schema';

import type { CutterSpec, PartMesh } from '../kernel/types';
import type { PathBuildHeights } from '../pathbuild';
import type { Ring } from '../geom2d';
import { area as ringArea, boolean as ringBoolean, ensureGeom2dReady, offset as ringOffset } from '../geom2d';
import type { Cam3dClient } from '../worker/client';
import { irToToolpathMoves } from '../ir/toToolpathMoves';
import { importStlToPartMesh, importStepToPartMesh } from '../input';
import { resolveEditedStlBytes } from '../../mesh/edit';
import type { MeshEditRecord } from '../../mesh/edit';
import type { Cam3dFaceScope, FeedrateOverride, ToolpathMove, Tool } from '../../types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { toolToCutterSpec } from './cutterSpec';

// ---------------------------------------------------------------------------
// WO-1271: the stock-edge overrun.
//
// The strategy clips its scanlines to a containment region and samples the
// tool CENTRE from end to end of each clipped span. A pass that stops with
// its axis on the containment edge therefore leaves one tool radius of
// material outside the cut; for a FLAT cutter on a surface that slopes down
// toward the edge, every point within one radius of the edge is left at the
// height of the higher material inside the footprint (a wedge R wide, up to
// R * slope tall), and the between-pass scallops cut that wedge into the comb
// of fins Operator saw on the shakedown wave. A ball cutter leaves the crescent he
// reasoned about. Same cause either way: the centre is clipped, the edge is
// not.
//
// The cure is the ADR-0015 s2 outward-overrun convention, already carried by
// 2D Face (passExtension, auto tool radius) and Adaptive Rough 3D
// (stockEdgeOvershoot, auto tool radius): let the centre travel one radius
// past the edge so the cutter's trailing rim clears it. WHERE that is right:
//
//   stock outline (useStockBoundary)   every edge is the stock edge; nothing
//                                      beyond it but air. Overrun.
//   part bounds (default)              the mesh AABB. Beyond it is either the
//                                      stock edge or a margin of unroughed
//                                      stock. There is no way to finish a part
//                                      edge without the cutter passing beyond
//                                      it, and the RIM already engages one
//                                      radius of that margin at model height
//                                      on every pass end today; overrun makes
//                                      it two. A finish assumes roughing. Overrun.
//   face scope (WO-1223)               the region is a SELECTION edge, inset
//                                      by the radius so the pass cuts nothing
//                                      outside the chosen faces. That edge is
//                                      a wall in the ADR-0015 sense. NEVER.
//   walls inside the region            ridden over by construction: Z comes
//                                      from a drop against the whole mesh, so
//                                      a raster cannot cut into a model wall.
//
// What the model cannot see is a clamp or fixture standing beside the stock;
// the two sibling implementations accept the same blind spot at the same
// radius, and the operator is told in the help text.
// ---------------------------------------------------------------------------

/**
 * The overrun stops this far short of the requested distance. At EXACTLY one
 * radius the cutter footprint is tangent to the edge and the drop cutter may
 * register a miss (no triangle under the disk), which would put the last
 * sample of every pass on the miss-hold rule instead of on the surface. A
 * hundredth of a millimetre keeps a sliver of part under the footprint so the
 * final sample is a real surface height. Do not "clean this up" to zero.
 */
export const STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM = 0.01;

/** Round joins on the outward offset are polygonal to this many mm of the true arc. */
const STOCK_EDGE_OVERRUN_ARC_TOLERANCE_MM = 0.01;

export interface StockEdgeOverrunInput {
  /** mm. AUTO (undefined) is this. */
  cutterRadius: number;
  /** The operator's setting: undefined = auto (tool radius), 0 = none. */
  stockEdgeOvershoot?: number;
  /** BRep face ids the pass is aimed at; a non-empty scope disables the overrun. */
  faceScope?: readonly number[];
  /** The containment region when one was resolved (stock footprint), else undefined. */
  boundary?: readonly Ring[];
  /** The caller's vouch for `boundary` (see ComputeParallel3dArgs.boundaryKind). */
  boundaryKind?: 'stock' | 'selection';
  /** The part xy-bounds rectangle the strategy would contain to when `boundary` is absent. */
  xyBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface StockEdgeOverrunDecision {
  /** mm the tool centre may travel past the containment edge (0 = none). */
  overrunMm: number;
  /** The tool-centre region for the strategy; absent when overrunMm is 0. */
  rings?: Ring[];
  /** Why, in one line, for the console and the IR consumer. */
  reason: string;
  /** True when a caller handed over a boundary without saying what it is (ADR-0003: said out loud). */
  unvouched?: boolean;
}

/** The strategy's own containment rectangle for the xy-bounds fallback (same vertex order). */
export function xyBoundsRing(b: { minX: number; minY: number; maxX: number; maxY: number }): Ring {
  return new Float64Array([b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY]);
}

/**
 * Decide the stock-edge overrun and build the tool-centre region: the
 * containment region offset OUTWARD by the overrun with round joins, so at a
 * convex corner the centre stays within one radius of the apex and the
 * footprint always keeps a sliver of part under it. Deterministic.
 */
export async function resolveStockEdgeOverrun(
  input: StockEdgeOverrunInput,
): Promise<StockEdgeOverrunDecision> {
  const requested = input.stockEdgeOvershoot ?? input.cutterRadius;
  if (input.faceScope !== undefined && input.faceScope.length > 0) {
    return { overrunMm: 0, reason: 'face-scoped pass: the selection edge is a wall, region stays inset' };
  }
  if (input.boundary !== undefined && input.boundaryKind !== 'stock') {
    // A composer (steep/shallow) hands over a selection region it already
    // inset, with the scope consumed; only its vouch can tell that edge from
    // a stock outline. No vouch -> no overrun: forgetting costs a fin, never
    // a gouge (the (A)-vs-(B) decision on WO-1271).
    return input.boundaryKind === 'selection'
      ? { overrunMm: 0, reason: 'selection region: its edge is a wall, region stays inset' }
      : {
          overrunMm: 0,
          unvouched: true,
          reason: 'the caller did not say whether this boundary is a stock outline; no overrun applied',
        };
  }
  const overrunMm = requested - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM;
  if (!(overrunMm > 0)) {
    return {
      overrunMm: 0,
      reason: input.stockEdgeOvershoot === 0
        ? 'stock-edge overrun set to 0: the cutter stops with its axis on the edge'
        : `stock-edge overrun ${requested.toFixed(3)} mm is inside the tangent margin; none applied`,
    };
  }
  await ensureGeom2dReady();
  const region: readonly Ring[] = input.boundary ?? [xyBoundsRing(input.xyBounds)];
  const rings = ringOffset(region, overrunMm, {
    joinType: 'round',
    arcTolerance: STOCK_EDGE_OVERRUN_ARC_TOLERANCE_MM,
  });
  if (rings.length === 0) {
    // An outward offset cannot annihilate a region; if it did, the containment
    // was not a region. Named, never silent (ADR-0003).
    throw new Error('Parallel 3D: the containment region could not be offset outward for the stock-edge overrun.');
  }
  return {
    overrunMm,
    rings,
    reason: `${input.stockEdgeOvershoot === undefined ? 'auto (tool radius)' : 'set'} ` +
      `${requested.toFixed(3)} mm past the ${input.boundary !== undefined ? 'stock outline' : 'part bounds'}`,
  };
}

// ---------------------------------------------------------------------------
// WO-1223: aiming a finishing pass at CHOSEN FACES.
//
// The wire was already laid: a STEP import carries one BRep face id per
// triangle on PartMesh.faceIds (cam3d/input/step.ts), and every finishing
// strategy already takes a CONTAINMENT REGION (`boundary`, geom2d rings) that
// its scanlines / z-levels are clipped to. This block connects the two: it
// turns "these face ids" into the containment region the five finish
// strategies already honour. No strategy or kernel change, no second mesh.
//
// CONTAINMENT, NOT CROPPING. The mesh handed to the planner is the WHOLE part,
// unchanged, so every drop-cutter probe still sees the real surface and the
// pass rides over unselected geometry instead of gouging into a hole where
// triangles were deleted. What the region controls is where the tool may be
// DOWN, i.e. where it may cut.
//
// THE REGION IS INSET BY THE CUTTER RADIUS. A containment ring that bounds the
// tool CENTRE still lets a 3 mm ball touch material 1.5 mm outside the chosen
// faces, and the promise here is that a face-scoped pass cuts ZERO length
// outside its selection. Insetting by the radius puts the whole cutter inside
// the selection instead of just its axis. The cost is the outermost radius of
// each chosen face going unmachined by THIS pass, which is the standard
// "tool contained by boundary" trade and the only one that can keep the
// promise.
//
// OCCLUDERS ARE SUBTRACTED. A drop cutter contacts the TOPMOST surface under
// it, so being inside a chosen face's footprint is not on its own enough: a
// boss standing on a chosen floor would be cut by a pass aimed at the floor.
// Anything unselected that reaches above the lowest chosen surface therefore
// has its footprint removed from the region. The rule is deliberately
// conservative (one global z comparison, not a per-pair one): it can only ever
// remove region, never add it, so it cannot break the zero-cut promise.
// ---------------------------------------------------------------------------

/** Below this a projected triangle is a vertical face seen edge-on, not a region. */
const MIN_PROJECTED_TRIANGLE_AREA_MM2 = 1e-9;

/**
 * Round joins on the inward offset are polygonal to this many mm of the true
 * arc (geom2d OffsetOptions.arcTolerance). Pinned here rather than left to the
 * package default so the clearance below is provably larger than it.
 */
const FACE_SCOPE_ARC_TOLERANCE_MM = 0.01;

/**
 * Extra mm the containment region is inset BEYOND the cutter radius.
 *
 * Inset by exactly the radius leaves the cutter TANGENT to whatever stands on
 * the chosen face -- the wall of a boss rooted in a selected floor, the rim of
 * a selected pocket floor. Tangent is not a cut, but it is a rub, it is where
 * the arc approximation above (and clipper's 1e-6 mm coordinate grid) can put
 * the tool a hair on the wrong side, and it is measurably not "zero length
 * outside the selection". Five times the arc tolerance buys the margin at a
 * cost of 0.05 mm of reach into each chosen face's own edge.
 */
const FACE_SCOPE_EDGE_CLEARANCE_MM = 0.05;

/** Ring sets are unioned in batches so a 100k-triangle STEP is one bounded pass, not one giant call. */
const RING_UNION_BATCH = 4_000;

/** Thrown when a face scope cannot produce a machinable region. Named, never silent (ADR-0003). */
export class FaceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceScopeError';
  }
}

/**
 * Read a face scope out of an untyped `op.params` record. Accepts the stored
 * `{ faceIds: number[] }` shape and a bare `number[]`; anything else, and any
 * non-integer / negative member, is dropped. Returns undefined for "whole
 * part" so the caller's default path stays literally unchanged.
 */
export function readFaceScope(params: Record<string, unknown>): number[] | undefined {
  const raw = params.faceScope;
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as Cam3dFaceScope).faceIds)
      ? (raw as Cam3dFaceScope).faceIds
      : undefined;
  if (list === undefined) return undefined;
  const ids = [...new Set(
    list.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0),
  )].sort((a, b) => a - b);
  return ids.length > 0 ? ids : undefined;
}

/**
 * WO-1223: the face scope a FORM may show and save while it is pointed at one
 * particular solid.
 *
 * A face id is an index into ONE part's BRep. It means nothing against another
 * part, and a mesh has no BRep for it to mean anything against at all -- so a
 * scope picked on solid A that survives a switch to solid B does not select
 * "nothing", it selects whatever faces B happens to number 3 and 8, which is a
 * different pass on different metal.
 *
 * This is the one place that rule is written down: a scope is live only while
 * the form still points at the solid its faces were picked on, and only while
 * that solid is a STEP part. Every other answer is the whole part -- for the
 * READING and for the SAVE in the same breath, so the two can never disagree
 * and no stale id can be written behind a form that says "All faces".
 */
export function faceScopeForSource(
  pick: { partId?: string; faceIds?: readonly number[] },
  source: { id?: string; format?: string },
): number[] {
  if (!source.id || source.format !== 'step') return [];
  if (!pick.partId || pick.partId !== source.id) return [];
  return [...new Set(pick.faceIds ?? [])].sort((a, b) => a - b);
}

/** Cutter radius in mm for any supported profile (all four are round in plan). */
export function cutterRadius(cutter: CutterSpec): number {
  return cutter.diameter / 2;
}

/** One triangle's XY projection as a geom2d OUTER ring, or null if it is edge-on. */
function projectedTriangleRing(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): Ring | null {
  const ax = positions[a * 3], ay = positions[a * 3 + 1];
  const bx = positions[b * 3], by = positions[b * 3 + 1];
  const cx = positions[c * 3], cy = positions[c * 3 + 1];
  const twiceArea = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(twiceArea) / 2 < MIN_PROJECTED_TRIANGLE_AREA_MM2) return null;
  // Orientation is semantic in geom2d: force CCW so every triangle ADDS region.
  return twiceArea > 0
    ? new Float64Array([ax, ay, bx, by, cx, cy])
    : new Float64Array([ax, ay, cx, cy, bx, by]);
}

/** Union a ring list in bounded batches (see RING_UNION_BATCH). Empty in -> empty out. */
function unionRings(rings: readonly Ring[]): Ring[] {
  if (rings.length === 0) return [];
  let accumulated: Ring[] = [];
  for (let i = 0; i < rings.length; i += RING_UNION_BATCH) {
    const batch = rings.slice(i, i + RING_UNION_BATCH);
    // geom2d's NonZero fill merges overlapping outers WITHIN one operand, so a
    // batch unioned against its own first ring is exactly that batch's union.
    const merged = ringBoolean(batch, [batch[0]], 'union');
    accumulated = accumulated.length === 0
      ? merged
      : merged.length === 0
        ? accumulated
        : ringBoolean(accumulated, merged, 'union');
  }
  return accumulated;
}

export interface FaceScopeBoundaryInput {
  /** The whole part, unchanged. Its `faceIds` are what the scope names. */
  partMesh: PartMesh;
  /** BRep face ids the pass is aimed at. undefined/empty = whole part. */
  faceScope?: readonly number[];
  /** The containment the caller already resolved (stock footprint); intersected with the scope. */
  boundary?: readonly Ring[];
  /** mm. The region is inset by this so the WHOLE cutter stays inside the selection. */
  cutterRadius: number;
  /** Operation name used in console lines and refusals ("Parallel 3D"). */
  operationLabel: string;
  /** WO-1540: receives the operator notice when the scope cannot be honoured. */
  onNotice?: (message: string) => void;
}

/**
 * Turn a face scope into the containment region the finish strategies take.
 *
 * Returns `input.boundary` UNCHANGED (same reference) whenever there is no
 * scope to apply -- that is the whole-part path, and it must stay identical.
 * Throws a named FaceScopeError when a scope was asked for and cannot be
 * honoured; it never falls back to machining the whole part behind the
 * operator's back (ADR-0003).
 */
export async function resolveFaceScopedBoundary(
  input: FaceScopeBoundaryInput,
): Promise<readonly Ring[] | undefined> {
  const scope = input.faceScope;
  if (scope === undefined || scope.length === 0) return input.boundary;

  const { partMesh, operationLabel } = input;
  const faceIds = partMesh.faceIds;
  if (faceIds === undefined) {
    // Every STL is this case: a triangle soup has no BRep faces to aim at.
    // One console line, no UI notice (COHESION-STANDARD s13) -- the form's
    // control is already disabled for such a source.
    console.warn(
      `[${operationLabel}] this ${partMesh.source.toUpperCase()} part carries no BRep face ids, ` +
        'so a face selection cannot be honoured; machining the whole part.',
    );
    input.onNotice?.(
      `this ${partMesh.source.toUpperCase()} part carries no face ids, so the face selection could not be ` +
        'honoured and the whole part was machined.',
    );
    return input.boundary;
  }

  const wanted = new Set(scope);
  const selected: Ring[] = [];
  const triCount = partMesh.indices.length / 3;
  let selectedTriangles = 0;
  let selectedMinZ = Infinity;
  for (let t = 0; t < triCount; t++) {
    if (!wanted.has(faceIds[t])) continue;
    selectedTriangles++;
    const a = partMesh.indices[t * 3], b = partMesh.indices[t * 3 + 1], c = partMesh.indices[t * 3 + 2];
    for (const v of [a, b, c]) selectedMinZ = Math.min(selectedMinZ, partMesh.positions[v * 3 + 2]);
    const ring = projectedTriangleRing(partMesh.positions, a, b, c);
    if (ring !== null) selected.push(ring);
  }
  if (selectedTriangles === 0) {
    throw new FaceScopeError(
      `${operationLabel} is aimed at face${scope.length === 1 ? '' : 's'} ${scope.join(', ')}, but this ` +
        'part has no geometry on them. Re-pick the faces (the part may have been re-imported or edited).',
    );
  }

  await ensureGeom2dReady();
  let region = unionRings(selected);
  if (region.length === 0) {
    throw new FaceScopeError(
      `${operationLabel} is aimed at face${scope.length === 1 ? '' : 's'} ${scope.join(', ')}, which are ` +
        'vertical (they have no footprint seen from the tool). A 3-axis finish cannot be aimed at them alone.',
    );
  }

  // Subtract the footprint of everything unselected that stands above the
  // lowest chosen surface -- see OCCLUDERS ARE SUBTRACTED above.
  const occluders: Ring[] = [];
  for (let t = 0; t < triCount; t++) {
    if (wanted.has(faceIds[t])) continue;
    const a = partMesh.indices[t * 3], b = partMesh.indices[t * 3 + 1], c = partMesh.indices[t * 3 + 2];
    const maxZ = Math.max(
      partMesh.positions[a * 3 + 2], partMesh.positions[b * 3 + 2], partMesh.positions[c * 3 + 2],
    );
    if (maxZ <= selectedMinZ) continue;
    const ring = projectedTriangleRing(partMesh.positions, a, b, c);
    if (ring !== null) occluders.push(ring);
  }
  if (occluders.length > 0) {
    const occluding = unionRings(occluders);
    if (occluding.length > 0) region = ringBoolean(region, occluding, 'difference');
  }

  const inset = input.cutterRadius + FACE_SCOPE_EDGE_CLEARANCE_MM;
  if (region.length > 0) {
    region = ringOffset(region, -inset, { arcTolerance: FACE_SCOPE_ARC_TOLERANCE_MM });
  }
  if (region.length === 0 || Math.abs(region.reduce((s, r) => s + ringArea(r), 0)) < MIN_PROJECTED_TRIANGLE_AREA_MM2) {
    throw new FaceScopeError(
      `${operationLabel} is aimed at face${scope.length === 1 ? '' : 's'} ${scope.join(', ')}, but nothing ` +
        `is left to cut once the ${(input.cutterRadius * 2).toFixed(3)} mm cutter is kept fully inside ` +
        'them (and clear of anything standing above them). Pick a larger face set or a smaller tool.',
    );
  }

  if (input.boundary !== undefined) {
    region = ringBoolean(region, input.boundary, 'intersect');
    if (region.length === 0) {
      throw new FaceScopeError(
        `${operationLabel} is aimed at face${scope.length === 1 ? '' : 's'} ${scope.join(', ')}, but none of ` +
          'them lies inside the stock footprint this operation is clipped to.',
      );
    }
  }
  return region;
}

/** The height planes the adapter needs, in the SAME frame as the part mesh z. */
export interface ResolvedParallel3dHeights {
  /** Authored safe traverse level; the traverse plane is never below this. */
  clearanceZ: number;
  /** Safe retract/link plane above Feed Height. */
  retractZ: number;
  /** Lowest rapid-descent endpoint; ramp/plunge motion starts here. */
  feedZ: number;
  /** Model top (highest surface z). Informational for M1. */
  topZ: number;
  /** Model bottom (lowest surface z). Bounds the drop floor. */
  bottomZ: number;
  /**
   * WO-127. PROVEN top of the in-process stock, in the same frame as the part
   * mesh z. Supply it ONLY when the caller actually knows where the material
   * ends; every rapid is then floored on it rather than on the part.
   *
   * Leave it undefined when the stock is unknown. It is deliberately NOT
   * defaulted to `topZ`: "the part top" is the exact assumption that put a
   * RAPID at Z 7.650 through Operator's 14 mm part (WO-096), and this adapter warns
   * rather than repeat it. The store does not pass it yet -- see the fallback
   * warning in computeParallel3dMoves.
   */
  stockTopZ?: number;
}

/**
 * WO-1678: no tool-reach input. The finish returns every move it plans; the
 * store trims the result to what the tool assembly reaches at its one seam
 * (trimToToolReachInPartFrame), the same trim and words as every other strategy.
 */
export interface ComputeParallel3dArgs {
  /** Already-acquired part mesh (see acquirePartMesh); the store owns byte fetch. */
  partMesh: PartMesh;
  tool: Tool;
  /**
   * Presence marks the app operation boundary, including an explicit undefined
   * value for "no override". Lower-layer geometry gates that omit the property
   * intentionally inspect raw role-only IR conversion.
   */
  feedrateOverride?: FeedrateOverride;
  params: Parallel3dParams;
  resolvedHeights: ResolvedParallel3dHeights;
  /** Stock outline rings (geom2d convention: outers CCW, holes CW); undefined -> part xy-bounds. */
  boundary?: readonly Ring[];
  /**
   * WO-1271. What `boundary` IS, vouched by the caller: 'stock' = the proven
   * stock outline (nothing beyond it but air; the stock-edge overrun applies),
   * 'selection' = a face-scope region already inset by the radius (its edge
   * is a wall; never overrun). A caller-provided boundary with NO vouch gets
   * no overrun and one console line saying so -- the safe failure. Forgetting
   * this field can cost a fin; it can never cost a gouge. Ignored when
   * `boundary` is undefined (part bounds, the adapter's own authority).
   */
  boundaryKind?: 'stock' | 'selection';
  /**
   * WO-1223. BRep face ids this pass is aimed at (Cam3dFaceScope). Absent or
   * empty = the whole part, byte-identical to the pre-WO-1223 output.
   */
  faceScope?: readonly number[];
  client: Cam3dClient;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** xy-bounds fallback (used when no stock boundary is given), from the mesh AABB. */
function xyBoundsFromMesh(mesh: PartMesh): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return {
    minX: mesh.bounds.min[0],
    minY: mesh.bounds.min[1],
    maxX: mesh.bounds.max[0],
    maxY: mesh.bounds.max[1],
  };
}

/**
 * Compute the parallel_3d toolpath moves through the cam3d worker.
 *
 * zSeed policy: the kernel's drop FLOOR must sit AT or BELOW the lowest surface
 * (kernel/types.ts GridSpec doc — every drop result is raised to be >= zSeed,
 * and a miss returns zSeed itself). We take the lower of the model's minimum
 * surface z and the resolved bottom plane, so a miss can never read as material
 * above the true floor and a pass can never be seeded above a real surface.
 */
export async function computeParallel3dMoves(
  args: ComputeParallel3dArgs,
): Promise<{
  moves: ToolpathMove[];
  computeTimeMs: number;
  /** WO-1540: what this generation substituted or left out, in plain words, for the app console. */
  notices?: string[];
}> {
  const cutter: CutterSpec = toolToCutterSpec(args.tool);
  const notices: string[] = [];
  const onNotice = (message: string) => { notices.push(message); };

  const stockTopZ = args.resolvedHeights.stockTopZ;
  if (stockTopZ === undefined) {
    // ADR-0003: a fallback is LOUD, never silent. Without a proven material top
    // the traverse plane is only as safe as the authored clearance, and the
    // resolver that produces it floors on the PART (topZ), so an authored
    // clearance below the stock top yields rapids inside uncleared stock. Named
    // limitation, not a guess -- WO-127.
    console.warn(
      '[parallel3d] no proven stock top: traverse safety falls back to the authored ' +
        `clearance z=${args.resolvedHeights.clearanceZ} (part top z=${args.resolvedHeights.topZ}). ` +
        'Rapids are NOT proven clear of uncleared stock above the part.',
    );
    onNotice(
      `no stock top was proven, so rapids use the authored clearance height (z=${args.resolvedHeights.clearanceZ}) ` +
        'and are not proven clear of uncut stock above the part.',
    );
  }
  const heights: PathBuildHeights = {
    clearanceZ: args.resolvedHeights.clearanceZ,
    retractZ: args.resolvedHeights.retractZ,
    feedZ: args.resolvedHeights.feedZ,
    ...(stockTopZ !== undefined ? { materialTopZ: stockTopZ } : {}),
  };
  const zSeed = Math.min(args.partMesh.bounds.min[2], args.resolvedHeights.bottomZ);
  const boundary = await resolveFaceScopedBoundary({
    partMesh: args.partMesh,
    faceScope: args.faceScope,
    boundary: args.boundary,
    cutterRadius: cutterRadius(cutter),
    operationLabel: 'Parallel 3D',
    onNotice,
  });
  // WO-1271: the tool-centre region. `boundary` here is the face-scoped
  // region when a scope was given (and the decision then refuses), else the
  // caller's stock footprint or nothing (part bounds).
  const overrun = await resolveStockEdgeOverrun({
    cutterRadius: cutterRadius(cutter),
    stockEdgeOvershoot: args.params.stockEdgeOvershoot,
    faceScope: args.faceScope,
    boundary,
    boundaryKind: args.boundaryKind,
    xyBounds: xyBoundsFromMesh(args.partMesh),
  });
  if (overrun.unvouched) {
    // ADR-0003: a capability withheld for want of information is said out loud.
    console.warn(`[parallel3d] stock-edge overrun: ${overrun.reason}.`);
    onNotice(
      'the stock-edge overrun was not applied because the boundary was not confirmed as the stock outline, ' +
        'so a fin may be left at the edge.',
    );
  }

  const t0 = performance.now();
  const ir = await args.client.generateParallelFinish(
    {
      partMesh: args.partMesh,
      cutter,
      stepover: args.params.stepover,
      angleDeg: args.params.angleDeg,
      tolerance: args.params.tolerance,
      surfaceStockToLeave: args.params.surfaceStockToLeave ?? 0,
      ...(args.params.maxSlopeDeg !== undefined
        ? { maxSlopeDeg: args.params.maxSlopeDeg }
        : {}),
      ...(args.params.finishDepth !== undefined
        ? { minFinishZ: args.resolvedHeights.topZ - args.params.finishDepth }
        : {}),
      heights,
      zSeed,
      ...(boundary !== undefined
        ? { boundary }
        : { xyBounds: xyBoundsFromMesh(args.partMesh) }),
      ...(overrun.rings !== undefined ? { overrunBoundary: overrun.rings } : {}),
    },
    { signal: args.signal, onProgress: args.onProgress },
  );
  const computeTimeMs = performance.now() - t0;

  const resolvedFeeds = Object.prototype.hasOwnProperty.call(args, 'feedrateOverride')
    ? resolveFeedrates(args.tool, args.feedrateOverride)
    : undefined;
  const moves = irToToolpathMoves(ir, resolvedFeeds);
  if (moves.length === 0) {
    // ADR-0003: an empty result is a loud failure, never a silently-empty op.
    throw new Error(
      'parallel_3d produced no toolpath moves. The pass region may not intersect the ' +
        'part surface, or the stepover/boundary may exclude the whole part.',
    );
  }

  return {
    moves,
    computeTimeMs,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/**
 * Acquire a PartMesh from file bytes at CAM tolerance (D-007 policy lives in
 * the importers: STEP deflection = camTolerance/4). Kept OUT of the compute
 * adapter so the store can pass raw bytes+format and this owns the tolerance
 * policy; the later full-fixture gate calls it directly too.
 *
 * WO-1845 / ADR-0051 R1: THE toolpath route through an STL's edit journal.
 * `meshEdits` is the row's journal; the bytes are parsed, the journal is
 * replayed over them and the RESULT is what the importer sees, so the part the
 * cutter is driven around is the part the operator edited. With no journal
 * `resolveEditedStlBytes` hands back the very ArrayBuffer it was given, so an
 * unedited STL takes exactly today's path - same object, same importer, same
 * mesh. (Layering: src/mesh is a leaf domain module - typed arrays and pure
 * functions, no store, no IndexedDB, no kernel - the same class of dependency
 * as src/types, which this bridge already imports.)
 */
export async function acquirePartMesh(
  source: { format: 'stl' | 'step'; bytes: ArrayBuffer; meshEdits?: readonly MeshEditRecord[] },
  camTolerance: number,
): Promise<PartMesh> {
  if (source.format === 'stl') {
    const r = await importStlToPartMesh(resolveEditedStlBytes(source.bytes, source.meshEdits));
    return r.mesh;
  }
  const r = await importStepToPartMesh(source.bytes, { camTolerance });
  return r.mesh;
}
