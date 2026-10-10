// Stage 3 derivation-layer tests (docs/brep/PLAN.md Stage 3): planarFaceLoops,
// edgeChainLoops, holeFeatures, sectionAtZ against the canonical STEP fixtures
// (truths in test_fixtures/brep/README.md). Runs the worker-side geometry
// directly in Node, same harness as occt-model-smoke.test.ts.
//
// Winding/type house convention asserted here (matches path2d.ts joinSegments
// and stlProjection.ts): closed contour = CCW (signed area > 0), closed hole =
// CW (signed area < 0), open chain = type 'open', Loop2D.area = |signed area|,
// closed loops do not repeat the first point.
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
import {
  readStepShape,
  indexSubshapes,
} from "../../lib/cam/geometry/occt/model/core";
import {
  planarFaceLoops,
  edgeChainLoops,
  holeFeatures,
  cylinderFeatures,
  prismaticRoughTargetFacts,
  sectionAtZ,
} from "../../lib/cam/geometry/occt/model/derive";
import type { DerivedLoop } from "../../lib/cam/geometry/occt/model/types";
import type { TopoDS_Shape } from "../../lib/cam/geometry/occt/model/vendor/occt-model.js";

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the ESM test
// runtime lacks them (see occt-model-smoke.test.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, "../../lib/cam/geometry/occt/model/vendor/occt-model.wasm");
const fixtureDir = join(here, "../../../test_fixtures/brep");

let oc: OcctModelModule;
const shapes = new Map<string, TopoDS_Shape>();

function shape(file: string): TopoDS_Shape {
  const s = shapes.get(file);
  if (!s) throw new Error(`fixture not loaded: ${file}`);
  return s;
}

// ---- helpers --------------------------------------------------------------

interface FaceInfo {
  index: number;
  typeName: string;
  /** Plane Z when planar with Z-parallel normal, else undefined. */
  planeZ?: number;
}

/** Classify every face: surface type + (for Z-normal planes) the plane Z. */
function classifyFaces(s: TopoDS_Shape): FaceInfo[] {
  const { faces, edges } = indexSubshapes(oc, s);
  const out: FaceInfo[] = [];
  try {
    for (let i = 0; i < faces.length; i++) {
      const surf = new oc.BRepAdaptor_Surface_2(faces[i], true);
      const t = surf.GetType();
      let typeName = "Other";
      if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane) typeName = "Plane";
      else if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) typeName = "Cylinder";
      else if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cone) typeName = "Cone";
      else if (t === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) typeName = "Sphere";
      let planeZ: number | undefined;
      if (typeName === "Plane") {
        const pln = surf.Plane();
        const ax = pln.Axis();
        const dir = ax.Direction();
        const loc = pln.Location();
        if (Math.abs(Math.abs(dir.Z()) - 1) < 1e-6) planeZ = loc.Z();
        loc.delete();
        dir.delete();
        ax.delete();
        pln.delete();
      }
      surf.delete();
      out.push({ index: i, typeName, planeZ });
    }
  } finally {
    for (const f of faces) f.delete();
    for (const e of edges) e.delete();
  }
  return out;
}

function bbox(loop: DerivedLoop): { dx: number; dy: number; min: [number, number]; max: [number, number] } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { dx: maxX - minX, dy: maxY - minY, min: [minX, minY], max: [maxX, maxY] };
}

/** Shoelace signed area (positive = CCW) -- the convention probe. */
function signedArea(loop: DerivedLoop): number {
  let a = 0;
  const pts = loop.points;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

/** Endpoint z of every edge, via its vertices (for picking non-coplanar sets). */
function edgeEndpoints(s: TopoDS_Shape): { index: number; a: [number, number, number]; b: [number, number, number]; degenerated: boolean }[] {
  const { faces, edges } = indexSubshapes(oc, s);
  const out: { index: number; a: [number, number, number]; b: [number, number, number]; degenerated: boolean }[] = [];
  try {
    for (let i = 0; i < edges.length; i++) {
      const degenerated = oc.BRep_Tool.Degenerated(edges[i]);
      const fv = oc.TopExp.FirstVertex(edges[i], true);
      const lv = oc.TopExp.LastVertex(edges[i], true);
      const pa = oc.BRep_Tool.Pnt(fv);
      const pb = oc.BRep_Tool.Pnt(lv);
      out.push({
        index: i,
        a: [pa.X(), pa.Y(), pa.Z()],
        b: [pb.X(), pb.Y(), pb.Z()],
        degenerated,
      });
      pa.delete();
      pb.delete();
      fv.delete();
      lv.delete();
    }
  } finally {
    for (const f of faces) f.delete();
    for (const e of edges) e.delete();
  }
  return out;
}

// ---- harness ---------------------------------------------------------------

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  for (const file of [
    "fix_block_pocket.step",
    "fix_plate_holes.step",
    "fix_boss_taper.step",
    "fix_freeform.step",
    "fix_prismatic_boss.step",
    "fix_two_solids.step",
  ]) {
    const bytes = readFileSync(join(fixtureDir, file));
    shapes.set(file, readStepShape(oc, bytes, file).shape);
  }
}, 120000);

afterAll(() => {
  for (const s of shapes.values()) s.delete();
  shapes.clear();
});

// ---- Smart Height prismatic target classification -------------------------

describe("prismaticRoughTargetFacts", () => {
  it("accepts one deck plus a nested cylindrical boss with complete face accounting", () => {
    const facts = prismaticRoughTargetFacts(oc, shape("fix_prismatic_boss.step"));
    expect(facts.solidCount).toBe(1);
    expect(facts.roughFloorZ).toBeCloseTo(10, 6);
    expect(facts.classification).toMatchObject({
      allFacesClassified: true,
      hasSlopedFaces: false,
      hasUndercuts: false,
      deckLevelsZ: [10],
      unclassifiedFaceIds: [],
    });
    expect(facts.keepOutRegions).toHaveLength(1);
    expect(facts.keepOutRegions[0].targetTopZ).toBeCloseTo(20, 6);
    expect(facts.keepOutRegions[0].loop.closed).toBe(true);
    expect(facts.keepOutRegions[0].loop.type).toBe("contour");
    expect(Math.abs(facts.keepOutRegions[0].loop.area - Math.PI * 8 * 8)).toBeLessThan(1);
  }, 30000);

  it("accepts a flat plate with through holes and does not invent keep-outs", () => {
    const facts = prismaticRoughTargetFacts(oc, shape("fix_plate_holes.step"));
    expect(facts.roughFloorZ).toBeCloseTo(10, 6);
    expect(facts.keepOutRegions).toEqual([]);
    expect(facts.classification.allFacesClassified).toBe(true);
  }, 30000);

  it("refuses a pocket floor because two scalar roughing decks are required", () => {
    const facts = prismaticRoughTargetFacts(oc, shape("fix_block_pocket.step"));
    expect(facts.roughFloorZ).toBeUndefined();
    expect(facts.classification.allFacesClassified).toBe(false);
    expect(facts.classification.deckLevelsZ).toEqual([12, 20]);
    expect(facts.classification.unclassifiedFaceIds).toContain(
      "deck:non-nested-or-complex-higher-region",
    );
  }, 30000);

  it("names tapered/freeform faces and multiple solids instead of approximating them", () => {
    const tapered = prismaticRoughTargetFacts(oc, shape("fix_boss_taper.step"));
    const freeform = prismaticRoughTargetFacts(oc, shape("fix_freeform.step"));
    const multiple = prismaticRoughTargetFacts(oc, shape("fix_two_solids.step"));
    expect(tapered.classification.hasSlopedFaces).toBe(true);
    expect(tapered.classification.allFacesClassified).toBe(false);
    expect(freeform.classification.hasSlopedFaces).toBe(true);
    expect(freeform.classification.allFacesClassified).toBe(false);
    expect(multiple.solidCount).toBe(2);
    expect(multiple.classification.allFacesClassified).toBe(false);
    expect(multiple.classification.unclassifiedFaceIds).toContain("solid-count:2");
  }, 30000);
});

// ---- planarFaceLoops --------------------------------------------------------

describe("planarFaceLoops", () => {
  it("block_pocket floor face: z=12, 50x30 rounded contour + 12x8 island hole", () => {
    const s = shape("fix_block_pocket.step");
    const floorCandidates = classifyFaces(s).filter(
      (f) => f.planeZ !== undefined && Math.abs(f.planeZ - 12) < 1e-6,
    );
    expect(floorCandidates.length).toBe(1); // the pocket floor is the only z=12 plane
    const floorIndex = floorCandidates[0].index;
    // eslint-disable-next-line no-console
    console.log(`floor face index (fix_block_pocket) = ${floorIndex}`);

    const { loops, z } = planarFaceLoops(oc, s, floorIndex);
    expect(Math.abs(z - 12)).toBeLessThan(1e-6);

    const contours = loops.filter((l) => l.type === "contour");
    const holes = loops.filter((l) => l.type === "hole");
    expect(contours.length).toBe(1);
    expect(holes.length).toBe(1);

    const outer = contours[0];
    expect(outer.closed).toBe(true);
    const ob = bbox(outer);
    expect(Math.abs(ob.dx - 50)).toBeLessThan(0.1);
    expect(Math.abs(ob.dy - 30)).toBeLessThan(0.1);
    // 50*30 minus the 4 corner-fillet deficits (4 - pi) * r^2, r = 6.
    const expectedArea = 50 * 30 - (4 - Math.PI) * 36;
    expect(Math.abs(outer.area - expectedArea)).toBeLessThan(1.0);
    // eslint-disable-next-line no-console
    console.log(
      `floor outer: bbox ${ob.dx.toFixed(3)} x ${ob.dy.toFixed(3)}, area ${outer.area.toFixed(2)} (expected ~${expectedArea.toFixed(2)})`,
    );

    const island = holes[0];
    expect(island.closed).toBe(true);
    const ib = bbox(island);
    expect(Math.abs(ib.dx - 12)).toBeLessThan(0.1);
    expect(Math.abs(ib.dy - 8)).toBeLessThan(0.1);
    expect(Math.abs(island.area - 96)).toBeLessThan(0.5);

    // House winding convention: contour CCW (+), hole CW (-).
    expect(signedArea(outer)).toBeGreaterThan(0);
    expect(signedArea(island)).toBeLessThan(0);
    // Closed loops do not repeat the first point.
    const f0 = outer.points[0];
    const fn = outer.points[outer.points.length - 1];
    expect(Math.hypot(f0.x - fn.x, f0.y - fn.y)).toBeGreaterThan(1e-6);
  }, 30000);

  it("block_pocket top face: 80x60 contour + pocket-opening hole; island top is a separate face", () => {
    const s = shape("fix_block_pocket.step");
    const topPlanes = classifyFaces(s).filter(
      (f) => f.planeZ !== undefined && Math.abs(f.planeZ - 20) < 1e-6,
    );
    // Block top AND island top both live at z=20 (island is flush).
    expect(topPlanes.length).toBe(2);

    const results = topPlanes.map((f) => ({
      index: f.index,
      ...planarFaceLoops(oc, s, f.index),
    }));
    const blockTop = results.find((r) => Math.abs(bbox(r.loops[0]).dx - 80) < 0.1);
    const islandTop = results.find((r) => Math.abs(bbox(r.loops[0]).dx - 12) < 0.1);
    expect(blockTop).toBeDefined();
    expect(islandTop).toBeDefined();

    // Block top: one 80x60 contour + ONE hole (the rounded pocket opening).
    expect(blockTop!.loops.filter((l) => l.type === "contour").length).toBe(1);
    const topHoles = blockTop!.loops.filter((l) => l.type === "hole");
    expect(topHoles.length).toBe(1);
    const hb = bbox(topHoles[0]);
    expect(Math.abs(hb.dx - 50)).toBeLessThan(0.2);
    expect(Math.abs(hb.dy - 30)).toBeLessThan(0.2);
    const outerB = bbox(blockTop!.loops.find((l) => l.type === "contour")!);
    expect(Math.abs(outerB.dy - 60)).toBeLessThan(0.1);

    // Island top is NOT part of the block-top face wires: it is its own face
    // with exactly one 12x8 contour and no holes.
    expect(islandTop!.loops.length).toBe(1);
    expect(islandTop!.loops[0].type).toBe("contour");
    expect(Math.abs(bbox(islandTop!.loops[0]).dy - 8)).toBeLessThan(0.1);
  }, 30000);

  it("freeform spherical face: typed rejection naming the surface type", () => {
    const s = shape("fix_freeform.step");
    const sphere = classifyFaces(s).find((f) => f.typeName === "Sphere");
    expect(sphere).toBeDefined();
    expect(() => planarFaceLoops(oc, s, sphere!.index)).toThrow(/Sphere.*not a Plane/);
  }, 30000);
});

// ---- edgeChainLoops ----------------------------------------------------------

describe("edgeChainLoops", () => {
  it("closed circle chain: top rim of the d10 hole at (30,40) on plate_holes", () => {
    const s = shape("fix_plate_holes.step");
    const candidates = edgeEndpoints(s).filter((e) => {
      if (e.degenerated) return false;
      const zTop = Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6;
      const rA = Math.hypot(e.a[0] - 30, e.a[1] - 40);
      const rB = Math.hypot(e.b[0] - 30, e.b[1] - 40);
      return zTop && Math.abs(rA - 5) < 1e-6 && Math.abs(rB - 5) < 1e-6;
    });
    expect(candidates.length).toBe(1); // exactly the top circle of that hole

    // Single-plane pick -> exactly ONE Z group, byte-identical to the old single
    // result (loops/z/winding preserved).
    const groups = edgeChainLoops(oc, s, [candidates[0].index]);
    expect(groups.length).toBe(1);
    const { loops, z } = groups[0];
    expect(loops.length).toBe(1);
    expect(loops[0].closed).toBe(true);
    expect(loops[0].type).toBe("contour");
    expect(Math.abs(z - 10)).toBeLessThan(1e-6);
    expect(Math.abs(loops[0].area - Math.PI * 25)).toBeLessThan(0.6);
    expect(signedArea(loops[0])).toBeGreaterThan(0); // CCW-normalized
  }, 30000);

  it("multi-Z edge pick: top rim (z=10) + bottom rim (z=0) of a hole -> two groups", () => {
    const s = shape("fix_plate_holes.step");
    // Horizontal circle rims of the d10 hole at (30,40): one at z=10 (top), one
    // at z=0 (bottom -- the plate is a through-hole, z 0..10).
    const isRim = (
      e: { a: [number, number, number]; b: [number, number, number]; degenerated: boolean },
      zPlane: number,
    ) =>
      !e.degenerated &&
      Math.abs(e.a[2] - e.b[2]) < 1e-6 &&
      Math.abs(e.a[2] - zPlane) < 1e-6 &&
      Math.abs(Math.hypot(e.a[0] - 30, e.a[1] - 40) - 5) < 1e-6 &&
      Math.abs(Math.hypot(e.b[0] - 30, e.b[1] - 40) - 5) < 1e-6;
    const eps = edgeEndpoints(s);
    const top = eps.filter((e) => isRim(e, 10));
    const bot = eps.filter((e) => isRim(e, 0));
    expect(top.length).toBe(1);
    expect(bot.length).toBe(1);

    // One Z group PER plane, each chaining only its own coplanar loop.
    const groups = edgeChainLoops(oc, s, [top[0].index, bot[0].index]);
    expect(groups.length).toBe(2);
    const sorted = [...groups].sort((g1, g2) => g1.z - g2.z);
    expect(Math.abs(sorted[0].z - 0)).toBeLessThan(1e-6);
    expect(Math.abs(sorted[1].z - 10)).toBeLessThan(1e-6);
    for (const g of groups) {
      expect(g.loops.length).toBe(1);
      expect(g.loops[0].closed).toBe(true);
      expect(g.loops[0].type).toBe("contour");
      expect(Math.abs(g.loops[0].area - Math.PI * 25)).toBeLessThan(0.6);
    }
  }, 30000);

  it("tilted single loop: typed rejection naming the z spread (still fails loud)", () => {
    const s = shape("fix_freeform.step");
    // A vertical block edge spans z 0..10 -- not a Z=const machining plane. The
    // per-loop coplanar check rejects this single tilted chain (ADR 0003).
    const vertical = edgeEndpoints(s).find(
      (e) => !e.degenerated && Math.abs(e.a[2] - e.b[2]) > 1,
    );
    expect(vertical).toBeDefined();
    expect(() => edgeChainLoops(oc, s, [vertical!.index])).toThrow(/not coplanar/);
  }, 30000);
});

// ---- holeFeatures -------------------------------------------------------------

describe("holeFeatures", () => {
  it("plate_holes: exactly 6 through holes with the README diameters and centers", () => {
    const s = shape("fix_plate_holes.step");
    const holes = holeFeatures(oc, s);
    expect(holes.length).toBe(6);

    const diaCounts = new Map<number, number>();
    for (const h of holes) {
      const d = Math.round(h.diameter * 1000) / 1000;
      diaCounts.set(d, (diaCounts.get(d) ?? 0) + 1);
    }
    expect(diaCounts.get(3)).toBe(1);
    expect(diaCounts.get(6)).toBe(3);
    expect(diaCounts.get(10)).toBe(2);

    const expected: [number, number, number][] = [
      [20, 20, 6],
      [50, 20, 6],
      [80, 20, 6],
      [30, 40, 10],
      [70, 40, 10],
      [90, 40, 3],
    ];
    for (const [cx, cy, d] of expected) {
      const match = holes.find(
        (h) =>
          Math.abs(h.center[0] - cx) < 1e-3 &&
          Math.abs(h.center[1] - cy) < 1e-3 &&
          Math.abs(h.diameter - d) < 1e-3,
      );
      expect(match, `hole d${d} at (${cx},${cy})`).toBeDefined();
      expect(Math.abs(match!.topZ - 10)).toBeLessThan(1e-6);
      expect(Math.abs(match!.bottomZ - 0)).toBeLessThan(1e-6);
      expect(match!.through).toBe(true);
    }
    // eslint-disable-next-line no-console
    console.log(
      "holes:",
      holes.map((h) => `d${h.diameter.toFixed(3)}@(${h.center[0].toFixed(3)},${h.center[1].toFixed(3)})`).join(" "),
    );
  }, 30000);

  it("boss_taper: zero holes (outward boss wall is excluded by the normal test)", () => {
    const s = shape("fix_boss_taper.step");
    expect(holeFeatures(oc, s).length).toBe(0);
  }, 30000);
});

// ---- cylinderFeatures ---------------------------------------------------------

describe("cylinderFeatures", () => {
  it("plate_holes: returns the 6 bores; bore subset is byte-identical to holeFeatures", () => {
    const s = shape("fix_plate_holes.step");
    const cyls = cylinderFeatures(oc, s);
    // No bosses on this plate (outer boundary is a planar rectangle, holes are
    // straight cylinders) -> exactly the 6 bores, all kind 'bore'.
    expect(cyls.length).toBe(6);
    expect(cyls.every((c) => c.kind === "bore")).toBe(true);

    // PROOF the refactor preserves holeFeatures: the bore subset (kind stripped)
    // must deep-equal holeFeatures' output, feature-for-feature, in the same order.
    const holes = holeFeatures(oc, s);
    expect(cyls.length).toBe(holes.length);
    for (let i = 0; i < holes.length; i++) {
      const { kind, ...bore } = cyls[i];
      expect(kind).toBe("bore");
      expect(bore).toEqual(holes[i]);
    }
  }, 30000);

  it("plate_holes: faceIndices subset restricts to a single picked bore wall", () => {
    const s = shape("fix_plate_holes.step");
    const cylFaces = classifyFaces(s).filter((f) => f.typeName === "Cylinder");
    expect(cylFaces.length).toBe(6); // one wall per hole (README)
    const one = cylinderFeatures(oc, s, { faceIndices: [cylFaces[0].index] });
    expect(one.length).toBe(1);
    expect(one[0].kind).toBe("bore");
    // It must match one of the known README holes (d3/d6/d10).
    expect([3, 6, 10].some((d) => Math.abs(one[0].diameter - d) < 1e-3)).toBe(true);
    expect(Math.abs(one[0].topZ - 10)).toBeLessThan(1e-6);
    expect(Math.abs(one[0].bottomZ - 0)).toBeLessThan(1e-6);
    expect(one[0].through).toBe(true);
  }, 30000);

  it("boss_taper: zero vertical cylinders (the boss wall is a cone, not a cylinder)", () => {
    const s = shape("fix_boss_taper.step");
    // Same null result as holeFeatures -> no false 'boss' from a tapered wall.
    expect(cylinderFeatures(oc, s).length).toBe(0);
    expect(holeFeatures(oc, s).length).toBe(0);
  }, 30000);
});

// ---- sectionAtZ -----------------------------------------------------------------

describe("sectionAtZ", () => {
  it("boss_taper z=15: one closed circle, diameter 25.0 (linear taper 30->18 over z 10..22)", () => {
    const s = shape("fix_boss_taper.step");
    const { loops, z } = sectionAtZ(oc, s, 15);
    expect(z).toBe(15);
    const closed = loops.filter((l) => l.closed);
    expect(closed.length).toBe(1);
    expect(loops.filter((l) => !l.closed).length).toBe(0);
    expect(closed[0].type).toBe("contour");
    const b = bbox(closed[0]);
    expect(Math.abs(b.dx - 25)).toBeLessThan(0.2);
    expect(Math.abs(b.dy - 25)).toBeLessThan(0.2);
    expect(signedArea(closed[0])).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`section z=15 circle: dx=${b.dx.toFixed(4)} dy=${b.dy.toFixed(4)}`);
  }, 30000);

  it("boss_taper z=5: one closed 60x60 rectangle (base block only)", () => {
    const s = shape("fix_boss_taper.step");
    const { loops } = sectionAtZ(oc, s, 5);
    const closed = loops.filter((l) => l.closed);
    expect(closed.length).toBe(1);
    expect(closed[0].type).toBe("contour");
    const b = bbox(closed[0]);
    expect(Math.abs(b.dx - 60)).toBeLessThan(0.1);
    expect(Math.abs(b.dy - 60)).toBeLessThan(0.1);
  }, 30000);
});
