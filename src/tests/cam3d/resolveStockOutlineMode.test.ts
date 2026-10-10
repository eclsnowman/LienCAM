// Stage C-3 SAFETY GATE unit test for resolveStockOutlineMode (pure/fast).
//
// The store's stock-outline full-clear decision is browser-only, so the decision
// is extracted into resolveStockOutlineMode. This pins every branch:
//  - full-clear only when single-part + unspun + footprint,
//  - LOUD part-bounds fallback (with a reason) for each of: spun, no-footprint,
//    and >1 part (nesting), and
//  - the multi-part reason names the part count (so the UI/console message tells
//    the user how many neighbours would have been machined).

import { describe, expect, it } from 'vitest';

import {
  resolveStockOutlineMode,
  roughingScopeFallbackMessage,
} from '../../cam3d/integration/adaptive3dOperation';

const base = {
  useStockBoundary: true,
  unspun: true,
  hasFootprint: true,
  solidPartsOnStock: 1,
  opName: 'Rough A',
};

describe('resolveStockOutlineMode (Stage C-3 safety gate)', () => {
  it('full-clear when single-part + unspun + footprint', () => {
    const d = resolveStockOutlineMode(base);
    expect(d.mode).toBe('full-clear');
    // full-clear carries no reason field.
    expect((d as { reason?: string }).reason).toBeUndefined();
  });

  it('part-bounds + reason when the part is spun (rotated stock)', () => {
    const d = resolveStockOutlineMode({ ...base, unspun: false });
    expect(d.mode).toBe('part-bounds');
    expect(d).toMatchObject({ mode: 'part-bounds', cause: 'rotated-part' });
    const reason = (d as { reason: string }).reason;
    expect(reason).toContain('unspun');
    expect(reason).toContain('"Rough A"');
    expect(roughingScopeFallbackMessage(d)).toBe(
      'Clear all stock cannot run because the part is rotated. The engine uses Clear around part instead.',
    );
  });

  it('part-bounds + reason when the footprint could not be resolved', () => {
    const d = resolveStockOutlineMode({ ...base, hasFootprint: false });
    expect(d.mode).toBe('part-bounds');
    const reason = (d as { reason: string }).reason;
    expect(reason).toContain('could not resolve the stock footprint');
    expect(reason).toContain('"Rough A"');
  });

  it('part-bounds + reason when >1 solid part shares the stock, naming the count', () => {
    const d = resolveStockOutlineMode({ ...base, solidPartsOnStock: 3 });
    expect(d.mode).toBe('part-bounds');
    const reason = (d as { reason: string }).reason;
    // The multi-part message must NAME the count so the user knows how many
    // neighbours would have been machined.
    expect(reason).toContain('3 parts share this stock');
    expect(reason).toContain('machine the neighbours');
    expect(reason).toContain('"Rough A"');
  });

  it('precedence: spun beats the multi-part message (unspun checked first)', () => {
    const d = resolveStockOutlineMode({ ...base, unspun: false, solidPartsOnStock: 5 });
    expect(d.mode).toBe('part-bounds');
    expect((d as { reason: string }).reason).toContain('unspun');
  });

  it('neutral part-bounds when the gate is consulted with useStockBoundary false', () => {
    const d = resolveStockOutlineMode({ ...base, useStockBoundary: false });
    expect(d.mode).toBe('part-bounds');
    expect((d as { reason: string }).reason).toContain('not requested');
    expect(roughingScopeFallbackMessage(d)).toBeUndefined();
  });
});
