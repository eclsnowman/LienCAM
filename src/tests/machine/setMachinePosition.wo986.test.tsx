// @vitest-environment jsdom
//
// WO-986: typing a machine position ESTABLISHES a datum. The safety controls
// below watch the real simulator's position remain unchanged on refusal; they
// do not merely assert that a guard function or mock was called.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  setMachinePosition,
  triggerEmergencyStop,
} = await import('../../lib/machine/machineSession')
type MachineController = import('../../lib/machine/controller').MachineController


describe('WO-986 manual machine datum', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    mem.clear()
    useCamStore.getState().newProject()
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({ ...machine, noHomingSwitches: true })
    useUiPrefs.setState({ collapsedPropsGroups: {} })
    await connectMachine('simulator')
    __resetEstopInterlockForTest()
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  // WO-993 REPIN, 2026-08-25. These two drove the "Set machine position"
  // BUTTON, and Operator DELETED that control: "we already have a mechanism to do
  // that and that's by typing the values into the machine. Dro readouts. that
  // should be our mechanism not adding another f****** button."
  //
  // The BEHAVIOUR these tests prove is unchanged and still required - the datum
  // seam is kept and WO-994 will drive it from the DRO. So they are repinned
  // onto `setMachinePosition` directly rather than deleted. Nothing was
  // weakened: every assertion about position, homed state, the store and the
  // dashed readout survives verbatim. What is gone is the click on a control
  // that no longer exists.
  it('round-trips XYZ through the datum seam and opens the coordinate gates', () => {
    const ctrl = getMachineController()
    const before = ctrl.status().machinePos
    render(<ControlPage />)

    expect((screen.getByTestId('control-dro-machine-x') as HTMLInputElement).value).toBe('---')
    expect((screen.getByTestId('control-dro-machine-y') as HTMLInputElement).value).toBe('---')
    expect((screen.getByTestId('control-dro-machine-z') as HTMLInputElement).value).toBe('---')
    expect(ctrl.status().machinePos).toEqual(before)
    expect(ctrl.homedThisSession()).toBe(false)

    const result = setMachinePosition({ x: 12.5, y: -7.25, z: 3 })
    expect(result.ok).toBe(true)

    expect(ctrl.status().machinePos).toEqual({ x: 12.5, y: -7.25, z: 3 })
    expect(ctrl.status().homed).toEqual({ X: true, Y: true, Z: true })
    expect(ctrl.homedThisSession()).toBe(true)
    expect(useMachineControl.getState().homed).toBe(true)
    expect(useMachineControl.getState().mpos).toEqual({ x: 12.5, y: -7.25, z: 3 })
  })

  it('THE DELETED BUTTON STAYS DELETED: no "set machine position" control in the jog panel', () => {
    render(<JogPanel />)
    // Operator's ruling is that this is the wrong MECHANISM, not the wrong
    // placement, so a re-add anywhere in this panel is the regression - not
    // just a re-add on its own row.
    expect(screen.queryByTestId('control-set-machine-position')).toBeNull()
    expect(screen.queryByTestId('control-set-position-confirm')).toBeNull()
  })

  it('NEGATIVE CONTROL: a running program is watched refusing without changing position', () => {
    const ctrl = getMachineController()

    const before = ctrl.status().machinePos
    expect(ctrl.loadMoves?.([{ id: 986, kind: 'line', to: { x: before!.x + 1 }, feedMmMin: 60 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    expect(ctrl.hasActiveJob()).toBe(true)

    const result = setMachinePosition({ x: 40, y: 41, z: 42 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('program is running')
    expect(ctrl.status().machinePos).toEqual(before)
    expect(ctrl.homedThisSession()).toBe(false)
  })

  it('NEGATIVE CONTROL: a latched E-STOP is watched refusing without changing position', () => {
    const ctrl = getMachineController()
    const before = ctrl.status().machinePos

    triggerEmergencyStop()
    const result = setMachinePosition({ x: 8, y: 9, z: 10 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('software stop')
    expect(ctrl.status().machinePos).toEqual(before)
    expect(ctrl.homedThisSession()).toBe(false)
  })

  it('refuses an unwired backend instead of faking a datum', () => {
    const ctrl = getMachineController() as MachineController & {
      setMachinePosition?: MachineController['setMachinePosition']
    }
    ctrl.setMachinePosition = undefined
    const before = ctrl.status().machinePos

    const result = setMachinePosition({ x: 1, y: 2, z: 3 })

    expect(result).toEqual({
      ok: false,
      reason: 'Setting the machine position is not wired on this controller backend yet.',
    })
    expect(ctrl.status().machinePos).toEqual(before)
    expect(ctrl.homedThisSession()).toBe(false)
  })
})
