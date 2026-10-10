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

function axisLabel(axis: 'X' | 'Y' | 'Z'): HTMLElement {
  return screen.getByTestId(`control-dro-${axis.toLowerCase()}`)
    .querySelector<HTMLElement>('.control-dro-axis')!
}

function expectAxis(axis: 'X' | 'Y' | 'Z', homed: boolean): void {
  const label = axisLabel(axis)
  expect(label).toHaveProperty('title', `${axis} ${homed ? 'homed this session' : 'not homed'}`)
  expect(label.classList.contains('control-dro-axis-homed')).toBe(homed)
}

function publishRenderState(
  connectionPhase: 'connected' | 'disconnected',
  homed: boolean,
  x: number,
): void {
  act(() => useMachineControl.setState({
    connectionPhase,
    machineState: connectionPhase === 'connected' ? 'idle' : 'unknown',
    homed,
    mpos: connectionPhase === 'connected' ? { x, y: 2, z: 3 } : null,
    wpos: connectionPhase === 'connected' ? { x, y: 2, z: 3 } : null,
  }))
}

describe('WO-1119 DRO per-axis homing glow', () => {
  beforeEach(() => {
    readReportedHomed.mockClear()
    reportedHomed = { X: true, Y: true, Z: true }
    fallbackHomed = false
    useMachineControl.setState({
      connectionPhase: 'connected', machineState: 'idle', homed: true,
      mpos: { x: 1, y: 2, z: 3 }, wpos: { x: 1, y: 2, z: 3 },
      settings: {}, consoleLines: [],
    })
  })

  afterEach(() => cleanup())

  it('drops an axis on the same frame and clears every stale glow across reconnect', () => {
    render(<ControlPage />)

    expectAxis('X', true)
    expectAxis('Y', true)
    expectAxis('Z', true)
    expect(readReportedHomed).toHaveBeenCalled()
    expect(screen.getByTestId('control-homed-led').classList).toContain('control-led-ok')

    reportedHomed = { X: true, Y: false, Z: true }
    publishRenderState('connected', true, 4)
    expectAxis('X', true)
    expectAxis('Y', false)
    expectAxis('Z', true)
    // The existing whole-machine lamp still follows only the store's aggregate.
    expect(screen.getByTestId('control-homed-led').classList).toContain('control-led-ok')

    publishRenderState('disconnected', false, 5)
    expectAxis('X', false)
    expectAxis('Y', false)
    expectAxis('Z', false)
    expect(screen.queryByTestId('control-homed-led')).toBeNull()

    reportedHomed = null
    fallbackHomed = false
    publishRenderState('connected', false, 6)
    expectAxis('X', false)
    expectAxis('Y', false)
    expectAxis('Z', false)
    expect(screen.getByTestId('control-homed-led').classList).not.toContain('control-led-ok')
  })

  it('uses the whole-session fallback only when no per-axis answer exists', () => {
    reportedHomed = null
    fallbackHomed = true
    render(<ControlPage />)

    expectAxis('X', true)
    expectAxis('Y', true)
    expectAxis('Z', true)

    fallbackHomed = false
    publishRenderState('connected', false, 7)
    expectAxis('X', false)
    expectAxis('Y', false)
    expectAxis('Z', false)
  })
})
