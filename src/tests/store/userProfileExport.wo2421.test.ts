// WO-2421: "Export settings" writes the documented profile JSON.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { useCamStore } from '../../store'
import { useUiPrefs, exportUserProfileText } from '../../store/uiPrefs'

const schema = JSON.parse(readFileSync('docs/formats/user-profile.schema.json', 'utf-8'))

describe('user profile export (WO-2421)', () => {
  it('validates against the published schema and equals the store values', () => {
    useCamStore.getState().setDisplayUnits('inch')
    useCamStore.getState().setProjectionToleranceDefault(0.15)
    useUiPrefs.getState().setUiScale(1.25)
    useUiPrefs.getState().setDxfKeepOrigin(true)

    // the same call the "Export settings" button makes
    const text = exportUserProfileText(useCamStore.getState().appSettings)
    const parsed = JSON.parse(text)

    const ajv = new Ajv({ allErrors: true })
    const validate = ajv.compile(schema)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)

    const app = useCamStore.getState().appSettings
    expect(parsed.appSettings).toEqual(JSON.parse(JSON.stringify(app)))
    expect(parsed.appSettings.displayUnits).toBe('inch')
    expect(parsed.appSettings.projectionToleranceDefault).toBe(0.15)
    expect(parsed.uiPreferences.uiScale).toBe(1.25)
    expect(parsed.uiPreferences.dxfKeepOrigin).toBe(true)
    expect(parsed.uiPreferences.uiTheme).toBe(useUiPrefs.getState().uiTheme)
    expect(Object.values(parsed.uiPreferences).every((v) => typeof v !== 'function')).toBe(true)
  })
})
