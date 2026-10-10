// cam3d Toolpath IR fingerprint tests: the determinism contract that
// snapshot regression testing rests on.

import { describe, expect, it } from 'vitest';
import type { ToolpathIR } from '../../cam3d/ir/types';
import { irFingerprint } from '../../cam3d/ir/types';

function makeIR(): ToolpathIR {
  return {
    moves: [
      { t: 'rapid', x: 0, y: 0, z: 25, role: 'rapid' },
      { t: 'feed', x: 10.123456, y: 5, z: -2.5, f: 800, role: 'plunge' },
      { t: 'feed', x: 42, y: 5, z: -2.5, f: 1200, role: 'cut' },
      { t: 'arc', x: 44, y: 7, z: -2.5, i: 0, j: 2, cw: false, f: 1200, role: 'lead_out' },
      { t: 'rapid', x: 44, y: 7, z: 25 },
    ],
    meta: {
      strategyId: 'parallel_finish',
      cutterId: 'ball-6mm',
      params: { stepover: 0.5, angleDeg: 0, limits: { zTop: 25, zBottom: -2.5 } },
    },
  };
}

describe('irFingerprint', () => {
  it('is deterministic: two independently built identical IRs hash equal', () => {
    const a = irFingerprint(makeIR());
    const b = irFingerprint(makeIR());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('any single-field mutation changes the hash', () => {
    const base = irFingerprint(makeIR());
    const mutate = (fn: (ir: ToolpathIR) => void): string => {
      const ir = makeIR();
      fn(ir);
      return irFingerprint(ir);
    };
    const variants: Array<[string, string]> = [
      ['move type', mutate((ir) => (ir.moves[0].t = 'feed'))],
      ['x', mutate((ir) => (ir.moves[2].x += 0.00001))],
      ['y', mutate((ir) => (ir.moves[2].y += 0.00001))],
      ['z', mutate((ir) => (ir.moves[2].z += 0.00001))],
      ['f value', mutate((ir) => (ir.moves[2].f = 1000))],
      ['f removed', mutate((ir) => delete ir.moves[2].f)],
      ['i', mutate((ir) => (ir.moves[3].i = 1))],
      ['j', mutate((ir) => (ir.moves[3].j = 3))],
      ['cw flipped', mutate((ir) => (ir.moves[3].cw = true))],
      ['role changed', mutate((ir) => (ir.moves[2].role = 'finish'))],
      ['role removed', mutate((ir) => delete ir.moves[2].role)],
      ['move dropped', mutate((ir) => void ir.moves.pop())],
      ['moves reordered', mutate((ir) => ir.moves.reverse())],
      ['strategyId', mutate((ir) => (ir.meta.strategyId = 'waterline'))],
      ['cutterId', mutate((ir) => (ir.meta.cutterId = 'flat-6mm'))],
      ['params value', mutate((ir) => ((ir.meta.params as { stepover: number }).stepover = 0.6))],
      ['params nested value', mutate((ir) => {
        (ir.meta.params as { limits: { zTop: number } }).limits.zTop = 26;
      })],
      ['params removed', mutate((ir) => delete ir.meta.params)],
    ];
    for (const [label, hash] of variants) {
      if (hash === base) {
        throw new Error(`mutation '${label}' did not change the fingerprint`);
      }
    }
  });

  it('params key order does not affect the hash (content, not construction order)', () => {
    const a = makeIR();
    a.meta.params = { stepover: 0.5, angleDeg: 0, limits: { zTop: 25, zBottom: -2.5 } };
    const b = makeIR();
    b.meta.params = { limits: { zBottom: -2.5, zTop: 25 }, angleDeg: 0, stepover: 0.5 };
    expect(irFingerprint(a)).toBe(irFingerprint(b));
  });

  it('canonicalizes below the 1e-6 mm quantum (noise-immune by design)', () => {
    const a = makeIR();
    const b = makeIR();
    b.moves[2].x += 1e-9; // far below machining tolerance: same fingerprint
    expect(irFingerprint(a)).toBe(irFingerprint(b));
    // Negative zero is canonicalized to positive zero.
    const c = makeIR();
    c.moves[0].x = -0;
    expect(irFingerprint(c)).toBe(irFingerprint(a));
  });

  it('fails loud on non-finite coordinates', () => {
    const ir = makeIR();
    ir.moves[1].z = Number.NaN;
    expect(() => irFingerprint(ir)).toThrow(/non-finite/);
  });
});
