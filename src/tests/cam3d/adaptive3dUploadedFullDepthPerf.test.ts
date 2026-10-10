import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh } from '../../cam3d/kernel/types';
import type { Cam3dProgressDetail } from '../../cam3d/progress';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';

const FIXTURE = 'src/tests/fixtures/adaptive3d-uploaded-bore.json';
const STOCK_BOUNDS = {
  minX: -48.809749603271484,
  minY: -24.470998764038086,
  minZ: 0,
  maxX: 48.809749603271484,
  maxY: 24.470998764038086,
  maxZ: 35,
};
const TOOL_DIAMETER = 9.52;

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
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

describe.runIf(process.env.ADAPTIVE_FULL_DEPTH_PERF === '1')(
  'uploaded Adaptive 3D full-depth performance gate',
  () => {
    it('finishes through the real worker path under 30 seconds with two exact XY plans', { timeout: 120_000 }, async () => {
      const display = JSON.parse(readFileSync(FIXTURE, 'utf8'));
      const mesh: PartMesh = {
        positions: Float32Array.from(display.positions),
        indices: Uint32Array.from(display.indices),
        bounds: display.bounds,
        source: 'fixture',
      };
      const client = makeClient();
      const toolRadius = TOOL_DIAMETER / 2;
      const progress: Array<{ fraction: number; detail?: Cam3dProgressDetail }> = [];

      try {
        const startedAt = performance.now();
        const { ir, diagnostics } = await client.generateAdaptiveRough({
          partMesh: mesh,
          cutter: { kind: 'flat', diameter: TOOL_DIAMETER },
          stockBounds: STOCK_BOUNDS,
          cellSize: TOOL_DIAMETER / 12,
          maxStepdown: 3,
          stepover: 0.4,
          millingDirection: 'climb',
          tolerance: 0.05,
          helixDiameter: 3,
          helixAngleDeg: 5,
          // Smart Height resolves target-surface Z 0 plus the authored 0.5 mm
          // axial allowance before the strategy boundary.
          floorZ: 0.5,
          radialStockToLeave: 0.25,
          axialStockToLeave: 0.5,
          reachStockEdgeBy: toolRadius * 2,
          sideEntry: true,
          heights: { clearanceZ: 50, retractZ: 40, feedZ: 40 },
          materialTopZ: 35,
          stockBoundsAreRealStock: true,
        }, {
          onProgress: (fraction, detail) => progress.push({ fraction, detail }),
        });
        const elapsedMs = performance.now() - startedAt;

        expect(ir.moves.length).toBeGreaterThan(0);
        expect(ir.meta.params?.levelCount).toBe(12);
        expect(ir.meta.params?.plannerCacheHits).toBe(10);
        expect(ir.meta.params?.plannerCacheMisses).toBe(2);
        expect(ir.meta.params?.plannerUniquePlans).toBe(2);
        expect(Number(ir.meta.params?.wallCleanupContours)).toBeGreaterThanOrEqual(12);
        expect(diagnostics?.adaptiveRough).toMatchObject({
          plannedRegions: 17,
          machinedRegions: 17,
          skippedRegions: 0,
          partialRegions: 0,
        });
        const schedule = diagnostics?.adaptiveRough?.componentSchedule ?? [];
        expect(schedule.slice(7, 12).map(item => [item.levelIndex, item.componentIndex]))
          .toEqual([[7, 1], [8, 1], [9, 1], [10, 1], [11, 1]]);
        expect(schedule.slice(12).map(item => [item.levelIndex, item.componentIndex]))
          .toEqual([[7, 0], [8, 0], [9, 0], [10, 0], [11, 0]]);
        expect(progress.filter((item) => item.detail?.step?.includes('reused XY plan')))
          .toHaveLength(10);
        expect(progress.flatMap((item) => item.detail?.phase ?? []))
          .not.toContain('Refining retained-model safety');
        expect(progress.at(-1)?.fraction).toBe(1);
        expect(progress.at(-1)?.detail?.attempt).toBe(1);
        expect(elapsedMs).toBeLessThanOrEqual(30_000);

        console.log(
          `[adaptive full-depth perf] ${(elapsedMs / 1000).toFixed(2)}s, `
          + `${ir.moves.length} moves, cache 10 hits / 2 unique plans`,
        );
      } finally {
        await client.dispose();
      }
    });
  },
);
