// WO-1893: project undo depth.
//
// The undo stacks used to cap at ten snapshots (`slice(-9)` plus the current
// state), which is easy to exhaust while setting up operations. This suite
// pins the raised authority -- PROJECT_UNDO_DEPTH = 50 in src/store/index.ts:
// 30 edits are all reachable (acceptance 1), the stack itself caps at 50, and
// each snapshot strips the operation's recomputable `toolpathMoves` so a deep
// history stays small (the memory measurement lives in
// src/tests/evidence/WO-1893/).

import { beforeEach, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import type { Operation, Setup } from '../../types'

const UNDO_DEPTH = 50

const state = () => useCamStore.getState()
const history = () => state().projectHistory

function resetHistoryState(): void {
  useCamStore.setState(s => ({
    project: { ...s.project, name: 'depth-base', geometry: [], setups: [] },
    projectHistory: [],
    sketchHistory: [],
    projectFuture: [],
    sketchFuture: [],
    toolSlicesHistory: [],
    toolSlicesFuture: [],
    canUndo: false,
    canRedo: false,
  }))
}

/** One "edit": push the current project onto history, then change it. The
 *  store's real edit actions do exactly this (pushHistory -> mutate). */
function edit(label: string): void {
  state().pushHistory()
  useCamStore.setState(s => ({ project: { ...s.project, name: label } }))
}

describe('WO-1893: undo reaches fifty steps back', () => {
  beforeEach(resetHistoryState)

  it('acceptance 1: 30 edits then 30 undos returns to the first state', () => {
    const first = state().project
    for (let i = 0; i < 30; i += 1) edit(`edit-${i}`)
    expect(state().project.name).toBe('edit-29')
    expect(history().length).toBe(30)

    for (let i = 0; i < 30; i += 1) state().undo()

    expect(state().project.name).toBe(first.name)
    expect(history().length).toBe(0)
    expect(state().canUndo).toBe(false)
  })

  it('the history stack caps at 50 snapshots and the 50th-oldest state is reachable', () => {
    for (let i = 0; i < 60; i += 1) edit(`e${i}`)
    expect(history().length).toBe(UNDO_DEPTH)

    for (let i = 0; i < UNDO_DEPTH; i += 1) state().undo()

    // 60 pushes -> the oldest 10 snapshots were dropped, so the deepest
    // reachable state is the one before edit #11 (name 'e9'); a 51st undo
    // must not step further back.
    expect(state().project.name).toBe('e9')
    expect(history().length).toBe(0)
    state().undo()
    expect(state().project.name).toBe('e9')
  })

  it('redo also reaches 30 steps forward again', () => {
    for (let i = 0; i < 30; i += 1) edit(`r${i}`)
    for (let i = 0; i < 30; i += 1) state().undo()
    expect(state().project.name).toBe('depth-base')

    for (let i = 0; i < 30; i += 1) state().redo()
    expect(state().project.name).toBe('r29')
    expect(state().canRedo).toBe(false)
  })

  it('pushHistory strips recomputable toolpathMoves from every snapshot', () => {
    const moves = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: 0, z: 0 }) as never)
    const op = {
      id: 'op-1', name: 'Rough', type: 'contour_2d', enabled: true,
      status: 'ready', toolId: 'tool-1', geometrySelections: [],
      heights: {}, passes: {}, linking: {}, params: {},
      toolpathMoves: moves,
    } as unknown as Operation
    const setup = { id: 'setup-1', name: 'Setup 1', operations: [op] } as unknown as Setup
    useCamStore.setState(s => ({ project: { ...s.project, setups: [setup] } }))

    state().pushHistory()
    const snapshot = history().at(-1)!
    expect(snapshot.setups[0].operations[0].toolpathMoves).toBeUndefined()
    expect(snapshot.setups[0].operations[0].status).toBe('outdated')
  })
})