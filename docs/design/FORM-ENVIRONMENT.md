# Form environment (SubD organic modeling) - the brief

## FOR THE ARCHITECT - HIT LIST FOR FUTURE WORK ORDERS (Operator ruling 2026-09-29: "Just make sure your documentation lets the architect know that this should be at its hit list for future work orders.")

the operator parked these to keep Form moving. They are Model and Sketch work, not Form: please card them as work
orders (this session does not write queue/). In his order of value:

1. Construct: Axis datum. Through a cylinder or hole, through two points, or along an edge. A new datum kind
   (edge or cylinder refs, its own glyph). Revolve and Plane at angle could then take an axis. Stage 37's
   construction-plane kinds (datumPlane.ts ConstructionPlaneDefinition) are the pattern.
2. Construct, second wave:
   - Plane through 3 points, or through two edges;
   - Tangent plane (to a cylindrical face);
   - Point (a vertex, a circle centre, where an edge meets a plane).
3. Construct wording debt from stage 37:
   - "Offset Plane replay refused" and "Offset Plane preview refused" name the wrong kind for a midplane
     or angled plane. They were kept verbatim so no refusal lines were added; reword them under an order
     that authorizes it.
   - In Edit, the status line says "Edit offset plane" for every kind: the edit DialogState has no kind.
4. Palette layout, next steps after stages 35 and 36:
   - Form palette (FormPanel.tsx) rows in foldable groups: DONE in stage 43.
   - Consider merging the one-button Sketch and Construct rail groups only if Construct stays small (it
     now has 3 tools, so probably not).
   - The hover hint does not render in headless captures: a real-browser check would be good.
5. Axis before the second wave. Both before any Construct polish.
6. Form Pipe along picked body edges (stage 42 note): the page hands Form the selected edges' polylines.

## LATEST FROM THE CLOUD SESSION (2026-09-30 ~2:30 PM CT) - STAGE 52 (docked palettes show that they scroll; panel audit) READY TO LAND

- STAGE 52 READY TO LAND. SHA d9b02dbf2, on top of stage 51.
- Operator ruling 2026-09-30: "I see no scroll on the relief panel, and things run off the bottom ... scroll bar appears if it
  extents are larger than panel size." Also: the Relief panel only while a Relief operation is open.
- Measured first, in the app:
  - the Relief column DID scroll (content 1372 px in a 719 px window; the wheel moved it 653 px);
  - but nothing showed it. The app's scrollbar is 5 px with a dark thumb, invisible on the dark panel, and
    Playwright's headless default hides scrollbars, so no evidence shot ever showed one.
  - The Relief palette was already shown only in Relief mode (absent on the Model screen with a body, present
    once Relief opens); stage 52 records both.
- Fixed:
  - docked palettes scroll only when their rows are taller than the column, with a scrollbar you can see: 10 px, the
    lighter --border-light thumb, and a stable gutter so rows do not shift;
  - the Form evidence and the tutorial recorder now launch with scrollbars shown.
- For the desk, a standing check: panelScrollAudit in src/tests/evidence/FORM/stages.mjs. For every side panel, a
  control below the panel's edge must sit in a scrolling area that scrolls and shows a bar.
  - Stage 52 runs it at 1600 x 900 and 1280 x 720, on the Model screen, in Form, and in Relief with a picture.
  - Every panel passes: the tree, the rail, and both palettes; 0 unreachable controls anywhere.
  - Worth adopting as a UI rule: a panel body is `overflow-y: auto` with a visible bar, and the audit runs on any
    new panel.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-30 ~1:30 PM CT) - STAGE 51 (docked palettes fold; Relief docked) READY TO LAND

- STAGE 51 READY TO LAND. SHA 5a40a63b3, on top of stage 50.
- Operator ruling 2026-09-30, after seeing a docked Relief preview: "we should have Chevron collapsibility on those parked panels.
  Otherwise, visibility to the 3D viewpoint gets too small if person wants to actually review the preview."
- A shared DockedPanel (src/components/model3d/workbench/DockedPanel.tsx) for both palettes:
  - the rail-style header with a fold chevron and the close X;
  - a scrolling body, and a footer that stays put (Cancel / Finish or Apply);
  - the chevron folds the column to a 32 px strip (an unfold chevron, the icon, the name written vertically). The
    view gets its width back (760 to 1028 px at 1600 wide). The fold is remembered per viewer.
- The Relief palette now docks the same way (it floated over the view's top-left, its height map over the right):
  - one 320 px column;
  - the height map is a foldable section at its top (a chevron header, remembered).
- For the desk: the overlay census drops the two Relief surfaces (137 to 135; MODAL-GOVERNED 28 to 26), with the
  exemptions artifact regenerated. OVERLAY-RUNTIME-KEYS.md takes only this change; it is still out of date on main
  for the Offsets panel, as before.

### Earlier LATEST (2026-09-30 ~12:20 PM CT) - STAGE 50 (Form palette docked beside the rail) READY TO LAND

- STAGE 50 READY TO LAND. SHA aefd2a24d, on top of stage 49 and a merge of main.
- Operator ruling 2026-09-30: "Dock the Form palette at the side like the rail". Building the example parts showed the
  floating palette covered the view's left third, and clicks meant for the canvas landed on it.
- The palette is now a column of the Model screen's row, between the view and the rail:
  - the rail's panel styling, 300 px wide;
  - the rows scroll, and Cancel / Finish Form stay pinned at the bottom;
  - the view narrows for it (at 1600 px wide the view goes from 1060 to 760 px) and nothing overlaps.
- The Relief palette still floats; it was not part of the ask.
- For the desk: the overlay census counts one floating surface fewer (138 to 137; MODAL-GOVERNED 29 to 28), and the
  exemptions artifact is regenerated. OVERLAY-RUNTIME-KEYS.md takes only this change. That file is already out of
  date on main for the Control screen's Offsets panel, and its byte check fails on main the same way; it was left
  alone (not this branch's, and the Control screen is off-limits here).
- The tutorial recorder follows the new layout (empty-canvas spot, caption centred on the narrower view); both
  example videos are re-recorded.

### Earlier LATEST (2026-09-29 ~10:10 PM CT) - STAGE 49 (exact G1 at star points, in the export) READY TO LAND

- STAGE 49 READY TO LAND. SHAs fe4b5d375 (wiring) and c743cdd02 (tests, evidence), on top of stage 48 (aa5db5c75).
- Item 5 of the operator's order is DONE: exact G1 at star points. Every smooth star point of a closed form (no crease
  there, no flat face there) now meets with one tangent plane exactly.
  - Its faces are written at degree 5, with stage 48's solved corner patches.
  - The other star points keep the bicubic G1 pass, as before.
- Measured:
  - the kernel's own mesh normals across every face boundary: 7e-12 deg on the degree-5 file, against 0.0104 deg
    (lobed knob) and 0.0023 deg (6-sided cylinder) on the bicubic file;
  - face and edge counts are unchanged (sphere 6, knob 24);
  - the surface moves less than under the bicubic pass (knob 0.145 mm before, 0.056 mm now);
  - volumes still match the limit surface within 5e-4.
- Cost, for the desk:
  - about 2.8x the poles and the STEP size (sphere 152 to 445 KB);
  - formStep 150-400 ms slower;
  - the kernel's STEP import 2-3x slower: knob 1.9 s to 5.8 s, sphere 2.9 s to 5.0 s. Finish on the knob is
    about 4 s later.
  - The torus (no star points) is unchanged.
  A switch back is formStep's exactG1 argument (false); it is not in the UI.
- Open, not fixed here: the Gaussian curvature view of the finished knob showed small blue speckles on its nearly
  ruled flanks. That is probably the display's per-vertex fit on the kernel mesh, where K is about 0, but it is not
  proven. The shot was left out of the evidence.
- the operator asked for example parts and videos (to learn the tools, and for users at release). They are in
  docs/examples/form (README.md there):
  - lobed-knob and grip-handle: .camproject files (the app's own Save, reopened and checked), .mp4 walkthroughs
    with captions and a drawn cursor, reopened screenshots;
  - built by src/tests/evidence/FORM/tutorials.mjs. Form steps are real clicks, gizmo drags and orbit drags;
    standard features are the tree nodes their dialogs write, named in the captions.

### Earlier LATEST (2026-09-29 ~8:15 PM CT) - STAGE 48 (exact G1 spike) PUSHED, NOT YET IN THE EXPORT

- STAGE 48 is a spike: aa5db5c75, on top of stage 47 and a merge of main. the operator chose exact G1 as item 5,
  starting with a 2-hour go/no-go spike. The result is GO, at degree 5 rather than degree 4.
- src/form/g1Exact.ts solves degree-5 corner patches round every smooth extraordinary point. The faces then
  meet with one tangent plane exactly, to rounding, not to a tolerance.
  - Seam angle, before the solve (the bicubic patches) and after:
    | cage | before | after |
    |---|---|---|
    | box, valence 3 | 0.51 deg | 1.7e-11 deg |
    | 5-sided cylinder, valence 5 | 0.48 deg | 6e-12 deg |
    | 6-sided cylinder, valence 6 | 1.07 deg | 5e-12 deg |
    | lobed knob, valence 8 and 3 | 2.40 deg | 8e-12 deg |
  - The ordinary neighbours' C1 is kept to 1e-13 mm. The surface moves at most 0.056 mm (g1.ts allows up to
    0.2 mm).
- Why degree 5 and not degree 4: at degree 4, round a point of even valence (6, 8), the twist conditions need an
  alternating sum of fixed poles to vanish. They do not in general, so degree 4 would only cover odd valence.
- NOT in the export yet: formStep still writes bicubic faces through g1.ts, so the app is unchanged and there is
  no headless evidence. Remaining, per the estimate given to the operator:
  - raise the faces holding a corner patch to degree 5, with the edge curves to match;
  - packing and knot removal at degree 5;
  - kernel checks, performance and evidence.
  Waiting on the operator's go before wiring it in.

### Earlier LATEST (2026-09-29 ~5:40 PM CT) - STAGE 47 (curvature display: measure and range) READY TO LAND

- STAGE 47 READY TO LAND. SHA 100884184 (code, tests and evidence in one commit). On top of stage 46.
- Item 4 of the operator's order: Gaussian and range controls on the existing curvature display (Model screen,
  Display Mode flyout, Curvature on).
  - Measure: "How tight" (curvedness, as before) or "Gaussian". Gaussian colours green where flat or ruled
    (planes, cylinders, cones), toward red on a dome, toward blue on a saddle.
  - Range: Flat radius and Tight radius, mm (defaults 200 and 3, as before). Typed the wrong way round they
    come back swapped; a value that is not a radius leaves the old one. No refusal, no warning.
  - Shared uniforms: every body follows at once, no shader recompile.
- Evidence: an exact torus. How tight: all of it curves (no blue). Gaussian: the outside red-ward, the inside
  blue-ward. Tight radius 20: the torus turns red.
- Next: item 5, exact G1 at star points. It was deferred in the plan the operator approved, so the approved order is
  done. Waiting for the operator's next pick.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~5:13 PM CT) - STAGE 46 (face packing: fewer faces, measured right) READY TO LAND

- STAGE 46 READY TO LAND. SHAs 1ca6d8bd5; evidence 6defa91b6. On top of stage 45 (c942c8cd2).
- Item 3b of the operator's order: face packing. What limited it was not rectangles.
  - The G1 pass nudged poles by about 1e-7 mm at points already smooth (a cylinder rim, 1.2e-6 deg before
    and after: no gain), and that broke the exact C1 joins packing needs.
  - A one-ring cylinder side packed into 10 faces; now it packs into 2, the fewest without a seam. The
    From-body cylinder finishes as 4 exact faces (was 15).
- Found and fixed on the way: with the bigger packs, knot removal left faces with a single span up their
  height, and the kernel's volume integration drifted (0.15% on the kernel, 0.6% in the app's Bodies list),
  though a fine mesh showed the surface was right. Packed faces now keep at least 4 spans each way. The
  Bodies list reads 9421.87 against the cylinder's 9424.78 (-0.031%).
  - Cost, for the desk: the torus's knot reduction drops from 40x to 25x fewer poles. Its size check is
    re-pinned to 24 with the reason written beside it. The knob's edge-count bound goes 44 to 45 (same 18
    faces).
- NOT done, and recommended against: truly non-rectangular packs. One untrimmed B-spline face is a
  rectangle; an L-shape needs trimmed surfaces. After this fix the packs are already large.
- Next: item 4, Gaussian/range curvature controls.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~4:16 PM CT) - STAGE 45 (From body: fewer rings on ruled faces) READY TO LAND

- STAGE 45 READY TO LAND. SHAs f464ddda7; evidence d1b2e5421. On top of stage 44 (9785020ca).
- Item 3a of the operator's order. From body now gives a ruled face one ring of quads instead of a ring every
  spacing:
  - cylinder and cone sides;
  - quad faces between creased straight sides, like a cylinder notch.
  A real cylinder or cone goes from 176 cage points to 44, and a notched box from 30 to 14, with volumes as
  close or closer. In the app, a 30 mm cylinder finishes exact within 0.035% (20 cage faces, 15 exact
  faces).
- Found on the way, and fixed: the two rims' samples started at different angles, so one ring twisted into a
  waisted hyperboloid (-0.54% in the app). The second rim now starts at the point nearest the first's first
  sample. Also found and not done: thinning fillet strips beside flat faces makes the skin sag 2 mm off the
  body, so smooth neighbours keep their segments.
- Next: item 3b, non-rectangular face packing.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~3:45 PM CT) - STAGE 44 (Face: picked work plane, chain mode) READY TO LAND

- STAGE 44 READY TO LAND. SHAs c70811946; evidence 4427cae67. On top of stage 43 (196d3e026).
- Item 2 of the operator's order. Face by clicks now:
  - Works on the construction or base plane selected in the Model tree (Offset plane, Midplane, At angle,
    XY ...) when no sketch is selected; before, it was the sketch's plane or XY only.
  - Alt+click on a face of the form makes that face's plane the work plane.
  - Chain: a new Chain rail button next to Face. Each face starts the next on its last edge, so a strip
    takes two clicks a face, clicked back and forth.
  - Tripwire CLEAR.
- Next: item 3, From body with fewer rings on ruled faces, then non-rectangular face packing.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~3:32 PM CT) - STAGE 43 (Form palette groups) READY TO LAND

- STAGE 43 READY TO LAND. SHAs 1716469f7; evidence fc8afffe4. On top of stage 42 (a753b5ff5) and a merge of
  origin/main.
- the operator's order for the rest of the Form list (his "go for it" to this plan):
  (1) the Form palette's foldable groups: this stage;
  (2) Face: a work plane picked in the view, then chain mode;
  (3) From body: fewer rings on ruled faces, then non-rectangular face packing;
  (4) Gaussian/range curvature controls;
  (5) exact G1 at star points: deferred, possibly indefinitely. Star points are already within 0.02 deg,
      invisible on a machined part.
- The palette's settings now sit in groups named after the rail groups whose tools they set: Start from,
  Edit form, Topology, Openings, Display, and Symmetry once a mirror is on. Each group's slim header folds it,
  remembered per viewer. Name stays on top.
  - Heights at 1600 x 900: every group open 726 px, a working set folded 582 px, every group folded 459 px.
  - FOR THE DESK: the five slim headers are the only added lines, and each one folds away rows. No setting
    row was added and none moved out of its tool's group.
- For the desk: src/tests/ui/overlayRuntimeCensus.test.tsx "OVERLAY-RUNTIME-KEYS.md is byte-identical" is
  RED on origin/main itself (checked in a clean worktree of origin/main): not this branch's. The generated
  artifact needs regenerating on main.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~2:23 PM CT) - STAGE 42 (Pipe along 3D paths) READY TO LAND

- STAGE 42 READY TO LAND. SHAs 8b605b188; evidence 6f931edea. On top of stage 41 (f596c4e64).
- Pipe along 3D paths. Click Pipe with a sketch selected, then select a next sketch whose curve starts where
  the pipe ends (any plane) and click Pipe again: the path carries on, and it closes when it comes back
  round.
  - Rotation-minimising frames come back round a closed 3D loop turned (a trefoil: 2.6 rad). That turn is
    now spread along the loop, so the seam meets untwisted.
  - Body edges as a path are NOT in this stage: it needs the Model screen's edge selection and edge
    tessellation handed to Form (a page seam), so it is left for the architect's hit list.
  - Tripwire CLEAR.
- Remaining Form gap list: ruled faces with fewer rings (From body), non-rectangular face packing,
  Gaussian/range curvature controls, a chain mode and a picked work plane for Face; exact G1 at star points
  (L). Also the Form palette's foldable groups (hit list).
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~2:09 PM CT) - STAGE 41 (Mirror duplicate) READY TO LAND

- STAGE 41 READY TO LAND. SHAs 8a50f2a44; evidence de80ce4be. On top of stage 40 (6926bd000).
- Mirror duplicate (a Duplicate button in the Symmetry group) copies the form across the mirror plane and
  joins the two halves: model half, get the whole.
  - The plane is the mirror that is on, else X = 0, and the notice says so.
  - Points on the plane are shared, and faces lying in it join away.
  - Creases and weights are mirrored too, and the mirror stays on afterwards.
  - A form that crosses the plane is still copied, and the notice counts the points the copy overlaps.
    Rule 11: it can do it, so it does it and says what it did.
  - Tripwire CLEAR.
- Next on the gap list: 3D pipe paths.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~1:59 PM CT) - STAGE 40 (curved bridge band) READY TO LAND

- STAGE 40 READY TO LAND. SHAs 4e8e7abd0; evidence ae86bd7f3. On top of stage 39 (976aaaebd).
- Bridge bands now curve: each end leaves its opening the way the surface there faces.
  - Two face sets on a box's top arch up into a handle (about half the gap high).
  - Opposite faces (a hole through) and two sheets edge to edge still run straight, exactly as before.
  - No new control: Bridge's existing "long" and "twist" still apply. Tripwire CLEAR.
- The Form gap list's remaining S items: mirror-duplicate, 3D pipe paths, ruled faces with fewer rings in
  From body, non-rectangular face packing, Gaussian/range curvature controls, a chain mode and a picked work
  plane for Face. The one L item is exact G1 at star points. Next, unless the operator says otherwise:
  mirror-duplicate, then 3D pipe paths.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~1:40 PM CT) - STAGE 39 (Loft rails) READY TO LAND

- STAGE 39 READY TO LAND. SHAs cb7e8ce0d; evidence 8c46b0fd0. On top of stage 38 (b07deab9e).
- Loft rails. After two or more profiles, an open sketch curve whose ends lie on the first and last profiles,
  added with the same Loft button (select it in the tree, click Loft), is a rail and the loft's sides follow it.
  - One rail sets the size along the way; two or more also lean and turn the loft.
  - The skin is pulled through the rails as well as the profiles.
  - Anything else clicked stays a profile, as before.
  - No new button, row, refusal or gate; tripwire CLEAR.
- Next on the Form gap list: a curved bridge band.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~1:04 PM CT) - STAGE 38 (drag the mirror plane) READY TO LAND

- STAGE 38 READY TO LAND. SHAs 8d6048564; evidence 674f56ec2. On top of stage 37 (7ecc85ba5) and the
  hit-list commit 1f53c2516.
- Back on Form, as the operator asked ("we can get form moving along"). The Construct and palette items are parked in
  the FOR THE ARCHITECT hit list above.
- With a mirror on (X, Y, Z or from a selection), a press on the bare mirror plane grabs it:
  - it slides along its normal and the pairs and seam follow live;
  - the Mirror row shows the number as it moves;
  - release lets go, orbit is held off during the drag, and the pointer shows a grab cursor over the plane;
  - the cage wins: a press on a point, edge or face that lies on the plane selects as before;
  - circular symmetry and the Face tool are left alone.
- Next on the Form gap list: loft rails, then a curved bridge band.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~12:35 PM CT) - STAGE 37 (Construct: Midplane, Plane at angle) READY TO LAND

- STAGE 37 READY TO LAND. SHAs 066fbd66d, f1285dd1c, 6d519a8de; evidence c4d38f1f0, re-shot on the final
  code in 2fa58039b. On top of a merge of origin/main (453b94cdc). Stage 36 (entry below, kept) is still
  READY TO LAND too.
- the operator: "construct plane is the only thing in the construct panel". The Model rail's Construct group now has:
  - Offset plane;
  - Midplane: two planes or flat faces. Parallel ones give the plane halfway across; ones that meet give
    the plane through their shared line that halves the angle. So there is no "not
    parallel" refusal (rule 11).
  - At angle: a plane or flat face turned about its own X or Y axis.
- Built as new definition kinds of the existing construction-plane datum (planeKind 'offset-plane',
  definition.kind 'midplane' | 'angle'). The tree row, sheet glyph, New sketch on it, Extrude to it, Edit,
  save and reload, and face-pick support planes all come with it unchanged. One dialog, one preview
  session, one Apply path.
- Found and fixed on the way: a FeatureDag serializes `consumes` sorted, so a midplane's "first" plane did
  not survive a reload. A midplane now reads its parents in that same sorted order
  (constructionPlaneParentOrder), so it never depends on pick order.
- Axis is not in this stage. It is a new datum kind (edge or cylinder refs, its own glyph), the next
  Construct stage if the operator wants it. Then back to the Form gap list.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~11:09 AM CT) - STAGE 36 (CAM Sketch toolbox layout) READY TO LAND

- STAGE 36 READY TO LAND. SHAs fb534e5bf; evidence fc59d5057. On top of main c5baf30f2 (stage 35 is
  already on main; the merge was a fast-forward).
- the operator: "cam sketch also falls victim to pallet overflow". The CAM Sketch toolbox (SketchToolbox.tsx) now
  uses the rail's layout hook (palette key 'cam-sketch'):
  - a compact button in its header;
  - its existing group folds, now remembered;
  - tighter button padding.
  The CSS moved to src/components/common/toolPaletteLayout.css and is shared by both palettes.
- Measured headless (1600 x 900, a new sketch; stage36.json):
  - normal: 1319 px of tools, 623 px out of sight below the bottom;
  - compact: 726 px, 30 px out of sight;
  - compact with Constraints folded: 0 px out of sight.
- Order agreed with the operator (his words: "go with your own recommendation"):
  (1) this stage;
  (2) Construct tools in the Model rail: Midplane, Plane at angle, Axis (Offset plane is the only one
      today);
  (3) back to the Form gap list: drag the mirror plane in the view, loft rails, a curved bridge band.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~8:05 AM CT) - STAGE 35 (rail layout) READY TO LAND

- STAGE 35 READY TO LAND. SHAs 9b9718846; evidence 85764290e. On top of stage 34 (fbdab8b71) and a merge of
  origin/main (85ed987f9). Stage 34 (the entry below, kept) is still READY TO LAND too.
- the operator asked for the palette to stop running off the bottom. The rail (Model, Form and Model-sketch
  modes; one component) now has:
  - A compact button in the rail header: icons only, packed tight (30 x 28 px cells). Each hover hint
    names the tool first ("Box: ..."). The names stay in the buttons for screen readers.
  - A fold chevron on the right of every group header. A folded group keeps its header, and nothing
    else moves.
  - Tighter padding in normal mode (5/4 px, not 7/5).
  - Both choices remembered per viewer in browser storage. A store that is empty, garbled or throws
    leaves the defaults.
- Measured headless (1600 x 900; stage35.json):
  - Form rail: normal 990 px of tools in a 767 px rail (223 px off the bottom); compact 506 px, all 45
    tools in sight.
  - Model rail: 615 px normal, 349 px compact.
- The hook is shared (src/components/common/useToolPaletteLayout.ts), so the CAM Sketch toolbox can use
  it next. the operator says that toolbox overflows worst. It already folds groups but forgets them, and has no
  compact mode.
- No new rows, refusals, warnings or disabled states. The first CSS try hid names with position:absolute,
  and the UI78 overlay guard warned on every button. It was replaced before commit; the final run has
  no guard lines.
This session cannot send cross-session replies; it answers here.

### Earlier LATEST (2026-09-29 ~7:40 AM CT) - STAGE 34 (remesh From body) READY TO LAND

- STAGE 34 READY TO LAND. SHAs 0f99e3126, 7a3fc0d33, 60203d02f; evidence aa15e00fb. On top of a merge of
  origin/main (69c345863). The section is below the stage 33 section.
- From body now remeshes by default. The old path is kept behind `formFromBody(mesh, { remesh: false })`, and
  its tests (formFromBody.test.ts) run that path as the control.
- All five TODO items are done:
  - (1) Flat-flat edges keep their points: the box has 8 points again (76 before).
  - (2) Three-sided and five-sided faces split at a centre into quads. The filleted box has no triangle
    faces now (8 corner blends before).
  - (3) Wired into From body.
  - (4) Real-kernel tests: remesh.test.ts, 6 tests.
  - (5) 7 negative controls, all bite; 4 app captures, opened.
- Two things the probe did not show, both fixed:
  - Rim points: pulled onto the nearest point of the whole body, a cylinder's rim points found the flat end
    (distance 0) and never moved. The rim sat 0.16 mm inside. Each point is now pulled onto its own edge or
    face.
  - Flat faces beside a fillet: one n-gon per face dragged its tangent edges inward (2.5 mm), and the Pull's
    correction left 0.4 mm waves. These flat faces are now gridded too.
- For the desk's eye: stage34/01-03. A green outline of the filleted block's bottom face stays drawn after
  the block is hidden (the Model screen's selection highlight, not Form's code). The top of the Form rail's
  MODELING section is clipped, as in earlier stages.
- Rules kept: no palette rows; stayed out of src/lib/machine, pendant/, tools/, queue/ and the Control /
  Probing screens; WO-1894 probe-result.json reverted before each commit.
This session cannot send cross-session replies; it answers here.

## RULING 2026-09-27 ~7:40 PM CT - Form lives INSIDE the Model screen (supersedes "its own screen" below)

the operator, after seeing stage 1's separate Form tab: "My preference would be modeling tab is modeling tab.
Potentially there might be a different alternate viewpoint inside of the modeling tab when they use forms, but
ideally I'd like to be able to make a form and then perform some of the other standard CAD operations against it
like booleans, cuts, holes, etc. ... the modeling workspace is where modeling happens, regardless of style."

So:
- NO Form tab, NO 'form' workspace. Remove them (header tab, Workspace type, App host, the repinned tab tests go
  back to eight tabs).
- "Create Form" is a tool on the Model screen's tool rail. It enters a form-editing mode INSIDE the Model screen
  (the "alternate viewpoint": cage, smooth skin, the form tool panel, form undo). "Finish Form" returns to the
  normal Model screen with the form as a body in the model tree, beside the other bodies; editing that feature
  re-enters form mode on its cage (one feature in the model history so editing reuses the stored cage).
- The finished body must take the Model screen's standard operations. As a mesh body (stage 4 path) booleans
  and cuts work today; holes, fillets, shell etc. need the exact CAD-solid conversion, which is therefore the
  NEXT stage after the Model integration (it was "later").
- Code placement (project lint, found by the gate): React/UI code lives under src/components/ (e.g.
  src/components/model3d/form/); src/form/ keeps the non-React core (cage, half-edge, subdivide, surface,
  starters, store logic).
- Keep the hub edit to src/components/model3d/SolidsWorkbenchPage.tsx small (a rail button, a mode switch,
  mounting the form panel/scene, the Finish hand-off) - desk lanes edit that file too.

Revised stages: 1R Model integration of what stage 1 built (above) -> 2 Edit Form -> 3 edge loop / crease /
mirror -> 4 Finish Form -> body in the Model tree -> booleans/cuts on it and CAM toolpaths on it -> 5 exact
CAD-solid conversion (so holes, fillets, shell work on forms).

## Scope for the cloud run (the operator's accepted defaults - see the RULING above for where Form lives)

Stage 1 - Form screen, cage, live smooth display
- Its own screen, "Form", reachable like the other top-level screens.
- Cage data: vertex positions, faces (quads mostly, n-gons allowed), edge crease flags. Half-edge topology in
  our own TypeScript (no JS library has robust edit operations; Wings3D, OpenMesh and pmp-library are design
  references). A validator after every topology operation (manifold, closed where expected, oriented).
- Starters: box, cylinder, sphere (quadball), plane - with segment counts.
- Undo/redo inside the form: whole-cage snapshots (cages are small).
- Live Catmull-Clark smooth skin with sharp creases, drawn with three.js. Recompute on topology change;
  while dragging only positions change (precomputed stencils: each skin point is a fixed weighted sum of
  cage points). Coarser level while dragging, finer at rest.
- Display: cage only / cage + smooth / smooth only.

Stage 2 - Edit Form
- Pick a cage point, edge or face (picking the cage drawn over the smooth skin must feel right).
- Move / rotate / scale with a gizmo (reuse src/components/model3d/gizmos, TransformControlsAdapter and the
  screen-space picking in src/viewport3d). Multi-select. Alt-drag a face to extrude it.

Stage 3 - Topology tools and symmetry
- Insert edge loop. Crease / uncrease. Mirror symmetry (paired points; seam points held on the plane).

Stage 4 - Finish Form -> mesh body -> CAM
- Tessellate the smooth surface to a tolerance (default 0.01 mm chord) and create a mesh body through the
  existing mesh-body path (see src/components/model3d/workbench/stlModelBody.ts, src/mesh/). Label it
  approximate, as other mesh results are.
- The form stays re-editable: Finish Form is one feature in the model history; editing it reopens the cage.
- PROVE in the app: a formed knob goes to Setup and a 3D roughing + finishing toolpath generates on it
  (the 3D CAM already reads meshes: src/cam3d/input/index.ts turns STL and STEP into one PartMesh).

Later (NOT this run unless stages 1-4 are landed): SubD -> exact B-spline patches -> OpenCascade solid.
Regular faces convert exactly (Stam 1998: a regular Catmull-Clark face is a uniform bicubic B-spline patch);
faces at star points (3 or 5+ edges at a point) must be approximated (Peters 2000 PCCM; newer G1 biquartic
schemes). Needs one new occt-wasm binding: an exact Geom_BSplineSurface from poles/knots -> face (today's
bsplineSurface() is an approximating fitter at 1e-3 - never use it for this). Then second-wave tools (bridge,
fill hole, weld, slide edge, circular symmetry, start from a sketch).

## Facts the research established

- Patents: US 7,274,364 (core T-spline) expired 2024-03-26; US 8,310,481 lapsed 2016; SubD->NURBS
  US 6,859,202 and US 6,950,099 expired 2022 and 2023; Pixar released its subdivision patents. Not a full
  freedom-to-operate search.
- Licences: LienCAM is GPL v3. OpenCascade LGPL-2.1 (already shipped), OpenSubdiv Apache-2.0 variant (probably
  compatible; optional - start with our own TypeScript subdivision), Blender GPL-2.0+ (code may be borrowed),
  OpenMesh BSD-3, pmp MIT, Wings3D BSD.
- Already in LienCAM: occt-wasm 3.6.1 (OpenCascade 7.9, patched build in vendor/), three.js 0.184,
  manifold-3d 3.5.1 (mesh booleans, src/mesh/manifoldOps.ts), gizmos and picking, mesh bodies, the 3D CAM mesh
  input.

## How the cloud session works (binding)

- Read LIENCAM.md first (the whole rulebook - rule 5, 6 and 11 bind you). ADR-0040: no legacy before 1.0.
- Branch: `form/subd` from origin/main. Push after each stage is working. Never push to main; the desk
  architect lands each stage through the test gate.
- Keep it additive: new code under src/form/ and src/tests/form/. Touch shared hub files (App screen routing,
  src/components/model3d/SolidsWorkbenchPage.tsx, src/store/index.ts, the doc/DAG feature registry) only where
  a stage needs a hook, keep those edits small, and list every hub edit in the Progress section below.
- Never touch src/lib/machine/, pendant/, tools/ or queue/.
- Every stage: focused tests (npx vitest run src/tests/form plus any test a hub edit could break) and
  `npx tsc -b` green. A test that proves a behaviour must fail with the behaviour removed (negative control).
  Do not run the whole suite (slow); the desk gate runs it before landing.
- Visual work needs a capture: a headless Playwright screenshot of the Form screen per stage in
  src/tests/evidence/FORM/<stage>/ (delete-first, then shoot; open them yourself before claiming done).
- No new refusals, warnings, confirms, disabled controls or red console lines the operator did not ask for
  (tools/blocker-tripwire.mjs refuses such a landing). The software refuses only what it cannot do.
- Small atomic commits, imperative subjects. Plain ASCII in docs and commit messages.
- Update the Progress section below at the end of each stage: what works, the SHA, what is not proven,
  hub files touched, and anything that needs the operator's eye (with the capture path).

## Progress

Cloud session, branch `form/subd` (from origin/main 1c1f512). Newest stage last.

### Stage 1 - Form screen, cage, live smooth display - DONE at 2e88c97 (screen placement SUPERSEDED by 1R)

What works (all in the running app, see captures):
- A "Form" tab after Model in the header opens the Form screen (workspace 'form'), lazily mounted and
  retained like Control, so a cage in progress survives tab switches. Any CAM tab goes back.
- Cage data (src/form/cage.ts): points, faces (quads, triangles, n-gons), crease flags as edge keys.
  Half-edge topology and a validator (src/form/halfEdge.ts): every face 3+ distinct existing points,
  every point used, manifold edges (max two faces), one fan per point, consistent orientation, closed
  when expected, creases must be edges. The store refuses (by name, in the Form status line) any
  topology change that fails it and keeps the previous cage.
- Starters with segment counts (src/form/starters.ts): box (X/Y/Z), cylinder (around/along, n-gon
  caps), sphere as a quadball (per cube side), open plane (X/Y). All sit on Z = 0 centred on Z.
- Catmull-Clark with infinitely sharp creases (src/form/subdivide.ts): one step is a sparse matrix;
  open boundaries behave as creases; limit-position masks put displayed points on the limit surface.
  Stencils (src/form/surface.ts): each skin point is a fixed weighted sum of cage points, compiled on
  topology change; a drag only re-multiplies (measured: level 4 of a 4x4x4 box, 24,576 quads, compile
  ~0.6 s once, evaluate ~5 ms per frame). Normals split only across creases and open edges.
- Level policy (src/form/formScene.ts skinLevels): finest level up to 4 within 40,000 quads at rest,
  one level coarser while dragging.
- Display: Cage / Cage + smooth / Smooth. Undo/Redo on the Form panel and Ctrl+Z / Ctrl+Shift+Z /
  Ctrl+Y while Form is showing: whole-cage snapshots (limit 200).
- Help topic "The Form screen (SubD organic modeling)" for workspace:form.

Decisions made (reversible):
- Form state lives in its own zustand store (src/form/formStore.ts), not the CAM project store: a
  form in progress is transient, like a sketch in progress. Stage 4 writes the finished body into
  the project.
- The skin uses the Model screen's studio look (same tone mapping, PMREM environment, world-fixed
  lights, createModeledBodyMaterial). First captures with a camera-carried light showed hard
  specular patches and terracing; level 4 at rest removed the terracing.
- The header Undo/Redo is hidden on the Form screen (as on Control) instead of being shown disabled;
  the Form panel carries its own Undo/Redo, shown only when there is something to undo/redo.
- Cylinder caps are single n-gons (Catmull-Clark makes a quad fan round a centre point).

Tests (all green at 2e88c97):
- `npx vitest run src/tests/form/` -> 1 file, 20 passed / 0 failed.
- `npx tsc -b` -> clean.
- Shared-file slice (every test naming ModeTabStrip / mode-tab- / TopToolbar / helpContext /
  activeWorkspaceHistory / Workspace, plus src/tests/help): 83 files, 544 tests. Mine: 7 reds
  fixed (help census wanted a workspace:form topic; three tab-order tests pinned eight tabs and now
  pin nine with Form after Model). 5 reds are identical on a clean origin/main worktree and are not
  from this branch: uiClutterCensus.wo1182 (same census diff), int17aR1ConsumerCensus (unclassified
  reader components/machine/ProgramPanel.tsx), bridgeLifecycle.wo1179, rehearsalProfileIsolated.wo2030,
  renderedTextContrast.wo1296 + headerClipBand.wo060 + headerFloor.wo064 (these need Playwright's own
  headless-shell build, absent in this sandbox).
- `node tools/blocker-tripwire.mjs --base origin/main --head HEAD` -> CLEAR.
- Negative controls (script mutates the committed source, runs `npx vitest run src/tests/form/`,
  restores with git checkout; baseline 20/0, after restore 20/0, no mutation left):
  creases ignored in the edge rule -> 3 red (creased box, creased cylinder rim, crease shading);
  creases ignored in the point rule -> same 3 red; smooth point rule dropped -> 2 red (smooth rule,
  limit agreement); limit mask not composed -> 1 red (stencils = direct subdivision); orientation
  check removed -> 1 red; fan check removed -> 1 red; no normal split at creases -> 1 red; undo
  snapshot sharing arrays -> 1 red; redo not cleared by a new change -> 1 red.

Captures (src/tests/evidence/FORM/stage1/, shot by `node src/tests/evidence/FORM/shoot.mjs 1` through
the Form tab of the running app, each gated by a live-store predicate; opened and checked):
01 box cage + smooth, 02 sphere (3 per side) smooth only, 03 cylinder cage only, 04 one cylinder
point pulled up and out (level 3 while dragging, 4 at rest), 05 the Form Undo button restores it,
06 open plane.

Not proven in stage 1: point picking/moving by mouse (stage 2; the capture's pull goes through the
store's drag path, the same path the gizmo will drive). Performance on the operator's machine (numbers above
are this sandbox, software GL in the captures).

Shared (hub) files touched: src/types/index.ts (Workspace gains 'form'); src/App.tsx (lazy Form host);
src/components/toolbar/ModeTabStrip.tsx (Form tab; CAM tabs return from Form);
src/components/toolbar/TopToolbar.tsx (header Undo/Redo hidden on Form, as on Control);
src/help/helpContext.ts (workspace type follows Workspace); src/help/index-data.ts and
src/help/topics/modeling/index.ts (Form topic); tests repinned: src/tests/viewport/headerModeTabs.wo047,
tabStripModelDefault.ui77, workspaceBar.int13a.

For the operator's eye: the ninth header tab (Form, after Model) - stage1/01-box-cage-and-smooth.png; the skin
look (Model-screen material) - stage1/02-sphere-smooth-only.png.

Note to the desk architect: this cloud session cannot send cross-session messages (the reply to the 7:40 PM
ruling and the 10:30 PM check-in failed with "cannot message other sessions yet"), so answers live here.

### Stage 1R - Form inside the Model screen - DONE at c6a1786 (fixes after: 83ee23f, a75e5bf)

What works (captures in src/tests/evidence/FORM/stage1R/, shot by `node src/tests/evidence/FORM/shoot.mjs 1R`,
every shot gated by a live-store predicate, all opened and checked):
- No Form tab, no 'form' workspace, no App host: those files are back to main byte for byte and the three tab
  tests pin eight tabs again. 01: the Model rail's Create section has "Form".
- Form mode INSIDE the Model screen (02-06): the cage and the live skin draw in the Model viewport (same scene,
  camera, studio lighting); the right rail swaps to the form tools (Form - start from / Edit form / Topology /
  Symmetry / Display / Form history) the way Sketch swaps it; a Form palette docks at the viewport's top-left
  (name, segment counts, chord tolerance, status, Finish Form / Cancel). Header Undo/Redo and Ctrl+Z / Ctrl+Y
  drive the FORM history while form mode is open (whole-cage snapshots), the Model history otherwise.
- Finish Form (07): ONE Model-history feature, opType 'form', payload = the cage (+ name, tolerance). Replay
  tessellates the limit surface (src/form/finish.ts) and hands one planar face per triangle (flat quads as one
  face) to the kernel's existing makeSolidFromPlanarFaces, which sews a closed solid: a real body in the Model
  tree and Bodies list ("Knob 23445.28 mm^3"), reaching CAM as any model body does. Smooth facet edges are not
  drawn (src/form/formEdges.ts drops an edge only when both faces are form facets meeting within 30 deg), so
  the body shows its creases and cuts only.
- Edit (08): tree right-click > Edit reopens form mode on the feature's own cage, the old body hidden while the
  cage is open; Finish edits the same node (EditFeaturePayloadCommand), Cancel leaves it untouched.
- Code placement per the gate: React/UI in src/components/model3d/form/ (FormPanel, useFormSession,
  formInteraction); non-React core in src/form/. `npx eslint` on changed files: 0 errors.

Performance found and fixed on the way (both measured in this sandbox):
- Finish took ~240 s for a knob: occt-wasm's edgeToFaceMap is quadratic in the face count (1,920 planar faces
  ~3 s, 7,680 ~75 s per tessellate call, twice per body). src/geom/worker/planarAdjacency.ts walks each face's
  edges instead, only for bodies with more than 256 faces that are ALL planar (no seams can exist on a plane);
  every other body keeps the kernel map. Tessellate: 75 s -> ~1 s; Finish in the app: 240 s -> 9.7 s.
- Proven equal to the kernel map on a real faceted solid (same edge -> face sets, same seam classification).

Decisions (reversible):
- The form body is a FACETED kernel solid, not a mesh row: that is what puts it in the Model tree as one
  feature and lets booleans/cuts (and CAM) take it today. Sewing grows faster than linearly (3,072 triangles
  ~0.8 s, 12,288 ~7.5 s), so a form body is refined until it meets its tolerance OR 12,288 triangles
  (FORM_BODY_MAX_TRIANGLES). The creased knob at the default 0.01 mm reaches ~0.024 mm at that cap; 0.01 mm
  needs ~41k triangles (minutes of sewing). Stage 5 (exact B-spline patches) removes this limit properly.
- Chord error is measured along the surface normal (a flat creased bottom has no chord error even though its
  points drift sideways between levels).
- Form lives in the Create section of the rail; the palette is docked, not the shared floating DialogShell
  (which opens over the rail and hid the form tools).

Not proven: booleans/cuts on a form body in the app (next, with stage 4); performance on the operator's machine.
Known sandbox behaviour, not this branch: "3D geometry engine initialization failed (attempt 1 of 3)" appears
~30 s after load on a clean origin/main worktree too (slow wasm start under software GL); the retry succeeds.

### Stage 2 - Edit Form - DONE at 1382d13

What works (captures src/tests/evidence/FORM/stage2/, `node src/tests/evidence/FORM/shoot.mjs 2`, REAL mouse
input in the app; opened and checked):
- 01 a click on a cage point picks it (the Model screen's TransformControlsAdapter gizmo appears at it);
  02 dragging the gizmo's Z arrow lifts the point (40 -> 48.5 mm) and the skin follows live;
  03 Shift-click adds a point (gizmo at the selection centre); 04 a click on the smooth skin picks the CAGE face
  that skin grew from; 05 Alt-drag of a move arrow extrudes the selected face (24 -> 28 faces) and pulls it out;
  06 Rotate on the rail swaps the gizmo; 07 Ctrl+Z undoes the extrusion (form undo; Model history untouched).
- Picking rules (src/form/pick.ts): a point within 10 px, else an edge within the Model screen's edge target,
  else the face under the pointer via the skin's ancestry; points/edges hidden behind the skin are not picked
  through it (cage-only display: nothing is hidden). Hover lights what a click would take. Escape clears.
- Fix found by the capture: depth was measured from the camera position, which is wrong for the Model
  screen's orthographic camera (front points read as hidden); now measured along the pointer ray.

### Stage 3 - Topology tools and symmetry - DONE at 30ecc1e21 (captures), merged with main at 4baf48649

- Insert edge loop across the ring of the selected edge (closed rings, open ends, stops at n-gons, creases
  carried), Crease / Uncrease (selected edges and the rims of selected faces), Mirror X / Mirror Y: paired
  points follow the moved side, seam points stay on the plane, extrude / loop / crease act on the mirror too.
- Captures (stage3/, `node src/tests/evidence/FORM/shoot.mjs 3`, real mouse + rail clicks; opened): 01 a click on
  an edge + Insert loop -> 32 faces, the new loop selected; 02 the top cap of a cylinder creased -> flat top with a
  sharp rim (smooth view); 03 Uncrease -> rounded again; 04 Mirror X, a +X corner pulled up by the gizmo -> its -X
  partner follows as its mirror.
- Tests: src/tests/form/topologyTools.test.ts (12): rings (closed, into an n-gon cap, open plane), crease carried
  on both halves, crease targets, pairing + seams, symmetrize, mirrored selection, store-level mirrored move /
  extrude / loop / crease, and "without symmetry the partner stays put".
- Display button "Cage + smooth" renamed "Both" (it clipped on the rail - architect's note); tooltip explains.

### Stage 4 - Finish Form -> body -> CAM - PROVEN at e928b1bd9

- The finished form is the faceted kernel body of stage 1R (a model body, not an STL row: that is what the
  ruling's "body in the model tree" needs); it reaches CAM as a format:'model' row (modelbody:FRM1) like any
  Model body.
- Captures (stage4/, `node src/tests/evidence/FORM/shoot.mjs 4`; opened): 01 the knob formed (cylinder cage,
  middle ring swelled 1.25x through the Form store's move - the path the gizmo drives - bottom cap creased flat);
  02 Finish -> Knob body in the Model tree (33,689.72 mm^3); 03 Show in CAM -> Setup with a setup made in the New
  Setup modal and a 6 mm / 2 mm stock margin typed into the Auto Stock properties; 04 both toolpaths on the knob;
  05 the roughing selected (top view); 06 the finishing selected (front view).
- Measured (stage4/stage4-toolpaths.json): Adaptive Rough (3D), 6 mm flat: ready, 9,564 moves (4,189 cutting),
  cut Z 14.2..28.3, computed in ~44-54 s; Parallel Finish (3D), 3 mm ball: ready, 3,249 moves (3,039 cutting), cut
  Z 13.5..29.2. Below Z ~14 the knob tucks in under its swell (an undercut no 3-axis cutter reaches from above);
  the roughing's "Reach: stopped short" badge says so.
- Learned on the way (not changed, for the operator): with the default stock (exactly the part's box) the Adaptive rough
  refuses: "refusing a straight plunge through remaining stock at (-14.97, -14.97) ... helix radius 0.065 below
  the 0.200 minimum" - the only material is the corner slivers of the box. With a stock margin it generates.
  That refusal is in the adaptive engine, not the form; worth a CAM work order (rule 11: the corner slivers are
  open to the outside, a side entry could reach them).
- Not done by mouse: the bottom cap (it faces the table) was selected through the Form store's select() - the
  call a click makes - and the two tools were added with the tool library's own addTool.

### Stage 4b - booleans / cuts on a form body - PROVEN at c21738aa7

- No source change: a form body is an ordinary kernel body, so the Model screen's Boolean takes it as target
  and as tool. This stage is proof only (`node src/tests/evidence/FORM/shoot.mjs 4b`, scenario in stages.mjs).
- Captures (stage4b/; opened): 01 a sphere starter scaled to r = 8 and centred at z = 34 over the knob's top
  (form mode, named "Dimple"); 02 Finish -> two form bodies (FRM1 Knob, FRM2 Dimple) in the Model tree; 03 Boolean
  dialog (target FRM1, tool FRM2, Cut - picked from its "Choose from lists" selects) -> "Boolean F1", ONE body, the
  thumb dimple visible in the knob's top; 04 Show in CAM -> New Setup -> Parallel Finish (3D) 3 mm ball through the
  New Operation modal, the finishing path running down into the dimple.
- Measured (stage4b/stage4b-boolean.json): knob 33,689.72 mm^3 -> 33,634.34 mm^3 after the cut (only the sphere's
  lower cap reaches into the knob's crown); Boolean in 14.7 s; finish ready, 3,321 moves (2,981 cutting), cut Z
  14.2..28.9 (the knob alone: 3,249 moves, up to Z 29.2 - the dimple lowers the crown).
- Not done by mouse: the sphere's scale and lift went through the Form store's select + move (the path the gizmo
  drives); the 3 mm ball was added with addTool. The Boolean, Setup and Operation were driven through their UI.
- Display after the cut (stage4b/03): the knob's own facet edges stay hidden (no wireframe on the body), the
  dimple's rim draws as an edge, but the dimple's floor shows a dense line hatch - its facets (the tool's faces
  inside the result) are drawn as edges. Not fixed here: which ids the Boolean gives the tool's faces decides
  whether formEdges.ts sees them as form facets; worth a look if the operator wants the dimple as clean as the knob.
- Not proven: a Join or Intersect with a form body (only Cut was run); a form body as a Push/Pull, Fillet or
  Shell target (a faceted body has hundreds of faces; those tools were not tried).

### Stage 4b (operations) - the Model tools on a form body - PROVEN (captures stage4b-ops/)

Scenario `node src/tests/evidence/FORM/shoot.mjs 4b-ops` (stages.mjs stage4bOps): a formed knob, then each
tool as its dialog writes it into the model history (a DAG feature node, then the same replay), chained on the
previous result; a failed op is removed again so the next one has a live body. Table from
stage4b-ops/stage4b-ops.json (exact body, 73 faces):

| Operation | Result | Time | Volume after |
|---|---|---|---|
| Extrude join: a 8 mm dia shaft sketched on the knob's flat bottom | works | 2.1 s | 34,120.81 mm^3 |
| Fillet 1.5 mm: the form's OWN creased rim (form edges) | works | 2.1 s | 34,094.35 mm^3 |
| Hole: 3 mm x 10 deep in the shaft end | works | 2.4 s | 34,023.66 mm^3 |
| Extrude cut: a 4 mm grip slot across the crown | works | 2.6 s | 33,735.04 mm^3 |
| Push/Pull: the slot floor 1 mm deeper | works | 3.6 s | 33,605.64 mm^3 |
| Fillet 0.5 mm: the slot rim (slot walls against the form's B-spline faces), after the Push/Pull | works | 8.7 s | 33,601.94 mm^3 |
| Fillet 1 mm: the shaft root (planar extrude against the form's flat bottom) | works | 2.5 s | 33,607.64 mm^3 |
| Chamfer 0.5 mm: the shaft end | works | 2.9 s | 33,604.63 mm^3 |
| Chamfer 0.3 mm: the hole rim | works | 2.8 s | 33,604.18 mm^3 |
| Shell 1.5 mm on the whole part (after its fillets), open at the shaft end | FAILS with a plain reason that now names the working order (stage 7: the grip slot is the cause, not the fillets) | 144 s | - |
| Shell 1.5 mm on the same part WITHOUT the grip slot (stage 7, captures stage7/) | works | 58.7 s | 7,769.53 mm^3 |
| Shell 1.5 mm on the plain exact knob, then fillet its rim (32 edges) | works (kernel test) | 2.9 s + ~2 s | - |
| Boolean: knob minus another form (stage4b/) | works | 14.7 s (faceted) | 33,634.34 mm^3 |

ROOT CAUSE of the two "never finishing" cases (Architect 4:55 AM ask), evidence in stage4b-ops/run-log.txt:
- Slot-rim fillet after the Push/Pull: it never was a hang. My capture runner (a) selected the slot FLOOR
  edges too (z > 20.5 caught the pushed floor at z = 25: a mixed concave/convex set the kernel refuses, as it
  does in the kernel test - "radius too large" in 0.4 s), and (b) waited for the error on the DAG node, where
  it never lands: a failed feature is 'failed' in the regen scheduler (scheduler.statusOf / diagnosticsOf).
  So it waited out its 600 s. With the rim selected and failure read from the scheduler, the fillet WORKS
  in-app after the Push/Pull (8.7 s). No product change needed.
- Shell on the whole finished part: it fails with a plain reason, in the kernel worker, after ~70 s (the
  engine tries MakeThickSolid, then its WO-2107 shell-by-construction fallback). Kernel tests pin the cause:
  Shell fails on the exact knob as soon as ANY fillet blends its plane against its B-spline faces (0.5 mm and
  2 mm rim fillets, walls 0.4 and 1.5 mm, 1, 2 or 3 knot spans, offset tolerance 1e-6 / 1e-4 / 1e-3: all fail;
  a filleted BOX shells fine; the unfilleted knob shells fine). OCCT's thick-solid offset cannot offset those
  rolling-ball blend surfaces. Workaround that works: Shell first, then fillet (tested). Not fixed here.
  CORRECTED BY STAGE 7: those kernel probes failed for another reason (see Stage 7); fillets on form faces
  shell. The part's real blocker is the grip slot cut across the crown.
- Separate observation for the desk fix round (not touched here, per the Architect): after that Shell failure
  the page's main thread stays busy ~80-90 s more (no animation frame for 4 x 20 s, then a frame) - the kernel
  is in a worker, so this is page-side work after the failed op; it is what holds the Model screen.

- WO-2121 fix round 1 (measured, stagehold-before/): while that Shell runs, every kernel call, a second
  operation and Undo's rebuild wait on it (the kernel is one worker; rebuilds queue); switching screens still
  works. Now the status strip offers "Cancel operation" once a kernel call has run 2 s: it kills the worker,
  undoes the change whose rebuild is running (suppresses it when there is nothing to undo), starts a fresh
  worker and rebuilds the model. Proven in the app (stagehold/): back in 26 s, same volume, kernel answers.
- Captures (opened): 01 from below - shaft, hole with its chamfer, shaft-end chamfer, root fillet, and the
  filleted form rim as a rounded band; 02 from above - the grip slot across the crown with its filleted rim
  ("Slot rim fillet" in the tree); 03 front - the part.
- On the FACETED body (before stage 5) the same ops worked but slowly: extrude join 263 s, hole 275 s, cut
  280 s (measured while a kernel build shared the 4 cores).
- The slot-rim fillet defect (FIXED by the kernel stack build, below), measured in the kernel (vitest, real occt-wasm) on the shipped kernel: the fillet returns ok, then the
  next call (any call - an import) fails "memory access out of bounds". Fillets on the uncut knob's rim, on
  plane/plane edges of the same cut body, and on a box-minus-box body leave the kernel healthy; a single-span
  B-spline (no interior knots) and a STEP re-import of the cut body (no history) both still corrupt it. So it
  is the kernel's fillet on a plane/B-spline edge, and the likeliest cause is a C-stack overflow (no
  -sSTACK_SIZE in xtask/src/build.rs: 64 KB default). The fix is a link flag and a rebuilt vendored kernel.
- Not done by mouse: the ops went in as DAG nodes (the dialogs' own record shape), not through their dialogs.
  Sketches were inserted the same way (no sketch UI driven).

### Stage 5 - exact CAD solid - WORKS (the slot-rim fillet needs the 8 MB stack kernel, pinned on this branch)

- src/form/exact.ts: the limit surface as bicubic Bezier patches after 3 refinement steps (Loop & Schaefer 2008
  rules, extended to sharp creases: sector valence on crease points, crease curves as edge points). A patch
  whose 4 corners are ordinary (valence 4, or a regular crease point) IS the limit surface: checked against one
  more subdivision step to 1e-9 mm. Around an extraordinary point the patch is an approximation: within
  0.1 mm of the surface along its normal on a 40 mm part, and neighbouring patches meet within 2 degrees of
  tangent there (exact-to-exact joins: 1e-4 degrees). Shared edge and corner points make the patches meet
  exactly (watertight by construction). A creased flat region stays exactly flat.
- src/form/exactStep.ts: the patches of each first-level quad joined into ONE bicubic B-spline surface (C1:
  interior knots of multiplicity 2 - exact, because every join runs through ordinary points where the corner
  lies midway between its neighbours), flat quads merged into true PLANE faces, boundary curves shared from the
  same control points on both sides, written as an AP214 MANIFOLD_SOLID_BREP.
- src/form/formBody.ts buildFormBody: STEP text -> the kernel's importStep (ids FRMn:step:face#i) -> volume
  check against a coarse tessellation (a gross failure falls back) -> the faceted body when the exact one
  cannot be built, with an info diagnostic naming the surface and the reason.
- Why STEP and not the new binding the brief asked for: the kernel's STEP reader already builds exact
  B-spline faces and computes their pcurves; this needs no occt-wasm rebuild and no vendored-binary change,
  and a STEP export then carries the surfaces unchanged. (The kernel rebuild now running is only for the
  stack-size fix, not for Form.)
- Measured: knob / sphere / box read back as ONE solid, volume within 2e-4 of a 0.002 mm tessellation; knob 73
  faces (72 B-spline + 1 plane), 1-2 s. Fillet 2 mm along the knob's creased rim: ok, 1.4 s, -95 mm^3 (hand
  estimate 97). Shell 1.5 mm open at the bottom: ok, 2.9 s (it failed with C0 surfaces - the knot fix). STEP
  export: 72+ B_SPLINE_SURFACE_WITH_KNOTS entities.
- Display: the exact body's smooth seams between faces are hidden, its creases and cut edges drawn
  (formEdges.ts now also knows FRMn:step:face ids and compares the two named faces' triangles at the edge).
- The Form palette lost its "Tolerance" row (the exact body has no chord; the faceted fallback keeps the
  payload's default). The Form help topic now describes Form inside the Model screen and the exact body.
- Not proven yet: G1 at extraordinary points (up to 2 degrees
  kink - the operator's eye on a zebra/reflection look when one exists); a form with a dart or 3+ creases at a point
  (approximated patches, not measured); Edit Form on an exact body re-finishing (same replay path, not
  captured).

### Gap tools built (after the gap list) - Loop, Ring, Delete, Fill hole, Bridge, Thicken, Soft

- src/form/topoTools.ts + formStore actions + two rail sections (Select: Loop, Ring; Openings: Delete, Fill
  hole, Bridge, Thicken) + palette rows (Soft radius; Thicken wall, shown while the form has an opening):
  - Loop: the edge loop of each selected edge, straight on through ordinary points (stops at a point with 3
    or 5+ edges). Ring: the edge ring across the quads.
  - Delete: removes the selected faces (and their mirrors with symmetry on); unused points go too.
  - Fill hole: caps the open loop through the selected rim edge with one n-sided face.
  - Bridge: joins two faces with the same side count by a tube of quads (a hole through / a handle);
    genus goes up by one (Euler characteristic 2 -> 0 checked).
  - Thicken: an open form gets an inner skin `wall` inside along the point normals, joined at every open
    edge with a creased rim; the result is closed and finishes as an exact solid.
  - Soft: points within the radius of the selection follow a move with weight 1 - 3t^2 + 2t^3 (t =
    distance / radius); symmetric with Mirror on; one undo step.
- Every tool keeps the cage oriented and is one undo step; the bridged box (genus 1) and the thickened
  plane read back as ONE exact solid (kernel test).
- Captures (stage5/, `node src/tests/evidence/FORM/shoot.mjs 5`; opened): 01 Loop selects 12 edges right
  round a 3x3x3 box; 02 Bridge top-to-bottom: a hole through the cage; 03 Finish -> "Ring block", an exact
  body (212 B-spline/plane faces, no wireframe); 04 a plane domed up and Thickened 3 mm (closed, creased
  rims); 05 both exact bodies in the tree.
- Tests: src/tests/form/openingTools.test.ts (12). Negative controls: loop through any point, delete
  keeping unused points, fill hole / bridge wound the wrong way, thicken without rim creases, soft
  weights ignored - each goes red (the loop's valence check was redundant with its "exactly one way
  straight on" rule and was removed).

### Kernel: an 8 MB C stack - BUILT AND PINNED on form/subd (separate commits 9f41d62c2 + 57e5986b6)

- The slot-rim fillet defect (Stage 4b ops) is fixed by one link flag, -sSTACK_SIZE=8388608
  (patches/occt-wasm-3.6.1-stack-size.patch). Built in the sandbox (no Docker): OCCT + the facade at the
  pinned commits with the three existing patches (A) and then the flag (B).
- Proof (src/tests/evidence/FORM/kernel-stack/README.md): shipped and A corrupt the heap after the
  slot-rim fillet; B gives the identical fillet (22,112.947 mm^3) and a healthy kernel. The JS glue of all
  three is token-for-token identical; only the .wasm differs.
- Equivalence, same tests on both kernels (WO-1892's slice - src/tests/geom/ + the WO-114 store test -
  plus src/tests/form/): shipped 82 files / 623 tests all green; stack build 83 / 635 all green (12 more
  form tests written between the runs).
- vendor/occt-wasm/occt-wasm-3.6.1-geo9-iges-history-stack.tgz (the history tarball with the new .wasm and
  the updated NOTICE), package.json pin + comment, package-lock (path + sha512); `npm ci` installs it.
- For the desk / the operator: this is a vendored-kernel change. The two commits can land with the Form work or
  be dropped on their own (then the slot-rim fillet case - a fillet between a cut wall and a B-spline face -
  corrupts the kernel until reload, as it does on main today for any B-spline body, e.g. an organic STEP
  part).

### Stage 6 - From body, crease weights, mirror through Edit, display level - READY TO LAND (on top of WO-2121)

- From body (src/form/fromMesh.ts; rail "From body"; SolidsWorkbenchPage passes the selected body's
  tessellation and a hide-through-the-eye callback): the body selected in the Model tree (or the only body)
  becomes a cage - merged points, one cage face per flat face (its boundary loop), curved faces as their
  triangles, edges between faces meeting at more than 30 degrees creased. A box comes back as itself (volume
  18,000.000 mm^3 exact); a cylinder within 10% (a subdivision surface sits inside its cage); a notched box
  within 2%. The source body is hidden while shaping and after Finish (Bodies-list eye, undoable). Never
  refuses: an open body gives an open form. Captures stage5b/: 01 the extruded block as a cage (8 points, 6
  faces, 12 creases), 02 its top edges uncreased - the skin rounds over, 03 "Soft block" exact body (21 faces),
  the Block hidden.
- Crease weights (subdivide.ts, DeRose et al. 1998): a weight s keeps an edge sharp for s subdivision steps
  (a fractional step blends smooth and crease rules; a point on 2+ weighted edges blends by their average),
  halves inherit s - 1. Palette row "Crease weight" (0 = fully sharp, the old behaviour); Crease uses it,
  Uncrease clears. Weights ride through insert loop, extrude, delete, thicken and the payload. The exact
  solid resolves weights up to 3 before its patches, so ordinary patches stay exactly the limit (1e-9).
  Captures stage5c/: a cylinder with a sharp top rim (27,066.70 mm^3) beside one with a weight-1 rim
  (26,291.82 mm^3), both exact bodies.
- Mirror through Finish -> Edit: the payload carries `symmetry`; Edit turns it back on; a new form starts
  without; a mirror switched off is dropped from the payload.
- Smooth-skin display level: palette "Smooth" 0 = automatic, 1..5 (capped at 4x the automatic budget),
  display only.
- Tests: src/tests/form/ 11 files, 102 passed (formFromBody 3, creaseWeights 7, openingTools +2, exactSolid
  split: exactSolidSlotFillet in its own file). Negative controls: flat faces not merged / no creases /
  points not merged (from body); edge rule not blended / sharpness never used up / point rule not blended
  (weights); symmetry not stored / not restored; requested level ignored - every one red.
- Shared files touched this round: SolidsWorkbenchPage.tsx (the useFormSession call gains selectedBodyMesh
  and hideBody; the form-edit visibility term also hides the From-body source while form mode is open; one
  import), src/tests/model3d/SolidsWorkbenchPage.rawBodyConsumerCensus.test.ts (the new live-filtered body
  lookup classified), src/help/topics/modeling/index.ts (torus, From body).

### Stage 7 - Shell on form parts - READY TO LAND (9b258d2ce, 98c1a9d14, evidence 2bbea0943)

Architect 8:10 AM item 2 ("Shell after fillets on form faces fails"). Measured in the kernel (vitest, real
occt-wasm) and in the app. The fillets were never the cause:
- Every shell of a part with a boss was refused. MakeThickSolid rounds the wall where it turns round a
  re-entrant edge (a boss on a plate, the shaft on the knob) with a cylinder or torus face that none of its
  evolution channels reports, so applyShell refused it as untraceable (GEO-4-R1.4). A plain box with a
  round or square boss failed the same way; this was not specific to forms. Fix (src/geom/worker/stable-id.ts
  nameShellBlendFaces, geom-engine.ts #nameShellBlends, both shell routes): name each blend by the faces whose
  inner walls it joins, sorted like a pattern's merged face: `<fid>:SHL:blend:(A|B)` (`#j` for two blends on the
  same faces; a blend touching only blends takes the union of theirs; a face with no named neighbour still
  refuses). docs/stable-id-spec.md gains the row.
- A blind hole in the opened face sent Shell to the WO-2107 construction, which gave up. offsetWire2D applies a
  floor edge's placement a second time: the grown outline of a hole floor made by extruding a sketch came back
  a hole-depth (10 mm) away, so the wall prism missed the hole and the cavity cut into it (the retained-face
  check then refused). Fix (#shellConstructionCavity): put the outline back on the floor's plane.
- After both fixes, in the kernel: knob + shaft + rim fillet + root fillet + end chamfer + 3 mm blind hole
  shells (about 30 s). Knob + shaft + rim fillet + Hole feature + grip slot does NOT shell. Knob + any slot
  (across the crown or inside it) does not shell either, with no fillet on it, in about 1 s. MakeThickSolid
  cannot offset the B-spline faces a plane cut trims. The same slot cut into the SHELLED knob works.
- Route for the user: Shell on the pre-fillet solid, then re-apply the fillets (the WO-2086/2107 pattern
  suggested), was built and tried. It cannot help, because the solid beneath the fillets carries the slot
  and fails too, so it was removed again. The failure message now names what works: "... Offsets stop where
  a cut trims form faces (FRM1); Shell the form before that cut, then cut - that order works." This appears
  only on the MakeThickSolid failure of a body that has form faces plus faces from later features. It is the
  existing refusal with a sentence added; the tripwire is CLEAR.
- In the app (the real Model history, `node src/tests/evidence/FORM/shoot.mjs 7`, stages.mjs stage7; opened):
  the stage 4b part without the grip slot, Shell 1.5 mm open at the shaft end: works, 58.7 s, 34,025.87 ->
  7,769.53 mm^3. 01 from below: the shaft end is a solid ring round the hole. 02 front. The 4b-ops re-run
  (stage4b-ops/, opened): the whole part's Shell fails in 144 s with the new sentence.
- For the operator's eye: in stage7 the hollow inside the knob is SEALED. The 3 mm hole plus its two 1.5 mm walls
  (6 mm) is wider than the shaft's 5 mm inner opening, so the hole's wall fills the opening. That is what
  those dimensions give; a larger shaft or a thinner wall leaves it open. Also: the slot-first Shell is
  refused; Shell-then-cut opens the slot into the cavity (a different part).
- Tests: src/tests/form/shellFormPart.test.ts (4, real kernel): a plate with a round boss / a square boss
  shells and each blend is named from the plate underside and a boss side, identically twice; the stage 4b part
  (no slot) shells and keeps every hole face; knob + slot fails with the sentence, and Shell-then-cut works.
  Negative controls: blend naming off -> the two boss tests red (2 / 4; the knob part goes through WO-2107,
  which names its walls by distance); outline drift not corrected -> the stage 4b part test red; the sentence
  off -> the slot test red. `npx vitest run src/tests/form` + the engine's shell / stable-id / alias suites
  (25 files): 269 passed. `npx tsc -b` clean, eslint clean, tripwire (merge base) CLEAR.
- Shared files touched: src/geom/worker/geom-engine.ts (the blend naming in both shell routes, the outline
  drift, the sentence), src/geom/worker/stable-id.ts (nameShellBlendFaces), docs/stable-id-spec.md (one row),
  src/tests/evidence/FORM/stages.mjs (buildOpsPart takes withSlot; stage7).
- Not proven: shells of non-form parts with bosses beyond the plate tests and the existing shell suites (all
  green). Pipe along a sketch curve (item 1) is next.

### Stage 8 - Pipe along a sketch curve - READY TO LAND (94391e64a, 44d0400b0, evidence bbe091c84)

- src/form/pipe.ts:
  - sketchPaths turns a sketch's lines, arcs, circles, ellipses, elliptical arcs and splines (construction
    geometry left out) into 3D chains. Pieces meeting end to end are joined in running order, whatever order
    or direction they were drawn in, and the sketch plane places them. Longest first.
  - pipeCage puts rings of 8 points round the chain on rotation-minimising frames (double reflection). A
    circle closes into a ring. An open chain gets one cap face per end with its rim creased, so the ends are
    flat and crisp.
  - Two corrections make the smooth skin land where asked. The ring radius is padded by 3 / (2 + cos(2 pi /
    8)), because a ring's limit curve sits inside it. Each column of cage points along the path is solved
    (Jacobi) so its cubic B-spline passes through the ring points. Without the second, a thick ring came out
    4% thin and the first in-app S pipe 12% thin.
  - defaultPipeRadius: a twelfth of the curve's length, at most 0.6 x its tightest bend, 0.5 to 10 mm, to the
    half millimetre. The cage is scaled like any other afterwards.
- Pipe on the Form rail (useFormSession: startPipe, the deps gain selectedSketchPath). SolidsWorkbenchPage
  passes the longest curve of the package sketch selected in the tree (planeFrameOf + sketchPaths). With no
  sketch it builds a straight 60 mm pipe and the notice says Pipe follows a selected sketch; it never refuses.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 8`, stages.mjs stage8; opened): two package sketches go
  into the model history. One is an S (a line, a half turn, a half turn back, a line) listed out of order
  with pieces reversed; the other is a circle. Each is selected in the tree, then Form -> Pipe -> Finish.
  - 01: the S cage, 96 points, 90 faces, 16 creased rim edges, radius 6.
  - 03: the ring cage, 64 points.
  - 04: both exact bodies: S 352 B-spline + 2 plane faces, 11,508.78 mm^3 (the ideal pi r^2 L is 11,626;
    the inside of each bend is shorter); ring 256 B-spline faces, 31,988.10 mm^3 (a torus: 32,066).
- Tests: src/tests/form/pipe.test.ts (7; one real kernel):
  - chaining out of order and reversed, construction skipped; a circle closed on its plane;
  - straight pipe: radius within 0.05 mm, volume within 2%;
  - a ring and a thick ring (13 rings round) within 2% of the torus;
  - a rounded L: every tube point within 0.25 mm of the radius from the curve (worst 0.035);
  - a straight pipe reads back as one exact solid with 2 flat faces.
  Negative controls, each red: no reversal when joining (1 of 7 red); no radius padding (4); no column solve
  (1); faces wound inward (3); cap rims not creased (3).
  `npx vitest run src/tests/form src/tests/help`: 161 passed, 2 red (helpHotlinks.wo413, ProbingPanel - red on
  main). The hub tests naming the Form session / raw body census: 25 passed. tsc clean, eslint 0 errors,
  tripwire CLEAR.
- Shared files touched: SolidsWorkbenchPage.tsx (one import, the selectedSketchPath dep - 7 lines),
  src/help/topics/modeling/index.ts (Pipe sentence), src/tests/evidence/FORM/stages.mjs (stage8).
- Not proven: 3D (non-planar) paths - sketches are planar, so a closed path never comes back twisted; the pipe
  radius is set only through scaling (no palette row); self-intersecting tubes (a radius larger than a bend)
  are prevented only by the default radius.

### Stage 9 - Insert point, Subdivide, Weld - READY TO LAND (888a7087c, 976e114a0, evidence 283a3ff37)

- src/form/topoTools.ts:
  - splitEdges puts a point in the middle of each edge, in every face using it. A creased or weighted edge
    leaves two creased or weighted halves.
  - subdivideFaces turns each face into one quad per corner round a new centre point. The faces beside it
    gain the edge middles, so no point hangs on an edge and the cage stays closed.
  - weldPoints merges points at their centroid. Faces drop repeated corners; a face left with fewer than
    three corners goes; creases and weights follow.
  - Welding an edge's two ends collapses it into triangles. Welding two open sheets point to point along
    facing sides stitches them into one.
- Form store: insertPointOnSelection (selected edges; the new points are selected), subdivideSelection
  (selected faces, with symmetry; the new quads are selected), weldSelection (the selected points and the
  corners of selected edges and faces). Rail: Topology gains Insert point, Subdivide, Weld.
- With nothing fitting selected each one says what to select (the pattern Delete / Bridge use). A result the
  cage cannot hold (for example a weld that pinches the surface) is caught by applyCage's validator, as for
  every topology tool. Tripwire CLEAR.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 9`, stages.mjs stage9; rail buttons clicked; opened):
  - 01: box 2x2x2, the top face at x > 0, y < 0 subdivided (31 points, 27 faces), its centre point raised
    15 mm;
  - 02: Insert point on the two back top edges (33 points), then Weld on the bottom-front edge from
    x = -20 to 0 (32 points);
  - 03: "Peaked block" exact body, 114 B-spline faces, 51,647.13 mm^3.
- Tests: src/tests/form/pointTools.test.ts (6): split edge with creases and weights; subdivide keeps the cage
  closed and outward; weld collapses an edge; weld stitches two sheets; weld needs two points; the store
  actions select what they made. Negative controls, each red: the middle not put into the faces (3 of 6);
  crease halves dropped (1); repeated corners kept after a weld (2); subdivided quads wound backwards (2).
  src/tests/form: 18 files, 131 passed. tsc clean, eslint 0 errors.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: weld by distance (a tolerance would merge nearby pairs; here a weld merges what is selected into
  one point, so stitching is pair by pair).

### Stage 10 - Mirror Z and circular symmetry - READY TO LAND (dc7e54a35, 1e9103325, evidence 79b268951)

- src/form/symmetry.ts, generalised:
  - A symmetry is a mode: 'x' / 'y' / 'z' (a mirror) or `c<N>` (N copies round the Z axis, 2..24). A mirror
    plane can sit off zero (symmetryAt).
  - Every point is matched with its images under the mode's transforms. A moved point's group follows it:
    the operator's pick wins, then (mirror) the + side, else the lowest index. Seam points stay on the plane
    or axis.
  - Selections widen to all images. partner = images[0] keeps the mirror API.
- Mirror Z mirrors across the plane through the form's mid-height, recorded when it is switched on. Starters
  sit on the table, so Z = 0 would be useless. The height is kept in the payload (symmetryAt) and restored
  on Edit.
- Circular turns on with the palette's copies when the form fits that many, else with the most copies the
  form fits (so the 8-sided cylinder gets 8, not the default 6 with every point alone). The palette shows a
  "Circular ... copies" row while it is on, and changing it re-applies. Clicking an active button turns
  symmetry off (clear).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 10`, stages.mjs stage10; rail and palette used; opened):
  - 01: cylinder, Circular on (8), copies set to 4 in the palette, one middle-ring point pulled 8 mm out:
    4 points at 28 mm, 20 at 20 mm, a four-lobed knob.
  - 02: "Lobed knob" exact body, 80 faces, 28,471.92 mm^3, payload symmetry 'c4'.
  - 03: a box (the knob hidden by its Bodies-list checkbox) with Mirror Z at Z = 20: its top corner moved
    (+6, -6, +12) to (26, -26, 52) and its mirror followed to (26, -26, -12).
- Tests: src/tests/form/symmetryModes.test.ts (8):
  - circular groups on an 8-segment cylinder (8 / 4 / 2 fit, 3 does not);
  - one point's seven copies follow as rotations;
  - a face widens to 8;
  - an axis point stays on the axis;
  - Mirror Z at mid-height through the store;
  - payload and Edit restore mode and plane;
  - Circular picks a fitting count and toggles off;
  - an extrude with circular symmetry extrudes all copies and keeps the form symmetric.
  Negative controls, each red: rotation not applied (4 of 7); mirror plane position ignored (1); selection
  widened by one image only (2); axis points not held (1); payload drops the plane (1); no fitting count
  (1 of 8). src/tests/form: 139 passed. tsc clean, eslint 0 errors.
- Tripwire: "held on the plane" matched its hold/gate words once this round rewrote those notice lines. They
  now say "stay on the plane / axis"; the tripwire is CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).

### Stage 11 - Zebra stripes - READY TO LAND (cbb058dc5, 92e14adf1, evidence a5626b1e2)

- Display Mode flyout (WorkbenchDisplayMode) gains a "Zebra stripes" checkbox, after the projection radios. It
  is optional like projection (other callers unchanged) and sits inside the existing sanctioned flyout: no new
  floating surface. State: the page's `zebra` (display only, not saved).
- src/lib/viewport/lighting/zebra.ts: every modeled-body material (createModeledBodyMaterial: Model bodies,
  STL bodies, CAM viewport bodies, the Form skin) carries the stripe code from the start, switched by its own
  uniform.
  - Stripes are bands of the reflected view direction (view space, 12 per half-turn, anti-aliased with
    fwidth). They follow the camera so rotating the view reveals surface continuity.
  - The hook is one shared function, not a closure per material, so every body material compiles the same
    program text. Toggling flips a uniform: no recompile, no new program.
  - The vertex-AO patch chains onto it; its 'geo23-ao' cache key is unchanged (tested).
- The page sets each body material's stripes in the per-body repaint loop. The Form session gets `zebra` in
  its deps and sets the skin's.
- Found and fixed on the way (src/form/formOverlay.ts): the Form skin was first drawn before its geometry had
  a normal attribute. three.js compiled its program with per-triangle (flat) normals from screen-space
  derivatives and kept it after the normals arrived. So the smooth skin was lit faceted (subtle when shaded);
  the zebra showed it as blocks. The skin geometry now has position and normal attributes from construction.
  Diagnosed in the app: a forced recompile cleaned it; the depth offset and the normals themselves were ruled
  out.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 11`, stages.mjs stage11; flyout clicked; opened). The
  stage 10 lobed knob (cylinder, Circular 4, one point pulled 8 mm), exact body:
  - 01 shaded;
  - 02 zebra;
  - 03 zebra from above;
  - 04 zebra from the front;
  - 06 perspective, close over the top cap's centre (valence 8): a small star in the stripes, the kink;
  - 07 close over a top-rim point (valence 3): clean;
  - 05 the Form skin with zebra while editing (Edit from the tree): smooth, no star.
  No shader error in the console.
- Tests: src/tests/lib/zebra.test.tsx (8): the stripe code is in every body material and off, and comes after
  three's final colour; setZebra flips the bound uniform without a material version change; two materials
  share the hook and program text; the AO patch chains and keeps its key; a plain material is left alone; the
  flyout offers and reports the toggle, and omits it for other callers; the Form skin has normals before its
  first draw. Negative controls, each red: factory without zebra (3 of 7); a closure per material (1); stripes
  before the final colour (1); no flyout row (1); skin without early normals (1 of 8).
- Suites: src/tests/form plus displayModes, vertexAO.ui86, bodyVisualStyle, CNCViewport.modelBodyDisplayMode,
  SolidsWorkbenchPage.ui17Kernel, SceneRuntime.ui84R1, depthSafeBodyEdges, overlayAttachGuard (both),
  viewportCanvasFollowsTheme.wo346, rawBodyConsumerCensus: 31 files, 252 passed. overlayRuntimeCensus's
  OVERLAY-RUNTIME-KEYS.md drift is red without these changes too (main). tsc clean, eslint 0 errors,
  tripwire CLEAR.
- Shared files touched: src/lib/viewport/lighting/bodyVisualStyle.ts (the factory installs the stripe code),
  new src/lib/viewport/lighting/zebra.ts, src/components/model3d/workbench/WorkbenchDisplayMode.tsx (optional
  row), SolidsWorkbenchPage.tsx (zebra state, one call in the repaint loop, the flyout props, the Form dep),
  src/form/formOverlay.ts.
- Not done: stripe direction and count controls; zebra on preview ghosts; curvature display.

### Stage 12 - Grow, Shrink, All - LANDED on main as WO-2149 (a92145816, 77a9a1f5e, evidence a35892c3e)

- src/form/topoTools.ts:
  - growSelection adds one ring. Faces gain every face sharing a corner (one topological ring), so one face
    becomes its 3 x 3 block. Points gain their edge neighbours; edges gain the edges sharing an end.
  - shrinkSelection removes whatever touches the unselected rest. A face on the form's open border stays when
    all its neighbours are selected, as in Blender; shrink narrows the selection, not the form.
  - selectAll takes every element of the kind selected: every face by default, or when kinds are mixed.
- Form store growSelection / shrinkSelection / selectAll replace the selection and say what is selected
  ("Grown to 9 faces", "Selected all: 96 faces"). Rail: the Select section gains Grow, Shrink and All.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 12`, stages.mjs stage12; rail buttons clicked; opened).
  A 4 x 4 x 4 box, one front face picked:
  - 01: 1 face;
  - 02: Grow twice, 24 faces (the second ring wraps over the box's top edge);
  - 03: Shrink once, back to the 3 x 3 block (9);
  - 04: All, 96.
- Tests: src/tests/form/selectionTools.test.ts (6): face grow / shrink round trip on a 6 x 6 sheet; points;
  edges; shrinking a lone face empties it, and grow / shrink of a whole closed form changes nothing; select all
  by kind; the store's notices. Negative controls, each red: faces grow from one corner only (2 of 6); shrink
  keeps every face (3); select all always faces (1); points never grow (1). src/tests/form: 20 files, 145
  passed. tsc clean, eslint 0 errors, tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: a Ctrl+A keyboard shortcut in form mode (the rail button is
  there).

### Stage 13 - G1 at star points - READY TO LAND (675e90fa5, 8cf9748ff, evidence d66c4678f)

- Measure first (src/form/exact.ts seamAngles on the Bezier patches; src/form/g1.ts extraordinarySeamDeg on the
  B-spline faces as written):
  - The faces round an extraordinary point meet with ONE tangent plane at the point (1e-6 deg). Loop and
    Schaefer's edge points there lie in the limit tangent plane.
  - The kink runs along the first span of each boundary leaving it: 2.40 deg at valence 8, 0.48 deg at
    valence 5, 0.51 deg at valence 3, 0 elsewhere.
  - More refinement shrinks it only slowly: valence 8 gives 3.39 / 2.40 / 1.73 / 1.25 deg at levels 2-5.
    Levels are no fix.
- Why there. exactStep writes one C1 bicubic B-spline face per first-level quad, and every extraordinary
  point sits at a corner of those faces. Inside a face the surface is C1 by its representation; across the
  face boundaries leaving the point, the two faces' cross-boundary derivatives do not lie in one plane.
- Fix (src/form/g1.ts g1AtExtraordinary, called by formStep before writing):
  - Only the poles one row in from those boundaries move, over the first 2 spans. The poles are those of the
    written surface: span-join poles are the implied midpoints.
  - At 10 samples per span along each boundary: N . D_A = N . D_B = 0, with N the mean of the two faces'
    normals. This is least squares, linear with N frozen and re-solved 10 times.
  - A pull toward the original poles (1e-6 of the largest cross derivative squared) keeps the shape.
  - Untouched: boundary curves (watertight), creases (over 20 deg), boundaries already G1 (flat regions),
    regular faces.
  - FormStep reports g1BeforeDeg / g1AfterDeg / g1MoveMm / g1SurfaceMoveMm.
- Tuning measured on the lobed knob (valence 8), kink after the pass and how far the surface moved:

  | Pull | Kink after | Surface moved | Note |
  |---|---|---|---|
  | 1e-4 | 0.25 deg | 0.06 mm | |
  | 1e-5 | 0.054 deg | 0.11 mm | |
  | 1e-6 | 0.018 deg | 0.135 mm | chosen |
  | 1e-8 | 0.010 deg | - | poles moved 1.07 mm |
  | 1e-10 | - | - | blows up |

  3 spans instead of 2 changed nothing that mattered.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 13-before` with the pass switched off in the source for
  that run only, then `... 13`; zebra and perspective from the flyout; opened):
  - 01: close over the lobed knob's valence-8 cap centre; the star is gone;
  - 02: a valence-3 rim point, clean in both;
  - 03: the whole knob;
  - 04 / 05: a 5-sided cylinder's valence-5 cap centre and the whole cylinder.
  Finish times: in this file's git history (the stage 13 LATEST block).
- Tests:
  - src/tests/form/g1.test.ts (6): valence 8 / 5 / 3 each start over 2 / 0.4 / 0.4 deg and end under 0.05 /
    0.01 / 0.005 deg, with the surface moving under 0.2 mm; a torus (no extraordinary point) is untouched;
    the lobed knob and the 5-sided cylinder read back in the kernel as ONE closed solid within 5e-4 of the
    limit surface's volume.
  - shellFormPart: the slotted knob shells at 1.5 mm and fails at 3 mm with the sentence; Shell-then-cut
    works.
  - Negative controls (on g1 + shellFormPart + exactSolid): no solver iterations -> 4 red; creases not left
    alone -> 6 red; no pull -> the blown-up solid stalls the kernel (the run hit its 25-minute limit).
  - src/tests/form: 21 files, 151 passed. tsc clean, eslint 0 errors, tripwire CLEAR.
- Shared files touched: none outside src/form and the Form tests / evidence.
- Not done: exact G1 (see the fix round below); G2 / curvature continuity at star points.


Fix round (WO-2150 audit), from the LATEST block of 2026-09-28 ~4:45 PM CT:

- STAGE 13 FIX READY TO LAND (WO-2150 audit, Architect 3:55 PM). SHA 6f3829414, on top of 675e90fa5 /
  8cf9748ff / d66c4678f. The audit was right on both counts:
  - Creases now come from the cage's flags: exactSurface.sharpEdges, carried to face sides by formStep. They
    are never guessed from the angle.
  - The report (extraordinarySeamDeg) counts every smooth boundary with no 20 deg cutoff. It had been hiding
    kinks: a 32-segment cylinder's valence-32 cap centre is 29.3 deg before the pass, which the old report
    dropped as a "crease".
  - The pass now weights each sample so its residual is an angle. A per-point guard puts that point's poles
    back if the pass would change a crease's angle (tolerance 0.01 deg) or leave a smooth boundary there
    worse.
  - Holding the crease poles fixed (the audit's first option) was built and measured. It changed nothing:
    at every creased point in these cages the guard reverted the point either way. It was removed (its
    control did not bite). Points on a crease keep Loop and Schaefer's surface.
- Measured on 6f3829414. Each row: kink before -> after (deg), surface moved (mm), crease angle change (deg),
  kernel volume error vs the limit surface, and the same volume error with the pass off (main's surface):

  | Case | Kink | Moved | Crease | Volume error | Pass off |
  |---|---|---|---|---|---|
  | lobed knob | 2.349 -> 0.0152 | 0.145 | 0 | 7.2e-5 | 6.2e-5 |
  | 5-sided cylinder | 0.474 -> 0.0067 | 0.019 | 0 | 1.3e-4 | 1.3e-4 |
  | box | 0.510 -> 0.0003 | 0.006 | 0 | 5.8e-5 | 5.9e-5 |
  | stage 4b knob (creased bottom rim) | 2.439 -> 0.0152 | 0.144 | 0 | 4.5e-5 | 3.8e-5 |
  | box, one creased edge (audit) | 4.875 -> 4.8747 | 0.006 | 0 | 5.7e-5 | 5.8e-5 |
  | cylinder, creased sides (audit) | 2.439 -> 2.4173 | 0.144 | 0 | 6.8e-5 | 5.3e-5 |
  | 32-segment cylinder | 29.30 -> 0.2248 | 0.585 | 0 | 1.3e-4 | 3.5e-5 |
  | 32-segment, creased sides (audit) | 29.30 -> 3.129 | 0.585 | 0 | 1.3e-4 | 3.4e-5 |

  - No folds: every crease angle change is 0.
  - The creased cases improve only away from the creases; their creased points stay as before (box 4.87 deg
    at the crease end).
  - The 32-segment volume error rises from 3.5e-5 to 1.3e-4. That is the 0.585 mm correction of a 29 deg kink,
    still well inside the 5e-4 the tests allow.
  - The knob result is kept (0.015 deg; 0.018 on 675e90fa5). The stage13/ captures were shot on 675e90fa5;
    the lobed knob has no crease, so they stand.
- Tests (src/tests/form/g1.test.ts, 11):
  - The three audit cages: creases keep their angle (under 0.01 deg); smooth boundaries end no worse; the
    surface moves no more than the same cage uncreased.
  - The valence-32 kink shows in the report (over 20 before, under 1 after).
  - The creased box reads back as one solid within 5e-4 of the volume.
  - Negative controls: guard off -> 3 red; the report guessing creases from a 20 deg angle -> 1 red; the new
    test file on the audited sources (675e90fa5) -> 4 red.
  - src/tests/form: 21 files, 156 passed. tsc clean, eslint 0 errors, tripwire CLEAR.

### Stage 14 - Weld close (weld by distance) - READY TO LAND (d480c95b4, 1b2deaf56, evidence d5f9e9cb5)

- src/form/topoTools.ts:
  - weldByDistance takes candidates (every point when none are given) and a distance. Points within the
    distance of one another, directly or through a chain, become one point at their centroid. It returns null
    when no two points are that close.
  - weldGroups welds several groups in one step. weldPoints now goes through it; the stage 9 weld tests are
    unchanged and pass.
- Form store:
  - weldDistance (default 1 mm) and setWeldDistance (clamped at 0).
  - weldCloseSelection welds among the selected points (and the corners of selected edges and faces), or
    across the whole form when nothing is selected. It selects the merged points and is one undo step.
  - Notices: "Welded N groups of close points in the form (M points fewer)", or "No two points ... are within
    D mm; raise Weld distance to join them".
  - A result the cage cannot hold goes to applyCage's validator, as for every topology tool. For example, two
    sheets touching at one point is a pinch.
- Rail: Topology gains Weld close. Palette: a Weld row, "mm apart", always shown.
- Decisions:
  - Chained clusters, not pairs. Two open sheets 1 mm apart stitch in one click, and a row of points closer
    than the distance collapses as one.
  - The distance is inclusive (<=).
  - With nothing selected the whole form is the candidate set (Blender's Merge by Distance on everything).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 14`, stages.mjs stage14; palette typed into, rail button
  clicked; opened). A 2 x 2 x 2 box (26 points, 24 faces):
  - 01: its nine top points scaled to 1 % (0.2 mm apart), Weld set to 0.5 in the palette;
  - 02: Weld close with nothing selected. 18 points, 20 faces, 8 triangles round one apex. Notice "Welded 1
    group of close points in the form (8 points fewer)"; the apex is selected;
  - 03: "Welded apex" exact body, 72 B-spline faces, 30,524.44 mm^3.
  No console errors. The grey mark over the apex in 02 and 03 is the viewport's world Z-axis label; the apex
  sits on the Z axis.
- Tests: src/tests/form/weldClose.test.tsx (8):
  - two sheets 1 mm apart stitch in one step: 12 -> 9 points, 12 -> 8 open edges, merged points on the seam;
  - 0.99 mm and a plain box give null;
  - only the candidates weld when some are given;
  - a chain 0.8 + 0.8 mm (ends 1.6 apart) welds as one group at 1 mm;
  - store with nothing selected: 3 groups, the notice, the selection, one undo;
  - store with points selected: only the selected pairs;
  - too small a distance: the notice, the cage untouched;
  - the palette row sets the distance Weld close uses.
- Negative controls (each mutation applied to the committed source, the file run, the source restored and
  compared byte for byte). Red of 8:
  - distance ignored: 7;
  - candidates ignored: 3;
  - pairs only, no chaining: 1;
  - first group only: 3;
  - store ignores the selection: 1;
  - palette row sets nothing: 1.
  Two controls did not bite on the first test draft. The first no-chain mutation still chained, so it was
  replaced by a sharper one. No store test used a selection, so one was added.
- src/tests/form: 22 files, 164 passed. `npx tsc -b` clean. eslint 0 errors (1 warning in useFormSession.ts,
  also there without this change). Tripwire CLEAR on d480c95b4.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: Unweld (split a point or an edge back open); a preview of what Weld close would join.

### Stage 15 - A form from a sketch profile (Extrude / Revolve) - READY TO LAND (87be60579, 0e7724a4e, 46dba4728, 2a8571ac0; evidence 33f1946db, 41bb0f550)

- src/form/profile.ts:
  - sketchProfile: the sketch's longest closed curve, else its longest curve. Pipe's sketchPaths does the
    chaining, in sketch coordinates.
  - sampleProfile:
    - corners (a turn over 25 deg) are always samples; an open profile's ends count as corners;
    - between corners the samples are even, 48 round the whole profile.
  - interpolateProfile: each run between corners is solved (Jacobi, as for Pipe's columns). The skin's
    cross-section, a cubic B-spline of the cage points, then passes through the samples. A profile with no
    corner is solved all the way round.
  - extrudeProfileCage:
    - rings along the sketch normal, 2 to 32 of them at about the sample spacing; a negative height goes
      the other way;
    - a closed profile gets flat caps with creased rims. A cap is one n-gon when every corner sees the
      centroid, else ear-clipped triangles (a U shape);
    - corner columns are creased; an open profile makes an open sheet.
  - revolveAxis: the first construction line the profile does not cross, else the sketch Y axis, else X,
    else a line along Y at the profile's left edge. The notice names the one used.
  - revolveProfileCage:
    - 16 round, the ring radius padded by 3 / (2 + cos(2 pi / 16)) (a ring's limit curve sits inside it);
    - corner rows creased;
    - points on the axis weld into poles (weldByDistance), so a half outline closes into a solid;
    - faces flip outward when the enclosed volume comes out negative.
- Form store: profileHeight (default 20 mm; 0 or not a number falls back to 20). Palette: an Extrude row,
  "mm tall", always shown.
- Rail, Form - start from: Extrude and Revolve, after Pipe. With no sketch selected they build a default
  profile (a 40 mm circle / a 10 x 10 square beside Z, a ring) and the notice says a selected sketch is used
  when there is one. They never refuse. Like the starters, they replace the cage (one undo step) and show a
  From-body source body again.
- Hub: SolidsWorkbenchPage.tsx gains the selectedSketch dep (6 lines, beside selectedSketchPath): the
  selected package sketch's name, entities and plane frame. Help: the Form topic gains two sentences.
- Decisions:
  - Revolve is a full turn only. Angle, segment count and a picked axis edge are later.
  - The height applies when Extrude is clicked. It is not live; the cage scales afterwards like any form.
  - 48 samples round the profile, not 24. At 24 the interpolating cross-section rippled 0.12 mm along the flat
    sides of a rounded plate (a line meets an arc by tangent, a curvature jump the cubic overshoots); at 48
    it is 0.03 mm (96: 0.009). The price is a denser cage (the vase: 482 points).
- Measured (src/tests/form/profileForms.test.ts; skin volume from the tessellated surface at 0.02 mm):
  - circle r 20 x 30: volume -0.07%, radius error 0.0002 mm;
  - 40 x 20 rectangle x 10: exact volume, 4 corners;
  - U shape: exact volume, triangulated caps;
  - rounded plate 50 x 30 (r 8): under 0.05 mm of the profile (0.03);
  - half disc revolved (a sphere r 20): volume -0.47%, equator within 0.024 mm, 2 poles;
  - washer 10..20 x 10: volume -0.05%;
  - square round a construction line: Pappus within 1%.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 15`, stages.mjs stage15; tree rows, the palette and the
  rail clicked; opened). Two package sketches: a 50 x 30 plate with 8 mm rounded corners on XY, and half a
  vase on XZ (foot, bulge arc, neck, lip, closed along the sketch Y axis).
  - 01: plate extruded 12 mm (height typed in the palette). 240 points, 194 faces; "0 corners creased",
    since tangent arcs are not corners.
  - 02: vase revolved round the sketch Y axis (model Z). 482 points, 496 faces, 64 creased edges, 2 poles.
  - 03: both exact bodies.
    - Plate: 768 B-spline + 2 plane faces, 17,333.77 mm^3 (ideal 17,340.7: -0.04%), 21 s to finish in
      this sandbox.
    - Vase: 1,472 B-spline + 2 plane faces, 55,483.54 mm^3, 22 s. The sketch outline lies on its silhouette.
  - 04 / 05: vase zebra, whole and close over the top. Stripes run on across the bulge and neck. The pole
    sits in the flat lip, so no star.
  - 06: plate zebra close over a rounded corner. The corner's stripes are smooth. On the flat side walls the
    stripe edges are jagged. The surface there is within 0.03 mm of flat (measured); the jag was not traced
    further (display tessellation normals are the likely cause, unproven).
  - One console error in the run: "3D geometry engine initialization failed (attempt 1 of 3) ... timed out
    after 30000ms". The retry succeeds, and it is in the run logs of stages 1R, 2, 4, 4b, 5, 7, 8 and 13
    too, so it is this sandbox's Chromium, not this change.
- Tests:
  - src/tests/form/profileForms.test.ts (9): the measurements above, plus an open arc giving an open sheet
    and axis choice.
  - src/tests/form/profileFormSession.test.tsx (3), through useFormSession's rail tools with a selectedSketch
    dep: Extrude from a sketch on Z = 7 runs 7 -> 19 with the palette's 12 mm, then undoes in one step;
    Revolve names its axis and 2 poles; with no sketch both build and say how to use a sketch.
- Negative controls (the committed source mutated, both files run, restored and compared byte for byte). Red of
  11 (12 once the plate test was added):
  - no cross-section solve: 1;
  - no revolve radius pad: 3;
  - corners not kept: 6;
  - corner columns not creased: 3;
  - one n-gon cap always: 1;
  - poles not welded: 2;
  - no outward flip: 3;
  - negative height ignored: 1;
  - construction axis ignored: 1;
  - palette height ignored: 1.
  - The plate test on 24 samples: red (0.126 mm).
- src/tests/form: 25 files, 177 passed (with the stage 14 and select-all files). `npx tsc -b` clean. eslint 0
  errors on every changed file (the hub file's 281 warnings are there without this change). Tripwire CLEAR.
  src/tests/help: 38 passed; 2 red in helpHotlinks.wo413 (ProbingPanel has no HelpLink), red without this
  change too and off limits here.
- Shared files touched: SolidsWorkbenchPage.tsx (selectedSketch dep), src/help/topics/modeling/index.ts.
- Not done: a partial revolve angle; the segment count round a revolve (fixed at 16); a live height; loft and
  sweep of a profile; caps as quads (a U cap is triangles).

### Stage 16 - Unweld - READY TO LAND (03d77ffff, evidence 8223869c9, 5625807fb)

- src/form/topoTools.ts:
  - unweldEdges cuts the cage open along edges that have two faces; other edges are ignored. At each point on
    the cut, its face fan splits into sides, separated by cut edges and open borders. Each side past the first
    gets its own copy of the point, at the same place.
    - A closed loop of edges separates the form.
    - An open chain becomes a slit; its end points stay joined.
    - A chain that reaches an open border cuts through to it.
    - A lone edge inside the form has nothing to open (null).
    - Creases and weights follow onto both sides.
  - regionBorder: the edges between a face set and the rest.
- Form store unweldSelection:
  - it cuts along the selected edges plus the border of the selected faces, so faces are cut free;
  - it selects the opened edges (both sides) and is one undo step.
  - Notices:
    - "Unwelded: the 4 selected faces cut free (8 points doubled)";
    - "Unwelded: 2 edges opened (1 point doubled)";
    - with nothing selected: "Select edges (a chain, or a loop) or faces to unweld";
    - with nothing to open: "Nothing to open there: edges open along a chain of two or more, or where they
      reach the form's open border".
- Rail: Topology gains Unweld (after Weld close).
- Decisions:
  - Selected points are not unwelded. Splitting a point into one copy per face would tear a star-shaped hole;
    edges and faces say where the cut runs.
  - The copies are not moved apart; the operator moves either side. Keeping them in place
    preserves the surface until the operator separates the copies.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 16`, stages.mjs stage16; rail button clicked; opened):
  - 01: a 2 x 2 x 2 box, its four top faces cut free (34 points: 8 doubled) and lifted 12 mm. The lid is a flat
    sheet over an open box, and the palette shows Thicken now the form is open.
  - 02: a 4 x 4 x 4 box, a two-edge chain down the middle of its front face unwelded (1 point doubled, 99
    points). The two copies of the middle point are pulled 6 mm apart: a lens-shaped slit.
  - No console errors.
- Tests: src/tests/form/unweld.test.ts (7):
  - a ring round a box: 8 doubled, 16 open edges, two pieces, nothing moved;
  - a chain inside a face: a slit, 1 doubled, still one piece;
  - a lone edge and border-only edges: null;
  - border to border on a sheet: two sheets;
  - creases and weights on both sides;
  - store: faces cut free, the notice, the selection, undo;
  - store: both notices.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  7:
  - cut edges do not separate sides: 5;
  - creases not carried to copies: 1;
  - weights not carried: 1;
  - the face border taken inside out: 2;
  - one copy shared by every extra side: 4;
  - store selects nothing after: 1.
- src/tests/form: 26 files, 184 passed. `npx tsc -b` clean. eslint clean on the changed files. Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: unwelding single points; a gap option (moving the two sides apart as they open).

### Stage 17 - Flatten and Straighten - READY TO LAND (0e6d88fe8, evidence 478cdcc22, be122c3d8)

- src/form/shapeTools.ts:
  - principalAxes: the centroid, and the covariance's eigenvectors by Jacobi rotations.
  - flattenPoints puts the points on their least-squares plane: through the centroid, normal the least-spread
    axis. It needs three points.
  - edgeChains sorts selected edges into open chains (walked end to end), closed loops and branching sets.
  - straightenChains:
    - each open chain goes onto the line between its ends, each point at its share of the chain's length;
    - branching sets and selected loose points go onto their best-fit line, keeping their order;
    - closed loops are counted, not moved (a loop has no two ends).
  - Both report `before`: how far the farthest point was off.
- Form store:
  - flattenSelection: the selected points plus the corners of selected edges and faces.
  - straightenSelection: the selected edges and points.
  - Both keep symmetry: the moved points go through symmetrize, as a drag does. Each is one undo step.
  - Notices:
    - "Flattened 25 points onto their plane (the farthest was 6.40 mm off it)";
    - "Straightened 1 line, 3 points moved (the farthest was 8.00 mm off)", plus "; 1 closed loop left as it
      was (Flatten makes a loop planar)" when loops came along;
    - loops only: "A closed loop has no two ends to run a line between; Flatten makes it planar";
    - nothing fitting: "Select three or more points (or a face, or edges) to flatten" / "Select a chain of
      edges (or three or more points) to straighten".
- Rail: Edit form gains Flatten and Straighten (after Move / Rotate / Scale).
- Measured before -> after (src/tests/form/flattenStraighten.test.ts and a one-off run):
  - Flatten, a 4 x 4 x 4 box with its top domed (inner nine up 4 mm, the centre 8):
    - cage: 6.40 mm -> 1e-16 off the plane;
    - skin over the inner region (|x|, |y| <= 10): 4.18 mm -> 1e-14;
    - the plane is the least-squares one (z = 41.6, the mean).
    - Toward the rim the skin still rounds over the box's uncreased edges: 11.3 mm below the plane at 19 mm
      out, before and after. That is the box's rounding, not the dome. Crease the rim to keep a face flat to
      its edge.
  - Straighten, the front face's middle column bent out 3 / 6 / 8 mm:
    - cage: 8.00 mm -> 0 off the line;
    - skin down the middle of the face: 4.66 mm -> 4e-15.
    - In the app the points land at z 0 / 13.25 / 19.99 / 30.34 / 40, their shares of the bent length. They
      are not re-spaced evenly; preserving spacing avoids redistributing features along the line.
  - A tilted, noisy 16-point sheet: back on one plane, normal within 0.5 deg of the true one.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 17`, stages.mjs stage17; rail buttons clicked; opened):
  - 01: the domed top, its 16 faces selected;
  - 02: after Flatten (all top points at z = 41.6);
  - 03: the bent column's four edges selected;
  - 04: after Straighten.
  - No console errors. The first shoot had a scenario bug: its second lift looked the point up in the stale
    cage and moved nothing. It was caught by the notice (2.56 mm, not 6.40), fixed and re-shot.
- Tests: src/tests/form/flattenStraighten.test.ts (9):
  - the dome (cage and skin);
  - the tilted noisy plane;
  - three points needed;
  - chain onto its line at the length shares;
  - the skin down the straightened face;
  - loose points onto their line in order;
  - loops counted and not moved (loops alone give null);
  - store Flatten with Mirror X: the -X images follow; the notice; undo;
  - store Straighten notices.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  9:
  - plane normal = the widest axis: 2;
  - no eigen rotations: 1;
  - straighten by projection, not length share: 1;
  - loose points ignored: 1;
  - loops walked as open chains: 2;
  - Flatten ignores symmetry: 1.
- src/tests/form: 27 files, 193 passed. `npx tsc -b` clean. eslint clean on the changed files. Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done:
  - Flatten onto a chosen plane (an axis plane or a picked face); today it is always best-fit;
  - Make Uniform (even spacing);
  - Pull to points / surface.

### Stage 18 - Insert loop at a chosen position - READY TO LAND (f51a54ee1, evidence 367e34366, 86743c89c)

- The problem found first: insertEdgeLoop took `t` from each ring edge's lower-NUMBERED point. At 0.5 that
  never showed. At any other value the loop would zigzag, because point numbering flips side from quad to
  quad.
- src/form/edgeLoop.ts:
  - ringSides walks the ring outward from the start edge's `from` end. Across each quad (entry p-q, exit s-r)
    p pairs with s and q with r, along the quad's sides. Every ring edge thus gets its end on the same side
    of the ring.
  - insertEdgeLoop(cage, start, t, from) cuts each ring edge at t from that end. Without t / from it is the
    middle, as before; the existing loop, crease and weight tests are unchanged and pass.
- Form store:
  - loopPosition, default 0.5, kept to 0.01..0.99 (0 or 1 would put a point on a point; not a number falls
    back to 0.5).
  - insertLoop measures from the selected edge's lower end: lower Z, then -Y, then -X when level. Each
    symmetry image is measured from its image of that end, so mirrored and circular loops stay images of one
    another.
  - Notice: "Inserted an edge loop (8 edges) at 0.2 of each edge from the selected edge's lower end". It is
    unchanged at 0.5.
- Palette: a "Loop at ... of each edge" row, always shown. The fraction is typed; the architect said "slider /
  typed fraction", and this is the palette's NumericInput with its step arrows. It applies to the next Insert
  loop, not live.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 18`, stages.mjs stage18; palette typed into, rail button
  clicked; opened):
  - 01: a 2 x 2 x 2 box, Loop at 0.2, a lower front vertical edge. All 8 new points at z = 4. The smooth
    bottom visibly tightens.
  - 02: "Tight bottom" exact body, 53,652.31 mm^3. Bottom edge sharper than the top.
  - 03: a new box with Mirror X, Loop at 0.25, an X-direction top edge at +X. 16 new points at x = +5 and -5.
  - No console errors.
- Tests: src/tests/form/loopPosition.test.tsx (5):
  - on a box with its points renumbered by a fixed shuffle, 0.25 from either end: every new point at z = 5
    (or 15);
  - no position: the middle;
  - the palette row sets it and the loop lands at z = 4 from the lower end, even with the edge key's first
    point the upper one; the notice;
  - Mirror X: loops at -5 and +5;
  - the clamps.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  5:
  - side not carried round the ring: 3;
  - from ignored: 2;
  - mirror measured from its own lower end: 1;
  - store ignores the position: 2;
  - upper end taken for lower: 1;
  - palette row sets nothing: 1.
  - The first mirror mutation (the image edge's lower-numbered end) did not bite: with this numbering it
    happened to be the seam point. It was replaced by the real wrong rule (the image edge's own -X end),
    which bites.
- src/tests/form: 28 files, 198 passed. `npx tsc -b` clean. eslint clean on the changed files. Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: a live slider that moves the just-inserted loop; picking which end to measure from (0.3 from one
  end is 0.7 from the other, so it is not needed to reach any position).

Fix round (WO-2163 audit): 07b6d8ced + evidence 53ea2470e. An edge crossing the mirror plane (its own mirror
image, ends swapped) now gets both loops, at t and 1 - t. Details in the LATEST block of 2026-09-28 ~6:45 PM CT
(this file's history).

### Stage 19 - Delete edges - READY TO LAND (3c6c26439, evidence f410388de, 6d7ccd730)

- src/form/topoTools.ts dissolveEdges merges the two faces beside each edge into one.
  - The group's outline is walked from its faces' directed edges, the deleted ones left out.
  - Edges with one face (an open border) are left.
  - A group whose outline is not one simple loop is left as it was and counted (skipped).
  - A point of a deleted edge left with two edges, both with two faces (not on an open border), is removed.
    Its two edges become one, creased when both were and weighted with the smaller weight when both were. So
    deleting an edge loop removes the whole loop.
- Form store deleteSelection:
  - faces selected (or nothing): Delete faces, as before;
  - only edges: dissolve them, mirrors included (the effective selection).
  - Notices:
    - "Deleted 16 edges: the faces either side merged; 16 points left between two edges removed";
    - border edges only: "Nothing to delete there: an edge on the form's open border has only one face (Delete
      faces opens the form)".
- Rail: the Openings section's Delete calls deleteSelection; its tooltip says what it does with edges.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 19`, stages.mjs stage19; rail Loop and Delete clicked;
  opened):
  - 01: a 4 x 4 x 4 box, one edge at z = 20 picked, Loop: 16 edges round the box.
  - 02: Delete. 98 -> 82 points, 96 -> 80 faces, all quads; the sides are three segments tall.
  - 03: one top edge deleted: 79 faces, one hexagon.
  - 04: "Fewer loops" exact body, 262 faces, 60,252.95 mm^3.
  - The run log has the sandbox's first-attempt engine timeout (see stage 15); the retry worked.
- Tests: src/tests/form/deleteEdges.test.ts (6):
  - the middle loop of a 2 x 2 x 2 box: 8 edges, 8 points; closed; 18 points, 16 faces, side quads full
    height;
  - one top edge: a hexagon, no point removed;
  - a sheet: border edges alone give null; its middle line merges the quads and removes the centre point but
    not the border ends;
  - a creased column stays one creased edge after its middle point goes;
  - store: the loop and its notice; undo; Mirror X takes the mirror edge (the centre point goes, two
    pentagons); faces still open the form;
  - store: the border-only notice.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  6:
  - points between two edges kept: 4;
  - creases not joined across a removed point: 1;
  - deleted edges kept in the outline: 5;
  - points on an open border removed too: 1;
  - store drops the mirror: 1;
  - store sends edges to face delete: 2.
- src/tests/form: 29 files, 204 passed. `npx tsc -b` clean. eslint clean on the changed files. Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done: deleting points (dissolve a point into one face).

### Stage 20 - Bridge two edge loops / face sets - READY TO LAND (d0ba1dc52, 2d3749dfb, evidence 2a3793463, db7294007)

- src/form/bridgeLoops.ts (new):
  - openLoops reads the open borders through given edges as chains. Each runs the way a new face beside it
    must: against the one face each edge has. Branch points end a chain.
  - bridgeOpenings joins two chains, both closed or both open.
    - B is reversed along the band. A closed B is turned to line up with A (least total distance; nearest
      start when the lengths differ).
    - The band is `segments` rings long; the rings between are placed by share of length.
    - Quads when the two have as many points; else a zip of triangles by share of length.
    - Null for one closed with one open, a shared point, or under two points.
  - faceSets: the connected sets of a face selection.
  - bridgeFaceSets removes two face sets and bridges the openings they leave. Points only those faces used go.
    Null when a set's outline is not one closed loop.
  - The old bridge(cage, faceA, faceB) stays and its tests pass. Bridging two single faces now goes through
    bridgeFaceSets, the same result.
- topoTools.ts: compactWithMap is exported (bridgeLoops uses it).
- Form store bridgeSelection:
  - faces selected: exactly two connected sets; edges selected: exactly two open chains. It selects the
    band and is one undo step.
  - bridgeSegments, 1 to 32, default 1.
  - Notices:
    - "Bridged the two face sets (4 and 4 faces) with 16 faces, 2 segments long";
    - "Bridged the two openings (4 and 8 edges round) with 20 faces, 2 segments long (12 triangles where the
      two differ in length)";
    - otherwise it says what to select, or why the two cannot be joined (one closed and one open; a band with
      two outlines).
- Palette: a "Bridge ... segments" row, always shown. The rail's Bridge tooltip says what it takes.
- Decisions:
  - Unequal loops are zipped with triangles rather than refused. The software can do it (rule 11), and a
    triangle is a valid Catmull-Clark face.
  - Symmetry is not applied to Bridge; select both sides' sets to bridge them.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 20`, stages.mjs stage20; palette typed into, rail clicked;
  opened):
  - 01: a 4 x 4 x 4 box, the top's and bottom's middle 2 x 2 faces, Bridge segments 3. 112 points, 112 faces:
    a square hole through.
  - 02: "Hole through" exact body, 388 faces, 43,865.29 mm^3.
  - 03: a new box, the top's middle 2 x 2 and one bottom face deleted, both rims' edges selected, segments 2.
    20 faces, 12 of them triangles: a tapering hole.
  - The run log has the sandbox's first-attempt engine timeout; the retry worked.
- Tests: src/tests/form/bridgeLoops.test.ts (9):
  - face sets top / bottom: closed, 8 quads, 2 points gone, Euler 0 (a hole through), outward volume, no twist
    (every band quad's sides run straight down);
  - 3 segments: rings at z = 13.33 and 26.67;
  - faceSets;
  - the rims as selected edges: the same hole;
  - openings of 8 and 4: 12 triangles, closed, outward;
  - two open borders: one sheet, 12 open edges;
  - closed with open: null;
  - store with faces: notice, selection, undo, the 1-set notice, nothing selected, the segments clamp;
  - store with edges: the unequal notice.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  9:
  - B not reversed along the band: 7;
  - closed B not lined up with A: 1 (the no-twist check);
  - unequal loops forced into quads: 2;
  - segments ignored: 3;
  - open borders read the way their face runs: 8;
  - removed faces' points kept: 3.
- src/tests/form: 30 files, 214 passed. `npx tsc -b` clean. eslint 0 errors (the old useFormSession warning).
  Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done:
  - a twist control for the band;
  - a curved (tangent-following) band; the rings are straight between the two;
  - Bridge with symmetry.

Stage 20 fix round (WO-2164 audit): 5bfd28c55. Face sets on open forms, and lone faces, bridge again: the outline
comes from the set's own faces (see the LATEST block of 2026-09-28 ~7:20 PM CT in this file's history).

### Stage 21 - Curvature display - READY TO LAND (ed5eecafc, evidence a9ea2b1f9, d546ca14b)

- src/lib/viewport/lighting/zebra.ts: the shared body-material hook gains a second switched uniform, uCurv.
  It is installed with the zebra one on every createModeledBodyMaterial material (Model bodies, the STL body,
  CAM viewport bodies, the Form skin).
  - Per pixel, curvature = how fast the view-space normal turns per mm of surface. That is |dFdx(n)| /
    |dFdx(p)| and the same in y, averaged over the two screen directions: 1 / radius on a sphere, about the
    mean curvature elsewhere.
  - It is coloured on a log ramp. Blue is radius 200 mm or more (CURVATURE_FLAT_MM), red is radius 3 mm or
    less (CURVATURE_TIGHT_MM), with five stops at 200 / 70 / 24 / 8.6 / 3 mm. It is written after three's
    final colour, so the pixel is the ramp colour itself.
  - With zebra on too, the stripes darken the colours (x 0.3 in the dark bands).
  - The GLSL ramp is generated from the same CURVATURE_STOPS the legend and the tests use.
  - One program for every body material; toggling flips the uniform, with no recompile and no version change.
  - setCurvature / curvatureOn, curvatureRampT, curvatureColor and CURVATURE_LEGEND_MM are exported.
- Display Mode flyout (WorkbenchDisplayMode.tsx): an optional "Curvature" checkbox after Zebra stripes. While
  it is on, a legend shows: a gradient bar, "200+ 70 24 8.6 3-" and "radius, mm". Other callers are
  unchanged.
- SolidsWorkbenchPage.tsx:
  - `curvature` state plus curvatureRef (the STL creation path);
  - setCurvature beside every setZebra (the body repaint loop, the STL body twice), and the deps;
  - the flyout props, and the Form session dep.
- debugSceneCensus.ts classifies curvature / curvatureRef as transient, as zebra is. The state census is red
  without it; I checked.
- useFormSession: the Form skin follows `curvature` as it follows zebra.
- Measured in the app (`node src/tests/evidence/FORM/shoot.mjs 21`, stages.mjs stage21).
  - Setup: two exact spheres made in the app (half discs of radius 20 and 6 on XZ, revolved, finished).
    Curvature was switched on in the flyout; "Shaded, no edges" was set so the face-boundary lines do not
    cover the samples.
  - Method: the rendered pixels (5 x 5 median) at five points on each sphere were read back and turned into
    a radius through the ramp.
  - Radius 20: read 18.7 / 20.2 / 20.3 / 20.5 / 20.5 mm.
  - Radius 6: read 5.6 / 6.0 / 6.1 / 6.1 / 6.2 mm.
  - Within 7% everywhere; worst channel differences 13 and 11 of 255.
  - GPU control: the estimate doubled in the shader (source restored after, captures re-taken on the right
    source) reads 148 and 113 off.
  - Two sample points were moved while building the check, so they sample the surface itself:
    - lon 0 sat under the sketch's diameter / axis line, which is drawn over the bodies;
    - the view target's pivot mark sat on the first sample.
- Captures (opened):
  - 01: the flyout with the legend;
  - 02 / 03: each sphere from the front;
  - 04: both spheres.
  - The radius-20 sphere shows green-yellow, the radius-6 one orange, as the ramp says.
  - Seen, not fixed: faint latitude banding on the large sphere (the +-7% scatter above), and a small star at
    each revolve's pole (16 faces meet there; thin display triangles make the estimate noisy).
- Tests: src/tests/lib/curvature.test.tsx (7):
  - the shader code present, off, after the final colour, with the ramp from the stops;
  - setCurvature flips its own uniform only, with no recompile, and one program text;
  - a plain material is left alone;
  - the ramp ends, its log middle, the legend radii;
  - the flyout row, the toggle, the legend only while on, and no row for other callers;
  - the Form skin carries it.
  - src/tests/lib/zebra.test.tsx (8) unchanged and passing.
- Negative controls (the committed source mutated, the files run, restored and compared byte for byte). Red of
  15:
  - no curvature block: 1;
  - setCurvature writes the zebra uniform: 2;
  - shader ramp not from the stops: 1;
  - not installed on body materials: 2;
  - ramp linear in radius: 1;
  - no legend: 1.
  - The state census without the new rulings: 2 red.
- Suites: src/tests/form 30 files / 215 passed. Display, overlay and census suites (21 files): 361 passed and 1
  red, overlayRuntimeCensus OVERLAY-RUNTIME-KEYS.md drift. That one is red with the flyout reverted to its
  pre-stage-21 source too, as stage 11 recorded. tsc clean, eslint 0 errors, tripwire CLEAR.
- Shared files touched:
  - src/lib/viewport/lighting/zebra.ts;
  - src/components/model3d/workbench/WorkbenchDisplayMode.tsx (optional row + legend);
  - SolidsWorkbenchPage.tsx (state, 4 call sites, deps, props, the Form dep);
  - src/components/model3d/debugSceneCensus.ts (2 rulings);
  - src/components/model3d/form/useFormSession.ts.
- Not done:
  - Gaussian versus mean choice;
  - an adjustable ramp range;
  - per-face exact curvature from the kernel (this is a screen-space estimate of the displayed mesh).

Stage 21 fix round (architect picture check): 9fd9f2348, 1239d7f53, 9593e7ec2. Curvature is now a per-vertex value
from the mesh's own normals (exact on spheres and cylinders, view-independent). The Form spheres' bands are their
real curvature (see the LATEST block of 2026-09-28 ~8:35 PM CT in this file's history).

### Stage 22 - Make uniform - READY TO LAND (b00bd407d, evidence bc346fa66, de7aadaae)

- src/form/shapeTools.ts makeUniform relaxes the given points toward the average of their neighbours, 20
  times at half strength. Each move is kept in the point's tangent plane (the Newell point normal), so
  spacing evens out without the form flattening or shrinking.
  - Points on an open border or a crease stay: they hold the outline and the sharp edges.
  - Points not given stay.
  - edgeLengthSpread (the spread / mean of the edge lengths touching the points) is reported before and
    after.
- Form store makeUniformSelection works on the selection (points and the corners of edges and faces), or on
  the whole form when nothing is selected. It keeps symmetry (symmetrize) and is one undo step.
  - Notice: "Made 25 of the form's points uniform: edge length spread 0.28 -> 0.00 (points on the open border
    or on creases stay)".
  - When nothing can move it says so.
- Rail: Edit form gains Uniform (after Flatten / Straighten).
- Measured:
  - a 6 x 6 sheet, inner points pushed up to 4 mm in its plane: spread 0.28 -> 0.00, back on the grid,
    still in its plane, border untouched;
  - a quadball sphere (4 per side), points pushed up to 3 mm along its surface: spread 0.31 -> 0.11, skin
    volume within 1.5%.
    - A quadball is uneven by nature near its cube corners, so 0 is not the target there.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 22`, stages.mjs stage22; rail button clicked; opened):
  - 01 / 02: the Plane starter (6 x 6) jumbled, then Uniform: an even grid again.
  - 03 / 04: the Sphere starter (4 per side) jumbled, then Uniform.
  - No console errors on the second run. The first run's scenario dragged 98 points one by one and a
    screenshot timed out; the scenario now applies the jumble as one cage update.
- Tests: src/tests/form/makeUniform.test.ts (6):
  - the sheet (spread, plane, border, grid);
  - the sphere (spread, volume);
  - creased points and points not given stay;
  - nothing to move: null;
  - store: whole form, notice, undo, Mirror X kept and an unselected neighbour untouched;
  - store: the nothing-to-move notice.
- Negative controls (the committed source mutated, the file run, restored and compared byte for byte). Red of
  6:
  - move not kept in the tangent plane: 1;
  - border points move too: 4;
  - creased points move too: 1;
  - no iterations: 3;
  - store ignores the selection: 1;
  - store ignores symmetry: 1.
  - "Store ignores the selection" did not bite on the first draft (a box's points are in balance). An
    unselected neighbour of the pushed point is now checked.
- src/tests/form: 31 files, 221 passed. `npx tsc -b` clean. eslint clean on the changed files. Tripwire CLEAR.
- Shared files touched: none (Form's own files and stages.mjs).
- Not done:
  - a strength / iterations control;
  - sliding border and crease points along their own curves;
  - pull to points / surface.

### Stage 23 - Face packing on convert - READY TO LAND (9b51e140c, ca0805da9, evidence 5d2f1a59c)

- src/form/pack.ts packRoots. Two first-level quads side by side are one C1 bicubic B-spline exactly when
  every pole on their join lies midway between the poles on either side of it. That is the same test the
  span joins inside a quad already pass. Where it holds, the join poles drop out (knot multiplicity 2) and
  the two pole grids become one.
  - Joins through ordinary points pass: the patch rules put those poles midway.
  - Joins at an extraordinary point do not (the G1 pass moves the poles beside it), and neither do creases.
    Both stay face boundaries because packing must preserve those surface joins.
  - Packs are rectangles of quads grown from a seed while a whole row or column joins.
  - A pack never wraps round onto itself. A face whose rim runs the same edge twice (a seam) is refused, and
    the rectangle stops one column short.
  - Tolerance: 1e-11 x the model's size. The largest measured deviation is under 1e-9 mm.
- src/form/exactStep.ts builds each face as a surface and a rim of quad sides, then packs the edges. A chain of
  quad sides through points where only two sides meet, and where the curve's poles pass the same midpoint
  test, is one edge curve. A closed chain keeps two of its points, so no edge closes on a single vertex.
  - formStep(cage, name, levels, pack = false) still writes one face per quad (tests, controls).
  - FormStep gains edges and packJoinMm.
- Found on the way, fixed (src/form/formEdges.ts): two packed faces often meet along more than one edge. The
  kernel names the second one (A^B)@m..., which the smooth-seam filter did not match, so the knob drew two
  smooth seams. The filter now takes the tail.
- Measured (faces / edges, before -> after):

  | Cage | Faces | Edges |
  |---|---|---|
  | sphere starter | 96 -> 6 | 192 -> 12 |
  | 2 x 2 x 2 box | 96 -> 6 | 192 -> 12 |
  | torus | 128 -> 4 | 256 -> 8 |
  | knob | 72 + 1 plane -> 18 + 1 plane | 152 -> 44 |
  | 32-segment cylinder | 320 -> 96 | 640 -> 224 |
  | default cylinder (in the app) | 24 after | - |

- In the app (`node src/tests/evidence/FORM/shoot.mjs 23`, stages.mjs stage23; opened):
  - 01: the Sphere starter finished. The body reads 6 B-spline faces, 19,656.15 mm^3. One click lights a
    sixth of the sphere.
  - 02: the Cylinder starter finished. 24 B-spline faces, 23,474.12 mm^3. One click lights a whole side
    region, rim to rim.
  - One console error: the geometry engine's first init attempt timed out at page load in headless (attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/facePacking.test.ts (10).
  - Per cage (sphere, box, torus, knob):
    - face and edge counts;
    - planar faces unchanged;
    - dropped poles within 1e-9 mm;
    - Euler V - E + F = 2 - 2g;
    - no face runs an edge twice, and every edge borders exactly two faces.
  - A crease stays a boundary.
  - A 5-sided cylinder does not pack across its valence-5 centres.
  - Kernel (sphere, torus, knob, 5-sided cylinder): ONE solid with the packed face count; volume and area
    within 3e-5 of unpacked.
  - exactSolid.test.ts: the knob counts are now 18 B-spline + 1 plane, and the seam display test compares
    shown edges against all edges.
- Negative controls (source mutated, the pure packing tests run, restored). Red of 6:
  - join tolerance 1e-2: 4;
  - quad rotation ignored when placing poles: 6;
  - no rim check (the torus wraps into one face): 1 (after adding the no-edge-twice check; 0 before it);
  - no edge packing: 4;
  - no join midpoint test: 5.
  - Plus: without the formEdges fix, exactSolid's seam test is red (a seam 18.35 mm tall drawn).
- Suites: exactSolid, facePacking, formBody (34 passed); g1, shellFormPart, exactSolidSlotFillet,
  creaseWeights, formFromBody, pipe all green. `npx tsc -b` clean. eslint clean on the changed files.
  Tripwire CLEAR.
- Shared files touched: src/form/formEdges.ts (Form's own edge filter, used by the Model display).
- Not done:
  - packs that are not rectangles (an L of quads is two faces);
  - packing across a join that is G1 but not C1 (near star points).

### Stage 24 - A mirror plane the operator places - READY TO LAND (7dfacbb56, c0d991af7, evidence b8bc51e7b, bf8621933)

- A mirror is now the plane n . p = at (src/form/symmetry.ts).
  - X, Y and Z keep their axis as the normal.
  - The new mode 'p' carries its own unit normal.
  - findPairs, symmetrize and mirrorSelection all work from the plane. The + side wins a tie; a seam point is
    projected back onto the plane along the normal, keeping its move along the plane.
- mirrorPlaneFrom(points):
  - two points: the plane halfway between them, which maps one onto the other;
  - three or more: the best-fit plane through them, with the worst deviation reported;
  - a plane square to X, Y or Z comes back as that axis's mirror, moved along it;
  - any other plane comes back as 'p', its normal's largest component positive (the same plane always reads
    the same);
  - coincident points, or points on one line: null.
- Form store:
  - symmetryNormal (a new field);
  - setSymmetryAt(mm) moves the plane along its normal;
  - mirrorFromSelection(): two points selected are used as they are; otherwise the selection's points (edges
    and faces give their corners);
  - the notices: "Mirror X at X = 30: 8 seam points stay on the plane"; "Mirror plane 0.866x + 0.5y + 0z = 0:
    ..."; points without a partner say they move alone, as before.
- The feature payload keeps symmetryNormal for 'p'. Edit restores it, and a later Finish without it drops it.
- UI:
  - Symmetry rail: Between (after Circular).
  - Form palette: a Mirror row while any mirror is on, "mm on X" for an axis mirror, "mm offset" for a placed
    plane.
  - The overlay draws the plane as a faint square round the form, 0.8 x the cage diagonal, for X, Y and Z
    too.
  - Help (modeling topic): the Mirror row and Between.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 24`, stages.mjs stage24; rail and palette clicked /
  typed; opened; re-shot after the first set showed a clipped label and edge-on planes):
  - 01: a box at X = 30, Mirror X. The plane at X = 0 is beside it; all 26 points are alone.
  - 02: 30 typed in the Mirror row. The plane goes through the box; 8 seam points.
  - 03: a corner pulled (8, -4, 6) to (58, -24, 46). Its partner is at (2, -24, 46), mirrored across X = 30.
  - 04: a box turned 30 degrees. Two corners across its own mid-plane are selected and Between is clicked:
    plane 0.866x + 0.5y = 0.
  - 05: one corner pulled up 12 to (7.32, 27.32, 52). Its partner is at (-27.32, 7.32, 52), the reflection.
  - 06: Finish, then Edit. The tilted plane is back (symmetry 'p', the same normal).
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/mirrorPlane.test.tsx (12).
  - two points map onto each other;
  - axis snap (X at 7, Z at 20);
  - three or more points fit the turned box's plane, the same either way round;
  - points on a line or in one place: null;
  - a turned box pairs every point across its tilted plane, and no axis plane pairs them;
  - a pulled point's partner is its reflection, and a seam point goes back onto the plane;
  - store: Between, then a move mirrors;
  - store: the Mirror row off-centre says "move alone", and back to centre it does not;
  - store: Mirror X on a box at X = 7, row to 7: "Mirror X at X = 7: 8 seam points stay on the plane";
  - store: nothing selected leaves symmetry off and names what to pick;
  - payload + Edit round trip;
  - the overlay draws the plane and hides it.
- Negative controls (source mutated, the file run, restored). Red of 12:
  - placed normal ignored: 4;
  - seam not projected: 1;
  - two points fitted as plane-through: 3;
  - no axis snap: 1;
  - setSymmetryAt ignores its value: 2;
  - payload drops the normal: 1;
  - overlay never shows the plane: 1;
  - no collinear check: 1.
- Suites: src/tests/form + zebra + curvature, 35 files, 263 passed; symmetryModes 8 / 8 unchanged. tsc clean;
  eslint 0 errors (1 warning in useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: src/help/topics/modeling/index.ts (one sentence).
- Not done:
  - dragging the plane in the viewport (it moves by the row, or is placed from points);
  - Mirror - duplicate (make the other half from one side).

### Stage 25 - Performance - READY TO LAND (3da227f8d, 906d6b7d5, evidence 05ff156c4)

- Knot removal (src/form/knots.ts). Tiller's algorithm (The NURBS Book A5.8), one knot at a time, every row
  of the net at once, tolerance 1e-11 x the model size.
  - Faces and edges are built three refinement levels down, so a smooth region carried the refinement's
    knots.
  - Now the knots inside a regular cage face go, and those on a regular cage edge drop to multiplicity 1
    (C2). Star-point and crease joins keep theirs, because the removal test misses by far more than the
    tolerance.
  - FormStep gains poles and knotMoveMm (a bound on how far any face or edge moved).
  - formStep(..., pack, reduce = false) keeps the old net.
- G1 pass (g1.ts): implied grids are built only for the faces round the point being worked. It rebuilt
  every face's grid 14 times per star point. Grids are copied shallowly (poles are replaced, never
  changed in place).
- buildHalfEdge (halfEdge.ts): twins and the edge map come from each vertex's outgoing list instead of a
  string or Map entry per half-edge. The results are identical, bad meshes included (the last twin wins,
  every half-edge is listed per edge). Topology edits use it too.
- findPairs (symmetry.ts): points are bucketed on a grid; each image searches 27 cells, not every point.
  The images are the same, ties included.
- Measured (the probe, box cages with points nudged so nothing is flat; faces / page build / STEP / kernel
  import / kernel mesh / Mirror X):

  | Faces | Before | After |
  |---|---|---|
  | 384 | 5.8 s / 9.5 MB / 1.7 s / 0.3 s / 13 ms | 1.1 s / 0.29 MB / 2.1 s* / 0.08 s / 7 ms |
  | 864 | 13 s / 22 MB / 2.5 s / 0.8 s / 41 ms | 2.7 s / 0.40 MB / 0.5 s / 0.12 s / 11 ms |
  | 1,536 | 25 s / 39 MB / 4.1 s / 1.8 s / 109 ms | 4.9 s / 0.53 MB / 2.8 s* / 0.16 s / 26 ms |
  | 3,456 | 76 s / 87 MB / 8.8 s / 6.1 s / 564 ms | 12.2 s / 0.84 MB / 1.3 s / 0.3 s / 46 ms |

  (*) Kernel import times swing by about 2 s from run to run at small sizes (the kernel's own warm-up and
  GC). The larger sizes show the trend.
- Surface poles, full -> reduced:
  - sphere starter 4x fewer; knob 2.6x fewer (small cages are mostly star-point neighbourhoods);
  - torus 40x+ fewer; a bumpy 8 x 8 x 8 box 20x+ fewer.
  - Knot removal moved faces and edges at most 1.2e-10 mm (864-face box).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 25`, stages.mjs stage25; opened):
  - 01: a 12 x 12 x 12 box (864 faces), points nudged.
  - 02: Finish to the exact body in 6,287 ms: 6 B-spline faces, 63,562.74 mm^3.
  - 03: a 24 x 24 x 24 box (3,458 points), Mirror X matched in 52 ms, 96 seam points.
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests:
  - src/tests/form/knotRemoval.test.ts (4):
    - one cubic split 8 ways comes back as 4 poles (1e-12);
    - a C1 kink keeps its knot;
    - one failing row blocks every row;
    - a refined C2 spline returns to its own knots.
  - src/tests/form/formPerformance.test.ts (13 + the probe):
    - knot removal on 4 cages: pole ratio, moved under 1e-9 mm, same faces and edges;
    - kernel on 4 cages: one solid; volume and area within 3e-5 of unreduced; the limit volume within 2e-4;
    - the grid symmetry search equals the direct search: Mirror X at 0 and 5, unpaired, circular 8;
    - buildHalfEdge equals the keyed build: closed, open, non-manifold and repeated faces.
    - The probe runs with FORM_SCALE=1.
- Negative controls (source mutated, the file run, restored):
  - knot tolerance 1e-2: 4 red of 4;
  - only the first row checked: 1 of 4;
  - twin takes the first match: 1 of 2;
  - edge list one direction only: 2 of 2;
  - symmetry searches the centre cell only: 1 of 3;
  - G1 local set misses side b: 10 of 11.
- Suites: src/tests/form + zebra + curvature: 37 files, 280 passed (1 skipped: the probe). tsc clean. eslint
  clean. Tripwire CLEAR.
- Shared files touched: none outside src/form, its tests and stages.mjs.
- Not done:
  - regular regions straight from the cage (skipping the refinement: most of the 12 s left);
  - an incremental skin rebuild on topology edits (surface.ts, after WO-2183);
  - the curvature attribute's 0.1-0.2 s per drag release.

### Stage 26 - Flatten onto a chosen plane - READY TO LAND (47a754f50, 042c8a350, evidence 8b21cd586)

- shapeTools flattenPoints(cage, points, onto?) puts points on a given plane (any number of points), or
  on their best fit as before (three or more).
- Form store:
  - flattenOnto: 'fit' | 'x' | 'y' | 'z' | 'face' | 'mirror';
  - flattenAt: an axis plane's position, or null for "through the centre of the points flattened";
  - choosing another plane forgets a typed position.
  - Plane resolution:
    - an axis plane: normal X, Y or Z, at flattenAt or the points' mean;
    - face: the best-fit plane of the first selected face's corners;
    - mirror: n . p = symmetryAt.
  - Symmetry is kept (symmetrize) and it is one undo step.
  - Notice: "Flattened 9 points onto the Z plane at Z = 45 (the farthest was 8.89 mm off it)".
  - With no face selected, or no mirror on, the notice names what to pick and nothing moves.
- Form palette: a Flatten row with a plane select (best fit / X plane / Y plane / Z plane / face / mirror;
  mirror is listed only while a mirror is on) and, for an axis plane, its position in mm. The first
  captures showed the row wrapping and the long names clipped; the names are now one word, with the
  tooltip spelling them out.
- The rail's Flatten tooltip names the palette's choice.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 26`, stages.mjs stage26; the select and input driven;
  opened):
  - 01 / 02: a box's top pushed about, top selected, Z plane at 45, Flatten. All 9 top points are at
    Z = 45; the farthest was 8.89 mm off.
  - 03 / 04: the +X side leaned 0.3, one side face and a point across the box selected, face, Flatten. The
    far point goes onto the face's plane: (12.84, -20, -3.85), 13.41 mm off before.
- Tests: src/tests/form/flattenOnto.test.ts (8):
  - one point onto a given plane, with its distance;
  - Z through the points' mean, nothing else moved, the notice;
  - X at a typed 25;
  - another plane forgets the typed position;
  - the face's plane (the far point lands on the plane of the face's ORIGINAL corners);
  - no face: notice, no move;
  - mirror: no mirror is a notice, then Mirror X moved to 5 puts the point at X = 5;
  - Mirror X kept: flattening the +X top flattens its partners.
  - flattenStraighten.test.ts (9) unchanged and green.
- Negative controls (source mutated, the file run, restored):
  - chosen plane ignored: 4 red of 8;
  - typed position ignored: 2;
  - face plane fitted through every point: 1 (after the test was tightened to the face's original plane;
    0 before);
  - mirror position ignored: 1;
  - no symmetrize: 1;
  - a new plane keeps the typed position: 1.
- Suites run: flattenOnto, flattenStraighten, editForm, mirrorPlane, symmetryModes: 51 passed. tsc clean
  (after `npm ci`: the main merge brought onnxruntime-web). eslint clean. Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.

### Stage 27 - Revolve by an angle, with its segments - READY TO LAND (280e4fead, 1e6b5964f, evidence bc4f8d4a0)

- profile.ts revolveProfileCage(path, frame, axis, segments, perLoop, angleDeg):
  - a full turn, or 1 to 360 degrees;
  - short of a full turn, n spans give n + 1 rings.
  - A closed profile gets a flat cap at each end: capFaces of the profile, wound against the side faces it
    meets, rim creased. The rim rings sit on the profile itself; the rings between are padded
    3 / (2 + cos step) as before, so the skin still passes through the profile.
  - An open profile makes an open sheet (no caps, no creases).
  - Profile points on the axis weld into poles as before.
  - A full turn gives the identical cage (the padding formula is the same at step = 2 pi / n).
- Form store: revolveAngle (1..360, default 360) and revolveSegments (3..64, default 16).
- Form palette: a Revolve row (deg, round).
- The Revolve rail button uses them, and its notice names the angle ("... 270 degrees, its ends capped
  flat ..."). The rail tooltip points to the palette.
- Measured: part-turn volumes against the full ring (a 10 x 10 square 10 mm off the axis, skin at 0.02 mm):
  90 degrees 0.2500, 180 degrees 0.4998, 270 degrees 0.7488.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 27`, stages.mjs stage27; the palette typed and the
  rail clicked; opened):
  - 01: stage 15's half-vase sketch on XZ, 270 degrees and 12 round. 408 points, 374 faces, 127 creased
    edges.
  - 02: Finish to the exact body in 7.3 s: 27 faces (4 planar: the two cut ends, foot and lip),
    41,496.93 mm^3. It is viewed from +Y so both flat cut faces show; the first set looked from the side
    the cut faced away from.
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/revolveAngle.test.ts (7):
  - a full turn is the default cage;
  - half a turn: closed and valid, 0.495-0.505 of the ring's volume, both rims creased, both end rings flat
    on the axis plane, and the skin on each end plane inside the profile;
  - a quarter turn of a half disc: poles welded, closed and valid, a quarter of the ball's volume;
  - an open profile: an open sheet;
  - segments: 24 round, 25 rings over part of a turn;
  - store clamps;
  - kernel: half a ring and a wedge of a ball each finish into ONE solid within 5e-4 of the limit volume.
  - profileForms.test.ts (9) unchanged and green.
- Negative controls (source mutated, the pure tests run, restored):
  - no caps: 2 red of 6;
  - cap winding not matched: 2;
  - rims padded like the rings: 1;
  - angle ignored: 4;
  - rims not creased: 1;
  - store does not clamp: 1.
- tsc clean. eslint clean (1 warning in useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.

### Stage 28 - A face by clicks - READY TO LAND (2e85d53a2, evidence d5836dd1a)

- src/form/faceByClicks.ts addClickedFace(cage, clicks, plane, replace).
  - A click is an existing cage point (a click on it snaps) or a new point where the pointer ray meets the
    work plane (rayOnPlane).
  - The new face is wound against any face it shares an edge with (a shared edge runs the other way in
    each); with none, toward the work plane's normal.
  - replace: the face alone is a new form (points of the old form clicked for it are copied).
  - Refused only when it cannot be: a repeated corner; corners on one line; an edge already joining two
    faces; a face turned against its neighbours on two sides. Then validateCage (open cages allowed).
- Form store: faceTool { replace, plane, planeWords, clicks } | null; startFaceTool, addFaceClick (a face
  every 4 clicks), finishFaceDraft (Enter: 3 or more), stopFaceTool.
  - The first face of Face replaces the form; the tool stays on and the next faces join it.
  - Each face is one undo step and is left selected.
  - A refused face clears the corners and says why ("...; the corners are cleared, click again").
  - Opening or leaving a session turns the tool off.
- Viewport (formInteraction.ts):
  - with the tool on, a click is a corner (a cage point under the pointer, else the ray on the work plane);
  - the corners so far and a line to the pointer are drawn in the selection amber (--vp-select-amber),
    owned by the interaction, not the overlay;
  - Enter makes a triangle, Esc stops.
- Rail:
  - Face (Form - start from): a new form on the selected sketch's plane, else XY at Z = 0;
  - Add face (Topology): faces added to this form.
  - Clicking the active one again stops it.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 28`, stages.mjs stage28; real mouse clicks at the
  projected corners; opened):
  - 01: three corners and the line to the pointer.
  - 02: the fourth: the form is that face (1 face, 4 points).
  - 03: a second quad snapped to the first one's edge (2 faces, 6 points), then three corners and Enter: a
    triangle (3 faces, 7 points).
  - 04: Esc, Thicken 2 mm: closed.
  - 05: Finish: the exact body, 4 faces, 1,637.08 mm^3.
  - The first runs clicked corners under the floating Form palette (x < 592 px) and beyond the right rail;
    the scenario now keeps the corners between them.
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/faceByClicks.test.ts (12):
  - four clicks either way round make a quad facing +Z;
  - a face on a face's edge shares it (either click order), valid;
  - a shared edge wins over the plane: next to a face turned to -Z the new face turns to -Z too;
  - replace;
  - the refusals;
  - rayOnPlane;
  - store: nothing changes until the 4th corner, then the form is that face, the next face shares an edge,
    one undo per face;
  - Add face + Enter triangle + Esc;
  - Enter with 1 corner; a refused face clears;
  - a sketch work plane;
  - leaving the session stops the tool;
  - the new face is selected.
- Negative controls (source mutated, the file run, restored):
  - never toward the plane normal: 1 red of 12;
  - shared-edge winding ignored: 1 (after the -Z test was added; 0 before, the plane normal agreed);
  - third face on an edge allowed: 1;
  - replace keeps the old form: 3;
  - no collinear check: 2;
  - replace stays on after the first face: 1;
  - Enter commits with 2 corners: 1.
- Suites: src/tests/form + zebra + curvature + the UI and body-consumer censuses: 44 files, 451 passed,
  2 red (both not this branch's, see LATEST). tsc clean. eslint clean (1 warning in useFormSession.ts,
  there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files (formInteraction.ts, useFormSession.ts) and
  stages.mjs.
- Not done:
  - a work plane picked in the viewport (it is the selected sketch's, else XY);
  - chain mode (each face starting from the last edge);
  - snapping to edges' midpoints.

### Stage 29 - Pull (the surface through the points) - READY TO LAND (54c600465, evidence d0e752c04)

- shapeTools pullToLimit(cage, points): each given point's current position is its target. The point is
  corrected, P += target - limit(P), until every limit lands within 1e-4 mm (at most 200 rounds). Other
  points stay.
- cageLimitRows(cage, levels): each cage point's limit mask over the cage points. It takes `levels`
  refinements (a cage point keeps its index), the limit mask there, composed back.
- Read three levels down (LIMIT_LEVELS):
  - the limit mask is exact at any level except next to where a crease ends (a dart), where it settles
    about 2.4x per level;
  - measured on a box with two creased edges against seven levels: 0.34 mm (1 level), 0.14, 0.060 (3),
    0.025, 0.010 (5);
  - three keeps Pull quick on large cages;
  - the notice no longer claims a precision ("... (it was up to 3.54 mm off them)").
- Form store pullSelection: the selected points, else the whole form. Symmetry kept, one undo step.
- Rail: Pull (Edit form).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 29`, stages.mjs stage29; the rail clicked; opened):
  - 01 / 02: the Sphere starter, skin box +-16.46 inside cage points at +-20; Pull, nothing selected. The
    skin box is then exactly [-20, 20] x [-20, 20] x [0, 40], where the points were; the cage grows to
    +-24.71.
  - 03 / 04: a box, its 9 top points selected, Pull. The skin passes through them and bulges between (skin
    top 42.27). A surface through points does that; the shot's first name ("pulled flat") was wrong and
    was renamed.
- Tests: src/tests/form/pull.test.ts (6). The surface is checked independently, five refinement levels down
  plus the limit mask there.
  - the sphere starter, all points: the surface lands on every cage point (1e-3) and the volume swells;
  - a box's top only: the surface lands on them, every other point is unchanged;
  - two creased edges: within 0.1 mm (measured 0.061), and within 1e-3 away from the crease's ends;
  - nothing given: null;
  - store: nothing selected pulls all, the notice, undo;
  - Mirror X kept.
- Negative controls (source mutated, the file run, restored):
  - one round only: 3 red of 6;
  - limit read one level down: 1;
  - every point moves: 1 (the first mutation of this, a no-op, did not bite and was replaced by pulling all
    points);
  - no symmetrize: 1;
  - the wrong rows (the last V): 3.
- flattenOnto, flattenStraighten, makeUniform, subdCore: 43 passed. tsc clean. eslint clean (1 warning in
  useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.
- Not done:
  - pull onto a Model body's surface (needs the kernel's closest point);
  - an exact limit next to crease ends.

### Stage 30 - Small gaps: delete points, bridge twist, Pipe radius - READY TO LAND (64825d4d3, 5607c0ad4, 071b811d1, evidence 9d3b69534)

- Delete on points (formStore deleteSelection). With only points selected, Delete dissolves every edge
  through each point, mirror images included (dissolveEdges), so the faces round it merge into one and
  the point goes.
  - A point on the open border keeps its border edges and stays. The notice counts it: "...; 1 on the open
    border stay". With only border points there is nothing to delete, and the notice says why.
  - Points with edges or faces also selected keep the old meaning.
  - The rail's Delete tooltip names all three.
- Bridge twist (bridgeLoops bridgeOpenings / bridgeFaceSets, twist).
  - A closed B is turned `twist` points further than the lined-up start, so the band spirals; a full turn
    of points is the same as none.
  - Open borders have ends to meet and take none.
  - Form palette: the Bridge row is now "n long, t twist".
  - The notice names the twist.
- Pipe radius (formStore pipeRadius; 0 = automatic).
  - Form palette: a Pipe row.
  - The automatic radius is as before (a twelfth of the path, under 0.6 x its tightest bend, 0.5-10 mm).
  - A typed radius is made as asked. The notice says a tube folds only when the radius passes the path's
    real tightest bend (tightestBend, split out of defaultPipeRadius; Infinity for a straight path).
  - The first capture showed a straight 6 mm pipe told it folds: the comparison was against the automatic
    radius. Fixed in 071b811d1.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 30`, stages.mjs stage30; rail and palette driven;
  opened):
  - 01 / 02: a 2 x 2 x 2 box's top centre point deleted. 21 faces, 25 points, the top one 8-sided face.
  - 03: a 4 x 4 x 4 box, top and bottom centre face sets bridged 4 long with a twist of 2: a spiral hole
    through (120 faces).
  - 04: Pipe at a typed 6 mm radius: "Pipe: a straight 60 mm pipe, radius 6 mm. ..."
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests:
  - src/tests/form/deletePoints.test.ts (5): a top centre point (8-gon, closed); a corner (6-gon, undo);
    Mirror X; open border; mixed selections.
  - src/tests/form/smallGaps.test.ts (6):
    - twist 0: every rung straight down;
    - twist 2: none straight, closed; 8 = 0; -2 differs;
    - face sets take it;
    - store clamp;
    - tightestBend: straight Infinity, a quarter circle of radius 20 bends at 20, the default well inside;
    - pipe radius clamp.
- Negative controls (source mutated, the file run, restored):
  - points fall to Delete faces: 4 red of 5;
  - the selection without its mirror: 1;
  - border points counted as gone: 1;
  - selection kept: 1;
  - twist ignored: 2 of 5;
  - face sets drop the twist: 1;
  - pipe radius not clamped: 1.
- Suites: src/tests/form + zebra + curvature: 44 files, 329 passed. eslint clean (1 warning in
  useFormSession.ts, there before). Tripwire CLEAR.
- tsc: NOT clean at 2173bba8d. smallGaps.test.ts typed its quarter-circle path loosely (vitest does not
  type-check, so the suite passed). Fixed in 9191481d1; tsc clean from there.
- Shared files touched: none outside Form's own files and stages.mjs.

### Stage 31 - A live Loop slider - READY TO LAND (f8fbb36b9, evidence 658a01dca)

- The Loop row gains a slider (0.01-0.99). The number box stays; the unit words went, and the tooltip
  says them.
- Right after Insert loop the loop is live (formStore liveLoop: the form before it, the selection then,
  and the form with it).
  - Moving the slider or the number rebuilds the loop at the new position from the form before it, with
    applyCage(record: false). So there is no second loop, and it all stays one undo step.
  - Any other change to the form ends it; then the slider only sets the next Insert loop's position.
- The loop computation moved out of insertLoop into loopInsertion(state, t), used by both.
- The notice adds "; the Loop slider moves it until the next change". loopPosition.test.tsx's notice
  expectation was updated for that; it is a deliberate change.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 31`, stages.mjs stage31; the slider driven by focus
  and arrow keys; opened):
  - 01: Insert loop on a vertical edge: loop at Z = 10, 34 points.
  - 02: 30 steps left: the same loop at Z = 4 (0.2), still 34 points.
  - 03: one Undo: no loop, 26 points.
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: loopPosition.test.tsx (9; 3 new):
  - live: 0.5 -> 0.25 -> 0.8 moves the one loop, one undo;
  - after a move the slider only sets the position;
  - the palette slider drives it.
- Negative controls (source mutated, the live tests run, restored):
  - never live: 2 red of 3;
  - live after other changes: 1;
  - rebuilt on the current form (a second loop): 2;
  - each move a new undo step: 1;
  - slider not wired: 1.
- loopPosition + formPanel: 10 passed. tsc clean. eslint clean. Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.

### Stage 32 - Loft - READY TO LAND (a2d9cc7b9, 7535c0721, evidence 502add93e)

- src/form/loft.ts loftCage(profiles, count = 32).
  - Each profile is resampled evenly by length to `count` points and put in model space on its sketch's
    plane.
  - Closed rings are faced one way along the loft (Newell normal against first-to-last centre direction).
  - Each ring is turned to line up with the one before (least total distance); an open profile may be
    taken reversed.
  - Rings are added between profiles, straight across, about the point spacing apart (1 to 16).
  - Closed profiles get flat caps (capFaces, wound against the side faces, rims creased); open ones a
    sheet.
  - Outward by volume sign.
  - Last, pullToLimit on the profile rings, so the skin passes through every profile.
  - Refused only when it cannot be: one profile; a mix of open and closed; all in one place.
- Rail: Loft (Form - start from).
  - Each click adds the profile of the sketch selected in the Model tree. From the second on, the form is
    lofted through them all and rebuilt as more are added.
  - A sketch already in the loft starts a new one from it.
  - A new session starts none.
  - No multi-select in the tree was needed (that would have meant editing SolidsWorkbenchPage).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 32`, stages.mjs stage32; tree rows and the rail
  clicked; opened). The two raised planes are copies of XY with their frame moved up, as a fixture.
  - Base circle (r 20, XY) then Loft: "profile 1".
  - Mid square (16, Z 25) then Loft: 7 rings (01).
  - Top circle (r 8, Z 45) then Loft: 15 rings (02).
  - Finish: the exact body, 35 faces, 39,623.32 mm^3 (03). The skin runs through all three outlines.
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/loft.test.ts (5), checked independently five refinement levels down.
  - circle to square: closed, valid, outward; the bottom ring's surface on the circle, the top's on the
    square (0.05 mm);
  - a waist of three: the skin through the small middle circle;
  - line-up: two squares starting at different corners, or running the other way, give straight sides;
  - open: a sheet, and a reversed second line is taken reversed (the middle ring stays 20 mm wide); the
    three refusals;
  - kernel: circle to square finishes into ONE solid within 5e-4 of the limit volume.
- Negative controls (source mutated, the pure tests run, restored):
  - no pull: 2 red of 4;
  - no line-up rotation: 1;
  - no facing one way: 1;
  - no caps: 3;
  - an open profile never taken reversed: 1 (after the middle-ring test was written; 0 with the first
    check, which looked only at the first ring).
- tsc clean. eslint clean (1 warning in useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.
- Not done:
  - profile corners (resampled evenly, a corner can round slightly);
  - rails or guide curves;
  - profiles of different point counts kept as drawn.

### Stage 33 - Pull to body - READY TO LAND (d3a162b82, evidence d2765ccee)

- The geometry kernel has no closest-point query, and adding one would mean editing the shared geom
  service. Pull to body uses the target body's display mesh instead, which the page already hands Form for
  From body (selectedBodyMesh: the body selected in the Model tree, else the only body).
- src/form/closestPoint.ts:
  - closestOnTriangle (Ericson 5.1.5);
  - closestPointIndex(mesh): triangles bucketed on a grid, cells sized by the cube root of the triangle
    count. A query searches shells of cells outward until none can hold a nearer triangle.
  - The first sizing (square root, finer) made a query from well inside the body scan tens of thousands of
    empty cells, and a test control timed out; the coarser grid runs both Pull suites in 4.2 s.
- shapeTools pullOntoMesh(cage, points, index):
  - each given point's surface point (limit, three levels down, as Pull) targets the mesh's closest point
    to it, and the cage is corrected toward those targets (settle, Pull's loop, now shared);
  - one round: the corrected surface points are on the mesh, and a second round would only slide them
    along it. A multi-round first draft showed no difference; the control removing it did not bite, so it
    was simplified away.
- Form store pullOntoBody(mesh, name): the selected points, else all. Symmetry kept, one undo step. The
  notice names the body and the worst remaining distance of those surface points to its display mesh.
- Rail: Pull to body (Edit form). No palette row.
- In the app (`node src/tests/evidence/FORM/shoot.mjs 33`, stages.mjs stage33; the rail clicked; opened):
  - the Sphere starter scaled 1.6x and finished as "Ball" (80,511.61 mm^3);
  - a new form from the Box starter (2 x 2 x 2), inside it (01);
  - Pull to body: "Pulled the surface at all 26 points onto Ball: within 0.00 mm of its display mesh (it was
    up to 6.32 mm off)" (02);
  - the ball hidden: the box form has its shape (03).
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/pullOntoBody.test.ts (5):
  - closest point on a triangle (inside, edge, corner);
  - the grid equals a search of every triangle, from inside and outside a sphere mesh;
  - the sphere starter onto a radius-25 sphere mesh: every surface point on it (0.1 mm, checked five levels
    down);
  - only the given points move;
  - store: all points, the notice, undo.
  - pull.test.ts (6) unchanged and green.
- Negative controls (source mutated, the file run, restored):
  - grid search stops after its own cell: 2 red of 5;
  - triangle closest point is vertices only: 1;
  - targets never the mesh: 2.
- tsc clean. eslint clean (1 warning in useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.
- Not done:
  - the exact surface of the body (the display mesh is 0.3 mm chord, FORM_FROM_BODY_TESS);
  - pulling only along each point's normal.

### Stage 34 - From body remeshes curved faces into quads - READY TO LAND (0f99e3126, 7a3fc0d33, 60203d02f, evidence aa15e00fb)

- src/form/remesh.ts remeshFromBody(mesh, opts).
  - The body's tessellation is split into its faces, and the edges between them into chains. Every chain is
    resampled once, so both faces beside it share its points.
  - Flat faces with every edge sharp: one face each. A chain between two such faces (or one and an opening)
    keeps its original points, so a box stays 8 points.
  - Curved faces, and flat faces that run smoothly into a neighbour, become grids:
    - four chains: a Coons grid;
    - one closed chain: a dome, the loop cut into four;
    - two closed chains: rings between them;
    - three, or five or more chains: a centre point, a spoke from the middle of each side, and one Coons
      grid per corner (all sides the same even count).
  - Opposite sides' counts are settled together (union-find). A face whose counts cannot be met keeps its
    triangles (a flat face keeps its single face).
  - A chain's count comes from its length (spacing, default a twelfth of the body's diagonal) and its turn
    (at most 30 degrees a segment). The turn is taken from the polyline, corrected for the half segment it
    misses at each end: a quarter circle in four chords turns only 67.5 degrees.
  - Interior points go on the face (closest point of its triangles) and are relaxed.
  - Last, the Pull (shapeTools pullOntoTargets, new; pullOntoMesh now uses it). Each point's surface point
    goes onto what the point belongs to: a chain point onto that edge's polyline, a body vertex onto itself,
    any other point onto its own face.
- src/form/fromMesh.ts formFromBody(mesh, { remesh }): default true. `remesh: false` is the path before
  stage 34, kept as the control. The result gains gridFaces.
- Notice (useFormSession): "From body: 2 flat faces kept whole, 1 face remeshed into quads; 44 sharp edges
  creased. ..." Each part is left out when its count is 0.
- Measured (real kernel, FORM_FROM_BODY_TESS input). "Off" is the skin (four levels down) against a fine
  tessellation of a separate copy of the body:

  | Body | Points (old) | Faces | Off body | Volume vs truth (old) |
  |---|---|---|---|---|
  | box 40x30x20 | 8 (8) | 6 flat | 0 | exact |
  | cylinder r10 x 20 | 176 (64) | 2 flat + 154 quads | 0.048 mm | -0.66% (-1.17%) |
  | filleted box (r4, every edge) | 480 (416) | 478 quads | 0.092 mm | +0.09% (-0.45%) |
  | notched box | 30 (24) | 6 flat + 15 quads | 0.077 mm | +0.03% |

  - The cylinder is limited by the input: its rim polyline is 0.3 mm chords. With a 0.02 mm tessellation it
    is 0.003 mm off.
  - The filleted box's worst spot is at the corner blends (the valence-3 centres), about 0.09 mm, however
    fine the arcs are divided (tried 30, 22.5 and 15 degrees).
- In the app (`node src/tests/evidence/FORM/shoot.mjs 34`, stages.mjs stage34; opened):
  - a 40 x 24 x 16 block, every edge filleted 4 mm, and a cylinder r10 x 20, built through the model history;
  - From body on the filleted block: 434 points, 432 faces, every one a quad, no creases (01); smooth (02);
  - Finish: the exact body, 14,351.06 mm^3 against the filleted block's 14,346.95 (+0.03%) (03);
  - From body on the cylinder: 2 flat caps and 154 quads, 44 rim edges creased (04).
  - One console error: the geometry engine's first init attempt timed out at page load (headless, attempt 1
    of 3). It retried, and the run completed normally.
- Tests: src/tests/form/remesh.test.ts (6, real occt-wasm):
  - box: 8 points, 6 faces, 12 creases, 24,000 mm^3;
  - cylinder: grids, all quads but the caps, off < 0.06 mm, volume within 1% and nearer than the old path;
  - filleted box: 26 grids, all quads, points < 1.25x the old path, off < 0.12 mm, volume within 0.2%;
  - notched box: flat faces whole, one grid, < 40 points, off < 0.1 mm, volume within 0.5%;
  - a quarter circle in three chords gets four segments at 25 degrees;
  - three-sided and five-sided caps: all quads, one centre point with one quad per side.
  - formFromBody.test.ts (3) runs the old path through `{ remesh: false }`.
- Negative controls (source mutated, remesh.test.ts run, restored; git diff of src/form empty after):
  - flat-flat chains resampled: 2 red of 6;
  - no centre split: 2;
  - flat faces never gridded: 1;
  - Pull onto the nearest point of the whole body: 1 (cylinder);
  - no end-turn correction: 1 (0 before the quarter-circle test was written; that test was added for it);
  - no Pull: 3;
  - remesh off by default: 3.
- npx vitest run src/tests/form/ plus the raw-body census: 45 files, 340 passed. tsc clean. eslint clean
  (1 warning in useFormSession.ts, there before). Tripwire CLEAR.
- Shared files touched: none outside Form's own files and stages.mjs.
- Not done:
  - a ruled face (a cylinder side) is divided along its straight direction by spacing alone; it could take
    fewer rings;
  - two-sided curved faces, and flat faces with holes, keep their triangles / n-gon as before;
  - a centre-split face needs all its sides the same count (general counts are possible:
    spoke_A = (b + c - a) / 2).

### Stage 35 - The rail: compact mode, folding groups, tighter padding - READY TO LAND (9b9718846, evidence 85764290e)

- What: WorkbenchToolRail.tsx (every mode) gains a header compact toggle (`workbench-rail-compact`) and a
  fold chevron per group (`workbench-rail-collapse-<id>`; sketch groups `sketch-<id>`, plus
  `sketch-constraints`). The layout is kept in useToolPaletteLayout(palette), whose keys are
  `liencam.<palette>.compact` and `liencam.<palette>.collapsed`. Styles live in the scoped
  workbenchToolRail.css; app.css is not touched.
- Compact hides each label (font-size 0 inside the button, so it keeps its accessible name). Hints read
  "<label>: <title>". Disabled tools stay disabled and in place: nothing is hidden or reordered by state.
- Tests: src/tests/model3d/workbenchRailLayout.test.tsx, 4 tests. The 16 existing rail/sketch-rail files
  (130 tests) pass unchanged.
- Negative controls, all bite:
  - no compact hint prefix: 1 of 4 fails;
  - folding does nothing: 2 fail;
  - nothing written to storage: 1 fails;
  - readPref without try/catch: 1 fails.
- Checks: tsc clean; eslint on the 3 files clean (the one warning, SKETCH_SECTIONS'
  only-export-components, was already there); tripwire CLEAR.
- Evidence stage35/01-05, opened: Model normal, compact, compact with Sketch folded, Form compact, Form
  normal. The hover hint does not render in headless shots, so no shot claims it; the test proves the
  hint text.
- Next (proposed): the same hook and CSS on the CAM Sketch toolbox (SketchToolbox.tsx; same
  .sketch-tool-grid classes), then the Form palette (FormPanel.tsx) rows in foldable groups without
  new rows.

### Stage 36 - The CAM Sketch toolbox: compact mode, remembered folds - READY TO LAND (fb534e5bf, evidence fc59d5057)

- SketchToolbox.tsx: useToolPaletteLayout('cam-sketch') replaces its own un-remembered fold Set. The header
  gains `cam-sketch-compact`. In compact mode a hint that does not start with its tool's name gets it
  prefixed (Measure, Reference); every other hint already names the tool.
- Tests: src/tests/sketch/camSketchToolboxLayout.test.tsx, 2 tests. The 24 existing toolbox, sketch and
  rail files (219 tests) pass.
- Negative controls, all bite:
  - no hint prefix: 1 of 2 fails;
  - folds ignored: 1 fails;
  - a fresh palette key each render (nothing remembered): 1 fails.
- Checks: tsc clean; eslint shows only the 2 warnings that were already there; tripwire CLEAR.
- Evidence stage36/01-03, opened. The UI78 overlay-guard console.warn lines in the run log name
  sketch-dim-layer, sketch-prompt-bar and the sticky section headers: markup that was already there, not
  this stage's.

### Stage 37 - Construct: Midplane and Plane at angle - READY TO LAND (066fbd66d, f1285dd1c, 6d519a8de, evidence c4d38f1f0 / re-shot 2fa58039b)

- Math (src/sketch3d/referencePlaneMath.ts):
  - makeMidplaneFrame: points p with p.(na + nb) = da + db, nb turned to face na. One rule covers
    parallel planes and planes that meet.
  - makeAngledPlaneFrame: Rodrigues about the parent's X or Y axis through its origin, right-handed.
- Datum (src/sketch3d/datumPlane.ts):
  - a ConstructionPlaneDefinition union, and constructionPlaneFrame (the one rule for the executor,
    preview and Apply);
  - constructionPlaneParentCount and constructionPlaneParentOrder;
  - buildConstructionPlaneDatumNodeInput;
  - the executor consumes 1 or 2 parents.
- UI:
  - OffsetPlaneDialog takes planeType. Midplane shows First and Second plane selects; At angle shows
    Angle (deg) and "Turn about the source plane's" X axis or Y axis.
  - Viewport picks alternate first and second for a Midplane, and face picks keep both support planes.
  - The status line and the preview label name the kind.
  - Help text and keywords were added.
- Rules kept:
  - No new refusals, gates or disabled controls; tripwire CLEAR.
  - The new buttons take Offset plane's state by spread, so the gate is its existing line.
  - Apply relies on the accepted preview (same parents, same math, fingerprint unchanged); its frame
    checks were removed, not reworded.
  - Existing refusal lines are kept verbatim ("Offset Plane replay refused", "Offset Plane preview
    refused"). A midplane that ever hit one would read "Offset Plane": known wording debt, left
    rather than add refusal lines.
- Tests:
  - src/tests/sketch3d/constructionPlanes.test.ts, 8 tests: frames; the executor through RegenScheduler;
    follows a moved parent; save and load; pick order does not matter; a malformed node fails by name.
  - src/tests/model3d/SolidsWorkbenchPage.constructionPlanes.test.tsx, 4 tests: the rail; a Midplane
    through the selects that follows an edited parent, flips in its own Edit and reloads; a Midplane by
    two viewport clicks (XZ and YZ give 45 deg); At angle 30 about X, edited to 60 about Y.
  - The existing offset-plane, sketch3d, census, help, tree and rail files pass (286 plus 41 on
    re-run).
- Negative controls, all bite:
  - midplane origin at the first plane: 3 of 12 fail;
  - angle sign flipped: 3 fail;
  - no parent order: 1 fails;
  - no pick slots: 1 fails;
  - Apply ignores the kind: 3 fail.
  C4 and C5 were re-run on the final code.
- Checks: tsc clean; the dialog has only its existing warning. The page has 1 new react-hooks/refs
  warning (286 against 285 on main): the flatMap over the Offset plane entry, which reads
  selectedFacePickRef for its title, the same family as the page's 237 existing ones.
- Evidence stage37/01-05, opened. The midplane at z = 8 sits inside the block, so it shows only as a
  faint line through its sides; the notice names it. The run log's one console.error ("geometry engine
  initialization timed out ... attempt 1 of 3") is in the stage 2, 13, 15, 19, 20, 21, 23 and 24 run
  logs too: capture-harness noise, not this stage.
- Known: in Edit, the status line says "Edit offset plane" for a midplane or angled plane (the edit
  dialog state has no kind; the dialog title is right).

### Stage 38 - Drag the mirror plane in the view - READY TO LAND (8d6048564, evidence 674f56ec2)

- src/form/mirrorDrag.ts:
  - slideAlongNormal: where the pointer ray passes closest to the line through the grab point along the
    normal. Null when looking straight along the normal, and the plane then stays put.
  - slidMirrorAt: rounds to 0.01 mm.
- formOverlay: mirrorHitAt(x, y) is a raycast on the drawn plane square; rayAt(x, y).
- formInteraction:
  - The grab happens in the capture-phase pointerdown when nothing of the cage is under the pointer, the
    gizmo is not, the symmetry is a mirror and the Face tool is off.
  - It holds orbit off, captures the pointer, and each move calls the store's existing setSymmetryAt. No
    new store action, and no undo step: symmetry is not in the cage history, the same as typing the
    Mirror row.
  - FormPanel's existing hint line gains "Drag the mirror plane to slide it." while a mirror is on. It is
    a sentence in that line, not a new row.
- Tests:
  - src/tests/form/mirrorDrag.test.ts, 4 tests (the slide read square-on and oblique, an unnormalized
    normal, null along the normal, rounding);
  - src/tests/form/mirrorPlaneDrag.test.tsx, 3 tests: FormInteraction with a stub overlay and gizmo
    adapter. It covers press, drag and release; orbit off then on; the release is not a click; the cage
    wins; nothing is grabbed off the plane, on the gizmo, with the Face tool on, circular, or no mirror.
  - mirrorPlane and faceByClicks still pass (33 in total).
- Negative controls:
  - slide sign flipped: 3 of 7 fail;
  - no cage priority: 1 fails;
  - orbit left off: 1 fails;
  - release also treated as a click: did NOT bite, and needs none. A drag always passes the 4 px click
    slop, so the click path already refuses it; the early return is redundant for real drags. Recorded,
    not counted.
- Checks: tsc clean; eslint clean on the 6 files; tripwire CLEAR.
- Evidence stage38/01-03, opened. A box at X = 30, Mirror X at 0. Real mouse events press on a plane corner
  clear of the cage and of the Form panel. Mid-drag: X = 15, "26 points have no mirror partner". Released:
  X = 30, "8 seam points stay on the plane", every point paired. Then a press-drag on a cage point lying
  on the plane leaves it at 30 (the scenario throws if not).
- Found while shooting: ctx.shoot parks the mouse at (1590, 890) before each capture, which drags anything
  held. The mid-drag shot passes mouseX/mouseY to keep the pointer in place: note for any future
  mid-gesture evidence.

### Stage 39 - Loft rails - READY TO LAND (cb7e8ce0d, evidence 8c46b0fd0)

- src/form/loft.ts:
  - loftCage(profiles, count, rails): each rail, in model space and run from the first profile, ties the
    first ring's point nearest its start (its column).
  - Each profile's tied point sits at the arc length of its nearest point on the rail. An in-between ring
    gets the rail point at the interpolated arc length.
  - ringOnRails places the straight in-between ring. One rail: a scale about the ring centre across the
    loft axis, plus a shift along it. Two or more: the similarity (scale, smallest rotation, translation)
    taking the first two tied points onto their rail points. Then every tied point is set exactly on its
    rail.
  - The Pull includes every ring's tied points with the profile rings, so the skin passes through the
    rails at each ring.
  - railOf(profiles, candidate): open, both ends within max(1 mm, 5% of the loft length) of the first and
    last profile curves, in either direction.
- useFormSession startLoft: a sketch that railOf accepts goes to the rails and the loft is rebuilt;
  otherwise it is the next profile. The same sketch again, or an earlier one, starts a new loft, as before.
  The notice names the rails; the Loft tooltip explains rails.
- Tests: src/tests/form/loftRails.test.ts, 6 tests:
  - control: no rail, radius 10;
  - one bowed rail: every ring's tied limit point within 0.1 mm of the rail, middle swollen past 17, the
    opposite side too;
  - reversed rail gives the same result;
  - a sideways-crossing rail drawn either way gives the same result;
  - two rails: both sides on their rails, and the middle ring leans (its +Y side near (4, 14));
  - railOf cases.
  loft.test.ts still passes (10 in total).
- Negative controls, all bite:
  - rings ignore the rails: 2 of 5 fail;
  - rail points not pulled: 2 fail;
  - two rails treated as one: 1 fails after the lean check was added;
  - no rail reversal: 1 of 6 fails, after the sideways rail was added (the bowed rail's ends share a
    column, so it could not see this).
- Checks: tsc clean; eslint shows only useFormSession's existing warning; tripwire CLEAR.
- Evidence stage39/01-04, opened:
  - two circles r = 12, 40 mm apart, lofted straight: widest cage radius near the middle 12;
  - the Side rail sketch (an XZ arc bowing to X = 20) added with Loft: 20.32, notice "... along Side
    rail";
  - the smooth skin;
  - finished exact: 34 faces, 38 259 mm3 (the straight cylinder is 18 096).
  The run log's one console.error is the capture harness's known engine-init timeout (attempt 1 of 3; see
  stage 37).

### Stage 40 - A curved bridge band - READY TO LAND (4e8e7abd0, evidence ae86bd7f3)

- src/form/bridgeLoops.ts bridgeOpenings: the in-between rings follow a Hermite curve,
  h00 a + h01 b + h10 tA + h11 tB, per matched point pair. The end tangents come from bandTangents.
  - A closed chain (an opening, or a face set's outline) faces along its Newell normal (the normal of a face
    filling it), turned toward the other opening, or outward when square to the gap.
  - An open border faces along the surface running on across it (border face centre to border edge), and
    is used only when that heads toward the other opening; otherwise straight, so the band never folds back
    over its sheet.
  - Tangent length: the gap between the centres when aimed along it (then the Hermite curve IS the
    straight band, so every straight case is unchanged), up to twice the gap when square to it (a handle
    then rises about half the gap).
- Tests:
  - src/tests/form/bridgeCurve.test.ts, 3 tests: the handle rises between 52 and 58 over the 30 mm gap,
    highest in the middle; top to bottom stays straight and evenly spaced; two sheets edge to edge stay
    flat.
  - bridgeLoops and smallGaps pass unchanged (19 in total).
- Negative controls, all bite (re-run on the final code):
  - straight tangents only: 1 of 19 fails;
  - a closed opening never flipped: 2 fail;
  - tangents always gap-long (no lengthening): 1 fails.
  The open-border rule has no control: it differs only for a border whose surface points away at an
  angle, and no current fixture has one. Recorded.
- Checks: tsc clean; eslint clean; tripwire CLEAR.
- Evidence stage40/01-04, opened. A 4 x 4 x 4 box; two 2 x 1 face sets on its top selected; Bridge at 6 long:
  the cage top is 55 (was 40), notice "Bridged the two face sets (2 and 2 faces) with 36 faces, 6 segments
  long". The smooth skin shows a handle with the opening under it. Finished exact: 41 faces, 64 760 mm3.
  (The first try, with gap-long tangents, rose only 7.5 mm and read as a bump; hence the lengthening.)

### Stage 41 - Mirror duplicate - READY TO LAND (8a50f2a44, evidence de80ce4be)

- src/form/mirrorDuplicate.ts mirrorDuplicate(cage, normal, at) returns { cage, seam, dropped, across }:
  - points within max(1e-6, 1e-4 x the box diagonal) of the plane are snapped onto it and shared;
  - every other point gets its reflection;
  - faces entirely on the plane are dropped from both halves;
  - the copy's faces are reversed (their orientation is kept outward);
  - creases and weights are mapped to their mirrored edges;
  - compactWithMap drops points only a dropped face used;
  - across = points on the side opposite most of the form.
- formStore mirrorDuplicateForm:
  - plane: the mirror on (X, Y, Z or 'p'), else X = 0;
  - applies through applyCage (one undo step; an invalid result says "Not applied: ..." on the existing
    path);
  - then symmetryOn with that plane, keeping the duplicate's notice.
- useFormSession: a 'form-mirror-duplicate' button in the Symmetry group (a rail button, not a palette row).
- Tests: src/tests/form/mirrorDuplicate.test.ts, 6 tests:
  - an open half box gives exactly the full box (same point set and face count, closed, valid);
  - a closed half with a face on the plane: 4 faces join away, twice as wide;
  - creases are mirrored, and a point 1e-5 off the plane is snapped and shared;
  - a form across the plane reports the overlap;
  - store with no mirror: X = 0, mirror left on, no unpaired points, one undo;
  - store with a mirror at X = 20: the open half's outer face joins away, giving a tube open at both
    ends.
  mirrorPlane still passes (18 in total).
- Negative controls, all bite:
  - in-plane faces kept: 2 of 6 fail;
  - no snap tolerance: 1 fails;
  - copy not reversed: 5 fail;
  - mirror not left on: 1 fails.
- Checks: tsc clean; eslint clean (useFormSession keeps its one existing warning); tripwire CLEAR.
- Evidence stage41/01-04, opened. A 4 x 4 x 4 box with its -X half deleted (48 faces, open along X = 0) and
  its +X top corner pulled out (12, 6, 14). Duplicate: 98 points and 96 faces (the full box's counts),
  X from -32 to 32, "16 seam points shared", Mirror X on. The smooth skin shows two symmetric ears.
  Finished exact: 46 faces, 61 664 mm3.

### Stage 42 - Pipe along 3D paths - READY TO LAND (8b605b188, evidence 6f931edea)

- src/form/pipe.ts:
  - joinPaths(a, b, tol) joins b onto a at whichever two ends meet (b turned round as needed); it closes
    when the far ends meet too, and is null when either is closed or no ends meet.
  - pipeCage on a closed path: the rotation-minimising frame propagated back to the start (U[m]) is turned
    about T[0] by some angle, and -angle * i / m is spread over ring i. Planar loops have angle 0, so they
    are unchanged.
- useFormSession startPipe: pipeRef keeps the last pipe's path and sketch names. A selected sketch whose
  curve joins it (tol max(0.01 mm, 1e-4 x the length)) extends it; the notice reads "Pipe along A + B".
  Any other sketch starts a new pipe, as before. The Pipe tooltip and the straight-pipe notice say how.
- Tests: src/tests/form/pipe3d.test.ts, 4 tests: the joins (all four end pairings, the joint point once);
  closing and nulls; an L on XY carried up XZ gives a valid tube; a trefoil's seam turn is no bigger than
  1.5 x the largest turn between neighbouring rings. pipe.test.ts passes unchanged (11 in total).
- Negative controls, both bite:
  - no seam spread: 1 of 4 fails. The first fixture (a symmetric saddle) did NOT bite: its frame comes back
    untwisted by symmetry. Probed four loops (the saddle, a lopsided loop, a tennis-ball seam, a bent loop:
    all under 0.002 rad), then the trefoil: 2.59 rad at the seam against at most 0.27 between neighbours
    without the fix; 0.023 against 0.024 with it.
  - no turning round in joinPaths: 1 fails.
- Checks: tsc clean; eslint clean (useFormSession keeps its one existing warning); tripwire CLEAR.
- Evidence stage42/01-04, opened. "Floor bend" (an XY arc ending at (30, 0, 0) heading +X), Pipe: 31.4 mm.
  Then "Rise" (an XZ arc from there curving up to (50, 0, 20)), Pipe: "Pipe along Floor bend + Rise:
  62.8 mm", spanning Y 26.9 and Z 26.9. The smooth skin is one tube. Finished exact: 11 faces, 4917 mm3.
  (The automatic radius doubled with the path length, 2.5 then 5 mm; the Pipe row sets it.)
- Hit list, for the architect: Pipe along picked BODY edges needs the Model screen to hand Form the
  selected edges' polylines (TessBuffers edgePositions / edgeOffsets by edge id). Page work.

### Stage 43 - The Form palette's foldable groups - READY TO LAND (1716469f7, evidence fc8afffe4)

- FormPanel.tsx: the palette body is regrouped. PaletteGroup({ id, title, layout }) draws a slim header
  button (form-group-toggle-<id>, aria-expanded) and its rows when open. Children.toArray empty means no
  header, so Symmetry's header appears only while a mirror or circular symmetry shows its row.
- Groups and rows:
  - start: Segments, Extrude, Pipe, Revolve;
  - edit: Soft, Flatten;
  - topology: Crease, Loop at, Weld;
  - openings: Bridge, Thicken;
  - symmetry: Mirror, Circular;
  - display: Tolerance, Smooth.
- The folds use useToolPaletteLayout('form-palette'), stage 35's shared hook. form.css gains
  .form-group-header.
- Tests: src/tests/form/formPaletteGroups.test.tsx, 3 tests (each setting in its group and the name in
  none; fold, unfold and remembered; no Symmetry header until a mirror is on). formPanel, weldClose and
  loopPosition pass (21 in total).
- Negative controls, all bite:
  - folds ignored: 1 of 3 fails;
  - an empty group's header shown: 1 fails;
  - folds not remembered: 1 fails.
- Checks: tsc clean; eslint clean; tripwire CLEAR.
- Evidence stage43/01-03, opened: all open (13 rows, shell 726 px), Start from and Display folded (582),
  all folded (459; only the Name row and the status lines stay).

### Stage 44 - Face on a picked work plane; chain mode - READY TO LAND (c70811946, evidence 4427cae67)

- formStore:
  - faceTool.chain. commitFace carries the new face's last two corners, in click order, into the next
    draft when chained. addClickedFace now also returns `corners` (click order); the face itself may be
    reversed for orientation.
  - toggleFaceChain starts Add face chained when the tool is off.
  - setFacePlaneFromFace(face) uses the face centroid and its Newell normal.
  - The Face start notice mentions Alt+click and the chain.
- formInteraction: with the Face tool on, a click that began with Alt on a cage face sets the work plane
  instead of adding a corner.
- useFormSession:
  - startFace takes its plane from selectedSketch, else a new selectedPlane dep, else XY. A chained tool
    keeps its chain.
  - New rail button 'form-face-chain' (Chain, active while chained).
- SolidsWorkbenchPage: the selectedPlane dep is the selected tree node's datum-plane lastGoodFrame (any
  planeKind). Page warnings stay at 286.
- Tests: src/tests/form/faceChain.test.tsx, 5 tests:
  - Chain with the tool off starts chained;
  - after 4 corners the draft holds the last two in click order;
  - a strip clicked back and forth gives 3 faces and 8 points, a valid sheet;
  - chain off gives 4 corners again;
  - a box top face as the work plane gives Z = 30 facing up;
  - Alt+click through FormInteraction (stub overlay, real camera above the box) sets the plane, and a
    plain click adds a corner.
  faceByClicks passes unchanged (19 in total).
- Found by the first test run: carrying the last corner first turned a natural back-and-forth strip into a
  bow tie. It is now carried second-last then last, so the next corner goes beside the last one clicked.
- Negative controls, all bite:
  - nothing carried: 2 of 5 fail;
  - last corner first: 2 fail;
  - Alt+click ignored: 1 fails.
  The tree-plane dep is page wiring with no unit test; the evidence proves it.
- Checks: tsc clean; eslint clean; tripwire CLEAR.
- Evidence stage44/01-03, opened. An At-angle plane "Tilted 30" (XY at 30 deg about X) is inserted and
  selected in the tree; Face then Chain: "the plane of Tilted 30".
  - Real mouse clicks at 4 corners on the tilted plane: 1 face, 2 corners carried.
  - 4 more clicks back and forth: 3 faces, 8 points.
  - Alt+click the middle face: "Face: the work plane is now the plane of face 2".

### Stage 45 - From body: fewer rings on ruled faces - READY TO LAND (f464ddda7, evidence d1b2e5421)

- src/form/remesh.ts:
  - (A) ringGrid, ruled annulus: every straight line between matched rim points lies on the face (quarter
    points). Tolerance: max(1e-3 x the body diagonal, 2 x the rim's own chord sag between neighbouring
    samples), because matched samples can straddle facets. Then one ring (m = 1). With creased rims a
    two-row smooth skin runs straight.
  - (B) A quad face whose opposite sides a and b are straight AND creased, and which is ruled between its
    other two sides (checked at 0.25 / 0.5 / 0.75 across), asks one segment of a and b (want = 1). The
    union-find still gives the largest any neighbour wants.
  - Rim pairing: for each annulus with two closed resampled rims of equal count, the second rim's samples
    start at the point nearest the first rim's first sample (closestOnPolyline), so the samples pair along
    the face.
- First try, found by the existing remesh test: (B) on uncreased sides (fillet strips beside the flat faces
  of a filleted box) made those flat faces single quads, and the skin sagged 2.16 mm off the body. Creased
  sides only now. A spacing-relative tolerance (3% of h) called a quarter arc "straight" when h = 100 mm;
  it is absolute now.
- Tests: src/tests/form/remeshRuled.test.ts, 6 tests:
  - synthetic cylinder band: one ring;
  - synthetic cylinder band with its top loop starting 5 points round: every rim-to-rim edge vertical
    within 1e-6;
  - synthetic sphere band: keeps its rings;
  - real cylinder and cone: every point on a rim, the skin within 0.08 mm of the body, volume within 1%
    (-0.65% each);
  - real notched box: at most 16 points.
  remesh.test.ts (cylinder 44 points, -0.65%; filleted box unchanged, 480 points, 0.092 off; notched box
  14) and formFromBody pass (14 in total).
- Negative controls, all bite (re-run on the final code):
  - no ruled rings: 4 of 6 fail;
  - no sag allowance: 1 fails;
  - no ruled quads: 1 fails;
  - always one ring: 1 fails;
  - no rim pairing: 1 fails.
- Checks: tsc clean; eslint clean; tripwire CLEAR.
- Evidence stage45/01-03, opened. A cylinder r = 10, 30 tall (extruded in the model history). From body:
  36 points, 20 faces, no point between the rims. The first shot showed the twist (slanted generators); the
  re-shot after the pairing fix shows them straight. Finished exact: 15 faces, 9421.50 mm3 against the
  cylinder's 9424.78 (-0.035%).

### Stage 46 - Face packing: fewer faces, measured right - READY TO LAND (1ca6d8bd5, evidence 6defa91b6)

- Diagnosis (probes, recorded for the desk):
  - a one-ring cylinder cage of 8 (18) quads packed into 4 (10) side faces;
  - every pack stopped at 4 x 2 cells on a join gap of 4-7e-8 mm (JOIN_TOLERANCE 1e-11 x the size);
  - with the G1 pass skipped, 2 faces and gaps of 5e-15;
  - the G1 pass moved poles by 1.4-4e-7 mm there and improved nothing (1.2e-6 deg before and after).
  - Relaxing JOIN_TOLERANCE to 1e-8 was tried and rejected. It merged joins 2.9e-7 mm off, over the STEP
    file's declared 1e-7 mm uncertainty, and worsened the knob.
- src/form/g1.ts: a side is constrained only when its local G1 error is over 1e-4 deg (was 1e-6), 200 x
  under the 0.02 deg star-point target.
- src/form/knots.ts: removeKnots(input, tol, keep) keeps listed knots at multiplicity 1 at least.
  reduceSurface(..., minSpans) keeps at least minSpans spans each way, evenly.
- src/form/exactStep.ts: MIN_SPANS = 4 for packed faces. The kernel volume on the From-body cylinder's
  2-face side (unpacked and unreduced -0.654%):
  - full reduction: -0.810% (a fine mesh of the same file: -0.663%);
  - one knot a quad: -0.709%;
  - 2 spans minimum: -0.709%, and the torus kernel check fails (3.3e-5 against 3e-5);
  - 3 or 4 spans minimum: -0.654%.
  4 keeps the sphere's and bumpy box's reductions (4x, 20x); the torus's is 25x (was 40x).
- Tests:
  - src/tests/form/packRing.test.ts, 4 tests: one-ring cylinders of 8 and 18 quads give 2 side faces,
    joins under 1e-9 and a G1 move of 0; the knob is still G1 (under 0.02 deg, improved, moved); real
    kernel: the From-body cylinder is 2 packed faces with the same volume as the unpacked, unreduced
    file within 3e-5.
  - facePacking: knob edges bound 44 to 45 (the same 18 faces). formPerformance: torus 40x to 24x, with
    the reasons in the test.
  - All of src/tests/form: 54 files, 369 tests pass.
- Negative controls, all bite:
  - old 1e-6 threshold: 2 of 3 fail;
  - threshold 1 deg (the star point unfixed): 1 fails;
  - MIN_SPANS 0: the kernel volume test fails.
- Checks: tsc clean; eslint clean; tripwire CLEAR.
- Evidence stage46/01-03, opened. Stage 45's cylinder again: From body gives one ring (36 points); finished
  exact: 4 faces (2 flat, 2 B-spline; stage 45 had 15), 9421.87 mm3 against 9424.78 (-0.031%). A run
  before the MIN_SPANS guard read +0.60%.

### Stage 47 - Curvature display: measure and range - READY TO LAND (100884184)

- src/lib/viewport/lighting/curvature.ts: vertexCurvatures() returns curvedness and Gaussian (ac - b^2 of
  the same per-vertex shape-operator fit). ensureCurvatureAttribute also fills 'aGauss'.
- src/lib/viewport/lighting/zebra.ts:
  - CurvatureDisplay {mode, flatMm, tightMm}, held in shared uniforms (uCurvMode, uCurvFlat, uCurvTight);
  - setCurvatureDisplay(partial) keeps a value that is not a radius and swaps a reversed pair;
  - curvatureLegendMm, curvatureRampT and gaussianRampT follow the settings;
  - the shader's Gaussian branch: curvT = 0.5 + 0.5 sign(K) t(1 / sqrt|K|).
- WorkbenchDisplayMode.tsx: under the Curvature legend, a How tight / Gaussian radio and the two radii
  (blur or Enter applies). The legend reads saddle / flat-ruled / dome in Gaussian. The page asks for a
  render on change. No new palette rows. The flyout is not a Form palette.
- Tests:
  - src/tests/lib/curvatureModes.test.tsx, 5 tests: sphere 1/R^2; cylinder and plane 0; saddle
    z = x^2 - y^2 and the turned saddle z = xy both -1/R^2; aGauss filled; range, swap and keep; the
    Gaussian ramp; shared uniforms with no recompile, and the shader's signed branch pinned.
  - src/tests/model3d/workbenchCurvatureSettings.test.tsx, 2 tests: Gaussian legend and a render asked;
    typed radii move the legend, reversed ones come back swapped.
  - curvature.test.tsx: its pinned shader line now reads the range uniform.
  - With curvature, zebra and the display-mode projection test: 30 pass.
- Negative controls, 5, all bite:
  - Gaussian ac + b^2: 1 fails (it bit only after the turned saddle was added);
  - no swap: 2 fail;
  - the shader's sign dropped: 1 fails (after the pin was added);
  - no render asked: 2 fail;
  - no aGauss attribute: 2 fail.
- Checks: tsc clean; eslint clean on the changed files; the page stays at 286 warnings; tripwire CLEAR.
- Evidence stage47/01-03, opened. The pixels are read from above at radius 26 (a dome) and radius 14 (a
  saddle):
  - How tight: [193,214,35] and [204,214,33];
  - Gaussian: outside [241,186,26], red-ward; inside [10,159,234], blue-ward;
  - Tight radius 20: [235,46,31] and [235,46,31].
  The torus's volume in the Bodies list is 25266.19 mm3 (2 pi^2 R r^2 = 25266.2).

### Stage 48 - Exact G1 spike: degree-5 corner patches - PUSHED, NOT WIRED (aa5db5c75)

- The construction: each first-level quad's corner patch at an extraordinary point is raised from bicubic to
  degree 5. Rows 0-3 of its poles move. Rows 4-5 on the far sides stay those of the raised bicubic patch, which
  keeps C1 with the ordinary patches beyond.
- Along every boundary leaving the point: D_A(t) + D_B(t) = g0 (1 - t)^2 c'(t), with g0 = 2 cos(2 pi / valence)
  and the curve c of degree 4.
  - The constraints are linear and the same for x, y and z: the boundary poles are shared, c's fifth difference
    is 0, and the identity is imposed at 6 values of t.
  - Least change: x = x0 + Q^T (d - Q x0), Q the rows orthonormalized by modified Gram-Schmidt, run twice.
- Why this blend: with g(1) = g'(1) = 0 the fixed far rows are consistent at the ordinary end, because the
  neighbours are C1 there with a continuous twist. A linear blend is not consistent at any valence.
- src/form/exactStep.ts: rootGrids() is split out of formStep, so the bicubic grids can be read before the G1
  pass. formStep behaves exactly as before: g1, facePacking, packRing and exactSurface pass, 34 tests with the
  new ones.
- Tests: src/tests/form/g1Exact.test.ts, 4 tests (valence 3, 5, 6, 8+3):
  - the seam before is over 0.4 deg, after under 1e-8 deg;
  - every constraint is met under 1e-9 mm;
  - C1 with the neighbours holds under 1e-9 mm;
  - the surface moves under 0.1 mm.
- Negative controls:
  - linear blend g0 (1 - t): 4 of 4 fail (seam 0.07-0.10 deg, constraints off by up to 0.044 mm);
  - the degree-4 curve row removed: does NOT bite. On these cages the least-change solve keeps the curve at
    degree 4 unaided. The row stays in as the guarantee.
- Checks: tsc clean; eslint clean; tripwire CLEAR. No app change, so no headless evidence.

### Stage 49 - Exact G1 at star points, in the export - READY TO LAND (fe4b5d375, c743cdd02)

- src/form/exactStep.ts formStep(..., exactG1 = true):
  - exactG1Points picks the star points: every boundary there is smooth and shared by two faces, and no root
    there is flat (a flat root is written as a PLANE bounded by the bicubic curves).
  - g1AtExtraordinary runs with those points skipped.
  - exactG1Corners solves them on the implied grids.
  - Packing is as before, on the bicubic grids. A pack holding a solved corner patch is written at degree 5
    throughout: every root raised span by span (raiseRootGrid), its corner patches put in, and the pack
    reassembled with placeGrid.
  - Edge chains take the highest degree along them; a bicubic side is raised with raiseChain. Where a chain runs on
    as one edge is still decided on the bicubic sides.
  - New FormStep fields: exactG1Points, exactG1SeamDeg, degree5Faces. g1AfterDeg and g1SurfaceMoveMm cover both
    kinds of star point.
- src/form/knots.ts: removal, reduceSurface, reduceCurve, c1Knots, keepC1 and evalRow take a degree (3 when
  absent). Tiller's removal is written for any degree.
- src/form/g1.ts: g1AtExtraordinary and extraordinarySeamDeg take a set of points to skip.
- src/form/pack.ts: placeGrid exported, with the same placement as before.
- Tests:
  - g1Exact.test.ts, now 9 tests:
    - export: box, 6-sided cylinder and knob solve 8, 14 and 18 points; seam under 1e-8 deg; the same faces
      and edges as the bicubic file; degree-5 faces in the file; surface moved under 0.1 mm;
    - kernel: the knob and the 6-sided cylinder read back as ONE solid with the limit volume within 5e-4. The
      kernel's mesh normals across boundaries: bicubic file over 1e-3 deg, degree-5 file under 1e-5.
  - packRing: the star-point test now checks the bicubic pass with exactG1 false (it still moves poles, under
    0.02 deg), and the exact seam with it on.
  - formPerformance, re-pinned with the reasons in the test:
    - knob pole ratio 2.5x to 2.2x (degree-5 faces keep more poles per span);
    - knot-move bound 1e-9 to 3e-9 mm. It is a sum of per-removal errors; degree 5 makes more removals. The bumpy
      box's sum is 2.2e-9, still 45x under the STEP file's declared 1e-7.
  - All of src/tests/form before those re-pins: 57 files, 394 tests, 3 failing, all addressed above. The two
    files re-run after: 23 of 23 pass.
- Negative controls, all bite:
  - exact solve off: 6 fail;
  - corner patches not written into the raised grid: 2 fail (the kernel's normals show the bicubic seam);
  - bicubic edge curves on degree-5 faces: 2 fail.
- Checks: tsc clean; eslint clean on the changed files; tripwire CLEAR.
- Evidence stage49/01-03, opened. The lobed knob, finished in the app:
  - 24 faces, 28473.45 mm3 (stage 13: 28472.17);
  - the kernel's mesh normals agree to 6.6e-12 deg over 346 boundary points;
  - 10.3 s to the exact body;
  - zebra smooth at the valence-8 top centre, at a valence-3 rim point and over the whole knob.
  One console error: the known sandbox "geometry engine initialization failed (attempt 1 of 3)", recovered on
  retry.

### Stage 50 - Form palette docked beside the rail - READY TO LAND (aefd2a24d)

- FormPanel.tsx: the shell is an `aside.panel-right.form-palette-shell` (header .panel-header, rows in
  .form-palette-body which scrolls, .form-palette-footer), not a position:fixed modal-container.
- SolidsWorkbenchPage.tsx: it is mounted right before WorkbenchToolRail in the page's row, not among the floating
  dialogs.
- useFormSession: paletteAnchor removed (nothing reads it); the test stubs drop it.
- form.css: 300 px column, tokens only.
- Tests: src/tests/form/formPaletteDock.test.tsx, 2 tests:
  - the shell is an aside with the rail's panel class, no inline position, left, top or z-index, and keeps its
    header, rows and Finish row;
  - in the page source it is mounted once, right before the rail, with only comments between.
- Census: overlayCohesionCensus 138 to 137 and MODAL-GOVERNED 29 to 28, each with the reason beside it; the Form
  entry is removed from overlayDispositions; overlayRuntimeCensus's Form recipe asserts nothing of FormPanel floats.
- Negative controls, both bite:
  - the fixed inline position put back: 1 fails;
  - mounted back among the dialogs: 1 fails.
- Checks:
  - tsc clean; eslint clean on the changed files. The page is at 293 warnings, 293 before too: the baseline moved
    with the main merge.
  - Form .tsx tests and the two census files: 185 tests, 184 pass. The one failure is OVERLAY-RUNTIME-KEYS.md byte
    identity, which fails on origin/main identically (checked in a worktree).
  - tripwire CLEAR.
- Evidence stage50/01, opened:
  - the view 280-1040, the palette 1040-1340, the rail 1340-1600, zero overlap;
  - a click at the view's top-left, where the palette used to float, lands on the canvas.

### Stage 51 - Docked palettes fold; Relief docked - READY TO LAND (5a40a63b3)

- DockedPanel.tsx and dockedPanel.css (tokens only):
  - folded is `aside.panel-right.docked-panel.is-folded` (32 px) with a `-unfold` button;
  - unfolded, `-fold` sits in the header;
  - the fold is kept in `liencam.<id>.dock-folded`;
  - readPref and writePref are exported from useToolPaletteLayout for it.
- FormPanel.tsx uses it (id form-palette, 300 px).
- ReliefPanel.tsx uses it (id relief-palette, 320 px):
  - the height map is a `relief-map-group` with a `relief-map-toggle` chevron (useToolPaletteLayout 'relief-palette'
    section 'map');
  - ReliefMapPanel is a plain section (`relief-map-shell`), not a fixed modal-container.
  - useReliefSession: paletteAnchor and mapAnchor removed (nothing reads them).
- SolidsWorkbenchPage.tsx: the Relief palette is mounted beside the Form palette, right before the rail.
- Tests: src/tests/form/formPaletteDock.test.tsx, now 4 tests:
  - Form folds, and unfolding brings the rows and Finish back;
  - the fold is remembered across a remount;
  - both palettes are mounted once, right before the rail;
  - Relief is one docked aside with the map inside it: the map chevron folds only the map, and the column folds and
    unfolds.
  The census runtime Relief recipe asserts nothing of ReliefPanel floats and the map sits in the column.
- Negative controls, all bite:
  - a dead fold chevron: 2 fail;
  - a fold that is not remembered: 1 fails;
  - a dead map chevron: 1 fails.
- Checks:
  - tsc clean; eslint: no new warnings (the page 293 as before; ReliefPanel's one react-hooks warning was already
    there, line 88 before);
  - the relief tests, Form .tsx tests and census: 288 tests, 286 pass, 1 skipped, 1 fail. The failure is the
    runtime-keys byte check that fails on main.
  - tripwire CLEAR.
- Evidence stage51/01-05, opened. View widths: Model screen 1060; Form docked 760 (palette 300); Form folded 1028
  (strip 32); Relief docked with the map 740 (column 320, map 295); map folded 740; Relief folded 1028 (strip 32).

### Stage 52 - Docked palettes show that they scroll; panel audit - READY TO LAND (d9b02dbf2)

- dockedPanel.css, .docked-panel-body:
  - overflow-y auto, min-height 0, scrollbar-gutter stable;
  - ::-webkit-scrollbar 10 px, thumb var(--border-light) on var(--bg-panel-alt), hover var(--text-muted).
- shoot.mjs and tutorials.mjs launch Chromium with `ignoreDefaultArgs: ['--hide-scrollbars']`.
- Stage 51's evidence re-shot with scrollbars shown. It measures the Relief column scrolling: 1372 px of content in
  719 px, the wheel reaching the bottom (653 px), a 10 px bar.
- Stage 52 evidence, opened:
  - the audit at both sizes: 0 unreachable controls in every panel. At 1280 x 720 Relief with a picture has 40
    controls below the edge, all in its scrolling body (1372 of 539 px), bar 10 px;
  - the Relief palette absent before Relief, present in it;
  - scrolled to the bottom, the Place section and summary line reached (833 of 833 px).
- Test: formPaletteDock.test.tsx, now 5 tests. The docked body's CSS must scroll on overflow, keep its gutter, and
  draw a bar of at least 8 px with the light thumb.
- Negative controls, both bite: overflow hidden, 1 fails; a 5 px bar, 1 fails.
- Checks: eslint clean; tripwire CLEAR.

### Form capability list and remaining gaps

| Feature | LienCAM implementation | Gap | Cost |
|---|---|---|---|
| Starters | box, cylinder, quadball sphere, torus, plane, Pipe, From body, Face by clicks (stage 28) with chain mode and a work plane from the tree or a form face (stage 44) | - | - |
| Create from a sketch (extrude / revolve / sweep / loft a profile into a form) | Extrude, Revolve by an angle with segments (stages 15, 27), Loft (stage 32) with rails (stage 39); Pipe along a curve (stage 8) | - | - |
| Move / rotate / scale, multi-select, extrude | yes | - | - |
| Soft modification (falloff / soft selection) | Soft radius (gap tools) | - | - |
| Selection helpers: loop / ring select, grow / shrink, select all | click / Shift, Loop, Ring, double-click loop, Grow, Shrink, All (stage 12) | - | - |
| Insert edge loop | yes, at a typed position (stage 18), with a live slider (stage 31) | - | - |
| Insert point / subdivide a face | Insert point, Subdivide (stage 9) | - | - |
| Bridge two face sets / edge loops | Bridge two faces, face sets, openings or open borders, with segments (stage 20), twist (stage 30), curved band (stage 40) | - | - |
| Fill hole (cap an open loop) | Fill hole (gap tools) | - | - |
| Delete faces / edges (make openings) | Delete faces (gap tools), Delete edges (dissolve, stage 19), Delete points (stage 30), Unweld (stage 16) | - | - |
| Weld / unweld points | Weld selected points (stage 9), Weld close by distance (stage 14), Unweld edges / faces (stage 16) | - | - |
| Crease / uncrease | sharp and weighted (stage 6) | - | - |
| Symmetry | mirror X / Y / Z, circular, kept through Edit, click again to clear (stages 6, 10); plane moved along its axis or placed from points (stage 24), dragged in the view (stage 38); mirror duplicate (stage 41) | - | - |
| Thicken an open form into a solid | Thicken (gap tools) | - | - |
| Pipe along a path | Pipe along a sketch curve (stage 8), radius row (stage 30), 3D paths from sketch curves joined across planes (stage 42) | body edges as a path (page seam; hit list) | S |
| Convert a body's faces / a mesh into a form | From body (stage 6), curved faces remeshed into quads (stage 34), ruled faces as one ring (stage 45) | - | - |
| Flatten, straighten, make uniform, pull to points / surface | Flatten (best-fit, X / Y / Z, face or mirror plane: stage 26), Straighten (stage 17), Make uniform (stage 22), Pull through points (stage 29), Pull to body (stage 33) | - | - |
| Display: box / smooth, X-ray, zebra / curvature | cage / both / smooth, smooth level (stage 6), zebra stripes (stage 11), curvature (stage 21), Gaussian / range controls (stage 47) | - | - |
| Exact conversion | exact solid, C2 regular, G1 exactly at smooth star points (degree-5 faces, stage 49); under 0.02 deg where a crease or a flat face meets one (stage 13) | - | - |
| Face packing on convert | rectangles of quads with C1 joins are one face; edges pack too (stage 23); smooth joins no longer broken, a cylinder side 2 faces (stage 46) | non-rectangular packs (need trimmed faces; not recommended) | M |

Build order I proposed (value per cost): loop / ring select, Mirror Z + clear symmetry, delete faces + fill hole,
bridge, thicken, soft modification, insert point, weld, torus, pipe. Built through stage 9 except Mirror Z +
clear. Remaining by value (after stage 18): revolve angle and segments; make uniform; flatten to a chosen plane;
face packing.
(Sketch profile: stage 15. Weld by distance: stage 14. G1 at star points: stage 13.)

### Tests and proof (after the WO-2109 landing: merge c297c4b20, then stage 5 + tools)

- `npx vitest run src/tests/form/` -> 8 files, 90 passed / 0 failed (subdCore 20, editForm 14, formBody 13,
  planarAdjacency 2, topologyTools 12, exactSurface 5, exactSolid 12 - real kernel, openingTools 12).
  `npx tsc -b` clean; eslint 0 errors on every changed file; `node tools/blocker-tripwire.mjs --base
  origin/main --head HEAD` CLEAR.
- Shared-file slice on the merged tree c297c4b20 (258 files: every test naming SolidsWorkbenchPage,
  bodyLineage, formEdges, GeometryCache, the overlay censuses, plus src/tests/form and src/tests/help): 1994
  passed / 7 failed, all 7 red identically on a clean origin/main: overlayAuthoringLint (2),
  int17aR1ConsumerCensus (1), overlayRuntimeCensus OVERLAY-RUNTIME-KEYS.md (1), helpHotlinks.wo413 (2,
  ProbingPanel), overlayCohesionCensus (1, --pbn-chip-font) - main's WO-2063 / LinuxCNC work.
- Kernel equivalence (stack build vs shipped): see "Kernel: an 8 MB C stack".
- Negative controls this round (each mutation run against the committed file, restored after; every one
  bites unless said): flat regions not merged; collinear rim points kept; the rim walk check off; the
  T-junction guard off (formBody face rings) | crease edge points smoothed; edge points not shared; corners not
  the limit; every patch called exact; crease sector read as valence (exact patches) | flat quads as B-spline;
  edges not shared between faces; no faceted fallback; C0 (triple-knot) surfaces -> Shell red (exact solid) |
  the display filter's nearest-triangle fallback (its test was red before the fallback existed) | the
  stack-size kernel -> the slot-rim test and the two after it red on the previous kernel | loop / delete /
  fill hole / bridge / thicken / soft (openingTools). Controls that did NOT bite led to code being removed:
  the pinch guard (the rim walk covers it) and the loop's valence check (its one-way-straight-on rule covers
  it).

Earlier rounds (before the landing): see git history of this file (56 tests at 465eac54d, slice 2472 / 4).

### Shared (hub) files touched (vs origin/main after the WO-2109 landing)

- src/components/model3d/SolidsWorkbenchPage.tsx, 2 hunks: the Form import names buildFormBody instead of
  formFaceSet; the executor's 'form' branch calls buildFormBody (exact solid, faceted fallback) - 5 lines
  instead of 7.
- src/help/index-data.ts + src/help/topics/modeling/index.ts: the Form topic rewritten for Form inside the
  Model screen, the tools, and the exact body.
- Kernel (separate commits 9f41d62c2 + 57e5986b6): package.json (occt-wasm pin + comment), package-lock.json
  (path + integrity), vendor/occt-wasm/occt-wasm-3.6.1-geo9-iges-history-stack.tgz (new), patches/README.md +
  patches/occt-wasm-3.6.1-stack-size.patch (new), NOTICE-GEO9.md (one section).
- Everything else is Form's own: src/form/*, src/components/model3d/form/*, src/tests/form/*,
  src/tests/evidence/FORM/*.

For the operator's eye: the exact ring block (a hole bridged through a box) - stage5/03; the ops part - stage4b-ops/01
and 02; the kernel decision (land the 8 MB stack build or not); the two ops that never finish (fillet after a
Push/Pull of the slot floor, Shell on the whole part) - a kernel time limit / cancel would be a Model-screen
work order; the up-to-2-degree kink at extraordinary points of the exact body (G1 there needs higher-degree
patches). Earlier: the knob body - stage1R/07; form mode in the Model screen - stage1R/02; Alt-drag extrude -
stage2/05.
