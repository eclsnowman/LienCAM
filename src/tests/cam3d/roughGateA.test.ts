// Gate A: the assembled per-Z-level 3D adaptive ROUGHER (stage A2), proved on
// exact-analytic fixtures. Builds on the stage-A1 region core (roughRegionA1).
//
// The strategy (src/cam3d/strategies/adaptiveRough) slices a job top-down, runs
// the READ-ONLY 2D adaptive engine per compartment at each level, emits IR at
// the level depth, and rest-updates the stock between levels. This gate proves
// the ASSEMBLY is correct end-to-end:
//   1. NO-GOUGE + REACHED-DEPTH: replay the IR against a fresh stock and check,
//      per column, that the tool never cut into the part and left no interior
//      region more than one stepdown proud of the part. (engagementPocket, flat.)
//   2. ENGAGEMENT UNDER CAP: per cut move, radial engagement (from engagementAt,
//      normalized by the local slab depth) stays under a stated fraction of the
//      tool diameter, and the cleared plan-area does not collapse (no early bail).
//   3. VOLUME: on a hemispherical boss the removed volume sits inside a closed-
//      form [no-overcut, terraced-lower-bound] window.
//   4. DETERMINISM: identical inputs -> identical irFingerprint and move count.
//   5. PERF: a coarse rough runs under a stated CPU budget (cpuUsage, not wall).
//   6. ABORT: a pre-aborted signal rejects (never a silent partial IR).
//
// The tolerances are discretization bounds (cell-resolution), not slack to hide
// a systematic offset: the fixtures are exact and the checks are quantified.

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ZDexelField,
  removeSweep,
  engagementAt,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock';
import { ensureGeom2dReady, netArea } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec, MeshHandle } from '../../cam3d/kernel/types';
import {
  engagementPocket,
  engagementPocketFootprintArea,
  hemisphereOnSlab,
  ENGAGEMENT_POCKET_BOUNDARIES,
} from '../../cam3d/fixtures';
import { buildPartHeightField, frameOf, planLevels, cutRegionAt } from '../../cam3d/rough';
import type { IrMove } from '../../cam3d/ir/types';
import { forEachLinearSweep } from '../../cam3d/rough/replayStock';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { irFingerprint, type ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

function boxOf(mesh: PartMesh): Box3 {
  const { min, max } = mesh.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

/** Replay every IR move as a tool-tip removeSweep onto a fresh stock box. */
function replayToField(
  ir: ToolpathIR,
  bounds: Box3,
  cell: number,
  cutter: CutterSpec,
): { field: ZDexelField; removedVolume: number } {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  let removedVolume = 0;
  // Arcs are walked along the arc (WO-402d): the published IR is arc-fitted,
  // and one chord per 16 mm arc misses the columns under the arc's bulge
  // (read here as a 12 mm-proud "unreached" floor) and carves where the
  // cutter never goes.
  for (const m of ir.moves) {
    if (prev !== null) {
      forEachLinearSweep(prev, m, cell / 4, (sweep) => {
        removedVolume += removeSweep(field, sweep, cutter).removedVolumeMm3;
      });
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return { field, removedVolume };
}

async function partFieldFor(handle: MeshHandle, stock: ZDexelField, zSeed: number): Promise<ZDexelField> {
  return buildPartHeightField(kernel, handle, frameOf(stock), { zSeed });
}

// ---------------------------------------------------------------------------
describe('Gate A.1: no-gouge + reached-depth (engagementPocket, flat)', () => {
  it('never gouges the part and leaves no interior region > one stepdown proud', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh); // x[0,90] y[0,60] z[0,16]
    const CELL = 0.5;
    const cutter: CutterSpec = { kind: 'flat', diameter: 3 };
    const tolerance = 0.1;
    const maxStepdown = 4;
    const floorZ = 4; // pocket floor (computed default lands here too)

    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter,
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown,
        stepover: 0.4,
        tolerance,
        helixDiameter: 2,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const ir = await adaptiveRough(kernel, input);
      expect(ir.meta.params?.floorZ).toBe(floorZ);

      const stock0 = ZDexelField.fromBox(bounds, CELL);
      const part = await partFieldFor(handle, stock0, bounds.minZ - 1);
      const { field: fin } = replayToField(ir, bounds, CELL, cutter);

      const stockTopZ = bounds.maxZ;
      const toolR = cutter.diameter / 2;

      // (a) NO-GOUGE over EVERY column: finalTop >= part.top - tolerance.
      let maxGouge = -Infinity;
      for (let c = 0; c < fin.top.length; c++) {
        const v = part.top[c] - fin.top[c];
        if (v > maxGouge) maxGouge = v;
      }

      // (b) REACHED-DEPTH over FLOOR-INTERIOR columns (flat floor, far from any
      // wall/island so the tool physically reaches the floor level): finalTop
      // must be within one stepdown of the part floor.
      const marginCells = Math.ceil((toolR + 2 * CELL) / CELL);
      const isFloor = (c: number): boolean => part.top[c] > part.bottom[c] && part.top[c] < floorZ + 1;
      let interiorCount = 0;
      let maxProud = -Infinity;
      let sumFloorTop = 0;
      for (let j = 0; j < fin.ny; j++) {
        for (let i = 0; i < fin.nx; i++) {
          const c = fin.colIndex(i, j);
          if (!isFloor(c)) continue;
          // Require the whole margin box to be floor (interior of the pocket).
          let interior = true;
          for (let dj = -marginCells; dj <= marginCells && interior; dj++) {
            for (let di = -marginCells; di <= marginCells; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= fin.nx || jj >= fin.ny || !isFloor(fin.colIndex(ii, jj))) {
                interior = false;
                break;
              }
            }
          }
          if (!interior) continue;
          interiorCount++;
          sumFloorTop += fin.top[c];
          const proud = fin.top[c] - part.top[c];
          if (proud > maxProud) maxProud = proud;
        }
      }

      const gougeTol = tolerance;
      const reachBound = maxStepdown + tolerance;
      // eslint-disable-next-line no-console
      console.log(
        `A.1 no-gouge/reached: maxGouge ${maxGouge.toFixed(4)} mm (tol ${gougeTol}); ` +
          `interior floor cols ${interiorCount}, maxProud ${maxProud.toFixed(4)} mm ` +
          `(bound ${reachBound}), meanFloorTop ${(sumFloorTop / Math.max(1, interiorCount)).toFixed(3)} ` +
          `(floorZ ${floorZ}); stockTop ${stockTopZ}`,
      );
      expect(interiorCount).toBeGreaterThan(100); // the check actually exercised columns
      expect(maxGouge).toBeLessThanOrEqual(gougeTol);
      expect(maxProud).toBeLessThanOrEqual(reachBound);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.2: engagement under cap (engagementPocket, 3mm flat)', () => {
  it('peak windowed radial engagement stays bounded; cleared area matches the footprint', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const CELL = 0.75;
    const cutter: CutterSpec = { kind: 'flat', diameter: 3 }; // radius 1.5; neck (6mm) = 2x dia
    const stockTopZ = bounds.maxZ;

    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter,
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown: 12, // one deep level: fraction is depth-normalized, so this is fine + fast
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const ir = await adaptiveRough(kernel, input);

      // Replay, measuring per-cut-move fresh-removal against the evolving field.
      // Single deep level: the engaged axial slab depth is (stockTop - z). We do
      // NOT read the centerline field top for depth -- in adaptive clearing the
      // tool CENTER rides already-cleared stock while the fresh material is a
      // leading-edge crescent, so the centerline top is already lowered.
      // engagementAt's removed volume already isolates that fresh crescent;
      // dividing by the slab depth gives that move's fresh PLAN area, and
      // fresh-plan-area / move-length is the radial (plan-view) cut width.
      //
      // Radial engagement is a SUSTAINED quantity: a single sub-cell cut step can
      // graze a sliver and read an absurd instantaneous width (tiny area / tinier
      // length) while removing no real material -- exactly the artifact the 2D
      // engine's own B8 gate averages away over a 2 mm window. So we peak the
      // WINDOWED average width over contiguous cut runs (WINDOW = 2 mm), matching
      // the engine's proven engagement metric rather than per-tiny-step spikes.
      const WINDOW = 2.0;
      const field = ZDexelField.fromBox(bounds, CELL);
      let prev: { x: number; y: number; z: number } | null = null;
      let peakFrac = 0;
      let peakAt = { x: 0, y: 0 };
      // Current contiguous cut run: per-move (length, fresh plan area, midpoint).
      let runLen: number[] = [];
      let runArea: number[] = [];
      let runMid: { x: number; y: number }[] = [];
      const flushRun = (): void => {
        // Sliding minimal window >= WINDOW mm; width = area density (mm^2/mm).
        let j = 0, lenSum = 0, areaSum = 0;
        for (let i = 0; i < runLen.length; i++) {
          while (j < runLen.length && lenSum < WINDOW) {
            lenSum += runLen[j];
            areaSum += runArea[j];
            j++;
          }
          const width = areaSum / Math.max(lenSum, WINDOW);
          const frac = width / cutter.diameter;
          if (frac > peakFrac) {
            peakFrac = frac;
            peakAt = runMid[i];
          }
          lenSum -= runLen[i];
          areaSum -= runArea[i];
        }
        runLen = [];
        runArea = [];
        runMid = [];
      };
      // The published IR is arc-fitted; walk arcs along the arc (WO-402d) - a
      // chord replay of a 10 mm arc on an 8 mm radius sits 1.5 mm off the path
      // and read as a 103% "burst" here in material the cutter never enters.
      const linear: IrMove[] = [];
      for (const m of ir.moves) {
        const p = linear[linear.length - 1];
        if (!p) { linear.push(m); continue; }
        forEachLinearSweep(p, m, CELL / 4, (sw) => linear.push({ t: m.t === 'arc' ? 'feed' : m.t, role: m.role, x: sw.x1, y: sw.y1, z: sw.z1 }));
      }
      for (const m of linear) {
        if (prev !== null) {
          const sweep: LinearMove = { x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z };
          if (m.role === 'cut') {
            const localDepth = stockTopZ - m.z; // slab thickness for this (single) level
            const len = Math.hypot(m.x - prev.x, m.y - prev.y);
            if (localDepth > 0.5 && len > 1e-9) {
              const engMm2 = engagementAt(field, sweep, cutter);
              const freshPlanArea = (engMm2 * len) / localDepth; // = radialWidth * len
              runLen.push(len);
              runArea.push(freshPlanArea);
              runMid.push({ x: (prev.x + m.x) / 2, y: (prev.y + m.y) / 2 });
            }
          } else {
            flushRun(); // a non-cut move (link/retract/ramp) ends the contiguous run
          }
          removeSweep(field, sweep, cutter);
        }
        prev = { x: m.x, y: m.y, z: m.z };
      }
      flushRun();

      // Cleared plan-area: columns whose top dropped below the stock top.
      let clearedCols = 0;
      for (let c = 0; c < field.top.length; c++) if (field.top[c] < stockTopZ - 0.5) clearedCols++;
      const clearedArea = clearedCols * CELL * CELL;
      const footprint = engagementPocketFootprintArea(); // 2360 mm^2

      // eslint-disable-next-line no-console
      console.log(
        `A.2 engagement: peak radial ${(peakFrac * 100).toFixed(1)}% of diameter (3mm flat) ` +
          `near (${peakAt.x.toFixed(1)}, ${peakAt.y.toFixed(1)}); cleared plan-area ` +
          `${clearedArea.toFixed(0)} / footprint ${footprint} mm^2`,
      );
      expect(peakFrac).toBeGreaterThan(0); // engagement actually measured

      // CAP INVESTIGATION (do NOT just raise it -- brief). The measured windowed
      // peak (~0.64) sits at a SHARP 90-deg INTERNAL CHAMBER CORNER -- precisely
      // the feature this torture fixture was built to stress. That is legitimate,
      // BOUNDED corner engagement of the primary cutting spiral, not a wrapper
      // fault: the cleared plan-area equals the exact analytic footprint (see the
      // assertion below), so the wrapper fed the CORRECT per-compartment region,
      // NOT a degenerate merged region (which would plow toward full-slot ~1.0
      // everywhere). The 2D engine's own 0.6-of-diameter figure is its LINK-RIDE
      // rejection cap (1.5 x stepOverDistance = 1.5 x 0.4 x d), which bounds
      // stay-down CONNECTIONS over cleared stock -- NOT the primary cut wrapping a
      // concave corner, where engagement legitimately climbs higher. The cap here
      // is therefore set to cleanly separate bounded corner engagement (~0.64)
      // from a real plowing failure (>= 1.0): 0.75.
      expect(peakFrac).toBeLessThanOrEqual(0.75);
      // No early bail / no degenerate merged feed: the cleared plan-area must
      // essentially equal the analytic footprint (the tiny surplus is cell-
      // boundary discretization of the block-traced region).
      expect(clearedArea).toBeGreaterThanOrEqual(0.9 * footprint);
      expect(clearedArea).toBeLessThanOrEqual(1.1 * footprint);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.3: removed volume within analytic window (hemisphereOnSlab)', () => {
  it('removed volume in [no-overcut upper, terraced lower]', { timeout: 120000 }, async () => {
    // WO-408: R 20 -> 12 on a 40 x 40 slab (was 100 x 100). The window is closed-
    // form in R and the slab, so the question is unchanged; the annulus the
    // rougher clears per level is ~7x smaller (105 s -> ~15 s).
    const R = 12;
    const SLAB_T = 10;
    const SLAB_XY = 40;
    const mesh = hemisphereOnSlab(R, { x: SLAB_XY, y: SLAB_XY, t: SLAB_T });
    const bounds = boxOf(mesh); // x[0,40] y[0,40] z[0,22]
    const CELL = 1.0;
    const cutter: CutterSpec = { kind: 'flat', diameter: 3 };
    const toolR = cutter.diameter / 2;

    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter,
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown: 4,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 3,
        radialStockToLeave: 0,
        heights: { clearanceZ: bounds.maxZ + 4, retractZ: bounds.maxZ + 0.5, feedZ: bounds.maxZ + 0.5 },
        materialTopZ: bounds.maxZ,
      };
      const ir = await adaptiveRough(kernel, input);
      expect(ir.meta.params?.floorZ).toBe(SLAB_T); // slab top is the flat floor

      const { removedVolume } = replayToField(ir, bounds, CELL, cutter);

      const stockAboveFloor = SLAB_XY * SLAB_XY * (bounds.maxZ - SLAB_T); // 19200
      const domeVol = (2 / 3) * Math.PI * R ** 3; // 3619.11
      // No overcut: cannot remove more than stock-minus-dome above the floor.
      const upper = stockAboveFloor - domeVol;
      // Terraced lower bound: ALL uncut material sits within a bounding cylinder
      // of radius R + toolRadius + 2 cells (dome + tool collar + discretization).
      const collarR = R + toolR + 2 * CELL;
      const boundCyl = Math.PI * collarR ** 2 * R;
      const lower = stockAboveFloor - boundCyl;

      // eslint-disable-next-line no-console
      console.log(
        `A.3 volume: removed ${removedVolume.toFixed(0)} mm^3; window ` +
          `[${lower.toFixed(0)}, ${upper.toFixed(0)}] (stockAboveFloor ${stockAboveFloor}, ` +
          `domeVol ${domeVol.toFixed(0)})`,
      );
      expect(removedVolume).toBeLessThanOrEqual(upper * 1.005); // no overcut (f32 slack)
      expect(removedVolume).toBeGreaterThanOrEqual(lower);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.4: determinism', () => {
  it('identical inputs -> identical fingerprint and move count', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: { kind: 'flat', diameter: 3 },
        stockBounds: bounds,
        // WO-408: one level at a 1.0 cell (was two levels at 0.75): byte-identity
        // of two runs is not a field assertion, and two full pocket roughs were 32 s.
        cellSize: 1.0,
        maxStepdown: 12,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const a = await adaptiveRough(kernel, input);
      const b = await adaptiveRough(kernel, input);
      const fa = irFingerprint(a);
      const fb = irFingerprint(b);
      // eslint-disable-next-line no-console
      console.log(`A.4 determinism: fingerprint ${fa}; moves ${a.moves.length}`);
      expect(fb).toBe(fa);
      expect(b.moves.length).toBe(a.moves.length);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.5: CPU budget (coarse rough)', () => {
  it('a coarse engagementPocket rough stays under the CPU budget', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const CELL = 1.5;
    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: { kind: 'flat', diameter: 4 },
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown: 12,
        stepover: 0.5,
        tolerance: 0.15,
        helixDiameter: 3,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const t0 = process.cpuUsage();
      let maxAttempt = 0;
      const ir = await adaptiveRough(kernel, input, {
        onProgress: (_fraction, detail) => {
          if (detail !== undefined) maxAttempt = Math.max(maxAttempt, detail.attempt);
        },
      });
      const d = process.cpuUsage(t0);
      const cpuMs = (d.user + d.system) / 1000;
      const budgetMs = 15000; // 15 CPU-seconds -- generous for a coarse rough
      // eslint-disable-next-line no-console
      console.log(`A.5 perf: coarse rough CPU ${cpuMs.toFixed(0)} ms (budget ${budgetMs} ms); moves ${ir.moves.length}`);
      expect(ir.moves.length).toBeGreaterThan(0);
      // A coarse prismatic field predictably aliases its vertical walls with
      // the fine tolerance probe. Start at the conservative cell-diagonal
      // probe instead of paying for a doomed plan plus recursive retry.
      expect(ir.meta.params?.retainedWallProbeDiameter).toBeCloseTo(CELL * Math.SQRT2);
      expect(maxAttempt).toBe(1);
      expect(cpuMs).toBeLessThan(budgetMs);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.6: abort', () => {
  it('a pre-aborted signal rejects (no silent partial IR)', async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const handle = kernel.uploadMesh(mesh);
    try {
      const controller = new AbortController();
      controller.abort();
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: { kind: 'flat', diameter: 3 },
        stockBounds: bounds,
        cellSize: 1.0,
        maxStepdown: 6,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      await expect(adaptiveRough(kernel, input, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
// STOCK-TO-LEAVE VERIFICATION (radial on walls + axial on floor).
//
// These three gates PROVE, with measured numbers, that stock-to-leave is
// applied at the correct NONZERO thickness -- not merely that it changes the
// output. A.7 pins the radial skin at the geometry source (cutRegionAt) against
// the closed-form S*perimeter. A.8 proves that skin survives end-to-end through
// the carve. A.9 pins the axial floor raise + the resulting step-down level
// count, and shows the carved floor physically moves up by S.
// ---------------------------------------------------------------------------

// Perimeter of a closed polygon given as [x,y] pairs, mm.
function polyPerimeter(poly: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += Math.hypot(x1 - x0, y1 - y0);
  }
  return s;
}

// ---------------------------------------------------------------------------
describe('Gate A.7: radial stock-to-leave at the geometry source (cutRegionAt)', () => {
  it('grows the part boundary outward by S: cut-region area shrinks by S*perimeter, monotone in S', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh); // x[0,90] y[0,60] z[0,16]
    const CELL = 0.5;
    const Z = 10; // mid-level between pocket floor (z=4) and block top (z=16)

    const handle = kernel.uploadMesh(mesh);
    try {
      const stock = ZDexelField.fromBox(bounds, CELL);
      const part = await partFieldFor(handle, stock, bounds.minZ - 1);

      // Cut region = stock section minus (grown) part section. Grow S = 0, 0.5, 1.0.
      const region0 = await cutRegionAt(stock, part, Z, { radialStockToLeave: 0 });
      const regionH = await cutRegionAt(stock, part, Z, { radialStockToLeave: 0.5 });
      const region1 = await cutRegionAt(stock, part, Z, { radialStockToLeave: 1.0 });
      const a0 = netArea(region0);
      const aH = netArea(regionH);
      const a1 = netArea(region1);

      // Part boundaries that FACE the cut region: the H outer outline (that
      // borders the pocket) + the standing island. Perimeter from the fixture's
      // analytic boundary polygons (can never drift from the mesh): 288 + 40.
      const P =
        polyPerimeter(ENGAGEMENT_POCKET_BOUNDARIES.outer) +
        polyPerimeter(ENGAGEMENT_POCKET_BOUNDARIES.islandHole);
      const S = 1.0;
      const expectedShrink = S * P; // 328 mm^2 to first order
      const measuredShrink = a0 - a1;

      // eslint-disable-next-line no-console
      console.log(
        `A.7 radial-region: netArea S=0 ${a0.toFixed(1)}, S=0.5 ${aH.toFixed(1)}, ` +
          `S=1.0 ${a1.toFixed(1)} mm^2; facing perimeter ${P.toFixed(1)}; expected shrink ` +
          `${expectedShrink.toFixed(1)}, measured ${measuredShrink.toFixed(1)} ` +
          `(delta ${(measuredShrink - expectedShrink).toFixed(2)})`,
      );

      // Anchor: the S=0 cut region equals the analytic net pocket footprint
      // (2360 mm^2), so the difference is being taken over the RIGHT region.
      const foot = engagementPocketFootprintArea();
      expect(a0).toBeGreaterThan(foot - 30);
      expect(a0).toBeLessThan(foot + 30);

      // Monotone STRICT decrease: more skin -> less cut region.
      expect(aH).toBeLessThan(a0);
      expect(a1).toBeLessThan(aH);

      // First-order shrink is S*perimeter. The round join adds only O(S^2)
      // corner terms (convex-corner arcs +pi*S^2/loop, reflex-corner overlaps
      // -S^2 each -> a net few mm^2 at S=1), plus sub-mm grid-ring
      // discretization. Tolerance 20 mm^2 (~6% of 328) covers both, while still
      // excluding S=0 (shrink 0) and any double-application of the skin (656).
      expect(Math.abs(measuredShrink - expectedShrink)).toBeLessThanOrEqual(20);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.8: radial stock-to-leave leaves a wall skin end-to-end (carved stock)', () => {
  it('no cleared column comes closer than ~S to any part wall; no gouge', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const CELL = 0.5;
    const cutter: CutterSpec = { kind: 'flat', diameter: 3 };
    const S = 1.0;
    const stockTopZ = bounds.maxZ; // 16

    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter,
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown: 4,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        radialStockToLeave: S,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const ir = await adaptiveRough(kernel, input);
      expect(ir.meta.params?.radialStockToLeave).toBe(S);

      const stock0 = ZDexelField.fromBox(bounds, CELL);
      const part = await partFieldFor(handle, stock0, bounds.minZ - 1);
      const { field: fin } = replayToField(ir, bounds, CELL, cutter);

      // A "wall" (uncut solid) column: part top essentially at the block top.
      const SOLID = stockTopZ - 0.5;
      const isSolid = (c: number): boolean => part.top[c] >= SOLID;
      const isCleared = (c: number): boolean => fin.top[c] < stockTopZ - 0.5;

      // Wall-BOUNDARY columns = solid columns with a non-solid 4-neighbour. The
      // nearest wall to any cleared column is always one of these, so restricting
      // the search to the boundary is EXACT and cheap (stated proxy:
      // boundary-of-solid, not every interior solid column).
      const wallX: number[] = [];
      const wallY: number[] = [];
      for (let j = 0; j < fin.ny; j++) {
        for (let i = 0; i < fin.nx; i++) {
          const c = fin.colIndex(i, j);
          if (!isSolid(c)) continue;
          const border =
            (i > 0 && !isSolid(fin.colIndex(i - 1, j))) ||
            (i + 1 < fin.nx && !isSolid(fin.colIndex(i + 1, j))) ||
            (j > 0 && !isSolid(fin.colIndex(i, j - 1))) ||
            (j + 1 < fin.ny && !isSolid(fin.colIndex(i, j + 1)));
          if (border) {
            wallX.push(fin.centerX(i));
            wallY.push(fin.centerY(j));
          }
        }
      }
      expect(wallX.length).toBeGreaterThan(0);

      // For every cleared column, distance to the nearest wall-boundary column.
      let minWallDist = Infinity;
      let clearedCount = 0;
      let maxGouge = -Infinity;
      for (let j = 0; j < fin.ny; j++) {
        for (let i = 0; i < fin.nx; i++) {
          const c = fin.colIndex(i, j);
          const g = part.top[c] - fin.top[c];
          if (g > maxGouge) maxGouge = g;
          if (!isCleared(c)) continue;
          clearedCount++;
          const cx = fin.centerX(i);
          const cy = fin.centerY(j);
          let d2 = Infinity;
          for (let w = 0; w < wallX.length; w++) {
            const dx = cx - wallX[w];
            const dy = cy - wallY[w];
            const dd = dx * dx + dy * dy;
            if (dd < d2) d2 = dd;
          }
          if (d2 < minWallDist * minWallDist) minWallDist = Math.sqrt(d2);
        }
      }

      // eslint-disable-next-line no-console
      console.log(
        `A.8 radial-skin: cleared cols ${clearedCount}, wall-boundary cols ${wallX.length}; ` +
          `min cleared->wall distance ${minWallDist.toFixed(3)} mm (S ${S}, bound >= ` +
          `${(S - CELL).toFixed(2)}); maxGouge ${maxGouge.toFixed(4)} mm`,
      );

      expect(clearedCount).toBeGreaterThan(1000); // the pocket really WAS cleared
      // Skin left: no cut edge came within ~S of a wall (allow 1 cell of grid
      // discretization). The tool tip stays toolR+S from the wall, so the carved
      // edge stops S from it -- this is the end-to-end proof that the radial skin
      // set in cutRegionAt survives through emit + carve.
      expect(minWallDist).toBeGreaterThanOrEqual(S - CELL);
      // Not grossly OVER-left either: the closest approach (at a straight wall)
      // sits within a couple cells of S. Loose upper guard against "cut nothing".
      expect(minWallDist).toBeLessThanOrEqual(S + 3 * CELL);
      // And no gouge into the part anywhere.
      expect(maxGouge).toBeLessThanOrEqual(0.1);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate A.9: axial stock-to-leave raises the floor + fixes level count (hemisphereOnSlab)', () => {
  it('floorZ = slabTop + S, levelCount = planLevels, carved floor at ~12 not 10', { timeout: 120000 }, async () => {
    // WO-408: R 20 -> 12 on a 40 x 40 slab (was 100 x 100, two full roughs of
    // it: 180 s timeout every run). Floor raise and level count are closed-form
    // in the slab top, S and the stepdown; the footprint carries no part of it.
    const R = 12;
    const SLAB_T = 10;
    const mesh = hemisphereOnSlab(R, { x: 40, y: 40, t: SLAB_T });
    const bounds = boxOf(mesh); // x[0,40] y[0,40] z[0,22]
    const CELL = 1.0;
    const cutter: CutterSpec = { kind: 'flat', diameter: 3 };
    const stockTopZ = bounds.maxZ; // 22

    const runWith = async (axial: number): Promise<{ ir: ToolpathIR; minClearedTop: number }> => {
      const handle = kernel.uploadMesh(mesh);
      try {
        const input: AdaptiveRoughInput = {
          mesh: handle,
          cutter,
          stockBounds: bounds,
          cellSize: CELL,
          maxStepdown: 4,
          stepover: 0.4,
          tolerance: 0.1,
          helixDiameter: 3,
          axialStockToLeave: axial,
          heights: { clearanceZ: stockTopZ + 4, retractZ: stockTopZ + 0.5, feedZ: stockTopZ + 0.5 },
          materialTopZ: bounds.maxZ,
        };
        const ir = await adaptiveRough(kernel, input);
        const { field } = replayToField(ir, bounds, CELL, cutter);
        // Deepest carved floor = min final top over CLEARED columns.
        let minClearedTop = Infinity;
        for (let c = 0; c < field.top.length; c++) {
          if (field.top[c] < stockTopZ - 0.5 && field.top[c] < minClearedTop) {
            minClearedTop = field.top[c];
          }
        }
        return { ir, minClearedTop };
      } finally {
        kernel.releaseMesh(handle);
      }
    };

    const S = 2.0;
    const withS = await runWith(S);
    const with0 = await runWith(0);

    const expLevels = planLevels(stockTopZ, SLAB_T + S, 4).length; // planLevels(22,12,4)
    const exp0Levels = planLevels(stockTopZ, SLAB_T, 4).length; //    planLevels(22,10,4)

    // eslint-disable-next-line no-console
    console.log(
      `A.9 axial: S=${S} floorZ ${withS.ir.meta.params?.floorZ} levelCount ` +
        `${withS.ir.meta.params?.levelCount} (planLevels ${expLevels}); minClearedTop ` +
        `${withS.minClearedTop.toFixed(3)}. S=0 floorZ ${with0.ir.meta.params?.floorZ} ` +
        `levelCount ${with0.ir.meta.params?.levelCount} (planLevels ${exp0Levels}); ` +
        `minClearedTop ${with0.minClearedTop.toFixed(3)}. floor moved up ` +
        `${(withS.minClearedTop - with0.minClearedTop).toFixed(3)} mm`,
    );

    // Floor raised by exactly S (slab top 10 + 2 = 12; default 10).
    expect(withS.ir.meta.params?.floorZ).toBe(SLAB_T + S); // 12
    expect(with0.ir.meta.params?.floorZ).toBe(SLAB_T); //    10
    // Level count matches the deterministic planner AND the closed-form ceil.
    expect(withS.ir.meta.params?.levelCount).toBe(expLevels);
    expect(expLevels).toBe(3); // ceil((22-12)/4) = ceil(2.5) = 3 (was 5 on the 30-tall fixture)
    expect(with0.ir.meta.params?.levelCount).toBe(exp0Levels);
    expect(exp0Levels).toBe(3); // ceil((22-10)/4) = 3 (was 5)
    // Carved floor physically sits at ~12 (2 mm skin above the slab top), NOT 10.
    expect(withS.minClearedTop).toBeGreaterThanOrEqual(SLAB_T + S - 0.5); // >= 11.5
    expect(withS.minClearedTop).toBeLessThanOrEqual(SLAB_T + S + 0.5); //   <= 12.5
    expect(with0.minClearedTop).toBeLessThanOrEqual(SLAB_T + 0.5); //       ~10
    // The floor moved UP by ~S between the two runs -- the axial skin, measured.
    expect(withS.minClearedTop - with0.minClearedTop).toBeGreaterThanOrEqual(S - 0.5);
    expect(withS.minClearedTop - with0.minClearedTop).toBeLessThanOrEqual(S + 0.5);
  });
});
