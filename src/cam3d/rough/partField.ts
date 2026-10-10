// cam3d rough: build the part's top-surface heightfield as a ZDexelField.
//
// The rougher needs the part cross-section at each Z level. That comes from a
// per-column top-of-part heightfield sampled through the L2 GeometryKernel
// (never the mesh internals -- strict layering, architecture doc section 3):
// a TINY flat probe is dropped over the frame's column CENTERS, so each sample
// is essentially a point read of the part's top surface at that (x, y).
//
// Point-sized probe (not cell-sized) on purpose: a finite-radius flat disk
// takes the MAX contact over its footprint, so near a vertical wall a disk
// centred over the pocket floor would catch the wall top and read too high --
// eroding the cut region by the probe radius. A near-point probe reads the
// surface directly under the center, so part / stock sections share one grid
// and their boolean difference is clean and un-biased. Adaptive retains this
// point field for depth evidence and builds a separate explicit-probe safety
// field only when exact path validation rejects a sampled boundary.
//
// GRID ALIGNMENT (load-bearing): GridSpec sample (ix, iy) lands at world
// (x0 + ix*dx, y0 + iy*dy) with result index iy*nx + ix -- IDENTICAL to
// ZDexelField.colIndex(i, j) = j*nx + i and centerX(i)/centerY(j). So x0/y0 is
// the FIRST SAMPLE POINT (a cell center), NOT a corner: x0 = originX +
// 0.5*cell. dropGrid's row order therefore maps straight onto the field's
// column order with no reindexing.
//
// MISS POLICY: dropGrid returns zSeed where nothing lies under the footprint.
// Choose zSeed BELOW the stock bottom; ZDexelField.fromColumnTops then
// canonicalizes those columns (top <= bottom) to the EMPTY encoding, so "no
// part here" reads as empty stock-to-remove rather than a phantom floor.

import type { CutterSpec, GeometryKernel, GridSpec, MeshHandle } from '../kernel/types';
import { ZDexelField, type GridFrame } from '../stock';

export interface BuildPartHeightFieldOpts {
  /** Probe cutter (default: a near-point flat, diameter = cell * 1e-3). */
  probe?: CutterSpec;
  /** Drop floor / miss value; MUST be below the stock bottom (see header). */
  zSeed: number;
  /** Cooperative cancellation forwarded to the kernel. */
  signal?: AbortSignal;
  /** Optional progress for this one sampling pass. */
  onProgress?: (fraction: number) => void;
}

/**
 * Sample the part top surface over `frame`'s column centers via the kernel and
 * return it as a ZDexelField (uniform bottom = zSeed; miss columns empty).
 * Fails loud on a non-finite drop result (ADR-0003).
 */
export async function buildPartHeightField(
  kernel: GeometryKernel,
  meshHandle: MeshHandle,
  frame: GridFrame,
  opts: BuildPartHeightFieldOpts,
): Promise<ZDexelField> {
  const { zSeed, signal, onProgress } = opts;
  if (!Number.isFinite(zSeed)) {
    throw new Error(`buildPartHeightField: zSeed must be finite, got ${zSeed}.`);
  }
  const spec: CutterSpec = opts.probe ?? {
    kind: 'flat',
    // A near-point probe: small vs the cell so wall tops are not caught over
    // floor columns, but comfortably above zero for the kernel's checks.
    diameter: Math.max(frame.cell * 1e-3, 1e-4),
  };
  const cutter = kernel.makeCutter(spec);
  try {
    const grid: GridSpec = {
      x0: frame.originX + 0.5 * frame.cell, // first sample = column 0 center
      y0: frame.originY + 0.5 * frame.cell,
      nx: frame.nx,
      ny: frame.ny,
      dx: frame.cell,
      dy: frame.cell,
      zSeed,
    };
    const z = await kernel.dropGrid(
      meshHandle,
      cutter,
      grid,
      signal !== undefined || onProgress !== undefined
        ? { ...(signal !== undefined ? { signal } : {}), ...(onProgress !== undefined ? { onProgress } : {}) }
        : undefined,
    );
    // Row order iy*nx+ix already matches colIndex j*nx+i. Pass the kernel's f64
    // samples directly so fromColumnTops can retain an exact maximum coverage
    // witness before narrowing the ordinary display/roughing field to f32.
    for (let c = 0; c < z.length; c++) {
      if (!Number.isFinite(z[c])) {
        throw new Error(`buildPartHeightField: non-finite drop result at column ${c} (${z[c]}).`);
      }
    }
    return ZDexelField.fromColumnTops(frame, z, zSeed);
  } finally {
    kernel.releaseCutter(cutter);
  }
}

/** Derive the ZDexelField's grid frame (for building an aligned part field). */
export function frameOf(field: ZDexelField): GridFrame {
  return {
    originX: field.originX,
    originY: field.originY,
    nx: field.nx,
    ny: field.ny,
    cell: field.cell,
  };
}
