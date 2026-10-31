// WO-3303: whether the Machine window is open and which page it shows. One small external store so
// the machine pill, the commands (`machine.open`, `machine.openDefinition`) and Control's definition
// door all open the same window without sharing a component tree.
import { useSyncExternalStore } from 'react'

/** The window's pages: the library, then the seven definition areas (DEF_GROUPS keys). */
export const MACHINE_PAGES = ['library', 'overview', 'machine', 'spindle', 'outputs', 'probing', 'controller', 'allSettings'] as const
export type MachinePage = (typeof MACHINE_PAGES)[number]
export type DefinitionArea = Exclude<MachinePage, 'library'>

export function isMachinePage(value: unknown): value is MachinePage {
  return typeof value === 'string' && (MACHINE_PAGES as readonly string[]).includes(value)
}

export interface MachineWindowState {
  readonly open: boolean
  readonly page: MachinePage
  /** The library record the window shows; null = the machine the project uses. */
  readonly machineId: string | null
}

let state: MachineWindowState = { open: false, page: 'library', machineId: null }
const listeners = new Set<() => void>()

function set(next: MachineWindowState): void {
  state = next
  for (const l of [...listeners]) l()
}

export function getMachineWindowState(): MachineWindowState { return state }
export function subscribeMachineWindow(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useMachineWindowState(): MachineWindowState {
  return useSyncExternalStore(subscribeMachineWindow, getMachineWindowState, getMachineWindowState)
}

/** `machine.open`: the window on its library page. */
export function openMachineWindow(): void { set({ open: true, page: 'library', machineId: null }) }
/** `machine.openDefinition`: the window on one definition area (Overview when none is named). */
export function openMachineDefinition(area: DefinitionArea = 'overview', machineId: string | null = null): void {
  set({ open: true, page: area, machineId })
}
export function closeMachineWindow(): void { set({ open: false, page: 'library', machineId: null }) }
export function setMachinePage(page: MachinePage): void { set({ ...state, page }) }
export function setMachineWindowMachine(machineId: string | null): void { set({ ...state, machineId }) }
