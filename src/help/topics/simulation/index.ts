import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'simulation-playback',
    title: 'Playing back a toolpath',
    category: 'simulation',
    summary: 'The Simulate tab plays the computed toolpath against a clock, with transport buttons, a draggable timeline, speed presets, and live position and move readouts.',
    sections: [
      {
        kind: 'paragraph',
        text: 'What plays depends on the selection: with an operation selected in the design tree, playback covers just that operation, and every enabled operation before it is already carved into the starting stock, so you see the material state it actually begins from. With no operation selected, all enabled operations in the active setup play in order, with rapid links between them and the 3D tool (and its holder) swapping at each tool change. Suppressed operations are skipped. If nothing is generated yet, the panel says so and names the operation to compute.',
      },
      {
        kind: 'steps',
        steps: [
          'Use the transport buttons: rewind to start, play/pause, and skip to end. The times on either side of the timeline show the current and total clock as minutes:seconds.',
          'Drag the timeline to scrub to any point. While dragging, the carved stock shows a nearby snapshot for speed and settles to the exact frame when you release; a very large jump shows a "Simulating" progress bar while it catches up.',
          'Click the Speed chip to open the preset flyout: 0.1x, 0.5x, 1x, 5x, 10x, 50x, and 100x.',
        ],
      },
      {
        kind: 'tip',
        text: 'Playback at 1x is feed-true: each move is timed from its programmed feed rate, and rapids run at the machine rapid rate, so the clock approximates real cutting time. The readouts on the right show the tool position as WCS X, Y, Z in your display units, plus the current move role and its feed rate (for example CUT @ 1200 mm/min).',
      },
      {
        kind: 'paragraph',
        text: 'With one operation selected, a feed estimate sits above the timeline: the Operation, its Commanded feed, the Estimated real feed (min / typical) the machine can reach through corners and short moves, the Theoretical cycle time and the Estimated cycle time, and the Chipload (commanded / estimated). The estimate uses the axis acceleration from the machine definition; when none is set, it reads "Acceleration not set in the machine definition" and shows only the commanded numbers.',
      },
      { kind: 'image', slot: 'playback-bar' },
    ],
    images: [
      {
        slot: 'playback-bar',
        file: 'playback-bar.webp',
        alt: 'The Simulate tab partway through playing a setup, with the speed flyout open',
        captureNotes: 'Simulate tab playing a setup of three generated operations at 100x, zoomed onto the partly carved stock: timeline partway through, Speed chip flyout open showing the 0.1x-100x presets, the WCS position readout and the move-role badge on the right, and Simulate Stock Removal on with the resolution dropdown and the Cut Stock / Compare / Target buttons below.',
        status: 'done',
      },
    ],
    keywords: 'playback play pause rewind skip to end scrubber timeline transport speed 1x 100x feed true clock time readout wcs position move role tool change per operation feed estimate commanded real feed acceleration cycle time chipload',
    contextKeys: ['mode:simulation'],
    relatedTopicIds: ['stock-simulation', 'cut-time', 'operation-folders'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'stock-simulation',
    title: 'Stock simulation',
    category: 'simulation',
    summary: 'The Simulate tab plays generated toolpaths and, with Simulate Stock Removal on, carves them out of the setup\'s stock.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Generate the operations you want to inspect, then open the Simulate tab.',
          'Tick Simulate Stock Removal and use the playback controls to step through the toolpath. The dropdown beside it sets the cell size of the simulated stock: 1.000 mm (fast), 0.500 mm (normal), 0.250 mm (fine), or 0.100 mm (very fine).',
          'Stock is carved only for operations that have a generated toolpath in a setup with stock. The simulation engine is chosen in Settings.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'For planar stepdown operations, the path overlay shows the complete current Z layer instead of letting uncut stock hide its far side. As playback begins the next descent, the previous layer disappears and the complete upcoming layer takes its place. Operations without stable Z layers keep their normal full-path view, and Hide Toolpath applies to either presentation.',
      },
      { kind: 'image', slot: 'carved-stock' },
    ],
    images: [
      {
        slot: 'carved-stock',
        file: 'carved-stock.webp',
        alt: 'Carved stock at the end of a setup\'s simulation, with the playback bar',
        captureNotes: 'Simulate tab with the setup played to the end in the Cut Stock view, zoomed onto the stock: the carved pockets and bored holes with the toolpath over them, the playback bar, and Simulate Stock Removal on with the resolution dropdown and the display buttons.',
        status: 'done',
      },
    ],
    keywords: 'stock simulation simulate playback removal voxel heightmap engine toolpath resolution cell size fast normal fine very fine',
    contextKeys: ['mode:simulation'],
    relatedTopicIds: ['generation-failures'],
    sinceVersion: '0.16.1',
  },
  {
    id: 'sim-engines',
    title: '3D and 2.5D simulation engines',
    category: 'simulation',
    summary: 'Stock removal can run on a full 3D engine that carves a true volume or a lighter 2.5D engine that tracks only the top surface, and Auto picks per your graphics hardware.',
    sections: [
      {
        kind: 'paragraph',
        text: 'The choice lives in Settings under the Stock Simulation section, as the "Simulation engine" dropdown: Auto (3D, falls back to 2.5D), 3D - smooth, true undercuts, and 2.5D - fast (low-end GPUs).',
      },
      {
        kind: 'paragraph',
        text: 'The 3D engine carves a true volume, so material can remain under overhangs and the carved shape stays honest in all three axes. It needs a GPU with WebGL2 and linear filtering of floating-point 3D textures. The 2.5D engine stores one height per point of the stock surface, so it only ever shows the top surface - it is much lighter and runs on almost any machine, but it cannot represent an undercut.',
      },
      {
        kind: 'paragraph',
        text: 'Auto uses the 3D engine whenever the GPU supports it. If the GPU cannot run it - even when 3D is forced - the simulation falls back to 2.5D and notes the fallback in the console rather than failing or degrading silently.',
      },
      {
        kind: 'tip',
        text: 'The 3D engine keeps its cell lattice out of the shaded and translucent views so the simulated surface stays readable. To inspect the cell grid, open the Display Mode flyout on the viewport and choose Unshaded (wireframe).',
      },
      { kind: 'image', slot: 'engine-comparison' },
    ],
    images: [
      {
        slot: 'engine-comparison',
        file: 'engine-comparison.webp',
        alt: 'The same carved setup shown by the 3D engine and the 2.5D engine side by side, with the engine dropdown',
        captureNotes: 'Side-by-side of the same setup carved to the end in the Cut Stock view: left with Simulation engine = 3D (Auto), right with 2.5D, plus the Settings "Simulation engine" dropdown open showing the three options.',
        status: 'done',
      },
    ],
    keywords: 'simulation engine voxel heightmap 3d 2.5d auto gpu webgl2 fallback undercut settings stock removal wireframe unshaded',
    contextKeys: ['modal:settings', 'mode:simulation'],
    relatedTopicIds: ['stock-simulation', 'gpu-limits'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sim-accuracy',
    title: 'What simulation shows and skips',
    category: 'simulation',
    summary: 'The simulated cut uses each tool\'s real cutting shape and only carves moves that actually cut; the 2.5D engine cannot show undercuts or threads, and a very fine resolution may be coarsened to fit.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Every tool type carves with its real bottom profile - flat, ball, bull nose, V, taper, and the rest - derived from the same tool geometry that drives the tool diagram and the 3D tool marker. Only moves that engage material remove stock: rapids and repositioning moves over already-cleared areas carve nothing, while lead moves and finishing passes do carve, so a thin wall-finish skim shows up in the result.',
      },
      {
        kind: 'paragraph',
        text: 'Undercut-style tools (lollipop, dovetail, and slot/disc cutters) carve only the space the tool body takes up: the full head, and above it only the neck. The 3D engine shows the undercut this leaves under the overhang. A thread mill carves its thread form, so the 3D engine shows the thread groove in the hole wall. The 2.5D engine keeps one height per point, so it cannot show an undercut or a thread.',
      },
      {
        kind: 'paragraph',
        text: 'The resolution dropdown sets the cell size of the simulated stock. A very fine resolution on a large stock can exceed the 3D engine\'s memory budget; when that happens the simulation coarsens the cell size to fit and logs the effective size in the console instead of failing.',
      },
      {
        kind: 'paragraph',
        text: 'When the setup has workholding (a vise, jaws or clamps marked as workholding), the simulation checks every move against it. Imported vise and clamp components use their actual shapes once loaded, so an open gap between vise ledges is not treated as solid workholding. While a shape is loading, or if it cannot be read, the check uses its bounding box. Each contact writes one line in the console naming the operation and move, the part of the tool that touches (cutter, neck, shank or holder) and where - for example "Pocket 2, moves 40-52: holder contacts workholding at X 12.00 Y 3.50 Z 20.00." Playback carries on.',
      },
      {
        kind: 'paragraph',
        text: 'To judge the result against the part, use the display buttons that appear with stock removal enabled: Cut Stock shows only the carved stock, Compare overlays translucent stock on the target part with a Stock opacity slider, and Target hides the carved stock to show the part alone. Hide Toolpath clears the path lines out of the way while comparing; it only affects the Simulate view.',
      },
    ],
    images: [],
    keywords: 'accuracy undercut lollipop dovetail slot cutter neck thread mill thread form resolution coarsen memory budget compare target cut stock opacity hide toolpath finish pass rapids workholding vise clamp contact holder shank console',
    contextKeys: ['mode:simulation'],
    relatedTopicIds: ['stock-simulation', 'sim-engines', 'gpu-limits'],
    sinceVersion: '0.36.0',
  },
])
