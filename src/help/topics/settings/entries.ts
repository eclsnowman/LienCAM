// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'settings-tour',
    title: 'The Settings window',
    category: 'settings',
    summary: 'Settings holds app-wide preferences in one scrolling window of titled sections - kept on this computer, not in your project file.',
    keywords:
      'settings preferences options application global window sections about version build schema project file format splash startup grbl controller settings where done ai assistant mcp',
    contextKeys: ['modal:settings'],
  },
  {
    id: 'settings-display',
    title: 'Theme, interface scale, and light mode',
    category: 'settings',
    summary: 'The Theme section picks the accent colors, how large the interface is drawn, and light or dark panels - all three apply immediately.',
    keywords:
      'display theme appearance amber default accent color interface scale size zoom 100% 125% 150% auto big screen light mode dark mode background',
    contextKeys: ['modal:settings'],
  },
  {
    id: 'settings-performance',
    title: 'Performance and simulation engine',
    category: 'settings',
    summary: 'Two sections trade looks against speed: how smoothly STEP parts are drawn, and which stock simulation engine runs.',
    keywords:
      'performance render fidelity tessellation quality balanced high memory step simulation engine auto voxel 3d heightmap 2.5d gpu graphics card webgl2 undercuts slow fallback',
    contextKeys: ['modal:settings'],
  },
  {
    id: 'settings-defaults',
    title: 'Projection, DXF import, nesting, and navigation',
    category: 'settings',
    summary: 'Four sections set working defaults: STL projection tolerance, where an imported DXF lands, new nest thickness, and how the mouse drives the 3D view.',
    keywords:
      'defaults stl projection tolerance quality preset draft standard fine custom dxf import keep drawing origin center nesting stock thickness padding navigation mouse scheme orbit pan zoom invert middle button right button',
    contextKeys: ['modal:settings'],
  },
  {
    id: 'machine-library',
    title: 'Machine library',
    category: 'settings',
    summary: 'The Machine Library stores your machine definitions - type, controller, travel, spindle, feeds, and probing defaults - and picks the one this project uses.',
    keywords:
      'machine library config travel spindle rpm rapid controller grbl grblhal linuxcnc uccnc generic dialect kind router plasma laser knife tool changer coolant axis feed limits default active import export json pro profile walkthrough',
    contextKeys: ['modal:machine-config'],
  },
  {
    id: 'settings-user-data',
    title: 'Backing up your data',
    category: 'settings',
    summary: 'The User Data section of Settings lists what LienCAM keeps on this computer, backs it up to a file or folder, and restores it.',
    keywords:
      'user data backup restore sync folder download bundle recover previous generation shop data machines tools libraries preferences storage safe keep lost',
    contextKeys: ['modal:settings'],
  },
]
