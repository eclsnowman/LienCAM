# Credits

LienCAM exists because a great many people chose to share their work. Every project, library, font, model,
algorithm, paper and published resource below made some part of it possible. Thank you, all of you.

This page is generated from `src/about/credits.json` by `tools/release/credits.mjs`; edit the JSON, not this file.
The licence terms and full licence texts for everything that ships with LienCAM are in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Geometry and CAD kernels

The solid, mesh, sketch and polygon engines underneath every model and every toolpath.

### Open CASCADE Technology (OCCT)

Decades of open solid-modelling work made a real CAD kernel possible in a browser - thank you to Open Cascade and every OCCT contributor.

- In LienCAM: The B-rep solid kernel: solids, fillets, booleans, defeature, STEP and IGES
- How it ships: Compiled into two vendored WebAssembly builds: occt-wasm (patched by us; patches in patches/) and occt-model (built with opencascade.js)
- Licence: LGPL-2.1-only WITH OCCT-exception-1.0
- Link: https://dev.opencascade.org

### occt-wasm

Thank you for a clean, reproducible OCCT-to-WASM build we could extend instead of starting from scratch.

- In LienCAM: The WebAssembly build and bindings of OCCT we patch and ship
- How it ships: Vendored, locally patched WebAssembly package (vendor/occt-wasm/; the iges-history-stack build is the one installed, the three earlier builds stay in the source tree), loaded by the geometry worker
- Licence: MIT OR Apache-2.0
- Link: https://github.com/andymai/occt-wasm

### brepjs

A thoughtful modelling API that saved us from writing kernel plumbing by hand.

- In LienCAM: TypeScript B-rep modelling API over OCCT
- How it ships: npm dependency, bundled into the geometry worker
- Licence: Apache-2.0
- Link: https://github.com/andymai/brepjs

### opencascade.js

Thank you for pioneering OCCT in the browser; our STEP import stands on it.

- In LienCAM: STEP import, topology queries and sectioning for the model kernel
- How it ships: The builder of our second OCCT WebAssembly module (occt-model.wasm, vendored with its rebuild recipe)
- Licence: LGPL-2.1-only
- Link: https://github.com/donalffons/opencascade.js

### Emscripten

Without Emscripten none of these C++ kernels would run in a browser - thank you.

- In LienCAM: The compiler that turned C++ kernels into WebAssembly a browser can run
- How it ships: Its JavaScript runtime support code is compiled into every WebAssembly module we ship (OCCT builds, PlaneGCS, Clipper2, Manifold, OpenCAMLib, ONNX Runtime)
- Licence: MIT OR NCSA
- Link: https://emscripten.org

### PlaneGCS (FreeCAD Sketcher solver)

FreeCAD's sketch solver is the heart of LienCAM's constrained sketching - thank you to its authors.

- In LienCAM: The 2D constraint solver behind every sketch
- How it ships: Compiled into the @salusoft89/planegcs WebAssembly module, loaded in a worker
- Licence: LGPL-2.1-or-later
- Link: https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/Sketcher/App/planegcs

### @salusoft89/planegcs

Thank you for packaging PlaneGCS so a web app can use it.

- In LienCAM: WebAssembly build and wrapper of PlaneGCS
- How it ships: npm dependency; WebAssembly module loaded unmodified in a worker
- Licence: LGPL-2.0-or-later
- Link: https://github.com/Salusoft89/planegcs

### Manifold (manifold-3d)

Booleans that simply do not fail - thank you, Emmett Lalish and contributors.

- In LienCAM: Robust mesh booleans and repair (Mesh Lab, mesh edits)
- How it ships: npm dependency; WebAssembly module loaded unmodified
- Licence: Apache-2.0
- Link: https://github.com/elalish/manifold

### Clipper2

Nearly every 2D toolpath in LienCAM passes through Angus Johnson's Clipper - thank you.

- In LienCAM: All 2D polygon offsetting, union and difference in toolpaths
- How it ships: Compiled into the clipper2-wasm WebAssembly module
- Licence: BSL-1.0
- Link: https://github.com/AngusJohnson/Clipper2

### Clipper2-WASM (clipper2-wasm)

Thank you for bringing Clipper2 to the web.

- In LienCAM: WebAssembly build of Clipper2
- How it ships: npm dependency; WebAssembly module loaded unmodified
- Licence: BSL-1.0
- Link: https://github.com/ErikSom/Clipper2-WASM

## CAM algorithms and code we ported or adapted

Toolpath strategies other people worked out first and published so others could build on them.

### FreeCAD Adaptive2d (Kresimir Tusek)

Kresimir Tusek's adaptive clearing is the strategy our users will lean on most - thank you for publishing it openly.

- In LienCAM: The adaptive-clearing engine (constant-engagement roughing), also used by face, 3D roughing and nesting
- How it ships: Ported to TypeScript in src/lib/cam/adaptiveClearing2d/engine/ (each file keeps its SPDX header and copyright)
- Licence: LGPL-2.1-or-later
- Link: https://github.com/FreeCAD/FreeCAD/tree/main/src/Mod/CAM

### OpenCAMLib (Anders Wallin; web build by Koen Schmeets)

OpenCAMLib taught a generation of open-source CAM how 3D toolpaths work - thank you.

- In LienCAM: Waterline 3D finishing; its drop-cutter method also guided our own 3D kernel
- How it ships: npm dependency (@opencamlib/opencamlib), unmodified, bundled into the 3D CAM worker
- Licence: LGPL-2.1-or-later
- Link: https://github.com/aewallin/opencamlib

### PureCutCNC (Franja Povazanj)

A generous, well-documented open project we learned a great deal from - thank you, Frank.

- In LienCAM: Engagement-based feed scaling, sketch print-to-paper tiles, gear sketch tool, GRBL conformance harness; methods studied for trochoidal slots, corner relief, pocket ring corners, DXF blocks and post import
- How it ships: Adapted source in a few files under src/ (each keeps the upstream header and marks our changes); other methods studied and reimplemented with no code copied
- Licence: Apache-2.0
- Link: https://github.com/PureCutCNC/purecutcnc

### SVGnest (Jack Qiao)

Thank you for an elegant, open nesting engine that makes sheet layouts possible.

- In LienCAM: True-shape nesting (no-fit polygons and genetic search)
- How it ships: Ported to TypeScript in src/lib/cam/nesting/ (upstream licence kept at src/lib/cam/nesting/vendored/LICENSE.svgnest)
- Licence: MIT
- Link: https://github.com/Jack000/SVGnest

### Delaunator (Mapbox / Vladimir Agafonkin)

Fast, tiny and correct - thank you.

- In LienCAM: Delaunay triangulation under the V-carve medial axis
- How it ships: Vendored source, src/lib/cam/vcarve2d/vendor/delaunator.js (version 5.1.0)
- Licence: ISC
- Link: https://github.com/mapbox/delaunator

### robust-predicates (Vladimir Agafonkin, after Jonathan Shewchuk)

Thank you, and thank you to Jonathan Shewchuk for the original robust predicates.

- In LienCAM: Exact orientation tests inside Delaunator
- How it ships: Vendored source, inside src/lib/cam/vcarve2d/vendor/delaunator.js (version 3.0.2)
- Licence: Unlicense
- Link: https://github.com/mourner/robust-predicates

## Rendering, UI and app platform

What draws the screen, holds the state, runs the models and turns a web app into a desktop app.

### three.js

The 3D web would be a poorer place without three.js - thank you, mrdoob and contributors.

- In LienCAM: Every viewport: model, toolpaths, simulation
- How it ships: npm dependency, bundled
- Licence: MIT
- Link: https://threejs.org

### @types/three (DefinitelyTyped)

Thank you to the DefinitelyTyped contributors for keeping three.js typed.

- In LienCAM: TypeScript types for three.js
- How it ships: Type declarations only; used at build time, nothing reaches the app
- Licence: MIT
- Link: https://github.com/DefinitelyTyped/DefinitelyTyped

### three-mesh-bvh (Garrett Johnson)

Thank you for making mesh queries fast enough for CAM.

- In LienCAM: Fast ray casts for 3D finishing and shading
- How it ships: npm dependency, bundled
- Licence: MIT
- Link: https://github.com/gkjohnson/three-mesh-bvh

### React and React DOM

Thank you to the React team and community.

- In LienCAM: The whole user interface
- How it ships: npm dependencies, bundled
- Licence: MIT
- Link: https://react.dev

### Zustand

Small, clear state management - thank you, pmndrs.

- In LienCAM: App state
- How it ships: npm dependency, bundled
- Licence: MIT
- Link: https://github.com/pmndrs/zustand

### Comlink

Thank you for making workers feel like ordinary function calls.

- In LienCAM: Talking to the geometry worker
- How it ships: npm dependency, bundled
- Licence: Apache-2.0
- Link: https://github.com/GoogleChromeLabs/comlink

### fflate

Thank you for fast, dependency-free compression.

- In LienCAM: Project file compression, 3MF, archive import
- How it ships: npm dependency, bundled
- Licence: MIT
- Link: https://github.com/101arrowz/fflate

### Lucide (lucide-react)

Thank you for a clean, consistent icon set.

- In LienCAM: Icons across the UI
- How it ships: npm dependency, bundled
- Licence: ISC AND MIT
- Link: https://lucide.dev

### ONNX Runtime Web (Microsoft)

Thank you for running real models locally, in the browser.

- In LienCAM: Runs the depth model for picture-to-relief
- How it ships: npm dependency; its WebAssembly runtime is loaded lazily in the relief-depth worker. It carries Microsoft's own third-party notices, reproduced in THIRD_PARTY_LICENSES.md
- Licence: MIT
- Link: https://github.com/microsoft/onnxruntime

### i18next and react-i18next

Thank you for the translation library half the web runs on.

- In LienCAM: Looks up the interface's words by key so the app can offer other languages
- How it ships: npm dependencies, bundled
- Licence: MIT
- Link: https://www.i18next.com

### Depth Anything V2 Small (Yang et al.)

Thank you for releasing a small, capable model under an open licence.

- In LienCAM: Estimates depth from a photo for Relief
- How it ships: Not in the installer or the web build: downloaded at first use from Hugging Face (the onnx-community ONNX export, pinned by commit) and cached on the user's computer
- Licence: Apache-2.0
- Link: https://huggingface.co/depth-anything/Depth-Anything-V2-Small

### opentype.js

Thank you for making real font outlines usable on the web.

- In LienCAM: Reading user fonts for sketch text
- How it ships: Bundled from the copy three.js ships in its examples (three/examples/jsm/libs/opentype.module.js)
- Licence: MIT
- Link: https://github.com/opentypejs/opentype.js

### Electron

Thank you for the desktop shell that lets one codebase run on three systems.

- In LienCAM: The desktop app
- How it ships: The desktop app's runtime (desktop installer only; LICENSE.electron.txt sits beside the program)
- Licence: MIT
- Link: https://www.electronjs.org

### Chromium

Thank you to the Chromium authors and to every project whose notice fills LICENSES.chromium.html.

- In LienCAM: The browser engine inside the desktop app
- How it ships: Inside Electron, in the desktop installer only; its full notices are LICENSES.chromium.html beside the program
- Licence: BSD-3-Clause
- Link: https://www.chromium.org

## Fonts and data

The typefaces in the interface and the letters LienCAM can cut.

### Hershey fonts (Dr. A. V. Hershey; packaging by techninja/hersheytextjs and Evil Mad Scientist)

Thank you to Dr. Hershey's 1967 work, still cutting letters today, and to those who kept it alive.

- In LienCAM: Single-line engraving text
- How it ships: Font data in src/lib/sketch/fonts/hersheySimplex.ts
- Licence: LicenseRef-Hershey-public-domain
- Link: https://github.com/techninja/hersheytextjs

### M PLUS Rounded 1c (M+ Fonts Project, Coji Morishita)

Thank you for a friendly, open typeface.

- In LienCAM: Outline sketch text
- How it ships: ASCII subset bundled as src/lib/sketch/fonts/mplusRounded1cAscii.typeface.json (the copyright line travels inside it); OFL text at src/lib/sketch/fonts/MPLUSRounded1c-OFL.txt
- Licence: OFL-1.1
- Link: https://github.com/coz-m/MPLUS_FONTS

### MgOpen (Helvetiker, Gentilis, Optimer; MAGENTA Ltd.)

Thank you for releasing these faces for free use.

- In LienCAM: Sketch text fonts
- How it ships: The typeface.json files three.js ships in its examples, bundled unmodified
- Licence: LicenseRef-MgOpen
- Link: https://web.archive.org/web/20050528114140/https://ellak.gr/fonts/mgopen/index.en

### DM Sans

Thank you to DM Sans's designers for making open type look this good.

- In LienCAM: The interface typeface
- How it ships: Bundled web font, public/fonts/ (OFL text at public/fonts/OFL.txt)
- Licence: OFL-1.1
- Link: https://github.com/googlefonts/dm-fonts

### IBM Plex Mono

Thank you to IBM and the Plex designers for a monospace this clear.

- In LienCAM: Numbers and readouts
- How it ships: Bundled web font, public/fonts/ (OFL text at public/fonts/OFL.txt)
- Licence: OFL-1.1
- Link: https://github.com/IBM/plex

### JetBrains Mono

Thank you to JetBrains for a code typeface made to be read all day.

- In LienCAM: G-code and code text
- How it ships: Bundled web font, public/fonts/ (OFL text at public/fonts/OFL.txt)
- Licence: OFL-1.1
- Link: https://github.com/JetBrains/JetBrainsMono

### Space Grotesk

Thank you to Florian Karsten for the face that gives LienCAM its name on screen.

- In LienCAM: The wordmark and splash typeface
- How it ships: Bundled web font, public/fonts/ (OFL text at public/fonts/OFL.txt)
- Licence: OFL-1.1
- Link: https://github.com/floriankarsten/space-grotesk

## Machine control, standards and references

The controllers, standards, papers and published specifications that keep LienCAM honest about real machines.

### LinuxCNC

Thank you for decades of open machine control and for a simulator we could test against honestly.

- In LienCAM: The LinuxCNC gateway talks to its Python interface; RS274NGC behaviour and G10 L2 R rotation measured on its simulator
- How it ships: Not shipped; the LinuxCNC gateway talks to a LinuxCNC install the user already has
- Licence: GPL-2.0-or-later
- Link: https://linuxcnc.org

### lcnc-suite (bildobodo)

Thank you for showing a clean way to drive LinuxCNC from outside.

- In LienCAM: Ideas for the LinuxCNC gateway
- How it ships: Not shipped; ideas only, no code copied
- Licence: GPL-3.0
- Link: https://github.com/bildobodo/lcnc-suite

### GRBL (Sungeun K. Jeon and contributors)

Thank you for the firmware that put CNC in reach of hobbyists.

- In LienCAM: Protocol, streaming method and messages we follow; GRBL and grbl-sim validate our posts
- How it ships: Not shipped; GRBL and grbl-sim run only in a test container
- Licence: GPL-3.0-or-later
- Link: https://github.com/gnea/grbl

### grblHAL (Terje Io)

Thank you for carrying GRBL forward to modern hardware.

- In LienCAM: The grblHAL post dialect and controller support
- How it ships: Not shipped
- Licence: GPL-3.0-or-later
- Link: https://github.com/grblHAL

### UCCNC and CNCdrive (UC100, AXBB-E)

Thank you for an open, documented API that let us drive real hardware.

- In LienCAM: The controller family LienCAM was first built and tested on; LienCAM drives it through its published API
- How it ships: Not shipped; the bridge is built on the user's own PC against the UCCNC install they already have
- Licence: LicenseRef-proprietary
- Link: https://cncdrive.com

### NIST RS274NGC interpreter report (Kramer, Proctor, Messina, 2000)

The reference every G-code interpreter still leans on - thank you to its authors.

- In LienCAM: The G-code language reference
- How it ships: Not shipped; a reference
- Licence: LicenseRef-public-us-government-work
- Link: https://www.nist.gov

### Papers and published methods

Thank you to every researcher who published these methods for others to build on.

- In LienCAM: Medial axis for V-carve (Brandt and Algazi 1994; Amenta, Bern and Eppstein 1998); Catmull-Clark subdivision (1978) and creases (DeRose, Kass and Truong 1998) for Form; Loop and Schaefer (2008) bicubic patches for exact Form bodies; rotation-minimising frames (Wang et al. 2008) for Form pipes; The NURBS Book (Piegl and Tiller) for splines and knots; Ramer-Douglas-Peucker simplification; Moller-Trumbore ray tests; Zhang-Suen thinning for pencil finishing; marching squares for picture tracing
- How it ships: Not shipped; methods reimplemented from the published papers

### Machine makers' public specifications

Thank you for publishing your specifications.

- In LienCAM: Carbide 3D, Sainsmart, Onefinity, Sienci Labs, OpenBuilds, FoxAlien and others: travels and spindle data for the example machines
- How it ships: Not shipped; travels and spindle data copied into the example machines

### FreeCAD CAM community

Thank you for keeping open CAM alive for so many years.

- In LienCAM: Beyond Adaptive2d: a long-running open CAM effort we learned from
- How it ships: Not shipped beyond the Adaptive2d port credited above
- Licence: LGPL-2.1-or-later
- Link: https://freecad.org

## Tools we built it with

Not shipped with LienCAM, but it could not have been built without them.

### Vite, TypeScript, Vitest, jsdom, Testing Library, Playwright, ESLint, electron-builder, Emscripten, Rust, Docker, Node.js and Git

Thank you to the tools that made a project this size testable.

- In LienCAM: Building, testing and packaging LienCAM (Rust builds the occt-wasm build tool; Emscripten compiles the kernels)
- How it ships: Not shipped; build and test tools

### AI coding assistants

Thank you to the AI coding assistants that helped write, review and test LienCAM.

- In LienCAM: Help writing, reviewing and testing the code
- How it ships: Not shipped
