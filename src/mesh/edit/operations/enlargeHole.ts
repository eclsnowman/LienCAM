// WO-1850 / ADR-0051 s3: bore a hole on an STL to a new diameter.
//
// The operator picks a round feature WO-1846 proved in his part, types the
// diameter he wants, and LienCAM re-bores it coaxially, to the depth it
// already has. One journal entry, one undo step, replayed over the imported
// bytes like every other edit.
//
// HOW, and why this one needs a kernel when WO-1847's fill did not: filling a
// hole is a re-close of a rim the part already has, so it is done with the
// part's own corners. Boring is a CUT - the new wall runs through material
// that is currently solid and through facets that currently belong to other
// features. That is a boolean, and we already ship one: manifold-3d 3.5.1
// (src/mesh/manifoldOps.ts). Next's f64 Manifold build is NOT imported and
// neither is its mesh kernel (this order's fence): an STL is a tessellated
// approximation already, and float32 is finer than the chord error the facets
// themselves carry.
//
// WHAT IT CUTS WITH: a coaxial prism at the new radius, with its corners ON
// the circle - the same convention the product's own fixtures and every
// slicer use for a round hole, so what WO-1846 measures back out of the
// result is the diameter that was asked for. Its open end is extended clear
// past the part; a blind hole's closed end stops exactly at its floor plane,
// which is what keeps the depth and the floor.
//
// SHRINKING IS NOT REFUSED (architect audit 2026-09-22, item 1; LIENCAM.md
// rule 11). A subtraction cannot make a hole smaller - so a smaller diameter
// FILLS the bore and cuts the new one, both inside ONE record, and the line
// the operator reads says so: "Filled the 8.00 mm hole and bored 6.00 mm".
//
// DECIDE-AND-LOG (rule 3), two calls:
//   - The two halves are ONE record, not two. The audit asked for them "as
//     edits in the journal" with "undo ... in one step"; two records cannot
//     give one undo step through the store's history, and a fill left behind
//     on its own would be a state the operator never asked for.
//   - The fill is a UNION with a plug prism, not WO-1847's facet-delete-and-
//     cap. Measured, 2026-09-23: WO-1847's cap is an ear-clipped polygon, so
//     the vertices the new bore inherits from it are asymmetric, the
//     least-squares axis WO-1846 fits to the finished bore comes back 0.4 um
//     off centre, and the part's own top face then reads as an obstruction
//     inside the corridor - LienCAM cuts the right hole and then cannot prove
//     it. A plug prism shares the cutter's symmetry, and both halves go
//     through one kernel with one ancestry story.

import { computeBoundingBox } from '../../analysis';
import { DEFAULT_FEATURE_OPTIONS, type FeatureKind, type RecognizedFeature } from '../../recognition';
import { vertexAt, weldMesh, type WeldedMesh } from '../../recognition/topology';
import { ManifoldKernel, type ManifoldWasmModule } from '../../manifoldKernel';
import {
  booleanMeshWithAncestry,
  BOOLEAN_TRIANGLE_ADDED,
  setSharedManifoldModule,
  sharedManifoldModule,
} from '../../manifoldOps';
import type { MeshBuffers, Vec3 } from '../../types';
import { facetCount, facetVertices, identityAncestry, vertexCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';

export const ENLARGE_HOLE_KIND = 'enlarge-hole';
export const ENLARGE_HOLE_VERSION = 1;

/** Corners of the cutting prism sit on the circle; this is how far inside the
 *  asked-for radius a chord midpoint is allowed to fall, mm. 0.005 is fifty
 *  times finer than WO-1846's 0.25 mm recognition budget, so the bore this
 *  cuts reads back as the diameter that was typed. */
const CHORD_BUDGET_MM = 0.005;
const MIN_SEGMENTS = 32;
const MAX_SEGMENTS = 512;
/** Corner count is rounded UP to a multiple of this. MEASURED, not taste: a
 *  prism whose corner count is not a multiple of 8 has no exact quadrant
 *  symmetry, so the least-squares axis WO-1846 fits to the finished bore comes
 *  back tilted by ~1e-25 - and that is enough to put every facet of the part's
 *  own top and bottom face a hair off the bore's end stations, which makes
 *  WO-1846 read them as obstructions INSIDE the corridor and refuse to prove
 *  the hole it just cut. 46 corners refused; 48, 64, 72, 96 and 128 all proved
 *  (2026-09-23). The part is right either way; this is what makes the software
 *  able to SAY so. */
const SEGMENT_QUANTUM = 8;

/** A facet whose normal is this close to parallel with the axis is a floor or
 *  a cap, not a wall: |cos| >= 0.9 is 25.8 degrees off the axis. */
const CAP_NORMAL_COSINE = 0.9;

export interface EnlargeHoleParameters {
  /** which WO-1846 feature this was, for the line the operator reads */
  feature: FeatureKind;
  /** the diameter it had when he asked, mm - reported, and the thing the new
   *  one is compared against to know whether this bores or fills-and-bores */
  fromDiameterMm: number;
  /** the diameter he asked for, mm */
  diameterMm: number;
  /** a point on the bore axis (WO-1846's `feature.axis.origin`) */
  axisOrigin: [number, number, number];
  /** the bore axis direction (WO-1846's `feature.axis.direction`). WO-2117: a
   *  depth edit records it pointing OUT of the hole's opening, the end its
   *  depth is measured from. */
  axisDirection: [number, number, number];
  /** WO-2117: a depth edit - the depth he asked for, mm from the opening... */
  depthMm?: number;
  /** Measured selected cylinder extent: the shrink plug stays inside it. */
  boreRangeMm?: [number, number];
  /** Diameter-step cutter exits here; the other end stays at the shoulder. */
  boreOpenEnd?: 'low' | 'high';
  /** ...or right through the part */
  through?: true;
  /** WO-2117: the depth it had when he asked, mm - reported */
  fromDepthMm?: number;
  /** WO-2117: it was a through hole when he asked */
  fromThrough?: true;
}

const PARAMETER_KEYS = new Set([
  'feature',
  'fromDiameterMm',
  'diameterMm',
  'axisOrigin',
  'axisDirection',
  'depthMm',
  'through',
  'fromDepthMm',
  'fromThrough',
  'boreRangeMm',
  'boreOpenEnd',
]);

const FEATURE_WORDS: Record<FeatureKind, string> = {
  'through-hole': 'through hole',
  'blind-hole': 'blind hole',
  boss: 'boss',
  counterbore: 'counterbore',
  countersink: 'countersink',
  'chamfered-hole': 'chamfered hole',
};

// ---------------------------------------------------------------- vectors

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l === 0) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Any unit vector perpendicular to `axis`, chosen deterministically so the
 *  same edit replays to the same triangles on every machine. */
function perpendicular(axis: Vec3): Vec3 {
  const smallest = Math.abs(axis[0]) <= Math.abs(axis[1])
    ? (Math.abs(axis[0]) <= Math.abs(axis[2]) ? 0 : 2)
    : (Math.abs(axis[1]) <= Math.abs(axis[2]) ? 1 : 2);
  const seed: Vec3 = [0, 0, 0];
  seed[smallest] = 1;
  return unit(cross(axis, seed));
}

// ------------------------------------------------------------ the geometry

/** How far along `axis` from `origin` a point sits. */
const station = (point: Vec3, origin: Vec3, axis: Vec3): number => dot(sub(point, origin), axis);

interface CutSpan {
  /** low station of the prism to subtract */
  from: number;
  /** high station of the prism to subtract */
  to: number;
  /** true when the bore is open at BOTH ends and the prism runs clear through */
  through: boolean;
  /** the hole's OWN extent, face to face or face to floor - what a plug has
   *  to fill, with nothing sticking out past the part */
  holeFrom: number;
  holeTo: number;
}

/**
 * The stretch of axis the new bore has to occupy, read off the facets the
 * operator selected.
 *
 * A hole's own facets span exactly its depth. An end that has a floor or cap
 * among those facets is CLOSED and the cut stops at it - that is the blind
 * hole keeping its depth and its floor. An open end is pushed clear past the
 * part so the bore breaks out cleanly instead of leaving a skin.
 */
function cutSpan(mesh: MeshBuffers, facets: readonly number[], origin: Vec3, axis: Vec3): CutSpan {
  let low = Infinity;
  let high = -Infinity;
  let capAtLow = false;
  let capAtHigh = false;
  const ends: Array<{ station: number; cap: boolean }> = [];
  for (const facet of facets) {
    const [a, b, c] = facetVertices(mesh, facet);
    const stations = [station(a, origin, axis), station(b, origin, axis), station(c, origin, axis)];
    for (const s of stations) {
      if (s < low) low = s;
      if (s > high) high = s;
    }
    const normal = unit(cross(sub(b, a), sub(c, a)));
    const cap = Math.abs(dot(normal, axis)) >= CAP_NORMAL_COSINE;
    ends.push({ station: (stations[0] + stations[1] + stations[2]) / 3, cap });
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    throw new Error(
      'The facets of this hole do not run along its axis, so LienCAM cannot tell how deep to bore. ' +
        'Nothing was changed.',
    );
  }
  // A cap in the lower/upper tenth of the selection's own extent closes that
  // end. The tenth is the band a flat floor's facets fall in; a wall facet
  // spans far more than that and never lands wholly inside it.
  const band = (high - low) / 10;
  for (const end of ends) {
    if (!end.cap) continue;
    if (end.station <= low + band) capAtLow = true;
    if (end.station >= high - band) capAtHigh = true;
  }

  const box = computeBoundingBox(mesh);
  let partLow = Infinity;
  let partHigh = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const point: Vec3 = [
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ];
    const s = station(point, origin, axis);
    if (s < partLow) partLow = s;
    if (s > partHigh) partHigh = s;
  }
  const margin = Math.max(1, (partHigh - partLow) * 0.01);
  return {
    from: capAtLow ? low : Math.min(low, partLow) - margin,
    to: capAtHigh ? high : Math.max(high, partHigh) + margin,
    through: !capAtLow && !capAtHigh,
    holeFrom: low,
    holeTo: high,
  };
}

/**
 * How much wider than the bore the plug that fills it has to be.
 *
 * Its flat sides must swallow the tessellated bore wall, or a sliver of the
 * old hole survives - that is the `/cos` below. The 5% on top is MEASURED
 * (2026-09-23): a plug that only just clears the wall grazes the part's own
 * face triangles at the old rim and leaves zero-area slivers there - 0.1%, 1%
 * and 2% all left 4 to 8 of them and an STL that no longer reads as closed;
 * 5% and 10% left none.
 *
 * The trade, stated rather than hidden: the plug spans the hole's own depth
 * and no further, so everything it adds outside the bore is material the part
 * already had - UNLESS the wall around the bore is thinner than 5% of its
 * radius, and a wall that thin is not a wall.
 */
const PLUG_CLEARANCE = 1.05;

function plugRadiusFor(boreRadius: number): number {
  return (boreRadius / Math.cos(Math.PI / boreSegments(boreRadius))) * PLUG_CLEARANCE;
}

/** Corners round the prism, from the chord budget, rounded up to a multiple of
 *  `SEGMENT_QUANTUM` and clamped so a huge or a tiny bore stays sane. */
export function boreSegments(radiusMm: number): number {
  const ratio = 1 - CHORD_BUDGET_MM / radiusMm;
  const ideal = ratio <= -1 ? MIN_SEGMENTS : Math.ceil(Math.PI / Math.acos(Math.max(-1, Math.min(1, ratio))));
  const quantised = Math.ceil(ideal / SEGMENT_QUANTUM) * SEGMENT_QUANTUM;
  return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, quantised));
}

/** A closed, outward-wound prism on the bore axis: the cutter, or the plug. */
function prism(origin: Vec3, axis: Vec3, radius: number, from: number, to: number, segments = boreSegments(radius)): MeshBuffers {
  const u = perpendicular(axis);
  const v = cross(axis, u);
  const at = (k: number, s: number): Vec3 => {
    const t = (2 * Math.PI * k) / segments;
    const cos = Math.cos(t) * radius;
    const sin = Math.sin(t) * radius;
    return [
      origin[0] + axis[0] * s + u[0] * cos + v[0] * sin,
      origin[1] + axis[1] * s + u[1] * cos + v[1] * sin,
      origin[2] + axis[2] * s + u[2] * cos + v[2] * sin,
    ];
  };
  const lowCentre: Vec3 = [
    origin[0] + axis[0] * from,
    origin[1] + axis[1] * from,
    origin[2] + axis[2] * from,
  ];
  const highCentre: Vec3 = [
    origin[0] + axis[0] * to,
    origin[1] + axis[1] * to,
    origin[2] + axis[2] * to,
  ];
  const coords: number[] = [];
  const tri = (a: Vec3, b: Vec3, c: Vec3) => { coords.push(...a, ...b, ...c); };
  for (let k = 0; k < segments; k++) {
    const j = (k + 1) % segments;
    const lk = at(k, from);
    const lj = at(j, from);
    const hk = at(k, to);
    const hj = at(j, to);
    tri(lk, lj, hk);
    tri(lj, hj, hk);
    tri(lowCentre, lj, lk);
    tri(highCentre, hk, hj);
  }
  const positions = Float32Array.from(coords);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

// ------------------------------------------------------------- the ancestry

/** `previous` then `next`, as one map from the first input to the last output. */
function composeAncestry(previous: MeshEditAncestry, next: MeshEditAncestry): MeshEditAncestry {
  const triangles = previous.triangles.map((middles) =>
    middles.flatMap((middle) => next.triangles[middle] ?? []),
  );
  const vertices = previous.vertices.map((middles) =>
    middles.flatMap((middle) => next.vertices[middle] ?? []),
  );
  return { triangles, vertices };
}

const positionKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * 1e5)}:${Math.round(y * 1e5)}:${Math.round(z * 1e5)}`;

/**
 * Who became what across the boolean (ADR-0051 s4.4).
 *
 * The triangle half comes straight out of manifold's own face ids, read back
 * by `booleanMeshWithAncestry`: a facet is either a piece of one of the
 * operator's facets or it is new, and a new one appears in NO entry, which is
 * how `composeSourceFacetIds` marks it NO_SOURCE_FACET. The vertex half is
 * matched by exact position, which is what welding already did to them -
 * including the crack weld: `input` is the part as `crackWelded` closed it, so
 * a corner that was a hair off its partner is looked up where it now sits.
 */
function booleanAncestry(
  input: MeshBuffers,
  output: MeshBuffers,
  leftTriangle: Int32Array,
): MeshEditAncestry {
  const triangles: number[][] = Array.from({ length: facetCount(input) }, () => []);
  for (let out = 0; out < leftTriangle.length; out++) {
    const source = leftTriangle[out];
    if (source !== BOOLEAN_TRIANGLE_ADDED && source < triangles.length) triangles[source].push(out);
  }
  const byPosition = new Map<string, number[]>();
  for (let out = 0; out < vertexCount(output); out++) {
    const key = positionKey(output.positions[out * 3], output.positions[out * 3 + 1], output.positions[out * 3 + 2]);
    const list = byPosition.get(key);
    if (list) list.push(out);
    else byPosition.set(key, [out]);
  }
  const vertices: number[][] = [];
  for (let i = 0; i < vertexCount(input); i++) {
    const key = positionKey(input.positions[i * 3], input.positions[i * 3 + 1], input.positions[i * 3 + 2]);
    vertices.push(byPosition.get(key) ?? []);
  }
  return { triangles, vertices };
}

// ------------------------------------------------------------- the crack weld
//
// WO-1925. Recognition welds hairline cracks shut before it looks for holes
// (WO-1889, `weldMesh`'s `weldToleranceMm`), so it lists a bore whose seam an
// exporter wrote twice a hair apart. The kernel welds by exact position only,
// saw that crack as an open edge, and refused the part as "Not manifold" - the
// hole was found, then could not be bored. So the part goes into the kernel
// the way recognition saw it: the SAME weld, at the SAME tolerance.

/**
 * The part with its hairline cracks closed exactly as recognition closed them,
 * or the part itself - the same object, untouched - when there was nothing to
 * close. Same vertex count, same indices, same facet order: only a cracked
 * corner moves, onto its partner's own coordinates (a point the file already
 * contains, never an average), so every facet and vertex id the ancestry
 * speaks of still names the same thing in the imported part.
 */
function crackWelded(mesh: MeshBuffers): MeshBuffers {
  const welded = weldMesh(mesh, DEFAULT_FEATURE_OPTIONS.weldToleranceMm);
  if (welded.crackWelds === 0) return mesh;
  const positions = Float32Array.from(mesh.positions);
  for (let corner = 0; corner < welded.facets.length; corner++) {
    const from = mesh.indices[corner] * 3;
    const to = welded.facets[corner] * 3;
    positions[from] = welded.positions[to];
    positions[from + 1] = welded.positions[to + 1];
    positions[from + 2] = welded.positions[to + 2];
  }
  return { positions, indices: mesh.indices };
}

/** A kernel refusal of the PART, said as what it is. The cutter and the plug
 *  are closed prisms built here, so an operand that is not closed is the part:
 *  an open edge the crack weld could not close without guessing (WO-1889's
 *  ambiguous junction) or a surface that was never closed at all. */
function namedRefusal(err: unknown): Error {
  const said = err instanceof Error ? err.message : String(err);
  if (!/not ?manifold/i.test(said)) return err instanceof Error ? err : new Error(said);
  return new Error(
    'This part is not a closed solid: its surface has open edges LienCAM could not weld shut, ' +
      `so a bore cannot be cut into it (the boring kernel said "${said}"). Nothing was changed.`,
  );
}

// ---------------------------------------------------------------- the kernel
//
// Replay is synchronous (src/mesh/edit/replay.ts) and the wasm kernel loads
// asynchronously, so the module is loaded once and read back by every later
// replay. Calling `primeBoringKernel` twice is free - the same promise comes
// back - and this is the only place in this directory that touches a kernel.
//
// WHO STARTS IT: this file does, at module evaluation (bottom of this
// section). Audit 2026-09-23: leaving that to the routes meant a SAVED bore
// did not replay after a reload - CAM's `acquirePartMesh` (ADR-0051 R1), the
// store's edge chains and feature targets (R2) and the Properties panel each
// resolve the journal with nobody having primed anything, replay stops at the
// bore, and all three then work on the UN-bored part. No route should have to
// know that one edit needs a kernel, and none is asked to: every route that
// can replay a journal reaches replay through `src/mesh/edit`, which imports
// this file, so the load is in flight from the moment a process is able to
// hold a journal at all.

let priming: Promise<void> | null = null;
let kernel: ManifoldKernel | null = null;
let loaded: ManifoldWasmModule | null = null;

/** Load the boring kernel and hand it to the synchronous replay path.
 *  Resolves when boring is ready; rejects, naming the problem, when the wasm
 *  kernel will not load at all (ADR-0003 - no silent fallback).
 *
 *  It hands the module over EVERY time, not only on the load: a caller that
 *  can await this is asking for a ready kernel, and it gets one whether the
 *  wasm is loading now or loaded a minute ago. */
export function primeBoringKernel(): Promise<void> {
  if (sharedManifoldModule()) return Promise.resolve();
  if (loaded) { setSharedManifoldModule(loaded); return Promise.resolve(); }
  if (!priming) {
    kernel = new ManifoldKernel();
    priming = kernel
      .getModule({ requireManifold: true })
      .then((module) => { loaded = module; setSharedManifoldModule(module); })
      .catch((err) => {
        priming = null;
        throw new Error(
          'The boring kernel could not be loaded, so holes cannot be re-bored: ' +
            (err instanceof Error ? err.message : String(err)),
        );
      });
  }
  return priming;
}

// The load, started the moment this module is evaluated - see WHO STARTS IT
// above. It is deliberately NOT awaited at the top level: a top-level await
// would hold the whole module graph, so the app would not start until a wasm
// kernel had loaded and would not start at all if one never did. Boring is the
// only thing that needs it, so boring is the only thing that waits for it - a
// bore attempted before the load lands changes nothing and says so in a
// sentence, and a caller that CAN wait (the Properties panel, a test) awaits
// this same promise by calling `primeBoringKernel` again.
void primeBoringKernel().catch(() => {
  // Said in words where it is felt: `enlargeHole` refuses, naming the problem,
  // rather than a rejection nobody is listening to at module load.
});

// ---------------------------------------------------------------- the depth
//
// WO-2117: the Model screen's Hole depth on an STL. The same record kind as the
// bore - the same hole, the same axis, the same kernel - carrying the depth he
// typed instead of a new diameter. The diameter never changes. How the floor
// gets there is chosen by the part, in this order:
//   - STRETCH: a blind hole's floor moves along the axis and the bore wall
//     lengthens or shortens with it. Corners move; no facet is added or cut,
//     so the mouth (its chamfer), the diameter and the floor stay exactly as
//     the file drew them, and the hole reads back the way it did. Used when
//     the new floor stays inside the bore and, going deeper, nothing but
//     solid material lies where the floor moves to.
//   - BORE ON: deeper where the stretch would meet something (the far side,
//     another hole, a pocket), or right through: the kernel cuts on down with
//     a prism whose corners ARE the bore's own corners at its floor, so the new
//     wall carries straight on from the old one.
//   - PLUG: a through hole given a depth, or a blind hole made shallower than
//     its bore reaches: a plug (the one shrinking uses, 5% clear of the widest
//     of what it fills) is added from the bottom of the hole up to the new
//     floor.

/** shortest bore a stretch may leave, mm */
const MIN_BORE_MM = 0.01;
/** a wall facet: its normal this close to square to the axis */
const WALL_NORMAL_COSINE = 0.2;

interface HoleEnds {
  welded: WeldedMesh;
  /** welded vertex -> station, for every corner of the hole's facets */
  station: Map<number, number>;
  low: number;
  high: number;
  openLow: boolean;
  openHigh: boolean;
  /** hole corners some facet outside the hole also uses: where it meets the part */
  shared: Set<number>;
}

/** Where the hole's facets reach along `axis`, and which end opens onto the
 *  part: an end is open when the part's own faces meet the hole there. */
function holeEnds(mesh: MeshBuffers, facets: readonly number[], origin: Vec3, axis: Vec3): HoleEnds {
  const welded = weldMesh(mesh, DEFAULT_FEATURE_OPTIONS.weldToleranceMm);
  const inHole = new Set(facets);
  const station = new Map<number, number>();
  const outside = new Set<number>();
  for (let f = 0; f < welded.facetCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = welded.facets[f * 3 + k];
      if (!inHole.has(f)) outside.add(v);
      else if (!station.has(v)) station.set(v, dot(sub(vertexAt(welded, v), origin), axis));
    }
  }
  let low = Infinity;
  let high = -Infinity;
  for (const s of station.values()) {
    if (s < low) low = s;
    if (s > high) high = s;
  }
  if (!Number.isFinite(low) || high - low <= 0) {
    throw new Error('The facets of this hole do not run along its axis, so LienCAM cannot tell how deep it is. Nothing was changed.');
  }
  const band = (high - low) / 10;
  const shared = new Set<number>();
  let openLow = false;
  let openHigh = false;
  for (const [v, s] of station) {
    if (!outside.has(v)) continue;
    shared.add(v);
    if (s <= low + band) openLow = true;
    if (s >= high - band) openHigh = true;
  }
  return { welded, station, low, high, openLow, openHigh, shared };
}

/** WO-2117: what the depth card shows for an STL hole - its depth from its
 *  opening, whether it runs right through, and its axis turned to point OUT of
 *  that opening (a through hole: out of its upper end). Null when neither end
 *  of it opens onto the part. */
export function holeDepthFacts(
  mesh: MeshBuffers,
  facets: readonly number[],
  axisOrigin: readonly number[],
  axisDirection: readonly number[],
): { depthMm: number; through: boolean; axisDirection: [number, number, number] } | null {
  const axis = unit(axisDirection as Vec3);
  const ends = holeEnds(mesh, facets, axisOrigin as Vec3, axis);
  if (!ends.openLow && !ends.openHigh) return null;
  const through = ends.openLow && ends.openHigh;
  const flip = through ? axis[2] < -1e-9 : !ends.openHigh;
  const out: [number, number, number] = flip ? [-axis[0], -axis[1], -axis[2]] : [axis[0], axis[1], axis[2]];
  return { depthMm: ends.high - ends.low, through, axisDirection: out };
}

function radialOf(ends: HoleEnds, origin: Vec3, axis: Vec3): (v: number) => number {
  return (v) => {
    const p = sub(vertexAt(ends.welded, v), origin);
    const s = dot(p, axis);
    return Math.hypot(p[0] - axis[0] * s, p[1] - axis[1] * s, p[2] - axis[2] * s);
  };
}

interface Bore {
  /** the wall facets that lie on the bore's radius */
  facets: Set<number>;
  /** their corners */
  corners: Set<number>;
  low: number;
  /** where the bore's wall ends going up: a chamfer, a counterbore or the face */
  ceiling: number;
}

/** The bore of the hole: its wall facets whose every corner sits on `radius`. */
function boreOf(ends: HoleEnds, facets: readonly number[], origin: Vec3, axis: Vec3, radius: number): Bore | null {
  const radial = radialOf(ends, origin, axis);
  const tolerance = Math.max(0.02, radius * 0.02);
  const corners = new Set<number>();
  const wall = new Set<number>();
  for (const f of facets) {
    const n: Vec3 = [ends.welded.normals[f * 3], ends.welded.normals[f * 3 + 1], ends.welded.normals[f * 3 + 2]];
    if (Math.abs(dot(n, axis)) > WALL_NORMAL_COSINE) continue;
    const vs = [0, 1, 2].map((k) => ends.welded.facets[f * 3 + k]);
    if (!vs.every((v) => Math.abs(radial(v) - radius) <= tolerance)) continue;
    wall.add(f);
    for (const v of vs) corners.add(v);
  }
  if (corners.size === 0) return null;
  let low = Infinity;
  let ceiling = -Infinity;
  for (const v of corners) {
    const s = ends.station.get(v) as number;
    if (s < low) low = s;
    if (s > ceiling) ceiling = s;
  }
  return { facets: wall, corners, low, ceiling };
}

/** `corners` (welded vertices) in order round the axis. */
function aroundAxis(ends: HoleEnds, corners: Iterable<number>, origin: Vec3, axis: Vec3): number[] {
  const u = perpendicular(axis);
  const w = cross(axis, u);
  return [...corners]
    .map((v) => {
      const p = sub(vertexAt(ends.welded, v), origin);
      return { v, angle: Math.atan2(dot(p, w), dot(p, u)) };
    })
    .sort((a, b) => a.angle - b.angle)
    .map((c) => c.v);
}

/** Open edges (used by one facet, or by more than two) of `mesh`, welded as
 *  recognition welds it. */
function openEdgeCount(mesh: MeshBuffers): number {
  return weldMesh(mesh, DEFAULT_FEATURE_OPTIONS.weldToleranceMm).edges.filter((e) => e.facets.length !== 2).length;
}

/** A depth edit never hands back a part with more gaps in its surface than it
 *  was given - it says so instead, and nothing changes. */
function keptClosed(before: MeshBuffers, result: MeshEditApplyResult, depthWords: string): MeshEditApplyResult {
  if (openEdgeCount(result.mesh) > openEdgeCount(before)) {
    throw new Error(
      `LienCAM could not make this hole ${depthWords} without leaving gaps in the part's surface, so it did not. Nothing was changed.`,
    );
  }
  return result;
}

/** Does any facet outside the hole come within `radius` of the axis between
 *  stations `from` and `to`? (The room a floor moving down has to have.) */
function sweepMeetsPart(ends: HoleEnds, facets: readonly number[], origin: Vec3, axis: Vec3, from: number, to: number, radius: number): boolean {
  const { welded } = ends;
  const inHole = new Set(facets);
  const u = perpendicular(axis);
  const w = cross(axis, u);
  for (let f = 0; f < welded.facetCount; f++) {
    if (inHole.has(f)) continue;
    let polygon = [0, 1, 2].map((k): Vec3 => {
      const p = sub(vertexAt(welded, welded.facets[f * 3 + k]), origin);
      return [dot(p, axis), dot(p, u), dot(p, w)];
    });
    if (polygon.every((p) => p[0] < from) || polygon.every((p) => p[0] > to)) continue;
    polygon = clipStation(clipStation(polygon, from, 1), to, -1);
    if (polygon.length > 0 && distanceToAxis(polygon) <= radius) return true;
  }
  return false;
}

/** Keep the part of a convex polygon (station, u, v) on one side of `limit`:
 *  sense 1 keeps station >= limit, -1 keeps station <= limit. */
function clipStation(polygon: Vec3[], limit: number, sense: 1 | -1): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const da = (a[0] - limit) * sense;
    const db = (b[0] - limit) * sense;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** How close a convex polygon (station, u, v), seen down the axis, comes to it. */
function distanceToAxis(polygon: readonly Vec3[]): number {
  let positive = false;
  let negative = false;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const [, ax, ay] = polygon[i];
    const [, bx, by] = polygon[(i + 1) % polygon.length];
    const side = ax * by - ay * bx;
    if (side > 0) positive = true;
    if (side < 0) negative = true;
    const ex = bx - ax;
    const ey = by - ay;
    const length2 = ex * ex + ey * ey;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * ex + ay * ey) / length2));
    best = Math.min(best, Math.hypot(ax + ex * t, ay + ey * t));
  }
  // The axis passes inside the polygon: it lies across the floor's path.
  if (polygon.length >= 3 && !(positive && negative)) return 0;
  return best;
}

/** STRETCH, or null when the part does not allow it (see above). */
function stretchFloor(
  mesh: MeshBuffers,
  facets: readonly number[],
  ends: HoleEnds,
  origin: Vec3,
  axis: Vec3,
  radius: number,
  floor: number,
): MeshEditApplyResult | null {
  const bore = boreOf(ends, facets, origin, axis, radius);
  if (bore === null || bore.ceiling - bore.low < MIN_BORE_MM) return null;
  const shift = floor - ends.low;
  const newBoreLow = bore.low + shift;
  if (newBoreLow > bore.ceiling - MIN_BORE_MM) return null;
  const scale = (bore.ceiling - newBoreLow) / (bore.ceiling - bore.low);
  const eps = 1e-4;
  // welded corner -> how far it moves along the axis
  const moves = new Map<number, number>();
  for (const [v, s] of ends.station) {
    if (s <= bore.low + eps) moves.set(v, shift);
    else if (s < bore.ceiling - eps) {
      // Anything but the bore between the floor and the ceiling is not a
      // plain bore to stretch.
      if (!bore.corners.has(v)) return null;
      moves.set(v, bore.ceiling - (bore.ceiling - s) * scale - s);
    }
  }
  let reach = 0;
  const radial = radialOf(ends, origin, axis);
  for (const v of moves.keys()) {
    // The floor meets the rest of the part: moving it would tear that open.
    if (ends.shared.has(v)) return null;
    reach = Math.max(reach, radial(v));
  }
  if (shift < 0 && sweepMeetsPart(ends, facets, origin, axis, floor - MIN_BORE_MM, ends.low, reach + MIN_BORE_MM)) return null;

  const positions = Float32Array.from(mesh.positions);
  const done = new Uint8Array(vertexCount(mesh));
  for (let corner = 0; corner < mesh.indices.length; corner++) {
    const vertex = mesh.indices[corner];
    if (done[vertex]) continue;
    const d = moves.get(ends.welded.facets[corner]);
    if (d === undefined) continue;
    done[vertex] = 1;
    positions[vertex * 3] += axis[0] * d;
    positions[vertex * 3 + 1] += axis[1] * d;
    positions[vertex * 3 + 2] += axis[2] * d;
  }
  return { mesh: { positions, indices: mesh.indices }, ancestry: identityAncestry(mesh) };
}

/** The far end of the part along the axis, as a station (the lowest corner of
 *  its bounding box), and a margin to carry a cut clear past it. */
function partBelow(mesh: MeshBuffers, origin: Vec3, axis: Vec3): { low: number; margin: number } {
  const box = computeBoundingBox(mesh);
  let low = Infinity;
  let high = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const s = station([
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ], origin, axis);
    low = Math.min(low, s);
    high = Math.max(high, s);
  }
  return { low, margin: Math.max(1, (high - low) * 0.01) };
}

/** BORE ON: cut from the bore's floor down to `floor`, or right through the
 *  part when `floor` is null (or reaches its far end). */
function boreOn(
  mesh: MeshBuffers,
  facets: readonly number[],
  ends: HoleEnds,
  origin: Vec3,
  axis: Vec3,
  radius: number,
  floor: number | null,
): MeshEditApplyResult {
  const below = partBelow(mesh, origin, axis);
  const bottom = floor === null || floor <= below.low + 1e-3 ? below.low - below.margin : floor;
  const bore = boreOf(ends, facets, origin, axis, radius);
  let cutter: MeshBuffers;
  if (bore !== null && bore.low - bottom > MIN_BORE_MM) {
    // The bore's own corners at its floor, round the axis: the cutter's wall
    // carries the hole's wall straight on down.
    const ring = aroundAxis(ends, [...bore.corners].filter((v) => (ends.station.get(v) as number) <= bore.low + 1e-4), origin, axis)
      .map((v) => vertexAt(ends.welded, v));
    cutter = ring.length >= 3
      ? ringPrism(ring, origin, axis, bore.low, bottom)
      : prism(origin, axis, radius, bottom, bore.low);
  } else {
    cutter = prism(origin, axis, radius, bottom, ends.low);
  }
  const module = boringKernel();
  const part = crackWelded(mesh);
  try {
    const { result, leftTriangle } = booleanMeshWithAncestry(module, part, cutter, { operation: 'difference' });
    return { mesh: result.mesh, ancestry: booleanAncestry(part, result.mesh, leftTriangle) };
  } catch (err) {
    throw namedRefusal(err);
  }
}

/** A closed prism through the corners of `ring` (at station `top`) down to
 *  station `bottom`, wound outward. */
function ringPrism(ring: readonly Vec3[], origin: Vec3, axis: Vec3, top: number, bottom: number): MeshBuffers {
  const lower = ring.map((p): Vec3 => {
    const d = bottom - station(p, origin, axis);
    return [p[0] + axis[0] * d, p[1] + axis[1] * d, p[2] + axis[2] * d];
  });
  const topCentre: Vec3 = [origin[0] + axis[0] * top, origin[1] + axis[1] * top, origin[2] + axis[2] * top];
  const bottomCentre: Vec3 = [origin[0] + axis[0] * bottom, origin[1] + axis[1] * bottom, origin[2] + axis[2] * bottom];
  const tris: Array<[Vec3, Vec3, Vec3]> = [];
  for (let k = 0; k < ring.length; k++) {
    const j = (k + 1) % ring.length;
    tris.push([ring[k], lower[k], lower[j]], [ring[k], lower[j], ring[j]]);
    tris.push([topCentre, ring[k], ring[j]], [bottomCentre, lower[j], lower[k]]);
  }
  // Outward: the signed volume of a closed, outward-wound solid is positive.
  let volume = 0;
  for (const [a, b, c] of tris) volume += dot(a, cross(b, c));
  const coords: number[] = [];
  for (const [a, b, c] of tris) coords.push(...a, ...(volume < 0 ? c : b), ...(volume < 0 ? b : c));
  const positions = Float32Array.from(coords);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** PLUG: fill the hole from its bottom up to `floor`. */
function plugUpTo(
  mesh: MeshBuffers,
  facets: readonly number[],
  ends: HoleEnds,
  origin: Vec3,
  axis: Vec3,
  floor: number,
): MeshEditApplyResult {
  // The widest of the hole it fills: every corner of every facet reaching below
  // the new floor (a wall facet's widest point is one of its corners).
  const radial = radialOf(ends, origin, axis);
  let widest = 0;
  for (const f of facets) {
    const vs = [0, 1, 2].map((k) => ends.welded.facets[f * 3 + k]);
    if (vs.some((v) => (ends.station.get(v) as number) < floor)) for (const v of vs) widest = Math.max(widest, radial(v));
  }
  const module = boringKernel();
  const part = crackWelded(mesh);
  try {
    const plugged = booleanMeshWithAncestry(
      module,
      part,
      prism(origin, axis, plugRadiusFor(widest), ends.low, floor),
      { operation: 'union' },
    );
    return { mesh: plugged.result.mesh, ancestry: booleanAncestry(part, plugged.result.mesh, plugged.leftTriangle) };
  } catch (err) {
    throw namedRefusal(err);
  }
}

/**
 * THROUGH -> BLIND without the kernel. The bottom opening is closed flush with
 * the face it opens onto (a cap on the rim that face already has), whatever
 * lay below the bore (a chamfer) goes, and the bore stretches up to the new
 * floor, which gets a cap of its own. Every facet above the floor is the
 * file's own. Null when the part does not allow it: the new floor is not in
 * the bore, the opening is not flat and square to the axis, or the hole has
 * something the bore and the mouth do not account for.
 */
function closeThrough(
  mesh: MeshBuffers,
  facets: readonly number[],
  ends: HoleEnds,
  origin: Vec3,
  axis: Vec3,
  radius: number,
  floor: number,
): MeshEditApplyResult | null {
  const bore = boreOf(ends, facets, origin, axis, radius);
  if (bore === null || floor <= bore.low + MIN_BORE_MM || floor >= bore.ceiling - MIN_BORE_MM) return null;
  const eps = 1e-4;
  const at = (v: number) => ends.station.get(v) as number;
  // The opening: where the part's face meets the hole at its lower end.
  const rimCorners = [...ends.shared].filter((v) => at(v) <= bore.low + eps);
  if (rimCorners.length < 3 || rimCorners.some((v) => Math.abs(at(v) - ends.low) > 1e-3)) return null;
  const drop = new Set<number>();
  for (const f of facets) {
    if (bore.facets.has(f)) continue;
    const s = [0, 1, 2].map((k) => at(ends.welded.facets[f * 3 + k]));
    if (s.every((x) => x <= bore.low + eps)) drop.add(f);
    else if (!s.every((x) => x >= bore.ceiling - eps)) return null;
  }
  const scale = (bore.ceiling - floor) / (bore.ceiling - bore.low);

  const coords = Array.from(mesh.positions);
  const added = new Map<number, number>();
  const moved = (v: number): number => {
    const known = added.get(v);
    if (known !== undefined) return known;
    const p = vertexAt(ends.welded, v);
    const d = bore.ceiling - (bore.ceiling - at(v)) * scale - at(v);
    const index = coords.length / 3;
    coords.push(p[0] + axis[0] * d, p[1] + axis[1] * d, p[2] + axis[2] * d);
    added.set(v, index);
    return index;
  };
  const centre = (s: number): number => {
    const index = coords.length / 3;
    coords.push(origin[0] + axis[0] * s, origin[1] + axis[1] * s, origin[2] + axis[2] * s);
    return index;
  };
  // The part's own vertex at each rim corner, so the cap closes on exactly the
  // numbers the face it joins already has.
  const inHole = new Set(facets);
  const partVertex = new Map<number, number>();
  for (let corner = 0; corner < mesh.indices.length; corner++) {
    const v = ends.welded.facets[corner];
    if (!inHole.has(Math.floor(corner / 3)) && !partVertex.has(v)) partVertex.set(v, mesh.indices[corner]);
  }

  const indices: number[] = [];
  const triangles: number[][] = [];
  for (let f = 0; f < facetCount(mesh); f++) {
    if (drop.has(f)) { triangles.push([]); continue; }
    triangles.push([indices.length / 3]);
    for (let k = 0; k < 3; k++) {
      const corner = f * 3 + k;
      const v = ends.welded.facets[corner];
      indices.push(bore.facets.has(f) && at(v) < bore.ceiling - eps ? moved(v) : mesh.indices[corner]);
    }
  }
  // Floor cap (facing up the hole, +axis) on the bore's lowest ring, moved.
  const ring = aroundAxis(ends, [...bore.corners].filter((v) => at(v) <= bore.low + eps), origin, axis);
  const floorCentre = centre(floor);
  for (let k = 0; k < ring.length; k++) indices.push(floorCentre, moved(ring[k]), moved(ring[(k + 1) % ring.length]));
  // Opening cap (facing out of the part, -axis) on the rim.
  const rim = aroundAxis(ends, rimCorners, origin, axis);
  const rimCentre = centre(ends.low);
  for (let k = 0; k < rim.length; k++) {
    const a = partVertex.get(rim[k]);
    const b = partVertex.get(rim[(k + 1) % rim.length]);
    if (a === undefined || b === undefined) return null;
    indices.push(rimCentre, b, a);
  }
  const vertices: number[][] = [];
  for (let i = 0; i < vertexCount(mesh); i++) vertices.push([i]);
  const out: MeshBuffers = { positions: Float32Array.from(coords), indices: Uint32Array.from(indices) };
  // A rim or a ring that is not one clean loop leaves the cap short of it.
  if (openEdgeCount(out) > openEdgeCount(mesh)) return null;
  return { mesh: out, ancestry: { triangles, vertices } };
}

/** WO-2117: the hole `facets` belongs to, `parameters.depthMm` deep from its
 *  opening (the +axis end), or right through. */
function changeHoleDepth(
  mesh: MeshBuffers,
  facets: readonly number[],
  parameters: EnlargeHoleParameters,
  origin: Vec3,
  axis: Vec3,
): MeshEditApplyResult {
  const ends = holeEnds(mesh, facets, origin, axis);
  if (!ends.openHigh) {
    throw new Error('This hole does not open at the end its depth is measured from, so LienCAM cannot tell where its top is. Nothing was changed.');
  }
  const radius = parameters.fromDiameterMm / 2;
  if (parameters.through === true) {
    if (ends.openLow) throw new Error('This hole already runs right through, so there is nothing to change.');
    return keptClosed(mesh, boreOn(mesh, facets, ends, origin, axis, radius, null), 'go right through');
  }
  const depth = parameters.depthMm as number;
  const floor = ends.high - depth;
  if (ends.openLow) {
    if (floor <= ends.low + 1e-6) {
      throw new Error(
        `This hole runs right through ${(ends.high - ends.low).toFixed(2)} mm of the part, so ${depth.toFixed(2)} mm deep ` +
          'is still right through it. Nothing was changed.',
      );
    }
    return closeThrough(mesh, facets, ends, origin, axis, radius, floor) ??
      keptClosed(mesh, plugUpTo(mesh, facets, ends, origin, axis, floor), `${depth.toFixed(2)} mm deep`);
  }
  if (Math.abs(floor - ends.low) < 1e-6) {
    throw new Error(`This hole is already ${depth.toFixed(2)} mm deep, so there is nothing to change.`);
  }
  const stretched = stretchFloor(mesh, facets, ends, origin, axis, radius, floor);
  if (stretched !== null) return stretched;
  return keptClosed(mesh, floor < ends.low
    ? boreOn(mesh, facets, ends, origin, axis, radius, floor)
    : plugUpTo(mesh, facets, ends, origin, axis, floor), `${depth.toFixed(2)} mm deep`);
}

/** The loaded boring kernel, or the sentence that says it is not there yet. */
function boringKernel(): ManifoldWasmModule {
  const module = sharedManifoldModule();
  if (!module) {
    throw new Error(
      'The boring kernel has not finished loading yet, so the bore was not cut. ' +
        'Nothing was changed; try again in a moment.',
    );
  }
  return module;
}

// ------------------------------------------------------------- the operation

/**
 * Re-bore the hole `facets` belongs to, to `parameters.diameterMm`.
 *
 * Throws a sentence naming what LienCAM cannot do - and only that. A bore
 * that breaks into a neighbouring feature is NOT one of those things: it is
 * carried out, and the caller says in the console what it now breaks into
 * (see `holeBreaksInto`).
 */
export function enlargeHole(
  mesh: MeshBuffers,
  facets: readonly number[],
  parameters: EnlargeHoleParameters,
): MeshEditApplyResult {
  const axis = unit(parameters.axisDirection as Vec3);
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) {
    throw new Error('This hole has no axis direction, so LienCAM cannot tell which way to bore.');
  }
  const origin = parameters.axisOrigin as Vec3;
  if (parameters.depthMm !== undefined || parameters.through === true) {
    return changeHoleDepth(mesh, facets, parameters, origin, axis);
  }
  const module = boringKernel();
  const radius = parameters.diameterMm / 2;
  // The part as recognition saw it (WO-1925); `mesh` itself when uncracked.
  const part = crackWelded(mesh);
  const span = cutSpan(part, facets, origin, axis);
  // WO-2804: complete recognition may connect this step to an internal cone.
  // Its open ring is not permission to bore through the pilot. Conversely,
  // the cylinder/mouth-chamfer seam is not a closed end (round 6). Protect the
  // shoulder while letting the cutter exit the explicitly proved opening.
  // The shrink plug stays in the measured cylinder. Records lacking the new
  // open-end field retain their previous bounded/cap-derived replay semantics.
  if (parameters.boreRangeMm) {
    span.from = parameters.boreOpenEnd === 'low' ? span.from : parameters.boreRangeMm[0];
    span.to = parameters.boreOpenEnd === 'high' ? span.to : parameters.boreRangeMm[1];
    [span.holeFrom, span.holeTo] = parameters.boreRangeMm;
    span.through = false;
  }

  try {
    // Shrinking: fill what is there first. The plug runs the hole's own extent
    // and no further, so the material it adds outside the old bore is material
    // the part already had - a union that fills the hole and changes nothing
    // else. Both halves land in this one record.
    let working = part;
    let fill: MeshEditAncestry | null = null;
    if (parameters.diameterMm < parameters.fromDiameterMm) {
      const plugRadius = plugRadiusFor(parameters.fromDiameterMm / 2);
      const plugged = booleanMeshWithAncestry(
        module,
        part,
        prism(origin, axis, plugRadius, span.holeFrom, span.holeTo),
        { operation: 'union' },
      );
      fill = booleanAncestry(part, plugged.result.mesh, plugged.leftTriangle);
      working = plugged.result.mesh;
    }

    // At an existing mouth of the requested diameter an inscribed prism
    // leaves interrupted cone slivers and collapsed tangent triangles. New
    // open-end step cuts put their side midpoints on the asked circle instead;
    // corner excess is bounded by the SAME radial chord budget. Older records
    // and all other diameter/depth routes retain their original cutter.
    const cutterSegments = boreSegments(parameters.boreOpenEnd ? radius + CHORD_BUDGET_MM : radius);
    const cutterRadius = parameters.boreOpenEnd
      ? radius / Math.cos(Math.PI / cutterSegments)
      : radius;
    const { result, leftTriangle } = booleanMeshWithAncestry(
      module,
      working,
      prism(origin, axis, cutterRadius, span.from, span.to, cutterSegments),
      { operation: 'difference' },
    );
    let boreMesh = result.mesh;
    let boreParents = leftTriangle;
    if (parameters.boreOpenEnd) {
      // Float32 Boolean intersections can collapse triangles to exactly zero
      // area. They carry no surface; keeping them creates repeated edges and
      // correctly trips recognition's ambiguous-topology guard. Remove only
      // those triangles, with the identical ancestry permutation. Never weld
      // nearby points or discard a nonzero facet to make recognition pass.
      const topology = weldMesh(boreMesh);
      const retained = Array.from(topology.areas).flatMap((area, f) => area === 0 ? [] : [f]);
      if (retained.length !== facetCount(boreMesh)) {
        boreMesh = { positions: boreMesh.positions, indices: Uint32Array.from(retained.flatMap(f =>
          Array.from(boreMesh.indices.subarray(f * 3, f * 3 + 3)))) };
        boreParents = Int32Array.from(retained.map(f => leftTriangle[f]));
      }
    }
    const bore = booleanAncestry(working, boreMesh, boreParents);
    const ancestry = fill ? composeAncestry(fill, bore) : bore;
    if (parameters.boreOpenEnd) {
      // A re-bored wall is still the picked cylinder. LEFT ancestry alone
      // loses that identity when the cutter replaces its entire surface.
      // Retain logical facet descendants on that wall only; generated caps
      // stay new and every surviving LEFT facet keeps its exact ancestry.
      const wallPosition = (body: MeshBuffers, f: number) => {
        const [a, b, c] = facetVertices(body, f);
        if (Math.abs(dot(unit(cross(sub(b, a), sub(c, a))), axis)) > 1e-6) return null;
        const centre: Vec3 = a.map((v, i) => (v + b[i] + c[i]) / 3) as Vec3;
        const t = station(centre, origin, axis);
        const radial = unit(sub(sub(centre, origin), axis.map(v => v * t) as Vec3));
        return { t, radial };
      };
      const predecessors = facets.flatMap(f => {
        const p = wallPosition(part, f);
        return p ? [{ f, ...p }] : [];
      });
      const axialScale = Math.max(1, span.holeTo - span.holeFrom);
      for (let f = 0; f < facetCount(boreMesh); f++) {
        if (boreParents[f] !== BOOLEAN_TRIANGLE_ADDED) continue;
        const p = wallPosition(boreMesh, f);
        if (!p || !predecessors.length) continue;
        const distance = (old: typeof predecessors[number]) =>
          1 - dot(p.radial, old.radial) + Math.abs(p.t - old.t) / axialScale;
        const old = predecessors.reduce((a, b) => distance(b) < distance(a) ? b : a);
        ancestry.triangles[old.f].push(f);
      }
    }
    return { mesh: boreMesh, ancestry };
  } catch (err) {
    throw namedRefusal(err);
  }
}

/** The sentence this bore would refuse with, or null when it goes through.
 *  The panel asks BEFORE it records, so a refusal never lands in the journal
 *  as an edit that cannot replay. */
export function enlargeHoleRefusal(
  mesh: MeshBuffers,
  facets: readonly number[],
  parameters: Record<string, unknown>,
): string | null {
  try {
    enlargeHole(mesh, facets, enlargeHoleOperation.validate(parameters));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The other proved features this bore would reach into at `newDiameterMm`.
 *
 * Not a gate and not a warning: the software can cut it, so it cuts it
 * (LIENCAM.md rule 11). This is what lets the caller SAY what it did -
 * "the hole now breaks into the 10.00 mm counterbore" - in the console.
 *
 * Measured, not guessed: two features are reached when the closest approach of
 * their axis SEGMENTS is inside the sum of the new radius and the other
 * feature's own radius, and their axial stretches overlap along this bore.
 */
export function holeBreaksInto(
  feature: RecognizedFeature,
  others: readonly RecognizedFeature[],
  newDiameterMm: number,
): RecognizedFeature[] {
  const radius = newDiameterMm / 2;
  const axis = unit(feature.axis.direction);
  const origin = feature.axis.origin;
  const out: RecognizedFeature[] = [];
  for (const other of others) {
    if (other.id === feature.id) continue;
    const reach = radius + other.diameterMm / 2;
    // Distance from the other feature's axis origin to this bore's axis line,
    // plus how far its own body reaches along its own axis, is the closest
    // its material can come to this bore's wall.
    const delta = sub(other.axis.origin, origin);
    const along = dot(delta, axis);
    const perp: Vec3 = [
      delta[0] - axis[0] * along,
      delta[1] - axis[1] * along,
      delta[2] - axis[2] * along,
    ];
    const distance = Math.hypot(perp[0], perp[1], perp[2]);
    // The other feature's axis may lean; its body sweeps up to its own depth
    // away from its origin, so allow that much closing in.
    const lean = Math.abs(dot(unit(other.axis.direction), axis));
    const sweep = other.depthMm * Math.sqrt(Math.max(0, 1 - lean * lean));
    if (distance - sweep < reach) out.push(other);
  }
  return out;
}

export const enlargeHoleOperation: MeshEditOperation<EnlargeHoleParameters> = {
  kind: ENLARGE_HOLE_KIND,
  version: ENLARGE_HOLE_VERSION,
  label: 'Bore hole to size',

  describe(record: MeshEditRecord): string {
    const p = (record.parameters ?? {}) as Partial<EnlargeHoleParameters>;
    const to = typeof p.diameterMm === 'number' ? p.diameterMm.toFixed(2) : '?';
    const from = typeof p.fromDiameterMm === 'number' ? p.fromDiameterMm.toFixed(2) : '?';
    const word = p.feature ? FEATURE_WORDS[p.feature] : 'hole';
    if (typeof p.depthMm === 'number' || p.through === true) {
      const was = p.fromThrough === true ? 'through' : typeof p.fromDepthMm === 'number' ? `${p.fromDepthMm.toFixed(2)} mm deep` : '?';
      const now = p.through === true ? 'through' : `${(p.depthMm as number).toFixed(2)} mm deep`;
      return `Changed the ${to} mm ${word} from ${was} to ${now}`;
    }
    if (typeof p.diameterMm === 'number' && typeof p.fromDiameterMm === 'number'
      && p.diameterMm < p.fromDiameterMm) {
      return `Filled the ${from} mm ${word} and bored ${to} mm`;
    }
    return `Bored the ${from} mm ${word} out to ${to} mm`;
  },

  validate(parameters: Record<string, unknown>): EnlargeHoleParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) {
      throw new Error(`"${ENLARGE_HOLE_KIND}" does not take ${extra.join(', ')}.`);
    }
    const feature = given.feature;
    if (typeof feature !== 'string' || !(feature in FEATURE_WORDS)) {
      throw new Error(
        `"${ENLARGE_HOLE_KIND}" needs to know which kind of feature it bored; ` +
          `"${String(feature)}" is not one LienCAM recognises.`,
      );
    }
    if (feature === 'boss') {
      throw new Error('A boss is not a hole, so there is nothing to bore.');
    }
    const diameterMm = measurement(given.diameterMm, 'diameter');
    const fromDiameterMm = measurement(given.fromDiameterMm, 'existing diameter');
    if (given.boreOpenEnd !== undefined && (given.boreRangeMm === undefined || (given.boreOpenEnd !== 'low' && given.boreOpenEnd !== 'high'))) {
      throw new Error('The selected counterbore opening must be the low or high end of its measured range.');
    }
    if (given.depthMm !== undefined || given.through !== undefined) {
      if (given.boreRangeMm !== undefined) throw new Error('A selected bore range belongs to a diameter edit, not a depth edit.');
      return validateDepthEdit(given, feature as FeatureKind, diameterMm, fromDiameterMm);
    }
    if (Math.abs(diameterMm - fromDiameterMm) < 1e-6) {
      throw new Error(
        `This ${FEATURE_WORDS[feature as FeatureKind]} is already ${fromDiameterMm.toFixed(2)} mm across, ` +
          'so there is nothing to bore.',
      );
    }
    return {
      feature: feature as FeatureKind,
      diameterMm,
      fromDiameterMm,
      axisOrigin: triple(given.axisOrigin, 'axisOrigin'),
      axisDirection: triple(given.axisDirection, 'axisDirection'),
      ...(given.boreRangeMm !== undefined ? { boreRangeMm: boreRange(given.boreRangeMm) } : {}),
      ...(given.boreOpenEnd !== undefined ? { boreOpenEnd: given.boreOpenEnd as 'low' | 'high' } : {}),
    };
  },

  apply({ mesh, facets, parameters }: MeshEditApplyInput<EnlargeHoleParameters>): MeshEditApplyResult {
    return enlargeHole(mesh, facets, parameters);
  },
};

/** WO-2117: a depth edit's parameters. It keeps the diameter - one edit
 *  changes one thing, so the line he reads says exactly what it did. */
function validateDepthEdit(
  given: Record<string, unknown>,
  feature: FeatureKind,
  diameterMm: number,
  fromDiameterMm: number,
): EnlargeHoleParameters {
  if (Math.abs(diameterMm - fromDiameterMm) >= 1e-6) {
    throw new Error(`"${ENLARGE_HOLE_KIND}" changes a hole's diameter or its depth, not both in one edit.`);
  }
  if (given.through !== undefined && given.through !== true) {
    throw new Error(`"${ENLARGE_HOLE_KIND}"'s "through" is true or absent.`);
  }
  if (given.fromThrough !== undefined && given.fromThrough !== true) {
    throw new Error(`"${ENLARGE_HOLE_KIND}"'s "fromThrough" is true or absent.`);
  }
  if (given.through === true && given.depthMm !== undefined) {
    throw new Error(`"${ENLARGE_HOLE_KIND}" takes a depth or "through", not both.`);
  }
  const fromDepthMm = measurement(given.fromDepthMm, 'existing depth');
  const out: EnlargeHoleParameters = {
    feature,
    diameterMm,
    fromDiameterMm,
    axisOrigin: triple(given.axisOrigin, 'axisOrigin'),
    axisDirection: triple(given.axisDirection, 'axisDirection'),
    fromDepthMm,
    ...(given.fromThrough === true ? { fromThrough: true as const } : {}),
    ...(given.through === true ? { through: true as const } : { depthMm: measurement(given.depthMm, 'depth') }),
  };
  if (out.through === true && out.fromThrough === true) {
    throw new Error(`This ${FEATURE_WORDS[feature]} already runs right through, so there is nothing to change.`);
  }
  if (out.depthMm !== undefined && out.fromThrough !== true && Math.abs(out.depthMm - fromDepthMm) < 1e-6) {
    throw new Error(`This ${FEATURE_WORDS[feature]} is already ${fromDepthMm.toFixed(2)} mm deep, so there is nothing to change.`);
  }
  return out;
}

function measurement(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `"${ENLARGE_HOLE_KIND}" was given a ${label} of "${String(value)}", which is not a measurement.`,
    );
  }
  return value;
}

function triple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`"${ENLARGE_HOLE_KIND}" needs a ${label} of three finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

registerMeshEditOperation(enlargeHoleOperation);

function boreRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || value.some(v => typeof v !== 'number' || !Number.isFinite(v)) || value[1] <= value[0]) {
    throw new Error('The selected counterbore needs two finite, increasing axial stations.');
  }
  return [value[0], value[1]];
}
