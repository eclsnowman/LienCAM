// Smoke test for the vendored OCCT B-rep MODEL kernel (ADR 0018 D1). Proves, in-WASM,
// the capabilities the custom occt-model build exists for, against the canonical STEP
// fixtures in test_fixtures/brep/ (expected counts documented in its README.md):
//   GATE A: STEP read + exact unique FACE/EDGE/SOLID counts on all 4 fixtures
//   GATE B: subshape identity stability across reads (ADR 0018 D3)
//   GATE C: tessellation (BRepMesh_IncrementalMesh -> per-face Poly_Triangulation)
//   GATE D: exact planar section (BRepAlgoAPI_Section vs gp_Pln)
//   GATE E: surface classification (BRepAdaptor_Surface.GetType, D5 groundwork)
//
// NOTE on TopTools_IndexedMapOfShape: the binding exists in the d.ts but its base class
// NCollection_BaseMap was NOT bound, so constructing it throws UnboundTypeError at
// runtime. Until the module is rebuilt with that base bound, unique-subshape indexing
// uses TopExp_Explorer + IsSame dedup in first-encounter order — which is exactly the
// traversal order TopExp::MapShapes uses internally, so GATE B still proves the
// determinism ADR 0018 D3 requires.
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
import type {
  TopoDS_Shape,
  TopAbs_ShapeEnum,
} from "../../lib/cam/geometry/occt/model/vendor/occt-model.js";

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the ESM test runtime
// lacks them. The browser worker takes the ENVIRONMENT_IS_WEB branch and never hits these.
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, "../../lib/cam/geometry/occt/model/vendor/occt-model.wasm");
const fixtureDir = join(here, "../../../test_fixtures/brep");

// Expected unique-subshape counts per fixture (test_fixtures/brep/README.md).
const FIXTURES = [
  { file: "fix_block_pocket.step", faces: 20, edges: 48, solids: 1 },
  { file: "fix_plate_holes.step", faces: 12, edges: 30, solids: 1 },
  { file: "fix_boss_taper.step", faces: 8, edges: 15, solids: 1 },
  { file: "fix_freeform.step", faces: 7, edges: 15, solids: 1 },
] as const;

let oc: OcctModelModule;
const shapes = new Map<string, TopoDS_Shape>();

/** Write the STEP bytes into MEMFS, read + transfer with a fresh reader, return OneShape. */
function readStepShape(file: string): TopoDS_Shape {
  const memPath = `/${file}`;
  oc.FS.writeFile(memPath, readFileSync(join(fixtureDir, file)));
  const reader = new oc.STEPControl_Reader_1();
  try {
    const status = reader.ReadFile(memPath);
    expect(status).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
    // ocjs has no C++ default-arg support: Message_ProgressRange must be constructed.
    const progress = new oc.Message_ProgressRange_1();
    const nRoots = reader.TransferRoots(progress);
    progress.delete();
    expect(nRoots).toBeGreaterThanOrEqual(1);
    return reader.OneShape();
  } finally {
    reader.delete();
  }
}

/**
 * Unique subshapes of a type, in first-encounter (deterministic DFS) order — the same
 * order TopExp::MapShapes would index them. See header note for why the indexed map
 * itself is unusable in this build.
 */
// `type` is widened to `| object` because the d.ts types enum MEMBERS as {} while
// parameters want the enum alias; the cast below bridges that declaration quirk.
function uniqueSubshapes(shape: TopoDS_Shape, type: TopAbs_ShapeEnum | object): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const ex = new oc.TopExp_Explorer_2(
    shape,
    type as TopAbs_ShapeEnum,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum,
  );
  for (; ex.More(); ex.Next()) {
    const s = ex.Current();
    if (out.some((u) => u.IsSame(s))) s.delete();
    else out.push(s);
  }
  ex.delete();
  return out;
}

function freeAll(list: TopoDS_Shape[]): void {
  for (const s of list) s.delete();
}

/** Centroid of a face via BRepGProp::SurfaceProperties -> GProp_GProps.CentreOfMass. */
function faceCentroid(faceShape: TopoDS_Shape): [number, number, number] {
  const face = oc.TopoDS.Face_1(faceShape);
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const c = props.CentreOfMass();
  const out: [number, number, number] = [c.X(), c.Y(), c.Z()];
  c.delete();
  props.delete();
  face.delete();
  return out;
}

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  for (const fx of FIXTURES) shapes.set(fx.file, readStepShape(fx.file));
}, 60000);

afterAll(() => {
  for (const s of shapes.values()) s.delete();
  shapes.clear();
});

describe("OCCT model kernel smoke test", () => {
  it("GATE A: reads every STEP fixture with exact unique FACE/EDGE/SOLID counts", () => {
    for (const fx of FIXTURES) {
      const shape = shapes.get(fx.file)!;
      const faces = uniqueSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
      const edges = uniqueSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      const solids = uniqueSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
      expect(
        { file: fx.file, faces: faces.length, edges: edges.length, solids: solids.length },
      ).toEqual({ file: fx.file, faces: fx.faces, edges: fx.edges, solids: fx.solids });
      freeAll(faces);
      freeAll(edges);
      freeAll(solids);
    }
  }, 30000);

  it("GATE B: face indexing is deterministic across independent reads (ADR 0018 D3)", () => {
    // Fresh reader each time — proves order comes from the topology, not reader state.
    const shapeA = readStepShape("fix_plate_holes.step");
    const shapeB = readStepShape("fix_plate_holes.step");
    const facesA = uniqueSubshapes(shapeA, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const facesB = uniqueSubshapes(shapeB, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    expect(facesA.length).toBe(12);
    expect(facesB.length).toBe(facesA.length);
    for (let i = 0; i < facesA.length; i++) {
      const ca = faceCentroid(facesA[i]);
      const cb = faceCentroid(facesB[i]);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(ca[k] - cb[k]), `face ${i + 1} centroid axis ${k}`).toBeLessThan(1e-9);
      }
    }
    freeAll(facesA);
    freeAll(facesB);
    shapeA.delete();
    shapeB.delete();
  }, 30000);

  it("GATE C: tessellation produces a triangulation on every face of fix_block_pocket", () => {
    const shape = shapes.get("fix_block_pocket.step")!;
    const mesh = new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
    expect(mesh.IsDone()).toBe(true);
    const faces = uniqueSubshapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    let totalTriangles = 0;
    for (const f of faces) {
      const face = oc.TopoDS.Face_1(f);
      const loc = new oc.TopLoc_Location_1();
      // Poly_MeshPurpose enum is NOT bound in this build; passing undefined marshals to
      // Poly_MeshPurpose_NONE (0) and returns the active triangulation.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = oc.BRep_Tool.Triangulation(face, loc, undefined as any);
      expect(handle.IsNull()).toBe(false);
      totalTriangles += handle.get().NbTriangles();
      handle.delete();
      loc.delete();
      face.delete();
    }
    freeAll(faces);
    mesh.delete();
    expect(totalTriangles).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`GATE C: fix_block_pocket triangles total = ${totalTriangles}`);
  }, 30000);

  it("GATE D: planar section of fix_boss_taper at z=5 builds and yields edges", () => {
    const shape = shapes.get("fix_boss_taper.step")!;
    const origin = new oc.gp_Pnt_3(0, 0, 5);
    const normal = new oc.gp_Dir_4(0, 0, 1);
    const plane = new oc.gp_Pln_3(origin, normal);
    const section = new oc.BRepAlgoAPI_Section_5(shape, plane, false);
    const progress = new oc.Message_ProgressRange_1();
    section.Build(progress);
    expect(section.IsDone()).toBe(true);
    const result = section.Shape();
    const edges = uniqueSubshapes(result, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`GATE D: fix_boss_taper section edges at z=5 = ${edges.length}`);
    freeAll(edges);
    result.delete();
    progress.delete();
    section.delete();
    plane.delete();
    normal.delete();
    origin.delete();
  }, 30000);

  it("GATE E: surface classification — 6 cylinders in plate_holes, sphere in freeform", () => {
    const surfaceType = (f: TopoDS_Shape) => {
      const face = oc.TopoDS.Face_1(f);
      const surf = new oc.BRepAdaptor_Surface_2(face, true);
      const t = surf.GetType();
      surf.delete();
      face.delete();
      return t;
    };

    const plateFaces = uniqueSubshapes(
      shapes.get("fix_plate_holes.step")!,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
    );
    const cylinders = plateFaces.filter(
      (f) => surfaceType(f) === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder,
    ).length;
    expect(cylinders).toBe(6);
    freeAll(plateFaces);

    const freeformFaces = uniqueSubshapes(
      shapes.get("fix_freeform.step")!,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
    );
    const nonPlanarNonCyl = freeformFaces.filter((f) => {
      const t = surfaceType(f);
      return (
        t === oc.GeomAbs_SurfaceType.GeomAbs_Sphere ||
        (t !== oc.GeomAbs_SurfaceType.GeomAbs_Plane &&
          t !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder)
      );
    }).length;
    expect(nonPlanarNonCyl).toBeGreaterThanOrEqual(1);
    freeAll(freeformFaces);
  }, 30000);
});
