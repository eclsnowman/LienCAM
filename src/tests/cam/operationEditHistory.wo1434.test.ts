// WO-1434 (BUG-412): updateOperation is the one writer for an operator's edit
// AND for compute publication. It pushed no history for either, so after
// editing a parameter and recomputing, one Undo deleted the whole operation.
//
// These drive the real store actions: addOperation, updateOperation with the
// patch shape the Edit Operation dialog's Save & Recompute writes, then the
// status/toolpath/timing writes a compute publishes through the same writer,
// and the real undo()/redo().

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import type { Operation, Setup, ToolpathMove } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

const SETUP_ID = 'setup-wo1434'
const OP_ID = 'op-wo1434'

const state = () => useCamStore.getState()
const ops = () => state().project.setups.find((st) => st.id === SETUP_ID)?.operations ?? []
const opNow = () => ops().find((op) => op.id === OP_ID)
const tipOffset = () => (opNow()?.params as { tipOffset?: number } | undefined)?.tipOffset
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const MOVES: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 1, y: 1, z: -1, feed: 300, role: 'cut' },
] as ToolpathMove[]

function makeOperation(): Operation {
  return {
    id: OP_ID, name: 'Chamfer edge', type: 'contour_2d', enabled: true,
    status: 'pending', toolId: 'tool-1', geometrySelections: [],
    heights: {} as Operation['heights'],
    passes: {} as Operation['passes'],
    linking: {} as Operation['linking'],
    params: { tipOffset: 1, side: 'outer' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: SETUP_ID }),
  } as unknown as Operation
}

/** The writes a compute publishes: computing, then the finished result. */
function publishCompute(): void {
  state().updateOperation(SETUP_ID, OP_ID, {
    status: 'computing', errorMessage: undefined, progress: 0, progressPhase: undefined,
    estimatedCutTimeMs: undefined,
  })
  state().updateOperation(SETUP_ID, OP_ID, { progress: 0.5, progressPhase: 'Generating' })
  state().updateOperation(SETUP_ID, OP_ID, {
    status: 'ready', toolpathMoves: MOVES, computeTimeMs: 12, estimatedCutTimeMs: 3400,
    progress: undefined, progressPhase: undefined, errorMessage: undefined,
  })
}

/** The patch the Edit Operation dialog's Save & Recompute writes. */
function saveEdit(offset: number): void {
  state().updateOperation(SETUP_ID, OP_ID, {
    name: 'Chamfer edge',
    params: { ...(opNow()!.params), tipOffset: offset },
    status: 'pending', toolpathMoves: undefined, computeTimeMs: undefined, errorMessage: undefined,
  })
}

describe('WO-1434: an operation edit is one undo step; compute publication is none', () => {
  beforeEach(async () => {
    vi.stubGlobal('window', {})
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        activeSetupId: SETUP_ID,
        activeOperationId: null,
        setups: [{ id: SETUP_ID, name: 'Setup 1', operations: [] } as unknown as Setup],
      },
      activeSketch: null,
      projectHistory: [],
      sketchHistory: [],
      projectFuture: [],
      sketchFuture: [],
      toolSlicesHistory: [],
      toolSlicesFuture: [],
      canUndo: false,
      canRedo: false,
    }))
    await nextTurn()
    state().addOperation(SETUP_ID, makeOperation())
    await nextTurn()
    publishCompute()
    await nextTurn()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('Undo after editing a parameter and recomputing restores the prior value, not no operation', async () => {
    const depthBeforeEdit = state().projectHistory.length
    saveEdit(0)
    publishCompute()
    expect(tipOffset()).toBe(0)
    expect(opNow()!.status).toBe('ready')
    // One accepted edit, however many internal writes, is exactly one step.
    expect(state().projectHistory.length).toBe(depthBeforeEdit + 1)
    await nextTurn()

    state().undo()
    expect(opNow()).toBeDefined()
    expect(tipOffset()).toBe(1)
    expect(opNow()!.status).toBe('outdated')
    expect(state().canRedo).toBe(true)

    state().redo()
    expect(opNow()).toBeDefined()
    expect(tipOffset()).toBe(0)
  })

  it('compute publication alone adds no history entry', async () => {
    const depth = state().projectHistory.length
    const canUndo = state().canUndo
    publishCompute()
    await nextTurn()
    publishCompute()
    state().updateOperation(SETUP_ID, OP_ID, { status: 'error', errorMessage: 'refused' })
    expect(state().projectHistory.length).toBe(depth)
    expect(state().canUndo).toBe(canUndo)
  })

  it('enable toggle and rename are each their own undo step', async () => {
    state().updateOperation(SETUP_ID, OP_ID, { enabled: false })
    await nextTurn()
    state().updateOperation(SETUP_ID, OP_ID, { name: 'Renamed' })
    await nextTurn()

    state().undo()
    expect(opNow()!.name).toBe('Chamfer edge')
    expect(opNow()!.enabled).toBe(false)
    state().undo()
    expect(opNow()!.enabled).toBe(true)
    expect(tipOffset()).toBe(1)
  })

  it('a handler that pushes history itself and then edits still makes one step', async () => {
    const depth = state().projectHistory.length
    state().pushHistory()
    saveEdit(0.5)
    state().updateOperation(SETUP_ID, OP_ID, { name: 'Second write, same action' })
    expect(state().projectHistory.length).toBe(depth + 1)
    await nextTurn()

    state().undo()
    expect(tipOffset()).toBe(1)
    expect(opNow()!.name).toBe('Chamfer edge')
  })

  it('an edit made after an undo in the same turn still branches history', () => {
    saveEdit(0.25)
    state().undo()
    expect(tipOffset()).toBe(1)
    saveEdit(0.75)
    expect(state().canRedo).toBe(false)
    state().undo()
    expect(tipOffset()).toBe(1)
  })
})
