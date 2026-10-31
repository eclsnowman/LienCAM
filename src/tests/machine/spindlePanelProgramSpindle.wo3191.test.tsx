// @vitest-environment jsdom
//
// WO-3191 (gap CT-5, the owner's approved alpha.3.2 plan, Tier 1): a posted program
// runs M3 S10000 on the simulator. During the run, and in Feed Hold, the
// spindle panel lit Off while the readout said 10000 rpm, and CW never lit:
// the panel took its direction only from its OWN presses.
//
// The direction the panel lights is the last M3/M4/M5 actually sent to the
// controller by any route - the program stream, MDI, the panel. Running /
// stopped stays the machine's report, and the direction never comes from the
// inverter (VFD-COMMISSIONING.md 4.9).
//
// Driven through the production session and the simulated controller, by
// Control's own doors (Load, CYCLE START, Feed Hold, the MDI line), and read
// off the rendered SpindlePanel.
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

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
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeFile,
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart, executeOperatorFeedHold, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { spindleWordInLine } = await import('../../lib/machine/commandedSpindle')

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
async function advance(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) await act(async () => { await vi.advanceTimersByTimeAsync(step) })
}
async function runUntil(done: () => boolean, ms = 60000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    await advance(50)
    if (done()) return
  }
  throw new Error(`never reached; console:\n${consoleText()}`)
}

/** A posted program in the CT-5 repro's shape: M3 S10000, a cut long enough
 *  to Feed Hold inside, then M5 before the end. */
const PROGRAM = [
  'G21 G90 G54',
  'G0 Z5',
  'M3 S10000',
  'G0 X10 Y10',
  'G1 Z-1 F300',
  'G1 X80 F300',
  'G0 Z5',
  'M5',
  'G0 X0 Y0',
  'M30',
].join('\n')

/** Which spindle member the rendered panel lights, or null for none. */
function lit(): string | null {
  const members = ['cw', 'ccw', 'off'].filter((dir) =>
    screen.getByTestId(`control-spindle-${dir}`).className.includes('control-latched'))
  expect(members.length, `more than one lit: ${members.join(', ')}`).toBeLessThanOrEqual(1)
  return members[0] ?? null
}

const rpm = () => useMachineControl.getState().spindleRpm ?? 0

describe('WO-3191 the spindle panel shows the spindle a program started (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(3000)
    for (const [axis, mm] of [['X', -300], ['Y', -225], ['Z', -60]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    useMachineControl.setState({ consoleLines: [] })
    render(createElement(SpindlePanel, { onOpenActions: () => {} }))
  })

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('CT-5: a program\'s M3 S10000 lights CW while it runs and in Feed Hold; its M5 lights Off', async () => {
    expect(lit()).toBe('off')
    expect(loadGcodeFile('ct5.gcode', PROGRAM, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => rpm() >= 10000 && useMachineControl.getState().machineState === 'run')
    expect(lit(), `running at ${rpm()} rpm\n${consoleText()}`).toBe('cw')

    // Feed Hold inside the cut: the spindle keeps turning, CW stays lit.
    const at = () => getMachineController().status().workPos!
    await runUntil(() => at().z < -0.5 && at().x > 20)
    expect(executeOperatorFeedHold()).toBe(true)
    await runUntil(() => useMachineControl.getState().machineState === 'hold')
    await advance(1000)
    expect(rpm()).toBeGreaterThanOrEqual(10000)
    expect(lit(), `in Feed Hold\n${consoleText()}`).toBe('cw')

    // Resume; the program's own M5 lights Off.
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => useMachineControl.getState().job.phase === 'complete'
      && useMachineControl.getState().machineState === 'idle')
    await advance(500)
    expect(rpm()).toBe(0)
    expect(lit(), consoleText()).toBe('off')
  })

  it('Stop/Reset while the program\'s spindle runs lights Off: the controller stopped it (WO-2863)', async () => {
    expect(loadGcodeFile('ct5.gcode', PROGRAM, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => rpm() >= 10000 && useMachineControl.getState().machineState === 'run')
    expect(lit()).toBe('cw')
    expect(executeOperatorStopReset(), consoleText()).toBeTruthy()
    await runUntil(() => rpm() === 0 && useMachineControl.getState().machineState === 'idle')
    await advance(500)
    expect(lit(), consoleText()).toBe('off')
  })

  it('an MDI M3 lights CW, a refused MDI M4 moves nothing, and an MDI M5 lights Off', async () => {
    expect(sendMdiLine('M3 S8000'), consoleText()).toBe(true)
    await runUntil(() => rpm() >= 8000)
    expect(lit(), consoleText()).toBe('cw')
    // The Sample hobby router turns clockwise only: the controller refuses M4,
    // so it never went, and the panel does not claim it.
    expect(sendMdiLine('M4 S8000')).toBe(false)
    await advance(200)
    expect(lit(), consoleText()).toBe('cw')
    expect(sendMdiLine('M5'), consoleText()).toBe(true)
    await runUntil(() => rpm() === 0)
    expect(lit(), consoleText()).toBe('off')
  })

  it('compact MDI words count (astra audit): N10M3S10000 lights CW, N20M5 lights Off', async () => {
    expect(sendMdiLine('N10M3S10000'), consoleText()).toBe(true)
    await runUntil(() => rpm() >= 10000)
    expect(lit(), `N10M3S10000 at ${rpm()} rpm\n${consoleText()}`).toBe('cw')
    expect(sendMdiLine('N20M5'), consoleText()).toBe(true)
    await runUntil(() => rpm() === 0)
    await advance(200)
    expect(lit(), `N20M5 at ${rpm()} rpm\n${consoleText()}`).toBe('off')
  })

  it('a program written without spaces (N30M3S10000 ... N80M5) lights CW, then Off', async () => {
    const compact = PROGRAM.split('\n').map((line, i) => `N${(i + 1) * 10}${line.replace(/ /g, '')}`).join('\n')
    expect(loadGcodeFile('compact.gcode', compact, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => rpm() >= 10000 && useMachineControl.getState().machineState === 'run')
    expect(lit(), `running at ${rpm()} rpm\n${consoleText()}`).toBe('cw')
    await runUntil(() => useMachineControl.getState().job.phase === 'complete'
      && useMachineControl.getState().machineState === 'idle')
    await advance(500)
    expect(rpm()).toBe(0)
    expect(lit(), consoleText()).toBe('off')
  })

  it('a refused MDI spindle line moves nothing (WO-474: only a command that went)', async () => {
    getMachineController().emergencyStop()
    await advance(200)
    expect(sendMdiLine('M3 S10000')).toBe(false)
    await advance(200)
    expect(lit()).toBe('off')
  })
})

describe('WO-3191 spindleWordInLine reads the word, not a lookalike', () => {
  it.each([
    ['M3 S10000', 'cw'],
    ['m03 s5000', 'cw'],
    ['M4', 'ccw'],
    ['N20 M5', 'off'],
    ['M3 S1000 M5', 'off'],
    ['G0 X10 (M3 in a comment)', null],
    ['G0 X10 ; M4 after a semicolon', null],
    ['M30', null],
    ['M50', null],
    ['M3.1', null],
    ['G1 X5 F300', null],
    // Address words need no spaces between them (astra audit).
    ['N20M5', 'off'],
    ['N10M3S10000', 'cw'],
    ['M3S10000', 'cw'],
    ['G0X1M5', 'off'],
    ['M4S500(M3 in a comment)', 'ccw'],
    ['N5M5;M3 after a semicolon', 'off'],
    ['(M3)M4', 'ccw'],
    ['N10M30', null],
    ['G0X1M50', null],
    ['M3.1S100', null],
    ['X1.5M3', 'cw'],
    ['S3000M3M5', 'off'],
    ['G0X1(M3 never closed', null],
  ] as const)('%s -> %s', (line, expected) => {
    expect(spindleWordInLine(line)).toBe(expected)
  })
})
