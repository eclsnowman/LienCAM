#!/usr/bin/env bash
# Regenerate occt-model.js/.wasm/.d.ts from occt-model.yml.
# Run from WSL (Ubuntu-24.04) where docker is available:
#   bash /mnt/d/worktrees/liencnc-brep/src/lib/cam/geometry/occt/model/vendor/build.sh
set -euo pipefail
cd "$(dirname "$0")"
docker run --rm -v "$PWD:/src" -u "$(id -u):$(id -g)" \
  donalffons/opencascade.js:2.0.0-beta.b5ff984 occt-model.yml
