/**
 * WO-1727: trajectory planning and soft-limit enable are typed fields in the
 * machine definition's settings collection. A .pro import and a hand-built
 * definition feed the bridge through that same editable definition data.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  controllerSettingValue,
  createDefaultControllerDefinition,
  type ControllerDefinition,
  type ControllerSetting,
  type ControllerSettingValue,
} from '../../types'
import { importUccncProfile } from '../../lib/machine/uccncProfileImport'
import { exportUccncProfile } from '../../lib/machine/uccncProfileExport'

const PROFILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/profiles/LienCNCV2.pro'),
  'utf8',
)

const fields = {
  constantVelocity: 'Generalsettings.Constantvelocitymode',
  stopAngle: 'Generalsettings.Stopatangle',
  linearError: 'Generalsettings.Linearerror',
  cornerError: 'Generalsettings.Cornerserror',
  softLimitsEnabled: 'Generalsettings.Softlimitsenable',
} as const

const setting = (key: string, value: ControllerSettingValue): ControllerSetting =>
  ({ controller: 'uccnc', key, value })

const value = (definition: ControllerDefinition, key: string): ControllerSettingValue | null =>
  controllerSettingValue(definition.settings, 'uccnc', key)

describe('WO-1727 trajectory and soft-limit enable live in the definition', () => {
  it("imports Operator's values into the editable definition fields, unchanged", () => {
    const definition = importUccncProfile(PROFILE).definition!
    expect(value(definition, fields.constantVelocity)).toEqual({ kind: 'boolean', value: true })
    expect(value(definition, fields.stopAngle)).toEqual({ kind: 'number', value: 89 })
    expect(value(definition, fields.linearError)).toEqual({ kind: 'number', value: 0.03 })
    expect(value(definition, fields.cornerError)).toEqual({ kind: 'number', value: 0.03 })
    expect(value(definition, fields.softLimitsEnabled)).toEqual({ kind: 'boolean', value: true })
  })

  it('a hand-built definition round-trips only its stated values', () => {
    const handBuilt = createDefaultControllerDefinition()
    handBuilt.settings = [
      setting(fields.constantVelocity, { kind: 'boolean', value: true }),
      setting(fields.cornerError, { kind: 'number', value: 0.05 }),
      setting(fields.softLimitsEnabled, { kind: 'boolean', value: false }),
    ]

    const roundTripped = JSON.parse(JSON.stringify(handBuilt)) as ControllerDefinition
    expect(value(roundTripped, fields.constantVelocity)).toEqual({ kind: 'boolean', value: true })
    expect(value(roundTripped, fields.stopAngle)).toBeNull()
    expect(value(roundTripped, fields.linearError)).toBeNull()
    expect(value(roundTripped, fields.cornerError)).toEqual({ kind: 'number', value: 0.05 })
    expect(value(roundTripped, fields.softLimitsEnabled)).toEqual({ kind: 'boolean', value: false })

    const exported = exportUccncProfile(roundTripped, { profileName: 'Hand built' }).text
    expect(exported).toContain('Constantvelocitymode=True\r\n')
    expect(exported).not.toContain('Stopatangle=')
    expect(exported).not.toContain('Linearerror=')
    expect(exported).toContain('Cornerserror=0.05\r\n')
    expect(exported).toContain('Softlimitsenable=False\r\n')
  })
})
