# What GOOD means - 2D adaptive clearing

> **Status: VERIFIED by Operator 2026-08-22 ("spec is fine", in chat) - this file
> is LAW.** Execution order given the same day: fix forward, in chunks, fast.
> The section-7 open questions were not answered individually; under the
> fast-execution order their RECOMMENDED answers are adopted as working
> assumptions (each WO names its assumption), and every one remains vetoable
> by Operator at that phase's picture gate (T4). [OPERATOR TO RULE] tags below mark
> where those assumptions live.
>
> Why this file exists: on 2026-08-22 Operator rejected a landed engine change
> whose safety numbers were all green but whose paths were visibly worse to
> run (travel-move explosion, corpus lifts 31 -> 233). The change was judged
> by correctness gates alone because no gate said what GOOD motion is. This
> file says it, so that mistake is structurally unrepeatable.
>
> Companions: `AC-SPEC.md` (the correctness contract - R1-R6, W1-W5; this file
> does not repeat it, it completes it), `AC-ATTEMPTS-LEDGER.md` (dead
> approaches), and the six research reports in
> `.planning/research/good-adaptive/` (every external claim below carries its
> lane; the lane report carries the URL/quote).
>
> Provenance tags: [AC-SPEC x] existing contract; [CODE file:line] read in our
> source; [FREECAD] read in the ancestor's source (freecad-ancestry.md);
> [REFERENCE] external CAM documentation (fusion-behavior.md); [FORCES] tooling-vendor
> physics (cutting-forces.md); [SHOP] machinist consensus
> (machinist-consensus.md); [GT] measured on the nine reference corpus recordings
> (gt-census.md); [MEASURED] measured on our own engine this week;
> [OPERATOR date] his words.

---

## 1. The definition

A good adaptive path removes ALL commanded material, holding the cutter's
load inside its designed band at its designed feed for every cutting move,
and travels between cuts through already-cleared material using the CHEAPEST
safe motion tier (section 3), in one consistent cutting direction, with
motion a machinist reads as calm: flowing arcs, no dwelling or recutting, no
sharp reversals, and no flight through the air that a loopback on the floor
could have replaced.

Two failure directions, both real:
- A move that is UNSAFE (overloads the cutter, gouges, or traverses uncut
  stock) is a crash. [AC-SPEC R1]
- A move that is SAFE but WASTEFUL (a full retract where a cheaper tier was
  provable) is a QUALITY DEFECT. It is not acceptable merely because it is
  safe. This direction is what the 2026-08-22 rejection was. [OPERATOR 2026-08-22]

## 2. The forces - why the rules are physics, not taste

- The load currency is swept-area-per-mm of travel ("effective width", mm).
  Full slot = tool diameter; optimal load = stepover fraction x full slot.
  Every cap in the engine is denominated in it. [CODE toolGeometry.ts:53-66]
  [FREECAD Adaptive.cpp:1858-1893 - identical formula]
- Adaptive milling runs LOW radial engagement compensated by HIGH feed (chip
  thinning): at 10% radial engagement the feed runs ~1.6x base, at 2% ~3.6x,
  at 1% ~5x, to hold the designed chip load. [FORCES]
- Therefore: any move that meets MORE engagement than it was planned for is
  multiplying chip load by its feed compensation. A feed-compensated or
  traverse-speed move meeting real stock is the single most cited real-world
  tool breaker. [FORCES] This is why AC-SPEC R1 defines a crash as "a move
  over UNCLEARED stock that is not a designed cutting move" - the definition
  is physics.
- Stepover tolerance is ONE-SIDED: under-ideal costs only cycle time;
  over-ideal deflects the tool (a cantilever effect) - taper, chatter, bad
  walls, breakage - and is not recoverable mid-cut. Under acceptable, over
  forbidden. [AC-SPEC F] [FORCES]
- Full slotting is the worst case: climb and conventional at once, no open
  side for chips or coolant, zero chip-thinning credit. [FORCES]
- Cutting direction (climb vs conventional) inverts both the chip-thickness
  curve and the force vector; it is set by cutter rotation + operation and
  never flips mid-operation. [AC-SPEC R3] [OPERATOR, recovered 2026-06]
- RULING [OPERATOR 2026-08-22]: purely ONE direction at a time, and CLIMB is the
  default. "Both Ways" cutting (cutting the return trip in the opposite
  direction to save retracts) is acknowledged as a real
  efficiency and DEFERRED - not to be implemented until the basics work.
  Nothing in the tier ladder (section 3) may smuggle in an opposite-sense
  CUT; tier-1 loopbacks travel backward without cutting, which is allowed
  and is not Both Ways.

## 3. The motion tiers - the ladder every pass-to-pass connection descends

Every connection between two cutting positions is resolved by trying tiers
in order and taking the FIRST whose safety proof passes. Naming the tier and
its proof is mandatory; skipping to a more expensive tier when a cheaper
proof would have passed is a quality defect.

- **Tier 0 - keep cutting.** Continue-On to the adjacent ring, or a SHORT
  connection (within ~2x stepover) executed as an ORDINARY CUTTING MOVE at
  cutting feed, allowed to cut through a small sliver, gated by the same
  area-rate machinery as any cut. The ancestor does exactly this
  (IsAllowedToCutTrough reclassifies the link to mtCutting). [FREECAD
  Adaptive.cpp:3196-3219] Our engine does NOT have this tier today - its
  absence is one root of the 2026-08-22 lift storm (measured: a 0.1 mm hop
  emitted as a full clearance retract). [MEASURED lift-probe fix0]
- **Tier 1 - travel at depth over cleared stock.** The loopback/wall-follow:
  backtrack through your own already-cut track (always legal by construction
  - the cutter came from there), or the designed loopback arc (midpoint
  radius rCross - stepover/2, inside cleared BY GEOMETRY). Runs at traverse
  speed, so its corridor must be PROVEN clear at full width against the
  physical pre-move state - zero cutting allowance at this speed, ever.
  [AC-SPEC E.3-4, F] [CODE emit.ts:354-362,703-709]
- **Tier 2 - micro-lift hop.** Rapid at a small stay-down height above the
  level floor, over cleared-or-cusped floor, landing gated. This is the
  ancestor's default "keep tool down" (rapid at passEndDepth + Lift
  Distance) [FREECAD GenerateGCode.py:79-104]. A small lift between passes
  [SHOP] follows the machinist norm ("2-5 mm
  hover between same-pocket passes") [FORCES/SHOP]. Our engine does not have
  this tier as a distinct height today - a connection is either at-depth or
  full clearance. [CODE emit.ts:711-715]
- **Tier 3 - full retract to clearance height.** Rapid up, over, plunge or
  helix back in with a gated landing. Always legal; last resort; BUDGETED
  (section 5). Legitimate reasons machinists accept: moving between truly
  separated regions, and chip evacuation in deep pockets. [SHOP]

A detour budget applies within tier 1: a keep-down route much longer than
the direct distance is worse than the lift it avoids (the ancestor gates
this with keepToolDownDistRatio). [FREECAD
Adaptive.cpp:2904] [REFERENCE] [OPERATOR TO RULE: our ratio.]

Where the next pass STARTS is part of motion quality: current FreeCAD costs
candidate engage points by their link, penalizing any candidate whose link
would retract (+10000 bias). Our engine ports the older single-walk model
and picks engage points blind to link cost. [FREECAD Adaptive.cpp:4053-4055]

## 4. The stock belief - what the engine may and may not conclude from it

The engine's only knowledge of remaining stock is a polygon belief map
(cleared = union of swept capsules). Its measured limits bind every gate:

- The belief errs CONSERVATIVE: polygon faceting under-counts each swept
  track (~0.5% at production arcTol; worse when coarser), so the engine
  always believes slightly MORE stock remains than truly does - phantom
  slivers at corridor edges are expected, not exceptional. [MEASURED,
  stock-belief-limitations.md sec 2a]
- Consequence (binding on every consumer): the PRESENCE of a belief-sliver is
  not proof of a wall. A gate may refuse a move on presence (R1 demands it at
  traverse speed), but the ENGINE may not conclude "unreachable material,
  give up / fly away" from bare presence - escalation to a costlier tier
  requires either a measured sustained load over the 2 mm window or a
  geometric keep-out. Diagnosing WHICH (real frontier stock vs faceting
  artifact) must be measured, not asserted.
- One limit leans the DANGEROUS way and is quarantined: the leftover-pocket
  inscribed-radius search under-reports by up to its 0.05 mm step, and it
  feeds a fail-loud abort. Any future consumer of residualMaxInscribedR must
  account for that step. [CODE processFeature.ts:918,1015-1023]
- clearedBeforePass discipline: every gate on a connection move validates
  against the PHYSICAL pre-move state, never against belief that includes
  material the upcoming pass has not yet removed. [CODE processFeature.ts:545-553]
- THE LESSON OF WO-410, generalized: when a lie in the belief is corrected,
  every consumer of the belief must be re-audited under the honest data
  before the correction lands. The 2026-08-19 change fixed the phantom-disk
  lie and re-audited none of the consumers; the consumers' thresholds had
  been calibrated against the lie.

## 5. What good looks like, with numbers (the reference corpus recordings)

From the nine enriched recordings (646 passes, 14.2 m of cut) [GT]:

- Loopback is the DEFAULT connection: only ~9% of the reference corpus's pass transitions
  resume in place; the rest hop loopback-scale (2-15 mm) or longer. Zero-gap
  is NOT the target; cheap, at-depth or micro-lift connections are.
- Pass counts per fixture: Comma 63, Kidney 79, SquareIsland 102, Tee 59,
  Bar 38, BootL 107, Triangle 60, Barbell 54, Boomerang 84. Our engine cuts
  Comma in 154 passes (pre-WO-410) / 263 (post). Fragmentation at 2.5-4x the
  gold standard is a standing quality gap, visible or not. [GT] [MEASURED]
- Lead caps hold across the corpus: lead-in <= 3.5 mm, lead-out <= 2 mm,
  violated only 9 times in 585 passes, worst by 0.11 mm. These caps are law.
  [GT] [AC-SPEC W5]
- Honest limit: the recordings do not label which hops lifted vs travelled
  at depth, so the reference corpus's true retract count per fixture is NOT extractable
  from this data. [GT method note] [OPERATOR TO RULE: whether he reads the real
  retract counts off a reference corpus preview per fixture, or we gate on tier
  budgets instead (section 6).]
- Visual signatures a machinist reads [SHOP]: flowing arcs of gradually
  varying curvature; no sharp reversals (chatter + chip-recut risk); red
  (air) proportional to region structure, not sprayed across open field;
  no dwelling/recutting.

## 6. Tripwires - the gates that make the 2026-08-22 mistake unrepeatable

To be WIRED as tests (order = priority). A behavior-reshaping engine change
that lands without these passing is a process violation, not a judgment call.

- **T1 retract budget, per fixture.** Full-clearance retracts (tier 3) on
  each corpus fixture <= entries + (region count - 1) + a small named
  allowance. Every tier-3 move in a plan must carry an attribution: which
  cheaper tiers were tried and which proof failed. An unattributed retract
  is a red. (This is AC-SPEC W2 made wirable without the missing
  reference count.) [OPERATOR TO RULE: the allowance.]
- **T2 pass-count sanity.** Passes per corpus fixture <= K x the reference corpus
  recording's count. [OPERATOR TO RULE: K; the measured gap today is 2.5-4x.]
- **T3 spiral continuity.** No cut pass may end mid-region except with a
  named forced-reposition reason. (AC-SPEC gate e-spiral-continuity, still
  unwired since June.)
- **T4 the picture gate, before landing.** Any engine change that reshapes
  paths ships with before/after renders of the nine fixtures PLUS at least
  one level from a real project file, and Operator's verdict, BEFORE it lands on
  main. Numbers alone are never sufficient to land path-shape changes.
  [OPERATOR 2026-08-22]
- **T5 feed-role invariant.** No move carrying a traverse/rapid role may
  cross belief-uncut stock. Zero tolerance at that speed stands (R1); the
  legal answers to a failed clearance proof are the cheaper tiers, never a
  wider allowance. Conversely a tier-0 cut-through connection must be gated
  by the same load cap as any cutting move.
- **T6 consumer re-audit rule.** A change to how the belief is built (fold
  geometry, resolution, tolerance) requires re-running T1-T3 and the
  engagement gates before landing - the WO-410 lesson as a checklist item.

## 7. Open questions for Operator (each becomes law on his answer)

1. Tier-0 cut-through: adopt the ancestor's "short connection cuts through
   at feed under the load cap" as our missing tier? (Recommended - it is
   what the working ancestor does, and it erases micro-hop retracts.)
2. Tier-2 micro-lift: what stay-down height? (Ancestor: a Lift Distance
   property; machinist norm 2-5 mm; must clear standing rims by proof or
   geometry.)
3. T1 allowance and T2 factor K.
4. reference retract counts: read them off a preview per fixture, or
   accept tier budgets as the bar?
5. Detour budget ratio for tier 1 (ancestor default ~3x direct distance).
6. Does W2/W3's region-count gate wait for the region-lineage work AC-SPEC
   G describes, or do T1-T2 stand in until then?
