// @vitest-environment jsdom
//
// WO-289: find zero again after the part is turned over.
//
// WO-261 gave the machinist probing routines; WO-288 gave a setup the ability
// to record that it IS the second side of another. Neither knew about the
// other, so the join - "I probed this feature, where is this side's zero?" -
// was done in the machinist's head. These are the proofs that the app now does
// it, and refuses rather than guesses when the inputs disagree.
//
//   1. the arithmetic, pure: including the sign trap (a plausible wrong answer
//      asserted against the right one) and the off-centre origin that makes a
//      naive negation wrong,
//   2. the refusals, each naming what disagrees with what,
//   3. a MOUNTED proof that the panel says which side and which axis it is
//      setting, writes the flip-corrected zero, and is UNCHANGED on a setup
//      that is not a second side.
//
// jsdom is needed for (3): the repo's vitest env is 'node' (vite.config.mts),
// so the directive above flips this file exactly as probeRoutines.wo261.test.ts
// and flipSetup.wo288.test.ts do. React is mounted through createElement
// because this is a .ts file (the work order's declared slice).

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhysicalStock, Setup, Vec3 } from '../../types'
import type { SecondSideFrame } from '../../lib/cam/flipSetup'
import {
  planSecondSideProbeZero,
  secondSideStaleTouchRefusal,
  secondSideStatement,
  type SecondSideZeroInput,
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
// WO-297: workpiece probing (including the flip-aware second-side path this
// file proves) moved out of ToolsProbePanel into its own ProbingPanel/Probing
// tab.
// WO-2063 (docs/design/PROBING-SCREEN-V2.md): the manual touch buttons are
// gone - Start probing runs the whole routine; the result, a second-side
// refusal and Confirm sit on the routine's last step. The zeros written and
// every refusal below are unchanged; only the way in is.
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling tests use.
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

// -- the block both sides share ----------------------------------------------
//
// 100 x 50 x 20 mm, sitting at the world origin, zeroed on its FRONT LEFT TOP
// corner. Every number below is measured in that frame.
const TOP_FRONT_LEFT: SecondSideFrame = {
  stockSize: { x: 100, y: 50, z: 20 },
  originInStock: { x: 0, y: 0, z: 20 },
}

function baseInput(overrides: Partial<SecondSideZeroInput> = {}): SecondSideZeroInput {
  return {
    relationship: { setupId: 'side-1', axis: 'x' },
    flipAxis: 'x',
    frame: TOP_FRONT_LEFT,
    featureOnFirstSideMm: {},
    probedMachineMm: {},
    firstSideName: 'Top side',
    secondSideName: 'Underside',
    relationshipOffsetG: 56,
    targetOffsetG: 56,
    ...overrides,
  }
}

describe('WO-289 second-side zero from a probed feature', () => {
  it("sets this side's zero from a feature whose first-side position is known", () => {
    // The block's zero sits at machine (-300, -200). A bore was put through at
    // first-side (25, 15); turned about X it must now read (25, 35), because Y
    // is measured from what is now the BACK face: 50 - 15.
    const plan = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: 25, Y: 15 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    if (!plan.ok) throw new Error(`refused: ${plan.message}`)

    expect(plan.axes).toEqual([
      {
        axis: 'X',
        featureFirstSideMm: 25,
        featureSecondSideMm: 25,          // X carries over a turn about X
        probedMachineMm: -275,
        workZeroMachineMm: -300,
      },
      {
        axis: 'Y',
        featureFirstSideMm: 15,
        featureSecondSideMm: 35,          // 50 - 15: measured from the far face
        probedMachineMm: -165,
        workZeroMachineMm: -200,
      },
    ])

    // THE SIGN TRAP. Negating the feature instead of measuring it from the
    // opposite face gives Y' = -15 and a zero of -150: a perfectly plausible
    // machine coordinate, 50 mm - one whole block - from the right one.
    expect(plan.axes[1].workZeroMachineMm).not.toBe(-150)
  })

  it('answers from where the zero sits inside the block, not from its size alone', () => {
    // Same 100 mm block, turned about Y, but zeroed 30 mm in from the left.
    // X' = 100 - 2*30 - 10 = 30, not -10.
    const offCentre: SecondSideFrame = {
      stockSize: { x: 100, y: 50, z: 20 },
      originInStock: { x: 30, y: 0, z: 20 },
    }
    const plan = planSecondSideProbeZero(baseInput({
      relationship: { setupId: 'side-1', axis: 'y' },
      flipAxis: 'y',
      frame: offCentre,
      featureOnFirstSideMm: { X: 10 },
      probedMachineMm: { X: -270 },
    }))
    if (!plan.ok) throw new Error(`refused: ${plan.message}`)

    expect(plan.axes[0].featureSecondSideMm).toBe(30)
    expect(plan.axes[0].workZeroMachineMm).toBe(-300)
    // Negating would put the zero at -260 - plausible, and 40 mm wrong.
    expect(plan.axes[0].workZeroMachineMm).not.toBe(-260)
  })

  it('reads one axis at a time, so a reference on the other cannot move this one', () => {
    // The per-axis call in probeRoutines relies on flipPointToSecondSide
    // mapping X from X and Y from Y only. If flipSetup.ts ever couples them,
    // this fails here rather than a wrong zero reaching an offset table.
    const withOneY = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: 25, Y: 15 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    const withAnotherY = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: 25, Y: -40 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    if (!withOneY.ok || !withAnotherY.ok) throw new Error('refused')

    expect(withAnotherY.axes[0]).toEqual(withOneY.axes[0])
    expect(withAnotherY.axes[1]).not.toEqual(withOneY.axes[1])
  })

  it('turning about X and turning about Y give different zeros, so neither is guessed', () => {
    const aboutX = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: 25, Y: 15 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    const aboutY = planSecondSideProbeZero(baseInput({
      relationship: { setupId: 'side-1', axis: 'y' },
      flipAxis: 'y',
      featureOnFirstSideMm: { X: 25, Y: 15 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    if (!aboutX.ok || !aboutY.ok) throw new Error('refused')
    expect(aboutX.axes).not.toEqual(aboutY.axes)
  })

  it('states which side it is setting and which way the part was turned', () => {
    expect(secondSideStatement('Underside', 'Top side', 'x')).toBe(
      'Setting zero for "Underside" - the second side of "Top side", ' +
      'turned about X (front and back swap).',
    )
    expect(secondSideStatement('Underside', 'Top side', 'y')).toContain(
      'turned about Y (left and right swap)',
    )
  })
})

describe('WO-289 refusals - the disagreement is named, never resolved', () => {
  it('refuses when the setup and the arithmetic disagree about which way it turned', () => {
    const refusal = planSecondSideProbeZero(baseInput({
      relationship: { setupId: 'side-1', axis: 'x' },
      flipAxis: 'y',
      featureOnFirstSideMm: { X: 25 },
      probedMachineMm: { X: -275 },
    }))
    expect(refusal.ok).toBe(false)
    if (refusal.ok) throw new Error('a contradictory turn produced a zero')
    expect(refusal.code).toBe('SECOND_SIDE_AXIS_DISAGREES')
    // Both readings are named. Picking one silently is the failure this exists
    // to prevent: each gives a plausible zero and only one matches the part.
    expect(refusal.message).toContain('turned about X')
    expect(refusal.message).toContain('turn about Y')
    expect(refusal.message).toContain('Underside')
  })

  it('refuses to write a second-side zero into an offset the two sides do not run on', () => {
    const refusal = planSecondSideProbeZero(baseInput({
      targetOffsetG: 54,
      featureOnFirstSideMm: { X: 25 },
      probedMachineMm: { X: -275 },
    }))
    if (refusal.ok) throw new Error('wrote toward the wrong offset')
    expect(refusal.code).toBe('SECOND_SIDE_OFFSET_DISAGREES')
    expect(refusal.message).toContain('G56')
    expect(refusal.message).toContain('G54')
  })

  it('refuses a probed axis with no first-side reference instead of assuming zero', () => {
    // Assuming 0 would mean "the feature IS the zero" - exactly what WO-261
    // does on a first side, and exactly wrong here.
    const refusal = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: 25 },
      probedMachineMm: { X: -275, Y: -165 },
    }))
    if (refusal.ok) throw new Error('guessed a missing reference')
    expect(refusal.code).toBe('SECOND_SIDE_REFERENCE_MISSING')
    expect(refusal.message).toContain('Y was probed')
    expect(refusal.message).toContain('Top side')
  })

  it('refuses when nothing has been probed yet', () => {
    const refusal = planSecondSideProbeZero(baseInput({ featureOnFirstSideMm: { X: 25 } }))
    if (refusal.ok) throw new Error('produced a zero from no probe result')
    expect(refusal.code).toBe('SECOND_SIDE_NOTHING_PROBED')
  })

  it('names the setup when the touches on hand were taken under a different one', () => {
    const refusal = secondSideStaleTouchRefusal('Underside')
    expect(refusal.ok).toBe(false)
    expect(refusal.code).toBe('SECOND_SIDE_TOUCHES_NOT_THIS_SETUP')
    expect(refusal.message).toContain('a different setup was active')
    expect(refusal.message).toContain('Underside')
    expect(refusal.message).toContain('Probe this side again')
  })

  it('refuses a reference or a probe result that is not a finite number', () => {
    const refusal = planSecondSideProbeZero(baseInput({
      featureOnFirstSideMm: { X: Number.NaN },
      probedMachineMm: { X: -275 },
    }))
    if (refusal.ok) throw new Error('produced a zero from NaN')
    expect(refusal.code).toBe('SECOND_SIDE_INPUT_NOT_FINITE')
  })
})

// -- mounted -------------------------------------------------------------------

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

/** Zero on the block's FRONT LEFT TOP corner (row 2, col 0). Both sides share
 *  it: the block did not move, the part under it did. */
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

function installProject(setups: Setup[], activeSetupId: string): void {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        stocks: [block()],
        setups,
        activeSetupId,
        geometry: [] as unknown as typeof s.project.geometry,
        nests: [] as unknown as typeof s.project.nests,
      },
    }))
  })
}

/** Second side of "Top side", turned about X, on the same block. */
function installSecondSide(): void {
  installProject(
    [
      sideSetup('side-1', 'Top side'),
      sideSetup('side-2', 'Underside', { setupId: 'side-1', axis: 'x' }),
    ],
    'side-2',
  )
}

/** TWO different second sides of the same first side, turned different ways.
 *  A reference or a touch that belongs to one gives a plausible - and wrong -
 *  zero on the other: a feature at first-side X 25 must read 25 after a turn
 *  about X and 75 after a turn about Y on this 100 mm block. */
function installTwoSecondSides(): void {
  installProject(
    [
      sideSetup('side-1', 'Top side'),
      sideSetup('side-2', 'Underside', { setupId: 'side-1', axis: 'x' }),
      sideSetup('side-2b', 'End-for-end underside', { setupId: 'side-1', axis: 'y' }),
    ],
    'side-2',
  )
}

/** What the rest of the app does when the machinist picks another setup: the
 *  panel is never remounted (ControlPage retains it for the session), so this
 *  is the only thing that changes under it. */
function switchActiveSetup(id: string): void {
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: id } }))
  })
}

function shownIn(testId: string): string {
  return (screen.getByTestId(testId) as HTMLInputElement).value
}

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
    settings: { 23: '0', 27: '1', 130: '400', 131: '400', 132: '50' },
  })
}

type TouchKey = import('../../lib/machine/probeFeatureCycle').ProbeCycleTouchKey

/** Start probing, with the runner reporting each touch as it lands (onTouch),
 *  exactly as runFeatureProbeCycle does, then the run ends. */
async function runRoutine(touches: Partial<Record<TouchKey, number>>) {
  runFeatureProbeCycle.mockImplementationOnce(async (_plan, _config, _clear, onTouch) => {
    for (const [key, mm] of Object.entries(touches)) onTouch?.(key as TouchKey, mm as number)
    return { ok: true, message: 'cycle recorded its touches.', touches, topMachineZ: null }
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-probe-run-guided'))
    await Promise.resolve()
  })
}

/** The Edge face the pre-v2 defaults touched (X-), so the numbers below are
 *  the ones WO-289 shipped with: a touch at -275 is the face at -276.5. */
function faceXminus() {
  fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'X-' } })
}

/** The routine's last step: its result, a second-side refusal, and Confirm. */
function resultStep(): HTMLElement {
  const chips = screen.getAllByTestId(/^probing-step-chip-/)
  fireEvent.click(chips[chips.length - 1])
  return screen.getByTestId('control-work-probe-result')
}

/** Confirm is offered only for a zero the app could work out. */
function confirmOffered(): boolean {
  const apply = screen.queryByTestId('control-work-probe-apply') as HTMLButtonElement | null
  return apply !== null && !apply.disabled
}

/** Type a first-side feature position into the panel's reference field. */
function enterFeature(axis: 'X' | 'Y', mm: number) {
  const field = screen.getByTestId(`control-second-side-feature-${axis}`)
  fireEvent.change(field, { target: { value: String(mm) } })
  fireEvent.blur(field)
}

function selectWcs(wcs: string) {
  fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: wcs } })
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

describe('WO-289 mounted ProbingPanel on a second-side setup', () => {
  it('says which side it is setting and which way the part was turned', () => {
    connectIdle()
    installSecondSide()
    render(React.createElement(ProbingPanel))

    expect(screen.getByTestId('control-second-side-statement').textContent).toBe(
      'Setting zero for "Underside" - the second side of "Top side", ' +
      'turned about X (front and back swap).',
    )
    // And it asks where the feature sits on the first side, by that side's name.
    expect(screen.getByTestId('control-probe-setup-card').textContent).toContain('Feature X on Top side')
    expect(screen.getByTestId('control-second-side-feature-X')).toBeTruthy()
  })

  it('turns a probed bore centre into this side\'s zero, with the turn accounted for', async () => {
    connectHomed()
    installSecondSide()
    render(React.createElement(ProbingPanel))

    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    selectWcs('G56')
    enterFeature('X', 25)
    enterFeature('Y', 15)

    // The bore centre lands at machine (-275, -165) - the block's zero is at
    // (-300, -200) and the flipped feature reads (25, 35) from it.
    await runRoutine({ xNegative: -280, xPositive: -270, yNegative: -170, yPositive: -160 })

    const result = resultStep()
    expect(result.textContent).toContain('Centre at machine X -275.00 Y -165.00')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('Centre at machine X -10.827 Y -6.496')
    expect(result.textContent).toContain('Writes G56 X=-11.811 in, Y=-7.874 in')
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(1, 'G56', 'X', -300)
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(2, 'G56', 'Y', -200)
    // Not the probed centre (WO-261's first-side answer), and not the sign trap.
    expect(setWorkOffsetValue).not.toHaveBeenCalledWith('G56', 'Y', -165)
    expect(setWorkOffsetValue).not.toHaveBeenCalledWith('G56', 'Y', -150)
  })

  it('refuses, in words, when the probed feature has no first-side position', async () => {
    connectHomed()
    installSecondSide()
    render(React.createElement(ProbingPanel))
    faceXminus()
    selectWcs('G56')

    await runRoutine({ edge: -275 })

    resultStep()
    await waitFor(() => {
      expect(screen.getByTestId('control-second-side-refusal').textContent)
        .toContain('X was probed')
    })
    // No confirmation is offered at all: nothing can be written from a zero the
    // app could not work out.
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })

  it('refuses when the panel would write an offset the two sides do not run on', async () => {
    connectHomed()
    installSecondSide()
    render(React.createElement(ProbingPanel))
    faceXminus()

    // Left on the controller's active G54; both sides run on the block's G56.
    enterFeature('X', 25)
    await runRoutine({ edge: -275 })

    resultStep()
    await waitFor(() => {
      const text = screen.getByTestId('control-second-side-refusal').textContent ?? ''
      expect(text).toContain('G56')
      expect(text).toContain('G54')
    })
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    // Selecting the offset the relationship names clears it and the zero appears.
    selectWcs('G56')
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledOnce()
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G56', 'X', -301.5)
  })

  // -- the active setup changing under a retained panel -----------------------
  //
  // ControlPage mounts this panel once and RETAINS it (display:none, never
  // unmounted) so a live serial session survives tab switches. Nothing about
  // that lifecycle is scoped to the active setup, so a machinist can type a
  // first-side reference for one second side, pick a different second side
  // elsewhere in the app, and come back to a panel whose statement names the
  // new setup. Anything the panel still holds from before that switch belongs
  // to another part.

  it('does not carry a first-side reference across a switch to another second side', async () => {
    connectHomed()
    installTwoSecondSides()
    render(React.createElement(ProbingPanel))
    faceXminus()
    selectWcs('G56')
    enterFeature('X', 25)
    expect(shownIn('control-second-side-feature-X')).toBe('25.00')

    // The other second side is picked elsewhere in the app: no remount, and no
    // routine/axis/direction control touched here.
    switchActiveSetup('side-2b')

    const statement = screen.getByTestId('control-second-side-statement').textContent ?? ''
    expect(statement).toContain('Setting zero for "End-for-end underside"')
    expect(statement).toContain('turned about Y (left and right swap)')
    // The number typed for "Underside" is GONE - not sitting in this setup's
    // box looking exactly like one typed for it.
    expect(shownIn('control-second-side-feature-X')).toBe('')

    await runRoutine({ edge: -275 })
    resultStep()
    await waitFor(() => {
      expect(screen.getByTestId('control-second-side-refusal').textContent)
        .toContain('X was probed')
    })
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    // Given a reference typed for THIS setup, the zero appears - worked out for
    // the turn THIS setup records.
    enterFeature('X', 40)
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G56', 'X', -336.5)
    // What the carried-over 25 would have written on this setup's Y turn: a
    // plausible machine coordinate, 15 mm out.
    expect(setWorkOffsetValue).not.toHaveBeenCalledWith('G56', 'X', -351.5)
  })

  it("will not build this setup's zero from touches taken under the old one", async () => {
    connectHomed()
    installTwoSecondSides()
    render(React.createElement(ProbingPanel))
    faceXminus()
    selectWcs('G56')
    enterFeature('X', 25)
    await runRoutine({ edge: -275 })
    // Live and correct on "Underside" before the switch.
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)

    switchActiveSetup('side-2b')

    resultStep()
    await waitFor(() => {
      expect(screen.getByTestId('control-second-side-refusal').textContent)
        .toContain('a different setup was active')
    })
    // A reference typed FOR the setup now active does not release it: the touch
    // is still the other part's measurement.
    enterFeature('X', 40)
    resultStep()
    expect(screen.getByTestId('control-second-side-refusal').textContent)
      .toContain('Probe this side again')
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    // Probing this side replaces that touch, and the zero appears.
    await runRoutine({ edge: -275 })
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G56', 'X', -336.5)
  })

  it('holds still when the relationship will not resolve, rather than probing on', async () => {
    connectHomed()
    // The first side is gone: "the second side of" names a setup that no longer
    // exists, so there is no block relationship to correct anything with.
    installProject([sideSetup('side-2', 'Underside', { setupId: 'ghost', axis: 'x' })], 'side-2')
    render(React.createElement(ProbingPanel))

    expect(screen.getByTestId('control-second-side-blocked').textContent)
      .toContain('no longer exists')
    expect(screen.queryByTestId('control-second-side-feature-X')).toBeNull()

    faceXminus()
    await runRoutine({ edge: -275 })
    // The run still reports, but no confirmation is offered: falling back to
    // the first-side answer here would write a zero one face out.
    expect(useMachineControl.getState().consoleLines.map((line) => line.text))
      .toContain('cycle recorded its touches.')
    resultStep()
    expect(confirmOffered()).toBe(false)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })
})

describe('WO-289 leaves first-side probing exactly as it was', () => {
  it('shows no second-side wording and writes the compensated coordinate itself', async () => {
    connectHomed()
    installProject([sideSetup('side-1', 'Top side')], 'side-1')
    render(React.createElement(ProbingPanel))

    expect(screen.queryByTestId('control-second-side-statement')).toBeNull()
    expect(screen.queryByTestId('control-second-side-feature-X')).toBeNull()

    faceXminus()
    await runRoutine({ edge: 10 })
    const result = resultStep()
    expect(result.textContent).toContain('X face 8.50 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('X face 0.335 in')
    expect(result.textContent).not.toContain('Setting zero for')
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(screen.getByTestId('control-work-probe-apply').getAttribute('data-tooltip')).toContain('Write G54')

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledOnce()
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G54', 'X', 8.5)
  })

  it('keeps a first-side touch across a setup change, exactly as WO-261 shipped', async () => {
    // The setup scoping added for second sides is deliberately not applied
    // here. With no flipOf the panel never reads the setup at all: the answer
    // is the compensated machine coordinate itself, which is true of the
    // machine whatever setup is selected. Changing that would be changing
    // first-side probing, which this order forbids.
    connectHomed()
    installProject(
      [sideSetup('side-1', 'Top side'), sideSetup('side-1b', 'Another top')],
      'side-1',
    )
    render(React.createElement(ProbingPanel))

    faceXminus()
    await runRoutine({ edge: 10 })
    switchActiveSetup('side-1b')

    const result = resultStep()
    expect(result.textContent).toContain('X face 8.50 mm')
    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    expect(result.textContent).toContain('X face 0.335 in')
    expect(screen.queryByTestId('control-second-side-statement')).toBeNull()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G54', 'X', 8.5)
  })
})
