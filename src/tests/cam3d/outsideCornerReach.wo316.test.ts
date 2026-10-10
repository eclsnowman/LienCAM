// WO-316: an outside corner must not leave a spire.
//
// Operator's authority (queue/WO-316-an-outside-corner-must-not-leave-a-spire.md):
// cleaning stock away from around a part, the cutter can swing past the stock
// edge and sweep an OUTSIDE corner out -- nothing physical stops it, only our
// own boundary does, and leaving a post there is a defect. An INSIDE corner
// (a pocket narrower than the cutter) is different: the tool genuinely cannot
// fit, and that boundary against the model must not move by one micron. The
// inflation that clears an outside corner must also be BOUNDED -- no air
// cutting past what the tool could ever reach.
//
// The mechanism already exists end to end (Stage C-2, `reachStockEdgeBy`):
// cutRegionAt (src/cam3d/rough/cutRegion.ts, read-only to this WO) dilates the
// STOCK section outward before the stock/part difference; the engine
// (src/lib/cam/adaptiveClearing2d, read-only, reached only through this WO's
// owned src/cam3d/rough/engineEntry.ts bridge) then insets the WHOLE region
// back by toolRadius. At reach == toolRadius that round trip returns the
// outer boundary EXACTLY to the true stock edge (corner posts removed); the
// PART/pocket boundary side of the region is never dilated, so it is
// untouched regardless of reach. What this WO adds, in its owned
// src/cam3d/strategies/adaptiveRough.ts, is the missing bound: reach is now
// clamped to toolRadius at the strategy boundary, so no caller (a mis-set
// override, a future UI field) can push travel past the corner apex into air
// the tool could never need to cut -- see the "bound" test below.
//
// FIXTURE-VISIBILITY FINDING (WO-316 "stop and say so"): neither this test
// nor the strategy it drives has any visibility into fixtures/clamps.
// `AdaptiveRoughInput` carries no fixture field, and the only fixture model in
// this codebase (`FixtureStackItem`, src/lib/cam/types.ts) records vertical
// layer HEIGHT for Z-origin resolution only -- it has no XY footprint.
// `holderClearanceGate.ts` checks the tool holder/shank against the stock
// BLOCK for Z clearance, not a clamp's XY position. So "so long as there are
// no collisions with clamps and other parts" cannot be verified at this, or
// any, layer of the current codebase; this test proves the geometry is
// correctly BOUNDED (never travels past the true stock edge), which is the
// part provable here.

import { describe, it, expect, beforeAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ZDexelField,
  removeSweep,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import { hemisphereOnSlab, engagementPocket, ENGAGEMENT_POCKET_BLOCK } from '../../cam3d/fixtures';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { irFingerprint } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

/** Replay every IR move as a tool-tip removeSweep onto a fresh stock box. */
function replayToField(
  moves: ReadonlyArray<{ x: number; y: number; z: number }>,
  bounds: Box3,
  cell: number,
  cut: CutterSpec,
): ZDexelField {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of moves) {
    if (prev !== null) {
      const sweep: LinearMove = { x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z };
      removeSweep(field, sweep, cut);
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return field;
}

/** Material top at world (x,y) via the field's column grid; +Inf outside the grid. */
function topAt(field: ZDexelField, x: number, y: number): number {
  const i = Math.floor((x - field.originX) / field.cell);
  const j = Math.floor((y - field.originY) / field.cell);
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return Infinity;
  return field.top[j * field.nx + i];
}

// === Evidence: minimal PNG writer + plan-view render (WO-134 pattern) ======
// No browser involved (this is pure cam3d compute); a small self-contained
// 8-bit RGB PNG encoder, same as the WO-134 evidence shooter.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 3);
    raw[o] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Plan-view (X-Y, looking down +Z) render of a field at representative depth
 * `zRep`: dark grey = material still standing above zRep (a spire); light =
 * cleared to zRep or below. A red ring marks the part's plan-view silhouette
 * at zRep for reference so the corners can be judged against it by eye.
 */
function renderPlanView(
  field: ZDexelField,
  zRep: number,
  partCenter: { x: number; y: number },
  partRadiusAtZ: number,
  pxPerMm: number,
): { png: Buffer; width: number; height: number } {
  const w = field.nx;
  const h = field.ny;
  const rgb = new Uint8Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 3;
      const cleared = field.top[j * w + i] <= zRep + field.cell;
      if (cleared) {
        rgb[o] = 235; rgb[o + 1] = 236; rgb[o + 2] = 240; // cleared: light
      } else {
        rgb[o] = 120; rgb[o + 1] = 96; rgb[o + 2] = 40; // standing material: brass/dark
      }
      // Part silhouette ring at zRep, drawn thin over either colour.
      const cx = field.centerX(i);
      const cy = field.centerY(j);
      const d = Math.hypot(cx - partCenter.x, cy - partCenter.y);
      if (Math.abs(d - partRadiusAtZ) < field.cell * 0.75) {
        rgb[o] = 210; rgb[o + 1] = 40; rgb[o + 2] = 40; // red
      }
    }
  }
  // Nearest-neighbour upscale for a legible image (fields are XY-mirrored to
  // screen convention: image row 0 = max Y, matching a top-down "north up" view).
  const outW = w * pxPerMm;
  const outH = h * pxPerMm;
  const out = new Uint8Array(outW * outH * 3);
  for (let oy = 0; oy < outH; oy++) {
    const j = h - 1 - Math.floor(oy / pxPerMm);
    for (let ox = 0; ox < outW; ox++) {
      const i = Math.floor(ox / pxPerMm);
      const s = (j * w + i) * 3;
      const d = (oy * outW + ox) * 3;
      out[d] = rgb[s]; out[d + 1] = rgb[s + 1]; out[d + 2] = rgb[s + 2];
    }
  }
  return { png: encodePng(outW, outH, out), width: outW, height: outH };
}

// === Fixture A: a round part in a square stock (the reported geometry) =====
// A hemispherical dome on a slab -- circular in plan, the "round part" Operator
// described -- centred in a square stock block. Isolated, wide-open corners
// far from the part so the post/clear measurement is unambiguous.

const DOME_R = 6;
const SLAB = { x: 20, y: 20, t: 10 } as const;
const A_CX = SLAB.x / 2; // 10
const A_CY = SLAB.y / 2; // 10
const A_STOCK_TOP = SLAB.t + DOME_R; // 16
const A_STOCK_HALF = 25; // 50 x 50 square stock, corners well clear of the part
const A_BOUNDS: Box3 = {
  minX: A_CX - A_STOCK_HALF,
  minY: A_CY - A_STOCK_HALF,
  minZ: 0,
  maxX: A_CX + A_STOCK_HALF,
  maxY: A_CY + A_STOCK_HALF,
  maxZ: A_STOCK_TOP,
};
const A_CELL = 0.5;
const A_CUTTER: CutterSpec = { kind: 'flat', diameter: 6 };
const A_TOOL_R = A_CUTTER.diameter / 2; // 3
const A_Z_REP = 13; // between the slab top (10) and the dome apex (16)

function mkDomeMesh(): PartMesh {
  return hemisphereOnSlab(DOME_R, SLAB);
}

function inputFor(handle: MeshHandle, reach: number): AdaptiveRoughInput {
  return {
    mesh: handle,
    cutter: A_CUTTER,
    stockBounds: A_BOUNDS,
    cellSize: A_CELL,
    maxStepdown: 4,
    stepover: 0.5,
    tolerance: 0.1,
    helixDiameter: 3,
    heights: { clearanceZ: A_STOCK_TOP + 10, retractZ: A_STOCK_TOP + 2, feedZ: A_STOCK_TOP + 2 },
    materialTopZ: A_STOCK_TOP,
    reachStockEdgeBy: reach,
  };
}

/**
 * Corner-post depth (mm): walk INWARD from a stock corner apex along the
 * 45-deg diagonal; return the distance at which material first clears to the
 * representative plane. ~0 when the corner is fully cleared; this is a direct
 * FIELD measurement (WO-316: "assert on the actual cleared area or the
 * resulting field, not on a region count"), not a diagnostics region count.
 */
function cornerPostDepth(field: ZDexelField): number {
  const cleared = (x: number, y: number) => topAt(field, x, y) <= A_Z_REP + A_CELL;
  const corners = [
    { ax: A_BOUNDS.minX, ay: A_BOUNDS.minY, dx: 1, dy: 1 },
    { ax: A_BOUNDS.maxX, ay: A_BOUNDS.minY, dx: -1, dy: 1 },
    { ax: A_BOUNDS.minX, ay: A_BOUNDS.maxY, dx: 1, dy: -1 },
    { ax: A_BOUNDS.maxX, ay: A_BOUNDS.maxY, dx: -1, dy: -1 },
  ];
  const inset = A_CELL * 0.5;
  const invSqrt2 = 1 / Math.SQRT2;
  const step = A_CELL * 0.5;
  const maxWalk = 4 * A_TOOL_R;
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

describe('WO-316: outside stock corners clear; the reach is bounded', () => {
  it(
    'reach=0 leaves posts; reach=toolRadius clears them (field-based); an oversized request clamps to the SAME result',
    { timeout: 300000 },
    async () => {
      const mesh = mkDomeMesh();
      const expectedPostDepth = A_TOOL_R * (Math.SQRT2 - 1); // ~1.24 mm, analytic

      const handle = kernel.uploadMesh(mesh);
      let depthNoReach: number;
      let depthFullReach: number;
      let depthOverReach: number;
      let fpOverReach: string;
      let movesFullReach: number;
      let movesOverReach: number;
      let depthClampReach: number;
      let fpClampReach: string;
      let movesClampReach: number;
      try {
        // --- reach = 0: the pre-existing defect -- posts remain -----------
        const irNone = await adaptiveRough(kernel, inputFor(handle, 0));
        const fieldNoReach = replayToField(irNone.moves, A_BOUNDS, A_CELL, A_CUTTER);
        depthNoReach = cornerPostDepth(fieldNoReach);

        // --- reach = toolRadius: the fix -- corners clear ------------------
        const irFull = await adaptiveRough(kernel, inputFor(handle, A_TOOL_R));
        const fieldFullReach = replayToField(irFull.moves, A_BOUNDS, A_CELL, A_CUTTER);
        depthFullReach = cornerPostDepth(fieldFullReach);
        movesFullReach = irFull.moves.length;
        expect(irFull.meta.params?.reachStockEdgeBy).toBe(A_TOOL_R);

        // --- evidence: before/after plan-view capture, Operator judges by looking.
        // WO-1093 rule (applied by WO-1280): written ONLY under WRITE_EVIDENCE=1; the
        // measurements above and the assertions below run regardless.
        if (process.env.WRITE_EVIDENCE === '1') {
          const evidenceDir = resolve(process.cwd(), 'src/tests/evidence/WO-316');
          mkdirSync(evidenceDir, { recursive: true });
          const partRadiusAtZRep = Math.sqrt(Math.max(0, DOME_R * DOME_R - (A_Z_REP - SLAB.t) ** 2));
          const beforeShot = renderPlanView(
            fieldNoReach, A_Z_REP, { x: A_CX, y: A_CY }, partRadiusAtZRep, 6,
          );
          const afterShot = renderPlanView(
            fieldFullReach, A_Z_REP, { x: A_CX, y: A_CY }, partRadiusAtZRep, 6,
          );
          const beforePath = resolve(evidenceDir, 'corners-before-reach0.png');
          const afterPath = resolve(evidenceDir, 'corners-after-reachToolRadius.png');
          const notesPath = resolve(evidenceDir, 'corners-notes.json');
          // DELETE FIRST: a stale artifact must never be mistaken for a fresh shot.
          for (const p of [beforePath, afterPath, notesPath]) rmSync(p, { force: true });
          writeFileSync(beforePath, beforeShot.png);
          writeFileSync(afterPath, afterShot.png);
          writeFileSync(
            notesPath,
            `${JSON.stringify(
              {
                wo: 'WO-316',
                view: `plan (top-down), z=${A_Z_REP} mm representative level`,
                legend: 'brass = material still standing (a spire); light = cleared to z; red ring = part silhouette at z',
                before: { file: 'corners-before-reach0.png', reachStockEdgeBy: 0, cornerPostDepthMm: Number(depthNoReach.toFixed(4)) },
                after: { file: 'corners-after-reachToolRadius.png', reachStockEdgeBy: A_TOOL_R, cornerPostDepthMm: Number(depthFullReach.toFixed(4)) },
                fixture: { stock: A_BOUNDS, cutterDiameterMm: A_CUTTER.diameter, domeRadiusMm: DOME_R, slab: SLAB },
              },
              null,
              2,
            )}\n`,
          );
          expect(statSync(beforePath).size).toBeGreaterThan(0);
          expect(statSync(afterPath).size).toBeGreaterThan(0);
          expect(existsSync(notesPath)).toBe(true);
        }

        // --- reach requested WAY beyond the clamp: must clamp, not overshoot.
        // "It shouldn't inflate everywhere so it's air cutting beyond the
        // boundaries that it could reach" (Operator's authority). The clamp is
        // 2 x toolRadius since the side-entry work (Stage C-3 / WO-402b): the
        // engine insets the region by R, so 2R is what lets a fully clear
        // cutter start R outside the real stock and feed inward, and it is
        // what the store's AUTO overshoot sends. A caller asking for 5x
        // toolRadius must land EXACTLY where a 2 x toolRadius request does.
        const irClamp = await adaptiveRough(kernel, inputFor(handle, A_TOOL_R * 2));
        depthClampReach = cornerPostDepth(replayToField(irClamp.moves, A_BOUNDS, A_CELL, A_CUTTER));
        fpClampReach = irFingerprint(irClamp);
        movesClampReach = irClamp.moves.length;
        expect(irClamp.meta.params?.reachStockEdgeBy).toBe(A_TOOL_R * 2);
        const irOver = await adaptiveRough(kernel, inputFor(handle, A_TOOL_R * 5));
        depthOverReach = cornerPostDepth(replayToField(irOver.moves, A_BOUNDS, A_CELL, A_CUTTER));
        fpOverReach = irFingerprint(irOver);
        movesOverReach = irOver.moves.length;
        expect(irOver.meta.params?.reachStockEdgeBy).toBe(A_TOOL_R * 2);
      } finally {
        kernel.releaseMesh(handle);
      }

      console.log(
        `WO-316 corner post depth @z=${A_Z_REP}: reach=0 -> ${depthNoReach.toFixed(3)} mm ` +
          `(expected ~${expectedPostDepth.toFixed(3)} mm); reach=toolRadius -> ` +
          `${depthFullReach.toFixed(3)} mm; reach=2x toolRadius -> ${depthClampReach.toFixed(3)} mm; ` +
          `reach=5x toolRadius -> ${depthOverReach.toFixed(3)} mm ` +
          `(clamped, must equal the 2x toolRadius result); movesFullReach=${movesFullReach} ` +
          `movesClampReach=${movesClampReach} movesOverReach=${movesOverReach}`,
      );

      // Today's defect, proven on the actual field: a real post stands, close
      // to the analytic r(sqrt2-1) prediction (discretization band).
      expect(depthNoReach).toBeGreaterThanOrEqual(expectedPostDepth - 2 * A_CELL);
      expect(depthNoReach).toBeLessThanOrEqual(expectedPostDepth + 2 * A_CELL);

      // The fix, proven on the actual field: the stock corners clear.
      expect(depthFullReach).toBeLessThanOrEqual(2 * A_CELL);
      expect(depthFullReach).toBeLessThan(depthNoReach - A_CELL);

      // The bound: an over-large request produces the IDENTICAL result to an
      // exact 2 x toolRadius request -- proof the clamp, not the caller's
      // number, decides how far the tool travels; and the clamped reach still
      // clears the corners.
      expect(fpOverReach).toBe(fpClampReach);
      expect(movesOverReach).toBe(movesClampReach);
      expect(depthOverReach).toBe(depthClampReach);
      expect(depthClampReach).toBeLessThanOrEqual(2 * A_CELL);
    },
  );
});

// === Fixture B: an inside pocket corner narrower than the cutter ===========
// engagementPocket: a 90 x 60 x 16 block with a 6 mm-wide neck joining two
// wide (30 x 40) chambers. A flat cutter wider than 6 mm genuinely cannot
// enter the neck -- an INSIDE boundary the strategy must never move, no
// matter what reachStockEdgeBy is asked to do (reach only ever dilates the
// STOCK section in cutRegionAt; the PART section -- what forms this neck's
// walls -- is never touched).

const B_CUTTER: CutterSpec = { kind: 'flat', diameter: 8 }; // radius 4: neck (6mm) doesn't fit
const B_BOUNDS: Box3 = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: ENGAGEMENT_POCKET_BLOCK.x,
  maxY: ENGAGEMENT_POCKET_BLOCK.y,
  maxZ: ENGAGEMENT_POCKET_BLOCK.z,
};
const B_CELL = 1;
// Neck centre (derived from ENGAGEMENT_POCKET_BOUNDARIES.outer: x in [40,50], y in [27,33]).
const B_NECK_PT = { x: 45, y: 30 };
// Open right-chamber interior (no island there): must machine normally either way.
const B_OPEN_PT = { x: 70, y: 30 };

function inputForPocket(handle: MeshHandle, reach: number): AdaptiveRoughInput {
  return {
    mesh: handle,
    cutter: B_CUTTER,
    stockBounds: B_BOUNDS,
    cellSize: B_CELL,
    maxStepdown: 4,
    stepover: 0.5,
    tolerance: 0.1,
    helixDiameter: 3,
    heights: { clearanceZ: B_BOUNDS.maxZ + 10, retractZ: B_BOUNDS.maxZ + 2, feedZ: B_BOUNDS.maxZ + 2 },
    materialTopZ: B_BOUNDS.maxZ,
    reachStockEdgeBy: reach,
  };
}

describe('WO-316: an inside pocket corner narrower than the cutter is unchanged by reach', () => {
  it(
    'the neck stays uncut (boundary unmoved) whether reach is 0 or clamped to toolRadius',
    { timeout: 120000 },
    async () => {
      const mesh = engagementPocket();
      const handle = kernel.uploadMesh(mesh);
      let neckTopReachZero: number;
      let neckTopReachClamped: number;
      let openTopReachZero: number;
      let openTopReachClamped: number;
      try {
        const irZero = await adaptiveRough(kernel, inputForPocket(handle, 0));
        const fieldZero = replayToField(irZero.moves, B_BOUNDS, B_CELL, B_CUTTER);
        neckTopReachZero = topAt(fieldZero, B_NECK_PT.x, B_NECK_PT.y);
        openTopReachZero = topAt(fieldZero, B_OPEN_PT.x, B_OPEN_PT.y);

        // Deliberately over-request reach (clamped internally to toolRadius=4 by
        // this WO's fix) so the inside boundary is checked against the SAME
        // aggressive input the outside-corner bound test above uses.
        const irClamped = await adaptiveRough(kernel, inputForPocket(handle, B_CUTTER.diameter * 5));
        const fieldClamped = replayToField(irClamped.moves, B_BOUNDS, B_CELL, B_CUTTER);
        neckTopReachClamped = topAt(fieldClamped, B_NECK_PT.x, B_NECK_PT.y);
        openTopReachClamped = topAt(fieldClamped, B_OPEN_PT.x, B_OPEN_PT.y);
      } finally {
        kernel.releaseMesh(handle);
      }

      console.log(
        `WO-316 inside-corner check: neck top reach=0 -> ${neckTopReachZero.toFixed(3)} mm, ` +
          `reach=huge(clamped) -> ${neckTopReachClamped.toFixed(3)} mm (block top ` +
          `${B_BOUNDS.maxZ} = untouched); open chamber top reach=0 -> ` +
          `${openTopReachZero.toFixed(3)} mm, reach=huge -> ${openTopReachClamped.toFixed(3)} mm ` +
          `(pocket floor = machined)`,
      );

      // The neck is a sub-tool-width INSIDE feature: still not machined, and its
      // boundary reads IDENTICALLY regardless of reach -- proof reach never
      // touches the part/pocket side of the region.
      expect(neckTopReachZero).toBeGreaterThanOrEqual(B_BOUNDS.maxZ - B_CELL);
      expect(neckTopReachClamped).toBe(neckTopReachZero);

      // Sanity: the wide-open chamber machined normally in both runs (this
      // fixture is not degenerate -- it actually cuts material elsewhere).
      expect(openTopReachZero).toBeLessThan(B_BOUNDS.maxZ - 4);
      expect(openTopReachClamped).toBe(openTopReachZero);
    },
  );
});
