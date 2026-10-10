// @vitest-environment jsdom
//
// WO-414 batch 3 - Operator's verdicts (2026-08-21) on the Control walkthrough:
//   R6  the program bar's Setup dropdown + Load setup + Open file... + Recent
//       are ONE "Load" menu; the bar is one row at rest
//   R13 a load error / run-from refusal is ALSO a console line; on screen one
//       short red line until the next load
//   R14 the "armed from the beginning" advice is a console line, no box
//   R9  "N skipped" leaves the bar: the program name's hover + the Info card
//   R38 retired by WO-1016 under ADR-0040: goto refusals are console-only
//   R32 the standing "Soft limits are OFF ($20=0)" text is gone from the
//       Machine panel entirely - one console line at connect / when $20 flips
//   R36 the "Ov F100% R100% S100%" row is gone; a non-100% override is one
//       amber value on the Feed/Spindle row
//   R41 the Tool panel folds by default (controlPanelCollapse.test.tsx)
//   R24 Step Back -> console only (stepBack.test.tsx)
//   R30 connect error -> console + one short line (the simulator cannot fail
//       to connect; the disconnected detail path is covered below)

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

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

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { makeStock, makeWcs } = await import('../post/helpers')
import type { Setup } from '../../types'

/** Two empty setups - enough for the Load menu to list them. */
function seedSetups() {
  const mk = (id: string, name: string, label: string): Setup => ({
    id,
    name,
    wcs: makeWcs({ label }),
    stock: makeStock({}),
    operations: [],
    notes: '',
  })
  useCamStore.setState((s) => ({
    project: { ...s.project, setups: [mk('s1', 'Top face', 'G54'), mk('s2', 'Bottom', 'G55')] },
  }))
}

const consoleLines = () => useMachineControl.getState().consoleLines

describe('WO-414 batch 3 / R6: one Load menu on a one-row program bar', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    seedSetups()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', consoleLines: [] })
  })
  afterEach(() => cleanup())

  it('the bar carries ONE Load button - no setup dropdown, no Recent select, no Open file button', () => {
    render(<ProgramPanel />)
    expect(screen.getByTestId('control-load-menu')).toBeTruthy()
    expect(screen.queryByTestId('control-setup-select')).toBeNull()
    expect(screen.queryByTestId('control-recent-select')).toBeNull()
    expect(screen.queryByTestId('control-load-setup')).toBeNull()
    expect(screen.queryByTestId('control-load-menu-panel')).toBeNull()
    expect(screen.queryByText('Open file...')).toBeNull()
    // The file input is still there (the menu's Open file... clicks it).
    expect(screen.getByTestId('control-file-input')).toBeTruthy()
  })

  it('Load opens a menu with every setup, Open file... and Recent; Escape closes it; Open file... clicks the file input', () => {
    render(<ProgramPanel />)
    const setups = useCamStore.getState().project.setups
    expect(setups.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByTestId('control-load-menu'))
    const panel = screen.getByTestId('control-load-menu-panel')
    expect(screen.getByTestId('control-load-menu').getAttribute('aria-expanded')).toBe('true')
    for (const s of setups) {
      expect(screen.getByTestId(`control-load-setup-item-${s.id}`).textContent).toBe(s.name)
    }
    expect(panel.textContent).toContain('Load setup')
    expect(panel.textContent).toContain('Open file...')
    expect(panel.textContent).toMatch(/Recent \(\d+\)/)
    // WO-414 batch 3b: a floating popover anchored under the Load button, not
    // an in-flow row of the bar - it lives in its own anchor wrapper.
    expect(panel.closest('.control-load-menu-anchor')).toBeTruthy()
    expect(panel.className).toContain('control-load-menu')

    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByTestId('control-open-file'))
    expect(click).toHaveBeenCalledTimes(1)
    // A choice closes the menu.
    expect(screen.queryByTestId('control-load-menu-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('control-load-menu'))
    expect(screen.getByTestId('control-load-menu-panel')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('control-load-menu-panel')).toBeNull()
  })

  it('a press outside the menu closes it; a press inside does not', () => {
    render(<ProgramPanel />)
    fireEvent.click(screen.getByTestId('control-load-menu'))
    fireEvent.mouseDown(screen.getByTestId('control-load-menu-panel'))
    expect(screen.getByTestId('control-load-menu-panel')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('control-load-menu-panel')).toBeNull()
  })
})

describe('WO-414 batch 3 / R13 + R14 + R9: the program bar talks through the console', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', consoleLines: [] })
  })
  afterEach(() => cleanup())

  async function loadFile(name: string, text: string) {
    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([text], name)] } })
    await waitFor(() => expect(screen.getByTestId('control-program-name').textContent).toBe(name))
  }

  it('R13: a run-from refusal is one short red line AND a console error line; the next load clears the line', async () => {
    render(<ProgramPanel />)
    await loadFile('a.nc', 'G21\nG90\nG1 X1 F100\nG1 X2\nM30')
    fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: '99999' } })
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')) })
    await waitFor(() => expect(screen.getByTestId('control-load-error')).toBeTruthy())
    const line = screen.getByTestId('control-load-error')
    expect(line.className).toContain('control-load-error-line')
    expect(line.getAttribute('title')).toBe(line.textContent)
    const errors = consoleLines().filter((l) => l.severity === 'error' && /Run from line 99999 refused/.test(l.text))
    expect(errors).toHaveLength(1)
    expect(errors[0].text).toContain(line.textContent!)
    expect(screen.queryByTestId('control-runfrom-notice')).toBeNull()

    await loadFile('b.nc', 'G21\nG90\nG1 X1 F100\nM30')
    expect(screen.queryByTestId('control-load-error')).toBeNull()
    // The console still has it.
    expect(consoleLines().filter((l) => /Run from line 99999 refused/.test(l.text))).toHaveLength(1)
  })

  it('R14: "line 1 is the start" is a console info line, not a box under the bar', async () => {
    render(<ProgramPanel />)
    await loadFile('a.nc', 'G21\nG90\nG1 X1 F100\nG1 X2\nM30')
    fireEvent.change(screen.getByTestId('control-runfrom-input'), { target: { value: '1' } })
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-plan')) })
    await waitFor(() =>
      expect(consoleLines().some((l) => l.severity === 'info' && /Line 1 is the start of the program/.test(l.text))).toBe(true),
    )
    expect(screen.queryByTestId('control-runfrom-notice')).toBeNull()
    expect(screen.queryByTestId('control-load-error')).toBeNull()
  })

  it('R9/batch 3b: the skipped count and line count are the program name hover only - there is no Info card', async () => {
    render(<ProgramPanel />)
    await loadFile('skips.nc', '%\nG21\n(comment)\n\nG90\nG1 X1 F100\nM2')
    expect(screen.queryByTestId('control-program-skipped')).toBeNull()
    const name = screen.getByTestId('control-program-name')
    expect(name.getAttribute('data-skipped')).toBe('3')
    expect(name.getAttribute('data-tooltip')).toMatch(/4 lines; 3 will not be sent/)
    // Operator ruling 2026-08-21: "I don't think [Info] is currently useful" - deleted.
    expect(screen.queryByTestId('control-jobinfo-toggle')).toBeNull()
    expect(screen.queryByTestId('control-jobinfo-card')).toBeNull()
  })
})

describe('WO-414 batch 3 / R32 + R36 + R30: the rail panels talk through the console', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineGotoSkipConfirm: false, collapsedPropsGroups: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      connectionDetail: null,
      machineState: 'idle',
      alarm: null,
      homed: true,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
      settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      consoleLines: [],
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('R32: no soft-limit text on screen at all; one console line when $20 arrives and again when it flips', () => {
    render(<ControlPage />)
    expect(screen.queryByTestId('control-softlimit-hint')).toBeNull()
    expect(consoleLines().filter((l) => /Soft limits/.test(l.text))).toHaveLength(0)

    act(() => { useMachineControl.setState({ settings: { 20: '0', 130: '740.000' } }) })
    expect(screen.queryByTestId('control-softlimit-hint')).toBeNull()
    // The Machine panel says nothing - no line, no tooltip (Operator: "don't put
    // any text there at all"); the only place the words exist is the console.
    const machinePanel = screen.getByTestId('control-kind-select').closest('section')!
    expect(machinePanel.textContent).not.toMatch(/Soft limits/)
    expect(machinePanel.innerHTML).not.toMatch(/Soft limits|\$20/)
    let lines = consoleLines().filter((l) => /Soft limits/.test(l.text))
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toMatch(/OFF in GRBL settings \(\$20=0\)/)

    // Same value again (another settings dump): nothing new.
    act(() => { useMachineControl.setState({ settings: { 20: '0', 130: '740.000', 131: '1' } }) })
    expect(consoleLines().filter((l) => /Soft limits/.test(l.text))).toHaveLength(1)

    act(() => { useMachineControl.setState({ settings: { 20: '1', 130: '740.000' } }) })
    lines = consoleLines().filter((l) => /Soft limits/.test(l.text))
    expect(lines).toHaveLength(2)
    expect(lines[1].text).toMatch(/ON in GRBL settings \(\$20=1\)/)
  })

  it('R36: no Ov row at 100/100/100; a non-100% override is one amber value on the Feed/Spindle row', () => {
    render(<ControlPage />)
    expect(document.body.textContent).not.toMatch(/Ov F100%/)
    expect(screen.queryByTestId('control-override-flag')).toBeNull()
    act(() => { useMachineControl.setState({ overrides: { feed: 10, rapid: 100, spindle: 100 } }) })
    const flag = screen.getByTestId('control-override-flag')
    expect(flag.textContent).toBe('F10%')
    expect(flag.className).toContain('control-override-flag')
    act(() => { useMachineControl.setState({ overrides: { feed: 10, rapid: 50, spindle: 100 } }) })
    expect(screen.getByTestId('control-override-flag').textContent).toBe('F10% R50%')
    act(() => { useMachineControl.setState({ overrides: { feed: 100, rapid: 100, spindle: 100 } }) })
    expect(screen.queryByTestId('control-override-flag')).toBeNull()
  })

  it('R30: a disconnected detail is one short line in the Machine panel and one console line', () => {
    render(<ControlPage />)
    act(() => {
      useMachineControl.getState().setConnection('disconnected', 'The controller stopped answering.')
    })
    const line = document.querySelector('.control-connect-detail-line')!
    expect(line).toBeTruthy()
    expect(line.textContent).toBe('The controller stopped answering.')
    expect(line.getAttribute('title')).toBe('The controller stopped answering.')
    const lines = consoleLines().filter((l) => l.text === 'The controller stopped answering.')
    expect(lines).toHaveLength(1)
    // A re-render with the same detail never writes it twice.
    act(() => { useMachineControl.setState({ feed: 5 }) })
    expect(consoleLines().filter((l) => l.text === 'The controller stopped answering.')).toHaveLength(1)
  })
})
