// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  calculateBoreCenter,
  calculateBossCenter,
  calculateCorner,
  calculateEdge,
} from '../../lib/machine/probeRoutines'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const machineSession = await import('../../lib/machine/machineSession')
// WO-297: workpiece probing (this file's routines, mounted) moved out of
// ToolsProbePanel into its own ProbingPanel/Probing tab.
// WO-2063 (docs/design/PROBING-SCREEN-V2.md): the manual touch buttons are
// gone - Start probing runs the whole routine, and its result and Confirm sit
// on the routine's last step. The arithmetic, the tip-radius compensation and
// the confirmation gate below are unchanged; only the way in is.
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

function connectIdle() {
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

/** Start probing needs a known machine: homed, its limits read. */
function connectHomed() {
  connectIdle()
  useMachineControl.setState({
    connectionKind: 'serial',
    homed: true,
    mpos: { x: -50, y: -50, z: -10 },
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
  })
}

type TouchKey = import('../../lib/machine/probeFeatureCycle').ProbeCycleTouchKey
type CycleResult = Awaited<ReturnType<typeof machineSession.runFeatureProbeCycle>>

/** Start probing, with the runner reporting each touch as it lands (onTouch),
 *  exactly as runFeatureProbeCycle does, then ending with `message`. */
async function runRoutine(touches: Partial<Record<TouchKey, number>>, ok = true, message = 'cycle recorded its touches.') {
  runFeatureProbeCycle.mockImplementationOnce(async (_plan, _config, _clear, onTouch) => {
    for (const [key, mm] of Object.entries(touches)) onTouch?.(key as TouchKey, mm as number)
    return { ok, message, touches, topMachineZ: null }
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-probe-run-guided'))
    await Promise.resolve()
  })
}

/** The routine's last step: its result and the Confirm button. */
function resultStep(): HTMLElement {
  const chips = screen.getAllByTestId(/^probing-step-chip-/)
  fireEvent.click(chips[chips.length - 1])
  return screen.getByTestId('control-work-probe-result')
}

/** The touch directions of the plan Start probing ran (call `n`, from 0). */
function touchOrder(n = 0): string[] {
  return runFeatureProbeCycle.mock.calls[n][0].review.touchOrder.map((t) => `${t.axis}${t.direction}`)
}

function said(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

beforeEach(() => {
  memory.clear()
  useUiPrefs.setState({ machineDisplayUnits: 'mm' })
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: null,
    activeTool: null,
    tlo: null,
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  runFeatureProbeCycle.mockReset()
  setWorkOffsetValue.mockReset()
  setWorkOffsetValue.mockReturnValue(true)
})

afterEach(() => cleanup())

describe('probe routine arithmetic', () => {
  it('compensates an edge in the touch direction', () => {
    const result = calculateEdge({ axis: 'X', direction: '+', triggerPositionMm: 24, tipRadiusMm: 2 })
    expect(result.coordinateMm).toBe(26)
    expect(result.coordinateMm).not.toBe(24)
    expect(result.compensation).toContain('+2 mm')
  })

  it('compensates both faces of a corner independently', () => {
    const result = calculateCorner({
      x: { direction: '-', triggerPositionMm: 10, tipRadiusMm: 2 },
      y: { direction: '+', triggerPositionMm: 20, tipRadiusMm: 2 },
    })
    expect(result).toMatchObject({ xMm: 8, yMm: 22, tipRadiusMm: 2 })
    expect([result.xMm, result.yMm]).not.toEqual([10, 20])
  })

  it('adds two tip radii to each bore diameter without shifting its centre', () => {
    const result = calculateBoreCenter({
      xNegativeMm: -4,
      xPositiveMm: 4,
      yNegativeMm: -5,
      yPositiveMm: 5,
      tipRadiusMm: 1,
    })
    expect(result).toMatchObject({ centerXmm: 0, centerYmm: 0, diameterXmm: 10, diameterYmm: 12 })
    expect(result.diameterXmm).not.toBe(8)
    expect(result.compensation).toContain('added at both walls')
  })

  it('subtracts two tip radii from each boss diameter without shifting its centre', () => {
    const result = calculateBossCenter({
      xPositiveMm: -6,
      xNegativeMm: 6,
      yPositiveMm: -8,
      yNegativeMm: 8,
      tipRadiusMm: 1,
    })
    expect(result).toMatchObject({ centerXmm: 0, centerYmm: 0, diameterXmm: 10, diameterYmm: 14 })
    expect(result.diameterYmm).not.toBe(16)
    expect(result.compensation).toContain('subtracted at both faces')
  })
})

describe('mounted ProbingPanel workpiece routines', () => {
  it('runs the edge form, previews its target WCS, and waits for confirmation before writing', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))

    const face = screen.getByTestId('control-work-probe-edge-face') as HTMLSelectElement
    fireEvent.change(face, { target: { value: 'X-' } })
    fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: 'G55' } })
    await runRoutine({ edge: 10 })
    expect(touchOrder()).toEqual(['X-'])

    const result = resultStep()
    // Touching X- at 10 with the default 1.5 mm tip: the face is at 10 - 1.5.
    expect(result.textContent).toContain('X face 8.50 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('X face 0.335 in')
    const apply = screen.getByTestId('control-work-probe-apply') as HTMLButtonElement
    expect(apply.disabled).toBe(false)
    // What Confirm writes, and the compensation behind it, before it is pressed.
    expect(apply.getAttribute('data-tooltip')).toContain('Write G55')
    expect(apply.getAttribute('data-tooltip')).toContain('-1.5 mm')
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(apply)
    expect(setWorkOffsetValue).toHaveBeenCalledOnce()
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G55', 'X', 8.5)
  })

  it('locks routine and direction choices until an in-flight run finishes', async () => {
    connectHomed()
    let finish!: (result: CycleResult) => void
    runFeatureProbeCycle.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    render(React.createElement(ProbingPanel))

    // Any other routine tile is the witness that the choices lock mid-run.
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
      await Promise.resolve()
    })
    expect((screen.getByTestId('control-work-probe-routine-outsideCorner') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('control-work-probe-edge-face') as HTMLSelectElement).disabled).toBe(true)

    await act(async () => {
      finish({ ok: true, message: 'Contact.', touches: { edge: 10 }, topMachineZ: null })
      await Promise.resolve()
    })
    expect((screen.getByTestId('control-work-probe-routine-outsideCorner') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('control-work-probe-edge-face') as HTMLSelectElement).disabled).toBe(false)
  })

  it('runs the two-touch corner form and displays the compensated XY corner', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-outsideCorner'))

    // The one Corner choice sets both touch directions: an outside corner's
    // back-right is touched X- then Y-.
    fireEvent.change(screen.getByTestId('control-work-probe-corner'), { target: { value: '--' } })
    await runRoutine({ cornerX: 10, cornerY: 20 })
    expect(touchOrder()).toEqual(['X-', 'Y-'])

    const result = resultStep()
    expect(result.textContent).toContain('Corner at machine X 8.50 Y 18.50 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('Corner at machine X 0.335 Y 0.728 in')
  })

  it('runs the four-touch bore form and displays centre plus both measured diameters', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5, yPositive: 5 })

    const result = resultStep()
    expect(result.textContent).toContain('Centre at machine X 0.00 Y 0.00')
    expect(result.textContent).toContain('measured diameter X 11.00, Y 13.00 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('Centre at machine X 0.000 Y 0.000')
    expect(result.textContent).toContain('measured diameter X 0.433, Y 0.512 in')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'mm' }) })
    expect(screen.getByTestId('control-work-probe-apply').getAttribute('data-tooltip')).toContain('1.5 mm added at both walls')
  })

  it('runs the four-touch boss form and displays centre plus both measured diameters', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))

    await runRoutine({ xNegative: 6, xPositive: -6, yNegative: 8, yPositive: -8 })

    const result = resultStep()
    expect(result.textContent).toContain('Centre at machine X 0.00 Y 0.00')
    expect(result.textContent).toContain('measured diameter X 9.00, Y 13.00 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('Centre at machine X 0.000 Y 0.000')
    expect(result.textContent).toContain('measured diameter X 0.354, Y 0.512 in')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'mm' }) })
    expect(screen.getByTestId('control-work-probe-apply').getAttribute('data-tooltip')).toContain('1.5 mm subtracted at both faces')
  })

  it('quotes a failed touch result and does not produce an offset preview', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))

    // WO-2557 retains a prior result on an unsent retry. This is a moved run that misses.
    runFeatureProbeCycle.mockImplementationOnce(async () => {
      const start = useMachineControl.getState().mpos!
      useMachineControl.setState({ mpos: { ...start, x: start.x - 4 } })
      return { ok: false, message: 'The controller did not report a probe contact ([PRB]).', touches: {}, topMachineZ: null }
    })
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    // The runner's words reach the one console (COHESION-STANDARD 13), as an error.
    await waitFor(() => {
      const errors = useMachineControl.getState().consoleLines.filter((line) => line.severity === 'error')
      expect(errors.map((line) => line.text)).toContain('The controller did not report a probe contact ([PRB]).')
    })
    expect(resultStep().textContent).toContain('No result yet')
    expect((screen.getByTestId('control-work-probe-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })

  it('refuses an axis that is not X or Y instead of quietly touching toward Z', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))

    // A tampered/renamed option is the only way this value can be anything
    // else; the transport would map it to the Z index and probe downward.
    const face = screen.getByTestId('control-work-probe-edge-face') as HTMLSelectElement
    const rogue = document.createElement('option')
    rogue.value = 'Z-'
    face.appendChild(rogue)
    fireEvent.change(face, { target: { value: 'Z-' } })

    // Refused: the Face stays the X face it was, and Start probing runs that.
    expect(face.value).toBe('X+')
    await runRoutine({ edge: 10 })
    expect(runFeatureProbeCycle).toHaveBeenCalledOnce()
    expect(touchOrder()).toEqual(['X+'])
    expect(setWorkOffsetValue).not.toHaveBeenCalledWith(expect.anything(), 'Z', expect.anything())
  })

  it('drops the superseded trigger when a re-run fails, so no stale result stays confirmable', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'X-' } })

    await runRoutine({ edge: 10 })
    expect(resultStep().textContent).toContain('X face 8.50 mm')

    // WO-2557 retains a prior result on an unsent retry. This is a moved run that misses.
    runFeatureProbeCycle.mockImplementationOnce(async () => {
      const start = useMachineControl.getState().mpos!
      useMachineControl.setState({ mpos: { ...start, x: start.x - 4 } })
      return { ok: false, message: 'The controller did not report a probe contact ([PRB]).', touches: {}, topMachineZ: null }
    })
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    await waitFor(() => {
      expect(said()).toContain('The controller did not report a probe contact ([PRB]).')
    })
    expect(resultStep().textContent).toContain('No result yet')
    expect((screen.getByTestId('control-work-probe-apply') as HTMLButtonElement).disabled).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })
})
