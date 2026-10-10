// @vitest-environment jsdom
//
// WO-1079 - power calculated from volts x amps is apparent power (VA), not
// measured real power (W). That provenance label lived on the panel's inline
// power segment.
//
// WO-1793 (Operator MC 2026-09-20) retired that segment from the telemetry row:
// the row now shows ONLY the three measurements he named - volts, amps and
// torque - with no static "Inverter" caption and no inline power field, for a
// derived OR a register power definition alike. The decode still computes
// apparent power honestly (src/lib/machine/vfd, pinned by
// vfdDecode.wo441.test.ts); what changed here is presentation only. This
// file keeps the WO-1079 provenance fixtures and pins the new row contract:
// the same three values, and the power field absent whichever source the
// machine document states.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type {
  ConnectionPhase,
  LoadOutcome,
  MachineController,
  MachineState,
  MachineStatus,
  StreamerProgress,
} from '../../lib/machine/controller'
import type {
  MachineActionResult,
  SpindleCommandResult,
  SpindleRoute,
} from '../../lib/machine/machineSession'
import type { MachineConfig, MachineSpindleLinkDefinition } from '../../types'
import type { VfdStatusField } from '../../lib/machine/vfd'
import { typedMock } from '../support/typedMock'

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

const liveSpindle: NonNullable<MachineStatus['spindle']> = {
  volts: 230,
  amps: 5,
  torque: 40,
  power: 1150,
  upToSpeed: true,
  running: false,
  linkUp: true,
}
/** Mutable so a test can put the row in its honest null state. */
let reportedSpindle: NonNullable<MachineStatus['spindle']> = liveSpindle

function emptyJobProgress(): StreamerProgress {
  return {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
}

function stubMachineController(): MachineController {
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: false, perAxisHoming: false, ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn((): MachineStatus => ({
      state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null,
      spindleRpm: null, overrides: null, executingMoveId: null, buffer: null,
      inputs: null, homed: null, spindle: reportedSpindle,
    })),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => false),
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
    jobProgress: vi.fn(emptyJobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  // WO-2237: SpindlePanel reads the tool-change hold and the kept-pause verdict.
  subscribeToolChangeHold: () => () => {},
  toolChangeHoldActive: () => false,
  subscribePausedProgramTakesCommands: () => () => {},
  pausedProgramTakesCommands: () => false,
  getMachineController: vi.fn(stubMachineController),
  runMachineAction: vi.fn((): MachineActionResult => ({ ok: true, sent: 1 })),
  spindleRoute: vi.fn((): SpindleRoute => 'calls'),
  commandSpindle: vi.fn((): SpindleCommandResult => ({ ok: true, route: 'calls' })),
}))

const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { HUANYANG_GT } = await import('../../lib/machine/vfd/huanyangGt')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

function machineWithPowerSource(source: 'derived' | 'register'): MachineConfig {
  const machine = useCamStore.getState().project.machine
  const power: VfdStatusField = source === 'derived'
    ? { name: 'power', source: 'derived', scale: 'field.volts * field.amps' }
    : { name: 'power', source: 'register', offset: 4, scale: 'raw.value' }
  const definition: MachineSpindleLinkDefinition = {
    ...HUANYANG_GT,
    provenance: { kind: 'edited-here', source: 'WO-1079 test' },
    status: HUANYANG_GT.status.map((field) => field.name === 'power' ? power : field),
  }
  return { ...machine, spindleLinkDefinition: definition }
}

function mountWithPowerSource(source: 'derived' | 'register'): void {
  const machine = machineWithPowerSource(source)
  act(() => {
    useCamStore.setState({ project: { ...useCamStore.getState().project, machine } })
    const machineState = useMachineControl.getState()
    useMachineControl.setState({
      connectionPhase: 'connected',
      job: { ...machineState.job, phase: 'empty' },
    })
  })
  render(<SpindlePanel onOpenActions={() => {}} />)
}

const telemetryRow = () => screen.getByTestId('control-spindle-telemetry')
const telemetryValues = () => screen.getByTestId('control-spindle-telemetry-values')

afterEach(cleanup)
beforeEach(() => {
  mem.clear()
  reportedSpindle = liveSpindle
  act(() => { useCamStore.getState().newProject() })
})

describe('WO-1793: the telemetry row shows volts, amps and torque, not the retired power field', () => {
  it('shows the three measurements and no power segment for a derived-power definition', () => {
    mountWithPowerSource('derived')

    expect(telemetryValues().textContent).toContain('230 V')
    expect(telemetryValues().textContent).toContain('5.0 A')
    expect(telemetryValues().textContent).toContain('torque 40')
    // The retired segment: no field, no number, no VA/W label, no tooltip.
    expect(screen.queryByTestId('control-spindle-power')).toBeNull()
    expect(telemetryRow().textContent).not.toContain('1150')
    expect(telemetryRow().textContent).not.toMatch(/\b(VA|W)\b/)
    // The retired caption is gone.
    expect(telemetryRow().textContent).not.toContain('Inverter')
    // Speed state stays outside the three-value span (WO-1793).
    expect(screen.getByTestId('control-spindle-up-to-speed').textContent).toBe('up to speed')
    expect(telemetryValues().textContent).not.toMatch(/up to speed|ramping/)
  })

  it('shows the same three measurements for a register-power definition, power still off the row', () => {
    mountWithPowerSource('register')

    expect(telemetryValues().textContent).toContain('230 V')
    expect(telemetryValues().textContent).toContain('5.0 A')
    expect(telemetryValues().textContent).toContain('torque 40')
    expect(screen.queryByTestId('control-spindle-power')).toBeNull()
    expect(telemetryRow().textContent).not.toMatch(/\b(VA|W)\b/)
  })

  it('keeps the honest null placeholders when the drive reports nothing for a field', () => {
    reportedSpindle = {
      volts: null, amps: null, torque: null, power: null,
      upToSpeed: null, running: false, linkUp: true,
    }
    mountWithPowerSource('derived')

    expect(telemetryValues().textContent).toContain('-- V')
    expect(telemetryValues().textContent).toContain('-- A')
    expect(telemetryValues().textContent).toContain('torque --')
    expect(screen.queryByTestId('control-spindle-power')).toBeNull()
    // No speed state reported: no up-to-speed/ramping word.
    expect(screen.queryByTestId('control-spindle-up-to-speed')).toBeNull()
  })
})
