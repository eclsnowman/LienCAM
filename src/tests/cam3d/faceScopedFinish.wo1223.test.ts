// WO-1223: a finishing pass can be aimed at chosen faces.
//
// The promise this file exists to hold: a face-scoped finish cuts ZERO length
// outside the faces it was aimed at, and an unscoped one still cuts the whole
// part. Both are MEASURED here, on the same fixture, with the same tool, off
// the moves the production adapters return.
//
// HOW "CUT OUTSIDE THE SELECTION" IS MEASURED. Every emitted move is walked in
// 0.25 mm steps. At each step the ball's CENTRE (tool tip + radius) is tested
// against every triangle of the part for its closest point; if that closest
// point sits within R + CONTACT_TOLERANCE_MM of the centre the cutter is
// touching material there, and the BRep face id of the triangle owning that
// closest point is the contact face. Step length is then charged to the
// selected or the unselected bucket. Nothing about the strategy, the boundary
// or the containment code is consulted -- the measurement only knows moves and
// triangles, so it cannot agree with the implementation by construction.
//
// The part is the committed STEP twin of the feature block, read through the
// production STEP importer, so its faceIds are real BRep subshape indices and
// not something this test invented (rule 6: a hand-built payload is a control,
// never application truth).

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { wave } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import {
  createOclWaterlineSlicer,
  type OclWaterlineModule,
  type WaterlineSlicer,
} from '../../cam3d/kernel/oclWaterline';
import type {
  FixedStockItem,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types';
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture';
import { typedMock } from '../support/typedMock';
import { PARTS } from '../benchmark/registry';
import {
  computeParallel3dMoves,
  cutterRadius,
  FaceScopeError,
  faceScopeForSource,
  readFaceScope,
  resolveFaceScopedBoundary,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';
import { computeScallop3dMoves, type Scallop3dParams } from '../../cam3d/integration/scallop3dOperation';
import { computePencil3dMoves, type Pencil3dParams } from '../../cam3d/integration/pencil3dOperation';
import { computeWaterline3dMoves, type WaterlineParams } from '../../cam3d/integration/waterline3dOperation';
import {
  computeSteepShallow3dMoves,
  type SteepShallow3dParams,
} from '../../cam3d/integration/steepShallow3dOperation';

// --- the part -------------------------------------------------------------
//
// fix_feature_block.step, 60 x 40 x 27, 19 BRep faces. The two this file aims
// at, by their measured geometry (not by name):
//   face 1  -- the flat block top at z = 20, 1361 mm^2 of footprint. Everything
//              standing above it (the r7 dome, the 8 x 10 boss) is a separate
//              face whose footprint is a HOLE in this one.
//   face 15 -- the pocket floor at z = 8, 672 mm^2, sunk 12 mm below the top.
const TOP_FACE = 1;
const POCKET_FLOOR_FACE = 15;
/** The r7 spherical cap standing on the block top, z 20 -> 27. */
const DOME_FACE = 0;
/** Every face of the pocket plus the top it is sunk into -- see the pencil case. */
const POCKET_AND_TOP = [1, 4, 6, 8, 15];

let cachedPart: PartMesh | undefined;
async function featureBlockStep(): Promise<PartMesh> {
  cachedPart ??= await PARTS.find((part) => part.id === 'feature-block-step')!.mesh();
  return cachedPart;
}

// --- in-process client (client <-> dispatcher over a REAL BvhKernel) -------
function makeClient(slicer?: WaterlineSlicer): Cam3dClient {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(
    kernel,
    (msg: Cam3dResponse) => { fakeWorker.onmessage?.({ data: msg } as MessageEvent); },
    slicer ? { slicer } : {},
  );
  return new Cam3dClient(fakeWorker);
}

/**
 * The REAL opencamlib slicer, loaded exactly the way WO-1176's adapter test
 * loads it: the package's `main` is a native Node addon that is not shipped and
 * the browser build refuses to start without a `window`, so the emscripten build
 * is required directly under a `window` shim (installed by the beforeAll below).
 * The same wasm the app runs in its worker therefore produces the loops this
 * test measures -- a face-scoped waterline has to survive real slicer output,
 * not a rectangle invented here.
 */
const nodeRequire = createRequire(import.meta.url);
function realOclSlicer(): WaterlineSlicer {
  return createOclWaterlineSlicer({
    load: async () =>
      nodeRequire('@opencamlib/opencamlib/lib/emscripten/index.js') as OclWaterlineModule,
  });
}

const globalWithWindow = globalThis as { window?: unknown };
let hadWindow = false;
beforeAll(() => {
  hadWindow = 'window' in globalWithWindow;
  if (!hadWindow) globalWithWindow.window = globalThis;
});
afterAll(() => {
  if (!hadWindow) delete globalWithWindow.window;
});

const ball3: Tool = {
  id: 'wo1223-ball-3', name: '3 mm ball', type: 'ball_end_mill', diameter: 3, fluteLength: 32,
  shankDiameter: 3, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
} as unknown as Tool;

// Model surface spans z 0..27; retract/clearance sit above it.
const HEIGHTS: ResolvedParallel3dHeights = {
  clearanceZ: 40, retractZ: 32, feedZ: 30, topZ: 27, bottomZ: 0,
};

const PARALLEL: Parallel3dParams = {
  stepover: 1.5, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false,
};

// --- contact measurement ---------------------------------------------------

/**
 * How far past the ball radius a closest point may sit and still count as a CUT.
 *
 * Deliberately tighter than the 0.05 mm clearance the containment keeps from
 * unselected geometry (FACE_SCOPE_EDGE_CLEARANCE_MM), so the two questions stay
 * separable: a tool passing 0.05 mm clear of a boss wall is a near miss and is
 * NOT charged as cutting it, while a tool SEATED on a surface -- which is what
 * every path vertex of a drop-cutter finish is, exactly -- is. Loosening this
 * past the clearance is what makes a rub read as a cut.
 */
const CONTACT_TOLERANCE_MM = 0.03;
/** Walking step along every move. Well under the tool radius. */
const WALK_STEP_MM = 0.25;

interface TriangleIndex {
  /** Per triangle: minX, minY, maxX, maxY. */
  aabb: Float64Array;
  count: number;
}

function indexTriangles(mesh: PartMesh): TriangleIndex {
  const count = mesh.indices.length / 3;
  const aabb = new Float64Array(count * 4);
  for (let t = 0; t < count; t++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      minX = Math.min(minX, mesh.positions[v * 3]);
      maxX = Math.max(maxX, mesh.positions[v * 3]);
      minY = Math.min(minY, mesh.positions[v * 3 + 1]);
      maxY = Math.max(maxY, mesh.positions[v * 3 + 1]);
    }
    aabb[t * 4] = minX; aabb[t * 4 + 1] = minY; aabb[t * 4 + 2] = maxX; aabb[t * 4 + 3] = maxY;
  }
  return { aabb, count };
}

/** Closest point on triangle ABC to P (Ericson, Real-Time Collision Detection 5.1.5). */
function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array,
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v; return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w; return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w; return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

const scratch = new Float64Array(3);

/** BRep face id of the triangle the ball touches at this tool position, or -1 for air. */
function contactFaceId(
  mesh: PartMesh, index: TriangleIndex, radius: number,
  tipX: number, tipY: number, tipZ: number,
): number {
  const cz = tipZ + radius;
  const reach = radius + CONTACT_TOLERANCE_MM;
  let best = Infinity;
  let bestFace = -1;
  for (let t = 0; t < index.count; t++) {
    // XY reject first: a triangle whose footprint is farther than the reach can
    // never hold the contact point.
    const dx = Math.max(index.aabb[t * 4] - tipX, 0, tipX - index.aabb[t * 4 + 2]);
    const dy = Math.max(index.aabb[t * 4 + 1] - tipY, 0, tipY - index.aabb[t * 4 + 3]);
    if (dx * dx + dy * dy > reach * reach) continue;
    const a = mesh.indices[t * 3], b = mesh.indices[t * 3 + 1], c = mesh.indices[t * 3 + 2];
    closestPointOnTriangle(
      tipX, tipY, cz,
      mesh.positions[a * 3], mesh.positions[a * 3 + 1], mesh.positions[a * 3 + 2],
      mesh.positions[b * 3], mesh.positions[b * 3 + 1], mesh.positions[b * 3 + 2],
      mesh.positions[c * 3], mesh.positions[c * 3 + 1], mesh.positions[c * 3 + 2],
      scratch,
    );
    const d = Math.hypot(scratch[0] - tipX, scratch[1] - tipY, scratch[2] - cz);
    if (d < best) { best = d; bestFace = mesh.faceIds![t]; }
  }
  return best <= reach ? bestFace : -1;
}

interface CutLedger {
  /** mm of travel in contact with a face in the selection (or with any face when unscoped). */
  inside: number;
  /** mm of travel in contact with a face OUTSIDE the selection. THE number this WO is about. */
  outside: number;
  /** mm of travel touching nothing. */
  air: number;
  /** Contact length per BRep face id. */
  byFace: Map<number, number>;
}

function measureCut(
  mesh: PartMesh, moves: readonly ToolpathMove[], tool: Tool, selection: readonly number[],
): CutLedger {
  const index = indexTriangles(mesh);
  const radius = tool.diameter / 2;
  const wanted = new Set(selection);
  const ledger: CutLedger = { inside: 0, outside: 0, air: 0, byFace: new Map() };
  let px = moves[0].x, py = moves[0].y, pz = moves[0].z;
  for (let m = 1; m < moves.length; m++) {
    const move = moves[m];
    const length = Math.hypot(move.x - px, move.y - py, move.z - pz);
    if (length > 0) {
      const steps = Math.max(1, Math.ceil(length / WALK_STEP_MM));
      const stepLength = length / steps;
      for (let s = 0; s < steps; s++) {
        // Midpoint of each sub-step: charges the whole sub-step to one contact.
        const f = (s + 0.5) / steps;
        const face = contactFaceId(
          mesh, index, radius,
          px + (move.x - px) * f, py + (move.y - py) * f, pz + (move.z - pz) * f,
        );
        if (face < 0) { ledger.air += stepLength; continue; }
        ledger.byFace.set(face, (ledger.byFace.get(face) ?? 0) + stepLength);
        if (wanted.size === 0 || wanted.has(face)) ledger.inside += stepLength;
        else ledger.outside += stepLength;
      }
    }
    px = move.x; py = move.y; pz = move.z;
  }
  return ledger;
}

function report(label: string, ledger: CutLedger): void {
  const faces = [...ledger.byFace.entries()].sort((a, b) => b[1] - a[1])
    .map(([id, len]) => `face ${id}: ${len.toFixed(1)} mm`).join(', ');
  console.log(
    `[WO-1223] ${label}: in-selection ${ledger.inside.toFixed(1)} mm, ` +
      `OUT of selection ${ledger.outside.toFixed(3)} mm, air ${ledger.air.toFixed(1)} mm | ${faces}`,
  );
}

// --- readFaceScope ---------------------------------------------------------

describe('WO-1223 readFaceScope', () => {
  it('reads both stored shapes, keeps the whole part for absent/empty, and drops junk', () => {
    expect(readFaceScope({})).toBeUndefined();
    expect(readFaceScope({ faceScope: [] })).toBeUndefined();
    expect(readFaceScope({ faceScope: { faceIds: [] } })).toBeUndefined();
    expect(readFaceScope({ faceScope: null })).toBeUndefined();
    expect(readFaceScope({ faceScope: 'all' })).toBeUndefined();
    expect(readFaceScope({ faceScope: [3, 1, 3] })).toEqual([1, 3]);
    expect(readFaceScope({ faceScope: { faceIds: [7, 2] } })).toEqual([2, 7]);
    expect(readFaceScope({ faceScope: [1, -2, 1.5, NaN, 'x', 4] })).toEqual([1, 4]);
  });

  it('reads a radius off every cutter profile the finishes accept', () => {
    expect(cutterRadius({ kind: 'flat', diameter: 6 })).toBe(3);
    expect(cutterRadius({ kind: 'ball', diameter: 3 })).toBe(1.5);
    expect(cutterRadius({ kind: 'bull', diameter: 6, cornerRadius: 1 })).toBe(3);
    expect(cutterRadius({ kind: 'vbit', diameter: 10, angleFromAxisDeg: 45 })).toBe(5);
  });
});

// --- the promise -----------------------------------------------------------

describe('WO-1223 a parallel finish aimed at chosen faces', () => {
  it('cuts ZERO length outside the selection, where the same pass unscoped cuts the whole part', async () => {
    const mesh = await featureBlockStep();
    expect(mesh.faceIds, 'the STEP twin must carry BRep face ids').toBeDefined();

    const wholePart = await computeParallel3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params: PARALLEL, client: makeClient(),
    });
    const wholeLedger = measureCut(mesh, wholePart.moves, ball3, [TOP_FACE]);
    report('parallel_3d whole part (selection would have been face 1)', wholeLedger);

    // The control: unscoped, the pass really does machine the rest of the part.
    expect(wholeLedger.outside).toBeGreaterThan(100);
    expect(wholeLedger.byFace.size).toBeGreaterThan(3);

    const scoped = await computeParallel3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params: PARALLEL,
      faceScope: [TOP_FACE], client: makeClient(),
    });
    const scopedLedger = measureCut(mesh, scoped.moves, ball3, [TOP_FACE]);
    report('parallel_3d scoped to face 1', scopedLedger);

    expect(scopedLedger.outside).toBe(0);
    expect(scopedLedger.inside).toBeGreaterThan(100);
  }, 300_000);

  it('leaves the whole-part path literally untouched when no scope is set', async () => {
    const mesh = await featureBlockStep();
    const base = await computeParallel3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params: PARALLEL, client: makeClient(),
    });
    const explicitUndefined = await computeParallel3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params: PARALLEL,
      faceScope: undefined, client: makeClient(),
    });
    const emptyScope = await computeParallel3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params: PARALLEL,
      faceScope: [], client: makeClient(),
    });
    expect(explicitUndefined.moves).toEqual(base.moves);
    expect(emptyScope.moves).toEqual(base.moves);
  }, 300_000);
});

describe('WO-1223 every finishing strategy honours the selection', () => {
  it('scallop_3d cuts zero length outside the pocket floor it is aimed at', async () => {
    const mesh = await featureBlockStep();
    const params: Scallop3dParams = {
      scallopHeight: 0.05, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false,
      direction: 'climb',
    };
    const scoped = await computeScallop3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params,
      faceScope: [POCKET_FLOOR_FACE], client: makeClient(),
    });
    const ledger = measureCut(mesh, scoped.moves, ball3, [POCKET_FLOOR_FACE]);
    report('scallop_3d scoped to face 15 (pocket floor)', ledger);
    expect(ledger.outside).toBe(0);
    expect(ledger.inside).toBeGreaterThan(50);
  }, 300_000);

  it('pencil_3d cuts zero length outside the pocket it is aimed at', async () => {
    const mesh = await featureBlockStep();
    const params: Pencil3dParams = {
      tolerance: 0.1, stockToLeave: 0, useStockBoundary: false, direction: 'climb',
    };
    // Pencil's whole subject is the CONCAVE CORNER between two faces, so a
    // pencil scope has to name both sides of the corners it wants: the pocket
    // floor, its walls and its drafted wall, plus the block top the pocket is
    // sunk into. Aim it at a floor alone and containment correctly leaves it
    // nothing -- the corner is on that floor's edge, which is exactly where the
    // cutter may not go.
    const scoped = await computePencil3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params,
      faceScope: POCKET_AND_TOP, client: makeClient(),
    });
    const ledger = measureCut(mesh, scoped.moves, ball3, POCKET_AND_TOP);
    report('pencil_3d scoped to the pocket + block top', ledger);
    expect(ledger.outside).toBe(0);
    expect(ledger.inside).toBeGreaterThan(10);
  }, 300_000);

  it('waterline_3d cuts zero length outside the dome it is aimed at (REAL opencamlib slicer)', async () => {
    const mesh = await featureBlockStep();
    const params: WaterlineParams = {
      stepdown: 1, tolerance: 0.1, stockToLeave: 0, minSlopeDeg: 0, flatAreaDetection: false,
      order: 'region', direction: 'climb', useStockBoundary: false,
    };
    // A finishing band over the dome only: Material Start at the apex, Cutter
    // End just below its base. Both runs use the identical band, so the only
    // difference between them is the face scope.
    const band: ResolvedParallel3dHeights = { ...HEIGHTS, topZ: 27, bottomZ: 19 };

    const unscoped = await computeWaterline3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: band, params,
      client: makeClient(realOclSlicer()),
    });
    const unscopedLedger = measureCut(mesh, unscoped.moves, ball3, [DOME_FACE]);
    report('waterline_3d whole part over the dome band', unscopedLedger);
    expect(unscopedLedger.outside).toBeGreaterThan(10);

    const scoped = await computeWaterline3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: band, params,
      faceScope: [DOME_FACE], client: makeClient(realOclSlicer()),
    });
    const scopedLedger = measureCut(mesh, scoped.moves, ball3, [DOME_FACE]);
    report('waterline_3d scoped to face 0 (the dome)', scopedLedger);
    expect(scopedLedger.outside).toBe(0);
    expect(scopedLedger.inside).toBeGreaterThan(10);
  }, 600_000);

  it('steep_shallow_3d carries the selection into both of its halves', async () => {
    const mesh = await featureBlockStep();
    const params: SteepShallow3dParams = {
      thresholdDeg: 90, stepdown: 2, stepover: 1.5, angleDeg: 0, tolerance: 0.1, stockToLeave: 0,
      useStockBoundary: false,
    };
    // threshold 90 is the pure-shallow composition: one parallel half, so this
    // measures the same zero-cut promise through the composed adapter.
    const scoped = await computeSteepShallow3dMoves({
      partMesh: mesh, tool: ball3, resolvedHeights: HEIGHTS, params,
      faceScope: [TOP_FACE], client: makeClient(),
    });
    const ledger = measureCut(mesh, scoped.moves, ball3, [TOP_FACE]);
    report('steep_shallow_3d scoped to face 1', ledger);
    expect(ledger.outside).toBe(0);
    expect(ledger.inside).toBeGreaterThan(100);
  }, 300_000);
});

// --- the traps -------------------------------------------------------------

describe('WO-1223 a scope that cannot be honoured', () => {
  it('runs whole-part with ONE console line when the source has no BRep faces at all', async () => {
    const mesh = wave(20, 25);
    expect(mesh.faceIds).toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const boundary: readonly Ring[] = [new Float64Array([0, 0, 20, 0, 20, 20, 0, 20])];
      const resolved = await resolveFaceScopedBoundary({
        partMesh: mesh, faceScope: [1, 2], boundary, cutterRadius: 1.5,
        operationLabel: 'Parallel 3D',
      });
      // Same reference back: the whole-part path is not merely equivalent, it is
      // the identical containment the caller already had.
      expect(resolved).toBe(boundary);
      const lines = warn.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes('no BRep face ids'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('machining the whole part');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses by name when the chosen faces are not on this part', async () => {
    const mesh = await featureBlockStep();
    await expect(resolveFaceScopedBoundary({
      partMesh: mesh, faceScope: [9999], cutterRadius: 1.5, operationLabel: 'Parallel 3D',
    })).rejects.toThrow(FaceScopeError);
  }, 120_000);

  it('refuses by name when the cutter cannot fit inside the chosen faces', async () => {
    const mesh = await featureBlockStep();
    // Face 17 is the 8 x 10 boss top; a 30 mm cutter cannot be kept inside it.
    await expect(resolveFaceScopedBoundary({
      partMesh: mesh, faceScope: [17], cutterRadius: 15, operationLabel: 'Parallel 3D',
    })).rejects.toThrow(/nothing is left to cut/);
  }, 120_000);

  // The audit caught this: the case above calls the RESOLVER once, and the
  // steep-and-shallow behaviour case earlier sets thresholdDeg 90, which takes
  // the pure-shallow early return and never composes. Both stayed green while
  // the default composed operation reported the fallback TWICE -- once from
  // each half -- for one operation the operator started once. This case runs
  // the composed path at an intermediate threshold, which is what the form's
  // default produces, and counts what the operator would actually read.
  it('reports the no-faceIds fallback ONCE from the composed steep-and-shallow default', async () => {
    const mesh = wave(20, 25);
    expect(mesh.faceIds).toBeUndefined();
    const params: SteepShallow3dParams = {
      thresholdDeg: 45, stepdown: 2, stepover: 1.5, angleDeg: 0, tolerance: 0.1, stockToLeave: 0,
      useStockBoundary: false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await computeSteepShallow3dMoves({
        partMesh: mesh, tool: ball3, resolvedHeights: { ...HEIGHTS, topZ: 15, bottomZ: 0 }, params,
        faceScope: [1, 2], client: makeClient(realOclSlicer()),
      });
      const lines = warn.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes('no BRep face ids'));
      expect(lines).toHaveLength(1);
      // And it names the operation the operator started, not one of its halves.
      expect(lines[0]).toContain('[Steep and Shallow]');
    } finally {
      warn.mockRestore();
    }
  }, 300_000);

  it('refuses by name when the chosen faces lie outside the stock footprint', async () => {
    const mesh = await featureBlockStep();
    await ensureGeom2dReady();
    const elsewhere: readonly Ring[] = [
      new Float64Array([500, 500, 520, 500, 520, 520, 500, 520]),
    ];
    await expect(resolveFaceScopedBoundary({
      partMesh: mesh, faceScope: [TOP_FACE], boundary: elsewhere, cutterRadius: 1.5,
      operationLabel: 'Parallel 3D',
    })).rejects.toThrow(/stock footprint/);
  }, 120_000);
});

// --- through the production entry point ------------------------------------
//
// Rule 6: a claim about what the APPLICATION machines has to be measured where
// the application machines it. Everything above drives the strategy adapters
// directly. That proves the containment arithmetic, but it cannot prove that
// `op.params.faceScope` ever REACHES an adapter: the store resolves the scope
// once per compute (`readFaceScope`) and hands it down, and a dropped or
// misdirected hand-off there would leave every adapter assertion above green
// while the app quietly machined the whole part.
//
// So this block presses Generate. `computeOperationToolpath(setupId, opId)` on
// a real Setup, with the real store, the real strategy adapters, the real
// kernel and the real containment code. Only the STEP byte cache and the
// tessellator are stubbed -- the same two the WO-1217 chain runner stubs -- and
// the mesh handed to the tessellator stub is the one the production STEP
// importer produced at the top of this file, BRep face ids and all.

const SETUP_ID = 'wo1223-setup';
const GEO_ID = 'wo1223-geo';
const STOCK_ID = 'wo1223-stock';

/** The operation the app writes when a machinist creates a 3D finish. */
function finishOperation(input: {
  id: string;
  type: Operation['type'];
  params: Record<string, unknown>;
  topZ: number;
}): Operation {
  return stampSmartHeightAuthority(
    {
      id: input.id,
      name: input.id,
      type: input.type,
      enabled: true,
      status: 'pending',
      toolId: ball3.id,
      geometrySelections: [GEO_ID],
      heights: {
        clearanceHeight: input.topZ + 13,
        clearanceHeightMode: 'absolute',
        retractHeight: input.topZ + 5,
        feedHeight: input.topZ + 3,
        topHeight: 0,
        topHeightMode: 'model_top',
        bottomHeight: 0,
        bottomHeightMode: 'model_bottom',
      },
      passes: { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
        leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
      },
      params: input.params,
    } as unknown as Operation,
    { setupId: SETUP_ID, geometryIds: [GEO_ID], stockId: STOCK_ID },
  ) as Operation;
}

/** Stand-ins for the five strategy adapters, when the question is the HAND-OFF. */
interface AdapterRecorders {
  parallel?: Mock;
  waterline?: Mock;
  scallop?: Mock;
  pencil?: Mock;
  steepShallow?: Mock;
}

/** What a recorder gives the store back: two moves, so the op can land `ready`. */
function stubMoves(): { moves: ToolpathMove[]; computeTimeMs: number } {
  return {
    moves: [
      { type: 'rapid', x: 0, y: 0, z: 40, role: 'rapid' },
      { type: 'feed', x: 1, y: 1, z: 20, feed: 300, role: 'cut' },
    ] as unknown as ToolpathMove[],
    computeTimeMs: 1,
  };
}

interface StoreScene {
  /** The production entry point itself. */
  compute: (opId: string) => Promise<void>;
  op: (opId: string) => Operation;
  dispose: () => Promise<void>;
}

/**
 * Stand the app up around the real kernel and hand back its Generate button.
 *
 * Lifted from `src/tests/benchmark/chainRunner.ts` (a third way of standing the
 * store up is how contracts drift apart): a Cam3dClient wired straight to a
 * Cam3dDispatcher over the in-process channel, the STEP byte cache and the
 * tessellator stubbed, everything else production.
 */
async function pressGenerate(input: {
  mesh: PartMesh;
  operations: Operation[];
  slicer?: WaterlineSlicer;
  recorders?: AdapterRecorders;
}): Promise<StoreScene> {
  vi.resetModules();
  const client = makeClient(input.slicer);
  const rec = input.recorders;

  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) =>
    typedMock<typeof import('../../cam3d/integration/appClient')>({
      ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
      getCam3dClient: () => client,
    }));
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) =>
    typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
      ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
      acquirePartMesh: vi.fn(async () => input.mesh),
      ...(rec?.parallel ? { computeParallel3dMoves: rec.parallel } : {}),
    }));
  if (rec?.waterline) {
    vi.doMock('../../cam3d/integration/waterline3dOperation', async (importOriginal) =>
      typedMock<typeof import('../../cam3d/integration/waterline3dOperation')>({
        ...(await importOriginal<typeof import('../../cam3d/integration/waterline3dOperation')>()),
        computeWaterline3dMoves: rec.waterline!,
      }));
  }
  if (rec?.scallop) {
    vi.doMock('../../cam3d/integration/scallop3dOperation', async (importOriginal) =>
      typedMock<typeof import('../../cam3d/integration/scallop3dOperation')>({
        ...(await importOriginal<typeof import('../../cam3d/integration/scallop3dOperation')>()),
        computeScallop3dMoves: rec.scallop!,
      }));
  }
  if (rec?.pencil) {
    vi.doMock('../../cam3d/integration/pencil3dOperation', async (importOriginal) =>
      typedMock<typeof import('../../cam3d/integration/pencil3dOperation')>({
        ...(await importOriginal<typeof import('../../cam3d/integration/pencil3dOperation')>()),
        computePencil3dMoves: rec.pencil!,
      }));
  }
  if (rec?.steepShallow) {
    vi.doMock('../../cam3d/integration/steepShallow3dOperation', async (importOriginal) =>
      typedMock<typeof import('../../cam3d/integration/steepShallow3dOperation')>({
        ...(await importOriginal<typeof import('../../cam3d/integration/steepShallow3dOperation')>()),
        computeSteepShallow3dMoves: rec.steepShallow!,
      }));
  }
  vi.doMock('../../lib/stepCache', async (importOriginal) =>
    typedMock<typeof import('../../lib/stepCache')>({
      ...(await importOriginal<typeof import('../../lib/stepCache')>()),
      loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
    }));

  // `window` is already this file's OCL shim (window === globalThis, set in the
  // beforeAll above), so the app's browser-only reads resolve against globals.
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(),
  });
  vi.stubGlobal('__cncViewport', { getStockBounds: () => null });

  const min = input.mesh.bounds.min;
  const max = input.mesh.bounds.max;
  const fixedStock: FixedStockItem = {
    id: STOCK_ID,
    name: 'WO-1223 block',
    width: max[0] - min[0],
    height: max[1] - min[1],
    depth: max[2] - min[2],
    position: { x: min[0], y: min[1], z: min[2] },
  };
  const geometry = {
    id: GEO_ID,
    name: 'WO-1223 feature block',
    filename: 'fix_feature_block.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] },
      size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
      center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
    },
    // The part sits where the fixture puts it, so the world moves the store
    // stores are the same numbers the triangles above are measured in.
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: STOCK_ID,
  } as unknown as ImportedGeometry;
  const physicalStock = {
    id: STOCK_ID,
    name: fixedStock.name,
    mode: 'explicit',
    bounds: {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] },
      size: { x: fixedStock.width, y: fixedStock.height, z: fixedStock.depth },
      center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
    },
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock;
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: fixedStock.width, fixedHeight: fixedStock.height, fixedDepth: fixedStock.depth,
    fixedStocks: [fixedStock],
  } as unknown as SceneStock;
  const setup = {
    id: SETUP_ID,
    name: 'WO-1223 setup',
    wcs: {
      id: `wcs-${SETUP_ID}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: input.operations,
    notes: '',
  } as unknown as Setup;

  const { useCamStore } = await import('../../store');
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      id: 'project-wo1223',
      geometry: [geometry],
      setups: [setup],
      stocks: [physicalStock],
      sceneStock,
      toolLibrary: [ball3],
      activeSetupId: SETUP_ID,
    },
    toolLibrary: [ball3],
    toolpathBatch: null,
  }));

  return {
    compute: (opId) => useCamStore.getState().computeOperationToolpath(SETUP_ID, opId),
    op: (opId) => {
      const found = useCamStore.getState().project.setups
        .find((s) => s.id === SETUP_ID)?.operations.find((o) => o.id === opId);
      if (!found) throw new Error(`WO-1223: operation ${opId} vanished from the setup`);
      return found;
    },
    dispose: async () => {
      await client.dispose();
      vi.doUnmock('../../cam3d/integration/appClient');
      vi.doUnmock('../../cam3d/integration/parallel3dOperation');
      vi.doUnmock('../../cam3d/integration/waterline3dOperation');
      vi.doUnmock('../../cam3d/integration/scallop3dOperation');
      vi.doUnmock('../../cam3d/integration/pencil3dOperation');
      vi.doUnmock('../../cam3d/integration/steepShallow3dOperation');
      vi.doUnmock('../../lib/stepCache');
      vi.unstubAllGlobals();
      vi.resetModules();
    },
  };
}

/** The operation must have LANDED, with the app's own message when it did not. */
function readyMoves(op: Operation): readonly ToolpathMove[] {
  expect(`${op.status}${op.errorMessage ? `: ${op.errorMessage}` : ''}`).toBe('ready');
  const moves = op.toolpathMoves ?? [];
  expect(moves.length).toBeGreaterThan(0);
  return moves;
}

describe('WO-1223 the production entry point (computeOperationToolpath)', () => {
  it('a scoped parallel finish cuts ZERO outside its faces, where the SAME operation unscoped cuts the whole part', async () => {
    const mesh = await featureBlockStep();
    const topZ = mesh.bounds.max[2];
    const scene = await pressGenerate({
      mesh,
      operations: [
        finishOperation({
          id: 'wo1223-parallel-whole', type: 'parallel_3d', topZ,
          params: { ...PARALLEL },
        }),
        finishOperation({
          id: 'wo1223-parallel-scoped', type: 'parallel_3d', topZ,
          // Exactly the shape the operation form writes (Cam3dFaceScope).
          params: { ...PARALLEL, faceScope: { faceIds: [TOP_FACE] } },
        }),
      ],
    });
    try {
      await scene.compute('wo1223-parallel-whole');
      const wholeLedger = measureCut(
        mesh, readyMoves(scene.op('wo1223-parallel-whole')), ball3, [TOP_FACE],
      );
      report('computeOperationToolpath parallel_3d, whole part', wholeLedger);
      expect(wholeLedger.outside).toBeGreaterThan(100);
      expect(wholeLedger.byFace.size).toBeGreaterThan(3);

      await scene.compute('wo1223-parallel-scoped');
      const scopedLedger = measureCut(
        mesh, readyMoves(scene.op('wo1223-parallel-scoped')), ball3, [TOP_FACE],
      );
      report('computeOperationToolpath parallel_3d, scoped to face 1', scopedLedger);
      expect(scopedLedger.outside).toBe(0);
      expect(scopedLedger.inside).toBeGreaterThan(100);
    } finally {
      await scene.dispose();
    }
  }, 900_000);

  it('a scoped waterline finish cuts ZERO outside the dome, through the store\'s OWN second orchestrator', async () => {
    const mesh = await featureBlockStep();
    const topZ = mesh.bounds.max[2];
    // computeWaterline3dToolpath is a separate function in the store with its
    // own hand-off, so it gets its own measured run rather than inheriting the
    // parallel one. Stepdown 1 mm over the whole-model band the Smart Height
    // policy resolves: the dome's containment region is its footprint inset by
    // the cutter, so only the levels near the apex have anything left inside it
    // and a coarse stepdown steps straight past them (the app then refuses, by
    // name -- which is correct, and is not the question this test asks).
    const scene = await pressGenerate({
      mesh,
      slicer: realOclSlicer(),
      operations: [
        finishOperation({
          id: 'wo1223-waterline-scoped', type: 'waterline_3d', topZ,
          params: {
            stepdown: 1, tolerance: 0.1, stockToLeave: 0, minSlopeDeg: 0,
            flatAreaDetection: false, order: 'region', direction: 'climb',
            useStockBoundary: false,
            faceScope: { faceIds: [DOME_FACE] },
          },
        }),
      ],
    });
    try {
      await scene.compute('wo1223-waterline-scoped');
      const ledger = measureCut(
        mesh, readyMoves(scene.op('wo1223-waterline-scoped')), ball3, [DOME_FACE],
      );
      report('computeOperationToolpath waterline_3d, scoped to face 0 (the dome)', ledger);
      expect(ledger.outside).toBe(0);
      expect(ledger.inside).toBeGreaterThan(1);
    } finally {
      await scene.dispose();
    }
  }, 900_000);

  it('hands the stored selection to ALL FIVE finishing strategies, and hands down nothing when there is none', async () => {
    const mesh = await featureBlockStep();
    const topZ = mesh.bounds.max[2];
    // The measured runs above prove the parallel and waterline hand-offs on real
    // metal. This one asks the remaining question of every strategy at once, and
    // asks it at the entry point: does the operator's stored choice arrive at the
    // adapter, unchanged, for each of the five? The adapters are recorders here --
    // what each of them WOULD do with the scope is measured above and in the
    // per-strategy block earlier in this file.
    const recorders: Required<AdapterRecorders> = {
      parallel: vi.fn(async () => stubMoves()),
      waterline: vi.fn(async () => stubMoves()),
      scallop: vi.fn(async () => stubMoves()),
      pencil: vi.fn(async () => stubMoves()),
      steepShallow: vi.fn(async () => stubMoves()),
    };
    const cases = [
      { type: 'parallel_3d', rec: recorders.parallel, params: { ...PARALLEL } },
      {
        type: 'waterline_3d', rec: recorders.waterline,
        params: {
          stepdown: 1, tolerance: 0.1, stockToLeave: 0, minSlopeDeg: 0,
          flatAreaDetection: false, order: 'region', direction: 'climb', useStockBoundary: false,
        },
      },
      {
        type: 'scallop_3d', rec: recorders.scallop,
        params: {
          scallopHeight: 0.05, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false,
          direction: 'climb',
        },
      },
      {
        type: 'pencil_3d', rec: recorders.pencil,
        params: { tolerance: 0.1, stockToLeave: 0, useStockBoundary: false, direction: 'climb' },
      },
      {
        type: 'steep_shallow_3d', rec: recorders.steepShallow,
        params: {
          thresholdDeg: 45, stepdown: 2, stepover: 1.5, angleDeg: 0, tolerance: 0.1,
          stockToLeave: 0, useStockBoundary: false,
        },
      },
    ] as const;

    const scene = await pressGenerate({
      mesh,
      recorders,
      operations: cases.flatMap((c) => [
        finishOperation({
          id: `${c.type}-scoped`, type: c.type as Operation['type'], topZ,
          params: { ...c.params, faceScope: { faceIds: [POCKET_FLOOR_FACE, TOP_FACE] } },
        }),
        finishOperation({
          id: `${c.type}-whole`, type: c.type as Operation['type'], topZ,
          params: { ...c.params },
        }),
      ]),
    });
    try {
      for (const c of cases) {
        await scene.compute(`${c.type}-scoped`);
        readyMoves(scene.op(`${c.type}-scoped`));
        await scene.compute(`${c.type}-whole`);
        readyMoves(scene.op(`${c.type}-whole`));

        expect(c.rec, `${c.type}: its own adapter must be the one that ran`)
          .toHaveBeenCalledTimes(2);
        const scopedArgs = c.rec.mock.calls[0][0] as { faceScope?: readonly number[] };
        const wholeArgs = c.rec.mock.calls[1][0] as { faceScope?: readonly number[] };
        // Sorted and de-duplicated by readFaceScope; face 15 was stored first.
        expect(scopedArgs.faceScope, `${c.type} scoped`).toEqual([TOP_FACE, POCKET_FLOOR_FACE]);
        expect(wholeArgs.faceScope, `${c.type} whole part`).toBeUndefined();
      }
    } finally {
      await scene.dispose();
    }
  }, 300_000);
});

// --- one solid's face ids never travel to another --------------------------
//
// A face id is an index into ONE part's BRep. Against a different solid it is
// not "no selection", it is a DIFFERENT selection -- whatever faces that part
// happens to number 3 and 8 -- and against a mesh there is no BRep for it to
// index at all. `faceScopeForSource` is the single place that rule lives, and
// both the operation form and the New Operation form read the scope through it,
// for the reading and for the SAVE in the same breath, so a form can never show
// "All faces" while carrying hidden ids to disk.
describe('WO-1223 faceScopeForSource', () => {
  const picked = { partId: 'solid-a', faceIds: [8, 3] };

  it('keeps the scope only on the solid it was picked on', () => {
    expect(faceScopeForSource(picked, { id: 'solid-a', format: 'step' })).toEqual([3, 8]);
    expect(faceScopeForSource(picked, { id: 'solid-b', format: 'step' })).toEqual([]);
    expect(faceScopeForSource(picked, { id: undefined, format: 'step' })).toEqual([]);
  });

  it('keeps no scope at all against a source with no BRep faces', () => {
    expect(faceScopeForSource(picked, { id: 'solid-a', format: 'stl' })).toEqual([]);
    expect(faceScopeForSource(picked, { id: 'solid-a', format: 'model' })).toEqual([]);
    expect(faceScopeForSource(picked, { id: 'solid-a', format: undefined })).toEqual([]);
  });

  it('is the whole part for an unpicked form, whatever it is pointed at', () => {
    expect(faceScopeForSource({ partId: '', faceIds: [] }, { id: 'solid-a', format: 'step' }))
      .toEqual([]);
    expect(faceScopeForSource({}, { id: 'solid-a', format: 'step' })).toEqual([]);
  });
});
