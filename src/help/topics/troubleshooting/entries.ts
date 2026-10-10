// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'outdated-after-open',
    title: 'Everything says outdated after opening',
    category: 'troubleshooting',
    summary: 'Operations reopen with an amber clock badge when their toolpath could not come back with them - every setting is kept, and regenerating rebuilds the toolpath.',
    keywords:
      'outdated amber clock everything stale after open reload regenerate regen all shift+g toolpath gone lost recompute why',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'blank-or-crashed',
    title: 'Recovering from a crash',
    category: 'troubleshooting',
    summary: 'A drawing error shows an error screen with the real error message; Reload opens the same saved project, and a failure in the 3D view alone leaves the rest of the app working.',
    keywords:
      'crash crashed blank white screen error boundary encountered an error reload reset project data recover frozen broken lost work view failed to render retry',
    contextKeys: ['error:recent'],
  },
  {
    id: 'gpu-limits',
    title: 'GPU capability fallbacks',
    category: 'troubleshooting',
    summary: 'The 3D stock simulation needs a GPU feature not every computer has; without it the app runs the 2.5D simulation and says so in the console.',
    keywords:
      'gpu graphics fallback voxel heightmap webgl webgl2 unsupported slow simulation engine undercut missing 3d not working intel integrated 2.5d',
    contextKeys: ['mode:simulation'],
  },
  {
    id: 'import-refusals',
    title: 'Why an import or derive was refused',
    category: 'troubleshooting',
    summary: 'When a file cannot be read or a shape cannot be used, the app names the reason in the design tree, the bottom console, or on the operation.',
    keywords:
      'refused refusal rejected cannot convert import failed curved mesh watertight open edges non-manifold tilted rotated off axis planar face error why wont step read edit as model',
    contextKeys: ['error:recent'],
  },
  {
    id: 'sketch-conflicts',
    title: 'Fixing an over-defined sketch',
    category: 'troubleshooting',
    summary: 'A constraint or dimension that would contradict the sketch is taken back at once and named in the status bar; a sketch that already holds a contradiction shows a red Over-defined banner with a Resolve list.',
    keywords:
      'over-defined overdefined conflicting conflict constraint dimension resolve redundant solver failed dof sketch stuck red banner remove rejected conflicts with',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'missing-toolpath',
    title: 'A toolpath vanished',
    category: 'troubleshooting',
    summary: 'If an operation points at a loop, hole or face that is no longer in its geometry, it turns red and names what is missing instead of drawing nothing.',
    keywords:
      'toolpath vanished disappeared missing gone empty no toolpath loop no longer exist orphan re-select reselect geometry tab stale selection degraded',
    contextKeys: ['workspace:cam'],
  },
]
