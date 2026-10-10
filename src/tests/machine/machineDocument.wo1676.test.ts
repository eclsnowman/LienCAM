// @vitest-environment jsdom
//
// WO-1676: the per-machine tool table, probe pad thickness, probe feed
// overrides and M-code overrides used to live outside the machine definition
// in machineToolTableStore/machineActionsStore, keyed by machine id. An
// export of a machine (MachineLibraryModal's handleExportSelected) writes
// only the MachineConfig object, so importing it into a clean store lost all
// four (bespoke-code audit finding 7). They now live on MachineConfig
// (`toolTable`, `probeOverrides`, `actionOverrides`), so a plain JSON export
// and re-import carries them. Both control-side stores' caches are kept in
// step with the definition by a `useCamStore` subscription (reads never see
// a stale value), and `machineActionsStore.setOverride`/`clearOverride`
// write the definition directly - `MachineActionsModal` is their only real
// caller and it always resolves to the machine it means. The tool-table
// mutators stay pure cache writes instead: `controlMachineSelection.
// wo1065.test.tsx` calls them directly with a CAM id and a Control id side
// by side to prove neither ever perturbs the other, including CAM's own
// `project.machine` reference staying untouched - a real product invariant a
// blanket write-through inside the mutator broke. `ToolsProbePanel` is the
// one caller that knows which record a real edit is for, so it pushes the
// cache onto that record itself (`saveMachineToolRecord`) right after every
// mutator call.

import { beforeEach, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import { saveMachineToolRecord, useMachineToolTable } from '../../store/machineToolTableStore'
import { useMachineActions } from '../../store/machineActionsStore'
import { makeMachine } from '../post/helpers'
import { DEFAULT_ZPROBE_CONFIG, toolOffsetLine } from '../../lib/machine/toolTable'

/** The exact byte path a machine takes out of the library and back in:
 *  JSON.stringify/parse, same as `handleExportSelected`'s
 *  `JSON.stringify(draft, null, 2)` and `handleImport`'s `JSON.parse(...)`. */
function exportThenImport(machine: ReturnType<typeof makeMachine>, newId: string) {
  const exported = JSON.parse(JSON.stringify(machine)) as ReturnType<typeof makeMachine>
  return { ...exported, id: newId }
}

describe('WO-1676: tool table, probe overrides and M-code overrides travel with the definition', () => {
  beforeEach(() => {
    useCamStore.setState({ machineLibrary: [] })
    useMachineToolTable.setState({ byMachine: {} })
    useMachineActions.setState({ byMachine: {} })
  })

  it('THE FINDING: exporting a machine and importing it into a clean store used to lose the table, pad, feeds and M-code overrides - it now carries all four', () => {
    const original = makeMachine({
      id: 'machine-a',
      toolTable: {
        reference: 1,
        tools: [
          { tool: 1, probedMachineZ: -40, dia: 6.35, note: 'quarter inch', measuredAt: 111 },
          { tool: 2, probedMachineZ: -38.5, dia: 3.175, note: '', measuredAt: 222 },
        ],
      },
      probeOverrides: { padThickness: 12.7, fastFeed: 350, slowFeed: 40 },
      actionOverrides: { spindleCw: ['M3 S{rpm} G4 P1'], coolantMist: ['M107'] },
    })
    useCamStore.getState().addMachineToLibrary(original)

    const imported = exportThenImport(original, 'machine-a-imported')
    useCamStore.getState().addMachineToLibrary(imported)

    // The tool table.
    expect(useMachineToolTable.getState().tableFor('machine-a-imported')).toEqual(original.toolTable)
    // The probe pad thickness and feed overrides.
    const probeCfg = useMachineToolTable.getState().probeConfigFor('machine-a-imported')
    expect(probeCfg.padThickness).toBe(12.7)
    expect(probeCfg.fastFeed).toBe(350)
    expect(probeCfg.slowFeed).toBe(40)
    // Every value this machine did not override still comes from the defaults.
    expect(probeCfg.retract).toBe(DEFAULT_ZPROBE_CONFIG.retract)
    // The M-code overrides.
    expect(useMachineActions.getState().configFor('machine-a-imported').overrides).toEqual({
      spindleCw: ['M3 S{rpm} G4 P1'],
      coolantMist: ['M107'],
    })
  })

  it('two machines with different tables, pads and overrides never cross-contaminate after import', () => {
    const a = makeMachine({
      id: 'machine-a',
      toolTable: { reference: 1, tools: [{ tool: 1, probedMachineZ: -40, dia: 6, note: '', measuredAt: 1 }] },
      probeOverrides: { padThickness: 10 },
      actionOverrides: { spindleCw: ['M3 S{rpm}'] },
    })
    const b = makeMachine({
      id: 'machine-b',
      toolTable: { reference: 5, tools: [{ tool: 5, probedMachineZ: -22, dia: 12, note: '', measuredAt: 2 }] },
      probeOverrides: { padThickness: 25 },
      actionOverrides: { spindleCcw: ['M4 S{rpm}'] },
    })
    useCamStore.getState().addMachineToLibrary(exportThenImport(a, 'a2'))
    useCamStore.getState().addMachineToLibrary(exportThenImport(b, 'b2'))

    expect(useMachineToolTable.getState().tableFor('a2').tools.map((t) => t.tool)).toEqual([1])
    expect(useMachineToolTable.getState().tableFor('b2').tools.map((t) => t.tool)).toEqual([5])
    expect(useMachineToolTable.getState().probeConfigFor('a2').padThickness).toBe(10)
    expect(useMachineToolTable.getState().probeConfigFor('b2').padThickness).toBe(25)
    expect(useMachineActions.getState().configFor('a2').overrides).toEqual({ spindleCw: ['M3 S{rpm}'] })
    expect(useMachineActions.getState().configFor('b2').overrides).toEqual({ spindleCcw: ['M4 S{rpm}'] })

    // A typed line that reads the table (`G43 H<n>`, via `toolOffsetLine`):
    // each machine's reference tool applies a zero offset to itself, and
    // neither table has ever seen the other's tool number.
    expect(toolOffsetLine(useMachineToolTable.getState().tableFor('a2'), 1)).toEqual({
      ok: true, line: 'G43.1 Z0', deltaMm: 0,
    })
    expect(toolOffsetLine(useMachineToolTable.getState().tableFor('b2'), 5)).toEqual({
      ok: true, line: 'G43.1 Z0', deltaMm: 0,
    })
    expect(toolOffsetLine(useMachineToolTable.getState().tableFor('a2'), 5).ok).toBe(false)
    expect(toolOffsetLine(useMachineToolTable.getState().tableFor('b2'), 1).ok).toBe(false)
  })

  it('a live edit (Tools/Probe panel: addTool/updateTool/setProbeConfig, then push) writes onto the machine record, not a side store', () => {
    const machine = makeMachine({ id: 'machine-live' })
    useCamStore.getState().addMachineToLibrary(machine)

    // The store's own mutators stay pure cache writes - a direct call with an
    // arbitrary id must never perturb a machine record it was not for
    // (controlMachineSelection.wo1065.test.tsx keys parks/actions/probe
    // config to CAM vs Control machines side by side and asserts CAM's own
    // `project.machine` reference never moves). `ToolsProbePanel` is the one
    // caller that knows which record a real edit is for, so it pushes the
    // cache onto that record itself right after each mutator call
    // (`saveMachineToolRecord`) - reproduced here without mounting the panel.
    useMachineToolTable.getState().addTool('machine-live', 4)
    useMachineToolTable.getState().updateTool('machine-live', 4, { dia: 8 })
    useMachineToolTable.getState().setReference('machine-live', 4)
    useMachineToolTable.getState().setProbeConfig('machine-live', { padThickness: 9.5 })
    saveMachineToolRecord(machine)

    const stored = useCamStore.getState().machineLibrary.find((m) => m.id === 'machine-live')!
    expect(stored.toolTable?.reference).toBe(4)
    expect(stored.toolTable?.tools).toEqual([expect.objectContaining({ tool: 4, dia: 8 })])
    expect(stored.probeOverrides?.padThickness).toBe(9.5)

    // A round trip of THIS machine now carries the live edits.
    const reimported = exportThenImport(stored, 'machine-live-2')
    useCamStore.getState().addMachineToLibrary(reimported)
    expect(useMachineToolTable.getState().tableFor('machine-live-2').reference).toBe(4)
    expect(useMachineToolTable.getState().probeConfigFor('machine-live-2').padThickness).toBe(9.5)
  })

  it('setOverride/clearOverride write the M-code override onto the machine record', () => {
    const machine = makeMachine({ id: 'machine-mcode' })
    useCamStore.getState().addMachineToLibrary(machine)

    useMachineActions.getState().setOverride('machine-mcode', 'coolantFlood', ['M108'])
    let stored = useCamStore.getState().machineLibrary.find((m) => m.id === 'machine-mcode')!
    expect(stored.actionOverrides).toEqual({ coolantFlood: ['M108'] })
    expect(useMachineActions.getState().configFor('machine-mcode').overrides).toEqual({ coolantFlood: ['M108'] })

    useMachineActions.getState().clearOverride('machine-mcode', 'coolantFlood')
    stored = useCamStore.getState().machineLibrary.find((m) => m.id === 'machine-mcode')!
    expect(stored.actionOverrides).toEqual({})
    expect(useMachineActions.getState().configFor('machine-mcode').overrides).toEqual({})
  })

  it('AUDIT FIX ROUND: a tool-length measurement (Routines tab / Probing panel / guided tool change - recordProbedZ then a push onto the open record) survives a later, unrelated machine edit', () => {
    // Reproduces the audit's finding exactly: machineSession.ts's
    // confirmProbeRoutineToolLength, ProbingPanel's measureTool/feed edits
    // and ProgramPanel's guided tool change all follow this same sequence -
    // mutate the cache, then push it onto whichever record is open right
    // now (`saveMachineToolRecord`) - so a later machine edit that spreads
    // the current definition (as `setProjectMachine` callers do) carries the
    // measurement forward instead of `syncToolTableCacheFromDefinitions`
    // silently copying the pre-measurement definition back over the cache.
    const machine = makeMachine({
      id: 'm-audit',
      toolTable: {
        reference: null,
        tools: [
          { tool: 1, probedMachineZ: -40, dia: null, note: '', measuredAt: 1 },
          { tool: 2, probedMachineZ: null, dia: null, note: '', measuredAt: 0 },
        ],
      },
    })
    useCamStore.getState().addMachineToLibrary(machine)
    useCamStore.getState().setProjectMachine(machine)

    useMachineToolTable.getState().recordProbedZ('m-audit', 2, -37.25, 2)
    saveMachineToolRecord(useCamStore.getState().project.machine)

    useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine, name: 'renamed' })

    expect(
      useMachineToolTable.getState().tableFor('m-audit').tools.find((t) => t.tool === 2)?.probedMachineZ,
    ).toBe(-37.25)
  })

  it('a machine id naming no real record still works ephemerally (fallback cache, unchanged from before)', () => {
    useMachineToolTable.getState().addTool('no-such-machine', 9)
    expect(useMachineToolTable.getState().tableFor('no-such-machine').tools.map((t) => t.tool)).toEqual([9])
    useMachineActions.getState().setOverride('no-such-machine', 'spindleOff', ['M5', 'G4 P1'])
    expect(useMachineActions.getState().configFor('no-such-machine').overrides).toEqual({
      spindleOff: ['M5', 'G4 P1'],
    })
  })
})
