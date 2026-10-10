// Gate C-2 -- CORNER-REACH knob for the adaptive_3d 3D rougher full-clear.
//
// Stage C-1 sized the carve field to the real stock footprint, so the border
// clears out toward the stock walls -- but a round tool inset by its radius
// CANNOT reach into a convex 90-deg stock corner, so a small leftover POST
// remains at each corner (depth ~ toolRadius*(sqrt2-1) along the diagonal).
//
// Stage C-2 adds `reachStockEdgeBy` (plumbed from params.stockEdgeOvershoot,
// default AUTO = tool radius): cutRegionAt dilates the STOCK section OUTWARD by
// that amount before the stock/part difference. The engine then insets the whole
// region back by toolRadius, so at reach = toolRadius the outer boundary returns
// to the true stock edge and the tool CENTRE reaches the corner apex -- the posts
// go away. removeSweep clamps the out-of-bounds tool motion gracefully.
//
// This gate drives the strategy directly (like C-1), toggling reachStockEdgeBy:
//   - reach = 0            -> corner posts remain (~ toolRadius*(sqrt2-1) deep).
//   - reach = toolRadius   -> posts removed (leftover ~0, <= a cell); part not
//                             gouged; two runs byte-identical (D-006).
//
// Fixture: a SMALL central dome-on-slab part (20 x 20 footprint) centred in a
// 50 x 50 rectangular stock -- four wide-open corners far from the part. (Was
// 100 x 100 until WO-408: the corner posts are a local feature of the stock
// corner, so the open border width is not part of the question; the cell /
// cutter ratio is kept, the footprint is what was shrunk.)

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ZDexelField,
  removeSweep,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec, MeshHandle } from '../../cam3d/kernel/types';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import { buildPartHeightField, frameOf } from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { irFingerprint, type ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

// --- Fixture geometry --------------------------------------------------------
// Dome (r=6) on a 20 x 20 x 10 slab centred at (10,10); part AABB x[0,20]
// y[0,20] z[0,16]. Stock is a 50 x 50 block CENTRED on the part, top at the
// part top: x[-15,35] y[-15,35] z[0,16]. The four stock corners sit 15 mm (5
// tool radii) from the part AABB -- clean, isolated leftover posts.
const DOME_R = 6;
const SLAB = { x: 20, y: 20, t: 10 } as const;
const PART_CX = SLAB.x / 2; // 10
const PART_CY = SLAB.y / 2; // 10
const STOCK_TOP = SLAB.t + DOME_R; // 16
const STOCK_HALF = 25; // 50 x 50 stock (WO-408: was 100 x 100)
const STOCK_BOUNDS: Box3 = {
  minX: PART_CX - STOCK_HALF,
  minY: PART_CY - STOCK_HALF,
  minZ: 0,
  maxX: PART_CX + STOCK_HALF,
  maxY: PART_CY + STOCK_HALF,
  maxZ: STOCK_TOP,
};

const CELL = 0.5;
const cutter: CutterSpec = { kind: 'flat', diameter: 6 };
const TOOL_R = cutter.diameter / 2; // 3
// Representative level between the slab top (10) and the dome apex (16).
const Z_REP = 13;

function mkMesh(): PartMesh {
  return hemisphereOnSlab(DOME_R, { x: SLAB.x, y: SLAB.y, t: SLAB.t });
}

const inputFor = (handle: MeshHandle, reach: number): AdaptiveRoughInput => ({
  mesh: handle,
  cutter,
  stockBounds: STOCK_BOUNDS,
  cellSize: CELL,
  maxStepdown: 4,
  stepover: 0.5,
  tolerance: 0.1,
  helixDiameter: 3,
  heights: { clearanceZ: STOCK_TOP + 10, retractZ: STOCK_TOP + 2, feedZ: STOCK_TOP + 2 },
  materialTopZ: STOCK_TOP,
  reachStockEdgeBy: reach,
});

async function partFieldFor(handle: MeshHandle, stock: ZDexelField, zSeed: number): Promise<ZDexelField> {
  return buildPartHeightField(kernel, handle, frameOf(stock), { zSeed });
}

/** Replay every IR move as a tool-tip removeSweep onto a fresh stock box.
 *  Arc moves are walked along the ARC (chords with sagitta <= cell / 4): the
 *  published IR is arc-fitted, and a single chord across the corner arc the
 *  planner rides around the slab (radius R + finish stock) has a 0.4 mm
 *  sagitta - it carved the slab corner column here and read as a 10 mm
 *  "gouge" the machine never makes (WO-402c). */
function replayToField(ir: ToolpathIR, bounds: Box3, cell: number, cut: CutterSpec): ZDexelField {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  const sweepTo = (from: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
    const sweep: LinearMove = { x0: from.x, y0: from.y, z0: from.z, x1: x, y1: y, z1: z };
    removeSweep(field, sweep, cut);
  };
  for (const m of ir.moves) {
    if (prev !== null) {
      if (m.t === 'arc' && m.i !== undefined && m.j !== undefined) {
        const cx = prev.x + m.i, cy = prev.y + m.j;
        const r = Math.hypot(prev.x - cx, prev.y - cy);
        const a0 = Math.atan2(prev.y - cy, prev.x - cx);
        let sweepAng = Math.atan2(m.y - cy, m.x - cx) - a0;
        if (m.cw) { while (sweepAng >= 0) sweepAng -= 2 * Math.PI; } else { while (sweepAng <= 0) sweepAng += 2 * Math.PI; }
        const maxChord = 2 * Math.sqrt(Math.max(2 * r * (cell / 4) - (cell / 4) ** 2, 1e-9));
        const steps = Math.max(1, Math.ceil(Math.abs(sweepAng) * r / maxChord));
        let from = prev;
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const x = k === steps ? m.x : cx + r * Math.cos(a0 + sweepAng * t);
          const y = k === steps ? m.y : cy + r * Math.sin(a0 + sweepAng * t);
          const z = prev.z + (m.z - prev.z) * t;
          sweepTo(from, x, y, z);
          from = { x, y, z };
        }
      } else {
        sweepTo(prev, m.x, m.y, m.z);
      }
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return field;
}

/** Material top at world (x,y) via the field's column grid; +Inf outside. */
function topAt(field: ZDexelField, x: number, y: number): number {
  const i = Math.floor((x - field.originX) / field.cell);
  const j = Math.floor((y - field.originY) / field.cell);
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return Infinity;
  return field.top[j * field.nx + i];
}

/**
 * Corner-post depth (mm): walk INWARD from a stock corner apex along the 45-deg
 * diagonal; return the Euclidean distance at which material first drops to the
 * representative plane (the depth of the uncleared leftover triangle). ~0 when
 * the corner is fully cleared. Robust to thin edge strips because it samples only
 * the diagonal, where the round-tool leftover is deepest.
 */
function cornerPostDepth(field: ZDexelField): number {
  const cleared = (x: number, y: number) => topAt(field, x, y) <= Z_REP + CELL;
  const corners = [
    { ax: STOCK_BOUNDS.minX, ay: STOCK_BOUNDS.minY, dx: 1, dy: 1 },
    { ax: STOCK_BOUNDS.maxX, ay: STOCK_BOUNDS.minY, dx: -1, dy: 1 },
    { ax: STOCK_BOUNDS.minX, ay: STOCK_BOUNDS.maxY, dx: 1, dy: -1 },
    { ax: STOCK_BOUNDS.maxX, ay: STOCK_BOUNDS.maxY, dx: -1, dy: -1 },
  ];
  const inset = CELL * 0.5; // start just inside the boundary (apex column centre)
  const invSqrt2 = 1 / Math.SQRT2;
  const step = CELL * 0.5;
  const maxWalk = 4 * TOOL_R; // well past any expected post
  let worst = 0;
  for (const c of corners) {
    let depth = 0;
    for (let s = 0; s <= maxWalk; s += step) {
      const px = c.ax + c.dx * (inset + s * invSqrt2);
      const py = c.ay + c.dy * (inset + s * invSqrt2);
      if (cleared(px, py)) {
        depth = s;
        break;
      }
    }
    if (depth > worst) worst = depth;
  }
  return worst;
}

// ---------------------------------------------------------------------------
describe('Gate C-2: corner-reach knob clears the leftover stock-corner posts', () => {
  it('reach=toolRadius removes the posts; reach=0 leaves ~r(sqrt2-1); no gouge; deterministic (D-006)', { timeout: 300000 }, async () => {
    const mesh = mkMesh();

    // --- reach = 0: posts remain ---
    let depth0: number;
    {
      const handle = kernel.uploadMesh(mesh);
      try {
        const ir = await adaptiveRough(kernel, inputFor(handle, 0));
        const fin = replayToField(ir, STOCK_BOUNDS, CELL, cutter);
        depth0 = cornerPostDepth(fin);
      } finally {
        kernel.releaseMesh(handle);
      }
    }

    // --- reach = toolRadius: posts removed + determinism + no-gouge ---
    let depthFull: number;
    let maxGouge = -Infinity;
    let fpA: string;
    let fpB: string;
    let movesA: number;
    let movesB: number;
    {
      const handle = kernel.uploadMesh(mesh);
      try {
        const irA = await adaptiveRough(kernel, inputFor(handle, TOOL_R));
        const irB = await adaptiveRough(kernel, inputFor(handle, TOOL_R));
        fpA = irFingerprint(irA);
        fpB = irFingerprint(irB);
        movesA = irA.moves.length;
        movesB = irB.moves.length;

        const fin = replayToField(irA, STOCK_BOUNDS, CELL, cutter);
        depthFull = cornerPostDepth(fin);

        // No-gouge: over EVERY column that has part, the carved top must not sit
        // below the part top by more than a discretization margin.
        const outStock = ZDexelField.fromBox(STOCK_BOUNDS, CELL);
        const part = await partFieldFor(handle, outStock, STOCK_BOUNDS.minZ - 1);
        for (let c = 0; c < fin.top.length; c++) {
          const hasPart = part.top[c] > part.bottom[c];
          if (!hasPart) continue;
          const g = part.top[c] - fin.top[c];
          if (g > maxGouge) maxGouge = g;
        }
      } finally {
        kernel.releaseMesh(handle);
      }
    }

    const expPost0 = TOOL_R * (Math.SQRT2 - 1); // ~1.243 mm

    // eslint-disable-next-line no-console
    console.log(
      `C-2 corner post depth @z=${Z_REP}: reach=0 ${depth0.toFixed(3)} mm ` +
        `(exp ~${expPost0.toFixed(3)}), reach=toolRadius ${depthFull.toFixed(3)} mm; ` +
        `maxGouge ${maxGouge.toFixed(4)} mm; movesA ${movesA} fp ${fpA}`,
    );

    // reach=0 leaves a real post near the analytic r(sqrt2-1) (discretization band).
    expect(depth0).toBeGreaterThanOrEqual(expPost0 - 2 * CELL);
    expect(depth0).toBeLessThanOrEqual(expPost0 + 2 * CELL);
    // reach=toolRadius clears the corner: leftover within a cell or so of zero.
    expect(depthFull).toBeLessThanOrEqual(2 * CELL);
    // The knob demonstrably removes the posts.
    expect(depthFull).toBeLessThan(depth0 - CELL);
    // Part preserved: no gouge into the dome (discretization only).
    expect(maxGouge).toBeLessThanOrEqual(0.6);
    // Determinism (D-006): two reach=toolRadius generates are byte-identical.
    expect(fpB).toBe(fpA);
    expect(movesB).toBe(movesA);
  });
});
