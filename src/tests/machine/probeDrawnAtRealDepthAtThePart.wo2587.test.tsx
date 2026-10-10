// @vitest-environment jsdom
// WO-2587: reported DEPTH only inside the frame during/after a moved run.
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((result: CycleResult) => void) | null = null
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>(resolve => { finishCycle = resolve }))
vi.mock('../../lib/machine/machineSession', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({ ...actual, runFeatureProbeCycle })
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
  vi.stubGlobal('requestAnimationFrame', undefined)
  __resetProbingSessionForTest()
  finishCycle = null
  runFeatureProbeCycle.mockClear()
  memory.clear()
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
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    wpos: { x: 150, y: 150, z: 100 },
    mpos: { x: 350, y: 350, z: 170 },
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })


const num = (el: Element, key: string) => Number(el.getAttribute(key))
const shape = () => ({
  side: screen.getByTestId('probe-side-probe').querySelector('circle')!,
  top: screen.getByTestId('probe-top-probe'),
})
function tipDepth() {
  // Height lines and ball are actual production SVG geometry, not metadata.
  const lines = Array.from(screen.getByTestId('probe-side-view').querySelectorAll(':scope > line'))
    .filter(el => num(el, 'x1') === 0 && num(el, 'x2') > 500)
  const ys = [...new Set(lines.map(el => num(el, 'y1')))].sort((a, b) => a - b)
  // Defaults: safe +5 and top 0 (Edge also has a start +10 line).
  const labels = screen.getAllByTestId('probe-height-label').map(el => el.textContent)
  const topIndex = labels.findIndex(text => text === 'top')
  const safeIndex = labels.findIndex(text => text?.startsWith('safe'))
  const topY = ys[topIndex], safeY = ys[safeIndex]
  const { side } = shape()
  return -(num(side, 'cy') + num(side, 'r') - topY) / ((topY - safeY) / 5)
}
function report(x: number, y: number, z: number) {
  act(() => useMachineControl.setState({ wpos: { x, y, z }, mpos: { x: x - 50, y: y - 50, z: z - 20 } }))
}
function open(kind: 'bore' | 'edge', face?: string) {
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${kind}`))
  if (face) fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: face } })
}

describe('WO-2587 real depth at the part', () => {
  it.each([['bore', undefined, 10, 0], ['edge', 'X+', -2, 0], ['edge', 'Y+', 0, -2]] as const)('%s %s keeps the complete start-zone picture even at the part', (kind, face, x, y) => {
    open(kind, face)
    const before = screen.getByTestId('probe-picture').outerHTML
    report(x, y, -5)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(before)
    report(x, y, -3)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(before)
  })

  it.each([['bore', undefined, 10, 0], ['edge', 'X+', -2, 0], ['edge', 'Y+', 0, -2]] as const)('%s %s draws a stopped tip at -5 without moving it sideways', async (kind, face, x, y) => {
    report(0, 0, 10)
    open(kind, face)
    await act(async () => fireEvent.click(screen.getByTestId('control-probe-run-guided')))
    report(x, y, -5)
    await act(async () => {
      finishCycle!({ ok: false, message: 'Stopped at wall.', touches: {}, topMachineZ: 70 })
    })
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')
    expect(tipDepth()).toBeCloseTo(-5, 5)
    const initial = shape()
    const sideways = [num(initial.side, 'cx'), num(initial.top, 'cx'), num(initial.top, 'cy')]
    report(x, y, -3)
    expect(tipDepth()).toBeCloseTo(-3, 5)
    const after = shape()
    expect([num(after.side, 'cx'), num(after.top, 'cx'), num(after.top, 'cy')]).toEqual(sideways)
  })

  it.each([[0, 0], [100, 50]])('stopped bore depth uses the plan frame with G54 centre at %s,%s', async (workX, workY) => {
    const atBore = (dx: number, z: number) => act(() => useMachineControl.setState({
      wpos: { x: workX + dx, y: workY, z },
      mpos: { x: -50 + dx, y: -50, z: -20 + z },
    }))
    atBore(0, 10)
    open('bore')
    const beforeStart = screen.getByTestId('probe-picture').outerHTML
    await act(async () => fireEvent.click(screen.getByTestId('control-probe-run-guided')))
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(beforeStart)
    atBore(10, -5)
    await act(async () => finishCycle!({ ok: false, message: 'Stopped at wall.', touches: {}, topMachineZ: 70 }))
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')
    expect(tipDepth()).toBeCloseTo(-5, 5)
    cleanup()
    render(React.createElement(ProbingPanel))
    expect(tipDepth()).toBeCloseTo(-5, 5)
    // Only the machine report changes: keep the run's plan XY and work-Z datum.
    act(() => useMachineControl.setState({ mpos: { x: -40, y: -50, z: -23 } }))
    expect(tipDepth()).toBeCloseTo(-3, 5)
  })

  it.each([[150, 0, -5], [0, 150, -5], [0, 0, 200], [0, 0, -200], [NaN, 0, -5]])('outside/invalid (%s,%s,%s) retains the complete picture', (x, y, z) => {
    open('bore')
    const before = screen.getByTestId('probe-picture').outerHTML
    report(x, y, z)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(before)
  })

  it('unknown or disconnected position retains the complete picture', () => {
    open('bore')
    const before = screen.getByTestId('probe-picture').outerHTML
    act(() => useMachineControl.setState({ wpos: null, mpos: null }))
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(before)
    cleanup()
    __resetProbingSessionForTest()
    useMachineControl.setState({ connectionPhase: 'disconnected', wpos: null })
    open('bore')
    const disconnected = screen.getByTestId('probe-picture').outerHTML
    act(() => useMachineControl.setState({ wpos: { x: 10, y: 0, z: -5 } }))
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(disconnected)
  })

  it('machine-step preview keeps its arrows, outline and preview at the planned position', () => {
    open('bore')
    fireEvent.click(screen.getByTestId('probing-step-chip-4'))
    const ids = ['probe-side-preview', 'probe-top-preview', 'probe-move-side', 'probe-move-top', 'probe-move-label']
    const before = ids.map(id => screen.queryByTestId(id)?.outerHTML)
    const picture = screen.getByTestId('probe-picture').outerHTML
    report(10, 0, -5)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(picture)
    expect(ids.map(id => screen.queryByTestId(id)?.outerHTML)).toEqual(before)
  })

  it('running, held, stopped and reopened panel use the reported depth', async () => {
    report(0, 0, 10)
    open('bore')
    await act(async () => fireEvent.click(screen.getByTestId('control-probe-run-guided')))
    expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
    // Start requested, but not yet moved: retain the complete preview.
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    expect(tipDepth()).toBeCloseTo(10, 5)
    report(0, 0, -3)
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('running')
    expect(tipDepth()).toBeCloseTo(-3, 5)
    act(() => useMachineControl.setState({ machineState: 'hold' }))
    report(10, 0, -5)
    expect(tipDepth()).toBeCloseTo(-5, 5)
    await act(async () => {
      useMachineControl.setState({ machineState: 'idle' })
      finishCycle!({ ok: false, message: 'Stopped at wall.', touches: {}, topMachineZ: 70 })
    })
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')
    expect(tipDepth()).toBeCloseTo(-5, 5)
    cleanup()
    render(React.createElement(ProbingPanel))
    expect(tipDepth()).toBeCloseTo(-5, 5)
    report(10, 0, -7)
    expect(tipDepth()).toBeCloseTo(-7, 5)
    // Browsing a step returns to preview even while followRun is retained.
    fireEvent.click(screen.getByTestId('probing-step-chip-1'))
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    expect(tipDepth()).toBeCloseTo(10, 5)
    const retainedRunPreview = screen.getByTestId('probe-picture').outerHTML
    report(10, 0, -5)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(retainedRunPreview)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    const preview = screen.getByTestId('probe-picture').outerHTML
    report(-2, 0, -5)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(preview)
  })

})
