// Gate P3 / Milestone M1 -- end-to-end automated gate for the parallel_3d
// 3D-finish path, fully HEADLESS via vitest.
//
// The parallel_3d finish strategy is already built and app-proven; this file is
// the regression gate around it. It drives the REAL compute pipeline
// (acquirePartMesh / importStepToPartMesh -> computeParallel3dMoves through an
// in-process Cam3dClient backed by a real BvhKernel) and the REAL postprocessor
// (postProgram + GRBL dialect) + REAL g-code linter, across FOUR fixtures
// (wave, hemisphere, a real STL, a STEP), plus:
//   - a determinism snapshot (inline hash tripwire, D-006),
//   - a CPU-budget perf assertion (process.cpuUsage, not wall-clock),
//   - the STL-vs-STEP SAME-PART IR comparison (the M1 signature test).
//
// Skip discipline (D-015): fixtures resolved IN PLACE via resolveSamplePartPath;
// a missing file skips the case with a clear message rather than failing.
//
// NOTE on responsiveness: real-app UI responsiveness was already proven by
// driving the app. The CPU-budget assertion here is the headless stand-in.
//
// NOTE on acquirePartMesh for STEP: acquirePartMesh's STEP branch uses the
// browser model-worker tessellator by default, which is unavailable in Node.
// So the STEP cases import via importStepToPartMesh with an injected OCCT-core
// tessellator (exactly what inputStep.test.ts does); the resulting PartMesh is
// identical to what the store's acquirePartMesh produces in the browser. The
// STL cases use acquirePartMesh directly (the STL parser is pure).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { wave, hemisphereOnSlab } from '../../cam3d/fixtures';
import type { PartMesh } from '../../cam3d/kernel/types';
import {
  computeParallel3dMoves,
  acquirePartMesh,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';
import {
  importStepToPartMesh,
  makeOcctCoreTessellator,
  type StepTessellator,
} from '../../cam3d/input';
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from '../../lib/cam/geometry/occt/model/loader';
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';
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
// OCCT model kernel (Node): same headless harness as inputStep.test.ts.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */
const wasmPath = join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm');

let occtTessellator: StepTessellator;

beforeAll(async () => {
  _resetOcctModelForTest();
  const oc: OcctModelModule = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  occtTessellator = makeOcctCoreTessellator(oc);
}, 120_000);

// ---------------------------------------------------------------------------
// In-process Cam3dClient (client <-> dispatcher(real BvhKernel), sync post).
// Mirrors parallel3dAdapter.test.ts.
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
// Shared helpers.
// ---------------------------------------------------------------------------
const VALID_TYPES = new Set(['rapid', 'feed', 'arc_cw', 'arc_ccw']);
const VALID_ROLES = new Set([
  'rapid', 'cut', 'helix', 'ramp', 'plunge', 'stepover', 'fast_traverse',
  'lead_in', 'lead_out', 'loop_back', 'wall_follow', 'finish',
]);

/** "preview-ready" invariants: the viewport renders moves by type + role. */
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
 * and REAL linter. Returns the emitted g-code and the error-level lint findings.
 * Uses postProgram (validate -> emit), so this exercises the production emit
 * pipeline (arc-fit, framing, spindle/coolant, program end).
 */
function postAndLint(moves: ToolpathMove[]): {
  gcode: string;
  ok: boolean;
  errors: ReturnType<typeof lintGcode>;
} {
  const tool = makeTool({ id: 't1', name: 'Ball d6', type: 'ball_end_mill', diameter: 6, toolNumber: 1 });
  const machine = makeMachine();
  const op = makeOp({
    id: 'op1',
    name: 'Parallel 3D Finish',
    type: 'parallel_3d',
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
    push(m.type);
    push('|');
    push(m.role ?? '-');
    push('|');
    push(q(m.x)); push(','); push(q(m.y)); push(','); push(q(m.z)); push(',');
    push(q(m.cx ?? 0)); push(','); push(q(m.cy ?? 0)); push(','); push(q(m.feed ?? 0));
    push(';');
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/** Maximal runs of consecutive cut-role moves (one run per raster pass). */
function cutRuns(moves: ToolpathMove[]): ToolpathMove[][] {
  const runs: ToolpathMove[][] = [];
  let cur: ToolpathMove[] | null = null;
  for (const m of moves) {
    if (m.role === 'cut') {
      if (cur === null) { cur = []; runs.push(cur); }
      cur.push(m);
    } else {
      cur = null;
    }
  }
  return runs;
}

/** True if a Sample Parts fixture is present (probe both working copies). */
function hasFixture(name: string): boolean {
  try {
    resolveSamplePartPath(name);
    return true;
  } catch {
    return false;
  }
}

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(resolveSamplePartPath(name));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** Encode a PartMesh (positions+indices) as binary STL bytes -> drives the REAL
 *  STL binary parser on the same geometry a different way. */
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

const BASE_PARAMS: Parallel3dParams = {
  stepover: 2,
  angleDeg: 0,
  tolerance: 0.05,
  useStockBoundary: false,
};

// ===========================================================================
// 1. Generate -> export, per fixture (wave, hemisphere, real STL, STEP)
// ===========================================================================
describe('parallel_3d gate: generate -> preview-ready moves -> lint-clean g-code', () => {
  it('wave (procedural analytic)', { timeout: 120_000 }, async () => {
    const client = makeClient();
    const partMesh = wave(60, 81); // ~12.8k tris, fast
    const { moves, computeTimeMs } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: BASE_PARAMS,
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);
    expect(computeTimeMs).toBeGreaterThanOrEqual(0);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.gcode.length).toBeGreaterThan(0);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate] wave: ${moves.length} moves, ${cutRuns(moves).length} passes -> lint clean`);
    await client.dispose();
  });

  it('hemisphere-on-slab (procedural analytic)', { timeout: 120_000 }, async () => {
    const client = makeClient();
    const partMesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: BASE_PARAMS,
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate] hemisphere: ${moves.length} moves, ${cutRuns(moves).length} passes -> lint clean`);
    await client.dispose();
  });

  const STL_NAME = 'obj_1_Platte C.stl';
  it.skipIf(!hasFixture(STL_NAME))(`real STL (${STL_NAME})`, { timeout: 180_000 }, async () => {
    const client = makeClient();
    // acquirePartMesh drives the REAL STL binary parser (pure, headless-safe).
    const partMesh = await acquirePartMesh({ format: 'stl', bytes: fixtureBytes(STL_NAME) }, 0.1);
    expect(partMesh.source).toBe('stl');
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: { ...BASE_PARAMS, tolerance: 0.1 }, // coarser: real plate, keep fast
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate] STL ${STL_NAME}: ${moves.length} moves, ${cutRuns(moves).length} passes -> lint clean`);
    await client.dispose();
  });

  const STEP_NAME = 'fix_freeform.step';
  it.skipIf(!hasFixture(STEP_NAME))(`STEP (${STEP_NAME})`, { timeout: 240_000 }, async () => {
    const client = makeClient();
    // STEP tessellation via injected OCCT-core tessellator (see file header).
    const r = await importStepToPartMesh(fixtureBytes(STEP_NAME), {
      camTolerance: 0.1, // -> 0.025 mm deflection: modest mesh, keeps the gate fast
      tessellator: occtTessellator,
    });
    const partMesh = r.mesh;
    expect(partMesh.source).toBe('step');
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: { ...BASE_PARAMS, tolerance: 0.1 },
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    assertWellFormed(moves);
    expect(moves.some((m) => m.role === 'cut')).toBe(true);

    const post = postAndLint(moves);
    expect(post.ok).toBe(true);
    expect(post.errors, JSON.stringify(post.errors)).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(`[gate] STEP ${STEP_NAME}: ${moves.length} moves, ${cutRuns(moves).length} passes -> lint clean`);
    await client.dispose();
  });
});

// ===========================================================================
// 2. Determinism snapshot (D-006) -- inline hash tripwire on the WAVE fixture.
// ===========================================================================
describe('parallel_3d gate: determinism (D-006)', () => {
  // Inline expected values captured from a clean run; a change to strategy
  // output flips these -> the regression tripwire. Recompute intentionally only.
  // Re-pinned 2026-08-19 (WO-403) from '2d7e2ccc': the 1962cecd pathbuild
  // contract makes the retract entry's descent a RAPID to Feed Height instead
  // of a feed 'plunge' to retractZ. Same 1951 moves, one move's type/role
  // differs per entry (the wave has one); every cut / lead_in / stepover is
  // unchanged (strategyParallel's snapshot shows the identical diff in full).
  // The role histogram below is asserted so the next hash move names itself.
  //
  // WO-1271 (2026-09-08): the DEFAULT toolpath now carries the stock-edge
  // overrun (auto = tool radius), so the default pin moved. The pre-WO-1271
  // pin is NOT discarded: it is asserted below under `stockEdgeOvershoot: 0`,
  // which is the legacy path and must stay byte-identical. Side by side:
  //   before   default            hash 7c6c5d4b  1951 moves  rapid 3 / lead_in 28 / cut 1870 / stepover 50
  //   after    overrun 0          hash 7c6c5d4b  1951 moves  (unchanged, same roles)
  //   after    default (auto)     hash 9ea9f5f5  2375 moves  rapid 6 / lead_in 50 / cut 2266 / stepover 53
  //
  // WO-1615 (2026-09-16): pass chords are refined where the straight chord leaves tolerance (a crease or a
  // cliff), because the chord drove the ball into walls. The wave has real creases (curvature radius 1.63 mm
  // under a 3 mm ball; main was 4x out of tolerance), so both pins moved: overrun 0 7c6c5d4b/1951 ->
  // 0c9e1c5c/2960, default 9ea9f5f5/2375 -> f9d5a449/3881. Stepovers and rapids unchanged; only cut and
  // lead_in points were inserted.
  //
  // WO-2209 (2026-09-29): every Feed Height entry now ramps back onto the pass START and the pass is cut
  // whole (the old ramp rode above the start of the pass and cutting began at touchdown). Both pins moved:
  // overrun 0 0c9e1c5c/2960 -> 6f2c55c8/3017, default f9d5a449/3881 -> 7d6694b5/4043. Rapids and stepovers
  // unchanged; cut gained exactly the samples the old ramps skipped, lead_in is the longer reverse ramp.
  //
  // WO-2405 (2026-10-02): a stay-down link never feeds below the lowest z any pass cuts. Default
  // 7d6694b5 -> bad3d35f, same 4043 moves and roles: three interior link points in the overrun band
  // (x 52.99, y 15/19/35) rise from z 5.00523 to 5.00787 (+0.0026 mm, the lowest pass sample).
  // Overrun 0 is untouched.
  const LEGACY_WAVE_HASH = '6f2c55c8';
  const LEGACY_WAVE_COUNT = 3017;
  const LEGACY_WAVE_ROLES = { rapid: 3, lead_in: 57, cut: 2907, stepover: 50 };
  const EXPECTED_WAVE_HASH = 'bad3d35f';
  const EXPECTED_WAVE_COUNT = 4043;
  const EXPECTED_WAVE_ROLES = { rapid: 6, lead_in: 162, cut: 3822, stepover: 53 };

  async function genWaveMoves(overrides: { stockEdgeOvershoot?: number } = {}): Promise<ToolpathMove[]> {
    const client = makeClient();
    const partMesh = wave(50, 61); // deterministic; wave() is pure
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: { stepover: 2, angleDeg: 0, tolerance: 0.02, useStockBoundary: false, ...overrides },
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    await client.dispose();
    return moves;
  }

  it('is byte-identical across two full generates', { timeout: 120_000 }, async () => {
    const a = await genWaveMoves();
    const b = await genWaveMoves();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(hashMoves(b)).toBe(hashMoves(a));
  });

  it('with the stock-edge overrun off, matches the pre-WO-1271 snapshot hash (the legacy path is byte-identical)', { timeout: 120_000 }, async () => {
    const moves = await genWaveMoves({ stockEdgeOvershoot: 0 });
    const hash = hashMoves(moves);
    // eslint-disable-next-line no-console
    console.log(`[gate] determinism snapshot (overrun 0): hash=${hash}, count=${moves.length}`);
    const roles: Record<string, number> = {};
    for (const mv of moves) roles[String(mv.role)] = (roles[String(mv.role)] ?? 0) + 1;
    expect(roles).toEqual(LEGACY_WAVE_ROLES);
    expect(hash).toBe(LEGACY_WAVE_HASH);
    expect(moves.length).toBe(LEGACY_WAVE_COUNT);
  });

  it('matches the committed snapshot hash (tripwire)', { timeout: 120_000 }, async () => {
    const moves = await genWaveMoves();
    const hash = hashMoves(moves);
    // eslint-disable-next-line no-console
    console.log(`[gate] determinism snapshot: hash=${hash}, count=${moves.length}`);
    const roles: Record<string, number> = {};
    for (const mv of moves) roles[String(mv.role)] = (roles[String(mv.role)] ?? 0) + 1;
    expect(roles).toEqual(EXPECTED_WAVE_ROLES);
    expect(hash).toBe(EXPECTED_WAVE_HASH);
    expect(moves.length).toBe(EXPECTED_WAVE_COUNT);
  });
});

// ===========================================================================
// 3. Perf / responsiveness -- CPU budget (process.cpuUsage), never wall-clock.
//    Stands in for "UI stays responsive" headlessly (app responsiveness was
//    already proven by driving the app).
// ===========================================================================
describe('parallel_3d gate: CPU budget (responsiveness stand-in)', () => {
  it('wave ~200k tris, stepover 1 completes within the CPU budget', { timeout: 300_000 }, async () => {
    const client = makeClient();
    const partMesh = wave(100, 317); // ~200k tris (OCL-CAPABILITIES benchmark size)
    const cpu0 = process.cpuUsage();
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: camTool('ball_end_mill'),
      params: { stepover: 1, angleDeg: 0, tolerance: 0.01, useStockBoundary: false },
      resolvedHeights: heightsFor(partMesh),
      client,
    });
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const passes = cutRuns(moves).length;
    // eslint-disable-next-line no-console
    console.log(`[gate] perf: cpu ${cpuMs.toFixed(0)} ms, ${passes} passes, ${moves.length} moves`);
    expect(passes).toBeGreaterThanOrEqual(95); // ~100 passes over 100 mm at stepover 1
    // Generous budget with healthy margin over the measured run (~450 ms here;
    // matches the strategy-level perf smoke's 8 s budget for this same workload).
    const CPU_BUDGET_MS = 8_000;
    expect(cpuMs).toBeLessThan(CPU_BUDGET_MS);
    await client.dispose();
  });
});

// ===========================================================================
// 4. STL-vs-STEP SAME-PART IR comparison (the M1 signature test).
//    Proves STL and STEP are indistinguishable downstream of PartMesh: ONE part
//    imported through BOTH code paths (STL binary parser vs STEP tessellation)
//    at DIFFERENT tessellations, same strategy+params, agree within tessellation
//    tolerance.
//    Path used here: FALLBACK (see digest). The STEP is tessellated at the CAM
//    tolerance for the STEP side; a COARSER tessellation of the SAME solid is
//    re-encoded to binary STL and imported via the STL path. Both import code
//    paths run on the same geometry at different deflections -- the point of the
//    test. (An independent-CAD-export STL via the OCP toolchain is a follow-up.)
// ===========================================================================
describe('parallel_3d gate: STL-vs-STEP same-part IR agreement (M1 signature)', () => {
  const PART = 'fix_fillet_box.step'; // box 40x30x15, top edges R4

  it.skipIf(!hasFixture(PART))(
    'STL and STEP of the same solid agree within tessellation tolerance',
    { timeout: 300_000 },
    async () => {
      const bytes = fixtureBytes(PART);

      // STEP side: CAM-tolerance tessellation (fine).
      const CAM_TOL = 0.05; // -> 0.0125 mm deflection
      const stepMesh = (await importStepToPartMesh(bytes, {
        camTolerance: CAM_TOL,
        tessellator: occtTessellator,
      })).mesh;

      // STL side: COARSER tessellation of the SAME solid, re-encoded as binary
      // STL and imported through the REAL STL parser.
      const COARSE_TOL = 0.4; // -> 0.1 mm deflection (8x coarser)
      const coarseDeflection = COARSE_TOL / 4;
      const coarseMesh = (await importStepToPartMesh(bytes, {
        camTolerance: COARSE_TOL,
        tessellator: occtTessellator,
      })).mesh;
      const stlMesh = await acquirePartMesh(
        { format: 'stl', bytes: meshToBinaryStl(coarseMesh) },
        CAM_TOL,
      );
      expect(stlMesh.source).toBe('stl');
      expect(stepMesh.source).toBe('step');

      const params: Parallel3dParams = { stepover: 2, angleDeg: 0, tolerance: CAM_TOL, useStockBoundary: false };
      const tool = camTool('ball_end_mill');

      const run = async (partMesh: PartMesh): Promise<ToolpathMove[]> => {
        const client = makeClient();
        const { moves } = await computeParallel3dMoves({
          partMesh,
          tool,
          params,
          resolvedHeights: heightsFor(partMesh),
          client,
        });
        await client.dispose();
        return moves;
      };

      const stepMoves = await run(stepMesh);
      const stlMoves = await run(stlMesh);

      // Structure: identical role vocabulary + same pass count (passes come from
      // xy-bounds + stepover, independent of tessellation).
      const stepRuns = cutRuns(stepMoves);
      const stlRuns = cutRuns(stlMoves);
      expect(stlRuns.length).toBe(stepRuns.length);
      const roleSet = (ms: ToolpathMove[]): Set<string> =>
        new Set(ms.map((m) => m.role ?? '-'));
      expect([...roleSet(stlMoves)].sort()).toEqual([...roleSet(stepMoves)].sort());

      // Move-count agreement within a small delta (adaptive sampling differs a
      // little between tessellations).
      const countDelta = Math.abs(stlMoves.length - stepMoves.length);
      const countRel = countDelta / stepMoves.length;
      expect(countRel).toBeLessThan(0.25);

      // Per-sample z agreement over the overlapping region: for each matching
      // pass (same y, same zigzag index) interpolate the coarse pass z at the
      // fine pass's x samples and take the max |dz|. Bound ~ tessellation-driven.
      let maxDz = 0;
      const n = Math.min(stepRuns.length, stlRuns.length);
      for (let i = 0; i < n; i++) {
        maxDz = Math.max(maxDz, maxZDiffAlongPass(stepRuns[i], stlRuns[i]));
      }
      const Z_TOL = coarseDeflection * 3; // ~2x coarse deflection + margin = 0.3 mm
      // eslint-disable-next-line no-console
      console.log(
        `[gate] same-part STL-vs-STEP: step ${stepMoves.length} moves / ${stepRuns.length} passes, ` +
          `stl ${stlMoves.length} moves / ${stlRuns.length} passes, countRel ${(countRel * 100).toFixed(1)}%, ` +
          `maxDz ${maxDz.toFixed(4)} mm (tol ${Z_TOL.toFixed(4)}, coarse deflection ${coarseDeflection} mm)`,
      );
      expect(maxDz).toBeLessThan(Z_TOL);
    },
  );
});

/**
 * Max |dz| between two raster passes (same nominal y) via piecewise-linear
 * interpolation of pass B's z at pass A's x samples, over the overlapping
 * x-range. Each pass is sorted by x first (zigzag reverses alternate passes).
 */
function maxZDiffAlongPass(a: ToolpathMove[], b: ToolpathMove[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = [...a].sort((p, q) => p.x - q.x);
  const B = [...b].sort((p, q) => p.x - q.x);
  const bMinX = B[0].x;
  const bMaxX = B[B.length - 1].x;
  let max = 0;
  for (const pa of A) {
    if (pa.x < bMinX || pa.x > bMaxX) continue; // outside overlap
    const zb = interpZ(B, pa.x);
    max = Math.max(max, Math.abs(pa.z - zb));
  }
  return max;
}

/** Linear interpolation of z at x along a by-x-sorted polyline. */
function interpZ(pts: ToolpathMove[], x: number): number {
  // Binary search for the segment containing x.
  let lo = 0;
  let hi = pts.length - 1;
  if (x <= pts[lo].x) return pts[lo].z;
  if (x >= pts[hi].x) return pts[hi].z;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const x0 = pts[lo].x;
  const x1 = pts[hi].x;
  if (x1 === x0) return pts[lo].z;
  const t = (x - x0) / (x1 - x0);
  return pts[lo].z + t * (pts[hi].z - pts[lo].z);
}
