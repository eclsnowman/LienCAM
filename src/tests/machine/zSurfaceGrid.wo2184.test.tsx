// @vitest-environment jsdom
//
// WO-2184 - the Z surface picture shows the whole grid (Operator, 09-29: "z surface
// probe screen shows only two probes ... It should show the points mesh").
//
//  1. Before the run, every step's top view draws every grid point (5 x 5 = 25,
//     10 x 10 = 100) in the order the machine probes them (the snake), with its
//     count and spacing. Changing Points X / Y redraws it.
//  2. A run shows the 8 plan steps and a "Point k of N" counter, not a step
//     number per move.
//  3. While it runs the dots light in order, as the points are touched, and the
//     point it is on is ringed.
//  4. After it, the dots take their measured heights' colours (low / high /
//     range beside the sentence) and keep them when a step number is pressed.
//  5. Every other routine renders exactly as main does (HARD LIMIT, Operator 09-28):
//     held against src/tests/evidence/WO-2184/other-routines-main.json, written
//     from main's source (WRITE_EVIDENCE=1).
//
// Only production entry points: the Probing panel, its step card, the scene
// planner and the step tracker. The mesh runner is mocked at its boundary (the
// positions and samples it streams); the moves and compensation are untouched.

import React from 'react'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type MeshInput = Parameters<typeof import('../../lib/machine/machineSession').runSurfaceMeshProbeCycle>[0]
type MeshOnSample = NonNullable<Parameters<typeof import('../../lib/machine/machineSession').runSurfaceMeshProbeCycle>[3]>
type MeshResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runSurfaceMeshProbeCycle>>
const run = vi.hoisted(() => ({
  input: null as unknown,
  onSample: null as unknown,
  finish: null as unknown,
}))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runSurfaceMeshProbeCycle: (input, _config, _clear, onSample) => new Promise<MeshResult>((resolve) => {
      run.input = input
      run.onSample = onSample
      run.finish = resolve
    }),
  })
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { StepCard } = await import('../../components/machine/probing/ProbingScreen')
const { buildProbeScene } = await import('../../components/machine/probing/probeScene')
type SceneSetup = import('../../components/machine/probing/probeScene').SceneSetup
type ProbeScene = import('../../components/machine/probing/probeScene').ProbeScene
const { buildSurfaceMeshPoints } = await import('../../lib/machine/zSurfaceMesh')
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

// A 20 x 20 mm square cut 0.2 mm deep; the grid is its cutting area + 2 mm:
// X 8..32, Y 18..42 - 6 mm apart on a 5 x 5.
const PROGRAM = [
  'G21 G90 G54',
  'G0 X100 Y100 Z5',
  'G0 X10 Y20',
  'G1 Z-0.2 F100',
  'G1 X30 Y20 F400',
  'G1 X30 Y40',
  'G1 X10 Y40',
  'G1 X10 Y20',
  'G0 X150 Y150',
].join('\n')
const BOUNDS = { minX: 8, minY: 18, maxX: 32, maxY: 42 }
const START = { x: -50, y: -50, z: -10 }

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  run.input = null
  run.onSample = null
  run.finish = null
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 1,
    mpos: { ...START },
    wpos: { x: 0, y: 0, z: 0 },
    homed: true,
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    alarm: null,
    programText: PROGRAM,
    surfaceMesh: null,
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' },
  })
})

afterEach(() => cleanup())

const chips = () => screen.getAllByTestId(/^probing-step-chip-\d+$/)
const dots = () => [...document.querySelectorAll('[data-testid="probe-top-mesh-point"]')]
const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''

function commit(testId: string, text: string): void {
  const input = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

/** The dots in their drawn order, where each is drawn (px). */
function drawnOrder(): Array<{ order: number; cx: number; cy: number; state: string | null }> {
  return dots()
    .map((d) => ({ order: Number(d.getAttribute('data-order')), cx: Number(d.getAttribute('cx')), cy: Number(d.getAttribute('cy')), state: d.getAttribute('data-state') }))
    .sort((a, b) => a.order - b.order)
}

/** The drawn dots follow the production order: each step between two points
 *  goes the way the grid's does (X right, Y up - drawn up the screen). */
function expectSnake(nx: number, ny: number): void {
  const want = buildSurfaceMeshPoints(BOUNDS, nx, ny)
  const got = drawnOrder()
  expect(got.map((d) => d.order)).toEqual(want.map((_, i) => i + 1))
  for (let i = 1; i < want.length; i++) {
    expect(Math.sign(Math.round(got[i].cx - got[i - 1].cx))).toBe(Math.sign(Math.round(want[i].x - want[i - 1].x)))
    expect(Math.sign(Math.round(got[i - 1].cy - got[i].cy))).toBe(Math.sign(Math.round(want[i].y - want[i - 1].y)))
  }
}

describe('WO-2184 before the run: every step draws the whole grid', () => {
  it('5 x 5: 25 dots on every one of the 8 steps, in the snake order, with "5 x 5" and "6 mm"', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    expect(chips()).toHaveLength(8)
    for (const chip of chips()) {
      fireEvent.click(chip)
      expect(dots()).toHaveLength(25)
      expectSnake(5, 5)
      expect(screen.getByTestId('probe-top-mesh-count').textContent).toBe('5 x 5')
      expect(screen.getByTestId('probe-top-mesh-spacing').textContent).toBe('6 mm')
      expect(screen.getByTestId('probe-top-mesh-route')).toBeTruthy()
      // The measured area: step 1's start zone is that area, drawn once.
      expect(document.querySelectorAll('[data-testid="probe-top-mesh-area"], [data-testid="probe-top-zone"]')).toHaveLength(1)
      expect(screen.getByTestId('probe-top-mesh-cut')).toBeTruthy()
    }
    // No counter before a run: the picture says the count.
    expect(screen.queryByTestId('probing-point-counter')).toBeNull()
  })

  it('the step shows the point it is at: point 1 while it touches it, point 2 as the next', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    const ringed = () => document.querySelector('[data-testid="probe-top-mesh-current"]')?.getAttribute('data-order') ?? null
    const byStep: Record<number, string | null> = {}
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
      byStep[n] = ringed()
    }
    expect(byStep).toEqual({ 1: null, 2: null, 3: '1', 4: '1', 5: '2', 6: '2', 7: '2', 8: '25' })
    // Step 5 (to the next point): point 1 already touched, the rest waiting.
    fireEvent.click(screen.getByTestId('probing-step-chip-5'))
    expect(drawnOrder().map((d) => d.state)).toEqual(['touched', ...Array(24).fill('waiting')])
  })

  it('10 x 10 redraws as 100 dots on every step; back to 3 x 4 draws 12', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    commit('control-surface-mesh-points-x', '10')
    commit('control-surface-mesh-points-y', '10')
    expect(chips()).toHaveLength(8)
    for (const chip of chips()) {
      fireEvent.click(chip)
      expect(dots()).toHaveLength(100)
    }
    expectSnake(10, 10)
    expect(screen.getByTestId('probe-top-mesh-count').textContent).toBe('10 x 10')
    commit('control-surface-mesh-points-x', '3')
    commit('control-surface-mesh-points-y', '4')
    expect(dots()).toHaveLength(12)
    expectSnake(3, 4)
    expect(screen.getByTestId('probe-top-mesh-count').textContent).toBe('3 x 4')
    // 24 / 2 = 12 mm across, 24 / 3 = 8 mm up.
    expect(screen.getByTestId('probe-top-mesh-spacing').textContent).toBe('12 x 8 mm')
  })
})

describe('WO-2184 the run: 8 plan steps, a point counter, the dots light as the points are touched', () => {
  /** Machine positions the mesh runner streams, point by point (as the WO-2063
   *  round 8 fixture): the lift to the travel plane, the XY move, the touch
   *  (search, back off, slow touch, retract) on a surface a little higher or
   *  lower at each point. `at(k)` runs before point k's first move. */
  async function drive(points: Array<{ row: number; column: number; x: number; y: number }>, at: (k: number) => void): Promise<number[]> {
    const feed = async (p: { x: number; y: number; z: number }) => { await act(async () => { useMachineControl.setState({ mpos: { ...p } }) }) }
    const off = { x: START.x - points[0].x, y: START.y - points[0].y }
    const top = START.z - 12
    const travel = top + 5
    const heights: number[] = []
    let p = { ...START }
    const go = async (to: Partial<typeof p>, n = 2) => {
      const from = p
      const end = { ...from, ...to }
      for (let i = 1; i <= n; i++) await feed({ x: from.x + (end.x - from.x) * i / n, y: from.y + (end.y - from.y) * i / n, z: from.z + (end.z - from.z) * i / n })
      p = end
    }
    for (const [i, pt] of points.entries()) {
      at(i + 1)
      if (i > 0) {
        await go({ z: travel }, 1)
        await go({ x: pt.x + off.x, y: pt.y + off.y }, 1)
      }
      const surface = top + [0, 0.4, -0.3, 0.2, -0.5][i % 5] + i * 0.01
      await go({ z: surface })
      await go({ z: surface + 2 }, 1)
      await go({ z: surface }, 1)
      await go({ z: surface + 2 }, 1)
      heights.push(surface)
      await act(async () => { (run.onSample as MeshOnSample)({ ...pt, machineZ: surface }) })
    }
    await go({ z: travel }, 1)
    return heights
  }

  it('5 x 5 through Start probing: counter and lit dots follow the touches; after it, the heights stay', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    const input = run.input as MeshInput
    expect(input.points).toHaveLength(25)
    const seen: Array<{ k: number; counter: string; chips: number; touched: number; ringed: string | null; current: string | null }> = []
    const heights = await drive(input.points, (k) => {
      if (k === 1) return
      seen.push({
        k,
        counter: screen.getByTestId('probing-point-counter').textContent ?? '',
        chips: chips().length,
        touched: drawnOrder().filter((d) => d.state === 'touched').length,
        ringed: document.querySelector('[data-testid="probe-top-mesh-current"]')?.getAttribute('data-order') ?? null,
        current: document.querySelector('[aria-current="step"]')?.getAttribute('data-testid') ?? null,
      })
    })
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('running')
    // Before point k's first move the machine is on point k-1's last step:
    // k-1 points touched (the samples reported), point k-1 ringed, 8 chips.
    for (const s of seen) {
      expect(s.chips).toBe(8)
      expect(s.touched).toBe(s.k - 1)
      expect(s.counter).toBe(`Point ${s.k - 1} of 25`)
      expect(s.ringed).toBe(String(s.k - 1))
    }
    // The last point's rise is the 8th plan step.
    expect(sentence()).toMatch(/^After the last point/)
    expect(screen.getByTestId('probing-step-chip-8').getAttribute('aria-current')).toBe('step')
    expect(screen.getByTestId('probing-point-counter').textContent).toBe('Point 25 of 25')
    expect(drawnOrder().filter((d) => d.state === 'touched')).toHaveLength(25)
    await act(async () => {
      (run.finish as (r: MeshResult) => void)({ ok: true, message: 'Surface mesh armed: 5 x 5 points measured.', samples: [], mesh: null } as unknown as MeshResult)
    })
    // After: every dot in its measured height's colour; low / high / range.
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')
    const after = dots()
    expect(after).toHaveLength(25)
    expect(after.every((d) => d.getAttribute('data-state') === 'height')).toBe(true)
    const rel = heights.map((z) => z - heights[0])
    expect(drawnOrder().map((d) => Number(dots().find((e) => Number(e.getAttribute('data-order')) === d.order)!.getAttribute('data-height')))).toEqual(rel.map((h) => Number(h.toFixed(4))))
    expect(screen.getByTestId('probing-mesh-low').textContent).toBe(`${Math.min(...rel).toFixed(3)} mm`)
    expect(screen.getByTestId('probing-mesh-high').textContent).toBe(`+${Math.max(...rel).toFixed(3)} mm`)
    expect(screen.getByTestId('probing-mesh-range').textContent).toBe(`range ${(Math.max(...rel) - Math.min(...rel)).toFixed(3)} mm`)
    // The highest point is the amber end of the scale, the lowest the blue.
    const fillOf = (h: number) => dots()[rel.indexOf(h)].getAttribute('fill')
    expect(fillOf(Math.max(...rel))).toBe('#ffaa00')
    expect(fillOf(Math.min(...rel))).toBe('#4a90d9')
    expect(chips().every((c) => c.getAttribute('data-done') === 'true')).toBe(true)
    // A step number pressed: its preview, the heights still drawn.
    fireEvent.click(screen.getByTestId('probing-step-chip-5'))
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    expect(dots().every((d) => d.getAttribute('data-state') === 'height')).toBe(true)
    expect(screen.getByTestId('probing-mesh-range')).toBeTruthy()
    // A new grid is a new plan: no heights for it.
    commit('control-surface-mesh-points-x', '4')
    expect(dots()).toHaveLength(20)
    expect(dots().every((d) => d.getAttribute('data-state') !== 'height')).toBe(true)
    expect(screen.queryByTestId('probing-mesh-heights')).toBeNull()
  })

  it('the moves the run follows are the planner\'s, one per point: nothing about them changed', () => {
    // The run scene still has a step per move for every point (the tracker
    // follows those); only how they show changed. 3 x 3: 2 YOU, point 1's
    // touch and rise, 3 per later point less the last rise, the final rise.
    const setup = {
      routine: 'zSurface', config: resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG), tipRadiusMm: 1.5, plateMm: 0, startDistanceMm: 10, depthMm: 5,
      edgeAxis: 'X', edgeDirection: '+', cornerXDirection: '+', cornerYDirection: '+', angleNominalAxis: 'X',
      angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25, sizeXmm: 25, sizeYmm: 25, wcs: 'G54',
      mesh: { points: buildSurfaceMeshPoints(BOUNDS, 3, 3).map((p) => ({ x: p.x, y: p.y })), heightChangeMm: 5 },
    } satisfies SceneSetup
    const scene = buildProbeScene({ ...setup, everyPoint: true })
    expect(scene.steps).toHaveLength(2 + 2 + 3 * 7 + 2 + 1)
    const touches = scene.steps.filter((s) => s.touch).map((s) => `${s.touch!.x},${s.touch!.y}`)
    expect(touches).toEqual(setup.mesh.points.map((p) => `${p.x},${p.y}`))
    expect(buildProbeScene(setup).steps).toHaveLength(8)
  })

  it('a stopped or paused run names the plan step it is on - one of the 8 chips - not a per-move step', () => {
    // The review's case: a 5 x 5 run stopped (or paused) on point 14's touch,
    // per-move step 42. The line names the chip that step shows as.
    const setup = {
      routine: 'zSurface', config: resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG), tipRadiusMm: 1.5, plateMm: 0, startDistanceMm: 10, depthMm: 5,
      edgeAxis: 'X', edgeDirection: '+', cornerXDirection: '+', cornerYDirection: '+', angleNominalAxis: 'X',
      angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25, sizeXmm: 25, sizeYmm: 25, wcs: 'G54',
      mesh: { points: buildSurfaceMeshPoints(BOUNDS, 5, 5).map((p) => ({ x: p.x, y: p.y })), heightChangeMm: 5 },
    } satisfies SceneSetup
    const scene = buildProbeScene({ ...setup, everyPoint: true })
    const i = scene.steps.findIndex((s) => s.point === 14 && s.touch)
    expect(i).toBeGreaterThan(8)
    const chip = scene.steps[i].chip!
    expect(chip).toBeGreaterThanOrEqual(1)
    expect(chip).toBeLessThanOrEqual(8)
    for (const [runState, word] of [['stopped', 'Stopped'], ['paused', 'Paused']] as const) {
      const { unmount } = render(React.createElement(StepCard, {
        scene, shown: i, onShow: () => {}, live: { step: i, move: 0, t: 0.5, touched: false }, runState, confirm: null, refusal: null,
      }))
      expect(chips()).toHaveLength(8)
      expect(screen.getByTestId('probing-run-state').textContent).toBe(`${word} at step ${chip}`)
      expect(screen.getByTestId(`probing-step-chip-${chip}`)).toBeTruthy()
      expect(screen.getByTestId('probing-point-counter').textContent).toBe('Point 14 of 25')
      unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// HARD LIMIT: every other routine renders byte-identical to main.

// WO-2592: approved WO-2554 changes 24 Bore/Rect pocket wall cards; all other 178 stay identical.
const BASELINE = resolve(__dirname, '../evidence/WO-2592/baselines/WO-2184-other-routines-main.json')

function otherRoutineCards(): Record<string, string> {
  const out: Record<string, string> = {}
  render(React.createElement(ProbingPanel))
  const routines = [...document.querySelectorAll('[data-testid^="control-work-probe-routine-"]')]
    .map((b) => b.getAttribute('data-testid')!)
    .filter((id) => !id.endsWith('-zSurface'))
  for (const id of routines) {
    fireEvent.click(screen.getByTestId(id))
    for (const chip of chips()) {
      fireEvent.click(chip)
      out[`panel ${id} ${chip.getAttribute('data-testid')}`] = screen.getByTestId('probing-step-card').outerHTML
    }
  }
  cleanup()
  // The card on its own while a run is followed, stopped and done, at every
  // MACHINE step: the step numbers, ticks and words.
  const base = {
    config: resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG), tipRadiusMm: 1.5, plateMm: 0, startDistanceMm: 10, depthMm: 5,
    edgeAxis: 'X', edgeDirection: '+', cornerXDirection: '+', cornerYDirection: '+', angleNominalAxis: 'X',
    angleProbeDirection: '+', angleAlongDirection: '+', angleSpacingMm: 25, sizeXmm: 25, sizeYmm: 25, wcs: 'G54',
  } as const
  for (const routine of ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'toolZ', 'calibrate'] as const) {
    const scene: ProbeScene = buildProbeScene({ ...base, routine })
    scene.steps.forEach((s, i) => {
      if (s.owner !== 'machine') return
      for (const runState of ['running', 'stopped'] as const) {
        const { container, unmount } = render(React.createElement(StepCard, {
          scene, shown: i, onShow: () => {}, live: { step: i, move: 0, t: 0.5, touched: false }, runState, confirm: null, refusal: null,
        }))
        out[`card ${routine} ${runState} ${i}`] = container.innerHTML
        unmount()
      }
    })
    const { container, unmount } = render(React.createElement(StepCard, {
      scene, shown: scene.steps.length - 1, onShow: () => {}, live: null, runState: 'done', confirm: null, refusal: null,
    }))
    out[`card ${routine} done`] = container.innerHTML
    unmount()
  }
  return out
}

describe('WO-2184 HARD LIMIT: every other routine renders as main does', () => {
  it('every step of every other routine, before, during and after a run, is byte-identical to main', () => {
    const now = otherRoutineCards()
    if (process.env.WRITE_EVIDENCE === '1') {
      mkdirSync(dirname(BASELINE), { recursive: true })
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`)
    }
    const main = JSON.parse(readFileSync(BASELINE, 'utf-8')) as Record<string, string>
    expect(Object.keys(now).length).toBeGreaterThan(100)
    expect(Object.keys(now)).toEqual(Object.keys(main))
    for (const k of Object.keys(main)) expect(now[k], k).toBe(main[k])
  })
})
