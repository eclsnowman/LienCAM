// WO-1910 / ADR-0051 s3: add a box or a cylinder to an STL, or cut one out
// of it.
//
// The operator types a shape, where it sits and how big it is, and picks Add
// or Subtract. LienCAM unions or subtracts that solid with his part through
// the same manifold-3d kernel WO-1850 bores holes with
// (`booleanMeshWithAncestry`), so every facet of the result is either a piece
// of one of his facets - carrying its source id - or is new and says so. One
// journal entry, one undo step, replayed over the imported bytes like every
// other edit.
//
// WHAT IT REFUSES, and only that (LIENCAM.md rule 11):
//   - an operand the kernel would get backwards: inside-out, flat, or with a
//     corner that is not a number (`booleanOperandProblem`, manifoldOps.ts).
//     The part itself is an operand too - an inside-out STL would come out of
//     a union with material removed, so it is named rather than cut wrong.
//   - a RESULT that is not one solid part when the part was. A box that does
//     not touch the part is a valid union - it is not refused for being
//     disjoint - but the answer would be two solids in one STL row, and an
//     STL row is one part. The same sentence covers a cut that splits the
//     part in two, and a cut that leaves nothing.
//
// DECIDE-AND-LOG (rule 3), three calls:
//   - Primitives only, not "another body". A record replays from THIS row's
//     bytes and nothing else (ADR-0051 s1.1); a record naming a second STL
//     row would replay differently the day that row is edited or deleted.
//   - The shape is placed in the PART'S OWN coordinates - the STL file's
//     numbers, the frame the journal replays in - not the scene's. Moving the
//     part in the scene then carries the box with it, as it should.
//   - The selection a record carries (ADR-0051 s1.4 needs at least one facet
//     and a witness) is the facets the shape reaches: every facet with a
//     corner inside the shape's own bounding box, grown by a millimetre; or,
//     when the shape does not reach the part, the single facet nearest to it.
//     That is the region the edit changes, so a journal whose earlier edits
//     moved that region stops here instead of cutting in the wrong place.
//
// WO-2089: the Model screen's Hole and Chamfer on an STL are this edit too,
// with two more shapes, so they replay wherever a journal is resolved:
//   - 'hole': one bore per placed point (a cylinder along the picked face's
//     normal, blind to its depth or right through), with a counterbore
//     (a second cylinder) or a countersink (a cone) at its mouth.
//   - 'chamfer': one wedge per picked straight sharp edge, its long face the
//     chamfer's flat - cut from an outside edge, added into an inside corner.
//   Each is ONE journal entry and one undo step however many holes or edges it
//   carries; the pieces are cut (or added) one after another and the ancestry
//   composed across them, so every facet still names where it came from.
//   Decide-and-log: a through hole records the depth that reached right through
//   the part when it was placed (plus a margin) - a number, so it replays the
//   same whatever later edits do; each cutter starts `HOLE_CLEARANCE_MM` above
//   the face so the mouth is cut clean, and a chamfer's wedge runs
//   `CHAMFER_END_RUN_MM` past each end of its edge for the same reason.
//
// WO-2090: the Model screen's Shell and Draft on an STL are this edit too
// (geometry in ./shellAndDraft.ts):
//   - 'shell': the part's inside - every face moved `thicknessMm` into the
//     material, the faces to open moved out past themselves - cut out of it.
//   - 'draft': the picked faces turned to `angleDeg` about the neutral plane,
//     their corners slid along the faces beside them. No kernel cut: only
//     corners move, so every facet is still the facet it was.
//   Their selection is the picked faces themselves (the faces to open, the
//   faces to draft), found again from the point and normal each one records.

import { computeBoundingBox } from '../../analysis';
import {
  booleanMeshWithAncestry,
  BOOLEAN_TRIANGLE_ADDED,
  sharedManifoldModule,
  solidShellCount,
} from '../../manifoldOps';
import type { ManifoldWasmModule } from '../../manifoldKernel';
import type { MeshBuffers, Vec3 } from '../../types';
import { facetCount, facetVertices, vertexCount } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
} from '../types';
import { boreSegments } from './enlargeHole';
import {
  draftFacesMesh,
  facetsOnFaces,
  sameElementsAncestry,
  shellInside,
  type MeshFaceRef,
} from './shellAndDraft';
import { shellByConstruction, shellConstructionPlan, shellOnePieceThickness } from './shellByConstruction';

export const BOOLEAN_BODY_KIND = 'boolean-body';
export const BOOLEAN_BODY_VERSION = 1;

export type BooleanBodyOperation = 'add' | 'subtract';
export type BooleanBodyShape = 'box' | 'cylinder' | 'hole' | 'chamfer' | 'shell' | 'draft';

/** WO-2089: one straight edge a chamfer is cut from (or added into). */
export interface BooleanBodyChamferEdge {
  /** the edge's two ends, part coordinates, mm */
  start: [number, number, number];
  end: [number, number, number];
  /** unit directions from the edge INTO each of its two faces, square to it */
  faceDirections: [[number, number, number], [number, number, number]];
  /** 'subtract' for an outside edge, 'add' for an inside corner */
  operation: BooleanBodyOperation;
}

export interface BooleanBodyParameters {
  /** WO-2090: a shell cuts ('subtract'); a draft both adds and cuts, either
   *  side of its neutral plane, and records 'subtract' - nothing reads it */
  operation: BooleanBodyOperation;
  shape: BooleanBodyShape;
  /** the middle of the shape, in the part's own (STL file) coordinates, mm */
  center: [number, number, number];
  /** box only: its X, Y and Z lengths, mm */
  size?: [number, number, number];
  /** cylinder only: its diameter, mm */
  diameterMm?: number;
  /** cylinder only: its length along its axis, mm */
  lengthMm?: number;
  /** cylinder only: which way its axis runs. hole: the picked face's outward
   *  normal - the hole runs the other way, into the part */
  axisDirection?: [number, number, number];
  /** hole: every hole's centre on the face (the first is `center`). Its
   *  `diameterMm` is the bore, `lengthMm` how deep the bore is cut below the
   *  face (the reach right through the part, for a through hole). */
  points?: [number, number, number][];
  through?: boolean;
  counterboreDiameterMm?: number;
  counterboreDepthMm?: number;
  countersinkDiameterMm?: number;
  countersinkAngleDeg?: number;
  /** chamfer: the edges, and how far the chamfer runs back along each face */
  edges?: BooleanBodyChamferEdge[];
  distanceMm?: number;
  /** WO-2090 shell: the faces to open; draft: the faces to draft */
  faces?: MeshFaceRef[];
  /** shell: the wall thickness, mm */
  thicknessMm?: number;
  /** draft: the angle each face is turned to, degrees from the pull direction */
  angleDeg?: number;
  /** draft: the pull direction, and a point on the neutral plane */
  pullDirection?: [number, number, number];
  neutralPoint?: [number, number, number];
}

const PARAMETER_KEYS = new Set([
  'operation',
  'shape',
  'center',
  'size',
  'diameterMm',
  'lengthMm',
  'axisDirection',
  'points',
  'through',
  'counterboreDiameterMm',
  'counterboreDepthMm',
  'countersinkDiameterMm',
  'countersinkAngleDeg',
  'edges',
  'distanceMm',
  'faces',
  'thicknessMm',
  'angleDeg',
  'pullDirection',
  'neutralPoint',
]);

/** WO-2089: how far above the face a hole's cutters start, mm. */
export const HOLE_CLEARANCE_MM = 1;
/** WO-2089: how far past each end of its edge a chamfer's wedge runs, mm. */
export const CHAMFER_END_RUN_MM = 0.01;

/** How far past the shape's own box a facet may sit and still be part of what
 *  the edit selected, mm. */
const SELECTION_REACH_MM = 1;

// ---------------------------------------------------------------- vectors

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
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

// ------------------------------------------------------------- the shapes

function soup(coords: number[]): MeshBuffers {
  const positions = Float32Array.from(coords);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** A closed, outward-wound box. */
function boxMesh(center: Vec3, size: Vec3): MeshBuffers {
  const lo: Vec3 = [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2];
  const hi: Vec3 = [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2];
  const corner = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  // each face as a quad, counter-clockwise seen from outside
  const faces = [
    [0, 2, 3, 1], // -Z
    [4, 5, 7, 6], // +Z
    [0, 1, 5, 4], // -Y
    [2, 6, 7, 3], // +Y
    [0, 4, 6, 2], // -X
    [1, 3, 7, 5], // +X
  ];
  const coords: number[] = [];
  for (const [a, b, c, d] of faces) {
    coords.push(...corner(a), ...corner(b), ...corner(c));
    coords.push(...corner(a), ...corner(c), ...corner(d));
  }
  return soup(coords);
}

/** A closed, outward-wound cylinder, as a prism with its corners ON the
 *  circle - the same convention and the same corner count WO-1850 bores with,
 *  so what WO-1846 measures back out of a cut is the diameter that was typed. */
function cylinderMesh(center: Vec3, axisDirection: Vec3, diameterMm: number, lengthMm: number): MeshBuffers {
  const axis = unit(axisDirection);
  const radius = diameterMm / 2;
  const segments = boreSegments(radius);
  const u = perpendicular(axis);
  const v = cross(axis, u);
  const from = -lengthMm / 2;
  const to = lengthMm / 2;
  const at = (k: number, s: number): Vec3 => {
    const t = (2 * Math.PI * k) / segments;
    const cos = Math.cos(t) * radius;
    const sin = Math.sin(t) * radius;
    return [
      center[0] + axis[0] * s + u[0] * cos + v[0] * sin,
      center[1] + axis[1] * s + u[1] * cos + v[1] * sin,
      center[2] + axis[2] * s + u[2] * cos + v[2] * sin,
    ];
  };
  const lowCentre: Vec3 = [center[0] + axis[0] * from, center[1] + axis[1] * from, center[2] + axis[2] * from];
  const highCentre: Vec3 = [center[0] + axis[0] * to, center[1] + axis[1] * to, center[2] + axis[2] * to];
  const coords: number[] = [];
  for (let k = 0; k < segments; k++) {
    const j = (k + 1) % segments;
    const lk = at(k, from);
    const lj = at(j, from);
    const hk = at(k, to);
    const hj = at(j, to);
    coords.push(...lk, ...lj, ...hk);
    coords.push(...lj, ...hj, ...hk);
    coords.push(...lowCentre, ...lj, ...lk);
    coords.push(...highCentre, ...hk, ...hj);
  }
  return soup(coords);
}

const along = (p: Vec3, axis: Vec3, s: number): Vec3 => [p[0] + axis[0] * s, p[1] + axis[1] * s, p[2] + axis[2] * s];

/** One ring of a hole cutter: where it sits along the axis from the hole's
 *  point on the face (+ out of the part, - into it), and how wide it is. */
interface CutterRing {
  station: number;
  diameterMm: number;
}

/**
 * WO-2089: a hole's cutter - a prism (or a cone) on the axis through `point`
 * with a ring of corners at every `rings` station, lowest first, capped at
 * both ends. Two things make the hole it cuts READ BACK as a hole (WO-1846),
 * both MEASURED on Platte C, 2026-09-27 - without them every hole drilled at
 * every position tried was refused as "possible-bore-obstruction":
 *   - a ring sits exactly on every face the hole passes through (`holeRings`),
 *     so the kernel meets the face along the cutter's own corners and keeps
 *     each wall facet whole, instead of clipping it there and splitting it
 *     unevenly - which tilted the axis fitted to the bore by ~4e-8;
 *   - every corner is on the float32 grid and exactly opposite its partner
 *     across the axis, so rounding cannot pull the fitted axis either.
 * Corners are ON the circle, WO-1850's count, as the cylinder's are.
 */
function ringedCutter(point: Vec3, axis: Vec3, rings: readonly CutterRing[], grid: HoleGrid): HoleCutter {
  const { segments, step } = grid;
  const u = perpendicular(axis);
  const v = cross(axis, u);
  const snap = (n: number) => Math.round(n / step) * step;
  const base = point.map(snap) as Vec3;
  const corners = rings.map((ring) => {
    const radius = ring.diameterMm / 2;
    const at = axis.map((a) => snap(a * ring.station)) as Vec3;
    const offsets: Vec3[] = [];
    for (let k = 0; k < segments; k++) {
      if (k >= segments / 2) {
        const o = offsets[k - segments / 2];
        offsets.push([-o[0], -o[1], -o[2]]);
        continue;
      }
      const t = (2 * Math.PI * k) / segments;
      const cos = Math.cos(t) * radius;
      const sin = Math.sin(t) * radius;
      offsets.push([snap(u[0] * cos + v[0] * sin), snap(u[1] * cos + v[1] * sin), snap(u[2] * cos + v[2] * sin)]);
    }
    return {
      centre: [base[0] + at[0], base[1] + at[1], base[2] + at[2]] as Vec3,
      ring: offsets.map((o): Vec3 => [base[0] + at[0] + o[0], base[1] + at[1] + o[1], base[2] + at[2] + o[2]]),
    };
  });
  const coords: number[] = [];
  const low = corners[0];
  const high = corners[corners.length - 1];
  for (let k = 0; k < segments; k++) {
    const j = (k + 1) % segments;
    for (let r = 0; r + 1 < corners.length; r++) {
      const lk = corners[r].ring[k];
      const lj = corners[r].ring[j];
      const hk = corners[r + 1].ring[k];
      const hj = corners[r + 1].ring[j];
      coords.push(...lk, ...lj, ...hk);
      coords.push(...lj, ...hj, ...hk);
    }
    coords.push(...low.centre, ...low.ring[j], ...low.ring[k]);
    coords.push(...high.centre, ...high.ring[k], ...high.ring[j]);
  }
  return { mesh: soup(coords), rims: corners.map((c) => c.ring) };
}

/** The corner count and float32 grid the cutters of one hole share, so where
 *  two of them have a ring at the same station and width (a countersink's
 *  cone meeting its bore) their corners are the same points. (A counterbore
 *  keeps its own corner count: sharing it lays the bore's corners exactly on
 *  the counterbore floor's own edges, and the kernel's cut there is not a
 *  closed solid - measured.) */
interface HoleGrid {
  segments: number;
  /** one float32 step at the largest magnitude any corner can have: every
   *  multiple of it up to there is exact in float32, and so is every sum */
  step: number;
}

function holeGrid(point: Vec3, reachMm: number, widestMm: number): HoleGrid {
  const reach = Math.max(...point.map(Math.abs)) + reachMm + widestMm;
  return { segments: boreSegments(widestMm / 2), step: 2 ** (Math.floor(Math.log2(reach)) - 23) };
}

/** A hole cutter, and its rings of corners (for `foldRimPoints`). */
interface HoleCutter {
  mesh: MeshBuffers;
  rims: Vec3[][];
}

/** How close to a cutter's rim edge a corner of the cut must lie to be one
 *  the kernel made on it, mm - float32 at a metre is 6e-5. */
const RIM_POINT_TOLERANCE_MM = 1e-4;

/**
 * WO-2089: fold every corner the kernel made ON a cutter's rim edge - where an
 * edge of the part's face crossed it - onto the nearer of that edge's two
 * cutter corners, and drop the facets that folding flattens. The point lies on
 * the straight edge between the two, so no facet moves off its plane and the
 * shape is exactly the same; what changes is that the bore's wall is the
 * cutter's own facets, evenly split. MEASURED, Platte C 2026-09-27: those
 * extra rim corners are uneven around the rim, the axis WO-1846 fits to the
 * bore comes back ~1e-11 off true, the part's own face then reads as an
 * obstruction inside the bore, and the hole just drilled is not recognised.
 * Returns the mesh and, per facet of it, the facet of `mesh` it was.
 */
function foldRimPoints(mesh: MeshBuffers, rims: readonly Vec3[][]): { mesh: MeshBuffers; kept: Int32Array } {
  const key = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
  const vertexAt = new Map<string, number>();
  for (let i = 0; i < vertexCount(mesh); i++) {
    vertexAt.set(key(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]), i);
  }
  const target = new Int32Array(vertexCount(mesh)).map((_, i) => i);
  let folded = 0;
  for (const rim of rims) {
    const lo = [0, 1, 2].map((a) => Math.min(...rim.map((c) => Math.fround(c[a]))) - RIM_POINT_TOLERANCE_MM);
    const hi = [0, 1, 2].map((a) => Math.max(...rim.map((c) => Math.fround(c[a]))) + RIM_POINT_TOLERANCE_MM);
    const cornerIndex = rim.map((c) => vertexAt.get(key(Math.fround(c[0]), Math.fround(c[1]), Math.fround(c[2]))));
    for (let i = 0; i < vertexCount(mesh); i++) {
      const p: Vec3 = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
      if (p.some((n, a) => n < lo[a] || n > hi[a]) || cornerIndex.includes(i)) continue;
      for (let k = 0; k < rim.length; k++) {
        const a = cornerIndex[k];
        const b = cornerIndex[(k + 1) % rim.length];
        if (a === undefined || b === undefined) continue;
        const A = rim[k];
        const ab = sub(rim[(k + 1) % rim.length], A);
        const ap = sub(p, A);
        const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]);
        if (t <= 0 || t >= 1) continue;
        const off = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
        if (Math.hypot(off[0], off[1], off[2]) > RIM_POINT_TOLERANCE_MM) continue;
        target[i] = t < 0.5 ? a : b;
        folded++;
        break;
      }
    }
  }
  if (folded === 0) return { mesh, kept: new Int32Array(facetCount(mesh)).map((_, f) => f) };
  const indices: number[] = [];
  const kept: number[] = [];
  for (let f = 0; f < facetCount(mesh); f++) {
    const [a, b, c] = [0, 1, 2].map((k) => target[mesh.indices[f * 3 + k]]);
    if (a === b || b === c || c === a) continue;
    indices.push(a, b, c);
    kept.push(f);
  }
  // Drop the corners no facet uses any more.
  const used = new Int32Array(vertexCount(mesh)).fill(-1);
  const positions: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (used[v] < 0) {
      used[v] = positions.length / 3;
      positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    }
    indices[i] = used[v];
  }
  return {
    mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    kept: Int32Array.from(kept),
  };
}

/** Where the line through `point` along `axis` crosses `mesh`'s surface,
 *  as stations along the axis from `point`. */
function surfaceCrossings(mesh: MeshBuffers, point: Vec3, axis: Vec3): number[] {
  const out: number[] = [];
  for (let facet = 0; facet < facetCount(mesh); facet++) {
    const [a, b, c] = facetVertices(mesh, facet);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const pv = cross(axis, e2);
    const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
    if (Math.abs(det) < 1e-12) continue;
    const tv = sub(point, a);
    const w1 = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
    if (w1 < -1e-9 || w1 > 1 + 1e-9) continue;
    const qv = cross(tv, e1);
    const w2 = (axis[0] * qv[0] + axis[1] * qv[1] + axis[2] * qv[2]) / det;
    if (w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
    out.push((e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det);
  }
  return out;
}

/** WO-2089: the rings of one hole cutter from `top` down to `bottom`, with a
 *  ring on every face of the part the hole passes through on the way (and at
 *  every station in `extra`, where another cutter of the same hole ends). */
function holeRings(
  mesh: MeshBuffers | undefined,
  point: Vec3,
  axis: Vec3,
  top: number,
  bottom: number,
  diameterAt: (station: number) => number,
  extra: readonly number[] = [],
): CutterRing[] {
  const crossings = mesh === undefined ? [] : surfaceCrossings(mesh, point, axis);
  const stations = [top, bottom, 0, ...extra, ...crossings]
    .filter((s) => s <= top && s >= bottom)
    .map((s) => Math.round(s * 1e6) / 1e6)
    .sort((x, y) => x - y)
    .filter((s, i, all) => i === 0 || s - all[i - 1] > 1e-4);
  return stations.map((station) => ({ station, diameterMm: diameterAt(station) }));
}

/** WO-2089: every hole's cutters - its bore, then its counterbore or its
 *  countersink. `axisDirection` is the face's outward normal; each hole runs
 *  the other way from its point. `mesh` is the part they cut, for the rings
 *  that sit on its faces; without it the cutters have the same extent. */
function holeCutters(p: BooleanBodyParameters, mesh?: MeshBuffers): HoleCutter[] {
  const axis = unit(p.axisDirection as Vec3);
  const bore = p.diameterMm as number;
  const out: HoleCutter[] = [];
  const top = HOLE_CLEARANCE_MM;
  const slope = Math.tan(((p.countersinkAngleDeg ?? 90) * Math.PI) / 360);
  const widest = p.counterboreDiameterMm ?? (p.countersinkDiameterMm !== undefined ? p.countersinkDiameterMm + 2 * top * slope : bore);
  for (const point of (p.points ?? [p.center]) as Vec3[]) {
    const grid = holeGrid(point, top + (p.lengthMm as number), Math.max(widest, bore));
    const mouthFloor = p.counterboreDiameterMm !== undefined
      ? -(p.counterboreDepthMm as number)
      : p.countersinkDiameterMm !== undefined
        ? -(p.countersinkDiameterMm - bore) / 2 / slope
        : undefined;
    const extra = mouthFloor === undefined ? [] : [mouthFloor];
    const boreGrid = p.countersinkDiameterMm !== undefined ? grid : { ...grid, segments: boreSegments(bore / 2) };
    out.push(ringedCutter(point, axis, holeRings(mesh, point, axis, top, -(p.lengthMm as number), () => bore, extra), boreGrid));
    if (p.counterboreDiameterMm !== undefined) {
      const wide = p.counterboreDiameterMm;
      const own = { ...grid, segments: boreSegments(wide / 2) };
      out.push(ringedCutter(point, axis, holeRings(mesh, point, axis, top, mouthFloor as number, () => wide), own));
    } else if (p.countersinkDiameterMm !== undefined && mouthFloor !== undefined) {
      // The cone: the typed diameter at the face, narrowing at the typed
      // included angle to the bore at `mouthFloor` - where its ring is the
      // bore's own ring, corner for corner - and on a little way inside the
      // bore, so its narrow end is cut in air, not along the bore's wall.
      const face = p.countersinkDiameterMm;
      const past = Math.min(0.1, bore / 4 / slope);
      const floor = Math.round(mouthFloor * 1e6) / 1e6;
      const widthAt = (s: number) => (s === floor ? bore : face + 2 * s * slope);
      out.push(ringedCutter(point, axis, holeRings(mesh, point, axis, top, mouthFloor - past, widthAt, extra), grid));
    }
  }
  return out;
}

/** WO-2089: one chamfer's wedge - a three-sided prism along the edge whose
 *  long face is the chamfer's flat, `distanceMm` back along each face. Its
 *  other two faces lie wholly on the far side of the corner (outside the part
 *  for an outside edge, inside it for an inside corner), so it takes away (or
 *  fills) the corner and nothing else. */
function chamferWedge(edge: BooleanBodyChamferEdge, distanceMm: number): MeshBuffers {
  const start = edge.start as Vec3;
  const end = edge.end as Vec3;
  const axis = unit(sub(end, start));
  const t1 = unit(edge.faceDirections[0] as Vec3);
  const t2 = unit(edge.faceDirections[1] as Vec3);
  const d = distanceMm;
  const run = 0.25; // how far the flat runs on past its two lines, x distance
  const bisector = unit([t1[0] + t2[0], t1[1] + t2[1], t1[2] + t2[2]]);
  const section = (p: Vec3): Vec3[] => [
    [0, 1, 2].map((a) => p[a] + d * (t1[a] + run * (t1[a] - t2[a]))) as Vec3,
    [0, 1, 2].map((a) => p[a] + d * (t2[a] + run * (t2[a] - t1[a]))) as Vec3,
    along(p, bisector, -run * d),
  ];
  const lo = section(along(start, axis, -CHAMFER_END_RUN_MM));
  const hi = section(along(end, axis, CHAMFER_END_RUN_MM));
  // Wind the end caps outward (the low cap faces back down the edge),
  // whichever way round the two faces were given.
  const n = cross(sub(lo[1], lo[0]), sub(lo[2], lo[0]));
  if (n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2] > 0) {
    lo.reverse();
    hi.reverse();
  }
  const coords: number[] = [...lo[0], ...lo[1], ...lo[2], ...hi[0], ...hi[2], ...hi[1]];
  for (let k = 0; k < 3; k++) {
    const j = (k + 1) % 3;
    coords.push(...lo[k], ...hi[k], ...hi[j]);
    coords.push(...lo[k], ...hi[j], ...lo[j]);
  }
  return soup(coords);
}

/** WO-2089: the solids this edit adds or cuts, in the order it applies them,
 *  each exactly as the kernel will be handed it. A box or a cylinder is one.
 *  `mesh` is the part they are applied to (a hole's cutters ring its faces). */
export function booleanBodyOperands(
  parameters: BooleanBodyParameters,
  mesh?: MeshBuffers,
): Array<{ mesh: MeshBuffers; operation: BooleanBodyOperation; rims?: Vec3[][] }> {
  if (parameters.shape === 'hole') {
    return holeCutters(parameters, mesh).map((cutter) => ({ ...cutter, operation: 'subtract' as const }));
  }
  if (parameters.shape === 'chamfer') {
    return (parameters.edges ?? []).map((edge) => ({
      mesh: chamferWedge(edge, parameters.distanceMm as number),
      operation: edge.operation,
    }));
  }
  if (parameters.shape === 'shell') {
    if (mesh === undefined) throw new Error("A shell's inside is made from the part it hollows.");
    const open = facetsOnFaces(mesh, parameters.faces ?? []).flat();
    return [{ mesh: shellInside(mesh, open, parameters.thicknessMm as number), operation: 'subtract' }];
  }
  if (parameters.shape === 'draft') throw new Error('A draft moves faces; it adds or cuts no solid.');
  return [{ mesh: booleanBodyOperand(parameters), operation: parameters.operation }];
}

/** The box or cylinder this edit adds or cuts, exactly as the kernel will be
 *  handed it. (A hole or a chamfer is several: `booleanBodyOperands`.) */
export function booleanBodyOperand(parameters: BooleanBodyParameters): MeshBuffers {
  const center = parameters.center as Vec3;
  if (parameters.shape === 'box') return boxMesh(center, parameters.size as Vec3);
  if (parameters.shape !== 'cylinder') {
    throw new Error(`A ${parameters.shape} is several solids, not one - booleanBodyOperands lists them.`);
  }
  return cylinderMesh(
    center,
    parameters.axisDirection as Vec3,
    parameters.diameterMm as number,
    parameters.lengthMm as number,
  );
}

/** "10.00 x 10.00 x 10.00 mm box", "12.00 mm cylinder, 10.00 mm long". */
function shapeWords(p: Partial<BooleanBodyParameters>): string {
  const mm = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : '?');
  if (p.shape === 'box') {
    const s = Array.isArray(p.size) ? p.size : [];
    return `${mm(s[0])} x ${mm(s[1])} x ${mm(s[2])} mm box`;
  }
  if (p.shape === 'cylinder') return `${mm(p.diameterMm)} mm cylinder, ${mm(p.lengthMm)} mm long`;
  return 'shape';
}

/** WO-2089: "Drilled 2 x 6.00 mm holes, 5.00 mm deep, counterbored 9.00 mm x
 *  2.00 mm deep" / "Chamfered 1 edge 1.00 mm"; null for a box or cylinder. */
function holeOrChamferWords(p: Partial<BooleanBodyParameters>): string | null {
  const mm = (n: unknown) => (typeof n === 'number' ? n.toFixed(2) : '?');
  if (p.shape === 'hole') {
    const count = Array.isArray(p.points) ? p.points.length : 1;
    const what = count === 1 ? `a ${mm(p.diameterMm)} mm hole` : `${count} x ${mm(p.diameterMm)} mm holes`;
    const depth = p.through === true ? 'through' : `${mm(p.lengthMm)} mm deep`;
    const mouth = p.counterboreDiameterMm !== undefined
      ? `, counterbored ${mm(p.counterboreDiameterMm)} mm x ${mm(p.counterboreDepthMm)} mm deep`
      : p.countersinkDiameterMm !== undefined
        ? `, countersunk ${mm(p.countersinkDiameterMm)} mm x ${mm(p.countersinkAngleDeg)} deg`
        : '';
    return `Drilled ${what}, ${depth}${mouth}`;
  }
  if (p.shape === 'chamfer') {
    const count = Array.isArray(p.edges) ? p.edges.length : 0;
    return `Chamfered ${count} edge${count === 1 ? '' : 's'} ${mm(p.distanceMm)} mm`;
  }
  const faces = Array.isArray(p.faces) ? p.faces.length : 0;
  const faceWord = `${faces} face${faces === 1 ? '' : 's'}`;
  if (p.shape === 'shell') return `Shelled to a ${mm(p.thicknessMm)} mm wall, ${faceWord} open`;
  if (p.shape === 'draft') return `Drafted ${faceWord} ${mm(p.angleDeg)} deg`;
  return null;
}

// ------------------------------------------------------------ the selection

/**
 * The facets of `mesh` this edit is recorded against (see the decide-and-log
 * note at the top): every facet with a corner inside the shape's box, grown by
 * `SELECTION_REACH_MM`; or the one facet nearest the shape when it reaches
 * none. Never empty for a mesh with facets.
 */
export function booleanBodySelection(mesh: MeshBuffers, parameters: Record<string, unknown>): number[] {
  const valid = booleanBodyOperation.validate(parameters);
  // WO-2090: a shell or a draft is recorded against the faces it picked.
  if (valid.shape === 'shell' || valid.shape === 'draft') {
    return [...new Set(facetsOnFaces(mesh, valid.faces ?? []).flat())].sort((a, b) => a - b);
  }
  const boxes = booleanBodyOperands(valid).map((o) => computeBoundingBox(o.mesh));
  const box = {
    min: [0, 1, 2].map((a) => Math.min(...boxes.map((b) => b.min[a]))),
    max: [0, 1, 2].map((a) => Math.max(...boxes.map((b) => b.max[a]))),
  };
  const lo = box.min.map((n) => n - SELECTION_REACH_MM);
  const hi = box.max.map((n) => n + SELECTION_REACH_MM);
  const centre: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const out: number[] = [];
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let facet = 0; facet < facetCount(mesh); facet++) {
    const corners = facetVertices(mesh, facet);
    let inside = false;
    for (const p of corners) {
      if (p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2]) {
        inside = true;
        break;
      }
    }
    if (inside) {
      out.push(facet);
      continue;
    }
    const mid: Vec3 = [
      (corners[0][0] + corners[1][0] + corners[2][0]) / 3,
      (corners[0][1] + corners[1][1] + corners[2][1]) / 3,
      (corners[0][2] + corners[1][2] + corners[2][2]) / 3,
    ];
    const d = sub(mid, centre);
    const distance = Math.hypot(d[0], d[1], d[2]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = facet;
    }
  }
  if (out.length === 0 && nearest >= 0) out.push(nearest);
  return out;
}

// ------------------------------------------------------------- the ancestry

const positionKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * 1e5)}:${Math.round(y * 1e5)}:${Math.round(z * 1e5)}`;

/** Who became what across the boolean (ADR-0051 s4.4): the triangle half out
 *  of manifold's own face ids, the vertex half by exact position. A facet no
 *  entry claims is new, and `composeSourceFacetIds` marks it NO_SOURCE_FACET. */
function booleanAncestry(input: MeshBuffers, output: MeshBuffers, leftTriangle: Int32Array): MeshEditAncestry {
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

// ------------------------------------------------------------- the operation

/**
 * Add the shape to `mesh`, or cut it out. Throws a sentence naming what
 * LienCAM cannot do - and only that.
 */
export function booleanBody(mesh: MeshBuffers, parameters: BooleanBodyParameters): MeshEditApplyResult {
  if (parameters.shape === 'shell' || parameters.shape === 'draft') {
    const found = facetsOnFaces(mesh, parameters.faces ?? []);
    if (found.some((facets) => facets.length === 0)) {
      throw new Error(`A face to ${parameters.shape === 'shell' ? 'open' : 'draft'} is no longer on this part, so nothing was changed.`);
    }
    if (parameters.shape === 'draft') {
      const drafted = draftFacesMesh(
        mesh,
        found.map((facets, i) => ({ face: (parameters.faces as MeshFaceRef[])[i], facets })),
        {
          angleDeg: parameters.angleDeg as number,
          pullDirection: parameters.pullDirection as [number, number, number],
          neutralPoint: parameters.neutralPoint as [number, number, number],
        },
      );
      return { mesh: drafted, ancestry: sameElementsAncestry(drafted) };
    }
  }
  const module = sharedManifoldModule();
  if (!module) {
    throw new Error(
      'The boolean kernel has not finished loading yet, so the shape was not ' +
        (parameters.operation === 'add' ? 'added' : 'cut') + '. Nothing was changed; try again in a moment.',
    );
  }
  const shape = parameters.shape;
  // WO-2089: a hole or a chamfer is several pieces, applied in turn; each
  // step's ancestry is composed onto the steps before, so `leftTriangle` still
  // names a facet of the part as it was handed in.
  let result = { mesh, measures: { componentCount: 0 } };
  let leftTriangle: Int32Array | null = null;
  try {
    for (const operand of booleanBodyOperands(parameters, mesh)) {
      const step = booleanMeshWithAncestry(module, result.mesh, operand.mesh, {
        operation: operand.operation === 'add' ? 'union' : 'difference',
        leftName: 'the part',
        rightName: 'the ' + shape,
      });
      const before: Int32Array | null = leftTriangle;
      let stepTriangle = step.leftTriangle;
      result = step.result;
      if (operand.rims !== undefined && result.mesh.indices.length > 0) {
        const folded = foldRimPoints(result.mesh, operand.rims);
        stepTriangle = folded.kept.map((f) => step.leftTriangle[f]);
        result = { mesh: folded.mesh, measures: result.measures };
      }
      leftTriangle = before === null
        ? stepTriangle
        : stepTriangle.map((t) => (t === BOOLEAN_TRIANGLE_ADDED ? BOOLEAN_TRIANGLE_ADDED : before[t]));
      if (result.mesh.indices.length === 0) break;
    }
  } catch (err) {
    // WO-2118: a direct shell the kernel cannot run (its inside turned inside
    // out at a thick wall) is not the end of Shell either.
    if (shape !== 'shell') throw err;
    return shellThatSplit(module, mesh, parameters, { error: err });
  }
  if (leftTriangle === null) throw new Error(`The ${shape} has nothing in it, so nothing was changed.`);
  const shells = result.measures.componentCount;
  if (result.mesh.indices.length === 0) {
    throw new Error(`Cutting the ${shape} out would leave nothing of the part, so nothing was changed.`);
  }
  const before = solidShellCount(mesh);
  if (shells > Math.max(1, before)) {
    if (shape === 'shell') return shellThatSplit(module, mesh, parameters, { pieces: shells });
    throw new Error(
      parameters.operation === 'add'
        ? `The ${shape} does not touch the part, so adding it would make ${shells} separate solids ` +
            'in one part. Nothing was changed.'
        : `Cutting the ${shape} out would split the part into ${shells} separate pieces. Nothing was changed.`,
    );
  }
  return { mesh: result.mesh, ancestry: booleanAncestry(mesh, result.mesh, leftTriangle) };
}

/** WO-2118: the direct shell would split the part (or the kernel could not run
 *  it). Build it the way the STEP route does (./shellByConstruction.ts) - the
 *  plain block hollowed, a wall kept round each blind hole and pocket - and
 *  take that when it is one piece; otherwise say how many pieces and the
 *  thinnest wall that keeps it one. Where the route does not apply, the direct
 *  shell's own answer stands. */
function shellThatSplit(
  module: ManifoldWasmModule,
  mesh: MeshBuffers,
  parameters: BooleanBodyParameters,
  direct: { pieces: number } | { error: unknown },
): MeshEditApplyResult {
  const t = parameters.thicknessMm as number;
  const faces = parameters.faces ?? [];
  const plan = faces.length === 1 ? shellConstructionPlan(module, mesh, faces[0]) : null;
  const built = plan === null ? null : shellByConstruction(module, mesh, plan, t);
  if (built !== null && built.pieces === 1) {
    return { mesh: built.mesh, ancestry: booleanAncestry(mesh, built.mesh, built.leftTriangle) };
  }
  if ('error' in direct && built === null) throw direct.error;
  const pieces = built?.pieces ?? ('pieces' in direct ? direct.pieces : 0);
  if (plan === null) {
    throw new Error(`A ${t} mm shell would split the part into ${pieces} separate pieces. Nothing was changed.`);
  }
  const onePiece = shellOnePieceThickness(module, mesh, plan, t);
  throw new Error(
    `A ${t} mm shell would split the part into ${pieces} separate pieces: the ${t} mm walls round some of its ` +
      'holes or pockets touch nothing else. ' +
      (onePiece !== null
        ? `The thinnest wall that keeps it one piece is ${onePiece} mm. `
        : 'No wall thickness Shell can build keeps it in one piece. ') +
      'Nothing was changed.',
  );
}

/** The sentence this edit would refuse with, or null when it goes through.
 *  The panel asks BEFORE it records, so a refusal never reaches the journal. */
export function booleanBodyRefusal(mesh: MeshBuffers, parameters: Record<string, unknown>): string | null {
  try {
    booleanBody(mesh, booleanBodyOperation.validate(parameters));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const booleanBodyOperation: MeshEditOperation<BooleanBodyParameters> = {
  kind: BOOLEAN_BODY_KIND,
  version: BOOLEAN_BODY_VERSION,
  label: 'Add or cut a shape',

  describe(record: MeshEditRecord): string {
    const p = (record.parameters ?? {}) as Partial<BooleanBodyParameters>;
    const at = Array.isArray(p.center) ? p.center.map((n) => Number(n).toFixed(2)).join(', ') : '?';
    const words = holeOrChamferWords(p);
    if (words !== null) return `${words} at ${at}`;
    return p.operation === 'subtract'
      ? `Cut a ${shapeWords(p)} out at ${at}`
      : `Added a ${shapeWords(p)} at ${at}`;
  },

  validate(parameters: Record<string, unknown>): BooleanBodyParameters {
    const given = parameters ?? {};
    const extra = Object.keys(given).filter((key) => !PARAMETER_KEYS.has(key));
    if (extra.length > 0) throw new Error(`"${BOOLEAN_BODY_KIND}" does not take ${extra.join(', ')}.`);
    const operation = given.operation;
    if (operation !== 'add' && operation !== 'subtract') {
      throw new Error(`"${BOOLEAN_BODY_KIND}" adds or subtracts; "${String(operation)}" is neither.`);
    }
    const center = triple(given.center, 'center');
    if (given.shape === 'hole') return validateHole(given, operation, center);
    if (given.shape === 'chamfer') return validateChamfer(given, operation, center);
    if (given.shape === 'shell' || given.shape === 'draft') return validateShellOrDraft(given, operation, center);
    if (given.shape === 'box') {
      const size = triple(given.size, 'size');
      size.forEach((n, i) => measurement(n, `${'XYZ'[i]} length`));
      if (given.diameterMm !== undefined || given.lengthMm !== undefined || given.axisDirection !== undefined) {
        throw new Error(`A box in "${BOOLEAN_BODY_KIND}" has a size, not a diameter, length or axis.`);
      }
      return { operation, shape: 'box', center, size };
    }
    if (given.shape === 'cylinder') {
      if (given.size !== undefined) {
        throw new Error(`A cylinder in "${BOOLEAN_BODY_KIND}" has a diameter and a length, not a size.`);
      }
      const axisDirection = triple(given.axisDirection, 'axisDirection');
      if (Math.hypot(...axisDirection) === 0) {
        throw new Error('This cylinder has no axis direction, so LienCAM cannot tell which way it runs.');
      }
      return {
        operation,
        shape: 'cylinder',
        center,
        diameterMm: measurement(given.diameterMm, 'diameter'),
        lengthMm: measurement(given.lengthMm, 'length'),
        axisDirection,
      };
    }
    throw new Error(`"${BOOLEAN_BODY_KIND}" makes a box or a cylinder (or a hole, a chamfer, a shell or a draft); "${String(given.shape)}" is none of those.`);
  },

  apply({ mesh, parameters }: MeshEditApplyInput<BooleanBodyParameters>): MeshEditApplyResult {
    return booleanBody(mesh, parameters);
  },
};

/** The keys a shape was given that it does not take, named. */
function onlyKeys(given: Record<string, unknown>, shape: string, allowed: readonly string[]): void {
  const wrong = Object.keys(given).filter((key) => !allowed.includes(key));
  if (wrong.length > 0) throw new Error(`A ${shape} in "${BOOLEAN_BODY_KIND}" does not take ${wrong.join(', ')}.`);
}

function validateHole(
  given: Record<string, unknown>,
  operation: BooleanBodyOperation,
  center: [number, number, number],
): BooleanBodyParameters {
  onlyKeys(given, 'hole', [
    'operation', 'shape', 'center', 'axisDirection', 'points', 'diameterMm', 'lengthMm', 'through',
    'counterboreDiameterMm', 'counterboreDepthMm', 'countersinkDiameterMm', 'countersinkAngleDeg',
  ]);
  if (operation !== 'subtract') throw new Error(`A hole in "${BOOLEAN_BODY_KIND}" is cut, not added.`);
  const axisDirection = triple(given.axisDirection, 'axisDirection');
  if (Math.hypot(...axisDirection) === 0) {
    throw new Error('This hole has no direction, so LienCAM cannot tell which way it runs.');
  }
  if (!Array.isArray(given.points) || given.points.length === 0) {
    throw new Error(`A hole in "${BOOLEAN_BODY_KIND}" needs at least one point.`);
  }
  const out: BooleanBodyParameters = {
    operation,
    shape: 'hole',
    center,
    axisDirection,
    points: given.points.map((p) => triple(p, 'point')),
    diameterMm: measurement(given.diameterMm, 'diameter'),
    lengthMm: measurement(given.lengthMm, 'depth'),
  };
  if (given.through !== undefined) {
    if (given.through !== true) throw new Error(`A hole's "through" in "${BOOLEAN_BODY_KIND}" is true or absent.`);
    out.through = true;
  }
  if (given.counterboreDiameterMm !== undefined || given.counterboreDepthMm !== undefined) {
    out.counterboreDiameterMm = measurement(given.counterboreDiameterMm, 'counterbore diameter');
    out.counterboreDepthMm = measurement(given.counterboreDepthMm, 'counterbore depth');
  }
  if (given.countersinkDiameterMm !== undefined || given.countersinkAngleDeg !== undefined) {
    if (out.counterboreDiameterMm !== undefined) {
      throw new Error(`A hole in "${BOOLEAN_BODY_KIND}" has a counterbore or a countersink, not both.`);
    }
    out.countersinkDiameterMm = measurement(given.countersinkDiameterMm, 'countersink diameter');
    const angle = measurement(given.countersinkAngleDeg, 'countersink angle');
    if (angle >= 180) throw new Error(`A countersink angle of ${angle} degrees is not a cone.`);
    out.countersinkAngleDeg = angle;
  }
  return out;
}

function validateChamfer(
  given: Record<string, unknown>,
  operation: BooleanBodyOperation,
  center: [number, number, number],
): BooleanBodyParameters {
  onlyKeys(given, 'chamfer', ['operation', 'shape', 'center', 'edges', 'distanceMm']);
  if (!Array.isArray(given.edges) || given.edges.length === 0) {
    throw new Error(`A chamfer in "${BOOLEAN_BODY_KIND}" needs at least one edge.`);
  }
  const edges = given.edges.map((raw): BooleanBodyChamferEdge => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const start = triple(e.start, 'edge start');
    const end = triple(e.end, 'edge end');
    if (Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]) === 0) {
      throw new Error('A chamfer edge has no length, so LienCAM cannot tell which way it runs.');
    }
    if (!Array.isArray(e.faceDirections) || e.faceDirections.length !== 2) {
      throw new Error(`A chamfer edge in "${BOOLEAN_BODY_KIND}" needs the directions into its two faces.`);
    }
    if (e.operation !== 'add' && e.operation !== 'subtract') {
      throw new Error(`A chamfer edge adds or subtracts; "${String(e.operation)}" is neither.`);
    }
    return {
      start,
      end,
      faceDirections: [triple(e.faceDirections[0], 'face direction'), triple(e.faceDirections[1], 'face direction')],
      operation: e.operation,
    };
  });
  return { operation, shape: 'chamfer', center, edges, distanceMm: measurement(given.distanceMm, 'chamfer distance') };
}

function validateShellOrDraft(
  given: Record<string, unknown>,
  operation: BooleanBodyOperation,
  center: [number, number, number],
): BooleanBodyParameters {
  const shape = given.shape as 'shell' | 'draft';
  onlyKeys(given, shape, shape === 'shell'
    ? ['operation', 'shape', 'center', 'faces', 'thicknessMm']
    : ['operation', 'shape', 'center', 'faces', 'angleDeg', 'pullDirection', 'neutralPoint']);
  if (operation !== 'subtract') throw new Error(`A ${shape} in "${BOOLEAN_BODY_KIND}" is recorded as 'subtract'.`);
  if (!Array.isArray(given.faces) || given.faces.length === 0) {
    throw new Error(`A ${shape} in "${BOOLEAN_BODY_KIND}" needs at least one face.`);
  }
  const faces = given.faces.map((raw): MeshFaceRef => {
    const face = (raw ?? {}) as Record<string, unknown>;
    const normal = triple(face.normal, 'face normal');
    if (Math.hypot(...normal) === 0) throw new Error(`A face in "${BOOLEAN_BODY_KIND}" needs a normal that is not zero.`);
    return { point: triple(face.point, 'face point'), normal };
  });
  if (shape === 'shell') {
    return { operation, shape, center, faces, thicknessMm: measurement(given.thicknessMm, 'wall thickness') };
  }
  const angleDeg = measurement(given.angleDeg, 'draft angle');
  if (angleDeg >= 90) throw new Error(`A draft of ${angleDeg} degrees would lay the face flat.`);
  const pullDirection = triple(given.pullDirection, 'pull direction');
  if (Math.hypot(...pullDirection) === 0) throw new Error(`A draft in "${BOOLEAN_BODY_KIND}" needs a pull direction that is not zero.`);
  return { operation, shape, center, faces, angleDeg, pullDirection, neutralPoint: triple(given.neutralPoint, 'neutral point') };
}

function measurement(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`"${BOOLEAN_BODY_KIND}" was given a ${label} of "${String(value)}", which is not a measurement.`);
  }
  return value;
}

function triple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error(`"${BOOLEAN_BODY_KIND}" needs a ${label} of three finite numbers.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

registerMeshEditOperation(booleanBodyOperation);
