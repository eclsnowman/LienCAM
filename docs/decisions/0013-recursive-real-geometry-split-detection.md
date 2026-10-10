# 0013 — Recursive real-geometry split detection via disjoint-segment wall-follow counting

Date: 2026-05-25
Status: Accepted

## Context

The prototype's split detection used `detectSplitsByStockConnectivity()` — a BFS
flood-fill over the FMM grid that counts connected components of free cells with
`dist >= level`. This was observed to produce pathological results across the
shape family:

- **Barbell:** BFS reported `regionCount=56` at the neck split level. The two
  bulbs plus their connecting neck produce dozens of narrow-cell discretization
  artifacts where adjacency is a grid-resolution question, not a geometric one.
- **L-shape:** BFS reported a phantom 3rd region at a specific level approximately
  0.7mm after the first real split. At that level, the grid's reflex-corner
  discretization produced a 3-component count; 0.7mm later it dropped back to 2.
  This was pure grid discretization noise, not a real topology change.

Both failures are structural consequences of using a grid BFS as the split counter.
Increasing grid resolution narrows but does not eliminate them — the artifact
geometry scales with resolution, not with the pocket topology.

A separate problem was the distance-threshold deduplication approach (collapsing
wall-follow events that happen within a fixed radius of each other): this fails
because the analytic spiral re-hits the SAME physical feature (e.g. the L's
reflex inside corner) on every revolution at ever-larger radius. Any fixed distance
threshold either falsely counts the same corner as multiple new contacts (threshold
too small) or merges genuinely distinct contacts (threshold too large). The
threshold value has no stable geometric anchor.

## Decision

Region-split detection is performed on **real geometry** — the real spiral/ring-march
path contacting the real boundary polygon segments — NOT on the FMM grid field.
The BFS stock-connectivity mechanism (`detectSplitsByStockConnectivity`,
`countStockComponents`) is **replaced as the split counter/identity mechanism**.
It is retained only as a seeding oracle for `findIsolatedRegions()`.

### THE RULE — applied recursively across all filling phases

**Fill each connected region:** SPIRAL for the seed region; RINGS ("ring march")
for each split-off sub-region. The same rule governs BOTH phases.

**Split trigger — wall-follow entry, not per-segment touch:**
A split is triggered by a WALL-FOLLOW EVENT: the path ENTERING contact with and
FOLLOWING along a boundary segment. A continuous follow across many segments is
one event. Per-step segment touches are NOT counted individually.

**Dedup by segment identity — not by distance:**
A wall-follow counts as a NEW DISCRETE contact ONLY IF its set of followed boundary
segments (`{polyIdx, segIdx}` pairs as returned by `wallDistAtAngle`) is FULLY
DISJOINT from the segment sets of ALL prior wall-follows in the current fill.

- ANY shared segment = overlap = continuation = does NOT count as a new discrete
  contact.
- A wall-follow that introduces at least one new segment AND shares no segment with
  any prior follow = new discrete contact.

**Split rule:**
Each new fully-disjoint discrete contact (after the FIRST contact in a region)
splits off one new region. The first contact in any region is the initial contact —
it does not split anything.

**Recursion — critical:**
Splitting does NOT end when the spiral stops. The rule applies RECURSIVELY:
- The spiral's disjoint wall-follows split off the first set of sub-regions.
- Each ring-march that fills a sub-region applies THE SAME RULE to its own
  wall-follows. Ring-march wall-follows that engage fully-disjoint boundary segments
  SEED AND START NEW ring-marches into newly-split sub-sub-regions.
- Regions emerge iteratively across all filling phases, not all at the spiral's
  first split.

**FMM field role — preserved as oracle:**
The FMM field (`runFastMarching`, `detectSplitsByStockConnectivity`,
`findIsolatedRegions`) is preserved as the oracle for:
- The split LEVEL (what FMM distance value does the connectivity change occur at?
  Still answered by `detectSplitsByStockConnectivity` on the grid).
- Ring-march SEEDING (`findIsolatedRegions`: identify isolated stock cells at the
  split level to seed the entry FMM for each new ring-march).
Only the split COUNTING and IDENTITY move to real geometry.

### Confirmed regional sequences (read-only analysis, 2026-05-25)

**L-shape (boundary: 6 segments, polyIdx=0, segs 0–5):**

Seed in the bottom arm (~20,20). Split level = 29mm (FMM oracle).

*Spiral phase:*
- Initial contacts: {seg 0, seg 5} (bottom and left outer walls at ~20mm radius).
- Repeated contacts of same segments on subsequent revolutions → continuations, not
  counted.
- At some radius, the ray toward the upper right hits seg 3 (x=40, y from 40 to 80,
  the inside corner vertical wall). Seg 3 is fully disjoint from {seg 0, seg 5} →
  FIRST new discrete contact → **1→2 split** (spiral phase).
- Seg 4 (y=80 top wall) is ~60mm from seed, unreached at split level 29mm — NOT
  contacted during the spiral.

*Ring-march of R2 (top arm, 40×40mm corridor, open at bottom):*
- Initial contacts in R2: {seg 3, seg 5} (right and left corridor walls contacted
  simultaneously as the ring-march grows from the cleared entry at y≈40).
- Successive rings contact same {seg 3, seg 5} → continuations.
- At the far end: ring-march contacts seg 4 (y=80 top wall). Seg 4 is fully disjoint
  from {seg 3, seg 5} → FIRST new discrete contact in R2 → **2→3 split** (ring-march
  phase).

**Total: 3 real regions, emerging recursively across spiral + ring-march.** ✓

*BFS phantom distinction:* The phantom 3rd region in the old BFS detection appeared
at a specific level ~0.7mm after the first real split, where the reflex-corner grid
cells produced a 3-component BFS count that reverted to 2 components 0.7mm later.
This is a grid-discretization artifact. It has no relationship to the real 3rd region
(R3), which is created by the ring-march of R2 when it contacts seg 4 — a distinct
event at a different level and via a different mechanism.

**Barbell (boundary: ~68 segments; left-bulb arc + neck straights + right-bulb arc):**

Seed in left bulb (center 25,40 radius 20mm). Split level ~20mm (FMM oracle).

*Spiral phase:*
- Initial contacts: left-bulb arc segments.
- Neck segments (the 2 straight lines at y=40±6mm) are fully disjoint from
  left-bulb arc segments → FIRST new discrete contact → **1→2 split** (spiral phase).

*Ring-march of R2 (right bulb, radius 14mm):*
- Filled from the cleared neck entry (one-sided entry from the left).
- Initial contacts: neck-adjacent arc segments of the right bulb (polyIdx=0, right
  side of the boundary polygon).
- Successive ring-march rings SLIDE along the continuous curved arc — each ring's
  contact set shares at least one segment with the prior ring's contact set (adjacent
  segments on a smooth arc overlap between consecutive rings). No follow set is ever
  fully disjoint from all prior follow sets.
- ZERO new disjoint contacts in R2's ring-march → **0 additional splits**.

**Total: 2 real regions.** BFS reported regionCount=56 — all grid artifacts. ✓

**Paisley (simply-connected spiral alley, no reflex corners):**

The spiral fills the body to the truncation level (ring 9, L=32mm — not a connectivity
split). The disjoint-segment rule applies during the spiral phase and within any
subsequent ring-march phases. The outer alley arm segments form the
initial contact set; the inner alley arm segments are disjoint and may fire a split
depending on exactly when they are first contacted relative to the truncation level.
The ring-march fills the tail, with its own wall-follows subject to the same rule
recursively. The practical result is 2 principal regions (body + tail), which is
sensible. Exact segment-set tracing for the paisley requires code-level implementation
(the build session task).

## Why segment identity, not distance

A distance-threshold deduplication fails structurally:

- The analytic spiral re-hits the same physical corner (e.g. the L's reflex corner
  at (40,40)) on EVERY revolution, at ever-larger radius. The physical distance
  from the previous contact point to the current contact point grows monotonically
  with the spiral's expansion rate × time. Any fixed distance threshold therefore
  eventually counts the same physical feature as a new contact — a false positive
  that grows worse as the spiral runs longer.
- Segment identity does not drift with radius. Seg 3 is seg 3 on revolution 1 and
  on revolution 8. Two contacts of seg 3 separated by any distance are still the
  same segment → continuation → not counted.

## Why this replaces BFS counting, not BFS detection entirely

BFS grid connectivity (`detectSplitsByStockConnectivity`, `findIsolatedRegions`)
answers TWO distinct questions:

1. **WHAT LEVEL** does the first split occur at? — still answered correctly by BFS
   on the grid (the FMM distance field accurately encodes when stock becomes
   metrically disconnected even if the BFS cell count has artifacts).
2. **HOW MANY SPLITS** and which are real? — answered incorrectly by BFS (56
   artifacts on barbell). Replaced by the disjoint-segment wall-follow count.

The FMM oracle is preserved for seeding (question 1 + `findIsolatedRegions`). Only
the split counting/identity (question 2) moves to real geometry.

## P1 — the split seal point

P1 is the point on the real boundary wall where the spiral contacts the first new
disjoint segment set, sealing the split. P1 is currently computed via a bridge-cell
scan + `wallDistAtAngle()` ray-cast (see `analyticSpiral.ts`). This is consistent
with the disjoint-segment rule: P1 is the wall point corresponding to the first
disjoint wall-follow contact.

## Offset-boundary sealing observation

Confirmed (from the cut/uncut playthrough during the morph prototype development):
the regions seal at the OFFSET / CONTAINMENT BOUNDARY (the real geometry offset
from the pocket wall), not at the raw FMM isocontour. The FMM field locates where
the boundary is; the real geometry (offset polygon) defines what the boundary is.
This is consistent with ADR-0012 (real geometry for all path representation).

## Alternatives considered

**BFS component count (current, replaced):** Intrinsically grid-artifact-prone.
56 components on barbell; phantom components on L-shape. The only fix is to
eliminate the grid-based counting, not to filter the results.

**Distance-threshold deduplication on wall-follow events:** Fails structurally —
the same physical feature is re-hit at ever-increasing distances as the spiral
expands, making any fixed threshold incorrect for all spiral radii simultaneously.

**Connectivity-only triggers (original architecture doc §3/§5):** The original
architecture stated that only genuinely disconnected stock areas form separate
regions. This was found too narrow: (a) it misses the spiral-truncation trigger
(a connected region that the spiral can no longer fill productively), and (b) the
BFS grid implementation of this concept produces false positives (artifacts) at
every discretization boundary. The disjoint-segment rule produces topologically
correct behavior without depending on grid connectivity.

## Consequences

**Positive:**
- BFS artifacts (56 regions on barbell, phantom regions on L-shape) are eliminated
  at the substrate level — they cannot occur because real boundary segment identity
  is immune to grid discretization noise.
- The L-shape's 3 real regions emerge correctly and recursively (not all at once at
  the spiral phase), matching the commercial reference behavior.
- The barbell's 2 real regions are detected correctly (spiral splits at neck; right
  bulb ring-march produces no further splits because arc contacts slide continuously).
- The distance-threshold instability is eliminated. No parameter to tune.

**Negative / cost:**
- Implementation requires tracking the accumulated set of followed segment index
  pairs across each filling phase (spiral and each ring-march). This is O(N_segments)
  per wall-follow event — negligible for typical pocket boundary sizes (dozens to low
  hundreds of segments).
- The rule must be implemented in the build phase and then verified visually per
  shape. The analysis above is read-only (static) and confirms logical correctness;
  code-level correctness requires the build.

**Open items for the build phase:**
- Implement disjoint-segment dedup in the spiral wall-follow detector (extending
  FIX-2's transition counting in `analyticSpiral.ts`).
- Implement the RECURSIVE ring-march: each ring-march applies the same dedup rule
  and seeds new ring-marches when new disjoint contacts fire.
- Confirm the paisley exact segment-set firing against the implementation.
- Rename "ring march" → "ring march" throughout (existing rename tracked in STATUS.md).
- Purge dead code: old MS-spiral / failed attempts / T-variant scaffolding.

## References

- `src/lib/cam/adaptiveClearing2d/morphProto/analyticSpiral.ts` — `WallHit`,
  `wallDistAtAngle`, FIX-2 transition counting (`clamped && !prevClamped`)
- `src/lib/cam/adaptiveClearing2d/morphProto/reMorph.ts` —
  `detectSplitsByStockConnectivity` (retained for level oracle),
  `findIsolatedRegions` (retained for seeding)
- ADR-0012 — grid as occupancy oracle; real geometry for all paths (the substrate
  decision that makes this rule implementable: real boundary segments are available
  because ADR-0012 mandates real-geometry paths)
- `docs/research/adaptive-clearing-architecture.md` §3/§5 — prior "topology-only"
  region split rule (superseded in part by this ADR for the counting/identity
  mechanism; the FMM level oracle is preserved)
- Read-only analysis (static geometry trace): 2026-05-25; confirmed by inspection of
  `testShapes.ts` (L-shape 6-segment boundary, Barbell continuous-arc boundary,
  Paisley simply-connected alley)
