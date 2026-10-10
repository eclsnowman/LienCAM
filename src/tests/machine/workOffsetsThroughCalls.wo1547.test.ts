// @vitest-environment jsdom
//
// WO-1547 (WO-1545 slice 3) - WORK OFFSETS AND WCS SELECT GO THROUGH CONTROLLER
// CALLS ON A CONTROLLER THAT TAKES NO TEXT.
//
// Driven through the REAL `UccncController` on the real session singleton,
// over a fake bridge socket that answers the way the board did on 2026-09-14.
// The reply shapes and the numbers are the recorded ones
// (src/tests/evidence/SESSION-2026-09-14/machine-2026-09-14/session*.ws-frames.ndjson):
//
//   tx {"m":"setWorkOffset","a":{"wcs":"G54","z":66.57}}
//   rx {"ok":true,"v":{"ok":true,"reason":null,"offset":{"x":188.7325,"y":397.655,"z":66.57}}}
//   tx {"m":"selectWcs","a":{"wcs":"G54"}}
//   rx {"ok":true,"v":true}
//
// Every claim is about what reached THAT WIRE and what the app then shows.
// A refused setWorkOffset uses the contract's receipt shape
// (`SetWorkOffsetResult`); no refusal was recorded on the board.
//
// NOT CLAIMED: hardware. A work-offset write on machine PC is owed (Tier 1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineController, MachineStatus } from '../../lib/machine/controller'
import type { MachineVec3 } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

/** Operator's AXBB-E as the bridge reports it: no interpreter on the wire. */
const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** The board's work-offset table at connect, as its hello reported it. */
function boardOffsets(): Record<string, MachineVec3> {
  return {
    G54: { x: 188.7325, y: 397.655, z: 110 },
    G55: { x: 288.7325, y: 397.655, z: 110 },
    G56: { x: 0, y: 0, z: 0 },
    G57: { x: 0, y: 0, z: 0 },
    G58: { x: 0, y: 0, z: 0 },
    G59: { x: 0, y: 0, z: 0 },
  }
}

let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let board = boardOffsets()
/** Method -> refusal reason: the next call of that method is refused. */
let refuse: Record<string, string> = {}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: boardOffsets(), profile: boardOffsets() },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        const reason = refuse[message.m]
        if (message.m === 'selectWcs') {
          if (reason) {
            delete refuse[message.m]
            bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: false, error: reason })
            return
          }
          bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
        }
        if (message.m === 'setWorkOffset') {
          if (reason) {
            delete refuse[message.m]
            bridgeEvents?.onMessage({
              t: 'reply', seq: message.seq, ok: true, v: { ok: false, reason, offset: null },
            })
            return
          }
          const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
          const row = board[a.wcs]
          board[a.wcs] = { x: a.x ?? row.x, y: a.y ?? row.y, z: a.z ?? row.z }
          bridgeEvents?.onMessage({
            t: 'reply', seq: message.seq, ok: true, v: { ok: true, reason: null, offset: { ...board[a.wcs] } },
          })
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const { fmtMachineLength } = await import('../../lib/ui/unitFormat')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendAppCommand,
  sendAppCommandAwait,
} = await import('../../lib/machine/machineSession')

function idleStatus(machinePos: MachineVec3 = { x: 0, y: 0, z: 0 }): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos,
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

const textFrames = () => sent.filter((m) => m.m === 'sendCommand' || m.m === 'sendCommandAwait')
const offsetCalls = () => sent.filter((m) => m.m === 'setWorkOffset' || m.m === 'selectWcs').map(({ m, a }) => ({ m, a }))
const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage({ t: 'status', v: idleStatus() } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54' })
  // Only what the app issues AFTER the connection is under test.
  sent = []
}

function renderOffsets(): HTMLElement {
  useUiPrefs.setState({ machineOffsetsCollapsed: false })
  return render(createElement(OffsetsPanel)).container
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  refuse = {}
  board = boardOffsets()
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  // The connect restore pushes remembered offsets; each test starts from the board's own table.
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1547: work offsets on a controller that takes geometry', () => {
  it('a typed G54 Z value sends setWorkOffset and the table shows the controller reply', async () => {
    await connectBridge()
    const container = renderOffsets()
    const cell = container.querySelector('[data-testid="control-offset-g54-z"]') as HTMLInputElement
    expect(cell).toBeInstanceOf(HTMLInputElement)
    expect(cell.disabled).toBe(false)

    await act(async () => {
      fireEvent.change(cell, { target: { value: '66.57' } })
      fireEvent.blur(cell)
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(offsetCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G54', z: 66.57 } }])
    expect(textFrames()).toEqual([])
    expect(useMachineControl.getState().offsets.G54).toEqual([188.7325, 397.655, 66.57])
    const shown = container.querySelector('[data-testid="control-offset-g54-z"]') as HTMLInputElement
    expect(shown.value).toBe(fmtMachineLength(66.57, 'mm'))
    expect(container.innerHTML).not.toContain('no text path')
  })

  it('a pad zero (G10 L20 P0 Z) sets the active offset from the machine position', async () => {
    await connectBridge()
    bridgeEvents?.onMessage({ t: 'status', v: idleStatus({ x: 738, y: 724.5, z: 76.57 }) } as BridgeMessage)

    const zero = await sendAppCommandAwait('G10 L20 P0 Z10')

    expect(zero).toMatchObject({ ok: true, sent: true, message: null })
    expect(offsetCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G54', z: 66.57 } }])
    expect(textFrames()).toEqual([])
    expect(useMachineControl.getState().offsets.G54).toEqual([188.7325, 397.655, 66.57])
    // The receipt is what the next connect restores, so it is durable - Z only.
    const machineId = controlMachine(useCamStore.getState()).id
    const stored = useCamStore.getState().machineWorkOffsets[machineId]?.G54
    expect(stored?.offset).toMatchObject({ z: 66.57 })
    expect(stored?.state).toBe('sent')
  })

  it('a G10 L2 line writes the named slot in the line units', async () => {
    await connectBridge()

    const write = await sendAppCommandAwait('G20 G10 L2 P2 X1 Y-0.5')

    expect(write).toMatchObject({ ok: true, sent: true })
    expect(offsetCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G55', x: 25.4, y: -12.7 } }])
    expect(useMachineControl.getState().offsets.G55).toEqual([25.4, -12.7, 110])
    expect(textFrames()).toEqual([])
  })

  it('a switch from G54 to G55 sends selectWcs, by button and by line', async () => {
    await connectBridge()
    const container = renderOffsets()

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="control-wcs-g55"]')!)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(offsetCalls()).toEqual([{ m: 'selectWcs', a: { wcs: 'G55' } }])
    expect(useMachineControl.getState().activeWcs).toBe('G55')

    sent = []
    const back = await sendAppCommandAwait('G54')
    expect(back).toMatchObject({ ok: true, sent: true })
    expect(offsetCalls()).toEqual([{ m: 'selectWcs', a: { wcs: 'G54' } }])
    expect(useMachineControl.getState().activeWcs).toBe('G54')

    sent = []
    const fired = sendAppCommand('G55')
    expect(fired).toMatchObject({ ok: true, sent: true })
    await vi.advanceTimersByTimeAsync(50)
    expect(offsetCalls()).toEqual([{ m: 'selectWcs', a: { wcs: 'G55' } }])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(textFrames()).toEqual([])
  })
})

describe('WO-1547: a refused call is reported as a refusal naming the command', () => {
  it('a refused setWorkOffset names the line and the call, and changes nothing', async () => {
    await connectBridge()
    bridgeEvents?.onMessage({ t: 'status', v: idleStatus({ x: 738, y: 724.5, z: 76.57 }) } as BridgeMessage)
    refuse = { setWorkOffset: 'the offset is outside the soft limits' }
    const before = useMachineControl.getState().offsets.G54
    expect(before).toEqual([188.7325, 397.655, 110])

    const zero = await sendAppCommandAwait('G10 L20 P0 Z10')

    expect(zero?.ok).toBe(false)
    expect(zero?.sent).toBe(true)
    expect(zero?.message).toContain('G10 L20 P0 Z10')
    expect(zero?.message).toContain('setWorkOffset')
    expect(zero?.message).toContain('the offset is outside the soft limits')
    expect(consoleText()).toContain('G10 L20 P0 Z10: the controller refused setWorkOffset G54')
    expect(useMachineControl.getState().offsets.G54).toEqual(before)
  })

  it('a refused selectWcs names the line and the call, and keeps the active frame', async () => {
    await connectBridge()
    refuse = { selectWcs: 'SelectWcs failed' }

    const select = await sendAppCommandAwait('G55')

    expect(select).toMatchObject({ ok: false, sent: true })
    expect(select?.message).toContain('G55: the controller refused selectWcs G55 - SelectWcs failed')
    expect(consoleText()).toContain('refused selectWcs G55')
    expect(useMachineControl.getState().activeWcs).toBe('G54')
  })

  it('a line with no controller equivalent names itself and sends nothing', async () => {
    await connectBridge()

    const rotated = await sendAppCommandAwait('G10 L2 P1 R45')

    expect(rotated).toMatchObject({ ok: false, sent: false })
    expect(rotated?.message).toContain('G10 L2 P1 R45: R45 has no call')
    expect(sent).toEqual([])
  })
})

describe('WO-1547: a controller that takes text keeps its text lines (GRBL, simulator)', () => {
  function textController() {
    const ctrl = {
      capabilities: { ...BRIDGE_CAPABILITIES, gcodeText: true },
      connectionPhase: () => 'connected',
      sendCommand: vi.fn(() => true),
      sendCommandAwait: vi.fn(() => Promise.resolve({ ok: true, message: null })),
      setWorkOffset: vi.fn(),
      selectWcs: vi.fn(() => true),
    }
    return ctrl as unknown as MachineController & typeof ctrl
  }

  it('sends G10 L2, G10 L20 and G55 as text and never as calls', async () => {
    const ctrl = textController()

    expect(await sendAppCommandAwait('G10 L2 P1 Z66.57', ctrl)).toMatchObject({ ok: true, sent: true })
    expect(await sendAppCommandAwait('G10 L20 P0 Z10', ctrl)).toMatchObject({ ok: true, sent: true })
    expect(sendAppCommand('G55', ctrl)).toMatchObject({ ok: true, sent: true })

    expect(ctrl.sendCommandAwait.mock.calls).toEqual([['G10 L2 P1 Z66.57'], ['G10 L20 P0 Z10']])
    expect(ctrl.sendCommand.mock.calls).toEqual([['G55']])
    expect(ctrl.setWorkOffset).not.toHaveBeenCalled()
    expect(ctrl.selectWcs).not.toHaveBeenCalled()
  })
})
