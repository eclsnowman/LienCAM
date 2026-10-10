// cam3d fixtures: procedural PartMesh generators.
//
// These are the engine's analytic ground truth (MISSION.md section 5
// Testing): generators are committed, never binaries, and each shape has
// closed-form math a test can assert against. Everything is deterministic --
// no randomness, fixed loop order -- so meshes are byte-identical run to run.
//
// Conventions: units mm, Z-up, Z=0 at table surface. Triangles wound CCW
// viewed from outside (signed volume of a closed solid is positive). Solids
// are watertight where geometrically sensible (wave is an open heightfield
// sheet by design).

import type { PartMesh } from '../kernel/types';
import { MeshBuilder, computeBounds } from './meshBuilder';
import { ShapeUtils, Vector2 } from 'three';

// ---------------------------------------------------------------------------
// wave -- the Phase 0 benchmark surface (open heightfield sheet)
// ---------------------------------------------------------------------------

/**
 * z = 10 + 5 * sin(0.35 x) * cos(0.35 y) over [0, size]^2, sampled on an
 * n x n grid. EXACTLY this formula -- it matches the Phase 0 benchmark.
 * Default n = 317 yields 2 * 316^2 = 199712 triangles (~200k benchmark mesh).
 * Vertex (i, j) sits at index j * n + i (x fastest).
 */
export function wave(size = 100, n = 317): PartMesh {
  if (!(size > 0) || !Number.isInteger(n) || n < 2) {
    throw new Error(`wave: invalid params size=${size} n=${n}`);
  }
  const positions = new Float32Array(n * n * 3);
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    const y = (size * j) / (n - 1);
    for (let i = 0; i < n; i++) {
      const x = (size * i) / (n - 1);
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = 10 + 5 * Math.sin(0.35 * x) * Math.cos(0.35 * y);
      p += 3;
    }
  }
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = b + n;
      const d = a + n;
      // CCW viewed from +Z (the outside of an up-facing sheet).
      indices[q] = a;
      indices[q + 1] = b;
      indices[q + 2] = c;
      indices[q + 3] = a;
      indices[q + 4] = c;
      indices[q + 5] = d;
      q += 6;
    }
  }
  return { positions, indices, bounds: computeBounds(positions), source: 'fixture' };
}

// ---------------------------------------------------------------------------
// sphere -- icosphere (closed solid, analytic radius)
// ---------------------------------------------------------------------------

/**
 * Icosphere: icosahedron subdivided `subdiv` times, every vertex normalized
 * onto the sphere, so all vertices lie EXACTLY at radius r in f64 (only
 * Float32 storage quantization remains -- tests derive that bound).
 * Default subdiv = 3 -> 20 * 4^3 = 1280 triangles.
 */
export function sphere(r = 25, cx = 50, cy = 50, cz = 25, subdiv = 3): PartMesh {
  if (!(r > 0) || !Number.isInteger(subdiv) || subdiv < 0 || subdiv > 7) {
    throw new Error(`sphere: invalid params r=${r} subdiv=${subdiv}`);
  }
  const t = (1 + Math.sqrt(5)) / 2;
  // Unit-normalized icosahedron vertices (f64 throughout the refinement).
  const raw: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts: Array<[number, number, number]> = raw.map(normalize);
  // Standard icosahedron faces, CCW viewed from outside.
  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const midCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = midCache.get(key);
      if (hit !== undefined) return hit;
      const va = verts[a];
      const vb = verts[b];
      const m = normalize([va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]]);
      const idx = verts.length;
      verts.push(m);
      midCache.set(key, idx);
      return idx;
    };
    const next: Array<[number, number, number]> = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = cx + r * verts[i][0];
    positions[i * 3 + 1] = cy + r * verts[i][1];
    positions[i * 3 + 2] = cz + r * verts[i][2];
  }
  const indices = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    indices[i * 3] = faces[i][0];
    indices[i * 3 + 1] = faces[i][1];
    indices[i * 3 + 2] = faces[i][2];
  }
  return { positions, indices, bounds: computeBounds(positions), source: 'fixture' };
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

// ---------------------------------------------------------------------------
// hemisphereOnSlab -- dome on a slab top (closed solid)
// ---------------------------------------------------------------------------

/**
 * A rectangular slab [0,x] x [0,y] x [0,t] with a hemispherical dome of
 * radius r centered on its top face. Watertight: the dome rim ring is
 * shared with the inner edge of the slab-top annulus, the slab boundary
 * ring is shared between top, walls, and bottom fan.
 */
export function hemisphereOnSlab(
  r = 20,
  slab: { x: number; y: number; t: number } = { x: 100, y: 100, t: 10 },
): PartMesh {
  if (!(r > 0) || !(slab.x > 0) || !(slab.y > 0) || !(slab.t > 0)) {
    throw new Error(`hemisphereOnSlab: invalid params r=${r}`);
  }
  const cx = slab.x / 2;
  const cy = slab.y / 2;
  if (r >= Math.min(cx, cy)) {
    throw new Error(`hemisphereOnSlab: dome r=${r} must fit inside the slab top`);
  }
  const ns = 64; // segments around
  const nk = 16; // dome rings rim->pole
  const b = new MeshBuilder();

  // Slab boundary ring: cast a ray from the top-face center at each theta to
  // the rectangle border. Matched by index with the dome rim ring so the
  // top annulus stitches cleanly.
  const thetas: number[] = [];
  for (let k = 0; k < ns; k++) thetas.push((2 * Math.PI * k) / ns);
  const rectPt = (theta: number): [number, number] => {
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const tx = dx > 0 ? (slab.x - cx) / dx : dx < 0 ? -cx / dx : Infinity;
    const ty = dy > 0 ? (slab.y - cy) / dy : dy < 0 ? -cy / dy : Infinity;
    const s = Math.min(tx, ty);
    return [cx + s * dx, cy + s * dy];
  };
  const rectLo: number[] = [];
  const rectHi: number[] = [];
  for (const th of thetas) {
    const [px, py] = rectPt(th);
    rectLo.push(b.vertex(px, py, 0));
    rectHi.push(b.vertex(px, py, slab.t));
  }

  // Bottom: fan from the center, facing -Z.
  const bc = b.vertex(cx, cy, 0);
  for (let k = 0; k < ns; k++) {
    b.tri(bc, rectLo[(k + 1) % ns], rectLo[k]);
  }
  // Side walls, outward.
  for (let k = 0; k < ns; k++) {
    const k1 = (k + 1) % ns;
    b.quad(rectLo[k], rectLo[k1], rectHi[k1], rectHi[k]);
  }

  // Dome rings, rim (phi = 0, z = t) toward the pole.
  const rings: number[][] = [];
  for (let j = 0; j < nk; j++) {
    const phi = (Math.PI / 2) * (j / nk);
    const rad = r * Math.cos(phi);
    const z = slab.t + r * Math.sin(phi);
    const ring: number[] = [];
    for (const th of thetas) {
      ring.push(b.vertex(cx + rad * Math.cos(th), cy + rad * Math.sin(th), z));
    }
    rings.push(ring);
  }
  const rim = rings[0];

  // Top annulus between the slab boundary ring (outer) and the rim (inner), +Z.
  for (let k = 0; k < ns; k++) {
    const k1 = (k + 1) % ns;
    b.quad(rectHi[k], rectHi[k1], rim[k1], rim[k]);
  }
  // Dome bands, outward.
  for (let j = 0; j < nk - 1; j++) {
    const lo = rings[j];
    const hi = rings[j + 1];
    for (let k = 0; k < ns; k++) {
      const k1 = (k + 1) % ns;
      b.quad(lo[k], lo[k1], hi[k1], hi[k]);
    }
  }
  // Pole cap.
  const pole = b.vertex(cx, cy, slab.t + r);
  const last = rings[nk - 1];
  for (let k = 0; k < ns; k++) {
    b.tri(last[k], last[(k + 1) % ns], pole);
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// steps -- concentric rectangular steps (closed solid, exact volume)
// ---------------------------------------------------------------------------

/**
 * A ziggurat of `levels` concentric square steps centered on [0,size]^2.
 * Level i spans z in [i*stepHeight, (i+1)*stepHeight] with half-extent
 * (size/2) * (levels - i) / levels. Exact analytic volume:
 * sum_i (2*h_i)^2 * stepHeight.
 */
export function steps(levels = 3, size = 90, stepHeight = 10): PartMesh {
  if (!Number.isInteger(levels) || levels < 1 || !(size > 0) || !(stepHeight > 0)) {
    throw new Error(`steps: invalid params levels=${levels}`);
  }
  const cx = size / 2;
  const cy = size / 2;
  const b = new MeshBuilder();
  // Corner rings, CCW viewed from +Z, per level footprint.
  const corners = (h: number, z: number): [number, number, number, number] => [
    b.vertex(cx - h, cy - h, z),
    b.vertex(cx + h, cy - h, z),
    b.vertex(cx + h, cy + h, z),
    b.vertex(cx - h, cy + h, z),
  ];
  const half = (i: number): number => ((size / 2) * (levels - i)) / levels;

  // Bottom face, -Z.
  const base = corners(half(0), 0);
  b.quad(base[0], base[3], base[2], base[1]);

  for (let i = 0; i < levels; i++) {
    const h = half(i);
    const zLo = i * stepHeight;
    const zHi = (i + 1) * stepHeight;
    const lo = corners(h, zLo);
    const hi = corners(h, zHi);
    // Outer walls of this level.
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      b.quad(lo[k], lo[k1], hi[k1], hi[k]);
    }
    if (i < levels - 1) {
      // Flat annular tread between this footprint and the next, +Z.
      const inner = corners(half(i + 1), zHi);
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        b.quad(hi[k], hi[k1], inner[k1], inner[k]);
      }
    } else {
      // Top face, +Z.
      b.quad(hi[0], hi[1], hi[2], hi[3]);
    }
  }
  return b.build();
}

// ---------------------------------------------------------------------------
// pocketBox -- box with a rectangular pocket in the top (closed solid)
// ---------------------------------------------------------------------------

/**
 * Box [0,outer.x] x [0,outer.y] x [0,outer.z] with a centered rectangular
 * pocket (pocket.x by pocket.y, pocket.depth deep) cut into the top face.
 * Exact analytic volume: outer volume - pocket volume.
 */
export function pocketBox(
  outer: { x: number; y: number; z: number } = { x: 80, y: 60, z: 30 },
  pocket: { x: number; y: number; depth: number } = { x: 40, y: 30, depth: 15 },
): PartMesh {
  if (!(outer.x > 0) || !(outer.y > 0) || !(outer.z > 0)) {
    throw new Error('pocketBox: invalid outer dims');
  }
  if (!(pocket.x > 0) || !(pocket.y > 0) || !(pocket.depth > 0)) {
    throw new Error('pocketBox: invalid pocket dims');
  }
  if (pocket.x >= outer.x || pocket.y >= outer.y || pocket.depth >= outer.z) {
    throw new Error('pocketBox: pocket must be strictly inside the box');
  }
  const cx = outer.x / 2;
  const cy = outer.y / 2;
  const zTop = outer.z;
  const zFloor = outer.z - pocket.depth;
  const b = new MeshBuilder();
  const rect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    z: number,
  ): [number, number, number, number] => [
    b.vertex(x0, y0, z),
    b.vertex(x1, y0, z),
    b.vertex(x1, y1, z),
    b.vertex(x0, y1, z),
  ];
  const oLo = rect(0, 0, outer.x, outer.y, 0);
  const oHi = rect(0, 0, outer.x, outer.y, zTop);
  const pHi = rect(cx - pocket.x / 2, cy - pocket.y / 2, cx + pocket.x / 2, cy + pocket.y / 2, zTop);
  const pLo = rect(cx - pocket.x / 2, cy - pocket.y / 2, cx + pocket.x / 2, cy + pocket.y / 2, zFloor);

  // Bottom, -Z.
  b.quad(oLo[0], oLo[3], oLo[2], oLo[1]);
  // Outer walls.
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    b.quad(oLo[k], oLo[k1], oHi[k1], oHi[k]);
  }
  // Top annulus between outer rim and pocket rim, +Z.
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    b.quad(oHi[k], oHi[k1], pHi[k1], pHi[k]);
  }
  // Pocket walls: outward normal points INTO the cavity (toward pocket center).
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    b.quad(pLo[k1], pLo[k], pHi[k], pHi[k1]);
  }
  // Pocket floor, +Z.
  b.quad(pLo[0], pLo[1], pLo[2], pLo[3]);
  return b.build();
}

// ---------------------------------------------------------------------------
// engagementPocket -- radial-engagement torture fixture (closed-ish solid)
// ---------------------------------------------------------------------------
//
// Purpose: stress-test an ADAPTIVE ROUGHER's engagement control. Radial
// engagement is a PLAN-VIEW phenomenon -- it spikes at sharp internal corners,
// in narrow slots/necks (full-slot cutting), and in the pinch gap between an
// island and a wall. This fixture deliberately contains all three so a future
// M2 gate can assert the rougher keeps PEAK radial engagement bounded. The
// pocket is PRISMATIC (vertical walls, flat floor): curved walls are a finish
// concern, orthogonal to the plan-view engagement question tested here.
//
// Plan-view of the pocket footprint (cut to a flat floor at z = 4, 12 mm deep,
// in a 90 x 60 x 16 block) is the union of:
//   - LEFT chamber   x[10,40] y[10,50]   (30 x 40)
//   - RIGHT chamber  x[50,80] y[10,50]   (30 x 40)
//   - NECK           x[40,50] y[27,33]   (6 mm-wide slot joining the chambers)
// MINUS a square ISLAND x[20,30] y[25,35] (10 x 10) left standing full-height
// (top at the block top z = 16) inside the left chamber -- a post that creates
// ~10 mm pinch gaps to the chamber walls.
//
// Nasty features: sharp 90-deg internal corners at every chamber/neck junction,
// a 6 mm slot (full-slot engagement for a 4-6 mm tool), and a pinched island.
//
// Construction: the plan is decomposed on the break-line grid
//   xs = [0,10,20,30,40,50,80,90], ys = [0,10,25,27,33,35,50,60]
// Each grid cell is classified POCKET (floor z=4) or SOLID (top z=16); every
// POCKET|SOLID cell boundary emits a vertical wall z[4,16]. This is exact (the
// break lines are exactly the feature edges) and robust (no general polygon
// triangulation, no slivers).

/** X break lines of the engagement-pocket plan (feature edges). */
const EP_XS = [0, 10, 20, 30, 40, 50, 80, 90] as const;
/** Y break lines of the engagement-pocket plan (feature edges). */
const EP_YS = [0, 10, 25, 27, 33, 35, 50, 60] as const;
const EP_Z_TOP = 16;
const EP_Z_FLOOR = 4;

/** Plan rectangles [x0,x1,y0,y1] whose union (minus the island) is the pocket. */
const EP_LEFT_CHAMBER = { x0: 10, x1: 40, y0: 10, y1: 50 } as const;
const EP_RIGHT_CHAMBER = { x0: 50, x1: 80, y0: 10, y1: 50 } as const;
const EP_NECK = { x0: 40, x1: 50, y0: 27, y1: 33 } as const;
const EP_ISLAND = { x0: 20, x1: 30, y0: 25, y1: 35 } as const;

function inRect(x: number, y: number, r: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
}

/** True iff the plan point (x, y) is inside the cut pocket footprint. */
function epIsPocketPoint(x: number, y: number): boolean {
  const inUnion = inRect(x, y, EP_LEFT_CHAMBER) || inRect(x, y, EP_RIGHT_CHAMBER) || inRect(x, y, EP_NECK);
  return inUnion && !inRect(x, y, EP_ISLAND);
}

/**
 * Engagement-torture fixture: a 90 x 60 x 16 block with the H-shaped pocket
 * (two chambers + a 6 mm neck) cut to a flat floor at z = 4, minus a
 * full-height 10 x 10 island post in the left chamber. See the block comment
 * above for the plan and rationale. Deterministic (pure, fixed loop order).
 */
export function engagementPocket(): PartMesh {
  const b = new MeshBuilder();
  const nx = EP_XS.length - 1; // 7 columns
  const ny = EP_YS.length - 1; // 7 rows

  // Classify each cell POCKET/SOLID by its center (break lines are the exact
  // feature edges, so the center is unambiguous).
  const pocket: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    pocket[i] = [];
    const cxc = (EP_XS[i] + EP_XS[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cyc = (EP_YS[j] + EP_YS[j + 1]) / 2;
      pocket[i][j] = epIsPocketPoint(cxc, cyc);
    }
  }

  // Top faces (+Z) over SOLID cells at z=16; floor faces (+Z) over POCKET cells
  // at z=4. Corner order (x0,y0)(x1,y0)(x1,y1)(x0,y1) winds CCW from +Z.
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x0 = EP_XS[i], x1 = EP_XS[i + 1];
      const y0 = EP_YS[j], y1 = EP_YS[j + 1];
      const z = pocket[i][j] ? EP_Z_FLOOR : EP_Z_TOP;
      b.quad(
        b.vertex(x0, y0, z),
        b.vertex(x1, y0, z),
        b.vertex(x1, y1, z),
        b.vertex(x0, y1, z),
      );
    }
  }

  // Vertical walls on every POCKET|SOLID boundary (z 4->16). Orientation: the
  // exposed wall faces the pocket (open side); we pass a point on the pocket
  // side so the quad winds CCW-from-outside there.
  const wall = (ax: number, ay: number, bx: number, by: number, pocketX: number, pocketY: number): void => {
    const ex = bx - ax, ey = by - ay;
    // Normal of the order (Alo,Blo,Bhi,Ahi) is (ey, -ex) in plan.
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dot = ey * (pocketX - mx) + -ex * (pocketY - my);
    const aLo = b.vertex(ax, ay, EP_Z_FLOOR);
    const bLo = b.vertex(bx, by, EP_Z_FLOOR);
    const bHi = b.vertex(bx, by, EP_Z_TOP);
    const aHi = b.vertex(ax, ay, EP_Z_TOP);
    if (dot >= 0) b.quad(aLo, bLo, bHi, aHi);
    else b.quad(aHi, bHi, bLo, aLo);
  };
  // Vertical grid lines (between columns i and i+1): shared edge x = EP_XS[i+1].
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny; j++) {
      const l = pocket[i][j], r = pocket[i + 1][j];
      if (l === r) continue;
      const x = EP_XS[i + 1];
      const y0 = EP_YS[j], y1 = EP_YS[j + 1];
      const px = l ? (EP_XS[i] + x) / 2 : (x + EP_XS[i + 2]) / 2; // center of the pocket cell
      wall(x, y0, x, y1, px, (y0 + y1) / 2);
    }
  }
  // Horizontal grid lines (between rows j and j+1): shared edge y = EP_YS[j+1].
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const d = pocket[i][j], u = pocket[i][j + 1];
      if (d === u) continue;
      const y = EP_YS[j + 1];
      const x0 = EP_XS[i], x1 = EP_XS[i + 1];
      const py = d ? (EP_YS[j] + y) / 2 : (y + EP_YS[j + 2]) / 2;
      wall(x0, y, x1, y, (x0 + x1) / 2, py);
    }
  }

  // Outer shell: bottom face (-Z) and four side walls (outward).
  const X = EP_XS[nx], Y = EP_YS[ny];
  const oLo = [b.vertex(0, 0, 0), b.vertex(X, 0, 0), b.vertex(X, Y, 0), b.vertex(0, Y, 0)];
  const oHi = [b.vertex(0, 0, EP_Z_TOP), b.vertex(X, 0, EP_Z_TOP), b.vertex(X, Y, EP_Z_TOP), b.vertex(0, Y, EP_Z_TOP)];
  b.quad(oLo[0], oLo[3], oLo[2], oLo[1]); // bottom, -Z
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    b.quad(oLo[k], oLo[k1], oHi[k1], oHi[k]); // side, outward
  }

  return b.build();
}

// --- engagementPocket analytic truth (for the future M2 engagement gate) -----

/** Depth of the engagement pocket (block top z minus floor z). */
export const ENGAGEMENT_POCKET_DEPTH = EP_Z_TOP - EP_Z_FLOOR; // 12 mm

/** Block extents of the engagement fixture, mm. */
export const ENGAGEMENT_POCKET_BLOCK = { x: 90, y: 60, z: 16 } as const;

/**
 * Plan-view boundary polygons of the engagement pocket, for a gate to feed the
 * rougher / compare cleared regions:
 * - `outer`: the H-shaped footprint outer loop, CCW (area 2460 mm^2).
 * - `islandHole`: the standing island, CCW as an independent loop (area 100
 *   mm^2); it is a HOLE in the cut region (uncut material).
 * Net cut footprint area = outer - islandHole = 2360 mm^2.
 */
export const ENGAGEMENT_POCKET_BOUNDARIES: {
  outer: ReadonlyArray<readonly [number, number]>;
  islandHole: ReadonlyArray<readonly [number, number]>;
} = {
  outer: [
    [10, 10], [40, 10], [40, 27], [50, 27], [50, 10], [80, 10],
    [80, 50], [50, 50], [50, 33], [40, 33], [40, 50], [10, 50],
  ],
  islandHole: [
    [20, 25], [30, 25], [30, 35], [20, 35],
  ],
};

/** Shoelace area of a simple polygon (absolute value), mm^2. */
function polygonArea(poly: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/**
 * Net cut-footprint area of the engagement pocket, mm^2 (outer H minus the
 * island): 30*40 + 30*40 + 10*6 - 10*10 = 2360. Computed from the boundary
 * polygons so it can never drift from the geometry.
 */
export function engagementPocketFootprintArea(): number {
  return polygonArea(ENGAGEMENT_POCKET_BOUNDARIES.outer) - polygonArea(ENGAGEMENT_POCKET_BOUNDARIES.islandHole);
}

/**
 * Nominal removed volume of the engagement pocket, mm^3 (footprint x depth,
 * ignoring tool-radius corner leftovers): 2360 * 12 = 28320.
 */
export function engagementPocketRemovedVolume(): number {
  return engagementPocketFootprintArea() * ENGAGEMENT_POCKET_DEPTH;
}

// --- hemisphereOnSlab analytic truth (for the M2 analytic-volume rough gate) --
//
// hemisphereOnSlab is a hemispherical BOSS (dome pointing +Z) on a slab. That
// is the clean analytic-volume rough target: at any height h above the slab
// top the dome cross-section is a DISC of radius sqrt(r^2 - h^2), so the
// stock-minus-part region a rougher removes at each level is an annulus with a
// closed-form area. (A cavity would give the same discs inverted; the boss is
// chosen so per-level regions are simply connected discs.)

/**
 * Radius of the hemispherical-dome cross-section at height `h` above the slab
 * top (0 <= h <= r): sqrt(r^2 - h^2). Returns 0 at/above the pole and clamps
 * negatives to 0.
 */
export function hemisphereDiscRadiusAt(r: number, h: number): number {
  const d2 = r * r - h * h;
  return d2 > 0 ? Math.sqrt(d2) : 0;
}

/** Analytic volume of a solid hemisphere of radius r: (2/3) * pi * r^3. */
export function hemisphereVolume(r: number): number {
  return (2 / 3) * Math.PI * r * r * r;
}

// ---------------------------------------------------------------------------
// draftDomePocket -- 3D-FINISHING torture fixture (drafted walls + sphere dome)
// ---------------------------------------------------------------------------
//
// Purpose: exercise 3D FINISHING (a ball tool tracking sloped + curved
// surfaces), not just plan-view roughing. It keeps engagementPocket's H-plan
// (two chambers + 6 mm neck, minus an island) so the roughing engagement
// features persist at the FLOOR, but replaces the prismatic vertical walls and
// full-height island with:
//   - DRAFTED pocket walls (~15 deg from vertical): the opening is the H grown
//     OUTWARD by depth*tan(15deg) ~ 3.2 mm, so every wall ramps z 4 -> 16.
//   - a DRAFTED ISLAND post in the left chamber: base x[20,30] y[25,35] at
//     z=4, WIDER AT BASE, tapering UP ~15 deg to a flat top at z=16 (frustum),
//     keeping ~10 mm pinch gaps to the chamber walls at the base.
//   - a SPHERICAL DOME in the right chamber: hemisphere center (65,30) R=12 on
//     the floor, apex flush with the block top (z=16).
//
// The whole part is a single-valued HEIGHTFIELD z = f(x,y) (3-axis machinable,
// no undercuts: walls open wider at top, the post is wider at its base, the
// dome is single-valued), so it is meshed exactly like `wave` /
// `hemisphereOnSlab`: sample a regular grid, emit two triangles per cell. This
// is an OPEN top-surface sheet (like wave) -- drop-cutter finishing only reads
// the top surface, so no closing walls/bottom are needed, and the mesh z
// extent is the surface range z[4,16] (NOT the solid's z[0,16]).

/** Block footprint of the draft/dome fixture (mm); z is the block-top height. */
const DD_BLOCK = { x: 90, y: 60, z: 16 } as const;
/** Pocket floor and block-top heights (mm). Depth 12, same as engagementPocket. */
const DD_Z_FLOOR = 4;
const DD_Z_TOP = 16;
const DD_DEPTH = DD_Z_TOP - DD_Z_FLOOR; // 12 mm
/** Wall/island/post draft, degrees from vertical. */
export const DRAFT_ANGLE_DEG = 15;
/** tan(draft): horizontal run per unit vertical rise on a drafted face. */
const DD_TAN = Math.tan((DRAFT_ANGLE_DEG * Math.PI) / 180); // ~0.267949
/** Horizontal grow of the top opening over the floor edge: depth*tan(draft). */
const DD_GROW = DD_DEPTH * DD_TAN; // ~3.2154 mm

/** Spherical-dome center in the right chamber (mm). */
export const DRAFT_DOME_CENTER = { x: 65, y: 30 } as const;
/** Spherical-dome radius (mm): apex sits at floor+R = 4+12 = 16 (block top). */
export const DRAFT_DOME_RADIUS = 12;

// The H plan rectangles (identical to engagementPocket): their union is the
// floor pocket footprint; the island is a post standing in the left chamber.
const DD_LEFT_CHAMBER = { x0: 10, x1: 40, y0: 10, y1: 50 } as const;
const DD_RIGHT_CHAMBER = { x0: 50, x1: 80, y0: 10, y1: 50 } as const;
const DD_NECK = { x0: 40, x1: 50, y0: 27, y1: 33 } as const;
const DD_ISLAND = { x0: 20, x1: 30, y0: 25, y1: 35 } as const;

type Rect = { x0: number; x1: number; y0: number; y1: number };

/** Euclidean distance from (x,y) to a rectangle; 0 inside (>=0 always). */
function rectDistOutside(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.x0 - x, x - r.x1, 0);
  const dy = Math.max(r.y0 - y, y - r.y1, 0);
  return Math.hypot(dx, dy);
}

/** Interior distance from (x,y) to a rectangle's nearest edge; 0 outside. */
function rectDistInside(x: number, y: number, r: Rect): number {
  if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) {
    return Math.min(x - r.x0, r.x1 - x, y - r.y0, r.y1 - y);
  }
  return 0;
}

/**
 * The fixture height field z = f(x,y) over the 90 x 60 block. Single source of
 * truth for the mesh, the analytic gate, and the diagnostic renders.
 *
 * z = max(walls, island, dome), each >= floor:
 * - walls: distance to the floor H-region F (union of the two chambers + neck)
 *   ramps z from 4 at the floor edge to 16 over the drafted band; inside F it
 *   is the flat floor (z=4). Euclidean distance rounds the outer corners of the
 *   opening -- the opening is exactly the Minkowski sum of F with a disc of
 *   radius DD_GROW.
 * - island: interior distance into the island base rectangle ramps z UP toward
 *   the post interior (frustum, flat top at 16), 0 outside the base.
 * - dome: 4 + sqrt(R^2 - r^2) inside radius R of the dome center, else floor.
 */
export function draftDomeHeight(x: number, y: number): number {
  // Drafted floor + walls. distToF = 0 inside the pocket, grows outward.
  const distToF = Math.min(
    rectDistOutside(x, y, DD_LEFT_CHAMBER),
    rectDistOutside(x, y, DD_RIGHT_CHAMBER),
    rectDistOutside(x, y, DD_NECK),
  );
  const zWalls = DD_Z_FLOOR + Math.min(DD_DEPTH, distToF / DD_TAN);

  // Drafted island post (frustum), rising toward its interior.
  const zIsland = DD_Z_FLOOR + Math.min(DD_DEPTH, rectDistInside(x, y, DD_ISLAND) / DD_TAN);

  // Spherical dome sitting on the floor.
  const rr = (x - DRAFT_DOME_CENTER.x) ** 2 + (y - DRAFT_DOME_CENTER.y) ** 2;
  const disc = DRAFT_DOME_RADIUS * DRAFT_DOME_RADIUS - rr;
  const zDome = disc > 0 ? DD_Z_FLOOR + Math.sqrt(disc) : DD_Z_FLOOR;

  return Math.max(zWalls, zIsland, zDome);
}

/**
 * 3D-finishing torture fixture: a 90 x 60 x 16 block whose H-pocket has DRAFTED
 * walls (~15 deg), a DRAFTED island post (frustum) in the left chamber, and a
 * SPHERICAL DOME in the right chamber -- meshed as an open heightfield sheet
 * z = f(x,y) (see the block comment above). Default grid ~0.33 mm cells.
 * Deterministic (pure, fixed loop order, no randomness).
 */
export function draftDomePocket(nx = 271, ny = 181): PartMesh {
  if (!Number.isInteger(nx) || nx < 2 || !Number.isInteger(ny) || ny < 2) {
    throw new Error(`draftDomePocket: invalid grid nx=${nx} ny=${ny}`);
  }
  const positions = new Float32Array(nx * ny * 3);
  let p = 0;
  for (let j = 0; j < ny; j++) {
    const y = (DD_BLOCK.y * j) / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const x = (DD_BLOCK.x * i) / (nx - 1);
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = draftDomeHeight(x, y);
      p += 3;
    }
  }
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = b + nx;
      const d = a + nx;
      // CCW viewed from +Z (outside of an up-facing sheet), matching `wave`.
      indices[q] = a;
      indices[q + 1] = b;
      indices[q + 2] = c;
      indices[q + 3] = a;
      indices[q + 4] = c;
      indices[q + 5] = d;
      q += 6;
    }
  }
  return { positions, indices, bounds: computeBounds(positions), source: 'fixture' };
}

// --- draftDomePocket analytic truth (for a future 3D-finish gate) ------------

/** Depth of the draft/dome pocket (block top minus floor). */
export const DRAFT_DOME_DEPTH = DD_DEPTH; // 12 mm

/** Block extents of the draft/dome fixture, mm. */
export const DRAFT_DOME_BLOCK = DD_BLOCK;

/**
 * Radius of the spherical-dome cross-section at height `h` above the floor
 * (0 <= h <= R): sqrt(R^2 - h^2). Clamps to 0 at/above the apex. (Same closed
 * form as hemisphereDiscRadiusAt, specialized to this dome's R = 12.)
 */
export function domeDiscRadiusAt(h: number): number {
  const d2 = DRAFT_DOME_RADIUS * DRAFT_DOME_RADIUS - h * h;
  return d2 > 0 ? Math.sqrt(d2) : 0;
}

/** Analytic volume of the solid spherical dome (hemisphere): (2/3) pi R^3. */
export function draftDomeVolume(): number {
  return (2 / 3) * Math.PI * DRAFT_DOME_RADIUS ** 3;
}

// The floor H-footprint and grown top opening. The outer H outline (same as
// engagementPocket's `outer`) has area 2460 and perimeter 288; the net floor
// footprint subtracts the 100 mm^2 island; the top opening is the Minkowski
// sum of that outline with a disc of radius DD_GROW (Euclidean-distance walls
// round the convex corners), area = A + P*g + pi*g^2.
const DD_H_OUTER: ReadonlyArray<readonly [number, number]> = [
  [10, 10], [40, 10], [40, 27], [50, 27], [50, 10], [80, 10],
  [80, 50], [50, 50], [50, 33], [40, 33], [40, 50], [10, 50],
];
const DD_ISLAND_LOOP: ReadonlyArray<readonly [number, number]> = [
  [20, 25], [30, 25], [30, 35], [20, 35],
];

function polygonPerimeter(poly: ReadonlyArray<readonly [number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += Math.hypot(x1 - x0, y1 - y0);
  }
  return s;
}

/**
 * Net floor-pocket footprint area (mm^2): the H outline (2460) minus the island
 * base (100) = 2360 -- identical to engagementPocket, so the roughing plan-view
 * features are preserved at the floor.
 */
export function draftDomeFloorFootprintArea(): number {
  return polygonArea(DD_H_OUTER) - polygonArea(DD_ISLAND_LOOP);
}

/**
 * Top-opening footprint area (mm^2): the H outline grown outward by DD_GROW.
 * Minkowski sum with a disc: area = A + P*g + pi*g^2
 * = 2460 + 288*3.2154 + pi*3.2154^2 ~= 3418.5 mm^2.
 */
export function draftDomeTopOpeningArea(): number {
  const a = polygonArea(DD_H_OUTER);
  const p = polygonPerimeter(DD_H_OUTER);
  return a + p * DD_GROW + Math.PI * DD_GROW * DD_GROW;
}

// ---------------------------------------------------------------------------
// bossInOpenStock -- WO-100: a single square part sitting in open stock
// ---------------------------------------------------------------------------

/**
 * A plain rectangular boss centred in a larger stock box: the exact shape the
 * "Enter from stock edge (side entry)" setting is documented to apply to ("a
 * single part sitting in open, unspun stock"). The part is a solid box
 * `part.x` x `part.y` x `part.z`, centred in a `stock.x` x `stock.y` plan
 * footprint, so the material a rougher must clear is a uniform PERIMETER RING
 * of width `ringWidth = (stock.x - part.x) / 2` (square stock/part keeps that
 * one number meaningful on all four sides).
 *
 * The ring width is the whole point of the fixture: the tool-centre corridor
 * the adaptive engine actually gets to steer in is `ringWidth - toolDiameter`
 * (minus the engine's own tolerance/2 inset), so a ring only slightly wider
 * than the cutter leaves a ribbon with no lateral room -- the condition under
 * which a perimeter pass degenerates into a full-width slot (WO-100).
 *
 * Origin at the stock's min corner, part base at z = 0. The returned mesh is
 * the PART only; the caller supplies the (larger) stock box.
 */
export function bossInOpenStock(
  stock: { x: number; y: number } = { x: 100, y: 100 },
  part: { x: number; y: number; z: number } = { x: 80, y: 80, z: 14 },
): PartMesh {
  if (!(stock.x > 0) || !(stock.y > 0)) throw new Error('bossInOpenStock: invalid stock dims');
  if (!(part.x > 0) || !(part.y > 0) || !(part.z > 0)) {
    throw new Error('bossInOpenStock: invalid part dims');
  }
  if (part.x >= stock.x || part.y >= stock.y) {
    throw new Error('bossInOpenStock: part must sit strictly inside the stock footprint');
  }
  const x0 = (stock.x - part.x) / 2;
  const y0 = (stock.y - part.y) / 2;
  const x1 = x0 + part.x;
  const y1 = y0 + part.y;
  const b = new MeshBuilder();
  const v = (x: number, y: number, z: number): number => b.vertex(x, y, z);
  const a00 = v(x0, y0, 0), a10 = v(x1, y0, 0), a11 = v(x1, y1, 0), a01 = v(x0, y1, 0);
  const t00 = v(x0, y0, part.z), t10 = v(x1, y0, part.z);
  const t11 = v(x1, y1, part.z), t01 = v(x0, y1, part.z);
  b.quad(a00, a01, a11, a10); // bottom (-Z)
  b.quad(t00, t10, t11, t01); // top (+Z)
  b.quad(a00, a10, t10, t00);
  b.quad(a10, a11, t11, t10);
  b.quad(a11, a01, t01, t11);
  b.quad(a01, a00, t00, t01);
  return b.build();
}

/** Perimeter ring width (mm) a bossInOpenStock rougher must clear on each side. */
export function bossRingWidth(
  stock: { x: number; y: number } = { x: 100, y: 100 },
  part: { x: number; y: number } = { x: 80, y: 80 },
): number {
  return (stock.x - part.x) / 2;
}

// ---------------------------------------------------------------------------
// featureBlock -- compact whole-part 3D benchmark fixture (WO-1218)
// ---------------------------------------------------------------------------

/** The stock envelope used by the compact whole-part benchmark, mm. */
export const FEATURE_BLOCK = { x: 60, y: 40, z: 27 } as const;
const FB_BASE_Z = 20;
const FB_THROUGH = { x: 49, y: 9, r: 3 } as const;
const FB_BLIND = { x: 49, y: 31, r: 3, floor: 10 } as const;
const FB_DOME = { x: 42, y: 20, r: 7 } as const;
// The pocket's far wall (opposite the open mouth) is a single 15-degree
// drafted plane -- the SLOPED-surface row Operator's authority names. Floor
// boundary is unchanged; the deck-level opening grows outward by
// depth * tan(draft), reusing the same DRAFT_ANGLE_DEG convention as
// draftDomePocket above so this file states the number once.
const FB_POCKET_FLOOR_Z = 8;
const FB_POCKET_Y0 = 8;
const FB_POCKET_Y1 = 32;
const FB_POCKET_X = 28; // floor boundary, unchanged by the draft
const FB_POCKET_X_TOP = FB_POCKET_X + (FB_BASE_Z - FB_POCKET_FLOOR_Z) * DD_TAN; // ~31.215
// A standing square boss, vertical walls, flat top -- the OUTSIDE-faces /
// outside-corner row the block otherwise lacks. Clear in plan view of the
// pocket, both bores and the dome; its top sits well inside the block's own
// z envelope (the dome's apex already reaches FEATURE_BLOCK.z).
const FB_BOSS = { x0: 51, x1: 59, y0: 15, y1: 25, topZ: 25 } as const;
// The production STEP importer deterministically tessellates these radius-7
// analytic circles as 56 segments and the cap as 14 latitude rings at its
// committed 0.025 mm / 0.35 rad deflection. Matching that analytic sampling
// keeps the mesh and STEP benchmark twins comparable at CAM resolution.
const FB_CIRCLE_SEGMENTS = 56;
const FB_DOME_RINGS = 14;

type FbPoint = readonly [number, number];

function fbCircle(cx: number, cy: number, r: number, clockwise = false): FbPoint[] {
  const points: FbPoint[] = [];
  for (let i = 0; i < FB_CIRCLE_SEGMENTS; i++) {
    const theta = (2 * Math.PI * (clockwise ? -i : i)) / FB_CIRCLE_SEGMENTS;
    points.push([cx + r * Math.cos(theta), cy + r * Math.sin(theta)]);
  }
  return points;
}

/** Add one horizontal polygon face, with holes, sharing every boundary vertex. */
function fbPlanarFace(
  b: MeshBuilder,
  contour: readonly FbPoint[],
  holes: readonly (readonly FbPoint[])[],
  z: number,
  up: boolean,
  splitBoundaryEdge?: readonly FbPoint[],
): void {
  const all = [contour, ...holes].flat();
  const triangles = ShapeUtils.triangulateShape(
    contour.map(([x, y]) => new Vector2(x, y)),
    holes.map((hole) => hole.map(([x, y]) => new Vector2(x, y))),
  );
  const addTriangle = (a: FbPoint, bb: FbPoint, c: FbPoint): void => {
    const va = b.vertex(a[0], a[1], z), vb = b.vertex(bb[0], bb[1], z), vc = b.vertex(c[0], c[1], z);
    const ccw = (bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]) > 0;
    if (up === ccw) b.tri(va, vb, vc);
    else b.tri(va, vc, vb);
  };
  const same = (a: FbPoint, bb: FbPoint): boolean => a[0] === bb[0] && a[1] === bb[1];
  for (const [ia, ib, ic] of triangles) {
    const triangle = [all[ia], all[ib], all[ic]] as const;
    const edge = splitBoundaryEdge;
    if (edge) {
      const first = edge[0], last = edge[edge.length - 1];
      for (let i = 0; i < 3; i++) {
        const a = triangle[i], bb = triangle[(i + 1) % 3], apex = triangle[(i + 2) % 3];
        if ((same(a, first) && same(bb, last)) || (same(a, last) && same(bb, first))) {
          const chain = same(a, first) ? edge : [...edge].reverse();
          for (let j = 0; j < chain.length - 1; j++) addTriangle(chain[j], chain[j + 1], apex);
          break;
        }
      }
      if (triangle.some((point) => same(point, first)) && triangle.some((point) => same(point, last))) continue;
    }
    addTriangle(triangle[0], triangle[1], triangle[2]);
  }
}

/** Add a vertical wall along a CCW material boundary. */
function fbWall(b: MeshBuilder, path: readonly FbPoint[], zLo: number, zHi: number, closed = true): void {
  const edgeCount = closed ? path.length : path.length - 1;
  for (let i = 0; i < edgeCount; i++) {
    const [x0, y0] = path[i], [x1, y1] = path[(i + 1) % path.length];
    b.quad(b.vertex(x0, y0, zLo), b.vertex(x1, y1, zLo), b.vertex(x1, y1, zHi), b.vertex(x0, y0, zHi));
  }
}

/**
 * Compact 60 x 40 feature block, matching fix_feature_block.step exactly: a
 * left-open pocket whose far wall is a single 15-degree drafted plane, a
 * spherical cap, through/blind bores, and a standing square boss with
 * vertical walls. The mesh is an analytic-face tessellation, not a voxel
 * field: planar faces (drafted and vertical), true circular bores, and a
 * smooth hemispherical cap share welded boundary rings.
 */
export function featureBlock(): PartMesh {
  const b = new MeshBuilder();
  const topContour: FbPoint[] = [
    [0, 0], [60, 0], [60, 40], [0, 40],
    [0, FB_POCKET_Y1], [FB_POCKET_X_TOP, FB_POCKET_Y1], [FB_POCKET_X_TOP, FB_POCKET_Y0], [0, FB_POCKET_Y0],
  ];
  const through = fbCircle(FB_THROUGH.x, FB_THROUGH.y, FB_THROUGH.r);
  const blind = fbCircle(FB_BLIND.x, FB_BLIND.y, FB_BLIND.r);
  const dome = fbCircle(FB_DOME.x, FB_DOME.y, FB_DOME.r);
  const bossHole: FbPoint[] = [[FB_BOSS.x0, FB_BOSS.y0], [FB_BOSS.x1, FB_BOSS.y0], [FB_BOSS.x1, FB_BOSS.y1], [FB_BOSS.x0, FB_BOSS.y1]];

  fbPlanarFace(b, topContour, [through, blind, dome, bossHole], FB_BASE_Z, true);
  fbPlanarFace(b, [[0, FB_POCKET_Y0], [FB_POCKET_X, FB_POCKET_Y0], [FB_POCKET_X, FB_POCKET_Y1], [0, FB_POCKET_Y1]], [], FB_POCKET_FLOOR_Z, true);
  fbPlanarFace(b, [[0, 0], [60, 0], [60, 40], [0, 40]], [through], 0, false, [[0, 0], [0, FB_POCKET_Y0], [0, FB_POCKET_Y1], [0, 40]]);
  fbPlanarFace(b, blind, [], FB_BLIND.floor, true);
  fbPlanarFace(b, bossHole, [], FB_BOSS.topZ, true);

  // Outer boundary, including the lower opening below the open pocket.
  fbWall(b, [[0, 0], [60, 0], [60, 40], [0, 40], [0, FB_POCKET_Y1]], 0, FB_POCKET_FLOOR_Z, false);
  fbWall(b, [[0, FB_POCKET_Y1], [0, FB_POCKET_Y0]], 0, FB_POCKET_FLOOR_Z, false);
  fbWall(b, [[0, FB_POCKET_Y0], [0, 0]], 0, FB_POCKET_FLOOR_Z, false);
  fbWall(b, [[0, 0], [60, 0], [60, 40], [0, 40], [0, FB_POCKET_Y1]], FB_POCKET_FLOOR_Z, FB_BASE_Z, false);
  fbWall(b, [[0, FB_POCKET_Y0], [0, 0]], FB_POCKET_FLOOR_Z, FB_BASE_Z, false);
  // Pocket walls: the far wall (opposite the open mouth) is drafted, growing
  // from FB_POCKET_X at the floor to FB_POCKET_X_TOP at the deck; the two
  // flanking walls share its floor edge and top-x, so they become trapezoids.
  b.quad(
    b.vertex(0, FB_POCKET_Y1, FB_POCKET_FLOOR_Z), b.vertex(FB_POCKET_X, FB_POCKET_Y1, FB_POCKET_FLOOR_Z),
    b.vertex(FB_POCKET_X_TOP, FB_POCKET_Y1, FB_BASE_Z), b.vertex(0, FB_POCKET_Y1, FB_BASE_Z),
  );
  b.quad(
    b.vertex(FB_POCKET_X, FB_POCKET_Y1, FB_POCKET_FLOOR_Z), b.vertex(FB_POCKET_X, FB_POCKET_Y0, FB_POCKET_FLOOR_Z),
    b.vertex(FB_POCKET_X_TOP, FB_POCKET_Y0, FB_BASE_Z), b.vertex(FB_POCKET_X_TOP, FB_POCKET_Y1, FB_BASE_Z),
  );
  b.quad(
    b.vertex(FB_POCKET_X, FB_POCKET_Y0, FB_POCKET_FLOOR_Z), b.vertex(0, FB_POCKET_Y0, FB_POCKET_FLOOR_Z),
    b.vertex(0, FB_POCKET_Y0, FB_BASE_Z), b.vertex(FB_POCKET_X_TOP, FB_POCKET_Y0, FB_BASE_Z),
  );
  // Hole paths are clockwise so their material-facing normal points into the bore.
  fbWall(b, [...through].reverse(), 0, FB_BASE_Z);
  fbWall(b, [...blind].reverse(), FB_BLIND.floor, FB_BASE_Z);
  // Boss: standing proud of the deck, vertical walls, CCW like the block's own
  // outer perimeter (an outward-facing wall, not a cavity).
  fbWall(b, bossHole, FB_BASE_Z, FB_BOSS.topZ, true);

  // The upper half of the fused sphere is the exposed cap. Its rim is the deck
  // hole above, so the MeshBuilder welds the two surfaces into one closed solid.
  const rings: number[][] = [];
  for (let j = 0; j < FB_DOME_RINGS; j++) {
    const phi = (Math.PI / 2) * (j / FB_DOME_RINGS);
    const r = FB_DOME.r * Math.cos(phi);
    const z = FB_BASE_Z + FB_DOME.r * Math.sin(phi);
    const ring: number[] = [];
    for (let i = 0; i < FB_CIRCLE_SEGMENTS; i++) {
      const theta = (2 * Math.PI * i) / FB_CIRCLE_SEGMENTS;
      ring.push(b.vertex(FB_DOME.x + r * Math.cos(theta), FB_DOME.y + r * Math.sin(theta), z));
    }
    rings.push(ring);
  }
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < FB_CIRCLE_SEGMENTS; i++) {
      const next = (i + 1) % FB_CIRCLE_SEGMENTS;
      b.quad(rings[j][i], rings[j][next], rings[j + 1][next], rings[j + 1][i]);
    }
  }
  const pole = b.vertex(FB_DOME.x, FB_DOME.y, FB_BASE_Z + FB_DOME.r);
  const last = rings[rings.length - 1];
  for (let i = 0; i < FB_CIRCLE_SEGMENTS; i++) b.tri(last[i], last[(i + 1) % FB_CIRCLE_SEGMENTS], pole);
  return b.build();
}

/** Exact analytic solid volume, independent of the mesh tessellation, mm^3. */
export const FEATURE_BLOCK_SOLID_VOLUME =
  60 * 40 * FB_BASE_Z
  - (FB_POCKET_X * (FB_POCKET_Y1 - FB_POCKET_Y0) * (FB_BASE_Z - FB_POCKET_FLOOR_Z)
    + 0.5 * (FB_POCKET_X_TOP - FB_POCKET_X) * (FB_BASE_Z - FB_POCKET_FLOOR_Z) * (FB_POCKET_Y1 - FB_POCKET_Y0))
  - Math.PI * FB_THROUGH.r ** 2 * FB_BASE_Z
  - Math.PI * FB_BLIND.r ** 2 * (FB_BASE_Z - FB_BLIND.floor)
  + (2 / 3) * Math.PI * FB_DOME.r ** 3
  + (FB_BOSS.x1 - FB_BOSS.x0) * (FB_BOSS.y1 - FB_BOSS.y0) * (FB_BOSS.topZ - FB_BASE_Z);

/** Material removed from the 60 x 40 x 27 stock envelope, mm^3. */
export const FEATURE_BLOCK_REMOVED_VOLUME = FEATURE_BLOCK.x * FEATURE_BLOCK.y * FEATURE_BLOCK.z - FEATURE_BLOCK_SOLID_VOLUME;
