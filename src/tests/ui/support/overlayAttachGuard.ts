// WO UI-78 -- the OVERLAY ATTACH GUARD: fail-closed enforcement at the DOM
// ATTACH choke point.
//
// ===========================================================================
// WHY THIS EXISTS (DECISIONS 2026-07-17, "enforcement moves to the ATTACH
// choke point"): source-level enforcement lost TWICE by inversion. R4's
// blacklist was beaten by a dynamically-named iframe; R5's allowlist was
// beaten by document.write -- iframe creation in a form no source-syntax
// walker sees. The lesson is structural: a STATIC lint over an unbounded
// dynamic authoring language loses to a determined enumerator no matter which
// polarity it uses. The census law already named the correct layer -- domain
// membership decided at runtime is guarded at runtime -- and this guard applies
// it to ENFORCEMENT: the fail-closed guarantee moves to the point a node
// actually attaches to the live DOM.
//
// THE INVERSION, APPLIED (the fifth and final application). This guard does NOT
// enumerate forbidden authoring routes. There is no list of "bad" spellings
// anywhere below -- no `document.write`, no `innerHTML`, no `createElement`,
// no `attachShadow` string match drives a verdict. Instead it observes every
// node that ATTACHES to the live tree, classifies whether that node is a
// floating surface over the viewport BY POSITIONING ALONE (the census's own
// rule, shared via overlayFloating.ts), and REFUSES it unless it is
// SANCTIONED. document.write, srcdoc, DOMParser adoption, innerHTML/outerHTML,
// Object.assign/Reflect.set onto document.body, a dynamically named iframe, a
// styled wrapper, a body portal, shadow DOM, createContextualFragment +
// insertBefore -- all reach the tree through ATTACHMENT, and the choke point
// catches them by construction. The guard does not care HOW a node was
// authored, only that it attached and is not on the sanctioned list.
//
// ---------------------------------------------------------------------------
// THE FOUR ROUTES AROUND A NAIVE OBSERVER, closed by construction (preflight
// AM1-AM4). A childList-only observer bound to document.body would be beaten
// exactly the way the lint was:
//   AM1 -- document.open()/write() removes documentElement/body but NOT the
//          Document node. The root observer targets `document`, which survives;
//          write/open are patched to re-scan and re-establish child observers.
//   AM2 -- an iframe's contentDocument is a SEPARATE Document the root observer
//          never sees. Every same-origin iframe gets its own child observer
//          (retried on 'load'); a cross-origin iframe is UNINSPECTABLE and is
//          REFUSED BY NAME (mirroring the census's isUninspectableCustomElement).
//   AM3 -- an in-flow, viewport-sized iframe is not ITSELF a floating surface,
//          but its content document can hold one. Every iframe gets a child
//          observer regardless of the iframe's own computed position.
//   AM4 (RE-BOUND, DECISIONS 2026-07-17 "AM4 re-bound -- reclassification
//          triggers on ANY mutation (tenth bypass)") -- ANY change to an
//          already-attached tree can reclassify an existing element as floating
//          without that element attaching: a class/inline-style flip, a new
//          <style>, a NON style/class attribute flip against a pre-existing rule
//          keyed on it ([data-*], id, aria-*), a sibling insertion that flips a
//          structural selector (:nth-child, +, ~) on a node that never changed,
//          a <style> text edit, an adoptedStyleSheets/insertRule call, or a
//          media/viewport change with no DOM record at all. The original bound
//          text enumerated its triggers (attributeFilter ['style','class'] + new
//          <style>/<link> + CSSStyleSheet API) and the auditor walked out through
//          the gap (the tenth bypass: a pre-existing [data-floaty]{position:fixed}
//          rule, an in-flow attach, then a data-floaty flip -- no enumerated
//          trigger fires). The re-binding removes the enumeration entirely: the
//          observer watches `attributes: true` (NO filter), `childList: true,
//          subtree: true`, and `characterData: true`, so EVERY mutation record --
//          whatever its kind -- schedules ONE debounced reclassifyAll pass over
//          every observed root. Two immediate FAST-PATH hooks cover the flip
//          sources that leave no mutation record: the three named CSSStyleSheet
//          methods insertRule/replace/replaceSync plus the adoptedStyleSheets
//          setter (a CSSOM API call), and a matchMedia/resize listener (a
//          media/viewport change). No attribute name, element name, or record
//          type gates whether reclassification runs -- there is no trigger list
//          left to walk around ON THE MUTATION PATH. But the CSSOM fast-path hook
//          set is itself a closed method-name LIST (insertRule/replace/replaceSync
//          + the setter), and the platform offers no observe-all-CSSOM primitive:
//          CSSStyleSheet.deleteRule/removeRule and rule-level edits
//          (CSSStyleDeclaration.setProperty, rule.style.position,
//          CSSStyleRule.selectorText) emit NO record and are NOT hooked -- the
//          eleventh bypass walked exactly that gap (deleteRule unmasks a masked
//          position:fixed). The floor that CANNOT be enumerated around is the
//          BACKSTOP below.
//
// ---------------------------------------------------------------------------
// THE NON-ENUMERATED BACKSTOP (DECISIONS 2026-07-17 "UI-78 eleventh bypass: END
// THE ENUMERATION GAME"). Eleven bypasses, and every one walked an enumerated
// member list (routes, fixtures, attribute filters, trigger kinds, now CSSOM
// method names). Any hook LIST on the CSSOM leg stays walkable, so the guard
// gains a floor that inspects NOTHING: a dev-only setInterval (BACKSTOP_PERIOD_MS)
// that runs the SAME reclassifyAll the fast paths use, unconditionally, over every
// observed root. It has no filter, no trigger inspection, no notion of what
// changed -- it re-examines EVERY node BY CONSTRUCTION every period, so ANY
// computed-position flip (an un-hooked CSSOM edit, adoptedStyleSheets in a real
// browser, a media change, anything the observer/hook fast paths miss) is caught
// within one period. The observer + the CSSStyleSheet/adoptedStyleSheets hooks +
// the media/resize listener stay as the IMMEDIATE fast path (a flip they see is
// caught the same microtask); the backstop is the floor for everything they do
// not. The single NAMED residual is timing: a flip only the backstop catches is
// refused up to one BACKSTOP_PERIOD_MS late -- a dev-warning latency, accepted by
// the ruling, not a hole. The backstop installs on install and is cleared in the
// uninstall cleanup tail (charter 5); it is gated by the named
// UI78_BACKSTOP_DISABLED lever ONLY at install (the pass itself has no condition).
// Per the ruling, no further enumeration rounds: a future bypass that beats the
// backstop is a DECISIONS design problem, never another hook-list patch.
//
// ---------------------------------------------------------------------------
// DEV/TEST ONLY (AC6). The app reaches this module only through a dev-gated
// dynamic import (main.tsx -> src/devtools/overlayAttachGuardBootstrap.ts,
// behind `import.meta.env.DEV`), so a production build's dead-code elimination
// strips the whole chain. It has ZERO node dependencies so the dev browser
// build can bundle it; its verdict-bearing proofs live in
// src/tests/ui/overlayAttachGuard.test.tsx.
//
// WHY IT LIVES UNDER src/tests/ui/support: this is enforcement INSTRUMENTATION,
// the same kind of thing as the census's own attachShadow patch
// (overlayRuntimeCensus.ts:installShadowInspector) -- it legitimately wields
// the very attachShadow/document.write primitives the authoring lint refuses in
// PRODUCT paint code. Like the census instrumentation, it is therefore excluded
// from productSourceFiles (the lint's product scan) by construction, not by a
// special-case carve-out that would weaken the lint's "src/ has never used
// attachShadow" guarantee.

import { classifyFloating } from './overlayFloating'

// ---------------------------------------------------------------------------
// Marker + exemption vocabulary (the SANCTION adapter, preflight AM5/AM6)
// ---------------------------------------------------------------------------

/** REGIME 2 (AM5): the explicit ownership marker a piece of sanctioned
 *  IMPERATIVE code sets on the floating surface it owns. Analogous to the
 *  census's own `data-ui70-census` self-exclusion marker
 *  (overlayRuntimeCensus.ts:478,559). A floating node carrying this on itself
 *  or an ancestor within its root is sanctioned; delete it and the guard
 *  refuses the node -- the AM5 regime-2 can-fail. */
export const SANCTION_MARKER = 'data-ui78-sanctioned'

/** The census's scaffolding marker: its injected <style> and canary host carry
 *  it. Exempt so the guard never refuses the census's own instrumentation. */
export const CENSUS_MARKER = 'data-ui70-census'

/** The JSX-site attribute the wrapped jsxDEV stamps on every host element
 *  (overlayRuntimeCensus.ts SITE_ATTR). REGIME 1 (AM5) consults it -- but only
 *  through the injected `isSanctionedJsx` predicate, because "carries a JSX
 *  site" alone does NOT sanction (a body-portal HUD is JSX too). The predicate
 *  is the disposition cross-check; see the test's wiring. */
export const SITE_ATTR = 'data-ui70-site'

/** Vite's own dev-only error overlay: a hyphenated custom element with a shadow
 *  root that legitimately floats over the whole viewport on a dev compile
 *  error. A NAMED exemption per AM6, not an incidental pass. */
export const VITE_ERROR_OVERLAY_TAG = 'vite-error-overlay'

// ---------------------------------------------------------------------------
// The disable toggle (AC4 / AM8)
// ---------------------------------------------------------------------------

/** THE single documented toggle AC4's mutation proof turns. When true the guard
 *  still installs its observers/hooks but records NO refusal -- so a committed
 *  test that expects a refusal goes RED, and restoring it to false restores
 *  GREEN. Named and module-level rather than an ad-hoc deletion chosen at
 *  execution time (AM8). */
let UI78_GUARD_DISABLED = false
export function setGuardDisabled(value: boolean): void { UI78_GUARD_DISABLED = value }
export function isGuardDisabled(): boolean { return UI78_GUARD_DISABLED }

/** The non-enumerated BACKSTOP's period (DECISIONS 2026-07-17 "END THE
 *  ENUMERATION GAME"). Every this-many ms, while the guard is installed, one
 *  reclassifyAll pass re-examines every node under every observed root -- so ANY
 *  computed-position flip, whatever caused it (an un-hooked CSSOM edit, a media
 *  change, adoptedStyleSheets in a real browser), is caught within one period BY
 *  CONSTRUCTION. 500ms sits mid-range of the ruling's 250-1000ms target: the
 *  dev-warning latency is imperceptible to a developer, and one full-tree
 *  getComputedStyle sweep per 500ms is negligible dev/test-only cost (this module
 *  is DEV-gated out of production entirely, AC6). setInterval, NOT rAF: jsdom
 *  implements no requestAnimationFrame but drives setInterval deterministically
 *  under fake timers, so the backstop leg is a committed, timer-advanced can-fail
 *  (charter 4) rather than event-loop prose. */
export const BACKSTOP_PERIOD_MS = 500

/** The named lever the B2/B3 backstop mutation proof turns (B6), mirroring
 *  UI78_GUARD_DISABLED. When true the backstop interval is never installed, so a
 *  flip that ONLY the periodic floor catches (a deleteRule/removeRule unmask -- no
 *  hook, no mutation record) is never re-examined and its fixture goes RED, while
 *  the fast-path fixtures (R2-R4) stay GREEN (targeted, no collateral). Gated at
 *  INSTALL only -- the backstop pass itself carries no condition, per the ruling's
 *  "no filter or trigger inspection in the backstop". Module-level and named, not
 *  an ad-hoc deletion (charter 6 / AM8 discipline). */
let UI78_BACKSTOP_DISABLED = false
export function setBackstopDisabled(value: boolean): void { UI78_BACKSTOP_DISABLED = value }
export function isBackstopDisabled(): boolean { return UI78_BACKSTOP_DISABLED }

// ---------------------------------------------------------------------------
// Refusal record
// ---------------------------------------------------------------------------

export interface GuardRefusal {
  /** Human summary of why this floating surface was refused at attach. */
  reason: string
  /** The detection channel -- a DIAGNOSTIC label of which observer/hook saw the
   *  surface, NEVER a verdict input and NEVER a trigger enumeration: attach-time
   *  channels ('childList' | 'iframe-document' | 'cross-origin-iframe' |
   *  'document.write' | 'existing' | 'shadow-root') name where a node FIRST
   *  attached; the reclassification channel 'reclassify' covers every FAST-PATH
   *  post-attach flip uniformly (an attribute of any name, a new/edited
   *  stylesheet, a structural selector flip from a sibling insertion, a hooked
   *  CSSOM API call, or a media/viewport change) -- the re-bound AM4 no longer
   *  splits it into 'attributes'/'stylesheet' because the trigger kind never
   *  decides anything; and 'backstop' names a refusal caught by the
   *  non-enumerated periodic floor (a flip no hook/observer saw -- e.g. a
   *  deleteRule/removeRule unmask). NONE of these is a verdict input. */
  channel: string
  tag: string
  classes: string[]
  position: string
  positionSource: string
  /** The data-ui70-site the node carried, if any (null for imperative DOM). */
  site: string | null
  /** A short ancestor path, for locating the surface in a report. */
  domPath: string
}

let refusals: GuardRefusal[] = []
export function getGuardRefusals(): readonly GuardRefusal[] { return refusals }
export function resetGuardRefusals(): void { refusals = [] }

/** Nodes already refused, so a reclassification pass does not re-report the same
 *  surface every drain. A WeakSet: cleared implicitly when the node is GC'd. */
let refusedNodes = new WeakSet<Element>()

// ---------------------------------------------------------------------------
// Install options + state
// ---------------------------------------------------------------------------

export interface AttachGuardOptions {
  /** REGIME 1 (AM5): decides whether a JSX-authored node (one carrying
   *  data-ui70-site) is sanctioned. Receives the element so it can read the
   *  site attribute itself and cross-check it against the census's disposition
   *  set. Default: nothing is sanctioned by JSX site -- so a JSX overlay must
   *  either be dispositioned (via this predicate) or carry the ownership marker,
   *  or it is refused. The vitest gate injects a disposition-backed predicate;
   *  the real-dev bootstrap injects its own (see bootstrap.ts). */
  isSanctionedJsx?: (el: Element) => boolean
  /** Called on every refusal in addition to the recorded array (e.g. the
   *  real-dev bootstrap logs; the test inspects the array). */
  onRefusal?: (r: GuardRefusal) => void
}

interface GuardState {
  installed: boolean
  rootDoc: Document
  opts: AttachGuardOptions
  observers: Set<MutationObserver>
  observedRoots: Set<Document | ShadowRoot>
  observedIframeDocs: WeakSet<Document>
  pristineAttachShadow: typeof Element.prototype.attachShadow | null
  pristineDocWrite: typeof Document.prototype.write | null
  pristineDocOpen: typeof Document.prototype.open | null
  cssRestore: Array<() => void>
  /** The AM4-R media/viewport listeners' removers -- a media-driven position
   *  flip leaves no mutation record, so a matchMedia/resize change drives one
   *  reclassifyAll pass. Enumerated in the CLEANUP TAIL (charter 5). */
  viewportRestore: Array<() => void>
  /** The non-enumerated backstop's setInterval handle (null while disabled via
   *  UI78_BACKSTOP_DISABLED). Cleared in the CLEANUP TAIL so no timer leaks past
   *  uninstall (charter 5; the B1 leak test proves vi.getTimerCount drops to 0). */
  backstopHandle: ReturnType<typeof setInterval> | null
}

let state: GuardState | null = null

// ---------------------------------------------------------------------------
// Reclassification debounce (AM4-R). EVERY MutationObserver record schedules a
// single coalesced reclassifyAll pass -- no trigger-kind branch decides whether
// to run. queueMicrotask gives the real browser one pass per mutation batch;
// drainGuard forces the pending pass synchronously so tests need no event-loop
// reasoning (charter 4). The pass counter is observable so a committed test can
// prove N rapid mutations coalesce to exactly one pass (R4).
// ---------------------------------------------------------------------------

let reclassifyScheduled = false
let reclassifyPassCount = 0

/** How many reclassifyAll passes have run since install. Observable so the R4
 *  debounce test can assert coalescing (N mutations -> exactly one pass). */
export function getReclassifyPassCount(): number { return reclassifyPassCount }

/** Mark a reclassification pending. Idempotent within a batch: many mutation
 *  records collapse to ONE queued pass. Called unconditionally for every record,
 *  so nothing enumerates which mutations "deserve" reclassification. */
function scheduleReclassify(): void {
  if (state === null) return
  if (reclassifyScheduled) return
  reclassifyScheduled = true
  queueMicrotask(runScheduledReclassify)
}

/** Run the pending pass if one is scheduled. Guarded so a microtask queued
 *  before uninstall (or already drained synchronously) is a harmless no-op. */
function runScheduledReclassify(): void {
  if (!reclassifyScheduled) return
  reclassifyScheduled = false
  if (state === null) return
  reclassifyPassCount++
  reclassifyAll('reclassify')
}

// ---------------------------------------------------------------------------
// The NON-ENUMERATED BACKSTOP (DECISIONS 2026-07-17 "END THE ENUMERATION GAME").
// A dev-only setInterval that runs the SAME reclassifyAll the fast paths use,
// with NO condition, filter, or trigger inspection -- every pass re-examines every
// node BY CONSTRUCTION, so a flip no hook/observer saw (a deleteRule/removeRule
// unmask, adoptedStyleSheets in a real browser, a media change) is caught within
// one BACKSTOP_PERIOD_MS. A SEPARATE counter from reclassifyPassCount so the R4
// debounce measurement is unpolluted (B5).
// ---------------------------------------------------------------------------

let backstopPassCount = 0

/** How many backstop passes have run since install. Observable so the B5 quiet-
 *  page test can assert exactly one pass per period (no busy loop) and the B1 leak
 *  test can assert no pass fires after uninstall. Distinct from
 *  getReclassifyPassCount so the R4 burst measurement excludes backstop ticks. */
export function getBackstopPassCount(): number { return backstopPassCount }

/** ONE backstop pass: unconditionally re-examine every node under every observed
 *  root. There is NO inspection of what changed here -- the backstop cannot know,
 *  and by design does not care, so it re-classifies EVERYTHING (ruling item 1).
 *  reclassifyAll tags refusals with the 'backstop' channel, so a test proves a
 *  refusal came from the periodic floor rather than a fast path. */
function runBackstopPass(): void {
  if (state === null) return
  backstopPassCount++
  reclassifyAll('backstop')
}

/** Start the periodic backstop, unless the named lever disables it. Gated at
 *  INSTALL only -- runBackstopPass itself has no condition (ruling: no filter or
 *  trigger inspection in the backstop). The handle goes into GuardState so the
 *  cleanup tail clears it. */
function installBackstop(): void {
  if (state === null) return
  if (UI78_BACKSTOP_DISABLED) return
  state.backstopHandle = setInterval(runBackstopPass, BACKSTOP_PERIOD_MS)
}

// ---------------------------------------------------------------------------
// Small DOM helpers (a local composed walk; the census's is node-tainted)
// ---------------------------------------------------------------------------

function ownerViewOf(el: Element): Window | null {
  return el.ownerDocument?.defaultView ?? null
}

function shadowRootOf(el: Element): ShadowRoot | null {
  return el.shadowRoot ?? recordedShadowRoots.get(el) ?? null
}

/** Every element in the composed subtree rooted at `node` (inclusive of element
 *  nodes directly under it), descending into open OR recorded shadow roots. */
function composedElements(node: ParentNode, visited = new Set<ParentNode>()): Element[] {
  // WO-2929: roots overlap (rootDoc is also observed; shadow roots are both
  // composed descendants and independently observed). Share this set only
  // within ONE scan, never across mutations: every changed cascade is re-read.
  if (visited.has(node)) return []
  visited.add(node)
  const out: Element[] = []
  for (const el of Array.from(node.querySelectorAll('*'))) {
    out.push(el)
    const shadow = shadowRootOf(el)
    if (shadow !== null) out.push(...composedElements(shadow, visited))
  }
  return out
}

function shortPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur !== null && depth < 5) {
    const cls = cur.classList.length > 0 ? `.${Array.from(cur.classList).join('.')}` : ''
    const id = cur.id !== '' ? `#${cur.id}` : ''
    parts.unshift(`${cur.tagName.toLowerCase()}${id}${cls}`)
    cur = cur.parentElement
    depth++
  }
  return parts.join(' > ')
}

// ---------------------------------------------------------------------------
// The SANCTION check -- a POSITIVE allow-list, no forbidden spellings
// ---------------------------------------------------------------------------

function hasMarkerWithin(el: Element, attr: string): boolean {
  // closest() stays within the current tree/shadow root, which is what we want:
  // a marker in the PARENT document does not sanction a surface in a child
  // iframe document.
  return el.closest(`[${attr}]`) !== null
}

/** A named exemption (AM6): Vite's dev error overlay, and the census's own
 *  scaffolding. */
export function isNamedExemption(el: Element): boolean {
  if (el.tagName.toLowerCase() === VITE_ERROR_OVERLAY_TAG) return true
  if (el.closest(VITE_ERROR_OVERLAY_TAG) !== null) return true
  if (hasMarkerWithin(el, CENSUS_MARKER)) return true
  return false
}

/** Is this floating surface sanctioned? A POSITIVE allow-list applied at attach.
 *  Anything floating that is not exempt, not owned (regime 2), and not a
 *  sanctioned JSX surface (regime 1) is refused -- whatever authored it. */
export function isSanctionedFloating(el: Element, opts: AttachGuardOptions): boolean {
  if (isNamedExemption(el)) return true
  if (hasMarkerWithin(el, SANCTION_MARKER)) return true          // regime 2
  if (opts.isSanctionedJsx !== undefined && opts.isSanctionedJsx(el)) return true // regime 1
  return false
}

// ---------------------------------------------------------------------------
// Classify + refuse
// ---------------------------------------------------------------------------

function record(refusal: GuardRefusal): void {
  refusals.push(refusal)
  state?.opts.onRefusal?.(refusal)
}

/** Examine ONE element: if it is a floating surface and not sanctioned, refuse
 *  it. Idempotent per node (refusedNodes). The cross-origin-iframe refusal is
 *  handled separately in observeIframe. */
function examine(el: Element, channel: string): void {
  if (UI78_GUARD_DISABLED) return
  if (state === null) return
  if (refusedNodes.has(el)) return
  const view = ownerViewOf(el)
  if (view === null) return
  const c = classifyFloating(el, view)
  if (!c.floating) return
  if (isSanctionedFloating(el, state.opts)) return
  refusedNodes.add(el)
  record({
    reason:
      `UNSANCTIONED floating surface refused AT ATTACH: <${el.tagName.toLowerCase()}> resolved position:${c.position} `
      + `over the viewport, carrying neither the ${SANCTION_MARKER} ownership marker nor a sanctioned JSX disposition, `
      + 'and it is not a named exemption. Whatever authored it, it reached the live tree through attachment and the '
      + 'choke point caught it.',
    channel,
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList),
    position: c.position,
    positionSource: c.source,
    site: el.getAttribute(SITE_ATTR),
    domPath: shortPath(el),
  })
}

/** Examine an element and its whole composed subtree. */
function examineSubtree(node: Element, channel: string): void {
  examine(node, channel)
  for (const el of composedElements(node)) examine(el, channel)
  // A newly-attached subtree may itself contain iframes/shadow hosts we must
  // start observing (their own mutations do not bubble here).
  discoverChildContexts(node)
}

// ---------------------------------------------------------------------------
// Child browsing contexts: shadow roots (AM2/AC2) and iframe documents (AM2/AM3)
// ---------------------------------------------------------------------------

/** Roots recorded by the patched attachShadow, so CLOSED roots (which read back
 *  null through el.shadowRoot) are still reachable. */
const recordedShadowRoots = new WeakMap<Element, ShadowRoot>()

function observeRoot(root: Document | ShadowRoot, channel: string): void {
  if (state === null) return
  if (state.observedRoots.has(root)) return
  state.observedRoots.add(root)
  const obs = new MutationObserver((records) => processRecords(records, channel))
  // AM4-R: attributes WITHOUT a filter (a rule can key on ANY attribute -- id,
  // aria-*, data-* -- not just style/class), childList+subtree, and
  // characterData (a <style>'s text node edit changes the cascade). Every record
  // this yields schedules one reclassifyAll; NO attributeFilter, no record-type
  // gate -- the closed trigger list that the tenth bypass walked through is gone.
  obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true })
  state.observers.add(obs)
  // Scan what is already inside it at the moment we begin observing.
  for (const el of composedElements(root)) examine(el, channel)
}

/** Start observing an iframe's content document, recursing into further nested
 *  iframes/shadow roots. Cross-origin (contentDocument === null) is REFUSED BY
 *  NAME (AM2). Retries on 'load' for an iframe not yet navigated (AM2). */
function observeIframe(frame: HTMLIFrameElement): void {
  if (state === null) return
  let childDoc: Document | null = null
  try {
    childDoc = frame.contentDocument
  } catch {
    childDoc = null // SecurityError on a cross-origin frame
  }
  if (childDoc === null) {
    // AM2: an uninspectable (cross-origin) iframe could paint a HUD over the
    // viewport from a document the same-origin policy forbids us to read. We
    // cannot prove it does NOT, so we refuse it by name rather than pass it.
    if (!UI78_GUARD_DISABLED && !refusedNodes.has(frame)) {
      refusedNodes.add(frame)
      record({
        reason:
          'CROSS-ORIGIN iframe refused BY NAME: its contentDocument is null under the same-origin policy, so the guard '
          + 'cannot inspect whether it paints a floating surface over the viewport. Uninspectable is refused, not '
          + 'passed (AM2, mirroring the census isUninspectableCustomElement rule).',
        channel: 'cross-origin-iframe',
        tag: 'iframe',
        classes: Array.from(frame.classList),
        position: 'n/a',
        positionSource: 'n/a',
        site: frame.getAttribute(SITE_ATTR),
        domPath: shortPath(frame),
      })
    }
    // Retry once the frame navigates -- a frame appended before its src loads
    // reads contentDocument === about:blank now but may become inspectable.
    frame.addEventListener('load', () => observeIframe(frame), { once: true })
    return
  }
  if (state.observedIframeDocs.has(childDoc)) return
  state.observedIframeDocs.add(childDoc)
  observeRoot(childDoc, 'iframe-document')
  // Re-scan on navigation: document.write / src load replaces the child tree.
  frame.addEventListener('load', () => {
    const d = frame.contentDocument
    if (d !== null) {
      observeRoot(d, 'iframe-document')
      for (const el of composedElements(d)) examine(el, 'iframe-document')
      discoverChildContexts(d)
    }
  })
}

/** Find iframes and shadow hosts inside a freshly-seen subtree/root and begin
 *  observing their child contexts. */
function discoverChildContexts(root: ParentNode): void {
  if (state === null) return
  const scope: Element[] = []
  if ((root as Element).tagName !== undefined) scope.push(root as Element)
  scope.push(...Array.from(root.querySelectorAll('*')))
  for (const el of scope) {
    if (el.tagName === 'IFRAME') observeIframe(el as HTMLIFrameElement)
    const shadow = shadowRootOf(el)
    if (shadow !== null) {
      observeRoot(shadow, 'shadow-root')
      discoverChildContexts(shadow)
    }
  }
}

// ---------------------------------------------------------------------------
// Mutation processing
// ---------------------------------------------------------------------------

function processRecords(records: MutationRecord[], defaultChannel: string): void {
  for (const rec of records) {
    // ATTACH-time examination (a separate concern from reclassification): a
    // childList add is the choke point itself -- examine the freshly-attached
    // subtree under its attach channel and start observers on any child context
    // it carries. This is NOT a reclassification gate; reclassification below
    // fires for EVERY record regardless of type.
    if (rec.type === 'childList') {
      rec.addedNodes.forEach((n) => {
        if (n.nodeType === 1) {
          examineSubtree(n as Element, defaultChannel === 'iframe-document' ? 'iframe-document' : 'childList')
        }
      })
    }
    // AM4-R: ANY record -- attribute of any name, childList (a sibling insertion
    // can flip a structural selector on a node that never changed), or
    // characterData (a <style> text edit) -- schedules the one debounced
    // reclassification pass. No record-type or attribute-name test decides this.
    scheduleReclassify()
  }
}

/** Re-evaluate every element under every observed root. A post-attach flip can
 *  make an existing node floating without that node itself attaching -- a
 *  selector keyed on any attribute that just changed, a new/edited stylesheet, a
 *  :nth-child/sibling-combinator match changed by an insertion elsewhere, a
 *  CSSOM API call, or a media/viewport change (AM4-R). examine() is idempotent
 *  per node (refusedNodes), so a node already refused is not re-reported and a
 *  still-in-flow node is simply re-checked -- no blanket refusedNodes.delete that
 *  would duplicate every standing refusal on each of the now-frequent passes. */
function reclassifyAll(channel: string): void {
  if (state === null) return
  const roots: Array<Document | ShadowRoot> = [state.rootDoc, ...state.observedRoots]
  const visited = new Set<ParentNode>()
  for (const root of roots) {
    for (const el of composedElements(root, visited)) examine(el, channel)
  }
}

/** Drain all pending mutation records NOW and process them synchronously, so
 *  tests can assert attach-time refusal deterministically without awaiting the
 *  MutationObserver microtask. Loops until no observer yields more records
 *  (a cascade -- e.g. discovering a shadow root that then reports its own
 *  content), bounded so a pathological churn cannot spin forever. */
export function drainGuard(): void {
  if (state === null) return
  for (let i = 0; i < 50; i++) {
    let any = false
    for (const obs of Array.from(state.observers)) {
      const recs = obs.takeRecords()
      if (recs.length > 0) { any = true; processRecords(recs, 'childList') }
    }
    // Force the debounced reclassification pass NOW so a synchronous test sees
    // it without awaiting the microtask (charter 4: constructed interleave, not
    // event-loop reasoning). A pass may itself surface nothing new; the loop
    // exits once no observer yields records and none is pending.
    if (reclassifyScheduled) { any = true; runScheduledReclassify() }
    if (!any) return
  }
}

// ---------------------------------------------------------------------------
// Hooks: attachShadow (AC2), document.open/write (AM1), stylesheets (AM4)
// ---------------------------------------------------------------------------

function installAttachShadowHook(): void {
  if (state === null || typeof Element === 'undefined') return
  const original = Element.prototype.attachShadow
  state.pristineAttachShadow = original
  const guard = state
  function patched(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init)
    recordedShadowRoots.set(this, root)          // reach CLOSED roots later
    observeRoot(root, 'shadow-root')             // AC2: nested roots get observers
    return root
  }
  ;(patched as unknown as Record<string, unknown>)['__ui78AttachGuard'] = true
  Element.prototype.attachShadow = patched as typeof Element.prototype.attachShadow
  void guard
}

function installDocumentWriteHook(): void {
  if (state === null || typeof Document === 'undefined') return
  const origWrite = Document.prototype.write
  const origOpen = Document.prototype.open
  state.pristineDocWrite = origWrite
  state.pristineDocOpen = origOpen
  const afterMutatingDocument = (doc: Document, channel: string): void => {
    // AM1: write/open removed documentElement/body but NOT the Document node,
    // so the root observer (bound to `document`) still fires. Re-scan the tree
    // and re-establish child observers for any iframe/shadow now present, then
    // examine the freshly-written surfaces.
    if (state === null) return
    if (doc === state.rootDoc || state.observedRoots.has(doc)) {
      for (const el of composedElements(doc)) examine(el, channel)
      discoverChildContexts(doc)
    }
  }
  Document.prototype.write = function patchedWrite(this: Document, ...args: string[]): void {
    const r = (origWrite as (...a: string[]) => void).apply(this, args)
    afterMutatingDocument(this, 'document.write')
    return r
  } as typeof Document.prototype.write
  Document.prototype.open = function patchedOpen(this: Document, ...args: unknown[]): Document {
    const r = (origOpen as (...a: unknown[]) => Document).apply(this, args)
    afterMutatingDocument(this, 'document.write')
    return r as Document
  } as typeof Document.prototype.open
}

function installStylesheetHooks(): void {
  if (state === null) return
  // Constructable stylesheets / adoptedStyleSheets are absent in jsdom, so this
  // is feature-detected. In a real browser it closes AM4's stylesheet route;
  // in jsdom the <style>-element and attribute paths (both present) carry the
  // AM4 proof, and this is documented as an honest environment limit.
  if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype !== undefined) {
    for (const name of ['insertRule', 'replace', 'replaceSync'] as const) {
      const proto = CSSStyleSheet.prototype as unknown as Record<string, unknown>
      const orig = proto[name]
      if (typeof orig === 'function') {
        proto[name] = function patchedRule(this: CSSStyleSheet, ...a: unknown[]): unknown {
          const r = (orig as (...args: unknown[]) => unknown).apply(this, a)
          scheduleReclassify()
          return r
        }
        state.cssRestore.push(() => { proto[name] = orig })
      }
    }
  }
  // document.adoptedStyleSheets reassignment (feature-detected).
  try {
    const proto = Object.getPrototypeOf(state.rootDoc) as object
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets')
    if (desc?.set !== undefined && desc.get !== undefined) {
      const origSet = desc.set
      const origGet = desc.get
      Object.defineProperty(state.rootDoc, 'adoptedStyleSheets', {
        configurable: true,
        get() { return origGet.call(this) },
        set(v: unknown) { origSet.call(this, v); scheduleReclassify() },
      })
      state.cssRestore.push(() => {
        delete (state!.rootDoc as unknown as Record<string, unknown>).adoptedStyleSheets
      })
    }
  } catch { /* environment without adoptedStyleSheets -- documented limit */ }
}

/** AM4-R media/viewport trigger. A computed-style flip with NO DOM mutation and
 *  NO CSSOM API call is driven by a media/viewport change (an `@media` rule, a
 *  resize, an orientation or color-scheme flip). Those emit no MutationObserver
 *  record, so a resize + a matchMedia change listener each schedule one
 *  reclassifyAll pass. Both are feature-detected: jsdom implements neither
 *  reliably (no matchMedia; resize never fires), so in jsdom this is an honest
 *  no-op and the attribute/childList/CSSOM legs carry the proof, while a real
 *  browser gets the media leg. Removers go in the cleanup tail (charter 5). */
function installViewportListeners(): void {
  if (state === null) return
  const view = state.rootDoc.defaultView
  if (view === null) return
  const onViewportChange = (): void => scheduleReclassify()
  if (typeof view.addEventListener === 'function') {
    view.addEventListener('resize', onViewportChange)
    state.viewportRestore.push(() => view.removeEventListener('resize', onViewportChange))
  }
  if (typeof view.matchMedia === 'function') {
    // The specific query is immaterial: ANY media change re-runs the full pass,
    // because the guard cannot know which rule a flip came from.
    const mql = view.matchMedia('(min-width: 0px)')
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onViewportChange)
      state.viewportRestore.push(() => mql.removeEventListener('change', onViewportChange))
    }
  }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/** Install the guard on `doc` (default: the ambient document). Patches
 *  attachShadow, document.open/write and (where present) stylesheet mutation;
 *  observes the document root and every existing child context; and scans the
 *  tree already attached. Returns an uninstall handle. Idempotent-guarded:
 *  refuses a double install rather than silently leaking observers. */
export function installOverlayAttachGuard(
  doc: Document = document,
  opts: AttachGuardOptions = {},
): () => void {
  if (state !== null) {
    throw new Error('overlayAttachGuard: already installed -- call the returned uninstall handle before re-installing.')
  }
  state = {
    installed: true,
    rootDoc: doc,
    opts,
    observers: new Set(),
    observedRoots: new Set(),
    observedIframeDocs: new WeakSet(),
    pristineAttachShadow: null,
    pristineDocWrite: null,
    pristineDocOpen: null,
    cssRestore: [],
    viewportRestore: [],
    backstopHandle: null,
  }
  reclassifyScheduled = false
  reclassifyPassCount = 0
  backstopPassCount = 0
  installAttachShadowHook()
  installDocumentWriteHook()
  installStylesheetHooks()
  installViewportListeners()                    // AM4-R: media/viewport flips
  installBackstop()                             // the non-enumerated periodic floor
  observeRoot(doc, 'childList')                 // AM1: root is the Document node
  discoverChildContexts(doc)        // pick up pre-existing frames/roots
  for (const el of composedElements(doc)) examine(el, 'existing')
  return uninstallOverlayAttachGuard
}

export function uninstallOverlayAttachGuard(): void {
  if (state === null) return
  for (const obs of state.observers) obs.disconnect()
  if (state.pristineAttachShadow !== null && typeof Element !== 'undefined') {
    Element.prototype.attachShadow = state.pristineAttachShadow
  }
  if (state.pristineDocWrite !== null && typeof Document !== 'undefined') {
    Document.prototype.write = state.pristineDocWrite
  }
  if (state.pristineDocOpen !== null && typeof Document !== 'undefined') {
    Document.prototype.open = state.pristineDocOpen
  }
  for (const restore of state.cssRestore) restore()
  for (const restore of state.viewportRestore) restore()   // AM4-R cleanup tail
  if (state.backstopHandle !== null) {                      // backstop cleanup tail
    clearInterval(state.backstopHandle)
    state.backstopHandle = null
  }
  reclassifyScheduled = false            // a still-queued microtask no-ops now
  state = null
  refusedNodes = new WeakSet<Element>()
}

export function guardIsInstalled(): boolean { return state !== null }
