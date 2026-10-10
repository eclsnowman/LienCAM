// @vitest-environment jsdom
//
// WO-2127 - the Probing pictures are named by the real view they draw
// (Operator ruling 2026-09-28: "we call front view side view on corner probe ... and
// then we have a second side view but it is right view").
//
// The side drawing puts the view's axis to the right and Z up (ProbeStepPicture
// maps u -> x with a positive scale): along X that is the Front view (looking
// toward +Y), along Y the Right view (looking toward -X, +Y to the right). The
// plan drawing is the Top view. Words only; the drawings do not change.

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
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

beforeEach(() => {
  __resetProbingSessionForTest()
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

const ROUTINES = ['workZero', 'edge', 'outsideCorner', 'insideCorner', 'angle', 'bore', 'boss', 'rectPocket', 'rectBoss', 'zSurface', 'toolZ'] as const
const REAL_VIEW: Record<string, string> = { X: 'Front view', Y: 'Right view' }

const sideCaption = () => screen.getByTestId('probing-caption-side').textContent
const topCaption = () => screen.getByTestId('probing-caption-top').textContent
const drawnView = () => screen.getByTestId('probe-picture').getAttribute('data-view') ?? ''
const sentence = () => screen.getByTestId('probing-step-sentence').textContent ?? ''

/** Every step of the routine shown: its captions and the view it draws. */
function walk(): Array<{ n: number; side: string | null; top: string | null; view: string; sentence: string }> {
  const out: Array<{ n: number; side: string | null; top: string | null; view: string; sentence: string }> = []
  const count = screen.queryAllByTestId(/^probing-step-chip-\d+$/).length
  for (let n = 1; n <= count; n++) {
    fireEvent.click(screen.getByTestId(`probing-step-chip-${n}`))
    out.push({ n, side: sideCaption(), top: topCaption(), view: drawnView(), sentence: sentence() })
  }
  return out
}

describe('WO-2127 the Probing pictures are named by their real view', () => {
  it('Outside corner (Operator\'s screenshots): step 4 is the Front view, step 5 the Right view', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-outsideCorner'))
    const steps = walk()
    expect(steps[3]).toMatchObject({ view: 'X', side: 'Front view', top: 'Top view' })
    expect(steps[4]).toMatchObject({ view: 'Y', side: 'Right view', top: 'Top view' })
  })

  it('every step of every routine: the caption names the view the picture draws; no "side view" is left', () => {
    render(React.createElement(ProbingPanel))
    const seen = new Set<string>()
    const bad: string[] = []
    let shownSteps = 0
    for (const routine of ROUTINES) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      if (!screen.queryByTestId('probing-caption-side')) continue
      for (const s of walk()) {
        shownSteps++
        seen.add(s.side ?? '')
        if (s.side !== REAL_VIEW[s.view] || s.top !== 'Top view') bad.push(`${routine} step ${s.n} (${s.view}): "${s.side}" / "${s.top}" - ${s.sentence}`)
      }
    }
    expect(bad).toEqual([])
    expect(shownSteps).toBeGreaterThan(50)
    // Both side views occur somewhere, and nothing reads "side view".
    expect([...seen].sort()).toEqual(['Front view', 'Right view'])
    expect(document.body.textContent ?? '').not.toMatch(/side view/i)
  })

  it('Edge on a Y face looks along Y: every step is the Right view; on an X face, the Front view', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    const face = screen.getByTestId('control-work-probe-edge-face')
    for (const [value, name] of [['Y+', 'Right view'], ['Y-', 'Right view'], ['X+', 'Front view'], ['X-', 'Front view']] as const) {
      fireEvent.change(face, { target: { value } })
      expect(new Set(walk().map((s) => s.side))).toEqual(new Set([name]))
    }
  })
})
