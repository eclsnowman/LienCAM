// @vitest-environment jsdom
//
// WO-2063 - the Probing screen shows one step at a time
// (docs/design/PROBING-SCREEN-V2.md).
//
//  - Layout: "side view" / "top view" captions over the pictures, the step
//    sentence UNDER them with no YOU tag, the step numbers in one row (current
//    outlined, done ticked, YOU steps marked "YOU"), no "Preview steps / Step n
//    of N"; the right column holds Jog, Picture key, More (one open at a time),
//    E-STOP, Start probing and Stop - and no CYCLE START, Feed Hold or
//    Stop/Reset.
//  - While it runs: the screen follows the machine's real position step by step
//    (the step tracker), the distance counts down, done steps get ticks, and a
//    stopped run says "Stopped at step n" beside the numbers.
//  - Stop: the brief's Stop cancels the running routine without an E-STOP
//    latch. Measured first (src/tests/evidence/WO-2063/stopMeasurement*.ts).
//    It is the app's one Stop/Reset path (executeOperatorStopReset), gated
//    the same way; WO-2071 makes the runners end on it.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((r: CycleResult) => void) | null = null
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>((resolve) => { finishCycle = resolve }))
// Operator ruling WO-2600: "Stop only stops probing and can be restarted by hitting probe again."
const stopProbing = vi.fn()
const executeOperatorStopReset = vi.fn(() => true)

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle,
    stopProbing,
    setWorkOffsetValue: vi.fn(() => true),
  })
})
vi.mock('../../lib/machine/operatorTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/operatorTransport')>()
  return typedMock<typeof import('../../lib/machine/operatorTransport')>({ ...actual, executeOperatorStopReset })
})

const { ProbingPanel, PROBE_STOP_TOOLTIP, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { buildProbeScene } = await import('../../components/machine/probing/probeScene')
const { buildSurfaceMeshPoints } = await import('../../lib/machine/zSurfaceMesh')
type SceneSetup = import('../../components/machine/probing/probeScene').SceneSetup
const { startTracker, trackPosition } = await import('../../components/machine/probing/stepTracker')
const { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } = await import('../../lib/machine/toolTable')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

// A homed GRBL-shaped machine with known travel, standing over the stock:
// the Probing screen can plan, so Start probing is live.
const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  finishCycle = null
  runFeatureProbeCycle.mockClear()
  executeOperatorStopReset.mockClear()
  stopProbing.mockClear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: true,
    settings: SETTINGS,
    mpos: { ...START },
    wpos: { x: 5, y: 0, z: 10 },
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''

describe('WO-2063 the layout', () => {
  it('captions over the pictures, the sentence under them, the numbers in one row', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    expect(screen.getByTestId('probing-caption-side').textContent).toBe('Front view')
    expect(screen.getByTestId('probing-caption-top').textContent).toBe('Top view')
    const card = screen.getByTestId('probing-step-card')
    const order = [...card.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    expect(order.indexOf('probing-caption-side')).toBeLessThan(order.indexOf('probe-picture'))
    expect(order.indexOf('probe-picture')).toBeLessThan(order.indexOf('probing-step-sentence'))
    expect(order.indexOf('probing-step-sentence')).toBeLessThan(order.indexOf('probing-step-strip'))
    // No YOU tag before the sentence; no "Preview steps / Step n of N"
    // heading. WO-2126's "Preview steps" BUTTON in the step strip is Operator's
    // (09-28), so the card is read without it.
    expect(sentence().startsWith('Jog the probe')).toBe(true)
    const withoutPlay = card.cloneNode(true) as HTMLElement
    withoutPlay.querySelector('[data-testid="probing-step-play"]')?.remove()
    expect(withoutPlay.textContent).not.toMatch(/Preview steps|Live progress|Step \d+ of \d+/)
    // Edge: 9 steps, 1 2 and 9 are YOU steps, 1 is current.
    const chips = screen.getAllByTestId(/^probing-step-chip-/)
    expect(chips).toHaveLength(9)
    expect(chips.filter((c) => c.textContent?.includes('YOU')).map((c) => c.getAttribute('data-testid'))).toEqual([
      'probing-step-chip-1', 'probing-step-chip-2', 'probing-step-chip-9',
    ])
    expect(chips[0].getAttribute('aria-current')).toBe('step')
  })

  it('the right column: Jog, Picture key, More, then E-STOP, Start probing and Stop - no CYCLE START, Feed Hold or Stop/Reset', () => {
    render(React.createElement(ProbingPanel))
    const right = screen.getByTestId('control-probing-right')
    expect(right.querySelector('[data-testid="control-home"]')).not.toBeNull()
    expect(right.querySelector('[data-testid="probing-key-panel"]')).not.toBeNull()
    expect(right.querySelector('[data-testid="probing-more-panel"]')).not.toBeNull()
    expect(right.querySelector('[data-testid="control-estop"]')).not.toBeNull()
    expect(right.querySelector('[data-testid="control-probe-run-guided"]')?.textContent).toBe('Start probing')
    expect(right.querySelector('[data-testid="control-probe-stop"]')?.textContent).toBe('Stop')
    const panel = screen.getByTestId('control-probing-panel')
    expect(panel.querySelector('[data-testid="control-cyclestart"]')).toBeNull()
    expect(panel.querySelector('[data-testid="control-feedhold"]')).toBeNull()
    expect(panel.querySelector('[data-testid="control-stop-reset"]')).toBeNull()
    // The left column: Main's Position panel, then the routines, then the setup.
    const left = screen.getByTestId('control-probing-left')
    expect(left.querySelector('[data-testid="control-dro-x"]')).not.toBeNull()
    expect(left.querySelector('[data-testid="control-work-probe-routine-workZero"]')).not.toBeNull()
  })

  it('Picture key and More about this step open one at a time', () => {
    // A 1080-tall screen opens with the key (a shorter one starts both closed
    // so the E-STOP stays on screen).
    Object.defineProperty(window, 'innerHeight', { value: 1080, configurable: true })
    render(React.createElement(ProbingPanel))
    const keyOpen = () => screen.queryByTestId('probing-picture-key') !== null
    const moreOpen = () => screen.queryByTestId('probing-more') !== null || screen.queryByTestId('probing-more-empty') !== null
    expect(keyOpen()).toBe(true)
    expect(moreOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('probing-more-toggle'))
    expect(moreOpen()).toBe(true)
    expect(keyOpen()).toBe(false)
    fireEvent.click(screen.getByTestId('probing-key-toggle'))
    expect(keyOpen()).toBe(true)
    expect(moreOpen()).toBe(false)
  })

  it('More on a probing step is the three headed sections with the real feeds', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-7'))
    fireEvent.click(screen.getByTestId('probing-more-toggle'))
    const more = screen.getByTestId('probing-more')
    expect([...more.querySelectorAll('h4')].map((h) => h.textContent)).toEqual([
      'The probing sequence', 'If nothing is touched', 'How the face is sensed',
    ])
    const cfg = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
    expect(more.textContent).toContain(`Search: ${cfg.fastFeed} mm/min until it touches`)
    expect(more.textContent).toContain(`Slow touch: ${cfg.slowFeed} mm/min (this one is recorded)`)
  })

  it('Stop is live whenever the machine is connected and sends only the probing Stop path', () => {
    render(React.createElement(ProbingPanel))
    const stop = screen.getByTestId('control-probe-stop') as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    expect(stop.getAttribute('data-tooltip')).toBe(PROBE_STOP_TOOLTIP)
    fireEvent.click(stop)
    expect(stopProbing).toHaveBeenCalledTimes(1)
    expect(executeOperatorStopReset).not.toHaveBeenCalled()
  })

  it('Stop is grey only when there is no machine to stop (the same gate as the Control tab Stop/Reset)', () => {
    useMachineControl.setState({ connectionPhase: 'disconnected' })
    render(React.createElement(ProbingPanel))
    const stop = screen.getByTestId('control-probe-stop') as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    fireEvent.click(stop)
    expect(executeOperatorStopReset).not.toHaveBeenCalled()
    expect(stopProbing).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const EDGE: SceneSetup = {
  routine: 'edge', config: CONFIG, tipRadiusMm: 1.5, plateMm: 0, startDistanceMm: 10, depthMm: 5,
  edgeAxis: 'X', edgeDirection: '+', cornerXDirection: '+', cornerYDirection: '+', angleNominalAxis: 'X',
  angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25, sizeXmm: 25, sizeYmm: 25, wcs: 'G54',
}

/** The machine positions an Edge X+ run streams, as the runner moves: top
 *  touch (search, back off, slow touch, retract), rise, step out, descent,
 *  side touch (search, back off, slow touch, retract), rise. Top at Z -20. */
function edgeRunPath(): Array<{ x: number; y: number; z: number }> {
  const out: Array<{ x: number; y: number; z: number }> = []
  const go = (from: { x: number; y: number; z: number }, to: Partial<{ x: number; y: number; z: number }>, n = 5) => {
    const end = { ...from, ...to }
    for (let i = 1; i <= n; i++) out.push({ x: from.x + (end.x - from.x) * i / n, y: from.y + (end.y - from.y) * i / n, z: from.z + (end.z - from.z) * i / n })
    return end
  }
  let p = { ...START }
  p = go(p, { z: -20 }) // top touch
  p = go(p, { z: -18 }, 2) // back off
  p = go(p, { z: -20 }, 2) // slow touch
  p = go(p, { z: -18 }, 2) // retract
  p = go(p, { z: -15 }) // rise to safe (top + 5)
  p = go(p, { x: START.x - 16.5 }) // step out
  p = go(p, { z: -25 }) // descend to depth (top - 5)
  p = go(p, { x: START.x - 5 - 1.5 }) // probe X+ until it touches the face (face at X start - 5)
  p = go(p, { x: START.x - 5 - 1.5 - 2 }, 2) // back off
  p = go(p, { x: START.x - 5 - 1.5 }, 2) // slow touch
  p = go(p, { x: START.x - 5 - 1.5 - 2 }, 2) // retract (the picture's "Backs off 2 mm")
  go(p, { z: -15 }) // rise
  return out
}

describe('WO-2063 the step tracker follows the machine', () => {
  it('an Edge run walks the steps in order, touches where the probe reverses, and ends on the rise', () => {
    const scene = buildProbeScene(EDGE)
    let state = startTracker(scene, START)
    const seen: number[] = []
    for (const pos of edgeRunPath()) {
      state = trackPosition(scene, state, pos)
      if (seen.at(-1) !== state.step) seen.push(state.step)
    }
    const n = (i: number) => scene.steps[i].n
    // Steps 3..8: top touch, rise, step out, descend, probe X+, back off + rise.
    expect(seen.map(n)).toEqual([3, 4, 5, 6, 7, 8])
    expect(state.move).toBe(1)
    expect(state.t).toBeCloseTo(1, 3)
    // The probe reversing off the face moved it on to the back-off, which
    // draws the touch it found.
    expect(scene.steps[state.step].found).toHaveLength(1)
  })

  it('the probe move\'s distance counts down as the machine moves', () => {
    const scene = buildProbeScene(EDGE)
    let state = startTracker(scene, START)
    const path = edgeRunPath()
    const ts: number[] = []
    for (const pos of path) {
      state = trackPosition(scene, state, pos)
      if (scene.steps[state.step].n === 5) ts.push(state.t)
    }
    expect(ts.length).toBeGreaterThan(2)
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1])
    expect(ts.at(-1)).toBeCloseTo(1, 3)
  })
})

describe('WO-2063 while it runs, through the Probing screen', () => {
  it('Start probing runs the routine; the screen follows the machine; a stop says where it stopped', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    const start = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
    expect(start.disabled).toBe(false)
    await act(async () => { fireEvent.click(start) })
    expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
    // Start probing is the operator's go: the plan runs with the path confirmed.
    expect((runFeatureProbeCycle.mock.calls[0] as unknown[])[2]).toBe(true)
    // WO-2557: the request alone does not advance the preview.
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    const path = edgeRunPath()
    await act(async () => { useMachineControl.setState({ mpos: path[0] }) })
    expect(sentence()).toContain('Touches the top')
    // Stream the run up to the descent to probing depth.
    const upToDescent = path.slice(0, 5 + 2 + 2 + 2 + 5 + 5 + 3)
    for (const pos of upToDescent) await act(async () => { useMachineControl.setState({ mpos: pos }) })
    expect(sentence()).toContain('Descends to probing depth')
    // RUNNING (the Bore video, part 2): the real probe follows the machine;
    // ONE path and ONE distance, counting down, in the picture.
    const picture = screen.getByTestId('probe-picture')
    expect(picture.getAttribute('data-mode')).toBe('running')
    expect(within(picture).getByTestId('probe-caption').textContent).toBe('RUNNING')
    expect(within(picture).queryByTestId('probe-side-preview')).toBeNull()
    expect(within(picture).getAllByTestId('probe-move-label')).toHaveLength(1)
    expect(within(picture).getByTestId('probe-move-label').textContent).toMatch(/^Z- [\d.]+ mm$/)
    // The real probe is the machine's: no see-through preview probe while it runs.
    expect(within(picture).getAllByTestId('probe-side-probe')).toHaveLength(1)
    // Done steps carry ticks while it runs (3, 4 and 5 are behind it).
    for (const n of [3, 4, 5]) expect(screen.getByTestId(`probing-step-chip-${n}`).getAttribute('data-done')).toBe('true')
    expect(screen.getByTestId('probing-step-chip-6').getAttribute('aria-current')).toBe('step')
    // Stop, pressed mid-run: it stays live while the routine runs and sends the
    // app's Stop/Reset; the runner comes back stopped and the screen says where.
    const stop = screen.getByTestId('control-probe-stop') as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    await act(async () => { fireEvent.click(stop) })
    expect(stopProbing).toHaveBeenCalledTimes(1)
    expect(executeOperatorStopReset).not.toHaveBeenCalled()
    await act(async () => { finishCycle!({ ok: false, message: 'stopped', touches: {}, topMachineZ: null }) })
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 6')
  })
})

/** The machine positions a run streams, walked from the scene's own moves:
 *  since the pictures draw the runner's two passes (search, back off, slow
 *  touch) as moves of their own, every move just goes there. */
function runPathFromScene(scene: ReturnType<typeof buildProbeScene>): Array<{ x: number; y: number; z: number }> {
  const off = { x: START.x - scene.start.x, y: START.y - scene.start.y, z: START.z - scene.start.z }
  const out: Array<{ x: number; y: number; z: number }> = []
  let p = { ...START }
  const go = (to: { x: number; y: number; z: number }, n = 4) => {
    const end = { x: to.x + off.x, y: to.y + off.y, z: to.z + off.z }
    for (let i = 1; i <= n; i++) out.push({ x: p.x + (end.x - p.x) * i / n, y: p.y + (end.y - p.y) * i / n, z: p.z + (end.z - p.z) * i / n })
    p = end
  }
  for (const step of scene.steps) {
    if (step.owner !== 'machine') continue
    for (const m of step.moves) go(m.to)
  }
  return out
}

describe('WO-2063 the tracker reaches the end of every routine (audit, attempt 2)', () => {
  // Bore and Rect pocket position toward a wall and then probe on to it the
  // same way: the tracker used to stay on "toward the wall" for the rest of the run.
  for (const routine of ['bore', 'rectPocket', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'boss', 'rectBoss'] as const) {
    it(`${routine}: live progress walks every machine step in order and ends on the last`, () => {
      const scene = buildProbeScene({ ...EDGE, routine })
      let state = startTracker(scene, START)
      const seen: number[] = [state.step]
      for (const pos of runPathFromScene(scene)) {
        state = trackPosition(scene, state, pos)
        if (seen.at(-1) !== state.step) seen.push(state.step)
      }
      const machineSteps = scene.steps.flatMap((s, i) => (s.owner === 'machine' && s.moves.length ? [i] : []))
      expect(seen.map((i) => scene.steps[i].n)).toEqual(machineSteps.map((i) => scene.steps[i].n))
      const last = scene.steps[state.step]
      expect(state.move).toBe(last.moves.length - 1)
      expect(state.t).toBeCloseTo(1, 3)
    })
  }
})

describe('WO-2063 architect review after Operator\'s video check, item 2: the running probe moves smoothly', () => {
  // A screen clock: requestAnimationFrame and performance.now under the
  // test's hand, 16 ms a frame; the machine reports every third frame (the
  // kit measured ~50 ms between reports, 09-27).
  let now = 0
  let nextId = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  beforeEach(() => {
    now = 1000
    callbacks.clear()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { nextId++; callbacks.set(nextId, cb); return nextId })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id) })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const frame = () => {
    now += 16
    const due = [...callbacks.values()]
    callbacks.clear()
    for (const cb of due) cb(now)
  }

  it('Edge on the running screen: each frame the drawn probe moves a little, the way the machine moves; the step\'s start outline stays put', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    type P = { x: number; y: number; z: number }
    const drawn = (): P => {
      const [x, y, z] = (screen.getByTestId('probe-picture').getAttribute('data-real') ?? '').split(',').map(Number)
      return { x, y, z }
    }
    const outline = () => {
      const g = screen.queryByTestId('probe-picture')?.querySelector('[data-testid="probe-side-ghost"] circle, circle[data-testid="probe-side-ghost"]')
      return g ? `${g.getAttribute('cx')},${g.getAttribute('cy')}` : null
    }
    const bad: string[] = []
    const outlines = new Map<string, Set<string>>()
    // The first report comes a report's time after Start.
    for (let f = 0; f < 3; f++) await act(async () => { frame() })
    let last = drawn()
    let prevReport: P = { ...START }
    let maxStep = 0
    for (const [k, pos] of edgeRunPath().entries()) {
      await act(async () => { useMachineControl.setState({ mpos: pos }) })
      const machine = { x: pos.x - prevReport.x, y: pos.y - prevReport.y, z: pos.z - prevReport.z }
      const machineLen = Math.hypot(machine.x, machine.y, machine.z)
      for (let f = 0; f < 3; f++) {
        await act(async () => { frame() })
        const p = drawn()
        const d = { x: p.x - last.x, y: p.y - last.y, z: p.z - last.z }
        const len = Math.hypot(d.x, d.y, d.z)
        maxStep = Math.max(maxStep, len)
        // WO-2115: the top search is followed over its whole 25 mm search (the
        // drawn probe is never ahead of the machine); the top came at 10 mm, so
        // when the machine reverses off it the drawn probe glides down onto the
        // drawn top - never below it. That one report is the touch landing.
        if (k === 5) {
          if (d.z > 1e-6 || p.z < -1e-6) bad.push(`report ${k} frame ${f}: the touch landing went ${d.z > 0 ? 'up' : 'below the top'}`)
          last = p
          continue
        }
        // Never against the move the machine is making (the back-off is the
        // machine's own reversal, so it passes); never a whole report in one frame.
        if (len > 1e-6 && machineLen > 1e-6 && (d.x * machine.x + d.y * machine.y + d.z * machine.z) / (len * machineLen) < -1e-6) bad.push(`report ${k} frame ${f}: drawn against the machine`)
        if (len > machineLen * 0.5 + 1e-6) bad.push(`report ${k} frame ${f}: jumped ${len.toFixed(2)} mm of a ${machineLen.toFixed(2)} mm report`)
        const stepN = screen.getByTestId('probe-picture').getAttribute('data-step') ?? ''
        const o = outline()
        if (o) outlines.set(stepN, (outlines.get(stepN) ?? new Set()).add(o))
        last = p
      }
      prevReport = pos
    }
    expect(bad).toEqual([])
    // The drawn probe did move, and ended where the machine is.
    expect(maxStep).toBeGreaterThan(0.1)
    // One outline place per step (the step's start), however many moves it has.
    for (const [stepN, places] of outlines) expect({ stepN, places: [...places] }).toEqual({ stepN, places: [...places].slice(0, 1) })
    expect(outlines.size).toBeGreaterThan(2)
    await act(async () => { finishCycle!({ ok: false, message: 'stopped', touches: {}, topMachineZ: null }) })
  })
})

describe('WO-2063 Tool Z keeps the machine\'s pace (same fault as item 2, found checking the routines Operator has not seen)', () => {
  it('the setter trip drawn schematic follows the share of the machine\'s real distance, and counts the real millimetres', async () => {
    const scene = buildProbeScene({ ...EDGE, routine: 'toolZ', toolZ: { tool: 1, machine: { riseMm: 74, crossMm: 700, downMm: 80 } } })
    const cross = scene.steps.findIndex((s) => /^Crosses to the setter/.test(s.sentence))
    const down = scene.steps.findIndex((s) => /^Probes down/.test(s.sentence))
    let state = startTracker(scene, { x: 0, y: 0, z: 0 })
    const feed = (to: { x: number; y: number; z: number }) => { state = trackPosition(scene, state, to) }
    for (let z = 5; z <= 74; z += 5) feed({ x: 0, y: 0, z })
    feed({ x: 0, y: 0, z: 74 })
    expect(state.t).toBeCloseTo(1, 2)
    // The real crossing runs diagonally (as the kit's did: X 518, Y 474).
    const ux = 518 / 702
    const uy = 474 / 702
    for (let d = 10; d <= 350; d += 10) feed({ x: ux * d, y: uy * d, z: 74 })
    expect(state.step).toBe(cross)
    expect(state.t).toBeCloseTo(0.5, 1)
    for (let d = 360; d <= 700; d += 10) feed({ x: ux * d, y: uy * d, z: 74 })
    expect(state.step).toBe(cross)
    expect(state.t).toBeCloseTo(1, 1)
    for (let z = 72; z >= 34; z -= 2) feed({ x: ux * 700, y: uy * 700, z })
    expect(state.step).toBe(down)
    expect(state.t).toBeCloseTo(0.5, 1)
    // The picture counts the real distance still to go on the descent (~40 mm), not the drawn one.
    const { ProbeStepPicture, probeAt } = await import('../../components/machine/probing/ProbeStepPicture')
    const step = scene.steps[down]
    render(React.createElement(ProbeStepPicture, {
      scene, step, width: 1240, height: 675, progress: { move: 0, t: state.t }, touched: false, mode: 'running', real: probeAt(step, { move: 0, t: state.t }),
    }))
    const words = screen.getByTestId('probe-move-label').textContent ?? ''
    expect(Number(/([\d.]+) mm/.exec(words)?.[1])).toBeGreaterThan(35)
    expect(Number(/([\d.]+) mm/.exec(words)?.[1])).toBeLessThan(45)
  })

  it('with no recorded tool length, the rise back after the touch keeps the pace the descent measured', () => {
    // The estimate (to the search floor) is 128 mm; the machine touched after 80.
    const scene = buildProbeScene({ ...EDGE, routine: 'toolZ', toolZ: { tool: 1, machine: { riseMm: 74, crossMm: 700, downMm: 128 } } })
    const rise = scene.steps.findIndex((s) => /^Rises back/.test(s.sentence))
    let state = startTracker(scene, { x: 0, y: 0, z: 0 })
    const feed = (to: { x: number; y: number; z: number }) => { state = trackPosition(scene, state, to) }
    for (let z = 5; z <= 74; z += 5) feed({ x: 0, y: 0, z })
    feed({ x: 0, y: 0, z: 74 })
    for (let d = 10; d <= 700; d += 10) feed({ x: d, y: 0, z: 74 })
    for (let z = 72; z >= -6; z -= 2) feed({ x: 700, y: 0, z })
    feed({ x: 700, y: 0, z: -4 }) // back off
    feed({ x: 700, y: 0, z: -6 }) // slow touch
    for (let z = -4; z <= 34; z += 2) feed({ x: 700, y: 0, z })
    expect(state.step).toBe(rise)
    expect(state.t).toBeCloseTo(0.5, 1)
  })
})

describe('WO-2063 round 8 (audit): Z surface follows the machine through every mesh point', () => {
  // A 3 x 3 grid in the production order (serpentine rows), 20 mm apart.
  const POINTS = buildSurfaceMeshPoints({ minX: 0, maxX: 40, minY: 0, maxY: 40 }, 3, 3).map((p) => ({ x: p.x, y: p.y }))
  const MESH: SceneSetup = { ...EDGE, routine: 'zSurface', mesh: { points: POINTS, heightChangeMm: 5 } }

  /** The positions runSurfaceMeshProbeCycle streams, as the runner moves -
   *  not walked from the scene: point 1 searched from where the operator
   *  stood; then for every point the lift to point 1's top + clearance, the
   *  XY move, the touch (search, back off, slow touch, retract) on a surface
   *  a little higher or lower at each point; last, the final lift. */
  function meshRunPath(): Array<{ x: number; y: number; z: number }> {
    const out: Array<{ x: number; y: number; z: number }> = []
    const go = (from: { x: number; y: number; z: number }, to: Partial<{ x: number; y: number; z: number }>, n = 4) => {
      const end = { ...from, ...to }
      for (let i = 1; i <= n; i++) out.push({ x: from.x + (end.x - from.x) * i / n, y: from.y + (end.y - from.y) * i / n, z: from.z + (end.z - from.z) * i / n })
      return end
    }
    const off = { x: START.x - POINTS[0].x, y: START.y - POINTS[0].y }
    const top = -20
    const travel = top + CONFIG.surfaceClearance
    let p = { ...START }
    for (const [i, pt] of POINTS.entries()) {
      if (i > 0) {
        p = go(p, { z: travel }, 2)
        p = go(p, { x: pt.x + off.x, y: pt.y + off.y })
      }
      const surface = top + [0, 0.4, -0.3, 0.2, -0.5][i % 5]
      p = go(p, { z: surface })
      p = go(p, { z: surface + CONFIG.retract }, 2)
      p = go(p, { z: surface }, 2)
      p = go(p, { z: surface + CONFIG.retract }, 2)
    }
    go(p, { z: travel }, 2)
    return out
  }

  it('the running picture visits a probe step at every point, in order, and ends on the final rise', () => {
    const scene = buildProbeScene({ ...MESH, everyPoint: true })
    let state = startTracker(scene, START)
    const seen: number[] = [state.step]
    for (const pos of meshRunPath()) {
      state = trackPosition(scene, state, pos)
      if (seen.at(-1) !== state.step) seen.push(state.step)
    }
    const machineSteps = scene.steps.flatMap((s, i) => (s.owner === 'machine' && s.moves.length ? [i] : []))
    expect(seen.map((i) => scene.steps[i].n)).toEqual(machineSteps.map((i) => scene.steps[i].n))
    // Every point's touch is a step the picture was on.
    const touched = seen.map((i) => scene.steps[i].touch).filter((t) => t !== null).map((t) => `${t!.x},${t!.y}`)
    expect(touched).toEqual(POINTS.map((p) => `${p.x},${p.y}`))
    const last = scene.steps[state.step]
    expect(last.sentence).toMatch(/^After the last point/)
    expect(state.move).toBe(last.moves.length - 1)
    // The final lift goes to point 1's top + clearance; the last point is
    // 0.2 mm higher than point 1, so that rise is 0.2 mm shorter than drawn.
    expect(state.t).toBeCloseTo(1 - 0.2 / CONFIG.surfaceClearance, 3)
  })

  it('the preview still says the rest repeat (8 steps); the run names each point', () => {
    const preview = buildProbeScene(MESH)
    expect(preview.steps).toHaveLength(8)
    expect(preview.steps[6].sentence).toMatch(/repeat for every point \(9 in all\)/)
    const run = buildProbeScene({ ...MESH, everyPoint: true })
    // 2 YOU steps, point 1's touch and rise, three steps for each of points 2-8, point 9's move and probe, the final rise.
    expect(run.steps).toHaveLength(2 + 2 + 3 * 7 + 2 + 1)
    expect(run.steps.filter((s) => /^Probes down at point \d+ of|^Probes down at point \d+,/.test(s.sentence)).map((s) => s.sentence.match(/point (\d+)/)![1])).toEqual(['2', '3', '4', '5', '6', '7', '8', '9'])
  })
})

describe('WO-2063 round 8 (audit): after a Stop, the picture is the plan on screen', () => {
  const picture = () => {
    const p = screen.getByTestId('probe-picture')
    return {
      sentence: sentence(),
      step: p.getAttribute('data-step'),
      view: p.getAttribute('data-view'),
      mode: p.getAttribute('data-mode'),
      chips: screen.getAllByTestId(/^probing-step-chip-/).length,
    }
  }
  const runEdgeToStop = async () => {
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    for (const pos of edgeRunPath().slice(0, 5 + 2 + 2 + 2 + 5 + 5 + 3)) await act(async () => { useMachineControl.setState({ mpos: pos }) })
    expect(sentence()).toContain('Descends to probing depth')
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-stop')) })
    await act(async () => { finishCycle!({ ok: false, message: 'stopped', touches: {}, topMachineZ: null }) })
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 6')
    useMachineControl.setState({ mpos: { ...START } })
  }

  it('stop -> pick another routine: the picture is the new routine; Start follows the plan it runs', async () => {
    render(React.createElement(ProbingPanel))
    // Bore as the screen shows it before any run: step 1, and its first MACHINE step.
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    const boreFirst = picture()
    const firstMc = screen.getAllByTestId(/^probing-step-chip-/).find((c) => c.getAttribute('data-owner') === 'machine')!
    fireEvent.click(firstMc)
    const boreRunStart = picture().sentence
    await runEdgeToStop()
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    expect(picture()).toEqual(boreFirst)
    expect(screen.queryByTestId('probing-run-state')?.textContent ?? '').not.toMatch(/Stopped/)
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    expect(runFeatureProbeCycle).toHaveBeenCalledTimes(2)
    expect(picture()).toEqual(boreFirst)
    await act(async () => { useMachineControl.setState({ mpos: { ...START, z: START.z - 1 } }) })
    // The running picture is Bore's plan, on its first MACHINE step.
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('running')
    expect(sentence()).toBe(boreRunStart)
    expect(screen.getAllByTestId(/^probing-step-chip-/)).toHaveLength(boreFirst.chips)
    await act(async () => { finishCycle!({ ok: false, message: 'stopped', touches: {}, topMachineZ: null }) })
  })

  it('stop -> change a setup field: the picture redraws from the new setup', async () => {
    render(React.createElement(ProbingPanel))
    // Edge, face Y+, step 6 as the screen shows it before any run.
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y+' } })
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    const faceY = picture()
    expect(faceY.view).toBe('Y')
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'X+' } })
    await runEdgeToStop()
    expect(picture().view).toBe('X')
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y+' } })
    expect(picture()).toEqual(faceY)
    expect(screen.queryByTestId('probing-run-state')?.textContent ?? '').not.toMatch(/Stopped/)
  })
})

describe('WO-2063 round 9 (review): after a SUCCESS, the picture is the plan on screen', () => {
  const picture = () => {
    const p = screen.getByTestId('probe-picture')
    return {
      sentence: sentence(),
      step: p.getAttribute('data-step'),
      view: p.getAttribute('data-view'),
      mode: p.getAttribute('data-mode'),
      done: screen.getAllByTestId(/^probing-step-chip-/).filter((c) => c.getAttribute('data-done') === 'true').length,
    }
  }
  const runEdgeToSuccess = async () => {
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    for (const pos of edgeRunPath()) await act(async () => { useMachineControl.setState({ mpos: pos }) })
    await act(async () => { finishCycle!({ ok: true, message: 'Edge found.', touches: {}, topMachineZ: null }) })
    useMachineControl.setState({ mpos: { ...START } })
    // The finished run: every step ticked, the picture after the run.
    expect(picture().mode).toBe('after')
    expect(picture().done).toBe(screen.getAllByTestId(/^probing-step-chip-/).length)
  }

  it('success -> change a setup field: the new plan shows its before-Start preview, nothing ticked', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y+' } })
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    const faceY = picture()
    expect(faceY).toMatchObject({ step: '6', view: 'Y', mode: 'preview', done: 0 })
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'X+' } })
    await runEdgeToSuccess()
    // The everyday route: Edge on X, then Face -> Y+ to probe the next face.
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y+' } })
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    expect(picture()).toEqual(faceY)
  })

  it('success -> pick another routine: the new routine as it shows before any run', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    const boreFirst = picture()
    expect(boreFirst.done).toBe(0)
    await runEdgeToSuccess()
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    expect(picture()).toEqual(boreFirst)
  })

  it('success -> page to a step: that step\'s before-Start preview, nothing ticked (as after a Stop)', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    const edge6 = picture()
    await runEdgeToSuccess()
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    expect(picture()).toEqual(edge6)
  })

  it('success, then the program changes under it (a Z surface success re-arms it): the success stays shown', async () => {
    render(React.createElement(ProbingPanel))
    await runEdgeToSuccess()
    const after = picture()
    await act(async () => { useMachineControl.setState({ programText: 'G0 X0 Y0\nG1 X10 Y10 Z-1 F100\n' }) })
    expect(picture()).toEqual(after)
  })
})
