// @vitest-environment jsdom
//
// WO-297: probing gets its own tab. Operator rejected sharing the probing screen
// with the tool table (docs/ui-ux/probing-workspace-requirements.md); this
// order moves the probing half of ToolsProbePanel into ProbingPanel,
// unchanged. These are the proofs that survived the move:
//
//   1. the panel is its own view, not embedded in the tool table,
//   2. the original four routine families remain present and reachable
//      (WO-2063, v2 brief: each runs from Start probing - the manual touch
//      buttons, the plan text and the path-clear tick are gone),
//   3. nothing is written to a work offset without a confirmation,
//   4. the second-side (flip-aware) path still refuses rather than guesses
//      when what it is told about the turn disagrees with itself, and still
//      refuses, in the mounted panel, a probed axis with no first-side
//      reference.
//
// jsdom is needed to mount the panel - the repo's vitest env is 'node'
// (vite.config.mts) - exactly as probeRoutines.wo261.test.ts and
// probeAfterFlip.wo289.test.ts flip it for the same reason.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const { planSecondSideProbeZero } = await import('../../lib/machine/probeRoutines')

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

describe('WO-297 ProbingPanel is its own view', () => {
  it('mounts as its own panel, separate from the tool table', () => {
    connectIdle()
    render(React.createElement(ProbingPanel))
    expect(screen.getByTestId('control-probing-panel')).toBeTruthy()
    expect(screen.getByTestId('control-probe-setup-card')).toBeTruthy()
    // Nothing from the tool table came along for the move.
    expect(screen.queryByTestId('control-tools-panel')).toBeNull()
    expect(screen.queryByTestId('control-tools-table')).toBeNull()
    expect(screen.queryByTestId('control-probe-z0')).toBeNull()
  })

  it('retains the original four routine families, present and reachable', () => {
    connectIdle()
    render(React.createElement(ProbingPanel))
    const setupTitle = () => screen.getByTestId('control-probe-setup-card').querySelector('.panel-title')?.textContent
    // Edge is the default routine.
    expect(setupTitle()).toBe('Edge setup')
    for (const [kind, title] of [
      ['outsideCorner', 'Outside corner setup'],
      ['bore', 'Bore setup'],
      ['boss', 'Boss setup'],
      ['edge', 'Edge setup'],
    ] as const) {
      const tile = screen.getByTestId(`control-work-probe-routine-${kind}`)
      fireEvent.click(tile)
      expect(tile.className).toContain('control-chip-active')
      expect(setupTitle()).toBe(title)
      // Each routine runs from the one Start probing, with its own picture.
      expect(screen.getByTestId('control-probe-run-guided')).toBeTruthy()
      expect(screen.getByTestId('probe-picture')).toBeTruthy()
    }
  })
})

describe('WO-372/WO-373 guided feature motion', () => {
  it('runs the executable bore plan it shows, with the size typed in', async () => {
    connectHomed()
    runFeatureProbeCycle.mockResolvedValue({ ok: true, message: 'bore cycle recorded 4 touches.', touches: {}, topMachineZ: null })
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    const diameter = screen.getByTestId('control-work-probe-nominal-diameter') as HTMLInputElement
    fireEvent.change(diameter, { target: { value: '30' } })
    fireEvent.blur(diameter)

    const run = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
    expect(run.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(run)
      await Promise.resolve()
    })
    expect(runFeatureProbeCycle).toHaveBeenCalledOnce()
    // Start probing is the operator's go: the plan runs with the path confirmed.
    expect(runFeatureProbeCycle.mock.calls[0][2]).toBe(true)
    const plan = runFeatureProbeCycle.mock.calls[0][0]
    expect(plan.kind).toBe('bore')
    expect(plan.review.touchOrder.map((t) => `${t.axis}${t.direction}`)).toEqual(['X-', 'X+', 'Y-', 'Y+'])
    // WO-2554: the typed size is for measurement/preview; a seek starts where
    // the operator stands and uses Maximum search, never a nominal approach.
    const first = plan.steps.find((step) => step.kind === 'touch')
    const startX = first && first.kind === 'touch' ? first.expectedStart.x : Number.NaN
    expect(startX).toBe(-50)
    expect(first).toMatchObject({ kind: 'touch', travelMm: 50 })
    expect(plan.steps.filter((step) => step.kind === 'position').every((step) => step.label.startsWith('Return toward start'))).toBe(true)
  })

  // WO-2058: the panel's Boss starts over the middle and crosses at the top it
  // touches + clearance, known only once touched, so the plan it runs carries
  // no start-derived lift or cross-over height (it used to: 'lift 10.000 mm to
  // absolute machine Z ...'). The pendant's beside-the-face plan keeps it.
  it('runs no start-derived boss cross-over: the boss works from the top it touches (WO-2058)', async () => {
    connectHomed()
    runFeatureProbeCycle.mockResolvedValue({ ok: false, message: 'stopped', touches: {}, topMachineZ: null })
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-run-guided'))
      await Promise.resolve()
    })
    const plan = runFeatureProbeCycle.mock.calls[0][0]
    expect(plan.review.clearMotion.kind).toBe('boss-from-top')
    expect(plan.fromTop?.topTouch).toBeTruthy()
  })
})

describe('WO-297 the work-offset confirmation still gates every write', () => {
  it('offers no confirmation before a routine finishes its touches', () => {
    connectIdle()
    render(React.createElement(ProbingPanel))
    expect(screen.queryByTestId('control-work-probe-result')).toBeNull()
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
  })

  it('previews the edge result and writes nothing until Confirm is pressed', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: 'G55' } })
    await runRoutine({ edge: 10 })

    const result = await screen.findByTestId('control-work-probe-result')
    // X+ face, default tip radius 1.5: the face is at 10 + 1.5.
    expect(result.textContent).toContain('X face 11.50 mm.')
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledOnce()
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G55', 'X', 11.5)
  })

  it('gates a completed bore centre the same way', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    // A run that stops after three walls offers nothing to write.
    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5 }, false)
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5, yPositive: 5 })

    const result = await screen.findByTestId('control-work-probe-result')
    expect(result.textContent).toMatch(/centre|center/i)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledTimes(2)
  })
})

// -- second-side (flip-aware) refusals ---------------------------------------

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

describe('WO-297 second-side (flip-aware) path still refuses on disagreement', () => {
  it(
    'refuses when what the setup records about the turn disagrees with what the zero was ' +
    'worked out from',
    () => {
      // The same product function ProbingPanel's confirmation calls
      // (planSecondSideProbeZero, WO-289, untouched by this move). Called
      // directly here because the mounted panel always derives its flipAxis
      // from the very setup record it reads relationship.axis from, so the
      // two can never legitimately disagree through the UI - this refusal is
      // what stands between a contradictory record and a written offset if
      // that ever changes.
      const refusal = planSecondSideProbeZero({
        relationship: { setupId: 'side-1', axis: 'x' },
        flipAxis: 'y',
        frame: { stockSize: { x: 100, y: 50, z: 20 }, originInStock: { x: 0, y: 0, z: 20 } },
        featureOnFirstSideMm: { X: 25 },
        probedMachineMm: { X: -275 },
        firstSideName: 'Top side',
        secondSideName: 'Underside',
        relationshipOffsetG: 56,
        targetOffsetG: 56,
      })
      expect(refusal.ok).toBe(false)
      if (refusal.ok) throw new Error('a contradictory turn produced a zero')
      expect(refusal.code).toBe('SECOND_SIDE_AXIS_DISAGREES')
      expect(refusal.message).toContain('turned about X')
      expect(refusal.message).toContain('turn about Y')
    },
  )

  it('mounted: refuses, in words, a probed axis with no first-side reference', async () => {
    connectHomed()
    installSecondSide()
    render(React.createElement(ProbingPanel))

    expect(screen.getByTestId('control-second-side-statement').textContent).toBe(
      'Setting zero for "Underside" - the second side of "Top side", ' +
      'turned about X (front and back swap).',
    )

    // Both sides run on G56; select it so the disagreement under test is the
    // missing first-side reference, not the offset mismatch.
    fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: 'G56' } })
    await runRoutine({ edge: -275 })

    await waitFor(() => {
      expect(screen.getByTestId('control-second-side-refusal').textContent)
        .toContain('X was probed')
    })
    // No confirmation is offered at all: nothing can be written from a zero
    // the app could not work out. (WO-2063: the result step shows the refusal
    // where Confirm would be.)
    expect(screen.getByTestId('control-work-probe-result').textContent).toContain('X was probed')
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })
})
