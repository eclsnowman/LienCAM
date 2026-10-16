// @vitest-environment jsdom
//
// WO-2180 - Tool Z: a round gold setter, a plain start sentence, and a
// Preview steps that plays once and stops (Operator, 09-29: "tool z probe preview
// keeps repeating step 6 over and over after preview. And it says no jogging.
// So does it assume you already set wcs zero via Z0 probe routine? If so how
// does the user know that? Also show the toolsetter as round, not square.
// Round is more common. And make it that yellow/gold look").
//
// Through the production Probing screen (ProbingPanel):
//  - the setter is a circle in the top view and its profile in the front
//    view, both in the gold of a round feature's rim (the Boss ring's stroke,
//    read from the Boss picture itself); no square setter;
//  - step 1's sentence says Tool Z goes to the setter's saved position and
//    measures the tool, and that work Z0 is not needed or changed - briefly;
//  - Preview steps shows step 1..6 once, in order, and holds step 6 still
//    after it stops (the preview's animation on a fake clock, as the browser);
//  - every other routine: each step's picture and sentence is main's, byte
//    for byte (hashes recorded from main's code into
//    src/tests/evidence/WO-2180/pictures.main.json; WRITE_EVIDENCE=1
//    re-records them). Their preview sequences are held to main's by
//    anglePreviewStepsOnce.wo2178.test.tsx.

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

// As WO-2178's test: a homed GRBL-shaped machine standing over the stock.
const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }
const PROGRAM = ['G21 G90 G54', 'G0 X100 Y100 Z5', 'G0 X10 Y20', 'G1 Z-0.2 F100', 'G1 X30 Y20 F400', 'G1 X30 Y40', 'G1 X10 Y40', 'G1 X10 Y20', 'G0 X150 Y150'].join('\n')
const OTHERS = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'calibrate'] as const
const PICTURES = join(process.cwd(), 'src/tests/evidence/WO-2180/pictures.main.json')
// WO-2554 changes only the four wall steps of these inside features.
const INSIDE_PICTURES = join(process.cwd(), 'src/tests/evidence/WO-2554/pictures.seek-only.json')
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
const chips = () => document.querySelectorAll('[data-testid^="probing-step-chip-"]').length
const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''

function open(routine: string): void {
  if (routine === 'zSurface') {
    useMachineControl.setState({ programText: PROGRAM, surfaceMesh: null, job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' } })
  }
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
}

/** Each step's picture and sentence, as the screen draws it on picking it. */
function pictures(routine: string): string[] {
  open(routine)
  const out: string[] = []
  for (let n = 1; n <= chips(); n++) {
    fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
    const pic = screen.getByTestId('probe-picture').outerHTML
    out.push(`${n}|${createHash('sha1').update(pic).digest('hex').slice(0, 12)}|${sentence()}`)
  }
  cleanup()
  return out
}

describe('WO-2180 Tool Z draws a round gold setter', () => {
  it('top view: the setter is a circle in the Boss ring\'s gold; front view: its profile in the same gold; no square setter', () => {
    // The gold of a round feature: the Boss picture's own rim.
    open('boss')
    const rim = screen.getByTestId('probe-top-view').querySelector('[data-testid="probe-top-face"]')!
    const gold = rim.getAttribute('stroke')
    expect(gold).toBeTruthy()
    cleanup()

    open('toolZ')
    for (let n = 1; n <= chips(); n++) {
      fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
      const top = screen.getByTestId('probe-top-view')
      const side = screen.getByTestId('probe-side-view')
      // Top view: one gold circle, filled in the setter's gold; no square.
      const setters = top.querySelectorAll('circle.pbn-setter')
      expect(setters.length, `step ${n}: a round setter from above`).toBe(1)
      expect(setters[0].getAttribute('stroke'), `step ${n}: in the Boss ring's gold`).toBe(gold)
      expect(top.querySelectorAll('rect.pbn-setter').length).toBe(0)
      // Nothing square the setter's size: only the part (wide) is a rect.
      const small = Array.from(top.querySelectorAll('rect.control-probe-diagram-stock'))
        .filter((r) => Number(r.getAttribute('width')) < 200 && Number(r.getAttribute('height')) < 200)
      expect(small.length, `step ${n}: no square setter`).toBe(0)
      // Front view: the setter's profile (a round setter seen from the
      // front), in the setter's gold.
      const profile = side.querySelectorAll('rect.pbn-setter')
      expect(profile.length, `step ${n}: the setter's profile in front`).toBe(1)
    }
  })
})

describe('WO-2180 Tool Z step 1 says what it uses', () => {
  it('goes to the setter\'s saved position and measures the tool; work Z0 is not needed or changed - briefly', () => {
    open('toolZ')
    fireEvent.click(screen.getByTestId('probing-step-chip-1'))
    const s = sentence()
    expect(s).toMatch(/saved setter/)
    expect(s).toMatch(/measures its length/)
    expect(s).toMatch(/without using or changing work Z0/)
    expect(s).not.toMatch(/no jogging/i)
    // Operator: "don't be verbose".
    expect(s.split(/\s+/).length).toBeLessThanOrEqual(32)
  })
})

interface Frame { step: number; playing: boolean; preview: string; move: string; picture: string }

async function tracePreview(routine: string): Promise<Frame[]> {
  open(routine)
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

describe('WO-2180 Tool Z: Preview steps goes through each step once', () => {
  it('shows step 1..6 once, in order, then ends on step 6 held still - step 6 does not play again', async () => {
    const frames = await tracePreview('toolZ')
    const last = 6
    const order = frames.map((f) => f.step).filter((n, i, a) => i === 0 || a[i - 1] !== n)
    expect(order).toEqual(Array.from({ length: last }, (_, i) => i + 1))
    const end = frames.findIndex((f) => !f.playing)
    expect(end, 'the play-through stops').toBeGreaterThan(0)
    const stepLast = frames.slice(0, end).filter((f) => f.step === last)
    expect(stepLast.some((f) => f.preview === 'playing'), 'step 6 plays during the play-through').toBe(true)
    const after = frames.slice(end)
    expect(after.length).toBeGreaterThanOrEqual(AFTER_MS / STEP_MS)
    expect(new Set(after.map((f) => f.step))).toEqual(new Set([last]))
    expect(new Set(after.map((f) => f.preview)), 'held still after the play-through').toEqual(new Set(['still']))
    expect(new Set(after.map((f) => f.picture)).size, 'the picture does not move after the play-through').toBe(1)
    expect(after[0].move).toBe(stepLast.at(-1)!.move)
  }, 60_000)

  it('picking step 6 after the play-through plays its preview again, as picking a step always does', async () => {
    open('toolZ')
    fireEvent.click(screen.getByTestId('probing-step-play'))
    while (playing()) await act(async () => { vi.advanceTimersByTime(STEP_MS) })
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(screen.getByTestId('probe-picture').getAttribute('data-preview')).toBe('still')
    fireEvent.click(screen.getByTestId('probing-step-chip-6'))
    const seen = new Set<string>()
    for (let t = 0; t < 30_000; t += STEP_MS) {
      await act(async () => { vi.advanceTimersByTime(STEP_MS) })
      seen.add(screen.getByTestId('probe-picture').getAttribute('data-preview') ?? '')
    }
    expect(seen.has('start') && seen.has('playing'), [...seen].join(',')).toBe(true)
  }, 60_000)
})

// WO-2665's explicitly changed setup wording; preserve the recorded SVG hashes
// and all other step sentences. Do not regenerate or weaken picture baselines.
const briefSetupWords = (row: string): string => row
  .replace('Set Z0 on this part first (G54): the probe descends from it. Then jog', 'Set part Z0 (G54), then jog')
  .replace(' (by eye is fine)', '')
  .replace('Load the program. Jog up to a safe start height, clear of the clamps and less than 50 mm above the top. The routine moves over point 1 itself.', 'Load the program; jog up clear of the clamps, less than 50 mm above the top.')

describe('WO-2180/2554 other pictures retain main or the approved seek-only walls, byte for byte', () => {
  for (const routine of OTHERS) {
    it(`${routine}: every step's picture and sentence match the recorded sequence`, () => {
      const got = pictures(routine)
      const path = routine === 'bore' || routine === 'rectPocket' ? INSIDE_PICTURES : PICTURES
      const recorded = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>) : {}
      if (process.env.WRITE_EVIDENCE === '1') {
        writeFileSync(path, JSON.stringify({ ...recorded, [routine]: got }, null, 1) + '\n')
        return
      }
      expect(recorded[routine], 'recorded picture sequence').toBeDefined()
      expect(got.length).toBeGreaterThan(1)
      expect(got).toEqual(recorded[routine].map((row, i) => i === 0 ? briefSetupWords(row) : row))
      if (path === INSIDE_PICTURES) {
        const main = JSON.parse(readFileSync(PICTURES, 'utf8')) as Record<string, string[]>
        // Setup, descent, rise and confirmation remain byte-identical to main.
        for (const i of [0, 1, 2, 7, 8]) expect(got[i]).toBe(i === 0 ? briefSetupWords(main[routine][i]) : main[routine][i])
      }
    })
  }
})
