// @vitest-environment jsdom

import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')

const MACHINE_ID = 'wo-1711-machine'
const PARK = { id: 'rear-park', name: 'Rear', x: 8, y: 9, z: 5 }
const CLAMP_PAUSE_MACRO = {
  id: 'clamp-pause-m2001',
  name: 'Clamp pause',
  mCode: 2001,
  body: 'clampPause()',
}
const M2001_PROGRAM = [
  'G21 G90 G54',
  'G0 X0 Y0 Z2',
  'M2001',
  'M0',
  'G0 X4 Y0 Z2',
  'M30',
  '',
].join('\n')

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function consoleMessage(fragment: string): string {
  return useMachineControl.getState().consoleLines.find(({ text }) => text.includes(fragment))?.text ?? ''
}

async function connectFixture(withPark: boolean): Promise<void> {
  useCamStore.getState().newProject()
  const base = useCamStore.getState().project.machine
  const macros = withPark
    ? [{
        id: PARK.id,
        name: PARK.name,
        body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
        usedForToolChange: true,
      }]
    : []
  useCamStore.getState().setProjectMachine({
    ...base,
    id: MACHINE_ID,
    name: 'WO-1711 fixture',
    controller: 'uccnc',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000,
    safeZMachine: PARK.z,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 200 },
    },
    macros: [...macros, CLAMP_PAUSE_MACRO],
  })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })

  const connecting = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connecting
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await advance(2000)
  for (const axis of ['X', 'Y', 'Z'] as const) {
    setWorkOffsetValue('G54', axis, 0)
    await advance(50)
  }
}

describe('WO-1711 park remedies name the Macros panel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
  })

  afterEach(async () => {
    cancelGuidedToolChange()
    if (useMachineControl.getState().connectionPhase !== 'disconnected') {
      const disconnecting = disconnectMachine()
      await vi.advanceTimersByTimeAsync(100)
      await disconnecting
    }
    vi.useRealTimers()
  })

  it('points both real no-park paths to the Macros panel, not Machine actions', async () => {
    await connectFixture(false)

    const pendant = await executePendantMachineCommand(
      { kind: 'macro', id: 'park-rear' },
      { clientId: 'wo-1711', emit: () => {} },
    )
    expect(pendant.ok).toBe(false)
    expect(pendant.error).toContain('Macros panel')
    expect(pendant.error).toContain('Edit macros')
    expect(pendant.error).not.toContain('Machine actions')

    expect(loadGcodeTextToolpathProgram('wo1711-no-park.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(5000)

    const clampMessage = consoleMessage('could not park')
    expect(clampMessage).toContain('Macros panel')
    expect(clampMessage).toContain('Edit macros')
    expect(clampMessage).not.toContain('Machine actions')
    expect(useMachineControl.getState().job.phase).toBe('paused')
  })

  it('keeps pendant and M2001 park moves at the macro position', async () => {
    await connectFixture(true)

    expect(await executePendantMachineCommand(
      { kind: 'macro', id: 'park-rear' },
      { clientId: 'wo-1711', emit: () => {} },
    )).toEqual({ ok: true })
    await advance(10_000)
    expect(useMachineControl.getState().mpos).toMatchObject({ x: PARK.x, y: PARK.y, z: PARK.z })

    expect(loadGcodeTextToolpathProgram('wo1711-with-park.nc', M2001_PROGRAM)).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10_000)

    const parked = useMachineControl.getState()
    expect(parked.job.phase).toBe('paused')
    expect(parked.toolChange).toMatchObject({ mode: 'clampPause', step: 'awaiting-swap' })
    expect(parked.mpos).toMatchObject({ x: PARK.x, y: PARK.y, z: PARK.z })
  })
})
