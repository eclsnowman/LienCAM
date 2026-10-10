// @vitest-environment jsdom
//
// WO-913 - a person edits their machine, with no UCCNC anywhere.
//
// The headline is the ROUND TRIP: a profile created from scratch, its axes,
// homing cycle and PIN ASSIGNMENTS filled in through the real modal, saved,
// and every value still there after a reload through the app's own persist
// path. A form that edits state nobody persisted is not the feature.
//
// Three things here are not style preferences and must not be "cleaned up":
//
//   1. A PIN FIELD IS TWO NUMBERS AND A NEGATE - port, pin, negate. Never one
//      number, never a lookup, never arithmetic on a pin number. The bridge
//      owns the single copy of the board's translation table; a second copy
//      here diverges invisibly and the board then accepts and counts every
//      move while emitting nothing.
//   2. Z FIRST is a safety default, and the editor must not quietly lose it.
//   3. A validation complaint rides the FIELD'S OWN hover context and the
//      machine console - both existing surfaces. It never appears as a banner
//      that pushes the form down.
//
// WO-942 REPIN (2026-08-24): Operator's ruling ("machine definition in control
// needs to have everything...the modal is too cramped") moved the WHOLE
// definition editor WO-913 built off MachineLibraryModal and onto
// MachineDefinitionPanel (WO-939/WO-941). Every test below that edits axes,
// homing or pins now mounts the panel and presses its `machine-def-panel-`
// prefixed controls instead of expanding the modal's (now-removed)
// `disclosure-machine-controller-definition`. The panel's sections are laid
// out FLAT on a page and are never collapsed, so there is no `expand(...)`
// step. Three tests that asserted the modal's DISCLOSURE LAYOUT (collapsed at
// rest, its titled sections, its own no-definition banner) have no surface
// left to assert against and are retired below, each naming the test that
// covers the property that survived. The full accounting is
// `src/tests/evidence/WO-942/accounting.txt`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { MachineConfig } from '../../types'
import { AXIS_NAMES } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). In-memory shim BEFORE the store import
// (same scaffolding as the other modal smoke suites). No app change.
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

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const {
  useCamStore,
  persistPartialize,
  persistMigrate,
  persistMerge,
  PERSIST_STORE_VERSION,
} = await import('../../store')

const state = () => useCamStore.getState()

function blankProfile(id: string, name = id): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

/** The real persist path, exactly as zustand runs it on a reload: partialize
 *  -> JSON -> migrate -> merge. Not a hand-rolled JSON.stringify; the point is
 *  that the EXISTING mechanism carries what the editor wrote. */
const reloadThroughPersist = (): MachineConfig[] => {
  const written = JSON.parse(JSON.stringify(persistPartialize(state())))
  const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
  return persistMerge(migrated, state()).machineLibrary
}

/** Mount the definition editor - MachineDefinitionPanel, WO-942 - on a
 *  library holding exactly one bare profile, made the project's ACTIVE
 *  machine (the panel edits the active machine by construction; MachineDefinitionPanel.tsx:278-285). */
function openEditor(machine: MachineConfig = blankProfile('wo913', 'Shop Router')): void {
  act(() => {
    useCamStore.setState({
      machineLibrary: [machine],
      project: { ...state().project, machine },
      consoleEvents: [],
    })
    state().closeModal()
  })
  render(<MachineDefinitionPanel />)
}

const definePress = () => {
  act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-define')) })
}

// ---------------------------------------------------------------------------
// WO-943 REPIN: the definition PANEL groups its settings into three tabs
// (Motion, Travel & Homing, Wiring) and mounts only the open one, so a field is
// reached by going to its group - the same click a person makes. The modal
// tests in this file are untouched by that: `reveal` returns immediately when
// the control is already on screen, and there are no group tabs in the modal.
//
// Every reveal is resolved BEFORE any act(), because a nested act() does not
// flush its state update until the outer one closes - so a query inside the
// act would still be looking at the tab we came from.
// ---------------------------------------------------------------------------

// WO-1690: the axis table (use/steps/speed/accel/travel/homing/slave/pins)
// moved off the three Legacy groups onto the outer "Machine" area tab - a
// different door (`DefinitionSectionNav`, not `DefinitionNavigation`), tried
// first since that is where those controls live now.
const showMachineArea = (): void => {
  const tab = screen.queryByTestId('machine-def-tab-machine')
  if (tab) act(() => { fireEvent.click(tab) })
}

const reveal = (label: string): HTMLElement => {
  const here = screen.queryByLabelText(label)
  if (here) return here
  showMachineArea()
  const onMachineArea = screen.queryByLabelText(label)
  if (onMachineArea) return onMachineArea
  for (const key of ['probing', 'controller', 'spindle', 'outputs', 'allSettings'] as const) {
    const tab = screen.queryByTestId(`machine-def-tab-${key}`)
    if (tab) act(() => { fireEvent.click(tab) })
    const found = screen.queryByLabelText(label)
    if (found) return found
  }
  throw new Error(`no group carries a control labelled "${label}"`)
}

const revealTestId = (testId: string): HTMLElement => {
  const here = screen.queryByTestId(testId)
  if (here) return here
  showMachineArea()
  const onMachineArea = screen.queryByTestId(testId)
  if (onMachineArea) return onMachineArea
  for (const key of ['probing', 'controller', 'spindle', 'outputs', 'allSettings', 'overview'] as const) {
    const tab = screen.queryByTestId(`machine-def-tab-${key}`)
    if (tab) act(() => { fireEvent.click(tab) })
    const found = screen.queryByTestId(testId)
    if (found) return found
  }
  throw new Error(`no group carries "${testId}"`)
}

/** Fill a pin field. THE POLARITY IS THREE-WAY (WO-995), because the record's
 *  is: a pin nobody has spoken about carries `null`, not `false`.
 *    `true`  - one click, the box says "inverted".
 *    `false` - TWO clicks, so the record carries a STATED "not inverted".
 *              Not clicking is not the same thing: it leaves the pin where it
 *              started, and where it starts is unknown.
 *    `null`  - say nothing, and the pin keeps the unknown it was born with. */
// WO-1690: an axis pin ("X step", "Y dir", ...) is behind that axis's own
// "Pins and more" drawer on the outer Machine tab; the machine-wide pins
// (e-stop/probe/probe2) are untouched, still on Wiring's "Machine inputs".
const openAxisDrawerFor = (name: string): void => {
  const axis = name.split(' ')[0]
  if (!(AXIS_NAMES as readonly string[]).includes(axis)) return
  showMachineArea()
  const chip = screen.queryByTestId(`machine-def-panel-axis-pins-more-${axis}`)
  if (chip) act(() => { fireEvent.click(chip) })
}

const setPin = (name: string, port: number, pin: number, negate: boolean | null) => {
  openAxisDrawerFor(name)
  const portBox = reveal(`${name} port`)
  act(() => { fireEvent.change(portBox, { target: { value: String(port) } }) })
  const pinBox = reveal(`${name} pin`)
  act(() => { fireEvent.change(pinBox, { target: { value: String(pin) } }) })
  if (negate === null) return
  act(() => { fireEvent.click(reveal(`${name} negate`)) })
  if (negate === false) act(() => { fireEvent.click(reveal(`${name} negate`)) })
}

/** NumericInput keeps a local edit draft and commits on blur/Enter. */
const setNumber = (label: string, value: number) => {
  const field = reveal(label)
  act(() => { fireEvent.change(field, { target: { value: String(value) } }) })
  act(() => { fireEvent.blur(field) })
}

const save = () => {
  act(() => { fireEvent.click(revealTestId('machine-def-panel-save')) })
}

const savedProfile = (): MachineConfig | undefined =>
  reloadThroughPersist().find((m) => m.id === 'wo913')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({ machineLibrary: [], consoleEvents: [] } as never)
    state().closeModal()
  })
})

// ---------------------------------------------------------------------------
// The door, and the deliberate absence of a definition
// ---------------------------------------------------------------------------

describe('WO-913 the editor lives on the machine profile that already exists', () => {
  // WO-942 (3 tests removed below: 2 COVERED-BY, 1 RETIRED): the definition
  // is no longer a section INSIDE the CAM modal - it does not exist there at
  // all any more (WO-941), so a claim
  // shaped "the modal has this section, alongside its other sections" has no
  // subject. The two halves of the original claim both survive, each on the
  // suite that now owns it:
  //   - "the modal's existing (CAM) sections are untouched" is
  //     applyBoundary.wo941.test.tsx :: "everything a TOOLPATH needs is still
  //     on it" (same seven testids, same assertion).
  //   - "the definition section is gone from the modal, not merely emptied"
  //     is applyBoundary.wo941.test.tsx :: "not one control-only field
  //     survives, with every section open".
  //   - "a profile with no definition says so, and never invents one on
  //     open" is machineDefinitionPanel.wo939.test.tsx :: "a machine with no
  //     definition says so and offers to define one" (same claim, the
  //     panel's `machine-def-panel-undefined` / `machine-def-panel-summary`
  //     in place of the modal's disclosure header).
  //   - "every new section is COLLAPSED at rest" has no successor because the
  //     panel has no collapse mechanism AT ALL - SectionHead
  //     (MachineDefinitionPanel.tsx:215-217) renders every section
  //     permanently open, which is the reversal Operator's ruling made ("the
  //     modal is too cramped...a page has much more space"), not a gap this
  //     order left. Every field-level test below reaches its field with no
  //     expand step, which is the live proof the sections stay open.
  //
  // See src/tests/evidence/WO-942/accounting.txt for the full 45-test ledger.

  it('each permanent area keeps the one Apply control in the shared bar', () => {
    openEditor()
    definePress()
    const areas = [
      ['overview', 'machine-def-overview'],
      ['machine', 'machine-def-group-machine'],
      ['spindle', 'machine-def-area-spindle'],
      ['outputs', 'machine-def-panel-outputs'],
      ['probing', 'machine-def-probing-area'],
      ['controller', 'machine-def-controller-area'],
      ['allSettings', 'machine-def-all-settings'],
    ] as const
    for (const [area, surface] of areas) {
      act(() => { fireEvent.click(screen.getByTestId(`machine-def-tab-${area}`)) })
      expect(screen.getByTestId(surface)).toBeTruthy()
      expect(screen.getAllByTestId('machine-def-bar-apply')).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// THE PIN RULE
// ---------------------------------------------------------------------------

describe('WO-913 THE PIN RULE: a pin field is two numbers and a negate', () => {
  it('every pin field asks for port, pin and negate - and nothing else', () => {
    openEditor()
    definePress()

    // WO-1690 REPIN: axis pins moved off Wiring's own table into each axis's
    // "Pins and more" drawer on the outer Machine tab; Wiring keeps only the
    // three machine-wide pins (e-stop/probe/probe2). The total count is
    // unchanged, which is the point: moving pins off Wiring dropped none of
    // them.
    //
    // WO-942 REPIN: the panel's own "Define" (MachineDefinitionPanel.tsx:350)
    // creates ALL SIX axes via `AXIS_NAMES`, not just X/Y/Z - the modal's
    // create used to stop at three (`createDefaultControllerDefinition`'s
    // default parameter). The disabled axes are carried, not omitted (WO-939:
    // "a switched-off axis still has its fields"), so every one of them still
    // has all six pins in its drawer. The count comes off AXIS_NAMES rather
    // than a typed number, so it stays honest if a seventh axis is ever added.
    showMachineArea()
    let axisCellCount = 0
    for (const axis of AXIS_NAMES) {
      const chip = revealTestId(`machine-def-panel-axis-pins-more-${axis}`)
      act(() => { fireEvent.click(chip) })
      const drawer = revealTestId(`machine-def-axis-drawer-${axis}`)
      const cells = drawer.querySelectorAll('[data-testid^="machine-def-panel-pin-"]')
      expect(cells.length).toBe(6)
      for (const cell of Array.from(cells)) {
        const boxes = cell.querySelectorAll('input')
        expect(boxes.length).toBe(3)
        expect((boxes[2] as HTMLInputElement).type).toBe('checkbox')
      }
      axisCellCount += cells.length
    }
    expect(axisCellCount).toBe(AXIS_NAMES.length * 6)

    act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-controller')) })
    const estopCells = document.querySelectorAll('[data-testid="machine-def-controller-estop-pin"]')
    expect(estopCells.length).toBe(1)
    act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-probing')) })
    const probeCells = document.querySelectorAll('[data-testid^="machine-def-panel-probing-pin-"]')
    expect(probeCells.length).toBe(2)
    for (const cell of [...Array.from(estopCells), ...Array.from(probeCells)]) {
      const boxes = cell.querySelectorAll('input')
      expect(boxes.length).toBe(3)
      expect((boxes[2] as HTMLInputElement).type).toBe('checkbox')
    }

    openAxisDrawerFor('X step')
    expect(reveal('X step port')).not.toBeNull()
    expect(reveal('X step pin')).not.toBeNull()
    expect(reveal('X step negate')).not.toBeNull()
  })

  it('an unassigned pin renders BLANK, never "port 0 pin 0"', () => {
    openEditor()
    definePress()
    openAxisDrawerFor('X step')
    expect((reveal('X step port') as HTMLInputElement).value).toBe('')
    expect((reveal('X step pin') as HTMLInputElement).value).toBe('')
    openAxisDrawerFor('Z limit+')
    expect((reveal('Z limit+ port') as HTMLInputElement).value).toBe('')
  })

  it('clearing a pin field puts it back to unassigned rather than to a stray number', () => {
    openEditor()
    definePress()
    setPin('X step', 1, 5, false)
    const _f = reveal('X step pin')
    act(() => { fireEvent.change(_f, { target: { value: '' } }) })
    save()
    const x = savedProfile()?.controllerDefinition?.axes.find((a) => a.axis === 'X')
    expect(x?.stepPin).toEqual({ port: 1, pin: 0, negate: false })
  })

  // There is deliberately NO source-scanning guard in this file. WO-912 ships
  // the one guard - `machineDefinition.wo912.test.ts`, "fails if a UCpin
  // translation table appears anywhere in src/" - and it already walks every
  // .ts/.tsx under src/, this panel included. A second copy of the guard here
  // would be a second copy of the very pattern list it forbids, which is the
  // same mistake at one remove. Run that suite; it is the authority.

  it('a pin is carried, not computed: what is typed is what is stored', () => {
    openEditor()
    definePress()
    setPin('X step', 2, 14, false)
    save()
    const x = savedProfile()?.controllerDefinition?.axes.find((a) => a.axis === 'X')
    expect(x?.stepPin).toEqual({ port: 2, pin: 14, negate: false })
  })
})

// ---------------------------------------------------------------------------
// SAFETY DEFAULTS the editor must not lose
// ---------------------------------------------------------------------------

describe('WO-913 safety defaults survive the editor', () => {
  it('SAFETY DEFAULT, NOT A PREFERENCE: a freshly defined machine homes Z FIRST', () => {
    openEditor()
    definePress()
    save()
    expect(savedProfile()?.controllerDefinition?.homing.order).toEqual(['Z', 'X', 'Y'])
  })

  it('SAFETY DEFAULT: no axis arrives with a slave nobody asked for', () => {
    openEditor()
    definePress()
    save()
    const axes = savedProfile()?.controllerDefinition?.axes ?? []
    expect(axes.length).toBeGreaterThan(0)
    expect(axes.every((a) => a.slaveAxis === null)).toBe(true)
  })

  it('SAFETY DEFAULT: no pin arrives guessed - every one is unassigned', () => {
    openEditor()
    definePress()
    save()
    const def = savedProfile()?.controllerDefinition
    const pins = [
      ...(def?.axes ?? []).flatMap((a) => [
        a.stepPin, a.dirPin, a.homePin, a.limitMinusPin, a.limitPlusPin, a.enablePin,
      ]),
      def?.io.estop, def?.io.probe, def?.io.probe2,
    ]
    expect(pins.every((p) => p !== undefined && p.port === 0 && p.pin === 0)).toBe(true)
  })

  it('re-enabling Z puts it back at the FRONT of the cycle, never at the end', () => {
    openEditor()
    definePress()
    const zEnabled = revealTestId('machine-def-panel-axis-enabled-Z')
    act(() => { fireEvent.click(zEnabled) })
    act(() => { fireEvent.click(zEnabled) })
    save()
    expect(savedProfile()?.controllerDefinition?.homing.order).toEqual(['Z', 'X', 'Y'])
  })

  it('a gantry slave axis can be added and homed without inventing one', () => {
    openEditor()
    definePress()
    // WO-1690: resolve BEFORE act(), same reason the file header states for
    // `reveal`/`revealTestId` generally - the navigation click a resolve can
    // require does not flush from inside an act() that is still open.
    const aEnabled = revealTestId('machine-def-panel-axis-enabled-A')
    act(() => { fireEvent.click(aEnabled) })
    const _f = reveal('Y slave axis')
    act(() => { fireEvent.change(_f, { target: { value: 'A' } }) })
    save()
    const def = savedProfile()?.controllerDefinition
    expect(def?.axes.find((a) => a.axis === 'Y')?.slaveAxis).toBe('A')
    expect(def?.axes.find((a) => a.axis === 'A')?.enabled).toBe(true)
    expect(def?.homing.order).toEqual(['Z', 'X', 'Y', 'A'])
    expect(def?.axes.find((a) => a.axis === 'X')?.slaveAxis).toBeNull()
  })

  it('disabling an axis takes it out of the homing cycle', () => {
    openEditor()
    definePress()
    const yEnabled = revealTestId('machine-def-panel-axis-enabled-Y')
    act(() => { fireEvent.click(yEnabled) })
    save()
    expect(savedProfile()?.controllerDefinition?.homing.order).toEqual(['Z', 'X'])
  })

  it('reordering a homing position SWAPS, so no axis falls out of the cycle', () => {
    openEditor()
    definePress()
    const _f = reveal('Homing order position 1')
    act(() => { fireEvent.change(_f, { target: { value: 'Y' } }) })
    save()
    expect(savedProfile()?.controllerDefinition?.homing.order).toEqual(['Y', 'X', 'Z'])
  })
})

// ---------------------------------------------------------------------------
// THE ROUND TRIP - the whole feature
// ---------------------------------------------------------------------------

describe('WO-913 THE ROUND TRIP: from scratch, filled in, saved, still there', () => {
  // WO-942 REPIN: this is the one test in the suite that genuinely spans BOTH
  // surfaces now, because the two verbs it drives - naming a new machine
  // record, and defining its axes/homing/pins - split across them (Operator:
  // "only Control can apply it to the machine...we just scope what the cam
  // modal can change to only what is actually useful for the CAM
  // definitions"). Steps 1-2 are unchanged: New and rename are still CAM
  // bookkeeping and still live on the modal. What is new is the explicit "Use
  // for this project" press - the modal never wrote a freshly-created machine
  // through to `project.machine` on its own, and MachineDefinitionPanel only
  // ever edits the ACTIVE machine (MachineDefinitionPanel.tsx:278-285), so
  // this step is what puts the new record in front of the panel. From there
  // the round trip is exactly the feature this order proved: fill in through
  // the real editor, save, reload through the app's own persist path.
  it('a profile created from scratch keeps every axis, homing and pin value across a reload', () => {
    act(() => {
      useCamStore.setState({ machineLibrary: [] })
      state().closeModal()
    })
    render(<MachineLibraryModal />)
    act(() => { state().openModal('machine-config') })

    // 1. From scratch: the New button, exactly as a person with no UCCNC
    //    install would start.
    act(() => { fireEvent.click(screen.getByText('New')) })
    const newId = state().machineLibrary[0].id
    expect(state().machineLibrary).toHaveLength(1)

    // 2. Name it, then make it the project's active machine - this is what
    //    hands it to the Control panel, which edits the active machine only.
    act(() => {
      fireEvent.change(screen.getByDisplayValue('New Machine'), { target: { value: 'Bench Router' } })
    })
    act(() => { fireEvent.click(screen.getByText('Use for this project')) })
    expect(state().project.machine.id).toBe(newId)
    cleanup()

    // 3. Control -> Machine -> Definition: define the axes/homing/pins that
    //    do not exist yet.
    render(<MachineDefinitionPanel />)
    expect(revealTestId('machine-def-panel-summary').textContent).toBe('Not defined')
    // WO-1690: "New" defaults to GRBL, whose pins are fixed by the board and
    // carry no editor at all here (GRBL has no software-configurable pin
    // map, unlike UCCNC/AXBB-E) - switch to a controller whose pins this
    // software carries, the same choice an operator filling this in from
    // scratch on non-GRBL hardware would make.
    act(() => {
      fireEvent.change(revealTestId('machine-def-bar-controller'), { target: { value: 'uccnc' } })
    })
    definePress()

    // 4. Axes: motion numbers and all six pins on X.
    setNumber('X steps per unit', 640)
    setNumber('X max velocity (units per minute)', 7500)
    setNumber('X acceleration (units per second squared)', 420)
    setNumber('X soft limit minimum', -3)
    setNumber('X soft limit maximum', 742)
    setPin('X step', 1, 2, false)
    setPin('X dir', 1, 3, true)
    setPin('X home', 2, 4, false)
    setPin('X limit-', 2, 5, true)
    setPin('X limit+', 2, 6, false)
    // Left UNSPOKEN on purpose: the reload has to carry an unknown polarity
    // as an unknown, not quietly resolve it to "not inverted" (WO-995).
    setPin('X enable', 3, 7, null)
    const _slave = reveal('Y slave axis')
    act(() => { fireEvent.change(_slave, { target: { value: 'A' } }) })

    // 5. Homing: the order and one axis's cycle in full.
    const _order2 = reveal('Homing order position 2')
    act(() => { fireEvent.change(_order2, { target: { value: 'Y' } }) })
    const _dir = reveal('X homing direction')
    act(() => { fireEvent.change(_dir, { target: { value: 'positive' } }) })
    setNumber('X homing fast speed', 1800)
    setNumber('X homing slow speed', 120)
    setNumber('X homing back off', 3.5)
    setNumber('X homing value', -12.5)
    { const _c = reveal('X homing auto zero'); act(() => { fireEvent.click(_c) }) }

    // 6. I/O.
    setPin('E-stop', 2, 9, true)
    setPin('Probe', 2, 10, false)
    setPin('Tool setter', 3, 11, false)

    // 7. Save, then RELOAD through the app's own persist path.
    save()
    const reloaded = reloadThroughPersist().find((m) => m.id === newId)
    expect(reloaded?.name).toBe('Bench Router')
    const def = reloaded?.controllerDefinition
    expect(def).toBeDefined()

    const x = def!.axes.find((a) => a.axis === 'X')!
    expect(x.stepsPerUnit).toBe(640)
    expect(x.maxVelocity).toBe(7500)
    expect(x.acceleration).toBe(420)
    expect(x.softLimitMin).toBe(-3)
    expect(x.softLimitMax).toBe(742)
    expect(x.stepPin).toEqual({ port: 1, pin: 2, negate: false })
    expect(x.dirPin).toEqual({ port: 1, pin: 3, negate: true })
    expect(x.homePin).toEqual({ port: 2, pin: 4, negate: false })
    expect(x.limitMinusPin).toEqual({ port: 2, pin: 5, negate: true })
    expect(x.limitPlusPin).toEqual({ port: 2, pin: 6, negate: false })
    expect(x.enablePin).toEqual({ port: 3, pin: 7, negate: null })
    expect(def!.axes.find((a) => a.axis === 'Y')!.slaveAxis).toBe('A')

    expect(def!.homing.order).toEqual(['Z', 'Y', 'X'])
    const hx = def!.homing.perAxis.X!
    expect(hx.direction).toBe('positive')
    expect(hx.fastSpeed).toBe(1800)
    expect(hx.slowSpeed).toBe(120)
    expect(hx.backOff).toBe(3.5)
    expect(hx.homingValue).toBe(-12.5)
    expect(hx.autoZero).toBe(false)

    expect(def!.io.estop).toEqual({ port: 2, pin: 9, negate: true })
    expect(def!.io.probe).toEqual({ port: 2, pin: 10, negate: false })
    expect(def!.io.probe2).toEqual({ port: 3, pin: 11, negate: false })
    // 15s, and the reason is on the page rather than in this test: WO-1039
    // gave every one of the machine's ~1465 non-wired settings an editable
    // box, so the definition panel now carries about that many more elements.
    // `reveal` above is O(page): it scans by label and, when a control is on
    // another tab, re-mounts tabs looking for it - and this test reveals ~60
    // controls. Measured 2.8s before the order and 5.1s after, against a 5s
    // default. Nothing here got slower per operation; the page it drives got
    // bigger, which is the order's point.
  }, 15_000)

  it('the reloaded values come BACK INTO the editor, not just into storage', () => {
    openEditor()
    definePress()
    setNumber('X steps per unit', 640)
    setPin('X step', 1, 2, true)
    save()

    // Re-mount the panel on the reloaded library: the editor must show what a
    // reload actually left behind, not the draft it happens to still hold.
    cleanup()
    act(() => {
      const reloaded = reloadThroughPersist()
      useCamStore.setState({
        machineLibrary: reloaded,
        project: { ...state().project, machine: reloaded.find((m) => m.id === 'wo913')! },
      })
    })
    render(<MachineDefinitionPanel />)

    expect((reveal('X steps per unit') as HTMLInputElement).value).toBe('640')
    openAxisDrawerFor('X step')
    expect((reveal('X step port') as HTMLInputElement).value).toBe('1')
    expect((reveal('X step pin') as HTMLInputElement).value).toBe('2')
    expect((reveal('X step negate') as HTMLInputElement).checked).toBe(true)
  })

  it('there is no second persistence path - the definition rides machineLibrary', () => {
    openEditor()
    definePress()
    save()
    const written = persistPartialize(state()) as unknown as Record<string, unknown>
    const carriers = Object.keys(written).filter((k) => {
      const blob = JSON.stringify(written[k] ?? null)
      return blob.includes('"controllerDefinition"')
    })
    // WO-937 REPIN, and it is a real contract change rather than a fixture
    // tweak, so it is spelled out.
    //
    // The invariant this test defends is "saving a definition must not invent
    // a NEW place to store one". That still holds and is still asserted below.
    //
    // What changed: the app now boots bound to Operator's imported machine, which
    // CARRIES a definition, so `project.machine` contains one too. That is not
    // a second source of truth - it is the active-machine mirror WO-928's F17
    // identified and deliberately RECONCILED ("Apply reads where homing reads;
    // Save writes through to project.machine when the entry saved is the
    // active machine"). Before WO-937 no default machine had a definition, so
    // this assertion only ever saw one carrier by accident of the fixture.
    //
    // The guard keeps its teeth: any carrier beyond these two - a new store
    // slice, a separate settings blob - still fails.
    expect(carriers.slice().sort()).toEqual(['machineLibrary', 'project'])
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S UI RULES
// ---------------------------------------------------------------------------

describe("WO-913 Operator's UI rules: a complaint reuses a surface and shifts nothing", () => {
  const duplicatePins = () => {
    openEditor()
    definePress()
    setPin('X step', 1, 8, false)
    setPin('Y step', 1, 8, false)
  }

  it('a duplicate claim rides the two fields own hover context, not a banner', () => {
    duplicatePins()
    // WO-1690: one axis's drawer is open at a time, so each field is checked
    // with its own axis's drawer open.
    openAxisDrawerFor('X step')
    const xCell = revealTestId('machine-def-panel-pin-X-stepPin')
    expect(xCell.getAttribute('data-pin-problem')).toBe('')
    expect(xCell.getAttribute('data-tooltip')).toContain('Port 1 pin 8')
    openAxisDrawerFor('Y step')
    const yCell = revealTestId('machine-def-panel-pin-Y-stepPin')
    expect(yCell.getAttribute('data-pin-problem')).toBe('')
    expect(yCell.getAttribute('data-tooltip')).toContain('Port 1 pin 8')
    // A field with nothing wrong keeps its ordinary hover text.
    openAxisDrawerFor('Z step')
    const clean = revealTestId('machine-def-panel-pin-Z-stepPin')
    expect(clean.getAttribute('data-pin-problem')).toBeNull()
    expect(clean.getAttribute('data-tooltip')).toContain('port, pin, negate')
  })

  it('the complaint adds no element and moves nothing on the form', () => {
    openEditor()
    definePress()
    // WO-942 REPIN: `.machine-editor` was the modal's root editing column;
    // the panel's equivalent root is its own `machine-definition-panel`
    // section (MachineDefinitionPanel.tsx:619).
    // WO-943 REPIN. Two things changed and both are deliberate.
    //
    // FIRST, the measurement was wrong once pins moved to their own group:
    // `before` was counted on the group at rest and the anchor lookup then
    // switched to Wiring, so it compared two different tabs and reported a
    // difference that had nothing to do with the complaint. The group is
    // opened FIRST now, and the form is measured on the tab it lives on.
    //
    // SECOND, the rule this test defends is that a complaint RIDES AN EXISTING
    // SURFACE and never becomes a banner that pushes the form down. The form
    // is asserted to be untouched, element for element, and the anchor field
    // is asserted not to have moved.
    //
    // The one thing WO-943 does add outside the form is the group tab's
    // problem count - and it is asserted here EXPLICITLY rather than allowed
    // to slip through a loosened bound. It exists because grouping the page
    // behind tabs creates a way for a fault to hide on a tab nobody opened,
    // which would be worse than the thing this rule protects against. It sits
    // in the tab strip, above the form, and moves no field.
    // WO-1690 REPIN: the pin table moved off Wiring onto the outer Machine
    // tab, so the "form that must not move" is its table now, not Wiring's.
    showMachineArea()
    const panel = revealTestId('machine-definition-panel')
    const form = revealTestId('machine-def-panel-axis-table')
    const beforeForm = form.querySelectorAll('*').length
    const beforePanel = panel.querySelectorAll('*').length
    const anchor = revealTestId('machine-def-panel-axis-Z')
    const anchorBefore = anchor.compareDocumentPosition(form)

    setPin('X step', 1, 8, false)
    setPin('Y step', 1, 8, false)

    // The table itself: not one element added, and nothing moved - the
    // complaint marks the field it is about (its own tooltip and
    // `data-pin-problem`) inside whichever axis's drawer is open, never the
    // row or table shape.
    expect(revealTestId('machine-def-panel-axis-table').querySelectorAll('*').length)
      .toBe(beforeForm)
    expect(revealTestId('machine-def-panel-axis-Z')
      .compareDocumentPosition(revealTestId('machine-def-panel-axis-table'))).toBe(anchorBefore)

    // Close Y's drawer (the last one `setPin` opened) so the panel is back
    // to the SAME shape `beforePanel` was measured against - no drawer open -
    // and the only thing left to account for is the complaint's own badges.
    const closeY = revealTestId('machine-def-axis-drawer-close-Y')
    act(() => { fireEvent.click(closeY) })

    // No banner. Staying on the outer Machine tab throughout, the panel
    // gains exactly the one count that tab strip always shows regardless of
    // section - its own badge (WO-1687/1690: axis pins are this area's own).
    // The Legacy Wiring sub-tab's badge (unchanged, WO-943 - a pin claim
    // still legacy-maps to Wiring) is checked separately below; its nav does
    // not exist in the DOM while the outer bar is on Machine, so it cannot
    // be part of this count.
    expect(revealTestId('machine-definition-panel').querySelectorAll('*').length)
      .toBe(beforePanel + 1)
    expect(revealTestId('machine-def-tab-badge-machine').textContent).toBe('1')
  })

  it('saving a definition with a problem reports it into the machine console', () => {
    duplicatePins()
    save()
    const events = (state() as unknown as {
      consoleEvents: { severity: string; source: string; message: string }[]
    }).consoleEvents
    const complaint = events.find((e) => e.message.includes('machine definition saved with'))
    expect(complaint).toBeDefined()
    expect(complaint!.severity).toBe('warning')
    expect(complaint!.source).toBe('machine')
    expect(complaint!.message).toContain('Port 1 pin 8')
    // Saved AS TYPED - the complaint reports, it does not silently discard.
    const axes = savedProfile()!.controllerDefinition!.axes
    expect(axes.find((a) => a.axis === 'Y')!.stepPin).toEqual({ port: 1, pin: 8, negate: false })
  })

  it('a clean definition says nothing at all', () => {
    openEditor()
    definePress()
    save()
    const events = (state() as unknown as { consoleEvents: { message: string }[] }).consoleEvents
    expect(events.some((e) => e.message.includes('machine definition saved with'))).toBe(false)
  })

  // WO-942 REPIN: the modal's collapsed-disclosure summary is gone along with
  // the disclosure itself. The property it defended - "the definition reads
  // at a glance, with nothing opened" - is now stronger on the panel: the
  // header summary (`machine-def-panel-summary`, MachineDefinitionPanel.tsx
  // :632-640) is not a collapsed-state fallback, it is ALWAYS on screen,
  // whether or not any section below it has been touched.
  it('the header summary reports the definition without opening any section', () => {
    openEditor()
    definePress()
    setPin('X step', 1, 2, false)
    const summary = revealTestId('machine-def-panel-summary')
    expect(summary.textContent).toContain('XYZ')
    expect(summary.textContent).toContain('home Z,X,Y')
    // The summary's pin count is scoped to ENABLED axes only
    // (MachineDefinitionPanel.tsx:571-575: `visiblePins` is built from
    // `enabledAxes`) - unlike the RAW CELL COUNT the pin-rule test above
    // reads off every carried axis. "Define" enables exactly X/Y/Z
    // (createDefaultAxisDefinition: `enabled: axis === 'X' || 'Y' || 'Z'`),
    // unchanged by this repin, so the total here is still 3 axes x 6 pins +
    // 3 machine-wide = 21, same as before.
    expect(summary.textContent).toContain('1 of 21 pins')
  })
})
