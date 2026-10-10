import { describe, expect, it } from 'vitest'
import {
  builtinDefaultLines,
  resolveBuiltinLines,
  substituteActionLines,
  validateActionLabel,
  validateActionLines,
  EMPTY_ACTION_CONFIG,
} from '../../lib/machine/machineActions'
import { useMachineActions } from '../../store/machineActionsStore'

describe('machine action resolution', () => {
  it('serves controller defaults when nothing is overridden', () => {
    expect(resolveBuiltinLines(undefined, 'grbl', 'coolantMist')).toEqual(['M7'])
    expect(resolveBuiltinLines(EMPTY_ACTION_CONFIG, 'grbl', 'spindleCw')).toEqual(['M3 S{rpm}'])
  })

  it('prefers the user override', () => {
    const config = { overrides: { coolantMist: ['M64 P1'] }, custom: [] }
    expect(resolveBuiltinLines(config, 'grbl', 'coolantMist')).toEqual(['M64 P1'])
  })

  it('makes an unknown controller a compile-time refusal instead of a fallback', () => {
    if (Math.PI < 0) {
      // @ts-expect-error ControllerType is closed; dispatch must use the resolver.
      builtinDefaultLines('somebody-elses-board', 'coolantOff')
    }
    expect(builtinDefaultLines('grbl', 'coolantOff')).toEqual(['M9'])
  })

  it('substitutes {rpm} with a rounded non-negative value', () => {
    expect(substituteActionLines(['M3 S{rpm}', 'G4 P0.5'], { rpm: 8000.6 })).toEqual([
      'M3 S8001',
      'G4 P0.5',
    ])
    expect(substituteActionLines(['M3 S{rpm}'], { rpm: -5 })).toEqual(['M3 S0'])
  })
})

describe('action validation', () => {
  it('cleans and accepts multi-line input', () => {
    const v = validateActionLines('  M8  \n\n G4 P0.5 \n')
    expect(v).toEqual({ ok: true, lines: ['M8', 'G4 P0.5'] })
  })

  it('rejects empty, oversized, and control-character input', () => {
    expect(validateActionLines('   \n  ').ok).toBe(false)
    expect(validateActionLines('G1 ' + 'X1 '.repeat(40)).ok).toBe(false)
    expect(validateActionLines('M8\x07').ok).toBe(false)
    expect(validateActionLines(Array.from({ length: 25 }, () => 'M8').join('\n')).ok).toBe(false)
  })

  it('validates labels', () => {
    expect(validateActionLabel('  Vacuum ON ')).toEqual({ ok: true, label: 'Vacuum ON' })
    expect(validateActionLabel('').ok).toBe(false)
    expect(validateActionLabel('This label is much too long for a button').ok).toBe(false)
  })
})

describe('machineActionsStore', () => {
  it('keeps wiring per machine and supports override + custom CRUD', () => {
    const s = useMachineActions.getState()
    s.setOverride('machineA', 'coolantMist', ['M64 P1'])
    s.setOverride('machineB', 'coolantMist', ['M100'])
    s.addCustom('machineA', { id: 'a1', label: 'Vacuum', color: 'cyan', lines: ['M64 P2'] })

    expect(useMachineActions.getState().configFor('machineA').overrides.coolantMist).toEqual(['M64 P1'])
    expect(useMachineActions.getState().configFor('machineB').overrides.coolantMist).toEqual(['M100'])
    expect(useMachineActions.getState().configFor('machineC')).toEqual(EMPTY_ACTION_CONFIG)

    s.updateCustom('machineA', { id: 'a1', label: 'Vacuum ON', color: 'green', lines: ['M64 P2'] })
    expect(useMachineActions.getState().configFor('machineA').custom[0].label).toBe('Vacuum ON')

    s.clearOverride('machineA', 'coolantMist')
    expect(useMachineActions.getState().configFor('machineA').overrides.coolantMist).toBeUndefined()

    s.removeCustom('machineA', 'a1')
    expect(useMachineActions.getState().configFor('machineA').custom).toHaveLength(0)
  })
})
