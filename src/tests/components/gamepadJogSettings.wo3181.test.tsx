// @vitest-environment jsdom
// WO-3259: Settings -> Gamepad step. Discover an observed pad through the
// injectable snapshot provider, capture raw buttons/axes for the six
// directions and a distinct deadman, invert, preview with NO motion, Apply,
// and the session-only Enable. Also: the Jog panel says "Gamepad step" while
// the pad is enabled even when its pointer mode is Continuous.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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

const { GamepadJogSettings } = await import('../../components/machine/GamepadJogSettings')
const { JogPanel } = await import('../../components/machine/JogPanel')
const pads = await import('../../lib/machine/gamepadJogInput')
const { useUiPrefs, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')
const { getMachineController } = await import('../../lib/machine/machineSession')

type GamepadSnapshot = import('../../lib/machine/gamepadJogInput').GamepadSnapshot

const PAD_ID = 'Desk Pad (STANDARD GAMEPAD)'
let axes = [0, 0, 0, 0]
let pressed = new Set<number>()
let stamp = 0

function snapshot(): GamepadSnapshot {
  return {
    id: PAD_ID,
    index: 2,
    connected: true,
    timestamp: stamp,
    axes: [...axes],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.has(i), value: pressed.has(i) ? 1 : 0 })),
  }
}

const provider = () => [null, null, snapshot()]

async function padTo(change: { axes?: number[]; press?: number[] }): Promise<void> {
  if (change.axes) axes = change.axes
  if (change.press) pressed = new Set(change.press)
  stamp += 1
  await act(async () => { await vi.advanceTimersByTimeAsync(60) })
}

async function capture(slot: string, change: { axes?: number[]; press?: number[] }): Promise<void> {
  fireEvent.click(screen.getByTestId(`gamepad-jog-capture-${slot}`))
  await padTo({})
  await padTo(change)
  await padTo({ axes: [0, 0, 0, 0], press: [] })
}

let motion: ReturnType<typeof vi.spyOn>[] = []

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  axes = [0, 0, 0, 0]
  pressed = new Set()
  useUiPrefs.setState({ gamepadJog: null, machineJogContinuous: false })
  pads.useGamepadJogSession.setState({ enabled: false, phase: 'session-disabled', hold: 'disabled' })
  const ctrl = getMachineController() as unknown as Record<string, (...args: never[]) => unknown>
  motion = ['jog', 'jogCancel', 'jogStartContinuous', 'jogHold', 'jogStop']
    .filter((name) => typeof ctrl[name] === 'function')
    .map((name) => vi.spyOn(ctrl, name as never))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WO-3259 Settings -> Gamepad step', () => {
  it('maps, previews without motion and applies one versioned object (no slot index)', async () => {
    render(<GamepadJogSettings provider={provider} pollMs={20} />)
    await padTo({})
    expect(screen.getByTestId('gamepad-jog-pad').textContent).toContain(PAD_ID)

    await capture('X+', { axes: [0.9, 0, 0, 0] })
    await capture('X-', { axes: [-0.9, 0, 0, 0] })
    await capture('Y+', { axes: [0, -0.9, 0, 0] })
    await capture('Y-', { axes: [0, 0.9, 0, 0] })
    await capture('Z+', { press: [4] })
    await capture('Z-', { press: [5] })
    await capture('deadman', { press: [7] })
    expect(screen.getByTestId('gamepad-jog-map-X+').textContent).toBe('Axis 0 +')
    expect(screen.getByTestId('gamepad-jog-map-Y+').textContent).toBe('Axis 1 -')
    expect(screen.getByTestId('gamepad-jog-map-Z-').textContent).toBe('Button 5')
    expect(screen.getByTestId('gamepad-jog-map-deadman').textContent).toBe('Button 7')

    // Live preview: the dead zone, inversion and the deadman, and nothing moves.
    await padTo({ axes: [0.6, 0, 0, 0], press: [7] })
    expect(screen.getByTestId('gamepad-jog-preview-motion').textContent).toBe('Would step X+')
    expect(screen.getByTestId('gamepad-jog-preview-deadman').textContent).toBe('Deadman: held')
    fireEvent.click(screen.getByTestId('gamepad-jog-invert-X'))
    await padTo({})
    expect(screen.getByTestId('gamepad-jog-preview-motion').textContent).toBe('Would step X-')
    await padTo({ axes: [0.15, 0, 0, 0], press: [] })
    expect(screen.getByTestId('gamepad-jog-preview-motion').textContent).toBe('At rest')
    await padTo({ axes: [0.9, 0, 0, 0], press: [4] })
    expect(screen.getByTestId('gamepad-jog-preview-motion').textContent).toBe('Two directions at once - no step')
    for (const spy of motion) expect(spy).not.toHaveBeenCalled()

    expect(useUiPrefs.getState().gamepadJog).toBeNull()
    fireEvent.click(screen.getByTestId('gamepad-jog-apply'))
    const applied = useUiPrefs.getState().gamepadJog!
    expect(pads.readGamepadJogPrefs(applied)).toEqual({ status: 'ok', prefs: applied })
    expect(applied.deviceFingerprint).toBe(pads.gamepadFingerprint(snapshot()))
    expect(applied.inverted).toEqual({ X: true, Y: false, Z: false })
    expect(applied.deadman).toEqual({ kind: 'button', index: 7 })
    expect(JSON.stringify(JSON.parse(mem.get(UI_PREFS_STORAGE_KEY)!).state.gamepadJog)).not.toMatch(/"index":2\b|slot|enabled/)
    for (const spy of motion) expect(spy).not.toHaveBeenCalled()
  })

  it('shows the mapping again after a reload (a fresh mount reads the stored object)', async () => {
    const view = render(<GamepadJogSettings provider={provider} pollMs={20} />)
    await padTo({})
    await capture('X+', { axes: [0.9, 0, 0, 0] })
    await capture('deadman', { press: [7] })
    fireEvent.click(screen.getByTestId('gamepad-jog-apply'))
    view.unmount()
    render(<GamepadJogSettings provider={provider} pollMs={20} />)
    await padTo({})
    expect(screen.getByTestId('gamepad-jog-map-X+').textContent).toBe('Axis 0 +')
    expect(screen.getByTestId('gamepad-jog-map-deadman').textContent).toBe('Button 7')
  })

  it('a deadman that is also a direction is not applied, and says which', async () => {
    render(<GamepadJogSettings provider={provider} pollMs={20} />)
    await padTo({})
    await capture('Z+', { press: [4] })
    await capture('deadman', { press: [4] })
    fireEvent.click(screen.getByTestId('gamepad-jog-apply'))
    expect(screen.getByTestId('gamepad-jog-clash').textContent).toContain('Z+')
    expect(useUiPrefs.getState().gamepadJog).toBeNull()
  })

  it('an unknown saved version stays inactive with one edit/reset sentence; Reset clears it', async () => {
    useUiPrefs.setState({ gamepadJog: { ...pads.emptyGamepadJogPrefs(), schemaVersion: 7 as never } })
    render(<GamepadJogSettings provider={provider} pollMs={20} />)
    await padTo({})
    expect(screen.getByTestId('gamepad-jog-unreadable').textContent).toMatch(/Edit and Apply, or Reset/)
    fireEvent.click(screen.getByTestId('gamepad-jog-reset'))
    expect(useUiPrefs.getState().gamepadJog).toBeNull()
    expect(screen.queryByTestId('gamepad-jog-unreadable')).toBeNull()
  })

  it('says so when no pad has been seen', async () => {
    render(<GamepadJogSettings provider={() => []} pollMs={20} />)
    await padTo({})
    expect(screen.getByTestId('gamepad-jog-no-pads')).toBeTruthy()
    expect((screen.getByTestId('gamepad-jog-capture-X+') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Enable is session-only: it is never written to the stored preferences', async () => {
    render(<GamepadJogSettings provider={provider} pollMs={20} />)
    fireEvent.click(screen.getByTestId('gamepad-jog-enable'))
    expect(pads.useGamepadJogSession.getState().enabled).toBe(true)
    useUiPrefs.getState().setGamepadJog(pads.emptyGamepadJogPrefs())
    expect(mem.get(UI_PREFS_STORAGE_KEY)).not.toMatch(/"enabled"/)
  })
})

describe('WO-3259 the Jog panel names the pad as a step input', () => {
  it('says "Gamepad step" while enabled, in Continuous too; nothing while off', () => {
    useUiPrefs.setState({ machineJogContinuous: true })
    render(<JogPanel />)
    expect(screen.queryByTestId('control-jog-gamepad-status')).toBeNull()
    act(() => { pads.useGamepadJogSession.setState({ enabled: true, phase: 'ready', hold: null }) })
    expect(screen.getByTestId('control-jog-gamepad-status').textContent).toBe('Gamepad step: hold the deadman')
    act(() => { pads.useGamepadJogSession.setState({ phase: 'armed', hold: null }) })
    expect(screen.getByTestId('control-jog-gamepad-status').textContent).toBe('Gamepad step: armed')
    expect(useUiPrefs.getState().machineJogContinuous).toBe(true)
  })
})
