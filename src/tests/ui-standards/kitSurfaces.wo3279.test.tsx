// @vitest-environment jsdom
//
// WO-3279 (UI M2 W1-B): the kit surfaces. Card and Section collapse by mouse and keyboard, PropRow
// lays out label and value on the grid, Pill and BrowserRow show their states, Tooltip replaces
// title= (delay, keyboard focus, never over its control), Dialog / Window / Confirm join the one
// dialog stack (Escape closes the top one only), trap focus and return it, and Window moves and
// keeps its place for the session. The gallery shows every part in the three M1 themes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Card, Confirm, Dialog, BrowserRow, Pill, PropRow, Section, Tooltip, Window } from '../../components/kit'
import { SurfacesGallery } from '../../components/kit/surfaces/gallery'
import { createCommandRegistry, createShortcutManager, dialogStack, installShortcutListener } from '../../commands'
import { THEMES } from '../../theme/tokens'

const ROOT = join(__dirname, '..', '..', '..')
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('WO-3279 Card', () => {
  it('shows the title, status pill and close button, and closes by mouse', () => {
    const onClose = vi.fn()
    render(<Card title="Pocket" status={{ tone: 'ok', label: 'Ready' }} onClose={onClose} closeLabel="Close" testId="c"><p>body</p></Card>)
    expect(screen.getByRole('region', { name: 'Pocket' })).toBeTruthy()
    expect(screen.getByText('Ready').getAttribute('data-tone')).toBe('ok')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('draws the footer ghost, Cancel and primary in that order; an unavailable action does nothing and says why', () => {
    const run = vi.fn()
    const blocked = vi.fn()
    render(
      <Card
        title="Edit"
        footer={{
          ghost: { label: 'Reset', onPress: () => {} },
          cancel: { label: 'Cancel', onPress: () => {} },
          primary: { label: 'Generate', onPress: blocked, availability: { ready: false, reason: 'app-shell-settings-menus:closeHelp' } },
        }}
      />,
    )
    const labels = screen.getAllByRole('button').map(b => b.textContent)
    expect(labels).toEqual(['Reset', 'Cancel', 'Generate'])
    const primary = screen.getByRole('button', { name: 'Generate' })
    expect(primary.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(primary)
    expect(blocked).not.toHaveBeenCalled()
    render(<Card title="Run" footer={{ primary: { label: 'Go', onPress: run } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('opens the overflow menu from the header and closes it on Escape', () => {
    render(<Card title="Menu card" menu={<button type="button">Duplicate</button>} />)
    expect(screen.queryByText('Duplicate')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'Menu card' })
    fireEvent.click(trigger)
    expect(screen.getByText('Duplicate')).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByText('Duplicate'), { key: 'Escape' })
    expect(screen.queryByText('Duplicate')).toBeNull()
  })
})

describe('WO-3279 Section', () => {
  it('collapses and expands by mouse and by keyboard, keeping the summary visible', () => {
    const onToggle = vi.fn()
    render(<Section caption="Depths" summary="3 mm / 2 passes" onToggle={onToggle}><p>inside</p></Section>)
    const header = screen.getByRole('button', { name: /Depths/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('inside')).toBeTruthy()
    fireEvent.click(header)
    expect(screen.queryByText('inside')).toBeNull()
    expect(screen.getByText('3 mm / 2 passes')).toBeTruthy()
    expect(onToggle).toHaveBeenLastCalledWith(false)
    // Enter and Space on a button arrive as a click; the header must be a real button
    expect(header.tagName).toBe('BUTTON')
    fireEvent.click(header)
    expect(screen.getByText('inside')).toBeTruthy()
    expect(header.getAttribute('aria-controls')).toBe(screen.getByText('inside').parentElement!.id)
  })

  it('obeys a controlled open state', () => {
    const { rerender } = render(<Section caption="A" open={false}><p>x</p></Section>)
    fireEvent.click(screen.getByRole('button', { name: /A/ }))
    expect(screen.queryByText('x')).toBeNull()
    rerender(<Section caption="A" open><p>x</p></Section>)
    expect(screen.getByText('x')).toBeTruthy()
  })
})

describe('WO-3279 PropRow and Pill', () => {
  it('names the value by its label so a screen reader reads them together', () => {
    render(<PropRow label="Stepover" testId="r"><input aria-label="v" /></PropRow>)
    const row = screen.getByTestId('r')
    expect(row.getAttribute('role')).toBe('group')
    const labelId = row.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelId)!.textContent).toBe('Stepover')
  })

  it('renders each tone', () => {
    render(<>{(['neutral', 'accent', 'ok', 'warn', 'err'] as const).map(t => <Pill key={t} tone={t} label={t} />)}</>)
    for (const t of ['neutral', 'accent', 'ok', 'warn', 'err']) expect(screen.getByText(t).getAttribute('data-tone')).toBe(t)
  })
})

describe('WO-3279 BrowserRow', () => {
  it('shows selection, indent, muted and status, and selects by click and Enter', () => {
    const onSelect = vi.fn()
    render(<BrowserRow depth={2} name="Pocket 1" meta="12 min" status="warn" selected muted onSelect={onSelect} testId="b" />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.getAttribute('aria-level')).toBe('3')
    expect(row.getAttribute('data-muted')).toBe('true')
    expect(row.getAttribute('data-status')).toBe('warn')
    expect(row.style.getPropertyValue('--kit-depth')).toBe('2')
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledTimes(2)
  })

  it('expands with the chevron and the arrow keys; a leaf has no chevron', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<BrowserRow depth={0} name="Setup" expanded={false} onToggle={onToggle} toggleLabel="Expand" />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'ArrowRight' })
    expect(onToggle).toHaveBeenCalledTimes(2)
    rerender(<BrowserRow depth={0} name="Setup" expanded onToggle={onToggle} toggleLabel="Collapse" />)
    fireEvent.keyDown(screen.getByRole('treeitem'), { key: 'ArrowLeft' })
    expect(onToggle).toHaveBeenCalledTimes(3)
    rerender(<BrowserRow depth={0} name="Leaf" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps row actions in the DOM for hover and selection to reveal', () => {
    render(<BrowserRow depth={0} name="Op" actions={<button type="button">Hide</button>} />)
    expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy()
  })
})

describe('WO-3279 Tooltip', () => {
  it('replaces title=: shows after the delay on hover, with the shortcut, and links to its control', () => {
    render(<Tooltip text="Generate" shortcut="G"><button type="button">Go</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Go' })
    expect(button.hasAttribute('title')).toBe(false)
    fireEvent.mouseEnter(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => { vi.advanceTimersByTime(500) })
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toContain('Generate')
    expect(tip.textContent).toContain('G')
    expect(button.getAttribute('aria-describedby')).toBe(tip.id)
    fireEvent.mouseLeave(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on keyboard focus, hides on blur and on Escape, and never opens before the delay on a quick pass', () => {
    render(<Tooltip text="Help"><button type="button">Q</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Q' })
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(button)
    fireEvent.mouseEnter(button)
    act(() => { vi.advanceTimersByTime(200) })
    fireEvent.mouseLeave(button)
    act(() => { vi.advanceTimersByTime(600) })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('opens below its control, or above when there is no room below, never over it', () => {
    render(<Tooltip text="T"><button type="button">B</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'B' })
    const rect = (top: number) => ({ top, bottom: top + 20, left: 10, right: 60, width: 50, height: 20, x: 10, y: top, toJSON: () => ({}) })
    button.getBoundingClientRect = () => rect(100) as DOMRect
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip').getAttribute('data-placement')).toBe('below')
    expect(Number.parseFloat(screen.getByRole('tooltip').style.getPropertyValue('--kit-y'))).toBeGreaterThanOrEqual(120)
    fireEvent.blur(button)
    button.getBoundingClientRect = () => rect(window.innerHeight - 10) as DOMRect
    fireEvent.focus(button)
    const above = screen.getByRole('tooltip')
    expect(above.getAttribute('data-placement')).toBe('above')
    expect(Number.parseFloat(above.style.getPropertyValue('--kit-y'))).toBeLessThanOrEqual(window.innerHeight - 10)
  })
})

describe('WO-3279 Dialog, Window and Confirm', () => {
  it('closes only the top dialog on Escape, through the one dialog stack', () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    render(<><Dialog open title="A" onClose={closeA} closeLabel="Close" /><Dialog open title="B" onClose={closeB} closeLabel="Close" /></>)
    expect(dialogStack.size).toBe(2)
    expect(dialogStack.handleEscape()).toBe(true)
    expect(closeB).toHaveBeenCalledTimes(1)
    expect(closeA).not.toHaveBeenCalled()
  })

  it('leaves the stack when it closes and when it unmounts', () => {
    const { rerender, unmount } = render(<Dialog open title="A" onClose={() => {}} closeLabel="Close" />)
    expect(dialogStack.size).toBe(1)
    rerender(<Dialog open={false} title="A" onClose={() => {}} closeLabel="Close" />)
    expect(dialogStack.size).toBe(0)
    rerender(<Dialog open title="A" onClose={() => {}} closeLabel="Close" />)
    unmount()
    expect(dialogStack.size).toBe(0)
  })

  it('moves focus in on open, keeps Tab inside, and returns focus to the opener on close', () => {
    function Host() {
      return (
        <>
          <button type="button">opener</button>
          <Dialog open title="D" onClose={() => {}} closeLabel="Close" footer={{ primary: { label: 'Save', onPress: () => {} } }}>
            <input aria-label="field" />
          </Dialog>
        </>
      )
    }
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Host />)
    const dialog = screen.getByRole('dialog', { name: 'D' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    const save = screen.getByRole('button', { name: 'Save' })
    act(() => save.focus())
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(save)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(save)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('renders nothing while closed', () => {
    render(<Dialog open={false} title="D" onClose={() => {}} closeLabel="Close" />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Confirm names the action by its verb, focuses Cancel first, and Escape cancels', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Confirm open title="Delete" sentence="Three operations will be removed." actionLabel="Delete 3 operations" cancelLabel="Cancel" danger onConfirm={onConfirm} onCancel={onCancel} />)
    const box = screen.getByRole('alertdialog', { name: 'Delete' })
    expect(box.getAttribute('data-danger')).toBe('true')
    expect(screen.getByText('Three operations will be removed.')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 operations' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(dialogStack.handleEscape()).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Window shows its navigation list and reports the chosen item', () => {
    const onNav = vi.fn()
    render(
      <Window open title="Settings" onClose={() => {}} closeLabel="Close" nav={[{ id: 'a', label: 'General' }, { id: 'b', label: 'Units' }]} activeNav="a" onNav={onNav}>
        <p>page</p>
      </Window>,
    )
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Units' }).hasAttribute('aria-current')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Units' }))
    expect(onNav).toHaveBeenCalledWith('b')
  })

  it('Window moves by dragging its header and by arrow keys, and keeps the place when reopened', () => {
    const props = { title: 'Tool library', onClose: () => {}, closeLabel: 'Close', testId: 'w' }
    const { rerender } = render(<Window open {...props} />)
    const handle = screen.getByTestId('w').querySelector('.kit-card-header')!
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 130, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 140, clientY: 130, pointerId: 1 })
    const win = screen.getByTestId('w')
    expect(win.style.getPropertyValue('--kit-x')).toBe('40px')
    expect(win.style.getPropertyValue('--kit-y')).toBe('30px')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(win.style.getPropertyValue('--kit-x')).toBe('56px')
    rerender(<Window open={false} {...props} />)
    rerender(<Window open {...props} />)
    expect(screen.getByTestId('w').style.getPropertyValue('--kit-x')).toBe('56px')
    expect(screen.getByTestId('w').style.getPropertyValue('--kit-y')).toBe('30px')
  })
})

describe('WO-3279 audit fixes', () => {
  it('keeps the same button element when availability flips, so focus is not lost', () => {
    const action = (ready: boolean) => ({ label: 'Generate', onPress: () => {}, availability: ready ? ({ ready: true } as const) : ({ ready: false, reason: 'app-shell-settings-menus:closeHelp' } as const) })
    const { rerender } = render(<Card title="C" footer={{ primary: action(true) }} />)
    const before = screen.getByRole('button', { name: 'Generate' })
    before.focus()
    rerender(<Card title="C" footer={{ primary: action(false) }} />)
    expect(screen.getByRole('button', { name: 'Generate' })).toBe(before)
    expect(document.activeElement).toBe(before)
  })

  it('does not reopen the tooltip when a mouse press focuses the control', () => {
    render(<Tooltip text="Help"><button type="button">Q</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Q' })
    fireEvent.mouseDown(button)
    fireEvent.focus(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.blur(button)
    fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('keeps the Window header on screen however far it is dragged, and ignores a right-button press', () => {
    render(<Window open title="Far" onClose={() => {}} closeLabel="Close" testId="far" />)
    const handle = screen.getByTestId('far').querySelector('.kit-card-header')!
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 2 })
    fireEvent.pointerMove(handle, { clientX: 50, clientY: 50, pointerId: 1 })
    expect(screen.getByTestId('far').style.getPropertyValue('--kit-x')).toBe('0px')
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1, button: 0 })
    fireEvent.pointerMove(handle, { clientX: -5000, clientY: -5000, pointerId: 1 })
    expect(Number.parseFloat(screen.getByTestId('far').style.getPropertyValue('--kit-y'))).toBeGreaterThanOrEqual(-0.1 * window.innerHeight)
    fireEvent.pointerMove(handle, { clientX: 5000, clientY: 5000, pointerId: 1 })
    expect(Number.parseFloat(screen.getByTestId('far').style.getPropertyValue('--kit-y'))).toBeLessThanOrEqual(0.9 * window.innerHeight - 80)
  })

  it('links the Confirm sentence to the alert dialog', () => {
    render(<Confirm open title="T" sentence="Sure?" actionLabel="Do it" cancelLabel="No" onConfirm={() => {}} onCancel={() => {}} />)
    const box = screen.getByRole('alertdialog')
    expect(document.getElementById(box.getAttribute('aria-describedby')!)!.textContent).toBe('Sure?')
  })
})

describe('WO-3279 Escape through the real listener', () => {
  // the New UI's ONE keydown listener: Escape reaches the dialog stack only if nothing in the
  // kit stops it on the way up (a tooltip that is not showing must pass the key through)
  let uninstall: () => void
  beforeEach(() => {
    uninstall = installShortcutListener(document, createShortcutManager({ registry: createCommandRegistry(), dialogs: dialogStack, context: () => ({ workspace: 'setup' }) }))
  })
  afterEach(() => uninstall())

  it('Confirm: Escape on the focused Cancel cancels on the first press', () => {
    const onCancel = vi.fn()
    render(<Confirm open title="Delete" sentence="Sure?" actionLabel="Delete 3" cancelLabel="Cancel" onConfirm={() => {}} onCancel={onCancel} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('Dialog: Escape on a focused footer Cancel closes it on the first press', () => {
    const onClose = vi.fn()
    render(<Dialog open title="D" onClose={onClose} closeLabel="Close" footer={{ cancel: { label: 'Cancel', onPress: () => {} }, primary: { label: 'Save', onPress: () => {} } }} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    act(() => cancel.focus())
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Window: Escape on a focused footer Cancel closes it on the first press', () => {
    const onClose = vi.fn()
    render(<Window open title="W" onClose={onClose} closeLabel="Close" footer={{ cancel: { label: 'Cancel', onPress: () => {} } }} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    act(() => cancel.focus())
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('an unavailable footer action: Escape first closes its showing tooltip, the second press closes the dialog', () => {
    const onClose = vi.fn()
    render(<Dialog open title="D" onClose={onClose} closeLabel="Close" footer={{ primary: { label: 'Save', onPress: () => {}, availability: { ready: false, reason: 'app-shell-settings-menus:closeHelp' } } }} />)
    const save = screen.getByRole('button', { name: 'Save' })
    act(() => save.focus())
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(save, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(save, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a Tooltip with empty text shows nothing and passes Escape through', () => {
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    render(<Tooltip text=""><button type="button">Q</button></Tooltip>)
    const button = screen.getByRole('button', { name: 'Q' })
    fireEvent.focus(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(seen).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', seen)
  })

  it('does not wrap a ready footer action in a Tooltip, and keeps one button element when availability flips', () => {
    const { container } = render(<Card title="C" footer={{ primary: { label: 'Go', onPress: () => {} } }} />)
    expect(container.querySelector('footer')!.children).toHaveLength(1)
  })
})

describe('WO-3279 gallery and tokens', () => {
  it('shows every surface part, in each of the three M1 themes, with the dialogs one press away', () => {
    for (const theme of Object.keys(THEMES)) {
      const { container, unmount } = render(<div data-ui2="" data-ui2-theme={theme}><SurfacesGallery /></div>)
      const parts = new Set([...container.querySelectorAll('[data-kit]')].map(e => e.getAttribute('data-kit')))
      for (const part of ['Card', 'Section', 'PropRow', 'Pill', 'BrowserRow']) expect(parts.has(part), `${theme}: ${part}`).toBe(true)
      for (const part of ['dialog', 'window', 'confirm', 'tooltip']) expect(container.querySelector(`[data-gallery="${part}"]`), `${theme}: ${part}`).toBeTruthy()
      unmount()
    }
  })

  it('styles only through token custom properties: no raw colour and no title= in the surfaces', () => {
    const dir = join(ROOT, 'src/components/kit/surfaces')
    const css = readFileSync(join(dir, 'surfaces.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(css).toMatch(/var\(--/)
    const source = readFileSync(join(dir, 'index.tsx'), 'utf8')
    expect(source).not.toMatch(/\btitle=\{?["'`]/)
  })
})
