// WO-1848: the fillets and chamfers LienCAM can PROVE along an edge between
// two flat faces of an imported STL.
//
// Port of Next's meshCylindricalBlend / meshPlanarTransition / meshBlendSupport
// cluster onto MeshBuffers. The proof shape is Next's; the arithmetic is
// float64 against a stated tolerance, for the reason WO-1846 already logged in
// ./types.ts (a binary STL carries float32 coordinates, so an exact predicate
// downstream of them answers an exact question about numbers the file never
// had). Nothing conservative is given up: every facet of a fillet band has to
// lie on the fitted cylinder across its WHOLE area, not at its corners.
//
// What a blend IS here, and this is the whole of it:
//   - two flat faces whose planes meet along a line L - the THEORETICAL SHARP
//     EDGE the part would have if the blend were not there;
//   - a band of facets between them, touching each face along a straight RAIL
//     parallel to L;
//   - two END faces closing the band off, each crossing L at one corner.
// A fillet's band fits a cylinder tangent to both faces. A chamfer's band is
// one flat strip. Anything else is not listed and is never guessed at.
//
// TWO ENTRY POINTS, on purpose:
//   - `recognizeEdgeBlends` is the public one (re-exported by ./index.ts):
//     "what blends does this part prove?". It applies the LISTING fences at
//     the bottom of this file - a blend is small beside the faces it joins, and
//     it turns through less than half a turn - so the panel lists blends and
//     not every formally valid planar transition a block outline contains.
//   - `prepareEdgeBlend` is what `src/mesh/edit/operations/` calls with an
//     EXPLICIT selection. It applies the structural proof and nothing else: the
//     operator picked that band, and LIENCAM.md rule 11 says the software
//     refuses only what it cannot do, never what a listing heuristic would not
//     have offered him.

import type { MeshBuffers, Vec3 } from '../types';
import { NO_SOURCE_FACET } from '../edit/idView';
import { add, cross, dot, length, normalize, scale, sub } from './types';
import {
  ambiguousTopology,
  facetNormal,
  facetPoints,
  normalsWithin,
  planarRegions,
  vertexAt,
  weldMesh,
  type WeldedMesh,
} from './topology';
import { inferCylinder, inspectCylinder, type CylinderSurface } from './surfaces';
import { findWallBlends, type PreparedWallBlend } from './wallBlends';

/** How far a face may bend and still be ONE flat face, mm. This is a flatness
 *  budget, not a machining tolerance: a CAD-exported flat face lands inside a
 *  micron, and admitting more lets a support plane swallow the first chord of
 *  the very fillet it supports (measured: a 3 mm fillet in 8 chords puts its
 *  first chord 0.058 mm off the tangent plane). */
export const DEFAULT_FACE_FLATNESS_MM = 1e-3;

/** tan of the angle two facet normals may differ by and still be one face. */
const FACE_SLOPE = 1e-4;

/** unit vectors closer than this are treated as parallel. */
const PARALLEL_EPS = 1e-6;

export interface EdgeBlendOptions {
  /** how far a face may bend and still be one flat face, mm */
  faceFlatnessMm?: number;
  /** the chord budget a fillet band's facets get against the fitted cylinder,
   *  mm. Same meaning and same default as WO-1846's `toleranceMm`. */
  toleranceMm?: number;
  /**
   * LISTING fence only. Two facets whose normals are farther apart than this
   * (as a tangent) are a CREASE rather than one smooth surface - WO-1846's
   * `maxNormalSlope`, same meaning and same default. It is what tells a face
   * from a chord of a round; see `listable` below.
   */
  smoothSlope?: number;
  /**
   * LISTING fence only. A blend has to reach at most this fraction of the way
   * out from the sharp edge that BOTH the faces it joins do. A blend is a small
   * thing between two faces; a whole face read as a "chamfer" between its
   * neighbour and its neighbour's neighbour is not.
   */
  maxBandReachRatio?: number;
  /** LISTING fence only: the widest band the search will grow, facets. */
  maxBandFacets?: number;
}

export const DEFAULT_EDGE_BLEND_OPTIONS: Required<EdgeBlendOptions> = {
  faceFlatnessMm: DEFAULT_FACE_FLATNESS_MM,
  toleranceMm: 0.25,
  smoothSlope: 0.5,
  maxBandReachRatio: 0.5,
  maxBandFacets: 4096,
};

/** One flat face of the part: its plane and the facets that make it. */
export interface BlendFace {
  /** unit normal, pointing out of the material */
  normal: Vec3;
  /** `normal . x = offsetMm` for every point on the face */
  offsetMm: number;
  /** facet indices into the mesh this was read from */
  facets: number[];
}

/** The theoretical sharp edge: where the two faces would meet. */
export interface SharpEdgeLine {
  /** the point of the line closest to the mesh origin */
  origin: Vec3;
  /** unit direction; stations increase along it */
  direction: Vec3;
  /** the line clipped to the two end faces - the edge the part gets back */
  ends: [Vec3, Vec3];
}

export interface RecognizedEdgeBlend {
  /** stable within one query result: `${kind}-${smallest source facet id}` */
  id: string;
  kind: 'fillet' | 'chamfer';
  /** convex = the blend took material off an outside corner; concave = it
   *  added material into an inside corner */
  shape: 'convex' | 'concave';
  /** fillet only: the fitted radius, mm */
  radiusMm?: number;
  /** chamfer only: how far the chamfer sets the edge back along each face, mm */
  setbackMm?: [number, number];
  /** chamfer only: the angle the chamfer face makes with the first face, deg */
  angleDeg?: number;
  /** the angle the two faces make through the material, degrees */
  includedAngleDeg: number;
  /** length of the sharp edge the part would get back, mm */
  lengthMm: number;
  /** worst distance from any point of any band facet to the fitted surface */
  maxDeviationMm: number;
  /** fillet: worst |distance(axis, face) - radius|. Chamfer: 0. */
  tangencyErrorMm: number;
  edgeLine: SharpEdgeLine;
  /** WO-1845 source-facet ids of the band, ascending */
  sourceFacetIds: number[];
}

export interface EdgeBlendRecognition {
  blends: RecognizedEdgeBlend[];
  /** the tolerance actually used, echoed so a report can state it */
  toleranceMm: number;
  /** facets the query examined (the whole mesh) */
  facetCount: number;
}

/** Everything an edit needs to work on one blend, all of it re-derived from
 *  the mesh and the selection so replay never depends on recognition. */
export interface PreparedEdgeBlend {
  welded: WeldedMesh;
  /** the selected band, ascending facet indices */
  band: number[];
  kind: 'fillet' | 'chamfer';
  shape: 'convex' | 'concave';
  /** the two faces the blend joins */
  supports: [BlendFace, BlendFace];
  /** the two faces that close its ends */
  ends: [BlendFace, BlendFace];
  edgeLine: SharpEdgeLine;
  /** welded vertex ids of the band, split by what the edit does with them */
  rail: [number[], number[]];
  endRing: [number[], number[]];
  interior: number[];
  /** fillet only */
  cylinder?: CylinderSurface;
  radiusMm?: number;
  setbackMm: [number, number];
  maxDeviationMm: number;
  tangencyErrorMm: number;
  includedAngleDeg: number;
  faceFlatnessMm: number;
}

// ---------------------------------------------------------------- the query

/**
 * Every edge blend this mesh PROVES.
 *
 * `sourceFacetIds` is WO-1845's id view, with the same meaning it has in
 * `recognizeMeshFeatures`: pass the one `resolveEditedStlMesh` returns and the
 * ids in the result name triangles of the imported bytes.
 */
export function recognizeEdgeBlends(
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
  options: EdgeBlendOptions = {},
): EdgeBlendRecognition {
  const settings = { ...DEFAULT_EDGE_BLEND_OPTIONS, ...options };
  const w = weldMesh(mesh);
  const facetCount = w.facetCount;
  if (facetCount === 0 || ambiguousTopology(w)) {
    return { blends: [], toleranceMm: settings.toleranceMm, facetCount };
  }

  const patches = planarRegions(w, settings.faceFlatnessMm, FACE_SLOPE);
  const patchOf = new Int32Array(facetCount).fill(-1);
  patches.forEach((facets, index) => { for (const f of facets) patchOf[f] = index; });
  const planes = patches.map((facets) => facePlane(w, facets));
  const shared = patchPairEdges(w, patchOf);
  const neighbours: number[][] = Array.from({ length: patches.length }, () => []);
  for (const key of shared.keys()) {
    const [a, b] = key.split(':').map(Number);
    neighbours[a].push(b);
    neighbours[b].push(a);
  }

  const found = new Map<string, { band: number[]; blend: RecognizedEdgeBlend }>();
  for (let a = 0; a < patches.length; a++) {
    for (const seed of neighbours[a]) {
      for (const candidate of growBands(w, patchOf, patches, planes, shared, a, seed, settings)) {
        const key = candidate.band.join(',');
        if (found.has(key)) continue;
        let prepared: PreparedEdgeBlend;
        try {
          prepared = proveEdgeBlend(w, candidate.band, patchOf, patches, planes, settings);
        } catch {
          continue;
        }
        if (!listable(w, prepared, settings)) continue;
        found.set(key, { band: candidate.band, blend: describeAsBlend(prepared, mesh, sourceFacetIds) });
      }
    }
  }

  // Maximality: a 3-chord slice of an 8-chord fillet is a formally valid blend
  // too. Keep the widest reading of each edge and drop the readings inside it,
  // which is what "the widest thing that is actually correct" means here.
  const bands = [...found.values()];
  const straight = bands
    .filter(({ band }) => !bands.some((other) => other.band.length > band.length && isSubset(band, other.band)));
  // WO-2798: blends round a wall standing square to their face - a boss foot,
  // a chain round a top, a pocket's floor fillets - that the straight proof
  // above cannot read. A band it already proved keeps its reading.
  // WO-2802: after resizing a chain, a tiny planar member can also prove as
  // a straight blend. Maximality applies across BOTH proofs: that member
  // must not hide the proven whole chain on the next pick/replay boundary.
  const walls = findWallBlends(w).filter((wall) => {
    const inWall = new Set(wall.band);
    return straight.every(({ band }) => !band.some((f) => inWall.has(f)) ||
      (wall.band.length > band.length && isSubset(band, wall.band)));
  });
  const maximalStraight = straight.filter(({ band }) =>
    !walls.some((wall) => wall.band.length > band.length && isSubset(band, wall.band)));
  const taken = new Set(maximalStraight.flatMap(({ band }) => band));
  const round = walls
    .filter((wall) => !wall.band.some((f) => taken.has(f)))
    .map((wall) => describeWallBlend(wall, sourceFacetIds));
  const blends = [...maximalStraight.map(({ blend }) => blend), ...round]
    .sort((x, y) => (x.sourceFacetIds[0] ?? 0) - (y.sourceFacetIds[0] ?? 0));

  return { blends, toleranceMm: settings.toleranceMm, facetCount };
}

/** The one line the panel and the console use to name a blend. */
export function describeEdgeBlend(blend: RecognizedEdgeBlend): string {
  const length = `${blend.lengthMm.toFixed(2)} mm long`;
  if (blend.kind === 'fillet') {
    return `${(blend.radiusMm ?? 0).toFixed(2)} mm ${blend.shape === 'concave' ? 'inside ' : ''}fillet, ${length}`;
  }
  const setback = blend.setbackMm ?? [0, 0];
  const size = Math.abs(setback[0] - setback[1]) < 5e-3
    ? `${setback[0].toFixed(2)} mm`
    : `${setback[0].toFixed(2)} x ${setback[1].toFixed(2)} mm`;
  return `${size} x ${(blend.angleDeg ?? 0).toFixed(0)} deg chamfer, ${length}`;
}

// -------------------------------------------------------- the edits' door

/**
 * Prove that `facets` IS a blend band and work out everything an edit needs:
 * the two faces, the sharp edge they would meet along, the two end faces and
 * which of the band's vertices go where.
 *
 * THROWS a plain sentence naming what LienCAM could not work out. It never
 * tells the operator to go and change his file (LIENCAM.md rule 11).
 */
export function prepareEdgeBlend(
  mesh: MeshBuffers,
  facets: readonly number[],
  options: EdgeBlendOptions = {},
): PreparedEdgeBlend {
  const settings = { ...DEFAULT_EDGE_BLEND_OPTIONS, ...options };
  const w = weldMesh(mesh);
  if (ambiguousTopology(w)) {
    throw new Error(
      'This part has facets that meet more than two to an edge, or facets with no area, so ' +
        'LienCAM cannot work out which faces an edge blend sits between. Nothing was changed.',
    );
  }
  const patches = planarRegions(w, settings.faceFlatnessMm, FACE_SLOPE);
  const patchOf = new Int32Array(w.facetCount).fill(-1);
  patches.forEach((group, index) => { for (const f of group) patchOf[f] = index; });
  const planes = patches.map((group) => facePlane(w, group));
  const band = [...new Set(facets)].sort((x, y) => x - y);
  return proveEdgeBlend(w, band, patchOf, patches, planes, settings);
}

// ------------------------------------------------------------------ the proof

function proveEdgeBlend(
  w: WeldedMesh,
  band: readonly number[],
  patchOf: Int32Array,
  patches: number[][],
  planes: BlendFace[],
  settings: Required<EdgeBlendOptions>,
): PreparedEdgeBlend {
  if (band.length === 0) refuse('No facets were chosen, so there is no blend to work on.');
  const bandSet = new Set(band);
  const boundary = bandBoundary(w, bandSet);
  const byPatch = new Map<number, number[]>();
  for (const [edgeIndex, outside] of boundary) {
    const patch = patchOf[outside];
    const list = byPatch.get(patch) ?? [];
    list.push(edgeIndex);
    byPatch.set(patch, list);
  }
  if (byPatch.size !== 4) {
    refuse(
      `A fillet or a chamfer runs between two flat faces and is closed off at each end, which is ` +
        `four faces around it; this selection has ${byPatch.size}. Nothing was changed.`,
    );
  }

  // Which two of the four are the FACES the blend joins: the pair whose rails
  // both run straight, parallel to each other, and parallel to the line their
  // two planes meet along. The other two close the ends.
  const around = [...byPatch.keys()];
  const supportPair = around.flatMap((p, i) =>
    around.slice(i + 1).flatMap((q) => {
      const pair = supportGeometry(w, planes[p], planes[q], byPatch.get(p) as number[], byPatch.get(q) as number[]);
      return pair ? [{ p, q, ...pair }] : [];
    }),
  );
  if (supportPair.length !== 1) {
    refuse(
      supportPair.length === 0
        ? 'LienCAM could not find two flat faces this blend runs between with a straight edge along ' +
            'each of them, so it cannot work out where the sharp edge would be. Nothing was changed.'
        : 'More than one pair of faces around this selection could be the ones it runs between, so ' +
            'LienCAM cannot tell which sharp edge the operator means. Nothing was changed.',
    );
  }
  const chosen = supportPair[0];
  const supports: [BlendFace, BlendFace] = [planes[chosen.p], planes[chosen.q]];
  const endPatches = around.filter((p) => p !== chosen.p && p !== chosen.q);
  const ends: [BlendFace, BlendFace] = [planes[endPatches[0]], planes[endPatches[1]]];

  // The sharp edge, clipped to the two end faces.
  const direction = chosen.direction;
  const origin = chosen.origin;
  const corners = ends.map((end) => {
    const along = dot(end.normal, direction);
    if (Math.abs(along) <= PARALLEL_EPS) {
      refuse(
        'One of the faces closing this blend off runs alongside the sharp edge instead of across ' +
          'it, so LienCAM cannot work out where that end of the edge would be. Nothing was changed.',
      );
    }
    return add(origin, scale(direction, (end.offsetMm - dot(end.normal, origin)) / along));
  }) as [Vec3, Vec3];
  const lengthMm = length(sub(corners[1], corners[0]));
  if (!(lengthMm > 0)) {
    refuse('The two ends of this blend meet at the same point, so it has no sharp edge to restore. Nothing was changed.');
  }
  const edgeLine: SharpEdgeLine = { origin, direction, ends: corners };

  // Which way the blend goes: is the material in the wedge between the two
  // faces (an outside corner, rounded off) or outside it (an inside corner,
  // filled in)? The band's own centroid answers it.
  const centroid = bandCentroid(w, band);
  const side = supports.map((face) => dot(face.normal, centroid) - face.offsetMm);
  const shape: 'convex' | 'concave' = side[0] < 0 && side[1] < 0 ? 'convex' : 'concave';
  if (!(side[0] < 0 && side[1] < 0) && !(side[0] > 0 && side[1] > 0)) {
    refuse(
      'This band lies on one side of one of its faces and the other side of the other, so it is ' +
        'not a blend along the edge between them. Nothing was changed.',
    );
  }

  // Which of the band's vertices go where. A vertex shared with an end face
  // is pulled to that end's corner; a vertex shared with a support face only
  // is pulled onto the sharp edge; anything else is interior and goes away
  // with the band (Next's meshBlendSupport, same split).
  const bandVertices = new Set<number>();
  for (const f of band) for (let c = 0; c < 3; c++) bandVertices.add(w.facets[f * 3 + c]);
  const onPatch = (patch: number): Set<number> => {
    const out = new Set<number>();
    for (const f of patches[patch]) for (let c = 0; c < 3; c++) {
      const id = w.facets[f * 3 + c];
      if (bandVertices.has(id)) out.add(id);
    }
    return out;
  };
  const endRingSets = [onPatch(endPatches[0]), onPatch(endPatches[1])];
  if (endRingSets[0].size === 0 || endRingSets[1].size === 0) {
    refuse('One end of this blend has no corner on the face that closes it. Nothing was changed.');
  }
  for (const id of endRingSets[0]) {
    if (endRingSets[1].has(id)) {
      refuse('One corner of this blend belongs to both of its ends, so LienCAM cannot tell them apart. Nothing was changed.');
    }
  }
  const endRing: [number[], number[]] = [
    [...endRingSets[0]].sort((x, y) => x - y),
    [...endRingSets[1]].sort((x, y) => x - y),
  ];
  const railSets = [onPatch(chosen.p), onPatch(chosen.q)];
  const rail: [number[], number[]] = [
    [...railSets[0]].filter((id) => !endRingSets[0].has(id) && !endRingSets[1].has(id)).sort((x, y) => x - y),
    [...railSets[1]].filter((id) => !endRingSets[0].has(id) && !endRingSets[1].has(id)).sort((x, y) => x - y),
  ];
  const placed = new Set<number>([...endRing[0], ...endRing[1], ...rail[0], ...rail[1]]);
  const interior = [...bandVertices].filter((id) => !placed.has(id)).sort((x, y) => x - y);

  // How far the blend sets the edge back along each face, measured in that
  // face's own plane: the fillet's tangent line, the chamfer's leg.
  const setbackMm = supports.map((face, i) => {
    const across = normalize(cross(face.normal, direction));
    const ids = [...railSets[i]];
    let worst = 0;
    for (const id of ids) worst = Math.max(worst, Math.abs(dot(sub(vertexAt(w, id), origin), across)));
    return worst;
  }) as [number, number];

  const includedAngleDeg =
    180 - (Math.acos(Math.min(1, Math.max(-1, dot(supports[0].normal, supports[1].normal)))) * 180) / Math.PI;

  const common = {
    welded: w, band: [...band], shape, supports, ends, edgeLine, rail, endRing, interior,
    setbackMm, includedAngleDeg, faceFlatnessMm: settings.faceFlatnessMm,
  };

  // A chamfer is one flat strip; a fillet is a band on a cylinder tangent to
  // both faces. Nothing else is either.
  const bandPatches = new Set(band.map((f) => patchOf[f]));
  if (bandPatches.size === 1) {
    const strip = planes[[...bandPatches][0]];
    let deviation = 0;
    for (const f of band) for (const p of facetPoints(w, f)) {
      deviation = Math.max(deviation, Math.abs(dot(strip.normal, p) - strip.offsetMm));
    }
    return {
      ...common, kind: 'chamfer', maxDeviationMm: deviation, tangencyErrorMm: 0,
    };
  }

  const inference = inferCylinder(w, band, settings.toleranceMm);
  if (inference.status !== 'candidate') {
    refuse(
      'This band is neither one flat strip nor a piece of a round of constant radius, so LienCAM ' +
        'cannot work out what shape it is meant to be. Nothing was changed.',
    );
  }
  const surface = inference.surface;
  if (length(cross(surface.axis, direction)) > 1e-4) {
    refuse('The round of this blend does not run along the edge it sits on. Nothing was changed.');
  }
  let tangencyErrorMm = 0;
  for (const face of supports) {
    if (Math.abs(dot(face.normal, surface.axis)) > 1e-4) {
      refuse('The round of this blend leans across one of the faces beside it instead of running along it. Nothing was changed.');
    }
    const distance = Math.abs(dot(face.normal, surface.origin) - face.offsetMm);
    tangencyErrorMm = Math.max(tangencyErrorMm, Math.abs(distance - surface.radiusMm));
  }
  if (tangencyErrorMm > settings.toleranceMm) {
    refuse(
      `This round does not sit tangent to the faces beside it - it misses one of them by ` +
        `${tangencyErrorMm.toFixed(3)} mm - so LienCAM cannot treat it as a fillet. Nothing was changed.`,
    );
  }
  return {
    ...common, kind: 'fillet', cylinder: surface, radiusMm: surface.radiusMm,
    maxDeviationMm: inference.inspection.maxDeviationMm, tangencyErrorMm,
  };
}

// ------------------------------------------------------------- band searching

interface BandCandidate {
  band: number[];
}

/**
 * Walk outward from the rail between face `a` and its neighbour `seed`,
 * widening the band one face at a time, and offer every reading that closes on
 * a second face. The walk stops when the surface has turned half a turn - past
 * that it is going the long way round the part, not across a blend.
 */
function* growBands(
  w: WeldedMesh,
  patchOf: Int32Array,
  patches: number[][],
  planes: BlendFace[],
  shared: Map<string, number[]>,
  a: number,
  seed: number,
  settings: Required<EdgeBlendOptions>,
): Generator<BandCandidate> {
  const anchor = planes[a];
  const edges = shared.get(pairKey(a, seed)) ?? [];
  const railDirection = commonDirection(w, edges.map((i) => [w.edges[i].a, w.edges[i].b] as [number, number]));
  if (!railDirection) return;
  const bandFacets = new Set<number>(patches[seed]);
  const bandPatches = [seed];
  let previous = planes[seed].normal;
  let turn = signedAngle(anchor.normal, previous, railDirection);
  if (turn === 0) return;
  const sign = Math.sign(turn);

  for (let step = 0; step < patches.length; step++) {
    if (bandFacets.size > settings.maxBandFacets) return;
    const outside = new Set<number>();
    for (const [, other] of bandBoundary(w, bandFacets)) {
      const patch = patchOf[other];
      if (patch === a || bandPatches.includes(patch)) continue;
      if (Math.abs(dot(planes[patch].normal, railDirection)) > 1e-4) continue; // an end face
      outside.add(patch);
    }
    if (outside.size !== 1) return;
    const next = [...outside][0];
    const closing = turn + signedAngle(previous, planes[next].normal, railDirection);
    if (Math.sign(closing - turn) !== sign) return;
    if (Math.abs(closing) >= Math.PI - 1e-9) return;
    yield { band: [...bandFacets].sort((x, y) => x - y) };
    for (const f of patches[next]) bandFacets.add(f);
    bandPatches.push(next);
    previous = planes[next].normal;
    turn = closing;
  }
}

/**
 * The LISTING fences (see this file's header). Two of them, and both were put
 * here by a measured piece of noise rather than a preference:
 *
 *  1. A blend's supports have to be FACES, not chords of a round. Every
 *     tessellated round formally contains a chamfer between each of its chords
 *     and the chords either side. What separates a face from a chord is where
 *     the surface STOPS curving: a face creases somewhere along the way the
 *     blend runs, a chord is smooth on both sides of it. Without this the
 *     round-bar fixture in this order's test listed 48 "0.30 mm x 11 degree
 *     chamfers" round its top edge, one per quad of its torus band.
 *     WO-2081: a pocket wall can meet rounds at BOTH sides without a crease.
 *     For a fillet, it is also a support if it leaves the fitted cylinder's
 *     tolerance envelope: the surface stops curving on that planar wall.
 *  2. A blend has to be SMALL beside the two faces it joins. Every block
 *     outline formally contains a chamfer between each face and its
 *     neighbour's neighbour. Without this the block in that same test, once
 *     its fillet came off, listed its own 58 mm top face as a "chamfer"
 *     between the wall and the real 2 mm chamfer.
 *
 * `prepareEdgeBlend` applies NEITHER. The operator may pick any band that is
 * geometrically a blend and the software will do it - rule 11 is about what
 * LienCAM cannot do, and these are only about what it volunteers.
 */
function listable(
  w: WeldedMesh,
  prepared: PreparedEdgeBlend,
  settings: Required<EdgeBlendOptions>,
): boolean {
  const { origin, direction } = prepared.edgeLine;
  if (!prepared.supports.every((face) =>
    creasesAlong(w, face, direction, settings.smoothSlope) ||
    (prepared.kind === 'fillet' && prepared.cylinder !== undefined &&
      inspectCylinder(w, face.facets, prepared.cylinder, settings.toleranceMm).maxDeviationMm > settings.toleranceMm),
  )) {
    return false;
  }
  const reach = (ids: Iterable<number>): number => {
    let worst = 0;
    for (const id of ids) {
      const d = sub(vertexAt(w, id), origin);
      worst = Math.max(worst, length(sub(d, scale(direction, dot(d, direction)))));
    }
    return worst;
  };
  const bandVertices = new Set<number>();
  for (const f of prepared.band) for (let c = 0; c < 3; c++) bandVertices.add(w.facets[f * 3 + c]);
  const bandReach = reach(bandVertices);
  for (const face of prepared.supports) {
    const ids = new Set<number>();
    for (const f of face.facets) for (let c = 0; c < 3; c++) ids.add(w.facets[f * 3 + c]);
    if (bandReach > settings.maxBandReachRatio * reach(ids)) return false;
  }
  return true;
}

/** Does this face crease at any of its boundaries that run the blend's way? */
function creasesAlong(w: WeldedMesh, face: BlendFace, t: Vec3, slope: number): boolean {
  const inside = new Set(face.facets);
  for (const f of face.facets) {
    for (let e = 0; e < 3; e++) {
      const index = w.facetEdges[f * 3 + e];
      if (index < 0) continue;
      const edge = w.edges[index];
      if (edge.facets.length !== 2) continue;
      const other = edge.facets[0] === f ? edge.facets[1] : edge.facets[0];
      if (inside.has(other)) continue;
      const raw = sub(vertexAt(w, edge.b), vertexAt(w, edge.a));
      const l = length(raw);
      if (l === 0) continue;
      if (length(cross(scale(raw, 1 / l), t)) > PARALLEL_EPS) continue;
      if (!normalsWithin(face.normal, facetNormal(w, other), slope)) return true;
    }
  }
  return false;
}

function describeAsBlend(
  prepared: PreparedEdgeBlend,
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
): RecognizedEdgeBlend {
  void mesh;
  const ids = prepared.band
    .map((f) => (sourceFacetIds ? sourceFacetIds[f] : f))
    .filter((id) => id !== undefined && id !== NO_SOURCE_FACET)
    .sort((x, y) => x - y);
  const angleDeg = prepared.kind === 'chamfer'
    ? (Math.acos(Math.min(1, Math.max(-1, Math.abs(dot(bandNormal(prepared), prepared.supports[0].normal))))) * 180) / Math.PI
    : undefined;
  return {
    id: `${prepared.kind}-${ids[0] ?? prepared.band[0]}`,
    kind: prepared.kind,
    shape: prepared.shape,
    ...(prepared.kind === 'fillet' ? { radiusMm: prepared.radiusMm } : { setbackMm: prepared.setbackMm, angleDeg }),
    includedAngleDeg: prepared.includedAngleDeg,
    lengthMm: length(sub(prepared.edgeLine.ends[1], prepared.edgeLine.ends[0])),
    maxDeviationMm: prepared.maxDeviationMm,
    tangencyErrorMm: prepared.tangencyErrorMm,
    edgeLine: prepared.edgeLine,
    sourceFacetIds: ids,
  };
}

/** A wall blend as the listing names a blend. Its sharp edge is a curve; the
 *  `edgeLine` reported is the chord across it, and `lengthMm` the curve's own
 *  length. */
function describeWallBlend(wall: PreparedWallBlend, sourceFacetIds?: Uint32Array): RecognizedEdgeBlend {
  const ids = wall.band
    .map((f) => (sourceFacetIds ? sourceFacetIds[f] : f))
    .filter((id) => id !== undefined && id !== NO_SOURCE_FACET)
    .sort((x, y) => x - y);
  const feet = wall.wallRail.map((id) => wall.frames.get(id)?.foot as Vec3);
  const first = feet[0];
  let far = first;
  for (const p of feet) if (length(sub(p, first)) > length(sub(far, first))) far = p;
  const span = sub(far, first);
  const direction: Vec3 = length(span) > 0 ? normalize(span) : normalize(cross(wall.plane.normal, [1, 0, 0]));
  return {
    id: `${wall.kind}-${ids[0] ?? wall.band[0]}`,
    kind: wall.kind,
    shape: wall.shape,
    ...(wall.kind === 'fillet' ? { radiusMm: wall.sizeMm } : { setbackMm: [wall.sizeMm, wall.sizeMm] as [number, number], angleDeg: 45 }),
    includedAngleDeg: 90,
    lengthMm: wall.edgeLengthMm,
    maxDeviationMm: wall.maxDeviationMm,
    tangencyErrorMm: wall.maxDeviationMm,
    edgeLine: { origin: first, direction, ends: [first, far] },
    sourceFacetIds: ids,
  };
}

function bandNormal(prepared: PreparedEdgeBlend): Vec3 {
  const w = prepared.welded;
  let sum: Vec3 = [0, 0, 0];
  for (const f of prepared.band) sum = add(sum, scale(facetNormal(w, f), w.areas[f]));
  return normalize(sum);
}

// -------------------------------------------------------------------- helpers

function refuse(message: string): never {
  throw new Error(message);
}

/** A flat face's plane, area-weighted so one sliver cannot tilt it. */
function facePlane(w: WeldedMesh, facets: readonly number[]): BlendFace {
  let sum: Vec3 = [0, 0, 0];
  let centre: Vec3 = [0, 0, 0];
  let area = 0;
  for (const f of facets) {
    const weight = w.areas[f];
    sum = add(sum, scale(facetNormal(w, f), weight));
    const [p0, p1, p2] = facetPoints(w, f);
    centre = add(centre, scale(scale(add(add(p0, p1), p2), 1 / 3), weight));
    area += weight;
  }
  const normal = normalize(sum);
  const point = area > 0 ? scale(centre, 1 / area) : centre;
  return { normal, offsetMm: dot(normal, point), facets: [...facets] };
}

/** Edge index -> the facet outside `band` that shares it. */
function bandBoundary(w: WeldedMesh, band: ReadonlySet<number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const f of band) {
    for (let e = 0; e < 3; e++) {
      const index = w.facetEdges[f * 3 + e];
      if (index < 0) continue;
      const edge = w.edges[index];
      if (edge.facets.length !== 2) continue;
      const other = edge.facets[0] === f ? edge.facets[1] : edge.facets[0];
      if (band.has(other)) continue;
      out.push([index, other]);
    }
  }
  return out;
}

const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Every pair of faces that touch, and the edge indices along which they do. */
function patchPairEdges(w: WeldedMesh, patchOf: Int32Array): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let index = 0; index < w.edges.length; index++) {
    const edge = w.edges[index];
    if (edge.facets.length !== 2) continue;
    const a = patchOf[edge.facets[0]];
    const b = patchOf[edge.facets[1]];
    if (a < 0 || b < 0 || a === b) continue;
    const key = pairKey(a, b);
    const list = out.get(key) ?? [];
    list.push(index);
    out.set(key, list);
  }
  return out;
}

function commonDirection(w: WeldedMesh, edges: ReadonlyArray<[number, number]>): Vec3 | undefined {
  let direction: Vec3 | undefined;
  for (const [a, b] of edges) {
    const raw = sub(vertexAt(w, b), vertexAt(w, a));
    const l = length(raw);
    if (l === 0) continue;
    const unit = canonical(scale(raw, 1 / l));
    if (!direction) direction = unit;
    else if (length(cross(direction, unit)) > PARALLEL_EPS) return undefined;
  }
  return direction;
}

/** Same line, same reported direction, whichever way its edges were wound. */
function canonical(v: Vec3): Vec3 {
  let biggest = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[biggest])) biggest = i;
  return v[biggest] < 0 ? [-v[0], -v[1], -v[2]] : v;
}

/**
 * Two faces are the ones a blend runs BETWEEN when each of them meets it along
 * a straight rail, both rails run the same way, and that way is the way their
 * two planes meet. Returns the sharp edge, or undefined when they are not.
 */
function supportGeometry(
  w: WeldedMesh,
  p: BlendFace,
  q: BlendFace,
  pEdges: readonly number[],
  qEdges: readonly number[],
): { origin: Vec3; direction: Vec3 } | undefined {
  const pDirection = commonDirection(w, pEdges.map((i) => [w.edges[i].a, w.edges[i].b] as [number, number]));
  const qDirection = commonDirection(w, qEdges.map((i) => [w.edges[i].a, w.edges[i].b] as [number, number]));
  if (!pDirection || !qDirection) return undefined;
  if (length(cross(pDirection, qDirection)) > PARALLEL_EPS) return undefined;
  if (normalsWithin(p.normal, q.normal, FACE_SLOPE) || length(cross(p.normal, q.normal)) <= PARALLEL_EPS) {
    return undefined;
  }
  const raw = cross(p.normal, q.normal);
  const direction = canonical(normalize(raw));
  if (length(cross(direction, pDirection)) > 1e-4) return undefined;
  // The point of the line closest to the origin.
  const denominator = dot(raw, raw);
  const origin = scale(
    add(scale(cross(q.normal, raw), p.offsetMm), scale(cross(raw, p.normal), q.offsetMm)),
    1 / denominator,
  );
  if (origin.some((n) => !Number.isFinite(n))) return undefined;
  return { origin, direction };
}

function bandCentroid(w: WeldedMesh, band: readonly number[]): Vec3 {
  let centre: Vec3 = [0, 0, 0];
  let area = 0;
  for (const f of band) {
    const weight = w.areas[f];
    const [p0, p1, p2] = facetPoints(w, f);
    centre = add(centre, scale(scale(add(add(p0, p1), p2), 1 / 3), weight));
    area += weight;
  }
  return area > 0 ? scale(centre, 1 / area) : centre;
}

/** The turn from `a` to `b` seen looking along `axis`, radians, signed. */
function signedAngle(a: Vec3, b: Vec3, axis: Vec3): number {
  return Math.atan2(dot(cross(a, b), axis), dot(a, b));
}

function isSubset(small: readonly number[], big: readonly number[]): boolean {
  const set = new Set(big);
  return small.every((f) => set.has(f));
}
