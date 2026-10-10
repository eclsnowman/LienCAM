// WO SKC-15, acceptance criterion 1: Origin + XY/XZ/YZ are first-class tree items that
// suppress/delete/reorder/rollback each REFUSE BY NAME.
//
// The WO's wording is load-bearing: "suppress/delete/reorder/rollback paths must each refuse or
// ignore these items BY NAME, not by accident." So each test below asserts the refusal came from
// the genesis guard (GenesisNodeError, or ReorderBlocked.reason === 'genesis'), never merely that
// "something threw" -- a dependency-cycle throw or a missing-node throw would pass a weaker test
// while leaving Origin deletable through a different path.
//
// These are the LAST consumers: every UI path (the tree's Delete key, its context menu, the row
// suppress button, drag-reorder, the marker row) funnels into the FeatureDag mutations exercised
// here, so a guard here holds even for a caller that forgot to check. The UI gates additionally,
// to explain rather than throw -- that is asserted in the tree test, not this one.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
  CommandHistory,
  CompositeCommand,
  FeatureDag,
  GENESIS_NODE_IDS,
  GenesisNodeError,
  ORIGIN_NODE_ID,
  RemoveNodeCommand,
  ReorderNodeCommand,
  SetRollbackMarkerCommand,
  SetSuppressedCommand,
  isGenesisNodeId,
  markerInsertIndex,
} from '../../doc'
import { seedGenesisNodes, seedGenesisNodesOutsideHistory, BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'

const FEATURE_A = 'F1'
const FEATURE_B = 'F2'

function makeDag(): FeatureDag {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  return dag
}

/** A sketch on the XY base plane, exactly the DAG shape SKC-5 established for a face plane:
 *  the sketch CONSUMES its datum. This is the edge that makes base planes real nodes. */
function addSketchOnXY(dag: FeatureDag, id = FEATURE_A): void {
  dag.insertNode({ id, kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [], payload: { planeNodeId: BASE_PLANE_XY_NODE_ID } })
}

describe('WO SKC-15: genesis nodes are seeded, pinned and permanent', () => {
  let dag: FeatureDag

  beforeEach(() => {
    dag = makeDag()
  })

  it('seeds Origin + XY/XZ/YZ at featureOrder() indices 0..3, in declaration order', () => {
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS])
    expect(GENESIS_NODE_IDS[0]).toBe(ORIGIN_NODE_ID)
  })

  it('is idempotent: a second seed neither duplicates nor reorders', () => {
    seedGenesisNodes(dag)
    seedGenesisNodes(dag)
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS])
    expect(dag.nodeIds().filter(isGenesisNodeId)).toHaveLength(GENESIS_NODE_IDS.length)
  })

  it('base planes carry a resolvable frame; Origin carries none', () => {
    const xy = dag.getNode(BASE_PLANE_XY_NODE_ID)!
    expect(xy.kind).toBe('datum')
    expect(xy.payload.lastGoodFrame).toEqual(BASE_PLANE_FRAMES.xy)
    expect(dag.getNode(ORIGIN_NODE_ID)!.payload.datumType).toBe('origin')
  })

  it('seeding never touches CommandHistory (Ctrl+Z at genesis must not delete the Origin)', () => {
    const fresh = new FeatureDag()
    const history = new CommandHistory(fresh)
    expect(() => seedGenesisNodesOutsideHistory(fresh, history)).not.toThrow()
    expect(history.canUndo()).toBe(false)
  })

  it('features insert BELOW the genesis run, even when asked for index 0', () => {
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} }, 0)
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
  })
})

describe('WO SKC-15: DELETE refuses genesis nodes by name', () => {
  let dag: FeatureDag

  beforeEach(() => {
    dag = makeDag()
  })

  it.each(GENESIS_NODE_IDS)('dag.removeNode(%s) throws GenesisNodeError naming the node', (id) => {
    expect(() => dag.removeNode(id)).toThrow(GenesisNodeError)
    try {
      dag.removeNode(id)
    } catch (err) {
      expect((err as GenesisNodeError).nodeId).toBe(id)
      expect((err as Error).message).toContain('genesis node')
    }
    expect(dag.has(id)).toBe(true)
  })

  it('RemoveNodeCommand (the tree Delete path) refuses, and the DAG is unchanged', () => {
    const history = new CommandHistory(dag)
    const before = dag.featureOrder()
    expect(() => history.execute(new RemoveNodeCommand(ORIGIN_NODE_ID))).toThrow(GenesisNodeError)
    expect(dag.featureOrder()).toEqual(before)
    expect(history.canUndo()).toBe(false)
  })

  it('a CompositeCommand that sweeps a genesis node in with real features still refuses', () => {
    addSketchOnXY(dag)
    const history = new CommandHistory(dag)
    expect(() =>
      history.execute(new CompositeCommand([new RemoveNodeCommand(FEATURE_A), new RemoveNodeCommand(BASE_PLANE_XY_NODE_ID)])),
    ).toThrow(GenesisNodeError)
    expect(dag.has(BASE_PLANE_XY_NODE_ID)).toBe(true)
  })
})

describe('WO SKC-15: SUPPRESS refuses genesis nodes by name', () => {
  it.each(GENESIS_NODE_IDS)('dag.setSuppressed(%s) throws GenesisNodeError', (id) => {
    const dag = makeDag()
    expect(() => dag.setSuppressed(id, true)).toThrow(GenesisNodeError)
    expect(dag.isSuppressed(id)).toBe(false)
  })

  it('SetSuppressedCommand (the row button + folder-suppress composite) refuses', () => {
    const dag = makeDag()
    const history = new CommandHistory(dag)
    expect(() => history.execute(new SetSuppressedCommand(BASE_PLANE_YZ_NODE_ID, true))).toThrow(GenesisNodeError)
    expect(dag.isSuppressed(BASE_PLANE_YZ_NODE_ID)).toBe(false)
  })
})

describe('WO SKC-15: REORDER refuses genesis nodes by name', () => {
  let dag: FeatureDag

  beforeEach(() => {
    dag = makeDag()
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })
    dag.insertNode({ id: FEATURE_B, kind: 'feature', consumes: [], refs: [], payload: {} })
  })

  it.each(GENESIS_NODE_IDS)('a genesis node (%s) cannot be dragged anywhere', (id) => {
    const blocked = dag.checkReorder(id, 5)
    expect(blocked?.reason).toBe('genesis')
    expect(() => dag.reorderNode(id, 5)).toThrow(/permanent document/)
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A, FEATURE_B])
  })

  it('a feature cannot be dragged above the genesis run', () => {
    for (const target of [0, 1, 2, 3]) {
      const blocked = dag.checkReorder(FEATURE_B, target)
      expect(blocked?.reason, `target index ${target} must be refused`).toBe('genesis')
      expect(() => dag.reorderNode(FEATURE_B, target)).toThrow(/permanent document/)
    }
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A, FEATURE_B])
  })

  it('non-vacuity: a legal feature reorder below the genesis run still works', () => {
    expect(dag.checkReorder(FEATURE_B, 4)).toBeNull()
    dag.reorderNode(FEATURE_B, 4)
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_B, FEATURE_A])
  })

  it('ReorderNodeCommand (the drag-drop path) refuses and leaves the timeline untouched', () => {
    const history = new CommandHistory(dag)
    expect(() => history.execute(new ReorderNodeCommand(ORIGIN_NODE_ID, 4))).toThrow()
    expect(dag.featureOrder()[0]).toBe(ORIGIN_NODE_ID)
  })
})

describe('WO SKC-15: ROLLBACK ignores genesis nodes by name', () => {
  let dag: FeatureDag

  beforeEach(() => {
    dag = makeDag()
    addSketchOnXY(dag)
  })

  it("a 'start' marker rolls back every FEATURE but never Origin or a base plane", () => {
    dag.setRollbackMarker({ kind: 'start' })
    for (const id of GENESIS_NODE_IDS) expect(dag.isRolledBack(id), `${id} must never roll back`).toBe(false)
    expect(dag.isRolledBack(FEATURE_A)).toBe(true)
    expect(dag.rolledBackIds()).toEqual([FEATURE_A])
  })

  it("markerInsertIndex('start') resolves BELOW the genesis run, so an insert-at-marker lands there", () => {
    expect(markerInsertIndex(dag.featureOrder(), { kind: 'start' })).toBe(GENESIS_NODE_IDS.length)
  })

  it('a new sketch on XY is still insertable while everything is rolled back', () => {
    // Regression guard: insertNode refuses a rolled-back PRODUCER. If a 'start' marker rolled back
    // the base planes, every new sketch on one would be rejected -- the bug isRolledBack's genesis
    // guard exists to prevent.
    dag.setRollbackMarker({ kind: 'start' })
    expect(() => addSketchOnXY(dag, 'F3')).not.toThrow()
  })

  it('SetRollbackMarkerCommand to start leaves the genesis rows live', () => {
    const history = new CommandHistory(dag)
    history.execute(new SetRollbackMarkerCommand({ kind: 'start' }))
    expect(dag.isRolledBack(BASE_PLANE_XY_NODE_ID)).toBe(false)
    history.undo()
    expect(dag.getRollbackMarker()).toEqual({ kind: 'end' })
  })
})

describe('WO SKC-15: genesis nodes survive save/load and undo', () => {
  it('serialize -> restore -> restoreRollbackState keeps them pinned at the front', () => {
    const dag = makeDag()
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })

    const reloaded = FeatureDag.restore(dag.serialize())
    reloaded.restoreRollbackState({ featureOrder: dag.featureOrder(), marker: { kind: 'end' } })

    expect(reloaded.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
    expect(reloaded.getNode(BASE_PLANE_XY_NODE_ID)!.payload.lastGoodFrame).toEqual(BASE_PLANE_FRAMES.xy)
  })

  it('an archive that lists Origin BELOW a feature is re-pinned, not obeyed', () => {
    const dag = makeDag()
    dag.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })
    const reloaded = FeatureDag.restore(dag.serialize())
    // Hand-edited / future-version archive: genesis scattered and out of order.
    reloaded.restoreRollbackState({ featureOrder: [FEATURE_A, BASE_PLANE_YZ_NODE_ID, ORIGIN_NODE_ID], marker: { kind: 'end' } })
    expect(reloaded.featureOrder().slice(0, GENESIS_NODE_IDS.length)).toEqual([...GENESIS_NODE_IDS])
  })

  it('a pre-SKC-15 archive (no genesis nodes) gains them at the front on seed', () => {
    const legacy = new FeatureDag()
    legacy.insertNode({ id: FEATURE_A, kind: 'feature', consumes: [], refs: [], payload: {} })
    const reloaded = FeatureDag.restore(legacy.serialize())
    reloaded.restoreRollbackState({ featureOrder: [FEATURE_A], marker: { kind: 'end' } })
    expect(reloaded.featureOrder()).toEqual([FEATURE_A])

    seedGenesisNodes(reloaded)
    expect(reloaded.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
  })

  it('undoing a feature insert removes the feature and nothing else', () => {
    const dag = makeDag()
    const history = new CommandHistory(dag)
    addSketchOnXY(dag)
    history.execute(new RemoveNodeCommand(FEATURE_A))
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS])
    history.undo()
    expect(dag.featureOrder()).toEqual([...GENESIS_NODE_IDS, FEATURE_A])
  })
})
