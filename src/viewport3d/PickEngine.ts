// viewport3d: BVH raycast + edge/vertex proximity picking (WO UI-1 AC2/AC4).
//
// Face picking resolves via the frozen triFace map: MeshBVH gives a triangle
// index, triFace[triangleIndex] gives the faceIndex, faceIds[faceIndex]
// gives the StableId. Edge/vertex picking has no BVH (three-mesh-bvh indexes
// triangles, not polylines) so it does a threshold proximity test against
// the edge polylines directly -- cheap because edge counts are orders of
// magnitude below triangle counts on any real body.
//
// INTERFACE CONCERN (recorded in the WO report): TessBuffers has no native
// vertex-id array -- only faceIds (per triangle-group) and edgeIds (per
// polyline). Vertex identity is synthesized here, not sourced from
// geom-service, by merging edge-polyline endpoints that share a position and
// deriving a BridgeVertexRef (WO UI-1-R1, R1.2) carrying the sorted adjacent
// edgeIds -- the same "sorted set of adjacent identifiers" shape
// stable-id-spec.md uses for real vertex ids, just built from the
// finer-grained data this contract actually exposes. This is a bridge-local
// reference, NOT a StableId and not a persisted document reference; see
// types.ts's BridgeVertexRef doc comment for why (ICR-2 candidate).

import { DoubleSide, Ray, Vector3 } from 'three';
import type { CachedBody, GeometryCache } from './GeometryCache';
import {
  DEFAULT_PICK_THRESHOLDS,
  makeBridgeVertexRef,
  type BodyId,
  type BridgeVertexRef,
  type PickHit,
  type PickThresholds,
  type RayLike,
  type SelectionFilterMode,
} from './types';

interface VertexEntry {
  ref: BridgeVertexRef;
  x: number;
  y: number;
  z: number;
}

interface VertexIndexEntry {
  version: number;
  vertices: VertexEntry[];
}

/** Snap grid for merging edge-polyline endpoints into one vertex (world
 *  units); coarser than float noise, fine enough to keep distinct corners
 *  of any real mock fixture apart. */
const VERTEX_MERGE_EPS = 1e-4;

function quantizeKey(x: number, y: number, z: number): string {
  const q = (v: number): number => Math.round(v / VERTEX_MERGE_EPS);
  return `${q(x)}:${q(y)}:${q(z)}`;
}

export class PickEngine {
  private readonly vertexIndex = new Map<BodyId, VertexIndexEntry>();
  private readonly cache: GeometryCache;

  constructor(cache: GeometryCache) {
    this.cache = cache;
  }

  /** Resolve one pick against one body's cached geometry. Returns null on
   *  no hit (unknown bodyId, or nothing within the ray/threshold). */
  pick(
    bodyId: BodyId,
    ray: RayLike,
    filter: SelectionFilterMode,
    thresholds: PickThresholds = DEFAULT_PICK_THRESHOLDS,
    occluders?: readonly CachedBody[],
  ): PickHit | null {
    const entry = this.cache.get(bodyId);
    if (entry === undefined) return null;

    const threeRay = new Ray(
      new Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
      new Vector3(ray.direction.x, ray.direction.y, ray.direction.z).normalize(),
    );

    switch (filter) {
      case 'body':
        return this.pickBody(entry, threeRay);
      case 'face':
        return this.pickFace(entry, threeRay);
      case 'edge':
        return this.pickEdge(entry, threeRay, thresholds, occluders ?? [entry]);
      case 'vertex':
        return this.pickVertex(entry, threeRay, thresholds.vertex);
    }
  }

  private pickBody(entry: CachedBody, ray: Ray): PickHit | null {
    // DoubleSide: picking must not silently miss a triangle because its
    // winding faces away from the ray (section views, interior picks, or a
    // mock fixture whose winding is merely "consistent", not camera-facing).
    const hit = entry.bvh.raycastFirst(ray, DoubleSide);
    if (hit === null) return null;
    return {
      kind: 'body',
      id: entry.bodyId,
      bodyId: entry.bodyId,
      distance: hit.distance,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    };
  }

  private pickFace(entry: CachedBody, ray: Ray): PickHit | null {
    const hit = entry.bvh.raycastFirst(ray, DoubleSide);
    if (hit === null || hit.faceIndex == null) return null;
    const faceIndex = entry.triFace[hit.faceIndex];
    const id = entry.faceIds[faceIndex];
    return {
      kind: 'face',
      id,
      bodyId: entry.bodyId,
      distance: hit.distance,
      point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    };
  }

  private pickEdge(entry: CachedBody, ray: Ray, thresholds: PickThresholds, occluders: readonly CachedBody[]): PickHit | null {
    const { edgePositions, edgeOffsets, edgeIds } = entry;
    if (edgeIds.length === 0) return null;
    let best: PickHit | null = null;
    let bestDistSq = Infinity;
    const v0 = new Vector3();
    const v1 = new Vector3();
    const onRay = new Vector3();
    const onSegment = new Vector3();
    const sightRay = new Ray();

    for (let e = 0; e < edgeIds.length; e++) {
      const start = edgeOffsets[e];
      const end = edgeOffsets[e + 1];
      for (let p = start; p < end - 1; p++) {
        v0.set(edgePositions[p * 3], edgePositions[p * 3 + 1], edgePositions[p * 3 + 2]);
        v1.set(
          edgePositions[(p + 1) * 3],
          edgePositions[(p + 1) * 3 + 1],
          edgePositions[(p + 1) * 3 + 2],
        );
        const distSq = ray.distanceSqToSegment(v0, v1, onRay, onSegment);
        const rayDistance = ray.origin.distanceTo(onRay);
        const threshold = thresholds.edgeAtDistance?.(rayDistance) ?? thresholds.edge;
        const thresholdSq = threshold * threshold;
        if (distSq <= thresholdSq && distSq < bestDistSq) {
          // WO-2077: proximity alone selected the back corner through a pocket
          // fillet. Test the EDGE point, not the cursor ray: at a silhouette
          // the cursor can miss the mesh, or hit a nearer sloping face while
          // the nearby edge remains visible. Orthographic sight lines stay
          // parallel; perspective sight lines share the camera origin.
          sightRay.origin.copy(ray.origin);
          if (thresholds.edgeProjection === 'orthographic') {
            sightRay.origin.add(onSegment).sub(onRay);
          }
          sightRay.direction.copy(onSegment).sub(sightRay.origin);
          const sightDistance = sightRay.direction.length();
          sightRay.direction.normalize();
          // Only absorb Float32 endpoint/raycast noise, never the much larger
          // cursor tolerance (which would allow picks through thin walls).
          const epsilon = Math.max(1, onSegment.length()) * 1e-6
            + sightDistance * Number.EPSILON * 16;
          if (occluders.some(body => {
            const face = body.bvh.raycastFirst(sightRay, DoubleSide);
            return face !== null && face.distance < sightDistance - epsilon;
          })) continue;
          bestDistSq = distSq;
          best = {
            kind: 'edge',
            id: edgeIds[e],
            bodyId: entry.bodyId,
            distance: rayDistance,
            point: { x: onSegment.x, y: onSegment.y, z: onSegment.z },
          };
        }
      }
    }
    return best;
  }

  private pickVertex(entry: CachedBody, ray: Ray, threshold: number): PickHit | null {
    const vertices = this.verticesFor(entry);
    const thresholdSq = threshold * threshold;
    let best: PickHit | null = null;
    let bestDistSq = Infinity;
    const p = new Vector3();
    const onRay = new Vector3();

    for (const v of vertices) {
      p.set(v.x, v.y, v.z);
      const distSq = ray.distanceSqToPoint(p);
      if (distSq <= thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        ray.closestPointToPoint(p, onRay);
        best = {
          kind: 'vertex',
          id: v.ref,
          bodyId: entry.bodyId,
          distance: ray.origin.distanceTo(onRay),
          point: { x: v.x, y: v.y, z: v.z },
        };
      }
    }
    return best;
  }

  /** Memoized per bodyId+version: only recomputed when ingest() rebuilds
   *  the body (GeometryCache bumps version on every re-ingest). */
  private verticesFor(entry: CachedBody): VertexEntry[] {
    const cached = this.vertexIndex.get(entry.bodyId);
    if (cached !== undefined && cached.version === entry.version) return cached.vertices;

    const byKey = new Map<string, { x: number; y: number; z: number; edgeIds: Set<string> }>();
    for (let e = 0; e < entry.edgeIds.length; e++) {
      const start = entry.edgeOffsets[e];
      const end = entry.edgeOffsets[e + 1];
      if (end <= start) continue;
      for (const p of [start, end - 1]) {
        const x = entry.edgePositions[p * 3];
        const y = entry.edgePositions[p * 3 + 1];
        const z = entry.edgePositions[p * 3 + 2];
        const key = quantizeKey(x, y, z);
        let rec = byKey.get(key);
        if (rec === undefined) {
          rec = { x, y, z, edgeIds: new Set() };
          byKey.set(key, rec);
        }
        rec.edgeIds.add(entry.edgeIds[e]);
      }
    }

    const vertices: VertexEntry[] = [];
    for (const key of [...byKey.keys()].sort()) {
      const rec = byKey.get(key);
      if (rec === undefined) continue;
      const sortedEdges = [...rec.edgeIds].sort();
      vertices.push({ ref: makeBridgeVertexRef(sortedEdges), x: rec.x, y: rec.y, z: rec.z });
    }

    this.vertexIndex.set(entry.bodyId, { version: entry.version, vertices });
    return vertices;
  }
}
