// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'import-dxf-svg',
    title: 'Importing DXF and SVG',
    category: 'import-geometry',
    summary: 'DXF and SVG files import as 2D layers of loops you can machine, edit in Sketch, clean up, or turn into a model.',
    keywords:
      'import dxf svg insert nested array mirrored blocks 2d drawing vector layers loops contour hole open chain gaps closed units inches keep drawing origin annotation hidden layer stock prompt edit in sketch block explode import into sketch picture trace png jpg',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'import-stl',
    title: 'Importing STL and OBJ meshes',
    category: 'import-geometry',
    summary: 'An STL or OBJ mesh shows in 3D. Slice an STL into 2D loops in two steps: pick the slice height, then pick where the loops land.',
    keywords:
      'import stl obj mesh 3d slice project projection 2d loops tolerance quality preset draft standard fine target plane stock top floor re-slice rotation moved edge chains contour pocket',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'import-step',
    title: 'Importing STEP and IGES solids',
    category: 'import-geometry',
    summary: 'STEP and IGES files import as true solids that keep their exact shape for face picks, sections, and editing as a model.',
    keywords:
      'import step stp iges igs solid brep b-rep exact geometry render fidelity performance balanced high embedded part name rename seated floor progress failed surfaces reload cache rotate rotation turn over upside down flip tilt tilted re-derive',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'multi-body-step',
    title: 'Multi-body STEP files',
    category: 'import-geometry',
    summary: 'When a STEP file holds more than one body, you choose whether it lands as one row or as one row per body.',
    keywords:
      'multi-body step multiple bodies solids combined one item per body split choose body split import choice assembly',
    contextKeys: ['modal:multi-body-import'],
  },
  {
    id: 'face-edge-selection',
    title: 'Picking faces and edges on a solid',
    category: 'import-geometry',
    summary: 'The operation editor can take its cutting geometry straight from an imported solid: pick faces, pick edges, or detect holes.',
    keywords:
      'pick face pick edges detect holes from 3d model solid step iges brep loops boundary bottom of cut cylinder wall bore boss island drill thread done banner datum flat planar curved refused',
    contextKeys: ['workspace:cam', 'modal:new-operation'],
  },
  {
    id: 'section-at-z',
    title: 'Slicing a solid at a height',
    category: 'import-geometry',
    summary: 'An imported solid can be cut at any height to give exact 2D loops, from the design tree or from the operation editor.',
    keywords:
      'section slice z height cross-section exact solid step scrub set in viewport live preview loops layer section 1 z range model coords stale modeled body refresh rotated',
    contextKeys: ['interaction:brep-section'],
  },
  {
    id: 'geometry-cleanup',
    title: 'Fit arcs and merge lines',
    category: 'import-geometry',
    summary: 'Rebuild an imported layer with true arcs and merged lines, compare before and after, then keep it or cancel.',
    keywords:
      'fit arcs merge lines optimize optimization preview cleanup segments polyline simplify nodes before after compare apply cancel wand',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'edit-import-as-model',
    title: 'Editing an import as a model',
    category: 'import-geometry',
    summary: 'Open an imported STEP part or STL in the Model workspace to change it, even though you did not draw it here.',
    keywords:
      'edit as model edit model import step stl convert solid flat sided prismatic mesh features recognised model workspace push pull fillet hole defeature refused nest seed missing',
    contextKeys: ['workspace:cam', 'workspace:part'],
  },
  {
    id: 'convert-to-model',
    title: 'Converting a sketch layer to a model',
    category: 'import-geometry',
    summary: 'A 2D layer can move into a new model as its base sketch; operations that used it are marked outdated until you pick again.',
    keywords:
      'convert sketch layer to model promote base sketch move dxf svg dependent operations outdated reselect extrude',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'boolean-mesh-model',
    title: 'Boolean an imported mesh with a model body',
    category: 'import-geometry',
    summary: 'Subtract, union, or intersect an imported STL with a body built in the Model workspace to get a new row, marked exact or approx.',
    keywords:
      'boolean mesh model body subtract union intersect combine carve exact approximate snapshot edit boolean re-run stl',
    contextKeys: ['modal:boolean-mesh'],
  },
  {
    id: 'provenance-badges',
    title: 'Edited, stale and approx badges',
    category: 'import-geometry',
    summary: 'Small badges and highlights on geometry rows tell you when a part or layer may no longer match where it came from.',
    keywords:
      'badge edited stale approx exact provenance source changed re-slice moved rotated section boolean open shell tooltip',
    contextKeys: ['workspace:cam'],
  },
]
