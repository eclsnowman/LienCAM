// @vitest-environment jsdom
//
// WO-995 - AN UNKNOWN PIN POLARITY IS NOT `false`.
//
// `PinRef.negate` used to be a plain boolean, so "nobody has told us" had
// nowhere to live and came out as `false` - a CLAIM that the signal is not
// inverted. Two places made that claim without being told anything:
// `UNASSIGNED_PIN`, for a pin nothing is wired to, and the profile importer,
// for an assigned pin whose negate key the file does not carry. The screen
// then drew the claim as an unchecked box, which is the form of it a person
// can actually act on. Inverting an e-stop is how that claim gets someone
// hurt, and the bridge refuses to guess it for exactly that reason.
//
// `negate` is now `boolean | null` and `null` means UNKNOWN. This file holds
// the four halves of that contract together, because they only mean anything
// together:
//
//   1. THE RECORD  - unknown is representable, and it is what the two silent
//                    cases produce.
//   2. THE CONTROL - a stated polarity is still that polarity. This is the
//                    negative control, and it is the half that a "fix" which
//                    turned every polarity into an unknown would fail.
//   3. THE SCREEN  - unknown draws as the indeterminate dash, never as an
//                    empty box, and a person clicking it RESOLVES it.
//   4. THE WIRE    - `null` crosses VERBATIM. This app translates no pin.
//
// Every expected value is derived from Operator's own profile or from the record
// under test. Where a literal appears it is the contract itself (`null`).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ControllerDefinition, MachineConfig, PinRef } from '../../types'
import {
  UNASSIGNED_PIN,
  createDefaultControllerDefinition,
  isPinAssigned,
} from '../../types'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). In-memory shim BEFORE the store import
// (the same scaffolding the other machine suites use). No app change.
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

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { useCamStore } = await import('../../store')

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8',
)

/** Operator's profile with every `Steppinnegate` line DELETED - the shape of a
 *  profile that simply does not carry the key. The step pins themselves are
 *  untouched and stay assigned, which is the case that matters: an ASSIGNED
 *  pin whose polarity nobody has stated. */
const withoutStepNegate = (): string => PROFILE
  .split(/\r?\n/)
  .filter((line) => !/^\s*Steppinnegate\s*=/i.test(line))
  .join('\n')

const axisOf = (profile: string, axis: string) => {
  const def = importUccncProfile(profile).definition
  if (!def) throw new Error('the real profile did not import at all')
  const found = def.axes.find((a) => a.axis === axis)
  if (!found) throw new Error('no ' + axis + ' axis in the imported definition')
  return found
}

// ---------------------------------------------------------------------------
// 1. THE RECORD
// ---------------------------------------------------------------------------

describe('WO-995 the record can say "nobody has told us"', () => {
  it('an unassigned pin carries null, not false', () => {
    expect(UNASSIGNED_PIN.negate).toBe(null)
    expect(isPinAssigned(UNASSIGNED_PIN)).toBe(false)
    // Still three keys. Unknown is a VALUE of negate, not the absence of it -
    // a missing key would vanish from the JSON the wire is made of.
    expect(Object.keys(UNASSIGNED_PIN).sort()).toEqual(['negate', 'pin', 'port'])
  })

  it('every pin of a blank definition is unknown, because nothing has been said', () => {
    const def = createDefaultControllerDefinition()
    const pins: PinRef[] = [
      def.io.estop, def.io.probe, def.io.probe2,
      ...def.axes.flatMap((a) => [
        a.stepPin, a.dirPin, a.homePin, a.limitMinusPin, a.limitPlusPin, a.enablePin,
      ]),
    ]
    expect(pins.length).toBeGreaterThan(0)
    for (const pin of pins) expect(pin.negate).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// 2. THE IMPORT, AND ITS NEGATIVE CONTROL
// ---------------------------------------------------------------------------

describe('WO-995 the importer stops inventing a polarity it was not given', () => {
  it('an ASSIGNED pin whose negate key the profile does not carry reads null', () => {
    const x = axisOf(withoutStepNegate(), 'X')
    // The pin is assigned - this is not the unassigned case wearing a disguise.
    expect(isPinAssigned(x.stepPin)).toBe(true)
    expect(x.stepPin.negate).toBe(null)
  })

  it('an unassigned pin reads null - X has no limit inputs at all', () => {
    const x = axisOf(PROFILE, 'X')
    expect(isPinAssigned(x.limitMinusPin)).toBe(false)
    expect(x.limitMinusPin.negate).toBe(null)
    expect(x.limitPlusPin.negate).toBe(null)
  })

  it('NEGATIVE CONTROL: a polarity the profile DOES state is read, unchanged', () => {
    const def = importUccncProfile(PROFILE).definition
    expect(def).not.toBeNull()
    // `Steppinnegate=False` - stated, and therefore false, not unknown.
    expect(axisOf(PROFILE, 'X').stepPin.negate).toBe(false)
    // `Estoppinnegate=True` - stated, and therefore true. A "fix" that turned
    // known polarities into unknowns would fail on this line.
    expect(def!.io.estop.negate).toBe(true)
  })

  it('NEGATIVE CONTROL: the SAME pin, one key apart - stated false vs unknown', () => {
    const stated = axisOf(PROFILE, 'X').stepPin
    const silent = axisOf(withoutStepNegate(), 'X').stepPin
    expect(stated.port).toBe(silent.port)
    expect(stated.pin).toBe(silent.pin)
    // Deleting the one key is the ONLY difference between the two profiles,
    // and it is the only thing that changes. `false` and `null` are not
    // interchangeable here.
    expect(stated.negate).toBe(false)
    expect(silent.negate).toBe(null)
    expect(stated.negate).not.toBe(silent.negate)
  })
})

// ---------------------------------------------------------------------------
// 3. THE SCREEN
// ---------------------------------------------------------------------------

const machineWith = (estop: PinRef, probe: PinRef, probe2: PinRef): MachineConfig => {
  const def: ControllerDefinition = createDefaultControllerDefinition()
  def.io = { estop, probe, probe2 }
  return {
    id: 'wo995', name: 'Polarity Bench', type: 'gantry_router', controller: 'uccnc',
    travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
    controllerDefinition: def,
  }
}

const state = () => useCamStore.getState()

function mount(machine: MachineConfig): void {
  act(() => {
    useCamStore.setState({
      machineLibrary: [machine],
      project: { ...state().project, machine },
      consoleEvents: [],
    })
  })
  render(createElement(MachineDefinitionPanel))
}

/** Pin polarity lives with the permanent area that owns the input. */
const reveal = (label: string): HTMLInputElement => {
  const here = screen.queryByLabelText(label)
  if (here) return here as HTMLInputElement
  const area = label.startsWith('E-stop') ? 'controller' : 'probing'
  act(() => { fireEvent.click(screen.getByTestId(`machine-def-tab-${area}`)) })
  const found = screen.queryByLabelText(label)
  if (found) return found as HTMLInputElement
  throw new Error('no group on the definition page carries a control labelled "' + label + '"')
}

const save = () => {
  act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) })
}

const savedDefinition = (): ControllerDefinition => {
  const saved = state().machineLibrary.find((m) => m.id === 'wo995')
  if (!saved?.controllerDefinition) throw new Error('nothing was saved')
  return saved.controllerDefinition
}

afterEach(() => { cleanup() })

describe('WO-995 an unknown polarity is drawn as unknown, never as an unchecked box', () => {
  // Three pins that differ in NOTHING but their polarity, so the assertions
  // below can only be about the polarity.
  const unknown: PinRef = { port: 2, pin: 9, negate: null }
  const stated: PinRef = { port: 2, pin: 10, negate: false }
  const inverted: PinRef = { port: 2, pin: 11, negate: true }

  it('null is the indeterminate dash - and an empty box means a STATED false', () => {
    mount(machineWith(unknown, stated, inverted))

    const unknownBox = reveal('E-stop negate')
    expect(unknownBox.indeterminate).toBe(true)
    expect(unknownBox.checked).toBe(false)

    // THE NEGATIVE CONTROL, on screen: a pin somebody actually said "not
    // inverted" about still draws as an empty box, and the empty box now
    // means only that.
    const statedBox = reveal('Probe negate')
    expect(statedBox.indeterminate).toBe(false)
    expect(statedBox.checked).toBe(false)

    const invertedBox = reveal('Tool setter negate')
    expect(invertedBox.indeterminate).toBe(false)
    expect(invertedBox.checked).toBe(true)
  })

  it('the unknown says so where a person reads it, not only in the record', () => {
    mount(machineWith(unknown, stated, inverted))
    expect(reveal('E-stop negate').getAttribute('data-tooltip')).toMatch(/UNKNOWN/)
    expect(reveal('Probe negate').getAttribute('data-tooltip')).not.toMatch(/UNKNOWN/)
  })

  it('a person clicking an unknown RESOLVES it, and it does not come back', () => {
    mount(machineWith(unknown, stated, inverted))

    // Every reveal is resolved BEFORE its act(): a nested act() does not
    // flush its state update until the outer one closes, so a query inside
    // one would still be looking at the tab we came from.
    // The first click on an indeterminate box states "inverted"...
    const box = reveal('E-stop negate')
    act(() => { fireEvent.click(box) })
    save()
    expect(savedDefinition().io.estop.negate).toBe(true)

    // ...and a second states "not inverted". Only a person's click ever
    // produces a polarity, and no click ever produces an unknown again.
    const again = reveal('E-stop negate')
    act(() => { fireEvent.click(again) })
    save()
    expect(savedDefinition().io.estop.negate).toBe(false)
    expect(reveal('E-stop negate').indeterminate).toBe(false)
  })

  it('editing the port and pin of an unknown leaves the unknown alone', () => {
    mount(machineWith({ ...UNASSIGNED_PIN }, stated, inverted))
    const port = reveal('E-stop port')
    act(() => { fireEvent.change(port, { target: { value: '2' } }) })
    const pin = reveal('E-stop pin')
    act(() => { fireEvent.change(pin, { target: { value: '9' } }) })
    save()

    // Wiring a pin up is not a statement about its polarity. The panel must
    // not take the opportunity to invent one.
    expect(savedDefinition().io.estop).toEqual({ port: 2, pin: 9, negate: null })
  })
})

// ---------------------------------------------------------------------------
// 4. THE WIRE
//
// DECIDED AND LOGGED (WO-995): `null` crosses the wire AS `null`. WO-928's
// rule is that the definition crosses VERBATIM and this app translates no pin,
// so coercing an unknown to `false` on the way out would be exactly the
// translation that rule forbids - and it would put the fabrication back one
// layer down, where nobody can see it. The bridge already owns that default
// and applies it at the moment it calls the board: `Json.Bool(p, "negate",
// false)` (Machine.cs:1140) for a wire pin, `B(sec, "Steppinnegate", false)`
// (Machine.cs:771) for a profile one. So what reaches the board is unchanged
// by this order; what changed is that the RECORD no longer pretends the
// default was a person's answer.
// ---------------------------------------------------------------------------

describe('WO-995 an unknown survives the wire as an unknown', () => {
  it('the JSON the wire is made of carries null, with the key still present', () => {
    const def = createDefaultControllerDefinition()
    def.io.estop = { port: 2, pin: 9, negate: null }
    def.io.probe = { port: 2, pin: 10, negate: false }

    const crossed = JSON.parse(JSON.stringify(def)) as ControllerDefinition

    // `undefined` would have vanished from the JSON entirely and the bridge
    // would have read a pin with no negate member at all. `null` is carried.
    expect('negate' in (crossed.io.estop as object)).toBe(true)
    expect(crossed.io.estop.negate).toBe(null)
    // And a stated polarity crosses as itself - the negative control again.
    expect(crossed.io.probe.negate).toBe(false)
    // Nothing else moved on the way across either.
    expect(crossed).toEqual(def)
  })
})
