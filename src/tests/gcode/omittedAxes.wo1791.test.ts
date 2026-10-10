import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { buildStraightLineProgram } from '../../lib/program/buildMachineProgram'
import type { QueuedMove } from '../../lib/machine/controller'
import type { WCS } from '../../types'

const WCS_AT_ORIGIN: WCS = {
  id: 'wo1791-g54',
  label: 'G54',
  fixtureOffset: 54,
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
}

function stagedLines(text: string, initialPosition = { x: -188.732, y: -397.655, z: 0 }): QueuedMove[] {
  const interpreted = interpretGcodeProgram(text, {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition,
    machineUnits: 'mm',
    workOffsets: {
      G54: { x: 0, y: 0, z: 0 },
      G55: { x: 100, y: 200, z: 10 },
    },
  })
  expect(interpreted.ok).toBe(true)
  if (!interpreted.ok) throw new Error(interpreted.refusal.message)

  const moves = interpreted.program.stages.flatMap((stage) => stage.moves)
  const built = buildStraightLineProgram(moves, WCS_AT_ORIGIN, 5000, {
    opId: 'wo1791',
    setupId: 'file',
  }, undefined, initialPosition)
  expect(built.ok).toBe(true)
  if (!built.ok) throw new Error(built.reason)
  return built.program.steps.filter((step): step is QueuedMove =>
    step.kind === 'line' || step.kind === 'arc' || step.kind === 'dwell' || step.kind === 'marker')
}

function roundedTargets(moves: QueuedMove[]): Array<Partial<{ x: number; y: number; z: number }> | null> {
  return moves.map((move) => {
    if (move.kind !== 'line') return null
    return Object.fromEntries(Object.entries(move.to).map(([axis, value]) => [axis, Number(value!.toFixed(6))]))
  })
}

describe('WO-1791 omitted axes remain modal at execution', () => {
  it('keeps load-time coordinates in preview geometry but omits them from the executable line', () => {
    const initialPosition = { x: -188.732, y: -397.655, z: 0 }
    const interpreted = interpretGcodeProgram('G21 G90 G54\nG0 Z53\nG0 X0\nG0 Y25\nM30\n', {
      dialect: 'uccnc',
      sessionWcs: 'G54',
      initialPosition,
      machineUnits: 'mm',
      workOffsets: { G54: { x: 0, y: 0, z: 0 } },
    })
    expect(interpreted.ok).toBe(true)
    if (!interpreted.ok) throw new Error(interpreted.refusal.message)

    // Preview/backplot geometry remains a complete modal endpoint.
    expect(interpreted.program.stages[0].moves).toEqual([
      { type: 'rapid', role: 'rapid', x: -188.732, y: -397.655, z: 53 },
      { type: 'rapid', role: 'rapid', x: 0, y: -397.655, z: 53 },
      { type: 'rapid', role: 'rapid', x: 0, y: 25, z: 53 },
    ])

    // The wire target distinguishes omission from an explicitly stated zero.
    expect(roundedTargets(stagedLines('G21 G90 G54\nG0 Z53\nG0 X0\nG0 Y25\nM30\n', initialPosition))).toEqual([
      { z: 53 },
      { x: 0, z: 53 },
      { x: 0, y: 25, z: 53 },
    ])
  })

  it('carries only axes established by the program across G90/G91 and inch conversion', () => {
    expect(roundedTargets(stagedLines(
      'G20 G90 G54\nG0 Z1\nG91\nG0 X1\nG0 Y-0.5\nG90\nG0 X0\nM30\n',
      { x: 10, y: 20, z: 30 },
    ))).toEqual([
      { z: 25.4 },
      { x: 35.4, z: 25.4 },
      { x: 35.4, y: 7.3, z: 25.4 },
      { x: 0, y: 7.3, z: 25.4 },
    ])
  })

  it('rebases established modal coordinates through a WCS change without inventing untouched axes', () => {
    expect(roundedTargets(stagedLines(
      'G21 G90 G54\nG0 X40\nG55\nG0 Z5\nM30\n',
      { x: 10, y: 20, z: 30 },
    ))).toEqual([
      { x: 40 },
      { x: -60, z: 5 },
    ])
  })
})
