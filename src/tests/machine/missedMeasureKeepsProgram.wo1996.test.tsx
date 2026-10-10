// @vitest-environment jsdom
//
// WO-1996 (readiness walk 2026-09-25, findings 2 and 8): a guided tool change
// whose automatic measure misses keeps the program at that M6. The card offers
// Retry measure (same tool, same setter routine) and, once the retry has
// measured the tool, Continue from the M6 - no restart from line 1, no typed
// line. A Re-arm from start whose reload is refused says why in the console.
//
// Evidence is read back from the simulator controller through the session's
// store (machine position, controller TLO, job phase), never from return codes.
// The miss is physical: the setter sits 38 mm below the park, and the first
// measure searches only 20 mm.

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
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  armProgramFromTop,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  pressEstop,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1996-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
const PROGRAM = ['G21', 'G90', 'T1 M6', 'G1 X2 F6000', 'T2 M6', 'G1 X4 F6000', 'M30'].join('\n')
/** The setter is at machine Z -40 and the park at -2: 20 mm cannot reach it. */
const SHORT_SEARCH = { maxTravel: 20 }
const FULL_SEARCH = { maxTravel: 50 }

function configureMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-1996 simulator',
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

function readback(): Record<string, unknown> {
  const s = useMachineControl.getState()
  return {
    toolChange: s.toolChange,
    job: { phase: s.job.phase, name: s.job.name, error: s.job.error },
    controllerJob: getMachineController().jobProgress(),
    machineState: s.machineState,
    machinePosition: s.mpos,
    controllerTlo: s.tlo,
    toolTableT2: useMachineToolTable.getState().tableFor(MACHINE_ID).tools.find((tool) => tool.tool === 2) ?? null,
    card: screen.queryByTestId('control-toolchange-card')?.textContent ?? null,
  }
}

async function zeroG54(): Promise<void> {
  for (const axis of ['X', 'Y', 'Z'] as const) {
    expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
    await advance(50)
  }
}

type Route = 'text' | 'staged'

/** Load, run to the T2 M6, let it park, and press Continue with a search too
 * short to reach the setter. */
async function runToMissedMeasure(route: Route): Promise<void> {
  if (route === 'staged') await zeroG54()
  // WO-2037: the text route's work Z 0 sits 10 mm below the top of Z travel.
  // T2 measures 2 mm longer than T1 and the simulator now applies that length
  // to the program's Z as the machine does, so the resume's G0 Z0 needs room.
  else expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
  render(<ProgramPanel />)
  if (route === 'text') loadMachineProgram('m6-miss.nc', PROGRAM)
  else expect(loadGcodeTextToolpathProgram('m6-miss.nc', PROGRAM).ok).toBe(true)
  expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, SHORT_SEARCH) })

  expect(getMachineController().startJob()).toBe(true)
  await advance(4000)
  expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
  expect(useMachineControl.getState().mpos).toMatchObject({ x: PARK.x, y: PARK.y, z: PARK.z })

  fireEvent.click(screen.getByTestId('control-tc-continue'))
  await advance(20000)
}

function writeEvidence(name: string, evidence: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-1996')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`)
}

describe('WO-1996 a missed tool measure keeps the program', () => {
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
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  for (const route of ['text', 'staged'] as const) {
    it(`${route} program: M6 -> park -> miss -> Retry -> hit -> Continue resumes after the M6 with the new length`, async () => {
      const evidence: Record<string, unknown> = { route }
      await runToMissedMeasure(route)

      // The miss: the probe really ran out of travel, and the card is still at
      // the M6 with Retry measure - not a Close-only dead end.
      let state = useMachineControl.getState()
      evidence.afterMiss = readback()
      expect(state.mpos?.z, JSON.stringify(evidence.afterMiss)).toBeCloseTo(PARK.z - SHORT_SEARCH.maxTravel, 1)
      expect(state.toolChange).toMatchObject({ mode: 'toolChange', tool: 2, resumeLine: 6, step: 'awaiting-swap' })
      expect(screen.getByTestId('control-tc-retry').textContent).toBe('Retry measure T2')
      // WO-2553: the real missed-measure route retains a live touch indicator.
      for (const probe of [true, false]) {
        act(() => useMachineControl.setState({ inputs: { ...useMachineControl.getState().inputs!, probe } }))
        expect(screen.getByTestId('toolchange-lamp-probe').classList.contains(probe ? 'probe-lamp-on' : 'probe-lamp-off')).toBe(true)
      }
      expect(screen.queryByTestId('control-tc-continue')).toBeNull()
      expect(state.toolChange?.message).toContain('still held at the M6 on line 5')
      expect(state.job.phase).not.toBe('failed')
      expect(state.job.error).toBeNull()
      expect(consoleText()).not.toContain('Program parts ended')
      expect(consoleText()).toContain('T2 was not measured; the program stays at the M6 on line 5')

      // Retry: same tool, same setter - now with a search that reaches it.
      act(() => { useMachineToolTable.getState().setProbeConfig(MACHINE_ID, FULL_SEARCH) })
      fireEvent.click(screen.getByTestId('control-tc-retry'))
      await advance(20000)

      state = useMachineControl.getState()
      evidence.afterRetry = readback()
      expect(state.toolChange?.step, JSON.stringify(evidence.afterRetry)).toBe('ready')
      expect(state.toolChange?.message).toContain('Continue resumes the program after the M6 on line 5')
      expect(useMachineToolTable.getState().tableFor(MACHINE_ID).tools.find((tool) => tool.tool === 2)?.probedMachineZ)
        .toBeCloseTo(-40, 1)
      expect(state.tlo).toBeCloseTo(2, 3)
      // Measured, not resumed: the program has not moved past the M6 yet.
      expect(state.mpos).toMatchObject({ x: PARK.x, y: PARK.y })
      expect(state.job.phase).not.toBe('complete')

      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)

      state = useMachineControl.getState()
      evidence.completed = { ...readback(), console: state.consoleLines.map((line) => line.text) }
      expect(state.job.phase, JSON.stringify(evidence.completed)).toBe('complete')
      expect(state.mpos?.x).toBeCloseTo(4, 1)
      expect(state.tlo).toBeCloseTo(2, 3)
      expect(state.toolChange).toBeNull()
      writeEvidence(`${route}-miss-retry-continue.json`, evidence)
    })
  }

  it('E-STOP while the missed measure waits still ends the staged program (faults unchanged)', async () => {
    await runToMissedMeasure('staged')
    expect(useMachineControl.getState().job.phase).toBe('paused')

    await act(async () => { await pressEstop() })
    await advance(2000)

    const state = useMachineControl.getState()
    const evidence = readback()
    expect(state.job.phase, JSON.stringify(evidence)).toBe('failed')
    expect(consoleText()).toContain('Program parts ended because the controller entered an alarm')
    writeEvidence('staged-miss-then-estop.json', evidence)
  })

  it('Retry does not clear an alarm the measure did not raise', async () => {
    await runToMissedMeasure('text')
    await act(async () => { await pressEstop() })
    await advance(500)
    const zBefore = useMachineControl.getState().mpos?.z

    fireEvent.click(screen.getByTestId('control-tc-retry'))
    await advance(5000)

    const state = useMachineControl.getState()
    expect(state.machineState).toBe('alarm')
    expect(state.mpos?.z).toBe(zBefore)
    expect(state.toolChange?.step).toBe('awaiting-swap')
    expect(state.toolChange?.message).toContain('Retry measure did not run')
  })

  it('a refused Re-arm from start says why in the console', async () => {
    // Loads, then the reload is refused: a line the controller cannot stream.
    loadMachineProgram('rearm.nc', PROGRAM)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    const overlong = `G1 X1.${'0'.repeat(30)} Y1.${'0'.repeat(30)} F100.${'0'.repeat(30)}`
    useMachineControl.getState().setProgram('rearm.nc', `G21\n${overlong}\nM30`, [], null)
    useMachineControl.getState().clearConsole()

    let result: Awaited<ReturnType<typeof armProgramFromTop>> | null = null
    await act(async () => { result = await armProgramFromTop() })

    expect(result).toMatchObject({ ok: false })
    expect(consoleText()).toContain('Re-arm from start did not arm the program')
    writeEvidence('rearm-refusal.json', { result, console: consoleText() })
  })
})
