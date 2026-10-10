// WO UI-70-R1 -- THE ADVERSARIAL BYPASS, committed as a regression fixture.
//
// The UI-70 auditor broke the round-0 census with this exact move (verbatim):
//
//   "Adversarial reproduction: adding an always-rendered HUD immediately after
//    <ViewportOverlay> with className=sketch-prompt-bar, and no disposition
//    anywhere, left overlayCohesionCensus.test.ts fully green (18/18, EXIT
//    CODE: 0). The contract explicitly requires adding an undispositioned
//    overlay to fail."
//
// It worked because round 0 keyed dispositions by SELECTOR and by FILE:
// `.sketch-prompt-bar` was already dispositioned (as the sketch package's hint
// strip), and the new HUD added no inline position, so both text scans saw a
// domain that had not changed. Nothing about the RENDER TREE was consulted.
//
// This fixture is a viewport host -- the same shape Viewport.tsx has, a
// container with a `.viewport-canvas` child -- carrying FOUR bypasses, one per
// positioning route. overlayCohesionCensus.test.ts walks it with the real
// scanner and asserts every one lands as an undispositioned surface. It is
// never rendered by the app and is unreachable from App.tsx, so it cannot
// pollute the real census; it exists so the census's teeth are proven on the
// attack that defeated its predecessor rather than asserted.
//
// DO NOT "fix" this file by giving its surfaces dispositions. Its whole job is
// to be undispositioned.

/** Stands in for any opaque className binding -- the route a scanner that only
 *  reads string literals cannot see. */
const smuggled: string = 'sketch-prompt-bar'

export function BypassViewport() {
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      {/* BYPASS 1 -- the auditor's own: reuse a class that IS dispositioned at
          its real site (SketchPromptBar), from a brand-new render site. */}
      <div className="sketch-prompt-bar">phantom HUD</div>
      {/* BYPASS 2 -- a NEW positioning route: inline style, no class at all. */}
      <div style={{ position: 'absolute', top: 8, right: 8 }}>inline HUD</div>
      {/* BYPASS 3 -- className computed at runtime: no literal for a text scan
          to match. */}
      <div className={smuggled}>opaque HUD</div>
      {/* BYPASS 4 -- a class that exists in no stylesheet at all, positioned by
          a styled wrapper elsewhere. Caught as INDETERMINATE via the spread. */}
      <div {...{ className: 'brand-new-hud' }}>spread HUD</div>
    </div>
  )
}
