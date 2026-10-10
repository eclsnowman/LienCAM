// @vitest-environment jsdom
//
// WO-1732 (bounded Controller-area editor phase) - the DEFINITION'S board
// editor. The identity fact already exists (`MachineConfig.controllerBoard
// .deviceType`, declared by the board-identity phase) and the Control-page
// label already reads it; this suite defends the EDITOR: the real
// Definition > Controller tab edits the fact, the real Save writes the real
// record, and the Control-page label - expanded and collapsed - follows
// without a reload. It also pins the honesty rules the phase was scoped by:
//
//   1. Two distinct declared boards round-trip through edit/Save and name
//      the connection label each time; switching machines switches both.
//   2. "Not stated" REMOVES the optional fact - the persisted slice carries
//      no `controllerBoard` key at all after a reload, not a stale value and
//      not an invented default.
//   3. A stored unknown numeric type survives the editor honestly: it is
//      shown AS the unknown number, a Save that touches nothing keeps it,
//      and the label stays generic.
//   4. Another controller's Controller tab does not borrow this UCCNC fact,
//      even when a stale `controllerBoard` sits on its record.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MachineConfig } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { persistPartialize, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition } = await import('../../types')

function machine(
  id: string,
  name: string,
  controller: MachineConfig['controller'],
  deviceType?: number,
): MachineConfig {
  return {
    id,
    name,
    type: 'gantry_router',
    controller,
    ...(deviceType === undefined ? {} : { controllerBoard: { deviceType } }),
    travel: { x: 800, y: 600, z: 100 },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    controllerDefinition: createDefaultControllerDefinition(),
  }
}

function seed(selected: MachineConfig, library: MachineConfig[] = [selected]): void {
  act(() => {
    useCamStore.setState((state) => ({
      machineLibrary: library,
      project: { ...state.project, machine: selected },
      control: { activeMachineId: selected.id, sessionMachine: null },
    }))
    useMachineControl.setState((state) => ({
      connectionPhase: 'disconnected',
      connectionKind: null,
      connectionDetail: null,
      machineState: 'unknown',
      homed: false,
      settings: {},
      mpos: null,
      wpos: null,
      consoleLines: [],
      job: { ...state.job, phase: 'empty', name: null },
    }))
  })
}

/** The real door an operator uses: Control > Machine view > Definition tab
 *  (default) > Controller area. Nothing here mounts the area by hand. */
function openControllerArea(): void {
  fireEvent.click(screen.getByTestId('control-view-machine'))
  fireEvent.click(screen.getByTestId('machine-def-tab-controller'))
}

function boardSelect(): HTMLSelectElement {
  return screen.getByTestId('machine-def-controller-board-select') as HTMLSelectElement
}

function savePanel(): void {
  fireEvent.click(screen.getByTestId('machine-def-panel-save'))
}

function selectedConnectionLabel(): string {
  const select = screen.getByTestId('control-kind-select') as HTMLSelectElement
  return select.selectedOptions[0]?.text ?? ''
}

function libraryRecord(id: string): MachineConfig {
  return useCamStore.getState().machineLibrary.find((m) => m.id === id)!
}

beforeEach(() => memory.clear())
afterEach(() => cleanup())

describe('WO-1732 the Controller area declares the board', () => {
  it('two distinct boards round-trip edit/Save and the Control-page label follows, machine switch included', async () => {
    const routerA = machine('wo1732-ed-a', 'Router A', 'uccnc')
    const routerB = machine('wo1732-ed-b', 'Router B', 'uccnc')
    seed(routerA, [routerA, routerB])
    render(<ControlPage />)
    openControllerArea()

    // An unstated definition opens honestly as Not stated - no invented default.
    expect(boardSelect().value).toBe('')

    fireEvent.change(boardSelect(), { target: { value: '11' } })
    savePanel()
    expect(libraryRecord(routerA.id).controllerBoard).toEqual({ deviceType: 11 })
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / UC300ETH-5LPT)')

    // The other machine is its own record: still unstated, still generic.
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: routerB.id } })
    await waitFor(() => expect(boardSelect().value).toBe(''))
    fireEvent.change(boardSelect(), { target: { value: '19' } })
    savePanel()
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / AXBB-E)'))

    // Switching back re-reads the SAVED record, not a leftover draft.
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: routerA.id } })
    await waitFor(() => expect(boardSelect().value).toBe('11'))
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / UC300ETH-5LPT)')
  })

  it('Not stated removes the optional fact, and the persisted reload carries no board key', async () => {
    const axbb = machine('wo1732-ed-clear', 'AXBB router', 'uccnc', 19)
    seed(axbb, [axbb])
    render(<ControlPage />)
    openControllerArea()
    expect(boardSelect().value).toBe('19')

    fireEvent.change(boardSelect(), { target: { value: '' } })
    savePanel()
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)'))
    expect(libraryRecord(axbb.id).controllerBoard?.deviceType).toBeUndefined()

    // THE RELOAD: the persisted slice is exactly what a browser refresh
    // rehydrates, so the cleared fact must be GONE from it - not a stale 19
    // surviving the library's merge door, and not an explicit null either.
    const persisted = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState()))) as {
      machineLibrary: MachineConfig[]
    }
    const restored = persisted.machineLibrary.find((m) => m.id === axbb.id)!
    expect('controllerBoard' in restored).toBe(false)

    cleanup()
    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: persisted.machineLibrary,
        project: { ...state.project, machine: restored },
      }))
    })
    render(<ControlPage />)
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)')
  })

  it('a stored unknown device type survives the editor honestly and never names a board', async () => {
    const odd = machine('wo1732-ed-odd', 'Odd board router', 'uccnc', 999)
    seed(odd, [odd])
    render(<ControlPage />)
    openControllerArea()

    const select = boardSelect()
    expect(select.value).toBe('999')
    expect(select.selectedOptions[0]?.text).toBe('Unknown device type 999')
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)')

    // Saving without touching the select must not convert the unknown value
    // to a default or to absence - it is what the record states.
    savePanel()
    expect(libraryRecord(odd.id).controllerBoard).toEqual({ deviceType: 999 })
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)')

    // Declaring a known board replaces it.
    fireEvent.change(boardSelect(), { target: { value: '19' } })
    savePanel()
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / AXBB-E)'))
    expect(libraryRecord(odd.id).controllerBoard).toEqual({ deviceType: 19 })
  })

  it('another controller does not borrow the UCCNC board fact', async () => {
    const grbl = machine('wo1732-ed-grbl', 'GRBL router', 'grbl', 19)
    const linuxcnc = machine('wo1732-ed-lcnc', 'LinuxCNC router', 'linuxcnc', 19)
    seed(grbl, [grbl, linuxcnc])
    render(<ControlPage />)
    openControllerArea()

    // The stale UCCNC field on a GRBL record gets no editor and no label.
    expect(screen.queryByTestId('machine-def-controller-board')).toBeNull()

    // The board name is a CNCdrive fact - no LinuxCNC choice carries it, even
    // with the stale field on record. WO-2066: LinuxCNC is not offered the UCCNC
    // bridge at all, so it lands on its own LinuxCNC connection (WO-1987).
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: linuxcnc.id } })
    await waitFor(() => expect(screen.queryByTestId('machine-def-controller-board')).toBeNull())
    await waitFor(() => expect(selectedConnectionLabel()).toBe('LinuxCNC gateway'))
    const kinds = screen.getByTestId('control-kind-select') as HTMLSelectElement
    expect([...kinds.options].map((option) => option.value)).not.toContain('bridge')
    expect(kinds.textContent).not.toMatch(/AXBB|UC300|UCCNC/)
  })
})
