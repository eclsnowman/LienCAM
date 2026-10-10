// WO-131 gate: "Enter from stock edge" (side entry) must produce ADAPTIVE moves,
// never a full-width slot around the perimeter.
//
// THE RULE THIS ENFORCES (Operator, WO-100):
//   "No move emitted by an adaptive strategy may exceed the strategy's engagement
//    limit. If a region cannot be cleared within that limit, it must not be silently
//    cut at full width -- either it is entered differently, or it is reported, but it
//    is never quietly turned into a slot."
// So each case below asserts the DISJUNCTION: the run either refuses loudly, or every
// sustained window of its emitted path stays under the cap. What it may never do is
// return a toolpath that slots.
//
// The bound is measured on the EMITTED PATH (measurePathEngagement), not asserted as
// an intention inside the generator: replay every move into a fresh z-dexel stock and
// take the peak 2mm-windowed engagement, as a fraction of a full-width slot with the
// same cutter at the same axial depth. Same metric as Gate A.2 in roughGateA and as the
// 2D engine's own B8 ride gate. Every case here runs a FLAT cutter, for which that
// normaliser is exactly diameter * depth -- so the percentages below are also literally
// radial cut width over tool diameter. Ball cutters (which adaptiveRough also accepts)
// need the sphere profile instead, and are pinned in pathEngagementCutterProfile.test.ts.
//
// CAP 0.75 of tool diameter, inherited from Gate A.2's investigation: bounded corner
// engagement of a legitimate adaptive spiral measured 0.64 there, and the wide-ring
// cases below measure 0.49-0.63, while a genuine perimeter slot measures ~0.98. The
// cap cleanly separates the two; it is not slack to hide a systematic offset.
//
// FIXTURE: bossInOpenStock -- a single square part in open stock, exactly the shape
// the setting's help text says side entry applies to. The ring width is the variable
// that matters: with a 9.52mm cutter a 10mm ring leaves a 0.43mm tool-centre corridor
// (ringWidth - 2*(toolRadius + tolerance/2)), which has no lateral room at all, while
// an 11mm ring has no interior seed but emits a bounded outside-in path, and a
// 15mm ring leaves 5.4mm and steers normally. The 11mm transition prevents the
// safety check from treating a failed interior-entry search as proof of slotting.
//
// PROVENANCE: parameters are Operator's own from
// Adaptive_Clearing_Potential_Crash.camproject (9.52mm flat, stepover 0.4, tolerance
// 0.05, helixDiameter 3, maxStepdown 3); part 80x80x14 in stock 100x100x15 per WO-100
// (shrunk to a 60x60x6 stock with the same ring widths by WO-408 - see STOCK_XY).
// The 100x100 ring is still reachable for a once-per-session look through
// `SIDE_ENTRY_PROBE=1 ... _sideEntrySlots.probe.test.ts`.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import { typedMock } from '../support/typedMock';

// RING_PLAN_DUMP=<path.json>: record every 2D level-plan request (feature AND params) the
// 3D rougher makes during these cases, for the 5-second 2D replay loop (WO-409/WO-410
// pattern; same seam as _exampleGenerate.probe.test.ts). Engine untouched without the env.
const ringPlanDumpPath = process.env.RING_PLAN_DUMP;
const ringPlanRequests: unknown[] = [];
vi.mock('../../lib/cam/adaptiveClearing2d/engine/processFeature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/adaptiveClearing2d/engine/processFeature')>();
  return typedMock<typeof import('../../lib/cam/adaptiveClearing2d/engine/processFeature')>({
    ...actual,
    ...(process.env.RING_PLAN_DUMP ? {
      processFeature: (feature: unknown, params: unknown) => {
        const res = actual.processFeature(feature as never, params as never);
        ringPlanRequests.push({ feature, params, passes: res.passes.length, aborted: res.stats.aborted ?? null });
        fs.writeFileSync(ringPlanDumpPath!, JSON.stringify(ringPlanRequests));
        return res;
      },
    } : {}),
  });
});

import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { ZDexelField } from '../../cam3d/stock';
import type { Box3 } from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { measurePathEngagement } from '../../cam3d/rough';
import * as roughModule from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import type { ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

// WO-408: stock 100 x 100 x 15 / part z 14 (five 3 mm levels) -> 60 x 60 x 6 /
// part z 5 (two levels). The ring WIDTH is the variable under test and is
// unchanged (10 / 11 / 15 mm with the same 9.52 mm cutter at the same cell);
// the ring's length and the level count carry no part of the question. Five
// full roughs of the 100 x 100 ring were ~140 s.
const STOCK_XY = 60;
const STOCK_Z = 6;
const PART_Z = 5;
const CELL = 0.79; // Operator's run reported effectiveCellSize 0.7933
const CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 };
const MAX_STEPDOWN = 3;
const CAP = 0.75; // fraction of tool diameter -- see header

/** Run the 3D adaptive rougher over a boss-in-open-stock with the given ring width. */
async function roughRing(
  ringWidth: number,
  sideEntry: boolean,
  // WO-1252: the two declarations about the stock that an earlier attempt on this
  // order wrongly made part of the refusal condition. Defaults are the proven
  // full-stock job every case above runs.
  stock?: { stockBoundsAreRealStock?: false; startFromStock?: ZDexelField },
): Promise<{ ir: ToolpathIR | null; refusal: string | null; stockBounds: Box3 }> {
  const partXY = STOCK_XY - 2 * ringWidth;
  const mesh = bossInOpenStock({ x: STOCK_XY, y: STOCK_XY }, { x: partXY, y: partXY, z: PART_Z });
  const stockBounds: Box3 = {
    minX: 0, minY: 0, minZ: 0, maxX: STOCK_XY, maxY: STOCK_XY, maxZ: STOCK_Z,
  };
  const handle = kernel.uploadMesh(mesh);
  try {
    const input: AdaptiveRoughInput = {
      mesh: handle,
      cutter: CUTTER,
      stockBounds,
      ...(stock?.stockBoundsAreRealStock === false ? {} : { stockBoundsAreRealStock: true }),
      ...(stock?.startFromStock !== undefined ? { startFromStock: stock.startFromStock } : {}),
      cellSize: CELL,
      maxStepdown: MAX_STEPDOWN,
      stepover: 0.4,
      tolerance: 0.05,
      helixDiameter: 3,
      heights: { clearanceZ: STOCK_Z + 5, retractZ: STOCK_Z + 1, feedZ: STOCK_Z + 1 },
      materialTopZ: stockBounds.maxZ,
      ...(sideEntry ? { sideEntry: true } : {}),
    };
    return { ir: await adaptiveRough(kernel, input), refusal: null, stockBounds };
  } catch (e) {
    return { ir: null, refusal: (e as Error).message, stockBounds };
  } finally {
    kernel.releaseMesh(handle);
  }
}

/** Measure + report; returns null when the run refused (nothing to measure). */
function report(
  label: string,
  run: { ir: ToolpathIR | null; refusal: string | null; stockBounds: Box3 },
): ReturnType<typeof measurePathEngagement> | null {
  if (run.ir === null) {
    // eslint-disable-next-line no-console
    console.log(`${label}: REFUSED -- ${run.refusal}`);
    return null;
  }
  const m = measurePathEngagement(run.ir.moves, run.stockBounds, CELL, CUTTER, {
    capFraction: CAP,
    ...(process.env.RING_OVERCAP_DEBUG ? {
      onOverCap: (hit: { x: number; y: number; z: number; role: string; lengthMm: number; fraction: number }) => {
        // eslint-disable-next-line no-console
        console.log(`[ring-overcap] ${label} role ${hit.role} at (${hit.x.toFixed(2)}, ${hit.y.toFixed(2)}, z ${hit.z.toFixed(2)}) len ${hit.lengthMm.toFixed(2)} frac ${(hit.fraction * 100).toFixed(0)}%`);
      },
    } : {}),
  });
  const at = m.peakAt;
  // eslint-disable-next-line no-console
  console.log(
    `${label}: ${run.ir.moves.length} moves; peak sustained radial ` +
    `${(m.peakFraction * 100).toFixed(1)}% of tool diameter` +
    (at ? ` at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, z=${at.z.toFixed(1)})` : '') +
    `; ${m.overCapLengthMm.toFixed(0)}mm of ${m.cuttingLengthMm.toFixed(0)}mm cutting path ` +
    `over the ${(CAP * 100).toFixed(0)}% cap`,
  );
  return m;
}

describe('WO-131: side entry refusal follows measured engagement', () => {
  it(
    'narrow perimeter ring (10mm, 9.52mm cutter): side entry refuses rather than cutting full width',
    { timeout: 900000 },
    async () => {
      const run = await roughRing(10, true);
      const m = report('ring 10mm sideEntry=ON', run);
      if (m === null) {
        // Refusal branch: it must be the emitted-path engagement gate, not the
        // unrelated interior-entry search or an incidental crash.
        expect(run.refusal).toMatch(/side-entry path exceeded the sustained engagement cap/);
        return;
      }
      // Toolpath branch: whatever it emitted must respect the engagement limit.
      expect(m.overCapLengthMm).toBe(0);
      expect(m.peakFraction).toBeLessThanOrEqual(CAP);
    },
  );

  it(
    'transition perimeter ring (11mm): side entry machines it based on measured engagement',
    { timeout: 900000 },
    async () => {
      const run = await roughRing(11, true);
      const m = report('ring 11mm sideEntry=ON', run);
      expect(run.refusal).toBeNull();
      expect(m).not.toBeNull();
      expect(m!.cuttingLengthMm).toBeGreaterThan(4 * STOCK_XY);
      expect(Math.min(...run.ir!.moves.map(move => move.z))).toBe(0);
      expect(m!.overCapLengthMm).toBe(0);
      expect(m!.peakFraction).toBeLessThanOrEqual(CAP);
    },
  );

  it(
    'narrow perimeter ring (10mm): side entry OFF also refuses -- ON and OFF agree on what is machinable',
    { timeout: 900000 },
    async () => {
      // Green since WO-1252 via the REFUSAL branch, not the toolpath branch:
      // the corridor is still unmachinable (WO-410's path-quality debt is
      // untouched), but the refusal row of the engagement contract no longer
      // asks which entry mode built the path. Do not re-pin the toolpath branch.
      const run = await roughRing(10, false);
      const m = report('ring 10mm sideEntry=OFF', run);
      if (m === null) {
        // Refusal branch: any loud refusal that names the reason is acceptable --
        // historically 'no-start-point', later the emitter's live-stock plunge gate.
        expect(run.refusal).toMatch(
          /no-start-point|refusing a straight plunge|exceeded the sustained engagement cap/,
        );
        return;
      }
      // Toolpath branch: whatever it emitted must respect the engagement limit.
      expect(m.overCapLengthMm).toBe(0);
      expect(m.peakFraction).toBeLessThanOrEqual(CAP);
    },
  );

  it(
    'workable perimeter ring (15mm): side entry still machines it, within the engagement limit',
    { timeout: 900000 },
    async () => {
      const run = await roughRing(15, true);
      const m = report('ring 15mm sideEntry=ON', run);
      // This case is the guard against "fix it by disabling side entry": side entry
      // must still produce a real toolpath where the corridor genuinely admits one.
      expect(run.refusal).toBeNull();
      expect(m).not.toBeNull();
      expect(m!.cuttingLengthMm).toBeGreaterThan(4 * STOCK_XY);
      expect(Math.min(...run.ir!.moves.map(move => move.z))).toBe(0);
      expect(m!.overCapLengthMm).toBe(0);
      expect(m!.peakFraction).toBeLessThanOrEqual(CAP);
    },
  );

  it(
    'workable perimeter ring (15mm): side entry OFF is bounded too (the ON/OFF comparison)',
    { timeout: 900000 },
    async () => {
      const warning = vi.spyOn(console, 'warn');
      try {
        const run = await roughRing(15, false);
        const m = report('ring 15mm sideEntry=OFF', run);
        expect(run.refusal).toBeNull();
        expect(m!.overCapLengthMm).toBe(0);
        expect(m!.peakFraction).toBeLessThanOrEqual(CAP);
        expect(warning.mock.calls.filter(args => String(args[0]).includes('interior-entry path exceeded'))).toHaveLength(0);
      } finally {
        warning.mockRestore();
      }
    },
  );
});

// Keep the reporting contract separate from the WO-410 path-quality debt.
//
// RE-PINNED BY WO-1252, and the contract row that moved it is the REFUSAL row:
// "one unbroken over-cap run > the 2mm transient allowance -> loud refusal, no
// path", which stopped being conditioned on the entry mode. Its previous name was
// "...reports overload once without refusing", and it pinned exactly the behaviour
// WO-1252 removes: this same 10mm ring measured 331.7mm over the cap, 19.4mm of it
// in one unbroken stretch, and was still published with only a console line,
// because it was entered from the interior.
// What survives unchanged is the MEASUREMENT contract WO-1233 built - the numbers
// in the message are measured on the move array actually published, not on the
// planner's intent - so that is what this test still proves, now read off the
// refusal instead of off a warning. The REPORT row is pinned by the 0.4mm
// short-exceedance test below; deleting this one would drop the only proof that a
// sustained interior overload refuses.
it('WO-1252 refuses the published interior path once its measured overload exceeds the transient allowance',
  { timeout: 900000 }, async () => {
    const measured = vi.spyOn(roughModule, 'measurePathEngagement');
    const warning = vi.spyOn(console, 'warn');
    try {
      const run = await roughRing(10, false);
      expect(run.ir, 'a path over the sustained cap must not be published').toBeNull();
      expect(run.refusal).toMatch(/interior-entry path exceeded the sustained engagement cap/);
      // The refusal's numbers are the measurement of the moves it declined to
      // publish: take the exact array the strategy measured and re-measure it.
      const call = measured.mock.calls.length - 1;
      expect(call, 'the strategy must have measured a published move array').toBeGreaterThanOrEqual(0);
      const moves = measured.mock.calls[call][0];
      const result = measured.mock.results[call].value as ReturnType<typeof measurePathEngagement>;
      const replay = measurePathEngagement(moves, run.stockBounds, CELL, CUTTER, { capFraction: CAP });
      expect(result).toEqual(replay);
      expect(replay.overCapLengthMm).toBeGreaterThan(2);
      // The quantity the interior refusal row actually reads: this corridor is
      // refused for cutting over the cap WITHOUT INTERRUPTION for longer than the
      // transient allowance, not merely for totalling that much across the job.
      expect(replay.longestOverCapRunMm).toBeGreaterThan(2);
      expect(run.refusal).toContain(`peak ${(replay.peakFraction * 100).toFixed(1)}%`);
      expect(run.refusal).toContain(`${replay.overCapLengthMm.toFixed(1)}mm of ${replay.cuttingLengthMm.toFixed(1)}mm`);
      expect(run.refusal).toContain(`X${replay.peakAt!.x.toFixed(1)} Y${replay.peakAt!.y.toFixed(1)} Z${replay.peakAt!.z.toFixed(1)}`);
      // A refusal a user cannot act on is half a defect: an interior refusal
      // names WHERE, the same way a side-entry refusal always has.
      const runs = warning.mock.calls.map(args => String(args[0]))
        .filter(line => line.startsWith('[interior-entry] over-cap run:'));
      expect(runs.length, 'an interior refusal must list its over-cap runs').toBeGreaterThan(0);
      expect(runs.length).toBeLessThanOrEqual(40);
      // ...and it refused instead of reporting: no path was handed over, so the
      // report row's "still emitted" line must not appear. Matched on that row's
      // OWN prefix, not on its explanatory tail - the tail is prose and a
      // reworded one would make this assertion pass by matching nothing at all.
      expect(warning.mock.calls.map(args => String(args[0]))
        .filter(line => line.startsWith('[adaptive-rough] '))).toHaveLength(0);
    } finally {
      measured.mockRestore();
      warning.mockRestore();
    }
  });

// Explicit evidence run only: the normal focused slice does not re-plan the corpus.
it.skipIf(process.env.WO1233_CORPUS !== '1')('WO-1233 published benchmark census',
  { timeout: 900000 }, async () => {
    const { chainsForTier, WHOLE_PART } = await import('../benchmark/registry');
    const rows: unknown[] = [];
    let chainId = '';
    const path = 'src/tests/evidence/WO-1233/main-published-adaptive.json';
    const source = 'src/cam3d/strategies/adaptiveRough.ts';
    const { execFileSync } = await import('node:child_process');
    const baseline = execFileSync('git', ['show', `1ce6781a1f38b7e599924bff45d50bb37996fc5b:${source}`], { encoding: 'utf8' });
    expect(fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n') === baseline.replace(/\r\n/g, '\n'),
      'main evidence requires the unchanged baseline strategy').toBe(true);
    fs.rmSync(path, { force: true });
    // Observe returned adaptive IR without changing inputs, geometry or policy.
    // This also catches the adaptive rest-stock builds inside parallel finish;
    // applying a level-based metric to the final parallel path is invalid.
    vi.doMock('../../cam3d/strategies/adaptiveRough', async () => {
      const actual = await vi.importActual<typeof import('../../cam3d/strategies/adaptiveRough')>('../../cam3d/strategies/adaptiveRough');
      return typedMock<typeof import('../../cam3d/strategies/adaptiveRough')>({ ...actual, adaptiveRough: async (...args: Parameters<typeof actual.adaptiveRough>) => {
        const ir = await actual.adaptiveRough(...args);
        const input = args[1];
        const { useCamStore } = await import('../../store');
        const active = useCamStore.getState().project.setups.flatMap(setup => setup.operations)
          .filter(op => op.status === 'computing').map(op => op.id);
        expect(active.length, 'attribute each adaptive output to its computing operation').toBeGreaterThan(0);
        const result = measurePathEngagement(ir.moves, input.stockBounds, input.cellSize, input.cutter, { capFraction: CAP });
        rows.push({ chain: chainId, operations: active, cutter: input.cutter, cell: input.cellSize,
          sideEntry: input.sideEntry === true, retainedStock: !!input.startFromStock,
          stockReference: 'uncut box; NOT actual rest stock', ...result });
        fs.writeFileSync(path, JSON.stringify(rows, null, 2) + '\n');
        return ir;
      } });
    });
    const { planChain } = await import('../benchmark/chainRunner');
    const chains = [...new Map([...chainsForTier('smoke'), ...chainsForTier('full')].map(c => [c.id, c])).values()];
    const pocket = chains.find(c => c.id === 'engagement-pocket-rest-pencil')!;
    // WO-1219's suppression cases: same rough steps, with the explicit rest
    // finish toggle. Kept here to enumerate the path that a hard gate hid.
    for (const includeRest of [true, false]) {
      chains.push({
        ...pocket, id: `wo1219-suppress-${includeRest ? 'before' : 'after'}`, setupLabel: 'wo1219-suppress',
        steps: [
          ...pocket.steps.filter(s => s.type === 'adaptive_3d' && (includeRest || s.id === 'rough-6-flat')),
          { id: 'rest-finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART,
            params: { stepover: 1, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false,
              restMachining: true, stockSource: 'previous_operations', stockToLeave: 0, stepdown: 3, direction: 'climb' },
            stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2 },
        ],
      });
    }
    try {
      for (const chain of chains) {
        chainId = chain.id;
        const before = rows.length;
        const planned = await planChain(chain);
        expect(rows.length, `capture adaptive outputs for ${chain.id}`).toBeGreaterThan(before);
        console.log(`[WO-1233 census] ${chain.id}: ${planned.steps.length} published operations inspected`);
      }
    } finally {
      vi.doUnmock('../../cam3d/strategies/adaptiveRough');
    }
    expect(rows.length).toBeGreaterThan(0);
  });


it('WO-1233 reports short interior exceedances while preserving the side-entry transient allowance',
  { timeout: 900000 }, async () => {
    // A policy control, not a geometric finding: measured short exceedances
    // must be visible for interior jobs without making side entry refuse.
    const measurement = vi.spyOn(roughModule, 'measurePathEngagement').mockReturnValue({
      // WO-1252 added the field, not an assertion: one 0.4 mm blip is the whole
      // over-cap length AND the whole longest unbroken run, so this control reads
      // identically under either refusal row and every expectation below is the
      // one WO-1233 wrote.
      peakFraction: 0.8, overCapLengthMm: 0.4, longestOverCapRunMm: 0.4, cuttingLengthMm: 100,
      peakAt: { x: 1, y: 2, z: 3 }, capFraction: CAP,
    });
    const warning = vi.spyOn(console, 'warn');
    try {
      const interior = await roughRing(15, false);
      expect(interior.refusal).toBeNull();
      const messages = warning.mock.calls.filter(args => String(args[0]).includes('interior-entry path exceeded'));
      expect(messages).toHaveLength(1);
      expect(messages[0][0]).toContain('0.4mm of 100.0mm');
      warning.mockClear();
      const side = await roughRing(15, true);
      expect(side.refusal).toBeNull();
      expect(warning.mock.calls.filter(args => String(args[0]).includes('path exceeded'))).toHaveLength(0);
    } finally {
      measurement.mockRestore();
      warning.mockRestore();
    }
  });

// WO-1252, ROW 2b: an interior job refuses on `longestOverCapRunMm > the 2mm
// transient allowance`, and NOTHING ELSE is part of that condition. Not whether the
// caller asserted real stock (stockBoundsAreRealStock/stockProven), not whether an
// earlier rough handed this one a retained field. An earlier attempt on this order
// made the refusal conditional on `stockProven && startFromStock === undefined`;
// these cases exist so that exception cannot come back unnoticed, in either
// direction. Side entry is carried alongside on its own row (2a, the whole-path
// sum) because the same overload trips both -- this block is not what pins the
// difference between them; the transient-sum block below is.
//
// The numbers are mocked deliberately: the question here is the POLICY, not the
// geometry, so the same measured overload is fed to four stock configurations and
// all four must refuse.
describe('WO-1252: the refusal rows read their threshold and nothing else', () => {
  // Measured on the real 10mm ring: 331.7mm of over-cap cutting whose worst
  // unbroken stretch is 19.4mm, nearly ten times the transient allowance.
  const OVERLOAD = {
    peakFraction: 0.881, overCapLengthMm: 331.7, longestOverCapRunMm: 19.4, cuttingLengthMm: 2835.6,
    peakAt: { x: 27.5, y: 5, z: 2.5 }, capFraction: CAP,
  };

  // One variable per row: the same ring, the same mocked overload, and one changed
  // declaration about the stock. The expected verdict never changes.
  const CASES: Array<{ name: string; sideEntry: boolean; realStock: boolean; retained: boolean; mode: string }> = [
    { name: 'proven full stock, interior entry', sideEntry: false, realStock: true, retained: false, mode: 'interior-entry' },
    { name: 'proven full stock, side entry', sideEntry: true, realStock: true, retained: false, mode: 'side-entry' },
    { name: 'the caller never asserted the box is real stock', sideEntry: false, realStock: false, retained: false, mode: 'interior-entry' },
    { name: 'the job declares it starts from an earlier rough retained field', sideEntry: false, realStock: true, retained: true, mode: 'interior-entry' },
  ];

  for (const c of CASES) {
    it(`refuses the measured overload: ${c.name}`, { timeout: 900000 }, async () => {
      const measurement = vi.spyOn(roughModule, 'measurePathEngagement').mockReturnValue(OVERLOAD);
      const warning = vi.spyOn(console, 'warn');
      try {
        // A retained field that still holds every bit of the stock, so the geometry
        // and the emitted path are the control's and the ONLY thing that changed is
        // the declaration. (A partly-carved field would move the path too, and then
        // a difference would have two candidate causes.)
        const run = await roughRing(15, c.sideEntry, {
          ...(c.realStock ? {} : { stockBoundsAreRealStock: false }),
          ...(c.retained
            ? { startFromStock: ZDexelField.fromBox(
                { minX: 0, minY: 0, minZ: 0, maxX: STOCK_XY, maxY: STOCK_XY, maxZ: STOCK_Z }, CELL) }
            : {}),
        });
        expect(run.ir, 'an over-allowance path must not be published').toBeNull();
        expect(run.refusal).toMatch(new RegExp(`${c.mode} path exceeded the sustained engagement cap`));
        // Side entry's message formatting is byte-for-byte what it was on main
        // (0 decimals); interior keeps WO-1233's 1 decimal. Only the ROW moved.
        expect(run.refusal).toContain(c.sideEntry ? '332mm of 2836mm' : '331.7mm of 2835.6mm');
        // Refused, not emitted-and-reported: the "still emitted" line belongs to the
        // report row, and the report row did not run.
        expect(warning.mock.calls.map(args => String(args[0]))
          .filter(line => line.startsWith('[adaptive-rough] '))).toHaveLength(0);
      } finally {
        measurement.mockRestore();
        warning.mockRestore();
      }
    });
  }
});

// WO-1252, THE REGRESSION GUARD FOR THIS WHOLE ORDER. Three attempts silently
// changed one case and no test noticed: a SIDE-ENTRY job whose over-cap total is
// over the 2mm allowance but whose longest unbroken run is under it. Side entry's
// landed condition (WO-131) reads the SUM, so that job refuses on main and must go
// on refusing; every attempt that put the longest run on side entry's row turned it
// into a silent emission. This block fails on all three of those attempts.
//
// The interior half of the pair is the other side of the same fact: the identical
// measurement is the profile of a valid rest job (scattered sub-millimetre corner
// nibbles, cutter out of the material between every pair), and interior entry
// reports it rather than refusing. wo277/wo279 are the real jobs behind these
// numbers, and they are green because of this row.
describe('WO-1252: the two rows bound DIFFERENT quantities', () => {
  // Over the allowance as a SUM, under it as one unbroken stretch.
  const SCATTERED = {
    peakFraction: 1.01, overCapLengthMm: 2.5, longestOverCapRunMm: 0.8, cuttingLengthMm: 1200,
    peakAt: { x: 4, y: 5, z: 6 }, capFraction: CAP,
  };

  it('side entry still refuses on the whole-path sum (its landed WO-131 condition)',
    { timeout: 900000 }, async () => {
      const measurement = vi.spyOn(roughModule, 'measurePathEngagement').mockReturnValue(SCATTERED);
      try {
        const run = await roughRing(15, true);
        expect(run.ir, 'side entry over its 2mm over-cap total must not publish').toBeNull();
        expect(run.refusal).toMatch(/side-entry path exceeded the sustained engagement cap/);
      } finally {
        measurement.mockRestore();
      }
    });

  it('interior entry reports the same measurement rather than refusing it',
    { timeout: 900000 }, async () => {
      const measurement = vi.spyOn(roughModule, 'measurePathEngagement').mockReturnValue(SCATTERED);
      const warning = vi.spyOn(console, 'warn');
      try {
        const run = await roughRing(15, false);
        expect(run.refusal, 'scattered nibbles are not a sustained load').toBeNull();
        expect(run.ir).not.toBeNull();
        const messages = warning.mock.calls.map(args => String(args[0]))
          .filter(line => line.startsWith('[adaptive-rough] '));
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('2.5mm of 1200.0mm');
      } finally {
        measurement.mockRestore();
        warning.mockRestore();
      }
    });
});
