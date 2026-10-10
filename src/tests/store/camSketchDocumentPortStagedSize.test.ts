// SKC-46: `camSketchDocumentPort.getLastStagedSize`/`setLastStagedSize` (src/store/index.ts) is
// CAM's real wiring of the SketchDocumentPort staged-size memory members (ports.ts) onto the
// `liencam-ui-prefs` persist surface (src/store/uiPrefs.ts) -- the same store the workbench's
// `workbenchSketchDocumentPort` wires to (src/tests/model3d/workbenchSketchMount.test.ts), which
// is what makes this a SHARED memory rather than two independent ones (sketcher parity).
//
// jsdom's own `localStorage` is not usable in this project's test setup (same quirk
// SolidsWorkbenchPage.cameraProjection.test.tsx works around), so this file installs the same
// in-memory Storage shim rather than relying on the (broken here) jsdom default.
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterAll } from 'vitest'

const uiPrefsMemory = new Map<string, string>()
const uiPrefsStorageShim: Storage = {
  get length() { return uiPrefsMemory.size },
  clear: () => uiPrefsMemory.clear(),
  getItem: (key) => uiPrefsMemory.get(key) ?? null,
  key: (index) => [...uiPrefsMemory.keys()][index] ?? null,
  removeItem: (key) => { uiPrefsMemory.delete(key) },
  setItem: (key, value) => { uiPrefsMemory.set(key, String(value)) },
}
const priorLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
Object.defineProperty(globalThis, 'localStorage', { value: uiPrefsStorageShim, configurable: true })
afterAll(() => {
  if (priorLocalStorage === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
  else Object.defineProperty(globalThis, 'localStorage', priorLocalStorage)
})

import { camSketchDocumentPort } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'

beforeEach(() => {
  uiPrefsMemory.clear()
  useUiPrefs.setState({ lastFilletRadius: null, lastChamferSetback: null })
})

describe('camSketchDocumentPort staged-size memory (SKC-46)', () => {
  it('defaults to null for both tools', () => {
    expect(camSketchDocumentPort.getLastStagedSize('fillet')).toBeNull()
    expect(camSketchDocumentPort.getLastStagedSize('chamfer')).toBeNull()
  })

  it('setLastStagedSize writes through to the shared uiPrefs store, per tool kind', () => {
    camSketchDocumentPort.setLastStagedSize('fillet', 9)
    expect(camSketchDocumentPort.getLastStagedSize('fillet')).toBe(9)
    expect(useUiPrefs.getState().lastFilletRadius).toBe(9)
    expect(camSketchDocumentPort.getLastStagedSize('chamfer')).toBeNull()

    camSketchDocumentPort.setLastStagedSize('chamfer', 2.5)
    expect(camSketchDocumentPort.getLastStagedSize('chamfer')).toBe(2.5)
    expect(camSketchDocumentPort.getLastStagedSize('fillet')).toBe(9) // unaffected
  })

  it('a write made through uiPrefs directly is visible through the port (one shared store)', () => {
    useUiPrefs.getState().setLastFilletRadius(4)
    expect(camSketchDocumentPort.getLastStagedSize('fillet')).toBe(4)
  })
})
