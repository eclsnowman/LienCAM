// cam3d input pipeline: sanity/repair pass shared by the STL and STEP paths.
//
// Policy (fail loud, warn on repairable):
// - NaN/Inf vertex coordinates  -> ERROR. Garbage geometry must never flow
//   silently into toolpath math where it would surface as a "reasonable
//   looking" but wrong path (this project treats that as a defect).
// - Exactly-degenerate triangles (repeated indices, positionally-coincident
//   corners, or zero area) -> DROPPED, with a counting WARNING. They carry no
//   surface information and break normal/winding math downstream.
// - Non-watertight mesh (some edge not shared by exactly 2 triangles)
//   -> WARNING only. CAM on open meshes is explicitly allowed (heightfield
//   sheets, scanned surfaces); the operator just needs to know.
// - Bounds are ALWAYS recomputed from the actual vertex data, never trusted
//   from the file or the tessellator (PartMesh contract: bounds match the
//   real extents).

import { computeBounds } from '../fixtures/meshBuilder';
import type { PartMesh } from '../kernel/types';

/**
 * Zero-area threshold in mm^2. Vertex data is Float32; a genuinely intended
 * triangle at CAM scale (parts 1..1000 mm, tessellation chords >= microns)
 * has area many orders of magnitude above this. Only numerically collapsed
 * slivers land below it.
 */
const ZERO_AREA_MM2 = 1e-12;

/**
 * Positional welding tolerance in mm. OCCT can emit the same topological
 * corner through separate face tessellations with sub-micron coordinate
 * noise, so edge identity is quantized before manifold checks. This is the
 * same 1e-6 mm rule the modeled-solid Adaptive 3D path historically used.
 */
const POSITION_WELD_SCALE_PER_MM = 1_000_000;

export interface SanitizedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Present iff faceIds were passed in; filtered in lockstep with indices. */
  faceIds?: Uint32Array;
  bounds: PartMesh['bounds'];
  warnings: string[];
  droppedDegenerateTriangles: number;
  /** Edge health before degenerate triangles were removed. */
  watertightBeforeRepair: boolean;
  /** True when every (positionally welded) edge is shared by exactly 2 triangles. */
  watertight: boolean;
  boundaryEdges: number;
  oversharedEdges: number;
}

interface EdgeHealth {
  boundaryEdges: number;
  oversharedEdges: number;
  watertight: boolean;
}

function edgeHealth(edgeUse: ReadonlyMap<string, number>): EdgeHealth {
  let boundaryEdges = 0;
  let oversharedEdges = 0;
  for (const n of edgeUse.values()) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) oversharedEdges++;
  }
  return {
    boundaryEdges,
    oversharedEdges,
    watertight: boundaryEdges === 0 && oversharedEdges === 0,
  };
}

function addEdge(edgeUse: Map<string, number>, p: number, q: number): void {
  // A triangle corner pair that welds to one point is not a geometric edge.
  if (p === q) return;
  const key = p < q ? `${p},${q}` : `${q},${p}`;
  edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
}

/**
 * Validate + repair an indexed triangle mesh. Throws on structural garbage
 * (bad array lengths, out-of-range indices, non-finite coordinates); returns
 * the repaired mesh plus warnings otherwise.
 *
 * The watertight/degeneracy checks operate on POSITIONALLY WELDED vertices
 * (1e-6 mm quantization): STEP tessellation emits per-face vertex blocks that
 * duplicate coordinates along shared face borders, and an STL triangle soup
 * duplicates every vertex, so an index-identity edge check would misreport
 * both as fully open. The tolerance also prevents sub-micron OCCT seam noise
 * from inventing boundary edges.
 */
export function sanitizeTriangleMesh(
  positions: Float32Array,
  indices: Uint32Array,
  faceIds?: Uint32Array,
): SanitizedMesh {
  // --- structural validation (loud) ---
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error(
      `sanitizeTriangleMesh: positions length ${positions.length} is not a positive multiple of 3`,
    );
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error(
      `sanitizeTriangleMesh: indices length ${indices.length} is not a positive multiple of 3`,
    );
  }
  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;
  if (faceIds !== undefined && faceIds.length !== triCount) {
    throw new Error(
      `sanitizeTriangleMesh: faceIds length ${faceIds.length} != triangle count ${triCount}`,
    );
  }
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) {
      throw new Error(
        `sanitizeTriangleMesh: index ${indices[i]} at position ${i} out of range (vertex count ${vertexCount})`,
      );
    }
  }

  // --- non-finite vertex rejection (loud) ---
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      const v = Math.floor(i / 3);
      const axis = 'xyz'[i % 3];
      throw new Error(
        `sanitizeTriangleMesh: non-finite coordinate at vertex ${v} (${axis} = ${positions[i]}); ` +
          `refusing to import geometry containing NaN/Infinity`,
      );
    }
  }

  // --- positional weld map (see doc comment for why) ---
  const weldByKey = new Map<string, number>();
  const weldOf = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const key =
      `${Math.round(positions[v * 3] * POSITION_WELD_SCALE_PER_MM)}|` +
      `${Math.round(positions[v * 3 + 1] * POSITION_WELD_SCALE_PER_MM)}|` +
      `${Math.round(positions[v * 3 + 2] * POSITION_WELD_SCALE_PER_MM)}`;
    const existing = weldByKey.get(key);
    if (existing !== undefined) {
      weldOf[v] = existing;
    } else {
      weldByKey.set(key, v);
      weldOf[v] = v;
    }
  }

  // --- drop exactly-degenerate triangles ---
  const keptIndices: number[] = [];
  const keptFaceIds: number[] = [];
  const edgeUseBeforeRepair = new Map<string, number>();
  let dropped = 0;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    const wa = weldOf[a];
    const wb = weldOf[b];
    const wc = weldOf[c];
    addEdge(edgeUseBeforeRepair, wa, wb);
    addEdge(edgeUseBeforeRepair, wb, wc);
    addEdge(edgeUseBeforeRepair, wc, wa);
    if (a === b || b === c || c === a || wa === wb || wb === wc || wc === wa) {
      dropped++;
      continue;
    }
    // Cross-product area in f64 (inputs are exact f32 values, so this is exact
    // enough to distinguish "collapsed" from "tiny but real").
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(cx, cy, cz);
    if (area < ZERO_AREA_MM2) {
      dropped++;
      continue;
    }
    keptIndices.push(a, b, c);
    if (faceIds !== undefined) keptFaceIds.push(faceIds[t]);
  }

  if (keptIndices.length === 0) {
    throw new Error(
      `sanitizeTriangleMesh: all ${triCount} triangles are degenerate; nothing to import`,
    );
  }

  const warnings: string[] = [];
  if (dropped > 0) {
    warnings.push(
      `Dropped ${dropped} exactly-degenerate triangle${dropped === 1 ? '' : 's'} ` +
        `(repeated or coincident corners / zero area) of ${triCount} total.`,
    );
  }

  // --- edge-manifold (watertight) check over welded vertex ids ---
  // key = "min,max" of the welded endpoint pair; watertight iff every edge
  // is used by exactly 2 kept triangles.
  const edgeUse = new Map<string, number>();
  for (let i = 0; i < keptIndices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const p = weldOf[keptIndices[i + e]];
      const q = weldOf[keptIndices[i + ((e + 1) % 3)]];
      addEdge(edgeUse, p, q);
    }
  }
  const beforeRepair = edgeHealth(edgeUseBeforeRepair);
  const afterRepair = edgeHealth(edgeUse);
  const { boundaryEdges, oversharedEdges, watertight } = afterRepair;
  if (!watertight) {
    warnings.push(
      `Mesh is not watertight: ${boundaryEdges} boundary edge${boundaryEdges === 1 ? '' : 's'} ` +
        `and ${oversharedEdges} edge${oversharedEdges === 1 ? '' : 's'} shared by more than 2 triangles. ` +
        `CAM will proceed, but drop-cutter results near open borders reflect the open geometry.`,
    );
  }

  return {
    positions,
    indices: new Uint32Array(keptIndices),
    faceIds: faceIds !== undefined ? new Uint32Array(keptFaceIds) : undefined,
    // Bounds over ALL vertices in the buffer: dropping a degenerate triangle
    // does not remove its (real, on-surface) vertices from the vertex set.
    bounds: computeBounds(positions),
    warnings,
    droppedDegenerateTriangles: dropped,
    watertightBeforeRepair: beforeRepair.watertight,
    watertight,
    boundaryEdges,
    oversharedEdges,
  };
}
