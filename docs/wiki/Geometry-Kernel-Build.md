# Geometry kernel build

LienCAM's solid modelling (fillets, booleans, defeaturing, STEP and IGES) runs on Open CASCADE Technology compiled to WebAssembly. We ship a locally patched build of the open-source `occt-wasm` project. This page says where the pieces are and how to rebuild them.

## What ships

- Upstream: `occt-wasm` 3.6.1 (https://github.com/andymai/occt-wasm), built on Open CASCADE (OCCT).
- The package `package.json` installs is a tarball under `vendor/occt-wasm/`. Earlier tarballs stay beside it as build history.
- The master notice is `NOTICE-GEO9.md` in the repository root. It lists every change we made to upstream and carries the source offer.

## Where the pieces are

| Path | What it is |
| --- | --- |
| `patches/` | The local changes as unified diffs against the pinned upstream tag, with a README saying what each does and in what order they apply |
| `xtask/` | An unmodified copy of upstream's Rust build tool, kept so the patched file can be read in context; `xtask/PROVENANCE.md` says exactly what it is |
| `Dockerfile` | The recipe that fetches upstream at the pinned commits, applies a patch, regenerates the bindings and builds. It currently applies only the defeature patch, so it does not yet reproduce the shipped kernel |
| `NOTICE-GEO9.md` | What changed, the licences, and how to get the source |
| `THIRD_PARTY_LICENSES.md` | Licence duties for everything that ships |

Local changes go in `patches/`, never in `xtask/`, so the difference from upstream stays visible.

## Rebuilding

You need Docker, a network connection and roughly an hour on a cold build (compiling OCCT is the long layer).

```
docker build -t occt-wasm-geo9 -f Dockerfile .
```

The build context is this repository; upstream source is cloned inside the image at the pinned commits, so nothing else is required. The Dockerfile comments explain why code generation is re-run explicitly after the patch applies.

> **The Dockerfile does not yet build the kernel we ship.** It applies only `occt-wasm-3.6.1-geo9-defeature.patch`. The shipped kernel (`occt-wasm-3.6.1-geo9-iges-history-stack.tgz`) also carries the IGES, kernel-history and stack-size patches; without them IGES import, booleans that need history and some fillets break. `patches/README.md` gives the order the four patches apply in (geo9, IGES, history, stack size).

The package stays inside the image: the build output is `/workspace/dist` and `/workspace/ts/dist`. Run `npm pack` in `/workspace/ts`, copy the `.tgz` out with `docker create` and `docker cp`, put it in `vendor/occt-wasm/` with `NOTICE-GEO9.md` beside it, and point the `occt-wasm` entry in `package.json` at it to try it.

## The LGPL source offer

OCCT is licensed LGPL-2.1 with an exception. The licence lets you rebuild and replace the library, and everything you need is in this repository: the pinned upstream commits, the patches, the build recipe and the notice. If you want the corresponding source for a binary you received and cannot find it, open [a discussion](../discussions) and we will point you to it.

See also [Credits](Credits) and [Build from source](Build-from-source).
