// machineActionsStore - persisted per-MACHINE action wiring (MACHINE-CONTROL
// stage 9). Separate persisted zustand store (uiPrefs pattern), keyed by the
// machine id so each physical machine keeps its own wiring across projects
// and reloads. Deliberately NOT in the project schema: this describes how a
// MACHINE is wired, not what a project cuts.

import { create } from 'zustand'
import { persistRegistered } from './persistedKeys'
import { controlMachine, projectStoreDurability, registerLegacyToolChangeParkIdReader, useCamStore } from './index'
import type { MachineConfig, MachineMacro } from '../types'
import { saveFile } from '../lib/saveFile'
import {
  EMPTY_ACTION_CONFIG,
  machineActionOverride,
  type BuiltinActionId,
  type CustomAction,
  type MachineActionConfig,
  type ParkPosition,
} from '../lib/machine/machineActions'

interface MachineActionsState {
  byMachine: Record<string, MachineActionConfig>
  macroArrangementByMachine: Record<string, MacroArrangement>

  configFor: (machineId: string) => MachineActionConfig
  setOverride: (machineId: string, action: BuiltinActionId, lines: string[]) => void
  clearOverride: (machineId: string, action: BuiltinActionId) => void
  addCustom: (machineId: string, action: CustomAction) => void
  updateCustom: (machineId: string, action: CustomAction) => void
  removeCustom: (machineId: string, actionId: string) => void
  moveCustom: (machineId: string, actionId: string, direction: -1 | 1) => void
  setCustomVisible: (machineId: string, actionId: string, visible: boolean) => void
  addPark: (machineId: string, park: ParkPosition) => void
  updatePark: (machineId: string, park: ParkPosition) => void
  removePark: (machineId: string, parkId: string) => void
}

export interface MacroArrangement {
  order: string[]
  hidden: string[]
}

/** Reconcile persisted arrangement metadata with the live macro records.
 *  Old records have no metadata, new macros append in insertion order, and
 *  deleted IDs cannot leave stale order/visibility entries behind. */
export function normalizeMacroArrangement(
  custom: readonly CustomAction[],
  arrangement?: MacroArrangement,
): MacroArrangement {
  const validIds = new Set(custom.map((action) => action.id))
  const orderedIds: string[] = []
  const seen = new Set<string>()
  for (const id of arrangement?.order ?? []) {
    if (validIds.has(id) && !seen.has(id)) {
      orderedIds.push(id)
      seen.add(id)
    }
  }
  for (const action of custom) {
    if (!seen.has(action.id)) {
      orderedIds.push(action.id)
      seen.add(action.id)
    }
  }

  const hidden: string[] = []
  const hiddenSeen = new Set<string>()
  for (const id of arrangement?.hidden ?? []) {
    if (validIds.has(id) && !hiddenSeen.has(id)) {
      hidden.push(id)
      hiddenSeen.add(id)
    }
  }
  return { order: orderedIds, hidden }
}

export function arrangeCustomActions(
  custom: readonly CustomAction[],
  arrangement?: MacroArrangement,
  visibleOnly = false,
): CustomAction[] {
  const normalized = normalizeMacroArrangement(custom, arrangement)
  const byId = new Map(custom.map((action) => [action.id, action]))
  const hidden = new Set(normalized.hidden)
  return normalized.order.flatMap((id) => {
    const action = byId.get(id)
    return action && (!visibleOnly || !hidden.has(id)) ? [action] : []
  })
}

function mutate(
  byMachine: Record<string, MachineActionConfig>,
  machineId: string,
  fn: (cfg: MachineActionConfig) => MachineActionConfig,
): Record<string, MachineActionConfig> {
  const current = byMachine[machineId] ?? EMPTY_ACTION_CONFIG
  return { ...byMachine, [machineId]: fn(current) }
}

/** The record this machine id actually names - library entry first, the
 *  project's own machine as the fallback. `null` names no real machine (a
 *  bare test id). Mirrors `machineToolTableStore.machineRecordById`. */
function machineRecordById(machineId: string): MachineConfig | null {
  const cam = useCamStore.getState()
  const inLibrary = cam.machineLibrary.find((m) => m.id === machineId)
  if (inLibrary) return inLibrary
  return cam.project.machine.id === machineId ? cam.project.machine : null
}

/**
 * WO-1676: THE M-CODE OVERRIDES MOVED ONTO THE DEFINITION. Write the record
 * when this machine id names one - the `useCamStore` subscription below then
 * refreshes `byMachine[id].overrides` from it - or the local cache only when
 * it does not. Every other field of `MachineActionConfig` (custom actions,
 * legacy parks, the tool-change park id) is untouched: this WO moves
 * `overrides` alone, so only that key is ever read off or written onto the
 * record.
 */
function writeActionOverride(
  set: (fn: (s: MachineActionsState) => Partial<MachineActionsState>) => void,
  machineId: string,
  overrides: Partial<Record<BuiltinActionId, string[]>>,
): void {
  const record = machineRecordById(machineId)
  if (record) {
    const cam = useCamStore.getState()
    const next = { ...record, actionOverrides: overrides }
    if (cam.machineLibrary.some((m) => m.id === machineId)) cam.updateMachineInLibrary(machineId, next)
    if (cam.project.machine.id === machineId) cam.setProjectMachine(next)
    return
  }
  set((s) => ({ byMachine: mutate(s.byMachine, machineId, (cfg) => ({ ...cfg, overrides })) }))
}

export const useMachineActions = create<MachineActionsState>()(
  persistRegistered('machineActions',
    (set, get) => ({
      byMachine: {},
      macroArrangementByMachine: {},

      configFor: (machineId) => get().byMachine[machineId] ?? EMPTY_ACTION_CONFIG,

      setOverride: (machineId, action, lines) => {
        const overrides = { ...(machineActionOverride(machineRecordById(machineId)) ?? get().byMachine[machineId]?.overrides ?? {}) }
        overrides[action] = lines
        writeActionOverride(set, machineId, overrides)
      },

      clearOverride: (machineId, action) => {
        const overrides = { ...(machineActionOverride(machineRecordById(machineId)) ?? get().byMachine[machineId]?.overrides ?? {}) }
        delete overrides[action]
        writeActionOverride(set, machineId, overrides)
      },

      addCustom: (machineId, action) =>
        set((s) => ({
          byMachine: mutate(s.byMachine, machineId, (cfg) => ({
            ...cfg,
            custom: [...cfg.custom, action],
          })),
        })),

      updateCustom: (machineId, action) =>
        set((s) => ({
          byMachine: mutate(s.byMachine, machineId, (cfg) => ({
            ...cfg,
            custom: cfg.custom.map((a) => (a.id === action.id ? action : a)),
          })),
        })),

      removeCustom: (machineId, actionId) =>
        set((s) => {
          const custom = (s.byMachine[machineId] ?? EMPTY_ACTION_CONFIG).custom
            .filter((a) => a.id !== actionId)
          return {
            byMachine: mutate(s.byMachine, machineId, (cfg) => ({ ...cfg, custom })),
            macroArrangementByMachine: {
              ...s.macroArrangementByMachine,
              [machineId]: normalizeMacroArrangement(
                custom,
                s.macroArrangementByMachine[machineId],
              ),
            },
          }
        }),

      moveCustom: (machineId, actionId, direction) =>
        set((s) => {
          const custom = (s.byMachine[machineId] ?? EMPTY_ACTION_CONFIG).custom
          const arrangement = normalizeMacroArrangement(
            custom,
            s.macroArrangementByMachine[machineId],
          )
          const index = arrangement.order.indexOf(actionId)
          const target = index + direction
          if (index < 0 || target < 0 || target >= arrangement.order.length) return s
          const order = [...arrangement.order]
          const displaced = order[target]
          order[target] = order[index]
          order[index] = displaced
          return {
            macroArrangementByMachine: {
              ...s.macroArrangementByMachine,
              [machineId]: { ...arrangement, order },
            },
          }
        }),

      setCustomVisible: (machineId, actionId, visible) =>
        set((s) => {
          const custom = (s.byMachine[machineId] ?? EMPTY_ACTION_CONFIG).custom
          const arrangement = normalizeMacroArrangement(
            custom,
            s.macroArrangementByMachine[machineId],
          )
          if (!arrangement.order.includes(actionId)) return s
          const hidden = new Set(arrangement.hidden)
          if (visible) hidden.delete(actionId)
          else hidden.add(actionId)
          return {
            macroArrangementByMachine: {
              ...s.macroArrangementByMachine,
              [machineId]: { ...arrangement, hidden: [...hidden] },
            },
          }
        }),

      // Parks are optional on configs persisted before stage 11 - every
      // mutator defaults them rather than trusting the stored shape.
      addPark: (machineId, park) =>
        set((s) => ({
          byMachine: mutate(s.byMachine, machineId, (cfg) => ({
            ...cfg,
            parks: [...(cfg.parks ?? []), park],
          })),
        })),

      updatePark: (machineId, park) =>
        set((s) => ({
          byMachine: mutate(s.byMachine, machineId, (cfg) => ({
            ...cfg,
            parks: (cfg.parks ?? []).map((p) => (p.id === park.id ? park : p)),
          })),
        })),

      removePark: (machineId, parkId) =>
        set((s) => ({
          byMachine: mutate(s.byMachine, machineId, (cfg) => ({
            ...cfg,
            parks: (cfg.parks ?? []).filter((p) => p.id !== parkId),
          })),
        })),
    }),
    { version: 1 },
  ),
)

// WO-1681 fix round 2: hand `store/index.ts` a reader for the field above
// instead of it importing this module back (that would be a load-order
// cycle - see `registerLegacyToolChangeParkIdReader`'s own comment). Runs
// once, after `useMachineActions` exists, so `adoptMachineDocument` can bake
// a still-persisted pre-1681 designation onto the macro it converts to.
registerLegacyToolChangeParkIdReader((machineId) => useMachineActions.getState().byMachine[machineId]?.toolChangeParkId)

/**
 * THE RECORD PARKS AND SAFE Z ARE READ FROM (WO-1670): the active machine's
 * own saved record, live - the same carrier G30 reads - so a park edited or
 * imported while connected is the park the next press goes to. Parks are the
 * app's own data (nothing is applied to the board), so the connection's
 * pinned snapshot is not their authority.
 */
export function parkCarrierMachine(state: Parameters<typeof controlMachine>[0]): MachineConfig {
  const active = controlMachine(state)
  return state.machineLibrary.find((machine) => machine.id === active.id)
    ?? (state.project.machine.id === active.id ? state.project.machine : active)
}

/** Write a machine's parks / safe Z back to its record: the library entry and,
 *  when it is the project's machine, the project's copy - the path G30.1
 *  writes, so `parkCarrierMachine` reads the edit on the next press. */
export function saveParkMachineRecord(next: MachineConfig): void {
  const cam = useCamStore.getState()
  if (cam.machineLibrary.some((machine) => machine.id === next.id)) {
    cam.updateMachineInLibrary(next.id, next)
  }
  if (cam.project.machine.id === next.id) cam.setProjectMachine(next)
}

export type MacroExportFormat = 'json' | 'txt'

/** Export data only: never run the sandbox or resolve machine-dependent values.
 *  Text preserves the source, including blank lines and line endings. */
export function exportMachineMacro(macro: MachineMacro, format: MacroExportFormat): Promise<string | null> {
  const safeName = macro.name.replace(/[<>:"/\\|?*]/g, '_').split('')
    .map((character) => character.charCodeAt(0) <= 0x1f ? '_' : character).join('')
  const name = safeName.trim().replace(/[. ]+$/, '').slice(0, 120) || 'unnamed'
  const stem = `macro-${name}`
  if (format === 'txt') return saveFile(`${stem}.txt`, macro.body, 'text/plain;charset=utf-8')
  const document = { format: 'liencam-macro', version: 1, macro }
  return saveFile(`${stem}.json`, `${JSON.stringify(document, null, 2)}\n`, 'application/json')
}

/** Every machine this session knows about - the library plus the project's
 *  own machine when it is not already in it. Mirrors
 *  `machineToolTableStore.knownMachines`. */
function knownActionMachines(cam: { machineLibrary: MachineConfig[]; project: { machine: MachineConfig } }): MachineConfig[] {
  const all = cam.machineLibrary
  return all.some((m) => m.id === cam.project.machine.id) ? all : [...all, cam.project.machine]
}

/**
 * KEEP `overrides` IN STEP WITH THE DEFINITION (WO-1676). Non-owned Control
 * surfaces (`MachineActionsModal`) read `byMachine[id]` as plain state, so
 * the cache has to already hold what the definition says. Every other key on
 * `MachineActionConfig` is left alone - this WO moved `overrides` only.
 */
function syncActionOverridesFromDefinitions(): void {
  // Before an async (OPFS) boot hydrates, the store holds only the starter
  // machine; syncing it would save a phantom record (restoreBundle red, 10-09).
  if (!useCamStore.persist.hasHydrated()) return
  const cam = useCamStore.getState()
  const machines = knownActionMachines(cam)
  useMachineActions.setState((s) => {
    let byMachine = s.byMachine
    for (const m of machines) {
      const stated = machineActionOverride(m)
      const current = byMachine[m.id]
      // A record stating no override is not yet authoritative - keep whatever
      // the cache already holds (an override set before this machine had a
      // record at all must not be erased the moment it gets one; a mutator
      // that finds no record falls back to this same cache).
      if (stated === undefined) {
        if (current) continue
        byMachine = byMachine === s.byMachine ? { ...byMachine } : byMachine
        byMachine[m.id] = { ...EMPTY_ACTION_CONFIG }
        continue
      }
      if (current?.overrides === stated) continue
      if (byMachine === s.byMachine) byMachine = { ...byMachine }
      byMachine[m.id] = { ...(current ?? EMPTY_ACTION_CONFIG), overrides: stated }
    }
    return { byMachine }
  })
}

/** WO-1707: a pre-1707 custom button, as the macro it now is - same id, its
 *  lines sent as ONE `lines(...)` call (the macro API's door onto
 *  `runMachineAction`, the exact path the button always took, so a geometry
 *  controller still stages consecutive moves as one program), its colour,
 *  confirm-first flag and panel visibility carried onto the one macro model. */
export function customActionToMacro(action: CustomAction, hidden = false): MachineMacro {
  const args = action.lines.map((line) => JSON.stringify(line))
  const body = args.length <= 1 ? `lines(${args.join('')})` : `lines(\n  ${args.join(',\n  ')}\n)`
  return {
    id: action.id,
    name: action.label,
    body,
    color: action.color,
    ...(action.confirm ? { confirm: true as const } : {}),
    ...(hidden ? { hidden: true as const } : {}),
  }
}

let movingCustomButtons = false

/** Per machine: the older buttons already on its record (written there by this
 *  session's move, or found there), whose older copy is deleted only once the
 *  record write is known to be kept by durable storage. A button in here is
 *  never written onto the record a second time this session, so a moved
 *  button the operator deletes before that confirmation does not come back. */
const movedAwaitingDurableRecord = new Map<string, Set<string>>()

/**
 * WO-1707: THE ONE-TIME MOVE of the older custom buttons onto the machine
 * record, in two phases so a button is never in neither durable store.
 *
 * It runs only AFTER the project store has hydrated. Before that the records
 * in memory are the defaults (a starter machine) that hydration replaces, and
 * on an OPFS boot every project-store write is dropped by the initial-hydration
 * barrier - a move then would write the record into nothing and clear the
 * older list (plain localStorage) for real.
 *
 * Phase 1 - for every machine with a record, any button still in
 * `byMachine[id].custom` is written onto that record's `macros` (in the order
 * the operator arranged them, ahead of the record's own macros - the WO-1681
 * park-fold convention; a hidden button comes across hidden), saved through
 * the same path the macro editor saves through. The panel shows it from here
 * on (it reads only the record). The older list is NOT touched.
 *
 * Phase 2 - once the project store reports every write so far kept by durable
 * storage (`projectStoreDurability.writesCommitted()`), the older copy of each
 * button the record now carries is deleted, with its arrangement entry. When
 * that never becomes true (the durable read was unreadable, so writes are
 * dropped for the whole session; or a write failed) the older list stays
 * intact and durable, and the next session that can write moves it for real.
 * Idempotent - a button whose id the record already carries is not added
 * twice (it goes straight to phase 2), a machine with no custom buttons is
 * never touched, and a custom list whose machine has no record (yet) waits.
 */
function moveCustomButtonsOntoRecords(): void {
  if (movingCustomButtons) return
  if (!useCamStore.persist.hasHydrated()) return
  movingCustomButtons = true
  try {
    const cam = useCamStore.getState()
    for (const m of knownActionMachines(cam)) {
      const state = useMachineActions.getState()
      const custom = state.byMachine[m.id]?.custom ?? []
      if (custom.length === 0) continue
      const record = machineRecordById(m.id)
      if (!record) continue
      const awaiting = movedAwaitingDurableRecord.get(m.id) ?? new Set<string>()
      const arrangement = normalizeMacroArrangement(custom, state.macroArrangementByMachine[m.id])
      const hidden = new Set(arrangement.hidden)
      const own = record.macros ?? []
      const ownIds = new Set(own.map((macro) => macro.id))
      const moved = arrangeCustomActions(custom, arrangement)
        .filter((action) => !ownIds.has(action.id) && !awaiting.has(action.id))
        .map((action) => customActionToMacro(action, hidden.has(action.id)))
      if (moved.length > 0) saveParkMachineRecord({ ...record, macros: [...moved, ...own] })
      for (const action of custom) awaiting.add(action.id)
      movedAwaitingDurableRecord.set(m.id, awaiting)
    }
  } finally {
    movingCustomButtons = false
  }
  if (movedAwaitingDurableRecord.size > 0) deleteOlderCopiesOnceDurable()
}

/** Which awaiting older buttons each machine's record carries right now. */
function olderCopiesOnRecords(): Map<string, Set<string>> {
  const carried = new Map<string, Set<string>>()
  for (const [machineId, awaiting] of movedAwaitingDurableRecord) {
    const onRecord = new Set((machineRecordById(machineId)?.macros ?? []).map((macro) => macro.id))
    const ids = new Set([...awaiting].filter((id) => onRecord.has(id)))
    if (ids.size > 0) carried.set(machineId, ids)
  }
  return carried
}

/** Phase 2: delete the older copy of each button in `eligible` that the record
 *  STILL carries. A button no longer on the record keeps its older copy - it
 *  errs on keeping a button, never on losing one. */
function deleteOlderCopies(eligible: Map<string, Set<string>>): void {
  const current = olderCopiesOnRecords()
  for (const [machineId, ids] of eligible) {
    const still = [...ids].filter((id) => current.get(machineId)?.has(id))
    if (still.length === 0) continue
    const gone = new Set(still)
    const awaiting = movedAwaitingDurableRecord.get(machineId)
    for (const id of gone) awaiting?.delete(id)
    if (awaiting && awaiting.size === 0) movedAwaitingDurableRecord.delete(machineId)
    useMachineActions.setState((s) => {
      const cfg = s.byMachine[machineId] ?? EMPTY_ACTION_CONFIG
      const custom = cfg.custom.filter((action) => !gone.has(action.id))
      const byMachine = { ...s.byMachine, [machineId]: { ...cfg, custom } }
      if (custom.length > 0) return { byMachine }
      const { [machineId]: _gone, ...macroArrangementByMachine } = s.macroArrangementByMachine
      return { byMachine, macroArrangementByMachine }
    })
  }
}

let confirmingDurableRecord = false
let confirmAgain = false

function deleteOlderCopiesOnceDurable(): void {
  // Only buttons already on the record BEFORE asking are covered by the
  // answer: their record write was requested before the store settled.
  const eligible = olderCopiesOnRecords()
  if (eligible.size === 0) return
  let answer: boolean | Promise<boolean>
  try {
    answer = projectStoreDurability.writesCommitted()
  } catch {
    return
  }
  if (answer === true) {
    deleteOlderCopies(eligible)
    return
  }
  if (answer === false) return
  if (confirmingDurableRecord) {
    confirmAgain = true
    return
  }
  confirmingDurableRecord = true
  const settle = (committed: boolean) => {
    confirmingDurableRecord = false
    if (committed) deleteOlderCopies(eligible)
    if (confirmAgain) {
      confirmAgain = false
      deleteOlderCopiesOnceDurable()
    }
  }
  answer.then(settle, () => settle(false))
}

syncActionOverridesFromDefinitions()
// A synchronous (localStorage) boot has already hydrated at import - the move
// runs now against the real records. An async (OPFS) boot runs it when
// hydration finishes (and again after any later rehydrate).
moveCustomButtonsOntoRecords()
useCamStore.persist.onFinishHydration(() => {
  syncActionOverridesFromDefinitions()
  moveCustomButtonsOntoRecords()
})

let lastActionsMachineLibrary = useCamStore.getState().machineLibrary
let lastActionsProjectMachine = useCamStore.getState().project.machine
useCamStore.subscribe((state) => {
  if (state.machineLibrary === lastActionsMachineLibrary && state.project.machine === lastActionsProjectMachine) return
  lastActionsMachineLibrary = state.machineLibrary
  lastActionsProjectMachine = state.project.machine
  syncActionOverridesFromDefinitions()
  moveCustomButtonsOntoRecords()
})

// A custom list arriving after the records did (the persisted store
// rehydrating, an older session's list restored) is moved the same way.
let lastActionsByMachine = useMachineActions.getState().byMachine
useMachineActions.subscribe((state) => {
  if (state.byMachine === lastActionsByMachine) return
  lastActionsByMachine = state.byMachine
  moveCustomButtonsOntoRecords()
})
