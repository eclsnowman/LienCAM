// WO-1702 - SAFE Z IS ONE FIELD.
//
// The Safe Z box on the Machine area (WO-1690) edits through `withMachineSafeZ`;
// every other reader - jog, program preview, the guided tool change - reads
// through `machineSafeZValue`. This order closes the one gap the WO-1690
// review found: `machineSafeZValue` still fell back to
// `MachineActionConfig.safeZMachine`, a value stored with the pre-WO-1670
// wiring in `machineActionsStore` that nothing writes any more (there is no
// surviving caller of its `setSafeZ` action) - so that fallback could only
// ever answer with a stale number. One field means that fallback is gone.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AXIS_NAMES,
  createDefaultControllerDefinition,
  machineSafeZ,
  withMachineSafeZ,
  type MachineConfig,
} from '../../types'
import { machineSafeZValue, type MachineActionConfig } from '../../lib/machine/machineActions'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'

const PRO = readFileSync(join(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')

const STALE_CONFIG = {
  overrides: {},
  custom: [],
  // Persisted JSON from before WO-1670 can still have this extra key even
  // though WO-1710 removes it from MachineActionConfig and its store API.
  safeZMachine: 999,
} as unknown as MachineActionConfig

describe('WO-1702: editing Safe Z on the Machine area is what every other reader sees', () => {
  it('a UCCNC machine: the edit lands in the profile\'s own setting, and machineSafeZValue sees it with no config at all', () => {
    const machine = { controller: 'uccnc', controllerDefinition: importUccncProfile(PRO).definition! } as MachineConfig
    expect(machineSafeZ(machine)).toEqual({ z: 120, from: 'profile' })

    const edited = withMachineSafeZ(machine, 145)
    expect(machineSafeZ(edited)).toEqual({ z: 145, from: 'profile' })
    // Jog, the program preview and the guided tool change all read this one
    // function - none of them has to be handed a stored config for the
    // machine's own value to reach them.
    expect(machineSafeZValue(edited)).toBe(145)
    expect(machineSafeZValue(edited, undefined)).toBe(145)
  })

  it('a GRBL machine: Safe Z reads from the definition\'s own field, not a separate stored one', () => {
    const machine: MachineConfig = {
      controller: 'grbl',
      controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
    } as MachineConfig
    expect(machineSafeZ(machine)).toBeNull()

    const edited = withMachineSafeZ(machine, 45)
    expect(machineSafeZ(edited)).toEqual({ z: 45, from: 'app' })
    expect(edited.safeZMachine).toBeUndefined()
    expect(machineSafeZValue(edited)).toBe(45)
  })

  it('a leftover machineActionsStore value never wins over an unstated definition (the fallback is gone)', () => {
    const machine: MachineConfig = {
      controller: 'grbl',
      controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
      safeZMachine: undefined,
    } as MachineConfig
    expect(machineSafeZ(machine)).toBeNull()
    // Before this order, this call answered 999 - the stale wiring-store
    // value - because nothing had ever cleared it. One field: it answers null.
    expect(machineSafeZValue(machine, STALE_CONFIG)).toBeNull()
  })

  it('a leftover machineActionsStore value is not consulted even when the definition DOES state one', () => {
    const machine = { controllerDefinition: importUccncProfile(PRO).definition! } as MachineConfig
    expect(machineSafeZValue(machine, STALE_CONFIG)).toBe(120)
  })
})

describe('WO-1702: .pro export is content-identical before and after', () => {
  it('reading Safe Z through every consumer changes nothing the export reads', () => {
    const definition = importUccncProfile(PRO).definition!
    const before = exportUccncProfile(definition, { profileName: 'LienCNCV2' }).text

    const machine = { controllerDefinition: definition } as MachineConfig
    machineSafeZ(machine)
    machineSafeZValue(machine)
    machineSafeZValue(machine, STALE_CONFIG)

    const after = exportUccncProfile(definition, { profileName: 'LienCNCV2' }).text
    expect(after).toBe(before)
  })

  it('setting Safe Z back to the value the profile already states re-exports identically', () => {
    const definition = importUccncProfile(PRO).definition!
    const machine = { controllerDefinition: definition } as MachineConfig
    const before = exportUccncProfile(machine.controllerDefinition, { profileName: 'LienCNCV2' }).text

    const roundTripped = withMachineSafeZ(machine, machineSafeZ(machine)!.z)
    const after = exportUccncProfile(roundTripped.controllerDefinition, { profileName: 'LienCNCV2' }).text
    expect(after).toBe(before)
  })
})
