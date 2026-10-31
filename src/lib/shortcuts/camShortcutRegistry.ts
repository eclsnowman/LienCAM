// WO-3257: the three non-motion CAM shortcuts the operator can remap.
//
// Pure data and functions: no store, no DOM, no React. useGlobalShortcuts asks
// matchCamShortcut which action a key press means; Settings edits the bindings;
// Help, the printable map and the tooltip hints all read effectiveCamBindings.
// Jog, transport, sketch, history and delete keys are not in this registry.

export type CamShortcutId = 'computeOperationToolpath' | 'computeAllToolpaths' | 'openModal:new-operation'

/** One chord: a lowercase letter, optionally with Shift. */
export interface CamShortcutBinding {
  key: string
  shift: boolean
}

/** What uiPrefs stores. A missing entry inherits the default; null is unassigned. */
export interface CamShortcutOverrides {
  version: 1
  bindings: Partial<Record<CamShortcutId, CamShortcutBinding | null>>
}

export type EffectiveCamBindings = Record<CamShortcutId, CamShortcutBinding | null>

export const CAM_SHORTCUT_IDS: readonly CamShortcutId[] = [
  'computeOperationToolpath',
  'computeAllToolpaths',
  'openModal:new-operation',
]

export const DEFAULT_CAM_BINDINGS: Readonly<EffectiveCamBindings> = Object.freeze({
  computeOperationToolpath: Object.freeze({ key: 'g', shift: false }),
  computeAllToolpaths: Object.freeze({ key: 'g', shift: true }),
  'openModal:new-operation': Object.freeze({ key: 'n', shift: false }),
})

const LETTER = /^[a-z]$/

function isBinding(value: unknown): value is CamShortcutBinding {
  if (value === null || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  return typeof b.key === 'string' && LETTER.test(b.key) && typeof b.shift === 'boolean'
}

function sameChord(a: CamShortcutBinding, b: CamShortcutBinding): boolean {
  return a.key === b.key && a.shift === b.shift
}

function resolve(bindings: CamShortcutOverrides['bindings']): EffectiveCamBindings {
  const out = {} as EffectiveCamBindings
  for (const id of CAM_SHORTCUT_IDS) {
    const own = bindings[id]
    out[id] = own === undefined ? { ...DEFAULT_CAM_BINDINGS[id]! } : own === null ? null : { ...own }
  }
  return out
}

/** The first row (registry order) that already uses this chord, other than `except`. */
export function findCamShortcutConflict(
  effective: EffectiveCamBindings,
  except: CamShortcutId,
  chord: CamShortcutBinding,
): CamShortcutId | null {
  for (const id of CAM_SHORTCUT_IDS) {
    if (id === except) continue
    const other = effective[id]
    if (other !== null && sameChord(other, chord)) return id
  }
  return null
}

/** The stored blob if it is well formed and gives no chord to two rows; null when it is not. */
export function readCamShortcutOverrides(raw: unknown): CamShortcutOverrides | null {
  if (raw === null || typeof raw !== 'object') return null
  const blob = raw as Record<string, unknown>
  if (blob.version !== 1) return null
  const bindings = blob.bindings
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) return null
  const entries = Object.entries(bindings as Record<string, unknown>)
  for (const [id, value] of entries) {
    if (!CAM_SHORTCUT_IDS.includes(id as CamShortcutId)) return null
    if (value !== null && !isBinding(value)) return null
  }
  const overrides: CamShortcutOverrides = {
    version: 1,
    bindings: Object.fromEntries(entries.map(([id, value]) => [id, value === null ? null : { key: (value as CamShortcutBinding).key, shift: (value as CamShortcutBinding).shift }])),
  }
  const effective = resolve(overrides.bindings)
  for (const id of CAM_SHORTCUT_IDS) {
    const chord = effective[id]
    if (chord !== null && findCamShortcutConflict(effective, id, chord) !== null) return null
  }
  return overrides
}

/** The map in force: the stored overrides, or every default when they are absent or malformed. */
export function effectiveCamBindings(raw: unknown): EffectiveCamBindings {
  const overrides = readCamShortcutOverrides(raw)
  return resolve(overrides === null ? {} : overrides.bindings)
}

export interface CamShortcutKeyEvent {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  getModifierState?: (name: string) => boolean
}

function hasCommandModifier(e: CamShortcutKeyEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || e.getModifierState?.('AltGraph') === true
}

/** The chord a key press makes, or null when it is not a plain letter (Shift allowed). */
export function chordFromKeyEvent(e: CamShortcutKeyEvent): CamShortcutBinding | null {
  if (hasCommandModifier(e)) return null
  const key = e.key.toLowerCase()
  return e.key.length === 1 && LETTER.test(key) ? { key, shift: e.shiftKey } : null
}

/** Which action a key press means under the map in force. The event's key decides, never its
 *  physical code, so Caps Lock G is still G and a remapped letter follows the keyboard layout. */
export function matchCamShortcut(e: CamShortcutKeyEvent, raw: unknown): CamShortcutId | null {
  const chord = chordFromKeyEvent(e)
  if (chord === null) return null
  const effective = effectiveCamBindings(raw)
  return CAM_SHORTCUT_IDS.find((id) => {
    const own = effective[id]
    return own !== null && sameChord(own, chord)
  }) ?? null
}

/** "G", "Shift+G", or null when the row is unassigned. Letters stay English in every language. */
export function camBindingLabel(binding: CamShortcutBinding | null): string | null {
  if (binding === null) return null
  const letter = binding.key.toUpperCase()
  return binding.shift ? `Shift+${letter}` : letter
}

export type CamShortcutEdit =
  | { ok: true; overrides: CamShortcutOverrides }
  | { ok: false; conflictWith: CamShortcutId }

/** Change one row. `'default'` drops the override so the row inherits again; null unassigns it.
 *  A chord another row already uses (restoring included) is refused, naming that row. A malformed stored blob is
 *  replaced by a fresh one built from the defaults. */
export function editCamShortcut(
  raw: unknown,
  id: CamShortcutId,
  change: CamShortcutBinding | null | 'default',
): CamShortcutEdit {
  const base = readCamShortcutOverrides(raw)?.bindings ?? {}
  const bindings: CamShortcutOverrides['bindings'] = { ...base }
  if (change === 'default') {
    // The default chord may have been taken by another row since this one was remapped.
    const conflictWith = findCamShortcutConflict(resolve(base), id, DEFAULT_CAM_BINDINGS[id]!)
    if (conflictWith !== null) return { ok: false, conflictWith }
    delete bindings[id]
  } else if (change === null) {
    bindings[id] = null
  } else {
    const conflictWith = findCamShortcutConflict(resolve(base), id, change)
    if (conflictWith !== null) return { ok: false, conflictWith }
    bindings[id] = { key: change.key, shift: change.shift }
  }
  return { ok: true, overrides: { version: 1, bindings } }
}

/** Every row back to its default. */
export function restoreAllCamShortcuts(): CamShortcutOverrides {
  return { version: 1, bindings: {} }
}

/** The printable plain-text map: one line per action, "Action: key", then the scope line. */
export function camShortcutMapText(
  raw: unknown,
  words: { title: string; scope: string; unassigned: string; actions: Record<CamShortcutId, string> },
): string {
  const effective = effectiveCamBindings(raw)
  const lines = CAM_SHORTCUT_IDS.map((id) => `${words.actions[id]}: ${camBindingLabel(effective[id]) ?? words.unassigned}`)
  return [words.title, words.scope, '', ...lines, ''].join('\n')
}
