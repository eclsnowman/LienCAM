// WO-2786: read-only full-envelope check of a proposed descent / cut / link /
// step-up against tool, neck, shank, holder, stock, part and workholding.
// Each oracle row is an exact geometric case with a known answer (the WO-2654
// proposal's envelope negative-oracle row, plus step 1's reachability on the
// same fixtures). Unit geometry is a control, not an application claim.

import { describe, expect, it } from 'vitest';
import type { Tool, ToolHolder } from '../../types';
import type { SolidColumns } from '../../lib/cam/holderClearance';
import { analyzeExteriorAccess, exteriorAccessAt } from '../../cam3d/rough/exteriorAccess';
import {
  checkExteriorEnvelope,
  stockSolidColumns,
  type EnvelopeSegment,
  type ExteriorEnvelopeInput,
} from '../../cam3d/rough/exteriorEnvelope';
import { maxTraverseIntrusion, ZDexelField } from '../../cam3d/stock';

// ── Fixtures ────────────────────────────────────────────────────────────────
// 60 x 60 mm block, 0.5 mm cells, stock bottom -20.
const CELL = 0.5;
const N = 120;
const FRAME = { originX: 0, originY: 0, nx: N, ny: N, cell: CELL };

interface Box { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

/** Column tops: `inside` over [lo, hi]^2, `outside` elsewhere. */
function squareField(lo: number, hi: number, inside: number, outside: number): ZDexelField {
  const tops = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * CELL;
      const y = (j + 0.5) * CELL;
      tops[j * N + i] = x > lo && x < hi && y > lo && y < hi ? inside : outside;
    }
  }
  return ZDexelField.fromColumnTops(FRAME, tops, -20);
}

/** Solid boxes as column spans on a 0.5 mm grid over [-20, 80]^2. */
function boxColumns(boxes: readonly Box[]): SolidColumns {
  const o = -20;
  const n = 200;
  const spanStart = new Uint32Array(n * n + 1);
  const z: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      spanStart[j * n + i] = z.length;
      const x = o + (i + 0.5) * CELL;
      const y = o + (j + 0.5) * CELL;
      const spans = boxes
        .filter(b => x > b.minX && x < b.maxX && y > b.minY && y < b.maxY)
        .map(b => [b.minZ, b.maxZ] as const)
        .sort((a, b) => a[0] - b[0]);
      for (const [b, t] of spans) z.push(b, t);
    }
  }
  spanStart[n * n] = z.length;
  return { originX: o, originY: o, cell: CELL, nx: n, ny: n, spanStart, spanZ: Float64Array.from(z) };
}

/** Fixture A: closed pocket [20, 40]^2 cleared to -10, walls to 0. */
const pocketField = (): ZDexelField => squareField(20, 40, -10, 0);
/** A's part: a plate under the pocket floor (2 mm floor stock left). */
const PLATE = boxColumns([{ minX: 0, maxX: 60, minY: 0, maxY: 60, minZ: -20, maxZ: -12 }]);
/** A's clamp: sits on the stock top at the -x edge, 15 mm tall. */
const CLAMP = boxColumns([{ minX: 0, maxX: 12, minY: 25, maxY: 35, minZ: 0, maxZ: 15 }]);

/** Fixture C: a boss [20, 40]^2 roughed around (0.5 mm stock left on it). */
const bossField = (): ZDexelField => squareField(20, 40, 0, -20);
const BOSS = boxColumns([{ minX: 20.5, maxX: 39.5, minY: 20.5, maxY: 39.5, minZ: -20, maxZ: -0.5 }]);

// ── Tools ───────────────────────────────────────────────────────────────────
const HOLDER: ToolHolder = {
  id: 'h1', name: '30 mm collet nut', segments: [{ height: 40, lowerDiameter: 30, upperDiameter: 30 }],
};

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 't', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 15, shankDiameter: 6, overallLength: 50,
    lengthBelowHolder: 22, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'h1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool;
}

/** 6 mm flat, 15 mm flutes, 22 mm stickout. */
const LONG = tool({ name: '6 mm flat, 15 mm flutes' });
/** 6 mm flat, 4 mm flutes, 4 mm neck to 20 mm, then 6 mm shank. */
const NECKED = tool({ name: '6 mm reduced-neck flat', fluteLength: 4, neckDiameter: 4, shoulderLength: 16 });
/** 3 mm flat, 10 mm flutes, 6 mm shank, 30 mm stickout. */
const SMALL = tool({ name: '3 mm flat, 6 mm shank', diameter: 3, fluteLength: 10, lengthBelowHolder: 30 });

// ── Query helper ────────────────────────────────────────────────────────────
const seg = (role: EnvelopeSegment['role'], from: [number, number, number], to: [number, number, number]): EnvelopeSegment =>
  ({ role, from: { x: from[0], y: from[1], z: from[2] }, to: { x: to[0], y: to[1], z: to[2] } });

function pocketCheck(segments: EnvelopeSegment[], over: Partial<ExteriorEnvelopeInput> = {}) {
  return checkExteriorEnvelope({
    field: pocketField(),
    stockRevision: 7,
    fullStockProof: true,
    frame: 'world',
    tool: LONG,
    holder: HOLDER,
    part: PLATE,
    workholding: { status: 'complete', columns: [CLAMP] },
    allowanceMm: 0.25,
    partAllowanceMm: 0.5,
    segments,
    ...over,
  });
}

function bossCheck(segments: EnvelopeSegment[], over: Partial<ExteriorEnvelopeInput> = {}) {
  return pocketCheck(segments, {
    field: bossField(), tool: SMALL, part: BOSS, workholding: { status: 'complete', columns: [] }, ...over,
  });
}

const LEGAL_PLUNGE = seg('descent', [30, 30, 5], [30, 30, -9]);
const PLUNGE_BY_CLAMP = seg('descent', [24, 30, 5], [24, 30, -9]);
const INTO_PLUS_X_WALL: [[number, number, number], [number, number, number]] = [[36, 30, -10], [38.5, 30, -10]];
const BESIDE_BOSS = seg('descent', [18, 30, 5], [18, 30, -15]);

// ── Oracle rows ─────────────────────────────────────────────────────────────
describe('WO-2786 envelope oracle rows', () => {
  it('legal plunge in cleared stock: clear, nothing removed', () => {
    const r = pocketCheck([LEGAL_PLUNGE]);
    expect(r.verdict).toBe('clear');
    expect(r.segments).toEqual([{ index: 0, role: 'descent', verdict: 'clear', collisions: [], removesStock: false }]);
  });

  it('plunge cut 1 mm into the cleared floor: clear, removal by the cutting portion only', () => {
    const r = pocketCheck([seg('descent', [30, 30, 5], [30, 30, -11])]);
    expect(r.verdict).toBe('clear');
    expect(r.segments[0]).toMatchObject({ verdict: 'clear', collisions: [], removesStock: true });
  });

  it('holder hits a clamp above the pocket: collision, holder against workholding only', () => {
    const r = pocketCheck([PLUNGE_BY_CLAMP]);
    expect(r.verdict).toBe('collision');
    expect(r.segments[0].collisions).toEqual([{ component: 'holder', obstacle: 'workholding' }]);
    expect(r.segments[0].removesStock).toBe(false);
  });

  it('neck rubs the stock wall above the 4 mm flutes on a cut: collision, the neck is not removal', () => {
    const r = pocketCheck([seg('cut', ...INTO_PLUS_X_WALL)], { tool: NECKED });
    expect(r.verdict).toBe('collision');
    expect(r.segments[0].collisions).toEqual([{ component: 'neck', obstacle: 'stock' }]);
    // The flutes do meet the wall; that removal is real, the neck contact is not.
    expect(r.segments[0].removesStock).toBe(true);
  });

  it('cutter tip in air but shank through the part: collision on the shank, nothing removed', () => {
    const r = bossCheck([BESIDE_BOSS]);
    expect(r.verdict).toBe('collision');
    expect(r.segments[0].collisions).toEqual([
      { component: 'shank', obstacle: 'part' },
      { component: 'shank', obstacle: 'stock' },
    ]);
    expect(r.segments[0].removesStock).toBe(false);
  });

  it('a sufficiently clear assembly beside the boss passes', () => {
    const r = bossCheck([seg('descent', [15, 30, 5], [15, 30, -15])]);
    expect(r.verdict).toBe('clear');
    expect(r.segments[0]).toMatchObject({ collisions: [], removesStock: false });
  });

  it('missing holder -> unresolved with a reason, never assumed clear', () => {
    const r = pocketCheck([LEGAL_PLUNGE], { holder: undefined });
    expect(r.verdict).toBe('unresolved');
    expect(r.reason).toBe('holder-missing');
    expect(r.segments[0]).toMatchObject({ verdict: 'unresolved', reason: 'holder-missing', collisions: [] });
  });
});

describe('WO-2786 role and sequence semantics', () => {
  it('the same wall contact is removal on a cut and a collision on a link', () => {
    const cut = pocketCheck([seg('cut', ...INTO_PLUS_X_WALL)]);
    expect(cut.segments[0]).toMatchObject({ verdict: 'clear', collisions: [], removesStock: true });
    const link = pocketCheck([seg('link', ...INTO_PLUS_X_WALL)]);
    expect(link.segments[0]).toMatchObject({
      verdict: 'collision', collisions: [{ component: 'cutter', obstacle: 'stock' }], removesStock: false,
    });
  });

  it('cutting deeper than the flutes: shank in stock is a collision, not removal', () => {
    const r = pocketCheck([seg('cut', ...INTO_PLUS_X_WALL)], { tool: tool({ fluteLength: 4 }) });
    expect(r.segments[0].collisions).toEqual([{ component: 'shank', obstacle: 'stock' }]);
    expect(r.segments[0].removesStock).toBe(true);
  });

  it('judges a whole descent, cut, link and step-up against LIVE stock, never planned removal', () => {
    const r = pocketCheck([
      seg('descent', [30, 30, 5], [30, 30, -10]),
      seg('cut', [30, 30, -10], [38.5, 30, -10]),
      // The cut above has not happened in the field: the wall is still there.
      seg('link', [38.5, 30, -10], [30, 30, -10]),
      seg('step-up', [30, 30, -10], [30, 30, 30]),
    ]);
    expect(r.segments.map(s => [s.role, s.verdict, s.removesStock])).toEqual([
      ['descent', 'clear', false], // resting on the floor is not removal
      ['cut', 'clear', true],
      ['link', 'collision', false],
      ['step-up', 'clear', false], // leaving the floor is not a crash
    ]);
    expect(r.segments[2].collisions).toEqual([{ component: 'cutter', obstacle: 'stock' }]);
    expect(r.verdict).toBe('collision');
  });

  it('a step-up past the clamp is judged with the holder too', () => {
    const r = pocketCheck([seg('step-up', [24, 30, -9], [24, 30, 30])]);
    expect(r.segments[0].collisions).toEqual([{ component: 'holder', obstacle: 'workholding' }]);
  });

  it('a link high over the stock clears', () => {
    expect(pocketCheck([seg('link', [30, 30, 5], [50, 30, 5])]).verdict).toBe('clear');
  });

  it('a proven contact is a collision even with the holder unknown', () => {
    const r = bossCheck([BESIDE_BOSS], { holder: undefined });
    expect(r.verdict).toBe('collision');
    expect(r.segments[0].collisions.map(c => c.component)).toEqual(['shank', 'shank']);
  });

  it('cutter into the part is a gouge even on a cut', () => {
    const r = pocketCheck([seg('cut', [30, 30, -11.8], [32, 30, -11.8])]);
    expect(r.segments[0].collisions).toEqual([{ component: 'cutter', obstacle: 'part' }]);
  });
});

describe('WO-2786 absent or invalid geometry is unresolved with a reason', () => {
  const cases: [string, Partial<ExteriorEnvelopeInput>, string][] = [
    ['no full-stock proof', { fullStockProof: false }, 'no-full-stock-proof'],
    ['frame not proven', { frame: 'unknown' }, 'frame-unproven'],
    ['part missing', { part: undefined }, 'part-missing'],
    ['workholding unknown', { workholding: { status: 'unknown' } }, 'workholding-incomplete'],
    ['workholding unreadable', { workholding: { status: 'unreadable' } }, 'workholding-incomplete'],
    ['no segments', { segments: [] }, 'candidate-invalid'],
    ['stickout missing', { tool: tool({ lengthBelowHolder: undefined }) }, 'stickout-missing'],
    ['holder is not the tool\'s holder', { holder: { ...HOLDER, id: 'other' } }, 'holder-missing'],
    ['holder segment unreadable',
      { holder: { ...HOLDER, segments: [{ height: 0, lowerDiameter: 30, upperDiameter: 30 }] } }, 'holder-invalid'],
    ['tool profile invalid', { tool: tool({ fluteLength: 0 }) }, 'tool-profile-invalid'],
    ['negative allowance', { allowanceMm: -1 }, 'allowance-invalid'],
    ['non-finite coordinate', { segments: [seg('descent', [30, 30, 5], [30, Number.NaN, -9])] }, 'coordinates-invalid'],
  ];
  for (const [name, over, reason] of cases) {
    it(name, () => {
      const r = pocketCheck([LEGAL_PLUNGE], over);
      expect(r.verdict).toBe('unresolved');
      expect(r.reason).toBe(reason);
    });
  }

  it('corrupt obstacle columns are unresolved', () => {
    const bad: SolidColumns = { ...PLATE, spanStart: PLATE.spanStart.slice(0, 5) };
    expect(pocketCheck([LEGAL_PLUNGE], { part: bad }).reason).toBe('obstacle-invalid');
  });
});

describe('WO-2786 step 1 on the same fixtures: tip access is not assembly clearance', () => {
  it('pocket floor is ENCLOSED to step 1; step 2 clears a descent from above but sees the clamp', () => {
    const field = pocketField();
    const access = analyzeExteriorAccess({
      field, stockRevision: 7, band: { topZ: -10, bottomZ: -15 }, cutter: { kind: 'flat', diameter: 6 }, fullStockProof: true,
    });
    for (const [x, y] of [[30, 30], [24, 30]]) {
      const q = exteriorAccessAt(access, field, 7, x, y);
      expect(q.status === 'current' && q.component?.access).toBe('enclosed');
    }
    expect(pocketCheck([LEGAL_PLUNGE]).verdict).toBe('clear');
    expect(pocketCheck([PLUNGE_BY_CLAMP]).verdict).toBe('collision');
  });

  it('beside the boss the 3 mm tip disc is free at its plane (step 1\'s test) yet the shank collides', () => {
    const field = bossField();
    const tip = maxTraverseIntrusion(field, { x0: 18, y0: 30, z0: -15, x1: 18, y1: 30, z1: -15 }, { kind: 'flat', diameter: 3 });
    expect(tip.intrusionMm).toBeLessThanOrEqual(0);
    expect(bossCheck([BESIDE_BOSS]).verdict).toBe('collision');
  });
});

describe('WO-2786 read-only, bound and deterministic', () => {
  it('never mutates the field and binds the result to its revision and bytes', () => {
    const field = pocketField();
    const top = field.top.slice();
    const bottom = field.bottom.slice();
    const a = pocketCheck([LEGAL_PLUNGE, PLUNGE_BY_CLAMP], { field });
    expect(field.top).toEqual(top);
    expect(field.bottom).toEqual(bottom);
    const access = analyzeExteriorAccess({
      field, stockRevision: 7, band: { topZ: -10, bottomZ: -15 }, cutter: { kind: 'flat', diameter: 6 }, fullStockProof: true,
    });
    expect(a.stockRevision).toBe(7);
    expect(a.fieldDigest).toBe(access.fieldDigest);
    expect(pocketCheck([LEGAL_PLUNGE, PLUNGE_BY_CLAMP], { field })).toEqual(a);
  });

  it('stock columns mirror the z-dexel intervals exactly', () => {
    const field = pocketField();
    const cols = stockSolidColumns(field);
    const c = 60 * N + 60; // inside the pocket
    expect([...cols.spanZ.slice(cols.spanStart[c], cols.spanStart[c + 1])]).toEqual([-20, -10]);
    const empty = stockSolidColumns(bossField());
    expect(empty.spanStart[1] - empty.spanStart[0]).toBe(0); // roughed-away column is air
  });
});

describe('WO-2786 negative control: an envelope that ignores the holder fails the holder rows', () => {
  it('a holder no wider than the shank (a wrong envelope) lets the clamp row read clear', () => {
    const thin: ToolHolder = { ...HOLDER, segments: [{ height: 40, lowerDiameter: 6, upperDiameter: 6 }] };
    expect(pocketCheck([PLUNGE_BY_CLAMP], { holder: thin }).verdict).toBe('clear');
    expect(pocketCheck([PLUNGE_BY_CLAMP]).verdict).toBe('collision');
  });
});
