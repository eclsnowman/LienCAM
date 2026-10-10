// WO-440: restores the GrblController coverage `grblProbe.test.ts` carried
// before WO-433 retired it along with `SimulatedGrblTransport`. Only 2 of its
// original 9 tests actually exercised that transport; the other 7 test
// GrblController's own protocol handling (sendCommandAwait's ack plumbing,
// GRBL wire parsing for probe/alarm/offset/status lines) and are still live
// today. Recovered from git (`git show 9c51b161^:src/tests/machine/grblProbe.test.ts`)
// and rewritten against a scripted BytePipe instead of the deleted simulator -
// the assertions are the originals', not a paraphrase.
//
// NOT restored (2 of the original 9) - both genuinely tested
// SimulatedGrblTransport, not GrblController, and have no meaning against a
// scripted fake that only echoes back whatever a test tells it to:
//
//  - 'a probe move never yields a spurious ok before the cycle ends' -
//    asserted the SIMULATOR's real-time G38.2 motion (TICK_MS-driven
//    SimMove queue) did not resolve early. A scripted BytePipe controls
//    exactly when bytes arrive, so "not yet resolved at 1000ms of a ~4s
//    move" is just "we did not feed the ok yet" - a tautology, not a test.
//  - 'work zero set through the pad accounts for the pad thickness' -
//    asserted the SIMULATOR's virtual-pad arithmetic (probePadZ=-40, pad
//    10mm thick) produced the correct G54 offset after G10 L20 P0. GRBL
//    itself (real or fake) OWNS that arithmetic and just reports the
//    result; scripting the fake to answer with the "right" number would
//    only be asserting that our fixture echoed what we told it to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import { FakeBytePipe } from '../helpers/fakeBytePipe'

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onStatus: vi.fn(),
    onConsole: vi.fn(),
    onAlarm: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onWelcome: vi.fn(),
    onParserState: vi.fn(),
    onOffset: vi.fn(),
    onSetting: vi.fn(),
    onHomed: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connect() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const pipe = new FakeBytePipe()
  const pending = ctrl.connect({ kind: 'bytes', transport: pipe })
  await vi.advanceTimersByTimeAsync(0) // let start() settle and the banner waiter register
  pipe.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  pipe.clearWritten() // drop handshake-era writes for cleaner assertions
  return { ctrl, pipe, events }
}

/** Await an ack promise under fake timers: advance until it settles. */
async function settle<T>(p: Promise<T> | null, ms: number): Promise<T> {
  expect(p).not.toBeNull()
  let out: T | undefined
  let done = false
  void p!.then((v) => {
    out = v
    done = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  expect(done).toBe(true)
  return out!
}

function lastPrb(events: ReturnType<typeof makeEvents>) {
  return events.onOffset.mock.calls.filter((c) => c[0].label === 'PRB').at(-1)?.[0]
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('sendCommandAwait', () => {
  it('resolves ok for an accepted command and error for a rejected one', async () => {
    const { ctrl, pipe } = await connect()
    const goodPending = ctrl.sendCommandAwait('G21')
    pipe.feed('ok\r\n')
    const good = await settle(goodPending, 100)
    expect(good).toEqual({ ok: true, code: 0, message: '' })

    const badPending = ctrl.sendCommandAwait('$FOO')
    pipe.feed('error:3\r\n')
    const bad = await settle(badPending, 100)
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe(3)
  })

  it('is refused while a job is streaming', async () => {
    const { ctrl } = await connect()
    // Enough motion to keep the planner queue (STREAM_BYTE_LIMIT) holding acks back.
    const lines = Array.from({ length: 25 }, (_, i) => `G1 X${i + 1} F600`)
    ctrl.loadJob(lines.join('\n'))
    expect(ctrl.startJob()).toBe(true)
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(ctrl.sendCommandAwait('G21')).toBeNull()
  })

  it('settles pending awaits as failed when the connection dies', async () => {
    const { ctrl } = await connect()
    const pending = ctrl.sendCommandAwait('G91 G38.2 Z-30 F60') // 30s of travel, never answered
    expect(pending).not.toBeNull()
    const disconnect = ctrl.disconnect()
    const ack = await settle(pending, 100)
    await disconnect
    expect(ack.ok).toBe(false)
    expect(ack.code).toBe(-1)
  })
})

describe('G38.2 probe', () => {
  it('contact: reports [PRB:...:1] before the ok', async () => {
    const { ctrl, pipe, events } = await connect()
    const pending = ctrl.sendCommandAwait('G91 G38.2 Z-50 F6000')
    expect(pending).not.toBeNull()
    // Real GRBL emits the [PRB:...] feedback line before the cycle's ok.
    pipe.feed('[PRB:0.000,0.000,-40.000:1]\r\n')
    pipe.feed('ok\r\n')
    const ack = await settle(pending, 100)
    expect(ack.ok).toBe(true)
    const prb = lastPrb(events)
    expect(prb?.probeSuccess).toBe(true)
    expect(prb?.values[2]).toBeCloseTo(-40, 1)

    ctrl.queryStatus()
    pipe.feed('<Idle|MPos:0.000,0.000,-40.000|FS:0,0>\r\n')
    await vi.advanceTimersByTimeAsync(10)
    const report = events.onStatus.mock.calls.at(-1)![0]
    expect(report.mpos.z).toBeCloseTo(-40, 1)
    expect(report.state).toBe('idle')
  })

  it('miss: reaches max travel, raises ALARM:5, ack fails, $X recovers', async () => {
    const { ctrl, pipe, events } = await connect()
    const pending = ctrl.sendCommandAwait('G91 G38.2 Z-10 F6000')
    expect(pending).not.toBeNull()
    pipe.feed('[PRB:0.000,0.000,-10.000:0]\r\n')
    pipe.feed('ALARM:5\r\n')
    const ack = await settle(pending, 100)
    expect(ack.ok).toBe(false)
    expect(events.onAlarm).toHaveBeenCalledWith(5, expect.any(String), false)
    expect(lastPrb(events)?.probeSuccess).toBe(false)

    const unlockPending = ctrl.sendCommandAwait('$X')
    pipe.feed('ok\r\n')
    const unlock = await settle(unlockPending, 100)
    expect(unlock.ok).toBe(true)

    ctrl.queryStatus()
    pipe.feed('<Idle|MPos:0.000,0.000,-10.000|FS:0,0>\r\n')
    await vi.advanceTimersByTimeAsync(10)
    expect(events.onStatus.mock.calls.at(-1)![0].state).toBe('idle')
  })
})

describe('G43.1 / G49 tool length offset', () => {
  it('G43.1 sets TLO without motion; G49 clears it', async () => {
    const { ctrl, pipe, events } = await connect()
    const applyPending = ctrl.sendCommandAwait('G43.1 Z-2.5')
    pipe.feed('ok\r\n')
    const apply = await settle(applyPending, 100)
    expect(apply.ok).toBe(true)

    ctrl.refreshState() // $G then $#
    pipe.feed('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n')
    pipe.feed('ok\r\n')
    pipe.feed('[TLO:-2.500]\r\n')
    pipe.feed('ok\r\n')
    await vi.advanceTimersByTimeAsync(10)
    const tlo = events.onOffset.mock.calls.filter((c) => c[0].label === 'TLO').at(-1)![0]
    expect(tlo.values[0]).toBeCloseTo(-2.5, 3)

    ctrl.queryStatus()
    pipe.feed('<Idle|MPos:0.000,0.000,0.000|FS:0,0>\r\n')
    await vi.advanceTimersByTimeAsync(10)
    expect(events.onStatus.mock.calls.at(-1)![0].mpos).toEqual({ x: 0, y: 0, z: 0 })

    const clearPending = ctrl.sendCommandAwait('G49')
    pipe.feed('ok\r\n')
    await settle(clearPending, 100)

    ctrl.refreshState()
    pipe.feed('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n')
    pipe.feed('ok\r\n')
    pipe.feed('[TLO:0.000]\r\n')
    pipe.feed('ok\r\n')
    await vi.advanceTimersByTimeAsync(10)
    const cleared = events.onOffset.mock.calls.filter((c) => c[0].label === 'TLO').at(-1)![0]
    expect(cleared.values[0]).toBe(0)
  })

  it('offset changes push WCO in the NEXT status report - work DRO never stale', async () => {
    const { ctrl, pipe, events } = await connect()
    // Machine sits at MPos Z0; declare this work Z10 -> WCO Z becomes -10.
    const zeroPending = ctrl.sendCommandAwait('G10 L20 P0 Z10')
    pipe.feed('ok\r\n')
    await settle(zeroPending, 100)
    ctrl.queryStatus()
    pipe.feed('<Idle|MPos:0.000,0.000,0.000|WCO:0.000,0.000,-10.000|FS:0,0>\r\n')
    await vi.advanceTimersByTimeAsync(10)
    const [, derived] = events.onStatus.mock.calls.at(-1)!
    expect(derived.wpos.z).toBeCloseTo(10, 3) // fresh WCO, immediately

    // Same for a tool length offset: TLO folds into the same WCO field.
    const tloPending = ctrl.sendCommandAwait('G43.1 Z1.5')
    pipe.feed('ok\r\n')
    await settle(tloPending, 100)
    ctrl.queryStatus()
    pipe.feed('<Idle|MPos:0.000,0.000,0.000|WCO:0.000,0.000,-8.500|FS:0,0>\r\n')
    await vi.advanceTimersByTimeAsync(10)
    const [, derived2] = events.onStatus.mock.calls.at(-1)!
    expect(derived2.wpos.z).toBeCloseTo(8.5, 3)
  })
})
