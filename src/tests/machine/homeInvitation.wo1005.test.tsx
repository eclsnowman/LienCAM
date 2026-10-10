// @vitest-environment jsdom
//
// WO-1005: THE APP MUST STOP ISSUING AN UNCONDITIONAL "PRESS HOME ALL".
//
// HARDWARE DAMAGE, 2026-08-25 evening. Operator's Z endstop was driven into twice
// and physically damaged. Incident write-up:
// src/tests/evidence/WO-INCIDENT-2026-08-25-Z-ENDSTOP/.
//
// THE STATE THAT BITES IS NOT THE ONE ANYONE PICTURED, and it is the LIKELY
// NEXT EVENT rather than an edge case:
//
//   A homing cycle drives each axis TOWARDS its switch and leaves it parked ON
//   that switch - `homingValue`, zero positive travel left. `homed` lives only
//   in the machine-control store, which never persists (that store's header:
//   "none of it may ever persist"). So POWER OFF WITH THE AXES ON THEIR
//   SWITCHES - which is where homing put them - AND POWER BACK ON, and the app
//   comes up `homed=false` WITH THE MACHINE STILL PHYSICALLY ON EVERY SWITCH.
//
// In that state the old strings read:
//     'NO DATUM - HOME FIRST'
//     'This machine has not been homed this session, so it has no machine
//      datum. Press Home All before moving to any coordinate.'
// - which points the operator at the exact action that damaged the Z stop. X
// parks at 738 and Y at 724.5, and Y is a slaved gantry that drives in on both
// sides at once.
//
// WHAT THIS SUITE DOES NOT LET THE FIX BECOME, and this is the whole risk:
// `src/` CANNOT SEE THE SWITCH. Only the bridge can, and reading it is
// WO-1004's job. A string that implied a switch was clear would be strictly
// worse than the sentence it replaced - inventing a machine fact is the defect
// class of the entire week. So section 4 below is a NEGATIVE control over
// every string this order touches: none of them may report a switch as
// pressed or clear, and each one that mentions a switch must either ASK or say
// outright that the app cannot see it.
//
// DECIDE-AND-LOG (recorded in the WO): the order permitted "where the app
// knows the machine was left parked on its switches, say so", and it does not
// know. The machine-control store never persists, so `homed` and the parked
// position do not survive the reload - the very transition that creates the
// hazard is the one that erases the evidence. So the precondition is stated
// UNCONDITIONALLY, which is what the order requires when the state is not
// recoverable: "If it is not, do not fake it."
//
// Sections:
//   1. The chip contract, pure - no bare imperative, precondition attached.
//   2. The chip on the strip, rendered.
//   3. WO-990's acceptance, UNCHANGED and re-asserted here so this rewording
//      cannot quietly cost the switchless rule or the negative control.
//   4. NOTHING CLAIMS TO KNOW SWITCH STATE - across every string this order
//      touches, chip and both Home tooltips.
//   5. The Home controls in JogPanel carry the precondition in their tooltips.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { MachineController } from '../../lib/machine/controller'

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

const { ControlTransportBar, DATUM_CHIP, deriveDatumChip } = await import(
  '../../components/machine/ControlTransportBar'
)
const { JogPanel, HOME_PRECONDITION } = await import('../../components/machine/JogPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { connectMachine, disconnectMachine, getMachineController, __resetEstopInterlockForTest } =
  await import('../../lib/machine/machineSession')
const { createDefaultControllerDefinition, machineHasNoHomeSwitches } = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

/** A wiring diagram with nothing on the home inputs - the switchless machine.
 *  Copied from noDatumChip.wo990.test.tsx so the two suites argue about the
 *  same machine. */
function switchlessDefinition(): ControllerDefinition {
  const def = createDefaultControllerDefinition()
  def.axes.forEach((a, i) => {
    a.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
    a.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
  })
  return def
}

/** The same machine with its home switches wired - Operator's machine. */
function switchedDefinition(): ControllerDefinition {
  const def = switchlessDefinition()
  def.axes.forEach((a, i) => { a.homePin = { port: 2, pin: 1 + i, negate: false } })
  return def
}

function useMachine(
  definition: ControllerDefinition | null,
  extra: Record<string, unknown> = {},
): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    ...(definition ? { controllerDefinition: definition } : {}),
    ...extra,
  })
}

/** THE DANGEROUS MOMENT, reproduced exactly: a session that has just connected
 *  to a machine physically parked on its switches by the PREVIOUS session's
 *  homing cycle. Nothing in the store can tell this apart from a genuinely
 *  cold machine - that is the point, and why the wording has to work for both. */
function connectedAfterPowerCycle(): void {
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionDetail: 'simulator',
    machineState: 'idle',
    homed: false,
  })
}

const chip = () => screen.queryByTestId('control-datum-chip')

// ---------------------------------------------------------------------------
// 1. THE CHIP CONTRACT, PURE
// ---------------------------------------------------------------------------

describe('WO-1005 the chip stops issuing a bare imperative', () => {
  it('THE HEADLINE: "Press Home All" is gone from the chip, text and tooltip both', () => {
    const c = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })!
    const whole = `${c.text} ${c.title}`
    // The exact sentence that pointed at the exact action that damaged the
    // stop. Its absence is the acceptance item, so it is asserted as a string
    // and not as a shape.
    expect(whole).not.toContain('Press Home All')
    expect(whole).not.toMatch(/press home all/i)
    // Nor any other bare "just go and home it" phrasing that would be the
    // same sentence wearing different words.
    expect(whole).not.toMatch(/home (all )?(the machine )?before moving/i)
  })

  it('names homing as what establishes a datum, WITH the precondition in the same breath', () => {
    const c = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })!
    // Still the condition, still the remedy (WO-990's acceptance).
    expect(c.text).toMatch(/no datum/i)
    expect(c.text).toMatch(/home first/i)
    expect(c.title).toContain('Home All')
    // ...and now the precondition, attached to the suggestion rather than left
    // for the operator to already know: the cycle drives TOWARDS the switch,
    // so an axis already on one gets driven into it.
    expect(c.title).toMatch(/towards its switch/i)
    expect(c.title).toMatch(/driven into/i)
    // The check to run before pressing anything, on the visible chip itself -
    // the tooltip needs a hover, and the operator standing at the machine may
    // never take one.
    expect(c.text).toMatch(/check switches/i)
  })

  it('THE CHIP SURVIVES TRUNCATION: no prefix of it claims anything about a switch', () => {
    // The strip never wraps, so at narrow widths this chip ellipsizes. The
    // first draft read "NO DATUM - HOME FIRST, SWITCHES CLEAR?" and this suite
    // rejected it: cut the question mark and it becomes a report that the
    // switches are clear, said to an operator standing at a machine parked on
    // them. An imperative has no such failure mode - every prefix of "CHECK
    // SWITCHES" is still an instruction.
    const text = DATUM_CHIP.needsHome.text
    for (let i = 1; i <= text.length; i += 1) {
      const prefix = text.slice(0, i)
      for (const pattern of CLAIMS_A_READING) expect(prefix).not.toMatch(pattern)
      expect(prefix).not.toMatch(/\bclear\b/i)
      expect(prefix).not.toMatch(/\bpressed\b/i)
    }
  })

  it('the precondition is UNCONDITIONAL - it does not wait for evidence the app cannot have', () => {
    // The order allowed a narrower sentence IF the app could tell a machine
    // parked on its switches from a cold one. It cannot: `homed` and the
    // parked position live only in the machine-control store, which never
    // persists, so the power cycle that creates the hazard is the same event
    // that erases the evidence. Asserted here rather than described, so a
    // later seat cannot "improve" this into a conditional it has no input for.
    const store = useMachineControl as unknown as { persist?: unknown }
    expect(store.persist).toBeUndefined()
    expect(useMachineControl.getInitialState().homed).toBe(false)
    // Same sentence whatever else is true of the session.
    const cold = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })!
    useMachineControl.setState({ homed: true })
    useMachineControl.setState({ homed: false })
    const afterAHome = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })!
    expect(afterAHome.title).toBe(cold.title)
    expect(afterAHome.text).toBe(cold.text)
  })

  it('DATUM_CHIP.needsHome is the one copy of those strings - the chip reads from it', () => {
    const c = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })!
    expect(c.text).toBe(DATUM_CHIP.needsHome.text)
    expect(c.title).toBe(DATUM_CHIP.needsHome.title)
  })
})

// ---------------------------------------------------------------------------
// 2. THE CHIP ON THE STRIP - THE MOMENT AFTER THE POWER CYCLE
// ---------------------------------------------------------------------------

describe('WO-1005 on screen, connected to a machine that may be sitting on its switches', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.getState().setConnection('disconnected', '')
    useMachine(switchedDefinition())
    connectedAfterPowerCycle()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('the operator reads BOTH facts off the strip: no datum, and homing can drive in', () => {
    render(<ControlTransportBar />)
    const el = chip()!
    expect(el.getAttribute('data-datum-mode')).toBe('needs-home')
    expect(el.textContent).toMatch(/no datum/i)
    const title = el.getAttribute('title') ?? ''
    expect(title).toMatch(/towards its switch/i)
    expect(title).toMatch(/driven into/i)
  })

  it('and the rendered chip carries no "Press Home All" either', () => {
    render(<ControlTransportBar />)
    const el = chip()!
    expect(`${el.textContent} ${el.getAttribute('title')}`).not.toMatch(/press home all/i)
  })
})

// ---------------------------------------------------------------------------
// 3. WO-990'S ACCEPTANCE, UNCHANGED - a reword must not cost the old rules
// ---------------------------------------------------------------------------

describe('WO-1005 keeps WO-990 whole', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.getState().setConnection('disconnected', '')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('THE WORD "HOME" STILL NEVER APPEARS ON A SWITCHLESS MACHINE - text, tooltip, classes', () => {
    useMachine(switchlessDefinition())
    expect(machineHasNoHomeSwitches(useCamStore.getState().project.machine)).toBe(true)
    connectedAfterPowerCycle()
    render(<ControlTransportBar />)
    const el = chip()!
    expect(el.getAttribute('data-datum-mode')).toBe('work-coordinates')
    expect(`${el.textContent} ${el.getAttribute('title')} ${el.className}`).not.toMatch(/home/i)
    // Including the new precondition wording: a machine with no switches must
    // not be warned about driving into one.
    expect(`${el.textContent} ${el.getAttribute('title')}`).not.toMatch(/switch/i)
  })

  it('THE NEGATIVE CONTROL: a homed machine still shows NO CHIP AT ALL', () => {
    // The rewording adds words, and words are how a chip becomes furniture.
    // A datum exists; the chip is gone, not softened, not greyed.
    useMachine(switchedDefinition())
    useMachineControl.setState({
      connectionPhase: 'connected',
      connectionDetail: 'simulator',
      machineState: 'idle',
      homed: true,
    })
    render(<ControlTransportBar />)
    expect(screen.getByTestId('control-state-chip')).toBeTruthy()
    expect(chip()).toBeNull()
    expect(deriveDatumChip({ connected: true, homed: true, noHomeSwitches: false })).toBeNull()
    expect(deriveDatumChip({ connected: true, homed: true, noHomeSwitches: true })).toBeNull()
  })

  it('still one chip in the row that already exists - no banner, no modal, no new row', () => {
    useMachine(switchedDefinition())
    connectedAfterPowerCycle()
    const { container } = render(<ControlTransportBar />)
    const bar = screen.getByTestId('control-safety-bar')
    expect(chip()!.parentElement).toBe(bar)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.modal-backdrop, [role="dialog"]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. NOTHING CLAIMS TO KNOW SWITCH STATE
//
// The single most important section in this file. `src/` cannot see the
// switch. A string that reported one as pressed or clear would be a machine
// fact this app invented, and the operator would trust it standing at a
// machine that is holding a damaged stop.
// ---------------------------------------------------------------------------

/** Every string WO-1005 wrote or rewrote, named so the sweep below cannot
 *  silently miss one when a later order adds another. */
const WO_1005_STRINGS: Array<[string, string]> = [
  ['chip text', DATUM_CHIP.needsHome.text],
  ['chip tooltip', DATUM_CHIP.needsHome.title],
  ['home precondition', HOME_PRECONDITION],
]

/** Phrasings that would REPORT a switch reading rather than state a rule. */
const CLAIMS_A_READING = [
  /switch(es)?\s+(is|are|was|were)\b/i,
  /\b(is|are|was|were)\s+(currently\s+)?(pressed|triggered|closed|made|clear|free)\b/i,
  /\b(pressed|triggered|unpressed|untriggered|clear)\s+switch(es)?\b/i,
  /\bswitch(es)?\s+(pressed|triggered|clear|closed|open)\b/i,
  /\b(all|every|no)\s+axes?\s+(is|are)\s+(on|off|clear)/i,
  /\bthe machine is (on|off|clear of)\b/i,
]

describe('WO-1005 nothing in these strings reports a switch as pressed or clear', () => {
  it('no string claims a switch reading', () => {
    for (const [name, text] of WO_1005_STRINGS) {
      for (const pattern of CLAIMS_A_READING) {
        expect(`${name}: ${text}`).not.toMatch(pattern)
      }
    }
  })

  it('every string that mentions a switch tells the operator to CHECK it, never what it reads', () => {
    for (const [name, text] of WO_1005_STRINGS) {
      if (!/switch/i.test(text)) continue
      expect({ name, text, directsACheck: /\bcheck\b/i.test(text) })
        .toMatchObject({ directsACheck: true })
    }
  })

  it('the two strings with room for it say outright that the app cannot see the switches', () => {
    expect(DATUM_CHIP.needsHome.title).toMatch(/cannot see the switches/i)
    expect(HOME_PRECONDITION).toMatch(/cannot see the switches/i)
  })

  it('and none of them says the machine is safe to home, or homed, or referenced', () => {
    for (const [name, text] of WO_1005_STRINGS) {
      expect(`${name}: ${text}`).not.toMatch(/\bsafe to home\b/i)
      expect(`${name}: ${text}`).not.toMatch(/\bit is safe\b/i)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. THE HOME CONTROLS CARRY THE PRECONDITION
//
// The chip is the state; these buttons are the ACTION. WO-1005's survey found
// that every other "home first" string in `src/` is a refusal REASON - only
// the chip and these controls invite the press, so only these carry it.
// ---------------------------------------------------------------------------

/** The precondition, checked for what it must actually say rather than for
 *  being present - a constant can be gutted and still be spliced in. */
function expectsPrecondition(tooltip: string | null): void {
  expect(tooltip ?? '').toContain(HOME_PRECONDITION)
  expect(HOME_PRECONDITION).toMatch(/towards its switch/i)
  expect(HOME_PRECONDITION).toMatch(/driven into it/i)
  expect(HOME_PRECONDITION).toMatch(/off its home switch/i)
}

describe('WO-1005 the Home controls say what has to be true before they are pressed', () => {
  beforeEach(async () => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      machineJogContinuous: false,
      machineJogStepMm: 10,
      machineJogFeedMmMin: 1000,
    })
    await connectMachine('simulator')
    // Operator 2026-09-14 ("A: Flash, all motion off"): this section is about the
    // HOME_PRECONDITION wording on the Home tooltips, not the fresh-connect
    // E-STOP latch, which would otherwise cover it with ESTOP_BLOCKS_MOTION.
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', homed: false })
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
  })

  it('HOME ALL carries it - the control that commits the most motion', () => {
    // Note which button actually commits more: Home All sends the whole order,
    // so on a Z,X,Y machine it starts a full-length X seek. This is the press
    // the old chip sentence was sending the operator to.
    render(<JogPanel />)
    expectsPrecondition(screen.getByTestId('control-home').getAttribute('data-tooltip'))
  })

  it('...without losing WO-914: Home All still names the order it will run', () => {
    render(<JogPanel />)
    const tip = screen.getByTestId('control-home').getAttribute('data-tooltip') ?? ''
    expect(tip).toContain('Z, X, Y')
    expect(tip).toMatch(/run the homing cycle/i)
  })

  it('EVERY per-axis Home button carries it too - Z is the one that got damaged', () => {
    render(<JogPanel />)
    for (const axis of ['Z', 'X', 'Y'] as const) {
      const btn = screen.getByTestId(`control-home-${axis.toLowerCase()}`)
      expectsPrecondition(btn.getAttribute('data-tooltip'))
      // ...and WO-931's own words survive underneath it.
      expect(btn.getAttribute('data-tooltip')).toContain(`Home ${axis} ALONE`)
    }
  })

  it('the tooltips do not claim a switch reading either', () => {
    render(<JogPanel />)
    const tips = ['control-home', 'control-home-z', 'control-home-x', 'control-home-y']
      .map((id) => screen.getByTestId(id).getAttribute('data-tooltip') ?? '')
    for (const tip of tips) {
      for (const pattern of CLAIMS_A_READING) expect(tip).not.toMatch(pattern)
      expect(tip).toMatch(/cannot see the switches/i)
    }
  })

  it('a controller that runs its own cycle ($H) carries it as well - one Home All, same warning', () => {
    // GRBL: perAxisHoming is false, the per-axis buttons are absent (WO-927's
    // guarantee, untouched), and the ONE remaining home control is the one
    // that sends a whole-machine $H. It is the most dangerous button on that
    // controller and it must not be the one that says nothing.
    Object.defineProperty(getMachineController(), 'capabilities', {
      configurable: true,
      get: () => ({
        geometryQueue: false, executingMoveId: false, bufferSeconds: false,
        gcodeText: true, perAxisHoming: false,
        ownsSpindle: true, spindleCommands: true,
      }),
    })
    render(<JogPanel />)
    expect(screen.queryByTestId('control-home-z')).toBeNull()
    const tip = screen.getByTestId('control-home').getAttribute('data-tooltip')
    expectsPrecondition(tip)
    expect(tip).toMatch(/chooses its own axis order/)
  })

  it('NEGATIVE CONTROL: the precondition rides the HOME controls only, not every button', () => {
    // A warning on everything is a warning on nothing. Safe Z and Unlock do
    // not run a homing cycle, and Operator's standing rule is that a permanent
    // notice becomes furniture and gets ignored - which is how the homing rule
    // became invisible in the first place (WO-990).
    render(<JogPanel />)
    for (const id of ['control-safez', 'control-unlock', 'control-jog-x-plus']) {
      expect(screen.getByTestId(id).getAttribute('data-tooltip') ?? '')
        .not.toContain(HOME_PRECONDITION)
    }
  })

  it('and pressing Home All still homes - the wording changed, the control did not', () => {
    const home = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)
    fireEvent.click(screen.getByTestId('control-home'))
    expect(home).toHaveBeenCalledTimes(1)
    expect(home.mock.calls[0][0]).toEqual(['Z', 'X', 'Y'])
  })
})
