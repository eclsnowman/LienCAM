// @vitest-environment jsdom
//
// WO-990: THE MACHINE SAYS IT HAS NO DATUM BEFORE ANYONE REACHES FOR A JOG KEY.
//
// Operator, at the machine 2026-08-24, after jogging Z-1 on an unhomed machine:
// "WHY IS THIS NOT THE DEFAULT THAT HOME IS FIRST REQUIRED AFTER CONNECTION IF
// HOME STATE IS NOT KNOWN. It should be CONNECT, CLEAR, HOME, THEN MOVE ...
// This is basic stuff. Why are you not seeing this as obvious."
//
// WHAT WENT WRONG IS NOT THE GATE. RequireHomed() refuses every move to a
// coordinate and always did; a RELATIVE jog stays allowed unhomed on purpose,
// which is how an axis comes off a limit switch. What he hit was the policy
// working in silence - the jog was allowed, soft limits stopped it at -0.1,
// and the first feedback arrived AFTER the attempt. The rule lived in prose
// all week and never in the software.
//
// SO EVERY TEST BELOW IS ABOUT WHEN THE SENTENCE IS ON SCREEN, not about what
// a move does. Nothing here jogs, and that is the point: each render is a
// FRESHLY CONNECTED session with no move attempted.
//
//   1. WITH SWITCHES, UNHOMED: the chip is there, it says there is no datum,
//      and it names HOME as the next action.
//   2. SWITCHLESS (WO-985's mode, both ways a machine declares it): the chip
//      says the machine is working in the work coordinate system and NEVER
//      says "home" - visible text and tooltip both. A chip pointing at HOME on
//      a machine with nothing to home with sends the operator off to fix
//      something that was never the problem, which is the exact defect WO-985
//      and WO-988 exist to remove.
//   3. THE NEGATIVE CONTROL, WATCHED ABSENT: on a homed machine the chip is
//      not present at all. A permanent chip is furniture and gets ignored,
//      which is how the rule became invisible in the first place.
//   4. NO MODAL, NO BANNER, NO NEW ROW: the chip is a direct child of the
//      strip that already exists, beside the state chip that is already there,
//      and the render puts no dialog on screen.
//
// Harness: the machine-control store is faked directly and ControlTransportBar
// is mounted alone (the established MACHINE-CONTROL split - readout/contract
// tests fake the store, only motion claims connect the simulator). The chip is
// derived from state alone, so there is nothing here a real transport could
// prove that the store cannot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

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
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition, machineHasNoHomeSwitches } = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

/** A wiring diagram with nothing on the home inputs - the switchless machine.
 *  Every other pin is assigned, so the mode cannot be passing by accident on
 *  "this definition is blank" (copied from switchlessMode.wo985.test.tsx, so
 *  the two suites are arguing about the same machine). */
function switchlessDefinition(): ControllerDefinition {
  const def = createDefaultControllerDefinition()
  def.axes.forEach((a, i) => {
    a.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
    a.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
  })
  return def
}

/** The same machine with its home switches wired - the negative control. */
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

/** A freshly connected, idle session. NOTHING has been jogged or refused -
 *  this is the moment the operator first looks at the strip. */
function freshlyConnected(homed: boolean): void {
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionDetail: 'simulator',
    machineState: 'idle',
    homed,
  })
}

const chip = () => screen.queryByTestId('control-datum-chip')

beforeEach(() => {
  useCamStore.getState().newProject()
  useMachineControl.getState().setConnection('disconnected', '')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// 1. The contract, without a render
// ---------------------------------------------------------------------------

describe('WO-990 deriveDatumChip - when the strip carries the sentence', () => {
  it('unhomed with switches: names the missing datum AND makes HOME the next action', () => {
    const c = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: false })
    expect(c).not.toBeNull()
    expect(c!.mode).toBe('needs-home')
    expect(c!.text).toBe(DATUM_CHIP.needsHome.text)
    expect(c!.text).toMatch(/no datum/i)
    expect(c!.text).toMatch(/home/i)
  })

  it('unhomed and switchless: the work coordinate system, and not one "home" anywhere', () => {
    const c = deriveDatumChip({ connected: true, homed: false, noHomeSwitches: true })
    expect(c!.mode).toBe('work-coordinates')
    expect(c!.text).toMatch(/no datum/i)
    expect(c!.text).toMatch(/work coordinates/i)
    expect(c!.title).toMatch(/work coordinate system/i)
    // Text, tooltip and CLASS NAMES: a class called control-home-outline would
    // put the word into the DOM of a machine that cannot home, and the next
    // seat reading it would learn the wrong thing.
    expect(`${c!.text} ${c!.title} ${c!.className}`).not.toMatch(/home/i)
  })

  it('homed, or not connected at all, and there is no chip to read', () => {
    expect(deriveDatumChip({ connected: true, homed: true, noHomeSwitches: false })).toBeNull()
    expect(deriveDatumChip({ connected: true, homed: true, noHomeSwitches: true })).toBeNull()
    expect(deriveDatumChip({ connected: false, homed: false, noHomeSwitches: false })).toBeNull()
    expect(deriveDatumChip({ connected: false, homed: false, noHomeSwitches: true })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. On screen, on a freshly connected session - BEFORE any move is attempted
// ---------------------------------------------------------------------------

describe('WO-990 a machine WITH home switches, connected and unhomed', () => {
  beforeEach(() => {
    useMachine(switchedDefinition())
    freshlyConnected(false)
  })

  it('says it has no datum the moment the strip renders - no move, no refusal first', () => {
    render(<ControlTransportBar />)
    const el = chip()
    expect(el).not.toBeNull()
    expect(el!.textContent).toMatch(/no datum/i)
  })

  it('makes HOME the obvious next action, and names the control by its real label', () => {
    render(<ControlTransportBar />)
    expect(chip()!.textContent).toMatch(/home first/i)
    expect(chip()!.getAttribute('title')).toContain('Home All')
    expect(chip()!.getAttribute('data-datum-mode')).toBe('needs-home')
  })

  it('wears the HOME family blue (WO-931), not a new stylesheet rule', () => {
    render(<ControlTransportBar />)
    // The same class the per-axis Home buttons and Home All wear.
    expect(chip()!.className).toContain('control-home-outline')
    // ...on the chip shape that already exists in this row.
    expect(chip()!.className).toContain('control-state-chip')
  })
})

// ---------------------------------------------------------------------------
// 3. The switchless machine - WO-985's mode, read, never re-derived
// ---------------------------------------------------------------------------

describe('WO-990 a machine that cannot home never gets sent to HOME', () => {
  it('with no home pin on any axis, the chip is about work coordinates', () => {
    useMachine(switchlessDefinition())
    expect(machineHasNoHomeSwitches(useCamStore.getState().project.machine)).toBe(true)
    freshlyConnected(false)
    render(<ControlTransportBar />)
    expect(chip()!.getAttribute('data-datum-mode')).toBe('work-coordinates')
    expect(chip()!.textContent).toMatch(/work coordinates/i)
    expect(chip()!.getAttribute('title')).toMatch(/work coordinate system/i)
  })

  it('says nothing about homing - visible text, tooltip and classes all clean', () => {
    useMachine(switchlessDefinition())
    freshlyConnected(false)
    render(<ControlTransportBar />)
    const el = chip()!
    expect(`${el.textContent} ${el.getAttribute('title')} ${el.className}`).not.toMatch(/home/i)
  })

  it('honours the WO-301 noHomingSwitches declaration too - the other way a machine says it', () => {
    // Home pins wired, but the machine declares it does not home with them.
    // The mode is read from WO-985's predicate, so both routes reach it and
    // this file never asks about homePin itself.
    useMachine(switchedDefinition(), { noHomingSwitches: true })
    freshlyConnected(false)
    render(<ControlTransportBar />)
    expect(chip()!.getAttribute('data-datum-mode')).toBe('work-coordinates')
  })

  it('a single wired home pin is evidence of switches - the mode stays shut', () => {
    const def = switchlessDefinition()
    def.axes[1].homePin = { port: 2, pin: 5, negate: false }
    useMachine(def)
    freshlyConnected(false)
    render(<ControlTransportBar />)
    expect(chip()!.getAttribute('data-datum-mode')).toBe('needs-home')
  })
})

// ---------------------------------------------------------------------------
// 4. THE NEGATIVE CONTROL, watched absent
// ---------------------------------------------------------------------------

describe('WO-990 the chip is not furniture', () => {
  it('is ABSENT on a homed machine - the state chip is still there, this one is gone', () => {
    useMachine(switchedDefinition())
    freshlyConnected(true)
    render(<ControlTransportBar />)
    expect(screen.getByTestId('control-state-chip')).toBeTruthy()
    expect(chip()).toBeNull()
  })

  it('is absent on a homed switchless machine too - a datum exists, whatever set it', () => {
    // WO-986 types the machine position in by hand and sets `homed` without a
    // homing cycle. When it lands, this chip must already be gone - it keys on
    // the datum, not on the switches.
    useMachine(switchlessDefinition())
    freshlyConnected(true)
    render(<ControlTransportBar />)
    expect(chip()).toBeNull()
  })

  it('is absent while disconnected - there is no machine yet to have a datum', () => {
    useMachine(switchedDefinition())
    render(<ControlTransportBar />)
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Not connected')
    expect(chip()).toBeNull()
  })

  it('appears the instant the session connects unhomed, and clears the instant it homes', () => {
    useMachine(switchedDefinition())
    const { rerender } = render(<ControlTransportBar />)
    expect(chip()).toBeNull()
    freshlyConnected(false)
    rerender(<ControlTransportBar />)
    expect(chip()).not.toBeNull()
    useMachineControl.setState({ homed: true })
    rerender(<ControlTransportBar />)
    expect(chip()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. No modal, no banner, no new row
// ---------------------------------------------------------------------------

describe('WO-990 it lives in the row that already exists', () => {
  beforeEach(() => {
    useMachine(switchedDefinition())
    freshlyConnected(false)
  })

  it('renders INSIDE the existing strip, as a direct sibling of the state chip', () => {
    render(<ControlTransportBar />)
    const bar = screen.getByTestId('control-safety-bar')
    const el = within(bar).getByTestId('control-datum-chip')
    // Direct child: not wrapped in a new container of its own, which is how a
    // "chip" becomes a row.
    expect(el.parentElement).toBe(bar)
    expect(screen.getByTestId('control-state-chip').parentElement).toBe(bar)
  })

  it('opens no dialog and adds no banner element', () => {
    const { container } = render(<ControlTransportBar />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('.modal-backdrop, [role="dialog"]')).toBeNull()
    // The one banner in this row is WO-048's next-action line, which existed
    // before this order and is not what carries the datum sentence.
    expect(chip()!.className).not.toContain('control-next-action')
  })

  it('is present in the SPLIT mount too - the nav strip, once, never twice', () => {
    render(
      <>
        <ControlTransportBar sections="transport" />
        <ControlTransportBar sections="nav" onSelectView={() => {}} />
      </>,
    )
    const all = screen.getAllByTestId('control-datum-chip')
    expect(all).toHaveLength(1)
    expect(all[0].parentElement).toBe(screen.getByTestId('control-subnav-bar'))
  })
})
