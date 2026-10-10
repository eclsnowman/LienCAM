// @vitest-environment jsdom
//
// WO-1710 - SAFE Z HAS ONE EDITOR: the Machine tab on the definition.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultControllerDefinition } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { buildParkSequence } = await import('../../lib/machine/machineActions')

const SAFE_Z_INSTRUCTION = "Set this machine's Safe Z on the Machine tab of its definition first."

beforeEach(() => {
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1710-no-safe-z',
    controller: 'grbl',
    controllerDefinition: createDefaultControllerDefinition(),
    safeZMachine: undefined,
  })
  useMachineActions.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'idle',
    homed: true,
    programText: 'G21\nG0 X0 Y0\n',
  })
})

afterEach(cleanup)

describe('WO-1710: Safe Z has one editor', () => {
  it('Machine actions renders no Safe Z input', () => {
    render(<MachineActionsModal open onClose={() => {}} />)
    expect(screen.queryByTestId('control-park-safez')).toBeNull()
    expect(screen.getByTestId('control-actions-modal').textContent).not.toMatch(/Safe Z/i)
  })

  it('the Program and Jog refusals point to the Machine tab editor', () => {
    const program = render(<ProgramPanel />)
    expect(screen.getByTestId('control-fittrace').getAttribute('data-tooltip')).toBe(SAFE_Z_INSTRUCTION)
    program.unmount()

    render(<JogPanel />)
    expect(screen.getByTestId('control-safez').getAttribute('data-tooltip')).toBe(SAFE_Z_INSTRUCTION)
  })

  it('a stated Safe Z produces the same park moves as before', () => {
    expect(buildParkSequence({ id: 'park', label: 'Park', x: 700, y: 700 }, -2)).toEqual({
      ok: true,
      lines: ['G21 G90 G53 G0 Z-2', 'G21 G90 G53 G0 X700 Y700'],
    })
  })
})
