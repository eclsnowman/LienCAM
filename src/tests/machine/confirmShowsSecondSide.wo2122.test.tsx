// @vitest-environment jsdom
//
// WO-2122 (Operator, 2026-09-28 card: "Show it on the Confirm step"): on a second
// side (a flipped part) the Probing screen's Confirm step shows, per axis, the
// working the old result panel showed - where the feature sits on the first
// side, what it must read here after the turn - and what Confirm writes. The
// shown values are the values Confirm writes. A first-side run is unchanged.
//
// Harness copied from probingPanel.wo297.test.tsx (jsdom, the mocked runner
// that reports each touch as runFeatureProbeCycle does, the G56 block).

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhysicalStock, Setup, Vec3 } from '../../types'
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
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling probe
// tests use.
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

/** WO-2063 (v2 brief): the manual touch buttons are gone - Start probing runs
 *  the routine. The runner reports each touch as it lands (onTouch), exactly
 *  as runFeatureProbeCycle does, then the run ends. */
async function runRoutine(touches: Partial<Record<TouchKey, number>>, ok = true) {
  runFeatureProbeCycle.mockImplementationOnce(async (_plan, _config, _clear, onTouch) => {
    for (const [key, mm] of Object.entries(touches)) onTouch?.(key as TouchKey, mm as number)
    return { ok, message: ok ? 'cycle recorded its touches.' : 'no contact.', touches, topMachineZ: null }
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-probe-run-guided'))
    await Promise.resolve()
  })
}

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
  runFeatureProbeCycle.mockReset()
  setWorkOffsetValue.mockReset()
  setWorkOffsetValue.mockReturnValue(true)
})

afterEach(() => cleanup())

/** The one block, on G56. */
function block(): PhysicalStock {
  return {
    id: 'block',
    name: 'Vise Block',
    mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 100, y: 50, z: 20 },
      size: { x: 100, y: 50, z: 20 },
      center: { x: 50, y: 25, z: 10 },
    },
    position: { x: 0, y: 0, z: 0 },
    fixtureOffset: 56,
  }
}

/** Zero on the block's FRONT LEFT TOP corner. Both sides share it: the block
 *  did not move, the part under it did. */
function sideSetup(id: string, name: string, flipOf?: Setup['flipOf']): Setup {
  const origin: Vec3 = { x: 0, y: 0, z: 20 }
  return {
    id,
    name,
    wcs: {
      id: `wcs-${id}`,
      label: 'G56',
      fixtureOffset: 56,
      origin,
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'block',
      cornerRow: 2,
      cornerCol: 0,
      cornerFace: 'top',
      originBinding: {
        kind: 'stock_corner',
        stockId: 'block',
        cornerRow: 2,
        cornerCol: 0,
        cornerFace: 'top',
      },
    },
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0,
      material: 'aluminium',
    },
    ...(flipOf ? { flipOf } : {}),
    operations: [],
    notes: '',
  }
}

function installSecondSide(): void {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        stocks: [block()],
        setups: [
          sideSetup('side-1', 'Top side'),
          sideSetup('side-2', 'Underside', { setupId: 'side-1', axis: 'x' }),
        ],
        activeSetupId: 'side-2',
        geometry: [] as unknown as typeof s.project.geometry,
        nests: [] as unknown as typeof s.project.nests,
      },
    }))
  })
}

/** Type a first-side feature position into the setup card, as the operator does. */
function enterFeature(axis: 'X' | 'Y', text: string): void {
  const input = screen.getByTestId(`control-second-side-feature-${axis}`) as HTMLInputElement
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

/** "X=-265.000 mm, Y=-65.000 mm" -> { X: -265, Y: -65 } */
function parseWrites(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/([XY])=(-?\d+(?:\.\d+)?) mm/g)) out[m[1]] = Number(m[2])
  return out
}

describe('WO-2122 the Confirm step shows the second-side working', () => {
  it('shows each axis working and exactly what Confirm writes, on a flipped bore', async () => {
    connectHomed()
    installSecondSide()
    render(React.createElement(ProbingPanel))
    fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: 'G56' } })
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    // The bore sits at X 25, Y 15 on "Top side"; turned about X, Y reads 50 - 15 = 35 here.
    enterFeature('X', '25')
    enterFeature('Y', '15')

    // Centre found at machine X -240, Y -30.
    await runRoutine({ xNegative: -244, xPositive: -236, yNegative: -35, yPositive: -25 })

    const working = await screen.findByTestId('control-second-side-working')
    const lines = screen.getAllByTestId('control-second-side-line').map((el) => el.textContent)
    expect(lines).toEqual([
      'X: the feature sits at 25.00 on "Top side", so after the turn it must read 25.00 here. ' +
        "The probe found it at -240.00, so this side's X zero is -265.00 mm.",
      'Y: the feature sits at 15.00 on "Top side", so after the turn it must read 35.00 here. ' +
        "The probe found it at -30.00, so this side's Y zero is -65.00 mm.",
    ])
    const writes = screen.getByTestId('control-second-side-writes').textContent ?? ''
    expect(writes).toBe('Writes G56 X=-265.00 mm, Y=-65.00 mm')
    // It is on the step card itself, beside Confirm - not a banner elsewhere.
    expect(screen.getByTestId('probing-step-card').contains(working)).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    // What it wrote is exactly what the step showed.
    const shown = parseWrites(writes)
    expect(setWorkOffsetValue.mock.calls).toEqual(
      Object.entries(shown).map(([axis, mm]) => ['G56', axis, mm]),
    )
    expect(setWorkOffsetValue.mock.calls).toEqual([['G56', 'X', -265], ['G56', 'Y', -65]])
  })

  it('leaves a first-side Confirm step as it was: the result sentence and Confirm', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    await runRoutine({ xNegative: -244, xPositive: -236, yNegative: -35, yPositive: -25 })

    const result = await screen.findByTestId('control-work-probe-result')
    expect(screen.queryByTestId('control-second-side-working')).toBeNull()
    expect(screen.queryByTestId('control-second-side-line')).toBeNull()
    expect(screen.queryByTestId('control-second-side-writes')).toBeNull()
    // One sentence, then the button - WO-2063's step, unchanged.
    expect(Array.from(result.children).map((el) => el.tagName)).toEqual(['SPAN', 'BUTTON'])
    expect(result.children[0].textContent).toMatch(/^Bore centre result|^Centre at/)
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue.mock.calls).toEqual([['G54', 'X', -240], ['G54', 'Y', -30]])
  })
})
