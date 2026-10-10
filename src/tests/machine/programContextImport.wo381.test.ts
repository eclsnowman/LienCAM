// WO-381: the import side - a LienCAM-exported file comes back through the
// raw-file path and binds the SAME immutable context shape a direct load does,
// through the same authoritative boundary (freezeProgramContext), and compares
// against the live project exactly as a direct load would.

import { describe, it, expect } from 'vitest'
import {
  buildProgramContext,
  compareProgramContext,
  computeMotionDigest,
  freezeProgramContext,
  mintVerifiedExportContext,
  type ProgramContextV1,
} from '../../lib/machine/programContext'
import {
  postProject,
  GRBL_CONFIG,
  LINUXCNC_CONFIG,
  UCCNC_CONFIG,
  importProgramContextFromGcode,
  type PostConfig,
} from '../../lib/post'
import { useMachineControl } from '../../store/machineControlStore'
import { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } from '../post/helpers'
import type { Operation, Project, Setup, Stock } from '../../types'

function makeStock(): Stock {
  return { type: 'rectangular', width: 100, depth: 100, height: 20, origin: { x: 0, y: 0, z: 0 }, material: 'aluminum' } as unknown as Stock
}
function twoMoveOp(id: string, name: string, toolId = 't1'): Operation {
  return makeOp({
    id, name, toolId,
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 30, y: 20, z: 5, feed: 2000, role: 'cut' }),
    ],
  })
}
function makeProject(): Project {
  const setup: Setup = {
    id: 's1', name: 'Setup One',
    wcs: makeWcs({ id: 'wcs-s1', label: 'G54', fixtureOffset: 54 }),
    stock: makeStock(),
    operations: [twoMoveOp('opA', 'Face'), twoMoveOp('opB', 'Pocket', 't2')],
    notes: 'Clamp on the left.',
  }
  const project: Project = {
    id: 'p-import', name: 'Import Part', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })],
    geometry: [], setups: [setup], activeSetupId: 's1', activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  }
  for (const op of setup.operations) stampGenerationCurrent(project, setup, op, project.toolLibrary.find((t) => t.id === op.toolId)!)
  return project
}

const OPTS = { mode: 'combined' as const, pauseBetweenSetups: false, baseName: 'part', ext: 'nc' }

function exportBoth(project: Project, config: PostConfig) {
  const plain = postProject(project, project.setups, config, OPTS).combined!
  const exported = postProject(project, project.setups, config, { ...OPTS, programContext: true }).combined!
  const direct = buildProgramContext(project, project.setups[0], config, plain.gcode, plain.operationSpans!)
  const imported = importProgramContextFromGcode(exported.gcode)
  return { plain, exported, direct, imported }
}

describe('WO-381: import creates the same immutable context shape as a direct load', () => {
  it('the imported context is frozen, verified-export, and equal to the direct context field for field (minus source/generatedAt)', () => {
    for (const config of [GRBL_CONFIG, UCCNC_CONFIG, LINUXCNC_CONFIG]) {
      const { direct, imported } = exportBoth(makeProject(), config)
      expect(imported.warning).toBeNull()
      const ctx = imported.context!
      expect(ctx.source).toBe('verified-export')
      expect(Object.isFrozen(ctx)).toBe(true)
      expect(Object.isFrozen(ctx.stock)).toBe(true)
      expect(Object.isFrozen(ctx.operations[0].tool)).toBe(true)
      const { source: _s, generatedAt: _g, ...importedRest } = ctx
      const { source: _s2, generatedAt: _g2, ...directRest } = direct
      expect(importedRest).toEqual(directRest)
    }
  })

  it('the boundary accepts a minted verified-export context and still refuses a hand-labelled one', () => {
    const { direct, imported } = exportBoth(makeProject(), GRBL_CONFIG)
    const frozen = freezeProgramContext(imported.context)
    expect(frozen?.source).toBe('verified-export')
    // Re-freezing the stored copy (a re-validation of the same snapshot) still passes.
    expect(freezeProgramContext(frozen)?.source).toBe('verified-export')
    // A caller who simply writes the label is refused - provenance is not self-asserted.
    expect(() => freezeProgramContext({ ...direct, source: 'verified-export' })).toThrow()
    expect(() => freezeProgramContext({ ...imported.context!, source: 'foreign' } as ProgramContextV1)).toThrow()
    // Nor can the mint be used to launder a context onto a program it does not describe.
    expect(() => mintVerifiedExportContext({ ...direct, source: 'verified-export' }, 'G0 X1\nM30\n')).toThrow(/motion digest does not match/)
    expect(() => mintVerifiedExportContext(direct, 'x')).toThrow(/source must be verified-export/)
  })

  it('binds through the real store boundary exactly like a direct load, and cannot be mutated afterwards', () => {
    const { exported, imported } = exportBoth(makeProject(), GRBL_CONFIG)
    useMachineControl.getState().setProgram('part.nc', exported.gcode, [], imported.context)
    const stored = useMachineControl.getState().programContext!
    expect(stored.source).toBe('verified-export')
    expect(stored.setup.name).toBe('Setup One')
    expect(Object.isFrozen(stored)).toBe(true)
    expect(() => { (stored as { notes: string }).notes = 'x' }).toThrow()
    expect(useMachineControl.getState().programText).toBe(exported.gcode)
    // A program with a tampered motion line is refused at the same boundary.
    expect(() => useMachineControl.getState().setProgram('bad.nc', exported.gcode.replace('X30', 'X31'), [], imported.context)).toThrow()
    useMachineControl.getState().setProgram('', '', [], null)
  })
})

describe('WO-381: direct-load vs export->import comparison equivalence', () => {
  it("'current' both ways on the unchanged project; 'project-changed' both ways after an intent edit", () => {
    const project = makeProject()
    const { plain, exported, direct, imported } = exportBoth(project, GRBL_CONFIG)
    const ctx = imported.context!
    expect(compareProgramContext(direct, project, plain.gcode, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContext(ctx, project, exported.gcode, GRBL_CONFIG)).toBe('current')
    // The imported context also reads 'current' against the block-free text and
    // vice versa: the block is not motion.
    expect(compareProgramContext(ctx, project, plain.gcode, GRBL_CONFIG)).toBe('current')
    expect(compareProgramContext(direct, project, exported.gcode, GRBL_CONFIG)).toBe('current')
    expect(computeMotionDigest(plain.gcode)).toBe(computeMotionDigest(exported.gcode))

    const edited: Project = { ...project, setups: [{ ...project.setups[0], notes: 'Clamp on the RIGHT.' }] }
    expect(compareProgramContext(direct, edited, plain.gcode, GRBL_CONFIG)).toBe('project-changed')
    expect(compareProgramContext(ctx, edited, exported.gcode, GRBL_CONFIG)).toBe('project-changed')

    const other: Project = { ...project, id: 'someone-else' }
    expect(compareProgramContext(ctx, other, exported.gcode, GRBL_CONFIG)).toBe('project-changed')
    expect(compareProgramContext(ctx, project, exported.gcode.replace('X30', 'X31'), GRBL_CONFIG)).toBe('program-changed')
    expect(compareProgramContext(ctx, project, exported.gcode, UCCNC_CONFIG)).toBe('project-changed')
  })

  it('a foreign file (no block) and a refused block both load as no-context', () => {
    const project = makeProject()
    const { exported } = exportBoth(project, GRBL_CONFIG)
    const foreign = importProgramContextFromGcode('G21 G90\nG0 X0\nM30\n')
    expect(foreign).toEqual({ context: null, warning: null })
    expect(compareProgramContext(foreign.context, project, 'G21 G90\nG0 X0\nM30\n', GRBL_CONFIG)).toBe('no-context')
    const truncated = importProgramContextFromGcode(exported.gcode.slice(0, exported.gcode.length - 20))
    expect(truncated.context).toBeNull()
    expect(truncated.warning).toMatch(/Ignoring the LienCAM setup information/)
    expect(compareProgramContext(truncated.context, project, exported.gcode, GRBL_CONFIG)).toBe('no-context')
  })
})
