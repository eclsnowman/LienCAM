// WO-3282 (UI M2 W1-E): the ONE keydown listener of the New UI (InstallShortcutListener in
// ../types). The New UI mounts it once at its root (useShortcutListener); a second install while
// one is live is a programming error and throws. It reads each keydown into a KeyChord and hands
// it to the manager, which decides; preventDefault only when the manager handled the key.
//   - A field (text input, textarea, select, contenteditable) marks the chord editable; a focused
//     checkbox, radio or button is not a field, so shortcuts still work there.
//   - Key repeat (a held key) never runs a command again; it only keeps the browser's own action
//     off a chord the manager would take now (claims), never one it would let through.
//   - Space and Enter on a focused button, checkbox, radio or link press that control, so they
//     count as typed into it.
//   - AltGr typing (Ctrl+Alt on Windows layouts, @ on a German board) is a character, not a Mod chord.
//   - Text being composed by an input method is left alone.
import { useEffect } from 'react'
import type { InstallShortcutListener, KeyChord, ShortcutManager } from '../types'
import type { LiveShortcutManager } from './manager'

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

function isField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NOT_TEXT.has(((el as HTMLInputElement).type ?? 'text').toLowerCase())
  return el.isContentEditable === true
}

const ACTIVATES = /^(BUTTON|A|SUMMARY)$/

function isActivatable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (ACTIVATES.test(tag)) return true
  if (tag === 'INPUT') return NOT_TEXT.has(((el as HTMLInputElement).type ?? '').toLowerCase())
  const role = el.getAttribute?.('role') ?? ''
  return /^(button|checkbox|radio|switch|menuitem|option|tab|link)$/.test(role)
}

export function chordFromEvent(e: KeyboardEvent): KeyChord {
  const altGraph = e.getModifierState?.('AltGraph') === true
  const target = typeof e.composedPath === 'function' ? e.composedPath()[0] ?? e.target : e.target
  return {
    key: e.key,
    ctrlKey: e.ctrlKey && !altGraph,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey && !altGraph,
    editable: isField(target) || ((e.key === ' ' || e.key === 'Enter') && isActivatable(target)),
  }
}

let live: object | null = null

export const installShortcutListener: InstallShortcutListener = (target, manager) => {
  if (live) throw new Error('the shortcut listener is already installed; the New UI has exactly one')
  const token = {}
  live = token
  const onKey = (event: Event) => {
    const e = event as KeyboardEvent
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return
    const chord = chordFromEvent(e)
    if (e.repeat) {
      const claims = (manager as Partial<LiveShortcutManager>).claims
      if (chord.key !== 'Escape' && (claims ? claims(chord) : false)) e.preventDefault()
      return
    }
    if (manager.handle(chord)) e.preventDefault()
  }
  target.addEventListener('keydown', onKey)
  return () => {
    target.removeEventListener('keydown', onKey)
    if (live === token) live = null
  }
}

/** Mounts the one listener on the window for as long as the calling component (the New UI root)
 *  is mounted. */
export function useShortcutListener(manager: ShortcutManager, target: EventTarget | undefined = typeof window === 'undefined' ? undefined : window): void {
  useEffect(() => (target ? installShortcutListener(target, manager) : undefined), [manager, target])
}
