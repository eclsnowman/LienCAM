// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { positionMacroBody, machineReferencePositions } = await import('../../types')
const { machineParkList } = await import('../../lib/machine/machineActions')
const session = await import('../../lib/machine/machineSession')
const points = { 1: { x: 20, y: 30, z: -2 }, 2: { x: 40, y: 50, z: -3 },
  3: { x: 60, y: 70, z: -4 }, 4: { x: 80, y: 90, z: -5 } }
const expected = ['G30 P1', 'G30 P2', 'G30 P3', 'G30 P4', 'Clamp pause']
const panelNames = () => Array.from(document.querySelectorAll('.control-macro-btn'))
  .map((element) => element.textContent!.trim())
const editorNames = () => Array.from(screen.getByTestId('macro-editor-list')
  .querySelectorAll('.macro-editor-name')).map((element) => element.textContent)
const row = (name: string) => within(screen.getByText(name, { selector: '.macro-editor-name' }).closest('.macro-editor-item') as HTMLElement)
function mount() { render(<MacroPanel onOpenActions={() => {}} rpm={10000} />) }
function edit() { fireEvent.click(screen.getByTestId('control-macros-edit')) }

beforeEach(() => {
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({ ...machine, id: 'wo2841', name: 'Park button fixture',
    controller: 'grbl', controllerDefinition: undefined, unsentSettings: undefined,
    referencePositions: points, safeZMachine: -6, travel: { x: 738, y: 724, z: 130 }, rapidRate: 60000,
    homeConvention: { x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
    macros: [{ id: 'clamp', name: 'Clamp pause', body: 'hold()' }],
  })
  useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'idle', homed: false })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('WO-2841 Edit macros and the real panel', () => {
  it('lists every panel button in the same order through both editor doors', () => {
    mount()
    expect(panelNames()).toEqual(expected)
    edit()
    expect(editorNames()).toEqual(expected)
    cleanup()
    render(<MachineActionsModal open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('control-action-add'))
    expect(editorNames()).toEqual(expected)
  })

  it('reorders across park/user rows, renames, hides and restores after persistence and remount', async () => {
    mount(); edit()
    fireEvent.click(row('Clamp pause').getByRole('button', { name: 'Move Clamp pause up' }))
    expect(editorNames()).toEqual(['G30 P1', 'G30 P2', 'G30 P3', 'Clamp pause', 'G30 P4'])
    expect(panelNames()).toEqual(editorNames())
    fireEvent.click(row('G30 P2').getByRole('button', { name: 'Edit G30 P2' }))
    fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Front park' } })
    fireEvent.click(screen.getByTestId('macro-editor-shown'))
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(panelNames()).toEqual(['G30 P1', 'G30 P3', 'Clamp pause', 'G30 P4'])
    expect(editorNames()).toContain('Front park')
    expect(machineReferencePositions(useCamStore.getState().project.machine)).toEqual(points)
    expect(machineParkList(useCamStore.getState().project.machine, undefined)).toHaveLength(4)
    cleanup()
    await act(async () => { await useMachineActions.persist.rehydrate() })
    mount(); edit()
    expect(panelNames()).not.toContain('Front park')
    fireEvent.click(row('Front park').getByRole('button', { name: 'Edit Front park' }))
    fireEvent.click(screen.getByTestId('macro-editor-shown'))
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(panelNames()).toEqual(['G30 P1', 'Front park', 'G30 P3', 'Clamp pause', 'G30 P4'])
  })

  it('deletes a fallback button without deleting or renumbering G30 points', () => {
    mount(); edit()
    fireEvent.click(row('G30 P1').getByRole('button', { name: 'Delete G30 P1' }))
    expect(panelNames()).not.toContain('G30 P1')
    expect(editorNames()).not.toContain('G30 P1')
    expect(machineReferencePositions(useCamStore.getState().project.machine)).toEqual(points)
  })

  it('lists legacy wiring parks, keeps native position macros single and isolates machines', () => {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({ ...machine, referencePositions: {} })
    useMachineActions.getState().addPark('wo2841', { id: 'old', label: 'Legacy park', x: 10, y: 15 })
    mount(); edit()
    expect(editorNames()).toEqual(['Legacy park', 'Clamp pause'])
    cleanup()
    useCamStore.getState().setProjectMachine({ ...machine, id: 'other', macros: [
      { id: 'native', name: 'Native park', body: positionMacroBody({ x: 10, y: 15, z: -2, zFirst: true }) },
    ] })
    mount(); edit()
    expect(editorNames()).toEqual(['Native park'])
    expect(panelNames()).toEqual(['Native park'])
  })

  it('sends identical simulator commands and retains park refusals after display edits', async () => {
    vi.useFakeTimers()
    try {
      const pending = session.connectMachine('simulator', 115200)
      await vi.advanceTimersByTimeAsync(300); await pending
      await vi.advanceTimersByTimeAsync(50)
      act(() => { session.__resetEstopInterlockForTest() })
      session.getMachineController().home()
      await vi.advanceTimersByTimeAsync(2000)
      const controller = session.getMachineController()
      const sends = vi.spyOn(controller, 'sendCommand')
      mount()
      await act(async () => {
        fireEvent.click(screen.getByTestId('control-park-g30-p1'))
        await vi.advanceTimersByTimeAsync(3000)
      })
      const before = sends.mock.calls.map(([command]) => command)
      expect(before).toEqual(expect.arrayContaining(['G21 G90 G53 G0 Z-2', 'G21 G90 G53 G0 X20 Y30']))
      controller.home(); await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      edit()
      fireEvent.click(row('G30 P1').getByRole('button', { name: 'Edit G30 P1' }))
      fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Renamed park' } })
      fireEvent.click(screen.getByTestId('macro-editor-save'))
      sends.mockClear()
      await act(async () => {
        fireEvent.click(screen.getByTestId('control-park-g30-p1'))
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(sends.mock.calls.map(([command]) => command)).toEqual(before)
      act(() => { useMachineControl.setState({ homed: false }) })
      expect((screen.getByTestId('control-park-g30-p1') as HTMLButtonElement).disabled).toBe(true)
    } finally {
      const pending = session.disconnectMachine()
      await vi.advanceTimersByTimeAsync(100); await pending
      vi.useRealTimers()
    }
  })
})
