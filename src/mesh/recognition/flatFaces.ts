// WO-1854: the FLAT FACES an imported STL proves, and the shape of a picked one.
//
// WO-1846 answers "what round features does this part contain?". This file
// answers the other half of the same question: "which parts of this part are
// FLAT?" - a pocket floor, the top face, a step, a boss top, a flank. A picked
// flat face is how an operator says "this face" to an operation that wants one
// (WO-1849 push/pull, WO-1851's pocket floors).
//
// The capability it stands on already existed, unexposed: `planarRegions` in
// topology.ts (Next's recognizeMeshPlanarRegions) groups facets by smooth
// adjacency AND flatness against an anchor plane. What was missing is a named
// result, an OUTLINE, and a frame a caller can use. This file adds those three
// and nothing else.
//
// WHY A PLANAR REGION IS NOT YET A FACE. Run `planarRegions` alone on a plate
// with a 64-sided bore in it and the bore's WALL comes back as a fistful of
// "flat" regions: each neighbouring wall quad is only 5.6 degrees off the last,
// so an arc of ~8 quads (28 mm^2) stays inside any sane plane tolerance. Those
// are not faces, they are pieces of a cylinder. The discriminator is the RIM:
//   - a face is grown with a TIGHT normal agreement (`flatnessSlope`), so every
//     facet in it genuinely faces the same way; and
//   - every facet across its rim must be SHARPLY turned away from it
//     (`smoothSlope`, WO-1846's own 26.6-degree region-growing angle). One
//     smoothly-continuing rim edge means the region is a patch of a curved
//     surface, and it is not offered - UNLESS (WO-2798) the surface across
//     that rim leaves it tangentially: the plate top beside a filleted boss,
//     the top inside a fillet chain, a pocket floor with floor fillets. Those
//     are faces, and `tangentRim.ts` tells them from a chord of a curve.
// KNOWN LIMIT, stated rather than hidden (same shape as WO-1846's chamfer
// limit): a real flat face whose neighbour leaves it at less than 26.6 degrees
// - a shallow draft - reads as "still the same smooth surface" and is not
// listed. `smoothSlope` is an option so a caller can tighten it deliberately.
//
// RULE 11. This file REFUSES NOTHING. There is no facet ceiling, no "mesh too
// complex", no message telling the operator to simplify or re-export his file.
// A region that cannot be resolved into a closed outline is simply not in the
// list; `skipped` records why for a console diagnostic, never for the operator.
// An empty list is an answer.
//
// THE FRAME. Every coordinate that leaves this file is RECENTRED - the frame
// CNCViewport.addSTL puts an imported STL in, which is the frame the edge
// chains and WO-1851's targets already live in. `meshRecenterShift` is
// imported from `./toolpathTargets` rather than restated here: that file
// states the mirror once and explains why, and a fourth copy of
// `(-(minX+maxX)/2, -(minY+maxY)/2, -minZ)` is exactly how the two frames
// would eventually drift apart. (That import closes a cycle through `./index`,
// which re-exports this file per the WO-1854 door decision. It is safe: no
// module in the cycle CALLS across it at load time, only declares.)

import type { MeshBuffers, Vec3 } from '../types';
import { NO_SOURCE_FACET } from '../edit/idView';
import { cross, dot, normalize, sub } from './types';
import {
  ambiguousTopology,
  boundaryCycles,
  buildAdjacency,
  facetNormal,
  facetPoints,
  planarRegions,
  regionBoundaryEdges,
  vertexAt,
  weldMesh,
  type WeldedMesh,
} from './topology';
import { meshRecenterShift } from './toolpathTargets';
import { indexPlanarRegions, smoothRimLeavesTangentially } from './tangentRim';

export interface FlatFaceOptions {
  /**
   * How far a facet may sit off the face's plane and still belong to it, mm.
   * This is a FLATNESS budget for a face, not WO-1846's chord budget for a
   * tessellated bore - a face that bows by a quarter of a millimetre is not
   * flat. Default 0.05 mm.
   */
  planarityMm?: number;
  /**
   * Region growing: two adjacent facets are the same FACE when the tangent of
   * the angle between their normals is <= this. Default 0.01 (0.57 degrees) -
   * tight enough that a finely tessellated curve never grows into a face,
   * loose enough to absorb the normal noise of a float32 STL.
   */
  flatnessSlope?: number;
  /**
   * Rim test: a facet across the rim that agrees with the face to within this
   * tangent is the SAME SMOOTH SURFACE continuing, so the region is a patch of
   * something curved and is not a face. Default 0.5 (26.6 degrees), WO-1846's
   * own region-growing angle, so both halves of the recogniser draw the line
   * between "one surface" and "two" in exactly the same place.
   */
  smoothSlope?: number;
  /** A face smaller than this is not worth listing, mm^2. Default 1. */
  minAreaMm2?: number;
}

export const DEFAULT_FLAT_FACE_OPTIONS: Required<FlatFaceOptions> = {
  planarityMm: 0.05,
  flatnessSlope: 0.01,
  smoothSlope: 0.5,
  minAreaMm2: 1,
};

/** Where a face is and which way it looks, in the RECENTRED local frame. */
export interface FlatFacePlane {
  /** a point ON the face: its area-weighted centroid */
  point: Vec3;
  /** unit outward normal (the direction the material is NOT) */
  normal: Vec3;
}

/** The face's boundary, in the RECENTRED local frame, on its own plane.
 *  `outer` runs counter-clockwise seen from along +normal; every `inner` loop
 *  (a hole through the face) runs clockwise, so the signed areas add up. */
export interface FlatFaceOutline {
  outer: Vec3[];
  inner: Vec3[][];
}

export interface RecognizedFlatFace {
  /** stable within one query result: `flat-${smallest source facet id}` */
  id: string;
  plane: FlatFacePlane;
  outline: FlatFaceOutline;
  /** the measured truth: the summed area of the face's own facets, mm^2 */
  areaMm2: number;
  /** the same area computed the other way, from the OUTLINE: outer loop minus
   *  every hole. Reported beside `areaMm2` so a caller (and a test) can see the
   *  two independent measurements agree instead of being told they do. */
  outlineAreaMm2: number;
  /** worst distance from any vertex of the face to `plane`. The flatness error,
   *  measured, never folded into anything else. */
  maxDeviationMm: number;
  facetCount: number;
  /** WO-1845 source-facet ids of the face, ascending. Selecting the face
   *  highlights exactly these. */
  sourceFacetIds: number[];
}

/** A planar region the pass looked at and did not offer. A DIAGNOSTIC, for the
 *  console - never a message to the operator and never a refusal. */
export interface FlatFaceSkip {
  reason: 'curved-surface' | 'below-minimum-area' | 'outline-not-closed';
  facetCount: number;
  areaMm2: number;
}

export interface FlatFaceRecognition {
  /** largest face first; ties broken by id, so the order is deterministic */
  faces: RecognizedFlatFace[];
  skipped: FlatFaceSkip[];
  /** the flatness budget actually used, echoed so a report can state it */
  planarityMm: number;
  /** facets the query examined (the whole mesh) */
  facetCount: number;
}

/**
 * The 2D basis of a face's plane: `x` and `y` are unit, perpendicular, and
 * `cross(x, y) === normal`, so a point's (u, v) are `dot(p - point, x)` and
 * `dot(p - point, y)`.
 *
 * Exported because the store projects the same outline into a `Layer2D`, and
 * the projection has to agree with the signed areas this file reports. A
 * horizontal face keeps the world X and Y axes so the common case reads as
 * plain part coordinates rather than an arbitrary rotation of them.
 */
export function flatFacePlaneBasis(normal: Vec3): { x: Vec3; y: Vec3 } {
  const n = normalize(normal);
  const x: Vec3 = Math.abs(n[2]) > 1 - 1e-9 ? [1, 0, 0] : normalize(cross([0, 0, 1], n));
  return { x, y: cross(n, x) };
}

/** Signed area of a closed loop on the plane, positive when it runs
 *  counter-clockwise seen from along +normal. */
function signedLoopArea(loop: readonly Vec3[], origin: Vec3, basis: { x: Vec3; y: Vec3 }): number {
  let sum = 0;
  for (let k = 0; k < loop.length; k++) {
    const a = sub(loop[k], origin);
    const b = sub(loop[(k + 1) % loop.length], origin);
    sum += dot(a, basis.x) * dot(b, basis.y) - dot(b, basis.x) * dot(a, basis.y);
  }
  return sum / 2;
}

/** Area-weighted mean normal and centroid of a facet set. Both are exact for a
 *  face whose facets really are coplanar, which is the only kind this pass
 *  grows. */
function facePlane(w: WeldedMesh, facets: readonly number[]): { plane: FlatFacePlane; areaMm2: number } {
  let areaMm2 = 0;
  const n: Vec3 = [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  for (const f of facets) {
    const area = w.areas[f];
    areaMm2 += area;
    const fn = facetNormal(w, f);
    const [p0, p1, p2] = facetPoints(w, f);
    for (let i = 0; i < 3; i++) {
      n[i] += fn[i] * area;
      c[i] += ((p0[i] + p1[i] + p2[i]) / 3) * area;
    }
  }
  const scale = areaMm2 === 0 ? 0 : 1 / areaMm2;
  return {
    plane: { point: [c[0] * scale, c[1] * scale, c[2] * scale], normal: normalize(n) },
    areaMm2,
  };
}

/**
 * Every flat face this mesh PROVES, in the recentred local frame.
 *
 * `sourceFacetIds` is WO-1845's id view: facet i of `mesh` descends from
 * source-file triangle `sourceFacetIds[i]`. Pass the one `resolveEditedStlMesh`
 * returns and a picked face keeps its name across a save/reload, because the
 * ids name triangles of the imported bytes rather than slots in whatever mesh
 * the edit journal happened to produce.
 */
export function recognizeFlatFaces(
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
  options: FlatFaceOptions = {},
): FlatFaceRecognition {
  const settings = { ...DEFAULT_FLAT_FACE_OPTIONS, ...options };
  const { planarityMm, flatnessSlope, smoothSlope, minAreaMm2 } = settings;
  const w = weldMesh(mesh);
  const empty: FlatFaceRecognition = { faces: [], skipped: [], planarityMm, facetCount: w.facetCount };
  // Ambiguous topology is the one thing the adjacency below cannot be reasoned
  // about at all (WO-1846 takes the same line). It is an empty answer, not a
  // message: nothing was proved, so nothing is listed.
  if (w.facetCount === 0 || ambiguousTopology(w)) return empty;

  const [shiftX, shiftY, shiftZ] = meshRecenterShift(mesh);
  const recentred = (index: number): Vec3 => {
    const p = vertexAt(w, index);
    return [p[0] + shiftX, p[1] + shiftY, p[2] + shiftZ];
  };
  const toSource = (facets: readonly number[]): number[] => {
    const out = new Set<number>();
    for (const f of facets) {
      const id = sourceFacetIds ? sourceFacetIds[f] : f;
      if (id !== undefined && id !== NO_SOURCE_FACET) out.add(id);
    }
    return [...out].sort((a, b) => a - b);
  };

  const regions = planarRegions(w, planarityMm, flatnessSlope);
  // The LOOSE adjacency, for the rim test. Two slopes, one mechanism: the same
  // `buildAdjacency` the round-feature half already uses.
  const { smooth } = buildAdjacency(w, smoothSlope);
  const regionIndex = indexPlanarRegions(w, regions);

  const faces: RecognizedFlatFace[] = [];
  const skipped: FlatFaceSkip[] = [];

  for (const facets of regions) {
    const { plane: rawPlane, areaMm2 } = facePlane(w, facets);
    const skip = (reason: FlatFaceSkip['reason']) =>
      skipped.push({ reason, facetCount: facets.length, areaMm2 });

    if (areaMm2 < minAreaMm2) {
      skip('below-minimum-area');
      continue;
    }
    // The rim test: one facet across the rim that is still smoothly in line
    // with this region means this is a piece of a curved surface, not a face -
    // unless that surface leaves the rim tangentially (WO-2798: a blend).
    const inside = new Set(facets);
    if (
      facets.some((f) => smooth[f].some((next) => !inside.has(next))) &&
      !smoothRimLeavesTangentially(w, regionIndex, facets, rawPlane.normal, smooth)
    ) {
      skip('curved-surface');
      continue;
    }

    const cycles = boundaryCycles(regionBoundaryEdges(w, inside));
    if (cycles.loops.length === 0 || cycles.ambiguous.length > 0) {
      skip('outline-not-closed');
      continue;
    }

    const plane: FlatFacePlane = {
      point: [rawPlane.point[0] + shiftX, rawPlane.point[1] + shiftY, rawPlane.point[2] + shiftZ],
      normal: rawPlane.normal,
    };
    const basis = flatFacePlaneBasis(plane.normal);
    const measured = cycles.loops.map((loop) => {
      const points = loop.map(recentred);
      return { points, signedArea: signedLoopArea(points, plane.point, basis) };
    });
    // The biggest loop is the face's outer boundary; every other one is a hole
    // through it. Orient them so the signed areas ADD to the real face area:
    // outer counter-clockwise about the normal, holes clockwise.
    measured.sort((a, b) => Math.abs(b.signedArea) - Math.abs(a.signedArea));
    const oriented = measured.map((entry, index) => {
      const wantPositive = index === 0;
      const flip = wantPositive ? entry.signedArea < 0 : entry.signedArea > 0;
      return {
        points: flip ? [...entry.points].reverse() : entry.points,
        signedArea: flip ? -entry.signedArea : entry.signedArea,
      };
    });

    let maxDeviationMm = 0;
    for (const f of facets) {
      for (const p of facetPoints(w, f)) {
        const at: Vec3 = [p[0] + shiftX, p[1] + shiftY, p[2] + shiftZ];
        maxDeviationMm = Math.max(maxDeviationMm, Math.abs(dot(plane.normal, sub(at, plane.point))));
      }
    }

    const ids = toSource(facets);
    faces.push({
      id: `flat-${ids.length > 0 ? ids[0] : facets[0]}`,
      plane,
      outline: { outer: oriented[0].points, inner: oriented.slice(1).map((entry) => entry.points) },
      areaMm2,
      outlineAreaMm2: oriented.reduce((sum, entry) => sum + entry.signedArea, 0),
      maxDeviationMm,
      facetCount: facets.length,
      sourceFacetIds: ids,
    });
  }

  faces.sort((a, b) => b.areaMm2 - a.areaMm2 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { faces, skipped, planarityMm, facetCount: w.facetCount };
}

/** How close to an axis a normal has to be before the face is called "up",
 *  "down" or "upright" in words instead of given an angle. */
const AXIS_EPS = 1e-6;

/** One line naming THIS face, in the words Operator uses: how big it is, which way
 *  it looks, and where it sits. No jargon, no fit error folded into the size. */
export function describeFlatFace(face: RecognizedFlatFace): string {
  const [nx, ny, nz] = face.plane.normal;
  const size = `${face.areaMm2.toFixed(1)} mm2 flat face`;
  const at = (axis: 'X' | 'Y' | 'Z', value: number): string => `at ${axis} ${value.toFixed(2)} mm`;
  if (nz >= 1 - AXIS_EPS) return `${size}, facing up, ${at('Z', face.plane.point[2])}`;
  if (nz <= -1 + AXIS_EPS) return `${size}, facing down, ${at('Z', face.plane.point[2])}`;
  if (Math.abs(nx) >= 1 - AXIS_EPS) {
    return `${size}, upright, facing ${nx > 0 ? '+X' : '-X'}, ${at('X', face.plane.point[0])}`;
  }
  if (Math.abs(ny) >= 1 - AXIS_EPS) {
    return `${size}, upright, facing ${ny > 0 ? '+Y' : '-Y'}, ${at('Y', face.plane.point[1])}`;
  }
  const tiltDeg = (Math.acos(Math.min(1, Math.abs(nz))) * 180) / Math.PI;
  return `${size}, tilted ${tiltDeg.toFixed(0)} degrees from flat`;
}
