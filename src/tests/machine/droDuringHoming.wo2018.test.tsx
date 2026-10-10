// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionPhase,
  LoadOutcome,
  MachineController,
  MachineState,
  MachineStatus,
  StreamerProgress,
} from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

let reportedHomed: MachineStatus['homed'] = null
let fallbackHomed = false
const readReportedHomed = vi.fn(() => reportedHomed!)

function stubMachineController(): MachineController {
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: false, perAxisHoming: true, ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn((): MachineStatus => ({
      state: 'idle', subState: null,
      machinePos: { x: 1, y: 2, z: 3 },
      workPos: { x: 1, y: 2, z: 3 },
      feedMmMin: 0, spindleRpm: 0, overrides: null,
      executingMoveId: null, buffer: null, inputs: null,
      homed: reportedHomed, spindle: null,
    })),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => fallbackHomed),
    get homedAxesThisSession() {
      return reportedHomed === null ? undefined : readReportedHomed
    },
    resetInProgress: vi.fn(() => false),
    subscribeResetInProgress: vi.fn(() => () => {}),
    jog: vi.fn(() => true),
    jogToWorkXY: vi.fn(() => true),
    jogToMachineZ: vi.fn(() => true),
    jogCancel: vi.fn(),
    home: vi.fn(() => true),
    feedHold: vi.fn(),
    cycleResume: vi.fn(() => true),
    reset: vi.fn(),
    unlock: vi.fn(() => true),
    emergencyStop: vi.fn(),
    resetToIdle: vi.fn(async () => ({ ok: true, reason: null })),
    setOverride: vi.fn(),
    selectWcs: vi.fn(() => true),
    zeroWorkAxis: vi.fn(() => true),
    probe: vi.fn(async () => ({ ok: true, at: null })),
    sendCommand: vi.fn(() => true),
    sendCommandAwait: vi.fn(async () => ({ ok: true, message: null })),
    loadJob: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    loadJobFrom: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    startJob: vi.fn(() => true),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(() => true),
    stopJob: vi.fn(),
    stepJob: vi.fn(() => true),
    setSingleBlockMode: vi.fn(),
    singleBlockMode: vi.fn(() => false),
    hasActiveJob: vi.fn(() => false),
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

const controller = stubMachineController()

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    getMachineController: vi.fn(() => controller),
    controllerCapabilities: vi.fn(() => controller.capabilities),
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')


function cell(kind: 'work' | 'machine', axis: 'X' | 'Y' | 'Z'): string {
  return screen.getByTestId(`control-dro-${kind}-${axis.toLowerCase()}`).textContent
    ?? (screen.getByTestId(`control-dro-${kind}-${axis.toLowerCase()}`) as HTMLInputElement).value
}

function shown(kind: 'work' | 'machine', axis: 'X' | 'Y' | 'Z'): string {
  const el = screen.getByTestId(`control-dro-${kind}-${axis.toLowerCase()}`) as HTMLInputElement
  return el.value ?? cell(kind, axis)
}

describe('WO-2018 DRO during Home All', () => {
  beforeEach(() => {
    fallbackHomed = false
    reportedHomed = { X: false, Y: false, Z: false }
    useMachineControl.setState({
      connectionPhase: 'connected', machineState: 'home', homed: false,
      mpos: { x: 10, y: 20, z: 128.9 }, wpos: { x: 10, y: 20, z: 128.9 },
      settings: {}, consoleLines: [],
    })
  })
  afterEach(() => cleanup())

  it('shows a homed axis at once while unhomed axes stay dashed', () => {
    render(<ControlPage />)
    for (const a of ['X', 'Y', 'Z'] as const) {
      expect(shown('machine', a)).toBe('---')
      expect(shown('work', a)).toBe('---')
    }

    // Z homes; the aggregate stays false until the cycle ends.
    reportedHomed = { X: false, Y: false, Z: true }
    act(() => useMachineControl.setState({ mpos: { x: 11, y: 21, z: 128.9 }, wpos: { x: 11, y: 21, z: 128.9 } }))
    expect(shown('machine', 'Z')).toContain('128.9')
    expect(shown('work', 'Z')).toContain('128.9')
    expect(shown('machine', 'X')).toBe('---')
    expect(shown('machine', 'Y')).toBe('---')
    expect(shown('work', 'X')).toBe('---')

    // End state: everything homed, aggregate true.
    reportedHomed = { X: true, Y: true, Z: true }
    act(() => useMachineControl.setState({ homed: true, machineState: 'idle' }))
    for (const a of ['X', 'Y', 'Z'] as const) {
      expect(shown('machine', a)).not.toBe('---')
      expect(shown('work', a)).not.toBe('---')
    }
  })
})
