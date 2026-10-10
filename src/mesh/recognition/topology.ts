// WO-1846: the mesh topology the recogniser stands on.
//
// Port of Next's meshDiagnosis / meshRegionTopology / meshBoundaryCycles onto
// MeshBuffers. Same rules, our data: welding is by EXACT coordinate (Next's
// meshCoordinateKey), never by a blanket epsilon - an epsilon weld over the
// whole mesh invents adjacency, and adjacency is what every later proof is
// built on.
//
// WO-1889 adds ONE narrow exception to that, Next's meshDistanceWeld: after the
// exact weld, a vertex that sits on an OPEN BOUNDARY edge may be welded to one
// other open-boundary vertex within `weldToleranceMm`. That is a crack in the
// export and nothing else - a closed solid has no boundary edges at all, so the
// pass is a no-op on every mesh that already welds shut. Two rules keep it from
// inventing anything: the merge must be MUTUAL (each is the other's only
// candidate within tolerance, so an ambiguous three-way junction is skipped
// rather than guessed), and two vertices of the same facet are never merged, so
// no facet can be collapsed into a degenerate one.

import type { MeshBuffers, Vec3 } from '../types';
import { cross, dot, length, normalize, sub } from './types';

export interface WeldedMesh {
  /** welded vertex positions, x,y,z per vertex */
  positions: Float64Array;
  vertexCount: number;
  /** 3 welded vertex indices per facet, in winding order */
  facets: Int32Array;
  facetCount: number;
  /** unit normal per facet (zero for a degenerate facet) */
  normals: Float64Array;
  /** facet area, mm^2 */
  areas: Float64Array;
  /** undirected edges, `a < b` welded vertex indices */
  edges: MeshEdge[];
  /** facet index -> its 3 edge indices, for (v0,v1),(v1,v2),(v2,v0) */
  facetEdges: Int32Array;
  /** WO-1889: how many cracked-vertex pairs the tolerance weld closed */
  crackWelds: number;
  /** WO-1889: boundary vertices that had more than one candidate within
   *  tolerance and were therefore left alone */
  ambiguousWelds: number;
}

export interface MeshEdge {
  a: number;
  b: number;
  /** the facets using this edge; length 2 on a manifold interior edge */
  facets: number[];
}

export function vertexAt(w: WeldedMesh, index: number): Vec3 {
  const at = index * 3;
  return [w.positions[at], w.positions[at + 1], w.positions[at + 2]];
}

export function facetNormal(w: WeldedMesh, facet: number): Vec3 {
  const at = facet * 3;
  return [w.normals[at], w.normals[at + 1], w.normals[at + 2]];
}

export function facetPoints(w: WeldedMesh, facet: number): [Vec3, Vec3, Vec3] {
  const at = facet * 3;
  return [vertexAt(w, w.facets[at]), vertexAt(w, w.facets[at + 1]), vertexAt(w, w.facets[at + 2])];
}

/**
 * Weld by exact coordinate and build edge adjacency. Degenerate facets keep
 * their index (so source-facet ids stay true) and carry a zero normal.
 *
 * `weldToleranceMm` defaults to 0 - EXACT, as WO-1846 wrote it. The crack weld
 * is opt-in per caller and only `recognizeMeshFeatures` asks for it (WO-1889's
 * outcome is about what the recogniser can find in a cracked export); the mesh
 * EDIT operations that weld here keep the exact behaviour they were written
 * and proved against.
 */
export function weldMesh(mesh: MeshBuffers, weldToleranceMm = 0): WeldedMesh {
  const facetCount = Math.floor(mesh.indices.length / 3);
  const map = new Map<string, number>();
  const coords: number[] = [];
  const facets = new Int32Array(facetCount * 3);

  for (let i = 0; i < facetCount * 3; i++) {
    const v = mesh.indices[i] * 3;
    const x = mesh.positions[v];
    const y = mesh.positions[v + 1];
    const z = mesh.positions[v + 2];
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) {
      id = coords.length / 3;
      coords.push(x, y, z);
      map.set(key, id);
    }
    facets[i] = id;
  }

  const crack = weldCracks(coords, facets, facetCount, weldToleranceMm);
  const positions = Float64Array.from(crack ? crack.coords : coords);
  const w: WeldedMesh = {
    positions,
    vertexCount: positions.length / 3,
    facets,
    facetCount,
    normals: new Float64Array(facetCount * 3),
    areas: new Float64Array(facetCount),
    edges: [],
    facetEdges: new Int32Array(facetCount * 3).fill(-1),
    crackWelds: crack ? crack.welded : 0,
    ambiguousWelds: crack ? crack.ambiguous : 0,
  };

  for (let f = 0; f < facetCount; f++) {
    const [p0, p1, p2] = facetPoints(w, f);
    const raw = cross(sub(p1, p0), sub(p2, p0));
    const l = length(raw);
    w.areas[f] = l / 2;
    if (l > 0) {
      w.normals[f * 3] = raw[0] / l;
      w.normals[f * 3 + 1] = raw[1] / l;
      w.normals[f * 3 + 2] = raw[2] / l;
    }
  }

  const edgeIndex = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a : b) * w.vertexCount + (a < b ? b : a);
  for (let f = 0; f < facetCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = facets[f * 3 + e];
      const b = facets[f * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const k = key(a, b);
      let index = edgeIndex.get(k);
      if (index === undefined) {
        index = w.edges.length;
        w.edges.push({ a: Math.min(a, b), b: Math.max(a, b), facets: [] });
        edgeIndex.set(k, index);
      }
      w.edges[index].facets.push(f);
      w.facetEdges[f * 3 + e] = index;
    }
  }
  return w;
}

/**
 * WO-1889: close hairline cracks, in place, on the EXACTLY welded vertex ids.
 *
 * Only vertices on an open boundary edge are candidates, so a mesh that already
 * closes shut comes out of here bit-identical (`undefined`). A vertex is merged
 * only when it and exactly one other boundary vertex are each other's sole
 * candidate within tolerance; three coincident boundary vertices (a T-junction,
 * or two cracks meeting) leave all three alone and are counted as ambiguous.
 * Vertices sharing a facet are never merged - that would collapse the facet.
 * The surviving position is the LOWER-indexed vertex's own coordinates: a point
 * the file actually contains, never an invented average.
 */
function weldCracks(
  coords: readonly number[],
  facets: Int32Array,
  facetCount: number,
  tolerance: number,
): { coords: number[]; welded: number; ambiguous: number } | undefined {
  const vertexCount = coords.length / 3;
  if (!(tolerance > 0) || vertexCount === 0) return undefined;

  const uses = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a : b) * vertexCount + (a < b ? b : a);
  for (let f = 0; f < facetCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = facets[f * 3 + e];
      const b = facets[f * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const k = edgeKey(a, b);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  const onBoundary = new Uint8Array(vertexCount);
  let boundaryCount = 0;
  for (const [k, count] of uses) {
    if (count === 1) {
      const b = k % vertexCount;
      const a = (k - b) / vertexCount;
      for (const v of [a, b]) if (!onBoundary[v]) { onBoundary[v] = 1; boundaryCount++; }
    }
  }
  if (boundaryCount === 0) return undefined;

  const facetsOf = new Map<number, number[]>();
  for (let f = 0; f < facetCount; f++) {
    for (let e = 0; e < 3; e++) {
      const v = facets[f * 3 + e];
      if (!onBoundary[v]) continue;
      const list = facetsOf.get(v);
      if (list) list.push(f);
      else facetsOf.set(v, [f]);
    }
  }

  const cells = new Map<string, number[]>();
  const cellOf = (v: number): [number, number, number] => [
    Math.floor(coords[v * 3] / tolerance),
    Math.floor(coords[v * 3 + 1] / tolerance),
    Math.floor(coords[v * 3 + 2] / tolerance),
  ];
  for (let v = 0; v < vertexCount; v++) {
    if (!onBoundary[v]) continue;
    const [i, j, k] = cellOf(v);
    const key = `${i},${j},${k}`;
    const list = cells.get(key);
    if (list) list.push(v);
    else cells.set(key, [v]);
  }

  const partner = new Int32Array(vertexCount).fill(-1);
  const AMBIGUOUS = -2;
  let ambiguous = 0;
  for (let v = 0; v < vertexCount; v++) {
    if (!onBoundary[v]) continue;
    const [ci, cj, ck] = cellOf(v);
    const mine = facetsOf.get(v) as number[];
    const found: number[] = [];
    for (let di = -1; di <= 1 && found.length < 2; di++) {
      for (let dj = -1; dj <= 1 && found.length < 2; dj++) {
        for (let dk = -1; dk <= 1 && found.length < 2; dk++) {
          for (const u of cells.get(`${ci + di},${cj + dj},${ck + dk}`) ?? []) {
            if (u === v) continue;
            const dx = coords[u * 3] - coords[v * 3];
            const dy = coords[u * 3 + 1] - coords[v * 3 + 1];
            const dz = coords[u * 3 + 2] - coords[v * 3 + 2];
            if (Math.hypot(dx, dy, dz) > tolerance) continue;
            if ((facetsOf.get(u) as number[]).some((f) => mine.includes(f))) continue;
            found.push(u);
            if (found.length >= 2) break;
          }
        }
      }
    }
    if (found.length === 1) partner[v] = found[0];
    else if (found.length > 1) { partner[v] = AMBIGUOUS; ambiguous++; }
  }

  const remap = new Int32Array(vertexCount);
  let welded = 0;
  for (let v = 0; v < vertexCount; v++) {
    const u = partner[v];
    if (u >= 0 && partner[u] === v) {
      remap[v] = Math.min(v, u);
      if (v < u) welded++;
    } else remap[v] = v;
  }
  if (welded === 0) return undefined;

  const newIndex = new Int32Array(vertexCount).fill(-1);
  const out: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    const rep = remap[v];
    if (newIndex[rep] < 0) {
      newIndex[rep] = out.length / 3;
      out.push(coords[rep * 3], coords[rep * 3 + 1], coords[rep * 3 + 2]);
    }
  }
  for (let i = 0; i < facetCount * 3; i++) facets[i] = newIndex[remap[facets[i]]];
  return { coords: out, welded, ambiguous };
}

/** tan of the angle between two unit normals is within `slope`, and they point
 *  the same way. Next's meshNormalsWithin, in float64. */
export function normalsWithin(a: Vec3, b: Vec3, slope: number): boolean {
  const projection = dot(a, b);
  if (projection <= 0) return false;
  return length(cross(a, b)) <= slope * projection;
}

/**
 * Deterministic connected partition (Next's partitionMeshTriangles). A facet
 * joins the group it is smoothly adjacent to UNLESS it also has a blocked edge
 * to a facet already in that group - an alternate smooth path must not be able
 * to walk around a sharp edge. `accept` is an extra fixed-anchor predicate
 * (the planar pass uses it for the anchor plane).
 */
export function partitionFacets(
  facetCount: number,
  eligible: (facet: number) => boolean,
  smooth: ReadonlyArray<number[]>,
  blocked: ReadonlyArray<number[]>,
  accept: (anchor: number, candidate: number) => boolean = () => true,
): number[][] {
  const membership = new Int32Array(facetCount).fill(-1);
  const groups: number[][] = [];
  for (let start = 0; start < facetCount; start++) {
    if (!eligible(start) || membership[start] >= 0) continue;
    const index = groups.length;
    const group: number[] = [];
    const pending = [start];
    const rejected = new Set<number>();
    membership[start] = index;
    while (pending.length) {
      const facet = pending.pop() as number;
      group.push(facet);
      for (const next of smooth[facet]) {
        if (membership[next] >= 0 || rejected.has(next) || !eligible(next)) continue;
        if (blocked[next].some((id) => membership[id] === index) || !accept(start, next)) {
          rejected.add(next);
          continue;
        }
        membership[next] = index;
        pending.push(next);
      }
    }
    groups.push(group.sort((x, y) => x - y));
  }
  return groups;
}

export interface BoundaryCycles {
  loops: number[][];
  /** boundary vertices with anything other than exactly 2 boundary neighbours */
  ambiguous: number[];
}

/** Next's meshBoundaryCycles: chain unique undirected edges into closed loops,
 *  and leave anything ambiguous explicitly ambiguous instead of coercing it. */
export function boundaryCycles(edges: ReadonlyArray<[number, number]>): BoundaryCycles {
  const neighbours = new Map<number, number[]>();
  for (const [a, b] of edges) {
    for (const [u, v] of [[a, b], [b, a]] as Array<[number, number]>) {
      const list = neighbours.get(u) ?? [];
      list.push(v);
      neighbours.set(u, list);
    }
  }
  const ambiguous = [...neighbours].filter(([, n]) => n.length !== 2).map(([v]) => v).sort((a, b) => a - b);
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of [...neighbours.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const v = pending.pop() as number;
      component.push(v);
      for (const n of neighbours.get(v) as number[]) {
        if (!seen.has(n)) {
          seen.add(n);
          pending.push(n);
        }
      }
    }
    if (component.some((v) => (neighbours.get(v) as number[]).length !== 2)) continue;
    const loop: number[] = [];
    let previous = -1;
    let current = start;
    do {
      loop.push(current);
      const next = (neighbours.get(current) as number[]).find((v) => v !== previous) as number;
      previous = current;
      current = next;
    } while (current !== start);
    loops.push(loop);
  }
  return { loops, ambiguous };
}

/** The boundary edges of a facet set: every edge with exactly one incident
 *  facet inside it (an open mesh boundary edge counts too). */
export function regionBoundaryEdges(w: WeldedMesh, region: ReadonlySet<number>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const edge of w.edges) {
    const inside = edge.facets.filter((f) => region.has(f)).length;
    if (inside === 1) out.push([edge.a, edge.b]);
  }
  return out;
}

/** The facets OUTSIDE `region` that share a boundary edge with it. */
export function regionNeighbourFacets(w: WeldedMesh, region: ReadonlySet<number>): number[] {
  const out = new Set<number>();
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    const inside = edge.facets.filter((f) => region.has(f));
    if (inside.length !== 1) continue;
    out.add(edge.facets.find((f) => !region.has(f)) as number);
  }
  return [...out].sort((a, b) => a - b);
}

/** Smooth / blocked adjacency lists for one slope setting. */
export function buildAdjacency(w: WeldedMesh, slope: number): { smooth: number[][]; blocked: number[][] } {
  const smooth: number[][] = Array.from({ length: w.facetCount }, () => []);
  const blocked: number[][] = Array.from({ length: w.facetCount }, () => []);
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    const [a, b] = edge.facets;
    const target = normalsWithin(facetNormal(w, a), facetNormal(w, b), slope) ? smooth : blocked;
    target[a].push(b);
    target[b].push(a);
  }
  return { smooth, blocked };
}

/** Is the mesh adjacency safe to reason about at all? Next refuses region
 *  recognition outright on ambiguous topology; so do we. */
export function ambiguousTopology(w: WeldedMesh): boolean {
  for (let f = 0; f < w.facetCount; f++) if (w.areas[f] === 0) return true;
  for (const edge of w.edges) if (edge.facets.length > 2) return true;
  return false;
}

/** Planar regions: smooth adjacency AND every facet within `toleranceMm` of
 *  the anchor facet's plane (Next's recognizeMeshPlanarRegions with settings). */
export function planarRegions(w: WeldedMesh, toleranceMm: number, slope: number): number[][] {
  const { smooth, blocked } = buildAdjacency(w, slope);
  return partitionFacets(
    w.facetCount,
    (f) => w.areas[f] > 0,
    smooth,
    blocked,
    (anchor, candidate) => {
      const n = facetNormal(w, anchor);
      const origin = facetPoints(w, anchor)[0];
      if (!normalsWithin(n, facetNormal(w, candidate), slope)) return false;
      return facetPoints(w, candidate).every((p) => Math.abs(dot(n, sub(p, origin))) <= toleranceMm);
    },
  );
}

/**
 * WO-1889: the distinct dihedral slopes INSIDE one region, largest first.
 *
 * Region growing joins two facets when the tangent of the angle between their
 * normals is within `maxNormalSlope`, so a transition shallower than that -
 * a 20 degree chamfer off its bore, two cone bands of an exporter-split
 * countersink - lands inside a single region and the region then proves as
 * nothing. These are the places that region could be cut: every value is a real
 * dihedral the mesh contains, so a cut never falls anywhere the surface is
 * smooth.
 *
 * Each returned value is a THRESHOLD for `splitRegionAtSlope`, sitting just
 * below one cluster of equal dihedrals so that every edge of that cluster is
 * cut and everything smoother survives. Clustering is relative (1e-6): the same
 * seam of a tessellated part gives 64 slopes that agree to eight digits and
 * differ in the ninth, and cutting at one of them would leave the rest of the
 * seam welded.
 */
export function internalSlopeCuts(w: WeldedMesh, facets: readonly number[]): number[] {
  const inside = new Set(facets);
  const slopes: number[] = [];
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    const [a, b] = edge.facets;
    if (!inside.has(a) || !inside.has(b)) continue;
    const na = facetNormal(w, a);
    const nb = facetNormal(w, b);
    const projection = dot(na, nb);
    slopes.push(projection <= 0 ? Number.MAX_VALUE : length(cross(na, nb)) / projection);
  }
  slopes.sort((x, y) => y - x);
  const cuts: number[] = [];
  let clusterMin = Infinity;
  for (const s of slopes) {
    if (clusterMin !== Infinity && s >= clusterMin * (1 - 1e-6)) {
      clusterMin = Math.min(clusterMin, s);
      cuts[cuts.length - 1] = clusterMin * (1 - 1e-6);
      continue;
    }
    clusterMin = s;
    cuts.push(s * (1 - 1e-6));
  }
  return cuts.filter((cut) => cut > 0);
}

/**
 * WO-1889: split one region into connected parts, keeping only the internal
 * edges whose dihedral slope is strictly BELOW `cut`. Each part is ascending,
 * and the parts are ordered by their smallest facet, so a split is
 * deterministic and a region that does not actually break at `cut` comes back
 * as itself.
 */
export function splitRegionAtSlope(w: WeldedMesh, facets: readonly number[], cut: number): number[][] {
  const inside = new Set(facets);
  const links = new Map<number, number[]>(facets.map((f) => [f, []]));
  for (const edge of w.edges) {
    if (edge.facets.length !== 2) continue;
    const [a, b] = edge.facets;
    if (!inside.has(a) || !inside.has(b)) continue;
    const na = facetNormal(w, a);
    const nb = facetNormal(w, b);
    const projection = dot(na, nb);
    const slope = projection <= 0 ? Infinity : length(cross(na, nb)) / projection;
    if (!(slope < cut)) continue;
    (links.get(a) as number[]).push(b);
    (links.get(b) as number[]).push(a);
  }
  const seen = new Set<number>();
  const parts: number[][] = [];
  for (const start of [...facets].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const part: number[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const f = pending.pop() as number;
      part.push(f);
      for (const n of links.get(f) as number[]) {
        if (seen.has(n)) continue;
        seen.add(n);
        pending.push(n);
      }
    }
    parts.push(part.sort((a, b) => a - b));
  }
  return parts.sort((a, b) => a[0] - b[0]);
}

/** A facet's own plane deviation from an anchor plane, for reporting. */
export function planeDeviation(w: WeldedMesh, anchor: number, facets: readonly number[]): number {
  const n = facetNormal(w, anchor);
  const origin = facetPoints(w, anchor)[0];
  let worst = 0;
  for (const f of facets) {
    for (const p of facetPoints(w, f)) worst = Math.max(worst, Math.abs(dot(n, sub(p, origin))));
  }
  return worst;
}

export { normalize };
