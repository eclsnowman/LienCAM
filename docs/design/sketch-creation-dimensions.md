# WO-3116: creation-time dimensions implementation plan

Research only, 2026-10-24. No product, test, fixture or configuration changes.

## Authority and source identity

Owner's words, 2026-10-24 2:42 PM Central, request
`answer-1792870946962-e3uhf1ndbui`, on card
`Q-WO-3110-DIMENSION-TYPING-LAND-IT-1792863583954`:
"But make sure to look into adding the fast dimensioning while creating the sketch feature like solidcraft does for things like rectangles, circles and other geometry where it would be obvious what values need to get entered to define it."

The owner authorized this investigation. The interaction choices and phases below
are worker recommendations for steward review and bounded dispatch, not additional
owner decisions. Solidcraft was not independently inspected or measured.

Inspected checkout: `14f4678fd7c8e2cbaa5abfd1f298cdbc3c5cc8d7`.
Dispatch comparison baseline: `77979d8dc5b3237b8a4fabf830ec0098cd83f103`.
Approved WO-3110 final product source inspected through `git show`:
`376c7aad99d1b38236ed8c00ccf519d0c2ae599d`; its evidence is available at
commit `9015a35366`. It is absent from this checkout's product files, so do not
mistake the checkout's older Smart Dimension route for the final integration target.
Do not delay or redesign WO-3110. Its source and reviewed results must be retained
when implementation is dispatched after landing.

## Finding and recommendation

Creation-time numeric entry already exists for anchored lines (length) and
center circles (radius). `SketchDrawValueInput` captures numeric typing through
`useTypeToSet`; Enter or blur commits exact geometry plus a driving dimension in
one undo step. Circle entry is R, not diameter. Its visible input currently shows
only a number and unit, with no R caption or creation hint. Typing protects the
input from animation-frame replacement, but the canvas preview continues to use
the pointer rather than the typed draft. These are source findings, not a fresh
browser measurement of discoverability or a reproduced defect.

Rectangles have live width/height readouts, but these are display-only. Both the
numeric overlay's support predicate and `drawValueScalar` exclude rectangles;
`commitDrawValue` has no rectangle case. Thus this is a real missing entry route,
not a request to build another dimension solver.

Implement axis-aligned corner and center rectangles using the existing cursor-side
input chrome, capture helper, rectangle builder and document append ports. Keep
center-circle radius semantics and make R entry explicit in a following small
phase. Do not add a modal, wizard, new mandatory click, warning or prerequisite.
The existing mouse-only construction remains available throughout.

## Proposed interaction contract

| Situation | Recommended behavior |
| --- | --- |
| Rectangle tool armed, no anchor | Existing first-corner/center pick. No numeric capture yet; Tab retains its existing angled-mode toggle. |
| Anchor picked, axis-aligned rectangle | Show compact `W` and `H` inputs with units near the cursor, with accessible Width/Height labels. Values mean FULL side lengths in both rectangle modes. Neither field takes focus automatically. |
| Start typing `50` | Capture to W, replacing its live value, before digit tool shortcuts. Show that W is typed/held; H still follows the pointer. Clicking H directly also works. |
| `50 Tab 30 Enter` | Tab accepts W into the transient draft, focuses/selects H, and does not append geometry. Typing sets H. Enter commits one 50 x 30 rectangle, its construction geometry/constraints and two driving side dimensions. |
| Tab / Shift+Tab within the pair | Cycle W/H forward/back; skip no field and never toggle angled mode. Switching focus inside the pair must not trigger commit-on-blur. Enter from either field applies the whole current draft. |
| Only W entered, then Enter | Commit W plus the current valid pointer-derived H. Add a driving W dimension only. H was not typed merely because it was displayed or Tab-focused. H-only entry is symmetric. |
| Canvas placement click while typing | Apply entered sizes; pointer chooses quadrant and any untyped extent. One placement gesture commits once and is consumed; its release must not place the next shape's anchor. |
| Ordinary focus loss outside pair/canvas | Valid dirty draft commits once, matching the existing draw-value blur convention. Merely focusing an unchanged field does not add dimensions. Invalid draft never falls back to a different size. |
| No typing | Existing two-click rectangle behavior and snap/Shift constraints; no driving size dimension added by this feature. |
| Circle center picked | Caption existing scalar `R`, show units and a short type/Enter hint; type `10 Enter` gives radius 10, diameter 20, one driving radius dimension. Do not silently reinterpret existing input as diameter. |
| After commit | Tool stays armed, chain and transient size state clear, next shape has no inherited locks or focus; no second dimension editor opens. |

Enter applies; Tab chooses the other rectangle value. Do not make Enter require
both sizes or a second confirmation. A nonzero live H is enough for W-only entry.
Before numeric entry, Enter retains the tool machine's existing finish/cancel-chain
semantics. Angled rectangles retain the existing three-click flow in the first
release; no W/H numeric controls are offered there. Plain Tab outside the pair
retains angled-mode switching. Toggling the existing Axis/Angled control ends any
numeric draft without committing it and uses the existing mode transition.

For canvas placement, mark the current gesture in the shared interaction BEFORE
its explicit input blur. That blur defers append to the matching pointerup;
pointerup resolves the actual click with held sizes and invokes the normal single
gesture commit. Field-to-field blur only changes focus. External non-canvas blur
uses the keyboard/blur commit route. Pointercancel, lost capture and drag-abort
clear the gesture marker without committing or discarding valid held sizes; the
next placement can use them. Keep this in the existing interaction owner, not a
new window pointer listener. Tests must prove the callback order, one history
step and no extra anchor. This is proposed wiring, not a reproduced current bug.

### Geometry, pointer precedence and preview

All values are positive sizes. Pointer supplies signs, location and any untyped
component; entered W/H override the corresponding snapped coordinate. For a corner
anchor A, resolve B = A + (sx * W, sy * H). For a center C, resolve the cursor
corner B = C + (sx * W/2, sy * H/2), then use `rectCorners` for the opposite corner.
Use the live pointer quadrant, retain the last nonzero sign on each axis when the
pointer is exactly on that axis, and default an as-yet-unknown sign to positive.
Do not require pointer travel to type both valid sizes at an anchor.

Use one pure resolution function for the rubber band, live labels and commit.
Publish valid numeric draft updates into package-owned transient tool state and
refresh the existing preview subscription immediately, including without pointer
movement. DOM input text alone must not become a second geometry authority.
A typed field must not be replaced by the next rAF; untyped values continue to
track. Mark held fields visibly and accessibly; no new decorative status panel.
Existing outside-edge labels must use the same resolved geometry, without a second
contradictory W/H pair while the editor is present. Circle's typed-radius preview
must also agree with its eventual commit in its follow-up phase.

Keep anchor snap inferences when they still match the final geometry. A snap on
the raw opposite corner must not add a coincident/point-on-object relation to a
corner moved by typed sizes. Filter against actual resolved geometry through the
existing inference mechanism; never resnap the typed endpoint and change W/H.
Normal clicks currently drain pending inferences; `commitDrawValueAt` currently
appends with an empty inference list. Reusing only the latter for rectangles would
lose anchor relationships and leave pending snaps for later shapes. Explicitly
resolve/drain or discard each pending snap on success/cancel; test the next shape.
Do not turn this into a general repair of existing line/circle inference behavior.

Shift still affects the pointer's free coordinates/direction through existing
ortho-lock. Explicit numeric values take precedence over Shift's size effect.
For a resolved square with Shift and zero or one typed size, keep the existing
equal-leg constraint and at most one independent driving side dimension. With two
typed sizes, use their two driving dimensions and no extra equal constraint; with
unequal resolved sides do not emit an equal constraint that contradicts them.
No-typing Shift-square behavior is untouched. Ctrl/Alt/Meta numeric chords stay
with their existing owners; Shift+Tab reverses field traversal, not geometry mode.

### Units and draft validity

Reuse `toDisplay`, `parseDimToMm`, `unitLabel` at the UI boundary; store geometry and
driving values in mm. CAM accepts its selected mm/inch display mode. Part currently
exposes mm from its overlay port; this work must not promise or implement a new
Part unit preference. W/H are full extents even in center mode, avoiding a hidden
factor-of-two difference from corner rectangles.

The parser strips a trailing unit token, then interprets the number in ACTIVE
display units; a suffix is not a cross-unit override. Preserve that contract and
do not advertise mixed-unit conversion or equations for creation entry. Existing
post-creation `DimValueInput` equations remain separate.

Keep raw text while editing: empty, `-`, `.`, zero, negative, malformed, NaN and
infinite values do not become geometry or silently revert to the previous value.
Enter/Tab on an invalid edited field leaves that field editable, without a modal
or new warning. A click must not substitute the pointer size for an invalid typed
size. Escape always releases the draft. Untyped zero extent may continue rubber
banding until the pointer gives a nondegenerate shape; two typed positive sizes
can commit even at the anchor and below mouse-pick tolerance. Use mathematical
nondegeneracy for explicit values, not a zoom-dependent minimum or arbitrary clamp.

Latch display units for the duration of one edit group. If display units change
mid-draft, discard the transient draft and return to the current pointer preview
in the new units; never reinterpret raw `1` inches as `1` mm. Do not commit on that
programmatic reset. This is an implementation recommendation, not measured current
multi-field behavior.

### Commit, cancellation, history and persistence

- Input edits and Tab transitions change only transient state. Enter, successful
  external blur, or a placement click append geometry, auto constraints, valid
  inferences and entered driving dimensions together as ONE undo step.
- Reuse `buildRectCommit` through the tool path, retaining all four sides plus
  its construction center/diagonal and their constraints. Attach unsigned
  `distance` dimensions to side 0 and side 1 for typed W/H. H/V already supplies
  orientation, and unsigned distances avoid signed distanceX/Y mistakes in the
  up-left quadrants. Persist no dimensions for untouched sizes.
- Preserve normal pointer undo ownership (`beforeMutate`/gesture latch) and
  keyboard/blur ownership (`doc.beginStep`). Only one may open the final step.
  Do not append on Tab and then append again on Enter or blur.
- Escape inside a creation field discards the WHOLE numeric draft, prevents blur
  commit, restores free pointer preview and keeps the anchor. Next Escape outside
  the field cancels the chain; the following Escape returns to Select. This
  extends the existing scalar input cancellation contract to the pair.
- Tool change, rotated-mode transition, document change, true sketch exit and
  undo/redo invalidate the numeric draft without committing it. A retained mount
  suspension must release capture/focus; it must not type into the hidden host.
  Re-entry may retain an existing same-document chain according to the package's
  lifecycle contract, but must not resurrect a numeric lock from another session.
- Undo removes the whole created shape and its driving dimensions; redo restores
  the same IDs, size values and constraints. No empty undo step for typing, invalid
  entry, Tab or Escape. Do not change history semantics outside this draft.
- Committed entities/dimensions use existing Sketch/ToolCommit data. Finish/Save/
  reopen and Part DAG payload persistence must preserve their geometry and driving
  values. Raw drafts, field focus and pointer-sign caches are never serialized.
  Saving while editing uses the established blur/Finish behavior; do not introduce
  a hidden auto-commit for an invalid or unfinished numeric draft.

## Implementation seams and order

Use shared `src/lib/sketch/sketcher` behavior for CAM and Part. Do not implement a
second keyboard handler in a host, a new solver, or new stored entity types.
`ROUTES.md` records actual consumers and incident comments to recheck before edits.
The steward should grant the named sources and narrowly named tests afresh; this
plan itself authorizes edits only to its two Markdown files and own-order metadata.

1. **Phase A, M: complete axis-aligned rectangle entry.** Extend the existing
   draw-value pure module with W/H resolution/commit, and package tool state with
   a transient creation-entry record keyed to document/anchor/tool, active field,
   raw draft validity and finite mm overrides. Extend `SketchDrawValueInput`
   with the paired controls using `useTypeToSet` (same guard and capture priority).
   Route pointer preview, click, Enter and blur through the shared controller;
   update live-label/prompt consumers and reset boundaries together. Ship both
   corner/center modes with the full contract, not a disconnected helper.
   Candidate product grant: `src/lib/sketch/tools/drawValue.ts`,
   `src/lib/sketch/sketcher/toolStore.ts`, `src/lib/sketch/sketcher/toolController.ts`,
   `src/lib/sketch/sketcher/sketchInteraction.ts`, `src/lib/sketch/sketcher/index.ts`,
   `src/lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx`,
   `src/lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx`,
   `src/lib/sketch/tools/toolSteps.ts`, and the specific English workbench locale
   `src/i18n/locales/en/sketch-and-model-workbench.ts` if captions/hints need keys.
   Reuse existing input styles and rectangle builders; grant `rectTools.ts` or
   styles only if the phase's reviewed design actually needs changes there.
   `useTypeToSet.ts`, solver, host ports and WO-3110 overlay remain read-only.
2. **Phase B, S: clarify existing center-circle entry.** Add an explicit R caption,
   accessible Radius name and short type/Enter hint to the shared draw overlay;
   use Phase A's preview/commit ownership to display the typed radius immediately.
   Keep radius input, driving radius output and optional rim-click drawing.
   Candidate grant: the draw-value module, overlay and any shared controller/
   interaction/state seams actually reused, plus the same locale. Characterize
   current click-away behavior first; a new behavioral fix needs its own intended
   old-fail/new-pass evidence, not an assumed diagnosis. If safely reusing Phase A
   requires a larger rewrite, steward resizes this phase instead of broadening it
   inside the worker. A diameter toggle is deferred, not silently substituted.

Each phase needs its own narrowly named regression files, actual-app Tier 2
captures, build and independent adversarial review. Do not put source-string
assertions in place of event/geometry/solver tests. New test names proposed below
are paths for a future grant, not files created by this order.

### Discriminating verification proposed for Phase A

`src/tests/sketch/creationSizeValue.test.ts`:

- Corner A=(10,20), type 50 x 30 with pointer in each quadrant: four closed cut
  sides, correct 50/30 full extents, center/diagonal relations retained, two
  driving side distances. For center C=(10,20), extents are C +/- (25,15), not
  +/- (50,30). Confirm both modes and construction mode.
- W-only/H-only uses the other live extent and emits one driving dimension;
  no-type control emits none. Preview points and committed vertices match.
- Positive sub-pick-tolerance values and both typed at anchor work; invalid drafts
  produce no commit/IDs/history. Pointer quadrant changes never change held size.
- True anchor snap persists, displaced endpoint snap does not; the next shape has
  no stale pending inference. Test Shift cases described above with real solving,
  including unequal explicit sizes and the preserved mouse-only square control.

`src/tests/sketch/creationSizeEntry.test.tsx`:

- Drive actual window keydown through the mounted overlay and production
  interaction: `50 Tab 30 Enter`; 1/2/3 stay numeric, tool stays rectangle,
  Tab changes field rather than rotated mode, and Enter creates one shape.
- W-only Enter, H clicked directly, reverse Tab, field-to-field blur (no append),
  ordinary external blur, and real canvas pointerdown/up (exactly one append,
  no extra anchor). Include pointercancel/lost capture, double-click finishing
  and a new shape immediately after commit to expose stale/double actions.
- Type while stationary, advance rAF and move pointer: text/held value survive,
  free extent updates, preview matches. Invalid Enter then correction then blur
  commits once; Escape then blur commits zero. Neither consumes a later valid
  blur through a stale skip flag.
- Focused input/textarea/select/contenteditable and Ctrl/Alt/Meta chords retain
  their owners. Before anchor, in angled rectangle mode, Smart Dimension and
  unsupported tools retain normal shortcuts; Tab outside numeric editing still
  toggles rotated mode. Exercise the landed WO-3110 path as a regression control.
- Assert CAM inch `2 Tab 1 Enter` resolves 50.8 x 25.4 mm, plus active-mm entry,
  unit change reset, tool/mode/document switch, undo/redo and retained hidden-host
  capture cleanup. Preserve normal line length and fillet/chamfer Apply behavior.

`src/tests/sketch/creationSizeHosts.test.tsx`:

- Use the existing CAM/Part mount seams (see ROUTES) with the real solver, not an
  echo worker: typed creation retains shape, dimensions, chosen snap and solves
  without conflict. Change a driving side afterward to prove it drives actual
  geometry, and verify an untyped side is not accidentally locked.
- Both hosts: undo/redo one step, same IDs and values; Finish/reopen preserves
  sizes/constraints; CAM Save/open and Part serialized DAG restore preserve them.
  Confirm raw creation drafts are absent. Use an established save seam rather than
  adding an export test API to product code.

Suggested Phase A commands, for steward to declare explicitly:
`npx vitest run src/tests/sketch/creationSizeValue.test.ts src/tests/sketch/creationSizeEntry.test.tsx src/tests/sketch/creationSizeHosts.test.tsx src/tests/sketch/rectTools.test.ts src/tests/sketch/squareRect.solver.test.ts src/tests/sketch/drawValue.test.ts src/tests/sketch/liveDims.test.ts src/tests/sketch/shortcuts.test.ts src/tests/sketch/dimensionTyping.wo3110.test.tsx`
and `npm run build`. The WO-3110 test is only available after its source lands.
If test setup forces another production seam, reconcile the grant before editing.

Phase B should add a narrow `src/tests/sketch/circleCreationEntry.test.tsx` with
real key/blur/click/Escape events and radius-vs-diameter assertions, plus focused
existing `drawValue.test.ts` and `dimensionCommitOnBlur.ui50.test.tsx`; build and
actual-app captures remain required. Do not run a directory-wide suite.

Actual app evidence per implementing phase: use the existing production entry and
capture/provenance harness, show anchor -> typed preview -> final geometry in CAM
and Part, numeric values and active tool; include 50 x 30, center full extents,
W-only pointer height, inch CAM, R10 circle and one cancel/control sequence.
Measure solved extents/dimensions through the application. A helper sent straight
to the engine is only a unit control. The current research phase creates no new
screenshots and makes no claim that these future behaviors work.

For risk-relevant sequence fixes, retain the final regression on the pinned old
source and show the intended assertion fail, then the same command pass on the new
source; capture full source IDs and nonempty outputs in fix-proof.json after the
source commit. Every measured failed test needs an accountable RED JSON line.
New feature tests must also distinguish absent behavior from import/setup failure.
No oracle weakening; preserve approved Shift and WO-3110 expectations and have
independent judges resolve any disputed expectation. No machine/controller motion
or readback applies to these sketch-only phases.

## Other geometry, explicitly deferred

| Existing tool/phase | Obvious quantities | Why outside the first implementation |
| --- | --- | --- |
| Line | Length already implemented; angle could be another field | Retain current length/direction entry; angle would add another interaction. |
| Angled rectangles (both toolbar IDs) | First-edge length, perpendicular width, direction/angle | Existing Tab three-click mode and center-tool semantics differ from axis mode. Extend separately after W/H entry is proven. |
| Center arc | Radius before start point; sweep/end angle later | Pure radius override exists but is intentionally not surfaced; at commit its radius is already set by a prior click. Do not expose a misleading static box. |
| 3-point circle / arc, tangent arc | Radius/diameter or sweep with extra positional choices | Point/tangency construction can be ambiguous; never replace it with a center-based method. |
| Ellipse / elliptical arc | Major and minor radii, rotation; then arc parameters | Existing live labels are read-only. Full-axis versus radius and parameter phases need a separate bounded design. |
| Straight slot | Centerline length and full width (2 * cap radius) | Existing third click uses perpendicular half-width. Requires explicit full-width and relation decisions. |
| Arc slot | Centerline arc quantities and full width | Four-stage geometry; not a scalar substitution. |
| Polygon | Side count, inscribed/circumscribed radius and direction | Side count/mode already exist; R meaning differs by mode. Reuse later rather than invent a universal size field. |
| Gear | Existing parameter set, bore/outer sizing | Already a parameterized tool; no general rectangle-style overhaul. |
| Point, spline/control spline/Bezier, conic, text | Position; handles/rho/text-specific parameters | No single obvious overall size; existing dedicated workflows remain. |
| Fillet/chamfer and other Modify tools | Radius/setback already typed; other overlays have their own values | Existing accumulate/Apply two-Enter behavior must not be changed by creation entry. |

## Research verification and limits

Declared test-slice is empty. Tests executed: none; builds executed: none.
Read source and nearest tests only. No product red was asserted or reproduced.
No new application run, prototype, helper, card, order, other agent, controller
operation, landing or push was performed. Existing WO-3110 measurements/provenance
and its after/32.png were inspected from the evidence commit; that evidence proves
the post-creation workflow, not creation-time rectangle or circle input.

Completion check must be `npm run check -- --base 77979d8dc5b3237b8a4fabf830ec0098cd83f103 --dry-run`.
The check script unconditionally plans TypeScript compilation even for Markdown;
executing it would violate this phase's no-test/no-build scope. Dry-run creates no
.check-receipt.json; do not fabricate one or call its planned commands green.


Design-review provenance: mechanically copied from the preserved WO-3116 PLAN.md after steward review. This document changes no product and claims no executed behavioral tests. ROUTES.md remains the detailed current-source consumer map.


## Source freshness refresh, 2026-10-25

Mechanical review-packet continuation at `4714cbb8926b94f06a78ffa3eb17f9eca4ccc449`. Original research and
its source identity above remain historical. Current dispatch comparison is
`646ae4eeb4cf65f2dcb59981e4ce3bdab1e4f881`. The current source includes WO-3110's
`placeDimensionForTyping` and numeric capture in `SketchDimensionOverlay`; the
older statement that this source is absent describes the original inspection
only. Read the current two-file diff against the original research source:
WO-3110 adds the post-creation Smart Dimension route, while rectangle builders,
draw-value input/commit, pointer/blur handling, units and host ports retain their
original bytes. No change to the recommended rectangle/circle phases follows.

The committed `source-manifest.json` binds current source bytes and exact anchors;
`consumer-searches.json` captures actual read-only rg commands, exits and output;
`observations.json` separates current findings from proposed behavior and runtime
proof. ROUTES.md's original line numbers remain pinned to its original source;
current exact anchors are in the manifest. No runtime or visual measurement was
added and no independent review verdict is claimed. The existing plan's proposed
tests and captures remain future implementation obligations.

For this continuation the completion command is
`npm run check -- --base 646ae4eeb4cf65f2dcb59981e4ce3bdab1e4f881 --dry-run`.
The historical completion command above is retained as provenance, not the current
dispatch instruction. A planned compiler/build/test command is never executed in
this read-only phase; no check receipt is invented.
