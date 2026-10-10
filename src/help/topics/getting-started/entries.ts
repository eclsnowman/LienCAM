// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'keyboard-shortcuts',
    title: 'Keyboard shortcuts',
    category: 'getting-started',
    summary: 'Shortcuts follow the active workspace and stay out of the way while you are typing.',
    keywords:
      'keyboard shortcut hotkey keys cam setup shift part move axis lock sketch undo redo regenerate operation delete rename f2 line rectangle circle arc spline text dimension trim split extend offset mirror fillet chamfer pattern move rotate scale measure construction',
    contextKeys: ['workspace:cam', 'mode:sketch'],
  },
  {
    id: 'welcome-overview',
    title: 'What LienCAM is',
    category: 'getting-started',
    summary: 'A CAM and CAD app that turns drawings and models into G-code and saves self-contained project files.',
    keywords:
      'welcome overview introduction what is browser cam cad workspace start beginner about tabs tool library setup sketch model toolpath simulate post process control',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'first-toolpath',
    title: 'Your first toolpath',
    category: 'getting-started',
    summary: 'Import a part, add a setup, create an operation, check the toolpath, and post G-code.',
    keywords:
      'first toolpath tutorial quick start import part setup operation generate regenerate post gcode g-code happy path new user begin create setup create operation',
    contextKeys: ['workspace:cam', 'mode:setup'],
  },
  {
    id: 'projects-save-open',
    title: 'Saving and opening projects',
    category: 'getting-started',
    summary: 'Projects save as self-contained .camproject files that carry your parts, tools, models, and toolpaths inside them.',
    keywords:
      'save open project file camproject download load new portable self-contained embed backup share transfer tools imported library opening',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'units',
    title: 'mm and inch',
    category: 'getting-started',
    summary: 'Display units change what you see and type; export units set whether posted G-code uses G21 or G20.',
    keywords:
      'units mm millimeter inch imperial metric g20 g21 display export switch convert measurement',
    contextKeys: ['modal:settings'],
  },
  {
    id: 'undo',
    title: 'Undo and history',
    category: 'getting-started',
    summary: 'Ctrl+Z undoes the last change, Ctrl+Y redoes it, and the app keeps the last 50 changes.',
    keywords:
      'undo redo history ctrl+z ctrl+y ctrl+shift+z revert back mistake restore 50 steps',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'ui-tour',
    title: 'The five screen regions',
    category: 'getting-started',
    summary: 'The header, design tree, 3D view, properties panel, and console with status bar each have one job.',
    keywords:
      'ui tour layout screen regions panels header toolbar tabs design tree viewport 3d view properties console status bar machine status interface where',
    contextKeys: ['workspace:cam'],
  },
]
