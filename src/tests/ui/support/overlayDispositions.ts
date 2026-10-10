// WO UI-70-R2 -- THE overlay disposition tables, extracted so that the ADVISORY
// static census (src/tests/ui/overlayCohesionCensus.test.ts) and the
// VERDICT-BEARING runtime census (src/tests/ui/overlayRuntimeCensus.test.tsx)
// adjudicate ONE domain rather than two that can drift apart.
//
// R1 kept these inline in the static test. R2 has a second census that must
// answer for the SAME 74 members: if each owned its own copy, a member could be
// dispositioned in one and undispositioned in the other, and the round would
// ship a census whose two halves disagree. One table, two readers.
//
// The tables themselves are UNCHANGED from R1 (the R1 audit re-verified their
// content; only their location moved). What they mean:
//
//   SURFACE_DISPOSITIONS       -- keyed by AUTHORING SITE, one entry per
//                                 in-viewport floating surface.
//   IMPERATIVE_DISPOSITIONS    -- overlays built with document.createElement and
//                                 appended into the live viewport container; no
//                                 React walk can see them, and no jsdom mount can
//                                 host them (the class that builds them is the
//                                 WebGL seam the mounts must fake).
//   UNRENDERED_CLASSES         -- positioned classes app.css carries that no
//                                 surface renders, each named with why.
//   GUARDED_PHANTOM_DISPOSITIONS -- var(--x) with a fallback and no definition.

export type Verdict =
  /** Cohesive with the app design language; the reason carries the evidence. */
  | 'COHESIVE'
  /** Drifted, BOOKED as a follow-up, NOT edited (UI-70 scope fence). */
  | 'RESTYLE-NEEDED'
  /** Positioned but paints nothing: a host, a canvas, a pointer-events:none
   *  layer container. Structure, not surface. */
  | 'STRUCTURAL'
  /** Modal chrome. COHESION-STANDARD.md section 5 governs modality; it is in
   *  this census only because it is position:fixed. */
  | 'MODAL-GOVERNED'
  /** A standalone query-param-gated dev/lab route, not shipped user-facing UI. */
  | 'DEV-ROUTE'
  /** WO UI-70-R2: out of flow, but inside a docked panel / modal form / scrolling
   *  list rather than over a viewport canvas. Only the RUNTIME census sees these
   *  (its membership test is positioning alone, over the whole document -- see
   *  OUT_OF_VIEWPORT_DISPOSITIONS below for why it may not ask about ancestry).
   *  Answered for per site, never filtered out by a rule. */
  | 'PANEL-INTERNAL'

export interface Disposition { verdict: Verdict; reason: string }

const TOOLPATH_FEED_LAYOUT_REASON = 'WO-1062 in-flow metric layout inside the separately dispositioned .sim-panel; the flex container has no position, inset, z-index, background, border, or shadow, and enters the static census only because its shared style object or spread is fail-closed as indeterminate.'
const TOOLPATH_FEED_TEXT_REASON = 'WO-1062 in-flow metric text inside the separately dispositioned .sim-panel; it uses defined typography and text-color tokens with no position, inset, z-index, background, border, or shadow, and enters the static census only because its shared style object is fail-closed as indeterminate.'

// ---------------------------------------------------------------------------
// Derivation R: the render tree
// ---------------------------------------------------------------------------
//
// Keyed by AUTHORING SITE. Every in-viewport floating surface needs an entry;
// a surface with none fails by name, and an entry matching no live surface
// fails as stale.

export const SURFACE_DISPOSITIONS: Record<string, Disposition> = {
  'components/panels/sketch/ReferenceImage2d.tsx:ReferenceImage2dControls > aside.reference-image2d-controls': {
    verdict: 'COHESIVE',
    reason: 'WO-2305 fix: an independent image editor shown only when the 2D project contains an underlay. Authored as a toolbox sibling with explicit fixed positioning, defined bg-panel/border/radius-md/overlay-scrim-2 tokens, shared ReferenceImagePanel fields and a full-width Edit image selector. Fresh 1920x1080 and 1440x900 captures prove the complete Create grid remains visible and the selector does not clip; a real runtime census recipe mounts the surface. No portal, new modal or toolbox row.',
  },
  // --- The subject of this WO -- now a DISPOSITIONED EXCEPTION, not a WO-owned restyle ---
  'components/model3d/workbench/AnchoredValueEntry.tsx:AnchoredValueEntry > div.workbench-anchor-entry': {
    verdict: 'COHESIVE',
    reason: 'DISPOSITIONED EXCEPTION (merge-seam ruling, main 52ec79e9): this WO\'s own R1 class/token restyle -- the "RESTYLED BY THIS WO" surface Operator rejected -- was SUPERSEDED during the main merge by UI-57\'s independently shipped AnchoredValueEntry (v0.12.12). Per the merge commit\'s own ruling, "the branch variant predates it, dead pushpull selector dropped with it": UI-57\'s version wins. It is not an undispositioned regression -- UI-57 passed its OWN design-cohesion audit at the SKC-44 bar with a real-browser-driven card, and it paints every value (background var(--surface-2), border var(--border-accent), text var(--text-secondary)/var(--text-primary)/var(--text-danger), numerics var(--font-mono)) from REAL, DEFINED tokens inline -- the specific UI-58 phantom-token defect (var(--surface-panel), undefined anywhere in src/) this WO exists to catch is still absent and is guarded by derivation C below and by the mutation-proof block in this file. What is genuinely booked, not lost: the token/class refactor under THIS overlay standard (one .workbench-anchor-entry app.css rule instead of inline styles, matching every other COHESIVE member here) is BOOKED, not edited -- BK-168 rider, follow-up WO recommended. See "the AnchoredValueEntry disposition: a NAMED, AUDITED exception" below for the guard that ties this component\'s permitted inline position to THIS live entry, so no other surface can inherit the exception.',
  },

  // --- The reference implementation ------------------------------------------
  'components/model3d/workbench/WorkbenchConfirmBar.tsx:WorkbenchConfirmBar > div.workbench-confirm-bar.workbench-confirm-bar--refusal': {
    verdict: 'COHESIVE',
    reason: 'THE reference: the bottom hint bar Operator\'s own card blessed ("DOES look consistent and stays"). Full semantic-token set (--surface-1 / --border-accent / --radius-md / --font-size-sm / --text-primary), app.css:6864. One authoring site serves all six render sites in SolidsWorkbenchPage.',
  },

  // --- CAM viewport chrome (Viewport.tsx host subtree) ------------------------
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-overlay': {
    verdict: 'STRUCTURAL',
    reason: 'The overlay LAYER host (pointer-events:none container, app.css:2678); carries no paint of its own -- every child is dispositioned in its own right below.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-badge': {
    verdict: 'COHESIVE',
    reason: 'Token-styled viewport chrome (app.css:2685); its border/colour come from the viewportColors.ts bridge (asHex(--vp-axis-z) etc.), the sanctioned CSS<->Three.js seam, so the badge can never drift from the 3D scene.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-machine-info': {
    verdict: 'COHESIVE',
    reason: 'Token-styled viewport chrome (app.css:2700); no raw literal in its own block.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-selection-info': {
    verdict: 'COHESIVE',
    reason: 'Token-styled viewport chrome (app.css:2757); no raw literal in its own block.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-axis-legend': {
    verdict: 'COHESIVE',
    reason: 'Axis legend (app.css:2866); dot colours bridged through viewportColors.ts (asHex(--vp-axis-*)) so they equal the 3D axes exactly.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.tp-legend-wrap': {
    verdict: 'COHESIVE',
    reason: 'Toolpath legend host (app.css:5689); role colours come from the tokens.css toolpath role palette via the viewport bridge (roleColors).',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.tp-legend': {
    verdict: 'COHESIVE',
    reason: 'Toolpath legend body (app.css:5732); paired with .tp-legend-wrap, same bridged role palette -- no hand-copied hex.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.sketch-empty-hint': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). Raw hex #dcffe9 (app.css:2820) where a --text-* token belongs. Follow-up WO recommended in the UI-70 report.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The lay-on-face instruction banner: raw hex #e0f4ff (app.css:2781) and its -dot #00d4ff (:2795-2796) in an otherwise token-driven component. Cheapest remaining win. Follow-up WO recommended in the UI-70 report.',
  },
  'components/viewport/ViewportOverlay.tsx:ViewportOverlay > div.viewport-mode-banner#2': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The project-plane instruction banner -- a SECOND authoring site of the same drifted class (ViewportOverlay.tsx:116), which is why the key is per-site: fixing one does not fix the other. Same raw hex as #1. Follow-up WO recommended in the UI-70 report.',
  },
  'components/viewport/ViewportToolbar.tsx:ViewportToolbar > div.viewport-toolbar': {
    verdict: 'COHESIVE',
    reason: 'Token-styled in-viewport toolbar (app.css:2944).',
  },
  'components/viewport/ViewCube.tsx:ViewCube > div.view-cube-wrap': {
    verdict: 'COHESIVE',
    reason: 'Nav-cube gizmo (app.css:2901); COHESION-STANDARD.md section 2 item 5 names it as shipped viewport furniture. Token-styled, and reused as-is by the workbench through WorkbenchViewCube.',
  },
  'components/viewport/ViewCube.tsx:ViewCube > span.view-cube-label': {
    verdict: 'COHESIVE',
    reason: 'Nav-cube face label (app.css:2925); token-styled, paired with .view-cube-wrap.',
  },
  'components/viewport/DisplayModeControl.tsx:DisplayModeControl > div.display-mode-control': {
    verdict: 'COHESIVE',
    reason: 'Token-styled (app.css:5991); the chip+flyout precedent COHESION-STANDARD.md section 5 points new work at.',
  },
  'components/viewport/DisplayModeControl.tsx:DisplayModeControl > div.planes-flyout': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). Its .planes-flyout-hide-all:hover uses raw #ff6666 (app.css:6110) where --text-danger/--status-error belongs, and its own block leans on the fallback-guarded --border-overlay phantom (:6116, :6122). Follow-up WO recommended in the UI-70 report.',
  },
  'components/simulation/SimulationPanel.tsx:SimulationPanel > div.sim-panel': {
    verdict: 'COHESIVE',
    reason: 'Toolpath-mode feed-estimate panel (app.css:5781); token-styled and anchored in the same bottom panel position as simulation mode.',
  },
  'components/simulation/SimulationPanel.tsx:SimulationPanel > div.sim-panel#2': {
    verdict: 'COHESIVE',
    reason: 'Simulation panel (app.css:5781); token-styled, and publishes --sim-panel-h imperatively (SimulationPanel.tsx setProperty) -- a JS-side definition, not a phantom (derivation C recognises it).',
  },
  'components/simulation/SimulationPanel.tsx:SimulationPanel > div.sim-speed-flyout': {
    verdict: 'COHESIVE',
    reason: 'Simulation speed flyout (app.css:5870); token-styled, closed by default, opened only by the playback-speed chip, and dismissed by speed selection, chip toggle, or an outside mousedown.',
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#2': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#3': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#4': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#5': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#6': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#7': {
    verdict: 'STRUCTURAL',
    reason: TOOLPATH_FEED_LAYOUT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#2': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#3': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#4': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#5': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#6': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#7': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#8': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#9': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#10': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#11': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#12': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#13': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#14': {
    verdict: 'COHESIVE',
    reason: TOOLPATH_FEED_TEXT_REASON,
  },

  // --- Workbench viewport chrome (SolidsWorkbenchPage host subtree) -----------
  // WO GEO-UNIFY-S1b: the Model workspace header's own switcher-dropdown
  // click-outside-to-close backdrop (ModelWorkspaceHeader.tsx, an unclassed
  // `<div style={{position:'fixed', inset:0, ...}}>`, keyed bare because it
  // carries no className). See commit 523dc5256's own precedent
  // (ModelEntryModal's undispositioned backdrop) for the shape of this fix.
  'components/model3d/ModelWorkspaceHeader.tsx:ModelWorkspaceHeader > div': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'The switcher dropdown\'s click-outside-to-close backdrop (ModelWorkspaceHeader.tsx, rendered only while the switcher is open) -- INLINE position:fixed/inset:0/zIndex, the SAME "own click-catcher built with inline styles instead of one of the two sanctioned context-menu models" shape TreeContextMenu.tsx\'s own backdrop just below already carries (COHESION-STANDARD.md section 3). BOOKED, not edited (scope fence) -- same category of pre-existing, accepted drift, not a new one. Its sibling menu (`div.model-workspace-switcher-menu`, dispositioned in OUT_OF_VIEWPORT_DISPOSITIONS below -- it renders inside the docked left panel, not over the canvas) reuses real tokens (surface-2/border-subtle/radius-md, TreeContextMenu\'s own token choices); only this backdrop repeats the inline-style pattern.',
  },

  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div': {
    verdict: 'STRUCTURAL',
    reason: 'The workbench ROOT (SolidsWorkbenchPage.tsx:6599). Its position:fixed inset:0 is the STANDALONE ?lab3d=1&workbench=1 route\'s full-viewport shell; App\'s embedded host takes the position:relative flex branch instead (INT-13A-R2). A shell, not a surface: it paints --surface-page and hosts the dock/viewport/rail row. MERGE-SEAM NOTE (INT-14): the enclosing component is now SolidsWorkbenchPageDocument -- INT-14 wrapped the page so a fresh document load/save can remount it by key; the exported SolidsWorkbenchPage (SolidsWorkbenchPage.tsx:1145) is now a thin `<SolidsWorkbenchPageDocument key={documentGeneration} .../>` shell. Same site, same surface, renamed enclosing scope -- re-keyed, not re-adjudicated.',
  },
  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > canvas': {
    verdict: 'STRUCTURAL',
    reason: 'THE viewport canvas (SolidsWorkbenchPage.tsx:6875) -- the element the 3D scene paints into, which is what makes its parent a viewport host in this census\'s own host rule. It is the thing overlays float OVER, not an overlay. MERGE-SEAM NOTE (INT-14): re-keyed to SolidsWorkbenchPageDocument, the new enclosing scope INT-14\'s document-remount wrapper introduced -- same site, same surface.',
  },
  'components/model3d/workbench/WorkbenchDisplayMode.tsx:WorkbenchDisplayMode > div.display-mode-control': {
    verdict: 'COHESIVE',
    reason: 'The workbench display-mode chip (app.css:5991), docked by the cube exactly as CAM\'s DisplayModeControl is -- same class, same token treatment (UI-17 criterion 7).',
  },
  'components/model3d/workbench/WorkbenchDisplayMode.tsx:WorkbenchDisplayMode > div.planes-flyout': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The workbench\'s own authoring site of the same drifted .planes-flyout class as DisplayModeControl\'s (raw #ff6666 at app.css:6110, --border-overlay phantom at :6116/:6122). Both sites are booked; the follow-up WO must fix the shared CSS once and re-run this census.',
  },
  'components/ui/NumericInput.tsx:NumericInput > input': {
    verdict: 'COHESIVE',
    reason: 'INDETERMINATE to the scanner (className and style are both props), and in the domain because NumericInput is reachable from a viewport host. It is a shared token-styled form input, not a floating surface: its className is supplied by each caller and it sets no position of its own. Read as an overlay ONLY because this census refuses to assume an unresolvable binding is harmless -- the fail-closed default that keeps a computed className from smuggling a HUD in (bypass 3 of the committed fixture).',
  },

  // --- Sketch overlays: the SketcherOverlays port, per MEMBER -----------------
  // The audit's own words: "Existing SketcherOverlays children also share base
  // positioned classes instead of receiving the required per-member
  // dispositions." Round 0 dispositioned `.sketch-dim-layer` ONCE; two
  // different overlays author it. Each authoring site now answers for itself.
  'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > div.sketch-dim-layer': {
    verdict: 'COHESIVE',
    reason: 'SketchDimensionOverlay host layer (app.css:1774). The sketcher IS the feel bar (T-SKC-PARITY, COHESION-STANDARD.md section 0); zero non-fallback raw hex across the sketch-overlay family.',
  },
  'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > div': {
    verdict: 'COHESIVE',
    reason: 'The dimension LABEL (SketchDimensionOverlay.tsx:298). INDETERMINATE to the scanner because its className is a computed join of .sketch-dim-label plus state modifiers (-reference/-conflict/-selected, lines 289-293) -- the census reports rather than guesses. All four classes are token-styled (app.css:1782+).',
  },
  'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > div.sketch-dim-editor': {
    verdict: 'COHESIVE',
    reason: 'Sketch dimension inline editor (app.css:1865); token-styled.',
  },
  'lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx:SketchDimensionOverlay > div.sketch-dim-label.sketch-dim-preview.sketch-dim-preview-hint': {
    verdict: 'COHESIVE',
    reason: 'The placement-preview dimension label (app.css:1782 + preview modifiers); token-styled, a distinct authoring site from the live label above.',
  },
  'lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx:SketchLiveDimsOverlay > div.sketch-dim-layer.sketch-live-dim-layer': {
    verdict: 'COHESIVE',
    reason: 'The SECOND authoring site of .sketch-dim-layer (live draw dims, app.css:1774) -- invisible to a selector-keyed census, named here. Token-styled.',
  },
  'lib/sketch/sketcher/overlays/SketchLiveDimsOverlay.tsx:SketchLiveDimsOverlay > div.sketch-dim-label.sketch-live-dim': {
    verdict: 'COHESIVE',
    reason: 'Live draw-dimension label (app.css:1782 + .sketch-live-dim); token-styled.',
  },
  'lib/sketch/sketcher/overlays/SketchDrawValueInput.tsx:SketchDrawValueInput > div.sketch-dim-editor.sketch-draw-value': {
    verdict: 'COHESIVE',
    reason: 'The type-a-value box (app.css:1865 + .sketch-draw-value); token-styled, reuses the dim-editor treatment.',
  },
  'lib/sketch/sketcher/overlays/SketchTextInput.tsx:SketchTextInput > div.sketch-text-editor': {
    verdict: 'COHESIVE',
    reason: 'The WYSIWYG sketch text input (app.css:1940); token-styled.',
  },
  'lib/sketch/sketcher/overlays/SketchTextAnchorPill.tsx:SketchTextAnchorPill > div.sketch-dim-editor.sketch-text-anchor-pill': {
    verdict: 'COHESIVE',
    reason: 'The on-path text anchor pill (app.css:1865 + .sketch-text-anchor-pill); token-styled, reuses the dim-editor treatment.',
  },
  'lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar > div.sketch-prompt-bar': {
    verdict: 'COHESIVE',
    reason: 'The bottom-centre tool-status hint strip COHESION-STANDARD.md section 4 names as the shipped hint pattern (app.css:6269); token-styled. THIS is the site the auditor\'s bypass impersonated from Viewport.tsx -- the class being dispositioned here says nothing about any other site.',
  },
  'lib/sketch/sketcher/overlays/SketchPromptBar.tsx:SketchPromptBar > div.sketch-prompt-bar.sketch-prompt-bar-idle': {
    verdict: 'COHESIVE',
    reason: 'The idle-state prompt bar (app.css:6269 + .sketch-prompt-bar-idle), a second authoring site in the same component; token-styled.',
  },
  'lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > div.sketch-confirm-overlay': {
    verdict: 'COHESIVE',
    reason: 'Sketch confirm overlay (app.css:6368); token-styled, and the nowrap contract .workbench-confirm-bar cites as its own precedent.',
  },
  'lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > input': {
    verdict: 'COHESIVE',
    reason: 'The confirm overlay\'s numeric field (SketchConfirmOverlay.tsx:120). INDETERMINATE to the scanner because its style is computed per field; it sets no position and paints from the .sketch-confirm-field rule. Reported rather than assumed harmless.',
  },
  'lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > button.sketch-prompt-btn': {
    verdict: 'COHESIVE',
    reason: 'WO-1570\'s chamfer mode-select buttons (SketchConfirmOverlay.tsx:178, one per model.modeOptions entry) and its Swap button (SketchConfirmOverlay.tsx:191) collapse into this one authoring-site key -- same component, same .sketch-prompt-btn class already used by this overlay\'s own Apply/Cancel buttons and by SketchPromptBar. INDETERMINATE to the scanner because the mode button\'s style is a selected-state conditional (fontWeight/textDecoration only -- no position) and the Swap button carries no style prop at all; same treatment as the input entry above. Neither sets position; both are ordinary in-flow controls inside the (genuinely floating, separately dispositioned) .sketch-confirm-overlay panel.',
  },
  'components/model3d/dialogs/FilletDialog.tsx:FilletDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay': {
    verdict: 'COHESIVE',
    reason: 'DESIGN TRUTH (WO UX-KEYFLOW-1): this role=toolbar bottom command strip deliberately reuses the sanctioned SketchConfirmOverlay pattern Operator approved as the reference flow. The shared .sketch-confirm-overlay and .sketch-confirm-* vocabulary supplies the surface and controls; .fillet-command-strip qualifies only its compact bottom layout, and .fillet-command-strip--refusal adds the token-driven error border. This is the sanctioned confirm-strip family, not a new overlay pattern or modal surface.',
  },
  'components/model3d/dialogs/ChamferDialog.tsx:ChamferDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay': {
    verdict: 'COHESIVE',
    reason: 'DESIGN TRUTH (WO UX-KEYFLOW-1): Chamfer qualifies for the same select-edges plus one primary value interaction Operator accepted for model Fillet. It reuses the exact role=toolbar sketch-confirm-overlay and fillet-command-strip vocabulary without a backdrop, DialogShell, or new styling, so it is the same sanctioned confirm-strip family.',
  },
  'components/model3d/dialogs/ShellDialog.tsx:ShellDialog > div.fillet-command-strip.fillet-command-strip--refusal.sketch-confirm-overlay': {
    verdict: 'COHESIVE',
    reason: 'DESIGN TRUTH: Shell is the same select-faces plus one primary value interaction as Fillet/Chamfer. It reuses the exact role=toolbar sketch-confirm-overlay and fillet-command-strip vocabulary without a backdrop, DialogShell, or new styling, so it belongs to the sanctioned confirm-strip family.',
  },
  'components/viewport/SeatInViseStrip.tsx:SeatInViseStripBody > div.seat-in-vise-strip.seat-in-vise-strip--refusal.sketch-confirm-overlay': {
    verdict: 'COHESIVE',
    reason: 'WO-1586: WO-1574 shipped this command as a modal mounted nowhere; re-hosted here into the same sanctioned role=toolbar sketch-confirm-overlay confirm-strip family as Fillet/Chamfer/Shell above (no backdrop, no DialogShell). Its own .seat-in-vise-strip modifier only styles the four <select> face/body pickers (app.css, next to .fillet-command-strip) and .seat-in-vise-strip--refusal borrows the same error-border treatment .fillet-command-strip--refusal already uses.',
  },
  'lib/sketch/sketcher/overlays/SketchContextMenu.tsx:SketchContextMenu > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'Sketch context-menu host layer (app.css:6432); token-styled. position:fixed, so it is in the domain from anywhere.',
  },
  'lib/sketch/sketcher/overlays/SketchContextMenu.tsx:SketchContextMenu > div.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'Sketch context menu (app.css:6438); token-styled. COHESION-STANDARD.md section 3 names it one of the two sanctioned context-menu models.',
  },

  // --- In-viewport banners authored in MODAL files ---------------------------
  // Real in-viewport overlays that a viewport-host-only walk would have missed
  // entirely: they are position:fixed and rendered while a modal drives a pick.
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner': {
    verdict: 'COHESIVE',
    reason: 'Loop-pick banner (app.css:5568, fixed) shown over the viewport while the operation modal drives a loop pick; painted from the dedicated --surface-banner overlay-chrome token (tokens.css:189).',
  },
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner#2': {
    verdict: 'COHESIVE',
    reason: 'The SECOND loop-pick banner authoring site (NewOperationModalBody.tsx:1806, the chain-pick variant); same --surface-banner token treatment.',
  },
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner#3': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The THIRD loop-pick banner authoring site (NewOperationModalBody.tsx:1822, the B-rep face/edge/datum-plane pick variant) -- same --surface-banner container treatment as its siblings, but its datum-plane-derivation error message paints a raw hex (NewOperationModalBody.tsx:1832, `style={{ color: \'#ff8c8c\' }}`) where --text-danger/--status-error belongs. Follow-up WO recommended.',
  },
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.loop-pick-banner.op-perhole-review-banner': {
    verdict: 'COHESIVE',
    reason: 'The per-hole drill review banner (NewOperationModalBody.tsx:1869), the same banner surface with an op-specific modifier; same --surface-banner token treatment.',
  },
  'components/modals/SetupModal.tsx:SetupModal > div.vertex-pick-banner': {
    verdict: 'COHESIVE',
    reason: 'Vertex-pick banner (app.css:5620, fixed) shown over the viewport while the setup modal drives a stock-corner origin pick (SetupModal.tsx:483); same --surface-banner token as the loop-pick banner.',
  },
  'components/modals/SetupModal.tsx:SetupModal > div.vertex-pick-banner#2': {
    verdict: 'COHESIVE',
    reason: 'The SECOND vertex-pick banner authoring site (SetupModal.tsx:503, the WCS-origin vertex-snap variant that replaces the stock-corner banner above while isPickingVertex is active); same --surface-banner token treatment, no raw literal in its own block.',
  },
  'components/modals/NestModal.tsx:NestModal > div.loop-pick-banner': {
    verdict: 'COHESIVE',
    reason: 'Nest membership loop-pick banner (app.css:5748, fixed, NestModal.tsx:513) shown over the viewport while the nest editor drives a part-membership pick; same --surface-banner token treatment as the other loop-pick banners.',
  },
  'components/modals/SketchEntryModal.tsx:SketchEntryModal > div.loop-pick-banner': {
    verdict: 'COHESIVE',
    reason: 'Sketch-entry part-pick banner (app.css:5748, fixed, SketchEntryModal.tsx:135) shown over the viewport while the sketch-entry modal drives an existing-part pick; same --surface-banner token treatment as the other loop-pick banners.',
  },

  // --- Tree context menus (fixed, so in-domain from anywhere) -----------------
  'components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'The CAM Design-Tree context menu reuses the sketch context-menu host layer (app.css:6432) rather than growing bespoke chrome -- COHESION-STANDARD.md section 3\'s sanctioned model. Token-styled.',
  },
  'components/panels/TreeContextMenu.tsx:TreeContextMenu > div.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'The CAM Design-Tree context menu body (app.css:6438); same sanctioned model, token-styled.',
  },
  'components/modals/PostProcessModal.tsx:PostGcodeContextMenu > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'The G-code flyout\'s context menu reuses the sketch context-menu host layer (app.css:6637) rather than growing bespoke chrome -- COHESION-STANDARD.md section 3\'s sanctioned model. Token-styled.',
  },
  'components/modals/PostProcessModal.tsx:PostGcodeContextMenu > div.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'The G-code flyout\'s context menu body (app.css:6643); same sanctioned model as the CAM/workbench tree context menus, token-styled.',
  },
  'components/viewport/ViewportContextMenu.tsx:ViewportContextMenu > div.sketch-context-overlay': {
    verdict: 'COHESIVE',
    reason: 'The viewport\'s own right-click context menu reuses the sketch context-menu host layer (app.css:6637) rather than growing bespoke chrome -- COHESION-STANDARD.md section 3\'s sanctioned model. Token-styled.',
  },
  'components/viewport/ViewportContextMenu.tsx:ViewportContextMenu > div.sketch-context-menu': {
    verdict: 'COHESIVE',
    reason: 'The viewport\'s own right-click context menu body (app.css:6643); same sanctioned model, token-styled.',
  },
  'components/model3d/dialogs/HoleDialog.tsx:HolePointPickerOverlay > div.hole-point-pick-layer': {
    verdict: 'STRUCTURAL',
    reason: 'The hole point-picker\'s LAYER host (pointer-events:none container, app.css:7162), sized to the viewport via world-to-screen projection so orbit stays available around the candidate points while the transparent Hole dialog is open. Carries no paint of its own -- every child point-target button is dispositioned in its own right below.',
  },
  'components/model3d/dialogs/HoleDialog.tsx:HolePointPickerOverlay > button': {
    verdict: 'COHESIVE',
    reason: 'A single sketch-point candidate marker (HoleDialog.tsx:244). INDETERMINATE to the scanner because its className is built from an array literal filtered and joined at runtime (HoleDialog.tsx:247-251), which the AST walk cannot resolve -- reported rather than assumed harmless. All three classes it can take (hole-point-pick-target / --selected / --hovered, app.css:7170-7195) are token-styled (--accent-cyan border, --surface-1 background, --accent-amber hover/selected), zero raw hex.',
  },
  'components/model3d/tree/TreeContextMenu.tsx:TreeContextMenu > div': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The WORKBENCH tree context menu (TreeContextMenu.tsx:75) is a fixed click-catcher + menu built with INLINE styles rather than the .sketch-context-menu model the CAM tree reuses -- a second context-menu model, which COHESION-STANDARD.md section 3 explicitly limits to two sanctioned ones. Follow-up WO recommended in the UI-70 report.',
  },
  'components/model3d/tree/TreeContextMenu.tsx:TreeContextMenu > div#2': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The menu BODY of the same inline-styled workbench context menu (TreeContextMenu.tsx:84). Booked with its click-catcher above.',
  },
  'components/model3d/tree/TreeContextMenu.tsx:DeleteConfirmDialog > div': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The workbench delete-confirm scrim (TreeContextMenu.tsx:281) is an inline-styled fixed backdrop rather than .modal-backdrop -- a third modality model. Follow-up WO recommended in the UI-70 report.',
  },
  'components/model3d/tree/TreeContextMenu.tsx:DeleteConfirmDialog > div#2': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). The dialog BODY of that same inline-styled confirm (TreeContextMenu.tsx:282). Booked with its scrim above.',
  },

  // --- Themed form controls (UI-BRAND-B3-1, Q-65 "Option 2 - custom list, scoped")
  'components/ui/ThemedListbox.tsx:ThemedListbox > ul.themed-listbox-popup': {
    verdict: 'COHESIVE',
    reason: 'The open dropdown list of the ThemedListbox custom select (app.css:4172, position:fixed). '
      + 'Authored IN PLACE (no portal, per the overlay-authoring law); fixed ONLY so it escapes the '
      + 'Settings / Post-Processor modal body overflow:auto clip, and reachable ONLY inside those two '
      + 'modals (Q-65 scoped custom list; every other native <select> stays native). Fully token-styled, '
      + 'zero raw hex: --bg-panel surface, --border-light border, --overlay-scrim-2 shadow, --radius-md, '
      + '--text-secondary/--text-primary/--text-active option text, --bg-active active row, --accent-blue '
      + 'check -- the same token vocabulary the DisclosureSection popup idiom uses.',
  },

  // --- The shared themed tooltip (WO B3-2, Q-65 "ALL hints get the treatment")
  'components/ui/ThemedTooltip.tsx:ThemedTooltip > div.themed-tooltip': {
    verdict: 'COHESIVE',
    reason: 'The ONE shared themed hover/focus hint (app.css:.themed-tooltip, position:fixed), '
      + 'rendered by the ThemedTooltip singleton mounted once at the app root -- the token-styled '
      + 'replacement for native title= bubbles across src/components (the B3-2 sweep migrated every '
      + 'user-facing title= to a data-tooltip attribute this control reads). Authored IN PLACE (no '
      + 'createPortal, per the overlay-authoring law); position:fixed ONLY so a hint escapes a modal '
      + 'body / docked-panel overflow:auto clip, and pointer-events:none so it can never trap a click. '
      + 'Fully token-styled, zero raw hex: --surface-2 background, --border-strong border, '
      + '--overlay-scrim-2 shadow, --radius-sm, --text-primary text, --font-size-sm/--font-ui/'
      + '--line-tight type, --space-1/--space-2 padding -- the same token vocabulary the pick-banner '
      + 'and DisclosureSection idioms use.',
  },

  // --- Modal chrome: fixed, so present; governed by section 5, not this census
  'components/modals/BooleanMeshDialog.tsx:BooleanMeshDialog > div': {
    verdict: 'MODAL-GOVERNED',
    reason: 'MSH-4-BOOLEAN-EDIT boolean-mesh-vs-model-body dialog (BooleanMeshDialog.tsx:211, position:fixed top-right floating panel with NO backdrop so the 3D scene stays clickable for the viewport click-pick). Reuses the shared modal-container/modal-header/modal-body/modal-footer chrome + tokens; COHESION-STANDARD.md section 5 governs modality, not this census. Fixed, so it is in the domain from anywhere -- the rule that catches the pick banners.',
  },
  'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'WO-2318: the shared sketch row opens ordinary centred Import and Export / Print windows. Both states reuse this one authoring site with the app modal-backdrop/container/header/body chrome, tokens and useDialogFocus; COHESION-STANDARD section 5 governs their modality.',
  },
  'components/modals/ConfirmModal.tsx:ConfirmModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'PROMOTE-SKETCH-FAIL round 2: the app\'s ONE themed confirm dialog (ConfirmModal.tsx), the on-brand replacement for native window.confirm() that Operator flagged as off-theme. Reuses the shared .modal-backdrop scrim (app.css:3609, fixed) + modal-container/modal-header/modal-body chrome and tokens like every sibling modal; COHESION-STANDARD.md section 5 governs modality, not this census. In the domain only because a fixed surface is in it from anywhere.',
  },
  'components/modals/HelpFigure.tsx:HelpFigure > div.help-image-lightbox': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Help-image maximize lightbox (Operator directive 2026-08-03, 5eae1d577: tiny non-clickable help images were "less than useless"). Fixed full-viewport scrim + contained image + caption, layered above the help modal (z 2100); closes via X, Escape (guarded so Help stays open), or scrim click, returning focus to the figure. Token-styled like sibling modal chrome; COHESION-STANDARD.md section 5 governs modality. Fixed, so in the domain from anywhere.',
  },
  'components/modals/HelpFigure.tsx:HelpFigure > button.help-image-lightbox-close': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The lightbox\'s always-visible X close button (fixed top-right, part of the same 5eae1d577 surface): the "clear closure mechanism" Operator explicitly required. Token-styled, focus-visible ring, aria-label. Governed with its parent lightbox under section 5; listed separately only because it is its own fixed-position authoring site.',
  },
  'components/modals/MultiBodyImportModal.tsx:MultiBodyImportModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'IMPORT-MULTIBODY-CHOICE (Operator Q-76): the themed multi-body STEP import '
      + 'landing-shape chooser (MultiBodyImportModal.tsx), store-driven via '
      + 'requestMultiBodyImportChoice/multiBodyImportChoice and mounted once at the App '
      + 'root. Reuses the shared .modal-backdrop scrim (app.css:3288, fixed) + '
      + 'modal-container/modal-header/modal-body chrome and tokens like every sibling '
      + 'modal; COHESION-STANDARD.md section 5 governs modality, not this census. In the '
      + 'domain only because a fixed surface is in the domain from anywhere.',
  },
  'components/modals/ImportStockChoiceModal.tsx:ImportStockChoiceModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'IMPORT-STOCK-PROMPT: the themed import-time stock chooser '
      + '(ImportStockChoiceModal.tsx), store-driven via '
      + 'requestImportStockChoice/importStockChoice and mounted once at the App root. '
      + 'Reuses the shared .modal-backdrop scrim (app.css:3288, fixed) + '
      + 'modal-container/modal-header/modal-body chrome and tokens like every sibling '
      + 'modal (same shell as MultiBodyImportModal); COHESION-STANDARD.md section 5 '
      + 'governs modality, not this census. In the domain only because a fixed surface '
      + 'is in the domain from anywhere.',
  },
  'components/modals/MachineChoiceModal.tsx:MachineChoiceModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed). COHESION-STANDARD.md section 5 governs modality; it covers the whole shell rather than being viewport chrome. In this census only because a fixed surface is in the domain from anywhere -- which is the rule that catches the pick banners above.',
  },
  'components/modals/MachineLibraryModal.tsx:MachineLibraryModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/machine/MachineActionsModal.tsx:MachineActionsModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'MACHINE-CONTROL stage 9: the Machine actions configuration modal (Q-58 boundary: settings-dense config stays modal). Reuses the shared .modal-backdrop scrim (app.css:3609, fixed) + modal-container/header chrome like every sibling modal; COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/machine/MacroEditor.tsx:MacroEditor > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'WO-1706: the macro editor opened from the Macros panel\'s "Edit macros" control (settings-dense config, same Q-58 boundary as MachineActionsModal). Reuses the shared .modal-backdrop scrim (fixed) + modal-container/header chrome like every sibling modal; COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/machine/MeshViewerModal.tsx:MeshViewerModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'WO-416 (Operator ruling 2026-08-21: "I want a visualization of the flatness plane from the mesh. It should popup in a modal to look at ... Something like [Mainsail\'s bed-mesh viewer]"): the surface-mesh flatness viewer, opened from the "Mesh N x N" chip that replaced the full-width "MESH COMPENSATION ACTIVE" banner Operator rejected the same day ("Do not ever apply a huge vertical pixel stealing banner across the entire screen ... Don\'t do that again"). A modal is explicitly sanctioned here per docs/CONVENTIONS.md\'s UI-conventions ruling ("a modal is fine when Operator asks for one as a viewer (mesh flatness viewer, 2026-08-21)"). Reuses the shared .modal-backdrop scrim (app.css:3819, fixed) + modal-container/header/body chrome like every sibling modal; COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  // MC-TIER1 (2026-08-05): the authored Canvas-2D backplot was REMOVED. The
  // Control tab preview is now a real CNCViewport whose canvas THREE appends at
  // runtime, so it has no authoring site for this census to adjudicate.
  'components/machine/ProgramPreviewGridControl.tsx:ProgramPreviewGridControl > div.control-overlay-card.control-overlay-grid-card': {
    verdict: 'COHESIVE',
    reason: 'MACHINE-CONTROL: coordinate-grid selector anchored over the real ProgramPreview CNCViewport (WO-414 batch 2, Operator 2026-08-21 "simplify grid ... one line, and a dropdown with off, machine, and the G54, G55, G56, etc ... No more than that": the card is now just ONE native select - Off / Machine / G54..G59 - top-left, no chevron, no caption; the frame name is its tooltip). Its select reuses the shared .mform-input control vocabulary; surface, border, text and type are semantic tokens.',
  },
  'components/machine/ProgramPreview.tsx:ProgramPreview > div.control-preview-view-rail': {
    verdict: 'COHESIVE',
    reason: 'Operator ruling 2026-08-20 (WO-404, COHESION-STANDARD section 15 item 2): "I want the views buttons where they were." A viewport\'s own navigation control (TOP/FRT/RGT/ISO/MCH/PGM snap + fit) sits inside the viewport it navigates, the same family as the CAM view cube; surface/border/text from semantic tokens.',
  },
  'components/machine/PendantPanel.tsx:PendantPanel > div.pendant-popover': {
    verdict: 'COHESIVE',
    reason: 'Operator ruling 2026-08-20 (WO-404, COHESION-STANDARD section 15 item 1): "pendant pop-out behaved how I asked it to be. Pendant pops right, user interacts, it pops back." A transient flyout anchored to the Pendant button (position:fixed beside the trigger, Escape / outside press / close button dismiss it), allowed to paint over the program preview while open; tokens --surface-1 / --border-accent. Its createPortal route is a NAMED sanction in overlayAuthoringLint.ts keyed to this one site.',
  },
  'components/machine/ProgramPreview.tsx:IntendedStockReadout > div.control-intended-stock-card.control-overlay-bottom-right.control-overlay-card': {
    verdict: 'COHESIVE',
    reason: 'WO-380: the intended-stock readout (which setup/stock the loaded program was posted against, its CURRENT / STALE / NONE state). WO-414 batch 2 (Operator ruling 2026-08-21: "cleaner, allow toggling the stock visibility ... get out of the way ... lower right corner ... avoid covering the visibility of the preview"): ONE line anchored lower-right in the preview frame (.control-overlay-bottom-right) - badge + setup (WCS) + help link + an eye that shows/hides the box in the scene - in the same sanctioned "transient info rides ON the preview" overlay-card pattern (.control-overlay-card, app.css:10959); the view rail (top-right) and the travel-mismatch line (bottom-left) keep their places. Every colour is a semantic token (--surface-1 / --border-subtle / --text-primary / --text-muted / --border-strong / --accent-amber for the stale tint); staleness is carried by the badge TEXT, a data-context-state attribute and a dashed border together, never by colour alone. Advisory only - it cannot arm, start or alter a line.',
  },
  'components/machine/ProgramPreview.tsx:IntendedStockReadout > div.control-intended-stock-popover': {
    verdict: 'COHESIVE',
    reason: 'WO-414 batch 2: the intended-stock facts (Setup / Stock / Size / WCS / note) as a small popover that opens ABOVE the lower-right line when the line is clicked (Escape, the line again, or a press anywhere else closes it) - Operator: "a small popover ABOVE the line, not a card that covers the preview"; the same family as the pendant flyout (transient, anchored to its trigger, dismissed by Escape / outside press), authored in place (position:absolute inside the line\'s card, no portal) because the preview frame does not clip it. Tokens --surface-1 / --border-subtle / --text-primary; the stale tint is the same dashed --accent-amber border as the line. Advisory only.',
  },
  'components/machine/ProgramPreview.tsx:ProgramPreview > div.control-preview-empty.panel-empty': {
    verdict: 'COHESIVE',
    reason: 'MACHINE-CONTROL: the "Path preview appears when a program is loaded" empty-state text, centered over the preview stage. Reuses the shared .panel-empty class (same tokens/typography as every panel empty state) with only positioning added by .control-preview-empty (app.css:8834).',
  },
  'components/machine/ProgramPreview.tsx:TravelMismatchLine > div.control-overlay-bottom.control-overlay-card.control-travel-mismatch': {
    verdict: 'COHESIVE',
    reason: 'WO-292 named the Machine-Library-vs-controller travel disagreement; WO-414 batch 2 (Operator 2026-08-21 on the Table card: "I have no idea how this is supposed to have value. I say remove it") removed the card around it. What is left is this ONE amber line, bottom-left, present only while a mismatch exists - the same sanctioned "transient info rides ON the preview" overlay-card pattern (.control-overlay-card, .control-overlay-bottom) the toolchange / run-from-line cards use; --accent-amber is the token .control-homed-hint already uses for a caution that is not a hard error. The table status (homed / not homed) is the HOME LED\'s job; the fit verdict moved to the status strip under the Control sub-tabs (not a positioned surface).',
  },
  'components/modals/ModelEntryModal.tsx:ModelEntryModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/NestModal.tsx:NestModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census. '
      + 'This is the FIRST authoring site in source order (NewOperationModalBody.tsx:1893), which the component only '
      + 'reaches on the editLoadError early return (7be7f8f43: editing an operation type with no edit UI in this '
      + 'dialog) -- the ordinary create/edit render is the SECOND site, key #2 below.',
  },
  'components/modals/NewOperationModalBody.tsx:NewOperationModalBody > div.modal-backdrop#2': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The SAME modal scrim (app.css:3288, fixed) as the bare key above, at the ordinary "Full modal render" '
      + 'return (NewOperationModalBody.tsx:1923) that every normal create/edit open uses; COHESION-STANDARD.md section 5 '
      + 'governs modality, not this census.',
  },
  'components/modals/PostProcessModal.tsx:PostProcessModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/SettingsModal.tsx:SettingsModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/SketchEntryModal.tsx:SketchEntryModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/HelpCenterModal.tsx:HelpCenterModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/modals/ToolLibraryModal.tsx:ToolLibraryModal > div.modal-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Modal scrim (app.css:3288, fixed); COHESION-STANDARD.md section 5 governs modality, not this census.',
  },
  'components/model3d/dialogs/DialogShell.tsx:DialogShell > div.modal-backdrop.modal-backdrop-transparent': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The workbench dialog shell\'s scrim (app.css:3288, fixed) -- the SHARED shell every workbench dialog should use, and the reason the inline-styled DeleteConfirmDialog above is booked. RE-KEYED (was div.modal-backdrop only): a new allowViewportInteraction prop conditionally adds modal-backdrop-transparent so a dialog-driven pick can leave the viewport clickable, same pattern as SetupModal\'s own modal-backdrop-transparent variant below. Section 5 governs it.',
  },
  'components/model3d/dialogs/DialogShell.tsx:DialogShell > div.modal-container': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Defeature\'s compact draggable property palette: DialogShell conditionally fixes its shared modal-container at the upper-right while its transparent backdrop leaves the viewport interactive. It reuses the same modal header/body/footer chrome and semantic tokens as every workbench dialog; COHESION-STANDARD.md section 5 governs it.',
  },
  'components/model3d/dialogs/DraftDialog.tsx:DraftDialog > aside.draft-command-card': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Draft\'s movable feature-transaction card stays out of the model viewport while preserving direct viewport picking and live preview. It uses the shared command-card tokens and follows COHESION-STANDARD.md section 5 item 5 for non-blocking property palettes.',
  },
  'components/modals/SetupModal.tsx:SetupModal > div.modal-backdrop.modal-backdrop-transparent': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The setup modal\'s transparent scrim variant (app.css:3288, fixed) -- transparent precisely so the user can see the viewport while picking; section 5 governs it.',
  },
  'components/modals/SetupModal.tsx:SetupModal > div.modal-container.setup-modal.setup-modal-compact': {
    verdict: 'MODAL-GOVERNED',
    reason: 'The compact setup-modal body (app.css:3732, fixed) -- modal body positioning, governed by the modality rules rather than the overlay census.',
  },
  'components/modals/PostProcessModal.tsx:GcodeFlyout > div.gcode-flyout-backdrop': {
    verdict: 'MODAL-GOVERNED',
    reason: 'Click-catcher scrim for the G-code flyout (app.css:6590, fixed), anchored to panel chrome rather than the canvas; section 5 governs it.',
  },

  // --- Standalone dev/lab routes ---------------------------------------------
  // Query-param gated (App.tsx:57-58); not shipped user-facing UI. Each is
  // named individually rather than skipped wholesale -- a skip list is an
  // escape hatch, and this WO exists because of one.
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > div': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab shell (WO INT-3, M3 gate demo), mounted only behind ?meshlab=1 (App.tsx:58). Not shipped user-facing UI; its own inline-styled chrome is out of the design-cohesion contract by construction.',
  },
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > canvas': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab canvas (?meshlab=1 only, App.tsx:58) -- the element that makes its parent a host under this census\'s own rule. Dev route, not shipped UI.',
  },
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > div#2': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab in-canvas chrome (?meshlab=1 only, App.tsx:58); dev harness, not shipped UI.',
  },
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > div#3': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab in-canvas chrome (?meshlab=1 only, App.tsx:58); dev harness, not shipped UI.',
  },
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > div#4': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab in-canvas chrome (?meshlab=1 only, App.tsx:58); dev harness, not shipped UI.',
  },
  'components/meshlab/MeshLabPage.tsx:MeshLabPage > div#5': {
    verdict: 'DEV-ROUTE',
    reason: 'Mesh Shop Lab in-canvas chrome (?meshlab=1 only, App.tsx:58); dev harness, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab shell (WO INT-2, M2 gate demo), mounted only behind ?sketch3dlab=1 (App.tsx:57). Not shipped user-facing UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > canvas': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab canvas (?sketch3dlab=1 only, App.tsx:57) -- the element that makes its parent a host. Dev route, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div#2': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab in-canvas chrome (?sketch3dlab=1 only, App.tsx:57); dev harness, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div#3': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab in-canvas chrome (?sketch3dlab=1 only, App.tsx:57); dev harness, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div#4': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab in-canvas chrome (?sketch3dlab=1 only, App.tsx:57); dev harness, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div#5': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab in-canvas chrome (?sketch3dlab=1 only, App.tsx:57); dev harness, not shipped UI.',
  },
  'components/sketch3dlab/Sketch3dLabPage.tsx:Sketch3dLabPage > div#6': {
    verdict: 'DEV-ROUTE',
    reason: 'Sketch3d Lab in-canvas chrome (?sketch3dlab=1 only, App.tsx:57); dev harness, not shipped UI.',
  },
}

// ---------------------------------------------------------------------------
// Derivation D: imperative DOM append sites
// ---------------------------------------------------------------------------

// WO-2622: Form is observed by the production jsdom pointer recipe, while
// the historical IMPERATIVE_DISPOSITIONS table is derived from CNCViewport
// only (overlayCohesionCensus's bidirectional scanner). Keep those domains exact.
export const FORM_IMPERATIVE_DISPOSITIONS: Record<string, Disposition> = {
  'components/model3d/form/formInteraction.ts:form-box-select': {
    verdict: 'COHESIVE',
    reason: 'WO-2506 selection feedback: transient pointer-events:none fixed rectangle over the dragged canvas area, with viewport --vp-select-amber ink and translucent fill. overlayGatePair drives the production pointer route, reads the live fixed surface and proves cleanup. An imperative element has no JSX site; this exact route is checked separately, never used as a generic unattributed-node exemption.',
  },
}

export const IMPERATIVE_DISPOSITIONS: Record<string, Disposition> = {
  'lib/viewport/CNCViewport.ts:slice-plane-overlay': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). Built imperatively by CNCViewport.ts:4903 and appended into the live viewport container, where no React walk can see it. Its family carries raw hex (.sp-z #ffffff app.css:2425; .sp-btn-cancel #333/#ccc/#555 :2473-2478) instead of --text-primary/--surface-*/--border-*. Follow-up WO recommended in the UI-70 report.',
  },
  'lib/viewport/CNCViewport.ts:project-plane-overlay': {
    verdict: 'RESTYLE-NEEDED',
    reason: 'BOOKED, not edited (scope fence). Imperative (CNCViewport.ts:2396); worst drift on the census -- raw hex in CSS (.pp-opt-btn #3a3f4a, .pp-cancel-btn #555/#2a2a2a/#aaa) AND passed as JS string arguments, which no CSS-only restyle can reach. Follow-up WO recommended in the UI-70 report.',
  },
}

// ---------------------------------------------------------------------------
// Derivation A: app.css coverage cross-check
// ---------------------------------------------------------------------------
//
// The render walk is the domain; this proves the walk did not silently LOSE a
// positioned class on the way (a false negative -- the one failure mode a
// render-tree derivation has that a CSS text scan does not). Every positioned
// class in app.css must be claimed by a real surface, or be named here with a
// reason it renders nowhere.

export const UNRENDERED_CLASSES: Record<string, string> = {
  'control-preview-canvas': 'MC-TIER1 (2026-08-05): the Control tab preview became a real CNCViewport, whose canvas THREE appends imperatively into .control-preview-wrap. The authored Canvas-2D backplot this class styled is gone, so nothing writes the class in JSX any more (app.css:9407). Dead CSS to delete in a follow-up; left in place here because app.css is outside this work order\'s owned paths.',
  'viewport-machine-indicator': 'BOOKED, not edited (scope fence). Zero render sites in non-test source (app.css:2968) -- dead CSS to delete. Follow-up WO recommended in the UI-70 report.',
  'viewport-dropzone-active': 'Drag-and-drop affordance ring (app.css:2748), applied to .viewport-root IMPERATIVELY by the drop handler (classList toggle) rather than in JSX -- it decorates the host with a ::after pseudo, and adds no element of its own.',
  'opt-preview-overlay': 'Rendered inside the Design Tree docked panel (DesignTree.tsx:2595), positioned:absolute against that panel -- correctly OUT of the viewport domain, so no surface claims it. Not an overlay over the canvas.',
  'status-batch-fill': 'Progress fill inside the bottom status bar (App.tsx:221), position:absolute within the bar -- out of the viewport domain, so unclaimed by design.',
  'mform-toggle': 'Modal form toggle control (MachineLibraryModal.tsx:412), absolute within its own control -- out of the viewport domain by design.',
  'mform-toggle-track': 'Modal form toggle track (MachineLibraryModal.tsx:414), absolute within its own control -- out of the viewport domain by design.',
  toggle: 'Panel/modal toggle control (PostProcessModal.tsx:1600), absolute within the control itself -- out of the viewport domain by design.',
  track: 'Toggle track internals (PostProcessModal.tsx:1607), absolute within its own control -- out of the viewport domain by design.',
  knob: 'Toggle knob internals (PostProcessModal.tsx:1608), absolute within its own track -- out of the viewport domain by design.',
  'sketch-marquee': 'Rubber-band selection marquee (app.css:2101), drawn IMPERATIVELY by the sketch interaction layer into the canvas host rather than in JSX; --accent-strong with an explicit fallback.',
  'control-jog-wedge': 'MACHINE-CONTROL jog D-pad wedge buttons (JogPanel.tsx), absolute within the Jog panel\'s own square cluster in the right column -- out of the viewport domain by design, so no censused surface claims the class.',
  'hole-point-pick-target': 'Genuinely rendered (HoleDialog.tsx:244-262), but its className is an array literal filtered+joined at runtime, which the AST walk cannot resolve into a claimed class -- so the render walk cannot claim it by name even though it renders. The real authoring site is already adjudicated COHESIVE in SURFACE_DISPOSITIONS as HolePointPickerOverlay > button (the INDETERMINATE-className route, same treatment as NumericInput/SketchConfirmOverlay\'s input).',
  // UI-BRAND-B2-2 (commit 07c5b27cc, 2026-07-23): themed checkbox styling.
  'themed-checkbox': 'The rule is `input[type="checkbox"], .themed-checkbox { ... }` (app.css:94-134); the checked-state checkmark glyph on the compound selector\'s `::after` is what makes the class positioned (app.css:119, position:absolute). It applies to every native checkbox app-wide via the ATTRIBUTE selector on `input[type="checkbox"]`, which paints with no JSX ever writing className="themed-checkbox" -- grep of src/ confirms zero literal uses; the class is "exposed for direct use" per its own comment but nothing currently exercises that route. A className-based render walk cannot claim a surface authored by an attribute selector, so it is unclaimed by design, not a blind spot.',
}

/** Fallback-guarded phantoms that render correctly today. Each still needs a
 *  reason: a guarded phantom is a latent inconsistency (the fallback, not a
 *  token, is the real value), just not a visual defect. */
export const GUARDED_PHANTOM_DISPOSITIONS: Record<string, string> = {
  '--border-overlay': 'BOOKED, not edited (scope fence). Referenced only by .planes-flyout (app.css:6116, :6122), both WITH an rgba fallback, so it paints correctly today -- but the fallback, not a token, is the real value. Either define it or inline the fallbacks; low priority, no visual defect. Follow-up WO recommended in the UI-70 report.',
  '--control-program-preview-fr': 'WO-117 publishes this value at runtime on .control-col-main through programSplitGridStyle(), a typed React style object that the static token-definition scan does not model. The app.css reference carries an explicit 60fr fallback, so the default split paints correctly before or without that publication; this is scanner-classified guarded drift, not a visual defect.',
  '--control-program-list-fr': 'WO-117 publishes this value at runtime on .control-col-main through programSplitGridStyle(), a typed React style object that the static token-definition scan does not model. The app.css reference carries an explicit 40fr fallback, so the default split paints correctly before or without that publication; this is scanner-classified guarded drift, not a visual defect.',
  '--success': 'BOOKED, not edited (WO-2201 scope fence: no product change). ProbeStepPicture.tsx C.running = var(--success, #4ade80) (WO-2063, the lit "running" touch colour) names a token defined nowhere in src/theme/tokens.css; the fallback, not a token, is the real value, so it paints a visible green today -- no visual defect. The repair is to point it at an existing semantic token (e.g. --status-ready / --green-500) or define --success; follow-up for the probing owner.',
  '--font-sans': 'BOOKED, not edited (WO-2201 scope fence: no product change). probingScreen.css .pbn-picture font-family: var(--font-sans, \'DM Sans\', sans-serif) (WO-2063) names a token defined nowhere; the app\'s real UI face token is --font-ui (\'DM Sans\', system-ui, sans-serif in tokens.css), and the fallback paints the same DM Sans face, so no visual defect. The repair is to reference --font-ui; follow-up for the probing owner.',
}

// ---------------------------------------------------------------------------
// WO UI-70-R2: surfaces that are OUT OF FLOW but NOT over a viewport
// ---------------------------------------------------------------------------
//
// A new table, and it exists because amendment A4 changed the membership rule.
//
// The static tier decides "is this over the viewport?" with a MODEL: is it
// authored inside a viewport host's element subtree, or reachable from one, or
// position:fixed. A4 forbids that model as the runtime membership test, in these
// words: "DOM ancestry and geometric rect overlap are NEVER the membership test
// under jsdom (jsdom computes no layout - rects are zero)." The reason is the
// whole history of this WO: ancestry fails open on createPortal into body, and
// rect overlap fails open on everything, always, because jsdom has no layout.
//
// So the runtime census's membership test is POSITIONING ALONE, over the whole
// document. That is strictly wider than SURFACE_DISPOSITIONS' 74: it also
// catches out-of-flow elements that live inside docked panels, modal forms and
// scrolling lists -- real out-of-flow elements that are NOT overlays over the
// canvas.
//
// They are answered for HERE, per authoring site, rather than filtered out by a
// rule -- because a rule is a model, and a model is what was bypassed twice. A
// new positioned element inside a panel still lands as a brand-new key with no
// entry and still fails BY NAME; somebody has to look at it and say which of the
// two tables it belongs in. That is the cost of the closed domain, and it is the
// point of it.
//
// (UNRENDERED_CLASSES above already carried this judgement for a handful of
// classes -- "out of the viewport domain by design". This table is the same
// judgement, made per SITE instead of per CLASS, which is the R1 audit's own
// correction applied consistently.)

export const OUT_OF_VIEWPORT_DISPOSITIONS: Record<string, Disposition> = {
  'components/machine/PendantPanel.tsx:PendantPanel > div.pendant-popover-header': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The pendant flyout\'s own title row ("Enable phone control" / "Phone pairing" + close), position:sticky INSIDE the flyout (out of the viewport hosts\' subtree: it is the flyout\'s own chrome) so it stays put while the pairing body scrolls; it never leaves the flyout (same ruling as its parent, Operator 2026-08-20, WO-404). Tokens --surface-2 / --border-subtle / --text-primary.',
  },
  'components/modals/HelpFigure.tsx:HelpFigure > span.help-figure-expand': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The help figure\'s hover/focus expand chip (5eae1d577): position:absolute in the figure\'s own corner INSIDE the Help modal body, signalling "this image maximizes" - the visible affordance Operator\'s directive demanded. Token-styled, aria-hidden (the figure itself carries the accessible name). Panel-internal chrome over its own thumbnail, never over a 3D viewport.',
  },
  // Machine Control Program tab: absolute workflow status cards over its own
  // g-code preview stage. These are panel-internal preview chrome, not either
  // of the application's 3D viewport canvases. The two failed-state JSX sites
  // remain separate so adjudicating one workflow cannot silently cover another.
  'components/machine/ProgramPanel.tsx:ProgramPanel > div.control-overlay-card.control-overlay-top.control-tc-failed.control-toolchange-banner': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The guided tool-change workflow card\'s failed-state authoring site. It is position:absolute inside .control-preview-stage in the docked Program panel, over the g-code backplot rather than either 3D viewport. .control-overlay-card supplies the shared token surface, .control-toolchange-banner the common workflow stack, and .control-tc-failed changes the border and text to the semantic red accent. It is transient panel status, not a viewport HUD.',
  },
  'components/machine/ProgramPanel.tsx:ProgramPanel > div.control-overlay-card.control-overlay-top.control-tc-failed.control-toolchange-banner#2': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The material-fit-trace workflow card\'s failed-state authoring site, distinct from the guided tool-change card above. It is position:absolute inside the docked Program panel\'s .control-preview-stage and overlays only that panel\'s g-code backplot. The shared token-styled .control-overlay-card/.control-toolchange-banner treatment is qualified by .control-tc-failed for semantic error color. It is transient panel status, not a viewport HUD.',
  },

  // WO GEO-UNIFY-S1b: the Model workspace header's switcher dropdown. Real
  // position:absolute (app.css), but docked to its own panel's header row
  // (SolidsWorkbenchPage.tsx's .panel-left), not painted over the 3D canvas --
  // same judgement as the sticky tree-section headers just below.
  'components/model3d/ModelWorkspaceHeader.tsx:ModelWorkspaceHeader > div.model-workspace-switcher-menu': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The model switcher\'s dropdown list (ModelWorkspaceHeader.tsx, rendered only while the switcher is open) -- token-styled (var(--surface-2)/var(--border-subtle)/var(--radius-md), same floating-menu treatment TreeContextMenu.tsx\'s own popup uses), positioned relative to its trigger inside the docked left panel\'s header row. It replaces the OLD App.tsx `.model-item-editing-banner` (position:absolute, floating unaligned over the app-shell, Operator\'s "looks out of place. does not match visuals or even align" finding) -- this new control is docked panel chrome, not a canvas overlay.',
  },

  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div.tree-section-header.tree-section-header-btn': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The workbench design-tree section header (Sketches). position:STICKY -- a value no static round in this WO ever scanned for (positionedClasses only matched absolute|fixed), so this surface and its three siblings were outside the domain entirely and nothing said so. The runtime census found all four on its first workbench mount. It sticks to the top of its own scrolling tree panel in the docked left rail; it is not over the canvas. MERGE-SEAM NOTE (INT-14): re-keyed to SolidsWorkbenchPageDocument, the new enclosing scope INT-14\'s document-remount wrapper introduced -- same site, same surface.',
  },
  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div.tree-section-header.tree-section-header-btn#2': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The workbench design-tree section header (Features), second authoring site of the same sticky class. Sticks within the docked tree panel, not over the canvas. Per-site rather than per-class for the R1 audit\'s own reason: fixing one site must not silently mark the others clean. MERGE-SEAM NOTE (INT-14): re-keyed to SolidsWorkbenchPageDocument.',
  },
  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div.tree-section-header.tree-section-header-btn#3': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The workbench design-tree section header (Bodies), third authoring site of the same sticky class. Sticks within the docked tree panel, not over the canvas. MERGE-SEAM NOTE (INT-14): re-keyed to SolidsWorkbenchPageDocument.',
  },
  'components/model3d/SolidsWorkbenchPage.tsx:SolidsWorkbenchPageDocument > div.tree-section-header.tree-section-header-btn#4': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The workbench design-tree section header (Datums), fourth authoring site of the same sticky class. Sticks within the docked tree panel, not over the canvas. MERGE-SEAM NOTE (INT-14): re-keyed to SolidsWorkbenchPageDocument.',
  },

  // --- WO UI-70-R3: found by the modal recipes A2's completeness direction ---
  // forced this round to build. Both are parts of PostProcessModal's own Toggle
  // control -- the sliding switch's track and its knob, absolute within the
  // switch itself. They are the same judgement UNRENDERED_CLASSES already
  // carried for MachineLibraryModal's 'mform-toggle'/'mform-toggle-track'
  // ("absolute within its own control -- out of the viewport domain by design"),
  // made per SITE instead of per CLASS. Nothing rendered them until this round,
  // which is the completeness gate paying for itself on its first run.
  'components/modals/MachineLibraryModal.tsx:MachineLibraryModal > span': {
    verdict: 'PANEL-INTERNAL',
    reason: 'WO-2067 machine-list collapse header: absolute top/right within its relative machine-list-col, inside the modal list rail. The shared PanelCollapseToggle occupies the list header without moving list rows; it does not float over the viewport. Observed by the real machine-config modal census recipe.',
  },
  'components/modals/PostProcessModal.tsx:Toggle > span.track': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The sliding track of PostProcessModal\'s own Toggle switch (PostProcessModal.tsx:1607). position:absolute within the .toggle label that contains it -- it is the switch\'s own painted groove, not a surface over the canvas. Identical in kind to the mform-toggle-track entry in UNRENDERED_CLASSES.',
  },
  'components/modals/PostProcessModal.tsx:Toggle > span.knob': {
    verdict: 'PANEL-INTERNAL',
    reason: 'The sliding knob of PostProcessModal\'s own Toggle switch (PostProcessModal.tsx:1608). position:absolute within the .toggle label, which is how it slides across its track. Not a surface over the canvas.',
  },
}

// ---------------------------------------------------------------------------
// THE EXEMPTION LIST (WO UI-70-R3 -- amendment A2's direction two)
// ---------------------------------------------------------------------------
//
// A2, verbatim on this point:
//
//   "(COMPLETENESS) every disposition entry is either (i) observed in at least
//    one committed mount recipe (a named mount + state-driving steps per entry
//    or entry group), or (ii) carries a named non-jsdom disposition mechanism
//    per the exemption list in this order (imperative CNCViewport overlays ->
//    imperative-scan derivation + browser harness; ViewCube -> renderer-stub
//    mount or browser harness; imperative classList surfaces ->
//    UNRENDERED_CLASSES mechanism; DEV-ROUTE surfaces -> advisory static walk).
//    The exemption list itself is a committed, asserted artifact: an entry not
//    observed and not exempted fails the census."
//
// The four mechanisms below are that list, in that order, and nothing else may
// be invented: an entry that is neither observed nor carrying one of these four
// fails. Read the direction of every rule here as fail-closed:
//
//   * An exemption is a CLAIM THAT jsdom CANNOT HOST THE SURFACE. It is not a
//     to-do marker and it is not "we ran out of time". The census asserts the
//     claim: an exempt entry that IS observed in any recipe is a STALE exemption
//     and FAILS -- because if a mount can reach it, the exemption was a lie and
//     the surface must be adjudicated like every other.
//   * Only the mechanisms A2 names are honoured. There is deliberately no
//     'modal-governed' or 'sketch-session' mechanism: those surfaces mount fine
//     in jsdom, so they must be OBSERVED. That is why this WO's recipe list is
//     long, and it is not optional.

export type ExemptionMechanism =
  /** A2 mechanism 1: overlays CNCViewport builds with document.createElement and
   *  appends into the live viewport container. The class that builds them IS the
   *  WebGL seam every mount must fake (amendment A1), so no jsdom mount can host
   *  them by construction. Derived by the imperative scan + browser harness;
   *  answered for in IMPERATIVE_DISPOSITIONS. */
  | 'IMPERATIVE-CNCVIEWPORT'
  /** A2 mechanism 2: ViewCube. NOT USED -- and that is the honest answer. A2
   *  offers "renderer-stub mount or browser harness"; this WO took the mount
   *  (only the five THREE.WebGLRenderer methods it calls are stubbed, its DOM is
   *  real), so ViewCube's surfaces are OBSERVED and need no exemption. The
   *  mechanism is kept in the type because A2 names it and a later round may
   *  need it; the census asserts it claims nothing today. */
  | 'VIEWCUBE'
  /** A2 mechanism 3: classes applied to an existing host by an imperative
   *  classList toggle rather than by JSX. They add no element of their own, so
   *  no surface exists to observe; answered for in UNRENDERED_CLASSES. */
  | 'IMPERATIVE-CLASSLIST'
  /** A2 mechanism 4: the query-param-gated dev/lab routes (?meshlab=1,
   *  ?sketch3dlab=1). Amendment A7 puts them OUT of the runtime mounts' scope by
   *  name -- "The MeshLabPage / Sketch3dLabPage dev-route canvases keep their
   *  advisory static disposition (DEV-ROUTE) and are out of the runtime mounts'
   *  scope" -- so they are exempt by the contract's own words, and covered by
   *  the advisory static walk. */
  | 'DEV-ROUTE'

export interface Exemption { mechanism: ExemptionMechanism; reason: string }

/** The committed exemption list. Keyed by AUTHORING SITE, like the disposition
 *  tables it qualifies. Published to and asserted against
 *  coordination/evidence/UI-70/OVERLAY-CENSUS-EXEMPTIONS.md. */
export const CENSUS_EXEMPTIONS: Record<string, Exemption> = Object.fromEntries(
  // Every DEV-ROUTE surface, and ONLY those: the 13 entries A7 puts out of the
  // runtime mounts' scope by name. Built from the disposition table itself
  // rather than re-typed, so an entry cannot be quietly exempted by editing a
  // list here -- the ONLY way into this list is to carry the DEV-ROUTE verdict
  // in the table above, where its reason is written down and reviewable.
  Object.entries(SURFACE_DISPOSITIONS)
    .filter(([, d]) => d.verdict === 'DEV-ROUTE')
    .map(([key, d]) => [key, {
      mechanism: 'DEV-ROUTE' as const,
      reason: `Amendment A7 puts the dev-route canvases out of the runtime mounts' scope by name; covered by the advisory static walk. Disposition reason: ${d.reason}`,
    }]),
)

/** A2: "The exemption list itself is a committed, asserted artifact."
 *
 *  Rendered from CENSUS_EXEMPTIONS and gated byte-for-byte by the census, for
 *  the same reason as the A3 key map: a generated artifact is reproducible
 *  evidence, a hand-written one is a claim. The mechanisms are printed in A2's
 *  own order so the list can be read against the amendment directly. */
export function renderExemptionArtifact(): string {
  const ORDER: ExemptionMechanism[] = ['IMPERATIVE-CNCVIEWPORT', 'VIEWCUBE', 'IMPERATIVE-CLASSLIST', 'DEV-ROUTE']
  const lines: string[] = [
    '# UI-70 -- the census exemption list (amendment A2, direction two)',
    '',
    'GENERATED FILE. Do not edit by hand: it is rendered from `CENSUS_EXEMPTIONS`',
    'in `src/tests/ui/support/overlayDispositions.ts` and the census gates it',
    'byte-for-byte. Regenerate with:',
    '',
    '```',
    'UI70_WRITE_KEYS=1 npx vitest run src/tests/ui/overlayRuntimeCensus.test.tsx',
    '```',
    '',
    'WHAT AN EXEMPTION IS. A2 requires every disposition entry to be either',
    'OBSERVED in a committed mount recipe or to carry one of four named non-jsdom',
    'mechanisms. An exemption is the second: a CLAIM THAT jsdom CANNOT HOST THE',
    'SURFACE. It is not a to-do marker and not "we ran out of time".',
    '',
    'HOW IT IS KEPT HONEST. The census asserts the claim in both directions: an',
    'exempt entry that ANY recipe manages to render is a stale exemption and FAILS',
    'the census until it is dispositioned like every other surface; and no',
    'mechanism outside A2\'s four may be named. There is deliberately no',
    "'modal-governed' or 'sketch-session' mechanism -- those surfaces mount fine",
    'in jsdom, so they must be OBSERVED. That is why this WO ships ~40 mount',
    'recipes rather than a longer list here.',
    '',
    `TOTAL EXEMPT: ${Object.keys(CENSUS_EXEMPTIONS).length} of ${Object.keys(SURFACE_DISPOSITIONS).length + Object.keys(OUT_OF_VIEWPORT_DISPOSITIONS).length} disposition entries.`,
  ]
  for (const mechanism of ORDER) {
    const claimed = Object.entries(CENSUS_EXEMPTIONS).filter(([, e]) => e.mechanism === mechanism).sort()
    lines.push('', `## ${mechanism} (${claimed.length})`, '')
    if (claimed.length === 0) {
      lines.push('_Claims nothing. A2 names this mechanism; this WO did not need it._')
      if (mechanism === 'VIEWCUBE') {
        lines.push('')
        lines.push('A2 offers ViewCube "renderer-stub mount or browser harness". This WO took')
        lines.push('the MOUNT: only the five THREE.WebGLRenderer methods ViewCube calls are')
        lines.push("stubbed and its DOM is real, so its surfaces are OBSERVED. The census")
        lines.push('asserts this list stays empty -- exempting ViewCube would drop two real')
        lines.push('surfaces (view-cube-wrap, view-cube-label) out of the verdict-bearing census.')
      }
      continue
    }
    for (const [key, e] of claimed) lines.push(`- \`${key}\``, `  - ${e.reason}`)
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// THE SURFACES A MOUNT PROVES ARE NOT SURFACES
// ---------------------------------------------------------------------------
//
// The static tier is deliberately fail-closed: when it cannot statically resolve
// a `className` or a `style` it calls the element INDETERMINATE and demands a
// disposition rather than assuming it is harmless. Both entries below are in the
// domain for exactly that reason -- their className is a PROP, so the source
// cannot say whether they float.
//
// A mount RESOLVES that guess. The element is right there, and its computed
// position says. That is a STRONGER answer than the static tier's, and it is a
// third outcome the completeness gate must model honestly, distinct from both
// "observed floating" and "never mounted, so nobody knows".
//
// The escape-hatch risk is obvious and is closed two ways: (1) an entry may only
// take this route if it is NAMED here with a reason -- silence is not eligible;
// (2) the census asserts the claim in BOTH directions -- the entry must actually
// have RENDERED in a recipe (an unmounted entry is still "nobody knows" and
// still fails), and it must NOT have floated (if it ever floats, this table is
// lying and the census fails).
export const EXPECTED_IN_FLOW: Record<string, string> = {
  'components/ui/NumericInput.tsx:NumericInput > input': 'A shared numeric text input. It is in the static domain only because its className arrives as a prop, so the AST walk could not resolve it and fail-closed on it. Mounted for real (via the workbench display-mode flyout, which renders it), the input is an ordinary in-flow control: it takes space in its form row and paints over nothing.',
  'lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > input': 'The rename input inside the sketch confirm overlay. In the static domain for the same reason -- className is a prop. Mounted for real, it is an ordinary in-flow control inside the (genuinely floating, separately dispositioned) .sketch-confirm-overlay panel.',
  'lib/sketch/sketcher/overlays/SketchConfirmOverlay.tsx:SketchConfirmOverlay > button.sketch-prompt-btn': 'WO-1570\'s chamfer mode-select buttons and Swap control (SketchConfirmOverlay.tsx:178, 191). Indeterminate to the static scanner because the mode button\'s style is a selected-state conditional. Mounted for real (a two-distance chamfer chain renders all 4: 3 mode buttons + Swap), each is an ordinary in-flow control inside the (genuinely floating, separately dispositioned) .sketch-confirm-overlay panel -- same treatment as this overlay\'s own input above.',
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#2': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#3': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#4': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#5': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#6': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > div#7': TOOLPATH_FEED_LAYOUT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#2': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#3': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#4': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#5': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#6': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#7': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#8': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#9': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#10': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#11': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#12': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#13': TOOLPATH_FEED_TEXT_REASON,
  'components/toolpath/ToolpathFeedEstimatePanel.tsx:ToolpathFeedEstimateSummary > span#14': TOOLPATH_FEED_TEXT_REASON,
}
