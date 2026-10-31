// WO-3308 (UI M2 W2-5b): the Control layouts store. Per machine: the layout on screen, the name
// it was picked or saved under, and the operator's saved layouts. A separate zustand store on a
// key of its own (the shipped preferences file and store/index.ts belong to other orders); a
// damaged or missing value falls back to the shipped Run layout. Arrange mode itself is session
// state and never persists: Control always opens with nothing movable.
import { create } from 'zustand'
import {
  DEFAULT_LAYOUT_ID, DEFAULT_RUN_LAYOUT, repairLayout,
  type ControlLayout,
} from '../../ui2/control-arrange/layout'
import { PERSISTED_USER_DATA_REGISTRY, readRegisteredLocalData, writeRegisteredLocalData } from '../persistedKeys'

export const CONTROL_LAYOUTS_KEY = PERSISTED_USER_DATA_REGISTRY.controlLayouts.key
export const CONTROL_LAYOUTS_VERSION = 1
export const LAYOUT_NAME_MAX = 40
/** Machines that have no id of their own (a fresh install, the simulator) share this record. */
export const NO_MACHINE_KEY = 'default'

export interface MachineLayouts {
  /** The saved layout the screen started from, or the shipped Run layout. */
  readonly activeId: string
  /** What the screen shows now: the active layout plus any change made in Arrange. */
  readonly current: ControlLayout
  readonly saved: readonly ControlLayout[]
}

export function emptyMachineLayouts(): MachineLayouts {
  return { activeId: DEFAULT_LAYOUT_ID, current: DEFAULT_RUN_LAYOUT, saved: [] }
}

const EMPTY_MACHINE = emptyMachineLayouts()

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, LAYOUT_NAME_MAX)
}

/** A name nobody else uses: a taken one gets " 2", " 3" and so on. Saving is never refused. */
export function uniqueName(name: string, taken: readonly string[]): string {
  const base = cleanName(name) || 'Layout'
  const used = new Set([...taken, DEFAULT_RUN_LAYOUT.name].map(n => n.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, LAYOUT_NAME_MAX - String(n).length - 1)} ${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

function newId(saved: readonly ControlLayout[]): string {
  let n = saved.length + 1
  while (saved.some(l => l.id === `layout-${n}`)) n++
  return `layout-${n}`
}

function repairMachine(value: unknown): MachineLayouts {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const saved: ControlLayout[] = []
  for (const item of Array.isArray(raw.saved) ? raw.saved : []) {
    const l = repairLayout(item, newId(saved), 'Layout')
    if (l.id !== DEFAULT_LAYOUT_ID && !saved.some(s => s.id === l.id)) saved.push(l)
  }
  const current = repairLayout(raw.current, DEFAULT_LAYOUT_ID, DEFAULT_RUN_LAYOUT.name)
  const wanted = typeof raw.activeId === 'string' ? raw.activeId : DEFAULT_LAYOUT_ID
  const activeId = wanted === DEFAULT_LAYOUT_ID || saved.some(s => s.id === wanted) ? wanted : DEFAULT_LAYOUT_ID
  return { activeId, current: { ...current, id: activeId }, saved }
}

export function parseStored(text: string | null): Readonly<Record<string, MachineLayouts>> {
  if (!text) return {}
  try {
    const raw = JSON.parse(text) as { version?: unknown; machines?: unknown }
    if (raw?.version !== CONTROL_LAYOUTS_VERSION || typeof raw.machines !== 'object' || raw.machines === null) return {}
    const out: Record<string, MachineLayouts> = {}
    for (const [key, value] of Object.entries(raw.machines)) out[key] = repairMachine(value)
    return out
  } catch { return {} }
}

function readStored(): Readonly<Record<string, MachineLayouts>> {
  try { return parseStored(readRegisteredLocalData('controlLayouts')) } catch { return {} }
}

function writeStored(machines: Readonly<Record<string, MachineLayouts>>): void {
  try {
    writeRegisteredLocalData('controlLayouts', JSON.stringify({ version: CONTROL_LAYOUTS_VERSION, machines }))
  } catch { /* private window: this load only */ }
}

export interface ControlLayoutsState {
  readonly machines: Readonly<Record<string, MachineLayouts>>
  /** Arrange mode is on. Session state; modules move only while this is true. */
  readonly arranging: boolean
  setArranging(on: boolean): void
  /** Replace the layout on screen (every Arrange edit goes through here). */
  setCurrent(machine: string, layout: ControlLayout): void
  /** Save the layout on screen under a name and make it the active one. Returns the saved layout. */
  saveAs(machine: string, name: string): ControlLayout
  /** Write the layout on screen back to the saved layout it started from (no-op on the Run layout). */
  saveActive(machine: string): void
  pick(machine: string, id: string): void
  rename(machine: string, id: string, name: string): void
  remove(machine: string, id: string): void
  /** Return to the shipped Run layout. */
  resetToDefault(machine: string): void
}

export function machineKey(machineId: string | null | undefined): string {
  return machineId ? machineId : NO_MACHINE_KEY
}

export const useControlLayouts = create<ControlLayoutsState>()((set, get) => {
  const update = (machine: string, change: (m: MachineLayouts) => MachineLayouts) => {
    const key = machineKey(machine)
    const machines = { ...get().machines, [key]: change(get().machines[key] ?? emptyMachineLayouts()) }
    writeStored(machines)
    set({ machines })
  }
  return {
    machines: readStored(),
    arranging: false,
    setArranging: on => set({ arranging: on }),
    setCurrent: (machine, layout) => update(machine, m => ({ ...m, current: repairLayout(layout, m.activeId, m.current.name) })),
    saveAs: (machine, name) => {
      let made: ControlLayout = DEFAULT_RUN_LAYOUT
      update(machine, m => {
        const label = uniqueName(name, m.saved.map(s => s.name))
        made = { ...m.current, id: newId(m.saved), name: label }
        return { activeId: made.id, current: made, saved: [...m.saved, made] }
      })
      return made
    },
    saveActive: machine => update(machine, m => {
      if (m.activeId === DEFAULT_LAYOUT_ID) return m
      return { ...m, saved: m.saved.map(s => (s.id === m.activeId ? { ...m.current, id: s.id, name: s.name } : s)) }
    }),
    pick: (machine, id) => update(machine, m => {
      if (id === DEFAULT_LAYOUT_ID) return { ...m, activeId: id, current: DEFAULT_RUN_LAYOUT }
      const found = m.saved.find(s => s.id === id)
      return found ? { ...m, activeId: id, current: found } : m
    }),
    rename: (machine, id, name) => update(machine, m => {
      const others = m.saved.filter(s => s.id !== id).map(s => s.name)
      const label = uniqueName(name, others)
      const saved = m.saved.map(s => (s.id === id ? { ...s, name: label } : s))
      return { ...m, saved, current: m.activeId === id ? { ...m.current, name: label } : m.current }
    }),
    remove: (machine, id) => update(machine, m => {
      const saved = m.saved.filter(s => s.id !== id)
      return m.activeId === id ? { activeId: DEFAULT_LAYOUT_ID, current: DEFAULT_RUN_LAYOUT, saved } : { ...m, saved }
    }),
    resetToDefault: machine => update(machine, m => ({ ...m, activeId: DEFAULT_LAYOUT_ID, current: DEFAULT_RUN_LAYOUT })),
  }
})

/** The record of one machine (the shipped Run layout when it has none yet). */
export function selectMachineLayouts(state: ControlLayoutsState, machine: string): MachineLayouts {
  return state.machines[machineKey(machine)] ?? EMPTY_MACHINE
}
