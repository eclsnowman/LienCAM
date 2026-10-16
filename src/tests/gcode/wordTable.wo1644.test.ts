import { describe, expect, it } from 'vitest'
import { readGcodeProgram } from '../../lib/gcode'
import {
  builtInGcodeWordTable,
  gcodeWordEntry,
  gcodeWordRefusal,
  gcodeWordTable,
  gcodeWordTableWithOutputs,
} from '../../lib/gcode/wordTable'
import { createDefaultControllerDefinition, type MachineOutputDefinition } from '../../types'

// WO-1650 (on WO-1644's table): THE WORD TABLE LEARNS A MACHINE'S OWN OUTPUT
// WORDS FROM ITS DEFINITION. A pump on M10 and air on M11 are that machine's
// words; the dialect's own M7/M8/M9 keep the dialect's meaning.

const PUMP_AND_AIR: MachineOutputDefinition[] = [
  { name: 'coolant pump', onCode: 'M10', offCode: null, pin: { port: 1, pin: 17, negate: false } },
  { name: 'air', onCode: 'M11', offCode: 'M12', pin: { port: 2, pin: 3, negate: false } },
  { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { port: 3, pin: 14, negate: false } },
  { name: 'spindle relay', onCode: 'M3', offCode: 'M5', pin: { port: 1, pin: 1, negate: false }, besideWord: true },
]

function definition(outputs: MachineOutputDefinition[]) {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.outputs = outputs
  return { controller: 'grbl' as const, controllerDefinition }
}

describe('WO-1650: the table learns the output words a definition lists', () => {
  it('adds M10, M11 and M12 with the meaning the definition gives them', () => {
    const table = gcodeWordTableWithOutputs(gcodeWordTable('grbl'), PUMP_AND_AIR)
    expect(gcodeWordEntry(table, 'M', 10)).toMatchObject({ category: 'output', meaning: 'switches the "coolant pump" output on' })
    expect(gcodeWordEntry(table, 'M', 11)).toMatchObject({ category: 'output', meaning: 'switches the "air" output on' })
    expect(gcodeWordEntry(table, 'M', 12)).toMatchObject({ category: 'output', meaning: 'switches the "air" output off' })
    // The dialect's own words keep the dialect's meaning.
    expect(gcodeWordEntry(table, 'M', 8)).toEqual(gcodeWordEntry(builtInGcodeWordTable('grbl'), 'M', 8))
    expect(gcodeWordEntry(table, 'M', 3)).toEqual(gcodeWordEntry(builtInGcodeWordTable('grbl'), 'M', 3))
    // The refusal sentence names what this machine runs.
    expect(gcodeWordRefusal(table, 'M', 99)).toContain('output M10 M11 M12')
  })

  it('a machine that lists nothing gets the dialect table unchanged', () => {
    expect(gcodeWordTableWithOutputs(gcodeWordTable('uccnc'), [])).toBe(gcodeWordTable('uccnc'))
  })
})

describe('WO-1650: the shared reader accepts any word the list defines', () => {
  const FILE = 'G21 G90\nM10\nG0 X1\nM11\nG1 X2 F100\nM12\nM9\nM30\n'
  const options = { sessionWcs: 'G54' as const, initialPosition: { x: 0, y: 0, z: 0 } }

  it.each(['grbl', 'uccnc', 'linuxcnc'] as const)('%s: M10 / M11 / M12 / M9 read into the output state', (dialect) => {
    const read = readGcodeProgram(FILE, { ...options, dialect, machineDefinition: definition(PUMP_AND_AIR) })
    expect(read.ok, read.ok ? undefined : read.refusal.message).toBe(true)
    if (!read.ok) return
    const states = read.program.items.flatMap((item) => (item.kind === 'coolant' ? [item.outputs] : []))
    expect(states).toEqual([[10], [10, 11], [10], []])
  })

  it('without the definition the same file is refused at M10 with the table sentence', () => {
    const read = readGcodeProgram(FILE, { ...options, dialect: 'grbl' })
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.refusal.line).toBe(2)
    expect(read.refusal.reason).toMatch(/^M10 is not in the GRBL G-code word table/)
  })

  it('a machine with no extra output words reads coolant items exactly as before', () => {
    const read = readGcodeProgram('G21 G90\nM8\nG0 X1\nM9\nM30\n', {
      ...options,
      dialect: 'uccnc',
      machineDefinition: definition([PUMP_AND_AIR[2]]),
    })
    if (!read.ok) throw new Error(read.refusal.message)
    const coolant = read.program.items.filter((item) => item.kind === 'coolant')
    expect(coolant).toEqual([
      { kind: 'coolant', line: 2, flood: true, mist: false, standardCode: 8 },
      { kind: 'coolant', line: 4, flood: false, mist: false, standardCode: 9 },
    ])
    expect(coolant.every((item) => !('outputs' in item))).toBe(true)
  })
})
