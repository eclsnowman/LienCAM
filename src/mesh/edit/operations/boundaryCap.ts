// WO-1847: closing the opening that removing facets leaves behind.
//
// Port of Next's meshBoundaryCap + meshPlanarLoop (and the loop chaining under
// them) onto MeshBuffers. The whole of "fill a hole" is these two steps and no
// boolean at all: delete the facets that make the feature, then re-close the
// rim they leave. Next proves the rim exactly with bigint predicates; we do the
// same proof in float64 against a stated tolerance, for the reason WO-1846
// already logged (src/mesh/recognition/types.ts): a binary STL carries float32
// coordinates, so exactness downstream of them buys an exact answer about
// numbers the file never had. What is NOT given up is the proof itself - a rim
// that is not flat, not a single ring, or not consistently wound is REFUSED by
// name, never capped approximately.
//
// Layering note: this reaches sideways into `../../recognition/topology` for
// the weld and the boundary-cycle chaining rather than copying them. That
// direction is new (recognition already reads `../edit/idView`) but it is not a
// cycle: topology.ts imports only recognition/types and mesh/types, neither of
// which imports anything under edit/.

import type { MeshBuffers, Vec3 } from '../../types';
import { boundaryCycles, vertexAt, weldMesh } from '../../recognition/topology';
import { facetCount, facetVertices } from '../idView';

/**
 * How far a rim may bend out of its own best-fit plane and still be capped, mm.
 *
 * This is a FLATNESS budget, not a machining tolerance. A rim built from the
 * float32 vertices of an STL whose designer meant it flat lands inside a
 * micron; a rim that genuinely curves (a hole through a pipe wall, a slice
 * across a scan) bends by tenths of a millimetre or more and is refused with
 * its measured bend in the sentence.
 */
export const DEFAULT_CAP_FLATNESS_MM = 1e-3;

export interface BoundaryCapResult {
  /** the cap facets, each three corner positions taken from EXISTING rim
   *  vertices - no coordinate is invented, so the cap welds to the rim exactly */
  triangles: Array<[Vec3, Vec3, Vec3]>;
  /** how many rims were closed */
  loopCount: number;
  /** worst measured bend of any capped rim, mm (0 for a perfectly flat rim) */
  maxBendMm: number;
}

export interface FacetRemoval {
  /** the input facet indices that survive, ascending */
  keptFacets: number[];
  /** those facets alone, as a mesh. NOT capped - see `capExposedBoundary`. */
  mesh: MeshBuffers;
}

/** The facets of `mesh` that are not in `removed`, ascending. */
export function keptFacetsOf(mesh: MeshBuffers, removed: ReadonlySet<number>): number[] {
  const kept: number[] = [];
  const total = facetCount(mesh);
  for (let f = 0; f < total; f++) if (!removed.has(f)) kept.push(f);
  return kept;
}

/** A mesh from explicit facet corners, in the unwelded form an STL is already
 *  in (positions per corner, indices 0..3n-1). Every coordinate is copied
 *  verbatim, so float32 values round-trip exactly and nothing moves. */
export function facetSoup(facets: ReadonlyArray<readonly [Vec3, Vec3, Vec3]>): MeshBuffers {
  const positions = new Float32Array(facets.length * 9);
  const indices = new Uint32Array(facets.length * 3);
  let at = 0;
  for (const facet of facets) {
    for (const corner of facet) {
      positions[at] = corner[0];
      positions[at + 1] = corner[1];
      positions[at + 2] = corner[2];
      at += 3;
    }
  }
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/**
 * Delete facets and stop there.
 *
 * This is the HALF of a removal, kept separate on purpose: it is what the
 * negative control runs. Skip the cap and the result has an open rim, which is
 * exactly what the watertight assertion must fail on.
 */
export function removeFacets(mesh: MeshBuffers, removed: ReadonlySet<number>): FacetRemoval {
  const keptFacets = keptFacetsOf(mesh, removed);
  return { keptFacets, mesh: facetSoup(keptFacets.map((f) => facetVertices(mesh, f))) };
}

/**
 * The cap facets that re-close every rim the surviving facets now expose.
 *
 * THROWS, with a sentence naming what the software cannot do, when a rim is not
 * flat, branches instead of closing, is wound inconsistently, or crosses
 * itself. The caller applies nothing in that case, so the part is unchanged
 * (LIENCAM.md rule 11: the refusal names a thing we cannot do, and it never
 * asks the operator to go fix his file).
 *
 * A rim that was ALREADY open before the removal is left alone - filling a hole
 * the operator did not ask about would be an edit he never made.
 */
export function capExposedBoundary(
  source: MeshBuffers,
  keptFacets: readonly number[],
  options: { flatnessMm?: number } = {},
): BoundaryCapResult {
  const flatnessMm = options.flatnessMm ?? DEFAULT_CAP_FLATNESS_MM;
  const w = weldMesh(source);
  const kept = new Set(keptFacets);

  // Rims: every welded edge with exactly ONE surviving facet on it.
  const exposed: Array<[number, number]> = [];
  const fresh = new Set<number>();
  for (const edge of w.edges) {
    let inside = 0;
    for (const f of edge.facets) if (kept.has(f)) inside++;
    if (inside !== 1) continue;
    exposed.push([edge.a, edge.b]);
    // "fresh" = this edge is open BECAUSE of the removal, not before it.
    if (edge.facets.length > 1) {
      fresh.add(edge.a);
      fresh.add(edge.b);
    }
  }
  if (exposed.length === 0) return { triangles: [], loopCount: 0, maxBendMm: 0 };

  const { loops, ambiguous } = boundaryCycles(exposed);
  if (ambiguous.some((v) => fresh.has(v))) {
    refuse(
      'Removing these facets leaves a rim that branches instead of closing into one ring, ' +
        'so LienCAM cannot tell what shape to fill. Nothing was changed.',
    );
  }

  // Directed corner uses of the SURVIVING facets: the cap must traverse each
  // rim edge the other way round, which is what makes the result consistently
  // wound without ever guessing an outward direction.
  const stride = w.vertexCount;
  const used = new Set<number>();
  for (const f of keptFacets) {
    const base = f * 3;
    const a = w.facets[base];
    const b = w.facets[base + 1];
    const c = w.facets[base + 2];
    used.add(a * stride + b);
    used.add(b * stride + c);
    used.add(c * stride + a);
  }

  const triangles: Array<[Vec3, Vec3, Vec3]> = [];
  let loopCount = 0;
  let maxBendMm = 0;
  for (const loop of loops) {
    if (!loop.some((v) => fresh.has(v))) continue; // a rim that was already open
    if (loop.length < 3) {
      refuse(
        `This opening's rim has only ${loop.length} corner(s), which is not enough to close. ` +
          'Nothing was changed.',
      );
    }
    const ring = orientRing(loop, used, stride);
    const points = ring.map((v) => vertexAt(w, v));
    const plane = fitPlane(points);
    if (plane.bendMm > flatnessMm) {
      refuse(
        'LienCAM can only close an opening whose rim lies flat in one plane. This rim bends ' +
          `${plane.bendMm.toFixed(3)} mm out of flat, so closing it would take a curved patch ` +
          'LienCAM cannot build. Nothing was changed.',
      );
    }
    for (const [i, j, k] of triangulateRing(points, plane.normal)) {
      triangles.push([points[i], points[j], points[k]]);
    }
    maxBendMm = Math.max(maxBendMm, plane.bendMm);
    loopCount++;
  }
  return { triangles, loopCount, maxBendMm };
}

// ---------------------------------------------------------------------------

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * The rim in the direction the CAP must run: the reverse of however the
 * surviving surface already traverses each of its edges. Refuses a rim the
 * surface walks inconsistently, because then there is no side to call outside.
 */
function orientRing(loop: readonly number[], used: ReadonlySet<number>, stride: number): number[] {
  let reverse: boolean | undefined;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const forward = used.has(a * stride + b);
    const backward = used.has(b * stride + a);
    if (forward === backward) {
      refuse(
        'The facets around this opening are wound inconsistently, so LienCAM cannot tell which ' +
          'side of the fill is the outside. Nothing was changed.',
      );
    }
    if (reverse === undefined) reverse = forward;
    else if (reverse !== forward) {
      refuse(
        'The facets around this opening are wound inconsistently, so LienCAM cannot tell which ' +
          'side of the fill is the outside. Nothing was changed.',
      );
    }
  }
  const ring = [...loop];
  if (reverse) ring.reverse();
  return ring;
}

/** Newell plane of the rim, plus the worst out-of-plane distance on it. The
 *  normal follows the ring's own order by the right-hand rule, so the ring runs
 *  counter-clockwise seen from `normal`. */
function fitPlane(points: readonly Vec3[]): { normal: Vec3; bendMm: number } {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const l = Math.hypot(nx, ny, nz);
  if (l === 0) {
    refuse(
      "This opening's rim encloses no area, so there is nothing for LienCAM to fill. " +
        'Nothing was changed.',
    );
  }
  const normal: Vec3 = [nx / l, ny / l, nz / l];
  const centroid: Vec3 = [cx / points.length, cy / points.length, cz / points.length];
  let bendMm = 0;
  for (const p of points) {
    const d =
      normal[0] * (p[0] - centroid[0]) +
      normal[1] * (p[1] - centroid[1]) +
      normal[2] * (p[2] - centroid[2]);
    bendMm = Math.max(bendMm, Math.abs(d));
  }
  return { normal, bendMm };
}

/**
 * Index triples over the rim, wound the same way the rim runs.
 *
 * A strictly convex rim (every bore, every boss base) fans from its first
 * corner - the cheap, exact answer. Anything else is ear-clipped in the rim's
 * own plane, which is Next's `triangulateMeshPlanarLoop`: no vertex is moved
 * and none is added, so the cap still welds to the rim exactly. A rim that
 * crosses or touches itself has no valid ear and is refused by name.
 */
function triangulateRing(points: readonly Vec3[], normal: Vec3): Array<[number, number, number]> {
  const flat = projectToPlane(points, normal);
  const n = flat.length;
  let convex = true;
  for (let i = 0; i < n && convex; i++) {
    if (turn(flat[(i + n - 1) % n], flat[i], flat[(i + 1) % n]) <= 0) convex = false;
  }
  if (convex) {
    return Array.from({ length: n - 2 }, (_, i) => [0, i + 1, i + 2] as [number, number, number]);
  }

  const remaining = Array.from({ length: n }, (_, i) => i);
  const out: Array<[number, number, number]> = [];
  while (remaining.length > 3) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const previous = remaining[(i + remaining.length - 1) % remaining.length];
      const current = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      if (turn(flat[previous], flat[current], flat[next]) <= 0) continue;
      const blocked = remaining.some(
        (id) =>
          id !== previous &&
          id !== current &&
          id !== next &&
          turn(flat[previous], flat[current], flat[id]) >= 0 &&
          turn(flat[current], flat[next], flat[id]) >= 0 &&
          turn(flat[next], flat[previous], flat[id]) >= 0,
      );
      if (blocked) continue;
      out.push([previous, current, next]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      refuse(
        "This opening's rim crosses or touches itself, so LienCAM cannot close it with flat " +
          'triangles. Nothing was changed.',
      );
    }
  }
  out.push([remaining[0], remaining[1], remaining[2]]);
  return out;
}

/** The rim in its own plane, as 2D points, keeping its orientation. */
function projectToPlane(points: readonly Vec3[], normal: Vec3): Array<[number, number]> {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ux = normal[1] * seed[2] - normal[2] * seed[1];
  const uy = normal[2] * seed[0] - normal[0] * seed[2];
  const uz = normal[0] * seed[1] - normal[1] * seed[0];
  const ul = Math.hypot(ux, uy, uz);
  const u: Vec3 = [ux / ul, uy / ul, uz / ul];
  const v: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  return points.map((p) => [
    p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
    p[0] * v[0] + p[1] * v[1] + p[2] * v[2],
  ]);
}

/** Twice the signed area of a-b-c: positive when the turn is counter-clockwise. */
function turn(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
