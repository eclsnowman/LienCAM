// @vitest-environment jsdom
//
// WO-2437: a posted operator stop, run by Control on the in-app simulator
// through the real session (a controller made of software; no hardware
// claimed). The file is the one Post Process writes for the machine's own
// dialect, loaded through the file door the bridge runs. It stops at the
// machine's park with the spindle off, and Cycle Start carries on with the
// next operation. UCCNC's M2001 runs the machine's own "Clamp pause" macro -
// the existing park + clamp flow, reused - and Continue resumes.

import { Fragment, createElement, type ComponentProps, type ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  continueClampPause,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadSetupToolpathProgram,
  loadSetupsToolpathProgram,
  pausedProgramTakesCommands,
  programClampPauseTakesMdi,
  sendMdiLine,
  setWorkOffsetValue,
  toolChangeHoldActive,
} = await import('../../lib/machine/machineSession')
const { authorize } = await import('../../lib/machine/operatorAuthority')
const { programStopFollowing } = await import('../../lib/machine/runFromLine')
const { currentOperatorTransport, executeOperatorCycleStart, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { postProject } = await import('../../lib/post/postProject')
const { GRBL_CONFIG, LINUXCNC_CONFIG, UCCNC_CONFIG } = await import('../../lib/post')
const { positionMacroBody } = await import('../../types')
const { makeOp, makeTool, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')

type MachineConfig = import('../../types').MachineConfig
type Project = import('../../types').Project
type Setup = import('../../types').Setup
type PostConfig = import('../../lib/post').PostConfig

// Machine space: UCCNC and LinuxCNC count up from the min switches here; the
// GRBL simulator's Z zero is its switch at the top, so
// its Z space is negative (WO-1755).
let PARK = { x: 20, y: 30, z: 150 }
let OFFSET = { X: 100, Y: 100, Z: 50 }
let SAFE_Z = 140
function setMachineSpace(controller: MachineConfig['controller']): void {
  const grbl = controller === 'grbl'
  PARK = grbl ? { x: 20, y: 30, z: -50 } : { x: 20, y: 30, z: 150 }
  OFFSET = grbl ? { X: 100, Y: 100, Z: -350 } : { X: 100, Y: 100, Z: 50 }
  SAFE_Z = grbl ? -60 : 140
}
const MESSAGE = 'Drive the 4 screws, then press Cycle Start'

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text).join('\n')
}

async function advance(ms: number, step = 50, sample?: () => void): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    await act(async () => { await vi.advanceTimersByTimeAsync(step) })
    sample?.()
  }
}

function selectMachine(controller: MachineConfig['controller']): MachineConfig {
  setMachineSpace(controller)
  const machine: MachineConfig = {
    ...useCamStore.getState().project.machine,
    id: `wo-2437-${controller}`,
    name: `WO-2437 ${controller}`,
    controller,
    controllerDefinition: undefined,
    unsentSettings: undefined,
    // The machine's own park, flagged for the tool change (and so the clamp
    // pause); UCCNC also carries the "Clamp pause" macro its M2001 runs.
    macros: [
      { id: 'park-1', name: 'Park 1', body: positionMacroBody({ ...PARK, zFirst: true }), usedForToolChange: true },
      ...(controller === 'uccnc' ? [{ id: 'clamp-m2001', name: 'Clamp pause', mCode: 2001, body: 'clampPause()' }] : []),
    ],
    travel: { x: 1000, y: 1000, z: 400 },
    rapidRate: 60000,
    safeZMachine: SAFE_Z,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 200 },
    },
  } as MachineConfig
  useCamStore.getState().setProjectMachine(machine)
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  return useCamStore.getState().project.machine
}

const TOOL = makeTool({ id: 't1', toolNumber: 1, feedsAndSpeeds: { default: { rpm: 12000, feedRate: 3000, plungeRate: 600, depthOfCut: 1, stepover: 3, coolant: 'none' } } })

/** Setups placed in the store as Control's Load menu reads them, computed and
 *  current against the store's own project view. */
function storeSetups(setups: Setup[]): void {
  useCamStore.setState((state) => ({
    toolLibrary: [TOOL],
    project: { ...state.project, geometry: [], setups, activeSetupId: setups[0].id },
  }))
  const state = useCamStore.getState()
  const view = { ...state.project, toolLibrary: state.toolLibrary }
  for (const setup of view.setups) {
    for (const op of setup.operations) stampGenerationCurrent(view, setup, op, TOOL)
  }
}

function cutOp(id: string, x: number) {
  return makeOp({
    id, name: `Op ${id}`, toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x, y: 10, z: 5, role: 'rapid' }),
      move({ type: 'feed', x, y: 10, z: -1, feed: 600, role: 'plunge' }),
      move({ type: 'feed', x: x + 20, y: 10, z: -1, feed: 3000, role: 'cut' }),
      move({ type: 'rapid', x: x + 20, y: 10, z: 5, role: 'rapid' }),
    ],
  })
}

/** Post Process's own route: operation A, the stop, operation B. */
function postedFile(machine: MachineConfig, config: PostConfig): string {
  const cut = (id: string, x: number) => makeOp({
    id, name: `Op ${id}`, toolId: 't1',
    toolpathMoves: [
      move({ type: 'rapid', x, y: 10, z: 5, role: 'rapid' }),
      move({ type: 'feed', x, y: 10, z: -1, feed: 600, role: 'plunge' }),
      move({ type: 'feed', x: x + 20, y: 10, z: -1, feed: 3000, role: 'cut' }),
      move({ type: 'rapid', x: x + 20, y: 10, z: 5, role: 'rapid' }),
    ],
  })
  const setup: Setup = {
    id: 's1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
    operations: [cut('a', 0), cut('b', 50)],
    machineActions: [{ id: 'stop-1', kind: 'operator_stop', name: 'Operator stop', enabled: true, afterOpId: 'a', message: MESSAGE }],
    notes: '',
  }
  const project: Project = {
    ...structuredClone(useCamStore.getState().project),
    machine,
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1, feedsAndSpeeds: { default: { rpm: 12000, feedRate: 3000, plungeRate: 600, depthOfCut: 1, stepover: 3, coolant: 'none' } } })],
    geometry: [],
    setups: [setup],
  }
  for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary[0])
  const result = postProject(project, [setup], config, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2437', ext: 'nc',
  })
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return result.files![0].result.gcode
}

/** Control's Load -> Open file..., through the rendered panel: the door the
 *  operator's posted file takes (rehearsal 2026-10-02 - never the interpreter
 *  door called directly). The Jog panel is on screen beside it. */
async function openFile(name: string, text: string): Promise<void> {
  cleanup()
  // Its props are optional (`= {}`), which createElement's overloads cannot read.
  const Jog = JogPanel as ComponentType<NonNullable<ComponentProps<typeof JogPanel>>>
  render(createElement(Fragment, null, createElement(ProgramPanel), createElement(Jog, { selectedConnectionKind: 'simulator' })))
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  act(() => { fireEvent.click(screen.getByTestId('control-open-file')) })
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], name, { type: 'text/plain' })] } })
    await Promise.resolve()
    await Promise.resolve()
  })
  await advance(50)
}

async function connectSimulator(): Promise<void> {
  const connecting = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connecting
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await advance(3000)
  for (const axis of ['X', 'Y', 'Z'] as const) {
    expect(setWorkOffsetValue('G54', axis, OFFSET[axis])).toBe(true)
    await advance(50)
  }
  useMachineControl.setState({ consoleLines: [] })
}

type Sample = { x: number; y: number; z: number }

function sampler(into: Sample[]) {
  return () => {
    const at = getMachineController().status().workPos
    if (at) into.push({ x: at.x, y: at.y, z: at.z })
  }
}

/** The session read the file's M5 just before the stop and its M3 after it.
 *  This fixture machine has no spindle link, so the session says each at its
 *  line instead of driving an inverter - which is what makes it observable. */
function spindleOffBeforeAndOnAfter(gcode: string, stopLine: number): void {
  const lines = gcode.split('\n')
  const off = lines.findIndex((line, i) => line === 'M5' && i + 1 < stopLine && i + 1 > stopLine - 6) + 1
  const on = lines.findIndex((line, i) => /^M3 S/.test(line) && i + 1 > stopLine) + 1
  expect(off).toBeGreaterThan(0)
  expect(on).toBeGreaterThan(stopLine)
  expect(consoleText()).toContain(`Line ${off}: M5`)
  expect(consoleText()).toContain(`Line ${on}: M3`)
}

function atPark(): void {
  const m = useMachineControl.getState().mpos
  expect(m?.x, consoleText()).toBeCloseTo(PARK.x, 1)
  expect(m?.y).toBeCloseTo(PARK.y, 1)
  expect(m?.z).toBeCloseTo(PARK.z, 1)
}

/** B's cut: along X from 50 to 70 at work Z -1. */
function cutB(path: Sample[]): boolean {
  return path.some((s) => s.x > 60 && s.x < 70 && Math.abs(s.y - 10) < 0.05 && Math.abs(s.z + 1) < 0.05)
}

/** A's cut: along X from 0 to 20 at work Z -1. */
function cutA(path: Sample[]): boolean {
  return path.some((s) => s.x > 5 && s.x < 20 && Math.abs(s.y - 10) < 0.05 && Math.abs(s.z + 1) < 0.05)
}

describe('WO-2437 operator stop on the simulator, through the real session', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    getMachineController().emergencyStop()
    const disconnecting = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnecting
    vi.useRealTimers()
  })

  // GRBL through Control's Load -> Open file and CYCLE START, as the operator
  // runs it (rehearsal 2026-10-02: the simulator refused the posted file at
  // its G53 park, "G53 is not a word the GRBL post emits - refusing to run it").
  it('grbl, Load -> Open file: the posted file arms, stops at the park with the spindle off, Cycle Start runs B', async () => {
    const machine = selectMachine('grbl')
    const gcode = postedFile(machine, GRBL_CONFIG)
    expect(gcode).toMatch(/^G53 G0 /m)
    await connectSimulator()

    await openFile('wo2437.nc', gcode)
    expect(consoleText()).not.toContain('refusing to run it')
    expect(getMachineController().jobProgress().phase, consoleText()).toBe('ready')
    const before: Sample[] = []
    let spindleBefore = 0
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, () => {
      sampler(before)()
      spindleBefore = Math.max(spindleBefore, getMachineController().status().spindleRpm ?? 0)
    })

    // Held on the file's M0: A was cut, B was not, the machine sits at its
    // park, the spindle is off.
    const stopLine = gcode.split('\n').indexOf('M0') + 1
    const state = useMachineControl.getState()
    expect(state.job.phase, consoleText()).toBe('paused')
    expect(state.machineState).toBe('hold')
    expect(state.job.ackedSourceLine).toBe(stopLine)
    expect(cutA(before)).toBe(true)
    expect(cutB(before)).toBe(false)
    atPark()
    expect(spindleBefore).toBeGreaterThan(0)
    expect(getMachineController().status().spindleRpm ?? 0).toBe(0)

    // WO-3123: B restarts at authored machine safe Z, then XY, then down.
    const after: Sample[] = []
    let spindleAfter = 0
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, () => {
      sampler(after)()
      spindleAfter = Math.max(spindleAfter, getMachineController().status().spindleRpm ?? 0)
    })
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
    expect(spindleAfter).toBeGreaterThan(0)
    const firstMoveXY = after.findIndex((s) => Math.hypot(s.x - (PARK.x - OFFSET.X), s.y - (PARK.y - OFFSET.Y)) > 0.05)
    expect(firstMoveXY).toBeGreaterThan(0)
    expect(after[firstMoveXY].z).toBeCloseTo(SAFE_Z - OFFSET.Z, 1)
    // Rehearsal round 4: every GRBL stop printed a false red "THE MACHINE LEFT
    // THE COMMANDED PATH" - the frames at the park scored against the G0 before it.
    expect(consoleText()).not.toContain('LEFT THE COMMANDED PATH')
  })

  // Rehearsal round 4, check B (GRBL and LinuxCNC simulators): after a move at
  // the stop, CYCLE START dropped Z at the jogged X/Y to the program's last
  // work Z, LinuxCNC crossed the part there, and the same M0 held a second
  // time. It goes back the WO-2237 way - up first, then X/Y, then down to the
  // stop - and carries on after the stop with the one CYCLE START. (LinuxCNC's
  // post does not arm on this simulator's doors, on main too; its gateway
  // route plans the same return - rehearsal owed.)
  it('grbl: moved at the stop, CYCLE START goes up, over, down to the stop and carries on - no second hold', async () => {
    useUiPrefs.setState({ machineJogStepMm: 5, machineJogContinuous: false })
    const machine = selectMachine('grbl')
    const gcode = postedFile(machine, GRBL_CONFIG)
    await connectSimulator()
    await openFile('wo2437.nc', gcode)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000)
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('paused')
    atPark()

    // The operator moves X off the park and Z below it, with the Jog panel.
    for (const id of ['control-jog-x-plus', 'control-jog-z-minus']) {
      const button = screen.getByTestId(id) as HTMLButtonElement
      expect(button.disabled, id).toBe(false)
      act(() => { fireEvent.pointerDown(button); fireEvent.pointerUp(button) })
      await advance(3_000)
    }
    const m = useMachineControl.getState().mpos
    expect(m?.x, consoleText()).toBeCloseTo(PARK.x + 5, 1)
    expect(m?.z).toBeCloseTo(PARK.z - 5, 1)

    const parkWork = { x: PARK.x - OFFSET.X, y: PARK.y - OFFSET.Y, z: PARK.z - OFFSET.Z }
    const after: Sample[] = []
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(30_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
    // Up first: X/Y never moved below the park's Z until X/Y stood at the park.
    const reached = after.findIndex((s) => Math.hypot(s.x - parkWork.x, s.y - parkWork.y) < 0.05)
    expect(reached, consoleText()).toBeGreaterThan(0)
    for (const s of after.slice(0, reached)) {
      const offXY = Math.hypot(s.x - (parkWork.x + 5), s.y - parkWork.y) > 0.05
      if (offXY) expect(s.z, consoleText()).toBeGreaterThan(parkWork.z - 0.05)
    }
    // One CYCLE START ran to the end: the M0 did not hold a second time.
    const stopLine = gcode.split('\n').indexOf('M0') + 1
    expect(consoleText()).toContain(`carrying on after the stop on line ${stopLine}`)
  })

  // LinuxCNC stays on the interpreter door here: the in-app simulator's Load
  // lints a LinuxCNC post as a parentheses-style file and holds every one at
  // its first ';' comment, on main too (see the WO's fix round NOTE). The real
  // LinuxCNC route is the architect's rehearsal (owed).
  for (const { controller, config } of [
    { controller: 'grbl' as const, config: GRBL_CONFIG },
    { controller: 'linuxcnc' as const, config: LINUXCNC_CONFIG },
  ]) {
    it(`${controller}: stops at the park with the spindle off, Cycle Start runs B`, async () => {
      const machine = selectMachine(controller)
      const gcode = postedFile(machine, config)
      await connectSimulator()

      expect(loadGcodeTextToolpathProgram('wo2437.nc', gcode), consoleText()).toEqual({ ok: true, reason: null })
      const before: Sample[] = []
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
      await advance(20_000, 50, sampler(before))

      // Held at the stop: A was cut, B was not, the machine sits at its park.
      const state = useMachineControl.getState()
      expect(state.job.phase, consoleText()).toBe('paused')
      expect(cutA(before)).toBe(true)
      expect(cutB(before)).toBe(false)
      atPark()
      const stopLine = gcode.split('\n').indexOf('M0') + 1
      expect(consoleText()).toContain(`"wo2437.nc" stopped at the M0 on line ${stopLine}. Press CYCLE START`)

      // WO-3123: B restarts at authored machine safe Z, then XY, then down.
      const after: Sample[] = []
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
      await advance(20_000, 50, sampler(after))
      expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
      expect(cutB(after)).toBe(true)
      expect(cutA(after)).toBe(false)
      const firstMoveXY = after.findIndex((s) => Math.hypot(s.x - (PARK.x - OFFSET.X), s.y - (PARK.y - OFFSET.Y)) > 0.05)
      expect(firstMoveXY).toBeGreaterThan(0)
      expect(after[firstMoveXY].z).toBeCloseTo(SAFE_Z - OFFSET.Z, 1)
      spindleOffBeforeAndOnAfter(gcode, stopLine)
    })
  }

  /** UCCNC through Control's Load -> Open file and CYCLE START: A runs, then
   *  the file's M2001 runs the machine's own "Clamp pause" macro, which parks
   *  and puts up the clamp card. */
  async function uccncHeldAtTheClampPause(
    connected?: () => void,
  ): Promise<{ gcode: string; macroLine: number }> {
    const machine = selectMachine('uccnc')
    const gcode = postedFile(machine, UCCNC_CONFIG)
    await connectSimulator()
    connected?.()

    await openFile('wo2437.nc', gcode)
    const macroLine = gcode.split('\n').indexOf('M2001') + 1
    // WO-2591 (9693d8f371): built-in UCCNC has one operator stop, M2001.
    // Its card release must run B without a second M0/CYCLE START.
    expect(gcode.split('\n').slice(macroLine)).not.toContain('M0')
    expect(consoleText()).toContain(
      `The file calls M2001 on line ${macroLine} (this machine's macro "Clamp pause") - the program holds there and runs it.`,
    )
    const before: Sample[] = []
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(before))

    const paused = useMachineControl.getState()
    expect(paused.job.phase, consoleText()).toBe('paused')
    expect(paused.toolChange?.mode).toBe('clampPause')
    expect(paused.toolChange?.step).toBe('awaiting-swap')
    expect(cutA(before)).toBe(true)
    expect(cutB(before)).toBe(false)
    atPark()
    expect(consoleText()).not.toContain('shares this hold')
    return { gcode, macroLine }
  }

  it('uccnc: M2001 runs the machine\'s own clamp pause at the park; the card\'s Continue runs B', async () => {
    const { gcode, macroLine } = await uccncHeldAtTheClampPause()

    expect(continueClampPause()).toBe(true)
    const after: Sample[] = []
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
    spindleOffBeforeAndOnAfter(gcode, macroLine)
  })

  // Rehearsal 2026-10-02 (native kit, same on main): CYCLE START was lit and
  // said "Cycle Start continues", and pressing it did nothing - only the
  // card's Continue resumed. The fix round made CYCLE START run B; WO-2773
  // (Operator 2026-10-13, "A - Continue on both") makes the card's Continue the
  // one door, as on the guided tool-change card: CYCLE START is dark, says so,
  // and is refused.
  it('uccnc: at the parked stop CYCLE START is dark and refused; the card\'s Continue runs B', async () => {
    await uccncHeldAtTheClampPause()

    expect(currentOperatorTransport()).toMatchObject({
      action: 'none',
      cycleStartEnabled: false,
      cycleStartDetail: 'The Park + clamp card continues this program, not CYCLE START.',
    })
    expect(await executeOperatorCycleStart(), consoleText()).toBe(false)
    await advance(2_000)
    atPark()
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    const after: Sample[] = []
    expect(continueClampPause(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
  })

  // Rehearsal 2026-10-02: jog was locked at the stop ("A program is running -
  // jogging is locked out."). Through the Jog panel's own buttons.
  it('uccnc: at the parked stop jog and Safe Z move the machine, then Continue runs B', async () => {
    useUiPrefs.setState({ machineJogStepMm: 5, machineJogContinuous: false })
    await uccncHeldAtTheClampPause()

    const jogX = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
    expect(jogX.disabled).toBe(false)
    act(() => { fireEvent.pointerDown(jogX); fireEvent.pointerUp(jogX) })
    await advance(3_000)
    expect(useMachineControl.getState().mpos?.x, consoleText()).toBeCloseTo(PARK.x + 5, 1)
    expect(useMachineControl.getState().mpos?.y).toBeCloseTo(PARK.y, 1)

    const safeZ = screen.getByTestId('control-safez') as HTMLButtonElement
    expect(safeZ.disabled).toBe(false)
    act(() => { fireEvent.click(safeZ) })
    await advance(3_000)
    expect(useMachineControl.getState().mpos?.z, consoleText()).toBeCloseTo(SAFE_Z, 1)
    // Still held at the stop, card up: the jog did not release the program.
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

    // WO-2773: the card's Continue is the one door at the clamp pause.
    const after: Sample[] = []
    expect(continueClampPause(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
    // Rehearsal round 4: the operator's moves at the stop are not the program's path.
    expect(consoleText()).not.toContain('LEFT THE COMMANDED PATH')
  })

  // Rehearsal rounds 2 and 4: MDI was locked at the parked clamp pause ("A
  // program is running - MDI is locked out."). The box's authority row now
  // allows it there, a typed line moves the machine, the program stays held,
  // and Continue (WO-2773) goes back to the park and runs B.
  it('uccnc: at the parked stop MDI moves the machine, then Continue runs B', async () => {
    await uccncHeldAtTheClampPause()

    const s = useMachineControl.getState()
    const facts = {
      connected: true,
      machineState: s.machineState,
      jobPhase: s.job.phase,
      estopLatched: false,
      toolChangeHold: toolChangeHoldActive(),
      clampPauseHold: programClampPauseTakesMdi(),
      pauseTakesCommands: pausedProgramTakesCommands(),
      mdiLine: 'G91 G0 Y-5',
    }
    expect(authorize('mdiInput', facts).allowed, JSON.stringify(facts)).toBe(true)
    expect(authorize('mdiSend', facts).allowed).toBe(true)

    expect(sendMdiLine('G91 G0 Y-5'), consoleText()).toBe(true)
    await advance(3_000)
    expect(sendMdiLine('G90'), consoleText()).toBe(true)
    await advance(500)
    expect(useMachineControl.getState().mpos?.y, consoleText()).toBeCloseTo(PARK.y - 5, 1)
    expect(consoleText()).not.toContain('MDI is locked out')
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

    // WO-2773: the card's Continue is the one door at the clamp pause.
    const after: Sample[] = []
    expect(continueClampPause(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
    expect(cutA(after)).toBe(false)
  })

  // Fix round 4 kit rehearsal, check B: on the bridge (no text interpreter) an
  // MDI line was staged as a program and replaced the held one - CYCLE START
  // then had nothing to resume. At the clamp pause the line runs as the
  // controller's own calls and the held program stays.
  it('uccnc bridge route: MDI at the parked stop moves the machine and keeps the held program', async () => {
    let ctrl!: ReturnType<typeof getMachineController>
    let own: PropertyDescriptor | undefined
    const geometryOnly = () => {
      ctrl = getMachineController()
      own = Object.getOwnPropertyDescriptor(ctrl, 'capabilities')
      Object.defineProperty(ctrl, 'capabilities', {
        configurable: true,
        value: { ...ctrl.capabilities, gcodeText: false },
      })
    }
    try {
      await uccncHeldAtTheClampPause(geometryOnly)
      expect(programClampPauseTakesMdi()).toBe(true)
      expect(sendMdiLine(`G53 G0 Y${PARK.y - 5}`), consoleText()).toBe(true)
      await advance(3_000)
      expect(useMachineControl.getState().mpos?.y, consoleText()).toBeCloseTo(PARK.y - 5, 1)
      expect(consoleText()).not.toContain('has been replaced by this move')
      expect(useMachineControl.getState().job.phase).toBe('paused')
      expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')

      // WO-2773: the card's Continue is the one door at the clamp pause.
      const after: Sample[] = []
      expect(continueClampPause(), consoleText()).toBe(true)
      await advance(20_000, 50, sampler(after))
      expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
      expect(cutB(after)).toBe(true)
      expect(cutA(after)).toBe(false)
    } finally {
      if (ctrl && own) Object.defineProperty(ctrl, 'capabilities', own)
      else if (ctrl) delete (ctrl as { capabilities?: unknown }).capabilities
    }
  })

  // Rehearsal round 4 (desk kit, the operator's parks Z128 over safe Z 120, Y on the
  // travel limit): the bridge route parked Z DOWN to the safe Z, re-sent an XY
  // leg to where the posted G53 lines already stood (a zero-length move the
  // bridge latches as a soft-limit trip), then refused to continue because
  // the tool was below the park. Here the controller is geometry-only, as the
  // bridge is, and the park's Z (150) is above the safe Z (140).
  it('uccnc bridge route: the clamp pause parks at the park\'s own Z and sends no leg the tool is already at', async () => {
    useUiPrefs.setState({ machineJogStepMm: 5, machineJogContinuous: false })
    let ctrl!: ReturnType<typeof getMachineController>
    let own: PropertyDescriptor | undefined
    type Ctrl = ReturnType<typeof getMachineController>
    let jogZ!: MockInstance<Ctrl['jogToMachineZ']>
    let jogXY!: MockInstance<Ctrl['jogToWorkXY']>
    const geometryOnly = () => {
      ctrl = getMachineController()
      own = Object.getOwnPropertyDescriptor(ctrl, 'capabilities')
      Object.defineProperty(ctrl, 'capabilities', {
        configurable: true,
        value: { ...ctrl.capabilities, gcodeText: false },
      })
      jogZ = vi.spyOn(ctrl, 'jogToMachineZ')
      jogXY = vi.spyOn(ctrl, 'jogToWorkXY')
    }
    try {
      await uccncHeldAtTheClampPause(geometryOnly)
      expect(jogZ, consoleText()).not.toHaveBeenCalled()
      expect(jogXY).not.toHaveBeenCalled()

      // The operator moves X; Continue (WO-2773: the card's one door) goes
      // back to the park - XY only, Z stays at the park's Z - and runs B.
      const jogX = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
      act(() => { fireEvent.pointerDown(jogX); fireEvent.pointerUp(jogX) })
      await advance(3_000)
      expect(useMachineControl.getState().mpos?.x, consoleText()).toBeCloseTo(PARK.x + 5, 1)
      jogZ.mockClear()
      jogXY.mockClear()
      const after: Sample[] = []
      expect(continueClampPause(), consoleText()).toBe(true)
      await advance(20_000, 50, sampler(after))
      expect(jogZ).not.toHaveBeenCalledWith(SAFE_Z, expect.anything())
      expect(jogXY, consoleText()).toHaveBeenCalledTimes(1)
      expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
      expect(cutB(after)).toBe(true)
      expect(cutA(after)).toBe(false)
      expect(consoleText()).not.toContain('LEFT THE COMMANDED PATH')
    } finally {
      if (ctrl && own) Object.defineProperty(ctrl, 'capabilities', own)
      else if (ctrl) delete (ctrl as { capabilities?: unknown }).capabilities
    }
  })

  // Rehearsal 2026-10-02: Stop/Reset at the stop did nothing - phase stayed
  // paused, the card stayed up, jog and MDI stayed locked.
  it('uccnc: Stop/Reset at the parked stop ends the program; jog and MDI move the machine', async () => {
    useUiPrefs.setState({ machineJogStepMm: 5, machineJogContinuous: false })
    await uccncHeldAtTheClampPause()

    expect(executeOperatorStopReset()).toBe(true)
    await advance(3_000)
    const stopped = useMachineControl.getState()
    expect(stopped.toolChange).toBeNull()
    expect(stopped.job.phase, consoleText()).not.toBe('paused')
    expect(stopped.job.phase).not.toBe('failed')
    expect(consoleText()).toContain('Stopped by the operator')

    const jogX = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
    expect(jogX.disabled).toBe(false)
    act(() => { fireEvent.pointerDown(jogX); fireEvent.pointerUp(jogX) })
    await advance(3_000)
    expect(useMachineControl.getState().mpos?.x, consoleText()).toBeCloseTo(PARK.x + 5, 1)

    expect(sendMdiLine('G91 G0 Y5'), consoleText()).toBe(true)
    await advance(3_000)
    expect(useMachineControl.getState().mpos?.y, consoleText()).toBeCloseTo(PARK.y + 5, 1)
  })

  // Fix round 3 (Operator ruling 2026-10-02 4:26 PM, "User setable"): the machine's own
  // operator-stop park setting - one value the posted file and Control's clamp
  // pause both read - wins over Park 1.
  it('uccnc: the machine\'s operator-stop park setting - the posted file and the clamp pause both park there', async () => {
    const SET = { x: 400, y: 600, z: 150 }
    const base = selectMachine('uccnc')
    act(() => { useCamStore.getState().setProjectMachine({ ...base, operatorStopPark: SET }) })
    const machine = useCamStore.getState().project.machine
    expect(machine.operatorStopPark).toEqual(SET)
    const gcode = postedFile(machine, UCCNC_CONFIG)
    expect(gcode).toMatch(/^G53 G0 X400(\.0*)? Y600(\.0*)?$/m)
    expect(gcode).not.toMatch(/^G53 G0 X20(\.0*)? Y30/m)
    await connectSimulator()

    await openFile('wo2437.nc', gcode)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000)
    const paused = useMachineControl.getState()
    expect(paused.job.phase, consoleText()).toBe('paused')
    expect(paused.toolChange?.mode).toBe('clampPause')
    expect(paused.toolChange?.step).toBe('awaiting-swap')
    expect(paused.mpos?.x, consoleText()).toBeCloseTo(SET.x, 1)
    expect(paused.mpos?.y).toBeCloseTo(SET.y, 1)
    expect(paused.mpos?.z).toBeCloseTo(SET.z, 1)

    // WO-2773: the card's Continue is the one door at the clamp pause.
    const after: Sample[] = []
    expect(continueClampPause(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
  })

  // Control's Load menu stages a one-tool setup straight from its toolpaths,
  // which carry no stop - so a setup with a stop must load as its posted file.
  it('Load setup: a one-tool setup with a stop loads as its posted file and stops at the park', async () => {
    selectMachine('grbl')
    storeSetups([{
      id: 's1', name: 'Setup 1', wcs: makeWcs(),
      stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
      operations: [cutOp('a', 0), cutOp('b', 50)],
      machineActions: [{ id: 'stop-1', kind: 'operator_stop', name: 'Operator stop', enabled: true, afterOpId: 'a', message: MESSAGE }],
      notes: '',
    }])
    await connectSimulator()

    expect(await loadSetupToolpathProgram('s1'), consoleText()).toEqual({ ok: true, reason: null })
    expect(consoleText()).toContain('Program "Setup 1 (posted)" loaded')
    const before: Sample[] = []
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(before))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('paused')
    expect(cutA(before)).toBe(true)
    expect(cutB(before)).toBe(false)
    atPark()

    const after: Sample[] = []
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, sampler(after))
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(cutB(after)).toBe(true)
  })

  /** Setup 1 (G54: A, the stop, B) and Setup 2 (G55: C), one tool; G55 set
   *  300 mm along X, so setup 2 cuts at machine X 400..420. */
  async function twoSetupsLoaded(options: { runThrough?: boolean } = {}): Promise<() => number[]> {
    selectMachine('grbl')
    storeSetups([
      {
        id: 's1', name: 'Setup 1', wcs: makeWcs(),
        stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
        operations: [cutOp('a', 0), cutOp('b', 50)],
        machineActions: [{ id: 'stop-1', kind: 'operator_stop', name: 'Operator stop', enabled: true, afterOpId: 'a', message: MESSAGE }],
        notes: '',
      },
      {
        id: 's2', name: 'Setup 2', wcs: makeWcs({ id: 'w2', label: 'G55', fixtureOffset: 55 }),
        stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
        operations: [cutOp('c', 0)],
        notes: '',
      },
    ])
    await connectSimulator()
    for (const [axis, mm] of [['X', OFFSET.X + 300], ['Y', OFFSET.Y], ['Z', OFFSET.Z]] as const) {
      expect(setWorkOffsetValue('G55', axis, mm)).toBe(true)
      await advance(50)
    }
    expect(await loadSetupsToolpathProgram(['s1', 's2'], options), consoleText()).toEqual({ ok: true, reason: null })
    expect(consoleText()).toContain('Program "Setup 1 + Setup 2 (posted)" loaded')
    const machineX: number[] = []
    return () => {
      const m = getMachineController().status().machinePos
      if (m) machineX.push(m.x)
      return machineX
    }
  }

  /** Cycle Start runs A, then the operator stop holds at the park with setup 2
   *  not started. */
  async function runToTheStop(track: () => number[]): Promise<void> {
    const before: Sample[] = []
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, () => { sampler(before)(); track() })
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('paused')
    expect(cutA(before)).toBe(true)
    expect(cutB(before)).toBe(false)
    atPark()
    // Setup 2 (G55, machine X 400..420) has not started.
    expect(track().some((x) => x > 390)).toBe(false)
  }

  it('Load setups: two setups where one has a stop load as one posted file that stops there, then continue through G55', async () => {
    // "Continue through the setups" is on unless the operator turns it off.
    const track = await twoSetupsLoaded()
    await runToTheStop(track)

    // Cycle Start runs B and carries straight on into setup 2 at G55, as the
    // toolpath route does with the box on: the authored stop is the only hold.
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(30_000, 50, track)
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(consoleText()).not.toContain('Set up for G55, then press CYCLE START to run the rest.')
    expect(track().some((x) => x > 405 && x < 420)).toBe(true)
  })

  it('Load setups: with "Continue through the setups" off, the G55 change holds after the stop', async () => {
    const track = await twoSetupsLoaded({ runThrough: false })
    await runToTheStop(track)

    // The operator asked for a hold at every setup boundary (WO-1323's), so
    // Cycle Start runs B and the G55 change holds; Cycle Start runs setup 2.
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, track)
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('paused')
    expect(consoleText()).toContain('Set up for G55, then press CYCLE START to run the rest.')
    expect(track().some((x) => x > 390)).toBe(false)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(20_000, 50, track)
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    expect(track().some((x) => x > 405 && x < 420)).toBe(true)
  })

  it('Load setups: an outdated operation in a chosen setup is recomputed before the posted file loads', async () => {
    selectMachine('grbl')
    storeSetups([
      {
        id: 's1', name: 'Setup 1', wcs: makeWcs(),
        stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
        operations: [cutOp('a', 0), cutOp('b', 50)],
        machineActions: [{ id: 'stop-1', kind: 'operator_stop', name: 'Operator stop', enabled: true, afterOpId: 'a', message: MESSAGE }],
        notes: '',
      },
      {
        id: 's2', name: 'Setup 2', wcs: makeWcs({ id: 'w2', label: 'G55', fixtureOffset: 55 }),
        stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
        operations: [cutOp('c', 0)],
        notes: '',
      },
    ])
    // Operation C was edited since it was generated: its moves are outdated,
    // and the post on its own refuses them.
    const outdated = useCamStore.getState().project.setups[1].operations[0]
    outdated.generationFingerprint = 'edited-since-generation'
    {
      const state = useCamStore.getState()
      const view = { ...state.project, toolLibrary: state.toolLibrary }
      const unstaged = postProject(view, view.setups, GRBL_CONFIG, {
        mode: 'combined', pauseBetweenSetups: false, baseName: 'control', ext: 'nc',
      })
      expect(unstaged.ok).toBe(false)
    }
    // The store's recompute, as a load stages it: an outdated operation is
    // generated again. The real recompute needs model geometry this fixture
    // does not carry, so it stands in with the same effect - C made current.
    const realStage = useCamStore.getState().stageOperationsForEmission
    const staged: string[] = []
    useCamStore.setState({
      stageOperationsForEmission: async (setupId: string) => {
        staged.push(setupId)
        const state = useCamStore.getState()
        const view = { ...state.project, toolLibrary: state.toolLibrary }
        const setup = view.setups.find((candidate) => candidate.id === setupId)!
        for (const op of setup.operations) stampGenerationCurrent(view, setup, op, TOOL)
        useCamStore.setState({ project: { ...state.project, setups: [...state.project.setups] } })
        return { recomputed: [], restore: () => {} }
      },
    })
    try {
      await connectSimulator()
      for (const [axis, mm] of [['X', OFFSET.X + 300], ['Y', OFFSET.Y], ['Z', OFFSET.Z]] as const) {
        expect(setWorkOffsetValue('G55', axis, mm)).toBe(true)
        await advance(50)
      }
      expect(await loadSetupsToolpathProgram(['s1', 's2']), consoleText()).toEqual({ ok: true, reason: null })
      expect(staged).toEqual(['s1', 's2'])
      expect(consoleText()).toContain('Program "Setup 1 + Setup 2 (posted)" loaded')
      expect(consoleText()).not.toContain('not ready to post')
    } finally {
      useCamStore.setState({ stageOperationsForEmission: realStage })
    }
  })
})

// Fix round 4 LinuxCNC rehearsal, check B: LinuxCNC holds on the stop's M0
// while it names the park's G53 line (its last motion line). The stop after
// that line, with nothing that moves between, is the stop it holds on.
describe('WO-2437 the program stop a held controller is past', () => {
  const POSTED = [
    'G0 Z15',                                           // 1
    'M5',                                               // 2
    'G53 G0 Z90',                                       // 3
    'G53 G0 X200 Y200',                                 // 4
    '(MSG, Drive the 4 screws, then press Cycle Start)', // 5
    'M0',                                               // 6
    'G0 Z15',                                           // 7
  ].join('\n')

  it('the park line is followed by its stop, ending at the park in machine coordinates', () => {
    expect(programStopFollowing(POSTED, 4)).toEqual({ stopLine: 6, endOf: { frame: 'machine', at: { x: 200, y: 200 } } })
  })

  it('a line with motion before the stop is not followed by it', () => {
    expect(programStopFollowing(POSTED, 2)).toBeNull()
    expect(programStopFollowing(POSTED, 6)).toBeNull()
  })
})
