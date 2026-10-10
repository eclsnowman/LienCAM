// @vitest-environment jsdom
//
// WO-2176 - CALIBRATE IS THE BOSS AND BORE SCREENS, SET UP FOR CALIBRATION.
//
// Operator ruling 2026-09-28: "Aren't the two calibrate screens we're talking about
// almost identically a boar and a boss screen. Why wouldn't you just reuse
// those but set things up for calibration versus measurement?" ... "just don't
// touch them" (the other probing screens).
//
// Calibrate on an outside reference (a 25.000 gauge pin) draws exactly Boss's
// screen for a 25.000 boss, and on an inside one (a 30.000 ring gauge) exactly
// Bore's for a 30.000 bore: the same picture, dimensions, labels, step strip
// and picture key at every step. What differs is only the words that name the
// reference and the Confirm it ends in, and the setup rows on the left.
// WO-2284 additionally changes only Boss's four face sentences below the
// pictures. Calibrate retains its original face sentences exactly.
//
// Route: the scene the Probing screen draws (buildProbeScene), then the
// production Probing panel itself (ProbingPanel), every step, comparing the
// rendered picture / strip / key markup Boss vs Calibrate and Bore vs
// Calibrate. Negative control in-file: a 25.500 pin against the 25.000 boss
// must differ (the comparison can see a changed drawing).

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { buildProbeScene, type SceneSetup } from '../../components/machine/probing/probeScene'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { __resetCalibrationReferencesForTest } = await import('../../components/machine/probing/calibrationReferences')
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

// --- the scene ---------------------------------------------------------------

const SETUP: SceneSetup = {
  routine: 'boss',
  config: resolveProbeConfig(null, null),
  tipRadiusMm: 1.55,
  plateMm: 0,
  startDistanceMm: 5,
  depthMm: 5,
  edgeAxis: 'X',
  edgeDirection: '+',
  cornerXDirection: '+',
  cornerYDirection: '+',
  angleNominalAxis: 'X',
  angleProbeDirection: '+',
  angleAlongDirection: '+',
  angleSpacingMm: 25,
  sizeXmm: 25,
  sizeYmm: 25,
  wcs: 'G54',
}

/** Every path where two plain values differ. */
function differences(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return []
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return [path]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`))
}

/** What the scene draws: everything but the routine's name and its sentences. */
function drawn(scene: ReturnType<typeof buildProbeScene>) {
  return { ...scene, routine: null, steps: scene.steps.map((s) => ({ ...s, sentence: null })) }
}

describe('WO-2176 Calibrate\'s scene is Boss\'s / Bore\'s scene', () => {
  it('a 25.000 gauge pin draws the 25.000 boss; reference, Confirm and WO-2284 face words alone differ', () => {
    const boss = buildProbeScene(SETUP)
    const pin = buildProbeScene({ ...SETUP, routine: 'calibrate', calibration: { kind: 'outside', diameterMm: 25, tool: 'T20' } })
    expect(pin.steps.length).toBe(boss.steps.length)
    expect(differences(drawn(boss), drawn(pin))).toEqual([])
    const words = boss.steps.map((s, i) => [s.sentence, pin.steps[i].sentence]).filter(([a, b]) => a !== b)
    expect(words).toEqual([
      ['Jog over the middle of the boss (by eye is fine), less than 25 mm above the top.',
        'Jog over the middle of the reference (by eye is fine), less than 25 mm above the top.'],
      ['Press Start probing to run Boss.', 'Press Start probing to run Calibrate.'],
      // Exact WO-2284 exception: Boss gains the outside-face explanation;
      // Calibrate keeps the main words. No sentence is removed from comparison.
      ...([
        ['Right face: steps out X+ 19.1 mm', 'X-'],
        ['Left face: steps out X- 35.1 mm', 'X+'],
        ['Back face: steps out Y+ 24.9 mm', 'Y-'],
        ['Front face: steps out Y- 35.1 mm', 'Y+'],
      ] as const).map(([lead, direction]) => [
        `${lead}; comes down with probe centre 6.5 mm outside the face (Tip radius 1.6 mm + Clearance 5 mm; Clearance sets it).`,
        `${lead}, descends to probing depth, probes ${direction} until it touches (fast, then slow), backs off and rises.`,
      ]),
      [boss.steps.at(-2)!.sentence, boss.steps.at(-2)!.sentence.replace(/ Shows [^.]*\.$/, ' Shows the X and Y radius it found.')],
      ['Press Confirm to set X0 Y0 on the centre (G54).', 'Press Confirm to write the X and Y radius to T20.'],
    ])
  })

  it('a 30.000 ring gauge draws the 30.000 bore; only the words naming the reference and the Confirm differ', () => {
    const bore = buildProbeScene({ ...SETUP, routine: 'bore', sizeXmm: 30, sizeYmm: 30 })
    const ring = buildProbeScene({ ...SETUP, routine: 'calibrate', sizeXmm: 30, sizeYmm: 30, calibration: { kind: 'inside', diameterMm: 30, tool: null } })
    expect(ring.steps.length).toBe(bore.steps.length)
    expect(differences(drawn(bore), drawn(ring))).toEqual([])
    const changed = bore.steps.map((s, i) => [s.sentence, ring.steps[i].sentence]).filter(([a, b]) => a !== b)
    expect(changed.map(([a]) => a)).toEqual([
      bore.steps[0].sentence,
      'Press Start probing to run Bore.',
      bore.steps.at(-2)!.sentence,
      'Press Confirm to set X0 Y0 on the centre (G54).',
    ])
    expect(changed.map(([, b]) => b)).toEqual([
      bore.steps[0].sentence.replace('middle of the bore', 'middle of the reference'),
      'Press Start probing to run Calibrate.',
      bore.steps.at(-2)!.sentence.replace(/ Shows [^.]*\.$/, ' Shows the X and Y radius it found.'),
      'Press Confirm to write the X and Y radius to the loaded Probe tool.',
    ])
  })

  it('negative control: a 25.500 pin is NOT the 25.000 boss (the comparison sees a changed drawing)', () => {
    const boss = buildProbeScene(SETUP)
    const pin = buildProbeScene({ ...SETUP, routine: 'calibrate', calibration: { kind: 'outside', diameterMm: 25.5, tool: 'T20' } })
    expect(differences(drawn(boss), drawn(pin)).length).toBeGreaterThan(0)
  })
})

// --- the production Probing panel ---------------------------------------------

beforeEach(() => {
  __resetProbingSessionForTest()
  __resetCalibrationReferencesForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

const markup = (testId: string) => ((screen.queryByTestId(testId)?.outerHTML ?? '')
  // The top view's clip-path id carries the routine's key; it draws nothing.
  .replace(/pbn-top-clip-[A-Za-z]+/g, 'pbn-top-clip-X'))

/** Every step of the routine shown: its picture, strip and key markup (the key
 *  sits in the Control page's right column, when that is rendered), and its sentence. */
function walk(): Array<{ picture: string; strip: string; key: string; captions: string; sentence: string }> {
  const count = screen.queryAllByTestId(/^probing-step-chip-\d+$/).length
  const out = []
  for (let n = 1; n <= count; n++) {
    fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
    out.push({
      picture: markup('probing-picture-box'),
      strip: markup('probing-step-strip'),
      key: markup('probing-picture-key'),
      captions: `${screen.getByTestId('probing-caption-side').textContent} / ${screen.getByTestId('probing-caption-top').textContent}`,
      sentence: screen.getByTestId('probing-step-sentence').textContent ?? '',
    })
  }
  return out
}

function typeDim(testId: string, value: string): void {
  const input = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function routine(kind: string): void {
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`))
}

/** The setup rows on the left, by label. */
function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('.pbn-setup-row'))
    .map((row) => row.querySelector('.pbn-setup-label, label, span')?.textContent?.trim() ?? row.textContent?.trim() ?? '')
    .filter(Boolean)
}

function reference(kind: 'outside' | 'inside', diameter: string): void {
  routine('calibrate')
  fireEvent.change(screen.getByTestId('control-calibrate-reference-kind'), { target: { value: kind } })
  typeDim('control-calibrate-reference-diameter', diameter)
}

describe('WO-2176 on the Probing screen: every Calibrate step is the Boss / Bore step', () => {
  it('a 25.000 gauge pin vs a 25.000 boss: picture, dimensions, strip and key identical at every step', () => {
    render(React.createElement(ProbingPanel))
    routine('boss')
    typeDim('control-work-probe-nominal-diameter', '25')
    const boss = walk()
    reference('outside', '25')
    const pin = walk()
    expect(boss.length).toBeGreaterThan(5)
    expect(boss[0].picture).toContain('<svg')
    expect(boss[0].picture).toContain('Ø 25')
    expect(pin.map(({ sentence: _s, ...rest }) => rest)).toEqual(boss.map(({ sentence: _s, ...rest }) => rest))
    expect(pin[0].sentence).toBe(boss[0].sentence.replace('middle of the boss', 'middle of the reference'))
  })

  it('a 30.000 ring gauge vs a 30.000 bore: picture, dimensions, strip and key identical at every step', () => {
    render(React.createElement(ProbingPanel))
    routine('bore')
    typeDim('control-work-probe-nominal-diameter', '30')
    const bore = walk()
    reference('inside', '30')
    const ring = walk()
    expect(bore.length).toBeGreaterThan(5)
    expect(bore[0].picture).toContain('Ø 30')
    expect(ring.map(({ sentence: _s, ...rest }) => rest)).toEqual(bore.map(({ sentence: _s, ...rest }) => rest))
    expect(ring[0].sentence).toBe(bore[0].sentence.replace('middle of the bore', 'middle of the reference'))
  })

  it('negative control: a 25.500 pin against the 25.000 boss differs in the picture', () => {
    render(React.createElement(ProbingPanel))
    routine('boss')
    typeDim('control-work-probe-nominal-diameter', '25')
    const boss = walk()
    reference('outside', '25.5')
    const pin = walk()
    expect(pin.filter((s, i) => s.picture !== boss[i].picture).length).toBeGreaterThan(0)
  })

  it('the setup rows: the reference rows stand where Boss / Bore have Nominal diameter; the rest are theirs', () => {
    render(React.createElement(ProbingPanel))
    routine('boss')
    const boss = rowLabels()
    reference('outside', '25')
    const pin = rowLabels()
    routine('bore')
    const bore = rowLabels()
    reference('inside', '30')
    const ring = rowLabels()
    // (Add reference is a button row with no label; it follows Diameter.)
    const REFERENCE_ROWS = ['Reference', 'Name', 'Kind', 'Diameter (mm)']
    // Decide-and-log (WO-2176 result): Calibrate writes no work offset and
    // measures the bare probe on the reference, so Boss's / Bore's Work offset
    // and Sensed by rows are not on it (WO-2166, unchanged).
    const NOT_ON_CALIBRATE = ['Nominal diameter (mm)', 'Sensed by', 'Work offset']
    expect(pin).toEqual([...REFERENCE_ROWS, ...boss.filter((r) => !NOT_ON_CALIBRATE.includes(r))])
    expect(ring).toEqual([...REFERENCE_ROWS, ...bore.filter((r) => !NOT_ON_CALIBRATE.includes(r))])
    expect(screen.getByTestId('control-calibrate-reference-add').textContent).toBe('Add reference')
    expect(boss).toContain('Nominal diameter (mm)')
    expect(bore).toContain('Nominal diameter (mm)')
  })
})
