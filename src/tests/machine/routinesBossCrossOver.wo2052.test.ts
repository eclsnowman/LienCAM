// @vitest-environment jsdom
//
// WO-2052 - THE ROUTINES-TAB BOSS NEVER MOVES THROUGH THE BOSS.
//
// The factory "Boss centre" routine lifted to start Z + crossOverLift (10 mm)
// before each cross-over. Started more than 10 mm below the boss top, every
// cross-over drove the probe through the boss - the collision WO-2035 fixed on
// the Probing panel's boss. WO-2052 made it cross at the machine's safe Z.
// WO-2065 (the design Operator approved in WO-2034, as the panel's WO-2058): the
// operator starts OVER THE MIDDLE, the routine touches the top there, and every
// XY move runs at that touched top + clearance; every way down to probing
// depth is a probe move that stops on contact. The rule stays: never through
// the boss.
//
// Driven through the real Routines tab (ProbeRoutinesTab: pick Boss centre,
// type the diameter, Check, tick, Run - ProbeRoutineRunPanel calls
// runProbeRoutine) on the real SimulatedController (GRBL text route; G38.3
// answered by the WO-2055/WO-2073 shim below) with its WO-416 virtual boss.
// Every XY move the routine commands is recorded with the machine Z the probe
// stood at when it was sent; an XY move below the boss top whose path comes
// within the probe's reach of the boss axis is a COLLISION.
//
// NOT CLAIMED: hardware. No board readback exists for this change.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { DEFAULT_MACHINE_PROBE_DEFAULTS } = await import('../../lib/machine/toolTable')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useCamStore } = await import('../../store')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  setSimulatedPart,
} = await import('../../lib/machine/machineSession')

const TIP = 1.5 // the Routines tab's tip radius field default
const DIAMETER = 40
// Machine zero at max on every axis, Operator's travel (the WO-467 / WO-2035 simulator fixture).
const BOSS = { cx: -400, cy: -400, diameter: DIAMETER, height: 25 }
const BLOCK_TOP = -80
const BOSS_TOP = BLOCK_TOP + BOSS.height // machine Z -55
const REACH = DIAMETER / 2 + TIP
const DECLARED_SAFE_Z = -5
/** Safe height: the touched top + the profile's surface clearance. */
const CLEARANCE = DEFAULT_MACHINE_PROBE_DEFAULTS.surfaceClearance ?? 5
const SAFE = BOSS_TOP + CLEARANCE

interface XYMove { from: { x: number; y: number }; to: { x: number; y: number }; z: number }

function distanceToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2))
  return Math.hypot(a.x + t * dx - px, a.y + t * dy - py)
}

function collisions(moves: XYMove[]): string[] {
  return moves
    .filter((m) => m.z < BOSS_TOP && distanceToSegment(BOSS.cx, BOSS.cy, m.from, m.to) < REACH - 1e-3)
    .map((m) => `XY move to ${m.to.x},${m.to.y} at Z ${m.z} passes through the boss (top ${BOSS_TOP})`)
}

/** Fake timers never advance on their own - drive a promise to completion. */
async function settle<T>(promise: Promise<T>, ms = 60_000): Promise<T> {
  let done = false
  let value: T | undefined
  void promise.then((v) => { value = v; done = true })
  for (let waited = 0; !done && waited < ms; waited += 250) await vi.advanceTimersByTimeAsync(250)
  expect(done).toBe(true)
  return value as T
}

async function connectSimAt(heightAboveTop: number, safeZMachine: number | undefined): Promise<{ startZ: number }> {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo2052-sim-machine',
    name: 'WO-2052 simulator fixture',
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
    safeZMachine,
    // quick positioning so the simulated run takes seconds, not a minute; the
    // search feed at the Z ceiling (1000), since the routine now touches Z
    probing: { ...DEFAULT_MACHINE_PROBE_DEFAULTS, positioningFeed: 6000, fastFeed: 1000, slowFeed: 300 },
  })
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  __resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(50)
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(3000)
  expect(setSimulatedPart({
    origin: { x: -500, y: -500 },
    sizeX: 200,
    sizeY: 200,
    topZ: BLOCK_TOP,
    height: 30,
    bowMm: 0,
    noiseMm: 0,
    boss: BOSS,
  })).toBe(true)
  // over the middle of the boss, by eye (design 4.2)
  const startZ = BOSS_TOP + heightAboveTop
  const ctrl = getMachineController()
  await settle((async () => {
    const ack = await ctrl.sendCommandAwait(`G53 G90 G0 X${BOSS.cx} Y${BOSS.cy} Z${startZ}`)
    if (!ack?.ok) throw new Error(`jog refused: ${ack?.message}`)
    for (let i = 0; i < 400; i++) {
      ctrl.queryStatus()
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (ctrl.verifiedIdle()) return
    }
    throw new Error('jog did not settle to Idle')
  })())
  return { startZ }
}

interface Run {
  startZ: number
  moves: XYMove[]
  zTargets: number[]
  descents: string[]
  ok: boolean
  message: string
  proposal: string
}

type AwaitSend = (text: string) => Promise<{ ok: boolean; message: string | null }> | null

/** Routines tab -> Boss centre -> diameter -> Check -> tick -> Run. */
async function runFromRoutinesTab(heightAboveTop: number, safeZMachine: number | undefined, diameter = DIAMETER): Promise<Run> {
  const { startZ } = await connectSimAt(heightAboveTop, safeZMachine)
  const ctrl = getMachineController()
  const moves: XYMove[] = []
  const zTargets: number[] = []
  const realXY = ctrl.jogToWorkXY.bind(ctrl)
  const realZ = ctrl.jogToMachineZ.bind(ctrl)
  vi.spyOn(ctrl, 'jogToWorkXY').mockImplementation((x, y, feed) => {
    const status = ctrl.status()
    const m = status.machinePos!
    const w = status.workPos!
    moves.push({ from: { x: m.x, y: m.y }, to: { x: x + (m.x - w.x), y: y + (m.y - w.y) }, z: m.z })
    return realXY(x, y, feed)
  })
  vi.spyOn(ctrl, 'jogToMachineZ').mockImplementation((z, feed) => {
    zTargets.push(z)
    return realZ(z, feed)
  })
  // The simulator answers G38.3 as GRBL does (the WO-2055 shim): a probe that
  // stops on the boss top when the probe is over the boss, else a move that
  // ends quietly at its target.
  const descents: string[] = []
  const sim = ctrl as unknown as { sendCommandAwait: AwaitSend }
  const realAwait = sim.sendCommandAwait.bind(sim)
  sim.sendCommandAwait = (text) => {
    const g383 = /^G21 G91 G38\.3 Z-([\d.]+) F([\d.]+)$/.exec(text)
    if (!g383) return realAwait(text)
    descents.push(text)
    const at = ctrl.status().machinePos!
    const target = Number((at.z - Number(g383[1])).toFixed(4))
    const overBoss = Math.hypot(at.x - BOSS.cx, at.y - BOSS.cy) <= BOSS.diameter / 2
    return overBoss && BOSS_TOP >= target
      ? realAwait(`G21 G91 G38.2 Z-${g383[1]} F${g383[2]}`)
      : realAwait(`G21 G90 G53 G1 Z${target} F${g383[2]}`)
  }

  render(createElement(ProbeRoutinesTab))
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.boss-centre' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  fireEvent.change(screen.getByTestId('probe-routine-input-value-diameter'), { target: { value: String(diameter) } })
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-check')) })
  const tick = screen.queryByTestId('probe-routine-path-clear-tick')
  if (!tick) throw new Error(`Check did not reach the run panel: ${screen.getByTestId('probe-routine-preview-col').textContent}`)
  fireEvent.click(tick)
  await act(async () => { fireEvent.click(screen.getByTestId('probe-routine-run')) })
  for (let i = 0; i < 400 && !screen.queryByTestId('probe-routine-run-result'); i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  }
  const result = screen.getByTestId('probe-routine-run-result')
  return {
    startZ,
    moves,
    zTargets,
    descents,
    ok: result.getAttribute('data-ok') === 'true',
    message: screen.getByTestId('probe-routine-run-message').textContent ?? '',
    proposal: result.textContent ?? '',
  }
}

/** The simulator runs close to real time under fake timers: one Boss centre run
 *  is ~30-55 s of wall clock on the dev box. */
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

describe('WO-2052 / WO-2065: the Routines-tab Boss centre on the simulator, started over the middle', () => {
  it('started 15 mm above the boss top: touches the top, every XY move runs at the touched top + clearance, above the boss; no collision', async () => {
    const run = await runFromRoutinesTab(15, DECLARED_SAFE_Z)
    // four step-outs and the finish over the middle
    expect(run.moves.length).toBe(5)
    expect(collisions(run.moves)).toEqual([])
    expect(run.moves.map((m) => m.z)).toEqual(run.moves.map(() => expect.closeTo(SAFE, 3)))
    expect(run.moves.every((m) => m.z > BOSS_TOP)).toBe(true)
    // the cross-over height is the touched top + clearance - not the declared safe Z
    expect(SAFE).not.toBe(DECLARED_SAFE_Z)
    // rises to safe height once after the top touch and after each face; every way down is G38.3
    expect(run.zTargets).toEqual([SAFE, SAFE, SAFE, SAFE, SAFE].map((z) => expect.closeTo(z, 3)))
    expect(run.descents).toHaveLength(4)
    expect(run.ok, run.message).toBe(true)
    expect(run.message, run.proposal).not.toMatch(/fail|refus|stopp/i)
    expect(run.proposal).toContain('Set work zero at the boss centre')
  }, RUN_TIMEOUT_MS)

  it('started 2 mm above the top on a machine that declares no safe Z: the same heights, and it finds the boss', async () => {
    const run = await runFromRoutinesTab(2, undefined)
    expect(run.moves.length).toBe(5)
    expect(collisions(run.moves)).toEqual([])
    expect(run.moves.every((m) => Math.abs(m.z - SAFE) < 1e-3)).toBe(true)
    expect(run.ok, run.message).toBe(true)
    expect(run.proposal).toContain('Set work zero at the boss centre')
  }, RUN_TIMEOUT_MS)

  it('the diameter typed half the real one: the first descent lands on the boss top and the run stops there - never a move through the boss', async () => {
    const run = await runFromRoutinesTab(15, DECLARED_SAFE_Z, DIAMETER / 2)
    // one step-out, at safe height, that lands over the boss (16.5 mm from its axis, radius 20)
    expect(run.moves.length).toBe(1)
    expect(collisions(run.moves)).toEqual([])
    expect(run.moves[0].z).toBeCloseTo(SAFE, 3)
    expect(run.descents).toHaveLength(1)
    expect(run.ok).toBe(false)
    expect(run.message).toContain('The descent to probing depth touched something above that depth')
    expect(run.proposal).not.toContain('Set work zero at the boss centre')
  }, RUN_TIMEOUT_MS)
})
