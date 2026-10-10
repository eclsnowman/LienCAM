// cam3d rough: SUSTAINED RADIAL ENGAGEMENT measured on the EMITTED toolpath.
//
// WO-100's rule: "No move emitted by an adaptive strategy may exceed the strategy's
// engagement limit. If a region cannot be cleared within that limit, it must not be
// silently cut at full width." Enforcing that needs a bound that is CHECKABLE ON THE
// EMITTED PATH -- not an intention inside the generator. This module is that check:
// hand it an IR move list plus the stock it runs on and it reports, in tool-diameter
// fractions, the worst SUSTAINED radial width the path actually cuts.
//
// METHOD (the same metric the 2D engine's own B8 gate uses, and Gate A.2 in
// roughGateA):
//   1. Replay every move into a fresh ZDexelField so each measurement sees the stock
//      state the machine would physically be in at that instant.
//   2. For each lateral cutting move, engagementAt gives removedVolume / moveLength
//      (mm^2), so removedVolume is the fresh material the move actually takes. Divide
//      that by what a FULL-WIDTH SLOT with THIS cutter at THIS axial depth would remove
//      over the same distance -- slotCrossSectionMm2 * length -- and the move's
//      engagement falls out as a pure fraction, 1.0 == full slot.
//   3. Radial engagement is a SUSTAINED quantity. A single sub-cell step can graze a
//      sliver and read an absurd instantaneous fraction (tiny volume over a tinier
//      length) while removing nothing real. So the reported figure is the peak WINDOWED
//      average over contiguous cutting runs (default window 2mm) -- a genuine slot
//      carries cap-level material for every one of those millimetres; a quantization
//      spike averages away.
//
// WHY THE NORMALISER IS PROFILE-AWARE, AND NOT JUST `diameter * depth` (WO-100 audit,
// attempt 1): adaptiveRough accepts flat AND ball cutters. A flat cutter sweeps a
// vertical wall, so its full-slot cross-section is exactly diameter * depth and
// "fraction of a full slot" and "fraction of tool diameter" are the same number. A ball
// nose is a sphere: at 1mm depth a 10mm ball removes a 4.09 mm^2 circular segment where
// a 10mm flat removes 10.00 mm^2. Dividing a ball path's volume by depth and comparing
// it to the diameter therefore understates its engagement by that ratio -- a ball
// cutting a genuine full-width slot measured 41.6% and passed a 75% cap. Normalising
// against the cutter's OWN full-slot cross-section makes 1.0 mean the same physical
// thing for both kinds, and leaves every flat measurement arithmetically identical.
//
// SLAB DEPTH: the rougher cuts one Z level at a time with rest-between-levels, so the
// material standing above a move at level z reaches only to the level above it. The
// slab depth for z is therefore (next distinct cutting Z above z, or the stock top)
// minus z -- derived from the move list itself, so the helper needs no level plan.
//
// ROLES MEASURED: by default 'cut', 'finish' and 'stepover' -- the moves that travel
// laterally at depth. A caller can select another role set (for example only 'lead_in')
// without losing physical stock history: every non-measured move is still replayed and
// ends the contiguous measurement run.
//
// REPLAY RESOLUTION (WO-1253): the replay field must RESOLVE THE CUTTER, and the
// caller's own cell size is not required to. Removed width is quantized to whole
// columns, so on a 1.5mm field a 4mm cutter's radial width can only read as a
// multiple of 1.5mm -- 0%, 37%, 75%, 112% -- and the 2mm sustained window spans
// barely one cell, so nothing averages the quantization away. The coarse pocket
// rough of roughGateA A.5 read 107.4% of a full slot with 17.15mm over cap on
// its adaptive bulk pass, and the SAME move list read 60.4% / 0.00mm at 0.75mm,
// 56.0% / 0.00mm at 0.50mm and 52.9% / 0.00mm at 0.375mm -- converging on the
// 50% stepover it was planned for. Above 100% mid-run is physically impossible
// and is the read announcing itself. So the replay field is refined until the
// cutter spans MIN_REPLAY_CELLS_ACROSS_CUTTER columns (bounded, see
// replayCellFor). The cap, the window and the transient allowance are untouched:
// this makes the ruler finer, never the limit looser. Real slotting still reads
// over the cap at every resolution (the same A.5 path's wall-cleanup contour:
// 104.8% at 1.5mm, 83.6% at 0.375mm, 12.15mm over cap either way).
//
// ACCURACY (WO-1269): the read is the width of fresh material quantized to whole
// replay columns, so it is exact to ONE REPLAY COLUMN of the cutter's diameter
// (replay / D: 8.3% at the app's derived cell for a 9.52mm cutter, 12.5% at the
// eight-column floor, 17.5% at a 5mm caller cell where the 3x bound sets the
// replay at 1.67mm), plus a rim of straddling columns around every entry disc
// that amortizes with run length. Measured against analytic fixtures
// (src/tests/cam3d/narrowCorridorEngagement.wo1269.test.ts): a fresh strip of
// any width reads within that column of its true fraction at every cell, so a
// true engagement more than one column above the cap ALWAYS reads over it. The
// blind band is (cap, cap + one column], and only a straight, axis-aligned pass
// whose fresh edge sits mid-column lands in it. A narrow corridor is NOT a blind
// spot: a 9.52mm cutter down a 10.00mm corridor removes its full width and reads
// a full slot (100-105%) at every cell, whether the corridor is a channel in
// solid stock or a 10mm rib standing in air. What the ruler cannot see is what a
// caller-built starting field never held: standing material is stored to the
// CALLER's cell, so a 10mm rib on a 1.5mm field is 9.0mm, one caller column on
// top of the ruler's own budget (resampleOntoReplayGrid cannot invent it). The
// shakedown 4.1 ring with no refusal was therefore the engine never driving the
// ring's legs; its corner nibbles read 46% at 0.79mm and 40% at 0.2mm.
//
// PURE + DETERMINISTIC (D-006): no globals, no RNG, no time; it never mutates its
// inputs (the field is built here and discarded).

import { ZDexelField, removeSweep, engagementAt, sweepProfile, type Box3 } from '../stock';
import { forEachLinearSweep, replaySagittaFor } from './replayStock';
import type { CutterSpec } from '../kernel/types';
import type { IrMove, IrMoveRole } from '../ir/types';

/** Roles that travel laterally at cutting depth, so carry a radial width. */
const LATERAL_CUT_ROLES: ReadonlySet<IrMoveRole> = new Set<IrMoveRole>(['cut', 'finish', 'stepover']);

/**
 * Columns the replay field must span across the cutter before a radial-width read
 * means anything (WO-1253, module header). Eight puts the quantization step at an
 * eighth of the diameter, which measured 56.0% against a 52.9% converged truth on
 * the A.5 path where the caller's own 2.7-cells-across field read 107.4%.
 */
const MIN_REPLAY_CELLS_ACROSS_CUTTER = 8;
/**
 * ... but never refine by more than this factor below the caller's cell. The
 * replay's cost is superlinear in resolution (engagementAt clones the field per
 * sub-sweep and the arc sagitta is cell/4), so an unbounded floor would let a fine
 * cutter on a coarse field turn a planning-time check into the job's longest phase.
 * A bounded floor still measures far better than the caller's cell alone.
 */
const MAX_REPLAY_REFINEMENT = 3;

/** The cell the replay field is built at: fine enough to resolve the cutter, bounded. */
function replayCellFor(cellSize: number, cutter: CutterSpec): number {
  const resolvesCutter = cutter.diameter / MIN_REPLAY_CELLS_ACROSS_CUTTER;
  const floor = cellSize / MAX_REPLAY_REFINEMENT;
  return Math.max(Math.min(cellSize, resolvesCutter), floor);
}

/**
 * Re-sample a caller's starting field onto the (finer) replay grid: every replay
 * column takes the material state of the caller's column its centre falls in.
 *
 * This does NOT invent detail the caller's field never had -- the starting state
 * stays staircased at the caller's cell. What it buys is that the sweeps measured
 * ON it are resolved at the replay cell, which is where the quantization the
 * module header describes actually enters.
 */
function resampleOntoReplayGrid(coarse: ZDexelField, stockBounds: Box3, replayCell: number): ZDexelField {
  if (replayCell >= coarse.cell - 1e-12) return coarse;
  const fine = ZDexelField.fromBox(stockBounds, replayCell);
  // fromBox honours the cell budget and may hand back a coarser grid than asked.
  if (fine.cell >= coarse.cell - 1e-12) return coarse;
  for (let j = 0; j < fine.ny; j++) {
    const y = fine.originY + (j + 0.5) * fine.cell;
    const cj = Math.min(coarse.ny - 1, Math.max(0, Math.floor((y - coarse.originY) / coarse.cell)));
    for (let i = 0; i < fine.nx; i++) {
      const x = fine.originX + (i + 0.5) * fine.cell;
      const ci = Math.min(coarse.nx - 1, Math.max(0, Math.floor((x - coarse.originX) / coarse.cell)));
      const src = cj * coarse.nx + ci;
      const dst = j * fine.nx + i;
      fine.top[dst] = coarse.top[src];
      fine.bottom[dst] = coarse.bottom[src];
    }
  }
  return fine;
}

/**
 * Cross-section area (mm^2, normal to travel) that a FULL-WIDTH SLOT of `depthMm`
 * removes with this cutter -- the 1.0 reference the reported fraction is measured
 * against. Profile-aware, because the cutter's own shape decides how much material a
 * slot at a given depth contains:
 *
 *   flat: a vertical wall, so exactly diameter * depth.
 *   ball: the cutter half-width at height h above the tip is sqrt(R^2 - (R-h)^2) for
 *         h <= R and R above that, so the slot cross-section is the circular segment
 *           R^2 * acos((R-d)/R) - (R-d) * sqrt(2Rd - d^2)          for d <= R
 *         and that half-disc plus the full-width rectangle above it for d > R. This is
 *         STRICTLY LESS than diameter * depth at the same depth (4.09 vs 10.00 mm^2 for
 *         a 10mm ball at 1mm), which is exactly why normalising a ball path against
 *         diameter * depth under-reports its engagement.
 *
 * Fails loud for cutter kinds the sweep cannot profile (bull/vbit), same as removeSweep.
 */
export function slotCrossSectionMm2(cutter: CutterSpec, depthMm: number): number {
  const prof = sweepProfile(cutter);
  if (!(depthMm > 0) || !Number.isFinite(depthMm)) {
    throw new Error(`slotCrossSectionMm2: depth must be finite and > 0, got ${depthMm}.`);
  }
  const R = prof.radius;
  if (prof.kind === 'flat') return 2 * R * depthMm;
  // ball
  if (depthMm >= R) return (Math.PI * R * R) / 2 + (depthMm - R) * 2 * R;
  const d = depthMm;
  return R * R * Math.acos((R - d) / R) - (R - d) * Math.sqrt(2 * R * d - d * d);
}

export interface PathEngagementOptions {
  /** Sustained-window length, mm. Default 2 (matches the engine's B8 gate). */
  windowMm?: number;
  /**
   * Over-cap accounting threshold, as a fraction of a FULL-WIDTH SLOT with this cutter
   * at the same axial depth (see peakFraction). Default 0.75.
   */
  capFraction?: number;
  /** Roles to measure. All moves are still replayed so stock state stays real. */
  measuredRoles?: ReadonlySet<IrMoveRole>;
  /**
   * Optional axial depths for the caller's real cutting planes. Moves at Z
   * values absent from this map are still replayed into stock, but are not
   * measured. Interleaved cleanup phases use this to avoid inventing thinner
   * bulk slabs from their revisited midpoint Z values.
   */
  slabDepthsByZ?: ReadonlyMap<number, number>;
  /**
   * Diagnostic hook: called once per measured move whose sliding window exceeds
   * capFraction, with the move's midpoint, role, lateral length and the window's
   * fraction. Lets a report list WHERE a path over-engages instead of only the peak.
   */
  onOverCap?: (hit: {
    x: number; y: number; z: number; role: IrMoveRole; lengthMm: number; fraction: number;
    /**
     * Index in the supplied `moves` array of the move whose travel this window sits on.
     * An arc is walked as many sub-sweeps and every one of them reports the arc's own
     * index, so a caller can act on the MOVE (drop it, split the pass there) instead of
     * having to match a midpoint back to the path (WO-1253).
     */
    moveIndex: number;
  }) => void;
  /**
   * The material actually standing in front of the cutter when this path starts.
   * Default -- and every pre-WO-1252 caller's behaviour, unchanged -- is
   * `ZDexelField.fromBox(stockBounds, cellSize)`, an UNCUT box.
   *
   * That default is a lie for a REST job. A second rough runs on the field the first
   * one left behind, so replaying it into an uncut box charges it for material that is
   * not there any more and reports engagement above the physical maximum: 101% of a
   * full slot with 585.7mm of a 726.3mm path over the cap on
   * `restFromRetainedStock.wo277`, which is how the fiction announces itself. A caller
   * that knows the real starting field hands it over here and gets a load measurement
   * instead of a diagnostic (WO-1252).
   *
   * The field is CLONED before the replay carves it, so the caller's copy is untouched.
   * It must describe the same grid as `stockBounds`/`cellSize`; a mismatch throws rather
   * than silently measuring a path against a field that indexes somewhere else.
   */
  startingStock?: ZDexelField;
}

export interface PathEngagementResult {
  /**
   * Worst sustained engagement as a FRACTION of a full-width slot with THIS cutter at
   * the same axial depth: 1.0 == the move removes everything a slot would. For a flat
   * cutter this is identically the radial cut width as a fraction of tool DIAMETER,
   * because a flat slot's cross-section is diameter * depth; for a ball the reference
   * follows the sphere profile instead (see slotCrossSectionMm2), so 1.0 keeps meaning
   * "full slot" rather than silently reading low.
   *
   * Can exceed 1.0 slightly on a short pass: the entry/exit discs at the ends of a move
   * remove more than the straight run does, and they amortize away only as length grows.
   */
  peakFraction: number;
  /** Where that worst window sits, or null when the path cuts nothing laterally. */
  peakAt: { x: number; y: number; z: number } | null;
  /** Total lateral cutting length whose window average exceeds capFraction, mm. */
  overCapLengthMm: number;
  /**
   * The longest CONTIGUOUS stretch of over-cap cutting, mm -- the worst single
   * uninterrupted bite, where `overCapLengthMm` is the sum of every such bite anywhere
   * on the path.
   *
   * The two answer different questions and a caller has to pick deliberately. A
   * 10 mm ring with no bounded corridor cuts one 5 mm+ over-cap stretch after another;
   * a rest job taking the corner material a bigger cutter could not reach takes four
   * sub-millimetre nibbles at one corner across two levels. Both can total the same
   * few millimetres, but only the first is a cutter-breaking SUSTAINED load, and the
   * sum grows with path length at fixed severity while this does not (WO-1252).
   *
   * A stretch is broken by any move at or under the cap and by anything that ends the
   * contiguous cutting run (a retract, a rapid, a lead-in) -- the cutter is out of the
   * material, so the load is not sustained across it.
   */
  longestOverCapRunMm: number;
  /** Total lateral cutting length measured, mm. */
  cuttingLengthMm: number;
  /** The capFraction actually used (echoed so a report can quote it). */
  capFraction: number;
}

/**
 * Validate a caller-supplied starting field against the box the path is measured on,
 * then hand back a private copy. Same shape of check as adaptiveRough's retained-stock
 * gate, restated here rather than imported because adaptiveRough imports this module.
 */
function cloneStartingStock(field: ZDexelField, stockBounds: Box3, cellSize: number): ZDexelField {
  const diffs: string[] = [];
  if (field.requestedCellSize !== cellSize) {
    diffs.push(`cell size ${cellSize} mm requested, field built with ${field.requestedCellSize} mm`);
  }
  if (field.originX !== stockBounds.minX || field.originY !== stockBounds.minY) {
    diffs.push(
      `origin (${stockBounds.minX}, ${stockBounds.minY}) requested, `
      + `field starts at (${field.originX}, ${field.originY})`,
    );
  }
  const expectedNx = Math.max(1, Math.ceil((stockBounds.maxX - stockBounds.minX) / field.cell - 1e-9));
  const expectedNy = Math.max(1, Math.ceil((stockBounds.maxY - stockBounds.minY) / field.cell - 1e-9));
  if (field.nx !== expectedNx || field.ny !== expectedNy) {
    diffs.push(
      `a ${expectedNx} x ${expectedNy} grid at ${field.cell} mm cells requested, `
      + `field is ${field.nx} x ${field.ny}`,
    );
  }
  if (diffs.length > 0) {
    throw new Error(
      `measurePathEngagement: startingStock describes a different grid (${diffs.join('; ')}). `
      + `Measuring against it would read material from the wrong columns.`,
    );
  }
  return field.clone();
}

/**
 * Measure sustained radial engagement over an emitted toolpath.
 *
 * @param moves       the IR move list, in emission order.
 * @param stockBounds the stock box the path runs on (uncut).
 * @param cellSize    z-dexel cell size for the replay field, mm.
 * @param cutter      the cutter the path was generated for (flat or ball).
 */
export function measurePathEngagement(
  moves: readonly IrMove[],
  stockBounds: Box3,
  cellSize: number,
  cutter: CutterSpec,
  opts?: PathEngagementOptions,
): PathEngagementResult {
  const windowMm = opts?.windowMm ?? 2.0;
  const capFraction = opts?.capFraction ?? 0.75;
  const measuredRoles = opts?.measuredRoles ?? LATERAL_CUT_ROLES;
  if (!(windowMm > 0) || !Number.isFinite(windowMm)) {
    throw new Error(`measurePathEngagement: windowMm must be finite and > 0, got ${windowMm}.`);
  }
  if (!(capFraction > 0) || !Number.isFinite(capFraction)) {
    throw new Error(`measurePathEngagement: capFraction must be finite and > 0, got ${capFraction}.`);
  }
  if (!(cutter.diameter > 0) || !Number.isFinite(cutter.diameter)) {
    throw new Error(`measurePathEngagement: invalid cutter diameter ${cutter.diameter}.`);
  }
  // Fail loud NOW for a cutter kind the sweep cannot profile, rather than at the first
  // move that happens to remove something -- the normaliser needs the profile too.
  sweepProfile(cutter);

  const slabDepth = opts?.slabDepthsByZ
    ?? slabDepthsByZ(moves, stockBounds.maxZ, measuredRoles);
  // WO-1252: replay from the material this path really starts on when the caller can
  // say what that is; an uncut box otherwise, exactly as before. Cloned either way --
  // the replay carves it.
  const replayCell = replayCellFor(cellSize, cutter);
  const field = opts?.startingStock !== undefined
    ? resampleOntoReplayGrid(
        cloneStartingStock(opts.startingStock, stockBounds, cellSize),
        stockBounds,
        replayCell,
      )
    : ZDexelField.fromBox(stockBounds, replayCell);

  let peakFraction = 0;
  let peakAt: { x: number; y: number; z: number } | null = null;
  let overCapLengthMm = 0;
  let longestOverCapRunMm = 0;
  let cuttingLengthMm = 0;

  // Current contiguous lateral-cut run. Per move: its lateral length, its SLOT-
  // EQUIVALENT length (fresh volume / the full-slot cross-section at that move's depth,
  // i.e. how far a true slot would have to travel to remove as much), and its midpoint.
  // Slot-equivalent length over travelled length is the engagement fraction, and it
  // stays correct when a single run straddles levels of different slab depth.
  let runLen: number[] = [];
  let runSlotEq: number[] = [];
  let runMid: { x: number; y: number; z: number }[] = [];
  let runRole: IrMoveRole[] = [];
  let runMoveIndex: number[] = [];
  const onOverCap = opts?.onOverCap;

  const flushRun = (): void => {
    // Sliding minimal window of >= windowMm; fraction = slot-equivalent length per mm
    // travelled. A tail window shorter than windowMm keeps the windowMm denominator, so
    // a short full-width punch still trips while a grazing spike cannot.
    let j = 0;
    let lenSum = 0;
    let slotEqSum = 0;
    // Consecutive over-cap moves inside THIS contiguous cutting run. It starts at zero
    // for every run, so a stretch can never bridge the retract between two of them.
    let streakMm = 0;
    for (let i = 0; i < runLen.length; i++) {
      while (j < runLen.length && lenSum < windowMm) {
        lenSum += runLen[j];
        slotEqSum += runSlotEq[j];
        j++;
      }
      const frac = slotEqSum / Math.max(lenSum, windowMm);
      if (frac > peakFraction) {
        peakFraction = frac;
        peakAt = runMid[i];
      }
      if (frac > capFraction) {
        overCapLengthMm += runLen[i];
        streakMm += runLen[i];
        if (streakMm > longestOverCapRunMm) longestOverCapRunMm = streakMm;
        onOverCap?.({
          ...runMid[i], role: runRole[i], lengthMm: runLen[i], fraction: frac,
          moveIndex: runMoveIndex[i],
        });
      } else {
        streakMm = 0;
      }
      cuttingLengthMm += runLen[i];
      lenSum -= runLen[i];
      slotEqSum -= runSlotEq[i];
    }
    runLen = [];
    runSlotEq = [];
    runMid = [];
    runRole = [];
    runMoveIndex = [];
  };

  let prev: { x: number; y: number; z: number } | null = null;
  const sagitta = replaySagittaFor(field);
  for (let mi = 0; mi < moves.length; mi++) {
    const m = moves[mi];
    if (prev !== null) {
      const role = m.role;
      const measured = role !== undefined && measuredRoles.has(role);
      if (!measured) flushRun(); // a retract / ramp / rapid ends the contiguous run
      // An ARC is walked along the arc (WO-402d): measured and replayed as one
      // chord, a 10 mm arc on an 8 mm radius sat 1.5 mm off the machine's path
      // and read as a 90-100% "burst" in fresh material the cutter never enters.
      forEachLinearSweep(prev, m, sagitta, (sweep) => {
        if (measured) {
          const depth = slabDepth.get(m.z) ?? 0;
          const len = Math.hypot(sweep.x1 - sweep.x0, sweep.y1 - sweep.y0);
          if (depth > 0 && len > 1e-9) {
            // engagementAt = removedVolume / moveLength (mm^2), over the move's FULL 3D
            // length, so multiply that length back to recover the fresh volume. Dividing
            // by the full-slot cross-section at this depth gives the slot-equivalent
            // length: for a flat cutter that denominator is diameter * depth, so this is
            // arithmetically the old plan-area-over-diameter figure; for a ball it follows
            // the sphere profile instead of pretending the wall is vertical.
            const len3 = Math.hypot(sweep.x1 - sweep.x0, sweep.y1 - sweep.y0, sweep.z1 - sweep.z0);
            const freshVolMm3 = engagementAt(field, sweep, cutter) * len3;
            runLen.push(len);
            runSlotEq.push(freshVolMm3 / slotCrossSectionMm2(cutter, depth));
            runMid.push({ x: (sweep.x0 + sweep.x1) / 2, y: (sweep.y0 + sweep.y1) / 2, z: m.z });
            runRole.push(role!);
            runMoveIndex.push(mi);
          }
        }
        removeSweep(field, sweep, cutter);
      });
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  flushRun();

  return { peakFraction, peakAt, overCapLengthMm, longestOverCapRunMm, cuttingLengthMm, capFraction };
}

/**
 * Axial slab depth engaged at each distinct lateral-cutting Z: the gap up to the next
 * cutting level above it, or to the stock top for the first level. Rest-between-levels
 * means everything above that gap has already been removed by an earlier level.
 */
function slabDepthsByZ(
  moves: readonly IrMove[],
  stockTopZ: number,
  measuredRoles: ReadonlySet<IrMoveRole>,
): Map<number, number> {
  const zs = new Set<number>();
  for (const m of moves) {
    if (m.role !== undefined && measuredRoles.has(m.role)) zs.add(m.z);
  }
  const sorted = [...zs].sort((a, b) => b - a); // deepest last
  const out = new Map<number, number>();
  let above = stockTopZ;
  for (const z of sorted) {
    out.set(z, Math.max(above - z, 0));
    above = z;
  }
  return out;
}
