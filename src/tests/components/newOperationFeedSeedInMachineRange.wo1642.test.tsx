// @vitest-environment jsdom
//
// WO-1642 audit fix: the New Operation modal's own Feedrate tab seeds the
// spindle speed inside the ACTIVE machine's stated range - the same number the
// post emits - on a machine that is not Operator's. Drives the real modal, not the
// seed function, because the modal's call sites are where the seed escaped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'
import type { MachineConfig, Setup, Tool } from '../../types'

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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-1'

function benchMachine(base: MachineConfig): MachineConfig {
  return {
    ...base,
    id: 'hand-entered-grbl',
    name: 'Bench GRBL',
    controller: 'grbl',
    rapidRate: 2600,
    maxSpindleRpm: 11500,
    minSpindleRpm: 4200,
  }
}

const fastTool = {
  id: 'tool-fast', name: 'Fast 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
  feedsAndSpeeds: { default: { rpm: 30000, feedRate: 900, plungeRate: 200 } },
} as unknown as Tool

const slowTool = {
  id: 'tool-slow', name: 'Slow 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
  feedsAndSpeeds: { default: { rpm: 1000, feedRate: 900, plungeRate: 200 } },
} as unknown as Tool

function openOnBench(): MachineConfig {
  const machine = benchMachine(useCamStore.getState().project.machine)
  act(() => {
    const s = useCamStore.getState()
    const wcs = {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    }
    const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' } as unknown as Setup
    useCamStore.setState({
      toolLibrary: [fastTool, slowTool],
      project: { ...s.project, machine, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  return machine
}

function seededSpindleSpeed(): number {
  fireEvent.click(screen.getByText('Feedrate'))
  const toggle = screen.getByText(/Override tool feeds & speeds/).closest('label')!
  fireEvent.click(within(toggle).getByRole('checkbox'))
  const row = screen.getByText('Spindle speed').closest('.op-field-row') as HTMLElement
  const input = within(row).getByRole('textbox') as HTMLInputElement
  return Number(input.value.replace(/[^0-9.]/g, ''))
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

describe('WO-1642 New Operation modal seeds rpm inside the active machine range', () => {
  it('a tool above the machine maximum seeds the machine maximum', () => {
    const machine = openOnBench()
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Fast 6mm'))
    expect(seededSpindleSpeed()).toBe(machine.maxSpindleRpm!)
  })

  it('a tool below the machine minimum seeds the machine minimum', () => {
    const machine = openOnBench()
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Slow 6mm'))
    expect(seededSpindleSpeed()).toBe(machine.minSpindleRpm!)
  })

  it('no tool picked: the fallback seed is still inside the range', () => {
    const machine = openOnBench()
    const rpm = seededSpindleSpeed()
    expect(rpm).toBeGreaterThanOrEqual(machine.minSpindleRpm!)
    expect(rpm).toBeLessThanOrEqual(machine.maxSpindleRpm!)
  })
})
