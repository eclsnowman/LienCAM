// WO-2798: fillets and chamfers between a flat face and a WALL standing square
// to it - whatever shape that wall runs round.
//
// WO-1848's `edgeBlends.ts` proves one kind of blend: a straight band between
// two flat faces, closed off by two flat end faces. The parts machinists
// actually import are filleted all the way round: the foot of a boss (a torus
// against a cylinder), the top of a block with rounded corners (straight
// fillets joined by corner tori, one tangent chain with no end faces at all),
// the floor of a pocket. To that file none of them is a blend, so Fillet and
// Defeature had nothing to change (audit cells SFI-1..4, SDF-3/5/6/8). The
// software can do these (LIENCAM.md rule 11), so it does.
//
// WHAT A WALL BLEND IS. A flat face P (normal n), a wall W whose every facet
// stands square to P (a flank, a bore, a boss, a round corner - any profile
// swept along n), and a band of facets between them. Seen in the plane across
// the wall at any point of it, the band is a quarter circle of radius r tangent
// to both (a fillet) or a straight 45-degree leg of size r (an equal chamfer).
// Every band vertex therefore has a FOOT - the point of the sharp edge P and W
// would meet along - and two distances from it: `d` out from the wall along
// P, `h` off P along the wall. The fillet is (d - r)^2 + (h - r)^2 = r^2; the
// chamfer is d + h = r. Both are measured, at every vertex, never assumed.
//
// Changing the size is then one scale about the foot, (d, h) -> (d, h) r'/r,
// which lands every vertex on the new blend with both tangent lines still on
// their own faces - WO-1848's "scale about the sharp edge", with the edge now
// allowed to be a curve. Removing it is the same scale to zero: every vertex
// lands on its foot, the band's facets close up and the face and the wall meet
// at their sharp edge.
//
// THE FOOT. Projected onto P, the wall's rail (where band meets wall) is the
// sharp edge itself. A CAD tessellator meshes a blend on a grid, so each band
// vertex stands in the COLUMN of one rail vertex, straight out from the wall:
// that rail vertex is its foot, exactly. A vertex that is in no column (a
// tessellator that does not grid its blends) is footed on the nearest rail
// chord instead, and the proof below holds it to the same tolerance.

import type { Vec3 } from '../types';
import { add, cross, dot, length, normalize, scale, sub } from './types';
import { boundaryCycles, facetNormal, facetPoints, vertexAt, type WeldedMesh } from './topology';
import { faceRegions } from './tangentRim';

/** A facet stands square to P when its normal is this close to perpendicular
 *  (the flat-face flatness slope, 0.57 degrees). */
const SQUARE_SLOPE = 0.01;

/** How far a band vertex may sit off the blend it is proved against: a
 *  hundredth of a millimetre, or 1 % of the blend's size when that is more. */
const fitTolerance = (sizeMm: number): number => Math.max(0.01, 0.01 * sizeMm);

/** Where one band vertex is, read against the sharp edge. */
export interface WallBlendFrame {
  /** the point of the sharp edge it stands on (on P) */
  foot: Vec3;
  /** unit, along P, pointing out from the wall to the vertex */
  out: Vec3;
  /** distance out from the wall along P, mm */
  d: number;
  /** distance off P along the wall, mm */
  h: number;
  /** which closed loop of the sharp edge the foot is on, and how far along
   *  it (mm) - the order a removal closes the part up in */
  loop: number;
  s: number;
}

export interface PreparedWallBlend {
  welded: WeldedMesh;
  /** the band, ascending facet indices */
  band: number[];
  kind: 'fillet' | 'chamfer';
  shape: 'convex' | 'concave';
  /** fillet radius or chamfer leg, mm */
  sizeMm: number;
  /** the flat face: `dot(normal, x) = offsetMm` */
  plane: { normal: Vec3; offsetMm: number };
  /** unit: from P towards the band, along the wall */
  up: Vec3;
  /** every band vertex (welded id) -> where it stands */
  frames: Map<number, WallBlendFrame>;
  /** welded ids shared with the face, with the wall, and neither */
  planeRail: number[];
  wallRail: number[];
  interior: number[];
  /** length of the sharp edge, mm, and of each of its closed loops */
  edgeLengthMm: number;
  loopLengthsMm: number[];
  /** worst distance of a band vertex from the blend it was proved as, mm */
  maxDeviationMm: number;
}

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * Prove that `band` (facet indices of `w`) is a wall blend off the flat face
 * whose facets are `faceFacets`, and measure it. Throws a plain sentence when
 * it is not.
 */
export function proveWallBlend(
  w: WeldedMesh,
  band: readonly number[],
  faceFacets: readonly number[],
): PreparedWallBlend {
  if (band.length === 0) refuse('No facets were chosen, so there is no blend to work on.');
  const bandSet = new Set(band);
  const faceSet = new Set(faceFacets);

  // The face's plane, area-weighted.
  let nSum: Vec3 = [0, 0, 0];
  let cSum: Vec3 = [0, 0, 0];
  let area = 0;
  for (const f of faceFacets) {
    const a = w.areas[f];
    nSum = add(nSum, scale(facetNormal(w, f), a));
    const [p0, p1, p2] = facetPoints(w, f);
    cSum = add(cSum, scale(add(add(p0, p1), p2), a / 3));
    area += a;
  }
  const normal = normalize(nSum);
  const offsetMm = dot(normal, scale(cSum, 1 / area));

  // Everything round the band is the face or the wall; the wall stands square.
  const wallEdges: Array<[number, number]> = [];
  const planeRailSet = new Set<number>();
  const wallRailSet = new Set<number>();
  for (const f of band) {
    for (let k = 0; k < 3; k++) {
      const e = w.edges[w.facetEdges[f * 3 + k]];
      if (e.facets.length !== 2) refuse('This blend runs to an open edge of the part. Nothing was changed.');
      const other = e.facets[0] === f ? e.facets[1] : e.facets[0];
      if (bandSet.has(other)) continue;
      if (faceSet.has(other)) {
        planeRailSet.add(e.a);
        planeRailSet.add(e.b);
      } else if (Math.abs(dot(facetNormal(w, other), normal)) <= SQUARE_SLOPE) {
        wallRailSet.add(e.a);
        wallRailSet.add(e.b);
        wallEdges.push([e.a, e.b]);
      } else {
        refuse(
          'Something other than the face and a wall standing square to it closes this blend off, so ' +
            'LienCAM cannot work out where its sharp edge would be. Nothing was changed.',
        );
      }
    }
  }
  if (planeRailSet.size === 0 || wallRailSet.size === 0) {
    refuse('This blend does not run between a flat face and a wall. Nothing was changed.');
  }
  for (const id of planeRailSet) {
    if (wallRailSet.has(id)) refuse('This blend touches its face and its wall at the same corner. Nothing was changed.');
  }

  // Which side of P the band is on.
  const station = (id: number) => dot(normal, vertexAt(w, id)) - offsetMm;
  let side = 0;
  for (const f of band) for (let k = 0; k < 3; k++) side += station(w.facets[f * 3 + k]);
  const up: Vec3 = side >= 0 ? normal : scale(normal, -1);
  const height = (p: Vec3) => dot(up, p) - dot(up, scale(normal, offsetMm));

  // The sharp edge: the wall rail seen on P, as closed loops.
  const cycles = boundaryCycles(wallEdges);
  if (cycles.loops.length === 0 || cycles.ambiguous.length > 0) {
    refuse('The edge where this blend meets its wall does not close up, so it is not one blend round a wall. Nothing was changed.');
  }
  const onPlane = (p: Vec3): Vec3 => sub(p, scale(normal, dot(normal, p) - offsetMm));
  const rail: RailLoop[] = cycles.loops.map((loop) => {
    const points = loop.map((id) => onPlane(vertexAt(w, id)));
    const at: number[] = [];
    let run = 0;
    for (let i = 0; i < points.length; i++) {
      at.push(run);
      run += length(sub(points[(i + 1) % points.length], points[i]));
    }
    return { ids: loop, points, at, length: run };
  });
  const loopLengthsMm = rail.map((loop) => loop.length);
  const edgeLengthMm = loopLengthsMm.reduce((sum, l) => sum + l, 0);
  const railIndex = new Map<number, { loop: number; index: number }>();
  rail.forEach((loop, l) => loop.ids.forEach((id, index) => railIndex.set(id, { loop: l, index })));

  const bandVertices = new Set<number>();
  for (const f of band) for (let k = 0; k < 3; k++) bandVertices.add(w.facets[f * 3 + k]);

  const frames = new Map<number, WallBlendFrame>();
  for (const id of bandVertices) {
    const p = vertexAt(w, id);
    const q = onPlane(p);
    const h = height(p);
    const onRail = railIndex.get(id);
    if (wallRailSet.has(id) && onRail) {
      frames.set(id, { foot: q, out: [0, 0, 0], d: 0, h, loop: onRail.loop, s: rail[onRail.loop].at[onRail.index] });
      continue;
    }
    frames.set(id, footOf(q, h, rail));
  }

  // The size, read off both rails: how far the face rail stands out from the
  // wall, and how far the wall rail stands off the face.
  const median = (values: number[]) => {
    const sorted = [...values].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const out = median([...planeRailSet].map((id) => (frames.get(id) as WallBlendFrame).d));
  const off = median([...wallRailSet].map((id) => (frames.get(id) as WallBlendFrame).h));
  // The wall rail's height is read straight off P; the face rail's reach goes
  // through a foot. Size by the first, hold the second to it.
  const sizeMm = off;
  if (!(sizeMm > 0)) refuse('This blend has no size. Nothing was changed.');
  const tolerance = fitTolerance(sizeMm);
  if (Math.abs(out - off) > tolerance) {
    refuse(
      `This blend sets the edge back ${out.toFixed(2)} mm along the face and ${off.toFixed(2)} mm up the ` +
        'wall; LienCAM edits a round or an equal chamfer here. Nothing was changed.',
    );
  }
  let worstRail = 0;
  for (const id of planeRailSet) {
    const f = frames.get(id) as WallBlendFrame;
    worstRail = Math.max(worstRail, Math.abs(f.d - sizeMm), Math.abs(f.h));
  }
  for (const id of wallRailSet) {
    const f = frames.get(id) as WallBlendFrame;
    worstRail = Math.max(worstRail, Math.abs(f.h - sizeMm));
  }
  if (worstRail > tolerance) {
    refuse(
      `This blend is not the same size all the way along - it varies by ${worstRail.toFixed(3)} mm. ` +
        'Nothing was changed.',
    );
  }

  // Fillet or chamfer: what the vertices between the rails lie on.
  const interior = [...bandVertices].filter((id) => !planeRailSet.has(id) && !wallRailSet.has(id));
  const offFillet = (f: WallBlendFrame) => Math.abs(Math.hypot(f.d - sizeMm, f.h - sizeMm) - sizeMm);
  const offChamfer = (f: WallBlendFrame) => Math.abs(f.d + f.h - sizeMm) / Math.SQRT2;
  let worstFillet = 0;
  let worstChamfer = 0;
  for (const id of interior) {
    const f = frames.get(id) as WallBlendFrame;
    worstFillet = Math.max(worstFillet, offFillet(f));
    worstChamfer = Math.max(worstChamfer, offChamfer(f));
  }
  const kind: 'fillet' | 'chamfer' = interior.length > 0 && worstFillet <= worstChamfer ? 'fillet' : 'chamfer';
  const maxDeviationMm = Math.max(worstRail, kind === 'fillet' ? worstFillet : worstChamfer);
  if (maxDeviationMm > tolerance) {
    refuse(
      `The facets of this blend are ${maxDeviationMm.toFixed(3)} mm off any round or chamfer between ` +
        'the face and the wall, so LienCAM cannot prove its shape. Nothing was changed.',
    );
  }

  // Convex: the blend took an outside corner off (its facets face away from
  // the face's side); concave: it filled an inside corner.
  let lean = 0;
  for (const f of band) lean += dot(facetNormal(w, f), up) * w.areas[f];
  const shape: 'convex' | 'concave' = lean < 0 ? 'convex' : 'concave';

  return {
    welded: w,
    band: [...band].sort((x, y) => x - y),
    kind,
    shape,
    sizeMm,
    plane: { normal, offsetMm },
    up,
    frames,
    planeRail: [...planeRailSet].sort((x, y) => x - y),
    wallRail: [...wallRailSet].sort((x, y) => x - y),
    interior: interior.sort((x, y) => x - y),
    edgeLengthMm,
    loopLengthsMm,
    maxDeviationMm,
  };
}

interface RailLoop {
  ids: number[];
  points: Vec3[];
  /** arc length at each point */
  at: number[];
  length: number;
}

/** The foot of a vertex projected to `q` on P: the rail vertex whose column it
 *  stands in, else the nearest point of the nearest rail chord. */
function footOf(q: Vec3, h: number, rail: readonly RailLoop[]): WallBlendFrame {
  let found = { loop: 0, index: 0, distance: Infinity };
  rail.forEach((loop, l) => {
    loop.points.forEach((p, i) => {
      const distance = length(sub(q, p));
      if (distance < found.distance) found = { loop: l, index: i, distance };
    });
  });
  const { points, at: arc, length: total } = rail[found.loop];
  const count = points.length;
  const i = found.index;
  const at = points[i];
  const before = points[(i - 1 + count) % count];
  const after = points[(i + 1) % count];
  const tangent = normalize(sub(after, before));
  const toQ = sub(q, at);
  const d = length(toQ);
  if (d === 0) return { foot: at, out: [0, 0, 0], d: 0, h, loop: found.loop, s: arc[i] };
  if (Math.abs(dot(toQ, tangent)) <= 1e-3 * Math.max(1, d)) {
    return { foot: at, out: scale(toQ, 1 / d), d, h, loop: found.loop, s: arc[i] };
  }
  // Not in a column: on the circle through this rail point and the two either
  // side of it (a line when they are in line) - exact for a round or flat
  // wall, where the chords between rail points sit a sagitta inside a round.
  const circle = circleThrough(before, at, after);
  if (circle !== null) {
    const fromCentre = sub(q, circle.centre);
    const r = length(fromCentre);
    if (r > 0) {
      const foot = add(circle.centre, scale(fromCentre, circle.radius / r));
      const span = length(sub(foot, at));
      const ahead = dot(sub(foot, at), sub(after, before)) >= 0;
      const s = ((ahead ? arc[i] + span : arc[i] - span) + total) % total;
      const out = sub(q, foot);
      const dd = length(out);
      return { foot, out: dd > 0 ? scale(out, 1 / dd) : [0, 0, 0], d: dd, h, loop: found.loop, s };
    }
  }
  let foot = at;
  let s = arc[i];
  let bestDistance = d;
  const chords: Array<[Vec3, Vec3, number]> = [
    [before, at, (arc[(i - 1 + count) % count])],
    [at, after, arc[i]],
  ];
  for (const [a, b, start] of chords) {
    const ab = sub(b, a);
    const span = length(ab);
    const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / Math.max(dot(ab, ab), 1e-30)));
    const p = add(a, scale(ab, t));
    const distance = length(sub(q, p));
    if (distance < bestDistance) {
      bestDistance = distance;
      foot = p;
      s = (start + t * span) % total;
    }
  }
  return { foot, out: bestDistance > 0 ? scale(sub(q, foot), 1 / bestDistance) : [0, 0, 0], d: bestDistance, h, loop: found.loop, s };
}

/** The circle through three points (all on P), or null when they are in line. */
function circleThrough(a: Vec3, b: Vec3, c: Vec3): { centre: Vec3; radius: number } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn <= 1e-12 * dot(ab, ab) * dot(ac, ac)) return null;
  const toCentre = scale(add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab))), 1 / (2 * nn));
  return { centre: add(a, toCentre), radius: length(toCentre) };
}

/** Where a band vertex lands when the blend is made `factor` times its size
 *  (0 = taken off: on its foot). */
export function scaledWallBlendVertex(prepared: PreparedWallBlend, id: number, factor: number): Vec3 {
  const f = prepared.frames.get(id) as WallBlendFrame;
  return add(f.foot, add(scale(f.out, f.d * factor), scale(prepared.up, f.h * factor)));
}

/**
 * Every wall blend this mesh proves: grown from each real flat face across its
 * rim, through facets that do not stand square to it. A fillet leaves the face
 * smoothly; a chamfer leaves it at an angle and its straight legs are flat
 * faces of their own, so neither the rim nor the growth asks for smoothness or
 * stops at a face - only at the wall. Each connected band that proves is one
 * blend; a band that does not prove is simply not listed.
 */
export function findWallBlends(w: WeldedMesh): PreparedWallBlend[] {
  const faces = faceRegions(w);
  const found: PreparedWallBlend[] = [];
  const claimed = new Set<number>();
  const across: number[][] = Array.from({ length: w.facetCount }, () => []);
  for (const e of w.edges) {
    if (e.facets.length !== 2) continue;
    across[e.facets[0]].push(e.facets[1]);
    across[e.facets[1]].push(e.facets[0]);
  }
  faces.regions.forEach((faceFacets, region) => {
    if (!faces.isFace(region)) return;
    const normal = faces.normalOf[region];
    const inFace = new Set(faceFacets);
    const visited = new Set<number>();
    const eligible = (facet: number) =>
      !inFace.has(facet) && !claimed.has(facet) && !visited.has(facet) && w.areas[facet] > 0 &&
      Math.abs(dot(facetNormal(w, facet), normal)) > SQUARE_SLOPE;
    for (const f of faceFacets) {
      for (const seed of across[f]) {
        if (!eligible(seed)) continue;
        const band = new Set<number>([seed]);
        visited.add(seed);
        const queue = [seed];
        while (queue.length > 0) {
          const g = queue.pop() as number;
          for (const next of faces.smooth[g]) {
            if (band.has(next) || !eligible(next)) continue;
            band.add(next);
            visited.add(next);
            queue.push(next);
          }
        }
        try {
          found.push(proveWallBlend(w, [...band], faceFacets));
          for (const g of band) claimed.add(g);
        } catch {
          // not a wall blend: not listed
        }
      }
    }
  });
  return found;
}

/** The face a selected band is a wall blend off, for an edit given only the
 *  band: the real flat face along its smooth rim that it proves against. */
export function prepareWallBlendFromBand(w: WeldedMesh, band: readonly number[]): PreparedWallBlend {
  const faces = faceRegions(w);
  const bandSet = new Set(band);
  const candidates = new Set<number>();
  for (const f of band) {
    for (let k = 0; k < 3; k++) {
      for (const next of w.edges[w.facetEdges[f * 3 + k]].facets) {
        if (bandSet.has(next)) continue;
        const region = faces.regionOf[next];
        if (faces.isFace(region)) candidates.add(region);
      }
    }
  }
  let firstError: unknown = null;
  for (const region of candidates) {
    try {
      return proveWallBlend(w, band, faces.regions[region]);
    } catch (err) {
      firstError ??= err;
    }
  }
  if (firstError instanceof Error) throw firstError;
  return refuse(
    'LienCAM could not find the flat face this blend runs off, so it cannot work out where its sharp ' +
      'edge would be. Nothing was changed.',
  );
}

