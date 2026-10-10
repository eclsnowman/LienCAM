# 09 Nested kit sheet

Open `nested-kit-sheet.camproject` with **Open project**. Seven profiles are
packed true-shape onto a 290 x 190 x 3 mm sheet, with 8 mm part gap and
8 mm margin. The generic starter machine and embedded 3 mm starter end mill
are ready to inspect, simulate and post.
`reopened.png` shows the reopened project's finished Cut Stock simulation.

These standalone SVG inputs copy the current starter kit's toe-clamp
outside loop (quantity 2), original 80 x 18 mm soft-jaw base sketch
(quantity 2), 16- and 24-tooth gear loops (quantity 1 each), and sign
profile (quantity 1). Gear and clamp outlines are copied from the saved
projects without rescaling. The jaw base rectangle matches the dimensions
in the original build-soft-jaws script and saved jaw bodies.

Nesting is EXPERIMENTAL. This is intended as a sheet layout and outside
profile lesson. These thin cutouts omit holes, recesses, jaw grips and
lettering, and do not replace the functional thicker parts in examples
02, 03, 05 and 08.

The production **Explode** button bakes the completed nest into independent
parts. One **All Parts** contour cuts all seven outlines, with four triangular
tabs per part (4 mm wide, 1 mm high), 1 mm stepdown and 0.2 mm through allowance.
The saved project contains these baked profiles; the original nest report and
layout capture are retained in the development evidence. To change the pack,
rebuild from the standalone sources through **New nest**.

Secure the full sheet to a spoilboard with tape and glue. After machining,
cut the tabs and sand the stubs. Review workholding, feeds and speeds for
your own stock and machine. Tabs on the gear profiles are for this layout
lesson; use example 08 for functional gears without tooth-flank stubs.

Regenerate through the production app controls:

```powershell
npm run build
node tools/examples/build-nested-kit-sheet.mjs
npx vitest run src/tests/tools/exampleKitNestedkitsheet.wo2381.test.ts
```

The script uses the shared production driver, starts a new named project
with the generic starter machine, imports the starter tools, adds each
source through Nesting's Add part control, requests exact quantities,
and reads the application's durable autosave and visible result summary.
It asserts seven placed parts, accepts and explodes the nest, creates the
tabbed contour, computes it, saves and reopens in a fresh page, and recomputes.
It previews all five post dialects and runs Cut Stock simulation to the end.
Evidence is in src/tests/evidence/WO-2381 in the development repository.
Wiki walkthrough: [Nesting](../../docs/wiki/Nesting.md).

Licence: Apache-2.0. Project-made outlines, made for the release.
The gear generator retains its source attribution in the application.
