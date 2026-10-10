// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'reference-image-calibration',
    title: 'Calibrating a reference image',
    category: 'sketching',
    summary: 'Calibrate a tracing picture to a real distance using two marks or a selected sketch line, then lock its scale and place it with X, Y, Angle, drag and flips.',
    keywords: 'reference image picture tracing underlay ruler calibrate distance scale lock unlock two points sketch line move rotate angle flip horizontal vertical center',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-entry',
    title: 'Starting a sketch',
    category: 'sketching',
    summary: 'The Sketch tab opens the Enter Sketch Mode chooser: start a new sketch, pick a part in the viewport, or choose an existing 2D layer to edit.',
    keywords:
      'sketch tab enter sketch mode chooser new sketch pick existing viewport edit layer lift dxf svg png jpg picture trace import export true size print template 1:1 paper orientation actual fit page overlap Letter Legal Tabloid A4 A3 threshold locked read-only stl projection block explode open',
    contextKeys: ['modal:sketch-entry', 'mode:sketch'],
  },
  {
    id: 'sketch-draw-tools',
    title: 'Drawing entities',
    category: 'sketching',
    summary: 'The Create section of the sketch toolbox holds every drawing tool: lines, rectangles, circles, ellipses, arcs, splines, a bezier, a conic arc, polygons, spur gears, slots, text and points.',
    keywords:
      'draw line rectangle center rect circle 3-pt ellipse elliptical arc spline control spline bezier conic rho tangent arc center arc polygon gear spur involute teeth module pressure angle root fillet slot arc slot point chain shortcut esc enter shift ortho 45 rotated tab prompt bar right-click menu copy paste typed length',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-text',
    title: 'Sketch text',
    category: 'sketching',
    summary: 'The Text tool (G) places engravable text with a choice of single-line and outline fonts, your own imported fonts, and optional placement along a curve.',
    keywords:
      'text font single-line outline hershey engrave import ttf otf cap height letter spacing tracking mirror on path attach detach flip side curve align left center right free position',
    contextKeys: ['mode:sketch', 'tool:sketch:text'],
  },
  {
    id: 'sketch-constraints',
    title: 'Constraints',
    category: 'sketching',
    summary: 'Fifteen constraint buttons lock geometric relationships - each lights up only when your selection fits it, and a constraint that would conflict is rejected by name instead of breaking the sketch.',
    keywords:
      'constraint coincident concentric parallel perpendicular collinear horizontal vertical tangent equal midpoint symmetric fix on object g1 g2 curvature continuity browser glyph badge show conflict reject',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-dimensions',
    title: 'Smart dimensions',
    category: 'sketching',
    summary: 'One Smart Dimension tool (D) reads what you click and makes the right dimension - length, angle, radius, diameter or distance - with driving and reference modes and typed equations.',
    keywords:
      'dimension smart dim length angle radius diameter arc length distance horizontal vertical aligned tab driving reference parentheses equation expression units mm in d shortcut double-click edit',
    contextKeys: ['mode:sketch', 'tool:sketch:smart-dimension'],
  },
  {
    id: 'sketch-definition-states',
    title: 'Under-defined, fully defined, conflicting',
    category: 'sketching',
    summary: 'Entity colors and the chip beside the Sketch title tell you how locked-down the sketch is: blue can still move, near-white is fully defined, and red is caught in a conflict.',
    keywords:
      'under-defined fully defined over-defined conflicting redundant blue red white amber cyan dof degrees of freedom not solved solve failed banner resolve review chip color',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-modify-tools',
    title: 'Trim, split, extend, offset, mirror, patterns, move',
    category: 'sketching',
    summary: 'The Modify section reshapes existing geometry: trim, split, extend, offset, mirror, linear, circular and path patterns, move, rotate, scale and delete.',
    keywords:
      'trim split extend offset mirror pattern linear circular path follow tangent move rotate scale keep original copy paste delete cascade modify t k e o m 1 2 3 v w x swipe',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-fillet-chamfer',
    title: 'Sketch fillet and chamfer',
    category: 'sketching',
    summary: 'Fillet (F) rounds corners with true tangent arcs and Chamfer (H) cuts them with a flat - both stage several corners with ghost previews and apply them all at once.',
    keywords:
      'fillet chamfer round corner radius setback equal distance two distances d1 d2 angle tangent arc ghost preview stage batch apply enter f h',
    contextKeys: ['mode:sketch', 'tool:sketch:fillet', 'tool:sketch:chamfer'],
  },
  {
    id: 'construction-geometry',
    title: 'Construction geometry',
    category: 'sketching',
    summary: 'Construction entities are layout lines: they draw dashed, take part in constraints and dimensions like any other geometry, and are never baked into cutting geometry.',
    keywords:
      'construction q toggle dashed layout guide centerline axis mirror convert never bakes reference geometry mode',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-snaps-inference',
    title: 'Snaps and inferred constraints',
    category: 'sketching',
    summary: 'Three snap toggles - Entity snaps, Grid snap and Inference - guide the cursor while drawing, and Inference turns snapped clicks into real constraints when you commit.',
    keywords:
      'snap entity grid inference alignment guide horizontal vertical shift ortho lock spacing endpoint midpoint center intersection automatic constraint utility',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-blocks',
    title: 'Blocks',
    category: 'sketching',
    summary: 'A block groups entities into one rigid object you place, scale and rotate as a unit - copies can share one definition, and Edit block changes the contents in place.',
    keywords:
      'block group explode edit block in place place another instance definition copy rigid scale rotation import locked dxf unit double-click',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'project-use',
    title: 'Project / Use',
    category: 'sketching',
    summary: 'The Project / Use tool copies a loop from another 2D layer into your sketch as fixed geometry you can dimension and constrain against.',
    keywords:
      'project use copy reference layer loop model face edge point static fixed construction linked follows model include external geometry references',
    contextKeys: ['mode:sketch', 'tool:sketch:project'],
  },
  {
    id: 'sketch-measure',
    title: 'The measure readout',
    category: 'sketching',
    summary: 'Measure (I) shows the size of what you select - lengths, radii, angles and spacing - without adding a dimension.',
    keywords:
      'measure readout i toggle inspect length radius diameter circumference arc length sweep angle spacing distance dx dy no dimension utility',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'finish-and-bake',
    title: 'Finishing a sketch',
    category: 'sketching',
    summary: 'Finish (at the top of the sketch tools) bakes the sketch onto its layer as cutting loops and keeps the sketch itself, so you can open it again later with everything intact.',
    keywords:
      'finish sketch cancel sketch bake loops contour hole close exit discard empty re-edit reopen layer tab',
    contextKeys: ['mode:sketch'],
  },
  {
    id: 'sketch-limits',
    title: 'Sketch size limits',
    category: 'sketching',
    summary: 'The constraint solver works in a fixed amount of memory: large sketches are solved piece by piece, and a single connected piece that is too big fails with an error instead of guessing.',
    keywords:
      'solver limit memory large sketch entities 150 partition connected piece fail block oom',
    contextKeys: ['mode:sketch'],
  },
]
