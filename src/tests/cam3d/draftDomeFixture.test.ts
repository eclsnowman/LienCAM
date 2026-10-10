// cam3d M2 draft/dome fixture validity + analytic-truth tests.
//
// Covers draftDomePocket() -- the 3D-FINISHING torture fixture (drafted walls +
// drafted island post + spherical dome, meshed as a heightfield sheet):
//   - mesh validity (finite coords, in-range indices, no degenerate tris),
//   - exact surface bounds x[0,90] y[0,60] z[4,16] (open top-surface sheet),
//   - determinism (byte-identical across two calls, D-006),
//   - analytic helpers (dome disc radius / volume, floor + top-opening areas),
//   - a drop-grid recovers the dome apex (~z=16 at the center) with a sqrt
//     falloff (spot-checked against domeDiscRadiusAt), the floor minimum
//     (~z=4), and -- unlike the prismatic engagementPocket -- a CONTINUUM of
//     intermediate z values on the drafted walls (not just two discrete levels).

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { GridSpec, PartMesh } from '../../cam3d/kernel/types';
import {
  draftDomePocket,
  draftDomeHeight,
  domeDiscRadiusAt,
  draftDomeVolume,
  draftDomeFloorFootprintArea,
  draftDomeTopOpeningArea,
  DRAFT_DOME_RADIUS,
  DRAFT_DOME_DEPTH,
} from '../../cam3d/fixtures';

// Block extents referenced by the grid math (the fixture's block footprint).
const DRAFT_DOME_BLOCK_X = 90;
const DRAFT_DOME_BLOCK_Y = 60;

// Accumulate over the (large heightfield) mesh in plain loops and assert ONCE
// per invariant -- a per-element expect() over ~97k triangles is slow enough to
// trip the default test timeout under parallel load.
function assertMeshValid(mesh: PartMesh): void {
  expect(mesh.source).toBe('fixture');
  expect(mesh.positions.length % 3).toBe(0);
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.length).toBeGreaterThan(0);

  let allFinite = true;
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i])) { allFinite = false; break; }
  }
  expect(allFinite).toBe(true);

  const vertexCount = mesh.positions.length / 3;
  let maxIndex = -1;
  for (let i = 0; i < mesh.indices.length; i++) {
    if (mesh.indices[i] > maxIndex) maxIndex = mesh.indices[i];
  }
  expect(maxIndex).toBeLessThan(vertexCount);
  expect(maxIndex).toBeGreaterThanOrEqual(0);

  // Smallest triangle area over the whole mesh (no zero-area / degenerate tris).
  let minCross = Infinity;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t] * 3, ib = mesh.indices[t + 1] * 3, ic = mesh.indices[t + 2] * 3;
    const ux = mesh.positions[ib] - mesh.positions[ia];
    const uy = mesh.positions[ib + 1] - mesh.positions[ia + 1];
    const uz = mesh.positions[ib + 2] - mesh.positions[ia + 2];
    const vx = mesh.positions[ic] - mesh.positions[ia];
    const vy = mesh.positions[ic + 1] - mesh.positions[ia + 1];
    const vz = mesh.positions[ic + 2] - mesh.positions[ia + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const mag = Math.hypot(cx, cy, cz);
    if (mag < minCross) minCross = mag;
  }
  expect(minCross).toBeGreaterThan(1e-9);
}

describe('draftDomePocket fixture', () => {
  const mesh = draftDomePocket();

  it('is a valid mesh (finite, in-range, no degenerate tris)', () => {
    assertMeshValid(mesh);
  });

  it('has the exact surface bounds x[0,90] y[0,60] z[4,16]', () => {
    expect(mesh.bounds.min[0]).toBeCloseTo(0, 5);
    expect(mesh.bounds.min[1]).toBeCloseTo(0, 5);
    expect(mesh.bounds.min[2]).toBeCloseTo(4, 5); // pocket floor (sheet low)
    expect(mesh.bounds.max[0]).toBeCloseTo(90, 5);
    expect(mesh.bounds.max[1]).toBeCloseTo(60, 5);
    expect(mesh.bounds.max[2]).toBeCloseTo(16, 5); // block top / dome apex
  });

  it('is deterministic: byte-identical across two calls', () => {
    const a = draftDomePocket();
    const b = draftDomePocket();
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
  });

  it('analytic helpers: dome disc/volume, floor 2360, top opening ~3418.5 mm^2', () => {
    expect(DRAFT_DOME_DEPTH).toBe(12);
    // Dome cross-section radius: sqrt(R^2 - h^2). 3-4-5 at h=... R=12.
    expect(domeDiscRadiusAt(0)).toBeCloseTo(12, 6);        // rim
    expect(domeDiscRadiusAt(DRAFT_DOME_RADIUS)).toBeCloseTo(0, 6); // apex
    expect(domeDiscRadiusAt(12 * 0.8)).toBeCloseTo(12 * 0.6, 6);   // 6-8-10
    expect(draftDomeVolume()).toBeCloseTo((2 / 3) * Math.PI * 12 ** 3, 6);
    // Floor footprint identical to the prismatic engagement pocket.
    expect(draftDomeFloorFootprintArea()).toBeCloseTo(2360, 6);
    // Top opening = Minkowski(H outline, disc g), g = 12*tan(15deg).
    const g = 12 * Math.tan((15 * Math.PI) / 180);
    const expected = 2460 + 288 * g + Math.PI * g * g;
    expect(draftDomeTopOpeningArea()).toBeCloseTo(expected, 6);
    expect(expected).toBeGreaterThan(3410);
    expect(expected).toBeLessThan(3425);
  });

  it('drop-grid: dome apex ~16 with sqrt falloff, floor min ~4, continuum of wall z', async () => {
    const kernel = new BvhKernel();
    const m = kernel.uploadMesh(mesh);
    // Tiny flat cutter reads the true surface z per sample. A flat cutter still
    // climbs a curved slope within its radius, so probe the GENTLE part of the
    // dome (plan radii 0/4/8), not the near-vertical rim at r=R.
    const radius = 0.02;
    const c = kernel.makeCutter({ kind: 'flat', diameter: 2 * radius });

    // (a) Dome apex + sqrt falloff along +x from the dome center (65,30):
    //     (65,30) apex r=0, (69,30) r=4, (73,30) r=8.
    const domeGrid: GridSpec = { x0: 65, y0: 30, nx: 3, ny: 1, dx: 4, dy: 1, zSeed: -1 };
    const dz = await kernel.dropGrid(m, c, domeGrid);
    expect(dz[0]).toBeGreaterThan(16 - 0.05);           // apex ~ 16
    expect(dz[0]).toBeLessThanOrEqual(16 + 1e-6);
    // sqrt falloff: z = 4 + sqrt(R^2 - r^2).
    const zR4 = 4 + Math.sqrt(DRAFT_DOME_RADIUS ** 2 - 16); // ~15.314
    const zR8 = 4 + Math.sqrt(DRAFT_DOME_RADIUS ** 2 - 64); // ~12.944
    expect(dz[1]).toBeCloseTo(zR4, 1);
    expect(dz[2]).toBeCloseTo(zR8, 1);
    // Cross-check the analytic disc radius: at those heights the disc radius is
    // the plan radius (4 and 8).
    expect(domeDiscRadiusAt(zR4 - 4)).toBeCloseTo(4, 4);
    expect(domeDiscRadiusAt(zR8 - 4)).toBeCloseTo(8, 4);

    // (b) Full coarse grid: floor minimum ~4, apex ~16, and a CONTINUUM of
    //     intermediate wall/dome z values (unlike the two-level prismatic
    //     fixture). Sample cell centers on a 0.5 mm grid.
    const dx = 0.5, dy = 0.5;
    const nx = DRAFT_DOME_BLOCK_X / dx; // 180
    const ny = DRAFT_DOME_BLOCK_Y / dy; // 120
    const g: GridSpec = { x0: dx / 2, y0: dy / 2, nx, ny, dx, dy, zSeed: -1 };
    const z = await kernel.dropGrid(m, c, g);

    let zmin = Infinity, zmax = -Infinity;
    const intermediate = new Set<number>();
    for (let k = 0; k < z.length; k++) {
      const zz = z[k];
      if (zz < zmin) zmin = zz;
      if (zz > zmax) zmax = zz;
      // Bucket strictly-intermediate z (between floor and top) to 0.25 mm.
      if (zz > 4 + 0.2 && zz < 16 - 0.2) intermediate.add(Math.round(zz * 4) / 4);
    }
    expect(zmin).toBeGreaterThan(4 - 1e-6);
    expect(zmin).toBeLessThan(4 + 0.2);         // floor reached
    expect(zmax).toBeGreaterThan(16 - 0.2);     // top / apex reached
    // Drafted walls + dome produce a rich continuum of intermediate heights;
    // the prismatic engagementPocket would yield ZERO here (only 4 and 16).
    expect(intermediate.size).toBeGreaterThan(10);

    kernel.releaseCutter(c);
    kernel.releaseMesh(m);
  });
});

describe('draftDomeHeight analytic surface', () => {
  it('floor inside the chambers is exactly z=4', () => {
    expect(draftDomeHeight(15, 15)).toBeCloseTo(4, 6); // left chamber floor gap
    expect(draftDomeHeight(60, 45)).toBeCloseTo(4, 6); // right chamber floor
  });
  it('dome center apex is exactly z=16', () => {
    expect(draftDomeHeight(65, 30)).toBeCloseTo(16, 6);
  });
  it('block top well outside the opening is exactly z=16', () => {
    expect(draftDomeHeight(2, 2)).toBeCloseTo(16, 6);
  });
  it('drafted wall ramps linearly outward from the floor edge', () => {
    // Just outside the left-chamber wall at x=10, walking into the solid: z
    // rises by 1/tan(15deg) per mm until it caps at 16.
    const tan15 = Math.tan((15 * Math.PI) / 180);
    // 1 mm into the solid (x=9, y=30): z = 4 + 1/tan15.
    expect(draftDomeHeight(9, 30)).toBeCloseTo(4 + 1 / tan15, 4);
  });
  it('island post rises toward its interior (frustum)', () => {
    // Island base x[20,30] y[25,35]; center (25,30) is deepest -> flat top 16.
    expect(draftDomeHeight(25, 30)).toBeCloseTo(16, 6);
    // Just inside the base edge (x=21, y=30): z = 4 + 1/tan15.
    const tan15 = Math.tan((15 * Math.PI) / 180);
    expect(draftDomeHeight(21, 30)).toBeCloseTo(4 + 1 / tan15, 4);
  });
});
