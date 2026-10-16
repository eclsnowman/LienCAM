// WO-2802: a moved plate intersects a spherical boss instead of dragging the
// dome's tessellation. Clip its existing facets at the new plane, re-triangulate
// that plane with the resulting rim as a hole, and retain every facet's ancestry.
import { ShapeUtils, Vector2 } from 'three';
import { analyzeAndMeasure } from '../../analysis';
import type { MeshBuffers, Vec3 } from '../../types';
import { provePlateBosses } from '../../recognition/plateBosses';
import { axisFrame } from '../../recognition/surfaces';
import { boundaryCycles, facetPoints, vertexAt, weldMesh } from '../../recognition/topology';
import { add, cross, dot, scale, sub } from '../../recognition/types';
import type { MeshEditApplyResult } from '../types';
import { facetSoup } from './boundaryCap';
import { removeRoundFeature } from './removeRoundFeature';

interface SphericalMove { result: MeshEditApplyResult; appliedMm: number; note: string | null }
type Move = (mesh: MeshBuffers, facets: readonly number[], distanceMm: number) => SphericalMove;

export function moveBesideSphericalBoss(
  mesh: MeshBuffers, facets: readonly number[], distanceMm: number, move: Move,
): SphericalMove | null {
  if (!facets.length || !Number.isFinite(distanceMm) || distanceMm === 0) return null;
  const w = weldMesh(mesh), selected = new Set(facets);
  const bosses = provePlateBosses(w).filter((b) => b.sphere && b.face.length === selected.size && b.face.every((f) => selected.has(f)));
  if (!bosses.length) return null;
  // The source STL contains only the cap above this face. Below that plane
  // the continuation is absent; name that limitation rather than stretch it.
  if (distanceMm < 0) throw new Error('This flat face meets a dome whose surface below the original rim is absent from the STL; LienCAM cannot extend that rim inward. Nothing was changed.');
  const normal = bosses[0].normal;
  const removed = new Set(bosses.flatMap((b) => b.facets));
  const base = removeRoundFeature(mesh, [...removed]);
  const originalOfBase = new Map<number, number>();
  base.ancestry.triangles.forEach((outs, source) => outs.forEach((out) => originalOfBase.set(out, source)));
  const baseFace: number[] = [];
  for (let f = 0; f < base.mesh.indices.length / 3; f++) {
    const original = originalOfBase.get(f);
    if (original === undefined || selected.has(original)) baseFace.push(f);
  }
  const movedBase = move(base.mesh, baseFace, distanceMm);
  const shifted = movedBase.result;
  const offset = dot(normal, bosses[0].origin) + movedBase.appliedMm;
  const shiftedFace = new Set(baseFace.flatMap((f) => shifted.ancestry.triangles[f]));
  const originalOfShifted = new Map<number, number>();
  shifted.ancestry.triangles.forEach((outs, source) => {
    const original = originalOfBase.get(source);
    if (original !== undefined) outs.forEach((out) => originalOfShifted.set(out, original));
  });
  const sw = weldMesh(shifted.mesh);
  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  const owners: number[] = [];
  for (let f = 0; f < sw.facetCount; f++) if (!shiftedFace.has(f)) {
    triangles.push(facetPoints(sw, f)); owners.push(originalOfShifted.get(f) ?? -1);
  }
  for (const f of removed) {
    // Sutherland-Hodgman on a triangle, preserving its winding. The same
    // shared edge yields the same float32 intersection on both incident facets.
    const input = facetPoints(w, f);
    const polygon: Vec3[] = [];
    for (let i = 0; i < 3; i++) {
      const a = input[i], b = input[(i + 1) % 3];
      const da = dot(normal, a) - offset, db = dot(normal, b) - offset;
      if (da >= 0) polygon.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        polygon.push(add(a, scale(sub(b, a), t)));
      }
    }
    for (let i = 1; i + 1 < polygon.length; i++) {
      triangles.push([polygon[0], polygon[i], polygon[i + 1]]); owners.push(f);
    }
  }
  const open = weldMesh(facetSoup(triangles));
  const boundary = boundaryCycles(open.edges.filter((e) => e.facets.length === 1).map((e) => [e.a, e.b]));
  if (boundary.ambiguous.length || !boundary.loops.length) throw new Error('LienCAM cannot close the moved flat face at its spherical rim. Nothing was changed.');
  const { u, v } = axisFrame(normal);
  const loops = boundary.loops.map((loop) => loop.map((id) => vertexAt(open, id)));
  if (loops.some((loop) => loop.some((p) => Math.abs(dot(normal, p) - offset) > 1e-3))) {
    throw new Error('The moved flat face leaves a rim outside its plane. Nothing was changed.');
  }
  const area = (loop: Vec3[]) => loop.reduce((sum, p, i) => sum + dot(cross(p, loop[(i + 1) % loop.length]), normal), 0);
  loops.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  if (area(loops[0]) < 0) loops[0].reverse();
  for (const hole of loops.slice(1)) if (area(hole) > 0) hole.reverse();
  const flat = (loop: Vec3[]) => loop.map((p) => new Vector2(dot(p, u), dot(p, v)));
  const points = loops.flat();
  for (const ids of ShapeUtils.triangulateShape(flat(loops[0]), loops.slice(1).map(flat))) {
    const corners = ids.map((id) => points[id]) as [Vec3, Vec3, Vec3];
    if (dot(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])), normal) < 0) [corners[1], corners[2]] = [corners[2], corners[1]];
    // This is the selected face retessellated at its new rim, not a new
    // removal cap. Carry one of that face's input identities to every output
    // triangle so Model picking selects the complete plane after replay.
    // Removed dome triangles still map to nothing; their ids must not claim
    // any of this plane (round features have picking precedence).
    triangles.push(corners); owners.push(facets[0]);
  }
  const result = facetSoup(triangles);
  const health = (m: MeshBuffers) => {
    const welded = weldMesh(m);
    return analyzeAndMeasure({ positions: new Float32Array(welded.positions), indices: new Uint32Array(welded.facets) }, { checkSelfIntersections: false });
  };
  const was = health(mesh);
  const now = health(result);
  if (!now.report.watertight || now.report.windingConflictEdgeCount > 0 || now.measures.signedVolume <= 0 || now.measures.componentCount > was.measures.componentCount) {
    throw new Error('LienCAM cannot close the moved flat face at its spherical rim into one solid. Nothing was changed.');
  }
  const ancestry = {
    triangles: Array.from({ length: w.facetCount }, () => [] as number[]),
    vertices: Array.from({ length: mesh.positions.length / 3 }, () => [] as number[]),
  };
  owners.forEach((source, out) => {
    if (source < 0) return;
    ancestry.triangles[source].push(out);
    for (let c = 0; c < 3; c++) ancestry.vertices[mesh.indices[source * 3 + c]].push(out * 3 + c);
  });
  return { result: { mesh: result, ancestry }, appliedMm: movedBase.appliedMm, note: movedBase.note };
}
