// @vitest-environment jsdom
//
// WO-2138 - Feed Hold works between the moves of a probe routine.
//
// Rehearsal 2026-09-28 step 4c (.planning/rehearsal-2026-09-28/REPORT.md, bite
// 5): Edge > Feed Hold between two probe moves - the button was disabled in the
// ~0.3-1 s gaps between a routine's moves, the press did nothing (4 of 6) and
// the routine carried on.
//
// Each case runs a real routine through the production runner on the native
// route (UccncController over a fake bridge board that models a feed hold:
// nothing moves and no probe answers while it is held). Pinned:
//  - Main's Feed Hold button (the mounted ControlTransportBar) is live in the
//    gap after a move has come to rest, and a click there pauses the routine:
//    no further move goes to the board until CYCLE START, which resumes it to
//    its result; the button is dark again once the routine ends.
//  - A hold that lands after one move's answer and before the next move is
//    sent keeps that next move from starting (Edge and Probe work Z0).
//  - The table: a running routine is what makes the button live; nothing else
//    about Feed Hold changes.
// No red console line along the way.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

/** Verbs that start motion on the board. */
const MOTION_VERBS = new Set(['jog', 'jogToMachineZ', 'jogToWorkXY', 'probe'])

let bridgeEvents: BridgeTransportEvents | null = null
let g54: MachineVec3 = { x: 200, y: 200, z: 30 }
let machinePos: MachineVec3 = { x: 300, y: 275, z: 100 }
let motion: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
let verbs: string[] = []
/** The board's feed hold: nothing moves and no probe answers while it is set. */
let held = false
/** Motion verbs the board received while it was held. */
let motionWhileHeld: string[] = []
/** Opens once the step-out's last frame reports the machine at rest. */
let watchStepOutRest = false
let gapOpen = false
/** Press Feed Hold right after the board answers the next probe on this axis,
 *  before the routine sends its next move. */
let pressAfterProbeOnAxis: 'X' | 'Y' | 'Z' | null = null
let pressedAfterProbe = false

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
        if (held && MOTION_VERBS.has(message.m)) motionWhileHeld.push(message.m)
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            if (held) {
              pushStatus('hold')
            } else {
              const frame = motion.shift()
              if (frame) machinePos = { ...frame.pos }
              pushStatus(frame?.state ?? 'idle')
              if (watchStepOutRest && frame?.state === 'idle') {
                watchStepOutRest = false
                gapOpen = true
              }
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
            held = false
            motion = []
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
            return
          }
          case 'jog': {
            const a = message.a as { axis: 'X' | 'Y' | 'Z'; deltaMm: number }
            const key = a.axis.toLowerCase() as keyof MachineVec3
            reply(true)
            runTo({ ...machinePos, [key]: machinePos[key] + a.deltaMm })
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
            machinePos = { ...stop }
            motion = []
            pushStatus('idle')
            bridgeEvents?.onMessage({
              t: 'reply', seq: message.seq, ok: true, v: t !== null ? { ok: true, at: { ...stop } } : { ok: false, at: null },
            })
            if (pressAfterProbeOnAxis === a.axis) {
              // The operator's press lands after this probe answered and before
              // the routine sends its next move - the production send path
              // (keyboard, pendant and the button all end here).
              pressAfterProbeOnAxis = null
              pressedAfterProbe = operatorTransport.executeOperatorFeedHold()
            }
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
const operatorTransport = await import('../../lib/machine/operatorTransport')
const { currentOperatorTransport, executeOperatorCycleStart } = operatorTransport
const { authorize } = await import('../../lib/machine/operatorAuthority')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
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

async function tick(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function bridgeAt(p: MachineVec3): Promise<void> {
  const pending = session.connectMachine('bridge')
  await tick(300)
  await pending
  session.__resetEstopInterlockForTest()
  machinePos = { ...p }
  motion = []
  pushStatus('idle')
  await tick(50)
  useMachineControl.setState({ activeWcs: 'G54', consoleLines: [] })
  verbs = []
}

function redConsoleLines(): string[] {
  return useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error').map((l) => l.text)
}

function motionVerbs(): string[] {
  return verbs.filter((verb) => MOTION_VERBS.has(verb))
}

async function settle(result: () => CycleResult | null, ms = 20_000): Promise<CycleResult | null> {
  for (let t = 0; t < ms && result() === null; t += 50) await tick(50)
  return result()
}

beforeEach(() => {
  vi.useFakeTimers()
  verbs = []
  motion = []
  held = false
  motionWhileHeld = []
  watchStepOutRest = false
  gapOpen = false
  pressAfterProbeOnAxis = null
  pressedAfterProbe = false
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

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WO-2138 Feed Hold between the moves of a probe routine - native route', () => {
  it("Main's Feed Hold is live in the gap after a move; a click there pauses the routine until CYCLE START", async () => {
    render(createElement(ControlTransportBar))
    await bridgeAt(EDGE_START)
    const feedHold = () => screen.getByTestId('control-feedhold') as HTMLButtonElement
    expect(feedHold().disabled, 'Feed Hold with nothing running').toBe(true)

    // The gap: the step-out (a typed XY move) has come to rest and the routine
    // has not yet sent its descent.
    let result: CycleResult | null = null
    void session.runFeatureProbeCycle(edgePlan(), CONFIG, true).then((r) => { result = r })
    let sawStepOut = false
    for (let t = 0; t <= 30_000 && !gapOpen; t += 50) {
      if (!sawStepOut && verbs.includes('jogToWorkXY')) {
        sawStepOut = true
        watchStepOutRest = true
      }
      await tick(50)
    }
    expect(gapOpen, 'the routine never reached the gap after its step-out').toBe(true)
    expect(result, 'the routine ended before the gap').toBeNull()
    expect(useMachineControl.getState().machineState).toBe('idle')

    expect(feedHold().disabled, 'Feed Hold is dark in the gap between two probe moves').toBe(false)
    const movesBeforePress = motionVerbs().length
    act(() => { fireEvent.click(feedHold()) })
    expect(held, 'the click did not hold the board').toBe(true)

    // Held far longer than every settle and probe wait: nothing more moves.
    await tick(60_000)
    expect(result, 'the routine ended while the machine was held').toBeNull()
    expect(motionVerbs().slice(movesBeforePress), 'a move was sent while held').toEqual([])
    expect(motionWhileHeld).toEqual([])
    expect(useMachineControl.getState().machineState).toBe('hold')
    const whileHeld = currentOperatorTransport()
    expect(whileHeld.cycleStartEnabled).toBe(true)
    expect(whileHeld.nextAction).toBe('Edge probe is held - CYCLE START resumes it; Stop/Reset ends it.')

    const cycleStart = screen.getByTestId('control-cyclestart') as HTMLButtonElement
    expect(cycleStart.disabled).toBe(false)
    act(() => { fireEvent.click(cycleStart) })
    expect(verbs).toContain('cycleResume')
    const finished = await settle(() => result)
    expect(finished, 'the routine never finished after CYCLE START').not.toBeNull()
    expect(finished!.ok).toBe(true)
    expect(motionVerbs().length).toBeGreaterThan(movesBeforePress)
    expect(motionWhileHeld).toEqual([])
    expect(redConsoleLines()).toEqual([])

    // The routine is over: the button is dark again.
    await tick(200)
    expect(session.isProbeCycleActive()).toBe(false)
    expect(feedHold().disabled).toBe(true)
  })

  it('Edge: a hold that lands after a probe answers keeps the next move from starting until CYCLE START', async () => {
    await bridgeAt(EDGE_START)
    pressAfterProbeOnAxis = 'X'
    let result: CycleResult | null = null
    void session.runFeatureProbeCycle(edgePlan(), CONFIG, true).then((r) => { result = r })
    for (let t = 0; t <= 30_000 && !pressedAfterProbe; t += 50) await tick(50)
    expect(pressedAfterProbe, 'the routine never reached its X touch').toBe(true)
    expect(held).toBe(true)

    await tick(60_000)
    expect(result, 'the routine ended while the machine was held').toBeNull()
    expect(motionWhileHeld, 'the retract after the touch was sent into the hold').toEqual([])
    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)

    expect(await executeOperatorCycleStart()).toBe(true)
    const finished = await settle(() => result)
    expect(finished, 'the routine never finished after CYCLE START').not.toBeNull()
    expect(finished!.ok).toBe(true)
    expect(motionWhileHeld).toEqual([])
    expect(redConsoleLines()).toEqual([])
  })

  it('Probe work Z0: a hold after the search pass keeps the retract from starting until CYCLE START', async () => {
    await bridgeAt({ x: 300, y: 275, z: 40 })
    pressAfterProbeOnAxis = 'Z'
    let result: { ok: boolean; message: string } | null = null
    void session.runZProbeCycle('workZero', DEFAULT_ZPROBE_CONFIG).then((r) => { result = r })
    for (let t = 0; t <= 30_000 && !pressedAfterProbe && result === null; t += 50) await tick(50)
    expect(result, 'Probe work Z0 ended before its search answered').toBeNull()
    expect(pressedAfterProbe).toBe(true)
    expect(held).toBe(true)

    await tick(60_000)
    expect(result, 'the routine ended while the machine was held').toBeNull()
    expect(motionWhileHeld, 'the retract between passes was sent into the hold').toEqual([])
    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)

    expect(await executeOperatorCycleStart()).toBe(true)
    const finished = await settle(() => result)
    expect(finished, 'Probe work Z0 never finished after CYCLE START').not.toBeNull()
    expect(finished!.ok).toBe(true)
    expect(motionWhileHeld).toEqual([])
    expect(redConsoleLines()).toEqual([])
  })
})

describe('WO-2138 the Feed Hold row of the authority table', () => {
  const idle = { connected: true, machineState: 'idle' as const, jobPhase: 'empty' as const }

  it('a running probe routine makes the button live while the machine rests between moves', () => {
    expect(authorize('feedHold', { ...idle, probeRoutineRunning: true })).toEqual({
      allowed: true, disabled: false, refusal: null, refusedBy: null,
    })
  })

  it('nothing else changes: idle with no routine, held, alarmed or disconnected still refuse as before', () => {
    const unavailable = 'Feed Hold is available while the machine is moving or running a program'
    expect(authorize('feedHold', idle).refusal).toBe(unavailable)
    expect(authorize('feedHold', { ...idle, probeRoutineRunning: false }).disabled).toBe(true)
    expect(authorize('feedHold', { ...idle, machineState: 'hold', probeRoutineRunning: true }).refusal).toBe(unavailable)
    expect(authorize('feedHold', { ...idle, machineState: 'alarm', probeRoutineRunning: true }).refusal).toBe(unavailable)
    expect(authorize('feedHold', { ...idle, connected: false, probeRoutineRunning: true }).refusal)
      .toBe('Connect to the machine to use Feed Hold')
    expect(authorize('feedHold', { ...idle, machineState: 'run' }).allowed).toBe(true)
  })
})
