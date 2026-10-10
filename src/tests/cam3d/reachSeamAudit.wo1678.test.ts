// WO-1678 AUDIT (independent seat) - a reproducer for a gap the seam's own
// decide-and-log leaves unexamined.
//
// trimToToolReachInPartFrame (src/store/toolReachInputs.ts) drops the PART mesh
// entirely whenever ANY stock is known ("knowsStock" - stockBounds present or
// remainingStock present), on the reasoning that "the part sits inside the
// stock" (WO-1678 decide-and-log #3). That holds only while the declared stock
// actually encloses the part. When it does not - stock defined smaller than the
// real part (a plain data-entry mistake: stock not resized after the part grew,
// wrong units, wrong body picked) - the seam's stock-obstacle grid is windowed
// to the declared stock block ONLY (holderClearanceGate.ts `gridWindow` clips
// to `block.min`/`block.max`), so a move that sits outside that declared block
// is invisible to the stock check too. With the part check dropped and the
// stock window not covering the true material, the move is trimmed by NEITHER
// obstacle and is emitted exactly as planned, even though the tool assembly is
// physically buried in solid part material at that position.
//
// This is not true for 2D: resolveToolReachInputs (src/store/toolReachInputs.ts)
// puts the part on every request that has a model body, stock or no stock, so
// the same mismatch is caught there. The 3D seam's own acceptance line reads
// "through the same inputs ... the 2D operations use today" - this is a place
// where it is not the same input.

import { describe, expect, it } from 'vitest';
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs';
import type { Box3 } from '../../cam3d/stock';
import type { ClearanceMesh } from '../../lib/cam/holderClearance';
import type { Tool, ToolHolder, ToolpathMove } from '../../types';

// A solid 60 x 60 x 20 mm block - the TRUE part. Declared stock below covers
// only its left half in X, as if the stock was never resized after the part
// grew (or the wrong body/units were picked for the stock definition).
function box(min: [number, number, number], max: [number, number, number]): ClearanceMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

const PART: ClearanceMesh = box([0, 0, 0], [60, 60, 20]);

/** Declared stock: only x in [0, 30] - half of the true part's footprint. */
const UNDERSIZED_STOCK: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 30, maxY: 60, maxZ: 20 };

const HOLDER: ToolHolder = {
  id: 'holder-1',
  name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
};

/** 5 mm stickout below a 20 mm holder: the assembly cannot reach past
 *  topZ(20) - 5 + 0.25 = 15.25 without the holder meeting solid material. */
const TOOL: Tool = {
  id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 5, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 3, stepover: 1.5 } },
} as unknown as Tool;

describe('WO-1678 AUDIT: the seam when the declared stock is smaller than the true part', () => {
  it('a cut inside the declared stock, at an unreachable depth, IS trimmed (control)', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 15, y: 30, z: 25, role: 'rapid' } as ToolpathMove,
      { type: 'feed', x: 15, y: 30, z: 12, feed: 300, role: 'plunge' } as ToolpathMove,
    ];
    const reach = trimToToolReachInPartFrame({
      operation: 'Adaptive 3D', moves, tool: TOOL, holder: HOLDER, stockBounds: UNDERSIZED_STOCK,
      part: PART, partToleranceMm: 0.05, params: {}, workholding: [], noEarlierOperations: true,
    });
    const deepest = Math.min(...reach.moves.map((move) => move.z));
    expect(deepest).toBeGreaterThanOrEqual(20 - 5 + 0.25 - 1e-6);
    expect(reach.notices.some((notice) => /cut stopped at/.test(notice))).toBe(true);
  });

  it('the SAME unreachable cut, at the same depth, OUTSIDE the declared stock\'s footprint but still ' +
    'inside the real part, is emitted untouched - the holder is never trimmed clear of the part it is ' +
    'physically buried in', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 45, y: 30, z: 25, role: 'rapid' } as ToolpathMove,
      { type: 'feed', x: 45, y: 30, z: 12, feed: 300, role: 'plunge' } as ToolpathMove,
    ];
    const reach = trimToToolReachInPartFrame({
      operation: 'Adaptive 3D', moves, tool: TOOL, holder: HOLDER, stockBounds: UNDERSIZED_STOCK,
      part: PART, partToleranceMm: 0.05, params: {}, workholding: [], noEarlierOperations: true,
    });

    // What SHOULD happen: the same reach floor (15.25) applies - the part is
    // solid there too - so this move should be trimmed exactly like the control
    // above.
    const deepest = Math.min(...reach.moves.map((move) => move.z));
    // FAILS on the current seam: the move at z=12 survives untouched (deepest
    // stays 12, far below the reach floor of 15.25), and no stop is printed,
    // because stockBounds being present drops the part-mesh check entirely
    // (trimToToolReachInPartFrame omits `clearancePart` whenever `knowsStock`),
    // while the stock obstacle's own grid window is clipped to the declared
    // stock block and never reaches x = 45 at all.
    expect(deepest).toBeGreaterThanOrEqual(20 - 5 + 0.25 - 1e-6);
    expect(reach.notices.some((notice) => /cut stopped at/.test(notice))).toBe(true);
  });
});
