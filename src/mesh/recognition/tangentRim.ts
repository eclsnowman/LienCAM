// WO-2798: does the surface across a flat region's smooth rim LEAVE it
// tangentially (a fillet or a tangent wall running off a real face), or is the
// region only one chord of a curved surface?
//
// WO-1854's rim rule (flatFaces.ts) refused every flat region with one
// smoothly-continuing rim edge, so the plate top beside a filleted boss, the
// top inside a fillet chain and a pocket floor with floor fillets were never
// offered (audit cells SPP-2/4/8). The software can tell the two apart, so it
// does (LIENCAM.md rule 11).
//
// THE TEST, per smooth rim edge. Seen in the plane across the edge, the
// surface beyond it is a run of chords. A blend starts AT the rim with the
// face's own slope, so its first chord leans half its own turn off the face;
// a chord of a curved surface has the surface's tangent half the region's own
// turn off it. Measure the first chord's lean (phi1), the next chord's lean
// (phi2) and both widths, read the turning rate kappa from them, and run the
// curve back to the rim: tau = phi1 - kappa * w1 / 2 is the slope the surface
// had AT the rim. Tangent: tau ~ 0. Chord of a curve: tau ~ phi1 / 2. Scale
// free - the ratio |tau| / |phi1| does not care how fine the STL is.
//
// A region is a face when most of its smooth rim (by length) passes. Every
// strip of a tessellated bore, fillet or round corner fails (ratio 0.5, or
// its neighbour is wider than it is); the real faces of the WO-2757 parts
// pass at a median ratio of 0.00..0.21.

import type { Vec3 } from '../types';
import { cross, dot, normalize, sub } from './types';
import { buildAdjacency, facetNormal, planarRegions, vertexAt, type WeldedMesh } from './topology';

/** |tau| / |phi1| at or under this is a tangent start. Chords of a curve read
 *  0.5; the real faces of the audit parts read 0.00..0.21 at the median. */
const TANGENT_RATIO = 0.3;

/** Share of the smooth rim (by length) that must leave tangentially. */
const TANGENT_SHARE = 0.75;

/** A region of planar facets and its area-weighted plane, as `planarRegions`
 *  grows them. */
export interface PlanarRegionIndex {
  regions: readonly (readonly number[])[];
  regionOf: Int32Array;
  normalOf: readonly Vec3[];
}

export function indexPlanarRegions(w: WeldedMesh, regions: readonly (readonly number[])[]): PlanarRegionIndex {
  const regionOf = new Int32Array(w.facetCount).fill(-1);
  const normalOf: Vec3[] = [];
  regions.forEach((facets, index) => {
    const n: Vec3 = [0, 0, 0];
    for (const f of facets) {
      regionOf[f] = index;
      const fn = facetNormal(w, f);
      for (let k = 0; k < 3; k++) n[k] += fn[k] * w.areas[f];
    }
    normalOf.push(normalize(n));
  });
  return { regions, regionOf, normalOf };
}

function distanceFromLine(p: Vec3, origin: Vec3, along: Vec3): number {
  const d = sub(p, origin);
  const s = dot(d, along);
  return Math.hypot(d[0] - s * along[0], d[1] - s * along[1], d[2] - s * along[2]);
}

/** The widest a facet set reaches from a line, stopping as soon as it passes
 *  `cap` (the caller only asks "wider than this?"). */
function widthFrom(w: WeldedMesh, facets: readonly number[], origin: Vec3, along: Vec3, cap: number): number {
  let widest = 0;
  for (const f of facets) {
    for (let k = 0; k < 3; k++) {
      widest = Math.max(widest, distanceFromLine(vertexAt(w, w.facets[f * 3 + k]), origin, along));
      if (widest > cap) return widest;
    }
  }
  return widest;
}

/**
 * |tau| / |phi1| for one smooth rim edge of `region` (see the file comment),
 * or Infinity when the surface beyond is no narrower than the region itself
 * (then the REGION is the strip and the neighbour the face) or has no next
 * chord to read a turn from.
 */
function rimTangentRatio(
  w: WeldedMesh,
  index: PlanarRegionIndex,
  region: readonly number[],
  inside: ReadonlySet<number>,
  normal: Vec3,
  edge: { a: number; b: number },
  outsideFacet: number,
): number {
  const a = vertexAt(w, edge.a);
  const b = vertexAt(w, edge.b);
  const t = normalize(sub(b, a));
  const corners = [0, 1, 2].map((k) => vertexAt(w, w.facets[outsideFacet * 3 + k]));
  const centre: Vec3 = [0, 1, 2].map((i) => (corners[0][i] + corners[1][i] + corners[2][i]) / 3) as Vec3;
  let u = normalize(cross(normal, t));
  if (dot(u, sub(centre, a)) < 0) u = [-u[0], -u[1], -u[2]];
  const lean = (n: Vec3) => Math.atan2(dot(n, u), dot(n, normal));

  const firstIndex = index.regionOf[outsideFacet];
  if (firstIndex < 0) return Infinity;
  const first = index.regions[firstIndex];
  const phi1 = lean(index.normalOf[firstIndex]);
  const w1 = widthFrom(w, first, a, t, Infinity);
  if (!(w1 > 0) || widthFrom(w, region, a, t, w1) <= w1) return Infinity;

  // The first chord's far edge nearest this rim edge, and the chord past it.
  const firstSet = new Set(first);
  const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let best: { origin: Vec3; next: number; along: number } | null = null;
  for (const f of first) {
    for (let k = 0; k < 3; k++) {
      const e = w.edges[w.facetEdges[f * 3 + k]];
      if (e.facets.length !== 2) continue;
      const next = e.facets.find((x) => !firstSet.has(x));
      if (next === undefined || inside.has(next)) continue;
      const pa = vertexAt(w, e.a);
      const pb = vertexAt(w, e.b);
      if (Math.abs(dot(normalize(sub(pb, pa)), t)) < 0.9) continue;
      const m: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      if (distanceFromLine(m, a, t) < 0.5 * w1) continue;
      const along = Math.abs(dot(sub(m, mid), t));
      if (best === null || along < best.along) best = { origin: pa, next, along };
    }
  }
  if (best === null) return Infinity;
  const secondIndex = index.regionOf[best.next];
  if (secondIndex < 0) return Infinity;
  const phi2 = lean(index.normalOf[secondIndex]);
  // A neighbour much wider than a chord is the face the blend ends on: its
  // plane IS the end tangent, so it counts with no width of its own.
  let w2 = widthFrom(w, index.regions[secondIndex], best.origin, t, 3 * w1);
  if (w2 > 3 * w1) w2 = 0;
  const kappa = (phi2 - phi1) / ((w1 + w2) / 2);
  const tau = phi1 - (kappa * w1) / 2;
  return Math.abs(tau) / Math.max(Math.abs(phi1), 1e-12);
}

/**
 * Does the surface across `region`'s smooth rim leave it tangentially along
 * most of that rim's length? `smooth` is the loose adjacency the rim rule
 * reads (facets within the smooth slope of each other).
 */
export function smoothRimLeavesTangentially(
  w: WeldedMesh,
  index: PlanarRegionIndex,
  region: readonly number[],
  normal: Vec3,
  smooth: ReadonlyArray<readonly number[]>,
): boolean {
  const inside = new Set(region);
  let total = 0;
  let tangent = 0;
  for (const f of region) {
    for (let k = 0; k < 3; k++) {
      const e = w.edges[w.facetEdges[f * 3 + k]];
      if (e.facets.length !== 2) continue;
      const outside = e.facets.find((x) => !inside.has(x));
      if (outside === undefined || !smooth[f].includes(outside)) continue;
      const len = Math.hypot(...sub(vertexAt(w, e.b), vertexAt(w, e.a)));
      total += len;
      if (rimTangentRatio(w, index, region, inside, normal, e, outside) <= TANGENT_RATIO) tangent += len;
    }
  }
  return total > 0 && tangent >= TANGENT_SHARE * total;
}

/** The flatness budgets a flat face is grown with (`DEFAULT_FLAT_FACE_OPTIONS`
 *  in flatFaces.ts: planarity, flatness slope, smooth slope, minimum area),
 *  stated here so an edit can ask "is this a face?" without that file's door. */
const FACE_PLANARITY_MM = 0.05;
const FACE_FLATNESS_SLOPE = 0.01;
const FACE_SMOOTH_SLOPE = 0.5;
const FACE_MIN_AREA_MM2 = 1;

/** Every planar region of a mesh, and which of them are real FACES - the ones
 *  `recognizeFlatFaces` offers: big enough, and either sharp all round or
 *  running tangent into what is beside them. Everything else is a chord of
 *  something curved. Answers are worked out on first ask. */
export interface FaceRegions extends PlanarRegionIndex {
  smooth: number[][];
  isFace(region: number): boolean;
}

export function faceRegions(w: WeldedMesh): FaceRegions {
  const regions = planarRegions(w, FACE_PLANARITY_MM, FACE_FLATNESS_SLOPE);
  const index = indexPlanarRegions(w, regions);
  const { smooth } = buildAdjacency(w, FACE_SMOOTH_SLOPE);
  const known = new Map<number, boolean>();
  const isFace = (region: number): boolean => {
    if (region < 0) return false;
    let answer = known.get(region);
    if (answer === undefined) {
      const facets = regions[region];
      const inside = new Set(facets);
      const area = facets.reduce((sum, f) => sum + w.areas[f], 0);
      const smoothRim = facets.some((f) => smooth[f].some((next) => !inside.has(next)));
      answer = area >= FACE_MIN_AREA_MM2 &&
        (!smoothRim || smoothRimLeavesTangentially(w, index, facets, index.normalOf[region], smooth));
      known.set(region, answer);
    }
    return answer;
  };
  return { ...index, smooth, isFace };
}
