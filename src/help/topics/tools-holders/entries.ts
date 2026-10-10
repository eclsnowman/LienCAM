// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'tool-library',
    title: 'The tool library',
    category: 'tools-holders',
    summary: 'The Tool Library window holds every cutter in named libraries, with search, filters, and a tabbed editor with a live tool diagram.',
    keywords:
      'tool library tools list search filter sort type material duplicate new delete rename library scope save draft discard tabs general cutter cutting data post diagram tool number t number auto-post cutting hand left hand probe',
    contextKeys: ['modal:tool-library'],
  },
  {
    id: 'tool-geometry',
    title: 'Tool shapes',
    category: 'tools-holders',
    summary: 'All 19 tool types share one geometry model - a profile revolved around the tool axis - and that same profile drives the 2D diagram, the 3D tool in the viewport, and stock-removal simulation.',
    keywords:
      'tool shape geometry profile revolution 19 types diagram 3d simulation cutter fields diameter shank flute length corner radius neck relief included angle per side taper convention probe',
    contextKeys: ['modal:tool-library'],
  },
  {
    id: 'tool-holders',
    title: 'Tool holders',
    category: 'tools-holders',
    summary: 'Holders are a stack of cone or cylinder segments kept in their own list; assign one to a tool and the viewport draws the full tool-plus-holder assembly above the stickout.',
    keywords:
      'holder holders segment stack cone cylinder height lower upper diameter od gauge length stickout length below holder assembly collet chuck preview silhouette assign none reach',
    contextKeys: ['modal:tool-library'],
  },
  {
    id: 'tools-import-export',
    title: 'Importing and exporting tools',
    category: 'tools-holders',
    summary: 'Tools travel as JSON files or industry-standard .tools archives; every import lands as its own new library named after the file.',
    keywords:
      'import export tools file json archive zip library interchange share transfer holder embedded skipped readout console',
    contextKeys: ['modal:tool-library'],
  },
  {
    id: 'rub-warnings',
    title: 'Tool reach: Stopped short',
    category: 'tools-holders',
    summary: 'Every toolpath is kept to what the tool can reach - the neck, shank and holder stay clear of the part, the stock and any workholding - and an operation that could not reach full depth says "Stopped short".',
    keywords:
      'rub warning reach stopped short shank holder neck flute length stickout length below holder depth trim clearance shank clearance allowance collision contact workholding uncut',
    contextKeys: ['panel:properties:operation'],
  },
  {
    id: 'thread-mill-tool',
    title: 'Thread mill tools',
    category: 'tools-holders',
    summary: 'A thread mill adds a Thread form section to the Cutter tab - tooth count, form angle, and pitch - and the diagram draws the toothed cutter live.',
    keywords:
      'thread mill tool teeth form angle pitch single point full form neck relief transition angle diagram cutter 60 degree',
    contextKeys: ['modal:tool-library'],
  },
  {
    id: 'probe-tool',
    title: 'Probe tools',
    category: 'tools-holders',
    summary: 'The Probe tool type keeps a touch probe in the tool library: its ball, stylus and stem sizes, which probe input it is wired to, and whether its contact is normally open or normally closed.',
    keywords:
      'probe touch probe 3d probe tool type ball tip diameter stylus length stem diameter auto probe input probe 1 probe 2 contact normally open normally closed no nc calibrated radius x y ball radius',
    contextKeys: ['modal:tool-library'],
  },
]
