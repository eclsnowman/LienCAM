/**
 * Derive pickable feature-edge chains directly from triangle-mesh geometry.
 *
 * STL is a triangle soup, so topology is rebuilt from position-welded vertices
 * before boundary/sharp edges are classified. Every later choice is sorted by
 * geometry: triangle order, source vertex indices, and edge insertion order do
 * not participate in chain identity or ordering.
 */
import { computeBoundingBox } from './analysis';
import {
  DEFAULT_MESH_FEATURE_ANGLE_DEG,
  DEFAULT_MESH_WELD_TOL_FRACTION,
} from './prismatic';
import type { MeshBuffers, Vec3 } from './types';

export { DEFAULT_MESH_FEATURE_ANGLE_DEG } from './prismatic';

export interface MeshEdgeChainOptions {
  /** An edge is sharp when its adjacent triangle normals differ by more than this angle. */
  featureAngleDeg?: number;
  /** Position-weld tolerance as a fraction of the mesh bounding-box diagonal. */
  weldTolFraction?: number;
}

export interface MeshEdgeChain {
  /** Geometry-derived identity, stable across triangle and vertex reordering. */
  id: string;
  /** Ordered mesh-local points. Closed chains do not repeat their first point. */
  points: Vec3[];
  closed: boolean;
}

interface WeldedVertex {
  key: string;
  point: Vec3;
}

interface Triangle {
  vertices: [number, number, number];
  normal: Vec3;
}

interface TopologyEdge {
  a: number;
  b: number;
  triangles: number[];
}

interface CanonicalChain extends MeshEdgeChain {
  signature: string;
}

function cleanNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function comparePoint(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function pointKey(point: Vec3, tolerance: number): string {
  return point.map((value) => String(Math.round(cleanNumber(value) / tolerance))).join(':');
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalizedTriangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const value = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}

/**
 * Build quantized position topology with geometry-sorted representatives.
 * Prismatic's weld retains the first-seen point as each cell representative,
 * so it is input-order dependent and cannot satisfy persisted chain identity.
 * Keep this separate weld: selecting the lexicographically smallest point makes
 * near-coincident welding independent of source vertex and triangle order.
 */
function weldedTopology(
  mesh: MeshBuffers,
  tolerance: number,
): { vertices: WeldedVertex[]; triangles: Triangle[]; edges: TopologyEdge[] } {
  const sourceKeys: Array<string | null> = new Array(Math.floor(mesh.positions.length / 3)).fill(null);
  const representativeByKey = new Map<string, Vec3>();

  for (let index = 0; index < sourceKeys.length; index++) {
    const point: Vec3 = [
      cleanNumber(mesh.positions[index * 3]),
      cleanNumber(mesh.positions[index * 3 + 1]),
      cleanNumber(mesh.positions[index * 3 + 2]),
    ];
    if (!point.every(Number.isFinite)) continue;
    const key = pointKey(point, tolerance);
    sourceKeys[index] = key;
    const current = representativeByKey.get(key);
    if (current === undefined || comparePoint(point, current) < 0) representativeByKey.set(key, point);
  }

  const vertices = [...representativeByKey]
    .map(([key, point]) => ({ key, point }))
    .sort((left, right) => comparePoint(left.point, right.point) || left.key.localeCompare(right.key));
  const indexByKey = new Map(vertices.map((vertex, index) => [vertex.key, index]));
  const triangles: Triangle[] = [];

  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const source = [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]];
    const keys = source.map((index) => sourceKeys[index]);
    if (keys.some((key) => key === null || key === undefined)) continue;
    const indices = keys.map((key) => indexByKey.get(key as string));
    if (indices.some((index) => index === undefined)) continue;
    const [a, b, c] = indices as [number, number, number];
    if (a === b || b === c || c === a) continue;
    const normal = normalizedTriangleNormal(vertices[a].point, vertices[b].point, vertices[c].point);
    if (normal === null) continue;
    triangles.push({ vertices: [a, b, c], normal });
  }

  const edgeMap = new Map<string, TopologyEdge>();
  triangles.forEach((triangle, triangleIndex) => {
    const [a, b, c] = triangle.vertices;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = edgeKey(u, v);
      const edge = edgeMap.get(key);
      if (edge) edge.triangles.push(triangleIndex);
      else edgeMap.set(key, { a: Math.min(u, v), b: Math.max(u, v), triangles: [triangleIndex] });
    }
  });
  const edges = [...edgeMap.values()].sort((left, right) => left.a - right.a || left.b - right.b);
  return { vertices, triangles, edges };
}

function smoothPatches(
  triangles: readonly Triangle[],
  edges: readonly TopologyEdge[],
  smoothCos: number,
): number[][] {
  const parent = triangles.map((_triangle, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  for (const edge of edges) {
    for (let left = 0; left < edge.triangles.length; left++) {
      for (let right = left + 1; right < edge.triangles.length; right++) {
        const leftTriangle = edge.triangles[left];
        const rightTriangle = edge.triangles[right];
        if (dot(triangles[leftTriangle].normal, triangles[rightTriangle].normal) >= smoothCos) {
          union(leftTriangle, rightTriangle);
        }
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  triangles.forEach((_triangle, triangleIndex) => {
    const root = find(triangleIndex);
    byRoot.set(root, [...(byRoot.get(root) ?? []), triangleIndex]);
  });
  return [...byRoot.values()];
}

function patchBoundaryEdges(patch: readonly number[], triangles: readonly Triangle[]): TopologyEdge[] {
  const counts = new Map<string, TopologyEdge>();
  for (const triangleIndex of patch) {
    const [a, b, c] = triangles[triangleIndex].vertices;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = edgeKey(u, v);
      const current = counts.get(key);
      if (current) current.triangles.push(triangleIndex);
      else counts.set(key, { a: Math.min(u, v), b: Math.max(u, v), triangles: [triangleIndex] });
    }
  }
  return [...counts.values()]
    .filter((edge) => edge.triangles.length === 1)
    .sort((left, right) => left.a - right.a || left.b - right.b);
}

function literalFeatureEdges(
  edges: readonly TopologyEdge[],
  triangles: readonly Triangle[],
  smoothCos: number,
): TopologyEdge[] {
  return edges.filter((edge) => edge.triangles.length === 1 || (
    edge.triangles.length === 2
    && dot(triangles[edge.triangles[0]].normal, triangles[edge.triangles[1]].normal) < smoothCos
  ));
}

function compareSequence(left: readonly number[], right: readonly number[], vertices: readonly WeldedVertex[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const comparison = comparePoint(vertices[left[index]].point, vertices[right[index]].point);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function canonicalizeVertexSequence(
  sequence: readonly number[],
  closed: boolean,
  vertices: readonly WeldedVertex[],
): number[] {
  if (!closed) {
    const reversed = [...sequence].reverse();
    return compareSequence(sequence, reversed, vertices) <= 0 ? [...sequence] : reversed;
  }

  let minimum = 0;
  for (let index = 1; index < sequence.length; index++) {
    if (comparePoint(vertices[sequence[index]].point, vertices[sequence[minimum]].point) < 0) minimum = index;
  }
  const forward = [...sequence.slice(minimum), ...sequence.slice(0, minimum)];
  const reversedSource = [...sequence].reverse();
  const reverseMinimum = reversedSource.indexOf(sequence[minimum]);
  const reversed = [...reversedSource.slice(reverseMinimum), ...reversedSource.slice(0, reverseMinimum)];
  return compareSequence(forward, reversed, vertices) <= 0 ? forward : reversed;
}

function coordinateSignature(point: Vec3): string {
  return point.map((value) => String(cleanNumber(value))).join(',');
}

function hashSignature(signature: string): string {
  // Two independent FNV-1a passes keep ids compact while making accidental
  // collisions vanishingly unlikely for persisted mesh-chain identities.
  const fnv = (seed: number): number => {
    let hash = seed >>> 0;
    for (let index = 0; index < signature.length; index++) {
      hash ^= signature.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}

function canonicalChain(
  sequence: readonly number[],
  closed: boolean,
  vertices: readonly WeldedVertex[],
): CanonicalChain {
  const canonical = canonicalizeVertexSequence(sequence, closed, vertices);
  const points = canonical.map((index) => [...vertices[index].point] as Vec3);
  const signature = `${closed ? 'C' : 'O'}|${points.map(coordinateSignature).join('|')}`;
  return { id: `mec:${hashSignature(signature)}`, points, closed, signature };
}

function chainBoundaryEdges(
  boundaryEdges: readonly TopologyEdge[],
  vertices: readonly WeldedVertex[],
): CanonicalChain[] {
  if (boundaryEdges.length === 0) return [];
  const adjacency = new Map<number, number[]>();
  boundaryEdges.forEach((edge, edgeIndex) => {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edgeIndex]);
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edgeIndex]);
  });
  for (const incident of adjacency.values()) {
    incident.sort((left, right) => {
      const leftEdge = boundaryEdges[left];
      const rightEdge = boundaryEdges[right];
      return leftEdge.a - rightEdge.a || leftEdge.b - rightEdge.b;
    });
  }

  const visited = new Uint8Array(boundaryEdges.length);
  const walk = (startVertex: number, startEdge: number): { sequence: number[]; closed: boolean } => {
    const sequence = [startVertex];
    let currentVertex = startVertex;
    let currentEdge = startEdge;
    while (visited[currentEdge] === 0) {
      visited[currentEdge] = 1;
      const edge = boundaryEdges[currentEdge];
      const nextVertex = edge.a === currentVertex ? edge.b : edge.a;
      if (nextVertex === startVertex) return { sequence, closed: true };
      sequence.push(nextVertex);
      const incident = adjacency.get(nextVertex) ?? [];
      if (incident.length !== 2) break;
      const nextEdge = incident.find((candidate) => visited[candidate] === 0);
      if (nextEdge === undefined) break;
      currentVertex = nextVertex;
      currentEdge = nextEdge;
    }
    return { sequence, closed: false };
  };

  const chains: CanonicalChain[] = [];
  const branchVertices = [...adjacency.keys()]
    .filter((vertex) => (adjacency.get(vertex)?.length ?? 0) !== 2)
    .sort((left, right) => comparePoint(vertices[left].point, vertices[right].point));
  for (const vertex of branchVertices) {
    for (const edge of adjacency.get(vertex) ?? []) {
      if (visited[edge] !== 0) continue;
      const walked = walk(vertex, edge);
      chains.push(canonicalChain(walked.sequence, walked.closed, vertices));
    }
  }

  for (let edge = 0; edge < boundaryEdges.length; edge++) {
    if (visited[edge] !== 0) continue;
    const candidate = boundaryEdges[edge];
    const start = comparePoint(vertices[candidate.a].point, vertices[candidate.b].point) <= 0
      ? candidate.a
      : candidate.b;
    const walked = walk(start, edge);
    chains.push(canonicalChain(walked.sequence, walked.closed, vertices));
  }
  return chains;
}

/**
 * Extract ordered boundary/sharp-edge polylines from a triangle mesh.
 *
 * Triangles region-grow across edges below the feature threshold, using the
 * same smooth-patch construction as prismatic conversion. Each patch boundary
 * is then chained separately, so a degree-3 solid corner can participate in
 * each adjoining face contour instead of fragmenting a contour. Shared patch
 * boundaries are geometry-deduplicated. A smooth patch can reconnect around a
 * sharp edge, so any literal boundary/sharp edge absent from those contours is
 * chained separately. Branches degrade to deterministic open maximal chains
 * instead of throwing.
 */
export function extractMeshEdgeChains(
  mesh: MeshBuffers,
  options: MeshEdgeChainOptions = {},
): MeshEdgeChain[] {
  if (mesh.positions.length < 9 || mesh.indices.length < 3) return [];
  const bounds = computeBoundingBox(mesh);
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ) || 1;
  const weldFraction = Math.max(0, options.weldTolFraction ?? DEFAULT_MESH_WELD_TOL_FRACTION);
  const tolerance = Math.max(Number.EPSILON, weldFraction * diagonal);
  const angleDeg = Math.max(0, Math.min(180, options.featureAngleDeg ?? DEFAULT_MESH_FEATURE_ANGLE_DEG));
  const smoothCos = Math.cos((angleDeg * Math.PI) / 180);
  const { vertices, triangles, edges } = weldedTopology(mesh, tolerance);
  const bySignature = new Map<string, CanonicalChain>();
  const representedEdgeKeys = new Set<string>();
  for (const patch of smoothPatches(triangles, edges, smoothCos)) {
    const boundaryEdges = patchBoundaryEdges(patch, triangles);
    for (const edge of boundaryEdges) representedEdgeKeys.add(edgeKey(edge.a, edge.b));
    for (const chain of chainBoundaryEdges(boundaryEdges, vertices)) {
      bySignature.set(chain.signature, chain);
    }
  }
  const missingFeatureEdges = literalFeatureEdges(edges, triangles, smoothCos)
    .filter((edge) => !representedEdgeKeys.has(edgeKey(edge.a, edge.b)));
  for (const chain of chainBoundaryEdges(missingFeatureEdges, vertices)) {
    bySignature.set(chain.signature, chain);
  }
  return [...bySignature.values()]
    .sort((left, right) => left.signature.localeCompare(right.signature))
    .map(({ signature: _signature, ...chain }) => chain);
}
