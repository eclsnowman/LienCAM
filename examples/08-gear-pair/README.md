# Gear pair

Two involute spur gears, made in LienCAM with the sketch Gear tool.
Module 4 mm, 16 and 24 teeth, 20 deg pressure angle, 1.5 mm root fillets.
Pitch radii are 32 and 48 mm; the native sketches retain the 80 mm
meshing centre distance. For machining, the second gear, bore and keyway
are placed 16 mm farther along X. The cutting centres are 96 mm apart,
leaving 8 mm between tip envelopes (more than twice the 3 mm tool diameter).
Each gear has a nominal 10 mm bore and a 4 mm wide keyway.

Open gear-pair.camproject. Both setups use ONE 200 x 120 x 6 mm sheet
with the starter 3 mm flat end mill. Apply masking tape to the spoilboard
and the underside of the full sheet, bond the taped faces with superglue,
and let it cure. Run both setups without moving the sheet. Each gear's bore
and keyway run before its outside contour. Both outlines cut 0.5 mm below the stock bottom,
through the tape and slightly into the sacrificial spoilboard. This margin
ensures breakthrough; both gears stay glued in place. Pry off both gears and deburr.
Tabs stay off so no nub spoils a tooth flank. Check feeds for your material.
The saved setups and gear-pair.setup.pdf / .txt record these instructions.

Teaches: involute gear sketches, pitch-circle centre distance, explicit
operation boundaries, bore milling, keyway pockets, shared-sheet tape and glue.
Wiki page: Sketching.

Rebuild through the production app controls:

```powershell
npm run build
node tools/examples/build-gear-pair.mjs --from-project
```

This command reopens the shipped job, sets the outline breakthrough through
production controls, runs Generate all, saves and reopens, and captures both
Cut Stock end states. Omit --from-project to rebuild the stock assignments,
setups and operations from the original app-made sketches.camproject.
Cut Stock simulates one setup at a time; the two end pictures are labelled.

Licence: Apache-2.0. Original project geometry made for the release.
The application gear generator has its own source attribution.
