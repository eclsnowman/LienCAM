// @vitest-environment jsdom
//
// The tool rail's layout, per viewer: compact (icons only, the name and what the
// tool does in each hover hint) and groups that fold. Only Form's Start-from may
// fold once after an edit when the rail overflows; all other groups stay put
// until the viewer folds them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Box, Circle } from 'lucide-react'
import { WorkbenchToolRail, type RailSection } from '../../components/model3d/workbench/WorkbenchToolRail'

const clicks: string[] = []
const sections: RailSection[] = [
  { id: 'create', title: 'Create', tools: [
    { testId: 't-box', label: 'Box', icon: Box, title: 'A box from its three sizes', onClick: () => clicks.push('box') },
    { testId: 't-cyl', label: 'Cylinder', icon: Circle, onClick: () => clicks.push('cyl') },
  ] },
  { id: 'form', title: 'Form', tools: [
    { testId: 't-pull', label: 'Pull', icon: Circle, title: 'Pull the points onto the smooth skin', onClick: () => clicks.push('pull'), disabled: true },
  ] },
]
const mount = () => render(<WorkbenchToolRail sketchActive={false} modelingSections={sections} sketchHistoryTools={[]} onFinishSketch={() => {}} />)
const rail = () => screen.getByTestId('workbench-right-rail')

describe('the tool rail layout', () => {
  beforeEach(() => { window.localStorage.clear(); clicks.length = 0 })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('normal by default: names under icons, every group open, hover hints as before', () => {
    mount()
    expect(rail().classList.contains('is-compact')).toBe(false)
    expect(screen.getByTestId('workbench-rail-compact').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByTestId('t-box').getAttribute('data-tooltip')).toBe('A box from its three sizes')
    expect(screen.getByTestId('t-cyl').getAttribute('data-tooltip')).toBe('Cylinder')
    for (const id of ['create', 'form']) expect(screen.getByTestId(`workbench-rail-collapse-${id}`).getAttribute('aria-expanded')).toBe('true')
  })

  it('compact: the rail says so, each hint names the tool first, every button keeps its name and its click', () => {
    mount()
    fireEvent.click(screen.getByTestId('workbench-rail-compact'))
    expect(rail().classList.contains('is-compact')).toBe(true)
    expect(screen.getByTestId('t-box').getAttribute('data-tooltip')).toBe('Box: A box from its three sizes')
    expect(screen.getByTestId('t-cyl').getAttribute('data-tooltip')).toBe('Cylinder')
    expect(screen.getByRole('button', { name: 'Box' })).toBe(screen.getByTestId('t-box'))
    fireEvent.click(screen.getByTestId('t-box'))
    expect(clicks).toEqual(['box'])
    // a disabled tool stays disabled and in place, as in normal mode
    expect((screen.getByTestId('t-pull') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('workbench-rail-compact'))
    expect(rail().classList.contains('is-compact')).toBe(false)
  })

  it('a folded group hides only its own buttons; the header stays, and unfolds it', () => {
    mount()
    fireEvent.click(screen.getByTestId('workbench-rail-collapse-create'))
    expect(screen.queryByTestId('t-box')).toBeNull()
    expect(screen.queryByTestId('t-cyl')).toBeNull()
    expect(screen.getByTestId('t-pull')).toBeTruthy()
    expect(screen.getByTestId('workbench-rail-section-create').textContent).toContain('Create')
    expect(screen.getByTestId('workbench-rail-collapse-create').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByTestId('workbench-rail-collapse-create'))
    expect(screen.getByTestId('t-box')).toBeTruthy()
  })

  it('remembered for the next visit; a store that is empty, garbled or throws leaves the defaults', () => {
    mount()
    fireEvent.click(screen.getByTestId('workbench-rail-compact'))
    fireEvent.click(screen.getByTestId('workbench-rail-collapse-form'))
    cleanup()
    mount()
    expect(rail().classList.contains('is-compact')).toBe(true)
    expect(screen.queryByTestId('t-pull')).toBeNull()
    expect(screen.getByTestId('t-box')).toBeTruthy()
    cleanup()
    // WO-2297: the layout lives in the registered liencam-ui-prefs record (state.toolPaletteLayout).
    window.localStorage.setItem('liencam-ui-prefs', JSON.stringify({ state: { toolPaletteLayout: { 'liencam.rail.compact': 'yes', 'liencam.rail.collapsed': 'form' } } }))
    mount()
    expect(rail().classList.contains('is-compact')).toBe(false)
    expect(screen.getByTestId('t-pull')).toBeTruthy()
    cleanup()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    mount()
    expect(rail().classList.contains('is-compact')).toBe(false)
    fireEvent.click(screen.getByTestId('workbench-rail-compact'))
    expect(rail().classList.contains('is-compact')).toBe(true)
  })
})
