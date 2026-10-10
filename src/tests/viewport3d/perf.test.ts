// viewport3d picking performance guard (AC5): on a mock body of >=100k
// triangles, a raycast (after the one-time BVH build) must stay under 5ms.
//
// Tolerance/methodology (documented per AC5): BVH build happens once at
// ingest() and is excluded from the measurement entirely. We warm up with a
// handful of untimed raycasts (JIT warm-up -- V8 hasn't optimized the hot
// path on the first few calls), then time N subsequent raycasts and assert
// the MEDIAN (not max, which is sensitive to GC/scheduler noise on a shared
// CI box) is under the 5ms budget. The measured number is recorded in the
// WO report.

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { PickEngine } from '../../viewport3d/PickEngine';
import type { RayLike } from '../../viewport3d/types';
import { makeLargeMeshFixture } from './fixtures';

const BODY_ID = 'perf-body';
const WARMUP_RAYCASTS = 20;
const TIMED_RAYCASTS = 200;
const BUDGET_MS = 5;

function rayAt(x: number, y: number): RayLike {
  return { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } };
}

describe('picking performance guard', () => {
  it(`raycast on a >=100k triangle body stays under ${BUDGET_MS}ms per pick after BVH build`, () => {
    const { buffers, triangleCount } = makeLargeMeshFixture(100_000);
    expect(triangleCount).toBeGreaterThanOrEqual(100_000);

    const cache = new GeometryCache();
    const buildStart = performance.now();
    cache.ingest(BODY_ID, buffers);
    const buildMs = performance.now() - buildStart;

    const engine = new PickEngine(cache);

    // Warm-up: excluded from the measured budget.
    for (let i = 0; i < WARMUP_RAYCASTS; i++) {
      engine.pick(BODY_ID, rayAt((i % 100) * 2, (i % 100) * 2), 'face');
    }

    const samples: number[] = [];
    for (let i = 0; i < TIMED_RAYCASTS; i++) {
      // Vary the target point (within the grid's actual footprint) so the
      // BVH actually walks instead of repeating one cached branch pattern.
      const x = (i % 100) * 2;
      const y = ((i * 37) % 100) * 2;
      const t0 = performance.now();
      const hit = engine.pick(BODY_ID, rayAt(x, y), 'face');
      samples.push(performance.now() - t0);
      expect(hit).not.toBeNull();
    }

    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const max = samples[samples.length - 1];

    // Recorded in the WO report: triangleCount, buildMs, medianRaycastMs, maxRaycastMs.
    // eslint-disable-next-line no-console
    console.log(
      `[viewport3d perf] triangles=${triangleCount} buildMs=${buildMs.toFixed(3)} ` +
        `medianRaycastMs=${median.toFixed(4)} maxRaycastMs=${max.toFixed(4)}`,
    );

    expect(median).toBeLessThan(BUDGET_MS);
  });
});
