# Troubleshooting

Short fixes for the problems people hit first. If yours is not here, see [Reporting a bug](Reporting-a-Bug).

## Everything says outdated after opening

Operations reopen with an amber clock badge when their toolpath could not come back with them. Every setting is kept; regenerating rebuilds the toolpath.

## A toolpath vanished

If an operation points at a loop, hole or face that is no longer in its geometry, it turns red and names what is missing instead of drawing nothing. Re-select the geometry and generate again.

## An import or derive was refused

When a file cannot be read or a shape cannot be used, the app names the reason in the design tree, the bottom console, or on the operation. Read it there first.

Features tilted away from straight up cannot be cut from above. Turn the part upright or upside down to use them again. See [Importing STEP](Importing-files#import-step).

## Saved data could not be loaded

The console names the load failure. LienCAM starts with defaults for the affected data and holds back saves so it does not overwrite your stored copy this session. Reload to try again.

## An operation says "Stopped short"

The tool could not reach full depth without its neck, shank or holder touching something. A tool with a longer reach cuts the rest. See [Tool library](Tool-Library).

## A sketch is over-defined

A constraint that would contradict the sketch is taken back at once and named in the status bar. A sketch that already holds a contradiction shows a red Over-defined banner with a Resolve list.

## A blank screen, or an error screen

An error screen shows the real error message. Reload opens the same saved project. A failure in the 3D view alone leaves the rest of the app working.

## The 3D simulation is missing or slow

The 3D stock simulation needs WebGL2 with linear filtering of floating-point 3D textures, which not every GPU or driver offers. Without it LienCAM runs the 2.5D simulation and says so in the console; the 2.5D view shows the top surface only, not undercuts.

## Connect does nothing (GRBL, grblHAL)

Serial connections need a Chromium-based browser (or the desktop app). If Connect is unavailable, the browser is the limitation. See [Controllers: GRBL and grblHAL](Controllers-GRBL-and-grblHAL).

## The machine says Alarm

Alarm means the controller is locked: a fresh power-up or a limit hit. Press Home All if your machine has home switches, or press Unlock on the Control tab (on GRBL it sends `$X`) after you have checked the position is safe.

## UCCNC: the connection did not build

Check that UCCNC is installed on the same PC and that the Machine page found it; if not, choose its folder and press Build machine connection. The compiler's messages are in `machine-bridge\machine-bridge-build.log` inside LienCAM's user-data folder (on Windows, normally `%APPDATA%\LienCAM`). See [Controllers: UCCNC, UC100, AXBB-E](Controllers-UCCNC-UC100-AXBB-E).

## The position is wrong after restarting the connection

A restart loses the machine's position. Home the machine before you jog or run.
