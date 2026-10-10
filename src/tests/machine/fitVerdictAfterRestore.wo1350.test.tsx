// @vitest-environment jsdom
//
// WO-1350: a reconnecting bridge may report the profile's start-up work
// offsets before LienCAM restores its stored rows. The preview must see only
// the reconciled row, never publish a verdict against that temporary datum.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineVec3, WcsId } from '../../lib/machine/controller'
import type { Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

Object.defineProperty(globalThis, 'requestAnimationFrame', { value: vi.fn(() => 1), configurable: true })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: vi.fn(), configurable: true })

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

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  replyToRestore(): void
}

const bridge = vi.hoisted(() => ({
  currentG54: { x: 85, y: 20, z: 20 },
  restoredG54: { x: 20, y: 20, z: 20 },
  last: null as FakeBridgeTransport | null,
}))

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
      const current = allOffsets(bridge.currentG54)
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1350-fake 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current, profile: current },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
    }

    replyToRestore(): void {
      const message = [...this.sent].reverse().find((candidate) => candidate.m === 'setWorkOffset')
      if (!message) throw new Error('The bridge received no work-offset restore.')
      this.fakeEvents?.onMessage({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: { ok: true, reason: null, offset: { ...bridge.restoredG54 } },
      })
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { ProgramPreview } = await import('../../components/machine/ProgramPreview')
const { resetProgramFitConsole } = await import('../../components/machine/ProgramFitStatusLine')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1350-machine'
const PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z10\nG1 X20 Y20 Z0 F500\nM30\n'
const INITIAL_PARTIAL = { x: 91, y: 20, z: 20 }
const HELLO_PARTIAL = { x: 85, y: 20, z: 20 }

function allOffsets(g54: MachineVec3): Record<WcsId, MachineVec3> {
  const zero = { x: 0, y: 0, z: 0 }
  return {
    G54: { ...g54 }, G55: { ...zero }, G56: { ...zero },
    G57: { ...zero }, G58: { ...zero }, G59: { ...zero },
  }
}

function machine() {
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1350 positive table',
    travel: { x: 100, y: 100, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
}

let originalProject: Project
let originalMachineWorkOffsets: ReturnType<typeof useCamStore.getState>['machineWorkOffsets']

beforeEach(() => {
  cleanup()
  localStorage.clear()
  resetProgramFitConsole()
  bridge.last = null
  bridge.currentG54 = { ...HELLO_PARTIAL }
  bridge.restoredG54 = { x: 20, y: 20, z: 20 }

  const cam = useCamStore.getState()
  originalProject = cam.project
  originalMachineWorkOffsets = cam.machineWorkOffsets
  useCamStore.setState({
    project: { ...cam.project, machine: machine() },
    machineWorkOffsets: {
      ...cam.machineWorkOffsets,
      [MACHINE_ID]: {
        G54: { offset: { ...bridge.restoredG54 }, state: 'sent' },
      },
    },
  })
  useMachineControl.setState({
    programText: PROGRAM,
    connectionPhase: 'connected',
    connectionKind: 'bridge',
    activeWcs: 'G54',
    offsets: { G54: [INITIAL_PARTIAL.x, INITIAL_PARTIAL.y, INITIAL_PARTIAL.z] },
    homed: true,
    consoleLines: [],
    programFit: null,
  })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await act(async () => { await session.disconnectMachine() })
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: originalMachineWorkOffsets })
  useMachineControl.setState({
    programText: null,
    connectionPhase: 'disconnected',
    connectionKind: null,
    offsets: {},
    consoleLines: [],
    programFit: null,
  })
})

async function connectThroughHeldRestore(): Promise<void> {
  let pending!: Promise<void>
  act(() => { pending = session.connectMachine('bridge') })

  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => { await Promise.resolve() })
    if (bridge.last?.sent.some((message) => message.m === 'setWorkOffset')) break
  }
  expect(bridge.last?.sent.some((message) => message.m === 'setWorkOffset')).toBe(true)

  await act(async () => {
    bridge.last!.replyToRestore()
    await pending
  })
}

function fitLines() {
  return useMachineControl.getState().consoleLines.filter((line) =>
    line.text.includes('Program (after G54)'))
}

describe('WO-1350: fit verdict waits for restored offsets', () => {
  it('prints only the correct inside verdict after a reconnect restore', async () => {
    render(<ProgramPreview />)
    expect(fitLines()).toHaveLength(1)
    useMachineControl.setState({ consoleLines: [] })

    await connectThroughHeldRestore()

    expect(fitLines().map((line) => ({ text: line.text, severity: line.severity }))).toEqual([{
      text: 'Program (after G54) fits inside the table.',
      severity: 'info',
    }])
  })

  it('still prints one red verdict when the restored offset is genuinely outside', async () => {
    bridge.restoredG54 = { x: 120, y: 20, z: 20 }
    useCamStore.setState((state) => ({
      machineWorkOffsets: {
        ...state.machineWorkOffsets,
        [MACHINE_ID]: { G54: { offset: { ...bridge.restoredG54 }, state: 'sent' } },
      },
    }))
    render(<ProgramPreview />)
    expect(fitLines()).toHaveLength(1)
    useMachineControl.setState({ consoleLines: [] })

    await connectThroughHeldRestore()

    expect(fitLines()).toHaveLength(1)
    expect(fitLines()[0]).toMatchObject({ severity: 'error' })
    expect(fitLines()[0].text).toContain('OUTSIDE - Program (after G54) lies entirely off the table on X')
  })
})
