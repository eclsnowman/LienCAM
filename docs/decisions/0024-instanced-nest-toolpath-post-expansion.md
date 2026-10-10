# 0024 — Instanced nest toolpath and post-expansion contract

Date: 2026-06-17
Status: Accepted (2026-06-20; was Proposed — the instanced-toolpath contract and
its post-expansion model, as revised by Amendment 1, shipped in nesting phases P6/P7
and passed the operator's visual gate, so the contract now constrains all new code)

## Context

True-shape nesting (docs/planning/NESTING-SPEC.md) packs many copies of a small
set of source parts onto sheet stock. A naive implementation would duplicate the
geometry per copy and recompute a toolpath per copy. For a sheet packed with 40
copies of one bracket that is 40x the geometry memory and 40x the toolpath
compute for an identical result rotated/translated. the operator's core requirement
(SPEC, confirmation C2) is the opposite: store the nest as instance RECORDS and
compute the toolpath ONCE per unique source part.

The current pipeline (verified by recon, 2026-06-17):
- `ToolpathMove` (src/types/index.ts:372-384) is a flat array per operation:
  `{ type: 'rapid'|'feed'|'arc_cw'|'arc_ccw', x, y, z, feed?, cx?, cy?, role?,
  engagement? }`. Moves carry WORLD coordinates; arc centers `(cx,cy)` are
  absolute (src/lib/cam/coords.ts).
- A toolpath is computed once per operation and stored on the op object
  (`Operation.toolpathMoves`, src/store/index.ts computeOperationToolpath ->
  updateOperation).
- The postprocessor consumes ops strictly in array order
  (buildPostInput.ts -> assemble.ts -> emit.ts). It already applies a per-move
  world->work transform `toWork = R^T*(world - wcs.origin)` at emit time
  (emit.ts:411). There is NO cut-sequencing logic today; order == op array order.
- ADR 0001: operations emit controller-agnostic `ToolpathMove[]`; all
  replication/dialect/formatting belongs to the post.

Inside-window nesting (SPEC confirmation C3) adds a hard SAFETY constraint:
a part nested inside another part's interior loop must be cut BEFORE the host
part (innermost-first), so already-cut stock cannot shift. No recursion in v1.

## Decision

Adopt an INSTANCED model for nests. Three contracts:

### 1. Data model — instance records, no geometry duplication

A nest is a record set, not duplicated geometry. It surfaces as a pseudo
"Nest Geometry" node in the geometry tree (renameable). It holds:
- The sheet definition (fixed size, or the solver-produced size) and the chosen
  nesting style + spacing params.
- A list of PLACEMENTS. Each placement:
  `{ id, sourcePartId, x, y, rotationDeg, locked, windowParentId? }`.
  `windowParentId` is set when this placement sits inside another placement's
  interior-loop "window"; otherwise null.

The renderer instances each placement from the SINGLE stored source geometry by
applying the placement's 2D rigid transform. No copy of the loop data is stored
per placement.

### 2. Toolpath — computed once per source, expressed in source-local frame

A source part's toolpath is computed ONCE (its existing op pipeline), NOT per
placement. Because moves today carry world coordinates tied to the part's actual
position, the instanced source toolpath is treated as living in the source
part's LOCAL 2D frame (origin = the part's canonical placement origin). The
placement transform then maps local -> nest-world; the existing emit-time
world->work transform is unchanged downstream of that.

Concretely, the instance transform for a placement `p` applied to a source move
is a 2D rigid transform `M(p) = translate(p.x, p.y) . rotate(p.rotationDeg)`,
applied to:
- the move endpoint `(x, y)`,
- the arc center `(cx, cy)` when present.
`z`, `feed`, `role`, and arc direction are untouched. (A pure rotation+
translation preserves arc handedness and feed-by-role; mirror is NOT used.)

### 3. Post-expansion — replicate at emit time, innermost-first

Expansion happens in the POSTPROCESSOR, inside the per-op motion block
(emit.ts:367-427), NOT by emitting duplicate `ToolpathMove[]` from the operation
layer. For each nested operation, the post iterates that source part's
placements and re-emits the transformed move stream per placement, inserting an
inter-copy TRAVEL/link sequence between copies (retract to clearance -> rapid to
next copy entry -> plunge), preserving modal state and feedrate-by-role.

ORDERING (C3, innermost-first). Each placement has a depth: a windowed child has
`depth = host.depth + 1` (v1: max depth 1, no recursion). The nest is emitted as
a single logical unit ordered by DESCENDING depth — every windowed-child
placement is emitted before its host placement, across all source parts — so a
host part is never cut while a part still sits uncut inside its window. Within a
depth tier, placements are grouped by source part/op to minimize tool changes.
Correctness (innermost-first) outranks tool-change minimization: if a child and
its host use different tools, the post accepts the extra tool change rather than
violating cut order. Non-nest operations retain today's array-order emission.

This ADR is Proposed; implementation is scheduled for nesting phases P6
(instanced toolpath) and P7 (post-expansion). It is recorded now because it
constrains the nest data model (P3) and the engine's placement output (P1).

## Alternatives considered

**Duplicate geometry + recompute toolpath per copy.** Simplest to bolt on; the
post needs no new concept. Rejected: defeats the entire requirement (C2) —
40x geometry memory and 40x compute for identical replicated results, and the
slow path the operator explicitly called out as resource-wasteful.

**Expand instances at toolpath-COMPUTE time (emit duplicate `ToolpathMove[]`
from the operation/store layer).** Keeps the post simple. Rejected: it pushes
nest awareness into the operation layer, straining ADR 0001 (operations would
replicate and order copies — a post/replication concern), and re-bloats the
stored toolpath to 40x. The post already transforms every move world->work, so
replication is a natural extension of an existing seam, not new layering debt.

**General per-op dependency graph for cut ordering.** A full DAG of "op X before
op Y" would subsume innermost-first. Rejected for v1 as over-built: the only
ordering constraint v1 needs is depth-descending within a nest (no recursion).
A depth tier is sufficient and far simpler; a general graph can supersede this
ADR later if multi-level or cross-part constraints arrive.

## Consequences

**Positive:**
- Geometry stored once; toolpath computed once per source part. Memory and
  compute scale with the number of SOURCE parts, not the number of copies.
- Replication stays in the post, consistent with ADR 0001 (geometry replication
  is not gcode/M-code logic; it rides the existing world->work seam).
- The instance transform is a clean 2D rigid map; arc handedness and
  feedrate-by-role are preserved by construction.
- Innermost-first cut order is enforced at one place (the post emission order),
  not scattered through operations.

**Negative / costs:**
- Requires the instanced source toolpath to be expressed in (or reducible to)
  the source part's local frame — a deliberate change from "moves carry the
  part's actual world position." P6 must define how the source pose is captured
  and subtracted.
- Innermost-first ordering can force extra tool changes when a windowed child
  and its host use different tools (accepted: correctness > tool-change count).
- The post grows a nest-aware emission path (depth tiers, per-placement
  transform, inter-copy travel). buildPostInput / assemble / emit must learn the
  nest unit; non-nest ops are unaffected.
- Backplot/estimate (estimateRuntimeMs) must expand instances too, or report
  per-source and note the multiplier, to keep cut-time estimates honest.

## Amendment 1 — travel + ordering are a SOFTWARE concern, not the post (2026-06-20)

Status: Accepted (supersedes section 3 "Post-expansion" of the original decision)

During P6 review the operator rejected the original section-3 plan that the POST replicates
copies and INVENTS the inter-copy travel at emit time. The reason is a hard safety
requirement: inter-copy rapids can crash clamps, vises, and workholding. A rapid the
operator never sees and never simulates is a machine-crash risk. Therefore every
inter-copy travel move and the whole multi-copy machining ORDER must be generated as
real `ToolpathMove[]` IN SOFTWARE so they are rendered in the Toolpath view, run
through the Simulation, and counted in the cut-time estimate — exactly like any other
move. The post then only FORMATS that already-expanded stream.

This does NOT weaken ADR 0001. ADR 0001 says operations/the post emit no GEOMETRY and
make no controller-specific choices. Generating travel moves so they can be seen and
simulated is a software/toolpath concern, not gcode formatting; the post still only
formats `ToolpathMove[]` it is handed. What moves is WHERE the expansion lives:
out of emit.ts and into a shared, pure nest-level expander.

### Revised contract (FINAL, replaces section 3)

1. ARCHITECTURE = option (b). Each op's seed toolpath stays stored SEED-LOCAL
   (preserves the P6 frame-invariance from section 2 — moving the nest never
   restales a seed op). ONE shared, pure NEST-LEVEL expander (the existing
   `expandSourceMoves` in src/lib/cam/nesting/instanceToolpath.ts, extended)
   produces the full multi-copy `ToolpathMove[]` stream: flatten all placements,
   insert inter-copy travel, order copies, and apply `NestRecord.origin` as the
   world offset. The expander is NOT baked into `op.toolpathMoves` (that would be
   the rejected option (a) and break seed-local invariance). It is re-derived on
   demand (memoize by a nest key only if profiling shows it is needed).

2. ONE expander, FOUR identical consumers. The Toolpath view (Viewport.tsx render
   effect), the Simulation (SimulationPanel frame build + pre-carve), the post
   (emit.ts per-move walk), and the cut-time estimate (nestRuntime.ts) all consume
   the SAME expander output. They must agree by construction — no second travel
   model anywhere.

3. The expander is a NEST-LEVEL operation. It spans ALL seed ops of a nest and
   orders across sources; it is NOT a per-op render gate. (`renderMovesForGeo` /
   `seedSlotMoves` remain the per-op seed-slot render helpers from P6; the expander
   is the nest-wide stream.)

4. MACHINING ORDER = `NestRecord.machiningOrder`: `'by-operation'` (DEFAULT) or
   `'by-part'` (user-selectable toggle on the nest, exposed in NestProperties per
   the Many-Paths principle). by-operation = each op across all copies (all internal
   features on all parts before any cutoff -> parts stay anchored; fewer tool
   changes). by-part = all ops on copy 1, then copy 2, ... (frees parts as you go).
   BOTH are supported.

5. COPY VISIT ORDER within an op = innermost-first
   (`orderPlacementsInnermostFirst`, windowed children before hosts — the section-3
   safety invariant is RETAINED) THEN a deterministic NEAREST-NEIGHBOR pass to
   minimize rapids, with a deterministic tie-break so the stream is byte-stable.

6. INTER-COPY TRAVEL = retract -> rapid -> plunge, reusing the
   src/lib/cam/moves/index.ts primitives and each op's existing `retractMode` +
   `resolveHeights` (clearanceZ / retractZ / feedZ). NO new height vocabulary
   (ADR 0002 — the five canonical planes only).

7. COLLISION = visualize + simulate ONLY. There is no clamp/fixture/collision model
   in the app; the operator judges clamp/workholding risk by eye against the rendered
   and simulated travel. Automated collision avoidance is explicitly OUT of P7 scope
   (a separate future feature).

8. The cut-time estimate now COUNTS inter-copy travel (the section-2/P6
   `travelExcluded: true` is dropped once the expander emits real travel moves).

### Consequences of the amendment

- The "post grows a nest-aware emission path" cost in the original Consequences is
  REMOVED: emit.ts gains no nest concept. If a seed op's moves are handed to it as
  the already-expanded multi-copy stream, it formats them unchanged.
- The expansion is testable as a pure function in isolation (no post, no GL, no
  worker) and is exercised identically by all four consumers.
- Re-deriving on demand trades a little recompute for zero staleness; acceptable
  because seed-local storage means there is nothing to invalidate when the nest moves.

## References

- docs/planning/NESTING-SPEC.md — requirements + confirmations C1-C3
- ADR 0001 (0001-toolpath-postprocessor-separation.md) — operations emit
  controller-agnostic `ToolpathMove[]`; replication belongs to the post
- ADR 0020 (0020-nested-coordinate-hierarchy.md) — machine/setup/stock/geometry
  frames the placement transform composes with
- ADR 0021 (0021-postprocessor-architecture-and-customization.md) — post
  architecture this expansion extends
- src/types/index.ts:356-384 — `MoveRole`, `ToolpathMove`
- src/lib/post/emit.ts:367-427 — per-op motion block where expansion hooks in
- src/store/index.ts — `computeOperationToolpath`, per-op toolpath storage
