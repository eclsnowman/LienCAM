// @vitest-environment jsdom
//
// WO-2810 (Operator 10-14): "on run from line we should run from the line ... we
// can have a notification to inform them they would need to do a tool change
// if it's last known state is with a different tool ... We can inform and pause
// for confirmations they understand, but we don't want hard blockers. Part of
// that pop-up could ask them whether they want to run the tool change sequence
// prior to starting from that point."
//
// The production Program panel on the simulator, through both doors: GRBL's
// text door and the staged file door a UCCNC definition takes. Per case: the
// pop-up's text and choices, and what the machine was handed and ran.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
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
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { positionMacroBody } = await import('../../types')
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

const MACHINE_ID = 'wo2810-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
// T1 cuts lines 3-4; the T2 M6 on line 5 fits T2 for lines 6-7.
const PROGRAM = ['G21 G90 G54', 'T1 M6', 'G0 X10 Z-1', 'G1 X15 F300', 'T2 M6', 'G0 X20 Z-1', 'G1 X25 F300', 'M30'].join('\n')
const LINE = 7

type Route = 'text' | 'staged'

function configureMachine(route: Route): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-2810 simulator',
    controller: route === 'staged' ? 'uccnc' : 'grbl',
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

function evidence(name: string, value: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-2810')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
}

/** What the machine was handed: every load, with its prelude when it has one. */
function recordLoads() {
  const ctrl = getMachineController() as unknown as Record<string, (...args: unknown[]) => unknown>
  const loads: { via: string; startLine?: number; prelude?: string[] }[] = []
  for (const via of ['loadJob', 'loadJobFrom', 'loadProgram'] as const) {
    if (typeof ctrl[via] !== 'function') continue
    const original = ctrl[via].bind(ctrl)
    vi.spyOn(ctrl, via).mockImplementation((...args: unknown[]) => {
      loads.push(via === 'loadJobFrom' ? { via, startLine: args[1] as number, prelude: [...(args[2] as string[])] } : { via })
      return original(...args)
    })
  }
  return loads
}

/** CYCLE START, then play the operator to the end: Continue on a tool-change
 *  card, CYCLE START on a plain hold. Records each tool change it met. */
async function runToEnd(): Promise<{ toolChanges: (number | null)[]; phase: string; x: number | undefined }> {
  const toolChanges: (number | null)[] = []
  await act(async () => {
    expect(await executeOperatorCycleStart(), useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toBe(true)
  })
  for (let tick = 0; tick < 80; tick++) {
    await advance(500)
    const s = useMachineControl.getState()
    if (s.job.phase === 'complete' && s.machineState === 'idle' && s.toolChange === null) break
    if (toolChanges.length > 4) break
    if (s.toolChange?.step === 'awaiting-swap') {
      toolChanges.push(s.toolChange.tool)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
    } else if ((s.machineState === 'hold' || s.job.phase === 'paused') && s.toolChange === null) {
      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    }
  }
  const end = useMachineControl.getState()
  return { toolChanges, phase: end.job.phase, x: end.wpos?.x }
}

async function planLine(line: number): Promise<void> {
  fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: String(line) } })
  await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')) })
  await advance(300)
}

for (const route of ['text', 'staged'] as Route[]) describe(`WO-2810 run from line on the ${route === 'text' ? 'GRBL text' : 'UCCNC staged'} door`, () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine(route)
    useMachineControl.setState({ activeTool: null, toolChange: null })
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    if (route === 'staged') {
      const ctrl = getMachineController() as unknown as { capabilities: { gcodeText: boolean }; wco: Record<string, Record<string, number>>; setWorkOffset: (wcs: string, offset: Record<string, number>) => Promise<unknown> }
      ctrl.capabilities.gcodeText = false
      ctrl.setWorkOffset = async (wcs, offset) => {
        ctrl.wco = { ...ctrl.wco, [wcs]: { ...ctrl.wco[wcs], ...offset } }
        return { ok: true, reason: null, offset: { ...ctrl.wco[wcs] } }
      }
    }
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    tools.setProbeConfig(MACHINE_ID, { maxTravel: 50 })
    render(createElement(ProgramPanel))
    if (route === 'text') loadMachineProgram('wo2810.nc', PROGRAM)
    else expect(loadGcodeTextToolpathProgram('wo2810.nc', PROGRAM, { publishListing: true }).ok).toBe(true)
    await advance(3000)
    expect(useMachineControl.getState().job.phase).toBe('ready')
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('the same tool: no pop-up, the plan is armed from the line as before', async () => {
    useMachineControl.setState({ activeTool: 2 })
    await planLine(LINE)
    expect(screen.queryByTestId('control-runfrom-toolask')).toBeNull()
    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
    expect(screen.getByTestId('control-runfrom-tool').textContent).toContain('T2')
    const run = await runToEnd()
    expect(run).toMatchObject({ toolChanges: [], phase: 'complete' })
    expect(run.x).toBeCloseTo(25, 1)
  })

  it('a different last known tool: one pop-up names both tools and arms nothing until it is answered', async () => {
    useMachineControl.setState({ activeTool: 1 })
    const loads = recordLoads()
    const before = { mpos: { ...useMachineControl.getState().mpos }, armed: useMachineControl.getState().armedFromLine }
    await planLine(LINE)
    const ask = screen.getByTestId('control-runfrom-toolask')
    expect(screen.getByTestId('control-runfrom-toolask-title').textContent).toBe(`Line ${LINE} runs with T2 in the spindle.`)
    expect(screen.getByTestId('control-runfrom-toolask-lastknown').textContent).toBe('The last known tool in the spindle is T1.')
    expect(screen.getByTestId('control-runfrom-toolask-owner').textContent)
      .toBe(`Starting part-way through a program is your call: from line ${LINE} the machine cuts with whatever tool is fitted.`)
    expect([...ask.querySelectorAll('button')].map(b => b.textContent)).toEqual([
      `Run the tool change for T2 first, then start from line ${LINE}`,
      `Start from line ${LINE} now`,
      'Cancel',
    ])
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
    expect(loads).toEqual([])
    expect(useMachineControl.getState().armedFromLine).toBe(before.armed)
    evidence(`${route}-popup.json`, { text: ask.textContent, buttons: [...ask.querySelectorAll('button')].map(b => b.textContent) })

    // Cancel sends nothing and moves nothing.
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-cancel')) })
    await advance(1000)
    expect(screen.queryByTestId('control-runfrom-toolask')).toBeNull()
    expect(loads).toEqual([])
    expect(useMachineControl.getState().mpos).toEqual(before.mpos)
    expect(useMachineControl.getState().toolChange).toBeNull()
    expect(useMachineControl.getState().armedFromLine).toBe(before.armed)
  })

  it('an unknown last tool asks too, and says it is not known', async () => {
    await planLine(LINE)
    expect(screen.getByTestId('control-runfrom-toolask-lastknown').textContent).toBe('The tool in the spindle is not known.')
  })

  it('Start now runs from the line: no tool change, no prelude M6', async () => {
    useMachineControl.setState({ activeTool: 1 })
    const loads = recordLoads()
    await planLine(LINE)
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')) })
    await advance(1000)
    expect(screen.queryByTestId('control-runfrom-toolask')).toBeNull()
    const prelude = [...document.querySelectorAll('[data-testid="control-runfrom-planbox"] .control-runfrom-prelude .control-runfrom-cmd')].map(el => el.textContent)
    expect(prelude.some(cmd => /M0?6\b/.test(cmd ?? ''))).toBe(false)
    expect(useMachineControl.getState().toolChange).toBeNull()
    const run = await runToEnd()
    evidence(`${route}-start-now.json`, { prelude, loads, run, console: useMachineControl.getState().consoleLines.map(l => l.text) })
    expect(run).toMatchObject({ toolChanges: [], phase: 'complete' })
    expect(run.x).toBeCloseTo(25, 1)
    expect(loads.flatMap(load => load.prelude ?? []).some(cmd => /M0?6\b/.test(cmd))).toBe(false)
  })

  it('Run the tool change first runs the program\'s T2 change, then starts from the line', async () => {
    useMachineControl.setState({ activeTool: 1 })
    await planLine(LINE)
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-change')) })
    await advance(1000)
    expect(screen.queryByTestId('control-runfrom-toolask')).toBeNull()
    const toolChanges: (number | null)[] = []
    if (route === 'text') {
      // The text door runs the guided change now; its card arms the line.
      await advance(10000)
      expect(useMachineControl.getState().toolChange).toMatchObject({ mode: 'toolChange', tool: 2, step: 'awaiting-swap', resumeLine: LINE })
      toolChanges.push(2)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
      expect(useMachineControl.getState().toolChange, useMachineControl.getState().consoleLines.map(l => l.text).join('\n'))
        .toMatchObject({ step: 'ready', tool: 2 })
      expect(useMachineControl.getState().toolChange!.message).toContain(`armed at line ${LINE}`)
    } else {
      // The staged door arms the line behind the program's own M6.
      const prelude = [...document.querySelectorAll('[data-testid="control-runfrom-planbox"] .control-runfrom-prelude .control-runfrom-cmd')].map(el => el.textContent)
      expect(prelude).toContain('T2 M6')
    }
    const run = await runToEnd()
    evidence(`${route}-tool-change-first.json`, { run, toolChanges: [...toolChanges, ...run.toolChanges], console: useMachineControl.getState().consoleLines.map(l => l.text) })
    expect([...toolChanges, ...run.toolChanges]).toEqual([2])
    expect(run.phase).toBe('complete')
    expect(run.x).toBeCloseTo(25, 1)
  })

  // Fix round 1 (astra audit, 10-14): Start now leaves T1 fitted, so the
  // remainder must not read as if T2 were - its own later M6 to T2 still runs.
  for (const [kind, m6] of [['an explicit T2 M6', 'T2 M6'], ['a bare M6 (T2 preselected)', 'M6']] as const) {
    it(`Start now with T1 fitted: ${kind} later in the program still runs its tool change`, async () => {
      const later = ['G21 G90 G54', 'T1 M6', 'G0 X10 Z-1', 'G1 X15 F300', 'T2 M6', 'G0 X20 Z-1', 'G1 X25 F300', m6, 'G1 X30 F300', 'M30'].join('\n')
      if (route === 'text') loadMachineProgram('wo2810-later.nc', later)
      else expect(loadGcodeTextToolpathProgram('wo2810-later.nc', later, { publishListing: true }).ok).toBe(true)
      await advance(3000)
      expect(useMachineControl.getState().job.phase).toBe('ready')
      useMachineControl.setState({ activeTool: 1 })
      await planLine(LINE)
      await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-toolask-now')) })
      await advance(1000)
      expect(useMachineControl.getState().toolChange).toBeNull()
      const run = await runToEnd()
      evidence(`${route}-start-now-later-${m6 === 'M6' ? 'bare' : 'explicit'}-m6.json`, { run, console: useMachineControl.getState().consoleLines.map(l => l.text) })
      expect(run.toolChanges, useMachineControl.getState().consoleLines.map(l => l.text).join('\n')).toEqual([2])
      expect(run.phase).toBe('complete')
      expect(run.x).toBeCloseTo(30, 1)
    })
  }
})
