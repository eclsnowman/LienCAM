// @vitest-environment jsdom
//
// WO-2468 - THE PHONE PENDANT'S CONTINUOUS JOG MOVES LIKE THE DESKTOP'S.
//
// Operator, 2026-10-02 6:05 PM: "I am running into problems now in the
// simulator when I try and jog continuous from my phone via pendant."
//
// ROOT CAUSE: the pendant sent ONE relative jog of the axis's whole travel
// and relied on release to stop it. The simulator refuses any jog whose end is
// outside travel, so from mid-table nothing moved, and Z- never moved at all.
// The desktop's held route (now src/lib/machine/heldJog.ts) is what the
// pendant uses now.
//
// Driven here the way the phone drives it: commands arrive at the real
// PendantBridgeClient as broker frames - the first press, then the same
// command every 150 ms as the phone's keep-alive (pendant/app/app.js), then
// jog-cancel on release - and run through the real executor, the real session
// singleton and the real SimulatedController on Operator's profile,
// docs/machine/profiles/LienCNCV2.machine.json.
//
// NOT CLAIMED: UCCNC, GRBL or LinuxCNC hardware. The native route is pinned
// below against a controller that offers jogStartContinuous/jogHold; whether
// the board moves is only answered by a readback from it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineConfig } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const { PendantBridgeClient } = await import('../../lib/machine/pendantBridge')
const { __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController } = session
type PendantCommand = import('../../lib/machine/pendantBridge').PendantCommand
type PendantWebSocketFactory = import('../../lib/machine/pendantBridge').PendantWebSocketFactory

const PROFILE = JSON.parse(readFileSync(
  resolve('docs/machine/profiles/LienCNCV2.machine.json'),
  'utf8',
)) as MachineConfig

const FEED = 2000
const PHONE_KEEPALIVE_MS = 150

class FakeSocket {
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.(new Event('open')) }
  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

function install(target: MachineConfig): void {
  useCamStore.setState((state) => ({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
}

let originalState: ReturnType<typeof useCamStore.getState>
let bridge: InstanceType<typeof PendantBridgeClient> | null = null
let socket: FakeSocket
let requestSeq = 0

beforeEach(() => {
  vi.useFakeTimers()
  originalState = useCamStore.getState()
  useMachineControl.setState({ consoleLines: [], alarm: null, singleBlock: false })
})

afterEach(async () => {
  bridge?.disable()
  bridge = null
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalState.project,
    machineLibrary: originalState.machineLibrary,
    control: originalState.control,
  })
  __resetEstopInterlockForTest()
  useMachineControl.setState({ consoleLines: [], alarm: null })
  vi.useRealTimers()
})

async function connectSimulator(): Promise<ReturnType<typeof getMachineController>> {
  install(PROFILE)
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1)
  await pending
  __resetEstopInterlockForTest()
  return getMachineController()
}

/** Connect Simulate LienCNC V2 and home it; park at `at` when given. */
async function connectHomed(at?: { x: number; y: number; z: number }) {
  const ctrl = await connectSimulator()
  expect(ctrl.jogStartContinuous).toBeUndefined()
  expect(ctrl.home()).toBe(true)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(ctrl.machineState()).toBe('idle')
  if (at) {
    const pos = ctrl.status().machinePos!
    expect(ctrl.jog('X', at.x - pos.x, 60_000)).toBe(true)
    expect(ctrl.jog('Y', at.y - pos.y, 60_000)).toBe(true)
    expect(ctrl.jog('Z', at.z - pos.z, 60_000)).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctrl.machineState()).toBe('idle')
  }
  useMachineControl.setState({ consoleLines: [] })
  return ctrl
}

/** The phone's relay, paired and acknowledged. */
function pairPhone(): void {
  socket = new FakeSocket()
  bridge = new PendantBridgeClient(executePendantMachineCommand, (() => socket) as PendantWebSocketFactory)
  bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
  socket.open()
  socket.receive({ type: 'hello-ack', role: 'desktop' })
}

function phoneSends(command: PendantCommand): string {
  const requestId = `phone-${++requestSeq}`
  socket.receive({ type: 'command', requestId, clientId: 'phone-a', command })
  return requestId
}

function resultFor(requestId: string): Record<string, unknown> | undefined {
  return socket.sent.find((frame) => frame.type === 'command-result' && frame.requestId === requestId)
}

type Axis = 'X' | 'Y' | 'Z'
const KEY = { X: 'x', Y: 'y', Z: 'z' } as const

/**
 * Hold a phone jog button for `holdMs`: the press, the keep-alive every
 * 150 ms, then (unless `releaseBy` is 'watchdog') the jog-cancel the phone
 * sends on pointerup. Returns the position each 150 ms and the first answer.
 */
async function phoneHold(
  axis: Axis,
  direction: 1 | -1,
  holdMs: number,
  releaseBy: 'cancel' | 'watchdog' = 'cancel',
): Promise<{ samples: number[]; first: Record<string, unknown> | undefined }> {
  const ctrl = getMachineController()
  const command: PendantCommand = { kind: 'jog-continuous', axis, direction, feedMmMin: FEED }
  const firstId = phoneSends(command)
  const samples: number[] = []
  for (let t = PHONE_KEEPALIVE_MS; t <= holdMs; t += PHONE_KEEPALIVE_MS) {
    await vi.advanceTimersByTimeAsync(PHONE_KEEPALIVE_MS)
    samples.push(ctrl.status().machinePos![KEY[axis]])
    if (t < holdMs) phoneSends(command)
  }
  if (releaseBy === 'cancel') phoneSends({ kind: 'jog-cancel' })
  return { samples, first: resultFor(firstId) }
}

/** Advance until the simulator reads idle, then return where it stopped. */
async function settledAt(axis: Axis): Promise<{ at: number; afterMs: number }> {
  const ctrl = getMachineController()
  let afterMs = 0
  while (ctrl.machineState() !== 'idle' && afterMs < 5_000) {
    await vi.advanceTimersByTimeAsync(25)
    afterMs += 25
  }
  return { at: ctrl.status().machinePos![KEY[axis]], afterMs }
}

function errorLines(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

describe('WO-2468: the phone pendant continuous jog through the held-jog route', () => {
  const CASES: Array<[Axis, 1 | -1]> = [['X', 1], ['X', -1], ['Y', 1], ['Y', -1], ['Z', 1], ['Z', -1]]

  it.each(CASES)('from mid-table: %s %i moves while held and stops on release', async (axis, direction) => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    pairPhone()
    const start = ctrl.status().machinePos![KEY[axis]]
    const { samples, first } = await phoneHold(axis, direction, 1_500)
    expect(first).toMatchObject({ ok: true })
    const released = samples[samples.length - 1]
    // It moved for the whole hold, in the pressed direction.
    for (let i = 1; i < samples.length; i++) {
      expect((samples[i] - samples[i - 1]) * direction, samples.join(' ')).toBeGreaterThan(0)
    }
    // 1.5 s at 2000 mm/min is 50 mm; the burst route ramps into it.
    expect((released - start) * direction).toBeGreaterThan(30)
    // Released: it stops within the short queue the train keeps ahead.
    const stopped = await settledAt(axis)
    expect(ctrl.machineState()).toBe('idle')
    expect((stopped.at - released) * direction).toBeGreaterThanOrEqual(-1e-6)
    expect((stopped.at - released) * direction).toBeLessThan(12)
    expect(stopped.afterMs).toBeLessThan(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ctrl.status().machinePos![KEY[axis]]).toBeCloseTo(stopped.at, 6)
    expect(errorLines()).toEqual([])
  }, 60_000)

  it('from home: Z- moves from the top, and X / Y move off their switches', async () => {
    const ctrl = await connectHomed()
    pairPhone()
    const home = { ...ctrl.status().machinePos! }
    const envelope = session.currentResolvedMachineMotion().envelope
    // Away from whichever end of travel the home cycle parked the axis at.
    const offSwitch = (axis: 'X' | 'Y'): 1 | -1 => {
      const range = envelope[KEY[axis]]!
      return home[KEY[axis]] - range.min > range.max - home[KEY[axis]] ? -1 : 1
    }
    expect(home.z).toBeCloseTo(envelope.z!.max, 3)
    for (const [axis, direction] of [['Z', -1], ['X', offSwitch('X')], ['Y', offSwitch('Y')]] as Array<[Axis, 1 | -1]>) {
      const before = ctrl.status().machinePos![KEY[axis]]
      const { first } = await phoneHold(axis, direction, 1_050)
      expect(first, `${axis}${direction}`).toMatchObject({ ok: true })
      const stopped = await settledAt(axis)
      expect((stopped.at - before) * direction, `${axis}${direction} from ${JSON.stringify(home)}`).toBeGreaterThan(20)
    }
    expect(errorLines()).toEqual([])
  }, 60_000)

  it('a phone that stops talking: the bridge watchdog stops the held jog', async () => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    pairPhone()
    const { samples } = await phoneHold('X', -1, 900, 'watchdog')
    const lastHeard = samples[samples.length - 1]
    const stopped = await settledAt('X')
    // 350 ms watchdog after the last keep-alive, then the cancel: never a runaway.
    expect(lastHeard - stopped.at).toBeLessThan(25)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(stopped.at, 6)
    expect(ctrl.machineState()).toBe('idle')
  }, 60_000)

  it('feed hold from the phone ends the held jog timers too', async () => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    pairPhone()
    const jog = vi.spyOn(ctrl, 'jog')
    phoneSends({ kind: 'jog-continuous', axis: 'Y', direction: 1, feedMmMin: FEED })
    await vi.advanceTimersByTimeAsync(300)
    phoneSends({ kind: 'feed-hold' })
    await vi.advanceTimersByTimeAsync(10)
    const sentByHold = jog.mock.calls.length
    expect(sentByHold).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(jog.mock.calls.length).toBe(sentByHold)
  }, 60_000)

  it('step mode is unchanged: one jog of exactly the step', async () => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    pairPhone()
    const jog = vi.spyOn(ctrl, 'jog')
    const id = phoneSends({ kind: 'jog-step', axis: 'X', deltaMm: -10, feedMmMin: FEED })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(resultFor(id)).toMatchObject({ ok: true })
    expect(jog.mock.calls).toEqual([['X', -10, FEED]])
    expect(ctrl.status().machinePos!.x).toBeCloseTo(390, 3)
  }, 60_000)

  it('a controller with its own continuous jog gets jogStartContinuous, holds while held, jogStop + jogCancel on release', async () => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    const calls: string[] = []
    ctrl.jogStartContinuous = async (axis, direction, feed) => {
      calls.push(`start ${axis} ${direction} ${feed}`)
      return true
    }
    ctrl.jogHold = () => { calls.push('hold') }
    ctrl.jogStop = () => { calls.push('stop') }
    const jogCancel = ctrl.jogCancel.bind(ctrl)
    ctrl.jogCancel = () => { calls.push('cancel'); jogCancel() }
    const jog = vi.spyOn(ctrl, 'jog')
    try {
      pairPhone()
      const { first } = await phoneHold('Y', -1, 1_200)
      expect(first).toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(500)
      // One start - the phone's keep-alives renew it, they never restart it.
      expect(calls.filter((c) => c.startsWith('start'))).toEqual([`start Y -1 ${FEED}`])
      // Held: the desktop's own keep-alive every 75 ms (16 in 1.2 s).
      expect(calls.filter((c) => c === 'hold').length).toBeGreaterThanOrEqual(14)
      // Released: stop then cancel, and nothing after them.
      expect(calls.slice(-2)).toEqual(['stop', 'cancel'])
      expect(jog).not.toHaveBeenCalled()
    } finally {
      delete ctrl.jogStartContinuous
      delete ctrl.jogHold
      delete ctrl.jogStop
      ctrl.jogCancel = jogCancel
    }
  }, 60_000)

  it('a refused native start answers the phone and leaves nothing holding', async () => {
    const ctrl = await connectHomed({ x: 400, y: 360, z: 60 })
    const calls: string[] = []
    ctrl.jogStartContinuous = async () => false
    ctrl.jogHold = () => { calls.push('hold') }
    ctrl.jogStop = () => { calls.push('stop') }
    try {
      pairPhone()
      const id = phoneSends({ kind: 'jog-continuous', axis: 'Z', direction: 1, feedMmMin: FEED })
      await vi.advanceTimersByTimeAsync(10)
      expect(resultFor(id)).toMatchObject({ ok: false })
      const holds = calls.filter((c) => c === 'hold').length
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls.filter((c) => c === 'hold').length).toBe(holds)
      expect(calls).toContain('stop')
    } finally {
      delete ctrl.jogStartContinuous
      delete ctrl.jogHold
      delete ctrl.jogStop
    }
  }, 60_000)
})
