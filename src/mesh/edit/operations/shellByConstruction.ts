// WO-2118: Shell on an STL by construction - the mesh twin of WO-2107's route
// on a STEP body (GeomEngine #applyShellByConstruction), used only after the
// direct shell (every face moved into the material, ./shellAndDraft.ts
// `shellInside`) would split the part.
//
// Why the direct shell splits where the STEP route does not: moving every
// corner onto its moved planes cannot change the part's shape of joins. A
// blind hole whose grown floor passes the part's raised bottom should break
// through it and join its wall to the floor; moved corners instead fold the
// inside over itself there, and the cut comes back in pieces.
//
// Hollow the simplified block before adding openings, as the STEP route does:
//  1. depressions = the blind holes and pockets opened through the face
//     (facets reached from its inner loops without reaching its outer loop -
//     a through hole reaches the far side and the outer walls);
//  2. the plain block = the part with each depression's mouth capped flat,
//     and its inside the direct shell of that block;
//  3. keep a wall round each depression: its floor outline grown by the wall,
//     extruded from the wall below the floor to past the opening, cut out of
//     that inside;
//  4. cut what is left of the inside from the ORIGINAL part, so every chamfer
//     and every depression is the part's own.
// When the walls still cannot join up, the caller names the piece count and
// `shellOnePieceThickness`, as the STEP route does.
//
// Pure given the kernel: the same part, face and wall give the same mesh, so
// a journal replays it the same.

import { booleanMeshWithAncestry } from '../../manifoldOps';
import type { ManifoldWasmModule } from '../../manifoldKernel';
import type { MeshBuffers, Vec3 } from '../../types';
import { weldMesh, type WeldedMesh } from '../../recognition/topology';
import { facetsOnFaces, shellInside, SHELL_OPEN_CLEARANCE_MM, type MeshFaceRef } from './shellAndDraft';

type Vec2 = [number, number];

/** A depression floor faces the opening within this (cos), as the STEP route's. */
const FLOOR_NORMAL_COS = 0.999;
/** Corners within this of one plane are one floor, mm. */
const FLOOR_PLANE_MM = 1e-3;

/** What the construction needs from the part, found once per shell. */
export interface ShellConstructionPlan {
  /** the part with every depression's mouth capped flat */
  block: MeshBuffers;
  /** the block's facets on the opened face (its caps included) */
  blockOpen: number[];
  /** each floor's outer outline in the opened face's frame, and its depth
   *  below the opened face, mm */
  floors: Array<{ outline: Vec2[]; depth: number }>;
  /** the opened face's frame: `origin + x u + y v + z n`, n its outward normal */
  frame: { origin: Vec3; u: Vec3; v: Vec3; n: Vec3 };
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}
const corner = (w: WeldedMesh, v: number): Vec3 => [w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2]];

/** Shoelace area of a closed outline; positive counter-clockwise. */
function signedArea(outline: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % outline.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The closed boundary loops of a set of facets, each a list of welded corners
 * in the facets' own winding (so an outer loop runs counter-clockwise about
 * their normal). Null when a corner is pinched (two loops through it).
 */
function boundaryLoops(w: WeldedMesh, set: ReadonlySet<number>): number[][] | null {
  const next = new Map<number, number>();
  for (const f of set) {
    for (let e = 0; e < 3; e++) {
      const edge = w.facetEdges[f * 3 + e];
      const inside = edge >= 0 && w.edges[edge].facets.some((g) => g !== f && set.has(g));
      if (inside) continue;
      const a = w.facets[f * 3 + e];
      const b = w.facets[f * 3 + ((e + 1) % 3)];
      if (next.has(a)) return null;
      next.set(a, b);
    }
  }
  const loops: number[][] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: number[] = [];
    let at: number | undefined = start;
    while (at !== undefined && !done.has(at)) {
      done.add(at);
      loop.push(at);
      at = next.get(at);
    }
    if (at !== start) return null;
    loops.push(loop);
  }
  return loops;
}

/**
 * What the construction needs from `mesh` to open `face`, or null when the
 * route does not apply: the face is not found, or it opens no blind hole or
 * pocket with a flat floor (a drilled point has none - the STEP route does not
 * take those either). Pure.
 */
export function shellConstructionPlan(module: ManifoldWasmModule, mesh: MeshBuffers, face: MeshFaceRef): ShellConstructionPlan | null {
  const w = weldMesh(mesh);
  const open = facetsOnFaces(mesh, [face])[0];
  if (open.length === 0) return null;
  const openSet = new Set(open);
  const n = unit(face.normal as Vec3);
  const origin = face.point as Vec3;
  const a = n.map(Math.abs);
  const seed: Vec3 = a[0] <= a[1] && a[0] <= a[2] ? [1, 0, 0] : a[1] <= a[2] ? [0, 1, 0] : [0, 0, 1];
  const u = unit(cross(n, seed));
  const v = cross(n, u);
  const frame = { origin, u, v, n };
  const flat = (p: Vec3): Vec2 => {
    const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    return [dot(d, u), dot(d, v)];
  };
  const depthBelow = (p: Vec3): number => dot(n, [origin[0] - p[0], origin[1] - p[1], origin[2] - p[2]]);

  const loops = boundaryLoops(w, openSet);
  if (loops === null || loops.length < 2) return null;
  const areas = loops.map((loop) => signedArea(loop.map((c) => flat(corner(w, c)))));
  const outer = areas.reduce((best, area, i) => (Math.abs(area) > Math.abs(areas[best]) ? i : best), 0);

  // The facets across each boundary edge of the opened face, by its corners.
  const acrossEdge = new Map<string, number[]>();
  for (const f of open) {
    for (let e = 0; e < 3; e++) {
      const edge = w.facetEdges[f * 3 + e];
      if (edge < 0) continue;
      const others = w.edges[edge].facets.filter((g) => !openSet.has(g));
      if (others.length > 0) acrossEdge.set(`${w.edges[edge].a}:${w.edges[edge].b}`, others);
    }
  }
  const across = (loop: readonly number[]): number[] => loop.flatMap((c, i) => {
    const d = loop[(i + 1) % loop.length];
    return acrossEdge.get(`${Math.min(c, d)}:${Math.max(c, d)}`) ?? [];
  });
  const rim = new Set(across(loops[outer]));

  // Flood each inner loop's facets without crossing the opened face.
  const component = new Int32Array(w.facetCount).fill(-1);
  const depressions: Array<{ facets: number[]; mouths: number[] }> = [];
  const reachesRim: boolean[] = [];
  loops.forEach((loop, index) => {
    if (index === outer) return;
    const seeds = across(loop);
    const known = seeds.find((f) => component[f] >= 0);
    if (known !== undefined) {
      depressions[component[known]].mouths.push(index);
      return;
    }
    const id = depressions.length;
    const facets: number[] = [];
    let reached = false;
    const stack = [...seeds];
    for (const f of seeds) component[f] = id;
    while (stack.length > 0) {
      const f = stack.pop() as number;
      facets.push(f);
      if (rim.has(f)) reached = true;
      for (let e = 0; e < 3; e++) {
        const edge = w.facetEdges[f * 3 + e];
        if (edge < 0) continue;
        for (const g of w.edges[edge].facets) {
          if (openSet.has(g) || component[g] >= 0) continue;
          component[g] = id;
          stack.push(g);
        }
      }
    }
    depressions.push({ facets, mouths: [index] });
    reachesRim.push(reached);
  });
  const blind = depressions.filter((_, i) => !reachesRim[i]);
  if (blind.length === 0) return null;

  // Each depression's floors: flat facets facing the opening, below it, joined
  // edge-to-edge on one plane.
  const floors: ShellConstructionPlan['floors'] = [];
  for (const depression of blind) {
    const candidate = new Set(depression.facets.filter((f) => {
      if (w.areas[f] === 0) return false;
      const fn: Vec3 = [w.normals[f * 3], w.normals[f * 3 + 1], w.normals[f * 3 + 2]];
      return dot(fn, n) >= FLOOR_NORMAL_COS && depthBelow(corner(w, w.facets[f * 3])) > 1e-6;
    }));
    const taken = new Set<number>();
    let found = 0;
    for (const start of candidate) {
      if (taken.has(start)) continue;
      const depth = depthBelow(corner(w, w.facets[start * 3]));
      const floor = new Set<number>([start]);
      taken.add(start);
      const stack = [start];
      while (stack.length > 0) {
        const f = stack.pop() as number;
        for (let e = 0; e < 3; e++) {
          const edge = w.facetEdges[f * 3 + e];
          if (edge < 0) continue;
          for (const g of w.edges[edge].facets) {
            if (taken.has(g) || !candidate.has(g)) continue;
            if (Math.abs(depthBelow(corner(w, w.facets[g * 3])) - depth) > FLOOR_PLANE_MM) continue;
            taken.add(g);
            floor.add(g);
            stack.push(g);
          }
        }
      }
      const floorLoops = boundaryLoops(w, floor);
      if (floorLoops === null || floorLoops.length === 0) return null;
      const outlines = floorLoops.map((loop) => loop.map((c) => flat(corner(w, c))));
      const outline = outlines.reduce((best, o) => (Math.abs(signedArea(o)) > Math.abs(signedArea(best)) ? o : best));
      floors.push({ outline: signedArea(outline) < 0 ? outline.reverse() : outline, depth });
      found++;
    }
    if (found === 0) return null;
  }

  // The plain block: every facet but the depressions', each mouth capped on
  // the opened face's plane, wound to face out of it.
  const dropped = new Set(blind.flatMap((d) => d.facets));
  const indices: number[] = [];
  const blockOpen: number[] = [];
  for (let f = 0; f < w.facetCount; f++) {
    if (dropped.has(f)) continue;
    if (openSet.has(f)) blockOpen.push(indices.length / 3);
    indices.push(w.facets[f * 3], w.facets[f * 3 + 1], w.facets[f * 3 + 2]);
  }
  const triangulate = (module as unknown as { triangulate?: (polygons: Vec2[][]) => Array<[number, number, number]> }).triangulate;
  if (typeof triangulate !== 'function') return null;
  for (const depression of blind) {
    for (const mouth of depression.mouths) {
      // The opened face runs round a hole clockwise; the cap runs the other way.
      const loop = [...loops[mouth]].reverse();
      const outline = loop.map((c) => flat(corner(w, c)));
      if (signedArea(outline) <= 0) return null;
      for (const [i, j, k] of triangulate([outline])) {
        const ccw = (outline[j][0] - outline[i][0]) * (outline[k][1] - outline[i][1]) -
          (outline[k][0] - outline[i][0]) * (outline[j][1] - outline[i][1]);
        blockOpen.push(indices.length / 3);
        if (ccw >= 0) indices.push(loop[i], loop[j], loop[k]);
        else indices.push(loop[i], loop[k], loop[j]);
      }
    }
  }
  const block: MeshBuffers = { positions: Float32Array.from(w.positions), indices: Uint32Array.from(indices) };
  return { block, blockOpen, floors, frame };
}

interface CrossSectionHandle {
  offset(delta: number, joinType?: string, miterLimit?: number): CrossSectionHandle;
  extrude(height: number): SolidHandle;
  delete(): void;
}
interface SolidHandle {
  translate(offset: [number, number, number]): SolidHandle;
  add(other: SolidHandle): SolidHandle;
  getMesh(): { numProp: number; numVert: number; vertProperties: Float32Array; triVerts: Uint32Array };
  delete(): void;
}

/** How far past `t` below its floor a depression's wall reaches, mm. A wall
 *  whose foot lies exactly on the cavity's floor (a 10 mm deep hole at a 2 mm
 *  wall in a 14 mm part) touches it with no thickness, and the mesh kernel
 *  counts those as two pieces where the STEP kernel - and the metal - count
 *  one. A micron more makes them one; below the floor it cuts nothing. */
const WALL_TOUCH_MM = 1e-3;

/** The walls to keep round the depressions at wall `t`: each floor's outline
 *  grown by `t`, from `t` below the floor to past the opening, in part
 *  coordinates. Null when the kernel cannot grow an outline. */
function depressionWalls(module: ManifoldWasmModule, plan: ShellConstructionPlan, t: number): MeshBuffers | null {
  const CrossSection = (module as unknown as { CrossSection?: new (p: Vec2[][], fill?: string) => CrossSectionHandle }).CrossSection;
  if (typeof CrossSection !== 'function') return null;
  const handles: Array<CrossSectionHandle | SolidHandle> = [];
  const own = <T extends CrossSectionHandle | SolidHandle>(h: T): T => { handles.push(h); return h; };
  try {
    let all: SolidHandle | null = null;
    const top = SHELL_OPEN_CLEARANCE_MM + t;
    for (const floor of plan.floors) {
      const grown = own(own(new CrossSection([floor.outline], 'NonZero')).offset(t, 'Miter', 2));
      const bottom = -(floor.depth + t + WALL_TOUCH_MM);
      const prism = own(own(grown.extrude(top - bottom)).translate([0, 0, bottom]));
      all = all === null ? prism : own(all.add(prism));
    }
    if (all === null) return null;
    const raw = all.getMesh();
    const { origin, u, v, n } = plan.frame;
    const positions = new Float32Array(raw.numVert * 3);
    for (let i = 0; i < raw.numVert; i++) {
      const x = raw.vertProperties[i * raw.numProp];
      const y = raw.vertProperties[i * raw.numProp + 1];
      const z = raw.vertProperties[i * raw.numProp + 2];
      for (let k = 0; k < 3; k++) positions[i * 3 + k] = origin[k] + x * u[k] + y * v[k] + z * n[k];
    }
    return positions.length === 0 ? null : { positions, indices: Uint32Array.from(raw.triVerts) };
  } finally {
    for (const h of handles) {
      try { h.delete(); } catch { /* already released */ }
    }
  }
}

/** A shell built by construction: the mesh, per facet the facet of the part it
 *  came from (`BOOLEAN_TRIANGLE_ADDED` for a new wall), and how many pieces. */
export interface ShellConstruction {
  mesh: MeshBuffers;
  leftTriangle: Int32Array;
  pieces: number;
}

/** A piece this much smaller than the largest is a fold, not a wall: where a
 *  face narrower than the wall (a 0.5 mm chamfer at a 3 mm wall) vanishes from
 *  the block's inside, its corners cross over and the cut leaves zero-thick
 *  slivers along the cavity's corner (MEASURED 2026-09-28, Step Test With
 *  Holes at 3 mm: three, 0.52 mm3 together against 49391 mm3). A real wall
 *  round a 5 mm hole is hundreds of mm3. */
const SLIVER_FRACTION = 1e-4;

/** `mesh`'s pieces as the kernel returned them (a piece shares no corner with
 *  another), each with its facets and signed volume. */
function pieces(mesh: MeshBuffers): Array<{ facets: number[]; volume: number }> {
  const parent = Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const facets = mesh.indices.length / 3;
  for (let f = 0; f < facets; f++) {
    const a = find(mesh.indices[f * 3]);
    parent[find(mesh.indices[f * 3 + 1])] = a;
    parent[find(mesh.indices[f * 3 + 2])] = a;
  }
  const byRoot = new Map<number, { facets: number[]; volume: number }>();
  for (let f = 0; f < facets; f++) {
    const root = find(mesh.indices[f * 3]);
    let piece = byRoot.get(root);
    if (piece === undefined) {
      piece = { facets: [], volume: 0 };
      byRoot.set(root, piece);
    }
    piece.facets.push(f);
    const p = [0, 1, 2].map((k): Vec3 => {
      const v = mesh.indices[f * 3 + k] * 3;
      return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
    });
    piece.volume += dot(p[0], cross(p[1], p[2])) / 6;
  }
  return [...byRoot.values()];
}

/** An edge this short is a fold, mm (MEASURED 2026-09-28 on Step Test With
 *  Holes: 3.8e-6 at every wall from 2 to 3.5 mm, and ~1e-5 on a facet of the
 *  pocket's island turned over at 2 mm). */
const SHORT_EDGE_MM = 1e-4;

/**
 * `facets` of `mesh`, corners at one place made one, and every facet that
 * leaves with two corners the same dropped. The kernel works in doubles: where
 * a grown wall's corner lies on an edge of the part (a hole's wall grown
 * square to the part's own axis lines), it can make two corners 1e-8 mm apart
 * that are one float - a zero-area facet folded back on its neighbour
 * (MEASURED 2026-09-28: eight such edges on Step Test With Holes at 2 mm).
 * Dropping it is the edge collapse: the closed surface stays closed. Returns
 * the mesh and, per facet of it, the facet of `mesh` it was.
 */
function weldedWithout(mesh: MeshBuffers, facets: readonly number[]): { mesh: MeshBuffers; kept: number[] } {
  const w = weldMesh({ positions: mesh.positions, indices: mesh.indices });
  // An edge shorter than a float's reach at this size is the same fold one
  // step on (a zero-area facet, or one barely turned over): collapse it too.
  const into = Int32Array.from({ length: w.vertexCount }, (_, i) => i);
  const root = (v: number): number => {
    while (into[v] !== v) v = into[v];
    return v;
  };
  for (const f of facets) {
    for (let k = 0; k < 3; k++) {
      const a = root(w.facets[f * 3 + k]);
      const b = root(w.facets[f * 3 + ((k + 1) % 3)]);
      if (a === b) continue;
      const d = Math.hypot(...[0, 1, 2].map((x) => w.positions[a * 3 + x] - w.positions[b * 3 + x]));
      if (d < SHORT_EDGE_MM) into[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const indices: number[] = [];
  const kept: number[] = [];
  const used = new Int32Array(w.vertexCount).fill(-1);
  const positions: number[] = [];
  for (const f of facets) {
    const [a, b, c] = [0, 1, 2].map((k) => root(w.facets[f * 3 + k]));
    if (a === b || b === c || c === a) continue;
    for (const v of [a, b, c]) {
      if (used[v] < 0) {
        used[v] = positions.length / 3;
        positions.push(w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2]);
      }
      indices.push(used[v]);
    }
    kept.push(f);
  }
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, kept };
}

/**
 * The shell of `mesh` at wall `t` by construction: the part minus (the plain
 * block's inside less a wall round each depression), with the ancestry back to
 * `mesh`'s facets, fold slivers dropped. Null when the kernel cannot build it.
 */
export function shellByConstruction(
  module: ManifoldWasmModule,
  mesh: MeshBuffers,
  plan: ShellConstructionPlan,
  t: number,
): ShellConstruction | null {
  try {
    const walls = depressionWalls(module, plan, t);
    if (walls === null) return null;
    const inside = shellInside(plan.block, plan.blockOpen, t, { dropVanishedFaces: true });
    const cavity = booleanMeshWithAncestry(module, inside, walls, {
      operation: 'difference',
      leftName: "the shell's inside",
      rightName: 'the walls round its holes',
    }).result.mesh;
    if (cavity.indices.length === 0) return null;
    const cut = booleanMeshWithAncestry(module, mesh, cavity, { operation: 'difference', leftName: 'the part', rightName: 'the shell' });
    const found = pieces(cut.result.mesh);
    if (found.length === 0) return null;
    const largest = Math.max(...found.map((p) => p.volume));
    const kept = found.filter((p) => p.volume >= largest * SLIVER_FRACTION);
    const welded = weldedWithout(cut.result.mesh, kept.flatMap((p) => p.facets).sort((a, b) => a - b));
    return {
      mesh: welded.mesh,
      leftTriangle: Int32Array.from(welded.kept, (f) => cut.leftTriangle[f]),
      pieces: kept.length,
    };
  } catch {
    return null;
  }
}

/** The thinnest wall, on a 0.1 mm grid above `t`, at which the construction
 *  is one piece; null when none it can build is - the STEP route's search
 *  (half-millimetre steps up, then halving on the tenth). */
export function shellOnePieceThickness(
  module: ManifoldWasmModule,
  mesh: MeshBuffers,
  plan: ShellConstructionPlan,
  t: number,
): number | null {
  const piecesAt = (wall: number): number | null => shellByConstruction(module, mesh, plan, wall)?.pieces ?? null;
  let lo = t;
  let hi: number | null = null;
  for (let wall = Math.floor(t / 0.5 + 1e-9) * 0.5 + 0.5, tries = 0; tries < 24; wall += 0.5, tries++) {
    const pieces = piecesAt(wall);
    if (pieces === null) break;
    if (pieces === 1) { hi = wall; break; }
    lo = wall;
  }
  if (hi === null) return null;
  let low = Math.floor(lo * 10 + 1e-9);
  let high = Math.round(hi * 10);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (piecesAt(mid / 10) === 1) high = mid;
    else low = mid;
  }
  return high / 10;
}
