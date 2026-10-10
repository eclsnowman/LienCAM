import { describe, expect, it } from 'vitest'
import { createDefaultControllerDefinition, type AxisName, type MachineConfig } from '../../types'
import { transferCheckJobFromProgram } from '../../lib/machine/programContext'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { checkJobAgainstMachine } from '../../lib/machine/transferCheck'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.axes = controllerDefinition.axes.map((axis) => ({
    ...axis,
    enabled: axis.axis === 'X' || axis.axis === 'Y' || axis.axis === 'Z',
    softLimitMin: 0,
    softLimitMax: 100,
  }))
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'grbl' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return makeMachine({
    id: 'coverage-machine',
    name: 'Coverage Mill',
    controller: 'grbl',
    controllerDefinition,
    maxSpindleRpm: 24000,
  })
}

function withAxis(
  target: MachineConfig,
  axis: AxisName,
  change: (definition: NonNullable<MachineConfig['controllerDefinition']>['axes'][number]) => void,
): MachineConfig {
  const copy = structuredClone(target)
  const definition = copy.controllerDefinition?.axes.find((candidate) => candidate.axis === axis)
  if (!definition) throw new Error(`fixture has no ${axis} axis`)
  change(definition)
  return copy
}

function check(program: string, target = machine()) {
  return checkJobAgainstMachine(
    transferCheckJobFromProgram(program),
    target,
    { x: 0, y: 0, z: 0 },
  )
}

describe('WO-1150 commanded-axis coverage', () => {
  it('refuses a commanded disabled axis and names its first source line', () => {
    const target = withAxis(machine(), 'X', (axis) => { axis.enabled = false })

    expect(check('G21 G90\nG0 X10\nM30', target).refusals).toEqual([
      'X is commanded on line 2, but Coverage Mill defines X as disabled.',
    ])
  })

  it('refuses a commanded axis omitted from the definition', () => {
    const target = machine()
    target.controllerDefinition!.axes = target.controllerDefinition!.axes.filter((axis) => axis.axis !== 'X')

    expect(check('G21 G90\nG0 X10\nM30', target).refusals).toEqual([
      'X is commanded on line 2, but Coverage Mill has no X axis definition (unsupported/undefined).',
    ])
  })

  it('uses Machine-page travel when the whole controller definition is absent', () => {
    const target = machine()
    target.homeConvention = {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    }
    delete target.controllerDefinition

    expect(check('G21 G90\nG0 X10 Y20\nM30', target)).toEqual({
      refusals: [],
      warnings: [],
      notes: [],
    })
  })

  it('refuses commanded travel when controller and Machine-page envelopes are both unknown', () => {
    const target = machine()
    delete target.controllerDefinition

    expect(check('G21 G90\nG0 X10 Y20\nM30', target)).toEqual({
      refusals: [
        'X is commanded on line 2, but Coverage Mill has no controller definition or resolved X Machine-page travel envelope.',
        'Y is commanded on line 2, but Coverage Mill has no controller definition or resolved Y Machine-page travel envelope.',
      ],
      warnings: [],
      notes: [],
    })
  })

  it.each([
    ['non-finite', Number.NaN, 100],
    ['equal', 10, 10],
    ['reversed', 20, 10],
  ])('refuses a commanded axis with a %s envelope', (_case, min, max) => {
    const target = withAxis(machine(), 'X', (axis) => {
      axis.softLimitMin = min
      axis.softLimitMax = max
    })

    expect(check('G21 G90\nG0 X10\nM30', target).refusals).toEqual([
      'X is commanded on line 2, but Coverage Mill has an invalid X soft-limit envelope; set finite limits with maximum greater than minimum.',
    ])
  })

  it('keeps an unknown WCS offset distinct from an invalid envelope', () => {
    const result = checkJobAgainstMachine(
      transferCheckJobFromProgram('G21 G90\nG0 X10\nM30'),
      machine(),
      {},
    )

    expect(result.refusals).toEqual([])
    expect(result.notes).toEqual([
      'Work zero not set on X - travel on X is unchecked until you set it.',
    ])
  })

  it('does not penalize unused disabled rotary axes in an XYZ program', () => {
    expect(check('G21 G90\nG1 X10 Y20 Z30 F100\nM30')).toEqual({
      refusals: [], warnings: [], notes: [],
    })
  })

  it('retains Z coverage through a G98 canned cycle that returns to its initial plane', () => {
    const prepared = transferCheckJobFromProgram([
      'G21 G90',
      'G98 G81 X5 Y5 Z-5 R2 F100',
      'G80',
      'M30',
    ].join('\n'))

    expect(prepared.addressedAxes.z).toEqual({ firstLine: 2 })
    const cycleZMoves = prepared.moves.filter((move) => move.line === 2 && move.from.z !== move.to.z)
    expect(cycleZMoves.length).toBeGreaterThan(0)
    expect(cycleZMoves.every((move) => move.addressedAxes.includes('z'))).toBe(true)

    const target = withAxis(machine(), 'Z', (axis) => { axis.enabled = false })
    expect(checkJobAgainstMachine(prepared, target, { x: 0, y: 0, z: 0 }).refusals).toContain(
      'Z is commanded on line 2, but Coverage Mill defines Z as disabled.',
    )
  })

  it.each([
    ['G18', 'G2 X0 Z0 I5 K0 F100', ['x', 'z']],
    ['G19', 'G2 Y0 Z0 J5 K0 F100', ['y', 'z']],
  ] as const)('%s arc tessellation retains both geometrically used plane axes', (plane, arc, axes) => {
    const prepared = transferCheckJobFromProgram(`G21 G90\n${plane}\n${arc}\nM30`)
    const arcMoves = prepared.moves.filter((move) => move.line === 3)

    expect(arcMoves.length).toBeGreaterThan(0)
    for (const axis of axes) {
      expect(prepared.addressedAxes[axis]).toEqual({ firstLine: 3 })
      expect(arcMoves.every((move) => move.addressedAxes.includes(axis))).toBe(true)
    }
  })

  it('records an explicitly repeated coordinate even when it has zero geometric delta', () => {
    const prepared = transferCheckJobFromProgram('G21 G90\nG0 X0\nM30')

    expect(prepared.addressedAxes.x).toEqual({ firstLine: 2 })
  })

  it.each([
    ['G10 work-offset parameters', 'G10 L2 P1 X0 Y0 Z0', 'G10'],
    ['G92 coordinate parameters', 'G92 X0 Y0 Z0', 'G92'],
  ])('refuses unmodeled %s without classifying its parameters as commanded axes', (_case, parameterBlock, namedWord) => {
    const program = [
      'G21 G90',
      parameterBlock,
      'G0 Z5',
      'M30',
    ].join('\n')
    const preview = buildPreviewModel(program)
    const prepared = transferCheckJobFromProgram(program)

    expect(preview.refusal).toContain(`Line 2: ${namedWord}`)
    expect(preview.addressedAxes).toEqual({})
    expect(preview.moves).toEqual([])
    expect(preview.machineCoordinateRanges).toEqual({})
    expect(prepared.addressedAxes).toEqual({})
    expect(prepared.moves).toEqual([])
  })

  it('applies identical coverage to context-less and CAM-posted jobs', () => {
    const program = 'G21 G90\nG0 X10\nM30'
    const target = withAxis(machine(), 'X', (axis) => { axis.enabled = false })
    const direct = transferCheckJobFromProgram(program)
    const posted = transferCheckJobFromProgram(program, {
      id: target.id,
      name: target.name,
      controller: target.controller,
    })

    expect(checkJobAgainstMachine(direct, target, { x: 0, y: 0, z: 0 }))
      .toEqual(checkJobAgainstMachine(posted, target, { x: 0, y: 0, z: 0 }))
  })
})
