// WO-3282 (UI M2 W1-E): one portable spelling per key chord (src/commands/types.ts Shortcut).
//
// Shift and printed characters: a key that prints a character with no upper and lower case
// (+, ?, /, digits, punctuation) already carries Shift in the character itself, and whether a
// layout needs Shift for it differs by country ('+' is Shift+= on a US board and a plain key on a
// German one; digits need Shift on a French one). So Shift is dropped for those keys, on both the
// binding and the key press: 'Mod+Plus' is one shortcut on every layout. Letters keep Shift
// ('Shift+G' is not 'G'), and so do named keys ('Shift+Space', 'Shift+Tab'). Declaring Shift on a
// digit or punctuation key ('Shift+1', 'Mod+Shift+/') is refused at bind time (declaredShiftProblem):
// which character that press makes depends on the layout, so spell the character instead ('?').
// Plus is the one exception: 'Mod+Shift+Plus' is accepted and means 'Mod+Plus'.
import type { KeyChord, Shortcut } from '../types'

const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
const KEY_NAMES: Readonly<Record<string, string>> = { ' ': 'Space', '+': 'Plus', space: 'Space', plus: 'Plus', esc: 'Escape', del: 'Delete' }

function keyName(key: string): string {
  const named = KEY_NAMES[key] ?? KEY_NAMES[key.toLowerCase()]
  if (named) return named
  return key.length === 1 ? key.toUpperCase() : key
}

/** True for a key whose character already says whether Shift was down ('+', '?', '1'). */
function printsItsShift(key: string): boolean {
  if (key === 'Plus') return true
  return key.length === 1 && key !== ' ' && key.toUpperCase() === key.toLowerCase()
}

function join(mods: readonly string[], key: string): Shortcut {
  const kept = printsItsShift(key) ? mods.filter(m => m !== 'Shift') : mods
  return [...kept, key].join('+')
}

/** One portable spelling of a chord: modifiers in a fixed order, then the key (Shortcut). */
export function normalizeShortcut(shortcut: Shortcut): Shortcut {
  // a trailing '++' is the plus key ('Mod++' = 'Mod+Plus'); a lone '+' too
  const text = shortcut === '+' ? 'Plus' : shortcut.replace(/\+\+$/, '+Plus')
  const parts = text.split('+').map(p => p.trim()).filter(Boolean)
  const key = parts.pop() ?? ''
  const mods = MODIFIERS.filter(m => parts.some(p => p.toLowerCase() === m.toLowerCase()))
  return join(mods, keyName(key))
}

/** Why a declared spelling cannot be bound, or undefined when it can. */
export function declaredShiftProblem(shortcut: Shortcut): string | undefined {
  const text = shortcut === '+' ? 'Plus' : shortcut.replace(/\+\+$/, '+Plus')
  const parts = text.split('+').map(p => p.trim()).filter(Boolean)
  const key = keyName(parts.pop() ?? '')
  if (key === 'Plus' || !printsItsShift(key) || !parts.some(p => p.toLowerCase() === 'shift')) return undefined
  return `shortcut ${shortcut} puts Shift on a key whose character differs by keyboard layout; spell the character itself`
}

/** A shortcut the operator typed into command search, read the way the app shows it: Ctrl is Mod
 *  off macOS, Cmd (or Command) is Mod on macOS, Option is Alt. */
export function typedShortcut(text: string, isMac: boolean): Shortcut | undefined {
  const t = text.trim()
  if (!t) return undefined
  const words = t.replace(/\+\+$/, '+Plus').split('+').map(p => p.trim())
  const mapped = words.map((w, i) => {
    if (i === words.length - 1) return w
    const lower = w.toLowerCase()
    if (lower === 'cmd' || lower === 'command' || lower === '⌘') return isMac ? 'Mod' : 'Cmd'
    if (lower === 'ctrl' || lower === 'control') return isMac ? 'Ctrl' : 'Mod'
    if (lower === 'option' || lower === 'opt') return 'Alt'
    return w
  })
  // a modifier this platform does not have (Cmd off macOS) means the text is not a shortcut here
  if (mapped.slice(0, -1).some(m => !(MODIFIERS as readonly string[]).includes(m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()))) return undefined
  return normalizeShortcut(mapped.join('+'))
}

/** The shortcut a key press makes. On macOS Cmd is 'Mod' and the Control key is 'Ctrl'. */
export function chordToShortcut(chord: KeyChord, isMac: boolean): Shortcut {
  const mods: string[] = []
  if (isMac ? chord.metaKey : chord.ctrlKey) mods.push('Mod')
  if (isMac && chord.ctrlKey) mods.push('Ctrl')
  if (chord.altKey) mods.push('Alt')
  if (chord.shiftKey) mods.push('Shift')
  return join(mods, keyName(chord.key))
}

/** True when the press holds the platform's Mod key (Ctrl, or Cmd on macOS). */
export function hasMod(chord: KeyChord, isMac: boolean): boolean {
  return !!(isMac ? chord.metaKey : chord.ctrlKey)
}

/** The shortcut as the operator reads it: 'Ctrl+Shift+G', 'Cmd++'. Key names stay English in
 *  every language, like the printed keys. */
export function shortcutText(shortcut: Shortcut, isMac: boolean): string {
  return normalizeShortcut(shortcut).split('+').map(part => {
    if (part === 'Mod') return isMac ? 'Cmd' : 'Ctrl'
    if (part === 'Alt' && isMac) return 'Option'
    if (part === 'Plus') return '+'
    return part
  }).join('+')
}

/** Whether this computer is a Mac (Cmd is Mod). Reads the browser once; false outside one. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? '')
}
