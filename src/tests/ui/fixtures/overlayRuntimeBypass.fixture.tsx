// WO UI-70-R2 -- THE THREE BYPASSES THAT DEFEATED THE PREVIOUS TWO CENSUSES,
// committed as regression fixtures against the RUNTIME census.
//
// Every one of these renders a real, positioned, user-visible surface over the
// viewport. Each also defeats at least one STATIC census that shipped in this WO
// and was audited GREEN. That is the whole argument for the runtime tier: the
// bypasses are not exotic, they are ordinary React, and a scan that models
// source cannot see them.
//
//   BYPASS 1 (R1 auditor, the BLOCKER of this round) -- a locally declared
//   styled wrapper. Verbatim from the audit: "handleElement resolves a
//   capitalized identifier, enters its declaration, and returns before
//   inspecting the render site's className/style/spread attributes. A
//   styled.div-style variable declaration contains no intrinsic JSX for
//   walkBody to classify, so it creates neither a Surface nor an unresolved
//   in-viewport hole." Independently confirmed by the auditor: the static census
//   stayed 31/31 GREEN with EXIT CODE: 0 while this HUD rendered.
//
//   BYPASS 2 (preflight section B) -- createPortal into document.body. The R2
//   contract's own literal wording ("enumerate ACTUAL floating children over the
//   viewport container(s)") scopes a walk to the container subtree; a body-level
//   portal lives OUTSIDE that subtree while painting straight over the canvas.
//   Production has zero createPortal today, so this is a clean FUTURE bypass,
//   closed in advance by amendment A4: membership is decided by POSITIONING over
//   the whole document, never by DOM ancestry (and never by rect overlap --
//   jsdom computes no layout, so every rect is zero and a geometric test would
//   silently fail open).
//
//   BYPASS 3 (R0 auditor) -- a brand-new HUD reusing the already-dispositioned
//   .sketch-prompt-bar class. Kept live against the runtime tier because the R0
//   attack has to stay dead: the class IS dispositioned, at SketchPromptBar's
//   site, and that must buy an impostor at a different site nothing.
//
// styled-components is NOT a dependency of this repo and must not become one
// (package.json is outside this WO's ownership; amendment A6). The factory below
// is hand-rolled to mirror what styled-components actually DOES -- generate a
// class, inject a rule for it into the document, and return a component that
// renders a host element carrying that class -- which is what makes it a
// faithful stand-in for the auditor's AuditorStyledHud rather than a prop.
//
// DO NOT "fix" this file by dispositioning its surfaces. Its whole job is to be
// undispositioned. It is unreachable from App.tsx and the census asserts that.

import { useEffect, useRef, useState, type DetailedHTMLProps, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The R3 shadow-DOM fixtures render real custom elements, which TypeScript will
 *  not accept as intrinsic JSX without being told they exist. */
type CustomEl = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ui70-open-shadow-hud': CustomEl
      'ui70-closed-shadow-hud': CustomEl
      'ui70-nested-shadow-hud': CustomEl
      'ui70-nested-shadow-inner': CustomEl
      'ui70-uninspectable-hud': CustomEl
    }
  }
}

// ---------------------------------------------------------------------------
// A hand-rolled styled-components stand-in (amendment A6: no new dependency)
// ---------------------------------------------------------------------------

let styledSeq = 0

/** `styledLike('div')({ position: 'absolute', top: '8px' })` -> a component that
 *  renders `<div class="sc-1">` with that rule injected into the document.
 *
 *  The point: the returned component is a VARIABLE holding a closure. Its
 *  declaration contains no JSX for a source walk to classify, and its render
 *  site (`<AuditorStyledHud>`) carries no className and no style attribute to
 *  inspect. Nothing about the SOURCE says "positioned surface". Only the DOM
 *  does -- which is why this census reads the DOM. */
function styledLike(tag: 'div' | 'span', rules: Record<string, string>) {
  const className = `sc-ui70-${++styledSeq}`
  const body = Object.entries(rules).map(([k, v]) => `${k}: ${v};`).join(' ')
  return function StyledComponent({ children }: { children?: ReactNode }) {
    const injected = useRef(false)
    if (!injected.current) {
      injected.current = true
      const style = document.createElement('style')
      style.textContent = `.${className} { ${body} }`
      document.head.appendChild(style)
    }
    const Tag = tag
    return <Tag className={className}>{children}</Tag>
  }
}

/** The R1 auditor's own mutation, verbatim in spirit: "added const
 *  AuditorStyledHud = styled.div with position:absolute and rendered
 *  <AuditorStyledHud> as a fifth child of the fixture viewport host". */
const AuditorStyledHud = styledLike('div', {
  position: 'absolute',
  top: '12px',
  left: '12px',
  background: '#101418',
  padding: '6px',
})

/** The same route by its OTHER common shape: the wrapper positions its element
 *  with an inline style rather than a generated class. Also invisible to a scan
 *  that reads the render site, for the same reason. */
function AliasedInlineHud() {
  return <div style={{ position: 'fixed', bottom: '12px', left: '12px' }}>aliased HUD</div>
}
const AliasedHud = AliasedInlineHud

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

/** A viewport host of the same shape Viewport.tsx has (a container with a
 *  `.viewport-canvas` child), carrying NOTHING but the canvas. The GREEN
 *  control: mounted alone, the census finds no undispositioned surface. */
export function CleanViewport() {
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
    </div>
  )
}

/** BYPASS 1: the styled/aliased wrapper -- the R1 audit's BLOCKER. */
export function StyledWrapperBypassViewport() {
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      <AuditorStyledHud>styled HUD</AuditorStyledHud>
      <AliasedHud />
    </div>
  )
}

/** BYPASS 2: createPortal into document.body (amendment A4).
 *
 *  `position: absolute` -- deliberately NOT fixed. A census that shortcuts to
 *  "fixed surfaces are in-domain from anywhere" would catch a fixed portal by
 *  luck and still miss this one, because an absolute portal into body is
 *  positioned against the initial containing block, i.e. the viewport, i.e.
 *  straight over the canvas. */
export function PortalBypassViewport() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    setHost(el)
    return () => { el.remove() }
  }, [])
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      {host !== null && createPortal(
        <div style={{ position: 'absolute', top: '40px', left: '40px' }}>portal HUD</div>,
        host,
      )}
    </div>
  )
}

/** BYPASS 3: the R0 auditor's move -- a new site reusing a class that IS
 *  dispositioned, at SketchPromptBar's site. */
export function ReusedClassBypassViewport() {
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      <div className="sketch-prompt-bar">phantom HUD</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BYPASS 4 (R2 auditor, the BLOCKER of THIS round) -- Shadow DOM
// ---------------------------------------------------------------------------
//
// Verbatim from the R2 audit: "A web component can therefore render a real
// absolute/fixed/sticky HUD while its light-DOM host remains static, and the
// census reports no surface." The auditor's own probe is reproduced exactly --
// an open-shadow custom element containing div.auditor-shadow-hud with inline
// position:fixed -- and then extended with the two shapes the fix must also
// cover but the probe did not exercise:
//
//   * a CLOSED root (`mode: 'closed'`), which reads back as null through
//     `el.shadowRoot` and is therefore invisible to any walk that trusts that
//     property. Caught only because attachShadow is instrumented.
//   * a NESTED root -- a shadow root inside a shadow root. A one-level-deep
//     "fix" that descends once and stops would pass the auditor's probe and
//     still miss this, which is exactly the shape of near-miss this WO has
//     already shipped twice. The walk is recursive; this is what says so.
//
// The host elements are deliberately left STATIC in the light DOM, because that
// is the auditor's point: nothing about the host says "surface".

/** Registers a custom element ONCE per tag (customElements.define throws on a
 *  re-register, and vitest keeps one jsdom window across a file's tests). */
function defineOnce(tag: string, ctor: CustomElementConstructor): void {
  if (customElements.get(tag) === undefined) customElements.define(tag, ctor)
}

function defineShadowHudElements(): void {
  // The auditor's probe, verbatim: open root, inline position:fixed HUD.
  defineOnce('ui70-open-shadow-hud', class extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot !== null) return
      const root = this.attachShadow({ mode: 'open' })
      const hud = document.createElement('div')
      hud.className = 'auditor-shadow-hud'
      hud.style.position = 'fixed'
      hud.style.top = '10px'
      hud.style.right = '10px'
      hud.textContent = 'open shadow HUD'
      root.appendChild(hud)
    }
  })

  // The same attack with the root CLOSED -- `this.shadowRoot` stays null
  // forever, so only the attachShadow instrumentation can reach this HUD.
  defineOnce('ui70-closed-shadow-hud', class extends HTMLElement {
    private closedRoot: ShadowRoot | null = null
    connectedCallback(): void {
      if (this.closedRoot !== null) return
      this.closedRoot = this.attachShadow({ mode: 'closed' })
      const hud = document.createElement('div')
      hud.className = 'auditor-closed-shadow-hud'
      hud.style.position = 'absolute'
      hud.style.bottom = '10px'
      hud.style.right = '10px'
      hud.textContent = 'closed shadow HUD'
      this.closedRoot.appendChild(hud)
    }
  })

  // A shadow root INSIDE a shadow root: the host of the inner HUD is itself
  // only reachable through an outer root. Refutes a descend-once fix.
  defineOnce('ui70-nested-shadow-inner', class extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot !== null) return
      const root = this.attachShadow({ mode: 'open' })
      const hud = document.createElement('div')
      hud.className = 'auditor-nested-shadow-hud'
      hud.style.position = 'sticky'
      hud.style.top = '0px'
      hud.textContent = 'nested shadow HUD'
      root.appendChild(hud)
    }
  })
  defineOnce('ui70-nested-shadow-hud', class extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot !== null) return
      const root = this.attachShadow({ mode: 'open' })
      root.appendChild(document.createElement('ui70-nested-shadow-inner'))
    }
  })
}

/** BYPASS 4: the R2 audit's shadow-DOM route, in all three shapes. */
export function ShadowHudBypassViewport() {
  const [defined, setDefined] = useState(false)
  useEffect(() => { defineShadowHudElements(); setDefined(true) }, [])
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      {defined && (
        <>
          <ui70-open-shadow-hud />
          <ui70-closed-shadow-hud />
          <ui70-nested-shadow-hud />
        </>
      )}
    </div>
  )
}

/** The UNINSPECTABLE case: a custom element that attaches its closed root
 *  BEHIND the census's instrumentation (it grabs the pristine attachShadow off a
 *  fresh iframe's Element.prototype, so the inspector never sees the call).
 *
 *  This is the honest limit of instrumentation, and the census's answer to it is
 *  the point: it cannot prove this element is shadow-free, so it REFUSES it by
 *  name instead of walking past. A skip here would be a silent bypass. */
export function UninspectableShadowBypassViewport() {
  const [defined, setDefined] = useState(false)
  useEffect(() => {
    defineOnce('ui70-uninspectable-hud', class extends HTMLElement {
      connectedCallback(): void {
        const frame = document.createElement('iframe')
        document.body.appendChild(frame)
        const pristine = (frame.contentWindow as unknown as { Element: typeof Element } | null)?.Element.prototype.attachShadow
        frame.remove()
        if (pristine === undefined) return
        const root = pristine.call(this, { mode: 'closed' })
        const hud = document.createElement('div')
        hud.className = 'auditor-uninspectable-hud'
        hud.style.position = 'fixed'
        hud.textContent = 'uninspectable HUD'
        root.appendChild(hud)
      }
    })
    setDefined(true)
  }, [])
  return (
    <div className="viewport-root">
      <div className="viewport-canvas" />
      {defined && <ui70-uninspectable-hud />}
    </div>
  )
}
