/**
 * WO-936: the importer is asserted against OPERATOR'S REAL PROFILE, not a fixture.
 *
 * `docs/machine/profiles/LienCNCV2.pro` is the file the running bridge reads
 * on his machine, committed by the machine session on 2026-08-23. Asserting
 * against a fixture we wrote would only prove the importer agrees with our own
 * idea of the format - which is exactly the failure that put a GRBL machine
 * with invented 800/600/100 travel in front of him.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

const imported = () => importUccncProfile(PROFILE)
const axisOf = (name: string) => {
  const a = imported().definition?.axes.find((x) => x.axis === name)
  if (!a) throw new Error(`no ${name} axis imported`)
  return a
}

describe("WO-936 THE HEADLINE: Operator's machine is imported, not invented", () => {
  it('parses his profile at all - definition is not null', () => {
    const r = imported()
    expect(r.definition).not.toBeNull()
    expect(r.definition!.axes.length).toBeGreaterThanOrEqual(3)
  })

  it('X carries HIS numbers - 738 of travel, not 800', () => {
    const x = axisOf('X')
    expect(x.softLimitMin).toBe(0)
    expect(x.softLimitMax).toBe(738)
    expect(x.stepsPerUnit).toBe(400)
    // units/MIN, NOT divided by 60 - the bridge does that, src/ never does.
    expect(x.maxVelocity).toBe(9000)
    expect(x.acceleration).toBe(500)
  })

  it('travel comes from the soft limits, so it cannot disagree with the board', () => {
    const r = imported()
    expect(r.travel).toEqual({ x: 738, y: 724.5, z: 129.2 })
  })

  it("Z's asymmetric limits survive - -0.1 is not rounded to 0", () => {
    const z = axisOf('Z')
    expect(z.softLimitMin).toBeCloseTo(-0.1, 6)
    expect(z.softLimitMax).toBeCloseTo(129.1, 6)
  })
})

describe('WO-936 SAFETY: the gantry pairing survives the import', () => {
  it('Y IS SLAVED TO A - read as a NAME, because UCCNC writes a name', () => {
    // Machine.cs:747 does the same lookup and says why: "Missing this drives
    // one side of a gantry and racks it." A numeric read would return null
    // here and silently unpair Operator's gantry.
    expect(axisOf('Y').slaveAxis).toBe('A')
  })

  it('X and Z are NOT slaved - "None" is not an axis', () => {
    expect(axisOf('X').slaveAxis).toBeNull()
    expect(axisOf('Z').slaveAxis).toBeNull()
  })
})

describe('WO-936 the homing facts the demo depends on', () => {
  it('the homing ORDER is read from the profile, not imposed', () => {
    // [Generalsettings] Homesequence1=Z, 2=X, 3=Y. It happens to match our
    // safe default, which is exactly why reading it must be asserted - an
    // importer that hardcoded the default would pass a weaker test.
    expect(imported().definition!.homing.order).toEqual(['Z', 'X', 'Y'])
  })

  it('each axis keeps ITS OWN homing value - 738 / 724.5 / 128.9', () => {
    const h = imported().definition!.homing.perAxis
    expect(h.X!.homingValue).toBe(738)
    expect(h.Y!.homingValue).toBe(724.5)
    expect(h.Z!.homingValue).toBe(128.9)
  })

  it('X homes POSITIVE - his end stops are at axis max', () => {
    expect(imported().definition!.homing.perAxis.X!.direction).toBe('positive')
  })

  it('the fast and slow seek speeds are both carried', () => {
    const x = imported().definition!.homing.perAxis.X!
    expect(x.fastSpeed).toBe(1500)
    expect(x.slowSpeed).toBe(250)
  })

  it('A ZERO BACK-OFF IS IMPORTED AS ZERO - the importer invents nothing', () => {
    // This test previously asserted the OPPOSITE, and it was wrong. Raising a
    // profile 0 to 2mm re-introduced a value that was tried, measured at the
    // machine on 2026-08-21 with Operator watching, and REMOVED (Machine.cs:364-381)
    // - and whose stated benefit is known false, because the board's
    // HomeBackOff is the retreat BETWEEN approach stages, not a final one.
    // Inventing a machine fact on the path we are asking him to trust is the
    // exact defect WO-924 exists to kill.
    const r = imported()
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(r.definition!.homing.perAxis[axis]!.backOff).toBe(0)
    }
    expect(r.issues.some((i) => i.key.endsWith('.Homebackoff'))).toBe(false)
  })

  it('a NON-ZERO back-off in a profile is carried through untouched', () => {
    const r = importUccncProfile(
      '[axessettingscontrolX]\nAxisenabled=True\nHomebackoff=3.5\n',
    )
    expect(r.definition!.homing.perAxis.X!.backOff).toBe(3.5)
  })
})

describe('WO-936 THE 10x TRAP: enable delay units', () => {
  it('Enabledelay is 10ms STEPS in the profile and MILLISECONDS in the definition', () => {
    // ApplyDefinition divides ms by 10 on the way back to the board
    // (Machine.cs:1150). Copying the raw profile value here would hand every
    // drive a delay a TENTH of what the machine actually uses.
    const withDelay = importUccncProfile(
      '[axessettingscontrolX]\nAxisenabled=True\nEnabledelay=25\n',
    )
    expect(withDelay.definition!.axes[0].enableDelayMs).toBe(250)
  })

  it("Operator's profile has zero enable delay, and zero stays zero", () => {
    expect(axisOf('X').enableDelayMs).toBe(0)
  })
})

describe('WO-936 pins: assigned ones are read, unassigned stay unassigned', () => {
  it('X step/dir/home pins carry the real port and pin', () => {
    const x = axisOf('X')
    expect(x.stepPin).toEqual({ port: 1, pin: 15, negate: false })
    expect(x.dirPin.port).toBe(1)
    expect(x.dirPin.pin).toBe(16)
    expect(x.homePin.port).toBe(2)
    expect(x.homePin.pin).toBe(1)
  })

  it('X HAS NO LIMIT INPUTS AT ALL, and that is imported as unassigned', () => {
    // Limitminuspinnumber=0 and Limitpluspinnumber=0. This is why
    // inputs.hardLimit can never trip on X, and it must not be papered over
    // with a guessed pin - a guessed pin wired to something real is worse
    // than none.
    const x = axisOf('X')
    // ...and it must not be papered over with a guessed POLARITY either
    // (WO-995): an unassigned pin has no signal to invert, so `null`.
    expect(x.limitMinusPin).toEqual({ port: 0, pin: 0, negate: null })
    expect(x.limitPlusPin).toEqual({ port: 0, pin: 0, negate: null })
  })

  it('the E-STOP input is read, including its negation', () => {
    const io = imported().definition!.io
    expect(io.estop.port).toBe(3)
    expect(io.estop.pin).toBe(15)
    expect(io.estop.negate).toBe(true)
  })
})

describe('WO-936 a bad file fails VISIBLY, never silently into defaults', () => {
  it('empty text yields no definition and says so', () => {
    const r = importUccncProfile('')
    expect(r.definition).toBeNull()
    expect(r.issues.length).toBeGreaterThan(0)
  })

  it('text that is not a profile yields no definition', () => {
    const r = importUccncProfile('this is not a profile at all')
    expect(r.definition).toBeNull()
  })

  it('NEVER THROWS - a machine definition must fail readably, not explosively', () => {
    expect(() => importUccncProfile('[axessettingscontrolX]\nVelocity=banana\n')).not.toThrow()
    const r = importUccncProfile('[axessettingscontrolX]\nVelocity=banana\n')
    expect(r.issues.some((i) => i.key === 'axessettingscontrolX.Velocity')).toBe(true)
  })

  it('a nonsense slave is dropped rather than guessed', () => {
    const r = importUccncProfile('[axessettingscontrolY]\nAxisenabled=True\nSlaveaxis=Q\n')
    expect(r.definition!.axes[0].slaveAxis).toBeNull()
    expect(r.issues.some((i) => i.key.endsWith('.Slaveaxis'))).toBe(true)
  })
})
