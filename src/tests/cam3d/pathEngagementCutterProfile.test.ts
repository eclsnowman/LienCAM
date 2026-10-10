// WO-100 fix round: measurePathEngagement must report a FULL SLOT as a full slot for
// EVERY cutter kind adaptiveRough supports -- flat AND ball.
//
// THE DEFECT THIS PINS (audit of attempt 1):
//   The checker turned the swept volume into an engagement fraction by dividing by the
//   axial slab depth and comparing the result to the tool DIAMETER. That is exact for a
//   flat cutter, whose swept wall is vertical, so a full slot removes exactly
//   diameter * depth per mm of travel. A ball nose removes a circular SEGMENT, strictly
//   less than diameter * depth at the same depth -- so a ball cutter slotting at full
//   width was reported at a fraction of its real engagement and passed the 0.75 cap
//   comfortably. adaptiveRough explicitly accepts ball cutters (it validates
//   `flat | ball` and fails loud on anything else), so WO-100's rule was certifiable but
//   unproved for half the cutters the strategy actually runs.
//
// THE MEASURE THAT FIXES IT: normalise the fresh swept cross-section by what a FULL SLOT
// with THIS cutter at THIS axial depth would remove -- slotCrossSectionMm2 -- instead of
// by diameter * depth. For a flat cutter the two are the same number (a flat slot's
// cross-section IS diameter * depth), so every flat measurement on this branch is
// unchanged; for a ball the normaliser follows the sphere profile, so 1.0 means "full
// slot" for both kinds.
//
// The probes are the audit's own: uncut stock, one long straight move at a known axial
// depth, cells fine enough (0.1mm against a 10mm cutter) that quantization cannot
// explain the result. A slot must read >= 1.0 and trip the cap; a genuine stepover pass
// beside that slot must NOT trip it, so the fix cannot be "scale everything up until the
// ball case goes red".

import { describe, it, expect } from 'vitest';

import { measurePathEngagement, slotCrossSectionMm2 } from '../../cam3d/rough';
import type { Box3 } from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';
import type { IrMove } from '../../cam3d/ir/types';

const STOCK: Box3 = { minX: -20, minY: -20, minZ: -10, maxX: 220, maxY: 20, maxZ: 0 };
const CELL = 0.1;
const CAP = 0.75;
const DOC = 1; // axial depth of cut, mm -- stock top is z=0, so the tip rides at z=-1
const PASS_LEN = 200;

const FLAT: CutterSpec = { kind: 'flat', diameter: 10 };
const BALL: CutterSpec = { kind: 'ball', diameter: 10 };

/** A straight lateral cutting pass at y, tip at z = -DOC, preceded by its positioning. */
function pass(y: number, x0: number, x1: number): IrMove[] {
  return [
    { t: 'rapid', x: x0, y, z: -DOC, role: 'rapid' },
    { t: 'feed', x: x1, y, z: -DOC, role: 'cut' },
  ];
}

function measure(moves: IrMove[], cutter: CutterSpec) {
  return measurePathEngagement(moves, STOCK, CELL, cutter, { capFraction: CAP });
}

function report(label: string, m: ReturnType<typeof measurePathEngagement>): void {
  // eslint-disable-next-line no-console
  console.log(
    `${label}: peak ${(m.peakFraction * 100).toFixed(1)}% of a full slot; ` +
      `${m.overCapLengthMm.toFixed(0)}mm of ${m.cuttingLengthMm.toFixed(0)}mm cutting path ` +
      `over the ${(CAP * 100).toFixed(0)}% cap`,
  );
}

describe('measurePathEngagement: full-slot normalisation follows the cutter profile', () => {
  it('the full-slot cross-section follows the cutter profile', () => {
    // Flat: vertical wall, so diameter * depth exactly.
    expect(slotCrossSectionMm2(FLAT, DOC)).toBeCloseTo(10 * DOC, 9);
    // Ball R=5 at 1mm depth: circular segment R^2*acos((R-d)/R) - (R-d)*sqrt(2Rd-d^2)
    //   = 25*acos(0.8) - 4*3 = 16.0875... - 12 = 4.0875...
    // i.e. 40.9% of the flat figure -- exactly the shortfall that let a ball slot read
    // as bounded when it was normalised against diameter * depth.
    expect(slotCrossSectionMm2(BALL, DOC)).toBeCloseTo(4.087527, 5);
    // At depth == radius the ball has reached full width: half a disc.
    expect(slotCrossSectionMm2(BALL, 5)).toBeCloseTo((Math.PI * 25) / 2, 6);
    // Deeper still: half disc plus the full-width rectangle above it.
    expect(slotCrossSectionMm2(BALL, 8)).toBeCloseTo((Math.PI * 25) / 2 + 3 * 10, 6);
    // Monotone in depth, and never zero for a positive depth.
    expect(slotCrossSectionMm2(BALL, 2)).toBeGreaterThan(slotCrossSectionMm2(BALL, DOC));
  });

  it('a FLAT full-width slot reads as a slot and trips the cap', () => {
    const m = measure(pass(0, 0, PASS_LEN), FLAT);
    report(`flat d10, ${DOC}mm DOC, ${PASS_LEN}mm straight cut into uncut stock`, m);
    expect(m.peakFraction).toBeGreaterThan(1.0);
    expect(m.overCapLengthMm).toBeGreaterThan(PASS_LEN * 0.75);
  });

  it('a BALL full-width slot reads as a slot and trips the cap', () => {
    const m = measure(pass(0, 0, PASS_LEN), BALL);
    report(`ball d10, ${DOC}mm DOC, ${PASS_LEN}mm straight cut into uncut stock`, m);
    // This is the assertion the shipped checker failed: identical move, identical stock,
    // identical 100%-engaged geometry, reported ~41.6% because the flat normaliser was
    // applied to a sphere profile.
    expect(m.peakFraction).toBeGreaterThan(1.0);
    expect(m.overCapLengthMm).toBeGreaterThan(PASS_LEN * 0.75);
  });

  it('a BALL stepover pass beside that slot does NOT trip the cap', () => {
    // Slot first, then a 2mm-stepover pass back alongside it. Only the crescent of fresh
    // material counts for the second pass: analytically 1.933 mm^2/mm against a
    // 4.0875 mm^2/mm full slot, i.e. ~47%. So the peak is still the slot, and the
    // over-cap length must cover the SLOT ONLY -- if the normalisation were simply
    // inflated until ball slots go red, this second 200mm pass would go red with it.
    const moves = [...pass(0, 0, PASS_LEN), ...pass(2, PASS_LEN, 0)];
    const m = measure(moves, BALL);
    report(`ball d10, ${DOC}mm DOC, slot + 2mm stepover pass`, m);
    expect(m.cuttingLengthMm).toBeGreaterThan(PASS_LEN * 1.9);
    expect(m.peakFraction).toBeGreaterThan(1.0); // the slot
    expect(m.overCapLengthMm).toBeGreaterThan(PASS_LEN * 0.75);
    expect(m.overCapLengthMm).toBeLessThan(PASS_LEN * 1.15); // the stepover pass is not in it
  });

  it('can isolate actual lead-in engagement without counting the whole operation', () => {
    const moves: IrMove[] = [
      { t: 'rapid', x: 0, y: 0, z: -DOC, role: 'rapid' },
      { t: 'feed', x: 10, y: 0, z: -DOC, role: 'lead_in' },
      { t: 'feed', x: 110, y: 0, z: -DOC, role: 'cut' },
    ];
    const m = measurePathEngagement(moves, STOCK, CELL, FLAT, {
      capFraction: CAP,
      measuredRoles: new Set(['lead_in']),
    });
    expect(m.cuttingLengthMm).toBeCloseTo(10, 6);
    expect(m.peakFraction).toBeGreaterThan(0);
  });

  it('fails loud for cutter kinds the sweep cannot profile', () => {
    const bull = { kind: 'bull', diameter: 10, cornerRadius: 1 } as unknown as CutterSpec;
    expect(() => measure(pass(0, 0, PASS_LEN), bull)).toThrow(/not supported/);
    expect(() => slotCrossSectionMm2(bull, DOC)).toThrow(/not supported/);
  });
});
