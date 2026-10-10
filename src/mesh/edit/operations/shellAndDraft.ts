// WO-2090: the geometry of the Model screen's Shell and Draft on an STL.
//
// Both are recorded as shapes of the boolean-body edit (booleanBody.ts), so
// they replay wherever a journal is resolved, as WO-2089's Hole and Chamfer
// do. This file is the geometry they share: which facets a picked flat face
// is, and one solver that moves the planes of a mesh's faces and re-seats every
// corner on the planes it lies on.
//
//   - Shell: every face of the part moves INTO the material by the wall
//     thickness, except the faces to open, which move OUT by
//     `SHELL_OPEN_CLEARANCE_MM`. That moved copy is the part's inside, and
//     cutting it out of the part leaves walls of the typed thickness, open
//     through the picked faces. A bore's wall moves too, so every hole keeps a
//     tube of wall round it.
//   - Draft: each picked face turns about the line where it meets the neutral
//     plane until it stands at the typed angle to the pull direction; its
//     corners slide along the faces beside it, so those stay flat and the part
//     stays closed. The kernel's own convention (GEO-4, src/tests/geom/
//     draft.test.ts): the part grows AGAINST the pull direction - with the
//     neutral face's own normal as the pull, it grows away from that face.
//
// A corner is re-seated by the smallest move that puts it on every (moved)
// plane of the facets round it - exact where three faces meet, and along the
// edge where two do. Where more than three different planes meet (the tip of a
// cone) the move is their least-squares compromise.
//
// DECIDE-AND-LOG (rule 3): a face is recorded as a point on it (a facet's
// centre) and its outward normal - numbers, so it replays the same - and is
// found again as every facet on that plane joined edge-to-edge to the facet
// under the point. Two separate faces on one plane stay separate.

import type { MeshBuffers, Vec3 } from '../../types';
import { weldMesh, type WeldedMesh } from '../../recognition/topology';
import { facetCount, vertexCount } from '../idView';

/** How far the inside of a shell reaches past a face it opens, mm, so the
 *  opening is cut clean. */
export const SHELL_OPEN_CLEARANCE_MM = 1;

/** A face as a record carries it: a point on it and its outward normal. */
export interface MeshFaceRef {
  point: [number, number, number];
  normal: [number, number, number];
}

/** Facets on a face's plane: normals within this of its normal (cos) ... */
const FACE_NORMAL_COS = 0.9999;
/** ... and corners within this of its plane, mm. */
const FACE_PLANE_MM = 1e-3;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

function corner(w: WeldedMesh, v: number): Vec3 {
  return [w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2]];
}
function normalOf(w: WeldedMesh, f: number): Vec3 {
  return [w.normals[f * 3], w.normals[f * 3 + 1], w.normals[f * 3 + 2]];
}

/** Is `p` inside facet `f` (or on its rim), seen along the facet's normal? */
function facetHolds(w: WeldedMesh, f: number, p: Vec3): boolean {
  const n = normalOf(w, f);
  const [a, b, c] = [0, 1, 2].map((k) => corner(w, w.facets[f * 3 + k]));
  const side = (u: Vec3, v: Vec3): number => {
    const e: Vec3 = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
    const q: Vec3 = [p[0] - u[0], p[1] - u[1], p[2] - u[2]];
    return dot(n, [e[1] * q[2] - e[2] * q[1], e[2] * q[0] - e[0] * q[2], e[0] * q[1] - e[1] * q[0]]);
  };
  const tol = -1e-9;
  return side(a, b) >= tol && side(b, c) >= tol && side(c, a) >= tol;
}

/**
 * The facets of `mesh` on each face: every facet on the face's plane joined
 * edge-to-edge to the one under its point (the nearest one on the plane, if
 * none lies under it). One list per face, ascending; empty when nothing of
 * `mesh` lies on that plane any more. Pure.
 */
export function facetsOnFaces(mesh: MeshBuffers, faces: readonly MeshFaceRef[]): number[][] {
  const w = weldMesh(mesh);
  return faces.map((face) => facetsOnFace(w, face));
}

function facetsOnFace(w: WeldedMesh, face: MeshFaceRef): number[] {
  const n = unit(face.normal as Vec3);
  const p = face.point as Vec3;
  const onPlane = new Uint8Array(w.facetCount);
  let seed = -1;
  let seedDistance = Infinity;
  for (let f = 0; f < w.facetCount; f++) {
    if (w.areas[f] === 0 || dot(normalOf(w, f), n) < FACE_NORMAL_COS) continue;
    let flat = true;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      const c = corner(w, w.facets[f * 3 + k]);
      if (Math.abs(dot(n, [c[0] - p[0], c[1] - p[1], c[2] - p[2]])) > FACE_PLANE_MM) flat = false;
      cx += c[0] / 3;
      cy += c[1] / 3;
      cz += c[2] / 3;
    }
    if (!flat) continue;
    onPlane[f] = 1;
    const distance = facetHolds(w, f, p) ? -1 : Math.hypot(cx - p[0], cy - p[1], cz - p[2]);
    if (distance < seedDistance) {
      seedDistance = distance;
      seed = f;
    }
  }
  if (seed < 0) return [];
  const taken = new Uint8Array(w.facetCount);
  const out: number[] = [];
  const stack = [seed];
  taken[seed] = 1;
  while (stack.length > 0) {
    const f = stack.pop() as number;
    out.push(f);
    for (let e = 0; e < 3; e++) {
      const edge = w.facetEdges[f * 3 + e];
      if (edge < 0) continue;
      for (const g of w.edges[edge].facets) {
        if (onPlane[g] === 1 && taken[g] === 0) {
          taken[g] = 1;
          stack.push(g);
        }
      }
    }
  }
  return out.sort((a, b) => a - b);
}

/** A plane a facet's corners are to lie on after the move: `normal . x = offset`. */
interface TargetPlane {
  normal: Vec3;
  offset: number;
}

/**
 * Move every corner of `w` touched by `planeOf` onto the planes of its facets.
 * `planeOf(f)` is facet `f`'s plane after the move, or null for a facet that
 * stays where it is. Corners no moved facet touches stay exactly where they
 * are. Returns welded positions.
 *
 * A corner only ever moves ALONG the planes of the facets round it that stay:
 * its move is solved in the directions those planes leave free, so a face
 * that does not move stays exactly flat (MEASURED 2026-09-27: a corner let
 * drift 3e-12 mm off the plate's underside was enough for the hole
 * recogniser to stop seeing five of its six holes).
 */
function reseatCorners(
  w: WeldedMesh,
  planeOf: (f: number) => TargetPlane | null,
  vanished?: { facets: Uint8Array; acrossMm: number },
): Float64Array {
  const seat = cornerSeater(w, planeOf);
  const out = Float64Array.from(w.positions);
  for (let v = 0; v < w.vertexCount; v++) {
    const p = seat(v, vanished);
    if (p === null) continue;
    out[v * 3] = p[0];
    out[v * 3 + 1] = p[1];
    out[v * 3 + 2] = p[2];
  }
  return out;
}

/** Where one corner of `w` goes (see `reseatCorners`), or null when no facet
 *  round it moves. */
function cornerSeater(
  w: WeldedMesh,
  planeOf: (f: number) => TargetPlane | null,
): (v: number, vanished?: { facets: Uint8Array; acrossMm: number }) => Vec3 | null {
  const around: number[][] = Array.from({ length: w.vertexCount }, () => []);
  for (let f = 0; f < w.facetCount; f++) {
    for (let k = 0; k < 3; k++) around[w.facets[f * 3 + k]].push(f);
  }
  return (v, vanished) => {
    const x0 = corner(w, v);
    const facets = around[v].filter((f) => w.areas[f] > 0 && vanished?.facets[f] !== 1);
    const planes = facets.map((f) => planeOf(f));
    // WO-2118: a vanished facet gives up its plane; its corners go where the
    // faces round its corners ACROSS it meet - the corners within `acrossMm`,
    // not those along it (a corner chamfer's far end is at the other face of
    // the part). Those borrowed planes only move the corner along its own.
    const borrowed = new Set<number>();
    if (vanished !== undefined && facets.length < around[v].length) {
      for (const f of around[v]) {
        if (vanished.facets[f] !== 1) continue;
        for (let k = 0; k < 3; k++) {
          const u = w.facets[f * 3 + k];
          const p = corner(w, u);
          if (u === v || Math.hypot(p[0] - x0[0], p[1] - x0[1], p[2] - x0[2]) > vanished.acrossMm) continue;
          for (const g of around[u]) {
            if (w.areas[g] > 0 && vanished.facets[g] !== 1 && !facets.includes(g)) borrowed.add(g);
          }
        }
      }
    }
    if (planes.every((plane) => plane === null) && borrowed.size === 0) return null;
    const rowsOf = (list: readonly number[], at: Vec3): Array<{ n: Vec3; r: number }> => {
      const rows: Array<{ n: Vec3; r: number }> = [];
      for (const f of list) {
        const plane = planeOf(f);
        if (plane === null) continue;
        const n = unit(plane.normal);
        const r = plane.offset - dot(n, at);
        if (rows.some((row) => dot(row.n, n) > 1 - 1e-9 && Math.abs(row.r - r) < 1e-9)) continue;
        rows.push({ n, r });
      }
      return rows;
    };
    const held = facets.filter((_, i) => planes[i] === null).map((f) => normalOf(w, f));
    const own = rowsOf(facets, x0);
    const move = leastMove(freeDirections(held), own);
    if (borrowed.size > 0) {
      const x1: Vec3 = [x0[0] + move[0], x0[1] + move[1], x0[2] + move[2]];
      const along = leastMove(freeDirections([...held, ...own.map((row) => row.n)]), rowsOf([...borrowed], x1));
      for (let a = 0; a < 3; a++) move[a] += along[a];
    }
    return [x0[0] + move[0], x0[1] + move[1], x0[2] + move[2]];
  };
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Unit directions a corner may move in without leaving any plane whose
 *  normal is in `held` (none, when three independent planes hold it). An
 *  axis-aligned plane yields axis-aligned directions, exactly. */
function freeDirections(held: readonly Vec3[]): Vec3[] {
  const basis: Vec3[] = [];
  for (const n of held) {
    let r: Vec3 = [n[0], n[1], n[2]];
    for (const b of basis) {
      const t = dot(r, b);
      r = [r[0] - t * b[0], r[1] - t * b[1], r[2] - t * b[2]];
    }
    if (Math.hypot(r[0], r[1], r[2]) > 1e-6) basis.push(unit(r));
    if (basis.length === 3) return [];
  }
  if (basis.length === 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (basis.length === 2) return [unit(cross(basis[0], basis[1]))];
  const h = basis[0];
  const a = h.map(Math.abs);
  const seed: Vec3 = a[0] <= a[1] && a[0] <= a[2] ? [1, 0, 0] : a[1] <= a[2] ? [0, 1, 0] : [0, 0, 1];
  const u = unit(cross(h, seed));
  return [u, cross(h, u)];
}

/** The smallest move d, along `free` only, with n . d = r for every row (least
 *  squares where they disagree): (sum a a^T + eps I) c = sum a r in the free
 *  directions, a = the row's normal in them. The tiny eps only picks the
 *  shortest move where the rows leave some direction open. */
function leastMove(free: readonly Vec3[], rows: ReadonlyArray<{ n: Vec3; r: number }>): Vec3 {
  const k = free.length;
  if (k === 0) return [0, 0, 0];
  const g = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const { n, r } of rows) {
    const a = free.map((d) => dot(n, d));
    for (let i = 0; i < k; i++) {
      g[i][k] += a[i] * r;
      for (let j = 0; j < k; j++) g[i][j] += a[i] * a[j];
    }
  }
  for (let i = 0; i < k; i++) g[i][i] += 1e-10;
  // Gaussian elimination with partial pivoting on the k x k system.
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let row = col + 1; row < k; row++) if (Math.abs(g[row][col]) > Math.abs(g[pivot][col])) pivot = row;
    [g[col], g[pivot]] = [g[pivot], g[col]];
    for (let row = col + 1; row < k; row++) {
      const factor = g[row][col] / g[col][col];
      for (let j = col; j <= k; j++) g[row][j] -= factor * g[col][j];
    }
  }
  const c = new Array<number>(k).fill(0);
  for (let row = k - 1; row >= 0; row--) {
    let sum = g[row][k];
    for (let j = row + 1; j < k; j++) sum -= g[row][j] * c[j];
    c[row] = sum / g[row][row];
  }
  const move: Vec3 = [0, 0, 0];
  free.forEach((d, i) => {
    for (let a = 0; a < 3; a++) move[a] += c[i] * d[a];
  });
  return move;
}

/**
 * The inside of a shell of `thicknessMm` on `mesh`: a closed, outward-wound
 * copy of the part with every face moved `thicknessMm` into the material and
 * the facets in `openFacets` moved `SHELL_OPEN_CLEARANCE_MM` out of it.
 * Cutting it out of the part is the shell. Pure.
 */
export function shellInside(
  mesh: MeshBuffers,
  openFacets: readonly number[],
  thicknessMm: number,
  options: { dropVanishedFaces?: boolean } = {},
): MeshBuffers {
  const w = weldMesh(mesh);
  const open = new Set(openFacets);
  const planeOf = (f: number): TargetPlane => {
    const n = normalOf(w, f);
    const on = dot(n, corner(w, w.facets[f * 3]));
    return { normal: n, offset: on + (open.has(f) ? SHELL_OPEN_CLEARANCE_MM : -thicknessMm) };
  };
  let positions = reseatCorners(w, planeOf);
  // WO-2118 (the construction route only): a face narrower than the wall
  // allows - a 0.5 mm chamfer round the bottom at a 2.5 mm wall - vanishes
  // from the inside, as it does from a true offset. Moving its corners onto
  // its own moved plane crosses them over instead and folds the inside through
  // itself; so a facet the move turns inside out (or flattens) gives up its
  // plane, and the move is solved again without it, until none does.
  if (options.dropVanishedFaces === true) {
    const vanished = new Uint8Array(w.facetCount);
    const how = { facets: vanished, acrossMm: 2 * thicknessMm };
    const seat = cornerSeater(w, planeOf);
    const touchesVanished = new Uint8Array(w.vertexCount);
    for (let round = 0; round < VANISH_ROUNDS; round++) {
      let turned = 0;
      for (let f = 0; f < w.facetCount; f++) {
        if (w.areas[f] === 0 || vanished[f] === 1) continue;
        const [a, b, c] = [0, 1, 2].map((k) => w.facets[f * 3 + k] * 3);
        const u: Vec3 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
        const v: Vec3 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
        if (dot(cross(u, v), normalOf(w, f)) <= VANISHED_AREA_MM2) {
          vanished[f] = 1;
          turned++;
        }
      }
      // A small facet ringed by vanished ones - the little corner where three
      // chamfers meet - need not turn over to be gone: it is, when its
      // corners solved without it already lie inside its moved plane.
      touchesVanished.fill(0);
      for (let f = 0; f < w.facetCount; f++) {
        if (vanished[f] === 1) for (let k = 0; k < 3; k++) touchesVanished[w.facets[f * 3 + k]] = 1;
      }
      for (let f = 0; f < w.facetCount; f++) {
        if (w.areas[f] === 0 || vanished[f] === 1) continue;
        const corners = [0, 1, 2].map((k) => w.facets[f * 3 + k]);
        if (corners.some((c) => touchesVanished[c] === 0)) continue;
        const span = Math.max(...corners.map((c, k) => {
          const p = corner(w, c);
          const q = corner(w, corners[(k + 1) % 3]);
          return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        }));
        if (span > how.acrossMm) continue;
        const plane = planeOf(f);
        vanished[f] = 1;
        const inside = corners.every((c) => {
          const p = seat(c, how);
          return p !== null && dot(plane.normal, p) <= plane.offset + VANISHED_INSIDE_MM;
        });
        if (inside) turned++;
        else vanished[f] = 0;
      }
      if (turned === 0) break;
      positions = reseatCorners(w, planeOf, how);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(w.facets) };
}

/** How many times the inside is re-solved for faces that vanish ... */
const VANISH_ROUNDS = 8;
/** ... a facet the move leaves with no more (twice) area than this, turned or
 *  not, mm2: collapsed onto a line, its plane holds its corners nowhere. */
const VANISHED_AREA_MM2 = 1e-9;
/** ... or one whose corners, solved without it, lie this close to inside it, mm. */
const VANISHED_INSIDE_MM = 1e-9;

export interface DraftSpec {
  angleDeg: number;
  /** the pull direction (the kernel's `pullDir`) */
  pullDirection: [number, number, number];
  /** a point on the neutral plane (square to the pull direction) */
  neutralPoint: [number, number, number];
}

/**
 * Draft `faces` of `mesh` (each the facets `facetsOnFaces` found for it, with
 * its recorded face) by `spec`. The mesh keeps every facet and corner, in
 * order - only corners move - so the edit's ancestry is one-to-one. Throws a
 * sentence when a face cannot take a draft (it lies square to the pull
 * direction) or when the draft would fold a facet over. Pure.
 */
export function draftFacesMesh(
  mesh: MeshBuffers,
  faces: ReadonlyArray<{ face: MeshFaceRef; facets: readonly number[] }>,
  spec: DraftSpec,
): MeshBuffers {
  const w = weldMesh(mesh);
  const pull = unit(spec.pullDirection as Vec3);
  const o = spec.neutralPoint as Vec3;
  const angle = (spec.angleDeg * Math.PI) / 180;
  const planeOfFacet = new Map<number, TargetPlane>();
  for (const { face, facets } of faces) {
    const n = unit(face.normal as Vec3);
    const c = face.point as Vec3;
    const np = dot(n, pull);
    const across = 1 - np * np;
    if (across < 1e-6) {
      throw new Error('A face square to the pull direction has no side to draft, so nothing was changed. Pick the faces that run along it.');
    }
    // Where the face meets the neutral plane: q on both planes.
    const beta = dot(pull, [o[0] - c[0], o[1] - c[1], o[2] - c[2]]) / across;
    const alpha = -beta * np;
    const q: Vec3 = [0, 1, 2].map((k) => c[k] + alpha * n[k] + beta * pull[k]) as Vec3;
    const side = unit([n[0] - np * pull[0], n[1] - np * pull[1], n[2] - np * pull[2]]);
    const turned: Vec3 = [0, 1, 2].map((k) => Math.cos(angle) * side[k] + Math.sin(angle) * pull[k]) as Vec3;
    const plane = { normal: turned, offset: dot(turned, q) };
    for (const f of facets) planeOfFacet.set(f, plane);
  }
  const moved = reseatCorners(w, (f) => planeOfFacet.get(f) ?? null);

  // Fold check: a facet whose normal turns round has been flipped inside out.
  for (let f = 0; f < w.facetCount; f++) {
    if (w.areas[f] === 0) continue;
    const [a, b, c] = [0, 1, 2].map((k) => w.facets[f * 3 + k] * 3);
    const u = [moved[b] - moved[a], moved[b + 1] - moved[a + 1], moved[b + 2] - moved[a + 2]];
    const v = [moved[c] - moved[a], moved[c + 1] - moved[a + 1], moved[c + 2] - moved[a + 2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (dot(n, normalOf(w, f)) <= 0) {
      throw new Error(`At ${spec.angleDeg} degrees the drafted face would fold over the faces beside it, so nothing was changed.`);
    }
  }

  // Back onto the mesh as it was handed in: each of its corners takes its
  // welded corner's new place.
  const positions = Float32Array.from(mesh.positions);
  for (let i = 0; i < mesh.indices.length; i++) {
    const vertex = mesh.indices[i];
    const welded = w.facets[i];
    positions[vertex * 3] = moved[welded * 3];
    positions[vertex * 3 + 1] = moved[welded * 3 + 1];
    positions[vertex * 3 + 2] = moved[welded * 3 + 2];
  }
  return { positions, indices: Uint32Array.from(mesh.indices) };
}

/** One-to-one ancestry: every facet and corner is itself. */
export function sameElementsAncestry(mesh: MeshBuffers): { triangles: number[][]; vertices: number[][] } {
  return {
    triangles: Array.from({ length: facetCount(mesh) }, (_, f) => [f]),
    vertices: Array.from({ length: vertexCount(mesh) }, (_, v) => [v]),
  };
}
