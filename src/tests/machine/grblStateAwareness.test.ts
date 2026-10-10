// MACHINE-CONTROL stage 8: WCS / offsets / settings / homing awareness.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseOffsetEntry, parseParserState } from '../../lib/machine/grbl/lines'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import { findToolChanges } from '../../lib/machine/machineSession'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('parseParserState ($G / [GC:...])', () => {
  it('parses the canonical GRBL modal report', () => {
    const s = parseParserState('G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0')
    expect(s.wcs).toBe('G54')
    expect(s.units).toBe('mm')
    expect(s.distanceMode).toBe('absolute')
    expect(s.motionMode).toBe('G0')
    expect(s.tool).toBe(0)
    expect(s.spindle).toBe('off')
    expect(s.coolant).toBe('off')
  })

  it('parses inch/incremental/spindle-on/tool variants', () => {
    const s = parseParserState('G1 G56 G18 G20 G91 M3 M8 T4 F1200.5 S8000')
    expect(s.wcs).toBe('G56')
    expect(s.units).toBe('inch')
    expect(s.distanceMode).toBe('incremental')
    expect(s.tool).toBe(4)
    expect(s.spindle).toBe('cw')
    expect(s.coolant).toBe('flood')
    expect(s.feed).toBe(1200.5)
    expect(s.spindleRpm).toBe(8000)
  })
})

describe('parseOffsetEntry ($# entries)', () => {
  it('parses WCS offsets, TLO and PRB', () => {
    expect(parseOffsetEntry('G54', '-100.000,-50.000,-2.000')).toEqual({
      label: 'G54',
      values: [-100, -50, -2],
    })
    expect(parseOffsetEntry('TLO', '12.500')).toEqual({ label: 'TLO', values: [12.5] })
    expect(parseOffsetEntry('PRB', '0.000,1.500,-5.203:1')).toEqual({
      label: 'PRB',
      values: [0, 1.5, -5.203],
      probeSuccess: true,
    })
    expect(parseOffsetEntry('PRB', '0.000,0.000,0.000:0')!.probeSuccess).toBe(false)
  })

  it('rejects non-offset labels and malformed values', () => {
    expect(parseOffsetEntry('MSG', 'hello')).toBeNull()
    expect(parseOffsetEntry('G54', 'a,b,c')).toBeNull()
  })
})

describe('findToolChanges', () => {
  it('finds T words and pairs them with the adjacent M0 pause (one change)', () => {
    const text = 'G21\nT3\nM0 ( change tool T3 )\nG1 X5 F100\nT5 M6\nG1 X0'
    const changes = findToolChanges(text)
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ tool: 3, sourceLine: 3 }) // anchored on the pause
    expect(changes[1]).toMatchObject({ tool: 5, sourceLine: 5 })
  })

  it('finds a bare tool-change pause with no T word', () => {
    const changes = findToolChanges('G21\nM0 ( tool change )\nG1 X1 F50')
    expect(changes).toHaveLength(1)
    expect(changes[0].tool).toBeNull()
    expect(changes[0].sourceLine).toBe(2)
  })

  it('ignores plain M0 pauses and ordinary lines', () => {
    expect(findToolChanges('G21\nM0 ( clamp your part )\nG1 X1 F50')).toHaveLength(0)
  })
})

// ---- controller-level state awareness (fake transport) ----

class FakeTransport implements MachineTransport {
  events: TransportEvents | null = null
  written: Uint8Array[] = []
  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }
  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
  }
  async close(): Promise<void> {
    this.events?.onClose(null)
  }
  feed(text: string): void {
    this.events!.onChunk(enc.encode(text))
  }
  writtenLines(): string[] {
    return this.written.filter((w) => w.length > 1).map((w) => dec.decode(w).replace(/\n$/, ''))
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onParserState: vi.fn(),
    onOffset: vi.fn(),
    onSetting: vi.fn(),
    onHomed: vi.fn(),
    onConsole: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connect() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0)
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  ft.written = []
  return { ctrl, ft, events }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('GrblController state awareness', () => {
  it('routes [GC:...] to onParserState and $N=V to onSetting', async () => {
    const { ft, events } = await connect()
    ft.feed("[GC:G0 G55 G17 G21 G90 G94 M5 M9 T2 F0 S0]\nok\n$22=1\n$130=740.000\nok\n")
    expect(events.onParserState).toHaveBeenCalledTimes(1)
    expect(events.onParserState.mock.calls[0][0]).toMatchObject({ wcs: 'G55', tool: 2 })
    expect(events.onSetting).toHaveBeenCalledWith('22', '1')
    expect(events.onSetting).toHaveBeenCalledWith('130', '740.000')
  })

  it('routes $# entries to onOffset', async () => {
    const { ft, events } = await connect()
    ft.feed('[G54:-100.000,-50.000,-2.000]\n[G55:0.000,0.000,0.000]\n[TLO:0.000]\n[PRB:0.000,0.000,-5.203:1]\nok\n')
    const labels = events.onOffset.mock.calls.map((c) => c[0].label)
    expect(labels).toEqual(['G54', 'G55', 'TLO', 'PRB'])
  })

  it('marks homed only after $H acks ok, and resets on reconnect banner', async () => {
    const { ctrl, ft, events } = await connect()
    expect(ctrl.homedThisSession()).toBe(false)
    expect(ctrl.home()).toBe(true)
    ft.feed('ok\n')
    expect(ctrl.homedThisSession()).toBe(true)
    expect(events.onHomed).toHaveBeenCalledTimes(1)
    ft.feed("Grbl 1.1h ['$' for help]\r\n") // external reset
    expect(ctrl.homedThisSession()).toBe(false)
  })

  it('does not mark homed when $H fails', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.home()
    ft.feed('error:5\n') // homing not enabled
    expect(ctrl.homedThisSession()).toBe(false)
    expect(events.onHomed).not.toHaveBeenCalled()
  })

  it('selectWcs and refreshState send the right command lines', async () => {
    const { ctrl, ft } = await connect()
    ctrl.selectWcs('G55')
    ctrl.refreshState()
    expect(ft.writtenLines()).toEqual(['G55', '$G', '$#'])
  })

  it('jogToWorkXY emits an absolute work-frame jog and never a Z word', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('<Idle|MPos:5,5,5>\n')
    expect(ctrl.jogToWorkXY(0, 0, 3000)).toBe(true)
    const line = ft.writtenLines().find((l) => l.startsWith('$J='))
    expect(line).toBe('$J=G90 G21 X0 Y0 F3000')
    expect(line).not.toMatch(/Z/)
  })
})
