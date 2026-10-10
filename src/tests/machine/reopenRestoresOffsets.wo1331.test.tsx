// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
  BridgeVfdFrameObserver,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import type { MachineVec3, WcsId } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const STORED_G54: MachineVec3 = { x: 188.732, y: 397.655, z: 110 }
const STORED_G55: MachineVec3 = { x: 288.733, y: 497.656, z: 210 }
const PROFILE_G54: MachineVec3 = { x: 81.2275, y: 61.3225, z: 12.16 }
const PROFILE_G55: MachineVec3 = { x: 0, y: 0, z: 0 }

interface FakeTransportShape {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  reply(call: BridgeCallMessage, value: unknown): void
}

const bridge = vi.hoisted(() => ({
  instances: [] as FakeTransportShape[],
  startupConsole: null as BridgeMessage | null,
}))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport implements FakeTransportShape {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(
      url?: string,
      machineId?: string | null,
      onVfdFrame?: BridgeVfdFrameObserver | null,
    ) {
      super(url, machineId, onVfdFrame)
      bridge.instances.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit(hello({ G54: STORED_G54, G55: STORED_G55 }))
      if (bridge.startupConsole) this.emit(bridge.startupConsole)
    }

    send(message: BridgeCallMessage): void { this.sent.push(message) }
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
    reply(call: BridgeCallMessage, value: unknown): void {
      this.emit({ t: 'reply', seq: call.seq, ok: true, v: value })
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

function hello(offsets: Partial<Record<WcsId, MachineVec3>>): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: 1,
      bridge: 'WO-1331-fake-bridge',
      capabilities: CAPABILITIES,
      readOnly: false,
      workOffsets: { current: offsets, profile: offsets },
    },
  } as BridgeMessage
}

const session = await import('../../lib/machine/machineSession')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

function calls(target: FakeTransportShape, method: string): BridgeCallMessage[] {
  return target.sent.filter((message) => message.m === method)
}

function offsetInput(wcs: string, axis: string): HTMLInputElement | null {
  return screen.queryByTestId(`control-offset-${wcs}-${axis}`) as HTMLInputElement | null
}

async function flushReceipts(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

let machineId = ''

beforeEach(async () => {
  bridge.instances = []
  bridge.startupConsole = null
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  machineId = useCamStore.getState().project.machine.id
  useCamStore.setState({ machineWorkOffsets: {} })
  useCamStore.getState().setMachineWorkOffset(machineId, 'G54', STORED_G54, 'restored')
  useCamStore.getState().setMachineWorkOffset(machineId, 'G55', STORED_G55, 'restored')
  useUiPrefs.setState({ machineOffsetsCollapsed: false })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    connectionKind: null,
    offsets: {},
    consoleLines: [],
  })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
})

describe('WO-1331 durable work offsets follow an in-place controller reopen', () => {
  it('ignores a historical reopen warning replayed at hello and completes connect reconciliation', async () => {
    bridge.startupConsole = {
      t: 'console',
      v: {
        dir: 'rx',
        text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 3) - this link is live - BUT THE BOARD IS NOT CONFIGURED.',
        severity: 'warn',
      },
    }

    await session.connectMachine('bridge')

    const transport = bridge.instances[0]
    expect(calls(transport, 'setWorkOffset')).toEqual([])
    expect(useMachineControl.getState().offsets).toMatchObject({
      G54: [STORED_G54.x, STORED_G54.y, STORED_G54.z],
      G55: [STORED_G55.x, STORED_G55.y, STORED_G55.z],
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('restored')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).not.toContain(
      'Work zero restore skipped - an offset write is already waiting for the bridge to confirm.',
    )
  })

  it('hides stale rows, writes every stored frame sequentially, and republishes only each readback', async () => {
    await session.connectMachine('bridge')
    const transport = bridge.instances[0]
    transport.sent = []
    render(<OffsetsPanel />)

    expect(offsetInput('g54', 'x')?.value).toBe('188.73')
    expect(offsetInput('g55', 'z')?.value).toBe('210.00')

    await act(async () => {
      // The reopened board is back on the profile values. The real WO-1130
      // bridge then reports its proved reopen through this unchanged line.
      transport.emit(hello({ G54: PROFILE_G54, G55: PROFILE_G55 }))
      transport.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.',
          severity: 'info',
        },
      })
      await Promise.resolve()
    })

    const firstWrite = calls(transport, 'setWorkOffset')
    expect(firstWrite).toHaveLength(1)
    expect(firstWrite[0].a).toEqual({ wcs: 'G54', ...STORED_G54 })
    expect(useMachineControl.getState().offsets).toEqual({})
    expect(offsetInput('g54', 'x')).toBeNull()
    expect(offsetInput('g55', 'z')).toBeNull()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('not-sent')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('not-sent')
    expect(screen.getByTestId('control-offsets-table').querySelectorAll('[data-not-sent]')).toHaveLength(6)

    await act(async () => {
      transport.reply(firstWrite[0], { ok: true, reason: null, offset: STORED_G54 })
      await flushReceipts()
    })

    expect(offsetInput('g54', 'x')?.value).toBe('188.73')
    expect(offsetInput('g55', 'z')).toBeNull()
    const secondWrite = calls(transport, 'setWorkOffset')
    expect(secondWrite).toHaveLength(2)
    expect(secondWrite[1].a).toEqual({ wcs: 'G55', ...STORED_G55 })

    await act(async () => {
      // A second physical reopen after G54 was confirmed puts the new board
      // back on its profile values. Its report invalidates the old G55 write
      // and starts a complete retry without waiting for a receipt that belongs
      // to the previous physical controller session.
      transport.emit(hello({ G54: PROFILE_G54, G55: PROFILE_G55 }))
      transport.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 2) - this link is live.',
          severity: 'info',
        },
      })
      await Promise.resolve()
    })
    const retryWrites = calls(transport, 'setWorkOffset')
    expect(retryWrites).toHaveLength(3)
    expect(retryWrites[2].a).toEqual({ wcs: 'G54', ...STORED_G54 })
    expect(offsetInput('g54', 'x')).toBeNull()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('not-sent')

    await act(async () => {
      transport.reply(secondWrite[1], { ok: true, reason: null, offset: STORED_G55 })
      await flushReceipts()
    })

    expect(calls(transport, 'setWorkOffset')).toHaveLength(3)
    expect(session.machineWorkOffsetWriteInFlight(machineId)).toBe(true)
    expect(useMachineControl.getState().offsets).toEqual({})
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('not-sent')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('not-sent')

    await act(async () => {
      transport.reply(retryWrites[2], { ok: true, reason: null, offset: STORED_G54 })
      await flushReceipts()
    })

    expect(calls(transport, 'setWorkOffset')).toHaveLength(4)
    expect(calls(transport, 'setWorkOffset')[3].a).toEqual({ wcs: 'G55', ...STORED_G55 })

    await act(async () => {
      transport.reply(calls(transport, 'setWorkOffset')[3], { ok: true, reason: null, offset: STORED_G55 })
      await flushReceipts()
    })

    await waitFor(() => expect(offsetInput('g55', 'z')?.value).toBe('210.00'))
    expect(useMachineControl.getState().offsets).toMatchObject({
      G54: [STORED_G54.x, STORED_G54.y, STORED_G54.z],
      G55: [STORED_G55.x, STORED_G55.y, STORED_G55.z],
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('restored')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).toEqual(
      expect.arrayContaining([
        'Work zero restored from this computer: G54 X188.732 Y397.655 Z110 - not re-established on this machine this session.',
        'Work zero restored from this computer: G55 X288.733 Y497.656 Z210 - not re-established on this machine this session.',
      ]),
    )
  })

  it('invalidates an occupied work-offset slot and restores every durable frame', async () => {
    await session.connectMachine('bridge')
    const transport = bridge.instances[0]
    transport.sent = []

    expect(session.setWorkOffsetValue('G56', 'X', 42, session.getMachineController())).toBe(true)
    await flushReceipts()
    const staleWrite = calls(transport, 'setWorkOffset')[0]
    expect(staleWrite.a).toEqual({ wcs: 'G56', x: 42 })
    expect(session.machineWorkOffsetWriteInFlight(machineId)).toBe(true)

    await act(async () => {
      transport.emit(hello({ G54: PROFILE_G54, G55: PROFILE_G55 }))
      transport.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.',
          severity: 'info',
        },
      })
      await flushReceipts()
    })

    const writesAfterReopen = calls(transport, 'setWorkOffset')
    expect(writesAfterReopen).toHaveLength(2)
    expect(writesAfterReopen[1].a).toEqual({ wcs: 'G54', ...STORED_G54 })
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).not.toContain(
      'Work zero restore skipped - an offset write is already waiting for the bridge to confirm.',
    )

    await act(async () => {
      transport.reply(staleWrite, { ok: true, reason: null, offset: { x: 42, y: 0, z: 0 } })
      await flushReceipts()
    })
    expect(session.machineWorkOffsetWriteInFlight(machineId)).toBe(true)
    expect(calls(transport, 'setWorkOffset')).toHaveLength(2)

    await act(async () => {
      transport.reply(writesAfterReopen[1], { ok: true, reason: null, offset: STORED_G54 })
      await flushReceipts()
    })
    const finalWrites = calls(transport, 'setWorkOffset')
    expect(finalWrites).toHaveLength(3)
    expect(finalWrites[2].a).toEqual({ wcs: 'G55', ...STORED_G55 })

    await act(async () => {
      transport.reply(finalWrites[2], { ok: true, reason: null, offset: STORED_G55 })
      await flushReceipts()
    })
    expect(session.machineWorkOffsetWriteInFlight(machineId)).toBe(false)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('restored')
  })

  it('keeps newer authoritative rows when a superseded restore receipt arrives last', async () => {
    await session.connectMachine('bridge')
    const transport = bridge.instances[0]
    transport.sent = []

    await act(async () => {
      transport.emit(hello({ G54: PROFILE_G54, G55: PROFILE_G55 }))
      transport.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.',
          severity: 'info',
        },
      })
      await flushReceipts()
    })
    const supersededG54 = calls(transport, 'setWorkOffset')[0]
    expect(supersededG54.a).toEqual({ wcs: 'G54', ...STORED_G54 })

    await act(async () => {
      transport.emit(hello({ G54: PROFILE_G54, G55: PROFILE_G55 }))
      transport.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 2) - this link is live.',
          severity: 'info',
        },
      })
      await flushReceipts()
    })
    const authoritativeG54 = calls(transport, 'setWorkOffset')[1]
    expect(authoritativeG54.a).toEqual({ wcs: 'G54', ...STORED_G54 })

    await act(async () => {
      transport.reply(authoritativeG54, { ok: true, reason: null, offset: STORED_G54 })
      await flushReceipts()
    })
    const authoritativeG55 = calls(transport, 'setWorkOffset')[2]
    expect(authoritativeG55.a).toEqual({ wcs: 'G55', ...STORED_G55 })

    await act(async () => {
      transport.reply(authoritativeG55, { ok: true, reason: null, offset: STORED_G55 })
      await flushReceipts()
    })
    expect(useMachineControl.getState().offsets).toMatchObject({
      G54: [STORED_G54.x, STORED_G54.y, STORED_G54.z],
      G55: [STORED_G55.x, STORED_G55.y, STORED_G55.z],
    })

    await act(async () => {
      transport.reply(supersededG54, { ok: true, reason: null, offset: STORED_G54 })
      await flushReceipts()
    })

    expect(useMachineControl.getState().offsets).toMatchObject({
      G54: [STORED_G54.x, STORED_G54.y, STORED_G54.z],
      G55: [STORED_G55.x, STORED_G55.y, STORED_G55.z],
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('restored')
  })
})
