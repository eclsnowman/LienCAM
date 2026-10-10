// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'stock-simulation',
    title: 'Stock simulation',
    category: 'simulation',
    summary: 'The Simulate tab plays generated toolpaths and, with Simulate Stock Removal on, carves them out of the setup\'s stock.',
    keywords: 'stock simulation simulate playback removal voxel heightmap engine toolpath resolution cell size fast normal fine very fine',
    contextKeys: ['mode:simulation'],
  },
  {
    id: 'simulation-playback',
    title: 'Playing back a toolpath',
    category: 'simulation',
    summary: 'The Simulate tab plays the computed toolpath against a clock, with transport buttons, a draggable timeline, speed presets, and live position and move readouts.',
    keywords:
      'playback play pause rewind skip to end scrubber timeline transport speed 1x 100x feed true clock time readout wcs position move role tool change per operation feed estimate commanded real feed acceleration cycle time chipload',
    contextKeys: ['mode:simulation'],
  },
  {
    id: 'sim-engines',
    title: '3D and 2.5D simulation engines',
    category: 'simulation',
    summary: 'Stock removal can run on a full 3D engine that carves a true volume or a lighter 2.5D engine that tracks only the top surface, and Auto picks per your graphics hardware.',
    keywords:
      'simulation engine voxel heightmap 3d 2.5d auto gpu webgl2 fallback undercut settings stock removal wireframe unshaded',
    contextKeys: ['modal:settings', 'mode:simulation'],
  },
  {
    id: 'sim-accuracy',
    title: 'What simulation shows and skips',
    category: 'simulation',
    summary: 'The simulated cut uses each tool\'s real cutting shape and only carves moves that actually cut; the 2.5D engine cannot show undercuts or threads, and a very fine resolution may be coarsened to fit.',
    keywords:
      'accuracy undercut lollipop dovetail slot cutter neck thread mill thread form resolution coarsen memory budget compare target cut stock opacity hide toolpath finish pass rapids workholding vise clamp contact holder shank console',
    contextKeys: ['mode:simulation'],
  },
]
