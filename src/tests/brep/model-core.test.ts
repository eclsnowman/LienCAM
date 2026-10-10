// Stage 1 model worker core tests (vitest, Node): drives core.ts directly with the
// loaded oc module -- no Worker involved -- against the canonical STEP fixtures
// (expected counts: test_fixtures/brep/README.md). Asserts the BrepModelPayload
// shape contract from types.ts and the ADR 0018 D3 determinism guarantee.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from "../../lib/cam/geometry/occt/model/loader";
import { buildModelPayload } from "../../lib/cam/geometry/occt/model/core";
import type { BrepModelPayload } from "../../lib/cam/geometry/occt/model/types";

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the ESM test
// runtime lacks them. The browser worker takes the ENVIRONMENT_IS_WEB branch instead.
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, "../../lib/cam/geometry/occt/model/vendor/occt-model.wasm");
const fixtureDir = join(here, "../../../test_fixtures/brep");

let oc: OcctModelModule;

/** Embind enums are singleton objects; the numeric lives at `.value`. */
const enumNumeric = (e: unknown): number => (e as { value: number }).value;

/** Build the payload for a fixture and free the shape (these tests are payload-only). */
function buildPayload(file: string): BrepModelPayload {
  const bytes = readFileSync(join(fixtureDir, file));
  const { payload, shape } = buildModelPayload(oc, bytes, file);
  shape.delete();
  return payload;
}

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
}, 60000);

describe("model worker core (Stage 1)", () => {
  it("plate_holes: counts, faceRanges, buffer invariants, 6 cylinders, exact bbox", () => {
    const payload = buildPayload("fix_plate_holes.step");

    expect(payload.faceCount).toBe(12);
    expect(payload.edgeCount).toBe(30);
    expect(payload.solidCount).toBe(1);

    const { positions, normals, indices, faceRanges } = payload.mesh;
    expect(faceRanges.length).toBe(24);
    let rangeSum = 0;
    for (let i = 0; i < payload.faceCount; i++) {
      expect(faceRanges[2 * i + 1], `face ${i} index count`).toBeGreaterThan(0);
      rangeSum += faceRanges[2 * i + 1];
    }
    expect(indices.length).toBe(rangeSum);
    expect(positions.length % 3).toBe(0);
    expect(normals.length).toBe(positions.length);

    const cylinderValue = enumNumeric(oc.GeomAbs_SurfaceType.GeomAbs_Cylinder);
    const cylinders = Array.from(payload.faceTypes).filter((t) => t === cylinderValue);
    expect(cylinders.length).toBe(6);

    const expected = { min: [0, 0, 0], max: [100, 60, 10] };
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(payload.bbox.min[k] - expected.min[k]), `bbox min axis ${k}`).toBeLessThan(1e-6);
      expect(Math.abs(payload.bbox.max[k] - expected.max[k]), `bbox max axis ${k}`).toBeLessThan(1e-6);
    }

    // eslint-disable-next-line no-console
    console.log(
      `plate_holes: ${positions.length / 3} vertices, ${indices.length / 3} triangles`,
    );
  }, 30000);

  it("block_pocket: 20 faces, triangles present, 48 edge polylines each >= 2 points", () => {
    const payload = buildPayload("fix_block_pocket.step");

    expect(payload.faceCount).toBe(20);
    expect(payload.mesh.indices.length / 3).toBeGreaterThan(0);

    const { positions, edgeRanges } = payload.edges;
    expect(edgeRanges.length).toBe(96); // 48 edges x 2
    let pointSum = 0;
    for (let i = 0; i < payload.edgeCount; i++) {
      expect(edgeRanges[2 * i + 1], `edge ${i} point count`).toBeGreaterThanOrEqual(2);
      pointSum += edgeRanges[2 * i + 1];
    }
    expect(positions.length).toBe(pointSum * 3);

    // eslint-disable-next-line no-console
    console.log(
      `block_pocket: ${payload.mesh.positions.length / 3} vertices, ` +
        `${payload.mesh.indices.length / 3} triangles, ${pointSum} edge points`,
    );
  }, 30000);

  it("freeform: at least one face is neither Plane nor Cylinder", () => {
    const payload = buildPayload("fix_freeform.step");
    const planeValue = enumNumeric(oc.GeomAbs_SurfaceType.GeomAbs_Plane);
    const cylinderValue = enumNumeric(oc.GeomAbs_SurfaceType.GeomAbs_Cylinder);
    const exotic = Array.from(payload.faceTypes).filter(
      (t) => t !== planeValue && t !== cylinderValue,
    );
    expect(exotic.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("determinism: two builds of plate_holes agree on faceTypes, bbox and faceRanges (D3)", () => {
    const a = buildPayload("fix_plate_holes.step");
    const b = buildPayload("fix_plate_holes.step");
    expect(Array.from(a.faceTypes)).toEqual(Array.from(b.faceTypes));
    expect(a.bbox).toEqual(b.bbox);
    expect(Array.from(a.mesh.faceRanges)).toEqual(Array.from(b.mesh.faceRanges));
  }, 60000);
});
