// WO SKC-15 (S3): the Origin + XY/XZ/YZ base-plane GENESIS nodes -- their frames, their payloads,
// and the idempotent seeder that puts them at the top of every workbench document.
//
// Operator, driving the workbench (docs/3d/WORKBENCH-EXPERIENCE-FINDINGS.md A2): "the model
// environment has no concept of these planes". Major parametric CAD systems present Origin and
// three default planes as permanent, first-class tree items above every feature; this file makes
// that true here.
//
// REPRESENTATION DECISION (WO item 1 asks this to be justified): these are REAL FeatureDag nodes,
// not synthetic pinned rows in FeatureTree. Three reasons, in order of weight:
//
//  1. A sketch must CONSUME its plane. SKC-5 established the shape: a sketch node carries
//     `planeNodeId` and structurally `consumes` that datum, which is what makes
//     RegenScheduler.downstreamClosure re-run the sketch when its plane moves. A synthetic row is
//     not a node, so a sketch on XY would have nothing to consume -- every dirty-closure,
//     rollback and regen path would need a "...unless the plane is one of the fake ones" branch.
//     That is exactly the second-owner shape this program keeps deleting.
//  2. Persistence and undo come for free. `dag.serialize()` writes nodes; `FeatureDag.restore()`
//     rebuilds them; `restoreRollbackState` pins them to the front (dag.ts). Synthetic rows would
//     need their own parallel save/load, and a sketch's `planeNodeId` would dangle on load.
//  3. A standard feature model. They are features -- selectable, referenceable, listed. The tree is not
//     lying about them.
//
// The cost of that decision is that they now appear in `dag.featureOrder()`, which every
// suppress/delete/reorder/rollback consumer reads. That cost is paid ONCE, by name, in
// src/doc/genesis.ts + the guards in dag.ts -- not by each consumer guessing.

import type { CommandHistory, FeatureDag } from '../../../doc'
import {
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_XZ_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
  GENESIS_NODE_IDS,
  ORIGIN_NODE_ID,
} from '../../../doc'
import type { BasePlaneDatumPayload, BasePlaneKind, OriginDatumPayload } from '../../../sketch3d'
import type { PlaneFrame } from '../../../sketch3d'

/**
 * The three world planes. Normals/xDirs match `workbench/profileGeometry.ts`'s own `planeFor()`
 * for xy and xz EXACTLY -- those two are already proven against the real occt-wasm kernel by
 * extrude.test.ts / revolve.test.ts, so the base planes must not disagree with the rectangle
 * dialog about what "the XY plane" means.
 *
 * Local Y is `normal x xDir` (planeMath.ts's convention, cross-checked there against these same
 * fixtures). Written out per plane, because a sign flip here silently mirrors every sketch drawn
 * on it left-for-right and no downstream test would catch it:
 *   xy: normal=(0,0,1)  xDir=(1,0,0) -> localY=(0,1,0) = world +Y
 *   xz: normal=(0,-1,0) xDir=(1,0,0) -> localY=(0,0,1) = world +Z   (revolve-about-Z friendly)
 *   yz: normal=(1,0,0)  xDir=(0,1,0) -> localY=(0,0,1) = world +Z
 */
export const BASE_PLANE_FRAMES: Readonly<Record<BasePlaneKind, PlaneFrame>> = {
  xy: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
  xz: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } },
  yz: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } },
}

/** Node id <-> which world plane. The ONLY mapping; the picker, the seeder and the viewport glyph
 *  all read it, so they cannot disagree about which node is "YZ". */
export const BASE_PLANE_BY_NODE_ID: Readonly<Record<string, BasePlaneKind>> = {
  [BASE_PLANE_XY_NODE_ID]: 'xy',
  [BASE_PLANE_XZ_NODE_ID]: 'xz',
  [BASE_PLANE_YZ_NODE_ID]: 'yz',
}

export const NODE_ID_BY_BASE_PLANE: Readonly<Record<BasePlaneKind, string>> = {
  xy: BASE_PLANE_XY_NODE_ID,
  xz: BASE_PLANE_XZ_NODE_ID,
  yz: BASE_PLANE_YZ_NODE_ID,
}

export const BASE_PLANE_LABELS: Readonly<Record<BasePlaneKind, string>> = { xy: 'XY', xz: 'XZ', yz: 'YZ' }

function basePlanePayload(kind: BasePlaneKind): BasePlaneDatumPayload {
  return {
    datumType: 'plane',
    planeKind: 'base-plane',
    basePlane: kind,
    lastGoodFrame: BASE_PLANE_FRAMES[kind],
    name: BASE_PLANE_LABELS[kind],
  }
}

function originPayload(): OriginDatumPayload {
  return { datumType: 'origin', name: 'Origin' }
}

/** True once every genesis node exists. Cheap; the seeder is idempotent regardless. */
export function hasGenesisNodes(dag: FeatureDag): boolean {
  return GENESIS_NODE_IDS.every((id) => dag.has(id))
}

/**
 * Puts Origin + XY/XZ/YZ at featureOrder() indices 0..3, in their canonical shape. IDEMPOTENT on a
 * clean document; REPAIRING on a damaged one.
 *
 * WO SKC-15C (audit major: fail-closed genesis ingress). The pre-SKC-15C version skipped any id that
 * already existed (`if (dag.has(id)) return`) and inserted the rest at fixed indices. The audit
 * showed both halves were wrong:
 *   - "skip if it exists" left a MALFORMED existing genesis node (a wrong-kind masquerade that slipped
 *     in before this WO's ingress guards, or a canonical-but-stale one from an archive) in place. Now
 *     every genesis id is force-INSTALLED through `dag.installGenesisNode`, the one path that can
 *     replace a reserved id (removeNode refuses them by name), so a damaged entry is overwritten with
 *     the canonical one rather than trusted.
 *   - fixed insert indices left a PARTIAL seed scrambled: seeding an existing `[datum:YZ, datum:XY,
 *     F1]` produced `[origin, datum:YZ, datum:XZ, datum:XY, F1]`. Now `dag.reseatGenesis()` pins all
 *     four to the front in canonical order once they all exist, in one pass.
 *
 * NOT a Command, and deliberately never on the undo stack: these nodes have no creation event to undo
 * -- they are a property of "a document exists at all". installGenesisNode never touches history.
 */
export function seedGenesisNodes(dag: FeatureDag): void {
  dag.installGenesisNode({ id: ORIGIN_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: originPayload() })
  dag.installGenesisNode({ id: BASE_PLANE_XY_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: basePlanePayload('xy') })
  dag.installGenesisNode({ id: BASE_PLANE_XZ_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: basePlanePayload('xz') })
  dag.installGenesisNode({ id: BASE_PLANE_YZ_NODE_ID, kind: 'datum', consumes: [], refs: [], payload: basePlanePayload('yz') })
  dag.reseatGenesis()
}

/** The frame a base-plane node resolves to, or undefined if `nodeId` is not a base plane. */
export function basePlaneFrame(nodeId: string): PlaneFrame | undefined {
  const kind = BASE_PLANE_BY_NODE_ID[nodeId]
  return kind === undefined ? undefined : BASE_PLANE_FRAMES[kind]
}

/** Guard for callers holding a CommandHistory: genesis seeding must never enter it. Exported so a
 *  test can assert the seeder left `history` untouched (a genesis node that can be undone away is
 *  the whole failure mode this function's doc comment exists to prevent). */
export function seedGenesisNodesOutsideHistory(dag: FeatureDag, history: CommandHistory): void {
  const before = history.canUndo()
  seedGenesisNodes(dag)
  if (history.canUndo() !== before) {
    throw new Error('seedGenesisNodes must not push onto CommandHistory -- Origin is not undoable.')
  }
}
