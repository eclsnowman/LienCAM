// WO-2437: an operator stop between two operations - retract, park at the
// machine's own park, the message, the stop, then the next operation - posted
// through Post Process's own route (postProject) in every dialect and read
// back with the app's own G-code reader.
import { describe, expect, it } from 'vitest'
import { postProject, type PostProjectOptions } from '../../lib/post/postProject'
import { GENERIC_CONFIG, GRBL_CONFIG, GRBLHAL_CONFIG, LINUXCNC_CONFIG, UCCNC_CONFIG } from '../../lib/post'
import type { PostConfig } from '../../lib/post'
import { readGcodeProgram, type GcodeDialect } from '../../lib/gcode/reader'
import { workholdingStopPark } from '../../lib/machine/macros/clampPauseMacro'
import { positionMacroBody } from '../../types'
import type { MachineAction, MachineConfig, Operation, Project, Setup, Stock } from '../../types'

/** A stop as these cases place it: before an operation, or after the last
 *  (null). The project holds it as the Operator stop operation the New
 *  operation menu adds, placed after the operation above it. */
type StopAt = { id: string; beforeOpId: string | null; message: string }

function operatorStopActions(ops: Operation[], stops: StopAt[]): MachineAction[] {
  return stops.map((stop) => {
    const at = stop.beforeOpId === null ? ops.length : ops.findIndex((op) => op.id === stop.beforeOpId)
    return {
      id: stop.id, kind: 'operator_stop', name: 'Operator stop', enabled: true,
      afterOpId: at > 0 ? ops[at - 1].id : null, message: stop.message,
    }
  })
}
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from './helpers'

const PARK = { x: 738, y: 724.5, z: 128 }
const MESSAGE = 'Drive the 4 screws, then press Cycle Start'
const G54 = { x: 100, y: 120, z: -60 }

const DIALECTS: Array<{ config: PostConfig; reader: GcodeDialect; controller: MachineConfig['controller']; stop: string }> = [
  { config: UCCNC_CONFIG, reader: 'uccnc', controller: 'uccnc', stop: 'M2001' },
  { config: GRBL_CONFIG, reader: 'grbl', controller: 'grbl', stop: 'M0' },
  { config: GRBLHAL_CONFIG, reader: 'grbl', controller: 'grbl', stop: 'M0' },
  { config: LINUXCNC_CONFIG, reader: 'linuxcnc', controller: 'linuxcnc', stop: 'M0' },
  { config: GENERIC_CONFIG, reader: 'generic', controller: 'generic' as MachineConfig['controller'], stop: 'M0' },
]

function cutOp(id: string, x: number, toolId = 't1'): Operation {
  return makeOp({
    id,
    name: `Op ${id}`,
    toolId,
    toolpathMoves: [
      move({ type: 'rapid', x, y: 10, z: 5, role: 'rapid' }),
      move({ type: 'feed', x, y: 10, z: -1, feed: 400, role: 'plunge' }),
      move({ type: 'feed', x: x + 20, y: 10, z: -1, feed: 2000, role: 'cut' }),
      move({ type: 'rapid', x: x + 20, y: 10, z: 5, role: 'rapid' }),
    ],
  })
}

function machineWithPark(controller: MachineConfig['controller'], park: typeof PARK | null = PARK): MachineConfig {
  return makeMachine({
    controller,
    macros: park === null ? [] : [
      { id: 'park-1', name: 'Park 1', body: positionMacroBody({ ...park, zFirst: true }), usedForToolChange: true },
    ],
  })
}

function project(
  ops: Operation[],
  stops: StopAt[] | undefined,
  machine: MachineConfig = machineWithPark('uccnc'),
  extraSetups: Setup[] = [],
): { project: Project; setups: Setup[] } {
  const setup: Setup = {
    id: 's1',
    name: 'Setup 1',
    wcs: makeWcs(),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
    operations: ops,
    ...(stops === undefined ? {} : { machineActions: operatorStopActions(ops, stops) }),
    notes: '',
  }
  const setups = [setup, ...extraSetups]
  const p: Project = {
    id: 'p1',
    name: 'WO-2437',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine,
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [],
    setups,
    activeSetupId: null,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  for (const s of setups) {
    for (const op of s.operations) stampGenerationCurrent(p, s, op, p.toolLibrary.find((t) => t.id === op.toolId)!)
  }
  return { project: p, setups }
}

function postText(
  built: { project: Project; setups: Setup[] },
  config: PostConfig,
  options: Partial<PostProjectOptions> = {},
): string {
  const result = postProject(built.project, built.setups, config, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2437', ext: 'nc', ...options,
  })
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return options.mode === 'combined' ? result.combined!.gcode : result.files![0].result.gcode
}

function read(gcode: string, dialect: GcodeDialect, machine: MachineConfig) {
  const result = readGcodeProgram(gcode, {
    dialect,
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    macroMCodes: 'report',
    workOffsets: { G54: G54 },
    machineDefinition: machine,
  })
  if (!result.ok) throw new Error(`reader refused line ${result.refusal.line}: ${result.refusal.message}`)
  return result.program
}

/** A feed line cutting to X (the modal G1 may be suppressed). */
const cutsTo = (x: number) => (line: string) => new RegExp(`^(G1 )?X${x}(\\.0*)? .*F`).test(line)
const isCut = (line: string) => /^(G1\b|[XYZ]-?[\d.]+.* F)/.test(line)

const num = (line: string, letter: string) => Number(new RegExp(`\\b${letter}(-?[\\d.]+)`).exec(line)?.[1])

/** The 1-based line of the first match at or after `from`. */
function lineOf(lines: string[], test: (line: string) => boolean, from = 1): number {
  const index = lines.findIndex((line, i) => i + 1 >= from && test(line))
  return index < 0 ? -1 : index + 1
}

describe('WO-2437 operator stop between operations, every dialect', () => {
  for (const { config, reader, controller, stop } of DIALECTS) {
    it(`${config.id}: A, retract, park, message, ${stop}, then B - and the reader finds that order`, () => {
      const machine = machineWithPark(controller)
      const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st1', beforeOpId: 'b', message: MESSAGE }], machine)
      const gcode = postText(built, config)
      const lines = gcode.split('\n')

      // The text, in order.
      const aCut = lineOf(lines, cutsTo(20))
      const stopLine = lineOf(lines, (l) => l.trim() === stop)
      expect(aCut).toBeGreaterThan(0)
      expect(stopLine).toBeGreaterThan(aCut)
      const block = lines.slice(aCut, stopLine)
      const retract = block.findIndex((l) => /^G0 Z5(\.0*)?$/.test(l))
      const parkZ = block.findIndex((l) => /^G53 G0 Z128(\.0*)?$/.test(l))
      const parkXY = block.findIndex((l) => /^G53 G0 X738(\.0*)? Y724\.50*$/.test(l))
      expect(retract, block.join('\n')).toBeGreaterThanOrEqual(0)
      expect(block).toContain('M5')
      expect(parkZ).toBeGreaterThan(retract)
      expect(parkXY).toBeGreaterThan(parkZ)
      // The message is the line just before the stop.
      const messageLine = lines[stopLine - 2]
      expect(messageLine).toContain(MESSAGE)
      if (config.id === 'linuxcnc') expect(messageLine).toBe(`(MSG, ${MESSAGE})`)
      // WO-2591: M2001 owns the operator hold; a following M0 adds a second stop.
      if (stop === 'M2001') expect(lines.slice(stopLine).filter(l => l.trim() && !/^\s*\(/.test(l)).slice(0, 2)).not.toContain('M0')
      // B follows the stop: spindle back on, Z lifted alone, then B's start.
      const after = lines.slice(stopLine)
      const restart = after.findIndex((l) => /^M3 S/.test(l))
      const bStart = after.findIndex((l) => /\bX50(\.0*)?\b/.test(l) && !/^G53/.test(l))
      expect(restart).toBeGreaterThanOrEqual(0)
      expect(bStart).toBeGreaterThan(restart)
      expect(after.slice(0, bStart).some((l) => /^G0 Z[\d.]+$/.test(l))).toBe(true)

      // The app's own reader: A's last move, the retract, the park, the stop, then B.
      const program = read(gcode, reader, machine)
      const stopItem = program.items.find((item) =>
        stop === 'M2001' ? item.kind === 'macro' && item.code === 2001 : item.kind === 'pause' && !item.optional)
      expect(stopItem, JSON.stringify(program.items.map((i) => i.kind))).toBeDefined()
      expect(program.items.some((item) => item.kind === 'pause' && !item.optional && item.line >= stopItem!.line)).toBe(stop !== 'M2001')
      const before = program.moves.filter((_, i) => program.moveLines[i] < stopItem!.line)
      const afterMoves = program.moves.filter((_, i) => program.moveLines[i] > stopItem!.line)
      const last = before[before.length - 1]
      // The last move before the stop is the park (work = machine - G54).
      expect(last.x).toBeCloseTo(PARK.x - G54.x, 3)
      expect(last.y).toBeCloseTo(PARK.y - G54.y, 3)
      expect(last.z).toBeCloseTo(PARK.z - G54.z, 3)
      // ... reached by Z first, after the retract from A's cut.
      const cutIndex = before.findIndex((m) => Math.abs(m.x - 20) < 1e-6 && Math.abs(m.z + 1) < 1e-6)
      expect(cutIndex).toBeGreaterThanOrEqual(0)
      const tail = before.slice(cutIndex + 1)
      expect(tail.some((m) => Math.abs(m.z - 5) < 1e-6 && Math.abs(m.x - 20) < 1e-6)).toBe(true)
      expect(tail.at(-2)!.z).toBeCloseTo(PARK.z - G54.z, 3)
      // B cuts after the stop, from where the stop left off.
      expect(afterMoves.some((m) => Math.abs(m.x - 70) < 1e-6 && Math.abs(m.z + 1) < 1e-6)).toBe(true)
      expect(afterMoves[0].x).toBeCloseTo(PARK.x - G54.x, 3)
      expect(afterMoves[0].y).toBeCloseTo(PARK.y - G54.y, 3)
      // The spindle is off at the stop and on again before B cuts.
      const spindleItems = program.items.filter((item) => item.kind === 'spindle')
      expect(spindleItems.some((item) => item.kind === 'spindle' && !item.on && item.line < stopItem!.line)).toBe(true)
      expect(spindleItems.some((item) => item.kind === 'spindle' && item.on && item.line > stopItem!.line)).toBe(true)
    })

    it(`${config.id}: an empty message still posts the retract, park and stop`, () => {
      const machine = machineWithPark(controller)
      const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st1', beforeOpId: 'b', message: '  ' }], machine)
      const lines = postText(built, config).split('\n')
      const stopLine = lineOf(lines, (l) => l.trim() === stop)
      expect(stopLine).toBeGreaterThan(0)
      expect(lines[stopLine - 2]).toMatch(/^G53 G0 X738/)
      read(lines.join('\n'), reader, machine)
    })

    it(`${config.id}: a stop first or last in the setup posts the same retract, park and stop`, () => {
      const machine = machineWithPark(controller)
      const built = project([cutOp('a', 0), cutOp('b', 50)], [
        { id: 'first', beforeOpId: 'a', message: 'Clamp the stock' },
        { id: 'last', beforeOpId: null, message: 'Remove the part' },
      ], machine)
      const gcode = postText(built, config)
      const lines = gcode.split('\n')
      const stops = lines.map((l, i) => (l.trim() === stop ? i + 1 : -1)).filter((i) => i > 0)
      expect(stops).toHaveLength(2)
      const firstCut = lineOf(lines, isCut)
      const lastCut = lines.length - [...lines].reverse().findIndex(isCut)
      expect(stops[0]).toBeLessThan(firstCut)
      expect(stops[1]).toBeGreaterThan(lastCut)
      for (const [n, at] of stops.entries()) {
        const block = lines.slice(n === 0 ? 0 : lastCut, at)
        expect(block.some((l) => /^G0 Z5(\.0*)?$/.test(l)), block.join('\n')).toBe(true)
        expect(block).toContain('M5')
        expect(block.some((l) => /^G53 G0 Z128/.test(l))).toBe(true)
        expect(lines[at - 2]).toMatch(/Clamp the stock|Remove the part/)
      }
      // The program still ends as before after the last stop.
      expect(lines.filter(Boolean).at(-1)).toBe('M30')
      read(gcode, reader, machine)
    })
  }
})

describe('WO-2437 where a stop runs, and what does not change', () => {
  it('a setup with no stops posts byte-identical output to one with an empty stop list', () => {
    for (const { config, controller } of DIALECTS) {
      const machine = machineWithPark(controller)
      const without = postText(project([cutOp('a', 0), cutOp('b', 50)], undefined, machine), config)
      const empty = postText(project([cutOp('a', 0), cutOp('b', 50)], [], machine), config)
      expect(empty).toBe(without)
      expect(without).not.toMatch(/G53|M2001/)
    }
  })

  it('a stop before a suppressed operation runs before the next one that posts', () => {
    const ops = [cutOp('a', 0), { ...cutOp('b', 50), enabled: false }, cutOp('c', 100)]
    const lines = postText(project(ops, [{ id: 'st', beforeOpId: 'b', message: MESSAGE }]), GRBL_CONFIG).split('\n')
    const stopLine = lineOf(lines, (l) => l === 'M0')
    expect(stopLine).toBeGreaterThan(lineOf(lines, cutsTo(20)))
    expect(stopLine).toBeLessThan(lineOf(lines, cutsTo(120)))
  })

  it('a stop before an operation left out of the selection runs before the next selected one, or last', () => {
    const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st', beforeOpId: 'b', message: MESSAGE }])
    const lines = postText(built, GRBL_CONFIG, { selectedOpIds: { s1: ['a'] } }).split('\n')
    const stopLine = lineOf(lines, (l) => l === 'M0')
    expect(stopLine).toBeGreaterThan(lineOf(lines, cutsTo(20)))
    expect(lines.slice(stopLine).some(isCut)).toBe(false)
  })

  it('a machine with no park retracts and stops in place, and the file says so', () => {
    const machine = machineWithPark('grbl', null)
    const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st', beforeOpId: 'b', message: MESSAGE }], machine)
    const lines = postText(built, GRBL_CONFIG).split('\n')
    const stopLine = lineOf(lines, (l) => l === 'M0')
    const block = lines.slice(lineOf(lines, cutsTo(20)), stopLine)
    expect(block.join('\n')).not.toMatch(/G53/)
    expect(block.some((l) => /no park position/.test(l))).toBe(true)
    expect(block.some((l) => /^G0 Z5(\.0*)?$/.test(l))).toBe(true)
  })

  it('a tool change after a stop still runs the full tool change', () => {
    const built = project([cutOp('a', 0), cutOp('b', 50, 't2')], [{ id: 'st', beforeOpId: 'b', message: MESSAGE }])
    const lines = postText(built, UCCNC_CONFIG).split('\n')
    const stopLine = lineOf(lines, (l) => l === 'M2001')
    const change = lineOf(lines, (l) => l === 'T2 M6')
    expect(change).toBeGreaterThan(stopLine)
    expect(lineOf(lines, (l) => /^M3 S/.test(l), change)).toBeGreaterThan(change)
  })

  it('combined: a stop after setup 1 restarts the spindle for setup 2 on the same tool', () => {
    const second: Setup = {
      id: 's2', name: 'Setup 2', wcs: makeWcs({ id: 'w2', label: 'G55', fixtureOffset: 55 }),
      stock: { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 } } as unknown as Stock,
      operations: [cutOp('c', 0)], notes: '',
    }
    const built = project([cutOp('a', 0)], [{ id: 'st', beforeOpId: null, message: MESSAGE }], machineWithPark('grbl'), [second])
    const gcode = postText(built, GRBL_CONFIG, { mode: 'combined' })
    const lines = gcode.split('\n')
    const stopLine = lineOf(lines, (l) => l === 'M0')
    const g55 = lineOf(lines, (l) => l === 'G55', stopLine)
    const restart = lineOf(lines, (l) => /^M3 S/.test(l), g55)
    const cut = lineOf(lines, isCut, g55)
    expect(g55).toBeGreaterThan(stopLine)
    expect(restart).toBeGreaterThan(g55)
    expect(cut).toBeGreaterThan(restart)
  })

  it('inch output converts the park position like every other dimension', () => {
    const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st', beforeOpId: 'b', message: MESSAGE }], machineWithPark('grbl'))
    const config = { ...GRBL_CONFIG, format: { ...GRBL_CONFIG.format, units: 'inch' as const, xyzDecimals: 4 } }
    const lines = postText(built, config).split('\n')
    const parkZ = lines.find((l) => /^G53 G0 Z/.test(l))!
    expect(num(parkZ, 'Z')).toBeCloseTo(128 / 25.4, 3)
  })
})

// Fix round 3 (Operator ruling 2026-10-02 4:26 PM, "User setable"): the park is the
// machine's own `operatorStopPark` setting; unset, the machine's Park 1.
describe('WO-2437 the stop parks where the machine definition says', () => {
  const PARK_1 = { id: 'park-1', name: 'Park 1', body: positionMacroBody({ ...PARK, zFirst: true }) }
  const TOOL_CHANGE = {
    id: 'tc', name: 'Tool change', body: positionMacroBody({ x: 730, y: 50, z: 120, zFirst: true }), usedForToolChange: true,
  }
  const parkLines = (machine: MachineConfig) => {
    const built = project([cutOp('a', 0), cutOp('b', 50)], [{ id: 'st', beforeOpId: 'b', message: MESSAGE }], machine)
    const lines = postText(built, GRBL_CONFIG).split('\n')
    return lines.slice(lineOf(lines, cutsTo(20)), lineOf(lines, (l) => l === 'M0')).filter((l) => /^G53 /.test(l))
  }

  it('the user\'s setting wins over Park 1 and the tool-change park, Z first, in machine coordinates', () => {
    const machine = makeMachine({
      controller: 'grbl', macros: [PARK_1, TOOL_CHANGE], operatorStopPark: { x: 50, y: 724.5, z: 125 },
    })
    expect(parkLines(machine)).toEqual(['G53 G0 Z125', 'G53 G0 X50 Y724.5'])
    expect(workholdingStopPark(machine, undefined)).toMatchObject({ x: 50, y: 724.5, z: 125 })
  })

  it('unset, the stop parks at Park 1 even when another park is flagged for the tool change', () => {
    const machine = makeMachine({ controller: 'grbl', macros: [PARK_1, TOOL_CHANGE] })
    expect(parkLines(machine)).toEqual(['G53 G0 Z128', 'G53 G0 X738 Y724.5'])
    expect(parkLines({ ...machine, operatorStopPark: null })).toEqual(['G53 G0 Z128', 'G53 G0 X738 Y724.5'])
  })

  it('unset, a machine with no position macro parks at its G30 P1', () => {
    const machine = makeMachine({
      controller: 'grbl', macros: [], referencePositions: { 1: { x: 700, y: 20, z: 110 }, 2: { x: 10, y: 20, z: 110 } },
    })
    expect(parkLines(machine)).toEqual(['G53 G0 Z110', 'G53 G0 X700 Y20'])
  })

  it('unset, with no Park 1 the stop keeps the route it had: the machine\'s only park', () => {
    const machine = makeMachine({ controller: 'grbl', macros: [], referencePositions: { 2: { x: 10, y: 20, z: 110 } } })
    expect(parkLines(machine)).toEqual(['G53 G0 Z110', 'G53 G0 X10 Y20'])
  })
})
