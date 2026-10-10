// @vitest-environment jsdom
//
// WO-2114 - the Probing screen's first step says where to start.
//
// Found by the headed walkthrough 2026-09-28 (.planning/probing-walkthrough-
// 2026-09-28/REPORT.md): Bore, Rect pocket and Inside corner touch no top -
// they descend from the work Z0 already set (WO-2057) - yet step 1 never said
// to set Z0 on this part first. Z surface's step 1 said "Jog over point 1",
// though the mesh runner moves over point 1 itself from wherever the probe
// stands (runSurfaceMeshProbeCycle: safe Z move, then the XY move to point 1).
//
// Proven through the production Probing screen (ProbingPanel): the step-1
// sentence each routine shows. Wording only - no control is added.

import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')

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

beforeEach(() => {
  __resetProbingSessionForTest()
  mem.clear()
  useCamStore.getState().newProject()
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: true,
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    mpos: { x: -50, y: -50, z: -10 },
    wpos: { x: 5, y: 0, z: 10 },
    consoleLines: [],
    programText: PROGRAM,
    surfaceMesh: null,
    job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' },
  })
})

afterEach(() => cleanup())

/** Step 1's sentence on the Probing screen for one routine. */
function stepOne(routine: string): string {
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
  fireEvent.click(screen.getByTestId('probing-step-chip-1'))
  return screen.getByTestId('probing-step-sentence').textContent ?? ''
}

describe('WO-2114: step 1 says where each routine starts', () => {
  it('Bore, Rect pocket and Inside corner: set Z0 on this part first - the probe descends from it', () => {
    render(React.createElement(ProbingPanel))
    expect(stepOne('bore')).toBe('Set Z0 on this part first (G54): the probe descends from it. Then jog over the middle of the bore (by eye is fine), above the top.')
    expect(stepOne('rectPocket')).toBe('Set Z0 on this part first (G54): the probe descends from it. Then jog over the middle of the pocket (by eye is fine), above the top.')
    const corner = stepOne('insideCorner')
    expect(corner.startsWith('Set Z0 on this part first (G54): the probe descends from it. Then jog over the ')).toBe(true)
    expect(corner).toContain('corner of the pocket')
  })

  it('the routines that touch the top themselves (and Z0) say nothing about setting Z0 first', () => {
    render(React.createElement(ProbingPanel))
    for (const routine of ['edge', 'outsideCorner', 'angle', 'boss', 'rectBoss', 'workZero']) {
      expect(stepOne(routine), routine).not.toContain('Set Z0')
    }
  })

  it('Z surface: asks only for a safe start height - the routine moves over point 1 itself', () => {
    render(React.createElement(ProbingPanel))
    const said = stepOne('zSurface')
    expect(said).toBe('Load the program. Jog up to a safe start height, clear of the clamps and less than 50 mm above the top. The routine moves over point 1 itself.')
    expect(said).not.toContain('Jog over point 1')
    // WO-2179: the picture draws the zone's height as a dimension, where it
    // fits; the words are the sentence's.
    const words = within(screen.getByTestId('probe-picture')).queryByTestId('probe-zone-words')?.textContent ?? ''
    expect(words).not.toContain('a safe height')
    expect(words).not.toContain('over point 1')
  })
})
