import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADAPTIVE3D_PARAMS,
  readAdaptive3dParams,
} from '../../cam3d/integration/adaptive3dOperation';
import { emitLevelPasses } from '../../cam3d/rough/emit';
import { LOW_TRAVEL_HEADROOM_MM } from '../../cam3d/rough/traverseSafety';
import type { AdaptivePass } from '../../cam3d/rough/engineEntry';
import { removeSweep, ZDexelField } from '../../cam3d/stock';

const HELIX_ENTRY: AdaptivePass = {
  type: 'entry',
  point: { x: 0, y: 0 },
  radius: 1,
  mode: 'helix',
};

function emitAt(angle?: number) {
  return emitLevelPasses(
    [HELIX_ENTRY],
    -2,
    { clearanceZ: 12, retractZ: 4, feedZ: 4 },
    {
      cursor: { x: Number.NaN, y: Number.NaN, z: 12 },
      ...(angle === undefined ? {} : { helixAngleDeg: angle }),
    },
  );
}

describe('Adaptive 3D helix angle', () => {
  it('defaults legacy projects to 10 degrees and accepts the editable range', () => {
    expect(DEFAULT_ADAPTIVE3D_PARAMS.helixAngleDeg).toBe(10);
    expect(readAdaptive3dParams({}).helixAngleDeg).toBe(10);
    expect(readAdaptive3dParams({ helixAngleDeg: 7.5 }).helixAngleDeg).toBe(7.5);
    for (const invalid of [0.49, 30.01, Number.NaN, Number.POSITIVE_INFINITY, '7.5']) {
      expect(readAdaptive3dParams({ helixAngleDeg: invalid }).helixAngleDeg).toBe(10);
    }
  });

  it('preserves old output by default and changes pitch when requested', () => {
    expect(emitAt()).toEqual(emitAt(10));
    const ramps = (angle: number) => emitAt(angle).filter((move) => move.role === 'ramp');
    expect(ramps(5).length).toBeGreaterThan(ramps(10).length);
    expect(ramps(10).length).toBeGreaterThan(ramps(20).length);
    expect(ramps(20).at(-1)?.z).toBe(-2);
  });

  it('stops the entry rapid at Feed Height before helix motion begins', () => {
    const moves = emitAt();
    expect(moves[0]).toMatchObject({ t: 'rapid', z: 12, role: 'rapid' });
    expect(moves[1]).toMatchObject({ t: 'rapid', z: 4, role: 'rapid' });
    expect(moves[2]).toMatchObject({ t: 'feed', role: 'ramp' });
    expect(moves.filter((move) => move.t === 'rapid' && move.z < 4)).toHaveLength(0);
  });

  it('rapids through the constructively empty side-entry column', () => {
    const sideEntry: AdaptivePass = {
      type: 'entry',
      point: { x: 0, y: 0 },
      clearPoint: { x: -5, y: 0 },
      radius: 0,
      mode: 'side',
    };
    const stock = [Float64Array.from([-1, -1, 1, -1, 1, 1, -1, 1])];
    const moves = emitLevelPasses(
      [sideEntry],
      -2,
      { clearanceZ: 12, retractZ: 7, feedZ: 4 },
      { cursor: { x: Number.NaN, y: Number.NaN, z: 12 }, toolRadius: 0.5 },
      stock,
    );
    expect(moves).toEqual([
      { t: 'rapid', x: -5, y: 0, z: 12, role: 'rapid' },
      { t: 'rapid', x: -5, y: 0, z: 4, role: 'rapid' },
      { t: 'rapid', x: -5, y: 0, z: -2, role: 'rapid' },
      { t: 'feed', x: 0, y: 0, z: -2, role: 'lead_in' },
    ]);
  });

  it('keeps a later side entry below full retract when carved stock proves the pocket link', () => {
    const sideEntry: AdaptivePass = {
      type: 'entry',
      point: { x: -4, y: 0 },
      clearPoint: { x: -5, y: 0 },
      radius: 0,
      mode: 'side',
    };
    const stock = ZDexelField.fromBox({
      minX: -6, minY: -3, minZ: -5,
      maxX: 6, maxY: 3, maxZ: 0,
    }, 0.25);
    const cutter = { kind: 'flat' as const, diameter: 1 };
    // The upper stepdown already cleared this connector and the descent shaft.
    removeSweep(stock, { x0: -3, y0: 0, z0: -1, x1: -5, y1: 0, z1: -1 }, cutter);
    removeSweep(stock, { x0: -5, y0: 0, z0: -1, x1: -5, y1: 0, z1: -2 }, cutter);
    const stockSection = [Float64Array.from([-4, -2, 4, -2, 4, 2, -4, 2])];
    const moves = emitLevelPasses(
      [sideEntry],
      -2,
      { clearanceZ: 12, retractZ: 7, feedZ: 4 },
      {
        cursor: { x: -3, y: 0, z: -1 },
        toolRadius: 0.5,
        stock,
        cutter,
        stockProven: true,
      },
      stockSection,
    );

    expect(moves.some((move) => move.z === 4 || move.z === 7 || move.z === 12)).toBe(false);
    // WO-1178 re-pin (-0.95 -> 0.05): the emitter's hover now judges every column by the
    // SQUARE its material occupies, while this fixture's removeSweep clears by column
    // CENTRE, so the two rim columns at the slot's end still stand and the link rises to
    // the stock top instead of staying carved-in. Safe direction; the invariant above (no
    // move at feed, retract or clearance height) is the contract and still holds.
    // WO-1270 re-pin (0.05 -> stock top + LOW_TRAVEL_HEADROOM_MM): the connector is a rapid
    // across the standing rim, and low travel now keeps the headroom over the highest
    // material under it instead of the 0.05 mm feed hand-off standoff. Still low.
    const connectorZ = 0 + LOW_TRAVEL_HEADROOM_MM;
    expect(moves[0]).toMatchObject({ t: 'rapid', x: -3, y: 0, z: connectorZ, role: 'rapid' });
    expect(moves[1]).toMatchObject({ t: 'rapid', x: -5, y: 0, z: connectorZ, role: 'rapid' });
    expect(moves.at(-1)).toMatchObject({ t: 'feed', x: -4, y: 0, z: -2, role: 'lead_in' });

    const unproven = emitLevelPasses(
      [sideEntry],
      -2,
      { clearanceZ: 12, retractZ: 7, feedZ: 4 },
      { cursor: { x: -3, y: 0, z: -1 }, toolRadius: 0.5 },
      stockSection,
    );
    expect(unproven[0]).toMatchObject({ t: 'rapid', x: -3, y: 0, z: 12, role: 'rapid' });
  });

  it('uses carved stock instead of Feed Height for a later helix entry', () => {
    const stock = ZDexelField.fromBox({
      minX: -5, minY: -5, minZ: -5,
      maxX: 5, maxY: 5, maxZ: 0,
    }, 0.25);
    const moves = emitLevelPasses(
      [HELIX_ENTRY],
      -2,
      { clearanceZ: 12, retractZ: 7, feedZ: 4 },
      {
        cursor: { x: -3, y: 0, z: 0 },
        toolRadius: 1,
        stock,
        cutter: { kind: 'flat', diameter: 2 },
        stockProven: true,
      },
    );

    expect(moves.some((move) => move.z === 4 || move.z === 7 || move.z === 12)).toBe(false);
    // WO-1270 re-pin (0.05 -> stock top + LOW_TRAVEL_HEADROOM_MM) for the lateral connector
    // over uncut stock; the helix itself still starts its FEED ramp 0.05 above the stock.
    const connectorZ = 0 + LOW_TRAVEL_HEADROOM_MM;
    expect(moves[0]).toMatchObject({ t: 'rapid', x: -3, y: 0, z: connectorZ, role: 'rapid' });
    expect(moves[1]).toMatchObject({ t: 'rapid', x: 0.99, y: 0, z: connectorZ, role: 'rapid' });
    expect(moves[2]).toMatchObject({ t: 'rapid', x: 0.99, y: 0, z: 0.05, role: 'rapid' });
    expect(moves.filter((move) => move.role === 'ramp').at(-1)?.z).toBeCloseTo(-2, 12);
  });

  it('rejects unsafe angles and over-budget shallow helices', () => {
    expect(() => emitAt(0.49)).toThrow(/helixAngleDeg must be in/);
    const deepSmallHelix: AdaptivePass = {
      type: 'entry',
      point: { x: 0, y: 0 },
      radius: 0.25,
      mode: 'helix',
    };
    expect(() => emitLevelPasses(
      [deepSmallHelix],
      -20,
      { clearanceZ: 12, retractZ: 4, feedZ: 4 },
      { cursor: { x: Number.NaN, y: Number.NaN, z: 12 }, helixAngleDeg: 0.5 },
    )).toThrow(/above the 5000-point safety limit/);
  });
});
