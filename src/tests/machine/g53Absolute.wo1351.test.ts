import { describe, expect, it } from 'vitest'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import {
  buildStraightLineProgram,
  firstStepOutsideTravel,
  machineMoveWireForm,
} from '../../lib/program/buildMachineProgram'
import type { QueuedMove } from '../../lib/machine/controller'
import type { WCS } from '../../types'

const TRACE = { opId: 'gcode-file', setupId: 'wo-1351' }

/** What the bridge is sent for one staged move: the controller's wire form of
 *  it (WO-1897 - made at the wire in `sendStagedLoad`, not carried on the step
 *  as a `toJSON`), serialised. */
function wireOf(move: QueuedMove): Record<string, unknown> {
  return JSON.parse(JSON.stringify(machineMoveWireForm(move))) as Record<string, unknown>
}

function textFrame(): WCS {
  return {
    id: 'gcode-text-work-frame',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  }
}

function lineSteps(zOffset = 66.57): QueuedMove[] {
  const interpreted = interpretGcodeProgram('G21 G90 G54\nG53 G0 Z128.\nG1 X20 Y30 Z40 F600\nM30', {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition: { x: 738, y: 724.5, z: 0 },
    machineUnits: 'mm',
    workOffsets: { G54: { x: 738, y: 724.5, z: zOffset } },
  })
  if (!interpreted.ok) throw new Error(interpreted.refusal.message)
  const built = buildStraightLineProgram(interpreted.program.stages[0].moves, textFrame(), 3000, TRACE)
  if (!built.ok) throw new Error(built.reason)
  return built.program.steps.filter((step): step is QueuedMove => step.kind === 'line')
}

describe('WO-1351 G53 stays machine-absolute and preserves addressed axes', () => {
  it('stages Fusion preamble G53 G0 Z128 as a machine-absolute Z-only line', () => {
    const [park] = lineSteps()
    const wire = wireOf(park)
    expect(wire).toEqual({
      id: 1,
      kind: 'line',
      to: { z: 128 },
      feedMmMin: 3000,
      rapid: true,
      machineAbsolute: true,
    })
  })

  it('does not bake the work Z offset in force at load into the G53 wire target', () => {
    const wireTarget = (zOffset: number) => wireOf(lineSteps(zOffset)[0]).to
    expect(wireTarget(66.57)).toEqual({ z: 128 })
    expect(wireTarget(110)).toEqual({ z: 128 })
  })

  it('does not judge held X and Y at their soft maxima for a Z-only move', () => {
    const [park] = lineSteps()
    const program = { frame: 'work' as const, units: 'mm' as const, steps: [park], index: {} }
    expect(firstStepOutsideTravel(program, { x: 738, y: 724.5, z: 110 }, {
      x: { travelMm: 738, homesToward: 'max', homePositionMm: 738, pulloffMm: 0, min: 0, max: 738 },
      y: { travelMm: 724.5, homesToward: 'max', homePositionMm: 724.5, pulloffMm: 0, min: 0, max: 724.5 },
      z: { travelMm: 171.4, homesToward: 'max', homePositionMm: 171.4, pulloffMm: 0, min: 0, max: 171.4 },
    })).toBeNull()
  })

  it('keeps every named axis on an ordinary three-axis G1', () => {
    const [, cut] = lineSteps()
    expect(cut).toMatchObject({
      kind: 'line',
      to: { x: 20, y: 30, z: 40 },
      feedMmMin: 600,
    })
    expect(cut).not.toHaveProperty('machineAbsolute')
  })
})
