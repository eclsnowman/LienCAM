// WO-1271: Parallel Finish leaves vertical fins at the stock edge.
//
// The strategy clips the tool CENTRE to the containment region, so a pass
// that stops with its axis on the edge leaves one tool radius of material
// outside the cut. For a FLAT cutter on a surface sloping down toward the
// edge that leftover is a wedge one radius wide and up to R * slope tall
// (the comb of fins Operator saw on the shakedown wave); for a ball it is the
// crescent he reasoned about. These tests are behavioural: they measure the
// cutter tip height at the edge with and without the overrun, prove the
// overrun never plunges to the floor where the part ends, prove interior
// passes are byte-identical with and without it, and prove the case that
// makes the order dangerous -- a wall belonging to the model is never cut
// into with the overrun ON, and a face-scoped pass (whose region edge IS a
// wall) never overruns at all.

import { describe, expect, it, vi } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterHandle, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { steps, wave } from '../../cam3d/fixtures';
import { holdOverrunMisses, parallelFinish } from '../../cam3d/strategies/parallel';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import type { Ring } from '../../cam3d/geom2d';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Tool, ToolpathMove } from '../../types';
import {
  computeParallel3dMoves,
  readParallel3dParams,
  resolveStockEdgeOverrun,
  STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM,
  xyBoundsRing,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIZE = 20;
const Z0 = 5;
const SLOPE = 0.5;
const FLAT6 = { kind: 'flat', diameter: 6 } as const;
const R = 3;
/** The auto overrun: one radius less the tangent margin. */
const OVERRUN = R - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM;

/**
 * A closed slab over [0,SIZE]^2 whose top is the plane z = Z0 + SLOPE * x:
 * lowest at the x = 0 edge, rising inward. A flat cutter centred ON that edge
 * is held up by the higher material inside its footprint, so the tip sits at
 * z(R) = Z0 + SLOPE * R, not at z(0) = Z0. That gap IS the fin.
 */
function slopedSlab(n = 21): PartMesh {
  const b = new MeshBuilder();
  const top = (x: number, y: number): number => b.vertex(x, y, Z0 + SLOPE * x);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const x0 = (SIZE * i) / (n - 1), x1 = (SIZE * (i + 1)) / (n - 1);
      const y0 = (SIZE * j) / (n - 1), y1 = (SIZE * (j + 1)) / (n - 1);
      b.quad(top(x0, y0), top(x1, y0), top(x1, y1), top(x0, y1));
    }
  }
  // Walls + bottom, CCW from outside.
  const c00 = b.vertex(0, 0, 0), c10 = b.vertex(SIZE, 0, 0);
  const c11 = b.vertex(SIZE, SIZE, 0), c01 = b.vertex(0, SIZE, 0);
  b.quad(c00, c01, c11, c10); // bottom (-Z)
  b.quad(c00, c10, top(SIZE, 0), top(0, 0)); // y = 0 wall (-Y)
  b.quad(c10, c11, top(SIZE, SIZE), top(SIZE, 0)); // x = SIZE wall (+X)
  b.quad(c11, c01, top(0, SIZE), top(SIZE, SIZE)); // y = SIZE wall (+Y)
  b.quad(c01, c00, top(0, 0), top(0, SIZE)); // x = 0 wall (-X)
  return b.build();
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return new Float64Array([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
}

const kernel = new BvhKernel();

function cutMoves(ir: ToolpathIR): IrMove[] {
  return ir.moves.filter(m => m.role === 'cut');
}

async function redrop(mesh: MeshHandle, cutter: CutterHandle, pts: readonly { x: number; y: number }[], zSeed: number): Promise<Float64Array> {
  const xy = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    xy[2 * i] = pts[i].x;
    xy[2 * i + 1] = pts[i].y;
  }
  return kernel.dropPoints(mesh, cutter, xy, zSeed);
}

const HEIGHTS = { clearanceZ: 30, retractZ: 20, feedZ: 20 };
const Z_SEED = -10;

function strategyInput(mesh: MeshHandle, extra: Record<string, unknown> = {}) {
  return {
    mesh,
    cutter: FLAT6,
    stepover: 2,
    angleDeg: 0,
    tolerance: 0.05,
    xyBounds: { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE },
    heights: HEIGHTS,
    zSeed: Z_SEED,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Strategy: the fin, and its removal
// ---------------------------------------------------------------------------

describe('WO-1271 strategy: the tool centre is clipped, the overrun lets the cutter clear the edge', () => {
  const slabMesh = kernel.uploadMesh(slopedSlab());

  it('without an overrun a flat cutter stops with its axis on the edge and leaves a wedge one radius wide', async () => {
    const ir = await parallelFinish(kernel, strategyInput(slabMesh));
    const cuts = cutMoves(ir);
    const onEdge = cuts.filter(m => Math.abs(m.x) < 1e-9);
    expect(onEdge.length).toBeGreaterThan(0);
    // Held up by the material one radius inside: the tip is at z(R), R*slope
    // above the surface at the edge. That is the fin height.
    for (const m of onEdge) expect(m.z).toBeCloseTo(Z0 + SLOPE * R, 3);
    // And nothing ever goes past the containment edge.
    for (const m of cuts) {
      expect(m.x).toBeGreaterThanOrEqual(-1e-9);
      expect(m.x).toBeLessThanOrEqual(SIZE + 1e-9);
    }
    expect(ir.meta.params?.overrunRingCount).toBeUndefined();
  });

  it('with the overrun the pass runs one radius past the edge and the tip follows the surface down to it', async () => {
    const legacy = await parallelFinish(kernel, strategyInput(slabMesh));
    const ir = await parallelFinish(kernel, strategyInput(slabMesh, {
      overrunBoundary: [rect(-OVERRUN, -OVERRUN, SIZE + OVERRUN, SIZE + OVERRUN)],
    }));
    const cuts = cutMoves(ir);

    // The pass end is one radius (less the tangent margin) beyond the edge.
    const xs = cuts.map(m => m.x);
    expect(Math.min(...xs)).toBeCloseTo(-OVERRUN, 6);
    expect(Math.max(...xs)).toBeCloseTo(SIZE + OVERRUN, 6);
    // At that end the footprint keeps a 0.01 mm sliver of part under it, so
    // the tip is on the surface at the edge (z(0.01)), not R*slope above it.
    const atEnd = cuts.filter(m => Math.abs(m.x + OVERRUN) < 1e-9);
    expect(atEnd.length).toBeGreaterThan(0);
    for (const m of atEnd) expect(m.z).toBeCloseTo(Z0 + SLOPE * STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM, 3);

    // Never below the lowest surface: an overrun sample never plunges to
    // zSeed. The lowest point on the part is Z0 at the x = 0 edge.
    for (const m of cuts) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);

    // No gouge anywhere: every cut point is at or above what an independent
    // drop reports for that xy (a miss reports zSeed, trivially below).
    const c = kernel.makeCutter(FLAT6);
    try {
      const truth = await redrop(slabMesh, c, cuts, Z_SEED);
      for (let i = 0; i < cuts.length; i++) expect(cuts[i].z).toBeGreaterThanOrEqual(truth[i] - 1e-9);
    } finally {
      kernel.releaseCutter(c);
    }

    // Scanlines stay on the containment lattice: extra passes appear beyond
    // it (y = -2 and y = 22 with a 2 mm stepover), interior ones do not move.
    const ys = [...new Set(cuts.map(m => m.y))].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-2, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(SIZE + 2, 9);

    // Every interior sample of the legacy pass survives BIT-FOR-BIT, and every
    // added sample lies outside the containment region.
    const key = (m: IrMove) => `${m.x}|${m.y}|${m.z}`;
    const withOverrun = new Set(cuts.map(key));
    for (const m of cutMoves(legacy)) expect(withOverrun.has(key(m)), `legacy cut ${key(m)} missing`).toBe(true);
    // (Any legacy role: the legacy FIRST pass begins with a plunge onto its
    // first sample, which the overrun run reaches as a plain cut.)
    const legacyKeys = new Set(legacy.moves.map(key));
    for (const m of cuts) {
      if (legacyKeys.has(key(m))) continue;
      const outside = m.x < -1e-9 || m.x > SIZE + 1e-9 || m.y < -1e-9 || m.y > SIZE + 1e-9;
      expect(outside, `added sample ${key(m)} is inside the containment`).toBe(true);
    }
    expect(ir.meta.params?.overrunRingCount).toBe(1);
    expect(ir.meta.params?.overrunPassesDropped).toBe(0);
  });

  it('an overrun sample that finds no part holds the nearest surface height; a pass that finds none is dropped', async () => {
    // A band far wider than the radius: samples more than R past the edge
    // miss the mesh. They must hold the height they left, never zSeed, and
    // scanlines beyond R of the part (all misses) must not exist at all.
    const wide = 10;
    const ir = await parallelFinish(kernel, strategyInput(slabMesh, {
      overrunBoundary: [rect(-wide, -wide, SIZE + wide, SIZE + wide)],
    }));
    const cuts = cutMoves(ir);
    for (const m of cuts) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);
    expect(Math.min(...cuts.map(m => m.x))).toBeCloseTo(-wide, 6);
    // y = -2 is within R of the part (its footprint reaches y = +1): kept.
    // y = -4 and beyond: the footprint never touches the part: dropped.
    const ys = [...new Set(cuts.map(m => m.y))].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-2, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(SIZE + 2, 9);
    expect(ir.meta.params?.overrunPassesDropped).toBeGreaterThan(0);
  });

  it('holdOverrunMisses rewrites only flagged misses and reports a pass with no hit', () => {
    const z = new Float64Array([-10, 7, 6, -10, -10]);
    const flags = Uint8Array.from([1, 0, 0, 1, 1]);
    const nb = new Float64Array(20).fill(-10);
    expect(holdOverrunMisses(z, flags, -10, nb)).toBe(true);
    expect(Array.from(z)).toEqual([7, 7, 6, 6, 6]);
    // In-region probes are untouched (still the miss value); overrun probes are level.
    expect(nb[4]).toBe(-10);
    expect(nb[0]).toBe(7);
    expect(nb[19]).toBe(6);
    // An in-region miss is never rewritten.
    const z2 = new Float64Array([-10, 5]);
    expect(holdOverrunMisses(z2, Uint8Array.from([0, 1]), -10)).toBe(true);
    expect(Array.from(z2)).toEqual([-10, 5]);
    expect(holdOverrunMisses(new Float64Array([-10, -10]), Uint8Array.from([1, 1]), -10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adapter: WHEN the overrun applies (the CAM judgement of the order)
// ---------------------------------------------------------------------------

function makeClient(): Cam3dClient {
  const k = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(k, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

const FLAT_TOOL: Tool = {
  id: 'tool-flat6',
  name: 'flat d6',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
};

const WAVE = wave(SIZE, 25);
const WAVE_HEIGHTS: ResolvedParallel3dHeights = { clearanceZ: 25, retractZ: 16, feedZ: 16, topZ: 15, bottomZ: 0 };
const BASE_PARAMS: Parallel3dParams = { stepover: 2, angleDeg: 0, tolerance: 0.1, useStockBoundary: false };

function cutExtent(moves: readonly ToolpathMove[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of moves) {
    if (m.role !== 'cut') continue;
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }
  return { minX, maxX, minY, maxY };
}

async function compute(partMesh: PartMesh, params: Parallel3dParams, extra: {
  boundary?: readonly Ring[]; boundaryKind?: 'stock' | 'selection'; faceScope?: readonly number[];
} = {}): Promise<ToolpathMove[]> {
  const { moves } = await computeParallel3dMoves({
    partMesh, tool: FLAT_TOOL, params, resolvedHeights: WAVE_HEIGHTS, client: makeClient(), ...extra,
  });
  return moves;
}

describe('WO-1271 adapter: the overrun is auto one radius on stock and part edges, never on a selection edge', () => {
  it('readParallel3dParams: absent or invalid -> auto (undefined); a finite >= 0 value is kept', () => {
    expect(readParallel3dParams({}).stockEdgeOvershoot).toBeUndefined();
    expect(readParallel3dParams({ stockEdgeOvershoot: -1 }).stockEdgeOvershoot).toBeUndefined();
    expect(readParallel3dParams({ stockEdgeOvershoot: 'x' }).stockEdgeOvershoot).toBeUndefined();
    expect(readParallel3dParams({ stockEdgeOvershoot: 0 }).stockEdgeOvershoot).toBe(0);
    expect(readParallel3dParams({ stockEdgeOvershoot: 1.25 }).stockEdgeOvershoot).toBe(1.25);
  });

  it('resolveStockEdgeOverrun: auto is the radius less the tangent margin; 0 is none; a face scope is never overrun', async () => {
    const xyBounds = { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE };
    const auto = await resolveStockEdgeOverrun({ cutterRadius: R, xyBounds });
    expect(auto.overrunMm).toBeCloseTo(OVERRUN, 12);
    expect(auto.rings?.length).toBe(1);
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < auto.rings![0].length; i += 2) {
      minX = Math.min(minX, auto.rings![0][i]);
      maxX = Math.max(maxX, auto.rings![0][i]);
    }
    expect(minX).toBeCloseTo(-OVERRUN, 5);
    expect(maxX).toBeCloseTo(SIZE + OVERRUN, 5);

    const off = await resolveStockEdgeOverrun({ cutterRadius: R, stockEdgeOvershoot: 0, xyBounds });
    expect(off.overrunMm).toBe(0);
    expect(off.rings).toBeUndefined();

    const scoped = await resolveStockEdgeOverrun({ cutterRadius: R, faceScope: [3], xyBounds });
    expect(scoped.overrunMm).toBe(0);
    expect(scoped.rings).toBeUndefined();
    expect(scoped.reason).toMatch(/wall/);

    const set = await resolveStockEdgeOverrun({
      cutterRadius: R, stockEdgeOvershoot: 1.5, boundary: [xyBoundsRing(xyBounds)], boundaryKind: 'stock', xyBounds,
    });
    expect(set.overrunMm).toBeCloseTo(1.5 - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM, 12);
    expect(set.reason).toMatch(/stock outline/);
  });

  it('part bounds (default): auto overruns one radius on every side; 0 stops on the mesh bounds', { timeout: 60_000 }, async () => {
    const auto = await compute(WAVE, BASE_PARAMS);
    const e = cutExtent(auto);
    expect(e.minX).toBeCloseTo(-OVERRUN, 6);
    expect(e.maxX).toBeCloseTo(SIZE + OVERRUN, 6);
    // Extra scanlines only where the containment lattice reaches into the
    // band: y = -2 and y = 22 with a 2 mm stepover, never a re-spaced lattice.
    expect(e.minY).toBeCloseTo(-2, 9);
    expect(e.maxY).toBeCloseTo(SIZE + 2, 9);

    const none = await compute(WAVE, { ...BASE_PARAMS, stockEdgeOvershoot: 0 });
    const e0 = cutExtent(none);
    expect(e0.minX).toBeCloseTo(0, 9);
    expect(e0.maxX).toBeCloseTo(SIZE, 9);
    expect(e0.minY).toBeGreaterThanOrEqual(-1e-9);
    expect(e0.maxY).toBeLessThanOrEqual(SIZE + 1e-9);

    // Determinism (D-006) holds with the overrun.
    const again = await compute(WAVE, BASE_PARAMS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(auto));
  });

  it('stock outline (vouched): auto overruns one radius past the stock footprint; an explicit value is honoured', { timeout: 60_000 }, async () => {
    const boundary = [xyBoundsRing({ minX: 0, minY: 0, maxX: SIZE, maxY: SIZE })];
    const auto = await compute(WAVE, { ...BASE_PARAMS, useStockBoundary: true }, { boundary, boundaryKind: 'stock' });
    const e = cutExtent(auto);
    expect(e.minX).toBeCloseTo(-OVERRUN, 6);
    expect(e.maxX).toBeCloseTo(SIZE + OVERRUN, 6);

    const set = await compute(WAVE, { ...BASE_PARAMS, useStockBoundary: true, stockEdgeOvershoot: 1.5 }, { boundary, boundaryKind: 'stock' });
    const e1 = cutExtent(set);
    expect(e1.minX).toBeCloseTo(-(1.5 - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM), 6);
    expect(e1.maxX).toBeCloseTo(SIZE + 1.5 - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM, 6);
  });

  it('a caller-provided boundary is never overrun unless the caller vouches it is a stock outline (forgetting costs a fin, never a gouge)', { timeout: 60_000 }, async () => {
    const boundary = [xyBoundsRing({ minX: 2, minY: 2, maxX: SIZE - 2, maxY: SIZE - 2 })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const unvouched = await compute(WAVE, BASE_PARAMS, { boundary });
      const e = cutExtent(unvouched);
      expect(e.minX).toBeCloseTo(2, 9);
      expect(e.maxX).toBeCloseTo(SIZE - 2, 9);
      const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('stock-edge overrun'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/did not say whether this boundary is a stock outline/);

      warn.mockClear();
      const selection = await compute(WAVE, BASE_PARAMS, { boundary, boundaryKind: 'selection' });
      expect(JSON.stringify(selection)).toBe(JSON.stringify(unvouched));
      expect(warn.mock.calls.filter(call => String(call[0]).includes('stock-edge overrun'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
    const decision = await resolveStockEdgeOverrun({ cutterRadius: R, boundary, xyBounds: { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE } });
    expect(decision.overrunMm).toBe(0);
    expect(decision.unvouched).toBe(true);
  });

  it('a face-scoped pass never overruns: byte-identical with auto and with 0, and stays inside the inset region', { timeout: 60_000 }, async () => {
    const faceIds = new Uint32Array(WAVE.indices.length / 3).fill(7);
    const scopedMesh: PartMesh = { ...WAVE, faceIds };
    const auto = await compute(scopedMesh, BASE_PARAMS, { faceScope: [7] });
    const none = await compute(scopedMesh, { ...BASE_PARAMS, stockEdgeOvershoot: 0 }, { faceScope: [7] });
    expect(JSON.stringify(auto)).toBe(JSON.stringify(none));
    const e = cutExtent(auto);
    // WO-1223 inset: radius + 0.05 mm clearance, on every side.
    expect(e.minX).toBeGreaterThanOrEqual(R + 0.05 - 1e-6);
    expect(e.maxX).toBeLessThanOrEqual(SIZE - R - 0.05 + 1e-6);
  });
});

// ---------------------------------------------------------------------------
// The case that makes the order dangerous: walls belonging to the model
// ---------------------------------------------------------------------------

describe('WO-1271 walls: a finish pass with the overrun ON never cuts into a wall that belongs to the model', () => {
  // A 40 x 40 x 5 slab carrying a 20 x 20 x 5 boss centred on it: the boss
  // walls stand INSIDE the region, and its top is at z = 10.
  const STEP_SIZE = 40;
  const STEP_H = 5;
  const BOSS_MIN = 10;
  const BOSS_MAX = 30;
  const stepped = steps(2, STEP_SIZE, STEP_H);
  const STEP_HEIGHTS: ResolvedParallel3dHeights = { clearanceZ: 30, retractZ: 20, feedZ: 20, topZ: 10, bottomZ: 0 };
  const PARAMS: Parallel3dParams = { stepover: 2, angleDeg: 0, tolerance: 0.05, useStockBoundary: false };

  it('rides over the boss: every cut point over its footprint (plus a radius) is at or above the boss top, and the overrun still happened', { timeout: 120_000 }, async () => {
    const { moves } = await computeParallel3dMoves({
      partMesh: stepped, tool: FLAT_TOOL, params: PARAMS, resolvedHeights: STEP_HEIGHTS, client: makeClient(),
    });
    const cuts = moves.filter(m => m.role === 'cut');
    expect(cuts.length).toBeGreaterThan(0);
    const e = cutExtent(moves);
    expect(e.minX).toBeCloseTo(-OVERRUN, 6);
    expect(e.maxX).toBeCloseTo(STEP_SIZE + OVERRUN, 6);

    // Distance from the cutter axis to the boss footprint (a square).
    const bossDistance = (x: number, y: number): number => Math.hypot(
      Math.max(0, BOSS_MIN - x, x - BOSS_MAX), Math.max(0, BOSS_MIN - y, y - BOSS_MAX),
    );
    let overBoss = 0;
    for (const m of cuts) {
      if (bossDistance(m.x, m.y) >= R - 1e-9) continue; // footprint clear of the boss

      overBoss++;
      expect(m.z, `cut at (${m.x}, ${m.y}) is inside the boss wall`).toBeGreaterThanOrEqual(2 * STEP_H - 1e-6);
    }
    expect(overBoss).toBeGreaterThan(0);

    // And nowhere at all is the cutter below the surface it would contact.
    const k = new BvhKernel();
    const mh = k.uploadMesh(stepped);
    const c = k.makeCutter(FLAT6);
    try {
      const xy = new Float64Array(cuts.length * 2);
      for (let i = 0; i < cuts.length; i++) {
        xy[2 * i] = cuts[i].x;
        xy[2 * i + 1] = cuts[i].y;
      }
      const truth = await k.dropPoints(mh, c, xy, 0);
      for (let i = 0; i < cuts.length; i++) expect(cuts[i].z).toBeGreaterThanOrEqual(truth[i] - 1e-9);
    } finally {
      k.releaseCutter(c);
    }
    // The tread around the boss is finished all the way to the slab edge (the
    // fin case): cut points at the far end sit on the tread, not R*0 above it
    // -- the tread is flat, so the tip is exactly at STEP_H there.
    const atEnd = cuts.filter(m => Math.abs(m.x + OVERRUN) < 1e-9 && (m.y < BOSS_MIN - R || m.y > BOSS_MAX + R));
    expect(atEnd.length).toBeGreaterThan(0);
    for (const m of atEnd) expect(m.z).toBeCloseTo(STEP_H, 6);
  });

  it('aimed at the tread only (face scope), the pass stops one radius short of the boss wall and of the slab edge, with or without an overrun setting', { timeout: 120_000 }, async () => {
    // Face ids by triangle height: the tread (all vertices at z = STEP_H) is
    // face 1, the boss top (all at 2 * STEP_H) is face 2, everything else 0.
    const triCount = stepped.indices.length / 3;
    const faceIds = new Uint32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const zs = [0, 1, 2].map(v => stepped.positions[stepped.indices[t * 3 + v] * 3 + 2]);
      faceIds[t] = zs.every(z => z === STEP_H) ? 1 : zs.every(z => z === 2 * STEP_H) ? 2 : 0;
    }
    const scopedMesh: PartMesh = { ...stepped, faceIds };
    const run = (params: Parallel3dParams) => computeParallel3dMoves({
      partMesh: scopedMesh, tool: FLAT_TOOL, params, resolvedHeights: STEP_HEIGHTS, client: makeClient(), faceScope: [1],
    });
    const auto = (await run(PARAMS)).moves;
    const none = (await run({ ...PARAMS, stockEdgeOvershoot: 0 })).moves;
    expect(JSON.stringify(auto)).toBe(JSON.stringify(none));
    const inset = R + 0.05;
    const bossDistance = (x: number, y: number): number => Math.hypot(
      Math.max(0, BOSS_MIN - x, x - BOSS_MAX), Math.max(0, BOSS_MIN - y, y - BOSS_MAX),
    );
    let cutCount = 0;
    for (const m of auto) {
      if (m.role !== 'cut') continue;
      cutCount++;
      expect(m.x).toBeGreaterThanOrEqual(inset - 1e-6);
      expect(m.x).toBeLessThanOrEqual(STEP_SIZE - inset + 1e-6);
      expect(m.y).toBeGreaterThanOrEqual(inset - 1e-6);
      expect(m.y).toBeLessThanOrEqual(STEP_SIZE - inset + 1e-6);
      // The boss is the wall this selection edge stands against: the axis
      // never comes within a radius (plus clearance) of it. The WO-1223 inset
      // rounds the hole's corners to a 0.01 mm arc tolerance, hence the slack.
      expect(bossDistance(m.x, m.y), `cut at (${m.x}, ${m.y}) crossed toward the boss wall`)
        .toBeGreaterThanOrEqual(inset - 0.01 - 1e-6);
      expect(m.z).toBeCloseTo(STEP_H, 6);
    }
    expect(cutCount).toBeGreaterThan(0);
  });
});
