// WO-2023 / WO-3123: approach at authored machine safe Z before XY, and again
// after every tool change. Rehearsal 09-26: the first line `G0 X126.841 Y20.267
// Z15`, run from the tool-change park at Z 20, and the first line after a guided
// M6 measure at the setter, each travelled diagonally across the table.
import { describe, expect, it } from 'vitest'
import { emitCombinedProgram, emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import type { PostInput, PostOperation } from '../../lib/post/types'
import type { ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from './helpers'

const machine = makeMachine({ coolant: false, safeZMachine: 120 })

function postOp(id: string, toolNumber: number, moves: ToolpathMove[]): PostOperation {
  const tool = makeTool({ id: `t${toolNumber}`, toolNumber })
  const op = makeOp({ id, name: id, toolId: tool.id, toolpathMoves: moves })
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }
}

function input(ops: PostOperation[], wcs = makeWcs()): PostInput {
  return { machine, setup: { wcs, operations: ops } }
}

/** Rapid in at clearance, plunge, cut, rapid out - the shape CAM streams open with. */
function cutAt(x: number, clearance = 15, bottom = -5): ToolpathMove[] {
  return [
    move({ type: 'rapid', x, y: 20, z: clearance, role: 'rapid' }),
    move({ type: 'feed', x, y: 20, z: bottom, feed: 300, role: 'plunge' }),
    move({ type: 'feed', x: x + 5, y: 25, z: bottom, feed: 1200, role: 'cut' }),
    move({ type: 'rapid', x: x + 5, y: 25, z: clearance, role: 'rapid' }),
  ]
}

const isMotion = (l: string) => /(^|\s)[XYZ]-?\d/.test(l)
const isToolLoad = (l: string) => /^T\d+/.test(l) || /change tool to T\d+/.test(l)

/** Every motion line that follows a tool load, up to its first XY travel. */
function openingAfterEachToolLoad(lines: string[]): string[][] {
  const out: string[][] = []
  lines.forEach((l, i) => {
    if (!isToolLoad(l)) return
    const motion: string[] = []
    for (const next of lines.slice(i + 1)) {
      if (!isMotion(next)) continue
      motion.push(next)
      if (/[XY]-?\d/.test(next)) break
    }
    out.push(motion)
  })
  return out
}

describe('WO-2023 program starts by lifting Z before it travels', () => {
  it('the first motion is to authored machine safe Z, then XY, then the unchanged first move', () => {
    const { lines } = emitProgram(input([postOp('a', 1, cutAt(10))]), UCCNC_CONFIG)
    expect(lines).toEqual([
      'G90 G94 G17 G21 G64',
      'G54',
      '( a )',
      'T1',
      'M3 S12000',
      'G53 G0 Z120',
      'G0 X10 Y20',
      'G0 X10 Y20 Z15',
      'G1 Z-5 F300',
      'X15 Y25 F1200',
      'G0 Z15',
      'M5',
      'G0 Z15',
      'M30',
    ])
  })

  it('a first move below clearance lifts to clearance, travels XY there, then descends', () => {
    const moves = [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 10, y: 20, z: -5, feed: 300, role: 'plunge' }),
      move({ type: 'rapid', x: 10, y: 20, z: 25, role: 'rapid' }),
    ]
    const { lines } = emitProgram(input([postOp('a', 1, moves)]), UCCNC_CONFIG)
    const start = lines.indexOf('M3 S12000') + 1
    expect(lines.slice(start, start + 4)).toEqual(['G53 G0 Z120', 'G0 X10 Y20', 'G0 X10 Y20 Z5', 'G1 Z-5 F300'])
  })

  it('a first move that is a feed still gets the lift and the XY travel first', () => {
    const moves = [move({ type: 'feed', x: 10, y: 20, z: 2, feed: 300, role: 'plunge' }), ...cutAt(10)]
    const { lines } = emitProgram(input([postOp('a', 1, moves)]), UCCNC_CONFIG)
    const start = lines.indexOf('M3 S12000') + 1
    expect(lines.slice(start, start + 3)).toEqual(['G53 G0 Z120', 'G0 X10 Y20', 'G1 X10 Y20 Z2 F300'])
  })

  it('every tool change lifts Z alone before the first XY travel after the M6', () => {
    const ops = [postOp('a', 1, cutAt(10)), postOp('b', 2, cutAt(40)), postOp('c', 3, cutAt(70))]
    const { lines } = emitProgram(input(ops), UCCNC_CONFIG)
    const afterM6 = lines.indexOf('T2 M6')
    expect(lines.slice(afterM6, afterM6 + 6)).toEqual([
      'T2 M6', 'G54', 'M3 S12000', 'G53 G0 Z120', 'G0 X40 Y20', 'G0 X40 Y20 Z15',
    ])
    const openings = openingAfterEachToolLoad(lines)
    expect(openings).toHaveLength(3)
    for (const opening of openings) {
      expect(opening[0]).toBe('G53 G0 Z120')
      expect(opening[1]).toMatch(/^G0 X\d+ Y20$/)
    }
  })

  it('a same-tool operation gets no extra lift - the tool was not reloaded', () => {
    const { lines } = emitProgram(input([postOp('a', 1, cutAt(10)), postOp('b', 1, cutAt(40))]), UCCNC_CONFIG)
    const second = lines.indexOf('( b )')
    expect(lines.slice(second, second + 3)).toEqual(['( b )', 'G0 X40 Y20 Z15', 'G1 Z-5 F300'])
    expect(lines.filter((l) => l === 'G0 Z15')).toHaveLength(3) // a's out, b's out, program end; opening uses machine safe Z
  })

  it('a controller without M6 (GRBL pause) lifts the same way after its change', () => {
    const ops = [postOp('a', 1, cutAt(10)), postOp('b', 2, cutAt(40))]
    const { lines } = emitProgram(input(ops), GRBL_CONFIG)
    for (const opening of openingAfterEachToolLoad(lines)) {
      expect(opening[0]).toBe('G53 G0 Z120')
      expect(opening[1]).toMatch(/^G0 X\d+ Y20$/)
    }
  })

  it('a combined program lifts at its start and after the tool change into the next setup', () => {
    const wcs2 = makeWcs({ fixtureOffset: 55 })
    const { lines } = emitCombinedProgram(
      [input([postOp('a', 1, cutAt(10))]), input([postOp('b', 2, cutAt(40, 10, -3))], wcs2)],
      UCCNC_CONFIG,
      { pauseBetweenSetups: false },
    )
    const openings = openingAfterEachToolLoad(lines)
    expect(openings).toEqual([
      ['G53 G0 Z120', 'G0 X10 Y20'],
      ['G53 G0 Z120', 'G0 X40 Y20'],
    ])
  })

  it('removing only the approach lines preserves every original move and stop', () => {
    const ops = [postOp('a', 1, cutAt(10)), postOp('b', 2, cutAt(40))]
    const { lines } = emitProgram(input(ops), UCCNC_CONFIG)
    const lifts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => l === 'G53 G0 Z120' && /^M3 /.test(lines[i - 1]))
    expect(lifts.map(({ i }) => i)).toEqual([lines.indexOf('T1') + 2, lines.indexOf('T2 M6') + 3])
    const without = lines.filter((_, i) => !lifts.some((x) => x.i === i || x.i + 1 === i))
    expect(without).toEqual([
      'G90 G94 G17 G21 G64', 'G54',
      '( a )', 'T1', 'M3 S12000',
      'G0 X10 Y20 Z15', 'G1 Z-5 F300', 'X15 Y25 F1200', 'G0 Z15',
      '( b )', 'M5', 'M9', 'G0 Z15', 'T2 M6', 'G54', 'M3 S12000',
      'G0 X40 Y20 Z15', 'G1 Z-5 F300', 'X45 Y25 F1200', 'G0 Z15',
      'M5', 'G0 Z15', 'M30',
    ])
  })
})
