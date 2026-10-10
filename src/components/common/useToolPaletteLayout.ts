// A tool palette's layout, per viewer (browser storage; a store that throws or
// comes back empty or garbled leaves the defaults): compact (icons only, packed
// tight, the name and what the tool does in each hover hint) and the groups
// folded. Nothing moves when a tool becomes usable or not: a group stays where it
// is, shown or folded, until the viewer folds it. The Form rail alone may fold
// Start-from once after an edit when it overflows, without saving a preference.
// `palette` keeps each palette's
// choices its own.

import { useState } from 'react'
import { readRegisteredToolPalettePreference, writeRegisteredToolPalettePreference } from '../../store/persistedKeys'

export function readPref(key: string): unknown {
  try { return readRegisteredToolPalettePreference(key) } catch { return undefined }
}
export function writePref(key: string, value: unknown): void {
  try { writeRegisteredToolPalettePreference(key, value) } catch { /* the layout still changes; it just is not remembered */ }
}

export interface ToolPaletteLayout {
  compact: boolean
  toggleCompact(): void
  isCollapsed(id: string): boolean
  toggleSection(id: string, collapsed?: boolean): void
}

export function useToolPaletteLayout(palette: string): ToolPaletteLayout {
  const compactKey = `liencam.${palette}.compact`, collapsedKey = `liencam.${palette}.collapsed`
  const [compact, setCompact] = useState<boolean>(() => readPref(compactKey) === true)
  const [collapsed, setCollapsed] = useState<string[]>(() => { const v = readPref(collapsedKey); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] })
  return {
    compact,
    toggleCompact: () => setCompact((c) => { writePref(compactKey, !c); return !c }),
    isCollapsed: (id) => collapsed.includes(id),
    // An explicit target lets a header toggle a transient fold into a saved choice.
    toggleSection: (id, folded) => setCollapsed((list) => { const collapse = folded ?? !list.includes(id); const next = collapse ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id); writePref(collapsedKey, next); return next }),
  }
}
