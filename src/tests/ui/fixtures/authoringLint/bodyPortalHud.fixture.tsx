// WO UI-70-R4 -- LINT-MUST-REFUSE fixture: the BODY-PORTAL route.
//
// Both shapes of the R2 audit's portal bypass:
//   1. React's createPortal into document.body (the shape R3 committed the
//      RUNTIME RED/GREEN proof for -- the census DOES see this one).
//   2. An imperative append straight into document.body from an unsanctioned
//      site.
//
// This fixture is the one that proves the lint is not merely a census
// understudy. Route 1 is CENSUSED and still REFUSED, because the ruling bounds
// the authoring space by law rather than by what the current walk reaches. The
// five legitimate body-append sites in src/ are sanctioned BY NAME in
// SANCTIONED_AUTHORING; nothing here is among them, and the keys prove it --
// they name this fixture's own functions.
//
// It is never imported by the app. It is linted by path in
// src/tests/ui/overlayAuthoringLint.test.ts.
import { createPortal } from 'react-dom'

export function BodyPortalHud() {
  return createPortal(
    <div className="auditor-portal-hud" style={{ position: 'absolute', top: 0, left: 0 }}>
      a HUD outside every viewport container
    </div>,
    document.body,
  )
}

export function ImperativeBodyHud(): void {
  const hud = document.createElement('div')
  hud.className = 'auditor-imperative-body-hud'
  hud.style.position = 'fixed'
  document.body.appendChild(hud)
}
