// @vitest-environment jsdom
//
// WO-2695 (WO-2692 follow-up) - the simulated setter's top is where the
// machine's measured reference tool touched it.
//
// FINDING (cloud journey 10-09 final walkthrough, E1/E2): WO-2692 put the
// simulated setter's top at probing.toolSetter Z. On LienCNC V2 that Z (120)
// is UCCNC's FixedProbePos - the measure's START height - while the real setter
// is touched near machine Z 48.3 (the record's measured tools, reference T19
// 48.2925). Every simulated guided change then read "contact at machine Z
// 120.00 mm. Tool length offset 71.71 mm applied." and the resume was refused
// for travel.
//
// OUTCOME: at simulator connect the setter's top is the session machine's
// measured reference contact (the same tool table the guided change measures
// against) when it lies below the stated Z; otherwise the stated Z, as before.
// X/Y and diameter unchanged. Simulator only.
//
// Driven through the production path: Operator's imported profile
// (docs/machine/profiles/LienCNCV2.machine.json, its own tool table),
// connectMachine('simulator'), Load, CYCLE START, and the real ProgramPanel's
// guided tool-change Continue.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MachineConfig } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (k: string) => memory.get(k) ?? null,
  key: (i: number) => [...memory.keys()][i] ?? null,
  removeItem: (k: string) => { memory.delete(k) },
  setItem: (k: string, v: string) => { memory.set(k, String(v)) },
} satisfies Storage })

const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useProbeRoutineStore } = await import('../../store/probeRoutineStore')
const { findTool } = await import('../../lib/machine/toolTable')
const { SIMULATED_TOOL_SETTER_DIAMETER_MM } = await import('../../lib/machine/simulatedController')
const {
  __resetEstopInterlockForTest, cancelGuidedToolChange, connectMachine, disconnectMachine,
  getMachineController, getSimulatedToolSetter, loadGcodeTextToolpathProgram,
  setActiveToolLengthDatum, setWorkOffsetValue, simulatedToolSetterTopZ,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const PROFILE = JSON.parse(readFileSync(
  resolve('docs/machine/profiles/LienCNCV2.machine.json'), 'utf8',
)) as MachineConfig
/** The record's measured reference: T19, contact at machine Z 48.2925. */
const REFERENCE_Z = 48.2925
const STATED = { x: 738, y: 724.5, z: 120 }
/** Margin of error: the spread of the record's repeated contacts of the SAME
 *  tool, T19 on the setter - 47.50 (machine seat, 10-07, as reported) to
 *  48.40 (SESSION-2026-09-30 capture); the in-tree captures alone span
 *  48.2925 (stored) to 48.40. See src/tests/evidence/WO-2692-followup/proof.md. */
const MARGIN_MM = 0.9
const EVIDENCE = join(process.cwd(), 'src/tests/evidence/WO-2692-followup')
/** Work zero inside travel (X 738 / Y 724.5 / Z 129.2). */
const WORK = { x: 300, y: 300, z: 60 }
const PROGRAM = ['G21', 'G90', 'G54', 'T19 M6', 'G0 Z10', 'G1 X10 Y10 F2000', 'T1 M6', 'G0 Z10', 'G1 X20 Y20 F2000', 'G0 Z20', 'M30'].join('\n')

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

async function connect(machine: MachineConfig): Promise<void> {
  useCamStore.getState().setProjectMachine(machine)
  useCamStore.getState().setControlSessionMachine(machine)
  const p = connectMachine('simulator', 115200)
  await advance(300); await p
  __resetEstopInterlockForTest()
  getMachineController().home(); await advance(5000)
}

beforeEach(() => {
  vi.useFakeTimers()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useProbeRoutineStore.setState({ routines: {}, quarantined: {}, hidden: [] })
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null, activeTool: null })
  setActiveToolLengthDatum(null)
})

afterEach(async () => {
  cleanup()
  cancelGuidedToolChange()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  __resetEstopInterlockForTest()
  vi.useRealTimers()
})

describe('WO-2695: the simulated setter stands where the measured reference touched it', () => {
  it('LienCNC V2 (imported record): a guided M6 measures T1 at ~48.29, offset ~0, and the program resumes', async () => {
    const machine = PROFILE
    expect(machine.probing?.toolSetter).toMatchObject(STATED)
    expect(machine.toolTable?.reference).toBe(19)
    await connect(machine)
    const table = useMachineToolTable.getState().tableFor(machine.id)
    expect(findTool(table, 19)?.probedMachineZ).toBeCloseTo(REFERENCE_Z, 4)

    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(setWorkOffsetValue('G54', axis, WORK[axis.toLowerCase() as 'x' | 'y' | 'z'])).toBe(true)
      await advance(100)
    }
    useMachineControl.setState({ activeTool: 19, consoleLines: [] })
    render(createElement(ProgramPanel))
    act(() => { expect(loadGcodeTextToolpathProgram('wo2695.nc', PROGRAM).ok).toBe(true) })
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    for (let t = 0; t <= 120_000 && useMachineControl.getState().toolChange?.step !== 'awaiting-swap'; t += 100) await advance(100)
    expect(useMachineControl.getState().toolChange, consoleText()).toMatchObject({ mode: 'toolChange', tool: 1, step: 'awaiting-swap' })

    fireEvent.click(screen.getByTestId('control-tc-continue'))
    for (let t = 0; t <= 180_000 && useMachineControl.getState().job.phase !== 'complete'; t += 100) await advance(100)

    const text = consoleText()
    const measured = /T1 measured: contact at machine Z (-?[\d.]+) mm\. Tool length offset (-?[\d.]+) mm applied\./.exec(text)
    const evidence = {
      phase: process.env.WO2695_PHASE ?? 'branch',
      simulatedSetter: getSimulatedToolSetter(),
      measuredLine: measured?.[0] ?? null,
      t1TableZ: findTool(useMachineToolTable.getState().tableFor(machine.id), 1)?.probedMachineZ ?? null,
      jobPhase: useMachineControl.getState().job.phase,
      console: useMachineControl.getState().consoleLines.map((l) => l.text),
    }
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(join(EVIDENCE, `${evidence.phase}-guided-m6.json`), `${JSON.stringify(evidence, null, 2)}\n`)

    // The measure reads the reference tool's recorded contact within the
    // margin, the offset is near zero, and the resume is not refused.
    expect(measured, text).not.toBeNull()
    expect(Math.abs(Number(measured![1]) - REFERENCE_Z)).toBeLessThanOrEqual(MARGIN_MM)
    expect(Math.abs(Number(measured![2]))).toBeLessThanOrEqual(MARGIN_MM)
    expect(text).not.toMatch(/outside the machine's declared travel/)
    expect(text).not.toMatch(/refused to resume/)
    expect(findTool(useMachineToolTable.getState().tableFor(machine.id), 1)?.probedMachineZ).toBeCloseTo(REFERENCE_Z, 3)
    expect(useMachineControl.getState().job.phase, text).toBe('complete')
    // The setter on the simulated table: stated X/Y and diameter, top at the
    // measured reference contact.
    expect(getSimulatedToolSetter()).toEqual({
      x: STATED.x, y: STATED.y, topZ: REFERENCE_Z, diameter: SIMULATED_TOOL_SETTER_DIAMETER_MM,
    })
  }, 120_000)

  it('no measured reference: the top stays at the stated Z, as WO-2692 shipped', async () => {
    const machine: MachineConfig = { ...PROFILE, toolTable: { reference: null, tools: [] } }
    await connect(machine)
    expect(getSimulatedToolSetter()).toEqual({
      x: STATED.x, y: STATED.y, topZ: STATED.z, diameter: SIMULATED_TOOL_SETTER_DIAMETER_MM,
    })
  }, 60_000)

  it('the rule: the reference contact only when it is measured, finite and below the stated Z', () => {
    const tool = (t: number, z: number | null) => ({ tool: t, probedMachineZ: z, dia: null, note: '', measuredAt: z === null ? null : 1 })
    expect(simulatedToolSetterTopZ(120, { reference: 19, tools: [tool(19, 48.29)] })).toBe(48.29)
    expect(simulatedToolSetterTopZ(120, { reference: null, tools: [tool(19, 48.29)] })).toBe(120)
    expect(simulatedToolSetterTopZ(120, { reference: 19, tools: [tool(19, null)] })).toBe(120)
    expect(simulatedToolSetterTopZ(120, { reference: 19, tools: [tool(1, 48.29)] })).toBe(120)
    expect(simulatedToolSetterTopZ(40, { reference: 19, tools: [tool(19, 48.29)] })).toBe(40)
    expect(simulatedToolSetterTopZ(48.29, { reference: 19, tools: [tool(19, 48.29)] })).toBe(48.29)
  })
})
