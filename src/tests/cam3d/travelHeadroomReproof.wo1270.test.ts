// WO-1270, audit fix round: the WO-407 re-proof of the PUBLISHED path keeps a
// headroom lift, the same way it keeps a reroute or a fed-down descent.
//
// The audit proved that enforceTraverseSafety gained a third way to change the
// move stream (the lift to material + LOW_TRAVEL_HEADROOM_MM) and that the
// re-proof in adaptiveRough adopted corrected moves only on the first two. A
// lift-only correction of the published path was computed, announced in the
// console, and thrown away; the un-lifted path shipped.
//
// The real guard runs here on the real feature block (pocket, bores, dome,
// boss: several regions per level, so Stay Down links exist). Two runs of a
// deterministic engine (D-006): the first finds WHICH guard call is the
// published-path re-proof (the last one, starting from no tip, whose output is
// what ships). The second hands exactly that call a STRICTER headroom than the
// level pass authored to, so its only corrections are lifts: rerouted = 0,
// descentsFedDown = 0, liftedForHeadroom > 0 -- the report shape the old
// adoption test dropped. What ships must be what the re-proof returned.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { featureBlock } from '../../cam3d/fixtures';
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough';
import { LOW_TRAVEL_HEADROOM_MM, TRAVERSE_INTRUSION_TOLERANCE_MM } from '../../cam3d/rough/traverseSafety';
import type { TraverseSafetyReport } from '../../cam3d/rough/traverseSafety';
import type { IrMove } from '../../cam3d/ir/types';

interface GuardCall {
  startedFromNoTip: boolean;
  input: IrMove[];
  output: IrMove[];
  report: TraverseSafetyReport;
}

const probe = vi.hoisted(() => ({
  calls: [] as Array<{
    startedFromNoTip: boolean;
    input: unknown[];
    output: unknown[];
    report: unknown;
  }>,
  /** Index of the one guard call that gets the stricter rule, if any. */
  strictCallIndex: undefined as number | undefined,
  strictHeadroomMm: undefined as number | undefined,
}));

vi.mock('../../cam3d/rough/traverseSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/rough/traverseSafety')>();
  // Imported here, not at the top: the factory runs while this file's static
  // imports are still initialising (adaptiveRough -> emit -> traverseSafety).
  const { typedMock } = await import('../support/typedMock');
  const enforceTraverseSafety: typeof actual.enforceTraverseSafety = (moves, input) => {
    const strict = probe.calls.length === probe.strictCallIndex && probe.strictHeadroomMm !== undefined;
    const result = actual.enforceTraverseSafety(
      moves,
      strict ? { ...input, lowTravelHeadroomMm: probe.strictHeadroomMm } : input,
    );
    probe.calls.push({
      startedFromNoTip: input.initialTip === null,
      input: moves.map((m) => ({ ...m })),
      output: result.moves.map((m) => ({ ...m })),
      report: { ...result.report },
    });
    return result;
  };
  return typedMock<typeof import('../../cam3d/rough/traverseSafety')>({ ...actual, enforceTraverseSafety });
});

const CLEARANCE_Z = 40;
const MATERIAL_TOP_Z = 27;

/** Lowest z any lateral traverse below the clearance plane travels at. */
function lowestLateralTravelZ(moves: readonly IrMove[]): number {
  let prev: { x: number; y: number; z: number } | undefined;
  let lowest = Number.POSITIVE_INFINITY;
  for (const m of moves) {
    const isTraverse = m.t === 'rapid' || m.role === 'rapid';
    if (prev && isTraverse && (prev.x !== m.x || prev.y !== m.y)) {
      const z = Math.min(prev.z, m.z);
      if (z < CLEARANCE_Z - 1e-9) lowest = Math.min(lowest, z);
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return lowest;
}

async function roughTheFeatureBlock(): Promise<{ ir: Awaited<ReturnType<typeof adaptiveRough>>; calls: GuardCall[] }> {
  probe.calls.length = 0;
  const kernel = new BvhKernel();
  const mesh = kernel.uploadMesh(featureBlock());
  try {
    const ir = await adaptiveRough(kernel, {
      mesh,
      cutter: { kind: 'flat', diameter: 6 },
      stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 40, maxZ: MATERIAL_TOP_Z },
      stockBoundsAreRealStock: true,
      cellSize: 0.5,
      maxStepdown: 5,
      stepover: 0.4,
      tolerance: 0.05,
      helixDiameter: 3,
      sideEntry: true,
      reachStockEdgeBy: 6,
      millingDirection: 'climb',
      materialTopZ: MATERIAL_TOP_Z,
      heights: { clearanceZ: CLEARANCE_Z, retractZ: 34, feedZ: 32 },
    });
    return { ir, calls: [...(probe.calls as GuardCall[])] };
  } finally {
    kernel.releaseMesh(mesh);
  }
}

describe('WO-1270 published-path re-proof keeps the headroom lift', () => {
  afterEach(() => {
    probe.strictCallIndex = undefined;
    probe.strictHeadroomMm = undefined;
    vi.restoreAllMocks();
  });

  it('ships the moves the re-proof lifted, and reports the lift on meta.params', { timeout: 300_000 }, async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Run 1, the rule as shipped: locate the re-proof. It is the last guard
    // call, it starts from no tip, and its output is the path that ships.
    const first = await roughTheFeatureBlock();
    if (process.env.WO1270_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('CALLS', JSON.stringify(first.calls.map((c) => ({
        noTip: c.startedFromNoTip, n: c.input.length, out: c.output.length, report: c.report,
      }))));
    }
    const reproofIndex = first.calls.length - 1;
    expect(reproofIndex).toBeGreaterThan(0);
    expect(first.calls[reproofIndex].startedFromNoTip).toBe(true);
    expect(first.ir.moves).toEqual(first.calls[reproofIndex].output);
    // The fixture has to have low lateral traverses for the rule to govern.
    expect(first.calls[reproofIndex].report.checked).toBeGreaterThan(0);
    expect(Number.isFinite(lowestLateralTravelZ(first.ir.moves))).toBe(true);

    // Run 2: the same job, but the re-proof judges the published path by a
    // stricter headroom than the level pass authored to. Links that are clear
    // by the rule but not by THIS much fall in the lift window and nowhere else.
    probe.strictCallIndex = reproofIndex;
    probe.strictHeadroomMm = LOW_TRAVEL_HEADROOM_MM + 1.5;
    const second = await roughTheFeatureBlock();
    expect(second.calls).toHaveLength(first.calls.length);
    const reproof = second.calls[reproofIndex];
    expect(reproof.startedFromNoTip).toBe(true);

    // The discriminating shape: nothing rerouted, nothing fed down, at least
    // one link lifted. Before the fix, this report left the adoption test
    // false and the corrected moves were discarded.
    expect(reproof.report.rerouted).toBe(0);
    expect(reproof.report.descentsFedDown).toBe(0);
    expect(reproof.report.liftedForHeadroom).toBeGreaterThan(0);
    // And the lift really changed the stream it was handed: measured on the
    // corrected path, every low traverse now keeps the stricter air, where the
    // path run 1 shipped kept only the rule's.
    expect(reproof.output).not.toEqual(reproof.input);
    expect(first.calls[reproofIndex].report.minLowTravelGapMm)
      .toBeLessThan(probe.strictHeadroomMm - TRAVERSE_INTRUSION_TOLERANCE_MM);
    expect(reproof.report.minLowTravelGapMm)
      .toBeGreaterThanOrEqual(probe.strictHeadroomMm - TRAVERSE_INTRUSION_TOLERANCE_MM);

    // What ships IS the re-proof's corrected stream, move for move -- not the
    // un-lifted path run 1 shipped.
    expect(second.ir.moves).toEqual(reproof.output);
    expect(second.ir.moves).not.toEqual(first.ir.moves);
    expect(lowestLateralTravelZ(second.ir.moves)).toBeGreaterThanOrEqual(lowestLateralTravelZ(first.ir.moves));

    // The lift is visible on the path: counted across every guard call, and
    // the smallest air any low traverse kept is a finite number.
    const liftedTotal = second.calls.reduce((n, c) => n + c.report.liftedForHeadroom, 0);
    expect(liftedTotal).toBeGreaterThanOrEqual(reproof.report.liftedForHeadroom);
    expect(second.ir.meta?.params?.traverseLiftedForHeadroom).toBe(liftedTotal);
    const gapMin = Math.min(...second.calls.map((c) => c.report.minLowTravelGapMm));
    expect(Number.isFinite(gapMin)).toBe(true);
    expect(second.ir.meta?.params?.minLowTravelGapMm).toBe(gapMin);
  });
});
