// WO UI-74-R3 item 3 -- the OPEN-DEFECT-UI-76 pin, and the two-directional
// per-corner band rule that keeps it honest.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
// It lived inside ui74-depth-site-census.mjs, which is a top-level script: it
// boots a vite server and a real-GPU browser the moment it is imported, so its
// band rule could only ever be exercised by a full live census run. That made the
// rule's own correctness a passenger on the census's mechanism working. It is
// extracted here so the rule is DIRECTLY testable against named numbers --
// src/tests/viewport/openDefectPinBands.ui74.test.ts is the can-fail table, and
// it carries the R3 audit's own counter-example as a row.
//
// This is the same shape the R1 audit's MINOR 2 forced on the GPU classifier
// (tools/capture/lib/real-gpu.mjs + realGpuClassifier.ui74.test.ts): a decision
// table that can be asserted in both directions beats a function nobody can call.
//
// ── THE ADJUDICATION THIS IMPLEMENTS ────────────────────────────────────────
// The R1 audit found the census turning a live, clipped, non-exempt workbench
// surface into a passing knownGap. The Architect's binding ruling ("censuses do
// not paper live defects") was that the clipped datum-plane surface is a REAL
// OPEN DEFECT owned by board row UI-76 -- never a knownGap -- carried under a
// TEMPORARY pin that is (a) bound to exact genesis node IDs, (b) bound to
// bounded expected measurements, (c) labelled OPEN-DEFECT-UI-76 wherever it is
// printed or banked, and (d) can-fail: any other clipped surface, any new genesis
// root, or a measurement outside the bounds turns the census RED.
//
// (d) is where R2 failed, and the failure is worth stating plainly because it is
// a trap that looks like a fix. R2 encoded each id's bound as ONE OUTER ENVELOPE
// -- `minDepth >= band[0] && maxDepth <= band[1]` -- which constrains a surface
// only from getting BIGGER. The R3 audit's counter-example: datum:XZ is pinned
// from measured corners 75.27..164.73; an improvement to 75.27..160.00 is STILL
// CLIPPED (the live far plane is 157.42) but passes, because 160.00 <= 166.73.
// So the pin could silently absorb a 4.73mm change in the geometry it claims to
// describe -- which is a knownGap wearing a different word, the exact thing the
// adjudication forbade.
//
// The fix is per-CORNER bands, each a two-sided interval. A corner that moves
// more than the tolerance in EITHER direction makes the pin STALE and a human
// must hand-update it or delete it under UI-76. An improvement is not good news
// to be swallowed: it means the numbers in this file are lies, and the next
// reader will believe them.

export const OPEN_DEFECT_PINS = [
  {
    id: 'OPEN-DEFECT-UI-76',
    camera: 'workbench-runtime',
    identity: 'workbench genesis plane glyphs are clipped by UI-72\'s body-fitted slab (Operator N-33/N-36, one surface across)',
    board: 'UI-76 -- a REAL OPEN DEFECT with a visible board row, not a gap in this census. '
      + 'UI-76\'s acceptance includes DELETING this pin.',
    // (a) the exact IDs. Nothing else can wear this pin.
    ids: ['datum:XZ', 'datum:YZ'],
    identify: (r) => r.genesisNodeId === 'datum:XZ' || r.genesisNodeId === 'datum:YZ',
    // (b) PER-CORNER bounded bands, both directions (R3 item 3, correcting AM4).
    // Centred on the audit's clean real-GPU measurements -- datum:XZ
    // 75.27..164.73, datum:YZ 73.68..166.32, against slab 68.01..157.42 -- at
    // AM4's +/-2mm tolerance, with each CORNER given its own interval.
    bands: {
      'datum:XZ': { min: [73.27, 77.27], max: [162.73, 166.73] },   // measured 75.27 / 164.73
      'datum:YZ': { min: [71.68, 75.68], max: [164.32, 168.32] },   // measured 73.68 / 166.32
    },
    tolerance: '+/-2mm on the audit\'s measured corners, PER CORNER, both directions (R3 item 3, correcting AM4)',
    measuredBy: 'the R1 audit\'s clean independent real-GPU run, 2026-07-17',
    found: 'UI-74-R1, by this census. The 80mm origin plane glyphs (genesisGlyphs.ts '
      + 'buildPlaneGlyph, PLANE_HALF_MM=40, mounted always-on per UI-17) are REAL DRAWN GEOMETRY '
      + '-- genesisGlyphs.ts:53 says so in as many words: "the glyph is real geometry in the scene '
      + 'and occludes correctly behind solids". They are neither body bounds nor a registered '
      + 'DepthExtentRoot, so UI-72\'s slab does not frame them, and their far corners are cut.',
    whyNotFixedHere: 'the fix is a DepthExtentRoots registration in genesisGlyphs.ts / '
      + 'SolidsWorkbenchPage.tsx, and UI-74\'s ownership manifest is explicit: the workbench '
      + 'sceneRuntime/DepthExtentRoots is UI-72\'s SHIPPED code -- read, cite, do NOT edit. So the '
      + 'defect is disclosed, bounded and carried on the board as UI-76, which is what an open '
      + 'defect gets. What it does not get is a green label.',
  },
]

/** Render a pin's per-corner bands for a human. */
export const renderBands = (band) => band === undefined || band === null ? '(NO BAND FOR THIS ID)'
  : `near-corner ${band.min[0]}..${band.min[1]}, far-corner ${band.max[0]}..${band.max[1]}`

/** AM4 AS CORRECTED BY R3 ITEM 3 -- judge a pinned surface's TWO CORNERS
 *  INDEPENDENTLY, each against its own two-sided band, and NAME the direction of
 *  any drift.
 *
 *  Returns { band, inBand, drift[] }. `inBand` is true only when BOTH corners sit
 *  inside their own intervals; `drift` names every corner that does not, which
 *  way it went, and by how much -- because the reader's next act is to hand-update
 *  a number or delete the pin, and neither is possible from "out of band". */
export function evalPinBands(pin, genesisNodeId, minDepth, maxDepth) {
  const band = pin.bands[genesisNodeId]
  if (band === undefined) {
    return { band: null, inBand: false, drift: [`'${genesisNodeId}' carries pin ${pin.id} but the pin declares NO BAND for that id`] }
  }
  // A NaN corner compares false against BOTH bounds, so `value >= lo && value <=
  // hi` is false and the corner is refused -- which is the direction we want
  // (charter 3: NaN > tol is false in both directions, so it must never be the
  // thing that decides a pass). Say so explicitly rather than relying on it.
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth)) {
    return { band, inBand: false, drift: [`NON-FINITE depth measured for '${genesisNodeId}' (min=${minDepth}, max=${maxDepth}) -- a pin cannot bound a number that is not one`] }
  }
  const drift = []
  // Each corner against ITS OWN interval. `worseWhen` says which way is the
  // defect growing, so the message can distinguish a regression from an
  // improvement -- both fail, but a human does different things about them.
  const judge = (label, value, lo, hi, worseWhen) => {
    if (value >= lo && value <= hi) return
    const improved = worseWhen === 'below' ? value > hi : value < lo
    const edge = improved ? (worseWhen === 'below' ? hi : lo) : (worseWhen === 'below' ? lo : hi)
    drift.push(`${label} corner measured ${value.toFixed(2)}, outside its band ${lo}..${hi} -- `
      + `${improved ? 'IMPROVED' : 'WORSENED'} by ${Math.abs(value - edge).toFixed(2)}mm beyond the +/-2mm tolerance`
      + (improved ? ' (the defect moved toward fixed while still clipped: this pin is STALE, hand-update or delete it under UI-76)' : ''))
  }
  judge('near', minDepth, band.min[0], band.min[1], 'below')  // smaller min = reaches further past near = worse
  judge('far', maxDepth, band.max[0], band.max[1], 'above')   // larger max = reaches further past far = worse
  return { band, inBand: drift.length === 0, drift }
}
