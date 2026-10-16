// WO-2793: the restricted staged exterior pilot (step 3 of the outside-in
// roughing proposal). Exact boss-in-full-stock fixtures; every oracle is
// independent of the module under test (stock replay with the existing
// traverse-intrusion service, step 2's envelope re-run move by move against
// the replayed stock, the production engagement meter). Unit geometry is a
// control, not an application claim.

import { describe, expect, it } from 'vitest';
import type { Tool, ToolHolder } from '../../types';
import type { CutterSpec } from '../../cam3d/kernel/types';
import {
  exteriorScheduleToIr,
  planExteriorStages,
  type ExteriorScheduleInput,
  type ExteriorScheduleResult,
} from '../../cam3d/rough/exteriorSchedule';
import { checkExteriorEnvelope, stockSolidColumns } from '../../cam3d/rough/exteriorEnvelope';
import { measurePathEngagement } from '../../cam3d/rough/pathEngagement';
import { maxTraverseIntrusion, removeSweep, ZDexelField } from '../../cam3d/stock';
import { planLevels } from '../../cam3d/rough/levels';

// ── Fixture: a stepped boss on a plate in a 60 x 60 x 15 mm block ───────────
// Stock z -15..0, 0.5 mm cells. Part: plate to -12, shoulder [15, 45]^2 to -7,
// boss [20, 40]^2 to 0. Floor -11.5 and shoulder pin -6.5 (0.5 mm axial stock).
const CELL = 0.5;
const N = 120;
const FRAME = { originX: 0, originY: 0, nx: N, ny: N, cell: CELL };
const FLAT6: CutterSpec = { kind: 'flat', diameter: 6 };

function field(top: (x: number, y: number) => number): ZDexelField {
  const tops = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) tops[j * N + i] = top((i + 0.5) * CELL, (j + 0.5) * CELL);
  }
  return ZDexelField.fromColumnTops(FRAME, tops, -15);
}

const inSq = (x: number, y: number, lo: number, hi: number): boolean => x > lo && x < hi && y > lo && y < hi;
const fullStock = (): ZDexelField => field(() => 0);
const steppedBoss = (): ZDexelField => field((x, y) => (inSq(x, y, 20, 40) ? 0 : inSq(x, y, 15, 45) ? -7 : -12));
/** The boss with a 10 mm open-top pocket to -6: a cavity this pilot leaves for later. */
const cupBoss = (): ZDexelField =>
  field((x, y) => (inSq(x, y, 25, 35) ? -6 : inSq(x, y, 20, 40) ? 0 : inSq(x, y, 15, 45) ? -7 : -12));

const HOLDER: ToolHolder = {
  id: 'h1', name: '30 mm collet nut', segments: [{ height: 40, lowerDiameter: 30, upperDiameter: 30 }],
};

/** 6 mm flat, 20 mm flutes, 6 mm shank, 30 mm stickout. */
const TOOL = {
  id: 't', name: '6 mm flat', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 30, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'h1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 2.4 } },
} as unknown as Tool;

const BASE: Omit<ExteriorScheduleInput, 'stock' | 'part'> = {
  stockRevision: 1,
  fullStockProof: true,
  frame: 'world',
  tool: TOOL,
  holder: HOLDER,
  workholding: { status: 'complete', columns: [] },
  allowanceMm: 0.25,
  partAllowanceMm: 0.25,
  radialStockToLeave: 0.5,
  maxStepdown: 3,
  stepover: 0.4,
  floorZ: -11.5,
  requiredDepths: [-6.5],
  clearanceZ: 30,
};

function plan(over: Partial<ExteriorScheduleInput> = {}): Promise<ExteriorScheduleResult> {
  return planExteriorStages({ stock: fullStock(), part: steppedBoss(), ...BASE, ...over });
}

const STOCK_BOX = { minX: 0, maxX: 60, minY: 0, maxY: 60, minZ: -15, maxZ: 0 };
const R = 3;
const TRAVERSE_TOL = 1e-3;
const f32 = Math.fround;

let cached: Promise<ExteriorScheduleResult> | undefined;
const bossPlan = (): Promise<ExteriorScheduleResult> => (cached ??= plan());

const asSweep = (m: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }) =>
  ({ x0: m.from.x, y0: m.from.y, z0: m.from.z, x1: m.to.x, y1: m.to.y, z1: m.to.z });

describe('WO-2793 stages keep today\'s ladder', () => {
  it('plans every stage at the existing maximum stepdown, landing on the pin and the floor', async () => {
    const r = await bossPlan();
    expect(r.status).toBe('planned');
    expect(r.levels).toEqual(planLevels(0, -11.5, 3, [-6.5]));
    expect(r.levels).toContain(-6.5);
    expect(r.levels[r.levels.length - 1]).toBe(-11.5);
    expect(r.stages.map(s => s.z)).toEqual(r.levels);
    for (const s of r.stages) {
      expect(s.bandTopZ - s.z).toBeLessThanOrEqual(3 + 1e-9);
      expect(s.loopsCut).toBeGreaterThan(0);
    }
    // Stages run top down; moves never return to a stage above.
    const stageOrder = r.moves.map(m => m.stage).filter(s => s >= 0);
    expect(stageOrder).toEqual([...stageOrder].sort((a, b) => a - b));
  }, 60_000);
});

describe('WO-2793 every move is proven against the live stock it meets', () => {
  it('replayed independently: no link, step-up or descent meets standing stock; step 2 re-run clears every move', async () => {
    const r = await bossPlan();
    const replay = fullStock();
    const partColumns = stockSolidColumns(steppedBoss());
    const envelope = (segments: { role: 'descent' | 'cut' | 'link' | 'step-up'; from: never; to: never }[]) =>
      checkExteriorEnvelope({
        ...BASE, field: replay, part: partColumns, segments,
      } as unknown as Parameters<typeof checkExteriorEnvelope>[0]);
    let nonCutting = 0;
    let k = 0;
    while (k < r.moves.length) {
      const m = r.moves[k];
      if (m.role === 'cut') {
        // A run of cuts, judged against the stock before the run (conservative).
        let e = k;
        while (e < r.moves.length && r.moves[e].role === 'cut') e++;
        const run = r.moves.slice(k, e);
        const verdict = envelope(run.map(c => ({ role: 'cut', from: c.from, to: c.to })) as never);
        expect(verdict.verdict, `cut run at move ${k}`).toBe('clear');
        for (const c of run) removeSweep(replay, asSweep(c), FLAT6);
        k = e;
        continue;
      }
      nonCutting++;
      const intrusion = maxTraverseIntrusion(replay, asSweep(m), FLAT6).intrusionMm;
      expect(intrusion, `${m.route} ${m.role} at move ${k}`).toBeLessThanOrEqual(TRAVERSE_TOL);
      const v = envelope([{ role: m.role, from: m.from, to: m.to }] as never);
      expect(v.verdict, `${m.route} ${m.role} at move ${k}`).toBe('clear');
      expect(v.segments[0].removesStock, `${m.route} ${m.role} at move ${k}`).toBe(false);
      if (m.role === 'descent') removeSweep(replay, asSweep(m), FLAT6);
      k++;
    }
    expect(nonCutting).toBeGreaterThanOrEqual(r.stages.length + 1);
    // The schedule's own private stock is the stock the replay arrives at.
    expect(replay.top).toEqual(r.stock.top);
  }, 60_000);

  it('a stay-down link through the uncut strip to the next ring is refused on every stage; a transition cut takes it', async () => {
    const r = await bossPlan();
    for (let s = 0; s < r.stages.length; s++) {
      const refused = r.rejected.filter(x => x.stage === s && x.route === 'stay-down');
      expect(refused.length, `stage ${s}`).toBeGreaterThan(0);
      expect(refused.every(x => x.verdict === 'collision'
        && x.collisions.some(c => c.component === 'cutter' && c.obstacle === 'stock'))).toBe(true);
      expect(r.moves.some(m => m.stage === s && m.route === 'transition')).toBe(true);
    }
  }, 60_000);

  it('enters outside the stock: every descent stands a cutter radius clear of the stock box', async () => {
    const r = await bossPlan();
    expect(r.moves[0]).toMatchObject({ role: 'descent', route: 'entry', stage: 0 });
    const descents = r.moves.filter(m => m.role === 'descent');
    expect(descents.map(m => m.stage)).toEqual(r.stages.map(s => s.index));
    for (const d of descents) {
      const dx = Math.max(STOCK_BOX.minX - d.to.x, 0, d.to.x - STOCK_BOX.maxX);
      const dy = Math.max(STOCK_BOX.minY - d.to.y, 0, d.to.y - STOCK_BOX.maxY);
      expect(Math.hypot(dx, dy), `descent to stage ${d.stage}`).toBeGreaterThanOrEqual(R);
      expect(d.from.x).toBe(d.to.x);
      expect(d.from.y).toBe(d.to.y);
    }
  }, 60_000);
});

describe('WO-2793 engagement and result', () => {
  it('no stage cuts wider than today\'s stepover; the production meter agrees', async () => {
    const r = await bossPlan();
    for (const s of r.stages) expect(s.peakWidthMm).toBeLessThanOrEqual(r.stepoverMm + CELL);
    const ir = exteriorScheduleToIr(r.moves, BASE.clearanceZ);
    const meter = measurePathEngagement(ir, STOCK_BOX, CELL, FLAT6);
    expect(meter.peakFraction).toBeLessThanOrEqual(0.75);
    expect(meter.longestOverCapRunMm).toBe(0);
  }, 60_000);

  it('clears the exterior bulk to the floor and the shoulder pin, keeps the boss and its skin', async () => {
    const r = await bossPlan();
    const part = steppedBoss();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * CELL;
        const y = (j + 0.5) * CELL;
        const c = j * N + i;
        const top = r.stock.top[c];
        // Nothing is cut into the part or its 0.5 mm skin.
        expect(top, `(${x}, ${y})`).toBeGreaterThanOrEqual(Math.min(0, part.top[c] + 0.5) - 1e-4);
        if (!inSq(x, y, 14, 46)) expect(top, `floor at (${x}, ${y})`).toBe(f32(-11.5));
        else if (inSq(x, y, 15.5, 44.5) && !inSq(x, y, 19, 41)) expect(top, `pin at (${x}, ${y})`).toBe(f32(-6.5));
        else if (inSq(x, y, 20, 40)) expect(top).toBe(0);
      }
    }
    expect(r.cavities).toEqual([]);
  }, 60_000);
});

describe('WO-2793 cavities afterwards', () => {
  it('an open-top pocket in the boss is left whole: its rings are counted, never cut', async () => {
    const part = cupBoss();
    const r = await plan({ part });
    expect(r.status).toBe('planned');
    expect(r.stages[0].cavityLoops).toBeGreaterThan(0);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) * CELL;
        const y = (j + 0.5) * CELL;
        if (inSq(x, y, 25, 35)) expect(r.stock.top[j * N + i]).toBe(0);
      }
    }
    for (const m of r.moves) {
      const inPocket = (p: { x: number; y: number }) => inSq(p.x, p.y, 25 - R, 35 + R) && inSq(p.x, p.y, 25 - R, 35 + R);
      expect(inPocket(m.to) && m.to.z < 0, `${m.route} ${m.role}`).toBe(false);
    }
  }, 60_000);
});

describe('WO-2793 unresolved is study evidence, never a refusal or a guess', () => {
  const cases: [string, Partial<ExteriorScheduleInput>, string][] = [
    ['no full-stock proof', { fullStockProof: false }, 'no-full-stock-proof'],
    ['frame not proven', { frame: 'unknown' }, 'frame-unproven'],
    ['workholding unknown', { workholding: { status: 'unknown' } }, 'workholding-incomplete'],
    ['bull-nose cutter', { tool: { ...TOOL, type: 'bull_nose', cornerRadius: 1 } as Tool }, 'cutter-not-supported'],
    ['missing holder', { holder: undefined }, 'holder-missing'],
  ];
  for (const [name, over, reason] of cases) {
    it(name, async () => {
      const r = await plan(over);
      expect(r.status).toBe('unresolved');
      expect(r.reason).toBe(reason);
      expect(r.moves).toEqual([]);
    }, 60_000);
  }

  it('a clamp the holder cannot clear on every route leaves the stage unresolved, not a guessed path', async () => {
    // A tall clamp ring round the whole block: every entry from outside passes under it.
    const o = -20;
    const n = 200;
    const spanStart = new Uint32Array(n * n + 1);
    const z: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        spanStart[j * n + i] = z.length;
        const x = o + (i + 0.5) * CELL;
        const y = o + (j + 0.5) * CELL;
        if (!inSq(x, y, -2, 62)) z.push(-15, 40);
      }
    }
    spanStart[n * n] = z.length;
    const wall = { originX: o, originY: o, cell: CELL, nx: n, ny: n, spanStart, spanZ: Float64Array.from(z) };
    const r = await plan({ workholding: { status: 'complete', columns: [wall] } });
    expect(r.status).toBe('unresolved');
    expect(r.reason).toBe('no-route');
    expect(r.moves).toEqual([]);
    expect(r.rejected.some(x => x.collisions.some(c => c.obstacle === 'workholding'))).toBe(true);
  }, 60_000);
});

describe('WO-2793 read-only and deterministic', () => {
  it('never writes the caller\'s stock or part; identical inputs give identical schedules', async () => {
    const stock = fullStock();
    const part = steppedBoss();
    const before = [stock.top.slice(), stock.bottom.slice(), part.top.slice()];
    const a = await plan({ stock, part });
    expect([stock.top, stock.bottom, part.top]).toEqual(before);
    const b = await plan({ stock, part });
    expect(b.moves).toEqual(a.moves);
    expect(b.stockRevision).toBe(a.stockRevision);
    expect(a.stockRevision).toBeGreaterThan(BASE.stockRevision);
  }, 60_000);
});

// Evidence picture for the architect: WO2793_PICTURE=1 writes a top view of
// every stage's motion and a section at y = 30 to src/tests/evidence/WO-2793/.
// Registered only when asked for, so the gate never sees it as a skipped test.
if (process.env.WO2793_PICTURE) describe('WO-2793 evidence picture', () => {
  it('draws the boss fixture stages', async () => {
    const { writeFileSync } = await import('node:fs');
    const r = await bossPlan();
    const part = steppedBoss();
    const COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#555'];
    const S = 8; // px per mm
    const top = (x: number) => 40 + (x + 10) * S;
    const topY = (y: number) => 40 + (70 - y) * S;
    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1420" height="700" font-family="sans-serif" font-size="13">`);
    out.push('<rect width="1420" height="700" fill="white"/>');
    out.push(`<text x="40" y="24">Top view: ${r.stages.length} stages, ${r.moves.length} moves. Rings outside in; dashed = links, red dots = descents in air.</text>`);
    out.push(`<rect x="${top(0)}" y="${topY(60)}" width="${60 * S}" height="${60 * S}" fill="#f2efe6" stroke="#999"/>`);
    out.push(`<rect x="${top(15)}" y="${topY(45)}" width="${30 * S}" height="${30 * S}" fill="#d9d9d9" stroke="#777"/>`);
    out.push(`<rect x="${top(20)}" y="${topY(40)}" width="${20 * S}" height="${20 * S}" fill="#b0b0b0" stroke="#555"/>`);
    for (const m of r.moves) {
      if (m.role === 'step-up') continue;
      const color = COLORS[m.stage < 0 ? 5 : m.stage % 5];
      const dash = m.role === 'link' ? ' stroke-dasharray="4 3"' : '';
      const w = m.route === 'transition' || m.route === 'lead-out' ? 2.5 : 1;
      if (m.role === 'descent') {
        out.push(`<circle cx="${top(m.to.x)}" cy="${topY(m.to.y)}" r="4" fill="#d00"/>`);
        continue;
      }
      out.push(`<line x1="${top(m.from.x)}" y1="${topY(m.from.y)}" x2="${top(m.to.x)}" y2="${topY(m.to.y)}" stroke="${color}" stroke-width="${w}"${dash}/>`);
    }
    r.stages.forEach((s, k) => out.push(
      `<text x="${40 + k * 120}" y="660" fill="${COLORS[k]}">stage ${k}: z ${s.z.toFixed(2)}</text>`,
    ));
    // Section at y = 30: part, final stock, stage planes.
    const X0 = 720;
    const sx = (x: number) => X0 + (x + 5) * 8;
    const sz = (z: number) => 120 + (5 - z) * 22;
    out.push(`<text x="${X0}" y="24">Section y = 30 (z exaggerated 2.75x): part grey, stock left after the pilot tan, stage planes coloured.</text>`);
    const j = Math.floor(30 / CELL);
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const x = i * CELL;
      out.push(`<rect x="${sx(x)}" y="${sz(r.stock.top[c])}" width="${CELL * 8}" height="${sz(-15) - sz(r.stock.top[c])}" fill="#f2efe6"/>`);
      out.push(`<rect x="${sx(x)}" y="${sz(part.top[c])}" width="${CELL * 8}" height="${sz(-15) - sz(part.top[c])}" fill="#b0b0b0"/>`);
    }
    r.stages.forEach((s, k) => {
      out.push(`<line x1="${sx(-5)}" y1="${sz(s.z)}" x2="${sx(65)}" y2="${sz(s.z)}" stroke="${COLORS[k]}" stroke-dasharray="6 3"/>`);
      out.push(`<text x="${sx(65) + 4}" y="${sz(s.z) + 4}" fill="${COLORS[k]}">${s.z.toFixed(2)}${s.z === -6.5 ? ' (pin)' : ''}${s.z === -11.5 ? ' (floor)' : ''}</text>`);
    });
    out.push(`<line x1="${sx(0)}" y1="${sz(0)}" x2="${sx(60)}" y2="${sz(0)}" stroke="#999" stroke-dasharray="2 2"/>`);
    out.push(`<text x="${sx(0)}" y="${sz(0) - 6}" fill="#666">original stock top</text>`);
    out.push('</svg>');
    writeFileSync('src/tests/evidence/WO-2793/boss-stages.svg', out.join('\n'));
  }, 60_000);
});
