// cam3d ParallelFinishStrategy tests -- the headless half of Gate P3:
// surface fidelity (byte-equal vs dropPoints + analytic hemisphere truth),
// no-gouge links, boundary containment/clipping, zigzag order and spacing,
// determinism snapshot, exact-angle frames, and a CPU-time perf smoke.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterHandle, MeshHandle } from '../../cam3d/kernel/types';
import { hemisphereOnSlab, wave } from '../../cam3d/fixtures';
import { parallelFinish, type ParallelFinishInput } from '../../cam3d/strategies/parallel';
import { irFingerprint } from '../../cam3d/ir/types';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';

const BALL6 = { kind: 'ball', diameter: 6 } as const;
const R = 3;

// One kernel for the whole file; fixture meshes uploaded lazily and shared.
const kernel = new BvhKernel();
const handles = new Map<string, MeshHandle>();
function meshHandle(name: 'wave317' | 'wave121' | 'wave65' | 'hemi'): MeshHandle {
  let h = handles.get(name);
  if (h === undefined) {
    const mesh =
      name === 'wave317' ? wave(100, 317)
      : name === 'wave121' ? wave(100, 121)
      : name === 'wave65' ? wave(20, 65)
      : hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    h = kernel.uploadMesh(mesh);
    handles.set(name, h);
  }
  return h;
}

function xyBoundsOf(size: number): { minX: number; minY: number; maxX: number; maxY: number } {
  return { minX: 0, minY: 0, maxX: size, maxY: size };
}

/** Maximal runs of consecutive cut-role moves (one run per pass). */
function cutRuns(moves: readonly IrMove[]): IrMove[][] {
  const runs: IrMove[][] = [];
  let cur: IrMove[] | null = null;
  for (const m of moves) {
    if (m.role === 'cut') {
      if (cur === null) {
        cur = [];
        runs.push(cur);
      }
      cur.push(m);
    } else {
      cur = null;
    }
  }
  return runs;
}

/** Re-drop a move subset's xy through dropPoints (independent call). */
async function redrop(
  m: MeshHandle,
  c: CutterHandle,
  moves: readonly IrMove[],
  zSeed: number,
): Promise<Float64Array> {
  const xy = new Float64Array(moves.length * 2);
  for (let i = 0; i < moves.length; i++) {
    xy[2 * i] = moves[i].x;
    xy[2 * i + 1] = moves[i].y;
  }
  return kernel.dropPoints(m, c, xy, zSeed);
}

async function withBall<T>(_m: MeshHandle, fn: (c: CutterHandle) => Promise<T>): Promise<T> {
  const c = kernel.makeCutter(BALL6);
  try {
    return await fn(c);
  } finally {
    kernel.releaseCutter(c);
  }
}

/** Fidelity + no-gouge checks shared by several fixtures.
 *  Rapids (WO-403, the 1962cecd pathbuild contract): lateral rapids run at
 *  the traverse plane (clearanceZ here - no material top is proven), and the
 *  ONE downward rapid of a retract entry stops exactly at Feed Height, over
 *  the pass start it descends onto (same XY as the traverse rapid before it);
 *  before 1962cecd that descent was a feed 'plunge' to retractZ. */
async function assertFidelityAndNoGouge(
  m: MeshHandle,
  ir: ToolpathIR,
  zSeed: number,
  clearanceZ: number,
  feedZ: number,
): Promise<{ cutCount: number; maxLinkClearance: number }> {
  return withBall(m, async (c) => {
    const cuts = ir.moves.filter((mv) => mv.role === 'cut');
    expect(cuts.length).toBeGreaterThan(0);
    const zc = await redrop(m, c, cuts, zSeed);
    for (let i = 0; i < cuts.length; i++) {
      if (!Object.is(cuts[i].z, zc[i])) {
        throw new Error(
          `cut fidelity: move at (${cuts[i].x}, ${cuts[i].y}) z=${cuts[i].z} != drop ${zc[i]}`,
        );
      }
    }
    const others = ir.moves.filter((mv) => mv.role !== 'cut');
    const zo = await redrop(m, c, others, zSeed);
    let maxClear = 0;
    for (let i = 0; i < others.length; i++) {
      const mv = others[i];
      expect(mv.z).toBeGreaterThanOrEqual(zo[i] - 1e-6); // no gouge, any role
      if (mv.t === 'rapid') {
        if (mv.z !== clearanceZ) {
          // The entry descent: exactly Feed Height, straight down over the pass start.
          expect(mv.z).toBe(feedZ);
          const k = ir.moves.indexOf(mv);
          expect(k).toBeGreaterThan(0);
          expect(ir.moves[k - 1].t).toBe('rapid');
          expect(ir.moves[k - 1].x).toBe(mv.x);
          expect(ir.moves[k - 1].y).toBe(mv.y);
        }
      }
      maxClear = Math.max(maxClear, mv.z - zo[i]);
    }
    return { cutCount: cuts.length, maxLinkClearance: maxClear };
  });
}

// ---------------------------------------------------------------------------
// 1. Wave 200k: fidelity, links, zigzag, determinism snapshot
// ---------------------------------------------------------------------------

describe('parallelFinish on wave(100, 317)', () => {
  const input: ParallelFinishInput = {
    mesh: 0 as MeshHandle, // patched per call (handle known lazily)
    cutter: BALL6,
    stepover: 2,
    angleDeg: 0,
    tolerance: 0.01,
    xyBounds: xyBoundsOf(100),
    heights: { clearanceZ: 25, retractZ: 16, feedZ: 16 },
    zSeed: 0,
  };

  it(
    'cut z is byte-equal to dropPoints; links never gouge; rapids at clearance',
    { timeout: 120_000 },
    async () => {
      const m = meshHandle('wave317');
      const ir = await parallelFinish(kernel, { ...input, mesh: m });
      const { cutCount } = await assertFidelityAndNoGouge(m, ir, 0, 25, 16);
      console.log(`wave fidelity: ${cutCount} cut points byte-equal to dropPoints`);
    },
  );

  it('zigzag: consecutive passes alternate direction at exact stepover spacing', { timeout: 120_000 }, async () => {
    const m = meshHandle('wave317');
    const ir = await parallelFinish(kernel, { ...input, mesh: m });
    const runs = cutRuns(ir.moves);
    expect(runs).toHaveLength(51); // 0..100 at stepover 2
    for (let k = 0; k < runs.length; k++) {
      const run = runs[k];
      const y = run[0].y;
      for (const mv of run) expect(mv.y).toBe(y); // angle 0: passes exactly axis-aligned
      if (k > 0) expect(y - runs[k - 1][0].y).toBe(2); // spacing exactly stepover
      const dx = run[run.length - 1].x - run[0].x;
      expect(Math.sign(dx)).toBe(k % 2 === 0 ? 1 : -1); // alternate direction
    }
  });

  it('determinism: byte-stable IR snapshot (ball d6, stepover 2, angle 0, tol 0.01)', { timeout: 120_000 }, async () => {
    const m = meshHandle('wave317');
    const a = await parallelFinish(kernel, { ...input, mesh: m });
    const b = await parallelFinish(kernel, { ...input, mesh: m });
    const fpA = irFingerprint(a);
    const fpB = irFingerprint(b);
    expect(fpB).toBe(fpA); // run-to-run byte stability (canonical 1e-6 hash)
    expect(JSON.stringify(b.moves)).toBe(JSON.stringify(a.moves)); // full-precision identity
    const roleCounts: Record<string, number> = {};
    for (const mv of a.moves) {
      const role = mv.role ?? 'none';
      roleCounts[role] = (roleCounts[role] ?? 0) + 1;
    }
    console.log(`wave snapshot: fingerprint ${fpA}, ${a.moves.length} moves`, roleCounts);
    expect({
      fingerprint: fpA,
      moveCount: a.moves.length,
      roleCounts,
      meta: a.meta,
      firstMoves: a.moves.slice(0, 3),
      lastMove: a.moves[a.moves.length - 1],
    }).toMatchSnapshot('wave-ball6-so2-a0-tol001');
  });
});

// ---------------------------------------------------------------------------
// 2. Hemisphere-on-slab: analytic ball-drop truth on the dome cap
// ---------------------------------------------------------------------------

describe('parallelFinish on hemisphereOnSlab (analytic dome truth)', () => {
  const r = 20;
  const cx = 50;
  const cy = 50;
  const domeCz = 10; // dome center sits on the slab top
  // Feed Height must clear everything the pass cuts (pathbuild refuses a pass
  // that reaches above feedZ: "feed transition is below the cut"). The dome
  // apex is at 30; a fixture feed plane of 12 was authored INSIDE the target -
  // in the product the smart-height resolver derives Feed from the top height,
  // never below the surface. Verdict WO-403: fixture, not resolver.
  const HEMI_FEED_Z = domeCz + r + 1;

  /**
   * Tessellation deviation of the DOME: r minus the min distance from the
   * dome center to any cap facet plane (same bound-derivation approach as
   * the sphere-truth test in bvhKernel.test.ts). The mesh solid contains
   * the inscribed sphere, drop is monotone under geometry inclusion, so the
   * drop can sit below the analytic value by at most sagitta * amplification.
   */
  function domeSagitta(): number {
    const mesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    const pos = mesh.positions;
    const idx = mesh.indices;
    let rIn = Infinity;
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t] * 3;
      const ib = idx[t + 1] * 3;
      const ic = idx[t + 2] * 3;
      // Cap facets only: all three vertices clearly above the slab top.
      if (pos[ia + 2] < 11 || pos[ib + 2] < 11 || pos[ic + 2] < 11) continue;
      const ux = pos[ib] - pos[ia];
      const uy = pos[ib + 1] - pos[ia + 1];
      const uz = pos[ib + 2] - pos[ia + 2];
      const vx = pos[ic] - pos[ia];
      const vy = pos[ic + 1] - pos[ia + 1];
      const vz = pos[ic + 2] - pos[ia + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const nlen = Math.hypot(nx, ny, nz);
      if (nlen === 0) continue;
      const dist =
        Math.abs(nx * (pos[ia] - cx) + ny * (pos[ia + 1] - cy) + nz * (pos[ia + 2] - domeCz)) /
        nlen;
      if (dist < rIn) rIn = dist;
    }
    return r - rIn;
  }

  it(
    'ball d6 cut points on the cap match the sphere-on-sphere formula',
    { timeout: 120_000 },
    async () => {
      const m = meshHandle('hemi');
      const ir = await parallelFinish(kernel, {
        mesh: m,
        cutter: BALL6,
        stepover: 2,
        angleDeg: 0,
        tolerance: 0.01,
        xyBounds: xyBoundsOf(100),
        heights: { clearanceZ: 40, retractZ: HEMI_FEED_Z, feedZ: HEMI_FEED_Z },
        zSeed: 0,
      });
      // Byte-equal fidelity + no-gouge on this fixture too.
      await assertFidelityAndNoGouge(m, ir, 0, 40, HEMI_FEED_Z);

      const sagitta = domeSagitta();
      expect(sagitta).toBeGreaterThan(0);
      expect(sagitta).toBeLessThan(0.2); // sanity on the derivation itself
      const quant = 2 ** -23 * (cx + r) * 4;
      const capR = 0.6 * (r + R); // stay clearly on the dome, away from the rim
      let n = 0;
      let maxErr = 0;
      for (const mv of ir.moves) {
        if (mv.role !== 'cut') continue;
        const d = Math.hypot(mv.x - cx, mv.y - cy);
        if (d > capR) continue;
        const analytic = domeCz + Math.sqrt((r + R) ** 2 - d * d) - R;
        const amp = (r + R) / Math.sqrt((r + R) ** 2 - d * d);
        const tol = sagitta * amp * 1.5 + 1e-6;
        expect(mv.z).toBeLessThanOrEqual(analytic + quant);
        expect(mv.z).toBeGreaterThanOrEqual(analytic - tol);
        maxErr = Math.max(maxErr, Math.abs(mv.z - analytic));
        n++;
      }
      expect(n).toBeGreaterThan(100); // the cap region must actually be sampled
      console.log(
        `hemisphere cap: ${n} cut points, max |err| = ${maxErr.toExponential(3)} ` +
          `(sagitta ${sagitta.toExponential(3)})`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Containment: circular boundary clips passes, never drops them wholesale
// ---------------------------------------------------------------------------

describe('circular boundary containment', () => {
  it('clips crossing passes and keeps every cut point inside the ring', { timeout: 120_000 }, async () => {
    const m = meshHandle('wave121');
    const bR = 30;
    const nB = 128;
    const ring = new Float64Array(nB * 2);
    for (let k = 0; k < nB; k++) {
      const a = (2 * Math.PI * k) / nB; // CCW outer
      ring[2 * k] = 50 + bR * Math.cos(a);
      ring[2 * k + 1] = 50 + bR * Math.sin(a);
    }
    const ir = await parallelFinish(kernel, {
      mesh: m,
      cutter: BALL6,
      stepover: 5,
      angleDeg: 0,
      tolerance: 0.01,
      boundary: [ring],
      heights: { clearanceZ: 25, retractZ: 16, feedZ: 16 },
      zSeed: 0,
    });
    // No cut point outside the boundary circle (+ tiny epsilon).
    for (const mv of ir.moves) {
      if (mv.role !== 'cut') continue;
      expect(Math.hypot(mv.x - 50, mv.y - 50)).toBeLessThanOrEqual(bR + 1e-6);
    }
    // Scanlines at v = 20,25,...,80: the two tangent extremes are empty, the
    // 11 interior ones each produce ONE clipped pass -- crossing passes are
    // clipped, not dropped wholesale.
    const runs = cutRuns(ir.moves);
    expect(runs).toHaveLength(11);
    for (let k = 1; k < runs.length; k++) {
      expect(runs[k][0].y - runs[k - 1][0].y).toBeCloseTo(5, 9); // stepover spacing
    }
    // Width per scanline is measured over ALL feed roles (lead-in + plunge +
    // cut + stay-down touchdown), not the 'cut' run alone: the entry pass is
    // reached by a ramp lead-in, so its leading portion carries 'lead_in'
    // (not 'cut') yet still traverses the clipped chord. angle-0 passes are
    // axis-aligned, so every point of one pass shares an exact integer y; the
    // fractional-y points of stay-down link connectors fall outside the
    // scanline levels and are ignored.
    const spanByY = new Map<number, { min: number; max: number }>();
    for (const mv of ir.moves) {
      if (mv.t !== 'feed') continue; // rapids traverse at clearance, not on the pass
      const s = spanByY.get(mv.y);
      if (s === undefined) spanByY.set(mv.y, { min: mv.x, max: mv.x });
      else {
        s.min = Math.min(s.min, mv.x);
        s.max = Math.max(s.max, mv.x);
      }
    }
    let checked = 0;
    for (let y = 25; y <= 75; y += 5) {
      const s = spanByY.get(y);
      expect(s, `scanline y=${y} produced no feed moves`).toBeDefined();
      const width = s!.max - s!.min;
      const chord = 2 * Math.sqrt(bR * bR - (y - 50) * (y - 50));
      expect(width).toBeLessThanOrEqual(chord + 1e-6); // inside the (inscribed) circle
      expect(width).toBeGreaterThanOrEqual(chord - 1.0); // reaches the full clipped chord
      checked++;
    }
    expect(checked).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// 4. Rotated frames: 30 deg invariants, 90 deg exactness
// ---------------------------------------------------------------------------

describe('rotated sampling frames', () => {
  const base: Omit<ParallelFinishInput, 'mesh' | 'angleDeg'> = {
    cutter: BALL6,
    stepover: 2,
    tolerance: 0.01,
    xyBounds: xyBoundsOf(20),
    heights: { clearanceZ: 25, retractZ: 16, feedZ: 16 },
    zSeed: 0,
  };

  it('30 deg: passes run along u, alternate, and space at exactly one stepover in v', { timeout: 120_000 }, async () => {
    const m = meshHandle('wave65');
    const ir = await parallelFinish(kernel, { ...base, mesh: m, angleDeg: 30 });
    const rad = (30 * Math.PI) / 180;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const vx = -uy;
    const vy = ux;
    const runs = cutRuns(ir.moves);
    expect(runs.length).toBeGreaterThan(5);
    let prevV = NaN;
    let prevSign = 0;
    for (const run of runs) {
      const v0 = run[0].x * vx + run[0].y * vy;
      for (const mv of run) {
        expect(mv.x * vx + mv.y * vy).toBeCloseTo(v0, 9); // colinear pass
      }
      for (let i = 1; i < run.length; i++) {
        const dx = run[i].x - run[i - 1].x;
        const dy = run[i].y - run[i - 1].y;
        const len = Math.hypot(dx, dy);
        expect(Math.abs(dx * ux + dy * uy) / len).toBeGreaterThan(1 - 1e-9); // along u
      }
      const sign = Math.sign(
        (run[run.length - 1].x - run[0].x) * ux + (run[run.length - 1].y - run[0].y) * uy,
      );
      if (prevSign !== 0) expect(sign).toBe(-prevSign); // zigzag
      prevSign = sign;
      if (!Number.isNaN(prevV)) expect(v0 - prevV).toBeCloseTo(2, 9); // stepover in v
      prevV = v0;
    }
    // Fidelity + gouge hold in the rotated frame too.
    await assertFidelityAndNoGouge(m, ir, 0, 25, 16);
  });

  it('90 deg is exact: every pass lies on a bit-exact x = const line', { timeout: 120_000 }, async () => {
    const m = meshHandle('wave65');
    const ir = await parallelFinish(kernel, { ...base, mesh: m, angleDeg: 90 });
    const runs = cutRuns(ir.moves);
    expect(runs).toHaveLength(11); // x = 20, 18, ..., 0
    for (const run of runs) {
      const x = run[0].x;
      expect(Number.isInteger(x)).toBe(true);
      expect(x % 2).toBe(0);
      for (const mv of run) expect(Object.is(mv.x, x)).toBe(true); // bit-exact
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Perf smoke: CPU time, never wall-clock
// ---------------------------------------------------------------------------

describe('perf smoke (wave 200k tris, stepover 1, ~100 passes)', () => {
  it('completes within the CPU budget', { timeout: 300_000 }, async () => {
    const m = meshHandle('wave317');
    const cpu0 = process.cpuUsage();
    const ir = await parallelFinish(kernel, {
      mesh: m,
      cutter: BALL6,
      stepover: 1,
      angleDeg: 0,
      tolerance: 0.01,
      xyBounds: xyBoundsOf(100),
      heights: { clearanceZ: 25, retractZ: 16, feedZ: 16 },
      zSeed: 0,
    });
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const passes = cutRuns(ir.moves).length;
    console.log(
      `perf parallelFinish: cpu ${cpuMs.toFixed(0)} ms, ${passes} passes, ` +
        `${ir.moves.length} moves`,
    );
    expect(passes).toBeGreaterThanOrEqual(95);
    expect(cpuMs).toBeLessThan(8000);
  });
});
