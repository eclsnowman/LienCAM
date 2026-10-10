# The fresh-PC journey

`fresh-pc-journey.mjs` checks that a person who has just installed LienCAM can
actually do the whole job with it: set up their machine, build a project, save
it, post it and run it. It drives the **packaged desktop app** through its own
buttons, menus, dialogs and keyboard with Playwright, on a brand-new, empty
profile, and writes a PASS or FAIL line for every step.

It never reaches past the user interface: no store writes, no test hooks, no
hand-built payloads sent to an engine. The only things it does that a person at
the keyboard would not are sizing the window to 1920 x 1080 (so every picture
has the same frame) and answering the operating system's file dialogs with a
path (a person types or clicks that path; the app's own code reads and writes
the file).

## What you need

- The source tree (this repository) with its dependencies installed:
  `npm ci`. Playwright comes with the dev dependencies; the journey uses
  Playwright's Electron launcher, so no separate browser download is needed.
- Windows, macOS or Linux. The commands below are for Windows PowerShell.

## 1. Build the unpacked app

```powershell
npm run package:dir
```

This builds the renderer (`npm run build`) and then packages it with
electron-builder without an installer. The app lands in:

- Windows: `release\win-unpacked\LienCAM.exe`
- Linux: `release/linux-unpacked/liencam`
- macOS: `release/mac/LienCAM.app/Contents/MacOS/LienCAM`

## 2. Run the journey

```powershell
node e2e/fresh-pc-journey.mjs --app release\win-unpacked\LienCAM.exe --out journey-out --shots
```

| Option | Meaning |
| --- | --- |
| `--app <path>` | The packaged app's executable (required). |
| `--out <dir>` | Where the results go (required). |
| `--shots` | Also save the README/wiki scene set to `<out>/scenes/`. |
| `--samples <dir>` | The sample files to import (default: `Sample Parts/` beside `e2e/`). |
| `--profile <dir>` | The profile directory to use (default: `<out>/profile`). It is emptied before the run. |

The app runs in a visible window; leave the mouse alone while it works. A full
run takes roughly 15 to 30 minutes, most of it the simulated machine running the
posted program in real time.

The exit code is 0 when every step passes and 1 otherwise.

## What the steps do

1. **First launch** on an empty profile: the app opens an untitled, empty
   project and Settings > User Data lists nothing stored.
2. **Settings and a machine from scratch.** Display units (inches, then back to
   mm, read back from the status bar) and theme. A new machine in the Machine
   Library (name, controller, travel, spindle speeds, rapid, tool changer), set
   as default and used for the project; then Control > Machine > Definition
   (soft limits, homing direction, Safe Z), saved. The app is closed and
   started again on the same profile, and the machine and its values are
   checked.
3. **Tool Library:** a 6 mm end mill, a 5 mm drill and a 90 degree V-bit, saved;
   the library is closed and reopened and all three are still there.
4. **Design.** New project; in Sketch a circle and a rectangle, each given a
   dimension (100 x 60, 20 mm circle); the sketch is converted to a model,
   extruded 15 mm and given a 6 x 5 mm hole. The body's volume, read from the
   Model workspace, proves every dimension held. Then a STEP, a DXF and an SVG
   from `Sample Parts/` are imported.
5. **Setup and toolpaths.** The auto stock's offsets, a setup with its work
   offset (G54, top front-left of the stock), then Face, 2D Adaptive Clearing,
   2D Contour, Drill, 2D Pocket and a Parallel (3D) finish on the imported
   curved STEP body, and REGEN ALL. Every operation must end ready.
6. **Simulate** the whole setup with stock removal on, at 100x, to the end of
   the timeline.
7. **Save, close, reopen.** The project is posted (GRBL) and saved; the app is
   closed and started again; the project file is opened; REGEN ALL; the
   operation list, the setup's cycle time, the toolpath legend and the posted
   G-code bytes must be identical.
8. **Post with every shipped dialect.** The Post Process picker lists the
   machine's own dialect, so the journey changes the machine's controller in
   the Machine Library to each one it offers, exports the G-code for each, and
   sets it back to GRBL.
9. **Control on the built-in simulator:** connect, clear the software stop,
   Home All, move to a work-zero spot with MDI and Zero all (G54), load the
   GRBL file from step 8 with Load > Open file..., CYCLE START, Feed Hold, jog
   Z+, CYCLE START to resume, and run to the end. The console's lines are kept
   in the log.

## What you get in `<out>`

| File | What it is |
| --- | --- |
| `step-NN-*.png` | One picture at the end of every step, plus pictures of key moments inside a step. |
| `journey.log` | Everything: every console line the app printed, every page error and unhandled rejection, the app's own stdout/stderr, every file dialog answer, and what each step read back. |
| `result.txt` | One `STEP n PASS\|FAIL <reason>` line per step. |
| `result.json` | The same, with each step's errors, notes, pictures and timings. |
| `files/` | The saved project and every posted G-code file. |
| `scenes/` | With `--shots`: tool library, sketch, model, setup, hero with toolpaths, simulate mid-cut, post preview, control mid-run. |

## How a step passes or fails

A step fails when anything it asked the app to do did not happen (a button
missing or greyed, a value not kept, an operation in error, a file not
written), **or** when the app printed an error-level console line, threw a page
error or left an unhandled promise rejection while the step ran. A step that
fails is not skipped over quietly: its reason says what did not happen, and
later steps still run so one fault does not hide the rest.

Each step's `notes` in `result.json` record things the journey saw that did not
stop it (for example, a choice the app needed that nothing on screen asked
for). They are findings to read, not failures.

A failed step means a user on a fresh PC would hit the same thing. Reproduce it
by doing that step by hand in the same build; the log shows exactly what was
clicked and what the app said.
