// @vitest-environment jsdom
//
// WO SKC-5-R1 Finding 1 (BLOCKER, audit verbatim): "Q6's app-wide
// navigation-preset requirement is not implemented... the new sketch camera
// surface still constructs raw OrbitControls directly and never applies the
// existing NAV_PRESETS/app-settings path." REQUIRED: thread appSettings'
// navPreset/invertZoom/invertPan into the model3d scene runtime by SHARING
// CNCViewport's own preset-application logic (BK-26 one-coherent-feel) --
// see src/lib/viewport/navPresetController.ts, the engine both
// CNCViewport.applyNavPreset and sceneRuntime.ts's SceneRuntime.applyNavPreset
// now delegate to.
//
// This is the no-regress test AC #1 requires: change appSettings.navPreset
// (the REAL NAV_PRESETS table via the REAL store setter, not a hand-rolled
// fixture) and prove the workbench's scene runtime receives the SAME preset,
// both at rest and while sketch mode is active (jsdom has no real
// OrbitControls.mouseButtons effect to read back against -- same fake-runtime
// call-log seam every other camera/nav test in this suite already uses, see
// fakeSceneRuntime.ts's navPresetCalls).

// WO SKC-15C (THE SEVERING) -- why `workbench-finish-package-sketch` and not `workbench-finish-sketch`:
// this file used to drive the INLINE sketch session, whose Finish button carried the latter testid.
// Sketch-on-face now enters THE Sketcher package session, whose Finish carries the former. The old id
// no longer exists in the page AT ALL, deliberately: a stale caller reaching for it goes red rather
// than silently driving a different sketcher. Nothing else in this file's assertions changed.
// WO SKC-15C: sketch-on-face now opens THE Sketcher package session, whose constraint badges need a
// 2D canvas context jsdom does not have. See stubCanvas2d.ts -- environment gap, nothing asserted on.
import { stubCanvas2d } from './stubCanvas2d'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { NAV_PRESETS, type NavPresetId } from '../../types'
import { mintRectangleSketch } from './mintRectangleSketch'

// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (SettingsModal.
// smoke.test.tsx's own established pattern -- see its header comment). Pure
// test scaffolding; no app change.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { createLocalGeomService } = await import('../../geom')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => { restoreCanvas2d = stubCanvas2d() })
afterEach(() => { restoreCanvas2d?.(); restoreCanvas2d = null })

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

function hooks(): SolidsWorkbenchHooks {
  const h = window.__solidsWorkbenchHooks
  if (h === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return h
}

// Snapshot + restore the app-wide setting so this test doesn't bleed into
// any sibling test file sharing the same store singleton (appSettings.test.ts's
// own established pattern).
const state = () => useCamStore.getState()
let savedNavPreset: NavPresetId
let savedInvertZoom: boolean
let savedInvertPan: boolean
beforeEach(() => {
  savedNavPreset = state().appSettings.navPreset
  savedInvertZoom = state().appSettings.invertZoom
  savedInvertPan = state().appSettings.invertPan
})
afterEach(() => {
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, navPreset: savedNavPreset, invertZoom: savedInvertZoom, invertPan: savedInvertPan },
  }))
})

describe('SolidsWorkbenchPage: nav-preset routing (WO SKC-5-R1 Finding 1, AC #1)', () => {
  it('changing appSettings.navPreset re-applies the REAL NAV_PRESETS mapping to the workbench scene runtime, at rest and during sketch mode', async () => {
    let capturedRuntime: FakeSceneRuntime | null = null
    const captureSceneRuntime: CreateSceneRuntime = () => {
      const rt = createFakeSceneRuntime()
      capturedRuntime = rt
      return rt
    }
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={captureSceneRuntime} />)
    const runtime = () => capturedRuntime as unknown as FakeSceneRuntime
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })

    // --- At rest: mount applies the store's CURRENT preset -----------------
    await waitFor(() => expect(runtime().navPresetCalls.length).toBeGreaterThan(0))
    expect(runtime().navPresetCalls.at(-1)).toEqual({ presetId: 'liencnc-default', invertZoom: false, invertPan: false })

    // Changing the app-wide preset (the SAME setter Settings uses) re-applies
    // through the workbench's scene runtime -- via the REAL NAV_PRESETS
    // table (asserted below), never a second/forked mapping.
    expect(NAV_PRESETS.onshape).toBeDefined()
    state().setNavPreset('onshape')
    await waitFor(() => expect(runtime().navPresetCalls.at(-1)?.presetId).toBe('onshape'))

    // --- Build a real body, enter sketch mode (face pick) -------------------
    await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('workbench-extrude'))
    commitField('extrude-distance', '20')
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })

    runtime().rayOverride = { origin: { x: 30, y: 10, z: 1000 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('feature-row-datum:SK2')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('workbench-finish-package-sketch')).toBeTruthy() // sketch mode is active

    // --- While sketch mode is active: the mapping STILL follows -----------
    state().setInvertZoom(true)
    await waitFor(() =>
      expect(runtime().navPresetCalls.at(-1)).toEqual({ presetId: 'onshape', invertZoom: true, invertPan: false }),
    )

    fireEvent.click(screen.getByTestId('workbench-finish-package-sketch'))
  }, 40_000)
})
