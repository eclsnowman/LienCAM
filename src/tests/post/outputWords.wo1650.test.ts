import { describe, expect, it } from 'vitest'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { readGcodeProgram, type GcodeDialect } from '../../lib/gcode'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { emitProgram } from '../../lib/post/emit'
import { resolveSpindle } from '../../lib/post/resolve'
import type { PostConfig } from '../../lib/post/types'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type MachineOutputDefinition,
} from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'

// WO-1650: THE POST WRITES THE WORDS THE MACHINE'S ONE OUTPUT LIST DEFINES, AND
// OUR OWN READER READS THEM BACK. The audit's finding 4: a vacuum moved to M10
// by our own post was refused by our own reader. Two different machines, the
// same code, no edit between them.

function machineWith(
  controller: 'uccnc' | 'grbl',
  outputs: MachineOutputDefinition[] | undefined,
  extra: Partial<MachineConfig> = {},
): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  if (outputs !== undefined) controllerDefinition.outputs = outputs
  return makeMachine({ controller, controllerDefinition, ...extra })
}

function post(machine: MachineConfig, config: PostConfig, coolant: 'none' | 'flood' | 'mist'): string {
  const tool = makeTool()
  const op = makeOp({
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 5, y: 0, z: 0, feed: 1000, role: 'cut' }),
    ],
  })
  return emitProgram({
    machine,
    setup: {
      wcs: makeWcs(),
      operations: [{
        op,
        tool,
        feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
        spindle: resolveSpindle(op, tool, machine),
        coolant,
        moves: op.toolpathMoves ?? [],
      }],
    },
  }, config).lines.join('\n')
}

function readBack(text: string, dialect: GcodeDialect, machine: MachineConfig | null) {
  return readGcodeProgram(text, {
    dialect,
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    machineDefinition: machine,
  })
}

const HAND_MADE_GRBL: MachineOutputDefinition[] = [
  { name: 'flood coolant', role: 'flood', onCode: 'M108', offCode: null, pin: { port: 1, pin: 5, negate: false } },
  { name: 'vacuum', role: 'vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 2, pin: 3, negate: false } },
]

describe('WO-1650: the post writes the words the output list defines', () => {
  it('a hand-made GRBL machine: flood on M108 and vacuum on M10 are posted as listed', () => {
    const text = post(machineWith('grbl', HAND_MADE_GRBL), GRBL_CONFIG, 'flood')
    const lines = text.split('\n')
    expect(lines).toContain('M10')
    expect(lines).toContain('M108')
    expect(lines).not.toContain('M8')
  })

  it("Operator's shape - flood on M8 in the list - posts M8 exactly as before", () => {
    const sampleMachine: MachineOutputDefinition[] = [
      { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { port: 3, pin: 14, negate: false } },
      { name: 'mist coolant', role: 'mist', onCode: 'M7', offCode: null, pin: { port: 3, pin: 16, negate: false } },
    ]
    const lines = post(machineWith('uccnc', sampleMachine), UCCNC_CONFIG, 'flood').split('\n')
    expect(lines).toContain('M8')
    expect(lines.filter((line) => /^M(?:7|10|108)$/.test(line))).toEqual([])
  })

  it('a machine with no list posts the standard M8 / M7', () => {
    expect(post(machineWith('uccnc', undefined), UCCNC_CONFIG, 'flood').split('\n')).toContain('M8')
    expect(post(machineWith('uccnc', undefined), UCCNC_CONFIG, 'mist').split('\n')).toContain('M7')
  })
})

describe('WO-1650: what our post writes, our reader reads', () => {
  it.each([
    ['grbl', GRBL_CONFIG],
    ['uccnc', UCCNC_CONFIG],
  ] as const)('%s: the listed vacuum and flood words round-trip, and M9 stops them', (dialect, config) => {
    const machine = machineWith(dialect, HAND_MADE_GRBL)
    const text = post(machine, config, 'flood')
    const read = readBack(text, dialect, machine)
    expect(read.ok, read.ok ? undefined : read.refusal.message).toBe(true)
    if (!read.ok) return
    const outputs = read.program.items.filter((item) => item.kind === 'coolant')
    expect(outputs.map((item) => item.kind === 'coolant' ? item.outputs : null)).toEqual([[10], [10, 108], []])
  })

  it('a vacuum word stated only on the coolant record round-trips too', () => {
    const machine = machineWith('uccnc', [], { coolantCapability: { vacuum: { onCode: 'M10' } } })
    const text = post(machine, UCCNC_CONFIG, 'none')
    expect(text.split('\n')).toContain('M10')
    const read = readBack(text, 'uccnc', machine)
    expect(read.ok, read.ok ? undefined : read.refusal.message).toBe(true)
  })

  it('control: the same file read with no machine definition is refused at the M10', () => {
    const machine = machineWith('grbl', HAND_MADE_GRBL)
    const read = readBack(post(machine, GRBL_CONFIG, 'flood'), 'grbl', null)
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.refusal.reason).toMatch(/^M10 is not in the GRBL G-code word table/)
  })
})
