// WO-200: exercise authoritative stock proof through the production CAM3D
// adapter, worker protocol, strategy, and emitted moves.

import { describe, expect, it, vi } from 'vitest';

import { engagementPocket } from '../../cam3d/fixtures';
import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
} from '../../cam3d/integration/adaptive3dOperation';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { ZDexelField, maxTraverseIntrusion, removeSweep, type LinearMove } from '../../cam3d/stock';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling';
import type { Tool, ToolpathMove } from '../../types';

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel();
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    worker.onmessage?.({ data: message } as MessageEvent);
  });
  return new Cam3dClient(worker);
}

const TOOL: Tool = {
  id: 'tool-flat-3-wo200',
  name: 'Flat 3 mm',
  type: 'flat_end_mill',
  diameter: 3,
  fluteLength: 15,
  shankDiameter: 3,
  overallLength: 40,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
};

const CUTTER: CutterSpec = { kind: 'flat', diameter: 3 };
const CELL = 1;
const STOCK_BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 90, maxY: 60, maxZ: 16 };
const PARAMS = {
  ...DEFAULT_ADAPTIVE3D_PARAMS,
  maxStepdown: 4,
  tolerance: 0.2,
  cellSize: CELL,
};
const HEIGHTS = { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5, topZ: 16, bottomZ: 0 };

function isTraverse(move: ToolpathMove): boolean {
  return move.type === 'rapid' || move.role === 'rapid';
}

function measureEmittedPath(moves: readonly ToolpathMove[], clearanceZ: number): {
  lowLinks: number;
  worstTraverseIntrusionMm: number;
} {
  const field = ZDexelField.fromBox(STOCK_BOUNDS, CELL);
  let previous: { x: number; y: number; z: number } | null = null;
  let lowLinks = 0;
  let worstTraverseIntrusionMm = Number.NEGATIVE_INFINITY;

  for (const move of moves) {
    if (previous !== null) {
      const sweep: LinearMove = {
        x0: previous.x,
        y0: previous.y,
        z0: previous.z,
        x1: move.x,
        y1: move.y,
        z1: move.z,
      };
      const lateral = previous.x !== move.x || previous.y !== move.y;
      if (isTraverse(move)) {
        const hit = maxTraverseIntrusion(field, sweep, CUTTER);
        if (hit.intrusionMm > worstTraverseIntrusionMm) {
          worstTraverseIntrusionMm = hit.intrusionMm;
        }
        if (lateral && Math.min(previous.z, move.z) < clearanceZ) lowLinks++;
      } else if (isStockCuttingRole(effectiveMoveRole({ type: move.type, role: move.role }))) {
        removeSweep(field, sweep, CUTTER);
      }
    }
    previous = { x: move.x, y: move.y, z: move.z };
  }

  return { lowLinks, worstTraverseIntrusionMm };
}

describe('WO-200 production stock-proof channel', () => {
  it('preserves proven Stay Down while emitted rapids stay under the accepted ceiling', { timeout: 300_000 }, async () => {
    const client = makeClient();
    try {
      const result = await computeAdaptive3dMoves({
        partMesh: engagementPocket(),
        tool: TOOL,
        params: PARAMS,
        stockBounds: STOCK_BOUNDS,
        stockBoundsAreRealStock: true,
        resolvedHeights: HEIGHTS,
        client,
      });
      // The published IR is arc-fitted; a chord replay of an arc under-carves
      // (WO-407 read 3.95 mm here from exactly that). Sample the arcs finely
      // before replaying, as every linear consumer of these moves must.
      const linear = sampleArcMovesForLinearConsumers(result.moves, { maxChordMm: 0.25, maxAngleDeg: 2 });
      const measured = measureEmittedPath(linear, result.heightTruth.clearanceZ);
      expect(measured.lowLinks).toBeGreaterThan(0);
      // Operator accepted up to 0.01 mm of brief engagement. The implementation's
      // existing 0.001 mm threshold remains ten times tighter.
      expect(measured.worstTraverseIntrusionMm).toBeLessThanOrEqual(0.01);
    } finally {
      await client.dispose();
    }
  });

  it('does not dispatch an omitted stock proof as though coverage were verified', async () => {
    const generateAdaptiveRough = vi.fn();
    const client = { generateAdaptiveRough } as unknown as Cam3dClient;
    await expect(computeAdaptive3dMoves({
      partMesh: engagementPocket(),
      tool: TOOL,
      params: PARAMS,
      stockBounds: STOCK_BOUNDS,
      resolvedHeights: HEIGHTS,
      client,
    })).rejects.toThrow(/can't tell which block of stock the part is cutting in/);
    expect(generateAdaptiveRough).not.toHaveBeenCalled();
  });
});
