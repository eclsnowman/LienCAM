// cam3d integration: parallel_3d adapter (Wave 2) headless proof.
//
// Proves the programmatic compute path WITHOUT the app store or IndexedDB:
//   STL bytes -> acquirePartMesh -> computeParallel3dMoves(in-process client)
//     -> ToolpathMove[]
// on a small procedural surface. Also covers toolToCutterSpec (flat, ball,
// fail-loud). Determinism (D-006) is asserted byte-for-byte across two runs.
//
// The in-process Cam3dClient wiring mirrors parallelFinishClient.test.ts: a
// fake WorkerLike posts straight into a Cam3dDispatcher backed by a REAL
// BvhKernel, so the strategy does genuine drop-cutter work.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { wave } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import type { Tool, ToolType, ToolpathMove } from '../../types';
import {
  computeParallel3dMoves,
  acquirePartMesh,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';
import {
  toolToCutterSpec,
  UnsupportedCutterError,
} from '../../cam3d/integration/cutterSpec';

// ---- in-process client (client <-> dispatcher(real BvhKernel), sync post) ----
function makeClient(): { client: Cam3dClient } {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      /* no-op for the in-process channel */
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return { client: new Cam3dClient(fakeWorker) };
}

// ---- a tiny binary-STL encoder so the test drives the REAL STL importer ----
function meshToBinaryStl(mesh: PartMesh): ArrayBuffer {
  const triCount = mesh.indices.length / 3;
  const ab = new ArrayBuffer(84 + 50 * triCount);
  const view = new DataView(ab);
  view.setUint32(80, triCount, true);
  const p = mesh.positions;
  for (let t = 0; t < triCount; t++) {
    const base = 84 + t * 50 + 12; // skip the (zeroed) normal
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v];
      view.setFloat32(base + v * 12, p[vi * 3], true);
      view.setFloat32(base + v * 12 + 4, p[vi * 3 + 1], true);
      view.setFloat32(base + v * 12 + 8, p[vi * 3 + 2], true);
    }
  }
  return ab;
}

// A small, fast surface: wave heightfield on a 25x25 grid over [0,20]^2.
const WAVE_SIZE = 20;
const WAVE_N = 25;
const STL_BYTES = meshToBinaryStl(wave(WAVE_SIZE, WAVE_N));

function makeTool(type: ToolType, extra: Partial<Tool> = {}): Tool {
  return {
    id: `tool-${type}`,
    name: `${type} d6`,
    type,
    diameter: 6,
    fluteLength: 20,
    shankDiameter: 6,
    overallLength: 50,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
    ...extra,
  };
}

const PARAMS: Parallel3dParams = {
  stepover: 4,
  angleDeg: 0,
  tolerance: 0.1,
  useStockBoundary: true,
};

// Model surface z lives in ~[5,15]; retract above it, clearance above that.
const HEIGHTS: ResolvedParallel3dHeights = {
  clearanceZ: 25,
  retractZ: 16,
  feedZ: 16,
  topZ: 15,
  bottomZ: 0,
};

// Rectangular stock boundary over the part, geom2d OUTER (CCW).
const BOUNDARY: readonly Ring[] = [
  new Float64Array([0, 0, WAVE_SIZE, 0, WAVE_SIZE, WAVE_SIZE, 0, WAVE_SIZE]),
];

const VALID_TYPES = new Set(['rapid', 'feed', 'arc_cw', 'arc_ccw']);
const VALID_ROLES = new Set([
  'rapid', 'cut', 'helix', 'ramp', 'plunge', 'stepover', 'fast_traverse',
  'lead_in', 'lead_out', 'loop_back', 'wall_follow', 'finish',
]);

function assertWellFormed(moves: ToolpathMove[]): void {
  expect(moves.length).toBeGreaterThan(0);
  for (const m of moves) {
    expect(VALID_TYPES.has(m.type), `bad type ${m.type}`).toBe(true);
    expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
    if (m.role !== undefined) expect(VALID_ROLES.has(m.role), `bad role ${m.role}`).toBe(true);
    if (m.feed !== undefined) expect(Number.isFinite(m.feed)).toBe(true);
    if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
      expect(Number.isFinite(m.cx as number) && Number.isFinite(m.cy as number)).toBe(true);
    }
  }
}

describe('acquirePartMesh (STL bytes -> PartMesh at CAM tolerance)', () => {
  it('imports a binary STL into a valid PartMesh', async () => {
    const mesh = await acquirePartMesh({ format: 'stl', bytes: STL_BYTES }, 0.1);
    expect(mesh.source).toBe('stl');
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length / 3).toBeGreaterThan(0);
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isFinite(mesh.positions[i])).toBe(true);
    }
    // Bounds cover the [0,20]^2 footprint the wave was sampled over.
    expect(mesh.bounds.min[0]).toBeCloseTo(0, 5);
    expect(mesh.bounds.max[0]).toBeCloseTo(WAVE_SIZE, 5);
  });
});

describe('toolToCutterSpec', () => {
  it('maps a flat end mill to a flat cutter', () => {
    expect(toolToCutterSpec(makeTool('flat_end_mill'))).toEqual({ kind: 'flat', diameter: 6 });
  });
  it('maps a ball end mill to a ball cutter', () => {
    expect(toolToCutterSpec(makeTool('ball_end_mill'))).toEqual({ kind: 'ball', diameter: 6 });
  });
  it('maps a bull-nose mill to a bull cutter (with corner radius)', () => {
    expect(toolToCutterSpec(makeTool('bull_nose', { cornerRadius: 1 }))).toEqual({
      kind: 'bull', diameter: 6, cornerRadius: 1,
    });
  });
  it('maps a V-bit to a vbit cutter, with its tip flat when it has one (WO-1971)', () => {
    expect(toolToCutterSpec(makeTool('v_bit', { angleFromAxisDeg: 30 }))).toEqual({
      kind: 'vbit', diameter: 6, angleFromAxisDeg: 30,
    });
    expect(toolToCutterSpec(makeTool('v_bit', { angleFromAxisDeg: 45, tipDiameter: 0.5 }))).toEqual({
      kind: 'vbit', diameter: 6, angleFromAxisDeg: 45, tipDiameter: 0.5,
    });
    // No stored angle: the 59 deg the tool drawing uses.
    expect(toolToCutterSpec(makeTool('v_bit'))).toEqual({ kind: 'vbit', diameter: 6, angleFromAxisDeg: 59 });
  });
  it('fails loud on a V-bit it cannot model (no cone angle, tip flat as wide as the bit)', () => {
    expect(() => toolToCutterSpec(makeTool('v_bit', { angleFromAxisDeg: 90 }))).toThrow(UnsupportedCutterError);
    expect(() => toolToCutterSpec(makeTool('v_bit', { angleFromAxisDeg: 45, tipDiameter: 6 }))).toThrow(
      /tip flat/,
    );
  });
  it('fails loud (named error) on an unsupported cutter type', () => {
    expect(() => toolToCutterSpec(makeTool('drill'))).toThrow(UnsupportedCutterError);
    expect(() => toolToCutterSpec(makeTool('drill'))).toThrow(/does not yet support drill/);
  });
  it('fails loud on a bull-nose with no corner radius', () => {
    expect(() => toolToCutterSpec(makeTool('bull_nose'))).toThrow(/needs a positive cornerRadius/);
  });
});

describe('computeParallel3dMoves (headless compute path)', () => {
  for (const type of ['flat_end_mill', 'ball_end_mill'] as const) {
    it(`produces well-formed moves (${type})`, { timeout: 60_000 }, async () => {
      const { client } = makeClient();
      const partMesh = await acquirePartMesh({ format: 'stl', bytes: STL_BYTES }, PARAMS.tolerance);
      const { moves, computeTimeMs } = await computeParallel3dMoves({
        partMesh,
        tool: makeTool(type),
        params: PARAMS,
        resolvedHeights: HEIGHTS,
        boundary: BOUNDARY,
        client,
      });
      assertWellFormed(moves);
      expect(moves.some((m) => m.role === 'cut')).toBe(true);
      expect(computeTimeMs).toBeGreaterThanOrEqual(0);
      await client.dispose();
    });
  }

  it('is byte-stable across two runs (determinism, D-006)', { timeout: 60_000 }, async () => {
    const run = async (): Promise<ToolpathMove[]> => {
      const { client } = makeClient();
      // Fresh mesh each run: generateParallelFinish TRANSFERS (detaches) the buffers.
      const partMesh = await acquirePartMesh({ format: 'stl', bytes: STL_BYTES }, PARAMS.tolerance);
      const { moves } = await computeParallel3dMoves({
        partMesh,
        tool: makeTool('ball_end_mill'),
        params: PARAMS,
        resolvedHeights: HEIGHTS,
        boundary: BOUNDARY,
        client,
      });
      await client.dispose();
      return moves;
    };
    const a = await run();
    const b = await run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('uses the part xy-bounds when no boundary is given', { timeout: 60_000 }, async () => {
    const { client } = makeClient();
    const partMesh = await acquirePartMesh({ format: 'stl', bytes: STL_BYTES }, PARAMS.tolerance);
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: makeTool('flat_end_mill'),
      params: { ...PARAMS, useStockBoundary: false },
      resolvedHeights: HEIGHTS,
      boundary: undefined,
      client,
    });
    assertWellFormed(moves);
    await client.dispose();
  });
});
