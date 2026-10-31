# ADR-0051: An STL carries its edits as a replayed journal over its own bytes

Date: 2026-09-22
Status: Accepted 2026-09-22. This is a decide-and-log decision (LIENCAM.md
rule 3) taken on the operator's direct ruling; he may reverse any part of it. It
AMENDS ADR-0039 in part (see section 1.3 and ADR-0039's Amendment 1); it does
not supersede it.
Amended 2026-09-23 by WO-1852 - Amendment 1 below closes the f64 kernel question.
Relates to: ADR-0039 (STL Tier 2 stays experimental pending durable identity),
ADR-0003 (no silent fallbacks), ADR-0018 (B-rep model kernel), ADR-0027
(versioned schema), ADR-0040 (no legacy before 1.0), LIENCAM.md rule 11.
Gates: WO-1845, WO-1846, WO-1847, WO-1848, WO-1849, WO-1850, WO-1851, WO-1852.
Depends on: nothing. WO-1836 (the missing kernel build environment) is NOT a
prerequisite for this decision or for WO-1845..1851 - see section 4.

## the operator's words

2026-09-21 (D7): *"Yes I want to be able to edit stl."* Said after the
LienCAM-next harvest put the trade in front of him: a curved or scanned STL can
already be MACHINED here, what it cannot be is EDITED.

2026-09-22 10:44 AM CT (MC card, D10): *"Build everything you can easily port
from LienCAM-Next's prior work. Then make a workorder for the remainder. Build
the framework so it can be expanded to additional work more easily. We are not
looking to break existing functionality we have built we want to expand and
improve what works to give the user more options for exiting [editing] and for
tool feature/edge selection in toolpaths."*

2026-09-22 12:56 PM CT (MC card, D12): *"Build them in that order
(recommended)"* - the Top picks ranking in
`docs/audits/NEXT-PORT-REVIEW-2026-09-22.md`.

## Context

### What the product does today, read from source

- **A raw STL is machined, not refused.** `resolveAdaptive3dPartSource`
  (`src/cam3d/integration/adaptive3dPartSource.ts:102`) hands an imported STL's
  triangles straight to the 3D strategies after `acquirePartMesh`
  (`src/cam3d/integration/parallel3dOperation.ts:738`) parses and sanitises
  them. Six call sites in `src/store/index.ts` (2556, 2873, 3091, 3317, 3767,
  6104) go through that one function. Nothing about a curved STL stops a
  toolpath.
- **Promotion to a solid is flat-faced only, by design.**
  `convertPrismaticMesh` (`src/mesh/prismatic.ts:484`) segments smooth patches,
  fits a plane to each, and REFUSES by name when a patch is curved ("a curved
  (cylindrical) wall that cannot be represented as a flat face",
  `prismatic.ts:340-384`). Its own header says curved reverse-engineering is out
  of scope. That refusal is the whole of what the operator ran into.
- **Main has exactly one shipped mesh EDIT, and it bakes.**
  `booleanMeshWithModelBody` (`src/store/index.ts:~12660-12760`) cuts an STL row
  with a Model body, exports the result with `exportBinaryStl`, caches those new
  bytes under a new id and mints a new `format:'stl'` row carrying
  `booleanProvenance` (`src/types/index.ts:3264`). The row is explicitly "a
  STATIC snapshot, never a live parametric feature". There is no undo of the
  edit itself, no record of what was cut, and no way to change the diameter
  afterwards.
- **There is a mesh workbench, and it is a lab.**
  `src/components/meshlab/MeshLabPage.tsx` (946 lines) wires repair, boolean,
  plane cut, hollow, decimate and export behind `?meshlab=1`. It operates on
  loaded slots, not on a project's STL row. It is a diagnostic surface.
- **The source bytes already persist.** `src/lib/projectBinaries.ts` embeds
  every real imported STL and STEP payload in the `.camproject` (line 388 reads
  them back out of the cache at save) and fails loud when a part's bytes are
  missing. A saved project therefore already contains, byte for byte, the file
  the operator imported.

### What Next built, and what shape it is in

`LienCAM-next/src/domain/geometry/mesh*.ts` is 53 files / ~3,109 lines with 91
mesh contract tests - real implementations, not stubs. The port review
(`docs/audits/NEXT-PORT-REVIEW-2026-09-22.md`, Mesh table) marks the
recognition, hole-family removal, blend/chamfer removal and planar push/pull
families ADAPT and pure TS, with no kernel dependency.

Two facts about its SHAPE decide how much of it can be lifted:

1. **Its mesh is an object graph with string ids, not typed arrays.**
   `triangleMesh.ts` defines `TriangleMesh` as frozen arrays of
   `{id:string, position:{x,y,z}}` vertices and `{id, vertexIds}` triangles, and
   `ownTriangleMesh` refuses anything above **150,000 vertices / 50,000
   triangles**. Ours is `MeshBuffers` - `Float32Array` positions plus
   `Uint32Array` indices (`src/mesh/types.ts:3-6`) - and every CAM engine,
   the viewport and the worker boundary consume that.
2. **Its persistence stores a whole mesh per edit.** `domain/project/meshes.ts`
   persists `MeshOperationRecord {id, sourceAssetId, source: TriangleMesh,
   command}` and caps a project at **16 meshes and 16 operation records**.
   Selections are `triangleIds` bound to a `(meshId, revision)` pair, so each
   record only replays against the exact revision it was made on.

Those budgets are livable for Next's fixtures and would be a rule-11 refusal on
a real scanned part.

### The bar ADR-0039 set

ADR-0039 (2026-08-11) kept the Tier 2 recogniser in `src/spikes/tier2/` because
no analytic face KEY survived retessellation: 230 of 482 keyed faces sat closer
to a quantisation bucket boundary than the drift already measured. It named its
own unlock condition exactly: product work may resume "after a separate decision
identifies a durable, fail-closed reference source, such as exact source/kernel
lineage or another discrete topological fact available before tessellation, and
proves save/load and retessellation rebinding."

This ADR is that separate decision, for STL only.

## Decision

### 1. Where a mesh edit lives: on the STL row, as an ordered journal

**An edited STL is not a third kind of thing and not a new baked row. The
existing `format:'stl'` row grows an ordered list of edits; the imported bytes
stay the immutable source; the mesh every consumer sees is the result of
replaying that list over those bytes.**

1.1 **The source bytes are never rewritten.** No edit touches the STL cache
entry or the embedded project binary. An STL with an empty (or absent) journal
must produce byte-identical results to today, everywhere.

1.2 **One resolver, not a seam per consumer.** Every route that turns an STL
row into geometry goes through ONE function that loads the bytes, parses them
and applies the journal. Routes are enumerated in section 5; a route that skips
it is a defect, not a limitation. (WO-1845 may name it; this ADR binds only that
there is exactly one.)

1.3 **Identity: a facet is its index in the imported file, and that satisfies
ADR-0039.** `importStl` writes triangle `t` of a binary STL to
`indices[3t..3t+2]` in file order with no welding or reordering
(`src/mesh/stl.ts:44-72`); the ASCII path does the same from `vertex` lines.
File order is a discrete topological fact that exists BEFORE any tessellation we
perform - because for an STL there is no tessellation of ours at all, the file
IS the tessellation - and the file is persisted with the project. That is
precisely the "discrete topological fact available before tessellation" plus the
"save/load" proof ADR-0039 demanded, and it is why this ADR may amend it. It is
NOT a licence to persist analytic surface keys; ADR-0039's rejection of those
stands unchanged.

The identity is anchored at `parseStl`/`importStl` output. It is NOT anchored at
`importStlToPartMesh` (`src/cam3d/input/stl.ts:202`), which runs
`sanitizeTriangleMesh` and drops degenerate triangles - a different, lossy
numbering. Facet ancestry rides to CAM through the `faceIds` channel that
already exists for STEP (`PartMesh.faceIds`, `src/cam3d/kernel/types.ts:58`;
`sanitizeTriangleMesh` filters it in lockstep, `src/cam3d/input/sanitize.ts:94,
187,229`).

1.4 **Each edit carries a geometric witness and replay is fail-closed.** An edit
records its kind, a version, its parameters, its selection as facet indices in
the mesh produced by the edits before it, AND a small witness of what it
selected (for a round feature: axis, radius, depth, facet count; for a planar
region: plane and area). On replay, if the witness does not match what is at
those indices within tolerance, replay STOPS at that edit, says so in the
console naming the edit, and leaves the earlier edits applied. It never edits a
different region and never silently skips (ADR-0003). Indices alone are a
position, not a proof; the witness is what makes them safe.

1.5 **No size budget.** We do not port Next's 50,000-triangle / 16-record caps.
A refusal must name something the software cannot do (rule 11); "your scan is
too big for our data structure" is not that. If an operation is genuinely too
slow on a large mesh, it says so with the measured cost, or it runs in the mesh
worker - it does not refuse by policy.

1.6 **Baked rows stay baked.** The existing boolean-result row keeps its
snapshot semantics and its `booleanProvenance`. It is itself an STL row with its
own bytes, so it may carry a journal of its own from the day the framework
lands. Nothing is migrated (ADR-0040).

### 2. Promotion keeps winning where it applies, and the two paths compose

**A flat-faced STL still promotes exactly as it does today. Editing is offered
on the same row, to every STL, promotable or not. The operator is never asked to
choose a lane, and nothing new is refused.**

2.1 `convertPrismaticMesh`, `promoteImportedMeshModel.ts`, the meshImport replay
node (`SolidsWorkbenchPage.tsx:6991-7010`) and "Edit as model" behave as they do
now for an unedited STL. A promoted part gets real B-rep editing, which is
better than mesh editing, and that ordering does not change.

2.2 **"Edit as model" on an EDITED STL wraps the EDITED shape.** The wrap
(`src/store/index.ts:18589-18611`) today loads the row's cached bytes, validates
`convertPrismaticMesh` on them, copies THOSE bytes under a fresh cache key and
seeds the model item with `{fileName, cacheKey, name}`. With a journal present
it must instead validate and copy the REPLAYED mesh's bytes. The meshImport node
payload does not change shape; only which bytes the wrap copies does. Cost, and
it is stated plainly to the operator, not hidden: the model item is a SNAPSHOT
of the edit state at wrap time - the same semantics the boolean row already has
- and later mesh edits on the CAM row do not flow into it.

2.3 **What the UI says.** The properties panel for an STL row lists its edits in
order, each removable, and says whether the row can also be edited as a model.
No banner, no modal, no warning dialog (COHESION-STANDARD s13, console for
events). When the converter would refuse a promotion it already refuses by name
with its own region-naming message; that message stands and now has a true
second half - the part can still be edited as a mesh.

### 3. Which operations first: the operator's ranked order, not ours

The WO asked the ADR to pick a first slice on user value. the operator answered that
question himself before this ADR was written (D10, then D12: "Build them in that
order"), so the ADR records rather than re-decides:

| rank | what it gives the operator | order |
| --- | --- | --- |
| 1 | an STL can hold, save, undo and replay edits at all | WO-1845 |
| 2 | LienCAM names the holes, bosses, counterbores and countersinks it can prove | WO-1846 |
| 3 | fill a hole, remove a boss | WO-1847 |
| 4 | remove or resize a fillet or chamfer | WO-1848 |
| 5 | push or pull a flat face | WO-1849 |
| 6 | bore a hole bigger | WO-1850 |
| 7 | drill/bore/pocket a recognised STL feature directly | WO-1851 |
| - | everything that does not port easily | WO-1852 |

WO-1845 is the framework and is the only one of these that may change the
framework; 1846-1851 ADD a file and register. WO-1851 changes what a toolpath
cuts and therefore lands on the operator's picture verdict.

### 4. Their approach, not their kernel - and WO-1836 does not gate this series

4.1 **The families we are porting need no kernel at all.** Recognition
(WO-1846), hole-family removal (WO-1847), blend and chamfer work (WO-1848) and
planar offset (WO-1849) are pure TypeScript in Next and stay pure TypeScript
here. Verified in the port review's Mesh table and by reading the named files:
none of them imports `meshBooleanKernel`.

4.2 **The one boolean-shaped edit uses the kernel we already ship.** WO-1850
enlarges a bore with `booleanMesh` (`src/mesh/manifoldOps.ts`) on npm
`manifold-3d` 3.5.1 (`package.json:34`).

4.3 **We do not take Next's f64 mesh kernel, and the reason is in the file
format.** A binary STL stores each vertex as three IEEE **float32** values -
our parser reads them with `view.getFloat32` and keeps them in a `Float32Array`
(`src/mesh/stl.ts:60-66`), and the ASCII path lands in the same `Float32Array`.
A double-precision kernel cannot recover precision the source file never
carried. Next needed f64 for meshes it generated itself; for editing an
imported STL it buys nothing measurable and costs us the one thing we cannot
currently produce - a build of that kernel, which pins the same digest-only
container image as our occt-wasm build (WO-1836). So WO-1836 is a prerequisite
for WO-1852 item 1 and for the kernel history patches, and for nothing in
WO-1845..1851. If chained booleans are later shown to accumulate error that
matters on a real part, that measurement re-opens this in WO-1852 - a claim
alone does not.

4.4 **Adapt the algorithms to our buffers; do not adopt their representation.**
Porting `TriangleMesh` would put a frozen object graph with string ids and a
50,000-triangle ceiling underneath a pipeline whose every consumer takes typed
arrays. The port is: keep `MeshBuffers`, add a parallel `Uint32Array` of facet
ids, and rewrite each ported algorithm against that view. We DO adopt the
SHAPE of their command union (`meshOperation.ts`: `kind` + explicit `version` +
validated selection + parameters) and of their ancestry map
(`meshTopologyHistory.ts`: per edit, sourceId -> outputIds for triangles and
vertices). Their tests are contracts against their architecture and are not
ported; ours must run through our production entry points (rule 6).

4.5 **Licensing is clear either way.** Next's kernel wraps Manifold 3.5.3 under
Apache-2.0, one-way compatible into our GPL-3.0-or-later (ADR-0032), and the
algorithm files we are porting are GPL-3.0-or-later already. Nothing here needs
a licence decision; THIRD-PARTY-NOTICES.md changes only if WO-1852 later
vendors the kernel.

### 5. What an edit means downstream: one replayed mesh on every route

Every route below reads an STL row's geometry today. Each was read for this
ADR; the verdict column is binding on WO-1845 and its siblings. "The edit is
invisible here" is the failure mode this census exists to prevent - an operator
who fills a hole and still sees it in the viewport has been lied to.

| # | route | file:line | verdict |
| --- | --- | --- | --- |
| R1 | CAM part mesh (all six store call sites) | `cam3d/integration/parallel3dOperation.ts:738` via `store/index.ts:2556,2873,3091,3317,3767,6104` | MUST replay. This is the toolpath. |
| R2 | STL toolpath candidates (edge chains) | `store/index.ts:12455-12481` -> `meshContourLoops` at `:650`, `extractMeshEdgeChains` at `:666` | MUST replay: chains are derived from facets. |
| R3 | Viewport display, project restore | `lib/viewport/restoreScene.ts:464-467` (`vp.addSTL`) | MUST replay, or the part on screen is not the part being cut. |
| R4 | Viewport display, fresh import | `lib/import/importGeometryFile.ts:93` | No journal can exist at import; the route must still go through the resolver so a later edit redraws. |
| R5 | Workholding obstacles / holder clearance | `store/fixtureObstacles.ts:62` | MUST replay. A clearance check against a shape the part no longer has is a crash the software could have seen. |
| R6 | Duplicate a geometry row | `components/panels/DesignTree.tsx:741`, `components/panels/PropertiesPanel.tsx:341` | MUST copy the journal with the bytes, or a duplicate silently loses the edits. |
| R7 | "Edit as model" wrap | `store/index.ts:18589-18611` | MUST validate and copy the REPLAYED bytes (section 2.2). |
| R8 | Project save / load | `lib/projectBinaries.ts:388` | NO change. Source bytes already embed; the journal rides in the project JSON on the row. |
| R9 | Boolean-vs-model-body result row | `store/index.ts:~12660-12760` | NO change (section 1.6). |
| R10 | Mesh lab | `components/meshlab/MeshLabPage.tsx` | NO change. It is a lab on loaded slots, not on project rows. |

5.1 **Undo.** An edit is added and removed through the store's normal history
(`pushHistory`), one step per edit, like every other row-level change.

5.2 **Recompute.** Adding or removing an edit invalidates the toolpaths computed
from that row exactly as moving the part does. It does not silently leave a
stale path on screen.

5.3 **Persistence.** The journal is additive optional state on `ImportedGeometry`
under ADR-0027's schema rules; no migration is written (ADR-0040). A project
with no edits saves as it does today.

## Alternatives considered

**Bake the edited mesh into new bytes (what the boolean row does today).**
Rejected as the model for this lane. It is the cheapest thing to build and it
loses everything the operator asked for: no undo of the edit, no "make that hole 1 mm
bigger instead", no record of what was done, and a second copy of a large mesh
per edit in the project file. It stays for the boolean row because that row is
already shipped and honest about being a snapshot.

**A third geometry kind, or an STL editing workspace.** Rejected. It splits
every consumer in the census above into two branches, doubles the surface where
a route can forget the edits, and puts a mode between the operator and his part.
The mesh lab already shows what a separate surface buys: it is useful for
diagnosis and useless for the job.

**Port Next's `TriangleMesh`, persistence and f64 kernel wholesale.** Rejected:
sections 4.3 and 4.4. It imports a 50k-triangle ceiling, a per-edit full-mesh
copy, a 16-edit project cap and an unbuildable kernel, to gain precision the
STL file does not contain.

**Persisted analytic feature keys as the edit's identity** (a bore keyed by its
snapped axis and radius). Rejected, and it is ADR-0039's finding, not a new one:
every fixed quantisation grid has a boundary, and 230 of 482 measured faces sat
nearer a boundary than the observed drift. Facet indices plus a geometric
witness give exact identity with a loud, fail-closed check instead.

**Make this a promote-to-BREP improvement instead.** Rejected, and fenced.
Promotion works and is proven for flat-faced parts. Curved reverse-engineering
is what ADR-0039 stopped; this lane deliberately goes around it rather than
re-opening it.

## Consequences

- **ADR-0039 is amended in part**, and only in part: STL-specific, in-session
  and persisted edits keyed to source-file facet order are now permitted in the
  product. Analytic face keys remain rejected, `src/spikes/tier2/` stays a
  measurement harness, and its lane test stays.
- **WO-1845's owned paths are incomplete as filed** against the section 5
  census. It grants `src/cam3d/integration/parallel3dOperation.ts` (R1),
  `src/store/index.ts` (R1, R2, R6, R7) and `PropertiesPanel.tsx` (R6), but not
  `src/lib/viewport/restoreScene.ts` (R3), `src/lib/import/importGeometryFile.ts`
  (R4), `src/store/fixtureObstacles.ts` (R5) or
  `src/components/panels/DesignTree.tsx` (R6). The architect widens the grant
  before dispatch, or explicitly defers R3-R6 to a named follow-up order; it may
  not be left to the worker to discover.
- **WO-1845's "one replay seam" is understated**: there are ten routes, seven of
  which must replay. Its acceptance should assert at least R1, R2, R3 and R6
  through production entry points.
- **WO-1850 is unblocked without WO-1836**, on `manifold-3d` 3.5.1, with
  section 4.3 as the recorded reason. WO-1852 item 1 remains gated on WO-1836.
- **WO-1846..1849 are unblocked entirely** - no kernel, no build image.
- Each ported family arrives with tests written against OUR production entry
  points; Next's 91 contract tests are evidence that the algorithms work, never
  evidence that our port does (rule 6).
- WO-1851 changes what a toolpath cuts and lands on the operator's picture verdict.
- The mesh worker (`src/mesh/worker/`) becomes the escape hatch if replay cost
  shows up on large scans; no operation refuses on size (1.5).
- Risk accepted: a journal whose witness check fires on reload leaves the
  operator with a partially replayed part and a console message. That is the
  fail-closed choice; the alternative is editing the wrong region silently.

## Amendment 1 - 2026-09-23 (WO-1852): the f64 question is closed

Section 4.3 said the f64 decision re-opens only on a measurement showing that
error which matters accumulates on a real part, and that "WO-1852 item 1
remains gated on WO-1836". WO-1836 has landed and the measurement now exists.
It closes the question the other way: **we do not vendor or rebuild Next's f64
mesh kernel, and item 1 is no longer gated on anything.**

The measurement is WO-1850, driven through the product's own Bore box and Bore
button on npm `manifold-3d` 3.5.1 (float32): a 6 -> 8 mm through bore and an
8 -> 10 mm blind bore, with WO-1846's recognition reading the finished diameter
back within 0.01 mm and the fitted axis within 0.4 um. The two errors that did
appear were not precision - a cutting prism whose corner count was not a
multiple of 8 fitted a tilted axis, and a plug with less than 5% clearance left
zero-area slivers. Both are symmetry, both were fixed by construction, and
neither would have been touched by a double-precision kernel. Section 4.3's
underlying reason stands unchanged: a binary STL stores float32 and our parser
keeps it that way (`src/mesh/stl.ts:60-66`), so f64 cannot recover precision
the file never carried.

Consequences of this amendment:

- THIRD-PARTY-NOTICES.md does not change; section 4.5's conditional does not
  fire.
- The facet-ancestry half of item 1 is already in the product -
  `booleanMeshWithAncestry` (`src/mesh/manifoldOps.ts:379`), fail-loud when the
  runtime returns no run ids - so nothing of item 1 is owed except the operand
  acceptance checks, which WO-1852's verdict folds into the general-boolean
  order.
- This re-opens only on a NEW measurement: a chain of booleans on a real file
  of the operator's whose accumulated error a float32 kernel demonstrably causes. A
  claim still does not re-open it.

## References

- `src/mesh/stl.ts:34-90` (`importStl`, `parseBinary`, `parseAscii` - float32
  storage and file-order facets)
- `src/mesh/prismatic.ts:484` (`convertPrismaticMesh`), `:340-384` (curved
  refusal), `src/mesh/types.ts:3-6` (`MeshBuffers`)
- `src/cam3d/integration/parallel3dOperation.ts:738` (`acquirePartMesh`),
  `src/cam3d/integration/adaptive3dPartSource.ts:102`,
  `src/cam3d/input/stl.ts:202`, `src/cam3d/input/sanitize.ts:91-229`,
  `src/cam3d/kernel/types.ts:58`
- `src/store/index.ts:650,666,12455,12660-12760,18589-18611`,
  `src/store/fixtureObstacles.ts:62`
- `src/lib/viewport/restoreScene.ts:464`,
  `src/lib/import/importGeometryFile.ts:93`, `src/lib/projectBinaries.ts:388`
- `src/components/panels/DesignTree.tsx:741`,
  `src/components/panels/PropertiesPanel.tsx:341`,
  `src/components/model3d/SolidsWorkbenchPage.tsx:6991-7010`,
  `src/doc/promoteImportedMeshModel.ts`
- `src/types/index.ts:3135-3275` (`ImportedGeometry`, `BooleanMeshProvenance`)
- `package.json:34` (`manifold-3d` 3.5.1)
- `LienCAM-next/src/domain/geometry/triangleMesh.ts` (budgets, string ids),
  `meshOperation.ts` (command union), `meshTopologyHistory.ts` (ancestry),
  `src/domain/project/meshes.ts` (per-record mesh copy, 16-record cap)
- `docs/audits/NEXT-PORT-REVIEW-2026-09-22.md` (Mesh table)
- ADR-0039, ADR-0040, ADR-0032, ADR-0027, ADR-0018, ADR-0003
- WO-1836, WO-1837, WO-1845, WO-1846, WO-1847, WO-1848, WO-1849, WO-1850,
  WO-1851, WO-1852
