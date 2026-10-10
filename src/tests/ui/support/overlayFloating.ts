// WO UI-78 -- the ONE positioned-surface classification, shared by two runtimes.
//
// Why this file exists (AC1 "reuse ... not a new one"): the runtime census
// (src/tests/ui/support/overlayRuntimeCensus.ts) decides overlay membership by
// POSITIONING ALONE -- an element is a floating surface iff its resolved
// `position` is one of absolute/fixed/sticky. The census carries that rule
// inline (overlayRuntimeCensus.ts:504-511) over an OUT_OF_FLOW set it defined.
//
// The DOM attach-guard (overlayAttachGuard.ts) must classify by the EXACT SAME
// rule -- a guard that used a different notion of "floating" than the census
// would be a second, driftable definition, which is precisely the closed-list
// defect the R4/R5 rounds died on wearing a different mask. So OUT_OF_FLOW now
// lives HERE (moved from the census, which re-exports it unchanged), and both
// the census and the guard read the one set. This module has ZERO node
// dependencies (no `node:fs`, no `node:path`) so the guard -- which the dev
// browser build lazy-loads per AC6 -- can import it; the census's own module is
// node-tainted and cannot be. It lives in src/tests/ui/support alongside the
// census's attachShadow instrumentation because that is what it is: dev/test
// enforcement instrumentation, not product paint code, and so it is excluded
// from productSourceFiles exactly as the census's own instrumentation is.
//
// UI-78 note (AC8): moving the definition here leaves every census/lint/keymap
// assertion byte-identical -- they import OUT_OF_FLOW from overlayRuntimeCensus
// as before, which re-exports this binding, so it is the SAME set object at
// runtime. This is a disclosed, behaviour-preserving extraction.

/** Out of flow -- i.e. the element paints over whatever is beneath it instead of
 *  taking space in the layout. `sticky` is included per the census's amendment
 *  A4: it leaves flow the moment it engages, and a sticky HUD over the canvas is
 *  exactly the surface the overlay gates exist to catch. */
export const OUT_OF_FLOW: ReadonlySet<string> = new Set(['absolute', 'fixed', 'sticky'])

export interface FloatingClassification {
  /** True iff this element itself paints out of flow over the viewport. */
  floating: boolean
  /** The resolved position value the verdict rests on. */
  position: string
  /** Where the deciding value came from -- an inline `style.position`, the
   *  cascaded stylesheet, or neither (in-flow). */
  source: 'inline' | 'stylesheet' | 'none'
}

/** The census's positioned-surface rule, extracted verbatim
 *  (overlayRuntimeCensus.ts:504-511) so the attach-guard classifies by the same
 *  logic and the same OUT_OF_FLOW set: prefer an out-of-flow INLINE position
 *  over the computed one (an inline `position:fixed` is out of flow even where
 *  no stylesheet is loaded), else fall back to the cascaded computed value.
 *
 *  `view` is the element's OWN window -- for a node inside an iframe's
 *  contentDocument that is the child window, whose getComputedStyle resolves the
 *  child document's cascade (the parent's would throw or lie). */
export function classifyFloating(el: Element, view: Window): FloatingClassification {
  const inline = (el as HTMLElement).style?.position ?? ''
  const computed = view.getComputedStyle(el).position
  const position = OUT_OF_FLOW.has(inline) ? inline : computed
  if (!OUT_OF_FLOW.has(position)) return { floating: false, position, source: 'none' }
  return { floating: true, position, source: OUT_OF_FLOW.has(inline) ? 'inline' : 'stylesheet' }
}
