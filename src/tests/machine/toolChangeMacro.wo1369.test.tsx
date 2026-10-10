// @vitest-environment jsdom
//
// WO-1369: an M6 reached by a running program invokes the configured native
// tool-change sequence. Evidence is read from the simulator controller through
// the application's session/store events, never inferred from return codes.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { positionMacroBody, withMacroToolChangeFlag } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1369-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
const PROGRAM = [
  'G21',
  'G90',
  'T1 M6',
  'G1 X2 F6000',
  '(T2 M6 change) T2 M6',
  'G1 X4 F6000',
  'M30',
].join('\n')

// WO-1681 fix round 2: the fixed pad is a position macro flagged
// `usedForToolChange` - the one source the automatic/guided tool change
// reads - not a wiring-store park plus a separate designated id.
function configureMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-1369 simulator',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 5 },
    },
    macros: [{
      id: PARK.id,
      name: PARK.label,
      body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
      usedForToolChange: true,
    }],
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

describe('WO-1369 M6 native tool-change macro', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine()
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  it('loads and keeps the manual hold when the configured pad has no measured reference tool', async () => {
    render(<ProgramPanel />)
    loadMachineProgram('missing-reference.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(getMachineController().jobProgress().totalLines).toBe(7)

    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    const state = useMachineControl.getState()
    expect(state.machineState).toBe('hold')
    expect(state.mpos).toMatchObject({ x: 2 })
    expect(state.toolChange).toBeNull()
    expect(consoleText()).toContain('Measure a reference tool on the pad first')
    expect(consoleText()).not.toContain('nothing was staged')
  })

  it('loads with one ordinary park and leaves M6 on the established manual hold', async () => {
    // Clear the macro's flag directly (there is no wiring-store id to clear
    // any more) - an unflagged position macro is an ordinary park, same as
    // any other macro, and does not opt this machine into automatic M6.
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine(withMacroToolChangeFlag(machine, PARK.id, false))
    render(<ProgramPanel />)

    loadMachineProgram('ordinary-park.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(getMachineController().jobProgress().totalLines).toBe(7)

    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    const state = useMachineControl.getState()
    expect(state.machineState).toBe('hold')
    expect(state.mpos).toMatchObject({ x: 2 })
    expect(state.toolChange).toBeNull()
    expect(screen.getByTestId('control-toolchange-banner').textContent).toContain('insert T2')
    expect(consoleText()).not.toContain('fixed-pad tool change')
  })

  it('loads the geometry route without a reference and keeps its M6 boundary held', async () => {
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }

    const loaded = loadGcodeTextToolpathProgram('missing-reference-geometry.nc', PROGRAM)
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)

    const state = useMachineControl.getState()
    expect(state.job.phase).toBe('paused')
    expect(state.mpos).toMatchObject({ x: 2 })
    expect(state.toolChange).toBeNull()
    expect(consoleText()).toContain('cannot run the fixed-pad tool change because no reference tool has been measured')
    expect(consoleText()).toContain('the program remains held')
  })

  it('parks, probes, records T2, applies the controller offset and resumes after M6', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    // WO-2037: work Z 0 sits 10 mm below the top of Z travel. T2 measures 2 mm
    // longer than T1 and the simulator now applies that length to the
    // program's Z as the machine does, so the resume after the M6 needs room.
    expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
    await advance(50)
    render(<ProgramPanel />)

    const evidence: Record<string, unknown> = {}
    loadMachineProgram('real-m6.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    evidence.loaded = {
      toolChanges: useMachineControl.getState().job.toolChanges,
      controllerLines: getMachineController().jobProgress().totalLines,
    }

    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    evidence.atM6 = {
      state: useMachineControl.getState().machineState,
      card: useMachineControl.getState().toolChange,
      machinePosition: useMachineControl.getState().mpos,
    }
    expect(useMachineControl.getState().mpos).toMatchObject({ x: 5, y: 5, z: -2 })

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20000)

    const state = useMachineControl.getState()
    const t2 = useMachineToolTable.getState().tableFor(MACHINE_ID).tools.find((tool) => tool.tool === 2)
    expect(t2?.probedMachineZ, JSON.stringify({
      toolChange: state.toolChange,
      tables: useMachineToolTable.getState().byMachine,
      console: consoleText(),
    })).toBeCloseTo(-40, 1)
    expect(state.tlo).toBeCloseTo(2, 3)
    expect(state.job.phase).toBe('complete')
    expect(state.mpos?.x).toBeCloseTo(4, 1)
    expect(state.toolChange).toBeNull()
    expect(consoleText()).toContain('Continue will probe it, apply its measured length and resume the program')
    evidence.completed = {
      job: state.job,
      machinePosition: state.mpos,
      controllerTlo: state.tlo,
      toolTableT2: t2,
      console: state.consoleLines.map((line) => line.text),
    }

    if (process.env.WRITE_EVIDENCE === '1') {
      const directory = join(process.cwd(), 'src/tests/evidence/WO-1369')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'm6-fake-board-readback.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    }
  })

  it('does not start a geometry-routed M6 twice after its internal resume', async () => {
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await advance(50)
    }
    render(<ProgramPanel />)

    const evidence: Record<string, unknown> = {}
    const loaded = loadGcodeTextToolpathProgram('real-m6-geometry.nc', PROGRAM)
    expect(loaded.ok, loaded.reason ?? '').toBe(true)
    evidence.loaded = {
      job: useMachineControl.getState().job,
      activeWcs: useMachineControl.getState().activeWcs,
    }
    expect(getMachineController().startJob()).toBe(true)
    await advance(4000)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    evidence.atM6 = {
      state: useMachineControl.getState().machineState,
      card: useMachineControl.getState().toolChange,
      machinePosition: useMachineControl.getState().mpos,
    }

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    await advance(20000)

    const state = useMachineControl.getState()
    expect(state.job.phase, JSON.stringify({
      toolChange: state.toolChange,
      job: state.job,
      machineState: state.machineState,
      mpos: state.mpos,
      console: state.consoleLines.map((line) => line.text),
    })).toBe('complete')
    expect(state.mpos?.x).toBeCloseTo(4, 1)
    expect(state.tlo).toBeCloseTo(2, 3)
    expect(state.toolChange).toBeNull()
    expect(consoleText()).not.toContain('controller refused to resume the program')
    evidence.completed = {
      job: state.job,
      machinePosition: state.mpos,
      controllerTlo: state.tlo,
      controllerG54: state.offsets.G54,
      toolTableT2: useMachineToolTable.getState().tableFor(MACHINE_ID).tools
        .find((tool) => tool.tool === 2),
      console: state.consoleLines.map((line) => line.text),
    }

    if (process.env.WRITE_EVIDENCE === '1') {
      const directory = join(process.cwd(), 'src/tests/evidence/WO-1369')
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'm6-geometry-fake-board-readback.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      )
    }
  })
})
