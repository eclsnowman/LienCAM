// @vitest-environment jsdom
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
// WO-297: workpiece probing (including the flip-aware second-side path this
// file proves) moved out of ToolsProbePanel into its own ProbingPanel/Probing
// tab.
// WO-2063 (docs/design/PROBING-SCREEN-V2.md): the manual touch buttons are
// gone - Start probing runs the whole routine; the result, a second-side
// refusal and Confirm sit on the routine's last step. The zeros written and
// every refusal below are unchanged; only the way in is.
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
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

function switchActiveSetup(id: string): void {
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: id } }))
  })
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
  __resetProbingSessionForTest()
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


describe('WO-3108 active saved second-side frame', () => {
  it.each(['x', 'y'] as const)('uses each active child on a %s turn and retains stale-touch protection', async axis => {
    connectHomed()
    const parent = sideSetup('parent', 'Top side')
    parent.wcs.origin = { x: 30, y: -40, z: 32 }
    const childA = sideSetup('child-a', 'Underside A', { setupId: parent.id, axis })
    const childB = sideSetup('child-b', 'Underside B', { setupId: parent.id, axis })
    // Different explicit frames on the SAME parent/axis: a sibling guess cannot pass.
    Object.assign(childA.wcs, { fixtureOffset: 55, fixtureOffsetOwner: 'setup', label: 'G55',
      origin: axis === 'x' ? { x: 30, y: 10, z: 12 } : { x: 130, y: -40, z: 12 } })
    Object.assign(childB.wcs, { fixtureOffset: 58, fixtureOffsetOwner: 'setup', label: 'G58',
      origin: { x: 80, y: -15, z: 22 } })
    const setups = [parent, childA, childB]
    installProject(setups, childA.id)
    act(() => useCamStore.setState(s => ({ project: { ...s.project,
      stocks: s.project.stocks!.map(st => ({ ...st, position: { x: 30, y: -40, z: 12 } })) } })))
    const before = JSON.parse(JSON.stringify(useCamStore.getState().project))
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    selectWcs('G55')
    enterFeature('X', 25)
    enterFeature('Y', 15)
    const picture = screen.getByTestId('probe-picture').outerHTML
    await runRoutine({ xNegative: -280, xPositive: -270, yNegative: -170, yPositive: -160 })
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    // Independent world oracle: reflected feature world is (55,-5,15) for X,
    // (105,-25,15) for Y. Subtract the explicitly saved child zero.
    const worldFeature = axis === 'x' ? { x: 55, y: -5 } : { x: 105, y: -25 }
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(1, 'G55', 'X', -275 - (worldFeature.x - childA.wcs.origin.x))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(2, 'G55', 'Y', -165 - (worldFeature.y - childA.wcs.origin.y))
    const firstCycle = runFeatureProbeCycle.mock.calls[0][0]
    setWorkOffsetValue.mockClear()
    switchActiveSetup(childB.id)
    selectWcs('G58')
    resultStep()
    expect(confirmOffered()).toBe(false)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
    enterFeature('X', 25)
    enterFeature('Y', 15)
    // Reusing the prior touches after switching setups remains prohibited.
    resultStep()
    expect(confirmOffered()).toBe(false)
    await runRoutine({ xNegative: -280, xPositive: -270, yNegative: -170, yPositive: -160 })
    resultStep()
    expect(screen.queryByTestId('control-second-side-refusal')).toBeNull()
    expect(confirmOffered()).toBe(true)
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(1, 'G58', 'X', -275 - (worldFeature.x - childB.wcs.origin.x))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(2, 'G58', 'Y', -165 - (worldFeature.y - childB.wcs.origin.y))
    expect(runFeatureProbeCycle.mock.calls[1][0]).toEqual(firstCycle)
    expect(useCamStore.getState().project.setups).toEqual(before.setups)
    expect(picture).toContain('svg')
  })

  it('retains legacy shared-origin results and unchanged first-side sequencing', async () => {
    connectHomed()
    const parent = sideSetup('parent', 'Top side')
    const child = sideSetup('legacy', 'Legacy underside', { setupId: parent.id, axis: 'x' })
    installProject([parent, child], parent.id)
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    selectWcs('G56')
    const firstPicture = screen.getByTestId('probe-picture').outerHTML
    await runRoutine({ xNegative: -280, xPositive: -270, yNegative: -170, yPositive: -160 })
    resultStep()
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(1, 'G56', 'X', -275)
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(2, 'G56', 'Y', -165)
    const firstCycle = runFeatureProbeCycle.mock.calls[0][0]
    cleanup()
    __resetProbingSessionForTest()
    setWorkOffsetValue.mockClear()
    switchActiveSetup(child.id)
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    selectWcs('G56')
    enterFeature('X', 25)
    enterFeature('Y', 15)
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(firstPicture)
    await runRoutine({ xNegative: -280, xPositive: -270, yNegative: -170, yPositive: -160 })
    expect(runFeatureProbeCycle.mock.calls[1][0]).toEqual(firstCycle)
    resultStep()
    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(1, 'G56', 'X', -300)
    expect(setWorkOffsetValue).toHaveBeenNthCalledWith(2, 'G56', 'Y', -200)
    selectWcs('G54')
    resultStep()
    expect(confirmOffered()).toBe(false)
    expect(screen.getByTestId('control-second-side-refusal').textContent).toContain('G56')
  })
})
