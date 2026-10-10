import { analyzeAndMeasure, computeBoundingBox, measureMesh } from './analysis';
import type { ManifoldWasmModule } from './manifoldKernel';
import type {
  MeshBooleanParams,
  MeshBuffers,
  MeshDecimateParams,
  MeshHollowParams,
  MeshMirrorParams,
  MeshOperationResult,
  MeshPlaneCutParams,
  MeshPlaneCutResult,
  MeshTransformParams,
  Vec3,
} from './types';

type ManifoldVec3 = { x: number; y: number; z: number };

interface ManifoldMesh {
  numProp: number;
  numTri: number;
  numVert: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  /** WO-1850: present when the inputs were built with ids (see `MeshIdRun`).
   *  Run `i` covers triangles `runIndex[i]/3 .. runIndex[i+1]/3` and came from
   *  the input whose original id is `runOriginalID[i]`. */
  runIndex?: Uint32Array;
  runOriginalID?: Uint32Array;
  /** WO-1850: length numTri - the input triangle each output triangle is a
   *  piece of, numbered within its run's original mesh. */
  faceID?: Uint32Array;
}

interface ManifoldMeshOptions {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
  tolerance?: number;
  runIndex?: Uint32Array;
  runOriginalID?: Uint32Array;
  faceID?: Uint32Array;
}

interface ManifoldMeshConstructor {
  new (options: ManifoldMeshOptions): ManifoldMesh;
}

interface ManifoldSolid {
  add(other: ManifoldSolid): ManifoldSolid;
  subtract(other: ManifoldSolid): ManifoldSolid;
  intersect(other: ManifoldSolid): ManifoldSolid;
  splitByPlane(normal: ManifoldVec3, originOffset: number): [ManifoldSolid, ManifoldSolid];
  transform(matrix: number[]): ManifoldSolid;
  translate(x: number, y?: number, z?: number): ManifoldSolid;
  rotate(x: number, y?: number, z?: number): ManifoldSolid;
  scale(scale: ManifoldVec3 | number): ManifoldSolid;
  mirror(normal: ManifoldVec3): ManifoldSolid;
  simplify(tolerance?: number): ManifoldSolid;
  minkowskiDifference(other: ManifoldSolid): ManifoldSolid;
  getMesh(): ManifoldMesh;
  status(): unknown;
  /** manifold-3d Manifold instances are embind wasm-backed and MUST be
   *  explicitly released -- there is no GC for the wasm heap. Every solid
   *  this module creates is tracked and released via `mint`/`releaseAllTracked`
   *  below (MSH-2-R1.1). */
  delete(): void;
}

interface ManifoldConstructor {
  new (mesh: ManifoldMesh): ManifoldSolid;
  sphere(radius: number, circularSegments?: number): ManifoldSolid;
  /** the first of `count` fresh original ids, for `Mesh.runOriginalID` */
  reserveIDs(count: number): number;
}

interface ManifoldRuntime {
  Manifold: ManifoldConstructor;
  Mesh: ManifoldMeshConstructor;
}


function cleanNumber(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-12 ? 0 : value;
}

function positionKey(x: number, y: number, z: number): string {
  const q = (value: number) => String(Math.round(cleanNumber(value) * 1e8));
  return q(x) + ':' + q(y) + ':' + q(z);
}

function weldedMesh(mesh: MeshBuffers): MeshBuffers {
  const map = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(mesh.positions.length / 3);

  for (let vertex = 0; vertex < mesh.positions.length / 3; vertex++) {
    const x = cleanNumber(mesh.positions[vertex * 3]);
    const y = cleanNumber(mesh.positions[vertex * 3 + 1]);
    const z = cleanNumber(mesh.positions[vertex * 3 + 2]);
    const key = positionKey(x, y, z);
    let index = map.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      map.set(key, index);
      positions.push(x, y, z);
    }
    remap[vertex] = index;
  }

  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) indices[i] = remap[mesh.indices[i]];
  return { positions: new Float32Array(positions), indices };
}

function canonicalMesh(mesh: MeshBuffers): MeshBuffers {
  return canonicalMeshWithOrder(mesh).mesh;
}

/** `canonicalMesh`, plus the permutation it applied: `order[newTriangle]` is
 *  the index that triangle had on the way in. WO-1850 needs it to carry a
 *  per-triangle ancestry through the canonical sort; `canonicalMesh` above is
 *  this function with the permutation dropped, so the bytes it returns for
 *  every existing caller are unchanged. */
function canonicalMeshWithOrder(mesh: MeshBuffers): { mesh: MeshBuffers; order: Uint32Array } {
  const vertices = [] as Array<{ oldIndex: number; x: number; y: number; z: number }>;
  for (let oldIndex = 0; oldIndex < mesh.positions.length / 3; oldIndex++) {
    vertices.push({
      oldIndex,
      x: cleanNumber(mesh.positions[oldIndex * 3]),
      y: cleanNumber(mesh.positions[oldIndex * 3 + 1]),
      z: cleanNumber(mesh.positions[oldIndex * 3 + 2]),
    });
  }
  vertices.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z || a.oldIndex - b.oldIndex);

  const remap = new Uint32Array(vertices.length);
  const positions = new Float32Array(vertices.length * 3);
  vertices.forEach((vertex, newIndex) => {
    remap[vertex.oldIndex] = newIndex;
    positions[newIndex * 3] = vertex.x;
    positions[newIndex * 3 + 1] = vertex.y;
    positions[newIndex * 3 + 2] = vertex.z;
  });

  // [a, b, c, incoming triangle index]. The sort key is the first three, so
  // the ordering is exactly what it was before the fourth was carried along.
  const triangles = [] as Array<[number, number, number, number]>;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    triangles.push([remap[mesh.indices[i]], remap[mesh.indices[i + 1]], remap[mesh.indices[i + 2]], i / 3]);
  }
  triangles.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const indices = new Uint32Array(triangles.length * 3);
  const order = new Uint32Array(triangles.length);
  triangles.forEach((triangle, tri) => {
    indices[tri * 3] = triangle[0];
    indices[tri * 3 + 1] = triangle[1];
    indices[tri * 3 + 2] = triangle[2];
    order[tri] = triangle[3];
  });
  return { mesh: { positions, indices }, order };
}

function runtime(module: ManifoldWasmModule): ManifoldRuntime {
  if (typeof module.Manifold !== 'function' || typeof module.Mesh !== 'function') {
    throw new Error('manifold-3d runtime is missing Manifold or Mesh constructors');
  }
  return { Manifold: module.Manifold as ManifoldConstructor, Mesh: module.Mesh as ManifoldMeshConstructor };
}

function vector(value: Vec3, label: string): ManifoldVec3 {
  const [x, y, z] = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(label + ' must contain finite numbers');
  }
  return { x, y, z };
}

function validateNonZeroVector(value: Vec3, label: string): ManifoldVec3 {
  const out = vector(value, label);
  if (Math.hypot(out.x, out.y, out.z) <= 0) throw new Error(label + ' must be non-zero');
  return out;
}

function statusText(status: unknown): string {
  if (typeof status === 'object' && status !== null && 'value' in status) return String((status as { value: unknown }).value);
  return String(status);
}

function assertOk(solid: ManifoldSolid, operation: string): void {
  const status = statusText(solid.status());
  if (status !== 'NoError' && status !== '0') throw new Error(operation + ' failed with manifold status ' + status);
}

// --- wasm handle tracking --------------------------------------------------
// manifold-3d Manifold instances are embind wasm-backed and require explicit
// .delete() (there is no GC for wasm heap memory). Every solid this module
// creates -- toManifold's input solid, every boolean/split/transform/mirror/
// simplify/minkowskiDifference result, every Manifold.sphere() helper, and
// every decimateMesh binary-search candidate -- is registered here via
// `mint()` the instant it is created, and every exported op releases the
// WHOLE set in a `finally` block that runs on BOTH the success and the throw
// path (mirrors GEO-1-R1's #transients pattern, src/geom/worker/geom-engine.ts
// applyBoolean). These ops are synchronous and never overlap, so liveHandles
// is guaranteed empty between calls; releaseAllTracked() clearing the whole
// set at the end of every op is therefore safe.
//
// Mesh objects returned by getMesh() (and the Mesh passed into `new
// Manifold(mesh)`) are NOT tracked: verified against manifold-3d@3.5.1 that
// Mesh instances have no .delete() method and hold plain JS typed arrays
// already copied out of wasm memory (confirmed by probing that mesh data
// stays valid and mesh.delete is `undefined` after the source Manifold is
// deleted) -- only the Manifold/CrossSection solids themselves need release.
const liveHandles = new Set<ManifoldSolid>();

function mint<T extends ManifoldSolid>(solid: T): T {
  liveHandles.add(solid);
  return solid;
}

function releaseAllTracked(): void {
  for (const solid of liveHandles) {
    try {
      solid.delete();
    } catch {
      /* already deleted */
    }
  }
  liveHandles.clear();
}

/** TEST HOOK (MSH-2-R1.1): number of manifold-3d wasm solids currently live.
 *  Always 0 between ops -- every exported op below releases every solid it
 *  created in a finally block on BOTH the success and throw paths. The soak
 *  test asserts this returns to its pre-op baseline (0) after every op in a
 *  long-lived worker lifetime. */
export function debugLiveHandleCount(): number {
  return liveHandles.size;
}

function toManifold(module: ManifoldWasmModule, mesh: MeshBuffers): ManifoldSolid {
  const { Manifold, Mesh } = runtime(module);
  if (mesh.positions.length % 3 !== 0) throw new Error('mesh positions length is not divisible by 3');
  if (mesh.indices.length % 3 !== 0) throw new Error('mesh indices length is not divisible by 3');
  const welded = weldedMesh(mesh);
  const manifoldMesh = new Mesh({
    numProp: 3,
    vertProperties: welded.positions,
    triVerts: welded.indices,
  });
  const solid = mint(new Manifold(manifoldMesh));
  assertOk(solid, 'mesh import');
  return solid;
}

function fromManifold(solid: ManifoldSolid, operation: string): MeshBuffers {
  assertOk(solid, operation);
  const mesh = solid.getMesh();
  const indices = new Uint32Array(mesh.triVerts);
  let positions: Float32Array;
  if (mesh.numProp === 3) {
    positions = new Float32Array(mesh.vertProperties.length);
    for (let i = 0; i < mesh.vertProperties.length; i++) positions[i] = cleanNumber(mesh.vertProperties[i]);
  } else {
    positions = new Float32Array(mesh.numVert * 3);
    for (let vertex = 0; vertex < mesh.numVert; vertex++) {
      positions[vertex * 3] = cleanNumber(mesh.vertProperties[vertex * mesh.numProp]);
      positions[vertex * 3 + 1] = cleanNumber(mesh.vertProperties[vertex * mesh.numProp + 1]);
      positions[vertex * 3 + 2] = cleanNumber(mesh.vertProperties[vertex * mesh.numProp + 2]);
    }
  }
  return canonicalMesh({ positions, indices });
}

function operationResult(mesh: MeshBuffers): MeshOperationResult {
  // BK-17b: one shared buildTopology pass instead of analyzeMesh + measureMesh
  // each rebuilding it. Self-intersection stays OFF here (unchanged behavior).
  const { report, measures } = analyzeAndMeasure(mesh, { checkSelfIntersections: false });
  return { mesh, report, measures };
}

function resultFromManifold(solid: ManifoldSolid, operation: string): MeshOperationResult {
  return operationResult(fromManifold(solid, operation));
}

function extent(mesh: MeshBuffers): Vec3 {
  const bbox = computeBoundingBox(mesh);
  return [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
}

function diagonal(mesh: MeshBuffers): number {
  const e = extent(mesh);
  return Math.hypot(e[0], e[1], e[2]);
}

export function booleanMesh(module: ManifoldWasmModule, left: MeshBuffers, right: MeshBuffers, params: MeshBooleanParams): MeshOperationResult {
  try {
    const a = toManifold(module, left);
    const b = toManifold(module, right);
    switch (params.operation) {
      case 'union':
        return resultFromManifold(mint(a.add(b)), 'boolean union');
      case 'difference':
        return resultFromManifold(mint(a.subtract(b)), 'boolean difference');
      case 'intersect':
        return resultFromManifold(mint(a.intersect(b)), 'boolean intersect');
      default:
        // MSH-2-R1.3: fail-loud default branch (mirrors planeCutMesh's keep-mode
        // guard posture below) -- an out-of-union operation must throw, not
        // silently return undefined.
        throw new Error('unsupported boolean operation: ' + String(params.operation));
    }
  } finally {
    releaseAllTracked();
  }
}

// --- WO-1850: a boolean that says where every output triangle came from -----
//
// `booleanMesh` above answers "what shape". A mesh EDIT (ADR-0051 s4.4) also
// has to answer "who became what", because an STL's facet ids are its
// contract with the operator: a facet either descends from a triangle of his
// file or is new geometry this edit added. manifold-3d already tracks that -
// give each input a reserved original id and a per-triangle faceID, and the
// output mesh comes back in RUNS, each run tagged with the original it came
// from, each triangle tagged with the input triangle it is a piece of. Read
// back and verified against manifold-3d 3.5.1 before this was written.
//
// Unique per-triangle faceIDs also switch OFF manifold's coplanar-face
// condensing, which is deliberate: a condensed face would fuse two of the
// operator's triangles into one output triangle with one id, and the other
// id would silently vanish from the ancestry.

/** Where one output triangle came from. */
export const BOOLEAN_TRIANGLE_ADDED = -1;

export interface MeshBooleanAncestryResult {
  result: MeshOperationResult;
  /** length = output triangle count. `leftTriangle[i]` is the index of the
   *  triangle of `left` that output triangle `i` is a piece of, or
   *  `BOOLEAN_TRIANGLE_ADDED` when it is a face the operation introduced
   *  (a wall cut by `right`, a cap, a new intersection facet). */
  leftTriangle: Int32Array;
}

// --- WO-1910: what an operand must be before a boolean can mean anything ----
//
// manifold-3d refuses an operand that is not closed (status NotManifold), but
// it takes an INSIDE-OUT one without a word: a closed mesh whose facets all
// face inward is a perfectly good manifold with negative volume, and adding it
// removes material, subtracting it adds. Nor does it look at the numbers: a
// NaN corner or a flat sheet goes in and a wrong answer comes out. Those are
// the three things checked here, by name, before the kernel is asked anything.

/** Operator-readable reason `mesh` cannot take part in a boolean as `name`
 *  ("the part", "the box"), or null when it can. */
export function booleanOperandProblem(mesh: MeshBuffers, name: string): string | null {
  if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
    return name + ' is not made of whole triangles';
  }
  const triangles = mesh.indices.length / 3;
  if (triangles === 0) return name + ' has no facets';
  const vertices = mesh.positions.length / 3;
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i])) return name + ' has a corner at a coordinate that is not a number';
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let signedVolume = 0;
  for (let tri = 0; tri < triangles; tri++) {
    const corner: number[][] = [];
    for (let c = 0; c < 3; c++) {
      const vertex = mesh.indices[tri * 3 + c];
      if (vertex >= vertices) return name + ' has a facet pointing at a corner it does not have';
      const at = vertex * 3;
      const point = [mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]];
      for (let axis = 0; axis < 3; axis++) {
        if (point[axis] < min[axis]) min[axis] = point[axis];
        if (point[axis] > max[axis]) max[axis] = point[axis];
      }
      corner.push(point);
    }
    const [a, b, c] = corner;
    signedVolume += (a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (size.some((extentOnAxis) => !(extentOnAxis > 0))) return name + ' is flat, so it encloses no volume';
  // float32 corners: anything under a millionth of its own bounding box is
  // arithmetic noise, not a solid.
  const boxVolume = size[0] * size[1] * size[2];
  if (Math.abs(signedVolume) <= boxVolume * 1e-6) return name + ' encloses no volume';
  if (signedVolume < 0) {
    return name + ' is inside-out: its facets face inward, so it would add where it should cut and cut where it should add';
  }
  return null;
}

/** How many separate solids `mesh` is, counted on shared corners - an STL is
 *  a triangle soup, so it is welded by exact position first. */
export function solidShellCount(mesh: MeshBuffers): number {
  if (mesh.indices.length === 0) return 0;
  return measureMesh(weldedMesh(mesh)).componentCount;
}

function withIds(
  module: ManifoldWasmModule,
  mesh: MeshBuffers,
  name: string,
): { solid: ManifoldSolid; id: number } {
  const { Manifold, Mesh } = runtime(module);
  if (mesh.positions.length % 3 !== 0) throw new Error('mesh positions length is not divisible by 3');
  if (mesh.indices.length % 3 !== 0) throw new Error('mesh indices length is not divisible by 3');
  const problem = booleanOperandProblem(mesh, name);
  if (problem) throw new Error('The boolean was not run: ' + problem + '.');
  const welded = weldedMesh(mesh);
  const triangleCount = welded.indices.length / 3;
  const faceID = new Uint32Array(triangleCount);
  for (let tri = 0; tri < triangleCount; tri++) faceID[tri] = tri;
  const id = Manifold.reserveIDs(1);
  const solid = mint(
    new Manifold(
      new Mesh({
        numProp: 3,
        vertProperties: welded.positions,
        triVerts: welded.indices,
        runIndex: new Uint32Array([0, welded.indices.length]),
        runOriginalID: new Uint32Array([id]),
        faceID,
      }),
    ),
  );
  assertOk(solid, 'mesh import');
  return { solid, id };
}

/**
 * `booleanMesh`, plus the per-triangle ancestry back to `left`.
 *
 * `weldedMesh` re-indexes vertices but never reorders or drops a triangle, so
 * a faceID IS an index into `left.indices`. Fail-loud (ADR-0003): when the
 * runtime hands back no run/face ids there is no honest ancestry to report and
 * this throws rather than quietly calling every facet new.
 */
export function booleanMeshWithAncestry(
  module: ManifoldWasmModule,
  left: MeshBuffers,
  right: MeshBuffers,
  params: MeshBooleanParams & { leftName?: string; rightName?: string },
): MeshBooleanAncestryResult {
  try {
    const a = withIds(module, left, params.leftName ?? 'the part');
    const b = withIds(module, right, params.rightName ?? 'the operand');
    let combined: ManifoldSolid;
    switch (params.operation) {
      case 'union': combined = mint(a.solid.add(b.solid)); break;
      case 'difference': combined = mint(a.solid.subtract(b.solid)); break;
      case 'intersect': combined = mint(a.solid.intersect(b.solid)); break;
      default: throw new Error('unsupported boolean operation: ' + String(params.operation));
    }
    const label = 'boolean ' + params.operation + ' with ancestry';
    assertOk(combined, label);
    const raw = combined.getMesh();
    const rawTriangles = raw.triVerts.length / 3;
    const fromLeft = new Int32Array(rawTriangles).fill(BOOLEAN_TRIANGLE_ADDED);
    const { runIndex, runOriginalID, faceID } = raw;
    if (!runIndex || !runOriginalID || !faceID || faceID.length !== rawTriangles) {
      throw new Error(
        label + ' came back without the triangle ids it needs to say what each facet descends from',
      );
    }
    const leftTriangleCount = left.indices.length / 3;
    for (let run = 0; run < runOriginalID.length; run++) {
      if (runOriginalID[run] !== a.id) continue;
      const first = runIndex[run] / 3;
      const last = (run + 1 < runIndex.length ? runIndex[run + 1] : raw.triVerts.length) / 3;
      for (let tri = first; tri < last && tri < rawTriangles; tri++) {
        const source = faceID[tri];
        if (source < leftTriangleCount) fromLeft[tri] = source;
      }
    }

    // Canonicalise exactly as every other op does, and carry the ancestry
    // through the same permutation so it still lines up facet for facet.
    const positions = new Float32Array(raw.numVert * 3);
    for (let vertex = 0; vertex < raw.numVert; vertex++) {
      positions[vertex * 3] = cleanNumber(raw.vertProperties[vertex * raw.numProp]);
      positions[vertex * 3 + 1] = cleanNumber(raw.vertProperties[vertex * raw.numProp + 1]);
      positions[vertex * 3 + 2] = cleanNumber(raw.vertProperties[vertex * raw.numProp + 2]);
    }
    const canonical = canonicalMeshWithOrder({ positions, indices: new Uint32Array(raw.triVerts) });
    const leftTriangle = new Int32Array(canonical.order.length);
    for (let tri = 0; tri < canonical.order.length; tri++) leftTriangle[tri] = fromLeft[canonical.order[tri]];
    return { result: operationResult(canonical.mesh), leftTriangle };
  } finally {
    releaseAllTracked();
  }
}

// --- WO-1850: the module a synchronous consumer can reach -------------------
//
// Every op in this file takes its wasm module as an argument, because every
// caller of them is async and can await the kernel. Replaying an STL's edit
// journal (src/mesh/edit/replay.ts) is not: it is a pure, synchronous function
// that every route calls to get an STL's shape. So the module is primed ONCE,
// by whoever can await it, and read back synchronously here. Nothing else in
// this file touches the slot; passing a module explicitly still works exactly
// as before.

let shared: ManifoldWasmModule | null = null;

/** Hand the kernel to the synchronous consumers, or clear it with null. */
export function setSharedManifoldModule(module: ManifoldWasmModule | null): void {
  shared = module;
}

/** The primed kernel, or null when nothing has primed it yet. */
export function sharedManifoldModule(): ManifoldWasmModule | null {
  return shared;
}

export function planeCutMesh(module: ManifoldWasmModule, mesh: MeshBuffers, params: MeshPlaneCutParams): MeshPlaneCutResult {
  try {
    const normal = validateNonZeroVector(params.normal, 'plane normal');
    if (!Number.isFinite(params.offset)) throw new Error('plane offset must be finite');
    const keep = params.keep ?? 'positive';
    const [positive, negative] = toManifold(module, mesh).splitByPlane(normal, params.offset);
    mint(positive);
    mint(negative);
    if (keep === 'positive') return { positive: resultFromManifold(positive, 'plane cut positive') };
    if (keep === 'negative') return { negative: resultFromManifold(negative, 'plane cut negative') };
    if (keep === 'both') {
      return {
        positive: resultFromManifold(positive, 'plane cut positive'),
        negative: resultFromManifold(negative, 'plane cut negative'),
      };
    }
    throw new Error('unsupported plane cut keep mode: ' + String(keep));
  } finally {
    releaseAllTracked();
  }
}

/**
 * Hollows a mesh by subtracting `outer.minkowskiDifference(sphere(thickness))`
 * from the outer solid (MSH-2-R1.4 documentation, no algorithm change):
 *  - APPROXIMATION: the erosion sphere is a 16-segment faceted polyhedron
 *    (Manifold.sphere(thickness, 16)), not a true sphere, so its facet inradius
 *    is slightly LESS than `thickness` -- the actual wall thickness produced is
 *    marginally THINNER than requested.
 *  - ROUNDING: concave (interior) edges of the outer solid get filleted/rounded
 *    by the erosion rather than held at a uniform offset; this is exact for a
 *    convex outer shape (e.g. the unit-cube acceptance fixture) but only
 *    approximate for non-convex real-world parts.
 *  - PERF: minkowskiDifference is an expensive convolution over the whole
 *    outer solid; it is untested at large (real-world STL) scale here -- only
 *    small fixtures are exercised by the current test suite -- and may be slow
 *    or memory-heavy on large inputs. Callers exposing hollow on large meshes
 *    (e.g. via a future INT-3 UI) should add a size/perf guard before this is
 *    reachable interactively.
 */
export function hollowMesh(module: ManifoldWasmModule, mesh: MeshBuffers, params: MeshHollowParams): MeshOperationResult {
  try {
    const thickness = params.thickness;
    if (!Number.isFinite(thickness) || thickness <= 0) throw new Error('hollow thickness must be positive');
    const ext = extent(mesh);
    const minExtent = Math.min(ext[0], ext[1], ext[2]);
    if (minExtent <= 0) throw new Error('hollow requires non-zero mesh extent on all axes');
    if (thickness >= minExtent / 2) throw new Error('hollow thickness cannot be >= half of the minimum mesh extent');

    const { Manifold } = runtime(module);
    const outer = toManifold(module, mesh);
    const sphere = mint(Manifold.sphere(thickness, 16));
    const inner = mint(outer.minkowskiDifference(sphere));
    return resultFromManifold(mint(outer.subtract(inner)), 'hollow');
  } finally {
    releaseAllTracked();
  }
}

export function mirrorMesh(module: ManifoldWasmModule, mesh: MeshBuffers, params: MeshMirrorParams): MeshOperationResult {
  try {
    const mirrored = mint(toManifold(module, mesh).mirror(validateNonZeroVector(params.normal, 'mirror normal')));
    return resultFromManifold(mirrored, 'mirror');
  } finally {
    releaseAllTracked();
  }
}

export function transformMesh(module: ManifoldWasmModule, mesh: MeshBuffers, params: MeshTransformParams): MeshOperationResult {
  try {
    let solid = toManifold(module, mesh);
    if (params.matrix !== undefined) {
      if (params.matrix.length !== 16 || params.matrix.some((value) => !Number.isFinite(value))) {
        throw new Error('transform matrix must contain 16 finite numbers');
      }
      solid = mint(solid.transform([...params.matrix]));
    }
    if (params.scale !== undefined) {
      if (typeof params.scale === 'number') {
        if (!Number.isFinite(params.scale) || params.scale === 0) throw new Error('transform scale must be finite and non-zero');
        solid = mint(solid.scale(params.scale));
      } else {
        const scale = vector(params.scale, 'transform scale');
        if (scale.x === 0 || scale.y === 0 || scale.z === 0) throw new Error('transform scale components must be non-zero');
        solid = mint(solid.scale(scale));
      }
    }
    if (params.rotateDegrees !== undefined) {
      const rotate = vector(params.rotateDegrees, 'transform rotation');
      solid = mint(solid.rotate(rotate.x, rotate.y, rotate.z));
    }
    if (params.translate !== undefined) {
      const translate = vector(params.translate, 'transform translation');
      solid = mint(solid.translate(translate.x, translate.y, translate.z));
    }
    return resultFromManifold(solid, 'transform');
  } finally {
    releaseAllTracked();
  }
}

function simplifyWithTolerance(solid: ManifoldSolid, tolerance: number): ManifoldSolid {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('decimate tolerance must be non-negative');
  // simplify(0) is a documented no-op that returns the SAME solid instance
  // (already tracked, does not need re-minting); a positive tolerance mints a
  // NEW wasm solid that must be tracked for disposal (MSH-2-R1.1 -- decimate
  // is the worst offender: up to ~22 simplify() candidates per call).
  return tolerance === 0 ? solid : mint(solid.simplify(tolerance));
}

export function decimateMesh(module: ManifoldWasmModule, mesh: MeshBuffers, params: MeshDecimateParams): MeshOperationResult {
  try {
    const solid = toManifold(module, mesh);
    const originalTriangleCount = mesh.indices.length / 3;
    if (params.targetTriangleCount === undefined) {
      const tolerance = params.tolerance ?? params.errorBound;
      if (tolerance === undefined) throw new Error('decimate requires targetTriangleCount, tolerance, or errorBound');
      return resultFromManifold(simplifyWithTolerance(solid, tolerance), 'decimate');
    }

    const target = params.targetTriangleCount;
    if (!Number.isFinite(target) || target <= 0) throw new Error('targetTriangleCount must be positive');
    if (target >= originalTriangleCount) return resultFromManifold(solid, 'decimate');

    const maxTolerance = params.errorBound;
    const meshDiagonal = Math.max(diagonal(mesh), 1);
    let low = 0;
    let high = Math.max(params.tolerance ?? meshDiagonal * 1e-3, 1e-8);
    let best = solid;
    let bestDiff = Math.abs(originalTriangleCount - target);

    // Every candidate() below is a NEW wasm solid (mint()'d inside
    // simplifyWithTolerance) and every candidate.getMesh() is read out and
    // discarded WITHOUT retaining a reference (getMesh() copies to plain JS
    // typed arrays -- verified it needs no disposal, see the liveHandles
    // comment above toManifold). Up to ~22 candidate solids can be created
    // across the two search loops (MSH-2 audit's worst case); all of them,
    // rejected or not, are released by the outer finally below.
    for (let guard = 0; guard < 12; guard++) {
      const candidate = simplifyWithTolerance(solid, high);
      const triangles = candidate.getMesh().numTri;
      const diff = Math.abs(triangles - target);
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
      if (triangles <= target || (maxTolerance !== undefined && high >= maxTolerance)) break;
      low = high;
      high = Math.min(high * 2, meshDiagonal);
      if (maxTolerance !== undefined) high = Math.min(high, maxTolerance);
    }

    for (let i = 0; i < 10; i++) {
      const mid = (low + high) / 2;
      const candidate = simplifyWithTolerance(solid, mid);
      const triangles = candidate.getMesh().numTri;
      const diff = Math.abs(triangles - target);
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
      if (triangles > target) low = mid;
      else high = mid;
    }

    return resultFromManifold(best, 'decimate');
  } finally {
    releaseAllTracked();
  }
}
