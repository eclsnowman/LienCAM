// @vitest-environment jsdom
//
// WO-1979: the tools screen says what it does - Setter Z with a typed/measured
// mark, the always-visible "star a Ref" line, the pad chosen beside Probe work
// Z0 (last pad used preselected), and Main's "Open tool table" label.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

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
const { ToolGlance } = await import('../../components/machine/ToolGlance')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { saveMachineToolRecord, useMachineToolTable } = await import('../../store/machineToolTableStore')

function machineId(): string {
  return useCamStore.getState().project.machine?.id ?? 'default'
}

function saveActive(): void {
  saveMachineToolRecord(useCamStore.getState().project.machine)
}

beforeEach(() => {
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: `wo1979-test-${crypto.randomUUID()}`,
    toolTable: undefined,
    probeOverrides: undefined,
    probePads: undefined,
    activeProbePadId: undefined,
  })
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeTool: null,
    tlo: null,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WO-1979: tool table column and marks', () => {
  it('the column reads Setter Z, not Pad Z', () => {
    useMachineToolTable.getState().addTool(machineId(), 1)
    saveActive()
    render(<ToolsProbePanel />)
    const head = screen.getByTestId('control-tools-table').textContent ?? ''
    expect(head).toContain('Setter Z')
    expect(head).not.toContain('Pad Z')
  })

  it('a typed number is marked typed; a probe reading is marked measured', () => {
    const id = machineId()
    useMachineToolTable.getState().addTool(id, 1)
    useMachineToolTable.getState().addTool(id, 2)
    useMachineToolTable.getState().recordProbedZ(id, 2, -41.25, 1234)
    saveActive()
    render(<ToolsProbePanel />)
    // No value yet -> no mark.
    expect(screen.queryByTestId('control-tool-len-source-1')).toBeNull()
    expect(screen.getByTestId('control-tool-len-source-2').textContent).toBe('measured')

    const len = screen.getByTestId('control-tool-len-1') as HTMLInputElement
    fireEvent.change(len, { target: { value: '-40.5' } })
    fireEvent.blur(len)
    expect(screen.getByTestId('control-tool-len-source-1').textContent).toBe('typed')
    expect(screen.getByTestId('control-tool-len-source-2').textContent).toBe('measured')

    // Typing over a measured value makes it typed.
    const len2 = screen.getByTestId('control-tool-len-2') as HTMLInputElement
    fireEvent.change(len2, { target: { value: '-39' } })
    fireEvent.blur(len2)
    expect(screen.getByTestId('control-tool-len-source-2').textContent).toBe('typed')
  })
})

describe('WO-1979: Ref requirement line', () => {
  it('shows only while tools exist and none is starred Ref', () => {
    render(<ToolsProbePanel />)
    expect(screen.queryByTestId('control-tools-ref-needed')).toBeNull()

    fireEvent.change(screen.getByTestId('control-tool-add-input'), { target: { value: '1' } })
    fireEvent.click(screen.getByTestId('control-tool-add'))
    expect(screen.getByTestId('control-tools-ref-needed').textContent).toContain('Star the tool')

    fireEvent.click(screen.getByTestId('control-tool-ref-1'))
    expect(screen.queryByTestId('control-tools-ref-needed')).toBeNull()

    fireEvent.click(screen.getByTestId('control-tool-ref-1'))
    expect(screen.getByTestId('control-tools-ref-needed')).toBeTruthy()
  })
})

describe('WO-1979: pad chosen at probing', () => {
  it('sits beside Probe work Z0, hidden with one pad, last used preselected', () => {
    render(<ToolsProbePanel />)
    const z0 = screen.getByTestId('control-probe-z0')
    const add = screen.getByTestId('control-probe-pad-add')
    // WO-2429: Probe work Z0 moved to the Probe card under the jog; the pad
    // settings stay in the Tools panel. The pad is still chosen at probing:
    // both are on this one screen.
    expect(z0.closest('[data-testid="control-tools-probe-card"]')).toBeTruthy()
    expect(add.closest('[data-testid="control-tools-probe-card"]')).toBeNull()

    expect(screen.queryByTestId('control-probe-pad-select')).toBeNull()
    fireEvent.click(add)
    expect(screen.queryByTestId('control-probe-pad-select')).toBeNull()
    fireEvent.click(add)
    const select = screen.getByTestId('control-probe-pad-select') as HTMLSelectElement
    expect(select.parentElement!.parentElement).toBe(add.parentElement)
    // Adding makes the newest pad the active (last used) one.
    expect(select.value).toBe('pad-2')

    fireEvent.change(select, { target: { value: 'pad-1' } })
    cleanup()
    render(<ToolsProbePanel />)
    expect((screen.getByTestId('control-probe-pad-select') as HTMLSelectElement).value).toBe('pad-1')
  })
})

describe('WO-1979: Main TOOL box label', () => {
  it('reads Open tool table and still calls onChangeTool', () => {
    const onChangeTool = vi.fn()
    render(<ToolGlance onChangeTool={onChangeTool} />)
    const btn = screen.getByTestId('control-tool-glance-change')
    expect(btn.textContent).toContain('Open tool table')
    expect(btn.textContent).not.toContain('Change tool')
    fireEvent.click(btn)
    expect(onChangeTool).toHaveBeenCalledTimes(1)
  })
})
