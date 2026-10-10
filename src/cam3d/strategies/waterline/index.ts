// cam3d L4: WaterlineFinishStrategy -- constant-Z (waterline / contour)
// finishing (WO-1176).
//
// A pure L2/L3 recipe (MISSION layering rule): it consumes the GeometryKernel
// surface (dropPoints probes), the injected WaterlineSlicer (kernel/
// oclWaterline.ts in production, a fake in tests), geom2d rings and its own
// linker. No library import, ever.
//
// Shape of the computation:
// 1. Plan the Z ladder (levels.ts): top - stepdown ... bottom, plus the
//    heights of horizontal faces when flat-area detection is on.
// 2. Per level, top down: slice with a cutter enlarged by the stock to leave
//    (a ball's loops then sit exactly `stock` off the surface; a flat or bull
//    cutter's loops sit `stock` off the walls), classify the material side,
//    orient for climb/conventional, split for steep-only, clip to the
//    boundary (loops.ts). Cancellation is honoured between levels.
// 3. Order the passes: level-first (every loop at a level, then the next
//    level) or region-first (one boss or pocket to
//    its bottom before the next -- "Order by islands"), nearest-first within.
// 4. Link (link.ts) and wrap in the one ToolpathIR (D-012: dense polylines).

import type { CutterSpec, GeometryKernel, MeshHandle, PartMesh } from '../../kernel/types';
import type { Ring } from '../../geom2d';
import { validateRings } from '../../geom2d/rings';
import type { ToolpathIR } from '../../ir/types';
import type { PathBuildHeights } from '../../pathbuild';
import type { WaterlineSampling, WaterlineSlicer } from '../../kernel/oclWaterline';
import { flatFaceHeights, planWaterlineLevels } from './levels';
import {
  classifyLevel, clipPassOutsideRegion, clipPassToRegion, regionise,
  type MillingDirection, type SpindleRotation, type WaterlinePass,
} from './loops';
import { linkWaterlinePasses } from './link';

export type WaterlineOrder = 'level' | 'region';

export type WaterlineFinishInput = {
  /** Mesh handle previously uploaded to the SAME kernel (probes). */
  mesh: MeshHandle;
  /** The same mesh as data, for the slicer and flat-face detection. */
  partMesh: PartMesh;
  cutter: CutterSpec;
  /** Level spacing, mm (> 0). */
  stepdown: number;
  /** Library sampling derived from the operation tolerance. */
  sampling: WaterlineSampling;
  /** Radial allowance, mm (>= 0): loops are computed for a cutter this much larger. */
  stockToLeave: number;
  /** 0 = whole part; else drop loop runs shallower than this angle from horizontal. */
  minSlopeDeg: number;
  /** Add a level at every horizontal face. */
  flatAreaDetection: boolean;
  order: WaterlineOrder;
  direction: MillingDirection;
  spindle: SpindleRotation;
  /** Top of the band (Material Start), mm. Not itself a level. */
  topZ: number;
  /** Bottom of the band (Cutter End), mm. Always the last level. */
  bottomZ: number;
  heights: PathBuildHeights;
  /** Drop floor for kernel probes, mm (below the part). */
  zSeed: number;
  /** Optional containment (geom2d convention: outers CCW, holes CW). */
  boundary?: readonly Ring[];
  /** WO-1340: outward stock-edge band; boundary remains the byte-stable interior. */
  overrunBoundary?: readonly Ring[];
  /** Profile-ramp angle, degrees; default 10. */
  rampAngleDeg?: number;
};

function fail(msg: string): never {
  const error = new Error(`waterlineFinish: ${msg}`);
  error.name = 'WaterlineFinishError';
  throw error;
}

/** The cutter the loops are computed for: the tool grown by the allowance. */
export function enlargedCutter(cutter: CutterSpec, stockToLeave: number): CutterSpec {
  if (stockToLeave === 0) return cutter;
  const diameter = cutter.diameter + 2 * stockToLeave;
  switch (cutter.kind) {
    case 'flat':
    case 'ball':
      return { kind: cutter.kind, diameter };
    case 'bull':
      // Growing the corner radius with the allowance keeps the profile a true
      // offset of the original bull (radius + s, corner + s), capped at a ball.
      return { kind: 'bull', diameter, cornerRadius: Math.min(cutter.cornerRadius + stockToLeave, diameter / 2) };
    case 'vbit':
      return { ...cutter, diameter };
  }
}

function cutterIdOf(spec: CutterSpec): string {
  switch (spec.kind) {
    case 'flat':
    case 'ball':
      return `${spec.kind}-d${spec.diameter}`;
    case 'bull':
      return `bull-d${spec.diameter}-cr${spec.cornerRadius}`;
    case 'vbit':
      return `vbit-d${spec.diameter}-a${spec.angleFromAxisDeg}`;
  }
}

/** Nearest-first ordering of a group of passes from a starting point; ties by index. */
function nearestFirst(group: WaterlinePass[], fromX: number, fromY: number): WaterlinePass[] {
  const remaining = group.slice();
  const out: WaterlinePass[] = [];
  let x = fromX;
  let y = fromY;
  while (remaining.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i];
      // Distance to the nearest vertex of a closed pass, to its start for an open one.
      let d = Infinity;
      if (p.closed) {
        for (let k = 0; k < p.xy.length; k += 2) {
          const dk = Math.hypot(p.xy[k] - x, p.xy[k + 1] - y);
          if (dk < d) d = dk;
        }
      } else {
        d = Math.hypot(p.xy[0] - x, p.xy[1] - y);
      }
      if (d < bestD - 1e-9) {
        bestD = d;
        best = i;
      }
    }
    const chosen = remaining.splice(best, 1)[0];
    out.push(chosen);
    const n = chosen.xy.length / 2;
    x = chosen.closed ? chosen.xy[0] : chosen.xy[2 * n - 2];
    y = chosen.closed ? chosen.xy[1] : chosen.xy[2 * n - 1];
  }
  return out;
}

/**
 * Order passes for cutting. Level-first walks the ladder top down and
 * nearest-first within a level. Region-first orders regions by their highest
 * pass nearest-first, then each region top down, nearest-first within a
 * level. Deterministic: ties fall back to index order.
 */
export function orderPasses(passes: WaterlinePass[], order: WaterlineOrder): WaterlinePass[] {
  if (passes.length === 0) return [];
  const byLevel = (group: WaterlinePass[], fromX: number, fromY: number): WaterlinePass[] => {
    const levels = [...new Set(group.map((p) => p.level))].sort((a, b) => a - b);
    const out: WaterlinePass[] = [];
    let x = fromX;
    let y = fromY;
    for (const level of levels) {
      const ordered = nearestFirst(group.filter((p) => p.level === level), x, y);
      out.push(...ordered);
      const last = ordered[ordered.length - 1];
      const n = last.xy.length / 2;
      x = last.closed ? last.xy[0] : last.xy[2 * n - 2];
      y = last.closed ? last.xy[1] : last.xy[2 * n - 1];
    }
    return out;
  };
  const originX = passes[0].xy[0];
  const originY = passes[0].xy[1];
  if (order === 'level') return byLevel(passes, originX, originY);
  const regions = [...new Set(passes.map((p) => p.region))].sort((a, b) => a - b);
  // Order regions by their topmost pass, nearest-first from the origin.
  const heads = regions.map((r) => {
    const members = passes.filter((p) => p.region === r);
    const top = Math.min(...members.map((p) => p.level));
    return members.find((p) => p.level === top)!;
  });
  const headOrder = nearestFirst(heads, originX, originY);
  const out: WaterlinePass[] = [];
  let x = originX;
  let y = originY;
  for (const head of headOrder) {
    const ordered = byLevel(passes.filter((p) => p.region === head.region), x, y);
    out.push(...ordered);
    const last = ordered[ordered.length - 1];
    const n = last.xy.length / 2;
    x = last.closed ? last.xy[0] : last.xy[2 * n - 2];
    y = last.closed ? last.xy[1] : last.xy[2 * n - 1];
  }
  return out;
}

/**
 * Waterline finishing. Returns the IR program; deterministic for identical
 * inputs (D-006). Progress is per level; a cancel is honoured between levels.
 */
export async function waterlineFinish(
  kernel: GeometryKernel,
  slicer: WaterlineSlicer,
  input: WaterlineFinishInput,
  opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<ToolpathIR> {
  const { stepdown, stockToLeave, heights } = input;
  if (!(stepdown > 0) || !Number.isFinite(stepdown)) fail(`invalid stepdown ${stepdown}`);
  if (!(stockToLeave >= 0) || !Number.isFinite(stockToLeave)) fail(`stockToLeave must be finite and >= 0, got ${stockToLeave}`);
  if (!(input.minSlopeDeg >= 0) || !(input.minSlopeDeg < 90)) fail(`minSlopeDeg ${input.minSlopeDeg} outside [0, 90)`);
  if (!Number.isFinite(input.zSeed)) fail(`non-finite zSeed ${input.zSeed}`);
  if (!(input.cutter.diameter > 0) || !Number.isFinite(input.cutter.diameter)) fail(`invalid cutter diameter ${input.cutter.diameter}`);
  if (input.boundary !== undefined) validateRings(input.boundary, 'waterlineFinish boundary');
  if (input.overrunBoundary !== undefined) {
    if (input.boundary === undefined) fail('overrunBoundary requires boundary');
    validateRings(input.overrunBoundary, 'waterlineFinish overrunBoundary');
  }

  // Flat faces are found regardless of the detection switch: with it on they
  // become levels, and either way a level that lands ON a flat face is lifted
  // off it by the slicer's finest sampling (levels.ts explains the spokes).
  const flats = flatFaceHeights(input.partMesh);
  const levels = planWaterlineLevels({
    topZ: input.topZ,
    bottomZ: input.bottomZ,
    stepdown,
    ...(input.flatAreaDetection ? { flatHeights: flats } : {}),
    liftOffFlats: flats,
    flatLiftMm: input.sampling.minSampling,
  });
  const cutter = enlargedCutter(input.cutter, stockToLeave);
  const cutterR = cutter.diameter / 2;
  const probeMm = Math.max(0.05, Math.min(cutterR / 2, 2 * input.sampling.sampling));
  const cutterH = kernel.makeCutter(cutter);
  const passes: WaterlinePass[] = [];
  const overrunPasses: WaterlinePass[] = [];
  let slicedLoops = 0;
  try {
    for (let li = 0; li < levels.length; li++) {
      if (opts?.signal?.aborted) {
        const err = new Error('waterlineFinish: aborted');
        err.name = 'AbortError';
        throw err;
      }
      const z = levels[li];
      const loops = await slicer.slice(input.partMesh, cutter, z, input.sampling);
      slicedLoops += loops.length;
      const levelPasses = await classifyLevel({
        loops, z, level: li, kernel, mesh: input.mesh, cutter: cutterH,
        probeMm, zSeed: input.zSeed,
        direction: input.direction, spindle: input.spindle,
        minSlopeDeg: input.minSlopeDeg, minRunMm: cutter.diameter,
        signal: opts?.signal,
      });
      for (const pass of levelPasses) {
        if (input.boundary === undefined) passes.push(pass);
        else {
          // Keep the legacy containment pieces literally unchanged. The wider
          // region contributes only fragments outside that containment, so an
          // overrun cannot move, resample or replace an in-region waterline.
          passes.push(...clipPassToRegion(pass, input.boundary));
          if (input.overrunBoundary !== undefined) {
            for (const outside of clipPassOutsideRegion(pass, input.boundary)) {
              overrunPasses.push(...clipPassToRegion(outside, input.overrunBoundary));
            }
          }
        }
      }
      opts?.onProgress?.((0.9 * (li + 1)) / levels.length);
    }
  } finally {
    kernel.releaseCutter(cutterH);
  }
  if (slicedLoops === 0) {
    fail(
      `no waterline loops on any of the ${levels.length} levels between ${input.topZ} and ${input.bottomZ} mm; ` +
        'the cutter meets no material in that band (check the finishing band and the tool).',
    );
  }
  if (passes.length === 0 && overrunPasses.length === 0) {
    fail(
      'every waterline loop was removed by the steep-areas-only angle or the boundary clip; ' +
        'lower the angle, widen the boundary, or leave them off.',
    );
  }
  regionise(passes, 2 * stepdown + cutter.diameter);
  regionise(overrunPasses, 2 * stepdown + cutter.diameter);
  const ordered = orderPasses(passes, input.order);
  // Interior first preserves its complete pass order. Exterior fragments are
  // additive and cannot perturb nearest-first or region grouping inside.
  ordered.push(...orderPasses(overrunPasses, input.order));
  const moves = linkWaterlinePasses(ordered, heights, {
    stepdown,
    cutterRadiusMm: cutterR,
    ...(input.rampAngleDeg !== undefined ? { rampAngleDeg: input.rampAngleDeg } : {}),
  });
  opts?.onProgress?.(1);
  return {
    moves,
    meta: {
      strategyId: 'waterline_finish',
      cutterId: cutterIdOf(input.cutter),
      params: {
        stepdown,
        sampling: input.sampling.sampling,
        minSampling: input.sampling.minSampling,
        stockToLeave,
        minSlopeDeg: input.minSlopeDeg,
        flatAreaDetection: input.flatAreaDetection,
        order: input.order,
        direction: input.direction,
        spindle: input.spindle,
        topZ: input.topZ,
        bottomZ: input.bottomZ,
        levels: levels.length,
        zSeed: input.zSeed,
        clearanceZ: heights.clearanceZ,
        retractZ: heights.retractZ,
        boundaryRingCount: input.boundary !== undefined ? input.boundary.length : 0,
        ...(heights.materialTopZ !== undefined ? { materialTopZ: heights.materialTopZ } : {}),
        slicer: slicer.name,
      },
    },
  };
}
