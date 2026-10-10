// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'error-details',
    title: 'Where error details live',
    category: 'workspaces-viewport',
    summary: 'The bottom console is the in-app list of events, warnings, and errors for the current session.',
    keywords:
      'error details console warning refusal event log filter info success linked select troubleshoot clear unread',
    contextKeys: ['error:recent'],
  },
  {
    id: 'cam-vs-model-workspace',
    title: 'CAM and Model workspaces',
    category: 'workspaces-viewport',
    summary: 'The tabs in the header switch between the CAM workspace, the Model workspace, and Control, and bodies you model flow into CAM as geometry.',
    keywords:
      'workspace cam model part tab header switch mode setup sketch toolpath simulate control tool library post process body flow between edit wrap promote choose model item chooser',
    contextKeys: ['workspace:cam', 'workspace:part', 'modal:model-entry'],
  },
  {
    id: 'new-model',
    title: 'New Model',
    category: 'workspaces-viewport',
    summary: 'The Model tab opens the New Model window: Create Model starts a new, empty model, or choose an existing model to open it in the Model workspace.',
    keywords: 'new model create model tab window empty start build edit existing open design tree pen cancel',
    contextKeys: ['modal:new-model'],
  },
  {
    id: 'viewer-modes',
    title: 'Setup, Sketch, Toolpath, Simulate',
    category: 'workspaces-viewport',
    summary: 'The four CAM tabs are four views of the same project: arrange in Setup, draw in Sketch, inspect paths in Toolpath, and play them back in Simulate.',
    keywords:
      'viewer mode view tab setup sketch toolpath simulate simulation badge four views switch what each shows enter sketch mode stock removal playback',
    contextKeys: ['mode:setup', 'mode:toolpath', 'mode:simulation', 'mode:sketch'],
  },
  {
    id: 'viewport-navigation',
    title: 'Orbit, pan, zoom, view cube',
    category: 'workspaces-viewport',
    summary: 'The mouse orbits, pans, and zooms the 3D view under a scheme you pick in Settings, and the view cube or the right-click menu snaps to standard views.',
    keywords:
      'navigate orbit pan zoom rotate mouse scheme preset middle button wheel touch pinch view cube iso isometric top fit all right click axis invert orthographic',
    contextKeys: ['workspace:cam', 'workspace:part'],
  },
  {
    id: 'display-modes',
    title: 'Shading and display modes',
    category: 'workspaces-viewport',
    summary: 'The Display Mode flyout beside the view cube picks how bodies are shaded and holds the grid, height-plane, and section-view controls.',
    keywords:
      'display mode shading shaded edges wireframe unshaded translucent transparent section view slice cut plane axis flip drag plane grid spacing height planes nest seed flyout',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'design-tree',
    title: 'The design tree',
    category: 'workspaces-viewport',
    summary: 'The left panel lists everything in the project under three sections - Stock, Geometry, and Setups - with folders, renaming, visibility eyes, and status badges.',
    keywords:
      'design tree browser left panel stock geometry setups section folder drag reorder rename f2 double click context menu right click eye visibility lock suppress badge outdated ready error pending filter search collapse expand regen all',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'properties-panel',
    title: 'The properties panel',
    category: 'workspaces-viewport',
    summary: 'The right panel shows the properties of whatever is selected - stock, nest, layer, folder, part, operation, or setup - and most values edit in place.',
    keywords:
      'properties panel right side inspector selection edit inline value height pass parameter feed outdated regenerate collapsible group smart user override sketch toolbox move',
    contextKeys: ['panel:properties:operation'],
  },
  {
    id: 'toolpath-view',
    title: 'Reading the toolpath view',
    category: 'workspaces-viewport',
    summary: 'Toolpath moves are colored by type, and the Legend chip opens a list where each type can be hidden or shown on its own.',
    keywords:
      'toolpath view colors move type role legend chip cut rapid dashed helix ramp plunge stepover fast traverse wall follow finish lead-in lead-out hide show eye roughing preview pick move',
    contextKeys: ['mode:toolpath'],
  },
  {
    id: 'visibility-toggles',
    title: 'What the eye toggles control',
    category: 'workspaces-viewport',
    summary: 'Four buttons at the top of the 3D view show or hide the stock, parts, grid, and WCS marker, and finer eyes live in the Display Mode flyout, the design tree, and the toolpath legend.',
    keywords:
      'visibility toggle eye show hide stock geometry parts grid axes wcs marker toolbar toolpaths height planes seed outline layer per-part right click display only',
    contextKeys: ['mode:setup', 'workspace:cam'],
  },
]
