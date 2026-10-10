// @vitest-environment jsdom
//
// WO-116: every Control-tab rail panel collapses via the SAME chevron
// affordance WORK OFFSETS already had (Operator ruling 2026-08-09: "Infact allow all to
// be collapsed like work offsets"), and each panel's state PERSISTS through
// the existing uiPrefs collapsed-sections record (keys "control-<panel>").
//
// Pinned here:
//   1. All seven rail panels (Machine / Position / Work offsets / Tool left;
//      Jog / Overrides / Spindle / Coolant / Macros right) carry the chevron
//      and start EXPANDED (opt-in collapse; the current look never changes
//      on upgrade).
//   2. Each chevron folds its panel body and writes the pref; a second click
//      restores it.
//   3. PERSISTENCE PROOF for two panels (Machine + Jog, one per rail): the
//      click writes liencam-ui-prefs; a simulated reload (store forgets,
//      real persist rehydrate reads the blob back) returns the mounted page
//      to collapsed.
//   4. The WO's named trap - live state may not be folded out of sight:
//      collapsed Position keeps a live compact DRO, collapsed Overrides keeps
//      F/R/S in the header, collapsed Spindle keeps the rpm readout, and an
//      ACTIVE ALARM renders even with the Machine panel folded.
//   5. Jog SAFETY: folding the Jog panel cancels an in-flight continuous jog
//      (a held button unmounts without pointerup - e.g. a second finger on a
//      touchscreen hitting the chevron).
//
// Harness follows consoleCollapse.test.tsx: Viewport mocked, localStorage
// shimmed BEFORE the store import.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { connectMachine, disconnectMachine, getMachineController, __resetEstopInterlockForTest } =
  await import('../../lib/machine/machineSession')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The per-MACHINE stores key off the bound machine, not a literal 'default'. */
const machineKey = () => useCamStore.getState().project.machine?.id ?? 'default'

async function mountControlTab() {
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

// panel id -> its collapse toggle testid -> a testid that only exists while
// the panel body is expanded. WO-414 batch 3 (R41, Operator 2026-08-21 Approve):
// the Tool panel is folded BY DEFAULT, so its key records EXPANDED
// (defaultCollapsed) - absence = folded, true = open.
const PANELS: Array<{ key: string; toggle: string; body: string; defaultCollapsed?: boolean }> = [
  { key: 'control-machine', toggle: 'control-machine-toggle', body: 'control-kind-select' },
  { key: 'control-position', toggle: 'control-position-toggle', body: 'control-dro-x' },
  { key: 'control-tool-panel-expanded', toggle: 'control-tool-toggle', body: 'control-tool-glance', defaultCollapsed: true },
  { key: 'control-jog', toggle: 'control-jog-toggle', body: 'control-jog-x-plus' },
  { key: 'control-overrides', toggle: 'control-overrides-toggle', body: 'control-ovr-feed' },
  { key: 'control-spindle', toggle: 'control-spindle-toggle', body: 'control-spindle-cw' },
  { key: 'control-macros', toggle: 'control-macros-toggle', body: 'control-macros-empty' },
]

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam', control: { activeMachineId: null } })
  act(() => {
    useUiPrefs.setState({
      collapsedPropsGroups: {},
      machineJogContinuous: false,
      machineDisplayUnits: 'default',
    })
    useMachineControl.setState({
      alarm: null,
      spindleRpm: null,
      feed: null,
      reportedAccessories: { spindle: 'off', flood: false, mist: false },
    })
  })
})

afterEach(() => {
  cleanup()
})

/** Fold every rail panel that is open (a default-folded panel is left folded). */
function foldAllPanels() {
  for (const p of PANELS) {
    const toggle = screen.getByTestId(p.toggle)
    if (/^Collapse/.test(toggle.getAttribute('aria-label') ?? '')) fireEvent.click(toggle)
  }
}

describe('WO-116: every Control-tab rail panel collapses like Work offsets', () => {
  it('all seven panels carry the chevron; six render EXPANDED by default, Tool folded (WO-414 R41)', async () => {
    await mountControlTab()
    for (const p of PANELS) {
      const toggle = screen.getByTestId(p.toggle)
      expect(toggle.className).toContain('panel-action-btn')
      if (p.defaultCollapsed) {
        expect(toggle.getAttribute('aria-label')).toMatch(/^(Show|Expand)/)
        expect(screen.queryByTestId(p.body)).toBeNull()
        continue
      }
      // Expanded = the Up chevron + the "Collapse..." affordance label.
      expect(toggle.getAttribute('aria-label')).toMatch(/^Collapse/)
      expect(screen.getByTestId(p.body)).toBeTruthy()
    }
    // Nothing opted out yet.
    expect(useUiPrefs.getState().collapsedPropsGroups).toEqual({})
  })

  it('each chevron folds its panel body, writes the pref, and expands back', async () => {
    await mountControlTab()
    for (const p of PANELS) {
      if (p.defaultCollapsed) {
        // Folded at rest: the first click OPENS and records expanded=true.
        fireEvent.click(screen.getByTestId(p.toggle))
        expect(useUiPrefs.getState().collapsedPropsGroups[p.key]).toBe(true)
        expect(screen.getByTestId(p.body)).toBeTruthy()
        expect(screen.getByTestId(p.toggle).getAttribute('aria-label')).toMatch(/^Collapse/)

        fireEvent.click(screen.getByTestId(p.toggle))
        expect(useUiPrefs.getState().collapsedPropsGroups[p.key]).toBe(false)
        expect(screen.queryByTestId(p.body)).toBeNull()
        continue
      }
      fireEvent.click(screen.getByTestId(p.toggle))
      expect(useUiPrefs.getState().collapsedPropsGroups[p.key]).toBe(true)
      expect(screen.queryByTestId(p.body)).toBeNull()
      expect(screen.getByTestId(p.toggle).getAttribute('aria-label')).toMatch(/^(Show|Expand)/)

      fireEvent.click(screen.getByTestId(p.toggle))
      expect(useUiPrefs.getState().collapsedPropsGroups[p.key]).toBe(false)
      expect(screen.getByTestId(p.body)).toBeTruthy()
    }
  })

  it('PERSISTS across a reload for Machine + Jog (one per rail)', async () => {
    await mountControlTab()
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    fireEvent.click(screen.getByTestId('control-jog-toggle'))
    expect(screen.queryByTestId('control-kind-select')).toBeNull()
    expect(screen.queryByTestId('control-jog-x-plus')).toBeNull()

    // The clicks wrote the persisted blob under the app's UI-prefs key.
    const raw = mem.get('liencam-ui-prefs')
    expect(raw).toBeTruthy()
    const blob = JSON.parse(raw!)
    expect(blob.state.collapsedPropsGroups['control-machine']).toBe(true)
    expect(blob.state.collapsedPropsGroups['control-jog']).toBe(true)

    // Simulate a reload: the in-memory store forgets (page re-expands)...
    act(() => useUiPrefs.setState({ collapsedPropsGroups: {} }))
    expect(screen.getByTestId('control-kind-select')).toBeTruthy()
    expect(screen.getByTestId('control-jog-x-plus')).toBeTruthy()

    // ...while localStorage keeps the last blob; the REAL rehydrate+merge
    // path (what a page load runs at store creation) restores both panels,
    // and the mounted page folds them again.
    mem.set('liencam-ui-prefs', raw!)
    await act(async () => {
      await useUiPrefs.persist.rehydrate()
    })
    expect(useUiPrefs.getState().collapsedPropsGroups['control-machine']).toBe(true)
    expect(useUiPrefs.getState().collapsedPropsGroups['control-jog']).toBe(true)
    expect(screen.queryByTestId('control-kind-select')).toBeNull()
    expect(screen.queryByTestId('control-jog-x-plus')).toBeNull()
  })

  it('collapsed Position keeps a LIVE compact DRO that tracks the controller', async () => {
    await mountControlTab()
    act(() => {
      useUiPrefs.setState({ machineDisplayUnits: 'mm' })
      useMachineControl.setState({
        homed: true,
        wpos: { x: 12.345, y: -0.5, z: -7 },
        mpos: { x: 12.345, y: -0.5, z: -7 },
      })
    })
    fireEvent.click(screen.getByTestId('control-position-toggle'))
    const compact = screen.getByTestId('control-position-compact')
    expect(compact.textContent).toContain('12.35')
    expect(compact.textContent).toContain('-0.50')
    expect(compact.textContent).toContain('-7.00')
    expect(compact.textContent).toContain('mm')
    // The full DRO rows fold away; the header chips (units, WCS) stay.
    expect(screen.queryByTestId('control-dro-x')).toBeNull()
    expect(screen.getByTestId('control-units-chips')).toBeTruthy()

    // Mid-cycle: the compact readout keeps ticking with new positions.
    act(() => useMachineControl.setState({ wpos: { x: 99, y: -0.5, z: -7 } }))
    expect(screen.getByTestId('control-position-compact').textContent).toContain('99.00')
  })

  it('collapsed Overrides keeps live F/R/S values in the header', async () => {
    await mountControlTab()
    act(() => useMachineControl.setState({ overrides: { feed: 50, rapid: 25, spindle: 200 } }))
    fireEvent.click(screen.getByTestId('control-overrides-toggle'))
    const values = screen.getByTestId('control-ovr-collapsed-values')
    expect(values.textContent).toBe('F50% R25% S200%')
    expect(screen.queryByTestId('control-ovr-feed')).toBeNull()

    act(() => useMachineControl.setState({ overrides: { feed: 100, rapid: 100, spindle: 100 } }))
    expect(screen.getByTestId('control-ovr-collapsed-values').textContent).toBe('F100% R100% S100%')
  })

  it('collapsed Spindle keeps the live rpm readout on the panel', async () => {
    await mountControlTab()
    act(() => useMachineControl.setState({ spindleRpm: 12000 }))
    fireEvent.click(screen.getByTestId('control-spindle-toggle'))
    expect(screen.queryByTestId('control-spindle-cw')).toBeNull()
    // WO-184 moved this readout out of the 26px header onto its own compact
    // row (the title wrapped and crushed it there) - so the claim is asserted
    // on the PANEL, which is what "not folded out of sight" ever meant.
    const panel = screen.getByTestId('control-spindle-toggle').closest('section')!
    expect(panel.textContent).toContain('12000 rpm')
  })

  // RE-PINNED 2026-08-23. WO-116's safety claim is unchanged - AN ALARM MAY
  // NEVER BE HIDDEN BY A FOLD THE OPERATOR MADE FOR A DIFFERENT REASON - but
  // the surface that carries it moved, and the new one is strictly stronger.
  //
  // The old alarm block lived INSIDE the Machine panel and was kept visible by
  // forcing that panel open, so the guarantee only held while the operator was
  // looking at that panel. It also grew the left column whenever it appeared,
  // pushing everything below it down - which is what Operator objected to at the
  // machine ("For notification items you DO NOT NEED TO ALWAYS MAKE A NEW UI
  // ELEMENT"). And its text was stale: it named $H and $X, GRBL commands the
  // UCCNC controller does not have.
  //
  // The fact now rides on the transport bar's machine-state chip, which is
  // outside every foldable panel, plus the console, which persists it.
  it('an ACTIVE ALARM is still visible with the Machine panel folded', async () => {
    await mountControlTab()
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    // Folded, and nothing is alarmed yet.
    expect(screen.queryByTestId('control-kind-select')).toBeNull()
    expect(screen.getByTestId('control-state-chip').textContent).not.toContain('ALARM')

    act(() => useMachineControl.setState({ machineState: 'alarm' }))

    // The fold cannot hide it: this readout is not inside the folded panel.
    expect(screen.getByTestId('control-state-chip').textContent).toContain('ALARM')
    // The setup chrome stays folded - the alarm did not force it open.
    expect(screen.queryByTestId('control-kind-select')).toBeNull()
  })

  it('folding Jog CANCELS an in-flight continuous jog (held button unmounts)', async () => {
    await mountControlTab()
    await act(async () => {
      await connectMachine('simulator', 115200)
    })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this test is about
    // folding Jog cancelling an in-flight continuous jog, not the fresh-
    // connect E-STOP latch - clear it so the jog pad is reachable.
    __resetEstopInterlockForTest()
    try {
      await waitFor(
        () =>
          expect(
            (screen.getByTestId('control-jog-x-plus') as HTMLButtonElement).disabled,
          ).toBe(false),
        { timeout: 10000 },
      )
      act(() => useUiPrefs.setState({ machineJogContinuous: true }))

      const ctrl = getMachineController()
      const jogSpy = vi.spyOn(ctrl, 'jog')
      const cancelSpy = vi.spyOn(ctrl, 'jogCancel')

      // Press-and-hold: one jog now, then the 150ms interval keeps sending.
      fireEvent.pointerDown(screen.getByTestId('control-jog-x-plus'))
      expect(jogSpy).toHaveBeenCalled()
      await sleep(350)
      const callsBeforeCollapse = jogSpy.mock.calls.length
      expect(callsBeforeCollapse).toBeGreaterThanOrEqual(2)

      // A second finger taps the chevron: the held button unmounts with no
      // pointerup, so the FOLD ITSELF must cancel the jog...
      fireEvent.click(screen.getByTestId('control-jog-toggle'))
      expect(cancelSpy).toHaveBeenCalled()
      // ...and the interval must be dead - no further jog commands after.
      await sleep(350)
      expect(jogSpy.mock.calls.length).toBe(callsBeforeCollapse)
    } finally {
      await act(async () => {
        await disconnectMachine()
      })
    }
  })
})

// ---------------------------------------------------------------------------
// WO-133: a collapsed panel may hide CONTROLS, never LIVE MACHINE STATE.
// WO-116's audit fail: its collapsed Spindle header kept RPM only (direction
// and coolant lived in the folded body) and the compact Position row dropped
// the live feed. These tests pin the COLLAPSED readings, asserted on rendered
// text driven by store updates - never on the store itself.
// ---------------------------------------------------------------------------

describe('WO-133: collapsed panels never hide live machine state', () => {
  it('collapsed SPINDLE/COOLANT keeps RPM + DIRECTION + COOLANT ticking from the store', async () => {
    await mountControlTab()
    // The machine reports live values mid-cut: spindle CW at 12000, flood on.
    act(() =>
      useMachineControl.setState({
        spindleRpm: 12000,
        reportedAccessories: { spindle: 'cw', flood: true, mist: false },
      }),
    )
    fireEvent.click(screen.getByTestId('control-spindle-toggle'))
    // The CONTROLS fold away...
    expect(screen.queryByTestId('control-spindle-cw')).toBeNull()
    // ...but every READING stays on screen: rpm AND direction AND coolant.
    const summary = screen.getByTestId('control-spindle-collapsed-state')
    expect(summary.textContent).toBe('12000 rpm CW | Flood')

    // Still ticking as the store updates: rpm change alone, then an accessory
    // change alone - each re-renders the collapsed summary.
    act(() => useMachineControl.setState({ spindleRpm: 8500 }))
    expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toBe('8500 rpm CW | Flood')
    act(() =>
      useMachineControl.setState({
        reportedAccessories: { spindle: 'ccw', flood: false, mist: true },
      }),
    )
    expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toBe('8500 rpm CCW | Mist')

    // Off states are READINGS worth seeing, not defaults worth assuming:
    // a stopped spindle and coolant off still render, and an unreported rpm
    // is '---' rather than a silent blank.
    act(() =>
      useMachineControl.setState({
        spindleRpm: null,
        reportedAccessories: { spindle: 'off', flood: false, mist: false },
      }),
    )
    expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toBe('--- rpm Off | Off')
  })

  it('collapsed POSITION keeps X/Y/Z + units + the live FEED ticking from the store', async () => {
    await mountControlTab()
    act(() => {
      useUiPrefs.setState({ machineDisplayUnits: 'mm' })
      useMachineControl.setState({
        homed: true,
        wpos: { x: 12.345, y: -0.5, z: -7 },
        mpos: { x: 12.345, y: -0.5, z: -7 },
        feed: 1200,
      })
    })
    fireEvent.click(screen.getByTestId('control-position-toggle'))
    const compact = screen.getByTestId('control-position-compact')
    expect(compact.textContent).toContain('12.35')
    expect(compact.textContent).toContain('-0.50')
    expect(compact.textContent).toContain('-7.00')
    expect(compact.textContent).toContain('mm')
    // The feed WO-116 folded away is now ON the compact row.
    expect(screen.getByTestId('control-position-compact-feed').textContent).toBe('F 1200 mm/min')

    // Mid-cut: feed and position keep ticking with store updates.
    act(() => useMachineControl.setState({ feed: 2450.4, wpos: { x: 40, y: -0.5, z: -7 } }))
    expect(screen.getByTestId('control-position-compact-feed').textContent).toBe('F 2450 mm/min')
    expect(screen.getByTestId('control-position-compact').textContent).toContain('40.00')

    // Feed unknown (nothing reported yet) is '---', never a vanished reading.
    act(() => useMachineControl.setState({ feed: null }))
    expect(screen.getByTestId('control-position-compact-feed').textContent).toBe('F --- mm/min')
  })

  it('the collapsed readings follow REPORTED accessory state, not the local button latch', async () => {
    // The expanded panel latches CW locally when the button is pressed; the
    // collapsed summary must show what the MACHINE reports (A: field), so a
    // state change that arrives from the controller - an M5 in the streamed
    // program, an E-stop reset - is what the operator sees.
    await mountControlTab()
    await act(async () => {
      await connectMachine('simulator', 115200)
    })
    try {
      // Drive a real accessory change through the controller: M3 S12000 + M8
      // via MDI, then wait for the simulator's A:-bearing status reports.
      act(() => {
        useMachineControl.setState({ machineState: 'idle' })
      })
      const ctrl = getMachineController()
      act(() => {
        ctrl.sendCommand('M3 S12000')
        ctrl.sendCommand('M8')
      })
      await waitFor(
        () =>
          expect(useMachineControl.getState().reportedAccessories).toEqual({
            spindle: 'cw',
            flood: true,
            mist: false,
          }),
        { timeout: 10000 },
      )
      fireEvent.click(screen.getByTestId('control-spindle-toggle'))
      await waitFor(() =>
        expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toContain('CW | Flood'),
      )
      // The rpm rides the same live report path (FS field).
      await waitFor(() =>
        expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toMatch(/12000 rpm/),
      )
    } finally {
      await act(async () => {
        await disconnectMachine()
      })
    }
  })
})

// ---------------------------------------------------------------------------
// WO-184: EVERY collapsed rail panel keeps a live readout.
//
// Operator, 2026-08-09T18:48Z, on two annotated shots: "The collapsed froms of some
// still provide the minimum viable usable info, some like spindle do not follow
// this pattern. Look into minimum viable info still being diplay (if not
// controlled) while in the collapsed state. Some are much better than others
// currently."
//
// Machine, Tool, Macros and Jog showed NOTHING folded; Tool kept its "Change
// tool" BUTTON while losing the tool - the rule backwards. Pinned here:
//
//   1. Every collapsing rail panel renders SOME readout when folded (the
//      census, so a future panel cannot quietly ship blank).
//   2. Each new readout is LIVE, not a snapshot: the store changes UNDER THE
//      FOLD and the rendered text follows. A frozen readout lies mid-cycle.
//   3. Folding removes CONTROLS: Change tool, both gears and the jog pad all
//      go, and the panel's own readout stays.
// ---------------------------------------------------------------------------

describe('WO-184: every collapsed rail panel keeps a live readout', () => {
  it('CENSUS: no collapsing rail panel folds down to nothing but its title', async () => {
    await mountControlTab()
    foldAllPanels()

    for (const p of PANELS) {
      const section = screen.getByTestId(p.toggle).closest('section')!
      const title = section.querySelector('.panel-title')!.textContent ?? ''
      const readout = (section.textContent ?? '').replace(title, '').trim()
      expect(`${p.key} readout: "${readout}"`).not.toBe(`${p.key} readout: ""`)
    }
  })

  it('collapsed MACHINE keeps controller + baud + a LIVE connection state', async () => {
    await mountControlTab()
    const readout = () => screen.getByTestId('control-machine-collapsed-values').textContent

    // The picked controller rides the readout. Select a GRBL machine first:
    // WO-1065 deliberately removes serial from a UCCNC machine's options.
    const grblMachine = useCamStore.getState().machineLibrary.find((machine) => machine.controller === 'grbl')!
    fireEvent.change(screen.getByTestId('control-machine-select'), { target: { value: grblMachine.id } })
    await waitFor(() => expect((screen.getByTestId('control-kind-select') as HTMLSelectElement).value).toBe('simulator'))
    fireEvent.change(screen.getByTestId('control-kind-select'), { target: { value: 'serial' } })
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    // Disconnected: the thing the whole tab depends on, said plainly.
    expect(readout()).toBe('GRBL 115200 - Not connected')
    // The connect row itself is a CONTROL and is folded away.
    expect(screen.queryByTestId('control-kind-select')).toBeNull()

    // The Simulator has no baud to report, and says so rather than inventing one.
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    fireEvent.change(screen.getByTestId('control-kind-select'), { target: { value: 'simulator' } })
    fireEvent.click(screen.getByTestId('control-machine-toggle'))
    expect(readout()).toBe(`Simulated ${grblMachine.name} - Not connected`)

    // LIVE under the fold: a real connect flips the reading, and disconnecting
    // flips it back - a stale "Connected" would be the exact lie this forbids.
    await act(async () => {
      await connectMachine('simulator', 115200)
    })
    try {
      await waitFor(() => expect(readout()).toContain('Connected'))
      expect(readout()).not.toContain('Not connected')
    } finally {
      await act(async () => {
        await disconnectMachine()
      })
    }
    await waitFor(() => expect(readout()).toContain('Not connected'))
  })

  it('collapsed TOOL keeps the tool identity and drops the Change tool BUTTON', async () => {
    await mountControlTab()
    act(() => {
      useUiPrefs.setState({ machineDisplayUnits: 'mm' })
      useMachineControl.setState({ activeTool: 3, tlo: null })
      useMachineToolTable.setState({
        byMachine: {
          [machineKey()]: {
            table: {
              reference: null,
              tools: [{ tool: 3, probedMachineZ: null, dia: 6, note: 'flat', measuredAt: null }],
            },
            probe: useMachineToolTable.getState().probeConfigFor(machineKey()),
          },
        },
      })
    })
    // WO-414 batch 3 (R41): the Tool panel is already folded at rest.
    const readout = () => screen.getByTestId('control-tool-collapsed-values').textContent
    expect(readout()).toBe('T3 6mm flat')
    // A CONTROL may not outlive the information it belongs to.
    expect(screen.queryByTestId('control-tool-glance-change')).toBeNull()
    expect(screen.queryByTestId('control-tool-glance')).toBeNull()

    // LIVE under the fold: a tool change and an applied length offset both
    // move the reading.
    act(() => useMachineControl.setState({ activeTool: 7, tlo: 12.5 }))
    expect(readout()).toBe('T7 TLO 12.50')
    // No tool at all is still a reading, not a blank.
    act(() => useMachineControl.setState({ activeTool: null, tlo: null }))
    expect(readout()).toBe('--')
  })

  it('a chatty tool note cannot wrap the collapsed TOOL header', async () => {
    await mountControlTab()
    act(() => {
      useMachineControl.setState({ activeTool: 12, tlo: null })
      useMachineToolTable.setState({
        byMachine: {
          [machineKey()]: {
            table: {
              reference: null,
              tools: [
                {
                  tool: 12,
                  probedMachineZ: null,
                  dia: null,
                  note: '1/4 downcut for the plywood job',
                  measuredAt: null,
                },
              ],
            },
            probe: useMachineToolTable.getState().probeConfigFor(machineKey()),
          },
        },
      })
    })
    // WO-414 batch 3 (R41): folded at rest - no click needed.
    const text = screen.getByTestId('control-tool-collapsed-values').textContent!
    expect(text.startsWith('T12 ')).toBe(true)
    expect(text.endsWith('...')).toBe(true)
    // The identity survives the cap; the free text is what gets clipped.
    expect(text.length).toBeLessThanOrEqual('T12 '.length + 16)
  })

  it('collapsed JOG keeps the step/continuous mode and the LIVE jog feed', async () => {
    await mountControlTab()
    act(() =>
      useUiPrefs.setState({
        machineDisplayUnits: 'mm',
        machineJogContinuous: false,
        machineJogStepMm: 1,
        machineJogFeedMmMin: 1000,
      }),
    )
    fireEvent.click(screen.getByTestId('control-jog-toggle'))
    const readout = () => screen.getByTestId('control-jog-collapsed-values').textContent
    expect(readout()).toBe('1.00 mm - 1000 mm/min')
    // The D-pad is a CONTROL and folds away - Operator's "Jog collapsed is total".
    expect(screen.queryByTestId('control-jog-x-plus')).toBeNull()

    // LIVE under the fold: mode and feed both track the prefs store.
    act(() => useUiPrefs.setState({ machineJogContinuous: true, machineJogFeedMmMin: 2500 }))
    expect(readout()).toBe('cont - 2500 mm/min')
    // And it follows the display units, like every other reading on the tab.
    act(() => useUiPrefs.setState({ machineDisplayUnits: 'inch' }))
    expect(readout()).toBe('cont - 98 in/min')
  })

  it('collapsed MACROS keeps a LIVE count of what is wired up, minus the gear', async () => {
    await mountControlTab()
    act(() => useMachineActions.setState({ byMachine: {} }))
    fireEvent.click(screen.getByTestId('control-macros-toggle'))
    const readout = () => screen.getByTestId('control-macros-collapsed-values').textContent
    // An empty rig reads as empty, not as a panel that happens to be shut.
    expect(readout()).toBe('None configured')
    // The gear is a CONTROL: it folds with the buttons it configures.
    expect(screen.queryByTestId('control-actions-gear')).toBeNull()
    expect(screen.queryByTestId('control-macros-empty')).toBeNull()

    // LIVE under the fold: configuring parks and macros moves the count.
    act(() =>
      useMachineActions.setState({
        byMachine: {
          [machineKey()]: {
            overrides: {},
            custom: [{ id: 'vac', label: 'Vac', color: 'cyan', lines: ['M8'] }],
            parks: [{ id: 'p1', label: 'Park 1', x: -10, y: -10 }],
          },
        },
      }),
    )
    expect(readout()).toBe('1 park - 1 macro')
    act(() =>
      useMachineActions.setState({
        byMachine: {
          [machineKey()]: {
            overrides: {},
            custom: [
              { id: 'vac', label: 'Vac', color: 'cyan', lines: ['M8'] },
              { id: 'led', label: 'Lights', color: 'cyan', lines: ['M64'] },
            ],
            parks: [
              { id: 'p1', label: 'Park 1', x: -10, y: -10 },
              { id: 'p2', label: 'Park 2', x: -20, y: -20 },
            ],
          },
        },
      }),
    )
    expect(readout()).toBe('2 parks - 2 macros')
  })

  it('collapsed SPINDLE/COOLANT keeps its live readings and drops the gear', async () => {
    await mountControlTab()
    act(() =>
      useMachineControl.setState({
        spindleRpm: 12000,
        reportedAccessories: { spindle: 'cw', flood: true, mist: false },
      }),
    )
    fireEvent.click(screen.getByTestId('control-spindle-toggle'))
    // WO-133's readings are unchanged - they just no longer share the 26px
    // header with the longest title on the page.
    expect(screen.getByTestId('control-spindle-collapsed-state').textContent).toBe(
      '12000 rpm CW | Flood',
    )
    expect(
      screen.getByTestId('control-spindle-collapsed-state').closest('.panel-header'),
    ).toBeNull()
    // Both CONTROLS fold: the action buttons and the machine-actions gear.
    expect(screen.queryByTestId('control-spindle-cw')).toBeNull()
    expect(screen.queryByTestId('control-spindle-gear')).toBeNull()

    // Expanding restores the gear - it is folded, not deleted.
    fireEvent.click(screen.getByTestId('control-spindle-toggle'))
    expect(screen.getByTestId('control-spindle-gear')).toBeTruthy()
  })

  it('no collapsed rail panel leaves an interactive control behind', async () => {
    await mountControlTab()
    foldAllPanels()

    for (const p of PANELS) {
      const section = screen.getByTestId(p.toggle).closest('section')!
      const interactive = Array.from(section.querySelectorAll('button, input, select'))
        // The collapse chevron IS the affordance that gets you back; the
        // Position header's unit/WCS chips are Operator's own reference-quality
        // collapsed state (this WO forbids regrading it) and they choose how
        // the readout beside them is READ.
        .filter((el) => el !== screen.getByTestId(p.toggle))
        .filter((el) => !el.closest('.control-dro-header-meta'))
      expect(`${p.key} left behind: ${interactive.map((el) => el.textContent).join(',')}`).toBe(
        `${p.key} left behind: `,
      )
    }
  })
})
