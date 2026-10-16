// WO-2758: read-only exterior-access analysis of the real z-dexel stock.
// Exact small fixtures; unit geometry is a control, not an application claim.

import { describe, expect, it } from 'vitest';
import type { CutterSpec } from '../../cam3d/kernel/types';
import {
  analyzeExteriorAccess,
  exteriorAccessAt,
  type ExteriorAccessInput,
  type ExteriorAccessResult,
} from '../../cam3d/rough/exteriorAccess';
import { maxTraverseIntrusion, removeSweep, ZDexelField } from '../../cam3d/stock';

// 60 x 60 mm block, 0.5 mm cells, stock from -20 to 0.
const CELL = 0.5;
const N = 120;
const FRAME = { originX: 0, originY: 0, nx: N, ny: N, cell: CELL };
const BAND = { topZ: -10, bottomZ: -15 };
const FLAT6: CutterSpec = { kind: 'flat', diameter: 6 };

/** Tops: `inside` over the 20 x 20 mm centre square [20, 40]^2, `outside` elsewhere. */
function centreSquare(inside: number, outside: number): ZDexelField {
  const tops = new Float64Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * CELL;
      const y = (j + 0.5) * CELL;
      tops[j * N + i] = x > 20 && x < 40 && y > 20 && y < 40 ? inside : outside;
    }
  }
  return ZDexelField.fromColumnTops(FRAME, tops, -20);
}

/** A closed pocket: walls to 0, pocket floor at -10. */
const closedPocket = (): ZDexelField => centreSquare(-10, 0);

/** Cut a slot at the pocket floor from the pocket centre out past the -x stock edge. */
function cutOpening(field: ZDexelField, cutter: CutterSpec, ys: number[]): void {
  for (const y of ys) {
    removeSweep(field, { x0: 30, y0: y, z0: -10, x1: -5, y1: y, z1: -10 }, cutter);
  }
}

function analyze(field: ZDexelField, over: Partial<ExteriorAccessInput> = {}) {
  return analyzeExteriorAccess({
    field,
    stockRevision: 1,
    band: BAND,
    cutter: FLAT6,
    fullStockProof: true,
    ...over,
  });
}

/**
 * Independent oracle (the existing collision service, not the module under
 * test): grid-centre tool positions, inside or outside the stock grid, whose
 * footprint covers (x, y) and which stand clear at the band top.
 */
function clearCentresCovering(field: ZDexelField, x: number, y: number, cutter: CutterSpec): number {
  const R = cutter.diameter / 2;
  const m = Math.ceil(R / CELL) + 1;
  const i0 = Math.floor((x - field.originX) / CELL);
  const j0 = Math.floor((y - field.originY) / CELL);
  let clear = 0;
  for (let j = j0 - m; j <= j0 + m; j++) {
    for (let i = i0 - m; i <= i0 + m; i++) {
      const cx = field.centerX(i);
      const cy = field.centerY(j);
      if (Math.hypot(cx - x, cy - y) > R) continue;
      const move = { x0: cx, y0: cy, z0: BAND.topZ, x1: cx, y1: cy, z1: BAND.topZ };
      if (maxTraverseIntrusion(field, move, cutter).intrusionMm <= 0) clear++;
    }
  }
  return clear;
}

/** Every column of every exterior component has an oracle-clear centre covering it. */
function expectExteriorColumnsCovered(res: ExteriorAccessResult, field: ZDexelField, cutter: CutterSpec): void {
  let checked = 0;
  for (let c = 0; c < res.componentOf.length; c++) {
    const id = res.componentOf[c];
    if (id < 0 || res.components[id].access !== 'exterior') continue;
    const i = c % field.nx;
    const j = (c - i) / field.nx;
    expect(clearCentresCovering(field, field.centerX(i), field.centerY(j), cutter)).toBeGreaterThan(0);
    checked++;
  }
  expect(checked).toBeGreaterThan(0);
  for (const comp of res.components) {
    if (comp.access === 'exterior') expect(comp.reachedColumns).toBe(comp.columns);
  }
}

/** Access label at (x, y) on a current result, or 'stale'. */
function accessAt(res: ExteriorAccessResult, field: ZDexelField, x: number, y: number): string | undefined {
  const at = exteriorAccessAt(res, field, res.stockRevision, x, y);
  return at.status === 'current' ? at.component?.access : at.status;
}

describe('WO-2758 exterior access analysis', () => {
  it('open boss in a block: the ring around the boss is one exterior component', () => {
    const field = centreSquare(0, -10);
    const res = analyze(field);
    expect(res.unresolvedReason).toBeUndefined();
    expect(res.components).toHaveLength(1);
    const ring = res.components[0];
    expect(ring.access).toBe('exterior');
    expect(ring.columns).toBe(N * N - 40 * 40);
    // The boss rises above the band: it is not band material.
    const boss = exteriorAccessAt(res, field, 1, 30, 30);
    expect(boss).toEqual({ status: 'current', component: undefined });
    const ringAt = exteriorAccessAt(res, field, 1, 10, 30);
    expect(ringAt.status === 'current' && ringAt.component?.id).toBe(ring.id);
    // Same answer for a ball cutter.
    expect(analyze(field, { cutter: { kind: 'ball', diameter: 6 } }).components[0].access).toBe('exterior');
  });

  it('closed pocket inside a block is enclosed', () => {
    const field = closedPocket();
    const res = analyze(field);
    // One enclosed body plus four inside-corner residues no 6 mm centre covers.
    expect(res.components.map((c) => c.access).sort()).toEqual([
      'enclosed', 'unreachable', 'unreachable', 'unreachable', 'unreachable',
    ]);
    expect(res.components.reduce((sum, c) => sum + c.columns, 0)).toBe(40 * 40);
    const body = exteriorAccessAt(res, field, 1, 30, 30);
    if (body.status !== 'current' || body.component === undefined) throw new Error('no pocket component');
    expect(body.component.access).toBe('enclosed');
    expect(body.component.maxTopZ).toBe(-10);
    expect(accessAt(res, field, 20.25, 20.25)).toBe('unreachable');
  });

  it('a real opening cut through the pocket wall makes the pocket exterior', () => {
    const field = closedPocket();
    const before = analyze(field, { stockRevision: 1 });
    expect(accessAt(before, field, 30, 30)).toBe('enclosed');

    // 10 mm wide opening: three 6 mm passes 2 mm apart.
    cutOpening(field, FLAT6, [28, 30, 32]);
    const after = analyze(field, { stockRevision: 2 });
    const exterior = after.components.filter((c) => c.access === 'exterior');
    expect(exterior).toHaveLength(1);
    const comp = exterior[0];
    // Everything else is inside-corner residue, never enclosed.
    expect(after.components.filter((c) => c !== comp).every((c) => c.access === 'unreachable')).toBe(true);
    expect(comp.columns).toBeGreaterThan(40 * 40);
    expect(comp.minI).toBe(0); // the opening reaches the stock edge
    const at = exteriorAccessAt(after, field, 2, 30, 30);
    expect(at.status === 'current' && at.component?.access).toBe('exterior');
    expectExteriorColumnsCovered(after, field, FLAT6);
  });

  it('a result queried against a different revision or changed field is stale', () => {
    const field = closedPocket();
    const res = analyze(field, { stockRevision: 7 });
    expect(res.stockRevision).toBe(7);
    expect(res.band).toEqual(BAND);
    expect(exteriorAccessAt(res, field, 7, 30, 30).status).toBe('current');
    expect(exteriorAccessAt(res, field, 8, 30, 30)).toEqual({ status: 'stale', reason: 'revision-mismatch' });

    // The caller forgot to bump the revision after a real cut: still stale.
    cutOpening(field, FLAT6, [30]);
    expect(exteriorAccessAt(res, field, 7, 30, 30)).toEqual({ status: 'stale', reason: 'field-changed' });
  });

  it('missing full-stock proof leaves every component unresolved', () => {
    const field = closedPocket();
    cutOpening(field, FLAT6, [28, 30, 32]);
    const res = analyze(field, { fullStockProof: false });
    expect(res.unresolvedReason).toBe('no-full-stock-proof');
    expect(res.components).toHaveLength(1);
    expect(res.components[0].access).toBe('unresolved');
    expect(res.components[0].reason).toBe('no-full-stock-proof');
  });

  it('a footprint wider than the gap is not reachable through it', () => {
    const field = closedPocket();
    // One 4 mm pass: a ~4 mm gap through the wall.
    cutOpening(field, { kind: 'flat', diameter: 4 }, [30]);
    const pocketWith = (cutter: CutterSpec) => {
      const res = analyze(field, { cutter });
      const at = exteriorAccessAt(res, field, 1, 30, 30);
      if (at.status !== 'current' || at.component === undefined) throw new Error('no pocket component');
      return { res, pocket: at.component };
    };
    const flat6 = pocketWith(FLAT6);
    expect(flat6.pocket.access).toBe('enclosed');
    expect(flat6.pocket.reachedColumns).toBe(0);
    // The slot floor at the stock edge is touched from outside: its own
    // exterior component, which does not leak into the pocket.
    const mouth = flat6.res.components.filter((c) => c.access === 'exterior');
    expect(mouth).toHaveLength(1);
    expect(mouth[0].minI).toBe(0);
    expect(mouth[0].maxI).toBeLessThan(40);
    expectExteriorColumnsCovered(flat6.res, field, FLAT6);
    expect(pocketWith({ kind: 'ball', diameter: 6 }).pocket.access).toBe('enclosed');
    // Control: a 2 mm cutter fits through the same gap.
    const flat2 = pocketWith({ kind: 'flat', diameter: 2 });
    expect(flat2.pocket.access).toBe('exterior');
    // One exterior body; only inside-corner residue is left over.
    expect(flat2.res.components.filter((c) => c.access === 'exterior')).toHaveLength(1);
    expect(flat2.res.components.every((c) => c.access === 'exterior' || c.access === 'unreachable')).toBe(true);
  });

  it('a dead-end slot narrower than the cutter is exterior only at its mouth (audit fixture)', () => {
    // 40 mm long, 4 mm wide slot at -10, open at the -x stock edge, closed at x = 40.
    const tops = new Float64Array(N * N);
    for (let j = 56; j < 64; j++) for (let i = 0; i < 80; i++) tops[j * N + i] = -10;
    const field = ZDexelField.fromColumnTops(FRAME, tops, -20);
    const deep = { x: 30.25, y: 30.25 };

    // Independent oracle (the existing collision service): no 6 mm centre
    // whose footprint covers the deep point stands clear at the band top.
    let clear = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = field.centerX(i);
        const y = field.centerY(j);
        if (Math.hypot(x - deep.x, y - deep.y) > 3) continue;
        const hit = maxTraverseIntrusion(field, { x0: x, y0: y, z0: -10, x1: x, y1: y, z1: -10 }, FLAT6);
        if (hit.intrusionMm <= 0) clear++;
      }
    }
    expect(clear).toBe(0);

    const res = analyze(field);
    const at = exteriorAccessAt(res, field, 1, deep.x, deep.y);
    // No clear centre covers it and no interior air touches it: unreachable.
    expect(at.status === 'current' && at.component?.access).toBe('unreachable');
    const exterior = res.components.filter((c) => c.access === 'exterior');
    expect(exterior).toHaveLength(1);
    expect(exterior[0].minI).toBe(0);
    // Only directly covered columns: nothing past x = 4 mm of a 40 mm slot.
    expect(exterior[0].reachedColumns).toBeGreaterThan(0);
    expect(field.centerX(exterior[0].maxI)).toBeLessThan(4);
    expect(exterior[0].columns + (at.status === 'current' ? at.component?.columns ?? 0 : 0)).toBe(640);
    expectExteriorColumnsCovered(res, field, FLAT6);

    // Second audit's boundary points: the mouth is exterior (clear centres
    // cover it); 2 mm in, no clear centre covers it, so it is not exterior.
    expect(clearCentresCovering(field, 0.25, 30.25, FLAT6)).toBeGreaterThan(0);
    expect(accessAt(res, field, 0.25, 30.25)).toBe('exterior');
    expect(clearCentresCovering(field, 2.25, 30.25, FLAT6)).toBe(0);
    expect(accessAt(res, field, 2.25, 30.25)).not.toBe('exterior');
    expect(accessAt(res, field, 30.25, 30.25)).not.toBe('exterior');

    // Control: a 2 mm cutter fits the slot; exterior at all three points.
    const flat2Cutter: CutterSpec = { kind: 'flat', diameter: 2 };
    const flat2 = analyze(field, { cutter: flat2Cutter });
    for (const x of [0.25, 2.25, 30.25]) expect(accessAt(flat2, field, x, 30.25)).toBe('exterior');
    expect(flat2.components.filter((c) => c.access === 'exterior')).toHaveLength(1);
    expect(flat2.components.every((c) => c.access === 'exterior' || c.access === 'unreachable')).toBe(true);
    expectExteriorColumnsCovered(flat2, field, flat2Cutter);
  });

  it('a narrow neck into a pocket: exterior stops near the mouth, the neck middle is not exterior', () => {
    const field = closedPocket();
    // 4 mm neck through the 20 mm wall (x 0..20) into the pocket.
    cutOpening(field, { kind: 'flat', diameter: 4 }, [30]);
    for (const cutter of [FLAT6, { kind: 'ball', diameter: 6 } as CutterSpec]) {
      const res = analyze(field, { cutter });
      // No clear centre covers the neck middle: unreachable.
      expect(clearCentresCovering(field, 10.25, 30.25, cutter)).toBe(0);
      expect(accessAt(res, field, 10.25, 30.25)).toBe('unreachable');
      const pocket = exteriorAccessAt(res, field, 1, 30, 30);
      expect(pocket.status === 'current' && pocket.component?.access).toBe('enclosed');
      const mouth = res.components.filter((c) => c.access === 'exterior');
      expect(mouth).toHaveLength(1);
      expect(mouth[0].minI).toBe(0);
      expect(field.centerX(mouth[0].maxI)).toBeLessThan(4);
      expectExteriorColumnsCovered(res, field, cutter);
    }
  });

  it('never mutates the field and is deterministic', () => {
    const field = closedPocket();
    cutOpening(field, FLAT6, [28, 30, 32]);
    const top = field.top.slice();
    const bottom = field.bottom.slice();
    const a = analyze(field);
    const b = analyze(field);
    expect(Buffer.from(field.top.buffer).equals(Buffer.from(top.buffer))).toBe(true);
    expect(Buffer.from(field.bottom.buffer).equals(Buffer.from(bottom.buffer))).toBe(true);
    expect(b.components).toEqual(a.components);
    expect(Buffer.from(b.componentOf.buffer).equals(Buffer.from(a.componentOf.buffer))).toBe(true);
    expect(b.fieldDigest).toBe(a.fieldDigest);
  });

  it('limits it cannot analyse are unresolved with a reason, never a guess', () => {
    const field = centreSquare(0, -10);
    expect(analyze(field, { workBudget: 1 }).components[0].reason).toBe('budget-exceeded');
    expect(analyze(field, { cellBudget: 100 }).components[0].reason).toBe('budget-exceeded');
    expect(
      analyze(field, { cutter: { kind: 'bull', diameter: 6, cornerRadius: 1 } }).components[0].reason,
    ).toBe('cutter-not-supported');

    // Material over a void (bottom raised above the stock floor) cannot be
    // expressed as upward-open stock.
    const shelf = closedPocket();
    shelf.bottom[60 * N + 60] = -12;
    const res = analyze(shelf);
    expect(res.unresolvedReason).toBeUndefined();
    expect(res.components[0].access).toBe('unresolved');
    expect(res.components[0].reason).toBe('not-upward-open');
  });
});
