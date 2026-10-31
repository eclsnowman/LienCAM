// @vitest-environment jsdom
// The JOG panel header carries one icon toggle for the gamepad step (same
// switch Settings uses), and Settings > Gamepad confirms an Apply.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
})

const { JogPanel } = await import('../../components/machine/JogPanel')
const { GamepadJogSettings } = await import('../../components/machine/GamepadJogSettings')
const pads = await import('../../lib/machine/gamepadJogInput')
const { useUiPrefs } = await import('../../store/uiPrefs')

function mappedPrefs() {
  const p = pads.emptyGamepadJogPrefs('x')
  p.deadman = { kind: 'button', index: 7 }
  return p
}

beforeEach(() => {
  mem.clear()
  pads.useGamepadJogSession.setState({ enabled: false, phase: 'session-disabled', hold: 'disabled' })
})
afterEach(() => cleanup())

describe('JOG header gamepad toggle', () => {
  it('flips the session switch and reflects aria-pressed', () => {
    useUiPrefs.setState({ gamepadJog: mappedPrefs() })
    render(<JogPanel />)
    const btn = screen.getByTestId('control-jog-gamepad-toggle') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.getAttribute('data-tooltip')).toBe('Gamepad step off')
    fireEvent.click(btn)
    expect(pads.useGamepadJogSession.getState().enabled).toBe(true)
    expect(screen.getByTestId('control-jog-gamepad-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('control-jog-gamepad-toggle').getAttribute('data-tooltip')).toBe('Gamepad step on')
    fireEvent.click(screen.getByTestId('control-jog-gamepad-toggle'))
    expect(pads.useGamepadJogSession.getState().enabled).toBe(false)
  })

  it('is disabled, with the reason as its title, when no mapping is usable', () => {
    useUiPrefs.setState({ gamepadJog: null })
    const view = render(<JogPanel />)
    const btn = screen.getByTestId('control-jog-gamepad-toggle') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('data-tooltip')).toBe('Gamepad step: no deadman mapped')
    fireEvent.click(btn)
    expect(pads.useGamepadJogSession.getState().enabled).toBe(false)
    view.unmount()
    useUiPrefs.setState({ gamepadJog: { schemaVersion: 99 } as never })
    render(<JogPanel />)
    expect(screen.getByTestId('control-jog-gamepad-toggle').getAttribute('data-tooltip')).toBe('Gamepad step: settings unreadable')
  })
})

describe('Settings > Gamepad Apply', () => {
  it('confirms a saved mapping', () => {
    useUiPrefs.setState({ gamepadJog: null })
    render(<GamepadJogSettings provider={() => []} pollMs={20} />)
    expect(screen.queryByTestId('gamepad-jog-applied')).toBeNull()
    fireEvent.click(screen.getByTestId('gamepad-jog-apply'))
    expect(screen.getByTestId('gamepad-jog-applied').textContent).toBe('Gamepad mapping applied.')
    fireEvent.click(screen.getByTestId('gamepad-jog-reset'))
    expect(screen.queryByTestId('gamepad-jog-applied')).toBeNull()
  })
})
