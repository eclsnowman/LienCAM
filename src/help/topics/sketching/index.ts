import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'reference-image-calibration',
    title: 'Calibrating a reference image',
    category: 'sketching',
    summary: 'Calibrate a tracing picture to a real distance using two marks or a selected sketch line, then lock its scale and place it with X, Y, Angle, drag and flips.',
    sections: [{ kind: 'paragraph', text: 'Add a picture with Import... > Reference image (tracing underlay) in the Sketch tab, or Reference image > Insert... in a Model-tab sketch. To reopen it later, choose it in the Edit image list (Sketch tab) or click its row in the feature tree (Model tab). Choose Calibrate, pick two marks on the picture, type their real distance in your display units, and press Enter. Alternatively, select an ordinary sketch line between the marks before choosing Calibrate. The picture scales uniformly about the first mark; the sketch line stays unchanged. Esc cancels. Lock scale hides Calibrate until you unlock it. X and Y set the picture center in your display units; Angle turns it about that center in degrees. Flip horizontal and Flip vertical mirror the picture in place. While this palette is open, press and drag the picture to move it; X and Y follow the cursor. Release adds one Undo step; Esc cancels the drag. Drag a corner handle to resize evenly about the opposite corner; width updates live, one release is one Undo step, and Lock scale hides the handles. Close the palette to trace through the picture with sketch tools. Placement works with Lock scale on and preserves calibrated distances. Placement, calibration and the lock are saved with the project and can be undone.' }, { kind: 'image', slot: 'calibrate' }],
    images: [
      {
        slot: 'calibrate',
        file: 'calibrate.webp',
        alt: 'Sketch tab with medallion.png as the reference image: two marks picked on the picture and the Calibrate reference image box showing Current distance 152.905 mm, Real distance 152.905 mm selected for typing, Scale Uniform, Cancel and Apply',
        captureNotes: 'Sketch tab, Reference image palette open, Calibrate with two marks picked and the distance box shown (medallion.png, whole frame). WO-2710.',
        status: 'done',
      },
    ],
    keywords: 'reference image picture tracing underlay ruler calibrate distance scale lock unlock two points sketch line move rotate angle flip horizontal vertical center',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-entry'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-entry',
    title: 'Starting a sketch',
    category: 'sketching',
    summary: 'The Sketch tab opens the Enter Sketch Mode chooser: start a new sketch, pick a part in the viewport, or choose an existing 2D layer to edit.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click the Sketch tab. If the part selected in the design tree has exactly one layer you can edit, that layer opens straight away. If it has several, the chooser opens showing only that part\'s layers. With nothing selected, the chooser opens (or, if a sketch is already open, the Sketch tab just shows it).',
          'In the Enter Sketch Mode chooser, click New sketch to start on a new, empty layer.',
          'Or click Pick existing in viewport, then click the part in the viewport - the parts you can pick highlight, and Esc goes back to the chooser. A part with one editable layer opens it; a part with several lists them so you can choose one.',
          'Or pick a layer from the list under "Or choose an existing layer". Layers are grouped by part and show their loop count; a layer that already holds a sketch says "parametric".',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A layer you cannot sketch on stays in the list, greyed out, with the reason under it: "Layer is locked" (unlock it in the design tree), or an STL projection, which is read-only.',
      },
      {
        kind: 'paragraph',
        text: 'The first time you open an imported DXF or SVG layer, its loops arrive in the sketch as one block: a single rigid object that counts as fully defined, which you place as a whole. Right-click it and choose Explode block when you want to edit the curves themselves. Finishing the sketch stores it on the layer, so the next time you open that layer you get the same sketch back with its constraints and dimensions.',
      },
      {
        kind: 'paragraph',
        text: 'You can also bring a file into the sketch you are in: Import... in the Create section opens the Import window. Choose a DXF / SVG / PNG / JPG file there to add a DXF, SVG, PNG or JPG as ordinary sketch geometry you can edit and constrain. The picture choices in that window apply to PNG / JPG tracing: "Picture width (mm)" sets how wide it lands (the height follows the picture) and "Picture threshold" (1 to 254) sets how dark a pixel must be to become a shape. The console line says how many loops came in.',
      },
      { kind: 'paragraph', text: 'Export / Print... opens the Export window. Export SVG... there saves the open sketch at true size in millimetres, named after the sketch. Construction geometry is left out. Open the SVG in a laser or drawing program, or print from a browser at 100% scale for a 1:1 template.' },
      { kind: 'paragraph', text: 'Print... in the Export / Print window prints the open sketch. Choose Paper (Letter, Legal, Tabloid, A4 or A3), Orientation and Scale in that window. The choices in both windows are remembered while the sketch stays open. Actual size (1:1) makes a full-size template; choose 100% / "Actual size" in the system print dialog and the matching paper and orientation. Fit to page uses one sheet and records the fitted scale in the title box. Large actual-size drawings span numbered rows and columns with 10 mm overlap: align the crosses in the overlapping strips and tape the sheets together. Each sheet includes the sketch name, date, scale and page number. An empty sketch prints an empty titled page.' },
      { kind: 'image', slot: 'entry-modal' },
    ],
    images: [
      {
        slot: 'entry-modal',
        file: 'entry-modal.webp',
        alt: 'The Enter Sketch Mode chooser with New sketch, Pick existing in viewport, and layers grouped by part',
        captureNotes: 'The Enter Sketch Mode chooser on a project with two imported DXF parts: New sketch and Pick existing in viewport on top, the layer list scrolled so the bracket part shows its Cut layer and its locked Engrave layer greyed out with "Layer is locked", and the plate part with its Outline layer.',
        status: 'done',
      },
    ],
    keywords: 'sketch tab enter sketch mode chooser new sketch pick existing viewport edit layer lift dxf svg png jpg picture trace import export true size print template 1:1 paper orientation actual fit page overlap Letter Legal Tabloid A4 A3 threshold locked read-only stl projection block explode open',
    contextKeys: ['modal:sketch-entry', 'mode:sketch'],
    relatedTopicIds: ['sketch-draw-tools', 'sketch-blocks', 'finish-and-bake'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-draw-tools',
    title: 'Drawing entities',
    category: 'sketching',
    summary: 'The Create section of the sketch toolbox holds every drawing tool: lines, rectangles, circles, ellipses, arcs, splines, a bezier, a conic arc, polygons, spur gears, slots, text and points.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Create section holds Line, Rectangle, Center Rect, Circle, 3-Pt Circle, Ellipse, Elliptical Arc, Spline, Control Spline, Bezier, Conic Arc, Text, 3-Pt Arc, Tangent Arc, Center Arc, Polygon, Gear, Slot, Arc Slot, Point and Construction. Hover a button to see its key.',
      },
      {
        kind: 'steps',
        steps: [
          'Click a tool, or press its key: Line (L), Rectangle (R), Circle (C), Spline (S), Text (G), 3-Pt Arc (A). The tool stays armed until you press Esc or click its button again.',
          'Follow the prompt bar at the bottom of the viewport. It names the tool, shows "Step N of M", says what to click next, and has Confirm (Enter) and Back or Cancel (Esc) buttons.',
          'Click in the viewport to place points. The Line tool keeps going from the last point, so one pass draws a whole outline: click the start point again to close it, or press Enter to finish.',
          'While a line or circle follows the cursor, a small box shows its length or radius. Start typing a number to set it exactly and press Enter: the entity is drawn at that size with a dimension that holds it.',
          'Hold Shift to lock a line to the nearest 45-degree direction. Esc steps back from the current step; press it again to put the tool away.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Some tools show extra rows under the Create buttons while they are armed: Rectangle and Center Rect have "Rotated (Tab)" to draw a rectangle at any angle (three clicks: corner, edge, width); Polygon has Sides and Mode (Inscribed: click a vertex, Circumscribed: click a side midpoint); Spline, Control Spline and Bezier have Close loop; Conic Arc has Rho (0.5 is a parabola, lower is an ellipse arc, higher is a hyperbola arc). A rectangle also gets a dashed construction diagonal with a center point, which moves with its corners.',
      },
      {
        kind: 'paragraph',
        text: 'Gear: set Teeth (6-200), Module (mm), Pressure angle and Root fillet; click the center, then click to set rotation. The closed involute outline is ordinary lines and arcs. Snap Circle to its construction pitch circle center for a bore. Undo removes the whole gear in one step.',
      },
      {
        kind: 'paragraph',
        text: 'The Bezier tool works by press and drag: press for an anchor, drag out its handle, or release without dragging for a sharp corner. When a bezier is selected, the Modify section shows "Bezier joints" with Smooth (the handles stay in line) and Corner (each handle moves on its own).',
      },
      {
        kind: 'paragraph',
        text: 'Right-click in the viewport for a menu that fits what you are doing: with a tool armed it offers Confirm step, Cancel and Construction mode; with geometry selected it offers the constraints that fit, Copy (Ctrl+C), Paste (Ctrl+V), Delete, Toggle construction, Group into block, and the Modify tools that start from your selection; on empty space it lists the tools. An empty sketch shows a card of the tool keys at the top of the viewport; its X closes it.',
      },
      {
        kind: 'tip',
        text: 'Tool keys are ignored while you are typing in a value field, so typing "15" into a dimension never arms a tool.',
      },
      { kind: 'image', slot: 'tool-grid' },
    ],
    images: [
      {
        slot: 'tool-grid',
        file: 'tool-grid.webp',
        alt: 'The Line tool armed in the Create section, drawing a chained outline with the length box and the prompt bar',
        captureNotes: 'Line tool armed (highlighted in the Create section) with two segments drawn and a third following the cursor, the typed-length box beside the cursor, and the prompt bar reading "Line - Step 2 of 2" with Confirm and Back; the whole Create section and the top of Modify in frame.',
        status: 'done',
      },
    ],
    keywords: 'draw line rectangle center rect circle 3-pt ellipse elliptical arc spline control spline bezier conic rho tangent arc center arc polygon gear spur involute teeth module pressure angle root fillet slot arc slot point chain shortcut esc enter shift ortho 45 rotated tab prompt bar right-click menu copy paste typed length',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-snaps-inference', 'construction-geometry', 'sketch-modify-tools'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-text',
    title: 'Sketch text',
    category: 'sketching',
    summary: 'The Text tool (G) places engravable text with a choice of single-line and outline fonts, your own imported fonts, and optional placement along a curve.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Arm the Text tool (G) and click where the text should start, then type right in the canvas. Enter finishes. Esc on new text keeps what you typed, or removes the text if you typed nothing.',
          'Set Height, Angle (deg), Letter spacing (mm) and Mirror in the rows under the Create buttons. They apply to the next text you place, and to the text you are editing as you change them.',
          'Pick a font from the Font list. "Hershey (single-line / engrave)" cuts open centerline strokes with the tool tip; every other face is an outline font whose closed letter shapes you can pocket or contour. Import font... adds your own .ttf, .otf or typeface .json - it is converted in the browser and saved with the project.',
          'Double-click placed text to edit it. While editing, Esc puts the text back the way it was.',
        ],
      },
      {
        kind: 'heading',
        text: 'Text along a curve',
        anchor: 'text-on-path',
      },
      {
        kind: 'paragraph',
        text: 'With the Text tool armed, click on a line, arc, circle, ellipse or spline and the text is placed along it. For text you already placed, double-click it and press "Attach to path", then click the curve. While attached, the rows show Detach, Flip side and "Position along path". A small bar under the text sets where it sits on the curve: L (start of the curve), C (center), R (end), F (free - slide it anywhere), plus Flip and Mirror.',
      },
      {
        kind: 'tip',
        text: 'Mirror flips the letters themselves; Flip side moves the text to the other side of the curve. The two are separate.',
      },
      { kind: 'image', slot: 'text-on-path' },
    ],
    images: [
      {
        slot: 'text-on-path',
        file: 'text-on-path.webp',
        alt: 'Text placed along an arc with the L C R F Flip Mirror bar, and the text rows in the toolbox',
        captureNotes: 'New text "LIENCAM" placed by clicking on an arc, the arc highlighted and the L / C / R / F / Flip / Mirror bar beside the text; the toolbox Create section with Text armed and the text rows (hint line, Text, Height, Angle, Letter spacing, Mirror, Font) visible.',
        status: 'done',
      },
    ],
    keywords: 'text font single-line outline hershey engrave import ttf otf cap height letter spacing tracking mirror on path attach detach flip side curve align left center right free position',
    contextKeys: ['mode:sketch', 'tool:sketch:text'],
    relatedTopicIds: ['engrave', 'finish-and-bake'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-constraints',
    title: 'Constraints',
    category: 'sketching',
    summary: 'Fifteen constraint buttons lock geometric relationships - each lights up only when your selection fits it, and a constraint that would conflict is rejected by name instead of breaking the sketch.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Constraints section holds Coincident, Concentric, Parallel, Perpendicular, Collinear, Horizontal, Vertical, Tangent, Equal, Midpoint, Symmetric, Fix, On Object, Tangent G1 and Curvature G2. Select the geometry first, then click the constraint. A button is enabled only when your selection fits it; hover a greyed-out button and it tells you what it needs.',
      },
      {
        kind: 'steps',
        steps: [
          'Select the geometry: click entities (Shift adds to the selection). Click an endpoint node to pick the point itself, or the center mark of a circle or arc to pick its center.',
          'Click the constraint button, or right-click and pick it from the menu - the menu lists only the constraints that fit. It applies at once and the sketch re-solves.',
          'If the new constraint would conflict with the ones already there, it is taken back and the console names the constraints it fights with - the sketch is never left broken.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Tangent G1 and Curvature G2 keep a control spline smooth where it meets a line or an arc.',
      },
      {
        kind: 'paragraph',
        text: 'The Browser section at the bottom of the toolbox lists every constraint and dimension, grouped by kind. Click a row to select it, hover to see it in the viewport, and use its trash button to delete it. The Show button in the Constraints header hides or shows the small constraint badges in the viewport; the constraints themselves are unchanged.',
      },
      { kind: 'image', slot: 'constraint-buttons' },
    ],
    images: [
      {
        slot: 'constraint-buttons',
        file: 'constraint-buttons.webp',
        alt: 'The Constraints section with two lines selected: Parallel, Perpendicular, Collinear, Horizontal, Vertical, Equal and Fix enabled',
        captureNotes: 'Two loose lines selected (amber) in the viewport beside a rectangle carrying its constraint badges; the Constraints section open with Parallel, Perpendicular, Collinear, Horizontal, Vertical, Equal and Fix enabled and the point-only constraints greyed out; the Show badge toggle in the section header.',
        status: 'done',
      },
    ],
    keywords: 'constraint coincident concentric parallel perpendicular collinear horizontal vertical tangent equal midpoint symmetric fix on object g1 g2 curvature continuity browser glyph badge show conflict reject',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-dimensions', 'sketch-definition-states'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-dimensions',
    title: 'Smart dimensions',
    category: 'sketching',
    summary: 'One Smart Dimension tool (D) reads what you click and makes the right dimension - length, angle, radius, diameter or distance - with driving and reference modes and typed equations.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Arm Smart Dim. in the Modify section (or press D), then click what to measure: one line gives its length, two lines give the angle between them (or the distance if they are parallel), a circle gives its diameter, an arc its radius, two points their distance, and a point and a line the distance straight across from the point to the line.',
          'Click in open space to place the label. For a length, where you place it decides whether it measures along the line, horizontally or vertically; Tab switches between them. For an arc, Tab switches Radius to Arc length.',
          'Type the value and press Enter. The geometry moves to match. Esc keeps the measured value.',
          'Double-click any dimension label to change its value later.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A value can be an equation: start with "=" and use + - * / ^, unit suffixes such as mm and in, and functions such as sin, cos and sqrt. The result shows beside the box as you type, and reopening the box shows the equation you typed, not just the number.',
      },
      {
        kind: 'paragraph',
        text: 'A dimension is driving (it sets the size) or reference (it only reports it). The small button at the left of the value box switches between them, and so does Reference in the Modify section with the dimension selected. A reference dimension is shown in parentheses, updates itself after every change, and never moves the geometry. Switching a reference back to driving is refused, with the conflict named, if it would fight the sketch.',
      },
      { kind: 'image', slot: 'dimension-edit' },
    ],
    images: [
      {
        slot: 'dimension-edit',
        file: 'dimension-edit.webp',
        alt: 'A length dimension being edited with the equation =120/2 and its result 60 mm, and a reference radius (R12.00) in parentheses',
        captureNotes: 'A sketch with a driving 60 mm width dimension open for editing: the driving/reference button, the value box holding "=120/2" and the "= 60 mm" result beside it; a reference radius "(R12.00)" in parentheses and a driving 40.00 height in the same shot.',
        status: 'done',
      },
    ],
    keywords: 'dimension smart dim length angle radius diameter arc length distance horizontal vertical aligned tab driving reference parentheses equation expression units mm in d shortcut double-click edit',
    contextKeys: ['mode:sketch', 'tool:sketch:smart-dimension'],
    relatedTopicIds: ['sketch-constraints', 'sketch-measure', 'sketch-definition-states'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-definition-states',
    title: 'Under-defined, fully defined, conflicting',
    category: 'sketching',
    summary: 'Entity colors and the chip beside the Sketch title tell you how locked-down the sketch is: blue can still move, near-white is fully defined, and red is caught in a conflict.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Every entity is colored by its state: blue means under-defined (it can still move, and you can drag it), near-white means fully defined (every size and position is held by constraints and dimensions; dark on the light theme), and red marks entities caught in a conflict. Selected geometry shows in amber, and the entity under the cursor gets a cyan glow.',
      },
      {
        kind: 'paragraph',
        text: 'The chip beside the Sketch title reads "N DoF" while N degrees of freedom are left, "Fully defined" at zero, "Not solved" before the sketch has been solved at all (a new, empty sketch), and "Solve failed" when the solve gave no answer - hover it for the reason.',
      },
      {
        kind: 'steps',
        steps: [
          'When constraints conflict, a red "Over-defined: N conflicting" banner appears under the Finish button, naming the first few. Click Resolve... to list the whole conflicting set and remove one of them.',
          'Constraints that repeat something already held (redundant) get an amber "N redundant (advisory)" row with a Review... button. Removing them is up to you; the sketch still solves.',
        ],
      },
      { kind: 'image', slot: 'color-states' },
      { kind: 'image', slot: 'conflict-banner' },
    ],
    images: [
      {
        slot: 'color-states',
        file: 'color-states.webp',
        alt: 'A fully defined near-white rectangle beside blue under-defined geometry, with the chip reading 17 DoF',
        captureNotes: 'A sketch with a fully defined rectangle (near-white, with its two driving dimensions and constraint badges) beside blue under-defined geometry (a circle with a tangent line, an arc with a reference radius, a construction line, a point); the chip beside the Sketch title reading "17 DoF"; the Constraints section open in the toolbox.',
        status: 'done',
      },
      {
        slot: 'conflict-banner',
        file: 'conflict-banner.webp',
        alt: 'The red Over-defined banner with its Resolve button, the Solve failed chip, and the two conflicting dimensions drawn red',
        captureNotes: 'The same sketch after a second, conflicting width dimension (70 against 60) is added: the red "Over-defined: 2 conflicting" banner naming both Distance dimensions with its Resolve... button, the chip reading "Solve failed", and both width dimensions drawn red in the viewport.',
        status: 'done',
      },
    ],
    keywords: 'under-defined fully defined over-defined conflicting redundant blue red white amber cyan dof degrees of freedom not solved solve failed banner resolve review chip color',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-constraints', 'sketch-dimensions', 'sketch-limits'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-modify-tools',
    title: 'Trim, split, extend, offset, mirror, patterns, move',
    category: 'sketching',
    summary: 'The Modify section reshapes existing geometry: trim, split, extend, offset, mirror, linear, circular and path patterns, move, rotate, scale and delete.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Modify section holds Smart Dim., Reference, Trim, Split, Extend, Fillet, Chamfer, Offset, Mirror, Linear Pat., Circular Pat., Path Pat., Move, Rotate, Scale and Delete. The tools that end with a value (offset, patterns, move, rotate, scale) show a strip at the bottom of the viewport where you type it; OK (Enter) applies and Cancel (Esc) backs out.',
      },
      {
        kind: 'steps',
        steps: [
          'Trim (T): hover a curve to see what a click removes, then click it, or drag across several to trim them in one sweep. The piece between the nearest crossings goes; a curve that crosses nothing is deleted whole. New cut ends stay on the curve they were cut against.',
          'Split (K): click a line or arc to break it in two at that point - nothing is removed and the two pieces stay joined. A circle needs a second click.',
          'Extend (E): click the line or arc, then move toward the boundary you want it to reach - a ghost shows the result - and click.',
          'Offset (O): click a curve or chain, move the cursor to the side you want and click to lock that side (click again to flip it), set Distance in the strip, and press OK.',
          'Mirror (M): click the entities to mirror, then click a construction line to mirror about it. To use any other line as the axis, press Confirm (Enter) first, then click the line. The copies are tied to the originals with symmetric constraints.',
          'Linear Pattern (1): click the entities, Confirm, then click the start and end of one step. Set Count in the strip and press OK.',
          'Circular Pattern (2): click the entities, Confirm, then click the center. Set Count and Step (the angle between copies) in the strip.',
          'Path Pattern (3): click the entities, Confirm, then click the line, arc, spline, elliptical arc or chain to follow. Set Count, choose Equal spacing or Fixed distance, and tick Follow tangent to turn each copy with the path.',
          'Move (V), Rotate (W), Scale (X): click the entities and Confirm. Move: click a base point and a destination. Rotate: click the center, a point on the reference direction and a point on the target direction. Scale: click the base point, then type the factor or click a reference point and a target point. The strip shows dX / dY, Angle or Factor to adjust; tick Keep original to make a copy instead.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Right-click a selection and the menu offers Mirror, Linear Pattern, Circular Pattern, Path Pattern, Fillet, Chamfer, Offset, Move, Rotate and Scale "with selection": the tool starts with those entities already picked.',
      },
      {
        kind: 'paragraph',
        text: 'Delete removes the selection (Del or Backspace does the same), together with any constraints and dimensions that referred to it. Deleting a source also removes its dependent offsets and pattern copies; deleting a pattern member suppresses that entire instance, which Edit pattern can restore. Use Break pattern, or the Break this offset link button in the Browser, before deleting the source if you want to keep independent copies. Copy (Ctrl+C) and Paste (Ctrl+V) are on the right-click menu.',
      },
      {
        kind: 'paragraph',
        text: 'Linear, circular and path patterns, mirrored copies, and Move, Rotate or Scale with Keep original retain a definition linking the copies to their source. A copy stays driven by that definition instead of becoming a freely draggable entity. Select a member and choose Edit pattern from the right-click menu to reopen its values. Circular patterns show Count, Center X, Center Y and Step angle; linear patterns show Columns, Rows and the two spacing directions. Values accept expressions starting with =. Press Apply to update the copies.',
      },
      {
        kind: 'paragraph',
        text: 'In Edit pattern, uncheck an instance to suppress it and check it again to restore it. Break pattern keeps the currently visible geometry and removes its pattern definition, so the copies can be edited independently; it also removes the constraints created by that definition. The stored definition and suppression choices survive saving and reopening. Offset copies use their separate source link and distance controls; they are not edited in Edit pattern.',
      },
      { kind: 'image', slot: 'edit-pattern' },
      { kind: 'image', slot: 'offset-preview' },
    ],
    images: [
      {
        slot: 'edit-pattern',
        file: 'edit-pattern.webp',
        alt: 'Model sketch circular pattern editor with four circles, Count, centre, Step angle and instance checkboxes',
        captureNotes: 'Accepted WO-2616 capture at 6e7694fc4fa3d1b912332f1f9a9aeaea71f99f3f; visible controls unchanged. Reused historical capture, not a new run.',
        status: 'done',
      },
      {
        slot: 'offset-preview',
        file: 'offset-preview.webp',
        alt: 'A dashed offset preview around a rectangle with the Offset strip showing Distance and "side locked - click the sketch to flip"',
        captureNotes: 'Offset armed on a rectangle after the side is locked: the dashed offset preview outside the rectangle, and the Offset strip at the bottom of the viewport with the Distance box, "side locked - click the sketch to flip", and the OK / Cancel buttons.',
        status: 'done',
      },
    ],
    keywords: 'trim split extend offset mirror pattern linear circular path follow tangent move rotate scale keep original copy paste delete cascade modify t k e o m 1 2 3 v w x swipe',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-fillet-chamfer', 'sketch-draw-tools'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-fillet-chamfer',
    title: 'Sketch fillet and chamfer',
    category: 'sketching',
    summary: 'Fillet (F) rounds corners with true tangent arcs and Chamfer (H) cuts them with a flat - both stage several corners with ghost previews and apply them all at once.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Arm Fillet (F) or Chamfer (H).',
          'Click a corner point, or click two lines that meet. The corner is staged and a ghost shows the result. Keep clicking to stage more corners; click a staged corner again to remove it.',
          'Set the size in the strip at the bottom of the viewport, or type it into the box beside the first staged corner. The ghosts follow the value.',
          'Press Apply (or Enter) to add them all as one step; Cancel (or Esc) drops the staged set. The first fillet added gets a driving radius dimension; the others are tied to it as equal, so changing that one dimension later resizes the whole set.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The Chamfer strip offers three ways to size it: Equal distance (one Setback on both legs), Two distances (d1 and d2), or Distance and angle.',
      },
      {
        kind: 'paragraph',
        text: 'A radius too big for a corner is refused with a console line giving the largest radius that fits.',
      },
      { kind: 'image', slot: 'staged-ghost' },
    ],
    images: [
      {
        slot: 'staged-ghost',
        file: 'staged-ghost.webp',
        alt: 'Two staged fillet corners on a rectangle with dashed ghost arcs and the Fillet strip with Radius, 2 corners staged, Apply and Cancel',
        captureNotes: 'Fillet armed on a rectangle with its two top corners staged: dashed ghost arcs at both corners, the radius box beside the first corner, and the Fillet strip at the bottom of the viewport reading Radius, "2 corners staged", "Enter to apply the fillet - Esc to cancel", Apply and Cancel.',
        status: 'done',
      },
    ],
    keywords: 'fillet chamfer round corner radius setback equal distance two distances d1 d2 angle tangent arc ghost preview stage batch apply enter f h',
    contextKeys: ['mode:sketch', 'tool:sketch:fillet', 'tool:sketch:chamfer'],
    relatedTopicIds: ['sketch-modify-tools', 'sketch-constraints'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'construction-geometry',
    title: 'Construction geometry',
    category: 'sketching',
    summary: 'Construction entities are layout lines: they draw dashed, take part in constraints and dimensions like any other geometry, and are never baked into cutting geometry.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'With entities selected, press Q (or click Construction in the Create section, or right-click > Toggle construction) to switch them between normal and construction.',
          'With nothing selected, Q (or the Construction button) turns construction mode on: everything you draw arrives as construction until you turn it off. The console says when it is on.',
          'Use construction lines as mirror axes, symmetry lines and layout guides - constraints and dimensions treat them like any other geometry. Mirror accepts a construction line as its axis with a single click.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'When the sketch is finished, construction entities and lone points are left out of the bake, so they never become a toolpath source. They stay in the sketch and are there when you open it again.',
      },
      { kind: 'image', slot: 'dashed-entities' },
    ],
    images: [
      {
        slot: 'dashed-entities',
        file: 'dashed-entities.webp',
        alt: 'A dashed construction line used as the mirror axis between a profile and its mirrored copy',
        captureNotes: 'A dashed vertical construction line with a closed profile on one side and its mirrored copy on the other, the symmetric-constraint badges on both, nothing selected.',
        status: 'done',
      },
    ],
    keywords: 'construction q toggle dashed layout guide centerline axis mirror convert never bakes reference geometry mode',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-draw-tools', 'finish-and-bake'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-snaps-inference',
    title: 'Snaps and inferred constraints',
    category: 'sketching',
    summary: 'Three snap toggles - Entity snaps, Grid snap and Inference - guide the cursor while drawing, and Inference turns snapped clicks into real constraints when you commit.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Entity snaps pulls the cursor to endpoints, midpoints, centers and intersections of existing geometry.',
          'Grid snap pulls to grid points. "Grid spacing" under the toggles is the same value the viewport grid uses, so the snap and the drawn grid always agree.',
          'Inference shows horizontal and vertical alignment guides while you draw and remembers each snapped click. When the entity is drawn, those snaps become real constraints: a click on an endpoint becomes a coincident, a level or upright segment becomes horizontal or vertical.',
          'Hold Shift to lock the current segment to the nearest of the eight 45-degree directions; the lock wins over the alignment guides.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The three toggles and Grid spacing are in the Utility section of the toolbox. A lit toggle is on.',
      },
      { kind: 'image', slot: 'snap-markers' },
    ],
    images: [
      {
        slot: 'snap-markers',
        file: 'snap-markers.webp',
        alt: 'A line being drawn to a rectangle corner with the endpoint snap marker lit, and the snap toggles in the Utility section',
        captureNotes: 'Line tool mid-draw with the cursor on a rectangle corner: the endpoint snap marker lit on the corner and the length box beside it; the Utility section open showing Entity snaps and Inference on, Grid snap off, and Grid spacing (mm).',
        status: 'done',
      },
    ],
    keywords: 'snap entity grid inference alignment guide horizontal vertical shift ortho lock spacing endpoint midpoint center intersection automatic constraint utility',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-draw-tools', 'sketch-constraints'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-blocks',
    title: 'Blocks',
    category: 'sketching',
    summary: 'A block groups entities into one rigid object you place, scale and rotate as a unit - copies can share one definition, and Edit block changes the contents in place.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Select entities and right-click > Group into block. The block moves as one rigid shape. With one block selected, a "Block" row in the toolbox sets Scale (x) and Rotation (deg).',
          'Right-click a block > Edit block, or double-click it, to edit it in place: an "Editing block" row with Finish and Cancel appears under the Finish button at the top of the sketch tools and the rest of the sketch dims. Finish (or Enter) freezes it again; Cancel (or Esc) throws the edit away.',
          'Right-click a block > Place another instance to add a copy that shares its definition - editing the definition once changes every copy.',
          'Right-click a block > Explode block to turn it back into ordinary entities.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A block\'s rotation can be constrained: Horizontal, Vertical, Parallel and Perpendicular accept a block and turn it like a line. An imported DXF or SVG layer opens in the sketch as one block - a single rigid object that counts as fully defined - so a large import is something you place rather than hundreds of loose lines. Explode it to edit the imported curves.',
      },
      { kind: 'image', slot: 'block-edit' },
    ],
    images: [
      {
        slot: 'block-edit',
        file: 'block-edit.webp',
        alt: 'A block open for editing with the Editing block row and its Finish and Cancel buttons, the rest of the sketch dimmed',
        captureNotes: 'A block (rectangle with a circle) open with Edit block: its members drawn bright, the other rectangle dimmed, and the "Editing block" row with Finish and Cancel under the Finish sketch / Cancel sketch buttons at the top of the toolbox.',
        status: 'done',
      },
    ],
    keywords: 'block group explode edit block in place place another instance definition copy rigid scale rotation import locked dxf unit double-click',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['project-use', 'sketch-entry'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'project-use',
    title: 'Project / Use',
    category: 'sketching',
    summary: 'The Project / Use tool copies a loop from another 2D layer into your sketch as fixed geometry you can dimension and constrain against.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Project / Use in the Utility section.',
          'Hover a loop on another visible 2D layer (a locked layer works too) and click it.',
          'The loop arrives as fixed geometry, so it is a steady reference to dimension and constrain against. The Browser lists the copies under References, and the console says how many entities came in.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A copy from a layer is static: it does not change if that layer changes later. With construction mode on (Q), the copy comes in as construction, so it guides your drawing without ever being baked. A click that misses says so in the console.',
      },
      {
        kind: 'paragraph',
        text: 'In a sketch in the Model workspace, the same tool also takes a model face (its outline and holes come in together), a model edge or a model point, and those copies stay linked to the model and follow it when it changes.',
      },
      { kind: 'image', slot: 'pick-preview' },
    ],
    images: [
      {
        slot: 'pick-preview',
        file: 'pick-preview.webp',
        alt: 'A plate outline copied into the sketch with Project / Use, pinned with F badges and listed under References in the Browser',
        captureNotes: 'Project / Use armed after clicking an imported plate\'s outline: the copied rectangle in the sketch with its fixed (F) badges, the chip reading "Fully defined", and the Browser listing the four copied lines under REFERENCES as "not linked".',
        status: 'done',
      },
    ],
    keywords: 'project use copy reference layer loop model face edge point static fixed construction linked follows model include external geometry references',
    contextKeys: ['mode:sketch', 'tool:sketch:project'],
    relatedTopicIds: ['sketch-blocks', 'sketch-constraints'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-measure',
    title: 'The measure readout',
    category: 'sketching',
    summary: 'Measure (I) shows the size of what you select - lengths, radii, angles and spacing - without adding a dimension.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Press I or click Measure in the Utility section to open the readout.',
          'Select one entity to see its size: a line shows Length, dX, dY and Angle; a circle Radius, Diameter and Circumference; an arc Radius, Arc length and Sweep; a point its X and Y.',
          'Select two entities to see the spacing between them: the readout names the two points it measured between (for example line midpoint to line midpoint) and shows Distance, dX, dY and the Angle of that spacing.',
          'Press I or click Measure again to close it. Measure never adds anything to the sketch.',
        ],
      },
      { kind: 'image', slot: 'readout' },
    ],
    images: [
      {
        slot: 'readout',
        file: 'readout.webp',
        alt: 'The Selection spacing readout for two selected lines: Distance 25 mm, dX 0, dY 25 mm, Angle 90 deg',
        captureNotes: 'Two parallel lines selected (amber) in the viewport and the Measure button lit in the Utility section, with the "Selection spacing" readout: Reference "line midpoint to line midpoint", Distance 25.000 mm, dX 0.000 mm, dY 25.000 mm, Angle 90.00 deg.',
        status: 'done',
      },
    ],
    keywords: 'measure readout i toggle inspect length radius diameter circumference arc length sweep angle spacing distance dx dy no dimension utility',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-dimensions'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'finish-and-bake',
    title: 'Finishing a sketch',
    category: 'sketching',
    summary: 'Finish (at the top of the sketch tools) bakes the sketch onto its layer as cutting loops and keeps the sketch itself, so you can open it again later with everything intact.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Finish at the top of the toolbox. Connected entities chain into loops, sorted into outlines and holes, and land on the layer the same way imported DXF loops do - ready for operations. The console says how many loops were baked and how many are closed. You return to the tab you came from.',
          'Clicking another tab at the top does the same bake, so leaving the Sketch tab never throws work away.',
          'Cancel throws away everything done since you opened the sketch and puts it back the way it was.',
          'Opening the layer again brings back the sketch with all its constraints and dimensions.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Finishing an empty sketch removes the layer it made, so trying things out never leaves empty layers in the design tree. Construction entities and lone points are left out of the bake.',
      },
      { kind: 'image', slot: 'finish-button' },
    ],
    images: [
      {
        slot: 'finish-button',
        file: 'finish-button.webp',
        alt: 'The Finish and Cancel buttons at the top of the sketch toolbox',
        captureNotes: 'The top of the sketch toolbox - the Sketch title with its DoF chip, the Finish sketch and Cancel sketch buttons, and the top of the Create section - with part of a drawn rectangle in the viewport beside it.',
        status: 'done',
      },
    ],
    keywords: 'finish sketch cancel sketch bake loops contour hole close exit discard empty re-edit reopen layer tab',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-entry', 'construction-geometry'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-limits',
    title: 'Sketch size limits',
    category: 'sketching',
    summary: 'The constraint solver works in a fixed amount of memory: large sketches are solved piece by piece, and a single connected piece that is too big fails with an error instead of guessing.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The sketch solver runs in a fixed 16 MB of memory. Above 150 entities, the sketch is split into its separate connected pieces and each piece is solved on its own - the answer is the same as one big solve, because geometry that is not connected cannot affect other geometry.',
      },
      {
        kind: 'paragraph',
        text: 'The split cannot help a single piece where hundreds of entities are all tied together by constraints. If such a piece is too big, the solve fails with an error rather than giving wrong geometry. A block enters the solver as one piece no matter how many curves it holds, which is why an imported layer, which opens as one locked block, stays small to solve.',
      },
    ],
    images: [],
    keywords: 'solver limit memory large sketch entities 150 partition connected piece fail block oom',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['sketch-blocks', 'sketch-definition-states'],
    sinceVersion: '0.36.0',
  },
])
