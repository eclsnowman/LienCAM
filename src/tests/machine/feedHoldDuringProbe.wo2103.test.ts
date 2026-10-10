// @vitest-environment jsdom
//
// WO-2103 - Feed Hold during a probe never traps the machine.
//
// Rehearsal 2026-09-27 (native kit, .planning/rehearsal-2026-09-27/logs/
// stops2.json and lag-hold.json): Feed Hold mid-probe left the routine
// "running" forever, CYCLE START was dark ("Machine must be idle") or pointed at
// a program that was not there, and Stop/Reset left the board held.
//
// Each case starts a real probe routine through the production runner on the
// native route (UccncController over a fake bridge board that models a feed
// hold: nothing moves and no probe answers while it is held), presses the
// production Feed Hold (executeOperatorFeedHold), waits well past every probe
// timeout, and then presses the production CYCLE START or Stop/Reset. Pinned:
// CYCLE START is lit with a plain sentence while the routine is held, it
// resumes the routine to its result, and Stop/Reset ends it as stopped with the
// board released so a typed move and a new routine both run. No red console
// line along the way.
//
// The bridge half (Machine.cs Reset() releasing the hold, WaitProbeCycleOver
// pausing while held) is proven on the native kit: src/tests/evidence/WO-2103/.
// This fake models the fixed bridge's answer to 'reset' (hold released).

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
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  } satisfies Storage,
})

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
const EPS = 1e-7
/** The WO-2071 board's part: 200 x 150, top at machine Z 30. */
function partHit(p: MachineVec3): boolean {
  const dx = Math.max(200 - p.x, 0, p.x - 400)
  const dy = Math.max(200 - p.y, 0, p.y - 350)
  return p.z > EPS && p.z < 30 + EPS && Math.hypot(dx, dy) < TIP_R - EPS
}

function lerp(a: MachineVec3, b: MachineVec3, t: number): MachineVec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

function firstHit(a: MachineVec3, b: MachineVec3): number | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  const steps = Math.max(1, Math.ceil(length / 0.05))
  for (let i = 1; i <= steps; i++) {
    if (!partHit(lerp(a, b, i / steps))) continue
    let lo = (i - 1) / steps
    let hi = i / steps
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (partHit(lerp(a, b, mid))) hi = mid
      else lo = mid
    }
    return lo
  }
  return null
}

const round4 = (v: number) => Number(v.toFixed(4))
const r4 = (p: MachineVec3): MachineVec3 => ({ x: round4(p.x), y: round4(p.y), z: round4(p.z) })

let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 300, y: 275, z: 100 }
let motion: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
let verbs: string[] = []
/** The board's feed hold: nothing moves and no probe answers while it is set. */
let held = false
/** Ask the test to press Feed Hold: during the next probe on this axis ... */
let holdOnProbeAxis: 'X' | 'Y' | 'Z' | null = null
/** ... or halfway along the next typed XY move. */
let holdOnStepOut = false
let wantHold = false
/** A probe the board is running; it answers once it is no longer held. */
let runningProbe: { seq: number; stop: MachineVec3; touched: boolean } | null = null

function offsets(): Record<string, MachineVec3> {
  const zero = { x: 0, y: 0, z: 0 }
  return { G54: { ...g54 }, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
}

function boardStatus(state: 'run' | 'idle' | 'hold', pos: MachineVec3): MachineStatus {
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

function pushStatus(state: 'run' | 'idle' | 'hold'): void {
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus(state, machinePos) } as BridgeMessage)
}

function runTo(to: MachineVec3): void {
  const from = { ...machinePos }
  motion = [
    { state: 'run', pos: lerp(from, to, 0.5) },
    { state: 'idle', pos: { ...to } },
    { state: 'idle', pos: { ...to } },
  ]
}

function answerRunningProbe(): void {
  const probe = runningProbe
  if (!probe) return
  runningProbe = null
  machinePos = { ...probe.stop }
  motion = []
  pushStatus('idle')
  bridgeEvents?.onMessage({
    t: 'reply', seq: probe.seq, ok: true, v: probe.touched ? { ok: true, at: { ...probe.stop } } : { ok: false, at: null },
  })
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
        verbs.push(message.m)
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            if (held) {
              pushStatus('hold')
            } else if (runningProbe) {
              answerRunningProbe()
            } else {
              const frame = motion.shift()
              if (frame) machinePos = { ...frame.pos }
              pushStatus(frame?.state ?? 'idle')
            }
            reply(true)
            return
          }
          case 'feedHold': {
            held = true
            pushStatus('hold')
            reply(null)
            return
          }
          case 'cycleResume': {
            held = false
            reply(true)
            return
          }
          case 'reset': {
            // The fixed bridge (WO-2103 Machine.cs Reset): motion stops where it
            // is, the queue empties and the feed hold is released.
            held = false
            motion = []
            if (runningProbe) {
              const seq = runningProbe.seq
              runningProbe = null
              bridgeEvents?.onMessage({ t: 'reply', seq, ok: true, v: { ok: false, at: null } })
            }
            pushStatus('idle')
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
            if (holdOnStepOut) {
              holdOnStepOut = false
              machinePos = { ...motion[0].pos }
              motion = [{ state: 'run', pos: { ...machinePos } }, ...motion.slice(1)]
              wantHold = true
            }
            return
          }
          case 'selectWcs':
            reply(true)
            return
          // Background verbs the session sends; answered as Bridge.cs does.
          case 'refreshState':
          case 'querySettings':
            reply(true)
            return
          case 'setSingleBlockMode':
            reply(null)
            return
          case 'probe': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
            const key = a.axis.toLowerCase() as keyof MachineVec3
            const from = { ...machinePos }
            const end = { ...machinePos, [key]: a.targetMm }
            const t = firstHit(from, end)
            const stop = t !== null ? r4(lerp(from, end, t)) : end
            runningProbe = { seq: message.seq, stop, touched: t !== null }
            if (holdOnProbeAxis === a.axis) {
              // A third of the way along the search when Feed Hold is pressed.
              holdOnProbeAxis = null
              machinePos = r4(lerp(from, stop, 1 / 3))
              pushStatus('run')
              wantHold = true
              return
            }
            answerRunningProbe()
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
const session = await import('../../lib/machine/machineSession')
const {
  currentOperatorTransport,
  deriveOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { deriveMachineEnvelopeFromConvention } = await import('../../lib/machine/machineEnvelope')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]
type CycleResult = { ok: boolean; message: string; stopped?: true }

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
const ENVELOPE = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)
const EDGE_START: MachineVec3 = { x: 205, y: 275, z: 40 }

function edgePlan() {
  const planned = planFeatureProbeCycle({
    ...SCREEN_DEFAULTS, kind: 'edge', edgeAxis: 'X', edgeDirection: '+',
    start: { ...EDGE_START }, envelope: ENVELOPE, config: CONFIG, tipRadiusMm: TIP_R,
  } as PlanInput)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

async function bridgeAt(p: MachineVec3): Promise<void> {
  const pending = session.connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  session.__resetEstopInterlockForTest()
  machinePos = { ...p }
  motion = []
  pushStatus('idle')
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54', consoleLines: [] })
  verbs = []
}

function redConsoleLines(): string[] {
  return useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error').map((l) => l.text)
}

interface HeldRun {
  result: () => CycleResult | null
  /** What the transport showed after the long hold, before anything was pressed. */
  whileHeld: ReturnType<typeof currentOperatorTransport>
  stateWhileHeld: string
}

/** Start the cycle, press Feed Hold when the board asks, then sit held for 60 s. */
async function holdMidCycle(cycle: () => Promise<CycleResult>): Promise<HeldRun> {
  let result: CycleResult | null = null
  void cycle().then((r) => { result = r })
  let pressed = false
  for (let t = 0; t <= 30_000 && !pressed; t += 50) {
    await vi.advanceTimersByTimeAsync(50)
    if (wantHold) {
      wantHold = false
      expect(executeOperatorFeedHold()).toBe(true)
      pressed = true
    }
  }
  expect(pressed, 'the routine never reached the move to hold').toBe(true)
  // Longer than every settle wait (30 s) and the bridge's 5 s probe-cycle wait.
  await vi.advanceTimersByTimeAsync(60_000)
  return {
    result: () => result,
    whileHeld: currentOperatorTransport(),
    stateWhileHeld: useMachineControl.getState().machineState,
  }
}

async function settle(run: HeldRun, ms = 10_000): Promise<CycleResult | null> {
  for (let t = 0; t < ms && run.result() === null; t += 50) await vi.advanceTimersByTimeAsync(50)
  return run.result()
}

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WO-2103 Feed Hold during a probe routine - native route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    verbs = []
    motion = []
    held = false
    holdOnProbeAxis = null
    holdOnStepOut = false
    wantHold = false
    runningProbe = null
    g54 = { x: 200, y: 200, z: 30 }
    machinePos = { x: 300, y: 275, z: 100 }
    mem.clear()
    useCamStore.getState().newProject()
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
    }))
    useCamStore.setState({ machineWorkOffsets: {} })
    useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
  })

  it('held during the top-touch search: the routine waits, CYCLE START is lit and resumes it to its result', async () => {
    await bridgeAt(EDGE_START)
    holdOnProbeAxis = 'Z'
    const run = await holdMidCycle(() => session.runFeatureProbeCycle(edgePlan(), CONFIG, true))
    expect(run.stateWhileHeld).toBe('hold')
    expect(run.result(), 'the routine ended while the machine was held').toBeNull()
    expect(run.whileHeld.cycleStartEnabled).toBe(true)
    expect(run.whileHeld.action).toBe('resume')
    expect(run.whileHeld.nextAction).toBe('Edge probe is held - CYCLE START resumes it; Stop/Reset ends it.')

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(verbs).toContain('cycleResume')
    const result = await settle(run)
    expect(result, 'the routine never finished after CYCLE START').not.toBeNull()
    expect(result!.message).not.toMatch(/stopped by Stop\/Reset/)
    expect(result!.ok).toBe(true)
    expect(redConsoleLines()).toEqual([])
  })

  it('held halfway along the step-out: the 30 s settle wait does not fail it; CYCLE START resumes it to its result', async () => {
    await bridgeAt(EDGE_START)
    holdOnStepOut = true
    const run = await holdMidCycle(() => session.runFeatureProbeCycle(edgePlan(), CONFIG, true))
    expect(run.stateWhileHeld).toBe('hold')
    expect(run.result(), 'the routine ended while the machine was held').toBeNull()
    expect(run.whileHeld.cycleStartEnabled).toBe(true)
    expect(run.whileHeld.action).toBe('resume')

    expect(await executeOperatorCycleStart()).toBe(true)
    const result = await settle(run)
    expect(result, 'the routine never finished after CYCLE START').not.toBeNull()
    expect(result!.ok).toBe(true)
    expect(redConsoleLines()).toEqual([])
  })

  it('held, then Stop/Reset: the routine ends as stopped, the board is released, a typed move and a new routine run', async () => {
    await bridgeAt(EDGE_START)
    holdOnStepOut = true
    const run = await holdMidCycle(() => session.runFeatureProbeCycle(edgePlan(), CONFIG, true))
    expect(run.result()).toBeNull()

    expect(executeOperatorStopReset()).toBe(true)
    const stopped = await settle(run, 1000)
    expect(stopped, 'the routine did not end at once on Stop/Reset').not.toBeNull()
    expect(stopped!.ok).toBe(false)
    expect(stopped!.stopped).toBe(true)
    expect(stopped!.message).toMatch(/^Edge probe: stopped by Stop\/Reset during /)
    expect(held).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(useMachineControl.getState().machineState).toBe('idle')
    expect(session.estopNeedsReset()).toBe(false)

    // A typed move runs.
    const ctrl = session.getMachineController()
    expect(ctrl.jogToMachineZ(40, 1000)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(useMachineControl.getState().mpos?.z).toBe(40)

    // Back to the start; a new routine runs to its result.
    ctrl.jogToWorkXY(EDGE_START.x - g54.x, EDGE_START.y - g54.y, 1000)
    for (let t = 0; t < 5000; t += 50) {
      ctrl.queryStatus()
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(useMachineControl.getState().machineState).toBe('idle')
    expect(useMachineControl.getState().mpos).toEqual(EDGE_START)
    let again: CycleResult | null = null
    void session.runFeatureProbeCycle(edgePlan(), CONFIG, true).then((r) => { again = r })
    for (let t = 0; t < 20_000 && again === null; t += 50) await vi.advanceTimersByTimeAsync(50)
    expect(again, 'the new routine never finished').not.toBeNull()
    expect(again!.ok).toBe(true)
  })
})

describe('WO-2103 the transport verdict for a held probe routine', () => {
  const base = {
    connectionPhase: 'connected' as const,
    homed: true,
    activeWcs: 'G54' as const,
    programReadiness: { ready: true, reason: '' },
    programFit: null,
    singleBlock: false,
    fitTrace: null,
    toolChange: null,
  }
  const job = (phase: 'empty' | 'ready') => ({
    ...useMachineControl.getState().job,
    phase,
    name: phase === 'ready' ? 'part.nc' : null,
    totalLines: phase === 'ready' ? 10 : 0,
    sentLines: 0,
    ackedLines: 0,
  })

  it('lights CYCLE START to resume it, even with a program armed behind it (the rehearsal\'s "Machine must be idle")', () => {
    for (const phase of ['empty', 'ready'] as const) {
      const state = deriveOperatorTransport({
        ...base,
        machineState: 'hold',
        job: job(phase),
        programText: phase === 'ready' ? 'G0 X0\n' : null,
        programHold: { owner: 'probe-cycle', routine: 'Edge probe' },
      } as Parameters<typeof deriveOperatorTransport>[0])
      expect(state.cycleStartEnabled).toBe(true)
      expect(state.action).toBe('resume')
      expect(state.nextAction).toBe('Edge probe is held - CYCLE START resumes it; Stop/Reset ends it.')
    }
  })
})
