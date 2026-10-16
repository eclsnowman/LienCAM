import type {
  BoundingBox,
  MeshAnalyzeOptions,
  MeshBuffers,
  MeshHealthReport,
  MeshMeasureResult,
  MeshOrientResult,
  MeshRepairResult,
  Vec3,
} from './types';

const EPS = 1e-8;

interface EdgeInfo {
  a: number;
  b: number;
  count: number;
  faces: number[];
  /** WO-1453: direction each face in `faces` traversed this edge: +1 a-then-b,
   *  -1 b-then-a. The two faces of a consistently wound edge have opposite
   *  signs; matching signs are a winding conflict. */
  dirs: number[];
}

interface TriangleRef {
  tri: number;
  a: number;
  b: number;
  c: number;
}

function vec(mesh: MeshBuffers, index: number): Vec3 {
  const i = index * 3;
  return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

function triangleVolume(a: Vec3, b: Vec3, c: Vec3): number {
  return dot(a, cross(b, c)) / 6;
}

function edgeKey(a: number, b: number): string {
  return a < b ? String(a) + ':' + String(b) : String(b) + ':' + String(a);
}

function addEdge(edges: Map<string, EdgeInfo>, a: number, b: number, face: number): void {
  const key = edgeKey(a, b);
  const dir = a < b ? 1 : -1;
  const existing = edges.get(key);
  if (existing) {
    existing.count += 1;
    existing.faces.push(face);
    existing.dirs.push(dir);
    return;
  }
  edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), count: 1, faces: [face], dirs: [dir] });
}

/** WO-1453: edges shared by exactly two triangles that traverse them the same way. */
function countWindingConflicts(edges: Map<string, EdgeInfo>): number {
  let count = 0;
  for (const edge of edges.values()) {
    if (edge.count === 2 && edge.dirs[0] === edge.dirs[1]) count += 1;
  }
  return count;
}

function validateMeshShape(mesh: MeshBuffers): void {
  if (mesh.positions.length % 3 !== 0) {
    throw new Error('mesh positions length ' + String(mesh.positions.length) + ' is not divisible by 3');
  }
  if (mesh.indices.length % 3 !== 0) {
    throw new Error('mesh indices length ' + String(mesh.indices.length) + ' is not divisible by 3');
  }
  const vertexCount = mesh.positions.length / 3;
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i])) throw new Error('mesh position ' + String(i) + ' is non-finite');
  }
  for (let i = 0; i < mesh.indices.length; i++) {
    if (mesh.indices[i] >= vertexCount) {
      throw new Error('mesh index ' + String(i) + ' references vertex ' + String(mesh.indices[i]) + ', but only ' + String(vertexCount) + ' vertices exist');
    }
  }
}

function triangleRefs(mesh: MeshBuffers): TriangleRef[] {
  const refs: TriangleRef[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    refs.push({ tri: i / 3, a: mesh.indices[i], b: mesh.indices[i + 1], c: mesh.indices[i + 2] });
  }
  return refs;
}

function isDegenerate(mesh: MeshBuffers, ref: TriangleRef): boolean {
  if (ref.a === ref.b || ref.b === ref.c || ref.a === ref.c) return true;
  return triangleArea(vec(mesh, ref.a), vec(mesh, ref.b), vec(mesh, ref.c)) <= EPS;
}

// BK-17b / MSH-4 rider (b): deterministic, contention-immune proof that
// analyzeAndMeasure runs buildTopology ONCE where analyzeMesh()+measureMesh()
// back-to-back runs it TWICE. The original BK-17b test asserted this via a
// wall-clock race (best-of-3 timing of "separate" vs "shared") which inverts
// under full-suite CPU contention (observed 2026-07-08: two node processes
// fighting for cores skews the *slower* path faster by scheduler luck, not
// algorithm). A call counter measures the actual mechanism -- one shared
// topology traversal vs two redundant ones -- directly, with zero dependency
// on wall-clock scheduling. TEST HOOK, same precedent as manifoldOps.ts's
// debugLiveHandleCount.
let buildTopologyCallCount = 0;

export function debugBuildTopologyCallCount(): number {
  return buildTopologyCallCount;
}

export function debugResetBuildTopologyCallCount(): void {
  buildTopologyCallCount = 0;
}

function buildTopology(mesh: MeshBuffers): {
  edges: Map<string, EdgeInfo>;
  degenerateTriangles: Set<number>;
  duplicateTriangleCount: number;
  goodTriangles: TriangleRef[];
} {
  buildTopologyCallCount += 1;
  validateMeshShape(mesh);
  const edges = new Map<string, EdgeInfo>();
  const degenerateTriangles = new Set<number>();
  const seenTriangles = new Set<string>();
  const goodTriangles: TriangleRef[] = [];
  let duplicateTriangleCount = 0;

  for (const ref of triangleRefs(mesh)) {
    if (isDegenerate(mesh, ref)) {
      degenerateTriangles.add(ref.tri);
      continue;
    }
    const sorted = [ref.a, ref.b, ref.c].sort((a, b) => a - b);
    const key = String(sorted[0]) + ':' + String(sorted[1]) + ':' + String(sorted[2]);
    if (seenTriangles.has(key)) duplicateTriangleCount += 1;
    seenTriangles.add(key);
    goodTriangles.push(ref);
    addEdge(edges, ref.a, ref.b, ref.tri);
    addEdge(edges, ref.b, ref.c, ref.tri);
    addEdge(edges, ref.c, ref.a, ref.tri);
  }

  return { edges, degenerateTriangles, duplicateTriangleCount, goodTriangles };
}

function countBoundaryLoops(boundaryEdges: EdgeInfo[]): number {
  if (boundaryEdges.length === 0) return 0;
  const adjacency = new Map<number, number[]>();
  for (const edge of boundaryEdges) {
    const a = adjacency.get(edge.a) ?? [];
    const b = adjacency.get(edge.b) ?? [];
    a.push(edge.b);
    b.push(edge.a);
    adjacency.set(edge.a, a);
    adjacency.set(edge.b, b);
  }
  const visited = new Set<string>();
  let loops = 0;
  for (const edge of boundaryEdges) {
    const firstKey = edgeKey(edge.a, edge.b);
    if (visited.has(firstKey)) continue;
    loops += 1;
    const stack: number[] = [edge.a, edge.b];
    visited.add(firstKey);
    while (stack.length > 0) {
      const v = stack.pop() as number;
      for (const next of adjacency.get(v) ?? []) {
        const key = edgeKey(v, next);
        if (visited.has(key)) continue;
        visited.add(key);
        stack.push(next);
      }
    }
  }
  return loops;
}

function bboxOverlap(a: [Vec3, Vec3], b: [Vec3, Vec3]): boolean {
  for (let axis = 0; axis < 3; axis++) {
    if (a[1][axis] < b[0][axis] - EPS || b[1][axis] < a[0][axis] - EPS) return false;
  }
  return true;
}

function triangleBounds(a: Vec3, b: Vec3, c: Vec3): [Vec3, Vec3] {
  return [
    [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])],
    [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])],
  ];
}

function segmentIntersectsTriangle(p0: Vec3, p1: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const dir = sub(p1, p0);
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const h = cross(dir, e2);
  const det = dot(e1, h);
  if (Math.abs(det) <= EPS) return false;
  const invDet = 1 / det;
  const s = sub(p0, a);
  const u = invDet * dot(s, h);
  if (u < -EPS || u > 1 + EPS) return false;
  const q = cross(s, e1);
  const v = invDet * dot(dir, q);
  if (v < -EPS || u + v > 1 + EPS) return false;
  const t = invDet * dot(e2, q);
  return t > EPS && t < 1 - EPS;
}

function refsShareVertex(a: TriangleRef, b: TriangleRef): boolean {
  return a.a === b.a || a.a === b.b || a.a === b.c || a.b === b.a || a.b === b.b || a.b === b.c || a.c === b.a || a.c === b.b || a.c === b.c;
}

function trianglesIntersect(mesh: MeshBuffers, left: TriangleRef, right: TriangleRef): boolean {
  if (refsShareVertex(left, right)) return false;
  const a0 = vec(mesh, left.a);
  const a1 = vec(mesh, left.b);
  const a2 = vec(mesh, left.c);
  const b0 = vec(mesh, right.a);
  const b1 = vec(mesh, right.b);
  const b2 = vec(mesh, right.c);
  if (!bboxOverlap(triangleBounds(a0, a1, a2), triangleBounds(b0, b1, b2))) return false;
  return (
    segmentIntersectsTriangle(a0, a1, b0, b1, b2) ||
    segmentIntersectsTriangle(a1, a2, b0, b1, b2) ||
    segmentIntersectsTriangle(a2, a0, b0, b1, b2) ||
    segmentIntersectsTriangle(b0, b1, a0, a1, a2) ||
    segmentIntersectsTriangle(b1, b2, a0, a1, a2) ||
    segmentIntersectsTriangle(b2, b0, a0, a1, a2)
  );
}

/**
 * BK-11a: self-intersection detection accelerated by a UNIFORM SPATIAL GRID.
 *
 * The old implementation was an O(n^2) all-pairs loop that ran on EVERY import
 * (INT-3 measured it at 31.2s on the 14,160-triangle fixture). Two triangles
 * can only intersect if their axis-aligned bounding boxes overlap, and two
 * boxes only overlap if they share at least one grid cell. So binning every
 * triangle into all cells its AABB touches, then only testing pairs that
 * co-occupy a cell, is EXACT — it can never miss a truly-intersecting pair
 * (that pair necessarily shares a cell), so the boolean verdict is byte-for-
 * byte identical to the brute-force scan on every input. For realistic surface
 * meshes (triangles spatially separated) the candidate-pair count collapses
 * from ~n^2/2 to ~n, a >=10x measured speedup (see MSH-3.report.json). The
 * worst case (all triangles in one cell) degrades gracefully to the original
 * O(n^2) behavior, never worse.
 *
 * Determinism: triangles are inserted into cell lists in ascending index
 * order, and each unordered pair is tested at most once (from the lower-index
 * member, deduped across shared cells) — so the FIRST intersecting pair found,
 * and therefore the early-return, is independent of hash-map iteration order.
 * The verdict is a pure boolean either way.
 */
function hasSelfIntersections(mesh: MeshBuffers, goodTriangles: TriangleRef[]): boolean {
  const n = goodTriangles.length;
  if (n < 2) return false;

  const bbox = computeBoundingBox(mesh);
  const extent: Vec3 = [
    bbox.max[0] - bbox.min[0],
    bbox.max[1] - bbox.min[1],
    bbox.max[2] - bbox.min[2],
  ];
  // Resolution per axis ~ cbrt(n), clamped so total cells stay bounded and a
  // near-flat mesh (zero extent on an axis) collapses that axis to one cell.
  const res = Math.min(128, Math.max(1, Math.ceil(Math.cbrt(n))));
  const div: [number, number, number] = [
    extent[0] > EPS ? res : 1,
    extent[1] > EPS ? res : 1,
    extent[2] > EPS ? res : 1,
  ];
  const cellSize: [number, number, number] = [
    extent[0] > EPS ? extent[0] / div[0] : 1,
    extent[1] > EPS ? extent[1] / div[1] : 1,
    extent[2] > EPS ? extent[2] / div[2] : 1,
  ];
  const cellIndex = (x: number, y: number, z: number): number => (x * div[1] + y) * div[2] + z;
  const axisCell = (value: number, axis: number): number => {
    const raw = Math.floor((value - bbox.min[axis]) / cellSize[axis]);
    return raw < 0 ? 0 : raw >= div[axis] ? div[axis] - 1 : raw;
  };

  // Bin every triangle into all cells its AABB touches. Lists stay ascending
  // because we insert in triangle order.
  const cells = new Map<number, number[]>();
  const triCellRanges: Array<[number, number, number, number, number, number]> = new Array(n);
  for (let i = 0; i < n; i++) {
    const ref = goodTriangles[i];
    const a = vec(mesh, ref.a);
    const b = vec(mesh, ref.b);
    const c = vec(mesh, ref.c);
    const [lo, hi] = triangleBounds(a, b, c);
    const x0 = axisCell(lo[0], 0), x1 = axisCell(hi[0], 0);
    const y0 = axisCell(lo[1], 1), y1 = axisCell(hi[1], 1);
    const z0 = axisCell(lo[2], 2), z1 = axisCell(hi[2], 2);
    triCellRanges[i] = [x0, x1, y0, y1, z0, z1];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellIndex(x, y, z);
          const list = cells.get(key);
          if (list) list.push(i);
          else cells.set(key, [i]);
        }
      }
    }
  }

  // For each triangle, gather higher-index candidates sharing any of its cells
  // (deduped), then test. Early-return on the first real intersection.
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    seen.clear();
    const [x0, x1, y0, y1, z0, z1] = triCellRanges[i];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const list = cells.get(cellIndex(x, y, z));
          if (!list) continue;
          for (const j of list) {
            if (j <= i || seen.has(j)) continue;
            seen.add(j);
            if (trianglesIntersect(mesh, goodTriangles[i], goodTriangles[j])) return true;
          }
        }
      }
    }
  }
  return false;
}

function countComponents(goodTriangles: TriangleRef[], edges: Map<string, EdgeInfo>): number {
  if (goodTriangles.length === 0) return 0;
  const byTri = new Map<number, number[]>();
  for (const ref of goodTriangles) byTri.set(ref.tri, []);
  for (const edge of edges.values()) {
    for (const face of edge.faces) {
      const peers = byTri.get(face);
      if (!peers) continue;
      for (const other of edge.faces) if (other !== face) peers.push(other);
    }
  }
  const visited = new Set<number>();
  let components = 0;
  for (const ref of goodTriangles) {
    if (visited.has(ref.tri)) continue;
    components += 1;
    const stack = [ref.tri];
    visited.add(ref.tri);
    while (stack.length > 0) {
      const tri = stack.pop() as number;
      for (const next of byTri.get(tri) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return components;
}

export function computeBoundingBox(mesh: MeshBuffers): BoundingBox {
  if (mesh.positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[i + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

type Topology = ReturnType<typeof buildTopology>;

function measuresFromTopology(mesh: MeshBuffers, topology: Topology): MeshMeasureResult {
  const { edges, goodTriangles } = topology;
  let surfaceArea = 0;
  let signedVolume = 0;
  const referenced = new Set<number>();

  for (const ref of goodTriangles) {
    const a = vec(mesh, ref.a);
    const b = vec(mesh, ref.b);
    const c = vec(mesh, ref.c);
    surfaceArea += triangleArea(a, b, c);
    signedVolume += triangleVolume(a, b, c);
    referenced.add(ref.a);
    referenced.add(ref.b);
    referenced.add(ref.c);
  }

  const bbox = computeBoundingBox(mesh);
  const boundaryEdgeCount = [...edges.values()].filter((edge) => edge.count === 1).length;
  const nonManifoldEdgeCount = [...edges.values()].filter((edge) => edge.count > 2).length;
  const componentCount = countComponents(goodTriangles, edges);
  let genus: number | null = null;
  if (boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0 && componentCount > 0) {
    const chi = referenced.size - edges.size + goodTriangles.length;
    const raw = (2 * componentCount - chi) / 2;
    genus = Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : raw;
  }

  return {
    triangleCount: goodTriangles.length,
    vertexCount: referenced.size,
    surfaceArea,
    volume: Math.abs(signedVolume),
    // MSH-2-R1.2: expose the un-abs()'d signed volume so callers can assert
    // real outward orientation -- `volume` above cannot catch a winding
    // inversion because Math.abs() makes both orientations report identically.
    signedVolume,
    bbox,
    genus,
    componentCount,
  };
}

function reportFromTopology(mesh: MeshBuffers, topology: Topology, options: MeshAnalyzeOptions): MeshHealthReport {
  const { edges, degenerateTriangles, duplicateTriangleCount, goodTriangles } = topology;
  const boundaryEdges = [...edges.values()].filter((edge) => edge.count === 1);
  const nonManifoldEdgeCount = [...edges.values()].filter((edge) => edge.count > 2).length;
  const selfIntersections = options.checkSelfIntersections === false ? false : hasSelfIntersections(mesh, goodTriangles);
  const windingConflictEdgeCount = countWindingConflicts(edges);
  const warnings: string[] = [];
  if (degenerateTriangles.size > 0) warnings.push('Dropped ' + String(degenerateTriangles.size) + ' degenerate triangle(s) during analysis');
  if (boundaryEdges.length > 0) warnings.push('Mesh is not watertight: ' + String(boundaryEdges.length) + ' boundary edge(s) across ' + String(countBoundaryLoops(boundaryEdges)) + ' hole(s)');
  if (nonManifoldEdgeCount > 0) warnings.push('Mesh has ' + String(nonManifoldEdgeCount) + ' non-manifold edge(s)');
  if (duplicateTriangleCount > 0) warnings.push('Mesh has ' + String(duplicateTriangleCount) + ' duplicate triangle(s)');
  if (windingConflictEdgeCount > 0) warnings.push('Mesh has ' + String(windingConflictEdgeCount) + ' winding conflict edge(s) (adjacent triangles wind the same direction)');
  if (selfIntersections) warnings.push('Mesh has self-intersections');

  return {
    triangleCount: goodTriangles.length,
    vertexCount: mesh.positions.length / 3,
    watertight: boundaryEdges.length === 0 && nonManifoldEdgeCount === 0 && degenerateTriangles.size === 0,
    selfIntersections,
    holeCount: countBoundaryLoops(boundaryEdges),
    boundaryEdgeCount: boundaryEdges.length,
    nonManifoldEdgeCount,
    degenerateTriangleCount: degenerateTriangles.size,
    duplicateTriangleCount,
    windingConflictEdgeCount,
    warnings,
  };
}

export function measureMesh(mesh: MeshBuffers): MeshMeasureResult {
  return measuresFromTopology(mesh, buildTopology(mesh));
}

export function analyzeMesh(mesh: MeshBuffers, options: MeshAnalyzeOptions = { checkSelfIntersections: true }): MeshHealthReport {
  return reportFromTopology(mesh, buildTopology(mesh), options);
}

/**
 * BK-17b: run buildTopology EXACTLY ONCE and derive BOTH the health report and
 * the measures from that single pass. Every bundled {report, measures} path
 * (stl.ts importStl, manifoldOps.ts operationResult, repairMesh below) used to
 * call analyzeMesh() and measureMesh() back to back, paying for buildTopology
 * (edge map + degenerate scan + duplicate scan) twice per operation. This
 * shares it: measured before/after on the 100k-tri fixture in MSH-3.report.json.
 * The returned report and measures are bit-identical to calling the two
 * functions separately (same topology, same math) — only the redundant second
 * traversal is removed.
 */
export function analyzeAndMeasure(
  mesh: MeshBuffers,
  options: MeshAnalyzeOptions = { checkSelfIntersections: true },
): { report: MeshHealthReport; measures: MeshMeasureResult } {
  const topology = buildTopology(mesh);
  return {
    report: reportFromTopology(mesh, topology, options),
    measures: measuresFromTopology(mesh, topology),
  };
}

/**
 * WO-2763: the mesh without its zero-area (or repeated-vertex) triangles -
 * the same test analysis and repair use. `keptTriangles[i]` is the input
 * triangle output triangle `i` came from. With nothing to drop it returns the
 * input mesh object itself, so a clean mesh is untouched.
 */
export function dropZeroAreaTriangles(mesh: MeshBuffers): { mesh: MeshBuffers; keptTriangles: Uint32Array | null; dropped: number } {
  const kept: number[] = [];
  for (const ref of triangleRefs(mesh)) {
    if (!isDegenerate(mesh, ref)) kept.push(ref.tri);
  }
  const dropped = mesh.indices.length / 3 - kept.length;
  if (dropped === 0) return { mesh, keptTriangles: null, dropped: 0 };
  const indices = new Uint32Array(kept.length * 3);
  kept.forEach((tri, i) => indices.set(mesh.indices.subarray(tri * 3, tri * 3 + 3), i * 3));
  return { mesh: { positions: mesh.positions, indices }, keptTriangles: Uint32Array.from(kept), dropped };
}

function cleanedMesh(mesh: MeshBuffers): { mesh: MeshBuffers; dropped: number } {
  const positions = new Float32Array(mesh.positions);
  const indices: number[] = [];
  let dropped = 0;
  for (const ref of triangleRefs(mesh)) {
    if (isDegenerate(mesh, ref)) {
      dropped += 1;
      continue;
    }
    indices.push(ref.a, ref.b, ref.c);
  }
  return { mesh: { positions, indices: new Uint32Array(indices) }, dropped };
}

/**
 * WO-1911: triangles over the same three vertices. Two copies facing opposite
 * ways are a zero-thickness fold and cancel; copies facing the same way are one
 * facet. A set keeps |net winding| copies (0 or 1), the first that faces the
 * winning way - unless that would leave one of its edges with a single facet:
 * a set on an edge a third facet also uses stays, because cancelling it would
 * open a crack repair cannot always walk. Measured on Operator's broken STLs
 * (WO-1911 worker report): fewer non-manifold edges and no more open holes on
 * every file tested; Next's keep-one dedupe left the folds in.
 */
function cancelDuplicateTriangles(mesh: MeshBuffers): MeshBuffers {
  const groups = new Map<string, number[]>();
  for (const ref of triangleRefs(mesh)) {
    const sorted = [ref.a, ref.b, ref.c].sort((a, b) => a - b);
    const key = String(sorted[0]) + ':' + String(sorted[1]) + ':' + String(sorted[2]);
    const group = groups.get(key);
    if (group) group.push(ref.tri);
    else groups.set(key, [ref.tri]);
  }
  // +1 when the triangle winds as its vertex set in ascending order (any rotation), -1 reversed.
  const winding = (tri: number): number => {
    const a = mesh.indices[tri * 3];
    const b = mesh.indices[tri * 3 + 1];
    const c = mesh.indices[tri * 3 + 2];
    return (a < b ? 1 : 0) + (b < c ? 1 : 0) + (c < a ? 1 : 0) === 2 ? 1 : -1;
  };
  const drop = new Set<number>();
  let uses: Map<string, number> | null = null;
  for (const group of groups.values()) {
    if (group.length === 1) continue;
    if (uses === null) {
      uses = new Map<string, number>();
      for (const ref of triangleRefs(mesh)) {
        for (const key of [edgeKey(ref.a, ref.b), edgeKey(ref.b, ref.c), edgeKey(ref.c, ref.a)]) uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    const net = group.reduce((sum, tri) => sum + winding(tri), 0);
    const kept = net === 0 ? -1 : (group.find((tri) => winding(tri) === Math.sign(net)) as number);
    const removed = group.length - (kept === -1 ? 0 : 1);
    const i = group[0] * 3;
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    const rim = [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)];
    const counts = uses;
    if (rim.some((key) => (counts.get(key) as number) - removed === 1)) continue;
    for (const key of rim) counts.set(key, (counts.get(key) as number) - removed);
    for (const tri of group) if (tri !== kept) drop.add(tri);
  }
  if (drop.size === 0) return mesh;
  const indices: number[] = [];
  for (const ref of triangleRefs(mesh)) if (!drop.has(ref.tri)) indices.push(ref.a, ref.b, ref.c);
  return { positions: mesh.positions, indices: new Uint32Array(indices) };
}

/** WO-1907: every boundary loop, each running the way its CAP must - the
 *  reverse of how the surviving facets traverse its edges (majority vote, so a
 *  rim the surface walks inconsistently still gets a cap and orientMesh settles
 *  it). A cap wound this way meets its rim with no winding conflict. */
function boundaryLoops(mesh: MeshBuffers): number[][] {
  const { edges } = buildTopology(mesh);
  const boundary = [...edges.values()].filter((edge) => edge.count === 1).sort((a, b) => a.a - b.a || a.b - b.b);
  const adjacency = new Map<number, number[]>();
  for (const edge of boundary) {
    adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b].sort((a, b) => a - b));
    adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a].sort((a, b) => a - b));
  }

  const visited = new Set<string>();
  const loops: number[][] = [];
  for (const edge of boundary) {
    if (visited.has(edgeKey(edge.a, edge.b))) continue;
    const loop = [edge.a, edge.b];
    visited.add(edgeKey(edge.a, edge.b));
    let prev = edge.a;
    let current = edge.b;
    for (let guard = 0; guard < boundary.length + 1; guard++) {
      const next = (adjacency.get(current) ?? []).find((candidate) => candidate !== prev && !visited.has(edgeKey(current, candidate)));
      if (next === undefined) break;
      visited.add(edgeKey(current, next));
      if (next === loop[0]) break;
      loop.push(next);
      prev = current;
      current = next;
    }
    if (loop.length < 3) continue;
    let alongSurface = 0;
    for (let i = 0; i < loop.length; i++) {
      const u = loop[i];
      const v = loop[(i + 1) % loop.length];
      const edge = edges.get(edgeKey(u, v));
      if (edge === undefined || edge.count !== 1) continue;
      alongSurface += (u < v ? 1 : -1) === edge.dirs[0] ? 1 : -1;
    }
    loops.push(alongSurface > 0 ? loop.reverse() : loop);
  }
  return loops;
}

/**
 * WO-1907: index triples closing one boundary loop, wound the way the loop runs.
 *
 * This is WO-1847's cap (src/mesh/edit/operations/boundaryCap.ts's
 * triangulateRing): project the loop onto its Newell plane; a strictly convex
 * loop fans from its first corner, anything else is ear-clipped. No vertex is
 * added or moved, so the cap welds to the rim exactly and never folds back over
 * itself the way a centroid fan does on a non-convex rim. Unlike an edit's cap
 * there is no flatness refusal here - a repair closes a warped hole in its
 * best-fit plane. Returns null only when the projected loop has no area or
 * crosses itself, i.e. when no set of flat triangles over the rim's own
 * corners can close it; the caller then keeps the old centroid fan.
 */
function capLoop(mesh: MeshBuffers, loop: readonly number[]): Array<[number, number, number]> | null {
  const points = loop.map((index) => vec(mesh, index));
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    normal = add(normal, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]);
  }
  const l = length(normal);
  if (l <= EPS) return null;
  normal = scale(normal, 1 / l);
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = scale(cross(normal, seed), 1 / length(cross(normal, seed)));
  const v = cross(normal, u);
  const flat = points.map((p): [number, number] => [dot(p, u), dot(p, v)]);
  const turn = (a: number, b: number, c: number): number =>
    (flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) - (flat[b][1] - flat[a][1]) * (flat[c][0] - flat[a][0]);

  const n = flat.length;
  let convex = true;
  for (let i = 0; i < n && convex; i++) if (turn((i + n - 1) % n, i, (i + 1) % n) <= 0) convex = false;
  const out: Array<[number, number, number]> = [];
  if (convex) {
    for (let i = 1; i < n - 1; i++) out.push([loop[0], loop[i], loop[i + 1]]);
    return out;
  }

  const remaining = Array.from({ length: n }, (_, i) => i);
  let start = 0;
  while (remaining.length > 3) {
    let clipped = false;
    const m = remaining.length;
    for (let step = 0; step < m; step++) {
      const i = (start + step) % m;
      const previous = remaining[(i + m - 1) % m];
      const current = remaining[i];
      const next = remaining[(i + 1) % m];
      if (turn(previous, current, next) <= 0) continue;
      let blocked = false;
      for (let k = 0; k < m && !blocked; k++) {
        const id = remaining[k];
        if (id === previous || id === current || id === next) continue;
        // Only a reflex corner can sit inside an ear of a simple loop.
        if (turn(remaining[(k + m - 1) % m], id, remaining[(k + 1) % m]) > 0) continue;
        blocked = turn(previous, current, id) >= 0 && turn(current, next, id) >= 0 && turn(next, previous, id) >= 0;
      }
      if (blocked) continue;
      out.push([loop[previous], loop[current], loop[next]]);
      remaining.splice(i, 1);
      start = i === 0 ? 0 : i - 1;
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  out.push([loop[remaining[0]], loop[remaining[1]], loop[remaining[2]]]);
  return out;
}

function centroid(mesh: MeshBuffers, loop: number[]): Vec3 {
  let sum: Vec3 = [0, 0, 0];
  for (const index of loop) sum = add(sum, vec(mesh, index));
  return scale(sum, 1 / loop.length);
}

/** Generalized winding number of `point` against a closed, consistently wound
 *  triangle set (Van Oosterom-Strackee solid angle): +-1 inside, 0 outside. */
function windingNumber(point: Vec3, triangles: Array<[Vec3, Vec3, Vec3]>): number {
  let omega = 0;
  for (const [ta, tb, tc] of triangles) {
    const a = sub(ta, point);
    const b = sub(tb, point);
    const c = sub(tc, point);
    const la = length(a);
    const lb = length(b);
    const lc = length(c);
    const numerator = dot(a, cross(b, c));
    const denominator = la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la;
    omega += 2 * Math.atan2(numerator, denominator);
  }
  return omega / (4 * Math.PI);
}

/**
 * WO-1453: make every shell wind consistently and face the way its nesting says.
 *
 * 1. Propagation: walk each shell (triangles connected across exactly-two-face
 *    edges) and flip a neighbour whenever it winds the same way as the triangle
 *    it was reached from. That makes the shell internally consistent, but which
 *    way it then faces depends only on the seed triangle.
 * 2. Facing, one rule: a closed shell enclosed by an EVEN number of other
 *    closed shells faces outward (positive signed volume); one enclosed by an
 *    ODD number faces inward (a cavity). Enclosure comes from the winding
 *    number of a probe point on the shell against every other closed shell --
 *    geometry, never the shell's own volume sign. A shell with no enclosed
 *    volume to judge (open, or zero volume) keeps the facing most of its
 *    triangles already had.
 *
 * A shell that already winds consistently and obeys the rule comes out
 * untouched. `windingConflictEdgeCount` counts conflicts propagation could not
 * remove: nonzero means the surface is one-sided and cannot be oriented.
 */
export function orientMesh(mesh: MeshBuffers): MeshOrientResult {
  const { edges, goodTriangles } = buildTopology(mesh);
  const triCount = mesh.indices.length / 3;
  const neighbours: Array<Array<{ face: number; conflict: boolean }>> = Array.from({ length: triCount }, () => []);
  const open = new Array<boolean>(triCount).fill(false);
  for (const edge of edges.values()) {
    if (edge.count !== 2) {
      for (const face of edge.faces) open[face] = true;
      continue;
    }
    const [f0, f1] = edge.faces;
    const conflict = edge.dirs[0] === edge.dirs[1];
    neighbours[f0].push({ face: f1, conflict });
    neighbours[f1].push({ face: f0, conflict });
  }

  const flipped = new Array<boolean>(triCount).fill(false);
  const visited = new Array<boolean>(triCount).fill(false);
  const shells: Array<{ tris: number[]; closed: boolean }> = [];
  for (const ref of goodTriangles) {
    if (visited[ref.tri]) continue;
    visited[ref.tri] = true;
    const tris = [ref.tri];
    let closed = !open[ref.tri];
    for (let head = 0; head < tris.length; head++) {
      const cur = tris[head];
      for (const { face, conflict } of neighbours[cur]) {
        if (visited[face]) continue;
        visited[face] = true;
        flipped[face] = flipped[cur] !== conflict;
        if (open[face]) closed = false;
        tris.push(face);
      }
    }
    shells.push({ tris, closed });
  }

  const corners = (t: number): [Vec3, Vec3, Vec3] => {
    const i = t * 3;
    const a = vec(mesh, mesh.indices[i]);
    const b = vec(mesh, mesh.indices[i + 1]);
    const c = vec(mesh, mesh.indices[i + 2]);
    return flipped[t] ? [a, c, b] : [a, b, c];
  };
  const closedShells = shells.filter((shell) => shell.closed).map((shell) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const t of shell.tris) {
      for (const p of corners(t)) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], p[axis]);
          max[axis] = Math.max(max[axis], p[axis]);
        }
      }
    }
    return { shell, min, max };
  });
  const insideBounds = (p: Vec3, min: Vec3, max: Vec3): boolean =>
    p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1] && p[2] >= min[2] && p[2] <= max[2];

  for (const shell of shells) {
    let volume = 0;
    for (const t of shell.tris) volume += triangleVolume(...corners(t));
    let invert: boolean;
    if (shell.closed && Math.abs(volume) > EPS) {
      const [a, b, c] = corners(shell.tris[0]);
      const probe = scale(add(add(a, b), c), 1 / 3);
      let depth = 0;
      for (const other of closedShells) {
        if (other.shell === shell || !insideBounds(probe, other.min, other.max)) continue;
        if (Math.abs(windingNumber(probe, other.shell.tris.map(corners))) > 0.5) depth += 1;
      }
      invert = volume > 0 !== (depth % 2 === 0);
    } else {
      invert = shell.tris.filter((t) => flipped[t]).length * 2 > shell.tris.length;
    }
    if (invert) for (const t of shell.tris) flipped[t] = !flipped[t];
  }

  let windingConflictEdgeCount = 0;
  for (const edge of edges.values()) {
    if (edge.count !== 2) continue;
    const conflict = edge.dirs[0] === edge.dirs[1];
    if (conflict === (flipped[edge.faces[0]] === flipped[edge.faces[1]])) windingConflictEdgeCount += 1;
  }

  const indices = new Uint32Array(mesh.indices);
  let flippedTriangleCount = 0;
  for (let t = 0; t < triCount; t++) {
    if (!flipped[t]) continue;
    const i = t * 3;
    indices[i + 1] = mesh.indices[i + 2];
    indices[i + 2] = mesh.indices[i + 1];
    flippedTriangleCount += 1;
  }
  return { mesh: { positions: mesh.positions, indices }, flippedTriangleCount, windingConflictEdgeCount };
}

/**
 * WO-1907: `options` is the same MeshAnalyzeOptions importStl and every
 * manifold op take, and like theirs it defaults the self-intersection scan OFF:
 * repair closes holes and orients shells, and a caller that wants the crossing
 * verdict on the result asks for it. (It used to always scan, and the lab
 * refused Repair above 3,000 triangles for the cost.)
 */
export function repairMesh(mesh: MeshBuffers, options: MeshAnalyzeOptions = { checkSelfIntersections: false }): MeshRepairResult {
  const cleaned = cleanedMesh(mesh);
  // WO-1911: a duplicate facet makes its edges non-manifold, and a hole's rim
  // cannot be walked across one.
  const base = cancelDuplicateTriangles(cleaned.mesh);
  const positions = Array.from(base.positions);
  const indices = Array.from(base.indices);
  const loops = boundaryLoops(base);

  for (const loop of loops) {
    const cap = capLoop(base, loop);
    if (cap !== null) {
      for (const [a, b, c] of cap) indices.push(a, b, c);
      continue;
    }
    // A loop with no area, or one that crosses itself in its own plane, has no
    // flat cap over its own corners; the centroid fan still closes it.
    const center = centroid(base, loop);
    const centerIndex = positions.length / 3;
    positions.push(center[0], center[1], center[2]);
    for (let i = 0; i < loop.length; i++) indices.push(loop[i], loop[(i + 1) % loop.length], centerIndex);
  }

  // WO-1911: an ear of a cap can land exactly on a facet the rim already runs
  // two edges of, facing the other way (platte-c-broken.stl: two of them). The
  // pair cancels and the cap meets the facet's third edge.
  const filledMesh = cancelDuplicateTriangles({ positions: new Float32Array(positions), indices: new Uint32Array(indices) });
  // WO-1453: filling holes only closes the surface; orient it so every shell
  // winds consistently and faces the way its nesting says.
  const { mesh: repairedMesh, flippedTriangleCount } = orientMesh(filledMesh);
  // BK-17b: single shared topology pass for the bundled {report, measures}.
  const { report, measures } = analyzeAndMeasure(repairedMesh, options);
  return {
    mesh: repairedMesh,
    report,
    measures,
    filledHoleCount: loops.length,
    droppedDegenerateTriangleCount: cleaned.dropped,
    flippedTriangleCount,
  };
}
