// @vitest-environment jsdom
//
// MACHINE-CONTROL stage 10: Tools / Probe panel render smokes - table CRUD
// through the real stores, reference starring, apply gating, and probe
// button enablement. Probe MOTION is covered end to end in
// zProbeRunner.test.ts; here the machine stays disconnected or faked via
// store state.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

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

const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { saveMachineToolRecord, useMachineToolTable } = await import('../../store/machineToolTableStore')

function machineId(): string {
  return useCamStore.getState().project.machine?.id ?? 'default'
}

function connectIdle() {
  useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
}

/** WO-1676: the store's own mutators are pure cache writes now (see
 *  machineToolTableStore's file comment) - a real edit reaches the
 *  definition only through `ToolsProbePanel`'s own `save()` call after a UI
 *  interaction. A test that pokes the store directly, the way these two do
 *  to set up a scenario before/without going through the UI, has to do the
 *  same push `ToolsProbePanel` would have, or the panel (which reads the
 *  definition, not the cache) never sees it. */
function saveActive(): void {
  saveMachineToolRecord(useCamStore.getState().project.machine)
}

beforeEach(() => {
  useCamStore.getState().newProject()
  // WO-1676: the tool table now lives on the machine record, and `newProject`
  // deliberately KEEPS the machine library across projects (only the project
  // document resets) - so the previous test's writes to the shared default
  // machine id would otherwise still be sitting in the library entry. A fresh
  // id per test that names no library entry gives each test its own record,
  // the same isolation `useMachineToolTable.setState({ byMachine: {} })` used
  // to give for free when the table lived only in that store.
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: `wo1676-test-${crypto.randomUUID()}`,
    toolTable: undefined,
    probeOverrides: undefined,
  })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ToolsProbePanel', () => {
  it('renders disconnected with probe buttons disabled', () => {
    render(<ToolsProbePanel />)
    expect(screen.getByTestId('control-tools-panel')).toBeTruthy()
    expect((screen.getByTestId('control-probe-z0') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('control-probe-measure') as HTMLButtonElement).disabled).toBe(true)
  })

  it('adds tools, stars a reference, and edits cells inline', () => {
    connectIdle()
    render(<ToolsProbePanel />)
    fireEvent.change(screen.getByTestId('control-tool-add-input'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('control-tool-add'))
    fireEvent.change(screen.getByTestId('control-tool-add-input'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('control-tool-add'))
    expect(screen.getByTestId('control-tool-row-1')).toBeTruthy()
    expect(screen.getByTestId('control-tool-row-3')).toBeTruthy()

    fireEvent.click(screen.getByTestId('control-tool-ref-1'))
    expect(useMachineToolTable.getState().tableFor(machineId()).reference).toBe(1)

    const len = screen.getByTestId('control-tool-len-1') as HTMLInputElement
    fireEvent.change(len, { target: { value: '-40.5' } })
    fireEvent.blur(len)
    const t1 = useMachineToolTable.getState().tableFor(machineId()).tools.find((t) => t.tool === 1)!
    expect(t1.probedMachineZ).toBeCloseTo(-40.5, 3)

    fireEvent.click(screen.getByTestId('control-tool-remove-3'))
    expect(
      useMachineToolTable.getState().tableFor(machineId()).tools.map((t) => t.tool),
    ).toEqual([1])
  })

  it('gates Apply length on a measured reference AND a measured selected tool', () => {
    connectIdle()
    const id = machineId()
    const s = useMachineToolTable.getState()
    s.addTool(id, 1)
    s.addTool(id, 2)
    s.recordProbedZ(id, 1, -40, 1)
    s.setReference(id, 1)
    saveActive()
    render(<ToolsProbePanel />)
    // T2 selected but unmeasured -> Apply stays disabled.
    fireEvent.click(screen.getByTestId('control-tool-row-2'))
    expect((screen.getByTestId('control-tool-apply') as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      useMachineToolTable.getState().recordProbedZ(id, 2, -38.5, 2)
      saveActive()
    })
    expect((screen.getByTestId('control-tool-apply') as HTMLButtonElement).disabled).toBe(false)
  })

  it('Measure follows the selected row, falling back to the controller tool', () => {
    connectIdle()
    render(<ToolsProbePanel />)
    const measure = () => screen.getByTestId('control-probe-measure') as HTMLButtonElement
    expect(measure().disabled).toBe(true) // no selection, no active tool
    act(() => useMachineControl.setState({ activeTool: 5 }))
    expect(measure().disabled).toBe(false)
    expect(measure().textContent).toContain('T5')
    const id = machineId()
    act(() => {
      useMachineToolTable.getState().addTool(id, 2)
      saveActive()
    })
    fireEvent.click(screen.getByTestId('control-tool-row-2'))
    expect(measure().textContent).toContain('T2') // row pick wins over active tool
  })

  it('probe config cells edit the per-machine settings', () => {
    connectIdle()
    render(<ToolsProbePanel />)
    const pad = screen.getByTestId('control-probe-cfg-pad') as HTMLInputElement
    fireEvent.change(pad, { target: { value: '12.7' } })
    fireEvent.blur(pad)
    expect(useMachineToolTable.getState().probeConfigFor(machineId()).padThickness).toBeCloseTo(12.7, 3)
  })

  it('WO-2005: the pad thickness sits with the pad choice, not in the settings row', () => {
    connectIdle()
    render(<ToolsProbePanel />)
    const pad = screen.getByTestId('control-probe-cfg-pad')
    expect(screen.getAllByTestId('control-probe-cfg-pad')).toHaveLength(1)
    expect(pad.closest('.control-probe-pad-choice')).not.toBeNull()
    expect(pad.closest('.control-probe-cfg')).toBeNull()
    expect(pad.closest('.control-probe-pad-choice')).toBe(
      screen.getByTestId('control-probe-pad-add').closest('.control-probe-pad-choice'),
    )
  })
})
