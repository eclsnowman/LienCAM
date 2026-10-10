// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolsProbePanel } from '../../components/machine/ToolsProbePanel'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { useUiPrefs } from '../../store/uiPrefs'
import { createDefaultControllerDefinition } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

function installMachine(bottom: number | null): void {
  const current = useCamStore.getState().project.machine
  const controllerDefinition = bottom === null ? undefined : createDefaultControllerDefinition()
  const z = controllerDefinition?.axes.find((axis) => axis.axis === 'Z')
  if (z) z.softLimitMin = bottom!
  // WO-1798 follow-up: numbers alone state nothing; the plan may only call
  // this a declared bottom because the Machine-area statement pair is present.
  if (controllerDefinition) {
    controllerDefinition.stated = [
      { controller: current.controller, key: axisSoftLimitStatementKey('Z', 'min') },
      { controller: current.controller, key: axisSoftLimitStatementKey('Z', 'max') },
    ]
  }
  useCamStore.getState().setProjectMachine({
    ...current,
    id: `wo1798-${crypto.randomUUID()}`,
    controllerDefinition,
    probeOverrides: undefined,
  })
}

beforeEach(() => {
  memory.clear()
  useCamStore.setState({ machineLibrary: [] })
  useCamStore.getState().newProject()
  installMachine(-10)
  useCamStore.getState().setControlSessionMachine(null)
  useCamStore.getState().setControlMachineId(null)
  useCamStore.getState().setDisplayUnits('mm')
  useUiPrefs.setState({ machineDisplayUnits: 'default' })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    mpos: { x: 5, y: 6, z: 70 },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-1798 Tools/Probe work-Z plan', () => {
  it('shows the resolved limit search before the existing action and refreshes with position', () => {
    render(<ToolsProbePanel />)
    const plan = screen.getByTestId('control-probe-z0-search-plan')
    const action = screen.getByTestId('control-probe-z0')
    expect(plan.textContent).toBe('Search from machine Z 70.00 down to the machine Z limit -10.00 (80.00 mm).')
    expect(plan.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    act(() => useMachineControl.setState({ mpos: { x: 5, y: 6, z: 20 } }))
    expect(plan.textContent).toBe('Search from machine Z 20.00 down to the machine Z limit -10.00 (30.00 mm).')
  })

  it('shows an explicit shorter override, then presents the same resolved facts in inches', () => {
    render(<ToolsProbePanel />)
    const maxTravel = () => screen.getByTestId('control-probe-cfg-travel') as HTMLInputElement
    fireEvent.change(maxTravel(), { target: { value: '12' } })
    fireEvent.blur(maxTravel())

    const plan = screen.getByTestId('control-probe-z0-search-plan')
    expect(plan.textContent).toBe('Search from machine Z 70.00 down 12.00 mm, stopping at machine Z 58.00 before the machine Z limit.')

    fireEvent.change(maxTravel(), { target: { value: '200' } })
    fireEvent.blur(maxTravel())
    expect(plan.textContent).toBe('Search from machine Z 70.00 down to the machine Z limit -10.00 (80.00 mm); the saved Max travel is longer.')

    fireEvent.change(maxTravel(), { target: { value: '12' } })
    fireEvent.blur(maxTravel())
    act(() => useCamStore.getState().setDisplayUnits('inch'))
    expect(plan.textContent).toBe('Search from machine Z 2.756 down 0.472 in, stopping at machine Z 2.283 before the machine Z limit.')
  })

  it('states the finite fallback for an unknown bottom or unavailable machine position', () => {
    installMachine(null)
    render(<ToolsProbePanel />)
    expect(screen.getByTestId('control-probe-z0-search-plan').textContent)
      .toBe('Search down 50.00 mm using Max travel; the machine Z limit is not stated.')

    cleanup()
    installMachine(-10)
    useMachineControl.setState({ mpos: null })
    render(<ToolsProbePanel />)
    expect(screen.getByTestId('control-probe-z0-search-plan').textContent)
      .toBe('Search down 50.00 mm using Max travel; current machine Z is not reported.')
  })
})
