// @vitest-environment jsdom
//
// WO-2213: the Position panel's typed WORK goto lands on the typed work
// position under a rotated work system. WO-2204 measured it on LinuxCNC
// (src/tests/evidence/WO-2204/routes.md): at G55 30 deg, "work X 20" typed
// from work (0,20) jogged `20 - 0` along MACHINE X and ended at work
// (17.3205, 10). The machine goto (G53 frame) is right and must not change;
// at 0 deg every move is what it was.
//
// The controller here is the session's own (the disconnected GRBL backend)
// with its reports and motion verbs spied, so the test states what the
// controller reports and records what the Position panel asks of it. Where
// each request lands is computed with the controllers' own rule
// (docs/design/WCS-ROTATION.md): machine = O + Rot(R)(work); a jog moves one
// MACHINE axis; `jogToWorkXY` takes a work point and the controller turns it.
// The real controllers are driven by the Tier 2 file beside this one's
// evidence (src/tests/evidence/WO-2213/).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
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
  } as never,
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { __resetEstopInterlockForTest, getMachineController } = await import('../../lib/machine/machineSession')

type XY = { x: number; y: number }

/** G55's origin, machine mm, on GRBL's negative frame (-travel..0). */
const O: XY = { x: -180, y: -100 }
const RAPID = 6000

function rot(deg: number, p: XY): XY {
  const a = (deg * Math.PI) / 180
  return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }
}
const machineOf = (deg: number, work: XY): XY => {
  const t = rot(deg, work)
  return { x: O.x + t.x, y: O.y + t.y }
}
const workOf = (deg: number, machine: XY): XY => rot(-deg, { x: machine.x - O.x, y: machine.y - O.y })

/**
 * A GRBL machine with its rapid stated. Its travel reaches the Position panel's
 * envelope through the $130-$132 the controller reports (standAt): -travel..0.
 */
function selectMachine(travel: { x: number; y: number; z: number }): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo2213-rotated-goto',
    name: 'WO-2213 rotated goto fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel,
    rapidRate: RAPID,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
}

interface Reports {
  /** The bridge's route: the rotation rides the status frame. */
  frameRotation?: number
  /** LinuxCNC's route: the rotation keyed by work system. */
  wcsRotations?: Record<string, number>
}

/**
 * Stand the machine at work `work` in G55 rotated `deg`, with the controller
 * reporting that rotation the way `reports` says, and record every motion
 * request. Returns the recorder and a function that says where the recorded
 * requests leave the machine, in work coordinates.
 */
function standAt(deg: number, work: XY, reports: Reports, homed = true) {
  const travel = useCamStore.getState().project.machine.travel
  const machine = machineOf(deg, work)
  const mpos = { x: machine.x, y: machine.y, z: -40 }
  const wpos = { x: work.x, y: work.y, z: 40 }
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    alarm: null,
    homed,
    mpos,
    wpos,
    activeWcs: 'G55',
    settings: { 130: String(travel.x), 131: String(travel.y), 132: String(travel.z) },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  const ctrl = getMachineController()
  const baseStatus = ctrl.status()
  vi.spyOn(ctrl, 'status').mockReturnValue({
    ...baseStatus,
    machinePos: mpos,
    workPos: wpos,
    ...(reports.frameRotation !== undefined ? { workRotation: reports.frameRotation } : {}),
  } as ReturnType<typeof ctrl.status>)
  if (reports.wcsRotations) {
    ;(ctrl as { wcsRotations?: () => Record<string, number> | null }).wcsRotations = () => reports.wcsRotations!
  } else {
    delete (ctrl as { wcsRotations?: unknown }).wcsRotations
  }
  vi.spyOn(ctrl, 'verifiedIdle').mockReturnValue(true)
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  const jog = vi.spyOn(ctrl, 'jog').mockReturnValue(true)
  const jogToWorkXY = vi.spyOn(ctrl, 'jogToWorkXY').mockReturnValue(true)
  /** Where the requests sent so far leave the machine, as work XY. */
  const landing = (): XY => {
    let m: XY = { ...machine }
    for (const [axis, delta] of jog.mock.calls) {
      if (axis === 'X') m = { x: m.x + delta, y: m.y }
      if (axis === 'Y') m = { x: m.x, y: m.y + delta }
    }
    for (const [x, y] of jogToWorkXY.mock.calls) m = machineOf(deg, { x, y })
    return workOf(deg, m)
  }
  return { jog, jogToWorkXY, landing, machine }
}

function dro(column: 'work' | 'machine', axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-${column}-${axis}`) as HTMLInputElement
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

beforeEach(() => {
  useCamStore.getState().newProject()
  selectMachine({ x: 250, y: 250, z: 100 })
  useUiPrefs.setState({ machineGotoSkipConfirm: true, machineDisplayUnits: 'mm' })
  __resetEstopInterlockForTest()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (getMachineController() as { wcsRotations?: unknown }).wcsRotations
})

describe('WO-2213 the typed WORK goto under a rotated work system', () => {
  it('LinuxCNC route (rotation keyed by system): work X 20 from work (0,20) at G55 30 deg lands on work (20,20)', () => {
    const run = standAt(30, { x: 0, y: 20 }, { wcsRotations: { G55: 30 } })
    render(<ControlPage />)

    commit(dro('work', 'x'), '20')

    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY.mock.calls).toEqual([[20, 20, RAPID]])
    const at = run.landing()
    expect(at.x).toBeCloseTo(20, 6)
    expect(at.y).toBeCloseTo(20, 6)
  })

  it('AXBB-E route (rotation in the status frame): work Y -15 from work (12.5,20) at -12.5 deg holds work X', () => {
    const run = standAt(-12.5, { x: 12.5, y: 20 }, { frameRotation: -12.5 })
    render(<ControlPage />)

    commit(dro('work', 'y'), '-15')

    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY.mock.calls).toEqual([[12.5, -15, RAPID]])
    const at = run.landing()
    expect(at.x).toBeCloseTo(12.5, 6)
    expect(at.y).toBeCloseTo(-15, 6)
  })

  it('through the confirm card too: Move sends the same work-frame request', () => {
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    const run = standAt(30, { x: 0, y: 20 }, { wcsRotations: { G55: 30 } })
    render(<ControlPage />)

    commit(dro('work', 'x'), '20')
    expect(run.jogToWorkXY).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))

    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY.mock.calls).toEqual([[20, 20, RAPID]])
    const at = run.landing()
    expect(at.x).toBeCloseTo(20, 6)
    expect(at.y).toBeCloseTo(20, 6)
  })

  it('the frame says the active system is unrotated (another one is): the single-axis jog it was', () => {
    const run = standAt(0, { x: 0, y: 20 }, { frameRotation: 0, wcsRotations: { G54: 30 } })
    render(<ControlPage />)

    commit(dro('work', 'x'), '20')

    expect(run.jogToWorkXY).not.toHaveBeenCalled()
    expect(run.jog.mock.calls).toEqual([['X', 20, RAPID]])
  })

  it('LinuxCNC route, some system rotated but not which one is active: the work-frame request, exact at 0 deg too', () => {
    // LinuxCNC reports each system's rotation, not which system it runs in;
    // the store's activeWcs (G55 here) is only the app's last selection.
    // The work-frame request lands on the typed point whatever the rotation.
    const run = standAt(0, { x: 0, y: 20 }, { wcsRotations: { G54: 30, G55: 0 } })
    render(<ControlPage />)

    commit(dro('work', 'x'), '20')

    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY.mock.calls).toEqual([[20, 20, RAPID]])
    const at = run.landing()
    expect(at.x).toBeCloseTo(20, 6)
    expect(at.y).toBeCloseTo(20, 6)
  })

  it('work Z under a rotation is the Z jog it always was (the rotation is about Z)', () => {
    const run = standAt(30, { x: 0, y: 20 }, { wcsRotations: { G55: 30 } })
    render(<ControlPage />)

    commit(dro('work', 'z'), '25')

    expect(run.jogToWorkXY).not.toHaveBeenCalled()
    expect(run.jog.mock.calls).toEqual([['Z', -15, RAPID]])
  })

  it('the MACHINE goto is unchanged under a rotation: one jog along the machine axis', () => {
    const run = standAt(30, { x: 0, y: 20 }, { wcsRotations: { G55: 30 }, frameRotation: 30 })
    render(<ControlPage />)

    commit(dro('machine', 'x'), '-100')

    expect(run.jogToWorkXY).not.toHaveBeenCalled()
    expect(run.jog).toHaveBeenCalledTimes(1)
    expect(run.jog.mock.calls[0][0]).toBe('X')
    expect(run.jog.mock.calls[0][1]).toBeCloseTo(-100 - run.machine.x, 9)
    expect(run.jog.mock.calls[0][2]).toBe(RAPID)
  })

  it('at 0 deg the work goto is exactly the single-axis jog it was', () => {
    for (const reports of [{}, { frameRotation: 0 }, { wcsRotations: {} }, { wcsRotations: { G54: 0, G55: 0 } }] as Reports[]) {
      const run = standAt(0, { x: 0, y: 20 }, reports)
      render(<ControlPage />)

      commit(dro('work', 'x'), '20')
      commit(dro('work', 'y'), '-5')

      expect(run.jogToWorkXY, JSON.stringify(reports)).not.toHaveBeenCalled()
      expect(run.jog.mock.calls, JSON.stringify(reports)).toEqual([['X', 20, RAPID], ['Y', -25, RAPID]])
      cleanup()
      vi.restoreAllMocks()
    }
  })

  it('checks the travel at the machine point the turned move reaches, not along one machine axis', () => {
    // Travel -250..0 x -120..0. From work (0,20) at 30 deg (machine -190,
    // -82.68): work X 170 reaches machine (-42.78, 2.32) - past Y 0, though
    // the X offset alone (machine X -20) is inside. Refused, naming machine Y.
    selectMachine({ x: 250, y: 120, z: 100 })
    const run = standAt(30, { x: 0, y: 20 }, { frameRotation: 30 })
    render(<ControlPage />)
    const before = consoleErrors()

    commit(dro('work', 'x'), '170')

    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY).not.toHaveBeenCalled()
    expect(consoleErrors().slice(before.length)).toEqual([
      "Goto X work: refused - machine Y 2.32 mm is outside the machine's travel (-120.00 to 0.00 mm).",
    ])
  })

  it('does not refuse a turned move that stays inside the travel although the unturned sum would not', () => {
    // Travel -250..0 square. Work X 150 from work (0,-100) at 30 deg (machine
    // -130, -186.60) reaches machine (-0.10, -111.60): inside. The X offset
    // alone would say machine X 20 - outside - and refuse a move the machine
    // can make.
    const run = standAt(30, { x: 0, y: -100 }, { frameRotation: 30 })
    render(<ControlPage />)
    const before = consoleErrors()

    commit(dro('work', 'x'), '150')

    expect(consoleErrors().slice(before.length)).toEqual([])
    expect(run.jogToWorkXY.mock.calls).toEqual([[150, -100, RAPID]])
    const at = run.landing()
    expect(at.x).toBeCloseTo(150, 6)
    expect(at.y).toBeCloseTo(-100, 6)
  })

  it('an unknown active rotation leaves the travel to the controller: no app refusal computed on one machine axis', () => {
    // The first travel case, with the rotation reported LinuxCNC's way. The
    // app cannot say which point the move reaches, so the request goes out
    // and the controller's own soft limits judge it.
    selectMachine({ x: 250, y: 120, z: 100 })
    const run = standAt(30, { x: 0, y: 20 }, { wcsRotations: { G55: 30 } })
    render(<ControlPage />)
    const before = consoleErrors()

    commit(dro('work', 'x'), '170')

    expect(consoleErrors().slice(before.length)).toEqual([])
    expect(run.jog).not.toHaveBeenCalled()
    expect(run.jogToWorkXY.mock.calls).toEqual([[170, 20, RAPID]])
  })
})
