// WO-274 -- the carved stock field a 3D rough builds is KEPT after the run
// instead of being dropped when the handler returns.
//
// Before this order the rougher's fully-carved ZDexelField was meshed for the
// viewport preview and then went out of scope: every later question about "is
// there material here" had to be answered from scratch. Now the field stays
// live in the dispatcher's stock registry under a handle that comes back with
// the result.
//
// What these tests prove (nothing in the product reads the field yet -- that is
// deliberate, and it is the next order):
//   1. The retained field holds WHAT THE RUN ACTUALLY CARVED: the column under
//      the pocket reads lower than a column the cutter never reached. Comparing
//      handle identity or a column count would pass while the field held
//      nothing.
//   2. One retained field at a time: a second rough releases the first, the
//      live count does not grow with operations run, and the stale handle FAILS
//      LOUD rather than answering with material that is no longer there. A
//      stock the caller created itself is untouched by that release.
//   3. Global dispose still means dispose -- the retained field goes with it.
//
// Drives the real BvhKernel through the dispatcher over the in-process fake
// channel (worker.test.ts pattern), so the carve is real geometry, not a mock.

import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { pocketBox } from '../../cam3d/fixtures';
import { stockBoundsFromMesh } from '../../cam3d/integration/adaptive3dOperation';
import { ZDexelField } from '../../cam3d/stock';
import { Cam3dClient, type AdaptiveRoughClientInput, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';

// Small closed part: 24 x 20 x 12 block with a centred 10 x 8 pocket 5 mm deep,
// so the pocket floor sits at z = 7 and its plan spans x[7,17] y[6,14].
const OUTER = { x: 24, y: 20, z: 12 };
const POCKET = { x: 10, y: 8, depth: 5 };
const POCKET_FLOOR_Z = OUTER.z - POCKET.depth; // 7
const CELL_SIZE = 1;

function makeHarness(): { client: Cam3dClient; dispatcher: Cam3dDispatcher } {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      // The in-process test channel owns no browser worker.
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent);
  });
  return { client: new Cam3dClient(fakeWorker), dispatcher };
}

/**
 * Rougher input over the pocketBox part with the stock box EQUAL to the part
 * bounds: the only material above the part is the pocket itself, so columns
 * outside the pocket are ones the cutter never reaches.
 */
function roughInput(): AdaptiveRoughClientInput {
  const partMesh = pocketBox(OUTER, POCKET);
  const stockBounds = stockBoundsFromMesh(partMesh);
  return {
    partMesh,
    cutter: { kind: 'flat', diameter: 3 },
    stockBounds,
    cellSize: CELL_SIZE,
    maxStepdown: 3,
    stepover: 0.4,
    tolerance: 0.2,
    helixDiameter: 2,
    helixAngleDeg: 10,
    heights: { clearanceZ: OUTER.z + 10, retractZ: OUTER.z + 2, feedZ: OUTER.z + 2 },
    materialTopZ: OUTER.z,
  };
}

/** Material top of the column containing world (x, y). */
function topAt(field: ZDexelField, x: number, y: number): number {
  const i = Math.floor((x - field.originX) / field.cell);
  const j = Math.floor((y - field.originY) / field.cell);
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThanOrEqual(0);
  expect(i).toBeLessThan(field.nx);
  expect(j).toBeLessThan(field.ny);
  return field.top[field.colIndex(i, j)];
}

describe('WO-274 carved stock is retained after the rough completes', () => {
  it(
    'hands back a handle whose field holds what the run carved',
    { timeout: 120_000 },
    async () => {
      const { client, dispatcher } = makeHarness();
      try {
        const result = await client.generateAdaptiveRough(roughInput());
        expect(result.ir.moves.length).toBeGreaterThan(0);

        // The handle rides back with the result and the field is still live.
        expect(result.carvedStockHandle).toBeDefined();
        expect(dispatcher.liveStockCount).toBe(1);

        const field = dispatcher.peekStock(result.carvedStockHandle!);
        expect(field).toBeInstanceOf(ZDexelField);

        // Same grid the run carved on (the un-carved box for comparison).
        const fresh = ZDexelField.fromBox(stockBoundsFromMesh(pocketBox(OUTER, POCKET)), CELL_SIZE);
        expect(field.nx).toBe(fresh.nx);
        expect(field.ny).toBe(fresh.ny);
        expect(field.cell).toBe(fresh.cell);

        // THE assertion: a column under the cut reads lower than a column the
        // cutter never reached. The pocket centre is cut to its floor; the
        // corner outside the pocket still stands at full stock height.
        const cutTop = topAt(field, OUTER.x / 2, OUTER.y / 2);
        const untouchedTop = topAt(field, 0.5, 0.5);
        expect(untouchedTop).toBeCloseTo(OUTER.z, 5);
        expect(cutTop).toBeLessThan(untouchedTop - 1);
        // ...and it is the pocket floor it was cut to, not an arbitrary dip.
        expect(cutTop).toBeLessThanOrEqual(POCKET_FLOOR_Z + CELL_SIZE);
        expect(cutTop).toBeGreaterThanOrEqual(POCKET_FLOOR_Z - CELL_SIZE);

        // The field is a carve, not a wipe: most of the block is untouched.
        let lowered = 0;
        for (let c = 0; c < field.nx * field.ny; c++) {
          if (field.top[c] < fresh.top[c] - 1e-4) lowered += 1;
        }
        expect(lowered).toBeGreaterThan(0);
        expect(lowered).toBeLessThan(field.nx * field.ny);

        console.log(
          `[WO-274] retained field ${field.nx}x${field.ny} cells: ${lowered} columns lowered, ` +
            `cut column top ${cutTop.toFixed(3)} vs untouched ${untouchedTop.toFixed(3)} mm`,
        );
      } finally {
        await client.dispose();
      }
    },
  );

  it(
    'retains one field at a time: the previous handle is released and fails loud',
    { timeout: 180_000 },
    async () => {
      const { client, dispatcher } = makeHarness();
      try {
        const first = await client.generateAdaptiveRough(roughInput());
        expect(first.carvedStockHandle).toBeDefined();
        expect(dispatcher.liveStockCount).toBe(1);

        // A stock the CALLER created is not part of the retention scheme and
        // must survive the next run's release.
        const owned = await client.stockCreate(
          { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 5 },
          1,
        );
        expect(dispatcher.liveStockCount).toBe(2);

        const second = await client.generateAdaptiveRough(roughInput());
        expect(second.carvedStockHandle).toBeDefined();
        expect(second.carvedStockHandle).not.toBe(first.carvedStockHandle);

        // The live count did not grow with the number of operations run: the
        // second retained field replaced the first, the caller's stock remains.
        expect(dispatcher.liveStockCount).toBe(2);
        expect(dispatcher.peekStock(owned.stock)).toBeInstanceOf(ZDexelField);

        // The stale handle FAILS LOUD -- worker-side and across the boundary --
        // rather than answering with material that is no longer there.
        expect(() => dispatcher.peekStock(first.carvedStockHandle!)).toThrow(/not live/);
        await expect(client.stockToMesh(first.carvedStockHandle!)).rejects.toThrow(/not live/);

        // The current field is readable and really carved.
        const field = dispatcher.peekStock(second.carvedStockHandle!);
        expect(topAt(field, OUTER.x / 2, OUTER.y / 2)).toBeLessThan(
          topAt(field, 0.5, 0.5) - 1,
        );
      } finally {
        await client.dispose();
      }
    },
  );

  it('global dispose clears the retained field too', { timeout: 120_000 }, async () => {
    const { client, dispatcher } = makeHarness();
    const result = await client.generateAdaptiveRough(roughInput());
    expect(result.carvedStockHandle).toBeDefined();
    expect(dispatcher.liveStockCount).toBe(1);

    await client.dispose();

    expect(dispatcher.liveStockCount).toBe(0);
    expect(() => dispatcher.peekStock(result.carvedStockHandle!)).toThrow(/not live/);
  });
});
