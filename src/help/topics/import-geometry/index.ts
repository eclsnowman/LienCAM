import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'import-dxf-svg',
    title: 'Importing DXF and SVG',
    category: 'import-geometry',
    summary: 'DXF and SVG files import as 2D layers of loops you can machine, edit in Sketch, clean up, or turn into a model.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'In the design tree, click the + button on the Geometry header (its tooltip begins "Import geometry") and choose a .dxf or .svg file. The same button opens STL, OBJ, STEP and IGES files.',
          'The drawing appears as one row in the Geometry list with its layers under it. A DXF keeps the layer names and colors from the file. Layers whose names mark drawing-sheet extras (border, title block, notes, dims, center lines and similar) start hidden - click their eye button to show them. An SVG is split into layers by its own layers, or by color when it has none ("Layer 1", "Layer 2" ...).',
          'The console at the bottom says what was imported. For a DXF it also says what it fixed or left out: gaps it closed, chains it left open, entity types it did not import, and the unit it converted from when the file is not in millimeters.',
          'A DXF lands centered on the origin. To keep the drawing\'s own origin instead, turn on Keep drawing origin under DXF import in Settings.',
          'If the project has a stock other than the automatic one, a dialog asks which stock the new part joins: one of your stocks, Auto (default), or None.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Each layer row has buttons to hide, lock, rename, Edit in Sketch, Convert to model, Fit arcs & merge lines, and delete the layer. Click the arrow on a layer to list its loops. Operations pick from these loops on their Geometry tab.',
      },
      {
        kind: 'tip',
        text: 'Edit in Sketch opens the layer in the sketcher. The imported drawing arrives as one fixed block, so a stray click cannot bend it - select the block and explode it when you want to change single lines. After you finish an edited sketch, the drawing\'s row shows an "edited" badge.',
      },
      {
        kind: 'paragraph',
        text: 'You can also bring a DXF or SVG straight into the sketch you are working in: in the sketcher\'s Create section, click Import... to open the Import window, then choose a DXF / SVG / PNG / JPG file. The Picture width and Picture threshold choices in that window apply to PNG / JPG tracing and are remembered while the sketch stays open. Export / Print... opens the separate Export window for paper, orientation, scale, Export SVG... and Print... .',
      },
      {
        kind: 'paragraph',
        text: 'DXF block inserts import as ordinary geometry in both CAM and Import into sketch. Each placed copy keeps its position, scale, mirror and rotation, including nested inserts and arrays. Entities on layer 0 use the placed block\'s layer. Paper-space sheet and title-block inserts are left out.',
      },
      { kind: 'image', slot: 'import-result' },
    ],
    images: [
      {
        slot: 'import-result',
        file: 'import-result.webp',
        alt: 'An imported DXF in the design tree with its three layers, and its loops in the viewport from the top',
        captureNotes: 'Import a multi-layer DXF (Leadscrew_Stepper_Mount). Show the design tree Geometry section with the DXF row and its layers (with their buttons and loop counts), the loops in the viewport from the top, and the import line in the console.',
        status: 'done',
      },
    ],
    keywords: 'import dxf svg insert nested array mirrored blocks 2d drawing vector layers loops contour hole open chain gaps closed units inches keep drawing origin annotation hidden layer stock prompt edit in sketch block explode import into sketch picture trace png jpg',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['import-stl', 'geometry-cleanup', 'provenance-badges', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'import-stl',
    title: 'Importing STL and OBJ meshes',
    category: 'import-geometry',
    summary: 'An STL or OBJ mesh shows in 3D. Slice an STL into 2D loops in two steps: pick the slice height, then pick where the loops land.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Import a mesh with the + (Import geometry) button on the Geometry header. An STL or OBJ appears in the viewport seated on the floor. An OBJ is read the same way as an STL; its row offers color, rename, lock, duplicate and remove.',
      },
      {
        kind: 'paragraph',
        text: 'An STL row also has Edit as model, Hide model, and Slice to 2D loops (the layers icon). A mesh has no curves an operation can follow directly, so most 2D operations need loops sliced from it.',
      },
      {
        kind: 'steps',
        steps: [
          'Click Slice to 2D loops on the STL row.',
          'Step 1 (Slice Plane): drag the orange handle, or type a Z, to the height where the outline is taken. The panel shows the valid range. Click Confirm or press Enter; Esc cancels.',
          'Step 2 (Select Target Plane): choose where the loops land - Stock top, Stock bottom, Floor (Z = 0), or click a highlighted face on the part.',
          'The loops land on a new layer named "STL Projection 1", "STL Projection 2", and so on. The row shows how many 2D loops it has (for example "2D:6").',
        ],
      },
      {
        kind: 'tip',
        text: 'How closely the traced loops follow the mesh is set under STL Projection in Settings: a Quality preset (Draft, Standard, Fine) or your own STL projection tolerance. Projection layers cannot be opened in Sketch, but Fit arcs & merge lines works on them.',
      },
      {
        kind: 'paragraph',
        text: '2D Contour and 2D Pocket can also use an STL directly: pick the STL as the source geometry and the operation finds the part\'s edge chains itself.',
      },
      {
        kind: 'warning',
        text: 'If you move or rotate the STL after slicing, the slice button is highlighted and its tooltip reads "Rotation changed — re-slice to 2D loops". The old loops stay where they were taken.',
      },
      { kind: 'image', slot: 'projection-picker' },
    ],
    images: [
      {
        slot: 'projection-picker',
        file: 'projection-picker.webp',
        alt: 'Slice to 2D loops on an STL: the Slice Plane panel with the plane partway up the part, and the Select Target Plane panel',
        captureNotes: 'Start Slice to 2D loops on an STL plate. Left: step 1 with the slice plane on the part and the Slice Plane panel (Z typed, range, Confirm/Cancel). Right: step 2 with the Select Target Plane panel (Stock top, Stock bottom, Floor).',
        status: 'done',
      },
    ],
    keywords: 'import stl obj mesh 3d slice project projection 2d loops tolerance quality preset draft standard fine target plane stock top floor re-slice rotation moved edge chains contour pocket',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['import-dxf-svg', 'section-at-z', 'edit-import-as-model', 'geometry-cleanup'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'import-step',
    title: 'Importing STEP and IGES solids',
    category: 'import-geometry',
    summary: 'STEP and IGES files import as true solids that keep their exact shape for face picks, sections, and editing as a model.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Import a .step or .stp file with the + (Import geometry) button on the Geometry header. While it loads, the Geometry section shows "Importing <file name> ..." with the current stage. The part lands seated on the floor and centered over the origin. It takes the part name stored in the file when there is one (otherwise the file name) - double-click the name to rename it.',
      },
      {
        kind: 'paragraph',
        text: 'An IGES file (.igs or .iges) imports through the same button and lands as the same kind of solid row. The file dialog lists both extensions alongside STEP, STL, OBJ, DXF and SVG. The console says what the IGES file held, for example "IGES -- 1 solid"; a file with only surfaces still imports and says so.',
      },
      {
        kind: 'paragraph',
        text: 'Unlike a mesh, the part keeps its exact solid shape. That is what lets you pick faces and edges in the operation editor, take exact sections at any height, and edit the import as a model. How smooth curved surfaces look on screen is set by Model render fidelity under Performance in Settings (Performance, Balanced, High); it does not change the real shape.',
      },
      {
        kind: 'paragraph',
        text: 'The row has buttons for color, rename, lock, Edit as model, Hide model, Slice to 2D loops, duplicate and remove. If an import fails, a red message in the Geometry section names the file and the reason; click it to dismiss it.',
      },
      {
        kind: 'paragraph',
        text: 'Turning the part over keeps its operations. When you rotate a STEP part about X or Y, LienCAM re-derives the faces, holes and sections you took from it once, when the rotation is set (at the end of the gizmo drag, or when you enter the value), never while you drag. Turned upside down, each face, hole and section lands where it now is - a drill finds each hole at its new place and depth - and a face or hole you take on the turned part lands the same way.',
      },
      {
        kind: 'paragraph',
        text: 'Tilted part way, those faces and holes no longer face straight up, so they cannot be cut from above: the operations that use them turn red and the message names the tilt, for example "turned 30 deg off upright (rotation X=30 deg, Y=0 deg)". Turn the part back upright or upside down and they compute again.',
      },
      {
        kind: 'tip',
        text: 'LienCAM keeps a copy of the imported file in this browser, so the part comes back after a reload without importing it again. If a file holds more than one body, a dialog asks how they should land - see Multi-body STEP files.',
      },
      { kind: 'image', slot: 'step-part' },
    ],
    images: [
      {
        slot: 'step-part',
        file: 'step-part.webp',
        alt: 'An imported STEP part shaded in the viewport with its row selected in the design tree',
        captureNotes: 'Import a STEP part with pockets and holes, select its row in the design tree, and capture the part in the viewport with the tree row (name, STEP tag and its buttons) visible.',
        status: 'done',
      },
    ],
    keywords: 'import step stp iges igs solid brep b-rep exact geometry render fidelity performance balanced high embedded part name rename seated floor progress failed surfaces reload cache rotate rotation turn over upside down flip tilt tilted re-derive',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['multi-body-step', 'face-edge-selection', 'section-at-z', 'edit-import-as-model'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'multi-body-step',
    title: 'Multi-body STEP files',
    category: 'import-geometry',
    summary: 'When a STEP file holds more than one body, you choose whether it lands as one row or as one row per body.',
    sections: [
      {
        kind: 'paragraph',
        text: 'When a STEP file holds several separate bodies, a dialog titled "This file has N separate bodies" asks how they should appear in the Geometry list. Files with one body never show it.',
      },
      {
        kind: 'steps',
        steps: [
          'Keep as one item (default): all bodies stay together as one row that selects, hides and moves as one.',
          'One item per body: each body becomes its own model row, named after the file ("two-boxes", "two-boxes (2)" ...). You stay on the screen you were on.',
          'Escape, Enter, the X button, or a click outside the dialog keeps the highlighted choice.',
        ],
      },
      {
        kind: 'tip',
        text: 'While the file is still one row, right-click it and choose Choose body split... to bring the dialog back, with your earlier choice highlighted.',
      },
      { kind: 'image', slot: 'choice-modal' },
    ],
    images: [
      {
        slot: 'choice-modal',
        file: 'choice-modal.webp',
        alt: 'The multi-body import dialog offering Keep as one item or One item per body',
        captureNotes: 'Import a STEP file with two solids and capture the dialog: the title with the body count, both choices, Keep as one item marked (default).',
        status: 'done',
      },
    ],
    keywords: 'multi-body step multiple bodies solids combined one item per body split choose body split import choice assembly',
    contextKeys: ['modal:multi-body-import'],
    relatedTopicIds: ['import-step', 'edit-import-as-model', 'stock-membership'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'face-edge-selection',
    title: 'Picking faces and edges on a solid',
    category: 'import-geometry',
    summary: 'The operation editor can take its cutting geometry straight from an imported solid: pick faces, pick edges, or detect holes.',
    sections: [
      {
        kind: 'paragraph',
        text: 'When an operation\'s source geometry is an imported STEP or IGES part, the Geometry tab shows a "From 3D model" group. Which buttons appear depends on the operation: Pick face (2D Pocket, 2D Adaptive Clearing, 2D Face, 2D Contour, Drill, Bore, Thread Mill), Pick edges (2D Contour, Engrave / Trace, V-Carve, 2D Chamfer, Thread Mill), Detect holes (Drill), and Section at Z (the Pick face operations except Drill - see Slicing a solid at a height). Each one puts the loops on a new layer of the part and selects them for the operation.',
      },
      {
        kind: 'steps',
        steps: [
          'Pick face: click faces on the part in the viewport. Each click selects or deselects a face, and the banner at the bottom counts them and says what a click does in this operation. Click Done to use them, or Cancel.',
          'A flat face gives its outline as loops, and the deepest picked face sets the bottom of cut. A round wall is used by what it is: Drill and Bore take the hole to its depth, Thread Mill reads the thread\'s kind, size and depth, 2D Contour profiles it down to its base, and 2D Pocket avoids a boss as an island or uses a bore as the boundary.',
          'Pick edges: click edges on the part, then Done. The picked edges are chained into the contour.',
          'Detect holes (Drill): the part is searched for holes and each one is added to the loop list with its diameter and selected.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A body built in the Model workspace offers Pick edges for the profile operations and a typed Section at Z; Drill gets Detect holes.',
      },
      {
        kind: 'warning',
        text: 'Pick face on model on the Heights tab (a datum plane) needs a flat face on an imported solid. A curved face is refused with "That surface is curved - pick a FLAT (planar) face as the datum." and you can pick again.',
      },
      { kind: 'image', slot: 'face-pick' },
    ],
    images: [
      {
        slot: 'face-pick',
        file: 'face-pick.webp',
        alt: 'Pick face on a STEP part for a 2D Pocket: the picked pocket floor highlighted and the pick banner with Done and Cancel',
        captureNotes: 'Open a 2D Pocket with a STEP source, press Pick face, and click the pocket floor. Capture the viewport with the picked face highlighted and the pick banner (its text, face count, Done, Cancel).',
        status: 'done',
      },
    ],
    keywords: 'pick face pick edges detect holes from 3d model solid step iges brep loops boundary bottom of cut cylinder wall bore boss island drill thread done banner datum flat planar curved refused',
    contextKeys: ['workspace:cam', 'modal:new-operation'],
    relatedTopicIds: ['import-step', 'section-at-z', 'height-references', 'operation-sources', 'drill'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'section-at-z',
    title: 'Slicing a solid at a height',
    category: 'import-geometry',
    summary: 'An imported solid can be cut at any height to give exact 2D loops, from the design tree or from the operation editor.',
    sections: [
      {
        kind: 'paragraph',
        text: 'A section is an exact cross-section of the solid at one height - not a trace of a mesh - so the loops are as accurate as the file. There are two places to take one.',
      },
      {
        kind: 'steps',
        steps: [
          'From the design tree: click Slice to 2D loops (the layers icon) on the STEP row. Step 1 - drag the orange handle or type the height; the section outline previews on the part as you go. Click Confirm. Step 2 - choose where the loops land (Stock top, Stock bottom, Floor, or a clicked face). The loops land on a new layer named "Section 1", "Section 2", and so on.',
          'From the operation editor: on the Geometry tab, type a height in the box next to Section at Z and click Section at Z. The hint beside it shows the Z range and says "Exact solid cross-section at this height". Set in viewport lets you drag the height with the same live preview. The loops land on a layer named after the height (for example "Section z=-7") and are selected for the operation.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'For a body built in the Model workspace, the operation editor offers the typed Section at Z only, and the hint says the section is mesh-derived. Set in viewport refuses a part rotated off the Z axis and names its X and Y rotation.',
      },
      {
        kind: 'paragraph',
        text: 'A section taken from a modeled body shows a "stale" badge after the model changes. When an operation that uses it computes, LienCAM takes the section again at the same height from the current model.',
      },
      { kind: 'image', slot: 'scrub-preview' },
    ],
    images: [
      {
        slot: 'scrub-preview',
        file: 'scrub-preview.webp',
        alt: 'Slice to 2D loops on a STEP part: the slice plane partway down the part with the Slice Plane panel',
        captureNotes: 'Start Slice to 2D loops on a STEP part with pockets and holes. Capture the slice plane at mid height with the live section outline on the part and the Slice Plane panel (Z, range, Confirm/Cancel).',
        status: 'done',
      },
    ],
    keywords: 'section slice z height cross-section exact solid step scrub set in viewport live preview loops layer section 1 z range model coords stale modeled body refresh rotated',
    contextKeys: ['interaction:brep-section'],
    relatedTopicIds: ['import-step', 'import-stl', 'face-edge-selection', 'provenance-badges'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'geometry-cleanup',
    title: 'Fit arcs and merge lines',
    category: 'import-geometry',
    summary: 'Rebuild an imported layer with true arcs and merged lines, compare before and after, then keep it or cancel.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Imported curves often arrive as many short line segments where the original drawing had arcs. The wand button (Fit arcs & merge lines) on an imported 2D layer - DXF, SVG, STL projections, sections and picked-face loops - rebuilds its loops with arcs and merged straight lines. It works on open chains as well as closed loops. Sketch layers are edited in Sketch instead and have no wand button.',
      },
      {
        kind: 'steps',
        steps: [
          'Click the wand button on the layer row in the design tree.',
          'The Optimization Preview dialog opens with After selected. On STL projection and section layers the viewport draws the proposal with node markers - blue for Before, orange for After.',
          'Click Before or After to switch between the two and compare the node points.',
          'Click Apply to keep the result, or Cancel to keep the layer as it was.',
        ],
      },
      { kind: 'image', slot: 'compare-view' },
    ],
    images: [
      {
        slot: 'compare-view',
        file: 'compare-view.webp',
        alt: 'Fit arcs and merge lines on an STL projection layer: the Optimization Preview dialog on After and the orange node markers in the viewport',
        captureNotes: 'Slice an STL to a projection layer, then click its wand button. Capture the tree with the wand tooltip, the viewport with the orange After loops and node markers, and the Optimization Preview dialog (legend, Before/After, Apply/Cancel).',
        status: 'done',
      },
    ],
    keywords: 'fit arcs merge lines optimize optimization preview cleanup segments polyline simplify nodes before after compare apply cancel wand',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['import-dxf-svg', 'import-stl', 'section-at-z'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'edit-import-as-model',
    title: 'Editing an import as a model',
    category: 'import-geometry',
    summary: 'Open an imported STEP part or STL in the Model workspace to change it, even though you did not draw it here.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Click Edit as model (the pen button) on an imported STEP or STL row in the design tree, or right-click the row and choose Edit as model. The Model workspace opens on the part, where the Modify tools (Push/Pull, Fillet, Chamfer, Shell, Draft, Hole, Resize hole, Defeature) work on it.',
      },
      {
        kind: 'steps',
        steps: [
          'A STEP part becomes the base of a new model. The same Geometry row turns into a model row (tagged MODEL) once the model builds, and follows your edits. Its pen button then reads Edit model. A multi-body STEP gives each body its own row.',
          'A flat-sided STL (a plate, block or bracket) is turned into a real solid the same way.',
          'An STL with round holes, bosses or fillets opens in the Model workspace as a mesh and stays an STL. The console says how many features it recognised; click a feature to select it whole.',
          'When it cannot open the part, you get a named message: a mesh that is open or broken, a copy placed by a nest (see Nesting; edit its source part instead), or a part whose stored file is missing (import it again).',
        ],
      },
      {
        kind: 'tip',
        text: 'Edit as model starts from a 3D import. To start from a 2D layer, use Convert to model on the layer instead.',
      },
      { kind: 'image', slot: 'edit-as-model' },
    ],
    images: [
      {
        slot: 'edit-as-model',
        file: 'edit-as-model.webp',
        alt: 'The Edit as model button on a STEP row, and the same part open in the Model workspace',
        captureNotes: 'Two crops: (1) a STEP row in the design tree with the Edit as model button and its tooltip; (2) the same part open in the Model workspace with the import in the feature tree and the Modify tools.',
        status: 'done',
      },
    ],
    keywords: 'edit as model edit model import step stl convert solid flat sided prismatic mesh features recognised model workspace push pull fillet hole defeature refused nest seed missing',
    contextKeys: ['workspace:cam', 'workspace:part'],
    relatedTopicIds: ['import-step', 'convert-to-model', 'model-to-cam', 'multi-body-step'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'convert-to-model',
    title: 'Converting a sketch layer to a model',
    category: 'import-geometry',
    summary: 'A 2D layer can move into a new model as its base sketch; operations that used it are marked outdated until you pick again.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The box button (Convert to model) sits on DXF, SVG and sketch layer rows that are not locked; right-click a layer for Convert to model... as well. It moves the layer into a new model as its base sketch and opens the Model workspace, where you can extrude it and add features. This is a move, not a copy: the layer leaves its Geometry row, and the new model takes the layer\'s name.',
      },
      {
        kind: 'steps',
        steps: [
          'Click Convert to model on the layer row.',
          'The "Convert sketch to model?" dialog opens. If operations use the layer, it names them.',
          'Click Convert to model. The Model workspace opens on the new model.',
          'Operations that used the layer are marked outdated. Pick their geometry again on the model, then regenerate.',
        ],
      },
      { kind: 'image', slot: 'convert-warning' },
    ],
    images: [
      {
        slot: 'convert-warning',
        file: 'convert-warning.webp',
        alt: 'The Convert sketch to model dialog naming the operation that uses the layer',
        captureNotes: 'Make a 2D Contour that uses a DXF layer, click Convert to model on that layer, and capture the dialog with the operation named in its text.',
        status: 'done',
      },
    ],
    keywords: 'convert sketch layer to model promote base sketch move dxf svg dependent operations outdated reselect extrude',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['edit-import-as-model', 'model-to-cam', 'generation-failures'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'boolean-mesh-model',
    title: 'Boolean an imported mesh with a model body',
    category: 'import-geometry',
    summary: 'Subtract, union, or intersect an imported STL with a body built in the Model workspace to get a new row, marked exact or approx.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Once the project has a body built in the Model workspace, an imported STL row gets a Boolean with model body button (right-click also offers Boolean with model body...). It opens the "Boolean: mesh vs model body" panel at the top right. The viewport stays clickable, so you can pick both parts by clicking them.',
      },
      {
        kind: 'steps',
        steps: [
          'Mesh operand and Model body: the panel fills in what it can. To change one, click its Pick in viewport button (it reads "Click a mesh..." or "Click a body..." while it waits) and click the part. Choose from lists offers the same choice as drop-downs.',
          'Operation: Subtract, Union, or Intersect.',
          'The panel says whether the result will be EXACT (the body has only flat faces) or APPROXIMATE (curved surfaces use the body\'s display mesh).',
          'Click Run boolean. The result lands as a new row named after the mesh and the operation, for example "plate (subtract)". The original parts are not changed.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The result row carries an "exact" or "approx" badge. It is a snapshot: if either part changes, click Edit boolean (re-run) on the result row to run it again with the same inputs filled in.',
      },
      { kind: 'image', slot: 'boolean-dialog' },
    ],
    images: [
      {
        slot: 'boolean-dialog',
        file: 'boolean-dialog.webp',
        alt: 'The Boolean mesh vs model body panel with both parts filled in, and the result row with its approx badge',
        captureNotes: 'With a model body in the project, click Boolean with model body on an imported STL. Left: the panel with both operands, Operation, the APPROXIMATE line and Run boolean. Right: the design tree after running, with the result row and its approx badge.',
        status: 'done',
      },
    ],
    keywords: 'boolean mesh model body subtract union intersect combine carve exact approximate snapshot edit boolean re-run stl',
    contextKeys: ['modal:boolean-mesh'],
    relatedTopicIds: ['import-stl', 'model-to-cam', 'provenance-badges'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'provenance-badges',
    title: 'Edited, stale and approx badges',
    category: 'import-geometry',
    summary: 'Small badges and highlights on geometry rows tell you when a part or layer may no longer match where it came from.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The design tree marks geometry that has moved away from its source. Hover a badge to read the full note.',
      },
      {
        kind: 'steps',
        steps: [
          '"edited" (on a DXF or SVG row): a layer was changed in Sketch, so the geometry may no longer match its source file.',
          '"stale" (on a section layer of a modeled body): the model changed after the section was taken. An operation that uses it takes the section again when it computes.',
          'Highlighted slice button (on an STL row): the part was moved or rotated after it was sliced; the tooltip reads "Rotation changed — re-slice to 2D loops".',
          '"exact" / "approx" (on a boolean result row): whether the boolean kept exact flat geometry or used the model body\'s display mesh for curved surfaces.',
          'Hovering a STEP row with no closed solid reads "Open shell: no closed solid. Mass, volume and center of mass are unavailable."',
        ],
      },
      {
        kind: 'tip',
        text: 'Badges do not lock anything - the geometry still works as it is.',
      },
      { kind: 'image', slot: 'badge-crops' },
    ],
    images: [
      {
        slot: 'badge-crops',
        file: 'badge-crops.webp',
        alt: 'Design tree rows showing the edited badge on a DXF and the approx badge on a boolean result',
        captureNotes: 'Two crops of design tree rows: a DXF row with the "edited" badge after a layer was changed in Sketch, and a boolean result row with its "approx" badge.',
        status: 'done',
      },
    ],
    keywords: 'badge edited stale approx exact provenance source changed re-slice moved rotated section boolean open shell tooltip',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['import-dxf-svg', 'section-at-z', 'boolean-mesh-model', 'import-stl'],
    sinceVersion: '0.36.0',
  },
])
