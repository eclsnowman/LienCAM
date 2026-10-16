// @vitest-environment jsdom
// WO-2599: operator Stop ends the program hold through the production file
// door and transport. Manual tool changes retain their Cancel behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
  cancelGuidedToolChangeByOperator,
  programPartsTransportState,
  loadMachineProgram,
  stagedProgramContext,
  loadedProgramText,
} = await import('../../lib/machine/machineSession')
const {
  executeOperatorCycleStart,
  executeOperatorStopReset,
  currentOperatorTransport,
} = await import('../../lib/machine/operatorTransport')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { MachineStatusChip } = await import('../../components/toolbar/MachineStatusChip')

const SIM_ID = 'wo2562-simulator'
const SIM_PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
const at = () => getMachineController().status().workPos!
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50) })
}
async function until(done: () => boolean, ms = 60000) {
  for (let t = 0; t < ms; t += 50) { await advance(50); if (done()) return }
  throw new Error(`never reached: ${consoleText()}`)
}
async function action(fn: () => unknown) { await act(async () => { await fn() }) }
describe('WO-2599 Stop at a program hold', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const { positionMacroBody } = await import('../../types')
    const { useMachineActions } = await import('../../store/machineActionsStore')
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: SIM_ID,
      name: 'WO-2562 simulator',
      controller: 'grbl',
      controllerDefinition: undefined,
      unsentSettings: undefined,
      travel: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', homePositionMm: 5 },
      },
      macros: [{
        id: SIM_PARK.id,
        name: SIM_PARK.label,
        body: positionMacroBody({ x: SIM_PARK.x, y: SIM_PARK.y, z: SIM_PARK.z, zFirst: true }),
        usedForToolChange: true,
      }],
      safeZMachine: -2,
    } as never)
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    const tools = useMachineToolTable.getState()
    tools.setProbeConfig(SIM_ID, { maxTravel: 50 })
    tools.recordProbedZ(SIM_ID, 19, -40, 1)
    tools.setReference(SIM_ID, 19)
    for (const axis of ['X', 'Y'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(setWorkOffsetValue('G54', 'Z', -30)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    // The native route's shape (WO-2042's): no G-code text door; a tool length
    // is folded into the work offset's Z through the work-offset call.
    const sim = getMachineController() as unknown as {
      capabilities: { gcodeText: boolean }
      setWorkOffset?: (wcs: string, offset: Record<string, number>) => Promise<unknown>
      wco: Record<string, Record<string, number>>
    }
    sim.capabilities.gcodeText = false
    sim.setWorkOffset = async (wcs, offset) => {
      sim.wco = { ...sim.wco, [wcs]: { ...sim.wco[wcs], ...offset } }
      return { ok: true, reason: null, offset: { ...sim.wco[wcs] } }
    }
  })

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })



  it.each(['M0', 'T1 M6'])('%s: Stop ends the held program and CYCLE START starts from the top', async (stop) => {
    const file = ['G90 G21 G54 T19', 'G0 X0 Y0 Z15', 'G1 X10 F600', 'G0 Z15', stop, 'G1 X20 F600', 'G0 Z15', 'M30'].join('\n')
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar)))
    await action(() => expect(loadGcodeTextToolpathProgram('stop-at-card.nc', file, { publishListing: true }).ok).toBe(true))
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    if (stop === 'M0') await until(() => /stopped at the M0 on line 5/.test(consoleText()) && getMachineController().machineState() === 'idle')
    else await until(() => useMachineControl.getState().toolChange?.step === 'awaiting-swap')
    await advance(300)
    const pos = { ...at() }
    if (stop === 'M0') {
      expect.soft(screen.getByTestId('control-state-chip').textContent).toBe('Held')
      await action(() => expect(executeOperatorStopReset()).toBe(true))
    } else {
      expect.soft(screen.getByTestId('control-tc-cancel').textContent).toBe('Stop program')
      await action(() => fireEvent.click(screen.getByTestId('control-tc-cancel')))
    }
    await advance(1000)
    expect(programPartsTransportState()).toBeNull()
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(at()).toEqual(pos)
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(screen.getByTestId('control-next-action').textContent).toContain(`Stopped at line 5 (${stop === 'M0' ? 'M0 hold' : 'T1 change'}). Restart the program or run from a line.`)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => at().x < 9)
    expect(consoleText()).not.toMatch(/refused/)
  })

  it('a manual tool-change card keeps Cancel and does not acquire program stop semantics', async () => {
    render(createElement(ProgramPanel))
    useMachineControl.setState({ toolChange: { mode: 'toolChange', tool: 1, resumeLine: 0, step: 'awaiting-swap', message: 'Fit T1', warnings: [] } })
    await advance(50)
    expect(screen.getByTestId('control-tc-cancel').textContent).toBe('Cancel')
    await action(() => cancelGuidedToolChangeByOperator())
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(consoleText()).toContain('cancelled')
  })

  // The 10:30 PM fix round: an opened file has no CAM context, but remains
  // a file with line numbers. Exercise the production door, never a job stub.
  it('WO-2609: M0 chip follows Hold, Cycle Start and Stop', async () => {
    const file = 'G90 G21 G54 T19\nG0 X0 Y0 Z15\nG1 X10 F600\nM0\nG1 X20 F600\nM30'
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar), createElement(MachineStatusChip)))
    await action(() => {
      expect(loadGcodeTextToolpathProgram('chip-m0.nc', file, { publishListing: true }).ok).toBe(true)
    })
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    expect(screen.getByTestId('machine-status-chip').getAttribute('data-state')).toBe('running')
    await until(() => /stopped at the M0 on line 4/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    expect(screen.getByTestId('machine-status-chip').textContent).toBe('Held')
    expect(screen.getByTestId('machine-status-chip').getAttribute('data-state')).toBe('held')
    expect(screen.getByTestId('machine-status-chip').getAttribute('aria-label')).toBe('Machine status: Held')
    await action(() => useMachineControl.getState().clearConsole())
    expect(screen.getByTestId('machine-status-chip').textContent).toBe('Held')
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    expect(screen.getByTestId('machine-status-chip').textContent).toBe('Running')
    await until(() => at().x > 12)
    await action(() => executeOperatorStopReset())
    await advance(1000)
    expect(screen.getByTestId('machine-status-chip').getAttribute('data-state')).not.toBe('held')
  })

  it.each(['M0', 'T1 M6'])('WO-2609 text %s: Stop retains From line and Plan through the text door', async (stop) => {
    const file = ['G90 G21 G54 T19', 'G0 X0 Y0 Z15', 'G1 X10 F600', 'G0 Z15', stop, 'G1 X20 F600', 'G0 Z15', 'M30'].join('\n')
    getMachineController().capabilities.gcodeText = true
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar)))
    await action(() => expect(loadMachineProgram('text-stop.nc', file).lines.length).toBeGreaterThan(0))
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    if (stop === 'M0') await until(() => getMachineController().machineState() === 'hold')
    else await until(() => useMachineControl.getState().toolChange?.step === 'awaiting-swap')
    await action(() => executeOperatorStopReset())
    await advance(1000)
    expect(useMachineControl.getState().programText).toBe(file)
    await action(() => fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: '3' } }))
    await action(() => fireEvent.click(screen.getByTestId('control-runfrom-plan')))
    // WO-2810: an unknown/different fitted tool needs the operator's choice before arming.
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    await action(() => fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')))
    await advance(1000)
    expect(useMachineControl.getState().armedFromLine).toBe(3)
    expect(screen.getByText(/Run from line 3 - the machine will first/)).toBeTruthy()
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => getMachineController().machineState() === 'hold')
    expect(at().x).toBeCloseTo(10)
    expect(consoleText()).not.toMatch(/refused/)
  })

  it.each(['M0', 'T1 M6'])('WO-2609 %s: restaged progress is fresh and From line plans an opened file without CAM context', async (stop) => {
    const file = ['G90 G21 G54 T19', 'G0 X0 Y0 Z15', 'G1 X10 F600', 'G0 Z15', stop, 'G1 X20 F600', 'G1 X30 F600', 'G0 Z15', 'M30'].join('\n')
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar), createElement(MachineStatusChip)))
    await action(() => expect(loadGcodeTextToolpathProgram('from-stop.nc', file, { publishListing: true }).ok).toBe(true))
    await advance(300)
    expect(stagedProgramContext()).toBeNull()
    expect(loadedProgramText()).toBe(file)
    const fresh = screen.getByTestId('control-progress-text').textContent
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    if (stop === 'M0') await until(() => /stopped at the M0 on line 5/.test(consoleText()) && getMachineController().machineState() === 'idle')
    else await until(() => useMachineControl.getState().toolChange?.step === 'awaiting-swap')
    await advance(300)
    expect(screen.getByTestId('control-progress-text').textContent).not.toBe(fresh)
    if (stop === 'M0') await action(() => executeOperatorStopReset())
    else {
      // WO-2611 (Operator ruling 10-06 4:10 AM): a stationary tool-change card reads Held.
      expect(screen.getByTestId('machine-status-chip').textContent).toBe('Held')
      await action(() => fireEvent.click(screen.getByTestId('control-tc-cancel')))
    }
    await advance(1000)
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect.soft(screen.getByTestId('control-progress-text').textContent).toBe(fresh)
    expect.soft(screen.getByTestId('control-progress-fill').style.width).toBe('0%')
    const from = screen.getByTestId('control-runfrom-input')
    await action(() => fireEvent.change(from, { target: { value: '3' } }))
    await action(() => fireEvent.click(screen.getByTestId('control-runfrom-plan')))
    // WO-2810: retain the Stop/restart oracle after explicitly choosing Start now.
    expect(useMachineControl.getState().armedFromLine).toBeNull()
    await action(() => fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')))
    await advance(1000)
    expect(useMachineControl.getState().armedFromLine).toBe(3)
    expect(screen.getByText(/Run from line 3 - the machine will first/)).toBeTruthy()
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => at().x > 9.9 && getMachineController().machineState() === 'idle' && programPartsTransportState()?.held === true)
    expect(consoleText()).not.toMatch(/refused/)
  })
})
