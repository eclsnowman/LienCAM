// @vitest-environment jsdom
//
// WO-3278 (UI M2 W1-A): the six kit inputs. Numbers go through the units service both ways, an
// unreadable entry keeps the old value and shows the catalogue reason (rule 11), every part works
// by mouse and keyboard, an unavailable part says why, and the lane's files carry no raw colours.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NumberField, Segmented, Select, Slider, TextField, Toggle } from '../../components/kit'
import { INPUT_GALLERY } from '../../components/kit/inputs/gallery'
import { resolveMessage } from '../../notices'
import { units } from '../../lib/units'
import { THEMES, UI2_THEME_ATTRIBUTE, UI2_THEME_IDS } from '../../theme/tokens'
import type { Availability } from '../../commands/types'

const ROOT = join(__dirname, '..', '..', '..')
const LANE = join(ROOT, 'src/components/kit/inputs')
const WHY: Availability = { ready: false, reason: 'sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber' }
const WHY_TEXT = resolveMessage(WHY.ready ? 'sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber' : WHY.reason)

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const field = () => screen.getByRole('textbox') as HTMLInputElement
const type = (el: HTMLInputElement, text: string) => { fireEvent.focus(el); fireEvent.change(el, { target: { value: text } }) }

describe('WO-3278 NumberField', () => {
  it('shows a stored value in the user unit and the unit beside it', () => {
    render(<NumberField ariaLabel="Depth" value={12.5} quantity="length" precision={2} onChange={() => {}} testId="depth" />)
    expect(field().value).toBe('12.50')
    expect(screen.getByTestId('depth').textContent).toContain(units.unitLabel('length'))
    expect(field().getAttribute('aria-label')).toBe('Depth')
  })

  it('displays what the units service formats and reads through its parse', () => {
    vi.spyOn(units, 'format').mockReturnValue('12,5')
    const parse = vi.spyOn(units, 'parse').mockReturnValue({ ok: true, value: 7 })
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={12.5} quantity="length" onChange={onChange} />)
    expect(field().value).toBe('12,5')
    type(field(), '7,0')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(parse).toHaveBeenCalledWith('length', '7,0')
    expect(onChange).toHaveBeenCalledWith(7)
  })

  it('converts a typed unit suffix to stored millimetres', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={1} quantity="length" onChange={onChange} />)
    type(field(), '1 in')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(25.4)
  })

  it('commits on blur', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Angle" value={0} quantity="angle" onChange={onChange} />)
    type(field(), '45')
    fireEvent.blur(field())
    expect(onChange).toHaveBeenCalledExactlyOnceWith(45)
  })

  it('keeps the old value and shows the catalogue reason for an unreadable entry', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} />)
    type(field(), 'abc')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(field().getAttribute('aria-invalid')).toBe('true')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(resolveMessage('sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber'))
    expect(field().getAttribute('aria-describedby')).toBe(alert.id)
    fireEvent.blur(field())
    expect(field().value).toBe('3.0')
  })

  it('clears the reason on the next edit', () => {
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" onChange={() => {}} />)
    type(field(), 'abc')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(screen.queryByRole('alert')).not.toBeNull()
    fireEvent.change(field(), { target: { value: '4' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(field().getAttribute('aria-invalid')).not.toBe('true')
  })

  it('Escape drops the draft', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} />)
    type(field(), '99')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('3.0')
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('an empty entry gives null when optional, else restores the last value', () => {
    const onChange = vi.fn()
    const { rerender } = render(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} optional />)
    type(field(), '  ')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null)
    onChange.mockClear()
    rerender(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} />)
    type(field(), '')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('3.0')
  })

  it('shows an empty value as empty', () => {
    render(<NumberField ariaLabel="Depth" value={null} quantity="length" onChange={() => {}} optional />)
    expect(field().value).toBe('')
  })

  it('steps with the arrows, ten times with Shift or Page keys, and stays inside min and max', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={5} quantity="length" step={0.5} min={0} max={6} onChange={onChange} />)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith(5.5)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith(4.5)
    fireEvent.keyDown(field(), { key: 'ArrowUp', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(6)
    fireEvent.keyDown(field(), { key: 'PageDown' })
    expect(onChange).toHaveBeenLastCalledWith(0)
  })

  it('clamps a typed value to min and max', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={5} quantity="length" min={0} max={10} onChange={onChange} />)
    type(field(), '50')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(10)
  })

  it('unavailable: read-only, names its reason, and never changes the value', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" onChange={onChange} availability={WHY} testId="nf" />)
    expect(field().readOnly).toBe(true)
    expect(field().getAttribute('aria-disabled')).toBe('true')
    const tip = within(screen.getByTestId('nf')).getByRole('tooltip')
    expect(tip.textContent).toBe(WHY_TEXT)
    expect(field().getAttribute('aria-describedby')).toBe(tip.id)
    fireEvent.change(field(), { target: { value: '9' } })
    expect(field().value).toBe('3.000')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('has no tooltip element while it is ready', () => {
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" onChange={() => {}} />)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('WO-3278 TextField', () => {
  it('shows the value, reports edits, takes a placeholder and the mono look', () => {
    const onChange = vi.fn()
    render(<TextField ariaLabel="Name" value="Pocket 1" placeholder="Name" onChange={onChange} mono testId="tf" />)
    expect(field().value).toBe('Pocket 1')
    expect(field().placeholder).toBe('Name')
    fireEvent.change(field(), { target: { value: 'Pocket 2' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Pocket 2')
    expect(screen.getByTestId('tf').className).toContain('kit-mono')
  })

  it('unavailable: read-only with the reason', () => {
    const onChange = vi.fn()
    render(<TextField ariaLabel="Name" value="x" onChange={onChange} availability={WHY} />)
    expect(field().readOnly).toBe(true)
    expect(screen.getByRole('tooltip').textContent).toBe(WHY_TEXT)
    fireEvent.change(field(), { target: { value: 'y' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }] as const

describe('WO-3278 Select', () => {
  it('lists the options, shows the value and reports the choice', () => {
    const onChange = vi.fn()
    render(<Select ariaLabel="Mode" value="b" options={OPTIONS} onChange={onChange} />)
    const sel = screen.getByRole('combobox') as HTMLSelectElement
    expect(sel.value).toBe('b')
    expect([...sel.options].map(o => o.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    fireEvent.change(sel, { target: { value: 'c' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith('c')
  })

  it('unavailable: names its reason and ignores a change', () => {
    const onChange = vi.fn()
    render(<Select ariaLabel="Mode" value="a" options={OPTIONS} onChange={onChange} availability={WHY} />)
    const sel = screen.getByRole('combobox')
    expect(sel.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('tooltip').textContent).toBe(WHY_TEXT)
    fireEvent.change(sel, { target: { value: 'b' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WO-3278 Segmented', () => {
  it('is a radio group with the selected option checked and one tab stop', () => {
    render(<Segmented ariaLabel="Mode" value="b" options={OPTIONS} onChange={() => {}} />)
    expect(screen.getByRole('radiogroup').getAttribute('aria-label')).toBe('Mode')
    const radios = screen.getAllByRole('radio')
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios.map(r => r.tabIndex)).toEqual([-1, 0, -1])
  })

  it('selects by click', () => {
    const onChange = vi.fn()
    render(<Segmented ariaLabel="Mode" value="a" options={OPTIONS} onChange={onChange} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Gamma' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('c')
  })

  it('moves and selects with the arrow keys, wrapping, and Home and End', () => {
    const onChange = vi.fn()
    render(<Segmented ariaLabel="Mode" value="c" options={OPTIONS} onChange={onChange} />)
    const last = screen.getByRole('radio', { name: 'Gamma' })
    fireEvent.keyDown(last, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(last, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('b')
    fireEvent.keyDown(last, { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('c')
  })

  it('unavailable: names its reason and does not select', () => {
    const onChange = vi.fn()
    render(<Segmented ariaLabel="Mode" value="a" options={OPTIONS} onChange={onChange} availability={WHY} />)
    expect(screen.getByRole('tooltip').textContent).toBe(WHY_TEXT)
    const radios = screen.getAllByRole('radio')
    expect(radios.every(r => r.getAttribute('aria-disabled') === 'true')).toBe(true)
    fireEvent.click(radios[2])
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WO-3278 Toggle', () => {
  it('shows its label, reports the next state on click', () => {
    const onChange = vi.fn()
    render(<Toggle ariaLabel="Coolant" label="Coolant on" on={false} onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'Coolant' }) as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(screen.getByText('Coolant on')).toBeTruthy()
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('reflects the on state', () => {
    render(<Toggle ariaLabel="Coolant" label="Coolant on" on onChange={() => {}} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('unavailable: names its reason and does not toggle', () => {
    const onChange = vi.fn()
    render(<Toggle ariaLabel="Coolant" label="Coolant on" on={false} onChange={onChange} availability={WHY} />)
    expect(screen.getByRole('tooltip').textContent).toBe(WHY_TEXT)
    const box = screen.getByRole('checkbox')
    expect(box.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(box)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WO-3278 Slider', () => {
  it('is a range with its bounds and reports a number', () => {
    const onChange = vi.fn()
    render(<Slider ariaLabel="Feed override" value={50} min={10} max={200} step={5} onChange={onChange} />)
    const r = screen.getByRole('slider') as HTMLInputElement
    expect([r.min, r.max, r.step, r.value]).toEqual(['10', '200', '5', '50'])
    fireEvent.change(r, { target: { value: '75' } })
    expect(onChange).toHaveBeenCalledExactlyOnceWith(75)
  })

  it('shows the value through the units service when it has a quantity', () => {
    render(<Slider ariaLabel="Angle" value={45} min={0} max={90} quantity="angle" onChange={() => {}} testId="sl" />)
    expect(screen.getByTestId('sl').textContent).toContain(units.format('angle', 45))
  })

  it('unavailable: names its reason and ignores a change', () => {
    const onChange = vi.fn()
    render(<Slider ariaLabel="Feed override" value={50} min={10} max={200} onChange={onChange} availability={WHY} />)
    expect(screen.getByRole('tooltip').textContent).toBe(WHY_TEXT)
    const r = screen.getByRole('slider')
    expect(r.getAttribute('aria-disabled')).toBe('true')
    fireEvent.change(r, { target: { value: '90' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WO-3278 kit looks and gallery', () => {
  it('marks every part with data-kit and passes testId through', () => {
    render(<>
      <NumberField ariaLabel="n" value={1} quantity="none" onChange={() => {}} testId="t1" />
      <TextField ariaLabel="t" value="" onChange={() => {}} testId="t2" />
      <Select ariaLabel="s" value="a" options={OPTIONS} onChange={() => {}} testId="t3" />
      <Segmented ariaLabel="g" value="a" options={OPTIONS} onChange={() => {}} testId="t4" />
      <Toggle ariaLabel="o" label="o" on={false} onChange={() => {}} testId="t5" />
      <Slider ariaLabel="l" value={1} min={0} max={2} onChange={() => {}} testId="t6" />
    </>)
    const kinds = ['t1', 't2', 't3', 't4', 't5', 't6'].map(id => screen.getByTestId(id).getAttribute('data-kit'))
    expect(kinds).toEqual(['NumberField', 'TextField', 'Select', 'Segmented', 'Toggle', 'Slider'])
  })

  it('the gallery has an ordinary and an unavailable example for every part', () => {
    const parts = ['NumberField', 'TextField', 'Select', 'Segmented', 'Toggle', 'Slider']
    for (const part of parts) {
      const states = INPUT_GALLERY.filter(e => e.part === part).map(e => e.state)
      expect(states, part).toContain('default')
      expect(states, part).toContain('unavailable')
    }
    expect(INPUT_GALLERY.some(e => e.part === 'NumberField' && e.state === 'invalid')).toBe(true)
  })

  it('every gallery example renders in each of the three M1 themes', () => {
    expect(UI2_THEME_IDS).toEqual(Object.keys(THEMES))
    for (const theme of UI2_THEME_IDS) {
      for (const ex of INPUT_GALLERY) {
        const { container, unmount } = render(<div data-ui2="" {...{ [UI2_THEME_ATTRIBUTE]: theme }}>{ex.element}</div>)
        expect(container.querySelector('[data-kit]'), `${ex.part} ${ex.state} ${theme}`).not.toBeNull()
        unmount()
      }
    }
  })

  it('styles come from token custom properties only: no raw colour, font size or inline colour in the lane', () => {
    const files = readdirSync(LANE).filter(f => /\.(tsx?|css)$/.test(f))
    expect(files).toContain('kit-inputs.css')
    for (const f of files) {
      const src = readFileSync(join(LANE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toMatch(/\b(rgb|hsl)a?\(/)
      expect(src, f).not.toMatch(/font-size:\s*[\d.]+(px|rem|em)/)
      if (f.endsWith('.css')) expect(src, f).toMatch(/var\(--/)
      else expect(src, f).not.toMatch(/style=\{\{\s*(color|background|fontSize|width|height)/)
    }
  })
})

describe('WO-3278 audit fixes', () => {
  it('a draft typed before the field became unavailable is dropped, never committed', () => {
    const onChange = vi.fn()
    const { rerender } = render(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} />)
    type(field(), '50')
    rerender(<NumberField ariaLabel="Depth" value={3} quantity="length" precision={1} onChange={onChange} availability={WHY} />)
    fireEvent.blur(field())
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('3.0')
  })

  it('an unreadable draft is not stepped over: the arrow keeps the text and shows the reason', () => {
    const onChange = vi.fn()
    render(<NumberField ariaLabel="Depth" value={3} quantity="length" onChange={onChange} />)
    type(field(), 'abc')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(onChange).not.toHaveBeenCalled()
    expect(field().value).toBe('abc')
    expect(screen.getByRole('alert').textContent).toBe(resolveMessage('sketch-and-model-workbench:SolidsWorkbenchPage.enterANumber'))
  })

  it('Escape is consumed only while a draft is open; a leftover reason clears without stopping the dialog', () => {
    const outer = vi.fn()
    render(<div onKeyDown={e => { if (e.key === 'Escape') outer() }}><NumberField ariaLabel="Depth" value={3} quantity="length" onChange={() => {}} /></div>)
    type(field(), 'abc')
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.blur(field())
    expect(screen.queryByRole('alert')).not.toBeNull()
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(outer).toHaveBeenCalledTimes(1)
    type(field(), '9')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('steps from the new value after the screen updates it, clamping at the bounds', () => {
    let value = 5
    const onChange = vi.fn((v: number | null) => { value = v as number })
    const view = () => <NumberField ariaLabel="Depth" value={value} quantity="length" step={4} min={0} max={10} onChange={onChange} />
    const { rerender } = render(view())
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    rerender(view())
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(onChange.mock.calls.map(c => c[0])).toEqual([9, 10])
  })

  it('an unavailable part stays focusable: never natively disabled, no tab stop removed', () => {
    render(<>
      <NumberField ariaLabel="n" value={1} quantity="none" onChange={() => {}} availability={WHY} />
      <TextField ariaLabel="t" value="" onChange={() => {}} availability={WHY} />
      <Select ariaLabel="s" value="a" options={OPTIONS} onChange={() => {}} availability={WHY} />
      <Toggle ariaLabel="o" label="o" on={false} onChange={() => {}} availability={WHY} />
      <Slider ariaLabel="l" value={1} min={0} max={2} onChange={() => {}} availability={WHY} />
      <Segmented ariaLabel="g" value="a" options={OPTIONS} onChange={() => {}} availability={WHY} />
    </>)
    const controls = [...screen.getAllByRole('textbox'), screen.getByRole('combobox'), screen.getByRole('checkbox'), screen.getByRole('slider'), screen.getAllByRole('radio')[0]]
    for (const c of controls) {
      expect((c as HTMLInputElement).disabled).toBe(false)
      expect(c.tabIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('Segmented: the tab stop follows the selection and a modified arrow is left to the browser', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Segmented ariaLabel="Mode" value="a" options={OPTIONS} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'ArrowLeft', altKey: true })
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Alpha' }), { key: 'Home', ctrlKey: true })
    expect(onChange).not.toHaveBeenCalled()
    rerender(<Segmented ariaLabel="Mode" value="c" options={OPTIONS} onChange={onChange} />)
    expect(screen.getAllByRole('radio').map(r => r.tabIndex)).toEqual([-1, -1, 0])
  })

  it('Slider: an unavailable slider swallows its keys except Tab', () => {
    render(<Slider ariaLabel="l" value={1} min={0} max={2} onChange={() => {}} availability={WHY} />)
    const r = screen.getByRole('slider')
    expect(fireEvent.keyDown(r, { key: 'ArrowRight' })).toBe(false)
    expect(fireEvent.keyDown(r, { key: 'Tab' })).toBe(true)
  })
})
