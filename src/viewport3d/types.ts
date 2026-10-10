// viewport3d: shared types for the render bridge (WO UI-1).
//
// Consumes the FROZEN geom-service.ts contract only (TessBuffers, StableId).
// No kernel/worker types cross into this module -- everything here operates
// on plain TessBuffers already produced elsewhere (mock fixtures for this
// WO; real GeomService output wired in by UI-2).

import type { StableId, TessBuffers } from '../geom/geom-service';

export type { StableId, TessBuffers };

/** Caller-assigned identifier for a tessellated body (GeomService BodyHandle
 *  is worker-local and opaque; the bridge keys its cache on whatever id the
 *  caller uses to name that handle, e.g. `String(handle)`). */
export type BodyId = string;

export type SubshapeKind = 'body' | 'face' | 'edge' | 'vertex';

/** Plain xyz -- framework-agnostic, so callers never need a THREE import to
 *  use this module's public API. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A world-space ray. Callers derive this from whatever camera/input system
 *  they use (mouse NDC + THREE.Camera, XR controller, a fixed test ray...);
 *  the bridge never reaches into a Camera or DOM event itself. */
export interface RayLike {
  origin: Vec3Like;
  direction: Vec3Like;
}

declare const bridgeVertexRefBrand: unique symbol;

/** Bridge-local vertex reference (WO UI-1-R1, R1.2). TessBuffers has no
 *  native vertex-id array -- PickEngine synthesizes vertex identity by
 *  merging edge-polyline endpoints, which is NOT the stable-id-spec vertex
 *  shape (sorted adjacent FACE ids); deriving that would need face-adjacency
 *  data this contract doesn't carry yet (parked as an ICR-2 candidate). This
 *  type carries the sorted adjacent EDGE StableIds a vertex pick was derived
 *  from instead of masquerading as a real StableId. The brand is not
 *  exported, so no value outside this module can satisfy the type structurally
 *  -- only PickEngine (via makeBridgeVertexRef) can mint one, and it can
 *  never be passed where a StableId is expected. */
export interface BridgeVertexRef {
  readonly [bridgeVertexRefBrand]: true;
  readonly adjacentEdgeIds: readonly StableId[];
}

export function makeBridgeVertexRef(adjacentEdgeIds: readonly StableId[]): BridgeVertexRef {
  return { adjacentEdgeIds } as BridgeVertexRef;
}

interface PickHitBase {
  bodyId: BodyId;
  /** Distance from ray.origin, along the ray, to the point of contact
   *  (exact hit point for 'body'/'face'; closest-approach point on the ray
   *  for 'edge'/'vertex' proximity picks). */
  distance: number;
  point: Vec3Like;
}

export interface BodyPickHit extends PickHitBase {
  kind: 'body';
  id: BodyId;
}

export interface FacePickHit extends PickHitBase {
  kind: 'face';
  id: StableId;
}

export interface EdgePickHit extends PickHitBase {
  kind: 'edge';
  id: StableId;
}

/** Vertex hits carry a BridgeVertexRef, never a StableId (R1.2) -- a
 *  vertex-pick result can never be mistaken for, or misused as, a
 *  spec-conformant document reference. */
export interface VertexPickHit extends PickHitBase {
  kind: 'vertex';
  id: BridgeVertexRef;
}

export type PickHit = BodyPickHit | FacePickHit | EdgePickHit | VertexPickHit;

/** Selection filter mode: gates which subshape granularity picking resolves
 *  to, independent of what is geometrically closest to the ray (plan doc
 *  3.3: "selection-filter toggle, like every major CAD"). */
export type SelectionFilterMode = 'body' | 'face' | 'edge' | 'vertex';

export interface PickThresholds {
  /** World-unit distance from ray to an edge polyline segment to count as a hit. */
  edge: number;
  /**
   * Optional camera-aware edge tolerance. The Model workspace uses this to
   * keep its edge target approximately constant in screen pixels as camera
   * distance changes. Lower-level callers that omit it retain the historical
   * fixed-world `edge` threshold.
   */
  edgeAtDistance?(rayDistance: number): number;
  /** Candidate visibility rays converge at the origin unless the camera is orthographic. */
  edgeProjection?: 'perspective' | 'orthographic';
  /** World-unit distance from ray to a vertex point to count as a hit. */
  vertex: number;
}

export const DEFAULT_PICK_THRESHOLDS: PickThresholds = { edge: 0.25, vertex: 0.4 };

export type HighlightKind = 'none' | 'hovered' | 'selected';

export interface SelectionChangeEvent {
  type: 'hover' | 'select';
  hovered: StableId | null;
  selected: ReadonlySet<StableId>;
}
