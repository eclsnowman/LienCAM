// @vitest-environment jsdom
// WO-2562: sample the real panel and transport DOM on animation frames and
// mutations. The native simulator runs the alignment file through the real
// file door, including commands in a pause and the later program holds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { writeFileSync } from 'node:fs'
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
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const {
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlPage } = await import('../../components/machine/ControlPage')

/** The align run's program (plan/programs/wo2256-air-two-tools.nc). */
const ALIGN = [
  'G90 G94 G17 G21 G64', //            1
  'G54', //                            2
  'T19', //                            3
  '(air run - no spindle start)', //   4
  'G0 X0 Y0 Z15', //                   5  section 1
  'Z5', //                             6
  'G1 Z0 F300', //                     7
  'G1 X40 Y0 Z-1 F600', //             8
  'G0 Z15', //                         9
  'M5', //                             10
  'M0', //                             11
  '(air run - no spindle start)', //   12
  'G0 X0 Y10', //                      13 section 2
  'G1 Z-1 F300', //                    14
  'G1 X60 Y10 F600', //                15 the pause is inside this cut
  'G1 X60 Y20', //                     16
  'G1 X0 Y20', //                      17
  'G0 Z15', //                         18
  'M5', //                             19
  'M0', //                             20
  'G0 X10 Y30', //                     21 section 3
  '(air run - no spindle start)', //   22
  'G1 Z-1 F300', //                    23
  'G1 X50 Y30 F600', //                24
  'G0 Z15', //                         25
  'M5', //                             26
  'M9', //                             27
  'T1 M6', //                          28
  'M0', //                             29
  '(air run - no spindle start)', //   30
  'G0 X10 Y40 Z15', //                 31 section 4
  'Z5', //                             32
  'G1 Z-2 F300', //                    33
  'G1 X70 Y40 F600', //                34
  'G0 Z15', //                         35
  'M5', //                             36
  'M30', //                            37
].join('\n')

const SIM_ID = 'wo2562-simulator'
const SIM_PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const MOVE_LINES = [5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 21, 23, 24, 25, 31, 32, 33, 34, 35]
const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
const at = () => getMachineController().status().workPos!
type Frame = { at: number; via: string; progress: string; line: number | null; header: string; transport: string; chip: string; phase: string; partHold: boolean; moving: boolean; executing: number | null }
let frames: Frame[] = []
let raf = 0
let observer: MutationObserver | null = null
function sample(via: string) {
  const row = document.querySelector('.gcode-line-hl .gcode-lineno')
  frames.push({
    at: Date.now(), via,
    progress: screen.getByTestId('control-progress-text').textContent ?? '',
    line: row ? Number(row.textContent) : null,
    header: screen.queryByTestId('control-program-context')?.textContent ?? '',
    transport: screen.getByTestId('control-next-action').textContent ?? '',
    chip: screen.getByTestId('control-state-chip').textContent ?? '',
    phase: useMachineControl.getState().job.phase,
    moving: getMachineController().machineState() === 'run',
    executing: useMachineControl.getState().executingMoveId,
    partHold: /Program held at part|waiting for part/.test(screen.getByTestId('control-next-action').textContent ?? ''),
  })
}
function startSampling() {
  frames = []
  observer = new MutationObserver(() => sample('mutation'))
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  const tick = () => { sample('raf'); raf = requestAnimationFrame(tick) }
  raf = requestAnimationFrame(tick)
}
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 16) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, ms - t)) })
}
async function until(done: () => boolean, ms = 120000) {
  for (let t = 0; t < ms; t += 16) {
    await advance(16)
    if (done()) return
  }
  throw new Error(`never reached: ${consoleText()}`)
}
async function action(fn: () => unknown) { await act(async () => { await fn() }) }
function checkFrames(seen: Frame[], frozen = false) {
  expect(seen.length).toBeGreaterThan(0)
  let previous = 0
  for (const frame of seen) {
    const count = Number(/^(\d+)\//.exec(frame.progress)?.[1])
    expect(count, JSON.stringify(frame)).toBeGreaterThanOrEqual(previous)
    previous = count
    if (frame.phase === 'streaming' && !frozen && !/paused at|returning to/.test(frame.header)) {
      expect(frame.header, JSON.stringify(frame)).not.toMatch(/ ready$/)
      expect(frame.chip, JSON.stringify(frame)).not.toBe('Idle')
    }
    if (frame.moving && !frozen) {
      expect(frame.transport, JSON.stringify(frame)).not.toMatch(/Program checks passed|begins the program/)
    }
    if (frame.line !== null && frame.phase !== 'complete') {
      const section = frame.line < 13 ? 1 : frame.line < 21 ? 2 : frame.line < 31 ? 3 : 4
      expect(frame.header.startsWith(`wo2256-air-two-tools.nc - File section ${section} (G54)`), JSON.stringify(frame)).toBe(true)
      const named = /(?:paused at|returning to) line (\d+)/.exec(frame.header)
      if (named) expect(Number(named[1]), JSON.stringify(frame)).toBe(frame.line)
      const transportLine = /(?:paused at|Returning to) line (\d+)/.exec(frame.transport)
      if (transportLine) expect(Number(transportLine[1]), JSON.stringify(frame)).toBe(frame.line)
    }
    if (frozen) {
      expect(frame.progress, JSON.stringify(frame)).toMatch(/^7\/20 \((?!100)\d+%\)/)
      expect(frame.progress.split(')')[0], JSON.stringify(frame)).toBe(seen[0].progress.split(')')[0])
      expect(frame.progress).not.toContain('done in')
      expect(frame.line, JSON.stringify(frame)).toBe(15)
      expect(frame.header).toMatch(/^wo2256-air-two-tools\.nc - File section 2 \(G54\) (?:paused at|returning to) line 15/)
      expect(frame.transport).not.toMatch(/Cycle complete|Program checks passed|begins the program/)
    } else if (frame.executing !== null && frame.moving && frame.line !== null && !frame.partHold && frame.phase !== 'complete'
      && !/paused at|returning to/.test(frame.header) && !/tool change/.test(frame.transport)) {
      expect(count, JSON.stringify(frame)).toBe(MOVE_LINES.indexOf(frame.line))
    }
  }
}
describe('WO-2562 every rendered frame, native simulator and real file door/panel/transport', () => {
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
    observer?.disconnect(); cancelAnimationFrame(raf)
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })


  it('names the held M0 file line in the real MDI box, retaining running and stopped authority', async () => {
    render(createElement(ControlPage))
    await action(() => expect(loadGcodeTextToolpathProgram('wo2256-air-two-tools.nc', ALIGN, { publishListing: true }).ok).toBe(true))
    await advance(300)
    const input = () => screen.getByTestId('control-mdi-input') as HTMLInputElement
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => getMachineController().machineState() === 'run')
    expect(input().disabled).toBe(true)
    expect(input().placeholder).toBe('A program is running - MDI is locked out.')
    await until(() => /stopped at the M0 on line 11/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    expect(input().disabled).toBe(true)
    expect(input().placeholder).toBe('Program held at line 11 - MDI is locked until it ends or you press Stop/Reset')
    await action(() => useMachineControl.getState().clearConsole())
    expect(input().placeholder).toContain('Program held at line 11')
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => getMachineController().machineState() === 'run')
    expect(input().placeholder).toBe('A program is running - MDI is locked out.')
    await until(() => /stopped at the M0 on line 20/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    expect(input().placeholder).toBe('Program held at line 20 - MDI is locked until it ends or you press Stop/Reset')
    expect(input().disabled).toBe(true)
    await action(() => expect(executeOperatorStopReset()).toBe(true))
    await advance(1500)
    expect(input().disabled).toBe(false)
    expect(input().placeholder).toBe('MDI - type a g-code line, Enter to send')
  }, 120000)

  it('keeps one answer through the full align run, MDI, jog, T19 M6, return, M0 and T1 hold', async () => {
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar)))
    await action(() => expect(loadGcodeTextToolpathProgram('wo2256-air-two-tools.nc', ALIGN, { publishListing: true })).toEqual({ ok: true, reason: null }))
    await advance(300)
    startSampling()
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    await until(() => /stopped at the M0 on line 11/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    await until(() => at().z < -0.5 && Math.abs(at().y - 10) < 0.01 && at().x > 20)
    await action(() => expect(executeOperatorFeedHold()).toBe(true))
    await advance(1500)
    const beforePauseCommands = frames.length
    await action(() => expect(sendMdiLine('G0 Z10')).toBe(true))
    await until(() => /loaded again after the MDI line/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    await action(() => expect(getMachineController().jog('X', 5, 1000)).toBe(true))
    await until(() => getMachineController().machineState() === 'idle' && /Stopped at line 15/.test(consoleText()))
    await advance(300)
    await action(() => expect(sendMdiLine('T19 M6')).toBe(true))
    let answered = false
    await until(() => {
      const card = useMachineControl.getState().toolChange
      if (card?.step === 'awaiting-swap' && !answered) { answered = true; fireEvent.click(screen.getByTestId('control-tc-continue')) }
      return answered && card === null && getMachineController().machineState() === 'idle'
    })
    await advance(300)
    const afterPauseCommands = frames.length
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    await until(() => at().z < -0.99 && at().x > 25 && Math.abs(at().y - 10) < 0.01)
    await until(() => /stopped at the M0 on line 20/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(500)
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    answered = false
    await until(() => {
      const card = useMachineControl.getState().toolChange
      if (card?.tool === 1 && card.step === 'awaiting-swap' && !answered) { answered = true; fireEvent.click(screen.getByTestId('control-tc-continue')) }
      return answered && card === null && getMachineController().machineState() === 'idle'
    })
    // WO-2586 on main preserves the explicit M0 after this M6.
    await until(() => /stopped at the M0 on line 29/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    await until(() => useMachineControl.getState().job.phase === 'complete')
    await advance(300)
    observer?.disconnect(); cancelAnimationFrame(raf)
    if (process.env.WO2562_EVIDENCE) writeFileSync(process.env.WO2562_EVIDENCE, frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
    console.info(`WO-2562: ${frames.length} DOM/RAF samples; ${afterPauseCommands - beforePauseCommands} pause-command samples`)
    checkFrames(frames)
    checkFrames(frames.slice(beforePauseCommands, afterPauseCommands), true)
    expect(screen.getByTestId('control-progress-text').textContent).toMatch(/^20\/20 \(100%\) done in \d+s/)
    expect(screen.getByTestId('control-next-action').textContent).toMatch(/^Cycle complete/)
    // WO-2608, Operator ruling: "Fix all three" includes the end sentence matching
    // From line / Plan, also for an opened file with no CAM context.
    expect(screen.getByTestId('control-runfrom-input')).toBeTruthy()
    // WO-2686 (the operator, 10-08): the end sentence names CYCLE START, which runs it from line 1.
    expect(screen.getByTestId('control-next-action').textContent).toContain('CYCLE START runs the program from line 1.')
  }, 120000)

  it.each([1, 2])('counts every staged step through %i G4 dwells without stepping backward', async (dwells) => {
    const lines = [
      'G90 G21 G54', 'G0 X0 Y0 Z15', 'G1 Z0 F300', 'G1 X10 F600',
      'G4 P0.5', 'G1 X20',
      ...(dwells === 2 ? ['G4 P0.5'] : []),
      'G1 X30', 'G1 X40', 'G0 Z15', 'M30',
    ]
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar)))
    await action(() => expect(loadGcodeTextToolpathProgram('wo2562-dwells.nc', lines.join('\n'), { publishListing: true })).toEqual({ ok: true, reason: null }))
    await advance(300)
    const steps = useMachineControl.getState().stagedProgram!.program.steps
    expect(steps.filter((step) => step.kind === 'dwell')).toHaveLength(dwells)
    expect(steps).toHaveLength(7 + dwells)
    // Every row between the modal preamble and M30 is one staged step,
    // including G4. Controller step ids are distinct from file line numbers.
    const moveLines = lines.slice(1, -1).map((_, index) => index + 2)
    const ordinalByLine = new Map(moveLines.map((line, index) => [line, index]))
    startSampling()
    await action(async () => expect(await executeOperatorCycleStart(), consoleText()).toBe(true))
    await until(() => useMachineControl.getState().job.phase === 'complete')
    await advance(300)
    if (process.env.WO2562_DWELL_EVIDENCE) writeFileSync(`${process.env.WO2562_DWELL_EVIDENCE}-${dwells}.ndjson`, frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
    let previous = 0
    const seenLines = new Set<number>()
    for (const frame of frames) {
      const count = Number(/^(\d+)\//.exec(frame.progress)?.[1])
      expect(count, JSON.stringify(frame)).toBeGreaterThanOrEqual(previous)
      previous = count
      if (frame.line !== null && frame.phase === 'streaming') {
        seenLines.add(frame.line)
        expect(count, JSON.stringify(frame)).toBe(ordinalByLine.get(frame.line))
        expect(frame.header, JSON.stringify(frame)).toBe('wo2562-dwells.nc - 1 section (G54)')
        expect(frame.transport, JSON.stringify(frame)).not.toMatch(/Cycle complete|Program checks passed/)
      }
    }
    expect([...seenLines].sort((a, b) => a - b)).toEqual(moveLines)
    expect(screen.getByTestId('control-progress-text').textContent).toMatch(new RegExp(`^${steps.length}/${steps.length} \\(100%\\) done in \\d+s`))
    expect(screen.getByTestId('control-next-action').textContent).toMatch(/^Cycle complete/)
    console.info(`WO-2562: ${dwells} G4 dwells; ${frames.length} DOM/RAF samples; all ${steps.length} staged rows observed`)
  })

  it('keeps the pause while a return receipt waits, and after that receipt refuses', async () => {
    render(createElement(Fragment, null, createElement(ProgramPanel), createElement(ControlTransportBar)))
    await action(() => expect(loadGcodeTextToolpathProgram('wo2256-air-two-tools.nc', ALIGN, { publishListing: true }).ok).toBe(true))
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => /stopped at the M0 on line 11/.test(consoleText()) && getMachineController().machineState() === 'idle')
    await advance(300)
    await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
    await until(() => at().z < -0.5 && Math.abs(at().y - 10) < 0.01 && at().x > 20)
    await action(() => expect(executeOperatorFeedHold()).toBe(true))
    await advance(1500)
    await action(() => expect(getMachineController().jog('X', 5, 1000)).toBe(true))
    await until(() => getMachineController().machineState() === 'idle' && /Stopped at line 15/.test(consoleText()))
    await advance(300)
    const sim = getMachineController()
    let receipt!: (confirmed: boolean) => void
    // The bridge's delayed WCS receipt, on the native simulator's otherwise
    // unchanged file door. No return is staged or started on a refused reply.
    sim.selectWcsAwait = () => new Promise<boolean>((resolve) => { receipt = resolve })
    startSampling()
    try {
      await action(async () => expect(await executeOperatorCycleStart()).toBe(true))
      await advance(300)
      expect(screen.getByTestId('control-program-context').textContent).toBe('wo2256-air-two-tools.nc - File section 2 (G54) returning to line 15')
      await action(() => receipt(false))
      await advance(300)
      checkFrames(frames, true)
      expect(screen.getByTestId('control-program-context').textContent).toBe('wo2256-air-two-tools.nc - File section 2 (G54) paused at line 15')
      expect(sim.hasActiveJob()).toBe(false)
      expect(sim.machineState()).toBe('idle')
      console.info(`WO-2562: ${frames.length} delayed/refused return DOM/RAF samples`)
    } finally {
      delete sim.selectWcsAwait
      observer?.disconnect(); cancelAnimationFrame(raf)
    }
  })

})
