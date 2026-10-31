import { describe, expect, it } from 'vitest'
import { BUILT_IN_DIALECTS, parseUserPostConfig, serializeUserPostConfig, postCombined, postProgram } from '../../lib/post'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import type { DrillWorkerPayload } from '../../lib/cam/types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'

const machine = makeMachine({ coolant: false, safeZMachine: 120 })
function operation(id: string, number = 1): PostOperation {
  const tool = makeTool({ id: `t${number}`, toolNumber: number })
  const moves = [move({ type: 'rapid', x: 126.6, y: 21.709, z: 15 }),
    move({ x: 126.6, y: 21.709, z: 1, feed: 300, role: 'plunge' }),
    move({ x: 130, y: 21.709, z: 1, feed: 1000 }),
    move({ type: 'rapid', x: 130, y: 21.709, z: 15 })]
  const op = makeOp({ id, name: id, toolId: tool.id, toolpathMoves: moves })
  return { op, tool, moves, feeds: resolveFeedrates(tool, undefined, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine), coolant: resolveCoolant(tool, machine) }
}
function input(operations = [operation('a')]): PostInput {
  return { machine, setup: { wcs: makeWcs(), operations } }
}
function lines(input: PostInput, config: PostConfig) {
  const result = postProgram(input, config)
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
  return result.gcode.trim().split('\n')
}
const motions = (lines: string[]) => lines.filter(l => /\b[XYZ]-?\d/.test(l))
function expectApproach(lines: string[], z = '120', xy = 'X126.6 Y21.709') {
  expect(motions(lines).slice(0, 3)).toEqual([`G53 G0 Z${z}`, `G0 ${xy}`, `G0 ${xy} Z15`])
}

describe('WO-3123 production post starts and restarts at authored safe height', () => {
  for (const config of BUILT_IN_DIALECTS.filter(c => c.builtin)) {
    it(`${config.id}: authored safe Z, XY at that height, then work Z`, () => {
      expectApproach(lines(input(), config))
    })
    it(`${config.id}: tool-change and operator-stop returns use the same approach`, () => {
      const source = input([operation('a'), operation('b', 2), operation('c', 2)])
      source.setup.operatorStops = [{ beforeOpId: 'c', message: 'Check clamps' }]
      const posted = lines(source, config)
      for (const name of ['a', 'b', 'c']) {
        const at = posted.findIndex(l => l === `( ${name} )` || l === `; ${name}`)
        const first = posted.findIndex((l, i) => i > at && l === 'G53 G0 Z120')
        expect(first).toBeGreaterThan(at)
        expectApproach(posted.slice(first))
      }
      expect(posted.filter(l => l === 'G1 Z1 F300')).toHaveLength(3)
    })
  }
  it.each([false, true])('same-tool setup entry (pause=%s) reapproaches after WCS selection', pause => {
    const second = input([operation('b')])
    second.setup.wcs = makeWcs({ fixtureOffset: 55 })
    const result = postCombined([input(), second], BUILT_IN_DIALECTS[0], { pauseBetweenSetups: pause })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expectApproach(result.gcode.split('\n').slice(result.gcode.split('\n').indexOf('G55') + 1))
  })
  it('callable macro return reapproaches without changing the macro method', () => {
    const source = input([operation('a'), operation('b')])
    source.machine = { ...machine, macros: [{ id: 'check', name: 'Check', mCode: 2002, body: '' }] }
    source.setup.machineActions = [{ kind: 'run_macro', beforeOpId: 'b', macroId: 'check', name: 'Check' }]
    const posted = lines(source, BUILT_IN_DIALECTS[0])
    expect(posted).toContain('M2002')
    expectApproach(posted.slice(posted.indexOf('M2002') + 1))
  })
  it.each(['clearance', 'retract'] as const)('native drill %s entry positions XY before establishing G98 initial Z', retractMode => {
    const source = input()
    const op = source.setup.operations[0]
    op.op.type = 'drill'
    const params: DrillWorkerPayload['params'] = { cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0, retractMode, sortStrategy: 'by_x', geometryId: 'g', loopIds: [] }
    op.op.params = { ...params }
    const payload: DrillWorkerPayload = { opId: 'a', setupId: 's', params, heights: op.op.heights,
      passes: op.op.passes, linking: op.op.linking, tool: op.tool, wcsOrigin: { x: 0, y: 0, z: 0 },
      loops: [{ id: 'hole', closed: true, type: 'contour', points: [{ x: 8, y: 18 }, { x: 12, y: 18 }, { x: 12, y: 22 }, { x: 8, y: 22 }] }],
    }
    op.moves = buildDrillToolpath(payload)
    op.op.toolpathMoves = op.moves
    const posted = lines(source, BUILT_IN_DIALECTS[0])
    expect(motions(posted).slice(0, 2)).toEqual(['G53 G0 Z120', 'G0 X10 Y20'])
    expect(posted.some(l => /G8[123]/.test(l))).toBe(true)
  })
  it('inch post converts authored machine mm and keeps XY separate from descent', () => {
    const base = BUILT_IN_DIALECTS[0]
    const posted = lines(input(), { ...base, format: { ...base.format, units: 'inch', xyzDecimals: 5 } })
    expect(motions(posted).slice(0, 2)).toEqual(['G53 G0 Z4.72441', 'G0 X4.98425 Y0.85469'])
  })
  it('a post that cannot use machine coordinates keeps clearance fallback', () => {
    const base = BUILT_IN_DIALECTS[0]
    const posted = lines(input(), { ...base, capabilities: { ...base.capabilities, machineCoordinates: false } })
    expect(motions(posted).slice(0, 2)).toEqual(['G0 Z15', 'G0 X126.6 Y21.709 Z15'])
    expect(posted.some(l => /G53 is unavailable.*work clearance/.test(l))).toBe(true)
  })
  it.each([false, true, undefined])('portable import and roundtrip preserve machineCoordinates=%s and its approach', machineCoordinates => {
    const base = structuredClone(BUILT_IN_DIALECTS[0])
    base.capabilities.machineCoordinates = machineCoordinates
    const imported = parseUserPostConfig(JSON.stringify(base))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    const roundtrip = parseUserPostConfig(serializeUserPostConfig(imported.config))
    expect(roundtrip.ok).toBe(true)
    if (!roundtrip.ok) return
    for (const config of [imported.config, roundtrip.config]) {
      const posted = lines(input(), config)
      // Check production behavior before the field itself: old importer fails
      // here by commanding G53 on a controller explicitly declaring it absent.
      if (machineCoordinates === false) {
        expect(motions(posted).slice(0, 2)).toEqual(['G0 Z15', 'G0 X126.6 Y21.709 Z15'])
        expect(posted.some(l => /G53 is unavailable.*work clearance/.test(l))).toBe(true)
      } else {
        expectApproach(posted)
      }
      expect(config.capabilities.machineCoordinates).toBe(machineCoordinates)
    }
  })
  it.each(['false', 0, null])('portable import rejects malformed machineCoordinates=%s', machineCoordinates => {
    const base = structuredClone(BUILT_IN_DIALECTS[0])
    const source = { ...base, capabilities: { ...base.capabilities, machineCoordinates } }
    expect(parseUserPostConfig(JSON.stringify(source))).toEqual({
      ok: false, error: 'capabilities.machineCoordinates must be true or false',
    })
  })
  it.each([undefined, 0])('missing or zero safe Z (%s) retains clearance fallback and names the setting', safeZMachine => {
    const source = input()
    source.machine = { ...machine, safeZMachine }
    const posted = lines(source, BUILT_IN_DIALECTS[0])
    expect(motions(posted).slice(0, 2)).toEqual(['G0 Z15', 'G0 X126.6 Y21.709 Z15'])
    expect(posted.some(l => /safe Z.*work clearance/i.test(l))).toBe(true)
    expect(posted.some(l => /G53 G0 Z0(?:\D|$)/.test(l))).toBe(false)
  })
})

// Review edge case (10-27): a program whose first move is a feed still lifts and
// crosses XY high; the original feed move then descends from authored safe Z.
it('a feed first move descends from authored safe Z at its own feed after XY', () => {
  const op = operation('feedfirst')
  op.moves.shift()
  op.op.toolpathMoves = op.moves
  const first = motions(lines(input([op]), BUILT_IN_DIALECTS[0])).slice(0, 3)
  expect(first.slice(0, 2)).toEqual(['G53 G0 Z120', 'G0 X126.6 Y21.709'])
  expect(first[2]).toMatch(/^G1\b.*Z1\b.*F300/)
})
