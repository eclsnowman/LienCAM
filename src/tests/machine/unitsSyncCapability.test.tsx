// @vitest-environment jsdom
//
// The app must not send G-code text to a controller that told it, in the first
// frame of the connection, that it takes none.
//
// Seen at the machine 2026-08-22, on every single bridge connect:
//
//   sendCommand: this controller takes geometry, not G-code text - use
//   loadMoves (capabilities.geometryQueue is true)
//
// ControlPage syncs the controller's parser units on connect (G20/G21) so MDI
// typed by the operator is read in the units on screen. It did that
// unconditionally. The AXBB-E has no G-code interpreter and declares
// `gcodeText: false` in its hello, so the call could only ever be refused -
// and there is nothing to sync anyway, because with no interpreter there is no
// parser modal state for G20/G21 to set.
//
// Harmless in itself. It matters because it trains an operator to read
// refusals as noise, and the operator console is where this machine reports
// the refusals that DO matter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import type { BridgeCallMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

/** Every call the app put on the wire this test. */
let sent: BridgeCallMessage[] = []
/** What the bridge claims in its hello - the whole point of the test. */
let gcodeText = false

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    // A bridge that answers the handshake and records what it is told, so the
    // real UccncController and the real ControlPage run unchanged.
    BridgeTransport: class extends actual.BridgeTransport {
      /** Required by the real BridgeTransport's static side (WO-960 typedMock
       *  conversion) - never consulted by this fixture. */
      static isSupported(): boolean {
        return true
      }
      async start(events: BridgeTransportEvents): Promise<void> {
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: {
              geometryQueue: true,
              executingMoveId: true,
              bufferSeconds: true,
              gcodeText,
              perAxisHoming: true,
              ownsSpindle: false,
              // Required by ControllerCapabilities. The real bridge does not send
              // this - UccncController derives it from hello.vfd.present - but
              // the hello type is typed against the full capability set, so a
              // fixture must carry it. A mock must carry the real SHAPE.
              spindleCommands: false,
            },
            readOnly: false,
          },
        })
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
      }
      async close(): Promise<void> {}
    },
  })
})

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

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { connectMachine, disconnectMachine } = await import('../../lib/machine/machineSession')

const textCalls = () => sent.filter((c) => c.m === 'sendCommand' || c.m === 'sendCommandAwait')

async function connectAndMount(): Promise<void> {
  await connectMachine('bridge')
  sent = [] // only what the MOUNTED page sends is under test
  render(<ControlPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
})

afterEach(async () => {
  cleanup()
  await disconnectMachine()
  vi.useRealTimers()
})

describe('the units sync respects what the controller said it accepts', () => {
  it('sends NO G-code text to a controller that declares gcodeText false', async () => {
    gcodeText = false

    await connectAndMount()

    // The defect, as one assertion: this list was ['G21'] at the machine.
    expect(textCalls()).toEqual([])
  })

  it('still syncs units on a controller that DOES take text', async () => {
    // The guard must not quietly delete the feature for controllers that have
    // an interpreter - GRBL relies on this to read MDI in the units on screen.
    gcodeText = true

    await connectAndMount()

    const texts = textCalls().map((c) => (c.a as { text?: string })?.text)
    expect(texts).toContain('G21')
  })
})
