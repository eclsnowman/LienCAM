// @vitest-environment jsdom
//
// WO-2178 - Angle's Preview steps goes through each step once (Operator, 09-29:
// "angle probing preview keeps repeating step 5").
//
// Through the production Probing screen (ProbingPanel), with the preview's
// animation running (requestAnimationFrame on a fake clock, as the browser):
//  - Angle: Preview steps shows step 1..5 once, in order, and ends on step 5
//    holding its picture still, as the other routines end - step 5's
//    animation does not start again after the play-through has stopped;
//  - every other routine: the whole preview, frame by frame, during the
//    play-through and for 20 s after it, is identical to main's (a trace
//    recorded from main's ProbingScreen.tsx, src/tests/evidence/WO-2178/
//    preview-trace.main.json; WRITE_EVIDENCE=1 re-records it).

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'

const runFeatureProbeCycle = vi.fn(() => new Promise(() => {}))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: runFeatureProbeCycle as never,
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

// As WO-2126's test: a homed GRBL-shaped machine standing over the stock.
const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }
const PROGRAM = ['G21 G90 G54', 'G0 X100 Y100 Z5', 'G0 X10 Y20', 'G1 Z-0.2 F100', 'G1 X30 Y20 F400', 'G1 X30 Y40', 'G1 X10 Y40', 'G1 X10 Y20', 'G0 X150 Y150'].join('\n')
const OTHERS = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const
const TRACE = join(process.cwd(), 'src/tests/evidence/WO-2178/preview-trace.main.json')
// WO-2554 changes only Bore / Rect pocket wall steps. Keep every other
// routine on its original main baseline; retain full inside preview traces.
const INSIDE_TRACE = join(process.cwd(), 'src/tests/evidence/WO-2554/preview-trace.seek-only.json')
const AFTER_MS = 20_000
const STEP_MS = 100

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
  __resetProbingSessionForTest()
  memory.clear()
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
const playing = () => screen.queryByTestId('probing-step-play')?.getAttribute('data-playing') === 'true'

interface Frame { step: number; playing: boolean; preview: string; move: string; picture: string }

/** Presses Preview steps and samples the screen every 100 ms: through the
 *  play-through, then 20 s after it stopped. */
async function tracePreview(routine: string): Promise<Frame[]> {
  if (routine === 'zSurface') {
    useMachineControl.setState({ programText: PROGRAM, surfaceMesh: null, job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' } })
  }
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
  fireEvent.click(screen.getByTestId('probing-step-play'))
  const frames: Frame[] = []
  let endedAt = -1
  for (let t = 0; t < 180_000; t += STEP_MS) {
    await act(async () => { vi.advanceTimersByTime(STEP_MS) })
    const pic = screen.getByTestId('probe-picture')
    frames.push({
      step: current(),
      playing: playing(),
      preview: pic.getAttribute('data-preview') ?? '',
      move: pic.getAttribute('data-move') ?? '',
      picture: createHash('sha1').update(pic.outerHTML).digest('hex').slice(0, 10),
    })
    if (!playing() && endedAt < 0) endedAt = t
    if (endedAt >= 0 && t - endedAt >= AFTER_MS) break
  }
  cleanup()
  return frames
}

const key = (f: Frame) => `${f.step}|${f.playing ? 'P' : '-'}|${f.preview}|${f.move}|${f.picture}`

describe('WO-2178 Angle: Preview steps goes through each step once', () => {
  it('shows step 1..5 once, in order, then ends on step 5 held still - step 5 does not play again', async () => {
    const frames = await tracePreview('angle')
    const chips = 5
    // Every step once, in order.
    const order = frames.map((f) => f.step).filter((n, i, a) => i === 0 || a[i - 1] !== n)
    expect(order).toEqual(Array.from({ length: chips }, (_, i) => i + 1))
    const end = frames.findIndex((f) => !f.playing)
    expect(end, 'the play-through stops').toBeGreaterThan(0)
    // Step 5 played its animation during the play-through...
    const step5 = frames.slice(0, end).filter((f) => f.step === chips)
    expect(step5.some((f) => f.preview === 'playing')).toBe(true)
    // ...and once it has stopped, 20 s of the same held picture: never the
    // loop's start again, never moving.
    const after = frames.slice(end)
    expect(after.length).toBeGreaterThanOrEqual(AFTER_MS / STEP_MS)
    expect(new Set(after.map((f) => f.step))).toEqual(new Set([chips]))
    expect(new Set(after.map((f) => f.preview)), 'held still after the play-through').toEqual(new Set(['still']))
    expect(new Set(after.map((f) => f.picture)).size, 'the picture does not move after the play-through').toBe(1)
    // Held on step 5's end: its last move done.
    expect(after[0].move).toBe(step5.at(-1)!.move)
  }, 60_000)

  it('picking step 5 after the play-through plays its preview again, as picking a step always does', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    fireEvent.click(screen.getByTestId('probing-step-play'))
    while (playing()) await act(async () => { vi.advanceTimersByTime(STEP_MS) })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.getByTestId('probe-picture').getAttribute('data-preview')).toBe('still')
    fireEvent.click(screen.getByTestId('probing-step-chip-5'))
    const seen = new Set<string>()
    for (let t = 0; t < 30_000; t += STEP_MS) {
      await act(async () => { vi.advanceTimersByTime(STEP_MS) })
      seen.add(screen.getByTestId('probe-picture').getAttribute('data-preview') ?? '')
    }
    expect(seen.has('start') && seen.has('playing'), [...seen].join(',')).toBe(true)
  }, 60_000)

  it('the play-through itself is main\'s, frame for frame, up to where it stops', async () => {
    const recorded = existsSync(TRACE) ? (JSON.parse(readFileSync(TRACE, 'utf8')) as Record<string, string[]>) : {}
    const frames = (await tracePreview('angle')).map(key)
    if (process.env.WRITE_EVIDENCE === '1') {
      writeFileSync(TRACE, JSON.stringify({ ...recorded, angle: frames }, null, 1) + '\n')
      return
    }
    const main = recorded.angle
    expect(main, 'trace recorded from main').toBeDefined()
    const end = main.findIndex((k) => k.split('|')[1] === '-')
    expect(end).toBeGreaterThan(0)
    expect(frames.slice(0, end)).toEqual(main.slice(0, end))
  }, 60_000)
})

describe('WO-2178/2554 other previews retain main or the approved seek-only sequence, frame for frame', () => {
  for (const routine of OTHERS) {
    it(`${routine}: the play-through and 20 s after it match the recorded trace`, async () => {
      const frames = (await tracePreview(routine)).map(key)
      const path = routine === 'bore' || routine === 'rectPocket' ? INSIDE_TRACE : TRACE
      const recorded = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>) : {}
      if (process.env.WRITE_EVIDENCE === '1') {
        writeFileSync(path, JSON.stringify({ ...recorded, [routine]: frames }, null, 1) + '\n')
        return
      }
      expect(recorded[routine], 'recorded preview trace').toBeDefined()
      expect(frames).toEqual(recorded[routine])
    }, 60_000)
  }
})
