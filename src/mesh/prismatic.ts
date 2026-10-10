/**
 * MSH-3 — Prismatic mesh -> B-rep converter (mesh side).
 * ==========================================================================
 * Turns an imported prismatic (flat-faced) mesh into the plain-data
 * `PlanarFaceSet` the geom worker's makeSolidFromPlanarFaces (src/geom/worker/
 * prismaticBuild.ts) rebuilds + sews into a real editable B-rep solid.
 *
 * Pipeline (docs/3d-modeling-plan.md WP8.4 / §3.5):
 *   1. weld by position          (raw STL has zero shared-vertex topology)
 *   2. robustness gates          (degenerate / non-watertight -> typed failure;
 *                                 inconsistent or inward winding is re-oriented
 *                                 and noted, only a one-sided surface is refused)
 *   3. smooth-patch segmentation (region grow across edges whose dihedral angle
 *                                 is below the sharp-edge threshold = normal
 *                                 clustering by connectivity)
 *   4. planarity classification  (each patch: fit a plane, measure the max
 *                                 residual; curved patches -> typed REFUSAL
 *                                 naming the region, its triangle share, and a
 *                                 plain-English explanation -- no partial solid)
 *   5. boundary polygon extraction per planar face (oriented outer loop + holes,
 *                                 collinear points collapsed, snapped to plane)
 *   6. deterministic face ordering + per-face confidence report
 *
 * Curved reverse-engineering is explicitly out of scope V1: the converter
 * accepts flat-faced prismatic meshes only. Determinism is
 * a hard requirement: the output is a pure function of the mesh GEOMETRY, never
 * the triangle/vertex input order (regions are connected components; faces,
 * loops, and loop start points are all canonically sorted).
 */
import { analyzeMesh, computeBoundingBox, orientMesh } from './analysis';
import type { MeshBuffers, Vec3 } from './types';
import type { PlanarFaceSet, Vec3 as GeomVec3 } from '../geom/geom-service';

export const DEFAULT_MESH_FEATURE_ANGLE_DEG = 30;
export const DEFAULT_MESH_WELD_TOL_FRACTION = 1e-6;

// ---------- small vector helpers (local; analysis.ts's are private) ----------
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a: Vec3): number { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a: Vec3): Vec3 { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }

/**
 * Symmetric 3x3 eigen decomposition (cyclic Jacobi). Used to fit a best plane
 * to a patch's vertices via the eigenvector of the SMALLEST eigenvalue — the
 * plane-normal estimate that is robust even when the area-weighted triangle
 * normals cancel to zero (a full cylinder/sphere wall), which a naive
 * sum-of-normals fit gets wrong. Returns eigenvalues + column eigenvectors.
 */
function jacobiEigenSym3(m: number[]): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[1], m[4], m[5]],
    [m[2], m[5], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let i = 0; i < 3; i++) {
        const aip = a[i][p], aiq = a[i][q];
        a[i][p] = c * aip - s * aiq;
        a[i][q] = s * aip + c * aiq;
      }
      for (let i = 0; i < 3; i++) {
        const api = a[p][i], aqi = a[q][i];
        a[p][i] = c * api - s * aqi;
        a[q][i] = s * api + c * aqi;
      }
      for (let i = 0; i < 3; i++) {
        const vip = v[i][p], viq = v[i][q];
        v[i][p] = c * vip - s * viq;
        v[i][q] = s * vip + c * viq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]],
    ],
  };
}

// ---------- public result types ----------
export interface PlanarFaceReport {
  faceIndex: number;
  triangleCount: number;
  area: number;
  /** max distance of any face vertex to the fitted plane (model units, mm) */
  planarityResidual: number;
  /** 0..1; 1 = perfectly planar, degrades linearly with residual/tolerance */
  confidence: number;
  normal: Vec3;
  outerVertexCount: number;
  holeCount: number;
}

export interface CurvedRegion {
  triangleCount: number;
  /** fraction of the mesh's triangles this region covers, 0..1 */
  triangleShare: number;
  /** max vertex deviation from the best-fit plane (model units, mm) */
  maxResidual: number;
  /** best-effort shape hint: 'cylinder-like' | 'sphere-like' | 'curved' */
  shapeHint: 'cylinder-like' | 'sphere-like' | 'curved';
  /** plain-English explanation for the user */
  description: string;
}

export interface PrismaticConfidenceReport {
  faceCount: number;
  triangleCount: number;
  faces: PlanarFaceReport[];
  /** worst per-face planarity residual across all faces (model units, mm) */
  maxResidual: number;
  /** lowest per-face confidence across all faces, 0..1 */
  minConfidence: number;
  /** the absolute planarity tolerance used for classification (model units) */
  planarTolerance: number;
}

export type PrismaticConversionResult =
  | {
      ok: true;
      faceSet: PlanarFaceSet;
      report: PrismaticConfidenceReport;
      /** WO-1453: plain lines saying what the conversion did to the mesh
       *  (e.g. re-oriented triangles); empty when it changed nothing. */
      notes: string[];
    }
  | {
      ok: false;
      kind: 'refused-curved';
      curvedRegions: CurvedRegion[];
      message: string;
      /** the planar faces that WERE found (transparency; not emitted as a solid) */
      report: PrismaticConfidenceReport;
    }
  | { ok: false; kind: 'non-watertight'; message: string; boundaryEdgeCount: number; holeCount: number; nonManifoldEdgeCount: number }
  | { ok: false; kind: 'non-orientable'; message: string; windingConflictEdgeCount: number }
  | { ok: false; kind: 'degenerate-input'; message: string; degenerateTriangleCount: number }
  | { ok: false; kind: 'empty'; message: string };

export interface PrismaticOptions {
  /** roots the geom-side stable ids (CNVn:face#i grammar). Default 'CNV1'. */
  convertId?: string;
  /** edges whose dihedral angle exceeds this are FEATURE (sharp) edges that
   *  bound a face; below it, two triangles belong to the same smooth surface.
   *  Default 30deg: keeps a 32-facet sphere/cylinder wall (~11deg facets) as a
   *  single smooth patch so its curvature is caught, while a cube/plate (90deg
   *  feature edges) splits cleanly into faces. */
  smoothAngleDeg?: number;
  /** planarity tolerance as a fraction of the mesh bbox diagonal. Default 1e-3. */
  planarityTolFraction?: number;
  /** absolute floor for the planarity tolerance (model units). Default 1e-6. */
  planarityTolFloor?: number;
  /** boundary vertices whose turn angle is below this are collinear and
   *  collapsed into a straight segment. Default 1deg. */
  collinearAngleDeg?: number;
  /** weld tolerance as a fraction of the bbox diagonal. Default 1e-6. */
  weldTolFraction?: number;
}

// ---------- welding ----------
interface Welded {
  positions: Float32Array;
  indices: Uint32Array;
  /** unique vertex positions as Vec3, parallel to positions/3 */
  verts: Vec3[];
  /** welded triangles (triples of unique-vertex indices) */
  tris: Array<[number, number, number]>;
}

function bboxDiagonal(mesh: MeshBuffers): number {
  const b = computeBoundingBox(mesh);
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
}

/** Merge coincident vertices (quantized to `tol`) and remap triangle indices.
 *  Deterministic: the unique-vertex SET is order-independent; the assigned
 *  indices depend on first-seen order but nothing downstream depends on them
 *  (all output is in model coords, canonically sorted). */
function weld(mesh: MeshBuffers, tol: number): Welded {
  const q = tol > 0 ? tol : 1e-9;
  const keyOf = (x: number, y: number, z: number): string =>
    `${Math.round(x / q)}:${Math.round(y / q)}:${Math.round(z / q)}`;
  const map = new Map<string, number>();
  const verts: Vec3[] = [];
  const remap = new Uint32Array(mesh.positions.length / 3);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const key = keyOf(x, y, z);
    let idx = map.get(key);
    if (idx === undefined) {
      idx = verts.length;
      verts.push([x, y, z]);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const tris: Array<[number, number, number]> = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    tris.push([remap[mesh.indices[t]], remap[mesh.indices[t + 1]], remap[mesh.indices[t + 2]]]);
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { positions[i * 3] = v[0]; positions[i * 3 + 1] = v[1]; positions[i * 3 + 2] = v[2]; });
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => { indices[i * 3] = t[0]; indices[i * 3 + 1] = t[1]; indices[i * 3 + 2] = t[2]; });
  return { positions, indices, verts, tris };
}

// ---------- topology on welded mesh ----------
function edgeKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }

function triNormalArea(w: Welded, tri: [number, number, number]): { normal: Vec3; area: number } {
  const a = w.verts[tri[0]], b = w.verts[tri[1]], c = w.verts[tri[2]];
  const n = cross(sub(b, a), sub(c, a));
  const area = 0.5 * len(n);
  return { normal: normalize(n), area };
}

// ---------- segmentation ----------
interface Patch {
  tris: number[];              // welded-triangle indices
  normal: Vec3;                // area-weighted unit normal
  point: Vec3;                 // area-weighted centroid (a point on the plane)
  area: number;
  residual: number;            // max vertex distance to the fitted plane
}

function buildPatches(w: Welded, smoothCos: number): { patches: Patch[]; triNormals: Vec3[]; triAreas: number[]; edgeToTris: Map<string, number[]> } {
  const triNormals: Vec3[] = new Array(w.tris.length);
  const triAreas: number[] = new Array(w.tris.length);
  const edgeToTris = new Map<string, number[]>();
  for (let t = 0; t < w.tris.length; t++) {
    const { normal, area } = triNormalArea(w, w.tris[t]);
    triNormals[t] = normal;
    triAreas[t] = area;
    const [a, b, c] = w.tris[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = edgeKey(u, v);
      const list = edgeToTris.get(key);
      if (list) list.push(t); else edgeToTris.set(key, [t]);
    }
  }

  // Region grow across SMOOTH edges (dihedral below threshold).
  const patchOf = new Int32Array(w.tris.length).fill(-1);
  const patches: Patch[] = [];
  for (let seed = 0; seed < w.tris.length; seed++) {
    if (patchOf[seed] !== -1) continue;
    const id = patches.length;
    const members: number[] = [];
    const stack = [seed];
    patchOf[seed] = id;
    while (stack.length > 0) {
      const t = stack.pop() as number;
      members.push(t);
      const [a, b, c] = w.tris[t];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
        for (const other of edgeToTris.get(edgeKey(u, v)) ?? []) {
          if (other === t || patchOf[other] !== -1) continue;
          if (dot(triNormals[t], triNormals[other]) >= smoothCos) {
            patchOf[other] = id;
            stack.push(other);
          }
        }
      }
    }
    // Area-weighted normal (for OUTWARD orientation of the emitted plane) +
    // total area. This normal cancels to ~0 on a full curved wall, so it is
    // NOT trusted for the planarity test — only for choosing the sign.
    let nSum: Vec3 = [0, 0, 0];
    let areaSum = 0;
    for (const t of members) {
      nSum = add(nSum, scale(triNormals[t], triAreas[t]));
      areaSum += triAreas[t];
    }
    const areaNormal = normalize(nSum);

    // Robust plane fit: unweighted vertex centroid + covariance; the smallest-
    // eigenvalue eigenvector is the best-fit plane normal even when areaNormal
    // vanishes (cylinder/sphere), and the residual along it is the true
    // planarity deviation.
    const uniqueV = [...new Set<number>(members.flatMap((t) => w.tris[t]))];
    let cx = 0, cy = 0, cz = 0;
    for (const vi of uniqueV) { cx += w.verts[vi][0]; cy += w.verts[vi][1]; cz += w.verts[vi][2]; }
    const point: Vec3 = [cx / uniqueV.length, cy / uniqueV.length, cz / uniqueV.length];
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const vi of uniqueV) {
      const dx = w.verts[vi][0] - point[0], dy = w.verts[vi][1] - point[1], dz = w.verts[vi][2] - point[2];
      cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
      cov[4] += dy * dy; cov[5] += dy * dz; cov[8] += dz * dz;
    }
    cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
    const { values, vectors } = jacobiEigenSym3(cov);
    let minIdx = 0;
    if (values[1] < values[minIdx]) minIdx = 1;
    if (values[2] < values[minIdx]) minIdx = 2;
    let normal = normalize(vectors[minIdx]);
    if (len(areaNormal) > 1e-6 && dot(normal, areaNormal) < 0) normal = scale(normal, -1);

    let residual = 0;
    for (const vi of uniqueV) {
      residual = Math.max(residual, Math.abs(dot(sub(w.verts[vi], point), normal)));
    }
    patches.push({ tris: members, normal, point, area: areaSum, residual });
  }
  return { patches, triNormals, triAreas, edgeToTris };
}

// ---------- curved-region classification ----------
function classifyCurved(w: Welded, patch: Patch, triNormals: Vec3[]): CurvedRegion {
  // Sphere-like: triangle normals point radially from a common center (the
  //   normals span the whole direction sphere -> low mean-normal magnitude).
  // Cylinder-like: normals are perpendicular to a common axis (they span a
  //   great circle -> there is a direction orthogonal to (nearly) all of them).
  const mean = normalize(patch.tris.reduce<Vec3>((acc, t) => add(acc, triNormals[t]), [0, 0, 0]));
  const meanMag = len(patch.tris.reduce<Vec3>((acc, t) => add(acc, triNormals[t]), [0, 0, 0])) / patch.tris.length;
  // Test for an axis: the normal that minimizes max|dot(n_t, axis)|. Approximate
  // by checking each triangle-pair-derived candidate cheaply -> use the smallest
  // singular direction via a coarse covariance eigen check.
  let hint: CurvedRegion['shapeHint'] = 'curved';
  const axisScore = cylinderAxisScore(patch, triNormals);
  if (axisScore < 0.2) hint = 'cylinder-like';
  else if (meanMag < 0.5) hint = 'sphere-like';
  void mean;
  const description =
    hint === 'cylinder-like'
      ? 'a curved (cylindrical) wall that cannot be represented as a flat face'
      : hint === 'sphere-like'
        ? 'a curved (spherical / domed) surface that cannot be represented as a flat face'
        : 'a curved (non-planar) surface that cannot be represented as a flat face';
  return {
    triangleCount: patch.tris.length,
    triangleShare: patch.tris.length / w.tris.length,
    maxResidual: patch.residual,
    shapeHint: hint,
    description,
  };
}

/** Coarse measure of how well the patch's normals lie in a single plane through
 *  the origin (i.e. are perpendicular to one axis = cylindrical). Returns the
 *  smallest eigenvalue fraction of the normal covariance; ~0 => a clear axis. */
function cylinderAxisScore(patch: Patch, triNormals: Vec3[]): number {
  // 3x3 covariance of the unit normals.
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const t of patch.tris) {
    const n = triNormals[t];
    cov[0] += n[0] * n[0]; cov[1] += n[0] * n[1]; cov[2] += n[0] * n[2];
    cov[4] += n[1] * n[1]; cov[5] += n[1] * n[2];
    cov[8] += n[2] * n[2];
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  const k = patch.tris.length || 1;
  for (let i = 0; i < 9; i++) cov[i] /= k;
  // Power-iteration for the smallest eigenvalue is fiddly; use the trace-based
  // bound: smallest eigenvalue <= trace/3. Estimate via the minimum diagonal
  // after rotating is overkill — a cheap proxy: min projected variance along the
  // 3 world axes and the mean normal. Good enough to distinguish a cylinder
  // (one near-zero-variance axis) from a sphere (variance spread all ways).
  const diag = [cov[0], cov[4], cov[8]];
  return Math.min(...diag); // small on the axis of a cylinder
}

// ---------- boundary polygon extraction ----------
/** Ordered oriented loops (arrays of welded-vertex indices) for a planar patch,
 *  built from DIRECTED boundary half-edges so orientation follows the surface
 *  normal (outer CCW, holes CW). */
function patchLoops(w: Welded, patch: Patch, patchOf: Int32Array, edgeToTris: Map<string, number[]>, patchId: number): number[][] {
  // Directed boundary half-edges: a triangle half-edge (u->v) is on the boundary
  // when the undirected edge {u,v} is NOT shared with another triangle in THIS
  // patch (i.e. its other triangle is in a different patch, or it is a mesh
  // boundary edge).
  const next = new Map<number, number[]>(); // start vertex -> [end vertices]
  const usedFrom = new Map<number, number>();
  for (const t of patch.tris) {
    const [a, b, c] = w.tris[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const tris = edgeToTris.get(edgeKey(u, v)) ?? [];
      const interior = tris.some((o) => o !== t && patchOf[o] === patchId);
      if (!interior) {
        const arr = next.get(u); if (arr) arr.push(v); else next.set(u, [v]);
      }
    }
  }
  const loops: number[][] = [];
  const totalHalfEdges = [...next.values()].reduce((s, a) => s + a.length, 0);
  let guard = 0;
  for (const [start, ends] of next) {
    while ((usedFrom.get(start) ?? 0) < ends.length) {
      // begin a loop
      const loop: number[] = [start];
      let cur = start;
      while (guard++ < totalHalfEdges + 4) {
        const outs = next.get(cur) ?? [];
        const used = usedFrom.get(cur) ?? 0;
        if (used >= outs.length) break;
        const nxt = outs[used];
        usedFrom.set(cur, used + 1);
        if (nxt === loop[0]) { cur = nxt; break; }
        loop.push(nxt);
        cur = nxt;
      }
      if (loop.length >= 3) loops.push(loop);
      if (guard > totalHalfEdges + 4) break;
    }
  }
  return loops;
}

/** Signed area of a loop projected onto the plane basis (u,v). */
function signedArea2d(loop2d: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < loop2d.length; i++) {
    const [x0, y0] = loop2d[i];
    const [x1, y1] = loop2d[(i + 1) % loop2d.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** Remove collinear vertices (turn angle below threshold) from a 3D loop. */
function dropCollinear(loop: Vec3[], cosThresh: number): Vec3[] {
  if (loop.length <= 3) return loop;
  const out: Vec3[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const nxt = loop[(i + 1) % n];
    const d0 = normalize(sub(cur, prev));
    const d1 = normalize(sub(nxt, cur));
    // keep the vertex only if the direction actually turns
    if (dot(d0, d1) < cosThresh) out.push(cur);
  }
  return out.length >= 3 ? out : loop;
}

/** Rotate a loop so its lexicographically-smallest point is first (determinism),
 *  preserving orientation. */
function canonicalizeLoop(loop: Vec3[]): Vec3[] {
  let best = 0;
  for (let i = 1; i < loop.length; i++) {
    const a = loop[i], b = loop[best];
    if (a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) < 1e-9 && (a[1] < b[1] - 1e-9 || (Math.abs(a[1] - b[1]) < 1e-9 && a[2] < b[2] - 1e-9)))) best = i;
  }
  return [...loop.slice(best), ...loop.slice(0, best)];
}

function planeBasis(normal: Vec3): { xDir: Vec3; yDir: Vec3 } {
  // Deterministic in-plane X: cross the world axis least aligned with the normal.
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  const world: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const xDir = normalize(cross(normal, world));
  const yDir = normalize(cross(normal, xDir));
  return { xDir, yDir };
}

function toGeomVec(v: Vec3): GeomVec3 { return { x: v[0], y: v[1], z: v[2] }; }

// ---------- entry ----------
export function convertPrismaticMesh(mesh: MeshBuffers, options: PrismaticOptions = {}): PrismaticConversionResult {
  const convertId = options.convertId ?? 'CNV1';
  const smoothCos = Math.cos(((options.smoothAngleDeg ?? DEFAULT_MESH_FEATURE_ANGLE_DEG) * Math.PI) / 180);
  const collinearCos = Math.cos(((options.collinearAngleDeg ?? 1) * Math.PI) / 180);
  const diag = bboxDiagonal(mesh);
  const planarTol = Math.max(options.planarityTolFloor ?? 1e-6, (options.planarityTolFraction ?? 1e-3) * diag);
  const weldTol = (options.weldTolFraction ?? DEFAULT_MESH_WELD_TOL_FRACTION) * diag;

  if (mesh.indices.length < 9) {
    return { ok: false, kind: 'empty', message: 'The mesh has no triangles to convert.' };
  }

  const raw = weld(mesh, weldTol);

  // Robustness gates (criterion 4): degenerate or non-watertight -> typed
  // failure, never a crash or a silently-wrong solid.
  const welded: MeshBuffers = { positions: raw.positions, indices: raw.indices };
  const health = analyzeMesh(welded, { checkSelfIntersections: false });
  if (health.degenerateTriangleCount > 0) {
    return {
      ok: false,
      kind: 'degenerate-input',
      message: `The mesh has ${health.degenerateTriangleCount} degenerate (zero-area or collapsed) triangle(s); clean it before converting.`,
      degenerateTriangleCount: health.degenerateTriangleCount,
    };
  }
  if (health.boundaryEdgeCount > 0 || health.nonManifoldEdgeCount > 0) {
    return {
      ok: false,
      kind: 'non-watertight',
      message: `The mesh is not watertight (${health.boundaryEdgeCount} open edge(s) across ${health.holeCount} hole(s), ${health.nonManifoldEdgeCount} non-manifold edge(s)); a solid cannot be built from it. Repair it first.`,
      boundaryEdgeCount: health.boundaryEdgeCount,
      holeCount: health.holeCount,
      nonManifoldEdgeCount: health.nonManifoldEdgeCount,
    };
  }

  // WO-1453 (LIENCAM rule 11): a closed mesh whose triangles wind
  // inconsistently, or whose shells face the wrong way, is still a solid the
  // software can build -- orient it, continue with the corrected mesh, and say
  // what it did. Only a surface no orientation can make consistent is refused.
  const oriented = orientMesh(welded);
  if (oriented.windingConflictEdgeCount > 0) {
    return {
      ok: false,
      kind: 'non-orientable',
      message: `The mesh cannot be oriented: ${oriented.windingConflictEdgeCount} edge(s) still have both neighbouring triangles winding the same way after re-orienting, so the surface is one-sided with no inside or outside; a solid cannot be built from it.`,
      windingConflictEdgeCount: oriented.windingConflictEdgeCount,
    };
  }
  const notes: string[] = [];
  let w: Welded = raw;
  if (oriented.flippedTriangleCount > 0) {
    const idx = oriented.mesh.indices;
    w = { ...raw, indices: idx, tris: raw.tris.map((_, t) => [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]]) };
    const n = oriented.flippedTriangleCount;
    notes.push(`Edit as model: re-oriented ${n} triangle${n === 1 ? '' : 's'} so the mesh winds consistently`);
  }

  const { patches, triNormals, edgeToTris } = buildPatches(w, smoothCos);
  // patchOf lookup for boundary extraction.
  const patchOf = new Int32Array(w.tris.length).fill(-1);
  patches.forEach((p, id) => { for (const t of p.tris) patchOf[t] = id; });

  // Classify curved vs planar.
  const curvedRegions: CurvedRegion[] = [];
  const planarPatches: Patch[] = [];
  for (const patch of patches) {
    if (patch.residual > planarTol) curvedRegions.push(classifyCurved(w, patch, triNormals));
    else planarPatches.push(patch);
  }

  // Build per-face polygons for the planar patches (needed for both the success
  // faceSet and the transparency report on refusal).
  interface BuiltFace { plane: PlanarFaceSet['faces'][number]['plane']; outer: Vec3[]; holes: Vec3[][]; confidence: number; residual: number; area: number; triCount: number; normal: Vec3; sortKey: number[]; }
  const built: BuiltFace[] = [];
  for (let id = 0; id < patches.length; id++) {
    const patch = patches[id];
    if (patch.residual > planarTol) continue; // curved; skip
    const { xDir, yDir } = planeBasis(patch.normal);
    const project = (v: Vec3): Vec3 => {
      // snap onto the fitted plane
      const d = dot(sub(v, patch.point), patch.normal);
      return sub(v, scale(patch.normal, d));
    };
    const to2d = (v: Vec3): [number, number] => [dot(sub(v, patch.point), xDir), dot(sub(v, patch.point), yDir)];

    const rawLoops = patchLoops(w, patch, patchOf, edgeToTris, id);
    const processed = rawLoops
      .map((loop) => loop.map((vi) => project(w.verts[vi])))
      .map((loop) => canonicalizeLoop(dropCollinear(loop, collinearCos)))
      .filter((loop) => loop.length >= 3);
    if (processed.length === 0) continue;

    // outer = largest |area|; others = holes. Orient outer CCW (+area), holes CW.
    const withArea = processed.map((loop) => ({ loop, area: signedArea2d(loop.map(to2d)) }));
    withArea.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outerRec = withArea[0];
    let outer = outerRec.loop;
    if (outerRec.area < 0) outer = [...outer].reverse();
    outer = canonicalizeLoop(outer);
    const holes: Vec3[][] = [];
    for (let h = 1; h < withArea.length; h++) {
      let hl = withArea[h].loop;
      if (withArea[h].area > 0) hl = [...hl].reverse();
      holes.push(canonicalizeLoop(hl));
    }

    const confidence = Math.max(0, Math.min(1, 1 - patch.residual / planarTol));
    built.push({
      plane: { origin: toGeomVec(project(patch.point)), normal: toGeomVec(patch.normal), xDir: toGeomVec(xDir) },
      outer,
      holes,
      confidence,
      residual: patch.residual,
      area: patch.area,
      triCount: patch.tris.length,
      normal: patch.normal,
      sortKey: [
        round6(patch.normal[0]), round6(patch.normal[1]), round6(patch.normal[2]),
        round6(patch.point[0]), round6(patch.point[1]), round6(patch.point[2]),
      ],
    });
  }

  // Deterministic face ordering.
  built.sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i++) {
      if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i];
    }
    return 0;
  });

  const faceReports: PlanarFaceReport[] = built.map((f, i) => ({
    faceIndex: i,
    triangleCount: f.triCount,
    area: f.area,
    planarityResidual: f.residual,
    confidence: f.confidence,
    normal: f.normal,
    outerVertexCount: f.outer.length,
    holeCount: f.holes.length,
  }));
  const report: PrismaticConfidenceReport = {
    faceCount: faceReports.length,
    triangleCount: w.tris.length,
    faces: faceReports,
    maxResidual: faceReports.reduce((m, f) => Math.max(m, f.planarityResidual), 0),
    minConfidence: faceReports.reduce((m, f) => Math.min(m, f.confidence), 1),
    planarTolerance: planarTol,
  };

  // Curved -> honest refusal, NO partial solid.
  if (curvedRegions.length > 0) {
    curvedRegions.sort((a, b) => b.triangleCount - a.triangleCount);
    const pct = (s: number) => `${(s * 100).toFixed(1)}%`;
    const names = curvedRegions
      .map((r) => `${r.description} (${r.triangleCount} triangles, ${pct(r.triangleShare)} of the mesh)`)
      .join('; ');
    return {
      ok: false,
      kind: 'refused-curved',
      curvedRegions,
      message:
        `This mesh cannot be converted to an editable solid because it contains ${curvedRegions.length} curved region(s): ${names}. ` +
        `Prismatic conversion only supports flat faces in V1; curved regions must be remodeled before conversion.`,
      report,
    };
  }

  if (built.length === 0) {
    return { ok: false, kind: 'empty', message: 'No planar faces could be extracted from the mesh.' };
  }

  const faceSet: PlanarFaceSet = {
    convertId,
    planarTolerance: planarTol,
    faces: built.map((f) => ({
      plane: f.plane,
      outer: f.outer.map(toGeomVec),
      holes: f.holes.map((h) => h.map(toGeomVec)),
      confidence: f.confidence,
    })),
  };
  return { ok: true, faceSet, report, notes };
}

function round6(x: number): number { return Math.round(x * 1e6) / 1e6; }
