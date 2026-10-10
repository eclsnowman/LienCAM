// WO-278 - the holder crash check must not stop at the 2D strategies.
//
// WO-278 closed the gap where a 3D job with a short holder heard nothing. It did
// it with a refusal inside each 3D adapter. WO-1678 replaced those per-strategy
// gates with ONE seam: every 3D strategy returns every move it plans, and the
// store trims the result to what the tool assembly reaches
// (trimToToolReachInPartFrame) with the same function and the same words the 2D
// worker uses. Rule 11: nothing refuses what the software can cut.
//
// These tests pin that shut:
//
//  1. A real Adaptive 3D and Parallel 3D job whose holder would hit the block
//     comes back whole from the strategy - no refusal - and the seam trims it,
//     naming the holder, in the 2D worker's words (only the operation name
//     differs). The SAME job with enough stickout is not trimmed at all.
//  2. No 3D adapter carries a reach check or a clearance primitive of its own.
//  3. A setup with no resolvable stock still computes and still says it was not
//     proved clear. WO-1626 (Operator, 2026-09-16): a tool with no holder, or no
//     stickout, computes quietly instead - that is the operator's decision,
//     not ours to flag.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceOutDir } from '../helpers/evidenceScratch';

import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
} from '../../cam3d/integration/adaptive3dOperation';
import {
  computeParallel3dMoves,
  DEFAULT_PARALLEL3D_PARAMS,
} from '../../cam3d/integration/parallel3dOperation';
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs';
import type { PartMesh } from '../../cam3d/kernel/types';
import type { Box3 } from '../../cam3d/stock';
import type { Cam3dClient } from '../../cam3d/worker/client';
import type { IrMove } from '../../cam3d/ir/types';
import type { Tool, ToolHolder, ToolpathMove } from '../../types';

// ── The stock, the part, the tool and the holder ─────────────────────────────
// A 60 x 60 x 10 mm block whose top sits at z = 10 in the part's display-local
// frame, so a move's depth below the top of the stock is 10 - z. The part the
// seam keeps the tool clear of is a slab under the cut, so only the block can
// stop the holder.

const STOCK: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 10 };

const PART_MESH: PartMesh = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 60, 10]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [60, 60, 10] },
  source: 'fixture',
};

/** A closed 60 x 60 x 1 mm slab at the bottom of the block. */
const SLAB = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 60, 0, 60, 60, 0, 0, 0, 1, 60, 0, 1, 0, 60, 1, 60, 60, 1]),
  indices: new Uint32Array([
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5,
  ]),
};

const HOLDER: ToolHolder = {
  id: 'holder-1',
  name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
};

/** Depth of the deepest move below the top of the block, mm. */
const CUT_DEPTH_MM = 8;
const FLOOR_Z = STOCK.maxZ - CUT_DEPTH_MM;

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 5, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 1.5 },
    },
    ...overrides,
  } as unknown as Tool;
}

/** A short path that rapids in above the block and then cuts at the floor. */
const IR_MOVES: IrMove[] = [
  { t: 'rapid', x: 30, y: 30, z: 15, role: 'rapid' },
  { t: 'feed', x: 30, y: 30, z: FLOOR_Z, role: 'plunge' },
  { t: 'feed', x: 40, y: 30, z: FLOOR_Z, role: 'cut' },
];

function adaptiveClient(): Cam3dClient {
  return {
    generateAdaptiveRough: async () => ({
      ir: {
        moves: IR_MOVES,
        meta: { strategyId: 'adaptive_rough', cutterId: 'wo278', params: { floorZ: FLOOR_Z } },
      },
    }),
  } as unknown as Cam3dClient;
}

function parallelClient(): Cam3dClient {
  return {
    generateParallelFinish: async () => ({
      moves: IR_MOVES,
      meta: { strategyId: 'parallel_finish', cutterId: 'wo278' },
    }),
  } as unknown as Cam3dClient;
}

async function adaptiveMoves(stickoutMm: number): Promise<ToolpathMove[]> {
  const result = await computeAdaptive3dMoves({
    partMesh: PART_MESH,
    tool: tool({ lengthBelowHolder: stickoutMm }),
    params: { ...DEFAULT_ADAPTIVE3D_PARAMS, cellSize: 1 },
    stockBounds: STOCK,
    stockBoundsAreRealStock: true,
    resolvedHeights: { clearanceZ: 15, retractZ: 12, feedZ: 12, topZ: 10, bottomZ: 0 },
    client: adaptiveClient(),
  });
  return result.moves;
}

async function parallelMoves(stickoutMm: number): Promise<ToolpathMove[]> {
  const result = await computeParallel3dMoves({
    partMesh: PART_MESH,
    tool: tool({ lengthBelowHolder: stickoutMm }),
    params: { ...DEFAULT_PARALLEL3D_PARAMS },
    resolvedHeights: {
      clearanceZ: 15, retractZ: 12, feedZ: 12, topZ: 10, bottomZ: 0, stockTopZ: STOCK.maxZ,
    },
    client: parallelClient(),
  });
  return result.moves;
}

/** The store's seam, as every 3D compute calls it straight after its strategy. */
function seam(
  operation: string,
  moves: readonly ToolpathMove[],
  options: { stickoutMm: number; holder?: ToolHolder | undefined; stockBounds?: Box3 | undefined },
) {
  return trimToToolReachInPartFrame({
    operation,
    moves,
    tool: tool({ lengthBelowHolder: options.stickoutMm }),
    ...('holder' in options ? (options.holder ? { holder: options.holder } : {}) : { holder: HOLDER }),
    ...('stockBounds' in options
      ? (options.stockBounds ? { stockBounds: options.stockBounds } : {})
      : { stockBounds: STOCK }),
    part: SLAB,
    partToleranceMm: 0.05,
    params: {},
    workholding: [],
    noEarlierOperations: true,
  });
}

const JOBS = [['Adaptive 3D', adaptiveMoves], ['Parallel 3D', parallelMoves]] as const;

// ── 1. A holder that would hit the block is trimmed, never refused ───────────

describe('WO-278 / WO-1678 a 3D job whose holder would hit the block', () => {
  for (const [label, job] of JOBS) {
    it(`${label}: the strategy returns every move, and the seam trims where the holder would meet the stock`, async () => {
      const moves = await job(5);
      expect(moves).toHaveLength(3);
      const reach = seam(label, moves, { stickoutMm: 5 });

      // Nothing below the reach of a 5 mm stickout survives: tip >= 10 - 5 + 0.25.
      const deepest = Math.min(...reach.moves.map((move) => move.z));
      expect(deepest).toBeGreaterThanOrEqual(STOCK.maxZ - 5 + 0.25 - 1e-6);
      const stops = reach.notices.filter((notice) => /cut stopped at/.test(notice));
      expect(stops.length).toBeGreaterThan(0);
      expect(stops[0]).toMatch(new RegExp(
        `^${label}: cut stopped at X [\\d.-]+ Y [\\d.-]+ Z [\\d.-]+ - the holder would come within 0\\.25 mm of the stock\\. ` +
        '[\\d.]+ mm of cutting path was left uncut, .*; reached Z [\\d.]+ of Z [\\d.]+ asked; ' +
        'a tool with a longer reach cuts the rest\\.$',
      ));
    });

    it(`${label}: the same job with enough stickout is not trimmed at all`, async () => {
      const moves = await job(CUT_DEPTH_MM + 4);
      const reach = seam(label, moves, { stickoutMm: CUT_DEPTH_MM + 4 });
      expect(reach.moves).toEqual(moves);
      expect(reach.notices).toEqual([]);
      expect(Math.min(...reach.moves.map((move) => move.z))).toBeCloseTo(FLOOR_Z, 6);
    });
  }

  it('says the same thing on both sides, differing only in the operation name', async () => {
    const adaptive = seam('Adaptive 3D', await adaptiveMoves(5), { stickoutMm: 5 }).notices;
    const parallel = seam('Parallel 3D', await parallelMoves(5), { stickoutMm: 5 }).notices;
    expect(adaptive.map((line) => line.replace(/^Adaptive 3D/, '')))
      .toEqual(parallel.map((line) => line.replace(/^Parallel 3D/, '')));
  });
});

// ── 2. No 3D adapter carries a reach check of its own ────────────────────────

describe('WO-1678 no 3D strategy carries its own reach check', () => {
  it('no adapter imports the gate or a clearance primitive', () => {
    const dir = join(process.cwd(), 'src', 'cam3d', 'integration');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const forbidden of [
        'holderClearanceGate', 'checkHolderAndShankClearance', 'trimToolpathToAssemblyReach',
        'holderClearanceWarning',
      ]) {
        expect(source, `${file} must not carry its own reach check (${forbidden})`).not.toContain(forbidden);
      }
    }
  });
});

// ── 3. Not checked is not clear ──────────────────────────────────────────────

describe('WO-278 / WO-1678 a 3D job that could not be checked is never reported clear', () => {
  it("with no holder the job still runs quietly - it is the operator's choice, not ours to flag (WO-1626)", async () => {
    const moves = await adaptiveMoves(5);
    const reach = seam('Adaptive 3D', moves, { stickoutMm: 5, holder: undefined });
    // Operator ruling 2026-09-16: no holder component to check, so nothing to say - not
    // even to the developer console. The job runs exactly as the strategy
    // planned it.
    expect(reach.moves).toEqual(moves);
    expect(reach.notices).toEqual([]);
    expect(reach.uncheckedLimits).toEqual([]);
  });

  it('with no stock the job still runs, kept clear of the part only, and says so', async () => {
    const reach = seam('Parallel 3D', await parallelMoves(5), { stickoutMm: 5, stockBounds: undefined });
    expect(reach.moves.length).toBeGreaterThan(0);
    expect(reach.uncheckedLimits.join(' ')).toContain('no stock was known, so the tool was kept clear of the part only');
  });

  it("with no stickout the job also runs quietly - the operator's choice, not ours to flag (WO-1626)", async () => {
    const moves = await parallelMoves(CUT_DEPTH_MM + 4);
    const reach = trimToToolReachInPartFrame({
      operation: 'Parallel 3D',
      moves,
      tool: tool({ lengthBelowHolder: undefined }),
      holder: HOLDER,
      stockBounds: STOCK,
      part: SLAB,
      partToleranceMm: 0.05,
      params: {},
      workholding: [],
      noEarlierOperations: true,
    });
    expect(reach.moves).toEqual(moves);
    expect(reach.notices).toEqual([]);
    expect(reach.uncheckedLimits).toEqual([]);
  });
});

// ── 4. The capture Operator judges the wording by (Tier 1 evidence) ──────────────

describe('WO-278 evidence', () => {
  it('captures what the machinist sees on a 3D job', async () => {
    const adaptiveStop = seam('Adaptive 3D', await adaptiveMoves(5), { stickoutMm: 5 }).notices
      .find((notice) => /cut stopped at/.test(notice)) ?? '';
    const parallelStop = seam('Parallel 3D', await parallelMoves(5), { stickoutMm: 5 }).notices
      .find((notice) => /cut stopped at/.test(notice)) ?? '';
    const quiet = seam('Adaptive 3D', await adaptiveMoves(5), { stickoutMm: 5, holder: undefined });
    expect(quiet.notices).toEqual([]);

    const capture = [
      'WO-278 - what the machinist sees when a 3D job would drive the holder into',
      'the stock. Same check, same module and the same words as the 2D strategies',
      'have used since WO-276 (see ../WO-276/holder-crash-message.txt); only the',
      'operation name differs. WO-1678: the strategy is never refused - the seam',
      'trims the cut short and says so.',
      '',
      'Generated by src/tests/cam3d/holderClearance3d.wo278.test.ts on the same run',
      'that asserts it, so it cannot drift from the product.',
      '',
      `The job: a 60 x 60 x 10 mm block, a 6 mm flat end mill in an ER20 chuck with`,
      `${CUT_DEPTH_MM - 3}.000 mm of stickout, cutting to ${CUT_DEPTH_MM}.000 mm below the top of the block.`,
      '',
      '1. ADAPTIVE 3D (rough) - trimmed; the cut stops short of the holder:',
      '',
      adaptiveStop,
      '',
      '2. PARALLEL 3D (finish) - trimmed, in the same words:',
      '',
      parallelStop,
      '',
      '3. QUIET (WO-1626) - the tool has no holder assigned. That is the',
      '   operator\'s decision, not a fault: the operation reports ready and says',
      '   nothing about the holder:',
      '',
      '(no message - the operation reported ready)',
      '',
    ].join('\n');

    const dir = evidenceOutDir(join(process.cwd(), 'src', 'tests', 'evidence', 'WO-278'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'holder-crash-message-3d.txt'), capture, 'utf8');

    expect(capture).toContain('Adaptive 3D: cut stopped at');
    expect(capture).toContain('Parallel 3D: cut stopped at');
  });
});
