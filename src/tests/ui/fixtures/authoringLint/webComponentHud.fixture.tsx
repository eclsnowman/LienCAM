// WO UI-70-R4 -- LINT-MUST-REFUSE fixture: the WEB-COMPONENT route.
//
// The R2 audit's shadow bypass arrived wearing this: a custom element whose
// light-DOM host stays static while its root paints a real HUD. The census can
// only ever name a custom element as UNINSPECTABLE (it builds its DOM
// imperatively and carries no React fiber), so the ruling refuses the route.
//
// Both halves are refused independently -- the define() AND the class that
// extends an element base -- so the route cannot be assembled one half at a time
// and then completed in a later commit that "only adds one line".
//
// It is never imported by the app. It is linted by path in
// src/tests/ui/overlayAuthoringLint.test.ts.
export class AuditorHudElement extends HTMLElement {
  connectedCallback(): void {
    const hud = document.createElement('div')
    hud.className = 'auditor-web-component-hud'
    hud.style.position = 'fixed'
    this.appendChild(hud)
  }
}

customElements.define('auditor-hud', AuditorHudElement)
