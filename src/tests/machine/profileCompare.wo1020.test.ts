import { describe, expect, it } from 'vitest'
import {
  compareUccncProfilePins,
  type ProfilePinComparisonInput,
  type ProfilePinTranslation,
} from '../../lib/machine/uccncProfileImport'
import { createDefaultControllerDefinition, type PinRef } from '../../types'

const RAW: PinRef = { port: 1, pin: 15, negate: false }
const OTHER_RAW: PinRef = { port: 1, pin: 16, negate: false }
const translated = (boardPin: number): ProfilePinTranslation => ({
  kind: 'translated',
  boardPin,
})
const refused = (reason = 'this board has no translation for the pin'): ProfilePinTranslation => ({
  kind: 'refused',
  reason,
})

const machine = () => {
  const definition = createDefaultControllerDefinition(['X'])
  definition.axes[0].stepPin = { ...RAW }
  return definition
}

const comparedStep = (input: ProfilePinComparisonInput) => {
  const row = compareUccncProfilePins(machine(), [input])
    .find((candidate) => candidate.key === 'axis.X.stepPin')
  if (!row) throw new Error('comparison omitted the X step pin')
  return row
}

describe('WO-1020 complete three-state profile pin comparison table', () => {
  it('translates X -> translates X reads UNCHANGED', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: OTHER_RAW,
      oldResult: translated(11), newResult: translated(11),
    })

    expect(row).toMatchObject({ state: 'unchanged', changed: false })
    expect(row.outcome).toContain('UNCHANGED')
  })

  it('translates X -> translates Y reads CHANGED', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: OTHER_RAW,
      oldResult: translated(11), newResult: translated(12),
    })

    expect(row).toMatchObject({ state: 'changed', changed: true })
    expect(row.outcome).toContain('UCpin 11 becomes UCpin 12')
  })

  it('translates X -> REFUSED reads CHANGED, including when the raw pin is identical', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: { ...RAW },
      oldResult: translated(11), newResult: refused('not an output on this board'),
    })

    expect(row).toMatchObject({ state: 'changed', changed: true, translationOnly: true })
    expect(row.boardAfter).toBe('REFUSED: not an output on this board')
    expect(row.outcome).toContain('the raw pin is identical')
    expect(row.outcome).not.toContain('UNCHANGED')
  })

  it('REFUSED -> translates Y reads CHANGED', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: OTHER_RAW,
      oldResult: refused(), newResult: translated(12),
    })

    expect(row).toMatchObject({ state: 'changed', changed: true })
  })

  it('REFUSED -> REFUSED reads UNCHANGED', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: OTHER_RAW,
      oldResult: refused('old reason'), newResult: refused('new reason'),
    })

    expect(row).toMatchObject({ state: 'unchanged', changed: false })
    expect(row.boardBefore).toBe('REFUSED: old reason')
    expect(row.boardAfter).toBe('REFUSED: new reason')
  })

  it('translates X -> NOT IN PROFILE keeps the third state and differs', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: null,
      oldResult: translated(11),
      newResult: { kind: 'not-in-profile', applyEffect: 'clear' },
    })

    expect(row).toMatchObject({
      state: 'not-in-profile',
      changed: true,
      newResult: { kind: 'not-in-profile', applyEffect: 'clear' },
    })
    expect(row.boardAfter).toBe('NOT IN PROFILE')
    expect(row.outcome).toContain(
      'Applying this profile will clear the step pin assignment and leave it unassigned',
    )
    expect(row.outcome).not.toContain('would become NOT IN PROFILE')
    expect(row.outcome).not.toContain('UNCHANGED')
  })

  it('REFUSED -> NOT IN PROFILE keeps the third state and differs', () => {
    const row = comparedStep({
      key: 'axis.X.stepPin', rawAfter: null,
      oldResult: refused(),
      newResult: { kind: 'not-in-profile', applyEffect: 'clear' },
    })

    expect(row).toMatchObject({
      state: 'not-in-profile',
      changed: true,
      newResult: { kind: 'not-in-profile', applyEffect: 'clear' },
    })
    expect(row.boardBefore).toMatch(/^REFUSED: /)
    expect(row.boardAfter).toBe('NOT IN PROFILE')
    expect(row.outcome).toContain(
      'Applying this profile will clear the step pin assignment and leave it unassigned',
    )
  })
})

describe('WO-1020 comparison coverage is total over the machine pin fields', () => {
  it('returns one row for every machine pin, never only the supplied or changed rows', () => {
    const definition = createDefaultControllerDefinition(['X', 'Y'])
    const rows = compareUccncProfilePins(definition, [{
      key: 'axis.X.stepPin', rawAfter: { ...definition.axes[0].stepPin },
      oldResult: translated(11), newResult: translated(11),
    }])

    // Six pin fields per axis plus the three machine-wide input pin fields.
    expect(rows).toHaveLength((definition.axes.length * 6) + 3)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(rows.every((row) => row.boardBefore !== '' && row.boardAfter !== '')).toBe(true)
    expect(rows.find((row) => row.key === 'io.probe')).toMatchObject({
      state: 'not-in-profile',
      changed: true,
      boardBefore: 'REFUSED: the current board translation was not reported',
      boardAfter: 'NOT IN PROFILE',
      newResult: { kind: 'not-in-profile', applyEffect: 'clear' },
    })
    expect(rows.find((row) => row.key === 'io.probe')?.outcome).toContain(
      'Applying this profile will clear the probe input assignment and leave it unassigned',
    )
  })
})
