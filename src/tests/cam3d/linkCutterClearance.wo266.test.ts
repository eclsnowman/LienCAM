// WO-266: a stay-down link must clear the WHOLE CUTTER, not its centreline.
//
// The builder used to accept a connector whenever its xy length fitted under
// one cutter radius. That is a statement about the tool's CENTRELINE and it
// ignores direction entirely: a connector running along the corridor the
// previous pass swept is genuinely inside cut ground, while one of the same
// length running across it carries the cutter's far edge straight out of that
// ground. The WO-260 reproduction is the second case -- a 3 mm-radius cutter on
// a 2.5 mm perpendicular link, cutting 2.5 mm into material nothing proved was
// empty, at cutting feedrate, with the z floor dropped to -Infinity.
//
// These are PURE GEOMETRY tests: synthetic passes, a synthetic sampler, no
// kernel. Each one names the millimetre that decides it.

import { describe, expect, it } from 'vitest';
import {
  buildLinkedPath,
  type ConnectorSampler,
  type LinkPolicy,
  type PathBuildHeights,
} from '../../cam3d/pathbuild';
import type { IrMove } from '../../cam3d/ir/types';

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

const flatSampler: ConnectorSampler = (xy) => Promise.resolve(new Float64Array(xy.length / 2));

function constSampler(z: number): ConnectorSampler {
  return (xy) => Promise.resolve(new Float64Array(xy.length / 2).fill(z));
}

const HEIGHTS: PathBuildHeights = { clearanceZ: 10, retractZ: 1, feedZ: 1 };

/** The WO-260 reproduction's own numbers: 3 mm cutter radius, 2 mm stepover. */
const REPRO_POLICY: LinkPolicy = { stepover: 2, cutterContactRadiusMm: 3 };

const links = (ms: IrMove[]): IrMove[] => ms.filter((m) => m.role === 'stepover');
const roles = (ms: IrMove[]): string[] => ms.map((m) => m.role ?? '?');

// ---------------------------------------------------------------------------
// 1. Direction decides, not length
// ---------------------------------------------------------------------------

describe('WO-266 a link is judged on where the whole cutter goes', () => {
  it('KEEPS a 2.5 mm connector that runs ALONG the swept corridor', async () => {
    // Pass A runs +X at y=0 and ends at (10, 0). Pass B is a stub sitting ON
    // that same line, starting 2.5 mm back along it at (7.5, 0). Zigzag
    // reverses B, so the connector is (10,0) -> (7.5,0): 2.5 mm of travel that
    // never leaves the ground the cutter just swept. Escape = 0 mm.
    const along = [xPass(0, 10), pass([[5, 0, 0], [7.5, 0, 0]])];
    const moves = await buildLinkedPath(along, HEIGHTS, REPRO_POLICY, flatSampler);

    expect(links(moves).length).toBeGreaterThan(0);
    for (const m of links(moves)) expect(m.t).toBe('feed'); // cutting feedrate, stayed down
    // Entry = traverse rapid + the rapid down to Feed Height (1962cecd), + final.
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(3);
  });

  it('REFUSES a 2.5 mm connector of the same length running PERPENDICULAR', async () => {
    // Identical cutter, identical stepover, identical flat surface, identical
    // 2.5 mm of travel. Only the DIRECTION changed. The previous pass proved
    // ground clear out to y = 3.0; this connector puts the cutter's far edge at
    // y = 5.5. Escape = 2.5 mm, past the 2 mm the operation itself bites.
    const across = [xPass(0, 10), xPass(2.5, 10)];
    const moves = await buildLinkedPath(across, HEIGHTS, REPRO_POLICY, flatSampler);

    expect(links(moves)).toHaveLength(0);
  });

  it('is the WO-260 reproduction, refused on its own numbers', async () => {
    // Byte-for-byte the fixture in src/tests/evidence/WO-260/live-repros.mjs:
    // two 10 mm passes 2.5 mm apart, 3 mm cutter radius, 2 mm stepover.
    const repro = [
      pass([[0, 0, 0], [10, 0, 0]]),
      pass([[0, 2.5, 0], [10, 2.5, 0]]),
    ];
    const moves = await buildLinkedPath(
      repro,
      { clearanceZ: 10, retractZ: 5, feedZ: 5 },
      REPRO_POLICY,
      flatSampler,
    );
    expect(links(moves)).toHaveLength(0);
  });

  it('keeps an along-corridor link at the full 2 * stepover the outer gate allows', async () => {
    // The escape measure is an upper bound, so a densely sampled pass could in
    // principle score an along-corridor connector above 0. It cannot score it
    // above len / 2, and the outer gate caps len at 2 * stepover -- so the
    // longest along-corridor link the builder will even consider still clears
    // the allowance. This is the WO's "a connector ALONG the corridor stays
    // accepted", pinned at the worst length it can have.
    const maxAlong = [xPass(0, 10), pass([[3, 0, 0], [6, 0, 0]])]; // -> (10,0)->(6,0), 4 mm
    expect(4).toBe(2 * REPRO_POLICY.stepover);
    const moves = await buildLinkedPath(maxAlong, HEIGHTS, REPRO_POLICY, flatSampler);
    expect(links(moves).length).toBeGreaterThan(0);
  });

  it('length alone no longer decides: a LONGER along-corridor link outlives a shorter one across', async () => {
    // 3.5 mm along the corridor beats 2.5 mm across it. Under the old
    // `len <= cutterR` rule the 3.5 mm link was refused (3.5 > 3) and the
    // 2.5 mm one kept (2.5 <= 3) -- exactly backwards.
    const longAlong = [xPass(0, 10), pass([[4, 0, 0], [6.5, 0, 0]])]; // -> (10,0)->(6.5,0)
    const shortAcross = [xPass(0, 10), xPass(2.5, 10)];

    expect(
      links(await buildLinkedPath(longAlong, HEIGHTS, REPRO_POLICY, flatSampler)).length,
    ).toBeGreaterThan(0);
    expect(
      links(await buildLinkedPath(shortAcross, HEIGHTS, REPRO_POLICY, flatSampler)),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The bite that IS allowed, and the two terms that bound it
// ---------------------------------------------------------------------------

describe('WO-266 an escaping link may not cut deeper than the operation itself', () => {
  it('keeps a raster link that crosses by exactly one stepover', async () => {
    // The finishing regime WO-096 protects: passes one stepover apart, so the
    // link escapes by exactly the bite every pass already takes.
    const raster = [xPass(0, 10), xPass(2, 10)];
    const moves = await buildLinkedPath(raster, HEIGHTS, REPRO_POLICY, flatSampler);
    expect(links(moves).length).toBeGreaterThan(0);
    for (const m of links(moves)) expect(m.t).toBe('feed');
  });

  it('gates exactly at the stepover, not near it', async () => {
    const across = [xPass(0, 10), xPass(2.5, 10)]; // 2.5 mm escape
    const wideEnough: LinkPolicy = { ...REPRO_POLICY, stepover: 2.5 };
    const justUnder: LinkPolicy = { ...REPRO_POLICY, stepover: 2.4999 };
    expect(
      links(await buildLinkedPath(across, HEIGHTS, wideEnough, flatSampler)).length,
    ).toBeGreaterThan(0);
    expect(
      links(await buildLinkedPath(across, HEIGHTS, justUnder, flatSampler)),
    ).toHaveLength(0);
  });

  it('the cutter radius still caps it: a coarse stepover cannot excuse a slot', async () => {
    // 4 mm stepover with a 6 mm cutter (r = 3). The stepover term alone would
    // wave this through; at an escape of 4 mm the cutter's CENTRE is 1 mm past
    // the edge of the proven corridor, which is worse than slotting.
    const coarse = [xPass(0, 10), xPass(4, 10)];
    const smallCutter: LinkPolicy = { stepover: 4, cutterContactRadiusMm: 3 };
    expect(links(await buildLinkedPath(coarse, HEIGHTS, smallCutter, flatSampler))).toHaveLength(0);

    // Same geometry, same stepover, only the tool changed: a 12 mm cutter
    // (r = 6) sweeps a corridor wide enough that a 4 mm escape is within the
    // operation's own bite again.
    const wideCutter: LinkPolicy = { stepover: 4, cutterContactRadiusMm: 6 };
    expect(
      links(await buildLinkedPath(coarse, HEIGHTS, wideCutter, flatSampler)).length,
    ).toBeGreaterThan(0);
  });

  it('measures the escape against the whole swept polyline, not one straight run', async () => {
    // Pass A is an L: out along +X to (10,0), then up to (10,4), ending there.
    // Pass B is reversed by zigzag to start at (10,0.5), so the connector runs
    // 3.5 mm back DOWN the L's second leg -- ground this cutter just drove
    // along, on a pass that is not straight. The old rule refused it purely for
    // being longer than the 3 mm cutter radius; the corridor proves it.
    const elbow = pass([[0, 0, 0], [5, 0, 0], [10, 0, 0], [10, 2, 0], [10, 4, 0]]);
    const next = pass([[10, -2, 0], [10, 0.5, 0]]); // reversed -> starts (10,0.5)
    const moves = await buildLinkedPath([elbow, next], HEIGHTS, REPRO_POLICY, flatSampler);
    expect(links(moves).length).toBeGreaterThan(0);
    // Confirm the premise: the old `len <= cutterR` gate would have refused it.
    const ex = 10;
    const ey = 4;
    expect(Math.hypot(10 - ex, 0.5 - ey)).toBeGreaterThan(REPRO_POLICY.cutterContactRadiusMm);
  });
});

// ---------------------------------------------------------------------------
// 3. A refused link keeps the behaviour it always had
// ---------------------------------------------------------------------------

describe('WO-266 refusing a link changes nothing else', () => {
  it('falls through to P2, not to an unconditional retract', async () => {
    // Escape 2.5 mm with a 1 mm cutter radius: P1 cannot help. But the whole
    // connector rides at the PROVEN material top, so the tool -- which occupies
    // only z >= its tip -- meets nothing, and P2 keeps the link exactly as it
    // does today. The refusal is P1's alone.
    const MAT = 5;
    const flat = (y: number): Float64Array =>
      pass([[0, y, MAT], [5, y, MAT], [10, y, MAT]]);
    const slab = [flat(0), flat(2.5)];
    const heights: PathBuildHeights = { clearanceZ: 10, retractZ: 6, feedZ: 6, materialTopZ: MAT };
    const narrow: LinkPolicy = { stepover: 2, cutterContactRadiusMm: 1 };

    const moves = await buildLinkedPath(slab, heights, narrow, constSampler(MAT));
    expect(links(moves).length).toBeGreaterThan(0);
    for (const m of links(moves)) expect(m.z).toBe(MAT);
  });

  it('retracts over the traverse plane when neither proof holds', async () => {
    const across = [xPass(0, 10), xPass(2.5, 10)];
    const moves = await buildLinkedPath(across, HEIGHTS, REPRO_POLICY, flatSampler);

    expect(links(moves)).toHaveLength(0);
    // Retract-up, rapid-over, rapid down to Feed Height, ramp -- the ordinary
    // path (1962cecd: the descent is a rapid to feedZ, not a feed plunge). Two
    // entries -> 2 x (over + down) + the final lift = 6 rapids; lateral ones at
    // clearance, the descents exactly at feedZ.
    const rapids = moves.filter((m) => m.t === 'rapid');
    expect(rapids).toHaveLength(6);
    for (const m of rapids) expect([HEIGHTS.clearanceZ, HEIGHTS.feedZ]).toContain(m.z);
    expect(rapids.filter((m) => m.z === HEIGHTS.feedZ)).toHaveLength(2);
    expect(moves.filter((m) => m.role === 'plunge')).toHaveLength(0);
    expect(roles(moves)).toContain('lead_in');
  });

  it('costs no surface queries: an unprovable link is refused before sampling', async () => {
    const across = [xPass(0, 10), xPass(2.5, 10)];
    let calls = 0;
    const counting: ConnectorSampler = (xy) => {
      calls++;
      return flatSampler(xy);
    };
    await buildLinkedPath(across, HEIGHTS, REPRO_POLICY, counting);
    expect(calls).toBe(0);
  });

  it('a zero-length connector still behaves exactly as it does today', async () => {
    // Shared endpoint: no lateral travel, so the cutter goes nowhere and no
    // proof is owed. Unchanged even with an absurdly small cutter.
    const a = xPass(0, 4);
    const b = pass([[4, 4, 0], [4, 0, 0]]); // reversed by zigzag -> starts (4,0,0)
    const tiny: LinkPolicy = { stepover: 2, cutterContactRadiusMm: 0.001 };
    const moves = await buildLinkedPath([a, b], HEIGHTS, tiny, flatSampler);
    // (1962cecd: the entry descent is a rapid to Feed Height, then the
    // degenerate vertical plunge onto the surface.)
    expect(roles(moves)).toEqual([
      'rapid', 'rapid', 'plunge', 'cut', 'cut', 'cut', 'cut', 'cut', 'rapid',
    ]);
  });

  it('stays deterministic: two builds of the refused case are identical', async () => {
    const across = [xPass(0, 10), xPass(2.5, 10)];
    const a = await buildLinkedPath(across, HEIGHTS, REPRO_POLICY, flatSampler);
    const b = await buildLinkedPath(across, HEIGHTS, REPRO_POLICY, flatSampler);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
