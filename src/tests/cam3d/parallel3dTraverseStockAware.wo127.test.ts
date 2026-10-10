// WO-127: does parallel_3d traverse through uncleared stock the way adaptive_3d
// did? THE VERDICT IS YES, for the TRAVERSE half, and this file is the evidence.
//
// The defect class (WO-096, Operator 2026-08-08):
//
//   "It is ok to travel below the travel height providing the code generator
//    knows the stock is cleared. ... Just because it is above the part does not
//    mean it is above uncleared stock."
//
// THE CODE PATH, end to end:
//
//   store/index.ts resolveParallel3dHeights
//     -> lib/cam/heightIntent.ts resolveMeshBoundHeightEnvelope(h, wcsZ,
//          { min: mesh.bounds.min[2], max: mesh.bounds.max[2] })
//        ... topZ = MESH max z (the PART top). feedZ/retractZ/clearanceZ are
//        each floored at topZ. The stock is never an argument, so the safe
//        plane is derived from the part by construction.
//     -> integration/parallel3dOperation.ts computeParallel3dMoves
//          heights = { clearanceZ, retractZ, feedZ }       <- resolved authority
//     -> strategies/parallel.ts parallelFinish
//     -> pathbuild/index.ts buildLinkedPath -> enterViaRetract
//          push('rapid', x0, y0, clearanceZ, 'rapid')      <- LATERAL RAPID
//
// That last line is the exact shape of Operator's crash: a lateral rapid emitted at
// a plane whose only guarantee is "at or above the PART top".
//
// Operator's own numbers (WO-096): part 80 x 80 x 14, stock 100 x 100 x 15. Run
// through the PRODUCTION height resolver here -- not hand-authored -- so the
// offending Z is the number the app computes, not one this test chose.
//
// THE STAY-DOWN half is a different hazard -- a link is a FEED move at cutting
// feedrate, so it cannot put a RAPID through material -- but Operator's rule binds
// it too: "A low link is legal only where the engine KNOWS the territory is
// cleared", checked against IN-PROCESS STOCK. Being a feed move is not that
// proof, and the first attempt at this WO stopped there. The last describe
// block now pins the proof the builder demands (pathbuild tryStayDown, P1/P2):
// a link survives only where the cutter's OWN swept corridor -- or a proven
// material top -- shows the ground is clear, and an unprovable one retracts
// over the traverse plane. At the stepovers finishing actually uses every link
// is provable and none is lifted, which is the Stay Down feature Operator told
// WO-096 twice to preserve.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CutterHandle, GeometryKernel, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import type { IrMove } from '../../cam3d/ir/types';
import type { Cam3dClient, ParallelFinishClientInput } from '../../cam3d/worker/client';
import type { Tool } from '../../types';
import { parallelFinish } from '../../cam3d/strategies/parallel';
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild';
import {
  computeParallel3dMoves,
  DEFAULT_PARALLEL3D_PARAMS,
} from '../../cam3d/integration/parallel3dOperation';
import { resolveMeshBoundHeightEnvelope } from '../../lib/cam/heightIntent';

// --- Operator's project geometry (WO-096 "The evidence") ------------------------

/** Part: 80 x 80 x 14 -> its top surface. */
const PART_TOP_Z = 14;
const PART_BOTTOM_Z = 0;
/** Stock: 100 x 100 x 15, position Z 0 -> the highest material the tool meets. */
const STOCK_TOP_Z = 15;

/** The part footprint, and the boundary the passes are clipped to. */
const PART_MIN_XY = 0;
const PART_MAX_XY = 80;
/** A 20 x 20 hole in the middle -- Operator's "Step Test With Holes". Scanlines
 *  crossing the hole band split into two spans 20 mm apart, far longer than the
 *  2 * stepover stay-down gate, so they MUST retract and rapid across; the
 *  scanlines outside the band are single spans that link stay-down. One run
 *  therefore exercises both link kinds. */
const HOLE_MIN = 30;
const HOLE_MAX = 50;

/** Outer ring, geom2d convention (CCW). */
function rectCcw(minX: number, maxX: number, minY: number, maxY: number): Ring {
  return new Float64Array([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
}

/** Hole ring, geom2d convention (CW). */
function rectCw(minX: number, maxX: number, minY: number, maxY: number): Ring {
  return new Float64Array([minX, minY, minX, maxY, maxX, maxY, maxX, minY]);
}

const BOUNDARY_WITH_HOLE: Ring[] = [
  rectCcw(PART_MIN_XY, PART_MAX_XY, PART_MIN_XY, PART_MAX_XY),
  rectCw(HOLE_MIN, HOLE_MAX, HOLE_MIN, HOLE_MAX),
];

/** Flat slab top at PART_TOP_Z over the whole part footprint. */
function slabKernel(): GeometryKernel {
  return {
    makeCutter: () => 1 as CutterHandle,
    releaseCutter: () => {},
    dropPoints: async (_m: MeshHandle, _c: CutterHandle, xy: Float64Array) =>
      new Float64Array(xy.length / 2).fill(PART_TOP_Z),
  } as unknown as GeometryKernel;
}

/**
 * The heights the PRODUCTION path resolves for this part. `heights` are the
 * WCS-relative values an operation carries; wcsOriginZ = 0 here (stock bottom
 * on the table, Operator's setup). Only clearance/retract/feed are inputs -- top and
 * bottom come from the mesh, which is the whole problem.
 */
function productionHeights(clearanceHeight: number, retractHeight: number) {
  const env = resolveMeshBoundHeightEnvelope(
    { clearanceHeight, retractHeight, feedHeight: 2 },
    0,
    { min: PART_BOTTOM_Z, max: PART_TOP_Z },
  );
  return { clearanceZ: env.clearanceZ, retractZ: env.retractZ, feedZ: env.feedZ, topZ: env.topZ };
}

// --- traverse extraction ----------------------------------------------------

interface TraverseSegment {
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
  /** Lowest tip z the corridor is occupied at. */
  lowestZ: number;
}

/**
 * Every traverse segment WITH LATERAL MOTION. A traverse is t === 'rapid' or
 * any move carrying the 'rapid' role. Purely-vertical traverses are excluded on
 * the WO-096 proof: with the tip at (x, y, z) the tool occupies everything from
 * z upward in its own columns, so a lift meets nothing new -- and a pure descent
 * lands where the next move already put the tool.
 */
function lateralTraverses(moves: readonly IrMove[]): TraverseSegment[] {
  const out: TraverseSegment[] = [];
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of moves) {
    const isTraverse = m.t === 'rapid' || m.role === 'rapid';
    if (prev !== null && isTraverse && (prev.x !== m.x || prev.y !== m.y)) {
      out.push({
        fromX: prev.x, fromY: prev.y, fromZ: prev.z,
        toX: m.x, toY: m.y, toZ: m.z,
        lowestZ: Math.min(prev.z, m.z),
      });
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return out;
}

function describeSegment(s: TraverseSegment): string {
  return (
    `RAPID (${s.fromX.toFixed(3)}, ${s.fromY.toFixed(3)}, ${s.fromZ.toFixed(3)}) -> ` +
    `(${s.toX.toFixed(3)}, ${s.toY.toFixed(3)}, ${s.toZ.toFixed(3)})  Z ${s.lowestZ.toFixed(3)} mm`
  );
}

/** Links the builder emitted as stay-down (feed, role 'stepover'). */
function stayDownLinks(moves: readonly IrMove[]): IrMove[] {
  return moves.filter((m) => m.role === 'stepover');
}

// --- the run ----------------------------------------------------------------

const STEPOVER = 1;
const CUTTER = { kind: 'flat' as const, diameter: 6 };

async function runParallel(
  heights: { clearanceZ: number; retractZ: number; feedZ: number; materialTopZ?: number },
  opts?: { stepover?: number; cutterDiameter?: number },
): Promise<IrMove[]> {
  const ir = await parallelFinish(slabKernel(), {
    mesh: 1 as MeshHandle,
    cutter: { ...CUTTER, diameter: opts?.cutterDiameter ?? CUTTER.diameter },
    stepover: opts?.stepover ?? STEPOVER,
    angleDeg: 0,
    tolerance: 0.05,
    boundary: BOUNDARY_WITH_HOLE,
    heights,
    zSeed: PART_BOTTOM_Z,
  });
  return ir.moves;
}

describe('WO-127 parallel_3d traverse safety: the production heights', () => {
  it('floors the safe plane at the PART top, below the stock top', () => {
    // Operator's authored clearance of 15 resolves to EXACTLY the stock top: zero
    // margin, which he called out by name ("Looks to be zero clearance above
    // part but would be traveling through uncleared stock above part").
    const erics = productionHeights(15, 5);
    expect(erics.topZ).toBe(PART_TOP_Z);
    expect(erics.clearanceZ).toBe(15);
    expect(erics.clearanceZ).toBe(STOCK_TOP_Z); // level with material, not above it

    // And any authored clearance BELOW the part top is silently floored at the
    // part top -- 1.000 mm INSIDE the stock. This is "above the part therefore
    // safe" in one line of arithmetic.
    const floored = productionHeights(10, 5);
    expect(floored.clearanceZ).toBe(PART_TOP_Z);
    expect(floored.clearanceZ).toBeLessThan(STOCK_TOP_Z);
    // retract is floored the same way and is likewise inside the stock.
    expect(floored.retractZ).toBe(PART_TOP_Z);
  });
});

describe('WO-127 parallel_3d emits lateral rapids through uncleared stock', () => {
  // THE DEFECT, reproduced. Pre-fix this whole describe block was red; the
  // captured output is src/tests/evidence/WO-127/pre-fix-RED.txt:
  //
  //   38 of 38 lateral rapids occupy z <= stock top 15. First offenders:
  //   RAPID (80.000, 30.000, 14.000) -> (30.000, 31.000, 14.000)  Z 14.000 mm
  //   RAPID  (0.000, 31.000, 14.000) -> (50.000, 31.000, 14.000)  Z 14.000 mm
  //   RAPID (80.000, 31.000, 14.000) -> (30.000, 32.000, 14.000)  Z 14.000 mm
  //
  // Every one of them 1.000 mm inside stock that had not been touched.

  it('without a proven stock top, invents no safety it was not given', async () => {
    // This is the NAMED LIMITATION, pinned so it cannot be mistaken for a proof
    // and cannot silently change: with nothing proven, the traverse plane is
    // EXACTLY the authored clearance -- the builder neither raises it (a guess)
    // nor lowers it. For Operator's numbers that plane is inside the stock, which is
    // why computeParallel3dMoves warns loudly on this path (test below).
    const h = productionHeights(10, 5); // clearanceZ 14, stock top 15
    const moves = await runParallel(h);
    const traverses = lateralTraverses(moves);

    expect(traverses.length).toBe(38);
    for (const s of traverses) expect(s.lowestZ).toBe(h.clearanceZ);

    // ... and that authored plane really is inside uncleared stock. The moment
    // a caller proves a stock top, the next test says this cannot happen.
    const exposed = traverses.filter((s) => s.lowestZ <= STOCK_TOP_Z);
    expect(
      exposed.length,
      `unproven traverses inside stock:\n${exposed.slice(0, 3).map(describeSegment).join('\n')}`,
    ).toBe(38);
  });

  it('clears the stock once the material top is proven', async () => {
    const h = productionHeights(10, 5);
    const moves = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });
    const traverses = lateralTraverses(moves);

    expect(traverses.length).toBeGreaterThan(0);
    for (const s of traverses) {
      expect(s.lowestZ).toBeGreaterThanOrEqual(STOCK_TOP_Z + TRAVERSE_STANDOFF_MM);
    }
  });

  it('lifts the zero-margin clearance from Operator\'s project off the material', async () => {
    // clearanceZ resolves to exactly 15.000 = stock top. Level with material is
    // not clearance; the proven material top must push it strictly above.
    const h = productionHeights(15, 5);
    expect(h.clearanceZ).toBe(STOCK_TOP_Z);
    const moves = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });
    for (const s of lateralTraverses(moves)) {
      expect(s.lowestZ).toBeGreaterThan(STOCK_TOP_Z);
    }
  });
});

describe('WO-127 control: Stay Down is preserved', () => {
  it('emits the same stay-down links with and without a proven material top', async () => {
    const h = productionHeights(10, 5);
    const before = await runParallel(h);
    const after = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });

    const linksBefore = stayDownLinks(before);
    const linksAfter = stayDownLinks(after);
    expect(linksBefore.length).toBeGreaterThan(0);
    expect(linksAfter).toEqual(linksBefore); // not one link was lifted
  });

  it('leaves the approach, the retract and every cutting move byte-identical when clearance already clears material', async () => {
    // Authored clearance 25 -> clearanceZ 25, already above 15 + standoff.
    const h = productionHeights(25, 5);
    const before = await runParallel(h);
    const after = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });
    // WO-2210: on a proven top a link between passes lifts only to that top + standoff and comes
    // back down to Feed Height there; nothing else moves.
    const shaping = (ms: readonly IrMove[]): IrMove[] => ms.filter((m) => m.role === 'cut' || m.role === 'stepover');
    expect(shaping(after)).toEqual(shaping(before));
    expect(after[0]).toEqual(before[0]);
    expect(after[after.length - 1]).toEqual(before[before.length - 1]);
    const interiorRapidZs = new Set(after.slice(1, -1).filter((m) => m.t === 'rapid').map((m) => m.z));
    expect([...interiorRapidZs].sort()).toEqual([h.feedZ, STOCK_TOP_Z + TRAVERSE_STANDOFF_MM].sort());
  });

  it('touches nothing that shapes the part: cut geometry is unchanged', async () => {
    const h = productionHeights(10, 5);
    const before = await runParallel(h);
    const after = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });

    const cuts = (ms: readonly IrMove[]): IrMove[] => ms.filter((m) => m.role === 'cut');
    expect(cuts(before).length).toBeGreaterThan(0);
    expect(cuts(after)).toEqual(cuts(before));

    // The proven-stock path adds one vertical rapid descent per entry. Every
    // descent stops exactly at Feed Height; cutting motion never starts above
    // or bypasses that authored transition plane.
    const feedEntries = (ms: readonly IrMove[]): IrMove[] => ms.filter((m) =>
      m.t === 'rapid' && m.z === h.feedZ,
    );
    expect(feedEntries(before).length).toBe(39);
    expect(feedEntries(after).length).toBe(39);
  });

  it('costs only the extra vertical travel, and states how much', async () => {
    const h = productionHeights(10, 5);
    const before = await runParallel(h);
    const after = await runParallel({ ...h, materialTopZ: STOCK_TOP_Z });

    const travel = (ms: readonly IrMove[], roles: readonly string[]): number => {
      let d = 0;
      let prev: IrMove | null = null;
      for (const m of ms) {
        if (prev !== null && roles.includes(m.role ?? '')) {
          d += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
        }
        prev = m;
      }
      return d;
    };

    // The machining itself -- cuts and stay-down links -- is untouched.
    expect(travel(after, ['cut', 'stepover'])).toBeCloseTo(travel(before, ['cut', 'stepover']), 9);

    // The whole cost is the 2 mm the plane rose (14 -> 15 + 1 standoff), paid
    // once up and once down at each of the 39 entries:
    //   rapid +156 mm (39 lifts + 39 descents x 2 mm). Descents stop at the
    //   authored Feed Height, so no plunge motion is invented above the cut.
    const extraRapidMm = travel(after, ['rapid']) - travel(before, ['rapid']);
    const extraPlungeMm = travel(after, ['plunge']) - travel(before, ['plunge']);
    expect(extraRapidMm).toBeCloseTo(156, 6);
    expect(extraPlungeMm).toBeCloseTo(0, 6);
    expect((extraRapidMm / 5000) * 60).toBeCloseTo(1.872, 3);

    // Per entry the delta is exactly the rise of the plane -- structural, not a
    // property of this fixture: nothing scales with pass count except entries.
    const rise = STOCK_TOP_Z + TRAVERSE_STANDOFF_MM - h.clearanceZ;
    expect(extraRapidMm / 39).toBeCloseTo(rise * 2, 9);
  });
});

describe('WO-127 the L6 adapter carries the proof, and is loud without one', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Capture what computeParallel3dMoves hands the strategy. */
  function stubClient(): { client: Cam3dClient; captured: () => ParallelFinishClientInput } {
    let seen: ParallelFinishClientInput | undefined;
    const client = {
      generateParallelFinish: async (input: ParallelFinishClientInput) => {
        seen = input;
        return {
          moves: [{ t: 'feed' as const, x: 0, y: 0, z: 0, role: 'cut' as const }],
          meta: { strategyId: 'parallel_finish', cutterId: 'flat-d6' },
        };
      },
    } as unknown as Cam3dClient;
    return { client, captured: () => seen! };
  }

  const MESH: PartMesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, PART_TOP_Z]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, PART_BOTTOM_Z], max: [80, 80, PART_TOP_Z] },
    source: 'fixture',
  };
  const TOOL = {
    id: 't', name: 'Flat 6', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
    shankDiameter: 6, overallLength: 60, numberOfFlutes: 2, material: 'carbide',
    coating: 'none', notes: '', feedsAndSpeeds: {},
  } as Tool;

  function argsWith(stockTopZ?: number) {
    const h = productionHeights(10, 5);
    return {
      partMesh: MESH,
      tool: TOOL,
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: STEPOVER },
      resolvedHeights: {
        clearanceZ: h.clearanceZ,
        retractZ: h.retractZ,
        feedZ: h.retractZ,
        topZ: PART_TOP_Z,
        bottomZ: PART_BOTTOM_Z,
        ...(stockTopZ !== undefined ? { stockTopZ } : {}),
      },
    };
  }

  it('passes a proven stock top down to the builder as materialTopZ', async () => {
    const { client, captured } = stubClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await computeParallel3dMoves({ ...argsWith(STOCK_TOP_Z), client });
    expect(captured().heights.materialTopZ).toBe(STOCK_TOP_Z);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns loudly, and passes nothing, when no stock top is proven', async () => {
    const { client, captured } = stubClient();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await computeParallel3dMoves({ ...argsWith(), client });

    // No invented number reaches the builder -- undefined stays undefined.
    expect(captured().heights.materialTopZ).toBeUndefined();
    expect(captured().heights.clearanceZ).toBe(PART_TOP_Z);

    // ADR-0003: the fallback is announced, never silent.
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('[parallel3d] no proven stock top');
    expect(msg).toContain('NOT proven clear of uncleared stock');
  });
});

describe('WO-127 the stay-down link is a cutting move, not a traverse', () => {
  it('never emits a link as a rapid, and bounds it to 2 * stepover', async () => {
    const h = productionHeights(10, 5);
    const moves = await runParallel(h);
    const links = stayDownLinks(moves);
    expect(links.length).toBeGreaterThan(0);

    for (const m of links) {
      expect(m.t).toBe('feed'); // cutting feedrate, never a positioning move
      expect(m.role).toBe('stepover');
    }

    // Lateral extent of every connector, measured from the move before it.
    let prev: IrMove | null = null;
    let worstLinkSpanMm = 0;
    for (const m of moves) {
      if (prev !== null && m.role === 'stepover' && prev.role !== 'stepover') {
        // First move of a connector: its origin is the previous pass end.
        // Walk to the connector's end to get the whole span.
        worstLinkSpanMm = Math.max(worstLinkSpanMm, Math.hypot(m.x - prev.x, m.y - prev.y));
      }
      prev = m;
    }
    expect(worstLinkSpanMm).toBeLessThanOrEqual(2 * STEPOVER + 1e-9);
  });

  // --- the cleared-territory proof, end to end through the real strategy -----
  //
  // Audit finding (2): "tryStayDown ... receives no in-process stock state and
  // performs no cleared-territory test ... an unprovable low link must route
  // over a clearance plane, while provably safe low links are preserved."
  // These three drive parallelFinish, not the builder directly.

  it('keeps every link at a finishing stepover: the cutter swept that ground', async () => {
    // Operator's regime: 1 mm stepover, 6 mm cutter (r = 3). Every 1 mm connector
    // sits inside the corridor this cutter cut on the pass it just finished, so
    // the proof holds for all of them and Stay Down is fully intact.
    const h = productionHeights(10, 5);
    const links = stayDownLinks(await runParallel(h));
    expect(links.length).toBeGreaterThan(0);
  });

  it('retracts links the cutter CANNOT have cleared (coarse stepover)', async () => {
    // Same part, same surface, same 2 * stepover gate -- but a 4 mm stepover
    // with a 6 mm cutter (r = 3) puts 1 mm of every connector over ground
    // NOTHING has touched. Uncleared stock can stand full height there, so the
    // link is unprovable and must route over the clearance plane instead.
    const h = productionHeights(10, 5);
    const coarse = await runParallel(h, { stepover: 4, cutterDiameter: 6 });
    expect(stayDownLinks(coarse)).toHaveLength(0);
    // It did not vanish -- it became a retract over the traverse plane.
    expect(lateralTraverses(coarse).length).toBeGreaterThan(0);
  });

  it('keeps those same links once a wide enough cutter proves the corridor', async () => {
    // Identical geometry and stepover; only the tool changed. A 12 mm cutter
    // (r = 6) sweeps the whole 4 mm connector, so the proof holds and the links
    // come back. The gate is the PROOF, not a blanket lift.
    const h = productionHeights(10, 5);
    const wide = await runParallel(h, { stepover: 4, cutterDiameter: 12 });
    expect(stayDownLinks(wide).length).toBeGreaterThan(0);
    for (const m of stayDownLinks(wide)) expect(m.t).toBe('feed');
  });
});
