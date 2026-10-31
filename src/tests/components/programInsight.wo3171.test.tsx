// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProgramPanel } from '../../components/machine/ProgramPanel'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { applyLanguage } from '../../i18n'
import { connectMachine, disconnectMachine, getMachineController, loadMachineProgram, loadGcodeTextToolpathProgram, loadedProgramText } from '../../lib/machine/machineSession'
import { sendProgramToControl } from '../../components/gcode/editedProgram'

// The canvas alone is outside this component test; File Open, editor handoff,
// session staging, parser, estimate and the insight component are production code.
vi.mock('../../components/machine/ProgramPreview', async () => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../components/machine/ProgramPreview')>({ ProgramPreview: () => <div data-testid="preview" /> })
})
const text = 'G21 G90 G54 G94\nT1 M6\nM3 S12000\nG0 X0 Y0 Z5\nG1 Z-2 F300\nG1 X10 F600\nM30\n'
const state = useMachineControl.getState
const expand = () => fireEvent.click(screen.getByTestId('control-setup-notes-button'))
const body = () => screen.getByTestId('program-insight-body').textContent!
function open(text: string | Promise<string>, name = 'modal.nc') {
  fireEvent.change(screen.getByTestId('control-file-input'), { target: { files: [{ name, text: () => Promise.resolve(text) }] } })
}

beforeEach(async () => {
  useUiPrefs.setState({ machineDisplayUnits: 'mm' })
  await applyLanguage('en')
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({ ...machine, controller: 'grbl', controllerDefinition: undefined })
  await connectMachine('simulator', 115200)
})
afterEach(async () => { cleanup(); await disconnectMachine(); vi.restoreAllMocks() })

describe('WO-3171 production ProgramPanel routes', () => {
  it('loads File Open, defaults collapsed, displays hand-calculated facts and preserves bytes/calls on toggle', async () => {
    render(<ProgramPanel />)
    open(text)
    await waitFor(() => expect(state().programText).toBe(text))
    expect(screen.queryByTestId('program-insight-body')).toBeNull()
    expect(screen.queryByTestId('program-insight-toggle')).toBeNull()
    const controller = getMachineController()
    const run = vi.spyOn(controller, 'startJob')
    const spindle = vi.spyOn(controller, 'sendCommand')
    expand()
    expect(body()).toContain('300 - 600 mm/min')
    expect(body()).toContain('12000 RPM')
    expect(body()).toContain('T1')
    expect(body()).toContain('Estimated time')
    expect(body()).toContain('X 0.00 - 10.00')
    expect(loadedProgramText()).toBe(text)
    expand(); expand()
    expect(run).not.toHaveBeenCalled()
    expect(spindle).not.toHaveBeenCalled()
  })
  it('combines setup notes and loaded-file facts in one panel without binding either to the other', () => {
    const setup = (id: string, notes: string) => ({
      id, name: `Setup ${id}`,
      wcs: { id: `w-${id}`, label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
      operations: [], notes,
    })
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup('a', 'Clamp on the left jaw'), setup('b', 'Second setup')] as never[], activeSetupId: 'a', activeOperationId: null } }))
    })
    render(<ProgramPanel />)
    expect(screen.queryByTestId('program-insight-toggle')).toBeNull()
    expand()
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('Clamp on the left jaw')
    fireEvent.click(screen.getByTestId('control-setup-notes-edit-button'))
    fireEvent.change(screen.getByTestId('control-setup-notes-edit'), { target: { value: 'Temporary note' } })
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('Clamp on the left jaw')
    fireEvent.click(screen.getByTestId('control-setup-notes-edit-button'))
    fireEvent.change(screen.getByTestId('control-setup-notes-edit'), { target: { value: 'Zero on the top face' } })
    fireEvent.click(screen.getByTestId('control-setup-notes-save'))
    expect(useCamStore.getState().project.setups[0].notes).toBe('Zero on the top face')
    const commands = vi.spyOn(getMachineController(), 'sendCommand')
    act(() => loadMachineProgram('combined.nc', text))
    expect(screen.getByTestId('control-setup-notes-button').textContent).toBe('')
    expect(screen.getByTestId('control-setup-notes-button').getAttribute('aria-label')).toBe('Notes')
    expect(screen.getByTestId('control-setup-notes-button').getAttribute('title')).toBe('Notes')
    expect(body()).toContain('300 - 600 mm/min')
    expect(loadedProgramText()).toBe(text)
    expect(commands).not.toHaveBeenCalled()
    act(() => { useCamStore.getState().setActiveSetup('b') })
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('Second setup')
    expect(body()).toContain('12000 RPM')
  })
  it('keeps the one panel absent with neither a setup nor a loaded program', () => {
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [], activeSetupId: null } }))
      useMachineControl.setState({ programText: null, stagedProgram: null })
    })
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-setup-notes-button')).toBeNull()
    expect(screen.queryByTestId('program-insight-toggle')).toBeNull()
  })
  it('updates edited/reloaded file identities and clears facts on an empty file', async () => {
    render(<ProgramPanel />)
    act(() => loadMachineProgram('initial.nc', text))
    expand()
    act(() => sendProgramToControl({ name: 'edited.nc', base: text, text: text.replace('F600', 'F900') }))
    expect(body()).toContain('300 - 900 mm/min')
    open(text, 'reload.nc')
    await waitFor(() => expect(body()).toContain('300 - 600 mm/min'))
    open('', 'empty.nc')
    await waitFor(() => expect(state().programText).toBe(''))
    expect(body()).toContain('Unknown')
    expect(body()).not.toContain('12000 RPM')
  })
  it('ignores obsolete File Open completion after a newer file has loaded', async () => {
    render(<ProgramPanel />)
    let resolveOld!: (text: string) => void
    const old = new Promise<string>((resolve) => { resolveOld = resolve })
    open(old, 'old.nc')
    const newer = text.replace('F600', 'F800')
    open(newer, 'new.nc')
    await waitFor(() => expect(state().programText).toBe(newer))
    await act(async () => resolveOld(text))
    expect(state().programText).toBe(newer)
    expand()
    expect(body()).toContain('300 - 800 mm/min')
  })
  it('ignores an obsolete read after Send to Control replaces the session identity', async () => {
    render(<ProgramPanel />)
    let resolveOld!: (text: string) => void
    open(new Promise<string>((resolve) => { resolveOld = resolve }), 'old.nc')
    act(() => sendProgramToControl({ name: 'posted.nc', text: text.replace('F600', 'F700') }))
    await act(async () => resolveOld(text))
    expect(state().programText).toContain('F700')
    expand()
    expect(body()).toContain('300 - 700 mm/min')
  })
  it('reads the real staged file route without changing accepted steps or command calls', () => {
    render(<ProgramPanel />)
    let loaded!: { ok: boolean; reason: string | null }
    act(() => { loaded = loadGcodeTextToolpathProgram('staged.nc', text, { publishListing: true }) })
    expect(loaded).toEqual({ ok: true, reason: null })
    expect(state().programText).toBeNull()
    expect(state().stagedProgram).not.toBeNull()
    const bytes = JSON.stringify(state().stagedProgram!.program)
    const commands = vi.spyOn(getMachineController(), 'sendCommand')
    expand()
    expect(body()).toContain('300 - 600 mm/min')
    expect(body()).toContain('12000 RPM')
    expect(body()).toContain('T1')
    expect(JSON.stringify(state().stagedProgram!.program)).toBe(bytes)
    expect(loadedProgramText()).toBe(text)
    expect(commands).not.toHaveBeenCalled()
  })
  it.each(['File Open', 'staged file'])('displays return-from-G53 cutting values through %s without changing bytes or commands', async (route) => {
    const source = 'G21 G90 G54 G94\nT1 M6\nM3 S12000\nG0 X0 Y0 Z5\nG1 Z-2 F300\nG53 G0 Z0\nM3 S18000\nG1 Z-2 F600\nM30'
    // The default GRBL simulator's machine Z maximum is zero. Retract from
    // work Z-2 to machine Z0, then feed back to work Z-2 (the same defect).
    render(<ProgramPanel />)
    const controller = getMachineController()
    const run = vi.spyOn(controller, 'startJob')
    const commands = vi.spyOn(controller, 'sendCommand')
    if (route === 'File Open') {
      open(source, 'g53-return.nc')
      await waitFor(() => expect(state().programText).toBe(source))
    } else {
      let loaded!: { ok: boolean; reason: string | null }
      act(() => { loaded = loadGcodeTextToolpathProgram('g53-return.nc', source, { publishListing: true }) })
      expect(loaded).toEqual({ ok: true, reason: null })
    }
    const stagedBytes = JSON.stringify(state().stagedProgram?.program)
    expand()
    expect(body()).toContain('300 - 600 mm/min')
    expect(body()).toContain('12000 - 18000 RPM')
    expect(loadedProgramText()).toBe(source)
    expect(JSON.stringify(state().stagedProgram?.program)).toBe(stagedBytes)
    expect(run).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()
  })
  it('preserves independently interpretable facts for an unsupported feed mode', () => {
    render(<ProgramPanel />)
    act(() => loadMachineProgram('unknown-feed.nc', text.replace('G94', 'G95')))
    expand()
    expect(body()).toContain('Unknown')
    expect(body()).toContain('12000 RPM')
    expect(body()).toContain('T1')
  })
  it('updates display units without reinterpreting program values', async () => {
    render(<ProgramPanel />)
    act(() => loadMachineProgram('inch.nc', 'G20 G90 G54 G94\nT2 M6\nM3 S8000\nG0 X0\nG1 X1 F20\nM30'))
    expand()
    expect(body()).toContain('508 mm/min')
    act(() => useUiPrefs.setState({ machineDisplayUnits: 'inch' }))
    expect(body()).toContain('20 in/min')
  })
  it.each(['de', 'es', 'fr'])('has translated summary labels in %s', async (language) => {
    render(<ProgramPanel />)
    act(() => loadMachineProgram('modal.nc', text))
    await act(async () => applyLanguage(language))
    expand()
    expect(body()).not.toContain('Estimated time')
    expect(body()).not.toContain('Unknown')
    expect(body()).toContain('12000 RPM')
  })
})
