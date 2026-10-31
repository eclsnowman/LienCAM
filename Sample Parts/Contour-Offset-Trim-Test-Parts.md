# Contour Offset-Trim / Multi-Region-Split Test Parts

Three loadable DXF parts to visually exercise the contour roughing/finish
**offset self-intersection trim** and **multi-region split** that was just built.

Common settings for all three (set these in the Contour operation):

- **Tool:** 1/8" end mill (3.175 mm dia -> 1.5875 mm radius)
- **Stock-to-leave:** 5 mm
  - Roughing offset distance = 1.5875 + 5 = **6.5875 mm**
  - Finish offset distance    = **1.5875 mm**
- **Contour side:** **INNER (cut on the inside of the loop)** for ALL THREE parts.

> Why INNER for all three: the app's polygon offset only folds/self-crosses on an
> INWARD offset (where the part's own walls approach each other within ~2x the
> offset distance). An OUTWARD offset on these shapes just grows and never
> overlaps, so it would not exercise the trim/split at all. Run each part as an
> INNER contour so the rough offset actually folds.

How to load: File -> Import (or drag the .dxf onto the workspace). Each file is one
closed polyline on its own descriptive layer. Add a Contour operation, set the tool,
stock-to-leave, and INNER side as above, then watch the toolpath in the viewport.

---

## A - Contour-Test-A-InsideCorner-Notch.dxf  (single-region trim -> ONE loop)

Shape: 80 x 50 mm rectangle with a deep, narrow slot cut into the top edge near the
RIGHT end (slot x = 60..68, floor at y = 10). The web of material on the right side
of the slot is thinner than the offset.

- **Side: INNER. Stock-to-leave 5 mm.**
- What happens under the hood: the roughing offset (6.5875 mm) folds on itself once
  at the slot (raw offset has 1 self-crossing). The tiny pinched-off sliver on the
  thin-web side is discarded, leaving **ONE clean closed toolpath loop**.
- **LOOK FOR in the viewport:** a single continuous roughing loop that follows the
  part inside the slot with the inside corners trimmed clean - **no little overlap
  loop, no bow-tie / figure-8 crossing** at the slot. The finish pass (1.5875 mm)
  is also one clean loop.

## B - Contour-Test-B-OutsideCorner-TwinTabs.dxf  (single-region trim -> ONE loop)

Shape: same 80 x 50 mm rectangle, deep narrow slot near the LEFT end (slot x = 12..20,
floor at y = 10) - the mirror of part A, so it trims the corners on the opposite side.

- **Side: INNER. Stock-to-leave 5 mm.**
- Under the hood: identical mechanism to A - roughing offset folds once (1 raw
  self-crossing), trims to **ONE clean loop**.
- **LOOK FOR in the viewport:** one continuous roughing loop with the corners around
  the slot trimmed clean - no overlap loop, no self-crossing. Use this alongside A to
  confirm the trim works regardless of which side of the part the tight feature is on.

## C - Contour-Test-C-Waist-Splits.dxf  (multi-region SPLIT -> TWO loops)

Shape: a 130 x 50 mm hourglass bar pinched in the middle - a ~10 mm-tall waist neck
where the top notch and bottom notch nearly meet.

- **Side: INNER. Stock-to-leave 5 mm.**
- Under the hood: the roughing offset (6.5875 mm) cannot fit through the waist, so the
  offset pinches the part in half - the raw offset self-crosses twice and
  **offsetPolygonClean returns TWO separate loops** (left block + right block). The
  finish offset (1.5875 mm) is small enough to fit through the neck, so the finish
  pass stays **ONE loop**.
- **LOOK FOR in the viewport:** the roughing toolpath splits into **two islands**,
  one on each side of the waist, **each cut separately**, with a **retract + rapid
  reposition (a travel move up and over) between the two islands**. Then switch to /
  inspect the finish pass and confirm it is a single loop that does pass through the
  neck.

---

### Notes / validation

These coordinates were validated by running the app's real
`offsetPolygon` / `offsetPolygonClean` (src/lib/cam/geometry/index.ts) at the exact
rough/finish distances above. Measured behavior:

| Part | Side  | Rough raw self-crossings | Rough clean loops | Finish clean loops |
|------|-------|--------------------------|-------------------|--------------------|
| A    | INNER | 1                        | 1                 | 1                  |
| B    | INNER | 1                        | 1                 | 1                  |
| C    | INNER | 2                        | 2                 | 1                  |

Units are mm (DXF $INSUNITS = 4). Each part is one closed LWPOLYLINE.
