// WO-096: unit proof of the two halves of the traverse-safety rule.
//
//   maxTraverseIntrusion   -- "what would this move HIT", against in-process stock
//   enforceTraverseSafety  -- keep the low link when the field PROVES it clear,
//                             route it over the clearance plane when it does not
//
// Every case here is a hand-built z-dexel field with exact numbers, so a failure
// names a millimetre rather than a fixture mood.

import { describe, it, expect } from 'vitest';

import { ZDexelField, removeSweep, maxTraverseIntrusion, type Box3 } from '../../cam3d/stock';
import {
  DESCENT_STANDOFF_MM,
  LOW_TRAVEL_HEADROOM_MM,
  enforceTraverseSafety,
} from '../../cam3d/rough/traverseSafety';
import type { CutterSpec } from '../../cam3d/kernel/types';
import type { IrMove } from '../../cam3d/ir/types';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 4 };
const BLOCK: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 };
const CELL = 0.5;
const CLEARANCE_Z = 25;

const block = (): ZDexelField => ZDexelField.fromBox(BLOCK, CELL);

/** Mill a corridor down to `z` along y = 20, so a link can be proven clear. */
function clearCorridor(field: ZDexelField, z: number): void {
  removeSweep(field, { x0: 2, y0: 20, z0: z, x1: 38, y1: 20, z1: z }, CUTTER);
}

describe('WO-096 maxTraverseIntrusion: the read-only mirror of removeSweep', () => {
  it('reports the depth material rises into the cutter', () => {
    const hit = maxTraverseIntrusion(
      block(), { x0: 5, y0: 20, z0: 4, x1: 35, y1: 20, z1: 4 }, CUTTER,
    );
    // Solid block to z=10, tool tip at z=4 -> 6 mm of material through the tool.
    expect(hit.intrusionMm).toBeCloseTo(6, 6);
    expect(hit.materialTopZ).toBeCloseTo(10, 6);
    expect(hit.columnsTested).toBeGreaterThan(0);
  });

  it('a traverse level with the block still counts as contact, not clearance', () => {
    const hit = maxTraverseIntrusion(
      block(), { x0: 5, y0: 20, z0: 10, x1: 35, y1: 20, z1: 10 }, CUTTER,
    );
    expect(hit.intrusionMm).toBeCloseTo(0, 6); // zero margin: a scrape
    const above = maxTraverseIntrusion(
      block(), { x0: 5, y0: 20, z0: 10.5, x1: 35, y1: 20, z1: 10.5 }, CUTTER,
    );
    expect(above.intrusionMm).toBeCloseTo(-0.5, 6); // the standoff, as a gap
  });

  it('sees the corridor that has already been cut', () => {
    const field = block();
    clearCorridor(field, 4);
    const hit = maxTraverseIntrusion(
      field, { x0: 5, y0: 20, z0: 4, x1: 35, y1: 20, z1: 4 }, CUTTER,
    );
    expect(hit.intrusionMm).toBeLessThanOrEqual(1e-6);
  });

  it('judges a z-varying move at its LOWEST tip z (never under-detects)', () => {
    const field = block();
    clearCorridor(field, 4);
    // Descends from clearance to 4 across standing material: must be caught.
    const hit = maxTraverseIntrusion(
      field, { x0: 5, y0: 5, z0: CLEARANCE_Z, x1: 35, y1: 5, z1: 4 }, CUTTER,
    );
    expect(hit.intrusionMm).toBeCloseTo(6, 6);
    expect(hit.tipZ).toBe(4);
  });

  it('an empty column holds no material', () => {
    const field = block();
    // Punch a hole wider than the probe footprint, right through to the bottom.
    removeSweep(field, { x0: 20, y0: 20, z0: -5, x1: 20, y1: 20, z1: -5 }, { kind: 'flat', diameter: 16 });
    const hit = maxTraverseIntrusion(
      field, { x0: 19.9, y0: 20, z0: 0, x1: 20.1, y1: 20, z1: 0 }, CUTTER,
    );
    expect(hit.columnsTested).toBeGreaterThan(0);
    expect(hit.intrusionMm).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('WO-096 enforceTraverseSafety: keep down when proven, lift when not', () => {
  const lowLink: IrMove[] = [
    { t: 'rapid', x: 35, y: 20, z: 4, role: 'rapid' },
  ];

  it('KEEPS a low link the in-process stock proves is clear (with the headroom under it)', () => {
    // WO-1270: before, this link ran AT the floor it had just cut (z 4 over a
    // corridor cut to z 4) and was kept byte-identical. Travel now owes the floor
    // LOW_TRAVEL_HEADROOM_MM of air, so the proven-clear link that stays untouched
    // is the one authored with that air; it is still far below clearance (25).
    const stock = block();
    clearCorridor(stock, 4);
    const withHeadroom: IrMove[] = [
      { t: 'rapid', x: 35, y: 20, z: 4 + LOW_TRAVEL_HEADROOM_MM, role: 'rapid' },
    ];
    const res = enforceTraverseSafety(withHeadroom, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 + LOW_TRAVEL_HEADROOM_MM },
    });
    expect(res.moves).toEqual(withHeadroom); // untouched: Stay Down survives
    expect(res.report.checked).toBe(1);
    expect(res.report.rerouted).toBe(0);
    expect(res.report.liftedForHeadroom).toBe(0);
    expect(res.report.minLowTravelGapMm).toBeCloseTo(LOW_TRAVEL_HEADROOM_MM, 6);
  });

  it('LIFTS, but keeps LOW, a proven-clear link authored on the deck it just cut (WO-1270)', () => {
    const stock = block();
    clearCorridor(stock, 4);
    const res = enforceTraverseSafety(lowLink, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    // Up by the headroom, across at floor + headroom, and a GUARDED descent back
    // to the endpoint the link was heading for. Never the clearance plane.
    expect(res.moves).toEqual([
      { t: 'rapid', x: 5, y: 20, z: 4 + LOW_TRAVEL_HEADROOM_MM, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: 4 + LOW_TRAVEL_HEADROOM_MM, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: 4 + DESCENT_STANDOFF_MM, role: 'rapid' },
      { t: 'feed', x: 35, y: 20, z: 4, role: 'plunge' },
    ]);
    for (const m of res.moves) expect(m.z).toBeLessThan(CLEARANCE_Z);
    expect(res.report.checked).toBe(1);
    expect(res.report.rerouted).toBe(0);
    expect(res.report.liftedForHeadroom).toBe(1);
    expect(res.report.minLowTravelGapMm).toBeCloseTo(LOW_TRAVEL_HEADROOM_MM, 6);
    expect(res.lastTip).toEqual({ x: 35, y: 20, z: 4 });
  });

  it('ROUTES OVER CLEARANCE a low link that meets standing material', () => {
    const stock = block(); // nothing cut yet
    const res = enforceTraverseSafety(lowLink, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    // Up, across at clearance, and then DOWN ONLY AS FAR AS THE FIELD PROVES:
    // The block stands to z=10. Contact is not clearance: the rapid stops a
    // positive standoff above it and the remainder is a feed plunge.
    expect(res.moves).toEqual([
      { t: 'rapid', x: 5, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: 10 + DESCENT_STANDOFF_MM, role: 'rapid' },
      { t: 'feed', x: 35, y: 20, z: 4, role: 'plunge' },
    ]);
    expect(res.report.reroutedHitMaterial).toBe(1);
    expect(res.report.reroutedUnprovable).toBe(0);
    expect(res.report.descentsChecked).toBe(1);
    expect(res.report.descentsFedDown).toBe(1);
    expect(res.report.worstIntrusionMm).toBeCloseTo(6, 6);
    expect(res.report.worstWitness).toMatch(/6\.000 mm into the cutter/);
    expect(res.moves[2].z).toBeGreaterThan(BLOCK.maxZ);
    // The endpoint is unchanged, so everything downstream still lines up.
    expect(res.lastTip).toEqual({ x: 35, y: 20, z: 4 });
  });

  it('ROUTES OVER CLEARANCE every low link when the stock model proves nothing', () => {
    const stock = block();
    clearCorridor(stock, 4); // the field says clear -- but it cannot be trusted
    const res = enforceTraverseSafety(lowLink, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: false,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    // Nothing below the clearance plane is provable, so the tail is fed the
    // whole way rather than rapided into territory the field cannot vouch for.
    expect(res.moves).toEqual([
      { t: 'rapid', x: 5, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'feed', x: 35, y: 20, z: 4, role: 'plunge' },
    ]);
    expect(res.report.reroutedUnprovable).toBe(1);
    expect(res.report.reroutedHitMaterial).toBe(0);
    expect(res.report.descentsFedDown).toBe(1);
  });

  it('a rerouted rising link still reaches its emitted endpoint', () => {
    const rising: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: 30, role: 'rapid' }];
    const res = enforceTraverseSafety(rising, {
      stock: block(), cutter: CUTTER, clearanceZ: CLEARANCE_Z,
      materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    expect(res.moves).toEqual([
      { t: 'rapid', x: 5, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: 30, role: 'rapid' },
    ]);
    expect(res.lastTip).toEqual({ x: 35, y: 20, z: 30 });
  });

  // --- the AUDIT FINDING this fix round exists to close ---------------------
  it('never leaves a RAPID DESCENT running into material after a reroute', () => {
    // Exactly the audit's scenario: the low link is rerouted over clearance, but
    // its ORIGINAL endpoint (z 4) sits 6 mm inside a block standing to z 10. The
    // first attempt rapided straight back down to it.
    const stock = block();
    const res = enforceTraverseSafety(lowLink, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    let prev = { x: 5, y: 20, z: 4 };
    const fresh = block(); // judge against the block as it stood, nothing cut
    for (const m of res.moves) {
      const isTraverse = m.t === 'rapid' || m.role === 'rapid';
      const moved = prev.x !== m.x || prev.y !== m.y || m.z < prev.z;
      if (isTraverse && moved) {
        const hit = maxTraverseIntrusion(
          fresh, { x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z }, CUTTER,
        );
        expect(
          hit.intrusionMm,
          `rapid ${JSON.stringify(m)} drives ${hit.intrusionMm.toFixed(3)} mm into material`,
        ).toBeLessThanOrEqual(1e-3);
      }
      prev = { x: m.x, y: m.y, z: m.z };
    }
  });

  it('GUARDS a bare vertical rapid descent handed to it, not just its own tail', () => {
    const stock = block(); // solid to z=10
    const plummet: IrMove[] = [{ t: 'rapid', x: 20, y: 20, z: 2, role: 'rapid' }];
    const res = enforceTraverseSafety(plummet, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 20, y: 20, z: CLEARANCE_Z },
    });
    expect(res.moves).toEqual([
      { t: 'rapid', x: 20, y: 20, z: 10 + DESCENT_STANDOFF_MM, role: 'rapid' },
      { t: 'feed', x: 20, y: 20, z: 2, role: 'plunge' },
    ]);
    expect(res.report.descentsChecked).toBe(1);
    expect(res.report.descentsFedDown).toBe(1);
    expect(res.moves[0].z).toBeGreaterThan(BLOCK.maxZ);
    expect(res.lastTip).toEqual({ x: 20, y: 20, z: 2 });
  });

  it('lets a vertical rapid descent through untouched when the column is empty', () => {
    const stock = block();
    // Punch a through-hole wider than the tool at (20, 20): the descent is air.
    removeSweep(stock, { x0: 20, y0: 20, z0: -5, x1: 20, y1: 20, z1: -5 },
      { kind: 'flat', diameter: 16 });
    const plummet: IrMove[] = [{ t: 'rapid', x: 20, y: 20, z: 2, role: 'rapid' }];
    const res = enforceTraverseSafety(plummet, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 20, y: 20, z: CLEARANCE_Z },
    });
    expect(res.moves).toEqual(plummet); // byte-identical: Stay Down keeps its speed
    expect(res.report.descentsFedDown).toBe(0);
  });

  it('feeds the WHOLE descent down when the stock model proves nothing', () => {
    const stock = block();
    removeSweep(stock, { x0: 20, y0: 20, z0: -5, x1: 20, y1: 20, z1: -5 },
      { kind: 'flat', diameter: 16 }); // field says air -- but it cannot be trusted
    const plummet: IrMove[] = [{ t: 'rapid', x: 20, y: 20, z: 2, role: 'rapid' }];
    const res = enforceTraverseSafety(plummet, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: false,
      initialTip: { x: 20, y: 20, z: CLEARANCE_Z },
    });
    expect(res.moves).toEqual([{ t: 'feed', x: 20, y: 20, z: 2, role: 'plunge' }]);
    expect(res.report.descentsFedDown).toBe(1);
  });

  it('does not guard a descent that stops AT the declared clearance plane', () => {
    const stock = block();
    const toClearance: IrMove[] = [{ t: 'rapid', x: 20, y: 20, z: CLEARANCE_Z, role: 'rapid' }];
    const res = enforceTraverseSafety(toClearance, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: false,
      initialTip: { x: 20, y: 20, z: CLEARANCE_Z + 5 },
    });
    expect(res.moves).toEqual(toClearance);
    expect(res.report.descentsChecked).toBe(0);
  });

  it('leaves traverses already at the clearance plane alone', () => {
    const stock = block();
    const atClearance: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: CLEARANCE_Z, role: 'rapid' }];
    const res = enforceTraverseSafety(atClearance, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: false,
      initialTip: { x: 5, y: 20, z: CLEARANCE_Z },
    });
    expect(res.moves).toEqual(atClearance);
    expect(res.report.rerouted).toBe(0);
  });

  it('never reroutes a CUTTING move, and still replays its removal', () => {
    const stock = block();
    const cut: IrMove[] = [{ t: 'feed', x: 35, y: 20, z: 4, role: 'cut' }];
    const res = enforceTraverseSafety(cut, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    expect(res.moves).toEqual(cut);
    expect(res.report.checked).toBe(0);
    // The cut it just made is visible to the NEXT link, at that point in the program.
    const after = maxTraverseIntrusion(
      stock, { x0: 5, y0: 20, z0: 4, x1: 35, y1: 20, z1: 4 }, CUTTER,
    );
    expect(after.intrusionMm).toBeLessThanOrEqual(1e-6);
  });

  it('skips pure vertical moves (a lift retraces air the tool already occupies)', () => {
    const stock = block();
    const lift: IrMove[] = [{ t: 'rapid', x: 5, y: 20, z: CLEARANCE_Z, role: 'rapid' }];
    const res = enforceTraverseSafety(lift, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    expect(res.moves).toEqual(lift);
    expect(res.report.checked).toBe(0);
  });

  it('checks the loopback fast-traverse too (feed-typed, rapid role)', () => {
    const stock = block();
    const loopback: IrMove[] = [{ t: 'feed', x: 35, y: 20, z: 4, role: 'rapid' }];
    const res = enforceTraverseSafety(loopback, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: 4 },
    });
    expect(res.report.checked).toBe(1);
    expect(res.report.reroutedHitMaterial).toBe(1);
  });
});
