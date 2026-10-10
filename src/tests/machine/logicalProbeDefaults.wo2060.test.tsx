// @vitest-environment jsdom
//
// WO-2060: logical probe defaults through the real Probing panel. X0 is
// normally the left face and Y0 the front, so Edge probes X+, corners default
// to front-left (X+ Y+), Angle defaults to the front face (probe Y+), and the
// tip radius comes from the active tool's diameter / 2 - or the panel asks once
// and writes the tool table.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { makeTool } from '../post/helpers'

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

/** WO-2063 (v2 brief): one Face / Corner select per routine replaced the
 *  separate axis and direction selects and their "moves RIGHT" hints. The
 *  selected option says which face in the operator's words. */
function picked(testId: string): { value: string; words: string } {
  const select = screen.getByTestId(testId) as HTMLSelectElement
  return { value: select.value, words: select.selectedOptions[0]?.textContent ?? '' }
}

/** The Tip radius row's label: it names the tool only when the radius is that
 *  tool's, never while the default stands in (WO-2063: the separate source
 *  line went with the old screen). */
function tipRadiusLabel(): string {
  return screen.getByTestId('control-work-probe-tip-radius').closest('.pbn-setup-row')?.querySelector('span')?.textContent ?? ''
}

describe('WO-2060 logical probe defaults', () => {
  it('Edge with no override probes X+ (touches the left face)', () => {
    render(React.createElement(ProbingPanel))
    expect(picked('control-work-probe-edge-face')).toEqual({ value: 'X+', words: 'X left (X+)' })
  })

  it('outside corner defaults to front-left (X+ Y+)', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-outsideCorner'))
    // X+ Y+: the probe moves right onto the left face and back onto the front.
    expect(picked('control-work-probe-corner')).toEqual({ value: '++', words: 'front-left' })
  })

  it('inside corner defaults to a pocket front-left corner (X- Y-), apart from the outside corner (audit)', () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-insideCorner'))
    // X- Y-: inside a pocket the probe moves left and forward onto its walls.
    expect(picked('control-work-probe-corner')).toEqual({ value: '--', words: 'front-left' })
    // Back to the outside corner: still its own front-left X+ Y+.
    fireEvent.click(screen.getByTestId('control-work-probe-routine-outsideCorner'))
    expect(picked('control-work-probe-corner')).toEqual({ value: '++', words: 'front-left' })
  })

  it('tip radius is the active tool library diameter / 2', () => {
    useCamStore.setState({ toolLibrary: [makeTool({ id: 't1', toolNumber: 3, name: '6mm', diameter: 6 })] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbingPanel))
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('3.00')
    expect(tipRadiusLabel()).toBe('Tip radius (T3) (mm)')
    expect(screen.queryByTestId('control-work-probe-tool-diameter')).toBeNull()
  })

  it('negative control: no library diameter asks once and writes the tool table', () => {
    useMachineControl.setState({ activeTool: 7 })
    render(React.createElement(ProbingPanel))
    // Not silent: the radius in use is the default, not T7's, and T7's
    // diameter is asked for beside it until answered.
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('1.50')
    expect(tipRadiusLabel()).toBe('Tip radius (mm)')
    const ask = screen.getByTestId('control-work-probe-tool-diameter') as HTMLInputElement
    fireEvent.change(ask, { target: { value: '4' } })
    fireEvent.blur(ask)
    const entries = Object.values(useMachineToolTable.getState().byMachine).flatMap((r) => r.table.tools)
    expect(entries.find((t) => t.tool === 7)?.dia).toBe(4)
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('2.00')
    expect(screen.queryByTestId('control-work-probe-tool-diameter')).toBeNull()
  })

  it('a tool with no diameter never keeps the previous tool radius (audit 2)', () => {
    useCamStore.setState({ toolLibrary: [makeTool({ id: 't1', toolNumber: 3, name: '6mm', diameter: 6 })] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbingPanel))
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('3.00')
    act(() => useMachineControl.setState({ activeTool: 7 }))
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('1.50')
    expect(tipRadiusLabel()).toBe('Tip radius (mm)')
    expect(screen.getByTestId('control-work-probe-tool-diameter')).toBeTruthy()
  })
})
