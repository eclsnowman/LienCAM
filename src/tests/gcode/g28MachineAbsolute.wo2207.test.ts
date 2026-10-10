import { describe, expect, it } from 'vitest'
import { readGcodeProgram, type GcodeReaderMove, type GcodeReaderOptions } from '../../lib/gcode/reader'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { buildStraightLineProgram, machineMoveWireForm } from '../../lib/program/buildMachineProgram'
import type { QueuedMove } from '../../lib/machine/controller'
import type { WCS } from '../../types'

// WO-2207: G28's HOME LEG IS A MACHINE TARGET, as G30's legs are.
//
// The reader used to resolve G28's second leg into a WORK rapid to
// (home - offset) with nothing saying it was a machine point, so the AXBB-E
// bridge turned it with a rotated work offset: at 30 deg on G55 (450, 450, 60)
// it asked for machine X 562.17 Y 831.72 instead of home (738, 724.5)
// (WO-2203, src/tests/evidence/WO-2203/ROUTES.md). LinuxCNC turns the G28
// INTERMEDIATE point with the rotation and never the stored home, so leg one
// stays a work move and leg two carries `machineAbsolute` on exactly the axes
// the block names. Unrotated, the machine target is where the work move landed
// (work + offset), and the reader's enumerable geometry is unchanged.

/** machine PC's home, the definition's G28 target (machineSession `machineHome`). */
const HOME = { x: 738, y: 724.5, z: 128.9 }
/** G55 as the WO-2203 native-kit test sets it. */
const G55 = { x: 450, y: 450, z: 60 }

const OPTIONS: GcodeReaderOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G55',
  initialPosition: { x: 0, y: 0, z: 0 },
  machineHome: HOME,
  workOffsets: { G55 },
}

function moves(text: string): GcodeReaderMove[] {
  const result = readGcodeProgram(text, OPTIONS)
  if (!result.ok) throw new Error(result.refusal.message)
  return result.program.moves
}

function textFrame(): WCS {
  return {
    id: 'gcode-text-work-frame',
    label: 'G55',
    fixtureOffset: 55,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  }
}

/** The staged lines for a file, through the interpreter and the program
 *  builder the geometry route uses. */
type LineStep = Extract<QueuedMove, { kind: 'line' }>

function staged(text: string): LineStep[] {
  const interpreted = interpretGcodeProgram(text, { ...OPTIONS, machineUnits: 'mm' })
  if (!interpreted.ok) throw new Error(interpreted.refusal.message)
  const built = buildStraightLineProgram(interpreted.program.stages[0].moves, textFrame(), 3000, {
    opId: 'gcode-file',
    setupId: 'wo-2207',
  })
  if (!built.ok) throw new Error(built.reason)
  return built.program.steps.filter((step): step is LineStep => step.kind === 'line')
}

/** What the bridge is sent for one staged move (WO-1897), serialised. */
function wireOf(move: QueuedMove): Record<string, unknown> {
  return JSON.parse(JSON.stringify(machineMoveWireForm(move))) as Record<string, unknown>
}

describe('WO-2207 G28 lands on machine home, never a rotated work point', () => {
  it('G28 G91 Z0: one Z-only machine rapid to home Z; work geometry unchanged', () => {
    const [start, home] = moves('G21 G90\nG0 X1 Y2 Z3\nG28 G91 Z0\nM30')
    expect(start.machineAbsolute).toBeUndefined()
    // The work-coordinate bookkeeping value is what main produced.
    expect(home).toMatchObject({ type: 'rapid', role: 'rapid', x: 1, y: 2 })
    expect(home.z).toBeCloseTo(HOME.z - G55.z, 9)
    // The machine target: Z only, exactly home Z.
    expect(home.machineAbsolute).toEqual({ z: 128.9 })
    // Off the enumerable surface, so previews and JSON see what they always did.
    expect(Object.keys(home)).not.toContain('machineAbsolute')
    expect(JSON.parse(JSON.stringify(home))).toEqual({ type: 'rapid', role: 'rapid', x: 1, y: 2, z: home.z })
  })

  it('bare G28: every axis to home in machine coordinates, no intermediate move', () => {
    const all = moves('G21 G90\nG0 X1 Y2 Z3\nG28\nM30')
    expect(all).toHaveLength(4)
    expect(all.slice(1).map((move) => move.machineAbsolute)).toEqual([
      { z: 128.9 }, { x: 738 }, { y: 724.5 },
    ])
    const home = all[3]
    expect(home.x).toBe(288)
    expect(home.y).toBe(274.5)
    expect(home.z).toBeCloseTo(68.9, 9)
  })

  it('G28 X5: the intermediate point is a WORK move; the home leg is machine X only', () => {
    const [, via, home] = moves('G21 G90\nG0 X1 Y2 Z3\nG28 X5\nM30')
    expect(via).toMatchObject({ type: 'rapid', x: 5, y: 2, z: 3 })
    expect(via.machineAbsolute).toBeUndefined()
    expect(home).toMatchObject({ type: 'rapid', x: 288, y: 2, z: 3 })
    expect(home.machineAbsolute).toEqual({ x: 738 })
  })

  it('G28 G91 Z10: the incremental intermediate point stays in the work frame', () => {
    const [, via, home] = moves('G21 G90\nG0 X1 Y2 Z3\nG28 G91 Z10\nM30')
    expect(via).toMatchObject({ type: 'rapid', x: 1, y: 2, z: 13 })
    expect(via.machineAbsolute).toBeUndefined()
    expect(home.machineAbsolute).toEqual({ z: 128.9 })
  })

  it('the wire carries home in machine coordinates, where the old work move landed unrotated', () => {
    const [start, zHome] = staged('G21 G90 G55\nG0 X1 Y2 Z3\nG28 G91 Z0\nM30')
    expect(wireOf(start)).toMatchObject({ to: { x: 1, y: 2, z: 3 } })
    expect(wireOf(start).machineAbsolute).toBeUndefined()
    expect(wireOf(zHome)).toEqual({
      id: 2, kind: 'line', to: { z: 128.9 }, feedMmMin: 3000, rapid: true, machineAbsolute: true,
    })
    // Unrotated, the bridge used to land the work move at work + offset: home.
    expect(zHome.to.z! + G55.z).toBeCloseTo(HOME.z, 9)

    const [, z, x, all] = staged('G21 G90 G55\nG0 X1 Y2 Z3\nG28\nM30')
    expect([z, x, all].map(wireOf)).toEqual([
      { id: 2, kind: 'line', to: { z: 128.9 }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
      { id: 3, kind: 'line', to: { x: 738 }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
      { id: 4, kind: 'line', to: { y: 724.5 }, feedMmMin: 3000, rapid: true, machineAbsolute: true },
    ])
    expect(all.to.x! + G55.x).toBe(HOME.x)
    expect(all.to.y! + G55.y).toBe(HOME.y)
    expect(all.to.z! + G55.z).toBeCloseTo(HOME.z, 9)
  })
})
