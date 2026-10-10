// @vitest-environment jsdom
//
// WO-1633: two probe lamps - PROBE (the probe input, a touch) and PROBING (a
// probe cycle in process) - on all three surfaces the WO names: the Control
// screen's pin-LED row, the Probing panel, and the Tools/Probe panel. Each
// signal is independent (WO-2063: the rebuilt Probing screen carries no lamps -
// docs/design/PROBING-SCREEN-V2.md - so it is no longer one of the surfaces): `inputs.probe` true/false/null and `probeCycle`
// true/false/absent must each render lit/off/unavailable without the other
// signal's state leaking across.
//
// WO-1671: at the machine 2026-09-17 the wire carried `probeCycle: true` for
// the whole deliberate-miss probe and PROBING never lit - the lamp read a
// store field no status handler wrote, and this file (which set the store
// directly) could not see it. It now drives the REAL UccncController over a
// fake bridge transport: every signal below reaches the lamps as a bridge
// `status` frame, the way the board's own pusher sends it.

import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport as BridgeTransportType,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransportType {
  emitStatus(v: MachineStatus): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

// The AXBB-E bridge's own hello capabilities.
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

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'WO-1671 fake bridge', capabilities: CAPABILITIES, readOnly: false },
      })
    }

    send(message: BridgeCallMessage): void {
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    emitStatus(v: MachineStatus): void {
      this.emit({ t: 'status', v })
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

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { useCamStore } = await import('../../store')
const session = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

/** An idle AXBB-E status frame as the bridge pushes it (shape transcribed from
 *  the board's recorded frames, SESSION-2026-09-14 session-estopfix). */
function statusFrame(probe: boolean | null, probeCycle: boolean | null | undefined): MachineStatus {
  const frame: MachineStatus = {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: -81.2275, y: -61.3225, z: -12.16 },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: { feed: 100, rapid: null, spindle: 100 },
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 0.1 },
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe,
      limits: null,
      door: null,
      hold: false,
    },
    homed: null,
    spindle: null,
  }
  // `undefined` = the frame does not carry the field at all.
  if (probeCycle !== undefined) frame.probeCycle = probeCycle
  return frame
}

let transport: FakeBridgeTransport | null = null

/** One bridge status frame carrying these two signals. `probeCycle` undefined
 *  means the key is absent from the frame. */
function setSignals(probe: boolean | null, probeCycle: boolean | null | undefined): void {
  if (!transport) throw new Error('the fake bridge is not connected')
  const t = transport
  act(() => { t.emitStatus(statusFrame(probe, probeCycle)) })
}

beforeEach(async () => {
  memory.clear()
  bridge.last = null
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: false,
    settings: {},
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  await act(async () => { await session.connectMachine('bridge') })
  transport = bridge.last
})

afterEach(async () => {
  cleanup()
  await act(async () => { await session.disconnectMachine() })
  transport = null
})

type Lit = 'on' | 'off' | 'unavailable'

function classOf(testId: string): Lit {
  const el = screen.getByTestId(testId)
  if (el.classList.contains('probe-lamp-on')) return 'on'
  if (el.classList.contains('probe-lamp-unavailable')) return 'unavailable'
  expect(el.classList.contains('probe-lamp-off')).toBe(true)
  return 'off'
}

const SURFACES: Array<{
  name: string
  render: () => void
  probeTestId: string
  probingTestId: string
}> = [
  {
    name: 'Control screen',
    render: () => render(React.createElement(ControlPage)),
    probeTestId: 'control-lamp-probe',
    probingTestId: 'control-lamp-probing',
  },
  {
    name: 'Tools/Probe panel',
    render: () => render(React.createElement(ToolsProbePanel)),
    probeTestId: 'tools-probe-lamp-probe',
    probingTestId: 'tools-probe-lamp-probing',
  },
]

describe('WO-1633 / WO-1671 probe lamps from the bridge status frame', () => {
  it('connected over the real UCCNC controller', () => {
    expect(transport).not.toBeNull()
    expect(useMachineControl.getState().connectionKind).toBe('bridge')
  })

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it('PROBE lamp: true -> lit, false -> off, null -> unavailable, independent of PROBING', () => {
        setSignals(true, undefined)
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('on')
        expect(classOf(surface.probingTestId)).toBe('unavailable')

        setSignals(false, undefined)
        expect(classOf(surface.probeTestId)).toBe('off')

        setSignals(null, undefined)
        expect(classOf(surface.probeTestId)).toBe('unavailable')
      })

      it('PROBING lamp: probeCycle true -> lit for the whole cycle, false -> off, absent -> unavailable', () => {
        // WO-1671 at the machine: the pin stays clear through a deliberate
        // miss while the cycle flag is true on every frame.
        setSignals(false, true)
        surface.render()
        expect(classOf(surface.probingTestId)).toBe('on')
        expect(classOf(surface.probeTestId)).toBe('off')
        setSignals(false, true)
        expect(classOf(surface.probingTestId)).toBe('on')

        setSignals(false, false)
        expect(classOf(surface.probingTestId)).toBe('off')

        setSignals(false, undefined)
        expect(classOf(surface.probingTestId)).toBe('unavailable')

        setSignals(false, null)
        expect(classOf(surface.probingTestId)).toBe('unavailable')
      })

      it('both lit at once without either affecting the other', () => {
        setSignals(true, true)
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('on')
        expect(classOf(surface.probingTestId)).toBe('on')

        setSignals(true, false)
        expect(classOf(surface.probeTestId)).toBe('on')
        expect(classOf(surface.probingTestId)).toBe('off')

        setSignals(false, true)
        expect(classOf(surface.probeTestId)).toBe('off')
        expect(classOf(surface.probingTestId)).toBe('on')
      })
    })
  }

  it('a disconnect drops PROBING back to not reported', async () => {
    setSignals(false, true)
    expect(useMachineControl.getState().probeCycle).toBe(true)
    await act(async () => { await session.disconnectMachine() })
    expect(useMachineControl.getState().probeCycle).toBeNull()
  })

  it('Control screen no longer carries the old single-letter P lamp', () => {
    setSignals(false, false)
    render(React.createElement(ControlPage))
    const row = screen.getByTestId('control-pin-leds')
    const letterLamps = Array.from(row.querySelectorAll('.control-led')).map((el) => el.textContent)
    expect(letterLamps).not.toContain('P')
  })
})
