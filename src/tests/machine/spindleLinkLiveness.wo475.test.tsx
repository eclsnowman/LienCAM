// @vitest-environment jsdom
// WO-475 - the spindle buttons follow the LINK, not the plan.
//
// `hello.vfd.present` is `vfd != null` in the bridge: it means "--vfd was
// passed", and it stays TRUE when the serial port failed to open. Observed
// directly 2026-08-22 with COM3 held by another process - the bridge logged
// "the spindle link did not open" and the UI still showed the link present
// with every button live. The capability is right to be static; liveness is a
// live question and belongs in status.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { create } from 'zustand'
// Imported BEFORE UccncController/SpindlePanel below on purpose: those
// transitively trigger this file's mock factories during THEIR static-import
// resolution. A `typedMock` import placed after them left a factory closing
// over a binding not yet initialized - "Cannot access '__vi_import_N__'
// before initialization" (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type {
  ConnectionPhase, ControllerCapabilities, LoadOutcome, MachineController, MachineState, MachineStatus,
  StreamerProgress,
} from '../../lib/machine/controller'
import { SpindlePanel } from '../../components/machine/SpindlePanel'

// ---- half 1: the controller reports liveness honestly --------------------

const CAPS: ControllerCapabilities = {
  geometryQueue: true, executingMoveId: true, bufferSeconds: true,
  gcodeText: false, perAxisHoming: true,
  ownsSpindle: false, spindleCommands: false,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(): void {}
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
}

async function connected() {
  const transport = new FakeTransport()
  const ctrl = new UccncController({})
  const connecting = ctrl.connect({ kind: 'messages', transport } as never)
  await Promise.resolve()
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL, bridge: 'b/0.4', capabilities: CAPS,
      readOnly: false, vfd: { present: true, verified: false, name: 'Huanyang GT' },
    },
  })
  await connecting
  // A status frame, so there is something for the vfd push to patch onto.
  transport.emit({
    t: 'status',
    v: {
      state: 'idle', subState: null, machinePos: null, workPos: null,
      feedMmMin: null, spindleRpm: null, overrides: null, executingMoveId: null,
      buffer: null, inputs: null, homed: null, spindle: null,
    } as MachineStatus,
  })
  return { ctrl, transport }
}

const push = (transport: FakeTransport, up: boolean) =>
  transport.emit({
    t: 'vfd',
    v: {
      up, running: false, faulted: false, runStateWord: 3, commandWord: 5,
      setpointWord: 0, consecutiveFailures: up ? 0 : 11,
      lastStopReason: 'commanded', lastError: null,
      statusWords: up ? [45, 18, 0, 0, 9] : [], status: {}, upToSpeed: null,
    },
  })

describe('WO-475: the controller reports whether the inverter ANSWERED', () => {
  it('is null before any sample - unknown is not the same claim as down', async () => {
    const { ctrl } = await connected()
    expect(ctrl.status().spindle?.linkUp).toBeNull()
  })

  it('is true when the inverter answered', async () => {
    const { ctrl, transport } = await connected()
    push(transport, true)
    expect(ctrl.status().spindle?.linkUp).toBe(true)
  })

  it('is FALSE when the link is down, even though the link is configured', async () => {
    const { ctrl, transport } = await connected()
    push(transport, false)
    // The whole defect: present/configured says yes, the wire says no.
    expect(ctrl.capabilities.spindleCommands).toBe(true)
    expect(ctrl.status().spindle?.linkUp).toBe(false)
  })
})

// ---- half 2: the panel acts on it ----------------------------------------

const spindleStatus = (linkUp: boolean | null) => ({
  volts: null, amps: null, torque: null, power: null, upToSpeed: null, running: null, linkUp,
})

let telemetry: ReturnType<typeof spindleStatus> | null = null

/** A full MachineController stub - this suite only varies `status().spindle`,
 *  but the module's real `getMachineController` returns a genuine
 *  `MachineController` (same shape as collapsedSummaryTruth.wo959.test.tsx's
 *  stubMachineController). */
function stubMachineController(): MachineController {
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
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
    status: () => ({
      state: 'idle', subState: null, machinePos: null, workPos: null, feedMmMin: null, spindleRpm: null,
      overrides: null, executingMoveId: null, buffer: null, inputs: null, homed: null, spindle: telemetry,
    }),
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
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  // WO-2237: SpindlePanel reads the tool-change hold and the kept-pause verdict.
  subscribeToolChangeHold: () => () => {},
  toolChangeHoldActive: () => false,
  subscribePausedProgramTakesCommands: () => () => {},
  pausedProgramTakesCommands: () => false,
  getMachineController: () => stubMachineController(),
  runMachineAction: () => ({ ok: true, sent: 1 }),
  spindleRoute: () => 'calls',
  commandSpindle: () => ({ ok: true, route: 'calls' }),
  estopNeedsReset: () => false,
}))

vi.mock('../../store/machineControlStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/machineControlStore')>()
  const initial = actual.useMachineControl.getState()
  return typedMock<typeof import('../../store/machineControlStore')>({
    ...actual,
    useMachineControl: create<typeof initial>()(() => ({
      ...initial,
      connectionPhase: 'connected', job: { ...initial.job, phase: 'empty' }, spindleRpm: null,
      reportedAccessories: { spindle: 'off', mist: false, flood: false },
    })),
  })
})

afterEach(cleanup)
beforeEach(() => { telemetry = null })

describe('WO-475: the panel follows the link', () => {
  it('disables STARTING when the inverter is not answering', () => {
    telemetry = spindleStatus(false)
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect((screen.getByTestId('control-spindle-cw') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('control-spindle-ccw') as HTMLButtonElement).disabled).toBe(true)
  })

  it('NEVER disables the stop, which is exactly what a dead link invites', () => {
    telemetry = spindleStatus(false)
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect((screen.getByTestId('control-spindle-off') as HTMLButtonElement).disabled).toBe(false)
  })

  it('says why, in the tooltip, rather than going quietly dead', () => {
    telemetry = spindleStatus(false)
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect(screen.getByTestId('control-spindle-cw').getAttribute('data-tooltip'))
      .toMatch(/not answering/i)
  })

  it('leaves the buttons alone when the link is up', () => {
    telemetry = spindleStatus(true)
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect((screen.getByTestId('control-spindle-cw') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does NOT withhold the buttons merely because liveness is unknown', () => {
    // null is "no sample yet", not "down". Treating unknown as down would
    // disable the spindle for the first half-second of every connection.
    telemetry = spindleStatus(null)
    render(<SpindlePanel onOpenActions={() => {}} />)
    expect((screen.getByTestId('control-spindle-cw') as HTMLButtonElement).disabled).toBe(false)
  })
})
