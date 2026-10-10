// WO UI-23 (C4): the workbenchCameraProjection uiPrefs field -- persist,
// restore, and merge-guard behavior. Same in-memory localStorage shim +
// module-load-order requirement as src/tests/store/uiPrefs.test.ts (the
// persist middleware binds storage at import time, so the shim MUST be
// installed before the store module is imported) -- kept as a SEPARATE file
// in src/tests/model3d/** (this WO's own test ownership) rather than adding
// to the shared src/tests/store/uiPrefs.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = new Map<string, string>()
const mem = {
  get length() { return store.size },
  clear: () => store.clear(),
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
}
vi.stubGlobal('localStorage', mem)

import { useUiPrefs, UI_PREFS_STORAGE_KEY, UI_PREFS_VERSION } from '../../store/uiPrefs'

beforeEach(() => {
  mem.clear()
  useUiPrefs.setState({ workbenchCameraProjection: 'orthographic' })
})

describe('WO UI-23 (C4): workbenchCameraProjection persists across remount', () => {
  it('UI-34: the factory default is orthographic', () => {
    // getInitialState reads the persist config's factory result, not the value
    // beforeEach wrote into the live singleton. Reverting the source default
    // therefore makes this assertion fail.
    expect(useUiPrefs.getInitialState().workbenchCameraProjection).toBe('orthographic')
  })

  it('a deliberate perspective choice writes the current storage version', () => {
    useUiPrefs.getState().setWorkbenchCameraProjection('perspective')
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('perspective')
    const raw = mem.getItem(UI_PREFS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { state?: { workbenchCameraProjection?: string }; version?: number }
    expect(parsed.state?.workbenchCameraProjection).toBe('perspective')
    expect(parsed.version).toBe(UI_PREFS_VERSION)
  })

  it('UI-34 migration: a v0 default-era perspective value adopts orthographic once', async () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { workbenchCameraProjection: 'perspective', panelLeftWidth: 320 },
      version: 0,
    }))
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('orthographic')
    expect(useUiPrefs.getState().panelLeftWidth).toBe(320)

    // Zustand rewrites a successful migration. This is the one-time marker
    // that prevents later v1 Perspective choices from being clobbered.
    const rewritten = JSON.parse(mem.getItem(UI_PREFS_STORAGE_KEY)!) as {
      state?: { workbenchCameraProjection?: string }
      version?: number
    }
    expect(rewritten.version).toBe(UI_PREFS_VERSION)
    expect(rewritten.state?.workbenchCameraProjection).toBe('orthographic')
  })

  it('UI-34 non-regression: a current-v1 deliberate perspective choice is preserved', async () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { workbenchCameraProjection: 'perspective' },
      version: UI_PREFS_VERSION,
    }))
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('perspective')
  })

  it('merge guard: a current blob with NO projection field uses orthographic', async () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { panelLeftWidth: 280 },
      version: UI_PREFS_VERSION,
    }))
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('orthographic')
  })

  it('merge guard: a tampered current value falls back to orthographic', async () => {
    mem.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { workbenchCameraProjection: 'bogus' },
      version: UI_PREFS_VERSION,
    }))
    await useUiPrefs.persist.rehydrate()
    expect(useUiPrefs.getState().workbenchCameraProjection).toBe('orthographic')
  })
})
