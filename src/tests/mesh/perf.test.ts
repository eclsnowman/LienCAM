// MSH-3 perf riders: BK-11a (spatial-index self-intersection scan) and BK-17b
// (single shared topology pass). These assert the acceptance THRESHOLDS with
// generous margins so they never flake on a loaded fleet; the exact measured
// numbers for the report are logged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  analyzeMesh,
  measureMesh,
  analyzeAndMeasure,
  debugBuildTopologyCallCount,
  debugResetBuildTopologyCallCount,
} from '../../mesh/analysis';
import { importStl } from '../../mesh/stl';
import { unitCube, sphereApprox, selfIntersectingTriangles } from './fixtures';

function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('BK-11a: spatial-index self-intersection scan', () => {
  it('14,160-triangle fixture scans well under 3s (was 31.2s O(n^2)) with a false verdict', () => {
    const mesh = sphereApprox(10, 120, 60); // 14,160 triangles
    expect(mesh.indices.length / 3).toBe(14160);
    const t0 = performance.now();
    const report = analyzeMesh(mesh, { checkSelfIntersections: true });
    const ms = performance.now() - t0;
    console.log(`[BK-11a] 14,160-tri self-intersection scan: ${ms.toFixed(1)}ms (verdict=${report.selfIntersections})`);
    expect(report.selfIntersections).toBe(false);
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  it('verdict parity across fixtures (grid never misses an intersecting pair)', () => {
    expect(analyzeMesh(unitCube(10), { checkSelfIntersections: true }).selfIntersections).toBe(false);
    expect(analyzeMesh(selfIntersectingTriangles(), { checkSelfIntersections: true }).selfIntersections).toBe(true);
    expect(analyzeMesh(sphereApprox(5, 32, 16), { checkSelfIntersections: true }).selfIntersections).toBe(false);
    const plateBytes = readFileSync('src/tests/mesh/fixtures/prismatic-plate.stl');
    const ab = plateBytes.buffer.slice(plateBytes.byteOffset, plateBytes.byteOffset + plateBytes.byteLength);
    expect(analyzeMesh(importStl(ab).mesh, { checkSelfIntersections: true }).selfIntersections).toBe(false);
  }, 30_000);
});

describe('BK-17b: single shared topology pass', () => {
  // MSH-4 rider (b): the mechanism claim is "analyzeAndMeasure runs
  // buildTopology once; analyzeMesh()+measureMesh() runs it twice". The
  // PRIMARY assertion below is a deterministic call-count check (via the
  // debugBuildTopologyCallCount test hook added in src/mesh/analysis.ts) --
  // it proves the actual mechanism directly and is immune to CPU contention,
  // unlike a wall-clock race. The original wall-clock comparison
  // (best-of-3 "separate" vs "shared" timing) is KEPT but demoted to an
  // informational console.log with a generous non-gating margin: it inverted
  // under full-suite parallel load (2026-07-08, MSH-3-R1-gate.log run 2) even
  // though the isolated re-run passed at 1.96x, because scheduler noise on a
  // loaded machine can outweigh a real ~2x algorithmic win at n=3 samples.
  // Gating on the call count instead of the clock keeps the test meaningful
  // (it still fails if the sharing regresses) while removing the flake.
  it('analyzeAndMeasure runs buildTopology exactly once; analyzeMesh + measureMesh runs it twice (call-count proof, contention-immune)', () => {
    const mesh = sphereApprox(10, 320, 160); // 101,760 triangles
    expect(mesh.indices.length / 3).toBeGreaterThanOrEqual(100000);

    debugResetBuildTopologyCallCount();
    analyzeMesh(mesh, { checkSelfIntersections: false });
    measureMesh(mesh);
    const separateCalls = debugBuildTopologyCallCount();
    expect(separateCalls).toBe(2);

    debugResetBuildTopologyCallCount();
    analyzeAndMeasure(mesh, { checkSelfIntersections: false });
    const sharedCalls = debugBuildTopologyCallCount();
    expect(sharedCalls).toBe(1);

    // informational only, not gating (see comment above): logs the wall-clock
    // ratio for visibility but never fails the suite on scheduler noise.
    analyzeAndMeasure(mesh, { checkSelfIntersections: false }); // warmup
    const separateMs = bestOf(3, () => {
      analyzeMesh(mesh, { checkSelfIntersections: false });
      measureMesh(mesh);
    });
    const sharedMs = bestOf(3, () => analyzeAndMeasure(mesh, { checkSelfIntersections: false }));
    console.log(
      `[BK-17b] 101,760-tri buildTopology calls: separate=${separateCalls} shared=${sharedCalls} | ` +
        `informational wall-clock: separate=${separateMs.toFixed(1)}ms shared=${sharedMs.toFixed(1)}ms ratio=${(separateMs / sharedMs).toFixed(2)}x`,
    );

    // sanity: the shared result equals what the two calls would return
    const bundled = analyzeAndMeasure(mesh, { checkSelfIntersections: false });
    const r = analyzeMesh(mesh, { checkSelfIntersections: false });
    const m = measureMesh(mesh);
    expect(bundled.report).toEqual(r);
    expect(bundled.measures).toEqual(m);
  }, 30_000);
});
