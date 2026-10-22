// The EAGER help index entries for this category (collected by
// src/help/index-data.ts). The help census asserts each one matches its
// topic in ./index.ts FIELD FOR FIELD - edit both together. One file per
// category, so help work on different categories never shares a file.

import type { HelpIndexEntry } from '../../types'

export const entries: HelpIndexEntry[] = [
  {
    id: 'generation-failures',
    title: 'Operation generation failures',
    category: 'cam-operations',
    summary: 'When an operation cannot make its toolpath, it keeps the reason and shows it on the operation instead of making a path.',
    keywords:
      'operation generation compute failed error degraded outdated reason toolpath geometry tool regenerate status reach stopped short badge summary',
    contextKeys: [
      'panel:properties:operation',
      'error:recent',
    ],
  },
  {
    id: 'creating-operations',
    title: 'Creating an operation',
    category: 'cam-operations',
    summary: 'The New Operation dialog takes you through type, tool, geometry, passes, heights, linking and feedrate on one set of tabs.',
    keywords:
      'new operation dialog wizard create edit double-click n shortcut tabs type tool geometry passes heights linking feedrate g regenerate regen all shank clearance earlier operations',
    contextKeys: [
      'modal:new-operation',
      'modal:edit-operation',
    ],
  },
  {
    id: 'operation-sources',
    title: 'What an operation cuts',
    category: 'cam-operations',
    summary: 'The Geometry tab is where you tell an operation what to cut: loops from a drawing, edges or faces of a model, holes, the stock, or a whole solid.',
    keywords:
      'geometry tab source part loops faces edges model body detect holes machining boundary select pick solid stock rest boundary source section faces to machine',
    contextKeys: ['modal:new-operation'],
  },
  {
    id: 'contour',
    title: '2D contour',
    category: 'cam-operations',
    summary: '2D Contour cuts along a profile at one or more depths, with four cutting strategies, open paths, holding tabs and ramped entry.',
    keywords:
      'contour profile cutting strategy roughing finish open contour path type tool position left right outside inside tabs holding tab ramp plunge spring pass overlap edit tab locations corner relief dogbone t-bone longest edge roughing style trochoidal channel width advance per orbit',
    contextKeys: ['selection:operation:contour_2d'],
  },
  {
    id: 'pocket',
    title: '2D pocket',
    category: 'cam-operations',
    summary: '2D Pocket clears a closed region in rings, leaves islands standing, enters by helix, ramp or plunge, and finishes the wall.',
    keywords:
      'pocket clear stepover helix entry profile ramp island floor stock to leave axial radial fill strategy outside-in inside-out stay down finish contour wall boundary source stock corner relief dogbone t-bone longest edge slot feed full width engagement slow feed rounded ring corners arc smooth',
    contextKeys: ['selection:operation:pocket_2d'],
  },
  {
    id: 'drill',
    title: 'Drilling',
    category: 'cam-operations',
    summary: 'Drill drills at the centre of each picked or detected hole, with four drilling cycles and a depth for every hole.',
    keywords:
      'drill hole detect holes peck chip break dwell g81 g82 g83 g73 canned cycle depth policy per-hole depth hole ordering nearest breakthrough peck decrement between-hole retract blind flat floor through point compensation explicit target end',
    contextKeys: ['selection:operation:drill'],
  },
  {
    id: 'bore',
    title: 'Bore milling',
    category: 'cam-operations',
    summary: 'Bore mills holes larger than the tool in circles, with roughing orbits, finish and spring passes, and a depth for each hole.',
    keywords:
      'bore boring circular mill helix hole enlarge orbit target diameter finish spring pass overlap depth policy step cylinder climb conventional pick face',
    contextKeys: ['selection:operation:bore'],
  },
  {
    id: 'thread-milling',
    title: 'Thread milling',
    category: 'cam-operations',
    summary: 'Thread Mill cuts internal or external threads with a helix, with size presets and a cylinder pick that fills in the thread for you.',
    keywords:
      'thread mill internal external helix pitch tpi major diameter preset metric unc unf boss cylinder pick face orbit climb handedness left-hand thread depth',
    contextKeys: ['selection:operation:thread_mill'],
  },
  {
    id: 'chamfer-op',
    title: '2D chamfer',
    category: 'cam-operations',
    summary: '2D Chamfer runs a V-bit or chamfer mill along closed profile edges and cuts a bevel to the depth you set.',
    keywords:
      'chamfer bevel v-bit tip angle tip offset width depth inside outside edge break deburr pick edges reference plane',
    contextKeys: ['selection:operation:chamfer'],
  },
  {
    id: 'engrave',
    title: 'Engraving',
    category: 'cam-operations',
    summary: 'Engrave rides the tool along open or closed curves, at a depth you set or at a depth worked out from a line width, flat or following a curved surface.',
    keywords:
      'engrave trace v-engrave text line width depth groove open path closed loop side offset lead arc follow the surface curved engraving depth confirm pick edges style trochoidal slot keyway slot width advance per orbit',
    contextKeys: ['selection:operation:engrave'],
  },
  {
    id: 'vcarve',
    title: 'V-carving',
    category: 'cam-operations',
    summary: 'V-carve follows the centre line of letters and shapes with a V-bit, going deeper where the outline is wide and rising to a sharp point at every corner.',
    keywords:
      'v-carve vcarve carve lettering sign v-bit centre line flat depth floor clearing separate end mill start depth allowance pick edges',
    contextKeys: ['selection:operation:vcarve'],
  },
  {
    id: 'pattern-op',
    title: 'Pattern',
    category: 'cam-operations',
    summary: 'Pattern cuts a decorative pattern, such as a rose spiral, a wave raster or a line moire, at a shallow depth below the stock top.',
    keywords:
      'pattern decorative engine turning guilloche rose spiral sine raster epitrochoid line moire curves formula copies polar array mirror region clip trim depth ball end mill shallow',
    contextKeys: ['selection:operation:pattern'],
  },
  {
    id: 'face-op',
    title: '2D facing',
    category: 'cam-operations',
    summary: '2D Face surfaces the top of the stock with passes that run past the edges so the cutter fully clears it.',
    keywords:
      'face facing surface stock top parallel passes zigzag one-way offset pass extension overrun boundary containment rest finished face model top smart bottom explicit wcs plane override',
    contextKeys: ['selection:operation:face'],
  },
  {
    id: 'adaptive-clearing',
    title: 'Adaptive clearing',
    category: 'cam-operations',
    summary: '2D Adaptive Clearing roughs a region while holding the side load on the tool near the value you set.',
    keywords:
      'adaptive clearing trochoidal high speed roughing optimal load engagement stepover helix minimum radius climb conventional tolerance floor finish pass boundary source stock',
    contextKeys: ['selection:operation:adaptive_clearing_2d'],
  },
  {
    id: 'adaptive-linking',
    title: 'Adaptive linking and stay-down',
    category: 'cam-operations',
    summary: 'The Stay-down options keep the adaptive cutter down between passes instead of retracting, moving over and plunging again.',
    keywords:
      'stay down linking wall follow retract plunge ride budget wall cleanup loopback final wall cleanup wall finish depth finish pass at final depth',
    contextKeys: ['selection:operation:adaptive_clearing_2d'],
  },
  {
    id: 'parallel-3d',
    title: '3D parallel finish',
    category: 'cam-operations',
    summary: 'Parallel Finish (3D) lays parallel passes over the surface of a solid part.',
    keywords:
      'parallel finish 3d raster surface ball nose bull nose v-bit stepover angle tolerance stock to leave depth limit clip to stock outline edge overrun fins modeled body faces to machine',
    contextKeys: ['selection:operation:parallel_3d'],
  },
  {
    id: 'waterline-3d',
    title: '3D waterline finish',
    category: 'cam-operations',
    summary: 'Waterline Finish (3D) follows the part at one height, steps down, and follows it again - a finish for steep walls.',
    keywords:
      'waterline finish 3d contour z level constant z stepdown steep walls steep areas only order region level climb conventional flat area detection stock to leave clip to stock outline',
    contextKeys: ['selection:operation:waterline_3d'],
  },
  {
    id: 'adaptive-3d',
    title: '3D adaptive roughing',
    category: 'cam-operations',
    summary: 'Adaptive Rough (3D) clears stock level by level with light adaptive passes, down to the shape of the part.',
    keywords:
      'adaptive rough 3d roughing stepdown stepover fraction engagement roughing scope clear all stock clear around part edge overshoot side entry helix level reduce stair steps grid material source',
    contextKeys: ['selection:operation:adaptive_3d'],
  },
  {
    id: 'scallop-3d',
    title: '3D constant scallop finish',
    category: 'cam-operations',
    summary: 'Scallop Finish (3D) spaces its passes along the surface to hold the Scallop height you set, so steep areas get passes closer together than flat ones.',
    keywords:
      'scallop constant cusp 3d finish stepover steep flat edge overrun clip to stock outline direction climb conventional scallop height',
    contextKeys: [
      'selection:operation:scallop_3d',
      'selection:operation:scallop_3d:scallop-height',
      'selection:operation:scallop_3d:tolerance',
      'selection:operation:scallop_3d:stock-to-leave',
      'selection:operation:scallop_3d:use-stock-boundary',
      'selection:operation:scallop_3d:finish-depth',
      'selection:operation:scallop_3d:direction',
      'selection:operation:scallop_3d:stock-edge-overshoot',
    ],
  },
  {
    id: 'steep-shallow-3d',
    title: '3D steep and shallow finish',
    category: 'cam-operations',
    summary: 'Steep and Shallow (3D) finishes a part in one operation: waterline levels on the steep walls, parallel passes on the flatter areas.',
    keywords:
      'steep and shallow 3d finish threshold angle waterline parallel steep stepdown shallow stepover pass angle one operation',
    contextKeys: ['modal:new-operation'],
  },
  {
    id: 'pencil-3d',
    title: '3D pencil cleanup',
    category: 'cam-operations',
    summary: 'Pencil Cleanup (3D) runs along the inside corners of a part to clean out the material a larger finishing tool could not reach.',
    keywords:
      'pencil cleanup 3d corner concave fillet rest ball nose bull nose inside corner',
    contextKeys: ['modal:new-operation'],
  },
  {
    id: 'feeds-speeds',
    title: 'Feeds and speeds hierarchy',
    category: 'cam-operations',
    summary: 'Operations take feeds and speeds from the tool library unless you override them for one operation, inside the machine\'s limits.',
    keywords:
      'feeds speeds feedrate spindle rpm override tool library defaults machine limit range fast traverse plunge ramp finish tool + feeds',
    contextKeys: ['modal:new-operation'],
  },
  {
    id: 'operation-folders',
    title: 'Operation folders and suppression',
    category: 'cam-operations',
    summary: 'Group operations into folders in the design tree, and suppress the ones you want skipped by regeneration, simulation and posting.',
    keywords:
      'operation folder group suppress unsuppress disable enable skip post simulation regen organize tree delete folder',
    contextKeys: ['workspace:cam'],
  },
  {
    id: 'cut-time',
    title: 'Cut-time estimates',
    category: 'cam-operations',
    summary: 'Every ready operation shows an estimated machine run time, and each setup adds up its switched-on operations.',
    keywords:
      'cut time estimate duration machine run time setup total nest copies feedrate acceleration',
    contextKeys: ['panel:properties:operation'],
  },
]
