import { describe, expect, it } from 'vitest'
import { buildPreviewModel, samplePreviewArc } from '../../lib/machine/previewGeometry'
import { transferCheckJobFromProgram } from '../../lib/machine/programContext'
import { checkJobAgainstMachine } from '../../lib/machine/transferCheck'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { createDefaultControllerDefinition } from '../../types'
import { makeMachine } from '../post/helpers'

// Inch scaling can differ in the last binary digit between an absolute centre
// and start + offset. Compare geometry to 1e-8 mm, far below chord tolerance.
const point = (p: { x: number; y: number; z?: number }) => ({
  x: expect.closeTo(p.x, 8), y: expect.closeTo(p.y, 8),
  ...(p.z !== undefined ? { z: expect.closeTo(p.z, 8) } : {}),
})

function equivalent(absolute: string, incremental: string) {
  const actual = buildPreviewModel(absolute)
  const twin = buildPreviewModel(incremental)
  expect(actual.refusal).toBeNull()
  expect(twin.refusal).toBeNull()
  expect(actual.polylines).toEqual(twin.polylines.map((line) => ({ ...line, points: line.points.map(point) })))
  expect(actual.moves.map(({ sourceArc: _sourceArc, ...move }) => move))
    .toEqual(twin.moves.map(({ sourceArc: _sourceArc, ...move }) => ({ ...move, from: point(move.from), to: point(move.to) })))
  expect(actual.workBounds).toEqual(twin.workBounds && { min: point(twin.workBounds.min), max: point(twin.workBounds.max) })
  expect(actual.addressedAxes).toEqual(twin.addressedAxes)
  return actual
}

describe('WO-2260 production preview reads arc-centre distance mode', () => {
  it.each(['G2', 'G3'])('%s absolute centres draw the incremental twin in XY', (direction) => {
    const model = equivalent(
      `G21 G90 G17 G54 G90.1\nG0 X30 Y20 Z5\n${direction} X10 Y20 I20 J20 F300`,
      `G21 G90 G17 G54 G91.1\nG0 X30 Y20 Z5\n${direction} X10 Y20 I-10 J0 F300`,
    )
    expect(model.polylines.at(-1)!.points.length).toBeGreaterThan(8)
  })

  it('explicit G91.1 alone draws the existing default', () => {
    equivalent('G91.1\nG0 X30 Y20\nG3 X10 Y20 I-10 J0 F300',
      '\nG0 X30 Y20\nG3 X10 Y20 I-10 J0 F300')
  })

  it('switches back on the arc block without changing endpoint distance mode', () => {
    equivalent(
      'G21 G90 G90.1\nG0 X30 Y20\nG3 X10 Y20 I20 J20 F300\nG91 G91.1 G3 X20 Y0 I10 J0',
      'G21 G90\nG0 X30 Y20\nG3 X10 Y20 I-10 J0 F300\nG91 G3 X20 Y0 I10 J0',
    )
  })

  it.each([
    ['G18', 'G0 X30 Y5 Z20', 'G3 X10 Z20 I20 K20', 'G3 X10 Z20 I-10 K0'],
    ['G19', 'G0 X5 Y30 Z20', 'G3 Y10 Z20 J20 K20', 'G3 Y10 Z20 J-10 K0'],
  ])('reads absolute centres in %s through the shared plane frame', (plane, start, abs, inc) => {
    equivalent(`G21 G90 ${plane} G90.1\n${start}\n${abs} F300`,
      `G21 G90 ${plane}\n${start}\n${inc} F300`)
  })

  it('scales absolute centres in inches and leaves an omitted centre axis at the start', () => {
    equivalent('G20 G90 G90.1\nG0 X3 Y2\nG2 X1 Y2 I2 F10',
      'G20 G90\nG0 X3 Y2\nG2 X1 Y2 I-1 F10')
  })

  it('keeps absolute centre mode independent of incremental endpoints and helix Z', () => {
    equivalent('G21 G90 G90.1\nG0 X30 Y20 Z5\nG91 G3 X-20 Y0 Z-2 I20 J20 F300',
      'G21 G90\nG0 X30 Y20 Z5\nG91 G3 X-20 Y0 Z-2 I-10 J0 F300')
  })

  it('leaves R arcs independent of centre mode', () => {
    equivalent('G90 G90.1\nG0 X30 Y20\nG2 X10 Y20 R10 F300',
      'G90\nG0 X30 Y20\nG2 X10 Y20 R10 F300')
  })

  it('retains absolute coordinates when the transfer checker supplies a different WCS start', () => {
    const model = buildPreviewModel('G21 G90 G54\nG0 X30 Y20 Z5\nG55 G90.1 G3 X10 Y30 I10 J20 F300')
    expect(model.refusal).toBeNull()
    const command = model.moves.find((move) => move.kind === 'arc')!.sourceArc!
    const from = { x: 20, y: 20, z: 5 }
    const to = { x: 10, y: 30, z: 5 }
    const samples = samplePreviewArc(from, to, command, 'xy')
    expect(samples.length).toBeGreaterThan(8)
    for (const point of samples) expect(Math.hypot(point.x - 10, point.y - 20)).toBeCloseTo(10, 8)
  })

  it('still refuses G93 whole after accepting arc-centre mode', () => {
    const model = buildPreviewModel('G90.1\nG0 X30 Y20\nG93 G3 X10 Y20 I20 J20 F2')
    expect(model.refusal).toContain('Line 3: G93')
    expect(model.moves).toEqual([])
    expect(model.polylines).toEqual([])
  })

  it.each([['safe', 30], ['unsafe', 50]] as const)('checks the %s absolute-centre arc after a WCS change', (kind, centreY) => {
    const definition = createDefaultControllerDefinition()
    definition.axes = definition.axes.map((axis) => ({ ...axis, softLimitMin: 0, softLimitMax: 100 }))
    definition.stated = definition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
      controller: 'grbl' as const, key: axisSoftLimitStatementKey(axis.axis, end),
    })))
    const machine = makeMachine({ controller: 'grbl', travel: { x: 100, y: 100, z: 100 }, controllerDefinition: definition })
    const offsets = { byWcs: { G54: { x: 0, y: 0, z: 0 }, G55: { x: 0, y: 50, z: 0 } } }
    const startY = centreY === 30 ? 30 : 10
    const prefix = `G21 G90\nG54 G0 X10 Y${startY} Z10\n`
    const absolute = transferCheckJobFromProgram(`${prefix}G55 G90.1 G3 X20 Y-${centreY} I10 J-${centreY} F100\nM30`)
    expect(absolute.moves.filter((move) => move.kind === 'arc').length).toBeGreaterThan(8)
    const incremental = transferCheckJobFromProgram(`${prefix}G55 G3 X20 Y-${centreY} I0 J-10 F100\nM30`)
    const result = checkJobAgainstMachine(absolute, machine, offsets)
    expect(result).toEqual(checkJobAgainstMachine(incremental, machine, offsets))
    if (kind === 'safe') expect(result).toEqual({ refusals: [], warnings: [], notes: [] })
    else expect(result.refusals).toEqual(['G55 Y program range -10..9.81 mm exceeds soft limits 0..100 mm.'])
  })
})
