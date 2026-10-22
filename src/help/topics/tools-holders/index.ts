import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'tool-library',
    title: 'The tool library',
    category: 'tools-holders',
    summary: 'The Tool Library window holds every cutter in named libraries, with search, filters, and a tabbed editor with a live tool diagram.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Open it with Tool Library in the top toolbar. The window has two views, switched by the Tools / Holders toggle in the header. The Tools view shows a list pane on the left and an editor on the right. Tools live in named libraries: the dropdown at the top of the list scopes it to one library (with its tool count) or to All libraries, the + button creates a new library, and the pencil and trash buttons rename or delete the selected library (deleting a library asks first and deletes its tools too).',
      },
      {
        kind: 'steps',
        steps: [
          'Find a tool with the search box (matches name, type, and T number), or narrow the list with the material filter. While a search or filter is on, the list says how many tools it shows and Clear resets it.',
          'The type dropdown is a focus control: choosing a type expands that group and folds the others shut, without hiding any tools. Sort by Type, Name, Diameter, or Tool # - the Type sort groups the list into collapsible sections. Each row shows the diameter, flute count (a probe shows "probe" instead), the library (in All libraries) and the tool number badge.',
          'Below the list, New starts a blank tool in the selected library, Dup copies the selected one, Import brings in a tool file as a new library, and the export button saves All tools or just the selected library (Lib).',
          'Edit the selected tool in the four editor tabs while the diagram on the right redraws live from your values: General (name, type, material, coating, holder, vendor, product ID, notes), Cutter (the dimensions and shape), Cutting Data (spindle speed, feeds and coolant, with a "? Material guide" table), and Post (tool number and cutting hand).',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Edits are a draft until you press Save Changes in the footer; switching tools or libraries, or closing the window, with unsaved edits asks "Discard unsaved changes?" first. The footer also holds Delete and a per-tool Export. Operations pick their cutter from this library, and each tool\'s Cutting Data supplies the default feeds and speeds an operation starts from.',
      },
      { kind: 'heading', text: 'Tool numbers', anchor: 'tool-numbers' },
      {
        kind: 'paragraph',
        text: 'The Post tab\'s Tool number is the T word the program calls the tool by; it shows as the T badge in the list. Left blank ("Auto-post"), the post gives the tool the lowest number no other library tool uses and says so, for example "Tool "60deg V-Bit" has no tool number, so it posts as T7." Two different tools with the same number in one program stop the post with a message naming both. Resolve the conflict in Post Process > Properties > Tool numbers: give one tool a number for this program and press Enter or click away. The choice is saved with the project, while the tool library keeps its own number. Cutting hand picks the spindle direction: Right-hand cutting (standard) keeps the machine direction; Left-hand cutting (reverse spindle) reverses it.',
      },
      { kind: 'image', slot: 'library-modal' },
    ],
    images: [
      {
        slot: 'library-modal',
        file: 'library-modal.webp',
        alt: 'The Tool Library window with the grouped tool list, library selector, and the Cutter tab of the editor with its live diagram',
        captureNotes: 'Tool Library open on the Tools view with tools from at least two libraries under All libraries: list sorted by Type showing collapsible group headers and T badges, a tool selected, Cutter tab active, and the tool diagram visible on the right.',
        status: 'done',
      },
    ],
    keywords: 'tool library tools list search filter sort type material duplicate new delete rename library scope save draft discard tabs general cutter cutting data post diagram tool number t number auto-post cutting hand left hand probe',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-geometry', 'probe-tool', 'tools-import-export', 'tool-holders', 'feeds-speeds'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'tool-geometry',
    title: 'Tool shapes',
    category: 'tools-holders',
    summary: 'All 19 tool types share one geometry model - a profile revolved around the tool axis - and that same profile drives the 2D diagram, the 3D tool in the viewport, and stock-removal simulation.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Every tool is described as a solid of revolution: a radius-versus-height outline from the tip upward, mirrored across the centerline. The 2D diagram in the editor, the 3D tool drawn in the viewport, and the shape the simulation carves with all read this one profile, so what you see in the editor is what cuts in simulation. The 19 types are grouped as milling (flat, ball, bull nose, face mill, chamfer mill, tapered endmill, dovetail, lollipop, slitting saw), hole-making (drill, spot drill, center drill, countersink, reamer, boring bar), threading (tap, thread mill), engraving (V-bit), and probing (probe).',
      },
      {
        kind: 'paragraph',
        text: 'The Cutter tab shows only the fields the selected type actually uses. Every type has Diameter, Shank diameter, Overall length, Flute length (from tip), Shoulder length (from tip), Length below holder, and Flutes - except the probe, which has no Flutes, and whose Diameter and Flute length read "Ball (tip) diameter" and "Stylus length (from tip)" (see "Probe tools"). A bull nose adds Corner radius; undercut families (dovetail, lollipop, slitting saw, thread mill) add Neck diameter and "Relief / shoulder length" for the narrowed section above the cutting form. The diagram labels the cutter diameter, flute length, length below holder and overall length as you type.',
      },
      {
        kind: 'steps',
        steps: [
          'Pointed tools - V-bit, chamfer mill, drill, spot drill, center drill, countersink, and dovetail - take the "Included tip angle", and an echo line shows the equivalent per-side angle.',
          'The tapered endmill takes the "Taper angle (per side)" instead, with the included total echoed below.',
          'Press the ? button beside any angle field for a live diagram that draws both conventions at your current value and highlights the one you should enter.',
        ],
      },
      { kind: 'image', slot: 'profile-diagrams' },
    ],
    images: [
      {
        slot: 'profile-diagrams',
        file: 'profile-diagrams.webp',
        alt: 'Tool diagrams for several tool types side by side, plus the angle-convention helper diagram',
        captureNotes: 'Composite of the editor diagram for three contrasting types (for example ball end mill, V-bit, thread mill) plus the angle help diagram opened via the ? button on a V-bit showing the included and per-side labels.',
        status: 'done',
      },
    ],
    keywords: 'tool shape geometry profile revolution 19 types diagram 3d simulation cutter fields diameter shank flute length corner radius neck relief included angle per side taper convention probe',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-library', 'thread-mill-tool', 'probe-tool', 'stock-simulation'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'tool-holders',
    title: 'Tool holders',
    category: 'tools-holders',
    summary: 'Holders are a stack of cone or cylinder segments kept in their own list; assign one to a tool and the viewport draws the full tool-plus-holder assembly above the stickout.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Switch the Tool Library header toggle to Holders to open the holder editor. A holder is defined by a segment table: each row is one slice with a Height, a Lower OD, and an Upper OD, stacked from the tool side upward ("Segments (bottom = tool side, up)"). Cylinders have equal lower and upper diameters; cones taper between them. Add segment adds a row, the arrows reorder rows and the trash button removes one. The Identity fields above the table are Name, Vendor, Product ID and Gauge length.',
      },
      {
        kind: 'steps',
        steps: [
          'In the Holders view, press New to create a holder, then edit its segment rows - every change is kept immediately (holders have no Save button) and redraws the silhouette preview at true proportions.',
          'On a tool\'s General tab, pick the holder from the Holder dropdown (or None), then Save Changes.',
          'Set "Length below holder" on the Cutter tab - the stickout. The General tab shows it read-only. The holder is drawn starting that far above the tool tip, so the viewport shows the real assembly.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The holder also counts when a toolpath is generated: the path is kept so the holder stays clear of the part and stock (see "Tool reach: Stopped short"). Delete asks first; tools that used the deleted holder fall back to no holder.',
      },
      { kind: 'image', slot: 'holder-editor' },
    ],
    images: [
      {
        slot: 'holder-editor',
        file: 'holder-editor.webp',
        alt: 'The Holders view with a segment table and the live holder silhouette preview',
        captureNotes: 'Tool Library on the Holders view: a holder with 2-3 segments selected, the segment table showing Height / Lower OD / Upper OD columns and the reorder arrows, and the mirrored silhouette preview on the right.',
        status: 'done',
      },
    ],
    keywords: 'holder holders segment stack cone cylinder height lower upper diameter od gauge length stickout length below holder assembly collet chuck preview silhouette assign none reach',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-library', 'rub-warnings'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'tools-import-export',
    title: 'Importing and exporting tools',
    category: 'tools-holders',
    summary: 'Tools travel as JSON files or industry-standard .tools archives; every import lands as its own new library named after the file.',
    sections: [
      {
        kind: 'steps',
        steps: [
          'Press Import below the tool list and pick a .tools file (a zipped tool library, as exported by common CAM tools) or a .json export from this app.',
          'The file arrives as a NEW library named after the file, and the list jumps to it - imports never mix into your existing libraries.',
          'Holders embedded in the file are imported too, and each tool keeps its link to its holder.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Exporting goes three ways: the Export button in the footer saves the selected tool as a single .tool.json file (with its holder embedded), and the export button below the list saves either every tool (All, when the scope is All libraries) or just the selected library (Lib) as one .json file. All of these re-import.',
      },
      {
        kind: 'paragraph',
        text: 'After an import, a line below the buttons says how it went (for example "Imported 5 tools into library "Shop endmills"") and the bottom console keeps the full message. A record the app cannot read is skipped and named in the console with the reason; the rest of the file still imports. A file that yields no tools at all leaves no empty library behind.',
      },
      { kind: 'image', slot: 'import-flow' },
      {
        kind: 'paragraph',
        text: 'Inch-based Fusion tool libraries are converted to millimeters and their dimensions rounded to 0.0001 mm on import. A nonzero value too small to survive rounding is kept. Libraries imported earlier keep their stored values; import the original file again to get the rounded dimensions in a new library. Metric libraries and manual edits keep their values.',
      },
    ],
    images: [
      {
        slot: 'import-flow',
        file: 'import-flow.webp',
        alt: 'The tool list scoped to a freshly imported library with the inline import readout',
        captureNotes: 'Tool list right after importing a tool file: library dropdown showing the new library named after the file, the imported tools listed, and the inline "Imported N tools into library ..." readout visible below the action buttons.',
        status: 'done',
      },
    ],
    keywords: 'import export tools file json archive zip library interchange share transfer holder embedded skipped readout console',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-library'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'rub-warnings',
    title: 'Tool reach: Stopped short',
    category: 'tools-holders',
    summary: 'Every toolpath is kept to what the tool can reach - the neck, shank and holder stay clear of the part, the stock and any workholding - and an operation that could not reach full depth says "Stopped short".',
    sections: [
      {
        kind: 'paragraph',
        text: 'When an operation generates, the app checks the whole tool assembly along the path: the cutter, the neck, the shank above the flutes, and the holder above the Length below holder. Where the neck, shank or holder would come closer than the Shank clearance to the part, the stock (what earlier operations left, when that is known) or a workholding body, the cut is stopped there and picks up again where it is clear. The rest of the toolpath is kept, and the operation stays ready to post.',
      },
      {
        kind: 'paragraph',
        text: 'An operation that was stopped short shows it in three places: an amber arrow icon on its row in the design tree, a Reach row with a "Stopped short" badge in the Summary group of its Properties panel (hover it for the whole message, for example "Stopped short: reached Z 9.25 of Z 0 asked - 4263.4 mm of cutting path left uncut; a tool with a longer reach cuts the rest."), and one console line naming where the first stop happened and what would have touched.',
      },
      {
        kind: 'steps',
        steps: [
          'The Shank clearance field (0.25 mm unless you change it) is in the operation\'s Properties panel, Passes group, on 2D Contour, 2D Pocket, 2D Adaptive Clearing, Drill, Bore, 2D Chamfer, 2D Face, Engrave / Trace, V-Carve and Thread Mill. Other operations use 0.25 mm.',
          'The limits come from the tool: Flute length and Length below holder on the Cutter tab, the neck fields on undercut tools, and the holder assigned on the General tab.',
        ],
      },
      { kind: 'image', slot: 'reach-warning' },
    ],
    images: [
      {
        slot: 'reach-warning',
        file: 'reach-warning.webp',
        alt: 'An operation stopped short: the Reach row in its Properties panel',
        captureNotes: 'Properties panel for a generated operation whose tool (short stickout, holder assigned) could not reach full depth: the Summary group with Status ready and the Reach row showing the amber "Stopped short" badge and its message.',
        status: 'done',
      },
    ],
    keywords: 'rub warning reach stopped short shank holder neck flute length stickout length below holder depth trim clearance shank clearance allowance collision contact workholding uncut',
    contextKeys: ['panel:properties:operation'],
    relatedTopicIds: ['tool-holders', 'generation-failures', 'workholding'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'thread-mill-tool',
    title: 'Thread mill tools',
    category: 'tools-holders',
    summary: 'A thread mill adds a Thread form section to the Cutter tab - tooth count, form angle, and pitch - and the diagram draws the toothed cutter live.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Choose the Thread Mill type and the Cutter tab gains a Thread form section. Thread teeth (vertical) sets how many cutting teeth stack up the flute: 1 is a single-point cutter, more makes a full-form cutter. Thread form angle (degrees included) is the included angle of the tooth V (60 degrees for standard metric and unified forms), and Thread pitch is the spacing between teeth - leave it blank to draw a plain cylinder.',
      },
      {
        kind: 'paragraph',
        text: 'Because thread mills are relieved above the cutting form, the type also shows Neck diameter and "Relief / shoulder length", plus a Neck transition angle (measured from the tool axis) that shapes the blend from neck to shank - 90 is a sharp step, smaller values a gentler taper. All of these draw live in the editor diagram, teeth included, and shape the 3D tool shown in the viewport and the cutter the simulation carves with.',
      },
      {
        kind: 'tip',
        text: 'The Thread Mill operation cuts the pitch set in its own Pitch field; the tool\'s pitch describes the cutter\'s teeth.',
      },
      { kind: 'image', slot: 'thread-diagram' },
    ],
    images: [
      {
        slot: 'thread-diagram',
        file: 'thread-diagram.webp',
        alt: 'The tool diagram of a multi-tooth thread mill with the Thread form fields beside it',
        captureNotes: 'Tool editor with a Thread Mill selected: Thread form section visible (teeth, form angle, pitch) with the neck fields and neck transition angle above it, and the diagram drawing several V teeth with the relieved neck above them.',
        status: 'done',
      },
    ],
    keywords: 'thread mill tool teeth form angle pitch single point full form neck relief transition angle diagram cutter 60 degree',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-geometry', 'thread-milling'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'probe-tool',
    title: 'Probe tools',
    category: 'tools-holders',
    summary: 'The Probe tool type keeps a touch probe in the tool library: its ball, stylus and stem sizes, which probe input it is wired to, and whether its contact is normally open or normally closed.',
    sections: [
      {
        kind: 'paragraph',
        text: 'To add a probe, press New below the tool list, choose Probe in the Type dropdown on the General tab, fill in the Cutter tab, then press Save Changes. A probe has no Flutes field. Its row in the list shows "probe" where other tools show the flute count, and the Type sort gathers probes in their own Probe group.',
      },
      {
        kind: 'steps',
        steps: [
          'Ball (tip) diameter is the diameter of the ball on the end of the stylus. The diagram labels it "ball".',
          'Stylus length (from tip) is the length of the stylus from the ball tip up to the probe body. The diagram labels it "stylus".',
          'Shank diameter is the diameter of the probe body above the stylus. Overall length, Shoulder length (from tip) and Length below holder are the same fields every tool has (see "Tool shapes" and "Tool holders").',
          'Stem diameter, under Geometry, is the thin stem that carries the ball. It shows "auto" until you type a value, and on auto the diagram draws a stem thinner than the ball. Empty the box to go back to auto.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'The Probe section says how the probe is connected and what radius to use for it:',
      },
      {
        kind: 'steps',
        steps: [
          'Probe input is the controller probe input the probe is wired to: Probe 1 or Probe 2. A new probe starts on Probe 1.',
          'Contact is Open (NO) for a normally open probe or Closed (NC) for a normally closed one. A new probe starts on Open (NO).',
          'Calibrated radius X and Calibrated radius Y are the probe radius along X and along Y. Left blank, each box shows the ball radius (for example "ball 1.000" for a 2 mm ball) and the note below them reads "Blank calibrated radius = the ball radius is used." Type a value to set one; empty the box to go back to the ball radius.',
        ],
      },
      { kind: 'image', slot: 'probe-editor' },
    ],
    images: [
      {
        slot: 'probe-editor',
        file: 'probe-editor.webp',
        alt: 'Tool Library, Cutter tab of a probe being added (the tool list is still empty): Ball (tip) diameter 6, Stylus length (from tip) 18, Stem diameter auto, Probe input Probe 1, Contact Open (NO), both calibrated radius boxes showing ball 3.000, and the diagram labelled 6.00 mm ball and 18.0 mm stylus',
        captureNotes: 'Tool Library dialog crop, Type = Probe, Cutter tab with the probe section and diagram. WO-2710.',
        status: 'done',
      },
    ],
    keywords: 'probe touch probe 3d probe tool type ball tip diameter stylus length stem diameter auto probe input probe 1 probe 2 contact normally open normally closed no nc calibrated radius x y ball radius',
    contextKeys: ['modal:tool-library'],
    relatedTopicIds: ['tool-library', 'tool-geometry', 'tool-holders'],
    sinceVersion: '0.36.0',
  },
])
