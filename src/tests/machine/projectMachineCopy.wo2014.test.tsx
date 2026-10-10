// @vitest-environment jsdom
//
// WO-2014: a project opens with the machine it was made for, not a stale copy.
// Operator's 09-25 session: Full Suite.camproject embedded an older copy of
// LienCNC V2 without the tool setter he had saved to his library machine that
// evening. Control followed the project's copy, and Tools > Measure T19 said
// "Probe the pad" - it would have probed wherever the tool was. The library's
// record of a machine is the machine; the file's copy of the same id is not.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { useCamStore, controlMachine, persistMerge } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { fixedToolSetterPosition } = await import('../../lib/machine/machineSession')

import type { MachineConfig } from '../../types'

const SETTER = { x: 738, y: 724.5, z: 120 }

let libraryMachine: MachineConfig
let staleCopy: MachineConfig

function projectFileWith(machine: MachineConfig): string {
  return JSON.stringify({
    ...structuredClone(useCamStore.getState().project),
    id: `wo2014-project-${crypto.randomUUID()}`,
    name: 'Full_Suite_Test',
    machine,
    geometry: [],
    setups: [],
    modelItems: [],
    modelItemPlacements: [],
  })
}

async function openProjectFile(text: string): Promise<void> {
  await act(async () => {
    const store = useCamStore.getState()
    await store.loadProjectFromFile(text, store.beginProjectOpen())
  })
}

function machineLines(): string[] {
  return useCamStore.getState().consoleEvents
    .filter((event) => event.source === 'machine')
    .map((event) => event.message)
}

beforeEach(() => {
  useCamStore.getState().newProject()
  const base = useCamStore.getState().project.machine
  const id = `wo2014-lienCNC-v2-${crypto.randomUUID()}`
  staleCopy = structuredClone({
    ...base,
    id,
    name: 'LienCNC V2',
    probing: { ...(base.probing ?? {}), toolSetter: undefined },
  }) as MachineConfig
  delete (staleCopy.probing as { toolSetter?: unknown }).toolSetter
  useCamStore.getState().addMachineToLibrary({
    ...structuredClone(staleCopy),
    probing: { ...(staleCopy.probing ?? {}), toolSetter: SETTER },
  } as MachineConfig)
  libraryMachine = useCamStore.getState().machineLibrary.find((m) => m.id === id)!
  useCamStore.setState((s) => ({
    control: { ...s.control, activeMachineId: null },
    consoleEvents: [],
    consoleReadThroughId: 0,
  }))
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeTool: 19,
    tlo: null,
  })
})

afterEach(() => {
  cleanup()
  useCamStore.setState((s) => ({
    machineLibrary: s.machineLibrary.filter((m) => !m.id.startsWith('wo2014-')),
  }))
})

describe('WO-2014: the project names the machine; the library holds it', () => {
  it('opening a project that embeds an older copy of a library machine drives the library record, setter included', async () => {
    expect(fixedToolSetterPosition(staleCopy)).toBeNull()
    expect(fixedToolSetterPosition(libraryMachine)).toEqual(SETTER)

    await openProjectFile(projectFileWith(staleCopy))

    const state = useCamStore.getState()
    expect(state.project.name).toBe('Full_Suite_Test')
    expect(state.control.activeMachineId).toBeNull() // Follow CAM, no dropdown switch
    expect(state.project.machine).toBe(libraryMachine)
    expect(fixedToolSetterPosition(controlMachine(state))).toEqual(SETTER)
    expect(machineLines()).toEqual([
      'This project uses your library machine "LienCNC V2" as it is saved now; ' +
        'the copy stored in the project file differs and is not used.',
    ])

    render(<ToolsProbePanel />)
    const measure = screen.getByTestId('control-probe-measure')
    expect(measure.textContent).toContain('Measure T19')
    expect(measure.getAttribute('data-tooltip')).toBe('Probe the setter and record the length of T19')
  })

  it('an embedded copy identical to the library record opens silently', async () => {
    await openProjectFile(projectFileWith(structuredClone(libraryMachine)))

    expect(useCamStore.getState().project.machine).toBe(libraryMachine)
    expect(machineLines()).toEqual([])
  })

  it('a machine the library does not have keeps the project copy', async () => {
    const foreign = { ...structuredClone(staleCopy), id: `wo2014-foreign-${crypto.randomUUID()}`, name: 'Shop Router' }

    await openProjectFile(projectFileWith(foreign))

    const state = useCamStore.getState()
    expect(state.project.machine.id).toBe(foreign.id)
    expect(state.project.machine.name).toBe('Shop Router')
    expect(fixedToolSetterPosition(controlMachine(state))).toBeNull()
    expect(machineLines()).toEqual([])
  })

  it('a browser reload holding the stale copy comes back with the library record', () => {
    const current = useCamStore.getState()
    const merged = persistMerge({
      project: { ...structuredClone(current.project), machine: structuredClone(staleCopy) },
      machineLibrary: structuredClone(current.machineLibrary),
      control: { activeMachineId: null },
    }, current)

    expect(fixedToolSetterPosition(merged.project.machine)).toEqual(SETTER)
    expect(merged.project.machine).toBe(merged.machineLibrary.find((m) => m.id === staleCopy.id))
    expect(fixedToolSetterPosition(controlMachine(merged))).toEqual(SETTER)
    expect(merged.consoleEvents.filter((e) => e.source === 'machine').map((e) => e.message)).toEqual([
      'This project uses your library machine "LienCNC V2" as it is saved now; ' +
        'the copy stored in the project file differs and is not used.',
    ])
  })
})
