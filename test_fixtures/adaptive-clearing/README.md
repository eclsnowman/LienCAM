# Sketch1 adaptive-clearing test fixtures

Generated from `Sketch1.dxf`. Stock-vs-cut interpretation taken from the reference
screenshot: **grey = stock (uncut), blue = cut pockets**. Each closed DXF shape is a
pocket to clear; the big rectangle is the stock plate; the circle inside the square is
an **island** (stays as stock).

## Files
- `Sketch1_multiregion_fixture.json` — all 9 pockets on one stock plate, in the
  screenshot layout. Use this to test multi-region clearing + cross-region linking.
- `<Name>_fixture.json` — one pocket each, translated to a local origin with its own
  snug stock rectangle. Single-pocket schema, same input fields as the existing
  `*_morph_m0.json` fixtures, so the morph-viewer file picker loads them directly.
- `preview.png` — visual check (blue = cut, grey = stock, red = seed, cyan = per-region stock).

## Region map (DXF shape -> fixture)
Boomerang(L/7), Slot(narrow rect), CommaSpiral(hooked spiral), Kidney(concave blob),
Triangle(right tri), SquareIsland(square + circular island), Bar(tall rect),
BootL(boot/L), Tee(T).

## Schema (input fields)
`toolRadius, stepover, cellSize, firstLevel, marginRevolutions` — process params.
`stock` (Vec2[]) — stock rectangle corners (additive; the grey/cyan rect).
`boundary` (Vec2[]) — pocket to clear, wound CCW.
`islands` (Vec2[][]) — interior holes, wound CW (uncut).
`seed` (Vec2) — advisory deepest-from-wall point; AC recomputes via findSeed.
Multi-region file replaces `boundary/islands/seed` with a `regions[]` array of those.

## IMPORTANT — tool params are placeholders
Defaults are toolRadius=3, stepover=1.5 (50%), cellSize=0.5, firstLevel=3. The
reference CAM tool/stepover are unknown; **set these to match the reference before
comparing toolpaths**, or the ring counts won't line up.

## Notes
- Units: mm (DXF INSUNITS=4).
- Cross-region cutting ORDER is intentionally not encoded — that's the pending
  machining decision in `toolpath_element_convention.md`.
- The DXF geometry is the source of truth for shapes; the screenshot only defined
  stock-vs-cut. A couple of screenshot shapes (e.g. the keyhole) differ from the DXF
  shapes (the DXF has a plain slot there) — the DXF was used.
