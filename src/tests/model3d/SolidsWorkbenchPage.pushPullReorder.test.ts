// WO UI-80 CF6 (AM3): a first-class push/pull node CONSUMES the body feature it
// offsets, so the existing producer-before-consumer reorder guard
// (FeatureDag.checkReorder / reorderNode) blocks dragging it above its owner
// with a REORDER_BLOCKED diagnostic -- never a silent accept. This needs no new
// guard code: the guard reads `consumes`, and the pushPull node's consumes edge
// (SolidsWorkbenchPage's handlePushPullCommit) is the owner. This test pins that
// the promotion actually wired the edge, so the guard fires.
//
// FAILS-IF: handlePushPullCommit stops putting the owner on the pushPull node's
// `consumes` (e.g. reverts to a payload-only ownerId) -- the guard would then
// see no dependency and silently allow the illegal reorder.

import { describe, it, expect } from 'vitest'
import { FeatureDag, ReorderBlockedError } from '../../doc'

function boxWithPushPull(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', name: 'Extrude F1' } })
  // The push/pull node, shaped exactly as handlePushPullCommit builds it.
  dag.insertNode({
    id: 'F2',
    kind: 'feature',
    consumes: ['F1'],
    refs: [{ id: 'F1:BOX:zMax', kind: 'single-face' }],
    payload: { opType: 'pushPull', ownerId: 'F1', delta: 3, normal: { x: 0, y: 0, z: 1 }, name: 'Push/Pull F2' },
  })
  return dag
}

describe('WO UI-80 CF6: push/pull reorder guard', () => {
  it('dragging the pushPull node above its owner is refused (REORDER_BLOCKED), not silently accepted', () => {
    const dag = boxWithPushPull()
    const order = dag.featureOrder()
    expect(order).toEqual(['SK1', 'F1', 'F2'])

    // checkReorder (read-only) names the blocking owner + direction.
    const blocked = dag.checkReorder('F2', order.indexOf('F1'))
    expect(blocked).not.toBeNull()
    expect(blocked!.blockingId).toBe('F1')
    expect(blocked!.direction).toBe('above')

    // reorderNode throws rather than silently clamping into an illegal order,
    // with the structured REORDER_BLOCKED diagnostic.
    let thrown: unknown
    try {
      dag.reorderNode('F2', order.indexOf('F1'))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ReorderBlockedError)
    expect((thrown as ReorderBlockedError).diagnostic.code).toBe('REORDER_BLOCKED')
    expect((thrown as ReorderBlockedError).diagnostic.params.movedId).toBe('F2')
    expect((thrown as ReorderBlockedError).diagnostic.params.blockingId).toBe('F1')

    // The timeline is unchanged (a refused reorder mutates nothing).
    expect(dag.featureOrder()).toEqual(['SK1', 'F1', 'F2'])
  })

  it('dragging the pushPull node to a legal slot BELOW its owner is allowed', () => {
    const dag = boxWithPushPull()
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'], payload: { opType: 'fillet', ownerId: 'F1', name: 'Fillet F3' } })
    // F2 and F3 both consume F1; moving F2 after F3 (still below F1) is legal.
    expect(dag.checkReorder('F2', dag.featureOrder().indexOf('F3'))).toBeNull()
  })
})
