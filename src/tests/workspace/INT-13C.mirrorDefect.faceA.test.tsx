// @vitest-environment jsdom
//
// WO INT-13C, Work item 4 / AC5 -- MIRROR-DEFECT FACE (a).
//
// THE TRAP THIS IS: face (a) is what ships if the Part capture listener is re-scoped to the
// active workspace WITHOUT guarding TopToolbar. D5.2 removes the workbench's capture listener
// while the Part workspace is suspended -- and TopToolbar's bubble listener was, before this
// WO, "globally registered regardless of what is on screen, relying entirely on the workbench
// to stop it" (spec 5.3). Take the workbench's listener away on suspend and nothing stops
// TopToolbar firing CAM project undo while the operator is in Part Studio. Verbatim from the
// spec (lines 1177-1183): "This is a defect that D5.2 would otherwise INTRODUCE, which is why
// both changes ship in the same stage (INT-13C)."
//
// THE NAMED MUTATION THIS FAILS ON (coordination/evidence/INT-13C/mutation-faceA-guard/):
// delete the `workspace !== 'cam'` guard from TopToolbar's bubble listener (revert to
// always-claim). This file goes RED; the census stays green, which is exactly why this test
// has to exist as well as the census.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  bootCoMount, bootCamChromeOnly, installCamHistorySpies, mintWorkbenchSketch, workbenchSketchPresent,
  pressUndo, switchToPart, switchToCam, settle,
} from './int13cHarness'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { __resetPartWorkspaceHistory } from '../../lib/workspace/activeWorkspaceHistory'

/** The cam store is persist()-wrapped with createJSONStorage(() => localStorage), resolved ONCE
 *  when the store module initializes -- and this runtime's localStorage.setItem throws. The shim
 *  must therefore be installed BEFORE the store module is imported anywhere in this file's
 *  module graph, which is what vi.hoisted() is for (a beforeEach is far too late: every
 *  store-writing action throws "storage.setItem is not a function"). Inlined here rather than
 *  shared from the harness for a mechanical reason: vi.hoisted runs before this file's imports
 *  are evaluated, so it is the only place that can beat the store's own module init. Same
 *  pattern, same reason, as INT-13B's suspendResume test (:44-52). */
vi.hoisted(() => {
  const m = new Map<string, string>()
  const memStorage: Storage = {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
})

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useCamStore.getState().newProject()
  useCamStore.getState().setWorkspace('part')
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  // The store is module-level: leave the axis at its default or the next file inherits a Part
  // workspace and boots its own hosts suspended.
  useCamStore.setState({ workspace: 'cam' })
})

describe('INT-13C mirror defect, face (a): TopToolbar must not fire CAM undo in the Part workspace', () => {
  // THE CAN-FAIL TEST FOR AC5. It must come in this shape -- Part workspace ACTIVE, Part host
  // NOT mounted -- because it is the only shape in which the guard is REACHABLE. With the Part
  // host mounted, its capture listener claims the chord and stopImmediatePropagation's
  // TopToolbar away before the guard is ever consulted, so a test that mounts the host passes
  // identically with the guard deleted. That is not a hypothesis: the first mutation run
  // deleted the guard and every test below still passed (the RED-run log for that attempt is
  // kept in mutation-faceA-guard/ as the reason this test exists).
  //
  // The state is real, not invented for the test: SolidsWorkbenchPage is React.lazy behind a
  // <Suspense> and mounts only on FIRST entry to the Part workspace (App.tsx:281-292), while
  // the Part tab sets workspace='part' synchronously. Every first entry to Part Studio passes
  // through a window where the workspace is active and no history owner exists yet.
  it('AC5 - Part workspace active with the lazy host not yet mounted: Ctrl+Z fires NOTHING, not CAM undo', () => {
    const spies = installCamHistorySpies()
    bootCamChromeOnly() // workspace='part', no Part host -- the lazy-mount window

    pressUndo()

    // The guard is the ONLY thing between this keystroke and a CAM project undo fired from the
    // Model workspace. Delete it (mutation-faceA-guard) and this line goes RED.
    expect(spies.camUndo).not.toHaveBeenCalled()
    expect(spies.camRedo).not.toHaveBeenCalled()
  })

  it('AC5 - the same keystroke in the CAM workspace DOES fire CAM undo (non-vacuity of the guard)', () => {
    // Without this, "camUndo was not called" could be true because the harness never wires
    // camUndo at all. Same mount, same keystroke, one field different.
    const spies = installCamHistorySpies()
    bootCamChromeOnly()
    switchToCam()

    pressUndo()

    expect(spies.camUndo).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+Z with workspace=part fires the WORKBENCH history and NOT CAM project undo', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToPart() // explicit: the workspace under test, not an inherited default
    expect(workbenchSketchPresent()).toBe(true)

    pressUndo()
    await settle()

    // The workbench history undid the minted command...
    expect(workbenchSketchPresent()).toBe(false)
    // ...and CAM project undo never fired. NOT the can-fail assertion for AC5 (the two tests
    // above are): with the host mounted, what stops TopToolbar here is rule 2's
    // stopImmediatePropagation, not rule 3's guard -- proven by the mutation run, which left
    // this test green with the guard deleted. It is still worth pinning as the ordinary,
    // overwhelmingly common path: the operator in Part Studio with the host up.
    expect(spies.camUndo).not.toHaveBeenCalled()
    expect(spies.camRedo).not.toHaveBeenCalled()
  }, 40_000)

  it('the chord is CLAIMED in the Part workspace, so nothing downstream can act on it', async () => {
    installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToPart()

    const ev = pressUndo()

    // Rule 2 yields by preventDefault + stopImmediatePropagation. defaultPrevented is the
    // order-independent net TopToolbar's own comment relies on; asserting it here means face
    // (a) stays closed even for a future bubble listener that checks only defaultPrevented.
    expect(ev.defaultPrevented).toBe(true)
  }, 40_000)
})
