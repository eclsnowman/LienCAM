// WO-3308 (UI M2 W2-5b): the Control layout description, defined once. Which module sits in which
// column and place, whether it is folded, shown or turned off. The Control workspace lays its
// modules out from this and nothing else; only Arrange (the operator) changes it. Pure functions:
// no React, no store, so the Run layout (WO-3298) and the Arrange window read the same rules.
// Design: docs/design/control/CONTROL-LAYOUT.md sections 2.4 and 3.2 to 3.3.

export const CONTROL_COLUMNS = ['left', 'centre', 'right'] as const
export type ControlColumn = (typeof CONTROL_COLUMNS)[number]

/** Every Control module. The cycle log and the simulated part are off in the shipped layout. */
export const CONTROL_MODULE_IDS = [
  'machine', 'position', 'offsets', 'tool', 'program', 'console',
  'jog', 'overrides', 'spindle', 'macros', 'cycleLog', 'simulatedPart',
] as const
export type ControlModuleId = (typeof CONTROL_MODULE_IDS)[number]

/** Parts that hold motion authority or an alarm. They are listed in Arrange with a lock and are
 *  never moved, folded, hidden or turned off: the state chip lives in the machine bar and the Run
 *  section (E-STOP, Cycle start, Feed hold, Stop, step row) sits inside the Program module. */
export const LOCKED_PARTS = ['stateChip', 'runSection'] as const
export type LockedPartId = (typeof LOCKED_PARTS)[number]

/** Modules that can neither move, fold nor hide: the Program module carries the Run section. */
export const LOCKED_MODULES: readonly ControlModuleId[] = ['program']

export interface ModulePlacement {
  readonly id: ControlModuleId
  readonly column: ControlColumn
  readonly folded: boolean
  readonly shown: boolean
}

/** A named set of placements. Order inside a column is the order of `placements`. */
export interface ControlLayout {
  readonly id: string
  readonly name: string
  readonly placements: readonly ModulePlacement[]
}

export const DEFAULT_LAYOUT_ID = 'run'

function place(id: ControlModuleId, column: ControlColumn, shown = true, folded = false): ModulePlacement {
  return { id, column, folded, shown }
}

/** The shipped Run layout: today's three columns and places, Jog at the top of the right column. */
export const DEFAULT_RUN_LAYOUT: ControlLayout = Object.freeze({
  id: DEFAULT_LAYOUT_ID,
  name: 'Run',
  placements: Object.freeze([
    place('machine', 'left'), place('position', 'left'), place('offsets', 'left'), place('tool', 'left'),
    place('program', 'centre'), place('console', 'centre'),
    place('jog', 'right'), place('overrides', 'right'), place('spindle', 'right'), place('macros', 'right'),
    place('cycleLog', 'right', false), place('simulatedPart', 'right', false),
  ]),
})

export function isModuleId(value: unknown): value is ControlModuleId {
  return typeof value === 'string' && (CONTROL_MODULE_IDS as readonly string[]).includes(value)
}

export function isColumn(value: unknown): value is ControlColumn {
  return typeof value === 'string' && (CONTROL_COLUMNS as readonly string[]).includes(value)
}

export function isLocked(id: ControlModuleId): boolean {
  return LOCKED_MODULES.includes(id)
}

function shippedPlacement(id: ControlModuleId): ModulePlacement {
  return DEFAULT_RUN_LAYOUT.placements.find(p => p.id === id) as ModulePlacement
}

/** Keep every locked module at its shipped column and its shipped place among that column's modules,
 *  whatever moved around it: Program holds the Run section, so nothing is ever put ahead of it. */
function pinLocked(placements: readonly ModulePlacement[]): readonly ModulePlacement[] {
  let out = placements
  for (const id of LOCKED_MODULES) {
    const home = shippedPlacement(id)
    const index = DEFAULT_RUN_LAYOUT.placements.filter(p => p.column === home.column).findIndex(p => p.id === id)
    const without = out.filter(p => p.id !== id)
    const column = without.filter(p => p.column === home.column)
    const at = Math.min(index, column.length)
    const before = column[at]
    const insertAt = before ? without.indexOf(before) : (() => {
      const last = column[column.length - 1]
      return last ? without.indexOf(last) + 1 : without.length
    })()
    out = [...without.slice(0, insertAt), home, ...without.slice(insertAt)]
  }
  return out
}

/** Make any value a valid layout: unknown or repeated modules are dropped, a module the value
 *  lacks is added where the Run layout puts it, and a locked module is put back in its shipped
 *  place, shown and unfolded. A damaged saved value can therefore only ever fall back. */
export function repairLayout(value: unknown, fallbackId = DEFAULT_LAYOUT_ID, fallbackName = 'Layout'): ControlLayout {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName
  const seen = new Set<ControlModuleId>()
  const out: ModulePlacement[] = []
  const list = Array.isArray(raw.placements) ? raw.placements : []
  for (const item of list) {
    const p = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    if (!isModuleId(p.id) || seen.has(p.id)) continue
    seen.add(p.id)
    if (isLocked(p.id)) { out.push(shippedPlacement(p.id)); continue }
    out.push({
      id: p.id,
      column: isColumn(p.column) ? p.column : shippedPlacement(p.id).column,
      folded: p.folded === true,
      shown: p.shown !== false,
    })
  }
  for (const missing of DEFAULT_RUN_LAYOUT.placements) if (!seen.has(missing.id)) out.push(missing)
  return { id, name, placements: pinLocked(out) }
}

/** The modules of one column in order. A hidden module is not in the result unless asked for. */
export function columnModules(layout: ControlLayout, column: ControlColumn, includeHidden = false): readonly ModulePlacement[] {
  return layout.placements.filter(p => p.column === column && (includeHidden || p.shown))
}

export function placementOf(layout: ControlLayout, id: ControlModuleId): ModulePlacement {
  return layout.placements.find(p => p.id === id) ?? shippedPlacement(id)
}

/** Move a module to a column at an index among that column's modules (hidden ones count, so the
 *  order survives showing it again). A locked module does not move. */
export function moveModule(layout: ControlLayout, id: ControlModuleId, column: ControlColumn, index: number): ControlLayout {
  if (isLocked(id)) return layout
  const moving = placementOf(layout, id)
  const rest = layout.placements.filter(p => p.id !== id)
  const target = rest.filter(p => p.column === column)
  const at = Math.max(0, Math.min(Math.trunc(index), target.length))
  const before = target[at]
  const next: ModulePlacement = { ...moving, column }
  const insertAt = before ? rest.indexOf(before) : (() => {
    const last = target[target.length - 1]
    return last ? rest.indexOf(last) + 1 : rest.length
  })()
  return { ...layout, placements: pinLocked([...rest.slice(0, insertAt), next, ...rest.slice(insertAt)]) }
}

/** Move a module one place up or down inside its column (the keyboard route of Arrange). */
export function nudgeModule(layout: ControlLayout, id: ControlModuleId, delta: -1 | 1): ControlLayout {
  if (isLocked(id)) return layout
  const p = placementOf(layout, id)
  const col = columnModules(layout, p.column, true)
  const i = col.findIndex(m => m.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= col.length) return layout
  return moveModule(layout, id, p.column, j)
}

function patch(layout: ControlLayout, id: ControlModuleId, change: Partial<ModulePlacement>): ControlLayout {
  if (isLocked(id)) return layout
  return { ...layout, placements: layout.placements.map(p => (p.id === id ? { ...p, ...change } : p)) }
}

/** Turn a module off or on again. Off is a display choice: the module keeps its place and its
 *  behaviour that is not a button (keyboard jog, alarms, macros by M-code). */
export function setShown(layout: ControlLayout, id: ControlModuleId, shown: boolean): ControlLayout {
  return patch(layout, id, { shown })
}

export function setFolded(layout: ControlLayout, id: ControlModuleId, folded: boolean): ControlLayout {
  return patch(layout, id, { folded })
}

/** True when two layouts place every module identically (names and ids aside). */
export function sameArrangement(a: ControlLayout, b: ControlLayout): boolean {
  return JSON.stringify(a.placements) === JSON.stringify(b.placements)
}
