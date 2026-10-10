/**
 * WO-1685: ONE SETTINGS INDEX LISTS EVERY SETTING ON THE MACHINE.
 *
 * `buildSettingsIndex` is what T2/T6 (v2/SLICES.md) call the source for
 * Wave 1's All-settings table: the UCCNC catalogue and the GRBL table behind
 * one shape. Measured against Operator's real profile
 * (`docs/machine/profiles/LienCNCV2.pro`) for the same reason
 * `definitionModelCoverage.wo1037.test.ts` is - a fixture only proves the
 * model agrees with our own idea of the format.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildSettingsIndex,
  searchSettingsIndex,
  type SettingsIndexCard,
} from '../../lib/machine/settingsIndex'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import { GRBL_SETTINGS, type GrblSettingsRecord } from '../../lib/machine/grbl/settings'

const PROFILE_PATH = 'docs/machine/profiles/LienCNCV2.pro'
const PROFILE = readFileSync(resolve(process.cwd(), PROFILE_PATH), 'utf8')

const VALID_CARDS: readonly SettingsIndexCard[] =
  ['Overview', 'Machine', 'Spindle', 'Outputs & coolant', 'Probing', 'Controller']

describe('settingsIndex - UCCNC', () => {
  const imported = importUccncProfile(PROFILE)
  const machine = { controller: 'uccnc' as const, controllerDefinition: imported.definition ?? undefined }
  const index = buildSettingsIndex(machine)

  it('indexes every catalogue key on Operator\'s imported profile, not only the ones he stated', () => {
    // The catalogue's whole vocabulary (1681), not his profile's 1680 stated
    // keys - see definitionModelCoverage.wo1037.test.ts's header for the split.
    expect(index).toHaveLength(1681)
  })

  it('searches by name across sections: "thc" finds all 29 torch-height-control keys', () => {
    expect(searchSettingsIndex(index, 'thc')).toHaveLength(29)
    expect(searchSettingsIndex(index, 'THC')).toHaveLength(29)
  })

  it('groups by the .pro\'s own section, named in plain words', () => {
    const axisRow = index.find((row) => row.key === 'axessettingscontrolX.Velocity')
    expect(axisRow?.group).toBe('Axis X')

    const spindleRow = index.find((row) => row.key === 'Spindlesetupsettings.M9delay')
    expect(spindleRow?.group).toBe('Spindle')

    const ioRow = index.find((row) => row.key === 'IOsetupsettings.Indexprescaler')
    expect(ioRow?.group).toBe('Inputs and outputs')

    // No raw catalogue key leaks through as a group label.
    for (const row of index) {
      expect(row.group).not.toMatch(/settingscontrol|setupsettings|settings$/i)
    }
  })

  it('resolves ownedBy to a real card in the plan, or none', () => {
    for (const row of index) {
      expect(row.ownedBy === null || VALID_CARDS.includes(row.ownedBy)).toBe(true)
    }

    const axisRow = index.find((row) => row.key === 'axessettingscontrolX.Velocity')
    expect(axisRow?.ownedBy).toBe('Machine')

    const spindleRow = index.find((row) => row.key === 'Spindlesetupsettings.M9delay')
    expect(spindleRow?.ownedBy).toBe('Spindle')

    const estopRow = index.find((row) => row.key === 'IOsetupsettings.Estopportnumber')
    expect(estopRow?.ownedBy).toBe('Controller')

    const probeRow = index.find((row) => row.key === 'IOsetupsettings.Probeportnumber')
    expect(probeRow?.ownedBy).toBe('Probing')

    // UCCNC's Probing.* catalogue is All settings only (v2/SLICES.md T10) -
    // the Probing area reads io.probe/io.probe2 and MachineProbeDefaults,
    // not this section.
    const probingSectionRow = index.find((row) => row.group === 'Probing')
    expect(probingSectionRow?.ownedBy).toBeNull()
  })

  it('carries this machine\'s own stated value where it has one', () => {
    // `Velocity` is one of the 191 keys a named field owns (`ownedBy` on the
    // catalogue entry, not this module's card) and so is absent from
    // `settings` by design; `M9delay` is one of the 1489 catalogue-only keys.
    const row = index.find((row) => row.key === 'Spindlesetupsettings.M9delay')
    expect(row?.value).not.toBeNull()
  })
})

describe('settingsIndex - GRBL', () => {
  it('indexes a router\'s 36 stated $-settings, catalogued ones with their own names and units', () => {
    const catalogued = Object.keys(GRBL_SETTINGS).map(Number)
    expect(catalogued).toHaveLength(34)

    const grblSettings: GrblSettingsRecord = {}
    for (const id of catalogued) grblSettings[id] = String(id)
    // Two ids this software's catalogue does not name yet - a real board's
    // reported settings are not bounded by what GRBL_SETTINGS lists.
    grblSettings[33] = '0'
    grblSettings[34] = '0'

    const machine = { controller: 'grbl' as const, controllerDefinition: undefined, grblSettings }
    const index = buildSettingsIndex(machine)

    expect(index).toHaveLength(36)

    const named = index.find((row) => row.key === '$0')
    expect(named?.name).toBe('Step pulse time')
    expect(named?.unit).toBe('us')

    const unnamed = index.find((row) => row.key === '$33')
    expect(unnamed?.name).toBe('$33')
    expect(unnamed?.ownedBy).toBeNull()

    expect(searchSettingsIndex(index, 'thc')).toHaveLength(0)
  })

  it('indexes nothing for a GRBL machine that has read no settings yet', () => {
    const machine = { controller: 'grbl' as const, controllerDefinition: undefined, grblSettings: undefined }
    expect(buildSettingsIndex(machine)).toEqual([])
  })
})
