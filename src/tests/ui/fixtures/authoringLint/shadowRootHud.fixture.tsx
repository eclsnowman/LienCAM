// WO UI-70-R4 -- LINT-MUST-REFUSE fixture: the R2 audit's SHADOW-ROOT bypass.
//
// This is the R2 auditor's BLOCKER probe, verbatim in shape (open root, a
// div.auditor-shadow-hud with inline position:fixed). Under R3 it was a
// census-MUST-CATCH case and the census was extended to catch it. Under the
// DECISIONS 2026-07-17 ruling (item 3) it CONVERTS: the lint refuses the route
// at authoring, so this file exists to be REFUSED, not to be walked.
//
// It is never imported by the app. It is linted by path in
// src/tests/ui/overlayAuthoringLint.test.ts.
export function ShadowRootHud(host: HTMLElement): void {
  const root = host.attachShadow({ mode: 'open' })
  const hud = document.createElement('div')
  hud.className = 'auditor-shadow-hud'
  hud.style.position = 'fixed'
  hud.style.top = '0'
  hud.style.left = '0'
  hud.textContent = 'a real HUD the light DOM never shows'
  root.appendChild(hud)
}

/** The R3 shadow fixture's second shape: a CLOSED root, unreachable through
 *  el.shadowRoot by design. The census needed attachShadow instrumentation to
 *  see it; the lint needs nothing -- it is the same call. */
export function ClosedShadowRootHud(host: HTMLElement): void {
  const root = host.attachShadow({ mode: 'closed' })
  const hud = document.createElement('div')
  hud.className = 'auditor-shadow-hud-closed'
  hud.style.position = 'fixed'
  root.appendChild(hud)
}
