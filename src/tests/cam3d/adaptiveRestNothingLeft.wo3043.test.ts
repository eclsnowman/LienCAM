// WO-3043: a 3D adaptive second tool with nothing left to cut says so, instead of
// blaming the stock box. Production adapter (computeAdaptive3dMoves) over the real
// BvhKernel through the in-process cam3d channel; the second pass starts from the
// field the first rough retained, exactly as the store hands it over.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { pocketBox } from '../../cam3d/fixtures';
import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
  stockBoundsFromMesh,
  type ComputeAdaptive3dArgs,
} from '../../cam3d/integration/adaptive3dOperation';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { makeTool } from '../post/helpers';

const FULL_BOX_TEXT =
  'adaptive_3d produced no toolpath moves. The stock box may not enclose the ' +
  'part, the floor may sit at the stock top (nothing to rough), or the ' +
  'boundary may exclude the whole part.';

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

const mesh = pocketBox({ x: 24, y: 20, z: 12 }, { x: 10, y: 8, depth: 5 });
const top = mesh.bounds.max[2];
const tool = makeTool({ id: 't1', name: 'Flat d3', type: 'flat_end_mill', diameter: 3, toolNumber: 1 });

function args(client: Cam3dClient, over: Partial<ComputeAdaptive3dArgs> = {}): ComputeAdaptive3dArgs {
  return {
    partMesh: mesh,
    tool,
    params: { ...DEFAULT_ADAPTIVE3D_PARAMS, maxStepdown: 3, stepover: 0.4, tolerance: 0.2, helixDiameter: 2 },
    stockBounds: stockBoundsFromMesh(mesh),
    stockBoundsAreRealStock: true,
    resolvedHeights: { clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2, topZ: top, bottomZ: mesh.bounds.min[2] },
    client,
    ...over,
  };
}

async function messageOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('WO-3043 adaptive rest pass with nothing left to cut', () => {
  it('a second pass from the first rough\'s stock says the previous rough removed what it can reach', { timeout: 300_000 }, async () => {
    const client = makeClient();
    try {
      const first = await computeAdaptive3dMoves(args(client));
      expect(first.moves.length).toBeGreaterThan(0);
      const message = await messageOf(computeAdaptive3dMoves(args(client, { startFromStock: first.carvedStockHandle })));
      expect(message).toBe(
        'Nothing left for this 3 mm tool: the previous rough already removed all the material it can reach.',
      );
    } finally {
      await client.dispose();
    }
  });

  it('names the stock to leave when the operator asked for some', { timeout: 300_000 }, async () => {
    const client = makeClient();
    try {
      const params = { ...DEFAULT_ADAPTIVE3D_PARAMS, maxStepdown: 3, stepover: 0.4, tolerance: 0.2, helixDiameter: 2, radialStockToLeave: 0.3 };
      const first = await computeAdaptive3dMoves(args(client, { params }));
      const message = await messageOf(computeAdaptive3dMoves(args(client, { params, startFromStock: first.carvedStockHandle })));
      expect(message).toBe(
        'Nothing left for this 3 mm tool: the previous rough already removed all the material it can reach (stock to leave 0.3 mm).',
      );
    } finally {
      await client.dispose();
    }
  });

  it('a rough from the stock box with nothing to cut keeps the stock-box text', { timeout: 300_000 }, async () => {
    const client = makeClient();
    try {
      // Boundary that excludes the whole part: a first rough with no startFromStock and no moves.
      const far = [Float64Array.of(500, 500, 510, 500, 510, 510, 500, 510)];
      const message = await messageOf(computeAdaptive3dMoves(args(client, { boundary: far })));
      expect(message).toBe(FULL_BOX_TEXT);
    } finally {
      await client.dispose();
    }
  });

  it('the committed stick rows quote the rest line, and no row still blames the stock box', () => {
    const baseline = JSON.parse(readFileSync('src/tests/benchmark/baseline.alpha3.json', 'utf8')) as {
      rows: { key: string; operatorText?: string }[] };
    expect(JSON.stringify(baseline.rows)).not.toContain(FULL_BOX_TEXT);
    const keys = [
      'stepped-boss/top-default/rough-6-flat-tool2/starter-metric-1/whole',
      'stepped-boss/top-declared/rough-6-flat-tool2/starter-metric-1/whole',
      'boss-taper-step/top-default/rough-6-flat-tool2/starter-metric-1/whole',
      'boss-taper-step/top-declared/rough-6-flat-tool2/starter-metric-1/whole',
      'engagement-pocket/rest-pencil-declared/rest-rough-4-flat/starter-metric-2/whole',
    ];
    for (const key of keys) {
      const row = baseline.rows.find(candidate => candidate.key === key);
      expect(row?.operatorText, key).toMatch(/^Nothing left for this [\d.]+ mm tool: the previous rough already removed all the material it can reach/);
    }
  });
});
