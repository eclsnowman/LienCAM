# ADR-0052: The geometry kernel's build recipe lives in this repository

Date: 2026-09-23
Status: Accepted 2026-09-23, on the operator's ruling of 2026-09-22 (WO-1836, MC card
D11). Decide-and-log per LIENCAM.md rule 3; reversible.
Relates to: ADR-0014 / ADR-0018 (the older `occt-model` OCCT/WASM build),
ADR-0032 (GPL-3.0-or-later and the notice obligations it creates),
ADR-0051 (STL editing - which does NOT depend on this).
Gates: WO-1824 (IGES import), WO-1837 (mesh kernel), and any future decision
about LienCAM-next's ten kernel history patches.

## the operator's words

2026-09-22 10:46 AM CT (MC card, D11), answering "do we want the ability to
rebuild our own kernel at all?": *"Yes - it unblocks all three
(recommended)."* And: *"I believe it was built in an docker container. You will
need to review what happened previously, that is outside my knowledge base and
memory. But yes if we need to build or compile trusted code to make our
software more functional and it is compatible with the license then go for it.
I believe we already have atleast once, maybe more than once."*

His memory was right on both counts.

## Context

LienCAM's B-rep geometry kernel (`src/geom/`, imported as `occt-wasm`) ships as
one prebuilt tarball, `vendor/occt-wasm/occt-wasm-3.6.1-geo9-bk65.tgz`. It is a
PATCHED build: `defeature()` is rebound from upstream's zero-thickness
thick-solid shell path - which threw a `WebAssembly.Exception` on real inputs -
to OCCT's real `BRepAlgoAPI_Defeaturing`.

`THIRD-PARTY-NOTICES.md` explained how to rebuild it, citing
`xtask/src/codegen/config.rs`, a `Dockerfile` codegen step,
`coordination/reports/GEO-9.report.json` and a packaged `NOTICE-GEO9.md`. None
of those files were in this repository and, per `git log` over all refs, none
ever had been. Three consequences, in ascending order of cost:

1. A GPL-3.0 project's own third-party notice described source availability we
   could not actually provide from the repo.
2. Nobody working here could change the kernel at all.
3. Three pieces of work were parked behind (2): WO-1824 (IGES needs a new
   kernel entry point), WO-1837 (the mesh kernel pins the same container image
   digest), and any adoption of LienCAM-next's ten history patches.

### What the archaeology actually found (two corrections)

The WO's 2026-09-22 archaeology note said the recoverable patch was the dirty
working tree of `the reference checkout's .kernel-investigation/occt-wasm`, and that
the `defeature` MethodSpec was already upstream unmodified. Both are wrong, and
acting on them would have committed the wrong patch:

- That clone's uncommitted 5-file diff is byte-identical to LienCAM-next's own
  `patches/occt-wasm-3.6.1-draft-history.patch` (`draftWithHistory`). It is
  Next's work left in the tree, not ours.
- Upstream's `defeature` MethodSpec at c4a96db7 is the BROKEN
  `BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin(..., 0.0, tolerance)`
  form - exactly what the notice says we patched away from.

The real patch was never in any checkout. It was inside the build itself. The
pinned image `occt-wasm-geo9` /
`sha256:a8d33bde699ac9ea842a7ed1d5b4255ded879b99980e33d069c32f5d570b7892`, still
present in this box's WSL docker (with a `docker save` backup under
`the reference archive's kernel-images/`), carries the whole build at
`/workspace`, including `/workspace/dist/occt-wasm.wasm` whose sha256 is
`a3c02c79e435b21b3a37acc70912a0ce0c0ab8acb24a0a6fbdabb3534360ec44` - the hash
the notice records for the binary we ship. That tree is upstream v3.6.1 with
exactly ONE source change, in `xtask/src/codegen/config.rs`.

### The trap in upstream's build

`cargo xtask build` re-runs codegen only when `facade/generated/` is MISSING
(`xtask/src/build.rs`, step 1b), and upstream commits that directory. Upstream's
Dockerfile never calls `cargo xtask codegen`. So patching the codegen source and
running the stock recipe produces an UNPATCHED kernel, silently. The notice's
claim that "the Dockerfile runs `cargo xtask codegen` before compiling" was
false; on 2026-07-09 that step was run by hand.

## Decision

1. **We keep the ability to rebuild the kernel, and the recipe lives here.**
   Committed in this repo:
   - `patches/occt-wasm-3.6.1-geo9-defeature.patch` - the entire local change,
     as a unified diff against the codegen source.
   - `xtask/` - a pristine, unmodified copy of upstream's build tool at
     c4a96db7, so the file the notice cites exists and the diff can be read in
     context. It is build-input provenance, not a LienCAM build target: nothing
     in `package.json` or the test suite touches it.
   - `Dockerfile` - the from-scratch recipe. Upstream's, with the pins fetched
     inside the image and the missing `rm -rf facade/generated` +
     `cargo xtask codegen` step made explicit.
   - `NOTICE-GEO9.md` - the packaged notice, master copy.
   - `src/tests/evidence/WO-1836/GEO-9.report.json` - the machine-readable
     record of pins, hashes and reproduction. NOT at the
     `coordination/reports/` path the old notice cited: `.gitignore` bans
     `coordination/` outright ("must never exist in this repo"), which is part
     of why that file never existed. The notices now point here.
2. **The recipe is proven against the binary we ship, not asserted.** See
   "Evidence" below.
3. **This order did not change what ships.** `vendor/occt-wasm/...tgz` is
   untouched. Replacing the shipped binary is a separate decision with its own
   test gate.
4. **Local kernel changes go in `patches/`, never as hand-edits.** A hand-edited
   generated file is how the last one became unrecoverable. One diff per change,
   against the codegen source, named for what it does.
5. **The pinned image is a convenience, not the source of truth.** It is a warm
   cache that turns an hour-long build into minutes. If it is pruned, the
   `Dockerfile` rebuilds it; that is the whole point of committing the recipe.

## Evidence

Method and logs: `src/tests/evidence/WO-1836/`.

- **Codegen reproduction (exact).** Pristine upstream `xtask/` from this repo,
  plus `patches/occt-wasm-3.6.1-geo9-defeature.patch`, plus
  `cargo xtask codegen`, regenerated all three facade files byte-identical to
  the ones baked into the pinned image: `bindings.cpp`
  `b77ee1354e28df95b4c1574c19b901358d1cbc86ab25158c4a0fbdffe3991582`,
  `kernel.cpp` `284b789c5651745db5f83f4f4a023d9b497b8f6b21aaedc5a30a85f5b420131b`,
  `wasi_exports.cpp`
  `222acdb1de1f938452158aa22a912ce84f883feecef68cc124c9f2f4cd408085`
  (`codegen-proof.log`). 194 methods generated, 0 skipped.
- **Patch fidelity.** `git apply --check` passes against the vendored `xtask/`;
  applying it turns `config.rs`
  `526e3cb5384431a909834440ce3f191ecf1becf377bfe44a452f67a5da3162ce` into
  `d53b7fcbc929b31b8ea9d2a0b6098bfd4fe55e3499dfb171324a729411ec5fd8`, the
  image's copy.
- **Full rebuild.** `rebuild.log` - facade recompiled from the regenerated
  sources and relinked against the prebuilt OCCT static libs, then the produced
  `dist/occt-wasm.wasm` compared byte-for-byte with the shipped one. Result is
  recorded in `src/tests/evidence/WO-1836/GEO-9.report.json` and in the WO-1836
  worker result. Outcome: **byte-identical**. `dist/occt-wasm.wasm` sha256
  `a3c02c79e435b21b3a37acc70912a0ce0c0ab8acb24a0a6fbdabb3534360ec44`
  (22,158,771 bytes) and `dist/occt-wasm.js` sha256
  `2d3285281a20b8c5668dc52e543b5e04164abb0d126ca9f746e03adc40b984c4`, `cmp`
  clean against the `dist/` inside the shipped tarball. The WO's fallback
  (run the equivalence tests against both binaries) was therefore not needed.

## Consequences

- WO-1824 (IGES) is unblocked as a build problem. Adding an IGES entry point is
  now: add a MethodSpec to `xtask/src/codegen/config.rs`, save it as a patch in
  `patches/`, rebuild. Whether OCCT's IGES reader is worth binding, and what the
  JS surface should be, remain that order's own questions. Note that
  LienCAM-next's kernel does not expose IGES either - there is nothing to port.
- WO-1837 (mesh kernel) is unblocked for the same reason: it pinned the same
  image digest, and that image is now reproducible from a committed recipe.
- LienCAM-next's ten history patches (`draft`, `boolean`, `dressup`,
  `face-boundary`, `healing`, `loft`, `pipe`, `sewing`, `step-entity`, `sweep`)
  can now be evaluated on their merits. They target the identical wrapper commit
  and OCCT submodule, so there is no fork to reconcile. Taking them is a
  SEPARATE decision, deliberately not bundled here; the one thing that changes
  is that "we cannot apply them" is no longer the reason.
- Licensing is unchanged and now actually satisfiable: OCCT LGPL-2.1 with the
  Open CASCADE exception, wrapper MIT OR Apache-2.0, RapidJSON MIT. Our modified
  build's corresponding source is the pinned upstream plus one committed diff.
- Cost of the recipe: a 5,180-line vendored `config.rs` and eleven more Rust
  files that nothing here compiles. That is the price of the notice being true.
  `xtask/PROVENANCE.md` says plainly that they are not to be edited.

## Alternatives considered

- **Fix the notice only, keep the kernel unbuildable.** The WO offered this as
  the cheap half. Rejected: it leaves three orders parked and leaves the next
  kernel change as unrecoverable as this one was.
- **Vendor the whole upstream checkout (~360 MB).** Rejected: the pins plus a
  fetch in the Dockerfile give the identical tree, and the upstream repo and tag
  are public and reachable (verified by `git ls-remote`).
- **Treat the saved image tar as the archive.** Rejected on its own; a digest
  with no recipe is exactly how this became a blocker. The tar is kept as a warm
  cache, and the recipe is what we rely on.
