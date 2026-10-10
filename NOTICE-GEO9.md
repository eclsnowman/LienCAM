# occt-wasm 3.6.1 -- locally patched build

This is a locally rebuilt, patched drop-in for the upstream `occt-wasm@3.6.1`
package (https://github.com/andymai/occt-wasm, tag v3.6.1, commit
c4a96db7bb6ec7eed294dec42ba92fe4b6e0f580; OCCT submodule
6e1fe656bf028bf0004482c389661587b269fc65).

This file is the master notice and source offer for the package selected by
`package.json`:
`vendor/occt-wasm/occt-wasm-3.6.1-geo9-iges-history-stack.tgz`. Earlier
tarballs remain in `vendor/occt-wasm/` as build history and contain notices for
their earlier patch levels; this root notice describes the build distributed by
LienCAM now.

## What changed

Four patches are applied to upstream 3.6.1. `defeature()` was rebound from the
stock zero-thickness thick-solid shell path
(`BRepOffsetAPI_MakeThickSolid::MakeThickSolidByJoin(..., 0.0, tolerance)`, which
threw a `WebAssembly.Exception` on real inputs) to OCCT's real feature-removal
algorithm `BRepAlgoAPI_Defeaturing` (which drives `BOPAlgo_RemoveFeatures`), plus
a single-solid-compound unwrap so `isSolid()` / `watertight()` report correctly on
geometrically valid results. IGES reader/writer bindings were added. Boolean
operations use non-destructive mode so OCCT evolution history survives, and
extrude/revolve expose their construction history. The Emscripten C stack is
raised from 64 KB to 8 MB so OCCT fillets do not corrupt the heap.

The change lives in the codegen SOURCE (`xtask/src/codegen/config.rs`, the
`defeature` MethodSpec) and is emitted by `cargo xtask codegen` into
`facade/generated/kernel.cpp`. It is committed in this repository as
`patches/occt-wasm-3.6.1-geo9-defeature.patch`, against the vendored pristine
copy of that file in `xtask/`. The complete patch set is:

- `patches/occt-wasm-3.6.1-geo9-defeature.patch`
- `patches/occt-wasm-3.6.1-iges-import.patch`
- `patches/occt-wasm-3.6.1-kernel-history.patch`
- `patches/occt-wasm-3.6.1-stack-size.patch`

## Artifact hashes (the shipped build)

- `dist/occt-wasm.wasm` sha256 = 493c61e234ece6e070ff4ed5a83c117e16d7111372f23e1de45b725eef2421ff (24,058,625 bytes)
- tarball `occt-wasm-3.6.1-geo9-iges-history-stack.tgz` sha256 =
  22afb27a12a581212e5222539524ea78a8ea853a7fdc6520d92bf50c5ce64bcc

## LGPL-2.1 source availability (OCCT)

The compiled `.wasm` embeds OpenCASCADE Technology, licensed LGPL-2.1-only. To
satisfy LGPL replaceability the consuming app loads the `.wasm` via an explicit,
overridable URL/bytes (`OcctKernel.init({ wasm })`); replace the binary to relink.

Full corresponding source is the upstream repo/tag and OCCT submodule commit
above, plus the four local diffs listed in this notice. The repository retains
`xtask/` as a pristine upstream copy of the build tool and
`xtask/PROVENANCE.md` records its source identity.

Upstream build tooling + the TypeScript wrapper are MIT OR Apache-2.0.

## How to reproduce

Use emsdk 5.0.3, check out the pinned upstream and OCCT commits, apply the four
patches in the order listed above, then run

```
rm -rf facade/generated
cargo xtask codegen
cargo xtask build --release
```

The `rm -rf facade/generated` matters. `cargo xtask build` regenerates the facade
ONLY when `facade/generated/` is missing, and upstream commits that directory, so
without deleting it first the patch compiles to nothing. The packaged copy of this
notice (and the third-party notices file, now `THIRD_PARTY_LICENSES.md`, before WO-1836) claimed upstream's Dockerfile
already ran codegen; it does not, and never did. On 2026-07-09 that step was run by
hand. The `Dockerfile` committed here runs it explicitly.

The patch commands themselves are standard `patch -p1 < <patch-file>` calls.
`src/tests/evidence/WO-1836/GEO-9.report.json` records the original GEO-9 pins
and reproduction result; `src/tests/evidence/WO-1892/` covers history, and
`src/tests/evidence/FORM/kernel-stack/` covers the stack build.

## The 8 MB C stack (Form stage 5, 2026-09-28)

The tarball `vendor/occt-wasm/occt-wasm-3.6.1-geo9-iges-history-stack.tgz` is the
geo9 + IGES + history build with ONE more link flag, `-sSTACK_SIZE=8388608`
(`patches/occt-wasm-3.6.1-stack-size.patch`). Emscripten's default 64 KB stack has
no guard page; OCCT's fillet on a plane / B-spline edge overran it and corrupted the
heap. Only `dist/occt-wasm.wasm` differs from the history tarball (sha256
493c61e234ece6e070ff4ed5a83c117e16d7111372f23e1de45b725eef2421ff, 24058745 bytes); the JS glue and the TypeScript wrapper are unchanged.
Built natively (no Docker) with emsdk 5.0.3 at the pinned commits, the four patches
applied in order, `rm -rf facade/generated`, `cargo xtask codegen`,
`cargo xtask build --release`; see `src/tests/evidence/FORM/kernel-stack/`.

