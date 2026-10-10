// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'post-basics',
    title: 'Posting G-code',
    category: 'posting-gcode',
    summary: 'The Post Process dialog turns computed toolpaths into G-code files for your controller, with a live preview of exactly what will be written.',
    keywords:
      'post process gcode g-code export download save nc ngc gcode dialect uccnc grbl grblhal linuxcnc generic controller template combined separate scope setup units g20 g21 save post import share lienpost custom setup sheet pdf picture toolpath print letter a4 pp fusion cps scpost pst',
    contextKeys: [
      'modal:post-process',
      'controller:uccnc',
      'controller:grbl',
      'controller:grblhal',
      'controller:linuxcnc',
      'controller:generic',
    ],
  },
  {
    id: 'post-safety',
    title: 'Why posting refuses',
    category: 'posting-gcode',
    summary: 'Posting refuses to write G-code only when it cannot build a program it can trust, and every refusal names the problem and the fix. An out-of-date operation is recomputed, not refused.',
    keywords:
      'refuse refusal blocked export disabled diagnostics outdated recompute error computing degraded duplicate tool number assigned conflict same number this program renumber work offset conflict multi stock rotated wcs safe z retract g53 z0 machine travel spindle rpm clamped not generated',
    contextKeys: ['modal:post-process', 'error:recent'],
  },
  {
    id: 'post-options',
    title: 'Post options',
    category: 'posting-gcode',
    summary: 'The Properties form tunes how the program is written: number formatting, arc output, tool changes, spindle dwell, program end, and framing lines.',
    keywords:
      'options format decimals precision line numbers sequence n words arcs g2 g3 ijk r radius sweep tolerance smoothing tool change m6 m0 macro dwell g4 program end g53 home g28 custom preamble postamble framing comments g10 canned cycle g81 g82 g83 spindle coolant vacuum controller format safe retract m5',
    contextKeys: ['modal:post-process'],
  },
  {
    id: 'gcode-preview',
    title: 'Checking the output',
    category: 'posting-gcode',
    summary: 'The preview pane shows the exact G-code the export will write, rebuilt live on every change, with the diagnostics list right beneath it.',
    keywords:
      'preview gcode g-code check verify read output lines expand full viewer go to line copy clipboard recompute diagnostics ok clean file selector separate before running edit hand edit editor insert line m0 pause find replace undo',
    contextKeys: ['modal:post-process'],
  },
  {
    id: 'post-include-context',
    title: 'Include LienCAM context',
    category: 'posting-gcode',
    summary: 'With the toggle on, the exported file ends in a comment block after M30 that lets Control recognise which setup and stock the program was posted from.',
    keywords: 'include liencam context toggle post process export m30 comment block lcx1 setup stock work offset control recognise certified post multi setup combined',
    contextKeys: ['modal:post-process'],
  },
]
