// MACHINE-CONTROL: single-block stepping and emergency stop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import { REALTIME } from '../../lib/machine/grbl/constants'
import { CharacterCountStreamer } from '../../lib/machine/grbl/streamer'
import { prepareProgram } from '../../lib/gcode/text'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'

const enc = new TextEncoder()
const dec = new TextDecoder()

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
  lines(): string[] {
    return this.written.filter((w) => w.length > 1).map((w) => dec.decode(w).replace(/\n$/, ''))
  }
  bytes(): number[] {
    return this.written.filter((w) => w.length === 1).map((w) => w[0])
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onConsole: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onStatus: vi.fn(),
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

describe('CharacterCountStreamer.step', () => {
  it('sends exactly one line per step and never auto-fills on ack', () => {
    const sent: string[] = []
    const s = new CharacterCountStreamer((t) => sent.push(t))
    s.load(prepareProgram('G21\nG90\nG1 X1 F100').lines)
    expect(s.step()).toBe(true)
    expect(sent).toEqual(['G21'])
    expect(s.step()).toBe(false) // previous line un-acked
    s.handleAck(true)
    expect(sent).toEqual(['G21']) // paused phase: ack must NOT auto-send
    expect(s.step()).toBe(true)
    s.handleAck(true)
    expect(s.step()).toBe(true)
    s.handleAck(true)
    expect(s.progress().phase).toBe('complete')
    expect(sent).toEqual(['G21', 'G90', 'G1 X1 F100'])
  })

  it('can hand over from stepping to continuous streaming via resume', () => {
    const sent: string[] = []
    const s = new CharacterCountStreamer((t) => sent.push(t))
    s.load(prepareProgram('G21\nG90\nG1 X1 F100\nG1 X2').lines)
    s.step()
    s.handleAck(true)
    s.resume() // switch to continuous
    expect(s.progress().phase).toBe('streaming')
    expect(sent.length).toBe(4) // remainder filled
  })
})

describe('GrblController stepping and E-stop', () => {
  it('stepJob starts the job on first step and sends one line at a time', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG90')
    expect(ctrl.stepJob()).toBe(true)
    expect(events.onJobEvent).toHaveBeenCalledWith('started', null)
    expect(ft.lines()).toEqual(['G21'])
    expect(ctrl.stepJob()).toBe(false) // un-acked
    ft.feed('ok\n')
    expect(ctrl.stepJob()).toBe(true)
    ft.feed('ok\n')
    expect(ctrl.jobProgress().phase).toBe('complete')
    expect(events.onJobEvent).toHaveBeenCalledWith('completed', null)
  })

  it('refuses to step in alarm state', async () => {
    const { ctrl, ft } = await connect()
    ctrl.loadJob('G21')
    ft.feed('ALARM:1\n')
    expect(ctrl.stepJob()).toBe(false)
  })

  it('emergencyStop sends 0x18 immediately and kills the job', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG1 X100 F100\nG1 X0')
    ctrl.startJob()
    ft.written = []
    ctrl.emergencyStop()
    expect(ft.bytes()).toEqual([REALTIME.softReset]) // no feed hold, no settle
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(ctrl.jobProgress().phase).toBe('empty')
    expect(events.onJobEvent).toHaveBeenCalledWith('stopped', null)
  })

  it('emergencyStop cancels a pending controlled-stop timer', async () => {
    const { ctrl, ft } = await connect()
    ctrl.loadJob('G21\nG1 X100 F100')
    ctrl.startJob()
    ctrl.stopJob() // schedules settle-then-reset
    ft.written = []
    ctrl.emergencyStop()
    const resets = ft.bytes().filter((b) => b === REALTIME.softReset).length
    expect(resets).toBe(1)
    await vi.advanceTimersByTimeAsync(1000) // settle timer must NOT fire a second reset
    expect(ft.bytes().filter((b) => b === REALTIME.softReset).length).toBe(1)
  })
})
