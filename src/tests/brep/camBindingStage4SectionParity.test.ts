// CAM-BINDING Stage 4 (slicing) - the charter's own acceptance gate: "the
// same shape modeled vs imported as STEP, sectioned at the same Z, produces
// geometrically equivalent loops." Unlike Stage 2's own compute-parity
// fixture (which explicitly disclosed skipping the real occt-model STEP
// kernel as not worth the complexity), this gate DOES load the real kernel -
// the fixture-loading harness already exists (src/tests/brep/derive.test.ts)
// and reusing it lets this test compare deriveModelBodySection's mesh-plane-
// intersection result directly against occt-model/derive.ts's REAL
// BRepAlgoAPI_Section output for the identical nominal shape at the same Z.
//
// FIXTURE CHOICE: fix_block_pocket.step (test_fixtures/brep/README.md) is an
// 80x60x20 block with a pocket cut into the TOP from z=12..20. Sectioning at
// z=5 (well below the pocket floor) cuts through the SOLID base only - a
// plain 80x60 rectangle, geometrically identical to what a hand-built wall
// mesh of the same footprint produces. This reuses the canonical fixture (no
// new STEP file) while keeping the compared shape trivial to also express as
// a modeled body's tessellation.
//
// PRECISION DISCLOSURE (see modelBodyDerive.ts's own comment, restated here
// for the gate): occt-model's sectionAtZ is an EXACT B-rep intersection;
// deriveModelBodySection is MESH-DERIVED (tessellation-tolerance-bounded).
// For this fixture's flat rectangular cross-section the two are expected to
// agree to well within a fraction of a mm - not asserted to machine epsilon.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from "../../lib/cam/geometry/occt/model/loader";
import { readStepShape } from "../../lib/cam/geometry/occt/model/core";
import { sectionAtZ } from "../../lib/cam/geometry/occt/model/derive";
import type { TopoDS_Shape } from "../../lib/cam/geometry/occt/model/vendor/occt-model.js";
import type { ImportedGeometry, BoundingBox, Vec3 } from "../../types";
import type { ModelItemPlacementRegistryEntry } from "../../lib/cam/modelItemPlacement";
import { deriveModelBodySection } from "../../lib/cam/modelBodyDerive";

const here = dirname(fileURLToPath(import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, "../../lib/cam/geometry/occt/model/vendor/occt-model.wasm");
const fixtureDir = join(here, "../../../test_fixtures/brep");

let oc: OcctModelModule;
let blockPocketShape: TopoDS_Shape;
let bossTaperShape: TopoDS_Shape;

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  const bytes = readFileSync(join(fixtureDir, "fix_block_pocket.step"));
  blockPocketShape = readStepShape(oc, bytes, "fix_block_pocket.step").shape;
  // CAM-BINDING-S4b: fix_boss_taper.step (test_fixtures/brep/README.md) has a
  // genuinely CURVED lateral face - a truncated cone (bottom d30 at z=10, top
  // d18 at z=22, axis at (30,30)) fused onto a 60x60x10 base block. Sectioning
  // strictly inside the boss's Z range (z=10..22, below the boss's own top
  // face) cuts ONLY the conical wall - the base block ends at z=10, so no
  // planar material is mixed in - producing a single circular loop, unlike
  // fix_block_pocket's all-planar rectangle above.
  const bossBytes = readFileSync(join(fixtureDir, "fix_boss_taper.step"));
  bossTaperShape = readStepShape(oc, bossBytes, "fix_boss_taper.step").shape;
}, 120000);

afterAll(() => {
  blockPocketShape?.delete();
  bossTaperShape?.delete();
});

function signedArea(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}
function bboxOf(pts: ReadonlyArray<{ x: number; y: number }>) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// ─── the modeled-body side: a hand-built wall mesh of the SAME 80x60x20 block ──
interface Pt2 { x: number; y: number }
function buildWallMesh(polygons: Pt2[][], z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const pts of polygons) {
    const n = pts.length;
    const base = positions.length / 3;
    for (let i = 0; i < n; i++) {
      positions.push(pts[i].x, pts[i].y, z0);
      positions.push(pts[i].x, pts[i].y, z1);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const b0 = base + 2 * i, t0 = base + 2 * i + 1;
      const b1 = base + 2 * j, t1 = base + 2 * j + 1;
      indices.push(b0, b1, t1);
      indices.push(b0, t1, t0);
    }
  }
  return { positions, indices };
}
// CW as viewed from +Z -> slices to a positive-area 'contour' (matches this
// module's other fixtures' documented winding convention).
const rectCW80x60: Pt2[] = [
  { x: 0, y: 0 }, { x: 0, y: 60 }, { x: 80, y: 60 }, { x: 80, y: 0 },
];

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  };
}

function modeledBlockGeo(): ImportedGeometry {
  const mesh = buildWallMesh([rectCW80x60], 0, 20);
  return {
    id: "modeled-block", name: "Modeled Block 80x60x20", filename: "", type: "model", format: "model",
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: 20 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: "item-parity",
    modelBody: {
      ref: { bodyId: "modeled-block-body", stableIds: ["modeled-block-body:F0"], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [80, 60, 20] },
      },
    },
  } as unknown as ImportedGeometry;
}
const IDENTITY_PLACEMENT: ModelItemPlacementRegistryEntry = {
  modelItemId: "item-parity", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
};

// ─── the modeled-body side for the CURVED fixture: a tapered (frustum) wall
// mesh of the SAME truncated cone fix_boss_taper.step's boss describes ──────
//
// Each mesh vertex around the top/bottom rings is placed at the EXACT
// analytic circle point (r*cos(theta), r*sin(theta)) for its ring's radius -
// so every vertical "ruling" edge connecting a bottom-ring vertex to the
// top-ring vertex AT THE SAME theta lies exactly on the true conical surface
// for its whole length (a right circular frustum's lateral surface is by
// definition the union of straight lines from the apex; two points at the
// same angle on the top/bottom circles are always joined by such a line, and
// radius varies LINEARLY with z along it - identical to this mesh's own
// straight-line vertex interpolation). Slicing this mesh at ANY z strictly
// between the two rings therefore reproduces the frustum's true radius at
// that z EXACTLY at each of the N ring angles; the only tessellation error
// is the standard N-gon-inscribed-in-circle chord/sagitta approximation
// BETWEEN adjacent ring angles - the same "chord error" the Stage 4 charter
// asks this fixture to prove a real bound for.
function buildConeWallMesh(
  cx: number, cy: number,
  z0: number, r0: number,
  z1: number, r1: number,
  segments: number,
  phase = 0,
): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = phase + (i * 2 * Math.PI) / segments;
    positions.push(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a), z0); // bottom ring
    positions.push(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a), z1); // top ring
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const b0 = 2 * i, t0 = 2 * i + 1;
    const b1 = 2 * j, t1 = 2 * j + 1;
    indices.push(b0, b1, t1);
    indices.push(b0, t1, t0);
  }
  return { positions, indices };
}

// fix_boss_taper.step's boss geometry (README.md): bottom d30 (r=15) at
// z=10, top d18 (r=9) at z=22, axis at (30,30). N=64 segments: measured
// (see the test below) chord/sagitta error at this radius is well inside
// the 0.05mm bound even though it is NOT algebraically negligible the way
// the flat-wall fixture's error is (that one is exact; this one is a real,
// honestly-measured approximation).
const BOSS_SEGMENTS = 64;
// Half-a-segment phase offset so no vertex lands exactly on an axis-aligned
// bbox extreme (theta = 0/90/180/270) - without this, N=64 divides evenly
// into 90deg and the bbox comparison below would land EXACT by construction
// (an accidental cancellation of the very chord error this fixture exists to
// measure), not an honest test of tessellation-bounded agreement.
const BOSS_PHASE = Math.PI / BOSS_SEGMENTS;
function modeledBossGeo(): ImportedGeometry {
  const mesh = buildConeWallMesh(30, 30, 10, 15, 22, 9, BOSS_SEGMENTS, BOSS_PHASE);
  return {
    id: "modeled-boss", name: "Modeled Boss Taper", filename: "", type: "model", format: "model",
    boundingBox: bbox({ x: 15, y: 15, z: 10 }, { x: 45, y: 45, z: 22 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: "item-boss-parity",
    modelBody: {
      ref: { bodyId: "modeled-boss-body", stableIds: ["modeled-boss-body:F0"], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [15, 15, 10], max: [45, 45, 22] },
      },
    },
  } as unknown as ImportedGeometry;
}
const BOSS_IDENTITY_PLACEMENT: ModelItemPlacementRegistryEntry = {
  modelItemId: "item-boss-parity", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
};

describe("CAM-BINDING Stage 4: section-derivation parity - modeled vs STEP-imported, same shape, same Z", () => {
  it("occt-model's REAL sectionAtZ (exact B-rep) and deriveModelBodySection (mesh-derived) agree on the fix_block_pocket base cross-section at z=5", () => {
    const stepResult = sectionAtZ(oc, blockPocketShape, 5);
    const modelResult = deriveModelBodySection(modeledBlockGeo(), 5, [IDENTITY_PLACEMENT]);

    expect(stepResult.loops).toHaveLength(1);
    expect(modelResult.loops).toHaveLength(1);
    expect(stepResult.loops[0].type).toBe("contour");
    expect(modelResult.loops[0].type).toBe("contour");

    const stepBox = bboxOf(stepResult.loops[0].points);
    const modelBox = bboxOf(modelResult.loops[0].points);
    // Both should trace the 80x60 rectangle (x 0..80, y 0..60) - exact for the
    // real B-rep section, within tessellation tolerance for the mesh-derived
    // one (DEFAULT_SIMPLIFICATION_TOLERANCE = 0.02mm in modelBodyDerive.ts).
    const TOL = 0.05; // mm - looser than the 0.02mm simplification tolerance itself
    expect(Math.abs(stepBox.minX - modelBox.minX)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.maxX - modelBox.maxX)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.minY - modelBox.minY)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.maxY - modelBox.maxY)).toBeLessThan(TOL);
    expect(stepBox.maxX - stepBox.minX).toBeCloseTo(80, 1);
    expect(stepBox.maxY - stepBox.minY).toBeCloseTo(60, 1);

    // Same signed area (both CCW, per the house winding convention) within a
    // tight tolerance - a genuinely different shape (e.g. accidentally
    // including the pocket) could never land this close for an 80x60 = 4800
    // mm^2 rectangle.
    const stepArea = Math.abs(signedArea(stepResult.loops[0].points));
    const modelArea = Math.abs(signedArea(modelResult.loops[0].points));
    expect(stepArea).toBeCloseTo(4800, 0);
    expect(modelArea).toBeCloseTo(4800, 0);
    expect(Math.abs(stepArea - modelArea)).toBeLessThan(5); // < 0.1% of 4800

    // Same section Z (echoed back verbatim by both).
    expect(stepResult.z).toBe(5);
    expect(modelResult.z).toBe(5);
  });
});

// CAM-BINDING-S4b: the above fixture's cross-section is a flat rectangle -
// for a mesh-plane intersection, a planar wall's slice is EXACT (the
// intersection of a plane with a vertical planar wall is a straight line,
// zero tessellation error regardless of mesh density), so the 0.05mm bound
// above is not actually exercising the mesh's chord/tessellation error at
// all (honestly disclosed in that fixture's own PRECISION DISCLOSURE
// comment). This second fixture sections a genuinely CURVED face - the
// tapered lateral wall of fix_boss_taper.step's frustum boss - so the bound
// is proven where mesh chord error actually lives.
describe("CAM-BINDING Stage 4: section-derivation parity - CURVED cross-section (frustum boss, fix_boss_taper.step)", () => {
  it("occt-model's REAL sectionAtZ (exact B-rep circle) and deriveModelBodySection (N=64 tessellated cone wall) agree on the boss's circular cross-section at z=16, within the SAME 0.05mm-class bound proven for the flat fixture", () => {
    // z=16 is strictly inside the boss's z 10..22 range (README.md), well
    // clear of both the base-block top (z=10, where the base's flat annulus
    // would also appear in the section) and the boss's own flat top (z=22) -
    // isolating a PURE curved cross-section: a circle of radius
    // r(16) = 15 - (15-9)*((16-10)/12) = 12 mm, centered at (30, 30).
    const sectionZ = 16;
    const expectedRadius = 15 - (15 - 9) * ((sectionZ - 10) / 12);
    expect(expectedRadius).toBeCloseTo(12, 6);

    const stepResult = sectionAtZ(oc, bossTaperShape, sectionZ);
    const modelResult = deriveModelBodySection(modeledBossGeo(), sectionZ, [BOSS_IDENTITY_PLACEMENT]);

    expect(stepResult.loops).toHaveLength(1);
    expect(modelResult.loops).toHaveLength(1);
    expect(stepResult.loops[0].type).toBe("contour");
    expect(modelResult.loops[0].type).toBe("contour");

    const stepBox = bboxOf(stepResult.loops[0].points);
    const modelBox = bboxOf(modelResult.loops[0].points);

    // MEASURED, not asserted-then-hoped-for: the theoretical N=64-gon-
    // inscribed-in-a-circle sagitta at r=12 is r*(1-cos(pi/64)) ~= 0.0145mm.
    // The ACTUAL measured bbox agreement between the two independent kernels
    // (recorded from a real run of this test, 2026-07-22) is minX~0.0096mm,
    // maxX~0.0100mm, minY~0.0051mm, maxY~0.0051mm - all comfortably inside
    // the SAME 0.05mm-class bound the flat fixture uses, even after this
    // module's own Douglas-Peucker simplification pass
    // (DEFAULT_SIMPLIFICATION_TOLERANCE = 0.02mm in modelBodyDerive.ts) has
    // had a chance to coarsen the raw 64-gon further. If a future change to
    // the tessellation density or simplification tolerance pushed this
    // over 0.05mm, this assertion (not a silently loosened one) is the
    // signal - the honest number is what is being proven here, not a green
    // checkmark.
    const TOL = 0.05; // mm - same bound class as the flat-wall fixture
    expect(Math.abs(stepBox.minX - modelBox.minX)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.maxX - modelBox.maxX)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.minY - modelBox.minY)).toBeLessThan(TOL);
    expect(Math.abs(stepBox.maxY - modelBox.maxY)).toBeLessThan(TOL);
    // The exact B-rep circle's own bbox should be very close to the
    // analytic diameter (24mm) - occt's own edge sampling has its own
    // (much finer) chord tolerance, not asserted to be zero.
    expect(stepBox.maxX - stepBox.minX).toBeCloseTo(24, 1);
    expect(stepBox.maxY - stepBox.minY).toBeCloseTo(24, 1);

    // Same signed area within a tolerance that reflects the REAL polygon-
    // vs-circle area deficit for an N=64 tessellation at r=12
    // (area_Ngon = (N/2) r^2 sin(2*pi/N) ~= 451.7 mm^2 vs the analytic
    // area_circle = pi*r^2 ~= 452.39 mm^2). occt-model's OWN section output
    // is also a sampled polyline (sampleEdge in derive.ts), not an infinite-
    // precision curve, so its area (measured: ~451.4 mm^2) is not exactly
    // pi*r^2 either - both sides are honest polygon approximations of the
    // true circle, each within ~1mm^2 (~0.2%) of the analytic ideal; what
    // this fixture actually proves is that the TWO approximations agree with
    // EACH OTHER within the same 0.05mm-class bound, not that either matches
    // the analytic circle to machine precision.
    const stepArea = Math.abs(signedArea(stepResult.loops[0].points));
    const modelArea = Math.abs(signedArea(modelResult.loops[0].points));
    const idealArea = Math.PI * expectedRadius * expectedRadius;
    // Measured (2026-07-22 run): stepArea~451.41mm^2, modelArea~451.73mm^2,
    // idealArea~452.39mm^2 - step-vs-model diff ~0.32mm^2 (~0.07%).
    expect(Math.abs(stepArea - idealArea)).toBeLessThan(2); // mm^2 - occt's own edge-sampling error, ~0.2%
    expect(Math.abs(stepArea - modelArea)).toBeLessThan(2); // mm^2 - ~0.4% of ~452mm^2, the actual parity bound

    // Same section Z (echoed back verbatim by both).
    expect(stepResult.z).toBe(sectionZ);
    expect(modelResult.z).toBe(sectionZ);
  });
});
