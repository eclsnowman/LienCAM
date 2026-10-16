import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'model-to-cam',
    title: 'Model-to-CAM flow',
    category: 'modeling',
    summary: 'Bodies built or edited in the Model tab show up in Setup as parts marked MODEL, ready for stock, setups and operations.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Build or edit the part in the Model tab. The name at the top of the left panel (Project Model to start with) is the model you are working on.',
          'Press Finish at the top of the left panel to go back to Setup, or click any other tab. Every body of the model is a row in the Geometry list, marked MODEL.',
          'Build stock, setups and operations on those rows like any other part. When the model changes, its parts in Setup change with it.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'On a MODEL row, the pen button (Edit model) opens the Model tab on that model, the eye hides it, and the trash button (Delete model) deletes the whole model and every part it makes - it asks first and names them, and Undo brings them back. To remove only one body, delete it in the Model tab. The row\'s right-click menu has Edit model, Rename model..., Delete model, Rename (this row\'s own name) and Hide. Selecting the row shows the model in the Properties panel: its body count, Edit, Rename and Delete buttons, and its Position and Rotation.',
      },
      {
        kind: 'paragraph',
        text: 'At the top of the Model tab\'s left panel, double-click the model\'s name to rename it, use the arrow to switch to another model, and press + for a new model.',
      },
      { kind: 'image', slot: 'tree-mirror' },
    ],
    images: [
      {
        slot: 'tree-mirror',
        file: 'tree-mirror.webp',
        alt: 'The Geometry list in Setup with two bodies from the Model tab, each marked MODEL',
        captureNotes: 'Setup tab, top of the left panel: the Geometry section with two rows made in the Model tab, each marked MODEL, with their Edit model, hide and Delete model buttons.',
        status: 'done',
      },
    ],
    keywords: 'model cam body part workspace geometry row model badge finish edit model delete model rename switch new model properties flow',
    contextKeys: ['workspace:cam', 'workspace:part'],
    relatedTopicIds: ['setup-wcs', 'model-placement', 'edit-import-as-model'],
    sinceVersion: '0.16.1',
  },
  {
    id: 'model-workspace-tour',
    title: 'The Model workspace',
    category: 'modeling',
    summary: 'The Model tab builds and edits solid parts: feature tree, bodies, parameters and inspect tools on the left, the 3D view in the middle, and the modeling tools on the right.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The left panel starts with the model\'s name, a switch-model arrow, + (New model) and Finish (back to Setup). Below that are four sections you can fold: Model (the feature tree with its filter bar), Bodies (one row per solid with a show checkbox, a colour swatch and its volume), Parameters (named values), and Inspect (Measure, Appearance, hide and isolate, Section, and mass properties).',
      },
      {
        kind: 'paragraph',
        text: 'The right rail holds the modeling tools in five groups: Sketch (New sketch), Create (Extrude, Revolve, Sweep, Loft, Form, Relief, Boolean), Construct (Offset plane, Midplane, At angle, Axis, Plane through, Tangent plane, Point), Modify (Push/Pull, Fillet, Chamfer, Shell, Draft, Hole, Resize hole, Move Hole, Defeature, Edit...) and Document (Undo, Redo, Import, Export, STL, Debug export). Click a group\'s name to fold it, and the button at the top of the rail switches to compact icons (hover a tool for its name); both are remembered. While a sketch is open the rail shows the sketch tools instead, and in Form it shows the Form tools.',
      },
      { kind: 'heading', text: 'Docked palettes', anchor: 'docked-palettes' },
      {
        kind: 'paragraph',
        text: 'Form and Relief open a palette docked beside the rail: a column of the screen, so the view narrows for it instead of being covered. Its groups fold by their names, and when the rows are taller than the window the palette scrolls, with a scrollbar you can see. The chevron in the palette\'s header folds the whole palette to a slim strip at the side, giving the view its whole width back; click the strip to bring it back. The Cancel and Finish (or Apply) buttons stay at the bottom while the rows scroll.',
      },
      { kind: 'heading', text: 'Construct: planes, axes and points', anchor: 'construct' },
      {
        kind: 'paragraph',
        text: 'The Construct group makes reference geometry for sketches and features: Offset plane, Midplane and At angle make planes from a plane or flat face; Plane through makes one through three points or two edges, and Tangent plane touches a cylinder where you click; Axis runs through a cylinder or hole, along an edge or through two points; Point marks a vertex, a circle\'s centre, or where an edge meets a plane. Each gets its own row in the tree and follows the model when it changes. "Sketching on a plane or face" has the details of each.',
      },
      { kind: 'heading', text: 'What the tree shows', anchor: 'tree-rows' },
      {
        kind: 'paragraph',
        text: 'The Model section lists the part\'s history in order: Origin and the XY, XZ and YZ planes at the top, then a row for every sketch (pen icon), every construction plane, axis and point, every imported STEP or STL part, and every feature - Extrude, Revolve, Sweep, Loft, Form, Relief, Boolean, Push/Pull, Fillet, Chamfer, Shell, Draft, Hole, Resize hole, Move Hole and Defeature - each under the name you gave it. A Form row holds everything done inside Form; Edit on it reopens the cage. Every row has its status mark, a suppress button and a right-click menu, and sketch rows an eye to show or hide them ("The feature tree"); the bodies the features make are shown, hidden and isolated from the Bodies list below.',
      },
      {
        kind: 'paragraph',
        text: 'The view cube sits in the bottom-left corner of the 3D view: click a face (TOP, FRONT, RIGHT and so on) to look from that side. The small cube button beside it opens Display mode: Shaded with edges, Shaded, no edges, Unshaded (wireframe) or Translucent, Perspective or Orthographic, and the Zebra stripes and Curvature checks for judging smooth surfaces. Press N, then click a face or plane, to look straight at it.',
      },
      {
        kind: 'paragraph',
        text: 'Along the bottom, the message line shows what the tool in use wants or what it just did, and the status bar counts the bodies and features. At 1440- and 1680-pixel window widths, the left panel scrolls within its split panes: scroll down to reach the Inspect and Section controls below the fold.',
      },
      {
        kind: 'tip',
        text: 'When a tool waits for a click in the view, a bar at the bottom of the view says what to click and has a Cancel button. The other tools grey out until you finish or cancel.',
      },
      { kind: 'image', slot: 'workspace-overview' },
    ],
    images: [
      {
        slot: 'workspace-overview',
        file: 'workspace-overview.webp',
        alt: 'The Model tab with the lobed knob example: the tree with its Form row and standard features, the 3D view with the view cube, and the right tool rail',
        captureNotes: 'Full Model tab with the lobed knob example opened from Help (Open this example): the left panel (model name, Model tree with Lobed knob, Shaft profile, Shaft, Bore, Rim fillet; Bodies, Parameters, Inspect), the 3D view with the view cube bottom-left, and the right rail with its Sketch, Create, Construct, Modify and Document groups. node src/tests/evidence/WO-2252/pictures.mjs',
        status: 'done',
      },
    ],
    keywords: 'model workspace tour part tab feature tree body list tool rail view cube display mode wireframe translucent perspective orthographic inspect sections layout overview finish docked palette fold scroll strip compact construct plane axis point relief form tree rows',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['model-to-cam', 'feature-tree-history', 'model-sketch-plane-face', 'form-workspace', 'model-relief'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'model-sketch-plane-face',
    title: 'Sketching on a plane or face',
    category: 'modeling',
    summary: 'New sketch waits for one click in the view: a base plane (XY, XZ, YZ), a visible offset plane, or any flat face of a body - and the sketch opens there.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click New sketch in the Sketch group of the rail. The bar at the bottom of the view reads "Click a base plane, visible construction plane, or flat face to start the sketch".',
          'Click the XY, XZ or YZ plane, an offset plane you made, or a flat face on a body. The sketch opens on it.',
          'Draw, then press Finish at the top of the sketch tools (or Cancel to throw the sketch away). The sketch is added to the feature tree, and Extrude, Revolve and Sweep turn on once a sketch exists.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A sketch on a face starts empty - nothing from the face is copied into it. If a later change removes that face, the sketch\'s plane row shows Degraded; select that row and a Reattach button appears in the Sketch group, so you can pick a new flat face for it without losing the sketch.',
      },
      {
        kind: 'warning',
        text: 'A curved face cannot hold a sketch. Clicking one says "That face is not flat - pick a flat face or a base plane." and the pick stays on so you can try again.',
      },
      { kind: 'image', slot: 'plane-glyphs' },
      { kind: 'heading', text: 'Offset planes', anchor: 'offset-planes' },
      {
        kind: 'paragraph',
        text: 'Offset plane (Construct group) makes a flat construction plane parallel to another one. Choose the Source plane (XY, XZ or YZ plane) or click a flat face or plane in the view, give it a Name and a Signed distance (mm), tick Flip plane orientation if you need the other side, then Apply. The plane gets its own row in the feature tree. New sketch can start on it, and Extrude can stop at it with Up to face / plane.',
      },
      {
        kind: 'paragraph',
        text: 'Midplane makes the plane halfway between two planes or flat faces: pick the First plane, then the Second plane (or click two in the view, one after the other). Two parallel faces give the plane halfway across; two that meet give the plane through their shared line that halves the angle between them.',
      },
      {
        kind: 'paragraph',
        text: 'At angle (Plane at angle) turns a plane or flat face about its own X or Y axis, or about an axis you made with Axis, by the Angle (deg) you type (choose it under Turn about). A positive angle turns right-handed about that axis. About an axis, the new plane holds the axis and at 0 deg faces the way the source plane does. Both new planes get their own tree rows and work everywhere an offset plane does.',
      },
      {
        kind: 'paragraph',
        text: 'Axis (Construct group) makes a straight axis line. Choose the Type, then click in the view: Through a cylinder or hole - click the round face (a flat face gives the axis square to it, through its centre); Along an edge - click a straight edge (a round edge gives its centre axis); Through two points - click two corners, first then second. Name it, tick Flip direction to run it the other way, then Apply. The axis gets its own tree row and follows the faces it came from when the model changes. Revolve can spin about it and At angle can turn a plane about it.',
      },
      {
        kind: 'paragraph',
        text: 'Plane through (Construct group) makes a plane from picks. Choose the Type, then click in the view: Through three points - click three corners (X runs from the first to the second); Through two edges - click two edges (a round edge counts as its centre line; edges that do not meet give the plane through the first, parallel to the second). Tangent plane touches a cylinder or shaft where you click it, facing out (a flat face gives its own plane). Name it, tick Flip normal to face it the other way, then Apply. These planes follow the faces they came from when the model changes and work everywhere an offset plane does - New sketch, Extrude, Offset plane.',
      },
      {
        kind: 'paragraph',
        text: 'Point (Construct group) marks a point in space: At a vertex - click a corner; At a circle\'s centre - click a round edge (a round face gives its axis at its middle, a flat face its centre); Where an edge meets a plane - click an edge, then choose the plane in the list (XY, XZ, YZ or any construction plane) or click a flat face. The point gets its own tree row and follows the model when it changes.',
      },
    ],
    images: [
      {
        slot: 'plane-glyphs',
        file: 'plane-glyphs.webp',
        alt: 'The Model tab right after New sketch: the planes in the view and the pick bar at the bottom',
        captureNotes: 'Model tab right after clicking New sketch, with one body, the view orbited to the back-right and zoomed out so the XY, XZ and YZ planes and their labels all show; the bottom pick bar reads "Click a base plane, visible construction plane, or flat face to start the sketch".',
        status: 'done',
      },
    ],
    keywords: 'new sketch plane face xy xz yz base plane construction offset plane midplane mid plane angle plane at angle hinge signed distance flip pick sketch on face reattach degraded blank flat refuse axis datum construction axis hole cylinder edge two points plane through three points 3 point two edges tangent plane shaft point datum vertex circle centre center edge meets plane',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['extrude', 'sketch-entry', 'model-workspace-tour'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'extrude',
    title: 'Extrude',
    category: 'modeling',
    summary: 'Extrude pulls a closed sketch profile into a solid: pick the profile, choose how far it goes (End), and whether the result is a new body or adds to, cuts or intersects a body you already have.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Select the sketch in the feature tree, then click Extrude in the Create group (it turns on once a sketch exists). The panel opens beside the view with that whole sketch as the profile, and the view shows a live preview.',
          'To use only some closed areas of the sketch, press "Pick profile in viewport" and click the areas - each click adds or removes one. Press Enter or Done picking to keep them; Escape cancels. "Use whole sketch" goes back to every area.',
          'Choose End: Blind (a Distance in mm), Symmetric (the Distance split both sides of the sketch), Up to next (the next face it meets), Up to face / plane, Up to part / body, Up to vertex / point, or Through all. The three "Up to" choices add a pick button - click the face, plane, body or point in the view or the tree. Up to next and the "Up to" choices also take an Offset in mm.',
          'Set Direction (Up or Down), then Result: New body, Add, Remove or Intersect. For anything but New body, press "Pick body in viewport" and click the body to change. Press Apply.',
        ],
      },
      {
        kind: 'tip',
        text: 'The fx field under Distance takes a driving expression such as 2*base+5 using names from the Parameters table. While an expression is in the field the Distance box is greyed out, and changing the parameter later rebuilds the extrude.',
      },
      {
        kind: 'paragraph',
        text: 'Each picker also has a fallback list: "Choose profile by name fallback" (the sketch and its areas by number) and "Choose target by name fallback" (the body).',
      },
      { kind: 'image', slot: 'extrude-dialog' },
    ],
    images: [
      {
        slot: 'extrude-dialog',
        file: 'extrude-dialog.webp',
        alt: 'The Extrude panel with a sketch picked from the tree and its preview in the view',
        captureNotes: 'Extrude panel open beside the view with a sketch picked from the design tree ("from the design tree - whole sketch"), End, Direction, Distance, fx and Result visible, "Live preview ready", and the previewed body in the view.',
        status: 'done',
      },
    ],
    keywords: 'extrude profile distance direction up down end condition blind symmetric midplane up to next up to face plane up to part body up to vertex point through all offset new body add remove intersect target pick expression fx pad cut',
    contextKeys: ['modal:extrude-dialog', 'workspace:part'],
    relatedTopicIds: ['model-sketch-plane-face', 'revolve-sweep-loft', 'model-parameters'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'revolve-sweep-loft',
    title: 'Revolve, sweep, loft',
    category: 'modeling',
    summary: 'Three more ways to turn sketches into solids: spin a profile around an axis, run it along a straight path, or blend two sketches into one shape.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Revolve spins one closed sketch profile around an axis: World Z (through origin) by default, or any axis made with Construct > Axis, chosen in the panel\'s Axis list. Pick the profile the same way as Extrude, then set the Angle from 1 to 360 deg. The Angle has an fx field for a driving expression too. A revolve about an axis follows the axis when the model changes.',
      },
      {
        kind: 'paragraph',
        text: 'Sweep runs a closed profile along a straight path set by three fields: Path axis (World X, World Y or World Z), Length in mm, and Orientation (Fixed or Frenet).',
      },
      {
        kind: 'paragraph',
        text: 'Loft blends exactly two sketches. The button turns on once two sketches exist. Press "Pick sections in viewport" and click the first section, then the second - the order matters (the panel shows First and Second). Spacing moves the second section along world Z, and the Ruled box switches between straight and smooth blending. Picking the same sketch twice shows "Sections must be different sketches."',
      },
      {
        kind: 'tip',
        text: 'The panel stays open while you pick in the view, so your typed values stay in sight; its Cancel button reads Stop picking until you finish.',
      },
      { kind: 'image', slot: 'three-results' },
    ],
    images: [
      {
        slot: 'three-results',
        file: 'three-results.webp',
        alt: 'Three bodies made with revolve, sweep, and loft side by side',
        captureNotes: '3-up viewport shot: a revolved profile, a swept profile along an axis, and a loft between two different sketch sections, each labeled.',
        status: 'needed',
      },
    ],
    keywords: 'revolve sweep loft spin axis angle path length frenet fixed orientation sections spacing ruled blend two sketches stop picking axis datum',
    contextKeys: ['modal:revolve-dialog', 'modal:sweep-dialog', 'modal:loft-dialog'],

    relatedTopicIds: ['extrude', 'model-sketch-plane-face'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'fillet-chamfer-3d',
    title: '3D fillet and chamfer',
    category: 'modeling',
    summary: 'Fillet and Chamfer each open one slim bar at the bottom of the view: click edges and type the size, with a live preview - and Fillet can also change the radius of a fillet already on an imported part.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Fillet in the Modify group. A slim bar appears at the bottom of the view with the edge count, the Radius field, and Apply and Cancel, with nothing covering the part.',
          'Click edges in the view to add or remove them. The preview updates as the edges and the radius change.',
          'Type a radius at any time - the digits go straight into the Radius field. Press Enter or Apply when the preview looks right; Escape or Cancel puts the part back as it was.',
          'Chamfer works the same way in its own bar: click edges, type the Distance, watch the preview, then Enter or Apply.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Apply stays greyed out until the preview is ready, so you always see the shape before you commit it. A size that does not fit shows why in the bar and the part stays as it was. One fillet or chamfer works on one body: once the first edge is picked, clicks on other bodies are ignored.',
      },
      {
        kind: 'paragraph',
        text: 'On an imported STEP part, turn on Fillet and click a fillet that is already on the part: the bar opens with its current radius. Type the new radius and Apply - the recognized fillet or its tangent chain changes. On an STL opened in the Model tab, Fillet changes the radius of a rounded edge the same way, and Chamfer puts a chamfer on the sharp edges you click.',
      },
      { kind: 'image', slot: 'fillet-preview' },
      {
        kind: 'paragraph',
        text: 'On imported STEP and STL parts, a tangent-connected fillet or chamfer chain is one feature. With Fillet or Chamfer active, click an existing blend to change its radius or distance for the whole chain. Defeature removes the recognized chain as a whole; removing a boss takes its foot fillet with it. A size that cannot be built leaves the part unchanged and gives the reason.',
      },
      {
        kind: 'paragraph',
        text: 'Chamfer picks real sharp edges. The seam used to draw a cylinder is not a sharp edge and is not offered for Chamfer.',
      },
    ],
    images: [
      {
        slot: 'fillet-preview',
        file: 'fillet-preview.webp',
        alt: 'The slim Fillet bar with two edges selected, the radius typed, and the rounded edges previewed on the body',
        captureNotes: 'Fillet bar at the bottom of the view (no card, part not covered): "2 edges selected", Radius field, Ready, Apply and Cancel together; two picked edges lit on the body and the rounded edges previewed.',
        status: 'done',
      },
    ],
    keywords: 'fillet chamfer round bevel edge pick radius distance live preview ready apply cancel break edge change existing fillet radius imported step stl command bar enter escape',
    contextKeys: ['modal:fillet-dialog', 'modal:chamfer-dialog'],
    relatedTopicIds: ['shell-draft-hole', 'feature-tree-history', 'model-imported-parts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'shell-draft-hole',
    title: 'Shell, draft, hole',
    category: 'modeling',
    summary: 'Shell hollows a body and opens the faces you pick, Draft tilts faces about a neutral face, and Hole places simple, counterbore or countersink holes - one at a time or in a pattern.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Shell: click Shell and a slim bar appears at the bottom of the view. Click the faces to open (click again to keep one closed) and type the Thickness; the hollowed body previews as either changes. Enter or Apply commits; Escape or Cancel puts the part back. While the shell is being applied the bar reads Applying... and Cancel is greyed out.',
      },
      {
        kind: 'paragraph',
        text: 'Draft works in two steps on a small card (Draft faces). Step 1: click the neutral face - the face that keeps its size - and press "Confirm neutral face" ("Reselect neutral face" goes back). Step 2: click each face to draft. Set the Angle (0.1 to 89.9 deg), use Flip to reverse the pull direction, and an Offset in mm moves the neutral plane. A line under the fields spells out the pull direction and the neutral-plane offset. Apply turns on when the card reads "Preview ready".',
      },
      {
        kind: 'paragraph',
        text: 'Hole: click Hole, then click a face - the panel opens with the Seed point (X, Y, Z) where you clicked. If the face has sketch points, they light up and a Snap to list appears ("Pick a highlighted sketch point in the viewport, or use Snap to below"). Choose the Style (Simple, Counterbore with CB diameter and CB depth, or Countersink with CS diameter and CS angle), the Diameter, and the Depth (Blind with a Depth in mm, or Through all). Under Placement, Pattern repeats the hole: Linear adds Count and Spacing, Circular adds Count, Bolt radius and Start angle.',
      },
      { kind: 'image', slot: 'draft-preview' },
      {
        kind: 'paragraph',
        text: 'Draft beside existing fillets keeps their radii when the edit can be built. Shell can work on filleted parts too; opening a pocketed part can leave separate pieces rather than one connected body.',
      },
      {
        kind: 'paragraph',
        text: 'After Shell succeeds, the Console reports any information about the resulting pieces once, including when you edit an existing Shell.',
      },
      {
        kind: 'paragraph',
        text: 'On a curved STEP face, Hole uses the surface normal at the point you click as its drilling direction. The seed point still comes from that click.',
      },
    ],
    images: [
      {
        slot: 'draft-preview',
        file: 'draft-preview.webp',
        alt: 'The Draft card with the neutral face confirmed, one face picked to draft, and the drafted preview',
        captureNotes: 'Draft card in step 2: neutral face Confirmed, "1 draft face selected", Direction with Flip, Offset, the pull-direction line, Angle, and "Preview ready"; the drafted body previewed in the view.',
        status: 'done',
      },
    ],
    keywords: 'shell hollow thickness open faces draft angle neutral face confirm reselect flip offset pull direction mold hole seed point counterbore countersink blind through all pattern placement linear circular count spacing bolt radius start angle snap sketch point',
    contextKeys: ['modal:shell-dialog', 'modal:draft-dialog', 'modal:hole-dialog'],
    relatedTopicIds: ['fillet-chamfer-3d', 'defeature-resize-hole', 'model-imported-parts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'push-pull',
    title: 'Push/pull direct editing',
    category: 'modeling',
    summary: 'Push/Pull moves a flat face along its normal, or offsets a cylindrical or conical hole face on a STEP body, with a drag arrow or a typed distance. The result is a feature row you can edit later.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Push/Pull in the Modify group, then click a flat face, or a cylindrical or conical hole face on a STEP body.',
          'Drag the arrow, or type a distance in the small card next to the face (+ pulls, - pushes). Letting go of the drag does not commit - you can keep adjusting.',
          'Press Enter to preview a typed value, then Enter again or Apply to commit. Esc or Cancel stops.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The commit adds a Push/Pull row to the feature tree like any other feature, so it rebuilds with the model. To change it later, select the row and press Edit... - the arrow and the distance card come back on the same face with the distance you used.',
      },
      { kind: 'image', slot: 'pushpull-gizmo' },
      {
        kind: 'paragraph',
        text: 'Push/Pull and pocket-depth edits can carry neighboring fillet and chamfer chains with the face, keeping their size, including supported drafted walls and cone feet. On STL parts, a flat face meeting fillets can move with those fillets, and a counterbore floor can be picked for Push/Pull. An edit that cannot be built reports why and leaves the body unchanged.',
      },
      {
        kind: 'paragraph',
        text: 'On a STEP hole, a cylindrical face changes radius by the typed offset; a cone moves parallel to itself and keeps its angle. A positive offset enlarges the hole. On an STL, a flat face beside a curved rim can move while staying joined to that rim.',
      },
      {
        kind: 'paragraph',
        text: 'On an STL, Edit on the Push/Pull tree row brings back its stored distance. Apply replaces that edit; Undo and Redo step through the replacement, including when you press Undo quickly after Apply.',
      },
    ],
    images: [
      {
        slot: 'pushpull-gizmo',
        file: 'pushpull-gizmo.webp',
        alt: 'Push/Pull on the top face of a block: the arrow, the distance card with 8 mm typed, and the previewed taller body',
        captureNotes: 'A flat face picked for Push/Pull with the arrow visible, the Push/Pull card (Convention + pulls, - pushes, the typed value, Offset, Cancel, Apply), the previewed body, and the bottom bar\'s drag/type/Enter instructions.',
        status: 'done',
      },
    ],
    keywords: 'push pull direct edit face cylinder cone counterbore countersink arrow drag distance normal pulls pushes offset preview commit enter feature row edit',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['defeature-resize-hole', 'feature-tree-history', 'model-imported-parts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'defeature-resize-hole',
    title: 'Defeature, resize hole and hole depth',
    category: 'modeling',
    summary: 'Defeature deletes recognized features - holes, pockets, bosses, fillets, chamfers, engravings - and heals the body; Resize hole changes a recognized hole\'s diameter, or its depth, right in the view.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Defeature (Modify group) opens a small Delete faces card. Click faces in the view: a recognized hole, pocket, boss, fillet, chamfer or engraving is picked as one whole group, and faces to be deleted turn orange. The card counts what is picked, and "Recognized face groups" lists every group by kind and size (for example "Through hole - diameter 6 mm"); tick a group there or hover a row to light its faces. A healed preview builds as you pick ("Healed preview ready for 1 feature(s)."), and "Apply removal" deletes the groups as one feature row.',
      },
      {
        kind: 'steps',
        steps: [
          'Resize hole: click Resize hole in the Modify group. It finds the through, blind and counterbore holes on every body.',
          'Click a hole in the view, or press List to pick it from "Recognized holes". A small card appears at the hole with its Current diameter.',
          'Type the New diameter and press Enter or Apply - or click a different hole to move the card there.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Hole depth: while Resize hole is waiting for a hole, press Depth on its bar (Diameter switches back). The card then shows the Current depth ("(through)" for a through hole); type a New depth, or press Through, then Apply. The hole\'s floor moves and its diameter stays.',
      },
      { kind: 'image', slot: 'defeature-groups' },
      {
        kind: 'paragraph',
        text: 'Move Hole in the Modify group relocates a recognized hole on STEP or STL. Click the hole and type an XYZ delta in mm on the same face, then Apply. Every counterbore or countersink step moves together with its diameters and depths preserved. An overlap or wall breakthrough reports why the move cannot be built. Edit on the Move Hole tree row reopens it; Undo restores the old position.',
      },
      {
        kind: 'paragraph',
        text: 'On an STL, Defeature can remove a recognized round boss with its foot fillet, or a dome, leaving the plate face. Stepped-hole recognition includes connected cylindrical and conical bands, so moving a hole carries the whole stack.',
      },
      {
        kind: 'paragraph',
        text: 'A resized stepped hole keeps its remaining steps selectable for later edits and CAM face picks.',
      },
      {
        kind: 'paragraph',
        text: 'To change an imported-hole resize again, select its Resize hole row in the feature tree and choose Edit. The card reopens at the diameter you last applied; enter the next diameter and Apply to replace that edit. If an upstream change removed the hole, the console says why it cannot reopen.',
      },
    ],
    images: [
      {
        slot: 'defeature-groups',
        file: 'defeature-groups.webp',
        alt: 'The Delete faces card with the recognized holes listed, one ticked and shown orange, and the healed preview ready',
        captureNotes: 'Defeature card on an imported plate with six through holes: "Recognized face groups" open, one hole ticked ("1 of 6 selected - 1 hole"), that hole orange in the view, and "Healed preview ready for 1 feature(s)."',
        status: 'done',
      },
    ],
    keywords: 'defeature delete faces heal recognized hole pocket boss dome fillet chamfer engraving group orange resize hole move hole relocate xyz delta diameter depth through blind counterbore countersink list current new',
    contextKeys: ['modal:defeature-dialog', 'workspace:part'],
    relatedTopicIds: ['push-pull', 'shell-draft-hole', 'model-imported-parts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'booleans-3d',
    title: 'Model booleans',
    category: 'modeling',
    summary: 'Boolean combine joins two bodies with Union, Subtract or Intersect - click the body to keep, then the body to combine, right in the view.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Boolean in the Create group (it turns on once two bodies exist). The Boolean combine panel opens ready for clicks in the view.',
          'Click the target - the bar reads "TARGET: click the body to keep" - then the tool ("TOOL: click the body to combine"). The panel shows "Target: ... | Tool: ...".',
          'Choose the Op: Union, Subtract or Intersect (Subtract is the default), then Apply.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The result replaces both bodies, and the boolean is a row in the feature tree you can edit. "Restart viewport pick" starts the clicks over, and "Choose from lists" gives Target and Tool lists instead. Choosing the same body twice shows "Target and tool must be different bodies."',
      },
      {
        kind: 'paragraph',
        text: 'If Subtract would remove the whole target, it says that nothing would remain and leaves the model unchanged.',
      },
      {
        kind: 'paragraph',
        text: 'Import in the Document group can add an STL as another body. Boolean can use an STL and a STEP body, or two STLs, with either body as target or tool. Select the bodies in the view or from the lists; a mesh target also offers a Box or Cylinder tool sized in the panel. An STL used by a Boolean is hidden while that feature is active; Undo or rollback before it shows the STL again. An STL added through Model Import becomes a faceted solid that can later be exported as STEP.',
      },
      { kind: 'image', slot: 'boolean-result' },
    ],
    images: [
      {
        slot: 'boolean-result',
        file: 'boolean-result.webp',
        alt: 'The Boolean combine panel with target and tool picked in the view and Op set to Subtract',
        captureNotes: 'Boolean combine panel after two clicks in the view: "Viewport pick ready", "Target: Extrude F1 | Tool: Extrude F2", Choose from lists, Op Subtract; both bodies lit in the view.',
        status: 'done',
      },
    ],
    keywords: 'boolean combine union subtract intersect cut target tool keep body merge two bodies restart pick choose from lists stl box cylinder',
    contextKeys: ['modal:boolean-dialog'],
    relatedTopicIds: ['boolean-mesh-model', 'feature-tree-history', 'model-imported-parts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'feature-tree-history',
    title: 'The feature tree',
    category: 'modeling',
    summary: 'The Model section of the left panel is the part\'s history: every sketch, feature, plane and parameter is a row with a status mark, a right-click menu, and an Edit that reopens the tool it was made with.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Origin and the XY, XZ and YZ planes stay at the top; below them the rows rebuild in order. Changing a feature rebuilds only what depends on it. Each row shows its status: OK, Pending regeneration, Regenerating..., Failed, Degraded (something it uses failed or is gone), Suppressed, or Rolled back. The filter bar narrows the tree by name, or with :errors, :suppressed, or :type followed by a kind.',
      },
      {
        kind: 'steps',
        steps: [
          'Right-click a row and choose Edit... (or select it and press Edit... on the rail). The feature reopens in the same tool with its values loaded; Push/Pull and Resize hole bring back their card in the view.',
          'Delete... warns when other features use the row and names everything that goes with it. Suppress (the circle-slash button on the row, or the menu) skips a feature without deleting it. Sketch rows have an eye button to show or hide them.',
          'Drag rows to reorder; a move that cannot work is refused with the reason (for example, a feature cannot move above something it uses). Drag the Rollback marker, or use its up and down arrows, to rebuild the model only up to that point.',
          'New folder groups rows; drag rows into a folder or use Move to folder in the right-click menu, and drop them on "Root (drop here to ungroup)" to take them out.',
        ],
      },
      {
        kind: 'tip',
        text: 'Ctrl+Z undoes and Ctrl+Y (or Ctrl+Shift+Z) redoes in the Model tab - the Undo and Redo buttons in the Document group do the same.',
      },
      { kind: 'image', slot: 'tree-badges' },
    ],
    images: [
      {
        slot: 'tree-badges',
        file: 'tree-badges.webp',
        alt: 'The feature tree with its filter bar, sketch, extrude and parameter rows, and the Rollback marker',
        captureNotes: 'Model section crop: the filter bar, Root and New folder, Origin and the three planes, two sketches, two extrudes and two parameters, each row with its suppress button and status mark, and the Rollback marker at the bottom.',
        status: 'done',
      },
    ],
    keywords: 'feature tree history rebuild regenerate status badge ok pending failed degraded suppressed rolled back rollback marker reorder drag edit right click menu delete suppress folder move to folder filter errors type',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['model-workspace-tour', 'push-pull', 'model-to-cam'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'model-parameters',
    title: 'Named parameters',
    category: 'modeling',
    summary: 'The Parameters table holds named values with expressions, and features driven by a name rebuild when the value changes.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Parameters section of the left panel lists each parameter with its name, its expression (changes take effect on Enter or when you click away), the value it works out to, and a Delete button. The bottom row adds one: type a name and an expression such as 2*base+5 or 10mm and press Add. Each parameter is also a row in the feature tree. Deleting a parameter a feature still uses is refused and names that feature.',
      },
      {
        kind: 'paragraph',
        text: 'To drive a feature with a parameter, type an expression in the fx field of the Extrude panel (Distance) or the Revolve panel (Angle). While an expression is in the field the number box is greyed out, and changing the parameter rebuilds every feature that uses it. Sketch dimensions take the same arithmetic and unit suffixes in their equation field, but not parameter names.',
      },
      { kind: 'image', slot: 'params-table' },
    ],
    images: [
      {
        slot: 'params-table',
        file: 'params-table.webp',
        alt: 'The Parameters table with two named parameters and the add row',
        captureNotes: 'Parameters section crop with two rows (base = 20, height = 2*base+5 showing 45) and the add row with its name and expression boxes and Add.',
        status: 'done',
      },
    ],
    keywords: 'parameters named value expression fx drive dimension table add delete regenerate rebuild variable equation',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['extrude', 'sketch-dimensions'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'appearance-visibility',
    title: 'Appearance, visibility, isolate, section',
    category: 'modeling',
    summary: 'Colour bodies or single faces from the Inspect section, hide bodies from the Bodies list, isolate what you picked, and cut the view with a section plane.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Appearance in the Inspect section colours things: choose Face or Body, click the face or body in the view, then click the colour swatch to pick a colour. Clear removes it. Each row in the Bodies list also has its own colour swatch for the whole body.',
      },
      {
        kind: 'steps',
        steps: [
          'Hide or show a whole body with the checkbox on its Bodies row (Undo takes it back). Sketch rows in the feature tree have their own eye button.',
          'With faces picked in Measure or Appearance, press "Hide face" (or "Hide faces") to hide just those faces.',
          'Press "Isolate selection" to show only what is picked; "Exit isolate" or "Show all" brings everything back.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Section cuts the view with a plane: tick Section, choose X, Y or Z, and move the slider to move the cut. Flip shows the other side, "Drag plane" lets you drag the cut in the view, and Clear resets it.',
      },
      { kind: 'image', slot: 'appearance-panel' },
    ],
    images: [
      {
        slot: 'appearance-panel',
        file: 'appearance-panel.webp',
        alt: 'The Model tab with Appearance on in Face mode and one face of the block coloured orange',
        captureNotes: 'Full Model tab with Bodies and Parameters folded: Appearance on in the Inspect section (Face mode, the orange swatch and Clear for the picked face) and the coloured top face of the block in the view.',
        status: 'done',
      },
    ],
    keywords: 'appearance color colour face body swatch picker clear visibility hide show isolate exit show all checkbox eye section plane cut slider flip drag plane',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['measure-mass', 'model-stl-export'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'measure-mass',
    title: 'Measure and mass properties',
    category: 'modeling',
    summary: 'The Inspect section measures faces, edges, vertices and bodies - one pick, or the distance and angle between two - and gives a body\'s mass for a chosen material.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Measure in the Inspect section and choose what to pick with the Face, Edge, Vertex and Body buttons.',
          'Single reads one pick: a body gives Volume, a face gives Area (plus Radius and Diameter on a round face), an edge gives Length, a vertex gives its position.',
          'Between two reads a pair: the Distance between any two picks, and the Angle between two flat faces or two straight edges. Clear starts over.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Numbers come from the exact part where possible; a number worked out from the displayed mesh is marked (approx). Below the section tools, choose a body in Mass body and a material (Aluminum 6061, Steel 1018 (mild), Stainless Steel 304, Brass (C360), Copper (C110), Titanium (Grade 5), ABS, PLA, Nylon (PA6), or Custom... with your own density in g/cm^3) to read its Mass in grams, Volume in mm^3, and centre of mass (CoM).',
      },
      { kind: 'image', slot: 'measure-readout' },
    ],
    images: [
      {
        slot: 'measure-readout',
        file: 'measure-readout.webp',
        alt: 'The Inspect section measuring 10 mm between two faces, with the mass of the chosen body below',
        captureNotes: 'Inspect section crop: Measure on, Between two, Distance 10.000 mm (approx) and Angle 0 between two parallel faces, and below it Mass body, the material, Mass, Volume and CoM.',
        status: 'done',
      },
    ],
    keywords: 'measure distance angle length area volume radius diameter vertex between two single clear mass properties density material center centre of mass grams approx',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['appearance-visibility', 'model-workspace-tour'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'model-stl-export',
    title: 'Exporting STEP and STL',
    category: 'modeling',
    summary: 'The Document group of the rail saves the shown bodies as a STEP or STL file in one click - no dialog.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Export (STEP) or STL in the Document group of the rail. Both turn on once a body exists.',
          'The file is named after the project (for example My part.step or My part.stl; an unnamed project gives Untitled project.step). In a browser it downloads; in the desktop app you choose where to save it. STL is made fresh from the exact part.',
          'If the export cannot be made, the reason shows in red on the status bar at the bottom.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Every body that is not hidden is exported - the Bodies checkbox and the tree decide. Isolate and hidden faces do not change what is exported. With every body hidden there is nothing to export, and the status bar says so.',
      },
      { kind: 'image', slot: 'export-buttons' },
    ],
    images: [
      {
        slot: 'export-buttons',
        file: 'export-buttons.webp',
        alt: 'The Document group of the rail with the Export button\'s "Export STEP" tooltip showing',
        captureNotes: 'Right rail Document group crop (Undo, Redo, Import, Export, STL, Debug export) with the pointer on Export and its "Export STEP" tooltip showing.',
        status: 'done',
      },
    ],
    keywords: 'export step stl download save file document rail one click visible bodies hidden isolate import',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['appearance-visibility', 'import-step', 'model-to-cam'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'model-imported-parts',
    title: 'Editing imported STEP and STL parts',
    category: 'modeling',
    summary: 'An imported STEP or STL part opens in the Model tab as a body you can edit directly - push faces, change fillets and holes, remove features, add holes and chamfers - without redrawing it.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Import in the Model rail accepts STEP and STL files. A closed STL imported here becomes a faceted solid for further modeling and STEP export; curved surfaces keep their facets. This lets you combine imported bodies in one model.',
      },
      {
        kind: 'paragraph',
        text: 'A STEP part gets here two ways: Import in the Document group brings a STEP file into the model as a body named after the file, or the pen button (Edit as model) on an imported STEP row in Setup opens it in the Model tab. It is then a body like any other: Push/Pull, Fillet, Chamfer, Shell, Draft, Hole, Resize hole (diameter or depth) and Defeature all work on it, and Fillet also changes the radius of a fillet already on the part.',
      },
      {
        kind: 'paragraph',
        text: 'An STL opened with the pen button (Edit as model) on its row in Setup can remain a mesh body and stay an STL; the message line says how many features it recognised ("Click a feature to select it whole"). A click picks a whole feature - a hole, a rounded edge, a flat face - never a single triangle.',
      },
      {
        kind: 'table',
        columns: ['Tool', 'On an STL'],
        rows: [
          { cells: ['Push/Pull', 'Moves a flat face - the same card as on any body.'] },
          { cells: ['Fillet', 'Changes the radius of a rounded edge.'] },
          { cells: ['Chamfer', 'Adds a chamfer on the sharp edges you click.'] },
          { cells: ['Shell', 'Hollows the part and opens the flat faces you click.'] },
          { cells: ['Draft', 'Tilts the flat faces you click about a neutral face.'] },
          { cells: ['Hole', 'Drills a hole square to the face you click, with the usual Hole panel.'] },
          { cells: ['Resize hole', 'Changes a recognized hole\'s diameter, or its depth with Depth.'] },
          { cells: ['Defeature', 'Removes recognized features and heals the part.'] },
          { cells: ['Boolean', 'Combines with another STL or STEP body in either direction, or with a Box or Cylinder sized in the panel.'] },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Move Hole relocates a complete recognized hole stack on STEP or STL. From body in Form also accepts the open STL; the source mesh is hidden while its Form feature is active. Relief is not available on a mesh body yet; hover its disabled button to read why.',
      },
      {
        kind: 'paragraph',
        text: 'Each Apply is one step for Undo. Finish (top of the left panel) goes back to Setup with the edited part.',
      },
      {
        kind: 'paragraph',
        text: 'Import in the Model rail brings every solid of a multi-solid STEP into the model as its own body and reports the body count in the console. Cancel while the import is counting solids drops the import.',
      },
    ],
    images: [],
    keywords: 'imported step stl direct edit edit as model mesh recognised features push pull fillet radius chamfer shell draft hole resize depth defeature boolean box cylinder undo finish',
    contextKeys: ['workspace:part'],
    relatedTopicIds: ['edit-import-as-model', 'defeature-resize-hole', 'fillet-chamfer-3d', 'booleans-3d'],
    sinceVersion: '0.35.0',
  },
  {
    id: 'model-placement',
    title: 'Moving modeled bodies',
    category: 'modeling',
    summary: 'A model is placed in Setup with the Position and Rotation fields in the Properties panel - or the move gizmo in the view - and stock and operations follow the moment it moves.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Select a MODEL row in Setup\'s Geometry list and the Properties panel shows the model with a Position (mm) group (X, Y, Z) and a Rotation (deg) group. Typing here and dragging the move gizmo in the view are the same edit, and every body of the same model moves together. One finished move is one undo step.',
      },
      {
        kind: 'paragraph',
        text: 'When a body moves, auto stock around it resizes at once. Operations that cut the body turn Outdated with the note "The modeled part this operation cuts changed - recompute before posting."; their last toolpath stays on screen until you compute again.',
      },
      { kind: 'image', slot: 'placement-fields' },
    ],
    images: [
      {
        slot: 'placement-fields',
        file: 'placement-fields.webp',
        alt: 'Setup with a MODEL row selected: the Properties panel shows Position and Rotation, and the move gizmo sits on the body',
        captureNotes: 'Full Setup tab with a MODEL row selected: Properties panel with the model (Bodies, Edit, Rename, Delete), Position (mm) X/Y/Z and Rotation (deg), and the bodies with the move gizmo and the auto stock box in the view.',
        status: 'done',
      },
    ],
    keywords: 'move placement position rotation x y z gizmo model item body outdated recompute stock re-wrap translate',
    contextKeys: ['panel:properties:geometry', 'workspace:cam'],
    relatedTopicIds: ['model-to-cam', 'stocks-auto-fixed', 'setup-wcs'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'model-relief',
    title: 'Relief (a picture raised or cut into a face)',
    category: 'modeling',
    summary: 'Relief turns a picture into heights on a flat face of the part - Raise, Emboss or Engrave - with a live 3D preview and a height map, and Apply makes it one row in the design tree.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'In the Model tab, click Relief in the Create group of the rail (it needs a body). The rail shows the Relief tools and the Relief palette docks beside it.',
          'Click a flat face on the part to lay the picture on (a face you selected before clicking Relief is used straight away).',
          'Open image: a PNG or JPG, 8- or 16-bit. Light is high. Auto adjusts the picture and fits it inside the face, centred, and the part shows the relief live.',
          'Set the Depth and pick Raise, Emboss or Engrave, then Apply Relief. The relief is one row in the design tree; Edit on it reopens the palette with the picture and every value.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Relief is not available on an STL mesh body yet. Hover its disabled button for the reason; a flat face on a modelled solid can use Relief.',
      },
      { kind: 'image', slot: 'relief-palette' },
      { kind: 'heading', text: 'Height: Raise, Emboss, Engrave', anchor: 'height' },
      {
        kind: 'paragraph',
        text: 'Raise makes the subject stand proud of the face by the Depth. Emboss keeps the subject at the face and cuts everything round it down to the depth. Engrave cuts the subject into the face and leaves everything round it at the face. Invert makes dark high instead of light, for a picture whose subject reads the wrong way round. Zero plane sits everything darker than that share of the picture flat on the face; Base puts a plinth under the whole picture. Step-downs turn the heights into flat floors (Steps: Levels, or Fixed step with a Step in mm) with Walls at the angle you set.',
      },
      { kind: 'heading', text: 'The height map and the picture adjustments', anchor: 'height-map' },
      {
        kind: 'paragraph',
        text: 'The Height map at the top of the palette shows the picture as the relief will be cut: Before (the picture), After (adjusted), Split, Height (light is high) or Shaded, with the section A-A below it (the dashed line is the face). Click its name to fold it. Adjust holds the picture adjustments Auto set - Greyscale, Levels with its histogram, contrast, brightness, denoise, smooth and edge-keep smooth. Moving one switches Auto off; one click on Auto puts its values back.',
      },
      {
        kind: 'paragraph',
        text: 'Place sets the Size on the face (keep proportions ticked by default), Rotate and Move; Fit to face on the rail puts it back inside the face. A very large relief is built as a mesh, and its row says (mesh relief).',
      },
    ],
    images: [
      {
        slot: 'relief-palette',
        file: 'relief-palette.webp',
        alt: 'Relief on the top face of a plate: the terrain picture raised in the view, the Relief palette docked beside the rail with its height map',
        captureNotes: 'Model screen, an 80 x 60 x 12 mm plate, Relief open on its top face with fixture-02-terrain-heightmap.png: the live preview in the view, the Relief tools on the rail, the palette docked with the Height map open.',
        status: 'done',
      },
    ],
    keywords: 'relief image picture photo heightmap height map emboss engrave raise cut in depth zero plane base invert auto levels histogram contrast brightness denoise smooth edge keep step downs steps walls size rotate move fit to face apply section before after split shaded mesh relief png jpg 16 bit',
    contextKeys: ['interaction:relief', 'workspace:part'],
    relatedTopicIds: ['model-workspace-tour', 'feature-tree-history'],
    sinceVersion: '0.35.0',
  },
])
