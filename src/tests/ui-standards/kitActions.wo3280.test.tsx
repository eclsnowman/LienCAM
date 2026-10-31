// @vitest-environment jsdom
//
// WO-3280 (UI M2 Wave 1, lane C): the kit action parts. Button draws the four kinds of spec 7.1
// (held, lamp, selection, transport) and shows the availability reason instead of acting;
// RibbonGroup, PromptBar, AnchoredValue, ShowCard and ViewCube work by mouse and keyboard; the
// stylesheet uses only token custom properties; the gallery shows every part and state.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import * as kit from '../../components/kit'
import { ACTION_GALLERY } from '../../components/kit/actions/gallery'
import { THEMES, tokenCss } from '../../theme/tokens'
import type { Availability } from '../../commands/types'

const ROOT = join(__dirname, '..', '..', '..')
const ACTIONS_DIR = join(ROOT, 'src/components/kit/actions')
afterEach(cleanup)

const REASON = 'sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber' as const
const NOT_READY: Availability = { ready: false, reason: REASON, lock: true }

describe('WO-3280 Button', () => {
  it('a momentary button is held (solid, sunk) only while the press lasts', () => {
    const onPress = vi.fn(), onRelease = vi.fn()
    render(<kit.Button kind="momentary" label="X+" onPress={onPress} onRelease={onRelease} testId="jog" />)
    const jog = screen.getByTestId('jog')
    expect(jog.dataset.held).toBe('false')
    fireEvent.pointerDown(jog)
    expect(jog.dataset.held).toBe('true')
    fireEvent.pointerUp(jog)
    expect(jog.dataset.held).toBe('false')
    fireEvent.keyDown(jog, { key: ' ' })
    expect(jog.dataset.held).toBe('true')
    fireEvent.keyUp(jog, { key: ' ' })
    expect(jog.dataset.held).toBe('false')
    expect(onPress).toHaveBeenCalledTimes(2)
    expect(onRelease).toHaveBeenCalledTimes(2)
  })

  it('a hold ends once however it is lost: leave, cancel, blur, unmount', () => {
    const onRelease = vi.fn()
    const { unmount } = render(<kit.Button kind="momentary" label="X+" onPress={() => {}} onRelease={onRelease} testId="jog" />)
    const jog = screen.getByTestId('jog')
    fireEvent.pointerDown(jog)
    fireEvent.pointerLeave(jog)
    fireEvent.pointerUp(jog)
    expect(onRelease).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(jog)
    fireEvent.pointerCancel(jog)
    expect(onRelease).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(jog, { key: 'Enter' })
    fireEvent.blur(jog)
    expect(onRelease).toHaveBeenCalledTimes(3)
    fireEvent.pointerDown(jog)
    unmount()
    expect(onRelease).toHaveBeenCalledTimes(4)
  })

  it('a click-only momentary button runs on click and still shows held while pressed', () => {
    const onPress = vi.fn()
    render(<kit.Button kind="momentary" label="Step" onPress={onPress} testId="step" />)
    const step = screen.getByTestId('step')
    fireEvent.pointerDown(step)
    expect(step.dataset.held).toBe('true')
    fireEvent.pointerUp(step)
    fireEvent.click(step)
    expect(step.dataset.held).toBe('false')
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('latched always carries a lamp, hollow off and lit on; choice and momentary carry none', () => {
    render(
      <>
        <kit.Button kind="latched" label="Coolant" on={false} onToggle={() => {}} testId="off" />
        <kit.Button kind="latched" label="Vacuum" on onToggle={() => {}} testId="on" />
        <kit.Button kind="choice" label="1 mm" selected onSelect={() => {}} testId="choice" />
        <kit.Button kind="momentary" label="Step" onPress={() => {}} testId="mom" />
      </>,
    )
    expect(screen.getByTestId('off').querySelector('.kit-lamp')?.getAttribute('data-lit')).toBe('false')
    expect(screen.getByTestId('on').querySelector('.kit-lamp')?.getAttribute('data-lit')).toBe('true')
    expect(screen.getByTestId('on').dataset.on).toBe('true')
    expect(screen.getByTestId('choice').querySelector('.kit-lamp')).toBeNull()
    expect(screen.getByTestId('mom').querySelector('.kit-lamp')).toBeNull()
  })

  it('an unavailable button shows the reason and the lock, stays focusable and does nothing', () => {
    const onPress = vi.fn(), onRelease = vi.fn(), onToggle = vi.fn()
    render(
      <>
        <kit.Button kind="momentary" label="Probe" onPress={onPress} onRelease={onRelease} availability={NOT_READY} testId="u" />
        <kit.Button kind="latched" label="Coolant" on={false} onToggle={onToggle} availability={{ ready: false, reason: REASON }} testId="nolock" />
      </>,
    )
    const u = screen.getByTestId('u')
    expect(u.dataset.unavailable).toBe('true')
    expect(u.getAttribute('aria-disabled')).toBe('true')
    expect(u.hasAttribute('disabled')).toBe(false)
    expect(u.querySelector('.kit-lock')).not.toBeNull()
    expect(screen.getByTestId('nolock').querySelector('.kit-lock')).toBeNull()
    const tip = document.getElementById(u.getAttribute('aria-describedby') ?? 'missing')
    expect(tip?.getAttribute('role')).toBe('tooltip')
    expect((tip?.textContent ?? '').length).toBeGreaterThan(3)
    expect(u.getAttribute('title')).toBeNull()
    fireEvent.pointerDown(u)
    fireEvent.pointerUp(u)
    fireEvent.keyDown(u, { key: 'Enter' })
    fireEvent.keyUp(u, { key: 'Enter' })
    fireEvent.click(u)
    fireEvent.click(screen.getByTestId('nolock'))
    expect(onPress).not.toHaveBeenCalled()
    expect(onRelease).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
    expect(u.dataset.held).toBe('false')
  })

  it('a ready button has no tooltip and no lock', () => {
    render(<kit.Button kind="momentary" label="Go" onPress={() => {}} availability={{ ready: true }} testId="r" />)
    const r = screen.getByTestId('r')
    expect(r.dataset.unavailable).toBe('false')
    expect(r.getAttribute('aria-describedby')).toBeNull()
    expect(r.querySelector('.kit-lock')).toBeNull()
  })

  it('an icon button is named by its label and draws only the icon', () => {
    render(<kit.Button kind="momentary" form="icon" icon="extrude" label="Extrude" onPress={() => {}} testId="i" />)
    const i = screen.getByTestId('i')
    expect(i.getAttribute('aria-label')).toBe('Extrude')
    expect(i.querySelector('[data-icon="extrude"]')).not.toBeNull()
    expect(i.textContent).toBe('')
  })

  it('a big button stacks the icon above a label; a small one keeps one line', () => {
    render(
      <>
        <kit.Button kind="momentary" form="big" icon="pocket" label="Pocket" onPress={() => {}} testId="big" />
        <kit.Button kind="momentary" form="small" icon="line" label="Line" onPress={() => {}} testId="small" />
      </>,
    )
    expect(screen.getByTestId('big').dataset.form).toBe('big')
    expect(screen.getByTestId('big').querySelector('.kit-button-label')?.textContent).toBe('Pocket')
    expect(screen.getByTestId('small').dataset.form).toBe('small')
  })

  it('transport keeps start, hold and stop, lit only while active', () => {
    render(
      <>
        <kit.Button kind="transport" transport="start" label="Start" onPress={() => {}} testId="s" />
        <kit.Button kind="transport" transport="hold" label="Feed hold" active onPress={() => {}} testId="h" />
        <kit.Button kind="transport" transport="stop" label="Stop" onPress={() => {}} testId="x" />
      </>,
    )
    expect(['s', 'h', 'x'].map(id => screen.getByTestId(id).dataset.transport)).toEqual(['start', 'hold', 'stop'])
    expect(screen.getByTestId('h').dataset.on).toBe('true')
    expect(screen.getByTestId('s').dataset.on).toBe('false')
  })
})

describe('WO-3280 RibbonGroup', () => {
  it('names the group, lays the buttons in a tools band and opens the group menu from the caption', () => {
    const onOpenMenu = vi.fn()
    render(
      <kit.RibbonGroup caption="Draw" onOpenMenu={onOpenMenu} testId="g">
        <kit.Button kind="momentary" form="big" label="Line" onPress={() => {}} />
        <kit.Button kind="momentary" form="small" label="Arc" onPress={() => {}} />
      </kit.RibbonGroup>,
    )
    const group = screen.getByRole('group', { name: 'Draw' })
    expect(within(group).getAllByRole('button')).toHaveLength(3)
    const caption = screen.getByRole('button', { name: /Draw/ })
    expect(caption.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(caption)
    expect(onOpenMenu).toHaveBeenCalledTimes(1)
  })

  it('a caption with no menu is a plain label, not a button', () => {
    render(<kit.RibbonGroup caption="Exit"><kit.Button kind="momentary" label="Finish" onPress={() => {}} /></kit.RibbonGroup>)
    expect(screen.queryByRole('button', { name: 'Exit' })).toBeNull()
    expect(screen.getByText('Exit').className).toContain('kit-ribbongroup-caption')
  })
})

describe('WO-3280 PromptBar', () => {
  it('shows the prompt, the step, an Esc key cap and Cancel, and Escape cancels', () => {
    const onCancel = vi.fn()
    render(<kit.PromptBar prompt="Pick the floor face" step={{ index: 2, count: 3 }} onCancel={onCancel} actions={<kit.Button kind="momentary" emphasis="primary" label="Done" onPress={() => {}} />} testId="p" />)
    const bar = screen.getByTestId('p')
    expect(bar.textContent).toContain('Pick the floor face')
    expect(bar.textContent).toContain('2/3')
    expect(bar.querySelector('kbd')?.textContent).toBe('Esc')
    expect(within(bar).getByRole('button', { name: 'Cancel' })).not.toBeNull()
    expect(within(bar).getByRole('button', { name: 'Done' })).not.toBeNull()
    fireEvent.click(within(bar).getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(within(bar).getByRole('button', { name: 'Done' }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('with nothing to cancel it draws no Cancel and no key cap', () => {
    render(<kit.PromptBar prompt="Select a face" testId="p" />)
    const bar = screen.getByTestId('p')
    expect(within(bar).queryByRole('button')).toBeNull()
    expect(bar.querySelector('kbd')).toBeNull()
  })
})

describe('WO-3280 AnchoredValue', () => {
  it('is placed through CSS custom properties, focused, and commits a parsed value on Enter', () => {
    const onCommit = vi.fn(), onCancel = vi.fn()
    render(<kit.AnchoredValue anchor={{ x: 120, y: 80 }} value={25} quantity="length" ariaLabel="Distance" onCommit={onCommit} onCancel={onCancel} testId="a" />)
    const field = screen.getByLabelText('Distance') as HTMLInputElement
    const holder = screen.getByTestId('a')
    expect(holder.style.getPropertyValue('--kit-x')).toBe('120px')
    expect(holder.style.getPropertyValue('--kit-y')).toBe('80px')
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '30' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(30)
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('an entry that is not a number commits nothing and says why', () => {
    const onCommit = vi.fn()
    render(<kit.AnchoredValue anchor={{ x: 0, y: 0 }} value={null} quantity="length" ariaLabel="Distance" onCommit={onCommit} onCancel={() => {}} />)
    const field = screen.getByLabelText('Distance')
    fireEvent.change(field, { target: { value: 'abc' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(field.getAttribute('aria-invalid')).toBe('true')
    const reason = document.getElementById(field.getAttribute('aria-describedby') ?? 'missing')
    expect(reason?.getAttribute('role')).toBe('alert')
    fireEvent.change(field, { target: { value: '5' } })
    expect(field.getAttribute('aria-invalid')).toBeNull()
  })
})

describe('WO-3280 ShowCard', () => {
  const items = [
    { id: 'cut', label: 'Cut moves', visible: true, swatchVar: '--mv-cut' as const },
    { id: 'rapid', label: 'Rapids', visible: false, swatchVar: '--mv-rapid' as const },
  ]

  it('its header is the button; the list opens upward by a data flag and Escape folds it', () => {
    const onOpenChange = vi.fn()
    render(<kit.ShowCard title="Show" items={items} onToggle={() => {}} onOpenChange={onOpenChange} testId="s" />)
    const header = screen.getByRole('button', { name: /Show/ })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByTestId('s').dataset.open).toBe('true')
    expect(screen.getByTestId('s').dataset.dir).toBe('up')
    fireEvent.keyDown(screen.getByLabelText('Cut moves'), { key: 'Escape' })
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByTestId('s').dataset.open).toBe('false')
    expect(document.activeElement).toBe(header)
  })

  it('one row per item with its swatch and a checkbox that reports the visibility', () => {
    const onToggle = vi.fn()
    render(<kit.ShowCard title="Show" items={items} onToggle={onToggle} open testId="s" />)
    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(2)
    expect((rows[0] as HTMLInputElement).checked).toBe(true)
    const swatch = rows[0].closest('li')?.querySelector('.kit-swatch') as HTMLElement
    expect(swatch.style.getPropertyValue('--kit-swatch')).toBe('var(--mv-cut)')
    fireEvent.click(rows[1])
    expect(onToggle).toHaveBeenCalledWith('rapid', true)
  })

  it('a controlled card follows its open prop', () => {
    const { rerender } = render(<kit.ShowCard title="Show" items={items} onToggle={() => {}} open={false} testId="s" />)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    rerender(<kit.ShowCard title="Show" items={items} onToggle={() => {}} open testId="s" />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  })
})

describe('WO-3280 ViewCube', () => {
  const faceLabels = { top: 'Top', bottom: 'Bottom', front: 'Front', back: 'Back', left: 'Left', right: 'Right', iso: 'Isometric' }

  it('reports the picked view and nothing else', () => {
    const onView = vi.fn()
    render(<kit.ViewCube onView={onView} faceLabels={faceLabels} style="shaded" onStyle={() => {}} testId="v" />)
    fireEvent.click(screen.getByRole('button', { name: 'Front' }))
    expect(onView).toHaveBeenCalledWith('front')
    expect(kit.VIEW_PRESETS.every(v => screen.getByRole('button', { name: faceLabels[v] }))).toBe(true)
  })

  it('the View style button opens a flyout of four styles, marks the current one and reports a pick', () => {
    const onStyle = vi.fn()
    render(<kit.ViewCube onView={() => {}} faceLabels={faceLabels} style="wireframe" onStyle={onStyle} testId="v" />)
    const opener = screen.getByRole('button', { name: 'View style' })
    expect(opener.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(opener)
    const items = screen.getAllByRole('menuitemradio')
    expect(items).toHaveLength(4)
    expect(items.filter(i => i.getAttribute('aria-checked') === 'true').map(i => i.textContent)).toEqual(['Wireframe'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Hidden edges' }))
    expect(onStyle).toHaveBeenCalledWith('hidden-edges')
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('Escape folds the flyout and keeps focus on its button', () => {
    render(<kit.ViewCube onView={() => {}} faceLabels={faceLabels} style="shaded" onStyle={() => {}} />)
    const opener = screen.getByRole('button', { name: 'View style' })
    fireEvent.click(opener)
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0], { key: 'Escape' })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(document.activeElement).toBe(opener)
  })
})

describe('WO-3280 gallery and sheet', () => {
  it('shows every part and every state of spec 7.1', () => {
    const parts = new Set(ACTION_GALLERY.map(e => e.part))
    expect([...parts].sort()).toEqual(['AnchoredValue', 'Button', 'PromptBar', 'RibbonGroup', 'ShowCard', 'ViewCube'])
    const states = ACTION_GALLERY.filter(e => e.part === 'Button').map(e => e.state)
    for (const want of ['momentary rest', 'momentary held', 'latched off', 'latched on', 'choice selected', 'choice idle', 'transport start', 'transport hold', 'transport stop', 'unavailable', 'unavailable lock']) {
      expect(states).toContain(want)
    }
  })

  it('every example renders in each M1 theme', () => {
    expect(ACTION_GALLERY.length).toBeGreaterThan(20)
    for (const theme of Object.keys(THEMES)) {
      for (const entry of ACTION_GALLERY) {
        const { container, unmount } = render(<div data-ui2="" data-ui2-theme={theme}>{entry.node}</div>)
        expect(container.querySelector('[data-kit]'), `${entry.part} ${entry.state} in ${theme}`).not.toBeNull()
        unmount()
      }
    }
  })

  it('the stylesheet takes colours and sizes only from token custom properties', () => {
    const css = readFileSync(join(ACTIONS_DIR, 'actions.css'), 'utf8')
    const defined = new Set([...tokenCss().matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]))
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1])
    const local = new Set([...css.matchAll(/(--kit-[a-z0-9-]+)\s*:/g)].map(m => m[1]))
    const unknown = [...new Set(used)].filter(v => !defined.has(v) && !v.startsWith('--kit-') && !local.has(v))
    expect(unknown).toEqual([])
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []).toEqual([])
    const heads = stripped.split('\n').map(l => l.trim()).filter(l => l.endsWith('{') && !l.startsWith('@'))
    expect(heads.filter(h => !h.startsWith('[data-ui2]'))).toEqual([])
  })

  it('the button forms drive the same ground and edge variables as every state, so no state is hidden on a ribbon button', () => {
    const css = readFileSync(join(ACTIONS_DIR, 'actions.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const forms = [...css.matchAll(/data-form="(?:small|big)"\][^{]*\{([^}]*)\}/g)].map(m => m[1])
    expect(forms.length).toBeGreaterThan(1)
    for (const body of forms) expect(body).not.toMatch(/(^|;|\n)\s*(background|border-color)\s*:/)
  })

  it('the kit actions import nothing from the viewport, engine, store or screens', () => {
    const files = readdirSync(ACTIONS_DIR).filter(f => /\.tsx?$/.test(f))
    expect(files).toContain('gallery.tsx')
    for (const f of files) {
      const src = readFileSync(join(ACTIONS_DIR, f), 'utf8')
      const specs = [...src.matchAll(/(?:from|import)\s+'([^']+)'/g)].map(m => m[1])
      const bad = specs.filter(s => /lib\/cam|cam3d|kernel|wasm|three|\/store|\/post\b|components\/(?!kit)|viewport|Viewport/i.test(s))
      expect(bad, f).toEqual([])
    }
  })

  it('draws a state per kind into the document without throwing under act', () => {
    act(() => { render(<div data-ui2="">{ACTION_GALLERY.map(e => <div key={e.part + e.state}>{e.node}</div>)}</div>) })
    expect(document.querySelectorAll('[data-kit="Button"]').length).toBeGreaterThan(10)
  })
})
