// @vitest-environment jsdom
//
// WO-1634: Operator probes with the end mill in the collet, not a dedicated
// stylus - "I don't have a secondary probe... That's pretty typical for
// low-cost cncs that don't have a dedicated actual three-dimensional probe."
// The tip radius field on both the Probing tab (ProbingPanel) and the
// Routines tab (ProbeRoutinesTab) must default to whatever tool is actually
// active, named so the operator knows where the number came from, and must
// never clobber a value the operator typed on purpose.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import { makeTool } from '../post/helpers'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runDirectionalProbeTouch: vi.fn(),
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const { ProbingPanel, activeToolFromLibrary } = await import('../../components/machine/ProbingPanel')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling probe
// tests use (probingPanel.wo297.test.tsx, probingDiagramReacts.wo358.test.tsx).
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

function connectIdle() {
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

const SIX_MM_ENDMILL = makeTool({ id: 't1', toolNumber: 3, name: '6mm Flat End Mill', diameter: 6 })
const TEN_MM_FACEMILL = makeTool({ id: 't2', toolNumber: 5, name: '10mm Face Mill', diameter: 10 })

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: null,
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-1634 activeToolFromLibrary: the lookup both tabs share', () => {
  it('resolves the one library tool whose T-number matches', () => {
    expect(activeToolFromLibrary(3, [SIX_MM_ENDMILL, TEN_MM_FACEMILL])).toBe(SIX_MM_ENDMILL)
  })

  it('refuses to guess among duplicate T-numbers', () => {
    const duplicate = makeTool({ id: 't3', toolNumber: 3, name: 'Other 3' })
    expect(activeToolFromLibrary(3, [SIX_MM_ENDMILL, duplicate])).toBeNull()
  })

  it('is null with no active tool', () => {
    expect(activeToolFromLibrary(null, [SIX_MM_ENDMILL])).toBeNull()
  })
})

/** WO-2063 (v2 brief): the Probing screen's Tip radius row names the tool in
 *  its label while the radius is that tool's ("Tip radius (T3) (mm)"); the
 *  separate "tip radius from ..." source line went with the old screen. */
function tipRadiusLabel(): string {
  return screen.getByTestId('control-work-probe-tip-radius').closest('.pbn-setup-row')?.querySelector('span')?.textContent ?? ''
}

describe('WO-1634 ProbingPanel tip radius follows the active tool', () => {
  it('a 6 mm flat end mill active gives tip radius 3.000, source named', () => {
    connectIdle()
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbingPanel))
    const input = screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement
    expect(input.value).toBe('3.00')
    expect(tipRadiusLabel()).toBe('Tip radius (T3) (mm)')
  })

  it('a typed value survives a later tool change', () => {
    connectIdle()
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL, TEN_MM_FACEMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbingPanel))
    const input = () => screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement
    expect(input().value).toBe('3.00')

    fireEvent.change(input(), { target: { value: '2' } })
    fireEvent.blur(input())
    expect(input().value).toBe('2.00')
    // Typed: the radius is no longer the tool's, so the label stops naming it.
    expect(tipRadiusLabel()).toBe('Tip radius (mm)')

    act(() => { useMachineControl.setState({ activeTool: 5 }) })
    expect(input().value).toBe('2.00')
    // Typed: the radius is no longer the tool's, so the label stops naming it.
    expect(tipRadiusLabel()).toBe('Tip radius (mm)')
  })

  it('no active tool keeps the last value - no refusal, no nag', () => {
    connectIdle()
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbingPanel))
    const input = () => screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement
    expect(input().value).toBe('3.00')

    act(() => { useMachineControl.setState({ activeTool: null }) })
    expect(input().value).toBe('3.00')
  })

  it('WO-2060: a tool with no library diameter asks instead of silently using 1.5 mm', () => {
    connectIdle()
    useMachineControl.setState({ activeTool: 7 })
    render(React.createElement(ProbingPanel))
    // Not silent: 1.5 mm stands in, not called T7's, and T7's diameter is
    // asked for until the question is answered.
    expect((screen.getByTestId('control-work-probe-tip-radius') as HTMLInputElement).value).toBe('1.50')
    expect(tipRadiusLabel()).toBe('Tip radius (mm)')
    expect(screen.getByTestId('control-work-probe-tool-diameter')).toBeTruthy()
  })
})

describe('WO-1634 ProbeRoutinesTab tip radius follows the active tool', () => {
  it('a 6 mm flat end mill active gives tip radius 3.000, source named', () => {
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbeRoutinesTab))
    const input = screen.getByTestId('control-routines-tip-radius-cell') as HTMLInputElement
    expect(input.value).toBe('3.00')
    expect(screen.getByTestId('control-routines-tip-radius-source').textContent).toContain('T3 6mm Flat End Mill')
  })

  it('a typed value survives a later tool change', () => {
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL, TEN_MM_FACEMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbeRoutinesTab))
    const input = () => screen.getByTestId('control-routines-tip-radius-cell') as HTMLInputElement
    fireEvent.change(input(), { target: { value: '2' } })
    fireEvent.blur(input())
    expect(input().value).toBe('2.00')

    act(() => { useMachineControl.setState({ activeTool: 5 }) })
    expect(input().value).toBe('2.00')
    expect(screen.queryByTestId('control-routines-tip-radius-source')).toBeNull()
  })

  it('no active tool keeps the last value', () => {
    useCamStore.setState({ toolLibrary: [SIX_MM_ENDMILL] })
    useMachineControl.setState({ activeTool: 3 })
    render(React.createElement(ProbeRoutinesTab))
    const input = () => screen.getByTestId('control-routines-tip-radius-cell') as HTMLInputElement
    expect(input().value).toBe('3.00')

    act(() => { useMachineControl.setState({ activeTool: null }) })
    expect(input().value).toBe('3.00')
  })
})
