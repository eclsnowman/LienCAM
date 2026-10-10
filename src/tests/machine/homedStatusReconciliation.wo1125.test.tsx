// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  emit(message: BridgeMessage): void
}

const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      fakeBridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'fake-bridge 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const session = await import('../../lib/machine/machineSession')

const BASE_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: { x: -10, y: -20, z: -30 },
  workPos: { x: -10, y: -20, z: -30 },
  feedMmMin: 0,
  spindleRpm: 0,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: null,
  homed: null,
  spindle: null,
}

function report(homed: MachineStatus['homed']): void {
  fakeBridge.last!.emit({ t: 'status', v: { ...BASE_STATUS, homed } })
}

function machineDro(axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-machine-${axis}`) as HTMLInputElement
}

function axisLabel(axis: 'x' | 'y' | 'z'): HTMLElement {
  return screen.getByTestId(`control-dro-${axis}`).querySelector('.control-dro-axis')!
}

function commit(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(async () => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    controller: 'uccnc',
    rapidRate: 5000,
    noHomingSwitches: false,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  await session.connectMachine('bridge')
  // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about homed-
  // status reconciliation and the resulting DRO goto, not the fresh-connect
  // E-STOP latch.
  session.__resetEstopInterlockForTest()
})

afterEach(async () => {
  cleanup()
  await session.disconnectMachine()
  vi.useRealTimers()
})

describe('WO-1125 continuous homed-state reconciliation', () => {
  it('recovers on reconnect from homed=111 with no homed push, and permits a machine goto', () => {
    act(() => report({ X: true, Y: true, Z: true }))

    const ctrl = session.getMachineController()
    expect(ctrl.homedAxesThisSession?.()).toEqual({ X: true, Y: true, Z: true })
    expect(useMachineControl.getState().homed).toBe(true)

    render(<ControlPage />)
    expect(machineDro('x').value).toBe('-10.00')
    expect(machineDro('y').value).toBe('-20.00')
    expect(machineDro('z').value).toBe('-30.00')
    expect(screen.queryByTestId('control-datum-chip')).toBeNull()

    commit(machineDro('x'), '-11.000')

    const jogCalls = fakeBridge.last!.sent.filter((message) => message.m === 'jog')
    expect(jogCalls).toHaveLength(1)
    expect(jogCalls[0]?.a).toEqual({ axis: 'X', deltaMm: -1, feedMmMin: 5000 })
  })

  it('keeps unaffected axes homed when one reported axis is invalidated', () => {
    act(() => report({ X: false, Y: true, Z: true }))
    render(<ControlPage />)

    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: false,
      Y: true,
      Z: true,
    })
    expect(useMachineControl.getState().homed).toBe(false)
    expect(axisLabel('x').classList).not.toContain('control-dro-axis-homed')
    expect(axisLabel('y').classList).toContain('control-dro-axis-homed')
    expect(axisLabel('z').classList).toContain('control-dro-axis-homed')
  })

  it('follows a bridge restart down to homed=000', () => {
    act(() => report({ X: true, Y: true, Z: true }))
    expect(useMachineControl.getState().homed).toBe(true)

    act(() => report({ X: false, Y: false, Z: false }))

    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: false,
      Y: false,
      Z: false,
    })
    expect(useMachineControl.getState().homed).toBe(false)
  })

  it('revokes the store before a position-lost alarm can authorize another goto', () => {
    act(() => report({ X: true, Y: true, Z: true }))
    render(<ControlPage />)
    expect(useMachineControl.getState().homed).toBe(true)

    act(() => {
      fakeBridge.last!.emit({
        t: 'alarm',
        v: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })

    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: false,
      Y: false,
      Z: false,
    })
    expect(useMachineControl.getState().homed).toBe(false)
    expect(useMachineControl.getState().alarm).toMatchObject({ code: 1, positionLost: true })

    commit(machineDro('x'), '-11.000')
    expect(fakeBridge.last!.sent.filter((message) => message.m === 'jog')).toHaveLength(0)

    act(() => report({ X: true, Y: true, Z: true }))
    expect(useMachineControl.getState().homed).toBe(false)
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: false,
      Y: false,
      Z: false,
    })
  })

  it('keeps datum revoked when connectMachine constructs a new controller', async () => {
    act(() => report({ X: true, Y: true, Z: true }))
    render(<ControlPage />)
    const firstController = session.getMachineController()
    const machineId = useCamStore.getState().project.machine.id

    act(() => {
      fakeBridge.last!.emit({
        t: 'alarm',
        v: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y', 'Z'])

    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('bridge') })
    expect(session.getMachineController()).not.toBe(firstController)

    act(() => report({ X: true, Y: true, Z: true }))
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: false,
      Y: false,
      Z: false,
    })
    expect(useMachineControl.getState().homed).toBe(false)
    expect(useMachineControl.getState().consoleLines.some((line) =>
      line.text.includes('Machine datum remains revoked after reconnect'))).toBe(true)

    commit(machineDro('x'), '-11.000')
    expect(fakeBridge.last!.sent.filter((message) => message.m === 'jog')).toHaveLength(0)

    act(() => {
      fakeBridge.last!.emit({ t: 'homed', v: { axes: ['Z'] } })
      report({ X: true, Y: true, Z: true })
    })
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y'])
    expect(useMachineControl.getState().homed).toBe(false)

    act(() => {
      fakeBridge.last!.emit({ t: 'homed', v: { axes: ['X', 'Y'] } })
      report({ X: true, Y: true, Z: true })
    })
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toBeUndefined()
    expect(useMachineControl.getState().homed).toBe(true)
  })

  it('does not let a simulator datum clear the physical-machine revocation', async () => {
    act(() => report({ X: true, Y: true, Z: true }))
    const machineId = useCamStore.getState().project.machine.id
    act(() => {
      fakeBridge.last!.emit({
        t: 'alarm',
        v: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })

    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('simulator') })
    expect(session.getMachineController().setMachinePosition?.({ x: 0, y: 0, z: 0 })).toBe(true)

    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y', 'Z'])
  })

  it('does not erase push-derived truth on a keyless frame and ignores non-gate axes', () => {
    fakeBridge.last!.emit({ t: 'homed', v: { axes: ['Z'] } })
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({ Z: true })

    fakeBridge.last!.emit({
      t: 'status',
      v: { ...BASE_STATUS, homed: undefined } as unknown as MachineStatus,
    })
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({ Z: true })

    fakeBridge.last!.emit({
      t: 'status',
      v: {
        ...BASE_STATUS,
        homed: { X: true, Y: true, Z: true, A: true },
      } as unknown as MachineStatus,
    })
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({
      X: true,
      Y: true,
      Z: true,
    })
  })
})
