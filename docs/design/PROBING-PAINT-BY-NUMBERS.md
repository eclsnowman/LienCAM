# Probing, paint by numbers, with a Z component (WO-2034)

Status: PROPOSED. The build orders in section 5 wait for the operator's verdict on the
pictures in `src/tests/evidence/WO-2034/` (screen-*.png: the Probing screen
mockup, one step at a time; one PNG per routine; `steps.html` holds them all). No motion changed in WO-2034.

the operator, at the machine, 2026-09-26 ~8:55 AM CT: "how do we handle probing multiple
sides of stock if the tool probing never changes Z? ... for the more complicated
probes like bosses or surface meshing we need a z component ... do an entire
runthrough of probing, ensure it is paint by numbers with diagrams for the user,
and that it uses logical defaults."

## 1. How the run-through was done

- Code read at branch base f621a0537 (`probeFeatureCycle.ts` = PFC,
  `ProbingPanel.tsx` = PP, `machineSession.ts` = MS).
- Every routine was then RUN through the production planner the Run button uses
  (`planFeatureProbeCycle`, with the screen's own defaults) and the production
  runners (`runFeatureProbeCycle`, `runZProbeCycle('workZero')`,
  `runSurfaceMeshProbeCycle`), through the real `UccncController` on the NATIVE
  probe route (no G-code text: `probe`, `jogToMachineZ`, `jogToWorkXY`,
  `setWorkOffset` on the wire), against a fake board carrying solid geometry: the
  stock, a round boss, a bore, a rect boss and a rect pocket. Every commanded Z and
  every collision is captured from the wire.
  Test: `src/tests/machine/probingRunThrough.wo2034.test.ts` (15 tests).
  Negative control: removing the boss from the board turns both boss pins red.
- Tool Z (the setter) was not re-run here: its native wire is already pinned by
  `setterCrossingRapid.wo2017.test.ts` and `toolSetterWireReview.wo1613.test.ts`,
  and it was measured on the native rehearsal board on 09-26
  (`.planning/native-probe-rehearsal.md`: setter at X 738 Y 724.5, retract ran).
- The simulator (text route): the SAME plan runs as text. Position steps are
  `G21 G90 G53 G1 <axes> F<positioning feed>`, touches are
  `G21 G91 G38.2 <axis><dist> F<fast>`, back-off `G91 G0`, fine `G91 G38.2`
  (MS `runFeatureProbeCycle`, `executeDirectionalProbeTouch`). Same targets, same
  Z. The simulator has no part geometry, so it cannot show a miss or a collision;
  the fake board above can.

Defaults every run used (a fresh machine; `toolTable.ts` DEFAULT_MACHINE_PROBE_DEFAULTS):
positioning 1000 mm/min, fast 400, slow 50, retract 2, max travel 50, surface
clearance 5, overtravel 5, cross-over lift 10, pad thickness 10. the operator's machine
has max travel 100 and fast 300 (his overrides; the 09-26 Edge incident).

## 2. The run-through record - today

Where: Control > Probing holds Edge, Z surface, Inside corner, Outside corner,
Bore, Boss, Rect pocket, Rect boss, Angle, Tool Z (PP ROUTINE_OPTIONS ~:985).
Probe work Z0 is NOT on that screen - it is on Control > Tools (ToolsProbePanel).
Jogging is on Main, so every setup today is Main (jog) -> Probing (run) -> Main.
The editable routines (Control > Routines, WO-411 factory routines) follow the
same "park at probing depth" pattern (probeRoutineFactory.ts ~:138, :187, :232).

| Routine | What the operator must do first | What the machine does | Every Z it commands | Record (test) |
|---|---|---|---|---|
| Z0 (Tools) | Jog over the stock | Probe Z- fast from where it stands (to the machine Z bottom, or max travel), back off 2, fine touch, write Z0 = contact - pad, back off 2 | Descends from start Z; ends 2 mm above the touch | Contact 30, Z0 written at 20: the default 10 mm PAD is subtracted even when the tip touched the part directly |
| Edge | Jog OUTSIDE the face, "at probing depth" (PP ~:2484) - a depth the screen never states or asks for | One X or Y touch, search = max travel (50 default, 100 on the operator's machine) | NONE - start Z only | From 5 below the top: face at 200.000 (exact). From a safe height: passes over the part, no contact |
| Edge default | - | Direction default is X- (PP ~:1355): it touches the RIGHT face | - | Standing left of the part with the default: probes away, misses |
| Inside corner | Jog inside the corner at depth | X touch, back off, Y touch from there | NONE | Lands both walls (619.000 / 439.000) |
| Outside corner | "Clear of both faces at probing depth" | X touch then Y touch from the SAME point - never goes around the corner | NONE | From diagonally off the corner: the X touch runs in front of the part and misses. The routine cannot work from any single start point |
| Angle | Jog to point 1 at depth | Touch, move along the face 25 mm (XY only), touch | NONE | Two touches at the start Z |
| Bore | Jog to the centre at depth | 4 wall touches, back through centre between them | NONE | Lands all four at depth; from a safe height finds no wall |
| Rect pocket | As Bore | As Bore | NONE | Lands all four |
| Boss | Jog outside the X max face, centred on Y, at depth (PP ~:2480) | Lifts `start Z + 10` (PFC :285) to cross over, lowers back to start Z | start Z and start Z + 10 | 5 below the top: fine. 12 below the top: cross-over at 2 mm BELOW the top - drives through the boss (collision recorded) -> WO-2035 |
| Rect boss | As Boss | As Boss | As Boss | 5 below the top: fine |
| Z surface mesh | Jog to a safe Z, load a program | Every traverse at the machine Z held when Run was pressed; each point probes down up to max travel (50); point 1 writes Z0 | Traverse Z = wherever he stood | 9 points x 2 touches, all traverses at the start Z; each search aimed 50 mm down |
| Tool Z | Nothing (tool in spindle) | Lift to crossing Z, cross to setter, guarded approach, fast + fine, back to crossing Z | Crossing Z, approach, touch | Already has a proper Z component (WO-1613/2017/2021) |

Other defaults found:
- Tip radius: the active tool's library diameter / 2; with no diameter in the
  library it stays at 1.5 (PP ~:1341-1353). the operator's probe is T19, a 1/8 in tool:
  radius 1.5875. The library had no diameter for T19 on 09-26 (machine seat), so every result was
  0.0875 mm off per side.
- No way to say a face is sensed through a plate (09-26 incident: anodized part,
  plate 3.16 held on the face; workaround tip radius 1.5875 + 3.16 = 4.7475).
- Single-direction searches (Edge, corners, Angle) run the whole max travel;
  4-side routines are already bounded by clearance + overtravel (PFC :368). -> WO-2036.

## 3. Findings (what the design fixes)

1. Side routines never move Z. The depth is whatever height the operator left
   the probe at, and the screen never says what that should be.
2. Outside corner cannot work: it needs to go around the corner and does not.
3. Boss / Rect boss cross over at start + 10, unchecked against the boss (WO-2035).
4. Z0 lives on another screen and subtracts a 10 mm pad by default.
5. Mesh traverses at whatever Z he stood at and searches 50 mm per point.
6. Defaults point the wrong way (Edge X- = right face; corners X- Y- = back-right).
7. Tip radius falls back to 1.5 instead of the probe's real size.
8. No plate option for faces the probe cannot sense electrically.
9. Jog is on a different screen from every probe it sets up.

## 4. The proposed design

### 4.1 One model for every side routine: top, safe height, probing depth

Every routine that touches a side knows three heights, all measured from the TOP
of the feature being probed:

- Top of the feature. Default: TOUCH IT - the routine's first move is a Z touch
  at the start point (Edge, corners, Angle, Boss, Rect boss start OVER the
  material). For Bore, Rect pocket and Inside corner the start is over the hole,
  so the default is "use work Z0" (the hole is in the top face Z0 was probed on);
  the other choice is "touch the rim first" (jog over the rim, press Touch top).
- Safe height = top + clearance. Default clearance 5 mm. Every XY move happens at
  or above it, whatever the routine.
- Probing depth = top - depth. Default depth 5 mm. Every side touch happens there.

And every descent to probing depth is itself a PROBE move (stops on contact,
like the setter's guarded approach): if the operator started too far in and the
descent lands on the part, it stops and says "the descent touched at Z ... -
start closer to the edge". Nothing is refused up front (rule 11); motion is
simply bounded and honest.

### 4.2 Where the operator starts (the only thing he does by hand)

- Edge, Outside corner, Angle, Boss, Rect boss: OVER the material, within the
  start distance of the face (default 10 mm), at any height above it. The routine
  steps out by start distance + tip radius + clearance (16.6 mm with defaults)
  before descending. For Boss the start is over the middle (by eye); the step-out
  is nominal radius + tip + clearance.
- Inside corner, Bore, Rect pocket: over the hole/pocket (by eye), within the
  start distance of the walls (corner) or near the centre (bore), any height.
- Z0 and Mesh: over the stock (Mesh: over point 1), any height.
- Tool Z: nothing.
Every XY search then ends start distance + overtravel past where the face should
be (WO-2036's rule, applied to the stepped-out start).

### 4.3 How the face is sensed

One choice per routine, remembered per machine: "(o) the probe touches the part"
or "( ) a plate held against it (thickness T)". The plate thickness comes from the
tool table's pads (WO-1979), the same field Z0 uses (two lenses, one stored
field). A plate adds T to the tip radius on side touches and subtracts T on Z
touches. First-time default: probe touches the part (0 mm) - which also fixes Z0
subtracting 10 mm when there is no pad.

### 4.4 Logical defaults

| Setting | Today | Proposed | Why |
|---|---|---|---|
| Edge | X, direction - (right face) | X, left face (probe moves X+) | X0 is normally the left face |
| Corner | X- Y- (back-right) | Outside, front-left (X+ Y+) | The usual G54 origin |
| Angle | Face along X, probe Y- | Front face, probe Y+, point 2 at +X | Same corner convention |
| Tip radius | Tool library dia / 2, else 1.5 | The probe tool's diameter / 2; if the library has none, ask ONCE on the Probing screen and write it to the tool table | T19 = 1/8 in = 1.5875 radius |
| Clearance above top | none | 5 mm | |
| Probing depth below top | none | 5 mm (Boss: min(5, boss height - 1) when the height is typed) | |
| Start distance from face | none | 10 mm | |
| XY search | max travel (50/100) | start distance + 5 | WO-2036 |
| Z0 pad | 10 mm | per the sensing choice (0 when the probe touches the part) | 4.3 |
| Z0 end | 2 mm above the touch | top + clearance | ready for the next routine |
| Mesh traverse | Z where he stood | point-1 top + clearance | 4.1 |
| Mesh search per point | 50 mm | clearance + 5 (largest height change, editable) | bounded |

### 4.5 The screen: one step at a time (revised after the operator's card, 2026-09-26 11:10 AM CT)

the operator approved the CONCEPT of the diagrams and asked how the screen uses them
without clutter. Answer: the screen never lists the steps. It shows ONE step.

- ONE step on screen: one large side-view picture, and above it one short
  sentence in large text with the step's YOU or MACHINE tag. Nothing else about
  the step is shown until asked for.
- A compact numbered step strip under the picture: 1..N, YOU steps marked
  "YOU". The strip says which mode it is in, in words (outside UI audit,
  2026-09-26 12:15 PM CT): **"Preview steps"** before Run - the operator pages
  the steps (Back / Next, or press a number) to see what is coming - and
  **"Live progress"** while a routine runs - the screen follows the machine
  step by step by itself and paging is off. The current step is the larger chip
  with a heavy outline; a done step carries a tick; so current, done, coming and
  YOU read by shape and word, not by colour alone. "Step n of N" sits under the
  mode name. A long routine (Boss: 23 steps) shows a window of chips round the
  current step, with the first and last numbers at the ends.
- Every side view has a top view at the top of its right-hand column: the part
  from above, the probe as a dot, the face this step works on lit, and the
  step's move drawn when it is along X or Y. The top view is large (about 214 x
  244 px on the reference sheets, 255 x 290 px on the screen), its marks heavy
  (probe dot, 9-unit face line, 5-unit move line), and its title row carries X
  and Y arrows showing which way X+ and Y+ run on the part. The axis the side
  view looks along is the bright one; the other is grey (outside audit round 3,
  MUST 2).
- A heading beside the picture, at the right-hand end of the sentence line,
  names the view: **"SIDE VIEW: X"** with an arrow and "X+" in the X colour
  showing which way X runs across the picture, or "SIDE VIEW: Y" in the Y
  colour. It always matches the top view's bright arrow (round 3, SHOULD 6).
  Every move in the side view also carries its direction in words (X+, X-, Y+,
  Y-, Z+, Z-).
- The top view becomes the MAIN picture (heading "TOP VIEW") for each step
  whose one move is a horizontal positioning move at safe height, in the
  routines that probe more than one face or point (Outside and Inside corner,
  Angle, Bore/Rect pocket, Boss/Rect boss). Round 3 MUST 2: "promote it to the
  main picture whenever horizontal positioning is the step's main action." That
  is Outside corner 5, 9, 10; Angle 5 and 10; Boss 5, 9, 13, 14, 18, 21. (Inside
  corner and Bore have no such move: every one of their horizontal moves is a
  touch.) The part is drawn from above, framed on the move so even a short move
  is drawn long, the probe to scale, the move with its axis, direction and
  length on it ("X- 16.6 mm"), the part named, and "at safe +5 / tip clearance"
  plus the X/Y arrows in the right-hand column. Touches and moves at depth stay
  side views: their depth below the top is the point of this whole design.
- A compact **picture key** says what the marks mean (round 3, SHOULD 5). Each
  sample is drawn with the pictures' own classes: faded probe = where this step
  starts; solid arrow = moves to a position; dashed arrow = probes, stops at the
  first touch; dotted arrow = you jog the probe here; orange dot = where it
  touched; numbers 1 2 = two moves, in this order (round 4). On the screen it is a "Picture key" disclosure in the right-hand
  column. It and "More about this step" open one at a time, so they fit under
  the jog pad. On the reference sheets it is one row under each routine's setup.
- Every height line says what it measures to (round 2, item 6): "safe +5 / tip
  clearance" (the tip is on the line), "depth -5 / probe centre" (the ball's
  centre runs on the line), Tool Z's "crossing Z / tool tip". All lines meet
  their words the same way: a solid leader the same length into the right-hand
  column, the same gap before the word (round 2, item 3).
- **The jog pad is on the Probing screen on EVERY step**, YOU and MACHINE, at
  the top of the right-hand column (the operator 09-26 12:35 PM CT; COHESION-STANDARD
  22). It is the Main screen's Jog panel, the same component, and the mockup
  shows a capture of it from the running app, not a drawing.
- One control, one look (COHESION-STANDARD 22). The Position (DRO) panel, the
  E-STOP / CYCLE START / Feed Hold / Stop-Reset row and the app bar with the
  Control tab row are the Main screen's own components. The mockup places
  captures of them from the running app (`capture-main.mjs`, simulator: software
  stop cleared, homed, work position set by MDI) at their own pixel size. The
  DRO is at the top of the left-hand column. The E-STOP row is under the step
  strip, beside "Preview steps / Step n of N". The probing routine starts from
  that row's **CYCLE START**: the YOU step reads "Press CYCLE START to run Edge."
  The Probing screen gets no Run button, DRO strip or E-STOP of its own. Today's
  Probing tab has all three, each in a different look from Main (see
  `real-probing.png`).
- The picture takes all the height the step card has, so it is as large as the
  screen allows. Longer explanation sits behind "More about this step" in the
  right-hand column, under the jog pad and the picture key. Opening it never
  changes the picture or its words (outside audit round 2, item 5): the picture
  is 704 px tall with More closed and open, and nothing is pushed off the screen
  at 1920x1080. It uses the
  app's own DisclosureSection (COHESION-STANDARD 5). No pop-up, no modal, no
  nested scroll region (COHESION-STANDARD 5 and 21). Refusals and "why it
  stopped" still go to the console (COHESION-STANDARD 13-console), not here.
- **Are these help pop-ups? No. There are no pop-ups.** The picture and its
  sentence ARE the screen; "More" opens in its column and closes again.
- The left column keeps the routine picker and that routine's setup values
  (face, top, sensed by, depth, clearance, start distance, tip radius, work
  offset) - values only, per COHESION-STANDARD 21.
- Z0 is the first routine on the Probing screen (it stays on Tools too, same
  code). A side routine that uses "work Z0" as its top says which Z0 it will use
  and when it was set.
- Confirm stays the only writer of work offsets; Edge/corner/boss results offer
  Z0 from the top touch as a ticked option.

Mockup captures (static HTML built on the app's real CSS, 1920x1080,
Playwright; the app bar, DRO, jog pad and E-STOP row are captures of the
running app): `src/tests/evidence/WO-2034/screen-edge-1-you.png` (Edge step 1,
YOU, picture key open), `screen-edge-7-machine.png` (Edge step 7, MACHINE,
running, strip showing 1-6 done, jog pad still there),
`screen-edge-7-more.png` (the same with More open in the right-hand column).
Edge step 1 with More open is checked on every run but not captured. The
mockup is a picture of the design, not the product. The app bar, tab row and
DRO follow who acts (final outside audit, MUST): a YOU step shows them captured
with the app Idle; a MACHINE step shows them captured while a real Edge X+
probe move ran on the simulator - status "Running", DRO mid-move short of the
face, feed 300 mm/min (`real-chrome-running.png`, `real-dro-running.png`).
`draw.mjs` refuses a screen whose captured status does not match its step's
owner. One limit of a static capture remains: CYCLE START shows its idle look.

### 4.6 Styling: the app's own tokens (COHESION-STANDARD 1, 9, 14)

The pictures and the mockup link `src/theme/tokens.css` and
`src/styles/app.css` and name tokens only (no raw colour in `draw.mjs`); the
self-hosted DM Sans and JetBrains Mono load as in the app. Where a class for
the job already exists on today's probing diagram it is reused.

| Element | Token / class |
|---|---|
| Picture ground | `--surface-2` (as `.control-probe-diagram`) |
| Stock, boss, hole | `.control-probe-diagram-stock` / `-boss` / `-hole` |
| Probe ball | `.control-probe-diagram-probe-ball`, `--text-primary`; stem `--text-secondary` |
| Where the step starts (ghost) | `--text-disabled`, faded, plus a dashed `--text-secondary` outline drawn over the current shaft so a descent's start still shows |
| Move arrows | `.control-probe-diagram-arrow-shaft/-head/-casing`, coloured by axis `--vp-axis-x/y/z` (today's convention); probe move dashed, positioning solid; a vertical move runs beside the shaft |
| Direction words (X+ ... Z-) | axis colour, on a plain `--surface-1` chip |
| Picture words | one size (26 px in the picture's units) and one weight (`--weight-semibold`), plain - no outline; words inside the drawing sit on a plain `--surface-1` chip |
| Label gutter | `--surface-1`, uniform, divided from the drawing by `--border-strong`; material ends at the divider |
| Top view | `--surface-2` ground, `.control-probe-diagram-stock/-hole/-boss`; the face in play `--select-viewport`; probe dot `--text-primary`; found points `.control-probe-diagram-touch-landed` |
| Tool Z | holder `--border-strong`, shank `--text-secondary`, fluted cutter `--text-primary`; setter `--select-viewport` (named "setter"); clearance dimension `--text-primary` |
| Jog (YOU) arrow, top-view zone | `--role-identity-light`, `--role-identity` |
| Touch mark | `.control-probe-diagram-touch-landed` (`--select-viewport`) |
| Top line | `--text-primary`, solid, word "top" |
| Safe height line | `--hue-plane` (the clearance-plane hue), long dash, words "safe +5 / tip clearance" |
| Probing depth line | `--violet-300`, dotted, words "depth -5 / probe centre" |
| Height-line leaders | each line's own colour, SOLID, 12 px into the gutter, word 8 px after it |
| YOU / MACHINE tags | STATUS family (section 9): flat, borderless 14% wash; YOU `--text-active`, MACHINE `--role-live` (the machine is moving); the word is the second channel |
| Current step chip | larger chip, 3 px `--text-primary` outline, `--surface-selected`; done: tick + `--status-ready` border; mode name `--text-primary`, live dot `--role-live` |
| Step sentence | 24 px, `--text-primary` |
| View heading | 22 px bold caps `--text-primary`, `--border-strong` outline; the axis arrow and "X+"/"Y+" in `--vp-axis-x/y` |
| Top-view X/Y arrows | `--vp-axis-x/y`, the side view's axis bright, the other `--text-secondary` |
| App bar, DRO, jog pad, E-STOP row | NOT styled here: the real components (captures of the running app), per COHESION-STANDARD 22 |
| Other panels, fields, buttons | `.panel.control-panel` / `.panel-header` / `.panel-title`, `.mform-input` / `.mform-select`, `.modal-btn-*`, `.disclosure-*` |

Section 14 holds: this is presentation; the build order that draws it (9)
changes no motion.

### 4.7 Readable at a distance (COHESION-STANDARD 17, 13-pixels)

Minimums after the outside UI audit (2026-09-26 12:15 PM CT, architect scoping:
setup fields, jog increments and chrome stay the app's standard size so the
screen matches the rest of the UI; the step itself is what is read from a
distance). Measured in the page before every capture; the capture refuses if
any fails:

- Step sentence >= 24 px (rendered 24 px), contrast >= 7:1.
- Step-strip numbers >= 22 px (rendered 24 px; current step 28 px), contrast
  >= 7:1 on the chip behind them.
- Every picture word >= 20 px as rendered (screen 28.8 px, the same with More
  open; reference sheets 24.2 px).
- "More" text, its heading and the strip's mode name >= 18 px, contrast >= 7:1.
- At most three height lines and ONE move per picture (side view; two only as
  numbered below), and at most
  one move in its top view. Steps that did more than one thing are split: Angle
  9 -> 13 steps (back off, rise, move 25 mm X+ to point 2, descend, probe, rise
  and show the angle through both points); Boss 12 -> 23 (each face: out, down,
  probe, up; the Y faces as their own steps; ends over the centre showing
  centre and diameter); Bore's Y probes and the mesh's rise are their own steps.
- The picture shows ALL of its sentence, and each step starts where the one
  before it ended (outside audit round 4, MUST 1 and SHOULD 2). A sentence
  that says two moves in a row ("backs off 2 mm and touches again", "probes
  to the wall, then back to the middle", "backs off 2 mm, then rises") draws
  both, numbered 1 and 2 in the order they run, in a ring beside each move's
  direction word; never more than two. So Z0 step 4 starts at the touch,
  rises 2 mm (1) and probes down slowly (2); Bore 5-8 and Inside corner 5
  probe out (1) and come back to the faded start (2); every rise after a side
  touch (Edge 8, Outside corner 8 and 13, Inside corner 7, Angle 13, Boss 8,
  12, 17, 21) first draws the 2 mm back-off (1), then the rise (2). Tool Z's
  "fast then slow" is two steps: the touch (4), then back off 2 mm and touch
  again slowly (5); Tool Z is 6 steps. A 2 mm back-off is shorter than the
  ball, so it is drawn in a lane just under the balls, at least 52 px long,
  its word giving the true distance ("X- 2 mm"); a short Z move is drawn at
  least 110 px long beside the shaft for the same reason. Checked on every
  step of every routine before anything is written (refused otherwise): each
  step's start is the previous step's end (a change of view axis, or the
  mesh's "after the last point", excepted); move 2 starts where move 1 ended;
  the faded probe is where move 1 starts; a sentence with "then" or "and
  touches again" has exactly two moves, any other at most one. In the page:
  two moves only when numbered 1 and 2 with their rings drawn, no move arrow
  under 36 px, every move clear of the probe tip and the touch mark.
- The screen fits 1920x1080 with More or the key open. The columns reach the
  foot of the window and the picture fills its card (704 px tall). It is
  refused if more than 40 px of the picture box or 20 px of the card is left
  empty, or the columns end above 1060 px. More and the key do not change the
  picture: the same step with them closed and open must draw it at the same
  height (refused otherwise). Each side column must hold what is open without
  running past its space (refused otherwise; also checked on Edge step 1 with
  More open under the jog pad, 179 px to spare).
- The real components (round-3 fix round, the operator 12:35): the app bar, DRO, jog
  pad and E-STOP row must each be on the screen, loaded, and drawn at exactly
  their captured pixel size (refused if missing, not loaded, scaled or off the
  screen). The jog pad is required on every captured step, MACHINE steps too.
- The view heading and the top view (round 3): every picture has a heading
  (refused if not). A top view as the main picture must be headed "TOP VIEW".
  A side view's heading must name the axis its inset marks bright (refused
  otherwise). Every top view carries both an X and a Y arrow. The inset renders
  at least 200 x 220 px. Top-view move lines render at least 4 px thick, and
  top-view probe dots have a radius of at least 8 px. In the multi-face
  routines, a horizontal positioning move at safe height drawn as a side view is
  refused.
- Picture key words and view heading text: >= 18 px and >= 20 px, contrast
  >= 7:1.

Layout, also measured before every capture:

- As large as the space allows: each routine picks one scale from what its
  steps show (probe, moves and their words, touches and their words, its height
  lines, 2.5 mm of material below the lowest), the same for all its steps so the
  picture never jumps between steps. The same margin all round; the looser axis
  is centred.
- One uniform label gutter right of the drawing: the top view at its top, the
  height-line words below. The material ends at the gutter's edge (refused if
  any material reaches past it). Every height line meets its word the same way:
  a solid leader from the gutter's edge, all leaders ending at one x, every word
  the same gap after it (refused if a leader is not solid, ends elsewhere, or a
  gap differs by more than 1.5 px or falls outside 4-10 px).
- Each line names its probe reference, and the drawing agrees: refused if
  "tip clearance" / "probe centre" / "tool tip" is missing, if a probe sits
  centred on the safe line, or with its tip on the depth line.
- A step whose only move is along the other axis (the side view cannot show it)
  draws the top view as the main picture (refused if the move is only in the
  small inset, or shorter than 300 px).
- The jog arrow is short: a fixed 90 px, from just up and right of the probe to
  the ball's edge (refused over 140 px).
- A vertical move is drawn beside the shaft (the shaft would hide it), at most
  150 px, ending level with the tip; a horizontal move runs from the start
  ball's edge to the end ball's edge. Every move keeps 3 px clear of the probe
  tip and the touch mark (refused if any point of it runs under them).
- Nothing overlaps: a word or the top view touching any other word, probe part,
  move, touch mark or height line refuses the capture. Words stay 8 px from the
  picture edge; probe tips, moves and touch marks stay 8 px inside the drawing.
  A direction word goes above its move, or under it when a short move leaves no
  room between the two shafts; a vertical move's word goes where no height line
  runs.
- The strip's mode name reads "Preview steps" / "Live progress" as the state
  says, done steps carry a tick (count checked), and the current chip is the
  larger one (all refused otherwise).
- Negative controls, each refused for the right reason: material run into the
  gutter; vertical arrows drawn over the shaft; a horizontal arrow run into the
  ball ("move arrow runs under the probe"); strip numbers at 16 px; done ticks
  removed; the picture pinned to 420 px (its words fall to 18.2 px). Round 4:
  a dashed leader; the top leader 6 px longer; "probe centre" removed; the
  depth line at the ball's bottom; Angle step 10 back in the small inset; More
  back under the picture (674 -> 516 px). Round 5: the jog pad only on YOU
  steps ("the real jog capture is not on the screen"); the jog capture scaled
  to 260 px ("drawn at 260x304, not its own 280x327"); no top-view promotion
  ("a horizontal positioning move is drawn as a side view"); the inset without
  its arrows ("the top view has no X arrow"); the heading always X ("heading
  says SIDE VIEW: X but the inset marks Y"); the inset back to its old size
  ("renders 171x171 px (min 200x220)"). Earlier rounds: jog arrow 200 px;
  lines ending 30 px short; "touch" on the probe.

### 4.8 The per-routine pictures (reference for the verdict)

`src/tests/evidence/WO-2034/`: z0.png, edge.png, outside-corner.png,
inside-corner.png, angle.png, bore.png (Rect pocket: same), boss.png (Rect boss:
same), mesh.png, tool-z.png - every step of each routine as it would appear one
at a time, in the new styling. Tool Z shows the active tool as a cutter (holder,
shank, fluted end mill) over a named setter, with the crossing Z as the height of
the tool's lowest point and the clearance to the part top dimensioned. Regenerate: first the real-component
captures, `node src/tests/evidence/WO-2034/capture-main.mjs` (boots this
checkout's app on a throwaway port, simulator), then the pictures and the three
screen captures, `node src/tests/evidence/WO-2034/draw.mjs`.

## 5. Build orders (one concern each; file after the verdict)

Motion orders are opus seats, Tier 2 on the fake board of
`probingRunThrough.wo2034.test.ts` + simulator, then a machine-seat readback.
Each order that changes a pinned run-through fact must include that test file in
its grant and repin the named test.

1. Z from the top for Edge and Angle (motion, opus). Planner: top touch, rise to
   safe height, step out, guarded descent to depth, touch, rise. Runner: a guarded
   descent step (probe move that stops on contact) on native and text routes.
   Owned: PFC, MS (runFeatureProbeCycle only), the run-through test, a new test.
2. Outside corner goes around the corner (motion, opus). Two step-outs from one
   start over the material, per 4.2; depends on 1 (same step kinds).
3. Inside corner, Bore, Rect pocket descend from safe height to depth using the
   top (work Z0 or rim touch) (motion, opus). Depends on 1.
4. Boss / Rect boss start over the middle, touch the top, cross at top +
   clearance (motion, opus). WO-2035 (leased) makes the cross-over clear the top;
   this order changes the START (over the middle, not outside the X max face) and
   the depth. Depends on WO-2035 and 1.
5. Sensing choice: probe vs plate, plate thickness added to side results and
   used for Z0; remembered per machine; first default probe = 0 mm (math + UI,
   sonnet/opus). Replaces the 4.7475 tip-radius workaround.
6. Logical defaults: Edge left face X+, corner front-left X+ Y+, angle front Y+;
   tip radius from the probe tool, asked once and written to the tool table when
   missing (UI, sonnet). Pins in existing panel tests that assert the old defaults
   are granted.
7. Z0 on the Probing screen, ending at top + clearance (UI + small motion change
   to the Z0 end height, opus for the motion part). The Tools copy stays.
8. The Main screen's controls on the Probing screen (UI, sonnet). The Jog panel
   is on every step, YOU and MACHINE. The Position (DRO) panel and the E-STOP /
   CYCLE START / Feed Hold / Stop-Reset row are there too. Each is the SAME
   component Main renders, reused, never a copy or a restyle (COHESION-STANDARD
   22). The Probing screen's own DRO strip, its E-STOP / Feed Hold / Restart
   probe / Run buttons and its Run button go. CYCLE START on the Probing screen
   starts the selected routine. Any change to a shared control's size is a
   separate order applied to every screen (the operator's control-size card). Picture
   gate: the operator compares the controls with Main side by side.
9. One step at a time on the Probing screen (4.5-4.7): picture + sentence +
   the SIDE VIEW / TOP VIEW heading + step strip. "More about this step" and
   the picture key go in the right-hand column under the jog pad, opening one at
   a time. Everything is rendered from the plan's own steps (never a second
   description - PFC's `review` comment) and follows the machine while running
   (UI, sonnet/opus). Also REQUIRED in this order, from the outside audit round
   3 and not mocked again:
   - **Routine chooser (round 3, SHOULD 3):** the left column shows the
     selected routine as one control. The full list of routines opens from it
     as an expandable chooser, and closes again when one is picked. It is not
     a permanent grid. The height it gives back goes to the setup values.
   - **More (round 3, SHOULD 4):** the open text is wider (it may take the
     picture key's space, since they open one at a time) and set as short
     labelled lines at >= 22 px, not a paragraph: "Search: 300 mm/min until it
     touches", "Back off: 2 mm", "Slow touch: 50 mm/min (this one is recorded)",
     "Stops if: nothing touched 5 mm past the face", "Result: X face = touch +
     tip radius 1.588".
   - **Step strip ownership and completion (round 4, SHOULD 3):** every chip
     says whose step it is in words, YOU steps "YOU" and MACHINE steps too
     (for example "MC"), at 16-18 px, not the 14 px of the mockup. A done step
     carries its tick at the same 16-18 px size, in the same place on every
     chip, so owner and done read at 1.5 m as easily as the number.
   - **More, expanded (round 4, SHOULD 4):** its text is 22 px (not 18) and it
     gets more width than the right-hand column's 280 px: it may take the
     picture key's space and widen the column while open, as long as the
     picture keeps its size (the 4.7 rule). Its content is three short
     paragraphs, each with its own heading line: the probing sequence
     (search, back off, slow touch), what happens if nothing is touched, and
     how the face is sensed (probe or plate). The labelled lines above go
     inside those paragraphs.
   - **The app's status follows the run (final audit, MUST):** while a
     routine runs, the global status in the tab row shows the real execution
     state (Running, Hold, Stopped), never "Idle" beside a live MACHINE step.
     If the run is paused or stopped, the step card says so beside the
     current step ("Paused at step 7", "Stopped at step 7").
   - **Picture key and More text size (final audit, SHOULD):** the Picture
     key body text is 21-22 px (not about 18), like More's 22 px. Wrapping is
     kept, and the expanded panel is checked to still fit the screen.
   - **Long strips (final audit, SHOULD):** the picture gate includes the
     23-step Boss strip at full-screen size (1920x1080), showing that every
     step number stays readable and the current step stays clearly marked.
     The nine-step Edge strip does not prove this.
   Picture gate: the operator compares it with the screen-*.png mockups.
10. Mesh: traverse at point-1 top + clearance; per-point search = clearance +
    largest height change (motion, opus).
11. Routines tab factory routines (edge/corner/bore/boss) get the same top/safe/
    depth steps, so the two surfaces agree (routine data, sonnet; after 1-4).
Already filed: WO-2035 (boss cross-over clears the top), WO-2036 (XY search bound).

Order of work: 6 and 8 need no motion and can go first; 1 -> 2, 3, 4 -> 11;
5, 7, 10 independent; 9 last (it draws what 1-4 plan).

## 6. Decide-and-log calls made in this design (reversible)

- Top of feature defaults to a touch (not work Z0) for routines that start over
  material: one extra touch, but right even when Z0 was set on a different face
  or a fixture. Reverse: default to Z0 when it was set this session.
- Default depth 5, clearance 5, start distance 10: typical for a 1/8 in probe on
  hobby-to-light-industrial stock. All three are fields.
- Descents to depth are probe moves, not plain moves: a wrong start stops on
  contact instead of crashing, at no cost in time.
- Outside corner is re-planned (two step-outs), not retired.
- The routine is started with the Main screen's CYCLE START, not a "Run Edge"
  button (COHESION-STANDARD 22: one start control, one look). Reverse: give
  CYCLE START the routine's name as its label on the Probing screen. That keeps
  one component and changes only one word.
- The top view replaces the side view only for horizontal positioning moves at
  safe height. Touches and back-offs at depth keep the side view, with the
  larger oriented inset beside it, because the depth below the top is what
  those steps show. Reverse: promote every horizontal move.
- Future orders that change the planner contract or Z behaviour carry
  `src/lib/machine/pendantMachine.ts` (another `planFeatureProbeCycle`
  consumer) or say explicitly that they keep its pendant behaviour (codex review
  NOTE).
