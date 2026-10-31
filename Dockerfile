# syntax=docker/dockerfile:1
#
# LienCAM geometry kernel (GEO-9 / BK-65) - reproducible build recipe.
#
# Builds the patched occt-wasm package we ship as
# vendor/occt-wasm/occt-wasm-3.6.1-geo9-bk65.tgz. Derived from the upstream
# Dockerfile at github.com/andymai/occt-wasm v3.6.1 (same layer order, same
# emsdk base, same cmake flags), with one LienCAM change: the layers that
# fetch upstream source, apply patches/occt-wasm-3.6.1-geo9-defeature.patch and
# re-run `cargo xtask codegen` before the facade is compiled.
#
#   docker build -t occt-wasm-geo9 -f Dockerfile .
#
# The build context is THIS repository; upstream source is cloned inside the
# image at the pinned commits below, so nothing outside this repo is required.
# Needs network (git, rustup, npm, RapidJSON) and roughly an hour: the OCCT
# cmake layer is ~60 minutes cold.
#
# WHY codegen runs here and not upstream: `cargo xtask build` regenerates the
# facade only when facade/generated/ is MISSING, and upstream commits that
# directory. Our patch edits the codegen SOURCE (xtask/src/codegen/config.rs),
# so without the explicit `rm -rf facade/generated` + `cargo xtask codegen`
# below the patch would compile to nothing. The third-party notices file claimed
# upstream's Dockerfile already did this; it does not. (WO-1836)
#
# PROVENANCE / VERIFICATION: the build that produced the tarball we ship today
# ran on 2026-07-09 and survives as the local image occt-wasm-geo9,
# sha256:a8d33bde699ac9ea842a7ed1d5b4255ded879b99980e33d069c32f5d570b7892
# (docker save backup: kernel-images/). WO-1836
# reproduced our generated facade and .wasm from the inputs committed here,
# inside that image, using src/tests/evidence/WO-1836/rebuild-proof.sh - see
# that directory for hashes and logs. This Dockerfile is the from-scratch
# recipe for the same inputs; it was NOT executed end-to-end in WO-1836.

FROM emscripten/emsdk:5.0.3

ARG OCCT_WASM_REPO=https://github.com/andymai/occt-wasm.git
ARG OCCT_WASM_TAG=v3.6.1
ARG OCCT_WASM_COMMIT=c4a96db7bb6ec7eed294dec42ba92fe4b6e0f580
ARG OCCT_SUBMODULE_COMMIT=6e1fe656bf028bf0004482c389661587b269fc65

# --- Layer 1: System packages (rarely changes) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    libclang-dev \
    cmake \
    ninja-build \
    ccache \
    patch \
    git \
    && rm -rf /var/lib/apt/lists/*

# Enable ccache for C++ compilation
ENV CCACHE_DIR=/cache/ccache
ENV CC="ccache gcc"
ENV CXX="ccache g++"

WORKDIR /workspace

# --- Layer 2: Upstream source at the pinned commits ---
# Fetched here rather than COPY'd so this repo does not have to vendor a
# 360 MB checkout; the pins make the result identical either way.
RUN git init -q . \
    && git remote add origin "$OCCT_WASM_REPO" \
    && git fetch -q --depth 1 origin "refs/tags/$OCCT_WASM_TAG" \
    && git checkout -q FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$OCCT_WASM_COMMIT" \
    && git submodule update -q --init --depth 1 occt \
    && test "$(git -C occt rev-parse HEAD)" = "$OCCT_SUBMODULE_COMMIT" \
    && echo "wrapper $(git rev-parse HEAD) / occt $(git -C occt rev-parse HEAD)"

# --- Layer 3: Rust toolchain (changes only on toolchain bump) ---
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain "$(grep channel rust-toolchain.toml | cut -d'"' -f2)"
ENV PATH="/root/.cargo/bin:${PATH}"

# --- Layer 4: Node dependency cache ---
RUN (npm ci --ignore-scripts || npm install --ignore-scripts) \
    && cd ts && (npm ci || npm install)

# --- Layer 5: RapidJSON fetch + patch (rarely changes) ---
RUN bash scripts/fetch-rapidjson.sh

# --- Layer 6: OCCT cmake build (THE EXPENSIVE LAYER ~60 min) ---
# Flags are upstream's, verbatim. BuildKit cache mount persists ccache.
RUN --mount=type=cache,target=/cache/ccache \
    mkdir -p occt/build && cd occt/build \
    && emcmake cmake .. \
        -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_MODULE_FoundationClasses=TRUE \
        -DBUILD_MODULE_ModelingData=TRUE \
        -DBUILD_MODULE_ModelingAlgorithms=TRUE \
        -DBUILD_MODULE_DataExchange=TRUE \
        -DBUILD_MODULE_ApplicationFramework=TRUE \
        -DBUILD_MODULE_Visualization=FALSE \
        -DBUILD_MODULE_Draw=FALSE \
        -DBUILD_LIBRARY_TYPE=Static \
        -DUSE_FREETYPE=OFF \
        -DUSE_RAPIDJSON=ON \
        -D3RDPARTY_RAPIDJSON_INCLUDE_DIR=/workspace/3rdparty/rapidjson \
        -DCMAKE_C_FLAGS="-fwasm-exceptions -O3 -msimd128 -DIGNORE_NO_ATOMICS=1 -DOCCT_NO_PLUGINS" \
        -DCMAKE_CXX_FLAGS="-fwasm-exceptions -O3 -msimd128 -DIGNORE_NO_ATOMICS=1 -DOCCT_NO_PLUGINS" \
        -Wno-dev \
    && cmake --build . --parallel \
    && echo "OCCT build complete: $(ls -1 lin32/clang/lib/*.a 2>/dev/null | wc -l) static libs"

# --- Layer 7: THE LIENCAM PATCH ---
# Our only divergence from upstream v3.6.1. Applied to the codegen SOURCE, then
# the committed generated facade is deleted so codegen has to re-emit it.
COPY patches/ /liencam-patches/
RUN patch -p1 --no-backup-if-mismatch < /liencam-patches/occt-wasm-3.6.1-geo9-defeature.patch \
    && rm -rf facade/generated \
    && cargo run --release --package xtask -- codegen \
    && test -f facade/generated/kernel.cpp \
    && grep -q BRepAlgoAPI_Defeaturing facade/generated/kernel.cpp

# --- Layer 8: facade compile + link + wasm-opt ---
RUN --mount=type=cache,target=/cache/ccache \
    cargo run --release --package xtask -- build --release \
    && sha256sum dist/occt-wasm.wasm dist/occt-wasm.js

# --- Layer 9: TypeScript package + upstream test suite ---
RUN cd ts && npm run build && npx vitest run

# Output is /workspace/dist and /workspace/ts/dist. Package it with
# `npm pack` from ts/ and drop NOTICE-GEO9.md in beside dist/ (see
# NOTICE-GEO9.md and THIRD_PARTY_LICENSES.md).
