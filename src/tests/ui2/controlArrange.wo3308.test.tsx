// @vitest-environment jsdom
//
// WO-3308 (UI M2 W2-5b): Control Arrange mode and saved layouts. Modules move, hide or turn off
// only in Arrange; the locked stops never; the operator saves, picks, renames and deletes named
// layouts; the active layout survives a restart; Arrange will not open while the machine moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import {
  CONTROL_MODULE_IDS, DEFAULT_RUN_LAYOUT, columnModules, moveModule, nudgeModule, repairLayout, setFolded, setShown,
} from '../../ui2/control-arrange/layout'
import { ArrangeColumn } from '../../ui2/control-arrange/ArrangeColumn'
import { ArrangeWindow } from '../../ui2/control-arrange/ArrangeWindow'
import { useControlLayout } from '../../ui2/control-arrange/useControlLayout'
import { useMachineControl } from '../../store/machineControlStore'
import {
  CONTROL_LAYOUTS_KEY, parseStored, useControlLayouts, type MachineLayouts,
} from '../../store/slices/controlLayouts'
import en from '../../i18n/locales/en/ui2-control-arrange.wo3308'
import de from '../../i18n/locales/de/ui2-control-arrange.wo3308'
import es from '../../i18n/locales/es/ui2-control-arrange.wo3308'
import fr from '../../i18n/locales/fr/ui2-control-arrange.wo3308'

const MACHINE = 'router-1'

function Harness() {
  const api = useControlLayout(MACHINE)
  return (
    <div>
      <button data-testid="enter" onClick={() => api.enter()} />
      <button data-testid="try-move" onClick={() => { api.move('jog', 'left', 0); api.show('tool', false); api.fold('machine', true) }} />
      {(['left', 'centre', 'right'] as const).map(c => (
        <ArrangeColumn key={c} column={c} api={api} render={p => (
          <div data-testid={`mod-${p.id}`}>
            {p.id}
            {p.id === 'program' && ['estop', 'hold', 'stop'].map(k => <button key={k} data-testid={`stand-${k}`}>{k}</button>)}
          </div>
        )} />
      ))}
      {api.arranging && <ArrangeWindow api={api} machine={MACHINE} />}
    </div>
  )
}

const ids = (col: string) => [...screen.getByTestId(`control-column-${col}`).querySelectorAll('[data-module]')].map(e => e.getAttribute('data-module'))
const record = (): MachineLayouts => useControlLayouts.getState().machines[MACHINE]

beforeEach(() => {
  localStorage.clear()
  useControlLayouts.setState({ machines: {}, arranging: false })
})
afterEach(cleanup)

describe('WO-3308 layout description', () => {
  it('the Run layout is today\'s three columns with Jog at the top of the right column', () => {
    expect(columnModules(DEFAULT_RUN_LAYOUT, 'left').map(p => p.id)).toEqual(['machine', 'position', 'offsets', 'tool'])
    expect(columnModules(DEFAULT_RUN_LAYOUT, 'centre').map(p => p.id)).toEqual(['program', 'console'])
    expect(columnModules(DEFAULT_RUN_LAYOUT, 'right').map(p => p.id)).toEqual(['jog', 'overrides', 'spindle', 'macros'])
    expect(columnModules(DEFAULT_RUN_LAYOUT, 'right', true).map(p => p.id).slice(-2)).toEqual(['cycleLog', 'simulatedPart'])
  })

  it('the locked Program module cannot be moved, hidden or folded', () => {
    let l = moveModule(DEFAULT_RUN_LAYOUT, 'program', 'left', 0)
    l = setShown(l, 'program', false)
    l = setFolded(l, 'program', true)
    expect(l).toEqual(DEFAULT_RUN_LAYOUT)
  })

  it('moves a module to a column and place, and hides and folds an ordinary one', () => {
    const moved = moveModule(DEFAULT_RUN_LAYOUT, 'macros', 'left', 1)
    expect(columnModules(moved, 'left').map(p => p.id)).toEqual(['machine', 'macros', 'position', 'offsets', 'tool'])
    expect(columnModules(moved, 'right').map(p => p.id)).toEqual(['jog', 'overrides', 'spindle'])
    const off = setFolded(setShown(moved, 'tool', false), 'machine', true)
    expect(columnModules(off, 'left').map(p => p.id)).not.toContain('tool')
    expect(columnModules(off, 'left')[0].folded).toBe(true)
  })

  it('a damaged layout falls back: unknown modules go, missing ones return, locked ones are restored', () => {
    const l = repairLayout({ id: 'x', name: ' Mine ', placements: [
      { id: 'jog', column: 'left', shown: true }, { id: 'jog', column: 'right' }, { id: 'bogus', column: 'left' },
      { id: 'program', column: 'left', shown: false, folded: true }, { id: 'tool', column: 'nowhere' },
    ] })
    expect(l.name).toBe('Mine')
    expect(l.placements.map(p => p.id).sort()).toEqual([...CONTROL_MODULE_IDS].sort())
    expect(l.placements.find(p => p.id === 'jog')?.column).toBe('left')
    expect(l.placements.find(p => p.id === 'program')).toEqual(DEFAULT_RUN_LAYOUT.placements.find(p => p.id === 'program'))
    expect(l.placements.find(p => p.id === 'tool')?.column).toBe('left')
    expect(repairLayout(null).placements).toEqual(DEFAULT_RUN_LAYOUT.placements)
  })
})

describe('WO-3308 Arrange mode', () => {
  it('outside Arrange nothing moves and no grip is offered', () => {
    render(<Harness />)
    expect(ids('right')).toEqual(['jog', 'overrides', 'spindle', 'macros'])
    expect(screen.queryByTestId('arrange-grip-jog')).toBeNull()
    fireEvent.click(screen.getByTestId('try-move'))
    expect(ids('right')).toEqual(['jog', 'overrides', 'spindle', 'macros'])
    expect(ids('left')).toEqual(['machine', 'position', 'offsets', 'tool'])
    expect(record()).toBeUndefined()
  })

  it('Arrange shows grips on movable modules only, and the window lists the locked parts', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    expect(screen.getByTestId('arrange-grip-jog')).toBeTruthy()
    expect(screen.queryByTestId('arrange-grip-program')).toBeNull()
    expect(screen.getByTestId('arrange-locked-stateChip')).toBeTruthy()
    expect(screen.getByTestId('arrange-locked-runSection')).toBeTruthy()
    expect(screen.getByTestId('arrange-row-program').getAttribute('data-locked')).not.toBeNull()
  })

  it('the Arrange window moves a module between columns and turns it off and on', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    fireEvent.click(within(screen.getByTestId('arrange-col-macros')).getByRole('radio', { name: 'Left' }))
    expect(ids('left').at(-1)).toBe('macros')
    expect(ids('right')).not.toContain('macros')
    fireEvent.click(within(screen.getByTestId('arrange-show-tool')).getByRole('checkbox'))
    expect(ids('left')).not.toContain('tool')
    fireEvent.click(within(screen.getByTestId('arrange-show-tool')).getByRole('checkbox'))
    expect(ids('left')).toContain('tool')
    fireEvent.click(screen.getByTestId('arrange-up-macros'))
    expect(ids('left').slice(-2)).toEqual(['macros', 'tool'])
  })

  it('dragging a grip from one column to another moves the module', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    fireEvent.dragStart(screen.getByTestId('arrange-grip-jog'))
    const left = screen.getByTestId('control-column-left')
    fireEvent.dragOver(left)
    expect(screen.getByTestId('arrange-drop-line')).toBeTruthy()
    fireEvent.drop(left)
    expect(ids('left').at(-1)).toBe('jog')
    expect(ids('right')).not.toContain('jog')
    expect(screen.queryByTestId('arrange-drop-line')).toBeNull()
  })

  it('the locked rows offer no move or hide', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    for (const control of ['col', 'up', 'down', 'show']) expect(screen.queryByTestId(`arrange-${control}-program`)).toBeNull()
    expect(ids('centre')).toEqual(['program', 'console'])
  })

  it('Arrange opens and works while the machine is moving, and the locked stops stay where they are', () => {
    useMachineControl.setState({ machineState: 'run' })
    try {
      render(<Harness />)
      fireEvent.click(screen.getByTestId('enter'))
      expect(useControlLayouts.getState().arranging).toBe(true)
      expect(screen.getByTestId('arrange-window')).toBeTruthy()
      // turn off and move every ordinary module: the Program module, which carries the stops, is untouched
      for (const id of CONTROL_MODULE_IDS.filter(m => m !== 'program' && m !== 'cycleLog' && m !== 'simulatedPart')) {
        fireEvent.click(within(screen.getByTestId(`arrange-col-${id}`)).getByRole('radio', { name: 'Left' }))
        fireEvent.click(within(screen.getByTestId(`arrange-show-${id}`)).getByRole('checkbox'))
      }
      expect(ids('left')).toEqual([])
      expect(ids('right')).toEqual([])
      expect(ids('centre')).toEqual(['program'])
      for (const stop of ['stand-estop', 'stand-hold', 'stand-stop']) {
        const el = screen.getByTestId(stop)
        expect(el.hasAttribute('disabled')).toBe(false)
        expect(el.closest('[data-module="program"]')).not.toBeNull()
      }
      expect(record().current.placements.find(p => p.id === 'program')).toMatchObject({ column: 'centre', shown: true, folded: false })
    } finally {
      useMachineControl.setState({ machineState: 'unknown' })
    }
  })
})

describe('WO-3308 the locked Program module keeps its place when another module moves', () => {
  const centre = (l: Parameters<typeof columnModules>[0]) => columnModules(l, 'centre', true).map(p => p.id)

  it('Console moved up, or Macros dropped before Program, leaves Program first in its column', () => {
    expect(centre(nudgeModule(DEFAULT_RUN_LAYOUT, 'console', -1))).toEqual(['program', 'console'])
    expect(centre(moveModule(DEFAULT_RUN_LAYOUT, 'macros', 'centre', 0))).toEqual(['program', 'macros', 'console'])
    expect(centre(moveModule(DEFAULT_RUN_LAYOUT, 'console', 'centre', 0))).toEqual(['program', 'console'])
  })

  it('the Arrange window\'s Console "Move up" button does not push the Run controls down', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    fireEvent.click(screen.getByTestId('arrange-up-console'))
    expect(ids('centre')).toEqual(['program', 'console'])
    fireEvent.click(within(screen.getByTestId('arrange-col-macros')).getByRole('radio', { name: 'Centre' }))
    fireEvent.click(screen.getByTestId('arrange-up-macros'))
    fireEvent.click(screen.getByTestId('arrange-up-macros'))
    expect(ids('centre')[0]).toBe('program')
  })

  it('dropping a module above Program lands it below Program', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const at = [...(this.parentElement?.children ?? [])].indexOf(this) * 100
      return { top: at, bottom: at + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: at, toJSON: () => ({}) }
    })
    try {
      fireEvent.dragStart(screen.getByTestId('arrange-grip-macros'))
      const col = screen.getByTestId('control-column-centre')
      for (const make of [createEvent.dragOver, createEvent.drop]) {
        const event = make(col)
        Object.defineProperty(event, 'clientY', { value: 10 })
        fireEvent(col, event)
      }
    } finally { rect.mockRestore() }
    expect(ids('centre')).toEqual(['program', 'macros', 'console'])
  })

  it('a layout saved or stored with Program out of place comes back with Program in place', () => {
    const bad = JSON.parse(JSON.stringify(DEFAULT_RUN_LAYOUT))
    bad.placements = [bad.placements.find((p: { id: string }) => p.id === 'console'), ...bad.placements.filter((p: { id: string }) => p.id !== 'console')]
    bad.placements.splice(bad.placements.findIndex((p: { id: string }) => p.id === 'program'), 1)
    bad.placements.push({ id: 'program', column: 'centre', folded: false, shown: true })
    expect(centre(repairLayout(bad))).toEqual(['program', 'console'])
    const s = useControlLayouts.getState()
    s.setArranging(true)
    s.setCurrent(MACHINE, bad)
    s.saveAs(MACHINE, 'Odd')
    const stored = parseStored(localStorage.getItem(CONTROL_LAYOUTS_KEY))
    expect(centre(stored[MACHINE].current)).toEqual(['program', 'console'])
    expect(centre(stored[MACHINE].saved[0])).toEqual(['program', 'console'])
    const raw = { version: 1, machines: { m: { activeId: 'run', current: bad, saved: [] } } }
    expect(centre(parseStored(JSON.stringify(raw)).m.current)).toEqual(['program', 'console'])
  })
})

describe('WO-3308 saved layouts', () => {
  it('saves under a name, picks, renames, deletes and returns to the Run layout', () => {
    render(<Harness />)
    fireEvent.click(screen.getByTestId('enter'))
    fireEvent.click(within(screen.getByTestId('arrange-col-macros')).getByRole('radio', { name: 'Left' }))
    fireEvent.change(within(screen.getByTestId('arrange-name')).getByRole('textbox'), { target: { value: 'Compact' } })
    fireEvent.click(screen.getByTestId('arrange-save-as'))
    expect(record().saved.map(s => s.name)).toEqual(['Compact'])
    expect(record().activeId).toBe(record().saved[0].id)

    fireEvent.click(screen.getByTestId('arrange-reset'))
    expect(record().activeId).toBe('run')
    expect(ids('right')).toContain('macros')

    fireEvent.change(within(screen.getByTestId('arrange-pick')).getByRole('combobox'), { target: { value: record().saved[0].id } })
    expect(ids('left')).toContain('macros')

    fireEvent.change(within(screen.getByTestId('arrange-name')).getByRole('textbox'), { target: { value: 'Setup' } })
    fireEvent.click(screen.getByTestId('arrange-rename'))
    expect(record().saved[0].name).toBe('Setup')

    fireEvent.click(screen.getByTestId('arrange-delete'))
    expect(record().saved).toEqual([])
    expect(record().activeId).toBe('run')
    expect(ids('left')).not.toContain('macros')
  })

  it('a taken name is made unique, never refused', () => {
    const s = useControlLayouts.getState()
    s.saveAs(MACHINE, 'Mine')
    s.saveAs(MACHINE, 'mine')
    s.saveAs(MACHINE, 'Run')
    expect(useControlLayouts.getState().machines[MACHINE].saved.map(l => l.name)).toEqual(['Mine', 'mine 2', 'Run 2'])
  })

  it('the active layout persists across a restart, per machine', () => {
    const s = useControlLayouts.getState()
    s.setArranging(true)
    s.setCurrent(MACHINE, moveModule(DEFAULT_RUN_LAYOUT, 'jog', 'left', 0))
    s.saveAs(MACHINE, 'Mine')
    s.saveAs('other', 'Laser')
    const stored = parseStored(localStorage.getItem(CONTROL_LAYOUTS_KEY))
    expect(columnModules(stored[MACHINE].current, 'left')[0].id).toBe('jog')
    expect(stored[MACHINE].activeId).toBe(stored[MACHINE].saved[0].id)
    expect(stored.other.saved.map(l => l.name)).toEqual(['Laser'])
    expect(columnModules(stored.other.current, 'left')[0].id).toBe('machine')
  })

  it('damaged storage falls back to the Run layout', () => {
    expect(parseStored('{not json')).toEqual({})
    expect(parseStored(JSON.stringify({ version: 99, machines: {} }))).toEqual({})
    const bad = parseStored(JSON.stringify({ version: 1, machines: { m: { activeId: 'gone', current: 5, saved: [7] } } }))
    expect(bad.m.activeId).toBe('run')
    expect(bad.m.current.placements).toEqual(DEFAULT_RUN_LAYOUT.placements)
  })
})

describe('WO-3308 words', () => {
  it('every language has every English key', () => {
    const keys = Object.keys(en)
    for (const lang of [de, es, fr]) expect(Object.keys(lang).sort()).toEqual([...keys].sort())
  })
})
