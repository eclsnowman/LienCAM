# xtask/ - vendored upstream build tool

This directory is an UNMODIFIED copy of `xtask/` from
https://github.com/andymai/occt-wasm at tag `v3.6.1`, commit
`c4a96db7bb6ec7eed294dec42ba92fe4b6e0f580` (OCCT submodule
`6e1fe656bf028bf0004482c389661587b269fc65`). It is the Rust build/codegen tool
that produces our geometry kernel, vendored so that the file
`THIRD_PARTY_LICENSES.md` cites as the home of our local kernel diff -
`xtask/src/codegen/config.rs` - actually exists in this repository.

It is NOT built by any LienCAM script or test. It is build-input provenance:
the target of `patches/occt-wasm-3.6.1-geo9-defeature.patch` and the reference
copy a reader needs to read that diff in context. The kernel build itself runs
in Docker against a full upstream checkout (see `Dockerfile`).

Do not edit these files. Local changes belong in `patches/` so the delta from
upstream stays visible and reviewable.

- `PROVENANCE.md` and `.gitattributes` are LienCAM additions; every other file
  here is byte-identical to upstream (LF endings).
- `xtask/src/codegen/config.rs` upstream sha256 =
  `526e3cb5384431a909834440ce3f191ecf1becf377bfe44a452f67a5da3162ce`
  ; with `patches/occt-wasm-3.6.1-geo9-defeature.patch` applied, sha256 =
  `d53b7fcbc929b31b8ea9d2a0b6098bfd4fe55e3499dfb171324a729411ec5fd8`.
- License: MIT OR Apache-2.0 (upstream occt-wasm build tooling).
