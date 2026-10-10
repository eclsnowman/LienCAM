// WO-912 - the machine definition data model.
//
// The shape a person fills in to describe a CNC they built. Four later work
// orders (WO-913 the editor, WO-914 the homing order on the wire, WO-915 the
// live apply, WO-916 the .pro import) code against these exact names and
// units, so this suite pins them.
//
// Three things here are not style preferences and must not be "cleaned up":
//
//   1. A pin is stored as (port, pin) and NEVER as a UCpin. The guard test
//      below fails if a translation table ever appears in src/.
//   2. The default homing order is Z FIRST, a safety default.
//   3. There is NO second persistence path. The definition rides the machine
//      library the app already persists.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSourceSweep, toRepoPath } from '../support/srcSweep'
import {
  useCamStore,
  persistPartialize,
  persistMigrate,
  persistMerge,
  PERSIST_STORE_VERSION,
} from '../../store'
import {
  AXIS_NAMES,
  DEFAULT_HOMING_ORDER,
  DEFAULT_HOME_BACK_OFF,
  UNASSIGNED_PIN,
  isPinAssigned,
  createDefaultAxisDefinition,
  createDefaultAxisHomingDefinition,
  createDefaultControllerDefinition,
  controllerDefinitionPins,
  validateControllerDefinition,
} from '../../types'
import type {
  AxisDefinition,
  AxisHomingDefinition,
  AxisName,
  ControllerDefinition,
  MachineConfig,
  PinRef,
} from '../../types'

const state = () => useCamStore.getState()

const savedLibrary = state().machineLibrary
afterEach(() => {
  useCamStore.setState({ machineLibrary: savedLibrary })
})

// A fully populated definition: every field set to a value distinguishable
// from its default, so a round-trip that silently drops or defaults one is
// visible. Numbers are the ones a person reads off a wiring diagram.
const pin = (port: number, p: number, negate = false): PinRef => ({ port, pin: p, negate })

const fullAxis = (
  axis: AxisName,
  base: number,
  slaveAxis: AxisName | null = null,
): AxisDefinition => ({
  axis,
  enabled: true,
  stepsPerUnit: 800 + base,
  maxVelocity: 7200 + base,
  acceleration: 450 + base,
  softLimitMin: -1 - base,
  softLimitMax: 900 + base,
  slaveAxis,
  stepPin: pin(1, base + 1, false),
  dirPin: pin(1, base + 2, true),
  homePin: pin(2, base + 1, false),
  limitMinusPin: pin(3, base + 10, true),
  limitPlusPin: pin(3, base + 11, false),
  enablePin: pin(3, base + 30, false),
  enableDelayMs: 25 + base,
  backlash: { enabled: true, distance: 0.05 },
})

const fullHoming = (axis: AxisName): AxisHomingDefinition => ({
  direction: axis === 'Z' ? 'positive' : 'negative',
  fastSpeed: 1800,
  slowSpeed: 120,
  backOff: 3.5,
  homingValue: axis === 'Z' ? 0 : -12.5,
  autoZero: true,
})

const fullDefinition = (): ControllerDefinition => ({
  axes: [fullAxis('X', 0), fullAxis('Y', 3, 'A'), fullAxis('Z', 6), fullAxis('A', 9)],
  homing: {
    order: ['Z', 'X', 'Y'],
    perAxis: { X: fullHoming('X'), Y: fullHoming('Y'), Z: fullHoming('Z') },
  },
  io: { estop: pin(2, 5, true), probe: pin(2, 6, false), probe2: pin(3, 15, false) },
})

// ---------------------------------------------------------------------------
// The shape the later lanes code against
// ---------------------------------------------------------------------------

describe('WO-912 the shape: names and units the later orders code against', () => {
  it('AxisDefinition carries exactly the fields the bridge reads per axis', () => {
    const a = createDefaultAxisDefinition('X')
    expect(Object.keys(a).sort()).toEqual([
      'acceleration',
      'axis',
      'backlash',
      'dirPin',
      'enableDelayMs',
      'enablePin',
      'enabled',
      'homePin',
      'limitMinusPin',
      'limitPlusPin',
      'maxVelocity',
      'slaveAxis',
      'softLimitMax',
      'softLimitMin',
      'stepPin',
      'stepsPerUnit',
    ])
    expect(Object.keys(a.backlash).sort()).toEqual(['distance', 'enabled'])
  })

  it('AxisHomingDefinition carries exactly the per-axis homing fields', () => {
    expect(Object.keys(createDefaultAxisHomingDefinition('X')).sort()).toEqual([
      'autoZero',
      'backOff',
      'direction',
      'fastSpeed',
      'homingValue',
      'slowSpeed',
    ])
  })

  it('ControllerDefinition is axes + homing{order,perAxis} + io{estop,probe,probe2} + settings + stated', () => {
    // REPINNED 2026-08-27 (WO-960). `settings` and `stated` are landed product
    // groups, not drift: `settings` is ADR-0044 Amendment 1's container for a
    // setting this software can show but not yet send, and `stated` is
    // WO-1037's record of which keys a profile ACTUALLY stated - the thing that
    // stops an omitted `Softlimitpositive` reading as a soft limit of 0 nobody
    // wrote. `createDefaultControllerDefinition` emits both EMPTY, because for
    // a machine somebody is filling in by hand "states nothing yet" is the true
    // answer and absent is not.
    //
    // It is repinned here rather than left red because a stale red is not
    // neutral - it is this order's own sixth finding. The next session reads
    // "ControllerDefinition grew two keys it should not have" and deletes a
    // container two orders deliberately added.
    const def = createDefaultControllerDefinition()
    expect(Object.keys(def).sort()).toEqual(['axes', 'homing', 'io', 'settings', 'stated'])
    expect(Object.keys(def.homing).sort()).toEqual(['order', 'perAxis'])
    expect(Object.keys(def.io).sort()).toEqual(['estop', 'probe', 'probe2'])
  })

  it('the per-axis limit and enable pins live on the AXIS, not in io', () => {
    // The bridge reads them from the axis section (Machine.cs:445-456); io
    // holds only the machine-wide inputs. The scope doc sketched limits in
    // io and the bridge, as the consumer, wins.
    const def = createDefaultControllerDefinition()
    const io = def.io as unknown as Record<string, unknown>
    expect('limits' in io).toBe(false)
    expect('limitMinusPin' in io).toBe(false)
    expect('enablePin' in io).toBe(false)
    for (const a of def.axes) {
      expect(a.limitMinusPin).toBeDefined()
      expect(a.limitPlusPin).toBeDefined()
      expect(a.enablePin).toBeDefined()
      expect(a.homePin).toBeDefined()
    }
  })

  it('a PinRef is (port, pin, negate) and nothing else', () => {
    expect(Object.keys(UNASSIGNED_PIN).sort()).toEqual(['negate', 'pin', 'port'])
    // Three keys, and the third is `null` - NOT `false` (WO-995). A pin that
    // nothing is wired to has no polarity to have, and `false` would claim it
    // has one and that it is "not inverted". The key is still PRESENT: the
    // shape is (port, pin, negate) and nothing else, unknown or not.
    expect(UNASSIGNED_PIN).toEqual({ port: 0, pin: 0, negate: null })
    expect(isPinAssigned(UNASSIGNED_PIN)).toBe(false)
    expect(isPinAssigned(pin(1, 15))).toBe(true)
  })

  it('the six axis names are X Y Z A B C, in the order the API indexes them', () => {
    expect([...AXIS_NAMES]).toEqual(['X', 'Y', 'Z', 'A', 'B', 'C'])
  })

  it('velocities are units per MINUTE - what a person types; src never divides by 60', () => {
    // The bridge converts to units/sec at the moment it calls the board
    // (Machine.cs:415, 496-497). If this layer ever pre-divides, the board
    // gets 60x too slow and nothing here would say so.
    const a = createDefaultAxisDefinition('X')
    expect(a.maxVelocity).toBe(6000)
    const h = createDefaultAxisHomingDefinition('X', a.maxVelocity)
    expect(h.fastSpeed).toBe(1500) // 6000 / 4, still per MINUTE
    expect(h.slowSpeed).toBe(375) // 6000 / 16, still per MINUTE
  })
})

// ---------------------------------------------------------------------------
// Safety defaults
// ---------------------------------------------------------------------------

describe('WO-912 safety defaults', () => {
  it('SAFETY DEFAULT, NOT A PREFERENCE: the default homing order homes Z FIRST', () => {
    // Z last on a router with a tool in the spindle drives the tool THROUGH
    // THE WORK on its way to the X or Y switch. Retracting Z before anything
    // moves in the plane is the only order that cannot do that. Do not
    // "tidy" this into alphabetical order, and do not make it configurable
    // by defaulting to whatever a profile happened to hold: the profile's
    // own home sequence is parsed nowhere in the bridge, so this default IS
    // the setting.
    expect(DEFAULT_HOMING_ORDER[0]).toBe('Z')
    expect([...DEFAULT_HOMING_ORDER]).toEqual(['Z', 'X', 'Y'])
    expect(createDefaultControllerDefinition().homing.order[0]).toBe('Z')
    expect(createDefaultControllerDefinition(['X', 'Y', 'Z', 'A']).homing.order[0]).toBe('Z')
  })

  it('SAFETY DEFAULT: Z homes in the POSITIVE direction - up, away from the work', () => {
    const def = createDefaultControllerDefinition()
    expect(def.homing.perAxis.Z?.direction).toBe('positive')
  })

  it('SAFETY DEFAULT: no axis is given a slave axis nobody asked for', () => {
    // On a gantry, if the board is not actually holding the slave when a
    // homing cycle starts, one side drives into its switch alone and the
    // gantry racks (Machine.cs:296-303). Absent means none.
    for (const axis of AXIS_NAMES) {
      expect(createDefaultAxisDefinition(axis).slaveAxis).toBeNull()
    }
    for (const a of createDefaultControllerDefinition(['X', 'Y', 'Z', 'A']).axes) {
      expect(a.slaveAxis).toBeNull()
    }
  })

  it('SAFETY DEFAULT: the home back-off is not zero, so a finished cycle is observable', () => {
    // An axis parked on its own switch leaves the home input still made, so
    // "did the cycle finish where it should" has no observable answer
    // (Operator, at the machine 2026-08-21).
    expect(DEFAULT_HOME_BACK_OFF).toBeGreaterThan(0)
    for (const axis of ['X', 'Y', 'Z'] as AxisName[]) {
      expect(createDefaultControllerDefinition().homing.perAxis[axis]?.backOff)
        .toBeGreaterThan(0)
    }
  })

  it('no pin is guessed: a blank definition leaves every pin unassigned', () => {
    const def = createDefaultControllerDefinition()
    for (const { pin: p } of controllerDefinitionPins(def)) {
      expect(isPinAssigned(p)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// THE PIN RULE
// ---------------------------------------------------------------------------

const SRC_ROOT = join(process.cwd(), 'src')
const SELF = 'src/tests/machine/machineDefinition.wo912.test.ts'
const NEGATIVE_CONTROL_DIR = join(SRC_ROOT, '.vite', 'wo977-ucpin-negative-control')
const NEGATIVE_CONTROL_FILE = join(NEGATIVE_CONTROL_DIR, 'axbbPinDef.ts')
const BEHIND_A_COMMENT_FILE = join(NEGATIVE_CONTROL_DIR, 'behindAComment.ts')

// Comments are stripped first, on purpose: the types file and this test EXPLAIN
// the rule in prose and must be free to name the thing they forbid. What is
// forbidden is the table in CODE.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

// The port-1 head of AxbbPinDef (pendant/uccnc-bridge/Machine.cs:45-98):
// pin 1 -> 26, pin 2 -> 47, pin 3 -> 31, pin 4 -> 32. Four values in that
// exact order, close together, is the table's fingerprint - it has no
// arithmetic rule, so nothing else produces that sequence by accident.
const UCPIN_TABLE_FINGERPRINT = /\b26\b[\s\S]{0,60}?\b47\b[\s\S]{0,60}?\b31\b[\s\S]{0,60}?\b32\b/
// The identifier check names a DECLARATION that could hold the table - a
// binding, function, class or type whose name says UCpin / AxbbPinDef. The
// bare word is not enough: since WO-1002 the bridge's translation is REPORTED
// in src/ ("UCpin 26" as a display string, `ucPin` as a reported field, the
// word in comments) and none of that computes anything - the fingerprint
// above is what catches a table, this only catches a table's NAME.
const UCPIN_IDENTIFIER =
  /\b(?:const|let|var|function|class|type|interface|enum)\s+(?:uc_?pin\w*|\w*axbbpindef\w*|\w*pindef_axbb\w*)\b/i

// WO-960 - THE CHEAP SCREEN, AND WHY IT CANNOT HIDE ANYTHING.
//
// This guard reads every .ts/.tsx under src/. That breadth IS the guarantee and
// must never be narrowed. But comment-stripping and the two regexes above were
// being paid on all 31 MB of it, twice per run, and under load this file went
// over vitest's 5,000 ms per-test timeout - captured, not inferred, in
// src/tests/evidence/WO-960/. The screen below reads the same bytes and lets
// ~90% of the files skip the expensive part.
//
// It is a STRICT SUPERSET of the two checks, and that is an argument rather
// than a hope. stripComments only ever DELETES characters or replaces a block
// comment with a single space. It can neither introduce a character nor join
// two halves of a token - a block comment leaves a space behind, and a line
// comment's own newline survives it. So every literal that appears in the
// STRIPPED text was already present in the RAW text:
//
//   the four fingerprint numbers, with their word boundaries dropped;
//   ucpin -> cpin, uc_pin -> _pin, axbbpindef and pindef_axbb -> pind.
//
// The "behind a comment" fixture below is the case that would catch a screen
// written by eye: its four numbers are 60+ characters apart until the comment
// between them is stripped.
const MAY_HOLD_THE_TABLE = (raw: string): boolean =>
  raw.includes('26') && raw.includes('47') && raw.includes('31') && raw.includes('32')
const MAY_HOLD_THE_IDENTIFIER = /cpin|_pin|pind/i

const ucPinSweep = createSourceSweep<string>({
  skip: (rel) => rel === SELF,
  screen: (raw) => MAY_HOLD_THE_TABLE(raw) || MAY_HOLD_THE_IDENTIFIER.test(raw),
  inspect: (raw, rel) => {
    const code = stripComments(raw)
    const hits: string[] = []
    if (UCPIN_TABLE_FINGERPRINT.test(code)) hits.push('the AxbbPinDef port-1 value sequence')
    if (UCPIN_IDENTIFIER.test(code)) hits.push('a UCpin/AxbbPinDef identifier')
    return hits.length > 0 ? [rel + ' - ' + hits.join(' and ')] : []
  },
})

const findUCPinOffenders = (): Promise<string[]> => ucPinSweep.run()

// WO-960 - THE NEGATIVE CONTROLS MEASURE A DIFFERENCE, NOT A TOTAL.
//
// They used to assert the WHOLE offender list equalled the one fixture they
// planted, which quietly made each of them a second copy of "src/ is clean".
// So the standing offenders in the tree - the legitimate `ucPin` REPORTING
// path WO-1020 and WO-1002 landed, which this rule's identifier regex cannot
// tell apart from a second table - turn the negative control red for a reason
// that has nothing to do with whether the guard fires. A control that goes red
// for an unrelated edit is precisely what this order was raised about.
//
// The difference is STRICTER than a `toContain`: it proves that planting the
// fixture adds exactly that one finding and removes none. "Is src/ clean" keeps
// its own test below, where it belongs and where its message is readable.
const offendersAddedBy = async (write: () => void): Promise<string[]> => {
  const before = new Set(await findUCPinOffenders())
  write()
  const after = await findUCPinOffenders()
  const removed = [...before].filter((entry) => !after.includes(entry))
  expect(removed, 'planting a fixture removed a standing finding').toEqual([])
  return after.filter((entry) => !before.has(entry))
}

const writeControlFile = (path: string, contents: string): void => {
  ucPinSweep.forget(path)
  mkdirSync(NEGATIVE_CONTROL_DIR, { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

const removeControlFiles = (): void => {
  ucPinSweep.forget(NEGATIVE_CONTROL_FILE)
  ucPinSweep.forget(BEHIND_A_COMMENT_FILE)
  rmSync(NEGATIVE_CONTROL_DIR, { recursive: true, force: true })
}

describe('WO-912 THE PIN RULE: a pin is carried as (port, pin), never computed', () => {
  it('detects the AXBB table when it IS present (the guard is not vacuous)', async () => {
    // .vite is ignored by git, so an interrupted test cannot leave a fixture
    // that normal staging will pick up. The finally removes it on every exit.
    removeControlFiles()
    try {
      const added = await offendersAddedBy(() => {
        writeControlFile(NEGATIVE_CONTROL_FILE, 'const AxbbPinDef = [26, 47, 31, 32]\n')
      })

      expect(added).toEqual([
        toRepoPath(NEGATIVE_CONTROL_FILE)
          + ' - the AxbbPinDef port-1 value sequence and a UCpin/AxbbPinDef identifier',
      ])
    } finally {
      removeControlFiles()
    }
  })

  it('detects a table only a comment strip makes visible - the screen cannot hide it', async () => {
    // WO-960. The fast screen added for cost must not be able to make this
    // guard vacuous, and the shape that would expose a screen written by eye is
    // a table whose numbers are too far apart to match UNTIL the comment
    // between them goes. Raw, these four are 90+ characters apart; stripped,
    // they are adjacent. The guard must still fire.
    removeControlFiles()
    try {
      const filler = '/* ' + '.'.repeat(90) + ' */'
      const added = await offendersAddedBy(() => {
        writeControlFile(
          BEHIND_A_COMMENT_FILE,
          'export const table = [26, ' + filler + ' 47, ' + filler + ' 31, ' + filler + ' 32]\n',
        )
      })

      expect(added).toEqual([
        toRepoPath(BEHIND_A_COMMENT_FILE) + ' - the AxbbPinDef port-1 value sequence',
      ])
    } finally {
      removeControlFiles()
    }
  })

  it('the cheap screen never hides a file the full check would flag', () => {
    // WO-960. A screen that is not a superset silences the guard without
    // anything going red, so it gets its own check rather than a comment. Every
    // string here is one the full check flags; the screen must accept all of
    // them, including the ones only a comment strip makes visible.
    const mustPass = [
      'const AxbbPinDef = [26, 47, 31, 32]',
      'const t = [26, /* x */ 47, /* x */ 31, /* x */ 32]',
      'const t = [26, 47, 31, 32] // a trailing note',
      'const ucPin = 1',
      'const uc_pin = 1',
      'const UCPIN = 1',
      'type AxbbPinDef = number',
      'const PINDEF_AXBB = []',
      'const x = 1 //\nconst UcPin = 2',
    ]
    for (const source of mustPass) {
      const code = stripComments(source)
      const flagged = UCPIN_TABLE_FINGERPRINT.test(code) || UCPIN_IDENTIFIER.test(code)
      expect(flagged, 'the full check should flag: ' + JSON.stringify(source)).toBe(true)
      expect(
        MAY_HOLD_THE_TABLE(source) || MAY_HOLD_THE_IDENTIFIER.test(source),
        'the screen would HIDE a real offender: ' + JSON.stringify(source),
      ).toBe(true)
    }
  })

  it('fails if a UCpin translation table appears anywhere in src/', async () => {
    const offenders = await findUCPinOffenders()

    expect(
      offenders,
      [
        '',
        'A UCpin translation appears in src/. Delete it. The reason, so it',
        'outlives everyone who remembers it:',
        '',
        '  The number the UC100 API wants is NOT the pin number on the',
        '  connector. UCCNC runs every pin through a scrambled per-board-type',
        '  lookup (AxbbPinDef, pendant/uccnc-bridge/Machine.cs:45-98) with no',
        '  arithmetic rule. The bridge owns the ONE copy of that table and',
        '  applies it at the moment it calls the board.',
        '',
        '  A second copy in TypeScript diverges from the C# one INVISIBLY.',
        '  There is no error to see: the board accepts, plans and counts every',
        '  move written to the wrong pin and emits nothing. That is exactly',
        '  how a whole first hardware session ran silent - the values landed',
        '  on direction lines, an unused aux output, and pins that do not',
        '  exist, and readback "passed" because the board had stored exactly',
        '  the wrong number we gave it.',
        '',
        '  Not for validation, not for a preview, not just to show the user.',
        '  A pin number is carried, never computed. (WO-912; scope 8.1.)',
        '',
        'Offending files:',
        ...offenders.map((o) => '  ' + o),
        '',
      ].join('\n'),
    ).toEqual([])
  })

  it('validates range only: port and pin are whole numbers above zero', () => {
    const def = createDefaultControllerDefinition()
    def.axes[0].stepPin = { port: 0, pin: 4, negate: false }
    def.axes[1].dirPin = { port: 1, pin: -3, negate: false }
    def.axes[2].homePin = { port: 2, pin: 1.5, negate: false }
    const problems = validateControllerDefinition(def)
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toContain('X step')
    expect(problems.join('\n')).toContain('Y dir')
    expect(problems.join('\n')).toContain('Z home')
  })

  it('validates duplication only: no two things claim the same (port, pin)', () => {
    const def = createDefaultControllerDefinition()
    def.axes[0].stepPin = pin(1, 9)
    def.axes[1].stepPin = pin(1, 9)
    def.io.estop = pin(2, 1)
    def.io.probe = pin(2, 1)
    const problems = validateControllerDefinition(def)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('Port 1 pin 9')
    expect(problems[1]).toContain('e-stop')
  })

  it('a fully wired definition validates clean, and unassigned pins never collide', () => {
    expect(validateControllerDefinition(fullDefinition())).toEqual([])
    // Every pin unassigned is (0,0) many times over and must NOT read as a
    // duplicate claim.
    expect(validateControllerDefinition(createDefaultControllerDefinition())).toEqual([])
  })

  it('flags a duplicated axis and a homing order that names an axis that is not there', () => {
    const def = createDefaultControllerDefinition()
    def.axes.push(createDefaultAxisDefinition('X'))
    def.homing.order = ['Z', 'X', 'X', 'B']
    const problems = validateControllerDefinition(def).join('\n')
    expect(problems).toContain('Axis X is listed more than once.')
    expect(problems).toContain('Homing order lists X more than once.')
    expect(problems).toContain('Homing order lists B, which is not one of the axes.')
  })
})

// ---------------------------------------------------------------------------
// Persistence: the machine library the app ALREADY has
// ---------------------------------------------------------------------------

// The real persist path, exactly as zustand runs it on a reload: partialize ->
// JSON -> migrate -> merge. Not a hand-rolled JSON.stringify; the point of the
// test is that the EXISTING mechanism carries the new field.
const reloadThroughPersist = (): MachineConfig[] => {
  const written = JSON.parse(JSON.stringify(persistPartialize(state())))
  const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
  const merged = persistMerge(migrated, state())
  return merged.machineLibrary
}

describe('WO-912 persistence rides the machine library that already exists', () => {
  it('a definition round-trips through the real store path with every field intact', () => {
    const def = fullDefinition()
    const machine: MachineConfig = {
      ...savedLibrary[0],
      id: 'wo912-round-trip',
      name: 'WO-912 round trip',
      controller: 'uccnc',
      controllerDefinition: def,
    }
    state().addMachineToLibrary(machine)

    const reloaded = reloadThroughPersist().find((m) => m.id === 'wo912-round-trip')
    expect(reloaded).toBeDefined()
    expect(reloaded?.controllerDefinition).toEqual(def)
    // Spot-check the values that would be silently defaulted if something
    // reconstructed the object instead of carrying it.
    expect(reloaded?.controllerDefinition?.axes[1].slaveAxis).toBe('A')
    expect(reloaded?.controllerDefinition?.axes[1].stepPin).toEqual(pin(1, 4, false))
    expect(reloaded?.controllerDefinition?.io.probe2).toEqual(pin(3, 15, false))
    expect(reloaded?.controllerDefinition?.homing.order).toEqual(['Z', 'X', 'Y'])
    expect(reloaded?.controllerDefinition?.homing.perAxis.Y?.homingValue).toBe(-12.5)
  })

  it('the default machine and existing profiles survive with the field ABSENT', () => {
    // ADR-0040 owes no migration to old .camproject FILES, but a profile
    // already in the store is a different thing and must not break.
    const before = state().machineLibrary
    expect(before.length).toBeGreaterThan(0)
    expect('controllerDefinition' in before[0]).toBe(false)

    const reloaded = reloadThroughPersist()
    expect(reloaded).toEqual(before)
    expect('controllerDefinition' in reloaded[0]).toBe(false)
    expect(reloaded[0].controllerDefinition).toBeUndefined()
  })

  it('the existing CRUD actions carry the field with no new action', () => {
    const def = createDefaultControllerDefinition()
    state().addMachineToLibrary({
      ...savedLibrary[0],
      id: 'wo912-crud',
      name: 'WO-912 crud',
      controller: 'uccnc',
    })
    state().updateMachineInLibrary('wo912-crud', { controllerDefinition: def })
    expect(
      state().machineLibrary.find((m) => m.id === 'wo912-crud')?.controllerDefinition,
    ).toEqual(def)

    state().removeMachineFromLibrary('wo912-crud')
    expect(state().machineLibrary.some((m) => m.id === 'wo912-crud')).toBe(false)
  })

  it('NO SECOND PERSISTENCE PATH: it is written inside machineLibrary and nowhere else', () => {
    state().addMachineToLibrary({
      ...savedLibrary[0],
      id: 'wo912-storage',
      name: 'WO-912 storage',
      controller: 'uccnc',
      controllerDefinition: fullDefinition(),
    })
    const written = persistPartialize(state()) as unknown as Record<string, unknown>

    // No new root slice, no document of its own.
    expect('machineDefinition' in written).toBe(false)
    expect('machineDefinitions' in written).toBe(false)
    expect('controllerDefinition' in written).toBe(false)
    expect('controllerDefinitions' in written).toBe(false)

    // It appears exactly where the machine profile already lives.
    const libraryBytes = JSON.stringify(written.machineLibrary)
    expect(libraryBytes).toContain('controllerDefinition')

    // And it carries no schemaVersion of its own: the definition rides the
    // store's existing persist version, nothing else.
    const def = state().machineLibrary.find((m) => m.id === 'wo912-storage')
      ?.controllerDefinition as unknown as Record<string, unknown>
    expect('schemaVersion' in def).toBe(false)
    expect('version' in def).toBe(false)
  })
})
