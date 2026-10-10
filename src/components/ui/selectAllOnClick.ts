// Shared "click a numeric field -> the whole value is selected" contract.
//
// THE PROVEN PATTERN (extracted verbatim from NumericInput, verified in a real
// headed browser 2026-07): a mouse click into a TEXT input focuses it, but the
// browser then collapses the selection to a caret at the click point on
// mouseUp. So select-on-focus alone is NOT enough:
//   1. onFocus: select all + ARM a one-shot flag.
//   2. onMouseUp: if armed, consume the flag, preventDefault (kills the
//      browser's caret drop), and re-select all.
// The one-shot flag gives the Chrome-URL-bar feel: the FIRST click into a
// field selects everything; the second click of a double-click consumes no
// new arm, so the browser leaves its caret where the user placed it.
//
// PROGRAMMATIC-FOCUS CASE (SketchDimensionOverlay's auto-opened dim editor):
// when code focuses the input, the user's first click fires NO focus event
// (the field is already focused), so the flag must be armed by the
// programmatic focus too — call `arm()` from the same effect that focuses.
//
// REQUIREMENT ON THE INPUT: must be type="text" (use inputMode="decimal" /
// "numeric" for the mobile keypad). Per the HTML spec the text-selection APIs
// (select / setSelectionRange / selectionStart/End) DO NOT APPLY to
// type="number" — that silent no-op was the original bug (commit 18610ab).
//
// Two consumers:
//   - useSelectAllOnClick(): React hook for JSX inputs (onFocus/onMouseUp
//     handlers + arm() for programmatic-focus call sites).
//   - attachSelectAllOnClick(el): plain-DOM attach for imperatively built
//     inputs (e.g. CNCViewport's slice-plane Z overlay).
// Do NOT re-implement this pattern inline in a component — consume one of
// these so the behavior can never fork again.

import { useMemo, useRef } from 'react'

/** Select the input's entire value. setSelectionRange works on text inputs
 *  (unlike type="number", where the text-selection APIs are a no-op per the
 *  HTML spec — that was the bug). */
export function selectAllInInput(el: HTMLInputElement): void {
  try { el.setSelectionRange(0, el.value.length) } catch { el.select() }
}

export interface SelectAllOnClickHandlers {
  /** Select all + arm the one-shot mouseUp re-select WITHOUT a focus event.
   *  Call from the effect that programmatically focuses the input (the
   *  auto-focused-editor case: the user's first click fires no focus). */
  arm: (el?: HTMLInputElement | null) => void
  /** Attach as the input's onFocus (or call from inside a wrapping onFocus). */
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void
  /** Attach as the input's onMouseUp (or call from inside a wrapper). */
  onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => void
  /** The same one-shot re-select bound at CLICK time instead of mouseUp - for hosts
   *  whose down/up pointer gestures are owned elsewhere (the workbench's one sketch
   *  draw machine, SKC-15C: `onClick` is the only mouse verb allowed under
   *  src/components/model3d). Click fires after the default caret placement, so it
   *  cannot prevent it; it re-selects instead, which reads the same to the user (WO-406). */
  onClick: (e: React.MouseEvent<HTMLInputElement>) => void
}

/**
 * React hook flavor of the contract. One instance may serve several inputs in
 * the same component (the flag is armed by whichever input focuses and
 * consumed by the next mouseUp on any of them — focus always precedes the
 * paired mouseUp, so the pairing holds).
 */
export function useSelectAllOnClick(): SelectAllOnClickHandlers {
  const armed = useRef(false)
  // Stable identity so consumers can list the handlers (or the bundle) in
  // effect deps without re-running per render.
  return useMemo<SelectAllOnClickHandlers>(() => ({
    arm: (el?: HTMLInputElement | null) => {
      if (el) selectAllInInput(el)
      armed.current = true
    },
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      // Select all so the user can type immediately over the value. Also arm
      // the one-shot re-select for the mouseUp that follows a click focus
      // (the click otherwise collapses the selection to a caret).
      selectAllInInput(e.currentTarget)
      armed.current = true
    },
    onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
      if (armed.current) {
        armed.current = false
        // Prevent the default mouseUp caret placement, then re-select.
        e.preventDefault()
        selectAllInInput(e.currentTarget)
      }
    },
    onClick: (e: React.MouseEvent<HTMLInputElement>) => {
      if (armed.current) {
        armed.current = false
        selectAllInInput(e.currentTarget)
      }
    },
  }), [])
}

/**
 * Plain-DOM flavor for imperatively built inputs (raw createElement /
 * innerHTML overlays). Attaches the same focus + mouseUp pair via
 * addEventListener. Returns `arm` (for programmatic-focus call sites) and
 * `detach` (optional cleanup; listeners die with the element otherwise).
 */
export function attachSelectAllOnClick(
  el: HTMLInputElement,
): { arm: () => void; detach: () => void } {
  let armed = false
  const onFocus = () => {
    selectAllInInput(el)
    armed = true
  }
  const onMouseUp = (e: MouseEvent) => {
    if (armed) {
      armed = false
      e.preventDefault()
      selectAllInInput(el)
    }
  }
  el.addEventListener('focus', onFocus)
  el.addEventListener('mouseup', onMouseUp)
  return {
    arm: () => { selectAllInInput(el); armed = true },
    detach: () => {
      el.removeEventListener('focus', onFocus)
      el.removeEventListener('mouseup', onMouseUp)
    },
  }
}
