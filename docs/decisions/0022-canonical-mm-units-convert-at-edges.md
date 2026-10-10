# 0022 — Canonical millimeters; convert units only at the two edges

Date: 2026-06-15
Status: Accepted

## Context

LienCAM stores every dimensioned quantity in millimeters. Geometry, heights,
tool dimensions, stock, feeds, and machine travel are all mm, with `// mm`
annotations on roughly 200 fields in `src/types/index.ts`. There is no unit
abstraction anywhere in the internal model, and there is no central number
formatter — the literal string `"mm"` is hardcoded at ~80-100 display sites
across the UI, and the postprocessor always emits millimeter G-code (it never
emits G20/G21 and never converts coordinate values).

the operator works in a mixed metric/imperial shop and asked for a global units
preference that flows through the WHOLE app as TWO INDEPENDENT choices:

- how the USER works (UI display and input), and
- how the PROGRAM exports (the g-code: G20/G21 plus value conversion).

The two are independent because a user may prefer to design in inches but post
millimeter g-code for a metric controller, or vice versa. All four combinations
(work mm/export mm, work mm/export inch, work inch/export mm, work inch/export
inch) must work and be tested. The work-mm/export-mm path is today's behavior
and must stay byte-identical.

The temptation is to thread a unit through the internal model. That would touch
~200 fields and every algorithm, and risk regressions across cam, geometry,
heights, and feedrates for zero functional benefit — the numbers are the same
mm values regardless of how they are shown or exported.

## Decision

**Canonical internal unit is millimeters. Nothing in the store, types, or any
cam/geometry/heights/feedrates math changes.** Unit conversion happens at
exactly two boundaries.

1. **Two app-global preferences in `AppSettings`** (`src/types/index.ts`):
   - `displayUnits: 'mm' | 'inch'` — the unit shown and entered in the UI.
   - `exportUnits: 'mm' | 'inch'` — the unit of the exported g-code.
   Both default to `'mm'`, both persist via the existing Zustand persist
   middleware (the partialize list already includes `appSettings`), each has a
   store setter following the existing `invertZoom`/`navPreset` pattern. Units
   are APP-GLOBAL, not per-project: they never round-trip through the
   `.camproject` file, so loading an old project shows its stored mm values in
   whatever unit is currently set. There is no project-file migration.

2. **UI boundary — `src/lib/ui/unitFormat.ts` (new).** A single shim every
   display/input site routes through:
   - `fmtDim(valueMm, units)` -> display string with per-unit decimals.
   - `parseDimToMm(input, units)` -> stored mm value (inch input x 25.4).
   - `unitLabel(units)` -> `"mm"` or `"in"`.
   - `fmtFeed`/`parseFeedToMmMin` for feeds (IPM <-> mm/min via /25.4 x25.4).
   Every dimensioned input converts to mm BEFORE it touches the store; every
   display reads the mm value and formats it. Convert exactly once, at the edge.

3. **Export boundary — `emit.ts` / `coords.ts` / dialect format blocks.** The
   post reads `exportUnits`, emits `G20` (inch) or `G21` (mm) in the program
   frame, converts every coordinate, `I`/`J`, `R`, `Q`, and the `F` feed word
   (mm/min -> IPM), and widens decimals for inch. This is the slice formerly
   tracked as DEF-2; it is now driven by `exportUnits`. Conversion lives at the
   single formatting helper each quantity already flows through (the `word()` /
   number formatter, the F-word, the arc word emitter) so linear, arc, canned,
   and combined-program paths all inherit it — NOT scattered per call site.

4. **Per-unit decimals table**, one source of truth reused by both edges:
   mm -> xyz 3 / feed 1; inch -> xyz 4 / feed 1.

5. **Spindle speed (RPM) is unit-invariant** in every combination — never
   converted at either edge.

6. **Viewport grid is display-only:** grid spacing is 25 mm in mm mode, 25.4 mm
   (a 1-inch grid) in inch mode. No geometry changes.

7. **Tolerances** (`arcTolerance`, STL projection tolerance) are stored mm; only
   their UI display/input convert. The algorithms keep mm.

`1 inch = 25.4 mm` exactly. Rounding happens only at the formatting boundary,
never in stored values.

## Alternatives considered

- **Thread a unit through the internal model.** Rejected: ~200 fields and every
  algorithm would carry a unit, for no functional gain (the stored number is the
  same mm value). High regression surface across cam/geometry/heights/feedrates.

- **Per-project units (store in the `.camproject` file).** Rejected: the operator works
  in a chosen unit for a whole session across projects, not per file. App-global
  also avoids a project-file migration and keeps units out of the serialized
  `Project`.

- **A single `units` preference governing both display and export.** Rejected:
  the two are genuinely independent (design in inch, post mm, or vice versa).
  Two preferences give the full 2x2 matrix the operator asked for.

- **Convert inside each component / each emit call site.** Rejected: ~80-100 UI
  sites and several emit paths would each need correct, consistent conversion —
  fragile and prone to double-conversion. A single shim per edge is the
  enforceable seam.

## Consequences

Positive:
- The internal model stays mm-only and untouched; algorithm regressions are
  off the table by construction.
- Two enforceable seams (the UI shim, the post formatter) localize all unit
  logic and all future unit work.
- work-mm/export-mm is provably unchanged: when both prefs are `'mm'` the shim
  is identity and the post takes its existing path, guarded by a byte-identity
  regression test against today's samples.

Negative / watch-items:
- Every new dimensioned display/input site must route through the shim or it
  will show stale `"mm"`. The shim is the convention; reviews must enforce it.
- Inch decimals (xyz 4) must be wide enough for the controller; validated by the
  g-code lint and an operator-loaded sample. Double-conversion is the classic bug -
  convert once, at the edge.
- G20/G21 are standard G-codes; confirm `gcode/lint.ts` KNOWN_LETTERS already
  covers them (no new address letter is introduced).

## References

- `docs/planning/UNITS-FULLSTACK-HANDOFF.md` — full recon map, phasing, gates.
- `src/types/index.ts` AppSettings (~L461-474); `src/store/index.ts` setters /
  persist; `src/lib/ui/unitFormat.ts` (new); `src/lib/post/emit.ts`,
  `coords.ts`, dialect format blocks; `src/components/viewport/CNCViewport.ts`.
- ADR-0001 (toolpath/postprocessor separation — the export boundary is the post,
  not the operations), ADR-0002 (canonical Z vocabulary — heights are
  dimensioned and route through the same shim), ADR-0021 (postprocessor
  architecture). Supersedes the post-only DEF-2 item in
  `docs/planning/POSTPROCESSOR-DESIGN.md` S11.
