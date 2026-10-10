# 0023 — Spatial index (ClearedIndex) for cleared engagement queries

Date: 2026-06-15
Status: Rejected (2026-06-16) — see Outcome. The mechanism was implemented and measured; it
both changed geometry AND was slower. Do NOT rebuild it.

## Context

The adaptive-clearing engine (`src/lib/cam/adaptiveClearing2d/engine/`, the open-source CAD/CAM system
Adaptive2d clean-room port) accumulates a `cleared` polygon set as it cuts: the union of
every swept tool corridor so far. On every engagement query the engine asks "how much of
the tool disk near point P overlaps already-cleared stock?" via
`toolGeometry.ts` `clearedNear(cleared, from)` -> `intersection(cleared, rect)`, then
`difference(shape, clearedNear(...))`. `clearedNear` is called inside `tool.cutArea`, which
`steering.findNextPoint` invokes up to ~12x per step, across hundreds of passes.

`cleared` grows without bound: by the end of a large pocket it is a single polygon with
many thousands of edges. Each `clearedNear` cache miss runs `intersection(cleared, rect)`,
which is O(edges of the whole `cleared` set) even though the query only needs the handful
of edges geometrically near `rect`. This makes engagement querying the dominant non-steering
cost. Measured baseline: a 300x200 mm pocket (D3 tool, 25% stepover) takes ~572 s (~9.5 min);
processFeature flags this engagement query as the dominant cost (POST-MERGE-WORKPLAN Group 5,
B7).

A `cleared`-reader census (recon, 2026-06-15) established that `clearedNear`
(`toolGeometry.ts:95-118`) is the SOLE truly hot reader, but it is not the only reader of the
whole monolith: the per-reseed `difference(cutRegion, cleared)`, the final
`residual = difference(targetRegion, cleared)`, the returned `FeatureResult.cleared` field
(consumed by the process-feature coverage/gouge, visual-dump, and large-area-repro tests), and
the B8 ride/landing gates all consume the full polygon. The four write sites that grow
`cleared` are the `expandCleared`/`union` calls in `processFeature.ts` (corridor fold, reseed
seed-disk, finish band) plus the seed-disk initialization.

## Decision

Introduce a uniform-grid spatial index, `ClearedIndex`, in a new file
`src/lib/cam/adaptiveClearing2d/engine/clearedIndex.ts`, and accelerate ONLY the hot
`clearedNear` query with it. The monolithic `cleared` union is KEPT and remains fully
populated for every cold/whole-polygon reader and the `FeatureResult.cleared` field.

- **Structure.** A uniform grid of square tiles. As each cleared corridor piece is folded in,
  it is bucketed into every tile its bounding box overlaps, stored WHOLE (never pre-clipped to
  the tile). Tile size is a tuning knob on the order of a few tool diameters.
- **Query.** `clearedNear(from)` collects the buckets whose tiles overlap the query rect, unions
  those whole pieces, and clips the result to the rect. Because union is commutative and
  associative, `union(pieces overlapping rect) clipped to rect` is mathematically identical to
  `intersection(wholeCleared, rect)` — the index changes only WHICH edges enter the boolean op
  (the local ones), never the result.
- **Updates.** The index is updated at the same four sites that grow the monolith
  (`processFeature.ts` corridor fold, reseed seed-disk union, finish band union, and the seed-disk
  init), so the index and the monolith never diverge.
- **Invariant (the gate).** This is a SPEED change, not a geometry change. The AC bytestab
  fingerprint (`_bytestab-fingerprint.test.ts`, sha256 of `{startPoint, entries, passes}` over
  all 9 gt fixtures) MUST be byte-IDENTICAL before and after. That gate is stronger than any
  per-rule geometry check and is the correctness argument for this ADR.

## Alternatives considered

- **Retire the monolith entirely, store only the index.** Rejected for now: cold readers
  (reseed residual, final residual) and the `FeatureResult.cleared`/`residual` fields — the last
  load-bearing for three test gates — need the whole polygon. Migrating those off `res.cleared`
  is a separable follow-up; doing it here would balloon the change and risk the byte-stability
  gate. Default per the plan: keep the monolith, accelerate `clearedNear` only; retire later if
  justified.
- **Pre-clip corridor pieces to tile boundaries when bucketing.** Rejected: clipping at tile
  seams introduces seam artifacts and extra edges, and the per-tile fragments would not re-union
  to the exact original. Storing whole pieces and clipping only the final local union to the
  query rect reproduces today's result exactly.
- **A tree index (quadtree / R-tree) instead of a uniform grid.** Rejected as premature: the
  query is always a small fixed-size rect (tool-disk neighborhood), so a uniform grid sized to a
  few tool diameters gives O(local edges) lookups with far less code and no rebalancing. Can be
  revisited if a non-uniform workload appears.

## Consequences

- Positive: `clearedNear` cost drops from O(all cleared edges) to O(edges near the query rect),
  attacking the dominant large-area cost. Geometry is provably unchanged (byte-stability gate).
- Positive: tile size is a pure speed knob — it changes bucket granularity only, never the
  unioned/clipped result, so it can be tuned without re-validating geometry.
- Negative: the monolith and the index are both maintained, so writes do a little extra
  bookkeeping (bounded, off the hot read path) and there is a second structure to keep correct —
  mitigated by updating both at the identical four write sites and by the byte-stability gate.
- Opens a follow-up: if a future change migrates the cold whole-polygon readers and the
  `FeatureResult.cleared` test assertions off the monolith, the monolith could be retired and the
  index become the sole representation. That is explicitly out of scope here.

## Outcome (2026-06-16): REJECTED — do not rebuild

The index was implemented (parked on branch `perf/ac-b7-index-experiment-bytestab-fails`,
commit `9503604`) and measured. It failed on BOTH axes the decision rested on:

1. **Not byte-identical.** 5 of 9 gt fixtures reproduced the fingerprint exactly; 4 did NOT
   (SquareIsland, BootL, Triangle, Barbell — the island/concave fixtures). The core assumption
   "union is associative, so `intersection(union(local pieces), rect)` equals
   `intersection(monolith, rect)`" is true as a SET identity but FALSE bit-for-bit: clipper2 is
   not bit-stable under subset-vs-whole union, especially where the accumulated region has holes.
   The sub-micron vertex differences perturb the engagement area enough to shift a few steering
   decisions, cascading into +/- a handful of passes. The BootL change also broke the staydown
   "over-cap landing descends via helix" safety test.
2. **Slower, not faster.** On the 300x200 D3 25%-stepover reference pocket: baseline 572,070 ms ->
   index 808,521 ms = **1.41x SLOWER**. On a large area, many corridor pieces overlap each query
   rect, so unioning them per cache-miss costs more than the single, already box-cached
   `intersection(monolith, rect)` the index replaced.

Conclusion carried forward: a byte-IDENTICAL speedup of the clipper-based engagement query appears
unachievable — any change to what is fed to the final clip risks a low-order-bit difference, and the
only output-identical edge reduction (dropping loops fully outside the rect) does not help because
the accumulated `cleared` is typically one big connected loop. A meaningful B7 speedup therefore
requires a deliberate, deterministic GEOMETRY change (e.g. a raster occupancy oracle per ADR-0012, or
integer-scaled clipper) followed by re-baselining the fingerprint after a visual sign-off — not a
"speed-only" refactor. See `docs/planning/AC-PERF-BASELINE.md` and the review artifact
`review-images/ac-b7-bytestab-diff-review.html`.

## References

- `src/lib/cam/adaptiveClearing2d/engine/clearedIndex.ts` (new), `toolGeometry.ts` `clearedNear`
  (the sole accelerated reader), `processFeature.ts` (the four `cleared` write sites + monolith).
- Gates: `src/tests/adaptive-clearing/engine/_bytestab-fingerprint.test.ts` (byte-stability),
  `_large-area-repro.test.ts` (timing). Baseline recorded in `docs/planning/AC-PERF-BASELINE.md`.
- Plan: `docs/planning/AC-PERF-PLAN.md` (Items 2-3); `docs/planning/POST-MERGE-WORKPLAN.md` Group 5.
- Related: ADR-0012 (grid as occupancy oracle; real geometry for all path representation) — this
  index is an occupancy/query accelerator, not a path representation, consistent with 0012.
