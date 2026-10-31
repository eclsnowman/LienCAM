# Probing screen v2 - the brief (Operator ruling 2026-09-27)

This is the target for the Probing screen. It was worked out with the operator, picture by picture, on
2026-09-27 (after WO-2062 built Main's full DRO beside the old layout and the operator rejected it: "the
point of the page is squished into the middle ... How did this go so far from my approval images?").
Build to THIS page. Anything not written here is not approved.

## THE STANDARD - the Bore reference video (Operator ruling 2026-09-27 ~1:05 PM CT: LOCKED)

`src/tests/evidence/WO-2063/bore-full-run.mp4` (v2, commit after bbc098a67; script
`bore-full-run.mjs`) is the approved look and behaviour. the operator: *"Wow. I really like that. Lock this
down. This is the what I want. And this is the caliber I expect for all the other probe routines.
Visual styling and look of this must be maintained across the probe routines."*

Every routine (Z0, Edge, Outside corner, Inside corner, Angle, Bore, Boss, Rect pocket, Rect boss, Z
surface, Tool Z) looks and behaves exactly like it:
- **Before Start** - the "where to be" step draws the start zone and DIMENSIONS it in both views (size
  from the part, e.g. "within 5 mm of the centre", and height, e.g. "any height above the top"); the
  operator walks the steps with Next/Back or the step numbers, and each MACHINE step plays its moves as
  a preview with a see-through (blue) preview probe - one dashed path and one counting distance at a
  time, hollow rings where it would touch - while the real probe and the position readout stay put. A
  strip says "BEFORE START - preview (nothing moves)".
- **Running** - the real probe follows the machine; a faded outline marks where the current move
  started; ONE dashed path with ONE distance counting down; touches light orange and stay; the step
  numbers tick; the sentence is the current step's; ends with the result (e.g. centre + diameter) and
  the Confirm step.
- Steps grouped by face/wall/touch (the operator, card 11:21 AM CT). Labels beside their own path, never on
  the probe, the part, a height line or another label. The same colours, line weights and text sizes
  as the video. Where the machine does a fast and a fine pass, the preview and the run show both.

## The rule above all the others

**Any change that is not already written here goes to the operator for approval first.** The worker does not
invent layout, controls, wording, colours, checks or behaviour. If something seems needed, stop and
say so in the worker result; the architect puts it to the operator on a card. An audit or review finding that
asks for something new is also a question for the operator, never an instruction.

## The goal - who the pictures are for

the operator: "The diagrams aren't for us. It's for them." Every step's picture does three jobs, no more:

1. **Where to be.** Before the run (YOU steps): the zone the operator puts the probe in, dimensioned
   from the part - e.g. "within 10 mm of the face", "over the middle, by eye", "any height above the top".
2. **What happens next.** One dashed path from where the probe is to where it goes, with its distance
   ("X+ 10.0 mm"). Before Start, that move plays as a short preview loop.
3. **While it runs.** Both views follow the machine's real position live: the probe travels, the path
   shortens, the distance counts down, the touch lights up where it meets the part - so the operator
   can react (Stop) if something is wrong.

Few arrows and overlays: the motion explains. Readable from a distance: probe, 7 px paths with solid
heads, text 26 px and up, nothing tiny.

## One source of truth

the operator: "Single source of truth, displayed two different ways. The numerical list on the left and the
visual indication in the diagram." The routine's setup fields in the left column are the ONLY numbers
the pictures use. Changing a field (face, corner, direction, diameter, depth, clearance, start within,
tip radius, plate) redraws both views at once. Pictures are drawn from the routine's plan (the real
moves, in millimetres), never hand-drawn per setting.

## Layout (1920 x 1080; also works at 1440 x 900)

Reference: `src/tests/evidence/WO-2063/wireframe-v5-1920x1080.png`.

- **Left column (350 px):** Position panel (Main's own component, compact as in the approved picture;
  on Probing, WORK stays live before homing), Routine picker (3 across, full names), Setup for the
  chosen routine (label left, field right, one row each; the fields are that routine's own).
- **Middle:**
  - one caption row: "side view" over the side view, "top view" over the top view - never over a drawing;
  - side view and top view start on the SAME top line;
  - side view ~86% of the old size, zoomed to the area that matters; height lines (safe / top / depth)
    run to one-line labels at their right ends ("safe +5 · tip clearance"); labels never touch - a
    label that would, steps down with a short leader;
  - top view fills from ~48 px right of the side view to the edge and stops above the height labels;
    the X/Y axis marker sits clear of the part and of the probe;
  - the step sentence sits UNDER the pictures; no "YOU" tag before it;
  - the step numbers in one row (current outlined, done ticked, YOU steps marked "YOU");
    no "Preview steps / Step n of N" text.
- **Right column (280 px):** Jog (Main's own panel, on every step), Picture key, More about this step
  (they open one at a time), then the controls - **E-STOP** full width, **Start probing** and **Stop**
  side by side (the operator's pick: no CYCLE START, no Feed Hold, no Stop/Reset on this screen); the column
  ends level with the middle card.
- **Open with the operator:** the empty band between the sentence and the step numbers (options were: bigger
  sentence and step numbers; a larger side view; leave it). Do not fill it without his answer.

## Reference pictures (all in `src/tests/evidence/WO-2063/`)

| File | What it shows |
|---|---|
| `wireframe-v5-1920x1080.png` | the sections and their sizes |
| `edge-demo-step1.png` | Edge step 1 - where to be (zone + 10 mm dimension) |
| `edge-demo-step7.png` | Edge step 7 - what happens next (one dashed path + distance) |
| `edge-demo-step7.webp` | Edge step 7 running - the probe moves, the distance counts down, the touch lights |
| `bore-demo-step1.png`, `bore-demo-step5.png`, `bore-demo-step5.webp` | the same three jobs on a round feature |
| `bore-demo-step5-changed.png` | one source of truth: diameter 40 / depth 8 typed in the panel, both views redrawn |
| `edge-demo.mjs`, `bore-demo.mjs` | how those were drawn: real mm, zoom-to-fit, label rules - the reference renderer |
| `layout-*-1920x1080.png` | the layout on 8 routines (their TOP-VIEW MARKS are superseded by the demo style) |

the operator's original approval (09-26) is `src/tests/evidence/WO-2034/screen-edge-*.png` and the step
drawings `edge.png`, `bore.png`, ... - the step lists and sentences still hold except where this brief
changes them (e.g. "Press CYCLE START" becomes "Press Start probing").

## Every routine

Z0, Edge, Outside corner, Inside corner, Angle, Bore, Boss, Rect pocket, Rect boss, Z surface (mesh),
Tool Z - each gets the three jobs above, drawn from its own plan and setup.

## Stop

"Stop" cancels the running routine without an E-STOP latch. Before wiring it, MEASURE what the
current stop path does to a running probe cycle (simulator and the native fake board) and commit the
measurement; Stop must stop every probe cycle kind. No new confirm, lock, warning or refusal.

## Done means

- Captures of every routine at 1920x1080 (one YOU step, one MACHINE step) and 1440x900, plus one
  animation per routine of a MACHINE step; delete-first, fresh.
- A test proves one source of truth (change a setup field -> the drawn numbers change to match).
- **Adversarial UI audit before the operator sees it:** readability at a distance, overlaps, padding and
  alignment, font and control consistency with the rest of LienCAM (COHESION-STANDARD). Its findings
  are fixed only when they restore THIS brief; anything new goes to the operator as a question.
- the operator's picture verdict lands it.
