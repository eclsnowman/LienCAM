// WO-2638: a waterline on a part past the slicer's one-piece limit is sliced
// in tiles and joined, never refused (Operator ruling 2026-10-06, item 7).
//
// The real opencamlib wasm is loaded the way waterlineOclAdapter.wo1176 does
// (emscripten build + `window` shim) and driven through the operation's own
// entry point, computeWaterline3dMoves -> Cam3dClient -> Cam3dDispatcher ->
// slicer, with a real BvhKernel. The truth every path is measured against is
// analytic: a flat cutter's centre at one height sits exactly one radius off
// a box-built part.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import { area } from '../../cam3d/geom2d';
import {
  createOclWaterlineSlicer, waterlineSamplingFor, type OclWaterlineModule, type WaterlineSlicer,
} from '../../cam3d/kernel/oclWaterline';
import {
  cropTrianglesToBox, waterlineTilePlan, WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO,
} from '../../cam3d/kernel/waterlineTiles';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import {
  computeWaterline3dMoves, DEFAULT_WATERLINE_PARAMS, type WaterlineParams,
} from '../../cam3d/integration/waterline3dOperation';
import type { Tool } from '../../types';

const g = globalThis as { window?: unknown };
let hadWindow = false;
beforeAll(() => {
  hadWindow = 'window' in g;
  if (!hadWindow) g.window = globalThis;
});
afterAll(() => {
  if (!hadWindow) delete g.window;
});

const require = createRequire(import.meta.url);
const loadEmscripten = async (): Promise<OclWaterlineModule> =>
  require('@opencamlib/opencamlib/lib/emscripten/index.js') as OclWaterlineModule;

type Rect = [number, number, number, number, number, number];

/** Axis-aligned boxes [x0, y0, z0, x1, y1, z1] as one mesh (overlaps are fine for the slicer). */
function boxes(list: Rect[]): PartMesh {
  const b = new MeshBuilder();
  for (const [x0, y0, z0, x1, y1, z1] of list) {
    const v = (x: number, y: number, z: number) => b.vertex(x, y, z);
    const a00 = v(x0, y0, z0), a10 = v(x1, y0, z0), a11 = v(x1, y1, z0), a01 = v(x0, y1, z0);
    const t00 = v(x0, y0, z1), t10 = v(x1, y0, z1), t11 = v(x1, y1, z1), t01 = v(x0, y1, z1);
    b.quad(a00, a01, a11, a10);
    b.quad(t00, t10, t11, t01);
    b.quad(a00, a10, t10, t00);
    b.quad(a10, a11, t11, t10);
    b.quad(a11, a01, t01, t11);
    b.quad(a01, a00, t00, t01);
  }
  return b.build();
}

/** XY distance from a point to the union of the boxes' footprints (0 inside). */
function distToFootprint(list: Rect[], x: number, y: number): number {
  let best = Infinity;
  for (const [x0, y0, , x1, y1] of list) {
    const dx = Math.max(x0 - x, 0, x - x1);
    const dy = Math.max(y0 - y, 0, y - y1);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

function perimeter(ring: Ring): number {
  let p = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(ring[2 * j] - ring[2 * i], ring[2 * j + 1] - ring[2 * i + 1]);
  }
  return p;
}

/** Largest distance from any vertex of `a` to the polyline `b` (closed). */
function oneSidedHausdorff(a: Ring, b: Ring): number {
  let worst = 0;
  const n = b.length / 2;
  for (let i = 0; i < a.length; i += 2) {
    const px = a[i], py = a[i + 1];
    let best = Infinity;
    for (let k = 0; k < n; k++) {
      const x0 = b[2 * k], y0 = b[2 * k + 1];
      const x1 = b[2 * ((k + 1) % n)], y1 = b[2 * ((k + 1) % n) + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

function makeClient(slicer: WaterlineSlicer): Cam3dClient {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  }, { slicer });
  return new Cam3dClient(fakeWorker);
}

const flat6: Tool = {
  id: 'tool-flat-6', name: 'flat 6', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: { default: { rpm: 12000, feedRate: 900, plungeRate: 300, depthOfCut: 2, stepover: 1 } },
} as unknown as Tool;
const FLAT6: CutterSpec = { kind: 'flat', diameter: 6 };
const R = 3;

describe('waterlineTilePlan', () => {
  it('is null inside the measured ratio and tiles past it with every clipped box inside it', () => {
    const sampling = 0.1; // tolerance 0.01
    expect(waterlineTilePlan({ min: [0, 0, 0], max: [180, 30, 10] }, R, sampling)).toBeNull();
    const plan = waterlineTilePlan({ min: [0, 0, 0], max: [1000, 400, 10] }, R, sampling)!;
    expect(plan).not.toBeNull();
    expect(plan.sampling).toBe(sampling);
    expect(plan.tiles).toHaveLength(plan.nx * plan.ny);
    for (const { cell, box } of plan.tiles) {
      expect(box.maxX - box.minX).toBeLessThanOrEqual(WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO * sampling + 1e-9);
      expect(box.maxY - box.minY).toBeLessThanOrEqual(WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO * sampling + 1e-9);
      // The box holds every triangle a cutter centred in the cell can touch.
      expect(cell.minX - box.minX).toBeGreaterThanOrEqual(R);
      expect(box.maxY - cell.maxY).toBeGreaterThanOrEqual(R);
    }
    // The cells cover the part grown by the cutter radius.
    expect(Math.min(...plan.tiles.map(t => t.cell.minX))).toBeLessThanOrEqual(-R);
    expect(Math.max(...plan.tiles.map(t => t.cell.maxX))).toBeGreaterThanOrEqual(1000 + R);
    expect(Math.max(...plan.tiles.map(t => t.cell.maxY))).toBeGreaterThanOrEqual(400 + R);
  });

  it('slices a cutter too wide for a tile at a coarser spacing instead of refusing it', () => {
    const plan = waterlineTilePlan({ min: [0, 0, 0], max: [500, 10, 10] }, 60, 0.1)!;
    expect(plan.sampling).toBeGreaterThan(0.1);
    for (const { box } of plan.tiles) {
      expect(box.maxX - box.minX).toBeLessThanOrEqual(WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO * plan.sampling + 1e-9);
    }
  });
});

describe('cropTrianglesToBox', () => {
  it('keeps exactly the surface inside the box, z interpolated on the plane', () => {
    const b = new MeshBuilder();
    // One sloped triangle z = x / 10 over a 100 x 100 corner.
    b.tri(b.vertex(0, 0, 0), b.vertex(100, 0, 10), b.vertex(0, 100, 0));
    const tris = cropTrianglesToBox(b.build(), { minX: 20, minY: 10, maxX: 40, maxY: 30 });
    let a = 0;
    for (const t of tris) {
      for (const p of t) {
        expect(p[0]).toBeGreaterThanOrEqual(20 - 1e-9);
        expect(p[0]).toBeLessThanOrEqual(40 + 1e-9);
        expect(p[2]).toBeCloseTo(p[0] / 10, 9);
      }
      a += Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;
    }
    expect(a).toBeCloseTo(400, 6); // the 20 x 20 box lies wholly under the triangle
  });
});

describe('the real slicer past the limit', () => {
  // A frame: 60 x 40 outside, a 30 x 20 window through it, 10 high. At one
  // height its waterline is two loops: the outside grown by R, the window
  // shrunk by R - a boss and a pocket in one part.
  const FRAME: Rect[] = [
    [0, 0, 0, 60, 10, 10], [0, 30, 0, 60, 40, 10], [0, 10, 0, 15, 30, 10], [45, 10, 0, 60, 30, 10],
  ];
  const sampling = waterlineSamplingFor(0.05);

  it('tiled loops match the one-piece loops and the analytic offset, boss and pocket alike', async () => {
    const mesh = boxes(FRAME);
    const whole = await createOclWaterlineSlicer({ load: loadEmscripten }).slice(mesh, FLAT6, 5, sampling);
    // Force tiles on a part the slicer takes in one piece: 30 mm boxes, 3 x 2 of them.
    const ratio = 60;
    expect(waterlineTilePlan(mesh.bounds, R, sampling.sampling, ratio)!.tiles.length).toBeGreaterThan(4);
    const tiled = await createOclWaterlineSlicer({ load: loadEmscripten, maxFootprintRatio: ratio })
      .slice(mesh, FLAT6, 5, sampling);
    expect(whole).toHaveLength(2);
    expect(tiled).toHaveLength(2);
    const byArea = (rs: Ring[]) => [...rs].sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
    const [wOut, wIn] = byArea(whole);
    const [tOut, tIn] = byArea(tiled);
    expect(Math.abs(area(tOut))).toBeCloseTo(Math.abs(area(wOut)), 0);
    expect(Math.abs(area(tIn))).toBeCloseTo(Math.abs(area(wIn)), 0);
    for (const [t, w] of [[tOut, wOut], [tIn, wIn]] as const) {
      expect(oneSidedHausdorff(t, w)).toBeLessThan(0.05);
      expect(oneSidedHausdorff(w, t)).toBeLessThan(0.05);
    }
    // Gouge-free and complete against the analytic truth: every tiled vertex sits one radius off the frame.
    for (const ring of tiled) {
      for (let i = 0; i < ring.length; i += 2) {
        const d = distToFootprint(FRAME, ring[i], ring[i + 1]);
        expect(d).toBeGreaterThan(R - 0.01);
        expect(d).toBeLessThan(R + 0.05);
      }
    }
    // The window loop is the 30 x 20 window shrunk by R: a 24 x 14 rectangle.
    expect(perimeter(tIn)).toBeCloseTo(2 * (24 + 14), 0);
  }, 120_000);
});

describe('computeWaterline3dMoves on a part past the limit (production entry point, real slicer)', () => {
  // A 200 mm bar at a 0.01 mm tolerance slices at 0.1 mm: 2000 samples across,
  // past the proven 1800. Main refused it before starting.
  const BAR: Rect[] = [[0, 0, 0, 200, 30, 10]];
  const params: WaterlineParams = {
    ...DEFAULT_WATERLINE_PARAMS, tolerance: 0.01, stepdown: 5, flatAreaDetection: false,
  };
  const heights = { clearanceZ: 30, retractZ: 25, feedZ: 19, topZ: 10, bottomZ: 0, stockTopZ: 10 };

  it('finishes it in tiles, says so, and every cut sits one radius off the bar all the way round', async () => {
    const client = makeClient(createOclWaterlineSlicer({ load: loadEmscripten }));
    try {
      const out = await computeWaterline3dMoves({
        partMesh: boxes(BAR), tool: flat6, params, resolvedHeights: heights, client,
      });
      expect(out.notices?.some(n => /200\.0 mm across.*sliced in 2 x 1 tiles at the full tolerance/.test(n)))
        .toBe(true);
      const cuts = out.moves.filter(m => m.role === 'cut');
      const levels = [...new Set(cuts.map(m => m.z))].sort((p, q) => q - p);
      expect(levels.length).toBeGreaterThanOrEqual(2);
      for (const z of levels) {
        const at = cuts.filter(m => m.z === z);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const m of at) {
          const d = distToFootprint(BAR, m.x, m.y);
          expect(d).toBeGreaterThan(R - 0.01);
          expect(d).toBeLessThan(R + 0.05);
          minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
          minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
        }
        // Complete: the loop reaches every side of the bar, across the seam.
        expect(minX).toBeCloseTo(-R, 1);
        expect(maxX).toBeCloseTo(200 + R, 1);
        expect(minY).toBeCloseTo(-R, 1);
        expect(maxY).toBeCloseTo(30 + R, 1);
      }
    } finally {
      await client.dispose();
    }
  }, 300_000);
});

describe('parts inside the limit are untouched', () => {
  it('one-piece slicer output is byte-identical to main', async () => {
    const mesh = boxes([[10, 10, 2, 30, 30, 12], [0, 0, 0, 40, 40, 2]]);
    const slicer = createOclWaterlineSlicer({ load: loadEmscripten });
    const out: number[][] = [];
    for (const z of [11, 6, 1]) {
      for (const ring of await slicer.slice(mesh, { kind: 'ball', diameter: 4 }, z, waterlineSamplingFor(0.05))) {
        out.push(Array.from(ring));
      }
    }
    const hash = createHash('sha256').update(JSON.stringify(out)).digest('hex');
    // Pinned from main's oclWaterline.ts (see the WO-2638 worker result).
    expect(hash).toBe(MAIN_ONE_PIECE_HASH);
  }, 120_000);

  it('a part inside the limit gets no tile notice', async () => {
    const part = bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 });
    const fake: WaterlineSlicer = {
      name: 'fake-rect',
      async slice(_m, cutter, z) {
        if (z > 14 || z < 0) return [];
        const r = cutter.diameter / 2;
        return [new Float64Array([10 - r, 10 - r, 90 + r, 10 - r, 90 + r, 90 + r, 10 - r, 90 + r])];
      },
    };
    const out = await computeWaterline3dMoves({
      partMesh: part, tool: flat6,
      params: { ...DEFAULT_WATERLINE_PARAMS, stepdown: 4, flatAreaDetection: false },
      resolvedHeights: { clearanceZ: 30, retractZ: 25, feedZ: 19, topZ: 14, bottomZ: 0, stockTopZ: 14 },
      client: makeClient(fake),
    });
    expect(out.notices ?? []).toEqual([]);
  });
});

const MAIN_ONE_PIECE_HASH = '938acfc2ff30cedbb98a7e5a11dd7b4423a46f66e905be1da98a78b802646555';
