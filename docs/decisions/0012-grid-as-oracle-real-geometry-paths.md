# 0012 — Grid as occupancy oracle; real geometry for all path representation

Date: 2026-05-24
Status: Accepted

## Context

The morphProto prototype built the morph rings as marching-squares isocontours
(linear interpolation between cell-center distances), the spiral as a ring-blend
lerp of those isocontour polylines, and the ring-march arcs as row/column scans of
the entry-FMM distance field. Over multiple development sessions, this produced
persistent geometric defects across the full shape family:

- **Jagged ring polylines.** Cell-grid faceting is visible at every zoom level on
  every shape — an intrinsic property of the marching-squares cell-boundary
  polyline, not a resolution or parameter problem.
- **Drifting stepover.** The ring-blend lerp blends two marching-squares
  polylines; the lerp inherits their quantization offsets, producing non-uniform
  ring spacing that accumulates across revolutions.
- **Artificial / wrong spiral terminations.** The retrace-arc truncation metric
  (`ringRetraceGapFires()`) measures arc and chord on marching-squares polyline
  vertices that carry ~0.625mm cell-quantization noise. This caused the truncation
  trigger to fire at incorrect ring indices on some geometries and required a
  wide noise-gate parameter (AC_TRUNCATE_MARGIN=2.0) to suppress false positives —
  without eliminating the underlying instability.
- **Arc-to-wall termination variance.** Arc-march arcs end where the row/column
  scan crosses a cell boundary, not at the true geometric intersection with the
  alley wall. Measured baseline standard deviation ≈ 0.313mm on the paisley vs.
  ≈ 0.094mm on straight arms. This is a hard quality failure (uneven surface
  finish + dimensional inaccuracy), and it is structural, not tunable.

Despite targeted fixes over multiple sessions (NaN guards, three-case
interpolation, truncation parameter tuning, boundary-intersection closing pass),
the defects persisted across the shape family. The domain expert observed the
pattern: these are not isolated bugs in a correct substrate. They are structural
consequences of deriving path geometry from grid-cell coordinates. The substrate
is wrong.

## Decision

The grid (and the fast-marching distance field computed on it) is demoted to a
single role: **occupancy oracle**. It answers exactly one kind of question:
"is this area cleared or uncut?" — for collision checking, coverage decisions,
region detection, and truncation-level determination. It stamps and confirms
cut-vs-uncut. Nothing else.

**All path geometry is real geometry**, maintained correctly from creation:
offsets from boundaries, arcs, polylines, true curve/line intersections, real
points in continuous space. Cell-resolution polylines, marching-squares contours,
and lerp-between-cell-center constructions are never the path representation.

**Governing principle: Make and maintain good geometry. Never generate poor
geometry to correct later.**

The fast-marching field **may remain as the solver** that computes geodesic
distance, informs ring spacing, identifies truncation levels, and drives
ring-march progress. But the field's discretization must never appear as faceting
in a path. The field tells the geometry layer *where* a ring or arc should be;
real-geometry constructions (boundary offsets, smooth curves, true intersection)
express *what* the path actually is.

## What is preserved

- **The FMM field as solver/oracle.** `rasterizePocket()`, `runFastMarching()`,
  `findSeed()`, `distAtWorldPos()`, and `runEntryOnlyFMM()` all remain.
- **The occupancy grid** for `isCleared()` / cut-vs-uncut queries.
- **All behavioral logic:**
  - M0 truncation coupling (connectivity-split and retrace-truncation compose via
    `min(level)`) — the *trigger* mechanism is preserved; only the geometry the
    metric operates on changes.
  - Region/connectivity detection: `findIsolatedRegions()`,
    `detectSplitsByStockConnectivity()`, `findEntrySeedCells()`.
  - Arc-march-down-alley intent: one open-arc series per region, marching from
    entry toward the far end, handedness derived from spiral winding.
  - Spiral winding as single source of climb direction (`spiralWinding()`).
  - The `spiralClosingPass()` boundary-intersection approach (already uses
    `segSegIntersect()` — already real geometry).
  - The principle that geometry is emergent from the field, not bent after the
    fact (established in the steering revert; generalized here to the substrate).
- **All validated behavioral properties:** the morph ring's flow-around-islands
  with emergent merge seam, wall-parallel outer rings, truncation→ring-march
  handoff, and the two-trigger composition.

## What changes

The following sources of path-geometry generation are superseded:

- **`marchingSquares.ts` as a path source.** `extractContour()` and
  `extractRings()` produce grid-quantized cell-boundary polylines. These may
  continue to exist as diagnostic tools or shape-locating guides, but must not
  be the representation that ring paths are built from.
- **Ring-blend spiral on marching-squares loops.** `sampleLoop()` and the
  lerp-blend in `buildMorphSpiral()` / `buildMorphSpiralTruncated()` operate on
  marching-squares polylines. The spiral must be rebuilt on real offset curves.
- **Row/column-scan arc extraction.** `extractOpenArcsFromField()` produces
  arc polylines whose points are single-crossing-per-row-or-column grid scans.
  Arc-march arcs must be constructed as real curves clipped to alley boundaries.
- **`ringRetraceGapFires()` operating on marching-squares loop vertices.** The
  arc/chord measurement for the retrace metric must operate on real-ring geometry
  points. (The grid-oracle part of the metric — "is there uncut stock adjacent
  to this midpoint?" — remains as oracle use.)

## Alternatives considered

**Smoothing / upsampling grid-derived geometry.** Fitting Catmull-Rom splines or
similar to the marching-squares polyline; upsampling to reduce visible faceting.
Rejected: this is making poor geometry and correcting it later, which violates the
governing principle. The root cause is not resolution; the substrate is wrong.
Smoothing a grid-cell polyline still leaves the implicit grid-cell topology
constraining the path's shape, its seam positions, and its termination behavior.
The truncation-metric noise and arc-to-wall termination variance are structural
properties of the cell-boundary crossing method, not resolution artifacts.

**Increasing grid resolution.** Resolution is a computational cost parameter, not
a path-quality guarantee. The correct path should be correct at any resolution,
not merely less wrong at higher resolution.

## Consequences

**Positive:**
- Jaggedness, drifting stepover, and arc-to-wall termination variance are resolved
  at the substrate level, not per-defect.
- The retrace metric operating on real ring geometry will have accurate arc/chord
  measurements, removing the noise that required the wide AC_TRUNCATE_MARGIN gate.
- Future work (steering, lead-in/out, trim/extend) builds on a correct substrate.
- The "geometry stays emergent" working discipline (HANDOFF.md §Working Discipline)
  now has a named architectural home.

**Negative / cost:**
- The morph rings, spiral, and ring-march arcs must all be rebuilt on
  real-geometry foundations. This is a significant re-architecture of
  `morphSpiral.ts` and `ringMarch.ts`, and changes the role of `marchingSquares.ts`
  from path-source to diagnostic/locating tool.
- The relationship between FMM isocontours (which encode geodesic flow around
  islands and narrow passages) and real-geometry offset curves (which encode
  euclidean offset from the boundary) requires design care at non-convex features.
  This is the main risk in the re-architecture; see the staged plan in STATUS.md.

## References

- Morph prototype: `src/lib/cam/adaptiveClearing2d/morphProto/` (fastMarching.ts,
  marchingSquares.ts, morphSpiral.ts, ringMarch.ts)
- Architecture doc: `docs/research/adaptive-clearing-architecture.md` §1a (new),
  §6 Q1 (amended)
- Re-architecture plan: `src/lib/cam/adaptiveClearing2d/REAL_GEOMETRY_PLAN.md`
- Decision prompted by: domain expert's architectural directive, 2026-05-24,
  after observing multi-session persistent defects across the shape family
  attributable to grid-cell path substrate
