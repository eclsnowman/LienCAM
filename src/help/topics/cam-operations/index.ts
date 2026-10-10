import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'generation-failures',
    title: 'Operation generation failures',
    category: 'cam-operations',
    summary: 'When an operation cannot make its toolpath, it keeps the reason and shows it on the operation instead of making a path.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Look at the status icon on the operation row in the design tree: a green tick is ready, an amber clock needs recomputing, a red circle failed, and a red triangle means the model geometry it cut is gone. Hover the icon for the reason.',
          'Select the operation. The Summary group in the Properties panel shows its Status and, when it failed, the Error message. An outdated operation also gives its reason on the amber badge hover and in Summary Status, such as its tool changed or an earlier named operation changed after it was computed. Regenerate to update. The same error message is written to the console at the bottom of the screen.',
          'Fix what the message names, then click Regenerate in the Properties panel, click the play button on the row (Compute toolpath), or press G.',
          'A red triangle does not clear by regenerating. Open the operation with Edit operation and pick its geometry again.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'A collapsed setup or folder shows a badge when something inside it needs you: red for an error, an amber clock for an operation that needs recomputing.',
      },
      {
        kind: 'paragraph',
        text: 'When the tool cannot reach the full depth, the operation still makes its toolpath and says so: the row shows an amber arrow, and the Properties panel shows a Reach row marked Stopped short with the depth it reached and how much path was left uncut.',
      },
      { kind: 'image', slot: 'status-badges' },
    ],
    images: [
      {
        slot: 'status-badges',
        file: 'status-badges.webp',
        alt: 'Operation rows showing ready, outdated and error status icons',
        captureNotes: 'Design-tree crop with one ready, one outdated, one errored operation row.',
        status: 'done',
      },
    ],
    keywords: 'operation generation compute failed error degraded outdated reason toolpath geometry tool regenerate status reach stopped short badge summary',
    contextKeys: ['panel:properties:operation', 'error:recent'],
    relatedTopicIds: ['error-details', 'setup-wcs'],
    sinceVersion: '0.16.1',
  },
  {
    id: 'creating-operations',
    title: 'Creating an operation',
    category: 'cam-operations',
    summary: 'The New Operation dialog takes you through type, tool, geometry, passes, heights, linking and feedrate on one set of tabs.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'In the CAM workspace, click the + (Add operation) button on a setup row, or right-click the setup and choose Add operation, or select a setup and press N. An empty setup also shows an Add Operation button.',
          'On the Type & Name tab, click an operation card under Operation type. Type a name under Operation name, or leave it blank for the default name.',
          'Work through the tabs: Tool, Geometry, Passes, Heights, Linking and Feedrate. The six 3D operations, V-Carve and Thread Mill have no Linking tab.',
          'Click Create Operation. The toolpath starts computing straight away. If the button is greyed out, hover over it to see what is still missing, for example "Go to the Tool tab and select a tool first".',
          'To change an operation later, double-click its row, click its Edit operation button, or right-click it and choose Edit operation. The same dialog opens as Edit Operation, and its button reads Save & Recompute.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Press G to recompute the selected operation. Press Shift+G, or click REGEN ALL at the top of the design tree, to recompute every operation that is not suppressed.',
      },
      {
        kind: 'paragraph',
        text: 'Each operation cuts from the material that the earlier operations in its setup left, counting only operations that are switched on. When an earlier operation is changed, moved or suppressed, the operations after it are marked for recomputing.',
      },
      {
        kind: 'tip',
        text: 'The Feedrate tab already reads the feeds and speeds saved with the tool in the Tool Library. The Passes tab of the 2D and hole operations also has Shank clearance under Tool assembly: the gap kept between the neck, shank or holder and the part or remaining stock.',
      },
      { kind: 'image', slot: 'wizard' },
    ],
    images: [
      {
        slot: 'wizard',
        file: 'wizard.webp',
        alt: 'The New Operation dialog on the Type & Name tab with the operation type cards',
        captureNotes: 'New Operation dialog open on the Type & Name tab, the full grid of 16 type cards visible, 2D Pocket selected, tab strip along the top in frame.',
        status: 'done',
      },
    ],
    keywords: 'new operation dialog wizard create edit double-click n shortcut tabs type tool geometry passes heights linking feedrate g regenerate regen all shank clearance earlier operations',
    contextKeys: ['modal:new-operation', 'modal:edit-operation'],
    relatedTopicIds: ['operation-sources', 'generation-failures', 'feeds-speeds'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'operation-sources',
    title: 'What an operation cuts',
    category: 'cam-operations',
    summary: 'The Geometry tab is where you tell an operation what to cut: loops from a drawing, edges or faces of a model, holes, the stock, or a whole solid.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Every operation reads what it cuts from the Geometry tab of the operation dialog. What the tab offers depends on the operation and on the part you choose.',
      },
      {
        kind: 'steps',
        steps: [
          'Choose the part from the list, or click Pick source part in viewport and click it. All Parts combines the loops of every part.',
          'Under Loops to machine, click All loops, tick loops in the list, or click Pick from viewport and click loops in the 3D view. The dialog stays open while you pick; click Done, or press Esc, when you have them.',
          'For a STEP model or a body built in the Model workspace, the From 3D model buttons pick straight from the part, for example Pick edges (a chain of model edges), Pick face (a hole or boss wall), Section at Z (the outline at one height), and, for Drill, Detect holes.',
          '2D Pocket and 2D Adaptive Clearing can clear the whole stock instead: set Boundary source to Stock. 2D Face offers Stock, Contour, or Rest (only what earlier pocket operations left behind).',
          'For a modeled body, 2D Face, 2D Contour, 2D Pocket and 2D Adaptive Clearing also show Machining boundary: click Pick face on model and that face outline limits where the operation cuts.',
          'The 3D operations take a whole solid under Source solid: an STL, a STEP model, or a body modeled in the Model workspace. The 3D finishes can also be limited to chosen faces of a STEP part under Faces to machine.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'With Boundary source set to Stock and a STEP model in the project, 2D Pocket and 2D Adaptive Clearing show a green Auto from 3D model chip for what the software worked out from the model. Click Set manually to choose it yourself.',
      },
      {
        kind: 'tip',
        text: 'If Create Operation is greyed out, hover over it: it names the missing pick.',
      },
      { kind: 'image', slot: 'source-picker' },
      { kind: 'image', slot: 'loop-pick-highlight' },
    ],
    images: [
      {
        slot: 'source-picker',
        file: 'source-picker.webp',
        alt: 'The Geometry tab of a 2D Pocket with the part list and the Loops to machine list',
        captureNotes: 'New Operation dialog on the Geometry tab for a 2D Pocket: Boundary source, the part chosen in the list, Loops to machine with its All loops / Clear selection / Pick from viewport buttons and the ticked loop list.',
        status: 'done',
      },
      {
        slot: 'loop-pick-highlight',
        file: 'loop-pick-highlight.webp',
        alt: 'Pick-from-viewport mode with one loop selected and another hover-highlighted under the cursor',
        captureNotes: 'Affordance shot: loop pick-from-viewport ARMED - one loop selected, the cursor over another showing the live hover tint, the operation dialog still open beside the view.',
        status: 'needed',
      },
    ],
    keywords: 'geometry tab source part loops faces edges model body detect holes machining boundary select pick solid stock rest boundary source section faces to machine',
    contextKeys: ['modal:new-operation'],
    relatedTopicIds: ['creating-operations', 'drill', 'parallel-3d'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'contour',
    title: '2D contour',
    category: 'cam-operations',
    summary: '2D Contour cuts along a profile at one or more depths, with four cutting strategies, open paths, holding tabs and ramped entry.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the profile loops. Under Tool position choose Outside profile or Inside profile, and choose the Milling direction (Climb or Conventional).',
          'For a line that does not close, set Path type to Open contour and choose Left of drawn path or Right of drawn path. An open contour runs its ends out past the stock, so it starts and ends outside the material.',
          'On the Passes tab, set the Stepdown and pick a Cutting strategy: Cut at the geometry (no roughing), Roughing only (leave stock on the wall), Rough + finish each stepdown, or Rough + finish at final depth. The roughing choices show Stock to Leave - Radial and Axial; the two Rough + finish choices also show Finish passes.',
          'On the Linking tab, choose Plunge or Ramp (linear) and the Ramp angle. An open contour always plunges, outside the stock.',
          'To keep the part attached, tick Hold the part with tabs on the Linking tab and set Tab width, Tab height, Tab count and Tab shape (Box or Triangular (ramped)). Tab height is measured up from the stock bottom.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Passes > Advanced has Spring passes, Contour overlap and, for a closed contour, Corner relief. On the Heights tab, click the Top Height or Bottom Height row open to reach Target End, which sets where the cut stops; a flat drawn profile cuts down to the stock bottom. Passes that would only cut air that earlier operations already removed are left out.',
      },
      {
        kind: 'paragraph',
        text: 'A closed contour with roughing has a Roughing style: Offset (one loop per stepdown, the default) or Trochoidal, which cuts a channel wider than the tool in overlapping orbits so a deep stepdown takes a light side load. Trochoidal shows Channel width (1.15 to 2.5 x the tool diameter) and Advance per orbit; tabs, entry, stock to leave and the finish pass work as with Offset, and a hole too small for the channel is roughed with Offset.',
      },
      {
        kind: 'paragraph',
        text: 'The operation refuses tabs with Roughing only, triangular tabs narrower than twice their height, and tabs when the setup has no stock.',
      },
      {
        kind: 'table',
        columns: ['Corner relief', 'What it cuts'],
        rows: [
          { cells: ['None', 'Nothing: the inside corners keep the rounded fillet a round cutter leaves, with a radius equal to the tool radius (the default).'] },
          { cells: ['Dogbone', 'Out along the bisector of each inside corner until the cutter just touches the corner point.'] },
          { cells: ['T-bone', 'Along the corner edge nearer parallel to X until the cutter just touches the corner point.'] },
          { cells: ['Longest edge', 'Like T-bone, along the longer corner edge.'] },
        ],
      },
      {
        kind: 'paragraph',
        text: 'The relief is sized to the tool of this operation and runs after the profile at the same stepdowns, so a square tenon or slot-together part seats fully: rough with a big tool and no relief, then finish with the small tool and relief on.',
      },
      {
        kind: 'tip',
        text: 'Tabs can be placed by hand. After the toolpath is computed, select the operation and click Edit tab locations in the Properties panel: click the contour to add a tab, drag a tab to slide it, double-click a tab to remove it, then click Done placing tabs or press Esc. Reset to even spacing puts them back.',
      },
      { kind: 'image', slot: 'toolpath' },
    ],
    images: [
      {
        slot: 'toolpath',
        file: 'toolpath.webp',
        alt: 'A contour toolpath around a part, with ramp entries and rapid moves shown in the legend colours',
        captureNotes: 'Toolpath view of a closed 2D Contour: the profile passes at each depth, ramp entry visible, the toolpath legend in frame.',
        status: 'done',
      },
    ],
    keywords: 'contour profile cutting strategy roughing finish open contour path type tool position left right outside inside tabs holding tab ramp plunge spring pass overlap edit tab locations corner relief dogbone t-bone longest edge roughing style trochoidal channel width advance per orbit',
    contextKeys: ['selection:operation:contour_2d'],
    relatedTopicIds: ['creating-operations', 'pocket', 'chamfer-op'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'pocket',
    title: '2D pocket',
    category: 'cam-operations',
    summary: '2D Pocket clears a closed region in rings, leaves islands standing, enters by helix, ramp or plunge, and finishes the wall.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, set Boundary source: Selected geometry (pick the pocket loops) or Stock (clear the whole stock footprint). Loops inside the boundary are islands and are left standing.',
          'On the Passes tab, set the Stepdown and the Stepover. The Stepover is a length and starts at 35% of the tool diameter.',
          'Stock to Leave - Radial is for the walls and Stock to Leave - Axial for the floor. With Finish contour pass on pocket wall ticked, the walls are cut to size at the end; untick it to leave the radial stock standing. An axial value makes the last clearing level cut the floor to size on its own.',
          'Under Advanced, choose the Fill strategy (Outside-in or Inside-out), Ring overlap, Stepover lead-in (Direct or Arc), Rounded ring corners, Multiple pocket order (By region or By depth), Corner relief, and the wall finish with its Finish passes and Spring passes.',
          'On the Linking tab, choose the entry. With Inside-out it is Helix or Plunge; with Outside-in it is Profile Ramp or Plunge. Set the Helix diameter (% of tool diameter), the Ramp angle, and Helix start above material - how far above the remaining material the helix starts.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Stay down to finish contour, under Advanced with the wall finish, lifts the tool only by the Stay-down lift and ramps into the finishing contour instead of retracting. Switching the Fill strategy turns it on for Outside-in and off for Inside-out. Passes that would only cut air that earlier operations already removed are left out.',
      },
      {
        kind: 'paragraph',
        text: 'Slot feed, under Advanced, is the feed where the cutter cuts full width, as a percent of the cutting feed: the first ring into fresh stock runs at it, and wherever a later ring cuts wider than the stepover (into an inside corner, beside an island) the feed eases down toward it and back up as the cut narrows. 100% keeps every cut at the cutting feed; the posted program, the cut time and the simulation all use the slower feeds.',
      },
      {
        kind: 'paragraph',
        text: 'Rounded ring corners, under Advanced, takes the corners of each clearing ring as arcs instead of points, so the machine keeps its speed through them; the ring outside already cuts what the arc skips, so the floor and walls come out the same. The wall ring keeps its corners, and so does any corner where the next ring out does not reach.',
      },
      {
        kind: 'table',
        columns: ['Corner relief', 'What it cuts'],
        rows: [
          { cells: ['None', 'Nothing: the inside corners of the wall and of an L-shaped island keep the rounded fillet a round cutter leaves, with a radius equal to the tool radius (the default).'] },
          { cells: ['Dogbone', 'Out along the bisector of each inside corner until the cutter just touches the corner point.'] },
          { cells: ['T-bone', 'Along the corner edge nearer parallel to X until the cutter just touches the corner point.'] },
          { cells: ['Longest edge', 'Like T-bone, along the longer corner edge.'] },
        ],
      },
      { kind: 'image', slot: 'toolpath' },
    ],
    images: [
      {
        slot: 'toolpath',
        file: 'toolpath.webp',
        alt: 'A pocket toolpath with rings wrapping around an island',
        captureNotes: 'Toolpath view of a 2D Pocket with one island: rings around the island, helix entry mark, island untouched.',
        status: 'done',
      },
    ],
    keywords: 'pocket clear stepover helix entry profile ramp island floor stock to leave axial radial fill strategy outside-in inside-out stay down finish contour wall boundary source stock corner relief dogbone t-bone longest edge slot feed full width engagement slow feed rounded ring corners arc smooth',
    contextKeys: ['selection:operation:pocket_2d'],
    relatedTopicIds: ['adaptive-clearing', 'contour', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'drill',
    title: 'Drilling',
    category: 'cam-operations',
    summary: 'Drill drills at the centre of each picked or detected hole, with four drilling cycles and a depth for every hole.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, tick hole loops under Loops to machine (a closed loop is drilled at its centre). For a STEP model or a modeled body, click Detect holes under From 3D model, or Pick face and click the hole walls.',
          'On the Passes tab, under Drilling cycle, pick Simple (G81), Peck (G83), Chip break (G73) or Dwell (G82), and set the Peck depth, Chip-break retract or Dwell time the cycle uses.',
          'Under Advanced, set Hole ordering: Nearest neighbour, By X, By Y, or As selected.',
          'On the Heights tab, click the Top Height or Bottom Height row open to reach Depth policy. Detected physical floors (recommended) takes each hole\'s floor from the model. A detected blind floor gets no extra drill-point depth; a through hole keeps point compensation and Breakthrough past floor. Explicit Material Start and Target End uses the two WCS heights you type; typing a WCS height into the Top Height or Bottom Height row also switches to it.',
          'On the Linking tab, Between-hole retract chooses Clearance height or Retract height for the moves between holes.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'With Break through off, the drill tip stops at a detected blind flat floor; the cone above the tip remains above that floor. Break through remains your setting. If the hole cannot be identified as blind or through, the existing point compensation is kept. An explicit Target End remains the tip height; with Break through on, point length is added so the full diameter clears that end.',
      },
      {
        kind: 'paragraph',
        text: 'The Per-hole depths table on the Passes tab lists every hole. Type a bottom Z to change one hole, or leave it on auto to keep its depth. Click #1, #2 and so on to highlight that hole in the view.',
      },
      {
        kind: 'paragraph',
        text: 'Circles from a DXF, SVG or sketch have no floor to detect. With Detected physical floors, the operation refuses them by name and asks for explicit Material Start and Target End - set Depth policy to that.',
      },
      {
        kind: 'paragraph',
        text: 'Posts that support canned cycles get G81, G82 and G83 blocks. Chip break, and pecks that shrink, are written out as plain moves. In the Properties panel, Peck decrement makes each peck shorter than the one before, down to Min peck depth.',
      },
      { kind: 'image', slot: 'hole-table' },
    ],
    images: [
      {
        slot: 'hole-table',
        file: 'hole-table.webp',
        alt: 'The Drill Passes tab with the drilling cycle buttons and the per-hole depth table',
        captureNotes: 'Passes tab of a Drill operation with several holes listed in Per-hole depths, the Drilling cycle buttons above.',
        status: 'done',
      },
    ],
    keywords: 'drill hole detect holes peck chip break dwell g81 g82 g83 g73 canned cycle depth policy per-hole depth hole ordering nearest breakthrough peck decrement between-hole retract blind flat floor through point compensation explicit target end',
    contextKeys: ['selection:operation:drill'],
    relatedTopicIds: ['thread-milling', 'operation-sources', 'creating-operations'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'bore',
    title: 'Bore milling',
    category: 'cam-operations',
    summary: 'Bore mills holes larger than the tool in circles, with roughing orbits, finish and spring passes, and a depth for each hole.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, tick circular loops, or for a STEP model or modeled body click Pick face and click the inside wall of each hole. Each hole is bored on its own.',
          'On the Passes tab, under Bore milling, leave Target diameter on auto to bore each hole at its own size, or type one size for every hole. It cannot be larger than any picked hole.',
          'Set Maximum stepdown and Radial stepover, then Radial stock to leave, Finish passes, Spring passes and Overlap (how far each circle runs past its seam).',
          'Choose the Milling direction (Climb or Conventional) and the Bore ordering: Nearest neighbor, By X, By Y, or As selected.',
          'On the Heights tab, the Top Height and Bottom Height rows open to the same Depth policy as Drill: detected floors from the model, or explicit WCS heights. Circles from a drawing need the explicit choice.',
          'On the Linking tab, choose the Entry type (Helix or Plunge) and the Ramp angle.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The operation refuses, and names the hole, when a hole is too small for the tool, when the Target diameter is larger than a picked hole, when a loop is not round enough, when a picked cylinder is a boss instead of a hole, and when the tool is a drill, V-bit or ball mill.',
      },
      { kind: 'image', slot: 'bore-passes' },
    ],
    images: [
      {
        slot: 'bore-passes',
        file: 'bore-passes.webp',
        alt: 'The Bore Passes tab with target diameter, stepdown, stepover and finish pass fields',
        captureNotes: 'Passes tab of a Bore operation: Bore milling section with Target diameter on auto, stepdown and stepover fields, and the milling-direction buttons in frame.',
        status: 'done',
      },
    ],
    keywords: 'bore boring circular mill helix hole enlarge orbit target diameter finish spring pass overlap depth policy step cylinder climb conventional pick face',
    contextKeys: ['selection:operation:bore'],
    relatedTopicIds: ['drill', 'thread-milling', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'thread-milling',
    title: 'Thread milling',
    category: 'cam-operations',
    summary: 'Thread Mill cuts internal or external threads with a helix, with size presets and a cylinder pick that fills in the thread for you.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Pick the hole or boss. On a STEP model or a modeled body, click Pick face and click the cylinder wall: the operation reads whether it is a hole or a boss, sets the nearest standard thread size, and takes the top and the thread depth from the cylinder. A 2D circle also works; then set the Thread kind (Internal or External) yourself.',
          'On the Passes tab, pick a Thread size preset (metric coarse M3 to M24 and common UNC and UNF sizes), or leave it on Custom and type the Major diameter and Pitch, or TPI.',
          'Set the Radial stepover and Spring passes. Advanced holds Handedness (Right-hand or Left-hand), Lead in / out, and Cut direction (Climb or Conventional).',
          'On the Heights tab, click the Top Height or Bottom Height row open to set the thread datum and the Thread depth. For a picked boss, Thread reference chooses Top of cylinder (down) or Base (up).',
        ],
      },
      {
        kind: 'paragraph',
        text: 'There is no Z stepdown and no Linking tab. Each pass is one continuous helix that moves one pitch per turn over the full thread depth. An internal thread steps its orbit outward pass by pass, and an external thread steps inward. An internal thread is milled in a hole that is already there: the operation checks the hole diameter, not its depth.',
      },
      {
        kind: 'paragraph',
        text: 'The operation refuses by name when the tool is too large for the major diameter, when the tool does not fit the hole, and when the hole is already as large as the thread.',
      },
      { kind: 'image', slot: 'helix' },
    ],
    images: [
      {
        slot: 'helix',
        file: 'helix.webp',
        alt: 'A thread milling helix toolpath inside a hole',
        captureNotes: 'Toolpath view of an internal Thread Mill: helical path visible inside a hole, several radial passes distinguishable. Toolpath only - no dialog beside it.',
        status: 'done',
      },
    ],
    keywords: 'thread mill internal external helix pitch tpi major diameter preset metric unc unf boss cylinder pick face orbit climb handedness left-hand thread depth',
    contextKeys: ['selection:operation:thread_mill'],
    relatedTopicIds: ['drill', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'chamfer-op',
    title: '2D chamfer',
    category: 'cam-operations',
    summary: '2D Chamfer runs a V-bit or chamfer mill along closed profile edges and cuts a bevel to the depth you set.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Choose a tool with a tip angle (a V-bit or chamfer mill). If the tool has no angle, the operation refuses and asks you to set it in the Tool Library.',
          'On the Geometry tab, pick the closed loops, or on a modeled body click Pick edges and pick a closed loop of edges. Set each loop to Outside or Inside (holes start as Inside), and choose the Milling direction.',
          'On the Passes tab, set the Chamfer width: the depth of the chamfer below the reference plane. Tip offset takes the tool deeper so it cuts higher up the flute, and moves the path out so the bevel stays the same size.',
          'The line under the fields shows the tool angle, the depth and the total Z drop.',
          'On the Heights tab, click the Top Height or Bottom Height row open: Reference plane sets where the depth is measured from. On the Linking tab, choose Plunge or Ramp (linear).',
        ],
      },
      { kind: 'image', slot: 'result' },
    ],
    images: [
      {
        slot: 'result',
        file: 'result.webp',
        alt: 'The 2D Chamfer Passes tab with Chamfer width, Tip offset and the angle, depth and total Z drop line',
        captureNotes: 'Passes tab of a 2D Chamfer with a 90 deg V-bit: Chamfer width, Tip offset, and the line under them showing the included angle, the depth and the total Z drop.',
        status: 'done',
      },
    ],
    keywords: 'chamfer bevel v-bit tip angle tip offset width depth inside outside edge break deburr pick edges reference plane',
    contextKeys: ['selection:operation:chamfer'],
    relatedTopicIds: ['contour', 'engrave', 'creating-operations'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'engrave',
    title: 'Engraving',
    category: 'cam-operations',
    summary: 'Engrave rides the tool along open or closed curves, at a depth you set or at a depth worked out from a line width, flat or following a curved surface.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Pick the curves to follow. Open paths (such as single-stroke text) and closed loops both work. On a modeled body, click Pick edges to follow model edges. Curves to follow, under Advanced on the Passes tab, sets whether Open paths, Closed loops or both are cut.',
          'On the Passes tab, choose the Mode: V-engrave or Trace.',
          'In V-engrave, click Depth from line width and type the Target line width: the depth is worked out from the tool tip angle. Otherwise the depth is the Engraving depth on the Heights tab.',
          'On the Heights tab, click the Top Height or Bottom Height row open and enter the Engraving depth. That is the depth the operation uses; Create Operation becomes available once the height preview resolves. Choose Flat depth, or Follow the surface to cut the same depth below a curved part surface.',
          'Stepdown splits the depth into passes, and Axial offset moves the cut up or down.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Advanced also has the tool position (On the line, Left or Right, with a Side offset), the direction (As drawn, Climb or Conventional), and Lead-in radius and Lead-out radius. With Follow the surface, a path that runs off the part stays at the last surface height there.',
      },
      {
        kind: 'paragraph',
        text: 'Trace with the tool on the line has a Style: Plain (one pass along the line, the default) or Trochoidal, which cuts a slot wider than the tool, centred on the line, in overlapping orbits so a deep slot or keyway takes a light side load. Trochoidal shows Slot width (1.15 to 2.5 x the tool diameter) and Advance per orbit. The slot along an open line ends round at the end points of the line, around a closed loop it closes with no ridge, and a curve too short for one orbit is cut Plain.',
      },
      { kind: 'image', slot: 'result' },
    ],
    images: [
      {
        slot: 'result',
        file: 'result.webp',
        alt: 'V-engraved text toolpath following sketch text curves',
        captureNotes: 'Toolpath view of an Engrave over sketch text, with the Passes tab open showing the depth-from-line-width summary.',
        status: 'needed',
      },
    ],
    keywords: 'engrave trace v-engrave text line width depth groove open path closed loop side offset lead arc follow the surface curved engraving depth confirm pick edges style trochoidal slot keyway slot width advance per orbit',
    contextKeys: ['selection:operation:engrave'],
    relatedTopicIds: ['chamfer-op', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'vcarve',
    title: 'V-carving',
    category: 'cam-operations',
    summary: 'V-carve follows the centre line of letters and shapes with a V-bit, going deeper where the outline is wide and rising to a sharp point at every corner.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Pick the closed outlines to carve: outline text, logos, shapes from a DXF or SVG, or on a modeled body click Pick edges and pick a closed chain of edges. Letter counters (the hole in an O) are handled for you; a rectangle drawn around text carves the field and leaves the letters standing. Overlapping outlines are joined.',
          'Choose a V-Bit / Chamfer or Chamfer Mill tool on the Tool tab. Its tip angle sets how depth follows width: the wider the outline at a point, the deeper the bit goes.',
          'On the Passes tab, choose the Carve depth. "Bit\'s own limit" carves as deep as the bit reaches at its full diameter, or its flute length if that is shorter. "Flat depth" stops at a depth you set and clears the wider areas as a flat floor.',
          'Under Flat areas, choose who clears the flat floors: Clear with this bit (Floor stepover sets the spacing), Separate end mill (pick it under Clearing tool; a second operation named after the carve, ending in "- flat clearing", is made and kept just before it), or Leave floors.',
          'Start depth carves below the surface, for carving inside a pocket. Allowance, under Outline, grows or shrinks the outlines. Stepdown splits a deep carve into passes (0 is one pass). Tolerance sets how closely the path follows the outline.',
        ],
      },
      { kind: 'image', slot: 'passes' },
      {
        kind: 'paragraph',
        text: 'V-Carve has no Linking tab. It refuses by name when the tool has no usable tip angle, and when a Flat depth is deeper than the bit can cut.',
      },
      { kind: 'image', slot: 'result' },
    ],
    images: [
      {
        slot: 'result',
        file: 'result.webp',
        alt: 'Toolpath tab with example 05 name sign open: V-carve 1 selected, its path drawn over the sign lettering, and Properties showing type vcarve, status ready, tool 6 mm 60 deg V-bit',
        captureNotes: 'Toolpath view of a V-carve over outline text (examples/05-name-sign, V-carve 1 selected, whole frame). WO-2710.',
        status: 'done',
      },
      {
        slot: 'passes',
        file: 'passes.webp',
        alt: 'Edit Operation dialog on the Passes tab of a V-carve: Carve depth set to Flat depth 1 mm, Start depth 0, Stepdown 0.5 mm, Flat areas set to Clear with this bit with Floor stepover 0.3 mm, Allowance 0, Tolerance 0.01 mm, Shank clearance 0.25 mm',
        captureNotes: 'Edit Operation dialog crop, Passes tab of V-carve 1 in examples/05-name-sign. WO-2710.',
        status: 'done',
      },
    ],
    keywords: 'v-carve vcarve carve lettering sign v-bit centre line flat depth floor clearing separate end mill start depth allowance pick edges',
    contextKeys: ['selection:operation:vcarve'],
    relatedTopicIds: ['engrave', 'chamfer-op', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'face-op',
    title: '2D facing',
    category: 'cam-operations',
    summary: '2D Face surfaces the top of the stock with passes that run past the edges so the cutter fully clears it.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, set Boundary source: Stock faces the whole stock top with no pick, Contour faces inside a loop you pick, and Rest faces only what earlier pocket operations left behind.',
          'On the Passes tab, pick the Strategy: Zigzag, One-way climb, One-way conv., or Offset (rings from the outside in). Set the Stepover (it starts at 70% of the tool diameter) and the Stepdown for more than one level.',
          'Under Advanced, set Pass extension (how far each pass runs past the edge; auto is half the tool diameter), Pass angle, Stock offset, Boundary containment (Outside, Centre or Inside the boundary), and Alternate direction each level (on at first).',
          'On the Heights tab, Finished face starts at Model top (recommended) when the setup stock holds a model. You can choose Selected model face (click Pick finished face in workspace) or Explicit WCS plane (type the Z) instead. Without a model top, choose a finished face or type the plane before creating the operation.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'In Properties, the Model top row shows the smart bottom in WCS units. Typing a Z replaces it with your own plane; Use model top restores the smart choice. The bottom follows the model top, so facing removes the stock above the part rather than cutting down to the stock bottom.',
      },
      {
        kind: 'paragraph',
        text: 'Stock to Leave - Axial stops the upper levels short of the face; the last level still cuts to the finished face. Rest cannot be combined with the Offset strategy.',
      },
      { kind: 'image', slot: 'toolpath' },
    ],
    images: [
      {
        slot: 'toolpath',
        file: 'toolpath.webp',
        alt: 'A facing toolpath of parallel passes running past the stock edges',
        captureNotes: 'Toolpath view of a 2D Face over rectangular stock: parallel zigzag passes, the run past both edges clearly visible.',
        status: 'done',
      },
    ],
    keywords: 'face facing surface stock top parallel passes zigzag one-way offset pass extension overrun boundary containment rest finished face model top smart bottom explicit wcs plane override',
    contextKeys: ['selection:operation:face'],
    relatedTopicIds: ['pocket', 'creating-operations'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'adaptive-clearing',
    title: 'Adaptive clearing',
    category: 'cam-operations',
    summary: '2D Adaptive Clearing roughs a region while holding the side load on the tool near the value you set.',
    sections: [
      {
        kind: 'paragraph',
        text: 'A pocket follows fixed rings. Adaptive clearing steers the path instead, so the width of cut stays near the Optimal load in corners and slots too.',
      },
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, set Boundary source: Selected geometry (pick the loops, or on a modeled body click Pick edges) or Stock. Choose the Milling direction; a new adaptive starts on Conventional.',
          'On the Passes tab, set the Optimal load (stepover) - a length that starts at 25% of the tool diameter - the Tolerance, and the Maximum stepdown. The path is cut again at each level down to the bottom.',
          'Set Stock to Leave - Radial and Axial for later finishing. With an axial stock to leave, Floor finish pass runs the clearing once more at the true floor at the finish feed; with no axial stock it does nothing.',
          'On the Linking tab, choose the Entry type (Helix or Plunge), then the Helix diameter (% of tool diameter), the Ramp angle and the Minimum helix radius. Where a helix would have to be smaller than that, the tool plunges instead.',
        ],
      },
      {
        kind: 'tip',
        text: 'The Tolerance field trades path accuracy against compute time.',
      },
      { kind: 'image', slot: 'engagement' },
    ],
    images: [
      {
        slot: 'engagement',
        file: 'engagement.webp',
        alt: 'An adaptive clearing toolpath filling around an island',
        captureNotes: 'Toolpath view of a 2D Adaptive Clearing on a pocket with an island: the adaptive fill, helix entry, the island left standing.',
        status: 'done',
      },
    ],
    keywords: 'adaptive clearing trochoidal high speed roughing optimal load engagement stepover helix minimum radius climb conventional tolerance floor finish pass boundary source stock',
    contextKeys: ['selection:operation:adaptive_clearing_2d'],
    relatedTopicIds: ['adaptive-linking', 'pocket', 'adaptive-3d'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'adaptive-linking',
    title: 'Adaptive linking and stay-down',
    category: 'cam-operations',
    summary: 'The Stay-down options keep the adaptive cutter down between passes instead of retracting, moving over and plunging again.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Stay-down section of the Linking tab replaces retract-and-plunge moves with rides along a wall that is already cut. The tool rides only when both ends of the move are on the same wall and the ride is short enough; otherwise it lifts.',
      },
      {
        kind: 'steps',
        steps: [
          'Integral wall-follow (on at first) rides the wall at depth instead of retracting.',
          'Maximum direct wall ride sets how long that ride may be, as a percent of the straight-line distance (200% at first).',
          'Wall cleanup as we go (integrated finishing) rides the wall out of each pass and back into the next, cleaning the wall every pass. Loopback fillet (% of tool radius) sets how tight the turn-arounds are.',
          'Final wall cleanup contours the walls and islands at the end. Wall finish depth chooses At final depth (leaves stock to leave standing), At each stepdown (leaves stock to leave standing), or Finish pass at final depth (cuts to size). Wall finish lead-in radius and lead-out radius add arcs on and off the wall.',
        ],
      },
      { kind: 'image', slot: 'links' },
    ],
    images: [
      {
        slot: 'links',
        file: 'links.webp',
        alt: 'Adaptive link moves riding a cleared wall between passes instead of retracting',
        captureNotes: 'Toolpath view zoomed on a region change with Integral wall-follow on: the link move visibly follows the wall at depth, next to a lifted rapid elsewhere.',
        status: 'done',
      },
    ],
    keywords: 'stay down linking wall follow retract plunge ride budget wall cleanup loopback final wall cleanup wall finish depth finish pass at final depth',
    contextKeys: ['selection:operation:adaptive_clearing_2d'],
    relatedTopicIds: ['adaptive-clearing', 'pocket'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'parallel-3d',
    title: '3D parallel finish',
    category: 'cam-operations',
    summary: 'Parallel Finish (3D) lays parallel passes over the surface of a solid part.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the part under Source solid: an STL, a STEP model, or a body modeled in the Model workspace. On a STEP part, Faces to machine can limit the finish to faces you pick.',
          'Use a flat, ball or bull-nose end mill, or a V-bit. Create Operation stays greyed out for other cutters.',
          'On the Passes tab, set the Stepover between passes, the Pass angle across the part, and the Tolerance.',
          'If you need to, set Surface-normal stock to leave for a later pass, a Finish depth limit below the model top (blank finishes the full surface), and Clip to stock outline.',
        ],
      },
      { kind: 'image', slot: 'passes' },
      {
        kind: 'paragraph',
        text: 'Clip to stock outline chooses the outline that holds the passes: the stock outline when ticked, the rectangle around the part when not. The tool may travel anywhere inside it, and cuts only where there is part to cut. Edge overrun lets the round cutter finish the edge instead of stopping with its centre on it: auto is the tool radius, and 0 leaves one radius of material standing as thin fins.',
      },
      {
        kind: 'paragraph',
        text: 'The passes follow the surface, so there is no Linking tab and no stepdown. The Heights tab takes the top and bottom from the part; Clearance, Retract and Feed come from the setup and, when the stock is known, are measured from the stock top.',
      },
      { kind: 'image', slot: 'draped' },
    ],
    images: [
      {
        slot: 'draped',
        file: 'draped.webp',
        alt: 'Toolpath tab with example 06 knob and handwheel open: 3D Finish 2 selected, its parallel passes laid over the top and sides of the knob, and Properties showing type parallel 3d, status ready, tool 3 mm ball end mill',
        captureNotes: 'Toolpath view of a Parallel Finish (3D) over a curved part (examples/06-knob-handwheel, 3D Finish 2 selected, whole frame). WO-2710.',
        status: 'done',
      },
      {
        slot: 'passes',
        file: 'passes.webp',
        alt: 'Edit Operation dialog on the Passes tab of a 3D parallel finish: Stepover 0.2 mm, Pass angle 0, Tolerance 0.05 mm, Surface-normal stock to leave 0, Finish depth limit 16.5 mm, Clip to stock outline ticked, Edge overrun auto',
        captureNotes: 'Edit Operation dialog crop, Passes tab of 3D Finish 2 in examples/06-knob-handwheel. WO-2710.',
        status: 'done',
      },
    ],
    keywords: 'parallel finish 3d raster surface ball nose bull nose v-bit stepover angle tolerance stock to leave depth limit clip to stock outline edge overrun fins modeled body faces to machine',
    contextKeys: ['selection:operation:parallel_3d'],
    relatedTopicIds: ['adaptive-3d', 'waterline-3d', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'waterline-3d',
    title: '3D waterline finish',
    category: 'cam-operations',
    summary: 'Waterline Finish (3D) follows the part at one height, steps down, and follows it again - a finish for steep walls.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the part under Source solid: an STL, a STEP model, or a body modeled in the Model workspace. On a STEP part, Faces to machine can limit it to faces you pick.',
          'Use a flat, ball or bull-nose end mill. The Stepdown starts at 10% of the cutter diameter; the last step may be shorter so the bottom of the band is always cut.',
          'Leave "Steep areas only, above" at 0 to finish the whole part, or set an angle to cut only the walls steeper than it.',
          'Choose the Order: Region by region (the starting choice) finishes one pocket or boss to its bottom before moving on; Level by level cuts every wall at one height before stepping down.',
          'Keep Flat area detection on so a floor that meets a wall gets a pass of its own. Stock to leave (walls) holds a wall allowance for a later pass. Also on the Passes tab: Tolerance, Finish depth limit, Direction (Climb or Conventional) and Clip to stock outline.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'When the next level starts close to where the last one ended, the tool stays down: it feeds along the next loop and ramps onto it. Otherwise it retracts and comes back down. Finer tolerance follows the surface more closely but takes longer. A part too large for the slicer to take in one piece at your tolerance is sliced in tiles at that same tolerance and joined at the seams; the console says how many tiles it used. If the cutter itself is too wide for a tile at that spacing, the slicer uses a coarser spacing and the console reports the effective spacing.',
      },
      { kind: 'image', slot: 'levels' },
    ],
    images: [
      {
        slot: 'levels',
        file: 'levels.webp',
        alt: 'Waterline finishing loops stacked down the walls of a 3D part',
        captureNotes: 'Toolpath view of a Waterline Finish (3D) on a part with a boss and a pocket: closed loops at each level, the ramp visible between levels.',
        status: 'needed',
      },
    ],
    keywords: 'waterline finish 3d contour z level constant z stepdown steep walls steep areas only order region level climb conventional flat area detection stock to leave clip to stock outline',
    contextKeys: ['selection:operation:waterline_3d'],
    relatedTopicIds: ['parallel-3d', 'steep-shallow-3d', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'adaptive-3d',
    title: '3D adaptive roughing',
    category: 'cam-operations',
    summary: 'Adaptive Rough (3D) clears stock level by level with light adaptive passes, down to the shape of the part.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the part to rough: an STL, a STEP model, or a solid made in the Model workspace. The operation plans against the part and the stock.',
          'Use a flat, ball or bull-nose end mill. On the Passes tab set the Max stepdown, the Stepover (fraction of tool dia) - 0.4 is 40% of the diameter - and the Milling direction.',
          'Choose the Roughing scope: Clear around part, or Clear all stock (everything that is not the part). With Clear all stock, Edge overshoot pushes passes past the stock edge (auto is the tool radius).',
          'Entry is a helix: set the Entry helix diameter and the Helix angle. With Clear all stock, the tool comes in from the side instead when the software can prove the whole stock is clear around the part.',
          'Set Radial stock to leave and Axial stock to leave for the finishing operations.',
        ],
      },
      { kind: 'image', slot: 'passes' },
      {
        kind: 'paragraph',
        text: 'Reduce stair steps adds roughing cuts between full stepdowns so curved and sloped walls are left closer to shape. Wall transitions holds Wall lead-in radius, Wall lead-out radius, Loopback fillet, Integral wall-follow and Maximum direct wall ride. Tolerance and Auto grid resolution (untick it to set a Grid cell size) trade accuracy against planning time.',
      },
      {
        kind: 'paragraph',
        text: 'On the Heights tab, the Top Height and Bottom Height rows open to Material source, which chooses Current material (recommended), what the earlier operations left; Initial stock; or Explicit WCS band, between a Band top and Band bottom you type. The roughing path finishes with a vertical lift to its clearance plane, so the tool is raised before the posted tool change or program end stops the spindle.',
      },
      { kind: 'image', slot: 'levels' },
    ],
    images: [
      {
        slot: 'levels',
        file: 'levels.webp',
        alt: 'Toolpath tab with example 06 knob and handwheel open: 3D Rough 1 selected, its adaptive roughing path drawn around the knob, and Properties showing type adaptive 3d, status ready, tool 6 mm flat end mill',
        captureNotes: 'Toolpath view of an Adaptive Rough (3D) on a curved part (examples/06-knob-handwheel, 3D Rough 1 selected, whole frame). WO-2710.',
        status: 'done',
      },
      {
        slot: 'passes',
        file: 'passes.webp',
        alt: 'Edit Operation dialog on the Passes tab of a 3D adaptive rough: Max stepdown 2 mm, Stepover 0.4, Climb, Reduce stair steps unticked, the wall transition settings, Entry helix diameter 3 mm, Helix angle 10 deg, both stock to leave 0, Tolerance 0.1 mm, Auto grid resolution ticked',
        captureNotes: 'Edit Operation dialog crop, Passes tab of 3D Rough 1 in examples/06-knob-handwheel. WO-2710.',
        status: 'done',
      },
    ],
    keywords: 'adaptive rough 3d roughing stepdown stepover fraction engagement roughing scope clear all stock clear around part edge overshoot side entry helix level reduce stair steps grid material source',
    contextKeys: ['selection:operation:adaptive_3d'],
    relatedTopicIds: ['adaptive-clearing', 'parallel-3d', 'stock-simulation'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'scallop-3d',
    title: '3D constant scallop finish',
    category: 'cam-operations',
    summary: 'Scallop Finish (3D) spaces its passes along the surface to hold the Scallop height you set, so steep areas get passes closer together than flat ones.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Parallel Finish keeps the same stepover seen from above. Scallop measures its stepover along the surface instead: it works out one stepover from the Scallop height and the cutter, and spaces every pass by it. On a steep wall that puts the passes closer together seen from above, so the ridge left between passes stays the same height everywhere.',
      },
      {
        kind: 'table',
        columns: ['Field', 'What it does'],
        rows: [
          { cells: ['Scallop height', 'The ridge height the passes hold, everywhere on the surface. Lower is a smoother finish and more passes. It must be smaller than the cutter radius, or the corner radius for a bull-nose cutter.'] },
          { cells: ['Tolerance', 'How far the path may stray from the true surface. Lower follows it more closely and takes longer to compute.'] },
          { cells: ['Stock to leave', 'Material left along the surface - a positive value keeps stock for a later, finer finish.'] },
          { cells: ['Finish depth limit', 'How far below the model top to finish. Leave it blank to finish the whole surface.'] },
          { cells: ['Direction', 'Climb or Conventional for every pass.'] },
          { cells: ['Clip to stock outline', 'Off keeps the passes inside the rectangle around the part; on keeps them inside the stock outline.'] },
          { cells: ['Edge overrun', 'There is no field for it. With Clip to stock outline off, the tool centre runs one tool radius past the part edge, so the round cutter finishes the edge. With it on, there is no overrun, and the console says a fin may be left at the edge.'] },
        ],
      },
      {
        kind: 'paragraph',
        text: 'Use a flat, ball or bull-nose end mill. The part is picked on the Geometry tab like the other 3D finishes, and Faces to machine can limit it to faces of a STEP part.',
      },
    ],
    images: [],
    keywords: 'scallop constant cusp 3d finish stepover steep flat edge overrun clip to stock outline direction climb conventional scallop height',
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
    relatedTopicIds: ['parallel-3d', 'waterline-3d', 'adaptive-3d'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'steep-shallow-3d',
    title: '3D steep and shallow finish',
    category: 'cam-operations',
    summary: 'Steep and Shallow (3D) finishes a part in one operation: waterline levels on the steep walls, parallel passes on the flatter areas.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the part under Source solid: an STL, a STEP model, or a body modeled in the Model workspace. On a STEP part, Faces to machine can limit it to faces you pick.',
          'Use a flat, ball or bull-nose end mill.',
          'On the Passes tab, set the Threshold (0 to 90 degrees). Walls steeper than it get waterline levels; areas flatter than it get parallel passes. The two overlap by a degree on each side so no strip is left between them.',
          'Set the Steep stepdown for the levels, and the Shallow stepover and Shallow pass angle for the parallel passes.',
          'Set the Tolerance, Stock to leave, Finish depth limit (blank finishes the full surface) and Clip to stock outline.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The steep walls are cut first, region by region, then the flatter areas. A Threshold of 0 gives a plain waterline finish and 90 gives a plain parallel finish. If one of the two has nothing to cut it is left out; if both are empty, the operation says so.',
      },
    ],
    images: [],
    keywords: 'steep and shallow 3d finish threshold angle waterline parallel steep stepdown shallow stepover pass angle one operation',
    contextKeys: ['modal:new-operation'],
    relatedTopicIds: ['waterline-3d', 'parallel-3d', 'pencil-3d'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'pencil-3d',
    title: '3D pencil cleanup',
    category: 'cam-operations',
    summary: 'Pencil Cleanup (3D) runs along the inside corners of a part to clean out the material a larger finishing tool could not reach.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'On the Geometry tab, pick the part under Source solid: an STL, a STEP model, or a body modeled in the Model workspace. On a STEP part, Faces to machine can limit it to faces you pick.',
          'Use a ball or bull-nose end mill. Create Operation stays greyed out for a flat end mill or V-bit.',
          'On the Passes tab, set the Tolerance, Stock to leave, Finish depth limit (blank finishes the full surface), Direction (Climb or Conventional) and Clip to stock outline.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The operation finds the inside corners where the rounded end of the tool touches both sides at once, and makes one pass along each corner. There is no stepover or stepdown. A finer Tolerance also looks for corners more finely, so it takes longer. When the part has no inside corner to clean, the operation says no concave corner may be present.',
      },
    ],
    images: [],
    keywords: 'pencil cleanup 3d corner concave fillet rest ball nose bull nose inside corner',
    contextKeys: ['modal:new-operation'],
    relatedTopicIds: ['steep-shallow-3d', 'parallel-3d', 'scallop-3d'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'feeds-speeds',
    title: 'Feeds and speeds hierarchy',
    category: 'cam-operations',
    summary: 'Operations take feeds and speeds from the tool library unless you override them for one operation, inside the machine\'s limits.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The Feedrate tab of the operation dialog shows where the numbers come from. With the override off, it shows the selected tool\'s saved values, read-only: Spindle speed, Cutting feed, Plunge feed, Ramp feed, Lead-in feed, Lead-out feed, Fast traverse feed and Finish feed. Change them in the Tool Library and every operation using the tool follows.',
      },
      {
        kind: 'steps',
        steps: [
          'To use different values for one operation, tick "Override tool feeds & speeds for this operation" on the Feedrate tab. The fields fill in from the tool, with the spindle speed kept inside the machine\'s range.',
          'Type the spindle speed and feeds. Hover over a field to see its allowed range. A value outside it is set to the nearest limit, and the console says what it changed.',
          'The limits come from the machine: its spindle range for Spindle speed, its X axis cutting speed for the cutting feeds, its Z axis for Plunge feed, and its rapid rate for Fast traverse feed.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Fast traverse - the speed for repositioning moves inside areas already cut - is never faster than the machine rapid rate. In the Properties panel, the Tool + Feeds card has a "change" button to swap the tool, and its Feed and Plunge fields set an override for that operation.',
      },
      {
        kind: 'tip',
        text: 'If the tab says the tool has no saved feed and speed defaults, add them in the Tool Library once instead of overriding every operation.',
      },
      { kind: 'image', slot: 'feedrate-tab' },
    ],
    images: [
      {
        slot: 'feedrate-tab',
        file: 'feedrate-tab.webp',
        alt: 'The Feedrate tab showing the tool library values with the override unticked',
        captureNotes: 'Feedrate tab with the override OFF and the read-only grid of the tool\'s saved values filled in (all eight rows).',
        status: 'done',
      },
    ],
    keywords: 'feeds speeds feedrate spindle rpm override tool library defaults machine limit range fast traverse plunge ramp finish tool + feeds',
    contextKeys: ['modal:new-operation'],
    relatedTopicIds: ['creating-operations', 'cut-time'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'operation-folders',
    title: 'Operation folders and suppression',
    category: 'cam-operations',
    summary: 'Group operations into folders in the design tree, and suppress the ones you want skipped by regeneration, simulation and posting.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Click the New operation folder button on a setup row, name the folder, then drag operations into it by their handle. Drag one back to the setup to take it out. Folders can be renamed and collapsed.',
          'Click an operation\'s power button (Suppress operation), or right-click it and choose Suppress. A suppressed operation is dimmed and is skipped by REGEN ALL, the post processor and simulation; it keeps its settings.',
          'Click a folder\'s power button to suppress or enable every operation in it at once. A folder with some of each shows a mixed state; clicking it enables them all.',
          'A suppressed operation cannot be computed: its compute button is greyed out until you unsuppress it.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Right-click a folder to Rename it, Suppress all or Enable all, or Delete it. Delete folder and keep operations removes the folder and leaves its operations in the setup. Suppressing or enabling an operation marks the operations after it for recomputing, because they cut from what it leaves.',
      },
      { kind: 'image', slot: 'tree-folders' },
    ],
    images: [
      {
        slot: 'tree-folders',
        file: 'tree-folders.webp',
        alt: 'Design tree with an operation folder holding one suppressed operation',
        captureNotes: 'Design-tree crop: a setup with an operation folder, one operation suppressed (dimmed) inside it, the folder power button visible.',
        status: 'done',
      },
    ],
    keywords: 'operation folder group suppress unsuppress disable enable skip post simulation regen organize tree delete folder',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['creating-operations', 'generation-failures'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'cut-time',
    title: 'Cut-time estimates',
    category: 'cam-operations',
    summary: 'Every ready operation shows an estimated machine run time, and each setup adds up its switched-on operations.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Select a ready operation and read Cut time in the Summary group of the Properties panel.',
          'The setup row in the design tree shows the total for its ready operations that are switched on; suppressed operations are left out.',
          'For a nest, select the nest: Est. cut time in the Properties panel covers every copy, including the travel between copies.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The estimate follows the toolpath at its programmed feeds, with rapids at the machine rapid rate. When the machine definition gives acceleration for X, Y and Z, the estimate also slows down for acceleration and corners. Feed override at the controller is not included.',
      },
      {
        kind: 'paragraph',
        text: 'If an operation shows "Unavailable (recompute to fix)", or the setup total shows Unavailable, regenerate the operation to bring it back.',
      },
      { kind: 'image', slot: 'estimate' },
    ],
    images: [
      {
        slot: 'estimate',
        file: 'estimate.webp',
        alt: 'The Properties panel showing the cut time for a ready operation',
        captureNotes: 'Properties panel crop with a ready operation selected, the Cut time row visible in the Summary group.',
        status: 'done',
      },
    ],
    keywords: 'cut time estimate duration machine run time setup total nest copies feedrate acceleration',
    contextKeys: ['panel:properties:operation'],
    relatedTopicIds: ['feeds-speeds', 'generation-failures'],
    sinceVersion: '0.36.0',
  },
])
