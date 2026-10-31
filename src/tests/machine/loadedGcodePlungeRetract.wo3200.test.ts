// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { buildProgramPath } from '../../lib/machine/programPath'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { connectMachine, disconnectMachine, loadMachineProgram, armPathFidelityFromMoves, stagedGeometryProgramPath, clearPathFidelity } from '../../lib/machine/machineSession'
import { stagedListingProgramPath } from '../../components/machine/ProgramPreview'
import type { StagedProgramView } from '../../store/machineControlStore'
import { useMachineControl } from '../../store/machineControlStore'

const ownerProgram = readFileSync('src/tests/evidence/WO-3200/owner-fusion.nc', 'utf8')
const roles = (text: string) => buildProgramPath(text).moves.slice(1).map(m => m.role)
afterEach(async () => { clearPathFidelity(); await disconnectMachine() })

describe('WO-3200 loaded G-code display roles', () => {
  it('production loader preserves the owner file and exposes 45 plunges and 22 retracts', async () => {
    await connectMachine('simulator')
    loadMachineProgram('owner-fusion.nc', ownerProgram)
    const text = useMachineControl.getState().programText
    expect(text).toBe(ownerProgram)
    const path = buildProgramPath(text)
    expect(path.moves.filter(m => m.role === 'plunge')).toHaveLength(45)
    expect(path.moves.filter(m => String(m.role) === 'retract')).toHaveLength(22)
  })
  it('keeps real G0 rapid and colours only vertical G1 feeds', () => {
    expect(roles('G21 G90\nG0 X0 Y0 Z5\nG1 Z-2 F1000\nG1 X10\nG1 Z5\nG0 X0\nG0 Z10')).toEqual([
      'rapid', 'plunge', 'cut', 'retract', 'rapid', 'rapid',
    ])
  })
  it('uses resolved metric and incremental endpoints while ramps and arcs stay cut', () => {
    const text = 'G20 G90\nG0 X0 Y0 Z1\nG91 G1 Z-0.1 F10\nG1 Z0.1\nG1 X1 Z-0.1\nG90 G2 X0 Y0 I-0.5 J0'
    const path = buildProgramPath(text)
    expect(path.moves[2].role).toBe('plunge')
    expect(path.moves[3].role).toBe('retract')
    expect(path.moves.slice(4).every(m => m.role === 'cut')).toBe(true)
    expect(path.moves[2].z).toBeCloseTo(22.86)
  })
  it('staged listings and armed geometry use identical roles without mutating steps', () => {
    const view: StagedProgramView = { program: {
      frame: 'work', units: 'mm', index: {}, steps: [
        { id: 1, kind: 'line', rapid: true, to: { x: 0, y: 0, z: 5 }, feedMmMin: 1000 },
        { id: 2, kind: 'line', to: { z: -2 }, feedMmMin: 1000 },
        { id: 3, kind: 'line', to: { z: 5 }, feedMmMin: 1000 },
        { id: 4, kind: 'line', to: { x: 10, z: -2 }, feedMmMin: 1000 },
      ],
    }, setups: [] }
    const before = JSON.stringify(view)
    const listing = stagedListingProgramPath(view, null)
    expect(listing.moves.map(m => m.role)).toEqual(['rapid', 'plunge', 'retract', 'cut'])
    armPathFidelityFromMoves(view.program.steps.filter(s => s.kind === 'line'), 'work', { x: 0, y: 0, z: 0 })
    const armed = stagedGeometryProgramPath()!
    expect(armed.moves).toEqual(listing.moves)
    expect(stagedListingProgramPath(view, armed).moves).toEqual(listing.moves)
    expect(JSON.stringify(view)).toBe(before)
  })
  it('unknown starts and zero-length feed commands stay cut', () => {
    const view: StagedProgramView = { program: {
      frame: 'work', units: 'mm', index: {}, steps: [
        { id: 1, kind: 'line', to: { x: 0, y: 0, z: 5 }, feedMmMin: 1000 },
        { id: 2, kind: 'line', to: { z: 5 }, feedMmMin: 1000 },
      ],
    }, setups: [] }
    expect(stagedListingProgramPath(view, null).moves.map(m => m.role)).toEqual(['cut', 'cut'])
  })
  it('preserves source lines, resolved coordinates, feeds and refusal behaviour', () => {
    const text = 'G21 G90\nG0 X0 Y0 Z5\nG1 Z-2 F1000\nG1 Z5'
    const model = buildPreviewModel(text)
    const path = buildProgramPath(text)
    expect(path.moveLines).toEqual([2, 2, 3, 4])
    expect(path.moves.map(({ x, y, z }) => [x, y, z])).toEqual([[0,0,0],[0,0,5],[0,0,-2],[0,0,5]])
    expect(model.moves.map(m => m.feedMmMin)).toEqual([null,1000,1000])
    expect(buildProgramPath('G28')).toEqual({ moves: [], moveLines: [] })
  })
})

