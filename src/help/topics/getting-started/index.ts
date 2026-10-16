import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'welcome-overview',
    title: 'What LienCAM is',
    category: 'getting-started',
    summary: 'A CAM and CAD app that turns drawings and models into G-code and saves self-contained project files.',
    sections: [
      {
        kind: 'paragraph',
        text: 'LienCAM turns 2D drawings and 3D models into G-code for a CNC router or mill. It runs in your web browser. Projects are ordinary .camproject files you save to and open from your own computer.',
      },
      {
        kind: 'paragraph',
        text: 'The tabs across the top of the window take you through the job in order: Tool Library, Setup, Sketch, Model, Toolpath, Simulate, Post Process, and Control. Setup, Sketch, Toolpath, and Simulate are views of the CAM workspace, where you bring in parts, set up stock, create operations, and check the toolpaths. Model opens the Model workspace, a solid modeler for building 3D parts. Post Process writes the G-code, and Control runs it on your machine.',
      },
      {
        kind: 'paragraph',
        text: 'The CAM screen has five regions: the header along the top, the design tree on the left, the 3D view in the middle, the properties panel on the right, and the console and status bar along the bottom. See "The five screen regions" for a tour, and "Your first toolpath" for the shortest path to cutting a part.',
      },
      { kind: 'image', slot: 'app-overview' },
    ],
    images: [
      {
        slot: 'app-overview',
        file: 'app-overview.webp',
        alt: 'The full application window with a part loaded and a toolpath visible',
        captureNotes:
          'Full app window in the CAM workspace, Toolpath tab active, with parts in the design tree, one setup with computed operations, and all five regions visible (header, design tree, 3D view, properties panel, console and status bar). Numbered labels 1-5 mark the regions.',
        status: 'done',
      },
    ],
    keywords:
      'welcome overview introduction what is browser cam cad workspace start beginner about tabs tool library setup sketch model toolpath simulate post process control',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['ui-tour', 'first-toolpath', 'projects-save-open'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'first-toolpath',
    title: 'Your first toolpath',
    category: 'getting-started',
    summary: 'Import a part, add a setup, create an operation, check the toolpath, and post G-code.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Import a part: in the design tree on the left, click the + (Import geometry) button on the Geometry section header and pick a DXF, SVG, STL, OBJ, or STEP file.',
          'Add a setup: click the + button on the Setups section header ("Add setup"). In the New Setup window, choose the stock and place the work origin, then click Create Setup. The setup decides where your machine\'s zero point sits on the stock.',
          'Create an operation: click the + button on the setup row ("Add operation (N)"), or press N. Pick an operation type, a tool, and the geometry to cut, then click Create Operation. The toolpath is computed as soon as the operation is created.',
          'Check the result: click the Toolpath tab in the header to see the cutting moves. If you change something later, press G to regenerate the selected operation, Shift+G to regenerate all of them, or click REGEN ALL on the Setups section header.',
          'Post the G-code: click the Post Process tab in the header, review the output, and save the file for your machine.',
        ],
      },
      {
        kind: 'tip',
        text: 'Watch the left end of the status bar at the bottom of the window: it reads "Computing..." while toolpaths are being calculated, "Compute pending" when an operation needs regenerating, a count such as "1 operation failed" when one could not be generated, and "Ready" when there is nothing to do.',
      },
      { kind: 'image', slot: 'first-toolpath-strip' },
    ],
    images: [
      {
        slot: 'first-toolpath-strip',
        file: 'first-toolpath-strip.webp',
        alt: 'Five small screenshots showing import, setup, operation, toolpath view, and post process',
        captureNotes:
          'A horizontal 5-panel strip, one panel per step, numbered 1-5: (1) the Geometry section header with its buttons, (2) the New Setup window, (3) the new operation window with its Create Operation button, (4) the Toolpath view showing a computed path, (5) the Post Process window with G-code output.',
        status: 'done',
      },
    ],
    keywords:
      'first toolpath tutorial quick start import part setup operation generate regenerate post gcode g-code happy path new user begin create setup create operation',
    contextKeys: ['workspace:cam', 'mode:setup'],
    relatedTopicIds: ['welcome-overview', 'setup-wcs', 'generation-failures', 'projects-save-open'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'projects-save-open',
    title: 'Saving and opening projects',
    category: 'getting-started',
    summary: 'Projects save as self-contained .camproject files that carry your parts, tools, models, and toolpaths inside them.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Save in the header. The project is saved as a .camproject file named after the project, with spaces turned into underscores. In a browser it goes to your normal download folder; when LienCAM runs as a desktop program, a Save window asks where to put it.',
          'Click Open in the header to open the project picker. Choose an example, a recent project in the desktop app, or Browse... to pick a .camproject file. While it opens, the header and the status bar show "Opening" with what is being loaded.',
          'Click New in the header to start a fresh project. Your machines, tool library, and settings stay as they are - only the project is replaced.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A .camproject file is self-contained. It carries the imported STL and STEP parts, the tools your operations use (with their libraries and holders), and any models built in the Model workspace. You can move the file to another computer or send it to someone else and it opens complete - the original import files are not needed again.',
      },
      {
        kind: 'paragraph',
        text: 'Computed toolpaths are saved in the file too, so a saved project reopens with its operations ready. When a project uses tools your tool library does not have, opening it adds them to your library and the status bar says how many were added; tools you already have are never replaced. Settings and your machine library belong to this computer, not to the file.',
      },
      {
        kind: 'paragraph',
        text: 'The desktop picker shows recent projects with their folder and last-opened time. Remove from list removes only the recent entry; a moved or missing file stays listed but cannot be opened from that entry. Examples show part previews and open with the sample hobby router. Help > Open an example project opens the Examples section again. Tick Always go straight to the file browser in the picker or Settings > Opening projects to make Open go straight to Browse instead.',
      },
      { kind: 'image', slot: 'file-buttons' },
      {
        kind: 'paragraph',
        text: 'When the project is empty, the picker offers Start with an empty project. Choose it to close the picker and begin drawing; it does not replace a project that already has work in it.',
      },
    ],
    images: [
      {
        slot: 'file-buttons',
        file: 'file-buttons.webp',
        alt: 'The New, Open, and Save buttons in the header',
        captureNotes:
          'Close crop of the left end of the header showing the LienCAM name and the New, Open, and Save buttons.',
        status: 'done',
      },
    ],
    keywords:
      'save open project file camproject download load new portable self-contained embed backup share transfer tools imported library opening',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['first-toolpath', 'generation-failures', 'machine-choice'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'units',
    title: 'mm and inch',
    category: 'getting-started',
    summary: 'Display units change what you see and type; export units set whether posted G-code uses G21 or G20.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click Settings in the header and find the Units section below STL Projection.',
          'Set Display units to mm or in. This changes the units shown and typed everywhere in the app, and the status bar shows the current choice. Values are kept in millimeters inside the app, so switching back and forth never changes your part.',
          'Set Export units to mm or in. This controls the posted G-code only: G21 for millimeters, G20 for inches.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The two settings are independent, so you can design in one unit system and post in the other - for example, work in millimeters on screen while posting inch G-code for your machine.',
      },
      { kind: 'image', slot: 'units-settings' },
    ],
    images: [
      {
        slot: 'units-settings',
        file: 'units-settings.webp',
        alt: 'The Units section of the Settings window with Display units and Export units',
        captureNotes:
          'Settings window open, cropped to the Units section showing the Display units and Export units dropdowns.',
        status: 'done',
      },
    ],
    keywords: 'units mm millimeter inch imperial metric g20 g21 display export switch convert measurement',
    contextKeys: ['modal:settings'],
    relatedTopicIds: ['welcome-overview', 'settings-tour'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'undo',
    title: 'Undo and history',
    category: 'getting-started',
    summary: 'Ctrl+Z undoes the last change, Ctrl+Y redoes it, and the app keeps the last 50 changes.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Press Ctrl+Z to undo and Ctrl+Y (or Ctrl+Shift+Z) to redo, or use the Undo and Redo buttons at the right of the header. The app keeps the last 50 changes. Making a new edit after undoing discards the redo steps, as in most programs.',
      },
      {
        kind: 'paragraph',
        text: 'The buttons act on whichever workspace is active: in the CAM workspace they step through project changes, and in the Model workspace they step through modeling changes. The Control tab has no Undo or Redo. While you are typing in a text or number field, Ctrl+Z is the normal text undo for that field.',
      },
      {
        kind: 'tip',
        text: 'Toolpaths are not kept in the undo history, so an operation that was ready comes back from an undo marked outdated. Press G to regenerate the selected operation or Shift+G to regenerate all of them.',
      },
    ],
    images: [],
    keywords: 'undo redo history ctrl+z ctrl+y ctrl+shift+z revert back mistake restore 50 steps',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['keyboard-shortcuts', 'generation-failures'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    category: 'getting-started',
    summary: 'Shortcuts follow the active workspace and stay out of the way while you are typing.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'CAM: N opens a new operation on the active setup; G regenerates the selected operation; Shift+G regenerates all; Delete or Backspace deletes the selected part, operation, or setup after you confirm; F2 renames the selected tree row.',
          'Setup: while dragging a selected part by a plane or center handle, hold Shift to lock the move to the axis you are moving along most. The single-axis arrow handles always move along their own axis.',
          'Sketch drawing tools: L line, R rectangle, C circle, A arc, S spline, G text, D dimension. Sketch editing tools: T trim, K split, E extend, O offset, M mirror, F fillet, H chamfer, V move, W rotate, X scale; 1, 2, and 3 make linear, circular, and along-a-path patterns. I shows or hides the Measure readout and Q switches construction on or off. Tab turns a rectangle into an angled rectangle while drawing it. Enter finishes the current chain; Escape cancels or returns to Select; Delete removes the selected sketch items.',
          'Everywhere: Ctrl+Z undoes and Ctrl+Y or Ctrl+Shift+Z redoes in the active workspace. Single-key shortcuts do nothing while a text field, dropdown, or window has the keyboard.',
        ],
      },
    ],
    images: [],
    keywords:
      'keyboard shortcut hotkey keys cam setup shift part move axis lock sketch undo redo regenerate operation delete rename f2 line rectangle circle arc spline text dimension trim split extend offset mirror fillet chamfer pattern move rotate scale measure construction',
    contextKeys: ['workspace:cam', 'mode:sketch'],
    relatedTopicIds: ['error-details', 'undo', 'sketch-draw-tools'],
    sinceVersion: '0.16.1',
  },
  {
    id: 'ui-tour',
    title: 'The five screen regions',
    category: 'getting-started',
    summary: 'The header, design tree, 3D view, properties panel, and console with status bar each have one job.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The CAM screen is divided into five regions. The left and right panels can be resized by dragging their inner edges.',
      },
      {
        kind: 'steps',
        steps: [
          'Header (top): New, Open, and Save on the left; the tabs in the middle (Tool Library, Setup, Sketch, Model, Toolpath, Simulate, Post Process, Control); Undo, Redo, Settings, Help, About, and the machine status (Offline, Not homed, Ready, Running, or Alarm) on the right. In a narrow window the buttons show only their icons - hover over one to see its name.',
          'Design tree (left panel): everything in the project, in three sections - Stock, Geometry, and Setups. The buttons on each section header add new items, and right-clicking a row opens its menu.',
          '3D view (center): your parts, stock, and toolpaths. The badge in its top-left corner names the current view, the machine name in its top-right corner opens the Machine Library, the buttons at its top show or hide things, and the view cube sits in its bottom-left corner.',
          'Properties panel (right panel): the details of whatever is selected - a part, stock, setup, or operation - with most values editable in place.',
          'Console and status bar (bottom): the console line shows the latest event and opens into the full list of events, warnings, and errors; the status bar below it shows the project state (Ready, Computing..., Compute pending), the display units, and how many parts are loaded.',
        ],
      },
      { kind: 'image', slot: 'regions-labeled' },
    ],
    images: [
      {
        slot: 'regions-labeled',
        file: 'regions-labeled.webp',
        alt: 'The application window with the five screen regions numbered',
        captureNotes:
          'Full app window in the CAM workspace, Setup tab active, with a project loaded. Numbered labels mark each region: 1 header, 2 design tree, 3 3D view, 4 properties panel, 5 console and status bar - the same numbering as the steps.',
        status: 'done',
      },
    ],
    keywords:
      'ui tour layout screen regions panels header toolbar tabs design tree viewport 3d view properties console status bar machine status interface where',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['welcome-overview', 'first-toolpath', 'error-details', 'keyboard-shortcuts'],
    sinceVersion: '0.36.0',
  },
])
