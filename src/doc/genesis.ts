// WO SKC-15 (S3): the GENESIS nodes -- Origin and the three base datum planes (XY/XZ/YZ).
//
// Operator, driving the workbench (docs/3d/WORKBENCH-EXPERIENCE-FINDINGS.md A1/A2):
//   "why does a new sketch in the model have to be a rectangle? Why can I not just start on a
//    plane like the xy, xz, zy planes?"
//   "the model environment has no concept of these planes."
//
// Major parametric CAD systems present Origin + the three default planes as FIRST-CLASS,
// permanent tree items above every feature. This file is the single source of truth for WHICH
// ids are those items, so that every consumer that could delete, reorder, suppress or roll them
// back refuses them BY NAME rather than by accident.
//
// WHY IDS AND NOTHING ELSE LIVE HERE: `src/doc` is the layer `src/sketch3d` imports FROM
// (datumPlane.ts: `import type { ElementMap, FeatureDag, FeatureOp } from '../doc'`). Putting the
// PlaneFrame payloads here would invert that edge into a cycle. The frames are therefore built in
// src/components/model3d/workbench/basePlanes.ts, which owns the geometry; `dag.ts` needs only
// `isGenesisNodeId` to enforce the invariants, and it must not need to know what a plane IS.
//
// THE INVARIANT, stated once: a genesis node is never removed, never reordered, never suppressed,
// never rolled back, and always occupies the first GENESIS_NODE_IDS.length slots of
// FeatureDag.featureOrder(), in the order declared below.

/** The origin triad. Not sketchable -- a reference point + axes; it is a reference-only origin. */
export const ORIGIN_NODE_ID = 'origin'

/** The three base planes. `datum:` matches src/sketch3d/datumPlane.ts's own node-id namespace,
 *  so `datumPlaneIdFromNodeId` keeps working on them unchanged. */
export const BASE_PLANE_XY_NODE_ID = 'datum:XY'
export const BASE_PLANE_XZ_NODE_ID = 'datum:XZ'
export const BASE_PLANE_YZ_NODE_ID = 'datum:YZ'

/**
 * Declaration order IS timeline order: seeded at featureOrder() indices 0..3 and pinned there.
 * Nothing may be inserted, reordered or rolled back above them.
 */
export const GENESIS_NODE_IDS: readonly string[] = [
  ORIGIN_NODE_ID,
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_XZ_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
]

const GENESIS_SET: ReadonlySet<string> = new Set(GENESIS_NODE_IDS)

/** THE by-name refusal predicate. Every suppress/delete/reorder/rollback path calls this. */
export function isGenesisNodeId(id: string): boolean {
  return GENESIS_SET.has(id)
}

export const BASE_PLANE_NODE_IDS: readonly string[] = [
  BASE_PLANE_XY_NODE_ID,
  BASE_PLANE_XZ_NODE_ID,
  BASE_PLANE_YZ_NODE_ID,
]

// WO SKC-15C (audit major: fail-closed genesis ingress).
//
// The audit found that reserved genesis ids were reserved by NAME but not by SHAPE: `insertNode`,
// `restoreNode` and `FeatureDag.restore` accepted `{id:'origin', kind:'feature'}` (or a body, or a
// wrong-plane datum), creating an IMMORTAL ordinary node masquerading as a genesis fixture -- immortal
// because removeNode/setSuppressed then refuse it by name. The fix is a canonical-SHAPE check at every
// ingress point, plus one controlled construction path (`installGenesisNode`).
//
// This module owns IDS and nothing geometric (dag.ts imports from here; src/sketch3d imports from
// dag, so a reverse edge to the PlaneFrame payloads would be a cycle -- see this file's header). The
// canonical SHAPE is nonetheless fully checkable here, because it is structural: a kind and two/three
// string discriminants. The actual frame lives in the payload the workbench builds
// (basePlanes.ts:basePlanePayload) and is validated for finiteness where it is USED, not here.

/** Every genesis node is a datum. Not a feature, not a body -- the one thing an ingress guard checks first. */
export const GENESIS_NODE_KIND = 'datum'

/** id -> the `basePlane` discriminant its canonical payload must carry. Origin is absent (its payload
 *  discriminant is `datumType: 'origin'`, not a base-plane kind). Strings only -- no geometry. */
const GENESIS_BASE_PLANE_BY_ID: Readonly<Record<string, 'xy' | 'xz' | 'yz'>> = {
  [BASE_PLANE_XY_NODE_ID]: 'xy',
  [BASE_PLANE_XZ_NODE_ID]: 'xz',
  [BASE_PLANE_YZ_NODE_ID]: 'yz',
}

/**
 * Is `(id, kind, payload)` the CANONICAL shape for the genesis node `id`? Returns false for a
 * non-genesis id (this predicate only judges reserved ids), and false for any reserved id whose kind
 * or payload discriminants do not match the one true shape.
 *
 * Structural, deliberately shallow: it checks the discriminants that make a node "the Origin" or "the
 * XY base plane", NOT the frame coordinates (those are geometry, validated at the geometry boundary).
 * That is enough to reject every masquerade the audit built -- a feature, a body, an origin-typed
 * datum sitting on the XY id, a base plane with the wrong `basePlane`.
 */
export function isCanonicalGenesisShape(id: string, kind: string, payload: Record<string, unknown> | undefined): boolean {
  if (!isGenesisNodeId(id)) return false
  if (kind !== GENESIS_NODE_KIND) return false
  if (payload === undefined || payload === null) return false
  if (id === ORIGIN_NODE_ID) return payload.datumType === 'origin'
  const expected = GENESIS_BASE_PLANE_BY_ID[id]
  return payload.datumType === 'plane' && payload.planeKind === 'base-plane' && payload.basePlane === expected
}

/**
 * Thrown when a GENERIC ingress path (insertNode / restoreNode) is handed a reserved genesis id. The
 * generic paths refuse genesis ids OUTRIGHT -- a genesis node may only be built through the one
 * controlled path, `FeatureDag.installGenesisNode`, which validates the canonical shape. Named so a
 * test can assert the refusal fired for THIS reason, not because some later guard tripped.
 */
export class GenesisIngressError extends Error {
  readonly nodeId: string
  constructor(nodeId: string, path: string) {
    super(
      `FeatureDag.${path}: '${nodeId}' is a reserved genesis id and cannot be created through a generic ` +
        `ingress path. Genesis nodes are seeded once, through installGenesisNode, in their canonical shape.`,
    )
    this.name = 'GenesisIngressError'
    this.nodeId = nodeId
  }
}

/**
 * Thrown by `installGenesisNode` when its own input is not the canonical shape for its id -- a
 * belt-and-braces guard so even the ONE construction path cannot mint a malformed genesis node.
 */
export class GenesisShapeError extends Error {
  readonly nodeId: string
  constructor(nodeId: string, kind: string) {
    super(
      `FeatureDag.installGenesisNode: '${nodeId}' was given a non-canonical shape (kind '${kind}'). A genesis ` +
        `node must be a '${GENESIS_NODE_KIND}' with its canonical payload discriminants.`,
    )
    this.name = 'GenesisShapeError'
    this.nodeId = nodeId
  }
}

/**
 * How many genesis nodes lead `order`. Used as the FLOOR for every insert/reorder/marker index:
 * counted from the front rather than assumed to be GENESIS_NODE_IDS.length, because a document
 * restored from a pre-SKC-15 archive has none of them until seedGenesisNodes() runs, and a partial
 * seed must never let the floor overshoot the nodes that actually exist.
 */
export function leadingGenesisCount(order: readonly string[]): number {
  let n = 0
  while (n < order.length && isGenesisNodeId(order[n])) n += 1
  return n
}

/** Thrown when a caller tries to delete/reorder/suppress a genesis node. Named so tests can
 *  assert the refusal happened for the RIGHT reason, not because some other guard tripped. */
export class GenesisNodeError extends Error {
  readonly nodeId: string
  constructor(nodeId: string, action: string) {
    super(
      `FeatureDag: '${nodeId}' is a genesis node (Origin / base datum plane) and cannot be ${action}. ` +
        `Origin and the XY/XZ/YZ planes are permanent document fixtures.`,
    )
    this.name = 'GenesisNodeError'
    this.nodeId = nodeId
  }
}
