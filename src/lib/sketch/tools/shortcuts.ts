// Single-key sketch shortcuts (Stage 6, PLAN 3.4 doctrine).
//
// Pure decision layer: the key -> tool map and the focus guard live here
// so the dispatch rules are testable headless. The viewport's sketch key
// handler (CNCViewport, active ONLY in sketch mode) consults
// shortcutActionForKeyEvent and arms the returned tool / toggles the
// returned utility through the store.
//
// Doctrine:
//   - active in sketch mode only (the handler is attached on
//     enterSketchView and removed on exit);
//   - NEVER while a text input / value editor is focused (isTypingTarget);
//   - plain keypresses only — any Ctrl/Alt/Meta chord falls through to
//     the browser/app;
//   - q (construction toggle) and Esc/Enter/Delete keep their existing
//     dedicated handling; this module owns the tool-arming keys and the
//     Measure utility toggle.

import type { SketchToolId } from './toolMachine'

/** key (lowercase) -> tool to arm. Single source of truth: the toolbox
 *  derives its tooltip key hints from this map. */
export const SKETCH_TOOL_SHORTCUTS: Readonly<Record<string, SketchToolId>> = {
  l: 'line',
  r: 'rect-corner',
  c: 'circle-center',
  s: 'spline',
  g: 'text',
  a: 'arc-3pt',
  d: 'smart-dimension',
  t: 'trim',
  k: 'split',
  o: 'offset',
  m: 'mirror',
  e: 'extend',
  f: 'fillet',
  h: 'chamfer',
  '1': 'pattern-linear',
  '2': 'pattern-circular',
  '3': 'pattern-path',
  v: 'move',
  w: 'rotate',
  x: 'scale',
}

/** tool -> displayed key hint ("L"), for tool-button tooltips. */
export const SHORTCUT_KEY_BY_TOOL: Readonly<Partial<Record<SketchToolId, string>>> =
  Object.fromEntries(
    Object.entries(SKETCH_TOOL_SHORTCUTS).map(([k, tool]) => [tool, k.toUpperCase()])
  )

/** Utility readouts that have a single-key shortcut but are NOT SketchToolId
 *  drawing tools (they do not arm, do not enter the tool click machine, and do
 *  not own a chain). Today: Measure. Kept in its OWN map so the tool dispatch
 *  map stays typed `Record<string, SketchToolId>` and `shortcutToolForKeyEvent`
 *  keeps returning `SketchToolId | null` (Measure never appears there). */
export type SketchShortcutUtility = 'measure'

export const SKETCH_UTILITY_SHORTCUTS: Readonly<Record<string, SketchShortcutUtility>> = {
  i: 'measure',
}

/** utility -> displayed key hint ("I"), for utility-button tooltips. */
export const SHORTCUT_KEY_BY_UTILITY: Readonly<Partial<Record<SketchShortcutUtility, string>>> =
  Object.fromEntries(
    Object.entries(SKETCH_UTILITY_SHORTCUTS).map(([k, utility]) => [utility, k.toUpperCase()])
  )

/** The typed decision the sketch key handler makes for one key event: arm a
 *  drawing tool, or toggle a utility readout. `shortcutToolForKeyEvent` is the
 *  tool-only projection of this (it returns null for utility keys), kept so
 *  existing callers and tests that only care about arming stay unchanged. */
export type ShortcutAction =
  | { kind: 'tool'; tool: SketchToolId }
  | { kind: 'utility'; utility: SketchShortcutUtility }

/** Structural stand-in for an event target (testable without a DOM). */
export interface FocusTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** True when keystrokes belong to a text field, never to shortcuts. */
export function isTypingTarget(t: FocusTargetLike | EventTarget | null | undefined): boolean {
  if (!t) return false
  const target = t as FocusTargetLike
  const tag = target.tagName?.toUpperCase()
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
    target.isContentEditable === true ||
    (typeof target.closest === 'function' &&
      target.closest('[contenteditable]:not([contenteditable="false"])') != null)
  )
}

/** Structural stand-in for a KeyboardEvent (testable without a DOM). */
export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  repeat?: boolean
  target?: FocusTargetLike | null
}

/**
 * The typed action a key event should drive, or null when the event is not a
 * shortcut (unknown key, modifier chord, or focus inside a text field). The
 * sketch key handler dispatches on this so tool arming and utility toggles
 * share one focus/modifier guard and one dispatch source.
 */
export function shortcutActionForKeyEvent(e: KeyEventLike): ShortcutAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (isTypingTarget(e.target)) return null
  if (e.key.length !== 1) return null
  const key = e.key.toLowerCase()
  const tool = SKETCH_TOOL_SHORTCUTS[key]
  if (tool) return { kind: 'tool', tool }
  const utility = SKETCH_UTILITY_SHORTCUTS[key]
  // A held toggle key emits repeated keydowns. Tool arming is idempotent, but
  // a utility toggle would oscillate and finish in an unpredictable state.
  if (utility && e.repeat) return null
  if (utility) return { kind: 'utility', utility }
  return null
}

/**
 * The tool a key event should arm, or null when the event is not a tool
 * shortcut (unknown key, modifier chord, focus inside a text field, or a
 * utility key like `i` for Measure). Tool-only projection of
 * `shortcutActionForKeyEvent`; kept so callers/tests that only care about
 * arming keep their existing `SketchToolId | null` contract.
 */
export function shortcutToolForKeyEvent(e: KeyEventLike): SketchToolId | null {
  const action = shortcutActionForKeyEvent(e)
  return action?.kind === 'tool' ? action.tool : null
}
