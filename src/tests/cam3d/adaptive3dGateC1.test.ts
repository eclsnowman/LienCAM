// Gate C1 -- end-to-end automated gate for the adaptive_3d 3D-ROUGHER path,
// fully HEADLESS via vitest. Mirror of parallel3dGateM1.test.ts for the rougher.
//
// It drives the REAL compute pipeline (computeAdaptive3dMoves through an
// in-process Cam3dClient backed by a real BvhKernel -> the worker dispatcher ->
// strategies/adaptiveRough) and the REAL postprocessor (postProgram + GRBL
// dialect) + REAL g-code linter, across the two roughing torture fixtures
// (engagementPocket and hemisphereOnSlab), plus:
//   - determinism (two full generates -> identical move count + hash, D-006),
//   - a CPU-budget perf assertion (process.cpuUsage, not wall-clock).
//
// Fixtures are the procedural PartMeshes (engagementPocket / hemisphereOnSlab),
// uploaded directly -- no STEP tessellator, avoiding the headless OCCT gap the
// M1 gate had to work around for its STEP case.

import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { engagementPocket, hemisphereOnSlab } from '../../cam3d/fixtures';
import type { PartMesh } from '../../cam3d/kernel/types';
import {
  computeAdaptive3dMoves,
  stockBoundsFromMesh,
  DEFAULT_ADAPTIVE3D_PARAMS,
  type Adaptive3dParams,
} from '../../cam3d/integration/adaptive3dOperation';
import type { ResolvedParallel3dHeights } from '../../cam3d/integration/parallel3dOperation';
import type { Tool, ToolType, ToolpathMove } from '../../types';

// Real postprocessor + linter.
import { postProgram, GRBL_CONFIG } from '../../lib/post';
import type { PostInput, PostOperation } from '../../lib/post/types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve';
import { lintGcode } from '../../lib/gcode';
// Post-input fixture builders (imported, not edited).
import { makeTool, makeMachine, makeOp, makeWcs } from '../post/helpers';

// ---------------------------------------------------------------------------
// In-process Cam3dClient (client <-> dispatcher(real BvhKernel), sync post).
// Identical harness to parallel3dGateM1.test.ts / parallel3dAdapter.test.ts.
// ---------------------------------------------------------------------------
function makeClient(): Cam3dClient {
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
  return new Cam3dClient(fakeWorker);
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the M1 gate).
// ---------------------------------------------------------------------------
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
  }
}

/** Flat end mill: the rougher requires a flat or ball cutter. */
function camTool(type: ToolType): Tool {
  return makeTool({ id: `t-${type}`, name: `${type} d6`, type, diameter: 6, toolNumber: 1 });
}

/** Heights derived from a mesh AABB: clearance well above the surface. */
function heightsFor(mesh: PartMesh): ResolvedParallel3dHeights {
  const top = mesh.bounds.max[2];
  const bottom = mesh.bounds.min[2];
  return {
    clearanceZ: top + 10,
    retractZ: top + 2,
    feedZ: top + 2,
    topZ: top,
    bottomZ: bottom,
  };
}

/**
 * Feed generated ToolpathMove[] through the REAL postprocessor (GRBL dialect)
 * and REAL linter. Returns the emitted g-code and the error-level findings.
 */
function postAndLint(moves: ToolpathMove[]): {
  gcode: string;
  ok: boolean;
  errors: ReturnType<typeof lintGcode>;
} {
  const tool = makeTool({ id: 't1', name: 'Flat d6', type: 'flat_end_mill', diameter: 6, toolNumber: 1 });
  const machine = makeMachine();
  const op = makeOp({
    id: 'op1',
    name: 'Adaptive 3D Rough',
    type: 'adaptive_3d',
    toolId: 't1',
    status: 'ready',
    toolpathMoves: moves,
  });
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  };
  const input: PostInput = { machine, setup: { wcs: makeWcs(), operations: [postOp] } };
  const res = postProgram(input, GRBL_CONFIG);
  const findings = lintGcode(res.gcode, { commentStyle: GRBL_CONFIG.capabilities.comment });
  return { gcode: res.gcode, ok: res.ok, errors: findings.filter((f) => f.level === 'error') };
}

/** Stable FNV-1a hash over moves at 1e-6 rounding (determinism tripwire). */
function hashMoves(moves: ToolpathMove[]): string {
  let h = 0x811c9dc5 >>> 0;
  const push = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const q = (v: number): string => String(Math.round(v * 1e6) / 1e6);
  for (const m of moves) {
    push(m.type); push('|'); push(m.role ?? '-'); push('|');
    push(q(m.x)); push(','); push(q(m.y)); push(','); push(q(m.z)); push(',');
    push(q(m.cx ?? 0)); push(','); push(q(m.cy ?? 0)); push(','); push(q(m.feed ?? 0));
    push(';');
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// Roughing params: coarse-ish for a fast, deterministic gate. stepover is a
// FRACTION of tool diameter (the engagement knob); cellSize 0 -> auto.
const BASE_PARAMS: Adaptive3dParams = {
  ...DEFAULT_ADAPTIVE3D_PARAMS,
  maxStepdown: 3,
  stepover: 0.4,
  tolerance: 0.2,
  helixDiameter: 3,
};

async function roughFixture(mesh: PartMesh): Promise<{ moves: ToolpathMove[]; computeTimeMs: number }> {
  const client = makeClient();
  try {
    return await computeAdaptive3dMoves({
      partMesh: mesh,
      tool: camTool('flat_end_mill'),
      params: BASE_PARAMS,
      stockBounds: stockBoundsFromMesh(mesh),
      stockBoundsAreRealStock: true,
      resolvedHeights: heightsFor(mesh),
      client,
    });
  } finally {
    await client.dispose();
  }
}

// ===========================================================================
// 1. Generate -> preview-ready moves -> lint-clean g-code, per fixture.
// ===========================================================================
describe('adaptive_3d gate: generate -> preview-ready moves -> lint-clean g-code', () => {
  it('engagementPocket (H-pocket + island torture fixture)', { timeout: 180_000 }, async () => {
    const mesh = engagementPocket();
    const { moves, computeTimeMs } = await roughFixture(mesh);
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);
    expect(
      moves.some((m) => m.type === 'rapid' && m.z < heightsFor(mesh).clearanceZ - 1e-6),
      'resolved real stock must preserve at least one proven low Stay Down rapid',
    ).toBe(true);
    expect(computeTimeMs).toBeGreaterThanOrEqual(0);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.gcode.length).toBeGreaterThan(0);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate C1] engagementPocket: ${moves.length} moves -> lint clean`);
  });

  it('hemisphereOnSlab (dome-on-slab boss)', { timeout: 180_000 }, async () => {
    const { moves } = await roughFixture(hemisphereOnSlab(20, { x: 100, y: 100, t: 10 }));
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate C1] hemisphereOnSlab: ${moves.length} moves -> lint clean`);
  });
});

// ===========================================================================
// 2. Determinism (D-006): two full generates -> identical count + hash.
// ===========================================================================
describe('adaptive_3d gate: determinism (D-006)', () => {
  it('is byte-identical across two full generates (engagementPocket)', { timeout: 180_000 }, async () => {
    const a = (await roughFixture(engagementPocket())).moves;
    const b = (await roughFixture(engagementPocket())).moves;
    expect(b.length).toBe(a.length);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(hashMoves(b)).toBe(hashMoves(a));
    // eslint-disable-next-line no-console
    console.log(`[gate C1] determinism: ${a.length} moves, hash=${hashMoves(a)}`);
  });
});

// ===========================================================================
// 3. Perf / responsiveness -- CPU budget (process.cpuUsage), never wall-clock.
// ===========================================================================
describe('adaptive_3d gate: CPU budget (responsiveness stand-in)', () => {
  it('engagementPocket rough completes within the CPU budget', { timeout: 300_000 }, async () => {
    const cpu0 = process.cpuUsage();
    const { moves } = await roughFixture(engagementPocket());
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    // eslint-disable-next-line no-console
    console.log(`[gate C1] perf: cpu ${cpuMs.toFixed(0)} ms, ${moves.length} moves`);
    // Generous budget with healthy margin over the measured run.
    const CPU_BUDGET_MS = 30_000;
    expect(cpuMs).toBeLessThan(CPU_BUDGET_MS);
  });
});
