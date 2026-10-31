# 0031 — Thread-milling operation: pure helix core, bottom-to-top, hand-locked orbit

Date: 2026-06-25
Status: Accepted

## Context

`'thread_mill'` was already a declared-but-unimplemented member of the
`OperationType` union (`src/types/index.ts`), and a `thread_mill` operation
SILENTLY FELL THROUGH to `COMPUTE_CONTOUR` in the store dispatch — producing a
wrong toolpath (a profile cut) instead of failing or threading. A `thread_mill`
TOOL type already existed (rendered as a cylinder of the cutting diameter via
`toolProfile.ts`).

Thread milling cuts a thread by helical interpolation: the cutter orbits the
hole wall while climbing one thread pitch per revolution. The hole must ALREADY
be drilled/bored — by a SEPARATE drill operation that is the user's
responsibility — larger than the tool and below the thread bottom, so the cutter
can plunge straight down an open hole before it starts orbiting.

This is the next standard 2D operation to close out (CLOSE OUT THE LOGICAL 2D
OPERATIONS, FEATURE-HITLIST). The toolpath is fully representable as
`ToolpathMove[]` (helix moves) and posts on every dialect, and the 3D voxel sim
(ADR-0028) can visualize the undercut thread form, so neither posting nor
visualization is a blocker. The remaining work was the operation itself.

The user's directive (as with ADR-0015 facing): build a commercial-grade
operation with the full timeline-based CAD/CAM system-style configuration surface present from day one,
deferring implementation of advanced members but never losing track of them.

## Decision

### 1. Module split: pure helix core vs. op builder

The helix geometry is a PURE, side-effect-free core in
`src/lib/cam/threadHelix.ts` — no `Math.random`, no `Date`, no I/O, type-only
imports — exporting:

- `threadOrbitDirection(kind, hand, cut)` — resolve the orbit sense (see §5).
- `generateThreadHelix(spec)` — the dense feed/role:`'helix'` polyline.
- `generateLeadArc(spec)` — a tangent lead-in/lead-out semicircle of radius R/2.
- `HELIX_FI_STEP` — the angular step (PI/16 rad) for the dense polylines.

The op builder `src/lib/cam/threadmill2d.ts` exports the single entry function
`buildThreadMillToolpath(payload, onProgress?)` per the operation contract
(docs/ARCHITECTURE.md §Operation contract). The builder COMPOSES the pure core
with selection, height/feed resolution, the radial pass schedule, and the
fail-loud guards. The core is unit-testable in isolation; the builder is tested
end-to-end (`src/tests/cam/threadmill2d.test.ts`).

### 2. Toolpath model: bottom-to-top helix, per hole and per radial pass

For each selected hole and each radial pass the builder emits:

1. rapid to the hole center at `clearanceZ`, then to `feedZ`;
2. a straight `plunge` down the OPEN pre-cleared hole to the thread bottom
   (`bottomZ`);
3. a tangent `lead_in` (arc semicircle of radius R/2, or a straight feed when
   `leadInOut: 'none'`) from the hole center out to the orbit radius;
4. the dense `feed`/role:`'helix'` polyline, climbing BOTTOM-TO-TOP, advancing
   exactly `pitch` per full revolution at the thread orbit radius, landing
   EXACTLY on `topZ`;
5. a tangent `lead_out` back to the hole center;
6. a `rapid` retract to `clearanceZ`.

The helix is emitted as a DENSE POLYLINE of `feed` moves — NOT a single G2/G3
helical arc. This is post-safe on every dialect and renders in the backplot
today. True helical-arc output is a deferred optimization that the post's arcfit
can later collapse the polyline into.

### 3. Heights: the five canonical Z planes (ADR-0002), no new modes

The operation uses the canonical Z vocabulary: `topZ` = thread top, `bottomZ` =
thread bottom, resolved by the shared `resolveHeights()` with the SAME
top/bottom-mode + `heightReference` resolution as drill. No operation-specific Z
names and no new height modes are introduced.

### 4. Selection: drill-style hole-loop centroids, fail loud on orphans

Selection mirrors drill: each selected loop's centroid is a hole center, and the
operation fails loud (ADR-0003) on an orphaned `loopId` (geometry re-derived ->
loop ids re-minted) with an actionable re-select message rather than emitting
nothing. The selected loop IS the pre-cleared hole, so the builder also computes
a conservative hole diameter (the MIN of the loop's XY bounding-box width and
height) and runs an EXPLICIT per-hole fit guard (§6): the tool cutting diameter
must be strictly less than that hole diameter, else it throws. This is a
DISTINCT check from the orbit-radius guard — a tool can satisfy the
major-diameter math (`R_final > 0`) yet still be wider than the actual drilled
hole and gouge on the plunge. The builder does NOT inspect hole depth — it
assumes the hole runs below `bottomZ`.

### 5. Orbit direction is a single source of truth, hand-locked

`threadOrbitDirection(kind, hand, cut)` is the ONLY place the orbit sense is
decided. The key geometric reasoning, recorded here:

- For BOTTOM-TO-TOP travel the orbit SENSE is geometrically locked by the thread
  HAND. Following a thread groove upward, a right-hand thread ascends
  counter-clockwise (+1, looking down the -Z axis from +Z); a left-hand thread
  ascends clockwise (-1).
- `internal`/`external` changes the orbit RADIUS only (which side of the wall the
  tool center sits on), NOT the sense.
- climb vs. conventional at a FIXED spindle direction and a FIXED bottom-to-top
  travel does NOT flip the orbit sense — climb/conventional is a consequence of
  spindle direction plus which flank engages, not an independent orbit knob at
  fixed travel.

So in v1 the helper returns a sign determined by `hand` alone; `kind` and `cut`
are validated and reserved for forward-compat. The TRUE physical
climb-correctness (which depends on the real spindle direction M3 and the flank
that engages) is a STAGED VISUAL GATE for the user on the sim — it is NOT an
autonomously-claimed result. The single-knob design means that if the sim shows
the orbit reversed, the correction is a one-line change in
`threadOrbitDirection`.

### 6. Fail-loud surface (ADR-0003)

Every out-of-scope or degenerate input throws with a `'Thread mill:'` prefix
rather than silently degrading:

- `threadKind` is `external` (v1 is internal only);
- `pitch <= 0` (pitch resolves from `tpi` when given, else the explicit `pitch`);
- `majorDiameter <= 0`;
- `topZ <= bottomZ`;
- `roughingPasses < 1`;
- `springPasses < 0`;
- `compensation` is not `'computer'`;
- an orphaned or empty hole selection;
- a tool too large for the major diameter (computed orbit radius
  `majorDiameter/2 - toolRadius <= 0`);
- a tool too large for the selected pre-cleared hole (tool cutting diameter
  `>=` the hole's conservative min-bbox diameter) — a distinct guard from the
  orbit-radius one.

### 7. Full timeline-based CAD/CAM system-style param surface from day one

`ThreadMillParams` (`src/lib/cam/types.ts`) carries the complete configuration
surface from the first commit: `threadKind`, `majorDiameter`, `pitch`/`tpi`,
`handedness`, `cutDirection`, `roughingPasses`, `springPasses`, `leadInOut`,
`compensation`, and `heightReference`/`planeOffset`. Members not implemented in
v1 are typed, shown greyed/disabled in the wizard, and fail loud if a project
arrives with them set to an unimplemented value — the deferred-members-fail-loud
precedent from ADR-0015.

## Alternatives considered

- **Reuse `emitHelixRamp()` from the AC engine directly.** Rejected: that helix
  DESCENDS top-to-bottom with `depthPerCircle` derived from a helix angle.
  Thread milling needs to CLIMB bottom-to-top with `depthPerCircle = pitch`
  EXACTLY and land exactly on `topZ`. A dedicated pure core is clearer, encodes
  the exact-pitch / exact-top-landing contract, and is independently testable.
- **Emit a single G2/G3 helical arc.** Rejected for v1: a dense polyline is
  post-safe on every dialect and renders in the backplot now; arc output is a
  later optimization (the post's arcfit can collapse the polyline). Shipping the
  arc form first would couple v1 to per-dialect helical-arc support.
- **Let climb/conventional flip the orbit sign.** Rejected: at a fixed
  bottom-to-top travel, flipping the orbit sense would cut a MIRROR-IMAGE
  (wrong-hand) groove. The orbit sense must follow the thread HAND; climb vs.
  conventional is a spindle/flank consequence, not an orbit-direction input at
  fixed travel.

## Consequences

Positive:
- Kills the silent `COMPUTE_CONTOUR` fall-through (a wrong toolpath now becomes a
  real thread or a loud failure).
- The pure helix core is reusable and unit-tested in isolation.
- A SINGLE orbit-direction knob makes the only physically-uncertain choice a
  one-line change after the user's visual sim review.
- External threads, thread-size-standard presets, and helical-arc output are all
  ADDITIVE follow-ups — they do not restructure the operation.

Negative / costs:
- v1 is INTERNAL-only and BOTTOM-TO-TOP-only.
- The achieved climb/conventional is a CONSEQUENCE of geometry + spindle in v1,
  not independently selectable without adding top-to-bottom travel — a
  documented follow-up.
- The dense-polyline helix is larger in the toolpath/g-code than a single
  helical arc until arcfit lands.

### v1 follow-ups (deferred, tracked)

- External threads (`threadKind: 'external'`).
- Thread-size-standard presets (e.g. select "M10x1.5" -> auto-fill
  `majorDiameter` + `pitch`).
- Thread-teeth tool visualization (single-point cylinder today). [DONE in
  Amendment 1 for the tool VIEWS via `buildThread()`; the voxel-sim thread-form
  carve + the full-form single-orbit toolpath remain deferred.]
- True helical-arc g-code output (collapse the dense polyline via the post's
  arcfit).
- `'control'` compensation (computer comp only in v1).

## Amendment 1 (2026-06-25): tool geometry, smart depth, passes UI

A second round of thread-milling work landed three improvements. None changes
the helix-core toolpath contract above; they refine the tool model, the height
resolution, and the wizard surface. The original Context / Decision /
Alternatives stand as written.

### A1.1 Thread-mill tool geometry: thread teeth + a relieved neck

The thread-mill tool is no longer drawn as a plain cutting-OD cylinder. A new
`'thread'` member of the `ProfileKind` union and a `buildThread()` generator in
`src/lib/tool/toolProfile.ts` emit a triangle-wave silhouette at the tip: N
V-form teeth over `N * pitch`, where `toothDepth = (pitch/2) / tan(formAngle/2)`,
the crest radius is the cutting OD, and the root dips to `crest - toothDepth`
(clamped to never collapse below 40% of the crest radius). Above the teeth the
profile draws the optional relieved neck and then steps to the shank, mirroring
`buildFlat`. Three new OPTIONAL `Tool` fields drive it: `threadFormAngleDeg`
(default 60), `threadTeethCount` (1 = single-point, N = full-form), and
`threadPitch`. When `threadPitch` is unset or `<= 0`, `buildThread()` returns the
exact `buildFlat` cylinder, so EXISTING thread-mill tools are byte-identical and
NO schema migration is required (the fields are additive optionals).

Because the revolved profile is the single source of truth (ADR 0030), the same
`buildThread()` output drives BOTH the 2D `ToolDiagram` and the 3D lathe render —
the teeth appear in the tool VIEWS for free. The Tool Library Cutter tab exposes
the neck plus the three thread fields for thread mills, and the live
`ToolDiagram` preview was wired to receive them so edits update the silhouette.

HONEST LIMITATION (known deferral): the voxel simulation (`carve.ts`) still
models the thread mill as a constant-radius (crest-OD) half-space, so it does NOT
carve discrete thread forms onto the wall during the orbit. The teeth show in the
tool views only, not in the sim. Carving the true thread form requires a
z-varying revolved-solid carve and remains a deferred follow-up — it does not
gate this round.

This extends the ADR 0030 revolved-profile tool model (one `buildToolProfile`
keyed on `profileKind`); the teeth are just another `profileKind` branch.

### A1.2 Smart heights: thread milling is TOP-referenced like chamfer

Thread milling now resolves its Z planes chamfer-style. The Heights-tab reference
plane sets the thread TOP (default `geometry_face` = the face the thread enters),
and a new `ThreadMillParams.threadDepth` field (`src/lib/cam/types.ts`) drives
`bottom = top - threadDepth`. The store resolves this in the same chamfer-style
branch (`src/store/index.ts`), independent of the op-level top/bottom modes.
Covered by `src/tests/store/dispatchHeights.test.ts` (top rides the reference
face; a deeper `threadDepth` pushes the bottom further down with the top fixed).
This supersedes the original §3 phrasing for the BOTTOM plane only — `topZ` /
`bottomZ` are still the canonical names that reach the worker (ADR 0002); the
change is HOW the bottom is derived in the store, not the worker contract.

### A1.3 Passes UI: radial-infeed model, not axial stepdown

The thread op no longer shows contour's Depth-of-cut / Stepdown /
Cutting-strategy / stock-to-leave / Contour-overlap block, because thread milling
has NO axial stepdown — it climbs in one continuous helix. The former "Roughing
passes" control is renamed "Radial infeed passes" with help text explaining that
infeed steps the orbit RADIUS outward toward the final major diameter, not Z. The
Passes tab therefore carries lead in/out, compensation, radial infeed passes, and
spring passes only.

### A1.4 Unchanged in this round

Single-point remains the v1 TOOLPATH: the helix still orbits a single radius
schedule. `threadTeethCount > 1` draws a full-form tool but does NOT yet emit a
full-form single-orbit toolpath — that remains deferred alongside external
threads, size presets, `'control'` compensation, and true helical-arc output.

## Amendment 2 (2026-06-26): exit climb, neck transition cone, field order

A third round of review-driven refinements. None changes the orbit-direction or
fail-loud contracts above.

### A2.1 Exit climb — thread fully out of the hole before retract

RETIRED by Amendment 10 (2026-10-23, WO-3080): the ascending thread now ends at the
hole top and retracts up the open centre. Kept below as history.

The helix no longer ends at `topZ` (inside the hole) followed by a lead-out and
retract from the thread top. After cutting the thread to `topZ` the builder
CONTINUES the helix at the thread radius up to the feed plane (`feedZ`, above the
stock), then leads out and retracts from there — the cutter threads its way fully
OUT of the hole rather than retracting from inside it. The orbit phase continues
seamlessly (the exit climb's duplicate junction point is dropped so Z stays
strictly increasing); above the stock top the exit climb cuts air. Guarded: no
exit climb when `feedZ <= topZ`. Builder tests assert the helix reaches the thread
top AND lands on the feed plane, and that the lead-out is at the feed plane.

### A2.2 Tool neck -> shank transition cone

`buildThread()` blends the neck to the shank with a CONE instead of a sharp
vertical step (most real tools are not a sharp step). New optional Tool field
`neckTransitionAngleDeg` (angle from the tool axis per ADR-0029; 90 = sharp step,
default 30 = gentle taper); cone rise `dz = (Rsh - Rn)/tan(angle)`, clamped
`(0, 90]`, `dz = 0` at 90. Shown in the Tool Library for thread mills and wired
through the live `ToolDiagram` preview. `buildFlat` (other necked tool types) is
unchanged. The Thread-form inputs are reordered to vertical teeth -> form angle ->
pitch.

### A2.3 Radial infeed stepover

The radial infeed is now driven by a stepover (the max radial bite per pass)
rather than only an explicit pass count. New optional `ThreadMillParams.radialStepover`
(mm): when set, the number of roughing passes is derived as
`ceil(threadDepth / radialStepover)` with bites distributed evenly so each is
`<= radialStepover` (mirrors the axial-stepdown convention; the wizard shows the
derived pass count). `roughingPasses` is retained as a legacy fallback used only
when no stepover is given, so existing projects/tests are unchanged. The radial
span is still the `~0.6 * pitch` thread-height approximation; deriving it from the
real selected-hole diameter is a noted future refinement.

### A2.4 Deferred (tracked elsewhere)

A user-facing decimal-rounding pass (calculated values showing float noise) was
raised this round and is deferred to a project-wide UI audit — it is not specific
to thread milling.

## Amendment 3 (2026-06-26): real per-hole internal span, external threads, size presets

A fourth round landed three changes. None alters the orbit-direction (§5) or the
fail-loud (§6) contracts; the orbit SENSE stays hand-locked for both kinds.

### A3.1 Internal radial span is now REAL per-hole geometry (commit a9a5f2c)

The internal radial-infeed span is no longer the `~0.6 * pitch` thread-height
approximation noted in A2.3. It is now derived from the REAL selected-hole
geometry, PER HOLE: `spanReal = (majorDiameter - holeDia)/2`, with
`R_start = R_final - spanReal` (the tool just touching the pre-drilled hole wall)
stepping OUTWARD to `R_final`. The infeed schedule moved INSIDE the per-hole loop,
so a selection of different-diameter holes each gets its own derived infeed-pass
count. A new fail-loud guard (ADR-0003) throws when a hole is at or above the
thread major diameter (no material to thread / wrong hole picked). This RESOLVES
the A2.3 "derive it from the real selected-hole diameter" deferral for internal.

### A3.2 External threads implemented as the MECHANICAL MIRROR (commit 5b20ef2)

`threadKind: 'external'` is now implemented as the mechanical mirror of internal:
`R_final = majorDiameter/2 + toolR` (ADDS the tool radius instead of subtracting
it). The orbit SENSE stays HAND-LOCKED — `threadOrbitDirection` is unchanged;
internal/external changes the orbit RADIUS only, never the direction (§5). The
boss is SOLID at its center, so external NEVER crosses the boss center: the cutter
plunges in AIR beside the boss at the orbit start point and leads in/out on the
OUTSIDE via a virtual-center tangent arc; there is NO exit climb (the tool is
already radially clear of the boss after lead-out, so it retracts straight up).
The internal-only hole-fit guards (tool-fits-hole, hole-smaller-than-major) are
gated behind `threadKind === 'internal'`; the internal output is BYTE-IDENTICAL.
The original §6 "external fails loud (v1 internal only)" bullet is hereby
superseded.

CAVEAT (records the v1 limits): the external infeed DEPTH still uses the
`0.6 * pitch` approximation — deriving the real external span from a boss/root
diameter is future work. The external orbit DIRECTION and infeed SHAPE are PENDING
the user's visual-gate confirmation (a visual stage was produced at
`docs/planning/thread-mill-external-stage.html`); the single-knob design keeps a
reversal a one-line fix.

### A3.3 Thread-size presets (commit 131149f)

A "Thread size preset" dropdown in the thread-mill params UI (NewOperationModal)
batch-fills `majorDiameter` + `pitch` from a standard-size table. New data module
`src/lib/cam/threadPresets.ts` carries 16 presets (metric coarse M3–M24, common
UNC/UNF with `pitch = 25.4/tpi`, imperial diameters converted to mm). This is a
UI convenience ONLY — no builder change; "Custom" leaves the fields editable.

## Amendment 4 (2026-06-26): external thread heights are bottom-referenced

A follow-up to A3.2 corrects how EXTERNAL thread heights resolve in the store.
The orbit-direction (§5) and fail-loud (§6) contracts are unchanged; this is a
height-resolution fix only, with NO builder change (the helix builder always
climbs bottom-to-top).

Amendment 3 un-gated external milling but left it resolving heights TOP-referenced
exactly like internal. That was wrong for a boss: with the reference plane treated
as the thread TOP, external derived `bottom = top - threadDepth`, so the helix
threaded DOWNWARD into the plate BELOW the boss instead of climbing the boss. The
height branch now splits on `threadKind` (commit 7a950fd):

- INTERNAL stays TOP-referenced (like chamfer): the reference plane is the thread
  TOP (default the entered `geometry_face`) and `bottom = top - threadDepth`. The
  thread runs DOWN into a pre-drilled hole.
- EXTERNAL is BOTTOM-referenced: the reference plane is the BASE of the boss — the
  selected base loop, which derives on the stock-top plane — and
  `top = base + threadDepth`. The bottom-to-top helix then climbs UP the boss from
  the base.

Why external must reference the base: the geometry loops derive on the stock-top
plane, so the boss-TOP loop is not separately selectable. The only stable,
selectable datum is the base loop at the stock-top plane, so external heights are
governed bottom-up from that base. The wizard Heights tab reflects the split —
external shows a single "Thread depth (above base)" field (bottom-governed) while
internal keeps "Thread depth (below top)". This corrects the oversight in A3.2,
which un-gated external but inherited internal's top-referenced height path.

## Amendment 5 (2026-06-26): external reference-direction toggle + in-modal face pick

A fifth round generalizes Amendment 4's external height resolution into a
user-selectable toggle and makes the boss top directly pickable inside the thread
op. The orbit-direction (§5) and fail-loud (§6) contracts are unchanged; the helix
builder still always climbs bottom-to-top, so there is NO builder change.

### A5.1 External reference-DIRECTION toggle (commit 639ff32)

Amendment 4 made external heights UNCONDITIONALLY bottom-referenced. That is now
just one of two modes, chosen by a new optional field
`ThreadMillParams.externalReference: 'top' | 'base'` (default `'top'`; additive,
no migration). The store resolves ONE reference plane the same way for both kinds
and pins it as either the top or the bottom (`src/store/index.ts`, thread_mill
height branch):

- INTERNAL is ALWAYS top-referenced (unchanged): `top = ref`,
  `bottom = ref - threadDepth`.
- EXTERNAL `'top'` (the NEW DEFAULT): TOP-referenced — `ref` = boss top,
  `bottom = ref - threadDepth`; the thread runs DOWN from the boss top. This is
  the natural "pick the boss top and thread down" flow.
- EXTERNAL `'base'`: BOTTOM-referenced — `ref` = boss base,
  `top = ref + threadDepth`; the helix climbs UP the boss from the base. This is
  exactly Amendment 4's behavior, now the `'base'` mode.

So Amendment 4's unconditional bottom-referencing is GENERALIZED, not reverted —
it survives as the `'base'` mode while `'top'` becomes the default. The wizard
Heights tab shows a "Thread reference" select (Boss top / Boss base) for external
and flips the depth label between "below top" and "above base"; internal is
unaffected.

### A5.2 In-modal B-rep face/edge/section pick for thread_mill (commit 1b67694)

The Geometry tab now exposes the generic "Pick face / Pick edges / Section at Z"
derive controls for `thread_mill` (the visibility flags `showPickFace`,
`showPickEdges`, `showSectionZ` in `NewOperationModal.tsx` are gated to include
`isThreadMill`). A boss-top planar face can now be picked directly in the thread
op and its perimeter loop used — no separate slice step. This is pure UI gating;
the derive handlers were already op-generic. It RESOLVES the friction noted in
Amendment 4 that the boss-top loop "is not separately selectable" — with in-modal
face pick the boss top IS now selectable directly, which is what makes the A5.1
external `'top'` default practical.

## Amendment 6 (2026-06-27): smart cylinder-pick + cohesive dual-path selection

A sixth round makes the thread op operation-aware: pick a bore/boss CYLINDRICAL
face on the model and the wizard infers the thread kind, diameter, top plane, and
a default depth ("select the cylinder and it just knows"), while a bare 2D
circle/loop stays a fully manual path with an unmistakable source distinction.
The orbit-direction (§5) and fail-loud (§6) contracts are UNCHANGED, the helix
builder is UNCHANGED, and the store height-resolution contract (Amendments 4–5) is
UNCHANGED — this round is a NEW typed cylinder derive plus presentation. v1 is
VERTICAL-AXIS cylinders only. This is the first concrete proving ground for the
operation-aware smart-selection north star (the deferred whole-app UI/UX
simplification audit).

### A6.1 Cylinder-feature deriver — bores AND bosses (commit e8c3a31)

`holeFeatures` only ever returned BORES (a boss was classified by the radial-normal
axis-dot sign and then SKIPPED). A new `cylinderFeatures()` in
`src/lib/cam/geometry/occt/model/derive.ts` returns BOTH vertical bores and
bosses, each tagged `kind: 'bore' | 'boss'` from that same dot sign, and the new
`CylinderFeature` type (`src/types/index.ts`) carries `kind` + center + diameter +
top/bottom Z. `holeFeatures` and `cylinderFeatures` now share a single private
`collectVerticalCylinders` core, and `holeFeatures` is exactly the bore subset of
it — proven BYTE-IDENTICAL so the drill path is unchanged. A new
`DERIVE_CYLINDERS` worker route (`modelWorker.ts` / `modelClient.deriveCylinders`,
`DERIVED_CYLINDERS` response) plumbs it to the UI. The store's `deriveBrepLayer`
gains a `'cylinder'` kind that, for each picked cylinder, builds ONE CCW top-rim
circle `Loop2D` at the cylinder `topZ` (so the existing loop-based thread builder
still gets a center + diameter) and links the `CylinderFeature` to that loop by id.
It FAILS LOUD (ADR-0003) when the picked face is not a vertical cylinder. v1 is
VERTICAL-AXIS only; the cylinder path is a NEW typed derive, NOT a planar-loop
violation, so ADR-0018 D5 (non-planar loop rejection) does not apply to it.

### A6.2 Robust standard-thread table + nearest-snap helpers (commit c8c6b4c)

`threadPresets.ts` gains `THREAD_STANDARDS` — a 53-entry table (metric coarse
M1.6–M64, metric fine, UNC/UNF/UNEF) each with tap-drill data under the uniform
rule `tapDrill = major - pitch`. Two nearest-match helpers snap a MEASURED diameter
to the nearest standard within a tolerance, returning `undefined` when nothing is in
range: `findThreadByMajor(diameter, tol)` (a boss OD -> nearest major) and
`findThreadByBore(diameter, tol)` (a bore tap-drill -> nearest thread). This is
KEPT SEPARATE from the curated `THREAD_PRESETS` dropdown table (Amendment 3) — that
remains the by-id "Thread size preset" convenience; `THREAD_STANDARDS` is the
broader snap corpus for the auto-fill. Never forces a wrong thread: an
out-of-tolerance measurement leaves the raw measured diameter (face path) or an
unset size (loop path) for the user to set.

### A6.3 Smart auto-fill + cohesive dual-path `geometrySource` (commit 703316a)

The Geometry tab gains a "Pick cylinder (bore / boss)" control that routes a
cylindrical pick to the A6.1 derive. On a successful pick the wizard INFERS:
`threadKind` (bore -> internal, boss -> external), `majorDiameter` + `pitch`
(snapped via `findThreadByBore` / `findThreadByMajor`, falling back to the raw
measured diameter when the face is out of tolerance), the top plane
(`geometry_face` on the top-rim loop), a default `threadDepth` = the cylinder
length, and `externalReference: 'top'`. A new ADDITIVE optional field
`ThreadMillParams.geometrySource: 'cylinder' | 'loop'` (`src/lib/cam/types.ts`; no
migration) records WHICH entry path produced the params and drives an ADAPTIVE UI —
the cohesion is ONE control set with two unambiguous entry points:

- `'cylinder'` (a 3D cylindrical face) = INFERRED: a green "Auto from selected
  cylinder face" badge; the detected kind is read-only with an editable override
  tucked under Advanced (it knows).
- `'loop'` (a bare 2D circle / flat sketch loop) = MANUAL: the software cannot infer
  intent, so an amber badge and a PROMINENT, required kind select; the user declares
  internal vs external (and direction + size).

Either way the SAME params (`threadKind`, `externalReference`, `majorDiameter`,
`pitch`, `threadDepth`) are simply auto-filled or user-set, and ALL fields stay
editable. THE HELIX BUILDER IS UNCHANGED — this is selection + presentation only.

### A6.4 Heights relabel/prune, source-adaptive (commit d464f99)

For `thread_mill` ONLY the Heights tab is locked to `geometry_face` (the reference
plane is a datum LINE — the picked cylinder's top rim — so the generic 5-option
height-mode dropdown is dropped for thread); the "Top/Bottom of cut" framing and the
`selected_face` info box are dropped; the depth field uses band language ("Thread
depth"); and the `externalReference` toggle is now adaptive by source — demoted to an
Advanced `<details>` for the inferred `'cylinder'` path and prominent for the manual
`'loop'` path. The unifying model: for BOTH a bore and a boss the thread starts at the
cylinder TOP and runs DOWN by the depth (`externalReference: 'top'` default); base-up
is the rare Advanced override, and tool motion still climbs bottom-to-top. This is
PRESENTATION ONLY — the store height-resolution contract is unchanged, and every
change is gated behind `isThreadMill` so non-thread ops are byte-identical (guarded by
a test).

HONEST GAP: boss-kind classification has NO automated fixture (the only tracked
B-rep boss is a cone), so the bore-vs-boss tagging and the inferred-kind correctness
are a LIVE VISUAL GATE against `Sample Parts/Thread Milling Test - 3 holes 3
bosses.step`, not a CI-covered result.

## Amendment 7 (2026-06-27): climb/conventional is FUNCTIONAL (derived travel + descending traversal)

The seventh round makes `cutDirection` actually change the toolpath. This
SUPERSEDES section 5's v1 simplification ("orbit sense is hand-locked; `cut` is
validated but unused; climb/conventional is a consequence, not selectable"). The
fail-loud contract (sec 6) is unchanged; the height-resolution contract
(Amendments 4-5) is unchanged; `externalReference` stays band-placement ONLY,
orthogonal to traversal.

### A7.1 The chip-load model (the physics)

Climb vs conventional is set by the ORBIT SENSE relative to the spindle, exactly
like 2D contouring -- it depends on inside/outside geometry + spindle + cut, and
NOT on the thread hand. The thread HAND then forces whether that orbit sense
corresponds to ASCENDING (bottom-to-top) or DESCENDING (top-to-bottom) travel
along the one fixed groove. So `cutDirection` is the real knob; travel direction
and orbit sense are derived consequences. With signs climb=+1/conventional=-1
(c), internal=+1/external=-1 (e), M3/CW-from-top=+1 (p), right=+1/left=-1 (h):

  orbitSense  s = c * e * p          (+1 = CCW looking down -Z; note: hand-independent)
  travelUp      = (s * h) > 0        (true = ascend bottom->top)

Truth table for an M3 (right-hand-cut) tool: internal+climb -> CCW, ascend (==
the prior default, byte-identical); internal+conventional -> CW, descend;
external+climb -> CW, descend; external+conventional -> CCW, ascend (== the prior
external behavior). The radial infeed schedule is geometry-driven (hole
inside-out, boss outside-in) and is INDEPENDENT of cutDirection -- only the axial
travel + orbit sense flip.

### A7.2 Spindle is a TOOL-HARDWARE property, not an op knob

The spindle/flute rotation (M3 vs M4) is a property of the tool's cutting flutes
(a hardware fact), not an operation choice -- an op may not dictate where the
flutes are. v1 fixes the standard right-hand cutter = M3 (p = +1) via the pure
helper `spindleSignForTool(tool)` in `threadmill2d.ts`, which is the seam where a
future tool-level left-hand-cut flag returns -1. It is deliberately NOT wired to
`MachineConfig.spindleDirection` (a global machine setting, the wrong home for a
per-tool fact).

### A7.3 Pure core + builder changes

`threadOrbitDirection(kind, hand, cut)` is REPLACED by two pure functions in
`threadHelix.ts`: `threadOrbitSense(kind, cut, spindleSign)` (returns `c*e*p`)
and `threadTravelUp(orbitSense, hand)`. `generateThreadHelix` gains an optional
`descend?: boolean` (default false, byte-identical): when true it traverses the
SAME XY orbit (`dir`) top-to-bottom, first point at `topZ`, last clamped to
`bottomZ`, Z strictly decreasing. The builder (`buildThreadMillToolpath`) now has
FOUR explicit per-pass branches (internal/external x ascend/descend); the two
ASCENDING branches are byte-identical to the prior code (so internal+climb, the
default, is unchanged). Descending mirrors the ascending sequence: internal
enters from the top (optional air entry-climb feedZ->topZ), threads down, and
retracts up the open hole center; external plunges in air beside the boss to
`topZ`, threads down, and leads out at the base. NOTE: with climb the DEFAULT,
the external/boss path now DESCENDS (top-down) -- a visible change from the prior
ascending external (which is now the conventional case).

### A7.4 Direction correctness remains a VISUAL GATE

The achieved climb-correctness against the real M3 spindle is the user's sim
gate, not an autonomously-claimed result (per sec 5's single-knob design). A
real-builder-output stage covering all four cases (hole/boss x climb/conventional,
top + profile views with travel arrows) is at
`docs/planning/thread-direction-stage.html`. If the sim shows any case reversed,
the correction is a one-line flip in `threadOrbitSense`.

## Amendment 8 (2026-06-27): internal lead-out cusp fix (mirror of 961b202)

The internal arc lead-out reversed direction at the helix-end junction -- a
~172deg cusp (the internal analog of the external lead-out cusp fixed in
961b202). The cause: `generateLeadArc` for `'lead_out'` reverses point order, and
with the real orbit `dir` on the real hole-center construction the returned arc
traverses the WRONG half-circle, leaving the helix end E in the -orbit direction.
The fix flips `dir` for the internal real-center lead-out (the same flip idiom the
external lead-IN already uses), so the exit takes the tangent-continuous opposite
half-circle back to the hole center. Applied to BOTH internal branches (ascending
exit-climb lead-out and the Amendment-7 descending lead-out). Measured junction
angle: 172deg -> 10deg (climb), 173deg -> 13deg (conventional). Guarded by a
regression test asserting the junction angle stays well below a reversal
(`< 45deg`); before/after stage at `docs/planning/thread-leadout-cusp-stage.html`.
External lead-outs are unchanged (they use the virtual-outside-center construction
with real `dir`, already cusp-free since 961b202).

## Amendment 9 (2026-06-27): external thread cuts to the ROOT, not the crest

A correctness fix. Amendment 3's external "mechanical mirror" set
`R_final = majorDiameter/2 + toolR`, which places the tool's inner cutting edge at
the thread CREST (the boss OD) -- so the cutter grazed the boss surface and never
cut the groove down to the thread root. No real thread was formed; the voxel sim
(constant crest-OD carve) could not reveal it. Measured: M10x1.5 / 6mm landed the
edge at 5.00mm (crest) vs a 4.08mm root target -- a full thread-depth short.

Fix: external `R_final = majorDiameter/2 + toolR - extSpan`, where
`extSpan = 0.6*pitch` (the 60deg thread-depth approximation, the SAME value the
external radial-infeed `span` already used). The `holeSchedules` external branch
was already `R_start = R_final + span` stepping inward, so with the corrected
R_final the passes now run from the crest inward to the root -- no schedule change.

Entry safety: deep passes now orbit at radii whose tool body is inside the SOLID
boss, so a vertical plunge at the pass radius would gouge. The ARC entry already
plunges at `O_v = center + 2R*u` (well outside the boss) and its lead-in arc stays
at radius >= R, so it is unaffected. The STRAIGHT (`leadInOut: 'none'`) external
entry was changed to plunge at the safe crest orbit radius
(`majorDiameter/2 + toolR`, the tool grazing the boss OD in air) and then feed
radially in to the pass radius before the helix. Internal is unchanged.

Because there is no thread-form sim, the gates are GEOMETRIC, not visual:
regression tests assert the deepest pass reaches the root (not the crest) and that
NO plunge move's tool body enters the boss envelope (both lead modes x both cut
directions). A separate test ties the thread orbit sense to ADR-0002/the universal
`cross(heading, materialNormal) < 0 = climb` convention (ARCHITECTURE.md) so the
codebase agrees with itself on climb. `extSpan = 0.6*pitch` remains a v1
approximation -- deriving the real external span from a measured root/minor
diameter is still future work.

## Amendment 10 (2026-10-23, WO-3080): the ascending internal thread ends at the hole top

Retires A2.1's exit climb. The internal ascending (bottom-up) thread helix now ends
at `topZ`, the thread top: the lead-out (arc or straight, unchanged logic) runs at
`topZ` back to the open hole centre, and the tool then rapids straight up the open
centre to clearance - the same exit the internal descending branch already used.

Reason: owner release review 2026-10-23 on example 01 (Fixture Plate, Thread Mill 3):
"you are helixing up far beyond the part up. The end height seems excessive." The
exit climb orbited from the thread top to the feed plane in air - 5 air turns per
hole at the default 5 mm feed height (12.5 helix turns per hole for a 7.5-turn
thread). The open, pre-drilled hole centre is a clear path up, so threading back
out of the hole bought nothing.

Unchanged: the internal descending branch (its in-air entry orbit from the feed
plane to the thread top is a separate question), both external branches (they
never had an exit climb), `threadHelix.ts`, and the kernel parity copies.
Builder tests assert the helix ends at the thread top and the lead-out is there;
`src/tests/cam/threadMillStartHeight.wo3080.test.ts` asserts it through the
production route on example 01.

## Amendment 11 (2026-10-23, WO-3083): every pass enters at material + 1 and hops at Retract

Every branch comes down to 1 mm above the material under the tool (ADR-0002
Amendment 1, `src/lib/cam/moves`) instead of to the feed plane, then plunges as
before. The internal descending branch no longer orbits down in air from the
feed plane to the thread top: it plunges to `topZ`, leads in there and starts the
thread there (the former DEGENERATE branch is now the only one). Passes leave
straight up to Retract and the next pass hops there; the first pass comes down
through Clearance and the operation's final exit rises to it.

Reason: the owner's 2026-10-23 release review (see ADR-0002 Amendment 1); this
answers the "separate question" Amendment 10 left open.

## Amendment 12 (2026-10-27, WO-3193): the operator chooses Bottom-up or Top-down

The owner's alpha.3.2 plan (THREAD-DIR, 2026-10-27): the axial direction is now an
explicit choice, `ThreadMillParams.axialDirection: 'bottom-up' | 'top-down'`,
in the New Operation editor (Passes > Advanced, replacing the climb/conventional
toggle) and in Properties. With a direction chosen, every pass (roughing and
spring) follows it and the orbit sense is the one that follows the hand's groove
that way: s = h ascending, -h descending (the inverse of `threadTravelUp`).
Climb or conventional is what results, c = s * e * p (the inverse of
`threadOrbitSense`), and is shown under the choice, not asked. With no choice
made (every op saved before WO-3193) the direction is derived from
`cutDirection` exactly as in sec 5 / Amendment 7, so no saved toolpath changes;
both surfaces show that derived direction as the active one.
`resolveThreadMotion` in `threadHelix.ts` is the one resolver for the builder
and both screens. With a right-hand cutter (M3): internal RH and external LH cut
climb bottom-up and conventional top-down; internal LH and external RH cut
climb top-down and conventional bottom-up. A left-hand cutter swaps each.

## References

- ADR 0001 — toolpath/postprocessor separation (output stays full-precision; the
  dense helix is real geometry, the post may later arcfit it)
- ADR 0002 — canonical Z vocabulary (thread mill uses the five planes; `topZ` =
  thread top, `bottomZ` = thread bottom; no new height names)
- ADR 0003 — no silent fallbacks (the `'Thread mill:'`-prefixed fail-loud guards;
  deferred members fail loud)
- ADR 0004 — two-tier feedrate resolver (lead-in / lead-out / plunge / cut feeds
  by role)
- ADR 0015 — 2D Facing operation (the deferred-members-fail-loud precedent and
  full-configuration-surface-from-day-one pattern)
- ADR 0030 — tool geometry as a single tip-up revolved profile (Amendment 1 adds
  the `'thread'` `profileKind` + `buildThread()`; the teeth extend this model)
- `src/lib/tool/toolProfile.ts` — `buildThread()` (Amendment 1 thread-teeth +
  relieved-neck profile; the single source for the 2D diagram + 3D lathe)
- `src/store/index.ts` — chamfer-style thread-depth resolution (Amendment 1:
  bottom = top - `threadDepth`)
- `src/tests/store/dispatchHeights.test.ts` — Amendment 1 smart-depth tests
- `src/lib/cam/threadHelix.ts` — the pure helix + lead-arc core (Amendment 7:
  `threadOrbitSense` + `threadTravelUp` replace `threadOrbitDirection`;
  `generateThreadHelix` gains `descend`)
- `src/lib/cam/threadmill2d.ts` — the op builder (`buildThreadMillToolpath`;
  Amendment 3: real per-hole internal span + external mechanical-mirror branch;
  Amendment 7: `spindleSignForTool` seam + four directional branches)
- `src/lib/cam/threadPresets.ts` — Amendment 3 thread-size preset table
  (`THREAD_PRESETS` / `findThreadPreset`); Amendment 6 standards table
  (`THREAD_STANDARDS`) + nearest-snap helpers (`findThreadByMajor` /
  `findThreadByBore`)
- `src/lib/cam/geometry/occt/model/derive.ts` — Amendment 6 `cylinderFeatures()`
  (bores + bosses, shared `collectVerticalCylinders` core; `holeFeatures` is the
  byte-identical bore subset)
- `src/types/index.ts` — Amendment 6 `CylinderFeature` type (`kind: 'bore' |
  'boss'` + center/diameter/top/bottom Z)
- `src/lib/cam/geometry/occt/model/{modelWorker,modelClient}.ts` — Amendment 6
  `DERIVE_CYLINDERS` worker route / `deriveCylinders`
- `src/store/index.ts` — Amendment 6 `deriveBrepLayer` `'cylinder'` kind (top-rim
  circle loop at `topZ`; fails loud on a non-vertical / non-cylinder pick)
- `src/lib/cam/types.ts` — Amendment 6 `ThreadMillParams.geometrySource`
  (`'cylinder' | 'loop'`; drives the adaptive auto-vs-manual UI)
- `src/lib/cam/toolpathWorker.ts` — the `COMPUTE_THREAD_MILL` worker route
- `src/store/index.ts` — the explicit store dispatch (replaces the silent
  `COMPUTE_CONTOUR` fall-through)
- `src/tests/cam/threadmill2d.test.ts` — builder emission + fail-loud tests
- `src/tests/cam/threadMillStartHeight.wo3080.test.ts` — Amendment 10 production-route proof (example 01)
- `src/tests/cam/threadMillDirection.wo3193.test.ts` — Amendment 12 direction choice: hand oracle for every kind x hand x direction x cutter
