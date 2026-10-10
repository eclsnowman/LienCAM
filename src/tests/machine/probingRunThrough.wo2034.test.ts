// @vitest-environment jsdom
//
// WO-2034 - A RUN-THROUGH OF EVERY PROBING ROUTINE ON THE NATIVE ROUTE.
//
// Operator at the machine, 2026-09-26: "how do we handle probing multiple sides of
// stock if the tool probing never changes Z?" This file is the run-through record
// behind docs/design/PROBING-PAINT-BY-NUMBERS.md: each routine is planned by the
// production planner the Probing screen's Run button uses (planFeatureProbeCycle,
// with the screen's own default directions and the machine's default probe
// settings) and executed by the production runner (runFeatureProbeCycle /
// runZProbeCycle / runSurfaceMeshProbeCycle) through the REAL UccncController,
// over a fake bridge socket that plays a board with solid geometry on the table:
//
//   part        box      X 200..400  Y 200..350  Z 0..30   (the stock; G54 at its
//                                                           front-left top corner)
//   round boss  cylinder centre X 500 Y 150, R 12.5, Z 0..20
//   bore block  box      X 450..550  Y 400..500  Z 0..30, round hole centre
//                        X 500 Y 450, R 12.5, floor Z 10
//   rect boss   box      X 600..625  Y 100..125  Z 0..20
//   pocket blk  box      X 580..680  Y 400..500  Z 0..30, rect pocket
//                        X 617.5..642.5  Y 437.5..462.5, floor Z 10
//
// The fake probe stops where a 1.5 mm radius tip first touches a solid (the same
// radius the plans compensate); a positioning move that passes through a solid is
// recorded as a COLLISION (the board runs it anyway - so does a real one).
//
// What is pinned here is TODAY'S behaviour, as a record. The build orders filed
// from the design change some of it; each such pin names that order, and the
// order's grant must include this file.
//
// NOT CLAIMED: hardware. The board is a model of the answers, not the AXBB-E.

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

// ---- the table's geometry ------------------------------------------------

type Solid = { name: string; hits: (x: number, y: number, z: number, r: number) => boolean }

function rectDist(x: number, y: number, x0: number, x1: number, y0: number, y1: number): number {
  const dx = Math.max(x0 - x, 0, x - x1)
  const dy = Math.max(y0 - y, 0, y - y1)
  return Math.hypot(dx, dy)
}

const EPS = 1e-7
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
      return Math.hypot(x - 500, y - 450) + r > 12.5 + EPS
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

function solidAt(p: MachineVec3): string | null {
  for (const solid of SOLIDS) if (solid.hits(p.x, p.y, p.z, TIP_R)) return solid.name
  return null
}

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

// ---- the fake board --------------------------------------------------------

type TraceEntry =
  | { verb: 'move'; from: MachineVec3; to: MachineVec3; collision: string | null }
  | { verb: 'probe'; axis: 'X' | 'Y' | 'Z'; from: MachineVec3; target: number; contact: MachineVec3 | null }
  | { verb: 'setWorkOffset'; wcs: string; z?: number; x?: number; y?: number }

let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 300, y: 275, z: 100 }
let motion: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
let trace: TraceEntry[] = []

function offsets(): Record<string, MachineVec3> {
  const zero = { x: 0, y: 0, z: 0 }
  return { G54: { ...g54 }, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
}

function boardStatus(state: 'run' | 'idle', pos: MachineVec3): MachineStatus {
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
    inputs: null,
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  } as MachineStatus
}

function runTo(to: MachineVec3): void {
  const from = { ...machinePos }
  const hit = firstHit(from, to)
  trace.push({ verb: 'move', from: r4(from), to: r4(to), collision: hit ? hit.solid : null })
  motion = [
    { state: 'run', pos: lerp(from, to, 0.5) },
    { state: 'idle', pos: { ...to } },
    { state: 'idle', pos: { ...to } },
  ]
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets(), profile: offsets() },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            const frame = motion.shift()
            if (frame) machinePos = { ...frame.pos }
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus(frame?.state ?? 'idle', machinePos) } as BridgeMessage)
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
          case 'selectWcs':
            reply(true)
            return
          case 'probe': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
            const key = a.axis.toLowerCase() as keyof MachineVec3
            const from = { ...machinePos }
            const end = { ...machinePos, [key]: a.targetMm }
            const hit = firstHit(from, end)
            const stop = hit ? r4(lerp(from, end, hit.t)) : end
            trace.push({ verb: 'probe', axis: a.axis, from: r4(from), target: a.targetMm, contact: hit ? stop : null })
            machinePos = { ...stop }
            motion = []
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
            reply(hit ? { ok: true, at: { ...stop } } : { ok: false, at: null })
            return
          }
          case 'setWorkOffset': {
            const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
            trace.push({ verb: 'setWorkOffset', wcs: a.wcs, ...(a.z !== undefined ? { z: a.z } : {}), ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}) })
            if (a.wcs === 'G54') g54 = { x: a.x ?? g54.x, y: a.y ?? g54.y, z: a.z ?? g54.z }
            reply({ ok: true, reason: null, offset: a.wcs === 'G54' ? { ...g54 } : { x: 0, y: 0, z: 0 } })
            return
          }
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore, controlMachine } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runFeatureProbeCycle,
  runSurfaceMeshProbeCycle,
  runZProbeCycle,
  setProbeSensing,
} = await import('../../lib/machine/machineSession')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { planSurfaceMesh } = await import('../../lib/machine/zSurfaceMesh')
const { calculateCorner, calculateEdge } = await import('../../lib/machine/probeRoutines')

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]

/** The machine's default probe settings, as a fresh machine has them. */
const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)

/** The Probing screen's defaults (ProbingPanel.tsx useProbingSessionState seeds). */
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
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54' })
  sent = []
  trace = []
}

async function settle<T>(pending: Promise<T>): Promise<T | null> {
  let value: T | null = null
  let finished = false
  void pending.then((v) => { value = v; finished = true })
  for (let i = 0; i < 6000 && !finished; i++) await vi.advanceTimersByTimeAsync(50)
  return value
}

/** Stand the machine where the operator jogged it. */
function standAt(p: MachineVec3): void {
  machinePos = { ...p }
  motion = []
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
}

async function runRoutine(start: MachineVec3, input: Omit<PlanInput, 'start' | 'envelope' | 'config' | 'tipRadiusMm'>) {
  await connectBridge()
  standAt(start)
  await vi.advanceTimersByTimeAsync(50)
  const planned = planFeatureProbeCycle({
    ...SCREEN_DEFAULTS,
    ...input,
    start,
    envelope,
    config: CONFIG,
    tipRadiusMm: TIP_R,
  } as PlanInput)
  expect(planned.ok).toBe(true)
  if (!planned.ok) throw new Error(planned.reason)
  const result = await settle(runFeatureProbeCycle(planned.plan, CONFIG, true))
  return { plan: planned.plan, result, trace: [...trace] }
}

const zOf = (entries: TraceEntry[]) => new Set(entries.flatMap((e) =>
  e.verb === 'move' ? [e.from.z, e.to.z] : e.verb === 'probe' ? [e.from.z] : []))
const probes = (entries: TraceEntry[]) => entries.filter((e): e is Extract<TraceEntry, { verb: 'probe' }> => e.verb === 'probe')
const collisions = (entries: TraceEntry[]) => entries.flatMap((e) => (e.verb === 'move' && e.collision ? [e.collision] : []))

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  trace = []
  motion = []
  g54 = { x: 200, y: 200, z: 30 }
  machinePos = { x: 300, y: 275, z: 100 }
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
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

describe('WO-2034 run-through: the machine probe defaults and the screen defaults', () => {
  it('records the defaults every routine below runs on', () => {
    expect(CONFIG).toEqual({
      positioningFeed: 1000,
      fastFeed: 400,
      slowFeed: 50,
      retract: 2,
      maxTravel: 50,
      surfaceClearance: 5,
      overtravel: 5,
      crossOverLift: 10,
      padThickness: 10,
    })
    // Edge defaults to X, direction '-': the probe travels X- and so touches the
    // RIGHT face of the part. X zero is normally the LEFT face (-> build order
    // "logical defaults").
    expect(SCREEN_DEFAULTS.edgeDirection).toBe('-')
  })
})

describe('WO-2034 run-through: side routines (native route) - Edge and Angle work from the top since WO-2055, Outside corner since WO-2056, Inside corner, Bore and Rect pocket since WO-2057 (Boss and Rect boss since WO-2058, below)', () => {
  // WO-2055: Edge starts OVER the material. It touches the top, rises to top +
  // clearance, steps out past the face, descends to top - depth as a probe move
  // that stops on contact, touches the face there and rises again.
  it('Edge X+ (-> WO-2055) from over the part, 5 mm inside the left face, above its top: top, safe height, step out, guarded descent, face', async () => {
    const run = await runRoutine({ x: 205, y: 275, z: 40 }, { kind: 'edge', edgeAxis: 'X', edgeDirection: '+' })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { edge: 198.5 } })
    expect(collisions(run.trace)).toEqual([])
    expect(probes(run.trace).map((p) => [p.axis, p.from.x, p.from.z, p.target, p.contact === null ? null : p.axis === 'Z' ? p.contact.z : p.contact.x])).toEqual([
      ['Z', 205, 40, -10, 30], // the top, fast
      ['Z', 205, 32, 28, 30], // the top, slow
      ['Z', 188.5, 35, 25, null], // guarded descent: 16.5 mm out, top + 5 down to top - 5, nothing touched
      ['X', 188.5, 25, 208.5, 198.5], // the face, fast: one bounded 20 mm seek (WO-2569 / WO-2036)
      ['X', 196.5, 25, 200.5, 198.5], // the face, slow
    ])
    // It rose to safe height before stepping out, and again after the face.
    const moves = run.trace.filter((e): e is Extract<TraceEntry, { verb: 'move' }> => e.verb === 'move')
    expect(moves.filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y).map((m) => [m.from.z, m.to.x])).toEqual([
      [35, 188.5],
      [25, 196.5], // the 2 mm back-offs off the face
      [25, 196.5],
    ])
    expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 196.5, z: 35 } })
    const face = calculateEdge({ axis: 'X', direction: '+', triggerPositionMm: 198.5, tipRadiusMm: TIP_R })
    expect(face.coordinateMm).toBe(200)
  })

  it('Edge X+ (-> WO-2055) started where the old screen said - outside the face at probing depth: the top touch searches down beside the part and finds nothing on this table', async () => {
    const run = await runRoutine({ x: 190, y: 275, z: 25 }, { kind: 'edge', edgeAxis: 'X', edgeDirection: '+' })
    expect(run.result).toMatchObject({ ok: false, topMachineZ: null })
    // WO-2108: a top touch that finds nothing says so, not "check the probe wiring".
    expect(run.result?.message).toMatch(/^Touch the top stopped: no top found within 50\.00 mm below where the probe started/)
    expect(probes(run.trace)).toEqual([expect.objectContaining({ axis: 'Z', target: -25, contact: null })])
    expect(collisions(run.trace)).toEqual([])
  })

  it('Edge with the SCREEN DEFAULT direction (X-) started near the LEFT face steps out over the part: the guarded descent lands on the top, stops there and says so', async () => {
    const run = await runRoutine({ x: 205, y: 275, z: 40 }, { kind: 'edge' })
    expect(run.result).toMatchObject({ ok: false, touches: {} })
    const said = 'Probe edge: the descent touched at G54 Z 0.00 mm (machine Z 30.00 mm), above probing depth G54 Z -5.00 mm (machine Z 25.00 mm) - start closer to the edge.'
    expect(run.result?.message).toBe(said)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text)).toContain(said)
    expect(probes(run.trace).at(-1)).toMatchObject({ axis: 'Z', from: { x: 221.5, z: 35 }, target: 25, contact: { z: 30 } })
    // It stopped where it touched: no side touch, no further move.
    expect(run.trace.at(-1)?.verb).toBe('probe')
    expect(collisions(run.trace)).toEqual([])
  })

  // WO-2057 (design 4.1): Inside corner, Bore and Rect pocket start over the
  // hole at any height. Their top is work Z0 (G54 Z 30 here: the blocks' top
  // face) or a rim touch. The cycle descends once, over the start, to top - 5
  // as a probe move that stops on contact, runs the same wall touches as
  // before from there, and rises to top + 5. Until then every wall touch ran at
  // whatever height the operator left the probe.
  it('Inside corner (-> WO-2057, X- then Y-) from over the pocket corner, above the top: guarded descent to work Z0 - 5, the same two touches, rise', async () => {
    const run = await runRoutine({ x: 622, y: 442, z: 40 }, { kind: 'insideCorner' })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { cornerX: 619, cornerY: 439 } })
    expect(run.plan.steps.map((s) => s.kind)).toEqual(['descend', 'touch', 'touch', 'rise'])
    expect(collisions(run.trace)).toEqual([])
    expect(probes(run.trace).map((p) => [p.axis, p.from.x, p.from.y, p.from.z, p.target, p.contact === null ? null : r4(p.contact)])).toEqual([
      ['Z', 622, 442, 40, 25, null], // from 40 (above safe height 35) the whole way down to top - 5, guarded
      ['X', 622, 442, 25, 572, { x: 619, y: 442, z: 25 }],
      ['X', 621, 442, 25, 617, { x: 619, y: 442, z: 25 }],
      ['Y', 621, 442, 25, 392, { x: 621, y: 439, z: 25 }], // Y from where X backed off, as before
      ['Y', 621, 441, 25, 437, { x: 621, y: 439, z: 25 }],
    ])
    expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 621, y: 441, z: 35 } })
  })

  // WO-2056 (design 4.2): Outside corner goes AROUND the corner. Until then both
  // touches ran from the same point: from diagonally outside the front-left
  // corner (190, 190) at probing depth the X touch ran along Y 190, in front of
  // the part (which starts at Y 200), and missed. Now it starts over the stock
  // near the corner, touches the top, and gives each face its own step-out.
  it('Outside corner (-> WO-2056, X+ then Y+) from over the part near the front-left corner, above its top: top, X face from 16.5 mm out, back over the start, Y face from 16.5 mm out', async () => {
    const run = await runRoutine(
      { x: 205, y: 207, z: 40 },
      { kind: 'outsideCorner', cornerXDirection: '+', cornerYDirection: '+' },
    )
    expect(run.plan.steps.map((s) => s.kind)).toEqual(['touch', 'position', 'touch'])
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { cornerX: 198.5, cornerY: 198.5 } })
    expect(collisions(run.trace)).toEqual([])
    expect(probes(run.trace).map((p) => [p.axis, p.from.x, p.from.y, p.from.z, p.target, p.contact === null ? null : r4(p.contact)])).toEqual([
      ['Z', 205, 207, 40, -10, { x: 205, y: 207, z: 30 }], // the top, fast
      ['Z', 205, 207, 32, 28, { x: 205, y: 207, z: 30 }], // the top, slow
      ['Z', 188.5, 207, 35, 25, null], // X step-out: 16.5 mm left of the start, top + 5 down to top - 5
      ['X', 188.5, 207, 25, 208.5, { x: 198.5, y: 207, z: 25 }], // the left face, fast
      ['X', 196.5, 207, 25, 200.5, { x: 198.5, y: 207, z: 25 }], // the left face, slow
      ['Z', 205, 190.5, 35, 25, null], // Y step-out: 16.5 mm in front of the start
      ['Y', 205, 190.5, 25, 210.5, { x: 205, y: 198.5, z: 25 }], // the front face, fast
      ['Y', 205, 196.5, 25, 200.5, { x: 205, y: 198.5, z: 25 }], // the front face, slow
    ])
    // Every XY move below the top is a probe back-off beside a face; the ways
    // round the corner (step-outs and the return over the start) run at safe height.
    const moves = run.trace.filter((e): e is Extract<TraceEntry, { verb: 'move' }> => e.verb === 'move')
    expect(moves.filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y).map((m) => [m.from.z, m.to.x, m.to.y])).toEqual([
      [35, 188.5, 207], // X step-out
      [25, 196.5, 207], // back off the left face
      [25, 196.5, 207],
      [35, 205, 207], // back over the stock to the start
      [35, 205, 190.5], // Y step-out
      [25, 205, 196.5], // back off the front face
      [25, 205, 196.5],
    ])
    expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 205, y: 196.5, z: 35 } })
    const corner = calculateCorner({
      x: { direction: '+', triggerPositionMm: 198.5, tipRadiusMm: TIP_R },
      y: { direction: '+', triggerPositionMm: 198.5, tipRadiusMm: TIP_R },
    })
    expect([corner.xMm, corner.yMm]).toEqual([200, 200])
  })

  it('Outside corner (-> WO-2056) started where the old screen said - diagonally outside the corner at probing depth: the top touch finds nothing on this table, nothing runs in front of the part', async () => {
    const run = await runRoutine(
      { x: 190, y: 190, z: 25 },
      { kind: 'outsideCorner', cornerXDirection: '+', cornerYDirection: '+' },
    )
    expect(run.result).toMatchObject({ ok: false, topMachineZ: null })
    // WO-2108: a top touch that finds nothing says so, not "check the probe wiring".
    expect(run.result?.message).toMatch(/^Touch the top stopped: no top found within 50\.00 mm below where the probe started/)
    expect(probes(run.trace)).toEqual([expect.objectContaining({ axis: 'Z', target: -25, contact: null })])
    expect(collisions(run.trace)).toEqual([])
  })

  // WO-2056 audit: a text controller with no G38.3 runs the plan's
  // besideTheFace fallback (runFeatureProbeCycle swaps it in). That plan must
  // go around the corner too. Here the very plan the swap selects runs on the
  // fake board from the old screen's diagonal start at probing depth.
  it('Outside corner fallback (-> WO-2056 audit, no G38.3) from diagonally outside the corner at probing depth: goes around the corner at that height and lands both faces', async () => {
    const start = { x: 190, y: 190, z: 25 }
    await connectBridge()
    standAt(start)
    await vi.advanceTimersByTimeAsync(50)
    const planned = planFeatureProbeCycle({
      ...SCREEN_DEFAULTS,
      kind: 'outsideCorner',
      cornerXDirection: '+',
      cornerYDirection: '+',
      start,
      envelope,
      config: CONFIG,
      tipRadiusMm: TIP_R,
    } as PlanInput)
    if (!planned.ok) throw new Error(planned.reason)
    const beside = planned.plan.fromTop!.besideTheFace
    if (!beside.ok) throw new Error(beside.reason)
    expect(beside.plan.fromTop).toBeNull()
    const result = await settle(runFeatureProbeCycle(beside.plan, CONFIG, true))
    expect(result).toMatchObject({ ok: true, topMachineZ: null, touches: { cornerX: 198.5, cornerY: 198.5 } })
    expect(collisions(trace)).toEqual([])
    expect(zOf(trace)).toEqual(new Set([25]))
    expect(probes(trace).map((p) => [p.axis, p.from.x, p.from.y, p.target, p.contact === null ? null : r4(p.contact)])).toEqual([
      ['X', 190, 206.5, 200, { x: 198.5, y: 206.5, z: 25 }], // the left face, beside it past the front face
      ['X', 196.5, 206.5, 200.5, { x: 198.5, y: 206.5, z: 25 }],
      ['Y', 206.5, 190, 200, { x: 206.5, y: 198.5, z: 25 }], // the front face, beside it past the left face
      ['Y', 206.5, 196.5, 200.5, { x: 206.5, y: 198.5, z: 25 }],
    ])
    const corner = calculateCorner({
      x: { direction: '+', triggerPositionMm: 198.5, tipRadiusMm: TIP_R },
      y: { direction: '+', triggerPositionMm: 198.5, tipRadiusMm: TIP_R },
    })
    expect([corner.xMm, corner.yMm]).toEqual([200, 200])
  })

  it('Angle (-> WO-2055, face along X, probe Y+) from over the part 5 mm behind the front face: top once, then each point from 16.5 mm out at top - 5', async () => {
    const run = await runRoutine(
      { x: 250, y: 205, z: 40 },
      { kind: 'angle', angleProbeDirection: '+' },
    )
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30 })
    expect(collisions(run.trace)).toEqual([])
    expect(probes(run.trace).map((p) => [p.axis, p.from.x, p.from.y, p.from.z, p.target, p.contact === null ? null : r4(p.contact)])).toEqual([
      ['Z', 250, 205, 40, -10, { x: 250, y: 205, z: 30 }],
      ['Z', 250, 205, 32, 28, { x: 250, y: 205, z: 30 }],
      ['Z', 250, 188.5, 35, 25, null],
      ['Y', 250, 188.5, 25, 208.5, { x: 250, y: 198.5, z: 25 }],
      ['Y', 250, 196.5, 25, 200.5, { x: 250, y: 198.5, z: 25 }],
      ['Z', 275, 188.5, 35, 25, null],
      ['Y', 275, 188.5, 25, 208.5, { x: 275, y: 198.5, z: 25 }],
      ['Y', 275, 196.5, 25, 200.5, { x: 275, y: 198.5, z: 25 }],
    ])
    // The 25 mm move along the face runs at safe height (top + 5).
    expect(run.trace).toContainEqual(expect.objectContaining({ verb: 'move', from: { x: 250, y: 196.5, z: 35 }, to: { x: 275, y: 196.5, z: 35 } }))
  })

  it('Bore (-> WO-2057) from its centre 10 mm below the top (the old screen start): rises to work Z0 + 5, guarded descent to Z0 - 5, four walls there, rise', async () => {
    const run = await runRoutine({ x: 500, y: 450, z: 20 }, { kind: 'bore' })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { xNegative: 489, xPositive: 511, yNegative: 439, yPositive: 461 } })
    expect(collisions(run.trace)).toEqual([])
    expect(run.trace[0]).toMatchObject({ verb: 'move', from: { x: 500, y: 450, z: 20 }, to: { x: 500, y: 450, z: 35 } })
    expect(probes(run.trace)[0]).toMatchObject({ axis: 'Z', from: { x: 500, y: 450, z: 35 }, target: 25, contact: null })
    const fine = probes(run.trace).slice(1).filter((_, i) => i % 2 === 1).map((p) => r4(p.contact!))
    expect(fine).toEqual([
      { x: 489, y: 450, z: 25 },
      { x: 511, y: 450, z: 25 },
      { x: 500, y: 439, z: 25 },
      { x: 500, y: 461, z: 25 },
    ])
    // The wall touches keep their shape: every XY move is at depth, back
    // through the centre between walls; only the way down and up moves Z.
    expect(zOf(run.trace)).toEqual(new Set([20, 35, 25]))
    expect(run.trace.at(-1)).toMatchObject({ verb: 'move', from: { x: 500, y: 450, z: 25 }, to: { x: 500, y: 450, z: 35 } })
  })

  it('Bore (-> WO-2057) started ABOVE the hole at a safe height: until WO-2057 it found no wall; now it lands all four at work Z0 - 5', async () => {
    const run = await runRoutine({ x: 500, y: 450, z: 60 }, { kind: 'bore' })
    expect(run.result).toMatchObject({ ok: true, touches: { xNegative: 489, xPositive: 511, yNegative: 439, yPositive: 461 } })
    expect(probes(run.trace)[0]).toMatchObject({ axis: 'Z', from: { z: 60 }, target: 25, contact: null })
    expect(probes(run.trace).slice(1).every((p) => p.from.z === 25)).toBe(true)
    expect(collisions(run.trace)).toEqual([])
    // Negative control: the older plan (no top, no descent) from the same
    // start is the old record - every touch at the height where the probe was
    // left, and from there it finds no wall.
    const beside = run.plan.fromTop!.besideTheFace
    if (!beside.ok) throw new Error(beside.reason)
    standAt({ x: 500, y: 450, z: 60 })
    await vi.advanceTimersByTimeAsync(50)
    trace = []
    const old = await settle(runFeatureProbeCycle(beside.plan, CONFIG, true))
    expect(old).toMatchObject({ ok: false, topMachineZ: null })
    expect(zOf(trace)).toEqual(new Set([60]))
  })

  it('Rect pocket (-> WO-2057) from its centre above the top: guarded descent to work Z0 - 5, four walls there', async () => {
    const run = await runRoutine({ x: 630, y: 450, z: 40 }, { kind: 'rectPocket' })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { xNegative: 619, xPositive: 641, yNegative: 439, yPositive: 461 } })
    expect(probes(run.trace)[0]).toMatchObject({ axis: 'Z', from: { x: 630, y: 450, z: 40 }, target: 25, contact: null })
    expect(probes(run.trace).slice(1).every((p) => p.from.z === 25)).toBe(true)
    expect(collisions(run.trace)).toEqual([])
    expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 630, y: 450, z: 35 } })
  })

  it('Bore (-> WO-2057) with work Z0 set on the table and the rim touched at machine Z 30: works from the rim, not Z0', async () => {
    g54 = { x: 200, y: 200, z: 0 }
    const run = await runRoutine({ x: 500, y: 450, z: 40 }, { kind: 'bore', rimTopMachineZMm: 30 })
    expect(run.plan.fromTop).toMatchObject({ topTouch: null, knownTop: { source: 'rim', machineZ: 30 } })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: 30, touches: { xNegative: 489, xPositive: 511, yNegative: 439, yPositive: 461 } })
    expect(probes(run.trace)[0]).toMatchObject({ axis: 'Z', from: { z: 40 }, target: 25, contact: null })
    expect(collisions(run.trace)).toEqual([])
  })

  it('Bore (-> WO-2057) with a wrong work Z0 (18 mm below the top): the guarded descent lands on the floor, stops there and says so', async () => {
    g54 = { x: 200, y: 200, z: 12 }
    const run = await runRoutine({ x: 500, y: 450, z: 40 }, { kind: 'bore' })
    const said = 'Descend to probing depth over the start: the descent touched at G54 Z -2.00 mm (machine Z 10.00 mm), above probing depth '
      + 'G54 Z -5.00 mm (machine Z 7.00 mm) - start over the open hole, or check the top (work Z0).'
    expect(run.result).toMatchObject({ ok: false, topMachineZ: 12, touches: {} })
    expect(run.result?.message).toBe(said)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text)).toContain(said)
    expect(probes(run.trace)).toEqual([expect.objectContaining({ axis: 'Z', target: 7, contact: { x: 500, y: 450, z: 10 } })])
    expect(run.trace.at(-1)?.verb).toBe('probe')
    expect(collisions(run.trace)).toEqual([])
  })
})

describe('WO-2034 run-through: Boss and Rect boss start over the middle and cross at the touched top + 5 (WO-2058)', () => {
  // WO-2058 (design 4.2): start over the middle, by eye, at any height above
  // the top. The cycle touches the top there, then for each face rises to top +
  // clearance, steps out nominal radius + tip + clearance (12.5 + 1.5 + 5 = 19),
  // descends to top - 5 as a probe move that stops on contact, touches, rises.
  // Every XY move runs at top + 5, whatever height the operator started at.
  const TOP = 20
  const SAFE = TOP + 5
  /** Every XY move longer than the touch's 2 mm back-off (which runs away
   *  from the wall at depth), as the Z it ran at. */
  const xyMoveZ = (entries: TraceEntry[]) => [...new Set(entries.flatMap((e) =>
    e.verb === 'move' && Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) > CONFIG.retract + 1e-6 ? [e.from.z, e.to.z] : []))]
  /** The closest the tip came to an axis while below the top (move and probe
   *  ends): never inside the boss, i.e. never nearer than the radius + tip. */
  const nearestBelowTop = (entries: TraceEntry[], at: (p: MachineVec3) => number) => Math.min(...entries.flatMap((e) =>
    e.verb === 'move' ? [e.from, e.to] : e.verb === 'probe' ? [e.from, ...(e.contact ? [e.contact] : [])] : [])
    .filter((p) => p.z < TOP - 1e-6)
    .map(at))
  const roundBossGap = (p: MachineVec3) => Math.hypot(p.x - 500, p.y - 150) - 12.5
  const rectBossGap = (p: MachineVec3) => rectDist(p.x, p.y, 600, 625, 100, 125)

  for (const aboveTop of [15, 2]) {
    it(`Boss started over the middle ${aboveTop} mm above its top: top first, every cross at top + 5, four touches land`, async () => {
      const run = await runRoutine({ x: 500, y: 150, z: TOP + aboveTop }, { kind: 'boss' })
      expect(run.result).toMatchObject({
        ok: true,
        topMachineZ: TOP,
        touches: { xNegative: 514, xPositive: 486, yNegative: 164, yPositive: 136 },
      })
      expect(probes(run.trace)[0]).toMatchObject({ axis: 'Z', from: { x: 500, y: 150, z: TOP + aboveTop }, contact: { z: TOP } })
      expect(collisions(run.trace)).toEqual([])
      expect(xyMoveZ(run.trace)).toEqual([SAFE])
      expect(nearestBelowTop(run.trace, roundBossGap)).toBeGreaterThanOrEqual(TIP_R - 1e-6)
      // Each face from 19 mm out, guarded descent top + 5 -> top - 5, nothing touched.
      expect(probes(run.trace).filter((p) => p.axis === 'Z' && p.from.z === SAFE).map((p) => [p.from.x, p.from.y, p.target, p.contact])).toEqual([
        [519, 150, TOP - 5, null],
        [481, 150, TOP - 5, null],
        [500, 169, TOP - 5, null],
        [500, 131, TOP - 5, null],
      ])
      expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 500, y: 150, z: SAFE } })
      expect(run.plan.review.clearMotion).toMatchObject({ kind: 'boss-from-top', clearanceMm: 5, depthMm: 5 })
    })

    it(`Rect boss started over the middle ${aboveTop} mm above its top: top first, every cross at top + 5, four faces land`, async () => {
      const run = await runRoutine({ x: 612.5, y: 112.5, z: TOP + aboveTop }, { kind: 'rectBoss' })
      expect(run.result).toMatchObject({
        ok: true,
        topMachineZ: TOP,
        touches: { xNegative: 626.5, xPositive: 598.5, yNegative: 126.5, yPositive: 98.5 },
      })
      expect(collisions(run.trace)).toEqual([])
      expect(xyMoveZ(run.trace)).toEqual([SAFE])
      expect(nearestBelowTop(run.trace, rectBossGap)).toBeGreaterThanOrEqual(TIP_R - 1e-6)
      expect(run.trace.at(-1)).toMatchObject({ verb: 'move', to: { x: 612.5, y: 112.5, z: SAFE } })
    })
  }

  it('Boss started 3 mm off the middle (by eye): the same four walls, still crossing at top + 5', async () => {
    const run = await runRoutine({ x: 503, y: 148, z: 30 }, { kind: 'boss' })
    expect(run.result).toMatchObject({ ok: true, topMachineZ: TOP })
    const t = (run.result as { touches: Record<string, number> }).touches
    // Contacts on the true boss (centre 500, 150), off the axis by the start's offset.
    expect((t.xNegative + t.xPositive) / 2).toBeCloseTo(500, 3)
    expect((t.yNegative + t.yPositive) / 2).toBeCloseTo(150, 3)
    expect(collisions(run.trace)).toEqual([])
    expect(xyMoveZ(run.trace)).toEqual([SAFE])
  })

  it('Boss started where the old screen said - outside the X max face at probing depth: the top touch finds nothing on this table, nothing crosses the boss', async () => {
    const run = await runRoutine({ x: 519, y: 150, z: 15 }, { kind: 'boss' })
    expect(run.result).toMatchObject({ ok: false, touches: {} })
    expect(probes(run.trace)).toEqual([expect.objectContaining({ axis: 'Z', from: { x: 519, y: 150, z: 15 }, contact: null })])
    // WO-2258: the only move after the miss is Z straight back up to where the search started.
    expect(run.trace.filter((e) => e.verb === 'move')).toEqual([
      expect.objectContaining({ to: { x: 519, y: 150, z: 15 }, collision: null }),
    ])
  })
})

describe('WO-2034 run-through: the beside-the-face boss plan (the pendant; WO-2035: with the top unknown it crosses at safe Z)', () => {
  // The pendant's screen still says start outside the X max face, centred on
  // Y, at probing depth, so it plans with approachFromTop: false (WO-2058
  // leaves it there). WO-2035 (landed): no boss top typed and no Safe Z
  // declared, so the cross-over runs 1 mm under the top of Z travel (128.9 -
  // 1). Repinned by WO-2061, whose grant carries this file; the record used to
  // be start + 10.
  const bossStart = (z: number) => ({ x: 500 + 12.5 + TIP_R + 5, y: 150, z })
  const CROSS_Z = 127.9

  it('Boss started 5 mm below its top: crosses at safe Z and all four touches land', async () => {
    const run = await runRoutine(bossStart(15), { kind: 'boss', approachFromTop: false })
    expect(run.result).toMatchObject({ ok: true })
    expect(zOf(run.trace)).toEqual(new Set([15, CROSS_Z]))
    expect(collisions(run.trace)).toEqual([])
    expect(run.plan.review.clearMotion).toMatchObject({ kind: 'boss-cross-over', liftMm: 112.9, crossOverZMm: CROSS_Z })
  })

  it('Boss started 12 mm below its top: the cross-over no longer drives through the boss (WO-2035)', async () => {
    const run = await runRoutine(bossStart(8), { kind: 'boss', approachFromTop: false })
    expect(collisions(run.trace)).toEqual([])
    expect(run.plan.review.clearMotion).toMatchObject({ kind: 'boss-cross-over', crossOverZMm: CROSS_Z })
  })

  it('Rect boss started 5 mm below its top: crosses at safe Z and lands four touches', async () => {
    const run = await runRoutine({ x: 625 + TIP_R + 5, y: 112.5, z: 15 }, { kind: 'rectBoss', approachFromTop: false })
    expect(run.result).toMatchObject({ ok: true })
    expect(zOf(run.trace)).toEqual(new Set([15, CROSS_Z]))
    expect(collisions(run.trace)).toEqual([])
  })
})

describe('WO-2034 run-through: the Z routines do move Z', () => {
  it('Probe work Z0 over the part: searches down from where the tool stands, sets Z0 AT THE CONTACT (WO-2059: no pad by default)', async () => {
    await connectBridge()
    standAt({ x: 300, y: 275, z: 45 })
    await vi.advanceTimersByTimeAsync(50)
    const result = await settle(runZProbeCycle('workZero', CONFIG))
    expect(result).toMatchObject({ ok: true })
    const touches = probes(trace)
    expect(touches.map((p) => [p.axis, p.from.z, p.contact?.z ?? null])).toEqual([
      ['Z', 45, 30],
      ['Z', 32, 30],
    ])
    // Contact at machine Z 30, the bare part top. Until WO-2059 the default
    // 10 mm pad was subtracted and Z0 landed 10 mm INSIDE the part; the
    // first-time sensing choice is now the probe touching the part.
    expect(trace.find((e) => e.verb === 'setWorkOffset')).toMatchObject({ wcs: 'G54', z: 30 })
    // WO-2061: back off 2 mm, then rise to the part top + 5 mm clearance: the
    // old end (32) sat 2 mm above the surface, short of the next routine's
    // safe height.
    const moves = trace.filter((e): e is Extract<TraceEntry, { verb: 'move' }> => e.verb === 'move')
    expect(moves.map((m) => m.to.z).slice(-2)).toEqual([32, 35])
    expect(collisions(trace)).toEqual([])
    expect(machinePos.z).toBe(35)
    expect(result?.message).toContain('Probe left 5.00 mm above that top')
  })

  it('WO-2061: Probe work Z0 through a 10 mm plate stays at the 2 mm back-off (top + clearance would be inside the plate)', async () => {
    const machineId = controlMachine(useCamStore.getState()).id
    setProbeSensing(machineId, 'workZero', 'plate')
    try {
      await connectBridge()
      standAt({ x: 300, y: 275, z: 45 })
      await vi.advanceTimersByTimeAsync(50)
      const result = await settle(runZProbeCycle('workZero', CONFIG))
      expect(result).toMatchObject({ ok: true })
      expect(probes(trace).map((p) => [p.axis, p.from.z, p.contact?.z ?? null])).toEqual([
        ['Z', 45, 30],
        ['Z', 32, 30],
      ])
      // Contact 30 through the 10 mm plate: Z0 20. Top + 5 = 25 is inside
      // the plate, so it ends at the back-off, 2 mm above the contact.
      expect(trace.find((e) => e.verb === 'setWorkOffset')).toMatchObject({ wcs: 'G54', z: 20 })
      expect(machinePos.z).toBe(32)
      expect(collisions(trace)).toEqual([])
    } finally {
      setProbeSensing(machineId, 'workZero', 'probe')
    }
  })

  it('Z surface mesh: goes to point 1 at the Z where Run was pressed, then every traverse is at the point-1 top + clearance and each later point searches clearance + 5 (WO-2064)', async () => {
    const program = [
      'G21 G90 G54', 'G0 X10 Y10 Z5', 'G1 Z-0.2 F100', 'G1 X90 Y10 F400',
      'G1 X90 Y90', 'G1 X10 Y90', 'G1 X10 Y10', 'G0 Z5', 'M30',
    ].join('\n')
    const plan = planSurfaceMesh(program, { pointsX: 3, pointsY: 3 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    await connectBridge()
    standAt({ x: 250, y: 250, z: 40 })
    await vi.advanceTimersByTimeAsync(50)
    useMachineControl.setState({ programText: program, activeWcs: 'G54' })
    const result = await settle(runSurfaceMeshProbeCycle(
      {
        points: plan.points,
        bounds: plan.setup.bounds,
        cutBounds: plan.setup.cutBounds,
        pointsX: 3,
        pointsY: 3,
        fadeMm: plan.setup.fadeMm,
        safeMachineZ: 40,
        sourceProgramText: program,
        sourceName: 'mesh.nc',
        workOffset: 'G54',
      },
      CONFIG,
      true,
    ))
    expect(result).toMatchObject({ ok: true })
    const moves = trace.filter((e): e is Extract<TraceEntry, { verb: 'move' }> => e.verb === 'move')
    // The move to point 1 is at machine Z 40 (where Run was pressed); every
    // later XY traverse is at the part top (30) + clearance (5) (WO-2064).
    const traverses = moves.filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y).map((m) => m.from.z)
    expect(traverses[0]).toBe(40)
    expect(new Set(traverses.slice(1))).toEqual(new Set([35]))
    expect(collisions(trace)).toEqual([])
    // 9 points x (fast + fine). Point 1's fast pass searches the full 50 mm
    // from Z 40; every later one searches clearance 5 + largest height change 5
    // from Z 35 (WO-2064).
    const touches = probes(trace)
    expect(touches).toHaveLength(18)
    const fast = touches.filter((_, i) => i % 2 === 0)
    expect([fast[0].from.z, fast[0].target]).toEqual([40, -10])
    expect(fast.slice(1).every((p) => p.from.z === 35 && p.target === 25)).toBe(true)
    // It ends at point 1's top + clearance, not back at the start height.
    expect(machinePos.z).toBe(35)
  })
})
