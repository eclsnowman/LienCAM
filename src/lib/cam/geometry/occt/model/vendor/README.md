# occt-model: custom opencascade.js build for the B-rep model kernel

## Purpose (ADR 0018 D1)

Second OCCT WASM module in the app, alongside `../../vendor/occt-fillet.*`
(the toolpath kernel). This one carries everything the B-rep MODEL side
needs: STEP import, shape healing, tessellation, topology queries
(stable subshape identity, ADR 0018 D3), surface classification
(planar/cylindrical, D5), exact planar sections, and bbox/mass
properties. Binding list: `occt-model.yml`.

Loaded lazily by `../loader.ts` (`loadOcctModel()`), only when a STEP
file is imported, in a dedicated model worker. Smoke test:
`src/tests/geometry/occt-model-smoke.test.ts` (gates A-E; supersedes the
build author's draft `sanity.node.mjs`, now removed).

## Build

```
bash build.sh
```

Needs docker (WSL Ubuntu-24.04 on the dev box, or any Linux host). Docker is
only needed to REGENERATE the artifacts (pinned image
`donalffons/opencascade.js:2.0.0-beta.b5ff984`, OCCT 7.6.2, emscripten
3.1.14); consumers just use the committed `occt-model.{js,wasm,d.ts}`.

WO-3047: the image ships its OCCT objects precompiled with `-Os` and
emscripten's JS-emulated exceptions (`-fexceptions`). With that emulation
every C++ call that can throw leaves wasm for a JS `invoke_*` trampoline and
comes back; a CPU profile of a STEP read spent ~44% of its time there.
`build-inside.py` recompiles the same OCCT sources and the bound classes with
native wasm exceptions (`-fwasm-exceptions`) and `-O3`, then links with the
image's own `buildFromYaml.py`. Same OCCT commit and source files, so the model
is byte-identical (src/tests/import/occtModelReaderSpeed.wo3047.test.ts); the
STEP read + heal is ~4-5x faster (src/tests/evidence/WO-3047/). The image's
OCCT is built without `OCC_CONVERT_SIGNALS`, so it never calls `setjmp` and
native exceptions need no `SUPPORT_LONGJMP`. Objects are cached in
`OCCT_MODEL_CACHE`: the first build compiles ~5,400 files (about an hour on 4
cores), later builds only relink (~17 min). buildFromYaml.py writes the d.ts in
filesystem order; the committed d.ts keeps its old order with new classes
inserted, so its diff stays readable (same lines, `sort | diff` is empty).

## Artifact size

- `occt-model.wasm` (WO-3047 build): 15916308 bytes raw / about 4.83 MB gzip.
  Before WO-3047 (`-Os`, JS exceptions): 11593758 raw / 3880699 gzip.
- This exceeds the 10 MiB soft tripwire in docs/brep/PLAN.md Stage 0 and
  is ACCEPTED: the module lazy-loads only on STEP import, in a dedicated
  worker, so it costs nothing on app startup or for users who never
  import STEP.
- Runtime: native wasm exceptions need Chrome 95+, Firefox 100+, Safari 15.2+
  (and any current Electron/Node); the app's other OCCT module (occt-wasm)
  already uses them.

## Binding / signature gotchas (measured against this exact build)

These were hit while writing the smoke test. They will save the Stage 1
implementer real time.

1. TopTools_IndexedMapOfShape is UNUSABLE in this build. The class is in
   the d.ts, but its base `NCollection_BaseMap` was not bound in
   occt-model.yml, so `new oc.TopTools_IndexedMapOfShape_1()` throws
   `UnboundTypeError: ... unbound types: 19NCollection_BaseMap` at
   runtime. Workaround (used by the smoke test): TopExp_Explorer +
   `IsSame()` dedup in first-encounter order — that is the same DFS
   order TopExp::MapShapes uses internally, and GATE B proves it is
   deterministic across reads. On the next rebuild add
   `- symbol: NCollection_BaseMap` to the yml; then MapShapes_1 +
   FindKey(i) becomes available. (Note: the map exposes `Size()`, not
   `Extent()`.)

2. No C++ default arguments anywhere (ocjs limitation). Every
   `Message_ProgressRange` parameter must be passed explicitly:
   `reader.TransferRoots(new oc.Message_ProgressRange_1())`,
   `section.Build(new oc.Message_ProgressRange_1())`, same for
   ShapeFix `Perform`. Construct, pass, `.delete()`.

3. `BRep_Tool.Triangulation(face, loc, theMeshPurpose)` has the OCCT
   7.7+ three-argument signature, but the `Poly_MeshPurpose` enum is NOT
   bound (referenced in the d.ts, never declared). Passing `undefined`
   (cast `as any` in TS) works and marshals to 0 =
   `Poly_MeshPurpose_NONE`, returning the active triangulation. If you
   need a specific purpose, bind the enum on the next rebuild.

4. Embind constructor suffixes — exact ones used here:
   - `STEPControl_Reader_1()` (no-arg)
   - `TopExp_Explorer_2(shape, toFind, toAvoid)` — `toAvoid` is
     mandatory; pass `oc.TopAbs_ShapeEnum.TopAbs_SHAPE` for "none".
   - `BRepMesh_IncrementalMesh_2(shape, linDeflection, isRelative,
     angDeflection, isInParallel)` — e.g. `(shape, 0.1, false, 0.5,
     false)`; meshing happens in the constructor, check `IsDone()`.
   - `BRepAlgoAPI_Section_5(shape, gp_Pln, performNow)` — pass `false`
     and call `Build(progressRange)` yourself, then `IsDone()`,
     `Shape()`.
   - `gp_Pnt_3(x, y, z)`, `gp_Dir_4(x, y, z)`, `gp_Pln_3(pnt, dir)`,
     `GProp_GProps_1()`, `TopLoc_Location_1()`,
     `Message_ProgressRange_1()`.

5. Static methods live on the class object with overload suffixes:
   `oc.TopExp.MapShapes_1(...)`, `oc.BRepGProp.SurfaceProperties_1(S,
   props, skipShared, useTriangulation)` (pass `false, false`),
   `oc.BRep_Tool.Triangulation(...)` (no suffix — single overload).
   Downcasts via `oc.TopoDS.Face_1(shape)` etc.

6. Enums are singleton objects: compare with `===`
   (`status === oc.IFSelect_ReturnStatus.IFSelect_RetDone`,
   `t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder`); the numeric is at
   `.value`. Never compare to raw numbers.

7. STEP input goes through MEMFS (the module exports `FS` via
   `EXPORTED_RUNTIME_METHODS`): `oc.FS.writeFile("/part.step", bytes)`
   then `reader.ReadFile("/part.step")`. There is no
   read-from-ArrayBuffer path bound.

8. Node/ESM quirks: `occt-model.js` is an ES6 module (EXPORT_ES6) whose
   emscripten Node branch still references the CJS globals `require`,
   `__dirname`, `__filename` — shim them onto `globalThis` before
   `loadOcctModel()` in Node (see the smoke test header). The repo's
   `package.json` is `"type": "commonjs"`, so plain `node` cannot import
   the `.js` directly by path; vitest's transform handles it.

9. Memory discipline: every wrapper returned to JS owns a copy and needs
   `.delete()` — including `TopExp_Explorer.Current()` results (they are
   copies; they stay valid after `Next()`/explorer deletion) and the
   `gp_Pnt` returned by `GProp_GProps.CentreOfMass()`.

10. Geometry note for section sanity checks: fix_boss_taper's boss spans
    z 10..22, so a z=5 section cuts only the base block — 4 edges (the
    base rectangle), no boss circle.

Added during Stage 1 (model worker core, core.ts):

11. Poly_PolygonOnTriangulation is NOT usable: BRep_Tool.PolygonOnTriangulation_*
    signatures reference Handle_Poly_PolygonOnTriangulation, but the class is
    never declared in the d.ts and is absent from OpenCascadeInstance (same for
    TColStd_Array1OfInteger, which its Nodes() would return). Edge polylines
    therefore come from BRepAdaptor_Curve_2(edge) + GCPnts_TangentialDeflection.
    Watch the ctor arg order: GCPnts_TangentialDeflection_2(curve,
    ANGULAR_deflection, CURVATURE(linear)_deflection, minPoints, uTol, minLen)
    — angular comes FIRST, opposite of BRepMesh_IncrementalMesh_2.

12. Degenerate edges (e.g. fix_freeform's sphere pole edge) have no 3D curve;
    constructing BRepAdaptor_Curve on one aborts. Check
    oc.BRep_Tool.Degenerated(edge) first and emit the vertex point
    (TopExp.FirstVertex + BRep_Tool.Pnt) instead.

13. The d.ts types enum MEMBERS as `{}` while parameters are typed as the enum
    ALIAS (e.g. TopExp_Explorer_2 wants TopAbs_ShapeEnum but
    oc.TopAbs_ShapeEnum.TopAbs_FACE is `{}`). Runtime is fine; `tsc -p
    tsconfig.app.json` is not — cast at the call site (`as TopAbs_ShapeEnum`).
    vitest does not type-check, so this only bites in tsc/build.

14. Bnd_Box::Get/CornerMin/CornerMax include the box GAP (tolerance
    enlargement, ~1e-7 after BRepBndLib). For exact bounds use
    BRepBndLib.AddOptimal(shape, box, false, false) then box.SetGap(0) before
    reading corners — that passes a 1e-6 bbox assertion on the STEP fixtures.

15. Triangulation nodes are face-LOCAL: apply the TopLoc_Location transform
    (loc.Transformation() returns an owned gp_Trsf — delete it) via
    gp_Pnt.Transform(trsf) in place. BRepAdaptor_Curve, by contrast, already
    applies the edge location — its sampled points are world-space.

16. (WO-3047) BRepCheck_Analyzer is bound: `new oc.BRepCheck_Analyzer(shape,
    geomControls, isParallel)` (three args, no defaults), then `IsValid_2()`.
    `Result()` returns the unbound Handle_BRepCheck_Result; do not call it.

17. (WO-3047) With native wasm exceptions, a C++ exception that escapes to JS
    arrives as a `WebAssembly.Exception`, not as a bare number (the old
    emulation threw the exception's heap pointer). `catch {}` / `catch (e)`
    catch both; nothing in the app reads the thrown value's type.
