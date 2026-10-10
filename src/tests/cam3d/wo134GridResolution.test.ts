// WO-134: a face the cutter can clear must never be dropped because of GRID
// RESOLUTION.
//
// WO-101 taught the depth ladder to land on every horizontal part surface, and
// criticalDepths.ts decides what counts as a surface by asking two questions of
// each height bucket: is it a PLANE (some column is locally horizontal), and is
// it BIG ENOUGH for the tool (full plan-view area >= the cutter's cross
// section). Question 1's original form -- "every material-carrying neighbour of
// this column is level with it" -- is a statement about the GRID, not about the
// tool: a face only TWO cells wide has no such column at all, because every one
// of its cells touches the lower material on at least one side.
//
// The audit of WO-101 constructed that case and ran the real functions:
//
//   2 x 2-cell plateau at Z=5, 2 mm cells, surrounding solid floor at Z=2,
//   3 mm cutter. The represented face is 4 x 4 mm (16 mm^2) against the
//   cutter's 7.0686 mm^2 cross-section -- it fits in BOTH dimensions.
//     findCriticalDepths      -> [2]            (Z=5 omitted)
//     planLevels(10, 0, 4, pins) -> [6, 2, 0]   (Z=5 omitted)
//   The Z=6 pass leaves 1 mm above that face; the later Z=2 pass sees the Z=5
//   plateau and masks it. The remainder survives.
//
// Those two arrays are the RED this file was written against. `cellSize` is
// caller-supplied and ZDexelField coarsens it further under the cell budget, so
// this is reachable on real jobs.
//
// THE FIX is a NARROWING of question 1, not its removal. The original test
// stays exactly as it was and a SECOND, resolution-independent way to qualify
// is added beside it: a column is also locally horizontal when it is one corner
// of a fully level 2 x 2 QUAD of columns. A 2 x 2 quad at one height is a plane
// at grid resolution and nothing else is -- every artefact the original test
// exists to reject (a quantised slope's contour strip, a dome's scattered
// symmetric columns, a 1-cell ridge crest) is at most ONE cell wide somewhere,
// so no quad closes on it. The sloped and dome controls below are what hold
// that claim down.
//
// WHY THE OLD CONTROLS COULD NOT SEE THIS. wo101RemainderPasses.test.ts's
// positive small-face control uses 1 mm cells, so its 4 x 4 mm face spans 4 x 4
// cells and HAS an interior column; its negative control is 2 x 2 mm at 1 mm
// cells and is genuinely smaller than the 3 mm cutter. Both move physical size
// and cell count together, so neither separates "too small for the cutter" (a
// correct refusal) from "too few grid columns for this heuristic" (this defect).
// Every fixture below holds PHYSICAL size constant and varies CELL size.
//
// AND THE OTHER HALF OF THE RULE (fix round, after the audit of attempt 1). The
// quad answers the 2 x 2-cell case by HANDLING it. It cannot answer the ONE-cell
// case: a single sample of a 4 x 4 mm face at 4 mm cells is bit-for-bit the same
// grid as a single sample of a dome's pole, so pinning it would mint a level on
// every curve and dropping it silently leaves 1 mm of commanded material -- the
// original RED, one resolution coarser. The WO allows exactly two endings, and
// this is the case for the second: the operation REFUSES, loudly and by name,
// stating the cell size and the face it cannot resolve.
//
// WHERE THAT REFUSAL WAS KEYED, AND WHY IT MOVED (round 3, after the audit of
// the fix round). The fix round armed the refusal only once ONE COLUMN was
// itself tool-SIZED (cellArea >= minFlatArea, i.e. cell >= 0.886 x the tool).
// Its audit ran the case that sits just under that line, through the REAL mesh
// sampler rather than a hand-built field:
//
//   a 3.2 x 3.2 mm pocket floor at Z=8 in a 20 x 20 x 14 mm pocketBox, a 3 mm
//   cutter, 2 mm cells. The floor is wider than the cutter in both directions,
//   but partField samples cell CENTRES, and one centre lands inside it:
//     findCriticalDepths          -> [14]                     (Z=8 omitted)
//     planLevels(15, 0, 4, pins)  -> [14, 10.5, 7, 3.5, 0]    (Z=8 omitted)
//   One column, 4 mm^2 represented against the cutter's 7.0686 mm^2 -- UNDER
//   the old trigger, so the job was accepted and the ladder stepped over the
//   floor. The same silence, one band lower.
//
// That is the RED this round was written against, and the fixture below runs it
// through buildPartHeightField, not a synthetic field. The sharpest form of it
// is worse still and is also pinned below: the WO's own 4 x 4 mm face at 2 mm
// cells pins on one stock origin and vanishes entirely on an origin half a cell
// over. Whether commanded material survives cannot be decided by where the
// stock box happens to start.
//
// THE KEY MOVED TO THE POINT WHERE THE GRID STOPS SEEING THE TOOL: a face the
// cutter can stand on is guaranteed to close a quad at ANY grid phase exactly
// when cell <= across / (2*sqrt(2)) (~= 0.354 x the tool diameter; see
// criticalDepths.ts). At or below that, nothing changes at all and the ramp,
// cone and dome controls below still mint nothing, silently. Above it the scan
// refuses -- over material it cannot resolve AND cannot rule out as a face the
// tool would fit on, judged by the one sound statement centre sampling
// supports: the face holds the sampled centres and no neighbouring centre.
// Its conservative component extent includes diagonal grid phase, because a
// round face can bulge between sample rows beyond the old axis-only bound.
// A genuinely isolated sub-tool feature therefore stays silent; a
// maybe-tool-sized connected component is loud. The price is stated plainly
// in the source header and held down by the controls below: a sloped or curved
// part on a grid coarser than ~0.35 x the tool now refuses where it used to run
// and might have left a tread.

import { describe, it, expect, beforeAll } from 'vitest';

import { ZDexelField, remainingAbove, type Box3 } from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { pocketBox } from '../../cam3d/fixtures';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import {
  planLevels,
  findCriticalDepths,
  buildPartHeightField,
  frameOf,
} from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types';

/** The error NAME the operation must refuse with -- the wire contract a caller
 *  (or the operation UI) matches on, exactly as 'AbortError' is matched. */
const GRID_RESOLUTION_ERROR = 'GridResolutionError';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 3 };
const TOOL_R = CUTTER.diameter / 2;
const CUTTER_AREA = Math.PI * TOOL_R * TOOL_R; // 7.0686 mm^2

/**
 * At or below this cell size the grid is guaranteed to sample any face the
 * cutter can stand on with a full 2 x 2 block of columns, whatever the grid's
 * phase -- so question 1 sees every such face and the scan never refuses.
 * 1.0607 mm for a 3 mm cutter. Every "runs to a verdict" control below sits at
 * or under it; every refusal control sits above it.
 */
const RESOLVING_CELL = CUTTER.diameter / (2 * Math.SQRT2);
/** Cell sizes the grid can still see this cutter with. */
const FINE_CELLS = [0.5, 1] as const;

/** A Z=2 slab with two isolated Z=5 posts centred on grid samples six cells
 *  apart. Each post is physically smaller than the cutter, and even the most
 *  conservative single-sample extent is only 2*cell = 2.8 mm. */
function disconnectedSubToolPosts(): PartMesh {
  const b = new MeshBuilder();
  const addBox = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): void => {
    const lo = [
      b.vertex(x0, y0, z0), b.vertex(x1, y0, z0),
      b.vertex(x1, y1, z0), b.vertex(x0, y1, z0),
    ];
    const hi = [
      b.vertex(x0, y0, z1), b.vertex(x1, y0, z1),
      b.vertex(x1, y1, z1), b.vertex(x0, y1, z1),
    ];
    b.quad(lo[0], lo[3], lo[2], lo[1]);
    b.quad(hi[0], hi[1], hi[2], hi[3]);
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      b.quad(lo[k], lo[next], hi[next], hi[k]);
    }
  };
  addBox(0, 0, 14, 14, 0, 2);
  addBox(1.75, 1.75, 2.45, 2.45, 2, 5);
  addBox(10.15, 10.15, 10.85, 10.85, 2, 5);
  return b.build();
}

/** A Z=2 square floor carrying a horizontal round face at Z=5. */
function roundFaceOnFloor(opts: {
  span: number;
  cx: number;
  cy: number;
  diameter: number;
}): PartMesh {
  const b = new MeshBuilder();
  const lo = [
    b.vertex(0, 0, 0),
    b.vertex(opts.span, 0, 0),
    b.vertex(opts.span, opts.span, 0),
    b.vertex(0, opts.span, 0),
  ];
  const hi = [
    b.vertex(0, 0, 2),
    b.vertex(opts.span, 0, 2),
    b.vertex(opts.span, opts.span, 2),
    b.vertex(0, opts.span, 2),
  ];
  b.quad(lo[0], lo[3], lo[2], lo[1]);
  b.quad(hi[0], hi[1], hi[2], hi[3]);
  for (let k = 0; k < 4; k++) {
    const next = (k + 1) % 4;
    b.quad(lo[k], lo[next], hi[next], hi[k]);
  }

  const segments = 96;
  const radius = opts.diameter / 2;
  const topCenter = b.vertex(opts.cx, opts.cy, 5);
  const lower: number[] = [];
  const upper: number[] = [];
  for (let k = 0; k < segments; k++) {
    const angle = (2 * Math.PI * k) / segments;
    const x = opts.cx + radius * Math.cos(angle);
    const y = opts.cy + radius * Math.sin(angle);
    lower.push(b.vertex(x, y, 2));
    upper.push(b.vertex(x, y, 5));
  }
  for (let k = 0; k < segments; k++) {
    const next = (k + 1) % segments;
    b.quad(lower[k], lower[next], upper[next], upper[k]);
    b.tri(topCenter, upper[k], upper[next]);
  }
  return b.build();
}

/**
 * A synthetic part heightfield in WORLD units. The grid is sized to cover
 * `span` mm square at `cell` mm, the surrounding material stands at `solidTo`
 * (open air when omitted), and each plateau is placed by its world rectangle so
 * the SAME physical face can be re-sampled at any cell size.
 */
function fieldWithPhysicalPlateaus(opts: {
  span: number;
  cell: number;
  base: number;
  solidTo?: number;
  plateaus: ReadonlyArray<{ x0: number; y0: number; w: number; h: number; z: number }>;
}): ZDexelField {
  const n = Math.round(opts.span / opts.cell);
  const tops = new Float32Array(n * n).fill(opts.solidTo ?? opts.base);
  for (let j = 0; j < n; j++) {
    const y = (j + 0.5) * opts.cell;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * opts.cell;
      for (const p of opts.plateaus) {
        if (x >= p.x0 && x <= p.x0 + p.w && y >= p.y0 && y <= p.y0 + p.h) tops[j * n + i] = p.z;
      }
    }
  }
  return ZDexelField.fromColumnTops(
    { originX: 0, originY: 0, nx: n, ny: n, cell: opts.cell },
    tops,
    opts.base,
  );
}

/** Columns whose material top is within tol of z -- the face as the grid has it. */
function columnsAt(field: ZDexelField, z: number, tol = 1e-6): number {
  let n = 0;
  for (let c = 0; c < field.top.length; c++) {
    if (field.top[c] > field.bottom[c] && Math.abs(field.top[c] - z) <= tol) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
describe("WO-134: the audit's 2 x 2-cell fixture", () => {
  // Exactly the audit's numbers: 2 mm cells, a 4 x 4 mm plateau at Z=5 standing
  // 3 mm proud of a SOLID floor at Z=2 (so no neighbour is open air and the
  // "edge of the face abstains" escape hatch cannot fire), 3 mm cutter.
  const CELL = 2;
  const FACE_MM = 4;
  const build = (): ZDexelField =>
    fieldWithPhysicalPlateaus({
      span: 40,
      cell: CELL,
      base: 0,
      solidTo: 2,
      plateaus: [{ x0: 16, y0: 16, w: FACE_MM, h: FACE_MM, z: 5 }],
    });

  it('represents the face as exactly 2 x 2 cells, tool-sized in BOTH dimensions', () => {
    const field = build();
    const cols = columnsAt(field, 5);
    const area = cols * field.cell * field.cell;

    console.log(
      `WO-134 fixture: cell ${field.cell} mm; face ${FACE_MM} x ${FACE_MM} mm is ${cols} columns ` +
        `(${area} mm^2) vs cutter cross-section ${CUTTER_AREA.toFixed(4)} mm^2; ` +
        `face width ${FACE_MM} mm vs cutter diameter ${CUTTER.diameter} mm`,
    );

    expect(cols).toBe(4); // 2 x 2 cells -- no interior column exists at all
    expect(area).toBeGreaterThan(CUTTER_AREA); // the cutter fits by area...
    expect(FACE_MM).toBeGreaterThan(CUTTER.diameter); // ...and in both dimensions
  });

  it('pins Z=5: the ladder must not step over a face the cutter can clear', () => {
    const field = build();
    const pins = findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
    const levels = planLevels(10, 0, 4, pins);

    console.log(
      `WO-134 audit fixture: findCriticalDepths -> [${pins.join(', ')}] ` +
        `(RED was [2]); planLevels(10, 0, 4, pins) -> [${levels.join(', ')}] (RED was [6, 2, 0])`,
    );

    expect(pins).toContain(5);
    expect(levels).toContain(5);
    // The surrounding floor at Z=2 was always found; finding Z=5 must not lose it.
    expect(pins).toEqual([5, 2]);
    // No pass is silently deepened past the stepdown by the extra level.
    let prev = 10;
    for (const z of levels) {
      expect(z).toBeLessThan(prev);
      expect(prev - z).toBeLessThanOrEqual(4 + 1e-9);
      prev = z;
    }
    expect(levels[levels.length - 1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE CONTROL PAIR: hold PHYSICAL size constant, vary CELL size. This is the
// only shape that separates "too small for the cutter" from "too few columns".
// ---------------------------------------------------------------------------

describe('WO-134: the same physical face reaches the same conclusion at any cell size', () => {
  const CELLS = [0.5, 1, 2] as const;

  /** The face as a boss on a solid floor at Z=2 -- every neighbour is material. */
  const faceAt = (cell: number, faceMm: number): ZDexelField =>
    fieldWithPhysicalPlateaus({
      span: 40,
      cell,
      base: 0,
      solidTo: 2,
      plateaus: [{ x0: 16, y0: 16, w: faceMm, h: faceMm, z: 5 }],
    });

  it('a 4 x 4 mm face (bigger than the 3 mm cutter) is pinned at 0.5, 1 and 2 mm cells', () => {
    const rows = CELLS.map((cell) => {
      const field = faceAt(cell, 4);
      const cols = columnsAt(field, 5);
      const pins = findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
      return { cell, cols, area: cols * cell * cell, pins };
    });

    console.log(
      'WO-134 constant 4 x 4 mm face:\n' +
        rows
          .map(
            (r) =>
              `  cell ${r.cell} mm -> ${r.cols} columns (${r.area} mm^2), pins [${r.pins.join(', ')}]`,
          )
          .join('\n'),
    );

    // Column COUNT collapses 64 -> 16 -> 4 while the physical face never moves...
    expect(rows.map((r) => r.cols)).toEqual([64, 16, 4]);
    // ...so the physical conclusion must not move either.
    for (const r of rows) expect(r.pins).toEqual([5, 2]);
  });

  it('a 2 x 2 mm face (smaller than the 3 mm cutter) is dropped at every cell size that sees the cutter', () => {
    const rows = FINE_CELLS.map((cell) => {
      const field = faceAt(cell, 2);
      const cols = columnsAt(field, 5);
      const pins = findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
      return { cell, cols, area: cols * cell * cell, pins };
    });

    console.log(
      'WO-134 constant 2 x 2 mm face (below the cutter):\n' +
        rows
          .map(
            (r) =>
              `  cell ${r.cell} mm -> ${r.cols} columns (${r.area} mm^2), pins [${r.pins.join(', ')}]`,
          )
          .join('\n'),
    );

    // At 0.5 and 1 mm cells the face HAS a level quad, so question 1 passes and
    // only the AREA gate can reject it -- which is the correct reason. The
    // verdict is the same at every resolution the grid can see the cutter at:
    // the tool cannot stand on it.
    for (const r of rows) {
      expect(r.cell).toBeLessThanOrEqual(RESOLVING_CELL);
      expect(r.area).toBeLessThan(CUTTER_AREA);
      expect(r.pins).toEqual([2]); // the floor only; the boss earns nothing
    }
  });

  it('past the resolving cell that same sub-cutter face is refused, not guessed at', () => {
    // 2 mm cells with a 3 mm cutter is past RESOLVING_CELL, and the fixture
    // collapses onto ONE column. That single sample is the SAME grid a 3.9 mm
    // face would leave, so "smaller than the cutter" is no longer something the
    // grid knows -- it is something the previous rounds assumed. Guessing it in
    // either direction is what this WO forbids: guess small and a commanded
    // face is silently dropped, guess big and every curve mints a level.
    const field = faceAt(2, 2);
    expect(2).toBeGreaterThan(RESOLVING_CELL);
    expect(columnsAt(field, 5)).toBe(1);
    expect(() =>
      findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA }),
    ).toThrow(/cannot resolve/i);
  });
});

// ---------------------------------------------------------------------------
// THE OVERCORRECTION THIS MUST NOT BE: question 1 still has to reject curvature
// and slope, or every quantised surface mints levels.
// ---------------------------------------------------------------------------

describe('WO-134: the neighbour-height test still refuses slope and curvature', () => {
  /** A plane tilted in x: heights step by `slopePerMm * cell` per column. */
  function ramp(cell: number, slopePerMm: number): ZDexelField {
    const n = Math.round(40 / cell);
    const tops = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) tops[j * n + i] = 2 + (i + 0.5) * cell * slopePerMm;
    }
    return ZDexelField.fromColumnTops({ originX: 0, originY: 0, nx: n, ny: n, cell }, tops, 0);
  }

  it('a sloped surface mints no level, silently, at every cell size that sees the cutter', () => {
    for (const cell of FINE_CELLS) {
      const pins = findCriticalDepths(ramp(cell, 0.25), {
        stockTopZ: 20,
        floorZ: 0,
        minFlatArea: CUTTER_AREA,
      });
      console.log(`WO-134 ramp (0.25 mm/mm) at cell ${cell} mm: pins [${pins.join(', ')}]`);
      // Each contour of a ramp is a full-length strip ONE column wide -- easily
      // past the area gate, so only question 1 can reject it. No quad closes on
      // a 1-column strip. This is the overcorrection the WO forbids and it is
      // still not made: no level is minted, and no refusal is raised either.
      expect(pins).toEqual([]);
      expect(planLevels(20, 0, 4, pins)).toEqual(planLevels(20, 0, 4));
    }
  });

  it('past the resolving cell a ramp refuses rather than promising -- and still mints nothing', () => {
    // The stated price of round 3, pinned so it can never become accidental.
    // At 2 mm cells with a 3 mm cutter a ramp's 1-column contour strip could
    // hide a 3.9 mm-wide tread, and the grid has no way to tell -- so the job
    // is refused. What it must NOT do is invent a level: the failure mode this
    // WO names is spurious levels on sloped stock, and the refusal path emits
    // no pins at all rather than emitting bad ones.
    let thrown: unknown;
    try {
      findCriticalDepths(ramp(2, 0.25), { stockTopZ: 20, floorZ: 0, minFlatArea: CUTTER_AREA });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).name).toBe(GRID_RESOLUTION_ERROR);
    console.log(`WO-134 ramp at cell 2 mm (> ${RESOLVING_CELL.toFixed(4)} mm): refuses by name`);
  });

  it('a cone mints no level: concentric rings are one column wide everywhere', () => {
    const cell = 1;
    const n = 40;
    const tops = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const y = (j + 0.5) * cell - 20;
      for (let i = 0; i < n; i++) {
        const x = (i + 0.5) * cell - 20;
        const r = Math.hypot(x, y);
        tops[j * n + i] = 2 + Math.max(0, 15 - r * 0.75);
      }
    }
    const field = ZDexelField.fromColumnTops(
      { originX: 0, originY: 0, nx: n, ny: n, cell },
      tops,
      0,
    );
    const pins = findCriticalDepths(field, { stockTopZ: 20, floorZ: 0, minFlatArea: CUTTER_AREA });

    console.log(`WO-134 cone: pins [${pins.join(', ')}] (the flat skirt at Z=2 is the only plane)`);

    // The only true plane on a cone-on-a-slab is the slab top; the cone itself
    // contributes nothing however many columns share a radius.
    expect(pins).toEqual([2]);
  });

});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE RULE: where the grid can no longer JUDGE, refuse loudly.
// ---------------------------------------------------------------------------

describe('WO-134: a face the grid cannot resolve is refused by name, never dropped', () => {
  /** The same physical 4 x 4 mm face, now sampled onto a SINGLE 4 mm column. */
  const oneCellFace = (): ZDexelField =>
    fieldWithPhysicalPlateaus({
      span: 40,
      cell: 4,
      base: 0,
      solidTo: 2,
      plateaus: [{ x0: 16, y0: 16, w: 4, h: 4, z: 5 }],
    });

  it('refuses the one-cell 4 x 4 mm face instead of stepping the ladder over it', () => {
    const field = oneCellFace();
    const cols = columnsAt(field, 5);
    // The face the audit named: ONE column, but that column is 16 mm^2 -- more
    // than twice the cutter's cross-section, so this is material the caller was
    // told would be cut. Attempt 1 returned [2] here and planLevels then gave
    // [6, 2, 0]: 1 mm left standing, the original RED one resolution coarser.
    expect(cols).toBe(1);
    expect(cols * 4 * 4).toBeGreaterThan(CUTTER_AREA);

    let thrown: unknown;
    try {
      findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    console.log(`WO-134 refusal: ${err.name}: ${err.message}`);

    // Named, so a caller can match it the way 'AbortError' is matched.
    expect(err.name).toBe(GRID_RESOLUTION_ERROR);
    // ...and it NAMES the cell size and the face, which is what the WO requires
    // of the refusal branch. Nothing here is a substring of the other.
    expect(err.message).toMatch(/\b4 mm cell\b/); // the cell size
    expect(err.message).toMatch(/Z=5\b/); // the face
    expect(err.message).toMatch(/16\.0000 mm\^2/); // ...and how much it holds
    expect(err.message).toMatch(/1 column\b/);
    expect(err.message).toMatch(/3\.0000 mm across/); // the tool it cannot promise
    expect(err.message).toMatch(/1\.0607 mm/); // the cell size that would work
  });

  it('the refusal replaces the silent drop -- no ladder is planned over the face', () => {
    // The failure mode this closes: attempt 1 handed [2] back to planLevels and
    // the job ran, one millimetre short. There must be no value of the returned
    // pins that a caller could carry forward, so the call cannot return at all.
    const field = oneCellFace();
    expect(() =>
      findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA }),
    ).toThrow(/cannot resolve/i);
    // The RED this replaces, for the record: pins [2] -> planLevels [6, 2, 0].
    expect(planLevels(10, 0, 4, [2])).toEqual([6, 2, 0]);
  });

  it('a COARSE grid is not itself the offence: a resolvable face at 4 mm cells still pins', () => {
    // The refusal must be about material the grid cannot JUDGE, not about the
    // cell size on its own. Same 4 mm cells, same cutter, but a 16 x 16 mm face
    // spans 4 x 4 columns and closes quads, so it is resolvable and is pinned.
    const field = fieldWithPhysicalPlateaus({
      span: 40,
      cell: 4,
      base: 0,
      solidTo: 2,
      plateaus: [{ x0: 12, y0: 12, w: 16, h: 16, z: 5 }],
    });
    const cols = columnsAt(field, 5);
    const pins = findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });

    console.log(
      `WO-134 coarse but resolvable: 16 x 16 mm face at 4 mm cells is ${cols} columns; ` +
        `pins [${pins.join(', ')}] -- no refusal`,
    );

    expect(cols).toBe(16);
    expect(pins).toEqual([5, 2]);
  });

  it('the refusal does not fire while the grid can still see the tool', () => {
    // Every fixture in this file at or below RESOLVING_CELL runs to a verdict,
    // including the sloped and curved ones above. Stated as its own control so
    // a future widening of the refusal is caught here.
    for (const cell of FINE_CELLS) {
      const field = fieldWithPhysicalPlateaus({
        span: 40,
        cell,
        base: 0,
        solidTo: 2,
        plateaus: [{ x0: 16, y0: 16, w: 2, h: 2, z: 5 }], // sub-cutter, unresolvable
      });
      expect(cell).toBeLessThanOrEqual(RESOLVING_CELL);
      expect(() =>
        findCriticalDepths(field, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA }),
      ).not.toThrow();
    }
  });

  it('the refusal is keyed exactly at the resolving cell, and not a micron earlier', () => {
    // The threshold is a claim about geometry, so it is tested AS a threshold:
    // the same unresolvable sub-cutter fixture, once just inside the resolving
    // cell and once just outside it. Inside, the grid is guaranteed to see any
    // face the cutter fits on, so an unresolved bucket really is a curve and is
    // dropped in silence. Outside, it might be a face, so it is refused.
    // A face sampled by exactly 2 x 2 columns whichever side of the threshold
    // we are on, so the ONLY thing that changes across the boundary is the rule.
    // It closes a quad, so question 1 says "plane"; its represented area
    // (4 cells) is under the cutter's 7.0686 mm^2, so question 2 says "too
    // small" -- but its possible extent is 3 cells, which at these cell sizes
    // reaches the cutter's 3 mm. That is exactly an untrustworthy NO.
    const probe = (cell: number): ZDexelField =>
      fieldWithPhysicalPlateaus({
        span: 40,
        cell,
        base: 0,
        solidTo: 2,
        plateaus: [{ x0: 15.4 * cell, y0: 15.4 * cell, w: 1.2 * cell, h: 1.2 * cell, z: 5 }],
      });
    for (const cell of [RESOLVING_CELL * 0.999, RESOLVING_CELL * 1.001]) {
      expect(columnsAt(probe(cell), 5)).toBe(4);
      expect(4 * cell * cell).toBeLessThan(CUTTER_AREA); // question 2 says no...
      expect(3 * cell).toBeGreaterThanOrEqual(CUTTER.diameter); // ...untrustworthily
    }
    const run = (cell: number): void => {
      findCriticalDepths(probe(cell), { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
    };

    console.log(
      `WO-134 resolving cell for a ${CUTTER.diameter} mm cutter: ` +
        `${RESOLVING_CELL.toFixed(4)} mm (= diameter / (2*sqrt(2)))`,
    );
    expect(() => run(RESOLVING_CELL * 0.999)).not.toThrow();
    expect(() => run(RESOLVING_CELL * 1.001)).toThrow(/cannot resolve/i);
  });
});

// ---------------------------------------------------------------------------
// AND THE OPERATION ITSELF REFUSES -- not just the helper. The WO's wording is
// "the operation refuses with a named error", so the proof has to run through
// adaptiveRough on a real mesh.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE SAMPLING BAND -- the audit of the fix round, run through the REAL mesh
// sampler. Everything above builds heightfields by hand, which is exactly how
// the previous rounds missed this: a hand-built field cannot show you that
// buildPartHeightField samples cell CENTRES, so a face wider than the cutter
// can still arrive as one column.
// ---------------------------------------------------------------------------

describe('WO-134: centre sampling must not silently swallow a face the cutter fits on', () => {
  let kernel: BvhKernel;

  beforeAll(async () => {
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
    kernel = new BvhKernel();
  });

  /**
   * A pocket floor of `face` mm square at Z=8 in a 20 x 20 x 14 block, sampled
   * exactly as adaptiveRough samples it. `stockMin` shifts the stock box, and
   * therefore the GRID PHASE, without moving one atom of the part.
   */
  async function floorField(face: number, cell: number, stockMin: number): Promise<ZDexelField> {
    const mesh = pocketBox({ x: 20, y: 20, z: 14 }, { x: face, y: face, depth: 6 });
    const handle = kernel.uploadMesh(mesh);
    try {
      const stockBounds: Box3 = {
        minX: stockMin,
        minY: stockMin,
        minZ: 0,
        maxX: 20 - stockMin,
        maxY: 20 - stockMin,
        maxZ: 15,
      };
      const frame = frameOf(ZDexelField.fromBox(stockBounds, cell));
      return await buildPartHeightField(kernel, handle, frame, { zSeed: -1 });
    } finally {
      kernel.releaseMesh(handle);
    }
  }

  it('refuses a 3.1 mm round face sampled as two same-column points at 1.45 mm cells', async () => {
    const cell = 1.45;
    const span = 20 * cell;
    // x is exactly on one sampled column; y is halfway between two sample rows.
    const cx = 10.5 * cell;
    const cy = 10 * cell;
    const diameter = 3.1;
    const handle = kernel.uploadMesh(roundFaceOnFloor({ span, cx, cy, diameter }));
    try {
      const frame = frameOf(
        ZDexelField.fromBox(
          { minX: 0, minY: 0, minZ: 0, maxX: span, maxY: span, maxZ: 10 },
          cell,
        ),
      );
      const part = await buildPartHeightField(kernel, handle, frame, { zSeed: -1 });
      const samples: Array<{ i: number; j: number }> = [];
      for (let j = 0; j < part.ny; j++) {
        for (let i = 0; i < part.nx; i++) {
          const c = j * part.nx + i;
          if (part.top[c] > part.bottom[c] && Math.abs(part.top[c] - 5) < 1e-6) {
            samples.push({ i, j });
          }
        }
      }

      expect(diameter).toBeGreaterThan(CUTTER.diameter);
      expect(samples).toHaveLength(2);
      expect(new Set(samples.map((sample) => sample.i)).size).toBe(1);
      expect(Math.abs(samples[1].j - samples[0].j)).toBe(1);
      expect(2 * cell).toBe(2.9);
      expect(2 * cell).toBeLessThan(CUTTER.diameter);

      let thrown: unknown;
      try {
        findCriticalDepths(part, { stockTopZ: 10, floorZ: 0, minFlatArea: CUTTER_AREA });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      console.log(
        `WO-212 round face: diameter ${diameter} mm, cell ${cell} mm, ` +
          `${samples.length} same-column samples with old 2.9 mm axis envelope -> ` +
          `${err.name}: ${err.message}`,
      );
      expect(err.name).toBe(GRID_RESOLUTION_ERROR);
      expect(err.message).toMatch(/1\.45 mm cell/);
      expect(err.message).toMatch(/Z=5\b/);
      expect(err.message).toMatch(/2 columns/);
      expect(err.message).toMatch(/3\.2423 x 4\.3500 mm/);
    } finally {
      kernel.releaseMesh(handle);
    }
  });

  it("refuses the audit's 3.2 mm pocket floor instead of returning [14]", async () => {
    // THE RED, reproduced verbatim before it was fixed:
    //   Z=8 columns 1 (4 mm^2 vs the cutter's 7.0686 mm^2)
    //   findCriticalDepths         -> [14]
    //   planLevels(15, 0, 4, pins) -> [14, 10.5, 7, 3.5, 0]
    // Z=8 omitted; the Z=10.5 pass leaves 2.5 mm on the floor and the next pass
    // is below it, so the floor is masked and the remainder survives.
    const part = await floorField(3.2, 2, -5);
    let cols = 0;
    for (let c = 0; c < part.top.length; c++) {
      if (part.top[c] > part.bottom[c] && Math.abs(part.top[c] - 8) < 1e-6) cols++;
    }
    // The face is wider than the cutter in BOTH directions and still arrives as
    // one column whose represented area is BELOW the cutter's cross-section --
    // which is precisely why an area test could not save it.
    expect(3.2).toBeGreaterThan(CUTTER.diameter);
    expect(cols).toBe(1);
    expect(cols * part.cell * part.cell).toBeLessThan(CUTTER_AREA);

    let thrown: unknown;
    try {
      findCriticalDepths(part, { stockTopZ: 15, floorZ: 0, minFlatArea: CUTTER_AREA });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const err = thrown as Error;
    console.log(`WO-134 sampling band: ${err.name}: ${err.message}`);
    expect(err.name).toBe(GRID_RESOLUTION_ERROR);
    expect(err.message).toMatch(/\b2 mm cell\b/);
    expect(err.message).toMatch(/Z=8\b/);
    // The RED kept on the record as arithmetic about planLevels, never as an
    // expected result of the detector (that would encode the bug -- WO-053).
    expect(planLevels(15, 0, 4, [14])).toEqual([14, 10.5, 7, 3.5, 0]);
  });

  it('a 4 x 4 mm face cannot be decided by where the stock box starts', async () => {
    // The sharpest form of the defect. Same part, same cell size, same cutter;
    // only the stock ORIGIN moves, by half a cell. On one phase the floor lands
    // on 2 x 2 columns and pins; on the other it lands on ONE and, before this
    // round, was dropped in silence. A grid phase is not a property of the part
    // and may not decide whether commanded material is left standing.
    const aligned = await floorField(4, 2, -4);
    const shifted = await floorField(4, 2, -5);
    const count = (f: ZDexelField): number => {
      let n = 0;
      for (let c = 0; c < f.top.length; c++) {
        if (f.top[c] > f.bottom[c] && Math.abs(f.top[c] - 8) < 1e-6) n++;
      }
      return n;
    };
    expect(count(aligned)).toBe(4);
    expect(count(shifted)).toBe(1);

    const pins = findCriticalDepths(aligned, {
      stockTopZ: 15,
      floorZ: 0,
      minFlatArea: CUTTER_AREA,
    });
    let shiftedOutcome: string;
    try {
      const p = findCriticalDepths(shifted, {
        stockTopZ: 15,
        floorZ: 0,
        minFlatArea: CUTTER_AREA,
      });
      shiftedOutcome = `returned [${p.join(', ')}]`;
    } catch (e) {
      shiftedOutcome = `refused with ${(e as Error).name}`;
    }
    console.log(
      `WO-134 grid phase, same 4 x 4 mm floor at 2 mm cells: ` +
        `stock origin -4 -> 4 columns, pins [${pins.join(', ')}]; ` +
        `stock origin -5 -> 1 column, ${shiftedOutcome} (RED: returned [14])`,
    );

    // The aligned phase still HANDLES it -- the quad from attempt 1 is intact.
    expect(pins).toContain(8);
    // The unlucky phase must never quietly agree to a job it cannot see.
    expect(shiftedOutcome).toBe('refused with GridResolutionError');
  });

  it('adaptiveRough itself refuses the 3.2 mm floor at 2 mm cells', async () => {
    // The WO's wording is "the operation refuses", so the proof runs through the
    // strategy, not just the helper. This refuses at the ladder, before any
    // region is planned, so it is independent of the region-accounting failures
    // already red on main.
    const mesh = pocketBox({ x: 20, y: 20, z: 14 }, { x: 3.2, y: 3.2, depth: 6 });
    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: CUTTER,
        stockBounds: { minX: -5, minY: -5, minZ: 0, maxX: 25, maxY: 25, maxZ: 15 },
        cellSize: 2,
        maxStepdown: 4,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        materialTopZ: 15,
        heights: { clearanceZ: 20, retractZ: 16, feedZ: 16 },
      };
      let thrown: unknown;
      try {
        await adaptiveRough(kernel, input);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      console.log(`WO-134 adaptiveRough sampling-band refusal: ${err.name}: ${err.message}`);
      expect(err.name).toBe(GRID_RESOLUTION_ERROR);
      expect(err.message).toMatch(/Z=8\b/);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

describe('WO-134 audit fix: disconnected sub-tool features stay separate', () => {
  let kernel: BvhKernel;

  beforeAll(async () => {
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
    kernel = new BvhKernel();
  });

  it('does not invent one tool-sized face from two isolated samples', async () => {
    const handle = kernel.uploadMesh(disconnectedSubToolPosts());
    try {
      const frame = frameOf(
        ZDexelField.fromBox(
          { minX: 0, minY: 0, minZ: 0, maxX: 14, maxY: 14, maxZ: 6 },
          1.4,
        ),
      );
      const part = await buildPartHeightField(kernel, handle, frame, { zSeed: -1 });
      const z5Columns = columnsAt(part, 5);
      const pins = findCriticalDepths(part, {
        stockTopZ: 6,
        floorZ: 0,
        minFlatArea: CUTTER_AREA,
      });

      expect(z5Columns).toBe(2);
      expect(z5Columns * part.cell * part.cell).toBeLessThan(CUTTER_AREA);
      expect(pins).not.toContain(5);
    } finally {
      kernel.releaseMesh(handle);
    }
  });

  it('does not aggregate separated same-height components past the tool area', () => {
    const cell = 0.8;
    const componentArea = 4 * cell * cell;
    const field = fieldWithPhysicalPlateaus({
      span: 16,
      cell,
      base: 0,
      solidTo: 2,
      plateaus: [
        { x0: 0.8, y0: 0.8, w: 1.6, h: 1.6, z: 5 },
        { x0: 7.2, y0: 7.2, w: 1.6, h: 1.6, z: 5 },
        { x0: 13.6, y0: 13.6, w: 1.6, h: 1.6, z: 5 },
      ],
    });

    expect(columnsAt(field, 5)).toBe(12);
    expect(componentArea).toBeLessThan(CUTTER_AREA);
    expect(3 * componentArea).toBeGreaterThan(CUTTER_AREA);
    expect(findCriticalDepths(field, {
      stockTopZ: 10,
      floorZ: 0,
      minFlatArea: CUTTER_AREA,
    })).toEqual([2]);
  });

  it('does not join two sub-tool faces through diagonal sample contact alone', () => {
    const cell = 1;
    const componentArea = 4 * cell * cell;
    const field = fieldWithPhysicalPlateaus({
      span: 8,
      cell,
      base: 0,
      solidTo: 2,
      plateaus: [
        { x0: 1, y0: 1, w: 2, h: 2, z: 5 },
        { x0: 3, y0: 3, w: 2, h: 2, z: 5 },
      ],
    });

    expect(columnsAt(field, 5)).toBe(8);
    expect(componentArea).toBeLessThan(CUTTER_AREA);
    expect(2 * componentArea).toBeGreaterThan(CUTTER_AREA);
    expect(findCriticalDepths(field, {
      stockTopZ: 10,
      floorZ: 0,
      minFlatArea: CUTTER_AREA,
    })).toEqual([2]);
  });
});

describe('WO-221: a near-floor face is not the commanded floor', () => {
  it('pins a 4 x 4 mm face at Z0.0005 and leaves zero remainder under the production mask', () => {
    const faceZ = 0.0005;
    const field = fieldWithPhysicalPlateaus({
      span: 8,
      cell: 1,
      base: -1,
      solidTo: 0,
      plateaus: [{ x0: 2, y0: 2, w: 4, h: 4, z: faceZ }],
    });
    const naturalLevels = planLevels(10, 0, 4);

    const remainder = (levels: readonly number[]): number => {
      let stockTop = 10;
      for (const z of levels) {
        // This fixture has only the commanded face. An empty production mask
        // means the level may clear every face column to exactly z.
        if (remainingAbove(field, z).length === 0) stockTop = Math.min(stockTop, z);
      }
      return stockTop - field.top.find((top) => top > 0)!;
    };

    expect(columnsAt(field, faceZ)).toBe(16);
    expect(remainingAbove(field, 0)).not.toHaveLength(0);
    expect(remainder(naturalLevels)).toBeCloseTo(3.3328, 4);

    const pins = findCriticalDepths(field, {
      stockTopZ: 10,
      floorZ: 0,
      minFlatArea: CUTTER_AREA,
    });
    expect(pins).toHaveLength(1);
    expect(pins[0]).toBeCloseTo(faceZ, 8);

    const levels = planLevels(10, 0, 4, pins);
    expect(levels).toContain(pins[0]);
    expect(remainingAbove(field, pins[0])).toHaveLength(0);
    expect(remainder(levels)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('WO-134: adaptiveRough refuses the job rather than under-cutting it', () => {
  let kernel: BvhKernel;

  beforeAll(async () => {
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
    kernel = new BvhKernel();
  });

  it('rejects with GridResolutionError, naming the cell size and the face', async () => {
    // A 4 x 4 mm pocket floor at Z=8 in a 20 x 20 x 14 block, 4 mm of stock
    // border, 4 mm cells: the pocket floor lands on exactly one column. The 3 mm
    // cutter fits on that face in both directions, so the job must not quietly
    // finish 1 mm above it.
    const mesh = pocketBox({ x: 20, y: 20, z: 14 }, { x: 4, y: 4, depth: 6 });
    const stockBounds: Box3 = { minX: -4, minY: -4, minZ: 0, maxX: 24, maxY: 24, maxZ: 15 };
    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: CUTTER,
        stockBounds,
        cellSize: 4,
        maxStepdown: 4,
        stepover: 0.4,
        tolerance: 0.1,
        helixDiameter: 2,
        materialTopZ: 15,
        heights: { clearanceZ: 20, retractZ: 16, feedZ: 16 },
      };
      let thrown: unknown;
      try {
        await adaptiveRough(kernel, input);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      console.log(`WO-134 adaptiveRough refusal: ${err.name}: ${err.message}`);
      expect(err.name).toBe(GRID_RESOLUTION_ERROR);
      expect(err.message).toMatch(/\b4 mm cell\b/);
      expect(err.message).toMatch(/Z=8\b/);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});
