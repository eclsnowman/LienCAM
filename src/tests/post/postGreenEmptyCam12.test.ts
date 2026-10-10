// CAM-12 - a GREEN-EMPTY operation must be UNPOSTABLE, not silently emit a
// cut-free program.
//
// The defect (verified in coordination/preflights/CAM-12.preflight.md sec 7):
// buildPostInput builds its PostOperation[] from collectToolpathSections, which
// SILENTLY DROPS a moveless op (src/lib/cam/nesting/nestRuntime.ts). So a
// 'ready' (green) op with no computed toolpath - the exact stale-green state a
// browser refresh produces - never became a PostOperation, and validateOpsReady's
// OP_NO_TOOLPATH guard (src/lib/post/validate.ts) was DEAD CODE for this defect.
// Posting a stale-green setup therefore emitted a header/footer program with NO
// cutting moves, behind a green scope - a cut-free program, silently.
//
// CAM-12's load-boundary census now makes a stale-green op unrepresentable after
// any load, but this guard must ALSO exist at the post boundary so a green-empty
// op that arises any other way (an in-session regression, a future edit) still
// refuses loud. This test guards that invariant directly.
//
// Can-fail: revert the CAM-12 block in buildPostInput.ts and the stale-green op
// is dropped -> `po` is undefined (first expect fails) and postProgram returns a
// cut-free program with ok:true (the end-to-end expects fail).

import { describe, it, expect } from 'vitest'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { postProgram } from '../../lib/post/index'
import { validateOpsReady } from '../../lib/post/validate'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { makeTool, makeMachine, makeOp, makeWcs, move, stampGenerationCurrent } from './helpers'
import type { PhysicalStock, Project, Setup, Tool } from '../../types'

function makeProject(tools: Tool[], setup: Setup, stocks?: PhysicalStock[]): Project {
  return {
    id: 'p1', name: 'P', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(),
    toolLibrary: tools,
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    stocks,
    notes: '',
  }
}

function makeSetup(ops: Setup['operations']): Setup {
  return {
    id: 's1', name: 'Setup 1', wcs: makeWcs(),
    stock: {} as Setup['stock'], operations: ops, notes: '',
  }
}

describe('CAM-12 post boundary: green-empty op is unpostable', () => {
  it('surfaces a stale-green op (ready + no moves) so posting refuses as outdated', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const staleGreen = makeOp({ id: 'stale', name: '3D Rough 2', toolId: 't1', status: 'ready', toolpathMoves: [] })
    const setup = makeSetup([staleGreen])
    const input = buildPostInput(makeProject([t1], setup), setup)

    // The moveless green op must be PRESENT (with empty moves), not dropped.
    const po = input.setup.operations.find((o) => o.op.id === 'stale')
    expect(po).toBeDefined()
    expect(po!.moves).toHaveLength(0)

    // CAM-15's stronger fingerprint guard refuses before the empty-path guard.
    const diags = validateOpsReady(input.setup.operations)
    expect(diags.some((d) => d.code === 'OP_NO_TOOLPATH')).toBe(false)

    // End to end: the run refuses loud and emits NO program (not a cut-free one).
    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(false)
    expect(result.gcode).toBe('')
    expect(result.diagnostics.some((d) => d.code === 'OP_OUTDATED')).toBe(true)
  })

  it('does NOT false-flag a normal computed op (guard is scoped to the defect)', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const goodOp = makeOp({
      id: 'good', toolId: 't1', status: 'ready',
      toolpathMoves: [move({ type: 'rapid', z: 10 }), move({ type: 'feed', x: 5 })],
    })
    const setup = makeSetup([goodOp])
    const project = makeProject([t1], setup)
    // Commit 2e5678b7 (Smart Height V2 cutover): a generation-current op also
    // needs a valid smart_v2 envelope + resolved plan, or buildPostInput's
    // freshness gate refuses it same as a stale one. stampGenerationCurrent
    // (helpers.ts) stamps the V1 snapshot, the V2 envelope/plan, and the
    // fingerprint together - use it instead of hand-rolling the V1-only half.
    stampGenerationCurrent(project, setup, goodOp, t1)
    const input = buildPostInput(project, setup)

    // Exactly one PostOperation, from the section (no spurious empty-moves clone).
    expect(input.setup.operations).toHaveLength(1)
    expect(input.setup.operations[0].moves.length).toBeGreaterThan(0)
    expect(validateOpsReady(input.setup.operations).some((d) => d.code === 'OP_NO_TOOLPATH')).toBe(false)

    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(true)
    expect(result.gcode.length).toBeGreaterThan(0)
  })

  it('a moveless non-ready op is surfaced and refused by its own diagnostic (no cut-free program)', () => {
    // The census downgrades a stale-green op to 'outdated' with no moves. Such an
    // op must ALSO refuse posting rather than be silently dropped (which would
    // emit a cut-free / partial program). It surfaces as an empty-moves
    // PostOperation and validateOpsCurrent refuses it with OP_OUTDATED (NOT a
    // duplicate OP_NO_TOOLPATH, which is ready-only).
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const outdated = makeOp({ id: 'od', toolId: 't1', status: 'outdated', toolpathMoves: [] })
    const setup = makeSetup([outdated])
    const input = buildPostInput(makeProject([t1], setup), setup)
    const po = input.setup.operations.find((o) => o.op.id === 'od')
    expect(po).toBeDefined()
    expect(po!.moves).toHaveLength(0)
    expect(validateOpsReady(input.setup.operations).some((d) => d.code === 'OP_NO_TOOLPATH')).toBe(false)
    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(false)
    expect(result.gcode).toBe('')
    expect(result.diagnostics.some((d) => d.code === 'OP_OUTDATED' && d.opId === 'od')).toBe(true)
  })

  it('an errored op with persisted legacy moves is not posted or silently dropped', () => {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    const errored = makeOp({
      id: 'err', toolId: 't1', status: 'error', errorMessage: 'Flute length is too short.',
      toolpathMoves: [move({ type: 'feed', x: 618, z: -20 })],
    })
    const setup = makeSetup([errored])
    const input = buildPostInput(makeProject([t1], setup), setup)
    const po = input.setup.operations.find((o) => o.op.id === 'err')

    expect(po).toBeDefined()
    expect(po!.moves).toEqual([])
    const result = postProgram(input, UCCNC_CONFIG)
    expect(result.ok).toBe(false)
    expect(result.gcode).toBe('')
    expect(result.diagnostics.some((d) => d.code === 'OP_ERROR' && d.opId === 'err')).toBe(true)
  })
})
