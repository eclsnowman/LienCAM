// GATE: FreeCAD getEngagePoint edge roll-in ported into the 2D engine, driving the
// REAL cam3d strategy -> engine -> emit pipeline on hemisphereOnSlab (the roughGateA
// fixture). Supersedes the parked sideEntryStage2 design-blocker test: the outside-in
// side entry now enters from the open stock edge with the FIRST bite bounded BY
// CONSTRUCTION (getEngagePoint places the tool centre in air just past the edge, grazing
// in by a load-sized protrusion; the engine's bite-limiter carries it inward). Emit
// descends with the whole cutter clear, then feeds laterally to that grazing point.
//
// Measured honestly: the accumulator is seeded ONLY with physically-cleared area (the
// stock exterior air the side entry descends in was never solid), grown by every emitted
// move; windowed 2mm radial engagement, the SAME method as roughGateA Gate A.2. To tell a
// real outside-in regression from a fixture-intrinsic hot corner, the WHOLE-PATH peak is
// measured for BOTH modes (sideEntry ON and the inside-out helix default OFF).

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ZDexelField,
  removeSweep,
  engagementAt,
  remainingAbove,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock';
import { ensureGeom2dReady, area, type Ring } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import {
  intersection,
  netArea,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine';
import { pointInRing } from '../../cam3d/rough/cutRegion';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec } from '../../cam3d/kernel/types';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import {
  buildPartHeightField,
  frameOf,
  planLevels,
  cutRegionAt,
  decomposeToComponents,
} from '../../cam3d/rough';
import { featureFromComponent } from '../../cam3d/rough/feature';
import { buildSideEntrySeed } from '../../cam3d/rough/sideSeed';
import { processFeature, type AdaptivePass } from '../../cam3d/rough/engineEntry';
import { emitLevelPasses } from '../../cam3d/rough/emit';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { irFingerprint, type IrMove, type ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

// Shared fixture + params (the roughGateA / sideEntryStage2 hemisphere-on-slab).
// WO-408: R 20 -> 12 on a 50 x 50 slab (was 100 x 100), stepdown 12 -> 6 so the
// rough still has TWO levels (22 -> 10). The question is the outside-in entry at
// the open stock edge and the corner transient around the SAME sharp convex
// stock corners; the cell / cutter ratio is unchanged, only the footprint shrank
// (four full roughs of the 100 x 100 slab were ~190 s).
const R = 12;
const SLAB_T = 10;
const SLAB_XY = 50;
const CELL = 0.75;
const cutter: CutterSpec = { kind: 'flat', diameter: 3 };
const toolDia = cutter.diameter;
const MAX_STEPDOWN = 6;
const STEPOVER = 0.4;
const TOLERANCE = 0.1;
const HELIX_DIA = 3;

function makeMesh(): PartMesh {
  return hemisphereOnSlab(R, { x: SLAB_XY, y: SLAB_XY, t: SLAB_T });
}

function boxOf(mesh: PartMesh): Box3 {
  const { min, max } = mesh.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

function outerOf(rings: readonly Ring[]): Ring {
  let outer = rings[0];
  let best = -Infinity;
  for (const r of rings) {
    const a = area(r);
    if (a > best) {
      best = a;
      outer = r;
    }
  }
  return outer;
}

function cutterEdgeOverlap(ring: Ring, x: number, y: number, radius: number): number {
  let minDistance = Infinity;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i];
    const ay = ring[2 * i + 1];
    const bx = ring[2 * j];
    const by = ring[2 * j + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
      : 0;
    minDistance = Math.min(minDistance, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  const signedClearance = pointInRing(ring, x, y) ? -minDistance : minDistance;
  return radius - signedClearance;
}

function baseInput(mesh: PartMesh, sideEntry: boolean | undefined): AdaptiveRoughInput {
  return {
    mesh: undefined as never,
    cutter,
    stockBounds: boxOf(mesh),
    cellSize: CELL,
    maxStepdown: MAX_STEPDOWN,
    stepover: STEPOVER,
    tolerance: TOLERANCE,
    helixDiameter: HELIX_DIA,
    heights: { clearanceZ: boxOf(mesh).maxZ + 4, retractZ: boxOf(mesh).maxZ + 0.5, feedZ: boxOf(mesh).maxZ + 0.5 },
    materialTopZ: boxOf(mesh).maxZ,
    // WO-096: stockBounds here IS the block being carved -- this gate builds the
    // fixture itself, and there is no material outside boxOf(mesh) by
    // construction. Asserting that is a true statement about the fixture, and it
    // is what lets the traverse guard use the field to clear a low link at all;
    // without it every link below clearance is (correctly) treated as unprovable
    // and the side-entry lead-in would be walked down at feed rate.
    stockBoundsAreRealStock: true,
    // WO-1896: the material-left stream these engagement figures were measured on (the
    // default climb before climb was fixed to keep material on the cutter's right).
    millingDirection: 'conventional',
    ...(sideEntry !== undefined ? { sideEntry } : {}),
  };
}

async function run(mesh: PartMesh, sideEntry: boolean | undefined): Promise<ToolpathIR> {
  const handle = kernel.uploadMesh(mesh);
  try {
    const input = { ...baseInput(mesh, sideEntry), mesh: handle };
    return await adaptiveRough(kernel, input);
  } finally {
    kernel.releaseMesh(handle);
  }
}

// The pipelines are expensive; compute each ONCE and share it.
let onIrCache: Promise<ToolpathIR> | null = null;
function onIr(): Promise<ToolpathIR> {
  if (onIrCache === null) onIrCache = run(makeMesh(), true);
  return onIrCache;
}
let offIrCache: Promise<ToolpathIR> | null = null;
function offIr(): Promise<ToolpathIR> {
  if (offIrCache === null) offIrCache = run(makeMesh(), false);
  return offIrCache;
}

/** Directly exercise the engine on the FIRST level's first component (mirroring the
 *  strategy) so we can read entries[0].mode + the engage toolPos against the stock. */
async function firstLevelEngine(): Promise<{
  mode: string;
  startPoint: { x: number; y: number };
  coverage: number;
  toolPosInsideStock: boolean;
  aborted: string | undefined;
}> {
  const mesh = makeMesh();
  const bounds = boxOf(mesh);
  const handle = kernel.uploadMesh(mesh);
  try {
    const stock = ZDexelField.fromBox(bounds, CELL);
    const frame = frameOf(stock);
    const part = await buildPartHeightField(kernel, handle, frame, { zSeed: bounds.minZ - 1 });
    const levels = planLevels(bounds.maxZ, SLAB_T, MAX_STEPDOWN); // floorZ = slab top
    const z = levels[0];
    const region = await cutRegionAt(stock, part, z, { radialStockToLeave: 0, reachStockEdgeBy: 0 });
    const stockSec = remainingAbove(stock, z);
    const seed = buildSideEntrySeed(stockSec, cutter.diameter / 2);
    const comps = decomposeToComponents(region);
    const feat = featureFromComponent(comps[0]);
    const res = processFeature(feat, {
      toolRadius: cutter.diameter / 2,
      stepOver: STEPOVER,
      tolerance: TOLERANCE,
      helixDiameter: HELIX_DIA,
      stockToLeave: 0,
      arcTol: Math.max(TOLERANCE * 0.25, 0.01),
      clearedSeed: seed,
    });
    const covered = netArea(intersection(res.cleared, res.cutRegion));
    const total = Math.abs(netArea(res.cutRegion));
    const sp = res.startPoint ?? { x: NaN, y: NaN };
    const insideStock = pointInRing(outerOf(stockSec), sp.x, sp.y);
    return {
      mode: res.entries[0]?.mode ?? '(none)',
      startPoint: sp,
      coverage: covered / total,
      toolPosInsideStock: insideStock,
      aborted: res.stats.aborted,
    };
  } finally {
    kernel.releaseMesh(handle);
  }
}

/**
 * WO-3062: the straight sweeps the tool actually travels from `from` to the move `m`. A line
 * is its own chord; an arc (i/j = centre offset from its start, G2/G3) is tessellated at 1 deg
 * with z interpolated, so the replay follows the arc instead of cutting across it.
 */
function sweepsOf(from: { x: number; y: number; z: number }, m: IrMove): LinearMove[] {
  if (m.t !== 'arc' || m.i === undefined || m.j === undefined) {
    return [{ x0: from.x, y0: from.y, z0: from.z, x1: m.x, y1: m.y, z1: m.z }];
  }
  const cx = from.x + m.i;
  const cy = from.y + m.j;
  const r = Math.hypot(m.i, m.j);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let a1 = Math.atan2(m.y - cy, m.x - cx);
  if (m.cw) { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
  const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * 180) / Math.PI));
  const out: LinearMove[] = [];
  let x0 = from.x;
  let y0 = from.y;
  let z0 = from.z;
  for (let k = 1; k <= n; k++) {
    const t = a0 + ((a1 - a0) * k) / n;
    const x1 = k === n ? m.x : cx + r * Math.cos(t);
    const y1 = k === n ? m.y : cy + r * Math.sin(t);
    const z1 = from.z + ((m.z - from.z) * k) / n;
    out.push({ x0, y0, z0, x1, y1, z1 });
    x0 = x1;
    y0 = y1;
    z0 = z1;
  }
  return out;
}

/**
 * Peak windowed radial engagement (WINDOW = 2 mm) over the emitted IR, honest
 * accumulator: the field starts as full stock and every move's removeSweep carves it, so
 * each cut move's fresh removal is measured against what is physically already clear.
 * Mirrors roughGateA Gate A.2. Returns the peak over ALL engaged runs and the peak within
 * the FIRST run (the roll-in entry region for the ON pipeline).
 */
function measureEngagement(
  ir: ToolpathIR,
  bounds: Box3,
  engagedRoles: ReadonlyArray<string>,
): { peakFrac: number; peakAt: { x: number; y: number }; firstRunPeak: number; firstRunAt: { x: number; y: number } } {
  const WINDOW = 2.0;
  const stockTopZ = bounds.maxZ;
  const field = ZDexelField.fromBox(bounds, CELL);
  let prev: { x: number; y: number; z: number } | null = null;
  let peakFrac = 0;
  let peakAt = { x: 0, y: 0 };
  let firstRunPeak = -1;
  let firstRunAt = { x: 0, y: 0 };
  let seenFirstRun = false;
  let runLen: number[] = [];
  let runArea: number[] = [];
  let runMid: { x: number; y: number }[] = [];
  const flushRun = (): void => {
    if (runLen.length === 0) return;
    let localPeak = 0;
    let localAt = { x: 0, y: 0 };
    let j = 0;
    let lenSum = 0;
    let areaSum = 0;
    for (let i = 0; i < runLen.length; i++) {
      while (j < runLen.length && lenSum < WINDOW) {
        lenSum += runLen[j];
        areaSum += runArea[j];
        j++;
      }
      const width = areaSum / Math.max(lenSum, WINDOW);
      const frac = width / toolDia;
      if (frac > peakFrac) {
        peakFrac = frac;
        peakAt = runMid[i];
      }
      if (frac > localPeak) {
        localPeak = frac;
        localAt = runMid[i];
      }
      lenSum -= runLen[i];
      areaSum -= runArea[i];
    }
    if (!seenFirstRun) {
      seenFirstRun = true;
      firstRunPeak = localPeak;
      firstRunAt = localAt;
    }
    runLen = [];
    runArea = [];
    runMid = [];
  };
  for (const m of ir.moves) {
    if (prev !== null) {
      const engaged = m.role !== undefined && engagedRoles.includes(m.role);
      if (!engaged) flushRun();
      // WO-3062: an arc move is replayed as the arc the tool follows, not as its chord
      // (the chord of a big arc round the dome sweeps stock the tool never touches).
      for (const sweep of sweepsOf(prev, m)) {
        if (engaged) {
          const localDepth = stockTopZ - sweep.z1;
          const len = Math.hypot(sweep.x1 - sweep.x0, sweep.y1 - sweep.y0);
          if (localDepth > 0.5 && len > 1e-9) {
            const engMm2 = engagementAt(field, sweep, cutter);
            runLen.push(len);
            runArea.push((engMm2 * len) / localDepth);
            runMid.push({ x: (sweep.x0 + sweep.x1) / 2, y: (sweep.y0 + sweep.y1) / 2 });
          }
        }
        removeSweep(field, sweep, cutter);
      }
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  flushRun();
  return { peakFrac, peakAt, firstRunPeak, firstRunAt };
}

// ---------------------------------------------------------------------------
describe('getEngagePoint port: side entry fires + engage point is in air', () => {
  it('entries[0].mode === "side"; toolPos OUTSIDE stock; coverage: complete, or an honest wall-rim-overload refusal', { timeout: 180000 }, async () => {
    const r = await firstLevelEngine();
    // eslint-disable-next-line no-console
    console.log(
      `ENGAGE: mode=${r.mode}; startPoint (${r.startPoint.x.toFixed(2)}, ${r.startPoint.y.toFixed(2)}); ` +
        `toolPosInsideStock=${r.toolPosInsideStock} (want false); coverage ${(r.coverage * 100).toFixed(2)}%; aborted=${r.aborted}`,
    );
    expect(r.mode).toBe('side');
    expect(r.toolPosInsideStock).toBe(false); // engage centre is in air past the stock edge
    // WO-410 CONTOUR RIM (re-pinned 2026-08-21): this single processFeature call exercises
    // ONLY the first level's first component, none of adaptiveRough's multi-level/reseed
    // mop-up -- so a genuine wall-rim-overload refusal here (measured: 61.5mm of the ride
    // sustaining 100% of a slot near (13.45, 24.38) on this hemisphere-on-slab fixture) now
    // legitimately caps this single call's coverage well under the old 0.95, per the decided
    // contract: "a finishing contour that would sustain > 75% of a slot beyond the gate's 2mm
    // transient refuses the region loudly ... never a quiet slot" (processFeature.ts). This is
    // the honest-partial case the contract exists to surface, not a silent completion claim --
    // assert that explicitly instead of a coverage floor that assumed silent completion.
    if (r.aborted === 'wall-rim-overload') {
      expect(r.coverage).toBeGreaterThan(0.3);
    } else {
      expect(r.coverage).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('descends with the full cutter clear, then feeds laterally to the bounded engage point', { timeout: 180000 }, async () => {
    const ir = await onIr();
    const firstCut = ir.moves.findIndex((m) => m.role === 'cut');
    expect(firstCut).toBeGreaterThan(0);
    const entrySeq = ir.moves.slice(0, firstCut);
    const leadIndex = entrySeq.findIndex((m) => m.role === 'lead_in');
    const lead = leadIndex >= 0 ? entrySeq[leadIndex] : undefined;
    const touchdown = leadIndex > 0 ? entrySeq[leadIndex - 1] : entrySeq[entrySeq.length - 1];
    const bounds = boxOf(makeMesh());
    const sec = remainingAbove(ZDexelField.fromBox(bounds, CELL), touchdown.z);
    const outer = outerOf(sec);
    const toolRadius = cutter.diameter / 2;
    const touchdownOverlap = cutterEdgeOverlap(outer, touchdown.x, touchdown.y, toolRadius);
    const engageOverlap = lead
      ? cutterEdgeOverlap(outer, lead.x, lead.y, toolRadius)
      : touchdownOverlap;
    const unsafeDepthMoves = entrySeq.filter(
      (m) =>
        (m.role === 'rapid' || m.role === 'plunge') &&
        Math.abs(m.z - touchdown.z) <= 1e-9 &&
        cutterEdgeOverlap(outer, m.x, m.y, toolRadius) > 1e-6,
    );
    // eslint-disable-next-line no-console
    console.log(
      `SIDE-EMIT: touchdown (${touchdown.x.toFixed(4)}, ${touchdown.y.toFixed(4)}) z=${touchdown.z} ` +
        `role=${touchdown.role} cutter-edge overlap=${touchdownOverlap.toFixed(6)}mm; ` +
        `lead=${lead ? `${lead.t}/${lead.role} to (${lead.x.toFixed(4)}, ${lead.y.toFixed(4)})` : 'MISSING'} ` +
        `engage overlap=${engageOverlap.toFixed(6)}mm; unsafe depth moves=${unsafeDepthMoves.length}`,
    );
    expect(lead).toMatchObject({ t: 'feed', role: 'lead_in', z: touchdown.z });
    expect(touchdown.t).toBe('rapid');
    expect(touchdown.role).toBe('rapid');
    expect(touchdownOverlap).toBeLessThanOrEqual(1e-6);
    expect(engageOverlap).toBeGreaterThan(0);
    expect(unsafeDepthMoves).toEqual([]);
  });

  it('rejects a side descent whose centre is outside but cutter disk overlaps stock', () => {
    const stock = [Float64Array.from([0, 0, 10, 0, 10, 10, 0, 10])];
    const passes: AdaptivePass[] = [{
      type: 'entry',
      point: { x: -0.1, y: 5 },
      clearPoint: { x: -0.5, y: 5 },
      radius: 0,
      mode: 'side',
    }];
    expect(() => emitLevelPasses(
      passes,
      -1,
      { clearanceZ: 5, retractZ: 1, feedZ: 1 },
      { cursor: { x: Number.NaN, y: Number.NaN, z: 5 }, toolRadius: 1 },
      stock,
    )).toThrow(/cutter disk.*intersects the stock section/);
  });

  it('accepts a side reseed without a 2D section when live 3D stock proves it clear', () => {
    const stock = ZDexelField.fromBox({
      minX: 0, minY: 0, minZ: -2,
      maxX: 10, maxY: 10, maxZ: 0,
    }, 1);
    const passes: AdaptivePass[] = [{
      type: 'entry',
      point: { x: -0.5, y: 5 },
      clearPoint: { x: -2, y: 5 },
      radius: 0,
      mode: 'side',
    }];
    expect(() => emitLevelPasses(
      passes,
      1,
      { clearanceZ: 5, retractZ: 3, feedZ: 2 },
      {
        cursor: { x: Number.NaN, y: Number.NaN, z: 5 },
        toolRadius: 1,
        stock,
        cutter: { kind: 'flat', diameter: 2 },
        stockProven: true,
      },
    )).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('getEngagePoint port: MEASURED engagement', () => {
  it('entry roll-in hard-gated <= 0.75; whole path within the engine safety envelope (accepted corner transient)', { timeout: 300000 }, async () => {
    const bounds = boxOf(makeMesh());
    const on = measureEngagement(await onIr(), bounds, ['cut']);
    const off = measureEngagement(await offIr(), bounds, ['cut']);
    // eslint-disable-next-line no-console
    console.log(
      `ENGAGEMENT ON: entry roll-in peak ${(on.firstRunPeak * 100).toFixed(1)}% near ` +
        `(${on.firstRunAt.x.toFixed(1)}, ${on.firstRunAt.y.toFixed(1)}); whole-path peak ` +
        `${(on.peakFrac * 100).toFixed(1)}% near (${on.peakAt.x.toFixed(1)}, ${on.peakAt.y.toFixed(1)}). ` +
        `ENGAGEMENT OFF (inside-out baseline): whole-path peak ${(off.peakFrac * 100).toFixed(1)}% near ` +
        `(${off.peakAt.x.toFixed(1)}, ${off.peakAt.y.toFixed(1)}). cap 75%`,
    );
    expect(on.peakFrac).toBeGreaterThan(0); // engagement actually measured
    expect(on.firstRunPeak).toBeGreaterThanOrEqual(0); // entry region exercised
    // The port's GOAL, HARD-GATED: the ENTRY roll-in bite is bounded BY CONSTRUCTION.
    expect(on.firstRunPeak).toBeLessThanOrEqual(0.75);
    // Whole emitted IR (entry + all cuts). The whole-path peak is NOT the entry -- it is the
    // inherent radial-engagement transient where outside-in wraps the SHARP CONVEX stock
    // corners (measured 78.9% dia on the original 100 x 100 slab vs 65.9% for the inside-out
    // default at the same corners; 58.4% ON on the WO-408 50 x 50 slab, entry roll-in 49.7%;
    // the OFF whole-path figure this logs is NOT asserted and reads ~110% on both slabs -
    // a pre-existing observation, not part of this gate). Corners are the heaviest moment
    // of any adaptive clear; both modes stay within
    // the engine's own ~2x-optimal safety reject envelope (~0.80). Operator ACCEPTED this corner
    // transient on the visual verdict 2026-07-04 (_reviews/side-entry-corner-verdict-2026-07-04):
    // it is a deliberate tradeoff of the OPTIONAL, default-OFF side-entry mode, not a defect.
    // This bound guards against a REGRESSION past the safe envelope (e.g. a full-width slot),
    // NOT against the accepted corner transient; the bounded entry roll-in stays gated <= 0.75.
    expect(on.peakFrac).toBeLessThanOrEqual(0.82);
  });
});

// ---------------------------------------------------------------------------
describe('getEngagePoint port: OFF byte-identical + determinism', () => {
  it('sideEntry OFF == absent (interior-helix path untouched); no side entry', { timeout: 180000 }, async () => {
    const mesh = makeMesh();
    const off = await offIr();
    const absent = await run(mesh, undefined);
    expect(irFingerprint(off)).toBe(irFingerprint(absent));
    expect(off.moves.length).toBe(absent.moves.length);
    expect(off.moves.some((m) => m.role === 'ramp' || m.role === 'plunge')).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`OFF: ${off.moves.length} moves; fingerprint ${irFingerprint(off)} (== absent)`);
  });

  it('sideEntry ON is deterministic (two runs identical)', { timeout: 180000 }, async () => {
    const a = await onIr();
    const b = await run(makeMesh(), true);
    expect(irFingerprint(b)).toBe(irFingerprint(a));
    expect(b.moves.length).toBe(a.moves.length);
    // eslint-disable-next-line no-console
    console.log(`ON determinism: fingerprint ${irFingerprint(a)}; moves ${a.moves.length}`);
  });
});
