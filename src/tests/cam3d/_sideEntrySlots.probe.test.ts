// WO-402 probe (opt-in): where does the ring fixture over-engage? Dumps over-cap windows
// grouped by z / role / location. SIDE_ENTRY_PROBE=1 to run.
import { describe, it, beforeAll } from 'vitest';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { Box3 } from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { bossInOpenStock, hemisphereOnSlab } from '../../cam3d/fixtures';
import { measurePathEngagement } from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 };
const CELL = 0.79;
describe.skipIf(!process.env.SIDE_ENTRY_PROBE)('side entry slot probe', () => {
  let kernel: BvhKernel;
  beforeAll(async () => { await ensureGeom2dReady(); await ensureEngineClipperReady(); kernel = new BvhKernel(); });
  it('hemisphereOnSlab sideEntry=ON (getEngagePointPort fixture)', { timeout: 900000 }, async () => {
    const mesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    const { min, max } = mesh.bounds;
    const stockBounds: Box3 = { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
    const cutter3: CutterSpec = { kind: 'flat', diameter: 3 };
    const handle = kernel.uploadMesh(mesh);
    const ir = await adaptiveRough(kernel, {
      mesh: handle, cutter: cutter3, stockBounds, stockBoundsAreRealStock: true, cellSize: 0.75,
      maxStepdown: 12, stepover: 0.4, tolerance: 0.1, helixDiameter: 3,
      heights: { clearanceZ: 34, retractZ: 30.5, feedZ: 30.5 }, materialTopZ: max[2], sideEntry: true,
    });
    const buckets = new Map<string, { len: number; n: number; maxFrac: number; xs: number[]; ys: number[] }>();
    const m = measurePathEngagement(ir.moves, stockBounds, 0.75, cutter3, { capFraction: 0.75, onOverCap: (h) => {
      const key = `z=${h.z.toFixed(1)} role=${h.role} cell=(${Math.round(h.x / 10) * 10},${Math.round(h.y / 10) * 10})`;
      const b = buckets.get(key) ?? { len: 0, n: 0, maxFrac: 0, xs: [], ys: [] };
      b.len += h.lengthMm; b.n++; b.maxFrac = Math.max(b.maxFrac, h.fraction); b.xs.push(h.x); b.ys.push(h.y);
      buckets.set(key, b);
    } });
    console.log(`hemi ON: peak ${(m.peakFraction * 100).toFixed(1)}% overCap ${m.overCapLengthMm.toFixed(0)}/${m.cuttingLengthMm.toFixed(0)}mm`);
    for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].len - a[1].len).slice(0, 25)) {
      console.log(`   ${b.len.toFixed(1)}mm  max ${(b.maxFrac * 100).toFixed(0)}%  ${k}  x[${Math.min(...b.xs).toFixed(0)}..${Math.max(...b.xs).toFixed(0)}] y[${Math.min(...b.ys).toFixed(0)}..${Math.max(...b.ys).toFixed(0)}]`);
    }
    kernel.releaseMesh(handle);
  });
  for (const [ring, side] of [[10, true], [11, true], [15, false], [15, true]] as const) {
    it(`ring ${ring} sideEntry=${side}`, { timeout: 900000 }, async () => {
      const partXY = 100 - 2 * ring;
      const mesh = bossInOpenStock({ x: 100, y: 100 }, { x: partXY, y: partXY, z: 14 });
      const stockBounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 15 };
      const handle = kernel.uploadMesh(mesh);
      const input: AdaptiveRoughInput = {
        mesh: handle, cutter: CUTTER, stockBounds, stockBoundsAreRealStock: true, cellSize: CELL,
        maxStepdown: 3, stepover: 0.4, tolerance: 0.05, helixDiameter: 3,
        heights: { clearanceZ: 20, retractZ: 16, feedZ: 16 }, materialTopZ: 15,
        ...(side ? { sideEntry: true } : {}),
        ...(process.env.SIDE_ENTRY_PROBE_REACH ? { reachStockEdgeBy: Number(process.env.SIDE_ENTRY_PROBE_REACH) } : {}),
        ...(process.env.SIDE_ENTRY_PROBE_IWF === '0' ? { integralWallFollow: false } : {}),
      };
      let ir; let diag: any;
      try { ir = await adaptiveRough(kernel, input, { onDiagnostics: (d) => { diag = d; } }); } catch (e) { console.log(`ring ${ring} ${side}: REFUSED ${(e as Error).message.slice(0, 200)}`); return; }
      const buckets = new Map<string, { len: number; n: number; maxFrac: number; xs: number[]; ys: number[] }>();
      const m = measurePathEngagement(ir.moves, stockBounds, CELL, CUTTER, { capFraction: 0.75, onOverCap: (h) => {
        const key = `z=${h.z.toFixed(1)} role=${h.role} cell=(${Math.round(h.x / 10) * 10},${Math.round(h.y / 10) * 10})`;
        const b = buckets.get(key) ?? { len: 0, n: 0, maxFrac: 0, xs: [], ys: [] };
        b.len += h.lengthMm; b.n++; b.maxFrac = Math.max(b.maxFrac, h.fraction); b.xs.push(h.x); b.ys.push(h.y);
        buckets.set(key, b);
      } });
      if (process.env.SIDE_ENTRY_PROBE_MOVES) {
        const mv = ir.moves; let n = 0;
        const zSel = process.env.SIDE_ENTRY_PROBE_Z ? Number(process.env.SIDE_ENTRY_PROBE_Z) : null;
        const maxN = Number(process.env.SIDE_ENTRY_PROBE_MOVES) > 1 ? Number(process.env.SIDE_ENTRY_PROBE_MOVES) : 60;
        for (let i = 0; i < mv.length && n < maxN; i++) { const m = mv[i]; const L = mv[i-1] ? Math.hypot(m.x-mv[i-1].x, m.y-mv[i-1].y) : 0; if (zSel !== null ? (Math.abs(m.z - zSel) < 0.01 && (m.role !== 'cut' || L > 3)) : (m.z <= 14.01 && (m.role !== 'cut' || i % 8 === 0 || L > 5))) { console.log(`   mv${i} ${m.t} ${m.role} (${m.x.toFixed(2)}, ${m.y.toFixed(2)}, ${m.z.toFixed(2)}) L=${L.toFixed(1)}`); n++; } }
      }
      const ar = diag?.adaptiveRough; console.log(`ring ${ring} side=${side}: regions planned=${ar?.plannedRegions} machined=${ar?.machinedRegions} skipped=${ar?.skippedRegions} partial=${ar?.partialRegions} reasons=${JSON.stringify(ar?.reasonCounts)} issues=${JSON.stringify((ar?.issues ?? []).slice(0, 8).map((i: any) => ({ z: i.z, k: i.kind, r: i.reason, n: i.passCount })))}`);
      const prm = (ir.meta as any)?.params ?? {};
      console.log(`ring ${ring} side=${side}: retainedWallProbeDiameter=${prm.retainedWallProbeDiameter} smoothingSafetyFallback=${prm.smoothingSafetyFallback} wallCleanupSafetyFallback=${prm.wallCleanupSafetyFallback} wallCleanupContours=${prm.wallCleanupContours} outsideEntryCount=${prm.outsideEntryCount}`);
      console.log(`ring ${ring} side=${side}: peak ${(m.peakFraction * 100).toFixed(1)}% overCap ${m.overCapLengthMm.toFixed(0)}/${m.cuttingLengthMm.toFixed(0)}mm; levels ${[...new Set(ir.moves.filter(x => x.role === 'cut').map(x => x.z))].join(',')}`);
      for (const [k, b] of [...buckets.entries()].sort((a, c) => c[1].len - a[1].len).slice(0, 25)) {
        console.log(`   ${b.len.toFixed(1)}mm  max ${(b.maxFrac * 100).toFixed(0)}%  ${k}  x[${Math.min(...b.xs).toFixed(0)}..${Math.max(...b.xs).toFixed(0)}] y[${Math.min(...b.ys).toFixed(0)}..${Math.max(...b.ys).toFixed(0)}]`);
      }
      kernel.releaseMesh(handle);
    });
  }
});
