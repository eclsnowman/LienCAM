// WO UI-70-R4 -- LINT-MUST-REFUSE fixture: the R3 audit's IFRAME bypass.
//
// THE ROUTE THAT ENDED THE ARMS RACE. The R3 auditor's probe, verbatim in shape:
// a same-origin iframe whose contentDocument holds a div.auditor-iframe-hud with
// inline position:fixed. The child window computed its position as `fixed`;
// enumerateFloating(parent document) returned ZERO surfaces (PROBE RESULT:
// MISSED, EXIT CODE: 1).
//
// R3's contract carried a binding tripwire for exactly this, and it fired: no
// fifth patch round, re-scope at DECISIONS. So this fixture is NOT a
// census-must-catch case and the census was NOT taught to walk child documents.
// It is refused at authoring. Every clause it trips is named in the gate.
//
// It is never imported by the app. It is linted by path in
// src/tests/ui/overlayAuthoringLint.test.ts.
export function IframeHud(): void {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const childDoc = frame.contentDocument!
  const hud = childDoc.createElement('div')
  hud.className = 'auditor-iframe-hud'
  hud.style.position = 'fixed'
  hud.style.top = '0'
  hud.style.right = '0'
  hud.textContent = 'a fixed HUD in a second Document'
  childDoc.body.appendChild(hud)
}

/** The JSX shape of the same route -- refused by the same clause family, so the
 *  route cannot be reopened by declaring it instead of creating it. */
export function IframeHudJsx() {
  return <iframe title="auditor" srcDoc="<div style='position:fixed'>HUD</div>" />
}

/** Reaching a child browsing context through contentWindow rather than
 *  contentDocument. Same Document problem, different property. */
export function IframeHudViaContentWindow(frame: HTMLIFrameElement): void {
  const childDoc = frame.contentWindow!.document
  const hud = childDoc.createElement('div')
  hud.style.position = 'fixed'
  childDoc.body.appendChild(hud)
}
