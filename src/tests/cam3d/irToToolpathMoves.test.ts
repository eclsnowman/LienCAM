// cam3d converter tests: ToolpathIR -> ToolpathMove[] (the L6 boundary).
// Covers type mapping, absolute arc-center math (start-relative i/j ->
// absolute cx/cy), feed + role pass-through, exact order, determinism, the
// full IrMoveRole -> MoveRole coverage, and the fail-loud arc guards.

import { describe, expect, it } from 'vitest';
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves';
import type { IrMove, IrMoveRole, ToolpathIR } from '../../cam3d/ir/types';

const META = { strategyId: 'test', cutterId: 'ball-d6' } as const;

function ir(moves: IrMove[]): ToolpathIR {
  return { moves, meta: { ...META } };
}

describe('irToToolpathMoves', () => {
  it('maps types, computes absolute arc centers, and preserves feed/role/order', () => {
    // rapid -> (10,0); feed -> (10,10); cw arc -> (20,20) with start-relative
    // center (i=10,j=0) => absolute (20,10); ccw arc -> (30,20) with center
    // (i=5,j=-5) from start (20,20) => absolute (25,15).
    const program = ir([
      { t: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' },
      { t: 'feed', x: 10, y: 10, z: -1, f: 100, role: 'cut' },
      { t: 'arc', x: 20, y: 20, z: -1, f: 100, i: 10, j: 0, cw: true, role: 'finish' },
      { t: 'arc', x: 30, y: 20, z: -1, f: 50, i: 5, j: -5, cw: false, role: 'lead_out' },
    ]);
    const moves = irToToolpathMoves(program);
    expect(moves).toHaveLength(4);

    expect(moves[0]).toEqual({ type: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' });
    expect(moves[0].cx).toBeUndefined();
    expect(moves[0].cy).toBeUndefined();
    expect(moves[0].feed).toBeUndefined();

    expect(moves[1]).toEqual({ type: 'feed', x: 10, y: 10, z: -1, feed: 100, role: 'cut' });

    // cw arc: absolute center = start(10,10) + (10,0) = (20,10).
    expect(moves[2]).toEqual({
      type: 'arc_cw',
      x: 20,
      y: 20,
      z: -1,
      feed: 100,
      cx: 20,
      cy: 10,
      role: 'finish',
    });

    // ccw arc: absolute center = start(20,20) + (5,-5) = (25,15).
    expect(moves[3]).toEqual({
      type: 'arc_ccw',
      x: 30,
      y: 20,
      z: -1,
      feed: 50,
      cx: 25,
      cy: 15,
      role: 'lead_out',
    });
  });

  it('cw=undefined defaults to arc_ccw (only cw===true selects arc_cw)', () => {
    const moves = irToToolpathMoves(
      ir([
        { t: 'feed', x: 0, y: 0, z: 0 },
        { t: 'arc', x: 1, y: 1, z: 0, i: 1, j: 0 },
      ]),
    );
    expect(moves[1].type).toBe('arc_ccw');
    expect(moves[1].cx).toBe(1);
    expect(moves[1].cy).toBe(0);
  });

  it('omits feed and role when absent (undefined, not defaulted)', () => {
    const moves = irToToolpathMoves(ir([{ t: 'feed', x: 1, y: 2, z: 3 }]));
    expect(moves[0]).toEqual({ type: 'feed', x: 1, y: 2, z: 3 });
    expect('feed' in moves[0]).toBe(false);
    expect('role' in moves[0]).toBe(false);
  });

  it('is deterministic: converting twice is deep-equal', () => {
    const program = ir([
      { t: 'rapid', x: 3, y: 4, z: 9, role: 'rapid' },
      { t: 'feed', x: 3, y: 8, z: -2, f: 200, role: 'plunge' },
      { t: 'arc', x: 8, y: 8, z: -2, f: 200, i: 2.5, j: -1.25, cw: true, role: 'ramp' },
    ]);
    const a = irToToolpathMoves(program);
    const b = irToToolpathMoves(program);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('maps every IrMoveRole to a defined MoveRole (no silent drop)', () => {
    const roles: IrMoveRole[] = [
      'rapid',
      'cut',
      'plunge',
      'ramp',
      'lead_in',
      'lead_out',
      'stepover',
      'finish',
    ];
    for (const role of roles) {
      const moves = irToToolpathMoves(ir([{ t: 'feed', x: 0, y: 0, z: 0, role }]));
      expect(moves[0].role, `role ${role} dropped`).toBe(role);
      expect(moves[0].role).toBeDefined();
    }
  });

  it('preserves exact move order for a longer program', () => {
    const src: IrMove[] = [];
    for (let i = 0; i < 20; i++) {
      src.push({ t: i % 2 === 0 ? 'feed' : 'rapid', x: i, y: i * 2, z: -i, role: 'cut' });
    }
    const moves = irToToolpathMoves(ir(src));
    for (let i = 0; i < 20; i++) {
      expect(moves[i].x).toBe(i);
      expect(moves[i].y).toBe(i * 2);
      expect(moves[i].z).toBe(-i);
      expect(moves[i].type).toBe(i % 2 === 0 ? 'feed' : 'rapid');
    }
  });

  it('empty IR yields an empty array', () => {
    expect(irToToolpathMoves(ir([]))).toEqual([]);
  });

  it('fails loud when the first move is an arc (no known start)', () => {
    expect(() => irToToolpathMoves(ir([{ t: 'arc', x: 1, y: 1, z: 0, i: 1, j: 0 }]))).toThrow(
      /no preceding move/,
    );
  });

  it('fails loud when an arc is missing its i/j center offset', () => {
    expect(() =>
      irToToolpathMoves(ir([{ t: 'feed', x: 0, y: 0, z: 0 }, { t: 'arc', x: 1, y: 1, z: 0 }])),
    ).toThrow(/missing its i\/j/);
  });
});
