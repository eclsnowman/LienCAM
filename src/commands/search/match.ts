// WO-3282 (UI M2 W1-E): how command search ranks a command against what the operator typed.
// Lower is better; null is no match. Case and accents never matter ("Fräsen" is found by "frasen").

/** Lower case, accents off, spaces collapsed. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

const words = (text: string) => text.split(/[\s\-_./()]+/).filter(Boolean)

export interface MatchTarget {
  /** The label in the operator's language. */
  readonly label: string
  readonly id: string
  /** The bound shortcut, in its portable spelling ('Mod+Shift+P'), when there is one. */
  readonly shortcut?: string
  /** The same shortcut as the operator reads it on this computer ('Ctrl+Shift+P'). */
  readonly shortcutText?: string
  /** The query read as a shortcut spelling, when it reads as one. */
  readonly queryShortcut?: string
}

/** 0 whole label or exact shortcut, 1 label starts with it, 2 every typed word starts a label
 *  word, 3 label contains it, 4 the shortcut as shown contains it, 5 the id contains it. */
export function matchScore(query: string, target: MatchTarget): number | null {
  const q = fold(query)
  if (!q) return null
  const label = fold(target.label)
  if (label === q) return 0
  if (target.shortcut !== undefined && target.queryShortcut === target.shortcut) return 0
  if (label.startsWith(q)) return 1
  const labelWords = words(label)
  if (words(q).every(w => labelWords.some(l => l.startsWith(w)))) return 2
  if (label.includes(q)) return 3
  if (target.shortcutText !== undefined && q.includes('+') && fold(target.shortcutText).includes(q)) return 4
  if (fold(target.id).includes(q)) return 5
  return null
}
