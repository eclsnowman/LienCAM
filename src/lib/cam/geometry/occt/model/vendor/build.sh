#!/usr/bin/env bash
# Regenerate occt-model.js/.wasm/.d.ts from occt-model.yml.
# Needs docker (WSL Ubuntu-24.04 on the dev box, or any Linux host):
#   bash src/lib/cam/geometry/occt/model/vendor/build.sh
# WO-3047: build-inside.py first recompiles the image's OCCT 7.6.2 objects with
# native wasm exceptions and -O3 (the image ships them -Os with JS-emulated
# exceptions), then links with the image's own buildFromYaml.py. The objects are
# cached in OCCT_MODEL_CACHE (default ~/.cache/occt-model-wo3047); the first build
# compiles ~5,400 files (about an hour on 4 cores), later builds only relink.
set -euo pipefail
cd "$(dirname "$0")"
CACHE="${OCCT_MODEL_CACHE:-$HOME/.cache/occt-model-wo3047}"
mkdir -p "$CACHE"
docker run --rm -v "$PWD:/src" -v "$CACHE:/cache" -u "$(id -u):$(id -g)" \
  --entrypoint python3 \
  donalffons/opencascade.js:2.0.0-beta.b5ff984 /src/build-inside.py
