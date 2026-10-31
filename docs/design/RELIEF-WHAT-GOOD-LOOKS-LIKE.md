# Image relief - what good looks like

This is research for the image-relief tool (`docs/design/IMAGE-RELIEF-PLAN.md`). the operator asked for it on
2026-09-28 at about 9:59 PM CT, when he approved stage 1: "make sure you research what good should look
like. Have images of other software and the resulting images of cool looking and detailed height map
outputs so we can have well tuned defaults to help the user. Make it exceptional so users would love to
use this feature."

The public design reference is `docs/design/relief-references/`: our numerical renders in
`numbers/` and the public-domain or CC0 inputs in `fixtures/` (licences in `LICENCES.txt`).
Rebuild them with `relief-references/fixtures/make_fixtures.py` (numpy + scipy + Pillow).
Section 6 explains how these artifacts demonstrate the controls and surface defects.
External reference pictures are not shipped; sections 6b-6c retain source and licence notes
for the remaining private references.

---

> External screenshots and copyrighted result pictures stay outside the repo and are never shipped. Only our own renders and the licensed fixtures listed in section 7 are in git.

## 0. THE STANDARD - what stage 1 must meet

Each line below is a test. "Defaults" means the user opens the picture and presses nothing else (Auto
runs on open, see section 4). The numbers come from sections 1-3 and the pictures from section 6.

| # | Statement (testable) | Tied to |
|---|---|---|
| S1 | Opening a picture on a flat face fits it INSIDE the face, keeps its proportions, centres it and leaves a 5 % margin on each side. A 1200 x 1200 photo on a 100 x 70 face becomes 63 x 63 mm. | sec 1 "Fit"; placement geometry |
| S2 | Default depth = 4 % of the shorter placed side, clamped to 0.5-10 mm and rounded to 0.25 mm. That gives 2.5 mm for the S1 photo, 2.0 mm for a 100 x 50 sign and 1.25 mm for a 30 mm medallion. The default direction is Raise. | sec 3a; fixture depth examples |
| S3 | No terraces. Take the 8-bit dome fixture (`fixture-05b`) at 100 mm wide and 3 mm deep, with defaults. Its surface slope must stay within 1 deg of the 16-bit truth at the 99th percentile. Measured: 0.75 deg with the 2 px default smooth; 2.8 deg with no smooth, where terraces show. | `numbers/num-01-8bit-terraces-vs-smooth-vs-16bit.jpg` |
| S4 | 16-bit in stays 16-bit. `fixture-05` (16-bit) keeps at least 30,000 distinct height levels after the whole chain (measured 53,928). Heights stay float from loading to the kernel and are never re-quantised to 8 bits. | `fixtures/fixture-05-dome-rings-16bit.png`; sec 3f |
| S5 | A small picture never looks blocky. A 300 x 300 logo on a 100 mm face is resampled to the working grid with bicubic or better, so the 3D preview at 1:1 zoom shows no 0.33 mm squares. | `results-bad/synth-bad-pixel-steps-1.png` |
| S6 | Auto on black text on white (`fixture-03`) inverts the picture so the LETTERS RISE. The background lands exactly on the face (height 0.000), letter tops sit flat at full depth, and edges get a soft ramp (0.15 mm smooth). It looks like `numbers/default-fixture-03-text-sign.jpg`. | `results-good/good-pair-lettering-abc-1.jpg` |
| S7 | Auto never flattens a true height map. On `fixture-02`, no more than 0.01 % of samples sit at the top height (measured 0.0 %), so there are no blown-out flat tops. | `results-bad/synth-bad-clipped-flat-tops-1.png` |
| S8 | Auto on a photo (`fixture-01`) removes grain. Fine roughness (high-pass RMS at 4 px) drops by at least 50 % (measured 66 %), and the eyes, brows and mouth stay readable. It looks like `numbers/default-fixture-01-portrait-photo-lincoln.jpg`. | `numbers/num-02`; `results-bad/synth-bad-noise-speckle-1.jpg` |
| S9 | Live preview. While a slider is dragged, the 3D preview redraws at 30 frames/s or better (33 ms or less) on its 512 x 512 grid. For a 2000 x 2000 picture, the full-resolution 2D map and the 3D refine arrive within 250 ms of release. Nothing blocks the page for more than 100 ms. | Nielsen's 0.1 s / 1 s limits (sec 9); preview responsiveness |
| S10 | The preview is honest. At every preview sample, the applied body and the preview agree to within 1 % of depth, so what he sees is what he cuts. | plan sec 3 |
| S11 | Studio light. The 3D preview lights the relief from the upper left at 30-40 deg elevation, as in every good reference render in 6b, so terraces and noise show BEFORE cutting. Zebra works on it. | `results-good/good-topo-yosemite-1.jpg`, `good-rose-relief-render-1.jpg` |
| S12 | The status line shows, as information only (rule 11): relief size, highest point, steepest wall in degrees and the working grid (for example "1000 x 1288 @ 0.07 mm"). It never refuses. | sec 3d |
| S13 | The default look. The five fixtures with defaults look like `numbers/default-*.jpg`. the operator's picture verdict on those five renders is the acceptance gate. | sec 6d |

---

## 1. Stage 1 controls - default, range, reason, source

| Control | DEFAULT | Range | Reason | Source |
|---|---|---|---|---|
| Fit / size | Fit inside the face, keep proportions, centred, 5 % margin each side (at least 1 mm) | 1 mm .. 4 x face size (the mask clips to the face) | The centred fit preserves proportions. The margin keeps the later edge blend off the face edge | placement geometry |
| Depth | 4 % of the shorter placed side, clamped 0.5-10 mm, rounded to 0.25 mm (to 0.05 mm below 1 mm) | 0.05 .. 50 mm | See 3a: coins 1.5-2 %, medals and plaques 3-5 %, carved panels about 4 %. 4 % reads as a real relief without heavy roughing | sec 3a |
| Raise / Cut in | Raise | Raise, Cut in | Raise maps light pixels to heights above the face. Cut in (intaglio, stamp, mould) reverses the direction deliberately | height mapping |
| Invert image | Off. Auto may turn it on for two-tone artwork on a light background (sec 4) | on / off | Light = high is the relief convention. Invert changes the image mapping without changing Raise / Cut in. Lithophanes need their own thickness mapping | height mapping |
| Zero plane | 0 % (black sits on the face). Auto sets it to the background level for artwork | 0 .. 99 % | A relief goes one way from the face, so black starts at zero. Raising the zero plane flattens the background | height mapping |
| Base | 0.00 mm | 0 .. 2 x depth | Zero base keeps the relief attached to the selected face without adding an unintended pedestal | face placement |
| Preview resolution | A 512 x 512 displaced grid while dragging, refined to the working grid (at most 1024 on the long side) 250 ms after the drag stops | 128 .. 2048 | 512^2 = 262 k vertices. A bounded interactive grid separates drag responsiveness from applied resolution; measure the frame target in S9 | plan sec 3 |
| Working grid (applied) | 10 samples / mm (0.1 mm pitch), capped at 2048 on the long side | 2 .. 40 samples / mm | 0.1 mm is finer than a 0.8 mm ball can follow (R/4 rule, 3e). Ten samples per mm limits the mesh size while preserving cuttable detail | sec 3e |

## 2. Stage 2 adjustments - default, range, reason

| Adjustment | DEFAULT (manual) | What Auto sets | Range | Reason / source |
|---|---|---|---|---|
| Greyscale channel | Luma (Rec. 709: 0.2126 R + 0.7152 G + 0.0722 B) | Luma | Luma, R, G, B, Max | Rec. 709 luma weights give a documented brightness mapping. A single channel rescues a red rose on green leaves |
| Levels black / white | 0 / 255 (no clip) | Photos: clip 0.5 % at each end. Artwork and height maps: 0 % (min -> 0, max -> 1 only) | 0-255 each, black < white | A small photo-only clip uses the tonal range. A 0 % stretch preserves every height-map level. Clipping a TRUE height map flattens its peaks (S7) |
| Midtones (gamma) | 1.00 | 1.00 (Auto never bends midtones) | 0.30 .. 3.00 | Gamma above 1 fattens the middle heights (fuller cheeks, rounder petals); below 1 sharpens peaks. It is taste, so Auto leaves it |
| Contrast / brightness | 0 / 0 | 0 / 0 | -100 .. +100 | Both overlap with levels but offer direct tonal adjustments. Neutral defaults preserve the input |
| Denoise (median) | 0 px | Photos: radius 1 px (3 x 3). Others: 0 | 0 .. 5 px | Film grain and JPEG speckle turn into sandpaper on the relief (`numbers/num-02` panel 1). A median keeps edges |
| Smooth (Gaussian sigma, set in mm, also shown in px) | 0.10 mm | Photos 0.20 mm; artwork 0.15 mm; height maps 2 px if 8-bit, 0.5 px if 16-bit | 0 .. 5 mm | Removes 8-bit terraces (S3) and grain (S8). 0.2 mm removes nothing a 1.6 mm ball could cut (3c) |
| Edge-keeping smooth (bilateral) | Off | Off (stage 2 option for photos) | spatial 0-3 mm, range 0-30 % | Smooths skin but keeps eyelids. Slower (plan sec 2b) |
| Edge blend (stage 3) | 1.5 mm, Smooth profile | same | 0 .. 20 mm; Smooth / Straight / Round | A 1-2 mm rolled edge blends a mask into the face without a visible ledge |
| Shape profile for two-tone art (stage 3, recommended) | Flat | Flat | Flat / Round (pillow) / V, with an angle | Growing height with distance from the edge gives rounded or angled letter profiles rather than a flat stamp |
| Emboss (compress depth, keep detail) - later | Off | Off | 1-50 % | Compress the large depth range while preserving small surface detail. Useful for "Photo depth" (stage 7) |

---

## 3. Machining rules turned into numbers

### 3a. Depth vs part size
- Coins have 0.3-0.5 mm of relief on 20-30 mm (1.5-2 %). The most ambitious high-relief coins reach 3 mm
  (CoinsWeekly; `results-good/good-coin-high-relief-1.jpg`, the 1907 Saint-Gaudens).
- Medals and plaques: "several millimetres" is the historical norm, 3-5 % of a 60-100 mm medal.
- Carved panels (CNC Dad rose): 1/4-1/2 in (6-13 mm) on 6 x 7.5 to 12 x 15 in panels, about 4 % of the
  short side. Craftgineer: at most 1/2 in of relief in 3/4 in stock, keeping a 1/4 in base.
- Terrain carvings are usually exaggerated to 5-10 % of the width. Our terrain render at 4 % looks
  shallow, and the user raises it.
- Textures (hammered, wood grain, fish scale) want 0.3-1.0 mm whatever the panel size, because a texture
  is surface, not form. Our rule gives 2.5 mm on 60 mm, too deep for a texture. A later texture preset should
  default to 0.8 mm.
- DEFAULT RULE: depth = 4 % of the shorter side, 0.5-10 mm. A 100 mm panel gets 4 mm; a 100 x 70 face
  with a 63 mm square picture gets 2.5 mm.

### 3b. Ball nose, stepover and scallop
Scallop (cusp) height h = R - sqrt(R^2 - (s/2)^2), approximately s^2 / (8R). The finishing stepover for
reliefs is set to 8-12 % of the tool diameter to control the cusp height. CNCCookbook notes the returns flatten below
1/8 D. Craftgineer uses 10 % for fine work, 20 % for fast and 15 % as a compromise.

| Ball D (mm) | 8 % stepover | scallop | 10 % stepover | scallop |
|---|---|---|---|---|
| 0.50 | 0.040 | 0.8 um | 0.050 | 1.3 um |
| 1.00 | 0.080 | 1.6 um | 0.100 | 2.5 um |
| 1.59 (1/16 in, the tip of a 1/32 in radius TBN) | 0.127 | 2.5 um | 0.159 | 4.0 um |
| 3.18 (1/8 in) | 0.254 | 5.1 um | 0.318 | 8.0 um |
| 6.35 (1/4 in) | 0.508 | 10.2 um | 0.635 | 15.9 um |

At 8-10 % stepover the scallop is only 1.6-2.5 thousandths of the ball diameter, which wood and plastic
do not show. So what makes a finish look good is the RELIEF itself (noise, terraces, walls), not the
stepover. At 40 % the ribs dominate: `results-bad/synth-bad-scallops-big-stepover-1.png` (3 mm ball,
0.005 mm vs 0.125 mm scallop).

### 3c. The smallest detail a ball of diameter d can cut
- The ball cannot reach the bottom of a valley whose radius is smaller than its own: concave radius must
  be at least R = d/2.
- A ripple of amplitude A and wavelength L (a hair line, a petal vein) is followed fully only if
  L >= 2 pi sqrt(R A):

| Ball D (mm) | A = 0.10 mm | A = 0.25 mm | A = 0.50 mm |
|---|---|---|---|
| 0.50 | 0.99 mm | 1.57 mm | 2.22 mm |
| 1.00 | 1.40 | 2.22 | 3.14 |
| 1.59 | 1.77 | 2.80 | 3.96 |
| 3.18 | 2.50 | 3.96 | 5.60 |
| 6.35 | 3.54 | 5.60 | 7.92 |

- Picture: `numbers/num-03-ball-size-vs-detail-portrait.jpg` shows the same 100 mm portrait, then what
  0.8, 1.6, 3.2 and 6.4 mm balls would leave (an ideal zero-stepover cut, computed as a morphological
  opening by the ball). 0.8 mm keeps the wrinkles, 1.6 mm keeps the eyes and brows, 3.2 mm keeps the face,
  and 6.4 mm leaves a blob. `results-bad/synth-bad-ball-too-big-mushy-2.png` shows the same effect on the
  rose.
- Coastal Vectors, carving a painted depth map with a 1/8 in ball: flaws visible in the preview vanished
  in the cut, because the ball filters detail smaller than itself.
- So smoothing with a Gaussian of sigma no more than R/4 removes nothing any finishing ball could cut.
  The 0.20 mm photo default costs nothing for any ball of 1.6 mm or more.
- Tapered ball noses are the usual relief finisher, for example Amana 46281: 1/32 in radius tip on a
  1/4 in shank, 3.6 deg per side. They give a 1.6 mm tip with the stiffness of a 6 mm shank. Common
  practice: rough with a 1/4 in ball or end mill, finish with a 1/8 or 1/16 in (tapered) ball, 1/32 in
  for fine detail (CNC Dad, Craftgineer, the UKWorkshop heron).

### 3d. How steep a wall can be
- A straight ball end mill can cut up to 90 deg. A single-direction raster finish gets worse on slopes
  that run across the raster, because the scallop grows as 1 / cos^2(slope): x1.33 at 30 deg, x2 at
  45 deg, x4 at 60 deg, x8.6 at 70 deg and x33 at 80 deg.
- A tapered ball nose cannot cut steeper than 90 deg minus its taper per side (86.4 deg for 3.6 deg).
- RULE: keep most of a relief at or below 45 deg, where the finish is at most 2x worse. Walls above
  60 deg want a second raster at 90 deg to the first, or a waterline pass. Above 86 deg a tapered ball
  cannot reach at all.
- Measured on our fixtures with defaults (steepest / 99th percentile):
  - photo: 79 / 68 deg. Dark outlines become cliffs; see lesson 2 in section 5.
  - terrain: 72 / 44 deg.
  - text: 79 / 79 deg. These are the letter sides, which is normal for raised letters.
  - hammered: 72 / 68 deg.
  - dome: 15 / 14 deg.

  That is why the status line must show the steepest wall (S12).

### 3e. Height-map resolution per mm
- Work at 10 samples / mm (0.1 mm pitch): 1000 samples span a 100 mm model.
- The pictures that worked are coarser: the CNC Dad rose is about 3.4 px/mm (783 x 969 at 9 in) and the
  pngcam dagger 3.9 px/mm, both finished with balls of 1.6 mm or more. 3dp.rocks samples at 4 / mm.
  So 10 / mm is safe with margin, and nothing is gained below R/4.
- Rule of thumb: the pitch should be no more than R/4 of the finest ball (0.2 mm for a 1.6 mm ball,
  0.4 mm for 3.2 mm) and no more than the finishing stepover. Anything finer only grows the CAM mesh.
- Cap the working grid at 2048 on the long side (200 mm at 0.1 mm); larger reliefs get a coarser pitch.
  This cap bounds mesh growth; it is a LienCAM budget, not an input-size limit.
- Kernel note for stage 1: the plan caps the exact surface at 512 x 512 control points. On a 100 mm
  relief that is a 0.2 mm pitch, which is fine for balls of 1.6 mm or more and too coarse for a 0.8 mm
  tip. The stage 1 measurement should also time 1024 x 1024.
- A picture with fewer pixels than the working grid is upsampled bicubic, never nearest (S5).

### 3f. Terraces from 8-bit pictures
- 8 bits give 256 levels, so each terrace is depth / 255 high: 3.9 um at 1 mm, 11.8 um at 3 mm, 23.5 um at
  6 mm and 98 um at 25 mm.
  - Once machined, 12 um steps are about the size of a scallop (3b).
  - On SCREEN, every terrace edge shows as a line.
  - At 6-25 mm deep, they are real steps.
  - A narrow grey range stretched by levels is much worse: 32 levels become 0.19 mm steps
    (`results-bad/synth-bad-terracing-8bit-1.png`).
- The paired dome fixtures isolate this effect: the 8-bit input quantises the same surface that
  the 16-bit input represents smoothly (see `numbers/num-01-8bit-terraces-vs-smooth-vs-16bit.jpg`).
- Measured on `fixture-05b` (100 mm, 3 mm deep), as the 99th-percentile slope error against the 16-bit
  truth:

  | Smooth | Slope error | Terraces |
  |---|---|---|
  | none | 2.8 deg | visible |
  | 1 px | 1.4 deg | |
  | 1.5 px | 1.0 deg | |
  | 2 px | 0.75 deg | invisible |
  | 3 px | 0.45 deg | |

  The DEFAULT for 8-bit height maps is 2 px. Picture: `numbers/num-01`.
- Keep heights as float from end to end (S4). 16-bit PNG and TIFF have 65,536 levels and need only 0.5 px.

### 3g. Smoothing so the machined surface does not show pixels
- Pixel blocks come from nearest-neighbour sampling. Interpolate bicubic (S5;
  `results-bad/synth-bad-pixel-steps-1.png`).
- Facets come from a mesh or control grid that is too coarse for the picture
  (`results-bad/bad-facets-coarse-mesh-1.jpg`, `synth-bad-facets-coarse-grid-2.png`). Keep the preview
  grid at 512 or more, and the applied surface at the working pitch.
- Terraces come from 8-bit levels. Use a 2 px Gaussian (3f).
- Grain comes from photos. Use a 3 x 3 median, then a 0.20 mm Gaussian. In `numbers/num-02`: 0 px looks
  like sandpaper, 0.5 px is still gritty, 1 px is grainy, and 2 px (0.2 mm) is clean with the eyes intact.
- Too much is as bad as too little. A 0.9 mm blur melts folds
  (`results-bad/synth-bad-mushy-oversmoothed-1.png`), so Auto never goes above 0.2 mm.

---

## 4. The Auto button (runs once on open; one click puts it back)

1. Convert to greyscale by luma.
2. Classify the picture:
   - ARTWORK if at least 85 % of pixels are near black or white (after a 0.5 % stretch).
   - HEIGHT MAP if the file is 16-bit, or if it is smooth (median |pixel - 3x3 median| below
     0.6 grey levels).
   - PHOTO otherwise.
3. Artwork:
   - If the border (the outer 4 px) is light, invert, so dark art on white paper rises.
   - Levels with 0 % clip.
   - Zero plane = the background, so the background is exactly the face.
   - Smooth 0.15 mm.
4. Height map:
   - Never invert.
   - Levels with 0 % clip: stretch min -> 0 and max -> 1 only, so there are no flat tops.
   - Smooth 2 px if 8-bit, 0.5 px if 16-bit.
5. Photo:
   - Median 3 x 3.
   - Levels clipping 0.5 % at each end, as Photoshop Auto Contrast does.
   - Smooth 0.20 mm.
   - Never invert.
6. Set depth by the rule in 3a, direction Raise, Base 0.
7. Report what it did in one console line (COHESION-STANDARD s13), for example "Auto: artwork, inverted,
   background -> face, smooth 0.15 mm".

The prototype is `auto_adjust()` in `fixtures/make_fixtures.py`. It classified all five fixtures correctly
(photo, height map, artwork + inverted, height map, height map) and made every render in `numbers/`.
Auto never bends midtones, adds a base, or changes Raise / Cut in. Those are design choices, not repairs.

---

## 5. What makes a relief look good (lessons from the pictures)

1. **It uses the whole depth, and the background is black.** The CNC Dad rose height map
   (`good-rose-relief-heightmap-2.png`) has 61,370 distinct levels on a pure black background. Its render
   (`good-rose-relief-render-1.jpg`) is the "cool and detailed" look the operator means: layered petals, deep
   folds, soft transitions.
2. **Height follows shape, not lighting.** A photo's brightness is lighting, so dark outlines become
   trenches and a light shirt becomes a plateau (our `numbers/default-fixture-01-*`). The photos that work
   are evenly lit textures: the alligator skin (`good-pair-croc-*`; the author's rule is "evenly lit
   without long shadows, good contrast"), or depth maps painted by hand (`good-pair-photo-hands-*`, about
   18 revisions). For photos of real objects, the answer is the Photo depth button (plan stage 7).
3. **Crisp small features sit on soft large forms.** The Saint-Gaudens double eagle
   (`good-coin-high-relief-1.jpg`) and the Hodgkins medal (`good-medal-plaster-model-2.jpg`) keep
   lettering and stars sharp while drapery and faces roll softly. Both are low relief, a few percent of
   the diameter.
4. **Artwork needs soft edges.** An embossed ABC reads cleanly only when its map has blurred edges
   (`good-pair-lettering-abc-1.jpg`). That is our 0.15 mm artwork smooth, and later the Round profile.
5. **A mask with a rolled edge frames the relief.** Examples are the heron in an oval
   (`good-photo-heron-oval-1.jpg`) and the medal rim. The mask blend should meet the face smoothly.
6. **No terraces, no pixels, no grain, no flat tops, no mush** (all of `results-bad/`). Each defect has a
   default that prevents it (S3-S8).
7. **Small ball, small stepover.** 8-12 % stepover with a 1/8-1/16 in (tapered) ball gives surfaces like
   the rose; 40 % gives ribs. The machined aluminium penny (`good-coin-penny-machined-aluminium-1.jpg`) is
   impressive but mixed: its lumpy face shows a photo-derived map that was not smoothed.
8. **Raking light sells it.** Every good render is lit low from the upper left
   (`good-topo-yosemite-1.jpg`), and that is what S11 asks of the preview.
9. **Terrain and textures are their own use cases.** Topographic maps (`good-pair-topo-*`,
   `good-topo-lake-maps-dmap2gcode-3.jpg`) want exaggerated depth. Textures (`good-texture-*`, knurl,
   hammered) want shallow depth and tiling inside a boundary, so a later texture preset should
   combine a sketch mask with repeatable image placement.

---

## 6. The gallery

The shipped evidence uses LienCAM's own numerical renders and licensed input fixtures. Private
external screenshots and derivative result pictures are not public evidence. Source and licence
notes for the remaining external references follow; removed commercial-panel records remain in
the pre-release git history. No external picture is renamed or re-attributed here.

### 6a. Controls and the evidence they need

| Control family | What LienCAM must show | Evidence |
|---|---|---|
| Placement | Proportions preserved, centred fit, margin and face mask | S1, S10; plan section 3 |
| Heights | Depth, Raise / Cut in, zero plane and base have distinct effects | S2, S6; text-sign fixture |
| Tonal adjustments | Neutral manual defaults; Auto preserves height maps | S7; terrain fixture |
| Smoothing | Remove grain and terraces without erasing cuttable detail | S3, S8; numerical studies 01-03 |
| Preview | Bounded drag grid, prompt refinement and honest applied heights | S9-S11; plan section 3 |
| Later shape tools | Rolled mask edge, profile height, detail-preserving depth compression | sections 2 and 5; plan stages 3 and 7 |

### 6b. External good-result references (private, not shipped)

"C:" means Wikimedia Commons, https://commons.wikimedia.org/wiki/File:<name>. Licence "(c)"
means copyrighted: internal reference only. The public acceptance evidence is in section 6d.

| File | Source (image ; page) | Licence | What it shows | Why it matters |
|---|---|---|---|---|
| good-rose-relief-render-1.jpg | https://www.cnc-dad.com/model-assets/rose-bloom/preview.jpg ; https://www.cnc-dad.com/models/rose-bloom/ | CC BY-NC-ND 4.0 | Shaded rose relief | THE target look: layered petals, deep folds, soft transitions |
| good-rose-relief-heightmap-2.png | https://www.cnc-dad.com/model-assets/rose-bloom/relief.png ; same | CC BY-NC-ND 4.0 | The 16-bit height map behind it (saved as an 8-bit view) | What a good map looks like: black background, full range, 61,370 levels |
| good-coin-high-relief-1.jpg | C: 1907_High_Relief_Saint-Gaudens_double_eagle_obverse.jpg | PD | High-relief gold coin | Crisp letters and stars on soft drapery |
| good-medal-plaster-model-2.jpg | C: Model_for_Hodgkins_Medal_SAAM-1974.88.20_1.jpg | CC0 | Plaster portrait medal with ring lettering | A shallow portrait with rim and letters; the round-mask target |
| good-pair-dagger-a-heightmap.jpg + -b-carved.jpg | https://img.incoherency.co.uk/2995, /2985 ; https://incoherency.co.uk/blog/stories/cnc-heightmap-toolpaths.html | unknown (blog) | Height map -> machined wood part (pngcam) | A clean small-part pair at 3.9 px/mm |
| good-pair-topo-a-dem-input.jpg + -b-plywood-carved.jpg | https://content.instructables.com/F14/Z4IT/LADXVHN8/F14Z4ITLADXVHN8.jpg, .../F9G/7FOX/LACIFES5/F9G7FOXLACIFES5.jpg ; https://www.instructables.com/Carving-3D-Terrain-Topographic-Relief-Maps-on-a-CN/ | unknown | DEM -> carved plywood; the plies show as contours | Topographic use case |
| good-topo-framed-epoxy-2.jpg | https://content.instructables.com/F0A/TOHY/LACIFEUQ/F0ATOHYLACIFEUQ.jpg ; same | unknown | Finished framed terrain | What a finished terrain looks like |
| good-topo-lake-maps-dmap2gcode-3.jpg | https://www.scorchworks.com/Dmap2gcode/four_lake_maps.jpg ; https://www.scorchworks.com/Dmap2gcode/dmap2gcode_doc.html | unknown | Four carved lake-depth maps with lettering | Cut-in terrain (intaglio) plus text on one board |
| good-topo-yosemite-1.jpg | C: Elemental_Yosemite_no_labels.jpg (Tom Patterson) | PD | Shaded terrain relief | The lighting reference for S11 |
| good-texture-hand-carved-walnut-lid-2.jpg | .../aw_15913_003-copy.jpg ; same | (c) | Walnut lid with a gouge texture | Texture on a domed face |
| good-texture-knurl-1.jpg | C: Knurling_closeup.jpg | CC BY-SA 2.5 | Diamond knurl on a lathe part | A machinist's target for a repeating pattern |
| good-photo-heron-oval-1.jpg | https://cdn.ukworkshop.co.uk/a/105478-0dfd4bfed0c3d2d89344d0f5180f7484/Heron_2.jpg ; https://www.ukworkshop.co.uk/threads/relief-carving-from-a-photo.134552/ | unknown (forum) | Heron relief in an oval, from a photo | The masked relief with a rolled edge (stage 3) |
| good-lettering-vcarve-sign-1.jpg | C: Holzschild_mit_V-Carving.jpg | CC BY-SA 4.0 | Carved name sign with scroll border | The crisp lettering people expect |
| good-pair-lettering-abc-1.jpg | C: Displacement.jpg | CC BY 2.0 | Mesh, blurred ABC map, embossed result | Text embosses cleanly only with soft edges |
| good-pair-heightmap-a-input.jpg + -b-rendered.jpg | C: Heightmap.png, Heightmap_rendered.png | PD | 257 px height map -> 3D render | The textbook pair; slight faceting from a small map |
| good-lithophane-porcelain-lit-3.jpg | C: Lithophanie1_durchlicht.jpg | CC BY-SA 3.0 | 19th-century porcelain lithophane, lit | Tonal detail from thickness alone |
| good-lithophane-luminary-4.jpg | C: Porcelain_lithophane_luminary.jpg | CC BY-SA 4.0 | Lit fish lithophane disc | Soft gradients with no banding |
| good-lithophane-cnc-eagle-2.jpg | C: CNC_lithophane_-_bald_eagle.jpg (tweakie.cnc) | CC BY-SA 2.0 | CNC-cut lithophane, unlit | Fine feathers with a small ball |

### 6c. External defect references (private, not shipped)
The `synth-bad-*` files were generated by `results-bad/make_synth_bad.py` from the CNC Dad 16-bit rose.
Each shows the same relief, 100 mm wide and 6 mm deep, lit from the upper left at 35 deg, with GOOD on
the left and BAD on the right and captions burned in. They are derivatives of a CC BY-NC-ND map, so they
are internal only. The script needs the rose map, which is not in the repo.

| File | Defect | Why (in machinist terms) | Prevented by |
|---|---|---|---|
| synth-bad-terracing-8bit-1.png | Terracing | A low-contrast 8-bit picture stretched to 6 mm leaves 32 levels (0.19 mm steps), showing as contour bands | 2 px smooth for 8-bit maps (3f) |
| synth-bad-pixel-steps-1.png | Pixel blocks | 132 px across 100 mm (0.76 mm/px), each pixel a flat-topped block | Bicubic resampling (S5) |
| synth-bad-facets-coarse-grid-2.png | Facets | A 1.5 mm grid joined by straight patches | Working pitch 0.1 mm (3e) |
| bad-facets-coarse-mesh-1.jpg (C: Blender3D_JuteDisplacement.jpg, CC BY-SA 3.0) | Facets, real | Blender displace on a mesh too coarse for the map | Preview grid of 512 or more |
| synth-bad-noise-speckle-1.jpg | Noise | 1.2 % grey noise (0.07 mm) gives a sandpaper surface | Photo median + 0.2 mm smooth (S8) |
| synth-bad-clipped-flat-tops-1.png | Blown-out tops | White point at 55 % cuts the petals off flat | 0 % clip on height maps (S7) |
| synth-bad-mushy-oversmoothed-1.png | Mush | A 0.9 mm blur melts folds and edges | Auto smooth capped at 0.2 mm (3g) |
| synth-bad-scallops-big-stepover-1.png | Scallop ribs | 3 mm ball, 8 % (0.005 mm) vs 40 % (0.125 mm) stepover | 8-12 % finishing stepover (3b) |
| synth-bad-ball-too-big-mushy-2.png | Tool too big | A 12 mm ball cannot enter narrow folds | Ball-size readout (plan stage 6), 3c |


### 6d. Our renders (`relief-references/numbers/`, CC0, made by `fixtures/make_fixtures.py`)
All are top views of the height field in mm, Lambert-lit from the upper left at 35 deg (25 deg for the
terrace study). This is the "studio light" of S11.

| File | What it shows | Why it matters |
|---|---|---|
| num-01-8bit-terraces-vs-smooth-vs-16bit.jpg | Dome fixture, 100 mm, 3 mm deep: 8-bit raw, 8-bit + 1 px, 8-bit + 2 px, 16-bit | Terraces are real, and 2 px removes them (S3) |
| num-02-portrait-smoothing-0-05-1-2px.jpg | Portrait eyes at 10 px/mm, 2.5 mm deep, smoothed 0 / 0.05 / 0.1 / 0.2 mm | Photo grain looks like sandpaper; 0.2 mm is the default (S8) |
| num-03-ball-size-vs-detail-portrait.jpg | The model, then what 0.8 / 1.6 / 3.2 / 6.4 mm balls can leave | The smallest detail a ball resolves (3c) |
| default-fixture-01-portrait-photo-lincoln.jpg | Photo with Auto, 70 x 90 mm, 2.75 mm | Default look for a photo. Readable, but dark outlines become trenches (lesson 2) |
| default-fixture-02-terrain-heightmap.jpg | Height map with Auto, 100 mm, 4 mm | Default look for a height map. Shallow; terrain wants 5-10 % |
| default-fixture-03-text-sign.jpg | Text with Auto (inverted), 100 x 50 mm, 2 mm | Letters rise and the background sits on the face (S6) |
| default-fixture-04-hammered-texture-16bit.jpg | Texture with Auto, 60 mm, 2.5 mm | Too deep for a texture; texture presets want 0.8 mm |
| default-fixture-05-dome-rings-16bit.jpg | 16-bit soft gradients, 60 mm, 2.5 mm | A clean 16-bit surface with no terraces (S4) |

---

## 7. Test fixtures (`relief-references/fixtures/`, licences in `LICENCES.txt`)

| File | Size | Licence | Exercises |
|---|---|---|---|
| fixture-01-portrait-photo-lincoln.jpg | 1000 x 1288, 8-bit | Public domain (Gardner 1863, Wikimedia Commons) | Fine detail, photo grain, "photo is not shape" |
| fixture-02-terrain-heightmap.png | 1200 x 1200, 8-bit | CC0 (Drummyfish, Wikimedia Commons) | A true height map, soft gradients, the no-clip rule |
| fixture-03-text-sign.png | 1600 x 800, 8-bit, black on white | CC0 (generated; Aileron font, CC0) | Text, auto-invert, zero plane = background |
| fixture-04-hammered-texture-16bit.png | 512 x 512, 16-bit, tileable | CC0 (generated) | Texture, 16-bit kept, tiling |
| fixture-05-dome-rings-16bit.png + fixture-05b-dome-rings-8bit.png | 768 x 768 | CC0 (generated, known maths) | Soft gradients; 8-bit terraces measured against the truth |

The originals of fixtures 01 and 02 are in `fixtures/src/`.

---

## 8. Decisions for the operator (each has a default the build uses if he does not answer)

1. **The five default renders** (`numbers/default-*.jpg`): is that the look he wants? This is his picture
   verdict and the S13 gate. DEFAULT: build to them.
2. **Auto runs by itself when a picture is opened**, or only when he presses Auto? DEFAULT: it runs on
   open, says what it did in one console line, and one click undoes it.
3. **Default depth = 4 % of the shorter side** (2.5 mm on his 100 x 70 example, 4 mm on a 100 mm panel),
   or a fixed number he prefers. DEFAULT: 4 %.

---

## 9. Sources for the numbers

- CNCCookbook, stepover for 3D profiling (1/3-1/10 D; returns flatten below 1/8 D): https://www.cnccookbook.com/cnc-stepover/
- Scallop formula h = R - sqrt(R^2 - (s/2)^2), approximately s^2/8R: https://www.machiningdoctor.com/calculators/ball-nose-surface-finish/
- Topographic carving, 8-12 % stepover on a 6 mm ball: https://twotrees3d.com/blogs/knowledge/topographic-map-carving-without-stair-stepping-step-over-math-toolpaths-and-grain-control
- CNC Dad rose (1/4-1/2 in depth on 6x7.5-12x15 in, 1/4 in ball rough, 1/16 in TBN finish): https://www.cnc-dad.com/models/rose-bloom/
- Craftgineer photo to relief (1/2 in max in 3/4 in stock, 10 / 15 / 20 % stepover, 1/8 or 1/16 in ball): https://craftgineer.com/blog/photo-to-3d-relief
- pngcam dagger (3.9 px/mm, 2 mm ball finish): https://incoherency.co.uk/blog/stories/cnc-heightmap-toolpaths.html
- Coin relief 0.3-0.5 mm, high relief to 3 mm: https://coinsweekly.com/high-relief-issues-rediscovering-slowness/ ; medals: https://en.wikipedia.org/wiki/Medal
- Blender Displace (strength 1.0, mid_level 0.5): https://docs.blender.org/api/current/bpy.types.DisplaceModifier.html
- 3dp.rocks lithophane defaults: https://3dp.rocks/lithophane/data/layout.json
- dmap2gcode: https://www.scorchworks.com/Dmap2gcode/dmap2gcode_doc.html
- 8-bit vs 16-bit height maps (256 vs 65,536 levels): https://texturemap.app/height-map-generator ; https://omnvert.com/en/tutorials/prepare-height-map-for-stl
- Photo clipping is a LienCAM default; measure retained detail with the portrait fixture (S8).
- Response-time limits 0.1 s / 1 s / 10 s (Nielsen): https://www.nngroup.com/articles/response-times-3-important-limits/
- Tapered ball nose, 3.6 deg, 1/32 in radius, 1/4 in shank (Amana 46281): https://www.amanatool.com/46281-cnc-2d-and-3d-carving-3-6-deg-tapered-angle-ball-tip-1-16-dia-x-1-32-radius-x-1-1-2-x-1-4-shank-x-3-inch-long-x-3-flute-solid-carbide-up-cut-spiral-zrn-coated-router-bit.html
- Popular Woodworking, creating CNC textures ("evenly lit without long shadows"): https://www.popularwoodworking.com/techniques/creating-cnc-textures/
