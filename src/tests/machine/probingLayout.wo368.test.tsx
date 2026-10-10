// @vitest-environment jsdom
//
// WO-368: the probing screen must fit without scrolling. Operator's own words,
// annotated onto his screenshot (card verdict
// Q-THE-PROBING-DIAGRAM-YOU-KEPT-ASK-1786639290799): "We cannot have the
// probe screen require scroll... it must fit without scrolling with extra
// room if we add more capability." jsdom does not lay out real pixels, so
// the actual "no scrollbar" claim is proven live, from the running app
// (Tier 2 evidence - src/tests/evidence/WO-368/). What THIS file proves is
// the structural claim underneath that evidence: the diagram and the
// routine's own controls sit in ONE region together (control-probing-
// columns), with no new inner scroller of this WO's own making between
// them, and nothing WO-304 put on screen (machine position, homed state,
// the target work offset) left when the layout changed.
//
// WO-2063 (docs/design/PROBING-SCREEN-V2.md, Operator's 09-27 wireframe) rebuilt
// the station as three columns: Main's Position panel, the routine and its
// setup on the left; the one step card (pictures, sentence, step numbers) in
// the middle; Jog, Picture key / More and E-STOP, Start probing and Stop on
// the right. The WO-368 claims are re-pinned against that layout; the old
// diagram column, manual touches card and Feed Hold / Restart probe / Run
// Tool Z cluster are retired with the screen they belonged to.

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expectOneEstopControl } from './support/estopControl'

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling probe
// tests use (probingPanel.wo297.test.tsx, probingMachineState.wo304.test.tsx).
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
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    mpos: { x: 100, y: 50, z: 10 },
    wpos: { x: 0, y: 0, z: 0 },
    homed: true,
    settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
    alarm: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-368/WO-384 the probing workspace uses one non-scrolling operator station', () => {
  it('renders the setup, the step card and the controls as the three columns of one station', () => {
    render(React.createElement(ProbingPanel))

    const station = screen.getByTestId('control-probing-panel')
    expect(Array.from(station.children)).toEqual([
      screen.getByTestId('control-probing-left'),
      screen.getByTestId('probing-step-card'),
      screen.getByTestId('control-probing-right'),
    ])
  })

  it('keeps each zone in its own column', () => {
    render(React.createElement(ProbingPanel))

    const left = screen.getByTestId('control-probing-left')
    expect(left.contains(screen.getByTestId('control-probe-routine-bar'))).toBe(true)
    expect(left.contains(screen.getByTestId('control-probe-setup-card'))).toBe(true)
    expect(screen.getByTestId('probing-step-card').contains(screen.getByTestId('probe-picture'))).toBe(true)
    const right = screen.getByTestId('control-probing-right')
    expect(right.contains(screen.getByTestId('control-probe-command-cluster'))).toBe(true)
    expect(right.contains(screen.getByTestId('probing-key-panel'))).toBe(true)
  })

  it('gives the step card no scroller of its own; the side columns use the Control page column scroller Main uses', () => {
    render(React.createElement(ProbingPanel))

    const card = screen.getByTestId('probing-step-card')
    expect(card.className).not.toMatch(/scroll/i)
    for (const el of card.querySelectorAll('*')) expect(String(el.getAttribute('class') ?? '')).not.toMatch(/scroll/i)
    for (const testId of ['control-probing-left', 'control-probing-right']) {
      const classes = screen.getByTestId(testId).className.split(/\s+/).filter((c) => /scroll/i.test(c))
      expect(classes).toEqual(['control-col-scroll'])
    }
  })

  it('keeps the picture and Start probing in one station across edge, corners, and four-side routines', () => {
    render(React.createElement(ProbingPanel))
    const station = screen.getByTestId('control-probing-panel')

    for (const routine of ['edge', 'outsideCorner', 'bore']) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      expect(station.querySelector('[data-testid="probe-picture"]')).not.toBeNull()
      expect(station.querySelector('[data-testid="control-probe-run-guided"]')).not.toBeNull()
    }
  })

  it('still shows the WO-304 readouts - machine position, homed state and the target work offset', () => {
    useMachineControl.setState({ homed: false, mpos: null })
    render(React.createElement(ProbingPanel))

    expect(screen.getByTestId('control-dro-x')).toBeTruthy()
    expect(screen.getByTestId('control-dro-y')).toBeTruthy()
    expect(screen.getByTestId('control-dro-z')).toBeTruthy()
    expect((screen.getByTestId('control-work-probe-wcs') as HTMLSelectElement).value).toBe('G54')

    // The readouts sit in the left column, outside the step card.
    const dro = screen.getByTestId('control-dro-x')
    expect(screen.getByTestId('control-probing-left').contains(dro)).toBe(true)
    expect(screen.getByTestId('probing-step-card').contains(dro)).toBe(false)
  })

  it('exposes every setup-integrated routine with its own live picture', () => {
    render(React.createElement(ProbingPanel))
    const routines = [
      'workZero',
      'edge',
      'zSurface',
      'insideCorner',
      'outsideCorner',
      'bore',
      'boss',
      'rectPocket',
      'rectBoss',
      'angle',
      'toolZ',
    ]

    const shown: string[] = []
    for (const routine of routines) {
      fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
      // Its picture - or, where the routine cannot plan yet (Z surface with no
      // program loaded), the reason, in the same card.
      const picture = screen.queryByTestId('probe-picture')
      if (picture) expect(screen.getByTestId('probing-step-sentence').textContent).not.toBe('')
      else expect(screen.getByTestId('probing-scene-refusal').textContent).not.toBe('')
      shown.push(`${routine}:${picture ? 'picture' : 'reason'}`)
    }
    expect(shown.filter((r) => r.endsWith(':reason'))).toEqual(['zSurface:reason'])
    // WO-469: the word follows the mode, so ask for the control and keep it
    // pinned inside the cluster - with Start probing and Stop (Operator's pick,
    // card Q-PROBING-SCREEN-WHICH-BUTTONS).
    expect(
      expectOneEstopControl().closest('[data-testid="control-probe-command-cluster"]'),
    ).toBeTruthy()
    expect(screen.getByTestId('control-probe-command-cluster').textContent).toContain('Start probing')
    expect(screen.getByTestId('control-probe-command-cluster').textContent).toContain('Stop')
  })
})
