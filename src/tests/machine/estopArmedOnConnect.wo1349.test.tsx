// @vitest-environment jsdom

import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  reportIdle(): void
  drop(reason: string): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
}

const IDLE_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: null,
  workPos: null,
  feedMmMin: null,
  spindleRpm: null,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: {
    estop: false,
    hardLimit: false,
    softLimit: false,
    probe: false,
    limits: null,
    door: null,
    hold: false,
  },
  homed: null,
  spindle: null,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'WO-1349 fake bridge',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'queryStatus') this.reportIdle()
      this.emit({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: message.m === 'resetToIdle' ? { ok: true, reason: null } : true,
      })
    }

    reportIdle(): void {
      this.emit({ t: 'status', v: IDLE_STATUS })
    }

    /** The bridge socket goes away underneath a live session. */
    drop(reason: string): void {
      const events = this.fakeEvents
      this.fakeEvents = null
      events?.onClose(reason)
    }

    async close(): Promise<void> {
      this.fakeEvents = null
    }

    private emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { useControlJogKeys } = await import('../../hooks/useControlJogKeys')
const { useCamStore } = await import('../../store')
const session = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')

async function connectAndReportIdle(): Promise<FakeBridgeTransport> {
  await act(async () => { await session.connectMachine('bridge') })
  const current = bridge.last
  if (!current) throw new Error('The fake bridge was not installed.')
  act(() => { current.reportIdle() })
  return current
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  bridge.last = null
  useMachineControl.setState({ consoleLines: [], homed: false })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
})

describe('WO-1349 every fresh connection starts with the E-STOP armed', () => {
  it('distinguishes the fresh-connect interlock from an actual E-STOP trip on the state chip', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectAndReportIdle()

    expect(session.estopNeedsReset()).toBe(true)
    expect(session.estopTripNeedsReset()).toBe(false)
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Idle')

    act(() => { session.triggerEmergencyStop() })

    expect(session.estopTripNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-state-chip').textContent).toBe('E-STOP')
  })

  it('keeps an idle fake bridge armed, refuses homing, clears deliberately, and re-arms on reconnect', async () => {
    render(<ControlTransportBar sections="row" />)
    let current = await connectAndReportIdle()

    // Repins WO-1182 deliberately: an idle, E-STOP-open report must NOT
    // auto-release Operator's fresh-connection latch.
    expect(session.estopNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('needs-reset')
    expect(screen.getByTestId('control-estop').className).toContain('control-estop-needs-reset')
    expect(screen.getByTestId('control-estop').textContent).toContain('CLEAR')

    const controller = session.getMachineController()
    const sentBeforeHome = current.sent.length
    expect(controller.homeAxes?.(['Z', 'X', 'Y'])).toBe(false)
    expect(controller.home()).toBe(false)
    expect(current.sent.slice(sentBeforeHome).some((message) =>
      message.m === 'homeAxes' || message.m === 'home',
    )).toBe(false)
    expect(useMachineControl.getState().consoleLines.some((line) =>
      line.severity === 'error' && line.text.includes('software stop'),
    )).toBe(true)

    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(session.estopNeedsReset()).toBe(false)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('armed')
    expect(controller.homeAxes?.(['Z', 'X', 'Y'])).toBe(true)
    expect(current.sent.some((message) => message.m === 'homeAxes')).toBe(true)

    await act(async () => { await session.disconnectMachine() })
    current = await connectAndReportIdle()

    // "Fresh" means every connection, including one already cleared earlier
    // in this app session.
    expect(session.estopNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('needs-reset')
    expect(current.sent.some((message) => message.m === 'homeAxes')).toBe(false)
  })

  // Operator 2026-09-14 at the machine, "A: Flash, all motion off": the blink
  // stays, and while it blinks NO motion reaches the controller - jog was
  // the gap (a jog press went straight to the bridge) - and every motion
  // control is dead, not merely refused.
  it('refuses jog, continuous jog and Step Back while armed, greys the jog panel, and lets jog through after CLEAR', async () => {
    render(<><ControlTransportBar sections="row" /><JogPanel /></>)
    const current = await connectAndReportIdle()
    expect(session.estopNeedsReset()).toBe(true)

    const controller = session.getMachineController()
    const sentBefore = current.sent.length
    expect(controller.jog('X', 1, 1000)).toBe(false)
    if (controller.jogStartContinuous) {
      expect(await controller.jogStartContinuous('Y', 1, 1000)).toBe(false)
    }
    expect(current.sent.slice(sentBefore).some((message) =>
      message.m.toLowerCase().includes('jog'),
    )).toBe(false)

    // A loaded program, so Step Back gets past "no program" and the connection
    // check and is refused by the latch itself.
    useMachineControl.setState({ programText: 'G21\nG0 X0 Y0\nG1 X1 F100' })
    const stepBack = await session.stepBackOneLine()
    expect(stepBack.ok).toBe(false)
    expect(stepBack.ok ? '' : stepBack.reason).toBe(session.ESTOP_BLOCKS_MOTION)

    const homeAll = screen.getByTestId('control-home') as HTMLButtonElement
    expect(homeAll.disabled).toBe(true)
    expect(homeAll.getAttribute('data-tooltip')).toBe(session.ESTOP_BLOCKS_MOTION)
    expect((screen.getByTestId('control-jog-x-plus') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('control-unlock') as HTMLButtonElement).getAttribute('data-tooltip'))
      .not.toBe(session.ESTOP_BLOCKS_MOTION)
    expect(controller.jog('X', 1, 1000)).toBe(true)
    expect(current.sent.slice(sentBefore).some((message) =>
      message.m.toLowerCase().includes('jog'),
    )).toBe(true)
  })

  // Operator 2026-09-14 at the machine: "We will also test a disconnect and a
  // reconnect which should force the clear again anytime." A CLEAR never
  // carries across a connection: a bridge that drops and is reconnected
  // flashes again and refuses motion until the operator clears it by hand.
  it('a dropped bridge and a Reconnect re-arm the E-STOP; a CLEAR from the old connection does not carry over', async () => {
    render(<ControlTransportBar sections="row" />)
    let current = await connectAndReportIdle()
    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(session.estopNeedsReset()).toBe(false)

    act(() => { current.drop('bridge socket closed') })
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(session.estopNeedsReset()).toBe(true)

    // Reconnect: a new connection, and the old CLEAR is gone.
    current = await connectAndReportIdle()
    expect(session.estopNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('needs-reset')

    const controller = session.getMachineController()
    const sentBefore = current.sent.length
    expect(controller.jog('Z', 1, 500)).toBe(false)
    expect(controller.home()).toBe(false)
    expect(current.sent.slice(sentBefore).some((message) =>
      message.m.toLowerCase().includes('jog') || message.m === 'home' || message.m === 'homeAxes',
    )).toBe(false)

    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(controller.jog('Z', 1, 500)).toBe(true)
  })

  // WO-328's own result named the arrow-key path (useControlJogKeys) as the
  // other door to jog that nothing gated. It calls getMachineController().jog,
  // so the backend refusal is what must stop it - and say why in the console.
  it('an arrow-key jog under the blinking E-STOP never reaches the bridge and says why', async () => {
    function KeyHost() { useControlJogKeys(); return null }
    render(<KeyHost />)
    const current = await connectAndReportIdle()
    expect(session.estopNeedsReset()).toBe(true)
    useCamStore.setState({ workspace: 'control', activeModal: null })
    useMachineControl.setState({ consoleLines: [] })

    const sentBefore = current.sent.length
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(current.sent.slice(sentBefore).some((message) =>
      message.m.toLowerCase().includes('jog'),
    )).toBe(false)
    expect(useMachineControl.getState().consoleLines.some((line) =>
      line.severity === 'error' && line.text.includes(session.ESTOP_BLOCKS_MOTION),
    )).toBe(true)
  })
})
