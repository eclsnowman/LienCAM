# Adaptive-clearing engine - LGPL-2.1-or-later module

This folder is licensed differently from the rest of LienCAM.

The adaptive-clearing engine here is derived from FreeCAD's Adaptive2d
(`src/Mod/CAM/libarea/Adaptive.cpp` and the Path Adaptive Python code),
Copyright (c) 2018 Kresimir Tusek. Those files are licensed
**LGPL-2.1-or-later**; the licence text is in [`LICENSE`](LICENSE) in this
folder. Changes to those files stay under the LGPL.

The rest of LienCAM is Apache-2.0 (see the root `LICENSE` and `NOTICE`, and
ADR-0056).

## LGPL-2.1-or-later files

Every file below starts with `SPDX-License-Identifier: LGPL-2.1-or-later`:

- `clipperEngine.ts`
- `emit.ts`
- `engagePoint.ts`
- `engagementPoint.ts`
- `geom.ts`
- `index.ts`
- `interpolation.ts`
- `loopbackFillet.ts`
- `processFeature.ts`
- `steering.ts`
- `toolGeometry.ts`
- `wallCleanLoop.ts`

The ported files' headers also still say the project as a whole is
distributed under GPL-3.0-or-later. That was true under ADR-0032 and is out of date: the
project is now Apache-2.0 (ADR-0056). The LGPL-2.1-or-later marking of each
file is unchanged.

## LienCAM-original files (Apache-2.0)

These three files were written for LienCAM, not ported from Adaptive2d (git
history checked in WO-2335). They carry no SPDX header and are Apache-2.0 like
the rest of LienCAM:

- `boundedCleanPath.ts` - bounded path simplification against the original
  points (36c706e37, 2026-09-05)
- `operatorNotices.ts` - engine notices for the app console (WO-1540)
- `workholdingIsland.ts` - clears around a workholding clamp (WO-1579, WO-1618)

## Adding a file here

A file that ports Adaptive2d code gets the `LGPL-2.1-or-later` SPDX header and
the upstream copyright line, and is listed above. A file LienCAM writes itself
gets no header and is listed under LienCAM-original files.
