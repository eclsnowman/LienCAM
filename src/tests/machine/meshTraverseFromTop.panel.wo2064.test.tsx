// @vitest-environment jsdom
//
// WO-2064 - the Probing screen's Z surface route shows and sends the mesh's
// two travel planes.
//
// The runner half (meshTraverseFromTop.wo2064.test.ts) proves on the fake
// board that later points travel at point 1's top + clearance and search
// clearance + the largest height change (8 -> 13 mm down). This file proves the
// operator's screen: the steps name both planes, the "Largest height change"
// field is editable, and Start probing hands its value to the production
// runner. (WO-2063, v2 brief: the plan text and the path-clear tick went with
// the old screen; the step sentences carry the planes.)

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const { runnerInputs } = vi.hoisted(() => ({ runnerInputs: [] as unknown[] }))

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runSurfaceMeshProbeCycle: async (input) => {
      runnerInputs.push(input)
      return { ok: false, message: 'stopped by the test after recording the input', mesh: null, samples: [] }
    },
  })
})

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
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
  memory.clear()
  runnerInputs.length = 0
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: 1,
    mpos: { x: -50, y: -50, z: -10 },
    wpos: { x: 0, y: 0, z: 0 },
    homed: true,
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    alarm: null,
    programText: PROGRAM,
    surfaceMesh: null,
    job: { ...useMachineControl.getState().job, phase: 'ready', name: 'pcb.nc' },
  })
})

afterEach(() => cleanup())

/** Every step's sentence, paged through as the operator would. */
function stepSentences(): string[] {
  return screen.getAllByTestId(/^probing-step-chip-/).map((chip) => {
    fireEvent.click(chip)
    return screen.getByTestId('probing-step-sentence').textContent ?? ''
  })
}

function commit(testId: string, text: string): void {
  const input = screen.getByTestId(testId) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

describe('WO-2064: the Z surface route names both travel planes', () => {
  it('the steps name the probe from where it stands to point 1, and later moves at point 1\'s top + 5 mm', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))

    const said = stepSentences()
    expect(said).toContain('Touches point 1. That becomes work Z0.')
    expect(said.join(' ')).toMatch(/Rises to Z0 \+ 5(\.0)?\. Every move between points is at that height\./)
    // Default: clearance 5 + largest height change 5.
    expect(said.join(' ')).toMatch(/Probes down at that point, at most 10(\.0+)? mm\./)
    expect(said.join(' ')).not.toContain('Safe travel Z')
  })

  it('the largest height change is editable, the steps follow it, and Start probing sends it: 8 -> each later point searches 13 mm', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))

    const field = screen.getByTestId('control-surface-mesh-height-change') as HTMLInputElement
    expect(field.value).toBe('5.00')

    commit('control-surface-mesh-height-change', '8')
    expect((screen.getByTestId('control-surface-mesh-height-change') as HTMLInputElement).value).toBe('8.00')
    // A changed search is a changed plan: the step says so.
    expect(stepSentences().join(' ')).toMatch(/Probes down at that point, at most 13(\.0+)? mm\./)

    // A negative height change is not accepted.
    commit('control-surface-mesh-height-change', '-1')
    expect((screen.getByTestId('control-surface-mesh-height-change') as HTMLInputElement).value).toBe('8.00')

    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
    })
    expect(runnerInputs).toHaveLength(1)
    expect(runnerInputs[0]).toMatchObject({ safeMachineZ: -10, largestHeightChangeMm: 8 })
  })
})
