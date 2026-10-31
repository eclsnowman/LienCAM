// @vitest-environment jsdom
//
// WO-3275 (UI M2 Wave 0): the component kit contract. Every part of standard 1 is exported from
// the one kit barrel, the barrel re-exports only the three part folders (so no Wave 1 lane edits
// a shared file), the four action kinds exist, and a Button without a kind is refused (standard 3).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as kit from '../../components/kit'
import type { ButtonProps } from '../../components/kit'
import { dialogStack } from '../../commands'

const ROOT = join(__dirname, '..', '..', '..')
afterEach(cleanup)

describe('WO-3275 kit contract', () => {
  it('names the four action kinds of spec 7.1', () => {
    expect([...kit.ACTION_KINDS]).toEqual(['momentary', 'latched', 'choice', 'transport'])
    expect(kit.isActionKind('latched')).toBe(true)
    expect(kit.isActionKind('toggle')).toBe(false)
  })

  it('exports every part standard 1 names from the one barrel', () => {
    expect(kit.KIT_PARTS).toHaveLength(22)
    const missing = kit.KIT_PARTS.filter(name => typeof (kit as Record<string, unknown>)[name] !== 'function')
    expect(missing).toEqual([])
  })

  it('keeps the barrel to the contract and the three part folders', () => {
    const barrel = readFileSync(join(ROOT, 'src/components/kit/index.ts'), 'utf8')
    const specs = [...barrel.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
    expect(specs).toEqual(['./types', './inputs', './surfaces', './actions', '../../notices/Notice'])
  })

  it('refuses a Button without a kind, naming the four kinds', () => {
    const untyped = { label: 'Generate', onPress: () => {} } as unknown as ButtonProps
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<kit.Button {...untyped} />)).toThrow(/needs kind: momentary, latched, choice or transport/)
    const wrong = { label: 'Generate', kind: 'toggle', onPress: () => {} } as unknown as ButtonProps
    expect(() => render(<kit.Button {...wrong} />)).toThrow(/needs kind/)
    vi.restoreAllMocks()
  })

  it('renders each kind with its own state: latched carries a lamp, choice its selection', () => {
    const onToggle = vi.fn()
    render(
      <>
        <kit.Button kind="momentary" label="Step" onPress={() => {}} testId="m" />
        <kit.Button kind="latched" label="Coolant" on={false} onToggle={onToggle} testId="l" />
        <kit.Button kind="choice" label="1 mm" selected onSelect={() => {}} testId="c" />
        <kit.Button kind="transport" transport="hold" label="Feed hold" active onPress={() => {}} testId="t" />
      </>,
    )
    expect(screen.getByTestId('m').dataset.kind).toBe('momentary')
    const latched = screen.getByTestId('l')
    expect(latched.dataset.kind).toBe('latched')
    expect(latched.querySelector('.kit-lamp')?.getAttribute('data-lit')).toBe('false')
    fireEvent.click(latched)
    expect(onToggle).toHaveBeenCalledWith(true)
    expect(screen.getByTestId('c').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('t').dataset.transport).toBe('hold')
    expect(screen.getByTestId('t').dataset.on).toBe('true')
  })

  it('a press-and-hold button starts and ends from the keyboard as well as the pointer', () => {
    const onPress = vi.fn(), onRelease = vi.fn()
    render(<kit.Button kind="momentary" label="X+" onPress={onPress} onRelease={onRelease} testId="jog" />)
    const jog = screen.getByTestId('jog')
    fireEvent.keyDown(jog, { key: ' ' })
    fireEvent.keyUp(jog, { key: ' ' })
    fireEvent.pointerDown(jog)
    fireEvent.pointerUp(jog)
    expect(onPress).toHaveBeenCalledTimes(2)
    expect(onRelease).toHaveBeenCalledTimes(2)
  })

  it('Escape reaches the newest dialog even after an older one re-renders', () => {
    const closeA = vi.fn(), closeB = vi.fn()
    // A gets a new inline onClose on every render; B keeps one
    const view = (n: number) => (
      <>
        <kit.Dialog open title="A" closeLabel="Close" onClose={() => closeA(n)} />
        <kit.Dialog open title="B" closeLabel="Close" onClose={closeB} />
      </>
    )
    const r = render(view(0))
    r.rerender(view(1))
    expect(dialogStack.handleEscape()).toBe(true)
    expect(closeB).toHaveBeenCalledOnce()
    expect(closeA).not.toHaveBeenCalled()
  })

  it('an unavailable button does nothing when pressed', () => {
    const onPress = vi.fn()
    render(
      <kit.Button
        kind="momentary"
        label="Generate"
        onPress={onPress}
        availability={{ ready: false, reason: 'app-shell-settings-menus:App.noGeometryLoaded' }}
        testId="u"
      />,
    )
    fireEvent.click(screen.getByTestId('u'))
    expect(onPress).not.toHaveBeenCalled()
    expect(screen.getByTestId('u').dataset.unavailable).toBe('true')
  })
})
