// @vitest-environment jsdom
//
// WO INT-13C, Work item 3 / AC3 + AC4 + AC7 -- CONSTRUCTED INTERLEAVE TESTS for the
// focus/ownership transitions.
//
// Charter rule 4 and the WO's own Standing law: ownership-transition claims are settled by a
// CONSTRUCTED interleave test, never by event-loop reasoning. So every transition below is
// actually driven -- through the real setWorkspace action, against the real co-mounted
// listeners -- and asserts WHICH owner fired, not that an ordering "cannot happen".
//
// The five families (four from Work item 3, the fifth added by preflight amendment 4):
//   1. cam -> part -> cam round trip
//   2. a dialog/modal open in each workspace
//   3. sketch mode in the Part workspace AND in the CAM workspace
//   4. text-input focus in each workspace (D5.3 rule 1)
//   5. a CAM modal left OPEN across a switch (amendment 4)
//
// AC7 (the Undo BUTTON and Ctrl+Z resolve to the same history) rides here too, because it is
// the same question asked of a different input device.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  bootCoMount, installCamHistorySpies, installCamRegenSpies, installCaptureListenerProbe,
  mintWorkbenchSketch, workbenchSketchPresent, pressUndo, pressKey, switchToCam, switchToPart,
  settle, armedSketchTool, mountRealSketcher,
  type RealSketcherMount, type CaptureListenerProbe,
} from './int13cHarness'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { enterBasePlaneSketchViaPick } from '../model3d/enterBasePlaneSketch'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { __resetPartWorkspaceHistory } from '../../lib/workspace/activeWorkspaceHistory'
import { getByTooltip } from '../support/tooltipQuery'

/** See INT-13C.mirrorDefect.faceA.test.tsx for why this must be vi.hoisted. */
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
let sketcherMount: RealSketcherMount | null = null
let captureProbe: CaptureListenerProbe | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useCamStore.getState().newProject()
  useCamStore.getState().setWorkspace('part')
})
afterEach(() => {
  captureProbe?.uninstall()
  captureProbe = null
  sketcherMount?.dispose()
  sketcherMount = null
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  __resetPartWorkspaceHistory()
  useUiPrefs.setState({ workbenchHiddenGenesisIds: [] })
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

// ---------------------------------------------------------------------------------------
// FAMILY 1 -- the round trip
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 1: cam -> part -> cam round trip', () => {
  it('Ctrl+Z resolves to the ACTIVE workspace at each leg, and the SUSPENDED one is untouched', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    // LEG 1 -- CAM active. The Part host is mounted-but-suspended the whole time.
    switchToCam()
    pressUndo()
    await settle()
    expect(spies.camUndo).toHaveBeenCalledTimes(1)
    expect(workbenchSketchPresent()).toBe(true) // the suspended workspace's history is untouched

    // LEG 2 -- Part active. Same chord, different owner. This is the leg that proves the test
    // is measuring ownership rather than just "undo happened": nothing about the keystroke
    // changed between legs, only which workspace is active.
    switchToPart()
    pressUndo()
    await settle()
    expect(spies.camUndo).toHaveBeenCalledTimes(1) // still 1 -- CAM's history did NOT move
    expect(workbenchSketchPresent()).toBe(false)   // the workbench's history DID

    // LEG 3 -- back to CAM. Ownership must RETURN, not stay wherever it last was.
    switchToCam()
    pressUndo()
    await settle()
    expect(spies.camUndo).toHaveBeenCalledTimes(2)
  }, 40_000)

  it('proves BOTH re-scope directions in one run: neither owner ever fires in the other workspace', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    // Four crossings. A one-way fix (either face of the mirror defect) breaks this: face (a)
    // fires camUndo on the part legs, face (b) eats the chord on the cam legs so camUndo never
    // moves at all.
    for (const leg of ['cam', 'part', 'cam', 'part'] as const) {
      if (leg === 'cam') switchToCam()
      else switchToPart()
      const camCallsBefore = spies.camUndo.mock.calls.length
      pressUndo()
      await settle()
      const camFired = spies.camUndo.mock.calls.length > camCallsBefore
      expect(camFired).toBe(leg === 'cam')
    }
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// FAMILY 1b -- a keystroke that RACES the suspend/resume transition (constructed mid-keystroke)
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 1b: a Ctrl+Z that lands mid-transition is claimed by exactly ONE owner', () => {
  // WHAT THE AUDIT ASKED FOR (MAJOR AC4): the round-trip tests above complete each switch BEFORE
  // dispatch. This one dispatches INSIDE the transition. The capture listener is added/removed by a
  // React passive effect keyed on `suspended`; between the synchronous store write that flips the
  // workspace and that effect flushing, there is a gap where the store already says the new
  // workspace but the old owner's listener is still attached. This constructs that exact gap.
  //
  // REACHABILITY, stated honestly: real keyboard input never lands in this gap, because React
  // flushes pending passive effects before delivering the next DISCRETE event (a keydown), so the
  // teardown has run by the time a real Ctrl+Z arrives. The test constructs the gap anyway to PIN
  // the safety invariant it depends on -- that a keystroke straddling the switch is claimed by
  // EXACTLY ONE owner, never dropped and never double-fired -- so a future change that broke it
  // (e.g. leaving both listeners live for a tick, double-undo) would turn this RED.
  it('the in-flight keystroke goes to the press-time owner only; after the flush the new owner takes over', async () => {
    captureProbe = installCaptureListenerProbe()
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToPart()
    expect(captureProbe.captureKeydownCount()).toBe(1) // Part active: its capture owner is armed

    // Flip the store to CAM WITHOUT act, so the host's passive `suspended` effect that removes the
    // Part capture listener is SCHEDULED but not yet flushed -- the mid-transition gap. (A React
    // "not wrapped in act" warning is expected here: constructing the un-flushed gap is the point.)
    useCamStore.setState({ workspace: 'cam' })
    expect(captureProbe.captureKeydownCount()).toBe(1) // still attached at the dispatch instant

    const ev = pressUndo()
    // EXACTLY ONE owner claimed it: the Part capture listener (defaultPrevented + stopImmediate),
    // so CAM's history did NOT also move. Not dropped (someone claimed it), not doubled.
    expect(ev.defaultPrevented).toBe(true)
    expect(spies.camUndo).not.toHaveBeenCalled()

    await settle() // now the transition completes: the Part listener is torn down
    expect(captureProbe.captureKeydownCount()).toBe(0)

    // A SUBSEQUENT keystroke, fully past the transition, is CAM's -- the handoff completed.
    pressUndo()
    await settle()
    expect(spies.camUndo).toHaveBeenCalledTimes(1)
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// FAMILY 2 -- a dialog/modal open in each workspace
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 2: a modal-transient listener claims Escape without either history firing', () => {
  it('Part workspace: the in-workspace plane pick owns Escape, no history moves underneath it', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    // Open the real in-workspace plane pick through the real button. "New sketch" now arms the
    // in-workspace plane pick DIRECTLY (the modal chooser was removed) -- that pick is the transient
    // workbench listener that must own Escape here, in place of the old SketchPlaneDialog.
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    expect(screen.getByTestId('solids-workbench-plane-pick-hint')).toBeTruthy()

    pressKey('Escape')
    await settle()

    // The plane pick took it...
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-plane-pick-hint')).toBeNull())
    // ...and neither workspace's history moved. Escape is not an undo chord, so a history that
    // moved here would mean a listener claiming keys it never declared -- which is precisely
    // what the census's chord fingerprint exists to police.
    expect(spies.camUndo).not.toHaveBeenCalled()
    expect(workbenchSketchPresent()).toBe(true)
  }, 40_000)

  it('CAM workspace: a CAM root modal owns Escape, no history moves underneath it', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToCam()

    useCamStore.getState().openModal('sketch-entry')
    await waitFor(() => expect(useCamStore.getState().activeModal).toBe('sketch-entry'))

    pressKey('Escape')
    await settle()

    await waitFor(() => expect(useCamStore.getState().activeModal).toBeNull())
    expect(spies.camUndo).not.toHaveBeenCalled()
    expect(workbenchSketchPresent()).toBe(true)
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// FAMILY 3 -- sketch mode, in BOTH workspaces
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 3: a sketch hotkey is owned by the ACTIVE sketcher in BOTH workspaces', () => {
  // AC4 SKETCH LEG, rebuilt for INT-13C-R1. The audit found the prior version pressed only Ctrl+Z
  // -- a chord the sketcher intentionally ignores (shortcuts.ts:70) -- so it proved nothing about
  // sketch-hotkey OWNERSHIP. These press a REAL sketch-owned chord (a single-key tool shortcut,
  // shortcuts.ts: `l` -> line, `g` -> text) and assert the ACTIVE sketcher claims it while the
  // WRONG-workspace CAM global action stands down.

  it('PART host shape (real workbench sketch): `l` arms the sketcher, and the CAM global `g` does NOT regenerate', async () => {
    const spies = installCamHistorySpies()
    const regen = installCamRegenSpies()
    const runtime = await bootCoMount()
    await mintWorkbenchSketch()

    // A real package sketch session, opened through the real UI -- this attaches the SHARED
    // sketcher's own window key handler (sketchInteraction.ts:425) alongside the two history owners.
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())

    // A real sketch-owned chord: `r` arms the rect-corner tool. NON-VACUOUS -- an opened package
    // sketch defaults to the `line` tool, so this asserts a real CHANGE the sketcher made, not a
    // value that was already there (charter rule 1). The active Part sketcher OWNS the chord.
    expect(armedSketchTool()).toBe('line')
    pressKey('r')
    await settle()
    expect(armedSketchTool()).toBe('rect-corner')

    // `g` is the collision case: the sketcher arms its TEXT tool on `g`, while useGlobalShortcuts
    // ALSO claims bare `g` for CAM toolpath regenerate. In the Model workspace the CAM global must
    // stand down (P2's workspace guard), so ONLY the sketcher reacts.
    pressKey('g')
    await settle()
    expect(armedSketchTool()).toBe('text')
    expect(regen.computeAll).not.toHaveBeenCalled()
    expect(regen.computeOne).not.toHaveBeenCalled()

    // ...and while that sketcher is active it never touches either history owner's Ctrl+Z (it
    // ignores modifier chords, shortcuts.ts:70): CAM undo does not fire from the Model workspace.
    pressUndo()
    await settle()
    expect(spies.camUndo).not.toHaveBeenCalled()
  }, 40_000)

  it('CAM host shape (real Sketcher, the leg the audit found under-verified): `l`/`g` arm the sketcher, CAM global stands down', async () => {
    // The real CAM sketch leg. The CAM host cannot mount here (CNCViewport.enterSketchView needs
    // WebGL), so the SHARED Sketcher package is built against the CAM host literal -- the same seam
    // sketcherSuspendParity.int13b uses -- and entered, which attaches the package's real window key
    // handler. This is a real sketch-owned chord dispatched in the CAM host shape, not a Ctrl+Z.
    const regen = installCamRegenSpies()
    sketcherMount = mountRealSketcher(undefined) // undefined orbitPolicy == the CAM mount

    // CAM active, in sketch mode -- the state the real CAM sketcher runs in.
    switchToCam()
    useCamStore.setState({ viewer: { ...useCamStore.getState().viewer, mode: 'sketch' } })

    expect(armedSketchTool()).toBe('select') // non-vacuity anchor: nothing armed before the chord
    pressKey('l')
    await settle()
    expect(armedSketchTool()).toBe('line') // the active CAM sketcher owns its chord

    pressKey('g')
    await settle()
    expect(armedSketchTool()).toBe('text')
    // The CAM global `g` regenerate stands down while a CAM sketch is open (the hook's mode guard,
    // dispatchTable.int13c pins the predicate). Sketch mode owns its single-key tools.
    expect(regen.computeAll).not.toHaveBeenCalled()
    expect(regen.computeOne).not.toHaveBeenCalled()
  }, 40_000)

  it('the sketch chord is REFUSED in the wrong workspace: with no sketch active, `r` arms nothing', async () => {
    // Ownership is by the ACTIVE sketch, not page-wide: a single-key sketch chord dispatched when no
    // sketcher session is entered arms no tool. (The real workbench is mounted but has no open
    // session, so its sketcher handler is not attached.)
    installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    expect(armedSketchTool()).toBe('select')
    pressKey('r')
    await settle()
    expect(armedSketchTool()).toBe('select') // refused -- no active sketcher to claim it
  }, 40_000)

  it('REFUSED (F-5, WO INT-15): a SUSPENDED Part sketcher no longer claims its single-key chords in the CAM workspace', async () => {
    // This was the one place a sketch chord was NOT refused in the wrong workspace. INT-13C
    // pinned it as F-5: with a Part sketch OPEN and the operator switched to CAM, INT-13B's
    // Sketcher.suspend() was subscription-only -- it stopped the overlay repaint but left the
    // package's window keydown handler (sketchInteraction.ts) attached, so single-key tool
    // shortcuts (l/r/c/g/...) kept arming the invisible, suspended Part sketcher from the Model
    // workspace.
    //
    // WO INT-15 fixes it: Sketcher.suspend() now also DISARMS the interaction's window keydown
    // handler (index.ts -> interaction.suspendWindowKeys()); resume() re-arms it. This is INT-13B's
    // "a suspended host has no listener at all" idiom (D5.2) extended to the sketch key surface,
    // and it lands in the ONE shared Sketcher both hosts mount, so it holds for the Part AND the
    // CAM sketcher instance (parity is proved per-instance in int15.sketcherKeyDisarm below).
    installCamHistorySpies()
    const runtime = await bootCoMount()
    await mintWorkbenchSketch()
    enterBasePlaneSketchViaPick(runtime, 'xy')
    await waitFor(() => expect(screen.getByTestId('workbench-package-sketch-toolbar')).toBeTruthy())

    // Non-vacuity anchor: while the Part sketch is ACTIVE, `c` DOES arm circle-center -- proving
    // the chord is real and the refusal below is the suspend disarm, not an inert key.
    expect(armedSketchTool()).toBe('line') // an opened package sketch defaults to `line`
    pressKey('c')
    await settle()
    expect(armedSketchTool()).toBe('circle-center')

    switchToCam() // suspends the workbench and its sketcher -> now detaches its window key handler
    await settle()

    // Re-arm a known tool from the ACTIVE (pre-switch) state was circle-center; press a DIFFERENT
    // single-key chord in the CAM workspace and prove the SUSPENDED sketcher ignores it entirely.
    pressKey('r') // rect-corner, were the suspended handler still live
    await settle()
    expect(armedSketchTool()).toBe('circle-center') // unchanged: the suspended sketcher refused `r`
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// FAMILY 4 -- D5.3 rule 1: native text editing always wins, in BOTH workspaces
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 4: rule 1 -- typing Ctrl+Z in a text field undoes neither history', () => {
  for (const workspace of ['cam', 'part'] as const) {
    it(`${workspace} workspace: Ctrl+Z with an INPUT focused triggers no undo at all`, async () => {
      const spies = installCamHistorySpies()
      await bootCoMount()
      await mintWorkbenchSketch()
      if (workspace === 'cam') switchToCam()

      const input = screen.getByTestId('int13c-text-probe') as HTMLInputElement
      input.focus()
      pressUndo(input)
      await settle()

      // Rule 1 is the ONLY rule that holds regardless of workspace, and it must survive both
      // rewrites unchanged (spec lines 1172-1175). Both owners must stand down: the browser's
      // native field undo is what the operator gets.
      expect(spies.camUndo).not.toHaveBeenCalled()
      expect(workbenchSketchPresent()).toBe(true)
    }, 40_000)

    it(`${workspace} workspace: Ctrl+Z in a TEXTAREA and a contentEditable triggers no undo either`, async () => {
      const spies = installCamHistorySpies()
      await bootCoMount()
      await mintWorkbenchSketch()
      if (workspace === 'cam') switchToCam()

      // The rule names three targets; testing one of the three would leave a rewrite free to
      // drop the other two silently.
      for (const testId of ['int13c-textarea-probe', 'int13c-contenteditable-probe']) {
        const el = screen.getByTestId(testId) as HTMLElement
        el.focus()
        pressUndo(el)
        await settle()
      }
      expect(spies.camUndo).not.toHaveBeenCalled()
      expect(workbenchSketchPresent()).toBe(true)
    }, 40_000)
  }
})

// ---------------------------------------------------------------------------------------
// FAMILY 5 -- preflight amendment 4: a CAM modal left OPEN across a switch
// ---------------------------------------------------------------------------------------

describe('INT-13C interleave 5 (preflight amendment 4): a CAM modal left open across a switch', () => {
  it('does not intercept a chord the Part workspace owner should claim', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    // Open a CAM root modal in CAM, then leave for Part WITHOUT closing it. Nothing in the UI
    // currently prevents this: INT-13B's suspend step 2 clears the WORKBENCH's own dialog state
    // (SolidsWorkbenchPage.tsx), and CAM root modals are outside that boundary entirely.
    switchToCam()
    useCamStore.getState().openModal('sketch-entry')
    await waitFor(() => expect(useCamStore.getState().activeModal).toBe('sketch-entry'))
    switchToPart()

    // The modal is STILL OPEN and its listener is STILL LIVE while the Model workspace is active.
    expect(useCamStore.getState().activeModal).toBe('sketch-entry')

    pressUndo()
    await settle()

    // The Part workspace's owner still gets its chord: the open CAM modal claims only Escape,
    // and Escape is not an undo chord.
    expect(workbenchSketchPresent()).toBe(false)
    expect(spies.camUndo).not.toHaveBeenCalled()
  }, 40_000)

  it('WITHOUT the App-level modal boundary, a stranded modal still answers Escape (F-4 boundary is necessary)', async () => {
    installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()

    switchToCam()
    useCamStore.getState().openModal('sketch-entry')
    await waitFor(() => expect(useCamStore.getState().activeModal).toBe('sketch-entry'))
    switchToPart()

    // This co-mount deliberately omits App/CamApp, so INT-15's F-4 modal boundary (App.tsx: close
    // activeModal on a workspace switch) is NOT present here -- and the stranded modal keeps its
    // window Escape listener live and answers Escape from the Model workspace. That is precisely
    // why the fix had to live at the App boundary, not in a harness-mountable component: this test
    // pins the pre-boundary behaviour, and int15.camHostListeners (F-4) proves the REAL <App/>
    // closes the modal on the switch so this leak is gone in production. (It never misroutes a
    // history chord, asserted by the sibling test, so it was always out of the D5.3 contract.)
    pressKey('Escape')
    await settle()
    await waitFor(() => expect(useCamStore.getState().activeModal).toBeNull())
  }, 40_000)
})

// ---------------------------------------------------------------------------------------
// AC7 -- D5.4: the BUTTON and the CHORD resolve to the same history
// ---------------------------------------------------------------------------------------

describe('INT-13C AC7 (D5.4): TopToolbar Undo button and Ctrl+Z resolve to the SAME history', () => {
  it('Part workspace: the Undo BUTTON drives the workbench history, not CAM project undo', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToPart()
    expect(workbenchSketchPresent()).toBe(true)

    // The same button the operator clicks, found the same way -- by its label.
    fireEvent.click(getByTooltip('Undo (Ctrl+Z)'))
    await settle()

    // Identical outcome to pressing Ctrl+Z in this workspace (proved in the round trip above):
    // two paths, ONE value. Before D5.4 this button called CAM's undo from the Model workspace.
    // settle() flushes exactly one macrotask tick, which is enough on an idle machine but not a
    // proof under full-suite CPU contention (observed: this assertion flaked red in the full gate
    // run while this same file was 18/18 green standalone, moments apart, on the same commit --
    // a resource-contention flake, not a regression). Poll with a bounded timeout instead of
    // trusting the single tick.
    await waitFor(() => expect(workbenchSketchPresent()).toBe(false))
    expect(spies.camUndo).not.toHaveBeenCalled()
  }, 40_000)

  it('CAM workspace: the Undo BUTTON drives CAM project undo', async () => {
    const spies = installCamHistorySpies()
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToCam()

    fireEvent.click(getByTooltip('Undo (Ctrl+Z)'))
    await settle()

    expect(spies.camUndo).toHaveBeenCalledTimes(1)
    expect(workbenchSketchPresent()).toBe(true)
  }, 40_000)

  it("canUndo/canRedo read from the ACTIVE workspace's history, so the button disables with it", async () => {
    // CAM's history says "nothing to undo"; the Part workspace's says otherwise. If the buttons
    // still read CAM's flags while Part is active, the Undo button would sit DISABLED over a
    // workbench history that has plenty to undo -- the same split D5.4 closes, showing up as
    // enablement rather than as behaviour.
    installCamHistorySpies({ canUndo: false, canRedo: false })
    await bootCoMount()
    await mintWorkbenchSketch()
    switchToPart()

    expect((getByTooltip('Undo (Ctrl+Z)') as HTMLButtonElement).disabled).toBe(false)

    switchToCam()
    expect((getByTooltip('Undo (Ctrl+Z)') as HTMLButtonElement).disabled).toBe(true)
  }, 40_000)
})
