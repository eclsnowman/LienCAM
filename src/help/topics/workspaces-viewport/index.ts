import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'cam-vs-model-workspace',
    title: 'CAM and Model workspaces',
    category: 'workspaces-viewport',
    summary: 'The tabs in the header switch between the CAM workspace, the Model workspace, and Control, and bodies you model flow into CAM as geometry.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The header holds eight tabs: Tool Library, Setup, Sketch, Model, Toolpath, Simulate, Post Process, and Control. Setup, Sketch, Toolpath, and Simulate are views of the CAM workspace, where you arrange parts and stock and machine them. Model switches to the Model workspace, a separate solid-modeling screen for building and editing 3D bodies. Control switches to the machine control screen for running jobs on the real machine. Tool Library and Post Process open their own windows. Any of the four CAM tabs brings you back to CAM.',
      },
      {
        kind: 'paragraph',
        text: 'Bodies made in the Model workspace appear in the CAM design tree as model rows under Geometry, so operations can cut them like any imported part. To edit one of them, use Edit model on its row in the design tree; the Model tab itself always offers a new model. Select a body in the Model workspace and a CAM tab selects its row in the design tree.',
      },
      {
        kind: 'tip',
        text: 'To turn work you already have into a model, use the design tree: Edit as model on an imported STEP or STL part opens it as an editable model, and Convert to model on a sketch layer moves that sketch into a new model.',
      },
      {
        kind: 'paragraph',
        text: 'Clicking the Model tab opens the New Model window: Create Model starts a new model, or choose one of the models in the project below it to open it. Closing the window keeps you where you were. You can also open a model with Edit model on its row in the design tree.',
      },
      { kind: 'image', slot: 'mode-strip' },
    ],
    images: [
      {
        slot: 'mode-strip',
        file: 'mode-strip.webp',
        alt: 'The header tabs: Tool Library, Setup, Sketch, Model, Toolpath, Simulate, Post Process, and Control',
        captureNotes: 'Crop of the tabs in the middle of the header showing all eight, with the Setup tab active (underlined).',
        status: 'done',
      },
    ],
    keywords: 'workspace cam model part tab header switch mode setup sketch toolpath simulate control tool library post process body flow between edit wrap promote choose model item chooser',
    contextKeys: ['workspace:cam', 'workspace:part', 'modal:model-entry'],
    relatedTopicIds: ['model-to-cam', 'viewer-modes', 'edit-import-as-model', 'control-tab-overview'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'new-model',
    title: 'New Model',
    category: 'workspaces-viewport',
    summary: 'The Model tab opens the New Model window: Create Model starts a new, empty model, or choose an existing model to open it in the Model workspace.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Click the Model tab and the New Model window opens. Create Model adds a new model to the project and opens it in the Model workspace, ready to build. Below it, Or choose an existing model lists the models in the project; click one to open it. An imported STEP or STL part in that list opens as a model, the same as Edit as model in the design tree. Cancel, the X or Escape closes the window and leaves you where you were; nothing is added.',
      },
      {
        kind: 'paragraph',
        text: 'To change a model you already have, use its Edit model button (the pen) in the design tree, or right-click its row under Geometry and choose Edit model. That opens the existing model, not a new one.',
      },
    ],
    images: [],
    keywords: 'new model create model tab window empty start build edit existing open design tree pen cancel',
    contextKeys: ['modal:new-model'],
    relatedTopicIds: ['cam-vs-model-workspace', 'model-to-cam'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'viewer-modes',
    title: 'Setup, Sketch, Toolpath, Simulate',
    category: 'workspaces-viewport',
    summary: 'The four CAM tabs are four views of the same project: arrange in Setup, draw in Sketch, inspect paths in Toolpath, and play them back in Simulate.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Setup: the arranging view. Import and position parts, size stock, and place setups and their work origins.',
          'Sketch: with a sketch layer selected it opens that layer for editing. Otherwise the Enter Sketch Mode window offers New sketch, Pick existing in viewport, or a list of the existing layers to choose from.',
          'Toolpath: draws the computed toolpaths of the active setup, colored by move type, with the Legend chip to show or hide each type. A strip along the bottom of the view shows the selected operation\'s commanded feed, estimated real feed, chip load, and cycle time.',
          'Simulate: plays the toolpaths back move by move, with play, step, speed, and a timeline along the bottom of the view. Tick Simulate Stock Removal to watch the material being cut away.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A colored badge in the top-left corner of the 3D view names the current view (SETUP, SKETCH, TOOLPATH, or SIMULATION). Switching views never changes your project - each tab shows the same data for a different job.',
      },
      { kind: 'image', slot: 'four-modes' },
    ],
    images: [
      {
        slot: 'four-modes',
        file: 'four-modes.webp',
        alt: 'The same project shown in the Setup, Sketch, Toolpath, and Simulate views',
        captureNotes: '4-up comparison of real captures: one project shown in each of the four CAM views, with the view badge visible in each quadrant.',
        status: 'done',
      },
    ],
    keywords: 'viewer mode view tab setup sketch toolpath simulate simulation badge four views switch what each shows enter sketch mode stock removal playback',
    contextKeys: ['mode:setup', 'mode:toolpath', 'mode:simulation', 'mode:sketch'],
    relatedTopicIds: ['cam-vs-model-workspace', 'toolpath-view', 'stock-simulation', 'sketch-entry'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'viewport-navigation',
    title: 'Orbit, pan, zoom, view cube',
    category: 'workspaces-viewport',
    summary: 'The mouse orbits, pans, and zooms the 3D view under a scheme you pick in Settings, and the view cube or the right-click menu snaps to standard views.',
    sections: [
      {
        kind: 'paragraph',
        text: 'With the default mouse scheme, LienCAM default (left-orbit), left-drag orbits, right-drag pans, and the wheel or middle-drag zooms. Settings > Navigation offers six other schemes; most keep the left button free for selecting and put orbit, pan, and zoom on the middle or right button, some with Shift or Ctrl held. Two checkboxes there reverse the zoom and pan directions. On a touch screen, one finger orbits and two fingers pinch-zoom and pan. The same scheme applies in the CAM 3D view and in the Model workspace.',
      },
      {
        kind: 'steps',
        steps: [
          'Click a face of the view cube in the bottom-left corner (TOP, FRONT, RIGHT, BACK, LEFT, BOT) to turn the view to that side. The X, Y, and Z arrows on the cube show which way the axes point.',
          'Or right-click an empty spot in the 3D view: Fit all zooms to fit the imported 3D parts (STL and STEP) in view, Isometric view gives the three-quarter overview, and Top view looks straight down.',
        ],
      },
      {
        kind: 'tip',
        text: 'The CAM view uses a flat (orthographic) projection, so parallel edges stay parallel and lengths on screen do not shrink with distance.',
      },
      { kind: 'image', slot: 'view-cube' },
    ],
    images: [
      {
        slot: 'view-cube',
        file: 'view-cube.webp',
        alt: 'The view cube with labeled faces and XYZ axis arrows, and the right-click view menu',
        captureNotes: 'Close crop of the bottom-left view cube with its face labels, axis arrows and letters, and the Display mode button beside it; a second crop shows the right-click menu of the 3D view with Fit all, Isometric view, and Top view.',
        status: 'done',
      },
    ],
    keywords: 'navigate orbit pan zoom rotate mouse scheme preset middle button wheel touch pinch view cube iso isometric top fit all right click axis invert orthographic',
    contextKeys: ['workspace:cam', 'workspace:part'],
    relatedTopicIds: ['viewer-modes', 'display-modes', 'settings-defaults'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'display-modes',
    title: 'Shading and display modes',
    category: 'workspaces-viewport',
    summary: 'The Display Mode flyout beside the view cube picks how bodies are shaded and holds the grid, height-plane, and section-view controls.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click the Display mode button (a small cube with a gear) beside the view cube in the bottom-left corner of the 3D view to open the Display Mode flyout.',
          'Pick a shading mode: Shaded with edges, Shaded, no edges, Unshaded (wireframe), or Translucent - useful for seeing pockets and toolpaths through the part.',
          'Below that: Grid spacing sets the spacing of the floor grid, Nest seed outline shows or hides the outline box drawn around each nest\'s seed part, and Height planes shows the operation height planes, with a checkbox for each one (Clearance, Retract, Feed Height, Top of Stock, Bottom of Cut).',
        ],
      },
      {
        kind: 'paragraph',
        text: 'At the bottom sits Section view: a checkbox that slices the scene with a cutting plane. Choose the Axis (X, Y, or Z), move the Pos slider, or click Drag plane and drag up or down in the 3D view. Flip side keeps the other half instead, and Clear turns section view off and resets its controls. The slice is for looking inside only - it never changes your geometry.',
      },
      { kind: 'image', slot: 'shading-compare' },
    ],
    images: [
      {
        slot: 'shading-compare',
        file: 'shading-compare.webp',
        alt: 'The Display Mode flyout open beside the view cube',
        captureNotes: 'The Display Mode flyout open beside the view cube, showing the four shading modes, Grid spacing, Nest seed outline, Height planes with its per-plane checkboxes, and the Section view controls.',
        status: 'done',
      },
    ],
    keywords: 'display mode shading shaded edges wireframe unshaded translucent transparent section view slice cut plane axis flip drag plane grid spacing height planes nest seed flyout',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['height-planes-viewport', 'visibility-toggles', 'viewport-navigation'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'design-tree',
    title: 'The design tree',
    category: 'workspaces-viewport',
    summary: 'The left panel lists everything in the project under three sections - Stock, Geometry, and Setups - with folders, renaming, visibility eyes, and status badges.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The top row shows the project name - double-click it to rename the project. Below it, the filter box ("Filter by name or type...") narrows every section at once, and three buttons collapse everything, expand everything, or show just the top level. The three sections follow how a job is built: Stock holds the material blocks (+ Auto and + Fixed add one), Geometry holds parts, sketches, and models (its header buttons import a file or add a new layer, folder, nest, or model), and Setups holds each setup with its operations (+ adds a setup, REGEN ALL regenerates every operation). Right-click a row for its menu.',
      },
      {
        kind: 'steps',
        steps: [
          'Rename any named row by double-clicking its name, or select it and press F2. Double-clicking an operation opens it for editing.',
          'Organize with folders: parts and operations can be grouped into folders, and rows drag by their handle to reorder or drop into a folder. Whether a folder is open or closed is remembered.',
          'Use the eye buttons to show or hide a whole part or a single layer in the 3D view without deleting anything. The lock button on a part locks it in place so it cannot be moved.',
          'Each operation row has buttons to suppress it (the power button - a suppressed operation is skipped by REGEN ALL, posting, and simulation), edit, duplicate, compute (G), and delete it.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Operation rows carry a status badge: a green check means the toolpath is ready; a spinner or a filling ring means it is computing; a gray clock means it has not been computed yet; an amber clock means it is outdated (hover for why, then regenerate it); a red circle means it could not be generated (hover over it for the reason); and a red triangle means the model geometry it cuts is gone. A small down-arrow beside the badge means the tool could not reach the full depth. A collapsed folder, nest, or setup shows a red or amber badge when something hidden inside it needs attention.',
      },
      { kind: 'image', slot: 'tree-overview' },
    ],
    images: [
      {
        slot: 'tree-overview',
        file: 'tree-overview.webp',
        alt: 'The design tree with the Stock, Geometry, and Setups sections, ready and not-yet-computed operations',
        captureNotes: 'Full design tree with the three sections: the project name row, filter box and its buttons, a Geometry folder, a setup expanded with operations - two with the green ready check and the rest with the gray not-computed clock - and the row buttons visible.',
        status: 'done',
      },
    ],
    keywords: 'design tree browser left panel stock geometry setups section folder drag reorder rename f2 double click context menu right click eye visibility lock suppress badge outdated ready error pending filter search collapse expand regen all',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['operation-folders', 'stock-membership', 'properties-panel', 'provenance-badges'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'properties-panel',
    title: 'The properties panel',
    category: 'workspaces-viewport',
    summary: 'The right panel shows the properties of whatever is selected - stock, nest, layer, folder, part, operation, or setup - and most values edit in place.',
    sections: [
      {
        kind: 'paragraph',
        text: 'There is one Properties panel and it follows your selection: select a stock and you get its size and position, a part gives its placement and layers, an operation gives its tool, feeds, summary, heights, and passes, and with nothing selected the active setup shows. An outdated operation names the reason in its Summary Status row. A toolpath move you click in the Toolpath view comes first and shows that one move\'s numbers. In Sketch mode the panel becomes the sketch toolbox instead.',
      },
      {
        kind: 'paragraph',
        text: 'Values here are edited in place: changing an operation value in the panel - a height, a pass setting, a feed - updates the operation, and its badge in the tree turns to a clock until you click Regenerate at the bottom of the panel (or press G). Long panels are split into groups you can fold open and closed; the app remembers which ones you folded.',
      },
      {
        kind: 'tip',
        text: 'The Heights group shows each height with where it came from underneath: Smart when the app worked it out, User Override when you typed it.',
      },
      { kind: 'image', slot: 'panel-cascade' },
    ],
    images: [
      {
        slot: 'panel-cascade',
        file: 'panel-cascade.webp',
        alt: 'The properties panel showing an operation with its groups',
        captureNotes: 'Properties panel for a selected, computed operation: Tool + Feeds, the Rename/Duplicate/Delete buttons, the Summary and Heights groups open with editable number fields, and the Regenerate button at the bottom.',
        status: 'done',
      },
    ],
    keywords: 'properties panel right side inspector selection edit inline value height pass parameter feed outdated regenerate collapsible group smart user override sketch toolbox move',
    contextKeys: ['panel:properties:operation'],
    relatedTopicIds: ['design-tree', 'generation-failures', 'height-truthfulness'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'error-details',
    title: 'Where error details live',
    category: 'workspaces-viewport',
    summary: 'The bottom console is the in-app list of events, warnings, and errors for the current session.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'The console line above the status bar always shows the latest event; a red number on it counts errors you have not looked at yet. Click the line to open the full list, and click it again to close it.',
          'Use the All, Info, Success, Warning, and Error buttons to narrow the list. Newest events appear first. Clear empties the list; Troubleshoot opens the help on errors.',
          'When an event is linked to an operation, a part, or a setup, click the row to select that item and look at it in context.',
        ],
      },
      { kind: 'image', slot: 'console' },
    ],
    images: [
      {
        slot: 'console',
        file: 'console.webp',
        alt: 'The expanded bottom console with its filter buttons and event list',
        captureNotes: 'Expanded console at the bottom of the window: the latest-event line, the All/Info/Success/Warning/Error buttons, Troubleshoot and Clear, and several event rows with time and source.',
        status: 'done',
      },
    ],
    keywords: 'error details console warning refusal event log filter info success linked select troubleshoot clear unread',
    contextKeys: ['error:recent'],
    relatedTopicIds: ['generation-failures'],
    sinceVersion: '0.16.1',
  },
  {
    id: 'toolpath-view',
    title: 'Reading the toolpath view',
    category: 'workspaces-viewport',
    summary: 'Toolpath moves are colored by type, and the Legend chip opens a list where each type can be hidden or shown on its own.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Every drawn move has a type, and each type has its own color: Cut, Rapid (drawn dashed), Helix, Ramp, Plunge, Stepover, Fast Traverse, Wall Follow, Finish, Lead-in, and Lead-out. The legend uses the same colors as the lines in the 3D view.',
      },
      {
        kind: 'steps',
        steps: [
          'Click the Legend chip in the bottom-right corner of the Toolpath or Simulate view. The number on it counts how many move types are showing.',
          'The list shows only the move types the toolpaths on screen actually use. Click a row to hide or show that type - the eye icon changes and the lines disappear or come back.',
          'In the Toolpath view the legend also holds the Roughing stock preview checkbox, which shades the material a roughing pass leaves behind.',
          'Click a single move in the 3D view to see its numbers in the Properties panel.',
        ],
      },
      {
        kind: 'tip',
        text: 'Hiding Rapid is the quickest way to declutter a busy path and look at just the cutting moves; showing only Lead-in and Lead-out is a quick check of your entry moves.',
      },
      { kind: 'image', slot: 'legend' },
    ],
    images: [
      {
        slot: 'legend',
        file: 'legend.webp',
        alt: 'A colored toolpath with the open legend listing move types, Rapid hidden',
        captureNotes: 'Toolpath view of an operation with several move types, the legend open with Rapid hidden (struck through, eye off) and the chip number visible.',
        status: 'done',
      },
    ],
    keywords: 'toolpath view colors move type role legend chip cut rapid dashed helix ramp plunge stepover fast traverse wall follow finish lead-in lead-out hide show eye roughing preview pick move',
    contextKeys: ['mode:toolpath'],
    relatedTopicIds: ['viewer-modes', 'creating-operations', 'stock-simulation', 'cut-time'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'visibility-toggles',
    title: 'What the eye toggles control',
    category: 'workspaces-viewport',
    summary: 'Four buttons at the top of the 3D view show or hide the stock, parts, grid, and WCS marker, and finer eyes live in the Display Mode flyout, the design tree, and the toolpath legend.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'The four buttons at the top of the 3D view: Toggle stock, Toggle geometry (all parts at once), Toggle grid, and Toggle WCS (the work-origin axis marker). A lit button means the item is showing.',
          'Right-clicking an empty spot in the 3D view offers the same switches as words - Hide stock, Hide parts, Hide toolpaths, Hide grid (or Show ..., when hidden).',
          'The Display Mode flyout by the view cube holds the height planes, with a checkbox for each one, and the nest seed outline.',
          'Each part and each layer in the design tree has its own eye, and each move type has its own eye in the toolpath legend.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'All of these only change what you see. Hiding something never removes it from the project or from toolpath generation, posting, or simulation.',
      },
      { kind: 'image', slot: 'toolbar-toggles' },
    ],
    images: [
      {
        slot: 'toolbar-toggles',
        file: 'toolbar-toggles.webp',
        alt: 'The four show/hide buttons at the top of the 3D view with a tooltip showing',
        captureNotes: 'Crop of the four buttons at the top of the 3D view (stock, geometry, grid, WCS) with the pointer on Toggle geometry so its tooltip shows.',
        status: 'done',
      },
    ],
    keywords: 'visibility toggle eye show hide stock geometry parts grid axes wcs marker toolbar toolpaths height planes seed outline layer per-part right click display only',
    contextKeys: ['mode:setup', 'workspace:cam'],
    relatedTopicIds: ['display-modes', 'toolpath-view', 'design-tree'],
    sinceVersion: '0.36.0',
  },
])
