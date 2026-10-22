// @vitest-environment jsdom
//
// WO-917 - THE SECOND DOOR, AND THE ROW THAT MADE ROOM FOR IT.
//
// Operator 2026-08-23 (card Q-WHICH-TABS-MOVE-UNDER-MACHINE): "machine actions
// would become just machine and then underneath that there would be sub tabs
// for the tabs that moved there", and on the editor's two entry points: "Both
// go to the same location."
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom does not lay out, so nothing here
// is allowed to claim the row FITS - that claim is measured in a real browser
// by src/tests/evidence/WO-917/capture.mjs and lives in its results.json.
// What jsdom proves is the CONTRACT: which children the row has, that the four
// sub-tabs exist with real ARIA, that both doors reach ONE editor instance, and
// the negative control this whole move rests on - Macros and Diagnostics are
// still reachable, at full size, still wired to the same handlers.
//
// Harness copied from controlTabMount.test.tsx: Viewport mocked (no WebGL),
// localStorage shimmed BEFORE the store import.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')

/** The six views Operator left on the top row, in his order. */
const TOP_ROW = ['main', 'offsets', 'tools', 'probing', 'routines', 'machine']
/** The four sub-tabs he put under Machine, in his order. */
// WO-2102 (Operator 09-27, 'Fold into Definition and remove the tab'): Actions moved into Definition.
const SUB_TABS = ['definition', 'macros', 'diagnostics']

async function mountControl() {
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

/** A real macro load, so "Macros still works" is a claim about buttons that
 *  exist rather than about an empty panel that cannot fail. */
function seedMacros() {
  const machineId = useCamStore.getState().project.machine?.id ?? 'default'
  const actions = useMachineActions.getState()
  // WO-1707: two custom buttons as a pre-1707 store holds them, arriving
  // together - the one-time move carries them onto the record as macros.
  useMachineActions.setState((s) => ({
    byMachine: {
      ...s.byMachine,
      [machineId]: {
        ...actions.configFor(machineId),
        custom: [
          { id: 'wo917-vac', label: 'Vacuum', color: 'green', lines: ['M8'] },
          { id: 'wo917-light', label: 'Lights', color: 'neutral', lines: ['M64 P1'] },
        ],
      },
    },
  }))
  actions.addPark(machineId, { id: 'wo917-park', label: 'Front left', x: 5, y: 5 })
  return machineId
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam', activeModal: null })
})

afterEach(() => {
  cleanup()
})

describe('WO-917: the top row is six views and nothing else', () => {
  it("carries exactly Operator's six tabs, in his order, with no non-view child", async () => {
    await mountControl()
    const nav = screen.getByTestId('control-subnav-bar').querySelector('.control-strip-nav')!
    expect(nav).toBeTruthy()

    const children = Array.from(nav.children).map((el) => el.getAttribute('data-testid'))
    expect(children).toEqual(TOP_ROW.map((v) => `control-view-${v}`))

    // The row used to end in a button that was not a view at all. Its
    // disappearance is the "change of kind" this order records.
    expect(screen.queryByTestId('control-machine-actions')).toBeNull()
    // Diagnostics and Macros left the row. They did NOT leave the app.
    expect(screen.queryByTestId('control-view-diagnostics')).toBeNull()
    expect(screen.queryByTestId('control-view-macros')).toBeNull()
  })

  it('leaves Main, Offsets, Tools, Probing and Routines switching exactly as before', async () => {
    await mountControl()
    const columns = screen.getByTestId('control-page').querySelector('.control-columns')!
    for (const view of ['offsets', 'tools', 'probing', 'routines']) {
      fireEvent.click(screen.getByTestId(`control-view-${view}`))
      expect(columns.hasAttribute('hidden')).toBe(true)
      expect(screen.getByTestId(`control-view-${view}`).getAttribute('aria-pressed')).toBe('true')
    }
    fireEvent.click(screen.getByTestId('control-view-main'))
    expect(columns.hasAttribute('hidden')).toBe(false)
  })
})

describe('WO-917: Machine is a view with sub-tabs', () => {
  it('is a VIEW - it hides the Main columns and mounts in the aux workspace, no modal', async () => {
    await mountControl()
    const columns = screen.getByTestId('control-page').querySelector('.control-columns')!
    fireEvent.click(screen.getByTestId('control-view-machine'))
    expect(columns.hasAttribute('hidden')).toBe(true)
    const strip = screen.getByTestId('control-machine-subnav')
    expect(strip.closest('.control-aux-workspace')).toBeTruthy()
    // Selecting the view opens nothing on its own.
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(screen.queryByTestId('control-actions-modal')).toBeNull()
  })

  it("uses the ARIA tablist pattern (HelpCenterModal idiom), three tabs in Operator's order", async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    const strip = screen.getByTestId('control-machine-subnav')
    expect(strip.getAttribute('role')).toBe('tablist')
    const tabs = Array.from(strip.querySelectorAll('[role="tab"]'))
    expect(tabs.map((t) => t.getAttribute('data-testid')))
      .toEqual(SUB_TABS.map((t) => `control-machine-tab-${t}`))
    // Exactly one selected, and it is the door this order exists to add.
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true'))
      .toHaveLength(1)
    expect(screen.getByTestId('control-machine-tab-definition').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByTestId('control-machine-tab-macros'))
    expect(screen.getByTestId('control-machine-tab-macros').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('control-machine-tab-definition').getAttribute('aria-selected')).toBe('false')
  })

  it('is ONE NEW ROW inside the view and does not touch the top nav', async () => {
    await mountControl()
    const topNav = screen.getByTestId('control-subnav-bar').querySelector('.control-strip-nav')!
    const before = topNav.children.length
    fireEvent.click(screen.getByTestId('control-view-machine'))
    const strip = screen.getByTestId('control-machine-subnav')
    // The strip is a sibling INSIDE the workspace, not a second nav row bolted
    // to the page chrome, and the top row is untouched by it.
    expect(strip.closest('[data-testid="control-subnav-bar"]')).toBeNull()
    expect(topNav.children.length).toBe(before)
  })
})

describe('WO-917: Definition is not a door; the one door left is unchanged', () => {
  // REPIN (WO-942, following WO-939/WO-941): Operator ruled Definition OUT of the
  // modal ("the machine definition in control needs to have everything...the
  // modal is too cramped"). It is no longer a second door to the SAME editor -
  // it renders MachineDefinitionPanel inline. The one door that remains is the
  // viewport's machine chip, and it still reaches the (unchanged, CAM-only)
  // MachineLibraryModal - this test now proves that split rather than a
  // shared destination.
  it('Machine > Definition renders the panel inline; the viewport chip is the only door left and still reaches the CAM-only modal', async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    fireEvent.click(screen.getByTestId('control-machine-tab-definition'))

    // Selecting Definition opens no modal - it is a view, not a door.
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(screen.queryByTestId('machine-modal-panel')).toBeNull()
    expect(screen.getByTestId('control-machine-definition')).toBeTruthy()
    expect(screen.getByTestId('machine-definition-panel')).toBeTruthy()

    // The viewport's machine chip is the one door that remains, unchanged by
    // this move - exactly what it did before.
    useCamStore.getState().openModal('machine-config')
    const viaViewport = await screen.findByTestId('machine-modal-panel')
    expect(screen.getAllByTestId('machine-modal-panel')).toHaveLength(1)

    // WO-941: the control half (WO-913's editor) no longer lives behind that
    // door - it is named as moved, not silently dropped.
    expect(viaViewport.querySelector('[data-testid="disclosure-machine-controller-definition"]')).toBeNull()
    expect(viaViewport.querySelector('[data-testid="machine-modal-control-half-note"]')).toBeTruthy()

    useCamStore.setState({ activeModal: null })
    await waitFor(() => expect(screen.queryByTestId('machine-modal-panel')).toBeNull())
  })

  it('the Definition tab stays reachable after navigating to another sub-tab - no door, no modal state involved', async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    expect(screen.getByTestId('control-machine-definition')).toBeTruthy()

    // Wander away, the way the old test dismissed the modal before checking
    // the door could be reopened.
    fireEvent.click(screen.getByTestId('control-machine-tab-macros'))
    expect(screen.queryByTestId('control-machine-definition')).toBeNull()

    fireEvent.click(screen.getByTestId('control-machine-tab-definition'))
    expect(screen.getByTestId('control-machine-definition')).toBeTruthy()
    expect(screen.getByTestId('machine-definition-panel')).toBeTruthy()
    expect(useCamStore.getState().activeModal).toBeNull()
  })

  it('Machine has no Actions tab; its built-in commands live in Definition (WO-2102)', async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    expect(screen.queryByTestId('control-machine-tab-actions')).toBeNull()
    expect(screen.getByTestId('control-machine-tab-definition').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('machine-def-builtin-commands')).toBeTruthy()
  })
})

describe('WO-917 NEGATIVE CONTROL: Macros and Diagnostics survived the move', () => {
  it('Macros mounts at FULL SIZE in the workspace, not only in the clipped right rail', async () => {
    seedMacros()
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    fireEvent.click(screen.getByTestId('control-machine-tab-macros'))

    const panels = screen.getAllByTestId('control-macros-toggle')
      .map((el) => el.closest('.control-panel')!)
    // Two mounts: Main's right rail (hidden with the columns) and this one.
    const inWorkspace = panels.filter((p) => p.closest('.control-aux-workspace'))
    const inRail = panels.filter((p) => p.closest('.control-col-right'))
    expect(inWorkspace).toHaveLength(1)
    expect(inRail).toHaveLength(1)
    // The rail copy is the one WO-103 measured as cut off - the workspace copy
    // is a direct child of the workspace, with no rail scrollport around it.
    expect(inWorkspace[0].closest('.control-col-scroll')).toBeNull()
    expect(inRail[0].closest('.control-col-scroll')).toBeTruthy()

    // Still WORKS: every seeded button rendered, and the gear still reaches
    // the actions modal from here. WO-1707: custom buttons are macros now,
    // one grid (control-user-macro-grid) - the older, separate
    // control-macro-grid this used to read is gone.
    const grid = inWorkspace[0].querySelector('[data-testid="control-user-macro-grid"]')!
    // WO-2841 (851f073592) folded the separate park grid into this one grid: the
    // park this test seeds ('Front left', with its park icon) comes first, then the macros.
    expect(Array.from(grid.querySelectorAll('button')).map((b) => b.textContent?.trim()))
      .toEqual(['Front left', 'Vacuum', 'Lights'])
    expect(grid.querySelector('[data-testid="control-park-wo917-park"]')).toBeTruthy()
    expect(inWorkspace[0].querySelector('[data-testid="control-park-grid"]')).toBeNull()
    fireEvent.click(inWorkspace[0].querySelector('[data-testid="control-actions-gear"]')!)
    expect(screen.getByTestId('control-actions-modal')).toBeTruthy()
  })

  it('Diagnostics still mounts both of its panels at full size', async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    fireEvent.click(screen.getByTestId('control-machine-tab-diagnostics'))
    const log = screen.getByTestId('control-cyclelog-toggle').closest('.control-panel')!
    expect(log.closest('.control-aux-workspace')).toBeTruthy()
    // SimulatedPartPanel gates itself on connectionKind === 'simulator'
    // (SimulatedPartPanel.tsx:47) and returns null otherwise - unchanged by
    // this order, and the reason it is absent in a jsdom mount with no
    // connection. The live capture shoots it connected.
    expect(screen.queryByTestId('simulated-part-panel')).toBeNull()
    // Nothing else claims the workspace while Diagnostics is up.
    expect(screen.queryByTestId('control-machine-definition')).toBeNull()
    expect(screen.getAllByTestId('control-macros-toggle')
      .filter((el) => el.closest('.control-aux-workspace'))).toHaveLength(0)
  })

  it('keeps the operator authority row in the Machine view, as every aux subview has it', async () => {
    await mountControl()
    fireEvent.click(screen.getByTestId('control-view-machine'))
    // WO-068 finding 2: the transport authority mounts in every aux subview
    // except Probing and Routines. Machine is an aux subview, so it does too -
    // this order removed no authority.
    const authority = screen.getByTestId('control-aux-authority')
    expect(authority.closest('.control-aux-workspace')).toBeTruthy()
    expect(authority.querySelector('[data-testid="control-safety-bar"]')).toBeTruthy()
  })
})
