# Real-Geometry Path Re-Architecture Plan

**Anchor commit:** `435d2cf` (branch: adaptive-clearing-v1)
**Governing decision:** ADR-0012 — `docs/decisions/0012-grid-as-oracle-real-geometry-paths.md`
**Status:** SUPERSEDED (2026-06-16) - this morph-ring / FMM-oracle re-architecture (ADR-0012) was replaced by the FreeCAD Adaptive2d port. Historical only; see docs/planning/AC-PERF-HANDOFF.md.

---

## CORRECTIONS applied 2026-05-25

Three findings after the original plan was drafted require correction before execution.

**C1 — Rings: euclidean offsetPolygon REFUTED by measurement.**
The original plan proposed `ring_k = offsetPolygon(boundary, islands, inward_offset_k)`. Measurement
showed euclidean offset flattens with distance and fails on curved alleys: Paisley (same ring crosses
the alley at two geodesic positions / runs parallel to walls), Barbell far bulb (6–49× too flat).
Euclidean offset does NOT hold ring shape in curved regions. Corrected approach: FMM field LOCATES
where each ring is (correct geodesic topology); real geometry EXPRESSES it via FMM-angular-sort.

**C2 — Arcs: proven method is field-scan ordering + `_rayHit` endpoint trimming, NOT offset of entry frontier.**
`realGeomProof.ts` (validated on Paisley) achieved wall-gap std 0.000mm using: same first-per-scan-line
field-scan ordering as `extractOpenArcsFromField` (correct curved-alley topology) + true endpoint
intersection via `_rayHit` ray cast. The original "preferred" approach (offset of entry frontier polygon)
is superseded as the arc endpoint method. Arc interior real-geometry (interior kinks) remains the next
Stage 2 work.

**C3 — Islands: `offsetPolygon` does NOT handle islands "by nature."**
`offsetPolygon()` takes a single polygon ring. Island support requires a new primitive (`offsetPocket` /
multi-polygon offset with boolean merge — Clipper-equivalent). Square+Island is **BLOCKED** until that
primitive exists. Do NOT attempt island support in Stages 1–2.

---

## Confirmed grid-artifact defects (the two distinct defects driving this rebuild)

Two distinct root causes, two distinct fixes. Both are resolved structurally by the re-architecture.

**(a) Squarish near-seed spiral** — root cause: marching-squares ring polygons + discrete seam-snap.
The marching-squares topology forces segments within one cell (H/V/diagonal at cell-edge scale),
creating staircase appearance. The seam-snap (`alignLoop()`) adds a discrete jump at the re-index
seam. Fix: real-geometry rings (Stage 1) eliminate the staircase; smooth spiral-blend (Stage 4)
eliminates the seam artifact.

**(b) Arc interior kinks** — root cause: interior arc points are first-per-scan-line grid-pitch
polyline (one point per row or column, ±h/2 ≈ ±0.3mm jitter). Fix: real-geometry arc interiors
(Stage 2 interior work, after endpoint proof).

These are distinct problems with distinct fixes in the staging. Stage 1 addresses (a).
The arc endpoint proof (`realGeomProof.ts`) resolved wall-gap variance. Interior work addresses (b).

---

## What stays

The following are KEEPER and must not be removed or gutted:

| Component | File | Role | Why it stays |
|---|---|---|---|
| `rasterizePocket()` | fastMarching.ts | Grid setup | Creates occupancy grid — pure oracle setup |
| `findSeed()` | fastMarching.ts | Seed location | BFS oracle; seed position needed to start real-geometry ring family |
| `runFastMarching()` | fastMarching.ts | FMM solver | The solver itself; produces distance field that drives ring-level spacing |
| `distAtWorldPos()` | morphSpiral.ts | Oracle query | World-space distance lookup; used for truncation metric and alley decisions |
| `seedWorldPos()` | fastMarching.ts | Coordinate | Cell-to-world for the seed; minor, tolerable cell-center quantization at one point |
| `spiralWinding()` | morphSpiral.ts | Climb source | Single source of truth for climb direction; arcs derive handedness from it |
| `spiralClosingPass()` | morphSpiral.ts | Intersection | Already uses `segSegIntersect()` — already real geometry |
| `ringRetraceGapFires()` grid queries | morphSpiral.ts | Oracle | "Is there uncut stock adjacent to this segment midpoint?" queries stay grid-oracle |
| `findIsolatedRegions()` | ringMarch.ts | Region oracle | BFS on occupancy grid — pure oracle |
| `findEntrySeedCells()` | ringMarch.ts | Entry oracle | Cells adjacent to cleared material — oracle |
| `runEntryOnlyFMM()` | ringMarch.ts | Arc solver | Entry-only FMM solver; produces progress-along-alley field |
| `enforceArcHandedness()` concept | ringMarch.ts | Direction | Cross-product rule is real geometry; will apply to real-geometry arcs |
| `detectSplitsByStockConnectivity()` | reMorph.ts | Split oracle | Grid-based connectivity check — oracle |

---

## What gets gutted (grid-cell path sources)

These are the current grid-cell path generation sites, enumerated by file/function:

### marchingSquares.ts — `extractContour()` / `extractRings()`
**Current behavior:** Produces ring paths as marching-squares cell-boundary polylines. Points are lerp'd between adjacent cell-center distances on a 0.625mm grid. The polyline shape is constrained to follow cell grid edges, producing grid-faceting on every ring.
**Role in current pipeline:** These loops are the direct input to `buildMorphSpiral()` and `buildMorphSpiralTruncated()` — they ARE the rings today.
**Disposition:** Demoted to diagnostic/locating tool. Not deleted (useful for debugging where a ring *should* be), but must not be the source of path points.

### morphSpiral.ts — ring-blend spiral construction
**Current behavior:**
- `buildLoopSampler()` / `sampleLoop()`: arc-length parameterization of the marching-squares polyline loops.
- `alignLoop()`: re-indexes marching-squares loop vertices by closest-to-reference.
- `signedArea2x()`: signed area of the marching-squares loop (for winding detection).
- The lerp-blend itself: `pt = lerp(ring_k.sample(t), ring_{k+1}.sample(t), t)` — blends two faceted cell-boundary polylines.
**These all inherit grid-cell quantization through their input.**

### morphSpiral.ts — `ringRetraceGapFires()` vertex operations
**Current behavior:** The arc/chord measurement operates on the marching-squares polyline vertex array. Productive/retrace classification already uses the grid as oracle (correct). But measuring `arc` (sum of segment lengths) and `chord` (endpoint distance) on grid-faceted vertices produces noisy arc/chord ratios that required AC_TRUNCATE_MARGIN=2.0 to suppress.
**Disposition:** The oracle queries (midpoint → grid → free && dist >= level) stay. The arc/chord measurement moves to real-ring geometry.

### ringMarch.ts — `extractOpenArcsFromField()`
**Current behavior:** For each arc level, scans rows and columns of the `arcDist` field, taking the first horizontal crossing per row (or vertical crossing per column), producing one point per row/col. Assembles these into a polyline. Takes whichever scan (row vs col) yields more points.
**The result:** A jagged single-crossing-per-scan-line polyline whose points are grid-cell boundary artifacts. Endpoints land at grid cell-boundaries, not at the true wall geometry.
**This is the direct cause of arc-to-wall termination variance (std ≈ 0.313mm).**

### ringMarch.ts — `sampleOpenArc()`, `arcMidpoint()`, `applyOpenArcRateLimit()`
These operate on the above grid-scan polylines and will be rebuilt or removed when the arcs become real geometry.

---

## What replaces it — real-geometry construction per component

### (a) Morph rings — FMM-field-located real-geometry (CORRECTED — C1)

**⚠ CORRECTION C1: The original plan proposed `offsetPolygon(boundary, islands, inward_offset_k)`.
This was measured and REFUTED. Euclidean offset flattens on curved alleys and fails on the Paisley
and Barbell fixtures. The approach below supersedes it.**

**Principle:** The FMM field LOCATES where each ring is — at geodesic distance `L` from the seed,
with correct topology everywhere (around islands, through necks, in curved alleys). The ring is
EXPRESSED as real geometry: a smooth closed polygon derived directly from the FMM field values, not
from marching-squares cell-boundary polylines and not from euclidean boundary offset.

**Construction — FMM-angular-sort (for simply-connected shapes):**

For each ring level `L`:
1. Scan all horizontal cell-edge pairs `[r,c]↔[r,c+1]` and vertical pairs `[r,c]↔[r+1,c]`.
   Wherever adjacent FMM distance values straddle level `L`, compute the interpolated crossing
   position in world space: `t = (L - d0)/(d1 - d0)`, world x/y from grid coordinates.
2. Collect all such crossing positions (H-crossings + V-crossings).
3. Sort by angle from the seed world position (atan2 from seed).
4. Deduplicate very close points (within `h/4`).
5. Connect in angular order → smooth closed polygon.

**Why this works for simply-connected shapes:**
- Jordan-curve property: every FMM ring in a simply-connected pocket encircles the seed.
- Monotone-radial property: the FMM distance is monotone along any ray from the seed, so each
  ray crosses the ring at level `L` exactly once.
- Therefore angular sort from seed correctly orders all ring crossing positions into a single
  non-self-intersecting closed polygon.

**What is preserved from the FMM field:** The crossing positions are interpolated from the actual
FMM distance values (`d0`, `d1`), so the ring points are geodesically correct — the ring follows
the field topology, not euclidean offset geometry.

**Island support — BLOCKED (Correction C3).** `offsetPolygon()` takes a single polygon ring.
The FMM-angular-sort approach also handles only a single seed-encircling loop; islands create
disconnected ring arcs that cannot be sorted angularly from one seed. Island support requires
`offsetPocket` (multi-polygon offset with boolean merge — Clipper-equivalent), not yet built.
Square+Island is blocked until that primitive exists. Do not attempt.

**FMM field role after this change:** The FMM solver still runs for `maxDist`, `findSeed()`, and
ring-level spacing. Ring SHAPES come from FMM-angular-sort, not from `extractRings()` or `offsetPolygon()`.

### (b) Outward spiral — ring-blend on real-geometry rings

**Construction:** Same ring-blend Archimedean technique as today, but with real-geometry (angular-sort)
ring polygons as input instead of marching-squares polylines:
```
pt(t) = lerp( real_ring_k.sample(t),  real_ring_{k+1}.sample(t),  t )
```
The `sampleLoop()` arc-length parameterization works the same way on a real polygon. `alignLoop()`
works the same way (re-index by closest vertex to reference). `signedArea2x()` gives accurate winding
on a real polygon.

**What changes:** The input to all these functions. The functions themselves may be usable with minor
signature changes.

### (c) Arc-march arcs — proven real-geometry construction (CORRECTED — C2)

**⚠ CORRECTION C2: The original plan's "preferred" approach (offset of entry frontier polygon) is
superseded by the PROVEN method from `realGeomProof.ts` (validated on Paisley, wall-gap std 0.000mm).**

**PROVEN method** (`realGeomProof.ts`, validated on Paisley):
- Inherits `extractOpenArcsFromField`'s first-per-scan-line field-scan ordering (correct wall-to-wall
  topology through curved alleys — no greedy-NN stranding).
- Replaces arc endpoints with precise boundary intersections via `_rayHit`: cast a ray from the near-endpoint
  in the endpoint direction, take first hit on the boundary polygon.
- Result: wall-gap std **0.000mm** on Paisley (vs. baseline 0.313mm with grid-scan endpoints).

**Arc interior points (remaining work):** Interior arc points are still first-per-scan-line grid-pitch
polyline (one point per row/col, ±h/2 ≈ ±0.3mm). Interior kinks remain — this is the next Stage 2 work.

**Aspirational approach for interior real-geometry (Stage 2 interior, future):** Offset of the entry
frontier polygon → arcs as real-geometry curves clipped to alley walls via `segSegIntersect()`.
This requires expressing the cleared-material frontier as a real polygon (same geodesic-vs-euclidean
design care as rings). Deferred: the proven endpoint-only method is the correct staging point before
committing to frontier-offset construction.

### (d) Boundary/termination intersections

Already real geometry in `spiralClosingPass()` via `segSegIntersect()`. This stays as-is. For arc
endpoints, the `_rayHit` pattern (used in `realGeomProof.ts`) is the proven extension.

---

## Interface: oracle layer vs. geometry layer

The grid oracle is queried by world-space position only. The geometry layer constructs paths using real polygons and real intersection. Clear separation:

| Query type | Who answers | How |
|---|---|---|
| "Is this point cleared?" | Grid oracle | `distAtWorldPos(g, pt) < splitLevel` |
| "Is there uncut stock adjacent to this ring segment?" | Grid oracle | midpoint → nearest cell → check free && dist >= level neighbors |
| "What is the geodesic distance at this point?" | Grid oracle | `distAtWorldPos(g, pt)` |
| "What does ring k look like?" | Real geometry | FMM-angular-sort: interpolated crossings at level_k, sorted by angle from seed |
| "Where does this arc end?" | Real geometry | `_rayHit(near-endpoint, dir, boundary-polys)` |
| "What is the entry frontier polygon?" | Future work | `offsetPolygon(boundary, islands, maxDist - splitLevel)` — deferred to Stage 2 interior work |

---

## Staging — proposed sequence

**Stage 1 — Real-geometry rings (prove on L-shape)**

Replace the marching-squares ring polyline as path representation with the FMM-angular-sort ring
polygon: for each ring level, collect all H and V interpolated crossings from the FMM field, sort
by angle from seed, deduplicate, connect → smooth closed polygon.

**First fixture: L-shape** (simply-connected, no islands, no truncation). Proves the approach on
the simplest shape — no islands, no barbell neck, no curved-alley geodesic-vs-euclidean divergence.
The L-shape's rings are star-shaped from the seed at all levels, so angular sort is correct.

Stage 1 does NOT change the spiral or ring-march yet. It is a new overlay layer in the morph-viewer
only (`realGeomRings` field in the L-shape m0 fixture JSON, rendered as lime-green rings). The expert
compares real-geometry rings vs. marching-squares rings side-by-side.

**Visual-review gate:** Rings are smooth (no staircase); stepover is even across rings; rings follow
the L-shape reflex corner correctly; no kinks at the corner.

Stage 1 is independently verifiable: the real-geometry rings are a separate layer toggle in the viewer.

**Stage 2 — Real-geometry ring-march arcs (endpoints proven; interiors next)**

The arc endpoint real-geometry is already proven (`realGeomProof.ts`, wall-gap std 0.000mm). Stage 2
integrates the proven endpoint method and then addresses arc interior real-geometry.

**Endpoint integration:** Promote the `_rayHit` endpoint trimming from `realGeomProof.ts` into the
ring-march production path (`ringMarch.ts`). Arc endpoints land on actual wall polygons.

**Interior real-geometry:** Replace the interior grid-scan polyline points with real-geometry arc
interior construction (offset-of-entry-frontier or equivalent). Arc interiors eliminate the kinks.

**First fixture for interior work: paisley** (arc-to-wall termination benchmark + interior kink benchmark).
Target wall-gap std: < 0.05mm. Target interior: no visible kinks.

**Visual-review gate:** Arcs terminate cleanly at the wall; arc interiors are smooth; no grid-pitch kinks.

Stage 2 is independently verifiable: the ring-march layer is a separate toggle in the viewer.

**Stage 3 — Retrace metric on real rings**

Re-validate `ringRetraceGapFires()` on real ring geometry. The oracle queries (midpoint → grid →
uncut-neighbor) are unchanged. The arc/chord measurement now operates on real ring polygon vertices
(smoother → more accurate ratios).

Re-validate truncation parameters: AC_TRUNCATE_MARGIN=2.0 may be narrowed now that grid quantization
noise is gone. AC_TRUNCATE_MERGE_STEPOVERS=5 may need re-tuning.

**Self-check must still pass:** paisley truncates at ring 9 / L=32mm; disc never truncates.

Stage 3 gates on Stage 1 being done (metric operates on real rings).

**Stage 4 — Spiral blend on real rings (clean-up)**

With real rings as input and the retrace metric re-validated, rebuild `buildMorphSpiral()` /
`buildMorphSpiralTruncated()` cleanly. The lerp-blend structure may be largely reusable;
`sampleLoop()` and `alignLoop()` may be renamed/tidied.

**Visual-review gate:** Full spiral on all five fixtures (L-shape, barbell, sq+island, disc, paisley)
— smooth, even stepover, correct truncation, correct ring-march handoff.

---

## Risk / unknowns — the parts needing the most design care

**R1 — Geodesic vs. euclidean ring at non-convex features — CONFIRMED (not just a risk)**

MEASUREMENT confirmed that euclidean offsetPolygon FAILS for curved alleys (Paisley, Barbell far bulb).
This is why the rings approach was corrected to FMM-angular-sort. R1 is resolved structurally: the
angular-sort uses the FMM field values directly (crossing positions at level `L` reflect the geodesic
distance, not euclidean distance), so rings follow correct geodesic topology everywhere.

For Stage 1 (L-shape, simply-connected, convex enough that geodesic ≈ euclidean): R1 does not apply.
For future stages (barbell, paisley): the FMM-angular-sort inherently follows geodesic distance —
no euclidean-divergence problem.

**R2 — Entry frontier as real polygon for ring-march (Stage 2, MEDIUM)**

To compute arc offsets (for interior real-geometry), we need the cleared-material frontier (at
`splitLevel`) as a real polygon. The cleanest expression is `offsetPolygon(boundary, islands,
maxDist - splitLevel)`. For connectivity-split truncation, the frontier may be multi-component.

**Design care needed:** Verify that the entry frontier polygon corresponds geometrically to what the
entry-only FMM seeds in the current implementation. If they diverge on complex concave boundaries,
the ring-march's notion of "entry" may shift.

**R3 — Arc geometry in narrow alleys (Stage 2, MEDIUM)**

In a narrow alley (e.g., the paisley tail), the arc at level `d` may be degenerate when the alley
narrows to near-zero. The proven grid-scan approach naturally handles zero-arc regions. The
real-geometry approach must handle degenerate arcs similarly.

**Design care needed:** Preserve the `degenerate: true` path for regions where no valid arc can be
constructed. Define "degenerate" in real-geometry terms.

**R4 — Truncation-level correspondence between FMM and real rings (Stage 3, LOW-MEDIUM)**

The truncation level is in FMM geodesic distance units. After Stage 1, rings are indexed by
FMM-angular-sort at the same geodesic levels (not euclidean offset levels). The mapping is preserved:
level `L` in FMM = level `L` in the angular-sort ring family. For simply-connected shapes this is
exact. At non-convex features (if R1 variants arise at Stage 3), verify on all fixtures.

**R5 — Angular-sort failure on multi-loop rings (Stages 1–4, LOW for simply-connected)**

The FMM-angular-sort approach assumes each ring is a single closed loop encircling the seed (works
for simply-connected shapes). When islands are present, one ring level may produce disconnected arcs
(not a single encircling loop). The sort fails for disconnected loops. Island support (Square+Island)
remains blocked on `offsetPocket` primitive.

---

## Open questions for architect/user review

**Q1 — RESOLVED (Correction C2).** The proven method for arc endpoints is field-scan ordering +
`_rayHit` endpoint trimming (`realGeomProof.ts`, validated on Paisley, wall-gap std 0.000mm). This
supersedes both original options (offset of entry frontier, isocontour fit). The "offset of entry
frontier" remains the aspirational path for arc interior real-geometry (Stage 2 interior work), but
it is not the arc endpoint approach.

**Q2 — Whether to keep marchingSquares.ts at all:**
ADR-0012 demotes it to a diagnostic/locating tool. It may be useful for visualizing "where the
isocontour is" as a debug layer, to compare against the real-geometry ring overlay. Or it may be
removed entirely once the real-geometry rings are validated.
Keep as debug tool, or delete?

**Q3 — Stage 1 first fixture:**
Confirmed: L-shape (simply-connected, no islands, no truncation, no curved-alley complication).
All subsequent fixtures follow after L-shape visual review passes.

---

## Commit structure

Each stage is one atomic doc+code commit (or a small series of tightly scoped commits):

- **Stage 1 commit(s):** `feat(morph-proto): Stage 1 proof — real-geometry rings via FMM angular-sort (L-shape)`
- **Stage 2 commit(s):** `feat(morph-proto): real-geometry arc endpoints via _rayHit (promote proof to production)` then `feat(morph-proto): real-geometry arc interiors via entry-frontier offset`
- **Stage 3 commit(s):** `feat(morph-proto): re-validate retrace metric on real ring geometry`
- **Stage 4 commit(s):** `refactor(morph-proto): rebuild spiral blend on real-geometry rings`

Each stage is gated on architect/user visual review before the next begins. No monolithic rewrite.

---

## Execution order

1. ~~Architect/user approves this plan (with answers to Q1–Q3).~~ APPROVED. Corrections committed.
2. Stage 1 — real-geometry rings (FMM-angular-sort). Visual review on L-shape (ring layer overlay).
3. Stage 2 — real-geometry arc endpoints (promote `_rayHit` proof to production). Then arc interiors.
4. Stage 3 — re-validate retrace metric. Self-check must still pass.
5. Stage 4 — spiral rebuild on real rings. Full-family visual review.
6. Then: loopback + lead-in/out + trim/extend layer (per HANDOFF.md Recommended Next Steps).
