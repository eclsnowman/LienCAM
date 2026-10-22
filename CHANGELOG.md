# Changelog

All notable changes to LienCAM are recorded here. The layout follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

LienCAM is in alpha. Expect rough edges, and expect project files from one alpha to
need re-saving in the next; nothing is promised to keep working before 1.0. Unreleased versions are marked below.

## [Unreleased]

## [0.37.0-alpha.3] - 2026-10-22

The third public alpha: cutting and toolpath quality, measured on a 56-job machining benchmark
that covers all 16 operation types.

Release notes: `docs/release/notes-0.37.0-alpha.3.md`.

### Added

- 2D and 3D adaptive were rebuilt for the new machining kernel: every tuning number comes from one recorded policy, and the kernel plans the same moves as before (26 adaptive jobs, posted G-code byte-identical).
- Final Part Deviation in Simulation compares the simulated finished part with the model and colors leftover material and gouges; it names the operation it is waiting for, Compare again shows a check stamp, and it works with stock simulation on or off.
- Simulation can show a short toolpath trail around the moving cutter, with adjustable lead and trail lengths.
- Dimensioned drawings of modeled parts, imported STEP parts and STL meshes: standard views with hidden lines dashed, detail view, balloons, linear/angle/radius/diameter dimensions with tolerances, editable title block and general tolerance table, saved with the project, with Export PDF and Export DXF.
- A broken drawing dimension can be relinked end by end with a Was/New comparison, and Undo puts it back.
- Chamfer from model: pick a modeled chamfer (or all on a part) and the Chamfer operation takes the edge path, width and depth from the model; a bevel on one edge cuts only that edge, and freshly modeled bodies work through Section at Z.
- Face has an Inward spiral pattern for decorative flat finishing.
- Two setups on one machine can share G54 and post as separate files; a Combined post with a shared offset is still refused, and the setup dialog accepts an occupied offset with a plain note.
- Project notes in Properties, and each setup's notes read-only on Control.
- German, Spanish and French interface languages, labelled machine-translated, with a sourced CNC glossary and English fallback; G-code, posted files and controller messages stay English.
- A problem report can start at the failure, prefilled with the error and the steps, with an optional screenshot and what is needed to reproduce it.
- Experimental local MCP server for modeling commands in the desktop app, off by default, loopback-only and token-guarded, with an on-screen indicator; no CAM or machine commands.
- On UCCNC, the bridge logs controller versions and board type on every Open and checks a shipped compatibility record: a known-bad combination is refused before Open, an untested one gives one console line.
- On x86-64 Linux, Connect starts the UCCNC bridge under Wine by default in its own prefix (not yet proven on a real board); a native Linux bridge is included, opt-in with LIENCAM_BRIDGE_NATIVE=1.

### Changed

- 3D adaptive plans 2-8x faster with an identical toolpath (knob 493 s -> 62 s, Form cylinder 291 s -> 92 s; whole benchmark 1,668 s -> 664 s).
- Rapids end before the fed lead-in, and over an already cleared floor the tool hops at a low safe height; a link becomes a rapid or hop only where its clearance is proven, otherwise it stays at feed.
- 3D adaptive entries start at the material under the tool instead of the stock top, on by default: air time 32% -> 16% on the test box and 32% -> 17% on the sphere, cycle time about 18% shorter.
- 3D adaptive arc joins are tangent to their neighbours, on by default: kinks on the sphere 538 -> 10; posted programs get larger.
- Adaptive steers away from walls more smoothly: stock-edge direction flips 15.2% -> 7.1%, reversals 69 -> 33 on the test parts.
- V-carve links its cuts with far fewer repositions (example 78 -> 18 and 169 -> 40), with the carved surface within 0.0004 mm of before.
- Operations that depend on remaining stock read it from one shared source built from the enabled operations before them.
- The Model page shading on a large STEP part runs in the background: longest freeze 18.9 s -> 0.4 s, shading identical.
- CAM Import geometry reads STEP names without a second full read (large part: names 7.2 s -> 1.7 s, import 36.6 s -> 30.5 s; tray part 1.55 s -> 0.40 s).
- A Model recalculation reuses an unchanged imported STEP instead of reading it again.
- The STEP reader skips its repair step on shapes that are already valid (large part 7.2 s -> 2.5 s, tray part 2.8 s -> 0.5 s), model unchanged.
- Form > From body runs in the background; its remesh on a large part dropped from 14.4 s to 7.8 s, and on a complex STEP part of about 49,000 faces it builds a cage you can shape (about 30-45 s on a big part) instead of refusing.
- When the UCCNC controller DLL changes for a board, Connect waits for a second press after naming both versions and how to go back; with several UCCNC installs and none chosen, the install recorded for the board is used instead of the newest.
- A firmware update started by the controller on Connect is waited out with one console line at start and one at the end; a failed update is never retried by itself.
- A refused Load says its full sentence once, in the console; the Control top row no longer runs off or repeats it, and the line under Load reads "Load refused - see the console."
- Edit macros lists the G30 P1-P4 park buttons with your own macros, in the Macros panel order.
- The Post dialog reopens on the post and operation ticks you left.
- Imported inch tools are rounded on import (12.699999999999998 mm -> 12.7 mm).
- The Full Suite example's notes are written for the operator.

### Fixed

- Adaptive rapids no longer pass through standing stock: a 2D move to the next level or region rises straight up before crossing (rapids into stock on the benchmark pocket 5 -> 0), and a 3D rapid that dipped into uncut stock was removed.
- An adaptive region that cannot cut says why in one line, and an adaptive operation with no moves ends in error instead of Ready.
- A 3D adaptive rest pass whose tool has nothing left to cut says so plainly instead of blaming the stock box.
- 2D and 3D adaptive quality restored after a steering fault: straighter cuts at walls, no stray lifts at inside corners.
- Two 3D adaptive roughing cases that could stop with an internal error now generate.
- A second REGEN ALL in a row no longer crashes the page.
- The Properties panel no longer shows a false "Cannot resolve ... no longer exists" height refusal on operations whose geometry is a modeled body.
- 3D Rough generates on the Form cylinder and torus starters with default settings by entering from outside the part within the stock.
- A 3D finish with lifted rapids stays current after compute and after reopen, so it is not recomputed on every open.
- An operation with nothing left to cut posts one comment line and no motion; an export of only empty operations writes only those comment lines.
- The shipped example programs (soft jaws, knob, medallion) match what the app posts again, and every shipped example opens with its toolpaths ready.
- Form > From body no longer crashes the page on a large STEP part; Form symmetry turned on after edits never changes the cage.
- After a Feed Hold, Stop no longer leaves the controller at 0% feed with moves accepted but none run (simulator/desk proven).
- Feed Hold no longer prints a false soft-limit line; a Stop/Reset that ends a held move is named.
- "Cycle complete" appears only after a file actually ran; after a refused Load is fixed the status reads "Ready. CYCLE START runs the program from line 1."
- The phone pendant reconnects after you leave the page and come back, and a held continuous jog is released when the page hides.

### Known limitations

- Control through UCCNC (UC100 / AXBB-E) is proven on one Windows machine; the Linux route under Wine is not yet proven on a real board.
- The native Linux bridge is opt-in (LIENCAM_BRIDGE_NATIVE=1) until it is proven on a real board; Linux uses Wine by default.
- Before you connect LienCAM to your controller, open UCCNC once and let it connect. Do the same after every UCCNC update. If UCCNC shows 'Firmware update in progress', let it finish.
- LinuxCNC is proven on the LinuxCNC 2.9.4 simulator only; GRBL and grblHAL are not hardware-verified.
- Recent machine fixes may have been proven only on a simulator.
- A bridge restart loses the machine position; re-home afterwards.
- CAM Import geometry on a very large STEP part can still take up to about 30 s.
- German, Spanish and French are machine translations; some screens may still show English or crowd their labels.
- The MCP server is experimental, desktop-only and covers modeling commands only.
- The Windows installer is unsigned, so SmartScreen shows a warning on first run.
- The Linux and macOS builds are unsigned and untested; the macOS build is for Apple Silicon only.
- Project files from one alpha may need re-saving in the next; nothing is promised to keep working before 1.0.

## [0.36.0-alpha.2] - 2026-10-16

Release notes: `docs/release/notes-0.36.0-alpha.2.md`.

### Added

- Move Hole relocates a complete recognized hole on STEP or STL by a typed XYZ delta on the same face, preserving every step; tree Edit reopens it and Undo restores it.

- On an empty project, the project picker offers Start with an empty project.

- Chamfer has an opt-in clear-space approach and lead-out that check retained material, available tool and fixture geometry while preserving authored heights.
- Form Rotate can turn selected faces around a picked cage edge or an X, Y or Z axis through a cage point.
- Resize Hole can change the selected counterbore step on STEP and STL bodies while keeping the other step where it remains.
- STL files with zero-area triangles or open edges can open in Model as meshes, with unusable triangles removed and the import result explained.
- Run macro is a Machine actions operation that posts the selected machine macro at its place in the operation list.
- The program listing distinguishes headers, comments and move types with colors enabled by default and a Settings switch to turn them off.
- The macro editor lets you pick the output a macro drives, so its enabled button follows that output's reported state.
- Example machines include hidden, editable Part swap, Spindle warm-up and Part trace macros that you can inspect and enable.
- Post Process lets you name a combined export or each separate file, retaining a typed extension and adding the post extension when none is supplied.
- Sketch patterns, mirrors and copied transforms retain editable definitions, keep copies linked to their source, and survive save and reopen in CAM and Model.
- Edit pattern changes stored values, including expressions, while Suppress, Restore and Break pattern control individual copies or release their links.
- About is available from the main menu and links to the project and its releases in the system browser on desktop or a new browser tab.
- At startup, the desktop app checks for a newer LienCAM release and, when one is published, names it in the console with a link to its release page. Nothing downloads or installs by itself.
- Help > Report a problem builds a local diagnostic ZIP for review, with optional details and files included only when selected.
- You choose whether to open a GitHub issue with a previewed prefill, and Settings lets you turn local diagnostic history off or clear it.

### Changed

- Push/Pull and pocket-depth edits carry neighboring fillets and chamfers with the face, including supported drafted walls and cone feet; an edit that cannot be built leaves the body unchanged and says why.
- Fillet and Chamfer explain unsupported face picks; Resize Hole tree Edit reopens an imported hole at its current diameter, and says why if an upstream change removed the hole.
- Load pressed during a moving MDI line waits for completion and idle before replacing the program, with Stop or a fault canceling the wait.
- A refused probe start over an existing stop replaces that stopped reason with one Did not start message.
- Deleting a sketch source removes its dependent copies and offsets, with Break available to keep them as free geometry first.
- Open uses one project picker with desktop recents, project thumbnails, examples and Browse, plus an option to go straight to the file browser.
- First start and Help use the same picker, and returning desktop users see recents and Browse with examples collapsed.
- Help and wiki instructions and pictures cover Form rotation, editable sketch patterns, ordered Run macro actions, deferred Load and the revised right-drag behavior.
- Installation guides describe the Windows installation choices and shared PC data for portable builds, and Linux downloads link to their installation guide.
- Download information identifies Windows 10/11 and Apple Silicon macOS, and bug-report instructions explain that public attachments are world-readable.

### Fixed

- On Control, the position chip and the TOOL readout always name the same tool; the simulator reports the last tool it actually ran.
- Operation and Post messages name loops by their Geometry-list name and show no internal codes; the Post dialog's All operations box shows a mixed selection.
- An STL plate can be the source for Drill, Bore and 2D Adaptive like a STEP part, including All Parts with two identical copies: the copy you tick is the one cut.
- Opening a model and pressing Finish without an edit keeps its operations ready.
- Pocket 2D finds a helix entry around an island in a plain square; when no helix fits, it says so in one line and cuts nothing instead of plunging.
- Height fields show rounded values (15, 5) instead of long decimals.
- Undo right after Finish reopens the sketch with everything in it; Fillet and Chamfer report radii in your display units.
- After Undo or Redo the Model console names the step that was undone or redone, and a console that cannot save never blocks Undo.
- Messages name parts, faces, sketches and operations by their names, not internal ids.
- The Control spindle panel header reads Spindle with the live rpm on one line, so the two no longer wrap or overlap.
- A Load that is refused now disarms the file loaded before it: CYCLE START stays greyed until a file is armed, instead of running the old file. Canceling a Load that waits behind a moving MDI line keeps the old file as it was.
- 2D adaptive repositioning compares eligible stay-down wall routes and lifts by estimated machining time, including the wall cleanup each choice leaves.
- Stepped-hole recognition includes connected cylindrical and conical bands, keeping the complete hole selectable through moves, repeat resizes and CAM face picks.
- Shell reports its resulting-piece information once in the Console after Apply or Edit.
- On STEP holes, Push/Pull offsets cylindrical walls and countersink cones in either direction; a cone keeps its angle.
- On STL parts, Defeature removes recognized round bosses with their foot fillets and domes, and Push/Pull can move a flat face beside a curved rim.
- Form conversion preserves round imported fillets, pocket blends and domes within its reconstruction tolerance.
- Form > From body accepts an open STL; the source mesh is hidden while that Form feature is active and returns on Undo or rollback.
- The disabled Relief button explains why Relief is not yet available on a mesh body.
- A subtraction that would remove the whole target explains that nothing would remain and leaves the model unchanged.
- Model Import accepts an additional STL, and Boolean combines STL with STEP or another STL in either target/tool direction.
- An STL consumed by a Boolean is hidden while the feature is active and returns on Undo or rollback; changing the selected tool validates the body shown.
- STLs added through Model Import become faceted solids for later modeling and STEP export.
- Run from line names a different or unknown spindle tool and offers a tool change first or a start with the fitted tool; Cancel moves nothing (simulator/desk proven).
- Home guidance allows starting on the home switches and no longer asks for a preliminary move off them.
- Feature probing on the UCCNC simulator follows the native route's from-above plan; a route that cannot run that plan reports why and moves nothing (simulator/desk proven).
- Phone probing shares the desktop planner, setup values, calibrated tip radius and step guidance (simulator/desk proven).
- Tool Z and custom probe routines on the UCCNC simulator include the native route's guarded steps (simulator/desk proven).
- The header keeps About, machine status and E-STOP visible through the compact-label width range.

- Imported fillet and chamfer chains can change size or be removed as a whole on STEP and STL parts; removing a boss also removes its foot fillet.
- STL Push/Pull edits reopen from their tree row with the stored distance, and Undo keeps one edit even when pressed quickly.
- Push/Pull can move an STL counterbore floor; Chamfer no longer offers a cylinder seam as a sharp edge.
- Hole on a curved STEP face drills along the surface normal where you click.
- The Model screen imports every solid in a multi-solid STEP as its own body and reports the count; Cancel during import drops the import.
- Draft beside fillets keeps their radii. Shell can open a filleted, pocketed part into separate pieces when that is the resulting shape.
- On UCCNC, Rapid % scales each G0 before it is sent to the board. Cutting moves keep their programmed feed, and Feed % still applies on top. Moves already sent keep their sent speed.
- A file refused by Load for a machine-side reason stays available after MDI or a completed or failed run. Fix the cause, then CYCLE START rechecks and arms that file from line 1, never the finished old file; an accepted program still ready or held stays in place (simulator/desk proven).
- Continue is the action on both guided tool-change and Park + clamp cards; CYCLE START is disabled at the clamp card with a hint to press Continue.
- The sample router simulator checks loaded programs against its default work zero and declared travel.
- The built-in simulator touches with the probe tip radius of the tool in the spindle, so compensated Bore, Boss, Edge and Corner measurements read the simulated part size.
- Post Process recomputes the outdated operations in scope before preview or export, in upstream order, and reports what it recomputed. Never-generated operations stay omitted; a real compute error names the operation.

- 2D adaptive clearing keeps the selected climb or conventional cutting side during entry and bulk clearing.
- A counterbore extended to the pilot bottom or Through becomes one bore, and repeated countersink pilot edits keep the original outside rim until the bore consumes it.
- Leading, adjacent and trailing macro calls keep their execution order, and explicit coolant or output commands after a macro are honored.
- A tool-change hold before any cutting asks for the first tool, and a later same-tool change says that it asks for that tool again.
- The UCCNC bridge waits briefly for an override readback to settle before reporting a clamp.
- A first refused probe start leaves the step card and preview still, with the reason in the console.
- Smart Dimension preview arrows match committed dimensions across zoom levels, and a thin connector links the moving readout to its measurement preview.
- A right-click menu closes when a right-drag pan starts on browsers that open the menu on button press.
- A curved STL opened from the Model chooser or with Edit as model opens in the Model screen, however many models the project has, and Undo after Finish leaves no stray Plate.
- An imported DXF or SVG layer opens in Sketch exactly where it sits on the part.
- Push/Pull applies on imported STEP and STL faces that carry countersinks, chamfers or blends; a move the geometry cannot make restores the part and says why in the console.
- A Push/Pull inserted above a Fillet rebuilds the Fillet and the features after it on the moved face; when the picked edge is truly gone, the tree row and the console say so in plain words.
- Model messages are plain: Revolve explains why Apply is unavailable and starts at 360 deg, From body says why it could not convert a body and what to try, Resize hole names the hole it changed, and Shell refusals read in full with a next step.
- A reopened project regenerates and posts edited imported STEP and STL models without a visit to the Model screen.
- 3D Rough's straight-plunge refusal says where it stopped, why, and a remedy that can work for that setup.
- Every shipped example opens with all of its operations ready, under its own name.
- Opening the shipped examples no longer creates duplicate tool libraries, and importing an exported tool adds it once to the selected library (it says so when the tool is already there). The Tool Library shows 6.35 mm as 6.35 and closes with Escape.
- A partial post leaves every operation exactly as it was, and the Output Scope stays as you left it through Export, Send to Control and Setup Sheet; New clears the old console messages.
- After Stop/Reset the simulated spindle reads 0 rpm, and resuming a named tool-change hold shows the fitted tool in the Tool readout.
- The Generic post is named Generic and starts every program with G90 and G21 (G20 for inch jobs).
- The Post dialog's All operations box shows checked, mixed or unchecked and never widens what is exported; Escape closes the dialog.

### Known limitations

- Control through UCCNC (UC100 / AXBB-E) is Windows-only and proven on one machine.
- Before you connect LienCAM to your controller, open UCCNC once and let it connect. Do the same after every UCCNC update. If UCCNC shows 'Firmware update in progress', let it finish.
- LinuxCNC is proven on the LinuxCNC 2.9.4 simulator only; GRBL and grblHAL are not hardware-verified.
- Recent machine fixes may have been proven only on a simulator.
- A bridge restart loses the machine position; re-home afterwards.
- The Windows installer is unsigned, so SmartScreen shows a warning on first run.
- The Windows installer's Desktop shortcut, `LienCAM.lnk`, replaces any existing Desktop shortcut with that name, and uninstalling removes it.
- Uninstalling leaves the installer's download cache, `%LOCALAPPDATA%\liencam-updater` (about 170 MB); you can delete that folder by hand.
- The Linux and macOS builds are unsigned and untested; the macOS build is for Apple Silicon only.
- Project files from one alpha may need re-saving in the next; nothing is promised to keep working before 1.0.

## [0.36.0-alpha.1] - unreleased

The first public alpha. Each capability carries a status word: SUPPORTED (works, and is
tested end to end), ALPHA (works, but expect gaps) or EXPERIMENTAL (try it, do not rely
on it). The GitHub Release text for this version is `docs/release/notes-0.36.0-alpha.1.md`.

Licence: LienCAM's own code is Apache-2.0. The adaptive-clearing engine (ported from
FreeCAD's Adaptive2d) is LGPL-2.1-or-later and OpenCAMLib is LGPL; both are marked modules.
The LinuxCNC gateway is a separate program under GPL-3.0-or-later. See NOTICE and
THIRD_PARTY_LICENSES.md.

### Added

- Sketch (constraints, dimensions, text, SVG/DXF import) - SUPPORTED
- Model: extrude, revolve, sweep, loft, fillet, chamfer, shell, draft, hole, booleans; STEP/IGES/STL import; STEP/STL export - SUPPORTED
- Form (SubD organic modelling) - ALPHA
- Relief from an image (raise / emboss / engrave) - ALPHA
- Mesh lab (STL/OBJ/3MF edit, mesh booleans) - EXPERIMENTAL
- 2.5D ops: face, contour, pocket, adaptive, drill, bore, thread mill, engrave, V-carve, chamfer - SUPPORTED
- 3D ops: adaptive rough, parallel, waterline, scallop, steep/shallow, pencil - ALPHA
- Nesting - EXPERIMENTAL
- Simulate (stock removal) - SUPPORTED
- Post: UCCNC, GRBL, grblHAL, LinuxCNC and Generic dialects - SUPPORTED
- Control on the built-in simulator - SUPPORTED
- Control on AXBB-E / UC100 (Windows bridge; needs the controller's own software installed for its DLL) - ALPHA - one machine proven
- Control on LinuxCNC (gateway) - EXPERIMENTAL - simulator only
- Control on GRBL / grblHAL (Web Serial) - EXPERIMENTAL - not hardware-verified
- Probing routines, tool setter, guided M6, Z surface map, rotated work offsets, pause-move-resume - ALPHA
- Phone pendant - ALPHA - tested on one machine

### Fixed

- Saving, closing and reopening a project no longer changes the posted G-code, and a Drill
  operation stays ready after reopen.
- Operations no longer read "outdated" right after they compute, so Post Process no longer
  refuses them as out of date.
- Post Process offers every dialect, not only the active machine's.
- Restore bundle loads machines, the active machine, tools, settings, work offsets,
  macros, parks and probe routines after reload, including before a fresh profile's
  first save. Restored recipe templates, cutting data and fixtures survive later
  saves, reopening and backups.
- Desktop backups carry machine-connection launch settings and the bridge port;
  the installed shortcut uses them without a hand-edited .bat. Help explains the
  UCCNC installation, .pro copy and Windows Security steps needed on a rebuilt PC.
- Windows installer upgrades preserve the existing setup, including template,
  cutting-data and fixture values through a write, reopen and new backup.
- Pending changes survive a normal close. Failed data loads hold back saves,
  protecting the stored copy from defaults, and report the failure in the console.
- The geometry picker offers .igs and .iges. Committed STEP rotations re-derive
  features once; upside-down level features stay machinable, while features that
  no longer face up on a partly tilted part cannot be cut from above.
- An unavailable planning-grid plane no longer blocks creating or saving a setup.
  Entered engraving depth needs no extra confirmation checkbox; creation still
  needs a resolved height preview.
- Duplicate tool numbers can be resolved on the Post Process screen with saved
  per-program numbers, leaving the library unchanged. Control > Load and the
  tool-change card name the program's tool when posted from the open project;
  files opened from disk keep the library name lookup.
- Oversized waterline parts compute in tiles; the console reports the tile count
  and any coarser spacing needed for a cutter too wide for a tile.
- Model panel contents scroll at 1440 and 1680 pixels. Loaded vise and clamp
  shapes prevent the false soft-jaws gap-contact warning while retaining real
  contact reports and the bounding-box fallback when a shape cannot be read.
- Early setter touches no longer show a separate warning; successful fine touches
  use two shorter result sentences covering early contact, table prediction,
  retract and replacement measurement. Typed T19 M6 on the built-in simulator runs
  the guided tool change. The gear pair uses one shared 200 x 120 x 6 mm taped and glued sheet;
  both contours cut 0.5 mm below its bottom.

### Machine control details

- Est. remaining uses the execution time of moves still left while held, including
  their feeds, rapids and dwells. It no longer reads 0 s just because elapsed time
  exhausted the estimate while motion remains.
- CYCLE START arms a loaded program from line 1 when needed, including after a
  completed run, Stop/Reset or reconnect; a chosen start line or kept stop still wins.
  A refused Load leaves an accepted program in place and prints its reason once.
- The built-in simulator runs posted G81/G82/G83 drilling with G98/G99 return
  levels, modal hole repeats and G80 cancel. It follows the program's G54-G59,
  and Path check names that work offset.
- The machine picker offers the Default machine first and selected, without a
  premature machine-change announcement. A fresh post loaded from the same project
  reads current and keeps the matching Intended stock.
- A GRBL tool-change hold names the tool to fit before CYCLE START.
- The built-in simulator models a machine's stated tool setter. Its top uses the
  recorded reference-tool contact when below the stated Z, with stated Z as fallback.
- Automatic posted stops lift a tool left below safe retract height before M5;
  3D adaptive roughing also ends raised. Custom program ends remain verbatim.
- 2D Face uses model top as its smart bottom when a model is present. A typed
  WCS plane overrides it; Use model top restores the smart choice.
- Posting for another controller omits the project machine's own vacuum word;
  posting in its own controller format retains it.
- Every explicit M0 holds the program; CYCLE START resumes it, and Stop/Reset at an M0 ends it.
- The UCCNC post adds no redundant M0 after `T# M6`; Stop program on a program's tool-change card ends the job.
- On UCCNC, **From line** and **Plan** restart a posted setup at its original file line, restoring the tool, work offset and spindle.
- The amber **Held** chip marks an M0, controller Feed Hold or a stationary tool-change card waiting for you.
- The listing uses original file line numbers; the 3D view, progress, feed and spindle readouts follow the executing move.
- Probing-screen **Pause**, **Resume** and **Stop** act on probing only, leaving the loaded program in place; saved probing settings for the connected machine apply immediately, with operator overrides preserved.
- The PROBE lamp appears on every probing screen; inside-feature probing uses probe seeks, and **Retry measure** re-probes at the setter without another park move.
- On UCCNC, a G28 loaded into Control returns to the stored home position in the machine's configured homing order.
- The experimental LinuxCNC route shows its tool-change card when LinuxCNC is waiting for a tool.
- The probe picture uses its real height when it is at the part; each approach
  to a face is one probe move.

### Starter examples

- **Full Suite** is first in **Try an example** on desktop and in the browser;
  example filenames use plain names.
- The tool storage bar drills each hole from one side, the gear profiles cut
  through, and the knob combines roughing and finishing to make the saved shape.
- Eight machining examples have G-code for all five dialects; other parts need
  your own CAM or posting.

### Known limitations

- Control through UCCNC (UC100 / AXBB-E) is Windows-only and proven on one machine.
- LinuxCNC is proven on the LinuxCNC 2.9.4 simulator only; GRBL and grblHAL are not hardware-verified.
- Machine fixes made close to a release may have been proven only on a simulator; each release gets a short in-air run on one real machine before it ships.
- A bridge restart loses the machine position; re-home afterwards.
- The Windows installer is unsigned, so SmartScreen shows a warning on first run.
- The Windows installer's Desktop shortcut, `LienCAM.lnk`, replaces any existing Desktop shortcut with that name, and uninstalling removes it.
- Uninstalling leaves the installer's download cache, `%LOCALAPPDATA%\liencam-updater` (about 170 MB); you can delete that folder by hand.
- The Linux and macOS builds are unsigned and untested; the macOS build is for Apple Silicon only.
- Project files from one alpha may need re-saving in the next; nothing is promised to keep working before 1.0.

**What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
this note comes off.

[Unreleased]: https://github.com/eclsnowman/LienCAM/compare/v0.36.0-alpha.1...HEAD
[0.37.0-alpha.3]: https://github.com/eclsnowman/LienCAM/releases/tag/v0.37.0-alpha.3
[0.36.0-alpha.2]: https://github.com/eclsnowman/LienCAM/releases/tag/v0.36.0-alpha.2
[0.36.0-alpha.1]: https://github.com/eclsnowman/LienCAM/releases/tag/v0.36.0-alpha.1
