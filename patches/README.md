# patches/

Local source patches against pinned third-party build inputs. Each patch is a
unified diff that applies with `git apply -p1` (or `patch -p1`) at the root of
the upstream checkout named in its header.

## occt-wasm-3.6.1-geo9-defeature.patch

- Upstream: https://github.com/andymai/occt-wasm, tag `v3.6.1`, commit
  `c4a96db7bb6ec7eed294dec42ba92fe4b6e0f580`; OCCT submodule
  `6e1fe656bf028bf0004482c389661587b269fc65`.
- Target file: `xtask/src/codegen/config.rs` (the `defeature` MethodSpec, the
  codegen SOURCE - not a hand-edited generated file).
- What it does: rebinds `defeature()` from the stock zero-thickness thick-solid
  shell path (`BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin(..., 0.0,
  tolerance)`, which threw a `WebAssembly.Exception` on real inputs) to OCCT's
  real feature-removal algorithm `BRepAlgoAPI_Defeaturing` (driving
  `BOPAlgo_RemoveFeatures`), plus a single-solid-compound unwrap so
  `isSolid()` / `watertight()` report correctly. The public API signature is
  unchanged. This is the GEO-9 / BK-65 change described in `NOTICE-GEO9.md`.
- Applying it changes generated code only after `cargo xtask codegen` runs:
  `cargo xtask build` regenerates the facade only when `facade/generated/` is
  MISSING, and upstream commits that directory. The repo `Dockerfile` therefore
  deletes `facade/generated/` and runs `cargo xtask codegen` explicitly.
- Provenance: recovered 2026-09-23 (WO-1836) from the pinned build image
  `occt-wasm-geo9` /
  `sha256:a8d33bde699ac9ea842a7ed1d5b4255ded879b99980e33d069c32f5d570b7892`,
  whose `/workspace` tree is the build that produced the shipped tarball
  (`/workspace/dist/occt-wasm.wasm` sha256 =
  `a3c02c79e435b21b3a37acc70912a0ce0c0ab8acb24a0a6fbdabb3534360ec44`, the hash
  recorded in `THIRD_PARTY_LICENSES.md`). The image tree is upstream v3.6.1 with
  exactly this one source change; see `src/tests/evidence/WO-1836/`.

## occt-wasm-3.6.1-iges-import.patch

- Upstream: same pins as above (`v3.6.1`, wrapper `c4a96db7`, OCCT submodule
  `6e1fe656`). Applies ON TOP of
  `occt-wasm-3.6.1-geo9-defeature.patch`; the two touch disjoint files except
  `xtask/src/codegen/config.rs`, where this one appends after `importStep` and
  the geo9 one edits `defeature` ~3000 lines earlier.
- Target files: `xtask/src/codegen/config.rs` (two new `MethodSpec`s),
  `facade/include/occt_kernel.h` (their declarations - codegen emits the
  definitions and the Embind bindings but NOT the class declaration, so a spec
  without a declaration here fails the `bindings.cpp` compile),
  `xtask/src/build.rs` (stop excluding `libTKDEIGES.a` from the link),
  `ts/src/{raw-types,index,types,worker}.ts` (the typed wrapper).
- What it does: binds `importIges(data)` to `IGESControl_Reader` and
  `exportIges(id, brepMode)` to `IGESControl_Writer`, so LienCAM can open the
  .igs/.iges files that older CAD and legacy-parts sites still ship (WO-1824).
  `importIges` returns whatever the file held - solid, shell, trimmed surfaces
  or bare wireframe - and does NOT refuse a non-solid; the caller labels it.
  `exportIges` exists because the import fixtures have to come from somewhere
  and generating them on this kernel from a known solid is the only source that
  is both license-clean and reproducible from this repo. No product export UI
  uses it.
- Cost: `dist/occt-wasm.wasm` grows from 22,158,771 to 24,046,224 bytes
  (+1.8 MB, the IGES exchange library). `dist/occt-wasm.js` is byte-identical.
- Generated, not hand-written: `src/tests/evidence/WO-1824/apply-iges-edits.py`
  makes the edits with asserted anchors and
  `src/tests/evidence/WO-1824/iges-kernel-build.sh` emits this file as the diff,
  then re-applies it onto a fresh baseline and byte-compares. See
  `src/tests/evidence/WO-1824/` for the log.
- OUT OF THIS ORDER'S LANE, still owed: the root `Dockerfile`'s layer 7 applies
  only the geo9 patch by name, so a from-scratch image build still produces a
  kernel with no IGES entry point. `Dockerfile` is not in WO-1824's owned-paths,
  so this order did not edit it. The change is two lines - after the geo9
  `patch -p1` line add
  `&& patch -p1 --no-backup-if-mismatch < /liencam-patches/occt-wasm-3.6.1-iges-import.patch \`
  and extend the verification grep with
  `&& grep -q IGESControl_Reader facade/generated/kernel.cpp`. The warm-image
  path that actually built what we ship (this order's
  `src/tests/evidence/WO-1824/iges-kernel-build.sh`) applies both patches and is
  complete.

## occt-wasm-3.6.1-kernel-history.patch

- Upstream: same pins as above (`v3.6.1`, wrapper `c4a96db7`, OCCT submodule
  `6e1fe656`). Applies ON TOP of `occt-wasm-3.6.1-geo9-defeature.patch` and
  `occt-wasm-3.6.1-iges-import.patch`, in that order.
- Target files: `xtask/src/codegen/emitter.rs` and
  `xtask/src/codegen/config.rs` (the codegen SOURCE),
  `facade/include/occt_kernel.h` (the two new declarations - codegen emits
  definitions and Embind bindings but never the class declaration), and
  `ts/src/{raw-types,index}.ts` (the typed wrapper).
- What it does, in three parts:
  1. **Booleans stop rewriting their own inputs.** OCCT's argument-taking
     boolean constructors (`BRepAlgoAPI_Fuse op(a, b)`) run DESTRUCTIVELY: they
     replace the caller's input shapes in place. Every boolean now uses the
     default constructor plus `SetArguments`/`SetTools`/`SetNonDestructive(true)`
     before `Build()` (emitted by a new `prepareBoolean` helper), and the
     multi-argument builders (`fuseAll`, `cutAll`, `intersectionCells`, `split`)
     set the same flag. This is why a face hash taken from an input shape before
     `Build()` used to name something else afterwards - the "occt-wasm's
     generated hashes are unreliable" note in `src/geom/worker/stable-id.ts`.
  2. **`buildEvolution` stops double-counting.** `fuseWithHistory`,
     `cutWithHistory` and `intersectWithHistory` walk BOTH input shapes; a face
     reachable from each emitted two records for one face. The helper now takes
     an optional caller-owned `visited` map so the two passes are one walk.
  3. **Sweeps report their construction record.** New
     `extrudeWithHistory(shapeId, dx, dy, dz, hashUpperBound)` and
     `revolveWithHistory(shapeId, px, py, pz, dx, dy, dz, angleRad,
     hashUpperBound)` return, on the existing `EvolutionData` channel:
     `generated` = flat `[profileEdgeHash, n, sideFaceHash * n]` per profile
     edge; `modified` = flat `[0, n, startCapHash * n]` then
     `[1, n, endCapHash * n]`; `deleted` unused. The result solid is the one
     `extrude`/`revolve` already returns. On a full-turn revolve the high-level
     `Generated()` drops radial faces whose profile edge is not used as a seam,
     so the underlying `BRepSweep_Revol` construction map is consulted too, and
     accepted only for a face that is a member of the final result.
- Ported, not applied verbatim. The source is LienCAM-next's
  `patches/occt-wasm-3.6.1-boolean-history.patch` and
  `occt-wasm-3.6.1-sweep-history.patch`, which patch `facade/generated/*.cpp`
  DIRECTLY. ADR-0052's build deletes `facade/generated/` and regenerates it from
  `xtask/src/codegen/`, so a literal `git apply` of those two is a no-op the
  next codegen run erases; the same changes are expressed against the generator
  instead.
- Deliberate deviation from Next: Next's sweep patch introduces a new Embind
  struct `SweepData` and a `makeWireWithHistory` method. `SweepData` would need
  a new `ReturnType` variant handled in four vendored emitters
  (`emitter.rs`, `rust_emitter.rs`, `wasi_emitter.rs`, `types.rs`) plus new
  wrapper types, for information the existing `EvolutionData` carries as-is;
  `makeWireWithHistory` records wire-assembly bookkeeping LienCAM already keeps
  on the TS side (each profile segment carries its own `srcId`). Neither is
  taken. Everything the sweep record is FOR is present.
- Cost: `dist/occt-wasm.wasm` grows from 24,046,224 to 24,058,625 bytes
  (+12,401). `dist/occt-wasm.js` is byte-identical.
- Generated, not hand-written: `src/tests/evidence/WO-1892/apply-history-edits.py`
  makes the edits with asserted anchors and
  `src/tests/evidence/WO-1892/history-kernel-build.sh` emits this file as the
  diff, then re-applies it onto a fresh baseline and byte-compares. See
  `src/tests/evidence/WO-1892/` for the log.
- STILL OWED, out of this order's lane: the root `Dockerfile`'s layer 7 applies
  only the geo9 patch by name (WO-1824 left the same note for its own patch), so
  a from-scratch image build still produces a kernel with neither IGES nor this.
  `Dockerfile` is not in this order's owned-paths. The fix is one line per patch,
  after the geo9 `patch -p1` line:
  `&& patch -p1 --no-backup-if-mismatch < /liencam-patches/occt-wasm-3.6.1-kernel-history.patch \`
  and a verification grep for `prepareBoolean` in `facade/generated/kernel.cpp`.
  The warm-image path that actually built what we ship
  (`src/tests/evidence/WO-1892/history-kernel-build.sh`) applies all three and is
  complete.

## The other eight LienCAM-next history patches (evaluated, NOT applied)

WO-1892 piloted the two that decide whether a face keeps its name through a
model edit. The remaining eight in `LienCAM-next/patches/` target the same
wrapper commit and OCCT submodule, so each stays a one-line decision:

| patch | what it buys | why not now |
| --- | --- | --- |
| `draft-history` | `draftWithHistory`: which face each drafted face came from | LienCAM's `applyDraft` already names its results from the picked faces; no open defect |
| `dressup-history` | fillet/chamfer band faces keyed to the generating EDGE rather than a `new#k` fragment | `#relabelDressUpBandFaces` does this geometrically today and has no open failure; the honest next pilot if one appears |
| `face-boundary-history` | `addHolesInFace`/`makeFace` report which wire became which boundary | only useful once sketch-region edits re-drive a face; nothing consumes it |
| `healing-history` | `ShapeFix`/sewing reports which input face each healed face came from | GEO-20/21 heal lineage is the strongest candidate AFTER this order - heal is where ids are lost today (`assignHealedIds`) |
| `loft-history` | per-section face lineage for `loft` | `#assignLoftFaceIds` is section-index-derived already |
| `pipe-history` | per-spine-segment face lineage for `pipe` | `#assignPipeFaceIds` is segment-derived already |
| `sewing-history` | which shells a sewing pass merged | no consumer; diagnostics only |
| `step-entity-history` | STEP entity id -> face, so an imported face keeps the file's own name | real value for re-import of an edited STEP, and it needs a product decision (what an imported id means across files) rather than a kernel one |

The ranking, if the next order asks: `healing-history`, then `step-entity-history`,
then `dressup-history`. The other five have no consumer that is worse off today.

## occt-wasm-3.6.1-stack-size.patch

- Upstream: same pins as above. Applies ON TOP of the three patches above (geo9, IGES, history), in that order.
- Target file: `xtask/src/build.rs` (the emcc link flags): adds `-sSTACK_SIZE=8388608`.
- Why (Form stage 5, docs/design/FORM-ENVIRONMENT.md): the kernel was linked with Emscripten's default 64 KB C
  stack, which has no guard page. A fillet on an edge between a plane and a B-spline face (a slot cut into a
  form body; any organic STEP part) recursed past it inside OCCT's blend code and overwrote the heap: the
  fillet returned a result, then every later kernel call failed "memory access out of bounds" until reload.
- Proof (src/tests/evidence/FORM/kernel-stack/): the shipped kernel and a rebuild of the shipped recipe both
  corrupt; the same rebuild with this flag gives the identical fillet (same volume) and a healthy kernel. The
  kernel slice (src/tests/geom/, the WO-114 store test, src/tests/form/) passes in full on both kernels.
- Only the `.wasm` changes: the JS glue is token-for-token identical to the shipped one, and the wrapper is
  the shipped one. Embedded wasm sha256 = 493c61e234ece6e070ff4ed5a83c117e16d7111372f23e1de45b725eef2421ff (24058745 bytes).
