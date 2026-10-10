// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'nesting-overview',
    title: 'Nesting basics',
    category: 'nesting',
    summary: 'A nest packs copies of your 2D parts onto a sheet and lives in the design tree as a single node that owns its own seed copies of each part.',
    keywords:
      'nest nesting sheet pack layout seed copy owned violet outline sprout badge tree node utilization sources',
    contextKeys: ['workspace:cam', 'panel:properties:nest'],
  },
  {
    id: 'nest-create',
    title: 'Creating a nest',
    category: 'nesting',
    summary: 'The New Nest dialog picks parts and quantities, sets the sheet, solver, rotation, and spacing, then packs with Calculate and keeps the result with Accept - onto more sheets when one is not enough.',
    keywords:
      'new nest create modal dialog part picker quantity lock rotation solver fill exact sheet size calculate accept spacing gap margin window utilization pack max sheets multiple sheets overflow auto undo',
    contextKeys: ['modal:new-nest'],
  },
  {
    id: 'nest-sheet-stock',
    title: 'The nest sheet as stock',
    category: 'nesting',
    summary: 'Accepting a nest creates a fixed stock sized to the sheet, with the nest\'s Thickness (Z) as its depth - and moving that stock moves the whole nest.',
    keywords:
      'nest sheet stock thickness depth bound fixed material move gizmo setup default padding settings',
    contextKeys: ['modal:new-nest', 'panel:properties:nest'],
  },
  {
    id: 'nest-edit-explode',
    title: 'Editing a nest',
    category: 'nesting',
    summary: 'Edit reopens the nest dialog prefilled, seed layers are editable in place with a Recompute step, and Explode bakes every copy into independent parts.',
    keywords:
      'edit nest recompute stale seed changed layer visibility sketch explode ungroup independent parts rename reorder hide undo',
    contextKeys: ['workspace:cam', 'panel:properties:nest'],
  },
  {
    id: 'nest-toolpaths',
    title: 'Nested toolpaths and cut order',
    category: 'nesting',
    summary: 'Operations are computed once against the seed and expanded to every placed copy - in the toolpath view, the simulation, the cut-time estimate, and the posted G-code.',
    keywords:
      'nest toolpath copies expand instances cut order by operation by part travel clearance rapid post gcode multi-copy estimate simulation seed of source sheets',
    contextKeys: ['mode:toolpath', 'panel:properties:nest'],
  },
]
