> **SUPERSEDED (see wall-follow-roadmap.md "Design pivot" section).** This plan
> described the single-pass wall-follow finishing approach, which Stage 1 execution
> and visual review revealed to be aimed at the wrong layer. The real target is
> bulk-pass motion quality (even walls), not a finishing pass. The foundation
> commits (sampleArc, corner-classification gate, engagement infrastructure,
> ACParams plumbing, simStock test wiring) remain valid; the single-pass
> runWallFollowPass walk-and-skip logic is superseded. Retained for audit trail.

# Stage 1 Wall-Follow Finishing Strategy — Plan

Anchor commit: 8f35463
Branch: adaptive-clearing-v1

This is the binding execution plan for Stage 1 of the wall-follow roadmap (docs/research/wall-follow-roadmap.md). Execution proceeds one commit at a time with per-commit context checkpoints. Commit order: 1 → 1.5 → 2 → 3 → 4 → 5 → optional 6.

## Binding geometry (verified, do not re-derive)

For a CCW boundary polygon, vertex classification by cross product of adjacent normalized edge directions (e1 = incoming dir, e2 = outgoing dir, cross = e1.x*e2.y - e1.y*e2.x):
- cross > 0: left turn → convex vertex (outside corner) → miter intersection of offset edges, NO arc
- cross < 0: right turn → reflex vertex (inside corner) → tool-radius ARC centered at the boundary vertex

Verified fixtures:
- T_SHAPE [(40,0),(80,0),(80,60),(120,60),(120,120),(0,120),(0,60),(40,60)]: reflex at (80,60) and (40,60).
- L_SHAPE_NARROW [(0,0),(120,0),(120,60),(40,60),(40,120),(0,120)]: reflex at (40,60).

The arc is the tool-radius fillet a circular tool leaves at an inside corner. The miter is the sharp outside corner the tool wraps. Item 1.5 encodes this as a test BEFORE Item 2 implements against it.

## Item 1 — Arc-sampling geometry primitive

Title: Add sampleArc to geometry/index.ts
Files: src/lib/cam/geometry/index.ts (append after line 210); src/tests/adaptive-clearing/m5-wall-follow.test.ts (new file, arc unit tests only)

sampleArc(center, radius, startAngle, endAngle, direction: 'CCW'|'CW', chordTolerance) returns Vec2[] — points along a circular arc at chord tolerance, end-point excluded so callers splice segments end-to-end without duplicating vertices. CCW sweeps toward increasing angles, CW toward decreasing.

Implementation:
- cosVal = clamp(1 - chordTolerance/radius, -1, 1); maxStep = 2*acos(cosVal)
- span computed per direction with 2π wrap handling
- n = max(1, ceil(span/maxStep)); step = (span/n) * (CCW? +1 : -1)
- emit n points from i=0..n-1 at startAngle + i*step

Risk: pure math, zero side effects. Edge case chordTolerance ≥ radius clamped. End-point-excluded convention must be honored by callers.

Tests: point count matches formula; all points on circle within fp tolerance; CCW increases / CW decreases angle; 360° returns n points no duplicate endpoint; near-zero span returns 1 point.

## Item 1.5 — Corner-classification verification test

Title: Verify convex/reflex corner classification on M4A and M4B before strategy implementation
Files: src/tests/adaptive-clearing/m5-wall-follow.test.ts (corner-classification tests only, no production code)

This commit contains only tests. It proves the cross-product sign convention on actual fixture data before _buildOffsetContour is implemented. If any assertion fails, Item 2 must be revised before proceeding.

Test helper classifyBoundaryCorners(poly): for each vertex, compute normalized incoming/outgoing edge dirs, cross = (e1x/len1)*(e2y/len2) - (e1y/len1)*(e2x/len2), isReflex = cross < -1e-9.

Tests:
- T_SHAPE has exactly 2 reflex vertices, at (80,60) and (40,60)
- L_SHAPE_NARROW has exactly 1 reflex vertex, at (40,60)
- Arc endpoints at T_SHAPE (80,60) for offset=5: arc start (75,60) [incoming edge inward normal (-1,0)], arc end (80,65) [outgoing edge inward normal (0,+1)], both at distance 5 from vertex; arc sweeps CW 180°→90°, midpoint at 135° also at distance 5.

## Item 2 — ACParams additions + wallFollow.ts implementation

Title: Add wallFollowStockToLeave/wallFollowEnabled to ACParams; implement runWallFollowPass (not yet wired)
Files: src/lib/cam/types.ts (ACParams: add 2 optional fields); src/types/index.ts (ToolpathMove.engagement JSDoc, line 234-236); new src/lib/cam/adaptiveClearing2d/wallFollow.ts

ACParams additions:
- wallFollowStockToLeave?: number — finishing-pass wall offset (mm); tool edge stops this far from the wall; independent of passes.stockToLeave (bulk-roughing inset); default 0.0
- wallFollowEnabled?: boolean — when false, skip the finishing pass; default true

ToolpathMove.engagement JSDoc update: "Set on 'cut' and deliberate 'wall_follow' moves; undefined on link/rapid roles."

Contour source (binding): contour derives from BOUNDARY, not safeRegion. Arc centers at reflex corners MUST be the original boundary vertices; safeRegion's vertices are offsetPolygon miter/bevel points, NOT correct arc-center locations. safeRegion is used ONLY for the per-point containment guard. boundary → geometry; safeRegion → guard.

Island scope (Stage 1): runWallFollowPass accepts islands for engagement probes only; the contour traces the OUTER boundary only; island contours deferred with a TODO comment.

runWallFollowPass(boundary, safeRegion, islands, stock, params, toolRadius, feedRate, bottomZ, clearanceZ, moves): void
- early return if wallFollowEnabled === false
- offset = toolRadius + (wallFollowStockToLeave ?? 0); maxEng = params.maxEngagement; workRegion = {boundary, islands}
- contour = _buildOffsetContour(boundary, offset, params.stepDistance); return if empty
- return if !pointInPolygon(contour[0], safeRegion)
- push rapid to contour[0] at clearanceZ, then plunge (feed) to bottomZ
- walk contour with prevPt and lastEmitted tracking:
  - skip if !pointInPolygon(pt, safeRegion)
  - midpoint engagement check (R8): mid of prevPt→pt; if inside safeRegion and engagementAngle(mid) > maxEng, skip
  - endpoint check: if engagementAngle(pt) > maxEng, skip
  - else emit feed move role 'wall_follow' with engagement field set; stock.update(pt); update lastEmitted
- loop closure (R7): attempt closing move back to contour[0]; if engagementAngle(closePt) ≤ maxEng, emit it and stamp; else accept open seam (no log entry in Stage 1)
- final retract: rapid from lastEmitted to clearanceZ

WALL_FOLLOW_CHORD_TOLERANCE = 0.3 (mm, developer constant, not user-facing). N_RAYS = 32.

_buildOffsetContour(boundary, offset, stepDist):
1. For each edge V_i→V_{i+1}: inward normal = {x:-e.y, y:e.x} (rotate +90°, left side for CCW); offset edge from V_i + offset*n to V_{i+1} + offset*n
2. At each vertex: cross product of adjacent edge dirs. cross < 0 (reflex): arc center = V_i, radius = offset, start angle = dir from V_i to end-of-previous-offset-edge, end angle = dir from V_i to start-of-next-offset-edge, direction CW, generate via sampleArc. cross ≥ 0 (convex): miter intersection of adjacent offset edge lines; if parallel (no finite intersection), single offset point on either normal.
3. Between vertices: discretize straight offset segment at stepDist intervals, append all intermediate points.
4. Return flat Vec2[] in CCW order, end-point-excluded.

Inward normal {x:-e.y, y:e.x} is OPPOSITE to offsetPolygon's outward convention {x:e.y, y:-e.x}. Do not mix.

Risk: not wired → zero behavioral risk this commit. Correctness pre-verified by Item 1.5.

## Item 3 — simStock wall_follow stamping in test helper

Title: Extend assertPlannerOutput to stamp wall_follow moves in simStock and validate their engagement
Files: src/tests/adaptive-clearing/m2-planner.test.ts (lines 178, 222-225, 242)

- line 178: add wallFollowMoves filter and contribMoves = [...cutMoves, ...wallFollowMoves]
- line 242: stamp contribMoves instead of just cutMoves
- after line 225: Check 3b — for each wall_follow move with engagement defined, expect engagement ≤ maxEngagement + 1e-9
- fixture stats block (~line 313): add wallFollowMoveCount

Incidental RELOCATING wall_follow moves are in cleared territory (idempotent stamping), so coverage unchanged by this commit alone. Check 3b passes vacuously (no current wall_follow sets engagement). All 101 tests must still pass.

## Item 4 — Wire wall-follow strategy + update thresholds

Title: Call runWallFollowPass in _runPlannerForPayload; update M4A/M4B thresholds; add motion-quality diagnostics
Files: src/lib/cam/adaptiveClearing2d/index.ts (after line 62, before return); src/tests/adaptive-clearing/m2-planner.test.ts (M4A 0.89→0.93; M4B 0.86→0.94; SD-2 thresholds)

Integration point: _runPlannerForPayload (NOT inside runPlanner). After runPlanner returns, stock reflects final spiral state — exactly what the finishing pass needs. Add import of runWallFollowPass. After the runPlanner call, if wallFollowEnabled !== false, call runWallFollowPass(boundary, safeRegion, expandedIslands, stock, params, toolRadius, feedRate, bottomZ, clearanceZ, result.moves). result.moves is mutated in place. Return result.

Motion-quality diagnostics (R6) in assertPlannerOutput fixture stats: compute over wall_follow moves with engagement defined — maxHeadingDelta, sharpTurns (heading delta > π/3 = 60°), arcSegments (heading delta > π/9 = 20° heuristic). Heading delta via atan2(cross, dot) of consecutive segment vectors. Write to stats: wallFollowMoveCount, maxHeadingDeltaDeg, sharpTurnCount, arcSegmentHeuristic.

Hard motion gates (asserted in Item 5's M4A/M4B tests, not in general assertPlannerOutput): wfMoves.length > 0; sharpTurnCount === 0.

Move count estimates: M4A ≈ +164 (942 total, under 1245 bound); M4B ≈ +146 (985 total, under 1342 bound).

## Item 5 — Dedicated wall-follow test suite

Title: Add Stage 1 acceptance-gate and integration tests
Files: src/tests/adaptive-clearing/m5-wall-follow.test.ts (expand); src/tests/adaptive-clearing/m2-planner.test.ts (export L_SHAPE_NARROW at line 71)

Tests: M4A move count ≤ 1245; M4B ≤ 1342; all wall_follow engagement ≤ maxEng (M4A and M4B, with wfMoves.length > 0 assertion); M4A and M4B no heading change > 60° (sharpTurns === 0); wallFollowEnabled=false suppresses deliberate wall_follow (baseWF.length > noWF.length); crash check — all wall_follow moves inside safeRegion offset; island param doesn't crash.

T_SHAPE already exported (line 57). L_SHAPE_NARROW needs export added (line 71). makePayload — define locally in m5-wall-follow.test.ts to avoid coupling (10-line duplicate acceptable).

Total: 101 existing + ~9-10 new = ~110 passing (within 110-115 roadmap acceptance).

## Open questions — all resolved

Q1 (naming): wallFollowStockToLeave, distinct from passes.stockToLeave. Resolved.
Q2 (enabled default): true. Per-move engagement + safe-region gates make opt-in risk low. Investigate before changing if a T1-T6 test regresses.
Q3 (chord tolerance): WALL_FOLLOW_CHORD_TOLERANCE = 0.3mm constant. Promote to ACParam only if visual review reveals per-operation variance.
Q4 (direction): CCW boundary walk (matches spiral climb); arc sweeps CW through pocket interior at reflex corners. Comment in runWallFollowPass.
Q5 (shortfall policy): if coverage below threshold, CC does NOT lower thresholds. CC reports: achieved coverage, wallFollowMoveCount, sharpTurnCount, dominant skip reason (add skip-reason counter to runWallFollowPass), uncleared regions, chord tolerance used. Chat-side decides: tighten chord tolerance, add second pass, accept lower threshold (update roadmap §4), or split follow-up milestone.

## Acceptance gates (roadmap-binding)

- M4A physical coverage ≥ 93% (currently ~90.1% in test sim, 84.4% in viewer physical metric)
- M4B physical coverage ≥ 94% (currently ~87.0% in test sim, 90.3% in viewer physical metric)
- M4A move count ≤ 1245; M4B ≤ 1342
- Every wall_follow move engagement ≤ maxEngagement (by design, pre-emit)
- sharpTurnCount === 0 on M4A and M4B
- wallFollowMoveCount > 0 on M4A and M4B
- crash check 0 across all fixtures
- test suite passes (growth to 110-115 acceptable)
- visual review at milestone close against the reference corpus: corner geometry resembles smooth rounded approach, not faceted/stair-stepped
