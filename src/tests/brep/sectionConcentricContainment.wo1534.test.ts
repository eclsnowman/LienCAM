// WO-1534: sectionAtPlane's containment/depth computation must never count a
// loop as "inside" a same-or-smaller-area loop -- otherwise a hole centered on
// the block's own centroid (the ordinary case) makes the outer loop's centroid
// read as "inside" the tiny hole too, and BOTH loops come out 'hole'
// (BUG-452). test_fixtures/brep/fix_single_hole_block.step is exactly that
// case: a 40x20x20 block (centroid at (20,10)) with one blind hole d6 at
// (20,10), floor z=12 -- axis coincides with the block's own centroid.
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
import type { DerivedLoop } from "../../lib/cam/geometry/occt/model/types";
import type { TopoDS_Shape } from "../../lib/cam/geometry/occt/model/vendor/occt-model.js";

const here = dirname(fileURLToPath(import.meta.url));
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, "../../lib/cam/geometry/occt/model/vendor/occt-model.wasm");
const fixtureDir = join(here, "../../../test_fixtures/brep");

let oc: OcctModelModule;
let shape: TopoDS_Shape;

function bbox(loop: DerivedLoop): { dx: number; dy: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { dx: maxX - minX, dy: maxY - minY };
}

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  const bytes = readFileSync(join(fixtureDir, "fix_single_hole_block.step"));
  shape = readStepShape(oc, bytes, "fix_single_hole_block.step").shape;
}, 120000);

afterAll(() => {
  shape?.delete();
});

describe("sectionAtPlane concentric containment (WO-1534 / BUG-452)", () => {
  it("z=16 (through the hole, blind floor at z=12): outer 40x20 is 'contour', d6 ring is 'hole'", () => {
    const { loops } = sectionAtZ(oc, shape, 16);
    const closed = loops.filter((l) => l.closed);
    expect(closed.length).toBe(2);

    const outer = closed.find((l) => bbox(l).dx > 30)!;
    const inner = closed.find((l) => bbox(l).dx < 10)!;
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();

    expect(outer.type).toBe("contour");
    expect(inner.type).toBe("hole");

    const ob = bbox(outer);
    expect(Math.abs(ob.dx - 40)).toBeLessThan(0.1);
    expect(Math.abs(ob.dy - 20)).toBeLessThan(0.1);
    const ib = bbox(inner);
    expect(Math.abs(ib.dx - 6)).toBeLessThan(0.1);
    expect(Math.abs(ib.dy - 6)).toBeLessThan(0.1);
  }, 30000);

  it("z=8 (below the hole's floor): single solid 40x20 outer loop, no hole", () => {
    const { loops } = sectionAtZ(oc, shape, 8);
    const closed = loops.filter((l) => l.closed);
    expect(closed.length).toBe(1);
    expect(closed[0].type).toBe("contour");
    const b = bbox(closed[0]);
    expect(Math.abs(b.dx - 40)).toBeLessThan(0.1);
    expect(Math.abs(b.dy - 20)).toBeLessThan(0.1);
  }, 30000);
});
