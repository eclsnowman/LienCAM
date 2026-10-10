// cam3d M2 engagement-fixture validity + analytic-truth tests.
//
// Covers the engagement-torture fixture (engagementPocket) and the hemisphere
// analytic helpers used by the future 3D adaptive-rougher gate:
//   - mesh validity (finite coords, in-range indices, no degenerate tris),
//   - exact bounds x[0,90] y[0,60] z[0,16],
//   - determinism (byte-identical across two calls, D-006),
//   - a top-down drop-grid recovers the expected z-levels (block top 16,
//     pocket floor 4, island top 16) and the pocket-vs-solid AREA matches the
//     analytic footprint within tolerance,
//   - the analytic helpers return the closed-form footprint area / removed
//     volume, and the hemisphere disc-radius / volume math.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { GridSpec, PartMesh } from '../../cam3d/kernel/types';
import {
  engagementPocket,
  engagementPocketFootprintArea,
  engagementPocketRemovedVolume,
  ENGAGEMENT_POCKET_DEPTH,
  hemisphereOnSlab,
  hemisphereDiscRadiusAt,
  hemisphereVolume,
} from '../../cam3d/fixtures';

function assertMeshValid(mesh: PartMesh): void {
  expect(mesh.source).toBe('fixture');
  expect(mesh.positions.length % 3).toBe(0);
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.length).toBeGreaterThan(0);
  for (let i = 0; i < mesh.positions.length; i++) {
    expect(Number.isFinite(mesh.positions[i])).toBe(true);
  }
  const vertexCount = mesh.positions.length / 3;
  for (let i = 0; i < mesh.indices.length; i++) {
    expect(mesh.indices[i]).toBeLessThan(vertexCount);
  }
  // No degenerate (zero-area) triangles.
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const ia = mesh.indices[t] * 3, ib = mesh.indices[t + 1] * 3, ic = mesh.indices[t + 2] * 3;
    const ux = mesh.positions[ib] - mesh.positions[ia];
    const uy = mesh.positions[ib + 1] - mesh.positions[ia + 1];
    const uz = mesh.positions[ib + 2] - mesh.positions[ia + 2];
    const vx = mesh.positions[ic] - mesh.positions[ia];
    const vy = mesh.positions[ic + 1] - mesh.positions[ia + 1];
    const vz = mesh.positions[ic + 2] - mesh.positions[ia + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    expect(Math.hypot(cx, cy, cz)).toBeGreaterThan(1e-9);
  }
}

describe('engagementPocket fixture', () => {
  const mesh = engagementPocket();

  it('is a valid mesh (finite, in-range, no degenerate tris)', () => {
    assertMeshValid(mesh);
  });

  it('has the exact block bounds x[0,90] y[0,60] z[0,16]', () => {
    expect(mesh.bounds.min).toEqual([0, 0, 0]);
    expect(mesh.bounds.max).toEqual([90, 60, 16]);
  });

  it('is deterministic: byte-identical across two calls', () => {
    const a = engagementPocket();
    const b = engagementPocket();
    expect(a.positions).toEqual(b.positions);
    expect(a.indices).toEqual(b.indices);
  });

  it('analytic footprint area = 2360 mm^2 and removed volume = 28320 mm^3', () => {
    expect(engagementPocketFootprintArea()).toBeCloseTo(2360, 6);
    expect(ENGAGEMENT_POCKET_DEPTH).toBe(12);
    expect(engagementPocketRemovedVolume()).toBeCloseTo(28320, 6);
  });

  it('drop-grid recovers z-levels (top 16, floor 4, island top 16) and area matches footprint', async () => {
    const kernel = new BvhKernel();
    const m = kernel.uploadMesh(mesh);
    // Near-point flat cutter: reads the true surface z per sample. A flat
    // cutter still climbs any wall within its radius, so the recovered FLOOR
    // region is the pocket eroded by `radius` -- a tiny radius keeps that
    // erosion small and analytically bounded (see the area tolerance below).
    const radius = 0.05;
    const c = kernel.makeCutter({ kind: 'flat', diameter: 2 * radius });
    // Sample cell centers on a 0.25 mm grid over the block (avoids landing
    // exactly on feature edges).
    const dx = 0.25, dy = 0.25;
    const nx = 90 / dx; // 360
    const ny = 60 / dy; // 240
    const g: GridSpec = { x0: dx / 2, y0: dy / 2, nx, ny, dx, dy, zSeed: -1 };
    const z = await kernel.dropGrid(m, c, g);

    // Every sample is at the block top (16), the pocket floor (4), or the
    // zSeed miss (never, since the block spans the whole grid).
    let topCount = 0, floorCount = 0, islandCount = 0, other = 0;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const zz = z[iy * nx + ix];
        if (Math.abs(zz - 16) < 1e-6) topCount++;
        else if (Math.abs(zz - 4) < 1e-6) floorCount++;
        else other++;
        // Island footprint: x[20,30] y[25,35] should read the top (16).
        const x = g.x0 + ix * dx, y = g.y0 + iy * dy;
        if (x > 20 && x < 30 && y > 25 && y < 35) {
          islandCount++;
          expect(Math.abs(zz - 16)).toBeLessThan(1e-6);
        }
      }
    }
    expect(other).toBe(0); // only two z-levels exist over the block
    expect(islandCount).toBeGreaterThan(0);

    // Pocket-vs-solid area from the sample count vs the analytic footprint.
    const cellArea = dx * dy;
    const measuredPocketArea = floorCount * cellArea;
    // Physically-derived band. The recovered floor is the pocket eroded by the
    // cutter radius, so measured <= analytic; the deficit is ~ perimeter *
    // radius (pocket perimeter = outer-H 288 + island 40 = 328 mm), plus
    // grid-quantization noise (~ perimeter * cell). Analytic footprint = 2360.
    const perimeter = 328;
    const erosion = perimeter * radius;      // ~16.4 mm^2
    const quant = perimeter * dx;            // ~82 mm^2 (generous, unbiased)
    // eslint-disable-next-line no-console
    console.log(`[engagement] measured pocket area ${measuredPocketArea.toFixed(1)} mm^2 (analytic 2360, erosion ~${erosion.toFixed(0)})`);
    expect(measuredPocketArea).toBeGreaterThan(2360 - erosion - quant);
    expect(measuredPocketArea).toBeLessThan(2360 + quant);
    // Sanity: the two levels cover the whole grid.
    expect(topCount + floorCount).toBe(nx * ny);

    kernel.releaseCutter(c);
    kernel.releaseMesh(m);
  });
});

describe('hemisphere analytic helpers', () => {
  it('hemisphereOnSlab is a valid mesh with the dome above the slab top', () => {
    const mesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    assertMeshValid(mesh);
    // Slab top at z=10, dome pole at z=10+20=30.
    expect(mesh.bounds.max[2]).toBeCloseTo(30, 6);
  });

  it('hemisphereDiscRadiusAt gives sqrt(r^2 - h^2) and clamps past the pole', () => {
    const r = 20;
    expect(hemisphereDiscRadiusAt(r, 0)).toBeCloseTo(20, 6); // rim
    expect(hemisphereDiscRadiusAt(r, 12)).toBeCloseTo(16, 6); // 3-4-5: sqrt(400-144)=16
    expect(hemisphereDiscRadiusAt(r, 20)).toBeCloseTo(0, 6); // pole
    expect(hemisphereDiscRadiusAt(r, 25)).toBe(0); // above the pole -> clamped
  });

  it('hemisphereVolume = (2/3) pi r^3', () => {
    expect(hemisphereVolume(20)).toBeCloseTo((2 / 3) * Math.PI * 8000, 6);
  });
});
