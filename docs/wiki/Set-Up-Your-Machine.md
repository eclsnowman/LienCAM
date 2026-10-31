# Set up your machine

The machine definition tells LienCAM what your machine is: its travel, spindle speed range, feed limits, tool changer, and which controller it has. The controller decides which G-code dialect Post Process writes ([Post-Processors](Post-Processors)) and which way Control connects ([controller pages](#controllers)).

## The Machine Library

Click the machine name in the top-right corner of the 3D view to open the Machine Library.

![The Machine Library window with the machine list on the left and the definition on the right](images/machine-library/machine-modal.webp)

1. Pick a machine in the list on the left, or press New to add one. Import brings machines in from a JSON file; Export All saves the whole list as one.
2. Fill in the definition on the right: Name, Type, Kind (Router, Plasma, Laser or Knife) and Controller, then the groups under them: Travel, Homing & Machine Zero, Spindle, Feeds & Options, Probing Defaults, Tool Table & Overrides, Axis Feed Limits and Notes.
3. Press "Use for this project" to make it this project's machine, and "Set as Default" to use it for every new project.

A project saved with a machine this installation does not have asks you to choose when you open it. LienCAM never switches your machine silently.

## The generic starter

A fresh install starts with **Sample hobby router (GRBL)**. Its editable values are starting defaults, not your machine's specifications, and it has no controller connection. Edit or replace it before running a machine.

## The ten example machines

Press Examples in the Machine Library to add a ready-made starting point. Each is a new entry you can edit. Where a figure could not be confirmed it is left unset for you to fill in.

- Shapeoko 5 Pro / 4 Standard (GRBL post)
- Genmitsu 3018-PROVer V2 (GRBL post)
- Onefinity Woodworker (Generic post; no controller connection configured)
- Sienci LongMill MK2 30x30 (grblHAL post)
- OpenBuilds LEAD 1010 (GRBL post)
- FoxAlien Masuter Pro (GRBL post)
- Genmitsu PROVerXL 4030 (GRBL post)
- 6040-class gantry (UCCNC post; you set up your own connection)
- X-Carve 1000 (GRBL post)
- PCNC 440-class mill (LinuxCNC post; no connection configured)

These are sized from published specifications and may not match your own machine exactly. Machine names are listed only so you can find a starting point; picking one does not connect to anything and does not mean the controller has been tested. Check the travel, spindle range and homing equipment against your own machine.

Each example includes three hidden macros: **Example - Part swap (M300)**, **Example - Spindle warm-up (M301)** and **Example - Part trace (M302)**. Hidden means off. Review the body and show it in **Edit macros** before calling its M-code. Part swap asks for safe machine Z and a park at the back of travel, then pauses with M0. Warm-up asks for starting and final RPM. Part trace asks for safe machine Z and the outline in work coordinates. The examples supply no verified home convention or stock dimensions.

## The Machine definition page (wiring and homing)

Control > Machine > Machine definition holds the wiring, homing and controller-specific settings a homebuilt machine needs. It is the control half of the machine record (pin assignments, steps per unit, homing direction and speeds, backlash, and every setting your controller catalogues); the Machine Library holds the CAM half (travel, spindle, feed caps). Both write the same record.

In All settings, the Show list (Everything, Stated by the profile, Changed by me) and the "Only settings LienCAM uses" box narrow the full settings table.

## The setup walkthrough

New to a machine record? The walkthrough asks for it one screen at a time. Open it from **Control > Machine > Definition > Run the setup walkthrough**, or from the Machine Library with **Set up machine control (walkthrough)**. Its seven steps:

1. **What is this machine** - name, kind and controller. You can start from your UCCNC `.pro` file, read the connected board, or start blank.
2. **Axes and travel** - how far each axis moves.
3. **Where is home** - which end each axis homes to and where machine zero sits.
4. **Spindle** - speed range and how it is driven.
5. **Outputs and coolant** - flood, mist and other outputs.
6. **Probe and tool setter** - your touch probe and where the tool setter sits.
7. **Check and save** - review the record and save it.

Back, Skip and Next move between steps; step 7 saves the record.

## Controllers

- [Controllers: UCCNC, UC100, AXBB-E](Controllers-UCCNC-UC100-AXBB-E) - alpha, one machine proven.
- [Controllers: GRBL and grblHAL](Controllers-GRBL-and-grblHAL) - experimental, not hardware-verified.
- [Controllers: LinuxCNC](Controllers-LinuxCNC) - experimental, simulator only.

You can also post G-code for any of them and run it with the software you already use: see [Post-Processors](Post-Processors).

If something goes wrong, see [Reporting a bug](Reporting-a-Bug).
