// @vitest-environment jsdom
//
// WO-1732 (All Settings board row phase) - the SAME declared board fact,
// edited through the second door. The Controller area editor and the
// Control-page label already exist; this suite defends the All Settings row:
// it renders through the real Definition > All settings table, edits the
// existing `MachineConfig.controllerBoard.deviceType` through the ONE shared
// writer, Saves to the real record, and survives the production persist/
// reload. The honesty rules carry over unchanged:
//
//   1. An unstated UCCNC definition DISPLAYS the friendly 'Not stated' label,
//      but the row's VALUE stays null - the architect's filter correction:
//      a sentinel string in the value made the absent fact show up under
//      "Stated by the profile". Picking a known board names it, and the
//      Control-page label follows the row's edit.
//   2. Choosing 'Not stated' REMOVES the optional fact - the persisted slice
//      carries no `controllerBoard` key after a reload, not a stale value.
//   3. A stored unknown numeric id is shown AS the unknown number and a Save
//      that touches nothing keeps it verbatim.
//   4. Controller area and All settings round-trip the SAME fact: an edit in
//      one door is what the other door shows after Save, both directions.
//   5. Machine switching re-reads each record; another controller's table
//      does not borrow this UCCNC fact even with a stale field on record.
//   6. The real Show filters read the fact honestly: absent/cleared rows are
//      visible under Everything and omitted under Stated by the profile; a
//      stated board is included; Changed by me flags a clearing before Save
//      and resets after it.

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

const BOARD_KEY = 'machine.controllerBoard'

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

/** The real doors: Control > Machine view > Definition > All settings tab.
 *  Nothing here mounts the table by hand. */
function openAllSettings(): void {
  fireEvent.click(screen.getByTestId('control-view-machine'))
  fireEvent.click(screen.getByTestId('machine-def-tab-allSettings'))
}

function boardRowSelect(): HTMLSelectElement {
  return screen.getByLabelText(BOARD_KEY) as HTMLSelectElement
}

function boardRowSelectedText(): string {
  return boardRowSelect().selectedOptions[0]?.text ?? ''
}

/** The real Show door of the table (Everything / Stated by the profile /
 *  Changed by me) - not a model-only helper. */
function setShowFilter(value: 'everything' | 'stated' | 'changed'): void {
  fireEvent.change(screen.getByTestId('machine-def-all-settings-show'), { target: { value } })
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

function persistedLibrary(): MachineConfig[] {
  const persisted = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState()))) as {
    machineLibrary: MachineConfig[]
  }
  return persisted.machineLibrary
}

beforeEach(() => memory.clear())
afterEach(() => cleanup())

describe('WO-1732 the All Settings board row', () => {
  it('renders Not stated for an unstated UCCNC definition, names a chosen board on Save, and the label follows', async () => {
    const router = machine('wo1732-as-set', 'Router A', 'uccnc')
    seed(router)
    render(<ControlPage />)
    openAllSettings()

    const select = boardRowSelect()
    // Display and value are SEPARATE (the architect's filter correction):
    // the row READS "Not stated" while its value stays null, so the Stated
    // filter can honestly omit an absent fact. A sentinel string here is
    // the defect this pins.
    expect(select.value).toBe('')
    expect(select.selectedOptions[0]?.text).toBe('Not stated')
    const optionTexts = Array.from(select.options).map((o) => o.text)
    expect(optionTexts).toContain('Not stated')
    expect(optionTexts).toContain('UC100')
    expect(optionTexts).toContain('AXBB-E')

    fireEvent.change(select, { target: { value: 'UC300ETH-5LPT' } })
    expect(boardRowSelect().value).toBe('UC300ETH-5LPT')
    savePanel()

    expect(libraryRecord(router.id).controllerBoard).toEqual({ deviceType: 11 })
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / UC300ETH-5LPT)')

    // The production persisted slice carries the stated fact verbatim.
    const restored = persistedLibrary().find((m) => m.id === router.id)!
    expect(restored.controllerBoard).toEqual({ deviceType: 11 })
  }, 120000)

  it('choosing Not stated removes the optional fact - the persisted reload carries no board key', async () => {
    const axbb = machine('wo1732-as-clear', 'AXBB router', 'uccnc', 19)
    seed(axbb)
    render(<ControlPage />)
    openAllSettings()
    expect(boardRowSelect().value).toBe('AXBB-E')

    fireEvent.change(boardRowSelect(), { target: { value: 'Not stated' } })
    savePanel()
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)'))
    expect(libraryRecord(axbb.id).controllerBoard?.deviceType).toBeUndefined()

    // THE RELOAD: the persisted slice is exactly what a browser refresh
    // rehydrates, so the cleared fact must be GONE from it - the library
    // door merges, and a resurrected stale 19 is the defect this pins.
    const persisted = persistedLibrary()
    const restored = persisted.find((m) => m.id === axbb.id)!
    expect('controllerBoard' in restored).toBe(false)

    cleanup()
    act(() => {
      useCamStore.setState((state) => ({
        machineLibrary: persisted,
        project: { ...state.project, machine: restored },
      }))
    })
    render(<ControlPage />)
    openAllSettings()
    expect(boardRowSelect().value).toBe('')
    expect(boardRowSelectedText()).toBe('Not stated')
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)')
  }, 120000)

  it('shows a stored unknown id honestly, keeps it through an untouched Save, and round-trips the same fact with the Controller area', async () => {
    const odd = machine('wo1732-as-odd', 'Odd board router', 'uccnc', 999)
    seed(odd)
    render(<ControlPage />)
    openAllSettings()

    const select = boardRowSelect()
    expect(select.value).toBe('Unknown device type 999')
    expect(Array.from(select.options).map((o) => o.text)).toContain('Unknown device type 999')

    // Saving without touching the row must not convert the unknown value.
    savePanel()
    expect(libraryRecord(odd.id).controllerBoard).toEqual({ deviceType: 999 })

    // Door 2 -> door 1: declare UC100 here, and the Controller area shows
    // the same fact after Save.
    fireEvent.change(boardRowSelect(), { target: { value: 'UC100' } })
    savePanel()
    expect(libraryRecord(odd.id).controllerBoard).toEqual({ deviceType: 1 })
    fireEvent.click(screen.getByTestId('machine-def-tab-controller'))
    expect((screen.getByTestId('machine-def-controller-board-select') as HTMLSelectElement).value).toBe('1')

    // Door 1 -> door 2: declare AXBB-E there, and this row shows it.
    fireEvent.change(screen.getByTestId('machine-def-controller-board-select'), { target: { value: '19' } })
    savePanel()
    fireEvent.click(screen.getByTestId('machine-def-tab-allSettings'))
    await waitFor(() => expect(boardRowSelect().value).toBe('AXBB-E'))
    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / AXBB-E)')
  }, 120000)

  it('follows the machine switch and stays out of another controller\'s table', async () => {
    const routerA = machine('wo1732-as-a', 'Router A', 'uccnc', 1)
    const routerB = machine('wo1732-as-b', 'Router B', 'uccnc')
    const grbl = machine('wo1732-as-grbl', 'GRBL router', 'grbl', 19)
    seed(routerA, [routerA, routerB, grbl])
    render(<ControlPage />)
    openAllSettings()
    expect(boardRowSelect().value).toBe('UC100')

    // The other UCCNC machine is its own record: still reads Not stated,
    // with the value honestly null.
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: routerB.id } })
    await waitFor(() => expect(boardRowSelect().value).toBe(''))
    expect(boardRowSelectedText()).toBe('Not stated')

    // A GRBL definition does not borrow the UCCNC board row, stale field or
    // not - the row is gated on the controller, not on the leftover key.
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: grbl.id } })
    await waitFor(() => expect(screen.queryByLabelText(BOARD_KEY)).toBeNull())
    expect(grbl.controllerBoard).toEqual({ deviceType: 19 })
  }, 120000)

  it('keeps the Stated filter honest: absent and cleared rows are omitted, a stated board is included, Changed by me flags a clearing and resets', async () => {
    const router = machine('wo1732-as-filter', 'Filter router', 'uccnc')
    seed(router)
    render(<ControlPage />)
    openAllSettings()
    // Narrow the real table through the panel's own search door, so every
    // filter verdict below is about THIS row and nothing else.
    fireEvent.change(screen.getByTestId('machine-def-bar-search'), { target: { value: BOARD_KEY } })
    expect(boardRowSelectedText()).toBe('Not stated')

    // THE FILTER DEFECT THE ARCHITECT SENT BACK: a row whose value is the
    // sentinel string 'Not stated' passes the shared `value !== null` test
    // and poses as stated. The honest absent row is GONE under Stated.
    setShowFilter('stated')
    expect(screen.queryByLabelText(BOARD_KEY)).toBeNull()

    // Nothing edited yet: Changed by me also omits it.
    setShowFilter('changed')
    expect(screen.queryByLabelText(BOARD_KEY)).toBeNull()

    // State a board under Everything.
    setShowFilter('everything')
    fireEvent.change(boardRowSelect(), { target: { value: 'UC100' } })
    expect(boardRowSelect().value).toBe('UC100')

    // Draft differs from the saved record: Changed by me flags it...
    setShowFilter('changed')
    expect(boardRowSelect().value).toBe('UC100')
    // ...and a stated fact is INCLUDED under Stated by the profile.
    setShowFilter('stated')
    expect(boardRowSelect().value).toBe('UC100')

    // Save resets Changed by me - the draft no longer differs.
    savePanel()
    setShowFilter('changed')
    expect(screen.queryByLabelText(BOARD_KEY)).toBeNull()
    setShowFilter('stated')
    expect(boardRowSelect().value).toBe('UC100')
    expect(libraryRecord(router.id).controllerBoard).toEqual({ deviceType: 1 })

    // The CLEAR is equally honest: the cleared draft value is null, so the
    // row leaves Stated by the profile BEFORE Save, Changed by me flags the
    // unsaved clearing, and after Save both read the absence alike.
    setShowFilter('everything')
    fireEvent.change(boardRowSelect(), { target: { value: 'Not stated' } })
    expect(boardRowSelect().value).toBe('')
    expect(boardRowSelectedText()).toBe('Not stated')
    setShowFilter('stated')
    expect(screen.queryByLabelText(BOARD_KEY)).toBeNull()
    setShowFilter('changed')
    expect(boardRowSelect()).toBeTruthy()
    savePanel()
    setShowFilter('changed')
    expect(screen.queryByLabelText(BOARD_KEY)).toBeNull()
    expect(libraryRecord(router.id).controllerBoard).toBeUndefined()
  }, 120000)
})
