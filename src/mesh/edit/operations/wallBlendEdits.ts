// WO-2798: change the radius of, or take off, a blend between a flat face and
// a wall standing square to it (`recognition/wallBlends.ts`) - the boss-foot
// fillet, a fillet or chamfer chain round a block's top, a pocket's floor
// fillets.
//
// Both edits are one scale of every band vertex about its own foot on the
// sharp edge: factor r'/r changes the size, factor 0 takes the blend off (its
// facets close up and are dropped, and the face and the wall meet at their
// sharp edge). The face's facets stretch along the face, the wall's along the
// wall, because they already own the rail vertices - the same "move the
// vertices, keep the facets" rebuild the straight-edge edits use
// (`rebuildWithMovedVertices`), which refuses by name if anything beside the
// blend would leave its own plane.
//
// These are reached from `changeBlendRadius` and `restoreSharpEdge` when the
// selection is not WO-1848's straight blend between two faces with two end
// faces, so the journal kinds, the records and the panel are unchanged.

import { analyzeAndMeasure } from '../../analysis';
import type { MeshBuffers, Vec3 } from '../../types';
import { ambiguousTopology, facetNormal, vertexAt, weldMesh, type WeldedMesh } from '../../recognition/topology';
import { cross, dot, length, sub } from '../../recognition/types';
import {
  prepareWallBlendFromBand,
  scaledWallBlendVertex,
  type PreparedWallBlend,
  type WallBlendFrame,
} from '../../recognition/wallBlends';
import { facetCount } from '../idView';
import type { MeshEditApplyResult } from '../types';
import { rebuildWithMovedVertices, type EdgeStation } from './sharpEdgeRestoration';

/** How far a facet beside the blend may end up off its own plane, mm: float32
 *  rounding of a part tens of millimetres across, with room to spare. */
const PLANE_TOLERANCE_MM = 1e-3;

/** The wall blend under `facets`, or null when the selection is not one. */
export function wallBlendOf(mesh: MeshBuffers, facets: readonly number[]): PreparedWallBlend | null {
  const total = facetCount(mesh);
  if (facets.length === 0 || facets.some((f) => !Number.isInteger(f) || f < 0 || f >= total)) return null;
  const w = weldMesh(mesh);
  if (ambiguousTopology(w)) return null;
  try {
    return prepareWallBlendFromBand(w, [...new Set(facets)]);
  } catch {
    return null;
  }
}

/** Every facet that would turn over or close up when the vertices go to
 *  `moved` - a blend grown past the face or the wall it sits on. */
function foldsOver(w: WeldedMesh, moved: ReadonlyMap<number, Vec3>, dropped: ReadonlySet<number>): boolean {
  for (let f = 0; f < w.facetCount; f++) {
    if (dropped.has(f) || w.areas[f] <= 0) continue;
    const ids = [w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]];
    if (!ids.some((id) => moved.has(id))) continue;
    const [a, b, c] = ids.map((id) => moved.get(id) ?? vertexAt(w, id));
    const raw = cross(sub(b, a), sub(c, a));
    const area = length(raw) / 2;
    if (area <= 1e-12) return true;
    if (dot(raw, facetNormal(w, f)) <= 0) return true;
  }
  return false;
}

/** Edges with other than two facets on them, after welding: the open (or
 *  over-full) edges of a part. */
function badEdges(mesh: MeshBuffers): number {
  return weldMesh(mesh).edges.filter((e) => e.facets.length !== 2).length;
}

/** The result has to still be the part it was: no more open edges than it
 *  came in with, and not inside out. Measured on the welded result. */
function proveStillSolid(before: MeshBuffers, after: MeshBuffers, what: string): void {
  const options = { checkSelfIntersections: false };
  const was = analyzeAndMeasure(before, options);
  const now = analyzeAndMeasure(after, options);
  if (badEdges(after) > badEdges(before) || (was.measures.signedVolume > 0 && now.measures.signedVolume <= 0)) {
    throw new Error(`${what} would leave the part open where the blend was, so LienCAM did not do it. Nothing was changed.`);
  }
}

/** Make the wall fillet under `facets` `radiusMm`. Throws a plain sentence. */
export function resizeWallBlend(mesh: MeshBuffers, prepared: PreparedWallBlend, radiusMm: number): MeshEditApplyResult {
  return resizeWallBand(mesh, prepared, radiusMm, 'fillet');
}

/** Equal-leg chamfer uses the same sharp-edge frame, with a linear leg proof. */
export function resizeWallChamfer(mesh: MeshBuffers, prepared: PreparedWallBlend, distanceMm: number): MeshEditApplyResult {
  return resizeWallBand(mesh, prepared, distanceMm, 'chamfer');
}

function resizeWallBand(mesh: MeshBuffers, prepared: PreparedWallBlend, radiusMm: number, kind: 'fillet' | 'chamfer'): MeshEditApplyResult {
  if (prepared.kind !== kind) {
    throw new Error(kind === 'fillet' ? 'This is a flat chamfer, not a round, so it has no radius to change. Nothing was changed.' : 'This is a round, not a chamfer, so it has no chamfer distance to change. Nothing was changed.');
  }
  const from = prepared.sizeMm;
  if (Math.abs(radiusMm - from) <= 1e-9) {
    throw new Error(`This ${kind} is already ${from.toFixed(3)} mm, so there is nothing to change. Nothing was changed.`);
  }
  const factor = radiusMm / from;
  const w = prepared.welded;
  const moved = new Map<number, Vec3>();
  for (const id of prepared.frames.keys()) moved.set(id, scaledWallBlendVertex(prepared, id, factor));
  if (foldsOver(w, moved, new Set())) {
    throw new Error(
      `A ${radiusMm.toFixed(2)} mm ${kind} here would run past the edge of the face or the wall beside ` +
        'it, so the surface would fold through itself. Nothing was changed.',
    );
  }
  const result = rebuildWithMovedVertices(mesh, w, {
    removedFacets: new Set(),
    moved,
    deleted: new Set(),
    reshapedFacets: new Set(prepared.band),
    planeToleranceMm: PLANE_TOLERANCE_MM,
  });
  proveResized(result.mesh, prepared, radiusMm);
  proveStillSolid(mesh, result.mesh, `A ${radiusMm.toFixed(2)} mm ${kind} here`);
  return result;
}

/** Re-measure the band in the OUTPUT: every band vertex, read back from the
 *  rebuilt mesh, on the round of the new radius tangent to the same face and
 *  wall. A proof, not the transform restated. */
function proveResized(after: MeshBuffers, prepared: PreparedWallBlend, radiusMm: number): void {
  const w = prepared.welded;
  // The rebuild drops nothing here, so output facet f corner k is welded
  // vertex w.facets[f * 3 + k].
  if (facetCount(after) !== w.facetCount) {
    throw new Error('Changing this radius did not leave the part with the facets it started with. Nothing was changed.');
  }
  const read = new Map<number, Vec3>();
  for (let corner = 0; corner < w.facetCount * 3; corner++) {
    const id = w.facets[corner];
    if (read.has(id) || !prepared.frames.has(id)) continue;
    const at = after.indices[corner] * 3;
    read.set(id, [after.positions[at], after.positions[at + 1], after.positions[at + 2]]);
  }
  const { normal, offsetMm } = prepared.plane;
  const tolerance = Math.max(0.01, 0.01 * radiusMm) + prepared.maxDeviationMm * Math.max(1, radiusMm / prepared.sizeMm);
  let worst = 0;
  for (const [id, frame] of prepared.frames) {
    const p = read.get(id) as Vec3;
    const station = dot(normal, p) - offsetMm;
    const h = dot(prepared.up, normal) * station;
    const d = length(sub(sub(p, [normal[0] * station, normal[1] * station, normal[2] * station]), frame.foot));
    worst = Math.max(worst, prepared.kind === 'fillet' ? Math.abs(Math.hypot(d - radiusMm, h - radiusMm) - radiusMm) : Math.abs(d + h - radiusMm) / Math.SQRT2);
  }
  if (worst > tolerance) {
    throw new Error(
      `The facets of this ${prepared.kind} do not sit on a ${radiusMm.toFixed(2)} mm ${prepared.kind} after the change - ` +
        `the worst of them is ${worst.toFixed(4)} mm off it. Nothing was changed.`,
    );
  }
}

/** Take the wall blend off: the face and the wall meet at their sharp edge. */
export function removeWallBlend(mesh: MeshBuffers, prepared: PreparedWallBlend): MeshEditApplyResult {
  const w = prepared.welded;
  const removed = new Set(prepared.band);
  if (removed.size >= facetCount(mesh)) {
    throw new Error('Removing this would take away every facet of the part, leaving nothing to cut. Nothing was changed.');
  }
  const moved = new Map<number, Vec3>();
  for (const id of [...prepared.planeRail, ...prepared.wallRail]) moved.set(id, scaledWallBlendVertex(prepared, id, 0));
  if (foldsOver(w, moved, removed)) {
    throw new Error(
      'Giving this edge its sharp corner back would fold the face or the wall beside it through itself. ' +
        'Nothing was changed.',
    );
  }
  const stations = new Map<number, EdgeStation>();
  for (const id of moved.keys()) {
    const f = prepared.frames.get(id) as WallBlendFrame;
    stations.set(id, { loop: f.loop, s: f.s, length: prepared.loopLengthsMm[f.loop] });
  }
  const result = rebuildWithMovedVertices(mesh, w, {
    removedFacets: removed,
    moved,
    deleted: new Set(prepared.interior),
    edgeStations: stations,
    planeToleranceMm: PLANE_TOLERANCE_MM,
  });
  proveStillSolid(mesh, result.mesh, 'Taking this blend off');
  return result;
}
