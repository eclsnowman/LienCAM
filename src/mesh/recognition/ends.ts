// WO-1846: the two ends of a cylindrical wall, and what is (or is not) in the
// bore between them.
//
// Port of Next's meshCylinderEnds / meshCylinderProjection / meshAxialCorridor.
// This is the part that stops a "cylinder" from being called a HOLE on the
// strength of its wall alone: the wall must close all the way round at both
// ends, both end rings must be flat across the axis, nothing may hang outside
// them, and the bore they enclose must be clear.

import type { Vec3 } from '../types';
import { dot, length, sub } from './types';
import { boundaryCycles, facetPoints, regionBoundaryEdges, vertexAt, type WeldedMesh } from './topology';
import { axialSplit, axisFrame, facetRadialBounds } from './surfaces';

export interface CylinderEnd {
  /** the ring's welded vertex ids, in loop order */
  vertexIds: number[];
  /** station along the axis (the ring is flat within tolerance) */
  stationMm: number;
  /** +1 or -1: which way the ring wraps the axis */
  winding: 1 | -1;
}

export type EndsRefusal =
  | 'axis-clearance'
  | 'unsupported-boundary-topology'
  | 'unsupported-angular-wrap'
  | 'nonplanar-end'
  | 'overlapping-ends'
  | 'axial-overhang';

export type CylinderEnds =
  | { status: 'supported'; ends: [CylinderEnd, CylinderEnd] }
  | { status: 'unsupported'; reason: EndsRefusal };

/**
 * Both end rings of a wall region, low station first.
 *
 * `maxDeviationMm >= radius` is refused up front (Next's 'axis-clearance'):
 * a band that wide does not enclose its own axis, so nothing below it means
 * anything.
 */
export function inspectCylinderEnds(
  w: WeldedMesh,
  facets: readonly number[],
  origin: Vec3,
  axis: Vec3,
  radiusMm: number,
  maxDeviationMm: number,
  toleranceMm: number,
): CylinderEnds {
  if (maxDeviationMm >= radiusMm) return { status: 'unsupported', reason: 'axis-clearance' };
  const region = new Set(facets);
  const cycles = boundaryCycles(regionBoundaryEdges(w, region));
  if (cycles.loops.length !== 2 || cycles.ambiguous.length) {
    return { status: 'unsupported', reason: 'unsupported-boundary-topology' };
  }
  const { u, v } = axisFrame(axis);
  const loops: CylinderEnd[] = [];
  for (const ids of cycles.loops) {
    const points = ids.map((id) => vertexAt(w, id));
    const winding = ringWinding(points, origin, u, v);
    if (winding === null) return { status: 'unsupported', reason: 'unsupported-angular-wrap' };
    const stations = points.map((p) => dot(sub(p, origin), axis));
    const min = Math.min(...stations);
    const max = Math.max(...stations);
    if (max - min > toleranceMm) return { status: 'unsupported', reason: 'nonplanar-end' };
    loops.push({ vertexIds: ids, stationMm: (min + max) / 2, winding });
  }
  loops.sort((a, b) => a.stationMm - b.stationMm);
  if (loops[0].stationMm >= loops[1].stationMm) return { status: 'unsupported', reason: 'overlapping-ends' };

  // Nothing in the wall may stand outside the band its own rings define.
  const low = loops[0].stationMm - toleranceMm;
  const high = loops[1].stationMm + toleranceMm;
  for (const f of facets) {
    for (const p of facetPoints(w, f)) {
      const station = dot(sub(p, origin), axis);
      if (station < low || station > high) return { status: 'unsupported', reason: 'axial-overhang' };
    }
  }
  return { status: 'supported', ends: [loops[0], loops[1]] };
}

/**
 * Does the ring wrap the axis exactly once, turning the same way throughout?
 *
 * Next's cylinderAngularWinding, in float64: every consecutive projected edge
 * must turn in the same strict direction (no doubling back, no zero-length
 * projected edge) and the ray crossings must sum to exactly +/-1. An
 * atan2-accumulation with an epsilon would accept a ring that folds back over
 * itself; this does not.
 */
export function ringWinding(points: readonly Vec3[], origin: Vec3, u: Vec3, v: Vec3): 1 | -1 | null {
  const flat = points.map((p) => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)] as [number, number];
  });
  let direction = 0;
  let winding = 0;
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i];
    const b = flat[(i + 1) % flat.length];
    const turn = Math.sign(a[0] * b[1] - a[1] * b[0]);
    if (turn === 0 || (direction !== 0 && turn !== direction)) return null;
    direction = turn;
    if (a[1] <= 0 && b[1] > 0 && turn > 0) winding++;
    if (a[1] > 0 && b[1] <= 0 && turn < 0) winding--;
  }
  return winding === 1 || winding === -1 ? (winding as 1 | -1) : null;
}

/**
 * Facets that stand inside the bore between the two ends.
 *
 * Next's meshAxialCorridorObstructions: a facet whose axial span only TOUCHES
 * an endpoint is judged against the conservative core radius, one whose span
 * reaches into the bore against the fitted envelope. Whole-triangle radial
 * minima, not vertex samples - a rib spanning the bore can easily put all
 * three of its vertices in the wall while its body crosses the middle. That is
 * exactly the rib case the WO's acceptance asks for, and exactly what the
 * negative control breaks.
 */
export function corridorObstructions(
  w: WeldedMesh,
  origin: Vec3,
  axis: Vec3,
  lowStationMm: number,
  highStationMm: number,
  coreRadiusMm: number,
  envelopeRadiusMm: number,
  excluded: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (let f = 0; f < w.facetCount; f++) {
    if (excluded.has(f) || w.areas[f] === 0) continue;
    const points = facetPoints(w, f);
    const stations = points.map((p) => dot(sub(p, origin), axis));
    if (stations.every((s) => s < lowStationMm) || stations.every((s) => s > highStationMm)) continue;
    const interior = stations.some((s) => s > lowStationMm) && stations.some((s) => s < highStationMm);
    const limit = interior ? envelopeRadiusMm : coreRadiusMm;
    if (facetRadialBounds(points, origin, axis).min < limit) out.push(f);
  }
  return out;
}

/** A facet's distance from a station plane, for the "is this end flat" checks. */
export function facetStationSpan(w: WeldedMesh, facet: number, origin: Vec3, axis: Vec3): { min: number; max: number } {
  const stations = facetPoints(w, facet).map((p) => dot(sub(p, origin), axis));
  return { min: Math.min(...stations), max: Math.max(...stations) };
}

/** Radial distance of a point from the axis. */
export function radialDistance(point: Vec3, origin: Vec3, axis: Vec3): number {
  return length(axialSplit(point, origin, axis).radial);
}
