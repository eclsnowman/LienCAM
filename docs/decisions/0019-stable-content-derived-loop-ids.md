# 0019 — Loop identity is content-derived and stable across re-derivation

Date: 2026-06-13
Status: Accepted

## Context

A `Loop2D`'s `id` was `crypto.randomUUID()`, minted fresh on every loop
derivation (`src/lib/geometry/path2d.ts` join, `stlProjection.ts`,
`deriveBrepLayer`). Operations persist their selection as `params.loopIds`
(pocket / contour / chamfer / drill / face / engrave / AC).

When a geometry's loops are re-derived **in place** — sketch edit + Finish
Sketch, the STL-projection loop optimizer's Apply, B-rep re-derivation,
re-import + repoint — the new loops received brand-new random ids. The
operation's stored `loopIds` then matched nothing, the builder filtered the
selection to empty, and (pre-fix) silently emitted zero moves: the "B19c
disappearing toolpath" bug. ADR-0003 fail-loud later surfaced it as an
actionable "selected loop(s) no longer exist — re-select" error, but the
binding itself was still fragile: every benign re-derive forced a manual
re-select.

The hard constraint going in: a fix that silently re-binds a selection to the
*wrong* loop is quieter and worse than the original bug. The cure must fail in
the safe direction.

## Decision

Loop ids are **content-derived and deterministic**, in two layers
(`src/lib/geometry/loopId.ts`):

- **Content id** — `computeLoopContentId(layerId, points)` = an FNV-1a hash of
  `layerId | quantize(signedArea, 0.01) | quantize(centroidX, 0.01) |
  quantize(centroidY, 0.01)`. Pure function: no randomness, no clock, no
  counter. Quanta (0.01 mm / 0.01 mm²) sit below DXF arc-fit tolerance and
  above float noise, so a tolerance-stable re-derive reproduces the id while a
  genuine geometric change crosses a quantum and yields a new id. Signed (not
  absolute) area distinguishes a CCW boundary from a same-footprint CW hole.

- **Geometry namespace** — `assignStableLoopIds(loops, geoId)` prefixes the
  content id with the owning geometry id (`${geoId}~${contentId}`) and
  deterministically disambiguates intra-set collisions with `#1`, `#2`, … . The
  namespace is **required**: `layerId` is the layer *name* (not globally
  unique; re-importing a file collides) and `__all__` operations flat-map loops
  across every loaded 2D geometry, so ids must be unique across geometries.

Mint sites stamp the content id; every **store attach** path
(`setGeometryLoops`, `appendGeometryProjection`, `deriveBrepLayer`, the
DesignTree import/duplicate paths) stamps the geoId-namespaced id, and relinks
`HoleFeature.loopId`. The store is the source of truth for the id an operation
binds to.

Consequence by construction: an id matches **only if the loop is geometrically
the same**. A genuinely changed loop gets a new id, orphans, and the ADR-0003
fail-loud net fires (re-select) — never a silent wrong-loop cut.

A re-derive still (correctly) marks affected operations as needing recompute
(`outdateOpsReferencingGeo` keys on `geometryId`); the change is that the
recompute now *succeeds* instead of throwing.

## Alternatives considered

- **Keep random uuids (status quo).** Re-derive always orphans; the user must
  re-select after every benign edit. Rejected — that is the bug.
- **Ordinal ids (`geoId:layer:index`).** A re-derive that drops a tiny artifact
  loop or reorders loops shifts every ordinal, so the stored index then points
  at a *different* loop — a silent mis-bind. Rejected for violating the hard
  constraint (dangerous direction).
- **Fuzzy remap in `setGeometryLoops`** (match new→old loops on area/centroid
  with tolerance). On symmetric parts (identical bolt holes, mirrored profiles)
  the matcher can bind to the wrong-but-similar loop. Rejected — same dangerous
  direction. Content hashing fails safe instead: ambiguous/changed → new id →
  fail-loud, not a guess.

## Consequences

- Selections survive benign re-derivation across every UI path that re-derives
  loops (sketch edit, projection optimizer Apply, B-rep re-derive, re-import).
  Verified in the live app (Operator ruling 2026-06-13 verdict walkthrough P2/P6/P7).
- `HoleFeature.loopId` (per-hole drill depths) survives a re-derive — a bonus
  repair. A latent duplicate-geometry store-vs-cache id mismatch is also fixed.
- **New invariant for future code: never re-introduce `crypto.randomUUID()` (or
  any non-deterministic / order-dependent scheme) for loop ids, and stamp the
  geoId namespace at every new loop-attach path.** A new mint or attach site
  that skips `assignStableLoopIds(loops, geoId)` reopens the collision/orphan
  hole.
- Cost in the safe direction only: a sub-quantum geometric wobble could change a
  hash and force an unnecessary re-select — annoying, never a wrong cut.

## References

- `src/lib/geometry/loopId.ts` — `computeLoopContentId`, `assignStableLoopIds`.
- Mint/attach: `src/lib/geometry/path2d.ts`, `src/lib/geometry/stlProjection.ts`,
  `src/store/index.ts` (`setGeometryLoops`, `appendGeometryProjection`,
  `deriveBrepLayer`), `src/components/panels/DesignTree.tsx`.
- Tests: `src/tests/geometry/loopId.test.ts`,
  `src/tests/cam/loop-id-stability.test.ts` (real DXF),
  `src/tests/store/loop-id-rederive.test.ts` (survive + changed-loop-orphans +
  cross-geometry collision).
- ADR-0003 (no silent fallbacks) — the fail-loud net this builds on.
- docs/planning/STABLE-LOOP-ID-PLAN.md; docs/planning/POST-MERGE-WORKPLAN.md B19c.
- Commits: ae298de, 147c8f0, 923b8f2, 7fa3c3d, 78a1018 (precursor 4a1bcda).
