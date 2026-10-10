import { localizeHelpTopics } from '../catalog'
import type { HelpTopic } from '../../types'

export const topics: HelpTopic[] = localizeHelpTopics([
  {
    id: 'outdated-after-open',
    title: 'Everything says outdated after opening',
    category: 'troubleshooting',
    summary: 'Operations reopen with an amber clock badge when their toolpath could not come back with them - every setting is kept, and regenerating rebuilds the toolpath.',
    sections: [
      {
        kind: 'paragraph',
        text: 'An amber clock badge on an operation means "outdated": the operation and all of its settings are kept, but it has no current toolpath. A project saved to a .camproject file keeps its toolpaths, so it reopens ready. An operation reopens outdated when the browser page was reloaded (the copy of the project the browser keeps does not hold toolpath moves), when it was still computing as the app closed, or when a toolpath saved in the file cannot be matched to the operation\'s current inputs - that saved toolpath is dropped rather than shown.',
      },
      {
        kind: 'steps',
        steps: [
          'After a reload, the bottom console says how many need it, for example: "2 operations need regeneration (toolpaths are not saved to browser storage). Use Regen All to recompute."',
          'Press Shift+G, or click REGEN ALL on the Setups header of the design tree (its tooltip reads "Regenerate all toolpaths (Shift+G)"), to recompute every operation.',
          'To recompute one operation, select its row and press G, or right-click the row and choose Regenerate.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Post Process and sending a program to the machine recompute any outdated operation first, and the console names each one: "Recomputed "<name>": it was out of date, so it was recalculated before the program left the app."',
      },
      {
        kind: 'tip',
        text: 'Outdated is also the normal state in a session after something an operation depends on changes - for example its geometry, the stock, or the WCS origin.',
      },
      { kind: 'image', slot: 'regen-all' },
    ],
    images: [
      {
        slot: 'regen-all',
        file: 'regen-all.webp',
        alt: 'The design tree with outdated operations showing amber clock badges and the REGEN ALL button on the Setups header',
        captureNotes: 'Compute two operations, reload the page (the browser copy keeps no toolpath moves), so those rows show the amber clock badge; crop the Setups section header with its REGEN ALL button and two or three outdated operation rows, plus the console line "N operations need regeneration ...".',
        status: 'needed',
      },
    ],
    keywords: 'outdated amber clock everything stale after open reload regenerate regen all shift+g toolpath gone lost recompute why',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['generation-failures', 'projects-save-open', 'height-truthfulness'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'blank-or-crashed',
    title: 'Recovering from a crash',
    category: 'troubleshooting',
    summary: 'A drawing error shows an error screen with the real error message; Reload opens the same saved project, and a failure in the 3D view alone leaves the rest of the app working.',
    sections: [
      {
        kind: 'paragraph',
        text: 'If the whole window is replaced by a screen titled "LienCAM encountered an error", something stopped the app from drawing. The screen says "Something went wrong while rendering. Your saved project has not been touched -- reloading is usually all that is needed.", shows the error message itself in a red box, and offers two buttons. Reload reloads the page and opens the same saved project. Below it, "Reset Project Data & Reload (last resort)" clears everything the app has saved in this browser - the current project, your tool library, holder library, machine library, app settings and imported fonts - and reloads.',
      },
      {
        kind: 'paragraph',
        text: 'If only the 3D view shows "This view failed to render", the design tree, the properties panel and the other tabs keep working, and the error message is shown under the heading. Press "Retry this view", or click another tab (Setup, Sketch, Toolpath, Simulate) - changing tabs clears the error and draws the view again.',
      },
      {
        kind: 'steps',
        steps: [
          'Whole window: press Reload.',
          'Only the 3D view: press "Retry this view", or click another tab.',
          'If Reload brings the same error back every time, "Reset Project Data & Reload (last resort)" clears the saved data and reloads.',
        ],
      },
      {
        kind: 'warning',
        text: 'Reset Project Data & Reload cannot be undone: the project, tool library, holder library, machine library, app settings and imported fonts saved in this browser are cleared. A .camproject file saved to disk is not touched and can be opened again afterwards.',
      },
      { kind: 'image', slot: 'recovery-screen' },
    ],
    images: [
      {
        slot: 'recovery-screen',
        file: 'recovery-screen.webp',
        alt: 'The LienCAM encountered an error screen with the error message, the Reload button, and the last-resort reset button',
        captureNotes: 'Trigger the app-level error screen in a dev build (a render error outside the 3D view); capture the full screen: warning triangle + "LienCAM encountered an error" heading, the "Your saved project has not been touched" line, the red error-message box, the blue Reload button, the "Still broken after reloading?" text and the "Reset Project Data & Reload (last resort)" button.',
        status: 'needed',
      },
    ],
    keywords: 'crash crashed blank white screen error boundary encountered an error reload reset project data recover frozen broken lost work view failed to render retry',
    contextKeys: ['error:recent'],
    relatedTopicIds: ['error-details', 'projects-save-open'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'gpu-limits',
    title: 'GPU capability fallbacks',
    category: 'troubleshooting',
    summary: 'The 3D stock simulation needs a GPU feature not every computer has; without it the app runs the 2.5D simulation and says so in the console.',
    sections: [
      {
        kind: 'paragraph',
        text: 'Stock removal simulation has two engines. The 3D engine ("3D - smooth, true undercuts") shows true material removal, including undercuts, and needs WebGL2 with linear filtering of floating-point 3D textures. The 2.5D engine ("2.5D - fast (low-end GPUs)") follows only the top surface of the stock and runs on any GPU. The choice is in Settings, under Stock Simulation, "Simulation engine"; the default is "Auto (3D, falls back to 2.5D)".',
      },
      {
        kind: 'paragraph',
        text: 'When the 3D engine cannot run - on Auto, or with 3D picked on a computer that lacks the feature - the simulation runs on the 2.5D engine and the bottom console shows a warning: "Voxel simulation unavailable (GPU lacks WebGL2 + float-3D-texture linear filtering); using 2.5D heightmap." If the carved stock never shows undercuts, that line says why.',
      },
    ],
    images: [],
    keywords: 'gpu graphics fallback voxel heightmap webgl webgl2 unsupported slow simulation engine undercut missing 3d not working intel integrated 2.5d',
    contextKeys: ['mode:simulation'],
    relatedTopicIds: ['stock-simulation'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'import-refusals',
    title: 'Why an import or derive was refused',
    category: 'troubleshooting',
    summary: 'When a file cannot be read or a shape cannot be used, the app names the reason in the design tree, the bottom console, or on the operation.',
    sections: [
      {
        kind: 'paragraph',
        text: 'A refusal shows where the action ran: as a red line at the top of the Geometry section of the design tree (click it to dismiss), in the bottom console, or on the operation that could not be computed.',
      },
      {
        kind: 'paragraph',
        text: 'Files the app cannot read: a STEP file the reader cannot read shows a red line in the design tree such as "STEP import failed for "part.step" [step-read]: STEP read failed for "part.step": IFSelect status is not RetDone". Other files that fail to import write "Import failed for "<file name>": <reason>" in the bottom console.',
      },
      {
        kind: 'paragraph',
        text: 'Edit as model on an STL: right-click an imported STL and choose "Edit as model". A flat-faced mesh becomes an editable solid. A curved mesh (round holes, bosses, fillets) opens on the Model tab as a mesh and stays an STL; the console says so, for example: ""cylinder" is open as a mesh (kept as an STL): 2 feature(s) recognised across 192 facets in 241 ms. Click a feature to select it whole."',
      },
      {
        kind: 'paragraph',
        text: 'A mesh with holes or loose edges is refused: "The mesh is not watertight (4 open edge(s) across 1 hole(s), 0 non-manifold edge(s)); a solid cannot be built from it. Repair it first." A mesh with zero-area triangles, or one whose surface has no inside and outside, is refused the same way with its own message. A mesh boolean on a shape that is not closed reports "Boolean failed: one of the shapes is not a closed, watertight solid, so the boolean cannot run reliably. Repair or close the mesh first (Mesh tools), then try again." LienCAM has no mesh repair tools you can open yet: repair the mesh in your modelling program and import it again, or keep working with it as an STL.',
      },
      {
        kind: 'paragraph',
        text: 'Turned STEP parts: when you rotate a STEP part about X or Y, LienCAM re-derives its faces, holes and sections once, when the rotation is set, rather than during the drag. Turned upside down, level features can still be cut and their positions and depths follow the part. Tilted part way, features that no longer face straight up cannot be cut from above: the operations that use them turn red and the message names the tilt, for example "turned 30 deg off upright (rotation X=30 deg, Y=0 deg)". Turn the part upright or upside down to cut those features again.',
      },
      {
        kind: 'paragraph',
        text: 'Face picks: a picked face must be flat and level to drive a 2D operation or to serve as a height datum. A curved datum pick shows "That surface is curved - pick a FLAT (planar) face as the datum. Cylinder walls cannot be a datum plane."; a flat face that is not level is refused by name too.',
      },
      { kind: 'image', slot: 'refusal-example' },
    ],
    images: [
      {
        slot: 'refusal-example',
        file: 'refusal-example.webp',
        alt: 'A named refusal in the design tree after Edit as model on an STL mesh that is not watertight',
        captureNotes: 'Import an STL with an open side (for example a box with no lid), right-click it and choose Edit as model, and capture the red "The mesh is not watertight (...)" line at the top of the Geometry section of the design tree with the STL row below it.',
        status: 'needed',
      },
    ],
    keywords: 'refused refusal rejected cannot convert import failed curved mesh watertight open edges non-manifold tilted rotated off axis planar face error why wont step read edit as model',
    contextKeys: ['error:recent'],
    relatedTopicIds: ['error-details', 'operation-sources'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'sketch-conflicts',
    title: 'Fixing an over-defined sketch',
    category: 'troubleshooting',
    summary: 'A constraint or dimension that would contradict the sketch is taken back at once and named in the status bar; a sketch that already holds a contradiction shows a red Over-defined banner with a Resolve list.',
    sections: [
      {
        kind: 'paragraph',
        text: 'When you add a constraint or a dimension, change a dimension\'s value, or switch a reference dimension to driving, and the result would contradict the rest of the sketch, the app does not keep it. It is removed straight away, the sketch stays as it was, and the status bar and console name what it conflicts with, for example: "Parallel rejected: conflicts with Coincident(Line 1, Line 4), Coincident(Line 1, Line 2), ... Distance(Line 2 = 40)".',
      },
      {
        kind: 'paragraph',
        text: 'The chip beside the Sketch title shows the solver\'s verdict: "N DoF" (that many degrees of freedom remain), "Fully defined", "Not solved" (no verdict yet) or "Solve failed". If a sketch already holds a contradiction when it is opened, the chip reads "Solve failed" and a red banner reads "Over-defined: N conflicting" with the names of the first members of the conflicting set.',
      },
      {
        kind: 'steps',
        steps: [
          'Press Resolve... on the red banner.',
          'The list "Conflicting set (N) - remove one to resolve" shows each member with its value, for example "Line 1 = 70 mm", marked CONFLICT. Hover a row to highlight what it binds in the sketch.',
          'Click the trash button on the member to remove (its tooltip reads "Remove this constraint/dimension to resolve the conflict"). The list refreshes with whatever conflict remains.',
          'The list closes by itself when nothing is left to resolve; Close hides it sooner.',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Redundant is different from conflicting: a redundant constraint adds nothing new but does not break the sketch. It shows as an amber row "N redundant (advisory)" with a Review... button, and its list reads "Redundant (N) - advisory, removal optional".',
      },
      { kind: 'image', slot: 'resolve-panel' },
    ],
    images: [
      {
        slot: 'resolve-panel',
        file: 'resolve-panel.webp',
        alt: 'The over-defined banner and the conflict list with its CONFLICT rows and trash buttons',
        captureNotes: 'Open a sketch that already holds two contradicting dimensions on one line (60 mm and 70 mm; a dimension added in the app is taken back, so seed it into the sketch - the dev seed __seedConflict does this on the demo sketch); press Resolve... and capture the chip "Solve failed", the red "Over-defined: 2 conflicting" banner and the open "Conflicting set (2) - remove one to resolve" list with its trash buttons and Close.',
        status: 'needed',
      },
    ],
    keywords: 'over-defined overdefined conflicting conflict constraint dimension resolve redundant solver failed dof sketch stuck red banner remove rejected conflicts with',
    contextKeys: ['mode:sketch'],
    relatedTopicIds: ['keyboard-shortcuts'],
    sinceVersion: '0.36.0',
  },
  {
    id: 'missing-toolpath',
    title: 'A toolpath vanished',
    category: 'troubleshooting',
    summary: 'If an operation points at a loop, hole or face that is no longer in its geometry, it turns red and names what is missing instead of drawing nothing.',
    sections: [
      {
        kind: 'paragraph',
        text: 'An operation remembers exactly which loops, holes or edges it cuts. If the geometry it points at is rebuilt or removed so that a picked item is gone, generating the operation fails: its row gets a red badge, and the badge and the bottom console name what is missing, for example "Contour loop \'<id>\' no longer exists in the selected geometry scope." The console also shows "1 operation failed".',
      },
      {
        kind: 'steps',
        steps: [
          'Hover the red badge on the operation row, or open the bottom console, to read which item is missing.',
          'Open the operation and go to its Geometry tab.',
          'Pick the loops, holes or faces again on the current geometry, then generate it (G).',
        ],
      },
      {
        kind: 'paragraph',
        text: 'Operations on a body built on the Model tab react when the model changes: if a face or body they use moved, they turn amber (outdated) with a note on the badge saying what moved; if the geometry is gone, they turn red (degraded) and the badge shows a note, or "Degraded - referenced model geometry is gone; re-select geometry.". A degraded operation keeps showing its last toolpath, and Post Process refuses it with "Operation "<name>" is degraded - its model geometry changed; re-select geometry and recompute before posting."',
      },
      { kind: 'image', slot: 'orphan-error' },
    ],
    images: [
      {
        slot: 'orphan-error',
        file: 'orphan-error.webp',
        alt: 'An operation with a red error badge whose tooltip names a loop that no longer exists',
        captureNotes: 'Make a Contour on a loop, then leave its geometry without that loop (rebuild or replace the geometry) and generate it; capture the red badge on its tree row with the tooltip showing the "... no longer exists in the selected geometry scope." message, plus the console line "1 operation failed".',
        status: 'needed',
      },
    ],
    keywords: 'toolpath vanished disappeared missing gone empty no toolpath loop no longer exist orphan re-select reselect geometry tab stale selection degraded',
    contextKeys: ['workspace:cam'],
    relatedTopicIds: ['generation-failures', 'operation-sources', 'outdated-after-open'],
    sinceVersion: '0.36.0',
  },
])
