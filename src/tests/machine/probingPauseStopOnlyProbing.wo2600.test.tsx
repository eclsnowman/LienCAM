// @vitest-environment jsdom
// WO-2600: production feature routine through the real UCCNC controller.
// Fake board harness adapted from WO-2517. No hardware claim.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
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

const TIP_R = 1.5
/** The pin closes within this of a surface: a touch stops ON it. */
const PIN_REACH = 0.01
/** mm the fake board travels between two status frames of a plain move. */
const FRAME_MM = 1

// ---- the table's geometry (machine mm) -------------------------------------
//
//   part        box      X 200..400  Y 200..350  Z 0..30
//   round boss  cylinder centre X 500 Y 150, R 12.5, Z 0..20
//   bore block  box      X 450..550  Y 400..500  Z 0..30, round hole centre
//                        X 500 Y 450, DIAMETER 43.5 (the 10-03 bore), floor Z 10
//   rect boss   box      X 600..625  Y 100..125  Z 0..20
//   pocket blk  box      X 580..680  Y 400..500  Z 0..30, rect pocket
//                        X 617.5..642.5  Y 437.5..462.5, floor Z 10

type Solid = { name: string; hits: (x: number, y: number, z: number, r: number) => boolean }

function rectDist(x: number, y: number, x0: number, x1: number, y0: number, y1: number): number {
  const dx = Math.max(x0 - x, 0, x - x1)
  const dy = Math.max(y0 - y, 0, y - y1)
  return Math.hypot(dx, dy)
}

const EPS = 1e-7
const BORE_R = 43.5 / 2
function box(name: string, x0: number, x1: number, y0: number, y1: number, top: number): Solid {
  return { name, hits: (x, y, z, r) => z > EPS && z < top - EPS + 2 * EPS && rectDist(x, y, x0, x1, y0, y1) < r - EPS }
}

const SOLIDS: Solid[] = [
  box('part', 200, 400, 200, 350, 30),
  {
    name: 'round boss',
    hits: (x, y, z, r) => z > EPS && z <= 20 + EPS && Math.hypot(x - 500, y - 150) < 12.5 + r - EPS,
  },
  {
    name: 'bore block',
    hits: (x, y, z, r) => {
      if (!(z > EPS && z <= 30 + EPS)) return false
      if (rectDist(x, y, 450, 550, 400, 500) >= r - EPS) return false
      if (z <= 10 + EPS) return true
      return Math.hypot(x - 500, y - 450) + r > BORE_R + EPS
    },
  },
  box('rect boss', 600, 625, 100, 125, 20),
  {
    name: 'pocket block',
    hits: (x, y, z, r) => {
      if (!(z > EPS && z <= 30 + EPS)) return false
      if (rectDist(x, y, 580, 680, 400, 500) >= r - EPS) return false
      if (z <= 10 + EPS) return true
      const inside = x - r > 617.5 - EPS && x + r < 642.5 + EPS && y - r > 437.5 - EPS && y + r < 462.5 + EPS
      return !inside
    },
  },
]

function solidAt(p: MachineVec3, r = TIP_R): string | null {
  for (const solid of SOLIDS) if (solid.hits(p.x, p.y, p.z, r)) return solid.name
  return null
}

/** The probe pin: the tip touching (within PIN_REACH) or pushed into a solid. */
const pinAt = (p: MachineVec3): boolean => solidAt(p, TIP_R + PIN_REACH) !== null

function lerp(a: MachineVec3, b: MachineVec3, t: number): MachineVec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

/** The first solid a straight move from a to b passes through, or null. */
function firstHit(a: MachineVec3, b: MachineVec3): { t: number; solid: string } | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  const steps = Math.max(1, Math.ceil(length / 0.05))
  for (let i = 1; i <= steps; i++) {
    const solid = solidAt(lerp(a, b, i / steps))
    if (!solid) continue
    let lo = (i - 1) / steps
    let hi = i / steps
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (solidAt(lerp(a, b, mid))) hi = mid
      else lo = mid
    }
    return { t: lo, solid }
  }
  return null
}

const round4 = (v: number) => Number(v.toFixed(4))
const r4 = (p: MachineVec3): MachineVec3 => ({ x: round4(p.x), y: round4(p.y), z: round4(p.z) })

// ---- the fake board ----------------------------------------------------------

type Frame = { state: 'run' | 'idle'; pos: MachineVec3; move: number; n: number }
type Wire =
  | { kind: 'call'; m: string; a: unknown; at: MachineVec3 }
  | { kind: 'frame'; state: 'run' | 'idle'; pos: MachineVec3; probe: boolean; move: number }

let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 300, y: 275, z: 100 }
let motion: Frame[] = []
let wire: Wire[] = []
/** Plain moves the board has been sent, counted from 1. */
let moveCount = 0
let deferProbe = false
let deferAtProbe = 1
let waitingProbe: { seq: number; axis: keyof MachineVec3; target: number } | null = null
/** The walk: the pin reads ON from this move's second moving frame on. */
let forceOnMove: number | null = null
/** The pin reads ON whatever the geometry (the probe left touching). */
let forceOnAlways = false

function pin(pos: MachineVec3, move: number, n: number): boolean {
  return forceOnAlways || (forceOnMove !== null && move === forceOnMove && n >= 2) || pinAt(pos)
}

function boardStatus(state: 'run' | 'idle', pos: MachineVec3, probe: boolean): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { ...pos },
    workPos: { x: round4(pos.x - g54.x), y: round4(pos.y - g54.y), z: round4(pos.z - g54.z) },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 0.1 },
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe,
      limits: null,
      door: null,
      hold: null,
    },
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  } as MachineStatus
}

function emit(state: 'run' | 'idle', move: number, n: number): void {
  const probe = pin(machinePos, move, n)
  wire.push({ kind: 'frame', state, pos: r4(machinePos), probe, move })
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus(state, machinePos, probe) } as BridgeMessage)
}

/** A plain move, played one frame per FRAME_MM. It runs through any solid. */
function runTo(to: MachineVec3): void {
  const from = { ...machinePos }
  moveCount += 1
  const move = moveCount
  const steps = Math.max(3, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / FRAME_MM))
  motion = []
  for (let i = 1; i <= steps; i++) motion.push({ state: 'run', pos: lerp(from, to, i / steps), move, n: i })
  motion.push({ state: 'idle', pos: { ...to }, move, n: steps + 1 }, { state: 'idle', pos: { ...to }, move, n: steps + 2 })
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const zero = { x: 0, y: 0, z: 0 }
        const offsets = { G54: { ...g54 }, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        if (message.m !== 'queryStatus') wire.push({ kind: 'call', m: message.m, a: message.a, at: r4(machinePos) })
        switch (message.m) {
          case 'queryStatus': {
            const frame = motion.shift()
            if (frame) {
              machinePos = { ...frame.pos }
              emit(frame.state, frame.move, frame.n)
            } else {
              emit('idle', 0, 0)
            }
            reply(true)
            return
          }
          case 'jogToMachineZ': {
            const a = message.a as { z: number }
            reply(true)
            runTo({ ...machinePos, z: a.z })
            return
          }
          case 'jogToWorkXY': {
            const a = message.a as { x: number; y: number }
            reply(true)
            runTo({ x: a.x + g54.x, y: a.y + g54.y, z: machinePos.z })
            return
          }
          case 'jogCancel': {
            if (waitingProbe) {
              bridgeEvents?.onMessage({ t: 'reply', seq: waitingProbe.seq, ok: true, v: { ok: false, at: null, reason: 'stopped' } })
              waitingProbe = null
            }
            // The bridge's StopNow: the axis stops where it is.
            motion = []
            reply(null)
            return
          }
          case 'probe': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
            const key = a.axis.toLowerCase() as keyof MachineVec3
            if (deferProbe && key === 'x' && wire.filter(w => w.kind === 'call' && w.m === 'probe' && (w.a as { axis: string }).axis === 'X').length === deferAtProbe) {
              waitingProbe = { seq: message.seq, axis: key, target: a.targetMm }
              emit('run', 0, 0)
              return
            }
            const from = { ...machinePos }
            const end = { ...machinePos, [key]: a.targetMm }
            const hit = firstHit(from, end)
            const stop = hit ? r4(lerp(from, end, hit.t)) : end
            machinePos = { ...stop }
            motion = []
            emit('idle', 0, 0)
            reply(hit ? { ok: true, at: { ...stop } } : { ok: false, at: null })
            return
          }
          case 'setWorkOffset': {
            const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
            if (a.wcs === 'G54') g54 = { x: a.x ?? g54.x, y: a.y ?? g54.y, z: a.z ?? g54.z }
            reply({ ok: true, reason: null, offset: a.wcs === 'G54' ? { ...g54 } : { x: 0, y: 0, z: 0 } })
            return
          }
          default:
            reply(true)
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runFeatureProbeCycle,
  loadGcodeTextToolpathProgram,
} = session
// Compatibility doors make the test runnable against main without missing
// exports: main's Probing Stop uses Reset, and its only pause is Feed Hold.
const pauseProbing = session.pauseProbing ?? (() => getMachineController().feedHold())
const resumeProbing = session.resumeProbing ?? (() => getMachineController().cycleResume())
const stopProbing = session.stopProbing ?? (() => getMachineController().reset())
const isProbeCyclePaused = session.isProbeCyclePaused ?? (() => getMachineController().machineState() === 'hold')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)

const SCREEN_DEFAULTS = {
  edgeAxis: 'X',
  edgeDirection: '-',
  cornerXDirection: '-',
  cornerYDirection: '-',
  angleNominalAxis: 'X',
  angleProbeDirection: '-',
  angleAlongDirection: '+',
  angleSpacingMm: 25,
  nominalSizeXmm: 25,
  nominalSizeYmm: 25,
  tipRadiusMm: 1.5,
} as const

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  emit('idle', 0, 0)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54' })
  wire = []
  moveCount = 0
}

async function settle<T>(pending: Promise<T>): Promise<T | null> {
  let value: T | null = null
  let finished = false
  void pending.then((v) => { value = v; finished = true })
  for (let i = 0; i < 6000 && !finished; i++) await vi.advanceTimersByTimeAsync(50)
  return value
}

function standAt(p: MachineVec3): void {
  machinePos = { ...p }
  motion = []
  emit('idle', 0, 0)
}

function plan(start: MachineVec3, input: Partial<PlanInput> & Pick<PlanInput, 'kind'>) {
  const planned = planFeatureProbeCycle({
    ...SCREEN_DEFAULTS,
    ...input,
    start,
    envelope,
    config: CONFIG,
    tipRadiusMm: TIP_R,
  } as PlanInput)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

const calls = (m?: string) => wire.filter((w): w is Extract<Wire, { kind: 'call' }> => w.kind === 'call' && (m === undefined || w.m === m))
const MOTION_VERBS = new Set(['jogToWorkXY', 'jogToMachineZ', 'jog', 'probe'])

beforeEach(() => {
  vi.useFakeTimers()
  wire = []
  motion = []
  moveCount = 0
  deferProbe = false
  deferAtProbe = 1
  waitingProbe = null
  forceOnMove = null
  forceOnAlways = false
  g54 = { x: 500, y: 450, z: 30 }
  machinePos = { x: 300, y: 275, z: 100 }
  mem.clear()
  useCamStore.getState().newProject()
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {}, probe: null })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})


describe('WO-2600 probing controls isolate the routine (real UccncController, fake bridge)', () => {
  it('Pause cancels a plain move; Resume repeats its absolute endpoint and completes the same routine', async () => {
    await connectBridge()
    const start = { x: 500, y: 450, z: 40 }
    standAt(start)
    const pending = runFeatureProbeCycle(plan(start, { kind: 'bore', nominalSizeXmm: 43.5, nominalSizeYmm: 43.5 }), CONFIG, true)
    for (let i = 0; i < 100 && calls().filter(c => MOTION_VERBS.has(c.m)).length === 0; i++) await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    const original = calls().filter(c => c.m === 'jogToMachineZ' || c.m === 'jogToWorkXY').at(-1)!
    expect(original).toBeTruthy()
    const job = { ...useMachineControl.getState().job }
    pauseProbing()
    expect(isProbeCyclePaused()).toBe(true)
    expect(calls('jogCancel')).toHaveLength(1)
    const stopped = { ...machinePos }
    const mark = calls().length
    await vi.advanceTimersByTimeAsync(60000)
    expect(machinePos).toEqual(stopped)
    expect(calls().slice(mark).filter(c => MOTION_VERBS.has(c.m))).toEqual([])
    expect(useMachineControl.getState().job).toEqual(job)
    expect(getMachineController().cycleResume()).toBe(true)
    const result = await settle(pending)
    expect(result?.ok, result?.message).toBe(true)
    expect(calls(original.m)[1].a).toEqual(original.a)
    expect(calls('reset')).toHaveLength(0)
    expect(calls('stopJob')).toHaveLength(0)
  })

  it.each([false, true])('Stop from paused=%s ends only probing, sends no more motion, and permits a new routine', async (paused) => {
    await connectBridge()
    const start = { x: 500, y: 450, z: 40 }
    standAt(start)
    const makePlan = () => plan(start, { kind: 'bore', nominalSizeXmm: 43.5, nominalSizeYmm: 43.5 })
    expect(loadGcodeTextToolpathProgram('loaded-air.nc', 'G90 G21 G54\nG0 X10 Y10 Z10\nM30', { publishListing: true }).ok).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    const pending = runFeatureProbeCycle(makePlan(), CONFIG, true)
    await vi.advanceTimersByTimeAsync(20)
    if (paused) pauseProbing()
    const job = { ...useMachineControl.getState().job }
    stopProbing()
    const mark = calls().length
    const result = await settle(pending)
    expect(result).toMatchObject({ ok: false, stopped: true })
    expect(result?.message).toContain('stopped by Stop during')
    expect(useMachineControl.getState().job).toEqual(job)
    expect(calls().slice(mark).filter(c => MOTION_VERBS.has(c.m))).toEqual([])
    expect(calls('reset')).toHaveLength(0)
    expect(calls('stopJob')).toHaveLength(0)
    standAt(start)
    expect((await settle(runFeatureProbeCycle(makePlan(), CONFIG, true)))?.ok).toBe(true)
  })
})

it.each([1, 2])('cancelled native X seek %i (fast/slow) repeats the same endpoint, with less remaining travel', async (which) => {
  deferAtProbe = which
  await connectBridge()
  const start = { x: 500, y: 450, z: 40 }
  standAt(start)
  deferProbe = true
  const pending = runFeatureProbeCycle(plan(start, { kind: 'bore', nominalSizeXmm: 43.5, nominalSizeYmm: 43.5 }), CONFIG, true)
  for (let i = 0; i < 2000 && !waitingProbe; i++) await vi.advanceTimersByTimeAsync(10)
  expect(waitingProbe).not.toBeNull()
  const probeCount = calls('probe').length
  const original = calls('probe').at(-1)!
  const seek = waitingProbe!
  machinePos = { ...machinePos, [seek.axis]: machinePos[seek.axis] + 0.1 * Math.sign(seek.target - machinePos[seek.axis]) }
  const stopped = { ...machinePos }
  pauseProbing()
  await vi.advanceTimersByTimeAsync(60000)
  expect(calls('probe')).toHaveLength(probeCount)
  expect(machinePos).toEqual(stopped)
  deferProbe = false
  resumeProbing()
  const result = await settle(pending)
  expect(result?.ok, result?.message).toBe(true)
  expect(calls('probe')[probeCount].a).toEqual(original.a)
  expect(calls('probe')[probeCount].at).toEqual(stopped)
})

it('Pause after contact does not ProbeStop the native cycle; it holds before the next move', async () => {
  await connectBridge()
  const start = { x: 500, y: 450, z: 40 }
  standAt(start)
  deferProbe = true
  const pending = runFeatureProbeCycle(plan(start, { kind: 'bore', nominalSizeXmm: 43.5, nominalSizeYmm: 43.5 }), CONFIG, true)
  for (let i = 0; i < 2000 && !waitingProbe; i++) await vi.advanceTimersByTimeAsync(10)
  expect(waitingProbe).not.toBeNull()
  const seek = waitingProbe!
  // Contact arrived while the native call is still waiting for its cycle end.
  machinePos = { ...machinePos, [seek.axis]: 500 - BORE_R + TIP_R }
  forceOnAlways = true
  emit('run', 0, 0)
  pauseProbing()
  expect(calls('jogCancel')).toHaveLength(0)
  bridgeEvents!.onMessage({ t: 'reply', seq: seek.seq, ok: true, v: { ok: true, at: { ...machinePos } } })
  waitingProbe = null
  emit('idle', 0, 0)
  const mark = calls().length
  await vi.advanceTimersByTimeAsync(60000)
  expect(calls().slice(mark).filter(c => MOTION_VERBS.has(c.m))).toEqual([])
  stopProbing()
  expect(await settle(pending)).toMatchObject({ ok: false, stopped: true })
})

