// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import { useCamStore } from '../../store'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../../store/migrations/projectMigrations'

const schema = JSON.parse(readFileSync('docs/formats/camproject.schema.json', 'utf-8'))
const validate = new Ajv().compile(schema)

let saved = ''
beforeEach(() => {
  saved = ''
  ;(globalThis as unknown as { liencamHost: unknown }).liencamHost = {
    saveFile: async (_name: string, data: string) => { saved = data; return 'test' },
  }
})

describe('WO-2411 camproject JSON Schema', () => {
  it('validates a project saved through the Save button action', async () => {
    await useCamStore.getState().saveProjectToFile()
    const parsed = JSON.parse(saved)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    expect(parsed.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
    expect(schema.properties.schemaVersion.const).toBe(CURRENT_PROJECT_SCHEMA_VERSION)
  })

  it('negative control: a required field removed fails', async () => {
    await useCamStore.getState().saveProjectToFile()
    const noMachine = JSON.parse(saved)
    delete noMachine.machine
    expect(validate(noMachine)).toBe(false)
    const noSetups = JSON.parse(saved)
    delete noSetups.setups
    expect(validate(noSetups)).toBe(false)
  })
})
