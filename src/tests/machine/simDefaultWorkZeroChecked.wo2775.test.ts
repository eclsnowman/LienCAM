// @vitest-environment jsdom

// WO-2775 (the owner 2026-10-09, "Ok, after alpha"): the Sample router's default
// simulator G54 (WO-2712, the default part's front-left top) is a zero the
// simulated controller HOLDS at connect, so the Load transfer check judges
// travel on it - no "Work zero not set" note, and a file that leaves travel
// on that zero is refused with the existing soft-limit sentence. A real
// controller with no report, and any other simulated machine, are unchanged.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { typedMock } from '../support/typedMock'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  transferReview,
} = await import('../../lib/machine/machineSession')

const PLAIN_FILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/final-session-programs/final-o9-comments-first.nc'),
  'utf8',
)
// On the default zero (work Z0 = machine Z ~-60.25) a plunge to work Z-100
// lands at machine Z ~-160, below the Sample router's Z travel (-95..0).
const BELOW_TABLE_FILE = ['G90 G21 G54', 'G0 Z15', 'G0 X0 Y0', 'G1 Z-100 F300', 'G0 Z15', 'M30', ''].join('\n')

const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

async function connectSimulatorWith(machine: MachineConfig): Promise<void> {
  useCamStore.setState({ project: { ...initial.project, machine }, machineLibrary: [machine] })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(350)
  await pending
  await vi.advanceTimersByTimeAsync(50)
}

async function homeAndLoad(name: string, text: string): Promise<void> {
  __resetEstopInterlockForTest()
  expect(getMachineController().homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
  await vi.advanceTimersByTimeAsync(2_000)
  loadMachineProgram(name, text, null)
  await vi.advanceTimersByTimeAsync(50)
}

function uncheckedNotes(): string[] {
  return transferReview().result.notes.filter((note) => note.startsWith('Work zero not set on '))
}

describe('WO-2775: the simulator default work zero is checked at Load', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl, consoleLines: [] })
  })

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    useCamStore.setState(initial, true)
  })

  it('fresh Sample router: Load judges X, Y and Z on the default G54 - no "unchecked" note', async () => {
    await connectSimulatorWith(useCamStore.getInitialState().project.machine)
    await homeAndLoad('final-o9-comments-first.nc', PLAIN_FILE)
    expect(uncheckedNotes()).toEqual([])
    expect(transferReview().result.refusals).toEqual([])
  })

  it('fresh Sample router: a file that goes below the table on the default zero is refused at Load', async () => {
    await connectSimulatorWith(useCamStore.getInitialState().project.machine)
    await homeAndLoad('below-table.nc', BELOW_TABLE_FILE)
    expect(uncheckedNotes()).toEqual([])
    const refusals = transferReview().result.refusals
    expect(refusals).toHaveLength(1)
    // The single-frame sentence transferCheck.ts already speaks, unchanged.
    expect(refusals[0]).toBe('Z program range -160.25..-45.25 mm exceeds soft limits -95..0 mm.')
  })

  it('the default is still never written into the durable record', async () => {
    const sample = useCamStore.getInitialState().project.machine
    await connectSimulatorWith(sample)
    expect(useCamStore.getState().machineWorkOffsets[sample.id]?.G54).toBeUndefined()
  })

  // WO-3184 (owner report 2026-10-27): a stored G54 handed to the simulator at connect
  // counts as reported, as a real bridge's write receipt does - checked at Load.
  it('a stored G54 on the Sample router is handed to the simulator: checked at Load, no "unchecked" note', async () => {
    const sample = useCamStore.getInitialState().project.machine
    useCamStore.getState().setMachineWorkOffset(sample.id, 'G54', { x: -250, y: -240, z: -60 }, 'not-sent')
    await connectSimulatorWith(sample)
    await homeAndLoad('final-o9-comments-first.nc', PLAIN_FILE)
    expect(uncheckedNotes()).toEqual([])
  })

  it('another simulated machine (no default G54): unchanged - the note stays', async () => {
    // Stated travel, so the check reaches the work-zero question at all.
    const definition = createDefaultControllerDefinition()
    definition.axes = definition.axes.map((axis) => ({ ...axis, softLimitMin: -400, softLimitMax: 0 }))
    definition.stated = definition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
      controller: 'grbl' as const, key: axisSoftLimitStatementKey(axis.axis, end),
    })))
    const other = {
      ...useCamStore.getInitialState().project.machine,
      id: 'wo2775-other',
      name: 'Other router',
      controllerDefinition: definition,
    }
    await connectSimulatorWith(other)
    await homeAndLoad('final-o9-comments-first.nc', PLAIN_FILE)
    expect(transferReview().result.refusals).toEqual([])
    expect(uncheckedNotes()).toEqual([
      'Work zero not set on X - travel on X is unchecked until you set it.',
      'Work zero not set on Y - travel on Y is unchecked until you set it.',
      'Work zero not set on Z - travel on Z is unchecked until you set it.',
    ])
  })
})
