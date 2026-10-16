import { localizeHelpTopics } from '../catalog'
// WO-2252: Form's Help - what Form is, every tool group on its rail and in its
// palette, and the two walkthroughs (docs/examples/form/) that play inside
// Help. Listed under Modeling (registry.ts): Form is a mode of the Model screen.

import type { HelpImage, HelpTopic } from '../../types'

const FORM_KEYS = ['interaction:form', 'workspace:part']

/** One full-screen picture of the Model screen in Form (1600 x 1000). */
function picture(slot: string, alt: string, captureNotes: string): HelpImage {
  return { slot, file: `${slot}.webp`, alt, captureNotes, status: 'done' }
}

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'form-workspace',
    title: 'Form (smooth organic shapes in the Model tab)',
    category: 'modeling',
    summary: 'Form shapes smooth organic parts - knobs, handles, grips - by moving a coarse control cage; a smooth surface follows it, and Finish Form makes it an exact solid in the design tree.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Form works on a cage: the dark lines and points drawn round the part. The smooth skin inside the cage follows it - move a cage point, edge or face and the skin moves smoothly with it. A few cage points shape a whole handle, which is why Form is the quick way to make shapes that would take many lofts and blends with the standard tools.',
      },
      {
        kind: 'steps',
        steps: [
          'In the Model tab, click Form in the Create group of the rail. Form opens in the same view: the rail shows the Form tools and the Form palette docks beside it.',
          'Pick a start under Start from (Cylinder, Box and so on), or select a sketch or body in the tree first and start from it.',
          'Shape it: click a point, edge or face and drag the arrows. Add loops, creases and symmetry as you go.',
          'Type a Name at the top of the palette and press Finish Form. The part becomes one Form row in the design tree, and standard features (holes, fillets, cuts) work on it like on any other body.',
        ],
      },
      { kind: 'image', slot: 'form-overview' },
      {
        kind: 'paragraph',
        text: 'The palette holds the settings for the tools, in groups named after the rail groups they belong to: Start from, Edit form, Topology, Openings, Symmetry (while a symmetry is on) and Display. Click a group\'s name to fold it; the folds are remembered. When the rows are taller than the window the palette scrolls, with a scrollbar you can see. The chevron in the palette\'s header folds the whole palette to a strip at the side, so the view gets its whole width back; click the strip to bring it back. The bottom of the palette shows the cage size, what is selected, and the last thing a tool did.',
      },
      {
        kind: 'paragraph',
        text: 'Finish Form writes the form into the model and leaves Form. Cancel (or the X in the palette header) leaves the tree as it was. Undo and Redo in the Form history group (Ctrl+Z, Ctrl+Shift+Z) step through the cage edits; they show once there is something to undo.',
      },
      { kind: 'heading', text: 'Start from', anchor: 'start-from' },
      {
        kind: 'paragraph',
        text: 'Box, Cylinder, Sphere, Torus and Plane start a new cage with the counts on the palette\'s Segments row (Around, Along, X, Y, Z - up to 32). Every starter sits on the table (Z = 0), centred on the Z axis. Clicking a starter again starts over, as one undo step.',
      },
      {
        kind: 'paragraph',
        text: 'The other starters use what is selected in the design tree. Pipe makes a tube along the selected sketch\'s curve (lines, arcs, circles, splines; pieces joined end to end are followed in order): a ring round a closed curve, flat ends on an open one. The palette\'s Pipe radius sets its size (0 picks one from the path). Select a next sketch that starts where the pipe ends and click Pipe again to carry it on, onto other planes too. Extrude takes the sketch\'s profile along its plane\'s normal by the palette\'s Extrude height. Revolve turns it round the sketch\'s construction line (else a sketch axis it does not cross) by the palette\'s Revolve angle, with the number of cage spans round it set in the Revolve row\'s round field. Loft passes the skin through two or three sketch profiles, one Loft click per sketch; an open curve from the first profile to the last, added the same way, is a rail the sides follow. Face builds a cage by clicking 4 corners per face on the selected plane (Enter makes a triangle of 3, Esc stops). From body starts from the STEP or STL body selected in the tree: flat faces and sharp edges are kept, and curved fillets, pocket blends and domes retain their shape within the Form reconstruction tolerance. The source STL is hidden while its Form feature is active; Undo or rollback before the Form restores it.',
      },
      { kind: 'image', slot: 'start-from' },
      { kind: 'heading', text: 'Edit form: select and move', anchor: 'edit-form' },
      {
        kind: 'paragraph',
        text: 'Click a cage point, edge or face to select it; Shift+click adds to the selection and a click on empty space clears it. A face can be clicked on the smooth skin, inside the cage. Move, Rotate and Scale choose the handles the gizmo shows: drag an arrow to move along X (red), Y (green) or Z (blue). Alt+drag a face\'s arrow to extrude new faces from it. Left-drag on empty space orbits the view as usual.',
      },
      {
        kind: 'paragraph',
        text: 'Soft (palette) makes points near the selection follow a move part of the way, fading out at the radius you type (0: only the selection moves). Flatten puts the selected points on a plane - their best fit, or the one chosen in the palette (an X, Y or Z plane, the selected face\'s plane, or the mirror plane). Straighten puts each selected edge chain on the line between its ends. Uniform evens out the spacing of the points (the whole form when nothing is selected); points on an open border or a crease stay. Pull moves the cage so the smooth skin passes through the selected points where they are now.',
      },
      {
        kind: 'paragraph',
        text: 'With Rotate selected, the palette\'s Axis list starts at Selection centre. Choose X, Y or Z beside Rotate, enter an angle in degrees and press Apply. Pick cage edge uses an edge as the axis; X through point, Y through point and Z through point ask for a cage point without replacing your selection. The marked axis also works with the rotation ring. Esc or Selection centre returns to centre rotation. Changing the selection or leaving Rotate clears the picked axis.',
      },
      { kind: 'image', slot: 'edit-form' },
      { kind: 'image', slot: 'rotate-axis' },
      { kind: 'heading', text: 'Topology: loops, creases, faces and welds', anchor: 'topology' },
      {
        kind: 'paragraph',
        text: 'Insert loop adds a loop of edges across the ring through the selected edge, at the palette\'s Loop at position (0.5 is the middle; right after Insert loop the slider moves the new loop). Crease makes the selected edges sharp, at the palette\'s Crease weight (0 fully sharp; 0.5 to 3 soft to firm); Uncrease makes them smooth again. A face whose edges are all creased comes out flat, so other features can use it. Insert point splits each selected edge in the middle. Subdivide splits the selected faces into quads round their centres.',
      },
      {
        kind: 'paragraph',
        text: 'Add face adds faces by clicking 4 corners each - on the work plane, or on the form\'s own points to join them; Chain starts each next face on the last one\'s edge, 2 clicks a face. Weld merges the selected points into one. Weld close joins points closer than the palette\'s Weld distance (among the selection, or across the form). Unweld cuts the form open along the selected edges, or round the selected faces.',
      },
      { kind: 'image', slot: 'topology' },
      { kind: 'heading', text: 'Select', anchor: 'select' },
      {
        kind: 'paragraph',
        text: 'These widen what is selected without clicking every piece. Loop adds the edge loop of each selected edge (straight on through the points round it). Ring adds the edge ring (across the faces beside it). Grow widens the selection by one ring, Shrink narrows it by one. All selects every face - or every edge or point when edges or points are selected.',
      },
      { kind: 'image', slot: 'select' },
      { kind: 'heading', text: 'Openings: delete, fill, bridge, thicken', anchor: 'openings' },
      {
        kind: 'paragraph',
        text: 'Delete removes the selected faces, leaving the form open there; with only edges selected it removes those edges (the faces either side merge), with only points selected those points. Fill hole caps the opening through the selected rim edge with one face. Bridge joins two selected faces or face sets, or the edges of two openings, with a band of faces: a handle, a hole straight through, or two pieces joined. The palette sets how many rings long the band is and its twist. Thicken closes an open form with an inner skin, the palette\'s wall thickness inside it (the row shows while the form has an opening).',
      },
      { kind: 'image', slot: 'openings' },
      { kind: 'heading', text: 'Symmetry', anchor: 'symmetry' },
      {
        kind: 'paragraph',
        text: 'Mirror X, Mirror Y and Mirror Z keep the two halves the same: paired points move together and points on the plane stay on it. The palette\'s Mirror row moves the plane, and so does dragging the plane in the view. Circular keeps copies round the Z axis in step - as many as the form fits, or the palette\'s Circular copies (the copies must fit the segments: an 8-segment cylinder takes 8, 4 or 2). Between places a mirror plane from the selection: two points go halfway between them, three or more lie on it. Duplicate mirrors a copy of the form across the plane and joins the halves: model half, get the whole. Clicking an active Mirror or Circular button turns symmetry off.',
      },
      { kind: 'image', slot: 'symmetry' },
      { kind: 'heading', text: 'Display', anchor: 'display' },
      {
        kind: 'paragraph',
        text: 'Cage shows only the control cage, Smooth only the smooth skin (the surface you will get), Both the cage over the skin. The palette\'s Smooth row (level) sets how finely the skin is drawn (0: automatic) - display only, the finished body is exact either way. Tolerance sets how far the finished body\'s display facets may stray from the smooth surface. Zebra stripes and Curvature in the view\'s Display Mode menu help judge the surface.',
      },
      { kind: 'image', slot: 'display' },
      { kind: 'heading', text: 'What Finish makes, and the limits', anchor: 'limits' },
      {
        kind: 'paragraph',
        text: 'Finish Form puts one Form feature in the design tree with its body: an exact solid of the smooth surface (B-spline faces, flat regions as planes), so holes, fillets, chamfers, booleans and cuts work on it and a STEP export carries the smooth surfaces. Where three, or five or more, edges meet at a cage point, the faces round it still meet smoothly. Edit on the tree row reopens the cage where you left it, and every feature after it rebuilds when you Finish again. The tree does not record the edits made inside Form one by one - they all live in that one row.',
      },
      {
        kind: 'paragraph',
        text: 'Limits: a cage edit the cage cannot hold (for example a weld that pinches the surface) is not applied, and the palette\'s notice says why. Bridge cannot join a closed opening to an open one, and Face cannot use a repeated corner or corners on one line; the palette says what to select instead. Not every Form part shells: a Form body with a slot cut across it may not; Shell the Form body first, then cut. Circular symmetry takes only a number of copies the cage divides into.',
      },
      {
        kind: 'tip',
        text: 'The walkthroughs "Form example: lobed knob" and "Form example: grip handle" play a whole part being made, step by step, and open the finished project.',
      },
    ],
    images: [
      picture('form-overview', 'The Model tab in Form: a cylinder cage over its smooth skin, the Form tools on the rail and the Form palette docked beside it', 'Model screen, Form just opened with Start from: Cylinder. The cage over the smooth skin, the rail showing the Form groups, the Form palette docked beside the rail with every group open.'),
      picture('start-from', 'Start from: Pipe, a tube cage along a sketched arch', 'A sketched arch selected in the tree, Pipe radius 6 mm in the palette, Pipe clicked: the tube cage along the arch, the notice at the bottom of the palette naming the path.'),
      picture('edit-form', 'Edit form: a column of cage points selected and pulled out along X with the gizmo, the Soft radius set in the palette', 'A cylinder with Circular symmetry, one column of points selected and moved out 10 mm along X: four lobes, the move gizmo on the selection, the selection line in the palette.'),
      picture('rotate-axis', 'Form Rotate with Selection centre, Y, a typed 90 degree angle and Apply; selected cage faces and rotation rings', 'Accepted WO-2508 capture at 7dee853bf47d6d38f12a490199bc45ebbadf492e; reused after visible-source equivalence review. Selection centre rotation before Apply, not a new capture.'),
      picture('topology', 'Topology: a loop inserted round a box cage and its top edges creased', 'A box cage: Insert loop run on a side edge, the top face edges creased (Crease weight 0), Both display.'),
      picture('select', 'Select: an edge loop selected with Loop', 'A cylinder cage: one ring edge clicked, then Loop: the whole ring of edges selected, the palette reading the selection.'),
      picture('openings', 'Openings: two faces bridged into a hole straight through a box form', 'A box cage with 3 x 3 segments, the middle faces of the front and back selected and joined with Bridge: a hole through the form.'),
      picture('symmetry', 'Symmetry: Mirror X on, the mirror plane in the view and its Mirror row in the palette', 'A box cage with Mirror X on, one corner point moved and its mirror following; the mirror plane drawn in the view, the palette showing the Mirror row.'),
      picture('display', 'Display: a four-lobed cage shown Smooth - only the surface you will get - with the Display rows in the palette', 'The four-lobed cylinder (Circular 4, lobes out 10 mm, valleys in) with Display: Smooth; the palette showing its Symmetry and Display groups.'),
    ],
    keywords: 'form subd subdivision catmull clark organic smooth cage skin knob handle grip start from box cylinder sphere torus plane pipe extrude revolve loft face from body segments move rotate scale gizmo alt drag extrude soft flatten straighten uniform pull pull to body insert loop crease uncrease weight insert point add face chain subdivide weld weld close unweld loop ring grow shrink all delete fill hole bridge thicken mirror circular between duplicate symmetry display cage both smooth tolerance level palette fold scroll finish exact bspline body undo redo limits',
    contextKeys: FORM_KEYS,
    relatedTopicIds: ['form-walkthrough-lobed-knob', 'form-walkthrough-grip-handle', 'model-workspace-tour', 'feature-tree-history'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'form-walkthrough-lobed-knob',
    title: 'Form example: lobed knob',
    category: 'modeling',
    summary: 'A video of a four-lobed control knob made in Form and finished with a shaft, a bore and a fillet - with the steps beside it and an Open this example button for the finished project.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The lobes and finger valleys are one smooth Form surface; the shaft, the bore and the rim fillet are standard features, so they are exact and dimensioned. The video is one continuous take in the app, about a minute and a half, with the mouse drawn as an orange dot (it shrinks while the button is held).',
      },
      { kind: 'image', slot: 'video' },
      {
        kind: 'steps',
        steps: [
          'Model tab: click Form on the rail, then Start from: Cylinder.',
          'Symmetry: Circular, and set 4 copies in the palette.',
          'Click a point on the middle ring, then Shift+click the points above and below it. Drag the red X arrow out 10 mm: all four lobes pull out together.',
          'Click empty space. Select the column between two lobes the same way. Drag X in 6 mm, then Y in 6 mm: the finger valleys.',
          'Left-drag down on empty space to look from above. Click the top face and drag the blue Z arrow down 8 mm: a lower crown.',
          'Left-drag up to orbit underneath. Click the bottom face, then Topology: Crease. The base comes out flat.',
          'Display: Smooth. Name it and press Finish Form.',
          'Sketch a 4 mm diameter circle on XY and Extrude it Blind 10 mm, Direction Down, Result Add: the shaft, joined to the knob.',
          'Hole: 3 mm, 12 deep, in the shaft end.',
          'Fillet 1.5 mm on the base rim - a standard fillet on an edge Form made.',
          'Orbit back over the top and tick Zebra stripes in Display Mode to check the surface.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The design tree of the example reads: Lobed knob (Form), Shaft profile (sketch), Shaft (extrude), Bore (hole), Rim fillet. Open it with Open this example beside the video (in the repository it is public/help/form-walkthrough-lobed-knob/lobed-knob.camproject), click Edit on the Lobed knob row, move a point and Finish: the shaft, bore and fillet rebuild on the new shape.',
      },
    ],
    images: [
      {
        slot: 'video',
        file: 'lobed-knob.mp4',
        alt: 'The lobed knob made in Form, then its shaft, bore and rim fillet (about a minute and a half)',
        captureNotes: 'node src/tests/evidence/FORM/tutorials.mjs knob (FORM_FFMPEG for MP4): one continuous take, real clicks, gizmo and orbit drags, captions in the strip along the top of the view. Copied here with lobed-knob.camproject (Open this example).',
        status: 'done',
      },
    ],
    keywords: 'form example walkthrough tutorial video lobed knob control knob circular symmetry lobes valleys crown crease shaft bore hole fillet zebra open example project',
    contextKeys: FORM_KEYS,
    relatedTopicIds: ['form-workspace', 'form-walkthrough-grip-handle'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'form-walkthrough-grip-handle',
    title: 'Form example: grip handle',
    category: 'modeling',
    summary: 'A video of a pull handle made as a Form pipe along a sketch, shaped by hand and joined to a machined mounting plate - with the steps beside it and an Open this example button for the finished project.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The handle is a Form pipe along a sketched arch, with a palm swell pulled up by hand; the plate, its corner fillets and the mounting holes are standard features. The pipe\'s ends sit inside the plate, so handle and plate are one solid. The video is one continuous take in the app, under a minute.',
      },
      { kind: 'image', slot: 'video' },
      {
        kind: 'steps',
        steps: [
          'Sketch on XZ: an arc of radius 26 mm whose ends dip 3 mm below the XY plane, where the plate will be.',
          'Select the sketch in the tree, then click Form.',
          'Set the palette\'s Pipe radius to 6 mm, then click Pipe: a tube follows the sketch.',
          'Symmetry: Mirror X, so the two halves stay the same.',
          'Edit form: Soft radius 22 mm.',
          'Click the top of the arch and drag the Z arrow up 5 mm: a palm swell. The neighbouring points follow part of the way.',
          'Display: Smooth. Name it and press Finish Form.',
          'Sketch an 80 x 30 mm rectangle on XY and Extrude it Blind 6 mm, Direction Up, Result Add: the plate, joined to the grip.',
          'Fillet the plate\'s four corners, 5 mm.',
          'Construct: Offset plane 6 mm above XY (the plate top). Sketch four 5 mm diameter circles on it and Extrude them with End Through all, Direction Down, Result Remove: the mounting holes.',
          'Orbit underneath to see the holes go through, then back over the top and tick Zebra stripes in Display Mode.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The design tree of the example reads: Handle path (sketch), Grip (Form), Plate (sketch), Plate (extrude), Corner fillets, Plate top (offset plane), Mounting holes (sketch), Mounting holes (extrude cut). Open this example beside the video opens it (in the repository it is public/help/form-walkthrough-grip-handle/grip-handle.camproject).',
      },
    ],
    images: [
      {
        slot: 'video',
        file: 'grip-handle.mp4',
        alt: 'The grip handle made as a Form pipe, then joined to a plate with fillets and mounting holes (under a minute)',
        captureNotes: 'node src/tests/evidence/FORM/tutorials.mjs grip (FORM_FFMPEG for MP4): one continuous take, real clicks, gizmo and orbit drags, captions in the strip along the top of the view. Copied here with grip-handle.camproject (Open this example).',
        status: 'done',
      },
    ],
    keywords: 'form example walkthrough tutorial video grip handle pull handle pipe along sketch arch palm swell soft mirror plate fillet offset plane mounting holes cut zebra open example project',
    contextKeys: FORM_KEYS,
    relatedTopicIds: ['form-workspace', 'form-walkthrough-lobed-knob'],
    sinceVersion: '0.35.0',
  },
])
