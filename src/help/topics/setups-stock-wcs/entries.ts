// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'setup-wcs',
    title: 'Setup and WCS',
    category: 'setups-stock-wcs',
    summary: 'A Setup names the stock you machine, its work offset and work origin, the fixture stack under it, and the default heights its operations start from.',
    keywords:
      'setup wcs origin stock g54 fixture offset coordinate vertex gizmo edit second side flip turn over default heights outdated',
    contextKeys: ['modal:new-setup', 'modal:edit-setup'],
  },
  {
    id: 'fixture-stack-cam-grid',
    title: 'Fixture stack and CAM grid',
    category: 'setups-stock-wcs',
    summary: 'The Fixture Stack and CAM Grid section models what sits under your stock and picks the surface the reference grid draws at - for planning only, never for the WCS origin or a toolpath\'s Z.',
    keywords:
      'fixture stack cam grid support plane spoilboard vise vice clamp clamps fixed jaw soft jaw custom riser machine table stock bottom planning reference offset layer collision avoidance imported model workholding',
    contextKeys: ['modal:new-setup', 'modal:edit-setup'],
  },
  {
    id: 'wcs-origin-placement',
    title: 'Placing the work origin',
    category: 'setups-stock-wcs',
    summary: 'The Setup modal offers five ways to place the work origin: a stock corner, a snapped model vertex, typed coordinates, a draggable viewport gizmo, or the center of a circular feature.',
    keywords:
      'origin wcs zero corner grid vertex snap manual gizmo pick top bottom z0 place work zero circular center circle bore boss cylinder hole',
    contextKeys: ['modal:new-setup', 'interaction:wcs-origin-pick'],
  },
  {
    id: 'work-offsets',
    title: 'Work offsets G54-G59',
    category: 'setups-stock-wcs',
    summary: 'Each setup posts under one of six work offsets, G54 through G59, chosen in the Setup modal; setups on the same stock may share one.',
    keywords:
      'g54 g55 g56 g57 g58 g59 work offset fixture offset post gcode per stock per setup share conflict in use separate files',
    contextKeys: ['modal:new-setup'],
  },
  {
    id: 'stocks-auto-fixed',
    title: 'Auto and fixed stocks',
    category: 'setups-stock-wcs',
    summary: 'A project can carry any number of named stocks: auto stocks that size themselves around their member parts, and fixed stocks you size and place yourself.',
    keywords:
      'stock auto fixed named block size offset margin derive wrap fixture move gizmo add lock unlock padlock rename remove',
    contextKeys: ['mode:setup'],
  },
  {
    id: 'stock-membership',
    title: 'Which stock owns a part',
    category: 'setups-stock-wcs',
    summary: 'Every part row in the design tree shows the stock that owns it, and a dropdown on the row reassigns or excludes it.',
    keywords:
      'stock membership assign part owner none exclude dropdown lock model body as stock workholding import which stock join',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'workholding',
    title: 'Workholding: vises and clamps',
    category: 'setups-stock-wcs',
    summary: 'Import your vise, jaws or clamps as a part and turn on Workholding: the body is drawn as a fixture, is never stock or a cut, toolpaths keep clear of it, and Seat in vise places parts against it.',
    keywords:
      'workholding vise vice clamp jaw fixture import model seat in vise mate contact collision clearance never stock never cut',
    contextKeys: ['panel:properties:geometry', 'workspace:cam'],
  },
  {
    id: 'height-references',
    title: 'Heights explained',
    category: 'setups-stock-wcs',
    summary: 'Every operation uses five height planes - clearance, retract, feed, top, and bottom - each measured from a reference you choose, and the Heights tab shows the WCS Z each one lands on.',
    keywords:
      'heights clearance retract feed top bottom plane reference end condition depth through stock picked face surface datum offset smart user override setup default reset safety',
    contextKeys: ['modal:new-operation'],
  },
  {
    id: 'height-truthfulness',
    title: 'Generated-plane truth',
    category: 'setups-stock-wcs',
    summary: 'A generated toolpath remembers the height planes it was cut with, and the app never shows a saved path whose inputs no longer match.',
    keywords:
      'resolved heights snapshot stale outdated refuse truth authored intent regenerate fingerprint machine z wcs z clock',
    contextKeys: ['mode:toolpath'],
  },
  {
    id: 'height-planes-viewport',
    title: 'Seeing height planes',
    category: 'setups-stock-wcs',
    summary: 'The viewport can draw the five height planes of the selected operation as colored planes, with a master toggle and a per-plane checklist.',
    keywords:
      'height planes viewport show toggle display mode clearance retract feed top bottom colors',
    contextKeys: ['mode:setup'],
  },
]
