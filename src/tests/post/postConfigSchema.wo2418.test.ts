import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import {
  GENERIC_CONFIG,
  GRBLHAL_CONFIG,
  GRBL_CONFIG,
  LINUXCNC_CONFIG,
  UCCNC_CONFIG,
  serializeUserPostConfig,
} from '../../lib/post'

const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/formats/post-config.schema.json'), 'utf8'))
const validate = new Ajv({ allErrors: true }).compile(schema)

describe('WO-2418 post config schema', () => {
  for (const config of [UCCNC_CONFIG, GRBL_CONFIG, GRBLHAL_CONFIG, LINUXCNC_CONFIG, GENERIC_CONFIG]) {
    it(`validates a real ${config.label} export`, () => {
      const parsed = JSON.parse(serializeUserPostConfig(config))
      expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    })
  }

  it('fails broken copies', () => {
    const good = JSON.parse(serializeUserPostConfig(UCCNC_CONFIG))
    const broken = [
      (c: any) => { delete c.capabilities },
      (c: any) => { c.format.units = 'furlong' },
      (c: any) => { c.format.xyzDecimals = 12 },
      (c: any) => { c.options.programEndMode = 'sideways' },
      (c: any) => { c.framing.programStart = [1] },
      (c: any) => { c.wordTable.entries[0].category = 'nonsense' },
    ]
    for (const mutate of broken) {
      const copy = structuredClone(good)
      mutate(copy)
      expect(validate(copy)).toBe(false)
    }
  })
})
