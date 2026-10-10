// WO-056: live accessory state (spindle CW/CCW, flood, mist) end to end -
// parser -> GrblController cache -> store, plus the simulated transport's
// A: emission. GRBL appends A: only to override-bearing reports and only
// when something is on, so "absent" must resolve downstream, not upstream.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'
import { useMachineControl } from '../../store/machineControlStore'

const enc = new TextEncoder()

const OFF = { spindle: 'off', flood: false, mist: false }

class FakeTransport implements MachineTransport {
  events: TransportEvents | null = null
  written: Uint8Array[] = []
  closed = false

  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.events?.onClose(null)
  }

  feed(text: string): void {
    this.events!.onChunk(enc.encode(text))
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onStatus: vi.fn(),
    onConsole: vi.fn(),
    onAlarm: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onWelcome: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connectFake() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0)
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  return { ctrl, ft, events }
}

function lastAccessories(events: ReturnType<typeof makeEvents>) {
  return events.onStatus.mock.calls.at(-1)![1].accessories
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('GrblController accessory cache', () => {
  it('decodes and forwards a reported A: field', async () => {
    const { ft, events } = await connectFake()
    ft.feed('<Run|MPos:0,0,0|FS:100,8000|Ov:100,100,100|A:SF>\n')
    expect(lastAccessories(events)).toEqual({ spindle: 'cw', flood: true, mist: false })
  })

  it('starts all-off before any report mentions accessories', async () => {
    const { ft, events } = await connectFake()
    ft.feed('<Idle|MPos:0,0,0|FS:0,0>\n')
    expect(lastAccessories(events)).toEqual(OFF)
  })

  it('resolves Ov-without-A to all-off (GRBL omits A when nothing is on)', async () => {
    const { ft, events } = await connectFake()
    ft.feed('<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:S>\n')
    expect(lastAccessories(events)).toEqual({ spindle: 'cw', flood: false, mist: false })
    ft.feed('<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100>\n')
    expect(lastAccessories(events)).toEqual(OFF)
  })

  it('keeps the cache across reports that carry no override group', async () => {
    const { ft, events } = await connectFake()
    ft.feed('<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:CM>\n')
    ft.feed('<Run|MPos:1,0,0|FS:100,0>\n') // no Ov, no A - not accessory info
    expect(lastAccessories(events)).toEqual({ spindle: 'ccw', flood: false, mist: true })
  })

  it('tracks transitions cw -> ccw -> flood -> mist -> off', async () => {
    const { ft, events } = await connectFake()
    const seq: Array<[string, object]> = [
      ['A:S', { spindle: 'cw', flood: false, mist: false }],
      ['A:C', { spindle: 'ccw', flood: false, mist: false }],
      ['A:F', { spindle: 'off', flood: true, mist: false }],
      ['A:M', { spindle: 'off', flood: false, mist: true }],
      ['', OFF],
    ]
    for (const [field, want] of seq) {
      ft.feed(`<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100${field ? '|' + field : ''}>\n`)
      expect(lastAccessories(events)).toEqual(want)
    }
  })

  it('a mid-session banner (controller reset) clears the cache to all-off', async () => {
    const { ft, events } = await connectFake()
    ft.feed('<Run|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:SF>\n')
    ft.feed("Grbl 1.1h ['$' for help]\r\n")
    ft.feed('<Idle|MPos:0,0,0|FS:0,0>\n') // no Ov group - would keep a stale cache
    expect(lastAccessories(events)).toEqual(OFF)
  })
})

describe('machineControlStore reported accessories', () => {
  it('applyStatus threads the resolved accessory state into the store', () => {
    const s = useMachineControl.getState()
    s.applyStatus('run', null, { x: 0, y: 0, z: 0 }, null, 100, 8000, null, null, {
      spindle: 'ccw',
      flood: true,
      mist: false,
    })
    expect(useMachineControl.getState().reportedAccessories).toEqual({
      spindle: 'ccw',
      flood: true,
      mist: false,
    })
  })

  it('disconnect resets accessories to all-off with the other live readouts', () => {
    const s = useMachineControl.getState()
    s.applyStatus('run', null, null, null, null, null, null, null, {
      spindle: 'cw',
      flood: false,
      mist: true,
    })
    s.setConnection('disconnected', null)
    expect(useMachineControl.getState().reportedAccessories).toEqual(OFF)
  })
})

// WO-433: the "SimulatedGrblTransport accessory reporting end to end" block
// that lived here drove GrblController over SimulatedGrblTransport, which
// this WO deleted (the simulator no longer speaks GRBL - see
// src/lib/machine/simulatedController.ts). The same M3/M4/M8/M7/M5/M9 matrix
// against the native simulator is covered by
// simulatedControllerMdi.wo434.test.ts's "M3/M4/M5 drive the spindle
// immediately" / "M7/M8/M9 drive coolant immediately" cases.
