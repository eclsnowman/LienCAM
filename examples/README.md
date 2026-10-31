# LienCAM examples

These projects teach CNC setup and CAM through LienCAM's normal buttons and
fields. Open a part's `.camproject` with **Open project** to inspect its stock,
setups, tools and operations. The starter kit uses the built-in sample machine,
"Sample hobby router (GRBL)".

| Example | Teaches | Operations | Picture |
| --- | --- | --- | --- |
| [01 Fixture plate - M6 x 1](01-fixture-plate/fixture-plate.camproject) | Stock setup, mounting holes, M6 threads and edge finishing. | Face, drill, thread mill, contour, chamfer. | [Saved project](01-fixture-plate/reopened.png) |
| [02 Toe clamps](02-toe-clamps/toe-clamps.camproject) | Shallow recesses, screw holes and tabs holding the cut profiles. | Pocket, drill, contour. | [Saved project](02-toe-clamps/reopened.png) |
| [03 Soft jaws](03-soft-jaws/soft-jaws.camproject) | Grip profiles and clearance around imported vise workholding. | Face, pocket, two contours. | [Saved project](03-soft-jaws/reopened.png) |
| [04 Tool storage bar](04-tool-storage-bar/tool-storage-bar.camproject) | Two-sided machining, a flip about Y, G54 and G55. | Drill, bore and chamfer on each side. | [Saved project](04-tool-storage-bar/reopened.png) |
| [05 Name sign](05-name-sign/name-sign.camproject) | V-carved lettering and cutting the sign outline. | V-carve, contour. | [Saved project](05-name-sign/reopened.png) |
| [06 Knob and handwheel](06-knob-handwheel/knob-handwheel.camproject) | Imported 3D shape, roughing and complementary finishing strategies. | 3D rough, parallel finish, waterline finish. | [Saved project](06-knob-handwheel/reopened.png) |
| [07 Relief medallion](07-relief-medallion/relief-medallion.camproject) | Relief from a picture on a STEP blank, outline and screw holes. | Drill, operator stop, 3D rough, parallel finish, contour. | [Saved project](07-relief-medallion/reopened.png) |
| [08 Gear pair](08-gear-pair/gear-pair.camproject) | Involute gear sketches, bores and keyways in two setups on one taped and glued sheet. | Bore, pocket and contour for each gear. | [Saved project](08-gear-pair/reopened.png) |
| [09 Nested kit sheet](09-nested-kit-sheet/nested-kit-sheet.camproject) | [Nesting](../docs/wiki/Nesting.md) (EXPERIMENTAL), true-shape sheet packing and exploding placements for one tabbed contour. | Contour of seven thin kit profiles. | [Saved project](09-nested-kit-sheet/reopened.png) |
| [10 Leadscrew stepper mount](10-leadscrew-stepper-mount/) | [DXF/SVG import](../docs/wiki/Importing-files.md) and profile inspection. | Geometry only; add your own CAM. | [Source drawing](10-leadscrew-stepper-mount/Leadscrew_Stepper_Mount.svg) |
| [11 Screwdriver handles](11-screwdriver-handles/) | [STEP import](../docs/wiki/Importing-files.md) of the medium handle; the socket source is pending correction. | Geometry only; add your own CAM. | No saved capture. |
| [12 Tray](12-tray/) | [STEP import](../docs/wiki/Importing-files.md), walls and pocket inspection. | Geometry only; add your own CAM. | No saved capture. |
| [13 Thread-mill test](13-thread-mill-test/) | Three holes and three bosses with a matching [tool library](../docs/wiki/Tool-Library.md). | Geometry/tool library only; add your own CAM. | No saved capture. |

Rights: the examples are project content released under Apache-2.0 (rows in
[docs/release-licences.md](../docs/release-licences.md)). `07-relief-medallion/medallion.png` is
AI-generated within this project: a procedural image drawn by
`tools/examples/build-relief-medallion.mjs` (order WO-2379), not a photo and not
made by the project owner; the script accepts your own picture path to replace it.

This index reflects the current kit. Additional source parts start at 10. The auxiliary
`06-knob-handwheel/lobed-knob-source.camproject` is a modeling source with no
machining setups, saved as "Untitled Project"; open the numbered
`knob-handwheel.camproject` for machining.

## Posted G-code

[gcode/](gcode/) contains one combined program per machining project for UCCNC,
GRBL, grblHAL, LinuxCNC and Generic: eight projects x five dialects = 40 files.
Example 09 has no file in gcode/ yet; open it and post it yourself from
Post Process.
Filenames follow the saved `NN Title`, converted to a lowercase hyphenated stem,
then the dialect, for example `01-fixture-plate-m6-x-1-grbl.nc`.
The first comment identifies the LienCAM version, project and dialect.
Multi-setup programs pause between setups; both gear-pair setups cut the same
200 x 120 x 6 mm taped and glued sheet without moving it, as described in its part README.

These are reference programs for the walkthroughs. Review the stock, work
offsets, tools, feeds, speeds and workholding for your machine before use.
Import-only parts and the auxiliary modeling source have no program to post.

Regenerate from this checkout's application source (no prior build required):

```powershell
node tools/examples/post-all.mjs
node tools/examples/post-all.mjs --check
npx vitest run src/tests/tools/examplesGcode.wo2383.test.ts
```

The script uses headless Chromium, the production File Open loader, model
reference verification, staged Export recompute and `postProject`; it checks
that every enabled operation reaches every program. It never connects to a
controller. `--check` names missing, changed or extra files and exits nonzero.
When a post or example changes, regenerate the G-code in the same commit.
See `src/tests/evidence/WO-2383/README.md` in the development repository for
byte-comparison, negative-control, privacy-scan and GRBL parser evidence.

## Starter tools

In **Tool Library**, choose **Import** and select one of:

- `tools/starter-tools-metric.json`: 3 mm and 6 mm end mills, a 3 mm drill,
  a single-point thread mill, a 60 deg V-bit and a 90 deg chamfer mill.
- `tools/starter-tools-inch.json`: 1/8 inch and 1/4 inch end mills, a 1/8 inch
  drill, a single-point thread mill, a 60 deg V-bit and a 90 deg chamfer mill.

Both use LienCAM's native JSON tool format: dimensions and feeds are stored in
mm and mm/min, including the inch-sized tools. Names describe nominal cutter
sizes. These original example records are starting points; set feeds, speeds,
stickout and tool numbers for the material and machine you actually use.
Import creates a separate named library. Saved projects embed the tools their
operations use, so the example can be opened without first importing a library.

## Build scripts

Part scripts import `withExampleDriver` from `tools/examples/lib/drive.mjs`.
Run them from the repository root after installing dependencies and building:

```powershell
npm ci
npm run build
node tools/examples/lib/drive.mjs --self-check
```

The driver serves this checkout's `dist/` on a temporary loopback port and uses
headless Chromium. Install the Playwright browser with `npx playwright install
chromium` if needed. It never connects to a controller.

```javascript
import { withExampleDriver } from './lib/drive.mjs'

await withExampleDriver({ outDir: 'examples/01-my-part' }, async (driver) => {
  await driver.newProject()
  await driver.setStock({ width: 100, height: 80, depth: 12 })
  await driver.importTools('examples/tools/starter-tools-metric.json')
  // Each part supplies its own production UI actions and state predicates.
  await driver.step('Build the part', async (page) => {
    // Click/fill the real model or CAM UI here.
  }, (state) => state.project.geometry.length > 0)
  await driver.saveAndReopen('my-part.camproject')
})
```

`step(label, action, check)` runs an action, then waits for its predicate against
the application's persisted state before continuing. `page` is the Playwright
page; `readState()` reads the app's OPFS autosave (or its localStorage fallback)
without writing state. `saveAndReopen()` uses Save and Open in independent browser
contexts and compares the stock, setups, geometry and embedded tool records.
It leaves the driver on the reopened page. Outputs include `steps.json`, the
saved project and `reopened.png`; existing outputs are removed before regeneration.
Failed steps write a failure log and capture. `--negative-control` deliberately
expects the wrong stock width and must exit with an error at that check.
