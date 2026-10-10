// WO UI-70-R5 -- THE FIXTURE THAT KILLED R4, PLUS EVERY INDIRECTION AROUND IT.
//
// ###########################################################################
// # THIS FILE IS NOT PRODUCT CODE AND MUST NEVER BE IMPORTED BY ANY.        #
// # It exists to be REFUSED. Every construct below is a LINT-MUST-REFUSE    #
// # case, and src/tests/ui/overlayAuthoringLint.test.ts asserts the refusal #
// # of each one BY ITS REFUSAL CODE -- not merely "some violation", which   #
// # would stay green if the clause that matters were deleted and an         #
// # unrelated one happened to fire on the same file.                        #
// ###########################################################################
//
// PROVENANCE. Case 1 is the R4 audit's BLOCKER probe, rebuilt move for move
// from coordination/reports/UI-70-R4.audit.json:
//
//   "A combined probe used const tag='iframe', document.createElement(tag), a
//    computed child-document key, and host.appendChild(frame). The shipped lint
//    returned 0 findings; the child window computed the HUD as position:fixed;
//    enumerateFloating(parent document) returned 0 surfaces and did not find the
//    HUD. This is exactly neither sanctioned-and-censused nor refused."
//
// The audit's own remedy, verbatim: "Commit this combined dynamic-iframe probe
// plus alias cases as LINT-MUST-REFUSE coverage." That is this file.
//
// WHY EACH CASE IS SHAPED THE WAY IT IS. R4's lint recognised the BAD: an exact
// list of spellings. Every case below is the same route wearing a spelling that
// list did not have. They are here so that the next person who tries to widen
// the list instead of fixing the design finds a test that says no.
import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// CASE 1 -- THE R4 BLOCKER, VERBATIM: a dynamically-named iframe.
// ---------------------------------------------------------------------------
// R4 refused `document.createElement('iframe')` and passed this. The tag is the
// same fact; only the spelling moved. Refuses as IFRAME/RESOLVED-ROUTE, because
// the tag RESOLVES through the same-file alias -- and the child-document reads
// below refuse independently, so deleting either clause still fails a test.
export function AliasedIframeHud() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const tag = 'iframe'
    const frame = document.createElement(tag)
    host.appendChild(frame)
    const childDoc = frame['contentDocument' as 'contentDocument']
    const hud = childDoc!.createElement('div')
    hud.className = 'auditor-iframe-hud'
    hud.style.position = 'fixed'
    childDoc!.body.appendChild(hud)
    return () => frame.remove()
  }, [])
  return <div ref={hostRef} />
}

// ---------------------------------------------------------------------------
// CASE 2 -- a CONCATENATED tag. No literal 'iframe' appears anywhere.
// ---------------------------------------------------------------------------
// The obvious next spelling after case 1, and the reason the resolver folds `+`
// rather than matching text: `'if' + 'rame'` is the fact "iframe".
export function ConcatenatedTagHud(): HTMLElement {
  const tag = 'if' + 'rame'
  return document.createElement(tag)
}

// ---------------------------------------------------------------------------
// CASE 3 -- a TEMPLATE-LITERAL tag, folded through a second alias.
// ---------------------------------------------------------------------------
export function TemplateTagHud(): HTMLElement {
  const half = 'rame'
  const tag = `if${half}`
  return document.createElement(tag)
}

// ---------------------------------------------------------------------------
// CASE 4 -- a tag that does NOT resolve at all.
// ---------------------------------------------------------------------------
// THE CASE THAT PROVES THE DESIGN, and the one R4 could not have caught by any
// amount of list-widening: the lint cannot know what this builds, and REFUSES
// FOR THAT REASON ALONE (UNRESOLVED-TAG). A blacklist has nothing to say here.
export function ComputedTagHud(pick: () => string): HTMLElement {
  return document.createElement(pick())
}

// ---------------------------------------------------------------------------
// CASE 5 -- createElement ALIASED AWAY from its call site.
// ---------------------------------------------------------------------------
// The tag is never visible at the reference, so the reference itself refuses
// (UNRESOLVED-TAG). You cannot smuggle the factory out and use it elsewhere.
export function AliasedFactoryHud(): HTMLElement {
  const create = document.createElement.bind(document)
  return create('iframe')
}

// ---------------------------------------------------------------------------
// CASE 6 -- a COMPUTED child-document member (amendment AM5b).
// ---------------------------------------------------------------------------
// R4 checked for a dotted `.contentDocument` and passed this.
export function ComputedChildDocHud(frame: HTMLIFrameElement): Document | null {
  const key = 'contentDoc' + 'ument'
  return (frame as unknown as Record<string, Document | null>)[key]
}

// ---------------------------------------------------------------------------
// CASE 7 -- attachShadow reached through an ALIAS, never called by name.
// ---------------------------------------------------------------------------
// Refused at the REFERENCE, not the call: to alias a method you must name it
// once, and naming it is the violation.
export function AliasedShadowHud(host: HTMLElement): ShadowRoot {
  const attach = host.attachShadow
  return attach.call(host, { mode: 'open' })
}

// ---------------------------------------------------------------------------
// CASE 8 -- attachShadow through a COMPUTED CALLEE.
// ---------------------------------------------------------------------------
// The method name never appears in the source at all. Refuses as
// UNRESOLVED-CALLEE: which method this invokes is unknowable, so it cannot be
// allowed to be any of them.
export function ComputedCalleeShadowHud(host: HTMLElement, k: string): ShadowRoot {
  return (host as unknown as Record<string, (o: ShadowRootInit) => ShadowRoot>)[k]({ mode: 'open' })
}

// ---------------------------------------------------------------------------
// CASE 9 -- AMENDMENT AM2: an iframe parsed in through `innerHTML =`.
// ---------------------------------------------------------------------------
// R4 walked CallExpressions only, so a PROPERTY ASSIGNMENT was neither refused
// nor census-visible. The markup resolves, so it is scanned and refused as
// IFRAME by the fact it contains one.
export function MarkupIframeHud(): void {
  document.body.innerHTML = '<iframe class="auditor-markup-hud"></iframe>'
}

// ---------------------------------------------------------------------------
// CASE 10 -- AM2 again: markup that does NOT resolve.
// ---------------------------------------------------------------------------
// Refuses as UNRESOLVED-MARKUP. What it parses into is unknowable, and that is
// the entire finding.
export function ComputedMarkupHud(host: HTMLElement, build: () => string): void {
  host.innerHTML = build()
}

// ---------------------------------------------------------------------------
// CASE 11 -- a document root reached through an ALIAS.
// ---------------------------------------------------------------------------
// R4 matched `document.body.appendChild` by its text. The receiver is the same
// fact through a same-file alias, and the receiver RESOLVES.
export function AliasedBodyPortalHud(hud: HTMLElement): void {
  const root = document.body
  root.appendChild(hud)
}

// ---------------------------------------------------------------------------
// CASE 12 -- a JSX tag identifier holding a STRING.
// ---------------------------------------------------------------------------
// React renders the VALUE, not the spelling: this mounts a real <iframe>.
export function StringTagJsxHud() {
  const Tag = 'iframe'
  return <Tag className="auditor-jsx-tag-hud" />
}

// ---------------------------------------------------------------------------
// CASE 13 -- a JSX tag identifier that resolves to NEITHER string nor component.
// ---------------------------------------------------------------------------
// Refuses as UNRESOLVED-TAG. This is `document.createElement(compute())` wearing
// angle brackets, and it refuses for the same reason.
export function ComputedTagJsxHud({ pick }: { pick: Record<string, string> }) {
  const Tag = pick.which as unknown as 'div'
  return <Tag className="auditor-jsx-computed-hud" />
}

// ---------------------------------------------------------------------------
// CASE 14 -- a custom element, both halves.
// ---------------------------------------------------------------------------
export class AuditorHudElement extends HTMLElement {
  connectedCallback(): void {
    this.innerHTML = '<div class="auditor-wc-hud"></div>'
  }
}
export function defineAuditorHud(): void {
  customElements.define('auditor-hud', AuditorHudElement)
}

// ---------------------------------------------------------------------------
// CASE 15 -- a hyphenated tag, created dynamically.
// ---------------------------------------------------------------------------
// A custom element without a define() in sight. The tag resolves, and a hyphen
// is the HTML spec's own definition of a custom element.
export function DynamicCustomElementHud(): HTMLElement {
  const tag = 'auditor' + '-hud'
  return document.createElement(tag)
}
