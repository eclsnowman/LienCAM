// WO-2417: Export / Export All write files the published schema describes.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import Ajv from 'ajv'
import { machineDefinitionText, machineLibraryText } from '../../lib/machine/machineDefinitionExport'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { createExampleMachine, EXAMPLE_MACHINES } from '../../lib/machine/exampleMachines'

const schema = JSON.parse(readFileSync('docs/formats/machine-definition.schema.json', 'utf-8'))
const validate = new Ajv({ allErrors: true }).compile(schema)

describe('machine definition schema (WO-2417)', () => {
  it('validates a single-machine export and round-trips the data', () => {
    const machine = {
      ...createSampleMachine(),
      macros: [{ id: 'm1', name: 'Park', body: 'goTo({ x: 1, y: 2, z: 3 })', mCode: 1001 }],
    }
    const parsed = JSON.parse(machineDefinitionText(machine))
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
    expect(parsed).toEqual(JSON.parse(JSON.stringify(machine)))
  })

  it('validates a library export of every example machine', () => {
    const library = [createSampleMachine(), ...EXAMPLE_MACHINES.map((e) => createExampleMachine(e))]
    const parsed = JSON.parse(machineLibraryText(library))
    expect(parsed).toHaveLength(library.length)
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true)
  })

  it('rejects broken copies', () => {
    const good = JSON.parse(machineDefinitionText(createSampleMachine()))
    const noTravel = { ...good }
    delete noTravel.travel
    expect(validate(noTravel)).toBe(false)
    expect(validate({ ...good, spindleDirection: 'sideways' })).toBe(false)
    const badLimits = { x: { maxCutting: 'fast', maxRapid: 1 }, y: good.axisLimits.y, z: good.axisLimits.z }
    expect(validate({ ...good, axisLimits: badLimits })).toBe(false)
  })
})
