// @vitest-environment jsdom
//
// WO-2065 - THE ROUTINES TAB'S FACTORY ROUTINES WORK FROM THE TOP.
//
// The Probing panel's cycles (WO-2055..2058) find their depth from the top of
// the feature: touch the top where the operator started (or, for a hole, take
// work Z0 / the rim), rise to top + clearance for every XY move, and descend
// to top - depth as a probe move that stops on contact before every side
// touch. Until this order the Routines tab's factory Edge, corner, Bore and
// Boss routines touched at whatever height the operator left the probe.
//
// Driven through the real Routines tab (ProbeRoutinesTab: pick the routine,
// Check, tick, Run - ProbeRoutineRunPanel calls runProbeRoutine) on the real
// SimulatedController (GRBL text route; the simulator answers G38.3 through the
// WO-2055/WO-2073 shim below) with a WO-416 virtual block, bore and boss. Every
// probe call, XY move and G38.3 line is recorded with the machine Z the probe
// stood at, and the heights are compared with the Probing panel's own plan
// (planFeatureProbeCycle, from the top) for the same start and profile.
//
// NOT CLAIMED: hardware. No board readback exists for this change.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineVec3 } from '../../lib/machine/controller'

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

const { DEFAULT_MACHINE_PROBE_DEFAULTS, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { planFeatureProbeCycle } = await import('../../lib/machine/probeFeatureCycle')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useCamStore } = await import('../../store')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  currentResolvedMachineMotion,
  disconnectMachine,
  getMachineController,
  setSimulatedPart,
} = await import('../../lib/machine/machineSession')

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]

const TIP = 1.5 // the Routines tab's tip radius field default
const BLOCK_TOP = -80
const BORE = { cx: -340, cy: -340, diameter: 30, depth: 15 }
const BOSS = { cx: -400, cy: -400, diameter: 40, height: 25 }
const BOSS_TOP = BLOCK_TOP + BOSS.height // machine Z -55
const PART = {
  origin: { x: -500, y: -500 },
  sizeX: 200,
  sizeY: 200,
  topZ: BLOCK_TOP,
  height: 30,
  bowMm: 0,
  noiseMm: 0,
  bore: BORE,
  boss: BOSS,
}
// Quick positioning so a simulated run takes seconds, not a minute. The search
// feed stays at this machine's Z ceiling (1000 mm/min): the runner sends only
// the profile's search feed, so a Z touch previewed slower than it is refused.
const PROBING = { ...DEFAULT_MACHINE_PROBE_DEFAULTS, positioningFeed: 6000, fastFeed: 1000, slowFeed: 300 }

/** Fake timers never advance on their own - drive a promise to completion. */
async function settle<T>(promise: Promise<T>, ms = 60_000): Promise<T> {
  let done = false
  let value: T | undefined
  void promise.then((v) => { value = v; done = true })
  for (let waited = 0; !done && waited < ms; waited += 250) await vi.advanceTimersByTimeAsync(250)
  expect(done).toBe(true)
  return value as T
}

/** What a downward probe meets at (x, y): the simulator's own geometry. */
function surfaceAt(x: number, y: number): number | null {
  if (Math.hypot(x - BORE.cx, y - BORE.cy) <= BORE.diameter / 2) return null
  if (Math.hypot(x - BOSS.cx, y - BOSS.cy) <= BOSS.diameter / 2) return BOSS_TOP
  const inside = x >= PART.origin.x && x <= PART.origin.x + PART.sizeX && y >= PART.origin.y && y <= PART.origin.y + PART.sizeY
  return inside ? BLOCK_TOP : null
}

async function connectSimAt(start: MachineVec3): Promise<void> {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo2065-sim-machine',
    name: 'WO-2065 simulator fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 738, y: 724.5, z: 128.9 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    probing: PROBING,
  })
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  __resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(50)
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(3000)
  expect(setSimulatedPart(PART)).toBe(true)
  const ctrl = getMachineController()
  await settle((async () => {
    const ack = await ctrl.sendCommandAwait(`G53 G90 G0 X${start.x} Y${start.y} Z${start.z}`)
    if (!ack?.ok) throw new Error(`jog refused: ${ack?.message}`)
    for (let i = 0; i < 400; i++) {
      ctrl.queryStatus()
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (ctrl.verifiedIdle()) return
    }
    throw new Error('jog did not settle to Idle')
  })())
}

interface Recorded {
  /** Every typed probe call: its axis and where the probe stood when it was sent. */
  probes: Array<{ axis: string; at: MachineVec3; target: number }>
  /** Every XY move: where it went and the machine Z it ran at. */
  xyMoves: Array<{ to: { x: number; y: number }; z: number }>
  /** Every G38.3 line (a descent that stops on contact) and the Z it started from. */
  descents: Array<{ line: string; fromZ: number }>
  ok: boolean
  message: string
}

type AwaitSend = (text: string) => Promise<{ ok: boolean; message: string | null }> | null

/** Routines tab -> the routine -> inputs -> Check -> tick -> Run, recording the motion. */
async function runFromRoutinesTab(id: string, start: MachineVec3, inputs: Record<string, string>): Promise<Recorded> {
  await connectSimAt(start)
  const ctrl = getMachineController()
  const rec: Recorded = { probes: [], xyMoves: [], descents: [], ok: false, message: '' }
  const pos = () => ({ ...ctrl.status().machinePos! })
  const realProbe = ctrl.probe.bind(ctrl)
  vi.spyOn(ctrl, 'probe').mockImplementation((axis, target, feed) => {
    rec.probes.push({ axis, at: pos(), target })
    return realProbe(axis, target, feed)
  })
  const realXY = ctrl.jogToWorkXY.bind(ctrl)
  vi.spyOn(ctrl, 'jogToWorkXY').mockImplementation((x, y, feed) => {
    const status = ctrl.status()
    const m = status.machinePos!
    const w = status.workPos!
    rec.xyMoves.push({ to: { x: x + (m.x - w.x), y: y + (m.y - w.y) }, z: m.z })
    return realXY(x, y, feed)
  })
  // The simulator answers G38.3 as GRBL does (the WO-2055 shim): a probe that
  // stops on whatever lies under the probe, else a move that ends quietly at
  // its target.
  const sim = ctrl as unknown as { sendCommandAwait: AwaitSend }
  const realAwait = sim.sendCommandAwait.bind(sim)
  sim.sendCommandAwait = (text) => {
    const m = /^G21 G91 G38\.3 Z-([\d.]+) F([\d.]+)$/.exec(text)
    if (!m) return realAwait(text)
    const at = pos()
    rec.descents.push({ line: text, fromZ: at.z })
    const target = Number((at.z - Number(m[1])).toFixed(4))
    const surface = surfaceAt(at.x, at.y)
    return surface !== null && surface >= target
      ? realAwait(`G21 G91 G38.2 Z-${m[1]} F${m[2]}`)
      : realAwait(`G21 G90 G53 G1 Z${target} F${m[2]}`)
  }

  render(createElement(ProbeRoutinesTab))
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: id } })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  for (const [name, value] of Object.entries(inputs)) {
    fireEvent.change(screen.getByTestId(`probe-routine-input-value-${name}`), { target: { value } })
  }
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-check')) })
  const tick = screen.queryByTestId('probe-routine-path-clear-tick')
  if (!tick) throw new Error(`Check did not reach the run panel: ${screen.getByTestId('probe-routine-preview-col').textContent}`)
  fireEvent.click(tick)
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
  for (let i = 0; i < 400 && !screen.queryByTestId('probe-routine-run-result'); i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  }
  const result = screen.getByTestId('probe-routine-run-result')
  rec.ok = result.getAttribute('data-ok') === 'true'
  rec.message = screen.getByTestId('probe-routine-run-message').textContent ?? ''
  return rec
}

/** The Probing panel's plan for the same start and profile (WO-2055..2058). */
function panelPlan(input: Omit<PlanInput, 'envelope' | 'config' | 'tipRadiusMm'>) {
  const planned = planFeatureProbeCycle({
    ...input,
    envelope: currentResolvedMachineMotion().envelope,
    config: resolveProbeConfig(PROBING, null),
    tipRadiusMm: TIP,
  } as PlanInput)
  if (!planned.ok) throw new Error(planned.reason)
  if (!planned.plan.fromTop) throw new Error('the panel plan does not work from the top')
  return planned.plan
}

/** The heights every side routine keeps: XY only at top + clearance, side touches only at top - depth. */
function expectTopSafeDepth(run: Recorded, top: number, plan: ReturnType<typeof panelPlan>, sideTouches: number): void {
  const safe = top + plan.fromTop!.clearanceMm
  const depth = top - plan.fromTop!.depthMm
  const sides = run.probes.filter((p) => p.axis !== 'Z')
  expect(sides.map((p) => p.at.z)).toEqual(sides.map(() => expect.closeTo(depth, 3)))
  expect(sides.length).toBeGreaterThanOrEqual(sideTouches)
  expect(run.xyMoves.length).toBeGreaterThan(0)
  expect(run.xyMoves.map((m) => m.z)).toEqual(run.xyMoves.map(() => expect.closeTo(safe, 3)))
  // every way down to depth is a probe move that stops on contact (G38.3)
  expect(run.descents.length).toBeGreaterThanOrEqual(1)
  for (const d of run.descents) {
    expect(Number(/Z-([\d.]+)/.exec(d.line)![1])).toBeCloseTo(d.fromZ - depth, 3)
  }
}

/** The simulator runs close to real time under fake timers. */
const RUN_TIMEOUT_MS = 180_000

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  const ctrl = getMachineController()
  if (ctrl.connectionPhase() === 'connected') ctrl.emergencyStop()
  const disconnected = disconnectMachine()
  await vi.advanceTimersByTimeAsync(200)
  await disconnected
  vi.useRealTimers()
})

describe('WO-2065: the Routines-tab factory routines land at the Probing panel\'s top/safe/depth heights (simulator)', () => {
  it('Edge, left face (probe moves X+): touches the top, steps out past the face at top + clearance, descends to top - depth, touches the face', async () => {
    const start = { x: -490, y: -450, z: -60 } // over the block, 10 mm in from the left face
    const run = await runFromRoutinesTab('factory.edge.x-plus', start, {})
    const plan = panelPlan({ kind: 'edge', start, edgeAxis: 'X', edgeDirection: '+' })
    expect(run.probes[0]).toMatchObject({ axis: 'Z', at: { x: expect.closeTo(start.x, 3), y: expect.closeTo(start.y, 3), z: expect.closeTo(start.z, 3) } })
    expectTopSafeDepth(run, BLOCK_TOP, plan, 1)
    // the same stepped-out start as the panel's touch
    const touch = plan.steps.find((s) => s.kind === 'touch')!
    expect(touch.kind === 'touch' && touch.expectedStart.x).toBeCloseTo(run.xyMoves[0].to.x, 3)
    expect(run.descents).toHaveLength(1)
    expect(run.ok, run.message).toBe(true)
  }, RUN_TIMEOUT_MS)

  it('Outside corner, front left: around the corner from the top - X face, back over the start, Y face', async () => {
    const start = { x: -490, y: -490, z: -60 }
    const run = await runFromRoutinesTab('factory.corner.outside.x-plus.y-plus', start, {})
    const plan = panelPlan({ kind: 'outsideCorner', start, cornerXDirection: '+', cornerYDirection: '+' })
    expect(run.probes[0]).toMatchObject({ axis: 'Z' })
    expectTopSafeDepth(run, BLOCK_TOP, plan, 2)
    const touches = plan.steps.filter((s) => s.kind === 'touch')
    expect(run.xyMoves.map((m) => [m.to.x, m.to.y])).toEqual([
      [expect.closeTo(touches[0].kind === 'touch' ? touches[0].expectedStart.x : NaN, 3), expect.closeTo(start.y, 3)],
      [expect.closeTo(start.x, 3), expect.closeTo(start.y, 3)],
      [expect.closeTo(start.x, 3), expect.closeTo(touches[1].kind === 'touch' ? touches[1].expectedStart.y : NaN, 3)],
    ])
    expect(run.descents).toHaveLength(2)
    expect(run.ok, run.message).toBe(true)
  }, RUN_TIMEOUT_MS)

  it('Inside corner (in the bore): no top touch - the top is the typed hole top; one descent, both walls at top - depth', async () => {
    const start = { x: BORE.cx - 5, y: BORE.cy - 5, z: -60 }
    const run = await runFromRoutinesTab('factory.corner.inside.x-minus.y-minus', start, { topZ: String(BLOCK_TOP) })
    const plan = panelPlan({ kind: 'insideCorner', start, cornerXDirection: '-', cornerYDirection: '-', rimTopMachineZMm: BLOCK_TOP })
    expect(run.probes.filter((p) => p.axis === 'Z')).toEqual([])
    const depth = BLOCK_TOP - plan.fromTop!.depthMm
    // each touch is two probe calls (the search and the fine pass)
    expect(run.probes.map((p) => p.axis)).toEqual(['X', 'X', 'Y', 'Y'])
    expect(run.probes.every((p) => Math.abs(p.at.z - depth) < 1e-3)).toBe(true)
    expect(run.descents).toHaveLength(1)
    expect(run.descents[0].fromZ).toBeCloseTo(start.z, 3) // started above safe height: straight down from there
    expect(run.ok, run.message).toBe(true)
  }, RUN_TIMEOUT_MS)

  it('Bore centre: descends from the typed hole top, four walls at top - depth, rises to top + clearance', async () => {
    const start = { x: BORE.cx, y: BORE.cy, z: -60 }
    const run = await runFromRoutinesTab('factory.bore-centre', start, { diameter: String(BORE.diameter), topZ: String(BLOCK_TOP) })
    const plan = panelPlan({ kind: 'bore', start, nominalSizeXmm: BORE.diameter, nominalSizeYmm: BORE.diameter, rimTopMachineZMm: BLOCK_TOP })
    const depth = BLOCK_TOP - plan.fromTop!.depthMm
    expect(run.probes.map((p) => p.axis)).toEqual(['X', 'X', 'X', 'X', 'Y', 'Y', 'Y', 'Y'])
    expect(run.probes.every((p) => Math.abs(p.at.z - depth) < 1e-3)).toBe(true)
    // the wall moves run at depth inside the hole, exactly as the panel's bore
    expect(run.xyMoves.every((m) => Math.abs(m.z - depth) < 1e-3)).toBe(true)
    expect(run.descents).toHaveLength(1)
    expect(getMachineController().status().machinePos!.z).toBeCloseTo(BLOCK_TOP + plan.fromTop!.clearanceMm, 3)
    expect(run.ok, run.message).toBe(true)
    expect(run.message).not.toMatch(/fail|refus|stopp/i)
  }, RUN_TIMEOUT_MS)

  it('Boss centre: started over the middle, touches the top, every XY move at top + clearance, four faces at top - depth', async () => {
    const start = { x: BOSS.cx, y: BOSS.cy, z: -40 }
    const run = await runFromRoutinesTab('factory.boss-centre', start, { diameter: String(BOSS.diameter) })
    const plan = panelPlan({ kind: 'boss', start, nominalSizeXmm: BOSS.diameter, nominalSizeYmm: BOSS.diameter })
    expect(run.probes[0]).toMatchObject({ axis: 'Z', at: { x: expect.closeTo(BOSS.cx, 3), y: expect.closeTo(BOSS.cy, 3) } })
    expectTopSafeDepth(run, BOSS_TOP, plan, 4)
    const stepOuts = plan.steps.filter((s) => s.kind === 'touch').map((s) => (s.kind === 'touch' ? `${s.expectedStart.x},${s.expectedStart.y}` : '')).sort()
    expect(run.xyMoves.slice(0, 4).map((m) => `${Number(m.to.x.toFixed(4))},${Number(m.to.y.toFixed(4))}`).sort()).toEqual(stepOuts)
    expect(run.descents).toHaveLength(4)
    expect(run.ok, run.message).toBe(true)
  }, RUN_TIMEOUT_MS)
})
