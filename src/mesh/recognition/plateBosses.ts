// WO-2802: round protrusions seated on a real planar face. A closed circular
// rim bounds ONE connected surface entirely proud of that face. Its complete
// surface must prove a sphere, or a cylinder and cap plus a proved foot blend.
// A dome is a spherical boss: it stays outside the hole/toolpath families.
import type { Vec3 } from '../types';
import { add, cross, dot, length, normalize, scale, sub } from './types';
import { boundaryCycles, facetNormal, facetPoints, regionBoundaryEdges, vertexAt, type WeldedMesh } from './topology';
import { axisFrame, inferCylinder } from './surfaces';
import { faceRegions } from './tangentRim';
import { findWallBlends } from './wallBlends';

export interface PlateBoss {
  facets: number[];
  footFacets?: number[];
  face: readonly number[];
  rim: number[];
  origin: Vec3;
  normal: Vec3;
  radiusMm: number;
  heightMm: number;
  maxDeviationMm: number;
  sphere?: { center: Vec3; radiusMm: number };
}

/** Small least-squares circle fit, in a local frame to retain precision. */
function circle(points: Vec3[], normal: Vec3): { center: Vec3; radius: number } | null {
  const anchor = points[0];
  const { u, v } = axisFrame(normal);
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points) {
    const d = sub(p, anchor), x = dot(d, u), y = dot(d, v);
    const row = [2 * x, 2 * y, 1], rhs = x * x + y * y;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j];
      matrix[i][3] += row[i] * rhs;
    }
  }
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
    [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
    if (Math.abs(matrix[i][i]) < 1e-12) return null;
    const divisor = matrix[i][i];
    for (let j = i; j < 4; j++) matrix[i][j] /= divisor;
    for (let k = 0; k < 3; k++) if (k !== i) {
      const factor = matrix[k][i];
      for (let j = i; j < 4; j++) matrix[k][j] -= factor * matrix[i][j];
    }
  }
  const x = matrix[0][3], y = matrix[1][3];
  const radius = Math.sqrt(matrix[2][3] + x * x + y * y);
  return Number.isFinite(radius) && radius > 0
    ? { center: add(anchor, add(scale(u, x), scale(v, y))), radius } : null;
}

/** Exact nearest distance to a triangle, including its interior. */
function nearestTriangle(center: Vec3, points: Vec3[]): number {
  const n = normalize(cross(sub(points[1], points[0]), sub(points[2], points[0])));
  const signed = dot(sub(center, points[0]), n);
  const projected = sub(center, scale(n, signed));
  if (points.every((p, i) => dot(cross(sub(points[(i + 1) % 3], p), sub(projected, p)), n) >= -1e-10)) return Math.abs(signed);
  return Math.min(...points.map((p, i) => {
    const edge = sub(points[(i + 1) % 3], p);
    const t = Math.max(0, Math.min(1, dot(sub(center, p), edge) / dot(edge, edge)));
    return length(sub(center, add(p, scale(edge, t))));
  }));
}

export function provePlateBosses(w: WeldedMesh, toleranceMm = 0.25): PlateBoss[] {
  const faces = faceRegions(w);
  const across: number[][] = Array.from({ length: w.facetCount }, () => []);
  for (const edge of w.edges) if (edge.facets.length === 2) {
    across[edge.facets[0]].push(edge.facets[1]);
    across[edge.facets[1]].push(edge.facets[0]);
  }
  const blends = findWallBlends(w);
  const found: PlateBoss[] = [];
  faces.regions.forEach((face, index) => {
    if (!faces.isFace(index)) return;
    const normal = faces.normalOf[index];
    const offset = dot(normal, facetPoints(w, face[0])[0]);
    const faceSet = new Set(face);
    const cycles = boundaryCycles(regionBoundaryEdges(w, faceSet));
    if (cycles.ambiguous.length) return;
    for (const rim of cycles.loops) {
      const points = rim.map((id) => vertexAt(w, id));
      const fit = circle(points, normal);
      if (!fit || points.some((p) => Math.abs(length(sub(p, fit.center)) - fit.radius) > toleranceMm)) continue;
      // Reject coarse polygonal rims too: every chord lies in the circle band.
      if (points.some((p, i) => {
        const q = points[(i + 1) % points.length], edge = sub(q, p);
        const t = Math.max(0, Math.min(1, dot(sub(fit.center, p), edge) / dot(edge, edge)));
        return fit.radius - length(sub(add(p, scale(edge, t)), fit.center)) > toleranceMm;
      })) continue;
      const ringSet = new Set(rim);
      const seeds = w.edges.filter((e) => ringSet.has(e.a) && ringSet.has(e.b))
        .flatMap((e) => e.facets.filter((f) => !faceSet.has(f)));
      const region = new Set<number>();
      const queue = [...seeds];
      let bad = false;
      while (queue.length && !bad) {
        const f = queue.pop()!;
        if (region.has(f) || faceSet.has(f)) continue;
        if (w.areas[f] <= 0 || facetPoints(w, f).some((p) => dot(normal, p) < offset - 1e-3)) { bad = true; break; }
        region.add(f);
        for (const next of across[f]) if (!region.has(next) && !faceSet.has(next)) queue.push(next);
      }
      if (bad || !region.size) continue;
      const boundary = boundaryCycles(regionBoundaryEdges(w, region));
      if (boundary.ambiguous.length || boundary.loops.length !== 1 || boundary.loops[0].length !== rim.length ||
        boundary.loops[0].some((id) => !ringSet.has(id))) continue;
      const facets = [...region].sort((a, b) => a - b);
      const vertices = new Set(facets.flatMap((f) => Array.from(w.facets.slice(f * 3, f * 3 + 3))));
      const heightMm = Math.max(...[...vertices].map((id) => dot(sub(vertexAt(w, id), fit.center), normal)));
      if (heightMm <= toleranceMm) continue;
      const common = { facets, face, rim, origin: fit.center, normal, radiusMm: fit.radius, heightMm };
      // A circular sphere section fixes the centre onto this normal. Solve its
      // axial station, then prove the full area and outward normal of each facet.
      let numerator = 0, denominator = 0;
      for (const id of vertices) {
        const d = sub(vertexAt(w, id), fit.center), h = dot(d, normal);
        numerator += h * (dot(d, d) - fit.radius * fit.radius);
        denominator += 2 * h * h;
      }
      const center = add(fit.center, scale(normal, numerator / denominator));
      const radiusMm = Math.hypot(fit.radius, numerator / denominator);
      let deviation = 0;
      const sphere = facets.every((f) => {
        const ps = facetPoints(w, f);
        const max = Math.max(...ps.map((p) => length(sub(p, center))));
        deviation = Math.max(deviation, Math.abs(max - radiusMm), Math.abs(nearestTriangle(center, ps) - radiusMm));
        return deviation <= toleranceMm && dot(facetNormal(w, f), sub(ps[0], center)) > 0;
      });
      if (sphere) { found.push({ ...common, maxDeviationMm: deviation, sphere: { center, radiusMm } }); continue; }
      // Cylinder + flat disk, with an optional concave foot fillet proved by
      // WO-2798. Every facet belongs to one of those three surfaces.
      const blend = blends.find((b) => b.shape === 'concave' && b.kind === 'fillet' &&
        b.planeRail.length === rim.length && b.planeRail.every((id) => ringSet.has(id)) && b.band.every((f) => region.has(f)));
      const band = new Set(blend?.band ?? []);
      const wall = facets.filter((f) => !band.has(f) && Math.abs(dot(facetNormal(w, f), normal)) < 0.01);
      const cap = facets.filter((f) => !band.has(f) && !wall.includes(f));
      if (!wall.length || !cap.length || cap.some((f) => dot(facetNormal(w, f), normal) < 0.9999 ||
        facetPoints(w, f).some((p) => Math.abs(dot(sub(p, fit.center), normal) - heightMm) > 1e-3))) continue;
      const cylinder = inferCylinder(w, wall, toleranceMm, 2);
      if (cylinder.status !== 'candidate' || cylinder.surface.materialSide !== 'outward' ||
        Math.abs(dot(cylinder.surface.axis, normal)) < 0.9999 ||
        length(cross(sub(cylinder.surface.origin, fit.center), normal)) > toleranceMm) continue;
      found.push({ ...common, footFacets: blend?.band, radiusMm: cylinder.surface.radiusMm,
        maxDeviationMm: Math.max(cylinder.inspection.maxDeviationMm, blend?.maxDeviationMm ?? 0) });
    }
  });
  return found;
}
