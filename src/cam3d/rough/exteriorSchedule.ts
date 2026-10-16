// cam3d rough: RESTRICTED STAGED EXTERIOR PILOT -- rough an upward-open
// straight-wall boss in proven full stock from the outside in, stage by stage
// (WO-2793, step 3 of the outside-in roughing proposal, wo/WO-2654
// scoped-proposal.md "Later increments" item 3).
//
// STUDY ENTRY POINT ONLY. Nothing in the production rougher, worker, store or
// UI calls this; the default 3D rough is untouched. It returns a candidate
// schedule plus the evidence that proves it, or an UNRESOLVED verdict with a
// reason. Unresolved is study evidence -- never a job refusal: production keeps
// today's behaviour whatever this says.
//
// METHOD, per stage, top down:
//  1. Stages are planLevels() over the live stock top, the floor and the
//     required part-depth pins: the existing maximum stepdown, every pin hit
//     exactly. No deeper axial cut, no reordered or reversed precomputed moves:
//     each stage's motion is generated fresh against the stock that exists
//     after the stage above it.
//  2. Step 1 (exteriorAccess.ts) classifies the stage's band material on the
//     live stock. Only EXTERIOR components are cut here; enclosed, unreachable
//     and unresolved components, stock still standing above the band top (a
//     deeper axial cut) and the part grown by the radial stock to leave form
//     the KEEP-OUT. Exterior bulk goes first; cavities are evaluated afterwards
//     (re-run of step 1 on the final stock) and handed on as evidence.
//  3. Radial cutting is regenerated against live stock as tool-centre rings at
//     R + k*s from the keep-out (s = stepover * D), cut outermost first. Every
//     stock point a ring k touches beyond k*s + s was taken by a ring k' > k,
//     so no ring cuts wider than s: today's engagement, kept. The engagement
//     each ring actually takes on the live field is measured as it carves and a
//     window wider than s + one cell makes the whole pilot unresolved.
//     Rings that bound an enclosed free space (offset holes) are cavities: not
//     cut, counted.
//  4. EVERY move is judged by step 2 (exteriorEnvelope.ts, the whole tool
//     assembly against the live stock, part and workholding) before it is
//     accepted. Cuts may meet stock only with the cutting portion; descents
//     must go through proven air (clear AND no removal); links and step-ups may
//     touch nothing. Routes are offered cheapest first and the first one the
//     envelope proves clear is taken; every rejected candidate is recorded:
//       stay-down link at depth -> transition cut onto the next ring ->
//       lead-out + stay-down -> retreat over the clearance plane and descend
//       outside the stock (with and without a lead-out).
//     A stage with no proven route is unresolved; nothing is guessed clear.
//  5. Accepted cutting moves are carved into a PRIVATE clone of the stock in
//     order. A loop's cuts are judged as one batch against the stock before
//     that loop (more stock than the machine will meet: can only over-report).
//
// RESTRICTED (excluded until their proofs exist): under-shelf removal and
// overhangs (the field is one upward-open interval per column), radial-inward
// step-up along domes/tapers, a stage with no part island to work around, a
// stepover of half the diameter or more (a ring would then cut on both sides of
// its centre line, part climb, part conventional). Rings are cut whole where
// they cross air outside the stock: a pilot cost, not a saving claim.
//
// PURE + DETERMINISTIC (D-006) given geom2d's deterministic offsets: fixed
// iteration order, no RNG, no time. The caller's stock and part are never
// written.

import type { Tool, ToolHolder } from '../../types';
import type { CutterSpec } from '../kernel/types';
import type { IrMove } from '../ir/types';
import type { ReachBlocker, ReachPoint } from '../../lib/cam/holderClearance';
import { boolean, ensureGeom2dReady, offset, area, type Ring } from '../geom2d';
import { maxTraverseIntrusion, remainingAbove, removeSweep, ZDexelField } from '../stock';
import { analyzeExteriorAccess, type ExteriorAccess, type ExteriorAccessUnresolvedReason } from './exteriorAccess';
import {
  checkExteriorEnvelope,
  stockSolidColumns,
  type EnvelopeMoveRole,
  type EnvelopeWorkholding,
  type ExteriorEnvelopeUnresolvedReason,
} from './exteriorEnvelope';
import { planLevels } from './levels';

/** Material must stand this far above the tip to count (the envelope's floor tolerance). */
const FLOOR_TOL = 1e-3;
/** Sustained-engagement window, mm (the 2D engine's B8 gate and pathEngagement default). */
const ENGAGEMENT_WINDOW_MM = 2;

export type ExteriorScheduleRoute =
  | 'entry'
  | 'ring'
  | 'transition'
  | 'lead-out'
  | 'stay-down'
  | 'retreat'
  | 'exit';

export interface ExteriorScheduleMove {
  role: EnvelopeMoveRole;
  route: ExteriorScheduleRoute;
  /** Stage index, or -1 for the final exit. */
  stage: number;
  from: ReachPoint;
  to: ReachPoint;
}

export interface RejectedCandidate {
  stage: number;
  /** Which route was offered. */
  route: ExteriorScheduleRoute;
  /** collision, unresolved, or a descent that would cut instead of passing through air. */
  verdict: 'collision' | 'unresolved' | 'descent-cuts-stock';
  collisions: readonly ReachBlocker[];
}

export interface DeferredComponent {
  stage: number;
  access: ExteriorAccess;
  columns: number;
  witnessX: number;
  witnessY: number;
}

export interface ExteriorStage {
  index: number;
  z: number;
  bandTopZ: number;
  /** Live stock revision the stage was classified and planned against. */
  stockRevision: number;
  exteriorColumns: number;
  /** Non-exterior band components kept out of this stage (cavities afterwards). */
  deferred: readonly DeferredComponent[];
  /** Ring offsets (0..ringCount-1) the stage planned. */
  ringCount: number;
  loopsCut: number;
  /** Offset holes: rings round an enclosed free space, never cut by this pilot. */
  cavityLoops: number;
  removedVolumeMm3: number;
  /** Widest sustained radial width the stage took, mm, measured on the live field. */
  peakWidthMm: number;
}

export type ExteriorScheduleUnresolvedReason =
  | ExteriorAccessUnresolvedReason
  | ExteriorEnvelopeUnresolvedReason
  | 'invalid-input'
  | 'no-part-island'
  | 'no-route'
  | 'cut-collision'
  | 'engagement-over-limit';

export interface CavityEvidence {
  stage: number;
  bandTopZ: number;
  bottomZ: number;
  access: ExteriorAccess;
  columns: number;
  witnessX: number;
  witnessY: number;
}

export interface ExteriorScheduleResult {
  status: 'planned' | 'unresolved';
  reason?: ExteriorScheduleUnresolvedReason;
  /** Stage the unresolved verdict came from (-1: whole input). */
  unresolvedStage?: number;
  /** Stage planes in order; pins and the floor are members. */
  levels: readonly number[];
  stages: readonly ExteriorStage[];
  /** Empty unless status === 'planned'. */
  moves: readonly ExteriorScheduleMove[];
  rejected: readonly RejectedCandidate[];
  /** Band material left in non-exterior components after every exterior stage. */
  cavities: readonly CavityEvidence[];
  /** Stepover width s, mm. */
  stepoverMm: number;
  /** The private stock after every accepted cut, and its revision. */
  stock: ZDexelField;
  stockRevision: number;
}

export interface ExteriorScheduleInput {
  /** Live stock (never mutated). */
  stock: ZDexelField;
  stockRevision: number;
  /** True only when `stock` is proven full stock (its edge is open air). */
  fullStockProof: boolean;
  /** 'world' only when stock, part and fixtures share one frame. */
  frame: 'world' | 'mismatched' | 'unknown';
  /** The part's top-surface heightfield (one upward-open interval per column). */
  part: ZDexelField;
  tool: Tool;
  holder?: ToolHolder;
  workholding: EnvelopeWorkholding;
  /** Neck/shank/holder clearance from part and stock, and from fixtures, mm. */
  allowanceMm: number;
  /** Cutting-head clearance from the part the envelope enforces, mm. */
  partAllowanceMm: number;
  /** Radial skin left on part walls (the keep-out growth), mm. */
  radialStockToLeave: number;
  /** Today's maximum axial depth per level, mm. */
  maxStepdown: number;
  /** Today's stepover, a fraction 0..1 of tool diameter. */
  stepover: number;
  floorZ: number;
  /** Horizontal part surfaces (plus axial stock) every ladder must land on. */
  requiredDepths?: readonly number[];
  /** Height every retreat link travels at; above all stock, part and fixtures. */
  clearanceZ: number;
  /** Physical direction for a clockwise spindle; default climb. */
  millingDirection?: 'climb' | 'conventional';
}

interface Pt2 { x: number; y: number }

const dist = (a: Pt2, b: Pt2): number => Math.hypot(a.x - b.x, a.y - b.y);
const p3 = (p: Pt2, z: number): ReachPoint => ({ x: p.x, y: p.y, z });

function cutterOf(tool: Tool): CutterSpec | undefined {
  if (!(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return undefined;
  if (tool.type === 'flat_end_mill') return { kind: 'flat', diameter: tool.diameter };
  if (tool.type === 'ball_end_mill') return { kind: 'ball', diameter: tool.diameter };
  return undefined;
}

function ringPoints(ring: Ring, reverse: boolean): Pt2[] {
  const pts: Pt2[] = [];
  for (let k = 0; k < ring.length; k += 2) pts.push({ x: ring[k], y: ring[k + 1] });
  return reverse ? pts.reverse() : pts;
}

function nearestIndex(pts: readonly Pt2[], p: Pt2, ok?: (q: Pt2) => boolean): number {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < pts.length; k++) {
    if (ok && !ok(pts[k])) continue;
    const d = dist(pts[k], p);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** Rings of the field columns flagged in `mask` (cell squares, geom2d convention). */
function maskRings(field: ZDexelField, mask: Uint8Array): Ring[] {
  const tops = new Float64Array(mask.length);
  for (let c = 0; c < mask.length; c++) tops[c] = mask[c] ? 1 : 0;
  const { originX, originY, nx, ny, cell } = field;
  return remainingAbove(ZDexelField.fromColumnTops({ originX, originY, nx, ny, cell }, tops, 0), 0.5);
}

/** Distance from (x, y) to the region bounded by `rings` (0 inside). */
function distanceToRegion(rings: readonly Ring[], x: number, y: number): number {
  let inside = false;
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      const ex = xi - xj, ey = yi - yj;
      const l2 = ex * ex + ey * ey;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xj) * ex + (y - yj) * ey) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - (xj + ex * t), y - (yj + ey * t)));
    }
  }
  return inside ? 0 : best;
}

/** True when no stock column whose square the cutter disk at (x, y) may touch stands above `z`. */
function footprintInAir(field: ZDexelField, x: number, y: number, z: number, reach: number): boolean {
  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const i0 = Math.max(0, Math.floor((x - reach - originX) / cell));
  const i1 = Math.min(nx - 1, Math.floor((x + reach - originX) / cell));
  const j0 = Math.max(0, Math.floor((y - reach - originY) / cell));
  const j1 = Math.min(ny - 1, Math.floor((y + reach - originY) / cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * nx + i;
      if (!(top[c] > bottom[c]) || !(top[c] > z + FLOOR_TOL)) continue;
      if (Math.hypot(field.centerX(i) - x, field.centerY(j) - y) <= reach) return false;
    }
  }
  return true;
}

/**
 * Plan the restricted exterior pilot. Throws only for malformed numbers;
 * every limit of the pilot is an unresolved verdict with a reason.
 */
export async function planExteriorStages(input: ExteriorScheduleInput): Promise<ExteriorScheduleResult> {
  await ensureGeom2dReady();
  const live = input.stock.clone();
  let revision = input.stockRevision;
  const cutter = cutterOf(input.tool);
  const R = input.tool.diameter / 2;
  const s = input.stepover * input.tool.diameter;
  const cell = live.cell;
  const reverse = (input.millingDirection ?? 'climb') === 'climb';
  const stages: ExteriorStage[] = [];
  const moves: ExteriorScheduleMove[] = [];
  const rejected: RejectedCandidate[] = [];
  let levels: number[] = [];

  const result = (
    status: 'planned' | 'unresolved',
    extra: { reason?: ExteriorScheduleUnresolvedReason; unresolvedStage?: number; cavities?: CavityEvidence[] } = {},
  ): ExteriorScheduleResult => ({
    status,
    ...(extra.reason !== undefined ? { reason: extra.reason, unresolvedStage: extra.unresolvedStage } : {}),
    levels,
    stages,
    moves: status === 'planned' ? moves : [],
    rejected,
    cavities: extra.cavities ?? [],
    stepoverMm: s,
    stock: live,
    stockRevision: revision,
  });
  const unresolved = (reason: ExteriorScheduleUnresolvedReason, stage: number) =>
    result('unresolved', { reason, unresolvedStage: stage });

  if (!cutter) return unresolved('cutter-not-supported', -1);
  if (!input.fullStockProof) return unresolved('no-full-stock-proof', -1);
  if (input.frame !== 'world') return unresolved('frame-unproven', -1);
  if (input.workholding.status !== 'complete') return unresolved('workholding-incomplete', -1);
  if (!(input.stepover > 0 && input.stepover < 0.5) || !(input.radialStockToLeave >= 0)
    || ![input.clearanceZ, input.floorZ, input.maxStepdown].every(Number.isFinite)) {
    return unresolved('invalid-input', -1);
  }

  let stockTopZ = -Infinity;
  for (let c = 0; c < live.top.length; c++) {
    if (live.top[c] > live.bottom[c] && live.top[c] > stockTopZ) stockTopZ = live.top[c];
  }
  if (!(stockTopZ > input.floorZ) || !(input.clearanceZ > stockTopZ)) return unresolved('invalid-input', -1);
  levels = planLevels(stockTopZ, input.floorZ, input.maxStepdown, input.requiredDepths ?? []);
  const partColumns = stockSolidColumns(input.part);

  // ── Envelope judgement of one candidate against the LIVE stock ────────────
  type Judged = { ok: true } | { ok: false; reason?: ExteriorEnvelopeUnresolvedReason };
  const judge = (stage: number, route: ExteriorScheduleRoute, segs: ExteriorScheduleMove[]): Judged => {
    const r = checkExteriorEnvelope({
      field: live,
      stockRevision: revision,
      fullStockProof: input.fullStockProof,
      frame: input.frame,
      tool: input.tool,
      holder: input.holder,
      part: partColumns,
      workholding: input.workholding,
      allowanceMm: input.allowanceMm,
      partAllowanceMm: input.partAllowanceMm,
      segments: segs.map(m => ({ role: m.role, from: m.from, to: m.to })),
    });
    const airless = r.segments.some(g => g.role === 'descent' && g.removesStock);
    if (r.verdict === 'clear' && !airless) return { ok: true };
    const collisions = r.segments.flatMap(g => g.collisions);
    rejected.push({
      stage, route,
      verdict: r.verdict === 'clear' ? 'descent-cuts-stock' : r.verdict,
      collisions,
    });
    return { ok: false, reason: r.verdict === 'unresolved' ? r.reason : undefined };
  };

  // ── Carve accepted cutting moves, measuring the sustained radial width ────
  let window: { len: number; vol: number }[] = [];
  let peakWidth = 0;
  let stageRemoved = 0;
  let stageDepth = 1;
  const carve = (m: ExteriorScheduleMove): void => {
    const r = removeSweep(live, { x0: m.from.x, y0: m.from.y, z0: m.from.z, x1: m.to.x, y1: m.to.y, z1: m.to.z }, cutter);
    if (r.columnsChanged > 0) revision++;
    stageRemoved += r.removedVolumeMm3;
    if (m.role !== 'cut') return;
    window.push({ len: Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), vol: r.removedVolumeMm3 });
    let len = 0;
    let vol = 0;
    for (let k = window.length - 1; k >= 0; k--) {
      len += window[k].len;
      vol += window[k].vol;
      if (len >= ENGAGEMENT_WINDOW_MM) {
        window = window.slice(k);
        peakWidth = Math.max(peakWidth, vol / (len * stageDepth));
        break;
      }
    }
  };
  const accept = (segs: ExteriorScheduleMove[]): void => {
    for (const m of segs) {
      moves.push(m);
      if (m.role === 'cut' || m.role === 'descent') carve(m);
      // A sustained window is one continuous cut; any other motion ends it.
      if (m.role !== 'cut') window = [];
    }
  };

  let cur: ReachPoint | undefined;
  // The ring the tool last finished, for a lead-out away from its wall.
  let tail: { keepOut: Ring[]; k: number; z: number; leadOutMm: number } | undefined;
  const leadOut = (from: ReachPoint, stage: number): ExteriorScheduleMove | undefined => {
    if (!tail || tail.z !== from.z) return undefined;
    const out = offset(tail.keepOut, R + tail.k * s + tail.leadOutMm, { joinType: 'round' })
      .filter(r => area(r) > 0).flatMap(r => ringPoints(r, false));
    const t = nearestIndex(out, from);
    return t < 0 ? undefined : { role: 'cut', route: 'lead-out', stage, from, to: p3(out[t], from.z) };
  };

  for (let si = 0; si < levels.length; si++) {
    const z = levels[si];
    const bandTopZ = si === 0 ? stockTopZ : levels[si - 1];
    const stageRevision = revision;
    stageDepth = bandTopZ - z;
    window = [];
    peakWidth = 0;
    stageRemoved = 0;

    // ── 2. Step 1 on the live stock: what this band may cut. ────────────────
    const access = analyzeExteriorAccess({
      field: live, stockRevision: revision, band: { topZ: bandTopZ, bottomZ: z }, cutter,
      fullStockProof: input.fullStockProof,
    });
    if (access.unresolvedReason) return unresolved(access.unresolvedReason, si);
    const unresolvedComp = access.components.find(c => c.access === 'unresolved');
    if (unresolvedComp) return unresolved(unresolvedComp.reason ?? 'not-upward-open', si);
    const keepMask = new Uint8Array(live.nx * live.ny);
    let exteriorColumns = 0;
    const deferred: DeferredComponent[] = [];
    for (const comp of access.components) {
      if (comp.access === 'exterior') { exteriorColumns += comp.columns; continue; }
      deferred.push({ stage: si, access: comp.access, columns: comp.columns, witnessX: comp.witnessX, witnessY: comp.witnessY });
    }
    for (let c = 0; c < keepMask.length; c++) {
      const id = access.componentOf[c];
      if (id >= 0 && access.components[id].access !== 'exterior') keepMask[c] = 1;
    }
    const partSec = remainingAbove(input.part, z);
    if (partSec.length === 0) return unresolved('no-part-island', si);
    const grownPart = offset(partSec, input.radialStockToLeave, { joinType: 'round' });
    const standing = [...remainingAbove(live, bandTopZ), ...maskRings(live, keepMask)];
    const keepOut = standing.length > 0 ? boolean(grownPart, standing, 'union') : grownPart;

    // ── 3. Ring count from the farthest exterior band column. ───────────────
    let farthest = 0;
    for (let j = 0; j < live.ny; j++) {
      for (let i = 0; i < live.nx; i++) {
        const c = j * live.nx + i;
        const id = access.componentOf[c];
        if (id < 0 || access.components[id].access !== 'exterior') continue;
        farthest = Math.max(farthest, distanceToRegion(keepOut, live.centerX(i), live.centerY(j)));
      }
    }
    const ringCount = exteriorColumns === 0 ? 0 : Math.max(1, Math.ceil((farthest + cell) / s));
    const stage: ExteriorStage = {
      index: si, z, bandTopZ, stockRevision: stageRevision, exteriorColumns, deferred,
      ringCount, loopsCut: 0, cavityLoops: 0, removedVolumeMm3: 0, peakWidthMm: 0,
    };
    stages.push(stage);

    const airReach = R + cell * Math.SQRT2;
    const inAir = (q: Pt2) => footprintInAir(live, q.x, q.y, z, airReach);
    const leadOutMm = Math.min(s, 2 * cell);
    let prevLoop: { pts: Pt2[]; k: number } | undefined;

    for (let k = ringCount - 1; k >= 0; k--) {
      const rings = offset(keepOut, R + k * s, { joinType: 'round' });
      for (const ring of rings) {
        if (area(ring) <= 0) {
          stage.cavityLoops++;
          continue;
        }
        const pts = ringPoints(ring, reverse);
        const loopSegs = (start: number): ExteriorScheduleMove[] => {
          const out: ExteriorScheduleMove[] = [];
          for (let n = 0; n < pts.length; n++) {
            const a = pts[(start + n) % pts.length];
            const b = pts[(start + n + 1) % pts.length];
            out.push({ role: 'cut', route: 'ring', stage: si, from: p3(a, z), to: p3(b, z) });
          }
          return out;
        };

        // Air loop: no segment meets standing stock, nothing to cut or route to.
        const meetsStock = loopSegs(0).some(m =>
          maxTraverseIntrusion(live, { x0: m.from.x, y0: m.from.y, z0: z, x1: m.to.x, y1: m.to.y, z1: z }, cutter)
            .intrusionMm > FLOOR_TOL);
        if (!meetsStock) continue;

        // ── 4. Route to this loop: cheapest proven candidate first. ─────────
        type Candidate = { route: ExteriorScheduleRoute; segs: ExteriorScheduleMove[]; start: number };
        const candidates: Candidate[] = [];
        const descendAt = (from: ReachPoint): number => nearestIndex(pts, from, inAir);
        const mv = (role: EnvelopeMoveRole, route: ExteriorScheduleRoute, from: ReachPoint, to: ReachPoint) =>
          ({ role, route, stage: si, from, to });
        const retreat = (from: ReachPoint, prefix: ExteriorScheduleMove[]): Candidate | undefined => {
          const d = descendAt(from);
          if (d < 0) return undefined;
          const top = p3(from, input.clearanceZ);
          const above = p3(pts[d], input.clearanceZ);
          const segs = [...prefix];
          if (from.z < input.clearanceZ) segs.push(mv('step-up', 'retreat', from, top));
          segs.push(mv('link', 'retreat', top, above), mv('descent', 'retreat', above, p3(pts[d], z)));
          return { route: 'retreat', segs, start: d };
        };
        if (cur === undefined) {
          // First entry: the air vertex nearest the stock's minimum corner.
          const d = nearestIndex(pts, { x: live.originX, y: live.originY }, inAir);
          if (d >= 0) {
            const above = p3(pts[d], input.clearanceZ);
            candidates.push({ route: 'entry', segs: [mv('descent', 'entry', above, p3(pts[d], z))], start: d });
          }
        } else if (cur.z === z) {
          const from = cur;
          const near = nearestIndex(pts, from);
          candidates.push({ route: 'stay-down', segs: [mv('link', 'stay-down', from, p3(pts[near], z))], start: near });
          if (prevLoop && prevLoop.k === k + 1) {
            // Transition: from the loop's end, a cut that reaches this ring one
            // cutter diameter further along; its bite grows from nothing to s.
            const back = prevLoop.pts;
            let along = 0;
            let a = 0;
            while (along < 2 * R && a < back.length) {
              along += dist(back[a], back[(a + 1) % back.length]);
              a++;
            }
            const aheadPt = back[a % back.length];
            const t = nearestIndex(pts, aheadPt);
            if (t >= 0 && dist(aheadPt, pts[t]) <= s + cell) {
              candidates.push({ route: 'transition', segs: [mv('cut', 'transition', from, p3(pts[t], z))], start: t });
            }
          }
          const lo = leadOut(from, si);
          if (lo) {
            candidates.push({ route: 'stay-down', segs: [lo, mv('link', 'stay-down', lo.to, p3(pts[nearestIndex(pts, lo.to)], z))], start: nearestIndex(pts, lo.to) });
          }
          const r0 = retreat(from, []);
          if (r0) candidates.push(r0);
          if (lo) {
            const r1 = retreat(lo.to, [lo]);
            if (r1) candidates.push(r1);
          }
        } else {
          // New stage: the tool stands on the stage above.
          const from = cur;
          const d = descendAt(from);
          const lo = leadOut(from, si);
          const stayDown = (origin: ReachPoint, prefix: ExteriorScheduleMove[]): Candidate | undefined => d < 0 ? undefined : {
            route: 'stay-down',
            segs: [...prefix, mv('link', 'stay-down', origin, p3(pts[d], origin.z)), mv('descent', 'stay-down', p3(pts[d], origin.z), p3(pts[d], z))],
            start: d,
          };
          for (const c of [stayDown(from, []), lo && stayDown(lo.to, [lo]), retreat(from, []), lo && retreat(lo.to, [lo])]) {
            if (c) candidates.push(c);
          }
        }

        let chosen: Candidate | undefined;
        let envelopeReason: ExteriorEnvelopeUnresolvedReason | undefined;
        for (const c of candidates) {
          const j = judge(si, c.route, c.segs);
          if (j.ok) { chosen = c; break; }
          envelopeReason ??= j.reason;
        }
        if (!chosen) return unresolved(envelopeReason ?? 'no-route', si);
        accept(chosen.segs);

        const cuts = loopSegs(chosen.start);
        const cutJudge = judge(si, 'ring', cuts);
        if (!cutJudge.ok) return unresolved(cutJudge.reason ?? 'cut-collision', si);
        accept(cuts);
        stage.loopsCut++;
        cur = cuts[cuts.length - 1].to;
        // The loop ends where it started; the next transition reads it from there.
        prevLoop = { pts: [...pts.slice(chosen.start), ...pts.slice(0, chosen.start)], k };
        tail = { keepOut, k, z, leadOutMm };
      }
    }
    stage.removedVolumeMm3 = stageRemoved;
    stage.peakWidthMm = peakWidth;
    if (peakWidth > s + cell) return unresolved('engagement-over-limit', si);
  }

  // ── Exit: lift over everything from wherever the last ring ended. ─────────
  if (cur) {
    const from = cur;
    const up = (o: ReachPoint): ExteriorScheduleMove =>
      ({ role: 'step-up', route: 'exit', stage: -1, from: o, to: p3(o, input.clearanceZ) });
    const lo = leadOut(from, -1);
    const options = [[up(from)], ...(lo ? [[lo, up(lo.to)]] : [])];
    const ok = options.find(segs => judge(-1, 'exit', segs).ok);
    if (!ok) return unresolved('no-route', -1);
    accept(ok);
  }

  // ── Cavities afterwards: re-run step 1 on the final stock. ────────────────
  const cavities: CavityEvidence[] = [];
  for (let si = 0; si < levels.length; si++) {
    const bandTopZ = si === 0 ? stockTopZ : levels[si - 1];
    const after = analyzeExteriorAccess({
      field: live, stockRevision: revision, band: { topZ: bandTopZ, bottomZ: levels[si] }, cutter,
      fullStockProof: input.fullStockProof,
    });
    for (const comp of after.components) {
      if (comp.access === 'exterior') continue;
      cavities.push({
        stage: si, bandTopZ, bottomZ: levels[si], access: comp.access, columns: comp.columns,
        witnessX: comp.witnessX, witnessY: comp.witnessY,
      });
    }
  }
  return result('planned', { cavities });
}

/**
 * The schedule as IR for measurement and pictures: a rapid to the start over
 * the clearance plane, cuts as 'cut', descents as 'plunge', links at depth as
 * 'stepover', step-ups and links on the clearance plane as rapids.
 */
export function exteriorScheduleToIr(moves: readonly ExteriorScheduleMove[], clearanceZ: number): IrMove[] {
  if (moves.length === 0) return [];
  const first = moves[0].from;
  const ir: IrMove[] = [{ t: 'rapid', x: first.x, y: first.y, z: first.z, role: 'rapid' }];
  for (const m of moves) {
    const { x, y, z } = m.to;
    if (m.role === 'cut') ir.push({ t: 'feed', x, y, z, role: 'cut' });
    else if (m.role === 'descent') ir.push({ t: 'feed', x, y, z, role: 'plunge' });
    else if (m.role === 'link' && Math.min(m.from.z, z) < clearanceZ) ir.push({ t: 'feed', x, y, z, role: 'stepover' });
    else ir.push({ t: 'rapid', x, y, z, role: 'rapid' });
  }
  return ir;
}
