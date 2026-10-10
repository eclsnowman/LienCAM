# Changelog

All notable changes to LienCAM are recorded here. The layout follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

LienCAM is in alpha. Expect rough edges, and expect project files from one alpha to
need re-saving in the next; nothing is promised to keep working before 1.0. The first entry below is the first public release.

## [Unreleased]

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
- The Linux and macOS builds are unsigned and untested; the macOS build is for Apple Silicon only.
- Project files from one alpha may need re-saving in the next; nothing is promised to keep working before 1.0.

**What has been tested on real hardware.** I've tested LienCAM on my own router, which runs UCCNC with an
AXBB-E controller. I don't own a GRBL, grblHAL or LinuxCNC machine, so those routes have only been tested
against simulators (grbl-sim and the LinuxCNC simulator), not on real hardware yet. If you run one of those
machines, your test reports are exactly what we need - and once people have confirmed them on real machines,
this note comes off.

[Unreleased]: https://github.com/eclsnowman/LienCAM/compare/v0.36.0-alpha.1...HEAD
[0.36.0-alpha.1]: https://github.com/eclsnowman/LienCAM/releases/tag/v0.36.0-alpha.1
