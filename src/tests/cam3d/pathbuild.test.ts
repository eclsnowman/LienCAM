// cam3d path builder tests: pure-function linking with SYNTHETIC connector
// samplers (no kernel). Covers role vocabulary, stay-down vs retract links,
// ramp lead-in geometry, degenerate plunge, zigzag orientation, cut-geometry
// preservation (no resampling), determinism, fail-loud validation, and the
// WO-127 traverse plane (rapids floored on proven material, not on the part).

import { describe, expect, it } from 'vitest';
import {
  buildLinkedPath,
  TRAVERSE_STANDOFF_MM,
  type ConnectorSampler,
  type LinkPolicy,
  type PathBuildHeights,
} from '../../cam3d/pathbuild';
import type { IrMove } from '../../cam3d/ir/types';

const TAN10 = Math.tan((10 * Math.PI) / 180);

/** Build an xyz-triple pass from point tuples. */
function pass(points: Array<[number, number, number]>): Float64Array {
  const out = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

/** Straight pass along +X at y, z=0, integer-mm points 0..len. */
function xPass(y: number, len: number): Float64Array {
  const pts: Array<[number, number, number]> = [];
  for (let x = 0; x <= len; x++) pts.push([x, y, 0]);
  return pass(pts);
}

/** Sampler over the flat z=0 plane. */
const flatSampler: ConnectorSampler = (xy) => Promise.resolve(new Float64Array(xy.length / 2));

/** Sampler returning a constant z (ridge/valley between passes). */
function constSampler(z: number): ConnectorSampler {
  return (xy) => Promise.resolve(new Float64Array(xy.length / 2).fill(z));
}

/** Wrap a sampler and count invocations. */
function countingSampler(inner: ConnectorSampler): { sampler: ConnectorSampler; calls: () => number } {
  let n = 0;
  return {
    sampler: (xy) => {
      n++;
      return inner(xy);
    },
    calls: () => n,
  };
}

const HEIGHTS: PathBuildHeights = { clearanceZ: 10, retractZ: 3, feedZ: 1 };
/**
 * ramp 10 deg, sampleStep 1, maxDev 2, zigzag. cutterContactRadiusMm 3 = a
 * 6 mm cutter, the tool these 2 mm-stepover fixtures describe; it is the
 * stay-down cleared-territory proof radius (WO-127), so every 2 mm connector
 * below sits inside the corridor that cutter just swept.
 */
const POLICY: LinkPolicy = { stepover: 2, cutterContactRadiusMm: 3 };

function roles(moves: IrMove[]): string[] {
  return moves.map((m) => m.role ?? '?');
}

// ---------------------------------------------------------------------------
// 1. Stay-down linking, ramp lead-in, zigzag -- the golden two-pass scenario
// ---------------------------------------------------------------------------

describe('stay-down link + ramp lead-in + zigzag', () => {
  // Pass A at y=0 (forward), pass B at y=2 given forward but REVERSED by
  // zigzag; connector (10,0)->(10,2) is 2 mm <= 2*stepover, flat surface.
  const passes = [xPass(0, 10), xPass(2, 10)];

  it('emits the exact expected move program', async () => {
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, flatSampler);
    // WO-2209: rapid over the ramp top, down to Feed Height, lead x6 (5 ramp
    // vertices descending BACK along pass A + the landing on its first
    // sample), cut x10 (the whole of pass A), link x2 (1 interior sample +
    // pass-B start), cut x10, final rapid.
    const expected = [
      'rapid',
      'rapid',
      ...Array<string>(6).fill('lead_in'),
      ...Array<string>(10).fill('cut'),
      'stepover',
      'stepover',
      ...Array<string>(10).fill('cut'),
      'rapid',
    ];
    expect(roles(moves)).toEqual(expected);
    expect(moves).toHaveLength(31);

    // Entry: the ramp line z = tan(10deg) * d from pass A's start reaches Feed
    // Height (1) at d = 1 / tan(10deg) = 5.671 mm; the rapids land over that
    // point of the pass, at clearance and then at Feed Height.
    const rampRun = 1 / TAN10;
    expect(moves[0]).toMatchObject({ t: 'rapid', y: 0, z: 10 });
    expect(moves[0].x).toBeCloseTo(rampRun, 12);
    expect(moves[1]).toMatchObject({ t: 'rapid', x: moves[0].x, y: 0, z: 1 });
    for (let i = 1; i < moves.length; i++) {
      if (moves[i].t === 'rapid' && moves[i].z < moves[i - 1].z) {
        expect(moves[i].z).toBe(HEIGHTS.feedZ);
      }
    }

    // Ramp: vertices x = 5..1 exactly on the 10-deg ramp line, then the
    // landing exactly ON pass A's first sample (0,0,0).
    for (let j = 5; j >= 1; j--) {
      const m = moves[2 + (5 - j)];
      expect(m).toMatchObject({ x: j, y: 0, role: 'lead_in' });
      expect(m.z).toBeCloseTo(TAN10 * j, 12);
      expect(m.z).toBeGreaterThan(0);
    }
    expect(moves[7]).toMatchObject({ x: 0, y: 0, z: 0, role: 'lead_in' });

    // Every lead segment descends no steeper than the ramp angle.
    for (let i = 2; i <= 7; i++) {
      const a = moves[i - 1];
      const b = moves[i];
      const run = Math.hypot(b.x - a.x, b.y - a.y);
      expect(a.z - b.z).toBeLessThanOrEqual(TAN10 * run + 1e-12);
    }

    // Pass A cuts forward 1..10 -- the whole pass; link feeds along the
    // sampled surface.
    expect(moves[8]).toMatchObject({ x: 1, y: 0, z: 0, role: 'cut' });
    expect(moves[17]).toMatchObject({ x: 10, y: 0, z: 0, role: 'cut' });
    expect(moves[18]).toMatchObject({ x: 10, y: 1, z: 0, role: 'stepover' });
    expect(moves[19]).toMatchObject({ x: 10, y: 2, z: 0, role: 'stepover' });

    // Pass B runs REVERSED (zigzag): cuts 9..0 at y=2.
    expect(moves[20]).toMatchObject({ x: 9, y: 2, role: 'cut' });
    expect(moves[29]).toMatchObject({ x: 0, y: 2, role: 'cut' });

    // Final retract to clearance; rapids only at the ends (stay-down link).
    expect(moves[30]).toMatchObject({ t: 'rapid', x: 0, y: 2, z: 10 });
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(3);
  });

  it('preserves cut geometry exactly (no resampling)', async () => {
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, flatSampler);
    const cuts = moves.filter((m) => m.role === 'cut');
    // Pass A cuts are pass points 1..10; pass B cuts are reversed points 1..10.
    for (let i = 0; i < 10; i++) {
      expect(Object.is(cuts[i].x, i + 1)).toBe(true);
      expect(Object.is(cuts[i].y, 0)).toBe(true);
      expect(Object.is(cuts[i].z, 0)).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      expect(Object.is(cuts[10 + i].x, 9 - i)).toBe(true);
      expect(Object.is(cuts[10 + i].y, 2)).toBe(true);
    }
  });

  it('is deterministic: two builds produce identical move lists', async () => {
    const a = await buildLinkedPath(passes, HEIGHTS, POLICY, flatSampler);
    const b = await buildLinkedPath(passes, HEIGHTS, POLICY, flatSampler);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('samples the connector exactly once', async () => {
    const { sampler, calls } = countingSampler(flatSampler);
    await buildLinkedPath(passes, HEIGHTS, POLICY, sampler);
    expect(calls()).toBe(1); // one short connector, one batch
  });
});

// ---------------------------------------------------------------------------
// 2. Retract linking: surface deviation and connector length
// ---------------------------------------------------------------------------

describe('retract links', () => {
  it('a ridge between passes (deviation > gate) forces a retract link', async () => {
    const passes = [xPass(0, 10), xPass(2, 10)];
    // Surface z=5 mid-connector vs chord z=0: deviation 5 > maxDev (2).
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, constSampler(5));
    expect(roles(moves)).not.toContain('stepover');
    // Two entries each add a Feed Height descent; the link also lifts and
    // traverses before the final retract.
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(6);
    expect(moves.filter((m) => m.role === 'plunge')).toHaveLength(0);
    // Retract sequence sits between the two cut blocks, at clearance.
    const upIdx = moves.findIndex((m, i) => i > 1 && m.t === 'rapid' && m.z === 10);
    expect(moves[upIdx]).toMatchObject({ x: 10, y: 0, z: 10 });
    // WO-2209: pass B (reversed, starting at (10,2)) is entered over its ramp
    // top, 1 / tan(10deg) mm along it, and ramps back onto (10,2).
    const top = 10 - 1 / TAN10;
    expect(moves[upIdx + 1]).toMatchObject({ t: 'rapid', y: 2, z: 10 });
    expect(moves[upIdx + 1].x).toBeCloseTo(top, 12);
    expect(moves[upIdx + 2]).toMatchObject({ t: 'rapid', x: moves[upIdx + 1].x, y: 2, z: 1, role: 'rapid' });
    expect(moves[upIdx + 3].role).toBe('lead_in');
    const landing = moves.findIndex((m, i) => i > upIdx && m.role === 'lead_in' && m.x === 10 && m.y === 2 && m.z === 0);
    expect(landing).toBeGreaterThan(upIdx);
    expect(moves[landing + 1]).toMatchObject({ x: 9, y: 2, z: 0, role: 'cut' });
  });

  it('a long connector (> 2 * stepover) retracts WITHOUT sampling the surface', async () => {
    const passes = [xPass(0, 10), xPass(10, 10)]; // 10 mm apart > 4 mm
    const { sampler, calls } = countingSampler(flatSampler);
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, sampler);
    expect(calls()).toBe(0);
    expect(roles(moves)).not.toContain('stepover');
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(6);
  });

  it('a shared endpoint (zero-length connector) continues without link moves', async () => {
    // Pass A too short to ramp (degenerate plunge entry); pass B reversed by
    // zigzag starts exactly at pass A's end.
    const a = xPass(0, 4);
    const b = pass([[4, 4, 0], [4, 0, 0]]); // reversed -> starts (4,0,0)
    const moves = await buildLinkedPath([a, b], HEIGHTS, POLICY, flatSampler);
    expect(roles(moves)).toEqual([
      'rapid', 'rapid', 'plunge', 'cut', 'cut', 'cut', 'cut', 'cut', 'rapid',
    ]);
    // The single pass-B cut continues straight from (4,0,0) to (4,4,0).
    expect(moves[7]).toMatchObject({ x: 4, y: 4, z: 0, role: 'cut' });
  });
});

// ---------------------------------------------------------------------------
// 3. Degenerate plunge entry
// ---------------------------------------------------------------------------

describe('degenerate plunge', () => {
  it('a pass shorter than the ramp needs gets a vertical plunge, flagged by role', async () => {
    // feedZ=1 needs 1/tan(10deg) ~ 5.67 mm of pass; this one has 3 mm.
    const moves = await buildLinkedPath([xPass(0, 3)], HEIGHTS, POLICY, flatSampler);
    expect(roles(moves)).toEqual(['rapid', 'rapid', 'plunge', 'cut', 'cut', 'cut', 'rapid']);
    expect(moves[1]).toMatchObject({ t: 'rapid', x: 0, y: 0, z: 1 }); // to Feed Height
    expect(moves[2]).toMatchObject({ x: 0, y: 0, z: 0 }); // vertical, onto the surface
    expect(roles(moves)).not.toContain('lead_in');
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-loud validation
// ---------------------------------------------------------------------------

describe('fail-loud validation', () => {
  const ok = [xPass(0, 10)];

  it('rejects clearanceZ below retractZ', async () => {
    await expect(
      buildLinkedPath(ok, { clearanceZ: 0, retractZ: 1, feedZ: 1 }, POLICY, flatSampler),
    ).rejects.toThrow(/clearanceZ >= retractZ >= feedZ/);
  });

  it('rejects Feed Height below the pass entry z', async () => {
    const high = [pass([[0, 0, 5], [1, 0, 5], [2, 0, 5]])];
    await expect(buildLinkedPath(high, HEIGHTS, POLICY, flatSampler)).rejects.toThrow(
      /above feedZ/,
    );
  });

  it('rejects pass geometry above clearanceZ (rapids would gouge)', async () => {
    const tall = [pass([[0, 0, 20], [1, 0, 20], [2, 0, 20]])];
    await expect(buildLinkedPath(tall, HEIGHTS, POLICY, flatSampler)).rejects.toThrow(
      /above clearanceZ/,
    );
  });

  it('rejects empty pass lists, non-triple arrays, and single-point passes', async () => {
    await expect(buildLinkedPath([], HEIGHTS, POLICY, flatSampler)).rejects.toThrow(/no passes/);
    await expect(
      buildLinkedPath([new Float64Array(4)], HEIGHTS, POLICY, flatSampler),
    ).rejects.toThrow(/not xyz triples/);
    await expect(
      buildLinkedPath([new Float64Array(3)], HEIGHTS, POLICY, flatSampler),
    ).rejects.toThrow(/needs >= 2/);
  });

  it('rejects invalid policy values', async () => {
    await expect(
      buildLinkedPath(ok, HEIGHTS, { ...POLICY, stepover: 0 }, flatSampler),
    ).rejects.toThrow(/invalid stepover/);
    await expect(
      buildLinkedPath(ok, HEIGHTS, { ...POLICY, rampAngleDeg: 90 }, flatSampler),
    ).rejects.toThrow(/rampAngleDeg/);
  });

  it('rejects a missing or non-positive cutter contact radius', async () => {
    // The stay-down proof radius is REQUIRED (WO-127): a zero/negative/absent
    // value would silently disable proof P1 and let every short link through.
    await expect(
      buildLinkedPath(ok, HEIGHTS, { ...POLICY, cutterContactRadiusMm: 0 }, flatSampler),
    ).rejects.toThrow(/invalid cutterContactRadiusMm/);
    await expect(
      buildLinkedPath(ok, HEIGHTS, { ...POLICY, cutterContactRadiusMm: NaN }, flatSampler),
    ).rejects.toThrow(/invalid cutterContactRadiusMm/);
  });

  it('rejects a sampler that returns the wrong number of z values', async () => {
    const passes = [xPass(0, 10), xPass(2, 10)];
    const bad: ConnectorSampler = () => Promise.resolve(new Float64Array(0));
    await expect(buildLinkedPath(passes, HEIGHTS, POLICY, bad)).rejects.toThrow(
      /sampler returned/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Zigzag off
// ---------------------------------------------------------------------------

describe('zigzag disabled', () => {
  it('keeps every pass in its given direction', async () => {
    const passes = [xPass(0, 10), xPass(2, 10)];
    const moves = await buildLinkedPath(
      passes,
      HEIGHTS,
      { ...POLICY, zigzag: false },
      flatSampler,
    );
    // Pass B now starts at (0,2): the connector (10,0)->(0,2) is > 4 mm, so
    // it must retract; pass B cuts run FORWARD.
    const cuts = moves.filter((m) => m.role === 'cut' && m.y === 2);
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts[cuts.length - 1].x).toBeGreaterThan(cuts[0].x);
  });
});

// ---------------------------------------------------------------------------
// 6. Traverse plane (WO-127): rapids are floored on PROVEN MATERIAL
// ---------------------------------------------------------------------------

describe('traverse plane', () => {
  /** Two passes 6 mm apart: too far to stay down, so pass B enters via retract. */
  const retracting = [xPass(0, 10), xPass(6, 10)];

  /** Rapid traverse/lift endpoints, excluding the required descent to Feed Height. */
  function traverseRapidZs(moves: IrMove[], feedZ: number): number[] {
    return moves.filter((m) => m.t === 'rapid' && m.z !== feedZ).map((m) => m.z);
  }

  it('stays at the authored clearance when no material top is proven', async () => {
    const moves = await buildLinkedPath(retracting, HEIGHTS, POLICY, flatSampler);
    for (const z of traverseRapidZs(moves, HEIGHTS.feedZ)) expect(z).toBe(HEIGHTS.clearanceZ);
    expect(moves.filter((m) => m.t === 'rapid' && m.z === HEIGHTS.feedZ)).toHaveLength(2);
  });

  it('raises every rapid to materialTopZ + standoff when that is higher', async () => {
    // clearanceZ 10, material topping out at 12 -> traverse plane 13.
    const heights: PathBuildHeights = { ...HEIGHTS, materialTopZ: 12 };
    const moves = await buildLinkedPath(retracting, heights, POLICY, flatSampler);
    const zs = traverseRapidZs(moves, heights.feedZ);
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) expect(z).toBe(12 + TRAVERSE_STANDOFF_MM);
  });

  it('never lowers the authored clearance for the approach and the final retract', async () => {
    // Material tops out well below the authored plane: the user's number wins
    // for the traverse plane. WO-2210: a link BETWEEN passes lifts only to the
    // proven top + standoff (1 + 1 = 2), then drops to Feed Height (1).
    const heights: PathBuildHeights = { ...HEIGHTS, materialTopZ: 1 };
    const moves = await buildLinkedPath(retracting, heights, POLICY, flatSampler);
    expect(moves[0]).toMatchObject({ t: 'rapid', z: HEIGHTS.clearanceZ });
    expect(moves[moves.length - 1]).toMatchObject({ t: 'rapid', z: HEIGHTS.clearanceZ });
    const linkZs = traverseRapidZs(moves.slice(1, -1), heights.feedZ);
    expect(linkZs).toEqual([1 + TRAVERSE_STANDOFF_MM, 1 + TRAVERSE_STANDOFF_MM]);
  });

  it('is byte-identical to the unproven build when the clearance already clears', async () => {
    const plain = await buildLinkedPath(retracting, HEIGHTS, POLICY, flatSampler);
    const proven = await buildLinkedPath(
      retracting,
      { ...HEIGHTS, materialTopZ: HEIGHTS.clearanceZ - TRAVERSE_STANDOFF_MM },
      POLICY,
      flatSampler,
    );
    expect(proven).toEqual(plain);
  });

  it('leaves stay-down links alone (they are feeds, not traverses)', async () => {
    // 2 mm apart on a flat surface: the link stays down either way.
    const close = [xPass(0, 10), xPass(2, 10)];
    const plain = await buildLinkedPath(close, HEIGHTS, POLICY, flatSampler);
    const proven = await buildLinkedPath(
      close,
      { ...HEIGHTS, materialTopZ: 20 },
      POLICY,
      flatSampler,
    );
    const links = (ms: IrMove[]): IrMove[] => ms.filter((m) => m.role === 'stepover');
    expect(links(plain).length).toBeGreaterThan(0);
    expect(links(proven)).toEqual(links(plain));
    for (const m of links(proven)) expect(m.t).toBe('feed');
  });

  it('rejects a non-finite materialTopZ', async () => {
    await expect(
      buildLinkedPath(retracting, { ...HEIGHTS, materialTopZ: NaN }, POLICY, flatSampler),
    ).rejects.toThrow(/non-finite materialTopZ/);
  });
});

// ---------------------------------------------------------------------------
// 7. Stay-down CLEARED-TERRITORY proof (WO-127 fix round, audit finding 2)
//
// Operator's rule binds low LINKS, not only rapids: "A low link is legal only where
// the engine KNOWS the territory is cleared", checked "against IN-PROCESS
// STOCK, not against the part". Being short and near the part-surface chord is
// not that proof. Two proofs are available in this builder and a link needs
// one:
//   P1  the WHOLE CUTTER stays inside the corridor the previous pass swept, or
//       escapes it by no more than this operation itself bites -- at most
//       min(stepover, cutterContactRadiusMm) mm (tightened from a centreline
//       test to a whole-cutter one by WO-266);
//   P2  the whole connector rides at or above a PROVEN materialTopZ.
// An unprovable link retracts over the traverse plane, which is itself floored
// on proven material (section 6).
// ---------------------------------------------------------------------------

describe('stay-down cleared-territory proof', () => {
  /** Straight pass along +X at y, at a constant z, integer-mm points 0..len. */
  function xPassAtZ(y: number, len: number, z: number): Float64Array {
    const pts: Array<[number, number, number]> = [];
    for (let x = 0; x <= len; x++) pts.push([x, y, z]);
    return pass(pts);
  }

  /** Passes 2.5 mm apart: inside 2 * stepover (4 mm), so only the proof decides. */
  const gapped = [xPass(0, 10), xPass(2.5, 10)];
  const links = (ms: IrMove[]): IrMove[] => ms.filter((m) => m.role === 'stepover');

  it('retracts a link whose cutter body escapes the swept corridor by more than this operation itself bites (P1)', async () => {
    // Derived from the geometry, not read off the builder (WO-266's rule):
    //   - 6 mm cutter, r = 3. Pass A runs along y = 0, so it PROVED ground
    //     clear out to y = 3.0 -- its centreline plus one radius.
    //   - The connector is (10,0) -> (10,2.5): 2.5 mm straight ACROSS that
    //     corridor. At its far end the cutter's far edge sits at
    //     y = 2.5 + 3 = 5.5.
    //   - Escape = 5.5 - 3.0 = 2.5 mm of ground nothing has cut. (The radius
    //     cancels: the escape is just the connector's own distance from the
    //     swept centreline, which is why DIRECTION decides and length does not.)
    //   - The bite this operation already takes = min(stepover 2, r 3) = 2 mm.
    // 2.5 > 2, so P1 refuses by 0.5 mm; with no materialTopZ, P2 cannot apply
    // either, and the link retracts. This is the WO-260 reproduction's own
    // geometry and linkCutterClearance.wo266.test.ts pins the same refusal.
    //
    // Note what this fixture is NOT: its declared stepover (2 mm) is SMALLER
    // than the spacing its passes actually sit at (2.5 mm). A raster whose
    // passes are one true stepover apart escapes by exactly that stepover and
    // keeps its link -- see the golden two-pass scenario at the top of this
    // file, and the census in src/tests/evidence/WO-291/.
    const moves = await buildLinkedPath(gapped, HEIGHTS, POLICY, flatSampler);
    expect(links(moves)).toHaveLength(0);
    // A cutter WIDER than the connector is not itself a proof: the pre-WO-266
    // gate asked only whether the connector fitted under one radius, and on
    // this geometry that answer is yes.
    expect(2.5).toBeLessThan(POLICY.cutterContactRadiusMm);
    // Routed the ordinary way: retract-up, rapid-over, plunge, ramp back in.
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(6);
    expect(moves.filter((m) => m.role === 'plunge')).toHaveLength(0);
  });

  it('retracts the SAME link when nothing proves the corridor was cut', async () => {
    // Same geometry, same 2 * stepover gate, same flat surface, same deviation,
    // and a smaller cutter still (2 mm cutter, r = 1): the previous pass now
    // proves ground clear only to y = 1.0, the cutter's far edge reaches
    // y = 2.5 + 1 = 3.5, and the escape is the same 2.5 mm -- against a bite
    // allowance of min(stepover 2, r 1) = 1 mm, so it is refused twice over.
    // It runs over ground NOTHING has touched, where in-process stock may still
    // stand full height, so it must route over the clearance plane.
    const narrow: LinkPolicy = { ...POLICY, cutterContactRadiusMm: 1 };
    const { sampler, calls } = countingSampler(flatSampler);
    const moves = await buildLinkedPath(gapped, HEIGHTS, narrow, sampler);

    expect(links(moves)).toHaveLength(0);
    expect(calls()).toBe(0); // unprovable costs no surface queries, like a long link
    // The retract goes over the traverse plane, exactly like any other retract.
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(6);
    for (const m of moves.filter((m) => m.t === 'rapid' && m.z !== HEIGHTS.feedZ)) {
      expect(m.z).toBe(HEIGHTS.clearanceZ);
    }
    expect(moves.filter((m) => m.role === 'plunge')).toHaveLength(0);
  });

  it('gates exactly at the swept radius when the radius is the binding term, not near it', async () => {
    // P1 allows an escape of at most min(stepover, cutterContactRadiusMm)
    // (WO-266), so the CUTTER RADIUS is what decides only when it is the
    // smaller of the two terms. Stepover 3 puts it there; the fixture's escape
    // is 2.5 mm exactly (passes 2.5 mm apart, connector straight across the
    // corridor, so the escape equals the connector's distance from it):
    //   r = 2.5000 -> bound 2.5000, escape 2.5 <= 2.5000 -> link KEPT
    //   r = 2.4999 -> bound 2.4999, escape 2.5 >  2.4999 -> link RETRACTED
    // 0.1 um of tool decides it, so the gate is an exact comparison and not a
    // nearness test. (Under this file's POLICY stepover of 2 the stepover term
    // binds first and BOTH radii retract -- that case is the test above.)
    const wideStepover: LinkPolicy = { ...POLICY, stepover: 3 };
    const exact: LinkPolicy = { ...wideStepover, cutterContactRadiusMm: 2.5 };
    const justUnder: LinkPolicy = { ...wideStepover, cutterContactRadiusMm: 2.4999 };
    expect(links(await buildLinkedPath(gapped, HEIGHTS, exact, flatSampler)).length)
      .toBeGreaterThan(0);
    expect(links(await buildLinkedPath(gapped, HEIGHTS, justUnder, flatSampler))).toHaveLength(0);
  });

  it('keeps a link outside the corridor when it rides at the proven material top (P2)', async () => {
    // Surfacing a slab whose top face IS the stock top: the connector sits at
    // z = materialTopZ, the tool occupies only z >= its tip, so it meets
    // nothing -- provable even with a 2 mm cutter at 2.5 mm stepover.
    const MAT = 5;
    const slab = [xPassAtZ(0, 10, MAT), xPassAtZ(2.5, 10, MAT)];
    const heights: PathBuildHeights = { clearanceZ: 10, retractZ: 6, feedZ: 6, materialTopZ: MAT };
    const narrow: LinkPolicy = { ...POLICY, cutterContactRadiusMm: 1 };
    const moves = await buildLinkedPath(slab, heights, narrow, constSampler(MAT));
    expect(links(moves).length).toBeGreaterThan(0);
    for (const m of links(moves)) expect(m.z).toBe(MAT);
  });

  it('retracts when the connector dips below the proven material top', async () => {
    // Same slab, but the proven stock top is 0.5 mm ABOVE the finished face:
    // the link would feed through that uncleared 0.5 mm at cutting feedrate,
    // and neither proof covers it.
    const MAT = 5;
    const slab = [xPassAtZ(0, 10, MAT), xPassAtZ(2.5, 10, MAT)];
    const heights: PathBuildHeights = { clearanceZ: 10, retractZ: 6, feedZ: 6, materialTopZ: MAT + 0.5 };
    const narrow: LinkPolicy = { ...POLICY, cutterContactRadiusMm: 1 };
    const moves = await buildLinkedPath(slab, heights, narrow, constSampler(MAT));
    expect(links(moves)).toHaveLength(0);
    // Retracted: the approach and final retract on the traverse plane
    // (max(clearanceZ 10, materialTop 5.5 + standoff) = the authored clearance);
    // WO-2210: the link between the passes only over the proven top + standoff.
    expect(heights.clearanceZ).toBeGreaterThan(MAT + 0.5 + TRAVERSE_STANDOFF_MM);
    const rapidZs = moves.filter((m) => m.t === 'rapid' && m.z !== heights.feedZ).map((m) => m.z);
    const low = MAT + 0.5 + TRAVERSE_STANDOFF_MM;
    expect(rapidZs).toEqual([heights.clearanceZ, low, low, heights.clearanceZ]);
  });

  it('retracts an interior dip even when both endpoints clear the material top', async () => {
    // The endpoint check alone is not the proof: the connector's MIDDLE must
    // clear too. Endpoints at z = 5 = materialTopZ, sampled interior at 4.
    const MAT = 5;
    const slab = [xPassAtZ(0, 10, MAT), xPassAtZ(2.5, 10, MAT)];
    const heights: PathBuildHeights = { clearanceZ: 10, retractZ: 6, feedZ: 6, materialTopZ: MAT };
    const narrow: LinkPolicy = { ...POLICY, cutterContactRadiusMm: 1 };
    const moves = await buildLinkedPath(slab, heights, narrow, constSampler(4));
    expect(links(moves)).toHaveLength(0);
  });

  it('a zero-length connector needs no proof: it crosses no territory', async () => {
    const a = xPass(0, 4);
    const b = pass([[4, 4, 0], [4, 0, 0]]); // reversed by zigzag -> starts (4,0,0)
    const narrow: LinkPolicy = { ...POLICY, cutterContactRadiusMm: 0.001 };
    const moves = await buildLinkedPath([a, b], HEIGHTS, narrow, flatSampler);
    expect(roles(moves)).toEqual([
      'rapid', 'rapid', 'plunge', 'cut', 'cut', 'cut', 'cut', 'cut', 'rapid',
    ]);
  });
});
