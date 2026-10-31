// WO-3259: the gamepad step-jog preference is ONE versioned object in uiPrefs.
// It survives reload as stored; an older blob loads unmapped; an unknown
// version stays inactive (kept for its edit or reset); and nothing session-
// or device-slot-bound - Enable, the arm, a slot index, a sample - is written.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => { memory.set(k, String(v)) },
  removeItem: (k: string) => { memory.delete(k) },
  key: (i: number) => Array.from(memory.keys())[i] ?? null,
})

const { useUiPrefs, UI_PREFS_STORAGE_KEY, UI_PREFS_VERSION } = await import('../../store/uiPrefs')
const {
  emptyGamepadJogPrefs,
  readGamepadJogPrefs,
  useGamepadJogSession,
} = await import('../../lib/machine/gamepadJogInput')

function mapped() {
  return {
    ...emptyGamepadJogPrefs('Test Pad [4 axes, 17 buttons]'),
    mappings: {
      'X+': { kind: 'axis' as const, index: 0, sign: 1 as const },
      'X-': { kind: 'axis' as const, index: 0, sign: -1 as const },
      'Y+': { kind: 'axis' as const, index: 1, sign: -1 as const },
      'Y-': { kind: 'axis' as const, index: 1, sign: 1 as const },
      'Z+': { kind: 'button' as const, index: 4 },
      'Z-': { kind: 'button' as const, index: 5 },
    },
    deadman: { kind: 'button' as const, index: 7 },
    deadZone: 0.25,
    inverted: { X: false, Y: true, Z: false },
    speedScale: 0.5,
  }
}

function storedBlob(): Record<string, unknown> {
  return JSON.parse(memory.get(UI_PREFS_STORAGE_KEY) ?? '{}').state
}

async function reload(state: Record<string, unknown>): Promise<void> {
  // Clear the live value first: setState writes through to storage.
  useUiPrefs.setState({ gamepadJog: null })
  memory.set(UI_PREFS_STORAGE_KEY, JSON.stringify({ state, version: UI_PREFS_VERSION }))
  await useUiPrefs.persist.rehydrate()
}

beforeEach(() => {
  memory.clear()
  useUiPrefs.setState({ gamepadJog: null, machineJogContinuous: false, machineJogStepMm: 1, machineJogFeedMmMin: 1000 })
  useGamepadJogSession.setState({ enabled: false })
})

describe('WO-3259 gamepad jog preference', () => {
  it('Apply writes one versioned object that survives a reload unchanged', async () => {
    useUiPrefs.getState().setGamepadJog(mapped())
    const written = storedBlob().gamepadJog
    expect(written).toEqual(mapped())
    await reload(storedBlob())
    expect(readGamepadJogPrefs(useUiPrefs.getState().gamepadJog)).toEqual({ status: 'ok', prefs: mapped() })
  })

  it('never stores Enable, the arm, a slot index, a handle or a sample', () => {
    useGamepadJogSession.getState().setEnabled(true)
    useUiPrefs.getState().setGamepadJog(mapped())
    const written = storedBlob().gamepadJog as Record<string, unknown>
    expect(Object.keys(written).sort()).toEqual(
      ['deadZone', 'deadman', 'deviceFingerprint', 'inverted', 'mappings', 'schemaVersion', 'speedScale'])
    const text = JSON.stringify(storedBlob())
    expect(text).not.toMatch(/"enabled"|"armed"|"phase"|"timestamp"|"padIndex"/)
  })

  it('an older blob with no gamepad object loads unmapped', async () => {
    await reload({ machineJogStepMm: 1, machineJogFeedMmMin: 1000 })
    expect(useUiPrefs.getState().gamepadJog).toBeNull()
    expect(readGamepadJogPrefs(useUiPrefs.getState().gamepadJog)).toEqual({ status: 'unmapped' })
  })

  it('an unknown version is kept as stored but stays inactive until edited or reset', async () => {
    const future = { ...mapped(), schemaVersion: 9, extra: 'from a later build' }
    await reload({ gamepadJog: future })
    expect(useUiPrefs.getState().gamepadJog).toEqual(future)
    expect(readGamepadJogPrefs(useUiPrefs.getState().gamepadJog)).toEqual({ status: 'unreadable' })
    useUiPrefs.getState().setGamepadJog(null)
    expect(readGamepadJogPrefs(useUiPrefs.getState().gamepadJog)).toEqual({ status: 'unmapped' })
  })

  it('a tampered value loads as unmapped', async () => {
    await reload({ gamepadJog: 'oops' })
    expect(useUiPrefs.getState().gamepadJog).toBeNull()
    await reload({ gamepadJog: [1, 2] })
    expect(useUiPrefs.getState().gamepadJog).toBeNull()
  })

  it('leaves the pointer/phone jog preferences alone', () => {
    useUiPrefs.setState({ machineJogContinuous: true, machineJogStepMm: 25.4, machineJogFeedMmMin: 800 })
    useUiPrefs.getState().setGamepadJog(mapped())
    useUiPrefs.getState().setGamepadJog(null)
    const s = useUiPrefs.getState()
    expect([s.machineJogContinuous, s.machineJogStepMm, s.machineJogFeedMmMin]).toEqual([true, 25.4, 800])
  })
})
