// cam3d rough: map ONE Z-level's AdaptivePass stream onto ToolpathIR moves.
//
// The 3D rougher differs from the 2D engine's own emit (engine/emit.ts) in one
// structural way: the 2D engine computes the plan-view path ONCE and its emit
// re-bores that same path at every depth level. We instead recompute a fresh
// cut region PER LEVEL (rest-between-levels), so this emitter is called once per
// level with THAT level's passes at THAT level's single cutting depth `z`.
// There is no internal depth loop here.
//
// PASS -> IR MAPPING (roles are load-bearing: feedrate-by-role is resolved by a
// later op-layer chunk, so f is left UNDEFINED here but the role MUST be right
// -- feedback_ac_feedrate_by_role):
//   entry (helix)  -> first: feedZ; later: remaining-stock top -> z       role 'ramp'
//   entry (plunge) -> first: feedZ; later: remaining-stock top -> z       role 'plunge'
//   entry (side)   -> rapid over and down at the fully-clear pt, then feed laterally
//                     to the bounded engage pt with role 'lead_in'
//   cut            -> feed polyline at z                                 role 'cut'
//   wallfollow     -> feed polyline at z                                 role 'cut'
//   finish         -> feed polyline at z                                 role 'finish'
//   link jumpType 1-> keep-down stepover feed prev-end -> points[1] at z role 'stepover'
//   link jumpType 2-> stock-proven low link or guarded clearance reroute role 'rapid'/'ramp'/'plunge'
//                     (helixDescent -> helix ramp; else straight plunge when the live
//                     stock proves the shaft clear; else the planner's fallbackHelix;
//                     else refuse loudly -- WO-400)
//   loopback       -> keep-down ride at z over cleared stock            role 'stepover' (z held at depth)
//                     (WO-462: NOT role 'rapid' -- a feed move with a rapid role has no
//                      resolvable rate and the IR boundary refuses it, rightly)
//
// LINKING BETWEEN REGIONS/LEVELS: Feed Height owns the first material entry.
// Later entries use the carved-stock field to approach just above remaining
// material, while the downstream traverse guard proves each low corridor and
// reroutes an unproven one over Clearance Height. The cursor is carried across
// level calls through EmitContext.cursor.
//
// DETERMINISM (D-006): the helix uses a deterministic angle and fixed samples
// per turn, so identical inputs give a byte-identical move list.

import type { AdaptivePass, EnginePt as Pt } from './engineEntry';
import { MIN_DESCENT_HELIX_RADIUS } from '../../lib/cam/adaptiveClearing2d/engine/processFeature';
import { formatStraightPlungeRefusal, type PlungeRefusalWhere } from './entryRefusal';
import type { CutterSpec } from '../kernel/types';
import type { IrMove, IrMoveRole } from '../ir/types';
import { area, type Ring } from '../geom2d';
import { engagementAt, maxTraverseIntrusion, plungeUncutFraction, sweepProfile, type ZDexelField } from '../stock';
import { cutterDiskIntersectsRegion } from './cutRegion';
import { replayMovesIntoStock, type ToolTipPosition } from './replayStock';
import { LOW_TRAVEL_HEADROOM_MM } from './traverseSafety';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';

/** Fixed helix sampling: 24 straight segments per revolution (D-006 determinism). */
const HELIX_SEGMENTS_PER_TURN = 24;
/** Back-compatible angle for callers and saved operations that omit it. */
const DEFAULT_HELIX_ANGLE_DEG = 10;
/** Ride the tool-centre circle this far inside the nominal radius (matches engine emit). */
const HELIX_EDGE_BACKOFF = 0.01;
/** Safety cap so a tiny radius / big depth cannot explode the helix point count. */
const MAX_HELIX_POINTS = 5000;
/**
 * Small positive air gap above the highest remaining material under an entry
 * sweep: where a FEED ramp or plunge begins. A feed hand-off standoff, like
 * DESCENT_STANDOFF_MM -- NOT the height a rapid travels at. Lateral travel below
 * the clearance plane keeps LOW_TRAVEL_HEADROOM_MM (WO-1270), and this constant
 * must never set that height again.
 */
const STOCK_AWARE_RAMP_CLEARANCE_MM = 0.05;

/** Exact distance between the segment a-b and the axis-aligned square [x0,x1]x[y0,y1]:
 *  0 when they meet; otherwise the nearest pair is a vertex of one against the other. */
function segmentToSquareDistance(
  a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number,
): number {
  const pointToSegment = (px: number, py: number): number => {
    const ex = b.x - a.x, ey = b.y - a.y;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((px - a.x) * ex + (py - a.y) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (a.x + ex * t), py - (a.y + ey * t));
  };
  const pointToSquare = (px: number, py: number): number => {
    const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
    const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
    return Math.hypot(dx, dy);
  };
  // An endpoint inside the square, or the segment crossing a square edge, means contact.
  if (pointToSquare(a.x, a.y) === 0 || pointToSquare(b.x, b.y) === 0) return 0;
  const crosses = (px: number, py: number, qx: number, qy: number): boolean => {
    const d1 = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    const d2 = (b.x - a.x) * (qy - a.y) - (b.y - a.y) * (qx - a.x);
    const d3 = (qx - px) * (a.y - py) - (qy - py) * (a.x - px);
    const d4 = (qx - px) * (b.y - py) - (qy - py) * (b.x - px);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  if (crosses(x0, y0, x1, y0) || crosses(x1, y0, x1, y1) || crosses(x1, y1, x0, y1) || crosses(x0, y1, x0, y0)) return 0;
  return Math.min(
    pointToSegment(x0, y0), pointToSegment(x1, y0), pointToSegment(x1, y1), pointToSegment(x0, y1),
    pointToSquare(a.x, a.y), pointToSquare(b.x, b.y),
  );
}

/**
 * WO-1178: highest tool-tip contact Z under the horizontal tool-centre segment a-b, judging
 * every column by the SQUARE its material occupies. A column counts when the cutter disk
 * strictly overlaps that square; the cutter then touches the column's top at
 * `top - height(r)` where r is the nearest distance (the conservative choice for a ball).
 * Undefined when no column lies under the sweep.
 */
function highestCellContactAlong(
  field: ZDexelField,
  cutter: CutterSpec,
  a: Pt,
  b: Pt,
): number | undefined {
  const prof = sweepProfile(cutter);
  const R = prof.radius;
  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const half = cell / 2;
  const lo = (v: number, origin: number): number => Math.max(0, Math.floor((v - origin) / cell) - 1);
  const hi = (v: number, origin: number, n: number): number => Math.min(n - 1, Math.ceil((v - origin) / cell) + 1);
  const i0 = lo(Math.min(a.x, b.x) - R, originX), i1 = hi(Math.max(a.x, b.x) + R, originX, nx);
  const j0 = lo(Math.min(a.y, b.y) - R, originY), j1 = hi(Math.max(a.y, b.y) + R, originY, ny);
  let highest = Number.NEGATIVE_INFINITY;
  for (let j = j0; j <= j1; j++) {
    const cy = originY + (j + 0.5) * cell;
    for (let i = i0; i <= i1; i++) {
      const c = j * nx + i;
      if (!(top[c] > bottom[c])) continue; // empty column
      const cx = originX + (i + 0.5) * cell;
      const d = segmentToSquareDistance(a, b, cx - half, cy - half, cx + half, cy + half);
      if (!(d < R)) continue;
      const heightAboveTip = prof.kind === 'ball' ? R - Math.sqrt(Math.max(0, R * R - d * d)) : 0;
      const contactTipZ = top[c] - heightAboveTip;
      if (contactTipZ > highest) highest = contactTipZ;
    }
  }
  return Number.isFinite(highest) ? highest : undefined;
}
/**
 * A straight plunge may proceed when at most this fraction of the CUTTER FACE
 * still stands above the plunge floor (Operator ruling 2026-08-19: measure a sliver as a
 * share of the cutter face, not by its height, so a rounding-sized skin at the
 * disk edge never blocks a sensible move; 5% as the starting point, tune
 * later). Never less than ONE grid cell, because on a coarse field a single
 * cell can be a large share of a small cutter's face. FreeCAD's Adaptive, the
 * reference engine, does not check the re-plunge at all and trusts the walker's
 * bounded bite (a few percent of the face); our planner's own 5% cap was set
 * just above that bite. Above the allowance the planner's fallback helix (or a
 * loud refusal) takes over.
 */
const DEFAULT_PLUNGE_UNCUT_ALLOWANCE = 0.05;
/**
 * WO-409 part 2: a keep-down link (jumpType 1, role 'stepover') is a feed move at
 * depth that the planner believes runs through cleared stock. Its belief is a
 * polygon model; the live carved field is the authority here (as for landings,
 * WO-400). Where the link would remove more than this fraction of a full slot -
 * fresh volume per mm over the slot cross-section at the standing depth - it is
 * taken as PECKED BITES instead: advance at most KEEP_DOWN_BITE_MM, retreat
 * through the groove just cut, advance to the next bite, the last bite running
 * on to the link end. Every 2 mm window of the published path then holds at most
 * one bite of fresh material, so the side-entry gate's 75% cap is met by
 * construction, on the same line the planner chose. Measured on Full_Suite "3D
 * Rough 2": the lobe-neck nibble (0.5 mm arcs joined by 0.9 mm keep-down links
 * that ploughed 75-81%, 1.3 mm per level, four levels) was the last refusal.
 */
const KEEP_DOWN_PECK_FRACTION = 0.5;
const KEEP_DOWN_BITE_MM = 0.75;
const EPS = 1e-9;

export interface EmitHeights {
  /** Safe traverse level: rapid-overs between regions/levels run at this z. */
  clearanceZ: number;
  /** Lift-and-replunge level for jumpType-2 links (above the level's uncut stock). */
  retractZ: number;
  /** Lowest legal rapid-descent endpoint; entry motion below it is feed motion. */
  feedZ: number;
}

export interface EmitContext {
  /** Direction transformed to the engine's clockwise-spindle convention. */
  millingDirection?: AdaptiveMillingDirection;
  /** Helix descent angle from horizontal, degrees. Defaults to 10. */
  helixAngleDeg?: number;
  /**
   * Below this entry-helix radius (mm) a "helix" degenerates into a wobbling
   * plunge, so it is emitted as a straight plunge instead. Default
   * MIN_DESCENT_HELIX_RADIUS (0.2), the planner's own floor - one source.
   */
  minHelixRadius?: number;
  /** Cutter radius used to prove a side-entry descent's swept disk is clear. */
  toolRadius?: number;
  /**
   * Live carved stock at the start of this level. When both this and `cutter`
   * are present, later entries rapid through the proven-clear shaft and ramp
   * only through the material that still remains above this level.
   */
  stock?: ZDexelField;
  cutter?: CutterSpec;
  /** False disables low re-entry even when a field is present. */
  stockProven?: boolean;
  /**
   * Straight-plunge allowance: the share of the cutter face that may still
   * stand above the plunge floor. Default DEFAULT_PLUNGE_UNCUT_ALLOWANCE (5%),
   * never less than one field cell.
   */
  plungeUncutAllowance?: number;
  /**
   * Running tool position carried across level calls. Mutated in place as moves
   * are emitted so the caller can pass the SAME object to the next level's emit
   * (the next level's first entry retracts from wherever this level ended).
   * Initialize to { x: NaN, y: NaN, z: clearanceZ } before the first level so
   * the first entry emits its rapid-over as the toolpath's first move.
   */
  cursor: { x: number; y: number; z: number };
}

/**
 * Map one level's ordered AdaptivePass stream to IR moves at cutting depth `z`.
 * Appends to and returns a fresh IrMove[]; advances ctx.cursor in place. Feeds
 * (f) are intentionally left undefined -- roles carry the intent and the op
 * layer resolves feedrate-by-role later.
 */
export function emitLevelPasses(
  passes: readonly AdaptivePass[],
  z: number,
  heights: EmitHeights,
  ctx: EmitContext,
  // Optional stock cross-section at this z (geom2d Ring[], outers +area). A
  // 'side' entry needs either this 2D fallback or the stronger live 3D stock
  // proof carried by ctx. Absent for the interior-helix path (byte-identical).
  stockSection?: readonly Ring[],
): IrMove[] {
  const { clearanceZ, retractZ, feedZ } = heights;
  if (![clearanceZ, retractZ, feedZ, z].every(Number.isFinite)) {
    throw new Error('emitLevelPasses: clearanceZ, retractZ, feedZ, and cutting z must be finite.');
  }
  if (clearanceZ < retractZ || retractZ < feedZ || feedZ < z) {
    throw new Error(
      `emitLevelPasses: heights must satisfy clearanceZ >= retractZ >= feedZ >= cutting z; ` +
        `got ${clearanceZ}, ${retractZ}, ${feedZ}, ${z}.`,
    );
  }
  const minHelixR = ctx.minHelixRadius ?? MIN_DESCENT_HELIX_RADIUS;
  const helixDirection = ctx.millingDirection === 'conventional' ? -1 : 1;
  const helixAngleDeg = ctx.helixAngleDeg ?? DEFAULT_HELIX_ANGLE_DEG;
  if (!Number.isFinite(helixAngleDeg) || helixAngleDeg < 0.5 || helixAngleDeg > 30) {
    throw new Error(`emitLevelPasses: helixAngleDeg must be in [0.5, 30], got ${helixAngleDeg}.`);
  }
  const helixRampTan = Math.tan((helixAngleDeg * Math.PI) / 180);
  const cur = ctx.cursor;
  const moves: IrMove[] = [];
  const canUseStockAwareEntry =
    ctx.stockProven === true && ctx.stock !== undefined && ctx.cutter !== undefined;
  // Same-level re-entries may legitimately descend inside the ORIGINAL stock
  // after earlier passes have cleared that location. Replay emitted cutting
  // moves into a private clone so each side-entry proof sees the stock that
  // physically exists at that exact point in the operation.
  const entryProofStock = canUseStockAwareEntry ? ctx.stock!.clone() : undefined;
  let entryProofTip: ToolTipPosition | null = Number.isFinite(cur.x)
    ? { x: cur.x, y: cur.y, z: cur.z }
    : null;

  /**
   * Highest tool-tip contact Z under a cutter-center polyline. This is the
   * remaining-stock authority for entry length only; it never defines a part
   * wall or changes the XY cutting boundary.
   */
  const highestContactAlong = (points: readonly Pt[], targetZ: number): number | undefined => {
    const proofStock = entryProofStock ?? ctx.stock;
    if (ctx.stockProven !== true || !proofStock || !ctx.cutter || points.length === 0) {
      return undefined;
    }
    // WO-1178: judge every column by its CELL, not its centre. maxTraverseIntrusion tests a
    // column only when its centre lies within the cutter radius of the tool-centre segment,
    // so a column whose centre stands just past the radius is skipped even though the cell
    // it stands for (the square the dexel's material really occupies) reaches under the
    // cutter. A hover height read that way can pass an island corner by microns under the
    // real cutter: restWiring.wo279's control op planned a rapid at contact + 0.05 that
    // grazed the island corner 1.497 mm from a 1.5 mm cutter, the exact retained-model gate
    // refused it, and the whole operation ended in error. Here a column counts when the
    // cutter disk OVERLAPS its square, strictly: a cutter that exactly fits a one-tool slot
    // touches the walls' cells without overlapping them. Where the carving's own
    // centre-sampled removal left a rim column standing that the cutter's disk does overlap
    // (the two corner cells at the end of an exact-fit slot), that column counts too: the
    // field's material is the field's word, and the hover reads it conservatively rather
    // than relying on the exact gate to catch the difference afterwards.
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const contact = highestCellContactAlong(proofStock, ctx.cutter, a, b);
      if (contact !== undefined) highest = Math.max(highest, contact);
    }
    return Number.isFinite(highest) ? highest : targetZ;
  };

  const stockAwareRampStart = (
    center: Pt,
    radius: number,
    targetZ: number,
    firstEntry: boolean,
  ): number => {
    // Feed Height remains the authored first-entry transition. Once the tool
    // has a real position, the carved stock becomes the re-entry authority.
    if (firstEntry) return feedZ;
    const r = Math.max(radius - HELIX_EDGE_BACKOFF, radius * 0.5);
    const points: Pt[] = [];
    const samples = radius > 0 ? HELIX_SEGMENTS_PER_TURN : 1;
    for (let k = 0; k < samples; k++) {
      const fi = (2 * Math.PI * k) / samples;
      points.push({ x: center.x + r * Math.cos(fi), y: center.y + r * Math.sin(fi) });
    }
    const contact = highestContactAlong(points, targetZ);
    if (contact === undefined) return feedZ;
    return Math.max(targetZ, Math.min(feedZ, contact + STOCK_AWARE_RAMP_CLEARANCE_MM));
  };

  /**
   * Lowest stock-proven height for moving from the carried tool position to a
   * new entry point. This is deliberately separate from the entry descent:
   * first move over the already-carved component at the current/local height,
   * then descend at the entry. Combining XY travel with the descent makes the
   * traverse guard judge the whole connector at the deeper Z and needlessly
   * reroute a same-pocket stepdown over Clearance Height.
   *
   * WO-1270: the connector is a RAPID across whatever the field says stands under
   * it, so it keeps LOW_TRAVEL_HEADROOM_MM of air (the one number that rules low
   * travel; the traverse-safety pass enforces it and would lift anything lower).
   * Only the clearance plane caps it: a corridor can prove material right up to
   * the feed height, and a connector clamped to the feed height would then be
   * lifted again downstream, spending a move to reach the height it should have
   * been authored at.
   */
  const stockAwareConnectorHeight = (target: Pt, targetZ: number): number => {
    if (!canUseStockAwareEntry || !Number.isFinite(cur.x) || !Number.isFinite(cur.y)) {
      return clearanceZ;
    }
    const contact = highestContactAlong([
      { x: cur.x, y: cur.y },
      target,
    ], targetZ);
    if (contact === undefined) return clearanceZ;
    return Math.max(targetZ, Math.min(clearanceZ, contact + LOW_TRAVEL_HEADROOM_MM));
  };

  /** Move laterally at a proven local height, never diagonally down into an entry. */
  const moveToEntryAt = (target: Pt, minimumZ: number): void => {
    const approachZ = Math.max(minimumZ, stockAwareConnectorHeight(target, z));
    retractTo(approachZ);
    push('rapid', target.x, target.y, cur.z, 'rapid');
  };

  const plungeAllowance = ctx.plungeUncutAllowance ?? DEFAULT_PLUNGE_UNCUT_ALLOWANCE;
  if (!Number.isFinite(plungeAllowance) || plungeAllowance < 0 || plungeAllowance > 1) {
    throw new Error(`emitLevelPasses: plungeUncutAllowance must be in [0, 1], got ${plungeAllowance}.`);
  }
  /**
   * What a straight plunge at `center` would meet, read from the live proof stock
   * (this level's emitted moves replayed on top of the field the level started
   * with). Undefined when there is no live stock to ask -- the descent is then
   * the planner's word alone. `allowed` applies the cutter-face allowance: at
   * most `plungeAllowance` of the face, and never less than one cell, may still
   * stand above the floor.
   */
  const straightDescentVerdict = (
    center: Pt,
    targetZ: number,
  ): { allowed: boolean; fraction: number; uncutColumns: number; columns: number; contact: number } | undefined => {
    if (!canUseStockAwareEntry) return undefined;
    const proofStock = entryProofStock ?? ctx.stock!;
    const read = plungeUncutFraction(proofStock, center.x, center.y, targetZ, ctx.cutter!);
    const allowed = read.uncutColumns <= 1 || read.fraction <= plungeAllowance;
    return {
      allowed,
      fraction: read.fraction,
      uncutColumns: read.uncutColumns,
      columns: read.columns,
      contact: read.highestContactTipZ,
    };
  };
  const straightDescentIsClear = (center: Pt, targetZ: number): boolean => {
    const verdict = straightDescentVerdict(center, targetZ);
    return verdict === undefined || verdict.allowed;
  };
  const assertStraightDescentIsClear = (center: Pt, targetZ: number, where: PlungeRefusalWhere): void => {
    const verdict = straightDescentVerdict(center, targetZ);
    if (verdict !== undefined && !verdict.allowed) {
      throw new Error(formatStraightPlungeRefusal({
        x: center.x,
        y: center.y,
        fromZ: verdict.contact,
        toZ: targetZ,
        fraction: verdict.fraction,
        uncutColumns: verdict.uncutColumns,
        columns: verdict.columns,
        allowance: plungeAllowance,
        where,
      }));
    }
  };

  const push = (t: 'rapid' | 'feed', x: number, y: number, zz: number, role: IrMoveRole): void => {
    // Zero-length suppression (matches pathbuild): a move that does not change
    // position emits nothing, so byte-identical inputs stay byte-identical.
    if (cur.x === x && cur.y === y && cur.z === zz) return;
    const move: IrMove = { t, x, y, z: zz, role };
    moves.push(move);
    if (entryProofStock && ctx.cutter) {
      entryProofTip = replayMovesIntoStock(entryProofStock, ctx.cutter, [move], entryProofTip);
    }
    cur.x = x;
    cur.y = y;
    cur.z = zz;
  };

  /** A jumpType-1 link: plain keep-down feed, or pecked bites when the live stock
   *  says it would plough (see KEEP_DOWN_PECK_FRACTION). */
  const emitKeepDownLink = (b: Pt): void => {
    const ax = cur.x;
    const ay = cur.y;
    const L = Math.hypot(b.x - ax, b.y - ay);
    if (!canUseStockAwareEntry || !(L > 1e-6) || !Number.isFinite(ax)) {
      push('feed', b.x, b.y, z, 'stepover');
      return;
    }
    const proofStock = entryProofStock!;
    const cutter = ctx.cutter!;
    const freshPerMm = engagementAt(proofStock, { x0: ax, y0: ay, z0: z, x1: b.x, y1: b.y, z1: z }, cutter);
    const standing = plungeUncutFraction(proofStock, b.x, b.y, z, cutter).highestContactTipZ;
    const depth = Number.isFinite(standing) ? standing - z : 0;
    const fraction = depth > 1e-6 ? freshPerMm / (cutter.diameter * depth) : 0;
    if (!(fraction > KEEP_DOWN_PECK_FRACTION)) {
      push('feed', b.x, b.y, z, 'stepover');
      return;
    }
    const n = Math.ceil(L / KEEP_DOWN_BITE_MM);
    const ux = (b.x - ax) / L;
    const uy = (b.y - ay) / L;
    for (let k = 1; k < n; k++) {
      push('feed', ax + ux * KEEP_DOWN_BITE_MM * k, ay + uy * KEEP_DOWN_BITE_MM * k, z, 'stepover');
      push('feed', ax, ay, z, 'stepover');
    }
    push('feed', b.x, b.y, z, 'stepover');
    // eslint-disable-next-line no-console
    console.warn(
      `[keep-down] link (${ax.toFixed(2)}, ${ay.toFixed(2)}) -> (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) at z=${z.toFixed(2)} ` +
      `would plough ${(fraction * 100).toFixed(0)}% of a full slot by the live stock -- taken in ${n} pecked bite(s) of <= ${KEEP_DOWN_BITE_MM} mm (WO-409)`,
    );
  };

  /** Retract the tool straight up to `level` if it currently sits below it. */
  const retractTo = (level: number): void => {
    if (Number.isFinite(cur.z) && cur.z < level - EPS && Number.isFinite(cur.x)) {
      push('rapid', cur.x, cur.y, level, 'rapid');
    }
  };

  /**
   * Dense-polyline helix ramp descending from `zStart` down to `zEnd`, centred
   * at `c`, opening radius `radius`. The caller positions at the spiral start
   * on Feed Height; this helper emits only feed moves below that boundary.
   */
  const emitHelix = (c: Pt, radius: number, zStart: number, zEnd: number, role: IrMoveRole): void => {
    const r = Math.max(radius - HELIX_EDGE_BACKOFF, radius * 0.5);
    const totalDepth = zStart - zEnd;
    const circumference = 2 * Math.PI * r;
    const depthPerTurn = circumference * helixRampTan;
    const totalAngle = depthPerTurn > EPS ? (totalDepth / depthPerTurn) * 2 * Math.PI : 2 * Math.PI;
    const angStep = (2 * Math.PI) / HELIX_SEGMENTS_PER_TURN;
    const nSeg = Math.max(HELIX_SEGMENTS_PER_TURN, Math.ceil(totalAngle / angStep - EPS));
    const cleanupSegs = HELIX_SEGMENTS_PER_TURN;
    if (nSeg + cleanupSegs > MAX_HELIX_POINTS) {
      throw new Error(
        `emitLevelPasses: helix requires ${nSeg + cleanupSegs} points, above the ` +
          `${MAX_HELIX_POINTS}-point safety limit; ` +
          `increase the helix angle or diameter, or reduce the descent depth.`,
      );
    }

    // Spiral down; k = nSeg lands exactly on (zEnd, angle totalAngle).
    for (let k = 1; k <= nSeg; k++) {
      const fi = helixDirection * (totalAngle * k) / nSeg;
      const x = c.x + r * Math.cos(fi);
      const y = c.y + r * Math.sin(fi);
      const zz = zStart - (totalDepth * k) / nSeg;
      push('feed', x, y, zz, role);
    }
    // A descending helix reaches zEnd at only ONE angular point; everything
    // else inside its footprint is still a spiral ramp standing up to one
    // turn's depth proud of the level floor. MANDATORY, not an option:
    //
    //  - the 2D planner has no Z. It credits the whole opened disk (radius
    //    r + toolRadius, since r <= toolRadius puts the cutter over the
    //    centre) into `cleared`, and later offers points inside it -- the
    //    helix centre included -- as proven-clear descent shafts. That claim
    //    is only true once the disk is physically AT zEnd, so the at-depth
    //    turn is what makes the planner's model honest. Without it the live
    //    stock replay rightly refuses the descent (the uploaded tall-stock
    //    bore refused a plunge at its own helix centre, 12.813 -> 12.000);
    //  - the leftover ramp would otherwise survive into the next level and
    //    double that level's local depth of cut;
    //  - the next lateral move would flatten the sloped floor as an axial
    //    cut, which reads as excessive radial engagement.
    //
    // One full turn at zEnd sweeps the complete opened disk, so all three go
    // away together.
    for (let k = 1; k <= cleanupSegs; k++) {
      const fi = helixDirection * (totalAngle + (2 * Math.PI * k) / cleanupSegs);
      push('feed', c.x + r * Math.cos(fi), c.y + r * Math.sin(fi), zEnd, role);
    }
  };

  const emitPolyline = (pts: readonly Pt[], role: IrMoveRole, t: 'rapid' | 'feed'): void => {
    for (const p of pts) push(t, p.x, p.y, z, role);
  };

  /**
   * A loopback: the wall-clean turnaround, or WO-438's routed keep-down ride, travelling
   * at the cutting depth over stock the 2D planner proved cleared to its TRAVERSE bound.
   *
   * WHY ROLE 'stepover' AND NOT 'rapid' (WO-462; the reasoning in full, with the two
   * rejected shapes, lives in src/tests/evidence/WO-462/). The ride is bounded at ONE
   * ENGAGE-BAND BITE of fresh stock -- 4-7x tighter than the cutting-role cap the wall
   * rides are held to (processFeature.ts, "T5, THE TRAVERSE BOUND") -- so it is not a
   * cut. But "bounded at one bite" is not "zero": the ride ENDS on the next pass's
   * engage point, which sits on the frontier by definition, so it may meet material and
   * must never be posted as a rapid. That is exactly the at-depth, bounded-bite category
   * this emitter already gives the jumpType-1 keep-down link, and 'stepover' is its role:
   * it resolves through IR_ROLE_TO_RATE to the operation's cutting feed, which is the
   * conservative rate for a bite strictly smaller than a cutting pass takes.
   *
   * Emitting it as a feed move carrying role 'rapid' -- what this line did since the
   * clean slate -- leaves the L6 boundary with no resolvable commanded rate, and
   * toToolpathMoves throws rather than guess one. It is right to throw.
   */
  const emitLoopback = (pts: readonly Pt[]): void => {
    // OBSERVE the bound, do not merely trust it (ADR-0003). A cutting-role move is not
    // re-proved by the traverse guard, and the planner's proof is a POLYGON belief; the
    // live carved field is the authority here, exactly as it is for landings (WO-400)
    // and keep-down links (WO-409). Measure what the ride actually meets and name the
    // worst window when it exceeds the keep-down link's own plough fraction.
    let worstFraction = 0;
    let worstAt: Pt | null = null;
    for (const p of pts) {
      if (canUseStockAwareEntry && Number.isFinite(cur.x) && Number.isFinite(cur.y)) {
        const cutter = ctx.cutter!;
        const proofStock = entryProofStock!;
        const L = Math.hypot(p.x - cur.x, p.y - cur.y);
        if (L > 1e-6) {
          const freshPerMm = engagementAt(
            proofStock,
            { x0: cur.x, y0: cur.y, z0: z, x1: p.x, y1: p.y, z1: z },
            cutter,
          );
          const standing = plungeUncutFraction(proofStock, p.x, p.y, z, cutter).highestContactTipZ;
          const depth = Number.isFinite(standing) ? standing - z : 0;
          const fraction = depth > 1e-6 ? freshPerMm / (cutter.diameter * depth) : 0;
          if (fraction > worstFraction) {
            worstFraction = fraction;
            worstAt = p;
          }
        }
      }
      push('feed', p.x, p.y, z, 'stepover');
    }
    if (worstFraction > KEEP_DOWN_PECK_FRACTION && worstAt) {
      // eslint-disable-next-line no-console
      console.warn(
        `[loopback] ride at z=${z.toFixed(2)} meets ${(worstFraction * 100).toFixed(0)}% of a ` +
        `full slot by the live stock near (${worstAt.x.toFixed(2)}, ${worstAt.y.toFixed(2)}) -- ` +
        `above the ${(KEEP_DOWN_PECK_FRACTION * 100).toFixed(0)}% keep-down plough fraction, so the ` +
        `planner's one-engage-band-bite traverse bound and the live field disagree here (WO-462); ` +
        `posted at the cutting feed via role 'stepover', never as a rapid`,
      );
    }
  };

  /**
   * Emit a 'side' (outside-in) entry. The engine supplies both the fully-clear point C
   * on preEngage and the bounded grazing point P. Retract, rapid over C, descend at C,
   * then feed laterally C -> P so engageProtrusion is consumed by the cutter side.
   *
   * FAIL LOUD (ADR-0003): prove the whole cutter disk at C is clear of the stock section.
   * A centre-only point-membership check cannot express that physical invariant.
   */
  const emitSideEntry = (pass: Extract<AdaptivePass, { type: 'entry' }>): void => {
    // (1) Fail loud only when neither proof source exists. A bounded lateral
    // reseed can be planned after this Z section is already empty; in the 3D
    // strategy the replayed live stock is the physical authority in that case.
    const hasLiveStockProof = entryProofStock !== undefined && ctx.cutter !== undefined;
    if ((!stockSection || stockSection.length === 0) && !hasLiveStockProof) {
      throw new Error(
        `emitLevelPasses: 'side' entry at z=${z} has no stock section (wiring bug, ADR-0003).`,
      );
    }
    if (stockSection && stockSection.length > 0
      && !stockSection.some((ring) => area(ring) > 0)
      && !hasLiveStockProof) {
      throw new Error(
        `emitLevelPasses: 'side' entry at z=${z}: stock section has no positive-area outer ring.`,
      );
    }
    const R = ctx.toolRadius;
    if (!(R !== undefined && Number.isFinite(R) && R > 0)) {
      throw new Error(
        `emitLevelPasses: 'side' entry at z=${z} requires a finite positive toolRadius.`,
      );
    }
    const P = pass.point;
    const C = pass.clearPoint;
    if (!C) {
      throw new Error(
        `emitLevelPasses: 'side' entry at z=${z} is missing its fully-clear descent point.`,
      );
    }

    // (2) fail loud if any positive area of the cutter disk at C overlaps material.
    // The vertical move's XY is constant, so this disk is its complete swept volume.
    const clearPointIntersects = entryProofStock && ctx.cutter
      ? maxTraverseIntrusion(entryProofStock, {
          x0: C.x, y0: C.y, z0: z,
          x1: C.x, y1: C.y, z1: z,
        }, ctx.cutter).intrusionMm > 1e-3
      : cutterDiskIntersectsRegion(stockSection!, C.x, C.y, R);
    if (clearPointIntersects) {
      throw new Error(
        `emitLevelPasses: 'side' entry at z=${z}: cutter disk at clear point ` +
          `(${C.x.toFixed(3)}, ${C.y.toFixed(3)}), radius ${R.toFixed(3)}, intersects ` +
          `the stock section -- refusing an unsafe descent (ADR-0003).`,
      );
    }

    // (3) The complete cutter disk at C is constructively proven outside the
    // stock section above, so its vertical swept volume is empty. Rapid to
    // depth there; the lateral lead is the first move that can meet material
    // and therefore is the first feed move.
    if (!Number.isFinite(cur.x)) {
      push('rapid', C.x, C.y, clearanceZ, 'rapid');
      push('rapid', C.x, C.y, feedZ, 'rapid');
    } else {
      moveToEntryAt(C, z);
    }
    push('rapid', C.x, C.y, z, 'rapid');
    push('feed', P.x, P.y, z, 'lead_in');
  };

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    switch (pass.type) {
      case 'entry': {
        if (pass.mode === 'side') {
          // Outside-in lateral entry: descend fully clear, then feed in with the side.
          emitSideEntry(pass);
          break;
        }
        // Open a region. The first entry honors Feed Height. Later entries use
        // the live stock to lift only above remaining material; the downstream
        // traverse guard proves the low lateral link and raises it to clearance
        // automatically if the corridor is not actually clear.
        const firstEntry = !Number.isFinite(cur.x);
        const useHelix = pass.mode === 'helix' && pass.radius >= minHelixR;
        if (useHelix) {
          const r = Math.max(pass.radius - HELIX_EDGE_BACKOFF, pass.radius * 0.5);
          const rampStartZ = stockAwareRampStart(pass.point, pass.radius, z, firstEntry);
          const entryPoint = { x: pass.point.x + r, y: pass.point.y };
          if (firstEntry || !canUseStockAwareEntry) {
            retractTo(clearanceZ);
            push('rapid', entryPoint.x, entryPoint.y, clearanceZ, 'rapid');
          } else {
            moveToEntryAt(entryPoint, rampStartZ);
          }
          push('rapid', pass.point.x + r, pass.point.y, rampStartZ, 'rapid');
          if (rampStartZ > z + EPS) emitHelix(pass.point, pass.radius, rampStartZ, z, 'ramp');
          else push('rapid', pass.point.x + r, pass.point.y, z, 'rapid');
        } else {
          assertStraightDescentIsClear(
            pass.point,
            z,
            { kind: 'region', mode: pass.mode, helixRadius: pass.radius, minHelixRadius: minHelixR },
          );
          const rampStartZ = stockAwareRampStart(pass.point, 0, z, firstEntry);
          if (firstEntry || !canUseStockAwareEntry) {
            retractTo(clearanceZ);
            push('rapid', pass.point.x, pass.point.y, clearanceZ, 'rapid');
          } else {
            moveToEntryAt(pass.point, rampStartZ);
          }
          push('rapid', pass.point.x, pass.point.y, rampStartZ, 'rapid');
          if (rampStartZ > z + EPS) push('feed', pass.point.x, pass.point.y, z, 'plunge');
          else push('rapid', pass.point.x, pass.point.y, z, 'rapid');
        }
        break;
      }
      case 'cut':
        emitPolyline(pass.points, 'cut', 'feed');
        break;
      case 'lead':
        emitPolyline(pass.points, 'lead_in', 'feed');
        break;
      case 'wallfollow':
        emitPolyline(pass.points, 'cut', 'feed');
        break;
      case 'finish':
        emitPolyline(pass.points, 'finish', 'feed');
        break;
      case 'loopback':
        emitLoopback(pass.points);
        break;
      case 'link': {
        // A link immediately before an entry is superseded by that entry's own
        // safe approach (the entry owns the reposition), so skip it -- mirrors
        // the 2D engine emit.
        const next = passes[i + 1];
        if (next && next.type === 'entry') break;
        const b = pass.points[1];
        if (pass.jumpType === 1) {
          // Keep-down stepover feed through cleared stock, at depth - pecked where
          // the live stock says it would plough (KEEP_DOWN_PECK_FRACTION).
          emitKeepDownLink(b);
        } else {
          // Lift only as far as remaining stock requires. The traverse-safety
          // pass owns the final verdict and reroutes a blocked candidate over
          // clearance, so this optimization cannot rapid through material.
          //
          // Which descent (WO-400): the planner's mandatory helixDescent wins.
          // Otherwise the planner accepted a straight descent from its polygon
          // model of cleared stock; the LIVE carved field is the final authority
          // on that shaft. If it disagrees (a corner sliver the polygon disk did
          // not see, a cell the corridor missed), the planner's fallbackHelix --
          // proven to fit inside the cut region -- descends instead of a plunge
          // through standing material. Only with neither does the plunge branch
          // refuse, loudly.
          const helix =
            pass.helixDescent && pass.helixDescent.radius >= minHelixR
              ? pass.helixDescent
              : pass.fallbackHelix && pass.fallbackHelix.radius >= minHelixR
                  && !straightDescentIsClear(b, z)
                ? pass.fallbackHelix
                : undefined;
          if (helix) {
            const r = Math.max(
              helix.radius - HELIX_EDGE_BACKOFF,
              helix.radius * 0.5,
            );
            const rampStartZ = stockAwareRampStart(
              helix.center,
              helix.radius,
              z,
              false,
            );
            const entryPoint = {
              x: helix.center.x + r,
              y: helix.center.y,
            };
            if (canUseStockAwareEntry) {
              moveToEntryAt(entryPoint, rampStartZ);
            } else {
              retractTo(retractZ);
              push('rapid', entryPoint.x, entryPoint.y, retractZ, 'rapid');
            }
            push('rapid', helix.center.x + r, helix.center.y, rampStartZ, 'rapid');
            if (rampStartZ > z + EPS) {
              emitHelix(helix.center, helix.radius, rampStartZ, z, 'ramp');
            } else {
              push('rapid', helix.center.x + r, helix.center.y, z, 'rapid');
            }
            // Short at-depth lead from the helix bottom to the pass start, inside
            // (or, from a corner bisector, at most 0.42 radius past) the disk the
            // helix just opened -- bounded by the planner's construction.
            push('feed', b.x, b.y, z, 'ramp');
          } else {
            assertStraightDescentIsClear(
              b,
              z,
              { kind: 'landing', fallbackHelixTooSmall: Boolean(pass.fallbackHelix) },
            );
            const rampStartZ = stockAwareRampStart(b, 0, z, false);
            if (canUseStockAwareEntry) {
              moveToEntryAt(b, rampStartZ);
            } else {
              retractTo(retractZ);
              push('rapid', b.x, b.y, retractZ, 'rapid');
            }
            push('rapid', b.x, b.y, rampStartZ, 'rapid');
            if (rampStartZ > z + EPS) push('feed', b.x, b.y, z, 'plunge');
            else push('rapid', b.x, b.y, z, 'rapid');
          }
        }
        break;
      }
      default: {
        // Exhaustiveness guard (ADR-0003): a new pass type must be handled.
        const _never: never = pass;
        throw new Error(`emitLevelPasses: unhandled pass type ${(_never as AdaptivePass).type}`);
      }
    }
  }

  return moves;
}
