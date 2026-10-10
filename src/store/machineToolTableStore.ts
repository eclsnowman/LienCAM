import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// machineToolTableStore - per-MACHINE tool length table + Z probe overrides
// (MACHINE-CONTROL stage 10).
//
// WO-1676: THE DEFINITION IS THE SOURCE, THIS IS A THIN CACHE OF IT. The tool
// table and the probe overrides (pad thickness, feeds...) used to be the only
// copy here, keyed by machine id, outside the project schema - which is why
// exporting a machine and importing it into a clean store lost every measured
// length and probe setting (bespoke-code audit finding 7). They now live on
// `MachineConfig.toolTable` / `.probeOverrides`, and this store's `byMachine`
// is kept in step with the definition by the `useCamStore` subscription
// below, the same read-only mirroring `machineActionsStore` gives
// `overrides`. Mutators here stay PURE CACHE WRITES, exactly as before WO-1676
// - mirroring WO-1670's actual shape for parks/safeZ (the store's own
// `addPark`/`setSafeZ` never wrote through either; only the owned UI's
// `onChange` did, via `saveParkMachineRecord`). A mutator that wrote through
// unconditionally once tried here broke WO-1065's Control-vs-CAM isolation
// tests: `controlMachineSelection.wo1065.test.tsx` calls these mutators
// directly with a CAM id and a Control id side by side specifically to prove
// the two never cross, including CAM's own `project.machine` reference
// staying untouched - a real product invariant, not a test artifact. Reaching
// the definition from a live edit is `ToolsProbePanel`'s job now
// (`saveMachineToolRecord`, called there after every mutator call), because
// it is the one caller that actually knows which record the edit is for.

import { create } from 'zustand'
import { controlMachine, useCamStore } from './index'
import { useMachineControl } from './machineControlStore'
import { programToolCalls, type ProgramToolCall } from '../lib/machine/programTools'
import {
  EMPTY_TOOL_TABLE,
  machineProbeOverride,
  machineToolTable,
  newToolEntry,
  resolveProbeConfig,
  type MachineToolTable,
  type ProbePadChoice,
  type ToolTableEntry,
  type ZProbeConfig,
} from '../lib/machine/toolTable'
import type { MachineConfig } from '../types'

interface MachineToolRecord {
  table: MachineToolTable
  /** Only operator overrides live here. Machine-profile defaults remain the
   * source of truth until a field is explicitly changed in a control UI. */
  probe: Partial<ZProbeConfig>
  /** Optional keeps direct legacy cache seeds source-compatible; normal reads
   * resolve absence as no saved choices. */
  pads?: ProbePadChoice[]
  activePadId?: string | null
}

/** A successful fine setter contact that has not yet been associated with a
 * T number. It is transient controller-session evidence, not machine-profile
 * data and not an absolute physical tool length. */
export interface AvailableToolMeasurement {
  machineId: string
  sessionGeneration: number
  coordinate: 'machineZ'
  machineZ: number
  measuredAt: number
}

const EMPTY_RECORD: MachineToolRecord = { table: EMPTY_TOOL_TABLE, probe: {}, pads: [], activePadId: null }

interface MachineToolTableState {
  byMachine: Record<string, MachineToolRecord>
  availableMeasurement: AvailableToolMeasurement | null

  tableFor: (machineId: string) => MachineToolTable
  probeConfigFor: (machineId: string) => ZProbeConfig
  /** Add T`tool` if absent (no-op when it exists). */
  addTool: (machineId: string, tool: number) => void
  /** WO-1978: add every tool a loaded program calls that the table lacks,
   *  with the diameter the program states. An existing row keeps its reading,
   *  Ref star, note and typed Dia; only a BLANK Dia takes the program's. The
   *  record is `seed` (the definition's own) when this cache has none for the
   *  machine yet, so a first write never starts from an empty table or wipes
   *  the probe settings `saveMachineToolRecord` writes back beside it. */
  addProgramTools: (
    machineId: string,
    calls: ProgramToolCall[],
    seed: MachineToolRecord,
  ) => { added: ProgramToolCall[]; diaFilled: ProgramToolCall[] }
  removeTool: (machineId: string, tool: number) => void
  /** Merge a partial edit into one tool's row (dia, note, probedMachineZ...). */
  updateTool: (machineId: string, tool: number, patch: Partial<Omit<ToolTableEntry, 'tool'>>) => void
  /** Record a successful pad measurement. */
  recordProbedZ: (machineId: string, tool: number, probedMachineZ: number, at: number) => void
  retainAvailableMeasurement: (measurement: AvailableToolMeasurement) => void
  /** Attach only to an existing operator-selected row in the same live
   * machine generation. Returns the consumed receipt for truthful logging. */
  attachAvailableMeasurement: (
    machineId: string,
    sessionGeneration: number,
    tool: number,
  ) => AvailableToolMeasurement | null
  setReference: (machineId: string, tool: number | null) => void
  setProbeConfig: (machineId: string, patch: Partial<ZProbeConfig>) => void
  clearProbeConfig: (machineId: string) => void
  addProbePad: (machineId: string, thickness: number) => string
  selectProbePad: (machineId: string, padId: string) => void
}

function mutate(
  byMachine: Record<string, MachineToolRecord>,
  machineId: string,
  fn: (rec: MachineToolRecord) => MachineToolRecord,
): Record<string, MachineToolRecord> {
  const current = byMachine[machineId] ?? EMPTY_RECORD
  return { ...byMachine, [machineId]: fn(current) }
}

function mutateTable(
  byMachine: Record<string, MachineToolRecord>,
  machineId: string,
  fn: (table: MachineToolTable) => MachineToolTable,
): Record<string, MachineToolRecord> {
  return mutate(byMachine, machineId, (rec) => ({ ...rec, table: fn(rec.table) }))
}

export const useMachineToolTable = create<MachineToolTableState>()((set, get) => ({
  byMachine: {},
  availableMeasurement: null,

  tableFor: (machineId) => (get().byMachine[machineId] ?? EMPTY_RECORD).table,
  probeConfigFor: (machineId) =>
    resolveProbeConfig(null, (get().byMachine[machineId] ?? EMPTY_RECORD).probe),

  addTool: (machineId, tool) =>
    set((s) => ({
      byMachine: mutateTable(s.byMachine, machineId, (table) =>
        table.tools.some((t) => t.tool === tool)
          ? table
          : {
              ...table,
              tools: [...table.tools, newToolEntry(tool)].sort((a, b) => a.tool - b.tool),
            },
      ),
    })),

  addProgramTools: (machineId, calls, seed) => {
    const record = get().byMachine[machineId] ?? seed
    const current = record.table
    const added: ProgramToolCall[] = []
    const diaFilled: ProgramToolCall[] = []
    const tools = current.tools.map((entry) => {
      const call = calls.find((c) => c.tool === entry.tool)
      if (!call || call.dia === null || entry.dia !== null) return entry
      diaFilled.push(call)
      return { ...entry, dia: call.dia }
    })
    for (const call of calls) {
      if (tools.some((entry) => entry.tool === call.tool)) continue
      added.push(call)
      tools.push({ ...newToolEntry(call.tool), dia: call.dia })
    }
    if (added.length === 0 && diaFilled.length === 0) return { added, diaFilled }
    tools.sort((a, b) => a.tool - b.tool)
    set((s) => ({
      byMachine: {
        ...s.byMachine,
        [machineId]: { ...(s.byMachine[machineId] ?? record), table: { ...current, tools } },
      },
    }))
    return { added, diaFilled }
  },

  removeTool: (machineId, tool) =>
    set((s) => ({
      byMachine: mutateTable(s.byMachine, machineId, (table) => ({
        reference: table.reference === tool ? null : table.reference,
        tools: table.tools.filter((t) => t.tool !== tool),
      })),
    })),

  updateTool: (machineId, tool, patch) =>
    set((s) => ({
      byMachine: mutateTable(s.byMachine, machineId, (table) => ({
        ...table,
        tools: table.tools.map((t) => (t.tool === tool ? { ...t, ...patch } : t)),
      })),
    })),

  recordProbedZ: (machineId, tool, probedMachineZ, at) =>
    set((s) => ({
      byMachine: mutateTable(s.byMachine, machineId, (table) => {
        const tools = table.tools.some((t) => t.tool === tool)
          ? table.tools
          : [...table.tools, newToolEntry(tool)].sort((a, b) => a.tool - b.tool)
        return {
          ...table,
          tools: tools.map((t) =>
            t.tool === tool ? { ...t, probedMachineZ, measuredAt: at } : t,
          ),
        }
      }),
    })),

  retainAvailableMeasurement: (measurement) => set({ availableMeasurement: measurement }),

  attachAvailableMeasurement: (machineId, sessionGeneration, tool) => {
    const measurement = get().availableMeasurement
    const table = get().tableFor(machineId)
    if (
      !measurement
      || measurement.machineId !== machineId
      || measurement.sessionGeneration !== sessionGeneration
      || !table.tools.some((entry) => entry.tool === tool)
    ) return null
    set((s) => ({
      availableMeasurement: null,
      byMachine: mutateTable(s.byMachine, machineId, (current) => ({
        ...current,
        tools: current.tools.map((entry) => entry.tool === tool
          ? { ...entry, probedMachineZ: measurement.machineZ, measuredAt: measurement.measuredAt }
          : entry),
      })),
    }))
    return measurement
  },

  setReference: (machineId, tool) =>
    set((s) => ({
      byMachine: mutateTable(s.byMachine, machineId, (table) => ({ ...table, reference: tool })),
    })),

  setProbeConfig: (machineId, patch) =>
    set((s) => ({
      byMachine: mutate(s.byMachine, machineId, (rec) => ({
        ...rec,
        probe: { ...rec.probe, ...patch },
        pads: patch.padThickness !== undefined && rec.activePadId != null
          ? (rec.pads ?? []).map((pad) => pad.id === rec.activePadId
            ? { ...pad, thickness: patch.padThickness! }
            : pad)
          : rec.pads,
      })),
    })),

  clearProbeConfig: (machineId) =>
    set((s) => ({
      byMachine: mutate(s.byMachine, machineId, (rec) => {
        const activePad = (rec.pads ?? []).find((pad) => pad.id === rec.activePadId)
        return { ...rec, probe: activePad ? { padThickness: activePad.thickness } : {} }
      }),
    })),

  addProbePad: (machineId, thickness) => {
    const used = new Set(((get().byMachine[machineId] ?? EMPTY_RECORD).pads ?? []).map((pad) => pad.id))
    let number = 1
    while (used.has(`pad-${number}`)) number += 1
    const id = `pad-${number}`
    set((s) => ({
      byMachine: mutate(s.byMachine, machineId, (rec) => ({
        ...rec,
        probe: { ...rec.probe, padThickness: thickness },
        pads: [...(rec.pads ?? []), { id, thickness }],
        activePadId: id,
      })),
    }))
    return id
  },

  selectProbePad: (machineId, padId) =>
    set((s) => ({
      byMachine: mutate(s.byMachine, machineId, (rec) => {
        const pad = (rec.pads ?? []).find((candidate) => candidate.id === padId)
        return pad
          ? { ...rec, probe: { ...rec.probe, padThickness: pad.thickness }, activePadId: pad.id }
          : rec
      }),
    })),
}))

/**
 * WO-1676: PUSH A LIVE EDIT ONTO THE RECORD IT IS FOR. Call after any mutator
 * above, with the SAME machine the edit was made against (`ToolsProbePanel`
 * always has it - `useCamStore(controlMachine)`). Writes the library entry
 * and, when it is also the project's machine, the project's copy, mirroring
 * `machineActionsStore.saveParkMachineRecord`. A no-op for a machine id that
 * names no record (an orphan test id): nothing to reach.
 */
export function saveMachineToolRecord(machine: MachineConfig): void {
  const cache = useMachineToolTable.getState().byMachine[machine.id]
  if (!cache) return
  const pads = cache.pads ?? []
  const activePad = pads.find((pad) => pad.id === cache.activePadId)
  const probeOverrides = { ...cache.probe }
  if (activePad) delete probeOverrides.padThickness
  const updates: Pick<MachineConfig, 'toolTable' | 'probeOverrides' | 'probePads' | 'activeProbePadId'> = {
    toolTable: cache.table,
    probeOverrides,
    probePads: pads.length > 0 ? pads : undefined,
    activeProbePadId: activePad?.id,
  }
  const cam = useCamStore.getState()
  // Patch the stored records instead of spreading a connection-start snapshot
  // across them. Controller, limits, spindle and I/O remain receipt/reconnect
  // bound while operator-owned tool rows and removable pads change immediately.
  if (cam.machineLibrary.some((m) => m.id === machine.id)) cam.updateMachineInLibrary(machine.id, updates)
  if (cam.project.machine.id === machine.id) cam.setProjectMachine({ ...cam.project.machine, ...updates })
  cam.updateControlSessionToolRecord(machine.id, {
    toolTable: updates.toolTable,
    probeOverrides,
    probePads: updates.probePads,
    activeProbePadId: updates.activeProbePadId,
  })
}

function formatDia(dia: number): string {
  return String(Number(dia.toFixed(3)))
}

/**
 * WO-1978: A PROGRAM'S TOOLS ARRIVE IN THE TABLE READY TO MEASURE. Called by
 * the Control tab's file door with the text the operator opened. Every tool the
 * program calls that the Control machine's table lacks gets a row, with the
 * diameter the program states; a row already there keeps its measurement, Ref
 * star and typed values (a blank Dia takes the program's). Tools the table has
 * that this program does not call stay - they belong to the machine. Writes
 * through to the definition exactly as a Tools-panel edit does, and says once
 * on the console what it added (COHESION-STANDARD 13.2). A program that calls
 * no tool, or only tools already complete in the table, changes and says
 * nothing.
 */
export function fillToolTableFromProgram(name: string, text: string): void {
  const calls = programToolCalls(text)
  if (calls.length === 0) return
  const machine = controlMachine(useCamStore.getState())
  const seed: MachineToolRecord = {
    table: machineToolTable(machine),
    probe: machineProbeOverride(machine) ?? {},
    pads: machine.probePads ?? [],
    activePadId: machine.activeProbePadId ?? null,
  }
  const { added, diaFilled } = useMachineToolTable.getState().addProgramTools(machine.id, calls, seed)
  if (added.length === 0 && diaFilled.length === 0) return
  saveMachineToolRecord(machine)
  const describe = (call: ProgramToolCall) => (call.dia !== null ? operatorText('machineToolTableStore1', { value1: String(call.tool), value2: String(formatDia(call.dia)) }) : operatorText('machineToolTableStore2', { value1: String(call.tool) }))
  const parts: string[] = []
  if (added.length > 0) {
    parts.push(operatorText('machineToolTableStore3', { value1: String(added.map(describe).join(', ')) }))
  }
  if (diaFilled.length > 0) {
    parts.push(operatorText('machineToolTableStore4', { value1: String(diaFilled.map(describe).join(', ')) }))
  }
  useMachineControl.getState().pushConsole('rx', `"${name}": ${parts.join('; ')}.`, 'info')
}

/** Every machine this session knows about - the library plus the project's
 *  own machine when it is not already in it (a from-scratch project before
 *  any Library save). */
function knownMachines(cam: { machineLibrary: MachineConfig[]; project: { machine: MachineConfig } }): MachineConfig[] {
  const all = cam.machineLibrary
  return all.some((m) => m.id === cam.project.machine.id) ? all : [...all, cam.project.machine]
}

/** KEEP THE CACHE IN STEP WITH THE DEFINITION. Non-owned Control panels read
 *  `byMachine[id].table` / `.probe` as plain state (never through `tableFor`/
 *  `probeConfigFor`), so the cache itself has to hold what the definition
 *  says after an import or a machine switch, not just answer for it on
 *  request. Runs once at module load (a reload's persisted project already
 *  has the data) and again on every `machineLibrary` / `project.machine`
 *  change - the reference check keeps it a no-op on the far more frequent
 *  state changes that touch neither. A record stating nothing for a field
 *  (`undefined`) is not yet authoritative for it - the cache keeps whatever
 *  it already holds, so a `setProbeConfig`/`addTool` call made before this
 *  machine had a record at all is not erased the moment one appears. */
function syncToolTableCacheFromDefinitions(): void {
  const cam = useCamStore.getState()
  const machines = knownMachines(cam)
  useMachineToolTable.setState((s) => {
    let byMachine = s.byMachine
    for (const m of machines) {
      const current = byMachine[m.id] ?? EMPTY_RECORD
      const definitionProbe = machineProbeOverride(m)
      const next: MachineToolRecord = {
        table: m.toolTable !== undefined ? machineToolTable(m) : current.table,
        probe: definitionProbe !== undefined ? definitionProbe : current.probe,
        pads: m.probePads !== undefined ? m.probePads : current.pads,
        activePadId: m.activeProbePadId !== undefined ? m.activeProbePadId : current.activePadId,
      }
      if (
        current.table === next.table
        && current.probe === next.probe
        && current.pads === next.pads
        && current.activePadId === next.activePadId
      ) continue
      if (byMachine === s.byMachine) byMachine = { ...byMachine }
      byMachine[m.id] = next
    }
    return { byMachine }
  })
}

syncToolTableCacheFromDefinitions()

let lastMachineLibrary = useCamStore.getState().machineLibrary
let lastProjectMachine = useCamStore.getState().project.machine
useCamStore.subscribe((state) => {
  if (state.machineLibrary === lastMachineLibrary && state.project.machine === lastProjectMachine) return
  lastMachineLibrary = state.machineLibrary
  lastProjectMachine = state.project.machine
  syncToolTableCacheFromDefinitions()
})
