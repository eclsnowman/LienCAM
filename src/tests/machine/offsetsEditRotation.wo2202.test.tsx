// @vitest-environment jsdom
//
// WO-2202: the Offsets panel and the Offsets tab show and edit each work
// offset's rotation.
//
// Operator ruling 2026-09-29: "can we also have a method to see and even edit this in
// the offsets panel and offsets tab?" The rotation lives in the CONTROLLER
// (docs/design/WCS-ROTATION.md, WO-2187): both places send what is typed
// through the one session call (setWorkRotation) and both show what the
// controller REPORTS - never the typed text on its own.
//
// Through the application's own entry points: connectMachine (the Control
// tab's Connect), the RENDERED Control page on its Offsets view (the quick
// Offsets panel + the Offsets tab side by side), on the real session singleton
// and the real UccncController over a fake bridge socket that holds a rotation
// per system the way Machine.cs does (hello.workOffsets.rotation,
// setWorkRotation receipts). The simulator is the controller that cannot rotate.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}
const OFFSET = { x: 10, y: 5, z: 2 }
const ZERO = { x: 0, y: 0, z: 0 }

/** What the fake bridge holds, per system - Machine.cs's rotations[]. */
let bridgeRotations: Record<string, number> = {}
/** A bridge that answers setWorkRotation with a refusal (and keeps its value). */
let bridgeRefuses: string | null = null

interface FakeBridge extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  frames(kind: string): BridgeCallMessage[]
}
const bridgeSockets: FakeBridge[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null
    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }
    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const current = { G54: { ...OFFSET }, G55: { ...ZERO }, G56: { ...ZERO }, G57: { ...ZERO }, G58: { ...ZERO }, G59: { ...ZERO } }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2202-fake 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
          vfd: { present: false, verified: false, name: null },
          workOffsets: { current, profile: current, rotation: { ...bridgeRotations } },
        },
      } as BridgeMessage)
    }
    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      const reply = (v: unknown) => this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
      if (message.m === 'selectWcs') reply(true)
      if (message.m === 'setWorkRotation') {
        // Bridge.cs's receipt shape: {ok, reason, wcs, rotation}.
        const a = message.a as { wcs: string; degrees: number }
        if (bridgeRefuses) {
          reply({ ok: false, reason: bridgeRefuses, wcs: a.wcs, rotation: bridgeRotations[a.wcs] ?? 0 })
          return
        }
        bridgeRotations = { ...bridgeRotations, [a.wcs]: a.degrees }
        reply({ ok: true, reason: null, wcs: a.wcs, rotation: a.degrees })
      }
    }
    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
    frames(kind: string): BridgeCallMessage[] { return this.sent.filter((m) => m.m === kind) }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridgeTransport })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const session = await import('../../lib/machine/machineSession')

const DEFAULT_MACHINE = useCamStore.getState().project.machine
const WCS = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] as const

function bridgeMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 50
  }
  return makeMachine({
    id: 'wo2202-axbb',
    name: 'WO-2202 AXBB-E router',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function idleStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 10, y: 5, z: 2 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
    workRotation: bridgeRotations.G54 ?? 0,
  } as MachineStatus
}

const socket = () => bridgeSockets[bridgeSockets.length - 1]
const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text)
/** The Offsets panel (Control screen quick card) cell and the Offsets tab cell. */
const panelCell = (wcs: string) => screen.getByTestId(`control-offset-${wcs.toLowerCase()}-rot`) as HTMLInputElement
const tabCell = (wcs: string) => screen.getByTestId(`offsets-workspace-${wcs.toLowerCase()}-rot`) as HTMLInputElement
const shownBoth = (wcs: string) => [panelCell(wcs).value, tabCell(wcs).value]

async function connectBridge(): Promise<void> {
  const pending = session.connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { session.__resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
}

function openOffsetsView(): void {
  render(<ControlPage />)
  act(() => { fireEvent.click(screen.getByTestId('control-view-offsets')) })
}

/** Type into a cell the way the operator does: focus, type, Enter. */
async function typeInto(cell: HTMLInputElement, text: string): Promise<void> {
  act(() => { cell.focus() })
  act(() => { fireEvent.change(cell, { target: { value: text } }) })
  await act(async () => {
    fireEvent.keyDown(cell, { key: 'Enter' })
    await vi.advanceTimersByTimeAsync(10)
  })
}

async function disconnect(): Promise<void> {
  if (session.getMachineController().connectionPhase() === 'disconnected') return
  const pending = session.disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

describe('WO-2202 AXBB-E bridge: both offsets screens show and edit the rotation the bridge holds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bridgeSockets.length = 0
    bridgeRefuses = null
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: bridgeMachine(), setups: [], activeSetupId: null },
      machineWorkOffsets: {},
    }))
    useUiPrefs.setState({ machineOffsetsCollapsed: false })
    useMachineControl.setState({ consoleLines: [] })
  })

  afterEach(async () => {
    cleanup()
    await disconnect()
    session.clearPathFidelity()
    vi.useRealTimers()
  })

  it('a rotation the bridge reports at connect shows in both places without any typing; square systems show 0', async () => {
    bridgeRotations = { G54: 0, G55: 30, G56: 0, G57: 0, G58: 0, G59: 0 }
    await connectBridge()
    openOffsetsView()
    expect(shownBoth('G55')).toEqual(['30.000', '30.000'])
    for (const wcs of WCS.filter((w) => w !== 'G55')) expect(shownBoth(wcs)).toEqual(['0.000', '0.000'])
    // The rotated row reads apart at a glance; a square one does not.
    expect(panelCell('G55').parentElement!.hasAttribute('data-rotated')).toBe(true)
    expect(tabCell('G55').parentElement!.hasAttribute('data-rotated')).toBe(true)
    expect(panelCell('G54').parentElement!.hasAttribute('data-rotated')).toBe(false)
    expect(socket().frames('setWorkRotation')).toEqual([])
  })

  it('typed in the Offsets panel -> the bridge receives it -> the Offsets tab shows it; 0 clears it in both', async () => {
    bridgeRotations = { G54: 0, G55: 0, G56: 0, G57: 0, G58: 0, G59: 0 }
    await connectBridge()
    openOffsetsView()
    expect(shownBoth('G55')).toEqual(['0.000', '0.000'])

    await typeInto(panelCell('G55'), '30')
    expect(socket().frames('setWorkRotation').map((m) => m.a)).toEqual([{ wcs: 'G55', degrees: 30 }])
    expect(bridgeRotations.G55).toBe(30)
    expect(session.workRotations()).toEqual({ G55: 30 })
    expect(shownBoth('G55')).toEqual(['30.000', '30.000'])
    // The always-visible WO-2187 indicator agrees.
    expect(screen.getByTestId('control-wcs-rotation-G55').textContent).toBe('G55 rotated 30 degClear')

    await typeInto(panelCell('G55'), '0')
    expect(socket().frames('setWorkRotation').map((m) => m.a)).toEqual([
      { wcs: 'G55', degrees: 30 },
      { wcs: 'G55', degrees: 0 },
    ])
    expect(session.workRotations()).toEqual({})
    expect(shownBoth('G55')).toEqual(['0.000', '0.000'])
    expect(screen.queryByTestId('control-wcs-rotation-G55')).toBeNull()
    expect(consoleText()).toContain('G55 rotation cleared.')
  })

  it('typed in the Offsets tab -> the bridge receives it -> the Offsets panel shows it; 0 clears it in both', async () => {
    bridgeRotations = { G54: 0, G55: 0, G56: 0, G57: 0, G58: 0, G59: 0 }
    await connectBridge()
    openOffsetsView()

    await typeInto(tabCell('G56'), '-1.5 deg')
    expect(socket().frames('setWorkRotation').map((m) => m.a)).toEqual([{ wcs: 'G56', degrees: -1.5 }])
    expect(shownBoth('G56')).toEqual(['-1.500', '-1.500'])
    expect(consoleText()).toContain('G56 rotated -1.5 deg.')

    await typeInto(tabCell('G56'), '0')
    expect(socket().frames('setWorkRotation').map((m) => m.a).at(-1)).toEqual({ wcs: 'G56', degrees: 0 })
    expect(shownBoth('G56')).toEqual(['0.000', '0.000'])
  })

  it('the cells show the controller\'s report, never the typed text: a refused rotation leaves the report showing', async () => {
    bridgeRotations = { G54: 0, G55: 2, G56: 0, G57: 0, G58: 0, G59: 0 }
    bridgeRefuses = 'the bridge is busy.'
    await connectBridge()
    openOffsetsView()

    await typeInto(panelCell('G55'), '45')
    expect(socket().frames('setWorkRotation').map((m) => m.a)).toEqual([{ wcs: 'G55', degrees: 45 }])
    expect(shownBoth('G55')).toEqual(['2.000', '2.000'])
    expect(consoleText()).toContain('G55 rotation not changed - the bridge is busy.')

    // Unchanged text and blank text send nothing.
    await typeInto(tabCell('G55'), '2')
    await typeInto(tabCell('G55'), '')
    expect(socket().frames('setWorkRotation')).toHaveLength(1)
    expect(shownBoth('G55')).toEqual(['2.000', '2.000'])
  })

  it('disconnected there is no report: both cells show a dash', async () => {
    bridgeRotations = { G54: 0, G55: 30, G56: 0, G57: 0, G58: 0, G59: 0 }
    openOffsetsView()
    expect(panelCell('G55').tagName).toBe('SPAN')
    expect(panelCell('G55').textContent).toBe('-')
    expect(tabCell('G55').textContent).toBe('-')
  })
})

describe('WO-2202 a controller that cannot rotate: the cell shows 0 and typing says so in the console', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: DEFAULT_MACHINE, setups: [], activeSetupId: null },
      machineWorkOffsets: {},
    }))
    useUiPrefs.setState({ machineOffsetsCollapsed: false })
    useMachineControl.setState({ consoleLines: [] })
    const pending = session.connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { session.__resetEstopInterlockForTest() })
    expect(session.getMachineController().setWcsRotation).toBeUndefined()
  })

  afterEach(async () => {
    cleanup()
    session.getMachineController().emergencyStop()
    await disconnect()
    vi.useRealTimers()
  })

  it('shows the reported 0 in both places; a typed rotation changes nothing and the console says why', async () => {
    openOffsetsView()
    expect(shownBoth('G54')).toEqual(['0.000', '0.000'])
    await typeInto(panelCell('G54'), '5')
    await typeInto(tabCell('G54'), '5')
    expect(consoleText().filter((t) => t === 'G54 rotation not changed - this controller cannot rotate a work offset.'))
      .toHaveLength(2)
    expect(shownBoth('G54')).toEqual(['0.000', '0.000'])
    expect(session.workRotations()).toEqual({})
  })
})
