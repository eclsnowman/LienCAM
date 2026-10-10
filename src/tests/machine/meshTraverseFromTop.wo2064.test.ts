// @vitest-environment jsdom
//
// WO-2064 - A Z SURFACE MESH TRAVERSES FROM THE TOP.
//
// Design (docs/design/PROBING-PAINT-BY-NUMBERS.md 4.4 and section 5 item 10,
// approved on card Q-PROBING-SCREEN-ROUND-2): the operator jogs over point 1 at
// any height and presses Run. Point 1 is touched from there and becomes work
// Z0; every move between points, and the end of the cycle, is at point 1's top
// + clearance; each later point searches down clearance + the largest height
// change expected (5 mm unless the operator says otherwise) - never the full
// 50 mm maximum travel.
//
// The production runner (runSurfaceMeshProbeCycle) drives the REAL
// UccncController on the native probe route over a fake bridge socket that
// plays a board with a SLOPED stock top: machine Z 30 at the front-left corner,
// falling 0.04 mm per mm in X and 0.02 mm per mm in Y (4.8 mm lower at the far
// corner of the 80 x 80 grid). Every commanded Z is captured from the wire.
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

// ---- the table: one sloped stock top ---------------------------------------

/** Stock under X 200..400, Y 200..350; its top falls away from the front-left. */
function topAt(x: number, y: number): number | null {
  if (x < 200 || x > 400 || y < 200 || y > 350) return null
  return 30 - 0.04 * (x - 210) - 0.02 * (y - 210)
}

const round4 = (v: number) => Number(v.toFixed(4))
const r4 = (p: MachineVec3): MachineVec3 => ({ x: round4(p.x), y: round4(p.y), z: round4(p.z) })

/** True when a straight move from a to b passes below the stock top. */
function collides(a: MachineVec3, b: MachineVec3): boolean {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  const steps = Math.max(1, Math.ceil(length / 0.1))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const top = topAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    if (top !== null && a.z + (b.z - a.z) * t < top - 1e-6) return true
  }
  return false
}

// ---- the fake board --------------------------------------------------------

type TraceEntry =
  | { verb: 'move'; from: MachineVec3; to: MachineVec3; collision: boolean }
  | { verb: 'probe'; from: MachineVec3; target: number; contact: number | null }

let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 210, y: 210, z: 60 }
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
  trace.push({ verb: 'move', from: r4(from), to: r4(to), collision: collides(from, to) })
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 }
  motion = [
    { state: 'run', pos: mid },
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
            const from = { ...machinePos }
            const top = topAt(from.x, from.y)
            const hit = a.axis === 'Z' && top !== null && top <= from.z + 1e-9 && top >= a.targetMm - 1e-9
            const stop = hit ? { ...from, z: round4(top!) } : { ...from, z: a.targetMm }
            trace.push({ verb: 'probe', from: r4(from), target: a.targetMm, contact: hit ? stop.z : null })
            machinePos = { ...stop }
            motion = []
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
            reply(hit ? { ok: true, at: { ...stop } } : { ok: false, at: null })
            return
          }
          case 'setWorkOffset': {
            const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runSurfaceMeshProbeCycle,
} = await import('../../lib/machine/machineSession')
const { DEFAULT_MESH_HEIGHT_CHANGE_MM, meshPointSearchMm } = await import('../../lib/machine/probeFeatureCycle')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { planSurfaceMesh } = await import('../../lib/machine/zSurfaceMesh')

/** The machine's default probe settings, as a fresh machine has them (clearance 5, max travel 50). */
const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)

const PROGRAM = [
  'G21 G90 G54', 'G0 X10 Y10 Z5', 'G1 Z-0.2 F100', 'G1 X90 Y10 F400',
  'G1 X90 Y90', 'G1 X10 Y90', 'G1 X10 Y10', 'G0 Z5', 'M30',
].join('\n')

async function settle<T>(pending: Promise<T>): Promise<T | null> {
  let value: T | null = null
  let finished = false
  void pending.then((v) => { value = v; finished = true })
  for (let i = 0; i < 6000 && !finished; i++) await vi.advanceTimersByTimeAsync(50)
  return value
}

/** Connect, stand where the operator jogged (over point 1 at `standZ`) and run the mesh. */
async function runMesh(standZ: number, largestHeightChangeMm?: number) {
  const plan = planSurfaceMesh(PROGRAM, { pointsX: 3, pointsY: 3, bounds: { minX: 10, minY: 10, maxX: 90, maxY: 90 } })
  if (!plan.ok) throw new Error(plan.reason)
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  machinePos = { x: 210, y: 210, z: standZ }
  motion = []
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54', programText: PROGRAM })
  trace = []
  const result = await settle(runSurfaceMeshProbeCycle(
    {
      points: plan.points,
      bounds: plan.setup.bounds,
      cutBounds: plan.setup.cutBounds,
      pointsX: 3,
      pointsY: 3,
      fadeMm: plan.setup.fadeMm,
      safeMachineZ: standZ,
      ...(largestHeightChangeMm === undefined ? {} : { largestHeightChangeMm }),
      sourceProgramText: PROGRAM,
      sourceName: 'mesh.nc',
      workOffset: 'G54',
    },
    CONFIG,
    true,
  ))
  const moves = trace.filter((e): e is Extract<TraceEntry, { verb: 'move' }> => e.verb === 'move')
  const probes = trace.filter((e): e is Extract<TraceEntry, { verb: 'probe' }> => e.verb === 'probe')
  return {
    result,
    traverses: moves.filter((m) => m.from.x !== m.to.x || m.from.y !== m.to.y),
    collisions: moves.filter((m) => m.collision),
    /** Every fast pass (the first touch of each point's fast + fine pair). */
    fast: probes.filter((_, i) => i % 2 === 0),
    probes,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  trace = []
  motion = []
  g54 = { x: 200, y: 200, z: 30 }
  machinePos = { x: 210, y: 210, z: 60 }
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

describe('WO-2064: the per-point search rule', () => {
  it('is clearance + the largest height change (5 by default), capped at the maximum travel', () => {
    expect(DEFAULT_MESH_HEIGHT_CHANGE_MM).toBe(5)
    expect(meshPointSearchMm(CONFIG)).toBe(10)
    expect(meshPointSearchMm(CONFIG, 2)).toBe(7)
    expect(meshPointSearchMm(CONFIG, 0)).toBe(5)
    expect(meshPointSearchMm(CONFIG, 200)).toBe(CONFIG.maxTravel)
  })
})

describe('WO-2064: a Z surface mesh traverses from the top (native route, sloped stock)', () => {
  it('started 30 mm above point 1: point 1 is found from there, then every traverse is at point-1 top + 5 and every later search stops 10 mm down', async () => {
    const run = await runMesh(60)
    expect(run.result).toMatchObject({ ok: true })
    expect(run.collisions).toEqual([])
    // Point 1 (the front-left corner, top at machine Z 30): searched from where
    // the operator stood, the full 50 mm maximum travel.
    expect(run.fast[0]).toMatchObject({ from: { x: 210, y: 210, z: 60 }, target: 10, contact: 30 })
    // Every XY move after point 1 is at 30 + 5 = 35, not at 60.
    expect(run.traverses.length).toBe(8)
    expect(new Set(run.traverses.map((m) => m.from.z))).toEqual(new Set([35]))
    // Every later fast pass starts at 35 and stops at most clearance 5 +
    // height change 5 = 10 mm down (machine Z 25) - never the 50 mm search.
    expect(run.fast).toHaveLength(9)
    for (const pass of run.fast.slice(1)) {
      expect(pass.from.z).toBe(35)
      expect(pass.target).toBe(25)
      expect(pass.contact).not.toBeNull()
    }
    // The lowest point (far corner, 4.8 mm below point 1) was still reached.
    expect(Math.min(...run.fast.map((p) => p.contact!))).toBeCloseTo(25.2, 4)
    // The cycle ends at point-1 top + clearance.
    expect(machinePos.z).toBe(35)
  })

  it('started 2 mm above point 1: the traverse still rises to point-1 top + 5, above where the operator stood', async () => {
    const run = await runMesh(32)
    expect(run.result).toMatchObject({ ok: true })
    expect(run.collisions).toEqual([])
    expect(run.fast[0]).toMatchObject({ from: { z: 32 }, contact: 30 })
    expect(new Set(run.traverses.map((m) => m.from.z))).toEqual(new Set([35]))
    expect(machinePos.z).toBe(35)
  })

  it('the largest height change is the operator\'s: 2 mm stops the search 7 mm down, and a point lower than that stops the cycle without arming', async () => {
    const run = await runMesh(60, 2)
    expect(run.result).toMatchObject({ ok: false })
    expect(run.result?.message).toMatch(/^Mesh point \d+ stopped: .*never made contact within 7\.00 mm/)
    expect(run.result?.mesh).toBeNull()
    for (const pass of run.fast.slice(1)) {
      expect(pass.from.z).toBe(35)
      expect(pass.target).toBe(28)
    }
    // The miss is the first point more than 2 mm below point 1, and the search
    // stopped 7 mm down - not 50.
    const missed = run.fast.find((p) => p.contact === null)!
    expect(missed.target).toBe(28)
    expect(topAt(missed.from.x, missed.from.y)!).toBeLessThan(28)
    expect(useMachineControl.getState().surfaceMesh).toBeNull()
  })

  it('a larger height change widens the search: 8 mm searches 13 mm down', async () => {
    const run = await runMesh(60, 8)
    expect(run.result).toMatchObject({ ok: true })
    expect(run.fast.slice(1).every((p) => p.from.z === 35 && p.target === 22)).toBe(true)
  })

  it('a height change that is not a number is refused before anything moves', async () => {
    const run = await runMesh(60, Number.NaN)
    expect(run.result).toMatchObject({ ok: false })
    expect(run.result?.message).toContain('largest height change')
    expect(trace).toEqual([])
  })
})
