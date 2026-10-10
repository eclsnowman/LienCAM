// An Adaptive 3D rough must leave the tool at its clearance plane when it ends.
//
// Found 10-09 in a newcomer journey on Full Suite: the posted program stopped
// the spindle (M5, before the tool-change retract and before the program-end
// retract) with the tool still at cutting depth, because the 3D rough's last
// move was its last cut. Every 2D op and every 3D finish (pathbuild,
// waterline) already ends with its own retract; the rougher did not.
//
// Production path: computeAdaptive3dMoves (the store's entry) through the
// in-process cam3d worker client, then the real postProgram (GRBL). The rough
// is posted twice with two different tools so the program contains both a
// tool-change M5 and the program-end M5 right after the rough's last move.

import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import {
  computeAdaptive3dMoves,
  stockBoundsFromMesh,
  DEFAULT_ADAPTIVE3D_PARAMS,
} from '../../cam3d/integration/adaptive3dOperation';
import { postProgram, GRBL_CONFIG } from '../../lib/post';
import type { PostInput, PostOperation } from '../../lib/post/types';
import { resolveFeedrates } from '../../lib/cam/feedrates';
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve';
import { makeTool, makeMachine, makeOp, makeWcs } from '../post/helpers';
import type { ToolpathMove } from '../../types';

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest); },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

/** Z (modal) at every M5 line of the program, tracked from the motion blocks. */
function zAtEachSpindleStop(gcode: string): number[] {
  let z = NaN;
  const out: number[] = [];
  for (const raw of gcode.split('\n')) {
    const line = raw.replace(/\(.*?\)/g, '').trim();
    const zWord = /\bZ(-?\d+(?:\.\d+)?)/.exec(line);
    if (zWord && !/\bG53\b/.test(line)) z = Number(zWord[1]);
    if (/^M5\b/.test(line)) out.push(z);
  }
  return out;
}

describe('Adaptive 3D rough ends at its clearance plane', () => {
  it('last move is a lift to clearance, and no M5 runs with the tool below it', { timeout: 300_000 }, async () => {
    const mesh = hemisphereOnSlab(8, { x: 40, y: 40, t: 6 });
    const top = mesh.bounds.max[2];
    const clearanceZ = top + 10;
    const client = makeClient();
    let moves: ToolpathMove[];
    try {
      ({ moves } = await computeAdaptive3dMoves({
        partMesh: mesh,
        tool: makeTool({ id: 't1', name: 'Flat d6', type: 'flat_end_mill', diameter: 6, toolNumber: 1 }),
        params: { ...DEFAULT_ADAPTIVE3D_PARAMS, maxStepdown: 3, stepover: 0.4, tolerance: 0.2, helixDiameter: 3 },
        stockBounds: stockBoundsFromMesh(mesh),
        stockBoundsAreRealStock: true,
        resolvedHeights: { clearanceZ, retractZ: top + 2, feedZ: top + 2, topZ: top, bottomZ: mesh.bounds.min[2] },
        client,
      }));
    } finally {
      await client.dispose();
    }
    expect(moves.some((m) => m.role === 'cut')).toBe(true);

    const machine = makeMachine();
    const postOps: PostOperation[] = [1, 2].map((n) => {
      const tool = makeTool({ id: `t${n}`, name: `Flat d6 #${n}`, type: 'flat_end_mill', diameter: 6, toolNumber: n });
      const op = makeOp({ id: `op${n}`, name: `3D Rough ${n}`, type: 'adaptive_3d', toolId: tool.id, status: 'ready', toolpathMoves: moves });
      return {
        op,
        tool,
        feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
        spindle: resolveSpindle(op, tool, machine),
        coolant: resolveCoolant(tool, machine),
        moves,
      };
    });
    const input: PostInput = { machine, setup: { wcs: makeWcs(), operations: postOps } };
    const res = postProgram(input, GRBL_CONFIG);
    expect(res.ok).toBe(true);

    const stops = zAtEachSpindleStop(res.gcode);
    expect(stops).toHaveLength(2); // the tool change, then the program end
    for (const z of stops) expect(z).toBeGreaterThanOrEqual(clearanceZ - 1e-3);

    const last = moves[moves.length - 1];
    const beforeLast = moves[moves.length - 2];
    expect(last.type).toBe('rapid');
    expect(last.z).toBeCloseTo(clearanceZ, 6);
    // A straight lift along the tool's own axis from where the cut ended.
    expect([last.x, last.y]).toEqual([beforeLast.x, beforeLast.y]);
  });
});
