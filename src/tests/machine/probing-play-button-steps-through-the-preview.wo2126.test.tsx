// @vitest-environment jsdom
//
// WO-2126 - a Play button steps through the routine preview (Operator, 09-28:
// "Perhaps we can make a button to simulate the probe so the user can see it
// step through them all").
//
// Through the production Probing screen (ProbingPanel), for every routine:
//  - before Start, Play walks the preview through step 1..N in order, staying
//    on each step for its own animation (a MACHINE step's preview once
//    through), and stops on the last step; nothing is sent to the machine;
//  - pressing it again, or a step number, Back or Next, stops it where it is;
//  - while a real run is followed, Play is not shown.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((r: CycleResult) => void) | null = null
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>((resolve) => { finishCycle = resolve }))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle,
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
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

// A homed GRBL-shaped machine standing over the stock (as WO-2063's tests):
// the Probing screen can plan, so Start probing is live.
const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }
// Z surface plans its grid over the loaded program (as zSurfaceMeshPanel.test).
const PROGRAM = ['G21 G90 G54', 'G0 X100 Y100 Z5', 'G0 X10 Y20', 'G1 Z-0.2 F100', 'G1 X30 Y20 F400', 'G1 X30 Y40', 'G1 X10 Y40', 'G1 X10 Y20', 'G0 X150 Y150'].join('\n')
const ROUTINES = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  __resetProbingSessionForTest()
  memory.clear()
  finishCycle = null
  runFeatureProbeCycle.mockClear()
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const current = () => Number(document.querySelector('[aria-current="step"] .pbn-chip-n')?.textContent ?? NaN)
const chipCount = () => document.querySelectorAll('[data-testid^="probing-step-chip-"]').length
const playButton = () => screen.queryByTestId('probing-step-play')
const playing = () => playButton()?.getAttribute('data-playing') === 'true'
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms) }) }

/** Runs the play-through 100 ms at a time; returns each step it showed and how long it stayed. */
async function watchPlay(limitMs = 120_000) {
  const seen: Array<{ n: number; ms: number }> = [{ n: current(), ms: 0 }]
  for (let t = 0; t < limitMs && playing(); t += 100) {
    await tick(100)
    const n = current()
    if (n === seen.at(-1)!.n) seen.at(-1)!.ms += 100
    else seen.push({ n, ms: 0 })
  }
  return seen
}

const HOVER = 'Plays the steps in the picture only - the machine does not move. Start probing runs the routine.'

describe('WO-2126 Play steps through the preview, every routine', () => {
  for (const routine of ROUTINES) {
    it(`${routine}: Play before Start runs step 1..N, each for its animation, then stops on the last; nothing moves`, async () => {
      if (routine === 'zSurface') {
        useMachineControl.setState({ programText: PROGRAM, surfaceMesh: null, job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' } })
      }
      render(React.createElement(ProbingPanel))
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      const n = chipCount()
      expect(n, 'the routine has steps').toBeGreaterThan(1)
      const play = playButton()
      expect(play, 'Play is on the step strip').not.toBeNull()
      expect(screen.getByTestId('probing-step-strip').contains(play)).toBe(true)
      // It says what it does in words, never as Start probing (Operator, 8:02 AM):
      // no play triangle, and a hover that names Start probing as the run.
      expect(play!.textContent).toBe('Preview steps')
      expect(play!.querySelector('svg'), 'words, not a play glyph').toBeNull()
      expect(play!.getAttribute('data-tooltip')).toBe(HOVER)
      const consoleBefore = useMachineControl.getState().consoleLines.length
      expect(current()).toBe(1)
      fireEvent.click(play!)
      expect(playing()).toBe(true)
      expect(playButton()!.textContent).toBe('Stop preview')
      expect(playButton()!.querySelector('svg'), 'words, not a pause glyph').toBeNull()
      expect(playButton()!.getAttribute('data-tooltip')).toBe(HOVER)
      expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
      // The picture keeps its BEFORE START strip while it plays.
      expect(screen.getByTestId('probe-caption').textContent).toBe('BEFORE START - preview (nothing moves)')
      const seen = await watchPlay()
      expect(seen.map((s) => s.n), 'every step, in order').toEqual(Array.from({ length: n }, (_, i) => i + 1))
      // Each step before the last stays for its animation (at least the
      // preview's lead and tail; a YOU step long enough to read).
      for (const s of seen.slice(0, -1)) expect(s.ms, `step ${s.n}`).toBeGreaterThanOrEqual(1500)
      // Stopped, on the last step.
      expect(playing()).toBe(false)
      expect(playButton()!.textContent).toBe('Preview steps')
      expect(current()).toBe(n)
      await tick(30_000)
      expect(current()).toBe(n)
      // A preview: no run, no motion, no console line.
      expect(runFeatureProbeCycle).not.toHaveBeenCalled()
      expect(useMachineControl.getState().consoleLines.length).toBe(consoleBefore)
      expect(useMachineControl.getState().mpos).toEqual(START)
    })
  }
})

describe('WO-2126 stopping the play-through', () => {
  it('pressing it again stops where it is; pressing again goes on from there', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    fireEvent.click(playButton()!)
    while (current() < 3) await tick(100)
    fireEvent.click(playButton()!)
    expect(playing()).toBe(false)
    await tick(30_000)
    expect(current()).toBe(3)
    fireEvent.click(playButton()!)
    expect(current()).toBe(3)
    while (current() === 3) await tick(100)
    expect(current()).toBe(4)
  })

  it('a step number, Back or Next stops it where it is', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    for (const [control, lands] of [['probing-step-chip-4', 4], ['probing-step-back', 1], ['probing-step-next', 3]] as const) {
      fireEvent.click(screen.getByTestId('probing-step-chip-1'))
      fireEvent.click(playButton()!)
      while (current() < 2) await tick(100)
      fireEvent.click(screen.getByTestId(control))
      expect(playing(), control).toBe(false)
      expect(current(), control).toBe(lands)
      await tick(30_000)
      expect(current(), control).toBe(lands)
    }
  })

  it('on the last step, Play starts again from step 1', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    const n = chipCount()
    fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
    fireEvent.click(playButton()!)
    expect(current()).toBe(1)
    expect(playing()).toBe(true)
  })

  it('picking another routine stops it', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(playButton()!)
    while (current() < 2) await tick(100)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    expect(playing()).toBe(false)
    expect(current()).toBe(1)
    await tick(30_000)
    expect(current()).toBe(1)
  })
})

describe('WO-2126 while a real run is live', () => {
  it('the running follow owns the picture: Play is not shown, and a play-through in progress stops', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    fireEvent.click(playButton()!)
    while (current() < 2) await tick(100)
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
    // WO-2557: publishing a running picture requires a machine report of actual movement.
    await act(async () => { useMachineControl.setState({ mpos: { ...START, z: START.z - 4 } }) })
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('running')
    expect(playButton()).toBeNull()
    const followed = current()
    await tick(30_000)
    expect(current()).toBe(followed)
    // The run ends: Play is back, not playing.
    await act(async () => { finishCycle?.({ ok: false, message: 'Stopped.' } as unknown as CycleResult) })
    expect(playButton()).not.toBeNull()
    expect(playing()).toBe(false)
  })
})
