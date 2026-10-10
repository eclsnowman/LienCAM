// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig } from '../../types'
import { typedMock } from '../support/typedMock'

type BridgeHostModule = typeof import('../../lib/machine/bridgeHost')

const host = vi.hoisted(() => ({
  capability: 'hosted' as 'hosted' | 'supervisor' | 'unhosted',
  restart: vi.fn<BridgeHostModule['restartBridge']>(),
  status: vi.fn<BridgeHostModule['bridgeProcessStatus']>(),
}))

vi.mock('../../lib/machine/bridgeHost', () =>
  typedMock<BridgeHostModule>({
    bridgeHostCapability: () => host.capability,
    bridgeProcessStatus: host.status,
    restartBridge: host.restart,
  }))

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

const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  buildContractEvents,
} = await import('../../lib/machine/machineSession')

const RECOVERY = 'Bridge recovery complete. The machine is connected.'

function machine(): MachineConfig {
  return {
    id: 'wo1553-uccnc',
    name: 'WO-1553 uccnc',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 },
    rapidRate: 6000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

function seedMachine(): MachineConfig {
  const selected = machine()
  useCamStore.setState((state) => ({
    machineLibrary: [selected],
    project: { ...state.project, machine: selected },
    control: { ...state.control, activeMachineId: selected.id },
  }))
  return selected
}

function seedPresence(overrides: Partial<ReturnType<typeof useMachineControl.getState>> = {}): void {
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    connectionKind: null,
    connectionDetail: null,
    machineState: 'idle',
    homed: false,
    bridgeControllerPresence: 'unknown',
    bridgeProcessPresence: 'running',
    consoleLines: [],
    job: { ...state.job, phase: 'empty' },
    ...overrides,
  }))
}

/** Every store update and every real contract event must land inside act(),
 *  the same single synthetic session the Control page's nav bar drives. */
function phase(phaseName: 'connecting' | 'connected' | 'disconnected', detail: string | null): void {
  act(() => buildContractEvents().onConnectionPhase!(phaseName, detail))
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

function recoveryLines(): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((text) => text === RECOVERY)
}

beforeEach(() => {
  cleanup()
  memory.clear()
  host.capability = 'hosted'
  host.restart.mockReset()
  host.status.mockReset()
  host.status.mockResolvedValue(null)
  __resetEstopInterlockForTest()
  seedMachine()
  seedPresence()
  useUiPrefs.setState({ collapsedPropsGroups: {}, machineJogContinuous: false })
  useCamStore.getState().closeModal()
})

afterEach(() => {
  cleanup()
  useCamStore.getState().closeModal()
  __resetEstopInterlockForTest()
})

describe('WO-1553 first connect is not a recovery', () => {
  it('prints no recovery line when a fresh session connects for the first time', () => {
    // The board sequence: app starts, bridge process already running, socket
    // still closed. The pre-connect bridge chip is shown, but nothing was lost.
    seedPresence({
      connectionPhase: 'disconnected',
      connectionKind: null,
      connectionDetail: 'socket closed',
      machineState: 'idle',
      bridgeProcessPresence: 'running',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    act(() => useMachineControl.getState().setConnectionKind('bridge'))
    phase('connecting', null)
    phase('connected', null)

    expect(useMachineControl.getState().connectionPhase).toBe('connected')
    expect(consoleText()).not.toContain('Bridge recovery complete.')
    expect(recoveryLines()).toHaveLength(0)
  })

  it('prints the recovery once after a real loss and restore in the same session', () => {
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    act(() => useMachineControl.getState().setConnectionKind('bridge'))
    phase('connecting', null)
    phase('connected', null)
    expect(recoveryLines()).toHaveLength(0)

    // The bridge is genuinely lost this session - a real presence issue.
    phase('disconnected', 'socket closed')
    expect(consoleText()).toContain('Not connected to the bridge')
    expect(recoveryLines()).toHaveLength(0)

    act(() => useMachineControl.getState().setConnectionKind('bridge'))
    phase('connecting', null)
    phase('connected', null)

    expect(recoveryLines()).toHaveLength(1)
  })

  it('stays silent on a first connect even with no observed pre-connect incident', () => {
    seedPresence({
      connectionPhase: 'disconnected',
      connectionKind: null,
      connectionDetail: null,
      machineState: 'idle',
      bridgeProcessPresence: 'unknown',
    })
    render(<ControlTransportBar sections="nav" selectedConnectionKind="bridge" />)

    act(() => useMachineControl.getState().setConnectionKind('bridge'))
    phase('connecting', null)
    phase('connected', null)

    expect(recoveryLines()).toHaveLength(0)
  })
})
