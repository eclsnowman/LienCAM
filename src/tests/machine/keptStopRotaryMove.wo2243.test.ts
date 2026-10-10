// WO-2243: a pause inside a move that turns a rotary axis (A alone, or with
// X/Y/Z), then jog / MDI, then CYCLE START. Operator, 2026-09-30 (the WO-2237
// resume-time refusals): "put in the workorders to fix those edge cases". The
// return goes back to the pause point on every axis, the rotary one included -
// up first, then X/Y and the turn at the lifted height, then down at the capped
// feed - and finishes the move and the program. It never turns the rotary axis
// while the tool is down in the work. Real session singleton on the native
// simulator with an independent A axis (a controller made of software), file
// door - the bridge route. This simulator's text door refuses a program with
// A words at its preview ("a coordinate the preview cannot place"), so the
// text route is the Tier 2 kit's LinuxCNC run (src/tests/evidence/WO-2243/).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
  setWorkOffsetValue,
} from '../../lib/machine/machineSession'
import {
  currentOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
} from '../../lib/machine/operatorTransport'
import { buildResumeAtPointPlan, locatePausedLine } from '../../lib/machine/runFromLine'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'

const LINES = [
  'G21 G90 G54', //          1
  'G0 Z5', //                2
  'G0 X0 Y0 A0', //          3
  'G1 Z-1 F300', //          4
  'G1 X60 A90 F600', //      5  X and A together
  'G1 A180', //              6  A alone
  'G1 X0 A270', //           7
  'G0 Z5', //                8
  'M30', //                  9
]
const PROGRAM = LINES.join('\n')

function rotaryMachine(): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z', 'A'])
  for (const axis of definition.axes) {
    axis.enabled = true
    if (axis.axis === 'X' || axis.axis === 'Y' || axis.axis === 'Z') {
      axis.softLimitMin = -1_000
      axis.softLimitMax = 1_000
    }
  }
  return makeMachine({
    id: 'wo2243-a',
    name: 'WO-2243 A machine',
    rapidRate: 5_000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    controllerDefinition: definition,
  })
}

type Sample = { t: number; x: number; y: number; z: number; a: number; state: string }
let samples: Sample[] = []
let clock = 0

async function run(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step)
    clock += step
    const at = getMachineController().status().workPos
    if (at) samples.push({ t: clock, x: at.x, y: at.y, z: at.z, a: at.a ?? NaN, state: getMachineController().machineState() })
  }
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

function here(): { x: number; y: number; z: number; a: number } {
  const at = getMachineController().status().workPos!
  return { x: at.x, y: at.y, z: at.z, a: at.a ?? NaN }
}

/** Load through the file door, CYCLE START, run until `until` holds, Feed
 *  Hold: paused at rest. */
async function pauseWhen(until: (at: ReturnType<typeof here>) => boolean) {
  const loaded = loadGcodeTextToolpathProgram('wo2243.nc', PROGRAM, { publishListing: true })
  await run(100)
  expect(loaded, consoleText()).toEqual({ ok: true, reason: null })
  expect(await executeOperatorCycleStart(), `${JSON.stringify(currentOperatorTransport())} / ${consoleText()}`).toBe(true)
  for (let t = 0; t < 60_000; t += 50) {
    await run(50)
    if (until(here())) break
  }
  expect(until(here()), JSON.stringify(here())).toBe(true)
  expect(executeOperatorFeedHold()).toBe(true)
  await run(1500)
  expect(getMachineController().machineState(), consoleText()).toBe('hold')
  return here()
}

async function cycleStartAndRun(ms = 60_000): Promise<Sample[]> {
  expect(currentOperatorTransport().cycleStartEnabled, JSON.stringify(currentOperatorTransport())).toBe(true)
  samples = []
  expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
  for (let t = 0; t < ms && (t < 1000 || getMachineController().hasActiveJob()); t += 500) await run(500)
  await run(500)
  return samples
}

/** The return, up to the first sample back down at the pause point: the one
 *  before it is still over the point at the pause angle. Sampled every 50 ms,
 *  so the rest of the move may already have begun at that sample. */
function splitAtPoint(path: Sample[], point: ReturnType<typeof here>) {
  const rose = path.findIndex((s) => s.z > point.z + 0.5)
  let at = rose < 0 ? -1 : path.findIndex((s, i) => i > rose && s.z <= point.z + 0.02)
  const above = at > 0 ? path[at - 1] : null
  if (above === null || Math.hypot(above.x - point.x, above.y - point.y) > 0.01 || Math.abs(above.a - point.a) > 0.01) at = -1
  return { at, before: path.slice(0, Math.max(at, 0)), after: path.slice(Math.max(at, 0)) }
}

/** The return turns A only at the lifted height `z`: on the way up A stays
 *  where the stop left it, and once up every sample below `z` is already at the
 *  pause angle. (Sampled every 50 ms: the turn can end at `z` and the plunge
 *  begin inside one sample; the point is rounded to four decimals.) */
function turnsOnlyAbove(before: Sample[], z: number, angle: number): boolean {
  const up = before.findIndex((s) => s.z >= z - 1e-6)
  if (up < 0) return false
  if (before.slice(0, up).some((s) => Math.abs(s.a - before[0].a) > 1e-3)) return false
  return before.slice(up).every((s) => s.z >= z - 1e-6 || Math.abs(s.a - angle) < 1e-3)
}

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

async function connectRotarySimulator(): Promise<void> {
  vi.useFakeTimers()
  samples = []
  clock = 0
  const state = useCamStore.getState()
  originalProject = state.project
  originalLibrary = state.machineLibrary
  originalControl = state.control
  const machine = rotaryMachine()
  useCamStore.setState((s) => ({
    project: { ...s.project, machine },
    machineLibrary: [machine],
    control: { ...s.control, activeMachineId: null, sessionMachine: null, appliedMachine: null, sessionActiveMachineId: undefined },
  }))
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(500)
  await pending
  __resetEstopInterlockForTest()
  expect(getMachineController().home()).toBe(true)
  await vi.advanceTimersByTimeAsync(3000)
  for (const [axis, mm] of [['X', 100], ['Y', 100], ['Z', 60]] as const) {
    expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
  }
  useMachineControl.setState({ consoleLines: [] })
}

async function disconnectRotarySimulator(): Promise<void> {
  vi.restoreAllMocks()
  getMachineController().emergencyStop()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
}

describe('WO-2243 a pause inside a rotary move - native simulator with an A axis, file door', () => {
  beforeEach(connectRotarySimulator)
  afterEach(disconnectRotarySimulator)

  it('paused inside X+A -> jog A and an MDI move -> CYCLE START: up, back to the point and its angle, down, the rest of the move, the program ends', async () => {
    const paused = await pauseWhen((at) => at.x > 15 && at.x < 45)
    expect(paused.z).toBeCloseTo(-1, 3)
    // On the move: A turns with X, 90 deg over 60 mm.
    expect(paused.a).toBeCloseTo(paused.x * 1.5, 1)
    // The Control panel's A jog, then a typed move.
    expect(getMachineController().jog('A', 40, 1000)).toBe(true)
    await run(4000)
    expect(sendMdiLine('G91 G0 Y10')).toBe(true)
    await run(3000)
    expect(here().y).toBeCloseTo(10, 2)
    expect(here().a).toBeCloseTo(paused.a + 40, 2)
    expect(consoleText()).toMatch(
      /Stopped at line 5 so you can move; CYCLE START goes back to G54 X \d+\.\d{2} mm Y 0\.00 mm Z -1\.00 mm A [\d.]+ and carries on from line 5\./,
    )
    const path = await cycleStartAndRun()
    const text = consoleText()
    expect(text).not.toMatch(/cannot be resumed|not one plain move/)
    expect(text).toMatch(/going back to G54 X -?\d+\.\d{2} mm Y 0\.00 mm Z -1\.00 mm A [\d.]+ \(safe Z, then X\/Y, then down at the approach feed\)/)
    const { at, before, after } = splitAtPoint(path, paused)
    expect(at, JSON.stringify(path.slice(0, 40))).toBeGreaterThan(-1)
    // The turn back to the pause angle happened above the program's clearance.
    expect(before.some((s) => Math.abs(s.a - (paused.a + 40)) > 1)).toBe(true)
    expect(turnsOnlyAbove(before, 5, paused.a), JSON.stringify(before.map((s) => [s.z, s.a]))).toBe(true)
    // Nothing of the return went below the point.
    expect(before.every((s) => s.z >= -1 - 1e-6)).toBe(true)
    // The rest of line 5 runs from the point, on its own path: A with X.
    const line5 = after.filter((s) => s.x < 59.99 && s.a < 89.99)
    expect(line5.length).toBeGreaterThan(0)
    expect(line5.every((s) => s.x >= paused.x - 0.01 && Math.abs(s.a - s.x * 1.5) < 0.1 && Math.abs(s.y) < 1e-6)).toBe(true)
    // Then line 6 (A alone to 180) and line 7 (back to X0 with A to 270).
    expect(after.some((s) => Math.abs(s.x - 60) < 0.01 && s.a > 120 && s.a < 170)).toBe(true)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(here()).toMatchObject({ x: expect.closeTo(0, 2), y: expect.closeTo(0, 2), z: expect.closeTo(5, 2), a: expect.closeTo(270, 2) })
  })

  it('paused inside a move that turns A alone -> jog -> CYCLE START comes back to the angle it stopped at and finishes the turn', async () => {
    const paused = await pauseWhen((at) => Math.abs(at.x - 60) < 1e-6 && at.a > 110 && at.a < 160)
    expect(getMachineController().jog('Y', 5, 1000)).toBe(true)
    await run(2000)
    expect(here().y).toBeCloseTo(5, 2)
    expect(consoleText()).toMatch(new RegExp(`Stopped at line 6 so you can move; CYCLE START goes back to G54 X 60.00 mm Y 0.00 mm Z -1.00 mm A ${paused.a.toFixed(4).replace(/\.?0+$/, '').replace('.', '\\.')} and carries on from line 6\\.`))
    const path = await cycleStartAndRun()
    const { at, before, after } = splitAtPoint(path, paused)
    expect(at).toBeGreaterThan(-1)
    expect(turnsOnlyAbove(before, 5, paused.a), JSON.stringify(before.map((s) => [s.z, s.a]))).toBe(true)
    // The turn is not started again from 90: it carries on from the pause angle.
    const turning = after.filter((s) => Math.abs(s.x - 60) < 1e-6 && s.a < 179.99)
    expect(turning.length).toBeGreaterThan(0)
    expect(Math.min(...turning.map((s) => s.a))).toBeGreaterThanOrEqual(paused.a - 0.01)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(here()).toMatchObject({ x: expect.closeTo(0, 2), a: expect.closeTo(270, 2) })
  })

  it('a pause with no command inside the rotary move resumes on the board as it always did', async () => {
    const paused = await pauseWhen((at) => at.x > 15 && at.x < 45)
    const path = await cycleStartAndRun()
    expect(consoleText()).not.toMatch(/Stopped at line/)
    // Carries straight on from where it held - no lift, no return.
    expect(path.every((s, i) => i === 0 || s.z <= paused.z + 1e-6 || s.x < 1)).toBe(true)
    expect(Math.min(...path.filter((s) => s.a < 90).map((s) => s.x))).toBeGreaterThanOrEqual(paused.x - 0.01)
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })
})

describe('WO-2243 the return plan for a line that turns a rotary axis', () => {
  it('X with A: the point carries its angle; A turns there before the tool comes down; the rest turns on to the end', () => {
    const found = locatePausedLine(PROGRAM, [6, 5, 4], { x: 20, y: 0, z: -1, a: 30 }, 0.25)
    expect(found).toEqual({ line: 5, pointMm: { x: 20, y: 0, z: -1, a: 30 }, offPathMm: 0 })
    const planned = buildResumeAtPointPlan(PROGRAM, 5, found!.pointMm, { safeZMachine: -5 })
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt).toMatchObject({ line: 5, text: 'G1 X60 Y0 Z-1 A90 F600', point: { x: 20, y: 0, z: -1, a: 30 } })
    const p = planned.plan.prelude
    const lift = p.indexOf('G53 G0 Z-5')
    const over = p.indexOf('G0 X20 Y0 A30')
    const down = p.indexOf('G1 Z-1 F300')
    expect(lift).toBeGreaterThan(-1)
    expect(over).toBeGreaterThan(lift)
    expect(down).toBeGreaterThan(over)
    // Nothing after the plunge names A: the turn is over before the tool is down.
    expect(p.slice(down).some((c) => /A/.test(c))).toBe(false)
    expect(planned.plan.warnings[0]).toMatch(/^CYCLE START goes back to X20 Y0 Z-1 A30, where the pause stopped line 5/)
  })

  it('a move that turns A alone is placed by its angle - the cursor naming the next line does not skip the rest of this one', () => {
    const program = ['G21 G90 G54', 'G0 Z5', 'G0 X10 Y0 A0', 'G1 Z-1 F300', 'G1 A90 F600', 'G1 A180', 'G0 Z5', 'M30'].join('\n')
    // Cursor ahead on line 6, the tool still turning on line 5 at A45.
    const found = locatePausedLine(program, [6, 5], { x: 10, y: 0, z: -1, a: 45 }, 0.25)
    expect(found).toEqual({ line: 5, pointMm: { x: 10, y: 0, z: -1, a: 45 }, offPathMm: 0 })
    const planned = buildResumeAtPointPlan(program, 5, found!.pointMm, {})
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G1 X10 Y0 Z-1 A90 F600')
    // Past line 5's end, line 6 is the one.
    expect(locatePausedLine(program, [5, 6], { x: 10, y: 0, z: -1, a: 135 }, 0.25)?.line).toBe(6)
    // An angle off both turns is on neither line.
    expect(locatePausedLine(program, [5, 6], { x: 10, y: 0, z: -1, a: 200 }, 0.25)).toBeNull()
  })

  it('G91: the rest of the move is the distance and the turn left from the point', () => {
    const program = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0 A10', 'G1 Z-1 F300', 'G91 G1 X60 A90 F600', 'G90 G0 Z5', 'M30'].join('\n')
    const found = locatePausedLine(program, [5], { x: 20, y: 0, z: -1, a: 40 }, 0.25)
    expect(found?.pointMm).toEqual({ x: 20, y: 0, z: -1, a: 40 })
    const planned = buildResumeAtPointPlan(program, 5, found!.pointMm, {})
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G91 G1 X40 Y0 Z0 A60 F600')
    expect(planned.ok && planned.plan.prelude).toContain('G0 X20 Y0 A40')
  })

  it('G93 inverse time: the way down is in millimetres per minute, and the rest of the move takes its share of the time', () => {
    const program = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0 A0', 'G1 Z-1 F300', 'G93 G1 X60 A90 F2', 'G94 G0 Z5', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(program, 5, { x: 30, y: 0, z: -1, a: 45 }, {})
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    // Half the move is left: it takes half the line's time (F2 -> F4), and the
    // line's own G93 comes with it.
    expect(planned.plan.resumeAt.text).toBe('G93 G1 X60 Y0 Z-1 A90 F4')
    const p = planned.plan.prelude
    const g94 = p.indexOf('G94')
    const down = p.findIndex((c) => /^G1 Z-1 F\d+/.test(c))
    expect(g94).toBeGreaterThan(-1)
    expect(down).toBeGreaterThan(g94)
    expect(p).not.toContain('G93')

    // G93 set before the line: it goes back on after the way down.
    const earlier = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0 A0', 'G1 Z-1 F300', 'G93', 'G1 X60 A90 F2', 'G94 G0 Z5', 'M30'].join('\n')
    const again = buildResumeAtPointPlan(earlier, 6, { x: 45, y: 0, z: -1, a: 67.5 }, {})
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.plan.resumeAt.text).toBe('G1 X60 Y0 Z-1 A90 F8')
    const q = again.plan.prelude
    const down2 = q.findIndex((c) => /^G1 Z-1 F\d+/.test(c))
    expect(q.indexOf('G94')).toBeGreaterThan(-1)
    expect(down2).toBeGreaterThan(q.indexOf('G94'))
    expect(q.lastIndexOf('G93')).toBeGreaterThan(down2)

    // Every move before the line in G93: its last F is a time, so the way down
    // is at the capped 300 mm/min, never F5 read as a speed.
    const timed = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0 A0', 'G93 G1 Z-1 F5', 'G1 X60 A90 F2', 'G94 G0 Z5', 'M30'].join('\n')
    const timedPlan = buildResumeAtPointPlan(timed, 5, { x: 30, y: 0, z: -1, a: 45 }, {})
    expect(timedPlan.ok && timedPlan.plan.prelude).toContain('G1 Z-1 F300')
    expect(timedPlan.ok && timedPlan.plan.resumeAt.text).toBe('G1 X60 Y0 Z-1 A90 F4')
  })

  it('an arc that turns A: the point is on the arc at its share of the turn', () => {
    const program = ['G21 G90 G54 G17', 'G0 Z5', 'G0 X0 Y0 A0', 'G1 Z-1 F300', 'G2 X20 Y0 I10 J0 A180 F600', 'G0 Z5', 'M30'].join('\n')
    // A quarter of the way: the arc's top, A90.
    const found = locatePausedLine(program, [5], { x: 10, y: 10, z: -1, a: 90 }, 0.25)
    expect(found?.line).toBe(5)
    expect(found!.pointMm.a).toBeCloseTo(90, 6)
    const planned = buildResumeAtPointPlan(program, 5, found!.pointMm, {})
    expect(planned.ok && planned.plan.resumeAt.text).toBe('G2 X20 Y0 Z-1 A180 I0 J-10 F600')
  })

  it('a line whose A start the program never set starts from its beginning, as before', () => {
    const program = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0', 'G1 Z-1 F300', 'G1 X60 A90 F600', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(program, 5, { x: 20, y: 0, z: -1, a: 30 }, {})
    expect(planned).toEqual({ ok: false, reason: 'The pause point cannot be resumed inside line 5 starts where A is not known.' })
  })

  it('a line with no rotary word plans exactly as before - no angle in the point', () => {
    const program = ['G21 G90 G54', 'G0 Z5', 'G0 X0 Y0 A15', 'G1 Z-1 F300', 'G1 X60 F600', 'M30'].join('\n')
    const planned = buildResumeAtPointPlan(program, 5, { x: 20, y: 0, z: -1, a: 15 }, {})
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.resumeAt.point).toEqual({ x: 20, y: 0, z: -1 })
    expect(planned.plan.resumeAt.text).toBe('G1 X60 Y0 Z-1 F600')
    // A stays where the program set it before the line (the WO-1989 prelude).
    expect(planned.plan.prelude).toContain('G0 X20 Y0 A15')
  })
})
