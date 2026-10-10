// WO UI-70-R2 -- the RUNTIME overlay census engine (THE verdict-bearing gate).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS: two bounces, both on the census, both the same defect class
// ---------------------------------------------------------------------------
// R0 derived the overlay domain from CSS TEXT. The auditor beat it by reusing an
// already-dispositioned class from a new site.
// R1 derived it from an AST walk of the render tree. The auditor beat THAT, too
// (verbatim):
//
//   "A1's closed-domain law is still bypassable through a locally declared
//    styled or aliased JSX component. handleElement resolves a capitalized
//    identifier, enters its declaration, and returns before inspecting the
//    render site's className/style/spread attributes. A styled.div-style
//    variable declaration contains no intrinsic JSX for walkBody to classify,
//    so it creates neither a Surface nor an unresolved in-viewport hole."
//
// Both bypasses share ONE root cause: a STATIC scan must model how the code
// paints, and every model has a route it does not model. The fix is not a better
// model. It is to stop modelling: MOUNT THE REAL COMPONENTS AND LOOK AT THE
// LIVE DOM. A styled wrapper, an aliased component, a portal, a computed
// className -- all of them have to produce a real positioned element to be
// visible to the user, and this census enumerates elements, not source.
// (DECISIONS 2026-07-17, the RUNTIME-GROUNDED CENSUS LAW.)
//
// ---------------------------------------------------------------------------
// THE TWO FACTS THAT MAKE THIS POSSIBLE (both measured, not assumed)
// ---------------------------------------------------------------------------
// 1. jsdom DOES cascade `position` from a stylesheet -- but only one that is in
//    the document. jsdom loads none (the repo's own committed statement:
//    src/tests/model3d/AnchoredValueEntry.cohesion.test.tsx:8-11, "jsdom does
//    not resolve CSS custom properties or load app.css"). So injectAppStylesheet()
//    puts the app's REAL css text in the document, and assertStylesheetIsLive()
//    is the non-vacuity canary: a census that silently reads `static` for every
//    class-styled element would pass while seeing nothing, which is the exact
//    fail-open class this law forbids (amendment A5).
// 2. React 19 dev fibers carry `_debugStack` -- an Error whose first in-src frame
//    is the file:line:column of the JSX that created the node. That is what makes
//    a live DOM node resolve back to EXACTLY ONE authoring-site key (amendment
//    A3). A component-name key cannot: ViewportOverlay authors
//    `div.viewport-mode-banner` at TWO sites, and both would collapse onto one
//    runtime key. The JSX site is what keeps the mapping 1:1.
//
// Membership is decided by POSITIONING ALONE, over the WHOLE document -- never by
// DOM ancestry and never by rect overlap (amendment A4). jsdom computes no
// layout, so every getBoundingClientRect is zero and a geometric "is it over the
// viewport" test would silently fail open. Ancestry fails open too: a
// createPortal into document.body lands outside every viewport container's
// subtree while painting straight over the canvas.
//
// ---------------------------------------------------------------------------
// R3: THE THIRD BYPASS -- SHADOW DOM (the R2 audit's BLOCKER, verbatim)
// ---------------------------------------------------------------------------
//   "The verdict-bearing runtime census is bypassable through Shadow DOM.
//    enumerateFloating() walks only document.body.querySelectorAll('*'), which
//    never descends into an element's ShadowRoot. A web component can therefore
//    render a real absolute/fixed/sticky HUD while its light-DOM host remains
//    static, and the census reports no surface."
//
// The auditor is right, and the root cause is worth naming precisely, because it
// is NOT the modelling defect that killed R0 and R1. R2 stopped modelling how
// the code paints and started reading the live DOM -- that part held. What it
// got wrong is smaller and dumber: `querySelectorAll` enumerates one TREE, and a
// document with shadow roots is SEVERAL trees. The census was reading the DOM,
// just not all of it.
//
// So the walk is now COMPOSED: document.body down, and into every shadow root it
// meets, recursively. Open roots are reachable through `el.shadowRoot`. Closed
// roots are NOT -- by design, that is what "closed" means -- so attachShadow is
// instrumented at module load (before any mount can call it) and every root it
// hands out, open or closed, is recorded. Anything left that could still be
// hiding a root -- a custom element whose root we cannot enumerate -- fails BY
// NAME rather than being walked past. See UNINSPECTABLE below.
import { readFileSync } from 'node:fs'
import path from 'node:path'
// WO UI-78 (disclosed, behaviour-preserving): OUT_OF_FLOW now lives in a
// node-free module so the DOM attach-guard (bundled into the dev browser build)
// can share the ONE set object rather than defining a second, driftable copy.
// This census re-exports it below, so every existing importer -- overlayKeyMap,
// overlayAuthoringLint, the census's own :504-511 rule -- reads the identical
// binding it always did. See src/tests/ui/support/overlayFloating.ts.
import { OUT_OF_FLOW as OUT_OF_FLOW_SHARED } from './overlayFloating'

/** src/. `import.meta.url` is NOT a file URL under the jsdom environment (it
 *  throws "The URL must be of scheme file"), which is why this is cwd-derived:
 *  vitest runs every file from the repo root. */
export const SRC_ROOT = path.join(process.cwd(), 'src')

/** Out of flow -- i.e. the element paints over whatever is beneath it instead of
 *  taking space in the layout. `sticky` is included per amendment A4: it leaves
 *  flow the moment it engages, and a sticky HUD over the canvas is exactly the
 *  surface this census exists to catch. */
export const OUT_OF_FLOW = OUT_OF_FLOW_SHARED

// ---------------------------------------------------------------------------
// 0. The shadow inspector (R3: the R2 audit's BLOCKER)
// ---------------------------------------------------------------------------

const SHADOW_INSPECTOR_MARK = '__ui70ShadowInspector'

/** Every root attachShadow has handed out since the inspector was installed --
 *  open AND closed. `el.shadowRoot` covers only the open ones (a closed root
 *  reads back as null, which is the entire point of `mode: 'closed'`), so
 *  without this record a closed-root web component is a hole the walk cannot
 *  even know it is walking past. */
const attachedRoots = new WeakMap<Element, ShadowRoot>()

/** Patches Element.prototype.attachShadow to record every root it creates.
 *
 *  Called at MODULE LOAD, which is what makes it sound: a jsdom document starts
 *  empty and elements are created during render, so the inspector is in place
 *  before any element in the census's document exists. It is idempotent, it does
 *  not change attachShadow's behaviour (the real root is returned, still closed
 *  to the app), and shadowInspectorIsInstalled() lets the census refuse to run
 *  without it rather than silently enumerating one tree out of several.
 *
 *  Guarded on `Element` because this module is also imported (through
 *  overlayKeyMap) by the ADVISORY static census, which runs in the node
 *  environment where no DOM globals exist. */
let pristineAttachShadow: typeof Element.prototype.attachShadow | null = null

export function installShadowInspector(): void {
  if (typeof Element === 'undefined') return
  const current = Element.prototype.attachShadow as unknown as Record<string, unknown>
  if (current?.[SHADOW_INSPECTOR_MARK] === true) return
  const original = Element.prototype.attachShadow
  pristineAttachShadow = original
  function patched(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = original.call(this, init)
    attachedRoots.set(this, root)
    return root
  }
  ;(patched as unknown as Record<string, unknown>)[SHADOW_INSPECTOR_MARK] = true
  Element.prototype.attachShadow = patched as typeof Element.prototype.attachShadow
}
installShadowInspector()

/** Puts the PRISTINE attachShadow back and hands over the restore. Exists for
 *  one caller: the canary that proves the inspector is load-bearing by watching
 *  the census refuse without it (WORKER-CHARTER item 1 -- a probe that cannot
 *  fail is not a gate). Nothing in the census's own path may call it. */
export function uninstallShadowInspectorForCanary(): () => void {
  if (typeof Element === 'undefined' || pristineAttachShadow === null) return () => {}
  const patched = Element.prototype.attachShadow
  Element.prototype.attachShadow = pristineAttachShadow
  return () => { Element.prototype.attachShadow = patched }
}

/** THE SHADOW CANARY's fact (amendment A5's shape, applied to R3's blocker): if
 *  the inspector is not live, closed roots are unrecorded, and a closed-root HUD
 *  is invisible to the walk while painting over the canvas. The census asserts
 *  this rather than assuming its own module side effect ran. */
export function shadowInspectorIsInstalled(): boolean {
  if (typeof Element === 'undefined') return false
  return (Element.prototype.attachShadow as unknown as Record<string, unknown>)?.[SHADOW_INSPECTOR_MARK] === true
}

/** The root hanging off this element, whether it is open or closed. */
function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot !== null) return el.shadowRoot
  return attachedRoots.get(el) ?? null
}

/** A custom element (its tag name must contain a hyphen -- that is the spec's own
 *  rule) with no root we can read.
 *
 *  It is reported BY NAME rather than walked past. The census cannot prove such
 *  an element is shadow-free: a closed root attached outside the inspector's
 *  reach reads back as null and is indistinguishable from no root at all. That
 *  ambiguity is precisely the bypass, so it resolves to a REFUSAL, per the R2
 *  audit's own suggested fix ("...or fail closed on uninspectable custom
 *  elements"). This app defines ZERO custom elements (`customElements.define`
 *  has no hit in src/), so the rule costs nothing today and refuses the day
 *  someone introduces one without telling this census about it. */
function isUninspectableCustomElement(el: Element): boolean {
  if (!el.tagName.includes('-')) return false
  return shadowRootOf(el) === null
}

/** Every element in the COMPOSED tree under `root`: its own descendants, plus
 *  the descendants of every shadow root beneath it, recursively.
 *
 *  This is the R2 audit's BLOCKER fix. `querySelectorAll('*')` enumerates ONE
 *  tree; shadow roots are separate trees hanging off elements of this one, and
 *  they are where a web component's real, painting, positioned DOM lives. */
export function composedDescendants(root: ParentNode): Element[] {
  const out: Element[] = []
  for (const el of Array.from(root.querySelectorAll('*'))) {
    out.push(el)
    const shadow = shadowRootOf(el)
    if (shadow !== null) out.push(...composedDescendants(shadow))
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. The stylesheet (amendment A5)
// ---------------------------------------------------------------------------

/** The app's real CSS text, in the app's own import order (App.tsx:25-26). */
export function appStylesheetText(): string {
  return [
    readFileSync(path.join(SRC_ROOT, 'theme', 'tokens.css'), 'utf8'),
    readFileSync(path.join(SRC_ROOT, 'styles', 'app.css'), 'utf8'),
  ].join('\n')
}

/** Puts the app's real stylesheet in the jsdom document, so getComputedStyle()
 *  reports what a class-positioned element ACTUALLY resolves to. Returns the
 *  removal handle. */
export function injectAppStylesheet(doc: Document = document): () => void {
  const style = doc.createElement('style')
  style.setAttribute('data-ui70-census', 'app-stylesheet')
  style.textContent = appStylesheetText()
  doc.head.appendChild(style)
  return () => { style.remove() }
}

/** The classes the canary proves the cascade on: two absolute, one fixed, and
 *  one negative control. Each is a REAL production class carrying a REAL
 *  production position, so the canary cannot rot into a self-referential fixture
 *  (if app.css stops positioning these, the canary is supposed to break) --
 *  which is exactly what happened to `workbench-anchor-entry`: the main merge
 *  (52ec79e9) brought in UI-57's shipped AnchoredValueEntry, which positions
 *  itself INLINE rather than through an app.css class rule (a DISPOSITIONED
 *  exception -- see overlayDispositions.ts and overlayCohesionCensus.test.ts's
 *  "AnchoredValueEntry disposition" block), so app.css no longer positions
 *  `.workbench-anchor-entry` at all and this canary broke as designed.
 *  `workbench-confirm-bar` (app.css:6852) replaces it as the second real
 *  absolute-positioned class -- the reference implementation this WO's own
 *  disposition table cites as what AnchoredValueEntry now visually matches. */
export const CANARY_EXPECTATIONS: ReadonlyArray<{ className: string; expected: string }> = [
  { className: 'viewport-overlay', expected: 'absolute' },
  { className: 'workbench-confirm-bar', expected: 'absolute' },
  { className: 'modal-backdrop', expected: 'fixed' },
  { className: 'ui70-canary-unstyled-control', expected: 'static' },
]

export interface CanaryResult { className: string; expected: string; actual: string }

/** THE NON-VACUITY CANARY (amendment A5). Reads a known class-positioned element
 *  back through the same getComputedStyle() path the census itself uses. If the
 *  injected stylesheet is missing, mis-ordered, or silently unparsed, every
 *  class-styled element reads `static`, the census enumerates NOTHING, and every
 *  assertion below passes -- a green run that looked at an empty domain. This is
 *  what refuses that. Call it in the same document the census runs in. */
export function measureCanary(doc: Document = document): CanaryResult[] {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const out: CanaryResult[] = []
  for (const { className, expected } of CANARY_EXPECTATIONS) {
    const el = doc.createElement('div')
    el.className = className
    host.appendChild(el)
    out.push({ className, expected, actual: doc.defaultView?.getComputedStyle(el).position ?? '(no window)' })
  }
  host.remove()
  return out
}

// ---------------------------------------------------------------------------
// 2. The React fiber: who authored this node, and where
// ---------------------------------------------------------------------------

interface FiberLike {
  tag: number
  type: unknown
  return: FiberLike | null
  memoizedProps?: unknown
  pendingProps?: unknown
  _debugOwner?: FiberLike | null
  _debugStack?: { stack?: string } | null
}

function fiberOf(el: Element): FiberLike | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$')) return (el as unknown as Record<string, FiberLike>)[key]
  }
  return null
}

/** A component fiber's display name. Covers the plain function/class case plus
 *  the wrappers React represents as objects (memo/forwardRef), because "the
 *  owner has no readable name" must be a LOUD unknown, never a quiet ''. */
function componentName(type: unknown): string | null {
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string }
    return fn.displayName ?? (fn.name !== undefined && fn.name !== '' ? fn.name : null)
  }
  if (typeof type === 'object' && type !== null) {
    const obj = type as { displayName?: string; render?: { name?: string }; type?: unknown }
    if (obj.displayName !== undefined) return obj.displayName
    if (obj.render?.name !== undefined && obj.render.name !== '') return obj.render.name
    if (obj.type !== undefined) return componentName(obj.type)
  }
  return null
}

export interface AuthoringSite { file: string; line: number; column: number }

/** This module's own file, so the stack parser can skip its own frames: the JSX
 *  site recorder below is CALLED FROM inside this file, and this file lives
 *  under src/, so "the first frame under src/" would otherwise resolve every
 *  element to the recorder itself. */
const SELF_FILE: string | null = (() => {
  const frame = (new Error().stack ?? '').split('\n')[1]?.trim() ?? ''
  const m = /\(?([A-Za-z]:[\\/][^()]*?|\/[^()]*?):(\d+):(\d+)\)?\s*$/.exec(frame)
  return m === null ? null : path.resolve(m[1])
})()

// ---------------------------------------------------------------------------
// 2a. THE JSX SITE RECORDER (WO UI-70-R3)
// ---------------------------------------------------------------------------
//
// R2 read the authoring site off `fiber._debugStack`. That is WRONG for any
// fiber React REUSES, and it is wrong silently. React's own source says so:
//
//   createWorkInProgress:  workInProgress._debugStack = current._debugStack
//                          (react-dom-client.development.js:4819)
//   updateElement:         current._debugOwner = element._owner
//                          (react-dom-client.development.js:6268)
//
// On an update React refreshes `_debugOwner` and `_debugInfo` -- and NOT
// `_debugStack`. So a host fiber carries the stack of the JSX site that FIRST
// created it, for the rest of its life, however many different sites later
// render through it.
//
// This is not theoretical; it is how it was found. SetupModal renders its modal
// backdrop at :425 and, when a vertex pick starts, EARLY-RETURNS a
// `div.vertex-pick-banner` at :410 instead. Same position, same tag, so React
// reuses the fiber -- and the live banner reported itself authored at :425, the
// BACKDROP's site. The census named a real surface with another surface's key.
//
// Why that is a BYPASS and not a cosmetic mislabel: an element misattributed to
// a DISPOSITIONED site inherits that site's disposition and passes the
// fail-closed direction silently. The R2 census's whole safety argument is "a
// surface the static walk cannot name is still SEEN, finds no name, and fails BY
// NAME". A stale site does not fail to find a name -- it finds the WRONG one.
//
// The fix does not read the fiber for the site at all -- and the reason it must
// not is a SECOND stale-read that the first fix walked straight into. React
// double-buffers fibers: `el.__reactFiber$...` is cached on the DOM node when
// the node is created and is never re-pointed, so after an update the node's
// cached fiber can be the ALTERNATE, holding the PREVIOUS committed props. Any
// route through the fiber -- _debugStack, memoizedProps, pendingProps -- can
// therefore hand back a stale answer, and each one fails silently.
//
// So the site goes where this WO's whole thesis says the truth lives: ON THE
// LIVE DOM. The wrapped jsxDEV stamps every HOST element with a
// `data-ui70-site` attribute naming the JSX site that rendered it. React writes
// that attribute exactly like any other prop, on every update, from the render
// that is actually on screen. There is no cache to go stale, no alternate to
// pick between, and no reconciler internal to reason about -- the census reads
// the attribute off the element it is already holding.
//
// It is instrumentation, not a mock: the real jsxDEV is called and its element
// returned. The attribute is inert (it carries no style, no class, no position)
// and lands only in this harness's jsdom document.

const SITE_ATTR = 'data-ui70-site'
let jsxRecorderInstalled = false

/** Wraps the real jsxDEV so every HOST element carries the JSX site that
 *  rendered it. Install via vi.mock('react/jsx-dev-runtime') BEFORE any
 *  component module loads. */
export function wrapJsxDev<T extends (...args: unknown[]) => unknown>(actual: T, srcRoot: string = SRC_ROOT): T {
  jsxRecorderInstalled = true
  return function jsxDEV(this: unknown, ...args: unknown[]): unknown {
    // Host elements only: `type` is a string for intrinsics ('div', 'span'). A
    // component gets nothing, or the unknown prop would be passed down its tree
    // and land on whatever host element it happens to spread onto.
    if (typeof args[0] === 'string') {
      const config = args[1]
      if (config !== null && config !== undefined && typeof config === 'object') {
        const site = siteFromStack(new Error().stack, srcRoot)
        // Stamped on the CONFIG, before jsxDEV reads it -- React copies config
        // into the frozen props object, so mutating it afterwards is not an
        // option and mutating it here is safe (it is a fresh object literal per
        // JSX call, by construction of the transform).
        if (site !== null) (config as Record<string, unknown>)[SITE_ATTR] = `${site.file}@${site.line}:${site.column}`
      }
    }
    return actual.apply(this, args)
  } as unknown as T
}

export function jsxSiteRecorderIsInstalled(): boolean { return jsxRecorderInstalled }

/** The JSX site that rendered THIS element, read off the element itself. */
export function siteOfElement(el: Element): AuthoringSite | null {
  const raw = el.getAttribute(SITE_ATTR)
  if (raw === null) return null
  const m = /^(.*)@(\d+):(\d+)$/.exec(raw)
  if (m === null) return null
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) }
}

/** The first frame under srcRoot that is not this module itself. Both frame
 *  shapes V8 emits are parsed: `at Name (file:l:c)` and the bare `at file:l:c`
 *  an anonymous callback (a `.map()` render) produces. */
function siteFromStack(stack: string | undefined, srcRoot: string): AuthoringSite | null {
  if (typeof stack !== 'string') return null
  for (const raw of stack.split('\n').slice(1)) {
    const m = /\(?([A-Za-z]:[\\/][^()]*?|\/[^()]*?):(\d+):(\d+)\)?\s*$/.exec(raw.trim())
    if (m === null) continue
    const file = m[1]
    if (file.includes('node_modules')) continue
    const resolved = path.resolve(file)
    if (SELF_FILE !== null && resolved === SELF_FILE) continue
    if (!resolved.startsWith(srcRoot + path.sep)) continue
    return {
      file: path.relative(srcRoot, resolved).split(path.sep).join('/'),
      line: Number(m[2]),
      column: Number(m[3]),
    }
  }
  return null
}

/** The site R2 trusted, kept ONLY so the census can prove the two disagree.
 *
 *  A probe that cannot fail is not a gate (WORKER-CHARTER item 1), and "React
 *  does not refresh _debugStack on update" is exactly the kind of claim this
 *  program requires a constructed, committed test for rather than prose about
 *  reconciler internals (charter item 4). The census renders the real reuse,
 *  reads BOTH answers, and asserts they differ -- so if a future React ever
 *  refreshes _debugStack, that test fails and tells the next reader this
 *  machinery is no longer load-bearing. */
export function staleFiberSiteOf(fiber: FiberLike, srcRoot: string = SRC_ROOT): AuthoringSite | null {
  return siteFromStack(fiber._debugStack?.stack, srcRoot)
}

// ---------------------------------------------------------------------------
// 3. The enumeration
// ---------------------------------------------------------------------------

export interface RuntimeSurface {
  /** THE runtime identity (amendment A3): the fiber OWNER component (qualified
   *  by its file, so two same-named components -- there are two `TreeContextMenu`s
   *  in this tree -- cannot collapse), the element TAG, its live CLASSLIST, and
   *  the JSX site that authored it. The site is not decoration: without it the
   *  scheme is lossy, because one component can author the same
   *  owner+tag+classList at several sites. */
  key: string
  /** `<file>@<line>:<column>` -- the JSX site, and the join key onto the AST
   *  walk's authoring-site keys. */
  site: string
  ownerFile: string
  ownerComponent: string
  tag: string
  classes: string[]
  position: string
  positionSource: 'inline' | 'stylesheet'
  /** Set when the node cannot be resolved to a React authoring site at all --
   *  no fiber (imperative DOM), no readable owner, or no in-src stack frame.
   *  The census fails BY NAME on any of these rather than skipping them: an
   *  unattributable floating element is precisely what a bypass looks like. */
  unattributed: string | null
}

function runtimeKey(s: Omit<RuntimeSurface, 'key' | 'unattributed'>): string {
  const classes = s.classes.length === 0 ? '' : `.${[...s.classes].sort().join('.')}`
  return `${s.ownerFile}:${s.ownerComponent} > ${s.tag}${classes} @${s.site.split('@')[1]}`
}

/** Every out-of-flow element in the WHOLE document (amendment A4: document.body
 *  down, never a viewport container's subtree -- a portal into body is outside
 *  every such subtree while painting straight over the canvas), across the whole
 *  COMPOSED tree (R3: and into every shadow root, open or closed -- a web
 *  component's HUD paints over the canvas from inside a tree
 *  `querySelectorAll` does not enumerate).
 *
 *  Elements this census's own scaffolding owns (the injected <style>, the
 *  canary host) are excluded by an explicit marker attribute, never by a
 *  heuristic. */
export function enumerateFloating(doc: Document = document, _srcRoot: string = SRC_ROOT): RuntimeSurface[] {
  const view = doc.defaultView
  if (view === null) throw new Error('enumerateFloating: the document has no window -- getComputedStyle is unavailable')
  if (!shadowInspectorIsInstalled()) {
    throw new Error(
      'enumerateFloating: the shadow inspector is NOT installed, so closed shadow roots are unrecorded and this '
      + 'census would enumerate one tree out of possibly several -- the R2 audit BLOCKER. Refusing to report a '
      + 'verdict over a domain it cannot see. Call installShadowInspector() before any mount.',
    )
  }
  if (!jsxSiteRecorderIsInstalled()) {
    throw new Error(
      'enumerateFloating: the JSX site recorder is NOT installed, so authoring sites would fall back to nothing at '
      + 'all. Wrap jsxDEV with wrapJsxDev() via vi.mock(\'react/jsx-dev-runtime\') BEFORE any component module loads.',
    )
  }
  const out: RuntimeSurface[] = []
  for (const el of composedDescendants(doc.body)) {
    if (el.closest('[data-ui70-census]') !== null) continue

    // A custom element whose root cannot be read is a REFUSAL, not a skip: its
    // shadow tree may hold a painting surface and there is no way to tell.
    if (isUninspectableCustomElement(el)) {
      out.push({
        key: `<UNINSPECTABLE> ${el.tagName.toLowerCase()}`,
        site: '<unknown>', ownerFile: '<unknown>', ownerComponent: '<unknown>',
        tag: el.tagName.toLowerCase(), classes: Array.from(el.classList),
        position: '<unknown>', positionSource: 'inline',
        unattributed: 'this is a custom element whose shadow root the census cannot enumerate -- a closed root '
          + 'attached outside the inspector reads back as null and is indistinguishable from no root at all, so a '
          + 'HUD could be painting over the canvas from inside it',
      })
      continue
    }

    const inline = (el as HTMLElement).style?.position ?? ''
    const computed = view.getComputedStyle(el).position
    const position = OUT_OF_FLOW.has(inline) ? inline : computed
    if (!OUT_OF_FLOW.has(position)) continue

    const tag = el.tagName.toLowerCase()
    const classes = Array.from(el.classList)
    const positionSource: 'inline' | 'stylesheet' = OUT_OF_FLOW.has(inline) ? 'inline' : 'stylesheet'
    const fiber = fiberOf(el)
    const owner = fiber?._debugOwner ?? null
    const name = owner === null || owner === undefined ? null : componentName(owner.type)
    const site = siteOfElement(el)

    let unattributed: string | null = null
    if (fiber === null) unattributed = 'no React fiber -- this element was created imperatively, outside the render tree'
    else if (name === null) unattributed = 'the fiber has no readable owner component (React dev build required)'
    else if (site === null) unattributed = 'the element carries no data-ui70-site -- it was not rendered through the instrumented jsxDEV'

    if (unattributed !== null) {
      out.push({
        key: `<UNATTRIBUTED> ${tag}${classes.map((c) => `.${c}`).join('')} [position:${position}]`,
        site: '<unknown>',
        ownerFile: '<unknown>',
        ownerComponent: name ?? '<unknown>',
        tag,
        classes,
        position,
        positionSource,
        unattributed,
      })
      continue
    }
    const s = site as AuthoringSite
    const base = {
      site: `${s.file}@${s.line}:${s.column}`,
      ownerFile: s.file,
      ownerComponent: name as string,
      tag,
      classes,
      position,
      positionSource,
    }
    out.push({ ...base, key: runtimeKey(base), unattributed: null })
  }
  return out
}

/** Every JSX site that RENDERED AN ELEMENT in this document, whether that
 *  element floats or not.
 *
 *  This is what the COMPLETENESS direction (amendment A2) needs, and it is the
 *  honest half of it. The static tier is deliberately fail-closed: when it
 *  cannot statically resolve a `className` or a `style` it calls the element
 *  INDETERMINATE and demands a disposition rather than assuming it is harmless
 *  (`NumericInput > input` is in the domain for exactly that reason -- its
 *  className is a prop). A mount RESOLVES that guess: the element is right
 *  there, and its computed position says whether it is a floating surface or an
 *  ordinary in-flow control. Recording the sites that rendered lets the census
 *  distinguish "this entry was never mounted, so nobody knows" (which must fail)
 *  from "this entry was mounted and provably takes part in flow" (which is an
 *  answer, and a stronger one than the static guess it replaces). */
export function enumerateAuthoredSites(doc: Document = document, _srcRoot: string = SRC_ROOT): Set<string> {
  const sites = new Set<string>()
  for (const el of composedDescendants(doc.body)) {
    if (el.closest('[data-ui70-census]') !== null) continue
    const site = siteOfElement(el)
    if (site === null) continue
    sites.add(`${site.file}@${site.line}:${site.column}`)
  }
  return sites
}
