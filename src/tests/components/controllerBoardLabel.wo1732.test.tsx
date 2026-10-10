// @vitest-environment jsdom

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
const { controllerBoardName } = await import('../../lib/machine/controllerBoard')
const { persistPartialize, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
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

const AXBB = machine('wo1732-axbb', 'AXBB router', 'uccnc', 19)
const UC300ETH = machine('wo1732-uc300eth', 'UC300ETH router', 'uccnc', 11)
const UNSTATED = machine('wo1732-unstated', 'Unstated board router', 'uccnc')
const UNKNOWN = machine('wo1732-unknown', 'Unknown board router', 'uccnc', 999)
const OTHER_CONTROLLER = machine('wo1732-linuxcnc', 'LinuxCNC router', 'linuxcnc', 19)

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

function selectedConnectionLabel(): string {
  const select = screen.getByTestId('control-kind-select') as HTMLSelectElement
  return select.selectedOptions[0]?.text ?? ''
}

beforeEach(() => memory.clear())
afterEach(() => cleanup())

describe('WO-1732 declared controller board identity', () => {
  it('names two distinct stated DeviceInfo types and keeps absent or unknown identities honest', () => {
    expect(controllerBoardName(AXBB)).toBe('AXBB-E')
    expect(controllerBoardName(UC300ETH)).toBe('UC300ETH-5LPT')
    expect(controllerBoardName(UNSTATED)).toBeNull()
    expect(controllerBoardName(UNKNOWN)).toBeNull()
    expect(controllerBoardName(OTHER_CONTROLLER)).toBeNull()
  })

  it('updates the actual ControlPage label when the selected machine changes', async () => {
    seed(AXBB, [AXBB, UC300ETH, UNSTATED, UNKNOWN])
    render(<ControlPage />)

    expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / AXBB-E)')

    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: UC300ETH.id } })
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC / UC300ETH-5LPT)'))

    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: UNSTATED.id } })
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)'))

    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: UNKNOWN.id } })
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)'))
  })

  it('does not carry a UCCNC board name onto simulator, serial, or another controller', async () => {
    seed(AXBB, [AXBB, OTHER_CONTROLLER])
    render(<ControlPage />)

    const kind = screen.getByTestId('control-kind-select') as HTMLSelectElement
    fireEvent.change(kind, { target: { value: 'simulator' } })
    expect(selectedConnectionLabel()).toBe(`Simulate ${AXBB.name}`)
    expect(selectedConnectionLabel()).not.toContain('AXBB-E')

    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: OTHER_CONTROLLER.id } })
    // WO-2066: another controller is not offered the UCCNC bridge, so no choice
    // it has can carry a UCCNC board name. WO-1987: it lands on its own
    // LinuxCNC connection.
    await waitFor(() => expect(selectedConnectionLabel()).toBe('LinuxCNC gateway'))
    expect([...kind.options].map((option) => option.value)).not.toContain('bridge')
    expect(kind.textContent).not.toMatch(/AXBB|UC300|UCCNC/)

    fireEvent.change(screen.getByTestId('control-kind-select'), { target: { value: 'simulator' } })
    expect(selectedConnectionLabel()).toBe(`Simulate ${OTHER_CONTROLLER.name}`)
    expect(selectedConnectionLabel()).not.toContain('AXBB-E')

    // WO-2068 + WO-1987: LinuxCNC offers only its own gateway and its
    // simulator, so it has no serial choice left to carry a board name onto.
    expect([...kind.options].map((option) => option.value)).toEqual(['gateway', 'simulator'])
  })

  it('round-trips the declared board through the production persisted machine-library slice', () => {
    seed(UC300ETH)

    const persisted = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState()))) as {
      machineLibrary: MachineConfig[]
    }
    const restored = persisted.machineLibrary.find((candidate) => candidate.id === UC300ETH.id)

    expect(restored?.controllerBoard).toEqual({ deviceType: 11 })
    expect(controllerBoardName(restored)).toBe('UC300ETH-5LPT')
  })

  it('the collapsed machine panel says the same thing the connection select says', async () => {
    // Start from the panel expanded regardless of any earlier test's fold,
    // and leave it expanded for the same reason.
    act(() => {
      useUiPrefs.setState((state) => ({
        collapsedPropsGroups: { ...state.collapsedPropsGroups, 'control-machine': false },
      }))
    })
    seed(AXBB, [AXBB, UNSTATED])
    render(<ControlPage />)

    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    expect(screen.getByTestId('control-machine-collapsed-values').textContent)
      .toBe('Machine bridge (UCCNC / AXBB-E) - Not connected')

    // An unstated board folds to the same generic label the select shows -
    // the two surfaces can never now disagree about the board.
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: UNSTATED.id } })
    await waitFor(() => expect(selectedConnectionLabel()).toBe('Machine bridge (UCCNC)'))
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    expect(screen.getByTestId('control-machine-collapsed-values').textContent)
      .toBe('Machine bridge (UCCNC) - Not connected')
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
  })
})
