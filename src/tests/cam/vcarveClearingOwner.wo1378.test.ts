// WO-1378: a V-Carve's flat_clearing sibling belongs to the carve it clears
// for, by id (params.carveOpId) - not by geometryId+loopIds, which matched a
// duplicated carve's clearing edits to the ORIGINAL carve (BUG-416), and never
// kept the pair in cut order (BUG-415). Store-level per the WO's evidence
// tier, plus a buildPostInput check that the fix reaches the posted program.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { makeMachine, makeOp, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import type { Operation, Project, Setup } from '../../types'

const SETUP_ID = 'setup-wo1378'

function vcarveCarveParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    geometryId: 'geo-1', loopIds: ['loop-1'], role: 'carve',
    startDepthMm: 0, allowanceMm: 0,
    flatClearing: { mode: 'tool', clearingToolDiameter: 6, stepoverMm: 0.5 },
    tolerance: 0.01,
    ...over,
  }
}

function vcarveClearingParams(carveOpId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    geometryId: 'geo-1', loopIds: ['loop-1'], role: 'flat_clearing',
    startDepthMm: 0, allowanceMm: 0,
    flatClearing: { mode: 'tool', clearingToolDiameter: 6, stepoverMm: 0.5 },
    vbit: { angleFromAxisDeg: 45, tipDiameter: 0 },
    tolerance: 0.01,
    carveOpId,
    ...over,
  }
}

function carveOp(id: string, over: Partial<Operation> = {}): Operation {
  return makeOp({
    id, name: id, type: 'vcarve', toolId: 'vbit1',
    params: vcarveCarveParams(),
    ...over,
  })
}

function clearingOp(id: string, carveOpId: string, over: Partial<Operation> = {}): Operation {
  return makeOp({
    id, name: `${id} - flat clearing`, type: 'vcarve', toolId: 'em1',
    params: vcarveClearingParams(carveOpId),
    ...over,
  })
}

function projectWith(ops: Operation[]): { project: Project; setup: Setup } {
  const setup: Setup = {
    id: SETUP_ID, name: 'Setup', wcs: makeWcs(), stock: {} as Setup['stock'],
    operations: ops, notes: '',
  }
  const project = {
    id: 'p-wo1378', name: 'P', version: '1', createdAt: '', updatedAt: '',
    machine: makeMachine(),
    toolLibrary: [makeTool({ id: 'vbit1', toolNumber: 1 }), makeTool({ id: 'em1', toolNumber: 2 })],
    geometry: [], setups: [setup], activeSetupId: setup.id, activeOperationId: null,
    sceneStock: {} as Project['sceneStock'], notes: '',
  } as unknown as Project
  return { project, setup }
}

// Every fixture op is stamped GENERATION-CURRENT so store writers that run
// the freshness reconciler (reorderOperations, updateOperation) leave a
// 'ready' op's status and toolpathMoves alone - otherwise the reconciler
// downgrades it to 'outdated' with no moves, which is a different, unrelated
// mechanism (CAM-12) from the one this WO fixes.
function install(ops: Operation[]): void {
  const { project, setup } = projectWith(ops)
  for (const op of ops) {
    const tool = project.toolLibrary.find((t) => t.id === op.toolId) ?? project.toolLibrary[0]
    stampGenerationCurrent(project, setup, op, tool)
  }
  useCamStore.setState((state) => ({
    project, projectHistory: [], canUndo: false,
    viewer: { ...state.viewer, selectedNestId: null },
  }))
}

function opsNow(): Operation[] {
  return useCamStore.getState().project.setups[0].operations
}

function paramsOf(op: Operation): Record<string, unknown> {
  return op.params as Record<string, unknown>
}

beforeEach(() => {
  install([carveOp('carveA'), clearingOp('clearA', 'carveA')])
})

describe('WO-1378 a V-Carve clearing operation belongs to its own carve', () => {
  it('acceptance 1: duplicating a carve gives the copy its own clearing; editing the copy never touches the original', () => {
    useCamStore.getState().duplicateOperation(SETUP_ID, 'carveA')

    const ops = opsNow()
    const carveB = ops.find((o) => o.id !== 'carveA' && paramsOf(o).role === 'carve')
    expect(carveB).toBeDefined()
    const clearB = ops.find((o) => paramsOf(o).role === 'flat_clearing' && paramsOf(o).carveOpId === carveB!.id)
    expect(clearB).toBeDefined()
    expect(clearB!.id).not.toBe('clearA')

    // Edit B's clearing stepover.
    useCamStore.getState().updateOperation(SETUP_ID, clearB!.id, {
      params: {
        ...paramsOf(clearB!),
        flatClearing: { ...(paramsOf(clearB!).flatClearing as Record<string, unknown>), stepoverMm: 9.9 },
      },
    })

    const clearAAfter = opsNow().find((o) => o.id === 'clearA')!
    expect(clearAAfter).toBeDefined()
    expect((clearAAfter.params as Record<string, unknown>).carveOpId).toBe('carveA')
    expect((paramsOf(clearAAfter).flatClearing as Record<string, unknown>).stepoverMm).toBe(0.5)
  })

  it('acceptance 2: adding separate-tool clearing to an existing carve places it directly before the carve', () => {
    install([makeOp({ id: 'other', toolId: 'em1', type: 'contour_2d' }), carveOp('carve1')])

    const newClearing = stampSmartHeightAuthority(clearingOp('clear1', 'carve1'))
    useCamStore.getState().addOperation(SETUP_ID, newClearing)

    const ids = opsNow().map((o) => o.id)
    const carveIdx = ids.indexOf('carve1')
    const clearIdx = ids.indexOf('clear1')
    expect(clearIdx).toBe(carveIdx - 1)
  })

  it('acceptance 3: reordering the carve above its clearing op keeps the pair clearing-then-carve, including in the posted order', () => {
    install([
      clearingOp('clearA', 'carveA'),
      carveOp('carveA'),
      makeOp({ id: 'other', toolId: 'em1', type: 'contour_2d' }),
    ])
    expect(opsNow().map((o) => o.id)).toEqual(['clearA', 'carveA', 'other'])

    // Drag the carve (index 1) above its clearing op (index 0).
    useCamStore.getState().reorderOperations(SETUP_ID, 1, 0)

    expect(opsNow().map((o) => o.id)).toEqual(['clearA', 'carveA', 'other'])

    const setup = useCamStore.getState().project.setups[0]
    const project = useCamStore.getState().project
    const input = buildPostInput(project, setup)
    expect(input.setup.operations.map((o) => o.op.id)).toEqual(['clearA', 'carveA', 'other'])
  })
})
