# 0029 — Tool angle stored as angle-from-axis (half-angle), converted at the UI/import edge

Date: 2026-06-22
Status: Accepted

## Context

Angled cutting tools (V-bits, chamfer mills, tapered endmills, drills, spot/center
drills, countersinks) carry one angle. The machining industry states it two
incompatible ways, and which one is used depends on the tool family — the classic
trap is that a "90 deg V-bit" and a "45 deg chamfer" are the SAME geometry:

- **Included angle** — full apex-to-apex (a 90 V-bit = 90; a 118 drill = 118).
- **Angle from axis (half-angle, per side)** — centerline to one cutting edge
  (that same 90 V-bit = 45; a 5 deg tapered endmill = 5).

`included = 2 x angleFromAxis`.

The codebase carried BOTH conventions on a single `Tool.tipAngle` field, used
inconsistently: cut math (engrave/chamfer) read it as the half-angle, while the
3D cone render / voxel sim / tool diagram read it as the full included angle. The
v0.4.2 fix (`cd846fd`) tried to unify everyone on "full included" and halved it
everywhere — but the actual stored data was overwhelmingly the from-axis value
(timeline-based CAD/CAM system stores chamfer/taper angles per-side; real libraries showed 22.5, 41, 45,
all < 90). So v0.4.2 over-pointed every real tool: a 2 mm engrave with a 45-deg
chamfer cut ~2.4 mm deep instead of 1.0 mm. the operator (the machinist) authored the
ground-truth spec `docs/tool_angle_conventions.md` to settle it.

## Decision

**Store one canonical field `Tool.angleFromAxisDeg`** — the half-angle measured
from the tool axis. It is geometrically the cone slope every toolpath/engagement
calculation wants directly, so NO consumer halves it. `docs/tool_angle_conventions.md`
is the ground-truth spec; this ADR records the decision and its consequences.

- **Math/render unification.** `toolHalfAngleRad()` in `cam/geometry` only
  deg->rad converts (no `/2`); all nine angle consumers (engrave depth, chamfer
  XY offset, voxel carve, sim profile, tool diagram, 3D cone, two modal previews)
  route through the from-axis value. Universal fallback default is **59** (the
  from-axis half of a 118 included drill point).
- **Convert at the UI edge.** The Tool Library enters POINTED tools (v_bit,
  chamfer_mill, countersink, center_drill, drill, spot_drill, dovetail_mill) by
  their **included** angle (stored /2) with a live "(= X per side)" echo; the
  **tapered_endmill** is entered by its **per-side** taper angle (stored as-is).
  A help popup states the rule. This kills the 90->45 confusion at the source.
- **Convert at the timeline-based CAD/CAM system-import edge.** Drill/spot/center/countersink/v-bit read
  a timeline-based CAD/CAM system's full included point angle from `geometry.SIG` (TA fallback) and halve;
  chamfer mill and tapered mill read the from-axis angle from `geometry.TA` as-is.
  `'chamfer mill'` now maps to `chamfer_mill` (was `v_bit`); tapered/countersink/
  center-drill gain mappings.
- **Migration (schema v1 -> v2, ADR-0027 chain).** Existing `tipAngle` is mixed:
  from-axis values are physically < 90, old included defaults are >= 90, so
  `angleFromAxisDeg = tipAngle >= 90 ? tipAngle/2 : tipAngle`, then drop `tipAngle`.
  Pure + idempotent; current files are byte-identical no-ops. Applied on both the
  project-load chain and the persisted-localStorage tool-library rehydrate.

This supersedes `cd846fd` (v0.4.2), which assumed the stored value was full
included.

## Alternatives considered

- **Keep `tipAngle` as the full included angle (the v0.4.2 direction).** Rejected:
  it contradicts the real stored data (from-axis) and a timeline-based CAD/CAM system's per-side taper
  storage, and forces a `/2` at every geometry consumer (the bug surface).
- **Per-tool-type canonical (chamfer = per-side, v-bit = included).** Rejected:
  the same physical 90-included tool would store two different numbers depending
  on its type label — fragile, re-introduces the ambiguity internally. Per-type
  handling belongs at the UI/import EDGE only, over one canonical store.
- **No migration; have the user re-enter tools.** Rejected: the conversion is
  deterministic from the stored magnitude; making the user re-key it is needless.

## Consequences

Positive:
- One unambiguous internal value; geometry math has no scattered `/2`.
- the operator's chamfer bit (stored 45) loads as 45 from-axis = a real 45-deg chamfer and
  cuts a 2 mm engrave at the correct 1.0 mm depth — no re-entry.
- timeline-based CAD/CAM system libraries import with correct angles across tool families.

Negative / watch-items:
- The migration's `>= 90` disambiguation is correct for all observed data
  (from-axis tools are < 90; included defaults are 118). A hypothetical legacy
  tool stored as an included angle BELOW 90 (e.g. a 60 V-bit hand-keyed as "60")
  would be kept as 60 from-axis rather than 30 — no such data exists in practice,
  but new included input now flows through the converting UI/import edge, so only
  pre-v2 files are subject to the heuristic.
- New angled tool types (chamfer_mill, tapered_endmill, countersink, center_drill,
  dovetail_mill, plus reamer/slitting_saw/lollipop_mill) reuse existing tool
  visuals; bespoke profiles are deferred.

## References

- `docs/tool_angle_conventions.md` — the ground-truth spec (UI/import conversion
  table, timeline-based CAD/CAM system mapping, validation rules).
- `src/lib/cam/geometry/index.ts` `toolHalfAngleRad`; `src/types/index.ts`
  `Tool.angleFromAxisDeg` + the extended `ToolType`; `src/components/modals/
  ToolLibraryModal.tsx` (per-type input + echo + help); `src/lib/fusionImporter.ts`
  `fusionAngleFromAxis`; `src/store/migrations/projectMigrations.ts` (v1->v2).
- ADR-0027 (migration chain), ADR-0002 (canonical Z vocabulary — the sibling
  "one canonical representation" discipline), supersedes `cd846fd` (v0.4.2).
