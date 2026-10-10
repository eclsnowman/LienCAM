> HISTORICAL - SHIPPED. This is a branch-era development log. This subsystem is
> DELIVERED and merged to main; its current feature status lives in
> docs/FEATURE-HITLIST.md Part 1 (the single delivered-vs-not authority). Do NOT
> consult this file for current status. Kept for implementation history only.
> Live reference for ongoing work: docs/FEATURE-HITLIST.md.
> (Banner added 2026-06-24 doc consolidation.)

# Face 2D — STATUS

Active-development tracker for the 2D facing operation. Design of record:
ADR 0015 (`docs/decisions/0015-2d-facing-operation.md`).

## Milestone tracker

| Milestone | Scope | Commit | State |
|---|---|---|---|
| M0 | Design of record — ADR 0015 + this STATUS | `204d1f8` | done |
| M1 | Worker-protocol types (`FaceParams`, `FaceWorkerPayload`, `COMPUTE_FACE`) | `1437bf9` | done |
| M2 | Scanline parallel-pass algorithm (`face2d/index.ts`) + 19 unit tests | `33a8d08` | done |
| M3 | Worker dispatch route | `deaf23e` | done |
| M4 | Store dispatch + stock-footprint boundary-source resolver | `110c3ff` | done |
| M5 | UI wizard — Face card + full param panel (deferred = disabled) | `dba7766` | done |
| M6 | Paired docs (docs/ARCHITECTURE.md, docs/UI-ARCHITECTURE.md) | _(this commit)_ | done |

**v1 backend + UI complete and green (typecheck + 33 face tests).** Not yet
fully visually verified — see the manual test in the session report.

### Coverage guarantee ("missing stock is not an option")

Visual review (stock-removal sim) showed uncut material. Root cause, found by
measuring the worst-uncovered point (not the centre, as first assumed): convex
inner-ring **corners**. Concentric rings offset diagonally, so consecutive ring
corners sit stepover·√2 apart — beyond tool reach once stepover > √2·R. Fixes:
- **Ring stepover clamped to 1.3·R** (offset/spiral) so corners always clear.
- **Straight-pass stepover clamped to 1.9·R** so parallel passes never ridge.
- **Angle-sampling density ~1 mm** so the spiral polyline doesn't chord corners.
- **Coverage test with teeth**: every stock point must be within R of a cut
  segment, asserted for all patterns at default AND oversized stepover (the
  oversized cases fail without the clamps — verified), plus a concave L-shape.

### Spiral centre — smooth cleanup (replaces the earlier center hacks)

Visual review showed the spiral centre was jagged/ugly. Two causes fixed:
- **Ray-cast-from-centroid sampling** picked the *farthest* boundary hit, which
  jumps across a concave notch (the slot) → erratic geometry. Replaced with
  **arc-length resampling** (robust on any simply-connected concave shape; no
  "centre sees the ring" assumption). Start oriented by Pass-angle via one ray
  cast, then chained ring-to-ring so the morph doesn't twist.
- The bolted-on **centre hacks** (toolRadius cleanup rings → pitch
  discontinuity; innermost re-trace; radial centroid spike) are removed.
  Replaced by a **smooth converging final turn**: the innermost ring spirals
  into the centre over one revolution (each sample migrates toward the centroid),
  covering the residual centre disc without abrupt loops or a spike.
- Coverage still gated (incl. concave L + elongated 90×24). Even-division
  stepover + light smoothing removed the centre pigtail and corner kinks.

### KNOWN LIMITATION (measured): branched / slotted centres

A part with a slot/notch (e.g. the Platte C) makes the inner region **branched**
(U-shaped). Measured on a notched fixture: the spiral leaves **8.67 mm uncut**
(offset 6.43 mm) — and the convergence centroid lands *inside the notch, outside
the material*, so the finish aims off the part. This is NOT fixable by stepover
modulation or a single-point/medial-segment convergence (tried — the
medial-segment is built off the same bad centroid and made it worse; reverted).

It is the **region-splitting / medial-axis case** = the stretch goal (research
memo in the session thread). V1 facing is clean on convex and simple-concave
single-region parts; branched/slotted parts need the medial spiral. The grid
coverage test only asserts the cases V1 supports (convex, L, elongated); a
notched/branched fixture is intentionally NOT asserted (it would fail —
documenting the boundary rather than hiding it).

**SOLVED (offset tree, no gate).** The branched/slotted limit is fixed: both the
offset AND spiral patterns now handle concave/branched contours via a recursive
clipper offset tree, so there is NO concavity gate any more. See "Concave ring
fills" below.

## Platte C contour-facing fixes (Bug 2 + Bug 1)

Selecting the real "Platte C" contour (angled, concave, with bored holes) exposed
two independent bugs. Both fixed; the medial/offset-tree stretch goal stays
deferred (user decision: keep facing V1 = stock + simple-contour, do not turn it
into an AC-sized research project).

- **Bug 2 — turns at angled top/bottom edges (zigzag).** A boustrophedon turn now
  stays DOWN as one continuous cut whenever the connecting move stays inside the
  overrun envelope (`stayDownEnvR`, region grown by the overrun, in the scan
  frame) — even a long diagonal riding a slanted edge. It retracts ONLY when the
  move would leave the envelope, i.e. cut across a gap/slot outside the region
  (`segmentInsideRot` samples the move). So a single-span contour like the Platte C
  never retracts mid-level; a slotted contour retracts across the slot but cuts no
  material it should keep. (Supersedes the first attempt, which retracted on any
  X+Y jump `dx' > toolRadius` — that left visible retract segments at the slanted
  edges; the user's rule: just stay down and go there, one continuous move.)
- **Bug 1 — spiral/offset tangle on concave/branched (SOLVED, offset tree).** See
  "Concave ring fills" below. The earlier fail-loud gates (sharp-corner count, then
  total-reflex-turning > 45°) were stopgaps and are now removed.

## Concave ring fills — clipper offset tree (offset + spiral)

Both ring patterns build a recursive **offset tree** on `clipper2-wasm` instead of
the naive single-region miter offsetter, so concave/branched contours (the Platte
C) are handled instead of tangling:

- `clipperOffset.ts` — `ensureClipperReady()` loads clipper2-wasm once (async, in
  the worker before a face op; `buildFaceToolpath` stays sync). `offsetLoop(loop,
  delta)` offsets a loop (delta<0 inward, >0 outward) with ROUND joins and returns
  the MULTIPLE disjoint loops a concave region splits into. clipper trims the
  self-overlap a miter offset leaves at concave corners (the spike that broke the
  inward chain). The outer ring is also a clipper offset (`ringRoots`), not miter.
- `buildRegionTree()` — offset inward along each run; when a loop splits into N,
  recurse each as its own sub-region (`RegionNode` tree).
- OFFSET (`cutLevelOffset`/`emitOffsetNode`): nested rings outside-in per region,
  reposition (retract/rapid/plunge) into each sub-region, centre cleanup at leaves.
- SPIRAL (`cutLevelMorphedSpiral`/`emitSpiralNode`): a TRUE morph spiral per run
  (radius shrinks continuously over each revolution), sub-regions spiralled
  recursively, leaf converges to centroid. Uses the user's stepover (clamped only by
  the shared 1.3·R convex-corner rule, like offset). A morphed spiral sweeps each
  annulus once, so its coverage on a CONCAVE region is stepover-bound — it clears at
  reasonable stepovers but not arbitrarily coarse ones; offset/zigzag are the
  any-stepover guaranteed-coverage choice. (A medial-axis/Fermat spiral would lift
  that; out of scope.) clipper round joins → no miter kinks.
- PERF: `offsetLoop` decimates each offset ring to ~0.2 mm vertex spacing — without
  it, successive inward offsets accumulate round-join vertices and the O(N·n) morph
  resample blew up to seconds per region at fine stepovers (now ~ms).
- No concavity gate. Vite worker: clipper's wasm is resolved via a `?url` asset +
  `locateFile` in the browser (Node/vitest uses the default). Coverage tests assert
  both patterns clear the L-shape and a slotted/concave contour.

## v1 scope (active)

- Boundary source: **stock** only (fixed-stock footprint; auto-stock TBD — see below).
- Pattern: **linear** parallel passes and **zigzag** (both-ways).
- Pass angle (deg), start side / from-other-side.
- Cut direction: climb / conventional / both-ways.
- Stepover (radial), pass extension (overrun), stock offset, boundary containment.
- Multi-Z stepdown with optional per-level direction alternation (both-sides).
- Radial + axial (floor) stock-to-leave; optional finish pass with its own feed.
- Heights: five-plane vocabulary; top reference defaults to stock top.
- Linking: plunge entry; stay-down / retract between passes; extend-before-retract.
- Transitions: straight + smooth.
- Chord tolerance.

## Future Requirements (deferred — typed, greyed in UI, fail-loud if invoked)

Each item is present in `FaceParams` and guarded with a named error per ADR 0003
until implemented. Implementing any of these must not require changing the
`buildFaceToolpath` boundary contract.

- [x] **Boundary source `geometry`** — DONE. Face a selected closed contour
      (UI "Contour" source). The store reuses the existing geometryId/loopIds
      loop-build + loop picker; the algorithm stays source-agnostic. Top plane
      defaults to geometry_face. Boundary containment lets the tool overrun, ride,
      or stay inside the contour. (Branched/slotted contours hit the same
      single-region limit documented above.)
- [ ] **Boundary source `rest`** — face the uncut surface left by a prior
      operation (rest machining). Gated on rest machining being well-controlled.
- [x] **Auto-stock footprint** — DONE. The store reads the rendered stock AABB
      from the viewport (`getStockBounds`), which works for both fixed and auto
      stock and also supplies the correct top-Z for auto stock. Falls back to the
      project-data footprint for fixed stock when the viewport is unavailable.
- [x] **Offset / contour-parallel pattern** — DONE. Concentric closed rings
      stepping inward from the overrun perimeter, cut outside-in with a centre
      cleanup (`cutLevelOffset`). v1: single ring per generation (robust for
      convex / rectangular stock; concave best-effort), plunge entry, climb or
      conventional. Future polish: ramp/helix entry, concave ring splitting.
      (This is the "Offset"/"Concentric" strategy — closed loops, not a
      continuous spiral; see the separate true-spiral item below.)
- [ ] **True spiral (morphed)** — CORRECTED 2026-07-15 (truth reconciliation):
      this entry previously read "DONE" but the morphed-spiral pattern was
      REJECTED on visual review (twice) and REMOVED from the code. At HEAD
      there is no `cutLevelMorphedSpiral` in face2d and the `FacePattern`
      union (src/lib/cam/types.ts) has no 'spiral' member — shipping patterns
      are linear / zigzag / one_way / offset. If a facing spiral is ever
      revisited, the agreed direction is a SINGLE continuous INWARD spiral,
      NOT a Fermat/morph interleave (docs/FEATURE-HITLIST.md Part 2 "Face2D
      inward-spiral pattern [someday]"; docs/UI-ARCHITECTURE.md 15.1).
- [ ] **Arc lead-in / lead-out** (`leadInRadius`, `leadOutRadius`).
- [ ] **Chip thinning** loops at pass entry.
- [ ] **High-feed / no-contact transitions.**
- [ ] **Avoidance regions** — islands/features to keep clear (`avoidanceLoopIds`).

## Notes / open recon

- Stock-footprint XY synthesis reuses the bound-`FixedStockItem` lookup pattern
  from `resolveTopZ` in `src/store/index.ts` (resolves via `setup.wcs.stockId`).
- Outward-overrun convention (ADR 0015 §2): the tool-centre fill region is the
  boundary offset *outward* by `toolRadius`, the inverse of pocket's inset.

## TRUTH NOTE 2026-08-04 (housekeeping sweep, HEAD 4c36467e0)

The CAM-14 Face2D corner-fidelity repair shipped after the 2026-07-15 truth
note: the clipper round-join and decimation path was tightened, then repaired
with sagitta-bounded fidelity and matching truth/comment cleanup
(`05ebac4c2`, `e65e4eae6`, `1cc59d671`, `544da08f4`). The shared
insufficient-flute-reach fail-loud guard also now covers Face2D (`24fb11a56`).

Current delivered-vs-not truth remains code plus docs/FEATURE-HITLIST.md. No
test or build gate was rerun for this documentation reconciliation; all older
counts above remain historical evidence for their named commits.
