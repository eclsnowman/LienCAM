// cam3d gate P1: fillet-region drop heights on a box-with-fillet must land
// within 2x the tessellation deflection of the analytic fillet surface.
//
// Fixture: fix_fillet_box.step (untracked, Sample Parts) -- box 40 x 30 x 15
// mm at the origin with the four TOP edges filleted at R = 4 mm. Generated
// with the same OCP (Open CASCADE 7.9) pipeline as the other fix_*.step
// fixtures: 10 faces = 6 planes + 4 quarter-cylinder fillets (equal-radius
// corners are trimmed cylinder-to-cylinder, no sphere patches). The whole
// suite skips cleanly when the fixture file is absent and activates the day
// it appears.
//
// Analytic truth (local coords, box min corner at the origin):
// - The two LONG top-edge fillets are convex quarter cylinders, radius
//   R_F = 4, axes along X at height Z_AXIS = 15 - 4 = 11, offset 4 mm
//   inboard from the side faces: front axis y = 4, back axis y = 26.
// - BALL cutter r = 3 over a convex cylinder: the ball-center surface is the
//   surface offset by r, so with d = horizontal distance from the grid point
//   to the fillet axis, tip z = Z_AXIS + sqrt((R_F + r)^2 - d^2) - r.
//   Validity window: at d = 0 the formula equals the flat top (15, smooth
//   tangency); the contact point leaves the quarter arc at d = R_F + r = 7
//   (contact reaches the wall-tangent line). Tessellation error amplifies by
//   (R_F + r) / sqrt((R_F + r)^2 - d^2), so samples stay in d in
//   [1.25, 5.5] where the factor is <= 1.62 < 2 -- the 2x-deflection gate
//   bound then covers the worst chord sag with margin.
// - FLAT cutter r = 3: contact z = max of surface height under the disk
//   footprint. With the rim's innermost point at horizontal distance
//   h = d - r from the axis (d > r, footprint fully off the flat top),
//   tip z = Z_AXIS + sqrt(R_F^2 - h^2); when the footprint reaches the flat
//   top (d <= r + margin toward the interior) tip z = 15 exactly.
//   Samples keep h in [0.5, 3.0] (amplification <= 1.52).
// - Strips run x in [8, 32]: corner blends live within ~R_F = 4 of the box
//   ends and the d6 footprint adds 3, so 8 mm of margin keeps every sample
//   on prismatic fillet geometry.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from '../../lib/cam/geometry/occt/model/loader';
import {
  _resetStepImportCacheForTest,
  importStepToPartMesh,
  makeOcctCoreTessellator,
} from '../../cam3d/input';
import type { PartImportResult } from '../../cam3d/input';
import type { StepTessellator } from '../../cam3d/input';
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { GridSpec } from '../../cam3d/kernel/types';

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the
// ESM test runtime lacks them (same shim as inputStep.test.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm');

const FIXTURE = 'fix_fillet_box.step';

/** Skip-if-absent: resolve the untracked fixture, null when it is missing. */
function tryResolveFixture(): string | null {
  try {
    const p = resolveSamplePartPath(FIXTURE);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const fixturePath = tryResolveFixture();
if (fixturePath === null) {
  // eslint-disable-next-line no-console
  console.warn(
    `gate P1 (fillet region): SKIPPED -- ${FIXTURE} not found in either Sample Parts ` +
      `folder. Regenerate it (OCP script: box 40x30x15, top edges filleted R4) or ` +
      `export it from CAD; the gate activates as soon as the file exists.`,
  );
}

// ---- fixture geometry constants (mm, local coords: box min corner at 0) ----
const SX = 40;
const SY = 30;
const SZ = 15;
const R_F = 4; // fillet radius
const Z_AXIS = SZ - R_F; // 11
const Y_AXIS_FRONT = R_F; // 4
const Y_AXIS_BACK = SY - R_F; // 26
const R_BALL = 3; // d6 ball
const R_FLAT = 3; // d6 flat

// ---- sampling grid: x strips along both long edges plus interior control ----
// x: 25 columns over [8, 32]. y: 137 rows over [-2, 32] at 0.25 pitch; each
// row is classified as front-fillet / back-fillet / flat control / ignored by
// its exact local y (multiples of 0.25 are exact in binary).
const NX = 25;
const X0L = 8;
const DXG = 1;
const NY = 137;
const Y0L = -2;
const DYG = 0.25;

type Classified = { iy: number; yl: number; d: number };

/** Rows where the BALL contact is clearly interior on a long-edge fillet. */
function ballFilletRows(): Classified[] {
  const rows: Classified[] = [];
  for (let iy = 0; iy < NY; iy++) {
    const yl = Y0L + iy * DYG;
    for (const d of [Y_AXIS_FRONT - yl, yl - Y_AXIS_BACK]) {
      if (d >= 1.25 - 1e-9 && d <= 5.5 + 1e-9) rows.push({ iy, yl, d });
    }
  }
  return rows;
}

/** Rows fully over the flat top for the given cutter (control strip). */
function flatTopControlRows(reach: number): Classified[] {
  // BALL contacts the flat top exactly under its center, so any
  // yl in [Y_AXIS_FRONT, Y_AXIS_BACK] reads 15; FLAT reads 15 while the rim
  // still overlaps the flat top (reach = R_FLAT). A quarter-step of margin
  // keeps the classification away from the exact transition.
  const lo = Y_AXIS_FRONT - reach + 0.25;
  const hi = Y_AXIS_BACK + reach - 0.25;
  const rows: Classified[] = [];
  for (let iy = 0; iy < NY; iy++) {
    const yl = Y0L + iy * DYG;
    if (yl >= lo - 1e-9 && yl <= hi + 1e-9) rows.push({ iy, yl, d: 0 });
  }
  return rows;
}

/** Rows where the FLAT cutter's rim contact is clearly interior on a fillet. */
function flatFilletRows(): Classified[] {
  const rows: Classified[] = [];
  for (let iy = 0; iy < NY; iy++) {
    const yl = Y0L + iy * DYG;
    // h = horizontal distance from the fillet axis to the rim's innermost
    // point; d here stores h.
    for (const h of [Y_AXIS_FRONT - yl - R_FLAT, yl - Y_AXIS_BACK - R_FLAT]) {
      if (h >= 0.5 - 1e-9 && h <= 3.0 + 1e-9) rows.push({ iy, yl, d: h });
    }
  }
  return rows;
}

describe.skipIf(fixturePath === null)('gate P1: fillet-region drop heights (fix_fillet_box)', () => {
  let oc: OcctModelModule;
  let tessellator: StepTessellator;
  let imported: PartImportResult;
  let defl: number; // effective tessellation deflection, mm
  let origin: [number, number, number]; // box min corner (world)
  let grid: GridSpec;
  let zBall: Float64Array;
  let zFlat: Float64Array;

  beforeAll(async () => {
    _resetOcctModelForTest();
    oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
    tessellator = makeOcctCoreTessellator(oc);
    _resetStepImportCacheForTest();

    const buf = readFileSync(fixturePath!);
    const bytes = new ArrayBuffer(buf.byteLength);
    new Uint8Array(bytes).set(buf);
    imported = await importStepToPartMesh(bytes, {
      camTolerance: 0.04, // -> 0.01 mm linear deflection, far under budget
      tessellator,
    });
    defl = imported.effectiveDeflectionMm!;

    const { min, max } = imported.mesh.bounds;
    origin = [min[0], min[1], min[2]];
    // Fail loud in plain terms if the fixture is not the specified box: the
    // analytic truth below is only valid for the exact 40 x 30 x 15 / R4
    // geometry.
    for (const [axis, size] of [[0, SX], [1, SY], [2, SZ]] as const) {
      const actual = max[axis] - min[axis];
      if (Math.abs(actual - size) > 0.01) {
        throw new Error(
          `fix_fillet_box.step does not match the gate spec: axis ${axis} measures ` +
            `${actual.toFixed(4)} mm, expected ${size} mm. The fixture must be a ` +
            `40 x 30 x 15 mm box (x by y by z) with the four top edges filleted at R4.`,
        );
      }
    }

    grid = {
      x0: origin[0] + X0L,
      y0: origin[1] + Y0L,
      nx: NX,
      ny: NY,
      dx: DXG,
      dy: DYG,
      zSeed: origin[2], // table level: well below every sampled contact
    };

    const kernel = new BvhKernel();
    const m = kernel.uploadMesh(imported.mesh);
    const ball = kernel.makeCutter({ kind: 'ball', diameter: 2 * R_BALL });
    const flat = kernel.makeCutter({ kind: 'flat', diameter: 2 * R_FLAT });
    try {
      zBall = await kernel.dropGrid(m, ball, grid);
      zFlat = await kernel.dropGrid(m, flat, grid);
    } finally {
      kernel.releaseCutter(ball);
      kernel.releaseCutter(flat);
      kernel.releaseMesh(m);
    }
  }, 120000);

  it('imports with a deterministic deflection and a plausibly-curved mesh', () => {
    expect(defl).toBe(0.01); // camTolerance/4, uncoarsened
    expect(imported.warnings.filter((w) => /coarsening/.test(w))).toEqual([]);
    // Curved fillet strips force far more triangles than a plain box's 12.
    expect(imported.triangleCount).toBeGreaterThan(100);
    // Box = 6 faces; the fillets must add cylindrical faces on top of that.
    const faceIds = imported.mesh.faceIds!;
    let maxFaceId = 0;
    for (let i = 0; i < faceIds.length; i++) if (faceIds[i] > maxFaceId) maxFaceId = faceIds[i];
    expect(maxFaceId + 1).toBeGreaterThanOrEqual(7);
    // eslint-disable-next-line no-console
    console.log(
      `fix_fillet_box: ${imported.triangleCount} triangles, ${maxFaceId + 1} faces, ` +
        `deflection ${defl} mm`,
    );
  });

  it('ball d6 over the flat-top control strip reads exactly the top plane', () => {
    const rows = flatTopControlRows(0);
    expect(rows.length).toBeGreaterThan(10);
    let maxErr = 0;
    for (const { iy } of rows) {
      for (let ix = 0; ix < NX; ix++) {
        const err = Math.abs(zBall[iy * NX + ix] - (origin[2] + SZ));
        if (err > maxErr) maxErr = err;
      }
    }
    // The top face is planar: tessellated exactly, so the control error is
    // pure arithmetic noise, far inside the fillet gate bound.
    expect(maxErr).toBeLessThanOrEqual(1e-6);
    // eslint-disable-next-line no-console
    console.log(`ball flat-top control max |err| = ${maxErr.toExponential(3)}`);
  });

  it('GATE: ball d6 fillet drops within 2x deflection of the analytic quarter-cylinder', () => {
    const rows = ballFilletRows();
    expect(rows.length).toBeGreaterThan(20); // both edges sampled
    const bound = 2 * defl;
    let maxErr = 0;
    for (const { iy, d } of rows) {
      const analytic =
        origin[2] + Z_AXIS + Math.sqrt((R_F + R_BALL) ** 2 - d * d) - R_BALL;
      for (let ix = 0; ix < NX; ix++) {
        const err = Math.abs(zBall[iy * NX + ix] - analytic);
        if (err > maxErr) maxErr = err;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `GATE ball fillet: max |dropZ - analytic| = ${maxErr.toExponential(3)} mm ` +
        `vs bound ${bound} mm (${rows.length} rows x ${NX} cols)`,
    );
    expect(maxErr).toBeLessThanOrEqual(bound);
  });

  it('flat d6: control strip exact, rim-on-fillet within 2x deflection, monotone toward the edge', () => {
    // Control: while the disk footprint overlaps the flat top, tip z = 15.
    const control = flatTopControlRows(R_FLAT);
    expect(control.length).toBeGreaterThan(10);
    let maxCtl = 0;
    for (const { iy } of control) {
      for (let ix = 0; ix < NX; ix++) {
        const err = Math.abs(zFlat[iy * NX + ix] - (origin[2] + SZ));
        if (err > maxCtl) maxCtl = err;
      }
    }
    expect(maxCtl).toBeLessThanOrEqual(1e-6);

    // Rim contact on the fillet: tip z = Z_AXIS + sqrt(R_F^2 - h^2) with the
    // rim's innermost point at distance h from the axis (simple exact form,
    // asserted at the same 2x-deflection bound as the ball gate).
    const rows = flatFilletRows();
    expect(rows.length).toBeGreaterThan(10);
    let maxErr = 0;
    for (const { iy, d: h } of rows) {
      const analytic = origin[2] + Z_AXIS + Math.sqrt(R_F * R_F - h * h);
      for (let ix = 0; ix < NX; ix++) {
        const err = Math.abs(zFlat[iy * NX + ix] - analytic);
        if (err > maxErr) maxErr = err;
        // Ball-independent lower bound: contact never drops below the fillet
        // tangent line at the wall (z = Z_AXIS) for these interior samples.
        expect(zFlat[iy * NX + ix]).toBeGreaterThanOrEqual(origin[2] + Z_AXIS - defl);
      }
    }
    expect(maxErr).toBeLessThanOrEqual(2 * defl);

    // Monotonicity: walking outward across each long edge (increasing d),
    // heights never increase (small epsilon for arithmetic noise).
    for (let ix = 0; ix < NX; ix++) {
      // front edge: yl descending from 4 to -2 means iy descending.
      for (let iy = Math.round((4 - Y0L) / DYG); iy > 0; iy--) {
        expect(zFlat[(iy - 1) * NX + ix]).toBeLessThanOrEqual(zFlat[iy * NX + ix] + 1e-9);
      }
      // back edge: yl ascending from 26 to 32.
      for (let iy = Math.round((26 - Y0L) / DYG); iy < NY - 1; iy++) {
        expect(zFlat[(iy + 1) * NX + ix]).toBeLessThanOrEqual(zFlat[iy * NX + ix] + 1e-9);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `flat: control max |err| = ${maxCtl.toExponential(3)}, ` +
        `fillet max |err| = ${maxErr.toExponential(3)} (bound ${2 * defl})`,
    );
  });

  it('determinism: a second import + dropGrid run is byte-identical', async () => {
    // Force a genuine re-import (the importer caches by content+options).
    _resetStepImportCacheForTest();
    const buf = readFileSync(fixturePath!);
    const bytes = new ArrayBuffer(buf.byteLength);
    new Uint8Array(bytes).set(buf);
    const second = await importStepToPartMesh(bytes, {
      camTolerance: 0.04,
      tessellator,
    });
    expect(second.mesh.positions.length).toBe(imported.mesh.positions.length);
    for (let i = 0; i < second.mesh.positions.length; i++) {
      if (!Object.is(second.mesh.positions[i], imported.mesh.positions[i])) {
        throw new Error(`re-import positions differ at ${i}`);
      }
    }
    expect(second.mesh.indices).toEqual(imported.mesh.indices);

    const kernel = new BvhKernel();
    const m = kernel.uploadMesh(second.mesh);
    const ball = kernel.makeCutter({ kind: 'ball', diameter: 2 * R_BALL });
    try {
      const again = await kernel.dropGrid(m, ball, grid);
      expect(again.length).toBe(zBall.length);
      for (let i = 0; i < again.length; i++) {
        if (!Object.is(again[i], zBall[i])) {
          throw new Error(`dropGrid determinism violated at ${i}: ${again[i]} vs ${zBall[i]}`);
        }
      }
    } finally {
      kernel.releaseCutter(ball);
      kernel.releaseMesh(m);
    }
  }, 120000);
});
