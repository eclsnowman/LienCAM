// @vitest-environment jsdom
//
// WO INT-13C, Work item 4 / AC2 + AC6 -- MIRROR-DEFECT FACE (b).
//
// THE TRAP THIS IS: face (b) is what ships if TopToolbar gets its `workspace === 'cam'` guard
// but the Part capture listener is left MOUNT-scoped. INT-13A made the Part host retained --
// hidden on switch, never unmounted -- so a listener scoped to mountedness keeps claiming
// Ctrl+Z forever. Verbatim from the spec (5.1, lines 1135-1143): under a retained mount the
// capture listener "would hijack Ctrl+Z while the user is in the CAM workspace ... and
// TopToolbar's guards would dutifully stand down. CAM project undo would become unreachable by
// keyboard for the rest of the session."
//
// THE NAMED MUTATION THIS FAILS ON (coordination/evidence/INT-13C/mutation-faceB-suspend/):
// key the capture-listener registration effect on [] instead of on `suspended` (i.e. leave it
// mount-scoped, the pre-INT-13C behaviour). Both tests below go RED.
//
// TWO ASSERTIONS, DELIBERATELY: the first is BEHAVIOURAL (the right history fires), the second
// is STRUCTURAL (no capture listener is attached at all). The structural one is what makes this
// D5.2 rather than "D5.2's observable shadow": an implementation that kept the listener and
// early-returned on a flag would pass the behavioural test and FAIL the structural one, which
// is precisely the distinction the spec draws ("a suspended host has no listener at all, not a
// listener that checks a flag") and charter rule 5 warns about.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  bootCoMount, installCamHistorySpies, installCaptureListenerProbe, mintWorkbenchSketch,
  workbenchSketchPresent, pressUndo, switchToCam, switchToPart, settle, type CaptureListenerProbe,
} from './int13cHarness'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { __resetPartWorkspaceHistory } from '../../lib/workspace/activeWorkspaceHistory'

/** See the identical block in INT-13C.mirrorDefect.faceA.test.tsx for why this must be
 *  vi.hoisted and cannot be shared from the harness module. */
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
let probe: CaptureListenerProbe | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useCamStore.getState().newProject()
  useCamStore.getState().setWorkspace('part')
})
afterEach(() => {
  probe?.uninstall()
  probe = null
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  useCamStore.setState({ workspace: 'cam' })
})

describe('INT-13C mirror defect, face (b): a suspended Part host must own no keyboard', () => {
  it('AC6 - with the Part workspace suspended, Ctrl+Z fires CAM project undo and NOT the workbench history', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    expect(workbenchSketchPresent()).toBe(true)

    switchToCam() // the operator leaves Part Studio; the host stays MOUNTED (INT-13A, D1)

    pressUndo()
    await settle() // the workbench's undo resync is async -- give a WRONG undo time to land

    // CAM project undo is reachable by keyboard -- the exact thing spec 5.1 says would be lost
    // "for the rest of the session" if the retained mount kept claiming the chord.
    expect(spies.camUndo).toHaveBeenCalledTimes(1)
    // ...and the suspended workspace's history is UNTOUCHED: the minted command is still applied.
    expect(workbenchSketchPresent()).toBe(true)
  }, 40_000)

  it('AC2 - with the Part workspace suspended, NO capture-phase keydown listener is attached (structural)', async () => {
    // Installed BEFORE the mount so the page's own registration is counted.
    probe = installCaptureListenerProbe()
    installCamHistorySpies()
    await bootCoMount()

    // Non-vacuity, inline: the probe must be able to SEE the listener when the host is active,
    // or "zero when suspended" would be trivially true and would prove nothing at all.
    expect(probe.captureKeydownCount()).toBe(1)

    switchToCam()

    // D5.2: not a listener that checks a flag -- no listener.
    expect(probe.captureKeydownCount()).toBe(0)
  }, 40_000)

  it('AC2 - resuming the Part workspace re-acquires exactly ONE capture listener, not two', async () => {
    probe = installCaptureListenerProbe()
    installCamHistorySpies()
    await bootCoMount()
    expect(probe.captureKeydownCount()).toBe(1)

    // A full round trip: the cleanup tail (charter rule 5) is where double-registration hides.
    // A resume that re-added without the release having removed would leave two owners and
    // double-undo one keystroke -- invisible to any test that only asserts "at least one".
    switchToCam()
    expect(probe.captureKeydownCount()).toBe(0)
    switchToPart()
    expect(probe.captureKeydownCount()).toBe(1)
    switchToCam()
    expect(probe.captureKeydownCount()).toBe(0)
    switchToPart()
    expect(probe.captureKeydownCount()).toBe(1)
  }, 40_000)
})
