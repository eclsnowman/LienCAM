// WO-277 -- the next rough starts from what the last one left.
//
// WO-274 kept the carved field alive worker-side and handed back a handle;
// nothing read it, so every operation still planned as though the block were
// untouched. This is the reader: an adaptive rough may name a retained handle
// (startFromStock) and then starts from THAT field instead of a full stock box,
// so a second, smaller cutter only works the material the first could not reach.
//
// What these tests prove:
//   1. NOTHING LEFT TO CUT. The identical rough re-run from the retained handle
//      produces no cutting moves. Only a field that was really consulted can do
//      that -- planning from a fresh box would cut the whole pocket again.
//   2. THE CORNERS THE BIG CUTTER MISSED. A large cutter, then a small one from
//      its handle: the small one cuts, strictly less than the same small-cutter
//      rough from a full box, and every cutting move lies where the large cutter
//      left material standing.
//   3. REFUSAL, NEVER ADAPTATION. Different stock bounds, a different cell size,
//      a stock the caller made itself, and a stale handle are each refused with a
//      message naming the difference. A quiet fallback to a full box would also
//      be defensible on paper and is exactly what this order forbids: it is how a
//      caller never learns its sequencing is wrong, and believing a field that
//      describes something else means cutting solid metal at feed.
//
// Drives the real BvhKernel through the dispatcher over the in-process fake
// channel (worker.test.ts / WO-274 pattern), so every carve is real geometry.

import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { engagementPocket, pocketBox } from '../../cam3d/fixtures';
import { stockBoundsFromMesh } from '../../cam3d/integration/adaptive3dOperation';
import type { ZDexelField } from '../../cam3d/stock';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import { Cam3dClient, type AdaptiveRoughClientInput, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';

// Small closed part (WO-274's fixture): 24 x 20 x 12 block with a centred
// 10 x 8 pocket 5 mm deep, so the pocket floor sits at z = 7.
const OUTER = { x: 24, y: 20, z: 12 };
const POCKET = { x: 10, y: 8, depth: 5 };
const CELL_SIZE = 1;

// Engagement fixture: 90 x 60 x 16 block, H-shaped pocket to a floor at z = 4
// with a 6 mm NECK joining the two chambers. The neck is the point: an 8 mm
// cutter cannot enter it at all, so it is material the big cutter provably
// could not reach, not a corner scallop a tolerance argument could explain away.
const EP_TOP_Z = 16;
const EP_NECK = { x0: 40, x1: 50, y0: 27, y1: 33 };

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

/** WO-274's rough input: stock box EQUAL to the part bounds. */
function pocketRoughInput(): AdaptiveRoughClientInput {
  const partMesh = pocketBox(OUTER, POCKET);
  return {
    partMesh,
    cutter: { kind: 'flat', diameter: 3 },
    stockBounds: stockBoundsFromMesh(partMesh),
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

/** Engagement-pocket rough input with the cutter as the only variable. */
function neckRoughInput(diameter: number): AdaptiveRoughClientInput {
  const partMesh = engagementPocket();
  return {
    partMesh,
    cutter: { kind: 'flat', diameter },
    stockBounds: stockBoundsFromMesh(partMesh),
    cellSize: CELL_SIZE,
    maxStepdown: 6,
    stepover: 0.4,
    tolerance: 0.2,
    helixDiameter: 2,
    helixAngleDeg: 10,
    heights: { clearanceZ: EP_TOP_Z + 10, retractZ: EP_TOP_Z + 2, feedZ: EP_TOP_Z + 2 },
    materialTopZ: EP_TOP_Z,
  };
}

/** Moves that touch material: everything that is not a positioning rapid. */
function cuttingMoves(ir: ToolpathIR): IrMove[] {
  return ir.moves.filter((m) => m.t !== 'rapid');
}

/** Length (mm) of the moves that travel laterally at depth (cut / stepover /
 *  finish) - the honest "amount of work" measure; entries (plunge / ramp) and
 *  links are excluded. */
function lateralCuttingLength(ir: ToolpathIR): number {
  let length = 0;
  for (let k = 1; k < ir.moves.length; k++) {
    const a = ir.moves[k - 1];
    const b = ir.moves[k];
    if (b.t === 'rapid') continue;
    if (b.role !== 'cut' && b.role !== 'stepover' && b.role !== 'finish') continue;
    length += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return length;
}

/**
 * Highest material standing anywhere the cutter body covers at (x, y) -- the
 * honest question for "did this move work material the previous run left".
 * A cut in a leftover corner or slot has its CENTRE offset by up to the tool
 * radius from the material it removes, so a single-column probe would answer no
 * for a perfectly correct move. One cell of slack covers the grid quantization.
 */
function topWithinReach(field: ZDexelField, x: number, y: number, radius: number): number {
  const reach = radius + field.cell;
  const i0 = Math.max(0, Math.floor((x - reach - field.originX) / field.cell));
  const i1 = Math.min(field.nx - 1, Math.floor((x + reach - field.originX) / field.cell));
  const j0 = Math.max(0, Math.floor((y - reach - field.originY) / field.cell));
  const j1 = Math.min(field.ny - 1, Math.floor((y + reach - field.originY) / field.cell));
  let highest = Number.NEGATIVE_INFINITY;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const t = field.top[field.colIndex(i, j)];
      if (t > highest) highest = t;
    }
  }
  return highest;
}

describe('WO-277 a rough can start from the field the last rough left', () => {
  it(
    'the identical rough from the retained handle has nothing left to cut',
    { timeout: 300_000 },
    async () => {
      const { client, dispatcher } = makeHarness();
      try {
        const first = await client.generateAdaptiveRough(pocketRoughInput());
        expect(first.carvedStockHandle).toBeDefined();
        const firstCuts = cuttingMoves(first.ir).length;
        expect(firstCuts).toBeGreaterThan(0);

        // THE decisive assertion: the same rough, same tool, same everything --
        // but starting from what it already carved. Nothing is left for this
        // tool, so it must emit no cutting moves at all. A rough that quietly
        // re-planned from a full box would repeat all `firstCuts` of them.
        const second = await client.generateAdaptiveRough({
          ...pocketRoughInput(),
          startFromStock: first.carvedStockHandle!,
        });
        expect(cuttingMoves(second.ir)).toHaveLength(0);
        expect(second.ir.meta.params?.startedFromRetainedStock).toBe(true);

        // The rest pass retained its own field (one at a time), which RELEASED
        // the first -- and the released handle refuses loudly rather than
        // answering with material that is no longer there (WO-274's path).
        expect(second.carvedStockHandle).toBeDefined();
        expect(second.carvedStockHandle).not.toBe(first.carvedStockHandle);
        expect(dispatcher.liveStockCount).toBe(1);
        await expect(
          client.generateAdaptiveRough({
            ...pocketRoughInput(),
            startFromStock: first.carvedStockHandle!,
          }),
        ).rejects.toThrow(/not live/);

        console.log(
          `[WO-277] first rough ${firstCuts} cutting moves; rest pass from its handle ` +
            `${cuttingMoves(second.ir).length}`,
        );
      } finally {
        await client.dispose();
      }
    },
  );

  it(
    'a smaller cutter from the handle works only what the big one could not reach',
    { timeout: 600_000 },
    async () => {
      const { client, dispatcher } = makeHarness();
      try {
        // The 8 mm cutter clears both chambers and cannot enter the 6 mm neck.
        const big = await client.generateAdaptiveRough(neckRoughInput(8));
        expect(big.carvedStockHandle).toBeDefined();
        expect(cuttingMoves(big.ir).length).toBeGreaterThan(0);
        // Hold the field it left: the next run's retention releases the handle,
        // and this is what "the region the big cutter could not reach" means.
        const bigLeft = dispatcher.peekStock(big.carvedStockHandle!).clone();
        // The neck really is untouched material after the big run.
        expect(
          topWithinReach(bigLeft, (EP_NECK.x0 + EP_NECK.x1) / 2, (EP_NECK.y0 + EP_NECK.y1) / 2, 0),
        ).toBeCloseTo(EP_TOP_Z, 3);

        const rest = await client.generateAdaptiveRough({
          ...neckRoughInput(3),
          startFromStock: big.carvedStockHandle!,
        });
        const restCuts = cuttingMoves(rest.ir);
        expect(restCuts.length).toBeGreaterThan(0);

        // The same small-cutter rough from a FULL BOX: it has to clear both
        // chambers as well, so it is strictly more work. Work is LATERAL
        // CUTTING LENGTH, not move count: the rest job is a dozen small
        // leftover regions, each entered by a helix of ~200 ramp segments, so
        // it counts MORE moves (2630 vs 2051) while cutting an eighth of the
        // path (775 mm vs 6557 mm) - WO-401, 2026-08-19.
        const fromBox = await client.generateAdaptiveRough(neckRoughInput(3));
        const boxCuts = cuttingMoves(fromBox.ir);
        expect(boxCuts.length).toBeGreaterThan(0);
        expect(lateralCuttingLength(rest.ir)).toBeLessThan(lateralCuttingLength(fromBox.ir) / 2);

        // Every rest move that can touch anything stands where the big cutter
        // left material: something still above the level this move cuts at,
        // somewhere under the tool. Moves at or above the top of the block are
        // excluded by geometry, not by taste -- no material stands that high
        // anywhere in this stock, so an entry ramp descending to it cuts nothing
        // and makes no claim about which region it is over. Entries (plunge /
        // ramp / lead) are excluded for the same reason: the wall-cleanup
        // plunge lands in PROVEN-CLEAR air on the floor the big cutter already
        // made (z == local top, cutting nothing) and only then leads into the
        // island wall - WO-401.
        const restRadius = 1.5;
        const lateral = new Set(['cut', 'stepover', 'finish']);
        const engaging = restCuts.filter((m) => m.z < EP_TOP_Z - 1e-6 && lateral.has(String(m.role)));
        expect(engaging.length).toBeGreaterThan(0);
        const misplaced = engaging.filter(
          (m) => topWithinReach(bigLeft, m.x, m.y, restRadius) <= m.z + 1e-3,
        );
        expect(misplaced).toHaveLength(0);

        // ...and it did go into the neck, which is the material in question.
        const inNeck = restCuts.filter(
          (m) =>
            m.x > EP_NECK.x0 - restRadius &&
            m.x < EP_NECK.x1 + restRadius &&
            m.y > EP_NECK.y0 - restRadius &&
            m.y < EP_NECK.y1 + restRadius &&
            m.z < EP_TOP_Z,
        );
        expect(inNeck.length).toBeGreaterThan(0);

        console.log(
          `[WO-277] 8 mm rough ${cuttingMoves(big.ir).length} cutting moves; 3 mm rest pass ` +
            `${restCuts.length} (${inNeck.length} in the neck) vs ${boxCuts.length} for the ` +
            `same 3 mm rough from a full box`,
        );
      } finally {
        await client.dispose();
      }
    },
  );

  it(
    'refuses a field that describes a different situation, and never falls back to a box',
    { timeout: 300_000 },
    async () => {
      const { client, dispatcher } = makeHarness();
      try {
        const base = pocketRoughInput();
        const run = await client.generateAdaptiveRough(base);
        const handle = run.carvedStockHandle!;
        expect(handle).toBeDefined();

        // Different stock bounds: the field models a block that is not the one
        // being planned, so its "already removed" report is about other material.
        await expect(
          client.generateAdaptiveRough({
            ...pocketRoughInput(),
            stockBounds: { ...base.stockBounds, maxZ: base.stockBounds.maxZ + 5 },
            heights: { clearanceZ: OUTER.z + 20, retractZ: OUTER.z + 12, feedZ: OUTER.z + 12 },
            startFromStock: handle,
          }),
        ).rejects.toThrow(/stockBounds\.maxZ/);

        // Different cell size: a different grid entirely. Refused, not resampled.
        await expect(
          client.generateAdaptiveRough({
            ...pocketRoughInput(),
            cellSize: CELL_SIZE / 2,
            startFromStock: handle,
          }),
        ).rejects.toThrow(/cellSize/);

        // A stock the CALLER created is live, but nothing records what it
        // describes, so no rough may start from it.
        const owned = await client.stockCreate(base.stockBounds, CELL_SIZE);
        await expect(
          client.generateAdaptiveRough({ ...pocketRoughInput(), startFromStock: owned.stock }),
        ).rejects.toThrow(/not the carved field retained by the last adaptive rough/);

        // An explicitly disposed handle takes WO-274's fail-loud path.
        await client.stockDispose(handle);
        await expect(
          client.generateAdaptiveRough({ ...pocketRoughInput(), startFromStock: handle }),
        ).rejects.toThrow(/not live/);

        // Every refusal cost nothing: no rough ran, so no new field was retained
        // and the caller's own stock is the only one left.
        expect(dispatcher.liveStockCount).toBe(1);
        expect(dispatcher.peekStock(owned.stock).nx).toBeGreaterThan(0);
      } finally {
        await client.dispose();
      }
    },
  );
});
