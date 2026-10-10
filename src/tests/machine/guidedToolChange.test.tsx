// @vitest-environment jsdom
//
// MACHINE-CONTROL stage 12: the guided M6 tool change, end to end against the
// simulator - stream to the tool-change hold, controlled stop (homing
// SURVIVES the commanded soft reset), park over the pad, probe the new tool,
// apply its offset vs the reference, re-arm via run-from-line, and finish the
// program. Plus the ProgramPanel card render.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'

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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  __resetEstopInterlockForTest,
  applyToolLengthOffset,
  beginClampPause,
  beginGuidedToolChange,
  cancelGuidedToolChange,
  connectMachine,
  continueClampPause,
  continueGuidedToolChange,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
} = await import('../../lib/machine/machineSession')
const { toolOffsetLine } = await import('../../lib/machine/toolTable')

const PROBE = { fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10 }
const PARK = { id: 'tc', label: 'TC pad', x: 5, y: 5 }
const PROGRAM = 'G21\nG90\nG1 X2 F6000\nT2 M0 ( change tool )\nG1 X4 F6000'

/** Tool-change motion uses positive XY park/program positions and a negative
 * Z probe pad. Declare that mixed frame before constructing the simulator. */
function selectToolChangeMachineFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'guided-tool-change-machine',
    name: 'Guided tool-change fixture',
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
  })
}

/** Drive a runner promise under fake timers until it settles. */
async function finish<T>(p: Promise<T>, ms = 20000): Promise<T> {
  let out: T | undefined
  let done = false
  void p.then((v) => {
    out = v
    done = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  expect(done).toBe(true)
  return out!
}

function tc() {
  return useMachineControl.getState().toolChange
}

describe('guided tool change end to end (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useMachineToolTable.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectToolChangeMachineFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    // Guided motion begins only after the operator has cleared the startup latch.
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
  })

  afterEach(async () => {
    cancelGuidedToolChange()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('walks stop -> park -> swap -> probe -> offset -> re-arm -> finish', async () => {
    const M = 'test-machine'
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(M, 1, -40, 1) // reference tool, measured on the pad
    tools.setReference(M, 1)

    loadMachineProgram('tc-test.nc', PROGRAM)
    const changes = useMachineControl.getState().job.toolChanges
    expect(changes).toHaveLength(1)
    expect(changes[0].tool).toBe(2)

    expect(getMachineController().startJob()).toBe(true)
    // X2 at F6000 is ~20ms of motion; the M0 then holds the machine.
    await vi.advanceTimersByTimeAsync(2000)
    expect(useMachineControl.getState().machineState).toBe('hold')

    // Phase 1: controlled stop + park.
    const began = await finish(
      beginGuidedToolChange({
        tool: 2,
        resumeLine: changes[0].sourceLine + 1,
        park: PARK,
        safeZMachine: -2,
      }),
    )
    expect(began).toBe(true)
    expect(tc()?.step).toBe('awaiting-swap')
    const s1 = useMachineControl.getState()
    expect(s1.mpos?.x).toBeCloseTo(5, 1)
    expect(s1.mpos?.y).toBeCloseTo(5, 1)
    expect(s1.mpos?.z).toBeCloseTo(-2, 1)
    expect(getMachineController().homedThisSession()).toBe(true) // survived the reset

    // Phase 2: probe + offset + re-arm (the ProgramPanel callback, inlined).
    const cont = await finish(
      continueGuidedToolChange(PROBE, (probedZ) => {
        const t = useMachineToolTable.getState()
        t.recordProbedZ(M, 2, probedZ, 2)
        const line = toolOffsetLine(t.tableFor(M), 2)
        if (!line.ok) return { ok: false, reason: line.reason }
        return applyToolLengthOffset(line.deltaMm) ? { ok: true } : { ok: false, reason: 'refused' }
      }),
    )
    expect(cont).toBe(true)
    expect(tc()?.step).toBe('ready')
    expect(useMachineControl.getState().job.phase).toBe('ready')
    // Same pad, same trigger point -> zero delta vs the reference.
    expect(useMachineToolTable.getState().tableFor(M).tools.find((t) => t.tool === 2)?.probedMachineZ).toBeCloseTo(-40, 1)

    // Operator presses Start: program resumes AFTER the pause line and finishes.
    expect(getMachineController().startJob()).toBe(true)
    expect(tc()).toBeNull() // starting clears the card
    await vi.advanceTimersByTimeAsync(8000)
    const s2 = useMachineControl.getState()
    expect(s2.job.phase).toBe('complete')
    expect(s2.mpos?.x).toBeCloseTo(4, 1)
  })

  it('clamp pause: stops mid-run, parks, re-arms at the captured line, finishes', async () => {
    // Slow feed so the pause happens GENUINELY mid-stream (planner still
    // holding acks back, job actively streaming when we stop it).
    // WO-433: M30, not M2 - the native simulator's interpreter is scoped to
    // exactly the M-codes src/lib/post/dialects/uccnc.ts's default config can
    // emit (SUPPORTED_M in simulatedController.ts, a deliberate WO-428
    // choice), and LienCAM's own post always emits M30, never M2.
    const lines = ['G21', 'G90', ...Array.from({ length: 20 }, (_, i) => `G1 X${i + 1} F60`), 'M30']
    loadMachineProgram('clamp-test.nc', lines.join('\n'))
    expect(getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(3000) // ~X3 of 20mm at 60 mm/min
    expect(useMachineControl.getState().job.phase).toBe('streaming') // truly mid-run
    const acked = useMachineControl.getState().job.ackedSourceLine
    const resumeLine = Math.max(2, acked)

    const began = await finish(
      beginClampPause({ resumeLine, park: PARK, safeZMachine: -2 }),
    )
    expect(began).toBe(true)
    expect(tc()?.mode).toBe('clampPause')
    expect(tc()?.step).toBe('awaiting-swap')
    const parked = useMachineControl.getState()
    expect(parked.mpos?.x).toBeCloseTo(5, 1)
    expect(parked.mpos?.z).toBeCloseTo(-2, 1)

    expect(continueClampPause()).toBe(true)
    expect(tc()?.step).toBe('ready')
    expect(useMachineControl.getState().job.phase).toBe('ready')

    expect(getMachineController().startJob()).toBe(true)
    expect(tc()).toBeNull()
    await vi.advanceTimersByTimeAsync(180000) // remaining ~17mm at 60 mm/min + prelude
    const done = useMachineControl.getState()
    expect(done.job.phase).toBe('complete')
    expect(done.mpos?.x).toBeCloseTo(20, 1) // last programmed X
  })

  it('fails loudly when the probe misses, leaving the flow recoverable', async () => {
    loadMachineProgram('tc-test.nc', PROGRAM)
    getMachineController().startJob()
    await vi.advanceTimersByTimeAsync(2000)
    await finish(
      beginGuidedToolChange({ tool: 2, resumeLine: 5, park: PARK, safeZMachine: -2 }),
    )
    expect(tc()?.step).toBe('awaiting-swap')
    // Max travel too short to reach the pad from Z-2 -> ALARM:5.
    const cont = await finish(
      continueGuidedToolChange({ ...PROBE, maxTravel: 5 }, () => ({ ok: true })),
    )
    expect(cont).toBe(false)
    // WO-1996: a miss keeps the program held at the M6 so Retry measure can run.
    expect(tc()?.step).toBe('awaiting-swap')
    expect(tc()?.message).toContain('never made contact')
  })
})

describe('ProgramPanel tool-change card', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      toolChange: null,
    })
  })

  afterEach(() => cleanup())

  it('renders the step card with Continue at awaiting-swap', () => {
    render(<ProgramPanel />)
    act(() =>
      useMachineControl.getState().setToolChange({
        step: 'awaiting-swap',
        mode: 'toolChange',
        tool: 2,
        resumeLine: 5,
        message: 'Insert T2 and snug it.',
        warnings: [],
      }),
    )
    const card = screen.getByTestId('control-toolchange-card')
    expect(card.textContent).toContain('T2')
    expect(screen.getByTestId('control-tc-message').textContent).toContain('Insert T2')
    expect(screen.getByTestId('control-tc-continue')).toBeTruthy()
    act(() =>
      useMachineControl.getState().setToolChange({
        step: 'ready',
        mode: 'toolChange',
        tool: 2,
        resumeLine: 5,
        message: 'Armed.',
        warnings: ['The spindle will START.'],
      }),
    )
    expect(screen.getByTestId('control-toolchange-card').textContent).toContain('spindle will START')
    expect(screen.queryByTestId('control-tc-continue')).toBeNull()
  })
})
