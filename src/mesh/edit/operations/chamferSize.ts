// WO-2802: resize an EXISTING equal-distance chamfer, including a whole wall
// chain and its corner cones. Creation remains the boolean-body operation.
// Separate kind: old radius-only records must never reinterpret a chamfer.
import type { MeshBuffers, Vec3 } from '../../types';
import { prepareEdgeBlend } from '../../recognition/edgeBlends';
import { facetNormal, vertexAt } from '../../recognition/topology';
import { dot, sub } from '../../recognition/types';
import { registerMeshEditOperation } from '../registry';
import type { MeshEditApplyResult, MeshEditOperation } from '../types';
import { rebuildWithMovedVertices } from './sharpEdgeRestoration';
import { resizeWallChamfer, wallBlendOf } from './wallBlendEdits';

export const CHANGE_CHAMFER_SIZE_KIND = 'change-chamfer-size';
interface ChamferSizeParameters { distanceMm: number }

export function changeChamferSize(mesh: MeshBuffers, facets: readonly number[], distanceMm: number): MeshEditApplyResult {
  if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
    throw new Error('A chamfer distance must be a finite number greater than zero. Nothing was changed.');
  }
  // The same proven wall frames used by Fillet also describe linear legs.
  const wall = wallBlendOf(mesh, facets);
  if (wall !== null) return resizeWallChamfer(mesh, wall, distanceMm);
  const prepared = prepareEdgeBlend(mesh, facets);
  if (prepared.kind !== 'chamfer') throw new Error('This is a round, not a chamfer. Nothing was changed.');
  const from = prepared.setbackMm[0];
  if (Math.abs(from - prepared.setbackMm[1]) > prepared.faceFlatnessMm) {
    throw new Error('This chamfer has unequal legs; an equal-distance change cannot retain its angle. Nothing was changed.');
  }
  if (Math.abs(distanceMm - from) <= 1e-9) throw new Error('This chamfer already has that distance. Nothing was changed.');
  const scale = distanceMm / from;
  const w = prepared.welded;
  const { origin, direction } = prepared.edgeLine;
  const moved = new Map<number, Vec3>();
  for (const f of prepared.band) for (let c = 0; c < 3; c++) {
    const id = w.facets[f * 3 + c];
    const p = vertexAt(w, id);
    const station = dot(sub(p, origin), direction);
    const foot: Vec3 = [origin[0] + direction[0] * station, origin[1] + direction[1] * station, origin[2] + direction[2] * station];
    moved.set(id, [foot[0] + scale * (p[0] - foot[0]), foot[1] + scale * (p[1] - foot[1]), foot[2] + scale * (p[2] - foot[2])]);
  }
  // Match the existing radius edit's support-room limit before rebuilding.
  for (let i = 0; i < prepared.supports.length; i++) {
    const support = prepared.supports[i];
    const other = prepared.supports[1 - i];
    const rail = prepared.rail[i].map((id) => Math.abs(dot(other.normal, vertexAt(w, id)) - other.offsetMm));
    const wanted = Math.max(...rail) * scale;
    let room = Infinity;
    for (const f of support.facets) for (let c = 0; c < 3; c++) {
      const id = w.facets[f * 3 + c];
      if (!moved.has(id)) room = Math.min(room, Math.abs(dot(other.normal, vertexAt(w, id)) - other.offsetMm));
    }
    if (wanted > room + 1e-6) throw new Error('This chamfer would run past its support face. Nothing was changed.');
  }
  const result = rebuildWithMovedVertices(mesh, w, {
    removedFacets: new Set(), moved, deleted: new Set(), reshapedFacets: new Set(prepared.band), planeToleranceMm: prepared.faceFlatnessMm,
  });
  // Read the new band back: every output vertex must lie on its scaled plane.
  const normal = facetNormal(w, prepared.band[0]);
  const offset = dot(normal, origin) + scale * (dot(normal, vertexAt(w, w.facets[prepared.band[0] * 3])) - dot(normal, origin));
  for (const f of prepared.band) for (let c = 0; c < 3; c++) {
    const at = result.mesh.indices[f * 3 + c] * 3;
    const p: Vec3 = [result.mesh.positions[at], result.mesh.positions[at + 1], result.mesh.positions[at + 2]];
    if (Math.abs(dot(normal, p) - offset) > prepared.faceFlatnessMm * Math.max(1, scale)) {
      throw new Error('The changed chamfer does not lie on its requested plane. Nothing was changed.');
    }
  }
  return result;
}

export function chamferSizeChangeRefusal(mesh: MeshBuffers, facets: readonly number[], distanceMm: number): string | null {
  try { changeChamferSize(mesh, facets, distanceMm); return null; }
  catch (err) { return err instanceof Error ? err.message : String(err); }
}

export const changeChamferSizeOperation: MeshEditOperation<ChamferSizeParameters> = {
  kind: CHANGE_CHAMFER_SIZE_KIND,
  version: 1,
  label: 'Change chamfer distance',
  describe(record) { return `Changed the chamfer to ${Number(record.parameters.distanceMm).toFixed(2)} mm`; },
  validate(parameters) {
    if (Object.keys(parameters).some((key) => key !== 'distanceMm') ||
      typeof parameters.distanceMm !== 'number' || !Number.isFinite(parameters.distanceMm) || parameters.distanceMm <= 0) {
      throw new Error('Change chamfer distance requires only a finite positive distanceMm.');
    }
    return { distanceMm: parameters.distanceMm };
  },
  apply({ mesh, facets, parameters }) { return changeChamferSize(mesh, facets, parameters.distanceMm); },
};
registerMeshEditOperation(changeChamferSizeOperation);
