// SKC-BLOCKS Stage 4 (WORKBENCH PARITY): begin/finish/cancel a block edit-in-place session round-
// trips through sketchSessionStore + workbenchSketchDocumentPort/workbenchOverlaysPort, mirroring
// src/tests/sketch/blockStore.test.ts's CAM-side proof of the SAME feature -- adapted to this host's
// synchronous single write path (commitSketch/openStepNow -> CommandHistory) instead of CAM's
// zustand slice + solver-worker round trip. Drives the ports directly (like blockStore.test.ts
// drives useCamStore directly) rather than a full Sketcher/canvas mount -- the pointer/keyboard
// wiring into `doc.beginBlockEdit`/`getBlockEditId` is already proven generically by the shared
// package (sketchInteraction.ts) and workbenchSketchMount.test.tsx's port-surface tests; this file's
// job is the workbench-specific begin/finish/cancel SEMANTICS: same block id, ghost-set correctness,
// undo/redo lockstep.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Sketch, SketchBlockEntity } from '../../lib/sketch/types'
import { CommandHistory, FeatureDag, RegenScheduler, ElementMap } from '../../doc'
import { BASE_PLANE_FRAMES, seedGenesisNodes } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  workbenchSketchDocumentPort, __resetSketchDocumentPort, syncSketchSessionFromDag,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { workbenchOverlaysPort } from '../../components/model3d/workbench/workbenchOverlaysPort'
import {
  WORKBENCH_ORIGIN_ENTITY_ID, WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID,
  isInjectedSketchAnchorId,
} from '../../components/model3d/workbench/workbenchOriginAnchor'

const SKETCH_NODE_ID = 'sketch3d:s1'

// Two lines joined at a corner by one coincident constraint (wholly internal) -- the exact fixture
// blockStore.test.ts uses, so the two hosts' proofs are directly comparable.
function twoLineSketch(): Sketch {
  return {
    id: 's1', layerId: 'workbench',
    entities: [
      { id: 'l1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'l2', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 8 } },
    ],
    constraints: [
      { id: 'c12', kind: 'coincident', a: { entityId: 'l1', site: 'end' }, b: { entityId: 'l2', site: 'start' } },
    ],
    dimensions: [],
    solveStatus: null,
  }
}

interface Harness {
  dag: FeatureDag
  history: CommandHistory
  notices: Array<{ message: string; severity: string }>
}

/** The session's own write path, bound WITHOUT a solver wrapper (wrapper: null) -- these fixtures'
 *  constraint networks are simple enough that the unsolved path (geometry placed, not yet solved)
 *  is exactly what block group/edit/explode need to prove: none of it depends on the gcs wasm
 *  solver, only on the pure blocks.ts transforms + the write path around them. */
function harness(initialSketch: Sketch = twoLineSketch()): Harness {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())
  dag.insertNode({
    id: SKETCH_NODE_ID, kind: 'sketch', consumes: [], refs: [],
    payload: { sketch: initialSketch, externalRefs: [], dimensionDiagnostics: [] },
  }, dag.featureOrder().length)

  const notices: Array<{ message: string; severity: string }> = []
  sketchSessionStore.bindDeps({
    dag, history, scheduler,
    wrapper: null,
    notice: (message, severity) => { notices.push({ message, severity }) },
    onDocumentChanged: () => {},
    onHistoryStep: () => {},
  })
  sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, initialSketch)
  return { dag, history, notices }
}

function groupTwoLinesIntoBlock(): string {
  sketchSessionStore.setState({ selectedIds: ['l1', 'l2'] })
  workbenchOverlaysPort.groupSelectionIntoBlock()
  const block = sketchSessionStore.getState().sketch!.entities
    .find((e): e is SketchBlockEntity => e.kind === 'block')
  expect(block).toBeTruthy()
  return block!.id
}

beforeEach(() => {
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

afterEach(() => {
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

describe('workbench block edit-in-place (SKC-BLOCKS Stage 4)', () => {
  it('begin -> finish (no edit) round-trips: same block id, members restored, session cleared', () => {
    harness()
    const blockId = groupTwoLinesIntoBlock()

    workbenchOverlaysPort.beginBlockEdit?.(blockId)
    let s = sketchSessionStore.getState()
    expect(s.blockEditId).toBe(blockId)
    // Only the origin/axis anchors (injected by begin()) are NOT part of the block -- l1/l2 are the
    // detached members.
    expect([...(s.blockEditOuterIds ?? [])].sort()).toEqual(
      [WORKBENCH_ORIGIN_ENTITY_ID, WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID].sort(),
    )
    expect(s.sketch!.entities.some((e) => e.kind === 'block')).toBe(false)
    expect(s.sketch!.entities.filter((e) => !isInjectedSketchAnchorId(e.id)).map((e) => e.id).sort()).toEqual(['l1', 'l2'])
    expect(s.selectedIds.sort()).toEqual(['l1', 'l2'])

    // The ghost set excludes the anchors (they are the shared session backdrop, not "the rest of
    // the sketch") -- with nothing else outside the block, it is empty.
    expect(sketchSessionStore.getViewState().blockEditGhostIds).toEqual(new Set())

    workbenchOverlaysPort.finishBlockEdit?.()
    s = sketchSessionStore.getState()
    expect(s.blockEditId).toBeNull()
    expect(s.blockEditOuterIds).toBeNull()
    expect(sketchSessionStore.getViewState().blockEditGhostIds).toBeUndefined()
    const refrozen = s.sketch!.entities.find((e) => e.kind === 'block') as SketchBlockEntity
    expect(refrozen).toBeTruthy()
    expect(refrozen.id).toBe(blockId) // SAME id -- no identity loss
    expect(s.selectedIds).toEqual([blockId])
  })

  it('begin -> edit a member -> finish preserves the block id and folds the edit in', () => {
    harness()
    const blockId = groupTwoLinesIntoBlock()

    workbenchOverlaysPort.beginBlockEdit?.(blockId)
    // Simulate an in-session edit: move l1's end point directly on the session mirror (the package
    // would normally do this through a tool commit; the write path itself is exercised elsewhere).
    const edited = sketchSessionStore.getState().sketch!
    sketchSessionStore.setState({
      sketch: {
        ...edited,
        entities: edited.entities.map((e) =>
          e.id === 'l1' && e.kind === 'line' ? { ...e, end: { x: 20, y: 0 } } : e),
      },
    })
    workbenchOverlaysPort.finishBlockEdit?.()

    const s = sketchSessionStore.getState()
    expect(s.blockEditId).toBeNull()
    const block = s.sketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block.kind).toBe('block')
    expect(block.members.entities.find((e) => e.id === 'l1')).toBeTruthy()
    // The internal coincident constraint survives the round trip.
    expect(block.members.constraints.map((c) => c.id)).toEqual(['c12'])
  })

  it('cancelBlockEdit restores the pre-edit block verbatim as ONE forward undo step', () => {
    const h = harness()
    const blockId = groupTwoLinesIntoBlock()

    workbenchOverlaysPort.beginBlockEdit?.(blockId)
    expect(sketchSessionStore.getState().sketch!.entities.some((e) => e.kind === 'block')).toBe(false)

    workbenchOverlaysPort.cancelBlockEdit?.()
    let s = sketchSessionStore.getState()
    expect(s.blockEditId).toBeNull()
    expect(s.blockEditOuterIds).toBeNull()
    const block = s.sketch!.entities.find((e) => e.id === blockId) as SketchBlockEntity
    expect(block).toBeTruthy()
    expect(block.kind).toBe('block')
    expect(s.selectedIds).toEqual([blockId])

    // Cancel pushed history FORWARD (not popped): Undo steps back INTO the detached-member state,
    // not past the original group.
    h.history.undo()
    syncSketchSessionFromDag()
    s = sketchSessionStore.getState()
    expect(s.sketch!.entities.some((e) => e.kind === 'block')).toBe(false)
  })

  it('no-ops cleanly (no throw) with no sketch, a non-block id, or no open session', () => {
    // No deps bound / no sketch yet.
    expect(() => workbenchOverlaysPort.beginBlockEdit?.('nope')).not.toThrow()
    expect(sketchSessionStore.getState().blockEditId).toBeNull()

    harness()
    workbenchOverlaysPort.beginBlockEdit?.('l1') // not a block: refused by name
    expect(sketchSessionStore.getState().blockEditId).toBeNull()
    expect(() => workbenchOverlaysPort.finishBlockEdit?.()).not.toThrow() // no session open
    expect(() => workbenchOverlaysPort.cancelBlockEdit?.()).not.toThrow() // no session open
    expect(
      sketchSessionStore.getState().sketch!.entities.filter((e) => !isInjectedSketchAnchorId(e.id)).map((e) => e.id).sort(),
    ).toEqual(['l1', 'l2'])
  })

  it('workbenchOverlaysPort.getBlockEditId / useBlockEditId agree with the document port', () => {
    harness()
    const blockId = groupTwoLinesIntoBlock()
    expect(workbenchOverlaysPort.getBlockEditId?.()).toBeNull()
    expect(workbenchSketchDocumentPort.getBlockEditId?.()).toBeNull()

    workbenchOverlaysPort.beginBlockEdit?.(blockId)
    expect(workbenchOverlaysPort.getBlockEditId?.()).toBe(blockId)
    expect(workbenchSketchDocumentPort.getBlockEditId?.()).toBe(blockId)
  })
})
